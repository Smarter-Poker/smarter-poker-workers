/**
 * Tour HTML Schedule Extractor
 * Ported from World Hub src/lib/tourHtmlExtractor.js (597 LOC).
 * Null-guards on all regex match[] for noUncheckedIndexedAccess.
 * LLM call uses fetch() instead of raw https.request.
 */

import https from 'node:https';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_LLM_CHARS = 12_000;
const LLM_MODEL = 'grok-3-mini';

// ─── Types ───────────────────────────────────────────────────────────────────
export interface HtmlEvent {
  event_number: number | null;
  date?: string | null;
  event_name: string;
  buy_in: number | null;
  guaranteed: number | null;
  starting_chips: number | null;
  levels?: number | null;
  start_time?: string | null;
  start_date?: string | null;
  game_type: string;
  event_type: string;
  source: string;
  llm_model?: string;
  notes?: string;
}

export interface HtmlExtractResult {
  events: HtmlEvent[];
  source: string;
  llm_used: boolean;
  error: string | null;
}

// ─── HTTP Fetch ───────────────────────────────────────────────────────────────
export function fetchHtml(url: string, redirects = 0): Promise<string> {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise<string>((resolve, reject) => {
    const protocol: typeof https | typeof http = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
      },
    }, (res: IncomingMessage) => {
      if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (!loc.startsWith('http')) {
          try { const u = new URL(url); loc = `${u.protocol}//${u.host}${loc}`; }
          catch { return reject(new Error('Bad redirect')); }
        }
        return fetchHtml(loc, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', (c: Buffer) => { data += c; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

// ─── Text helpers ─────────────────────────────────────────────────────────────
function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#[\d]+;/g, ' ')
    .replace(/\s{3,}/g, '  ').trim();
}

function detectGameType(text: string): string {
  const t = (text || '').toLowerCase();
  if (/plo|pot.?limit.?omaha/i.test(t)) return 'PLO';
  if (/omaha.?hi.?lo|o8|omaha.?8/i.test(t)) return 'O8';
  if (/omaha/i.test(t)) return 'Omaha';
  if (/limit(?!\s*omaha)/i.test(t) && !/no.?limit/i.test(t)) return 'Limit HE';
  if (/stud\s*hi.?lo|stud.?8/i.test(t)) return 'Stud 8';
  if (/stud/i.test(t)) return 'Stud';
  if (/razz/i.test(t)) return 'Razz';
  if (/horse/i.test(t)) return 'HORSE';
  if (/8.game|eight.game/i.test(t)) return '8-Game';
  if (/2.7|lowball/i.test(t)) return '2-7';
  if (/short.deck/i.test(t)) return 'Short Deck';
  if (/mixed/i.test(t)) return 'Mixed';
  return 'NLH';
}

function detectEventType(text: string): string {
  const t = (text || '').toLowerCase();
  if (/main\s*event/i.test(t)) return 'main_event';
  if (/satellite|sat\b|mega.sat|single.day.sat/i.test(t)) return 'satellite';
  if (/ultra\s*high\s*roller|super\s*high\s*roller|high\s*roller/i.test(t)) return 'high_roller';
  if (/mystery\s*bounty/i.test(t)) return 'mystery_bounty';
  if (/bounty|knockout|ko\b/i.test(t)) return 'bounty';
  if (/turbo/i.test(t)) return 'turbo';
  if (/deepstack|deep\s*stack/i.test(t)) return 'deepstack';
  if (/senior|seniors/i.test(t)) return 'seniors';
  if (/ladies|women/i.test(t)) return 'ladies';
  if (/tag\s*team/i.test(t)) return 'tag_team';
  if (/flip\s*&\s*go|flip.go/i.test(t)) return 'flip_go';
  if (/daily|nightly/i.test(t)) return 'daily';
  return 'side_event';
}

function dedup(events: HtmlEvent[]): HtmlEvent[] {
  const seen = new Set<string>();
  return events.filter(ev => {
    const key = `${ev.buy_in}:${(ev.event_name || '').substring(0, 30).toLowerCase().replace(/\s+/g, '')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Tour-specific parsers ─────────────────────────────────────────────────
function parseWsopHtml(html: string): HtmlEvent[] {
  const events: HtmlEvent[] = [];
  const text = htmlToText(html);
  const wsopEventRe = /Event\s*#?\s*(\d+)[:\s]+([A-Za-z]+\s+\d{1,2})[^\$]*\$([0-9,]+)\s+(No-Limit|Pot-Limit|Limit|NLH|PLO|NLHE|Mixed|HORSE|Stud|Razz|Omaha)[^$\n]{0,120}/gi;
  let m: RegExpExecArray | null;
  while ((m = wsopEventRe.exec(text)) !== null) {
    const buyIn = parseInt((m[3] ?? '').replace(/,/g, ''), 10);
    if (!buyIn || buyIn < 100 || buyIn > 1_000_000) continue;
    const rawName = `$${buyIn.toLocaleString()} ${m[4] ?? ''} Hold'em`;
    events.push({ event_number: parseInt(m[1] ?? '', 10), date: (m[2] ?? '').trim(), event_name: rawName.substring(0, 120), buy_in: buyIn, guaranteed: null, starting_chips: null, game_type: detectGameType(m[4] ?? ''), event_type: detectEventType(rawName), source: 'wsop_html_parser' });
  }
  if (events.length < 5) {
    const simpleRe = /\$([0-9,]+)\s+(No-Limit|Pot-Limit|NLH|PLO|HORSE|Stud|Razz|Mixed|Omaha)[^$]{5,100}/gi;
    while ((m = simpleRe.exec(text)) !== null) {
      const buyIn = parseInt((m[1] ?? '').replace(/,/g, ''), 10);
      if (!buyIn || buyIn < 100 || buyIn > 1_000_000) continue;
      const rawName = `$${buyIn.toLocaleString()} ${m[2] ?? ''} Hold'em`;
      events.push({ event_number: null, event_name: rawName.substring(0, 120), buy_in: buyIn, guaranteed: null, starting_chips: null, game_type: detectGameType(m[2] ?? ''), event_type: detectEventType(rawName), source: 'wsop_html_fallback' });
    }
  }
  return dedup(events);
}

function parseWptHtml(html: string): HtmlEvent[] {
  const events: HtmlEvent[] = [];
  const text = htmlToText(html);
  const wptStopRe = /WPT\s+([A-Za-z\s&']+?)(?:\s+\||\s{2,})((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2})[^\$]{0,100}\$([0-9,]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = wptStopRe.exec(text)) !== null) {
    const buyIn = parseInt((m[3] ?? '').replace(/,/g, ''), 10);
    if (!buyIn || buyIn < 500 || buyIn > 500_000) continue;
    events.push({ event_number: null, date: (m[2] ?? '').trim(), event_name: `WPT ${(m[1] ?? '').trim()} Main Event`, buy_in: buyIn, guaranteed: null, starting_chips: null, game_type: 'NLH', event_type: 'main_event', source: 'wpt_html_parser' });
  }
  if (events.length < 3) {
    const buyInRe = /\$([0-9,]+)\s+(?:No.Limit|NLH|Buy.In|Main|Championship|Bounty|High.Roller|Deepstack)[^$\n]{0,80}/gi;
    while ((m = buyInRe.exec(text)) !== null) {
      const buyIn = parseInt((m[1] ?? '').replace(/,/g, ''), 10);
      if (!buyIn || buyIn < 300 || buyIn > 500_000) continue;
      const eventName = m[0].trim().substring(0, 120);
      events.push({ event_number: null, event_name: eventName, buy_in: buyIn, guaranteed: null, starting_chips: null, game_type: detectGameType(eventName), event_type: detectEventType(eventName), source: 'wpt_html_fallback' });
    }
  }
  return dedup(events);
}

function parseWsopcHtml(html: string): HtmlEvent[] {
  const events: HtmlEvent[] = [];
  const text = htmlToText(html);
  const stops: Array<{ dates: string; venue: string }> = [];
  const stopRe = /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2})\s*[-–]\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)?[a-z]*\s*\d{1,2})\s*,?\s*\d{4}?\s*([A-Za-z][A-Za-z\s&',.-]{5,60}?)(?:\s{2,}|\|)/gi;
  let m: RegExpExecArray | null;
  while ((m = stopRe.exec(text)) !== null) stops.push({ dates: `${m[1] ?? ''} - ${m[2] ?? ''}`, venue: (m[3] ?? '').trim() });
  const wsopcEventRe = /\$([0-9,]+)\s+(No.Limit|NLH|Pot.Limit|Omaha|Turbo|Seniors?|Ladies|Deepstack|Bounty|Mystery)[^$]{0,100}/gi;
  while ((m = wsopcEventRe.exec(text)) !== null) {
    const buyIn = parseInt((m[1] ?? '').replace(/,/g, ''), 10);
    if (!buyIn || buyIn < 100 || buyIn > 100_000) continue;
    const eventName = `$${buyIn.toLocaleString()} ${m[2] ?? ''}`.substring(0, 120);
    events.push({ event_number: null, event_name: eventName, buy_in: buyIn, guaranteed: null, starting_chips: null, game_type: detectGameType(m[2] ?? ''), event_type: detectEventType(eventName), source: 'wsopc_html_parser' });
  }
  if (stops.length > 0 && events.length < 5) {
    const standardEvents = [
      { name: 'WSOP Circuit Ring Event #1 - $365 NLH', buy_in: 365 },
      { name: 'WSOP Circuit Ring Event #2 - $600 NLH Deepstack', buy_in: 600 },
      { name: 'WSOP Circuit Ring Event #12 - $1,700 NLH Main Event', buy_in: 1700 },
    ];
    standardEvents.forEach((ev, i) => {
      events.push({ event_number: i + 1, event_name: ev.name, buy_in: ev.buy_in, guaranteed: ev.buy_in === 1700 ? 1_000_000 : null, starting_chips: null, game_type: detectGameType(ev.name), event_type: detectEventType(ev.name), source: 'wsopc_template', notes: `Stop: ${stops[0]?.venue ?? 'TBD'} ${stops[0]?.dates ?? ''}` });
    });
  }
  return dedup(events);
}

function parseGenericTourHtml(html: string): HtmlEvent[] {
  const events: HtmlEvent[] = [];
  const text = htmlToText(html);
  let m: RegExpExecArray | null;
  const p1 = /Event\s*#?\s*(\d+)[:\s]+\$([0-9,]+)\s+([A-Za-z][^$\n]{5,100})/gi;
  while ((m = p1.exec(text)) !== null) {
    const buyIn = parseInt((m[2] ?? '').replace(/,/g, ''), 10);
    if (!buyIn || buyIn < 50 || buyIn > 500_000) continue;
    const eventName = `$${buyIn.toLocaleString()} ${(m[3] ?? '').trim()}`.substring(0, 120);
    events.push({ event_number: parseInt(m[1] ?? '', 10) || null, event_name: eventName, buy_in: buyIn, guaranteed: null, starting_chips: null, game_type: detectGameType(m[3] ?? ''), event_type: detectEventType(eventName), source: 'generic_html_p1' });
  }
  const p2 = /\$([0-9,]+)\s+((?:No.Limit|Pot.Limit|Limit|NLH|NLHE|PLO|Omaha|Stud|Razz|HORSE|Mixed|Deepstack|Bounty|Main|Championship|High.Roller|Turbo|Seniors?|Ladies)[^$\n]{3,100})/gi;
  while ((m = p2.exec(text)) !== null) {
    const buyIn = parseInt((m[1] ?? '').replace(/,/g, ''), 10);
    if (!buyIn || buyIn < 50 || buyIn > 500_000) continue;
    const eventName = `$${buyIn.toLocaleString()} ${(m[2] ?? '').trim()}`.substring(0, 120);
    events.push({ event_number: null, event_name: eventName, buy_in: buyIn, guaranteed: null, starting_chips: null, game_type: detectGameType(m[2] ?? ''), event_type: detectEventType(eventName), source: 'generic_html_p2' });
  }
  return dedup(events);
}

const TOUR_PARSERS: Record<string, (html: string) => HtmlEvent[]> = {
  WSOP: parseWsopHtml,
  WPT: parseWptHtml,
  WSOPC: parseWsopcHtml,
};

// ─── LLM fallback (fetch-based) ───────────────────────────────────────────────
async function extractWithLLM(text: string, tourCode: string, sourceName: string, apiKey: string): Promise<HtmlEvent[]> {
  const trimmedText = text.substring(0, MAX_LLM_CHARS);
  const prompt = `Extract poker tournament schedule from ${tourCode} (${sourceName}). Return ONLY valid JSON array. Each object: event_number(int|null), event_name(string), buy_in(int), start_date("YYYY-MM-DD"|null), start_time(string|null), guaranteed(int|null), starting_chips(int|null), game_type(NLH|PLO|O8|Stud|HORSE|Mixed|etc), event_type(main_event|satellite|high_roller|mystery_bounty|bounty|turbo|deepstack|seniors|ladies|side_event). Return [] if no events found.\n\nText:\n${trimmedText}`;

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: LLM_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 4000, temperature: 0 }),
      signal: AbortSignal.timeout(30_000),
    });
    const parsed = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = parsed.choices?.[0]?.message?.content ?? '[]';
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const raw = JSON.parse(jsonMatch[0]) as unknown[];
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((ev): ev is Record<string, unknown> => typeof ev === 'object' && ev !== null)
      .filter(ev => typeof ev['buy_in'] === 'number' && (ev['buy_in'] as number) >= 50)
      .map(ev => ({
        event_number: typeof ev['event_number'] === 'number' ? ev['event_number'] : null,
        event_name: String(ev['event_name'] ?? '').substring(0, 120),
        buy_in: parseInt(String(ev['buy_in']), 10) || null,
        start_date: typeof ev['start_date'] === 'string' ? ev['start_date'] : null,
        start_time: typeof ev['start_time'] === 'string' ? ev['start_time'] : null,
        guaranteed: typeof ev['guaranteed'] === 'number' ? ev['guaranteed'] : null,
        starting_chips: typeof ev['starting_chips'] === 'number' ? ev['starting_chips'] : null,
        game_type: typeof ev['game_type'] === 'string' ? ev['game_type'] : detectGameType(String(ev['event_name'] ?? '')),
        event_type: typeof ev['event_type'] === 'string' ? ev['event_type'] : detectEventType(String(ev['event_name'] ?? '')),
        source: 'llm_extraction',
        llm_model: LLM_MODEL,
      }));
  } catch (e) {
    console.debug(`  [LLM:${tourCode}] error: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

// ─── Main entry points ────────────────────────────────────────────────────────
export async function extractScheduleFromHtml(html: string, tourCode: string, sourceName = '', options: { xaiApiKey?: string; minExpected?: number } = {}): Promise<HtmlExtractResult> {
  const { xaiApiKey, minExpected = 5 } = options;
  const apiKey = xaiApiKey ?? process.env.XAI_API_KEY;

  if (!html || html.length < 200) return { events: [], source: sourceName, llm_used: false, error: 'Empty HTML' };

  const parser = TOUR_PARSERS[tourCode] ?? parseGenericTourHtml;
  let events = parser(html);
  console.debug(`  [HTML:${tourCode}] Bespoke → ${events.length} events from ${sourceName}`);
  let llmUsed = false;

  if (events.length < minExpected && apiKey) {
    console.debug(`  [HTML:${tourCode}] Below threshold — trying LLM...`);
    const llmEvents = await extractWithLLM(htmlToText(html), tourCode, sourceName, apiKey);
    if (llmEvents.length > events.length) { events = dedup([...llmEvents, ...events]); llmUsed = true; }
  }

  return { events, source: sourceName, llm_used: llmUsed, error: null };
}

export async function fetchAndExtract(url: string, tourCode: string, sourceName = '', options: { xaiApiKey?: string; minExpected?: number } = {}): Promise<HtmlExtractResult> {
  try {
    console.debug(`  [HTML:${tourCode}] Fetching: ${url}`);
    const html = await fetchHtml(url);
    return extractScheduleFromHtml(html, tourCode, sourceName, options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.debug(`  [HTML:${tourCode}] Fetch error: ${msg}`);
    return { events: [], source: sourceName, llm_used: false, error: msg };
  }
}
