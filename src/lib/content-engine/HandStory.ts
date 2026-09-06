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
  | 'grind';

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
  /** How far the hand went. */
  street: 'preflop' | 'flop' | 'turn' | 'river';
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
export function categorise(leaks: string[], isWin: boolean, netBb: number): HandCategory {
  const has = (frag: string) => leaks.some((t) => t.includes(frag));

  if (has('big_fold')) return 'big_fold';
  if (has('river_aggr') && isWin) return 'river_aggression';
  if (has('river_raise') && isWin) return 'river_aggression';

  // The classic coolers: a strong hand that was second best.
  if (!isWin && (has('dominated_straight') || has('underfull') || has('nonnut_flush') ||
      has('second_nut_flush') || has('straight_into_flush') || has('plo_set'))) {
    return 'cooler';
  }
  if (!isWin && netBb <= -60) return 'bad_beat';
  if (has('stackoff')) return 'stackoff';
  if (isWin && netBb >= 60) return 'big_win';
  return 'grind';
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

function asCards(v: unknown): Card[] {
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
function stakeOf(format: string, bigBlind: number): string | undefined {
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
    return null;
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
  const row = top[fleetHash(`${horseId}:${seed}`, 'handpick') % top.length]!;

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
    category: categorise(leaks, isWin, netBb),
    holeNotation: holeText(hole),
    boardNotation: boardText(board),
    street: streetOf(board),
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
    return null;
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
