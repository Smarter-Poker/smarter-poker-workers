/**
 * Auth-health evaluation — PURE functions, zero I/O.
 * ═══════════════════════════════════════════════════════════════════════════
 * Backing story (why this file exists at all)
 * ───────────────────────────────────────────────────────────────────────────
 * The World Hub JWT verifier was hardcoded to HS256 long after the Supabase
 * project migrated to ES256 (asymmetric) signing keys. Local verification
 * therefore failed for EVERY authenticated request, and every request fell
 * through the "fast path" into a live GoTrue `/auth/v1/user` network call.
 * That ran undetected for months at ~20M edge requests/24h until it saturated
 * the project-wide auth rate limit and cascaded into a site-wide logout loop.
 *
 * Regression tests now exist (World-Hub #1196/#1198/#1210/#1220, commander
 * #77/#78) but they are all BUILD-TIME. They cannot catch:
 *   - Supabase rotating the signing keys underneath us
 *   - an env var changing on a deployed host
 *   - a stale bundle still shipping the old verifier from a CDN cache
 * All three break at RUNTIME, in production, with a green CI.
 *
 * Everything in this module is deliberately side-effect free so the thresholds
 * can be unit-tested without a database, without a network, and without any
 * credential — see authHealth.test.ts. The route that supplies the numbers is
 * src/routes/auth-health-monitor.ts.
 */

export type CheckStatus = 'ok' | 'warn' | 'critical' | 'skipped';

export interface CheckResult {
  /** Stable machine id — safe to alert/dedupe on. */
  id: string;
  status: CheckStatus;
  message: string;
  /** Normalised observed value (per hour, or a ratio) where meaningful. */
  observed?: number | null;
  threshold?: number | null;
  data?: Record<string, unknown>;
}

// ─── Thresholds ─────────────────────────────────────────────────────────────

export interface AuthHealthThresholds {
  /**
   * Max `/auth/v1/user` hits per hour before we call the fast path broken.
   *
   * REASONING. During the outage this endpoint ran at ~20,000/hour: local
   * verification was failing 100% of the time, so GoTrue `/user` volume tracked
   * authenticated API volume roughly 1:1. When local ES256 verification works,
   * `/user` should only be hit on genuine session bootstrap / recovery — a
   * small fraction of traffic. 1,000/h is ~5% of the observed outage rate:
   * comfortably above any plausible healthy bootstrap volume for this project,
   * and low enough that a full verification regression trips it inside a single
   * 60-minute run instead of inside a quarter. Tune with
   * AUTH_MONITOR_GOTRUE_USER_PER_HOUR once a real healthy baseline exists.
   */
  gotrueUserPerHour: number;
  /**
   * Max share of ALL auth_logs traffic that may be `/user`. Absolute counts
   * scale with DAU; this ratio does not, so it keeps catching the regression
   * as the site grows. At full breakage the ratio approaches 1.0 (during the
   * incident window it sat at 0.85–0.95). 0.30 leaves ample headroom for a
   * quiet hour dominated by page-load bootstraps.
   */
  gotrueUserRatio: number;
  /** Below this many total auth events, the ratio is statistical noise. */
  gotrueMinSample: number;
  /**
   * `token signature is invalid` / `signing method HS256 is invalid` per hour.
   * The healthy value is ZERO — a correctly configured client cannot produce
   * one. Kept env-tunable only so a known-noisy legacy client can be tolerated
   * temporarily; do not raise it casually.
   */
  signatureErrorsPerHour: number;
  /**
   * Combined `Invalid Refresh Token: Refresh Token Not Found` +
   * `crypto: refresh token length is not valid` per hour. Incident baselines
   * were 4,016 and 1,040 per 24h (≈167/h + ≈43/h ≈ 210/h combined); both should
   * now be near zero. 100/h is under half the incident rate, so a genuine
   * resurgence of the client-side refresh race is caught while ordinary
   * single-digit churn is not.
   */
  refreshFailuresPerHour: number;
  /**
   * `Possible abuse attempt` on /token per hour. The credential-stuffing wave
   * was ~40 Azure IPs × ~460 requests each over 24h ≈ 767/h. 200/h flags a
   * re-run of that pattern early while tolerating a handful of humans
   * fat-fingering a password.
   */
  abusePerHour: number;
}

export const DEFAULT_THRESHOLDS: AuthHealthThresholds = {
  gotrueUserPerHour: 1000,
  gotrueUserRatio: 0.3,
  gotrueMinSample: 50,
  signatureErrorsPerHour: 0,
  refreshFailuresPerHour: 100,
  abusePerHour: 200,
};

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Build thresholds from env, falling back to DEFAULT_THRESHOLDS per field. */
export function thresholdsFromEnv(
  env: Record<string, string | undefined>,
): AuthHealthThresholds {
  return {
    gotrueUserPerHour: num(env.AUTH_MONITOR_GOTRUE_USER_PER_HOUR, DEFAULT_THRESHOLDS.gotrueUserPerHour),
    gotrueUserRatio: num(env.AUTH_MONITOR_GOTRUE_USER_RATIO, DEFAULT_THRESHOLDS.gotrueUserRatio),
    gotrueMinSample: num(env.AUTH_MONITOR_GOTRUE_MIN_SAMPLE, DEFAULT_THRESHOLDS.gotrueMinSample),
    signatureErrorsPerHour: num(env.AUTH_MONITOR_SIGNATURE_ERRORS_PER_HOUR, DEFAULT_THRESHOLDS.signatureErrorsPerHour),
    refreshFailuresPerHour: num(env.AUTH_MONITOR_REFRESH_FAILURES_PER_HOUR, DEFAULT_THRESHOLDS.refreshFailuresPerHour),
    abusePerHour: num(env.AUTH_MONITOR_ABUSE_PER_HOUR, DEFAULT_THRESHOLDS.abusePerHour),
  };
}

// ─── Log window shape ───────────────────────────────────────────────────────

/** One aggregated slice of `auth_logs`, already reduced to counters. */
export interface AuthLogWindow {
  windowMinutes: number;
  total: number;
  userHits: number;
  signatureErrors: number;
  hs256Errors: number;
  refreshNotFound: number;
  refreshLengthInvalid: number;
  abuseAttempts: number;
  abuseByIp: Array<{ remote_addr: string; hits: number }>;
}

/** Normalise a raw count over an arbitrary window to a per-hour rate. */
export function perHour(count: number, windowMinutes: number): number {
  if (!(windowMinutes > 0)) return count;
  return Number(((count * 60) / windowMinutes).toFixed(1));
}

// ─── Check 1 — GoTrue fallback ratio (leading indicator) ────────────────────

export function evaluateGoTrueFallback(
  w: AuthLogWindow,
  t: AuthHealthThresholds,
): CheckResult {
  const rate = perHour(w.userHits, w.windowMinutes);
  const ratio = w.total > 0 ? w.userHits / w.total : 0;
  const ratioMeaningful = w.total >= t.gotrueMinSample;

  const data = {
    user_hits: w.userHits,
    total_auth_events: w.total,
    user_share: Number(ratio.toFixed(3)),
    window_minutes: w.windowMinutes,
    ratio_threshold: t.gotrueUserRatio,
  };

  if (rate > t.gotrueUserPerHour) {
    return {
      id: 'gotrue_fallback_ratio',
      status: 'critical',
      message:
        `GoTrue /user at ${rate}/h (limit ${t.gotrueUserPerHour}/h) — local JWT ` +
        'verification is probably falling through to the network fast-path',
      observed: rate,
      threshold: t.gotrueUserPerHour,
      data,
    };
  }

  if (ratioMeaningful && ratio > t.gotrueUserRatio) {
    return {
      id: 'gotrue_fallback_ratio',
      status: 'warn',
      message:
        `GoTrue /user is ${(ratio * 100).toFixed(1)}% of all auth traffic ` +
        `(limit ${(t.gotrueUserRatio * 100).toFixed(0)}%) — fast-path may be degrading`,
      observed: Number(ratio.toFixed(3)),
      threshold: t.gotrueUserRatio,
      data,
    };
  }

  return {
    id: 'gotrue_fallback_ratio',
    status: 'ok',
    message: `GoTrue /user at ${rate}/h (${(ratio * 100).toFixed(1)}% of auth traffic)`,
    observed: rate,
    threshold: t.gotrueUserPerHour,
    data,
  };
}

// ─── Check 2 — signature-algorithm errors (direct regression detector) ──────

export function evaluateSignatureErrors(
  w: AuthLogWindow,
  t: AuthHealthThresholds,
): CheckResult {
  const rate = perHour(w.signatureErrors, w.windowMinutes);
  const data = {
    signature_errors: w.signatureErrors,
    hs256_errors: w.hs256Errors,
    window_minutes: w.windowMinutes,
  };

  if (w.hs256Errors > 0) {
    return {
      id: 'signature_algorithm_errors',
      status: 'critical',
      message:
        `${w.hs256Errors} × "signing method HS256 is invalid" in the last ` +
        `${w.windowMinutes}m — a verifier is still asserting HS256 against ` +
        'ES256 signing keys. This is the exact outage regression.',
      observed: rate,
      threshold: t.signatureErrorsPerHour,
      data,
    };
  }

  if (rate > t.signatureErrorsPerHour) {
    return {
      id: 'signature_algorithm_errors',
      status: 'critical',
      message:
        `${w.signatureErrors} × "token signature is invalid" in the last ` +
        `${w.windowMinutes}m — healthy is zero`,
      observed: rate,
      threshold: t.signatureErrorsPerHour,
      data,
    };
  }

  return {
    id: 'signature_algorithm_errors',
    status: 'ok',
    message: 'no signature-algorithm errors',
    observed: rate,
    threshold: t.signatureErrorsPerHour,
    data,
  };
}

// ─── Check 4 — refresh-token failure rate ───────────────────────────────────

export function evaluateRefreshFailures(
  w: AuthLogWindow,
  t: AuthHealthThresholds,
): CheckResult {
  const combined = w.refreshNotFound + w.refreshLengthInvalid;
  const rate = perHour(combined, w.windowMinutes);
  const data = {
    refresh_token_not_found: w.refreshNotFound,
    refresh_token_length_invalid: w.refreshLengthInvalid,
    window_minutes: w.windowMinutes,
  };

  if (rate > t.refreshFailuresPerHour) {
    return {
      id: 'refresh_token_failures',
      status: 'warn',
      message:
        `refresh-token failures at ${rate}/h (limit ${t.refreshFailuresPerHour}/h): ` +
        `${w.refreshNotFound} not-found, ${w.refreshLengthInvalid} bad-length — ` +
        'the client-side refresh race may have regressed',
      observed: rate,
      threshold: t.refreshFailuresPerHour,
      data,
    };
  }

  return {
    id: 'refresh_token_failures',
    status: 'ok',
    message: `refresh-token failures at ${rate}/h`,
    observed: rate,
    threshold: t.refreshFailuresPerHour,
    data,
  };
}

// ─── Check 5 — credential stuffing ──────────────────────────────────────────

export function evaluateCredentialStuffing(
  w: AuthLogWindow,
  t: AuthHealthThresholds,
): CheckResult {
  const rate = perHour(w.abuseAttempts, w.windowMinutes);
  // Top offenders travel WITH the alert so they can be pasted straight into a
  // WAF blocklist without a second round-trip to the log console.
  const topIps = [...w.abuseByIp].sort((a, b) => b.hits - a.hits).slice(0, 10);
  const data = {
    abuse_attempts: w.abuseAttempts,
    distinct_ips: w.abuseByIp.length,
    top_ips: topIps,
    window_minutes: w.windowMinutes,
  };

  if (rate > t.abusePerHour) {
    return {
      id: 'credential_stuffing',
      status: 'warn',
      message:
        `${w.abuseAttempts} "Possible abuse attempt" on /token in ${w.windowMinutes}m ` +
        `(${rate}/h, limit ${t.abusePerHour}/h) from ${w.abuseByIp.length} IPs. ` +
        `Top: ${topIps.slice(0, 5).map((r) => `${r.remote_addr}(${r.hits})`).join(', ')}`,
      observed: rate,
      threshold: t.abusePerHour,
      data,
    };
  }

  return {
    id: 'credential_stuffing',
    status: 'ok',
    message: `abuse attempts at ${rate}/h`,
    observed: rate,
    threshold: t.abusePerHour,
    data,
  };
}

// ─── Check 3 — JWKS algorithm drift ─────────────────────────────────────────

export interface Jwk {
  kty?: string;
  alg?: string;
  crv?: string;
  kid?: string;
  x?: string;
  y?: string;
  use?: string;
}

export interface JwksDocument {
  keys?: Jwk[];
}

/**
 * Structural check on the live JWKS. Catches a signing-key rotation BEFORE it
 * breaks verification: if Supabase stops publishing ES256 keys, every verifier
 * pinned to ES256 fails on the next token issued, and we are back in the
 * outage. Pure — the fetch happens in the route.
 */
export function evaluateJwks(doc: JwksDocument | null): CheckResult {
  if (doc === null || !Array.isArray(doc.keys)) {
    return {
      id: 'jwks_algorithm_drift',
      status: 'critical',
      message: 'JWKS unreachable or malformed (no `keys` array)',
      observed: null,
      threshold: null,
    };
  }

  const keys = doc.keys;
  if (keys.length === 0) {
    return {
      id: 'jwks_algorithm_drift',
      status: 'critical',
      message: 'JWKS is empty — no signing keys published',
      observed: 0,
      threshold: null,
    };
  }

  const es256 = keys.filter(
    (k) => k.alg === 'ES256' && k.kty === 'EC' && k.crv === 'P-256',
  );
  const data = {
    key_count: keys.length,
    es256_count: es256.length,
    algs: keys.map((k) => k.alg ?? 'unknown'),
    kids: keys.map((k) => k.kid ?? 'unknown'),
  };

  if (es256.length === 0) {
    return {
      id: 'jwks_algorithm_drift',
      status: 'critical',
      message:
        `JWKS serves no ES256/P-256 key (algs: ${data.algs.join(', ')}) — ` +
        'every ES256-pinned verifier will fail on the next issued token',
      observed: 0,
      threshold: null,
      data,
    };
  }

  if (es256.length < keys.length) {
    return {
      id: 'jwks_algorithm_drift',
      status: 'warn',
      message:
        `JWKS is mixed-algorithm: ${es256.length}/${keys.length} keys are ES256 ` +
        `(algs: ${data.algs.join(', ')}) — a rotation may be in progress`,
      observed: es256.length,
      threshold: keys.length,
      data,
    };
  }

  return {
    id: 'jwks_algorithm_drift',
    status: 'ok',
    message: `JWKS serving ${es256.length} ES256/P-256 key(s)`,
    observed: es256.length,
    threshold: null,
    data,
  };
}

// ─── Synthetic canary — import the live key material ────────────────────────

/**
 * The most direct possible test, and it needs no credential at all: take the
 * real published key material and import it through WebCrypto exactly as the
 * production verifier does (ECDSA / P-256 / verify). Structural checks pass on
 * a JWKS whose `x`/`y` are truncated or re-encoded; this one does not. If the
 * key material stops importing, signature verification is about to fail for
 * every user on the site.
 *
 * Async, but still network-free — safe to unit test against a static JWKS.
 */
export async function canaryImportJwks(doc: JwksDocument | null): Promise<CheckResult> {
  if (doc === null || !Array.isArray(doc.keys) || doc.keys.length === 0) {
    return {
      id: 'jwks_import_canary',
      status: 'critical',
      message: 'no key material to import',
      observed: 0,
      threshold: null,
    };
  }

  const failures: string[] = [];
  let imported = 0;

  for (const key of doc.keys) {
    if (key.alg !== 'ES256') continue;
    try {
      // Minimal JWK only — mirrors what a verifier library hands to WebCrypto,
      // and keeps optional publication fields (ext/key_ops/use) from changing
      // the outcome of the check.
      await crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x: key.x, y: key.y },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      imported += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${key.kid ?? 'unknown-kid'}: ${msg}`);
    }
  }

  if (imported === 0) {
    return {
      id: 'jwks_import_canary',
      status: 'critical',
      message:
        'no ES256 key in the live JWKS could be imported as ECDSA P-256 — ' +
        `verification is about to fail site-wide. ${failures.join('; ')}`,
      observed: 0,
      threshold: null,
      data: { failures },
    };
  }

  if (failures.length > 0) {
    return {
      id: 'jwks_import_canary',
      status: 'warn',
      message: `${failures.length} JWKS key(s) failed ECDSA P-256 import: ${failures.join('; ')}`,
      observed: imported,
      threshold: null,
      data: { failures },
    };
  }

  return {
    id: 'jwks_import_canary',
    status: 'ok',
    message: `${imported} ES256 key(s) imported as ECDSA P-256`,
    observed: imported,
    threshold: null,
  };
}

// ─── Roll-up ────────────────────────────────────────────────────────────────

export interface AuthHealthSummary {
  status: CheckStatus;
  problems: string[];
  checks: CheckResult[];
}

const RANK: Record<CheckStatus, number> = { skipped: 0, ok: 1, warn: 2, critical: 3 };

/**
 * Worst-wins roll-up. `skipped` never masks a real verdict and never creates
 * one: a gated check contributes nothing either way, which is what lets the
 * monitor run usefully with no Management API token.
 */
export function summarizeChecks(checks: CheckResult[]): AuthHealthSummary {
  let status: CheckStatus = 'ok';
  const problems: string[] = [];

  for (const check of checks) {
    if (check.status === 'warn' || check.status === 'critical') {
      problems.push(`[${check.status}] ${check.id}: ${check.message}`);
    }
    if (RANK[check.status] > RANK[status]) status = check.status;
  }

  return { status, problems, checks };
}

/**
 * cron_health_log.last_status only accepts success|error|timeout, so the health
 * verdict maps onto that vocabulary rather than inventing one — same convention
 * as solver-watchdog. 'error' means "auth is unhealthy", not "this route
 * failed"; error_message carries the specifics.
 */
export function toCronHealthStatus(status: CheckStatus): 'success' | 'error' {
  return status === 'warn' || status === 'critical' ? 'error' : 'success';
}
