/**
 * StyleSheet: how one horse writes, as data.
 *
 * WHY (Dan, 2026-09-05): "WE NEED LIKE 100+ DIFFERENT WRITING STYLES WHEN
 * POSTING, THEY CAN NOT APPEAR SIMILAR OR SAME FORMATTING OR ANYTHING ELSE."
 *
 * Before this, a horse's "voice" was `hash(profile_id) % 10` picking one of
 * ten archetypes that changed a few word choices. Everything else - length,
 * capitalisation, punctuation, whether it opened with a word or a thought,
 * whether it ever asked anything - was identical across all 1,000 horses. Two
 * horses posting about the same clip produced two sentences from the same
 * pool with the same shape.
 *
 * A style sheet is twelve independent dimensions, each drawn from its own
 * salted hash of the horse's id, plus a per-horse lexicon drawn from shared
 * pools. Formatting is a dimension, not decoration: some horses write four
 * words with no full stop, some write three sentences with a line break.
 *
 * DISTINCTNESS IS TESTED, NOT ASSUMED. `styleId()` fingerprints the twelve
 * choices; `StyleSheet.test.ts` asserts the live fleet spreads across well
 * over 100 fingerprints, that no single fingerprint holds more than a small
 * share of the fleet, and that rendering one brief through many horses gives
 * mostly distinct strings.
 *
 * Deterministic, no model, no cost. `content_authors.personality` carries a
 * readable copy for the admin console (migration 20260906xxxxxx), but this
 * module is the source of truth: the sheet is a pure function of the id, so
 * it can never drift from what the writer actually did.
 *
 * HOUSE RULES BAKED IN: no emoji (Club Arena CLAUDE.md 10.6 and the fleet
 * programme invariant 9) and no em dashes (10.7, the punctuation rule).
 * `render()` strips both unconditionally, whatever a caller passes in.
 */
import { fleetHash } from './FleetScheduler.js';

export type Length = 'terse' | 'short' | 'medium' | 'long' | 'two_sentence' | 'three_sentence';
export type Casing = 'lower' | 'sentence' | 'emphatic';
export type Punctuation = 'none' | 'minimal' | 'full' | 'ellipsis';
export type OpenerMode = 'none' | 'interjection' | 'marker' | 'address';
export type CloserMode = 'none' | 'tag_question' | 'verdict' | 'trailing';
export type Voice = 'first' | 'impersonal' | 'second' | 'plural';
export type Certainty = 'hedged' | 'plain' | 'assertive';
export type SlangLevel = 'none' | 'light' | 'heavy';
export type Numerals = 'digits' | 'words';
export type Layout = 'single' | 'double_break' | 'list';

export interface StyleSheet {
  profileId: string;
  length: Length;
  casing: Casing;
  punctuation: Punctuation;
  opener: OpenerMode;
  closer: CloserMode;
  voice: Voice;
  certainty: Certainty;
  slang: SlangLevel;
  numerals: Numerals;
  layout: Layout;
  /** Share of posts that end as a question. */
  questionRate: number;
  /** Share of posts that tag a friend. */
  tagRate: number;
  /** This horse's own words, drawn from the shared pools. */
  lexicon: {
    interjections: string[];
    markers: string[];
    verdicts: string[];
    tags: string[];
    intensifiers: string[];
    hedges: string[];
  };
}

// ─── dimension tables ────────────────────────────────────────────────────

const LENGTHS: Length[] = ['terse', 'short', 'short', 'medium', 'medium', 'long', 'two_sentence', 'two_sentence', 'three_sentence'];
const CASINGS: Casing[] = ['lower', 'sentence', 'sentence', 'sentence', 'emphatic'];
const PUNCTUATIONS: Punctuation[] = ['none', 'minimal', 'full', 'full', 'ellipsis'];
const OPENERS: OpenerMode[] = ['none', 'none', 'interjection', 'marker', 'address'];
const CLOSERS: CloserMode[] = ['none', 'none', 'tag_question', 'verdict', 'trailing'];
const VOICES: Voice[] = ['first', 'first', 'impersonal', 'impersonal', 'second', 'plural'];
const CERTAINTIES: Certainty[] = ['hedged', 'plain', 'plain', 'assertive'];
const SLANGS: SlangLevel[] = ['none', 'light', 'light', 'heavy'];
const NUMERALS: Numerals[] = ['digits', 'digits', 'words'];
const LAYOUTS: Layout[] = ['single', 'single', 'single', 'double_break', 'list'];
const QUESTION_RATES = [0, 0, 0.15, 0.35];
const TAG_RATES = [0, 0, 0.1, 0.25];

// ─── lexicon pools ───────────────────────────────────────────────────────
// Each horse draws a small, fixed slice, so two horses with identical
// dimensions still reach for different words.

const INTERJECTIONS = [
  'ok', 'right', 'well', 'man', 'nah', 'yeah', 'listen', 'honestly', 'seriously',
  'wait', 'look', 'alright', 'hmm', 'jeez', 'wow', 'oh', 'so', 'and', 'yep', 'nope',
];
const MARKERS = [
  'genuinely', 'for real', 'no joke', 'not gonna lie', 'in fairness', 'to be fair',
  'the thing is', 'here is the part', 'what gets me', 'the detail nobody mentions',
  'people keep missing this', 'say what you want', 'every single time', 'one more time',
  'this again', 'as always', 'and again', 'somehow',
];
const VERDICTS = [
  'that is the whole thing', 'rest is noise', 'nothing else to add', 'case closed',
  'that is it', 'simple as that', 'no notes', 'good luck topping that',
  'still thinking about it', 'that will sit with me', 'wild', 'unreal stuff',
  'quality', 'proper stuff', 'top drawer', 'chef kiss level', 'elite', 'special',
];
const TAG_LEADS = [
  'you seeing this', 'thoughts', 'back me up', 'tell me I am wrong', 'your read',
  'what do you think', 'this is your spot', 'you called this', 'need your take',
];
const INTENSIFIERS = [
  'absolutely', 'completely', 'genuinely', 'properly', 'flat out', 'straight up',
  'legitimately', 'actually', 'seriously', 'truly', 'utterly', 'downright',
];
const HEDGES = [
  'might be', 'could be', 'feels like', 'seems like', 'I think', 'probably',
  'more or less', 'kind of', 'sort of', 'if I had to guess', 'my read is',
];

function pick<T>(arr: T[], id: string, salt: string): T {
  return arr[fleetHash(id, salt) % arr.length]!;
}

/** A deterministic slice of a pool: same horse, same words, every time. */
function slice(pool: string[], id: string, salt: string, n: number): string[] {
  const start = fleetHash(id, salt) % pool.length;
  const step = 1 + (fleetHash(id, `${salt}:step`) % (pool.length - 1));
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(pool[(start + i * step) % pool.length]!);
  return [...new Set(out)];
}

/** The horse's style sheet. Pure function of the id. */
export function styleSheetFor(profileId: string): StyleSheet {
  return {
    profileId,
    length: pick(LENGTHS, profileId, 'st:length'),
    casing: pick(CASINGS, profileId, 'st:casing'),
    punctuation: pick(PUNCTUATIONS, profileId, 'st:punct'),
    opener: pick(OPENERS, profileId, 'st:opener'),
    closer: pick(CLOSERS, profileId, 'st:closer'),
    voice: pick(VOICES, profileId, 'st:voice'),
    certainty: pick(CERTAINTIES, profileId, 'st:certainty'),
    slang: pick(SLANGS, profileId, 'st:slang'),
    numerals: pick(NUMERALS, profileId, 'st:numerals'),
    layout: pick(LAYOUTS, profileId, 'st:layout'),
    questionRate: pick(QUESTION_RATES, profileId, 'st:question'),
    tagRate: pick(TAG_RATES, profileId, 'st:tag'),
    lexicon: {
      interjections: slice(INTERJECTIONS, profileId, 'lx:interj', 3),
      markers: slice(MARKERS, profileId, 'lx:marker', 3),
      verdicts: slice(VERDICTS, profileId, 'lx:verdict', 3),
      tags: slice(TAG_LEADS, profileId, 'lx:tag', 2),
      intensifiers: slice(INTENSIFIERS, profileId, 'lx:intens', 3),
      hedges: slice(HEDGES, profileId, 'lx:hedge', 2),
    },
  };
}

/** Fingerprint of the twelve dimensions, for distinctness tests and admin. */
export function styleId(s: StyleSheet): string {
  return [
    s.length, s.casing, s.punctuation, s.opener, s.closer, s.voice,
    s.certainty, s.slang, s.numerals, s.layout,
    String(s.questionRate), String(s.tagRate),
  ].join('/');
}

/** Target sentence length in words, for the Composer to aim at. */
export function targetWords(s: StyleSheet): { min: number; max: number; sentences: number } {
  switch (s.length) {
    case 'terse': return { min: 2, max: 6, sentences: 1 };
    case 'short': return { min: 5, max: 11, sentences: 1 };
    case 'medium': return { min: 10, max: 18, sentences: 1 };
    case 'long': return { min: 16, max: 28, sentences: 1 };
    case 'two_sentence': return { min: 8, max: 22, sentences: 2 };
    case 'three_sentence': return { min: 12, max: 32, sentences: 3 };
  }
}

const NUMBER_WORDS: Record<string, string> = {
  '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six',
  '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten', '11': 'eleven', '12': 'twelve',
};

/**
 * Apply the style to finished sentences.
 *
 * The Composer decides WHAT is said (from the brief); this decides how it
 * looks. Emoji and em dashes are stripped unconditionally: house rules, and a
 * caller should not be able to smuggle either in through content.
 */
export function render(sentences: string[], s: StyleSheet, seed: string): string {
  let parts = sentences.map((x) => x.trim()).filter(Boolean);
  if (parts.length === 0) return '';

  // Opener on the first sentence.
  if (s.opener === 'interjection') {
    const word = s.lexicon.interjections[fleetHash(seed, 'op') % s.lexicon.interjections.length]!;
    parts[0] = `${word} ${lowerFirst(parts[0]!)}`;
  } else if (s.opener === 'marker') {
    const word = s.lexicon.markers[fleetHash(seed, 'op') % s.lexicon.markers.length]!;
    parts[0] = `${word}, ${lowerFirst(parts[0]!)}`;
  } else if (s.opener === 'address') {
    parts[0] = `${lowerFirst(parts[0]!)}`;
  }

  // Closer after the last sentence.
  if (s.closer === 'verdict') {
    parts.push(s.lexicon.verdicts[fleetHash(seed, 'cl') % s.lexicon.verdicts.length]!);
  } else if (s.closer === 'tag_question') {
    parts[parts.length - 1] = `${parts[parts.length - 1]}, right`;
  } else if (s.closer === 'trailing') {
    parts[parts.length - 1] = `${parts[parts.length - 1]}`;
  }

  // Numerals.
  if (s.numerals === 'words') {
    // Never reword a number that is part of a token: card notation ("9c",
    // "Ts"), a variant name ("PLO5"), a stake ("1/3"), a score or a decimal.
    // Measured 2026-09-06: without the letter guards this style turned
    // "QsJc9cKh3h on Qc 3c 7s" into "QsJcninecKhthreeh on Qc threec sevens",
    // which is not a hand any player could read.
    parts = parts.map((p) =>
      p.replace(
        /(^|[^\dA-Za-z/$.-])(\d{1,2})(?![\dA-Za-z/.-])/g,
        (_m, pre: string, n: string) => `${pre}${NUMBER_WORDS[n] ?? n}`,
      ),
    );
  }

  // Punctuation.
  parts = parts.map((p) => p.replace(/[.!?]+$/, ''));
  let joined: string;
  const sep = s.punctuation === 'none' ? ' ' : s.punctuation === 'ellipsis' ? '... ' : '. ';
  if (s.layout === 'list' && parts.length > 1) {
    joined = parts.join('\n');
  } else if (s.layout === 'double_break' && parts.length > 1) {
    const head = parts[0]!;
    const tail = parts.slice(1).join(sep);
    joined = `${head}${s.punctuation === 'none' ? '' : '.'}\n\n${tail}`;
  } else {
    joined = parts.join(sep);
  }
  if (s.punctuation === 'full') joined = `${joined}.`;
  else if (s.punctuation === 'ellipsis') joined = `${joined}...`;
  else if (s.punctuation === 'minimal' && parts.length > 1) joined = `${joined}.`;

  // Casing.
  if (s.casing === 'lower') {
    joined = joined.toLowerCase();
  } else if (s.casing === 'emphatic') {
    joined = upperFirst(joined);
    joined = emphasiseOneWord(joined, seed);
  } else {
    joined = joined
      .split('\n')
      .map((line) => upperFirst(line))
      .join('\n');
  }

  // House rules, unconditional.
  joined = stripBannedGlyphs(joined);

  return joined.replace(/[ \t]{2,}/g, ' ').trim();
}

/** No emoji, no em dashes, anywhere a horse publishes. */
export function stripBannedGlyphs(s: string): string {
  return s
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/—/g, ',')
    .replace(/–/g, '-')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
}

function emphasiseOneWord(s: string, seed: string): string {
  const words = s.split(' ');
  const candidates = words
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.length >= 5 && /^[A-Za-z]+$/.test(w));
  if (!candidates.length) return s;
  const chosen = candidates[fleetHash(seed, 'emph') % candidates.length]!;
  words[chosen.i] = chosen.w.toUpperCase();
  return words.join(' ');
}

function upperFirst(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function lowerFirst(s: string): string {
  // Never lower-case a proper noun or an acronym.
  if (/^[A-Z]{2,}/.test(s)) return s;
  const first = s.split(' ')[0] ?? '';
  if (first.length > 1 && first === upperFirst(first) && /^[A-Z][a-z]+$/.test(first)) {
    return s;
  }
  return s.length ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** A readable copy for content_authors.personality and the admin console. */
export function describeStyle(s: StyleSheet): Record<string, unknown> {
  return {
    style_id: styleId(s),
    length: s.length,
    casing: s.casing,
    punctuation: s.punctuation,
    opener: s.opener,
    closer: s.closer,
    voice: s.voice,
    certainty: s.certainty,
    slang: s.slang,
    numerals: s.numerals,
    layout: s.layout,
    question_rate: s.questionRate,
    tag_rate: s.tagRate,
    lexicon: s.lexicon,
  };
}
