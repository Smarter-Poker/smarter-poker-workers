/**
 * Phase7Stories: the four Phase 7 story modes, drafted from rows and nothing
 * else.
 *
 *   live_tournament_story  a horse still in a running MTT or satellite says
 *                          where its stack is (its own tournament_players row,
 *                          the tournament row, and a count of seats still
 *                          playing);
 *   throwback_hand         a horse retells one of its own hands from at least
 *                          three weeks ago (horse_hand_reviews), cards as
 *                          Phase 5 tokens, what it did from the action log;
 *   human_thread           a horse opens a question for people to answer,
 *                          from a fixed pool, one per horse per day;
 *   rail_human             a horse rails a person who opted in
 *                          (profiles.settings.rail_opt_in = 'true') and is
 *                          playing the same running tournament.
 *
 * WHAT IS TRUE HERE IS TRUE IN THE ROW. Every number in a draft is read
 * through `deps.supa` and recorded in `grounding.numbers`; a law test checks
 * that no other number appears in the text. Nothing is rounded into a better
 * story: a fractional net is spoken with "about" and stored exactly.
 *
 * NOBODY IS NAMED. Tournament player rows carry every seat's user id and a
 * username; the module keeps only the fleet's own rows and never copies a
 * user id, a username or a tournament name that is not a system name into a
 * draft. Opponents are "the field"; a railed person is "someone".
 *
 * The route (C5) owns the write: it checks the publication key, the
 * 20-hour post guard and the mode row, then inserts the post. This module
 * only reads, and it reads with `deps.now` so a fire can be replayed.
 * Deterministic by construction: the same rows on the same day draft the same
 * text under the same key, so a retry after a failed publish is a duplicate,
 * never a second post.
 */
import type { getSupabase } from '../supabase.js';
import { fleetHash } from './FleetScheduler.js';
import type { FleetHorse } from './HorsePublisher.js';
import { asCards, derivePlay, stakeOf, variantName, type Card, type HandPlay, type Street } from './HandStory.js';

export type StoryMode = 'live_tournament_story' | 'throwback_hand' | 'human_thread' | 'rail_human';
export const STORY_MODES: StoryMode[] = ['live_tournament_story', 'throwback_hand', 'human_thread', 'rail_human'];

export interface StoryDraft {
  mode: StoryMode;
  horse: { name: string; profile_id: string };
  publication_key: string;
  text: string;
  topic: 'poker' | 'tournament';
  grounding: Record<string, unknown>;
}

export interface StoryDeps {
  supa: ReturnType<typeof getSupabase>;
  now: Date;
  /** `loadFleet()`: the posting roster. Only these profile ids can author a draft. */
  fleet: FleetHorse[];
}

export interface StoryResult {
  drafts: StoryDraft[];
  skipped: Record<string, number>;
  considered: number;
}

/* ------------------------------------------------------------------------ */
/* Limits                                                                    */
/* ------------------------------------------------------------------------ */

/** A throwback is a hand at least this old (design 3.5, assumption A2). */
export const THROWBACK_MIN_DAYS = 21;
/** "about a month ago" only from here; younger hands are "a few weeks ago". */
export const THROWBACK_MONTH_DAYS = 28;
/** A hand worth retelling moved at least this many big blinds (HandStory rule). */
export const THROWBACK_MIN_ABS_BB = 25;
/** Rows read per horse when looking for a throwback; the action log is read for the shortlist only. */
const THROWBACK_ROWS_PER_HORSE = 200;
const THROWBACK_SHORTLIST = 12;
/** Running tournaments examined per fire. */
const TOURNAMENTS_PER_RUN = 50;
/** Player rows read per tournament; a tournament past this is skipped, not guessed at. */
const PLAYERS_PER_TOURNAMENT = 1000;
/** Opted-in people considered per fire. */
const RAIL_HUMANS_PER_RUN = 100;
/** Horses examined per fire for a per-horse mode, so a fire stays bounded. */
function horsesToExamine(limit: number): number {
  return Math.max(4 * Math.max(0, limit), 12);
}

/* ------------------------------------------------------------------------ */
/* Phase 5 card tokens                                                       */
/*                                                                           */
/* The same tokens PokerEvaluator.ts (C2, agent p7-evaluator) writes for the */
/* puzzles; named apart so the lead can swap these for its cardToken and     */
/* cardsLine once both modules are on one branch. The line shape is World    */
/* Hub formatPokerCards: `Hand <tokens> | Board <tokens>` on one line.       */
/* ------------------------------------------------------------------------ */

const SUIT_LETTER: Record<string, string> = {
  clubs: 'c', diamonds: 'd', hearts: 'h', spades: 's',
  c: 'c', d: 'd', h: 'h', s: 's',
};
const RANK_OK = /^[2-9TJQKA]$/;
export const CARD_TOKEN = /\[\[sp-card:[2-9TJQKA][cdhs]\]\]/g;

/** `[[sp-card:Kc]]`, or null when the row's card is not one the renderer draws. */
export function storyCardToken(c: Card): string | null {
  const rank = String(c.rank ?? '').toUpperCase();
  const suit = SUIT_LETTER[String(c.suit ?? '').toLowerCase()];
  if (!RANK_OK.test(rank) || !suit) return null;
  return `[[sp-card:${rank}${suit}]]`;
}

/**
 * `Hand [[sp-card:Kc]][[sp-card:7d]] | Board [[sp-card:2c]]...`, the exact
 * shape World Hub `formatPokerCards` writes, or null when any card is
 * unreadable: a hand whose cards cannot be drawn is not retold.
 */
export function storyCardsLine(hand: Card[], board: Card[]): string | null {
  const h = hand.map(storyCardToken);
  const b = board.map(storyCardToken);
  if (!h.length || !b.length) return null;
  if (h.some((t) => t === null) || b.some((t) => t === null)) return null;
  return `Hand ${h.join('')} | Board ${b.join('')}`;
}

/* ------------------------------------------------------------------------ */
/* Voice pools (law-tested: no emoji, no dashes, no @, no names, no numbers)  */
/* ------------------------------------------------------------------------ */

/**
 * Openers for a human thread. Each one asks; none states anything the horse
 * cannot know. Picked by fleetHash(profile:day), so a horse asks one question
 * a day and two horses rarely ask the same one.
 */
export const THREAD_OPENERS: readonly string[] = [
  'What is the one hand you still replay in your head weeks later?',
  'Honest question for the cash game people: how do you decide when a session is over?',
  'What is the worst advice you ever got at a poker table?',
  'Tournament players, what do you do differently once the bubble gets close?',
  'Does anyone else play tighter when a friend is watching, or is that just me?',
  'What was the first hand that made you feel like an actual poker player?',
  'How do you handle a table that never stops talking?',
  'What do you do between hands to stay sharp?',
  'Which is harder for you, folding a big hand or calling with a weak one?',
  'How many hands does it take before you trust a read on somebody new?',
  'Is there a hand you refuse to play no matter what the spot looks like?',
  'What got you into poker in the first place?',
  'How do you shake off a bad beat before the next hand is dealt?',
  'Do you review your hands after a session or just move on?',
  'What is the best lesson a losing session ever taught you?',
  'Cash or tournaments, and what made you pick a side?',
  'How do you know when it is time to move up in stakes?',
  'What is the one tell you actually trust?',
  'Anyone else get more nervous over a small pot than a big one?',
  'What do you listen to while you play, if anything?',
  'How do you decide between a value bet and a check on the river when you are unsure?',
  'Which board texture gives you the most trouble?',
  'What is a leak you fixed that made the biggest difference to your results?',
  'How long is your longest session, and did it end well?',
  'What is your rule for playing when you are tired?',
  'Do you talk at the table or keep quiet, and which works better for you?',
  'What is the hand you are happiest to see dealt, not the strongest, the happiest?',
  'How do you feel about running it twice?',
  'What would you tell someone about to play their first tournament?',
  'Which is worse, a cooler or a bad beat, and why?',
  'When do you take a break during a long session?',
  'What do you do when a table gets short handed, stay or move?',
  'How do you study away from the table, if at all?',
  'What is the longest you have ever thought about a single fold?',
  'Where do you stand on showing a bluff?',
  'What keeps you coming back to the game on the weeks it does not go well?',
];

export const THROWBACK_OPENERS: readonly string[] = [
  'Throwback to a hand from {age}.',
  'Found this one from {age} while going back through my hands.',
  'Still think about this hand from {age}.',
  'One from {age} that stuck with me.',
  'Digging through old hands and this one from {age} jumped out.',
];

export const THROWBACK_CLOSERS_WIN: readonly string[] = [
  'Still one of my favorite spots.',
  'Would take that result every time.',
  'Nice one to look back on.',
];

export const THROWBACK_CLOSERS_LOSS: readonly string[] = [
  'Still not sure I like how I played it.',
  'One to learn from.',
  'Would love to hear how others play that spot.',
];

export const LIVE_OPENERS: readonly string[] = [
  'Still alive in {where}.',
  'Quick update from {where}.',
  'Checking in from my seat in {where}.',
  'Grinding away in {where}.',
  'Update from {where}.',
  'Still in {where}, still have chips.',
];

export const LIVE_STACK_LINES: readonly string[] = [
  'Sitting on {chips} chips',
  '{chips} chips in front of me',
  'Stack is at {chips}',
];

export const LIVE_FIELD_LINES: readonly string[] = [
  '{n} players still in',
  '{n} left in the field',
  '{n} of us still playing',
];

export const LIVE_CLOSERS: readonly string[] = [
  'Long way to go.',
  'One hand at a time.',
  'Let us see where this goes.',
  'Back to it.',
];

export const RAIL_OPENERS: readonly string[] = [
  'Railing someone in {where} right now.',
  'Got someone to sweat in {where}.',
  'Following a player in {where} from my own seat.',
];

export const RAIL_CLOSERS: readonly string[] = [
  'Pulling for them.',
  'Sweating every hand from where I sit.',
  'Hoping we both make it deep.',
];

/** Every pool the law test scans, by name. */
export const STORY_POOLS: Record<string, readonly string[]> = {
  THREAD_OPENERS,
  THROWBACK_OPENERS,
  THROWBACK_CLOSERS_WIN,
  THROWBACK_CLOSERS_LOSS,
  LIVE_OPENERS,
  LIVE_STACK_LINES,
  LIVE_FIELD_LINES,
  LIVE_CLOSERS,
  RAIL_OPENERS,
  RAIL_CLOSERS,
};

/* ------------------------------------------------------------------------ */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------ */

function pick<T>(pool: readonly T[], seed: string, salt: string): T {
  return pool[fleetHash(seed, salt) % pool.length]!;
}

function count(skipped: Record<string, number>, reason: string, n = 1): void {
  skipped[reason] = (skipped[reason] ?? 0) + n;
}

function finite(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Whole numbers the way a player types them: 10,908. */
function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * The numbers a text may contain, for the grounding record and the law test:
 * digits as written, commas removed, card tokens ignored.
 */
export function numbersInText(text: string): string[] {
  const stripped = text.replace(CARD_TOKEN, ' ');
  return (stripped.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''));
}

function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function hourBucketOf(now: Date): string {
  return now.toISOString().slice(0, 13);
}

/** The roster in a per-day deterministic order that differs per mode. */
function horsesInOrder(fleet: FleetHorse[], day: string, salt: string): FleetHorse[] {
  return [...fleet]
    .filter((h) => typeof h.profile_id === 'string' && h.profile_id.length > 0)
    .sort((a, b) => {
      const d = fleetHash(`${a.profile_id}:${day}`, salt) - fleetHash(`${b.profile_id}:${day}`, salt);
      return d !== 0 ? d : a.profile_id < b.profile_id ? -1 : a.profile_id > b.profile_id ? 1 : 0;
    });
}

/**
 * Authors who already have a post of this mode today (UTC day of `now`),
 * from the social_posts metadata the route writes. Null when unreadable: a
 * roster whose ledger cannot be read drafts nothing (fail closed).
 */
async function authorsPostedToday(deps: StoryDeps, mode: StoryMode): Promise<Set<string> | null> {
  const since = `${dayOf(deps.now)}T00:00:00.000Z`;
  const { data, error } = await deps.supa
    .from('social_posts')
    .select('author_id')
    .eq('metadata->>phase7_mode', mode)
    .gte('created_at', since)
    .limit(1000);
  if (error) {
    console.warn(`[phase7-stories] ${mode}: ledger read failed:`, error.message);
    return null;
  }
  const out = new Set<string>();
  for (const row of (data ?? []) as Array<{ author_id?: unknown }>) {
    if (typeof row.author_id === 'string') out.add(row.author_id);
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Tournament names                                                          */
/* ------------------------------------------------------------------------ */

const AMOUNT = /^\$?\d[\d,]*(?:\.\d+)?[km]?$/;
const NAME_WORDS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'morning', 'afternoon', 'evening', 'night', 'nightly', 'midnight', 'midweek', 'weekend', 'weekday',
  'daily', 'weekly', 'monthly', 'late', 'early', 'lunch', 'rush', 'sunrise', 'sunset',
  'opener', 'closer', 'nightcap', 'feature', 'freeroll', 'free', 'buy', 'turbo', 'hyper', 'regular',
  'deepstack', 'deep', 'stack', 'stacks', 'stackfest', 'bounty', 'bounties', 'hunter', 'mystery',
  'progressive', 'knockout', 'omaha', 'holdem', 'texas', 'satellite', 'sat', 'reload', 'rebuy', 'reentry',
  'big', 'high', 'roller', 'funday', 'graveyard', 'guaranteed', 'special', 'main', 'event', 'series',
  'championship', 'super', 'mega', 'mini', 'micro', 'nano', 'low', 'mid', 'the', 'of', 'and', 'a', 'an',
  'cash', 'game', 'poker', 'club', 'arena', 'classic', 'showdown', 'shootout', 'five', 'six', 'four',
  'card', 'cards', 'hi', 'lo', 'hilo', 'stakes', 'grind', 'grinder', 'express', 'sprint', 'marathon',
  'flight', 'day', 'final', 'table', 'warm', 'up', 'warmup', 'kick', 'off', 'kickoff', 'premier', 'prime',
  'elite', 'pro', 'open', 'invitational', 'challenge', 'cup', 'league', 'pot', 'limit', 'no', 'fixed',
  'mixed', 'dss', 'nlh', 'nlhe', 'plo', 'plo4', 'plo5', 'plo6', 'plo8', 'flh', 'flo8', 'pko', 'ko',
  'mtt', 'sng', 'gtd', 'hu', 'heads', 'freezeout', 'ante', 'only', 'all', 'in', 'or', 'fold', 'short',
  'deck', 'pineapple', 'crazy', 'double', 'triple', 'summer', 'winter', 'spring', 'autumn', 'fall',
  'holiday', 'new', 'year', 'years', 'eve', 'birthday', 'anniversary', 'launch', 'welcome', 'members',
  'member', 'players', 'player', 'battle', 'royale', 'derby', 'sprint', 'dash', 'blitz', 'jackpot',
  'spin', 'go', 'ladder', 'race', 'qualifier', 'step', 'steps', 'tier', 'seat', 'seats', 'ticket',
  // Seen in production schedule names (30 days to 2026-09-29), all system words.
  'hunt', 'time', 'midday', 'pre', 'dawn', 'owl', 'brunch', 'breakfast', 'dinner', 'coffee', 'break',
  'union', 'grand', 'bird', 'fight', 'max', 'noon', 'twilight', 'dusk', 'happy', 'hour', 'hours',
  'am', 'pm', 'ct', 'et', 'pt', 'mt', 'freebuy', 'sit', 'ring', 'fest', 'nights', 'gold', 'silver',
  'bronze', 'platinum', 'diamond', 'diamonds', 'vip', 'private', 'reg', 'entry', 'unlimited', 'single',
  'rapid', 'slow', 'standard', 'deluxe', 'ultra', 'plus', 'lite', 'light', 'heavy', 'jumbo',
  'giant', 'monster', 'tiny', 'little', 'small', 'medium', 'large', 'huge', 'massive', 'hourly',
  'first', 'second', 'third', 'last', 'one', 'two', 'three', 'seven', 'eight', 'nine', 'ten', 'twenty',
  'fifty', 'hundred', 'thousand', 'grinders', 'players', 'club', 'clubs', 'home', 'road', 'trip',
  'north', 'south', 'east', 'west', 'central', 'midwest', 'pacific', 'atlantic', 'mountain', 'eastern',
  'western', 'southern', 'northern', 'city', 'downtown', 'uptown', 'suburban', 'lakeside', 'riverside',
]);

/**
 * The tournament's name when it is a system name: every word is a schedule
 * word, a weekday, a game, or an amount. Anything else (a person's name, a
 * handle, a club's free text) is refused and the draft says "a tournament".
 * The time tail after a bullet is dropped; it is not part of the story.
 */
export function systemTournamentName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.split(/[\u2022\u2013\u2014|]/)[0] ?? '';
  s = s.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 3 || s.length > 60 || /[@#]/.test(s)) return null;
  for (const tok of s.split(' ')) {
    const t = tok.toLowerCase().replace(/[,:;!.]+$/g, '');
    if (!t) continue;
    if (AMOUNT.test(t)) continue;
    // A hyphenated token is system when every part is (6-Max, Heads-Up, Pre-Dawn).
    const parts = t.split('-');
    if (!parts.every((p) => p.length > 0 && (NAME_WORDS.has(p) || AMOUNT.test(p)))) return null;
  }
  return s;
}

/* ------------------------------------------------------------------------ */
/* Running tournaments and the fleet's seats in them                         */
/* ------------------------------------------------------------------------ */

interface TournamentRow {
  id: string;
  name: unknown;
  tournament_type: string | null;
  current_level: unknown;
  blind_level_state: unknown;
  starting_chips: unknown;
  started_at: string | null;
  on_break: unknown;
}

interface SeatRow {
  id: string;
  user_id: string;
  chips: number;
}

interface TournamentFacts {
  row: TournamentRow;
  name: string | null;
  level: number | null;
  smallBlind: number | null;
  bigBlind: number | null;
  startingChips: number | null;
  onBreak: boolean;
  playersRemaining: number;
  /** Fleet seats only. Every other seat's row is dropped before this exists. */
  horses: SeatRow[];
  /** Seats of opted-in people, when the caller asked for them; never anyone else. */
  railed: SeatRow[];
}

async function readRunningTournaments(deps: StoryDeps, skipped: Record<string, number>): Promise<TournamentRow[] | null> {
  const { data, error } = await deps.supa
    .from('tournaments')
    .select('id, name, tournament_type, current_level, blind_level_state, starting_chips, started_at, on_break')
    .eq('status', 'RUNNING')
    .in('tournament_type', ['MTT', 'SATELLITE'])
    .order('started_at', { ascending: false })
    .limit(TOURNAMENTS_PER_RUN);
  if (error) {
    console.warn('[phase7-stories] tournaments read failed:', error.message);
    count(skipped, 'tournaments_read_failed');
    return null;
  }
  return ((data ?? []) as TournamentRow[]).filter((t) => typeof t.id === 'string' && t.id.length > 0);
}

/**
 * The seats of one running tournament: the count of everyone still playing
 * (a head request, no rows), and the rows of the fleet and, when asked, of
 * opted-in people. Null when the tournament cannot be read exactly.
 */
async function readTournamentFacts(
  deps: StoryDeps,
  t: TournamentRow,
  fleetIds: Set<string>,
  railedIds: Set<string>,
  skipped: Record<string, number>,
): Promise<TournamentFacts | null> {
  const { count: playing, error: countError } = await deps.supa
    .from('tournament_players')
    .select('id', { count: 'exact', head: true })
    .eq('tournament_id', t.id)
    .eq('status', 'playing');
  if (countError || typeof playing !== 'number') {
    count(skipped, 'players_count_unreadable');
    return null;
  }
  const { data, error } = await deps.supa
    .from('tournament_players')
    .select('id, user_id, chips')
    .eq('tournament_id', t.id)
    .eq('status', 'playing')
    .limit(PLAYERS_PER_TOURNAMENT);
  if (error) {
    count(skipped, 'players_read_failed');
    return null;
  }
  const rows = (data ?? []) as Array<{ id?: unknown; user_id?: unknown; chips?: unknown }>;
  if (rows.length >= PLAYERS_PER_TOURNAMENT) {
    // The read is clamped, so a horse may be missing from it. Not guessed at.
    count(skipped, 'tournament_too_large');
    return null;
  }
  const horses: SeatRow[] = [];
  const railed: SeatRow[] = [];
  for (const r of rows) {
    const uid = typeof r.user_id === 'string' ? r.user_id : '';
    const chips = finite(r.chips);
    const id = typeof r.id === 'string' ? r.id : String(r.id ?? '');
    if (!uid || chips === null || !id) continue;
    if (fleetIds.has(uid)) horses.push({ id, user_id: uid, chips });
    else if (railedIds.has(uid)) railed.push({ id, user_id: uid, chips });
    // Every other seat is somebody else's: dropped here, never held.
  }
  const state = (t.blind_level_state && typeof t.blind_level_state === 'object' ? t.blind_level_state : {}) as Record<string, unknown>;
  const level = finite(t.current_level);
  const sb = finite(state.small_blind);
  const bb = finite(state.big_blind);
  const start = finite(t.starting_chips);
  return {
    row: t,
    name: systemTournamentName(t.name),
    level: level !== null && Number.isInteger(level) && level >= 1 ? level : null,
    smallBlind: sb !== null && sb > 0 ? sb : null,
    bigBlind: bb !== null && bb > 0 ? bb : null,
    startingChips: start !== null && start > 0 ? start : null,
    onBreak: t.on_break === true,
    playersRemaining: playing,
    horses,
    railed,
  };
}

/**
 * "the Tuesday Bounty Hunt", or "a satellite" / "a tournament" when the name
 * is not a system name. A satellite whose kept name does not say so gets the
 * word back: "DSS Wednesday $22 NLH Deepstack \u2022 2 PM CT Satellite" keeps
 * only the part before the bullet, and that part names the target event.
 */
function wherePhrase(f: TournamentFacts): string {
  const satellite = f.row.tournament_type === 'SATELLITE';
  if (f.name) return satellite && !/satellite/i.test(f.name) ? `the ${f.name} satellite` : `the ${f.name}`;
  return satellite ? 'a satellite' : 'a tournament';
}

/** "Level 6 with blinds at 300/600." or "Level 6." or "" (nothing the row does not say). */
function levelSentence(f: TournamentFacts): string {
  if (f.level === null) return '';
  const blinds = f.smallBlind !== null && f.bigBlind !== null ? ` with blinds at ${fmtInt(f.smallBlind)}/${fmtInt(f.bigBlind)}` : '';
  return `Level ${f.level}${blinds}.`;
}

function levelBucket(f: TournamentFacts, now: Date): string {
  return f.level !== null ? String(f.level) : `h${hourBucketOf(now)}`;
}

function tournamentGrounding(f: TournamentFacts): Record<string, unknown> {
  return {
    tournament_id: f.row.id,
    tournament_type: f.row.tournament_type,
    tournament_named: f.name !== null,
    tournament_name: f.name,
    players_remaining: f.playersRemaining,
    current_level: f.level,
    small_blind: f.smallBlind,
    big_blind: f.bigBlind,
    starting_chips: f.startingChips,
    on_break: f.onBreak,
  };
}

function tournamentNumbers(f: TournamentFacts): string[] {
  const out: string[] = [String(f.playersRemaining)];
  if (f.level !== null) out.push(String(f.level));
  if (f.smallBlind !== null) out.push(String(Math.round(f.smallBlind)));
  if (f.bigBlind !== null) out.push(String(Math.round(f.bigBlind)));
  if (f.startingChips !== null) out.push(String(Math.round(f.startingChips)));
  if (f.name) out.push(...numbersInText(f.name));
  return out;
}

/* ------------------------------------------------------------------------ */
/* live_tournament_story                                                     */
/* ------------------------------------------------------------------------ */

async function draftLive(deps: StoryDeps, limit: number): Promise<StoryResult> {
  const skipped: Record<string, number> = {};
  const drafts: StoryDraft[] = [];
  let considered = 0;
  const byId = new Map(deps.fleet.map((h) => [h.profile_id, h] as const));
  if (!byId.size) {
    count(skipped, 'fleet_empty');
    return { drafts, skipped, considered };
  }
  const tournaments = await readRunningTournaments(deps, skipped);
  if (!tournaments) return { drafts, skipped, considered };
  if (!tournaments.length) {
    count(skipped, 'no_running_tournaments');
    return { drafts, skipped, considered };
  }
  const day = dayOf(deps.now);
  tournaments.sort((a, b) => fleetHash(`${a.id}:${day}`, 'p7-live-t') - fleetHash(`${b.id}:${day}`, 'p7-live-t'));

  // Every running tournament is read first (two light reads each, at most
  // TOURNAMENTS_PER_RUN of them), then seats are taken one per tournament per
  // pass: a fire never fills its limit with five updates from one field.
  const queues: Array<{ f: TournamentFacts; bucket: string; seats: SeatRow[] }> = [];
  for (const t of tournaments) {
    const f = await readTournamentFacts(deps, t, new Set(byId.keys()), new Set(), skipped);
    if (!f) continue;
    if (!f.horses.length) {
      count(skipped, 'no_horse_in_tournament');
      continue;
    }
    if (f.playersRemaining < 2) {
      count(skipped, 'field_too_small', f.horses.length);
      continue;
    }
    const bucket = levelBucket(f, deps.now);
    const seats = [...f.horses].sort(
      (a, b) => fleetHash(`${a.user_id}:${t.id}:${bucket}`, 'p7-live') - fleetHash(`${b.user_id}:${t.id}:${bucket}`, 'p7-live'),
    );
    queues.push({ f, bucket, seats });
  }
  for (let pass = 0; drafts.length < limit; pass++) {
    let any = false;
    for (const { f, bucket, seats } of queues) {
      if (drafts.length >= limit) break;
      const seat = seats[pass];
      if (!seat) continue;
      any = true;
      const t = f.row;
      considered += 1;
      const horse = byId.get(seat.user_id)!;
      const seed = `${seat.user_id}:${t.id}:${bucket}`;
      const stack = pick(LIVE_STACK_LINES, seed, 'p7-live-stack').replace('{chips}', fmtInt(seat.chips));
      // The tournament's starting stack is a fact about the tournament, not a
      // claim about this seat's history (re-entries and add-ons exist).
      const start = f.startingChips !== null ? `Starting stack was ${fmtInt(f.startingChips)}.` : '';
      const field = pick(LIVE_FIELD_LINES, seed, 'p7-live-field').replace('{n}', fmtInt(f.playersRemaining));
      const parts = [
        pick(LIVE_OPENERS, seed, 'p7-live-open').replace('{where}', wherePhrase(f)),
        `${stack}, ${field}.`,
        start,
        levelSentence(f),
        f.onBreak ? 'We are on a break right now.' : '',
        pick(LIVE_CLOSERS, seed, 'p7-live-close'),
      ].filter(Boolean);
      const text = parts.join(' ');
      drafts.push({
        mode: 'live_tournament_story',
        horse: { name: horse.name, profile_id: horse.profile_id },
        publication_key: `p7:live:${t.id}:${seat.user_id}:${bucket}`,
        text,
        topic: 'tournament',
        grounding: {
          ...tournamentGrounding(f),
          tournament_player_id: seat.id,
          chips: seat.chips,
          bucket,
          numbers: [String(Math.round(seat.chips)), ...tournamentNumbers(f)],
        },
      });
    }
    if (!any) break;
  }
  return { drafts, skipped, considered };
}

/* ------------------------------------------------------------------------ */
/* rail_human                                                                */
/* ------------------------------------------------------------------------ */

/**
 * People who asked to be railed: profiles.settings->>'rail_opt_in' = 'true'
 * and not a horse. Null when unreadable. Nobody is railed without this.
 */
async function readOptedInHumans(deps: StoryDeps, fleetIds: Set<string>): Promise<string[] | null> {
  const { data, error } = await deps.supa
    .from('profiles')
    .select('id')
    .eq('settings->>rail_opt_in', 'true')
    .or('is_horse.is.null,is_horse.eq.false')
    .limit(RAIL_HUMANS_PER_RUN);
  if (error) {
    console.warn('[phase7-stories] rail opt-in read failed:', error.message);
    return null;
  }
  const out: string[] = [];
  for (const row of (data ?? []) as Array<{ id?: unknown }>) {
    if (typeof row.id === 'string' && row.id && !fleetIds.has(row.id)) out.push(row.id);
  }
  return out;
}

async function draftRail(deps: StoryDeps, limit: number): Promise<StoryResult> {
  const skipped: Record<string, number> = {};
  const drafts: StoryDraft[] = [];
  let considered = 0;
  const byId = new Map(deps.fleet.map((h) => [h.profile_id, h] as const));
  if (!byId.size) {
    count(skipped, 'fleet_empty');
    return { drafts, skipped, considered };
  }
  const humans = await readOptedInHumans(deps, new Set(byId.keys()));
  if (!humans) {
    count(skipped, 'profiles_read_failed');
    return { drafts, skipped, considered };
  }
  if (!humans.length) {
    count(skipped, 'no_opted_in_humans');
    return { drafts, skipped, considered };
  }
  considered = humans.length;
  const tournaments = await readRunningTournaments(deps, skipped);
  if (!tournaments) return { drafts, skipped, considered };
  if (!tournaments.length) {
    count(skipped, 'no_running_tournaments');
    return { drafts, skipped, considered };
  }
  const bucket = hourBucketOf(deps.now);
  tournaments.sort((a, b) => fleetHash(`${a.id}:${bucket}`, 'p7-rail-t') - fleetHash(`${b.id}:${bucket}`, 'p7-rail-t'));
  const railedIds = new Set(humans);
  const seen = new Set<string>();
  const taken = new Set<string>();

  for (const t of tournaments) {
    if (drafts.length >= limit) break;
    const f = await readTournamentFacts(deps, t, new Set(byId.keys()), railedIds, skipped);
    if (!f) continue;
    if (!f.railed.length) continue;
    for (const r of f.railed) seen.add(r.user_id);
    if (!f.horses.length) {
      count(skipped, 'no_horse_in_tournament', f.railed.length);
      continue;
    }
    if (f.playersRemaining < 2) {
      count(skipped, 'field_too_small', f.railed.length);
      continue;
    }
    const horses = [...f.horses].sort(
      (a, b) => fleetHash(`${a.user_id}:${t.id}:${bucket}`, 'p7-rail') - fleetHash(`${b.user_id}:${t.id}:${bucket}`, 'p7-rail'),
    );
    // Sorted by the seat row id so the choice is stable; the person's id is
    // not part of any seed, key or text.
    const railed = [...f.railed].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    railed.forEach((seat, k) => {
      if (drafts.length >= limit) return;
      const horseSeat = horses[k % horses.length]!;
      const key = `p7:rail:${t.id}:${horseSeat.user_id}:${bucket}`;
      if (taken.has(key)) {
        count(skipped, 'key_taken');
        return;
      }
      taken.add(key);
      const horse = byId.get(horseSeat.user_id)!;
      const seed = `${horseSeat.user_id}:${t.id}:${bucket}`;
      const parts = [
        pick(RAIL_OPENERS, seed, 'p7-rail-open').replace('{where}', wherePhrase(f)),
        `They are sitting on ${fmtInt(seat.chips)} chips with ${fmtInt(f.playersRemaining)} players still in.`,
        `I am in it too with ${fmtInt(horseSeat.chips)}.`,
        levelSentence(f),
        pick(RAIL_CLOSERS, seed, 'p7-rail-close'),
      ].filter(Boolean);
      drafts.push({
        mode: 'rail_human',
        horse: { name: horse.name, profile_id: horse.profile_id },
        publication_key: key,
        text: parts.join(' '),
        topic: 'tournament',
        grounding: {
          ...tournamentGrounding(f),
          tournament_player_id: horseSeat.id,
          chips: horseSeat.chips,
          railed_chips: seat.chips,
          opt_in_source: 'profiles.settings.rail_opt_in',
          bucket,
          numbers: [String(Math.round(horseSeat.chips)), String(Math.round(seat.chips)), ...tournamentNumbers(f)],
        },
      });
    });
  }
  const notPlaying = humans.filter((h) => !seen.has(h)).length;
  if (notPlaying) count(skipped, 'human_not_playing', notPlaying);
  return { drafts, skipped, considered };
}

/* ------------------------------------------------------------------------ */
/* human_thread                                                              */
/* ------------------------------------------------------------------------ */

async function draftThreads(deps: StoryDeps, limit: number): Promise<StoryResult> {
  const skipped: Record<string, number> = {};
  const drafts: StoryDraft[] = [];
  let considered = 0;
  if (!deps.fleet.length) {
    count(skipped, 'fleet_empty');
    return { drafts, skipped, considered };
  }
  const day = dayOf(deps.now);
  const done = await authorsPostedToday(deps, 'human_thread');
  if (!done) {
    count(skipped, 'ledger_unreadable');
    return { drafts, skipped, considered };
  }
  for (const horse of horsesInOrder(deps.fleet, day, 'p7-thread-order')) {
    if (drafts.length >= limit) break;
    considered += 1;
    if (done.has(horse.profile_id)) {
      count(skipped, 'already_posted_today');
      continue;
    }
    const index = fleetHash(`${horse.profile_id}:${day}`, 'p7-thread') % THREAD_OPENERS.length;
    drafts.push({
      mode: 'human_thread',
      horse: { name: horse.name, profile_id: horse.profile_id },
      publication_key: `p7:thread:${horse.profile_id}:${day}`,
      text: THREAD_OPENERS[index]!,
      topic: 'poker',
      grounding: { fleet_row_id: horse.id, day, opener_index: index, pool_size: THREAD_OPENERS.length, numbers: [] },
    });
  }
  return { drafts, skipped, considered };
}

/* ------------------------------------------------------------------------ */
/* throwback_hand                                                            */
/* ------------------------------------------------------------------------ */

interface ThrowbackRow {
  id: number | string;
  hand_id: string | null;
  played_at: string;
  game_variant: string | null;
  format: string | null;
  big_blind: number | string | null;
  hole_cards: unknown;
  board: unknown;
  net_bb: number | string | null;
  pot_size: number | string | null;
  is_win: boolean | null;
}

const CARDS_SEEN: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };
const STREET_PHRASE: Record<Street, string> = { preflop: 'preflop', flop: 'on the flop', turn: 'on the turn', river: 'on the river' };

/** How long ago, in a player's words. Null under the minimum: not a throwback. */
export function agePhrase(days: number): string | null {
  if (!Number.isFinite(days) || days < THROWBACK_MIN_DAYS) return null;
  if (days >= 365) return 'about a year ago';
  if (days >= 84) return 'a few months ago';
  if (days >= 56) return 'a couple of months ago';
  if (days >= THROWBACK_MONTH_DAYS) return 'about a month ago';
  return 'a few weeks ago';
}

/** "1/2 no limit holdem", "a no limit holdem tournament", "heads up PLO", "no limit holdem cash". */
function settingPhrase(variant: string, format: string, bigBlind: number): string {
  const v = variantName(variant);
  if (format === 'tournament') return `a ${v} tournament`;
  const stake = stakeOf(format, bigBlind);
  if (stake) return `${stake} ${v}`;
  if (format === 'hu_cash') return `heads up ${v}`;
  return `${v} cash`;
}

/** "preflop, on the flop and the turn": the streets the horse bet or raised on. */
function streetList(streets: Street[]): string {
  const parts = streets.map((s, i) => {
    if (s === 'preflop') return 'preflop';
    const first = i === 0 || streets[i - 1] === 'preflop';
    return `${first ? 'on ' : ''}the ${s}`;
  });
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}

/**
 * What the horse did, past tense, only what the log shows (HandVoice rules).
 *
 * Throwback material predates the per-action table snapshot (production logs
 * carry `publicNode` only from 2026-09-12), so derivePlay cannot tell a shove
 * from an all-in call there. "Got it all in" is true either way and is all
 * this says; "got aggressive" covers a bet or a raise without claiming which.
 */
function actionPhrase(p: HandPlay): string {
  if (p.foldStreet) return `I folded ${STREET_PHRASE[p.foldStreet]}`;
  if (p.allInStreet) {
    if (p.stackInStreet === p.allInStreet) return `Got it all in ${STREET_PHRASE[p.allInStreet]}`;
    return `Called an all in ${STREET_PHRASE[p.allInStreet]}`;
  }
  if (p.aggressionStreets.length) {
    const list = streetList(p.aggressionStreets);
    // Without a showdown and without a fold the row says the horse won it.
    return p.showdown ? `Got aggressive ${list} and went to showdown` : `Got aggressive ${list} and took it down`;
  }
  return p.showdown ? 'Never put in a bet and still got to showdown' : 'Took it down without ever betting';
}

/** "62" or "about 92": the row's number, never a rounder one presented as exact. */
function spokenBb(absBb: number): { text: string; number: string } {
  const rounded = Math.round(absBb);
  const number = String(rounded);
  return { text: Number.isInteger(absBb) ? number : `about ${number}`, number };
}

async function draftThrowbacks(deps: StoryDeps, limit: number): Promise<StoryResult> {
  const skipped: Record<string, number> = {};
  const drafts: StoryDraft[] = [];
  let considered = 0;
  if (!deps.fleet.length) {
    count(skipped, 'fleet_empty');
    return { drafts, skipped, considered };
  }
  const day = dayOf(deps.now);
  const done = await authorsPostedToday(deps, 'throwback_hand');
  if (!done) {
    count(skipped, 'ledger_unreadable');
    return { drafts, skipped, considered };
  }
  const cutoff = new Date(deps.now.getTime() - THROWBACK_MIN_DAYS * 86_400_000).toISOString();
  const budget = horsesToExamine(limit);

  for (const horse of horsesInOrder(deps.fleet, day, 'p7-throwback-order')) {
    if (drafts.length >= limit || considered >= budget) break;
    considered += 1;
    if (done.has(horse.profile_id)) {
      count(skipped, 'already_posted_today');
      continue;
    }
    const draft = await throwbackFor(deps, horse, day, cutoff, skipped);
    if (draft) drafts.push(draft);
  }
  return { drafts, skipped, considered };
}

async function throwbackFor(
  deps: StoryDeps,
  horse: FleetHorse,
  day: string,
  cutoff: string,
  skipped: Record<string, number>,
): Promise<StoryDraft | null> {
  const pid = horse.profile_id;
  const { data, error } = await deps.supa
    .from('horse_hand_reviews')
    .select('id, hand_id, played_at, game_variant, format, big_blind, hole_cards, board, net_bb, pot_size, is_win')
    .eq('horse_user_id', pid)
    .lte('played_at', cutoff)
    .order('played_at', { ascending: false })
    .limit(THROWBACK_ROWS_PER_HORSE);
  if (error) {
    console.warn('[phase7-stories] throwback read failed:', error.message);
    count(skipped, 'hand_read_failed');
    return null;
  }
  const rows = ((data ?? []) as ThrowbackRow[]).filter((r) => {
    const net = finite(r.net_bb);
    return (
      typeof r.hand_id === 'string' && r.hand_id.length > 0 &&
      net !== null && Math.abs(net) >= THROWBACK_MIN_ABS_BB &&
      asCards(r.hole_cards).length >= 2 && asCards(r.board).length >= 3
    );
  });
  if (!rows.length) {
    count(skipped, 'no_old_hand');
    return null;
  }
  // The most eventful hands first, then the horse's own daily hash chooses
  // inside that slice (pickHandStory's rule), so a retry retells the same hand.
  rows.sort((a, b) => Math.abs(finite(b.net_bb) ?? 0) - Math.abs(finite(a.net_bb) ?? 0));
  const top = rows.slice(0, Math.min(THROWBACK_SHORTLIST, rows.length));
  const start = fleetHash(`${pid}:${day}`, 'p7-throwback') % top.length;
  const ordered = [...top.slice(start), ...top.slice(0, start)];

  const { data: logs, error: logError } = await deps.supa
    .from('horse_hand_reviews')
    .select('id, actions')
    .in('id', ordered.map((r) => r.id));
  if (logError) {
    console.warn('[phase7-stories] throwback action read failed:', logError.message);
    count(skipped, 'hand_actions_read_failed');
    return null;
  }
  const actionsById = new Map(
    ((logs ?? []) as Array<{ id: string | number; actions: unknown }>).map((l) => [String(l.id), l.actions]),
  );

  for (const row of ordered) {
    const play = derivePlay(pid, actionsById.get(String(row.id)));
    if (!play) {
      count(skipped, 'hand_actions_unreadable');
      continue;
    }
    const isWin = Boolean(row.is_win);
    if ((isWin && play.foldStreet) || (!isWin && !play.foldStreet && !play.showdown)) {
      count(skipped, 'hand_actions_disagree');
      continue;
    }
    if (play.runouts > 1) {
      // The stored board is only the first runout: not the board the pot was decided on.
      count(skipped, 'multiple_runouts');
      continue;
    }
    const playedAt = Date.parse(row.played_at);
    const days = Number.isFinite(playedAt) ? Math.floor((deps.now.getTime() - playedAt) / 86_400_000) : NaN;
    const age = agePhrase(days);
    if (!age) {
      count(skipped, 'too_recent');
      continue;
    }
    const hole = asCards(row.hole_cards);
    const board = asCards(row.board);
    // A fold shows only the cards the horse saw; an all-in board was dealt out.
    const shown = play.foldStreet ? board.slice(0, CARDS_SEEN[play.foldStreet]) : board;
    if (shown.length < 3) {
      count(skipped, 'no_board');
      continue;
    }
    const cards = storyCardsLine(hole, shown);
    if (!cards) {
      count(skipped, 'cards_unreadable');
      continue;
    }
    const netBb = finite(row.net_bb)!;
    const bb = spokenBb(Math.abs(netBb));
    const seed = `${pid}:${row.hand_id}`;
    const opener = pick(THROWBACK_OPENERS, seed, 'p7-throwback-open').replace('{age}', age);
    const bigBlind = finite(row.big_blind) ?? 0;
    const format = row.format ?? 'cash';
    const variant = row.game_variant ?? 'nlh';
    const setting = settingPhrase(variant, format, bigBlind);
    const action = actionPhrase(play);
    const result = play.foldStreet
      ? `${action}. Cost me ${bb.text} big blinds.`
      : `${action}. ${isWin ? 'Won' : 'Lost'} ${bb.text} big blinds.`;
    const closer = pick(isWin ? THROWBACK_CLOSERS_WIN : THROWBACK_CLOSERS_LOSS, seed, 'p7-throwback-close');
    const text = `${opener} It was ${setting}. ${result} ${closer}\n${cards}`;
    const stake = stakeOf(format, bigBlind);
    return {
      mode: 'throwback_hand',
      horse: { name: horse.name, profile_id: pid },
      publication_key: `p7:throwback:${pid}:${row.hand_id}`,
      text,
      topic: 'poker',
      grounding: {
        review_id: row.id,
        hand_id: row.hand_id,
        played_at: row.played_at,
        days_ago: days,
        game_variant: variant,
        format,
        big_blind: bigBlind,
        stake: stake ?? null,
        net_bb: netBb,
        is_win: isWin,
        pot_size: finite(row.pot_size),
        board_cards_shown: shown.length,
        play: {
          fold_street: play.foldStreet,
          all_in_street: play.allInStreet,
          stack_in_street: play.stackInStreet,
          showdown: play.showdown,
          aggression_streets: play.aggressionStreets,
          decisive_street: play.decisiveStreet,
          runouts: play.runouts,
        },
        numbers: [bb.number, ...(stake ? numbersInText(stake) : []), ...numbersInText(variantName(variant))],
      },
    };
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* Entry point                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Up to `limit` drafts of one mode from the rows as they are right now.
 * `skipped` counts every candidate that was not drafted, by reason;
 * `considered` is how many horses (or, for rail_human, opted-in people) were
 * examined. Reads only; the route writes.
 */
export async function draftStories(mode: StoryMode, deps: StoryDeps, limit: number): Promise<StoryResult> {
  const n = Math.max(0, Math.floor(limit));
  if (n === 0) return { drafts: [], skipped: { limit_zero: 1 }, considered: 0 };
  switch (mode) {
    case 'live_tournament_story':
      return draftLive(deps, n);
    case 'throwback_hand':
      return draftThrowbacks(deps, n);
    case 'human_thread':
      return draftThreads(deps, n);
    case 'rail_human':
      return draftRail(deps, n);
    default:
      return { drafts: [], skipped: { unknown_mode: 1 }, considered: 0 };
  }
}
