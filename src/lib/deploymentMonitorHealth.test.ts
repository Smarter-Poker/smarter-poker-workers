import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployErrorPoll } from '../routes/deploy-error-poll.js';
import { recordDeploymentMonitorHealth } from './deploymentMonitorHealth.js';
import { OperationalAlertDeliveryError } from './operationalAlerts.js';

const state = vi.hoisted(() => ({
  latest: undefined as undefined | { event_key: string; status: string },
  readError: null as null | { message: string },
  invalidReadData: undefined as unknown,
  rpc: vi.fn(),
}));
vi.mock('./supabase.js', () => ({ getSupabase: () => ({
  rpc: state.rpc,
  from: () => {
    const query = { select: () => query, eq: () => query, order: () => query,
      limit: async () => ({ data: state.invalidReadData === undefined ? (state.latest ? [state.latest] : []) : state.invalidReadData, error: state.readError }) };
    return query;
  },
}) }));

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('SUPABASE_URL', '');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  vi.stubEnv('VERCEL_TOKEN', '   configured-token   ');
  state.latest = undefined;
  state.readError = null;
  state.invalidReadData = undefined;
  state.rpc.mockReset().mockImplementation(async (_name: string, p: Record<string, string>) => {
    state.latest = { event_key: p.p_event_key, status: p.p_status };
    return { data: 1, error: null };
  });
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const context = () => ({ json: (body: unknown, status = 200) => ({ body, status }) });

describe('deployment credential health', () => {
  it('does not fabricate a recovery before an outage exists', async () => {
    await recordDeploymentMonitorHealth('resolved', { deploymentsRead: 5 });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('records one recovery and a distinct subsequent outage, even in the same hour', async () => {
    await recordDeploymentMonitorHealth('firing', { httpStatus: 403 });
    const first = state.latest?.event_key;
    await recordDeploymentMonitorHealth('firing', { httpStatus: 403 });
    expect(state.latest?.event_key).toBe(first);
    await recordDeploymentMonitorHealth('resolved', { deploymentsRead: 25 });
    const recovery = state.latest?.event_key;
    expect(recovery).not.toBe(first);
    expect(state.rpc.mock.calls[2][1]).toMatchObject({ p_status: 'resolved', p_alertname: 'DeploymentMonitorUnavailable' });
    await recordDeploymentMonitorHealth('resolved', { deploymentsRead: 25 });
    expect(state.rpc).toHaveBeenCalledTimes(3);
    await recordDeploymentMonitorHealth('firing', { httpStatus: 403 });
    expect(state.latest?.event_key).not.toBe(first);
    expect(state.latest?.event_key).not.toBe(recovery);
  });

  it('retains recovery retry identity when durable acknowledgement fails', async () => {
    state.latest = { event_key: 'original-outage', status: 'firing' };
    state.rpc.mockResolvedValueOnce({ data: null, error: { message: 'queue unavailable' } });
    await expect(recordDeploymentMonitorHealth('resolved', {})).rejects.toBeInstanceOf(OperationalAlertDeliveryError);
    const key = state.rpc.mock.calls[0][1].p_event_key;
    await recordDeploymentMonitorHealth('resolved', {});
    expect(state.rpc.mock.calls[1][1].p_event_key).toBe(key);
  });

  it('records recovery only after the real endpoint returns a valid deployment list', async () => {
    state.latest = { event_key: 'original-outage', status: 'firing' };
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ deployments: [] }) });
    vi.stubGlobal('fetch', fetch);
    expect(await deployErrorPoll(context() as never)).toMatchObject({ status: 200 });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer configured-token');
    expect(state.rpc.mock.calls[0][1]).toMatchObject({ p_status: 'resolved', p_payload: { deploymentsRead: 0 } });
  });

  it.each([{ wrong: 'shape' }, null, new SyntaxError('invalid JSON')])('does not clear an outage on a malformed successful HTTP response: %s', async (body) => {
    state.latest = { event_key: 'original-outage', status: 'firing' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => {
      if (body instanceof Error) throw body;
      return body;
    } }));
    expect(await deployErrorPoll(context() as never)).toMatchObject({ status: 502 });
    expect(state.rpc.mock.calls[0][1].p_status).toBe('firing');
    expect(state.latest.event_key).toBe('original-outage');
  });

  it('records a missing production credential instead of reporting a successful skip', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_TOKEN', '');
    expect(await deployErrorPoll(context() as never)).toMatchObject({ status: 503 });
    expect(state.rpc.mock.calls[0][1]).toMatchObject({ p_status: 'firing', p_payload: { summary: 'Deployment monitoring has no Vercel credential' } });
  });

  it('fails closed if the durable outage state cannot be read', async () => {
    state.readError = { message: 'read unavailable' };
    await expect(recordDeploymentMonitorHealth('resolved', {})).rejects.toBeInstanceOf(OperationalAlertDeliveryError);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([null, {}, [null], [{ event_key: 3, status: 'firing' }], [
    { event_key: 'one', status: 'firing' }, { event_key: 'two', status: 'resolved' },
  ]].map((data) => ({ data })))('retains the outage when the durable state response is malformed: $data', async ({ data }) => {
    state.latest = { event_key: 'original-outage', status: 'firing' };
    state.invalidReadData = data;
    await expect(recordDeploymentMonitorHealth('resolved', {})).rejects.toBeInstanceOf(OperationalAlertDeliveryError);
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.latest.status).toBe('firing');
  });
});
