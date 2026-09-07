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
 * ═══════════════════════════════════════════════════════════════════════════
 * SIGNAL QUALITY — read this before changing any threshold
 * ───────────────────────────────────────────────────────────────────────────
 * The first draft of this file treated ANY `signing method HS256 is invalid`
 * as critical, on the reasoning that "the healthy value is zero". That was
 * WRONG, and it would have made this monitor page forever from the day it
 * shipped. The correction, verified directly against `auth_logs` on
 * 2026-09-01:
 *
 *   Successful GoTrue /user calls per hour (OUR app's fallback traffic):
 *     11:00 20,752 | 12:00 17,028 | 13:00 20,847   <- fast path broken
 *     14:00  2,704 | 15:00  2,098 | 16:00  2,632
 *     17:00  1,468 | 18:00     91                  <- fix in production
 *
 *   That is a ~99.6% collapse at exactly the hour World-Hub #1196 (ES256
 *   verifier) and #1210 (removing the SUPABASE_JWT_SECRET gate) reached
 *   production. The fix WORKS.
 *
 *   Signature errors over the same hours did NOT collapse:
 *     11:00 2,080 | 12:00 1,803 | 13:00 1,960 | 14:00 1,495
 *     15:00 1,848 | 16:00 1,944 | 17:00 4,325 | 18:00   826
 *
 *   Because they are not ours. Every one of them:
 *     - carries an EMPTY `user_id` — no authenticated session is involved
 *     - arrives on `/user` from a rotating pool of Azure IPs with near-
 *       identical per-IP counts (~254-261 each: 52.234.47.122, 64.236.177.98,
 *       20.3.76.37, 52.161.69.161, 20.168.4.2, 52.250.243.37, 20.64.206.185,
 *       ...) — the same ranges already flagged as credential-stuffing traffic
 *     - scaled from 8-10 distinct IPs to 38 in the 17:00 hour, which is a bot
 *       farm spinning up, not our application regressing
 *
 *   Conclusion: the residual HS256 volume is EXTERNAL ATTACK TRAFFIC replaying
 *   forged or stale HS256 tokens against /user. It was always there. It only
 *   became visible as a *proportion* once our own legitimate fallback noise
 *   disappeared. It will never reach zero, because we do not control who sends
 *   us tokens.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ THEREFORE: `signature_algorithm_errors` IS A CONTAMINATED METRIC.       │
 * │ Its raw count is dominated by third-party traffic we cannot influence.  │
 * │ It must never page on its own. `gotrue_fallback_ratio` — successful     │
 * │ /user calls per hour — is the clean, uncontaminated regression signal,  │
 * │ because it is purely our own servers' fallback traffic.                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Why not simply filter the contamination out? Both obvious filters were
 * tested against the live logs and both fail:
 *   (a) "keep only events with a non-empty user_id" — `user_id` is empty on
 *       EVERY event in this project's auth_logs, including the 20,752
 *       successful /user calls during the outage. Filtering on it does not
 *       isolate app traffic, it zeroes the check permanently.
 *   (b) "exclude IPs that are not our server egress" — GoTrue /user is called
 *       from the browser, so remote_addr is the end user's IP, not ours.
 *       Worse, the single busiest source of *successful* /user calls
 *       (24.15.206.254, 4,106 hits) is also the busiest source of HS256
 *       errors (336 hits). There is no clean address-space separation.
 * So this file takes the third option: gate the signature check on app-origin
 * volume and compare it as a RATIO. See evaluateSignatureErrors below.
 *
 * Everything in this module is deliberately side-effect free so the thresholds
 * can be unit-tested without a database, without a network, and without any
 * credential — see authHealth.test.ts. The route that supplies the numbers is
 * src/routes/auth-health-monitor.ts.
 */

/**
 * `security` is informational-only: it reports abuse we should feed to a WAF,
 * and it deliberately ranks BELOW `ok` so it can never escalate the roll-up or
 * trigger the pager. An alert that always fires trains people to ignore it —
 * which is precisely the failure mode that let the original outage run for
 * months behind a green test.
 */
export type CheckStatus = 'ok' | 'warn' | 'critical' | 'skipped' | 'security';

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
   * Successful GoTrue `/auth/v1/user` calls per hour before we call the fast
   * path broken. THIS IS THE PRIMARY REGRESSION SIGNAL — see the header block.
   *
   * HOW 8,000 WAS DERIVED (from the real 2026-09-01 series, not a guess):
   *   broken  floor = 17,028/h   (the quietest hour while the bug was live;
   *                               the observed broken range was 17,028-20,847,
   *                               and 27,367-28,618 the evening before)
   *   healthy peak  =  2,704/h   (the busiest hour after the fix landed, and
   *                               still falling — 91/h by 18:00)
   * 8,000/h sits between them with deliberate asymmetry:
   *   - 2.96x above the healthy peak, so ordinary organic growth, a traffic
   *     spike, or a mass re-login event does not page anybody
   *   - 0.47x of the broken floor, so a full re-regression trips it inside a
   *     single 60-minute run with better than 2x margin
   * The geometric midpoint of the two is ~6,790/h; 8,000 rounds *upward* from
   * it on purpose, biasing toward a missed quarter-hour over a false page.
   * Tune with AUTH_MONITOR_GOTRUE_USER_PER_HOUR.
   */
  gotrueUserPerHour: number;
  /**
   * Early-warning tier at 4,000/h — ~1.5x the healthy peak. Warns (no SMS) on
   * a partial or gradual degradation that has not yet reached outage scale,
   * e.g. one deployed host out of several serving a stale bundle.
   */
  gotrueUserWarnPerHour: number;
  /**
   * Max share of ALL auth_logs traffic that may be successful `/user`.
   * Absolute counts scale with DAU; this ratio does not, so it keeps working
   * as the site grows.
   *
   * REVISED from 0.30 against real data. Measured share by hour:
   *   broken:  0.737, 0.756, 0.764   healthy: 0.198, 0.296, 0.513, 0.220
   * The healthy peak of 0.513 means the original 0.30 would have warned on
   * perfectly healthy traffic. 0.65 clears the healthy peak by 27% and sits
   * 12% below the broken floor.
   */
  gotrueUserRatio: number;
  /** Below this many total auth events, the ratio is statistical noise. */
  gotrueMinSample: number;
  /**
   * Signature errors as a fraction of successful /user calls, evaluated ONLY
   * when app-origin /user volume is itself elevated. See the header block and
   * evaluateSignatureErrors for why an absolute count cannot be used.
   *
   * During the outage this ratio was 0.100 / 0.106 / 0.094 (11:00-13:00).
   * 0.02 keeps ~4.5x margin under the observed regression value while being
   * far above anything a healthy app can emit — a working ES256 verifier
   * produces none of these at all.
   */
  signatureErrorAppRatio: number;
  /**
   * Purely informational: emit the `security` notice with the offending-IP
   * list once external signature-error volume exceeds this. Observed
   * attack-traffic floor is ~600-800/h with waves to 4,325/h, so 500/h keeps
   * the notice meaningful rather than constant. Never pages.
   */
  signatureErrorNoticePerHour: number;
  /**
   * Combined `Invalid Refresh Token: Refresh Token Not Found` +
   * `crypto: refresh token length is not valid` per hour.
   *
   * CONFIRMED against live logs rather than assumed. Post-fix hourly:
   *   not-found:   1,409 (14:00, the deploy hour) then 0, 0, 0, 0
   *   bad-length:  75 -> 68 -> 53 -> 59 -> 0 -> 0
   * Both are now genuinely zero, so a low threshold is defensible and 100/h
   * stands. The single 1,409 spike at 14:00 is the fix landing and mass-
   * invalidating stale sessions; it is a one-off transient, and warn-level
   * (no SMS) is the right response to it.
   */
  refreshFailuresPerHour: number;
  /**
   * `Possible abuse attempt` on /token per hour. The credential-stuffing wave
   * was ~40 Azure IPs x ~460 requests each over 24h ~= 767/h. 200/h flags a
   * re-run of that pattern early while tolerating a handful of humans
   * fat-fingering a password.
   *
   * NOTE: this counter does NOT see the HS256 replay traffic. In the 16:00-
   * 18:00 hours GoTrue logged 0 `Possible abuse attempt` while simultaneously
   * logging 1,944 / 4,325 / 826 signature errors — the replays hit /user, not
   * /token, so they are never classified as an abuse attempt. That is exactly
   * why the HS256 bot signal needs its own check (see
   * evaluateSignatureErrorSource) rather than being folded in here.
   */
  abusePerHour: number;
}

export const DEFAULT_THRESHOLDS: AuthHealthThresholds = {
  gotrueUserPerHour: 8000,
  gotrueUserWarnPerHour: 4000,
  gotrueUserRatio: 0.65,
  gotrueMinSample: 50,
  signatureErrorAppRatio: 0.02,
  signatureErrorNoticePerHour: 500,
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
    gotrueUserWarnPerHour: num(env.AUTH_MONITOR_GOTRUE_USER_WARN_PER_HOUR, DEFAULT_THRESHOLDS.gotrueUserWarnPerHour),
    gotrueUserRatio: num(env.AUTH_MONITOR_GOTRUE_USER_RATIO, DEFAULT_THRESHOLDS.gotrueUserRatio),
    gotrueMinSample: num(env.AUTH_MONITOR_GOTRUE_MIN_SAMPLE, DEFAULT_THRESHOLDS.gotrueMinSample),
    signatureErrorAppRatio: num(env.AUTH_MONITOR_SIGNATURE_ERROR_APP_RATIO, DEFAULT_THRESHOLDS.signatureErrorAppRatio),
    signatureErrorNoticePerHour: num(env.AUTH_MONITOR_SIGNATURE_ERROR_NOTICE_PER_HOUR, DEFAULT_THRESHOLDS.signatureErrorNoticePerHour),
    refreshFailuresPerHour: num(env.AUTH_MONITOR_REFRESH_FAILURES_PER_HOUR, DEFAULT_THRESHOLDS.refreshFailuresPerHour),
    abusePerHour: num(env.AUTH_MONITOR_ABUSE_PER_HOUR, DEFAULT_THRESHOLDS.abusePerHour),
  };
}

// ─── Log window shape ───────────────────────────────────────────────────────

/** One aggregated slice of `auth_logs`, already reduced to counters. */
export interface AuthLogWindow {
  windowMinutes: number;
  total: number;
  /**
   * SUCCESSFUL `/user` calls only (HTTP 200). This is deliberate and it is
   * load-bearing: a failed /user call is, by definition, a request whose token
   * GoTrue rejected — i.e. attacker traffic — whereas a successful one is our
   * own server completing a fallback lookup for a real session. Counting all
   * /user hits regardless of status would mix the two back together and
   * re-contaminate the one clean signal this monitor has.
   */
  userHits: number;
  signatureErrors: number;
  hs256Errors: number;
  refreshNotFound: number;
  refreshLengthInvalid: number;
  abuseAttempts: number;
  abuseByIp: Array<{ remote_addr: string; hits: number }>;
  /** Source addresses behind the signature errors, for the WAF blocklist. */
  signatureErrorsByIp: Array<{ remote_addr: string; hits: number }>;
}

/** Normalise a raw count over an arbitrary window to a per-hour rate. */
export function perHour(count: number, windowMinutes: number): number {
  if (!(windowMinutes > 0)) return count;
  return Number(((count * 60) / windowMinutes).toFixed(1));
}

// ─── Check 1 — GoTrue fallback volume — THE PRIMARY REGRESSION SIGNAL ───────

/**
 * Successful GoTrue /user calls per hour.
 *
 * This is the check that actually catches a repeat of the outage. It is the
 * only auth_logs metric in this file that is purely our own traffic: an
 * attacker cannot inflate it, because an attacker's forged token does not
 * produce a 200. If local ES256 verification breaks again, every authenticated
 * request falls through to this endpoint and the number climbs straight back
 * into five figures within minutes.
 *
 * See AuthHealthThresholds.gotrueUserPerHour for the full derivation of 8,000.
 */
export function evaluateGoTrueFallback(
  w: AuthLogWindow,
  t: AuthHealthThresholds,
): CheckResult {
  const rate = perHour(w.userHits, w.windowMinutes);
  const ratio = w.total > 0 ? w.userHits / w.total : 0;
  const ratioMeaningful = w.total >= t.gotrueMinSample;

  const data = {
    successful_user_hits: w.userHits,
    total_auth_events: w.total,
    user_share: Number(ratio.toFixed(3)),
    window_minutes: w.windowMinutes,
    ratio_threshold: t.gotrueUserRatio,
    warn_threshold_per_hour: t.gotrueUserWarnPerHour,
    healthy_reference: 'post-fix observed 91-2,704/h on 2026-09-01',
    broken_reference: 'outage observed 17,028-28,618/h',
  };

  if (rate > t.gotrueUserPerHour) {
    return {
      id: 'gotrue_fallback_ratio',
      status: 'critical',
      message:
        `successful GoTrue /user at ${rate}/h (limit ${t.gotrueUserPerHour}/h) — ` +
        'local JWT verification is falling through to the network fast-path. ' +
        'Healthy is under ~2,700/h; the outage ran at 17,000-21,000/h.',
      observed: rate,
      threshold: t.gotrueUserPerHour,
      data,
    };
  }

  if (rate > t.gotrueUserWarnPerHour) {
    return {
      id: 'gotrue_fallback_ratio',
      status: 'warn',
      message:
        `successful GoTrue /user at ${rate}/h (warn above ${t.gotrueUserWarnPerHour}/h, ` +
        `critical above ${t.gotrueUserPerHour}/h) — elevated well above the ~2,700/h ` +
        'healthy peak; a verifier may be degrading on some hosts',
      observed: rate,
      threshold: t.gotrueUserWarnPerHour,
      data,
    };
  }

  if (ratioMeaningful && ratio > t.gotrueUserRatio) {
    return {
      id: 'gotrue_fallback_ratio',
      status: 'warn',
      message:
        `successful GoTrue /user is ${(ratio * 100).toFixed(1)}% of all auth traffic ` +
        `(limit ${(t.gotrueUserRatio * 100).toFixed(0)}%) — fast-path may be degrading`,
      observed: Number(ratio.toFixed(3)),
      threshold: t.gotrueUserRatio,
      data,
    };
  }

  return {
    id: 'gotrue_fallback_ratio',
    status: 'ok',
    message: `successful GoTrue /user at ${rate}/h (${(ratio * 100).toFixed(1)}% of auth traffic)`,
    observed: rate,
    threshold: t.gotrueUserPerHour,
    data,
  };
}

// ─── Check 2 — signature errors, RE-BASED ON APP-ORIGIN SIGNAL ──────────────

/**
 * !! THIS METRIC IS CONTAMINATED BY THIRD-PARTY TRAFFIC. Read the header block
 * before touching it.
 *
 * The raw count of `signing method HS256 is invalid` is NOT a measure of our
 * application's health. On 2026-09-01, with the ES256 fix confirmed working
 * and our own fallback traffic down 99.6%, this counter was still running at
 * 826-4,325/h — entirely external bots replaying forged/stale HS256 tokens at
 * /user from rotating Azure address space. That volume was present throughout
 * the outage too; it simply became visible as a proportion once our own noise
 * stopped. It will never be zero.
 *
 * Neither of the cheap filters isolates our traffic (see header: `user_id` is
 * empty on every event in this stream, and the busiest legitimate /user source
 * IP is also the busiest HS256-error source IP). So the check is INVERTED:
 *
 *   Alert only when BOTH
 *     (1) app-origin fallback volume is itself elevated — i.e. the primary
 *         signal in evaluateGoTrueFallback is already saying something is
 *         wrong, AND
 *     (2) signature errors are a material FRACTION of that app volume.
 *
 * Condition (1) is what makes this safe: a bot wave alone cannot satisfy it,
 * because bots produce no successful /user calls. Condition (2) is what makes
 * it specific: during the real outage the ratio sat at 0.094-0.106.
 *
 * Note the ratio runs BACKWARDS from intuition in healthy periods — at 17:00
 * it was 2.95 (4,325 errors against 1,468 successful calls) precisely because
 * the denominator had collapsed. Any check on the ratio alone, ungated, would
 * fire hardest exactly when the system is healthiest. Hence the gate.
 */
export function evaluateSignatureErrors(
  w: AuthLogWindow,
  t: AuthHealthThresholds,
): CheckResult {
  const errRate = perHour(w.signatureErrors, w.windowMinutes);
  const appRate = perHour(w.userHits, w.windowMinutes);
  const appOriginElevated = appRate > t.gotrueUserWarnPerHour;
  const ratio = w.userHits > 0 ? w.signatureErrors / w.userHits : 0;

  const data = {
    signature_errors: w.signatureErrors,
    hs256_errors: w.hs256Errors,
    successful_user_hits: w.userHits,
    signature_errors_per_successful_user: Number(ratio.toFixed(4)),
    app_origin_elevated: appOriginElevated,
    app_origin_gate_per_hour: t.gotrueUserWarnPerHour,
    window_minutes: w.windowMinutes,
    contamination_note:
      'raw count includes external replay traffic and is NOT an app-health ' +
      'measure; see signature_error_sources for the offending IPs',
  };

  if (appOriginElevated && ratio > t.signatureErrorAppRatio) {
    return {
      id: 'signature_algorithm_errors',
      status: 'critical',
      message:
        `${w.signatureErrors} signature errors against ${w.userHits} successful ` +
        `/user calls (ratio ${ratio.toFixed(3)}, limit ${t.signatureErrorAppRatio}) ` +
        `WHILE app-origin fallback volume is elevated at ${appRate}/h. Both halves ` +
        'of the outage signature are present — a verifier is asserting HS256 ' +
        'against ES256 signing keys.',
      observed: Number(ratio.toFixed(4)),
      threshold: t.signatureErrorAppRatio,
      data,
    };
  }

  if (appOriginElevated) {
    return {
      id: 'signature_algorithm_errors',
      status: 'warn',
      message:
        `app-origin fallback volume is elevated (${appRate}/h) but signature errors ` +
        `are only ${ratio.toFixed(3)} of it (limit ${t.signatureErrorAppRatio}) — ` +
        'the fallback spike may have a cause other than algorithm mismatch',
      observed: Number(ratio.toFixed(4)),
      threshold: t.signatureErrorAppRatio,
      data,
    };
  }

  return {
    id: 'signature_algorithm_errors',
    status: 'ok',
    message:
      `${errRate}/h signature errors, but app-origin fallback volume is normal ` +
      `(${appRate}/h) — no app-side algorithm regression. Residual volume is ` +
      'external replay traffic; see signature_error_sources.',
    observed: Number(ratio.toFixed(4)),
    threshold: t.signatureErrorAppRatio,
    data,
  };
}

// ─── Check 2b — signature errors as a SECURITY signal (informational) ───────

/**
 * The other half of the split. The HS256 replay volume is real and worth
 * seeing — it is just a security observation, not an availability one, so it
 * reports at `security` severity: it appears in the payload and the log line,
 * it never escalates the roll-up, and it never sends an SMS.
 *
 * It carries the top offending IPs the same way `credential_stuffing` does, so
 * they can go straight into a WAF blocklist. It needs to exist separately from
 * `credential_stuffing` because GoTrue does not classify these as abuse: in
 * the 16:00-18:00 hours on 2026-09-01 `Possible abuse attempt` was 0 while
 * signature errors ran 1,944 / 4,325 / 826. The replays hit /user, not /token.
 */
export function evaluateSignatureErrorSource(
  w: AuthLogWindow,
  t: AuthHealthThresholds,
): CheckResult {
  const rate = perHour(w.signatureErrors, w.windowMinutes);
  const topIps = [...w.signatureErrorsByIp].sort((a, b) => b.hits - a.hits).slice(0, 10);
  const data = {
    signature_errors: w.signatureErrors,
    hs256_errors: w.hs256Errors,
    distinct_ips: w.signatureErrorsByIp.length,
    top_ips: topIps,
    window_minutes: w.windowMinutes,
  };

  if (rate > t.signatureErrorNoticePerHour) {
    return {
      id: 'signature_error_sources',
      status: 'security',
      message:
        `${w.signatureErrors} token-signature rejections in ${w.windowMinutes}m ` +
        `(${rate}/h) from ${w.signatureErrorsByIp.length} IPs — external clients ` +
        'replaying forged or stale HS256 tokens against /user. Informational: ' +
        'this is inbound abuse, not an app regression. WAF candidates: ' +
        `${topIps.slice(0, 5).map((r) => `${r.remote_addr}(${r.hits})`).join(', ')}`,
      observed: rate,
      threshold: t.signatureErrorNoticePerHour,
      data,
    };
  }

  return {
    id: 'signature_error_sources',
    status: 'ok',
    message: `token-signature rejections at ${rate}/h from ${w.signatureErrorsByIp.length} IPs`,
    observed: rate,
    threshold: t.signatureErrorNoticePerHour,
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
 *
 * Unchanged by the 2026-09-01 correction: this check reads a public endpoint
 * whose meaning we control, so no third-party traffic can contaminate it.
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
 * Also unchanged by the 2026-09-01 correction, for the same reason as
 * evaluateJwks: no third party can influence what it observes.
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
  /** Availability problems. These drive the log line and the pager. */
  problems: string[];
  /** Informational security observations. Reported, never paged on. */
  notices: string[];
  checks: CheckResult[];
}

/**
 * `security` ranks alongside `skipped` at 0 — strictly below `ok` — so a
 * security notice can never raise the overall verdict, never flip
 * cron_health_log to 'error', and never reach the SMS channel. It is carried
 * in `notices` and in the per-check payload instead.
 */
const RANK: Record<CheckStatus, number> = {
  skipped: 0,
  security: 0,
  ok: 1,
  warn: 2,
  critical: 3,
};

/**
 * Worst-wins roll-up. `skipped` never masks a real verdict and never creates
 * one: a gated check contributes nothing either way, which is what lets the
 * monitor run usefully with no Management API token. `security` behaves the
 * same way for escalation purposes but is surfaced in `notices`.
 */
export function summarizeChecks(checks: CheckResult[]): AuthHealthSummary {
  let status: CheckStatus = 'ok';
  const problems: string[] = [];
  const notices: string[] = [];

  for (const check of checks) {
    if (check.status === 'warn' || check.status === 'critical') {
      problems.push(`[${check.status}] ${check.id}: ${check.message}`);
    } else if (check.status === 'security') {
      notices.push(`[security] ${check.id}: ${check.message}`);
    }
    if (RANK[check.status] > RANK[status]) status = check.status;
  }

  return { status, problems, notices, checks };
}

/**
 * cron_health_log.last_status only accepts success|error|timeout, so the health
 * verdict maps onto that vocabulary rather than inventing one — same convention
 * as solver-watchdog. 'error' means "auth is unhealthy", not "this route
 * failed"; error_message carries the specifics. `security` maps to 'success'
 * because inbound abuse is not a health failure of this service.
 */
export function toCronHealthStatus(status: CheckStatus): 'success' | 'error' {
  return status === 'warn' || status === 'critical' ? 'error' : 'success';
}
