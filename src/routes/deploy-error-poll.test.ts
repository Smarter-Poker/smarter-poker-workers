import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deployErrorPoll } from './deploy-error-poll.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // No VERCEL_TOKEN configured → graceful no-op (200), not a 500.
  // Exercises the early-return path without hitting Vercel API.
  delete process.env.VERCEL_TOKEN;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const makeCtx = () => {
  let captured: { body?: unknown; status?: number } = {};
  return {
    json: (body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return captured;
    },
    get captured() { return captured; },
  } as unknown as Parameters<typeof deployErrorPoll>[0] & { readonly captured: { body: unknown; status: number } };
};

describe('GET/POST /cron/deploy-error-poll', () => {
  it('short-circuits with 200 no-op when VERCEL_TOKEN is missing', async () => {
    const ctx = makeCtx();
    await deployErrorPoll(ctx);
    const body = (ctx as any).captured.body as { action: string; message: string };
    expect((ctx as any).captured.status).toBe(200);
    expect(body.action).toBe('skipped');
    expect(body.message).toContain('VERCEL_TOKEN');
  });
});

describe('readVercelDeployments: one slow answer is not an outage', () => {
  const ok = () => new Response(JSON.stringify({ deployments: [] }), { status: 200 });
  const noSleep = async () => {};

  it('retries a timeout and returns the next clean read', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return ok();
    }) as typeof fetch;
    const { readVercelDeployments } = await import('./deploy-error-poll.js');
    const res = await readVercelDeployments('token', { fetchImpl, sleep: noSleep });
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('retries 429 and 5xx, but returns a 401 at once', async () => {
    const { readVercelDeployments } = await import('./deploy-error-poll.js');
    let calls = 0;
    const flaky = (async () => { calls += 1; return calls < 3 ? new Response('busy', { status: calls === 1 ? 429 : 503 }) : ok(); }) as typeof fetch;
    expect((await readVercelDeployments('token', { fetchImpl: flaky, sleep: noSleep })).ok).toBe(true);
    expect(calls).toBe(3);
    let denied = 0;
    const unauthorized = (async () => { denied += 1; return new Response('no', { status: 401 }); }) as typeof fetch;
    expect((await readVercelDeployments('token', { fetchImpl: unauthorized, sleep: noSleep })).status).toBe(401);
    expect(denied).toBe(1);
  });

  it('throws only after every attempt failed to answer', async () => {
    const { readVercelDeployments, VERCEL_READ_ATTEMPTS } = await import('./deploy-error-poll.js');
    let calls = 0;
    const down = (async () => { calls += 1; throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }) as typeof fetch;
    await expect(readVercelDeployments('token', { fetchImpl: down, sleep: noSleep })).rejects.toThrow('aborted');
    expect(calls).toBe(VERCEL_READ_ATTEMPTS);
  });
});

describe('extractDeploymentDiagnostics and formatDeployFailureMessage', () => {
  it('falls back to sanitized url when inspectorUrl is missing and bounds oversized error messages', async () => {
    const { extractDeploymentDiagnostics, formatDeployFailureMessage } = await import('./deploy-error-poll.js');
    const diagnostics = extractDeploymentDiagnostics({
      uid: 'dpl_url_fallback',
      state: 'BLOCKED',
      createdAt: Date.now(),
      url: 'hub-vanguard-fallback.vercel.app?token=should-strip&env=prod',
      inspectorUrl: null,
      errorCode: 'DEPLOYMENT_BLOCKED',
      errorMessage: 'X'.repeat(1500),
      meta: { githubCommitRef: 'main' },
    });
    expect(diagnostics.deploymentState).toBe('BLOCKED');
    expect(diagnostics.inspectorUrl).toBeNull();
    expect(diagnostics.url).toBe('hub-vanguard-fallback.vercel.app?env=prod');
    expect(diagnostics.errorMessage?.length).toBe(1000);
    expect(diagnostics.commitSha).toBeNull();
    expect(diagnostics.commitMessage).toBeNull();

    const message = formatDeployFailureMessage('dpl_url_fallback', diagnostics);
    expect(message).toContain('Deployment dpl_url_fallback settled as BLOCKED.');
    expect(message).toContain('Error [DEPLOYMENT_BLOCKED]:');
    expect(message).toContain('URL: hub-vanguard-fallback.vercel.app?env=prod');
    expect(message).not.toContain('should-strip');
  });

  it('formats cleanly when only errorCode or only errorMessage is present', async () => {
    const { formatDeployFailureMessage } = await import('./deploy-error-poll.js');
    const codeOnly = formatDeployFailureMessage('dpl_1', {
      deploymentState: 'ERROR',
      errorCode: 'BUILD_FAILED',
      errorMessage: null,
      inspectorUrl: null,
      url: null,
      commitSha: null,
      commitMessage: null,
    });
    expect(codeOnly).toBe('Deployment dpl_1 settled as ERROR. Error [BUILD_FAILED].');

    const msgOnly = formatDeployFailureMessage('dpl_2', {
      deploymentState: 'ERROR',
      errorCode: null,
      errorMessage: 'Module not found.\n',
      inspectorUrl: null,
      url: null,
      commitSha: 'abc1234',
      commitMessage: null,
    });
    expect(msgOnly).toBe('Deployment dpl_2 settled as ERROR for commit abc1234. Error: Module not found.');
  });
});
