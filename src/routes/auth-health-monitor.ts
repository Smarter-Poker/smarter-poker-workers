/**
 * GET/POST /cron/auth-health-monitor
 *
 * Production monitoring for the auth verification path — the gap left behind
 * by the ES256 outage.
 *
 * WHY THIS EXISTS
 * ────────────────
 * The World Hub JWT verifier stayed hardcoded to HS256 after the Supabase
 * project migrated to ES256 signing keys. Local verification failed on every
 * authenticated request, each one silently fell through to a live GoTrue
 * `/auth/v1/user` call (~20M edge requests/24h), and that eventually saturated
 * the project-wide auth rate limit and cascaded into a site-wide logout loop.
 * It ran for MONTHS with nobody noticing, because a fallback that works is
 * indistinguishable from a fast path that works — until it isn't.
 *
 * Regression tests exist now (World-Hub #1196/#1198/#1210/#1220, commander
 * #77/#78) but every one of them is build-time. None of them observe
 * production, and the three most likely ways this breaks again — Supabase
 * rotating signing keys, an env var changing on a deployed host, a stale
 * bundle served from cache — all happen at runtime with CI green.
 *
 * WHAT IT CHECKS (priority order)
 *   1. gotrue_fallback_ratio      GoTrue /user volume vs all auth traffic
 *   2. signature_algorithm_errors HS256 / "token signature is invalid"
 *   3. jwks_algorithm_drift       is the project still publishing ES256?
 *   4. refresh_token_failures     refresh-token race resurgence
 *   5. credential_stuffing        "Possible abuse attempt" spikes, by IP
 *   +  jwks_import_canary         real key material, real crypto.subtle import
 *
 * CREDENTIALS
 * Checks 3 and the canary need nothing but `fetch` and always run. Checks 1,
 * 2, 4 and 5 read Supabase `auth_logs`, which is NOT reachable through the
 * PostgREST service-role client this repo already has — log data lives in the
 * analytics backend behind the Management API. They are therefore GATED on
 * SUPABASE_MANAGEMENT_API_TOKEN and report status 'skipped' when it is absent,
 * so the monitor degrades instead of crashing. See the PR body for how to mint
 * that token.
 *
 * OUTPUT
 *   - cron_health_log upsert on cron_name='auth-health-monitor' (same surface
 *     as solver-watchdog — no new infra, no new dependency)
 *   - console.error with the greppable prefix `[auth-health-monitor] AUTH-ALERT`
 *   - SMS to the owner via the repo's existing alert channel on 'critical'
 *
 * Auth: /cron/* middleware chain (IP allowlist + Bearer CRON_SECRET).
 * Suggested schedule: every 15 minutes in Open Claw.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { alertScraperCritical } from '../lib/scraperAlerts.js';
import {
  thresholdsFromEnv,
  evaluateGoTrueFallback,
  evaluateSignatureErrors,
  evaluateRefreshFailures,
  evaluateCredentialStuffing,
  evaluateJwks,
  canaryImportJwks,
  summarizeChecks,
  toCronHealthStatus,
  type AuthLogWindow,
  type CheckResult,
  type JwksDocument,
} from '../lib/authHealth.js';

const JOB = 'auth-health-monitor';
const FETCH_TIMEOUT_MS = 10_000;

/** Default look-back. Long enough to be statistically meaningful, short enough
 *  that a fresh regression surfaces within one dispatch. */
const DEFAULT_WINDOW_MINUTES = 60;

// ─── Config ─────────────────────────────────────────────────────────────

function supabaseUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  return raw ? raw.replace(/\/+$/, '') : null;
}

/** Project ref, derived from the URL unless pinned explicitly. Never a secret. */
function projectRef(): string | null {
  if (process.env.SUPABASE_PROJECT_REF) return process.env.SUPABASE_PROJECT_REF;
  const url = supabaseUrl();
  const m = url?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co$/i);
  return m ? m[1] : null;
}

function jwksUrl(): string | null {
  if (process.env.AUTH_MONITOR_JWKS_URL) return process.env.AUTH_MONITOR_JWKS_URL;
  const url = supabaseUrl();
  return url ? `${url}/auth/v1/.well-known/jwks.json` : null;
}

// ─── auth_logs via the Management API analytics endpoint ────────────────────
//
// The service-role Supabase client in src/lib/supabase.ts speaks PostgREST and
// can only see tables in the database. `auth_logs` is a log stream, not a
// table, so it is unreachable that way — hence the raw Management API call
// below rather than a getSupabase() query. The SQL dialect is the one this
// project's analytics backend accepts today (unified `logs` stream, filtered
// by `source`, nested fields via `log_attributes['key']`); both statements
// below were executed against the live project before being committed.

interface LogsResponse {
  result?: Array<Record<string, unknown>>;
  error?: unknown;
}

async function runLogsQuery(
  ref: string,
  token: string,
  sql: string,
  startIso: string,
  endIso: string,
): Promise<Array<Record<string, unknown>>> {
  const url =
    `https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs.all` +
    `?iso_timestamp_start=${encodeURIComponent(startIso)}` +
    `&iso_timestamp_end=${encodeURIComponent(endIso)}` +
    `&sql=${encodeURIComponent(sql)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`analytics query failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as LogsResponse;
  if (json.error) throw new Error(`analytics query error: ${JSON.stringify(json.error)}`);
  return json.result ?? [];
}

const COUNTERS_SQL = `
SELECT
  count(*) AS total,
  countIf(log_attributes['path'] = '/user') AS user_hits,
  countIf(log_attributes['error'] LIKE '%signing method HS256 is invalid%') AS hs256_errors,
  countIf(log_attributes['error'] LIKE '%token signature is invalid%') AS signature_errors,
  countIf(log_attributes['error'] LIKE '%Refresh Token Not Found%') AS refresh_not_found,
  countIf(log_attributes['error'] LIKE '%refresh token length is not valid%') AS refresh_length_invalid,
  countIf(log_attributes['error'] LIKE '%Possible abuse attempt%') AS abuse_attempts
FROM logs
WHERE source = 'auth_logs'`.trim();

const ABUSE_BY_IP_SQL = `
SELECT log_attributes['remote_addr'] AS remote_addr, count(*) AS hits
FROM logs
WHERE source = 'auth_logs' AND log_attributes['error'] LIKE '%Possible abuse attempt%'
GROUP BY remote_addr
ORDER BY hits DESC
LIMIT 20`.trim();

function toInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function fetchAuthLogWindow(
  ref: string,
  token: string,
  windowMinutes: number,
): Promise<AuthLogWindow> {
  const end = new Date();
  const start = new Date(end.getTime() - windowMinutes * 60_000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const [counterRows, ipRows] = await Promise.all([
    runLogsQuery(ref, token, COUNTERS_SQL, startIso, endIso),
    runLogsQuery(ref, token, ABUSE_BY_IP_SQL, startIso, endIso),
  ]);

  const c = counterRows[0] ?? {};
  return {
    windowMinutes,
    total: toInt(c.total),
    userHits: toInt(c.user_hits),
    signatureErrors: toInt(c.signature_errors),
    hs256Errors: toInt(c.hs256_errors),
    refreshNotFound: toInt(c.refresh_not_found),
    refreshLengthInvalid: toInt(c.refresh_length_invalid),
    abuseAttempts: toInt(c.abuse_attempts),
    abuseByIp: ipRows
      .map((r) => ({ remote_addr: String(r.remote_addr ?? 'unknown'), hits: toInt(r.hits) }))
      .filter((r) => r.hits > 0),
  };
}

// ─── JWKS ───────────────────────────────────────────────────────────────

async function fetchJwks(url: string): Promise<JwksDocument | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as JwksDocument;
  } catch {
    // Unreachable is itself the signal — evaluateJwks(null) is critical.
    return null;
  }
}

// ─── Handler ───────────────────────────────────────────────────────────

const GATED_CHECK_IDS = [
  'gotrue_fallback_ratio',
  'signature_algorithm_errors',
  'refresh_token_failures',
  'credential_stuffing',
] as const;

function gatedSkips(reason: string): CheckResult[] {
  return GATED_CHECK_IDS.map((id) => ({ id, status: 'skipped' as const, message: reason }));
}

export async function authHealthMonitor(c: Context) {
  const started = Date.now();
  const thresholds = thresholdsFromEnv(process.env);
  const windowMinutes = Math.max(
    5,
    Number(process.env.AUTH_MONITOR_WINDOW_MINUTES ?? DEFAULT_WINDOW_MINUTES) ||
      DEFAULT_WINDOW_MINUTES,
  );

  const checks: CheckResult[] = [];

  // ── Always-on: JWKS drift + import canary (no credential required) ──────
  const ju = jwksUrl();
  if (!ju) {
    checks.push({
      id: 'jwks_algorithm_drift',
      status: 'critical',
      message: 'no Supabase URL configured — cannot locate the JWKS endpoint',
    });
    checks.push({ id: 'jwks_import_canary', status: 'skipped', message: 'no JWKS URL' });
  } else {
    const jwks = await fetchJwks(ju);
    checks.push(evaluateJwks(jwks));
    checks.push(await canaryImportJwks(jwks));
  }

  // ── Gated: everything that reads auth_logs ──────────────────────────────
  const token = process.env.SUPABASE_MANAGEMENT_API_TOKEN;
  const ref = projectRef();
  let logWindow: AuthLogWindow | null = null;

  if (!token) {
    checks.push(
      ...gatedSkips(
        'SUPABASE_MANAGEMENT_API_TOKEN not set — auth_logs checks disabled ' +
          '(see PR feat/auth-health-monitor for how to enable)',
      ),
    );
  } else if (!ref) {
    checks.push(...gatedSkips('could not derive SUPABASE_PROJECT_REF from the Supabase URL'));
  } else {
    try {
      logWindow = await fetchAuthLogWindow(ref, token, windowMinutes);
      checks.push(evaluateGoTrueFallback(logWindow, thresholds));
      checks.push(evaluateSignatureErrors(logWindow, thresholds));
      checks.push(evaluateRefreshFailures(logWindow, thresholds));
      checks.push(evaluateCredentialStuffing(logWindow, thresholds));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A monitor that cannot read its own signal is BROKEN, not healthy — the
      // whole point of this route is that silence is not evidence of health.
      checks.push({
        id: 'auth_logs_query',
        status: 'warn',
        message: `auth_logs query failed, log-based checks did not run: ${msg}`,
      });
      checks.push(...gatedSkips('upstream auth_logs query failed'));
    }
  }

  const summary = summarizeChecks(checks);
  const elapsed = Date.now() - started;

  // ── Surface ────────────────────────────────────────────────────────
  // Greppable, structured, one line per run. `AUTH-ALERT` is the string to put
  // in a log-drain alert rule if/when one is wired up.
  if (summary.status === 'critical' || summary.status === 'warn') {
    console.error(
      `[${JOB}] AUTH-ALERT ${summary.status.toUpperCase()} ` +
        JSON.stringify({ window_minutes: windowMinutes, problems: summary.problems, checks }),
    );
  } else {
    console.log(`[${JOB}] ok — ${checks.map((k) => `${k.id}:${k.status}`).join(' ')}`);
  }

  const supabase = getSupabase();
  const { error: upsertErr } = await supabase.from('cron_health_log').upsert(
    {
      cron_name: JOB,
      last_run_at: new Date().toISOString(),
      last_status: toCronHealthStatus(summary.status),
      last_duration_ms: elapsed,
      error_message: summary.problems.length > 0 ? summary.problems.join('; ') : null,
      metadata: {
        window_minutes: windowMinutes,
        thresholds,
        checks,
        log_checks_enabled: logWindow !== null,
      } as unknown as Record<string, unknown>,
    },
    { onConflict: 'cron_name' },
  );

  if (upsertErr) {
    // Same rule solver-watchdog learned the hard way: a monitor whose recording
    // leg can fail silently is not a monitor. Fail loudly.
    console.error(`[${JOB}] AUTH-ALERT cron_health_log upsert failed:`, upsertErr.message);
    return c.json({ error: `health recorded nowhere: ${upsertErr.message}`, ...summary }, 500);
  }

  // Escalate only on 'critical' — warn-level noise on an SMS pager trains
  // people to ignore it, which is how the original outage stayed invisible.
  // alertScraperAlerts throttles the same key to once per 6h.
  if (summary.status === 'critical') {
    await alertScraperCritical(JOB, summary.problems.slice(0, 2).join(' | '), {
      errors: summary.problems.map((p) => ({ scraper: JOB, problem: p })),
    });
  }

  return c.json({
    ...summary,
    window_minutes: windowMinutes,
    log_checks_enabled: logWindow !== null,
    elapsed_ms: elapsed,
    run_at: new Date().toISOString(),
  });
}
