import { beforeEach, describe, expect, it, vi } from 'vitest';

const { engineEnabled, postModeEnabled, getSupabase } = vi.hoisted(() => ({
  engineEnabled: vi.fn(),
  postModeEnabled: vi.fn(),
  getSupabase: vi.fn(() => {
    throw new Error('database must not be reached');
  }),
}));

vi.mock('../lib/content-engine/Fleet.js', () => ({
  engineEnabled,
  postModeEnabled,
  loadFleet: vi.fn(),
}));
vi.mock('../lib/supabase.js', () => ({ getSupabase }));
vi.mock('../lib/content-engine/HorsePublisher.js', () => ({ postedRecently: vi.fn() }));
vi.mock('../lib/content-engine/ContentLedger.js', () => ({
  normalizePhrase: vi.fn((value: string) => value),
  recordPhrase: vi.fn(),
}));

import { phase6Content } from './phase6-content.js';

type TestContext = Parameters<typeof phase6Content>[0] & {
  readonly captured: { body: unknown; status: number };
};

function context(query: Record<string, string> = {}): TestContext {
  let captured = { body: null as unknown, status: 0 };
  return {
    req: { query: (key: string) => query[key] },
    json: (body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return captured;
    },
    get captured() { return captured; },
  } as unknown as TestContext;
}

describe('GET/POST /cron/phase6-content fail-closed behavior', () => {
  beforeEach(() => vi.clearAllMocks());

  it('touches no data when the fleet master switch is off', async () => {
    engineEnabled.mockResolvedValue(false);
    const c = context();
    await phase6Content(c);
    expect(c.captured).toEqual({
      status: 200,
      body: { success: true, skipped: 'engine_disabled', modes_checked: 0, posted: 0 },
    });
    expect(postModeEnabled).not.toHaveBeenCalled();
    expect(getSupabase).not.toHaveBeenCalled();
  });

  it('touches no source data when every independent mode is off', async () => {
    engineEnabled.mockResolvedValue(true);
    postModeEnabled.mockResolvedValue(false);
    const c = context();
    await phase6Content(c);
    expect(postModeEnabled).toHaveBeenCalledTimes(3);
    expect(getSupabase).not.toHaveBeenCalled();
    expect(c.captured.body).toMatchObject({
      success: true,
      posted: 0,
      results: {
        club_data_digest: { skipped: 'awaiting_approval', posted: 0 },
        local_event: { skipped: 'awaiting_approval', posted: 0 },
        seasonal_local: { skipped: 'awaiting_approval', posted: 0 },
      },
    });
  });
});
