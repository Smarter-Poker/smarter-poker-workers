/**
 * HorseScheduler — Phase 2B.2-followup port (2026-04-26)
 *
 * Ported from src/content-engine/pipeline/HorseScheduler.js (607 LOC).
 *
 * Pure-function utilities for horse content scheduling. Each horse's
 * profile_id deterministically hashes to a unique posting minute,
 * activity rates, writing-style traits, and active hours. No external
 * dependencies — safe to use anywhere.
 */

const CRON_TRIGGERS = [8, 23, 38, 53] as const;

/** Deterministic 0-59 minute slot for a horse. */
export function getHorseSlot(profileId: string | null | undefined): number {
  if (!profileId) return 0;
  let hash = 0;
  for (let i = 0; i < profileId.length; i++) {
    const char = profileId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash) % 60;
}

export function getHorseCronMinute(profileId: string): number {
  return getHorseSlot(profileId);
}

export function shouldHorseBeActive(
  profileId: string,
  currentMinute: number,
  variance = 7,
): boolean {
  const assignedMinute = getHorseCronMinute(profileId);
  const diff = Math.abs(currentMinute - assignedMinute);
  return diff <= variance || diff >= 60 - variance;
}

interface HorseRecord {
  profile_id: string;
  [key: string]: unknown;
}

export function getActiveHorsesForMinute<T extends HorseRecord>(
  horses: T[],
  currentMinute: number,
  variance = 2,
): T[] {
  return horses.filter((h) => shouldHorseBeActive(h.profile_id, currentMinute, variance));
}

type ActionType = 'like' | 'comment' | 'reply' | 'post' | 'friend';

export function getHorseActivityRate(profileId: string, actionType: ActionType | string): number {
  const hash = getHorseSlot(profileId);
  const baseRates: Record<string, number> = {
    like: 0.4 + (hash % 40) / 100,
    comment: 0.2 + (hash % 30) / 100,
    reply: 0.15 + (hash % 25) / 100,
    post: 0.3 + (hash % 30) / 100,
    friend: 0.05 + (hash % 15) / 100,
  };
  return baseRates[actionType] ?? 0.3;
}

interface ActiveHours {
  start: number;
  end: number;
}

export function getHorseActiveHours(profileId: string): ActiveHours {
  const hash = getHorseSlot(profileId);
  const patterns: ActiveHours[] = [
    { start: 6, end: 18 },
    { start: 8, end: 20 },
    { start: 10, end: 22 },
    { start: 12, end: 0 },
    { start: 14, end: 2 },
    { start: 16, end: 4 },
    { start: 18, end: 6 },
    { start: 20, end: 8 },
    { start: 22, end: 10 },
    { start: 0, end: 12 },
  ];
  return patterns[hash % patterns.length]!;
}

export function isHorseActiveHour(profileId: string, currentHour: number): boolean {
  const { start, end } = getHorseActiveHours(profileId);
  if (start <= end) {
    return currentHour >= start && currentHour <= end;
  }
  return currentHour >= start || currentHour <= end;
}

export function isHorseActiveHourTZ(
  profileId: string,
  utcHour: number,
  timezone: string | null | undefined,
): boolean {
  if (!timezone) return isHorseActiveHour(profileId, utcHour);
  try {
    const now = new Date();
    now.setUTCHours(utcHour, 0, 0, 0);
    const localHour = parseInt(
      new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hour12: false,
        timeZone: timezone,
      }).format(now),
    );
    return isHorseActiveHour(profileId, localHour);
  } catch {
    return isHorseActiveHour(profileId, utcHour);
  }
}

// ═══ Writing style ═════════════════════════════════════════════════════════

const CAPITALIZATION_STYLES = [
  'all_lower',
  'all_lower',
  'normal',
  'first_cap',
  'first_cap',
  'lazy_caps',
] as const;
const EMOJI_STYLES = ['none', 'none', 'none', 'none', 'none', 'none'] as const;
const PUNCTUATION_STYLES = [
  'none',
  'minimal',
  'normal',
  'enthusiastic',
  'ellipsis',
  'dash_lover',
] as const;
const FILLER_SETS: string[][] = [
  [],
  ['honestly', 'ngl'],
  ['fr', 'lowkey'],
  ['tbh', 'imo'],
  ['yo', 'bruh'],
  ['like', 'idk'],
  ['lmao', 'lol'],
  ['bro', 'dude'],
  ['damn', 'sheesh'],
  ['ong', 'no cap'],
];
const OPENER_STYLES = [
  'direct',
  'reaction',
  'emoji_first',
  'filler_first',
  'one_word',
] as const;
const LINGUISTIC_QUIRKS = [
  'none',
  'double_letters',
  'drops_vowels',
  'adds_periods',
  'stretches',
  'abbreviates',
  'uses_numbers',
  'spaces_out',
  'repeats_end',
  'slang_heavy',
] as const;

export interface HorseWritingStyle {
  capitalization: string;
  emojiStyle: string;
  emojiChoices: string[];
  punctuation: string;
  fillers: string[];
  openerStyle: string;
  quirk: string;
  fillerProbability: number;
  emojiProbability: number;
  doubleEmoji: boolean;
}

function getHorseStyleHash(profileId: string | null | undefined): number {
  if (!profileId) return 0;
  let hash = 0;
  for (let i = 0; i < profileId.length; i++) {
    const char = profileId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash) % 100;
}

export function getHorseWritingStyle(profileId: string): HorseWritingStyle {
  const hash = getHorseStyleHash(profileId);
  return {
    capitalization: CAPITALIZATION_STYLES[hash % CAPITALIZATION_STYLES.length] ?? 'normal',
    emojiStyle: EMOJI_STYLES[(hash * 7) % EMOJI_STYLES.length] ?? 'none',
    emojiChoices: [],
    punctuation: PUNCTUATION_STYLES[(hash * 13) % PUNCTUATION_STYLES.length] ?? 'normal',
    fillers: FILLER_SETS[(hash * 17) % FILLER_SETS.length] ?? [],
    openerStyle: OPENER_STYLES[(hash * 23) % OPENER_STYLES.length] ?? 'direct',
    quirk: LINGUISTIC_QUIRKS[(hash * 31) % LINGUISTIC_QUIRKS.length] ?? 'none',
    fillerProbability: (hash % 50) / 100,
    emojiProbability: ((hash * 3) % 40) / 100,
    doubleEmoji: false,
  };
}

function applyQuirk(text: string, quirk: string): string {
  switch (quirk) {
    case 'double_letters':
      return text.replace(/([aeiou])/gi, (m) => (Math.random() > 0.7 ? m + m : m));
    case 'stretches':
      return text.replace(/([aeiousy])(\s|$)/gi, (m, letter, after) =>
        Math.random() > 0.6 ? letter + letter + letter + after : m,
      );
    case 'adds_periods':
      return text;
    case 'abbreviates':
      return text.replace(/\bwith\b/gi, 'w/').replace(/\bbecause\b/gi, 'bc');
    case 'repeats_end':
      if (text.length > 3) {
        const lastChar = text[text.length - 1];
        if (lastChar && /[a-z]/i.test(lastChar)) {
          return text + lastChar.repeat(2 + Math.floor(Math.random() * 3));
        }
      }
      return text;
    default:
      return text;
  }
}

export function applyWritingStyle(comment: string, profileId: string): string {
  const style = getHorseWritingStyle(profileId);
  let result = comment;

  // Sanitization
  result = result
    .replace(/—/g, ' ')
    .replace(/–/g, ' ')
    .replace(/(?<![0-9a-z]{2,})-(?![0-9])(\b(?!bet|outer|raise|bluff|flop|call|fold|hand|street|barrel|pair|card|pot|roll|way|side))/gi, ' ')
    .replace(/["\u201c\u201d\u2018\u2019]/g, '')
    .replace(/:/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Capitalization
  switch (style.capitalization) {
    case 'all_lower':
      result = result.toLowerCase();
      break;
    case 'first_cap':
      result = result.charAt(0).toUpperCase() + result.slice(1).toLowerCase();
      break;
    case 'all_caps':
      result = result.toUpperCase();
      break;
    case 'random_caps':
      result = result
        .split('')
        .map((c) => (Math.random() > 0.7 ? c.toUpperCase() : c.toLowerCase()))
        .join('');
      break;
    case 'lazy_caps':
      if (Math.random() > 0.7) {
        result = result.charAt(0).toUpperCase() + result.slice(1).toLowerCase();
      } else {
        result = result.toLowerCase();
      }
      break;
  }

  // Punctuation
  switch (style.punctuation) {
    case 'none':
      result = result.replace(/[.!?,]+$/g, '');
      break;
    case 'minimal':
      result = result.replace(/[!]+/g, '').replace(/[.]+$/, '');
      break;
    case 'enthusiastic':
      if (!result.match(/[!?]$/)) {
        result = result.replace(/[.]+$/, '') + (Math.random() > 0.5 ? '!' : '!!');
      }
      break;
    case 'ellipsis':
      result = result.replace(/[.!?,]+$/, '').trim();
      if (Math.random() > 0.5) result += '...';
      else if (Math.random() > 0.4) result += '.';
      break;
  }

  // Fillers
  if (style.fillers.length > 0 && Math.random() < style.fillerProbability) {
    const filler = style.fillers[Math.floor(Math.random() * style.fillers.length)];
    if (filler) {
      if (style.openerStyle === 'filler_first' || Math.random() > 0.5) {
        result = filler + ' ' + result.toLowerCase();
      } else {
        result = result + ' ' + filler;
      }
    }
  }

  // Quirks
  if (style.quirk !== 'none' && Math.random() > 0.4) {
    result = applyQuirk(result, style.quirk);
  }

  return result.trim();
}

// ═══ Time-of-day energy ════════════════════════════════════════════════════

export interface TimeOfDayEnergy {
  mode: string;
  emojiBoost: number;
  typoChance: number;
  slangBoost: number;
  lengthMod: number;
  fillers: string[];
}

export function getTimeOfDayEnergy(hour = new Date().getHours()): TimeOfDayEnergy {
  if (hour >= 0 && hour < 5) {
    return {
      mode: 'degen',
      emojiBoost: 1.5,
      typoChance: 0.15,
      slangBoost: 1.5,
      lengthMod: 0.7,
      fillers: ['bruh', 'lmao', 'yo', 'sheesh'],
    };
  }
  if (hour >= 5 && hour < 11) {
    return {
      mode: 'mellow',
      emojiBoost: 0.7,
      typoChance: 0.05,
      slangBoost: 0.8,
      lengthMod: 0.9,
      fillers: ['morning', 'coffee needed', 'early'],
    };
  }
  if (hour >= 11 && hour < 17) {
    return {
      mode: 'professional',
      emojiBoost: 1.0,
      typoChance: 0.03,
      slangBoost: 1.0,
      lengthMod: 1.0,
      fillers: [],
    };
  }
  return {
    mode: 'social',
    emojiBoost: 1.3,
    typoChance: 0.08,
    slangBoost: 1.2,
    lengthMod: 1.1,
    fillers: ['evening grind', 'session time', 'lets go'],
  };
}

// ═══ Stakes voice ══════════════════════════════════════════════════════════

export interface StakesVoice {
  tier: 'micro' | 'low' | 'mid' | 'high';
  emojiMod: number;
  enthusiasm: number;
  slangLevel: 'heavy' | 'moderate' | 'balanced' | 'minimal';
  confidence: number;
  traits: string[];
}

export function getStakesVoice(stakes: string | null | undefined): StakesVoice {
  const s = stakes || '2/5';
  const match = s.match(/(\d+)\/(\d+)/);
  const bigBlind = match && match[2] ? parseInt(match[2]) : 5;

  if (bigBlind <= 3) {
    return {
      tier: 'micro',
      emojiMod: 1.4,
      enthusiasm: 1.3,
      slangLevel: 'heavy',
      confidence: 0.8,
      traits: ['excited', 'expressive', 'lots of emojis'],
    };
  }
  if (bigBlind <= 10) {
    return {
      tier: 'low',
      emojiMod: 1.2,
      enthusiasm: 1.1,
      slangLevel: 'moderate',
      confidence: 0.9,
      traits: ['casual', 'friendly', 'relatable'],
    };
  }
  if (bigBlind <= 50) {
    return {
      tier: 'mid',
      emojiMod: 1.0,
      enthusiasm: 1.0,
      slangLevel: 'balanced',
      confidence: 1.0,
      traits: ['measured', 'occasional humor'],
    };
  }
  return {
    tier: 'high',
    emojiMod: 0.6,
    enthusiasm: 0.7,
    slangLevel: 'minimal',
    confidence: 1.3,
    traits: ['understated', 'dry', 'confident', 'fewer words'],
  };
}

// ═══ Typos ═════════════════════════════════════════════════════════════════

const TYPO_MAP: Record<string, string[]> = {
  the: ['teh', 'hte', 'th'],
  and: ['adn', 'nad', 'annd'],
  that: ['taht', 'tht'],
  with: ['wiht', 'wih'],
  have: ['ahve', 'hav'],
  this: ['tihs', 'thsi'],
  what: ['waht', 'wht'],
  just: ['jsut', 'juts'],
  from: ['form', 'fomr'],
  they: ['tehy', 'thye'],
};

export function injectTypos(text: string, probability = 0.05): string {
  if (Math.random() > probability) return text;
  const words = text.split(' ');
  const result = words.map((word) => {
    const lower = word.toLowerCase();
    const typos = TYPO_MAP[lower];
    if (typos && Math.random() < 0.3) {
      const typo = typos[Math.floor(Math.random() * typos.length)] ?? word;
      const firstChar = word[0];
      return firstChar && firstChar === firstChar.toUpperCase()
        ? typo.charAt(0).toUpperCase() + typo.slice(1)
        : typo;
    }
    if (word.length > 3 && Math.random() < 0.1) {
      const pos = Math.floor(Math.random() * (word.length - 1)) + 1;
      const chosenChar = word[pos];
      if (chosenChar) return word.slice(0, pos) + chosenChar + word.slice(pos);
    }
    return word;
  });
  return result.join(' ');
}

// ═══ Activity variance ═════════════════════════════════════════════════════

export function shouldHorsePostToday(profileId: string): boolean {
  const hash = getHorseStyleHash(profileId);
  const dayOfYear = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
  const combined = (hash + dayOfYear) % 100;
  return combined < 70;
}

export function getHorseDailyPostLimit(profileId: string): number {
  const hash = getHorseStyleHash(profileId);
  const dayOfYear = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
  const combined = (hash + dayOfYear) % 100;
  if (combined < 20) return 1;
  if (combined < 50) return 2;
  if (combined < 80) return 3;
  return 4;
}

// ═══ Content reactions ═════════════════════════════════════════════════════

interface ContentReaction {
  templates: string[];
  energy: string;
  emojiBoost: number;
}

const CONTENT_REACTIONS: Record<string, ContentReaction> = {
  tournament_win: {
    templates: ['lets go', 'massive ship', 'gg well played', 'congrats on the run', 'king behavior', 'huge win', 'shipped it'],
    energy: 'hype',
    emojiBoost: 0,
  },
  bad_beat: {
    templates: ['that is brutal', 'runner runner pain', 'variance is cruel', 'rough spot', 'tough one to stomach', 'felt that', 'the deck lied'],
    energy: 'sympathy',
    emojiBoost: 0,
  },
  strategy: {
    templates: ['noted that', 'valid point', 'interesting line', 'makes sense', 'facts tbh', 'solid play', 'worth studying'],
    energy: 'analytical',
    emojiBoost: 0,
  },
  lifestyle: {
    templates: ['that is the mood', 'relatable honestly', 'lowkey same', 'haha real', 'this is me', 'no cap', 'every time'],
    energy: 'casual',
    emojiBoost: 0,
  },
  news: {
    templates: ['whoa hold on', 'wild to see', 'that is interesting', 'watching this', 'did not see that', 'breaking stuff', 'noted this'],
    energy: 'neutral',
    emojiBoost: 0,
  },
};

export function getContentAwareReaction(
  contentType: string,
  profileId: string,
): { template: string; energy: string; emojiBoost: number } {
  const reactions = CONTENT_REACTIONS[contentType] ?? CONTENT_REACTIONS.news!;
  const hash = getHorseStyleHash(profileId);
  const template = reactions.templates[hash % reactions.templates.length] ?? reactions.templates[0]!;
  return {
    template,
    energy: reactions.energy,
    emojiBoost: reactions.emojiBoost,
  };
}

export function detectContentType(title: string, description = ''): string {
  const text = (title + ' ' + description).toLowerCase();
  if (text.match(/win|ship|champion|first place|bracelet|title/)) return 'tournament_win';
  if (text.match(/bad beat|cooler|suck.*out|lost|bust|bad run/)) return 'bad_beat';
  if (text.match(/strategy|gto|range|study|tip|learn|how to|guide/)) return 'strategy';
  if (text.match(/life|grind|session|story|interview|day in/)) return 'lifestyle';
  return 'news';
}

export function getRandomPostDelay(minMinutes = 1, maxMinutes = 25): number {
  return Math.floor(Math.random() * (maxMinutes - minMinutes + 1) + minMinutes) * 60 * 1000;
}
