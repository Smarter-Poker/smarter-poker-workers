/**
 * Threshold + evaluation tests for the auth-health monitor.
 *
 * Pure functions over sample inputs. No network, no database, no credential —
 * every number below is either a synthetic edge case or a real figure taken
 * from the incident window, so the file doubles as the documented baseline.
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
    ...over,
  };
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

describe('evaluateGoTrueFallback', () => {
  it('is ok on a healthy window', () => {
    const r = evaluateGoTrueFallback(healthyWindow(), DEFAULT_THRESHOLDS);
    expect(r.status).toBe('ok');
  });

  it('goes critical at the observed outage rate (~20k /user per hour)', () => {
    const r = evaluateGoTrueFallback(
      healthyWindow({ total: 21000, userHits: 20000 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('critical');
    expect(r.observed).toBe(20000);
  });

  it('warns on a bad ratio even when absolute volume is under the cap', () => {
    // 600/h is below the 1000/h cap, but 600/700 = 86% of all auth traffic is
    // the signature of a fast path that has stopped working.
    const r = evaluateGoTrueFallback(
      healthyWindow({ total: 700, userHits: 600 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('warn');
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
    // 600 hits in 15 minutes is 2400/h — over the cap even though the raw
    // count is not.
    const r = evaluateGoTrueFallback(
      healthyWindow({ windowMinutes: 15, total: 700, userHits: 600 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('critical');
    expect(r.observed).toBe(2400);
  });
});

describe('evaluateSignatureErrors', () => {
  it('is ok at zero', () => {
    expect(evaluateSignatureErrors(healthyWindow(), DEFAULT_THRESHOLDS).status).toBe('ok');
  });

  it('goes critical on a SINGLE HS256 error', () => {
    const r = evaluateSignatureErrors(
      healthyWindow({ signatureErrors: 1, hs256Errors: 1 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('critical');
    expect(r.message).toContain('HS256');
  });

  it('goes critical on a generic signature error with no HS256 in it', () => {
    const r = evaluateSignatureErrors(
      healthyWindow({ signatureErrors: 4, hs256Errors: 0 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('critical');
  });

  it('still reports HS256 as critical even if the threshold is raised', () => {
    // Raising the numeric threshold must not silence the exact regression.
    const r = evaluateSignatureErrors(
      healthyWindow({ signatureErrors: 5, hs256Errors: 5 }),
      { ...DEFAULT_THRESHOLDS, signatureErrorsPerHour: 10_000 },
    );
    expect(r.status).toBe('critical');
  });
});

describe('evaluateRefreshFailures', () => {
  it('tolerates the near-zero post-incident baseline', () => {
    expect(evaluateRefreshFailures(healthyWindow(), DEFAULT_THRESHOLDS).status).toBe('ok');
  });

  it('warns at the incident baseline (4,016 + 1,040 per 24h ≈ 210/h)', () => {
    const r = evaluateRefreshFailures(
      healthyWindow({ refreshNotFound: 167, refreshLengthInvalid: 43 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.status).toBe('warn');
    expect(r.observed).toBe(210);
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

  it('sorts offenders by hit count, worst first', () => {
    const r = evaluateCredentialStuffing(
      healthyWindow({
        abuseAttempts: 900,
        abuseByIp: [
          { remote_addr: 'a', hits: 10 },
          { remote_addr: 'b', hits: 890 },
        ],
      }),
      DEFAULT_THRESHOLDS,
    );
    const top = r.data?.top_ips as Array<{ remote_addr: string }>;
    expect(top[0].remote_addr).toBe('b');
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
});

describe('toCronHealthStatus', () => {
  it('maps onto the cron_health_log vocabulary', () => {
    expect(toCronHealthStatus('ok')).toBe('success');
    expect(toCronHealthStatus('skipped')).toBe('success');
    expect(toCronHealthStatus('warn')).toBe('error');
    expect(toCronHealthStatus('critical')).toBe('error');
  });
});
