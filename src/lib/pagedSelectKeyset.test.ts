/**
 * The keyset pager, which exists because the collusion detector DIED.
 *
 * Every case here is a property the old OFFSET pager did not have, and the
 * absence of each one cost something real on 2026-09-03:
 *   - no budget      -> the scan never returned, and the only signal was a
 *                       `killed` row written half an hour later by a sweeper
 *                       nobody was watching;
 *   - no total order -> OFFSET over rows sharing a millisecond can repeat one
 *                       row and skip another, silently;
 *   - newest-first   -> an interrupted scan left a hole in the middle of the
 *                       window instead of a resumable tail.
 */
import { describe, expect, it, vi } from 'vitest';
import { pagedSelectKeyset, type KeysetRow } from './pagedSelectKeyset.js';

interface Row extends KeysetRow {
  n: number;
}

/** A fake table of `count` rows, paged by (created_at, id). */
function fakeTable(count: number, sharedTimestamp = false) {
  const rows: Row[] = Array.from({ length: count }, (_, i) => ({
    id: `id-${String(i).padStart(6, '0')}`,
    // sharedTimestamp reproduces the real hazard: thousands of hands landing
    // inside the same millisecond.
    created_at: sharedTimestamp
      ? '2026-09-04T00:00:00.000Z'
      : new Date(1_700_000_000_000 + i * 1000).toISOString(),
    n: i,
  }));

  const calls: Array<{ afterCreatedAt: string | null; afterId: string | null; limit: number }> = [];

  const build = (afterCreatedAt: string | null, afterId: string | null) => ({
    limit: (n: number) => {
      calls.push({ afterCreatedAt, afterId, limit: n });
      let start = 0;
      if (afterCreatedAt !== null && afterId !== null) {
        start = rows.findIndex(
          (r) =>
            r.created_at > afterCreatedAt ||
            (r.created_at === afterCreatedAt && r.id > afterId),
        );
        if (start < 0) start = rows.length;
      }
      return Promise.resolve({ data: rows.slice(start, start + n), error: null });
    },
  });

  return { rows, calls, build: build as never };
}

describe('pagedSelectKeyset', () => {
  it('reads a whole window and reports it complete', async () => {
    const t = fakeTable(2_500);
    const res = await pagedSelectKeyset<Row>(t.build, {
      maxRows: 10_000,
      budgetMs: 60_000,
      pageSize: 1_000,
    });
    expect(res.rows).toHaveLength(2_500);
    expect(res.complete).toBe(true);
    expect(res.hitBudget).toBe(false);
    expect(res.hitRowCap).toBe(false);
    // Every row exactly once, in order.
    expect(new Set(res.rows.map((r) => r.id)).size).toBe(2_500);
    expect(res.rows[0]!.n).toBe(0);
    expect(res.rows[2_499]!.n).toBe(2_499);
  });

  it('reads every row exactly once even when they share a timestamp', async () => {
    // THE CORRECTNESS BUG THE OLD PAGER HAD. With OFFSET and a non-unique sort
    // key there is no total order, so a page boundary can repeat and skip.
    const t = fakeTable(3_000, true);
    const res = await pagedSelectKeyset<Row>(t.build, {
      maxRows: 10_000,
      budgetMs: 60_000,
      pageSize: 1_000,
    });
    expect(res.rows).toHaveLength(3_000);
    expect(new Set(res.rows.map((r) => r.id)).size).toBe(3_000);
    expect(res.complete).toBe(true);
  });

  it('stops on the time budget and says so, rather than never returning', async () => {
    // The whole point. A sweep that cannot finish returns what it has.
    const t = fakeTable(1_000_000);
    let clock = 0;
    const res = await pagedSelectKeyset<Row>(t.build, {
      maxRows: 1_000_000,
      budgetMs: 5_000,
      pageSize: 1_000,
      // Each page "costs" 2s, so the budget bites on the third check.
      now: () => (clock += 2_000) && clock,
    });
    expect(res.hitBudget).toBe(true);
    expect(res.complete).toBe(false);
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.rows.length).toBeLessThan(1_000_000);
    // And it hands back where to resume, so the tail is not lost.
    expect(res.cursorEnd).toBe(res.rows[res.rows.length - 1]!.created_at);
  });

  it('stops on the row ceiling and says so', async () => {
    const t = fakeTable(50_000);
    const res = await pagedSelectKeyset<Row>(t.build, {
      maxRows: 4_000,
      budgetMs: 60_000,
      pageSize: 1_000,
    });
    expect(res.rows).toHaveLength(4_000);
    expect(res.hitRowCap).toBe(true);
    expect(res.complete).toBe(false);
    expect(res.hitBudget).toBe(false);
  });

  it('reads ascending, so an interrupted run leaves a resumable tail', async () => {
    // Newest-first would leave the hole in the MIDDLE of the window, which is
    // the "never examined by anything and never would be" gap scanWindow.ts
    // exists to prevent.
    const t = fakeTable(5_000);
    const res = await pagedSelectKeyset<Row>(t.build, {
      maxRows: 2_000,
      budgetMs: 60_000,
      pageSize: 1_000,
    });
    expect(res.rows[0]!.n).toBe(0);
    expect(res.rows[1_999]!.n).toBe(1_999);
    expect(res.cursorEnd).toBe(t.rows[1_999]!.created_at);
  });

  it('handles an empty window without claiming truncation', async () => {
    const t = fakeTable(0);
    const res = await pagedSelectKeyset<Row>(t.build, { maxRows: 100, budgetMs: 60_000 });
    expect(res.rows).toHaveLength(0);
    expect(res.complete).toBe(true);
    expect(res.cursorEnd).toBeNull();
  });

  it('passes the cursor forward on every page after the first', async () => {
    const t = fakeTable(2_500);
    await pagedSelectKeyset<Row>(t.build, { maxRows: 10_000, budgetMs: 60_000, pageSize: 1_000 });
    expect(t.calls[0]!.afterCreatedAt).toBeNull();
    expect(t.calls[0]!.afterId).toBeNull();
    expect(t.calls[1]!.afterId).toBe('id-000999');
    expect(t.calls[2]!.afterId).toBe('id-001999');
  });

  it('propagates a read error rather than reporting a short clean scan', async () => {
    const build = (() => ({
      limit: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
    })) as never;
    await expect(
      pagedSelectKeyset(build, { maxRows: 100, budgetMs: 60_000 }),
    ).rejects.toThrow('boom');
  });
});
