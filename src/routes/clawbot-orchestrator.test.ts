import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clawbotOrchestrator } from './clawbot-orchestrator.js';

const originalFetch = globalThis.fetch;

// logAudit writes to Supabase — we mock supabase so the inserts silently succeed
vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (_table: string) => ({
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
  }),
}));

beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: { summary: 'all quiet' } }),
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const makeCtx = (authHeader = 'Bearer test-secret') => {
  let captured: { body?: unknown; status?: number } = {};
  return {
    req: {
      header: (name: string) => (name === 'Authorization' ? authHeader : undefined),
    },
    json: (body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return captured;
    },
    get captured() { return captured; },
  } as unknown as Parameters<typeof clawbotOrchestrator>[0] & { readonly captured: { body: unknown; status: number } };
};

describe('GET /cron/clawbot-orchestrator', () => {
  it('dispatches all enabled tasks and aggregates results', async () => {
    const ctx = makeCtx();
    await clawbotOrchestrator(ctx);
    const body = (ctx as any).captured.body as {
      success: boolean;
      summary: string;
      results: Array<{ task_id: string; status: string }>;
    };
    expect(body.success).toBe(true);
    expect(body.summary).toContain('1/1 tasks succeeded');
    expect(body.results).toHaveLength(1);
    expect(body.results[0].status).toBe('success');
    expect(body.results[0].task_id).toBe('cb-01-sentry-triage');
  });
});
