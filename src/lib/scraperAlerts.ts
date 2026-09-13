/** Scraper incidents are persisted for Codex; no owner SMS is sent. */
import { operationalEventKey, recordOperationalAlert } from './operationalAlerts.js';

// Alert throttle: don't send same alert type more than once per 6 hours
const alertThrottle = new Map<string, number>();
const THROTTLE_MS = 6 * 60 * 60 * 1000; // 6 hours

function isThrottled(key: string): boolean {
  const last = alertThrottle.get(key);
  if (!last) return false;
  return (Date.now() - last) < THROTTLE_MS;
}

function markSent(key: string): void {
  alertThrottle.set(key, Date.now());
}

// ─── Stats shape (mirrors monolith) ──────────────────────────────────────────
export interface ScraperStats {
  tours_scraped?: number;
  tours_updated?: number;
  tours_skipped?: number;
  total_events?: number;
  pdf_events_found?: number;
  errors?: Array<{ tour?: string; scraper?: string; [k: string]: unknown }>;
  failures?: unknown[];
  [k: string]: unknown;
}

async function recordScraperAlert(
  level: 'critical' | 'warning' | 'info', scraperName: string, reason: string, stats: ScraperStats,
): Promise<{ sent: boolean; reason?: string }> {
  // Use the producing run when supplied. For callers without a run identity,
  // a time window deduplicates concurrent/replayed notifications across boots.
  const windowMs = level === 'info' ? 12 * 60 * 60 * 1000 : THROTTLE_MS;
  const occurrence = typeof stats.startedAt === 'string'
    ? stats.startedAt : Math.floor(Date.now() / windowMs);
  await recordOperationalAlert({
    source: 'workers.scraper',
    eventKey: operationalEventKey(scraperName, level, reason, occurrence),
    alertname: `Scraper${level === 'critical' ? 'Critical' : level === 'warning' ? 'Warning' : 'Info'}`,
    status: 'firing',
    severity: level,
    payload: { scraper: scraperName, summary: reason, message: formatAlert(level.toUpperCase() as 'CRITICAL' | 'WARNING' | 'INFO', scraperName, reason, stats), stats },
  });
  // Preserve the existing response shape: "sent" acknowledges inbox delivery.
  return { sent: true, reason: 'recorded_in_operational_inbox' };
}

// ─── Format ──────────────────────────────────────────────────────────────────
function formatAlert(level: 'CRITICAL' | 'WARNING' | 'INFO', scraperName: string, reason: string, stats: ScraperStats = {}): string {
  const ts = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const emoji = level === 'CRITICAL' ? '🚨' : level === 'WARNING' ? '⚠️' : '✅';
  let msg = `${emoji} Smarter.Poker Scraper ${level}\n`;
  msg += `[${scraperName}] ${ts} CT\n`;
  msg += reason;

  if (stats.tours_scraped !== undefined) {
    msg += `\nTours: ${stats.tours_updated ?? 0}/${stats.tours_scraped ?? 0} updated`;
  }
  if (stats.total_events !== undefined) {
    msg += `, Events: ${stats.total_events ?? 0}`;
  }
  if (stats.errors?.length) {
    const errSummary = stats.errors
      .slice(0, 2)
      .map((e) => e.tour ?? e.scraper ?? 'unknown')
      .join(', ');
    msg += `\nErrors: ${errSummary}${stats.errors.length > 2 ? '...' : ''}`;
  }

  return msg; // The incident inbox preserves the complete diagnostic message.
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function alertScraperCritical(
  scraperName: string,
  reason: string,
  stats: ScraperStats = {},
): Promise<{ sent: boolean; reason?: string }> {
  const key = operationalEventKey('critical', scraperName, reason);
  if (isThrottled(key)) {
    console.debug(`[ALERT] Critical alert throttled for ${scraperName}`);
    return { sent: false, reason: 'throttled' };
  }
  const result = await recordScraperAlert('critical', scraperName, reason, stats);
  if (result.sent) markSent(key);
  return result;
}

export async function alertScraperWarning(
  scraperName: string,
  reason: string,
  stats: ScraperStats = {},
): Promise<{ sent: boolean; reason?: string }> {
  const key = operationalEventKey('warning', scraperName, reason);
  if (isThrottled(key)) {
    console.debug(`[ALERT] Warning alert throttled for ${scraperName}`);
    return { sent: false, reason: 'throttled' };
  }
  const result = await recordScraperAlert('warning', scraperName, reason, stats);
  if (result.sent) markSent(key);
  return result;
}

export async function alertScraperInfo(
  scraperName: string,
  reason: string,
  stats: ScraperStats = {},
): Promise<{ sent: boolean; reason?: string }> {
  const key = operationalEventKey('info', scraperName, reason);
  const last = alertThrottle.get(key);
  const infoThrottle = 12 * 60 * 60 * 1000;
  if (last && Date.now() - last < infoThrottle) {
    return { sent: false, reason: 'throttled' };
  }
  const result = await recordScraperAlert('info', scraperName, reason, stats);
  if (result.sent) markSent(key);
  return result;
}

export async function evaluateAndAlert(
  scraperName: string,
  stats: ScraperStats,
): Promise<{ sent: boolean; reason?: string }> {
  const {
    tours_scraped = 0,
    tours_updated = 0,
    tours_skipped = 0,
    total_events = 0,
    errors = [],
    pdf_events_found = 0,
  } = stats;

  const totalAttempted = tours_scraped;
  const errorRate = totalAttempted > 0 ? errors.length / totalAttempted : 0;

  if (totalAttempted > 0 && tours_updated === 0 && errors.length > 0) {
    return alertScraperCritical(
      scraperName,
      `0 tours updated. ${errors.length} error(s). May be blocked or down.`,
      stats,
    );
  }

  if (totalAttempted === 0 && tours_skipped === 0) {
    return alertScraperCritical(
      scraperName,
      'Scraper produced no output — possible config error.',
      stats,
    );
  }

  if (errorRate > 0.5) {
    return alertScraperWarning(
      scraperName,
      `High error rate: ${errors.length}/${totalAttempted} tours failed.`,
      stats,
    );
  }

  if (total_events < 5 && tours_updated > 0) {
    return alertScraperWarning(
      scraperName,
      `Only ${total_events} events found across ${tours_updated} tours — schedule data may be stale.`,
      stats,
    );
  }

  if (pdf_events_found > 20) {
    return alertScraperInfo(
      scraperName,
      `PDF extraction: ${pdf_events_found} detailed events captured from ${tours_updated} tours.`,
      stats,
    );
  }

  console.debug(`[ALERT] Scraper ${scraperName} ran cleanly — no alerts needed`);
  return { sent: false, reason: 'no_alert_needed' };
}
