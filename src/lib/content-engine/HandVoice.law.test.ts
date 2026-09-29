/**
 * Laws for the grounded-hand voice.
 *
 * These tests do not approve the voice. They enforce the factual and writing
 * boundaries around the samples that a person still has to approve.
 *
 * Two kinds of fixture. The synthetic `facts()` cases cover every category
 * with a made-up but consistent action record. The REAL rows further down are
 * production hands (horse_hand_reviews, 2026-09-14..21, md5-verified by the
 * p3-handvoice-c investigator) with their action logs compacted to the fields
 * `derivePlay` reads. They are the rows on which the first HandVoice was
 * caught claiming things the hand did not contain (2026-09-21 recertification,
 * findings P3C-03..P3C-10), and each of those claims is a law here.
 *
 * Everything runs through the real pickHandStory against a SELECT-only fake
 * client. Any write throws: nothing here can reach a database.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { HandFacts, HandCategory, HandPlay, Street } from './HandStory.js';
import { categorise, derivePlay, pickHandStory, storySkips } from './HandStory.js';
import {
  lineFor,
  sayBoard,
  sayHolding,
  sayMoney,
  sayStreet,
  spokenLineMatches,
} from './HandVoice.js';

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  reads: [] as string[],
  writes: [] as string[],
  failReads: new Set<string>(),
}));

vi.mock('../supabase.js', () => {
  function builder(table: string): unknown {
    const filters: Array<(r: Row) => boolean> = [];
    const rows = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const result = () =>
      db.failReads.has(table) ? { data: null, error: { message: `${table} unavailable` } } : { data: rows(), error: null };
    const b: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') {
          db.reads.push(table);
          const res = result();
          return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(res).then(ok, bad);
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return () => {
            db.reads.push(table);
            const res = result();
            return Promise.resolve({ data: Array.isArray(res.data) ? res.data[0] ?? null : null, error: res.error });
          };
        }
        if (prop === 'eq') return (k: string, v: unknown) => { filters.push((r) => !(k in r) || String(r[k]) === String(v)); return b; };
        if (prop === 'in') return (k: string, vs: unknown[]) => { const set = new Set(vs.map(String)); filters.push((r) => !(k in r) || set.has(String(r[k]))); return b; };
        if (prop === 'like') return (k: string, p: string) => { const pre = p.replace(/%$/, ''); filters.push((r) => String(r[k] ?? '').startsWith(pre)); return b; };
        if (prop === 'insert' || prop === 'update' || prop === 'upsert' || prop === 'delete') {
          return () => { db.writes.push(`${table}.${String(prop)}`); throw new Error(`zero-write test: ${String(prop)} on ${table}`); };
        }
        return () => b;
      },
    });
    return b;
  }
  return {
    DEFAULT_REQUEST_TIMEOUT_MS: 20_000,
    getSupabase: () => ({ from: (t: string) => builder(t), rpc: () => { db.writes.push('rpc'); throw new Error('zero-write test: rpc'); } }),
  };
});

/* ------------------------------------------------------------------------ */
/* Synthetic fixtures                                                        */
/* ------------------------------------------------------------------------ */

const PLAY: HandPlay = {
  showdown: true,
  stackInStreet: null,
  allInStreet: null,
  foldStreet: null,
  aggressionStreets: [],
  riverAggression: false,
  runouts: 1,
  decisiveStreet: 'river',
};

/** An action record that agrees with the category it is asked for. */
function playFor(category: HandCategory): HandPlay {
  switch (category) {
    case 'river_aggression': return { ...PLAY, aggressionStreets: ['turn', 'river'], riverAggression: true };
    case 'big_fold': return { ...PLAY, showdown: false, foldStreet: 'turn', decisiveStreet: 'turn' };
    case 'stackoff': return { ...PLAY, stackInStreet: 'turn', allInStreet: 'turn', decisiveStreet: 'turn' };
    default: return { ...PLAY };
  }
}

function facts(
  category: HandCategory,
  overrides: Partial<Omit<HandFacts, 'play'>> & { play?: Partial<HandPlay> } = {},
): HandFacts {
  const win = category === 'big_win' || category === 'river_aggression';
  const { play, ...rest } = overrides;
  return {
    handId: 'hand-1',
    playedAt: '2026-09-06T12:00:00Z',
    variant: 'nlh',
    format: 'cash',
    bigBlind: 2,
    hole: [
      { rank: 'A', suit: 'spades' },
      { rank: 'A', suit: 'hearts' },
    ],
    board: [
      { rank: 'K', suit: 'clubs' },
      { rank: '9', suit: 'clubs' },
      { rank: '6', suit: 'diamonds' },
      { rank: '4', suit: 'hearts' },
      { rank: '2', suit: 'spades' },
    ],
    netBb: win ? 140 : -140,
    potBb: 220,
    isWin: win,
    leaks: [],
    category,
    holeNotation: 'AA',
    boardNotation: 'Kc 9c 6d 4h 2s',
    street: 'river',
    play: { ...playFor(category), ...play },
    ...rest,
  };
}

function rendered(f: HandFacts): Array<{ text: string; key: string }> {
  const lines = new Map<string, { text: string; key: string }>();
  for (let i = 0; i < 500; i += 1) {
    const line = lineFor(f, `seed-${i}`);
    if (line) lines.set(line.key, line);
  }
  return [...lines.values()];
}

/* ------------------------------------------------------------------------ */
/* Real rows                                                                 */
/* ------------------------------------------------------------------------ */

interface RealRow {
  id: number;
  playedAt: string;
  variant: string;
  format: string;
  bb: number;
  net: number;
  pot: number;
  win: boolean;
  tags: string[];
  hole: string;
  board: string;
  /** The investigator's independent SQL derivation of the same facts. */
  sql: { liveEnd: number; fold: string; allIn: string; rit: boolean };
  /**
   * The action log, compacted to what derivePlay reads:
   * stage:action:amount:who:currentBet:stackBefore:dead per entry, where
   * who is H (the horse), S (the table) or oN (an anonymous opponent).
   */
  log: string;
}

const ROWS: RealRow[] = [
  { id: 618768, playedAt: '2026-09-20T23:10:54Z', variant: 'nlh', format: 'cash', bb: 1, net: 83.25, pot: 171.5, win: true, tags: [], hole: 'Th Ts', board: '7c 8d 8s 9s',
    sql: { liveEnd: 1, fold: '-', allIn: 'turn', rit: false },
    log: 'P:sb:0.5:o1:::;P:bb:1:o2:::;P:raise:2:o3:1:329.3:;P:fold:0:o4:2:140.83:;P:raise:5:H:2:123.18:;P:fold:0:o5:5:90.6:;P:fold:0:o1:5:74.67:;P:call:4:o2:5:51.74:;P:call:3:o3:5:327.3:;F:check:0:o2:0:47.74:;F:check:0:o3:0:324.3:;F:bet:6:H:0:118.18:;F:fold:0:o2:6:47.74:;F:call:6:o3:6:324.3:;T:check:0:o3:0:318.3:;T:bet:20:H:0:112.18:;T:raise:72:o3:20:318.3:;T:all_in:112.18:H:72:92.18:;T:fold:0:o3:112.18:246.3:;T:return:40.18:H:::' },
  { id: 534016, playedAt: '2026-09-17T17:19:04Z', variant: 'nlh', format: 'cash', bb: 2, net: 64.75, pot: 231, win: true, tags: [], hole: '8s 8h', board: '4c Ah 9d 9c',
    sql: { liveEnd: 1, fold: '-', allIn: 'turn', rit: false },
    log: 'P:bomb_ante:6:o1:::1;P:bomb_ante:6:o2:::1;P:bomb_ante:6:o3:::1;P:bomb_ante:6:o4:::1;P:bomb_ante:6:H:::1;F:bet:21:o3:0:269.36:;F:fold:0:o4:21:214:;F:call:21:H:21:183.55:;F:fold:0:o1:21:335.65:;F:call:21:o2:21:374.03:;T:bet:69:o3:0:248.36:;T:all_in:162.55:H:69:162.55:;T:fold:0:o2:162.55:353.03:;T:fold:0:o3:162.55:179.36:;T:return:93.55:H:::' },
  { id: 558804, playedAt: '2026-09-18T05:51:34Z', variant: 'plo5', format: 'tournament', bb: 30, net: 30.3, pot: 1803, win: true, tags: ['nonnut_flush_stackoff_won'], hole: '8c 4h 6s 7c 2h', board: '8h 6h 4s 5h 3c',
    sql: { liveEnd: 2, fold: '-', allIn: 'flop', rit: false },
    log: 'P:sb:15:o1:::;P:bb:30:o2:::;P:raise:103:H:30:894:;P:fold:0:o1:103:1098:;P:call:73:o2:103:963:;F:check:0:o2:0:890:;F:bet:136:H:0:791:;F:raise:474:o2:136:890:;F:all_in:791:H:474:655:;F:call:317:o2:791:416:' },
  { id: 559728, playedAt: '2026-09-18T06:18:49Z', variant: 'nlh', format: 'cash', bb: 2, net: -98.86, pot: 397.44, win: false, tags: ['preflop_stackoff'], hole: 'Qs Ah', board: '3c Jc 5h 3s 4h',
    sql: { liveEnd: 2, fold: '-', allIn: 'preflop', rit: false },
    log: 'P:sb:1:o1:::;P:bb:2:H:::;P:ante:2:H:::1;P:fold:0:o2:2:232.99:;P:fold:0:o3:2:178.72:;P:raise:4:o4:2:569.65:;P:fold:0:o5:4:126.15:;P:raise:16:o1:4:194.72:;P:raise:42:H:16:450.19:;P:fold:0:o4:42:565.65:;P:all_in:195.72:o1:42:179.72:;P:all_in:452.19:H:195.72:410.19:;P:return:256.47:H:::' },
  { id: 596484, playedAt: '2026-09-19T09:32:00Z', variant: 'nlh', format: 'cash', bb: 0.5, net: -40.38, pot: 41.51, win: false, tags: ['coldcall_stackoff'], hole: 'Kc As', board: '8d 6s Tc 5s 5c',
    sql: { liveEnd: 2, fold: '-', allIn: '-', rit: false },
    log: 'P:sb:0.25:o1:::;P:bb:0.5:H:::;P:fold:0:o2:0.5:39.38:;P:fold:0:o3:0.5:99.69:;P:fold:0:o4:0.5:127.79:;P:raise:1.13:o5:0.5:26.98:;P:raise:4.47:o1:1.13:71.05:;P:call:3.97:H:4.47:100.33:;P:fold:0:o5:4.47:25.85:;F:bet:2.96:o1:0:66.83:;F:raise:15.72:H:2.96:96.36:;F:call:12.76:o1:15.72:63.87:;T:check:0:o1:0:51.11:;T:check:0:H:0:80.64:;R:check:0:o1:0:51.11:;R:check:0:H:0:80.64:' },
  { id: 551888, playedAt: '2026-09-18T02:28:25Z', variant: 'plo4', format: 'cash', bb: 0.5, net: 92.9, pot: 98.5, win: true, tags: [], hole: '9d 8s As Ac', board: '7s 2s 6c 3c 5d',
    sql: { liveEnd: 2, fold: '-', allIn: 'flop', rit: false },
    log: 'P:sb:0.25:H:::;P:ante:0.25:H:::1;P:bb:0.5:o1:::;P:ante:0.25:o1:::1;P:ante:0.25:o2:::1;P:ante:0.25:o3:::1;P:raise:2.75:o2:0.5:175.96:;P:fold:0:o3:2.75:48:;P:raise:9.75:H:2.75:48.25:;P:fold:0:o1:9.75:133.97:;P:call:7:o2:9.75:173.21:;F:bet:17.85:H:0:38.75:;F:raise:71.26:o2:17.85:166.21:;F:all_in:38.75:H:71.26:20.9:;F:return:32.51:o2:::' },
  { id: 527781, playedAt: '2026-09-17T14:03:10Z', variant: 'plo4', format: 'hu_cash', bb: 0.5, net: -217.62, pot: 217.62, win: false, tags: ['big_bet_fold', 'big_fold_early', 'preflop_stackoff'], hole: '7c Qc Qs Ks', board: 'As 7h 9h 5d',
    sql: { liveEnd: 1, fold: 'turn', allIn: '-', rit: false },
    log: 'P:bb:0.5:H:::;P:sb:0.25:o1:::;P:raise:1.5:o1:0.5:145.84:;P:raise:4.16:H:1.5:192.06:;P:raise:12.09:o1:4.16:144.59:;P:raise:36.27:H:12.09:188.4:;P:raise:108.81:o1:36.27:134:;P:call:72.54:H:108.81:156.29:;F:check:0:H:0:83.75:;F:check:0:o1:0:37.28:;T:check:0:H:0:83.75:;T:all_in:37.28:o1:0:37.28:;T:fold:0:H:37.28:83.75:;T:return:37.28:o1:::' },
  { id: 598861, playedAt: '2026-09-19T13:38:50Z', variant: 'nlh', format: 'cash', bb: 1, net: 123.95, pot: 258.4, win: true, tags: [], hole: '2h 2d', board: 'Ad Ks 8s 2c 5h',
    sql: { liveEnd: 2, fold: '-', allIn: '-', rit: true },
    log: 'P:sb:0.5:H:::;P:bb:1:o1:::;P:fold:0:o2:1:186.1:;P:fold:0:o3:1:329.12:;P:fold:0:o4:1:110.74:;P:fold:0:o5:1:69.83:;P:raise:2:H:1:174.87:;P:call:1:o1:2:128.2:;F:bet:2:H:0:173.37:;F:call:2:o1:2:127.2:;T:bet:10:H:0:171.37:;T:raise:30:o1:10:125.2:;T:raise:101:H:30:161.37:;T:all_in:125.2:o1:101:95.2:;T:call:24.2:H:125.2:70.37:;R:rit_board_2::S:::' },
  { id: 554908, playedAt: '2026-09-18T03:46:09Z', variant: 'plo4', format: 'cash', bb: 0.5, net: 42.6, pot: 82.33, win: true, tags: [], hole: 'Kc Kd Qh 6c', board: '8h 2d 2c Ac 9c',
    sql: { liveEnd: 2, fold: '-', allIn: 'turn', rit: true },
    log: 'P:sb:0.25:o1:::;P:bb:0.5:o2:::;P:fold:0:o3:0.5:53.33:;P:fold:0:o4:0.5:91.5:;P:fold:0:o5:0.5:50.92:;P:raise:1.61:H:0.5:37.97:;P:call:1.36:o1:1.61:70.53:;P:raise:6.39:o2:1.61:45.39:;P:call:4.78:H:6.39:36.36:;P:call:4.78:o1:6.39:69.17:;F:check:0:o1:0:64.39:;F:bet:6.89:o2:0:39.5:;F:call:6.89:H:6.89:31.58:;F:fold:0:o1:6.89:64.39:;T:bet:11.87:o2:0:32.61:;T:all_in:24.69:H:11.87:24.69:;T:call:12.82:o2:24.69:20.74:;R:rit_board_2::S:::' },
  { id: 568124, playedAt: '2026-09-18T12:38:08Z', variant: 'nlh', format: 'cash', bb: 2, net: -57, pot: 244, win: false, tags: [], hole: 'Kc 6h', board: '9d 6c 2h 2d Qd',
    sql: { liveEnd: 2, fold: '-', allIn: '-', rit: false },
    log: 'P:bomb_ante:4:o1:::1;P:bomb_ante:4:o2:::1;P:bomb_ante:4:o3:::1;P:bomb_ante:4:o4:::1;P:bomb_ante:4:o5:::1;P:bomb_ante:4:H:::1;F:check:0:o4:0:224.2:;F:check:0:o5:0:823.94:;F:check:0:H:0:347.9:;F:check:0:o1:0:202:;F:bet:6:o2:0:328:;F:fold:0:o3:6:167:;F:fold:0:o4:6:224.2:;F:fold:0:o5:6:823.94:;F:call:6:H:6:347.9:;F:fold:0:o1:6:202:;T:check:0:H:0:341.9:;T:bet:29:o2:0:322:;T:call:29:H:29:341.9:;R:check:0:H:0:312.9:;R:bet:75:o2:0:293:;R:call:75:H:75:312.9:' },
  { id: 615272, playedAt: '2026-09-20T17:17:58Z', variant: 'plo5', format: 'hu_cash', bb: 1, net: -25, pot: 50, win: false, tags: ['nonnut_flush_stackoff', 'river_aggr_lost'], hole: 'Ts 3c 3s 8h 6c', board: '2c 2d 4c Tc As',
    sql: { liveEnd: 2, fold: '-', allIn: '-', rit: false },
    log: 'P:bb:1:o1:::;P:sb:0.5:H:::;P:raise:3:H:1:133.9:;P:call:2:o1:3:108.7:;F:check:0:o1:0:106.7:;F:bet:2:H:0:131.4:;F:call:2:o1:2:106.7:;T:check:0:o1:0:104.7:;T:bet:5:H:0:129.4:;T:call:5:o1:5:104.7:;R:check:0:o1:0:99.7:;R:bet:15:H:0:124.4:;R:call:15:o1:15:99.7:' },
  { id: 544656, playedAt: '2026-09-17T22:38:35Z', variant: 'nlh', format: 'tournament', bb: 50, net: -75.3, pot: 7597, win: false, tags: ['river_aggr_lost', 'river_raise_paidoff'], hole: '6h 5h', board: '6d 7s 9c 2h 5s',
    sql: { liveEnd: 2, fold: '-', allIn: '-', rit: false },
    log: 'P:ante:6:o1:::1;P:ante:6:o2:::1;P:sb:25:o3:::;P:ante:6:o3:::1;P:bb:50:o4:::;P:ante:6:o4:::1;P:ante:6:o5:::1;P:ante:6:o6:::1;P:ante:6:o7:::1;P:ante:6:H:::1;P:ante:6:o8:::1;P:fold:0:o5:50:3988:;P:fold:0:o6:50:3988:;P:fold:0:o7:50:3988:;P:raise:100:H:50:4142:;P:fold:0:o8:100:3988:;P:fold:0:o1:100:3988:;P:fold:0:o2:100:3963:;P:fold:0:o3:100:4117:;P:call:50:o4:100:3709:;F:check:0:o4:0:3659:;F:check:0:H:0:4042:;T:bet:351:o4:0:3659:;T:call:351:H:351:4042:;R:bet:940:o4:0:3308:;R:raise:2746:H:940:3691:;R:all_in:3308:o4:2746:2368:;R:call:562:H:3308:945:' },
  { id: 616020, playedAt: '2026-09-20T18:42:57Z', variant: 'nlh', format: 'hu_cash', bb: 2, net: -65.5, pot: 262, win: false, tags: ['river_aggr_lost'], hole: 'Kd Qh', board: 'Ks 4s 6h 6d Jh',
    sql: { liveEnd: 2, fold: '-', allIn: '-', rit: false },
    log: 'P:sb:1:H:::;P:bb:2:o1:::;P:raise:4:H:2:314.3:;P:call:2:o1:4:661.39:;F:check:0:o1:0:659.39:;F:check:0:H:0:311.3:;T:bet:12:o1:0:659.39:;T:raise:41:H:12:311.3:;T:call:29:o1:41:647.39:;R:check:0:o1:0:618.39:;R:bet:86:H:0:270.3:;R:call:86:o1:86:618.39:' },
  { id: 494384, playedAt: '2026-09-14T22:39:34Z', variant: 'nlh', format: 'tournament', bb: 60, net: -126.53, pot: 15404, win: false, tags: ['top_pair_weak_kicker_stackoff'], hole: 'Ah 3h', board: 'Td Ac 4s 7s 7c',
    sql: { liveEnd: 2, fold: '-', allIn: '-', rit: false },
    log: 'P:sb:30:o1:::;P:bb:60:o2:::;P:ante:64:o2:::1;P:fold:0:o3:60:22000:;P:raise:126:o4:60:20946:;P:fold:0:o5:126:20921:;P:fold:0:o6:126:21925:;P:fold:0:o7:126:23482:;P:call:126:H:126:21142:;P:fold:0:o1:126:25161:;P:call:66:o2:126:20269:;F:check:0:o2:0:20203:;F:bet:230:o4:0:20820:;F:call:230:H:230:21016:;F:fold:0:o2:230:20203:;T:check:0:o4:0:20590:;T:bet:424:H:0:20786:;T:raise:1733:o4:424:20590:;T:call:1309:H:1733:20362:;R:bet:5503:o4:0:18857:;R:call:5503:H:5503:19053:' },
  { id: 553892, playedAt: '2026-09-18T03:30:10Z', variant: 'pineapple', format: 'cash', bb: 1, net: -100, pot: 200.5, win: false, tags: ['limped_pot_bloat', 'weak_kicker_trips_stackoff'], hole: 'Qd Js', board: 'Jc 6s Jd Kc 8s',
    sql: { liveEnd: 2, fold: '-', allIn: 'turn', rit: true },
    log: 'P:sb:0.5:o1:::;P:bb:1:H:::;P:raise:2:o2:1:198.66:;P:fold:0:o3:2:100:;P:fold:0:o1:2:366.7:;P:call:1:H:2:99:;X:discard:0:H:::;X:discard:0:o2:::;F:check:0:H:0:98:;F:bet:5:o2:0:196.66:;F:raise:20:H:5:98:;F:call:15:o2:20:191.66:;T:bet:32:H:0:78:;T:raise:118:o2:32:176.66:;T:all_in:78:H:118:46:;T:return:40:o2:::;R:rit_board_2::S:::;R:rit_board_3::S:::' },
  { id: 622216, playedAt: '2026-09-21T06:36:05Z', variant: 'nlh', format: 'cash', bb: 0.1, net: 70.6, pot: 17.09, win: true, tags: [], hole: 'Tc Ad', board: '7d 8d Jd Ac 6c',
    sql: { liveEnd: 2, fold: '-', allIn: '-', rit: false },
    log: 'P:sb:0.05:o1:::;P:bb:0.1:o2:::;P:raise:0.3:o3:0.1:12.94:;P:fold:0:o4:0.3:10.55:;P:fold:0:o5:0.3:11.97:;P:call:0.3:H:0.3:18.6:;P:fold:0:o1:0.3:13.42:;P:fold:0:o2:0.3:20.05:;F:check:0:o3:0:12.64:;F:bet:0.45:H:0:18.3:;F:raise:1.92:o3:0.45:12.64:;F:call:1.47:H:1.92:17.85:;T:bet:3.3:o3:0:10.72:;T:call:3.3:H:3.3:16.38:;R:bet:2.95:o3:0:7.42:;R:call:2.95:H:2.95:13.08:' },
  { id: 517992, playedAt: '2026-09-17T05:28:03Z', variant: 'nlh', format: 'tournament', bb: 60, net: -90.97, pot: 11165, win: false, tags: ['river_aggr_lost', 'underfull_stackoff'], hole: 'Tc Th', board: 'Ah 9h Ac 3h Td',
    sql: { liveEnd: 2, fold: '-', allIn: 'river', rit: false },
    log: 'P:sb:30:o1:::;P:bb:60:o2:::;P:ante:72:o2:::1;P:fold:0:o3:60:5563:;P:fold:0:o4:60:4599:;P:fold:0:o5:60:4792:;P:fold:0:o6:60:5292:;P:raise:147:o7:60:4886:;P:raise:454:H:147:5458:;P:fold:0:o8:454:4326:;P:fold:0:o1:454:4248:;P:call:394:o2:454:5674:;P:fold:0:o7:454:4739:;F:check:0:o2:0:5280:;F:bet:395:H:0:5004:;F:raise:2228:o2:395:5280:;F:call:1833:H:2228:4609:;T:check:0:o2:0:3052:;T:check:0:H:0:2776:;R:check:0:o2:0:3052:;R:all_in:2776:H:0:2776:;R:all_in:3052:o2:2776:3052:;X:return:276:o2:::' },
  { id: 573264, playedAt: '2026-09-18T15:30:08Z', variant: 'nlh', format: 'cash', bb: 2, net: 143.57, pot: 555.3, win: true, tags: ['preflop_stackoff_won'], hole: 'Ad Ac', board: 'Tc 3h Jc 4d Td',
    sql: { liveEnd: 2, fold: '-', allIn: 'preflop', rit: false },
    log: 'P:ante:1:H:::1;P:ante:1:o1:::1;P:ante:1:o2:::1;P:ante:1:o3:::1;P:sb:1:o4:::;P:ante:1:o4:::1;P:bb:2:o5:::;P:ante:1:o5:::1;P:raise:5:H:2:261.65:;P:call:5:o1:5:212.1:;P:fold:0:o2:5:189.55:;P:raise:19:o3:5:740.79:;P:call:18:o4:19:222.1:;P:fold:0:o5:19:168.95:;P:raise:58:H:19:256.65:;P:fold:0:o1:58:207.1:;P:all_in:740.79:o3:58:721.79:;P:fold:0:o4:740.79:204.1:;P:all_in:261.65:H:740.79:203.65:;P:return:479.14:o3:::' },
  { id: 600644, playedAt: '2026-09-19T15:48:32Z', variant: 'nlh', format: 'cash', bb: 2, net: -32.5, pot: 135, win: false, tags: ['big_bet_fold', 'big_fold_early', 'bet_fold_line'], hole: 'As Qh', board: '',
    sql: { liveEnd: 1, fold: 'preflop', allIn: '-', rit: false },
    log: 'P:sb:1:o1:::;P:bb:2:o2:::;P:raise:5:H:2:414.39:;P:fold:0:o3:5:673.5:;P:fold:0:o4:5:346.65:;P:fold:0:o5:5:176.25:;P:call:4:o1:5:303.53:;P:raise:29:o2:5:232.15:;P:raise:65:H:29:409.39:;P:fold:0:o1:65:299.53:;P:all_in:234.15:o2:65:205.15:;P:fold:0:H:234.15:349.39:;P:return:169.15:o2:::' },
  { id: 548052, playedAt: '2026-09-18T01:08:15Z', variant: 'nlh', format: 'cash', bb: 5, net: -54, pot: 556, win: false, tags: ['big_bet_fold', 'big_fold_river'], hole: 'Qh Ah', board: '2s 8s 7c 3h Tc',
    sql: { liveEnd: 1, fold: 'river', allIn: '-', rit: false },
    log: 'P:sb:2:o1:::;P:ante:2:o1:::1;P:bb:5:o2:::;P:ante:2:o2:::1;P:ante:2:H:::1;P:ante:2:o3:::1;P:raise:10:H:5:874.1:;P:call:10:o3:10:492:;P:fold:0:o1:10:695.98:;P:raise:59:o2:10:1002.7:;P:raise:136:H:59:864.1:;P:fold:0:o3:136:482:;P:call:77:o2:136:948.7:;F:check:0:o2:0:871.7:;F:check:0:H:0:738.1:;T:bet:132:o2:0:871.7:;T:call:132:H:132:738.1:;R:bet:470:o2:0:739.7:;R:fold:0:H:470:606.1:;R:return:470:o2:::' },
  { id: 592120, playedAt: '2026-09-19T05:06:30Z', variant: 'plo4', format: 'cash', bb: 1, net: 120.75, pot: 241, win: true, tags: ['river_aggr_won', 'plo_underfull_stackoff_won'], hole: 'Ts Qh Js 3h', board: 'Jd Jh 4d 3d 3s',
    sql: { liveEnd: 2, fold: '-', allIn: 'river', rit: false },
    log: 'P:sb:0.5:o1:::;P:bb:1:o2:::;P:fold:0:o3:1:42.08:;P:raise:3:H:1:265.93:;P:fold:0:o4:3:103:;P:call:2.5:o1:3:103.5:;P:raise:11:o2:3:114:;P:call:8:H:11:262.93:;P:call:8:o1:11:101:;F:check:0:o1:0:93:;F:bet:21:o2:0:104:;F:call:21:H:21:254.93:;F:fold:0:o1:21:93:;T:bet:52:o2:0:83:;T:call:52:H:52:233.93:;R:all_in:31:o2:0:31:;R:all_in:181.93:H:31:181.93:;X:return:150.93:H:::' },
  { id: 506784, playedAt: '2026-09-16T09:38:24Z', variant: 'nlh', format: 'tournament', bb: 50, net: 25.06, pot: 2104, win: true, tags: [], hole: 'As Ad', board: '',
    sql: { liveEnd: 1, fold: '-', allIn: 'preflop', rit: false },
    log: 'P:ante:6:o1:::1;P:ante:6:o2:::1;P:sb:25:H:::;P:ante:6:H:::1;P:bb:50:o3:::;P:ante:6:o3:::1;P:ante:6:o4:::1;P:ante:6:o5:::1;P:ante:6:o6:::1;P:ante:6:o7:::1;P:fold:0:o4:50:3988:;P:raise:100:o5:50:3988:;P:fold:0:o6:100:3988:;P:fold:0:o7:100:4161:;P:fold:0:o1:100:3988:;P:fold:0:o2:100:3963:;P:raise:366:H:100:3863:;P:call:316:o3:366:3938:;P:raise:845:o5:366:3888:;P:all_in:3888:H:845:3522:;P:fold:0:o3:3888:3622:;P:fold:0:o5:3888:3143:;P:return:3043:H:::' },
  { id: 533404, playedAt: '2026-09-17T16:46:42Z', variant: 'short_deck', format: 'cash', bb: 1, net: 47.5, pot: 105.5, win: true, tags: ['limped_pot_bloat_won', 'river_aggr_won'], hole: 'Ts Th', board: 'Jc Tc 6s 8c As',
    sql: { liveEnd: 1, fold: '-', allIn: '-', rit: false },
    log: 'P:bb:1:H:::;P:ante:1:H:::1;P:sb:0.5:o1:::;P:fold:0:o2:1:240.85:;P:raise:2:o3:1:260.23:;P:fold:0:o4:2:93:;P:fold:0:o5:2:93.58:;P:fold:0:o1:2:57.13:;P:call:1:H:2:286.87:;F:check:0:H:0:285.87:;F:bet:3:o3:0:258.23:;F:raise:14:H:3:285.87:;F:call:11:o3:14:255.23:;T:bet:36:H:0:271.87:;T:call:36:o3:36:244.23:;R:bet:71:H:0:235.87:;R:fold:0:o3:71:208.23:;R:return:71:H:::' },
];

const HORSE = 'horse-under-test';
const SUIT: Record<string, string> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const STAGE: Record<string, string> = { P: 'preflop', F: 'flop', T: 'turn', R: 'river', X: 'other' };
const cards = (s: string) => (s ? s.split(' ').map((c) => ({ rank: c.slice(0, -1), suit: SUIT[c.slice(-1)]! })) : []);

/** The compact log back in the shape the production column carries. */
function actionsOf(row: RealRow): unknown[] {
  return row.log.split(';').map((tok) => {
    const [st, action, amount, who, currentBet, stackBefore, dead] = tok.split(':');
    const e: Row = { stage: STAGE[st!] ?? 'other', action };
    if (amount) e.amount = Number(amount);
    if (who === 'H') e.userId = HORSE;
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

function reviewRow(row: RealRow, actions: unknown = actionsOf(row)): Row {
  return {
    id: row.id, played_at: row.playedAt, game_variant: row.variant, format: row.format, big_blind: row.bb,
    hole_cards: cards(row.hole), board: cards(row.board), net_bb: row.net, pot_size: row.pot, is_win: row.win,
    leak_tags: row.tags, horse_user_id: HORSE, actions,
  };
}

/** The real pickHandStory on one real row, through the fake client. */
async function factsOf(row: RealRow, actions?: unknown): Promise<HandFacts | null> {
  db.tables = { horse_hand_reviews: [reviewRow(row, actions)] };
  db.failReads = new Set();
  return pickHandStory(HORSE, { seed: 'law' });
}

const real = new Map<number, HandFacts>();
async function realFacts(id: number): Promise<HandFacts> {
  const have = real.get(id);
  if (have) return have;
  const row = ROWS.find((r) => r.id === id)!;
  const f = await factsOf(row);
  expect(f, `facts for ${id}`).not.toBeNull();
  real.set(id, f!);
  return f!;
}

const SOURCE = readFileSync(new URL('./HandVoice.ts', import.meta.url), 'utf8');
const VOCABULARY = new Set((SOURCE.match(/[A-Za-z]+/g) ?? []).map((w) => w.toLowerCase()));

/* ------------------------------------------------------------------------ */

describe('a hand is spoken, not printed', () => {
  it('names common holdings naturally and does not recite Omaha cards', () => {
    expect(sayHolding('AA', 'nlh')).toBe('pocket aces');
    expect(sayHolding('aks', 'nlh')).toBe('ace-king suited');
    expect(sayHolding('72o', 'nlh')).toBe('seven-deuce offsuit');
    expect(sayHolding('AsKhQdJc', 'plo4')).toBeNull();
  });

  it('describes board texture without exposing the board', () => {
    expect(sayBoard(facts('grind'))).toBe('a connected board');
    expect(sayBoard(facts('grind', {
      board: [
        { rank: 'K', suit: 'clubs' },
        { rank: '9', suit: 'clubs' },
        { rank: '6', suit: 'clubs' },
        { rank: '4', suit: 'hearts' },
        { rank: '2', suit: 'spades' },
      ],
    }))).toBe('a three-flush board');
  });

  it('describes only the cards the player saw before the hand was decided', () => {
    // Folded on the flop: the turn and river were dealt to somebody else.
    const flopFold = facts('big_fold', { play: { foldStreet: 'flop', decisiveStreet: 'flop' } });
    expect(sayBoard(flopFold)).toBe('a high-card board');
    // Folded preflop: there is no board to describe.
    const preflopFold = facts('big_fold', { play: { foldStreet: 'preflop', decisiveStreet: 'preflop' } });
    expect(sayBoard(preflopFold)).toBeNull();
    expect(sayStreet(preflopFold)).toBe('preflop');
  });

  it('uses grammatical scale phrases instead of database units', () => {
    expect(sayMoney(facts('big_win', { netBb: 240, isWin: true }))).toBe('a monster pot');
    expect(sayMoney(facts('bad_beat', { netBb: -240, isWin: false }))).toBe('a brutal pot');
    expect(sayMoney(facts('bad_beat', { netBb: -120, isWin: false }))).toBe('a stack-sized pot');
  });
});

describe('every proposed sentence keeps the same laws', () => {
  const cases: HandFacts[] = [
    facts('big_win'),
    facts('bad_beat'),
    facts('cooler'),
    facts('tough_spot'),
    facts('river_aggression'),
    facts('big_fold'),
    facts('stackoff', { isWin: true, netBb: 120 }),
    facts('grind', { isWin: true, netBb: 12 }),
    facts('grind', { isWin: false, netBb: -12 }),
  ];

  it('renders broad, category-specific variety', () => {
    for (const f of cases) {
      expect(rendered(f).length, f.category).toBeGreaterThanOrEqual(8);
    }
  });

  it('never leaks notation, units, placeholders, broken articles, or em dashes', () => {
    for (const f of cases) {
      for (const line of rendered(f)) {
        expect(spokenLineMatches(line.text, f), line.text).toBe(true);
        expect(line.text).not.toMatch(/\b(?:a a|a an|the a)\b/i);
        expect(line.text).not.toMatch(/[{}]/);
        expect(line.text).not.toContain('—');
        expect(line.text).not.toContain('–');
        expect(line.text[0]).toMatch(/[A-Z0-9]/);
        expect(line.text).not.toMatch(/[.!?]\s+[a-z]/);
      }
    }
  });

  it('does not claim a river, win, or loss the row does not support', () => {
    const flopLoss = facts('bad_beat', {
      board: [
        { rank: 'K', suit: 'clubs' },
        { rank: '9', suit: 'clubs' },
        { rank: '6', suit: 'diamonds' },
      ],
      boardNotation: 'Kc 9c 6d',
      street: 'flop',
      play: { stackInStreet: 'flop', allInStreet: 'flop', decisiveStreet: 'flop' },
    });
    for (const line of rendered(flopLoss)) {
      expect(line.text).not.toMatch(/\briver\b/i);
      expect(line.text).not.toMatch(/\bwon\b|\bcollected\b/i);
    }
    // A hand the tags call river aggression, whose log shows none: silence.
    expect(lineFor(facts('river_aggression', { play: { aggressionStreets: [], riverAggression: false } }), 'seed')).toBeNull();
  });

  it('returns silence after the category frame pool is exhausted', () => {
    const f = facts('big_win');
    const used = new Set<string>();
    while (true) {
      const line = lineFor(f, 'fixed-seed', used);
      if (!line) break;
      expect(used.has(line.key)).toBe(false);
      used.add(line.key);
    }
    expect(used.size).toBeGreaterThanOrEqual(8);
    expect(lineFor(f, 'another-seed', used)).toBeNull();
  });

  it('rejects unsafe text even if a future template introduces it', () => {
    const f = facts('grind', { isWin: false, netBb: -20, street: 'flop', play: { decisiveStreet: 'flop' } });
    expect(spokenLineMatches('Lost 184bb with AsKs.', f)).toBe(false);
    expect(spokenLineMatches('The river was rough.', f)).toBe(false);
    expect(spokenLineMatches('Won a small pot.', f)).toBe(false);
    expect(spokenLineMatches('A normal poker sentence.', f)).toBe(true);
  });

  it('a hand with no action record gets no sentence at all', () => {
    const f = facts('big_win');
    expect(lineFor({ ...f, play: undefined as unknown as HandPlay }, 'seed')).toBeNull();
    expect(spokenLineMatches('Good pot with pocket aces. On to the next one.', { ...f, play: undefined as unknown as HandPlay })).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* The action log is the source of every claim (P3C-03..P3C-10)              */
/* ------------------------------------------------------------------------ */

describe('the action log is read, and read the way the engine writes it', () => {
  it('derives showdown, fold street, all-in street and run-it-twice exactly as the investigator did in SQL', async () => {
    for (const row of ROWS) {
      const f = await realFacts(row.id);
      const p = f.play;
      const label = `hand ${row.id}`;
      expect(p.showdown, `${label} showdown`).toBe(row.sql.liveEnd >= 2 && row.sql.fold === '-');
      expect(p.foldStreet ?? '-', `${label} fold`).toBe(row.sql.fold);
      expect(p.stackInStreet ?? '-', `${label} own all-in`).toBe(row.sql.allIn);
      expect(p.runouts > 1, `${label} run it twice`).toBe(row.sql.rit);
      expect(db.writes).toEqual([]);
    }
  });

  it('a call of somebody else\'s all-in is an all-in pot, and a shove nobody called is not a showdown', async () => {
    // 573264: pocket aces moved in preflop over an opponent's all-in, and
    // got looked up; it is the pot going all in, with a showdown.
    const aces = await realFacts(573264);
    expect(aces.play).toMatchObject({ stackInStreet: 'preflop', allInStreet: 'preflop', showdown: true, decisiveStreet: 'preflop' });
    // 618768: moved in on the turn, the last opponent folded. No showdown,
    // decided on the turn.
    const tens = await realFacts(618768);
    expect(tens.play).toMatchObject({ stackInStreet: 'turn', allInStreet: 'turn', showdown: false, decisiveStreet: 'turn' });
    // 558804: all in on the flop and called; the board ran out to five
    // cards, but the hand was decided on the flop.
    const flopAllIn = await realFacts(558804);
    expect(flopAllIn.street).toBe('river');
    expect(flopAllIn.play).toMatchObject({ allInStreet: 'flop', decisiveStreet: 'flop', showdown: true });
  });

  it('fails closed on a log it cannot read', async () => {
    expect(derivePlay(HORSE, null)).toBeNull();
    expect(derivePlay(HORSE, [])).toBeNull();
    expect(derivePlay(HORSE, 'not a log')).toBeNull();
    expect(derivePlay(HORSE, [{ stage: 'flop', action: 'bet' }])).toBeNull(); // a decision nobody made
    expect(derivePlay(HORSE, [{ stage: 'flop', action: 'bet', amount: 5, userId: 'somebody-else' }])).toBeNull(); // the horse never acts
    expect(derivePlay('', actionsOf(ROWS[0]!))).toBeNull();

    // Through the real picker: a row without its log is not a story.
    const before = storySkips.hand_actions_unreadable ?? 0;
    expect(await factsOf(ROWS[0]!, null)).toBeNull();
    expect(storySkips.hand_actions_unreadable).toBe(before + 1);

    // And an action read that errors is silence, not a guess.
    db.tables = { horse_hand_reviews: [reviewRow(ROWS[0]!)] };
    db.failReads = new Set(['horse_hand_reviews']);
    expect(await pickHandStory(HORSE, { seed: 'law' })).toBeNull();
    db.failReads = new Set();
  });

  it('a log that disagrees with the row is not told', async () => {
    // A "win" in which the horse folded.
    const folded = ROWS.find((r) => r.id === 600644)!;
    expect(await factsOf({ ...folded, win: true, net: 32.5 })).toBeNull();
  });
});

describe('P3C-03: held up and got home only when the hand was shown down and won', () => {
  it('a pot taken with a shove nobody called is never said to have held', async () => {
    for (const id of [618768, 534016]) {
      const f = await realFacts(id);
      expect(f.play.showdown).toBe(false);
      expect(f.isWin).toBe(true);
      const lines = rendered(f);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.text, `hand ${id}`).not.toMatch(/held up|it held|got home|showdown|showed|got paid/i);
      }
    }
  });

  it('a showdown win may still say it held', async () => {
    const f = await realFacts(573264);
    expect(f.play.showdown).toBe(true);
    const texts = rendered(f).map((l) => l.text);
    expect(texts.some((t) => /it held/i.test(t))).toBe(true);
  });

  it('the sentence checker refuses the claim on its own', async () => {
    const f = await realFacts(618768);
    expect(spokenLineMatches('Pocket tens held up on a paired board. Nice when the simple plan works.', f)).toBe(false);
    expect(spokenLineMatches('A paired board made it interesting, but pocket eights got home.', f)).toBe(false);
  });
});

describe('P3C-04: the street is where the money went in, never the board length', () => {
  it('a flop all-in that was dealt out is not a river story', async () => {
    const f = await realFacts(558804);
    const lines = rendered(f);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.text, line.text).not.toMatch(/\briver\b|last card|on the turn|\bpreflop\b/i);
    }
    expect(spokenLineMatches('Committed the stack on the river. There was no quiet ending after that.', f)).toBe(false);
    expect(sayStreet(f)).toBe('on the flop');
  });

  it('a preflop all-in says preflop, and never "before a flop"', async () => {
    const f = await realFacts(559728);
    expect(sayStreet(f)).toBe('preflop');
    for (const line of rendered(f)) {
      expect(line.text).not.toMatch(/before a flop|on the flop|on the turn|\briver\b/i);
    }
  });

  it('no line blames the river card: there is no evaluator to prove it', async () => {
    expect(SOURCE).not.toMatch(/looked a lot better before the last card/);
    expect(SOURCE).not.toMatch(/The river was not kind/);
    for (const row of ROWS) {
      const f = await realFacts(row.id);
      for (const line of rendered(f)) {
        expect(line.text).not.toMatch(/before the last card|river was not kind|did not cooperate|made it interesting|never made this comfortable|turned a good hand into/i);
      }
    }
  });
});

describe('P3C-05: the full stack only when the stack actually went in', () => {
  it('a cold-call stack-off tag without an all-in in the log is told without a stack', async () => {
    const f = await realFacts(596484);
    expect(f.play.allInStreet).toBeNull();
    expect(f.play.stackInStreet).toBeNull();
    expect(f.category).not.toBe('stackoff');
    const lines = rendered(f);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.text).not.toMatch(/full stack|full-stack|whole stack|every chip|committed the stack|shoved|\ball in\b|went in|stack-off/i);
    }
    expect(spokenLineMatches('Ace-king offsuit, the full stack, and a result I could do without.', f)).toBe(false);
  });

  it('a stack that went in preflop can be spoken of as one', async () => {
    const f = await realFacts(573264);
    expect(f.category).toBe('stackoff');
    const texts = rendered(f).map((l) => l.text);
    expect(texts.some((t) => /stack|went in|all in/i.test(t))).toBe(true);
    for (const t of texts) expect(t).not.toMatch(/on the flop|on the turn|\briver\b/i);
  });
});

describe('P3C-06: no backstory the row does not carry', () => {
  it('the three invented lines are gone from the templates', () => {
    expect(SOURCE).not.toMatch(/bankroll can breathe/i);
    expect(SOURCE).not.toMatch(/A year ago I probably call/i);
    expect(SOURCE).not.toMatch(/Finally dragged a real one/i);
  });

  it('nothing rendered for any real row mentions a bankroll, a year ago or finally', async () => {
    for (const row of ROWS) {
      const f = await realFacts(row.id);
      for (const line of rendered(f)) {
        expect(line.text).not.toMatch(/a year ago|\bfinally\b|bankroll|breathe again|\btoday\b|\btonight\b|\byesterday\b|last week|this week/i);
      }
    }
    const f = await realFacts(551888);
    expect(spokenLineMatches('That was a solid pot. The bankroll can breathe again.', f)).toBe(false);
  });
});

describe('P3C-07: small, quiet and ordinary only under forty big blinds', () => {
  it('a forty-plus pot is never small, and a cooler never costs a small pot', async () => {
    for (const id of [554908, 568124]) {
      const f = await realFacts(id);
      expect(Math.abs(f.netBb)).toBeGreaterThanOrEqual(40);
      for (const line of rendered(f)) {
        expect(line.text, `hand ${id}: ${line.text}`).not.toMatch(/\bsmall\b|\bquiet\b|ordinary|routine|unglamorous|no drama|nothing dramatic/i);
      }
    }
    const cooler = await realFacts(615272);
    expect(cooler.category).toBe('cooler');
    for (const line of rendered(cooler)) expect(line.text).not.toMatch(/a small pot/i);
    expect(spokenLineMatches('Small pot, clean decision, next hand.', await realFacts(554908))).toBe(false);
    expect(spokenLineMatches('That felt unavoidable. It still cost a small pot.', cooler)).toBe(false);
  });

  it('a hand its own stack went into is never quiet, however small the pot', async () => {
    // 506784: pocket aces moved in preflop, nobody called, a small pot won.
    const f = await realFacts(506784);
    expect(f.play.stackInStreet).toBe('preflop');
    expect(Math.abs(f.netBb)).toBeLessThan(40);
    const lines = rendered(f);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.text, line.text).not.toMatch(/\bquiet\b|no drama|nothing dramatic/i);
    }
    expect(spokenLineMatches('Quiet one with pocket aces. Most of the game looks like that.', f)).toBe(false);
  });
});

describe('P3C-08: a loss the reviewer put on the player is a tough spot, not a bad beat', () => {
  it('leak-tagged losses are categorised as tough_spot', async () => {
    for (const id of [544656, 616020, 494384]) {
      const f = await realFacts(id);
      expect(f.category, `hand ${id}`).toBe('tough_spot');
      for (const line of rendered(f)) {
        expect(line.text).not.toMatch(/cooler|did not cooperate|not kind|unlucky|bad beat|the cards had|second best/i);
      }
    }
    expect(categorise(['river_aggr_lost', 'river_raise_paidoff'], false, -75.3)).toBe('tough_spot');
    expect(categorise(['top_pair_weak_kicker_stackoff'], false, -126.53)).toBe('tough_spot');
    // Untagged big losses still are what they were.
    expect(categorise([], false, -91.5)).toBe('bad_beat');
    // A fold tag is not a leak on the player; it stays a fold.
    expect(categorise(['big_bet_fold', 'big_fold_river'], false, -54)).toBe('big_fold');
  });

  it('a cooler tag still tells a cooler', async () => {
    const f = await realFacts(517992);
    expect(f.category).toBe('cooler');
  });
});

describe('P3C-09: a board that was run more than once has no board or river to describe', () => {
  it('run-it-twice hands get no board or river wording', async () => {
    for (const id of [553892, 598861, 554908]) {
      const f = await realFacts(id);
      expect(f.play.runouts, `hand ${id}`).toBeGreaterThan(1);
      expect(sayBoard(f)).toBeNull();
      const lines = rendered(f);
      expect(lines.length, `hand ${id}`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.text, `hand ${id}: ${line.text}`).not.toMatch(/\bboard\b|\briver\b|runout|last card/i);
      }
    }
    expect(spokenLineMatches('A paired board did not cooperate with queen-jack offsuit.', await realFacts(553892))).toBe(false);
  });
});

describe('P3C-10: the flagged templates read like a player', () => {
  it('none of the flagged phrasings survives', async () => {
    expect(SOURCE).not.toMatch(/got through on the river|before a flop|Give me a lap|too strong to feel cheap/);
    for (const row of ROWS) {
      const f = await realFacts(row.id);
      for (const line of rendered(f)) {
        expect(line.text).not.toMatch(/got through|before a flop|give me a lap|too strong to feel cheap/i);
      }
    }
  });
});

describe('every sentence about a real hand comes from the module and matches its log', () => {
  it('no notation, no numbers, no filler, no dashes, and every word is the module\'s own', async () => {
    for (const row of ROWS) {
      const f = await realFacts(row.id);
      const lines = rendered(f);
      expect(lines.length, `hand ${row.id} has nothing to say`).toBeGreaterThan(0);
      for (const line of lines) {
        const label = `hand ${row.id}: ${line.text}`;
        expect(spokenLineMatches(line.text, f), label).toBe(true);
        expect(line.text, label).not.toMatch(/[AKQJT2-9][hdcs]\s*[AKQJT2-9][hdcs]|\b[AKQJT2-9][hdcs]\b|\b(?:[AKQJT][AKQJT2-9]|[2-9][AKQJT])[so]\b/);
        expect(line.text, label).not.toMatch(/\d|\bbb\b|big blind/i);
        expect(line.text, label).not.toMatch(/\p{Extended_Pictographic}/u);
        expect(line.text, label).not.toMatch(/[–—]/);
        expect(line.text, label).not.toMatch(/^(?:look|nah|okay|ok|well|honestly|so|yeah|what gets me|the thing is|on another watch|for me)\b/i);
        for (const word of line.text.match(/[A-Za-z]+/g) ?? []) {
          expect(VOCABULARY.has(word.toLowerCase()), `${label} (word "${word}")`).toBe(true);
        }
        // A fold is only ever the horse's own.
        if (/\b(?:folded|let it go|in the muck|passed on it)\b/i.test(line.text)) expect(f.play.foldStreet, label).not.toBeNull();
        // A street named is the street the hand was decided on.
        const street: Street | null = /\bpreflop\b/i.test(line.text) ? 'preflop' : /on the flop/i.test(line.text) ? 'flop' : /on the turn/i.test(line.text) ? 'turn' : /on the river|\bthe river\b/i.test(line.text) ? 'river' : null;
        if (street) expect(f.play.decisiveStreet, label).toBe(street);
      }
    }
    expect(db.writes).toEqual([]);
  });
});
