/**
 * PuzzleComposer: a real hand from `horse_hand_reviews` turned into one of
 * the Phase 7 interactive puzzles a horse posts on the feed.
 *
 * Three kinds: `nuts` (what is the best possible hand on this river board),
 * `pot_odds` (what equity does the call need, from the pot and the bet the
 * horse actually faced) and `what_would_you_do` (the horse's own river
 * decision, revealed six hours later with the result from the row).
 *
 * WHAT IS TRUE HERE IS TRUE IN THE LEDGER (HandStory.ts rule): every card,
 * amount and result comes from the row and is passed through unchanged;
 * nothing is rounded into a better story. Percentages and ratios are the
 * arithmetic the contract prescribes, over the row's own numbers.
 *
 * OPPONENTS ARE NEVER NAMED. The action log carries every seat's user id;
 * it is compared against the horse's own id to find the horse's actions and
 * never copied anywhere. No opponent's cards, id or name can reach the
 * prompt, the options, the explanation or the proof (the tests put a fake
 * user id into the log and prove it never comes out).
 *
 * THE ANSWER IS COMMITTED, NOT PUBLISHED. The prompt never states which
 * option is right. The correct option lives server-side with a random salt,
 * and `answer_commitment = sha256(puzzle_key:correct:salt)` is public so
 * anyone can verify after the reveal that it was fixed before the first
 * human answered. The explanation is written so it never repeats the
 * correct option's label either; the reveal appends the label itself.
 *
 * Pure: no Supabase, no network, no clock (the caller passes `now`), and
 * the salt is the caller's. Same row, key and salt in, same puzzle out.
 */
import { createHash } from 'node:crypto';
import {
  EVALUATOR_VERSION,
  cardsFromRow,
  cardsLine,
  evaluate5,
  nutsOnBoard,
  type Card,
  type NutsClass,
} from './PokerEvaluator.js';

export type PuzzleKind = 'nuts' | 'pot_odds' | 'what_would_you_do';
export const PUZZLE_KINDS: readonly PuzzleKind[] = ['nuts', 'pot_odds', 'what_would_you_do'];

export type OptionKey = 'A' | 'B' | 'C' | 'D';
const OPTION_KEYS: readonly OptionKey[] = ['A', 'B', 'C', 'D'];

/** Hours between the post and the reveal; the prompt says "about six hours". */
export const REVEAL_HOURS = 6;

/** A `horse_hand_reviews` row as the route selects it (numeric columns may arrive as strings). */
export interface PuzzleReviewRow {
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
  actions: unknown;
}

export interface PuzzleOption {
  key: OptionKey;
  label: string;
}

export interface ComposedPuzzle {
  kind: PuzzleKind;
  puzzle_key: string;
  hand_id: string;
  source_review_id: number;
  game_variant: string;
  /** The five board cards with letter suits, as `social_puzzles.board` stores them. */
  board: Card[];
  /** The exact horse-visible post text. Never names the correct option. */
  prompt: string;
  options: PuzzleOption[];
  correct_option: OptionKey;
  /** Server-side until the reveal; never contains the correct option's label. */
  explanation: string;
  salt: string;
  answer_commitment: string;
  proof: Record<string, unknown>;
  evaluator_version: string;
  rewardable: boolean;
  reveal_hours: number;
}

export type ComposeResult = { ok: true; puzzle: ComposedPuzzle } | { ok: false; rejected: string };

/** 'p7:<kind>:<hand_id>': the publication key of the post and the puzzle. */
export function puzzleKey(kind: PuzzleKind, handId: string): string {
  return `p7:${kind}:${handId}`;
}

/** sha256 hex of `puzzleKey:correct:salt`, the same bytes the SQL side hashes with encode(sha256(...), 'hex'). */
export function commitmentFor(key: string, correct: OptionKey, salt: string): string {
  return createHash('sha256').update(`${key}:${correct}:${salt}`).digest('hex');
}

/**
 * Where the correct option sits among `n` options: deterministic from the
 * puzzle key alone, so the same puzzle always renders the same way and the
 * position is not always 'A'.
 */
export function correctPosition(key: string, n: number): number {
  const digest = createHash('sha256').update(`${key}:option-slot`).digest('hex');
  return parseInt(digest.slice(0, 8), 16) % n;
}

/* ------------------------------------------------------------------------ */
/* Fixed phrases (the law test scans this pool)                              */
/* ------------------------------------------------------------------------ */

// The source row carries an instant, not the author's timezone. A rolling
// age window therefore cannot prove that a hand happened on the author's
// local calendar day.
const WHEN = { recent: 'not long ago' } as const;
const CLOSER_ANSWER = 'I will post the answer in about six hours.';
const CLOSER_DID = 'I will post what I did in about six hours.';
const NUTS_QUESTION = 'What is the nuts here?';
const POT_ODDS_QUESTION = 'How much equity do I need to call?';
const WWYD_QUESTION = 'What would you do?';

/** Decision labels (options) and the words the explanation uses instead, so the explanation never repeats a label. */
const DECISION_LABEL: Record<string, string> = {
  fold: 'Fold',
  call: 'Call',
  raise: 'Raise',
  all_in: 'Move all in',
  check: 'Check',
  bet: 'Bet',
};
const DECISION_TOLD: Record<string, string> = {
  fold: 'I let it go',
  call: 'I paid it off',
  raise: 'I came over the top',
  all_in: 'I shoved the rest in',
  check: 'I knocked',
  bet: 'I fired',
};
const FACING_OPTIONS = ['fold', 'call', 'raise', 'all_in'] as const;
const OPEN_OPTIONS = ['check', 'bet', 'all_in'] as const;

/** Every fixed sentence and fragment horse-visible text is built from. */
export const TEMPLATE_POOL: readonly string[] = [
  WHEN.recent,
  CLOSER_ANSWER,
  CLOSER_DID,
  NUTS_QUESTION,
  POT_ODDS_QUESTION,
  WWYD_QUESTION,
  'Went to the river on this board {when} in {game}.',
  'Spot from {when} in {game}.',
  'a {stake} cash game',
  'a cash game',
  'a heads up cash game',
  'a tournament',
  'a game',
  'There is {pot} in the pot and I am facing a bet of {bet}.',
  'There is {pot} in the pot and I am facing a shove of {bet}.',
  'I had {mine} in on the river and got raised. The pot is {pot} and it is {call} to call.',
  'I had {mine} in on the river and got shoved on. The pot is {pot} and it is {call} to call.',
  'The pot is {pot} and it is {call} to call.',
  'On the river there is {pot} in the pot and it is {call} to call.',
  'On the river there is {pot} in the pot and it is on me to act.',
  'On the river I had {mine} in, now there is {pot} in the pot and it is {call} to call.',
  '{pct} percent, about {ratio} to 1',
  'The best hand this board allows is {hand}. {n} of the {enumerated} two card holdings makes it. Next best is {runner_up}, made by {m} holdings.',
  'Calling {call} to win a pot of {pot_after} means putting in {call} of the final {total}, which comes to {pct} percent. In odds that is about {ratio} to 1. With at least that much equity the call is fine over time.',
  '{told} and the hand went my way, up {net} big blinds.',
  '{told} and it went the other way, down {net} big blinds.',
  '{told} and finished the hand up {net} big blinds.',
  '{told} and finished the hand down {net} big blinds.',
  '{told} and that was the hand.',
  ...Object.values(DECISION_LABEL),
  ...Object.values(DECISION_TOLD),
];

/* ------------------------------------------------------------------------ */
/* Row reading                                                               */
/* ------------------------------------------------------------------------ */

/** A finite number, or null. Never a guess. Numeric columns arrive as strings from PostgREST. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Amounts as the row records them, without float noise: 4.78, 9.3, 419. */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Stakes only where the row can support the claim (the HandStory.ts stakeOf
 * rule): a whole-number half blind, cash only. Otherwise no stake is stated.
 */
function stakeOf(format: string | null, bigBlind: number | null): string | undefined {
  if (!bigBlind || format === 'tournament' || bigBlind < 1) return undefined;
  const sb = bigBlind / 2;
  if (!Number.isInteger(sb * 100)) return undefined;
  const f = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));
  return `${f(sb)}/${f(bigBlind)}`;
}

function gamePhrase(row: PuzzleReviewRow): string {
  const stake = stakeOf(row.format, num(row.big_blind));
  if (stake && (row.format === 'cash' || row.format === 'hu_cash')) return row.format === 'hu_cash' ? `a ${stake} heads up cash game` : `a ${stake} cash game`;
  if (row.format === 'cash') return 'a cash game';
  if (row.format === 'hu_cash') return 'a heads up cash game';
  if (row.format === 'tournament') return 'a tournament';
  return 'a game';
}

function whenPhrase(playedAt: string): string | null {
  const t = Date.parse(playedAt);
  if (!Number.isFinite(t)) return null;
  return WHEN.recent;
}

interface ActionEntry {
  seat?: unknown;
  stage?: unknown;
  action?: unknown;
  amount?: unknown;
  userId?: unknown;
  publicNode?: { pot?: unknown; currentBet?: unknown } | null;
}

const STREETS = ['preflop', 'flop', 'turn', 'river'] as const;
type Street = (typeof STREETS)[number];
const isStreet = (s: unknown): s is Street => typeof s === 'string' && (STREETS as readonly string[]).includes(s);
const VOLUNTARY = new Set(['fold', 'check', 'call', 'bet', 'raise', 'all_in']);
const AGGRESSIVE = new Set(['bet', 'raise', 'all_in']);

/** A river bet the horse had to answer: the pot before it, the chips it added, the chips the horse needed. */
interface FacedBet {
  action: string;
  pot: number;
  bet: number;
  call: number;
  /** The horse's own river chips before this bet (0 when it had not bet). */
  mine: number;
  /** The opponent's river chips before this bet (0 for a fresh bet). */
  theirs: number;
}

/** The horse's last river decision: what it faced and what it did. */
interface RiverDecision {
  action: string;
  facing: boolean;
  pot: number;
  call: number;
  mine: number;
}

interface RiverRead {
  faced: FacedBet[];
  decision: RiverDecision | null;
}

/**
 * Walk the action log and read the river from the horse's seat. The horse
 * is identified by its own user id or its seat; every other actor is an
 * opaque key that is compared and discarded. Null when the log cannot be
 * read (fail closed).
 */
function readRiver(row: PuzzleReviewRow, actions: unknown): RiverRead | null {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const horseId = typeof row.horse_user_id === 'string' && row.horse_user_id ? row.horse_user_id : null;
  const horseSeat = num(row.seat);
  if (horseId === null && horseSeat === null) return null;

  const isHorse = (a: ActionEntry): boolean =>
    (horseId !== null && a.userId === horseId) || (horseSeat !== null && num(a.seat) === horseSeat);
  const actorKey = (a: ActionEntry): string | null => {
    const seat = num(a.seat);
    if (seat !== null) return `seat:${seat}`;
    return typeof a.userId === 'string' && a.userId ? `user:${a.userId}` : null;
  };

  let horseFolded = false;
  let horseAllIn = false;
  let horseSawRiver = false;
  const contrib = new Map<string, number>();
  const faced: FacedBet[] = [];
  let facedAtDecision = 0;
  let decision: RiverDecision | null = null;
  let currentBet = 0;

  for (const raw of actions) {
    if (!raw || typeof raw !== 'object') return null;
    const a = raw as ActionEntry;
    const act = typeof a.action === 'string' ? a.action : '';
    if (!isStreet(a.stage)) continue;
    if (!VOLUNTARY.has(act)) continue;
    const mine = isHorse(a);
    if (a.stage !== 'river') {
      if (mine && act === 'fold') horseFolded = true;
      if (mine && act === 'all_in') horseAllIn = true;
      continue;
    }
    if (horseFolded || horseAllIn) break;
    horseSawRiver = true;
    const key = mine ? 'horse' : actorKey(a);
    if (key === null) return null;
    const amount = num(a.amount);
    const before = contrib.get(key) ?? 0;
    const horseBefore = contrib.get('horse') ?? 0;
    const pot = num(a.publicNode?.pot);

    if (mine) {
      const logged = num(a.publicNode?.currentBet);
      const standing = logged !== null ? Math.max(logged, currentBet) : currentBet;
      const call = round2(Math.max(0, standing - horseBefore));
      if (pot === null) return null;
      decision = { action: act, facing: call > 0, pot, call, mine: horseBefore };
      facedAtDecision = faced.length;
    } else if (AGGRESSIVE.has(act) && amount !== null && amount > before) {
      const bet = round2(amount - before);
      const call = round2(amount - horseBefore);
      if (call > 0 && pot !== null) faced.push({ action: act, pot, bet, call, mine: horseBefore, theirs: before });
    }

    if (act === 'fold') {
      if (mine) horseFolded = true;
    } else if (act === 'call' && amount !== null) {
      contrib.set(key, round2(before + amount));
    } else if (AGGRESSIVE.has(act) && amount !== null) {
      contrib.set(key, Math.max(before, amount));
      currentBet = Math.max(currentBet, amount);
    }
    if (mine && act === 'all_in') horseAllIn = true;
    if (mine && (act === 'fold' || act === 'all_in')) break;
  }
  if (!horseSawRiver) return { faced: [], decision: null };
  // A bet only counts as faced when the horse answered it on the river.
  return { faced: faced.slice(0, facedAtDecision), decision };
}

/* ------------------------------------------------------------------------ */
/* Composition                                                               */
/* ------------------------------------------------------------------------ */

function reject(rejected: string): ComposeResult {
  return { ok: false, rejected };
}

/** Options with the correct one at its deterministic slot and the decoys in their given order. */
function placeOptions(key: string, correct: string, decoys: string[]): { options: PuzzleOption[]; correct_option: OptionKey } | null {
  const labels = [correct, ...decoys];
  if (labels.length < 2 || labels.length > 4) return null;
  if (new Set(labels).size !== labels.length) return null;
  const slot = correctPosition(key, labels.length);
  const ordered = [...decoys];
  ordered.splice(slot, 0, correct);
  return {
    options: ordered.map((label, i) => ({ key: OPTION_KEYS[i]!, label })),
    correct_option: OPTION_KEYS[slot]!,
  };
}

function finish(
  kind: PuzzleKind,
  row: PuzzleReviewRow,
  board: Card[],
  salt: string,
  prompt: string,
  correct: string,
  decoys: string[],
  explanation: string,
  proof: Record<string, unknown>,
): ComposeResult {
  const key = puzzleKey(kind, row.hand_id);
  const placed = placeOptions(key, correct, decoys);
  if (!placed) return reject('labels_not_distinct');
  // The prompt never names the correct label (as written: "to call" in a
  // situation is not the option "Call"); the explanation never repeats it in
  // any case, because the reveal appends the label itself.
  if (prompt.includes(correct) || explanation.toLowerCase().includes(correct.toLowerCase())) return reject('answer_leaks');
  return {
    ok: true,
    puzzle: {
      kind,
      puzzle_key: key,
      hand_id: row.hand_id,
      source_review_id: row.id,
      game_variant: row.game_variant,
      board,
      prompt,
      options: placed.options,
      correct_option: placed.correct_option,
      explanation,
      salt,
      answer_commitment: commitmentFor(key, placed.correct_option, salt),
      proof,
      evaluator_version: EVALUATOR_VERSION,
      rewardable: kind === 'nuts' || kind === 'pot_odds',
      reveal_hours: REVEAL_HOURS,
    },
  };
}

function composeNuts(row: PuzzleReviewRow, board: Card[], salt: string, when: string): ComposeResult {
  const onBoard = evaluate5(board);
  if (onBoard.category === 'quads' || onBoard.category === 'straight_flush') return reject('nuts_on_board');
  const nuts = nutsOnBoard(board);
  const best = nuts.classes[0];
  if (!best || nuts.classes.length < 2 || best.holdings.length === nuts.enumerated) return reject('every_holding_ties');
  if (!best.exactLabel) return reject('nut_label_unclear');
  const decoyClasses: NutsClass[] = nuts.classes.slice(1).filter((c) => c.exactLabel).slice(0, 3);
  if (decoyClasses.length === 0) return reject('too_few_classes');
  const runnerUp = decoyClasses[0]!;

  const prompt = [
    `Went to the river on this board ${when} in ${gamePhrase(row)}.`,
    cardsLine('Board', board),
    `${NUTS_QUESTION} ${CLOSER_ANSWER}`,
  ].join('\n');
  const handOf = (label: string) => label.slice(label.indexOf(', for ') + 6);
  const n = best.holdings.length;
  const explanation =
    `The best hand this board allows is ${handOf(best.label)}. ${n} of the ${nuts.enumerated} two card holdings ${n === 1 ? 'makes' : 'make'} it. ` +
    `Next best is ${handOf(runnerUp.label)}, made by ${runnerUp.holdings.length} ${runnerUp.holdings.length === 1 ? 'holding' : 'holdings'}.`;
  const proof = {
    category: best.category,
    score: best.score,
    holdings: best.holdings,
    holdings_count: n,
    enumerated: nuts.enumerated,
    evaluator_version: EVALUATOR_VERSION,
    classes: nuts.classes.length,
    decoys: decoyClasses.map((c) => ({ category: c.category, holdings_count: c.holdings.length })),
  };
  return finish('nuts', row, board, salt, prompt, best.label, decoyClasses.map((c) => c.label), explanation, proof);
}

function composePotOdds(row: PuzzleReviewRow, board: Card[], salt: string, when: string): ComposeResult {
  const river = readRiver(row, row.actions);
  if (!river) return reject('actions_unreadable');
  if (river.faced.length === 0) return reject('no_river_bet_faced');
  // The largest bet the horse had to answer; the first of equals.
  const faced = river.faced.reduce((best, f) => (f.call > best.call ? f : best));
  const { pot, bet, call } = faced;
  if (pot <= 0 || bet <= 0 || call <= 0) return reject('pot_unreadable');

  const total = round2(pot + bet + call);
  const pct = (100 * call) / total;
  const ratio = (pot + bet) / call;
  const decoyValues = [(100 * bet) / pot, (100 * bet) / (pot + bet), pct / 2];
  const whole = [pct, ...decoyValues].map((x) => Math.round(x));
  if (new Set(whole).size !== whole.length) return reject('decoys_not_distinct');
  if (decoyValues.some((x) => x <= 0 || x >= 100)) return reject('decoy_out_of_range');
  const labelFor = (p: number, r: number) => `${Math.round(p)} percent, about ${r.toFixed(1)} to 1`;
  const correct = labelFor(pct, ratio);
  const decoys = decoyValues.map((x) => labelFor(x, (100 - x) / x));

  const fresh = faced.mine === 0 && faced.theirs === 0;
  const situation = fresh
    ? `There is ${fmt(pot)} in the pot and I am facing ${faced.action === 'all_in' ? 'a shove' : 'a bet'} of ${fmt(bet)}.`
    : faced.mine > 0
      ? `I had ${fmt(faced.mine)} in on the river and got ${faced.action === 'all_in' ? 'shoved on' : 'raised'}. The pot is ${fmt(pot + bet)} and it is ${fmt(call)} to call.`
      : `The pot is ${fmt(pot + bet)} and it is ${fmt(call)} to call.`;
  const prompt = [
    `Went to the river on this board ${when} in ${gamePhrase(row)}.`,
    cardsLine('Board', board),
    `${situation} ${POT_ODDS_QUESTION} ${CLOSER_ANSWER}`,
  ].join('\n');
  const explanation =
    `Calling ${fmt(call)} to win a pot of ${fmt(pot + bet)} means putting in ${fmt(call)} of the final ${fmt(total)}, which comes to ${pct.toFixed(1)} percent. ` +
    `In odds that is about ${ratio.toFixed(1)} to 1. With at least that much equity the call is fine over time.`;
  const proof = {
    river_action: faced.action,
    pot,
    bet,
    call,
    pot_after_bet: round2(pot + bet),
    final_pot: total,
    required_pct: Math.round(pct * 10) / 10,
    ratio_to_one: Math.round(ratio * 10) / 10,
    decoys: { bet_over_pot: whole[1], bet_over_pot_plus_bet: whole[2], half: whole[3] },
    evaluator_version: EVALUATOR_VERSION,
  };
  return finish('pot_odds', row, board, salt, prompt, correct, decoys, explanation, proof);
}

function composeWhatWouldYouDo(row: PuzzleReviewRow, board: Card[], salt: string, when: string): ComposeResult {
  const hole = cardsFromRow(row.hole_cards);
  if (!hole || hole.length !== 2) return reject('hole_cards_unreadable');
  const river = readRiver(row, row.actions);
  if (!river) return reject('actions_unreadable');
  const d = river.decision;
  if (!d) return reject('no_river_decision');
  const choices: readonly string[] = d.facing ? FACING_OPTIONS : OPEN_OPTIONS;
  if (!choices.includes(d.action)) return reject('river_decision_unreadable');
  const correct = DECISION_LABEL[d.action]!;
  const decoys = choices.filter((c) => c !== d.action).map((c) => DECISION_LABEL[c]!);

  const situation = d.facing
    ? d.mine > 0
      ? `On the river I had ${fmt(d.mine)} in, now there is ${fmt(d.pot)} in the pot and it is ${fmt(d.call)} to call.`
      : `On the river there is ${fmt(d.pot)} in the pot and it is ${fmt(d.call)} to call.`
    : `On the river there is ${fmt(d.pot)} in the pot and it is on me to act.`;
  const prompt = [
    `Spot from ${when} in ${gamePhrase(row)}.`,
    cardsLine('Hand', hole),
    cardsLine('Board', board),
    `${situation} ${WWYD_QUESTION} ${CLOSER_DID}`,
  ].join('\n');

  const told = DECISION_TOLD[d.action]!;
  const net = num(row.net_bb);
  const isWin = typeof row.is_win === 'boolean' ? row.is_win : null;
  let explanation: string;
  if (net !== null && isWin === true) explanation = `${told} and the hand went my way, up ${fmt(Math.abs(net))} big blinds.`;
  else if (net !== null && isWin === false) explanation = `${told} and it went the other way, down ${fmt(Math.abs(net))} big blinds.`;
  else if (net !== null) explanation = `${told} and finished the hand ${net >= 0 ? 'up' : 'down'} ${fmt(Math.abs(net))} big blinds.`;
  else explanation = `${told} and that was the hand.`;
  const proof = {
    action: d.action,
    facing: d.facing,
    pot: d.pot,
    to_call: d.call,
    horse_river_chips_before: d.mine,
    net_bb: net,
    is_win: isWin,
    evaluator_version: EVALUATOR_VERSION,
  };
  return finish('what_would_you_do', row, board, salt, prompt, correct, decoys, explanation, proof);
}

/**
 * One puzzle of `kind` from one row, or the reason there is none. Never
 * throws on row content: anything unreadable is a rejection, counted by the
 * route per reason.
 */
export function composePuzzle(kind: PuzzleKind, row: PuzzleReviewRow, opts: { salt: string; now: Date }): ComposeResult {
  if (!PUZZLE_KINDS.includes(kind)) return reject('unknown_kind');
  if (!row || typeof row !== 'object') return reject('row_unreadable');
  if (typeof row.hand_id !== 'string' || !row.hand_id) return reject('hand_id_missing');
  if (typeof opts?.salt !== 'string' || !opts.salt) return reject('salt_missing');
  if (row.game_variant !== 'nlh') return reject('variant_not_nlh');
  if (!Array.isArray(row.board)) return reject('board_unreadable');
  if (row.board.length !== 5) return reject('board_not_five_cards');
  const board = cardsFromRow(row.board);
  if (!board) return reject('board_unreadable');
  const when = whenPhrase(row.played_at);
  if (!when) return reject('played_at_unreadable');
  switch (kind) {
    case 'nuts':
      return composeNuts(row, board, opts.salt, when);
    case 'pot_odds':
      return composePotOdds(row, board, opts.salt, when);
    case 'what_would_you_do':
      return composeWhatWouldYouDo(row, board, opts.salt, when);
  }
}
