/**
 * Check 4 of the content supply watchdog measures the share of poker sources
 * still active among those that have RESOLVED AT LEAST ONCE (last_ok_at IS
 * NOT NULL). A registered handle that never resolved is not a channel the
 * resolver or the feed parser broke, so it must not be in the denominator.
 *
 * Production, 2026-09-29 (read-only): inactive never-resolved 30, inactive
 * ever-resolved 27, active never-resolved 4, active ever-resolved 50. The old
 * share, 54 of 111, alarmed every hour; the new one, 50 of 77, does not. A
 * real collapse among the sources that ever worked still alarms.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const fake = vi.hoisted(() => ({ rows: {} as Record<string, Row[]> }));

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from(table: string) {
      // A counting query builder: each filter narrows the in-memory table and
      // awaiting the builder answers { count } the way a head count does.
      const filters: Array<(row: Row) => boolean> = [];
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return builder;
        },
        lt: (column: string, value: string) => {
          filters.push((row) => String(row[column]) < value);
          return builder;
        },
        gte: (column: string, value: string) => {
          filters.push((row) => String(row[column]) >= value);
          return builder;
        },
        not: (column: string, operator: string, value: unknown) => {
          if (operator !== 'is' || value !== null) throw new Error(`unsupported filter: not ${operator}`);
          filters.push((row) => row[column] !== null && row[column] !== undefined);
          return builder;
        },
        then: (
          resolve: (value: { count: number; data: null; error: null }) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => {
          const count = (fake.rows[table] ?? []).filter((row) => filters.every((f) => f(row))).length;
          return Promise.resolve({ count, data: null, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  }),
}));

import { contentSupplyWatchdog } from './content-supply-watchdog.js';

function sources(spec: {
  inactiveNever: number;
  inactiveEver: number;
  activeNever: number;
  activeEver: number;
}): Row[] {
  const rows: Row[] = [];
  const add = (n: number, is_active: boolean, resolved: boolean) => {
    for (let i = 0; i < n; i++) {
      rows.push({
        domain: 'poker',
        is_active,
        last_ok_at: resolved ? '2026-09-28T10:00:00.000Z' : null,
      });
    }
  };
  add(spec.inactiveNever, false, false);
  add(spec.inactiveEver, false, true);
  add(spec.activeNever, true, false);
  add(spec.activeEver, true, true);
  // A sports row never counts towards the poker share.
  rows.push({ domain: 'sports', is_active: false, last_ok_at: null });
  return rows;
}

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
  } as unknown as Parameters<typeof contentSupplyWatchdog>[0] & {
    readonly captured: { body: Record<string, unknown>; status: number };
  };
}

beforeEach(() => {
  // The other three checks are quiet: no stuck reels, a full and moving pool.
  const fresh = new Date().toISOString();
  fake.rows = {
    social_reels: [],
    poker_clips: Array.from({ length: 500 }, () => ({ is_active: true, created_at: fresh })),
    content_sources: [],
  };
});

describe('content supply watchdog, check 4: are the poker sources alive?', () => {
  it('registrations that never resolved do not trip the alarm (production shape, 2026-09-29)', async () => {
    fake.rows.content_sources = sources({ inactiveNever: 30, inactiveEver: 27, activeNever: 4, activeEver: 50 });
    const c = context();
    await contentSupplyWatchdog(c);
    expect(c.captured.status).toBe(200);
    expect(c.captured.body).toMatchObject({
      success: true,
      healthy: true,
      problems: [],
      facts: {
        reels_queued_over_6h: 0,
        poker_pool: 500,
        poker_clips_added_recently: 500,
        poker_sources_total: 111,
        poker_sources_active: 54,
        poker_sources_ever_resolved: 77,
        poker_sources_active_ever_resolved: 50,
      },
    });
  });

  it('a real collapse among the sources that ever resolved still alarms, and says so in those terms', async () => {
    fake.rows.content_sources = sources({ inactiveNever: 30, inactiveEver: 47, activeNever: 4, activeEver: 30 });
    const c = context();
    await contentSupplyWatchdog(c);
    expect(c.captured.status).toBe(200);
    expect(c.captured.body).toMatchObject({
      success: true,
      healthy: false,
      facts: {
        poker_sources_total: 111,
        poker_sources_active: 34,
        poker_sources_ever_resolved: 77,
        poker_sources_active_ever_resolved: 30,
      },
    });
    const problems = c.captured.body.problems as string[];
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^only 30 of 77 poker sources that ever resolved are still active - the resolver or the feed parser is broken, not the channels$/);
  });

  it('exactly half still active is the edge that does not alarm, one fewer does', async () => {
    fake.rows.content_sources = sources({ inactiveNever: 30, inactiveEver: 38, activeNever: 4, activeEver: 38 });
    const even = context();
    await contentSupplyWatchdog(even);
    expect(even.captured.body).toMatchObject({ healthy: true, problems: [] });

    fake.rows.content_sources = sources({ inactiveNever: 30, inactiveEver: 39, activeNever: 4, activeEver: 37 });
    const under = context();
    await contentSupplyWatchdog(under);
    expect(under.captured.body).toMatchObject({ healthy: false });
    expect((under.captured.body.problems as string[])[0]).toMatch(/^only 37 of 76 poker sources that ever resolved/);
  });

  it('a registry in which nothing has resolved yet is not a collapse', async () => {
    fake.rows.content_sources = sources({ inactiveNever: 30, inactiveEver: 0, activeNever: 4, activeEver: 0 });
    const c = context();
    await contentSupplyWatchdog(c);
    expect(c.captured.body).toMatchObject({
      healthy: true,
      problems: [],
      facts: {
        poker_sources_total: 34,
        poker_sources_active: 4,
        poker_sources_ever_resolved: 0,
        poker_sources_active_ever_resolved: 0,
      },
    });
  });
});
