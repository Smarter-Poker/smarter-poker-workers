import { describe, it, expect, vi } from 'vitest';
import { videoLibraryViews } from './video-library-views.js';

// Mock the supabase module — no real network in unit tests.
// Uses mockReturnThis() so the fluent chain (.from().select().order().limit())
// returns the same object at each step. Avoids the TDZ bug where referencing
// `chain` inside its own object-literal initializer fails because the variable
// isn't bound yet when the closures capture it.
vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => {
    type Chain = {
      select: ReturnType<typeof vi.fn>;
      order: ReturnType<typeof vi.fn>;
      eq: ReturnType<typeof vi.fn>;
      limit: ReturnType<typeof vi.fn>;
      insert: ReturnType<typeof vi.fn>;
    };
    // Separate chain per from() call so the resolved data can depend on the table name.
    const makeChain = (table: string): Chain => {
      const c: Chain = {
        select: vi.fn(),
        order: vi.fn(),
        eq: vi.fn(),
        limit: vi.fn(),
        insert: vi.fn(),
      };
      c.select.mockReturnValue(c);
      c.order.mockReturnValue(c);
      c.eq.mockReturnValue(c);
      c.limit.mockResolvedValue({
        data:
          table === 'video_library_videos'
            ? [{ youtube_video_id: 'abc', source_id: 's', title: 't', views_count: 100, updated_at: 'now' }]
            : [{ scrape_proof: '{"updated":42,"failed":0}', created_at: 'then' }],
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
    get captured() {
      return captured;
    },
  } as unknown as Parameters<typeof videoLibraryViews>[0] & { readonly captured: { body: unknown; status: number } };
};

describe('GET /cron/video-library-views', () => {
  it('returns status payload with top_5_videos + last_refreshes', async () => {
    const ctx = makeCtx({ method: 'GET' });
    await videoLibraryViews(ctx);
    const body = (ctx as any).captured.body as {
      success: boolean;
      top_5_videos: unknown[];
      last_refreshes: unknown[];
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.top_5_videos)).toBe(true);
    expect(Array.isArray(body.last_refreshes)).toBe(true);
    expect(body.top_5_videos).toHaveLength(1);
    expect(body.last_refreshes).toHaveLength(1);
  });
});

describe('POST /cron/video-library-views?report=1', () => {
  it('accepts a refresh report and returns success', async () => {
    const ctx = makeCtx({
      method: 'POST',
      query: { report: '1' },
      body: { updated: 42, failed: 0 },
    });
    await videoLibraryViews(ctx);
    const body = (ctx as any).captured.body as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('logged');
  });

  it('handles missing body gracefully (counts default to 0)', async () => {
    const ctx = makeCtx({ method: 'POST', query: { report: '1' } });
    ctx.req.json = async () => {
      throw new Error('no body');
    };
    await videoLibraryViews(ctx);
    const body = (ctx as any).captured.body as { success: boolean };
    expect(body.success).toBe(true);
  });
});
