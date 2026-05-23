/**
 * GET/POST /cron/venue-tournaments
 *
 * Ported from pages/api/cron/venue-tournaments.js (336 lines).
 *
 * Daily venue tournament scraper — pulls poker_venues.scrape_url (or
 * pokeratlas_url for pokeratlas source) and parses HTML for tournament
 * rows: day-of-week, start time, buy-in, format, GTD. Upserts into
 * venue_daily_tournaments with conflict on (venue_id, day_of_week,
 * start_time, buy_in).
 *
 * Query params (passed via Hono context query string):
 *   state=NV       → only that state
 *   source=pokeratlas → only that source
 *   limit=50       → cap venues
 *   force=true     → ignore 24h scrape cooldown
 *
 * Idempotence: 24h last_scraped guard + upsert-on-conflict tuple keep
 * double-fires harmless. Rate-limited 2s between venues.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const RATE_LIMIT_MS = 2000;
const FETCH_TIMEOUT_MS = 20000;

// Full browser-grade header set — passes Cloudflare's basic bot fingerprint check.
// PokerAtlas embeds tournament data in JSON-LD server-side before the JS challenge
// fires, so these headers are sufficient to retrieve the structured data.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

interface Tournament {
  venue_name: string;
  day_of_week: string;
  start_time: string;
  buy_in: number;
  game_type: string;
  format: string | null;
  guaranteed: number | null;
  // populated later
  venue_id?: string;
  source_url?: string;
  last_scraped?: string;
  is_active?: boolean;
}

interface VenueRow {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  scrape_source: string | null;
  scrape_url: string | null;
  pokeratlas_url: string | null;
  last_scraped: string | null;
}

interface ScrapeStats {
  venuesProcessed: number;
  tournamentsFound: number;
  tournamentsInserted: number;
  errors: Array<{ venue: string; error: string }>;
  skipped: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchUrl(url: string, retries = 3): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: BROWSER_HEADERS,
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (err) {
    clearTimeout(timeout);
    if (retries > 0) {
      await sleep(1000);
      return fetchUrl(url, retries - 1);
    }
    throw err;
  }
}

// Returns true when Cloudflare's managed JS challenge page is detected.
// In this case the HTML contains no real data and we must skip rather than
// persist empty results or error-loop.
function isCloudflareChallenge(html: string): boolean {
  return html.includes('challenges.cloudflare.com') && html.includes('Just a moment');
}

// ---------------------------------------------------------------------------
// PokerAtlas parser — two-stage extraction
// Stage 1: JSON-LD (schema.org/Event) — embedded server-side before any CF
//          JS challenge fires. Most reliable source.
// Stage 2: HTML table-row fallback — used when JSON-LD yields nothing.
// ---------------------------------------------------------------------------

function extractDayFromScheduleText(text: string): string {
  const DAY_MAP: Record<string, string> = {
    mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday',
    thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
  };
  const m = text.match(
    /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Daily)/i,
  );
  if (!m || !m[1]) return 'Daily';
  const k = m[1].toLowerCase().substring(0, 3);
  return DAY_MAP[k] ?? m[1];
}

function extractGameType(text: string): string {
  if (/\bPLO\b/i.test(text)) return 'PLO';
  if (/\bOmaha\b/i.test(text)) return 'Omaha';
  if (/\bMixed\b/i.test(text)) return 'Mixed';
  if (/\bBig-O\b/i.test(text)) return 'Big-O';
  return 'NLH';
}

function extractFormat(text: string): string | null {
  if (/mystery\s*bounty/i.test(text)) return 'Mystery Bounty';
  if (/bounty/i.test(text)) return 'Bounty';
  if (/turbo/i.test(text)) return 'Turbo';
  if (/deep\s*stack/i.test(text)) return 'Deep Stack';
  if (/freezeout/i.test(text)) return 'Freezeout';
  if (/rebuy/i.test(text)) return 'Rebuy';
  return null;
}

function parsePokerAtlasTournamentsJsonLd(
  html: string,
  venueName: string,
): Tournament[] {
  const tournaments: Tournament[] = [];
  // Match all <script type="application/ld+json"> blocks
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptRe.exec(html)) !== null) {
    let payload: unknown;
    try {
      payload = JSON.parse(match[1] ?? '');
    } catch {
      continue;
    }

    // Handle both single objects and arrays
    const items: unknown[] = Array.isArray(payload) ? payload : [payload];

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;

      // schema.org/Event or Event arrays inside a ItemList
      const events: unknown[] = [];
      if (obj['@type'] === 'Event') {
        events.push(obj);
      } else if (obj['@type'] === 'ItemList') {
        const elements = obj['itemListElement'];
        if (Array.isArray(elements)) {
          for (const el of elements) {
            if (el && typeof el === 'object' && (el as Record<string, unknown>)['@type'] === 'Event') {
              events.push(el);
            }
          }
        }
      }

      for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue;
        const event = ev as Record<string, unknown>;

        // PokerAtlas encodes buy-in in offers.price or name
        const name = String(event['name'] ?? '');
        const description = String(event['description'] ?? '');
        const fullText = `${name} ${description}`;

        // Buy-in from offers.price
        let buyin = 0;
        const offers = event['offers'];
        if (offers && typeof offers === 'object') {
          const price = (offers as Record<string, unknown>)['price'];
          if (price !== undefined && price !== null) {
            buyin = parseInt(String(price).replace(/[^0-9]/g, ''), 10);
          }
        }
        // Fallback: parse $ from name/description
        if (!buyin || Number.isNaN(buyin)) {
          const buyinM = fullText.match(/\$(\d{1,3}(?:,\d{3})*)/);
          if (buyinM && buyinM[1]) buyin = parseInt(buyinM[1].replace(/,/g, ''), 10);
        }
        if (!buyin || Number.isNaN(buyin) || buyin < 10 || buyin > 50000) continue;

        // Start time from startDate
        const startDate = String(event['startDate'] ?? '');
        let startTime = '';
        if (startDate) {
          // ISO datetime: extract HH:MM and convert to AM/PM
          const timePart = startDate.match(/T(\d{2}):(\d{2})/);
          if (timePart && timePart[1] && timePart[2]) {
            const h = parseInt(timePart[1], 10);
            const m2 = timePart[2];
            const ampm = h >= 12 ? 'PM' : 'AM';
            const h12 = h % 12 === 0 ? 12 : h % 12;
            startTime = `${h12}:${m2}${ampm}`;
          }
        }
        // Fallback: parse time string from name/description
        if (!startTime) {
          const timeM = fullText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))/i);
          if (timeM && timeM[1]) startTime = timeM[1].toUpperCase().replace(/\s/g, '');
        }
        if (!startTime) continue;

        // Day of week from eventSchedule.byDay or startDate
        let dayOfWeek = 'Daily';
        const schedule = event['eventSchedule'];
        if (schedule && typeof schedule === 'object') {
          const byDay = (schedule as Record<string, unknown>)['byDay'];
          if (byDay) {
            const dayStr = String(byDay).replace(/.*\//, ''); // strip schema.org URL prefix
            dayOfWeek = dayStr || 'Daily';
          }
        }
        if (dayOfWeek === 'Daily' && startDate) {
          const dateObj = new Date(startDate);
          if (!Number.isNaN(dateObj.getTime())) {
            const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
            dayOfWeek = DAYS[dateObj.getDay()] ?? 'Daily';
          }
        }
        if (dayOfWeek === 'Daily') {
          dayOfWeek = extractDayFromScheduleText(fullText);
        }

        const gtdM = fullText.match(/(?:GTD|Guaranteed)[:\s]*\$?([\d,]+)/i);
        const guaranteed = gtdM && gtdM[1] ? parseInt(gtdM[1].replace(/,/g, ''), 10) : null;

        tournaments.push({
          venue_name: venueName,
          day_of_week: dayOfWeek,
          start_time: startTime,
          buy_in: buyin,
          game_type: extractGameType(fullText),
          format: extractFormat(fullText),
          guaranteed,
        });
      }
    }
  }

  const seen = new Set<string>();
  return tournaments.filter((t) => {
    const key = `${t.day_of_week}-${t.start_time}-${t.buy_in}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Fallback: HTML table-row parser (used when JSON-LD returns nothing).
function parsePokerAtlasTournaments(html: string, venueName: string): Tournament[] {
  const tournaments: Tournament[] = [];
  const rows = html.split(/<tr[^>]*>/gi);

  for (const row of rows) {
    if (!row.includes('$') || row.includes('<th')) continue;

    const cells: string[] = [];
    const cellMatches = row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    for (const m of cellMatches) {
      const inner = m[1];
      if (!inner) continue;
      cells.push(inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    }
    if (cells.length < 2) continue;

    const fullText = cells.join(' ');

    const buyinMatch = fullText.match(/\$(\d{1,3}(?:,\d{3})*)/);
    if (!buyinMatch || !buyinMatch[1]) continue;

    const buyin = parseInt(buyinMatch[1].replace(/,/g, ''), 10);
    if (Number.isNaN(buyin) || buyin < 10 || buyin > 50000) continue;

    const timeMatch = fullText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)/i);
    if (!timeMatch || !timeMatch[1]) continue;

    const gtdMatch = fullText.match(/(?:GTD|Guaranteed)[:\s]*\$?([\d,]+)/i);
    const guaranteed = gtdMatch && gtdMatch[1] ? parseInt(gtdMatch[1].replace(/,/g, ''), 10) : null;

    tournaments.push({
      venue_name: venueName,
      day_of_week: extractDayFromScheduleText(fullText),
      start_time: timeMatch[1].toUpperCase().replace(/\s/g, ''),
      buy_in: buyin,
      game_type: extractGameType(fullText),
      format: extractFormat(fullText),
      guaranteed,
    });
  }

  const seen = new Set<string>();
  return tournaments.filter((t) => {
    const key = `${t.day_of_week}-${t.start_time}-${t.buy_in}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseDirectWebsiteTournaments(html: string, venueName: string): Tournament[] {
  const tournaments: Tournament[] = [];
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const blocks = text.split(/(?=\$\d)/);

  for (const block of blocks) {
    if (block.length > 500) continue;

    const buyinMatch = block.match(/\$(\d{1,3}(?:,\d{3})*)/);
    if (!buyinMatch || !buyinMatch[1]) continue;

    const buyin = parseInt(buyinMatch[1].replace(/,/g, ''), 10);
    if (Number.isNaN(buyin) || buyin < 10 || buyin > 50000) continue;

    const timeMatch = block.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
    if (!timeMatch || !timeMatch[1]) continue;

    const dayMatch = block.match(
      /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Daily)/i,
    );

    tournaments.push({
      venue_name: venueName,
      day_of_week: dayMatch && dayMatch[1] ? dayMatch[1] : 'Daily',
      start_time: timeMatch[1].toUpperCase().replace(/\s/g, ''),
      buy_in: buyin,
      game_type: /PLO|Omaha/i.test(block) ? 'PLO' : 'NLH',
      format: /turbo/i.test(block) ? 'Turbo' : null,
      guaranteed: null,
    });
  }

  const seen = new Set<string>();
  return tournaments.filter((t) => {
    const key = `${t.day_of_week}-${t.start_time}-${t.buy_in}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function venueTournaments(c: Context) {
  const supabase = getSupabase();
  const stats: ScrapeStats = {
    venuesProcessed: 0,
    tournamentsFound: 0,
    tournamentsInserted: 0,
    errors: [],
    skipped: 0,
  };

  try {
    const state = c.req.query('state');
    const source = c.req.query('source');
    const limitParam = c.req.query('limit');
    const force = c.req.query('force');

    let query = supabase
      .from('poker_venues')
      .select('id, name, city, state, scrape_source, scrape_url, pokeratlas_url, last_scraped')
      .eq('is_active', true)
      .order('name')
      .limit(100);

    if (state) query = query.eq('state', state.toUpperCase());
    // Exclude bravo permanently — removed 2026-05-23
    if (source) {
      query = query.eq('scrape_source', source);
    } else {
      query = query.neq('scrape_source', 'bravo');
    }
    if (limitParam) {
      const n = parseInt(limitParam, 10);
      if (!Number.isNaN(n) && n > 0) query = query.limit(n);
    }
    if (force !== 'true') {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      query = query.or(`last_scraped.is.null,last_scraped.lt.${yesterday}`);
    }

    const { data: venuesData, error: queryError } = await query;
    if (queryError) {
      return c.json({ error: queryError.message }, 500);
    }
    const venues = (venuesData ?? []) as VenueRow[];

    const maxVenues = Math.min(venues.length, 50);

    for (let i = 0; i < maxVenues; i++) {
      const venue = venues[i];
      if (!venue) continue;
      stats.venuesProcessed++;

      const scrapeSource = venue.scrape_source ?? 'manual';
      if (scrapeSource === 'manual' || !venue.scrape_url) {
        stats.skipped++;
        continue;
      }

      let url = venue.scrape_url;
      let tournaments: Tournament[] = [];

      try {
        if (scrapeSource === 'pokeratlas') {
          url = venue.pokeratlas_url || venue.scrape_url;
          if (!url.endsWith('/tournaments')) {
            url = url.replace(/\/$/, '') + '/tournaments';
          }
          const html = await fetchUrl(url);

          // Detect Cloudflare managed challenge — no real data available.
          // Mark the venue so operators know it needs a headless proxy.
          if (isCloudflareChallenge(html)) {
            console.warn(`[venue-tournaments] CF challenge on ${venue.name} (${url})`);
            await supabase
              .from('poker_venues')
              .update({
                scrape_status: 'cf_blocked',
                last_scraped: new Date().toISOString(),
              })
              .eq('id', venue.id);
            stats.skipped++;
            continue;
          }

          // Stage 1: JSON-LD structured data (schema.org/Event)
          tournaments = parsePokerAtlasTournamentsJsonLd(html, venue.name);
          // Stage 2: HTML table-row fallback
          if (tournaments.length === 0) {
            tournaments = parsePokerAtlasTournaments(html, venue.name);
          }
        } else if (scrapeSource === 'direct_website') {
          if (!url.startsWith('http')) url = 'https://' + url;
          const paths = ['', '/poker', '/poker/tournaments', '/tournaments'];
          for (const path of paths) {
            try {
              const tryUrl = url.replace(/\/$/, '') + path;
              const html = await fetchUrl(tryUrl);
              tournaments = parseDirectWebsiteTournaments(html, venue.name);
              if (tournaments.length > 0) {
                url = tryUrl;
                break;
              }
            } catch (e) {
              console.warn(
                '[venue-tournaments] subpath fetch failed:',
                e instanceof Error ? e.message : e,
              );
            }
          }
        }

        stats.tournamentsFound += tournaments.length;

        const nowIso = new Date().toISOString();
        if (tournaments.length > 0) {
          for (const tournament of tournaments) {
            tournament.venue_id = venue.id;
            tournament.source_url = url;
            tournament.last_scraped = nowIso;
            tournament.is_active = true;

            const { error: insertError } = await supabase
              .from('venue_daily_tournaments')
              .upsert(tournament, {
                onConflict: 'venue_id,day_of_week,start_time,buy_in',
              });

            if (!insertError) stats.tournamentsInserted++;
          }
        }

        await supabase
          .from('poker_venues')
          .update({
            last_scraped: nowIso,
            scrape_status: tournaments.length > 0 ? 'complete' : 'no_tournaments',
          })
          .eq('id', venue.id);
      } catch (err) {
        stats.errors.push({
          venue: venue.name,
          error: err instanceof Error ? err.message : String(err),
        });
        await supabase
          .from('poker_venues')
          .update({ scrape_status: 'error', last_scraped: new Date().toISOString() })
          .eq('id', venue.id);
      }

      if (i < maxVenues - 1) await sleep(RATE_LIMIT_MS);
    }

    return c.json({
      success: true,
      stats,
      remaining: venues.length - maxVenues,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[venue-tournaments] fatal:', msg);
    return c.json({ success: false, error: msg, stats }, 500);
  }
}
