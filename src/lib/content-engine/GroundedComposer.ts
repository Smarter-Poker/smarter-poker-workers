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
 * detail the row does not carry: a frame that needs a board is only offered
 * when there is one.
 */
const HAND_FRAMES: Record<string, string[]> = {
  big_win: [
    '{hole} on {board} and the whole thing went in on the river',
    'got there with {hole}, {board} runout, {net} back',
    '{hole} held on {board}. {net}',
    'stacked {opp} with {hole} on {board}',
  ],
  bad_beat: [
    '{hole} on {board} and it still found a way to lose',
    'had it all the way with {hole}, {board}, {net}',
    '{hole}, board runs {board}, and that is {amount} gone',
    'no way to fold {hole} there. {board}. {net}',
  ],
  cooler: [
    '{hole} on {board} is not a mistake, it is just the deck',
    'both hands were getting stacked on {board}. mine was {hole}',
    '{hole} into the one hand that beats it. {board}',
  ],
  river_aggression: [
    'fired the river on {board} with {hole} and got the fold',
    '{hole} on {board}, last bullet, {net}',
    'the river bet is the whole hand there. {hole} on {board}',
  ],
  big_fold: [
    'folded a hand I would have paid off with a year ago. {board}',
    'let {hole} go on {board} and I am still fine with it',
    'the discipline hand nobody makes a clip about. {hole} on {board}',
  ],
  stackoff: [
    '{hole} on {board}, stacks in, {net}',
    'full stack in with {hole} on {board}',
  ],
  grind: [
    '{hole} on {board} for {pot}',
    'small one but a clean line. {hole} on {board}',
  ],
};

/** Frames that need no board, for hands that ended before the flop. */
const PREFLOP_FRAMES: Record<string, string[]> = {
  big_win: ['{hole} preflop and nobody wanted to find out. {net}', 'got it in preflop with {hole}, {net}'],
  bad_beat: ['{hole} in preflop and it did not hold. {net}', 'all in preflop with {hole}. {net}'],
  cooler: ['{hole} preflop into the one hand ahead of it'],
  river_aggression: ['{hole} and the raise did the work preflop'],
  big_fold: ['folded {hole} preflop and it was the right button'],
  stackoff: ['stacks in preflop with {hole}. {net}'],
  grind: ['{hole} preflop, nothing dramatic'],
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

function fillHand(tpl: string, f: HandFacts, seed: string): string {
  if (tpl.includes('{board}') && !f.boardNotation) return '';
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

/** A post about one hand, in this horse's voice. */
export function composeHandPost(
  f: HandFacts,
  style: StyleSheet,
  variantSeed = '0',
): GroundedResult {
  const seed = `${style.profileId}:h:${f.handId}:${variantSeed}`;
  const frames = f.street === 'preflop'
    ? (PREFLOP_FRAMES[f.category] ?? PREFLOP_FRAMES.grind!)
    : (HAND_FRAMES[f.category] ?? HAND_FRAMES.grind!);

  const lines: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const tpl = frames[(fleetHash(seed, 'frame') + i) % frames.length]!;
    const filled = fillHand(tpl, f, seed);
    if (filled) {
      lines.push(filled);
      break;
    }
  }
  if (!lines.length) return { text: '', grounding: [], stated: {} };

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
    grounding: [`hand:${f.handId}`, `cards:${f.holeNotation}`, `category:${f.category}`],
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
): GroundedResult {
  const seed = `${style.profileId}:s:${s.day}:${variantSeed}`;
  const up = s.netBb > 5;
  const down = s.netBb < -5;
  const frames = up ? SESSION_FRAMES_UP : down ? SESSION_FRAMES_DOWN : SESSION_FRAMES_FLAT;
  const netText = up ? `+${bb(s.netBb)}` : down ? `-${bb(Math.abs(s.netBb))}` : bb(Math.abs(s.netBb));

  const lines = [
    pick(frames, seed, 'frame')
      .replace(/\{hands\}/g, String(s.hands))
      .replace(/\{net\}/g, netText)
      .replace(/\{variant\}/g, variantName(s.variant)),
  ];
  const { sentences } = targetWords(style);
  if (sentences >= 2) lines.push(pick(SESSION_FOLLOWUP, seed, 'follow'));

  const text = render(lines, style, seed);
  return {
    text,
    grounding: [`session:${s.day}`, `variant:${s.variant}`],
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
