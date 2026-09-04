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
        // The stub serves the whole fixture on the first page. `limit(n)` with
        // n > fixture length is a SHORT page, which is what "the window is
        // exhausted" looks like to pagedSelectKeyset - so `complete` is true
        // and the caller may advance its mark to the window end.
        const c: Record<string, any> = {};
        let served = false;
        c.select = vi.fn().mockReturnValue(c);
        c.gte = vi.fn().mockReturnValue(c);
        c.lt = vi.fn().mockReturnValue(c);
        c.or = vi.fn().mockReturnValue(c);
        c.order = vi.fn().mockReturnValue(c);
        c.limit = vi.fn().mockImplementation(() => {
          const page = served ? [] : hands;
          served = true;
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
    rpc: vi.fn().mockImplementation((fn: string) => {
      if (fn === 'fn_ca_collusion_scan_state') {
        return Promise.resolve({
          data: {
            ok: true,
            last_window_end: new Date(Date.now() - 30 * 60_000).toISOString(),
            last_success_at: new Date(Date.now() - 30 * 60_000).toISOString(),
            seconds_behind: 1800,
          },
          error: null,
        });
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
