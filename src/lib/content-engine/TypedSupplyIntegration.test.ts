import {expect,it} from 'vitest';
import {briefForAsset} from './PostBrief.js';
import {captionFact,subjectCaption} from './CaptionVoice.js';
import {composeCaption,RELEVANCE_FLOOR} from './Composer.js';
import {styleSheetFor} from './StyleSheet.js';

it('renders a source-bound strategy topic through the real composer without a title fallback',()=>{
 const brief=briefForAsset({kind:'link',domainHint:'poker',source:'Upswing Poker',title:'Lose Less, Win More: The Fundamentals of Big Blind Defense'});
 expect(captionFact(brief)?.identity).toBe('poker_strategy:big_blind_defense');
 for(let author=0;author<24;author++){
  const out=composeCaption(brief,styleSheetFor(`typed-source-${author}`),'0');
  expect(out.text).toMatch(/big.blind defense/i);
  expect(out.text).not.toMatch(/I (?:played|watched)|my (?:win|hand)|what context|\?/i);
  expect(out.relevance).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
 }
});
it('keeps the legacy stake meaning instead of assigning a new topic identity',()=>{
 const brief=briefForAsset({kind:'video',domainHint:'poker',source:'TCH Live',title:"LIVE POKER | $2/$5 No-Limit Hold'em Cash Game | TCH Social Austin"});
 expect(subjectCaption(brief,styleSheetFor('typed-source-0'))?.semanticKey).toBe('meaning:subject:stakes 2 5 unit dollars:stakes_context:effective_stacks');
});
it('renders a typed public sports sequence without adding a game result',()=>{
 const brief=briefForAsset({kind:'video',domainHint:'sports',source:'NBA',title:'Chet Holmgren Goes From BLOCK To BUCKET In Seconds 😤'});
 expect(captionFact(brief)?.identity).toBe('typed_sports_action:block_bucket:actor:chet holmgren');
 for(let author=0;author<24;author++){
  const out=composeCaption(brief,styleSheetFor(`typed-source-${author}`),'0');
  expect(out.text).toMatch(/Chet Holmgren goes from a block to a bucket/i);
  expect(out.text).not.toMatch(/win|title|final score|what context|\?/i);
  expect(out.relevance).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
 }
});
