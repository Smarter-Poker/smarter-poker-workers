import { describe, it, expect, vi } from 'vitest';
import { unionRakeback } from './union-rakeback.js';

// No unions with rake = 0 distributions — exercises the short-circuit
vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (_table: string) => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {
        select: vi.fn(),
        gt: vi.fn(),
        in: vi.fn(),
        eq: vi.fn(),
        limit: vi.fn(),
        insert: vi.fn(),
      };
      c.select.mockReturnValue(c);
      c.gt.mockResolvedValue({ data: [], error: null });  // no unions with rake
      c.in.mockReturnValue(c);
      c.eq.mockReturnValue(c);
      c.limit.mockResolvedValue({ data: [], error: null });
      c.insert.mockResolvedValue({ data: null, error: null });
      return c;
    },
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
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
  } as unknown as Parameters<typeof unionRakeback>[0] & { readonly captured: { body: unknown; status: number } };
};

describe('GET/POST /cron/union-rakeback', () => {
  it('returns no-op message when no unions have rake balance', async () => {
    const ctx = makeCtx();
    await unionRakeback(ctx);
    const body = (ctx as any).captured.body as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('No unions with rake balance');
  });
});
