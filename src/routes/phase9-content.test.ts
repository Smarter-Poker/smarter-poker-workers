/**
 * Behavioural Phase 9.1 tests through the real route handler and the real
 * run, with the fleet's in-memory PostgREST stand-in. The two fleet
 * dependencies are mocked at their CONTRACT signatures: Fleet.js (the master
 * switch and the mode row) and HorsePublisher.js (fleetSlotId returns the
 * slot or null, fleetPublicationKey names it). The last block reads the
 * sources and pins the wiring and the laws the behavioural tests cannot see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeDb, type Row } from '../lib/content-engine/testing/fakeSupabase.js';

const h = vi.hoisted(() => ({
  db: null as unknown as { client: { from: (table: string) => unknown } },
  engineSwitch: vi.fn(),
  readPostModeStates: vi.fn(),
  fleetSlotId: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({ from: (table: string) => h.db.client.from(table) }),
}));
vi.mock('../lib/content-engine/Fleet.js', () => ({
  engineSwitch: h.engineSwitch,
  readPostModeStates: h.readPostModeStates,
}));
vi.mock('../lib/content-engine/HorsePublisher.js', () => ({
  fleetSlotId: h.fleetSlotId,
  fleetPublicationKey: (profileId: string, slot: string) => `fleet:${profileId}:${slot}`,
}));

import { phase9Content } from './phase9-content.js';
import {
  buildCaption,
  CANDIDATE_LIMIT,
  CAPTION_DASHES,
  CAPTION_EMOJI,
  captionPassesLaw,
  CLIP_STYLE,
  DRY_RUN_WRITES_NOTE,
  EXCLUSION_CHECK_ROWS,
  excludeClipped,
  formatBlind,
  HAND_CLIP_MODE,
  POOL_MAX_ROWS,
  rankPool,
  runPhase9,
  UNKNOWN_VARIANT_LABEL,
  VARIANT_LABELS,
  variantLabel,
  type Phase9Result,
} from './phase9-content.js';

const NOW = new Date('2026-09-29T20:40:00Z');
const SLOT = '2026-09-29T14';
const TZ = 'America/Chicago';

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

/** A winning review: 100 big blinds for horse-a unless overridden. */
function review(id: number, overrides: Partial<Row> = {}): Row {
  return {
    id,
    hand_id: `hand-${String(id).padStart(3, '0')}`,
    horse_user_id: 'horse-a',
    game_variant: 'nlh',
    format: 'cash',
    big_blind: 5,
    pot_size: 500,
    seat: 3,
    is_win: true,
    net_bb: 40,
    played_at: hoursAgo(3),
    created_at: hoursAgo(3),
    ...overrides,
  };
}

function author(profileId: string, overrides: Partial<Row> = {}): Row {
  return { id: profileId, name: `Horse ${profileId}`, profile_id: profileId, timezone: TZ, is_active: true, ...overrides };
}

/** The pick-order fixture: horse-b's 600 BB pot, then horse-c's 300, then horse-a's 100. */
function seedPickFixture(): void {
  h.db.seed('horse_hand_reviews', [
    review(1),
    review(2, { horse_user_id: 'horse-b', big_blind: 2, pot_size: 1200, seat: 7, game_variant: 'plo5' }),
    review(3, { horse_user_id: 'horse-c', big_blind: 100, pot_size: 30000, seat: 1, game_variant: 'short_deck' }),
    review(4, { big_blind: 5, pot_size: 50 }), // 10 BB: under the floor
    review(5, { big_blind: 1, pot_size: 1000, played_at: hoursAgo(30), created_at: hoursAgo(30) }), // outside the window
    review(6, { is_win: false, big_blind: 1, pot_size: 5000 }),
  ]);
  h.db.seed('content_authors', [author('horse-a'), author('horse-b', { timezone: 'Europe/London' }), author('horse-c')]);
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
  return c as unknown as Parameters<typeof phase9Content>[0] & { readonly captured: { body: unknown; status: number } };
}

async function run(query: Record<string, string> = {}) {
  const c = context(query);
  await phase9Content(c);
  return c.captured;
}

async function live(): Promise<Phase9Result> {
  return (await run()).body as Phase9Result;
}

async function dryRun(query: Record<string, string> = {}): Promise<Phase9Result> {
  return (await run({ dry_run: '1', ...query })).body as Phase9Result;
}

function reads(table: string) {
  return db.log.filter((op) => op.table === table && op.kind === 'select');
}

function sample(name: string, body: unknown): void {
  const dir = process.env.P9_SAMPLES_DIR;
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
  h.engineSwitch.mockResolvedValue('on');
  h.readPostModeStates.mockResolvedValue({ [HAND_CLIP_MODE]: true });
  h.fleetSlotId.mockReturnValue(SLOT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('gates', () => {
  it('engine off: skipped engine_disabled, nothing read, the mode row not even asked', async () => {
    h.engineSwitch.mockResolvedValue('off');
    seedPickFixture();
    const captured = await run();
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ ok: true, skipped: 'engine_disabled', enqueued: 0, candidates: 0, dry_run: false });
    expect(h.engineSwitch).toHaveBeenCalledWith({ fresh: true });
    expect(h.readPostModeStates).not.toHaveBeenCalled();
    expect(db.log).toHaveLength(0);
  });

  it('engine unreadable: skipped engine_unreadable and nothing read', async () => {
    h.engineSwitch.mockResolvedValue('unreadable');
    seedPickFixture();
    const body = await live();
    expect(body).toMatchObject({ ok: true, skipped: 'engine_unreadable', enqueued: 0, gates: { engine: 'unreadable', mode: 'not_read' } });
    expect(db.log).toHaveLength(0);
  });

  it('mode off: skipped mode_disabled and no review read', async () => {
    h.readPostModeStates.mockResolvedValue({ [HAND_CLIP_MODE]: false });
    seedPickFixture();
    const body = await live();
    expect(body).toMatchObject({ ok: true, skipped: 'mode_disabled', enqueued: 0, candidates: 0, gates: { engine: 'on', mode: 'off' } });
    expect(h.readPostModeStates).toHaveBeenCalledWith([HAND_CLIP_MODE]);
    expect(db.log).toHaveLength(0);
  });

  it('mode unreadable (the row missing or the table down): skipped mode_unreadable, nothing read', async () => {
    h.readPostModeStates.mockRejectedValue(new Error('horse post modes missing: hand_clip'));
    seedPickFixture();
    const body = await live();
    expect(body).toMatchObject({ ok: true, skipped: 'mode_unreadable', enqueued: 0, gates: { engine: 'on', mode: 'unreadable' } });
    expect(reads('horse_hand_reviews')).toHaveLength(0);
    expect(db.writes('hand_clip_jobs')).toHaveLength(0);
  });

  it('engine switched off between the pick and the write: no insert', async () => {
    h.engineSwitch.mockResolvedValueOnce('on').mockResolvedValue('off');
    seedPickFixture();
    const body = await live();
    expect(body).toMatchObject({ ok: true, skipped: 'engine_disabled', enqueued: 0, candidates: 3 });
    expect(body.pick?.hand_id).toBe('hand-002');
    expect(h.engineSwitch).toHaveBeenCalledTimes(2);
    expect(db.writes('hand_clip_jobs')).toHaveLength(0);
  });
});

describe('the pick', () => {
  it('ranks by pot in big blinds, drops small pots, ignores the window edge and losses, and enqueues the best', async () => {
    seedPickFixture();
    const captured = await run();
    const body = captured.body as Phase9Result;
    expect(captured.status).toBe(200);
    expect(body).toMatchObject({ ok: true, enqueued: 1, candidates: 3, dry_run: false, gates: { engine: 'on', mode: 'on' } });
    expect(body.skipped).toBeUndefined();
    expect(body.pool).toMatchObject({ read: 4, eligible: 3, truncated: false, checked_for_jobs: 3, already_clipped: 0, dropped: { malformed: 0, small_pot: 1 } });
    expect(body.pick).toEqual({
      hand_id: 'hand-002',
      author_id: 'horse-b',
      slot: SLOT,
      publication_key: `fleet:horse-b:${SLOT}`,
      caption: 'Hand review: Pot Limit Omaha Five Card, big blind 2. Pot 600.0 BB, won from seat 7.',
      review_id: 2,
      pot_bb: 600,
    });
    expect(typeof body.job_id).toBe('string');
    expect(body.job_id).toBe(db.rows('hand_clip_jobs')[0]?.id);
    const inserts = db.writes('hand_clip_jobs');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.values).toEqual([{
      hand_id: 'hand-002',
      author_id: 'horse-b',
      kind: 'horse',
      style: CLIP_STYLE,
      auto_publish: true,
      publication_key: `fleet:horse-b:${SLOT}`,
      caption: 'Hand review: Pot Limit Omaha Five Card, big blind 2. Pot 600.0 BB, won from seat 7.',
    }]);
    // The slot is asked in the author's own timezone at the run's clock.
    expect(h.fleetSlotId).toHaveBeenCalledWith('horse-b', 'Europe/London', NOW);
    // The exclusion read names the shortlisted hands; the author read names the candidate horses.
    expect(reads('hand_clip_jobs')[0]?.filters).toEqual(['in:hand_id']);
    expect(reads('content_authors')[0]?.filters).toEqual(['in:profile_id', 'eq:is_active']);
    sample('enqueued.json', body);
  });

  it('breaks a pot tie by created_at, newest first', async () => {
    db.seed('horse_hand_reviews', [
      review(1, { created_at: hoursAgo(5), played_at: hoursAgo(5) }),
      review(2, { created_at: hoursAgo(2), played_at: hoursAgo(2) }),
      review(3, { created_at: hoursAgo(4), played_at: hoursAgo(4) }),
    ]);
    db.seed('content_authors', [author('horse-a')]);
    const body = await live();
    expect(body.pick?.hand_id).toBe('hand-002');
    expect(rankPool(db.rows('horse_hand_reviews')).ranked.map((c) => c.review.id)).toEqual([2, 3, 1]);
  });

  it('excludes a hand this horse already has a job for, and only this horse', async () => {
    seedPickFixture();
    const jobs = [
      { hand_id: 'hand-002', author_id: 'horse-b', kind: 'horse', style: CLIP_STYLE, state: 'ready' },
      { hand_id: 'hand-003', author_id: 'human-9', kind: 'user', style: CLIP_STYLE, state: 'queued' },
    ];
    db.seed('hand_clip_jobs', jobs);
    const body = await live();
    expect(body).toMatchObject({ enqueued: 1, candidates: 2, pool: { already_clipped: 1 } });
    expect(body.pick?.hand_id).toBe('hand-003');
    expect(body.pick?.author_id).toBe('horse-c');
    const inWindow = db.rows('horse_hand_reviews').filter((row) => String(row.played_at) >= hoursAgo(24) && row.is_win === true);
    expect(excludeClipped(rankPool(inWindow).ranked, jobs).candidates.map((c) => c.review.hand_id)).toEqual(['hand-003', 'hand-001']);
  });

  it('passes over a horse with no open slot and takes the next candidate', async () => {
    seedPickFixture();
    h.fleetSlotId.mockImplementation((profileId: string) => (profileId === 'horse-b' ? null : SLOT));
    const body = await live();
    expect(body).toMatchObject({ enqueued: 1, candidates: 3, passed_over: { no_slot: 1, not_on_roster: 0 } });
    expect(body.pick?.author_id).toBe('horse-c');
    expect(db.writes('hand_clip_jobs')[0]?.values[0]?.author_id).toBe('horse-c');
  });

  it('no horse with an open slot: skipped no_slot, candidates counted, nothing written', async () => {
    seedPickFixture();
    h.fleetSlotId.mockReturnValue(null);
    const body = await live();
    expect(body).toMatchObject({ ok: true, enqueued: 0, candidates: 3, skipped: 'no_slot', passed_over: { no_slot: 3 } });
    expect(body.pick).toBeUndefined();
    expect(db.writes('hand_clip_jobs')).toHaveLength(0);
  });

  it('passes over a horse that is not on the active roster', async () => {
    seedPickFixture();
    db.rows('content_authors').find((row) => row.profile_id === 'horse-b')!.is_active = false;
    const body = await live();
    expect(body).toMatchObject({ enqueued: 1, passed_over: { no_slot: 0, not_on_roster: 1 } });
    expect(body.pick?.author_id).toBe('horse-c');
  });

  it('no winning review in the window: skipped no_candidates, no job or author read', async () => {
    db.seed('horse_hand_reviews', [review(1, { played_at: hoursAgo(25), created_at: hoursAgo(25) }), review(2, { is_win: false })]);
    const body = await live();
    expect(body).toMatchObject({ ok: true, enqueued: 0, candidates: 0, skipped: 'no_candidates', pool: { read: 0 } });
    expect(reads('hand_clip_jobs')).toHaveLength(0);
    expect(reads('content_authors')).toHaveLength(0);
  });

  it('every shortlisted hand already clipped: skipped no_candidates after the exclusion read', async () => {
    seedPickFixture();
    db.seed('hand_clip_jobs', [
      { hand_id: 'hand-001', author_id: 'horse-a' },
      { hand_id: 'hand-002', author_id: 'horse-b' },
      { hand_id: 'hand-003', author_id: 'horse-c' },
    ]);
    const body = await live();
    expect(body).toMatchObject({ enqueued: 0, candidates: 0, skipped: 'no_candidates', pool: { already_clipped: 3 } });
    expect(reads('content_authors')).toHaveLength(0);
  });

  it('a bounded pool: the ranking sees the newest POOL_MAX_ROWS winners and says so', async () => {
    const rows: Row[] = [];
    for (let i = 1; i <= POOL_MAX_ROWS + 100; i += 1) {
      // Older rows carry bigger pots: the biggest pot in the window is outside the pool.
      rows.push(review(i, { pot_size: 100 + i, played_at: hoursAgo(i / 1000), created_at: hoursAgo(i / 1000) }));
    }
    db.seed('horse_hand_reviews', rows);
    db.seed('content_authors', [author('horse-a')]);
    const body = await live();
    expect(body.pool).toMatchObject({ read: POOL_MAX_ROWS, eligible: POOL_MAX_ROWS, truncated: true, checked_for_jobs: EXCLUSION_CHECK_ROWS });
    expect(body.candidates).toBe(CANDIDATE_LIMIT);
    expect(body.pick?.hand_id).toBe(`hand-${POOL_MAX_ROWS}`);
    expect(body.notes.some((note) => note.includes(`newest ${POOL_MAX_ROWS}`))).toBe(true);
    expect(reads('hand_clip_jobs')[0]?.inListSizes).toEqual([EXCLUSION_CHECK_ROWS]);
  });

  it('the review read is bounded on played_at over the last 24 hours and ordered newest first', async () => {
    seedPickFixture();
    await live();
    const read = reads('horse_hand_reviews')[0];
    expect(read?.filters).toEqual(['gte:played_at', 'eq:is_win']);
    expect(read?.ranged).toBe(true);
  });
});

describe('the caption', () => {
  it('is the fixed template over the row numbers and passes the output law', () => {
    const caption = buildCaption({ game_variant: 'nlh', big_blind: 5, pot_size: 1005, seat: 3 });
    expect(caption).toBe("Hand review: No Limit Hold'em, big blind 5. Pot 201.0 BB, won from seat 3.");
    expect(captionPassesLaw(caption)).toBe(true);
    expect(buildCaption({ game_variant: 'plo', big_blind: 0.02, pot_size: 1.5, seat: null })).toBe(
      'Hand review: Pot Limit Omaha, big blind 0.02. Pot 75.0 BB, won.',
    );
    expect(formatBlind(0.5)).toBe('0.5');
    expect(formatBlind(2.5)).toBe('2.5');
    expect(formatBlind(20000)).toBe('20000');
  });

  it('maps every known variant to a fixed label and anything else to "poker"', () => {
    for (const [variant, label] of Object.entries(VARIANT_LABELS)) {
      expect(variantLabel(variant)).toBe(label);
      expect(variantLabel(variant.toUpperCase())).toBe(label);
      const caption = buildCaption({ game_variant: variant, big_blind: 1, pot_size: 123.46, seat: 9 });
      expect(caption).toContain(`Hand review: ${label}, big blind 1. Pot 123.5 BB, won from seat 9.`);
      expect(captionPassesLaw(caption)).toBe(true);
    }
    expect(variantLabel('mixed_game_xyz')).toBe(UNKNOWN_VARIANT_LABEL);
    expect(variantLabel(null)).toBe(UNKNOWN_VARIANT_LABEL);
    expect(buildCaption({ game_variant: 'unknown', big_blind: 1, pot_size: 40, seat: 2 })).toBe('Hand review: poker, big blind 1. Pot 40.0 BB, won from seat 2.');
  });

  it('refuses emoji, dashes and anything outside the template (a name cannot fit)', () => {
    expect(captionPassesLaw('Hand review: No Limit Hold\'em, big blind 5. Pot 201.0 BB, won from seat 3. \u{1F525}')).toBe(false);
    expect(captionPassesLaw('Hand review: No Limit Hold\'em \u2014 big blind 5. Pot 201.0 BB, won from seat 3.')).toBe(false);
    expect(captionPassesLaw('Hand review: No Limit Hold\'em \u2013 big blind 5. Pot 201.0 BB, won from seat 3.')).toBe(false);
    expect(captionPassesLaw('Hand review: Dan won big, big blind 5. Pot 201.0 BB, won from seat 3.')).toBe(false);
    expect(captionPassesLaw('Hand review: No Limit Hold\'em, big blind 5. Pot 201.0 BB, won from seat 3 by Dan.')).toBe(false);
    expect(CAPTION_EMOJI.test('\u{1F3B0}')).toBe(true);
    expect(CAPTION_DASHES.test('\u2014')).toBe(true);
  });
});

describe('writes', () => {
  it('a unique violation on the insert is a duplicate, counted, not an error', async () => {
    seedPickFixture();
    db.fail((op) => op.table === 'hand_clip_jobs' && op.kind === 'insert', {
      message: 'duplicate key value violates unique constraint "hand_clip_jobs_hand_id_author_id_style_key"',
      code: '23505',
    });
    const captured = await run();
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ ok: true, enqueued: 0, candidates: 3, skipped: 'duplicate', duplicates: 1 });
    expect(db.writes('hand_clip_jobs')).toHaveLength(1);
    expect(db.rows('hand_clip_jobs')).toHaveLength(0);
  });

  it('any other insert failure is a 500 the log can see', async () => {
    seedPickFixture();
    db.fail((op) => op.table === 'hand_clip_jobs' && op.kind === 'insert', { message: 'relation "hand_clip_jobs" does not exist', code: '42P01' });
    const captured = await run();
    expect(captured.status).toBe(500);
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('hand_clip_jobs insert failed') });
  });

  it('an unreadable review table is a 500, never a quiet fire', async () => {
    seedPickFixture();
    db.fail((op) => op.table === 'horse_hand_reviews');
    const captured = await run();
    expect(captured.status).toBe(500);
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('horse_hand_reviews read failed') });
    expect(db.writes('hand_clip_jobs')).toHaveLength(0);
  });

  it('the deadline stops the run before the next read or write', async () => {
    seedPickFixture();
    const ticks = [0, 250_000];
    const body = await runPhase9({ now: NOW, dryRun: false, clock: () => ticks.shift() ?? 250_000, deadlineMs: 240_000 });
    expect(body).toMatchObject({ ok: true, skipped: 'deadline', enqueued: 0, candidates: 0, limits: { deadline_ms: 240_000 } });
    expect(reads('horse_hand_reviews')).toHaveLength(0);
    expect(db.writes('hand_clip_jobs')).toHaveLength(0);
  });
});

describe('dry run', () => {
  it('computes the pick and the caption and writes nothing, even while the mode is off', async () => {
    h.readPostModeStates.mockResolvedValue({ [HAND_CLIP_MODE]: false });
    seedPickFixture();
    const body = await dryRun();
    expect(body).toMatchObject({ ok: true, dry_run: true, enqueued: 0, candidates: 3, gates: { engine: 'on', mode: 'off' } });
    expect(body.skipped).toBeUndefined();
    expect(body.job_id).toBeUndefined();
    expect(body.pick).toMatchObject({
      hand_id: 'hand-002',
      author_id: 'horse-b',
      slot: SLOT,
      caption: 'Hand review: Pot Limit Omaha Five Card, big blind 2. Pot 600.0 BB, won from seat 7.',
    });
    expect(body.notes).toContain(DRY_RUN_WRITES_NOTE);
    expect(db.log.every((op) => op.kind === 'select')).toBe(true);
    expect(db.rows('hand_clip_jobs')).toHaveLength(0);
    // The write path's second switch read never happens either.
    expect(h.engineSwitch).toHaveBeenCalledTimes(1);
    sample('dry-run.json', body);
  });

  it('accepts the Phase 7 spelling and steers its clock and its window with at=', async () => {
    seedPickFixture();
    // A day earlier, the 1,000 BB hand played 30 hours before NOW is inside the window.
    const at = '2026-09-28T09:05:00.000Z';
    const body = (await run({ preview: '1', at })).body as Phase9Result;
    expect(body).toMatchObject({ dry_run: true, at, enqueued: 0, candidates: 4 });
    expect(body.pick?.hand_id).toBe('hand-005');
    expect(h.fleetSlotId).toHaveBeenCalledWith('horse-a', TZ, new Date(at));
    expect(db.writes('hand_clip_jobs')).toHaveLength(0);
  });

  it('rejects an unparseable at= and ignores at= on a live run', async () => {
    seedPickFixture();
    const bad = await run({ dry_run: '1', at: 'yesterday-ish' });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ ok: false, error: 'invalid_at' });
    const liveBody = (await run({ at: '2020-01-01T00:00:00Z' })).body as Phase9Result;
    expect(liveBody.at).toBe(NOW.toISOString());
    expect(liveBody.enqueued).toBe(1);
  });
});

describe('wiring and laws (static)', () => {
  const route = readFileSync(new URL('./phase9-content.ts', import.meta.url), 'utf8');
  const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const handVoice = readFileSync(new URL('../lib/content-engine/HandVoice.ts', import.meta.url), 'utf8');

  it('is registered for GET and POST behind the cron guards, right after the Phase 7 route', () => {
    expect(index).toContain("import { phase9Content } from './routes/phase9-content.js';");
    const ipGuard = index.indexOf("app.use('/cron/*', ipAllowlist);");
    const secretGuard = index.indexOf("app.use('/cron/*', requireCronSecret);");
    const logMiddleware = index.indexOf(".from('cron_execution_log')");
    const phase7Post = index.indexOf("app.post('/cron/phase7-content', phase7Content);");
    const getRoute = index.indexOf("app.get('/cron/phase9-content', phase9Content);");
    const postRoute = index.indexOf("app.post('/cron/phase9-content', phase9Content);");
    expect(ipGuard).toBeGreaterThan(-1);
    expect(secretGuard).toBeGreaterThan(ipGuard);
    expect(logMiddleware).toBeGreaterThan(secretGuard);
    expect(phase7Post).toBeGreaterThan(logMiddleware);
    expect(getRoute).toBeGreaterThan(phase7Post);
    expect(getRoute - phase7Post).toBeLessThan(400);
    expect(postRoute).toBeGreaterThan(getRoute);
    expect(index.match(/phase9-content/g)).toHaveLength(3);
  });

  it('takes the slot and the key from HorsePublisher and the gates from Fleet', () => {
    expect(route).toContain("import { fleetPublicationKey, fleetSlotId } from '../lib/content-engine/HorsePublisher.js';");
    expect(route).toContain("import { engineSwitch, readPostModeStates, type EngineSwitchState } from '../lib/content-engine/Fleet.js';");
    expect(route).toContain("import { pagedSelect } from '../lib/pagedSelect.js';");
  });

  it('writes one table, never a post, never a setting, and schedules nothing', () => {
    const inserts = route.match(/\.insert\(/g) ?? [];
    expect(inserts).toHaveLength(1);
    expect(route.indexOf(".from('hand_clip_jobs')\n    .insert(")).toBeGreaterThan(-1);
    expect(route).not.toMatch(/\.(?:update|upsert|delete|rpc)\(/);
    expect(route).not.toMatch(/from\('(?:social_posts|social_reels|content_settings|horse_post_modes|profiles)'\)/);
    expect(route).not.toMatch(/\bset(?:Timeout|Interval|Immediate)\b|\bretry\b|\bwhile \(true\)/i);
    // The dry run returns before the only insert.
    expect(route.indexOf('if (options.dryRun) {')).toBeLessThan(route.indexOf('.insert('));
    // The master switch is read again right before that insert.
    const writeBlock = route.slice(route.indexOf('if (options.dryRun) {'), route.indexOf('.insert('));
    expect(writeBlock).toContain("engineSwitch({ fresh: true })");
  });

  it('pins the Phase 6 output law regexes exactly as HandVoice.ts has them', () => {
    // Source text, not .source: the bundler rewrites the escapes in the compiled literal.
    for (const source of [handVoice, route]) {
      expect(source).toContain('= /\\p{Extended_Pictographic}/u;');
      expect(source).toContain('= /[\\u2013\\u2014]/;');
    }
    expect(CAPTION_EMOJI.flags).toBe('u');
    expect(CAPTION_DASHES.test('-')).toBe(false);
    expect(CAPTION_DASHES.test('\u2013')).toBe(true);
    expect(CAPTION_DASHES.test('\u2014')).toBe(true);
    expect(CAPTION_EMOJI.test("Hold'em")).toBe(false);
  });

  it('every visible word in the caption template and the variant labels is plain text', () => {
    const texts = [...Object.values(VARIANT_LABELS), UNKNOWN_VARIANT_LABEL, buildCaption({ game_variant: 'nlh', big_blind: 5, pot_size: 100, seat: 1 })];
    for (const text of texts) {
      expect(CAPTION_EMOJI.test(text)).toBe(false);
      expect(CAPTION_DASHES.test(text)).toBe(false);
    }
  });
});
