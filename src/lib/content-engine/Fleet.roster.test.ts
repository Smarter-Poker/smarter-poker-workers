/**
 * Recertification A7, B1 and D2 (2026-09-21).
 *
 *   A7: the roster is only profiles that ARE horses (profiles.is_horse).
 *   B1: a horse posts only once it has a face (profiles.avatar_url), the same
 *       test fn_horses_not_social_ready applies.
 *   Both reads are complete past PostgREST's 1,000-row clamp and fail closed.
 *   D2: the kill switch can be read fresh, and a slow ON answer can never
 *       overwrite a newer OFF answer in the cache.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => {
  const MAX_ROWS = 1000; // db-max-rows on this project
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {};
  const failAt: Record<string, number> = {};
  const requests: Record<string, number> = {};
  class Query {
    private filters: Array<(r: Row) => boolean> = [];
    private sortBy: { col: string; asc: boolean } | null = null;
    private start = 0;
    private end = Number.POSITIVE_INFINITY;
    constructor(private table: string) {}
    select() {
      return this;
    }
    eq(col: string, v: unknown) {
      this.filters.push((r) => r[col] === v);
      return this;
    }
    not(col: string, op: string, v: unknown) {
      if (op !== 'is' || v !== null) throw new Error('fake supports not.is.null only');
      this.filters.push((r) => r[col] !== null && r[col] !== undefined);
      return this;
    }
    gt(col: string, v: string | number) {
      this.filters.push((r) => (r[col] as string | number) > v);
      return this;
    }
    order(col: string, o?: { ascending?: boolean }) {
      this.sortBy = { col, asc: o?.ascending !== false };
      return this;
    }
    range(a: number, b: number) {
      this.start = a;
      this.end = b;
      return this;
    }
    limit(n: number) {
      this.end = this.start + n - 1;
      return this;
    }
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      const n = (requests[this.table] = (requests[this.table] ?? 0) + 1) - 1;
      if (failAt[this.table] === n) {
        return Promise.resolve({ data: null, error: { message: `${this.table} unavailable` } }).then(resolve, reject);
      }
      let rows = (tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
      if (this.sortBy) {
        const { col, asc } = this.sortBy;
        rows = [...rows].sort((x, y) => {
          const a = x[col] as string | number;
          const b = y[col] as string | number;
          return (a < b ? -1 : a > b ? 1 : 0) * (asc ? 1 : -1);
        });
      }
      rows = rows.slice(this.start, Math.min(this.end + 1, this.start + MAX_ROWS));
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    }
  }
  return { tables, failAt, requests, Query };
});

type SwitchAnswer = () => Promise<{ data: unknown; error: unknown }>;
const sw = vi.hoisted(() => ({ next: [] as Array<() => Promise<{ data: unknown; error: unknown }>>, reads: 0 }));

vi.mock('../supabase.js', () => ({
  getSupabase: () => ({
    from(table: string) {
      if (table === 'content_settings') {
        const chain: Record<string, unknown> = {};
        Object.assign(chain, {
          select: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => {
            sw.reads += 1;
            const answer = sw.next.shift();
            if (!answer) throw new Error('unexpected switch read');
            return answer();
          },
        });
        return chain;
      }
      return new pg.Query(table);
    },
  }),
}));

import {
  _resetEngineSwitchCache,
  engineEnabled,
  engineSwitch,
  loadFleet,
  postingReadyHorseIds,
} from './Fleet.js';

const pid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function seed() {
  const authors: Array<Record<string, unknown>> = [];
  const profiles: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= 1200; i++) {
    authors.push({ id: i, name: `Horse ${i}`, profile_id: pid(i), is_active: true, timezone: 'UTC' });
    profiles.push({ id: pid(i), is_horse: true, avatar_url: `https://cdn.example/a/${i}.jpg` });
  }
  // A content_authors row pointing at a person's profile.
  authors.push({ id: 1201, name: 'Hand-written row', profile_id: 'f0000000-0000-4000-8000-000000000001', is_active: true });
  profiles.push({ id: 'f0000000-0000-4000-8000-000000000001', is_horse: false, avatar_url: 'https://cdn.example/p.jpg' });
  // A horse that was just born and has no face yet.
  authors.push({ id: 1202, name: 'Newborn', profile_id: 'f0000000-0000-4000-8000-000000000002', is_active: true });
  profiles.push({ id: 'f0000000-0000-4000-8000-000000000002', is_horse: true, avatar_url: null });
  // Inactive, and not linked at all: excluded before and after.
  authors.push({ id: 1203, name: 'Retired', profile_id: pid(1203), is_active: false });
  profiles.push({ id: pid(1203), is_horse: true, avatar_url: 'https://cdn.example/r.jpg' });
  authors.push({ id: 1204, name: 'Unlinked', profile_id: null, is_active: true });
  // Storage order is not id order.
  const shuffle = <T,>(xs: T[]) => xs.map((x, i) => ({ x, k: (i * 7919) % 1231 })).sort((a, b) => a.k - b.k).map((e) => e.x);
  pg.tables.content_authors = shuffle(authors);
  pg.tables.profiles = shuffle(profiles);
}

beforeEach(() => {
  seed();
  for (const k of Object.keys(pg.failAt)) delete pg.failAt[k];
  for (const k of Object.keys(pg.requests)) delete pg.requests[k];
  sw.next = [];
  sw.reads = 0;
  _resetEngineSwitchCache();
});

describe('loadFleet: only horses with a face, read completely', () => {
  it('drops a person profile and a faceless horse, keeps all 1,200 horses past the row clamp', async () => {
    const roster = await loadFleet();
    const ids = roster.map((h) => h.profile_id);
    expect(ids).toHaveLength(1200);
    expect(ids).toEqual(Array.from({ length: 1200 }, (_, i) => pid(i + 1)));
    expect(ids).not.toContain('f0000000-0000-4000-8000-000000000001');
    expect(ids).not.toContain('f0000000-0000-4000-8000-000000000002');
  });

  it('reads the horse allowlist in keyset pages under the clamp', async () => {
    const ready = await postingReadyHorseIds();
    expect(ready.size).toBe(1201); // 1,200 roster horses plus the retired one with a face
    expect(ready.has('f0000000-0000-4000-8000-000000000001')).toBe(false);
    expect(ready.has('f0000000-0000-4000-8000-000000000002')).toBe(false);
    expect(pg.requests.profiles).toBeGreaterThanOrEqual(3);
  });

  it('an unreadable profile page means no roster at all', async () => {
    pg.failAt.profiles = 1;
    await expect(loadFleet()).rejects.toThrow(/horse profile read failed/);
  });
});

const on: SwitchAnswer = () => Promise.resolve({ data: { engine_enabled: true }, error: null });
const off: SwitchAnswer = () => Promise.resolve({ data: { engine_enabled: false }, error: null });

describe('the kill switch', () => {
  it('a fresh read skips the cache, and what it sees is what the cache keeps', async () => {
    sw.next = [on];
    expect(await engineEnabled()).toBe(true);
    sw.next = [off];
    expect(await engineEnabled()).toBe(true); // inside the 30s cache, no read
    expect(sw.reads).toBe(1);
    expect(await engineEnabled({ fresh: true })).toBe(false);
    expect(sw.reads).toBe(2);
    expect(await engineEnabled()).toBe(false); // the OFF answer is cached
    expect(sw.reads).toBe(2);
  });

  it('a slow ON answer cannot land after a newer OFF answer and turn the fleet back on', async () => {
    let release: (v: { data: unknown; error: unknown }) => void = () => undefined;
    const slow = new Promise<{ data: unknown; error: unknown }>((r) => {
      release = r;
    });
    sw.next = [() => slow, off];
    const older = engineEnabled({ fresh: true });
    const newer = engineEnabled({ fresh: true });
    expect(await newer).toBe(false);
    release({ data: { engine_enabled: true }, error: null });
    expect(await older).toBe(false);
    expect(await engineEnabled()).toBe(false);
    expect(sw.reads).toBe(2);
  });

  it('a read that throws is OFF, and is remembered as unreadable, never as ON', async () => {
    sw.next = [() => Promise.reject(new Error('fetch failed'))];
    expect(await engineEnabled()).toBe(false);
    expect(await engineSwitch()).toBe('unreadable');
    expect(sw.reads).toBe(1);
  });

  it('an unreadable or missing row is unreadable, not a decision', async () => {
    sw.next = [() => Promise.resolve({ data: null, error: { message: 'permission denied' } }), () => Promise.resolve({ data: null, error: null })];
    expect(await engineSwitch({ fresh: true })).toBe('unreadable');
    expect(await engineSwitch({ fresh: true })).toBe('unreadable');
  });
});
