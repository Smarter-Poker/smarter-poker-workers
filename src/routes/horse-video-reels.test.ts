import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadFleet: vi.fn(),
  postModeEnabled: vi.fn(),
  isDueForPost: vi.fn(),
  publishVideoForHorse: vi.fn(),
  takeSupplyStats: vi.fn(),
}));

vi.mock('../lib/content-engine/Fleet.js', () => ({
  loadFleet: mocks.loadFleet,
  postModeEnabled: mocks.postModeEnabled,
}));

vi.mock('../lib/content-engine/FleetScheduler.js', () => ({
  DUE_WINDOW_HOURS: 3,
  isDueForPost: mocks.isDueForPost,
}));

vi.mock('../lib/content-engine/HorsePublisher.js', () => ({
  publishVideoForHorse: mocks.publishVideoForHorse,
  takeSupplyStats: mocks.takeSupplyStats,
}));

import { horseVideoReels } from './horse-video-reels.js';

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
  mocks.postModeEnabled.mockImplementation(async (mode: string) => mode === 'poker_video');
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
    mocks.postModeEnabled.mockResolvedValue(false);
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

  it('is wired for GET and POST without the mixed publisher or master engine switch', () => {
    const route = fs.readFileSync(fileURLToPath(new URL('./horse-video-reels.ts', import.meta.url)), 'utf8');
    const index = fs.readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
    expect(route).not.toMatch(/\bengineEnabled\b/);
    expect(route).not.toMatch(/\bpublishForHorse\b/);
    expect(route).toContain('publishVideoForHorse');
    expect(index).toContain("import { horseVideoReels } from './routes/horse-video-reels.js';");
    expect(index).toContain("app.get('/cron/horse-video-reels', horseVideoReels);");
    expect(index).toContain("app.post('/cron/horse-video-reels', horseVideoReels);");
  });
});
