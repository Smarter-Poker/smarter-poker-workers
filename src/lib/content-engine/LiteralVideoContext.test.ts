import {describe,it,expect} from 'vitest';
import {briefForAsset} from './PostBrief.js';
import {subjectCaption} from './CaptionVoice.js';
import {styleSheetFor} from './StyleSheet.js';
import {composeCaption} from './Composer.js';

// Minimal controlled source labels, not reconstructed actual registry titles.
describe('literal video context without invented discussion filler',()=>{
  it.each([
    ['Save the Dates: 2027 Irish Poker Open Runs March 18-29 in Dublin','The 2027 Irish Poker Open runs March 18-29 in Dublin.'],
    ['Kick 2027 Off In Style at PokerStars Open Campione; New €1,250 Main Event Buy-In','The 2027 PokerStars Open Campione Main Event buy-in is €1,250.'],
    ['Four-year chase ends in gold: Frankie Cucchiara wins first WSOP bracelet','Frankie Cucchiara won his first WSOP bracelet.'],
    ['Negreanu denied at Poker Masters as Nick Seward wins $412K and first PGT title','Nick Seward won $412K and his first PGT title at Poker Masters.'],
    ['WSOP slashes Paradise rake across 12 events following criticism','WSOP reduced Paradise rake across 12 events.'],
  ])('renders concrete new report without advisory fallback: %s',(title,text)=>{
    const brief=briefForAsset({kind:'link',title,source:'PokerNews',domainHint:'poker'});
    expect(subjectCaption(brief,styleSheetFor('report-author'))?.text).toBe(text);
  });
  it.each([
    ['Cash game $2/$5','TCH Live','The $2/$5 stakes.','meaning:subject:stakes 2 5 unit dollars:stakes_context:effective_stacks'],
    ['Big Mike, Mariano & Dylan Flashner Play HIGH STAKES $50/100! Commentary by David Tuchman','Hustler Casino Live','The $50/$100 stakes.','meaning:subject:stakes 50 100 unit dollars:stakes_context:effective_stacks'],
    ['LIVE POKER | $10/$25 No Limit Hold’em Cash Game | TCHLIVE Dallas','TCH Live','The $10/$25 stakes.','meaning:subject:stakes 10 25 unit dollars:stakes_context:effective_stacks'],
    ['LIVE POKER | $2/$5 No-Limit Hold’em Cash Game | TCH Social Austin','TCH Live','The $2/$5 stakes.','meaning:subject:stakes 2 5 unit dollars:stakes_context:effective_stacks'],
    ['Super High Roller Bowl Day 2 Highlights with The Foxen’s, Petrangelo & Nick Schulman','PokerGO','The Super High Roller Bowl Day 2.','meaning:subject:poker event super high roller bowl stage day 2:poker_event_context:event_stage'],
    ['Super High Roller Bowl Day 2','PokerGO','The Super High Roller Bowl Day 2.','meaning:subject:poker event super high roller bowl stage day 2:poker_event_context:event_stage'],
  ])('states only supplied context in %s',(title,source,text,key)=>{
    const brief=briefForAsset({kind:'video',title,source,domainHint:'poker'});
    for(const id of ['terse-author','developed-author','other-author'])for(let retry=0;retry<6;retry++){
      const result=subjectCaption(brief,styleSheetFor(id),String(retry));
      expect(result?.text).toBe(text);
      expect(result?.semanticKey).toBe(key);
      expect(result?.text).not.toMatch(/buy-in|position|field size|players|I'd|take on|cash game|won/);
      const composed=composeCaption(brief,styleSheetFor(id),String(retry));
      expect(composed.text).not.toBe('');
      expect(composed.relevance).toBeGreaterThanOrEqual(.3);
    }
  });
});
