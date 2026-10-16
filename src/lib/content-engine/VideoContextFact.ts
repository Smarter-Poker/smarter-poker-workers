import type { CaptionFact } from './CaptionVoice.js';

const PAIRS: Record<string, string> = {
  aces: 'aa', kings: 'kk', queens: 'qq', jacks: 'jj', tens: 'tt',
  nines: '99', eights: '88', sevens: '77', sixes: '66', fives: '55',
  fours: '44', threes: '33', twos: '22', deuces: '22',
};
const COUNTS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const pairPattern = Object.keys(PAIRS).join('|');

/** Literal context only: no actor, winner, bet size or cards are inferred. */
export function pokerVideoContextFact(rawTitle: string): CaptionFact | null {
  const title = rawTitle.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').trim();
  if (/[?]|\b(?:not|no|never|didn't|doesn't|don't|isn't|wasn't|weren't|won't|can't|cannot|could|would|should|couldn't|wouldn't|shouldn't|might|if|unless|without|reacts|watches|then|before|after|followed|versus|vs|against)\b/.test(title)) return null;
  // Bind the count to its own noun phrase, not any number elsewhere in a title.
  const countPattern = '(two|three|four|five|six|seven|eight|nine|[2-9])';
  const allInCount = title.match(new RegExp(`\\b${countPattern}[- ]ways? all[- ]in\\b`))?.[1]
    ?? title.match(new RegExp(`\\ball[- ]in(?: with (?:pocket )?(?:${pairPattern}))? ${countPattern}[- ]ways?\\b`))?.[1];
  const potCount = title.match(new RegExp(`\\b${countPattern}[- ]ways? (?:side[- ])?pot\\b`))?.[1];
  const countToken = /\ball[- ]in\b/.test(title) ? allInCount : potCount;
  const count = countToken ? (COUNTS[countToken] ?? Number(countToken)) : null;
  const multiway = count !== null || /\bmulti[- ]?way (?:side[- ])?pot\b/.test(title);
  const allIn = /\ball[- ]in\b/.test(title);
  const sidePot = /\bside[- ]pot\b/.test(title);
  if (allIn && /\bpot\b/.test(title)) return null;
  if ((title.match(/\ball[- ]in\b/g)?.length ?? 0) > 1 || (title.match(/\bpot\b/g)?.length ?? 0) > 1) return null;
  const allInPair = title.match(new RegExp(`\\ball[- ]in with (?:pocket )?(${pairPattern})\\b`))?.[1];
  const potPair = title.match(new RegExp(`\\bpot with (?:pocket )?(${pairPattern})\\b`))?.[1]
    ?? title.match(new RegExp(`\\b(${pairPattern}) in (?:a |the )?(?:bizarre |huge |big )?multi[- ]?way pot\\b`))?.[1];
  if (allIn && (count !== null || allInPair)) {
    const holding = allInPair ? PAIRS[allInPair] : null;
    return {
      person: '', action: 'all_in_context',
      identity: `all_in${holding ? `:holding:${holding}` : ''}${count ? `:players:${count}` : ''}`,
      subject: `the ${count ? `${count}-way ` : ''}all-in${allInPair ? ` with pocket ${allInPair === 'deuces' ? 'twos' : allInPair}` : ''}`,
    };
  }
  if (/\bpot\b/.test(title) && (potPair || sidePot || multiway)) {
    const holding = potPair ? PAIRS[potPair] : null;
    return {
      person: '', action: 'pot_context',
      identity: `pot${sidePot ? ':side' : ''}${holding ? `:holding:${holding}` : ''}${count ? `:players:${count}` : multiway ? ':multiway' : ''}`,
      subject: `the ${count ? `${count}-way ` : multiway ? 'multi-way ' : ''}${sidePot ? 'side ' : ''}pot${potPair ? ` with pocket ${potPair === 'deuces' ? 'twos' : potPair}` : ''}`,
    };
  }
  const riverAmount = title.match(/\$([\d,]+(?:\.\d+)?)\s*(million|thousand|m|k)?\s+river\b/);
  if (riverAmount) {
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(riverAmount[1]!)) return null;
    const scale = /^(?:million|m)$/.test(riverAmount[2] ?? '') ? 1_000_000 : /^(?:thousand|k)$/.test(riverAmount[2] ?? '') ? 1_000 : 1;
    const amount = Number(riverAmount[1]!.replace(/,/g, '')) * scale;
    if (Number.isSafeInteger(amount) && amount > 0) return {
      person: '', action: 'river_context', identity: `river:amount:${amount}`,
      subject: `the $${amount.toLocaleString('en-US')} river`,
    };
  }
  return null;
}
