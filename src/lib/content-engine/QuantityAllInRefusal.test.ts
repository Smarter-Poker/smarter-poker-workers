import {it,expect} from 'vitest';
import {briefForAsset} from './PostBrief.js';
import {composeCaption} from './Composer.js';
import {subjectCaption} from './CaptionVoice.js';
import {styleSheetFor} from './StyleSheet.js';
it.each(['INSANE CLASH! $456,000 ALL-IN!','$1,085,500 ALL-IN SWEAT!','High Stakes Poker LIVE Highlights with a THREE WAY ALL-IN!'])('refuses quantity-only all-in focus without renaming its historical meaning: %s',title=>{
 const b=briefForAsset({kind:'video',title,source:'PokerGO',domainHint:'poker'});
 for(let a=0;a<24;a++)for(let d=0;d<6;d++){
  const s=styleSheetFor(`all-in-refusal-${a}`);
  expect(subjectCaption(b,s)?.semanticKey).toContain(':all_in_context:ranges');
  expect(composeCaption(b,s,String(d))).toEqual({text:'',relevance:0,grounding:[]});
 }
});
