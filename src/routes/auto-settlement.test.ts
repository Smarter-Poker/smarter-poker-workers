import { describe, it, expect, vi } from 'vitest';
import { autoSettlement } from './auto-settlement.js';

// Zero clubs with auto_settlement_enabled — exercises the no-op short-circuit.
vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (_table: string) => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {
        select: vi.fn(),
        eq: vi.fn(),
        limit: vi.fn(),
      };
      c.select.mockReturnValue(c);
      c.eq.mockReturnValue(c);
      c.limit.mockResolvedValue({ data: [], error: null });
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
  } as unknown as Parameters<typeof autoSettlement>[0] & { readonly captured: { body: unknown; status: number } };
};

describe('POST /cron/auto-settlement', () => {
  it('short-circuits when no auto-settlement-enabled clubs exist', async () => {
    const ctx = makeCtx();
    await autoSettlement(ctx);
    const body = (ctx as any).captured.body as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('No clubs with auto-settlement enabled');
  });
});
