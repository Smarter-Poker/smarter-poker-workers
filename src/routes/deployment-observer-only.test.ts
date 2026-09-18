import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { deployErrorPoll } from './deploy-error-poll.js';

const alerts = vi.hoisted(() => ({ record: vi.fn(), health: vi.fn() }));
vi.mock('../lib/deploymentMonitorHealth.js', () => ({ recordDeploymentMonitorHealth: alerts.health }));
vi.mock('../lib/operationalAlerts.js', async (original) => ({
  ...await original<typeof import('../lib/operationalAlerts.js')>(),
  recordOperationalAlert: alerts.record,
}));

beforeEach(() => {
  alerts.record.mockReset().mockResolvedValue('19');
  alerts.health.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('VERCEL_TOKEN', 'test-provider');
  vi.stubEnv('DEPLOY_INTERNAL_SECRET', 'test-retired-publisher');
  vi.stubEnv('GH_PAT', 'test-retired-github');
  vi.stubEnv('SUPABASE_URL', 'https://database.invalid');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-database');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('scheduled deployment observation has no release authority', () => {
  it.each(['GET', 'POST'])('reports a failed build without cancelling or repairing any build (%s)', async (method) => {
    const old = Date.now() - 60 * 60_000;
    const deployments = [
      { uid: 'preview-queued', state: 'QUEUED', createdAt: old, meta: { githubCommitRef: 'preview' } },
      { uid: 'main-building', state: 'BUILDING', createdAt: old + 1, meta: { githubCommitRef: 'main' } },
      { uid: 'main-error', state: 'ERROR', createdAt: old, meta: { githubCommitRef: 'main', githubCommitSha: 'abc123', githubCommitMessage: 'application change' } },
      { uid: 'main-queued-1', state: 'QUEUED', createdAt: old, meta: { githubCommitRef: 'main' } },
      { uid: 'main-queued-2', state: 'QUEUED', createdAt: old - 1, meta: { githubCommitRef: 'main' } },
    ];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') return new Response('{}', { status: 405 });
      const url = String(input);
      if (url.startsWith('https://api.vercel.com/v6/deployments?')) {
        return new Response(JSON.stringify({ deployments }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetch);
    const app = new Hono();
    app.on(['GET', 'POST'], '/cron/deploy-error-poll', deployErrorPoll);
    const response = await app.request('/cron/deploy-error-poll', { method });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: 'reported', deployId: 'main-error', releaseAction: 'none' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
    expect(alerts.record).toHaveBeenCalledWith(expect.objectContaining({
      source: 'workers.deploy-error-poll', alertname: 'VercelDeploymentFailed',
      status: 'firing', payload: expect.objectContaining({ deploymentId: 'main-error' }),
    }));
  });
});
