/**
 * Phase 7 story modes (contract C6): four modes drafted from rows through the
 * fake client, and the voice law over every pool and every draft.
 *
 * The pins: a draft says only what its rows say (every number in the text is
 * in grounding.numbers), names nobody (a person's id and username sit in the
 * fixture rows and never reach a draft), reads only the horse's own rows plus
 * tournament rows, carries the contract's publication key, fails closed when
 * a read fails, and is the same draft on a retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb, type Operation } from './testing/fakeSupabase.js';
import {
  DAY,
  FLEET,
  HORSE_A,
  HORSE_B,
  HORSE_C,
  HOUR_BUCKET,
  HUMAN2_ID,
  HUMAN_ID,
  HUMAN_NAME,
  NOW,
  T1,
  T1_SYSTEM_NAME,
  T2,
  T3,
  T4,
  T5,
  seedProfiles,
  seedThrowbackRows,
  seedTournamentRows,
} from './testing/phase7StoryFixtures.js';
import {
  STORY_MODES,
  STORY_POOLS,
  THREAD_OPENERS,
  THROWBACK_MIN_DAYS,
  agePhrase,
  draftStories,
  numbersInText,
  storyCardsLine,
  systemTournamentName,
  type StoryDeps,
  type StoryDraft,
  type StoryMode,
} from './Phase7Stories.js';

const EMOJI = /\p{Extended_Pictographic}/u;
const DASHES = /[–—]/;
/** Every string a person could be identified by in the fixtures. */
const PEOPLE = [HUMAN_ID, HUMAN2_ID, HUMAN_NAME, 'quiet_person', 'horse_one', 'horse_two', 'horse_three', "Dan's"];

let db: FakeDb;

function deps(overrides: Partial<StoryDeps> = {}): StoryDeps {
  return { supa: db.client as unknown as StoryDeps['supa'], now: NOW, fleet: FLEET, ...overrides };
}

function seedAll(optIn = true): void {
  seedTournamentRows(db);
  seedThrowbackRows(db);
  seedProfiles(db, optIn);
}

async function allDrafts(optIn = true): Promise<StoryDraft[]> {
  db = new FakeDb();
  seedAll(optIn);
  const out: StoryDraft[] = [];
  for (const mode of STORY_MODES) out.push(...(await draftStories(mode, deps(), 5)).drafts);
  return out;
}

/** The law every horse-visible text keeps, and the grounding of its numbers. */
function expectLawful(d: StoryDraft): void {
  const label = `${d.mode} ${d.publication_key}`;
  expect(d.text, label).not.toMatch(EMOJI);
  expect(d.text, label).not.toMatch(DASHES);
  expect(d.text, label).not.toContain('@');
  expect(d.text.trim().length, label).toBeGreaterThan(20);
  const everything = JSON.stringify(d);
  for (const p of PEOPLE) expect(everything, `${label} carries ${p}`).not.toContain(p);
  const allowed = new Set((d.grounding.numbers as string[]) ?? []);
  for (const n of numbersInText(d.text)) expect(allowed.has(n), `${label}: number ${n} is not in the row`).toBe(true);
}

function reads(table: string): Operation[] {
  return db.log.filter((o) => o.table === table && o.kind === 'select');
}

beforeEach(() => {
  db = new FakeDb();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the pools keep the voice law', () => {
  it('no pool line carries an emoji, a dash, an @, a number or a name', () => {
    for (const [name, pool] of Object.entries(STORY_POOLS)) {
      expect(pool.length, name).toBeGreaterThan(0);
      expect(new Set(pool).size, `${name} repeats a line`).toBe(pool.length);
      for (const line of pool) {
        const label = `${name}: ${line}`;
        expect(line, label).not.toMatch(EMOJI);
        expect(line, label).not.toMatch(DASHES);
        expect(line, label).not.toContain('@');
        expect(line, label).not.toMatch(/\d/);
        // A capitalised word inside a sentence is a name. "I" is not.
        for (const sentence of line.split(/[.?!]\s+/)) {
          const words = sentence.replace(/[{}]/g, '').split(/\s+/).slice(1);
          for (const w of words) expect(w, `${label}: "${w}" reads as a name`).not.toMatch(/^[A-Z][a-z]+$/);
        }
      }
    }
  });

  it('holds at least 30 thread openers, each a question a horse can honestly ask', () => {
    expect(THREAD_OPENERS.length).toBeGreaterThanOrEqual(30);
    for (const o of THREAD_OPENERS) {
      expect(o.trim().endsWith('?'), o).toBe(true);
      expect(o, o).not.toMatch(/\bI (won|lost|played|had|got|saw)\b/);
    }
  });
});

describe('live_tournament_story', () => {
  it('drafts a horse still playing a running MTT or satellite, from its own seat row', async () => {
    seedAll();
    const r = await draftStories('live_tournament_story', deps(), 5);
    expect(r.drafts.map((d) => d.publication_key).sort()).toEqual(
      [`p7:live:${T1}:${HORSE_A}:6`, `p7:live:${T2}:${HORSE_B}:h${HOUR_BUCKET}`].sort(),
    );
    for (const d of r.drafts) {
      expectLawful(d);
      expect(d.mode).toBe('live_tournament_story');
      expect(d.topic).toBe('tournament');
    }
    const a = r.drafts.find((d) => d.horse.profile_id === HORSE_A)!;
    expect(a.horse.name).toBe('Horse One');
    expect(a.text).toContain(`the ${T1_SYSTEM_NAME}`);
    expect(a.text).not.toContain('PM CT');
    expect(a.text).toContain('10,908');
    expect(a.text).toMatch(/3 (players still in|left in the field|of us still playing)/);
    expect(a.text).toContain('Level 6 with blinds at 300/600.');
    expect(a.text).toContain('Starting stack was 10,000.');
    expect(a.grounding).toMatchObject({
      tournament_id: T1,
      tournament_player_id: 'tp-0001',
      chips: 10908,
      players_remaining: 3,
      current_level: 6,
      small_blind: 300,
      big_blind: 600,
      starting_chips: 10000,
      tournament_named: true,
      bucket: '6',
    });
    // The other seats' chips are not the horse's to tell.
    expect(a.text).not.toContain('5,000');
    expect(a.text).not.toContain('7,777');

    const b = r.drafts.find((d) => d.horse.profile_id === HORSE_B)!;
    expect(b.text).toContain('a satellite');
    expect(b.text).not.toContain('Level');
    expect(b.text).not.toContain('Starting stack');
    expect(b.grounding).toMatchObject({ tournament_id: T2, tournament_named: false, tournament_name: null, bucket: `h${HOUR_BUCKET}` });
  });

  it('skips completed tournaments, SNGs, eliminated seats and tournaments without a horse', async () => {
    seedAll();
    const r = await draftStories('live_tournament_story', deps(), 10);
    const keys = r.drafts.map((d) => d.publication_key).join('\n');
    expect(keys).not.toContain(T3);
    expect(keys).not.toContain(T4);
    expect(keys).not.toContain(T5);
    expect(r.drafts.some((d) => d.horse.profile_id === HORSE_C)).toBe(false);
    expect(r.skipped).toEqual({ no_horse_in_tournament: 1 });
    expect(r.considered).toBe(2);
    // The read is by running status and type; seats are read per tournament and status only.
    for (const op of reads('tournaments')) expect(op.filters).toEqual(expect.arrayContaining(['eq:status', 'in:tournament_type']));
    for (const op of reads('tournament_players')) expect(op.filters).toEqual(expect.arrayContaining(['eq:tournament_id', 'eq:status']));
  });

  it('honours the limit and fails closed when the tournament or seat reads fail', async () => {
    seedAll();
    expect((await draftStories('live_tournament_story', deps(), 1)).drafts).toHaveLength(1);

    db = new FakeDb();
    seedAll();
    db.fail((op) => op.table === 'tournaments');
    const t = await draftStories('live_tournament_story', deps(), 5);
    expect(t.drafts).toEqual([]);
    expect(t.skipped).toEqual({ tournaments_read_failed: 1 });

    db = new FakeDb();
    seedAll();
    db.fail((op) => op.table === 'tournament_players');
    const s = await draftStories('live_tournament_story', deps(), 5);
    expect(s.drafts).toEqual([]);
    expect(s.skipped.players_count_unreadable).toBe(3);
  });

  it('takes one seat per tournament per pass, so a small limit is never filled from one field', async () => {
    seedAll();
    // A third horse in T1: without interleaving, a limit of 2 could be two updates from T1.
    db.seed('tournament_players', [
      { id: 'tp-0009', tournament_id: T1, user_id: HORSE_C, username: 'horse_three', status: 'playing', chips: 4200, chip_count: 0 },
    ]);
    const two = await draftStories('live_tournament_story', deps(), 2);
    expect(two.drafts).toHaveLength(2);
    expect(new Set(two.drafts.map((d) => d.grounding.tournament_id)).size).toBe(2);
    const three = await draftStories('live_tournament_story', deps(), 3);
    expect(three.drafts.map((d) => d.grounding.tournament_id).sort()).toEqual([T1, T1, T2].sort());
    for (const d of three.drafts) expect(d.grounding.players_remaining).toBe(d.grounding.tournament_id === T1 ? 4 : 2);
  });

  it('calls a satellite a satellite when the schedule name only names its target event', async () => {
    seedAll();
    const T6 = 't6000000-0000-4000-8000-000000000006';
    db.seed('tournaments', [
      { id: T6, name: 'DSS Wednesday $22 NLH Deepstack \u2022 2 PM CT Satellite', tournament_type: 'SATELLITE', status: 'RUNNING', current_level: 3, blind_level_state: { big_blind: 150, small_blind: 75 }, starting_chips: 10000, started_at: '2026-09-29T18:20:00.000Z' },
    ]);
    db.seed('tournament_players', [
      { id: 'tp-0010', tournament_id: T6, user_id: HORSE_C, username: 'horse_three', status: 'playing', chips: 8064, chip_count: 0 },
      { id: 'tp-0011', tournament_id: T6, user_id: HUMAN_ID, username: HUMAN_NAME, status: 'playing', chips: 9000, chip_count: 0 },
    ]);
    const r = await draftStories('live_tournament_story', deps(), 10);
    const c = r.drafts.find((d) => d.grounding.tournament_id === T6)!;
    expectLawful(c);
    expect(c.text).toContain('the DSS Wednesday $22 NLH Deepstack satellite');
    expect(c.text).not.toContain('PM CT');
    expect(c.grounding.tournament_name).toBe('DSS Wednesday $22 NLH Deepstack');
  });

  it('says nothing about a running tournament when the fleet is empty', async () => {
    seedAll();
    const r = await draftStories('live_tournament_story', deps({ fleet: [] }), 5);
    expect(r.drafts).toEqual([]);
    expect(r.skipped).toEqual({ fleet_empty: 1 });
    expect(reads('tournaments')).toHaveLength(0);
  });
});

describe('rail_human', () => {
  it('drafts nothing and counts no_opted_in_humans when nobody opted in', async () => {
    seedAll(false);
    const r = await draftStories('rail_human', deps(), 5);
    expect(r.drafts).toEqual([]);
    expect(r.skipped).toEqual({ no_opted_in_humans: 1 });
    expect(r.considered).toBe(0);
    for (const op of reads('profiles')) expect(op.filters).toContain('eq:settings->>rail_opt_in');
    expect(reads('tournaments')).toHaveLength(0);
  });

  it('rails only an opted-in person seated with a horse, naming nobody', async () => {
    seedAll(true);
    const r = await draftStories('rail_human', deps(), 5);
    expect(r.drafts.map((d) => d.publication_key).sort()).toEqual(
      [`p7:rail:${T1}:${HORSE_A}:${HOUR_BUCKET}`, `p7:rail:${T2}:${HORSE_B}:${HOUR_BUCKET}`].sort(),
    );
    expect(r.considered).toBe(1);
    expect(r.skipped).toEqual({ no_horse_in_tournament: 1 });
    const a = r.drafts.find((d) => d.horse.profile_id === HORSE_A)!;
    expectLawful(a);
    expect(a.topic).toBe('tournament');
    expect(a.text).toContain('5,000');
    expect(a.text).toContain('10,908');
    expect(a.text).not.toContain('7,777');
    expect(a.grounding).toMatchObject({ railed_chips: 5000, chips: 10908, opt_in_source: 'profiles.settings.rail_opt_in' });
    expect(Object.values(a.grounding).map(String).join(' ')).not.toContain(HUMAN_ID);
    // The horse's own settings row says opted in too, and it is still never railed.
    expect(r.drafts.every((d) => d.text.includes('someone') || d.text.includes('a player'))).toBe(true);
  });

  it('fails closed when the opt-in read fails', async () => {
    seedAll(true);
    db.fail((op) => op.table === 'profiles');
    const r = await draftStories('rail_human', deps(), 5);
    expect(r.drafts).toEqual([]);
    expect(r.skipped).toEqual({ profiles_read_failed: 1 });
  });
});

describe('throwback_hand', () => {
  it('retells the horse\'s own hand from at least three weeks ago, cards as Phase 5 tokens', async () => {
    seedAll();
    const r = await draftStories('throwback_hand', deps(), 5);
    expect(r.drafts.map((d) => d.publication_key).sort()).toEqual(
      [`p7:throwback:${HORSE_A}:hand-0101`, `p7:throwback:${HORSE_B}:hand-0104`].sort(),
    );
    expect(r.skipped).toEqual({ no_old_hand: 1 });
    expect(r.considered).toBe(3);
    for (const d of r.drafts) {
      expectLawful(d);
      expect(d.topic).toBe('poker');
    }

    const a = r.drafts.find((d) => d.horse.profile_id === HORSE_A)!;
    // 30 days old: "about a month ago"; the 80bb hand from five days ago is not a throwback.
    expect(a.text).toContain('about a month ago');
    expect(a.text).toContain('It was 1/2 no limit holdem.');
    // A raise-shove in the log, told as "got it all in": true for a shove and for a call.
    expect(a.text).toContain('Got it all in on the turn. Won 62 big blinds.');
    expect(a.text.endsWith(
      '\nHand [[sp-card:Kc]][[sp-card:7d]] | Board [[sp-card:2c]][[sp-card:7c]][[sp-card:Ac]][[sp-card:Qc]][[sp-card:2d]]',
    )).toBe(true);
    expect(a.grounding).toMatchObject({
      review_id: 101, hand_id: 'hand-0101', net_bb: 62, is_win: true, days_ago: 30, stake: '1/2', board_cards_shown: 5,
      play: { all_in_street: 'turn', stack_in_street: 'turn', showdown: true, fold_street: null },
    });

    const b = r.drafts.find((d) => d.horse.profile_id === HORSE_B)!;
    // 22 days old, a fold on the turn: only the four cards it saw, a fractional loss spoken as "about".
    expect(b.text).toContain('a few weeks ago');
    expect(b.text).toContain('It was a no limit holdem tournament.');
    expect(b.text).toContain('I folded on the turn. Cost me about 41 big blinds.');
    expect(b.text).toContain('Board [[sp-card:2c]][[sp-card:7c]][[sp-card:Ac]][[sp-card:Qc]]');
    expect(b.text).not.toContain('[[sp-card:2d]]');
    expect(b.grounding).toMatchObject({ review_id: 104, net_bb: -40.5, is_win: false, days_ago: 22, board_cards_shown: 4, stake: null });
  });

  it('reads only the horse\'s own rows and never lets an opponent\'s id out of the action log', async () => {
    seedAll();
    const r = await draftStories('throwback_hand', deps(), 5);
    const ops = reads('horse_hand_reviews');
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      const own = op.filters.includes('eq:horse_user_id') || op.filters.includes('in:id');
      expect(own, op.filters.join(',')).toBe(true);
    }
    const everything = JSON.stringify(r.drafts);
    expect(everything).not.toContain(HUMAN_ID);
    expect(everything).not.toContain('actions');
  });

  it('tells one hand per horse per day and skips a horse that already posted one today', async () => {
    seedAll();
    db.seed('social_posts', [
      { id: 'post-1', author_id: HORSE_A, content: 'x', metadata: { phase7_mode: 'throwback_hand', publication_key: `p7:throwback:${HORSE_A}:hand-0199` }, created_at: '2026-09-29T09:00:00.000Z' },
      // Yesterday's post does not count.
      { id: 'post-2', author_id: HORSE_B, content: 'x', metadata: { phase7_mode: 'throwback_hand', publication_key: `p7:throwback:${HORSE_B}:hand-0198` }, created_at: '2026-09-28T23:59:00.000Z' },
      // Another mode's post today does not count either.
      { id: 'post-3', author_id: HORSE_B, content: 'x', metadata: { phase7_mode: 'human_thread', publication_key: `p7:thread:${HORSE_B}:${DAY}` }, created_at: '2026-09-29T10:00:00.000Z' },
    ]);
    const r = await draftStories('throwback_hand', deps(), 5);
    expect(r.drafts.map((d) => d.horse.profile_id)).toEqual([HORSE_B]);
    expect(r.skipped).toEqual({ already_posted_today: 1, no_old_hand: 1 });
  });

  it('fails closed when the ledger or the hand read fails', async () => {
    seedAll();
    db.fail((op) => op.table === 'social_posts');
    const l = await draftStories('throwback_hand', deps(), 5);
    expect(l.drafts).toEqual([]);
    expect(l.skipped).toEqual({ ledger_unreadable: 1 });

    db = new FakeDb();
    seedAll();
    db.fail((op) => op.table === 'horse_hand_reviews');
    const h = await draftStories('throwback_hand', deps(), 5);
    expect(h.drafts).toEqual([]);
    expect(h.skipped).toEqual({ hand_read_failed: 3 });
  });

  it('reads a log without table snapshots (every hand before 2026-09-12) and claims only what it shows', async () => {
    // No publicNode anywhere: the shape of every throwback-age log in production.
    const bare = (entries: Array<[string, string, string, number]>) =>
      entries.map(([stage, action, userId, amount]) => ({ seat: userId === HORSE_C ? 3 : 4, stage, action, amount, userId, timestamp: 't' }));
    const allIn = {
      id: 107, hand_id: 'hand-0107', horse_user_id: HORSE_C, played_at: '2026-09-02T20:00:00.000Z',
      game_variant: 'nlh', format: 'tournament', big_blind: 100, net_bb: -60.25, is_win: false, pot_size: 12050,
      hole_cards: [{ rank: 'J', suit: 'spades' }, { rank: 'J', suit: 'hearts' }],
      board: [{ rank: '2', suit: 'clubs' }, { rank: '7', suit: 'clubs' }, { rank: 'A', suit: 'clubs' }, { rank: 'Q', suit: 'clubs' }, { rank: '2', suit: 'diamonds' }],
      actions: bare([
        ['preflop', 'sb', HUMAN_ID, 50], ['preflop', 'bb', HORSE_C, 100], ['preflop', 'raise', HUMAN_ID, 300], ['preflop', 'all_in', HORSE_C, 6025],
        ['preflop', 'call', HUMAN_ID, 5725],
      ]),
    };
    const aggressive = {
      id: 106, hand_id: 'hand-0106', horse_user_id: HORSE_C, played_at: '2026-09-01T20:00:00.000Z',
      game_variant: 'nlh', format: 'cash', big_blind: 1, net_bb: 33.5, is_win: true, pot_size: 70,
      hole_cards: [{ rank: 'A', suit: 'spades' }, { rank: 'K', suit: 'hearts' }],
      board: [{ rank: '2', suit: 'clubs' }, { rank: '7', suit: 'clubs' }, { rank: 'A', suit: 'clubs' }, { rank: 'Q', suit: 'clubs' }],
      actions: bare([
        ['preflop', 'sb', HUMAN_ID, 0.5], ['preflop', 'bb', HORSE_C, 1], ['preflop', 'raise', HUMAN_ID, 3], ['preflop', 'call', HORSE_C, 2],
        ['flop', 'bet', HORSE_C, 4], ['flop', 'call', HUMAN_ID, 4], ['turn', 'bet', HORSE_C, 12], ['turn', 'fold', HUMAN_ID, 0],
      ]),
    };

    seedAll();
    db.seed('horse_hand_reviews', [allIn]);
    const one = (await draftStories('throwback_hand', deps(), 5)).drafts.find((d) => d.horse.profile_id === HORSE_C)!;
    expectLawful(one);
    // An all-in the log cannot classify: no shove and no call is claimed.
    expect(one.publication_key).toBe(`p7:throwback:${HORSE_C}:hand-0107`);
    expect(one.text).toContain('It was a no limit holdem tournament. Got it all in preflop. Lost about 60 big blinds.');
    expect(one.text).not.toMatch(/shove|Shoved|called an all in/i);
    expect(one.grounding).toMatchObject({ play: { all_in_street: 'preflop', showdown: true, fold_street: null }, board_cards_shown: 5 });

    db = new FakeDb();
    seedAll();
    db.seed('horse_hand_reviews', [aggressive]);
    const two = (await draftStories('throwback_hand', deps(), 5)).drafts.find((d) => d.horse.profile_id === HORSE_C)!;
    expectLawful(two);
    // Bet or raise, the log does not say which; won without a showdown, as the row says.
    expect(two.text).toContain('Got aggressive on the flop and the turn and took it down. Won about 34 big blinds.');
    expect(two.text).toContain('a few weeks ago'); // 27 days
    expect(two.text.endsWith('| Board [[sp-card:2c]][[sp-card:7c]][[sp-card:Ac]][[sp-card:Qc]]')).toBe(true);
  });

  it('never tells a hand younger than the minimum age, whatever its size', async () => {
    seedAll();
    // A horse whose only big hand is 20 days old.
    db.seed('horse_hand_reviews', [
      {
        id: 105, hand_id: 'hand-0105', horse_user_id: HORSE_C, played_at: '2026-09-09T20:00:00.000Z',
        game_variant: 'nlh', format: 'cash', big_blind: 2, net_bb: 300, is_win: true, pot_size: 700,
        hole_cards: [{ rank: 'A', suit: 'spades' }, { rank: 'A', suit: 'hearts' }],
        board: [{ rank: '2', suit: 'clubs' }, { rank: '7', suit: 'clubs' }, { rank: 'A', suit: 'clubs' }],
        actions: [],
      },
    ]);
    const r = await draftStories('throwback_hand', deps(), 5);
    expect(r.drafts.some((d) => d.horse.profile_id === HORSE_C)).toBe(false);
    expect(THROWBACK_MIN_DAYS).toBe(21);
  });
});

describe('human_thread', () => {
  it('opens one question per horse per day from the pool, keyed by horse and day', async () => {
    seedAll();
    const r = await draftStories('human_thread', deps(), 5);
    expect(r.drafts).toHaveLength(3);
    expect(r.considered).toBe(3);
    expect(r.skipped).toEqual({});
    for (const d of r.drafts) {
      expectLawful(d);
      expect(d.publication_key).toBe(`p7:thread:${d.horse.profile_id}:${DAY}`);
      expect(THREAD_OPENERS).toContain(d.text);
      expect(d.topic).toBe('poker');
      expect(d.grounding).toMatchObject({ day: DAY, pool_size: THREAD_OPENERS.length, numbers: [] });
      expect(THREAD_OPENERS[d.grounding.opener_index as number]).toBe(d.text);
    }
    expect(new Set(r.drafts.map((d) => d.horse.profile_id)).size).toBe(3);
  });

  it('honours the limit, skips a horse that already asked today and fails closed on the ledger', async () => {
    seedAll();
    expect((await draftStories('human_thread', deps(), 2)).drafts).toHaveLength(2);

    db.seed('social_posts', [
      { id: 'post-9', author_id: HORSE_A, content: 'x', metadata: { phase7_mode: 'human_thread', publication_key: `p7:thread:${HORSE_A}:${DAY}` }, created_at: '2026-09-29T01:00:00.000Z' },
    ]);
    const r = await draftStories('human_thread', deps(), 5);
    expect(r.drafts.map((d) => d.horse.profile_id).sort()).toEqual([HORSE_B, HORSE_C].sort());
    expect(r.skipped).toEqual({ already_posted_today: 1 });

    db.fail((op) => op.table === 'social_posts');
    const f = await draftStories('human_thread', deps(), 5);
    expect(f.drafts).toEqual([]);
    expect(f.skipped).toEqual({ ledger_unreadable: 1 });
  });
});

describe('every mode', () => {
  it('is deterministic: the same rows on the same day draft the same text under the same key', async () => {
    const first = await allDrafts();
    const second = await allDrafts();
    expect(first.length).toBeGreaterThanOrEqual(8);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(new Set(first.map((d) => d.publication_key)).size).toBe(first.length);
  });

  it('keeps the voice law and the grounding of every number in every draft', async () => {
    for (const d of await allDrafts()) expectLawful(d);
  });

  it('drafts nothing for a zero limit or an unknown mode', async () => {
    seedAll();
    expect(await draftStories('human_thread', deps(), 0)).toEqual({ drafts: [], skipped: { limit_zero: 1 }, considered: 0 });
    expect(await draftStories('not_a_mode' as StoryMode, deps(), 5)).toEqual({ drafts: [], skipped: { unknown_mode: 1 }, considered: 0 });
    expect(db.log).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('keeps a system tournament name and refuses anything that could be a person', () => {
    const system = [
      ['Tuesday Bounty Hunt', 'Tuesday Bounty Hunt'],
      ['Prime Time Free Buy (NLH)', 'Prime Time Free Buy NLH'],
      ['DSS Wednesday $22 NLH Deepstack • 2 PM CT Satellite', 'DSS Wednesday $22 NLH Deepstack'],
      ['Mid-Morning Turbo (6-Max NLH)', 'Mid-Morning Turbo 6-Max NLH'],
      ['Sunday Funday Main Event Satellite Heads-Up', 'Sunday Funday Main Event Satellite Heads-Up'],
      ['Pre-Dawn Mystery Bounty (PLO5)', 'Pre-Dawn Mystery Bounty PLO5'],
      ['Coffee Break Freeroll (PLO4)', 'Coffee Break Freeroll PLO4'],
      ['Union Grand Championship (NLH)', 'Union Grand Championship NLH'],
      ['Night Owl Special (NLH)', 'Night Owl Special NLH'],
      ['Friday Fight Night PKO', 'Friday Fight Night PKO'],
      ['Sunday Deep Stack Satellite $10', 'Sunday Deep Stack Satellite $10'],
      ['PLO8 Hi-Lo Nightcap', 'PLO8 Hi-Lo Nightcap'],
    ];
    for (const [raw, kept] of system) expect(systemTournamentName(raw), raw).toBe(kept);
    for (const raw of ["Dan's Tuesday Game", 'Mike Smith Invitational', 'Johnny B Good Freeroll', '@club night', 'Priya Home Game', 'xx', '', null, 42]) {
      expect(systemTournamentName(raw), String(raw)).toBeNull();
    }
  });

  it('speaks age honestly: nothing under 21 days, a month only from 28', () => {
    expect(agePhrase(20)).toBeNull();
    expect(agePhrase(21)).toBe('a few weeks ago');
    expect(agePhrase(27)).toBe('a few weeks ago');
    expect(agePhrase(28)).toBe('about a month ago');
    expect(agePhrase(55)).toBe('about a month ago');
    expect(agePhrase(56)).toBe('a couple of months ago');
    expect(agePhrase(Number.NaN)).toBeNull();
  });

  it('writes the World Hub card line and refuses a card it cannot draw', () => {
    expect(storyCardsLine([{ rank: 'K', suit: 'clubs' }, { rank: '7', suit: 'diamonds' }], [{ rank: 'T', suit: 'h' }, { rank: '2', suit: 'spades' }, { rank: 'A', suit: 's' }]))
      .toBe('Hand [[sp-card:Kc]][[sp-card:7d]] | Board [[sp-card:Th]][[sp-card:2s]][[sp-card:As]]');
    expect(storyCardsLine([{ rank: '10', suit: 'clubs' }, { rank: '7', suit: 'diamonds' }], [{ rank: '2', suit: 'clubs' }])).toBeNull();
    expect(storyCardsLine([{ rank: 'K', suit: 'clubs' }], [])).toBeNull();
    expect(numbersInText('Hand [[sp-card:Kc]][[sp-card:7d]] won 62 big blinds at 1/2, stack 10,908')).toEqual(['62', '1', '2', '10908']);
  });
});
