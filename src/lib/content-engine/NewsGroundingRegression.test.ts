import { describe, expect, it } from 'vitest';
import { briefForAsset } from './PostBrief.js';
import { composeCaption } from './Composer.js';
import { styleSheetFor } from './StyleSheet.js';
import { sportsVideoFact } from './SportsVideoFact.js';

describe('retained natural news grounding failures', () => {
  it.each([
    ['484d22c4-ff3c-4430-8058-b6f0d8c2387a', 'No. 1 pick Dybantsa to have ankle checked after leaving preseason finale', 'sports', 'ESPN NBA News'],
    ['31eb1c41-1349-499b-844c-8c2ea0268590', 'Why Micah Parsons trade will linger over Cowboys, Packers for years to come', 'sports', 'ESPN NFL News'],
    ['387b6e20-0019-429c-b8c1-e6bf5f8e7538', 'Brutal Full House Cooler Decides $10K Poker Masters Tournament', 'poker', 'PokerNews'],
  ] as const)('never replaces unsupported article facts with generic claims for %s', (id, title, domainHint, source) => {
    const brief = briefForAsset({kind: 'link', title, domainHint, source});
    for (let retry = 0; retry < 12; retry++) {
      const result = composeCaption(brief, styleSheetFor(id), String(retry));
      expect(result.text).not.toBe('');
      expect(result.text).not.toMatch(/crossover|handles like|year from now|can't fold|played it right|always going in/i);
      expect(result.semanticKey).toMatch(/^meaning:subject:/);
      expect(result.relevance).toBeGreaterThanOrEqual(.3);
    }
  });
  it('retains separately established literal article facts', () => {
    const brief = briefForAsset({kind: 'link', title: 'APT Championship offers $8.1 million guaranteed', domainHint: 'poker', source: 'PokerNews'});
    expect(composeCaption(brief, styleSheetFor('387b6e20-0019-429c-b8c1-e6bf5f8e7538')).text).not.toBe('');
  });
  it('keeps arbitrary topical news silent rather than dressing it as a play', () => {
    const brief = briefForAsset({kind:'link', title:'NBA injury update and roster rumors', domainHint:'sports', source:'ESPN NBA News'});
    expect(composeCaption(brief, styleSheetFor('484d22c4-ff3c-4430-8058-b6f0d8c2387a')).text).toBe('');
  });
  it('does not collapse the retained closing-out and matchup authors into the same need-a-read frame', () => {
    const rows = [
      ['15165d49-c7b3-42bc-b2e9-f46195e151ec', 'Trevor Megill closes out a Game 1 win for the Brewers'],
      ['4182bdc2-b78b-490d-a02f-07f19aa8c070', 'Brewers vs Dodgers NLCS Game 4 Shorts Recap'],
    ];
    const captions = rows.map(([id, title]) => composeCaption(briefForAsset({kind: 'video', title: title!, domainHint: 'sports', source: 'MLB'}), styleSheetFor(id!)).text);
    expect(captions.every(Boolean)).toBe(true);
    for (const caption of captions) expect(caption).not.toMatch(/I need .* to form a (?:read|take) on/i);
  });
  it.each([
    ['The Rays snatch the lead behind a Junior Caminero double down the line! 🔥', 'baseball:go_ahead_double:actor:junior caminero:team:rays'],
    ['Jonathan Aranda brings home another two runs for the Rays!', 'baseball:runs_batted_in:actor:jonathan aranda:team:rays:runs:2'],
    ['YANDY DÍAZ WITH A 2-RUN SHOT! 😤', 'baseball:home_run:actor:yandy diaz:runs:2'],
  ])('binds actual maintained MLB title facts without adding an unseen outcome: %s', (title, identity) => {
    const brief = briefForAsset({kind: 'video', title, domainHint: 'sports', source: 'MLB'});
    expect(sportsVideoFact(brief)?.identity).toBe(identity);
    expect(composeCaption(brief, styleSheetFor('15165d49-c7b3-42bc-b2e9-f46195e151ec')).text).not.toBe('');
    expect(sportsVideoFact({...brief, title: `Could ${title}`})).toBeNull();
    expect(sportsVideoFact({...brief, source: 'Unknown'})).toBeNull();
  });
});
