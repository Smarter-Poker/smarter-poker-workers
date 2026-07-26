/**
 * Tour PDF Schedule Extractor
 * ═══════════════════════════════════════════════════════════
 * Ported from World Hub src/lib/tourPdfExtractor.js (483 LOC).
 *
 * Downloads and parses poker tour schedule PDFs.
 * Pure regex on buffer-stringified text — no heavy pdf-parse dep.
 * Dynamic import of pdf-parse v2 attempted first; fallback to
 * latin1 text extraction if unavailable.
 *
 * Port notes:
 *   - noUncheckedIndexedAccess guards added on all regex match[]
 *   - Dynamic import of pdf-parse wrapped in try/catch
 *   - Strict null checks throughout
 */

import https from 'node:https';
import http from 'node:http';
import type { IncomingMessage, RequestOptions } from 'node:http';

// ─── Config ───────────────────────────────────────────────────────────────────
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

// ─── Types ───────────────────────────────────────────────────────────────────
export interface PdfEvent {
  event_number: number | null;
  event_number_raw?: string;
  start_time: string | null;
  event_name: string;
  buy_in: number | null;
  guaranteed: number | null;
  starting_chips: number | null;
  levels: number | null;
  game_type: string;
  event_type: string;
  date?: string | null;
  series_name?: string;
  tour_code?: string;
  pdf_source_url?: string;
  source: string;
}

export interface PdfExtractResult {
  events: PdfEvent[];
  pages: number;
  raw_text?: string;
  rawTextLength: number;
  error: string | null;
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

export function isPdfUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.endsWith('.pdf') ||
    lower.includes('showpdf') ||
    lower.includes('/pdf/') ||
    lower.includes('download_pdf') ||
    lower.includes('schedule.pdf') ||
    lower.includes('brochure.pdf') ||
    lower.includes('flyer.pdf')
  );
}

export function findPdfLinks(html: string | null | undefined, baseUrl: string): string[] {
  if (!html) return [];
  const links: string[] = [];
  const seen = new Set<string>();

  const patterns = [
    /href=["']([^"']*\.pdf[^"']*)/gi,
    /href=["']([^"']*showpdf[^"']*)/gi,
    /href=["']([^"']*\/pdf\/[^"']*)/gi,
    /href=["']([^"']*download[^"']*\.pdf[^"']*)/gi,
    /"url":\s*"([^"]*\.pdf[^"]*)"/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      let url = match[1];
      if (!url) continue;
      if (url.startsWith('//')) {
        url = 'https:' + url;
      } else if (url.startsWith('/')) {
        try {
          const base = new URL(baseUrl);
          url = `${base.protocol}//${base.host}${url}`;
        } catch { continue; }
      } else if (!url.startsWith('http')) {
        continue;
      }
      if (!seen.has(url)) {
        seen.add(url);
        links.push(url);
      }
    }
  }
  return links;
}

// ─── Binary download ─────────────────────────────────────────────────────────

function downloadBinary(url: string, redirects = 0): Promise<Buffer> {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));

  return new Promise<Buffer>((resolve, reject) => {
    const protocol: typeof https | typeof http = url.startsWith('https') ? https : http;
    const options: RequestOptions = {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'application/pdf,application/octet-stream,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };

    const request = protocol.get(url, options, (response: IncomingMessage) => {
      if (
        response.statusCode !== undefined &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        let redirectUrl = response.headers.location;
        if (!redirectUrl.startsWith('http')) {
          try {
            const u = new URL(url);
            redirectUrl = `${u.protocol}//${u.host}${redirectUrl}`;
          } catch { return reject(new Error('Bad redirect URL')); }
        }
        return downloadBinary(redirectUrl, redirects + 1).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP ${response.statusCode} from ${url}`));
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;
      response.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_PDF_SIZE_BYTES) {
          request.destroy();
          reject(new Error(`PDF too large (>${MAX_PDF_SIZE_BYTES / 1024 / 1024}MB)`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy();
      reject(new Error('Download timeout'));
    });
    request.on('error', reject);
  });
}

// ─── Game / Event type detection ──────────────────────────────────────────────

function detectGameType(text: string): string {
  const t = (text || '').toLowerCase();
  if (/plo|pot.?limit.?omaha/i.test(t)) return 'PLO';
  if (/omaha.?hi.?lo|o8|omaha.?8/i.test(t)) return 'O8';
  if (/omaha/i.test(t)) return 'Omaha';
  if (/limit(?!\s*omaha)/i.test(t) && !/no.?limit/i.test(t)) return 'Limit HE';
  if (/stud/i.test(t)) return 'Stud';
  if (/razz/i.test(t)) return 'Razz';
  if (/horse/i.test(t)) return 'HORSE';
  if (/8.game|eight.game/i.test(t)) return '8-Game';
  if (/mixed/i.test(t)) return 'Mixed';
  return 'NLH';
}

function detectEventType(text: string): string {
  const t = (text || '').toLowerCase();
  if (/main\s*event/i.test(t)) return 'main_event';
  if (/satellite|sat\b/i.test(t)) return 'satellite';
  if (/high\s*roller/i.test(t)) return 'high_roller';
  if (/mystery\s*bounty/i.test(t)) return 'mystery_bounty';
  if (/bounty|knockout|ko\b/i.test(t)) return 'bounty';
  if (/turbo/i.test(t)) return 'turbo';
  if (/deepstack|deep\s*stack/i.test(t)) return 'deepstack';
  if (/senior|seniors/i.test(t)) return 'seniors';
  if (/ladies|women/i.test(t)) return 'ladies';
  if (/tag\s*team/i.test(t)) return 'tag_team';
  if (/daily|nightly/i.test(t)) return 'daily';
  return 'side_event';
}

// ─── PDF text parsers ────────────────────────────────────────────────────────

// Date section headings that tour PDFs group their events under, e.g.
// "Friday, March 14", "MARCH 14, 2026", "Mar 14".
const DATE_HEADING_RE =
  /^(?:(?:Mon|Tues?|Wednes|Wed|Thurs?|Fri|Satur|Sat|Sun)[a-z]*\.?,?\s*)?((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2})(?:\s*,?\s*(\d{4}))?\s*[-–—:]?\s*$/i;

function extractDateHeading(line: string): string | null {
  const m = DATE_HEADING_RE.exec(line.trim());
  if (!m || !m[1]) return null;
  const date = m[1].replace(/\./g, '').replace(/\s+/g, ' ').trim();
  return m[2] ? `${date} ${m[2]}` : date;
}

function parseScheduleText(rawText: string): PdfEvent[] {
  const events: PdfEvent[] = [];
  const seen = new Set<string>();
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 2);

  const eventLineRe =
    /^(\d{1,3}[A-C]?)\s+(\d{1,2}:\d{2}\s*[AP]M)\s+(\$[\d,]+)\s+(.{5,100}?)(?:\s+\d{1,2}:\d{2}\s*[AP]M|\s+\$[\d,]+,\d{3}|\s*$)/i;

  // Tour PDFs list events under a date heading; without tracking it every
  // main-parser event landed with start_date NULL (undatable in search).
  let currentDate: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = eventLineRe.exec(line);
    if (!m) {
      const heading = extractDateHeading(line);
      if (heading) currentDate = heading;
      continue;
    }

    const evNumRaw = m[1] ?? '';
    const startTime = (m[2] ?? '').trim();
    const buyInStr = (m[3] ?? '').replace(/[,$]/g, '');
    const buyIn = parseInt(buyInStr, 10);
    const rawDesc = (m[4] ?? '').trim();

    if (!buyIn || buyIn < 50 || buyIn > 500_000) continue;
    if (rawDesc.length < 4) continue;

    const eventName = `$${buyIn.toLocaleString()} ${rawDesc}`.substring(0, 120);
    const lookAhead = [
      line,
      i + 1 < lines.length ? (lines[i + 1] ?? '') : '',
      i + 2 < lines.length ? (lines[i + 2] ?? '') : '',
    ].join(' ');

    let gtd: number | null = null;
    const gtdMatch =
      lookAhead.match(/\$([\d,]{5,})\s+(?:guaranteed|GTD)?/i) ??
      lookAhead.match(/\$([1-9][\d,]{3,})\s*\d{2,3},\d{3}/);
    if (gtdMatch) {
      gtd = parseInt((gtdMatch[1] ?? '').replace(/,/g, ''), 10);
      if (gtd < 5_000 || gtd > 50_000_000) gtd = null;
    }

    let chips: number | null = null;
    const chipsMatches = lookAhead.match(/\b([\d]{2,3},\d{3})\b/g);
    if (chipsMatches) {
      for (const cm of chipsMatches) {
        const n = parseInt(cm.replace(/,/g, ''), 10);
        if (n >= 5_000 && n <= 500_000 && n % 1_000 === 0) {
          chips = n;
          break;
        }
      }
    }

    let levels: number | null = null;
    // Trophy / card pictograph markers (written as escapes, not literal
    // characters) plus the plain-text equivalents. Dropping the pictographs
    // outright lost the level count on every PDF that uses them.
    const levMatch = lookAhead.match(
      /\b(\d{2})\s+(?:\uD83C\uDFC6|\uD83C\uDCCF|POY|Points?|Levels?|$)/i,
    );
    if (levMatch?.[1]) levels = parseInt(levMatch[1], 10);

    // Date is part of the identity: a series repeats the same event across days.
    const dedupKey = `${currentDate ?? 'nodate'}:${buyIn}:${rawDesc.substring(0, 25).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    events.push({
      event_number: parseInt(evNumRaw, 10) || null,
      event_number_raw: evNumRaw,
      start_time: startTime,
      event_name: eventName,
      buy_in: buyIn,
      guaranteed: gtd,
      starting_chips: chips,
      levels,
      date: currentDate,
      game_type: detectGameType(rawDesc),
      event_type: detectEventType(rawDesc),
      source: 'pdf_extraction',
    });
  }

  if (events.length === 0) return parseScheduleTextFallback(rawText);
  return events;
}

function parseScheduleTextFallback(rawText: string): PdfEvent[] {
  const events: PdfEvent[] = [];
  const text = rawText.replace(/\n/g, ' ').replace(/\s+/g, ' ');

  const patterns: RegExp[] = [
    /\$([0-9,]+)\s+((?:No-Limit|Pot-Limit|Limit|NLH|PLO|Omaha|Hold|Stud|Razz|HORSE|Mixed|Deepstack|Bounty|Championship|Main Event|High Roller|Mystery|Turbo|Super|Mega|Monster|Flash|Seniors?|Ladies)[^$\n.]{3,100})/gi,
    /Event\s*#?\s*(\d+)[:\s]+\$([0-9,]+)\s+([A-Za-z][^$\n]{5,100})/gi,
    /\$([0-9,]+)\s+([A-Za-z][^–$\n]{10,80})\s*[–-]\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2})/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      let buyIn: number;
      let eventName: string;
      let eventNum: number | null = null;

      if (pattern.source.startsWith('Event')) {
        eventNum = parseInt(match[1] ?? '', 10);
        buyIn = parseInt((match[2] ?? '').replace(/,/g, ''), 10);
        eventName = (match[3] ?? '').trim().substring(0, 120);
      } else {
        buyIn = parseInt((match[1] ?? '').replace(/,/g, ''), 10);
        eventName = (match[2] ?? '').trim().substring(0, 120);
      }

      if (!buyIn || buyIn < 50 || buyIn > 500_000 || !eventName || eventName.length < 5) continue;

      const exists = events.some(
        (e) =>
          e.event_name.toLowerCase().startsWith(eventName.toLowerCase().substring(0, 20)) &&
          e.buy_in === buyIn,
      );
      if (exists) continue;

      const contextStart = Math.max(0, match.index - 200);
      const context = text.substring(contextStart, match.index + match[0].length + 50);

      const dateMatch = context.match(
        /((?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2})/,
      );
      const timeMatch = context.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
      const gtdMatch = context.match(/\$?([0-9,]+(?:K|M)?)\s*(?:GTD|Guaranteed)/i);
      const chipsMatch = context.match(/\b([1-9][0-9]{0,2},[0-9]{3})\b/);
      const levelsMatch =
        context.match(/(?:Levels?|Blinds?)\D*(\d{2,3})/i) ?? context.match(/(\d{2})\s*min/i);

      let guaranteed: number | null = null;
      if (gtdMatch?.[1]) {
        const g = (gtdMatch[1]).replace(/,/g, '');
        if (g.endsWith('K')) guaranteed = parseInt(g, 10) * 1_000;
        else if (g.endsWith('M')) guaranteed = parseInt(g, 10) * 1_000_000;
        else guaranteed = parseInt(g, 10);
      }

      let startingChips: number | null = null;
      if (chipsMatch?.[1]) {
        const c = parseInt(chipsMatch[1].replace(/,/g, ''), 10);
        if (c >= 5_000 && c <= 1_000_000) startingChips = c;
      }

      events.push({
        event_number: eventNum,
        event_name: eventName,
        buy_in: buyIn,
        date: dateMatch?.[1] ?? null,
        start_time: timeMatch?.[1] ?? null,
        guaranteed,
        starting_chips: startingChips,
        levels: levelsMatch?.[1] ? parseInt(levelsMatch[1], 10) : null,
        game_type: detectGameType(eventName),
        event_type: detectEventType(eventName),
        source: 'pdf_fallback_extraction',
      });
    }
  }

  return events;
}

// ─── MSPT link extractor ─────────────────────────────────────────────────────

export function extractMsptPdfLinks(
  html: string,
  baseUrl: string,
): Array<{ stopName: string; pdfUrl: string }> {
  const entries: Array<{ stopName: string; pdfUrl: string }> = [];
  if (!html) return entries;

  // ONE regex captures the href and its anchor text together. Two parallel
  // index-counted passes desynchronised the moment an anchor contained nested
  // markup, shifting every later stop name onto the wrong PDF.
  const linkPattern =
    /href=["']([^"']*showpdf\.aspx\?eventID=\d+[^"']*)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  const seen = new Set<string>();

  while ((match = linkPattern.exec(html)) !== null) {
    let url = match[1] ?? '';
    if (!url) continue;
    if (url.startsWith('/')) {
      try {
        const base = new URL(baseUrl);
        url = `${base.protocol}//${base.host}${url}`;
      } catch { continue; }
    } else if (!url.startsWith('http')) {
      url = `https://msptpoker.com${url.startsWith('/') ? '' : '/'}${url}`;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    index++;

    const stopName =
      (match[2] ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || `Stop ${index}`;

    entries.push({ stopName, pdfUrl: url });
  }

  return entries;
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function extractPdfSchedule(
  pdfUrl: string,
  options: { tourCode?: string; seriesName?: string } = {},
): Promise<PdfExtractResult> {
  const { tourCode = 'UNKNOWN', seriesName = '' } = options;

  console.debug(`  [PDF] Downloading: ${pdfUrl}`);

  try {
    const buffer = await downloadBinary(pdfUrl);

    if (buffer.length < 100) {
      return { events: [], pages: 0, rawTextLength: 0, error: 'PDF too small — likely an error page' };
    }

    const header = buffer.slice(0, 5).toString('ascii');
    if (!header.startsWith('%PDF')) {
      return { events: [], pages: 0, rawTextLength: 0, error: `Not a valid PDF (header: ${header})` };
    }

    console.debug(`  [PDF] Downloaded ${(buffer.length / 1024).toFixed(1)}KB — parsing...`);

    let rawText = '';
    let numPages = 0;

    try {
      // Dynamic import — pdf-parse is an optional peer dep; use any cast so
      // tsc doesn't error when the package has no @types declaration.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { PDFParse } = await import('pdf-parse' as any) as { PDFParse: new (opts: { url?: string; data?: Uint8Array }) => { getText(): Promise<{ text: string; pages?: unknown[]; numpages?: number }> } };
      // Feed the buffer we already downloaded (browser UA, 10MB cap, redirect
      // handling). Passing the URL made pdf-parse re-fetch with its default
      // client — sites that 403 non-browser UAs then fell to the crude fallback.
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      const result = await parser.getText();
      rawText = result.text ?? '';
      numPages = result.pages ? result.pages.length : (result.numpages ?? 1);
    } catch {
      console.debug(`  [PDF] pdf-parse not available, using latin1 fallback`);
      const rawStr = buffer.toString('latin1');
      const textBlocks = rawStr.match(/\(([^)]{2,200})\)/g) ?? [];
      rawText = textBlocks
        .map((b) => b.slice(1, -1))
        .filter((b) => /\w/.test(b))
        .join('\n');
      numPages = 1;
    }

    console.debug(`  [PDF] ${numPages} pages, ${rawText.length} chars of text`);

    if (rawText.length < 50) {
      return {
        events: [],
        pages: numPages,
        rawTextLength: rawText.length,
        error: 'PDF text extraction yielded no content (may be scanned/image-only PDF)',
      };
    }

    const events = parseScheduleText(rawText);
    events.forEach((ev) => {
      if (seriesName) ev.series_name = seriesName;
      if (tourCode) ev.tour_code = tourCode;
      ev.pdf_source_url = pdfUrl;
    });

    console.debug(`  [PDF] Extracted ${events.length} events from ${numPages} pages`);

    return { events, pages: numPages, raw_text: rawText, rawTextLength: rawText.length, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.debug(`  [PDF] Error: ${msg}`);
    return { events: [], pages: 0, rawTextLength: 0, error: msg };
  }
}
