import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scraperWatchdog } from './scraper-watchdog.js';

const originalFetch = globalThis.fetch;

// Return a healthy scraper reading so nothing alerts.
// Every .from() call chain resolves to fresh data.
vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (_table: string) => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {
        select: vi.fn(),
        eq: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
        maybeSingle: vi.fn(),
        upsert: vi.fn(),
      };
      c.select.mockReturnValue(c);
      c.eq.mockReturnValue(c);
      c.order.mockReturnValue(c);
      // venue_live_tables query — one row, very fresh
      c.limit.mockResolvedValue({
        data: [{ scrape_timestamp: new Date().toISOString() }],
        count: 500, // within safe bounds (10 < 500 < 5000)
        error: null,
      });
      // .maybeSingle() for state lookups — return no existing state so defaults apply
      c.maybeSingle.mockResolvedValue({ data: null, error: null });
      c.upsert.mockResolvedValue({ data: null, error: null });
      return c;
    },
  }),
}));

// Twilio not configured — exercises the short-circuit path
vi.mock('../lib/twilio.js', () => ({
  isTwilioConfigured: () => false,
  sendSMS: vi.fn(),
}));

beforeEach(() => {
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
  } as unknown as Parameters<typeof scraperWatchdog>[0] & { readonly captured: { body: unknown; status: number } };
};

describe('GET/POST /cron/scraper-watchdog', () => {
  it('returns healthy status when sources are fresh', async () => {
    const ctx = makeCtx();
    await scraperWatchdog(ctx);
    const body = (ctx as any).captured.body as {
      checked_at: string;
      sources: Record<string, { status: string }>;
      alerts_sent: unknown[];
      resolved: unknown[];
    };
    expect(body.checked_at).toBeTruthy();
    expect(body.sources).toHaveProperty('pokeratlas');
    expect(body.sources).not.toHaveProperty('bravo');
    // pokeratlas should be 'ok' since scrape_timestamp is "now"
    expect(body.sources.pokeratlas.status).toBe('ok');
    // No alerts on healthy sources
    expect(body.alerts_sent).toHaveLength(0);
  });
});
