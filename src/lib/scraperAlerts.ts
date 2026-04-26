/**
 * Scraper Alert System
 * ═══════════════════════════════════════════════════════════
 * Ported from World Hub src/lib/scraperAlerts.js (249 LOC).
 * Sends SMS alerts to the owner when automated scrapers encounter
 * errors, zero results, or critical failures.
 *
 * Alert recipient: +1-708-677-5221 (owner)
 * SMS provider: Twilio (uses existing TWILIO_* env vars)
 *
 * In the workers repo, the in-memory throttle Map persists across
 * invocations (improved behaviour vs. Vercel cold-start resets).
 */

// OWNER ALERT NUMBER — receives all scraper failure notifications
const OWNER_PHONE = '+17086775221';

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

// ─── Twilio REST (no twilio npm — uses fetch) ────────────────────────────────
async function sendSmsAlert(message: string): Promise<{ sent: boolean; reason?: string; sid?: string }> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromPhone) {
    console.warn('[ALERT] Twilio not configured — SMS alert not sent');
    console.warn('[ALERT] Message was:', message);
    return { sent: false, reason: 'Twilio credentials not configured' };
  }

  try {
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const body = new URLSearchParams({ From: fromPhone, To: OWNER_PHONE, Body: message });

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      },
    );

    const result = (await response.json()) as { sid?: string; message?: string };

    if (result.sid) {
      console.debug(`[ALERT] SMS sent to ${OWNER_PHONE} — SID: ${result.sid}`);
      return { sent: true, sid: result.sid };
    }
    console.warn('[ALERT] SMS send failed:', result.message);
    return { sent: false, reason: result.message };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[ALERT] SMS error:', msg);
    return { sent: false, reason: msg };
  }
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

  return msg.substring(0, 320); // keep under 2 SMS segments
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function alertScraperCritical(
  scraperName: string,
  reason: string,
  stats: ScraperStats = {},
): Promise<{ sent: boolean; reason?: string }> {
  const key = `critical:${scraperName}`;
  if (isThrottled(key)) {
    console.debug(`[ALERT] Critical alert throttled for ${scraperName}`);
    return { sent: false, reason: 'throttled' };
  }
  const message = formatAlert('CRITICAL', scraperName, reason, stats);
  const result = await sendSmsAlert(message);
  if (result.sent) markSent(key);
  return result;
}

export async function alertScraperWarning(
  scraperName: string,
  reason: string,
  stats: ScraperStats = {},
): Promise<{ sent: boolean; reason?: string }> {
  const key = `warning:${scraperName}`;
  if (isThrottled(key)) {
    console.debug(`[ALERT] Warning alert throttled for ${scraperName}`);
    return { sent: false, reason: 'throttled' };
  }
  const message = formatAlert('WARNING', scraperName, reason, stats);
  const result = await sendSmsAlert(message);
  if (result.sent) markSent(key);
  return result;
}

export async function alertScraperInfo(
  scraperName: string,
  reason: string,
  stats: ScraperStats = {},
): Promise<{ sent: boolean; reason?: string }> {
  const key = `info:${scraperName}`;
  const last = alertThrottle.get(key);
  const infoThrottle = 12 * 60 * 60 * 1000;
  if (last && Date.now() - last < infoThrottle) {
    return { sent: false, reason: 'throttled' };
  }
  const message = formatAlert('INFO', scraperName, reason, stats);
  const result = await sendSmsAlert(message);
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
