import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadFleet: vi.fn(),
  readPostModeStates: vi.fn(),
  isDueForPost: vi.fn(),
  publishVideoForHorse: vi.fn(),
  takeSupplyStats: vi.fn(),
}));

vi.mock('../lib/content-engine/Fleet.js', () => ({
  loadFleet: mocks.loadFleet,
  readPostModeStates: mocks.readPostModeStates,
}));

vi.mock('../lib/content-engine/FleetScheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/content-engine/FleetScheduler.js')>();
  return {
    ...actual,
    isDueForPost: mocks.isDueForPost,
  };
});

vi.mock('../lib/content-engine/HorsePublisher.js', () => ({
  publishVideoForHorse: mocks.publishVideoForHorse,
  takeSupplyStats: mocks.takeSupplyStats,
}));

import {
  HORSE_VIDEO_QUEUE_STRATEGY,
  horseVideoReels,
  selectFairHorseVideoQueue,
} from './horse-video-reels.js';

const horses = [
  { id: 1, name: 'Alpha', profile_id: 'horse-a', timezone: 'UTC' },
  { id: 2, name: 'Bravo', profile_id: 'horse-b', timezone: 'UTC' },
];

function context() {
  let captured: { body?: unknown; status?: number } = {};
  return {
    json: (body: unknown, status = 200) => {
      captured = { body, status };
      return captured;
    },
    get captured() {
      return captured as { body: Record<string, unknown>; status: number };
    },
  } as unknown as Parameters<typeof horseVideoReels>[0] & {
    readonly captured: { body: Record<string, unknown>; status: number };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadFleet.mockResolvedValue(horses);
  mocks.readPostModeStates.mockResolvedValue({ poker_video: true, sports_video: false });
  mocks.isDueForPost.mockReturnValue({ due: true, age: 1 });
  mocks.publishVideoForHorse.mockImplementation(async (horse: (typeof horses)[number]) => ({
    success: true,
    horse: horse.name,
    profile_id: horse.profile_id,
    type: 'poker_video',
    postId: `post-${horse.id}`,
    reelId: `reel-${horse.id}`,
    created: true,
  }));
  mocks.takeSupplyStats.mockReturnValue({ yt_http_200: 2 });
});

describe('horseVideoReels', () => {
  it('fails closed before reading the fleet when both independent modes are disabled', async () => {
    mocks.readPostModeStates.mockResolvedValue({ poker_video: false, sports_video: false });
    const c = context();
    await horseVideoReels(c);
    expect(c.captured.status).toBe(200);
    expect(c.captured.body).toMatchObject({
      success: true,
      skipped: 'video_modes_disabled',
      posted: 0,
    });
    expect(mocks.loadFleet).not.toHaveBeenCalled();
    expect(mocks.publishVideoForHorse).not.toHaveBeenCalled();
  });

  it('pages on a total mode-state read outage instead of reporting a healthy disable', async () => {
    mocks.readPostModeStates.mockRejectedValue(new Error('database unavailable'));
    const c = context();
    await horseVideoReels(c);
    expect(c.captured.status).toBe(503);
    expect(c.captured.body).toMatchObject({
      success: false,
      error: 'mode_state_unavailable: database unavailable',
    });
    expect(mocks.loadFleet).not.toHaveBeenCalled();
  });

  it('pages when one required mode row is missing', async () => {
    mocks.readPostModeStates.mockRejectedValue(new Error('horse post modes missing: sports_video'));
    const c = context();
    await horseVideoReels(c);
    expect(c.captured.status).toBe(503);
    expect(c.captured.body).toMatchObject({
      success: false,
      error: 'mode_state_unavailable: horse post modes missing: sports_video',
    });
    expect(mocks.loadFleet).not.toHaveBeenCalled();
  });

  it('publishes only the approved video type and returns linked post/Reel identities', async () => {
    const c = context();
    await horseVideoReels(c);
    expect(mocks.publishVideoForHorse).toHaveBeenCalledTimes(2);
    for (const call of mocks.publishVideoForHorse.mock.calls) {
      expect(call[1]).toMatchObject({ allowedTypes: ['poker'] });
    }
    expect(c.captured.body).toMatchObject({
      posted: 2,
      created: 2,
      failed: 0,
      by_type: { poker_video: 2 },
      post_ids: ['post-1', 'post-2'],
      reel_ids: ['reel-1', 'reel-2'],
    });
  });

  it('does not attempt horses outside their due window', async () => {
    mocks.isDueForPost.mockImplementation((id: string) => ({ due: id === 'horse-a', age: 0 }));
    const c = context();
    await horseVideoReels(c);
    expect(mocks.publishVideoForHorse).toHaveBeenCalledTimes(1);
    expect(mocks.publishVideoForHorse.mock.calls[0]![0]).toMatchObject({ profile_id: 'horse-a' });
    expect(c.captured.body).toMatchObject({ due: 1, attempted: 1, posted: 1 });
  });

  it('keeps retries deterministic within an hour and rotates over-cap cohorts next hour', () => {
    const due = Array.from({ length: 200 }, (_, index) => ({
      horse: { profile_id: `horse-${String(index).padStart(3, '0')}` },
      slot: { due: true, age: index % 3 },
    }));
    const firstAt = new Date('2026-09-26T12:05:00.000Z');
    const nextAt = new Date('2026-09-26T13:05:00.000Z');
    const thirdAt = new Date('2026-09-26T14:05:00.000Z');
    const first = selectFairHorseVideoQueue(due, firstAt);
    const retry = selectFairHorseVideoQueue([...due].reverse(), firstAt);
    const next = selectFairHorseVideoQueue(due, nextAt);
    const third = selectFairHorseVideoQueue(due, thirdAt);
    const firstIds = first.queue.map((item) => item.horse.profile_id);
    const retryIds = retry.queue.map((item) => item.horse.profile_id);
    const nextIds = next.queue.map((item) => item.horse.profile_id);

    expect(firstIds).toEqual(retryIds);
    expect(firstIds).toHaveLength(80);
    expect(nextIds).toHaveLength(80);
    expect(new Set(firstIds).size).toBe(80);
    expect(new Set(nextIds).size).toBe(80);
    expect(nextIds.every((id) => !firstIds.includes(id))).toBe(true);
    expect(new Set([
      ...firstIds,
      ...nextIds,
      ...third.queue.map((item) => item.horse.profile_id),
    ]).size).toBe(200);
    expect(next.cursor).not.toBe(first.cursor);
  });

  it('does not let a permanently failing first 80 monopolize the next scheduled run', async () => {
    const largeFleet = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      name: `Horse ${index + 1}`,
      profile_id: `horse-${String(index).padStart(3, '0')}`,
      timezone: 'UTC',
    }));
    mocks.loadFleet.mockResolvedValue(largeFleet);
    mocks.publishVideoForHorse.mockImplementation(async (horse: (typeof largeFleet)[number]) => ({
      success: false,
      horse: horse.name,
      profile_id: horse.profile_id,
      error: 'permanent source rejection',
    }));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-26T12:05:00.000Z'));
      const firstContext = context();
      await horseVideoReels(firstContext);
      const firstIds = mocks.publishVideoForHorse.mock.calls.map((call) => call[0].profile_id as string);

      mocks.publishVideoForHorse.mockClear();
      vi.setSystemTime(new Date('2026-09-26T13:05:00.000Z'));
      const nextContext = context();
      await horseVideoReels(nextContext);
      const nextIds = mocks.publishVideoForHorse.mock.calls.map((call) => call[0].profile_id as string);

      expect(firstIds).toHaveLength(80);
      expect(nextIds).toHaveLength(80);
      expect(nextIds.every((id) => !firstIds.includes(id))).toBe(true);
      expect(firstContext.captured).toMatchObject({
        status: 503,
        body: {
          due: 200,
          attempted: 80,
          cap_hit: true,
          queue_strategy: HORSE_VIDEO_QUEUE_STRATEGY,
        },
      });
      expect(nextContext.captured.body.queue_cursor).not.toBe(firstContext.captured.body.queue_cursor);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pages when approved video modes have no active fleet to process', async () => {
    mocks.loadFleet.mockResolvedValue([]);
    const c = context();
    await horseVideoReels(c);
    expect(c.captured.status).toBe(503);
    expect(c.captured.body).toMatchObject({
      success: false,
      error: 'active_horse_fleet_empty',
    });
  });

  it('keeps one horse failure visible without dropping the rest of the run', async () => {
    mocks.publishVideoForHorse
      .mockRejectedValueOnce(new Error('verification registry unavailable'))
      .mockResolvedValueOnce({
        success: true,
        horse: 'Bravo',
        profile_id: 'horse-b',
        type: 'poker_video',
        postId: 'post-2',
        reelId: 'reel-2',
        created: false,
      });
    const c = context();
    await horseVideoReels(c);
    expect(c.captured.body).toMatchObject({
      success: true,
      attempted: 2,
      posted: 1,
      replayed: 1,
      failed: 1,
      errors: { 'verification registry unavailable': 1 },
    });
  });

  it('returns a monitored failure when every enabled publication attempt fails', async () => {
    mocks.publishVideoForHorse.mockResolvedValue({
      success: false,
      horse: 'Alpha',
      profile_id: 'horse-a',
      error: 'shared verification registry unavailable',
    });
    const c = context();
    await horseVideoReels(c);
    expect(c.captured.status).toBe(503);
    expect(c.captured.body).toMatchObject({
      success: false,
      attempted: 2,
      posted: 0,
      failed: 2,
      errors: { 'shared verification registry unavailable': 2 },
    });
  });

  it('does not let a normal cadence skip hide failures for every real attempt', async () => {
    mocks.publishVideoForHorse
      .mockResolvedValueOnce({
        success: false,
        horse: 'Alpha',
        profile_id: 'horse-a',
        skipped: 'posted_recently',
      })
      .mockResolvedValueOnce({
        success: false,
        horse: 'Bravo',
        profile_id: 'horse-b',
        error: 'shared verification registry unavailable',
      });
    const c = context();
    await horseVideoReels(c);
    expect(c.captured.status).toBe(503);
    expect(c.captured.body).toMatchObject({
      success: false,
      attempted: 2,
      posted: 0,
      skipped_recent: 1,
      failed: 1,
    });
  });

  it('keeps an all-cadence-skip run healthy', async () => {
    mocks.publishVideoForHorse.mockImplementation(async (horse: (typeof horses)[number]) => ({
      success: false,
      horse: horse.name,
      profile_id: horse.profile_id,
      skipped: 'posted_recently',
    }));
    const c = context();
    await horseVideoReels(c);
    expect(c.captured.status).toBe(200);
    expect(c.captured.body).toMatchObject({
      success: true,
      attempted: 2,
      posted: 0,
      skipped_recent: 2,
      failed: 0,
    });
  });

  it('reports a partial-progress deadline as incomplete while preserving published IDs', async () => {
    const now = vi.spyOn(Date, 'now');
    now
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(540_001)
      .mockReturnValue(540_002);
    const c = context();
    try {
      await horseVideoReels(c);
    } finally {
      now.mockRestore();
    }
    expect(c.captured.status).toBe(503);
    expect(c.captured.body).toMatchObject({
      success: false,
      due: 2,
      attempted: 1,
      posted: 1,
      deadline_hit: true,
      post_ids: ['post-1'],
      reel_ids: ['reel-1'],
    });
  });

  it('counts a lost RPC acknowledgement as unknown rather than failed', async () => {
    mocks.publishVideoForHorse.mockResolvedValue({
      success: false,
      horse: 'Alpha',
      profile_id: 'horse-a',
      outcome: 'unknown',
      error: 'atomic horse video publication outcome unknown: request aborted',
    });
    const c = context();
    await horseVideoReels(c);
    expect(c.captured.status).toBe(503);
    expect(c.captured.body).toMatchObject({
      success: false,
      attempted: 2,
      posted: 0,
      failed: 0,
      unknown: 2,
    });
  });

  it('is wired for GET and POST without the mixed publisher or master engine switch', () => {
    const route = fs.readFileSync(fileURLToPath(new URL('./horse-video-reels.ts', import.meta.url)), 'utf8');
    const index = fs.readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
    expect(route).not.toMatch(/\bengineEnabled\b/);
    expect(route).not.toMatch(/\bpublishForHorse\b/);
    expect(route).toContain('publishVideoForHorse');
    expect(index).toContain("import { horseVideoReels } from './routes/horse-video-reels.js';");
    expect(index).toContain("app.get('/cron/horse-video-reels', horseVideoReels);");
    expect(index).toContain("app.post('/cron/horse-video-reels', horseVideoReels);");
    const ipGuard = index.indexOf("app.use('/cron/*', ipAllowlist);");
    const secretGuard = index.indexOf("app.use('/cron/*', requireCronSecret);");
    const getRoute = index.indexOf("app.get('/cron/horse-video-reels', horseVideoReels);");
    const postRoute = index.indexOf("app.post('/cron/horse-video-reels', horseVideoReels);");
    expect(ipGuard).toBeGreaterThan(-1);
    expect(secretGuard).toBeGreaterThan(ipGuard);
    expect(getRoute).toBeGreaterThan(secretGuard);
    expect(postRoute).toBeGreaterThan(secretGuard);
  });
});
