import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dailyChallenges } from './daily-challenges.js';

const rpc = vi.fn();
const insert = vi.fn();
const maybeSingle = vi.fn();
const eq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select, insert }));

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({ from, rpc }),
}));

type TestContext = Parameters<typeof dailyChallenges>[0] & {
  readonly captured: { body: unknown; status: number };
};

function makeContext(): TestContext {
  let captured: { body?: unknown; status?: number } = {};
  return {
    json: (body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return captured;
    },
    get captured() {
      return captured;
    },
  } as unknown as TestContext;
}

describe('GET/POST /cron/daily-challenges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insert.mockResolvedValue({ error: null });
    rpc.mockResolvedValue({ data: 0, error: null });
  });

  it('retries mission alert enqueue when the training row already exists', async () => {
    maybeSingle.mockResolvedValue({ data: { id: 'existing' }, error: null });
    rpc.mockResolvedValueOnce({ data: 2, error: null });

    const context = makeContext();
    await dailyChallenges(context);

    expect(insert).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('enqueue_daily_mission_reset_notifications', {
      p_cycle_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      p_limit: 1000,
    });
    expect(context.captured).toMatchObject({
      status: 200,
      body: { success: true, trainingChallengeCreated: false, missionAlertsQueued: 2 },
    });
  });

  it('creates the training row and drains opted-in alert batches', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    rpc
      .mockResolvedValueOnce({ data: 1000, error: null })
      .mockResolvedValueOnce({ data: 7, error: null });

    const context = makeContext();
    await dailyChallenges(context);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(context.captured).toMatchObject({
      status: 200,
      body: { success: true, trainingChallengeCreated: true, missionAlertsQueued: 1007 },
    });
  });

  it('returns a retryable failure when the alert receipt fails', async () => {
    maybeSingle.mockResolvedValue({ data: { id: 'existing' }, error: null });
    rpc.mockResolvedValue({ data: null, error: { message: 'RPC unavailable' } });

    const context = makeContext();
    await dailyChallenges(context);

    expect(context.captured).toEqual({
      status: 500,
      body: { error: 'RPC unavailable' },
    });
  });
});
