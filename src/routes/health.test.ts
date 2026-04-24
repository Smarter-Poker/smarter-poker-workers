import { describe, it, expect } from 'vitest';
import { health } from './health.js';

// Minimal Hono Context stub — just enough for health() to call c.json()
const makeCtx = () => {
  let captured: unknown = null;
  return {
    json: (body: unknown) => {
      captured = body;
      return { body, status: 200 };
    },
    get captured() { return captured; },
  } as unknown as Parameters<typeof health>[0] & { readonly captured: unknown };
};

describe('GET /health', () => {
  it('returns status ok with expected fields', async () => {
    const ctx = makeCtx();
    await health(ctx);
    const body = (ctx as any).captured as {
      status: string; service: string; uptime_s: number; memory: { heapUsedMB: number };
    };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('smarter-poker-workers');
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);
    expect(body.memory.heapUsedMB).toBeGreaterThan(0);
  });
});
