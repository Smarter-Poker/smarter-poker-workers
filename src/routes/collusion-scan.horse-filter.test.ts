import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression cover for the horse-vs-horse suppression in collusion-scan.
 *
 * Before this filter the detector had written 169,523 rows since 2026-04-20,
 * of which 169,519 were horse-vs-horse - 99.99% WIN_RATE_ANOMALY at an average
 * suspicion_score of 97, and not one row had ever been reviewed. Horses are
 * house-run AI and cannot collude with each other, so those rows were pure
 * noise that buried the only signal worth having.
 *
 * The rules under test:
 *   1. a pair where BOTH sides are horses is dropped
 *   2. a pair with a human on either side survives (a horse leaking chips to
 *      a human must still surface)
 *   3. if the horse lookup fails the scan FAILS - it must never fall back to
 *      writing everything, which is the exact behaviour being fixed
 */

const HORSE_A = '11111111-1111-1111-1111-111111111111';
const HORSE_B = '22222222-2222-2222-2222-222222222222';
const HUMAN   = '33333333-3333-3333-3333-333333333333';

// One hand: three players, a clean winner, enough repetition to clear the
// >=30-shared-hands gate in scanWinRateAnomaly.
const mkHand = (i: number) => ({
  id: `hand-${i}`,
  table_id: 'table-1',
  hand_number: i,
  started_at: new Date().toISOString(),
  ended_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  players: [
    { userId: HORSE_A, stackBefore: 1000, stackAfter: 900 },
    { userId: HORSE_B, stackBefore: 1000, stackAfter: 1100 },
    { userId: HUMAN,   stackBefore: 1000, stackAfter: 1000 },
  ],
  winners: [{ userId: HORSE_B, amount: 100 }],
  actions: [],
  pot_size: 300,
  big_blind: 2,
  small_blind: 1,
});

const hands = Array.from({ length: 40 }, (_, i) => mkHand(i));

let horseLookupError: { message: string } | null = null;
/** The hands the hand_history stub will serve, and how many it has served. */
let handFixture: Array<Record<string, unknown>> = [];
let handsServed = 0;
/** Every filter set the route built, one entry per page it asked for. */
let handPages: Array<Record<string, any>> = [];
/** What fn_ca_collusion_scan_advance answers, and what it was called with. */
let advanceReply: { data: unknown; error: { message: string } | null } = {
  data: { ok: true, advanced_seconds: 1800 },
  error: null,
};
let advanceArgs: Record<string, unknown> | null = null;
/** Sizes of every id batch passed to the profiles .in() lookup. */
let horseLookupChunkSizes: number[] = [];
let insertedRows: unknown[] = [];

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === 'profiles') {
        const c: Record<string, any> = {};
        c.select = vi.fn().mockReturnValue(c);
        c.in = vi.fn().mockImplementation((_col: string, ids: string[]) => {
          horseLookupChunkSizes.push(ids.length);
          return c;
        });
        c.eq = vi.fn().mockResolvedValue(
          horseLookupError
            ? { data: null, error: horseLookupError }
            : { data: [{ id: HORSE_A }, { id: HORSE_B }], error: null },
        );
        return c;
      }
      if (table === 'hand_history') {
        // 2026-09-04: the scan pages on a KEYSET of (created_at, id) with a
        // wall-clock budget, not .range(). OFFSET paging over a window where
        // thousands of rows share a millisecond is not a total order, and an
        // unbudgeted read is what stopped this scan returning at all when the
        // platform went from 136k to 770k hands a day.
        //
        // THIS STUB RECORDS THE FILTERS IT WAS GIVEN, and the cases below
        // assert on those strings. The previous version returned `c` from
        // every filter and inspected none of them, so it would have passed
        // just as green with the cursor clause deleted, with the window
        // bounds swapped, or with the .gte() that makes the read an Index
        // Cond instead of a whole-window Filter absent - which is exactly the
        // defect it was supposed to be covering.
        //
        // It serves `handFixture` in pages of whatever `limit(n)` asks for.
        // A page shorter than n is what "the window is exhausted" looks like
        // to pagedSelectKeyset, so a fixture smaller than one page yields
        // complete:true in one call; a fixture that fills a page forces a
        // SECOND call carrying the cursor.
        const call: Record<string, any> = {};
        const c: Record<string, any> = {};
        c.select = vi.fn().mockReturnValue(c);
        c.gte = vi.fn().mockImplementation((col: string, val: string) => {
          call.gte = [col, val];
          return c;
        });
        c.lt = vi.fn().mockImplementation((col: string, val: string) => {
          call.lt = [col, val];
          return c;
        });
        c.or = vi.fn().mockImplementation((expr: string) => {
          call.or = expr;
          return c;
        });
        c.order = vi.fn().mockImplementation((col: string, o?: { ascending?: boolean }) => {
          (call.order ??= []).push([col, o?.ascending !== false]);
          return c;
        });
        c.limit = vi.fn().mockImplementation((n: number) => {
          const page = handFixture.slice(handsServed, handsServed + n);
          handsServed += page.length;
          call.limit = n;
          handPages.push({ ...call });
          return Promise.resolve({ data: page, error: null });
        });
        return c;
      }
      // collusion_tracking
      const c: Record<string, any> = {};
      c.insert = vi.fn().mockImplementation((rows: unknown[]) => {
        insertedRows = rows;
        return Promise.resolve({ data: null, error: null, count: rows.length });
      });
      return c;
    },
    // The scheduled path resumes from ca_collusion_scan_state rather than
    // reading a rolling window, and it FAILS rather than falling back when the
    // state cannot be read - falling back would quietly restore the 48x
    // overlap that killed the scan. So the stub has to answer the state read.
    rpc: vi.fn().mockImplementation((fn: string, args?: Record<string, unknown>) => {
      if (fn === 'fn_ca_collusion_scan_state') {
        return Promise.resolve({
          data: {
            ok: true,
            // Two hours behind, so windowFromState returns a real span even
            // after COMMIT_LAG_MS holds the ceiling back a minute.
            last_window_end: new Date(Date.now() - 2 * 3600_000).toISOString(),
            last_success_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
            seconds_behind: 7200,
          },
          error: null,
        });
      }
      if (fn === 'fn_ca_collusion_scan_advance') {
        advanceArgs = args ?? null;
        return Promise.resolve(advanceReply);
      }
      return Promise.resolve({ data: { ok: true }, error: null });
    }),
  }),
}));

// 2026-09-01: the scan now resolves its window through resolveScanWindow(),
// which reads c.req.query(). A context without req is no longer a valid stand-in
// for a Hono context, so the stub grows one. `query` is passed through so a test
// can exercise an explicit ?since=&until= rescan.
const makeCtx = (query: Record<string, string> = {}) => {
  let captured: { body?: any; status?: number } = {};
  return {
    req: {
      method: 'GET',
      query: () => query,
      json: async () => {
        throw new Error('no body');
      },
    },
    json: (body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return captured;
    },
    get captured() { return captured; },
  } as any;
};

describe('collusion-scan — horse-vs-horse suppression', () => {
  beforeEach(() => {
    horseLookupError = null;
    insertedRows = [];
    horseLookupChunkSizes = [];
    handFixture = hands;
    handsServed = 0;
    handPages = [];
    advanceReply = { data: { ok: true, advanced_seconds: 1800 }, error: null };
    advanceArgs = null;
  });

  it('never writes a row where both players are horses', async () => {
    const { collusionScan } = await import('./collusion-scan.js');
    const ctx = makeCtx();
    await collusionScan(ctx);

    const bothHorses = (insertedRows as Array<{ player_a: string; player_b: string }>).filter(
      (r) =>
        (r.player_a === HORSE_A || r.player_a === HORSE_B) &&
        (r.player_b === HORSE_A || r.player_b === HORSE_B),
    );
    expect(bothHorses).toHaveLength(0);
  });

  it('reports the suppression instead of hiding it', async () => {
    const { collusionScan } = await import('./collusion-scan.js');
    const ctx = makeCtx();
    await collusionScan(ctx);

    const body = ctx.captured.body;
    expect(body).toHaveProperty('suppressed_horse_pairs');
    expect(body).toHaveProperty('findings_after_horse_filter');
    expect(body.findings_after_horse_filter).toBe(insertedRows.length);
  });

  it('never asks for more ids in one lookup than PostgREST will accept', async () => {
    // The lookup serialises every id into the query string. While the scan was
    // capped at 1000 hands the list stayed small and one call worked; once it
    // read the full window the list grew until PostgREST refused the request
    // and the scan 500'd with "fetch failed". It is chunked now.
    const { collusionScan } = await import('./collusion-scan.js');
    await collusionScan(makeCtx());

    expect(horseLookupChunkSizes.length).toBeGreaterThan(0);
    for (const size of horseLookupChunkSizes) expect(size).toBeLessThanOrEqual(300);
    // Every id still gets looked at - chunking must not drop the tail.
    const total = horseLookupChunkSizes.reduce((a, b) => a + b, 0);
    expect(total).toBe(3);
  });

  it('fails the scan when the horse lookup errors, rather than writing everything', async () => {
    horseLookupError = { message: 'connection reset' };
    const { collusionScan } = await import('./collusion-scan.js');
    const ctx = makeCtx();
    await collusionScan(ctx);

    expect(ctx.captured.status).toBe(500);
    expect(String(ctx.captured.body.error)).toContain('horse lookup failed');
    expect(insertedRows).toHaveLength(0);
  });
});

/**
 * The paging contract, asserted against the filters the route actually built.
 *
 * Every case here failed to exist before 2026-09-04, and the review that found
 * that also found the defects they now pin. A test that only checks the mock
 * returned what the mock was told to return proves the mock works.
 */
describe('collusion-scan - what it actually asks Postgres for', () => {
  beforeEach(() => {
    horseLookupError = null;
    insertedRows = [];
    horseLookupChunkSizes = [];
    handFixture = hands;
    handsServed = 0;
    handPages = [];
    advanceReply = { data: { ok: true, advanced_seconds: 1800 }, error: null };
    advanceArgs = null;
  });

  it('bounds the first page by the window and orders it for a total order', async () => {
    const { collusionScan } = await import('./collusion-scan.js');
    const ctx = makeCtx();
    await collusionScan(ctx);

    expect(handPages.length).toBeGreaterThan(0);
    const first = handPages[0]!;
    const w = ctx.captured.body.window;
    expect(first.gte).toEqual(['created_at', w.start]);
    expect(first.lt).toEqual(['created_at', w.end]);
    // No cursor on the first page: it starts at the window's beginning.
    expect(first.or).toBeUndefined();
    // (created_at, id) ASCENDING. Ascending is what leaves an interrupted run
    // a contiguous unscanned TAIL instead of a hole in the middle; the id is
    // what breaks a millisecond tie so no row is read twice or skipped.
    expect(first.order).toEqual([
      ['created_at', true],
      ['id', true],
    ]);
  });

  it('carries the cursor as a plain >= as well as inside the or(), so the page is an index cond', async () => {
    // THE ONE-LINE DEFECT THIS PINS: with the cursor only inside `or=(...)`,
    // PostgREST produces a boolean expression the planner will not use as an
    // index condition. Page 40 measured 154.9ms and 21,099 buffers against
    // 8.6ms and 964 with the .gte() present - and it degraded with depth,
    // because each page re-scanned every page before it.
    handFixture = Array.from({ length: 1000 }, (_, i) => ({
      ...mkHand(i),
      id: `hand-${String(i).padStart(4, '0')}`,
      created_at: new Date(Date.now() - (1000 - i) * 1000).toISOString(),
    }));
    const { collusionScan } = await import('./collusion-scan.js');
    await collusionScan(makeCtx());

    // A full first page forces a second call carrying the cursor.
    expect(handPages.length).toBeGreaterThanOrEqual(2);
    const second = handPages[1]!;
    const lastOfPageOne = handFixture[999] as { id: string; created_at: string };

    expect(second.gte).toEqual(['created_at', lastOfPageOne.created_at]);
    expect(second.or).toBe(
      `created_at.gt.${lastOfPageOne.created_at},and(created_at.eq.${lastOfPageOne.created_at},id.gt.${lastOfPageOne.id})`,
    );
    // The window's upper bound survives paging - a cursor must never widen it.
    expect(second.lt).toEqual(handPages[0]!.lt);
  });

  it('tells the state there is more to read when it stopped on the ROW CAP, not only on the budget', async () => {
    // THE BLOCKER THIS PINS: the caller passed only the time-budget flag. A
    // six-hour catch-up span holds ~148,000 hands against a 40,000-row
    // ceiling, so every catch-up run stops on the row cap in about seven
    // seconds and never touches the budget - and the console renders this
    // flag as `catching_up`. It read "up to date" for the whole ~18 hours of
    // a catch-up.
    //
    // The fixture must OVERFLOW the row ceiling, or this case proves nothing:
    // with a fixture that fits, the read completes, and `readBudgetHit` and
    // `!readComplete` are both false - the broken formulation and the correct
    // one agree, and the test passes either way. 41,000 against a 40,000
    // ceiling is the smallest fixture that separates them.
    handFixture = Array.from({ length: 41_000 }, (_, i) => ({
      ...mkHand(i),
      id: `hand-${String(i).padStart(6, '0')}`,
      created_at: new Date(Date.now() - (41_000 - i) * 1000).toISOString(),
    }));
    const { collusionScan } = await import('./collusion-scan.js');
    const ctx = makeCtx();
    await collusionScan(ctx);

    // Stopped on the ROW CAP: 40,000 read, more in the window, and the clock
    // never came into it.
    expect(ctx.captured.body.scanned_hands).toBe(40_000);
    expect(ctx.captured.body.read_complete).toBe(false);
    expect(ctx.captured.body.read_budget_hit).toBe(false);
    // So the flag the console renders as `catching_up` MUST be true. Passing
    // the budget flag alone puts false here, which is the blocker.
    expect(advanceArgs).not.toBeNull();
    expect(advanceArgs!.p_budget_hit).toBe(true);
    expect(ctx.captured.body.hands_truncated).toBe(true);
  });

  it('fails the run when the findings landed but the mark did not move', async () => {
    // Answering 200 here means the next run re-reads the same window,
    // re-inserts the same findings, and does that forever while every row in
    // cron_execution_log says `success`.
    advanceReply = { data: { ok: false, reason: 'no_state_row' }, error: null };
    const { collusionScan } = await import('./collusion-scan.js');
    const ctx = makeCtx();
    await collusionScan(ctx);

    expect(ctx.captured.status).toBe(500);
    expect(ctx.captured.body.state_advanced).toBe(false);
    expect(String(ctx.captured.body.error)).toContain('no_state_row');
  });

  it('states how much ground the thresholds saw, because they were chosen for a 24h window', async () => {
    // PHASE5-CONTRACTS section 0: an integrity surface may never imply it is
    // watching something it is not watching. A resumed run is ~30 minutes and
    // the pair minimums (>=15 hands, >=30 for win rate) count hands shared
    // INSIDE one window, so a pair spread across runs cannot trigger yet.
    const { collusionScan } = await import('./collusion-scan.js');
    const ctx = makeCtx();
    await collusionScan(ctx);

    const body = ctx.captured.body;
    expect(typeof body.detection_span_minutes).toBe('number');
    expect(body.detection_thresholds.aggregates_across_runs).toBe(false);
    expect(body.detection_thresholds.min_shared_hands).toBeGreaterThan(0);
  });

  it('reports no covered_to on an operator rescan, which must never move the mark', async () => {
    const { collusionScan } = await import('./collusion-scan.js');
    const ctx = makeCtx({
      since: '2026-09-01T00:00:00Z',
      until: '2026-09-01T06:00:00Z',
    });
    await collusionScan(ctx);

    expect(ctx.captured.body.window_overridden).toBe(true);
    expect(ctx.captured.body.state_advanced).toBe(false);
    // Not the window end. Reporting one reads as though the live scan moved.
    expect(ctx.captured.body.covered_to).toBeNull();
    expect(advanceArgs).toBeNull();
  });
});
