import { describe, it, expect, vi } from 'vitest';
import { autoSettlement } from './auto-settlement.js';

// Zero clubs with auto_settlement_enabled - exercises the no-op short-circuit.
// Every read returns no rows, so the alert phase, which still runs on this
// path, finds nothing to record.
vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (_table: string) => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {
        select: vi.fn(),
        eq: vi.fn(),
        in: vi.fn(),
        not: vi.fn(),
        or: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
      };
      for (const chained of ['select', 'eq', 'in', 'not', 'or', 'order'] as const) c[chained].mockReturnValue(c);
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
    const { body, status } = (ctx as any).captured as {
      body: { success: boolean; message: string; results: { operational_alerts?: unknown[]; errors: unknown[] } };
      status: number;
    };
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.message).toContain('No clubs with auto-settlement enabled');
    // The alert phase ran, and found nothing.
    expect(body.results.operational_alerts).toEqual([]);
    expect(body.results.errors).toEqual([]);
  });
});
