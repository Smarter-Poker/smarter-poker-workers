/**
 * GET/POST /cron/scrape-charity-schedules
 *
 * Ported from pages/api/cron/scrape-charity-schedules.js (529 lines).
 *
 * Every 3 days at 03:00: pull tournament schedules from 21 hardcoded
 * charity-venue source URLs (CHARITY_SOURCE_REGISTRY). Plain HTTP fetch
 * with 3-attempt exponential backoff (1s/3s/7s). Parses HTML for two
 * patterns (day+time on one line, day on one then time on next).
 *
 * Idempotence:
 *   - 3-day staleness window (last_scraped > now-3d → skip unless force=true)
 *   - venue_daily_tournaments upsert ON CONFLICT (venue_id, day_of_week,
 *     start_time) — repeated runs over same data are no-op deltas
 *
 * Provenance: SHA-256 hash of raw response body persists as
 * scrape_html_hash. Each run gets a batchId, written to data_audit_log.
 *
 * Query params: force=true, venue=<id>, dry=true
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import { getSupabase } from '../lib/supabase.js';

const RESCRAPE_INTERVAL_DAYS = 3;
const RATE_LIMIT_MS = 1500;
const FETCH_TIMEOUT_MS = 12000;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 7000] as const;

interface RegistryEntry {
  name: string;
  urls: string[];
}

const CHARITY_SOURCE_REGISTRY: Record<string, RegistryEntry> = {
  '2802': {
    name: 'Chicago Charitable Games (CCG Poker)',
    urls: ['https://chicagocharitablegames.com', 'https://chicagocharitablegames.com/schedule'],
  },
  '2803': {
    name: 'Windy City Poker Championship',
    urls: ['https://windycity.poker', 'https://windycity.poker/schedule'],
  },
  '2804': {
    name: 'Rockford Charitable Games (RCG Poker)',
    urls: ['https://rcgpoker.com', 'https://rcgpoker.com/schedule'],
  },
  '2806': {
    name: 'Shark Tank Poker Club',
    urls: ['https://sharktankpokerclub.com', 'https://sharktankpokerclub.com/daily-tournaments'],
  },
  '2807': {
    name: 'The Reserve Poker Club',
    urls: ['https://thereservepoker.com', 'https://thereservepoker.com/tournaments'],
  },
  '2809': {
    name: 'River Room Players Club',
    urls: ['https://riverroompoker.com', 'https://riverroompoker.com/tournament-schedule'],
  },
  '2810': {
    name: 'OP Social Club / Outlaw Poker',
    urls: ['https://opsocialclub.com/activities', 'https://opsocialclub.com'],
  },
  '2813': {
    name: 'Concord Casino',
    urls: ['https://concordnhcasino.com/poker', 'https://concordnhcasino.com'],
  },
  '2814': {
    name: 'Gate City Casino',
    urls: ['https://thegatecitycasino.com/poker', 'https://thegatecitycasino.com'],
  },
  '2815': {
    name: "Pop's Poker",
    urls: [
      'https://popspoker.com/schedule',
      'https://popspoker.com/tournaments',
      'https://popspoker.com',
    ],
  },
  '2816': {
    name: 'RVA Charity Poker',
    urls: ['https://rvacharitypoker.org', 'https://rvacharitypoker.org/schedule'],
  },
  '2817': {
    name: 'ACES Charity Poker',
    urls: ['https://acescharitypoker.org', 'https://acescharitypoker.org/schedule'],
  },
  '2823': { name: 'Play Poker Chicago', urls: ['https://playpokerchicago.com'] },
  '2826': {
    name: 'Westfield Lions Club Poker',
    urls: ['https://lionspoker.org/tournament-details', 'https://lionspoker.org'],
  },
  '2827': {
    name: 'Monroe Boat Club (MBC-A Charity Poker)',
    urls: ['https://monroeboatclub.org/events', 'https://monroeboatclub.org'],
  },
  '2829': {
    name: 'Evlos Charity Poker',
    urls: ['https://evloscharitypoker.com', 'https://evloscharitypoker.com/schedule'],
  },
  '2836': {
    name: 'Westgate Poker Room',
    urls: [
      'https://westgateresorts.com/hotels/michigan/comstock-park/westgate-lakelands-resort/poker/',
      'https://www.pokeratlas.com/poker-room/westgate-poker-room-comstock-park',
    ],
  },
  '3118': {
    name: 'Concord NH Casino',
    urls: ['https://concordnhcasino.com/poker', 'https://concordnhcasino.com'],
  },
  '3119': { name: 'TGT Poker Room', urls: ['https://tgtpoker.com/tournaments', 'https://tgtpoker.com'] },
  '1829': {
    name: 'Texas Card House Austin',
    urls: ['https://texascardhouse.com/austin/tournaments', 'https://texascardhouse.com'],
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface FetchResult {
  body: string;
  htmlHash: string;
}

async function fetchWithRetry(url: string, attempt = 0): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const htmlHash = createHash('sha256').update(buf).digest('hex');
    return { body: buf.toString('utf8'), htmlHash };
  } catch (err) {
    clearTimeout(timeout);
    if (attempt < MAX_RETRIES - 1) {
      const wait = RETRY_DELAYS[attempt] ?? 5000;
      await sleep(wait);
      return fetchWithRetry(url, attempt + 1);
    }
    throw err;
  }
}

const DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

const DAY_ABBREV: Record<string, string> = {
  mon: 'monday',
  tue: 'tuesday',
  tues: 'tuesday',
  wed: 'wednesday',
  thu: 'thursday',
  thur: 'thursday',
  fri: 'friday',
  sat: 'saturday',
  sun: 'sunday',
};

function normalizeDay(raw: string): string | null {
  const s = raw.toLowerCase().trim();
  if ((DAYS as readonly string[]).includes(s)) return s;
  if (DAY_ABBREV[s]) return DAY_ABBREV[s]!;
  for (const d of DAYS) {
    if (d.startsWith(s.slice(0, 3))) return d;
  }
  return null;
}

function parseTime24h(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().toUpperCase().replace(/\./g, '');
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM|A|P)?$/);
  if (!m || !m[1]) return null;
  let h = parseInt(m[1], 10);
  const mn = parseInt(m[2] ?? '0', 10);
  const ap = m[3] ?? '';
  if (ap.startsWith('P') && h !== 12) h += 12;
  else if (ap.startsWith('A') && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}:00`;
}

interface Schedule {
  day_of_week: string;
  start_time: string;
  buy_in: number | null;
  game_type: string;
  format: string | null;
  guaranteed: number | null;
  source_url: string;
}

function extractSchedules(html: string, sourceUrl: string): Schedule[] {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

  const seen = new Set<string>();
  const schedules: Schedule[] = [];

  // Pattern A: day + time on same line
  const patA =
    /(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|fri|sat|sun)s?\b.{0,250}?(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm|a\.m\.|p\.m\.))/gi;
  for (const m of text.matchAll(patA)) {
    const dayRaw = m[1];
    const timeRaw = m[2];
    if (!dayRaw || !timeRaw) continue;
    const day = normalizeDay(dayRaw);
    if (!day) continue;
    const st = parseTime24h(timeRaw.trim());
    if (!st) continue;
    const key = `${day}|${st}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const ctx = text.slice(m.index ?? 0, (m.index ?? 0) + 400);
    const bi = ctx.match(/\$(\d{2,4})/);
    let gt = 'NLH';
    if (/\bPLO\b|Pot.?Limit Omaha/i.test(ctx)) gt = 'PLO';
    else if (/\bOmaha\b/i.test(ctx)) gt = 'PLO';
    let fmt: string | null = null;
    if (/bounty|knockout|\bKO\b/i.test(ctx)) fmt = 'Bounty';
    else if (/deep.?stack/i.test(ctx)) fmt = 'Deep Stack';
    else if (/rebuy/i.test(ctx)) fmt = 'Rebuy';
    else if (/turbo/i.test(ctx)) fmt = 'Turbo';
    const gtd = ctx.match(/\$([0-9,]+)\s*(?:GTD|guaranteed)/i);

    schedules.push({
      day_of_week: day,
      start_time: st,
      buy_in: bi && bi[1] ? parseInt(bi[1], 10) : null,
      game_type: gt,
      format: fmt,
      guaranteed: gtd && gtd[1] ? parseInt(gtd[1].replace(/,/g, ''), 10) : null,
      source_url: sourceUrl,
    });
  }

  // Pattern B: day on a line, time after newline/dash/separator
  const patB =
    /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)s?\s*[\n:—–-]{0,10}\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))/gi;
  for (const m of text.matchAll(patB)) {
    const dayRaw = m[1];
    const timeRaw = m[2];
    if (!dayRaw || !timeRaw) continue;
    const day = normalizeDay(dayRaw);
    if (!day) continue;
    const st = parseTime24h(timeRaw.trim());
    if (!st) continue;
    const key = `${day}|${st}`;
    if (seen.has(key)) continue;
    seen.add(key);
    schedules.push({
      day_of_week: day,
      start_time: st,
      buy_in: null,
      game_type: 'NLH',
      format: null,
      guaranteed: null,
      source_url: sourceUrl,
    });
  }

  return schedules;
}

interface ScrapeResult {
  success: boolean;
  url?: string;
  schedules?: Schedule[];
  htmlBytes?: number;
  htmlHash?: string | null;
  error?: string;
}

async function scrapeVenue(_venueId: string, registryEntry: RegistryEntry): Promise<ScrapeResult> {
  const { urls } = registryEntry;
  let lastError: string | null = null;

  for (const url of urls) {
    try {
      const { body, htmlHash } = await fetchWithRetry(url);
      if (!body || body.length < 300) {
        lastError = `Response too thin (${body?.length || 0} bytes)`;
        continue;
      }
      const schedules = extractSchedules(body, url);
      if (schedules.length > 0) {
        return { success: true, url, schedules, htmlBytes: body.length, htmlHash };
      }
      lastError = `No schedule patterns in HTML (${body.length} bytes)`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(RATE_LIMIT_MS);
  }

  return { success: false, error: lastError ?? 'unknown', htmlHash: null };
}

interface VenueRow {
  id: string | number;
  name: string;
  last_scraped: string | null;
  scrape_status: string | null;
}

export async function scrapeCharitySchedules(c: Context) {
  try {
    const force = c.req.query('force') === 'true';
    const venueFilter = c.req.query('venue');
    const isDryRun = c.req.query('dry') === 'true';
    const supabase = getSupabase();

    const batchId = (() => {
      try {
        return randomUUID();
      } catch {
        return `batch-${Date.now()}`;
      }
    })();
    const startedAt = new Date().toISOString();

    let query = supabase
      .from('poker_venues')
      .select('id, name, last_scraped, scrape_status')
      .eq('venue_type', 'charity')
      .order('name');

    if (venueFilter) query = query.eq('id', venueFilter);

    const { data: venuesData, error: venuesError } = await query;
    if (venuesError) {
      return c.json(
        { error: 'DB error fetching venues', details: venuesError.message },
        500,
      );
    }

    const venues = (venuesData ?? []) as VenueRow[];

    const stats = {
      batchId,
      startedAt,
      total: 0,
      scraped: 0,
      skipped: 0,
      inserted: 0,
      noData: 0,
      errors: [] as Array<{ id: string; name: string; error: string }>,
      results: [] as Array<Record<string, unknown>>,
    };

    const cutoff = new Date(
      Date.now() - RESCRAPE_INTERVAL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    for (const venue of venues) {
      const vid = String(venue.id);
      const entry = CHARITY_SOURCE_REGISTRY[vid];
      if (!entry) continue;

      stats.total++;

      if (!force && venue.last_scraped && venue.last_scraped > cutoff) {
        stats.skipped++;
        stats.results.push({
          id: vid,
          name: venue.name,
          status: 'skipped_fresh',
          last_scraped: venue.last_scraped,
        });
        continue;
      }

      const result = await scrapeVenue(vid, entry);

      if (!result.success || !result.schedules || result.schedules.length === 0) {
        stats.noData++;
        stats.errors.push({
          id: vid,
          name: venue.name,
          error: result.error ?? 'No schedules found',
        });

        if (!isDryRun) {
          await supabase
            .from('poker_venues')
            .update({
              last_scraped: new Date().toISOString(),
              scrape_status: 'no_data',
            })
            .eq('id', venue.id);
        }

        stats.results.push({
          id: vid,
          name: venue.name,
          status: 'no_data',
          error: result.error,
        });
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      stats.scraped++;
      let insertedHere = 0;

      if (!isDryRun) {
        const deduped = new Map<string, Schedule>();
        for (const s of result.schedules) {
          const k = `${s.day_of_week}|${s.start_time}`;
          if (!deduped.has(k)) deduped.set(k, s);
        }

        for (const [, sched] of deduped) {
          const record = {
            venue_id: venue.id,
            venue_name: venue.name,
            day_of_week: sched.day_of_week,
            start_time: sched.start_time || 'TBA',
            buy_in: sched.buy_in,
            game_type: sched.game_type || 'NLH',
            format: sched.format,
            guaranteed: sched.guaranteed,
            source_url: sched.source_url || result.url,
            is_active: true,
            data_quality: 'scraped_verified',
            scrape_html_hash: result.htmlHash ?? null,
            scrape_timestamp: new Date().toISOString(),
            scrape_batch_id: batchId,
            scrape_confidence: 'medium',
          };

          const { error: upsertError } = await supabase
            .from('venue_daily_tournaments')
            .upsert(record, { onConflict: 'venue_id,day_of_week,start_time' });

          if (!upsertError) {
            insertedHere++;
            stats.inserted++;
          } else {
            console.warn(
              `[scrape-charity-schedules] upsert error for ${venue.name}:`,
              upsertError.message,
            );
          }
        }

        await supabase
          .from('poker_venues')
          .update({
            last_scraped: new Date().toISOString(),
            scrape_status: insertedHere > 0 ? 'complete' : 'no_new_data',
            scrape_url: result.url,
          })
          .eq('id', venue.id);
      }

      stats.results.push({
        id: vid,
        name: venue.name,
        status: 'success',
        url: result.url,
        schedulesFound: result.schedules.length,
        inserted: insertedHere,
      });

      await sleep(RATE_LIMIT_MS);
    }

    if (!isDryRun) {
      try {
        await supabase.from('data_audit_log').insert({
          table_name: 'venue_daily_tournaments',
          action: 'charity_schedule_cron',
          records_affected: stats.inserted,
          batch_id: batchId,
          agent_id: 'scrape-charity-schedules-cron',
          details: JSON.stringify({
            started_at: startedAt,
            completed_at: new Date().toISOString(),
            total_venues: stats.total,
            scraped: stats.scraped,
            skipped_fresh: stats.skipped,
            no_data: stats.noData,
            inserted: stats.inserted,
            errors: stats.errors.length,
            script: '/cron/scrape-charity-schedules',
          }),
        });
      } catch (auditErr) {
        console.warn(
          '[scrape-charity-schedules] audit log non-fatal:',
          auditErr instanceof Error ? auditErr.message : auditErr,
        );
      }
    }

    return c.json({
      success: true,
      isDryRun,
      batchId,
      stats: {
        venuesInRegistry: Object.keys(CHARITY_SOURCE_REGISTRY).length,
        total: stats.total,
        scraped: stats.scraped,
        skippedFresh: stats.skipped,
        noData: stats.noData,
        inserted: stats.inserted,
        errors: stats.errors,
      },
      results: stats.results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[scrape-charity-schedules] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
