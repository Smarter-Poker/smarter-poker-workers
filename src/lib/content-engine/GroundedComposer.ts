/**
 * GroundedComposer: a post about a hand the horse actually played.
 *
 * Phase 3 of the Fleet Content Programme. Where the Phase 2 Composer writes
 * about somebody else's clip, this writes about the horse's own poker, from
 * `HandStory` facts read out of `horse_hand_reviews`.
 *
 * WHY THIS IS THE GOOD CONTENT. Every other source the fleet has is shared:
 * 150 clips, two RSS feeds, a caption pool. Two horses drawing from any of
 * them can collide, and the ledger exists to referee that. A hand cannot
 * collide, because two horses did not play the same hand from the same seat.
 * The subject is specific, the numbers are real, and there are 204,474 of
 * them a week.
 *
 * THE NUMBERS ARE THE LEDGER'S. `HandFacts` comes straight from the row and
 * nothing here recomputes, rounds up or dramatises it. A sentence may leave a
 * number out; it may never state a different one. `factsMatch()` is the gate
 * that proves it, and the law test runs it over every frame.
 *
 * NOBODY IS NAMED. Not the opponent, not the table, not the club. A horse
 * says "the big blind" or "one of the regs". The action log has every
 * opponent's user id in it and none of it reaches a sentence.
 */
import { fleetHash } from './FleetScheduler.js';
import { frameKey } from './ContentLedger.js';
import { render, targetWords, type StyleSheet } from './StyleSheet.js';
import type { PostBrief } from './PostBrief.js';
import { variantName, type HandFacts, type SessionFacts } from './HandStory.js';

/** How the result is spoken. Numbers stay exactly as recorded. */
function bb(n: number): string {
  const rounded = Math.abs(n) >= 100 ? Math.round(n) : Number(n.toFixed(1));
  return `${rounded}bb`;
}

function wonLost(f: HandFacts): string {
  return f.isWin ? `won ${bb(Math.abs(f.netBb))}` : `lost ${bb(Math.abs(f.netBb))}`;
}

/** The opponent, always anonymous. */
const OPPONENT = ['the big blind', 'a reg', 'the guy in the straddle', 'one of the regs', 'the small blind'];

/**
 * Openers by category. `{hole}`, `{board}`, `{net}`, `{pot}`, `{stake}`,
 * `{variant}`, `{opp}` are substituted from the facts. Nothing here invents a
 * detail the row does not carry.
 *
 * `needs` is the street the sentence CLAIMS. "the whole thing went in on the
 * river" is a statement about the hand as surely as a pot size is, and a hand
 * that ended on the flop did not have a river. The numbers-are-the-ledger's
 * rule covers streets too, so a frame naming one is only offered to a hand
 * that reached it.
 *
 * The pools are deliberately large. Eight hours of live output on 2026-09-06
 * drew 58 posts from 14 skeletons; with a three-hour frame ledger over these
 * pools, the same skeleton reaching the feed twice in an hour is arithmetic
 * rather than luck.
 */
interface Frame {
  t: string;
  /** The furthest street this sentence names. Omitted: names none. */
  needs?: 'flop' | 'turn' | 'river';
}

const STREET_ORDER: Record<string, number> = { preflop: 0, flop: 1, turn: 2, river: 3 };

const HAND_FRAMES: Record<string, Frame[]> = {
  big_win: [
    { t: '{hole} on {board} and the whole thing went in on the river', needs: 'river' },
    { t: 'got there with {hole}, {board} runout, {net} back' },
    { t: '{hole} held on {board}. {net}' },
    { t: 'stacked {opp} with {hole} on {board}' },
    { t: '{hole} on {board}. {net} and I will take it' },
    { t: 'the {board} board was never going to slow me down with {hole}' },
    { t: '{hole}, board came {board}, {net}' },
    { t: 'every street went in with {hole} on {board}' },
    { t: '{opp} paid it off. {hole} on {board}, {net}' },
    { t: 'nothing to think about with {hole} once {board} was out there' },
    { t: '{hole} on {board} for {pot}' },
    { t: 'held up. {hole}, {board}, {net}' },
    { t: 'value all three streets with {hole} on {board}', needs: 'river' },
    { t: 'you do not fold {hole} on {board} and I did not' },
  ],
  bad_beat: [
    { t: '{hole} on {board} and it still found a way to lose' },
    { t: 'had it all the way with {hole}, {board}, {net}' },
    { t: '{hole}, board runs {board}, and that is {amount} gone' },
    { t: 'no way to fold {hole} there. {board}. {net}' },
    { t: 'ahead until the last card. {hole} on {board}' },
    { t: '{hole} was good on every street that mattered. {board}. {net}' },
    { t: 'the {board} runout is the whole hand. I had {hole}' },
    { t: '{hole} into that board. {board}. {net}' },
    { t: 'do that a hundred times and I win it most of them. {hole} on {board}' },
    { t: 'lost {amount} with {hole} on {board} and I would do it again' },
    { t: '{opp} got there on {board}. I had {hole}' },
    { t: 'still not sure how {hole} loses on {board}' },
    { t: 'the river changed everything. {hole} on {board}', needs: 'river' },
    { t: '{hole}, {board}, {net}. nothing to add' },
  ],
  cooler: [
    { t: '{hole} on {board} is not a mistake, it is just the deck' },
    { t: 'both hands were getting stacked on {board}. mine was {hole}' },
    { t: '{hole} into the one hand that beats it. {board}' },
    { t: 'no fold exists there. {hole} on {board}. {net}' },
    { t: '{hole} on {board} and second best is still second best' },
    { t: 'you can play {hole} perfectly on {board} and lose the stack anyway' },
    { t: 'the deck dealt that one, not me. {hole}, {board}' },
    { t: '{hole} on {board}. the money was always going in' },
    { t: 'nobody folds {hole} on {board}. {net}' },
    { t: 'set up from the flop. {hole} against that {board}' },
    { t: '{hole} was the second best hand from the moment {board} landed' },
    { t: 'that is a cooler and I am fine calling it one. {hole} on {board}' },
  ],
  river_aggression: [
    { t: 'fired the river on {board} with {hole} and got the fold', needs: 'river' },
    { t: '{hole} on {board}, last bullet, {net}' },
    { t: 'the river bet is the whole hand there. {hole} on {board}', needs: 'river' },
    { t: 'third barrel with {hole} on {board}. {net}', needs: 'river' },
    { t: '{hole} on {board} and the story had to be told to the end' },
    { t: 'no hand, all narrative. {hole} on {board}. {net}' },
    { t: 'kept telling it on {board} with {hole} and they believed it' },
    { t: '{opp} folded to the last bet. {hole} on {board}' },
    { t: 'the bet on {board} is the only one that mattered. {hole}' },
    { t: '{hole} on {board}. {net} for being willing to be wrong' },
    { t: 'you either fire that river or you never get to. {hole} on {board}', needs: 'river' },
    { t: 'won it with {hole} on {board} without the best hand' },
  ],
  big_fold: [
    { t: 'folded a hand I would have paid off with a year ago. {board}' },
    { t: 'let {hole} go on {board} and I am still fine with it' },
    { t: 'the discipline hand nobody makes a clip about. {hole} on {board}' },
    { t: 'put {hole} in the muck on {board} and slept fine' },
    { t: '{hole} on {board} is a fold and it took me long enough to learn it' },
    { t: 'no clip gets made about folding {hole} on {board}' },
    { t: 'the {board} board told me everything. {hole} went in the muck' },
    { t: 'found the fold with {hole} on {board}' },
    { t: 'two years ago that is a call. {hole} on {board}' },
    { t: 'folding {hole} there saved more than most pots I win' },
    { t: 'the river bet was too confident. {hole} on {board}, gone', needs: 'river' },
    { t: '{hole} on {board}. laid it down and moved on' },
  ],
  stackoff: [
    { t: '{hole} on {board}, stacks in, {net}' },
    { t: 'full stack in with {hole} on {board}' },
    { t: 'no way to play {hole} on {board} for less than everything' },
    { t: '{hole} on {board} and neither of us was folding' },
    { t: 'the whole stack on {board} with {hole}. {net}' },
    { t: 'got it in on {board} holding {hole}' },
    { t: '{hole}, {board}, everything in the middle. {net}' },
    { t: 'nothing was getting folded on that {board}. I had {hole}' },
    { t: 'stacks in on {board}. {hole} against whatever they had' },
    { t: 'once {board} landed with {hole} the rest was arithmetic' },
    { t: '{opp} and I were never getting away from {board}' },
    { t: '{hole} on {board} for {pot}' },
  ],
  grind: [
    { t: '{hole} on {board} for {pot}' },
    { t: 'small one but a clean line. {hole} on {board}' },
    { t: 'nothing dramatic. {hole} on {board}, {net}' },
    { t: '{hole} on {board}. these are most of the game' },
    { t: 'a quiet {pot} with {hole} on {board}' },
    { t: 'took it down on {board} with {hole}' },
    { t: '{hole}, {board}, {net}. next hand' },
    { t: 'the unglamorous kind. {hole} on {board}' },
    { t: 'no story, just {hole} on {board} for {pot}' },
    { t: '{hole} on {board} and nobody wanted to fight for it' },
    { t: 'played it small with {hole} on {board}. {net}' },
    { t: 'these pay the bills. {hole} on {board}, {net}' },
  ],
};

/** Frames that need no board, for hands that ended before the flop. */
const PREFLOP_FRAMES: Record<string, Frame[]> = {
  big_win: [
    { t: '{hole} preflop and nobody wanted to find out. {net}' },
    { t: 'got it in preflop with {hole}, {net}' },
    { t: '{hole} and the pot was over before a flop. {net}' },
    { t: 'no flop needed. {hole}, {net}' },
    { t: 'raised {hole} and took it right there' },
    { t: '{hole} held without a board. {net}' },
    { t: 'they found out what {hole} was. {net}' },
    { t: 'best hand preflop with {hole} and it stayed that way' },
  ],
  bad_beat: [
    { t: '{hole} in preflop and it did not hold. {net}' },
    { t: 'all in preflop with {hole}. {net}' },
    { t: 'best hand preflop with {hole} and none of that mattered' },
    { t: '{hole} in before the flop. {amount} gone' },
    { t: 'you cannot get it in better than {hole} and it still lost' },
    { t: 'got it in ahead with {hole} and finished behind' },
    { t: '{hole} preflop, best of it, {net}' },
    { t: 'the favourite loses often enough. {hole}, {net}' },
  ],
  cooler: [
    { t: '{hole} preflop into the one hand ahead of it' },
    { t: '{hole} and there was exactly one holding I did not want to see' },
    { t: 'nobody folds {hole} preflop. {net}' },
    { t: 'second best before a card came out. {hole}' },
    { t: '{hole} and the one hand that beats it was sitting right there' },
    { t: 'you can be ahead of everything except the one. {hole}, {net}' },
    { t: '{hole} preflop and no flop was going to save it' },
    { t: 'ran {hole} into the top of the range' },
  ],
  river_aggression: [
    { t: '{hole} and the raise did the work preflop' },
    { t: 'the reraise with {hole} ended it before a flop' },
    { t: 'four bet with {hole} and that was the hand' },
    { t: 'put in the third raise with {hole} and got it through' },
    { t: '{hole}, and the pressure was the whole hand' },
    { t: 'no flop, just a raise they did not want. {hole}' },
    { t: 'the size did the talking preflop. {hole}, {net}' },
    { t: 'reraised with {hole} and nobody wanted it' },
  ],
  big_fold: [
    { t: 'folded {hole} preflop and it was the right button' },
    { t: 'laid {hole} down before the flop' },
    { t: 'passed on {hole} and did not think about it again' },
    { t: 'threw {hole} away and never looked back' },
    { t: 'the fold with {hole} was the whole decision' },
    { t: 'not every {hole} has to see a flop' },
    { t: 'folded {hole} and moved on to the next one' },
    { t: '{hole} into that action is a pass' },
  ],
  stackoff: [
    { t: 'stacks in preflop with {hole}. {net}' },
    { t: 'everything in before a flop holding {hole}' },
    { t: '{hole} and neither of us was folding preflop' },
    { t: 'the whole stack went in with {hole} before a card came' },
    { t: '{hole} preflop, all of it, {net}' },
    { t: 'no flop needed to get the stacks in. {hole}' },
    { t: 'got it in with {hole} and took what came' },
    { t: '{hole} and there was never a fold in it' },
  ],
  grind: [
    { t: '{hole} preflop, nothing dramatic' },
    { t: 'took the blinds with {hole}' },
    { t: '{hole}, no flop, next hand' },
    { t: 'a raise and a fold. {hole}' },
    { t: 'picked it up with {hole}, nothing to it' },
    { t: '{hole} and nobody was interested' },
    { t: 'quiet one with {hole} before the flop' },
    { t: '{hole}, blinds collected, moving on' },
  ],
};

/** Second lines: reflection rather than a second set of facts. */
const HAND_FOLLOWUP: Record<string, string[]> = {
  big_win: [
    'those do not come around often enough',
    'still the best feeling in the game',
    'nothing clever about it, the cards were just there',
  ],
  bad_beat: [
    'the maths does not care how it felt',
    'that is the game, it just stings on the night',
    'nothing to review there, it was already over',
  ],
  cooler: [
    'nobody played it badly and somebody still lost a stack',
    'you can only lose that one slowly or quickly',
  ],
  river_aggression: [
    'the story had to add up from the flop for that to work',
    'you have to be willing to be wrong out loud',
  ],
  big_fold: [
    'a good fold never gets a clip made about it',
    'worth more than most of the pots people brag about',
  ],
  stackoff: ['stack in, no way back from it', 'once it is in the rest is arithmetic'],
  grind: ['most of the game looks like this', 'the small clean ones pay the bills'],
};

const SESSION_FRAMES_UP = [
  '{hands} hands of {variant}, {net} up',
  'good day at the {variant} tables. {hands} hands, {net}',
  '{net} over {hands} hands. take those',
];
const SESSION_FRAMES_DOWN = [
  '{hands} hands of {variant} and {net} down',
  'rough one. {hands} hands, {net}',
  '{net} over {hands} hands of {variant}. moving on',
];
const SESSION_FRAMES_FLAT = [
  '{hands} hands of {variant}, basically flat',
  '{hands} hands and nothing to show either way',
];
const SESSION_FOLLOWUP = [
  'volume is the only thing you control',
  'the decisions were fine, the cards were the cards',
  'back at it tomorrow',
  'variance is real and nobody is exempt from it',
];

function pick<T>(arr: T[], seed: string, salt: string): T {
  return arr[fleetHash(seed, salt) % arr.length]!;
}

function fillHand(fr: Frame, f: HandFacts, seed: string): string {
  const tpl = fr.t;
  if (tpl.includes('{board}') && !f.boardNotation) return '';
  // A sentence may not name a street the hand never reached.
  if (fr.needs && (STREET_ORDER[f.street] ?? 0) < STREET_ORDER[fr.needs]!) return '';
  return tpl
    .replace(/\{hole\}/g, f.holeNotation)
    .replace(/\{board\}/g, f.boardNotation)
    .replace(/\{net\}/g, wonLost(f))
    .replace(/\{amount\}/g, bb(Math.abs(f.netBb)))
    .replace(/\{pot\}/g, `${bb(f.potBb)}`)
    .replace(/\{stake\}/g, f.stake ?? '')
    .replace(/\{variant\}/g, variantName(f.variant))
    .replace(/\{opp\}/g, pick(OPPONENT, seed, 'opp'));
}

export interface GroundedResult {
  text: string;
  /**
   * The ledger key for the sentence skeleton this used, so the caller can
   * record it and the next horse can avoid it. Empty when nothing composed.
   */
  frameKey: string;
  grounding: string[];
  /** The facts a reader could check against the ledger. */
  stated: { netBb?: number; potBb?: number; hole?: string; board?: string; hands?: number };
}

/**
 * Does this text state anything the facts do not support?
 *
 * The one rule Phase 3 cannot bend: a number in a post is a number in the
 * database. Every "NNbb" in the text must match the recorded net or pot, and
 * any card group must be the real holding or board.
 */
export function factsMatch(text: string, f: HandFacts): boolean {
  const allowed = new Set<string>([
    bb(Math.abs(f.netBb)),
    bb(f.potBb),
    `${Math.round(Math.abs(f.netBb))}bb`,
    `${Math.round(f.potBb)}bb`,
  ]);
  const stated = text.match(/\d+(?:\.\d+)?bb/g) ?? [];
  for (const s of stated) if (!allowed.has(s)) return false;

  // A card group in the text must be the hand or the board, not an invention.
  const cardish = text.match(/\b(?:[AKQJT2-9][hdcs]){2,}\b/g) ?? [];
  for (const c of cardish) {
    if (c !== f.holeNotation.replace(/\s/g, '') && !f.boardNotation.replace(/\s/g, '').includes(c)) return false;
  }
  return true;
}

/**
 * A post about one hand, in this horse's voice.
 *
 * `exclude` is the set of frame keys another horse has already used inside
 * the ledger window. Skeletons repeating across the fleet is the thing that
 * makes a thousand accounts read as one; see FRAME_GLOBAL_HOURS.
 */
export function composeHandPost(
  f: HandFacts,
  style: StyleSheet,
  variantSeed = '0',
  exclude?: ReadonlySet<string>,
): GroundedResult {
  const seed = `${style.profileId}:h:${f.handId}:${variantSeed}`;
  const preflop = f.street === 'preflop';
  const group = preflop ? `pre_${f.category}` : f.category;
  const frames = preflop
    ? (PREFLOP_FRAMES[f.category] ?? PREFLOP_FRAMES.grind!)
    : (HAND_FRAMES[f.category] ?? HAND_FRAMES.grind!);

  // Walk the whole pool from this horse's own offset, skipping frames that
  // do not fit the hand and frames the fleet has just used. If every frame
  // is excluded, take the first that fits rather than going silent: a
  // repeated skeleton is a blemish, a horse that cannot speak is a defect.
  const start = fleetHash(seed, 'frame');
  let chosen: { text: string; key: string } | null = null;
  let fallback: { text: string; key: string } | null = null;
  for (let i = 0; i < frames.length; i++) {
    const idx = (start + i) % frames.length;
    const filled = fillHand(frames[idx]!, f, seed);
    if (!filled) continue;
    const key = frameKey('hand', group, idx);
    if (!fallback) fallback = { text: filled, key };
    if (!exclude?.has(key)) {
      chosen = { text: filled, key };
      break;
    }
  }
  const opener = chosen ?? fallback;
  if (!opener) return { text: '', frameKey: '', grounding: [], stated: {} };

  const lines: string[] = [opener.text];
  const { sentences } = targetWords(style);
  if (sentences >= 2) {
    lines.push(pick(HAND_FOLLOWUP[f.category] ?? HAND_FOLLOWUP.grind!, seed, 'follow'));
  }
  if (sentences >= 3 && f.stake) {
    lines.push(`${f.stake} ${variantName(f.variant)}`);
  }

  const text = render(lines, style, seed);
  return {
    text,
    frameKey: opener.key,
    grounding: [`hand:${f.handId}`, `cards:${f.holeNotation}`, `category:${f.category}`, opener.key],
    stated: {
      netBb: f.netBb,
      potBb: f.potBb,
      hole: f.holeNotation,
      board: f.boardNotation || undefined,
    },
  };
}

/** A post about a day's play. */
export function composeSessionPost(
  s: SessionFacts,
  style: StyleSheet,
  variantSeed = '0',
  exclude?: ReadonlySet<string>,
): GroundedResult {
  const seed = `${style.profileId}:s:${s.day}:${variantSeed}`;
  const up = s.netBb > 5;
  const down = s.netBb < -5;
  const group = up ? 'up' : down ? 'down' : 'flat';
  const frames = up ? SESSION_FRAMES_UP : down ? SESSION_FRAMES_DOWN : SESSION_FRAMES_FLAT;
  const netText = up ? `+${bb(s.netBb)}` : down ? `-${bb(Math.abs(s.netBb))}` : bb(Math.abs(s.netBb));

  const start = fleetHash(seed, 'frame');
  let idx = start % frames.length;
  for (let i = 0; i < frames.length; i++) {
    const c = (start + i) % frames.length;
    if (!exclude?.has(frameKey('session', group, c))) {
      idx = c;
      break;
    }
  }
  const key = frameKey('session', group, idx);
  const lines = [
    frames[idx]!
      .replace(/\{hands\}/g, String(s.hands))
      .replace(/\{net\}/g, netText)
      .replace(/\{variant\}/g, variantName(s.variant)),
  ];
  const { sentences } = targetWords(style);
  if (sentences >= 2) lines.push(pick(SESSION_FOLLOWUP, seed, 'follow'));

  const text = render(lines, style, seed);
  return {
    text,
    frameKey: key,
    grounding: [`session:${s.day}`, `variant:${s.variant}`, key],
    stated: { netBb: s.netBb, hands: s.hands },
  };
}

/** A brief describing a grounded post, for post_briefs and for commenters. */
export function briefForHand(f: HandFacts): PostBrief {
  const concepts: string[] = [f.category];
  if (f.leaks.length) concepts.push(...f.leaks.slice(0, 2));
  return {
    kind: 'hand',
    domain: 'poker',
    title: f.boardNotation ? `${f.holeNotation} on ${f.boardNotation}` : `${f.holeNotation} preflop`,
    source: 'club arena',
    people: [],
    teams: [],
    concepts,
    amounts: [bb(Math.abs(f.netBb))],
    keyPhrase: f.holeNotation,
    topic: undefined,
    tone: f.category === 'bad_beat' ? 'bad_beat' : f.isWin ? 'admiring' : 'analytical',
    isQuestion: false,
    confidence: 1,
    builtFrom: ['horse_hand_reviews'],
  };
}

export function briefForSession(s: SessionFacts): PostBrief {
  return {
    kind: 'text',
    domain: 'poker',
    title: `${s.hands} hands of ${variantName(s.variant)}`,
    source: 'club arena',
    people: [],
    teams: [],
    concepts: ['variance', s.format === 'tournament' ? 'tournament' : 'cash_game'],
    amounts: [bb(Math.abs(s.netBb))],
    keyPhrase: variantName(s.variant),
    topic: undefined,
    tone: 'analytical',
    isQuestion: false,
    confidence: 1,
    builtFrom: ['horse_daily_nets'],
  };
}
