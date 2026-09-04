/**
 * Keyset (cursor) paging with a wall-clock budget, for the integrity sweeps.
 *
 * WHY THIS EXISTS, BESIDE pagedSelect (2026-09-04)
 * ------------------------------------------------
 * `pagedSelect` pages with OFFSET and reads up to a fixed row ceiling. It
 * fixed a real bug - PostgREST silently clamps a `.limit(50000)` to 1000, so
 * the collusion scan had been examining ~0.36% of play - and it is still the
 * right tool for a bounded set.
 *
 * It is the wrong tool for a sweep over `hand_history`, for two reasons the
 * detector's death on 2026-09-03 made concrete:
 *
 * 1. NO BUDGET. `pagedSelect` reads until it hits its ceiling, however long
 *    that takes. When the platform went from 136,000 hands a day to 770,000
 *    in four days, the collusion scan stopped returning at all: not slow,
 *    never finished. The only signal was the workers container's own sweeper
 *    marking the row `killed` thirty minutes later, and nothing watched that
 *    table. A sweep that cannot finish must return what it has and SAY SO,
 *    because a partial answer an operator can see beats a perfect one nobody
 *    ever receives.
 *
 * 2. NO STABLE ORDER. `.order('created_at')` with OFFSET, on a table where
 *    thousands of rows share a millisecond, does not define a total order.
 *    Two pages can return the same row and skip another, silently. A 24-hour
 *    window currently holds ~700,000 hands and `created_at` is not unique
 *    within it.
 *
 * This helper pages on a CURSOR of `(created_at, id)` - a real total order,
 * because `id` breaks every tie - and stops on whichever comes first: the row
 * ceiling, the end of the window, or the time budget. It reports which.
 *
 * ASCENDING, DELIBERATELY. `pagedSelect` reads newest-first so a truncated
 * scan sees the most recent slice. A RESUMABLE scan wants the opposite:
 * oldest-first, so stopping early leaves a contiguous unscanned TAIL that the
 * next run picks up from `cursorEnd`. Newest-first would leave the hole in the
 * middle of the window instead - which is exactly the "never examined by
 * anything and never would be" gap scanWindow.ts was written to close.
 */
import type { PostgrestFilterBuilder } from '@supabase/postgrest-js';
import { withDeadline } from './withDeadline.js';

export const PAGE_SIZE = 1000;

/**
 * PostgREST's `db-max-rows`, which this project has set to 1000.
 *
 * IT IS NOT A HINT. Ask for 50,000 rows and the server returns 1,000 with a
 * 200 - that silent clamp is what had the collusion scan reading 0.36% of its
 * window while reporting success. `complete` here is derived from a SHORT PAGE
 * ("I asked for N and got fewer, so the window is exhausted"), and that
 * inference is only sound while N is a size the server will actually honour.
 * At `pageSize` 1000 it holds because 1000 IS the clamp - by exact
 * coincidence, which is not a thing to leave load-bearing and undeclared.
 * Raise the clamp and the assertion below tells you; raise the page size past
 * it and every full page reads as short, so a run stops after 1,000 rows and
 * calls the window COMPLETE. That is the "hands nobody ever examined" failure,
 * arrived at from the other direction.
 */
export const SERVER_MAX_ROWS = 1000;

/**
 * Default ceiling on a single page. Measured: a 1,000-row page of
 * hand_history with its JSONB attached is under 900ms from a laptop, so
 * thirty seconds means hung, not busy.
 */
export const DEFAULT_PAGE_DEADLINE_MS = 30_000;

export interface KeysetRow {
  id: string;
  created_at: string;
}

export interface KeysetResult<T> {
  /**
   * Every row read - EMPTY when `onPage` was supplied, because the point of
   * `onPage` is not to hold them. Read `count` instead.
   */
  rows: T[];
  /** Rows read, whether or not they were retained. */
  count: number;
  /** The `created_at` of the last row read, or null when nothing was read. */
  cursorEnd: string | null;
  /** Stopped because the row ceiling was reached. */
  hitRowCap: boolean;
  /** Stopped because the time budget ran out. */
  hitBudget: boolean;
  /** True when the window was read to its end: nothing was left behind. */
  complete: boolean;
  pages: number;
  durationMs: number;
}

export interface KeysetOptions<T extends KeysetRow = KeysetRow> {
  /** Hard ceiling on rows, so one run cannot read an unbounded window. */
  maxRows: number;
  /** Wall-clock budget in ms. The loop checks it BEFORE each page. */
  budgetMs: number;
  /**
   * Ceiling on ONE page.
   *
   * The overall budget is checked BETWEEN pages, so it bounds a slow read and
   * does nothing at all about a hung one: if page 27 never answers, the loop
   * never reaches the next check and the whole handler waits forever. That is
   * not hypothetical - it is the shape of the run that sat at `running` for
   * ten minutes on 2026-09-04 while the same read completed in 37s from a
   * laptop. A budget that only applies when the thing is making progress is
   * not a budget.
   */
  pageDeadlineMs?: number;
  pageSize?: number;
  /** Injectable for tests. */
  now?: () => number;
  /**
   * Fold each page as it arrives instead of accumulating every row.
   *
   * WHY (2026-09-04). A run over a 106-minute window read 40,000 rows of
   * `hand_history` WITH its `actions` JSONB attached and then vanished: the
   * log row stayed `running` with no error and no completion, the container
   * stayed healthy and served every other cron in milliseconds, and every
   * await in the handler was already deadline-bounded. A process that
   * disappears mid-request without raising anything is not hanging on I/O,
   * and the only thing in the handler that grows with the window is the array
   * of rows it holds.
   *
   * SAID PLAINLY: that is inferred from the SHAPE, not measured. The
   * container's memory is not visible from here. What IS measured is that the
   * same read and the same analysis complete in 37.6s and 525ms off-box with
   * no limit, so the difference is the environment, not the work.
   *
   * With `onPage` the caller keeps only what it needs - for the collusion
   * scan, a slim per-hand record and the derived actions, about 36 MB instead
   * of the whole payload plus its parsed object graph - and peak memory stops
   * scaling with MAX_SCAN_HANDS. It is the change PHASE5-CONTRACTS section 1
   * asked for ("select only the columns the detectors actually use; the
   * actions JSONB is the bulk of the payload"), done at the right layer:
   * every caller of this helper gets it, and the column list stays honest.
   */
  onPage?: (rows: T[]) => void;
}

/**
 * `build(afterCreatedAt, afterId)` must return a FRESH query each call - a
 * PostgREST builder is a one-shot thenable. With a null cursor the query
 * should start at the window's beginning.
 */
export async function pagedSelectKeyset<T extends KeysetRow>(
  build: (
    afterCreatedAt: string | null,
    afterId: string | null,
  ) => PostgrestFilterBuilder<any, any, any, any, any>,
  opts: KeysetOptions<T>,
): Promise<KeysetResult<T>> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > SERVER_MAX_ROWS) {
    // Refuse rather than silently under-read. See SERVER_MAX_ROWS.
    throw new Error(
      `pagedSelectKeyset: pageSize ${pageSize} must be 1..${SERVER_MAX_ROWS} ` +
        `(PostgREST clamps beyond that, and a clamped page reads as the end of the window)`,
    );
  }
  const now = opts.now ?? ((): number => Date.now());
  const started = now();

  const rows: T[] = [];
  let count = 0;
  let pages = 0;
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  let hitRowCap = false;
  let hitBudget = false;
  let complete = false;

  for (;;) {
    if (count >= opts.maxRows) {
      hitRowCap = true;
      break;
    }
    // Checked BEFORE the page, not after: a budget checked after the fact has
    // already spent the time it was meant to protect.
    if (now() - started >= opts.budgetMs) {
      hitBudget = true;
      break;
    }

    const want = Math.min(pageSize, opts.maxRows - count);
    const { data, error } = await withDeadline(
      build(cursorCreatedAt, cursorId).limit(want),
      opts.pageDeadlineMs ?? DEFAULT_PAGE_DEADLINE_MS,
      `page ${pages + 1} (${want} rows after ${cursorCreatedAt ?? 'the window start'})`,
    );
    pages += 1;
    if (error) throw new Error(error.message);

    const batch = (data ?? []) as T[];
    if (batch.length === 0) {
      complete = true;
      break;
    }

    count += batch.length;
    if (opts.onPage) opts.onPage(batch);
    else rows.push(...batch);
    const last = batch[batch.length - 1]!;
    cursorCreatedAt = last.created_at;
    cursorId = last.id;

    // A short page means the window is exhausted. Nothing is left behind, so
    // the caller may advance its mark to the window's end rather than to the
    // last row read.
    if (batch.length < want) {
      complete = true;
      break;
    }
  }

  return {
    rows,
    count,
    cursorEnd: cursorCreatedAt,
    hitRowCap,
    hitBudget,
    complete,
    pages,
    durationMs: now() - started,
  };
}
