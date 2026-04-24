import { describe, it, expect, vi } from 'vitest';
import { videoLibraryBackfill } from './video-library-backfill.js';

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => {
    const makeChain = (table: string) => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {
        select: vi.fn(),
        or: vi.fn(),
        eq: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
        insert: vi.fn(),
      };
      c.select.mockReturnValue(c);
      c.or.mockResolvedValue({ data: null, count: 7, error: null });   // head=true returns just count
      c.eq.mockReturnValue(c);
      c.order.mockReturnValue(c);
      c.limit.mockResolvedValue({
        data: table === 'data_audit_log'
          ? [{ scrape_proof: '{"updated":5}', created_at: 't' }]
          : [],
        error: null,
      });
      c.insert.mockResolvedValue({ data: null, error: null });
      return c;
    };
    return { from: (table: string) => makeChain(table) };
  },
}));

const makeCtx = (opts: { method?: string; query?: Record<string, string>; body?: unknown } = {}) => {
  let captured: { body?: unknown; status?: number } = {};
  return {
    req: {
      method: opts.method ?? 'GET',
      query: (k: string) => opts.query?.[k],
      json: async () => opts.body ?? {},
    },
    json: (body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return captured;
    },
    get captured() { return captured; },
  } as unknown as Parameters<typeof videoLibraryBackfill>[0] & { readonly captured: { body: unknown; status: number } };
};

describe('GET /cron/video-library-backfill', () => {
  it('returns status payload with needs_backfill count', async () => {
    const ctx = makeCtx({ method: 'GET' });
    await videoLibraryBackfill(ctx);
    const body = (ctx as any).captured.body as { success: boolean; needs_backfill: number; last_backfills: unknown[] };
    expect(body.success).toBe(true);
    expect(body.needs_backfill).toBe(7);
    expect(Array.isArray(body.last_backfills)).toBe(true);
  });
});

describe('POST /cron/video-library-backfill?report=1', () => {
  it('accepts a backfill report and returns success', async () => {
    const ctx = makeCtx({ method: 'POST', query: { report: '1' }, body: { updated: 3, failed: 1 } });
    await videoLibraryBackfill(ctx);
    const body = (ctx as any).captured.body as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('Backfill');
  });
});
