import { describe, expect, it } from 'vitest';
import { composeCaption, relevanceOf, RELEVANCE_FLOOR } from './Composer.js';
import { captionFact, literalNewsReportClauses, literalSportInventoryClauses, subjectCaption } from './CaptionVoice.js';
import { briefForAsset } from './PostBrief.js';
import { styleSheetFor } from './StyleSheet.js';

const cases: Array<[string, 'poker' | 'sports']> = [
  ["888's Aaron Barone Wins PokerNews Online Championship Event", 'poker'],
  ['Grantas Naujokas Joins Poker Royalty With Kings of Tallinn Title', 'poker'],
  ["Joe Hachem Back in the Winner's Circle at Victorian Poker Championship", 'poker'],
  ['Marius Conan Takes Home the 888LIVE London Main Event Title (£91,170)', 'poker'],
  ['Adrian Mateos Wins Poker Masters Title After Three Money Bubbles', 'poker'],
  ['Vitalijs Zavorotnijs Wins Poker Masters Event No. 4', 'poker'],
  ['Joey Weissman Secures Fifth PGT Trophy At Poker Masters', 'poker'],
  ['Nicholas Palma Scores First PGT Title At Poker Masters', 'poker'],
  ['Myles Mullaly Opens 2026 Poker Masters With First PGT Title', 'poker'],
  ['Robert Gianquitti Wins WSOP Circuit Pompano Beach Main Event', 'poker'],
  ['Brandon Wilson Wins Super High Roller Bowl XI For $1.1 Million', 'poker'],
  ['London Proves Bryan Taylor\'s "Lucky Charm" on His Way to the 888LIVE High Roller Title', 'poker'],
  ['Thunder agree to 5-year, $139M extension with guard Wallace', 'sports'],
  ['Suns, center Ighodaro agree to 3-year, $29M extension', 'sports'],
  ['Kings guard Simmons has torn Achilles tendon, will undergo surgery', 'sports'],
  ["Warriors' Curry 'fine' after tweaking right ankle in practice", 'sports'],
];

describe('source-bound news report voice', () => {
  it('does not turn an individual event win into a festival or series championship',()=>{
    for(const title of ['Vitalijs Zavorotnijs Wins Poker Masters Event No. 4',"888's Aaron Barone Wins PokerNews Online Championship Event"]){
      const b=briefForAsset({kind:'link',title,domainHint:'poker',source:'PokerNews'});
      const clauses=literalNewsReportClauses(captionFact(b)!);
      expect(clauses.every(clause=>/\b(?:win|won) at\b/.test(clause))).toBe(true);
      expect(clauses.join(' ')).not.toMatch(/is the .* winner/);
    }
  });
  it('weights only complete literal report clauses, not actors or altered outcomes', () => {
    const brief = {...briefForAsset({kind:'link', title:'Brandon Wilson Wins Super High Roller Bowl XI For $1.1 Million', domainHint:'poker', source:'PokerNews'}),
      people:[], teams:[], concepts:[], amounts:[], topic:undefined, keyPhrase:undefined};
    const clauses = literalNewsReportClauses(captionFact(brief)!);
    expect(clauses).toHaveLength(2);
    for (const clause of clauses) expect(relevanceOf(clause, brief)).toBe(0.5);
    for (const wrong of ['Brandon Wilson lost Super High Roller Bowl XI', 'Someone Else won Super High Roller Bowl XI', 'Brandon Wilson won a different tournament', 'Brandon Wilson']) {
      expect(relevanceOf(wrong, brief)).toBe(0);
    }
  });
  it.each(cases)('renders the literal proposition without generic focus: %s', (title, domainHint) => {
    const brief = briefForAsset({kind:'link', title, domainHint, source:domainHint === 'poker' ? 'PokerNews' : 'ESPN News'});
    for (let author = 1; author <= 24; author++) {
      const style = styleSheetFor(`00000000-0000-0000-0000-${String(author).padStart(12,'0')}`);
      const keys = new Set<string>();
      for (let draft = 0; draft < 6; draft++) {
        const subject = subjectCaption(brief, style, String(draft));
        expect(subject?.text).not.toMatch(/available details|reported details|available context|which details|what context|I'd|I would|my focus|before judging|outcome|what do you/i);
        expect(subject?.text).not.toContain('?');
        const caption = composeCaption(brief, style, String(draft));
        expect(caption.text).not.toBe('');
        expect(caption.relevance).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
        keys.add(caption.semanticKey!);
      }
      expect(keys.size).toBe(1);
    }
  });
});

describe('additional literal sports proposition rendering', () => {
  it('credits the qualified strikeout but not unsupported or reversed roles', () => {
    expect(literalSportInventoryClauses({person:'', action:'sports_technical_context', identity:'basketball:dunk:actor:lebron james',subject:"LeBron James's dunk"})).toEqual([]);
    expect(literalSportInventoryClauses({person:'', action:'sports_technical_context', identity:'baseball:strikeout:pitcher:chris sale:batter:bryce harper',subject:'Chris Sale striking out Bryce Harper'})).toEqual(['Chris Sale struck out Bryce Harper']);
    const brief={...briefForAsset({kind:'video',title:'Cam Skattebo recorded 0 carries on 6 snaps',source:'Bleacher Report NBA',domainHint:'sports'}),people:[],teams:[],concepts:[],amounts:[],topic:undefined,keyPhrase:undefined};
    expect(relevanceOf('Cam Skattebo recorded 0 carries on 6 snaps',brief)).toBe(.5);
    expect(relevanceOf('Cam Skattebo recorded 6 carries on 0 snaps',brief)).toBe(0);
    expect(relevanceOf('Cam Skattebo recorded 0 snaps on 6 carries',brief)).toBe(0);
  });
  it.each([
    ['Cam Skattebo recorded 0 carries on 6 snaps','Bleacher Report NBA'],
    ['Damien Pierce scores a touchdown against the Panthers','Eagles'],
    ['Kenny Clark gets the third down sack','Cowboys'],
    ['Jalen Duren had 24 PTS in 15 minutes','Bleacher Report NBA'],
    ['Steal by Paul George','Celtics'],
    ['Scoot Henderson Chasedown Block','NBA'],
    ['Caleb Wilson dunks','NBA'],
    ['DeMar DeRozan makes a basket','NBA'],
    ['Darryn Peterson Back-to-Back And-1 Buckets','NBA'],
    ['Darius Acuff Jr. with the ball on a string for his first NBA bucket','NBA'],
    ['John Elmore gets his first bucket as a Spur','NBA'],
    ['LeBron James gets his first bucket as a 76er','NBA'],
    ['Giannis gets downhill for his first Heat bucket','NBA'],
    ["Matthews' OT WINNER",'NHL'],
    ['Igor Shesterkin scores a goalie goal','Rangers'],
    ['Didier Fuentes strikes out Shohei Ohtani','FOX Sports'],
    ['Fred VanVleet makes a between-the-legs assist','NBA'],
    ['Abner Uribe gets a strikeout with two runners on','MLB'],
    ['Will Smith puts the Dodgers in front','MLB'],
    ['Jake Cronenworth puts the Padres in front','MLB'],
    ['Jokić throws a dime behind his back','NBA'],
    ['Brady Tkachuk Pass','NHL'],
  ])('states the literal role rather than a shared focus: %s', (title, source) => {
    const brief = briefForAsset({kind:'video',title,source,domainHint:'sports'});
    for (let author=1; author<=8; author++) for(let draft=0;draft<6;draft++) {
      const style=styleSheetFor(`00000000-0000-0000-0000-${String(author).padStart(12,'0')}`);
      const subject=subjectCaption(brief,style,String(draft));
      expect(subject?.text).not.toMatch(/sequence around|look at|details|focus|context|what|I'd|I would|judg/i);
      expect(subject?.text).not.toContain('?');
      const result=composeCaption(brief,style,String(draft));
      expect(result.text).not.toBe('');
      expect(result.relevance).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
      expect(result.semanticKey).toMatch(/:sports_technical_context:literal_sequence$/);
    }
  });
});
