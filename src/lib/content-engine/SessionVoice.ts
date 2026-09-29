/**
 * SessionVoice - a day at the tables, said the way a player says it.
 *
 * WHAT THIS REPLACES (2026-09-21 recertification, P3C-11). The only session
 * writer was GroundedComposer.composeSessionPost run through StyleSheet, and
 * on 21 real days it produced lines like
 *
 *   "Rough one. 1684 hands, -2040bb."
 *   "The interesting part, 5894 hands of PLO8 and -854bb down."
 *
 * A column name for money, a hand count no person plays in a day, and a
 * filler opener in front of it. Nobody posts their day like that.
 *
 * THE RULES are HandVoice's rules:
 *
 * 1. Every word comes from this file. The only inputs that choose words are
 *    the variant, the format and the sign and size of the result, and each of
 *    those selects a phrase written here, so no name, username or row text can
 *    reach a sentence.
 * 2. No numbers at all: no big blinds, no hand counts, no stat line.
 * 3. No StyleSheet: no openers, no closers, no questions tacked on the end.
 * 4. Nothing the row does not carry. A day that went up is "a good day";
 *    tournament results are CHIPS, never money, because a day of chips won in
 *    tournament hands says nothing about what the player cashed for.
 *
 * `sessionLineMatches` checks the finished sentence again, so a template that
 * forgets its gate still cannot publish the claim.
 */
import type { SessionFacts } from './HandStory.js';
import type { PostBrief } from './PostBrief.js';
import { fleetHash } from './FleetScheduler.js';

/**
 * The game, as a player names it. Only what the variant code proves: plo5
 * and plo6 deal five and six cards (checked against production hole-card
 * counts, 2026-09-21), and plo8 is said as PLO and flo8 as limit Omaha
 * because nothing in the row says more than that.
 */
const GAME_WORDS: Record<string, string> = {
  nlh: 'no limit hold\'em',
  flh: 'limit hold\'em',
  plo4: 'PLO',
  plo5: 'five-card PLO',
  plo6: 'six-card PLO',
  plo8: 'PLO',
  flo8: 'limit Omaha',
  short_deck: 'short deck',
  pineapple: 'pineapple',
};

export type SessionGroup = 'up' | 'down' | 'flat';

/** Within five big blinds either way is a day that went nowhere. */
export function sessionGroup(s: SessionFacts): SessionGroup {
  if (s.netBb > 5) return 'up';
  if (s.netBb < -5) return 'down';
  return 'flat';
}

export function sayGame(s: SessionFacts): string | null {
  return GAME_WORDS[s.variant] ?? null;
}

interface Spoken {
  game: string | null;
}

type When = (s: SessionFacts) => boolean;
const all = (...ws: When[]): When => (s) => ws.every((w) => w(s));
const tourney: When = (s) => s.format === 'tournament';
const cash: When = (s) => s.format !== 'tournament';
const headsUp: When = (s) => s.format === 'hu_cash';
const mag = (s: SessionFacts) => Math.abs(s.netBb);
/** Under fifty big blinds, either way. */
const slight: When = (s) => mag(s) < 50;
/** Fifty or more. */
const real: When = (s) => mag(s) >= 50;
/** Three hundred or more. */
const big: When = (s) => mag(s) >= 300;

interface Line {
  t: string;
  needs: Array<keyof Spoken>;
  when?: When;
}

const LINES: Record<SessionGroup, Line[]> = {
  up: [
    { t: 'Good day at the {game} tables.', needs: ['game'], when: all(cash, real) },
    { t: 'Booked a small win at the {game} tables.', needs: ['game'], when: all(cash, slight) },
    { t: 'Big day at the {game} tables. I\'ll take it.', needs: ['game'], when: all(cash, big) },
    { t: 'The {game} tables were good to me.', needs: ['game'], when: all(cash, real) },
    { t: 'Finished up on the day. Happy with that.', needs: [], when: cash },
    { t: 'Up on the day. Nothing more to add.', needs: [], when: cash },
    { t: 'Nice day of {game}. Booked a win.', needs: ['game'], when: cash },
    { t: 'Heads-up went my way.', needs: [], when: all(headsUp, real) },
    { t: 'Left the tables up. That\'s how you want a day to end.', needs: [], when: cash },
    { t: 'Picked up chips in the {game} tournaments.', needs: ['game'], when: tourney },
    { t: 'The {game} tournaments were kind to my stack.', needs: ['game'], when: all(tourney, real) },
    { t: 'Chipped up in the {game} tournaments.', needs: ['game'], when: all(tourney, real) },
    { t: 'Added a few chips in the {game} tournaments.', needs: ['game'], when: all(tourney, slight) },
    { t: 'Small step forward in the {game} tournaments.', needs: ['game'], when: all(tourney, slight) },
  ],
  down: [
    { t: 'Rough day at the {game} tables.', needs: ['game'], when: all(cash, real) },
    { t: 'Brutal day at the {game} tables. Back at it next time.', needs: ['game'], when: all(cash, big) },
    { t: 'Lost a little at the {game} tables.', needs: ['game'], when: all(cash, slight) },
    { t: 'Not my day at the {game} tables.', needs: ['game'], when: all(cash, real) },
    { t: 'Down on the day. It happens.', needs: [], when: cash },
    { t: 'The {game} tables got the better of me.', needs: ['game'], when: all(cash, real) },
    { t: 'Heads-up didn\'t go my way.', needs: [], when: all(headsUp, real) },
    { t: 'Losing day. Not every day at the tables is a good one.', needs: [], when: cash },
    { t: 'Took a hit at the {game} tables. On to the next session.', needs: ['game'], when: all(cash, real) },
    { t: 'Finished down in {game}. Reset and go again.', needs: ['game'], when: cash },
    { t: 'Lost chips in the {game} tournaments.', needs: ['game'], when: tourney },
    { t: 'The {game} tournaments didn\'t go my way.', needs: ['game'], when: all(tourney, real) },
    { t: 'Tough day in the tournaments. Chips went the wrong way.', needs: [], when: all(tourney, real) },
    { t: 'Gave back a few chips in the {game} tournaments.', needs: ['game'], when: all(tourney, slight) },
    { t: 'Small dip in the {game} tournaments. Nothing dramatic.', needs: ['game'], when: all(tourney, slight) },
  ],
  flat: [
    { t: 'Basically broke even at the {game} tables.', needs: ['game'], when: cash },
    { t: 'Went nowhere at the {game} tables.', needs: ['game'], when: cash },
    { t: 'Ended about where I started in {game}.', needs: ['game'] },
    { t: 'Flat day. Some days are like that.', needs: [] },
    { t: 'Finished about even in the {game} tournaments.', needs: ['game'], when: tourney },
    { t: 'Broke even on the day. Could be worse.', needs: [], when: cash },
  ],
};

const EMOJI = /\p{Extended_Pictographic}/u;
const DASHES = /[\u2013\u2014]/;
const FILLER_OPENER = /^(?:look|nah|okay|ok|well|honestly|so|yeah|lol|ngl|fair enough|for me|one thing|the thing is|what gets me|on another watch|the interesting part|the part i keep|the detail worth|i keep coming back|rough one)\b/i;
const BACKSTORY = /\b(?:a year ago|years?|finally|bankroll|breathe again|today|tonight|yesterday|last week|this week|months?|streak|again and again)\b/i;

/** The final check of a finished session sentence against the row. */
export function sessionLineMatches(text: string, s: SessionFacts): boolean {
  if (!text.trim() || text.includes('{') || text.includes('}')) return false;
  if (/\d/.test(text) || /\bbb\b|big blinds?|\bhands\b/i.test(text)) return false;
  if (EMOJI.test(text) || DASHES.test(text) || text.includes('...') || text.includes('\u2026')) return false;
  if (FILLER_OPENER.test(text) || BACKSTORY.test(text)) return false;
  if (/\?/.test(text)) return false;

  const t = text.toLowerCase();
  const group = sessionGroup(s);
  if (/\b(?:good day|good to me|big day|booked|win|picked up|went my way|kind to|chipped up|finished up|up on the day|left the tables up|nice day|added|step forward)\b/.test(t) && group !== 'up') return false;
  if (/\b(?:rough|brutal|lost|losing|not my day|better of me|took a hit|finished down|down on the day|didn't go my way|wrong way|gave back|dip)\b/.test(t) && group !== 'down') return false;
  if (/\b(?:broke even|nowhere|where i started|flat day|about even)\b/.test(t) && group !== 'flat') return false;
  // Tournament days are chips, not money; cash days are not tournaments.
  if (/\btournaments?\b/.test(t) && s.format !== 'tournament') return false;
  if (/\b(?:booked|win|tables)\b/.test(t) && s.format === 'tournament') return false;
  if (/\bheads-up\b/.test(t) && s.format !== 'hu_cash') return false;
  // Size.
  if (/\b(?:small|little|a few)\b/.test(t) && mag(s) >= 50) return false;
  if (/\b(?:big day|brutal)\b/.test(t) && mag(s) < 300) return false;
  if (/\b(?:good day|rough day|not my day|good to me|better of me|took a hit|kind to|chipped up)\b/.test(t) && mag(s) < 50) return false;
  return true;
}

/**
 * One line about this day, or null when nothing true can be said in this
 * voice. The frame key is ledgered like a hand frame, so two players do not
 * post the same sentence inside the same window.
 */
export function sessionLineFor(
  s: SessionFacts,
  seed: string,
  exclude?: ReadonlySet<string>,
): { text: string; key: string } | null {
  const group = sessionGroup(s);
  const spoken: Spoken = { game: sayGame(s) };
  const pool = LINES[group];
  const start = fleetHash(seed, 'sessionvoice');
  for (let i = 0; i < pool.length; i++) {
    const idx = (start + i) % pool.length;
    const line = pool[idx]!;
    if (line.needs.some((part) => !spoken[part])) continue;
    if (line.when && !line.when(s)) continue;
    let text = line.t.replace(/\{game\}/g, spoken.game ?? '');
    if (text.includes('{')) continue;
    text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead: string, letter: string) => `${lead}${letter.toUpperCase()}`);
    const key = `frame:sessionvoice:${group}:${idx}`;
    if (exclude?.has(key)) continue;
    if (!sessionLineMatches(text, s)) continue;
    return { text, key };
  }
  return null;
}

/** The brief for a session post: no numbers, no units, nothing to echo. */
export function briefForSpokenSession(s: SessionFacts): PostBrief {
  return {
    kind: 'text',
    domain: 'poker',
    title: 'a day at the tables',
    source: 'club arena',
    people: [],
    teams: [],
    concepts: ['variance', s.format === 'tournament' ? 'tournament' : 'cash_game'],
    amounts: [],
    keyPhrase: undefined,
    topic: undefined,
    tone: 'neutral',
    isQuestion: false,
    confidence: 1,
    builtFrom: ['horse_daily_nets'],
  };
}
