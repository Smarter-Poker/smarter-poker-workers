import { describe, it, expect, vi } from 'vitest';
import { autoSettlementDistribute } from './auto-settlement-distribute.js';

// No pending distributions — exercises the no_distributions short-circuit,
// but also touches Phase 2 (unfreeze locks + announce) which we want to verify.
vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {
        select: vi.fn(),
        eq: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
        update: vi.fn(),
        insert: vi.fn(),
        maybeSingle: vi.fn(),
      };
      c.select.mockReturnValue(c);
      c.eq.mockReturnValue(c);
      c.order.mockReturnValue(c);
      c.maybeSingle.mockResolvedValue({ data: null, error: null });
      if (table === 'rakeback_distributions') {
        c.limit.mockResolvedValue({ data: [], error: null });  // no pending
      } else if (table === 'settlement_locks') {
        c.limit.mockResolvedValue({ data: [], error: null });  // no active locks
      } else if (table === 'clubs') {
        // .eq('auto_settlement_enabled', true) without limit — different terminator
        const eqResult = vi.fn().mockResolvedValue({ data: [], error: null });
        c.eq = eqResult as unknown as ReturnType<typeof vi.fn>;
      }
      // .update().eq() chain → resolves
      const updEq = vi.fn().mockResolvedValue({ data: null, error: null });
      c.update.mockReturnValue({ eq: updEq });
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
  } as unknown as Parameters<typeof autoSettlementDistribute>[0] & { readonly captured: { body: unknown; status: number } };
};

describe('POST /cron/auto-settlement-distribute', () => {
  it('short-circuits cleanly when no pending distributions', async () => {
    const ctx = makeCtx();
    await autoSettlementDistribute(ctx);
    const body = (ctx as any).captured.body as {
      success: boolean;
      results: { phase: string; distributions_processed: number; clubs_unfrozen: number };
    };
    expect(body.success).toBe(true);
    expect(body.results.phase).toBe('complete');
    expect(body.results.distributions_processed).toBe(0);
    expect(body.results.clubs_unfrozen).toBe(0);
  });
});
