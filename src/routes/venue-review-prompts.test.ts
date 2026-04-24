import { describe, it, expect, vi } from 'vitest';
import { venueReviewPrompts } from './venue-review-prompts.js';

// Mock BOTH supabase and push — the route touches both
vi.mock('../lib/push.js', () => ({
  sendPushNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {
        select: vi.fn(),
        eq: vi.fn(),
        lt: vi.fn(),
        limit: vi.fn(),
        in: vi.fn(),
        update: vi.fn(),
      };
      c.select.mockReturnValue(c);
      c.eq.mockReturnValue(c);
      c.lt.mockReturnValue(c);
      if (table === 'user_venue_checkins') {
        c.limit.mockResolvedValue({
          data: [
            { id: 'chk1', user_id: 'u1', venue_id: 'v1' },
            { id: 'chk2', user_id: 'u2', venue_id: 'v2' },
          ],
          error: null,
        });
        c.update.mockReturnValue(c);
        // .update().eq() resolves
        const updateEq = vi.fn().mockResolvedValue({ data: null, error: null });
        c.update.mockReturnValue({ eq: updateEq });
      } else if (table === 'venues') {
        c.in.mockResolvedValue({
          data: [
            { id: 'v1', name: 'Venue One' },
            { id: 'v2', name: 'Venue Two' },
          ],
          error: null,
        });
      }
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
  } as unknown as Parameters<typeof venueReviewPrompts>[0] & { readonly captured: { body: unknown; status: number } };
};

describe('GET/POST /cron/venue-review-prompts', () => {
  it('processes eligible checkins and reports processed count', async () => {
    const ctx = makeCtx();
    await venueReviewPrompts(ctx);
    const body = (ctx as any).captured.body as { success: boolean; processed: number };
    expect(body.success).toBe(true);
    expect(body.processed).toBe(2);
  });
});
