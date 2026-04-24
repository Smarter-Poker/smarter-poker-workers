import { describe, it, expect, vi } from 'vitest';
import { refreshVenueJson } from './refresh-venue-json.js';

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (_table: string) => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {
        select: vi.fn(),
        eq: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
        upsert: vi.fn(),
      };
      c.select.mockReturnValue(c);
      c.eq.mockReturnValue(c);
      c.order.mockReturnValue(c);
      c.limit.mockResolvedValue({
        data: [
          { id: 1, name: 'Venue A', is_active: true },
          { id: 2, name: 'Venue B', is_active: true },
        ],
        error: null,
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
  } as unknown as Parameters<typeof refreshVenueJson>[0] & { readonly captured: { body: unknown; status: number } };
};

describe('GET /cron/refresh-venue-json', () => {
  it('fetches active venues and upserts cache payload', async () => {
    const ctx = makeCtx();
    await refreshVenueJson(ctx);
    const body = (ctx as any).captured.body as { success: boolean; count: number };
    expect(body.success).toBe(true);
    expect(body.count).toBe(2);
  });
});
