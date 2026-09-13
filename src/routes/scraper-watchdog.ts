/**
 * GET/POST /cron/scraper-watchdog
 *
 * Ported from pages/api/cron/scraper-watchdog.js (2026-04-24).
 *
 * Every 2 hours (dispatcher schedule): check venue_live_tables freshness
 * for each source. Tiered alerting:
 *   Tier 2 STALE (>=45 min)  — Codex inbox, 1h cooldown
 *   Tier 3 DEAD  (>=60 min)  — Codex inbox, 30min cooldown
 *
 * Sources: pokeratlas only. Bravo removed permanently (2026-05-23).
 *   Tier 4 ANOMALY (count < 10 || > 5000 || 75%+ drop vs baseline) — same as DEAD
 *   HEALTHY — if previously alerting, record an ALL CLEAR recovery
 *
 * Volumetric baselines are learned per-hour via EWMA (10% new, 90% old).
 *
 * Idempotence: Supabase-persisted alert state (last_alert_ms, was_alerting)
 * gated by per-tier cooldown. STAGGERED on Hetzner secondary to close the
 * read/write race on the alert state row — see .memory/context/
 * phase-2a2-full-cron-audit.md for the full story.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { OperationalAlertDeliveryError, operationalEventKey, recordOperationalAlert } from '../lib/operationalAlerts.js';

const STALE_THRESHOLD_MIN = 45;
const DEAD_THRESHOLD_MIN = 60;
const TIER2_COOLDOWN_MS = 60 * 60 * 1000;
const TIER3_COOLDOWN_MS = 30 * 60 * 1000;

type SupabaseClient = ReturnType<typeof getSupabase>;

interface AlertState {
  last_alert_ms: number;
  was_alerting: boolean;
  last_severity?: string | null;
  last_message?: string | null;
}

interface Results {
  checked_at: string;
  sources: Record<string, {
    status: string;
    minutes_ago?: number | null;
    count?: number;
    error?: string;
  }>;
  alerts_sent: Array<Record<string, unknown>>;
  resolved: Array<Record<string, unknown>>;
}

async function getAlertState(supabase: SupabaseClient, source: string): Promise<AlertState> {
  const key = `${source}_last_alert`;
  try {
    const { data, error } = await supabase
      .from('scraper_watchdog_state')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data && (data as { value: string }).value) {
      return JSON.parse((data as { value: string }).value) as AlertState;
    }
  } catch (e) {
    throw new OperationalAlertDeliveryError(`cannot read retry state: ${e instanceof Error ? e.message : e}`);
  }
  return { last_alert_ms: 0, was_alerting: false };
}

async function setAlertState(supabase: SupabaseClient, source: string, state: AlertState): Promise<void> {
  const key = `${source}_last_alert`;
  try {
    const { error } = await supabase.from('scraper_watchdog_state').upsert(
      { key, value: JSON.stringify(state), updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
    if (error) throw new Error(error.message);
  } catch (e) {
    throw new OperationalAlertDeliveryError(`cannot save retry state: ${e instanceof Error ? e.message : e}`);
  }
}

async function appendAlertHistory(
  supabase: SupabaseClient,
  source: string,
  type: 'alert' | 'recovery',
  message: string,
): Promise<void> {
  const key = 'alert_history';
  try {
    let history: Array<{ id: string; timestamp: string; source: string; type: string; message: string }> = [];
    const { data } = await supabase
      .from('scraper_watchdog_state')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (data && (data as { value: string }).value) {
      history = JSON.parse((data as { value: string }).value);
    }
    history.unshift({
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      source,
      type,
      message,
    });
    history = history.slice(0, 50);
    await supabase.from('scraper_watchdog_state').upsert(
      { key, value: JSON.stringify(history), updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  } catch (e) {
    console.warn('[scraper-watchdog] appendAlertHistory failed:', e instanceof Error ? e.message : e);
  }
}

async function sendSmartAlert(
  supabase: SupabaseClient,
  source: string,
  message: string,
  severity: 'stale' | 'dead',
  now: Date,
  results: Results,
): Promise<void> {
  const nowMs = now.getTime();
  const alertState = await getAlertState(supabase, source);
  const cooldown = severity === 'dead' ? TIER3_COOLDOWN_MS : TIER2_COOLDOWN_MS;

  if (alertState.was_alerting && nowMs - (alertState.last_alert_ms || 0) < cooldown) {
    const nextIn = Math.round((cooldown - (nowMs - alertState.last_alert_ms)) / 60000);
    results.alerts_sent.push({ source, message, skipped: `cooldown (${nextIn}min remaining)` });
    return;
  }

  const fullMessage = `SCRAPER ALERT\n${source.toUpperCase()}: ${message}\nCheck: smarter.poker/api/poker/scraper-health`;

  const receipt = await recordOperationalAlert({
    source: 'workers.scraper-watchdog',
    eventKey: operationalEventKey(source, 'firing', severity, alertState.last_alert_ms || 0),
    alertname: severity === 'dead' ? 'ScraperDead' : 'ScraperStale',
    status: 'firing',
    severity: severity === 'dead' ? 'critical' : 'warning',
    payload: { source, summary: message, message: fullMessage, checkedAt: now.toISOString() },
  });
  results.alerts_sent.push({ source, type: 'operational_inbox', severity, sent: true, receipt });

  await setAlertState(supabase, source, {
    last_alert_ms: nowMs,
    was_alerting: true,
    last_severity: severity,
    last_message: message,
  });
  await appendAlertHistory(supabase, source, 'alert', fullMessage);
}

async function sendRecoveryAlert(
  supabase: SupabaseClient,
  source: string,
  minutesAgo: number,
  results: Results,
): Promise<void> {
  const message = `ALL CLEAR\n${source.toUpperCase()} scraper recovered! Data is now ${minutesAgo} min fresh.`;
  const alertState = await getAlertState(supabase, source);
  const receipt = await recordOperationalAlert({
    source: 'workers.scraper-watchdog',
    eventKey: operationalEventKey(source, 'resolved', alertState.last_alert_ms || 0),
    alertname: alertState.last_severity === 'dead' ? 'ScraperDead' : 'ScraperStale',
    status: 'resolved',
    severity: 'info',
    payload: { source, summary: message },
  });
  results.resolved.push({ source, type: 'operational_inbox', sent: true, receipt });
  await setAlertState(supabase, source, {
    // Retain the previous occurrence identity so a new incident does not
    // collide with the first firing after every recovery.
    last_alert_ms: alertState.last_alert_ms,
    was_alerting: false,
    last_severity: null,
    last_message: null,
  });
  await appendAlertHistory(supabase, source, 'recovery', message);
}

export async function scraperWatchdog(c: Context) {
  const now = new Date();
  const supabase = getSupabase();
  const results: Results = {
    checked_at: now.toISOString(),
    sources: {},
    alerts_sent: [],
    resolved: [],
  };

  let deliveryFailed = false;
  for (const source of ['pokeratlas']) {
    try {
      const { data, count, error } = await supabase
        .from('venue_live_tables')
        .select('scrape_timestamp', { count: 'exact' })
        .eq('source', source)
        .order('scrape_timestamp', { ascending: false })
        .limit(1);

      if (error) {
        results.sources[source] = { status: 'ERROR', minutes_ago: null };
        await sendSmartAlert(supabase, source, `DATABASE ERROR — ${error.message}`, 'dead', now, results);
        continue;
      }

      const rows = (data ?? []) as Array<{ scrape_timestamp: string }>;
      const firstRow = rows[0];
      const lastScrape = firstRow ? new Date(firstRow.scrape_timestamp) : new Date(0);
      const minutesAgo = firstRow ? Math.round((now.getTime() - lastScrape.getTime()) / 60000) : 999;
      const safeCount = count ?? 0;
      results.sources[source] = { status: 'ok', minutes_ago: minutesAgo, count: safeCount };

      // Volumetric baseline (EWMA per hour)
      const currentHour = now.getHours().toString();
      const baseKey = `baseline_${source}`;
      let baselines: Record<string, number> = {};
      try {
        const { data: bData } = await supabase
          .from('scraper_watchdog_state')
          .select('value')
          .eq('key', baseKey)
          .maybeSingle();
        if (bData && (bData as { value: string | Record<string, number> }).value) {
          const v = (bData as { value: string | Record<string, number> }).value;
          baselines = typeof v === 'string' ? JSON.parse(v) : v;
        }
      } catch (e) {
        console.warn('[scraper-watchdog] baseline parse error:', e instanceof Error ? e.message : e);
      }

      const previousBaseline = baselines[currentHour] ?? null;
      baselines[currentHour] = previousBaseline
        ? Math.round(safeCount * 0.1 + previousBaseline * 0.9)
        : safeCount;

      await supabase
        .from('scraper_watchdog_state')
        .upsert(
          { key: baseKey, value: JSON.stringify(baselines), updated_at: now.toISOString() },
          { onConflict: 'key' },
        );

      const relativeDrop =
        previousBaseline !== null &&
        previousBaseline > 50 &&
        (safeCount === 0 || safeCount < previousBaseline * 0.25);

      if (safeCount < 10 || safeCount > 5000 || relativeDrop) {
        results.sources[source].status = 'ANOMALY';
        const msg = relativeDrop
          ? `ANOMALY — 75%+ volumetric drop compared to ${currentHour}:00 baseline (${safeCount} vs ${previousBaseline})`
          : `ANOMALY — Table count breached safety limits: ${safeCount} total tables returned`;
        await sendSmartAlert(supabase, source, msg, 'dead', now, results);
      } else if (minutesAgo >= DEAD_THRESHOLD_MIN) {
        results.sources[source].status = 'DEAD';
        await sendSmartAlert(supabase, source, `DEAD — no data for ${minutesAgo} minutes`, 'dead', now, results);
      } else if (minutesAgo >= STALE_THRESHOLD_MIN) {
        results.sources[source].status = 'STALE';
        await sendSmartAlert(supabase, source, `STALE — data is ${minutesAgo} minutes old`, 'stale', now, results);
      } else {
        const alertState = await getAlertState(supabase, source);
        if (alertState.was_alerting) {
          await sendRecoveryAlert(supabase, source, minutesAgo, results);
        }
      }
    } catch (err) {
      if (err instanceof OperationalAlertDeliveryError) deliveryFailed = true;
      results.sources[source] = {
        status: 'ERROR',
        error: err instanceof Error ? err.message : String(err),
      };
      console.warn(`[scraper-watchdog] error for ${source}:`, err instanceof Error ? err.message : err);
    }
  }

  return c.json(results, deliveryFailed ? 503 : 200);
}
