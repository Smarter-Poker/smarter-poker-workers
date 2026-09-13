import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { scraperWatchdog } from './scraper-watchdog.js';
import { deployErrorPoll } from './deploy-error-poll.js';

const state = vi.hoisted(() => ({
  rpc: vi.fn(), upsert: vi.fn(), alertState: null as null | Record<string, unknown>,
  fresh: false,
}));
vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    rpc: state.rpc,
    from: (table: string) => {
      let key: string | undefined;
      const chain = {
        select: () => chain,
        eq: (_field: string, value: string) => { key = value; return chain; },
        order: () => chain,
        limit: async () => table === 'operational_alert_events' ? { data: [], error: null } : ({ data: [{ scrape_timestamp: new Date(Date.now() - (state.fresh ? 0 : 90 * 60_000)).toISOString() }], count: 500, error: null }),
        maybeSingle: async () => ({ data: key === 'pokeratlas_last_alert' && state.alertState ? { value: JSON.stringify(state.alertState) } : null, error: null }),
        upsert: async (row: { key: string; value: string }) => {
          state.upsert(table, row);
          if (row.key === 'pokeratlas_last_alert') state.alertState = JSON.parse(row.value);
          return { data: null, error: null };
        },
      };
      return chain;
    },
  }),
}));

const ctx = () => ({ json: (body: unknown, status = 200) => ({ body, status }) });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T16:00:00Z'));
  state.rpc.mockReset().mockResolvedValue({ data: 19, error: null });
  state.upsert.mockReset();
  state.alertState = null;
  state.fresh = false;
  vi.stubEnv('SUPABASE_URL', '');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  vi.stubEnv('VERCEL_TOKEN', 'test-vercel');
  vi.stubEnv('GITHUB_TOKEN', '');
  vi.stubEnv('GITHUB_PAT', '');
  vi.stubEnv('GH_PAT', '');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected external request')));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('operational senders no longer contact a phone', () => {
  it('records a dead scraper and its recovery; no Twilio or push request occurs', async () => {
    const result = await scraperWatchdog(ctx() as never);
    expect(result).toMatchObject({ status: 200, body: { alerts_sent: [{ type: 'operational_inbox', receipt: '19' }] } });
    expect(state.rpc.mock.calls[0][1]).toMatchObject({ p_source: 'workers.scraper-watchdog', p_status: 'firing' });
    state.fresh = true;
    const recovery = await scraperWatchdog(ctx() as never);
    expect(recovery).toMatchObject({ status: 200, body: { resolved: [{ type: 'operational_inbox' }] } });
    expect(state.rpc.mock.calls[1][1]).toMatchObject({ p_status: 'resolved', p_alertname: 'ScraperDead' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('records a new incident after recovery even inside the old cooldown', async () => {
    await scraperWatchdog(ctx() as never);
    const firstKey = state.rpc.mock.calls[0][1].p_event_key;
    state.fresh = true;
    await scraperWatchdog(ctx() as never);
    vi.advanceTimersByTime(60_000);
    state.fresh = false;
    const next = await scraperWatchdog(ctx() as never);
    expect(next).toMatchObject({ status: 200, body: { alerts_sent: [{ type: 'operational_inbox' }] } });
    expect(state.rpc.mock.calls[2][1].p_event_key).not.toBe(firstKey);
  });

  it('returns retryable failure without advancing scraper cooldown, then records the same event on retry', async () => {
    state.rpc.mockResolvedValueOnce({ data: null, error: { message: 'queue unavailable' } });
    expect(await scraperWatchdog(ctx() as never)).toMatchObject({ status: 503 });
    expect(state.alertState).toBeNull();
    const failedKey = state.rpc.mock.calls[0][1].p_event_key;
    expect(await scraperWatchdog(ctx() as never)).toMatchObject({ status: 200 });
    expect(state.rpc.mock.calls[1][1].p_event_key).toBe(failedKey);
    expect(state.alertState).toMatchObject({ was_alerting: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains a recovery until its durable receipt arrives', async () => {
    state.alertState = { last_alert_ms: Date.now() - 90 * 60_000, was_alerting: true, last_severity: 'dead' };
    state.fresh = true;
    state.rpc.mockResolvedValueOnce({ data: null, error: { message: 'queue unavailable' } });
    expect(await scraperWatchdog(ctx() as never)).toMatchObject({ status: 503 });
    expect(state.alertState.was_alerting).toBe(true);
    const failedKey = state.rpc.mock.calls[0][1].p_event_key;
    expect(await scraperWatchdog(ctx() as never)).toMatchObject({ status: 200 });
    expect(state.rpc.mock.calls[1][1].p_event_key).toBe(failedKey);
    expect(state.alertState.was_alerting).toBe(false);
  });

  it('records the real Vercel authentication failure before returning the failed poll', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403, text: async () => '{"error":{"code":"invalidToken"}}' } as Response);
    expect(await deployErrorPoll(ctx() as never)).toMatchObject({ status: 500 });
    expect(state.rpc.mock.calls[0][1]).toMatchObject({
      p_alertname: 'DeploymentMonitorUnavailable', p_severity: 'critical',
      p_payload: { summary: 'Deployment monitoring cannot read Vercel (HTTP 403)' },
    });
  });

  it('does not dedup an autofix failure before its inbox receipt succeeds', async () => {
    const deployments = { deployments: [{ uid: 'deployment-alert-retry', state: 'ERROR', createdAt: Date.now(), meta: { githubCommitRef: 'main', githubCommitSha: '123456789abcdef', githubCommitMessage: '[autofix] regression test' } }] };
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => deployments } as Response);
    state.rpc.mockResolvedValueOnce({ data: 19, error: null }).mockResolvedValueOnce({ data: null, error: { message: 'queue unavailable' } });
    expect(await deployErrorPoll(ctx() as never)).toMatchObject({ status: 503 });
    const failedKey = state.rpc.mock.calls[1][1].p_event_key;
    expect(await deployErrorPoll(ctx() as never)).toMatchObject({ status: 200 });
    expect(state.rpc.mock.calls[3][1].p_event_key).toBe(failedKey);
    expect(state.rpc.mock.calls[3][1].p_alertname).toBe('AutofixRebuildFailed');
    for (const [url] of vi.mocked(fetch).mock.calls) expect(String(url)).toContain('api.vercel.com');
  });
});
