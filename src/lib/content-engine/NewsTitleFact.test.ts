import { describe, expect, it } from 'vitest';
import { newsTitleFact } from './NewsTitleFact.js';
import { briefForAsset } from './PostBrief.js';

const brief = (title: string, domainHint: 'poker' | 'sports' = 'poker') => briefForAsset({ kind: 'link', title, domainHint, source: domainHint === 'poker' ? 'PokerNews' : 'ESPN News' });

describe('literal illustrated news facts', () => {
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
    const article = brief('APT Championship offers $8.1 million guaranteed');
    expect(newsTitleFact({ ...article, kind: 'video' })).toBeNull();
    expect(newsTitleFact({ ...article, domain: 'sports' })).toBeNull();
  });
});
