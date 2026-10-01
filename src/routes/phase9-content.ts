/**
 * GET/POST /cron/phase9-content
 *
 * Phase 9.1 of the Fleet Content Programme: the hourly pick for the hand
 * replay renderer. One fire enqueues AT MOST ONE horse hand clip job in
 * hand_clip_jobs. The World Hub cron (/api/cron/render-hand-clips) renders
 * the job and, because the job says auto_publish, fn_p9_publish_hand_clip
 * posts the clip while the mode row is on. Nothing here renders, posts,
 * polls, sleeps, retries or schedules anything; what a fire leaves undone is
 * due again on the next scheduled fire, and a failed clip job is final until
 * a person re-queues it.
 *
 * One fire, in this order (design section 7.3, contract C7):
 *   1. the master switch (content_settings.engine_enabled), then the mode row
 *      (horse_post_modes 'hand_clip'). Both fail closed: an unreadable switch
 *      is a skip, never a publish, and a skip reads no reviews;
 *   2. the pool: the newest POOL_MAX_ROWS winning rows of horse_hand_reviews
 *      in the last WINDOW_HOURS, bounded on played_at (idx_hhr_played is the
 *      table's only time index; created_at trails played_at by under a
 *      minute), ranked by pot_size / big_blind DESC then created_at DESC,
 *      pots under MIN_POT_BIG_BLINDS big blinds dropped. PostgREST cannot
 *      order by a quotient, so the ranking is done here over a bounded pool
 *      and the response says whether the pool was the whole window;
 *   3. a hand this horse already has a hand_clip_jobs row for is excluded
 *      (one IN read over the top EXCLUSION_CHECK_ROWS); the first
 *      CANDIDATE_LIMIT survivors are the candidates;
 *   4. in order, the first candidate whose horse has an open fleet slot
 *      (fleetSlotId over content_authors.timezone, the clock every fleet
 *      route uses) is the pick. The slot names the publication key, so the
 *      clip and the horse's ordinary fleet post can never both fill it;
 *   5. the caption is a fixed template over the row's own numbers and a
 *      fixed variant label: no model call, no name, no invented fact;
 *   6. one insert. Postgres 23505 on (hand_id, author_id, style) means
 *      another run already enqueued it: counted as a duplicate, not an error.
 *
 * `?dry_run=1` (or `?preview=1`, the Phase 7 spelling) computes the pick and
 * the caption and writes nothing; `at=<iso>` steers a dry run's clock only.
 *
 * Registered exactly like the Phase 7 route (src/index.ts): behind the IP
 * allowlist and the cron secret, with the cron middleware writing this
 * request's JSON result to cron_execution_log.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { pagedSelect } from '../lib/pagedSelect.js';
import { engineSwitch, readPostModeStates, type EngineSwitchState } from '../lib/content-engine/Fleet.js';
import { fleetPublicationKey, fleetSlotId } from '../lib/content-engine/HorsePublisher.js';

export const HAND_CLIP_MODE = 'hand_clip';
export const CLIP_STYLE = 'felt-720p';
/** Reviews played inside this many hours of `now` are in the window. */
export const WINDOW_HOURS = 24;
/** A pot smaller than this many big blinds is not worth a clip. */
export const MIN_POT_BIG_BLINDS = 20;
/** The newest winning rows of the window the ranking sees: two PostgREST pages. */
export const POOL_MAX_ROWS = 2_000;
/** How many of the best-ranked rows are checked against hand_clip_jobs in one IN read. */
export const EXCLUSION_CHECK_ROWS = 40;
/** Candidates tried for an open slot, in rank order. */
export const CANDIDATE_LIMIT = 10;
/** Inside the dispatcher's 300 s budget for this job, like Phase 7. */
export const DEADLINE_MS = 240_000;
const UNIQUE_VIOLATION = '23505';

export const DRY_RUN_WRITES_NOTE =
  'Dry run makes no writes: no hand_clip_jobs row, no post, no RPC. '
  + 'The only write is the cron middleware logging this request in cron_execution_log.';

const REVIEW_COLUMNS = 'id, hand_id, horse_user_id, game_variant, big_blind, pot_size, seat, is_win, played_at, created_at';

type Supa = ReturnType<typeof getSupabase>;

export type Phase9Skip =
  | 'engine_disabled'
  | 'engine_unreadable'
  | 'mode_disabled'
  | 'mode_unreadable'
  | 'no_candidates'
  | 'no_slot'
  | 'duplicate'
  | 'deadline';

export type ModeState = 'on' | 'off' | 'unreadable';

export interface ReviewRow {
  id: number | string;
  hand_id: string;
  horse_user_id: string;
  game_variant: string | null;
  big_blind: number;
  pot_size: number;
  seat: number | null;
  played_at: string;
  created_at: string;
}

export interface Candidate {
  review: ReviewRow;
  /** pot_size / big_blind, the rank. */
  pot_bb: number;
}

export interface Phase9Pick {
  hand_id: string;
  author_id: string;
  slot: string;
  publication_key: string;
  caption: string;
  review_id: number | string;
  pot_bb: number;
}

export interface Phase9Result {
  ok: true;
  dry_run: boolean;
  at: string;
  enqueued: 0 | 1;
  candidates: number;
  job_id?: string;
  skipped?: Phase9Skip;
  pick?: Phase9Pick;
  gates: { engine: EngineSwitchState | 'not_read'; mode: ModeState | 'not_read' };
  pool: {
    read: number;
    eligible: number;
    /** True when the window held more winning rows than POOL_MAX_ROWS. */
    truncated: boolean;
    checked_for_jobs: number;
    already_clipped: number;
    dropped: { malformed: number; small_pot: number };
  };
  passed_over: { no_slot: number; not_on_roster: number; caption_law: number };
  duplicates: number;
  limits: {
    window_hours: number;
    min_pot_big_blinds: number;
    pool_max_rows: number;
    exclusion_check_rows: number;
    candidate_limit: number;
    deadline_ms: number;
  };
  notes: string[];
  duration_ms: number;
  timestamp: string;
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

// ---------------------------------------------------------------------------
// The pool and the rank (pure)
// ---------------------------------------------------------------------------

/** One review row as the pick needs it, or null when a column is not usable. */
export function parseReview(raw: unknown): ReviewRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'number' || typeof row.id === 'string' ? row.id : null;
  const handId = text(row.hand_id);
  const horse = text(row.horse_user_id);
  const bigBlind = num(row.big_blind);
  const pot = num(row.pot_size);
  const playedAt = text(row.played_at);
  const createdAt = text(row.created_at);
  if (id === null || !handId || !horse || !playedAt || !createdAt) return null;
  if (bigBlind === null || bigBlind <= 0 || pot === null || pot < 0) return null;
  // The read filters on is_win; a row that carries the column must agree.
  if ('is_win' in row && row.is_win !== true) return null;
  const seat = num(row.seat);
  return {
    id,
    hand_id: handId,
    horse_user_id: horse,
    game_variant: typeof row.game_variant === 'string' ? row.game_variant : null,
    big_blind: bigBlind,
    pot_size: pot,
    seat: seat !== null && Number.isInteger(seat) && seat >= 0 ? seat : null,
    played_at: playedAt,
    created_at: createdAt,
  };
}

function timeOf(value: string): number {
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

function compareIdDesc(a: number | string, b: number | string): number {
  const na = num(a);
  const nb = num(b);
  if (na !== null && nb !== null) return nb - na;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? 1 : sa > sb ? -1 : 0;
}

export interface PoolSelection {
  read: number;
  /** Eligible rows, best first: pot in big blinds DESC, then created_at DESC, then id DESC. */
  ranked: Candidate[];
  dropped: { malformed: number; small_pot: number };
}

export function rankPool(rows: unknown[]): PoolSelection {
  const ranked: Candidate[] = [];
  const dropped = { malformed: 0, small_pot: 0 };
  for (const raw of rows) {
    const review = parseReview(raw);
    if (!review) {
      dropped.malformed += 1;
      continue;
    }
    if (review.pot_size < MIN_POT_BIG_BLINDS * review.big_blind) {
      dropped.small_pot += 1;
      continue;
    }
    ranked.push({ review, pot_bb: review.pot_size / review.big_blind });
  }
  ranked.sort(
    (a, b) =>
      b.pot_bb - a.pot_bb
      || timeOf(b.review.created_at) - timeOf(a.review.created_at)
      || compareIdDesc(a.review.id, b.review.id),
  );
  return { read: rows.length, ranked, dropped };
}

/**
 * Drop every row whose (hand, horse) already has a hand_clip_jobs row and keep
 * the first CANDIDATE_LIMIT of the rest, in rank order. A human's job for the
 * same hand is a different author and does not exclude the horse's.
 */
export function excludeClipped(
  ranked: Candidate[],
  jobs: Array<{ hand_id: unknown; author_id: unknown }>,
): { candidates: Candidate[]; excluded: number } {
  const clipped = new Set(jobs.map((job) => `${String(job.hand_id)}:${String(job.author_id)}`));
  const candidates: Candidate[] = [];
  let excluded = 0;
  for (const candidate of ranked) {
    if (clipped.has(`${candidate.review.hand_id}:${candidate.review.horse_user_id}`)) {
      excluded += 1;
      continue;
    }
    if (candidates.length < CANDIDATE_LIMIT) candidates.push(candidate);
  }
  return { candidates, excluded };
}

// ---------------------------------------------------------------------------
// The caption (pure, no model call)
// ---------------------------------------------------------------------------

/** game_variant values seen in horse_hand_reviews, to a fixed label. */
export const VARIANT_LABELS: Readonly<Record<string, string>> = {
  nlh: "No Limit Hold'em",
  flh: "Fixed Limit Hold'em",
  plo: 'Pot Limit Omaha',
  plo4: 'Pot Limit Omaha',
  plo5: 'Pot Limit Omaha Five Card',
  plo6: 'Pot Limit Omaha Six Card',
  plo8: 'Pot Limit Omaha Hi-Lo',
  flo8: 'Fixed Limit Omaha Hi-Lo',
  pineapple: 'Pineapple',
  short_deck: "Short Deck Hold'em",
};
export const UNKNOWN_VARIANT_LABEL = 'poker';

export function variantLabel(variant: unknown): string {
  if (typeof variant !== 'string') return UNKNOWN_VARIANT_LABEL;
  return VARIANT_LABELS[variant.trim().toLowerCase()] ?? UNKNOWN_VARIANT_LABEL;
}

/** 5 -> "5", 0.5 -> "0.5", 0.02 -> "0.02" (the smallest blind in production). */
export function formatBlind(bigBlind: number): string {
  if (Number.isInteger(bigBlind)) return String(bigBlind);
  return bigBlind.toFixed(2).replace(/0$/, '');
}

/** The pot in big blinds, one decimal. */
export function formatPotBb(potBb: number): string {
  return potBb.toFixed(1);
}

/**
 * "Hand review: No Limit Hold'em, big blind 5. Pot 201.0 BB, won from seat 3."
 * Only numbers from the row and fixed words; the seat clause is dropped when
 * the row has no seat.
 */
export function buildCaption(review: Pick<ReviewRow, 'game_variant' | 'big_blind' | 'pot_size' | 'seat'>): string {
  const seat = review.seat !== null ? ` from seat ${review.seat}` : '';
  return `Hand review: ${variantLabel(review.game_variant)}, big blind ${formatBlind(review.big_blind)}. `
    + `Pot ${formatPotBb(review.pot_size / review.big_blind)} BB, won${seat}.`;
}

/** The Phase 6 output law, as HandVoice.ts and SessionVoice.ts pin it. */
export const CAPTION_EMOJI = /\p{Extended_Pictographic}/u;
export const CAPTION_DASHES = /[\u2013\u2014]/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Exactly the template above over the fixed labels and nothing else: no name can fit in it. */
export const CAPTION_SHAPE = new RegExp(
  `^Hand review: (?:${[...new Set([...Object.values(VARIANT_LABELS), UNKNOWN_VARIANT_LABEL])].map(escapeRegExp).join('|')}), `
  + 'big blind \\d+(?:\\.\\d{1,2})?\\. Pot \\d+\\.\\d BB, won(?: from seat \\d+)?\\.$',
);

export function captionPassesLaw(caption: string): boolean {
  return !CAPTION_EMOJI.test(caption) && !CAPTION_DASHES.test(caption) && CAPTION_SHAPE.test(caption);
}

// ---------------------------------------------------------------------------
// Reads (every one bounded)
// ---------------------------------------------------------------------------

async function handClipMode(): Promise<ModeState> {
  try {
    const states = await readPostModeStates([HAND_CLIP_MODE]);
    return states[HAND_CLIP_MODE] ? 'on' : 'off';
  } catch (error) {
    console.warn('[phase9-content] hand_clip mode unreadable; treating it as OFF:', message(error));
    return 'unreadable';
  }
}

async function readPool(supa: Supa, now: Date): Promise<{ rows: unknown[]; truncated: boolean }> {
  const since = new Date(now.getTime() - WINDOW_HOURS * 3_600_000).toISOString();
  try {
    return await pagedSelect<unknown>(
      () => supa
        .from('horse_hand_reviews')
        .select(REVIEW_COLUMNS)
        .gte('played_at', since)
        .eq('is_win', true)
        .order('played_at', { ascending: false })
        .order('id', { ascending: false }),
      POOL_MAX_ROWS,
    );
  } catch (error) {
    throw new Error(`horse_hand_reviews read failed: ${message(error)}`);
  }
}

async function readClipJobs(supa: Supa, handIds: string[]): Promise<Array<{ hand_id: unknown; author_id: unknown }>> {
  if (handIds.length === 0) return [];
  const { data, error } = await supa.from('hand_clip_jobs').select('hand_id, author_id').in('hand_id', handIds);
  if (error) throw new Error(`hand_clip_jobs read failed: ${error.message}`);
  return (data ?? []) as Array<{ hand_id: unknown; author_id: unknown }>;
}

/** Active roster rows for the candidate horses: the timezone the fleet slot is computed in. */
async function readAuthors(supa: Supa, profileIds: string[]): Promise<Map<string, { timezone: string | null }>> {
  const out = new Map<string, { timezone: string | null }>();
  if (profileIds.length === 0) return out;
  const { data, error } = await supa
    .from('content_authors')
    .select('profile_id, timezone')
    .in('profile_id', profileIds)
    .eq('is_active', true);
  if (error) throw new Error(`content_authors read failed: ${error.message}`);
  for (const row of (data ?? []) as Array<{ profile_id: unknown; timezone: unknown }>) {
    const id = text(row.profile_id);
    if (id) out.set(id, { timezone: typeof row.timezone === 'string' ? row.timezone : null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunOptions {
  now: Date;
  dryRun: boolean;
  /** Test hooks: the wall clock the deadline is measured on, and the budget. */
  clock?: () => number;
  deadlineMs?: number;
}

function emptyResult(options: RunOptions, deadlineMs: number): Phase9Result {
  return {
    ok: true,
    dry_run: options.dryRun,
    at: options.now.toISOString(),
    enqueued: 0,
    candidates: 0,
    gates: { engine: 'not_read', mode: 'not_read' },
    pool: { read: 0, eligible: 0, truncated: false, checked_for_jobs: 0, already_clipped: 0, dropped: { malformed: 0, small_pot: 0 } },
    passed_over: { no_slot: 0, not_on_roster: 0, caption_law: 0 },
    duplicates: 0,
    limits: {
      window_hours: WINDOW_HOURS,
      min_pot_big_blinds: MIN_POT_BIG_BLINDS,
      pool_max_rows: POOL_MAX_ROWS,
      exclusion_check_rows: EXCLUSION_CHECK_ROWS,
      candidate_limit: CANDIDATE_LIMIT,
      deadline_ms: deadlineMs,
    },
    notes: [],
    duration_ms: 0,
    timestamp: '',
  };
}

function engineSkip(state: EngineSwitchState): Phase9Skip {
  return state === 'off' ? 'engine_disabled' : 'engine_unreadable';
}

/**
 * One fire: the gates, the pick, and at most one insert. A read that fails
 * throws, and the route answers 500 so the log shows an error, not a quiet
 * fire. A gate that cannot be read is a skip, never a publish.
 */
export async function runPhase9(options: RunOptions): Promise<Phase9Result> {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS;
  const result = emptyResult(options, deadlineMs);
  const finish = (skipped?: Phase9Skip): Phase9Result => {
    if (skipped) result.skipped = skipped;
    result.duration_ms = clock() - startedAt;
    result.timestamp = new Date().toISOString();
    return result;
  };
  const overBudget = (): boolean => clock() - startedAt > deadlineMs;

  // 1. The gates. A dry run reports them and goes on; a live run obeys them
  //    and reads nothing else when one says stop.
  const engine = await engineSwitch({ fresh: true });
  result.gates.engine = engine;
  if (!options.dryRun && engine !== 'on') return finish(engineSkip(engine));
  const mode = await handClipMode();
  result.gates.mode = mode;
  if (!options.dryRun && mode !== 'on') return finish(mode === 'off' ? 'mode_disabled' : 'mode_unreadable');

  // 2. The pool, ranked.
  if (overBudget()) return finish('deadline');
  const supa = getSupabase();
  const pool = await readPool(supa, options.now);
  const selection = rankPool(pool.rows);
  result.pool.read = selection.read;
  result.pool.eligible = selection.ranked.length;
  result.pool.truncated = pool.truncated;
  result.pool.dropped = selection.dropped;
  if (pool.truncated) {
    result.notes.push(`the window held more than ${POOL_MAX_ROWS} winning rows; the ranking saw the newest ${POOL_MAX_ROWS}`);
  }
  const shortlist = selection.ranked.slice(0, EXCLUSION_CHECK_ROWS);
  if (shortlist.length === 0) return finish('no_candidates');

  // 3. Hands this horse already has a job for are out.
  if (overBudget()) return finish('deadline');
  const jobs = await readClipJobs(supa, [...new Set(shortlist.map((candidate) => candidate.review.hand_id))]);
  const { candidates, excluded } = excludeClipped(shortlist, jobs);
  result.pool.checked_for_jobs = shortlist.length;
  result.pool.already_clipped = excluded;
  result.candidates = candidates.length;
  if (candidates.length === 0) return finish('no_candidates');

  // 4. The first candidate whose horse has an open fleet slot.
  if (overBudget()) return finish('deadline');
  const authors = await readAuthors(supa, [...new Set(candidates.map((candidate) => candidate.review.horse_user_id))]);
  let pick: Phase9Pick | null = null;
  for (const candidate of candidates) {
    const horse = candidate.review.horse_user_id;
    const author = authors.get(horse);
    if (!author) {
      result.passed_over.not_on_roster += 1;
      continue;
    }
    const slot = fleetSlotId(horse, author.timezone, options.now);
    if (!slot) {
      result.passed_over.no_slot += 1;
      continue;
    }
    const caption = buildCaption(candidate.review);
    if (!captionPassesLaw(caption)) {
      // The builder cannot produce this; if it ever does, the row is skipped and said so.
      result.passed_over.caption_law += 1;
      result.notes.push(`review ${String(candidate.review.id)}: caption failed the output law`);
      continue;
    }
    pick = {
      hand_id: candidate.review.hand_id,
      author_id: horse,
      slot,
      publication_key: fleetPublicationKey(horse, slot),
      caption,
      review_id: candidate.review.id,
      pot_bb: Number(formatPotBb(candidate.pot_bb)),
    };
    break;
  }
  if (!pick) return finish('no_slot');
  result.pick = pick;

  // 5. A dry run stops here: the pick and the caption, no write.
  if (options.dryRun) {
    result.notes.push(DRY_RUN_WRITES_NOTE);
    return finish();
  }

  // 6. One insert, after the deadline and the master switch are read again
  //    (horse-posts.ts:84: turning the engine off stops a run in flight).
  if (overBudget()) return finish('deadline');
  const again = await engineSwitch({ fresh: true });
  if (again !== 'on') {
    result.gates.engine = again;
    return finish(engineSkip(again));
  }
  const { data, error } = await supa
    .from('hand_clip_jobs')
    .insert({
      hand_id: pick.hand_id,
      author_id: pick.author_id,
      kind: 'horse',
      style: CLIP_STYLE,
      auto_publish: true,
      publication_key: pick.publication_key,
      caption: pick.caption,
    })
    .select('id')
    .maybeSingle();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      result.duplicates = 1;
      return finish('duplicate');
    }
    throw new Error(`hand_clip_jobs insert failed: ${error.message}`);
  }
  result.enqueued = 1;
  const jobId = (data as { id?: unknown } | null)?.id;
  if (jobId !== undefined && jobId !== null) result.job_id = String(jobId);
  return finish();
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

export async function phase9Content(c: Context) {
  const dryRun = c.req.query('dry_run') === '1' || c.req.query('preview') === '1';
  // `at` steers a dry run only. A live run reads the real clock, so the slot
  // it names is the slot the other fleet routes name right now.
  const atValue = dryRun ? c.req.query('at') : undefined;
  const now = atValue ? new Date(atValue) : new Date();
  if (Number.isNaN(now.getTime())) return c.json({ ok: false, error: 'invalid_at' }, 400);
  try {
    return c.json(await runPhase9({ now, dryRun }));
  } catch (error) {
    const reason = message(error);
    console.warn('[phase9-content] failed:', reason);
    return c.json({ ok: false, error: reason }, 500);
  }
}
