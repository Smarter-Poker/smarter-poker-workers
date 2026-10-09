/**
 * Recertification D2 and F2 at the route (2026-09-21).
 *
 *   - the kill switch is read again, fresh, before every horse, so turning
 *     the engine off stops a run in flight and the run says so;
 *   - each publish is told the scheduler slot it fills;
 *   - skips are counted by reason, never as failures.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({
  switches: [] as string[],
  engineSwitch: vi.fn(),
  publishForHorse: vi.fn(),
  prepareSharedHorseVideoSupply: vi.fn(),
  syncStyleSheets: vi.fn(),
}));

vi.mock('../lib/content-engine/Fleet.js', () => {
  const next = async () => {
    const s = m.switches.shift();
    if (!s) throw new Error('unexpected switch read');
    return s;
  };
  m.engineSwitch.mockImplementation(next);
  return {
    loadFleet: vi.fn(async () =>
      ['a', 'b', 'c', 'd'].map((k, i) => ({ id: i + 1, name: `Horse ${k}`, profile_id: `pid-${k}`, timezone: 'UTC' })),
    ),
    engineSwitch: m.engineSwitch,
    engineEnabled: vi.fn(async (opts?: { fresh?: boolean }) => (await m.engineSwitch(opts)) === 'on'),
  };
});
vi.mock('../lib/content-engine/FleetScheduler.js', () => ({
  isDueForPost: () => ({ due: true, dueHour: 14, age: 0 }),
  DUE_WINDOW_HOURS: 3,
}));
vi.mock('../lib/content-engine/HorsePublisher.js', () => ({
  publishForHorse: m.publishForHorse,
  prepareSharedHorseVideoSupply: m.prepareSharedHorseVideoSupply,
  takeSupplyStats: () => ({}),
  fleetSlotId: (profileId: string) => `slot-of-${profileId}`,
}));
vi.mock('../lib/content-engine/VoiceWriter.js', () => ({ syncStyleSheets: m.syncStyleSheets }));

import { horsePosts } from './horse-posts.js';

async function run() {
  const app = new Hono();
  app.get('/cron/horse-posts', horsePosts);
  const res = await app.request('/cron/horse-posts');
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  m.switches = [];
  m.engineSwitch.mockClear();
  m.publishForHorse.mockReset();
  m.prepareSharedHorseVideoSupply.mockReset();
  m.prepareSharedHorseVideoSupply.mockResolvedValue({
    status: 'ok',
    supply: { poker: [], sports: [] },
    availableTypes: [],
    counts: {},
  });
  m.publishForHorse.mockImplementation(async (h: { name: string; profile_id: string }) => ({
    success: true,
    horse: h.name,
    profile_id: h.profile_id,
    type: 'poker_news',
  }));
  m.syncStyleSheets.mockReset();
  m.syncStyleSheets.mockResolvedValue({ checked: 4, updated: 0 });
});

describe('turning the engine off stops a run in flight', () => {
  it('does not read shared supply when the master switch is off at entry', async () => {
    m.switches = ['off'];
    const r = await run();
    expect(r.body).toMatchObject({ success: true, skipped: 'engine_disabled' });
    expect(m.prepareSharedHorseVideoSupply).not.toHaveBeenCalled();
    expect(m.publishForHorse).not.toHaveBeenCalled();
  });

  it('stops before the next horse when the switch flips off mid-run', async () => {
    m.switches = ['on', 'on', 'on', 'off'];
    const r = await run();
    expect(r.status).toBe(200);
    expect(m.publishForHorse).toHaveBeenCalledTimes(2);
    expect(r.body).toMatchObject({ success: true, stopped: 'engine_disabled', attempted: 2, posted: 2, not_attempted: 2 });
    // The loop reads past the 30-second cache.
    for (const call of m.engineSwitch.mock.calls.slice(1)) expect(call[0]).toEqual({ fresh: true });
    // An engine that is off writes nothing more, not even style sheets.
    expect(m.syncStyleSheets).not.toHaveBeenCalled();
  });

  it('an unreadable switch mid-run also stops it, and says which', async () => {
    m.switches = ['on', 'on', 'unreadable'];
    const r = await run();
    expect(m.publishForHorse).toHaveBeenCalledTimes(1);
    expect(r.body).toMatchObject({ stopped: 'engine_unreadable', attempted: 1, not_attempted: 3 });
  });

  it('a run with the switch on throughout finishes and syncs style sheets', async () => {
    m.switches = ['on', 'on', 'on', 'on', 'on'];
    const r = await run();
    expect(m.publishForHorse).toHaveBeenCalledTimes(4);
    expect(r.body).toMatchObject({ stopped: null, attempted: 4, posted: 4, not_attempted: 0 });
    expect(m.syncStyleSheets).toHaveBeenCalledTimes(1);
  });
});

describe('each publish names its slot, and skips are counted by reason', () => {
  it('prepares one shared video proof snapshot and passes it to every horse', async () => {
    m.switches = ['on', 'on', 'on', 'on', 'on'];
    const supply = { poker: [{ video_id: 'AAAAAAAAAAA' }], sports: [] };
    m.prepareSharedHorseVideoSupply.mockResolvedValue({
      status: 'ok', supply, availableTypes: ['poker'], counts: { poker: { scanned: 1, verified: 1, captionable: 1 } },
    });
    const r = await run();
    expect(r.status).toBe(200);
    expect(m.prepareSharedHorseVideoSupply).toHaveBeenCalledTimes(1);
    expect(m.prepareSharedHorseVideoSupply).toHaveBeenCalledWith(['poker', 'sports']);
    for (const [, opts] of m.publishForHorse.mock.calls) {
      expect(opts).toMatchObject({ sharedVideoSupply: supply });
    }
    expect(r.body).toMatchObject({ video_supply_preflight: 'ok' });
  });

  it('passes a shared-proof outage as unknown instead of falling back to per-horse YouTube fanout', async () => {
    m.switches = ['on', 'on', 'on', 'on', 'on'];
    m.prepareSharedHorseVideoSupply.mockResolvedValue({ status: 'unknown', error: 'shared registry unavailable' });
    const r = await run();
    expect(r.status).toBe(200);
    for (const [, opts] of m.publishForHorse.mock.calls) {
      expect(opts).toMatchObject({ sharedVideoSupplyError: 'shared registry unavailable' });
      expect(opts.sharedVideoSupply).toBeUndefined();
    }
    expect(r.body).toMatchObject({ video_supply_preflight: 'unknown' });
  });

  it('passes the scheduler slot and counts guard, duplicate and recent skips apart from failures', async () => {
    m.switches = ['on', 'on', 'on', 'on', 'on'];
    const answers = [
      { success: false, skipped: 'guard_unreadable' },
      { success: false, skipped: 'duplicate_slot', publicationKey: 'fleet:pid-b:slot' },
      { success: false, skipped: 'posted_recently' },
      { success: true, type: 'poker_news' },
    ];
    m.publishForHorse.mockImplementation(async (h: { name: string; profile_id: string }) => ({
      horse: h.name,
      profile_id: h.profile_id,
      ...answers.shift()!,
    }));
    const r = await run();
    for (const [h, opts] of m.publishForHorse.mock.calls as Array<[{ profile_id: string }, { slot?: string }]>) {
      expect(opts.slot).toBe(`slot-of-${h.profile_id}`);
    }
    expect(r.body).toMatchObject({
      attempted: 4,
      posted: 1,
      failed: 0,
      skipped_recent: 1,
      skipped_guard_unreadable: 1,
      duplicate_slot: 1,
      skipped_by_reason: { guard_unreadable: 1, duplicate_slot: 1, posted_recently: 1 },
    });
  });

  it('reports definitive all-candidate exhaustion as safe silence, not failure', async () => {
    m.switches = ['on', 'on', 'on', 'on', 'on'];
    m.publishForHorse.mockImplementation(async (h: { name: string; profile_id: string }) => ({
      success: false,
      horse: h.name,
      profile_id: h.profile_id,
      skipped: 'content_exhausted',
      error: 'all bounded approved candidates exhausted',
    }));
    const r = await run();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      success: true,
      attempted: 4,
      posted: 0,
      failed: 0,
      content_exhausted: 4,
      skipped_by_reason: { content_exhausted: 4 },
      errors: {},
    });
  });

  it('keeps real failures visible beside exhausted horses', async () => {
    m.switches = ['on', 'on', 'on', 'on', 'on'];
    const answers = [
      { success: false, skipped: 'content_exhausted', error: 'bounded candidates exhausted' },
      { success: false, error: 'feed transport failed' },
      { success: true, type: 'poker_news' },
      { success: false, skipped: 'content_exhausted', error: 'bounded candidates exhausted' },
    ];
    m.publishForHorse.mockImplementation(async (h: { name: string; profile_id: string }) => ({
      horse: h.name,
      profile_id: h.profile_id,
      ...answers.shift()!,
    }));
    const r = await run();
    expect(r.body).toMatchObject({
      posted: 1,
      failed: 1,
      content_exhausted: 2,
      errors: { 'feed transport failed': 1 },
    });
  });
});
