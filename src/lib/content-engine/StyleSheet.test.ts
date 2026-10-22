import {describe,it,expect} from 'vitest';
import {captionEmojiPreference,render,styleSheetFor,withCaptionEmoji} from './StyleSheet.js';
import {composeCaption} from './Composer.js';
import {briefForAsset} from './PostBrief.js';

const profiles = Array.from({length:1000},(_,i)=>styleSheetFor(`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`));
const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
describe('conversational caption rendering',()=>{
  it('preserves literal numbered-event labels even in a words-numeral voice',()=>{
    const style={...profiles[0]!,numerals:'words' as const,opener:'none' as const,closer:'none' as const,casing:'sentence' as const};
    const text=render(['Poker Masters Event #7, Event 8 and Day 2'],style,'event-labels');
    expect(text).toContain('Event #7');expect(text).toContain('Event 8');expect(text).toContain('Day 2');
    expect(text).not.toMatch(/#seven|Event eight|Day two/);
  });
  it('keeps a name suffix inside its sentence while capitalizing the next real sentence',()=>{
    const style={...profiles[0]!,opener:'none' as const,closer:'none' as const,casing:'sentence' as const,punctuation:'full' as const};
    const text=render(['Darius Acuff Jr. made his first NBA basket. what a debut?'],style,'suffix');
    expect(text).toContain('Darius Acuff Jr. made');
    expect(text).toContain('basket. What');
    expect(text).not.toContain('Jr. Made');
  });
  it('drops decorative labels/list dashes while preserving scores, odds, times, names and cards',()=>{
    const text=render(['- My take: king-ten on As Kd Qh, 3-0 at 12:30 with 4:1 odds'],{...profiles[0]!,opener:'none',closer:'none',casing:'sentence'},'fixed');
    expect(text).not.toMatch(/^\s*[-*]|take:|—/);
    for(const fact of ['king-ten','As Kd Qh','3-0','12:30','4:1'])expect(text).toContain(fact);
  });
  it('adds at most one topic-bound emoji occasionally, with stable preference and content identity',()=>{
    let decorated=0,never=0;
    for(const profile of profiles){
      if(!captionEmojiPreference(profile))never++;
      for(const topic of ['poker','basketball','baseball','soccer'] as const){
        const text=withCaptionEmoji('A grounded question?',profile,'same-content',topic);
        expect(text).toBe(withCaptionEmoji('A grounded question?',profile,'same-content',topic));
        expect([...text.matchAll(emoji)].length).toBeLessThanOrEqual(1);
        expect(text).toMatch(/\?$/);
        expect(withCaptionEmoji('text',profile,'same-content')).toBe('text');
        if(text!=='A grounded question?')decorated++;
      }
    }
    expect(never).toBeGreaterThan(350);expect(never).toBeLessThan(650);
    expect(decorated).toBeGreaterThan(200);expect(decorated).toBeLessThan(1000);
  });
  it('makes real captions conversational, not colon labels or formal assessment templates',()=>{
    const titles=['Phil Ivey fires a river bluff','Phil Ivey makes a huge river call','Trailblazer Warm-Up $30K GTD','Stephen Curry hits a three pointer'];
    for(const profile of profiles)for(const title of titles){
      const b=briefForAsset({kind:'video',title,source:title.includes('Curry')?'NBA':'PokerGO',domainHint:title.includes('Curry')?'sports':'poker'});
      const out=composeCaption(b,profile);
      expect(out.text).not.toBe('');
      expect(out.text).not.toMatch(/:|—|\bassessment\b|\bexamine\b|^\s*[-*]/i);
      expect(out.text).not.toMatch(/I (?:watched|played|won|lost)|last night|when I was/i);
      expect(out.text).not.toMatch(/pot odds comes|ranges comes|details is|combinations comes|does (?:pot odds|the ranges|the combinations)/i);
      expect([...out.text.matchAll(emoji)].length).toBeLessThanOrEqual(1);
      if(out.text.includes('?'))expect(out.text).toMatch(/\?$/);
      expect(composeCaption(b,profile,'0')).toEqual(out);
      if(title.includes('GTD'))expect(out.text).not.toMatch(/\bresult\b|\boutcome\b/i);
    }
  });
  it('does not let input emoji survive the renderer or manufacture factual freshness',()=>{
    const b=briefForAsset({kind:'video',title:'Phil Ivey makes a huge river call',domainHint:'poker',source:'PokerGO'});
    for(const profile of profiles.slice(0,100)){
      const text=render(['untrusted \u{1F525}'],profile,'seed',{noOpener:true,noCloser:true});
      expect(text).not.toMatch(emoji);
      const ordinary=composeCaption(b,profile),other=composeCaption({...b,postId:'different-asset'},profile);
      expect(ordinary.semanticKey).toBe(other.semanticKey);
      expect(ordinary.text).toBe(other.text);
    }
  });
  it('uses typed sport facts instead of a misleading channel label for emoji',()=>{
    const b=briefForAsset({kind:'link',title:'Brewers sweep Dodgers in NLCS, advance to 1st World Series in 44 years',domainHint:'sports',source:'Bleacher Report NBA'});
    let decorated=0;
    for(const profile of profiles){
      const out=composeCaption(b,profile);
      expect(out.text).not.toContain('\u{1F3C0}');
      if(emoji.test(out.text)){expect(out.text).toContain('\u26BE');decorated++;}emoji.lastIndex=0;
    }
    expect(decorated).toBeGreaterThan(0);
  });
});
