/**
 * HandStory: the poker a horse actually played, turned into facts a post can
 * be built from.
 *
 * WHY (the 2026-09-05 audit, defect D-04): "Horses never talk about the poker
 * they actually play." Under the Horses Are Players law these accounts sit in
 * real seats, win and lose real pots and bust real tournaments, and
 * `horse_hand_reviews` has recorded every hand of it - hole cards, board,
 * action log, pot, net in big blinds, and a leak tag naming what kind of hand
 * it was. In the seven days to 2026-09-06 that was 204,474 hands across all
 * 1,000 horses, and not one post had ever been derived from any of it.
 *
 * This is the content source that cannot run dry and cannot repeat: two
 * horses cannot have played the same hand, and a hand is specific by
 * construction. Phase 1 and 2 fought over 150 clips and a placeholder title;
 * this needs neither.
 *
 * WHAT IS TRUE HERE IS TRUE IN THE LEDGER. Every number a post can state -
 * the pot, the net, the stake, the board - is read from the row and passed
 * through unchanged. Nothing is rounded into a better story and nothing is
 * inferred that the row does not say. If the post says 40bb, the hand was
 * 40bb; this is the platform that reconciles chips to the cent, and a horse
 * that lies about a pot is a horse a player can catch.
 *
 * OPPONENTS ARE NEVER NAMED. The action log carries every seat's user id, and
 * none of it leaves this module. A horse refers to "the big blind" or "one of
 * the regs", never to a person. Programme invariant 3.
 */
import { getSupabase } from '../supabase.js';
import { fleetHash } from './FleetScheduler.js';

export interface Card {
  rank: string;
  suit: string;
}

export type HandCategory =
  | 'big_win'
  | 'bad_beat'
  | 'river_aggression'
  | 'big_fold'
  | 'cooler'
  | 'stackoff'
  /**
   * A loss the reviewer tagged as the player's own kind of spot (a river bet
   * that got called, a weak kicker that went too far, a cold call that grew).
   * Told in a neutral voice: never as bad luck, never as a cooler.
   */
  | 'tough_spot'
  | 'grind';

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

/**
 * What the horse actually did in the hand, read from the action log
 * (`horse_hand_reviews.actions`), never from the board or the tags.
 *
 * WHY (2026-09-21 recertification, P3C-03..P3C-09): the first HandVoice only
 * knew the board, the net and the tags, so it said "held up" about pots won
 * without a showdown, "committed the stack on the river" when the money went
 * in on the flop (a board is always dealt out after an all-in), and "the full
 * stack" when the player checked the turn and river. Every one of those
 * claims is a fact about the ACTION, so the action log is where they come
 * from.
 */
export interface HandPlay {
  /** The hand reached a showdown with the horse still in it. */
  showdown: boolean;
  /**
   * The street on which the horse's own stack went all in (its own all-in,
   * as a bet, a raise or a call for less). Null when it never did.
   */
  stackInStreet: Street | null;
  /**
   * The street on which the pot went all in with the horse in it: its own
   * all-in, or a call of somebody else's all-in. Null when neither happened.
   */
  allInStreet: Street | null;
  /** The street the horse folded on, or null. */
  foldStreet: Street | null;
  /** Streets on which the horse bet or raised (an all-in that raised counts). */
  aggressionStreets: Street[];
  /** The horse bet or raised on the river. */
  riverAggression: boolean;
  /** 1 for a normal hand, 2 or 3 when the board was run more than once. */
  runouts: number;
  /** Where the hand was decided for the horse: its fold, its all-in, or the last betting street. */
  decisiveStreet: Street;
}

export interface HandFacts {
  handId: string;
  playedAt: string;
  variant: string;
  format: string;
  bigBlind: number;
  hole: Card[];
  board: Card[];
  /** Net result in big blinds, as recorded. Negative is a loss. */
  netBb: number;
  /** Pot size in big blinds, as recorded. */
  potBb: number;
  isWin: boolean;
  leaks: string[];
  category: HandCategory;
  /** "JJ", "AKs", "KQo", or the full holding for a four-card game. */
  holeNotation: string;
  /** "Kc 7s Js 4c 2s", or empty when the hand ended before a flop. */
  boardNotation: string;
  /**
   * How far the BOARD went. Not when the money went in: an all-in is always
   * dealt out to five cards. Anything a sentence says about a street comes
   * from `play`, never from this.
   */
  street: Street;
  /** What the horse did, from the action log. */
  play: HandPlay;
  /** Human-readable stake, when the format has one. */
  stake?: string;
}

export interface SessionFacts {
  day: string;
  variant: string;
  format: string;
  hands: number;
  netBb: number;
}

const SUIT_LETTER: Record<string, string> = {
  hearts: 'h', diamonds: 'd', clubs: 'c', spades: 's',
  h: 'h', d: 'd', c: 'c', s: 's',
};

const RANK_ORDER = '23456789TJQKA';

/** "Kc", "7s". Poker's own shorthand, which is what a player would write. */
export function cardText(c: Card): string {
  const rank = (c.rank ?? '').toUpperCase();
  const suit = SUIT_LETTER[(c.suit ?? '').toLowerCase()] ?? '';
  return `${rank}${suit}`;
}

export function boardText(board: Card[]): string {
  return board.map(cardText).join(' ');
}

/**
 * Hold'em shorthand for two cards: "JJ", "AKs", "KQo". Anything with more
 * cards (PLO and friends) is written out, because there is no shorthand a
 * player would recognise.
 */
export function holeText(hole: Card[]): string {
  if (hole.length === 2) {
    const [a, b] = hole as [Card, Card];
    const ra = (a.rank ?? '').toUpperCase();
    const rb = (b.rank ?? '').toUpperCase();
    if (ra === rb) return `${ra}${rb}`;
    const hi = RANK_ORDER.indexOf(ra) >= RANK_ORDER.indexOf(rb) ? ra : rb;
    const lo = hi === ra ? rb : ra;
    const suited = (a.suit ?? '') === (b.suit ?? '');
    return `${hi}${lo}${suited ? 's' : 'o'}`;
  }
  return hole.map(cardText).join('');
}

function streetOf(board: Card[]): HandFacts['street'] {
  if (board.length >= 5) return 'river';
  if (board.length === 4) return 'turn';
  if (board.length === 3) return 'flop';
  return 'preflop';
}

/**
 * What kind of hand this was, from the tags the reviewer already assigned
 * plus the result. The tag vocabulary is the engine's own (40 tags as of
 * 2026-09-06); a tag ending `_won` is the winning side of the same spot.
 */
export function categorise(leaks: string[], isWin: boolean, netBb: number, play?: HandPlay): HandCategory {
  const has = (frag: string) => leaks.some((t) => t.includes(frag));
  const cooler = COOLER_TAGS.some(has);
  // A loss tagged with anything other than a fold or a cooler is a spot the
  // reviewer put on the player (a called river bet, a weak kicker, a cold
  // call that grew). It is told neutrally, never as a bad beat (P3C-08).
  const ownSpot = !isWin && !cooler && leaks.some((t) => !FOLD_TAGS.some((f) => t.includes(f)));

  if (play) {
    // The action log outranks the tags. A horse that folded folded, and a
    // stack-off with no all-in in the log is not told as one (P3C-05).
    if (play.foldStreet) return 'big_fold';
    if (isWin && play.riverAggression && (has('river_aggr') || has('river_raise'))) return 'river_aggression';
    if (!isWin && cooler) return 'cooler';
    if (ownSpot) return 'tough_spot';
    if (!isWin && netBb <= -60) return 'bad_beat';
    if (has('stackoff') && play.allInStreet) return 'stackoff';
    if (isWin && netBb >= 60) return 'big_win';
    return 'grind';
  }

  if (has('big_fold')) return 'big_fold';
  if (has('river_aggr') && isWin) return 'river_aggression';
  if (has('river_raise') && isWin) return 'river_aggression';

  // The classic coolers: a strong hand that was second best.
  if (!isWin && cooler) return 'cooler';
  if (ownSpot) return 'tough_spot';
  if (!isWin && netBb <= -60) return 'bad_beat';
  if (has('stackoff')) return 'stackoff';
  if (isWin && netBb >= 60) return 'big_win';
  return 'grind';
}

const COOLER_TAGS = ['dominated_straight', 'underfull', 'nonnut_flush', 'second_nut_flush', 'straight_into_flush', 'plo_set'];
const FOLD_TAGS = ['big_fold', 'big_bet_fold', 'bet_fold_line'];

const STREETS: readonly Street[] = ['preflop', 'flop', 'turn', 'river'];
const isStreet = (s: unknown): s is Street => typeof s === 'string' && (STREETS as readonly string[]).includes(s);
const VOLUNTARY = new Set(['fold', 'check', 'call', 'bet', 'raise', 'all_in']);

interface ActionEntry {
  seat?: unknown;
  stage?: unknown;
  action?: unknown;
  amount?: unknown;
  userId?: unknown;
  publicNode?: { currentBet?: unknown; seats?: unknown } | null;
}

/** A finite number, or null. Never a guess. */
function finite(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The horse's stack behind before this action, from the table snapshot. */
function stackBefore(a: ActionEntry): number | null {
  const seats = a.publicNode?.seats;
  const seat = finite(a.seat);
  if (!Array.isArray(seats) || seat === null) return null;
  for (const s of seats) {
    if (Array.isArray(s) && finite(s[0]) === seat) return finite(s[1]);
  }
  return null;
}

/**
 * The horse's side of the hand, from the action log. Returns null when the
 * log cannot establish it (missing, malformed, or the horse never acts in
 * it): a hand whose action cannot be read is not a hand the horse talks
 * about. Fail closed.
 *
 * The log's own vocabulary (checked against production 2026-09-21): stages
 * preflop, flop, turn, river, plus pineapple_discard and showdown; actions
 * sb, bb, ante, bomb_ante, post, fold, check, call, bet, raise, all_in,
 * return, discard, and `rit_board_N:<cards>` for each extra runout. An
 * all_in amount is the street total it made; `publicNode.currentBet` is the
 * bet it faced.
 */
export function derivePlay(horseId: string, actions: unknown): HandPlay | null {
  if (!horseId || !Array.isArray(actions) || actions.length === 0) return null;

  const players = new Set<string>();
  const seen = new Set<string>();
  const folded = new Set<string>();
  const allInPlayers = new Set<string>();
  const aggression = new Set<Street>();
  // Per street: whether the bet standing right now is somebody's all-in.
  const standingAllIn = new Map<Street, boolean>();
  let horseActed = false;
  let foldStreet: Street | null = null;
  let stackInStreet: Street | null = null;
  let allInStreet: Street | null = null;
  let runouts = 1;
  let lastBettingStreet: Street | null = null;

  for (const raw of actions) {
    if (!raw || typeof raw !== 'object') return null;
    const a = raw as ActionEntry;
    const act = typeof a.action === 'string' ? a.action : '';
    const rit = act.match(/^rit_board_(\d+)/);
    if (rit) {
      runouts = Math.max(runouts, Number(rit[1]));
      continue;
    }
    if (!isStreet(a.stage)) continue;
    const street = a.stage;
    const who = typeof a.userId === 'string' ? a.userId : '';
    if (!who) {
      // A decision nobody made is a log that cannot be read.
      if (VOLUNTARY.has(act)) return null;
      continue;
    }
    // Blinds, antes and returned bets are not decisions. A seat counts as in
    // the hand once it makes one (an ante is logged as dead money, so it says
    // nothing about who was dealt in or who is still in at the end).
    if (who !== 'system') seen.add(who);
    if (!VOLUNTARY.has(act)) continue;
    players.add(who);
    lastBettingStreet = street;

    const amount = finite(a.amount);
    const facing = finite(a.publicNode?.currentBet);
    // An all-in raises the bet only when its street total beats the bet it
    // faced AND somebody still in the hand has chips left to face it. Moving
    // in over an all-in with nobody else behind is a call: the engine hands
    // the excess straight back. Without a snapshot none of it is assumed.
    const othersBehind = [...seen].some((p) => p !== who && !folded.has(p) && !allInPlayers.has(p));
    const raisingAllIn = act === 'all_in' && amount !== null && facing !== null && amount > facing && othersBehind;
    if (act === 'all_in') allInPlayers.add(who);

    if (who !== horseId) {
      if (act === 'fold') folded.add(who);
      if (act === 'bet' || act === 'raise') standingAllIn.set(street, false);
      if (raisingAllIn) standingAllIn.set(street, true);
      continue;
    }

    horseActed = true;
    if (act === 'fold') {
      folded.add(who);
      if (!foldStreet) foldStreet = street;
      continue;
    }
    if (foldStreet) return null; // the log has the horse acting after it folded
    if (act === 'bet' || act === 'raise') {
      aggression.add(street);
      standingAllIn.set(street, false);
    }
    if (act === 'all_in') {
      if (!stackInStreet) stackInStreet = street;
      if (!allInStreet) allInStreet = street;
      if (raisingAllIn) {
        aggression.add(street);
        standingAllIn.set(street, true);
      }
    }
    if (act === 'call') {
      const before = stackBefore(a);
      const emptied = before !== null && amount !== null && amount >= before;
      if (emptied && !stackInStreet) stackInStreet = street;
      if ((standingAllIn.get(street) === true || emptied) && !allInStreet) allInStreet = street;
    }
  }

  if (!horseActed || !lastBettingStreet) return null;
  const live = [...players].filter((p) => !folded.has(p));
  const showdown = !foldStreet && live.includes(horseId) && live.length >= 2;
  return {
    showdown,
    stackInStreet,
    allInStreet,
    foldStreet,
    aggressionStreets: STREETS.filter((s) => aggression.has(s)),
    riverAggression: aggression.has('river'),
    runouts,
    decisiveStreet: foldStreet ?? allInStreet ?? lastBettingStreet,
  };
}

/**
 * Why a grounded story was not told, counted per reason for the run report.
 * Observation only: nothing reads it to decide anything.
 */
export const storySkips: Record<string, number> = {};
function skip(reason: string): null {
  storySkips[reason] = (storySkips[reason] ?? 0) + 1;
  return null;
}

interface ReviewRow {
  id: string;
  played_at: string;
  game_variant: string | null;
  format: string | null;
  big_blind: number | string | null;
  hole_cards: unknown;
  board: unknown;
  net_bb: number | string | null;
  pot_size: number | string | null;
  is_win: boolean | null;
  leak_tags: string[] | null;
}

export function asCards(v: unknown): Card[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((c): c is Card => !!c && typeof c === 'object' && 'rank' in (c as object))
    .map((c) => ({ rank: String((c as Card).rank ?? ''), suit: String((c as Card).suit ?? '') }));
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Stakes, only where the row can actually support the claim. */
export function stakeOf(format: string, bigBlind: number): string | undefined {
  // Only where the halved blind is a stake somebody actually posts. A 0.25
  // big blind produced "0.125/0.25", which is not a game that exists.
  if (!bigBlind || format === 'tournament' || bigBlind < 1) return undefined;
  const sb = bigBlind / 2;
  if (!Number.isInteger(sb * 100)) return undefined;
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));
  return `${fmt(sb)}/${fmt(bigBlind)}`;
}

/**
 * The hand worth telling from this horse's recent play.
 *
 * Deterministic: the same horse on the same day picks the same hand, so a
 * retry after a failed publish does not produce a different story. Chosen
 * from the most eventful candidates by size, then by the horse's own hash, so
 * two horses looking at similar weeks still pick differently.
 */
export async function pickHandStory(
  horseId: string,
  opts: { days?: number; seed?: string; minAbsBb?: number } = {},
): Promise<HandFacts | null> {
  const days = opts.days ?? 7;
  const minAbsBb = opts.minAbsBb ?? 25;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data, error } = await getSupabase()
    .from('horse_hand_reviews')
    .select('id, played_at, game_variant, format, big_blind, hole_cards, board, net_bb, pot_size, is_win, leak_tags')
    .eq('horse_user_id', horseId)
    .gte('played_at', since)
    .order('played_at', { ascending: false })
    .limit(400);

  if (error) {
    console.warn('[hand-story] read failed:', error.message);
    return skip('hand_read_failed');
  }
  const rows = (data ?? []) as ReviewRow[];
  if (!rows.length) return null;

  // Only hands that actually went somewhere. A 2bb pot is not a story.
  const candidates = rows.filter((r) => Math.abs(num(r.net_bb)) >= minAbsBb && asCards(r.hole_cards).length >= 2);
  if (!candidates.length) return null;

  // Rank by how much happened, take the top slice, then let the horse's own
  // hash choose inside it.
  candidates.sort((a, b) => Math.abs(num(b.net_bb)) - Math.abs(num(a.net_bb)));
  const top = candidates.slice(0, Math.min(12, candidates.length));
  const seed = opts.seed ?? new Date().toISOString().slice(0, 10);
  const start = fleetHash(`${horseId}:${seed}`, 'handpick') % top.length;
  const ordered = [...top.slice(start), ...top.slice(0, start)];

  // The action log, for the slice only: a log carries a table snapshot per
  // action, so reading it for all 400 rows would move megabytes per pick.
  const { data: logs, error: logError } = await getSupabase()
    .from('horse_hand_reviews')
    .select('id, actions')
    .in('id', ordered.map((r) => r.id));
  if (logError) {
    console.warn('[hand-story] action read failed:', logError.message);
    return skip('hand_actions_read_failed');
  }
  const actionsById = new Map(
    ((logs ?? []) as Array<{ id: string | number; actions: unknown }>).map((l) => [String(l.id), l.actions]),
  );

  for (const row of ordered) {
    const play = derivePlay(horseId, actionsById.get(String(row.id)));
    if (!play) {
      skip('hand_actions_unreadable');
      continue;
    }
    const isWin = Boolean(row.is_win);
    // A win the horse folded, or a loss with neither a fold nor a showdown,
    // is a log that disagrees with the row. Neither is told.
    if ((isWin && play.foldStreet) || (!isWin && !play.foldStreet && !play.showdown)) {
      skip('hand_actions_disagree');
      continue;
    }
    return factsFrom(row, play);
  }
  return null;
}

function factsFrom(row: ReviewRow, play: HandPlay): HandFacts {
  const hole = asCards(row.hole_cards);
  const board = asCards(row.board);
  const bigBlind = num(row.big_blind);
  const netBb = Number(num(row.net_bb).toFixed(2));
  const potBb = bigBlind > 0 ? Number((num(row.pot_size) / bigBlind).toFixed(1)) : 0;
  const leaks = row.leak_tags ?? [];
  const isWin = Boolean(row.is_win);
  const format = row.format ?? 'cash';

  return {
    handId: row.id,
    playedAt: row.played_at,
    variant: row.game_variant ?? 'nlh',
    format,
    bigBlind,
    hole,
    board,
    netBb,
    potBb,
    isWin,
    leaks,
    category: categorise(leaks, isWin, netBb, play),
    holeNotation: holeText(hole),
    boardNotation: boardText(board),
    street: streetOf(board),
    play,
    stake: stakeOf(format, bigBlind),
  };
}

/**
 * The horse's most recent day of real volume, for a session post.
 * Days with a handful of hands are not a session and are skipped.
 */
export async function pickSessionStory(
  horseId: string,
  opts: { days?: number; minHands?: number } = {},
): Promise<SessionFacts | null> {
  const days = opts.days ?? 3;
  const minHands = opts.minHands ?? 40;
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const { data, error } = await getSupabase()
    .from('horse_daily_nets')
    .select('day, game_variant, format, hands, net_bb')
    .eq('horse_user_id', horseId)
    .gte('day', since)
    .order('day', { ascending: false })
    .limit(20);

  if (error) {
    console.warn('[hand-story] session read failed:', error.message);
    return skip('session_read_failed');
  }
  const rows = (data ?? []) as Array<{ day: string; game_variant: string | null; format: string | null; hands: number | null; net_bb: number | string | null }>;
  const usable = rows.filter((r) => num(r.hands) >= minHands);
  if (!usable.length) return null;

  // The biggest swing of the recent days is the one worth mentioning.
  usable.sort((a, b) => Math.abs(num(b.net_bb)) - Math.abs(num(a.net_bb)));
  const r = usable[0]!;
  return {
    day: r.day,
    variant: r.game_variant ?? 'nlh',
    format: r.format ?? 'cash',
    hands: num(r.hands),
    netBb: Number(num(r.net_bb).toFixed(1)),
  };
}

/** How a variant is written in a sentence. */
export function variantName(v: string): string {
  const map: Record<string, string> = {
    nlh: 'no limit holdem',
    flh: 'limit holdem',
    plo4: 'PLO',
    plo5: 'PLO5',
    plo6: 'PLO6',
    plo8: 'PLO8',
    flo8: 'limit Omaha 8',
    short_deck: 'short deck',
    pineapple: 'pineapple',
  };
  return map[v] ?? v;
}
