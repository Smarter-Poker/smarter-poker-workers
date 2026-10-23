import {describe,it,expect} from 'vitest';
import {briefForAsset} from './PostBrief.js';
import {newsTitleFact} from './NewsTitleFact.js';
import {composeCaption,RELEVANCE_FLOOR} from './Composer.js';
import {styleSheetFor} from './StyleSheet.js';

const actual="Peng Huang Wins KPC Jeju Main Event; Denied Heads-Up in King's Main Event";
const brief=(title:string,source='PokerNews')=>briefForAsset({kind:'link',title,source,domainHint:'poker'});
describe('source-explicit named tournament win with separate contextual event',()=>{
  it('retains the explicit first win without claiming the second event was won',()=>{
    expect(newsTitleFact(brief(actual))).toEqual({person:'',action:'news_report_context',identity:'news:win:actor:peng huang:event:kpc jeju main event',subject:"Peng Huang's KPC Jeju Main Event win"});
  });
  it('canonicalizes equivalent standalone title across casing and publishers',()=>{
    const expected='news:win:actor:peng huang:event:kpc jeju main event';
    for(const title of [actual,'Peng Huang Wins KPC Jeju Main Event','PENG HUANG WINS KPC JEJU MAIN EVENT']){
      for(const source of ['PokerNews','CardPlayer'])expect(newsTitleFact(brief(title,source))?.identity).toBe(expected);
    }
  });
  it('composes only the literal named win for different authors without creating fresh meaning',()=>{
    for(const author of ['peng-a','peng-b','peng-c']){
      const caption=composeCaption(brief(actual),styleSheetFor(author),'0');
      expect(caption.text).toMatch(/^Peng Huang (?:won|recorded a win) at KPC Jeju Main Event(?:[.!…]|$)/i);
      expect(caption.text).not.toMatch(/King|heads.up/i);
      expect(caption.semanticKey).toBe('meaning:subject:news win actor peng huang event kpc jeju main event:news_report_context:report_context');
      expect(caption.relevance).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
    }
  });
  it.each([
    'Will Peng Huang Win KPC Jeju Main Event?',
    'Peng Huang Could Win KPC Jeju Main Event',
    'Peng Huang Does Not Win KPC Jeju Main Event',
    'Unknown Player Wins KPC Jeju Main Event',
    "Peng Huang Wins King's Main Event",
    'Peng Huang Wins Unregistered Main Event',
    'Peng Huang Wins KPC Jeju Main Event; Wins Another Tournament',
    "Peng Huang Wins KPC Jeju Main Event; Denied Heads-Up in Unknown Main Event",
  ])('refuses unbound or hypothetical result: %s',title=>expect(newsTitleFact(brief(title))).toBeNull());
});
