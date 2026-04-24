import { describe, it, expect, vi } from 'vitest';
import { videoLibraryScraper } from './video-library-scraper.js';

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {
        select: vi.fn(),
        eq: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
        insert: vi.fn(),
      };
      c.select.mockImplementation((_cols: string, opts?: { head?: boolean }) => {
        if (opts?.head) return Promise.resolve({ count: 42, data: null, error: null });
        // non-head select — chainable
        return c;
      });
      c.eq.mockReturnValue(c);
      c.order.mockReturnValue(c);
      if (table === 'data_audit_log') {
        c.limit.mockResolvedValue({ data: [{ scrape_proof: '{"total_found":100}', created_at: 'now' }], error: null });
      }
      c.insert.mockResolvedValue({ data: null, error: null });
      return c;
    },
  }),
}));

const makeCtx = (opts: { method?: string; query?: Record<string, string> } = {}) => {
  let captured: { body?: unknown; status?: number } = {};
  return {
    req: {
      method: opts.method ?? 'GET',
      query: (k: string) => opts.query?.[k],
      json: async () => ({}),
    },
    json: (body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return captured;
    },
    get captured() { return captured; },
  } as unknown as Parameters<typeof videoLibraryScraper>[0] & { readonly captured: { body: unknown; status: number } };
};

describe('GET /cron/video-library-scraper', () => {
  it('returns status payload with total_videos', async () => {
    const ctx = makeCtx({ method: 'GET' });
    await videoLibraryScraper(ctx);
    const body = (ctx as any).captured.body as { success: boolean; total_videos: number };
    expect(body.success).toBe(true);
    expect(body.total_videos).toBe(42);
  });
});
