import { describe, expect, it } from 'vitest';
import { briefForAsset } from './PostBrief.js';
import { composeCaption, relevanceOf } from './Composer.js';
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
  it('never promises an injury update or repeats the trade noun in its focus for the actual affected voices', () => {
    const ids = ['484d22c4-ff3c-4430-8058-b6f0d8c2387a','31eb1c41-1349-499b-844c-8c2ea0268590','387b6e20-0019-429c-b8c1-e6bf5f8e7538','15165d49-c7b3-42bc-b2e9-f46195e151ec','3d872c4e-7a37-487e-ad39-9db7d22ee59d'];
    for (const id of ids) {
      const injury = composeCaption(briefForAsset({kind:'link', title:'No. 1 pick Dybantsa to have ankle checked after leaving preseason finale', domainHint:'sports', source:'ESPN NBA News'}), styleSheetFor(id));
      expect(injury.text).not.toBe('');
      expect(injury.text).not.toMatch(/next .*update|team update after|information from the check|awaiting confirmation/i);
      const trade = composeCaption(briefForAsset({kind:'link', title:'Why Micah Parsons trade will linger over Cowboys, Packers for years to come', domainHint:'sports', source:'ESPN NFL News'}), styleSheetFor(id));
      expect(trade.text).not.toBe('');
      expect(trade.text.match(/\btrade\b/gi)).toHaveLength(1);
    }
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
    ['Poker Masters 2026 | Event #5 - Day 1','PokerGO','poker','the 2026 poker masters event #five day one'],
    ['Live Poker | $10/$25 No-Limit Holdem Cash Game','TCH Live','poker','the $10/$25 stakes'],
    ['YANDY DÍAZ WITH A 2-RUN SHOT!','MLB','sports',"Yandy Díaz's two-run home run"],
  ] as const)('recognizes only the closed extracted subject as relevance evidence: %s', (title, source, domainHint, subject) => {
    const brief = briefForAsset({kind:'video', title, source, domainHint});
    expect(relevanceOf(`I'd look at ${subject}`, brief)).toBeGreaterThanOrEqual(.3);
    expect(relevanceOf('An unrelated anecdote about holidays', brief)).toBe(0);
  });
  it('does not award typed-subject relevance to incomplete or different fact bindings', () => {
    const event = briefForAsset({kind:'video', title:'Poker Masters 2026 | Event #5 - Day 1', source:'PokerGO', domainHint:'poker'});
    expect(relevanceOf('the 2026 Poker Masters Event #5', event)).toBeLessThan(.3);
    expect(relevanceOf('the 2026 Poker Masters Event #6 Day 1', event)).toBeLessThan(.3);
    const homer = briefForAsset({kind:'video', title:'YANDY DÍAZ WITH A 2-RUN SHOT!', source:'MLB', domainHint:'sports'});
    expect(relevanceOf("Yandy Díaz's", homer)).toBeLessThan(.3);
    expect(relevanceOf("Yandy Díaz's three-run home run", homer)).toBeLessThan(.3);
  });
  it.each(['Folding the 3rd Nuts?','No Pair Call All-in?','Representing Top Pair as Bluff?','What Does This River Bet Mean?','Monster Flush Draw: Flat Or Shove?','Can We Fold Top Set Here?','Should Hero Call This Flop Jam?'])('frames the literal Bart Hanson question without claiming the decision happened: %s', title => {
    const brief = briefForAsset({kind:'video', title, source:'Bart Hanson', domainHint:'poker'});
    const result = composeCaption(brief, styleSheetFor('15165d49-c7b3-42bc-b2e9-f46195e151ec'));
    expect(result.text).not.toBe('');
    expect(result.semanticKey).toContain('poker_question');
    expect(result.relevance).toBeGreaterThanOrEqual(.3);
    expect(result.text).not.toMatch(/\b(?:result|outcome|winner|won|lost)\b/i);
    expect(composeCaption({...brief, source:'Unknown'}, styleSheetFor('15165d49-c7b3-42bc-b2e9-f46195e151ec')).text).toBe('');
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
