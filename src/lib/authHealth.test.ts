/**
 * Threshold + evaluation tests for the auth-health monitor.
 *
 * Pure functions over sample inputs. No network, no database, no credential —
 * every number below is either a synthetic edge case or a real figure taken
 * from the incident window or the 2026-09-01 post-fix window, so the file
 * doubles as the documented baseline.
 *
 * Two tests here exist specifically to lock in the false-positive correction
 * described in the authHealth.ts header block:
 *   - 'does NOT go critical on an external signature-error burst'
 *   - 'DOES go critical when app-origin fallback volume is elevated'
 * If either of those ever needs relaxing, re-read that header first.
 *
 * Runs under the repo's existing vitest.config.ts (include: src/**\/*.test.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  thresholdsFromEnv,
  perHour,
  evaluateGoTrueFallback,
  evaluateSignatureErrors,
  evaluateSignatureErrorSource,
  evaluateRefreshFailures,
  evaluateCredentialStuffing,
  evaluateJwks,
  canaryImportJwks,
  summarizeChecks,
  toCronHealthStatus,
  type AuthLogWindow,
} from './authHealth.js';

/** A quiet, healthy hour. */
function healthyWindow(over: Partial<AuthLogWindow> = {}): AuthLogWindow {
  return {
    windowMinutes: 60,
    total: 1200,
    userHits: 40,
    signatureErrors: 0,
    hs256Errors: 0,
    refreshNotFound: 1,
    refreshLengthInvalid: 0,
    abuseAttempts: 3,
    abuseByIp: [{ remote_addr: '203.0.113.10', hits: 3 }],
    signatureErrorsByIp: [],
    ...over,
  };
}

/**
 * The real 17:00 hour on 2026-09-01: the ES256 fix is live, our own fallback
 * traffic has collapsed to 1,468/h, and a bot farm is replaying stale HS256
 * tokens at /user from 38 Azure addresses. THIS MUST NOT PAGE.
 */
function externalAttackWindow(over: Partial<AuthLogWindow> = {}): AuthLogWindow {
  return healthyWindow({
    total: 6660,
    userHits: 1468,
    signatureErrors: 4325,
    hs256Errors: 4020,
    abuseAttempts: 0,
    abuseByIp: [],
    signatureErrorsByIp: Array.from({ length: 38 }, (_, i) => ({
      remote_addr: `20.169.74.${i + 1}`,
      hits: i === 0 ? 336 : 259,
    })),
    ...over,
  });
}

/**
 * The real 13:00 hour on 2026-09-01, before the fix reached production:
 * 20,847 successful /user calls and 1,960 signature errors. THIS MUST PAGE.
 */
function outageWindow(over: Partial<AuthLogWindow> = {}): AuthLogWindow {
  return healthyWindow({
    total: 27275,
    userHits: 20847,
    signatureErrors: 1960,
    hs256Errors: 1778,
    signatureErrorsByIp: [{ remote_addr: '20.169.74.1', hits: 1960 }],
    ...over,
  });
}

// Real ES256/P-256 key material shape published by GoTrue. Public key only —
// there is nothing secret in a JWKS, that is the point of publishing it.
const ES256_KEY = {
  alg: 'ES256',
  crv: 'P-256',
  kty: 'EC',
  use: 'sig',
  kid: 'test-key-1',
  x: '7UwnCrqlNNDy5A8wIHK84kJv61VyqA6CWCME7-ubLLc',
  y: 'LPhFv4wOH2DoY67oF_OtL2Le0avfOHhXZe8s7bXOSZA',
};

describe('perHour', () => {
  it('normalises a partial window to an hourly rate', () => {
    expect(perHour(50, 30)).toBe(100);
    expect(perHour(50, 60)).toBe(50);
    expect(perHour(50, 120)).toBe(25);
  });

  it('returns the raw count for a nonsense window instead of dividing by zero', () => {
    expect(perHour(7, 0)).toBe(7);
  });
});

describe('thresholdsFromEnv', () => {
  it('falls back to defaults when unset', () => {
    expect(thresholdsFromEnv({})).toEqual(DEFAULT_THRESHOLDS);
  });

  it('honours overrides', () => {
    const t = thresholdsFromEnv({
      AUTH_MONITOR_GOTRUE_USER_PER_HOUR: '250',
      AUTH_MONITOR_ABUSE_PER_HOUR: '0',
    });
    expect(t.gotrueUserPerHour).toBe(250);
    expect(t.abusePerHour).toBe(0);
    expect(t.refreshFailuresPerHour).toBe(DEFAULT_THRESHOLDS.refreshFailuresPerHour);
  });

  it('ignores junk and negatives rather than disabling a check', () => {
    const t = thresholdsFromEnv({
      AUTH_MONITOR_GOTRUE_USER_PER_HOUR: 'banana',
      AUTH_MONITOR_REFRESH_FAILURES_PER_HOUR: '-5',
      AUTH_MONITOR_ABUSE_PER_HOUR: '',
    });
    expect(t).toEqual(DEFAULT_THRESHOLDS);
  });
});

describe('evaluateGoTrueFallback — the primary regression signal', () => {
  it('is ok on a healthy window', () => {
    const r = evaluateGoTrueFallback(healthyWindow(), DEFAULT_THRESHOLDS);
    expect(r.status).toBe('ok');
  });

  it('is ok at the real post-fix peak of 2,704/h — organic traffic must not page', () => {
    // 2026-09-01 14:00, the busiest hour after the fix landed. If this ever
    // goes critical the threshold is too tight and the monitor is crying wolf.
    const r = evaluateGoTrueFallback(
      healthyWindow({ total: 13647, userHits: 2704 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('ok');
  });

  it('goes critical at the real broken rate (20,847/h, 2026-09-01 13:00)', () => {
    const r = evaluateGoTrueFallback(outageWindow(), DEFAULT_THRESHOLDS);
    expect(r.status).toBe('critical');
    expect(r.observed).toBe(20847);
  });

  it('warns in the band between the healthy peak and outage scale', () => {
    // 5,000/h is ~1.8x the healthy peak but well under the 8,000/h cap:
    // partial degradation, worth a look, not worth an SMS.
    const r = evaluateGoTrueFallback(
      healthyWindow({ total: 20000, userHits: 5000 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('warn');
    expect(r.observed).toBe(5000);
  });

  it('warns on a bad ratio even when absolute volume is under the cap', () => {
    // 600/h is far below the cap, but 600/700 = 86% of all auth traffic is the
    // signature of a fast path that has stopped working on a low-traffic host.
    const r = evaluateGoTrueFallback(
      healthyWindow({ total: 700, userHits: 600 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('warn');
  });

  it('does not warn at the real healthy ratio peak of 0.513', () => {
    // 2026-09-01 16:00. The original 0.30 threshold would have warned here.
    const r = evaluateGoTrueFallback(
      healthyWindow({ total: 5135, userHits: 2632 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('ok');
  });

  it('does not fire on ratio alone for a tiny sample', () => {
    // 9 of 10 events being /user at 3am is noise, not an outage.
    const r = evaluateGoTrueFallback(
      healthyWindow({ total: 10, userHits: 9 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('ok');
  });

  it('scales a short window up before comparing', () => {
    // 2,500 hits in 15 minutes is 10,000/h — over the cap even though the raw
    // count is not.
    const r = evaluateGoTrueFallback(
      healthyWindow({ windowMinutes: 15, total: 3000, userHits: 2500 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('critical');
    expect(r.observed).toBe(10000);
  });
});

describe('evaluateSignatureErrors — must not page on third-party traffic', () => {
  it('is ok at zero', () => {
    expect(evaluateSignatureErrors(healthyWindow(), DEFAULT_THRESHOLDS).status).toBe('ok');
  });

  // ── THE FALSE-POSITIVE REGRESSION TEST ──────────────────────────────────
  it('does NOT go critical on an external signature-error burst with no app-origin volume', () => {
    // Real 2026-09-01 17:00: 4,325 signature errors / 4,020 of them HS256,
    // from 38 bot IPs, while our own fallback traffic sits at a healthy
    // 1,468/h. The previous implementation called this critical and would have
    // paged on every bot wave forever. It must not.
    const r = evaluateSignatureErrors(externalAttackWindow(), DEFAULT_THRESHOLDS);
    expect(r.status).toBe('ok');
    expect(r.data?.app_origin_elevated).toBe(false);
  });

  it('stays ok even when the external burst is enormous', () => {
    const r = evaluateSignatureErrors(
      externalAttackWindow({ signatureErrors: 250_000, hs256Errors: 250_000 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('ok');
  });

  it('stays ok for a single stray HS256 error — one forged token is not an outage', () => {
    const r = evaluateSignatureErrors(
      healthyWindow({ signatureErrors: 1, hs256Errors: 1 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('ok');
  });

  // ── THE TRUE-POSITIVE REGRESSION TEST ───────────────────────────────────
  it('DOES go critical when app-origin fallback volume is elevated alongside the errors', () => {
    // Real 2026-09-01 13:00: 1,960 signature errors against 20,847 successful
    // /user calls — ratio 0.094, and the app-origin gate is satisfied. Both
    // halves of the outage signature are present.
    const r = evaluateSignatureErrors(outageWindow(), DEFAULT_THRESHOLDS);
    expect(r.status).toBe('critical');
    expect(r.observed).toBeGreaterThan(DEFAULT_THRESHOLDS.signatureErrorAppRatio);
    expect(r.data?.app_origin_elevated).toBe(true);
  });

  it('warns when fallback volume is elevated but the errors do not explain it', () => {
    // Something is driving /user traffic up, but it is not an algorithm
    // mismatch — still worth surfacing, not worth an algorithm-specific page.
    const r = evaluateSignatureErrors(
      outageWindow({ signatureErrors: 5, hs256Errors: 0 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('warn');
  });
});

describe('evaluateSignatureErrorSource — security severity, never pages', () => {
  it('reports the bot wave at security severity with the top IPs for a WAF', () => {
    const r = evaluateSignatureErrorSource(externalAttackWindow(), DEFAULT_THRESHOLDS);
    expect(r.status).toBe('security');
    expect(r.data?.distinct_ips).toBe(38);
    const top = r.data?.top_ips as Array<{ remote_addr: string; hits: number }>;
    expect(top).toHaveLength(10);
    expect(top[0].hits).toBe(336);
  });

  it('is ok on background noise below the notice threshold', () => {
    const r = evaluateSignatureErrorSource(
      healthyWindow({ signatureErrors: 12, signatureErrorsByIp: [{ remote_addr: 'a', hits: 12 }] }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('ok');
  });

  it('never escalates the roll-up, however large the wave', () => {
    const notice = evaluateSignatureErrorSource(
      externalAttackWindow({ signatureErrors: 1_000_000 }),
      DEFAULT_THRESHOLDS,
    );
    const s = summarizeChecks([notice, { id: 'x', status: 'ok', message: '' }]);
    expect(s.status).toBe('ok');
    expect(s.problems).toHaveLength(0);
    expect(s.notices).toHaveLength(1);
  });
});

describe('evaluateRefreshFailures', () => {
  it('tolerates the confirmed post-fix baseline of zero', () => {
    // Live logs 15:00-18:00 on 2026-09-01: not-found 0, bad-length 59 -> 0.
    expect(evaluateRefreshFailures(healthyWindow(), DEFAULT_THRESHOLDS).status).toBe('ok');
    expect(
      evaluateRefreshFailures(
        healthyWindow({ refreshNotFound: 0, refreshLengthInvalid: 59 }),
        DEFAULT_THRESHOLDS,
      ).status,
    ).toBe('ok');
  });

  it('warns at the incident baseline (4,016 + 1,040 per 24h ~= 210/h)', () => {
    const r = evaluateRefreshFailures(
      healthyWindow({ refreshNotFound: 167, refreshLengthInvalid: 43 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('warn');
    expect(r.observed).toBe(210);
  });

  it('warns — but only warns — on the deploy-hour invalidation transient', () => {
    // Real 2026-09-01 14:00: 1,409 not-found + 53 bad-length as the fix landed
    // and invalidated stale sessions en masse. Warn is right; SMS is not.
    const r = evaluateRefreshFailures(
      healthyWindow({ refreshNotFound: 1409, refreshLengthInvalid: 53 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('warn');
  });

  it('sums both failure modes rather than checking them separately', () => {
    const r = evaluateRefreshFailures(
      healthyWindow({ refreshNotFound: 60, refreshLengthInvalid: 60 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('warn');
  });
});

describe('evaluateCredentialStuffing', () => {
  it('is ok on background noise', () => {
    expect(evaluateCredentialStuffing(healthyWindow(), DEFAULT_THRESHOLDS).status).toBe('ok');
  });

  it('warns on the incident pattern and carries the top IPs for a WAF blocklist', () => {
    const ips = Array.from({ length: 40 }, (_, i) => ({
      remote_addr: `20.169.74.${i + 1}`,
      hits: 20,
    }));
    const r = evaluateCredentialStuffing(
      healthyWindow({ abuseAttempts: 800, abuseByIp: ips }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('warn');
    const top = (r.data?.top_ips ?? []) as Array<{ remote_addr: string }>;
    expect(top).toHaveLength(10);
    expect(r.data?.distinct_ips).toBe(40);
  });

  it('does not see the HS256 replay wave — which is why that needs its own check', () => {
    // Real 2026-09-01 17:00: GoTrue logged 0 "Possible abuse attempt" while
    // 4,325 signature errors were landing, because the replays hit /user and
    // not /token. Folding the HS256 signal into this check would lose it.
    const r = evaluateCredentialStuffing(externalAttackWindow(), DEFAULT_THRESHOLDS);
    expect(r.status).toBe('ok');
    expect(evaluateSignatureErrorSource(externalAttackWindow(), DEFAULT_THRESHOLDS).status).toBe(
      'security',
    );
  });
});

describe('evaluateJwks', () => {
  it('is ok for an all-ES256 key set', () => {
    const r = evaluateJwks({ keys: [ES256_KEY, { ...ES256_KEY, kid: 'test-key-2' }] });
    expect(r.status).toBe('ok');
    expect(r.observed).toBe(2);
  });

  it('is critical when the endpoint is unreachable', () => {
    expect(evaluateJwks(null).status).toBe('critical');
  });

  it('is critical on an empty key set', () => {
    expect(evaluateJwks({ keys: [] }).status).toBe('critical');
  });

  it('is critical when the project stops serving ES256', () => {
    const r = evaluateJwks({ keys: [{ alg: 'RS256', kty: 'RSA', kid: 'r1' }] });
    expect(r.status).toBe('critical');
    expect(r.message).toContain('RS256');
  });

  it('warns mid-rotation when the set is mixed', () => {
    const r = evaluateJwks({ keys: [ES256_KEY, { alg: 'RS256', kty: 'RSA', kid: 'r1' }] });
    expect(r.status).toBe('warn');
  });

  it('rejects an ES256 label on the wrong curve', () => {
    const r = evaluateJwks({ keys: [{ ...ES256_KEY, crv: 'P-384' }] });
    expect(r.status).toBe('critical');
  });
});

describe('canaryImportJwks', () => {
  it('imports real ES256 key material as ECDSA P-256', async () => {
    const r = await canaryImportJwks({ keys: [ES256_KEY] });
    expect(r.status).toBe('ok');
    expect(r.observed).toBe(1);
  });

  it('goes critical when the key material is corrupt but structurally valid', async () => {
    // This is exactly the case evaluateJwks cannot see: alg/kty/crv all still
    // say ES256/EC/P-256, but the coordinates are truncated.
    const r = await canaryImportJwks({ keys: [{ ...ES256_KEY, x: 'AAAA', y: 'BBBB' }] });
    expect(r.status).toBe('critical');
  });

  it('warns when one key of several fails to import', async () => {
    const r = await canaryImportJwks({
      keys: [ES256_KEY, { ...ES256_KEY, kid: 'bad', x: 'AAAA', y: 'BBBB' }],
    });
    expect(r.status).toBe('warn');
  });

  it('is critical when there is nothing to import', async () => {
    expect((await canaryImportJwks({ keys: [] })).status).toBe('critical');
  });
});

describe('summarizeChecks', () => {
  it('is ok when everything is ok', () => {
    const s = summarizeChecks([
      { id: 'a', status: 'ok', message: '' },
      { id: 'b', status: 'ok', message: '' },
    ]);
    expect(s.status).toBe('ok');
    expect(s.problems).toHaveLength(0);
    expect(s.notices).toHaveLength(0);
  });

  it('takes the worst status, not the last one', () => {
    const s = summarizeChecks([
      { id: 'a', status: 'critical', message: 'boom' },
      { id: 'b', status: 'ok', message: '' },
      { id: 'c', status: 'warn', message: 'hmm' },
    ]);
    expect(s.status).toBe('critical');
    expect(s.problems).toHaveLength(2);
  });

  it('lets skipped checks degrade gracefully — they neither mask nor invent a verdict', () => {
    const s = summarizeChecks([
      { id: 'gated', status: 'skipped', message: 'no management token' },
      { id: 'jwks', status: 'ok', message: '' },
    ]);
    expect(s.status).toBe('ok');
    expect(s.problems).toHaveLength(0);
  });

  it('reports a problem when every check is skipped except a failing one', () => {
    const s = summarizeChecks([
      { id: 'gated', status: 'skipped', message: '' },
      { id: 'jwks', status: 'critical', message: 'no ES256' },
    ]);
    expect(s.status).toBe('critical');
  });

  it('routes security findings to notices, never to problems', () => {
    const s = summarizeChecks([
      { id: 'signature_error_sources', status: 'security', message: 'bot wave' },
      { id: 'jwks', status: 'ok', message: '' },
    ]);
    expect(s.status).toBe('ok');
    expect(s.problems).toHaveLength(0);
    expect(s.notices).toEqual(['[security] signature_error_sources: bot wave']);
  });

  it('does not let a security finding mask a real problem', () => {
    const s = summarizeChecks([
      { id: 'signature_error_sources', status: 'security', message: 'bot wave' },
      { id: 'gotrue_fallback_ratio', status: 'critical', message: '20847/h' },
    ]);
    expect(s.status).toBe('critical');
    expect(s.problems).toHaveLength(1);
    expect(s.notices).toHaveLength(1);
  });
});

describe('toCronHealthStatus', () => {
  it('maps onto the cron_health_log vocabulary', () => {
    expect(toCronHealthStatus('ok')).toBe('success');
    expect(toCronHealthStatus('skipped')).toBe('success');
    expect(toCronHealthStatus('security')).toBe('success');
    expect(toCronHealthStatus('warn')).toBe('error');
    expect(toCronHealthStatus('critical')).toBe('error');
  });
});
