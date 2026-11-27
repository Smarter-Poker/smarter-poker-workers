import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { deployErrorPoll } from './deploy-error-poll.js';

const alerts = vi.hoisted(() => ({
  record: vi.fn(),
  health: vi.fn(),
  resolveOpen: vi.fn(),
}));
vi.mock('../lib/deploymentMonitorHealth.js', () => ({ recordDeploymentMonitorHealth: alerts.health }));
vi.mock('../lib/operationalAlertResolution.js', () => ({ resolveOpenOperationalAlerts: alerts.resolveOpen }));
vi.mock('../lib/operationalAlerts.js', async (original) => ({
  ...await original<typeof import('../lib/operationalAlerts.js')>(),
  recordOperationalAlert: alerts.record,
}));

beforeEach(() => {
  alerts.record.mockReset().mockResolvedValue('19');
  alerts.health.mockReset().mockResolvedValue(undefined);
  alerts.resolveOpen.mockReset().mockResolvedValue({ resolvedKeys: [], receipts: [], skippedAlreadyResolved: 0 });
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

  it('does not re-report a superseded main failure while a newer main build is in progress', async () => {
    const old = Date.now() - 3 * 24 * 60 * 60_000;
    const deployments = [
      { uid: 'main-building', state: 'BUILDING', createdAt: Date.now(), meta: { githubCommitRef: 'main' } },
      { uid: 'main-ready', state: 'READY', createdAt: Date.now() - 60_000, meta: { githubCommitRef: 'main', githubCommitSha: 'def456789' } },
      { uid: 'main-canceled', state: 'CANCELED', createdAt: old + 1, meta: { githubCommitRef: 'main' } },
      { uid: 'main-error', state: 'ERROR', createdAt: old, meta: { githubCommitRef: 'main', githubCommitSha: 'abc123', githubCommitMessage: 'application change' } },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ deployments }), { status: 200 })));
    const app = new Hono();
    app.get('/cron/deploy-error-poll', deployErrorPoll);
    const response = await app.request('/cron/deploy-error-poll');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: 'ok', latestSha: 'def456789' });
    expect(alerts.record).not.toHaveBeenCalled();
  });

  it('reports a BLOCKED newest settled main deployment with rich diagnostic metadata while staying strictly read-only', async () => {
    const now = Date.now();
    const deployments = [
      { uid: 'main-queued', state: 'QUEUED', createdAt: now, meta: { githubCommitRef: 'main' } },
      {
        uid: 'dpl_blocked_001',
        state: 'BLOCKED',
        createdAt: now - 30_000,
        url: 'hub-vanguard-blocked.vercel.app',
        inspectorUrl: 'https://vercel.com/smarter-poker/hub-vanguard/dpl_blocked_001',
        errorCode: 'DEPLOYMENT_BLOCKED',
        errorMessage: 'Deployment was blocked by Vercel policy check',
        meta: {
          githubCommitRef: 'main',
          githubCommitSha: 'deadbeef1234567890',
          githubCommitMessage: 'fix: update routing rules',
        },
      },
      { uid: 'dpl_prev_ready', state: 'READY', createdAt: now - 120_000, meta: { githubCommitRef: 'main', githubCommitSha: 'oldready999' } },
    ];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') return new Response('{}', { status: 405 });
      return new Response(JSON.stringify({ deployments }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);

    const app = new Hono();
    app.get('/cron/deploy-error-poll', deployErrorPoll);
    const response = await app.request('/cron/deploy-error-poll');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      action: 'reported',
      deployId: 'dpl_blocked_001',
      deploymentState: 'BLOCKED',
      commitSha: 'deadbeef1234567890',
      releaseAction: 'none',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.method ?? 'GET').toBe('GET');

    expect(alerts.record).toHaveBeenCalledTimes(1);
    const recorded = alerts.record.mock.calls[0][0];
    expect(recorded).toMatchObject({
      source: 'workers.deploy-error-poll',
      alertname: 'VercelDeploymentFailed',
      status: 'firing',
      severity: 'critical',
      payload: {
        deploymentId: 'dpl_blocked_001',
        deploymentState: 'BLOCKED',
        errorCode: 'DEPLOYMENT_BLOCKED',
        errorMessage: 'Deployment was blocked by Vercel policy check',
        inspectorUrl: 'https://vercel.com/smarter-poker/hub-vanguard/dpl_blocked_001',
        url: 'hub-vanguard-blocked.vercel.app',
        commitSha: 'deadbeef1234567890',
        commitMessage: 'fix: update routing rules',
      },
    });
    const msg = String(recorded.payload.message);
    expect(msg).toContain('dpl_blocked_001');
    expect(msg).toContain('BLOCKED');
    expect(msg).toContain('DEPLOYMENT_BLOCKED');
    expect(msg).toContain('Deployment was blocked by Vercel policy check');
    expect(msg).toContain('https://vercel.com/smarter-poker/hub-vanguard/dpl_blocked_001');
    expect(msg).toContain('deadbeef1234567890');
  });

  it('never resurrects an older BLOCKED deploy when QUEUED/BUILDING/CANCELED follows a newer READY deploy', async () => {
    const now = Date.now();
    for (const unsettled of ['QUEUED', 'BUILDING', 'CANCELED']) {
      alerts.record.mockClear();
      const deployments = [
        { uid: `main-${unsettled.toLowerCase()}`, state: unsettled, createdAt: now, meta: { githubCommitRef: 'main' } },
        { uid: 'dpl_ready_new', state: 'READY', createdAt: now - 60_000, meta: { githubCommitRef: 'main', githubCommitSha: 'good12345678' } },
        { uid: 'dpl_blocked_old', state: 'BLOCKED', createdAt: now - 300_000, meta: { githubCommitRef: 'main', githubCommitSha: 'bad000000000' } },
      ];
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ deployments }), { status: 200 })));
      const app = new Hono();
      app.get('/cron/deploy-error-poll', deployErrorPoll);
      const response = await app.request('/cron/deploy-error-poll');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ action: 'ok', latestSha: 'good12345' });
      expect(alerts.record).not.toHaveBeenCalled();
    }
  });

  it('sanitizes secrets from diagnostic fields and handles missing/non-string fields without crashing', async () => {
    vi.stubEnv('VERCEL_TOKEN', 'vcp_SuperSecretVercelToken123456789');
    const now = Date.now();
    const leakedToken = 'vcp_SuperSecretVercelToken123456789';
    const leakedGh = 'ghp_1234567890abcdef1234567890abcdef1234';
    const leakedJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signaturePayloadValue12345';

    // Case 1: secret-bearing fields + sensitive query params & userinfo in inspectorUrl
    const secretDeployments = [
      {
        uid: 'dpl_secret_test',
        state: 'ERROR',
        createdAt: now,
        url: 'hub-vanguard-123.vercel.app',
        inspectorUrl: `https://admin:hunter2@vercel.com/smarter-poker/hub-vanguard/dpl_secret_test?token=${leakedToken}&view=logs`,
        errorCode: 'BUILD_FAILED',
        errorMessage: `Failed with Authorization: Bearer ${leakedJwt} and ${leakedGh} and token=${leakedToken}`,
        meta: {
          githubCommitRef: 'main',
          githubCommitSha: 'cafebabe9876543210',
          githubCommitMessage: `deploy fix api_key=my_secret_key_value_999`,
        },
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ deployments: secretDeployments }), { status: 200 })));
    const app = new Hono();
    app.get('/cron/deploy-error-poll', deployErrorPoll);
    const res1 = await app.request('/cron/deploy-error-poll');
    expect(res1.status).toBe(200);

    const payload1 = alerts.record.mock.calls[0][0].payload as Record<string, unknown>;
    const serialized1 = JSON.stringify(payload1);
    expect(serialized1).not.toContain(leakedToken);
    expect(serialized1).not.toContain(leakedGh);
    expect(serialized1).not.toContain(leakedJwt);
    expect(serialized1).not.toContain('hunter2');
    expect(serialized1).not.toContain('my_secret_key_value_999');
    expect(payload1.inspectorUrl).toBe('https://vercel.com/smarter-poker/hub-vanguard/dpl_secret_test?view=logs');
    expect(payload1.errorCode).toBe('BUILD_FAILED');
    expect(payload1.commitSha).toBe('cafebabe9876543210');

    // Case 2: missing, null, non-string, and unsafe URL scheme fields must not crash
    alerts.record.mockClear();
    const malformedDeployments = [
      {
        uid: 'dpl_malformed',
        state: 'BLOCKED',
        createdAt: now,
        url: { nested: 'not-a-string' },
        inspectorUrl: 'javascript:alert(1)',
        errorCode: 500,
        errorMessage: ['array', 'not', 'string'],
        meta: {
          githubCommitRef: 'main',
          githubCommitSha: 123456789,
          githubCommitMessage: { text: '[autofix]' },
        },
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ deployments: malformedDeployments }), { status: 200 })));
    const res2 = await app.request('/cron/deploy-error-poll');
    expect(res2.status).toBe(200);
    expect(alerts.record).toHaveBeenCalledTimes(1);
    const payload2 = alerts.record.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload2).toMatchObject({
      deploymentId: 'dpl_malformed',
      deploymentState: 'BLOCKED',
      errorCode: null,
      errorMessage: null,
      inspectorUrl: null,
      url: null,
      commitSha: null,
      commitMessage: null,
    });
    expect(String(payload2.message)).toContain('dpl_malformed');
    expect(String(payload2.message)).toContain('BLOCKED');
    expect(String(payload2.message)).not.toContain('javascript:');
  });
});
