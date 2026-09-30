/**
 * Behavioural Phase 7 tests through the real route handler and the real
 * run (Phase7Content.ts), with the fleet's in-memory PostgREST stand-in
 * plus an RPC stub. The composer (PuzzleComposer.ts) and the story writer
 * (Phase7Stories.ts) are mocked at their CONTRACT signatures, so these
 * tests pass against the stand-ins and against the real modules alike.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeDb, type Row } from '../lib/content-engine/testing/fakeSupabase.js';

const h = vi.hoisted(() => ({
  db: null as unknown as { client: { from: (table: string) => unknown } },
  rpc: vi.fn(),
  engineEnabled: vi.fn(),
  engineSwitch: vi.fn(),
  postModeEnabled: vi.fn(),
  loadFleet: vi.fn(),
  recentPostGuard: vi.fn(),
  composePuzzle: vi.fn(),
  draftStories: vi.fn(),
  recordPhrase: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (table: string) => h.db.client.from(table),
    rpc: (name: string, args: Row) => h.rpc(name, args),
  }),
}));
vi.mock('../lib/content-engine/Fleet.js', () => ({
  engineEnabled: h.engineEnabled,
  engineSwitch: h.engineSwitch,
  postModeEnabled: h.postModeEnabled,
  loadFleet: h.loadFleet,
}));
vi.mock('../lib/content-engine/HorsePublisher.js', () => ({ recentPostGuard: h.recentPostGuard }));
vi.mock('../lib/content-engine/ContentLedger.js', () => ({
  normalizePhrase: (value: string) => value,
  recordPhrase: h.recordPhrase,
}));
vi.mock('../lib/content-engine/PuzzleComposer.js', () => ({
  composePuzzle: h.composePuzzle,
  puzzleKey: (kind: string, handId: string) => `p7:${kind}:${handId}`,
}));
vi.mock('../lib/content-engine/Phase7Stories.js', () => ({
  STORY_MODES: ['live_tournament_story', 'throwback_hand', 'human_thread', 'rail_human'],
  draftStories: h.draftStories,
}));

import { phase7Content } from './phase7-content.js';
import {
  PUZZLES_PER_KIND_PER_RUN,
  PUZZLE_KINDS,
  REVEALS_PER_RUN,
  runPhase7,
  selectCandidates,
  storyInsert,
  type Phase7Preview,
  type Phase7RunResult,
} from '../lib/content-engine/Phase7Content.js';
import type { PuzzleReviewRow } from '../lib/content-engine/PuzzleComposer.js';
import type { StoryDraft, StoryMode } from '../lib/content-engine/Phase7Stories.js';

const NOW = new Date('2026-09-29T20:40:00Z');
const DAY = '2026-09-29';
const STORY_MODES: StoryMode[] = ['live_tournament_story', 'throwback_hand', 'human_thread', 'rail_human'];
const ALL_MODES = [...PUZZLE_KINDS.map((kind) => `puzzle_${kind}`), ...STORY_MODES];
const HORSES = ['horse-a', 'horse-b', 'horse-c', 'horse-d', 'horse-e'];
/** Sentinels: the correct answer and the explanation must never leak. */
const CORRECT_LABEL = 'ZZCORRECT pocket deuces, for quads';
const EXPLANATION = 'ZZEXPLAIN only pocket deuces make quads here';
const BOARD = [
  { rank: '2', suit: 'clubs' }, { rank: '7', suit: 'clubs' }, { rank: 'A', suit: 'clubs' },
  { rank: 'Q', suit: 'clubs' }, { rank: '2', suit: 'diamonds' },
];
const LETTER_BOARD = [
  { rank: '2', suit: 'c' }, { rank: '7', suit: 'c' }, { rank: 'A', suit: 'c' }, { rank: 'Q', suit: 'c' }, { rank: '2', suit: 'd' },
];

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

function review(id: number, overrides: Partial<Row> = {}): Row {
  return {
    id,
    hand_id: `hand-${String(id).padStart(3, '0')}`,
    horse_user_id: HORSES[id % HORSES.length]!,
    game_variant: 'nlh',
    format: 'cash',
    big_blind: 5,
    played_at: hoursAgo(3),
    net_bb: 40,
    is_win: true,
    pot_size: 1005,
    seat: 3,
    hole_cards: [{ rank: 'K', suit: 'clubs' }, { rank: '7', suit: 'diamonds' }],
    board: BOARD,
    actions: [{ seat: 3, stage: 'river', action: 'call', amount: 419, publicNode: { pot: 586 } }],
    ...overrides,
  };
}

function puzzleFor(kind: string, row: PuzzleReviewRow, salt: string) {
  const key = `p7:${kind}:${row.hand_id}`;
  return {
    ok: true as const,
    puzzle: {
      kind,
      puzzle_key: key,
      hand_id: row.hand_id,
      source_review_id: row.id,
      game_variant: row.game_variant,
      board: LETTER_BOARD,
      prompt: `Played this earlier today. Board [[sp-card:2c]][[sp-card:7c]][[sp-card:Ac]][[sp-card:Qc]][[sp-card:2d]]\nWhat is the nuts here? A, B, C or D. Answer comes in about six hours.`,
      options: [
        { key: 'A', label: 'ace of clubs with any club, for the nut flush' },
        { key: 'B', label: CORRECT_LABEL },
        { key: 'C', label: 'pocket aces, for aces full' },
        { key: 'D', label: 'pocket queens, for queens full' },
      ],
      correct_option: 'B',
      explanation: EXPLANATION,
      salt,
      answer_commitment: 'c0ffee'.repeat(10),
      proof: { category: 'quads', holdings: 1, enumerated: 1081, evaluator_version: 'p7-nlh-1' },
      evaluator_version: 'p7-nlh-1',
      rewardable: kind !== 'what_would_you_do',
      reveal_hours: 6,
    },
  };
}

function storyFor(mode: StoryMode, horse: string, suffix = '1'): StoryDraft {
  return {
    mode,
    horse: { name: `Horse ${horse}`, profile_id: horse },
    publication_key: `p7:${mode}:${horse}:${suffix}`,
    text: `A ${mode.replace(/_/g, ' ')} post from ${horse}, grounded in its own rows.`,
    topic: mode === 'live_tournament_story' ? 'tournament' : 'poker',
    grounding: { rows: [`${mode}-${horse}-${suffix}`] },
  };
}

function fleet(ids = HORSES) {
  h.loadFleet.mockResolvedValue(ids.map((id, index) => ({ id: index + 1, name: `Horse ${id}`, profile_id: id })));
}

function enable(...modes: string[]) {
  h.postModeEnabled.mockImplementation(async (mode: string) => modes.includes(mode));
}

function duePuzzle(n: number, overrides: Partial<Row> = {}): Row {
  return {
    id: `puzzle-${String(n).padStart(3, '0')}`,
    puzzle_key: `p7:nuts:due-${n}`,
    reveal_at: hoursAgo(n),
    revealed_at: null,
    ...overrides,
  };
}

function context(query: Record<string, string> = {}) {
  let captured = { body: null as unknown, status: 0 };
  const c = {
    req: { query: (key: string) => query[key] },
    json: (body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return captured;
    },
    get captured() { return captured; },
  };
  return c as unknown as Parameters<typeof phase7Content>[0] & { readonly captured: { body: unknown; status: number } };
}

async function run(query: Record<string, string> = {}) {
  const c = context(query);
  await phase7Content(c);
  return c.captured;
}

async function live(): Promise<Phase7RunResult> {
  return (await run()).body as Phase7RunResult;
}

async function preview(): Promise<Phase7Preview> {
  return (await run({ preview: '1', at: NOW.toISOString() })).body as Phase7Preview;
}

function rpcCalls(name: string): Row[] {
  return h.rpc.mock.calls.filter((call) => call[0] === name).map((call) => call[1] as Row);
}

function sample(name: string, body: unknown): void {
  const dir = process.env.P7_SAMPLES_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${JSON.stringify(body, null, 2)}\n`);
}

let db: FakeDb;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  db = new FakeDb();
  h.db = db;
  h.engineEnabled.mockResolvedValue(true);
  h.engineSwitch.mockResolvedValue('on');
  h.postModeEnabled.mockResolvedValue(false);
  h.recentPostGuard.mockResolvedValue('clear');
  h.recordPhrase.mockResolvedValue(undefined);
  h.composePuzzle.mockImplementation((kind: string, row: PuzzleReviewRow, opts: { salt: string }) => puzzleFor(kind, row, opts.salt));
  h.draftStories.mockImplementation(async () => ({ drafts: [], skipped: {}, considered: 0 }));
  h.rpc.mockImplementation(async (name: string, args: Row) => {
    if (name === 'fn_p7_publish_puzzle') {
      return { data: { status: 'created', puzzle_id: `pz-${String(args.p_hand_id)}`, post_id: `post-${String(args.p_hand_id)}` }, error: null };
    }
    if (name === 'fn_p7_reveal_puzzle') {
      return { data: { status: 'revealed', answers: 3, correct: 2, paid: 1, refused: { action_limit: 1 } }, error: null };
    }
    return { data: null, error: { message: `unknown rpc ${name}` } };
  });
  fleet();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('master switch', () => {
  it('engine off: {skipped: engine_disabled} and zero operations', async () => {
    h.engineEnabled.mockResolvedValue(false);
    db.seed('social_puzzles', [duePuzzle(1)]);
    const captured = await run();
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ success: true, skipped: 'engine_disabled', preview: false });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.postModeEnabled).not.toHaveBeenCalled();
    expect(h.loadFleet).not.toHaveBeenCalled();
    expect(db.log).toHaveLength(0);
  });

  it('engine switched off mid-run: stops before the next write and reports what it left', async () => {
    db.seed('social_puzzles', [duePuzzle(1), duePuzzle(2), duePuzzle(3)]);
    db.seed('horse_hand_reviews', [review(1), review(2)]);
    enable('puzzle_nuts', 'human_thread');
    h.draftStories.mockImplementation(async (mode: StoryMode) => ({ drafts: [storyFor(mode, 'horse-a')], skipped: {}, considered: 1 }));
    h.engineSwitch.mockResolvedValueOnce('on').mockResolvedValue('off');
    const body = await live();
    expect(body.stopped).toBe('engine_disabled');
    expect(rpcCalls('fn_p7_reveal_puzzle')).toHaveLength(1);
    expect(body.reveals).toMatchObject({ due: 3, attempted: 1, revealed: 1, remaining: 2 });
    expect(rpcCalls('fn_p7_publish_puzzle')).toHaveLength(0);
    expect(body.puzzles.nuts).toMatchObject({ mode_enabled: true, eligible: 2, attempted: 0, created: 0, skipped: { not_attempted: 2 } });
    expect(body.stories.human_thread.skipped.not_started).toBe(1);
    expect(h.draftStories).not.toHaveBeenCalled();
    expect(db.writes('social_posts')).toHaveLength(0);
  });

  it('engine unreadable mid-run: stops the same way and names the reason', async () => {
    db.seed('social_puzzles', [duePuzzle(1), duePuzzle(2)]);
    h.engineSwitch.mockResolvedValue('unreadable');
    const body = await live();
    expect(body.stopped).toBe('engine_unreadable');
    expect(body.reveals).toMatchObject({ due: 2, attempted: 0, remaining: 2 });
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe('preview', () => {
  it('returns samples of every puzzle kind and story mode with zero content writes and no RPC, while every mode is off', async () => {
    db.seed('horse_hand_reviews', [review(1), review(2), review(3)]);
    db.seed('social_puzzles', [duePuzzle(1)]);
    h.draftStories.mockImplementation(async (mode: StoryMode) => ({
      drafts: [storyFor(mode, 'horse-a'), storyFor(mode, 'horse-b', '2')],
      skipped: { no_rows: 4 },
      considered: 6,
    }));
    const body = await preview();
    sample('preview.json', body);
    expect(body).toMatchObject({ success: true, preview: true, content_writes: 0 });
    expect(body.writes_note).toContain('no content writes');
    expect(body.writes_note).toContain('cron_execution_log');
    expect(body.at).toBe(NOW.toISOString());
    for (const kind of PUZZLE_KINDS) {
      expect(body.puzzles[kind].samples).toHaveLength(3);
      expect(body.puzzles[kind].samples[0]).toMatchObject({ kind, proof: { enumerated: 1081 }, correct_option: 'B' });
      expect(body.puzzles[kind].samples[0]).not.toHaveProperty('salt');
      expect(body.puzzles[kind].samples[0]!.grounding).toEqual({
        source_review_id: expect.any(Number), hand_id: expect.any(String), played_at: expect.any(String),
        game_variant: 'nlh', format: 'cash', big_blind: 5,
      });
    }
    for (const mode of STORY_MODES) {
      expect(body.stories[mode].samples).toHaveLength(2);
      expect(body.stories[mode]).toMatchObject({ considered: 6, drafted: 2, skipped: { no_rows: 4 }, error: null });
    }
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.postModeEnabled).not.toHaveBeenCalled();
    expect(h.recentPostGuard).not.toHaveBeenCalled();
    expect(db.log.filter((op) => op.kind !== 'select')).toHaveLength(0);
    // Preview reads hands and their actions, never the due queue.
    expect(db.log.some((op) => op.table === 'social_puzzles')).toBe(false);
  });

  it('composes with the real clock when at= is absent and refuses a bad at=', async () => {
    const bad = await run({ preview: '1', at: 'not-a-date' });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ success: false, error: 'invalid_at' });
    const body = await preview();
    expect(body.candidates).toEqual({ read: 0, eligible: 0, dropped: { malformed: 0, variant: 0, board: 0, net_bb: 0, not_on_roster: 0, same_hand: 0 } });
  });

  it('counts composer rejections by reason and reports a broken roster without composing', async () => {
    db.seed('horse_hand_reviews', [review(1), review(2)]);
    h.composePuzzle.mockImplementation((kind: string, row: PuzzleReviewRow, opts: { salt: string }) =>
      kind === 'nuts' ? { ok: false, rejected: 'nuts_on_board' } : puzzleFor(kind, row, opts.salt));
    const body = await preview();
    expect(body.puzzles.nuts).toMatchObject({ considered: 2, composed: 0, rejected: { nuts_on_board: 2 }, samples: [] });
    expect(body.puzzles.pot_odds.samples).toHaveLength(2);

    h.loadFleet.mockRejectedValue(new Error('content_authors read failed'));
    const broken = await preview();
    expect(broken.errors.join(' ')).toContain('fleet read failed');
    expect(broken.candidates).toBeNull();
    for (const mode of STORY_MODES) expect(broken.stories[mode].error).toBe('fleet read failed');
    expect(h.draftStories).toHaveBeenCalledTimes(4);
  });
});

describe('mode rows off', () => {
  it('still reveals due puzzles, and every publish and story step reports mode_disabled', async () => {
    db.seed('social_puzzles', [duePuzzle(1), duePuzzle(2)]);
    db.seed('horse_hand_reviews', [review(1)]);
    const body = await live();
    sample('live-modes-off.json', body);
    expect(rpcCalls('fn_p7_reveal_puzzle')).toHaveLength(2);
    expect(body.reveals).toMatchObject({ due: 2, attempted: 2, revealed: 2, answers_graded: 6, correct: 4, paid: 2, refused: { action_limit: 2 } });
    expect(h.postModeEnabled).toHaveBeenCalledTimes(ALL_MODES.length);
    for (const mode of ALL_MODES) expect(h.postModeEnabled).toHaveBeenCalledWith(mode);
    for (const kind of PUZZLE_KINDS) {
      expect(body.puzzles[kind]).toMatchObject({ mode_enabled: false, created: 0, skipped: { mode_disabled: 1 } });
    }
    for (const mode of STORY_MODES) {
      expect(body.stories[mode]).toMatchObject({ mode_enabled: false, posted: 0, skipped: { mode_disabled: 1 } });
    }
    expect(rpcCalls('fn_p7_publish_puzzle')).toHaveLength(0);
    expect(h.loadFleet).not.toHaveBeenCalled();
    expect(db.log.some((op) => op.table === 'horse_hand_reviews')).toBe(false);
    expect(h.draftStories).not.toHaveBeenCalled();
  });
});

describe('reveal step', () => {
  it('calls fn_p7_reveal_puzzle once per due puzzle, oldest first, capped at 50, and tallies every status', async () => {
    // 60 due (oldest = 60 hours ago), one not due, one already revealed.
    const due = Array.from({ length: 60 }, (_, i) => duePuzzle(60 - i));
    db.seed('social_puzzles', [
      ...due,
      duePuzzle(0, { id: 'puzzle-future', reveal_at: new Date(NOW.getTime() + 3_600_000).toISOString() }),
      duePuzzle(99, { id: 'puzzle-done', revealed_at: hoursAgo(1) }),
    ]);
    h.rpc.mockImplementation(async (_name: string, args: Row) => {
      const id = String(args.p_puzzle_id);
      if (id === 'puzzle-060') return { data: { status: 'already_revealed' }, error: null };
      if (id === 'puzzle-059') return { data: { status: 'closed_post_gone' }, error: null };
      if (id === 'puzzle-058') return { data: { status: 'not_due' }, error: null };
      if (id === 'puzzle-057') return { data: null, error: { message: 'deadlock detected' } };
      if (id === 'puzzle-056') return { data: { status: 'something_else' }, error: null };
      return { data: { status: 'revealed', answers: 2, correct: 1, paid: 1, refused: {} }, error: null };
    });
    const body = await live();
    const calls = rpcCalls('fn_p7_reveal_puzzle');
    expect(calls).toHaveLength(REVEALS_PER_RUN);
    expect(calls.map((args) => args.p_puzzle_id).slice(0, 3)).toEqual(['puzzle-060', 'puzzle-059', 'puzzle-058']);
    expect(calls.map((args) => args.p_puzzle_id)).not.toContain('puzzle-future');
    expect(calls.map((args) => args.p_puzzle_id)).not.toContain('puzzle-done');
    expect(body.reveals).toMatchObject({
      due: 50, cap_hit: true, attempted: 50, revealed: 45, already_revealed: 1, closed_post_gone: 1, not_due: 1, failed: 2,
      answers_graded: 90, correct: 45, paid: 45, remaining: 0,
    });
    expect(body.reveals.errors.join(' ')).toContain('deadlock detected');
    expect(body.reveals.errors.join(' ')).toContain('unreadable result');
  });

  it('fails closed when the due queue cannot be read', async () => {
    db.fail((op) => op.table === 'social_puzzles' && op.kind === 'select', { message: 'statement timeout', code: '57014' });
    const body = await live();
    expect(body.reveals).toMatchObject({ due: 0, read_failed: true, attempted: 0 });
    expect(body.reveals.errors[0]).toContain('statement timeout');
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe('publish step', () => {
  it('filters candidates (variant, board length, net_bb, roster), keeps one row per hand, and tries them in the deterministic order', async () => {
    const rows = [
      review(1),
      review(2, { game_variant: 'plo4' }),
      review(3, { board: BOARD.slice(0, 4) }),
      review(4, { net_bb: 10 }),
      review(5, { net_bb: -5 }),
      review(6, { horse_user_id: 'not-a-horse' }),
      review(7, { net_bb: -100 }),
      review(8, { hand_id: 'hand-007', net_bb: 60, horse_user_id: 'horse-c' }),
    ];
    db.seed('horse_hand_reviews', rows);
    enable('puzzle_nuts');
    const body = await live();
    const expected = selectCandidates(rows, new Set(HORSES), DAY);
    expect(expected.eligible.map((row) => row.hand_id).sort()).toEqual(['hand-001', 'hand-007']);
    // The more eventful seat represents the shared hand (row 7 lost 100 bb; row 8 won 60).
    expect(expected.eligible.find((row) => row.hand_id === 'hand-007')!.id).toBe(7);
    // The pure selector re-applies every filter the query asked for.
    expect(expected.dropped).toEqual({ malformed: 0, variant: 1, board: 1, net_bb: 2, not_on_roster: 1, same_hand: 1 });
    // The query already held back the PLO row and the two small pots (5 rows read).
    expect(body.candidates).toEqual({
      read: 5, eligible: 2, dropped: { malformed: 0, variant: 0, board: 1, net_bb: 0, not_on_roster: 1, same_hand: 1 },
    });
    const published = rpcCalls('fn_p7_publish_puzzle');
    expect(published.map((args) => args.p_hand_id)).toEqual(expected.eligible.map((row) => row.hand_id));
    expect(body.puzzles.nuts).toMatchObject({ mode_enabled: true, candidates: 5, eligible: 2, attempted: 2, created: 2 });
  });

  it('is deterministic: the same hands on the same day come out in the same order regardless of read order', async () => {
    const rows = [review(11), review(12), review(13), review(14)];
    const forward = selectCandidates(rows, new Set(HORSES), DAY).eligible.map((row) => row.hand_id);
    const backward = selectCandidates([...rows].reverse(), new Set(HORSES), DAY).eligible.map((row) => row.hand_id);
    expect(backward).toEqual(forward);
    expect(selectCandidates(rows, new Set(HORSES), '2026-09-30').eligible.map((row) => row.hand_id)).not.toEqual(forward);
  });

  it('publishes at most 3 per kind per run and reports the cap', async () => {
    db.seed('horse_hand_reviews', [review(1), review(2), review(3), review(4), review(5)]);
    enable('puzzle_nuts', 'puzzle_pot_odds');
    const body = await live();
    sample('live-puzzles.json', body);
    expect(rpcCalls('fn_p7_publish_puzzle').filter((args) => args.p_kind === 'nuts')).toHaveLength(PUZZLES_PER_KIND_PER_RUN);
    expect(rpcCalls('fn_p7_publish_puzzle').filter((args) => args.p_kind === 'pot_odds')).toHaveLength(PUZZLES_PER_KIND_PER_RUN);
    expect(body.puzzles.nuts).toMatchObject({ created: 3, attempted: 3, cap_hit: true, eligible: 5 });
    expect(body.puzzles.pot_odds).toMatchObject({ created: 3, cap_hit: true });
    expect(body.puzzles.what_would_you_do).toMatchObject({ mode_enabled: false, skipped: { mode_disabled: 1 } });
  });

  it('skips a hand whose puzzle key already exists, a horse that posted recently, and an unreadable guard (fail closed), counting each', async () => {
    db.seed('horse_hand_reviews', [
      review(1, { horse_user_id: 'horse-a' }), review(2, { horse_user_id: 'horse-b' }), review(3, { horse_user_id: 'horse-c' }),
    ]);
    db.seed('social_puzzles', [{ id: 'existing', puzzle_key: 'p7:nuts:hand-001', revealed_at: hoursAgo(1), reveal_at: hoursAgo(2) }]);
    h.recentPostGuard.mockImplementation(async (profileId: string) => {
      if (profileId === 'horse-b') return 'posted_recently';
      if (profileId === 'horse-c') return 'guard_unreadable';
      return 'clear';
    });
    enable('puzzle_nuts');
    const body = await live();
    expect(rpcCalls('fn_p7_publish_puzzle')).toHaveLength(0);
    expect(body.puzzles.nuts).toMatchObject({
      attempted: 3, created: 0, skipped: { key_exists: 1, posted_recently: 1, guard_unreadable: 1, evaluator_rejected: 0 },
    });
    // The guard read that throws is not 'clear' either.
    h.recentPostGuard.mockRejectedValue(new Error('guard read threw'));
    db.seed('horse_hand_reviews', [review(4)]);
    const again = await live();
    expect(again.puzzles.nuts.skipped.guard_unreadable).toBe(3);
    expect(rpcCalls('fn_p7_publish_puzzle')).toHaveLength(0);
  });

  it('counts composer rejections by reason and a composer that throws', async () => {
    db.seed('horse_hand_reviews', [review(1), review(2), review(3)]);
    h.composePuzzle.mockImplementation((_kind: string, row: PuzzleReviewRow) => {
      if (row.id === 1) return { ok: false, rejected: 'nuts_on_board' };
      if (row.id === 2) return { ok: false, rejected: 'no_river_bet' };
      throw new Error('composer bug');
    });
    enable('puzzle_pot_odds');
    const body = await live();
    expect(body.puzzles.pot_odds).toMatchObject({
      attempted: 3, created: 0, skipped: { evaluator_rejected: 3 }, rejected: { nuts_on_board: 1, no_river_bet: 1, composer_threw: 1 },
    });
    expect(body.puzzles.pot_odds.errors.join(' ')).toContain('composer bug');
    expect(rpcCalls('fn_p7_publish_puzzle')).toHaveLength(0);
  });

  it('tallies created, duplicate and failed from the publish RPC and passes every contract argument', async () => {
    db.seed('horse_hand_reviews', [review(1), review(2), review(3)]);
    const order = selectCandidates([review(1), review(2), review(3)], new Set(HORSES), DAY).eligible.map((row) => row.hand_id);
    h.rpc.mockImplementation(async (name: string, args: Row) => {
      if (name !== 'fn_p7_publish_puzzle') return { data: null, error: { message: 'unexpected' } };
      if (args.p_hand_id === order[0]) return { data: { status: 'created', puzzle_id: 'pz-1', post_id: 'post-1' }, error: null };
      if (args.p_hand_id === order[1]) return { data: { status: 'duplicate', puzzle_id: 'pz-2', post_id: 'post-2' }, error: null };
      return { data: null, error: { message: 'horse is not active' } };
    });
    enable('puzzle_what_would_you_do');
    const body = await live();
    expect(body.puzzles.what_would_you_do).toMatchObject({ attempted: 3, created: 1, duplicate: 1, failed: 1 });
    expect(body.puzzles.what_would_you_do.errors[0]).toContain('horse is not active');
    const args = rpcCalls('fn_p7_publish_puzzle')[0]!;
    expect(Object.keys(args).sort()).toEqual([
      'p_author_id', 'p_board', 'p_correct_option', 'p_evaluator_version', 'p_explanation', 'p_game_variant', 'p_hand_id',
      'p_kind', 'p_metadata', 'p_options', 'p_prompt', 'p_proof', 'p_reveal_hours', 'p_rewardable', 'p_salt', 'p_source_review_id',
    ]);
    expect(args).toMatchObject({
      p_kind: 'what_would_you_do', p_hand_id: order[0], p_game_variant: 'nlh', p_board: LETTER_BOARD, p_correct_option: 'B',
      p_evaluator_version: 'p7-nlh-1', p_rewardable: false, p_reveal_hours: 6,
    });
    expect(String(args.p_salt)).toMatch(/^[0-9a-f]{64}$/);
    expect(HORSES).toContain(args.p_author_id);
    expect(args.p_metadata).toEqual({
      scheduler: 'phase7',
      grounding: { source_review_id: expect.any(Number), hand_id: order[0], played_at: hoursAgo(3), game_variant: 'nlh', format: 'cash', big_blind: 5 },
    });
    // The composer saw the row with its action log.
    const composed = h.composePuzzle.mock.calls[0]![1] as PuzzleReviewRow;
    expect(Array.isArray(composed.actions)).toBe(true);
    expect(composed).toMatchObject({ hand_id: order[0], net_bb: 40, big_blind: 5, seat: 3 });
  });

  it('never puts the correct option in p_metadata, in the result, or in a log line', async () => {
    db.seed('horse_hand_reviews', [review(1), review(2)]);
    db.seed('social_puzzles', [duePuzzle(1)]);
    enable(...ALL_MODES);
    h.draftStories.mockImplementation(async (mode: StoryMode) => ({ drafts: [storyFor(mode, 'horse-a')], skipped: {}, considered: 1 }));
    const logged: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => { logged.push(parts.map(String).join(' ')); });
    }
    const body = await live();
    sample('live-all-modes.json', body);
    const published = rpcCalls('fn_p7_publish_puzzle');
    expect(published.length).toBeGreaterThan(0);
    for (const args of published) {
      const metadata = JSON.stringify(args.p_metadata);
      expect(metadata).not.toContain('ZZCORRECT');
      expect(metadata).not.toContain('ZZEXPLAIN');
      expect(metadata).not.toContain('correct_option');
      expect(metadata).not.toContain('"B"');
      // The answer travels only as the RPC's own arguments, which it stores server-side.
      expect(args.p_correct_option).toBe('B');
      expect(args.p_explanation).toBe(EXPLANATION);
    }
    const result = JSON.stringify(body);
    expect(result).not.toContain('ZZCORRECT');
    expect(result).not.toContain('ZZEXPLAIN');
    expect(result).not.toContain('correct_option');
    expect(logged.join('\n')).not.toMatch(/ZZCORRECT|ZZEXPLAIN|correct_option/);
    for (const row of db.rows('social_posts')) {
      expect(JSON.stringify(row)).not.toMatch(/ZZCORRECT|ZZEXPLAIN/);
    }
  });

  it('publishes nothing for any kind when the candidate read or the roster fails', async () => {
    db.seed('horse_hand_reviews', [review(1)]);
    enable('puzzle_nuts', 'puzzle_pot_odds');
    db.fail((op) => op.table === 'horse_hand_reviews' && op.kind === 'select', { message: 'canceling statement', code: '57014' });
    const body = await live();
    expect(rpcCalls('fn_p7_publish_puzzle')).toHaveLength(0);
    expect(body.puzzles.nuts).toMatchObject({ mode_enabled: true, failed: 1, created: 0 });
    expect(body.puzzles.nuts.errors[0]).toContain('canceling statement');
    expect(body.errors[0]).toContain('candidate read failed');

    h.loadFleet.mockRejectedValue(new Error('content_authors read failed'));
    const noRoster = await live();
    expect(noRoster.puzzles.pot_odds.errors[0]).toContain('fleet read failed');
    expect(noRoster.fleet).toBeNull();
    expect(rpcCalls('fn_p7_publish_puzzle')).toHaveLength(0);
  });
});

describe('story step', () => {
  function drafts(mode: StoryMode, ...horses: string[]) {
    h.draftStories.mockImplementation(async (m: StoryMode) => (m === mode
      ? { drafts: horses.map((horse) => storyFor(mode, horse)), skipped: { no_rows: 2 }, considered: horses.length + 2 }
      : { drafts: [], skipped: {}, considered: 0 }));
  }

  it('inserts the Phase 6 shape with Phase 7 metadata, and never the publication_key column', async () => {
    drafts('throwback_hand', 'horse-a', 'horse-b');
    enable('throwback_hand');
    const body = await live();
    sample('live-stories.json', body);
    expect(body.stories.throwback_hand).toMatchObject({ mode_enabled: true, considered: 4, drafted: 2, attempted: 2, posted: 2, duplicate: 0, failed: 0, skipped: { no_rows: 2 } });
    const rows = db.rows('social_posts');
    expect(rows).toHaveLength(2);
    const draft = storyFor('throwback_hand', 'horse-a');
    const written = db.writes('social_posts')[0]!.values[0]!;
    expect(written).toEqual(storyInsert('throwback_hand', draft));
    expect(written).toEqual({
      author_id: 'horse-a',
      content: draft.text,
      content_type: 'text',
      media_urls: [],
      visibility: 'public',
      link_url: null,
      topic: 'poker',
      topics: ['poker', 'story'],
      metadata: { scheduler: 'phase7', phase7_mode: 'throwback_hand', publication_key: draft.publication_key, grounding: draft.grounding },
    });
    expect(Object.prototype.hasOwnProperty.call(written, 'publication_key')).toBe(false);
    expect(h.recordPhrase).toHaveBeenCalledTimes(2);
    expect(h.recordPhrase).toHaveBeenCalledWith(draft.text, 'horse-a', expect.any(String));
    expect(h.draftStories).toHaveBeenCalledWith('throwback_hand', expect.objectContaining({ now: NOW, fleet: expect.any(Array) }), expect.any(Number));
  });

  it('states the story topic: poker first, tournament as a facet of a live tournament story, story last', () => {
    expect(storyInsert('live_tournament_story', storyFor('live_tournament_story', 'horse-a'))).toMatchObject({ topic: 'poker', topics: ['poker', 'tournament', 'story'] });
    for (const mode of ['throwback_hand', 'human_thread', 'rail_human'] as const) {
      expect(storyInsert(mode, storyFor(mode, 'horse-a'))).toMatchObject({ topic: 'poker', topics: ['poker', 'story'] });
    }
  });

  it('counts a key already on the feed as duplicate before writing, and a 23505 on insert as duplicate, never failure', async () => {
    drafts('human_thread', 'horse-a', 'horse-b');
    enable('human_thread');
    db.seed('social_posts', [{ id: 'earlier', author_id: 'horse-a', metadata: { publication_key: storyFor('human_thread', 'horse-a').publication_key } }]);
    db.fail((op) => op.table === 'social_posts' && op.kind === 'insert', { code: '23505', message: 'duplicate key value violates unique constraint "uq_social_posts_metadata_publication_key"' });
    const body = await live();
    expect(body.stories.human_thread).toMatchObject({ attempted: 2, posted: 0, duplicate: 2, failed: 0 });
    expect(db.writes('social_posts')).toHaveLength(1);
    expect(h.recordPhrase).not.toHaveBeenCalled();
  });

  it('holds a draft for a horse that posted recently, an unreadable guard, or an author off the roster, and counts a failed insert', async () => {
    drafts('rail_human', 'horse-a', 'horse-b', 'horse-c', 'stranger');
    enable('rail_human');
    h.recentPostGuard.mockImplementation(async (profileId: string) => (profileId === 'horse-a' ? 'posted_recently' : profileId === 'horse-b' ? 'guard_unreadable' : 'clear'));
    db.fail((op) => op.table === 'social_posts' && op.kind === 'insert', { message: 'connection reset' });
    const body = await live();
    expect(body.stories.rail_human).toMatchObject({
      attempted: 4, posted: 0, duplicate: 0, failed: 1,
      skipped: { posted_recently: 1, guard_unreadable: 1, author_not_on_roster: 1, no_rows: 2 },
    });
    expect(body.stories.rail_human.errors[0]).toContain('connection reset');
  });

  it('reports a story writer that throws as failed for that mode only', async () => {
    h.draftStories.mockImplementation(async (mode: StoryMode) => {
      if (mode === 'live_tournament_story') throw new Error('tournaments read failed');
      return { drafts: [storyFor(mode, 'horse-d')], skipped: {}, considered: 1 };
    });
    enable('live_tournament_story', 'throwback_hand');
    const body = await live();
    expect(body.stories.live_tournament_story).toMatchObject({ failed: 1, posted: 0 });
    expect(body.stories.live_tournament_story.errors[0]).toContain('tournaments read failed');
    expect(body.stories.throwback_hand.posted).toBe(1);
  });
});

describe('budget and shape', () => {
  it('stops at the deadline before the next write and reports what remains', async () => {
    db.seed('social_puzzles', [duePuzzle(1), duePuzzle(2), duePuzzle(3), duePuzzle(4), duePuzzle(5)]);
    db.seed('horse_hand_reviews', [review(1), review(2)]);
    enable('puzzle_nuts', 'human_thread');
    h.draftStories.mockImplementation(async (mode: StoryMode) => ({ drafts: [storyFor(mode, 'horse-a')], skipped: {}, considered: 1 }));
    let tick = 0;
    const clock = () => { tick += 600; return tick; };
    const body = await runPhase7({ now: NOW, clock, deadlineMs: 1_000 });
    expect(body.deadline_hit).toBe(true);
    expect(body.stopped).toBeNull();
    expect(rpcCalls('fn_p7_reveal_puzzle')).toHaveLength(1);
    expect(body.reveals).toMatchObject({ due: 5, attempted: 1, remaining: 4 });
    expect(body.puzzles.nuts).toMatchObject({ attempted: 0, skipped: { not_attempted: 2 } });
    expect(body.stories.human_thread.skipped.not_started).toBe(1);
    expect(rpcCalls('fn_p7_publish_puzzle')).toHaveLength(0);
    expect(body.limits.deadline_ms).toBe(1_000);
  });

  it('returns the full result shape on every live run', async () => {
    const body = await live();
    expect(Object.keys(body).sort()).toEqual([
      'at', 'candidates', 'deadline_hit', 'duration_ms', 'errors', 'fleet', 'limits', 'preview', 'puzzles', 'reveals', 'stopped', 'stories', 'success', 'timestamp',
    ]);
    expect(Object.keys(body.reveals).sort()).toEqual([
      'already_revealed', 'answers_graded', 'attempted', 'cap_hit', 'closed_post_gone', 'correct', 'due', 'errors', 'failed', 'not_due', 'paid', 'read_failed', 'refused', 'remaining', 'revealed',
    ]);
    expect(Object.keys(body.puzzles).sort()).toEqual(['nuts', 'pot_odds', 'what_would_you_do']);
    for (const kind of PUZZLE_KINDS) {
      expect(Object.keys(body.puzzles[kind]).sort()).toEqual([
        'attempted', 'candidates', 'cap_hit', 'created', 'duplicate', 'eligible', 'errors', 'failed', 'mode_enabled', 'rejected', 'skipped',
      ]);
      expect(Object.keys(body.puzzles[kind].skipped).sort()).toEqual([
        'evaluator_rejected', 'guard_unreadable', 'key_exists', 'mode_disabled', 'not_attempted', 'posted_recently',
      ]);
    }
    expect(Object.keys(body.stories).sort()).toEqual([...STORY_MODES].sort());
    for (const mode of STORY_MODES) {
      expect(Object.keys(body.stories[mode]).sort()).toEqual([
        'attempted', 'considered', 'drafted', 'duplicate', 'errors', 'failed', 'mode_enabled', 'posted', 'skipped',
      ]);
    }
    expect(body.limits).toEqual({
      reveals_per_run: 50, puzzles_per_kind_per_run: 3, puzzle_attempts_per_kind: 30, stories_per_mode_per_run: 20, deadline_ms: 240_000, concurrency: 1,
    });
  });

  it('answers 500 with the error when the run itself throws', async () => {
    h.postModeEnabled.mockRejectedValue(new Error('modes table gone'));
    const captured = await run();
    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({ success: false, error: 'modes table gone' });
  });
});
