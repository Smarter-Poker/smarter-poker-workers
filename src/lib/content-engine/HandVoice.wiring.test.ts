/**
 * The Phase 3 replacement voices, CONNECTED (P3C-02, P3C-12).
 *
 * These tests go through publishForHorse, the function the fleet routes call,
 * with only the database stubbed. They prove that
 *  - with grounded_hand approved, the row that reaches social_posts is the
 *    line HandVoice.lineFor produced: no card notation, no "bb", no
 *    StyleSheet opener or closer, and the old composeHandPost is never run;
 *  - with grounded_session approved, the row is SessionVoice's line and the
 *    old composeSessionPost is never run;
 *  - each voice runs only when its own mode is approved: approving sessions
 *    does not read a hand, approving hands does not read a day;
 *  - with both modes off nothing is read and nothing is inserted;
 *  - writeGrounded called without the gate decision fails closed;
 *  - the frame is ledgered, and a frame the fleet just used is skipped;
 *  - a fleet insert never sets the social_posts.publication_key column,
 *    which is reserved for the video library.
 *
 * Nothing here enables a mode anywhere: horse_post_modes is a fake table.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  reads: [] as string[],
  writes: [] as Array<{ table: string; op: string; row: unknown }>,
}));

vi.mock('../supabase.js', () => {
  function builder(table: string): unknown {
    const filters: Array<(r: Row) => boolean> = [];
    let wrote = false;
    const rows = (): Row[] => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const b: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') {
          if (!wrote) db.reads.push(table);
          const res = { data: wrote ? null : rows(), error: null };
          return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(res).then(ok, bad);
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return async () => {
            if (wrote) return { data: { id: `${table}-row-1` }, error: null };
            db.reads.push(table);
            return { data: rows()[0] ?? null, error: null };
          };
        }
        if (prop === 'eq') return (k: string, v: unknown) => { filters.push((r) => !(k in r) || String(r[k]) === String(v)); return b; };
        if (prop === 'in') return (k: string, vs: unknown[]) => { const set = new Set(vs.map(String)); filters.push((r) => !(k in r) || set.has(String(r[k]))); return b; };
        if (prop === 'like') return (_k: string, pattern: string) => { const pre = pattern.replace(/%$/, ''); filters.push((r) => String(r.phrase_norm ?? '').startsWith(pre)); return b; };
        if (prop === 'insert' || prop === 'upsert' || prop === 'update' || prop === 'delete') {
          return (row: unknown) => { wrote = true; db.writes.push({ table, op: String(prop), row }); return b; };
        }
        return () => b;
      },
    });
    return b;
  }
  return {
    DEFAULT_REQUEST_TIMEOUT_MS: 20_000,
    getSupabase: () => ({ from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }) }),
  };
});

vi.mock('./HandVoice.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./HandVoice.js')>();
  return { ...real, lineFor: vi.fn(real.lineFor) };
});
vi.mock('./SessionVoice.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./SessionVoice.js')>();
  return { ...real, sessionLineFor: vi.fn(real.sessionLineFor) };
});
vi.mock('./GroundedComposer.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./GroundedComposer.js')>();
  return { ...real, composeHandPost: vi.fn(real.composeHandPost), composeSessionPost: vi.fn(real.composeSessionPost) };
});

import { publishForHorse, type FleetHorse } from './HorsePublisher.js';
import { writeGrounded, type AuthorHorse } from './VoiceWriter.js';
import { lineFor } from './HandVoice.js';
import { sessionLineFor } from './SessionVoice.js';
import { composeHandPost, composeSessionPost } from './GroundedComposer.js';
import { fleetHash } from './FleetScheduler.js';
import { _resetPostModes } from './Fleet.js';

const DAY = '2026-09-21';

/** A horse whose day opens with its own poker (HorsePublisher groundedFirst). */
function groundedFirstHorse(): FleetHorse {
  for (let i = 1; i < 1000; i++) {
    const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
    if (fleetHash(`${id}:${DAY}`, 'grounded') % 100 < 60) return { id: i, name: `fixture-${i}`, profile_id: id };
  }
  throw new Error('no grounded-first horse');
}
const HORSE = groundedFirstHorse();
// Every fleet publish names its scheduler slot (fleet publication key, #152);
// these tests are about which voice speaks, so the slot is fixed here.
const SLOT = '2026-09-21T12';

// A real settled hand (horse_hand_reviews 573264): pocket aces moved in
// preflop over an opponent's all-in, got called, won 143.57bb. The action
// log is the production one compacted to the fields derivePlay reads.
const LOG = 'P:ante:1:H:::1;P:ante:1:o1:::1;P:ante:1:o2:::1;P:ante:1:o3:::1;P:sb:1:o4:::;P:ante:1:o4:::1;P:bb:2:o5:::;P:ante:1:o5:::1;P:raise:5:H:2:261.65:;P:call:5:o1:5:212.1:;P:fold:0:o2:5:189.55:;P:raise:19:o3:5:740.79:;P:call:18:o4:19:222.1:;P:fold:0:o5:19:168.95:;P:raise:58:H:19:256.65:;P:fold:0:o1:58:207.1:;P:all_in:740.79:o3:58:721.79:;P:fold:0:o4:740.79:204.1:;P:all_in:261.65:H:740.79:203.65:;P:return:479.14:o3:::';
const STAGE: Record<string, string> = { P: 'preflop', F: 'flop', T: 'turn', R: 'river', X: 'other' };
function actions(compact: string, horse: string): unknown[] {
  return compact.split(';').map((tok) => {
    const [st, action, amount, who, currentBet, stackBefore, dead] = tok.split(':');
    const e: Row = { stage: STAGE[st!] ?? 'other', action };
    if (amount) e.amount = Number(amount);
    if (who === 'H') e.userId = horse;
    else if (who === 'S') e.userId = 'system';
    else if (who) e.userId = `opp-${who}`;
    if (dead === '1') e.dead = true;
    if (currentBet || stackBefore) {
      e.seat = 1;
      e.publicNode = { currentBet: currentBet ? Number(currentBet) : undefined, seats: stackBefore ? [[1, Number(stackBefore)]] : [] };
    }
    return e;
  });
}
const HAND: Row = {
  id: 573264,
  horse_user_id: HORSE.profile_id,
  played_at: `${DAY}T10:00:00Z`,
  game_variant: 'nlh',
  format: 'cash',
  big_blind: 2,
  hole_cards: [{ rank: 'A', suit: 'diamonds' }, { rank: 'A', suit: 'clubs' }],
  board: [
    { rank: 'T', suit: 'clubs' }, { rank: '3', suit: 'hearts' }, { rank: 'J', suit: 'clubs' },
    { rank: '4', suit: 'diamonds' }, { rank: 'T', suit: 'diamonds' },
  ],
  net_bb: 143.57,
  pot_size: 555.3,
  is_win: true,
  leak_tags: ['preflop_stackoff_won'],
  actions: actions(LOG, HORSE.profile_id),
};

// A real day (horse_daily_nets): 433 hands of pineapple cash, +665.24bb.
const SESSION: Row = { horse_user_id: HORSE.profile_id, day: '2026-09-20', game_variant: 'pineapple', format: 'cash', hands: 433, net_bb: '665.24' };

function modes(hand: boolean, session: boolean): Row[] {
  return [
    { mode: 'grounded_hand', enabled: hand },
    { mode: 'grounded_session', enabled: session },
  ];
}

const NOTATION = /[AKQJT2-9][hdcs]\b|\b\d+(?:\.\d+)?bb\b|\b(?:[AKQJT][AKQJT2-9]|[2-9][AKQJT])[so]\b/;
const FILLER = /^(look|nah|okay|well|honestly|what gets me|the thing is|on another watch|for me|the interesting part|rough one)\b/i;

function groundedInserts() {
  return db.writes.filter(
    (w) => w.table === 'social_posts' && w.op === 'insert' && (w.row as { metadata?: Row }).metadata?.grounded === true,
  );
}

describe('the publisher speaks grounded posts through HandVoice and SessionVoice', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${DAY}T12:00:00Z`));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network is not part of this test'); }));
    db.tables = { horse_hand_reviews: [HAND], horse_daily_nets: [SESSION] };
    db.reads = [];
    db.writes = [];
    _resetPostModes();
    vi.mocked(lineFor).mockClear();
    vi.mocked(sessionLineFor).mockClear();
    vi.mocked(composeHandPost).mockClear();
    vi.mocked(composeSessionPost).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('grounded_hand approved: the social_posts row carries the HandVoice line, unrendered', async () => {
    db.tables.horse_post_modes = modes(true, false);
    const res = await publishForHorse(HORSE, { skipGuard: true, slot: SLOT });

    expect(res.success).toBe(true);
    expect(res.type).toBe('grounded_hand');
    expect(lineFor).toHaveBeenCalledTimes(1);
    expect(composeHandPost).not.toHaveBeenCalled();
    expect(composeSessionPost).not.toHaveBeenCalled();
    expect(sessionLineFor).not.toHaveBeenCalled();
    expect(db.reads).not.toContain('horse_daily_nets');
    const [facts, seed] = vi.mocked(lineFor).mock.calls[0]!;
    expect(String(facts.handId)).toBe('573264');
    expect(facts.category).toBe('stackoff');
    expect(facts.play).toMatchObject({ showdown: true, stackInStreet: 'preflop', allInStreet: 'preflop', decisiveStreet: 'preflop', runouts: 1 });
    expect(seed).toBe(`${HORSE.profile_id}:h:573264`);
    const spoken = vi.mocked(lineFor).mock.results[0]!.value as { text: string; key: string };

    const inserts = groundedInserts();
    expect(inserts).toHaveLength(1);
    const post = inserts[0]!.row as { author_id: string; content: string; metadata: Row; publication_key?: unknown };
    expect(post.author_id).toBe(HORSE.profile_id);
    expect(post.content).toBe(spoken.text);
    expect(post.content).not.toMatch(NOTATION);
    expect(post.content).not.toMatch(FILLER);
    expect(post.content).not.toMatch(/\d/);
    expect(post.content).not.toContain('—');
    expect(post.content).not.toContain('–');
    expect(post.content).not.toMatch(/\bon the flop\b|\bon the turn\b|\briver\b/i);
    expect(post.metadata).toMatchObject({ grounded: true, grounded_type: 'hand' });
    // Phase 8: the writer states the topic it knows; the database derives the rest.
    expect(inserts[0]!.row).toMatchObject({ topic: 'poker', topics: ['poker', 'hand'] });
    expect(post.metadata.grounding).toEqual(['hand:573264', 'category:stackoff', spoken.key]);
    expect('publication_key' in post).toBe(false);

    expect(spoken.key).toMatch(/^frame:voice:stackoff:\d+$/);
    const ledgered = db.writes
      .filter((w) => w.table === 'horse_phrase_ledger')
      .map((w) => (w.row as { phrase_norm: string }).phrase_norm);
    expect(ledgered).toContain(spoken.key);
  });

  it('a frame the fleet used in this category inside the window is skipped', async () => {
    db.tables.horse_post_modes = modes(true, false);
    await publishForHorse(HORSE, { skipGuard: true, slot: SLOT });
    const firstKey = (vi.mocked(lineFor).mock.results[0]!.value as { key: string }).key;

    db.writes = [];
    _resetPostModes();
    db.tables.horse_phrase_ledger = [{ phrase_norm: firstKey, used_at: `${DAY}T11:00:00Z` }];
    const res = await publishForHorse(HORSE, { skipGuard: true, slot: SLOT });

    expect(res.success).toBe(true);
    const post = groundedInserts()[0]!.row as { metadata: { grounding: string[] } };
    const secondKey = post.metadata.grounding[2]!;
    expect(secondKey).toMatch(/^frame:voice:stackoff:\d+$/);
    expect(secondKey).not.toBe(firstKey);
  });

  it('grounded_session approved: the social_posts row carries the SessionVoice line, and no hand is read', async () => {
    db.tables.horse_post_modes = modes(false, true);
    const res = await publishForHorse(HORSE, { skipGuard: true, slot: SLOT });

    expect(res.success).toBe(true);
    expect(res.type).toBe('grounded_session');
    expect(lineFor).not.toHaveBeenCalled();
    expect(db.reads).not.toContain('horse_hand_reviews');
    expect(db.reads).toContain('horse_daily_nets');
    expect(sessionLineFor).toHaveBeenCalledTimes(1);
    expect(composeHandPost).not.toHaveBeenCalled();
    expect(composeSessionPost).not.toHaveBeenCalled();
    const [session, seed] = vi.mocked(sessionLineFor).mock.calls[0]!;
    expect(session).toMatchObject({ day: '2026-09-20', variant: 'pineapple', format: 'cash', netBb: 665.2 });
    expect(seed).toBe(`${HORSE.profile_id}:s:2026-09-20:pineapple:cash`);
    const spoken = vi.mocked(sessionLineFor).mock.results[0]!.value as { text: string; key: string };

    const inserts = groundedInserts();
    expect(inserts).toHaveLength(1);
    const post = inserts[0]!.row as { author_id: string; content: string; metadata: Row; publication_key?: unknown };
    expect(post.author_id).toBe(HORSE.profile_id);
    expect(post.content).toBe(spoken.text);
    expect(post.content).not.toMatch(/\d|\bbb\b|\bhands\b/i);
    expect(post.content).not.toMatch(NOTATION);
    expect(post.content).not.toMatch(FILLER);
    expect(post.content).not.toContain('—');
    expect(post.content).not.toContain('–');
    expect(post.metadata).toMatchObject({ grounded: true, grounded_type: 'session' });
    expect(inserts[0]!.row).toMatchObject({ topic: 'poker', topics: ['poker', 'session'] });
    expect(post.metadata.grounding).toEqual(['session:2026-09-20', 'variant:pineapple', 'format:cash', spoken.key]);
    expect(spoken.key).toMatch(/^frame:sessionvoice:up:\d+$/);
    expect('publication_key' in post).toBe(false);

    const ledgered = db.writes
      .filter((w) => w.table === 'horse_phrase_ledger')
      .map((w) => (w.row as { phrase_norm: string }).phrase_norm);
    expect(ledgered).toContain(spoken.key);
  });

  it('grounded_hand not approved: HandVoice is never reached and no hand is read', async () => {
    db.tables.horse_post_modes = modes(false, false);
    const res = await publishForHorse(HORSE, { skipGuard: true, slot: SLOT });

    expect(lineFor).not.toHaveBeenCalled();
    expect(sessionLineFor).not.toHaveBeenCalled();
    expect(composeHandPost).not.toHaveBeenCalled();
    expect(composeSessionPost).not.toHaveBeenCalled();
    expect(db.reads).not.toContain('horse_hand_reviews');
    expect(db.reads).not.toContain('horse_daily_nets');
    expect(groundedInserts()).toEqual([]);
    expect(res.type ?? '').not.toMatch(/^grounded/);
    expect(res.success ? '' : String(res.error)).toMatch(res.success ? /^$/ : /grounded: grounded posts await approval/);
  });

  it('approving sessions does not approve hands, and approving hands does not approve sessions', async () => {
    db.tables.horse_post_modes = modes(false, true);
    await publishForHorse(HORSE, { skipGuard: true, slot: SLOT });
    expect(lineFor).not.toHaveBeenCalled();
    expect(db.reads).not.toContain('horse_hand_reviews');

    db.reads = [];
    db.writes = [];
    _resetPostModes();
    vi.mocked(sessionLineFor).mockClear();
    db.tables.horse_post_modes = modes(true, false);
    await publishForHorse(HORSE, { skipGuard: true, slot: SLOT });
    expect(sessionLineFor).not.toHaveBeenCalled();
    expect(db.reads).not.toContain('horse_daily_nets');
  });

  it('with hands approved but no hand worth telling, the session voice still needs its own approval', async () => {
    db.tables = { horse_hand_reviews: [], horse_daily_nets: [SESSION], horse_post_modes: modes(true, false) };
    const res = await publishForHorse(HORSE, { skipGuard: true, slot: SLOT });
    expect(sessionLineFor).not.toHaveBeenCalled();
    expect(db.reads).not.toContain('horse_daily_nets');
    expect(groundedInserts()).toEqual([]);
    expect(res.type ?? '').not.toMatch(/^grounded/);
  });

  it('writeGrounded without the gate decision fails closed', async () => {
    const out = await writeGrounded({ profile_id: HORSE.profile_id, name: 'x' } as unknown as AuthorHorse);
    expect(out).toBeNull();
    expect(lineFor).not.toHaveBeenCalled();
    expect(sessionLineFor).not.toHaveBeenCalled();
    expect(db.reads).not.toContain('horse_hand_reviews');
    expect(db.reads).not.toContain('horse_daily_nets');
  });

  it('writeGrounded takes only an explicit true as approval', async () => {
    const horse = { profile_id: HORSE.profile_id, name: 'x' } as unknown as AuthorHorse;
    expect(await writeGrounded(horse, { hand: 1 as unknown as boolean, session: 'yes' as unknown as boolean })).toBeNull();
    expect(lineFor).not.toHaveBeenCalled();
    expect(sessionLineFor).not.toHaveBeenCalled();
    expect(db.reads).toEqual([]);
  });

  it('a hand whose action log cannot be read is silence, not a guess', async () => {
    db.tables.horse_hand_reviews = [{ ...HAND, actions: null }];
    const out = await writeGrounded({ profile_id: HORSE.profile_id, name: 'x' } as unknown as AuthorHorse, { hand: true, session: false });
    expect(out).toBeNull();
    expect(lineFor).not.toHaveBeenCalled();
    expect(composeHandPost).not.toHaveBeenCalled();
  });
});
