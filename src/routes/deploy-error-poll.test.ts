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
