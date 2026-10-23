import {expect,it} from 'vitest';
import {briefForAsset} from './PostBrief.js';
import {composeCaption,RELEVANCE_FLOOR} from './Composer.js';
import {subjectCaption} from './CaptionVoice.js';
import {styleSheetFor} from './StyleSheet.js';
it.each([
 ['QQ in a Six-Way Pot','Mariano',/the (?:6|six)-way pot/i,'meaning:subject:pot players 6:pot_context:structure'],
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
