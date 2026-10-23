import {expect,it} from 'vitest';
import {briefForAsset} from './PostBrief.js';
import {composeCaption,RELEVANCE_FLOOR} from './Composer.js';
import {subjectCaption} from './CaptionVoice.js';
import {styleSheetFor} from './StyleSheet.js';
it.each([
 ['INSANE CLASH! $456,000 ALL-IN!','PokerGO',/the \$456,000 all-in/i,'meaning:subject:all in amount 456000 unit dollars:all_in_context:ranges'],
 ['$1,085,500 ALL-IN SWEAT!','PokerGO',/the \$1,085,500 all-in/i,'meaning:subject:all in amount 1085500 unit dollars:all_in_context:ranges'],
 ['QQ in a Six-Way Pot','Mariano',/the (?:6|six)-way pot/i,'meaning:subject:pot players 6:pot_context:structure'],
 ['High Stakes Poker LIVE Highlights with a THREE WAY ALL-IN!','PokerGO',/the (?:3|three)-way all-in/i,'meaning:subject:all in players 3:all_in_context:ranges'],
 ['Aces Cracked','Mariano',/pocket aces are cracked/i,'meaning:subject:holding aa cracked:aces_cracked_context:runout'],
] as const)('states actual quantity/context without generic invented discussion: %s',(title,source,expected,key)=>{
 const brief=briefForAsset({kind:'video',title,source,domainHint:'poker'});
 for(let author=0;author<24;author++){
  const style=styleSheetFor(`literal-quantity-${author}`);
  expect(subjectCaption(brief,style)?.semanticKey).toBe(key);
  const out=composeCaption(brief,style,'0');
  expect(out.text).toMatch(expected);
  expect(out.text).not.toMatch(/curious|I'd|I would|opposing|structure before|what |which |\?/i);
  expect(out.relevance).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
 }
});
