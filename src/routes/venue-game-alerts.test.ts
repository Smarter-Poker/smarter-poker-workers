import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { venueGameAlerts } from './venue-game-alerts.js';

const originalFetch = globalThis.fetch;

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {
        select: vi.fn(),
        eq: vi.fn(),
        limit: vi.fn(),
        update: vi.fn(),
      };
      c.select.mockReturnValue(c);
      if (table === 'venue_game_alerts') {
        // .select().eq('active', true) resolves to alerts
        c.eq.mockResolvedValue({
          data: [
            { id: 'a1', user_id: 'u1', venue_name: 'Venue A', game_type: 'NLH', last_triggered: null, active: true },
            // This one should be skipped — cooldown not expired
            { id: 'a2', user_id: 'u2', venue_name: 'Venue A', game_type: 'NLH', last_triggered: new Date().toISOString(), active: true },
          ],
          error: null,
        });
        // .update().eq() — resolve
        const updEq = vi.fn().mockResolvedValue({ data: null, error: null });
        c.update.mockReturnValue({ eq: updEq });
      } else if (table === 'venue_live_tables') {
        c.limit.mockResolvedValue({
          data: [
            { venue_name: 'Venue A', game_name: 'NLH 1/2', tables_running: 3, source: 'pokeratlas' },
          ],
          error: null,
        });
      }
      return c;
    },
  }),
}));

beforeEach(() => {
  // Mock global fetch for the notification send call
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const makeCtx = () => {
  let captured: { body?: unknown; status?: number } = {};
  return {
    json: (body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return captured;
    },
    get captured() { return captured; },
  } as unknown as Parameters<typeof venueGameAlerts>[0] & { readonly captured: { body: unknown; status: number } };
};

describe('GET/POST /cron/venue-game-alerts', () => {
  it('matches, cools down, and reports counts', async () => {
    const ctx = makeCtx();
    await venueGameAlerts(ctx);
    const body = (ctx as any).captured.body as {
      matches: unknown[];
      notifications_sent: number;
    };
    // a1 fires (null last_triggered), a2 cooled down → expect 1 match, 1 notification
    expect(body.matches).toHaveLength(1);
    expect(body.notifications_sent).toBe(1);
    // fetch was called once for the notification send
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });
});
