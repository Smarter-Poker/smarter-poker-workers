import type { CaptionFact } from './CaptionVoice.js';
import { publicFigureDomain, type PostBrief } from './PostBrief.js';

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Three explicit article facts, not a headline-attribution fallback. Neither
 * a URL, article id, arbitrary title nor stylistic wording supplies novelty.
 * Unsupported, hypothetical or ambiguously bound headlines remain silent.
 */
export function newsTitleFact(b: PostBrief): CaptionFact | null {
  if (b.kind !== 'link' || b.isQuestion) return null;
  const title = b.title.replace(/[\u2018\u2019]/g, "'").replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim();
  if (/[?]|\b(?:no|not|never|didn't|doesn't|don't|isn't|wasn't|weren't|won't|can't|cannot|could|would|should|might|may|if|unless|without|before|after|then|reacts|watches|denies|rumor|rumour)\b/i.test(title)) return null;

  if (b.domain === 'poker') {
    // A guarantee is an announced pool floor, not a winner's payout, buy-in,
    // actual entries or money already awarded. Only this literal event and
    // amount binding is established by the retained real article fixture.
    const guarantee = title.match(/^APT Championship(?: returns to [A-Za-z][A-Za-z ]{0,65} with| (?:announces|offers|has))? \$([\d,]+(?:\.\d+)?)\s*(million|thousand|m|k)? (guaranteed|guarantee)(?: prize pool)?$/i);
    if (guarantee) {
      if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(guarantee[1]!)) return null;
      const scale = /^(million|m)$/i.test(guarantee[2] ?? '') ? 1_000_000 : /^(thousand|k)$/i.test(guarantee[2] ?? '') ? 1_000 : 1;
      const amount = Number(guarantee[1]!.replace(/,/g, '')) * scale;
      if (!Number.isSafeInteger(amount) || amount <= 0) return null;
      return {
        person: '', action: 'news_guarantee', identity: `event:apt championship:guarantee:${amount}`,
        // Keep the brief's source-established money notation for the shared
        // relevance gate; canonical dollars, not spelling, own deduplication.
        subject: `the ${b.amounts[0] ?? `$${amount.toLocaleString('en-US')}`} guarantee for APT Championship`,
      };
    }
    const people = b.people.filter(person => publicFigureDomain(person) === 'poker');
    if (people.length !== 1) return null;
    const person = people[0]!;
    // The whole-title grammar below binds the known actor directly and
    // separately names its closed event. Heuristic "Poker Masters" proper
    // nouns are not a second person; two known actors still fail above.
    const actor = escape(person);
    const bubble = title.match(new RegExp(`^${actor} (?:completes (?:an? )?(?:unwanted )?hat[- ]trick of (Poker Masters|WSOP|WPT) bubbles|bubbles (?:the )?(Poker Masters|WSOP|WPT) for (?:a |the )?third time)$`, 'i'));
    if (bubble) {
      const event = bubble[1] ?? bubble[2]!;
      const canonicalEvent = /^poker masters$/i.test(event) ? 'Poker Masters' : event.toUpperCase();
      return {
        person, action: 'news_bubble', identity: `person:${key(person)}:event:${key(event)}:bubbles:3`,
        subject: `${person}'s three ${canonicalEvent} bubble finishes`,
      };
    }
  }

  if (b.domain === 'sports' && b.sport === 'mlb' && b.teams.length === 2) {
    const teams = b.teams.map(escape).join('|');
    const sweep = title.match(new RegExp(`^(${teams}) (?:sweep(?:s|ed)? (${teams}) in (NLCS|ALCS|World Series)|complete (?:a |the )?(NLCS|ALCS|World Series) sweep of (${teams}))(?:, advance to (?:1st|first|the) World Series(?: in [1-9][0-9]* years)?)?$`, 'i'));
    if (sweep) {
      const winner = b.teams.find(team => team.toLowerCase() === sweep[1]!.toLowerCase())!;
      const loserName = sweep[2] ?? sweep[5]!;
      const loser = b.teams.find(team => team.toLowerCase() === loserName.toLowerCase())!;
      if (winner === loser) return null;
      const seriesRaw = sweep[3] ?? sweep[4]!;
      const series = /^world series$/i.test(seriesRaw) ? 'World Series' : seriesRaw.toUpperCase();
      return {
        person: '', action: 'news_sweep', identity: `team:${key(winner)}:opponent:${key(loser)}:series:${key(series)}:sweep`,
        subject: `the ${winner} sweep of the ${loser} in the ${series}`,
      };
    }
  }
  return null;
}
