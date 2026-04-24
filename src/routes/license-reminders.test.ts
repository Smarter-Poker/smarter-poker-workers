import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { licenseReminders } from './license-reminders.js';

const originalFetch = globalThis.fetch;

// Mock supabase — returns 2 docs, both eligible (null last_reminder_sent_at)
vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (_table: string) => {
      const c: Record<string, ReturnType<typeof vi.fn>> = {
        select: vi.fn(),
        eq: vi.fn(),
        not: vi.fn(),
        gte: vi.fn(),
        lte: vi.fn(),
        or: vi.fn(),
        limit: vi.fn(),
        update: vi.fn(),
      };
      c.select.mockReturnValue(c);
      c.eq.mockReturnValue(c);
      c.not.mockReturnValue(c);
      c.gte.mockReturnValue(c);
      c.lte.mockReturnValue(c);
      c.or.mockReturnValue(c);
      c.limit.mockResolvedValue({
        data: [
          { id: 'd1', user_id: 'u1', label: 'TX Gaming', state: 'TX', license_number: '123',
            expiry_date: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
            last_reminder_sent_at: null },
          { id: 'd2', user_id: 'u2', label: null, state: 'NV', license_number: '456',
            expiry_date: new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10),
            last_reminder_sent_at: null },
        ],
        error: null,
      });
      // .update().eq() resolves
      const updEq = vi.fn().mockResolvedValue({ data: null, error: null });
      c.update.mockReturnValue({ eq: updEq });
      return c;
    },
  }),
}));

beforeEach(() => {
  // OneSignal API mock
  process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID = 'test-app-id';
  process.env.ONESIGNAL_REST_API_KEY = 'test-rest-key';
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ id: 'notif-id-abc' }),
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID;
  delete process.env.ONESIGNAL_REST_API_KEY;
});

const makeCtx = () => {
  let captured: { body?: unknown; status?: number } = {};
  return {
    json: (body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return captured;
    },
    get captured() { return captured; },
  } as unknown as Parameters<typeof licenseReminders>[0] & { readonly captured: { body: unknown; status: number } };
};

describe('GET/POST /cron/license-reminders', () => {
  it('sends OneSignal push for each eligible doc', async () => {
    const ctx = makeCtx();
    await licenseReminders(ctx);
    const body = (ctx as any).captured.body as { sent: number; skipped: number; total: number };
    expect(body.sent).toBe(2);
    expect(body.skipped).toBe(0);
    expect(body.total).toBe(2);
    // fetch called once per doc
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });

  it('short-circuits with "OneSignal not configured" when env is missing', async () => {
    delete process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID;
    delete process.env.ONESIGNAL_REST_API_KEY;
    const ctx = makeCtx();
    await licenseReminders(ctx);
    const body = (ctx as any).captured.body as { skipped: boolean; reason: string };
    expect(body.skipped).toBe(true);
    expect(body.reason).toContain('OneSignal');
  });
});
