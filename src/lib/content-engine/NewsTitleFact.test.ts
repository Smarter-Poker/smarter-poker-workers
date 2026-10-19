import { describe, expect, it } from 'vitest';
import { newsTitleFact } from './NewsTitleFact.js';
import { briefForAsset } from './PostBrief.js';
import { composeCaption, RELEVANCE_FLOOR } from './Composer.js';
import { styleSheetFor } from './StyleSheet.js';

const brief = (title: string, domainHint: 'poker' | 'sports' = 'poker') => briefForAsset({ kind: 'link', title, domainHint, source: domainHint === 'poker' ? 'PokerNews' : 'ESPN News' });

describe('literal illustrated news facts', () => {
  it.each([
    ["888's Aaron Barone Wins PokerNews Online Championship Event", 'aaron barone', 'pokernews online championship'],
    ['Grantas Naujokas Joins Poker Royalty With Kings of Tallinn Title', 'grantas naujokas', 'kings of tallinn'],
    ["Joe Hachem Back in the Winner's Circle at Victorian Poker Championship", 'joe hachem', 'victorian poker championship'],
    ['Marius Conan Takes Home the 888LIVE London Main Event Title (£91,170)', 'marius conan', '888live london main event'],
    ['Adrian Mateos Wins Poker Masters Title After Three Money Bubbles', 'adrian mateos', 'poker masters'],
    ['Adrian Mateos Secures Ninth PGT Title At Poker Masters, Leads Race For Purple Jacket', 'adrian mateos', 'poker masters'],
    ['Vitalijs Zavorotnijs Wins Poker Masters Event No. 4', 'vitalijs zavorotnijs', 'poker masters'],
    ['Joey Weissman Secures Fifth PGT Trophy At Poker Masters', 'joey weissman', 'poker masters'],
    ['Nicholas Palma Scores First PGT Title At Poker Masters', 'nicholas palma', 'poker masters'],
    ['Myles Mullaly Opens 2026 Poker Masters With First PGT Title', 'myles mullaly', 'poker masters'],
    ['Robert Gianquitti Wins WSOP Circuit Pompano Beach Main Event', 'robert gianquitti', 'wsop circuit pompano beach main event'],
    ['Brandon Wilson Wins Super High Roller Bowl XI For $1.1 Million', 'brandon wilson', 'super high roller bowl xi'],
    ['London Proves Bryan Taylor\'s "Lucky Charm" on His Way to the 888LIVE High Roller Title', 'bryan taylor', '888live london high roller'],
  ])('extracts only the literal result in current source headline: %s', (title, actor, event) => {
    const article = brief(title);
    expect(newsTitleFact(article)).toMatchObject({
      person: '', action: 'news_report_context', identity: `news:win:actor:${actor}:event:${event}`,
    });
    const drafts = Array.from({length:6}, (_, index) => composeCaption(article, styleSheetFor('00000000-0000-0000-0000-000000000002'), String(index)));
    expect(drafts.some(draft => draft.text && draft.relevance >= RELEVANCE_FLOOR && draft.semanticKey)).toBe(true);
    expect(new Set(drafts.filter(draft => draft.text).map(draft => draft.semanticKey)).size).toBe(1);
  });
  it('coalesces aliases, career ordinals and event detail across source variants', () => {
    const a = newsTitleFact(brief('Nicholas Palma Scores First PGT Title At Poker Masters'));
    const b = newsTitleFact(briefForAsset({kind:'link', domainHint:'poker', source:'CardPlayer', title:'Nick Palma wins Poker Masters title'}));
    expect(a?.identity).toBe('news:win:actor:nicholas palma:event:poker masters');
    expect(b?.identity).toBe(a?.identity);
    expect(newsTitleFact(brief('Nicholas Palma Secures Second PGT Trophy At Poker Masters'))?.identity).toBe(a?.identity);
    expect(newsTitleFact(brief('Adrian Mateos Wins Poker Masters Title After Three Money Bubbles'))?.identity)
      .toBe(newsTitleFact(brief('Adrian Mateos Secures Ninth PGT Title At Poker Masters, Leads Race For Purple Jacket'))?.identity);
    expect(newsTitleFact(brief('Vitalijs Zavorotnijs Wins Poker Masters Title'))?.identity)
      .toBe(newsTitleFact(brief('Vitalijs Zavorotnijs Wins Poker Masters Event No. 4'))?.identity);
  });
  it.each([
    ['Thunder agree to 5-year, $139M extension with guard Wallace', 'news:contract_extension:team:thunder:actor:wallace'],
    ['Suns, center Ighodaro agree to 3-year, $29M extension', 'news:contract_extension:team:suns:actor:ighodaro'],
    ['Kings guard Simmons has torn Achilles tendon, will undergo surgery', 'news:injury:team:kings:actor:simmons:injury:torn achilles tendon'],
    ["Warriors' Curry 'fine' after tweaking right ankle in practice", 'news:ankle_practice_update:team:warriors:actor:curry'],
  ])('binds literal sports actions without inferred diagnoses or terms: %s', (title, identity) => {
    const article = brief(title, 'sports');
    expect(newsTitleFact(article)).toMatchObject({person:'', action:'news_report_context', identity});
    const drafts = Array.from({length:6}, (_, index) => composeCaption(article, styleSheetFor('00000000-0000-0000-0000-000000000002'), String(index)));
    expect(drafts.some(draft => draft.text && draft.relevance >= RELEVANCE_FLOOR && draft.semanticKey)).toBe(true);
  });
  it.each([
    'Unknown Person Wins Poker Masters Title',
    'Aaron Barone Wins Unknown Tournament Title',
    'Adrian Mateos Watches Joey Weissman Win Poker Masters Title',
    'Adrian Mateos Does Not Win Poker Masters Title',
    'Will Nick Palma Win Poker Masters Title?',
    'Nick Palma Could Win Poker Masters Title',
    'Nick Palma Wins Poker Masters Title and Joey Weissman Loses',
    'Adrian Mateos Loses Poker Masters Title',
    'Joey Weissman Wins WSOP Bracelet Before Poker Masters',
    'Joey Weissman Ships $10K Tournament Days After Winning WSOP Bracelet',
    'Adrian Mateos Wins Poker Masters Event No. 0',
    'Adrian Mateos Wins Poker Masters Event No. 999',
  ])('refuses ambiguous, unsupported and conflicting result roles: %s', title => {
    expect(newsTitleFact(brief(title))).toBeNull();
  });
  it.each([
    'Thunder might agree to 5-year, $139M extension with guard Wallace',
    'Thunder agree to 5-year, $139M extension with guard Unknown',
    'Suns, center Wallace agree to 3-year, $29M extension',
    'Kings guard Simmons may have torn Achilles tendon, will undergo surgery',
    'Kings guard Simmons has torn Achilles tendon, will undergo surgery and retire',
    "Warriors' Curry not 'fine' after tweaking right ankle in practice",
  ])('refuses unsupported sports action claims: %s', title => expect(newsTitleFact(brief(title, 'sports'))).toBeNull());
  it('binds a guarantee to its event and canonical dollars without claiming winnings', () => {
    const fact = newsTitleFact(brief('APT Championship Returns to Taiwan in November With $8.1 Million Guaranteed'));
    expect(fact).toEqual({ person: '', action: 'news_guarantee', identity: 'event:apt championship:guarantee:8100000', subject: 'the $8.1M guarantee for APT Championship' });
    expect(newsTitleFact(brief('APT Championship $8,100,000 guaranteed'))?.identity).toEqual(fact?.identity);
    expect(newsTitleFact(brief('APT Championship offers $8100K guarantee'))?.identity).toEqual(fact?.identity);
  });
  it('binds the known actor, event and count in the actual bubble headline', () => {
    const fact = newsTitleFact(brief('Adrian Mateos Completes Unwanted Hat Trick of Poker Masters Bubbles'));
    expect(fact).toEqual({ person: 'Adrian Mateos', action: 'news_bubble', identity: 'person:adrian mateos:event:poker masters:bubbles:3', subject: "Adrian Mateos's three Poker Masters bubble finishes" });
    expect(newsTitleFact(brief('Adrian Mateos bubbles Poker Masters for the third time'))).toEqual(fact);
  });
  it('binds the teams in the correct result direction and canonical series', () => {
    const fact = newsTitleFact(brief('Brewers sweep Dodgers in NLCS, advance to 1st World Series in 44 years', 'sports'));
    expect(fact).toEqual({ person: '', action: 'news_sweep', identity: 'team:brewers:opponent:dodgers:series:nlcs:sweep', subject: 'the Brewers sweep of the Dodgers in the NLCS' });
    expect(newsTitleFact(brief('Brewers complete the NLCS sweep of Dodgers', 'sports'))).toEqual(fact);
    expect(newsTitleFact(brief('Dodgers sweep Brewers in NLCS', 'sports'))?.identity).not.toBe(fact?.identity);
  });
  it.each([
    'Will APT Championship offer $8.1 million guaranteed?',
    'APT Championship might offer $8.1 million guaranteed',
    'APT Championship not $8.1 million guaranteed',
    'APT Championship announces $8,10,000 guaranteed',
    'APT Championship offers $8.1 million buy-in',
    'APT Championship awards $8.1 million',
    'APT Championship offers $8.1 million guaranteed and $9 million guaranteed',
    'Unknown Event offers $8.1 million guaranteed',
    'Unknown Person Completes Unwanted Hat Trick of Poker Masters Bubbles',
    'Adrian Mateos Watches Phil Ivey Complete Hat Trick of Poker Masters Bubbles',
    'Adrian Mateos might complete a hat trick of Poker Masters bubbles',
    'Adrian Mateos Completes Hat Trick of Poker Masters Bubbles and WPT Bubbles',
  ])('refuses unsupported or conflicting poker claims: %s', title => expect(newsTitleFact(brief(title))).toBeNull());
  it.each([
    'Brewers might sweep Dodgers in NLCS',
    'Will Brewers sweep Dodgers in NLCS?',
    'Brewers do not sweep Dodgers in NLCS',
    'Brewers sweep Dodgers in NLCS and Cubs sweep Mets',
    'Brewers sweep Brewers in NLCS',
    'Brewers sweep Unknowns in NLCS',
    'Brewers sweep Dodgers in mystery series',
    'Lakers sweep Celtics in NLCS',
  ])('refuses unsupported sports claims: %s', title => expect(newsTitleFact(brief(title, 'sports'))).toBeNull());
  it('does not broaden this news extraction into video or cross-domain claims', () => {
    for (const title of ['APT Championship offers $8.1 million guaranteed', 'Adrian Mateos Wins Poker Masters Title']) {
      const article = brief(title);
      expect(newsTitleFact({ ...article, kind: 'video' })).toBeNull();
      expect(newsTitleFact({ ...article, domain: 'sports' })).toBeNull();
      expect(newsTitleFact({ ...article, isQuestion: true })).toBeNull();
    }
  });
});
