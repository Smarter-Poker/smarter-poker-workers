import {describe,it,expect} from 'vitest';
import {briefForAsset} from './PostBrief.js';
import {newsTitleFact} from './NewsTitleFact.js';
import {composeCaption,RELEVANCE_FLOOR} from './Composer.js';
import {styleSheetFor} from './StyleSheet.js';

// Literal RSS headlines retained in current-news-facts-20261022.json.
// The break caught here is rejecting new, explicitly bound results while
// exhausted older results are the only captionable inventory.
const cases=[
  ['Keith Lehr Captures Poker Masters Event No. 8 Title','keith lehr','poker masters'],
  ['Jeremy Ausmus Wins Poker Masters Event #7 for 10th PGT Title','jeremy ausmus','poker masters'],
  ['Jeremy Ausmus Locks Up 10th PGT Trophy At 2026 Poker Masters','jeremy ausmus','poker masters'],
  ['Justin Vaysman Comes Back From 0.25 Big Blinds To Win A Poker Masters Title','justin vaysman','poker masters'],
  ['Justin Vaysman mounts chip-and-a-chair comeback to win first PGT title at Poker Masters','justin vaysman','poker masters'],
  ['Ivelin Kolev Wins WPT Prime Cyprus Champions for $171,600','ivelin kolev','wpt prime cyprus champions'],
  ['Shawn Murphy Dominates Day 2 to Win RGPS Houston $600 Main Event for $51,000!','shawn murphy','rgps houston 600 main event'],
  ['Sam Chartier Wins MSPT Canadian Poker Championship at Playground for Largest-Ever Score on Home Soil','sam chartier','mspt canadian poker championship'],
  ['Umut Ozturk Conquers FireKeepers For Second MSPT Main Event Title Of 2026','umut ozturk','mspt firekeepers main event'],
] as const;
describe('current news result supply without title-salted novelty',()=>{
  it.each([
    [cases[0][0],'Poker Masters Event 8 went to Keith Lehr'],
    [cases[1][0],'Jeremy Ausmus won Poker Masters Event 7 for his 10th PGT title'],
    [cases[3][0],'Justin Vaysman won a Poker Masters title after coming back from 0.25 big blinds'],
    [cases[4][0],'Justin Vaysman won his first PGT title at Poker Masters'],
    [cases[5][0],'Ivelin Kolev won WPT Prime Cyprus Champions for $171,600'],
    [cases[6][0],'Shawn Murphy won RGPS Houston $600 Main Event for $51,000'],
    [cases[7][0],'Sam Chartier won MSPT Canadian Poker Championship at Playground'],
    [cases[8][0],'Umut Ozturk won his second MSPT Main Event title of 2026 at FireKeepers'],
  ])('retains the concrete report detail rather than flattening it: %s',(title,want)=>{
    const brief=briefForAsset({kind:'link',title,source:'PokerNews',domainHint:'poker'});
    const draft=composeCaption(brief,styleSheetFor('report-detail'), '0');
    expect(draft.text).toContain(want);
  });
  it.each(cases)('binds the literal actor/event in %s',(title,actor,event)=>{
    const brief=briefForAsset({kind:'link',title,source:'PokerNews',domainHint:'poker'});
    expect(newsTitleFact(brief)?.identity).toBe(`news:win:actor:${actor}:event:${event}`);
    for(let i=0;i<12;i++){
      const draft=composeCaption(brief,styleSheetFor(`source-author-${i}`),String(i%6));
      expect(draft.text).not.toBe('');
      expect(draft.relevance).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
      expect(draft.text).not.toMatch(/\?|I watched|I played|my win|available details|what context/i);
    }
  });
  it('collapses the same Ausmus result across publishers and career-title wording',()=>{
    const identities=cases.slice(1,3).map(([title])=>newsTitleFact(briefForAsset({kind:'link',title,source:'CardPlayer',domainHint:'poker'}))?.identity);
    expect(identities).toEqual(['news:win:actor:jeremy ausmus:event:poker masters','news:win:actor:jeremy ausmus:event:poker masters']);
  });
  it.each([
    'Keith Lehr Might Capture Poker Masters Event No. 8 Title',
    'Keith Lehr Does Not Capture Poker Masters Event No. 8 Title',
    'Unknown Person Captures Poker Masters Event No. 8 Title',
    'Keith Lehr Captures Unknown Tournament Title',
    'Jeremy Ausmus Wins Poker Masters Event #7 for 10th PGT Title and Keith Lehr Loses',
  ])('refuses unsupported or compound roles: %s',title=>{
    expect(newsTitleFact(briefForAsset({kind:'link',title,source:'PokerNews',domainHint:'poker'}))).toBeNull();
  });
});
