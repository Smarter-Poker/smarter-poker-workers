/**
 * PostBrief: what a post is actually ABOUT, read before anybody writes a word
 * about it.
 *
 * WHY (Dan, 2026-09-05): "THE WORDS THAT ARE POSTED NEED TO MAKE SENSE FOR THE
 * ACTUAL THING THE HORSE IS POSTING ABOUT 100%" and "SOME KIND OF POST REVIEW
 * ON THE BACK END THAT CREATES A SUMMARY THAT THE HORSES CAN INGEST BEFORE
 * COMMENTING ON IT".
 *
 * Until today a caption was a draw from a pool keyed on a category, so a clip
 * of a basketball player holding position in the paint got "Nobody touches him
 * when he is locked in" - true of nothing in particular, and posted by 26
 * horses. A comment was chosen by a regex ladder over the post's text. Neither
 * step ever read what the thing WAS.
 *
 * A brief is that reading. It is built from the fields the platform already
 * has - the clip's title and channel, the article's headline and site, the
 * post's own metadata, the hand's cards and result - and it names the people,
 * teams, concepts and numbers actually present. Everything downstream
 * (Composer, the comment path, the reply engine) writes FROM the brief, so a
 * sentence can only be about the real subject.
 *
 * DETERMINISTIC ON PURPOSE. No model is called here. Every field comes from
 * text the post already carries, so a brief costs nothing, never rate-limits,
 * never hallucinates a player who is not in the title, and is identical on
 * every run. `confidence` says how much was actually understood; a low
 * confidence brief makes the Composer reach for language that commits to
 * less, rather than inventing detail.
 *
 * The model layer (ModelWriter) can enrich a brief later for free text, which
 * is the one case where extraction is genuinely hard. It is not required.
 */

/** Sport codes we can name confidently. */
export type Sport = 'nba' | 'nfl' | 'mlb' | 'nhl' | 'soccer' | 'ufc' | 'golf' | 'tennis' | 'ncaa';

export type BriefKind = 'video' | 'link' | 'text' | 'photo' | 'hand';
export type BriefDomain = 'poker' | 'sports' | 'general';
export type BriefTone =
  | 'hype'
  | 'admiring'
  | 'funny'
  | 'critical'
  | 'bad_beat'
  | 'analytical'
  | 'neutral';

export interface PostBrief {
  postId?: string;
  kind: BriefKind;
  domain: BriefDomain;
  sport?: Sport;
  /** Cleaned, human-readable title. Emoji and hashtags stripped. */
  title: string;
  /** Channel, site or club the content came from. */
  source?: string;
  /** Proper names present in the title (people). */
  people: string[];
  /** Teams or organisations present. */
  teams: string[];
  /** Domain terms present, normalised: 'bluff', 'dunk', 'cooler'... */
  concepts: string[];
  /** Money or size mentions, as written: '$60K', '40bb', '3-bet'. */
  amounts: string[];
  /** The most distinctive noun phrase, for grounding a sentence. */
  keyPhrase?: string;
  /** The subject as a phrase a sentence can be built around. */
  topic?: string;
  tone: BriefTone;
  isQuestion: boolean;
  /** For text posts: the assertion being made, trimmed. */
  claim?: string;
  /** 0..1. How much of the subject we actually pinned down. */
  confidence: number;
  /** Where the brief came from, for the audit trail. */
  builtFrom: string[];
}

// ─── vocabularies ────────────────────────────────────────────────────────
// Deliberately explicit. Every term here is one a horse may name in a
// sentence, so a wrong entry becomes a wrong sentence.

const POKER_CONCEPTS: Record<string, string[]> = {
  bluff: ['bluff', 'bluffing', 'bluffed', 'stone cold'],
  hero_call: ['hero call', 'hero-call', 'crazy call', 'sick call'],
  cooler: ['cooler', 'set over set', 'aces cracked'],
  bad_beat: ['bad beat', 'brutal beat', 'suck out', 'sucked out', 'runner runner', 'one outer', 'two outer'],
  all_in: ['all in', 'all-in', 'shove', 'shoved', 'jam', 'jammed'],
  final_table: ['final table', 'ft bubble'],
  heads_up: ['heads up', 'heads-up'],
  bracelet: ['bracelet', 'wsop', 'world series'],
  main_event: ['main event'],
  river: ['river', 'rivered'],
  turn: ['turn card', 'turned'],
  flop: ['flop', 'flopped'],
  gto: ['gto', 'solver', 'solvers', 'equilibrium'],
  exploit: ['exploit', 'exploitative', 'exploits'],
  range: ['range', 'ranges', 'range construction'],
  three_bet: ['3bet', '3-bet', 'three bet', 'three-bet'],
  check_raise: ['check raise', 'check-raise', 'checkraise'],
  fold: ['fold', 'folded', 'laydown', 'lay down'],
  pot: ['pot', 'the pot'],
  stack: ['stack', 'stacks', 'stacked off'],
  tilt: ['tilt', 'tilted', 'tilting'],
  bankroll: ['bankroll', 'roll'],
  variance: ['variance', 'downswing', 'upswing', 'heater'],
  bounty: ['bounty', 'bounties'],
  satellite: ['satellite', 'sattie'],
  high_stakes: ['high stakes', 'nosebleed', 'nosebleeds'],
  cash_game: ['cash game', 'cash games'],
  tournament: ['tournament', 'mtt', 'tourney'],
  plo: ['plo', 'omaha', 'pot limit omaha'],
  short_deck: ['short deck', 'six plus', '6+'],
  study: ['study', 'studying', 'review', 'leak', 'leaks'],
  read: ['soul read', 'read', 'tell', 'tells'],
};

const SPORT_CONCEPTS: Record<string, string[]> = {
  dunk: ['dunk', 'dunks', 'poster', 'posterized', 'slam', 'jam'],
  three: ['three', 'threes', '3-pointer', 'three pointer', 'from deep', 'logo'],
  buzzer_beater: ['buzzer beater', 'buzzer-beater', 'game winner', 'game-winner', 'walk off', 'walk-off'],
  block: ['block', 'blocks', 'rejected', 'swat'],
  crossover: ['crossover', 'ankle', 'ankles', 'handles'],
  assist: ['assist', 'dime', 'no look', 'no-look'],
  touchdown: ['touchdown', 'td', 'end zone', 'endzone'],
  catch: ['catch', 'one handed', 'one-handed', 'reception', 'grab'],
  interception: ['interception', 'pick six', 'pick-six'],
  home_run: ['home run', 'homer', 'grand slam', 'moonshot'],
  strikeout: ['strikeout', 'struck out', 'punch out'],
  goal: ['goal', 'golazo', 'free kick', 'header'],
  save: ['save', 'saves', 'point blank'],
  knockout: ['knockout', 'ko', 'finish', 'submission'],
  comeback: ['comeback', 'came back', 'rally', 'rallied'],
  // "Debut" also describes a poker player's first EPT win. Treating it as
  // an NBA/NFL rookie signal produced a sports comment under a poker article.
  rookie: ['rookie', 'first-year player'],
  record: ['record', 'franchise record', 'career high', 'career-high'],
  playoffs: ['playoff', 'playoffs', 'finals', 'game 7', 'game seven'],
  injury: ['injury', 'injured', 'hurt'],
  trade: ['trade', 'traded', 'signing', 'signs', 'contract'],
  footwork: ['footwork', 'balance', 'body control'],
  defense: ['defense', 'defence', 'lockdown', 'stop'],
};

const TEAMS: Record<string, Sport> = {
  lakers: 'nba', celtics: 'nba', warriors: 'nba', heat: 'nba', knicks: 'nba', nets: 'nba',
  bulls: 'nba', suns: 'nba', bucks: 'nba', nuggets: 'nba', mavericks: 'nba', mavs: 'nba',
  clippers: 'nba', sixers: 'nba', '76ers': 'nba', thunder: 'nba', grizzlies: 'nba',
  pelicans: 'nba', kings: 'nba', spurs: 'nba', rockets: 'nba', jazz: 'nba', magic: 'nba',
  hawks: 'nba', hornets: 'nba', pistons: 'nba', pacers: 'nba', cavaliers: 'nba', cavs: 'nba',
  raptors: 'nba', wizards: 'nba', timberwolves: 'nba', wolves: 'nba', blazers: 'nba',
  chiefs: 'nfl', eagles: 'nfl', cowboys: 'nfl', packers: 'nfl', niners: 'nfl',
  bears: 'nfl', bills: 'nfl', ravens: 'nfl', bengals: 'nfl', lions: 'nfl', vikings: 'nfl',
  dolphins: 'nfl', jets: 'nfl', giants: 'nfl', steelers: 'nfl', broncos: 'nfl',
  yankees: 'mlb', dodgers: 'mlb', 'red sox': 'mlb', cubs: 'mlb', mets: 'mlb', braves: 'mlb',
  astros: 'mlb', phillies: 'mlb', padres: 'mlb', orioles: 'mlb',
};

/** Channels that tell us the sport without reading the title. */
const CHANNEL_SPORT: Array<[RegExp, Sport]> = [
  [/\bnba\b|house of highlights|bleacher report nba|lakers|celtics|heat|warriors|bulls|knicks|nuggets|suns|bucks/i, 'nba'],
  [/\bnfl\b|espn nfl/i, 'nfl'],
  [/\bmlb\b|baseball/i, 'mlb'],
  [/\bnhl\b|hockey/i, 'nhl'],
  [/soccer|futbol|premier league|uefa|champions league/i, 'soccer'],
  [/\bufc\b|mma/i, 'ufc'],
  [/\bpga\b|golf/i, 'golf'],
  [/tennis|atp|wta/i, 'tennis'],
  [/ncaa|college (basketball|football)/i, 'ncaa'],
];

const POKER_SOURCE = /poker|upswing|cardplayer|wsop|pokernews|hustler|triton|pokergo|bike|hcl/i;

/**
 * People a headline is likely to be about. A title-cased headline makes every
 * word look like a name ("Too Weak to Call, Strong Enough to Raise" produced
 * the "person" Call Strong Enough), so in that mode only these, or a
 * possessive, count. Lower-cased for matching.
 */
const KNOWN_PEOPLE = [
  // poker
  'garrett adelstein', 'phil ivey', 'daniel negreanu', 'phil hellmuth', 'tom dwan',
  'patrik antonius', 'doug polk', 'jason koon', 'bryn kenney', 'justin bonomo',
  'stephen chidwick', 'fedor holz', 'dan smith', 'nick petrangelo', 'alex foxen',
  'kristen foxen', 'vanessa selbst', 'liv boeree', 'maria ho', 'jennifer tilly',
  'antonio esfandiari', 'mike matusow', 'scott seiver', 'david peters', 'ali imsirovic',
  'landon tice', 'wesley fei', 'eric persson', 'rampage poker', 'mariano grandoli',
  'andrew neeme', 'brad owen', 'johnnie vibes', 'nik airball', 'santhosh suvarna',
  'phil galfond', 'linus loeliger', 'isaac haxton', 'seth davies', 'chris moneymaker',
  'chris brewer', 'jungleman', 'dan cates', 'matt berkey', 'nick schulman',
  // sport
  'lebron james', 'stephen curry', 'kevin durant', 'giannis antetokounmpo',
  'nikola jokic', 'luka doncic', 'jayson tatum', 'joel embiid', 'anthony edwards',
  'shai gilgeous-alexander', 'victor wembanyama', 'jimmy butler', 'kawhi leonard',
  'damian lillard', 'devin booker', 'ja morant', 'zion williamson', 'tyrese haliburton',
  'patrick mahomes', 'travis kelce', 'josh allen', 'lamar jackson', 'justin jefferson',
  'tyreek hill', 'ceedee lamb', 'aaron judge', 'shohei ohtani', 'mookie betts',
  'connor mcdavid', 'lionel messi', 'cristiano ronaldo', 'erling haaland',
  'kylian mbappe', 'jon jones', 'islam makhachev', 'caitlin clark', 'angel reese',
];

/** Words that look like names but are not. */
const NOT_A_NAME = new Set([
  'the', 'this', 'that', 'and', 'but', 'for', 'with', 'from', 'into', 'over', 'under',
  'what', 'when', 'where', 'why', 'how', 'who', 'his', 'her', 'him', 'she', 'they',
  'i', 'a', 'an', 'is', 'it', 'in', 'on', 'at', 'of', 'to', 'he', 'we', 'you', 'me',
  'omg', 'wow', 'lol', 'insane', 'crazy', 'sick', 'nasty', 'wild', 'unreal', 'watch',
  'best', 'top', 'new', 'first', 'last', 'full', 'live', 'now', 'today', 'tonight',
  'shorts', 'highlights', 'video', 'clip', 'must', 'see', 'never', 'ever', 'again',
  'poker', 'basketball', 'football', 'baseball', 'hockey', 'soccer', 'nba', 'nfl', 'mlb',
  'espn', 'sportscenter', 'breaking', 'news', 'update', 'report', 'vs', 'game',
]);

/** Never the head of a key phrase. */
const PHRASE_STOP = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'his', 'her', 'their', 'its',
  'like', 'other', 'another', 'very', 'just', 'more', 'most', 'some', 'any', 'every',
  'here', 'there', 'now', 'then', 'when', 'while', 'after', 'before', 'about',
  'with', 'from', 'into', 'over', 'under', 'been', 'being', 'have', 'has', 'had',
  'crowd', 'video', 'clip', 'watch', 'full', 'best', 'top', 'new', 'live',
]);

// ─── text helpers ────────────────────────────────────────────────────────

/** Strip emoji, hashtags, handles, bracket tags and repeated punctuation. */
export function cleanTitle(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    // Emoji and pictographs, including the surrogate ranges YouTube titles use.
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}]/gu, ' ')
    .replace(/#\w+/g, ' ')
    .replace(/@\w+/g, ' ')
    .replace(/\s*\|\s*.*$/, '')          // "Title | Channel" tails
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // [HD], (Full Highlights)
    .replace(/\s*[-–—]\s*(highlights?|shorts?|full (video|clip)).*$/i, '')
    .replace(/(^|\s)["'`]+|["'`]+(?=\s|$)/g, '$1')   // quotes, not apostrophes
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*([.!?])\1+/g, '$1')
    .trim();
}

/** Acronyms that stay upper-case when a shouty title is calmed down. */
const ACRONYMS = new Set([
  'NBA', 'NFL', 'MLB', 'NHL', 'UFC', 'PGA', 'ATP', 'WTA', 'NCAA', 'MVP', 'OT',
  'WSOP', 'WPT', 'EPT', 'PLO', 'GTO', 'ICM', 'MTT', 'HU', 'TD', 'KO', 'MSG',
  'LA', 'NY', 'SF', 'GB', 'KC', 'US', 'UK', 'AI', 'VIP',
]);

/**
 * Calm a shouty title down. "THIS IS MAGIC OMG" reads as a person shouting,
 * not as content, and a horse quoting it verbatim looks like a scraper.
 * Real acronyms survive; short filler words do not (an earlier version kept
 * every word of three letters or fewer and produced "This IS Magic OMG").
 */
export function softenCaps(s: string): string {
  const words = s.split(/\s+/);
  const shouty = words.filter((w) => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w)).length;
  if (shouty < Math.max(2, words.length * 0.6)) return s;
  return words
    .map((w) => {
      const bare = w.replace(/[^A-Za-z]/g, '');
      if (ACRONYMS.has(bare.toUpperCase()) && bare === bare.toUpperCase()) return w;
      return w.charAt(0) + w.slice(1).toLowerCase();
    })
    .join(' ');
}

function matchConcepts(text: string, table: Record<string, string[]>): string[] {
  const lc = ` ${text.toLowerCase()} `;
  const found: string[] = [];
  for (const [key, terms] of Object.entries(table)) {
    for (const t of terms) {
      // Word-boundary match so 'pot' does not fire inside 'spot'.
      const re = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
      if (re.test(lc)) {
        found.push(key);
        break;
      }
    }
  }
  return found;
}

/** Is the title written in Headline Case, where capitals mean nothing? */
export function isHeadlineCase(title: string): boolean {
  const words = title.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w));
  if (words.length < 4) return false;
  const capped = words.filter((w) => /^[A-Z]/.test(w)).length;
  return capped / words.length >= 0.6;
}

/**
 * People named in the title.
 *
 * Two modes, because capitalisation means different things in each. In a
 * sentence-cased title ("Angel holding her own in the paint") a capitalised
 * run IS a name. In a headline-cased one ("Too Weak to Call, Strong Enough to
 * Raise") every word is capitalised and the same rule invents people; there we
 * accept only a known name or an explicit possessive.
 */
function extractPeople(title: string): string[] {
  const headline = isHeadlineCase(title);
  const lc = title.toLowerCase();
  const out: string[] = [];

  // Known names work in both modes and are the strongest signal.
  for (const known of KNOWN_PEOPLE) {
    if (lc.includes(known)) {
      out.push(known.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
    }
  }

  // Possessives name a person in any casing: "Garrett Adelstein's $60K bluff".
  const poss = title.match(/\b([A-Z][a-z'.-]+(?:\s+[A-Z][a-z'.-]+)?)'s\b/g);
  if (poss) {
    for (const p of poss) {
      const name = p.replace(/'s$/, '').trim();
      if (!NOT_A_NAME.has(name.toLowerCase()) && !(name.toLowerCase() in TEAMS)) out.push(name);
    }
  }

  if (!headline) {
    const tokens = title.split(/[\s,:;!?]+/).filter(Boolean);
    let run: string[] = [];
    const flush = () => {
      if (run.length) {
        const name = run.join(' ');
        const lower = name.toLowerCase();
        const ok =
          run.length >= 2 ||
          (run.length === 1 && name.length >= 4 && !NOT_A_NAME.has(lower) && !(lower in TEAMS) && !PHRASE_STOP.has(lower));
        if (ok) out.push(name);
      }
      run = [];
    };
    for (const tok of tokens) {
      const bare = tok.replace(/[^A-Za-z'.-]/g, '');
      const isCapped = /^[A-Z][a-z'.-]+$/.test(bare);
      if (isCapped && !NOT_A_NAME.has(bare.toLowerCase()) && !(bare.toLowerCase() in TEAMS)) run.push(bare);
      else flush();
    }
    flush();
  }

  const seen = new Set<string>();
  const unique = out.filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.sort((a, b) => b.split(' ').length - a.split(' ').length).slice(0, 3);
}

/** Only names we can positively identify as public figures. */
function publicNamesIn(text: string): string[] {
  const lc = text.toLowerCase();
  const out: string[] = [];
  for (const known of KNOWN_PEOPLE) {
    if (lc.includes(known)) {
      out.push(known.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
    }
  }
  return out.slice(0, 2);
}

function extractTeams(text: string): { teams: string[]; sport?: Sport } {
  const lc = text.toLowerCase();
  const teams: string[] = [];
  let sport: Sport | undefined;
  for (const [team, sp] of Object.entries(TEAMS)) {
    const re = new RegExp(`(^|[^a-z])${team}([^a-z]|$)`, 'i');
    if (re.test(lc)) {
      teams.push(team.charAt(0).toUpperCase() + team.slice(1));
      sport = sport ?? sp;
    }
  }
  return { teams: teams.slice(0, 2), sport };
}

function extractAmounts(text: string): string[] {
  const out: string[] = [];
  const money = text.match(/\$\s?\d[\d,.]*\s?[kKmM]?/g);
  if (money) out.push(...money.map((m) => m.replace(/\s+/g, '')));
  const bb = text.match(/\b\d+(\.\d+)?\s?bb\b/gi);
  if (bb) out.push(...bb);
  const stakes = text.match(/\b\d+\s?\/\s?\d+\b/g);
  if (stakes) out.push(...stakes.map((s) => s.replace(/\s+/g, '')));
  return [...new Set(out)].slice(0, 3);
}

function detectTone(text: string, concepts: string[]): BriefTone {
  const lc = text.toLowerCase();
  if (concepts.includes('bad_beat')) return 'bad_beat';
  if (/\b(lol|lmao|funny|hilarious|comedy|joke|troll)\b/.test(lc)) return 'funny';
  if (/\b(insane|unreal|crazy|ridiculous|omg|wow|nuts|filthy|nasty|absurd)\b/.test(lc)) return 'hype';
  if (/\b(worst|terrible|awful|disaster|embarrass|blunder|punt|misplay|choke)\b/.test(lc)) return 'critical';
  if (/\b(clinic|masterclass|perfect|clean|textbook|respect|elite|legend|goat)\b/.test(lc)) return 'admiring';
  if (/\b(why|how|analysis|breakdown|explained|strategy|theory|study|lesson)\b/.test(lc)) return 'analytical';
  return 'neutral';
}

/** The most distinctive phrase in the title, for grounding a sentence. */
function keyPhraseOf(title: string, people: string[], teams: string[]): string | undefined {
  if (people.length) return people[0];
  if (teams.length) return teams[0];
  const words = title.split(/\s+/).map((w) => w.replace(/[^A-Za-z0-9'-]/g, '')).filter(Boolean);
  // Walk to the first word that can head a phrase, then take up to three
  // words, stopping at a preposition or conjunction.
  const start = words.findIndex((w) => w.length > 3 && !PHRASE_STOP.has(w.toLowerCase()));
  if (start < 0) return undefined;
  const out: string[] = [];
  for (let i = start; i < words.length && out.length < 3; i++) {
    const w = words[i]!;
    if (out.length && /^(and|or|but|with|from|into|for|to|of|in|on|at|is|was|are)$/i.test(w)) break;
    out.push(w);
  }
  return out.length ? out.join(' ') : undefined;
}

/**
 * The subject as a phrase a sentence can be built around: the cleaned title,
 * trimmed to its meaningful half and to a usable length.
 *
 * A headline with a colon usually puts the meat after it ("Too Weak to Call,
 * Strong Enough to Raise: Garrett Adelstein's $60K Bluff"), so that half wins
 * when it is substantial.
 */
/** Verbs that make a title a sentence rather than a noun phrase. */
const CLAUSE_MARKERS_TOPIC =
  /\b(is|are|was|were|has|have|had|does|did|will|wont|can|cant|gets|got|goes|went|makes|made|takes|took|wins|won|loses|lost|calls|folds|shoves|says|said|thinks|tried|trying)\b/i;

export function topicOf(title: string): string | undefined {
  if (!title) return undefined;
  let t = title.trim();
  const colon = t.lastIndexOf(': ');
  if (colon > 0) {
    const tail = t.slice(colon + 2).trim();
    if (tail.split(/\s+/).length >= 3) t = tail;
  }
  t = t.replace(/[.!?]+$/, '').trim();
  // Trailing shouts add nothing and read as scraped text.
  t = t.replace(/\s+\b(omg|lol|lmao|wow|smh|wtf|insane|crazy)\b\s*$/i, '').trim();
  const words = t.split(/\s+/);
  // Trimming a NOUN PHRASE at nine words loses nothing that matters. Trimming
  // a SENTENCE changes what it says: the real title "Daniel Negreanu is
  // literally trying to give his money away" became "...give his money", which
  // is a different claim, and the caption then stated it as fact. Phase 4
  // feeds real YouTube titles in, and real titles are often whole clauses.
  //
  // So a clause keeps its words up to a generous cap, and beyond that the
  // topic is dropped rather than misquoted - the composer has other lines to
  // reach for, and none of them puts words in the video's mouth.
  const CLAUSE_CAP = 16;
  if (CLAUSE_MARKERS_TOPIC.test(t)) {
    if (words.length > CLAUSE_CAP) return undefined;
  } else if (words.length > 9) {
    // A noun phrase is not safe to cut at an arbitrary word either. Live
    // output proved the old assumption wrong: headlines became "...and the",
    // "...fall short of" and "...Game of All-Time with". Drop the topic and
    // let the relevance gate choose another asset instead of publishing half
    // a headline.
    return undefined;
  }
  if (/\b(the|a|an|and|or|but|of|with|to|for|from|in|on|at|by|as|his|her|its)$/i.test(t)) {
    return undefined;
  }
  if (t.split(/\s+/).length < 2) return undefined;
  // Lower-case the leading word unless it is a name or acronym, so the phrase
  // drops into the middle of a sentence.
  const first = t.split(' ')[0]!;
  if (!/^[A-Z]{2,}$/.test(first) && !/^[A-Z][a-z]+$/.test(first)) {
    t = t.charAt(0).toLowerCase() + t.slice(1);
  }
  return t;
}

/**
 * Does this title actually say anything?
 *
 * Measured 2026-09-05: 3,487 of 8,236 sports_clips titles contain their own
 * channel name and 4,281 end in "clip"/"highlights"/"video" - the scraper
 * stored a placeholder, not a description. Quoting one produces
 * "Bleacher Report NBA NBA Clip and nobody in the building blinked", which is
 * exactly the scraped-looking output Phase 2 exists to end.
 *
 * When a title says nothing we say so: no topic, no key phrase from it, low
 * confidence. The Composer then reaches for a take about the concept or the
 * tone, which is generic but clean and true. A clean generic sentence beats a
 * specific-sounding sentence about a placeholder.
 */
const YOUTUBE_CHROME = [
  'keyboard shortcuts', 'playback', 'subtitles and closed captions',
  'spherical videos', 'sign in to youtube', 'watch later', 'share',
  'picture-in-picture', 'full screen', 'autoplay', 'about press copyright',
  'press copyright contact us', 'developers', 'advertise', 'terms privacy',
  'nfl sunday ticket', 'how youtube works', 'test new features',
];

export function isUninformativeTitle(title: string, source?: string | null): boolean {
  const t = title.trim();
  if (!t) return true;

  // The scraper stored YouTube's own player menu as the title on 3,855 of
  // 8,236 rows (measured 2026-09-05): "Keyboard shortcuts" x1,223,
  // "Playback" x1,000, "Subtitles and closed captions" x837, "Spherical
  // Videos" x794. None of them is a clip.
  const chrome = t.toLowerCase();
  if (YOUTUBE_CHROME.some((c) => chrome === c || chrome.startsWith(c))) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 2) return true;

  const lc = t.toLowerCase();
  const src = (source ?? '').trim().toLowerCase();
  // "Bleacher Report NBA NBA Clip": the channel name plus a filler noun.
  if (src && lc.includes(src) && words.length <= 8) return true;

  // Ends in a generic content noun and carries nothing else specific.
  if (/\b(clip|clips|highlight|highlights|video|videos|short|shorts|reel|reels)\s*$/i.test(t) && words.length <= 7) {
    return true;
  }
  // Only league, team and filler words.
  const informative = words.filter((w) => {
    const b = w.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    if (!b) return false;
    if (b in TEAMS) return false;
    if (['nba', 'nfl', 'mlb', 'nhl', 'ufc', 'ncaa', 'clip', 'clips', 'highlight', 'highlights',
         'video', 'shorts', 'short', 'official', 'full', 'best', 'top', 'the', 'and', 'vs'].includes(b)) return false;
    return b.length > 2;
  });
  return informative.length < 2;
}



// ─── the builders ───────────────────────────────────────────────────────

export interface BriefSource {
  postId?: string;
  contentType?: string | null;
  content?: string | null;
  linkTitle?: string | null;
  linkSiteName?: string | null;
  mediaTitle?: string | null;
  channel?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Build a brief for an asset about to be posted (a clip or an article),
 * before the post exists.
 */
export function briefForAsset(input: {
  kind: 'video' | 'link' | 'text';
  title?: string | null;
  source?: string | null;
  domainHint?: BriefDomain;
  sportHint?: string | null;
}): PostBrief {
  const builtFrom: string[] = [];
  const rawTitle = input.title ?? '';
  if (rawTitle) builtFrom.push('title');
  if (input.source) builtFrom.push('source');

  const title = softenCaps(cleanTitle(rawTitle));
  const source = input.source ?? undefined;
  const haystack = `${title} ${source ?? ''}`;

  let domain: BriefDomain = input.domainHint ?? 'general';
  if (!input.domainHint) {
    if (POKER_SOURCE.test(haystack)) domain = 'poker';
    else if (CHANNEL_SPORT.some(([re]) => re.test(haystack))) domain = 'sports';
  }

  const pokerConcepts = matchConcepts(title, POKER_CONCEPTS);
  const sportConcepts = matchConcepts(title, SPORT_CONCEPTS);
  // The title can overrule a weak domain hint: a poker source posting about
  // a dunk is still a dunk.
  if (domain === 'general') {
    domain = pokerConcepts.length >= sportConcepts.length && pokerConcepts.length > 0
      ? 'poker'
      : sportConcepts.length > 0
        ? 'sports'
        : 'general';
  }

  const concepts = domain === 'poker' ? pokerConcepts : domain === 'sports' ? sportConcepts : [...pokerConcepts, ...sportConcepts];
  const { teams, sport: teamSport } = extractTeams(haystack);
  let sport: Sport | undefined = teamSport;
  if (!sport) {
    const hinted = (input.sportHint ?? '').toLowerCase();
    for (const [re, sp] of CHANNEL_SPORT) {
      if (re.test(haystack) || (hinted && re.test(hinted))) {
        sport = sp;
        break;
      }
    }
  }
  const empty = isUninformativeTitle(title, source);
  // A title that says nothing cannot name anybody either: "Keyboard
  // shortcuts" yielded the person "Keyboard", and a horse then asked
  // "anyone else watch Keyboard do this".
  const people = empty ? [] : extractPeople(title);
  const amounts = extractAmounts(title);
  const tone = detectTone(title, concepts);

  // Confidence: a title we could pull real entities out of is a brief worth
  // writing from. Everything is bounded so a long title cannot fake it.
  let confidence = 0;
  if (!empty && title.length >= 12) confidence += 0.25;
  if (people.length) confidence += 0.25;
  if (teams.length) confidence += 0.15;
  if (concepts.length) confidence += 0.25;
  if (amounts.length) confidence += 0.1;
  if (sport || domain === 'poker') confidence += 0.1;
  if (empty) confidence = Math.min(confidence, 0.35);
  confidence = Math.min(1, Number(confidence.toFixed(2)));

  return {
    kind: input.kind,
    domain,
    sport,
    title,
    source,
    people,
    teams,
    concepts,
    amounts,
    // A placeholder title anchors nothing: quoting it is how the old engine
    // ended up sounding scraped.
    keyPhrase: empty ? (people[0] ?? teams[0]) : keyPhraseOf(title, people, teams),
    topic: empty ? undefined : topicOf(title),
    tone,
    isQuestion: /\?\s*$/.test(title),
    confidence,
    builtFrom,
  };
}

/**
 * Build a brief for a post that already exists, so a horse can read it before
 * commenting. Uses the link/clip fields when present, the post's own text
 * otherwise.
 */
export function briefForPost(src: BriefSource): PostBrief {
  const ct = (src.contentType ?? 'text').toLowerCase();
  const meta = (src.metadata ?? {}) as Record<string, unknown>;
  const metaKind = typeof meta.clip_type === 'string' ? (meta.clip_type as string) : undefined;
  const newsKind = typeof meta.news_type === 'string' ? (meta.news_type as string) : undefined;
  const domainHint: BriefDomain | undefined =
    metaKind === 'poker' || newsKind === 'poker'
      ? 'poker'
      : metaKind === 'sports' || newsKind === 'sports'
        ? 'sports'
        : undefined;

  if (ct === 'link' || ct === 'video') {
    // NEVER fall back to the post's own text here.
    //
    // Measured 2026-09-05 23:30: a horse's video post has no link_title, so
    // this fell through to the post's content - which is the AUTHOR'S OWN
    // COMPOSED CAPTION, not a description of the video. The commenter then
    // treated that caption as the subject and quoted it back: "Still thinking
    // about Not many people on earth can do what he", "The part that gets me
    // is Come on now, the crowd reaction said everything that". A caption is
    // commentary; it is not what the post is about.
    //
    // The real subject of a horse's post is recorded in post_briefs when it
    // is published, and VoiceWriter.loadBrief() reads that first. This path
    // is the fallback, and it says "I do not know" rather than guessing.
    const title = src.linkTitle ?? src.mediaTitle ?? '';
    const brief = briefForAsset({
      kind: ct === 'link' ? 'link' : 'video',
      title,
      source: src.linkSiteName ?? src.channel ?? undefined,
      domainHint,
    });
    brief.postId = src.postId;
    // The author's own caption is evidence too: it carries the tone.
    const caption = firstLine(src.content);
    if (caption && caption !== title) {
      brief.builtFrom.push('caption');
      const capConcepts = matchConcepts(caption, brief.domain === 'poker' ? POKER_CONCEPTS : SPORT_CONCEPTS);
      brief.concepts = [...new Set([...brief.concepts, ...capConcepts])];
      if (brief.tone === 'neutral') brief.tone = detectTone(caption, brief.concepts);
      if (/\?\s*$/.test(caption)) brief.isQuestion = true;
    }
    return brief;
  }

  // Text or photo post: the content IS the subject.
  const text = (src.content ?? '').trim();
  const title = softenCaps(cleanTitle(firstLine(text)));
  const pokerConcepts = matchConcepts(text, POKER_CONCEPTS);
  const sportConcepts = matchConcepts(text, SPORT_CONCEPTS);
  const domain: BriefDomain =
    domainHint ??
    (pokerConcepts.length >= sportConcepts.length && pokerConcepts.length > 0
      ? 'poker'
      : sportConcepts.length > 0
        ? 'sports'
        : 'general');
  const concepts = domain === 'poker' ? pokerConcepts : domain === 'sports' ? sportConcepts : [...pokerConcepts, ...sportConcepts];
  const { teams, sport } = extractTeams(text);
  // A text post is somebody's own prose, so a capitalised word in it is far
  // more likely to be a PLAYER AT THIS CLUB than a public figure. Programme
  // invariant 3: a horse never names a human. Only names we can positively
  // identify as public survive here, and the author's own sentence is never
  // reused as a topic - both would put a member's name in a horse's mouth.
  const people = publicNamesIn(title);
  const amounts = extractAmounts(text);
  const tone = detectTone(text, concepts);
  const isQuestion = /\?/.test(text);

  let confidence = 0;
  if (text.length >= 20) confidence += 0.2;
  if (concepts.length) confidence += 0.3;
  if (people.length || teams.length) confidence += 0.2;
  if (amounts.length) confidence += 0.1;
  if (domain !== 'general') confidence += 0.2;
  confidence = Math.min(1, Number(confidence.toFixed(2)));

  return {
    postId: src.postId,
    kind: ct === 'photo' || ct === 'image' ? 'photo' : 'text',
    domain,
    sport,
    title,
    source: src.linkSiteName ?? undefined,
    people,
    teams,
    concepts,
    amounts,
    // Same reason as `topic` below: a phrase lifted from a member's own
    // sentence can carry their name. Only a public figure or a team may
    // anchor a horse's reply to a text post.
    keyPhrase: people[0] ?? teams[0],
    topic: undefined,
    tone,
    isQuestion,
    claim: text.length > 0 ? text.slice(0, 240) : undefined,
    confidence,
    builtFrom: ['content'],
  };
}

function firstLine(s: string | null | undefined): string {
  if (!s) return '';
  return s.split('\n')[0] ?? '';
}

/** A one-line human summary, for logs and for the post_briefs table. */
export function summarise(b: PostBrief): string {
  const bits: string[] = [b.domain];
  if (b.sport) bits.push(b.sport);
  if (b.people.length) bits.push(b.people.join(' & '));
  if (b.teams.length) bits.push(b.teams.join(' & '));
  if (b.concepts.length) bits.push(b.concepts.slice(0, 3).join('/'));
  if (b.amounts.length) bits.push(b.amounts[0]!);
  bits.push(b.tone);
  return bits.join(' | ');
}
