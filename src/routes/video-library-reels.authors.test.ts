/**
 * Recertification A1, reels part (2026-09-21). A reel's author is
 * horses[hash(video) % horses.length], so the horse list must be complete
 * (the old read was clamped at 1,000 and unordered: horse 1,001 never got a
 * reel, and a video could change authors between runs), and a read that
 * fails part-way must create nothing rather than attribute to a partial list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => {
  const MAX_ROWS = 1000;
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {};
  const failAt: Record<string, number> = {};
  const requests: Record<string, number> = {};
  const inserted: Row[] = [];
  class Query {
    private filters: Array<(r: Row) => boolean> = [];
    private sortBy: { col: string; asc: boolean } | null = null;
    private start = 0;
    private end = Number.POSITIVE_INFINITY;
    private op: 'select' | 'insert' | 'update' = 'select';
    private rowsIn: Row[] = [];
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
    in(col: string, vs: unknown[]) {
      this.filters.push((r) => vs.includes(r[col]));
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
    insert(rows: Row[]) {
      this.op = 'insert';
      this.rowsIn = rows;
      return this;
    }
    update() {
      this.op = 'update';
      return this;
    }
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      if (this.op === 'insert') {
        inserted.push(...this.rowsIn);
        return Promise.resolve({ data: this.rowsIn.map((_, i) => ({ id: `reel-${i}` })), error: null }).then(resolve, reject);
      }
      if (this.op === 'update') return Promise.resolve({ data: null, error: null }).then(resolve, reject);
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
  return { tables, failAt, requests, inserted, Query };
});

vi.mock('../lib/supabase.js', () => ({ getSupabase: () => ({ from: (t: string) => new pg.Query(t) }) }));
vi.mock('../lib/content-engine/Fleet.js', () => ({ engineEnabled: async () => true }));

import { bridgeLibraryToReels } from './video-library-reels.js';
import { fleetHash } from '../lib/content-engine/FleetScheduler.js';

const horseIds = Array.from({ length: 1200 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
const videoIds = Array.from({ length: 40 }, (_, i) => `vid${String(i).padStart(8, '0')}`);

beforeEach(() => {
  for (const k of Object.keys(pg.failAt)) delete pg.failAt[k];
  for (const k of Object.keys(pg.requests)) delete pg.requests[k];
  pg.inserted.length = 0;
  pg.tables.content_sources = [
    { id: 's1', name: 'PokerGO', handle: null, category: null, aliases: [], domain: 'poker', kind: 'youtube_channel' },
  ];
  // Storage order is not id order, and there is a person in the table too.
  pg.tables.profiles = [
    ...horseIds.map((id) => ({ id, is_horse: true })),
    { id: 'f0000000-0000-4000-8000-000000000001', is_horse: false },
  ]
    .map((x, i) => ({ x, k: (i * 7919) % 1201 }))
    .sort((a, b) => a.k - b.k)
    .map((e) => e.x);
  pg.tables.video_library_videos = videoIds.map((id, i) => ({
    youtube_video_id: id,
    video_url: `https://www.youtube.com/watch?v=${id}`,
    title: `Final table hand ${i}`,
    source_name: 'PokerGO',
    thumbnail_url: null,
    published_at: `2026-09-${String(1 + (i % 20)).padStart(2, '0')}T00:00:00Z`,
  }));
  pg.tables.social_reels = [];
});

describe('the reels bridge draws authors from every horse, in a stable order', () => {
  it('attributes each reel to horses[hash % 1,200] of the id-ordered list', async () => {
    const out = await bridgeLibraryToReels(false);
    expect(out.created).toBe(40);
    const byUrl = new Map(pg.inserted.map((r) => [r.video_url as string, r.author_id as string]));
    for (const id of videoIds) {
      const expected = horseIds[fleetHash(id, 'reel-author') % horseIds.length];
      expect(byUrl.get(`https://www.youtube.com/watch?v=${id}`)).toBe(expected);
    }
    // At least one reel lands on a horse beyond the old 1,000-row cut.
    expect(pg.inserted.some((r) => horseIds.indexOf(r.author_id as string) >= 1000)).toBe(true);
    expect(pg.inserted.every((r) => r.author_id !== 'f0000000-0000-4000-8000-000000000001')).toBe(true);
  });

  it('a horse page that fails part-way creates no reels', async () => {
    pg.failAt.profiles = 1;
    const out = await bridgeLibraryToReels(false);
    expect(out.created).toBe(0);
    expect(pg.inserted).toHaveLength(0);
  });
});
