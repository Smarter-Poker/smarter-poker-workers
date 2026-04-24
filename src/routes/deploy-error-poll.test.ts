import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deployErrorPoll } from './deploy-error-poll.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // No VERCEL_TOKEN configured → short-circuit to 500 error.
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
  it('short-circuits with 500 when VERCEL_TOKEN is missing', async () => {
    const ctx = makeCtx();
    await deployErrorPoll(ctx);
    const body = (ctx as any).captured.body as { error: string };
    expect((ctx as any).captured.status).toBe(500);
    expect(body.error).toContain('VERCEL_TOKEN');
  });
});
