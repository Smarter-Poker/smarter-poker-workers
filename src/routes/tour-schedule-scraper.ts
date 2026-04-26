/**
 * GET /cron/tour-schedule-scraper
 *
 * Ported from pages/api/cron/tour-schedule-scraper.js (733 LOC).
 *
 * Key changes from monolith:
 *  - loadJson(REGISTRY_PATH) / saveJson() replaced with Supabase upsert
 *    on tour_source_registry + tour_scrape_sources tables
 *  - fetchWithRetry rewritten using fetch() + AbortController
 *  - scraperAlerts / tourPdfExtractor / tourHtmlExtractor from workers libs
 *  - CRON_SECRET bearer auth (same as monolith)
 */

import type { Context } from 'hono';
import { createClient } from '@supabase/supabase-js';
import {
  extractPdfSchedule,
  isPdfUrl,
  findPdfLinks,
  extractMsptPdfLinks,
  type PdfEvent,
} from '../lib/tourPdfExtractor.js';
import { fetchAndExtract, fetchHtml } from '../lib/tourHtmlExtractor.js';
import { evaluateAndAlert, alertScraperCritical, type ScraperStats } from '../lib/scraperAlerts.js';

// ─── Config ───────────────────────────────────────────────────────────────────
const RATE_LIMIT_MS = 5_000;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REGRESSION_LOSS = 0.30;
const CURRENT_YEAR = new Date().getFullYear();

// ─── Supabase ────────────────────────────────────────────────────────────────
function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  return createClient(url, key);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Supabase registry helpers ────────────────────────────────────────────────
interface RegistryRow { tour_name: string; registry_data: Record<string, unknown> }
interface SourcesRow { tour_name: string; sources_config: Record<string, unknown>; is_active: boolean }

async function loadRegistry(): Promise<Record<string, Record<string, unknown>> | null> {
  const sb = getSupabase();
  const { data, error } = await sb.from('tour_schedule_registry').select('tour_name, registry_data');
  if (error) { console.warn('[SCRAPER] Failed to load registry:', error.message); return null; }
  const out: Record<string, Record<string, unknown>> = {};
  for (const row of (data ?? []) as RegistryRow[]) out[row.tour_name] = row.registry_data;
  return out;
}

async function saveRegistryEntry(tourName: string, data: Record<string, unknown>): Promise<void> {
  const sb = getSupabase();
  await sb.from('tour_schedule_registry').upsert(
    { tour_name: tourName, registry_data: data, last_modified: new Date().toISOString() },
    { onConflict: 'tour_name' },
  );
}

async function loadSources(): Promise<Record<string, unknown> | null> {
  const sb = getSupabase();
  const { data, error } = await sb.from('tour_schedule_sources').select('tour_name, sources_config').eq('is_active', true);
  if (error) { console.warn('[SCRAPER] Failed to load sources:', error.message); return null; }
  const out: Record<string, Record<string, unknown>> = {};
  for (const row of (data ?? []) as SourcesRow[]) out[row.tour_name] = row.sources_config;
  return { tours: out };
}

// ─── HTTP fetch with retry ────────────────────────────────────────────────────
async function fetchWithRetry(url: string, retries = MAX_RETRIES, attempt = 0): Promise<string> {
  const backoff = Math.pow(2, attempt) * 1_000;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (attempt < retries) { await sleep(backoff); return fetchWithRetry(url, retries, attempt + 1); }
    throw err;
  }
}

// ─── Verification layers ──────────────────────────────────────────────────────
function verifyResponse(html: string): { pass: boolean; reason?: string } {
  if (!html || html.length < 100) return { pass: false, reason: 'Empty/short response' };
  if (html.includes('Access Denied') || html.includes('403 Forbidden')) return { pass: false, reason: 'Access denied' };
  if (html.includes('captcha') || html.includes('CAPTCHA')) return { pass: false, reason: 'CAPTCHA detected' };
  return { pass: true };
}

function verifyPokerContent(html: string): { pass: boolean } {
  const keywords = ['poker', 'tournament', 'buy-in', 'buyin', 'hold', 'omaha', 'event', 'schedule'];
  const text = html.toLowerCase();
  return { pass: keywords.filter(k => text.includes(k)).length >= 2 };
}

function verifyNoRegression(tourCode: string, newEvents: unknown[], registry: Record<string, Record<string, unknown>>): { pass: boolean; reason: string } {
  const existing = registry[tourCode];
  if (!existing) return { pass: true, reason: 'New tour' };
  const existingCount = ((existing['stops_2026'] as unknown[] | undefined)?.length ?? 0) + ((existing['series_2026'] as unknown[] | undefined)?.length ?? 0);
  if (existingCount === 0) return { pass: true, reason: 'No existing events' };
  if (newEvents.length < existingCount * (1 - MAX_REGRESSION_LOSS)) {
    return { pass: false, reason: `Regression: new=${newEvents.length} vs existing=${existingCount}` };
  }
  return { pass: true, reason: 'OK' };
}

// ─── Stats shape ──────────────────────────────────────────────────────────────
interface TourScraperStats extends ScraperStats {
  scraper: string;
  startedAt: string;
  finishedAt?: string;
  duration_ms?: number;
  tours_scraped: number;
  tours_updated: number;
  tours_skipped: number;
  total_events: number;
  pdf_events_found: number;
  pdf_events_stored: number;
  errors: Array<{ tour?: string; source?: string; url?: string; error: string }>;
  skipped: Array<{ tour: string; reason: string }>;
  failures: Array<{ tour: string; error: string }>;
  verification_failures: Array<{ tour: string; source: string; layer: number; reason: string }>;
  results: Record<string, unknown>;
  pdf_results: Record<string, unknown>;
  registry_saved?: boolean;
}

// ─── PDF scraping ─────────────────────────────────────────────────────────────
async function scrapeTourPdfs(tourCode: string, sources: Record<string, unknown>, stats: TourScraperStats): Promise<PdfEvent[]> {
  const toursConfig = (sources['tours'] as Record<string, unknown> | undefined)?.[tourCode] as Record<string, unknown> | undefined;
  if (!toursConfig) return [];
  const allPdfEvents: PdfEvent[] = [];
  for (const [sourceName, rawCfg] of Object.entries(toursConfig['sources'] as Record<string, unknown> ?? {})) {
    const sourceConfig = rawCfg as Record<string, unknown>;
    const method = String(sourceConfig['method'] ?? '');
    const url = String(sourceConfig['url'] ?? '');
    if (method === 'pdf_direct' || isPdfUrl(url)) {
      try {
        const result = await extractPdfSchedule(url, { tourCode, seriesName: String(toursConfig['tour_name'] ?? '') });
        if (result.events.length > 0) { allPdfEvents.push(...result.events); stats.pdf_events_found = (stats.pdf_events_found ?? 0) + result.events.length; }
      } catch (err) { console.warn(`  [PDF:${tourCode}] Error: ${err instanceof Error ? err.message : String(err)}`); }
      await sleep(RATE_LIMIT_MS);
    }
    if (method === 'pdf_crawl') {
      try {
        const html = await fetchWithRetry(url);
        const pdfEntries = tourCode === 'MSPT' ? extractMsptPdfLinks(html, url) : findPdfLinks(html, url).map((u, i) => ({ stopName: `Stop ${i + 1}`, pdfUrl: u }));
        for (const { stopName, pdfUrl } of pdfEntries.slice(0, 20)) {
          const result = await extractPdfSchedule(pdfUrl, { tourCode, seriesName: `${toursConfig['tour_name'] ?? ''} - ${stopName}` });
          if (result.events.length > 0) { allPdfEvents.push(...result.events); stats.pdf_events_found = (stats.pdf_events_found ?? 0) + result.events.length; }
          await sleep(RATE_LIMIT_MS);
        }
      } catch (err) {
        stats.errors.push({ tour: tourCode, source: sourceName, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return allPdfEvents;
}

// ─── Store PDF events ─────────────────────────────────────────────────────────
function parseDateToISO(dateStr: string | undefined | null): string | null {
  if (!dateStr) return null;
  try {
    const d = new Date(`${dateStr} ${CURRENT_YEAR}`);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0] ?? null;
    const d2 = new Date(dateStr);
    if (!isNaN(d2.getTime())) return d2.toISOString().split('T')[0] ?? null;
  } catch { /* ignore */ }
  return null;
}

async function storePdfEvents(tourCode: string, pdfEvents: PdfEvent[]): Promise<{ inserted: number; errors: number }> {
  const sb = getSupabase();
  let inserted = 0; let errors = 0;
  for (const ev of pdfEvents) {
    const { error } = await sb.from('tour_event_details').upsert({
      tour_code: tourCode, series_name: ev.series_name ?? null, event_number: ev.event_number ?? null,
      event_name: ev.event_name || 'Unknown Event', buy_in: ev.buy_in ?? null, guaranteed: ev.guaranteed ?? null,
      start_date: parseDateToISO(ev.date),
      start_time: ev.start_time ?? null, starting_chips: ev.starting_chips ?? null, levels: ev.levels ?? null,
      game_type: ev.game_type || 'NLH', event_type: ev.event_type || 'side_event',
      pdf_source_url: ev.pdf_source_url ?? null, source: ev.source || 'pdf_extraction',
      scraped_at: new Date().toISOString(),
    }, { onConflict: 'tour_code,event_name,buy_in', ignoreDuplicates: false });
    if (error && !error.message?.includes('duplicate') && !error.message?.includes('does not exist')) { errors++; }
    else if (!error) { inserted++; }
  }
  return { inserted, errors };
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export async function tourScheduleScraperHandler(c: Context): Promise<Response> {
  const scraperName = 'tour-schedule-scraper';
  try {
    // Auth
    const authHeader = c.req.header('authorization');
    if (process.env.NODE_ENV === 'production' && process.env.CRON_SECRET) {
      if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) return c.json({ error: 'Unauthorized' }, 401);
    }

    const specificTour = c.req.query('tour');
    const pdfOnly = c.req.query('pdf_only') === 'true';

    const stats: TourScraperStats = {
      success: true, scraper: scraperName, startedAt: new Date().toISOString(),
      tours_scraped: 0, tours_updated: 0, tours_skipped: 0, total_events: 0,
      pdf_events_found: 0, pdf_events_stored: 0,
      errors: [], skipped: [], failures: [], verification_failures: [],
      results: {}, pdf_results: {},
    };

    const [sources, registry] = await Promise.all([loadSources(), loadRegistry()]);
    if (!sources || !registry) {
      const errMsg = 'Could not load tour_scrape_sources or tour_source_registry from Supabase';
      await alertScraperCritical(scraperName, errMsg, stats);
      return c.json({ success: false, error: errMsg }, 500);
    }

    let tourCodes = Object.keys((sources['tours'] as Record<string, unknown>) ?? {});
    if (specificTour) tourCodes = tourCodes.filter(c => c === specificTour.toUpperCase());
    const toursConfig = sources['tours'] as Record<string, Record<string, unknown>>;
    tourCodes.sort((a, b) => ((toursConfig[a]?.['scrape_priority'] as number | undefined) ?? 99) - ((toursConfig[b]?.['scrape_priority'] as number | undefined) ?? 99));

    console.warn(`[TOUR SCRAPER] v2.0 — ${scraperName}, tours: ${tourCodes.join(', ')}`);

    for (const tourCode of tourCodes) {
      const regEntry = registry[tourCode] as Record<string, unknown> | undefined;
      if (regEntry?.['is_active'] === false) { stats.skipped.push({ tour: tourCode, reason: 'Inactive' }); stats.tours_skipped++; continue; }

      try {
        // HTML scraping
        if (!pdfOnly) {
          const tourSources = toursConfig[tourCode];
          if (tourSources) {
            const sourceEntries = Object.entries(tourSources['sources'] as Record<string, unknown> ?? {})
              .filter(([, cfg]) => !String((cfg as Record<string, unknown>)['method'] ?? '').startsWith('pdf'));
            let bestResult: { events_found: number; source: string; verification: Record<string, unknown> } | null = null;
            for (const [sourceName, rawCfg] of sourceEntries) {
              const cfg = rawCfg as Record<string, unknown>;
              const url = String(cfg['url'] ?? '');
              if (!url) continue;
              try {
                let extractedEvents: unknown[] = [];
                let html = '';
                const method = String(cfg['method'] ?? '');
                if (method === 'html_extract' || method === 'scrapling') {
                  const result = await fetchAndExtract(url, tourCode, sourceName, { xaiApiKey: process.env.XAI_API_KEY, minExpected: 5 });
                  extractedEvents = result.events;
                  try { html = await fetchHtml(url); } catch { html = ''; }
                } else {
                  html = await fetchWithRetry(url);
                  extractedEvents = [];
                }
                const l1 = verifyResponse(html || 'poker tournament');
                if (!l1.pass && extractedEvents.length === 0) { stats.verification_failures.push({ tour: tourCode, source: sourceName, layer: 1, reason: l1.reason ?? '' }); await sleep(RATE_LIMIT_MS); continue; }
                const l2 = html ? verifyPokerContent(html) : { pass: extractedEvents.length > 0 };
                const l5 = verifyNoRegression(tourCode, extractedEvents, registry);
                const v = { l1_response: l1.pass, l2_content: l2.pass, l5_regression: l5.pass, l5_reason: l5.reason };

                if (extractedEvents.length > 0 && l5.pass) {
                  bestResult = { events_found: extractedEvents.length, source: sourceName, verification: v };
                  await saveRegistryEntry(tourCode, { ...(regEntry ?? {}), last_scraped: new Date().toISOString(), last_scrape_source: sourceName, last_scrape_events: extractedEvents.length });
                  stats.tours_updated++;
                  stats.total_events += extractedEvents.length;
                  break;
                }
                if (!bestResult || extractedEvents.length > (bestResult.events_found)) bestResult = { events_found: extractedEvents.length, source: sourceName, verification: v };
              } catch (err) { stats.errors.push({ tour: tourCode, source: sourceName, url, error: err instanceof Error ? err.message : String(err) }); }
              await sleep(RATE_LIMIT_MS);
            }
            stats.tours_scraped++;
            stats.results[tourCode] = bestResult ?? { source: 'none', events_found: 0 };
          }
        }

        // PDF scraping
        const pdfEvents = await scrapeTourPdfs(tourCode, sources, stats);
        if (pdfEvents.length > 0) {
          stats.pdf_results[tourCode] = { events_found: pdfEvents.length };
          const stored = await storePdfEvents(tourCode, pdfEvents);
          stats.pdf_events_stored += stored.inserted;
          await saveRegistryEntry(tourCode, { ...(regEntry ?? {}), last_pdf_scan: new Date().toISOString(), last_pdf_events: pdfEvents.length });
          if (pdfOnly) stats.tours_updated++;
        }
      } catch (err) { stats.errors.push({ tour: tourCode, error: err instanceof Error ? err.message : String(err) }); }

      if (tourCodes.indexOf(tourCode) < tourCodes.length - 1) await sleep(RATE_LIMIT_MS);
    }

    stats.finishedAt = new Date().toISOString();
    stats.duration_ms = new Date(stats.finishedAt).getTime() - new Date(stats.startedAt).getTime();
    stats.success = stats.errors.length === 0 || stats.tours_updated > 0;

    // Audit log
    await getSupabase().from('scraper_runs').insert({
      scraper_name: scraperName, started_at: stats.startedAt, finished_at: stats.finishedAt,
      tours_scraped: stats.tours_scraped, tours_updated: stats.tours_updated, total_events: stats.total_events,
      pdf_events_found: stats.pdf_events_found, errors_count: stats.errors.length,
      status: stats.success ? 'success' : 'partial', details: JSON.stringify(stats),
    });

    await evaluateAndAlert(scraperName, stats).catch(() => { /* non-fatal */ });

    console.warn(`[TOUR SCRAPER] COMPLETE — ${Math.round((stats.duration_ms ?? 0) / 1000)}s, ${stats.tours_updated}/${stats.tours_scraped} updated, ${stats.total_events} events, ${stats.pdf_events_found} PDF events`);
    return c.json(stats);
  } catch (err) {
    console.warn('[Tour Schedule Scraper FATAL]', err);
    await alertScraperCritical(scraperName, `Unhandled crash: ${err instanceof Error ? err.message : String(err)}`, {}).catch(() => { /* ignore */ });
    return c.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, 500);
  }
}
