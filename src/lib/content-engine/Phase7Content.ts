/**
 * Phase 7 ("Interactive Poker Content"): the run behind
 * GET/POST /cron/phase7-content, and the pure helpers it is built from.
 *
 * One fire is one bounded pass, in this order:
 *   1. reveal every due puzzle (oldest first, capped at REVEALS_PER_RUN),
 *      even while every Phase 7 mode row is off: a reveal is owed to the
 *      people who already answered, it creates no new content, and the
 *      master switch still stops it;
 *   2. publish puzzles, per kind, only while that kind's mode row is on
 *      (at most PUZZLES_PER_KIND_PER_RUN created per kind);
 *   3. post stories, per story mode, only while that mode row is on.
 * Nothing here polls, sleeps, retries or schedules anything. What a fire
 * leaves undone is counted in the result (remaining / not_attempted) and is
 * due again on the next scheduled fire.
 *
 * Laws (phase7-content.law.test.ts reads this file):
 * - the master switch is read again, fresh, before every write (mayWrite);
 * - a puzzle's correct option travels only inside the arguments of the
 *   publish RPC, which stores it server-side. It is never put in post
 *   metadata, never in a count, never in a log line;
 * - social_posts.publication_key (the column) is never written; the key is
 *   metadata.publication_key, exactly as Phase 6 does it;
 * - reads fail closed: an unreadable guard skips the horse and is counted,
 *   an unreadable candidate list or roster publishes nothing;
 * - preview composes with zero content writes and calls no RPC.
 */
import { randomBytes } from 'node:crypto';
import { getSupabase } from '../supabase.js';
import { engineSwitch, loadFleet, postModeEnabled } from './Fleet.js';
import { recentPostGuard, type FleetHorse, type RecentPostGuard } from './HorsePublisher.js';
import { fleetHash } from './FleetScheduler.js';
import { normalizePhrase, recordPhrase } from './ContentLedger.js';
import { storyTopicKind, topicsFor } from './SocialTopics.js';
import {
  composePuzzle,
  puzzleKey,
  type ComposedPuzzle,
  type PuzzleKind,
  type PuzzleReviewRow,
} from './PuzzleComposer.js';
import { draftStories, STORY_MODES, type StoryDraft, type StoryMode } from './Phase7Stories.js';

export const PUZZLE_KINDS: readonly PuzzleKind[] = ['nuts', 'pot_odds', 'what_would_you_do'];

/** horse_post_modes row for a puzzle kind: puzzle_nuts, puzzle_pot_odds, ... */
export function puzzleMode(kind: PuzzleKind): string {
  return `puzzle_${kind}`;
}

/** Bounds of one fire. Reaching one is reported, never worked around. */
export const REVEALS_PER_RUN = 50;
export const PUZZLES_PER_KIND_PER_RUN = 3;
/** Compose attempts per kind, so a run where every board is rejected stays short. */
export const PUZZLE_ATTEMPTS_PER_KIND = 30;
export const CANDIDATE_LIMIT = 200;
export const CANDIDATE_MIN_ABS_BB = 25;
/** Hands played between now-24h and now-1h: "earlier today", never mid-hand. */
export const CANDIDATE_OLDEST_HOURS = 24;
export const CANDIDATE_NEWEST_HOURS = 1;
export const STORIES_PER_MODE_PER_RUN = 20;
export const PREVIEW_SAMPLES_PER_KIND = 5;
export const PREVIEW_SHORTLIST = 40;
export const PREVIEW_STORIES_PER_MODE = 5;
/** Inside the dispatcher's 300 s budget for this job. */
export const DEADLINE_MS = 240_000;
/** One write at a time, as horse-posts.ts: every loop below is sequential. */
export const CONCURRENCY = 1;
const UNIQUE_VIOLATION = '23505';
const MAX_ERRORS = 10;

export const PREVIEW_WRITES_NOTE =
  'Preview makes no content writes: no posts, puzzles, reveals, rewards or phrase-ledger rows, and it calls no RPC. '
  + 'The only write is the cron middleware logging this request in cron_execution_log.';

type Supa = ReturnType<typeof getSupabase>;
export type Halt = 'engine_disabled' | 'engine_unreadable';

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}

function pushError(list: string[], text: string): void {
  if (list.length < MAX_ERRORS) list.push(text);
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function count(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 32 random bytes, hex, drawn at compose time. */
export function saltFor(): string {
  return randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Candidates (pure)
// ---------------------------------------------------------------------------

export interface CandidateRow {
  id: number;
  hand_id: string;
  horse_user_id: string;
  game_variant: string;
  format: string | null;
  big_blind: number | null;
  played_at: string;
  net_bb: number | null;
  is_win: boolean | null;
  pot_size: number | null;
  seat: number | null;
  hole_cards: unknown;
  board: unknown;
}

export interface CandidateDrops {
  malformed: number;
  variant: number;
  board: number;
  net_bb: number;
  not_on_roster: number;
  same_hand: number;
}

export interface CandidateSelection {
  read: number;
  eligible: CandidateRow[];
  dropped: CandidateDrops;
}

const CANDIDATE_COLUMNS =
  'id, hand_id, horse_user_id, game_variant, format, big_blind, played_at, net_bb, is_win, pot_size, seat, hole_cards, board';

function asCandidate(raw: unknown): CandidateRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = num(r.id);
  if (id === null) return null;
  if (typeof r.hand_id !== 'string' || !r.hand_id) return null;
  if (typeof r.horse_user_id !== 'string' || !r.horse_user_id) return null;
  if (typeof r.game_variant !== 'string' || typeof r.played_at !== 'string') return null;
  return {
    id,
    hand_id: r.hand_id,
    horse_user_id: r.horse_user_id,
    game_variant: r.game_variant,
    format: typeof r.format === 'string' ? r.format : null,
    big_blind: num(r.big_blind),
    played_at: r.played_at,
    net_bb: num(r.net_bb),
    is_win: typeof r.is_win === 'boolean' ? r.is_win : null,
    pot_size: num(r.pot_size),
    seat: num(r.seat),
    hole_cards: r.hole_cards ?? null,
    board: r.board ?? null,
  };
}

/** The deterministic place of a hand in today's queue. */
export function candidateOrder(handId: string, day: string): number {
  return fleetHash(`${handId}:${day}`, 'phase7-order');
}

/**
 * Which rows may become puzzles today, in the order they are tried.
 *
 * Re-applies every filter the query asked for (NLH, a five-card board,
 * |net_bb| >= 25) so a row the database let through is still held, keeps
 * only hands whose horse is on the roster, keeps one row per hand (the more
 * eventful seat; ties keep the lower review id, so two horses in one hand
 * make one puzzle), and orders by fleetHash(hand_id:day), so a retry after a
 * failed run tries the same hands in the same order.
 */
export function selectCandidates(rows: unknown[], roster: ReadonlySet<string>, day: string): CandidateSelection {
  const dropped: CandidateDrops = { malformed: 0, variant: 0, board: 0, net_bb: 0, not_on_roster: 0, same_hand: 0 };
  const byHand = new Map<string, CandidateRow>();
  for (const raw of rows) {
    const row = asCandidate(raw);
    if (!row) { dropped.malformed += 1; continue; }
    if (row.game_variant !== 'nlh') { dropped.variant += 1; continue; }
    if (!Array.isArray(row.board) || row.board.length !== 5 || !row.board.every((c) => c !== null && typeof c === 'object')) {
      dropped.board += 1;
      continue;
    }
    if (row.net_bb === null || Math.abs(row.net_bb) < CANDIDATE_MIN_ABS_BB) { dropped.net_bb += 1; continue; }
    if (!roster.has(row.horse_user_id)) { dropped.not_on_roster += 1; continue; }
    const seen = byHand.get(row.hand_id);
    if (seen) {
      dropped.same_hand += 1;
      const seenBb = Math.abs(seen.net_bb ?? 0);
      const rowBb = Math.abs(row.net_bb);
      if (rowBb > seenBb || (rowBb === seenBb && row.id < seen.id)) byHand.set(row.hand_id, row);
      continue;
    }
    byHand.set(row.hand_id, row);
  }
  const eligible = [...byHand.values()].sort((a, b) => {
    const diff = candidateOrder(a.hand_id, day) - candidateOrder(b.hand_id, day);
    if (diff !== 0) return diff;
    return a.hand_id < b.hand_id ? -1 : a.hand_id > b.hand_id ? 1 : 0;
  });
  return { read: rows.length, eligible, dropped };
}

export function rosterOf(fleet: FleetHorse[]): Set<string> {
  return new Set(fleet.map((horse) => horse.profile_id));
}

/** What a puzzle post's metadata says about its source: ids and time only. */
export function groundingFor(row: CandidateRow): Record<string, unknown> {
  // Never the result (net_bb, is_win, pot_size): post metadata is public and
  // "what would you do" reveals what the horse did; a win would give it away.
  return {
    source_review_id: row.id,
    hand_id: row.hand_id,
    played_at: row.played_at,
    game_variant: row.game_variant,
    format: row.format,
    big_blind: row.big_blind,
  };
}

function toReviewRow(row: CandidateRow, actions: unknown): PuzzleReviewRow {
  return { ...row, actions };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function readCandidates(supa: Supa, now: Date): Promise<unknown[]> {
  const oldest = new Date(now.getTime() - CANDIDATE_OLDEST_HOURS * 3_600_000).toISOString();
  const newest = new Date(now.getTime() - CANDIDATE_NEWEST_HOURS * 3_600_000).toISOString();
  const { data, error } = await supa
    .from('horse_hand_reviews')
    .select(CANDIDATE_COLUMNS)
    .eq('game_variant', 'nlh')
    .gte('played_at', oldest)
    .lte('played_at', newest)
    .or(`net_bb.gte.${CANDIDATE_MIN_ABS_BB},net_bb.lte.-${CANDIDATE_MIN_ABS_BB}`)
    .order('played_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(CANDIDATE_LIMIT);
  if (error) throw new Error(`horse_hand_reviews read failed: ${error.message}`);
  return Array.isArray(data) ? (data as unknown[]) : [];
}

/**
 * The action logs, for exactly the rows about to be composed: every action
 * carries a table snapshot, so the candidate read leaves them out.
 */
async function readActions(supa: Supa, ids: number[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (ids.length === 0) return out;
  const { data, error } = await supa.from('horse_hand_reviews').select('id, actions').in('id', ids);
  if (error) throw new Error(`horse_hand_reviews actions read failed: ${error.message}`);
  for (const row of (data ?? []) as Array<{ id: unknown; actions: unknown }>) out.set(String(row.id), row.actions ?? null);
  return out;
}

async function puzzleKeyExists(supa: Supa, key: string): Promise<boolean> {
  const { data, error } = await supa.from('social_puzzles').select('id').eq('puzzle_key', key).limit(1);
  if (error) throw new Error(`social_puzzles read failed: ${error.message}`);
  return ((data ?? []) as unknown[]).length > 0;
}

/** Has this story key been published as a feed post? */
async function alreadyPublished(supa: Supa, publicationKey: string): Promise<boolean> {
  const { data, error } = await supa
    .from('social_posts')
    .select('id')
    .eq('metadata->>publication_key', publicationKey)
    .limit(1);
  if (error) throw new Error(`publication ledger read failed (social_posts): ${error.message}`);
  return ((data ?? []) as unknown[]).length > 0;
}

/** The 20-hour guard, and it fails closed: an unreadable guard is not 'clear'. */
async function guardFor(profileId: string): Promise<RecentPostGuard> {
  try {
    return await recentPostGuard(profileId);
  } catch {
    return 'guard_unreadable';
  }
}

// ---------------------------------------------------------------------------
// Run state: the budget and the switch
// ---------------------------------------------------------------------------

export interface RunOptions {
  now: Date;
  /** Test hooks: the wall clock the deadline is measured on, and the budget. */
  clock?: () => number;
  deadlineMs?: number;
}

interface RunState {
  supa: Supa;
  now: Date;
  day: string;
  startedAt: number;
  clock: () => number;
  deadlineMs: number;
  halt: Halt | null;
  deadlineHit: boolean;
}

/**
 * May this run write now? Checked before every write: the deadline first,
 * then the master switch again with a fresh read, so turning the engine off
 * stops a run in flight and not only the next one (horse-posts.ts:84).
 */
async function mayWrite(state: RunState): Promise<boolean> {
  if (state.halt || state.deadlineHit) return false;
  if (state.clock() - state.startedAt > state.deadlineMs) {
    state.deadlineHit = true;
    return false;
  }
  const switchState = await engineSwitch({ fresh: true });
  if (switchState !== 'on') {
    state.halt = switchState === 'off' ? 'engine_disabled' : 'engine_unreadable';
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Step 1: reveals
// ---------------------------------------------------------------------------

export interface RevealCounts {
  due: number;
  read_failed: boolean;
  attempted: number;
  revealed: number;
  already_revealed: number;
  not_due: number;
  closed_post_gone: number;
  failed: number;
  answers_graded: number;
  correct: number;
  paid: number;
  refused: Record<string, number>;
  remaining: number;
  cap_hit: boolean;
  errors: string[];
}

export function emptyReveals(): RevealCounts {
  return {
    due: 0,
    read_failed: false,
    attempted: 0,
    revealed: 0,
    already_revealed: 0,
    not_due: 0,
    closed_post_gone: 0,
    failed: 0,
    answers_graded: 0,
    correct: 0,
    paid: 0,
    refused: {},
    remaining: 0,
    cap_hit: false,
    errors: [],
  };
}

export type RevealStatus = 'revealed' | 'already_revealed' | 'not_due' | 'closed_post_gone';
const REVEAL_STATUSES: readonly RevealStatus[] = ['revealed', 'already_revealed', 'not_due', 'closed_post_gone'];

export interface RevealResult {
  status: RevealStatus;
  answers: number;
  correct: number;
  paid: number;
  refused: Record<string, number>;
}

/** fn_p7_reveal_puzzle's jsonb, or null when it is not the documented shape. */
export function parseRevealResult(value: unknown): RevealResult | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.status !== 'string' || !(REVEAL_STATUSES as readonly string[]).includes(r.status)) return null;
  const refused: Record<string, number> = {};
  if (r.refused && typeof r.refused === 'object') {
    for (const [reason, n] of Object.entries(r.refused as Record<string, unknown>)) {
      const parsed = num(n);
      if (parsed !== null) refused[reason] = parsed;
    }
  }
  return {
    status: r.status as RevealStatus,
    answers: num(r.answers) ?? 0,
    correct: num(r.correct) ?? 0,
    paid: num(r.paid) ?? 0,
    refused,
  };
}

async function revealStep(state: RunState): Promise<RevealCounts> {
  const out = emptyReveals();
  let queue: Array<{ id: string }> = [];
  try {
    const { data, error } = await state.supa
      .from('social_puzzles')
      .select('id, reveal_at')
      .is('revealed_at', null)
      .lte('reveal_at', state.now.toISOString())
      .order('reveal_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(REVEALS_PER_RUN);
    if (error) throw new Error(error.message);
    queue = ((data ?? []) as Array<{ id: unknown }>)
      .filter((row) => typeof row.id === 'string' && row.id.length > 0)
      .map((row) => ({ id: row.id as string }));
  } catch (error) {
    out.read_failed = true;
    pushError(out.errors, `due puzzles read failed: ${message(error)}`);
    return out;
  }
  out.due = queue.length;
  out.cap_hit = queue.length >= REVEALS_PER_RUN;
  for (const row of queue) {
    if (!(await mayWrite(state))) break;
    out.attempted += 1;
    let result: RevealResult | null = null;
    try {
      const { data, error } = await state.supa.rpc('fn_p7_reveal_puzzle', { p_puzzle_id: row.id });
      if (error) throw new Error(error.message);
      result = parseRevealResult(data);
      if (!result) throw new Error('unreadable result');
    } catch (error) {
      out.failed += 1;
      pushError(out.errors, `reveal ${row.id}: ${message(error)}`);
      continue;
    }
    out[result.status] += 1;
    if (result.status === 'revealed') {
      out.answers_graded += result.answers;
      out.correct += result.correct;
      out.paid += result.paid;
      for (const [reason, n] of Object.entries(result.refused)) count(out.refused, reason, n);
    }
  }
  out.remaining = queue.length - out.attempted;
  return out;
}

// ---------------------------------------------------------------------------
// Step 2: puzzles
// ---------------------------------------------------------------------------

export interface PuzzleSkips {
  mode_disabled: number;
  key_exists: number;
  posted_recently: number;
  guard_unreadable: number;
  evaluator_rejected: number;
  not_attempted: number;
}

export interface PuzzleKindCounts {
  mode_enabled: boolean;
  candidates: number;
  eligible: number;
  attempted: number;
  created: number;
  duplicate: number;
  failed: number;
  cap_hit: boolean;
  skipped: PuzzleSkips;
  rejected: Record<string, number>;
  errors: string[];
}

export function emptyPuzzleCounts(enabled: boolean): PuzzleKindCounts {
  return {
    mode_enabled: enabled,
    candidates: 0,
    eligible: 0,
    attempted: 0,
    created: 0,
    duplicate: 0,
    failed: 0,
    cap_hit: false,
    skipped: { mode_disabled: 0, key_exists: 0, posted_recently: 0, guard_unreadable: 0, evaluator_rejected: 0, not_attempted: 0 },
    rejected: {},
    errors: [],
  };
}

type PublishOutcome = { status: 'created' } | { status: 'duplicate' } | { status: 'failed'; error: string };

async function publishPuzzle(state: RunState, puzzle: ComposedPuzzle, row: CandidateRow): Promise<PublishOutcome> {
  try {
    const { data, error } = await state.supa.rpc('fn_p7_publish_puzzle', {
      p_author_id: row.horse_user_id,
      p_kind: puzzle.kind,
      p_hand_id: puzzle.hand_id,
      p_source_review_id: puzzle.source_review_id,
      p_game_variant: puzzle.game_variant,
      p_board: puzzle.board,
      p_prompt: puzzle.prompt,
      p_options: puzzle.options,
      p_correct_option: puzzle.correct_option,
      p_salt: puzzle.salt,
      p_explanation: puzzle.explanation,
      p_proof: puzzle.proof,
      p_evaluator_version: puzzle.evaluator_version,
      p_rewardable: puzzle.rewardable,
      p_reveal_hours: puzzle.reveal_hours,
      p_metadata: { scheduler: 'phase7', grounding: groundingFor(row) },
    });
    if (error) return { status: 'failed', error: `publish rpc failed: ${error.message}` };
    const status = data && typeof data === 'object' ? (data as { status?: unknown }).status : undefined;
    if (status === 'created' || status === 'duplicate') return { status };
    return { status: 'failed', error: `publish rpc returned status ${String(status)}` };
  } catch (error) {
    return { status: 'failed', error: `publish rpc threw: ${message(error)}` };
  }
}

async function puzzleStep(state: RunState, kind: PuzzleKind, selection: CandidateSelection): Promise<PuzzleKindCounts> {
  const out = emptyPuzzleCounts(true);
  out.candidates = selection.read;
  out.eligible = selection.eligible.length;
  let looked = 0;
  let stoppedEarly = false;
  for (const row of selection.eligible) {
    if (out.created >= PUZZLES_PER_KIND_PER_RUN) { out.cap_hit = true; break; }
    if (out.attempted >= PUZZLE_ATTEMPTS_PER_KIND) { out.cap_hit = true; break; }
    if (!(await mayWrite(state))) { stoppedEarly = true; break; }
    looked += 1;
    out.attempted += 1;
    const key = puzzleKey(kind, row.hand_id);
    try {
      if (await puzzleKeyExists(state.supa, key)) { out.skipped.key_exists += 1; continue; }
    } catch (error) {
      out.failed += 1;
      pushError(out.errors, message(error));
      continue;
    }
    const guard = await guardFor(row.horse_user_id);
    if (guard !== 'clear') {
      out.skipped[guard] += 1;
      continue;
    }
    let actions: unknown = null;
    try {
      actions = (await readActions(state.supa, [row.id])).get(String(row.id)) ?? null;
    } catch (error) {
      out.failed += 1;
      pushError(out.errors, message(error));
      continue;
    }
    let composed: ReturnType<typeof composePuzzle>;
    try {
      composed = composePuzzle(kind, toReviewRow(row, actions), { salt: saltFor(), now: state.now });
    } catch (error) {
      composed = { ok: false, rejected: 'composer_threw' };
      pushError(out.errors, `composer threw for review ${row.id}: ${message(error)}`);
    }
    if (!composed.ok) {
      out.skipped.evaluator_rejected += 1;
      count(out.rejected, composed.rejected);
      continue;
    }
    const outcome = await publishPuzzle(state, composed.puzzle, row);
    if (outcome.status === 'created') out.created += 1;
    else if (outcome.status === 'duplicate') out.duplicate += 1;
    else {
      out.failed += 1;
      pushError(out.errors, outcome.error);
    }
  }
  if (stoppedEarly) out.skipped.not_attempted = selection.eligible.length - looked;
  return out;
}

// ---------------------------------------------------------------------------
// Step 3: stories
// ---------------------------------------------------------------------------

export interface StoryModeCounts {
  mode_enabled: boolean;
  considered: number;
  drafted: number;
  attempted: number;
  posted: number;
  duplicate: number;
  failed: number;
  skipped: Record<string, number>;
  errors: string[];
}

export function emptyStoryCounts(enabled: boolean): StoryModeCounts {
  return {
    mode_enabled: enabled,
    considered: 0,
    drafted: 0,
    attempted: 0,
    posted: 0,
    duplicate: 0,
    failed: 0,
    skipped: { mode_disabled: 0, author_not_on_roster: 0, posted_recently: 0, guard_unreadable: 0, not_attempted: 0 },
    errors: [],
  };
}

/** The Phase 6 metadata shape with Phase 7 names (phase6-content.ts metadataFor). */
export function storyMetadata(mode: StoryMode, draft: StoryDraft): Record<string, unknown> {
  return {
    scheduler: 'phase7',
    phase7_mode: mode,
    publication_key: draft.publication_key,
    grounding: draft.grounding,
  };
}

/**
 * The Phase 6 horse insert (phase6-content.ts publishHorseDraft), plus the topic
 * and topics of the story: the primary is always poker and a tournament story
 * carries tournament as a facet (Phase 8 topics rule, SocialTopics.ts).
 */
export function storyInsert(mode: StoryMode, draft: StoryDraft): Record<string, unknown> {
  return {
    author_id: draft.horse.profile_id,
    content: draft.text,
    content_type: 'text',
    media_urls: [],
    visibility: 'public',
    link_url: null,
    ...topicsFor(storyTopicKind(draft.topic)),
    metadata: storyMetadata(mode, draft),
  };
}

type StoryOutcome = { status: 'posted'; id: string } | { status: 'duplicate' } | { status: 'failed'; error: string };

async function publishStory(supa: Supa, mode: StoryMode, draft: StoryDraft): Promise<StoryOutcome> {
  const { data, error } = await supa.from('social_posts').insert(storyInsert(mode, draft)).select('id').maybeSingle();
  if (error?.code === UNIQUE_VIOLATION) return { status: 'duplicate' };
  if (error || !data?.id) return { status: 'failed', error: `story post failed: ${error?.message ?? 'missing id'}` };
  const id = String(data.id);
  try {
    await recordPhrase(normalizePhrase(draft.text), draft.horse.profile_id, id);
  } catch (ledgerError) {
    console.warn('[phase7-content] phrase ledger write failed:', message(ledgerError));
  }
  return { status: 'posted', id };
}

async function storyStep(state: RunState, mode: StoryMode, fleet: FleetHorse[]): Promise<StoryModeCounts> {
  const out = emptyStoryCounts(true);
  if (state.halt || state.deadlineHit) {
    // Nothing drafted: drafting reads rows for nothing when no write may follow.
    out.skipped.not_attempted = 0;
    out.skipped.not_started = 1;
    return out;
  }
  let drafted: Awaited<ReturnType<typeof draftStories>>;
  try {
    drafted = await draftStories(mode, { supa: state.supa, now: state.now, fleet }, STORIES_PER_MODE_PER_RUN);
  } catch (error) {
    out.failed += 1;
    pushError(out.errors, `draft failed: ${message(error)}`);
    return out;
  }
  out.considered = drafted.considered;
  out.drafted = drafted.drafts.length;
  for (const [reason, n] of Object.entries(drafted.skipped ?? {})) count(out.skipped, reason, n);
  const roster = rosterOf(fleet);
  const queue = drafted.drafts.slice(0, STORIES_PER_MODE_PER_RUN);
  let looked = 0;
  let stoppedEarly = false;
  for (const draft of queue) {
    if (!(await mayWrite(state))) { stoppedEarly = true; break; }
    looked += 1;
    out.attempted += 1;
    if (!roster.has(draft.horse.profile_id)) { count(out.skipped, 'author_not_on_roster'); continue; }
    try {
      if (await alreadyPublished(state.supa, draft.publication_key)) { out.duplicate += 1; continue; }
    } catch (error) {
      out.failed += 1;
      pushError(out.errors, message(error));
      continue;
    }
    const guard = await guardFor(draft.horse.profile_id);
    if (guard !== 'clear') { count(out.skipped, guard); continue; }
    let outcome: StoryOutcome;
    try {
      outcome = await publishStory(state.supa, mode, draft);
    } catch (error) {
      outcome = { status: 'failed', error: message(error) };
    }
    if (outcome.status === 'posted') out.posted += 1;
    else if (outcome.status === 'duplicate') out.duplicate += 1;
    else {
      out.failed += 1;
      pushError(out.errors, outcome.error);
    }
  }
  if (stoppedEarly) out.skipped.not_attempted = queue.length - looked;
  return out;
}

// ---------------------------------------------------------------------------
// The live run
// ---------------------------------------------------------------------------

export interface Phase7RunResult {
  success: true;
  preview: false;
  at: string;
  stopped: Halt | null;
  deadline_hit: boolean;
  fleet: number | null;
  candidates: { read: number; eligible: number; dropped: CandidateDrops } | null;
  reveals: RevealCounts;
  puzzles: Record<PuzzleKind, PuzzleKindCounts>;
  stories: Record<StoryMode, StoryModeCounts>;
  limits: {
    reveals_per_run: number;
    puzzles_per_kind_per_run: number;
    puzzle_attempts_per_kind: number;
    stories_per_mode_per_run: number;
    deadline_ms: number;
    concurrency: number;
  };
  errors: string[];
  duration_ms: number;
  timestamp: string;
}

function limits(deadlineMs: number): Phase7RunResult['limits'] {
  return {
    reveals_per_run: REVEALS_PER_RUN,
    puzzles_per_kind_per_run: PUZZLES_PER_KIND_PER_RUN,
    puzzle_attempts_per_kind: PUZZLE_ATTEMPTS_PER_KIND,
    stories_per_mode_per_run: STORIES_PER_MODE_PER_RUN,
    deadline_ms: deadlineMs,
    concurrency: CONCURRENCY,
  };
}

function failedPuzzleCounts(error: string): PuzzleKindCounts {
  const out = emptyPuzzleCounts(true);
  out.failed = 1;
  out.errors.push(error);
  return out;
}

function failedStoryCounts(error: string): StoryModeCounts {
  const out = emptyStoryCounts(true);
  out.failed = 1;
  out.errors.push(error);
  return out;
}

/**
 * One live fire. The caller has already checked the master switch once at
 * entry; every write below checks it again.
 */
export async function runPhase7(options: RunOptions): Promise<Phase7RunResult> {
  const clock = options.clock ?? Date.now;
  const state: RunState = {
    supa: getSupabase(),
    now: options.now,
    day: isoDay(options.now),
    startedAt: clock(),
    clock,
    deadlineMs: options.deadlineMs ?? DEADLINE_MS,
    halt: null,
    deadlineHit: false,
  };
  const errors: string[] = [];

  // 1. Reveals are owed regardless of the mode rows.
  const reveals = await revealStep(state);

  // Mode rows: each read fails closed (Fleet.ts postModeEnabled).
  const puzzleModes = new Map<PuzzleKind, boolean>();
  for (const kind of PUZZLE_KINDS) puzzleModes.set(kind, await postModeEnabled(puzzleMode(kind)));
  const storyModes = new Map<StoryMode, boolean>();
  for (const mode of STORY_MODES) storyModes.set(mode, await postModeEnabled(mode));
  const anyPuzzle = [...puzzleModes.values()].some(Boolean);
  const anyStory = [...storyModes.values()].some(Boolean);

  // The roster, once, only when something may post.
  let fleet: FleetHorse[] | null = null;
  let fleetError: string | null = null;
  if (anyPuzzle || anyStory) {
    try {
      fleet = await loadFleet();
    } catch (error) {
      fleetError = `fleet read failed: ${message(error)}`;
      pushError(errors, fleetError);
    }
  }

  // 2. Puzzles: one candidate read, shared by every enabled kind.
  let selection: CandidateSelection | null = null;
  let candidateError: string | null = fleetError;
  if (anyPuzzle && fleet) {
    try {
      selection = selectCandidates(await readCandidates(state.supa, state.now), rosterOf(fleet), state.day);
    } catch (error) {
      candidateError = `candidate read failed: ${message(error)}`;
      pushError(errors, candidateError);
    }
  }
  const puzzles = {} as Record<PuzzleKind, PuzzleKindCounts>;
  for (const kind of PUZZLE_KINDS) {
    if (!puzzleModes.get(kind)) {
      const disabled = emptyPuzzleCounts(false);
      disabled.skipped.mode_disabled = 1;
      puzzles[kind] = disabled;
    } else if (!selection) {
      puzzles[kind] = failedPuzzleCounts(candidateError ?? 'candidates unavailable');
    } else {
      puzzles[kind] = await puzzleStep(state, kind, selection);
    }
  }

  // 3. Stories.
  const stories = {} as Record<StoryMode, StoryModeCounts>;
  for (const mode of STORY_MODES) {
    if (!storyModes.get(mode)) {
      const disabled = emptyStoryCounts(false);
      disabled.skipped.mode_disabled = 1;
      stories[mode] = disabled;
    } else if (!fleet) {
      stories[mode] = failedStoryCounts(fleetError ?? 'fleet unavailable');
    } else {
      stories[mode] = await storyStep(state, mode, fleet);
    }
  }

  return {
    success: true,
    preview: false,
    at: state.now.toISOString(),
    stopped: state.halt,
    deadline_hit: state.deadlineHit,
    fleet: fleet ? fleet.length : null,
    candidates: selection ? { read: selection.read, eligible: selection.eligible.length, dropped: selection.dropped } : null,
    reveals,
    puzzles,
    stories,
    limits: limits(state.deadlineMs),
    errors,
    duration_ms: clock() - state.startedAt,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Preview: compose everything, write nothing, call no RPC
// ---------------------------------------------------------------------------

/** A composed puzzle as the owner reviews it: the salt stays out (it is not a commitment to anything). */
export interface PreviewPuzzle {
  kind: PuzzleKind;
  puzzle_key: string;
  hand_id: string;
  source_review_id: number;
  author_id: string;
  horse: string | null;
  game_variant: string;
  board: ComposedPuzzle['board'];
  prompt: string;
  options: ComposedPuzzle['options'];
  correct_option: ComposedPuzzle['correct_option'];
  explanation: string;
  answer_commitment: string;
  proof: Record<string, unknown>;
  evaluator_version: string;
  rewardable: boolean;
  reveal_hours: number;
  grounding: Record<string, unknown>;
}

export interface PreviewKind {
  considered: number;
  composed: number;
  rejected: Record<string, number>;
  samples: PreviewPuzzle[];
}

export interface PreviewStoryMode {
  considered: number;
  drafted: number;
  skipped: Record<string, number>;
  samples: StoryDraft[];
  error: string | null;
}

export interface Phase7Preview {
  success: true;
  preview: true;
  content_writes: 0;
  writes_note: string;
  at: string;
  fleet: number | null;
  candidates: { read: number; eligible: number; dropped: CandidateDrops } | null;
  puzzles: Record<PuzzleKind, PreviewKind>;
  stories: Record<StoryMode, PreviewStoryMode>;
  errors: string[];
  timestamp: string;
}

export function previewPuzzle(puzzle: ComposedPuzzle, row: CandidateRow, horse: string | null): PreviewPuzzle {
  return {
    kind: puzzle.kind,
    puzzle_key: puzzle.puzzle_key,
    hand_id: puzzle.hand_id,
    source_review_id: puzzle.source_review_id,
    author_id: row.horse_user_id,
    horse,
    game_variant: puzzle.game_variant,
    board: puzzle.board,
    prompt: puzzle.prompt,
    options: puzzle.options,
    correct_option: puzzle.correct_option,
    explanation: puzzle.explanation,
    answer_commitment: puzzle.answer_commitment,
    proof: puzzle.proof,
    evaluator_version: puzzle.evaluator_version,
    rewardable: puzzle.rewardable,
    reveal_hours: puzzle.reveal_hours,
    grounding: groundingFor(row),
  };
}

export async function previewPhase7(options: { now: Date }): Promise<Phase7Preview> {
  const supa = getSupabase();
  const now = options.now;
  const day = isoDay(now);
  const errors: string[] = [];

  let fleet: FleetHorse[] | null = null;
  try {
    fleet = await loadFleet();
  } catch (error) {
    pushError(errors, `fleet read failed: ${message(error)}`);
  }

  const puzzles = {} as Record<PuzzleKind, PreviewKind>;
  for (const kind of PUZZLE_KINDS) puzzles[kind] = { considered: 0, composed: 0, rejected: {}, samples: [] };
  let selection: CandidateSelection | null = null;
  if (fleet) {
    try {
      selection = selectCandidates(await readCandidates(supa, now), rosterOf(fleet), day);
    } catch (error) {
      pushError(errors, `candidate read failed: ${message(error)}`);
    }
  }
  if (fleet && selection) {
    let shortlist = selection.eligible.slice(0, PREVIEW_SHORTLIST);
    let actions = new Map<string, unknown>();
    try {
      actions = await readActions(supa, shortlist.map((row) => row.id));
    } catch (error) {
      pushError(errors, message(error));
      shortlist = [];
    }
    const names = new Map(fleet.map((horse) => [horse.profile_id, horse.name]));
    for (const kind of PUZZLE_KINDS) {
      const out = puzzles[kind];
      for (const row of shortlist) {
        if (out.samples.length >= PREVIEW_SAMPLES_PER_KIND) break;
        out.considered += 1;
        let composed: ReturnType<typeof composePuzzle>;
        try {
          composed = composePuzzle(kind, toReviewRow(row, actions.get(String(row.id)) ?? null), { salt: saltFor(), now });
        } catch (error) {
          composed = { ok: false, rejected: 'composer_threw' };
          pushError(errors, `composer threw for review ${row.id}: ${message(error)}`);
        }
        if (!composed.ok) { count(out.rejected, composed.rejected); continue; }
        out.composed += 1;
        out.samples.push(previewPuzzle(composed.puzzle, row, names.get(row.horse_user_id) ?? null));
      }
    }
  }

  const stories = {} as Record<StoryMode, PreviewStoryMode>;
  for (const mode of STORY_MODES) {
    if (!fleet) {
      stories[mode] = { considered: 0, drafted: 0, skipped: {}, samples: [], error: 'fleet read failed' };
      continue;
    }
    try {
      const drafted = await draftStories(mode, { supa, now, fleet }, PREVIEW_STORIES_PER_MODE);
      stories[mode] = {
        considered: drafted.considered,
        drafted: drafted.drafts.length,
        skipped: drafted.skipped ?? {},
        samples: drafted.drafts.slice(0, PREVIEW_STORIES_PER_MODE),
        error: null,
      };
    } catch (error) {
      stories[mode] = { considered: 0, drafted: 0, skipped: {}, samples: [], error: message(error) };
    }
  }

  return {
    success: true,
    preview: true,
    content_writes: 0,
    writes_note: PREVIEW_WRITES_NOTE,
    at: now.toISOString(),
    fleet: fleet ? fleet.length : null,
    candidates: selection ? { read: selection.read, eligible: selection.eligible.length, dropped: selection.dropped } : null,
    puzzles,
    stories,
    errors,
    timestamp: new Date().toISOString(),
  };
}
