import { describe, it, expect, vi } from 'vitest';
import { scraperDataCleanup } from './scraper-data-cleanup.js';

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (_table: string) => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {
        delete: vi.fn(),
        lt: vi.fn(),
        neq: vi.fn(),
        upsert: vi.fn(),
      };
      c.delete.mockReturnValue(c);
      c.lt.mockReturnValue(c);
      c.neq.mockResolvedValue({ data: null, count: 2, error: null });
      // For the 4 simple deleteOlderThan calls — .delete().lt() must resolve directly.
      // Make .lt() resolve after being called the first time per chain.
      let ltCallCount = 0;
      c.lt.mockImplementation(() => {
        ltCallCount++;
        // Last chain step — resolve
        return Promise.resolve({ data: null, count: 5, error: null });
      });
      c.upsert.mockResolvedValue({ data: null, error: null });
      return c;
    },
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
  } as unknown as Parameters<typeof scraperDataCleanup>[0] & { readonly captured: { body: unknown; status: number } };
};

describe('POST /cron/scraper-data-cleanup', () => {
  it('returns a per-table deletion report', async () => {
    const ctx = makeCtx();
    await scraperDataCleanup(ctx);
    const body = (ctx as any).captured.body as {
      cleaned_at: string;
      tables: Record<string, { deleted: number; error: string | null }>;
    };
    expect(body.cleaned_at).toBeTruthy();
    expect(body.tables).toHaveProperty('venue_live_history');
    expect(body.tables).toHaveProperty('scraper_metrics');
    expect(body.tables).toHaveProperty('game_live_history');
    expect(body.tables).toHaveProperty('venue_live_tables');
    expect(body.tables).toHaveProperty('scraper_watchdog_state');
    // Every table entry has the { deleted, error } shape
    for (const tbl of Object.values(body.tables)) {
      expect(typeof tbl.deleted).toBe('number');
      expect('error' in tbl).toBe(true);
    }
  });
});
