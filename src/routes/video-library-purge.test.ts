import { describe, it, expect, vi } from 'vitest';
import { videoLibraryPurge } from './video-library-purge.js';

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (_table: string) => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {
        select: vi.fn(),
        eq: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
        insert: vi.fn(),
      };
      c.select.mockImplementation((_cols: string, opts?: { head?: boolean }) => {
        if (opts?.head) return Promise.resolve({ count: 1903, data: null, error: null });
        return c;
      });
      c.eq.mockReturnValue(c);
      c.order.mockReturnValue(c);
      c.limit.mockResolvedValue({ data: [{ scrape_proof: '{"purged":5}', created_at: 'now' }], error: null });
      c.insert.mockResolvedValue({ data: null, error: null });
      return c;
    },
  }),
}));

const makeCtx = () => {
  let captured: { body?: unknown; status?: number } = {};
  return {
    req: {
      method: 'GET',
      query: (_k: string) => undefined,
      json: async () => ({}),
    },
    json: (body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return captured;
    },
    get captured() { return captured; },
  } as unknown as Parameters<typeof videoLibraryPurge>[0] & { readonly captured: { body: unknown; status: number } };
};

describe('GET /cron/video-library-purge', () => {
  it('returns status payload with total_videos + last_purges', async () => {
    const ctx = makeCtx();
    await videoLibraryPurge(ctx);
    const body = (ctx as any).captured.body as { success: boolean; total_videos: number; last_purges: unknown[] };
    expect(body.success).toBe(true);
    expect(body.total_videos).toBe(1903);
    expect(body.last_purges).toHaveLength(1);
  });
});
