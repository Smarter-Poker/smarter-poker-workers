import { describe, it, expect, vi } from 'vitest';
import { purgeIdempotencyKeys } from './purge-idempotency-keys.js';

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    rpc: vi.fn().mockResolvedValue({ data: 42, error: null }),
  }),
}));

const makeCtx = () => {
  let captured: { body?: unknown; status?: number } = {};
  return {
    json: (body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return captured;
    },
    get captured() { return captured; },
  } as unknown as Parameters<typeof purgeIdempotencyKeys>[0] & { readonly captured: { body: unknown; status: number } };
};

describe('GET/POST /cron/purge-idempotency-keys', () => {
  it('returns deleted count from purge_idempotency_keys RPC', async () => {
    const ctx = makeCtx();
    await purgeIdempotencyKeys(ctx);
    const body = (ctx as any).captured.body as { ok: boolean; deleted: number };
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(42);
  });
});
