/**
 * A ledger outage is named, not reported as exhausted supply (2026-09-29).
 *
 * ContentLedger fails closed: an asset whose history cannot be read counts as
 * used, so when the ledger is down every horse fails with "All poker clips
 * already posted". The run result carries `ledger_unreadable`, the number of
 * ledger reads that failed while it ran, so the operator sees the outage.
 *
 * The counter is ContentLedger.ledgerReadFailureTotal() from the fail-closed
 * ledger change (#143).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({
  publishForHorse: vi.fn(),
  ledgerFailures: 0,
}));

vi.mock('../lib/content-engine/Fleet.js', () => ({
  loadFleet: vi.fn(async () =>
    ['a', 'b', 'c', 'd'].map((k, i) => ({ id: i + 1, name: `Horse ${k}`, profile_id: `pid-${k}`, timezone: 'UTC' })),
  ),
  engineSwitch: vi.fn(async () => 'on'),
  engineEnabled: vi.fn(async () => true),
}));
vi.mock('../lib/content-engine/FleetScheduler.js', () => ({
  isDueForPost: () => ({ due: true, dueHour: 14, age: 0 }),
  DUE_WINDOW_HOURS: 3,
}));
vi.mock('../lib/content-engine/HorsePublisher.js', () => ({
  publishForHorse: m.publishForHorse,
  takeSupplyStats: () => ({}),
  fleetSlotId: (profileId: string) => `slot-of-${profileId}`,
}));
vi.mock('../lib/content-engine/VoiceWriter.js', () => ({
  syncStyleSheets: vi.fn(async () => ({ checked: 4, updated: 0 })),
}));
vi.mock('../lib/content-engine/ContentLedger.js', () => ({
  ledgerReadFailureTotal: () => m.ledgerFailures,
}));

import { horsePosts } from './horse-posts.js';

async function run() {
  const app = new Hono();
  app.get('/cron/horse-posts', horsePosts);
  const res = await app.request('/cron/horse-posts');
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  m.ledgerFailures = 0;
  m.publishForHorse.mockReset();
});

describe('a ledger outage is named in the run result', () => {
  it('reports the ledger reads that failed during the run, not those before it', async () => {
    // Two failed reads from an earlier run in this process; they are not this run's.
    m.ledgerFailures = 2;
    const answers = [
      { success: false, error: 'All poker clips already posted', bump: 1 },
      { success: true, type: 'poker_news', bump: 0 },
      { success: false, error: 'All poker clips already posted', bump: 1 },
      { success: false, error: 'All sports clips already posted', bump: 1 },
    ];
    m.publishForHorse.mockImplementation(async (h: { name: string; profile_id: string }) => {
      const { bump, ...answer } = answers.shift()!;
      m.ledgerFailures += bump;
      return { horse: h.name, profile_id: h.profile_id, ...answer };
    });

    const r = await run();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      attempted: 4,
      posted: 1,
      failed: 3,
      errors: { 'All poker clips already posted': 2, 'All sports clips already posted': 1 },
      ledger_unreadable: 3,
    });
  });

  it('is zero when every ledger read succeeded', async () => {
    m.ledgerFailures = 5;
    m.publishForHorse.mockImplementation(async (h: { name: string; profile_id: string }) => ({
      success: true,
      horse: h.name,
      profile_id: h.profile_id,
      type: 'poker_news',
    }));
    const r = await run();
    expect(r.body).toMatchObject({ posted: 4, failed: 0, ledger_unreadable: 0 });
  });
});
