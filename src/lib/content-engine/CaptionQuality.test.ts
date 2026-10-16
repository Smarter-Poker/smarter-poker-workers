import {describe, it, expect} from 'vitest';
import {captionQuality, captionShape, captionConvergencePenalty} from './CaptionQuality.js';
import {briefForAsset} from './PostBrief.js';
import {composeCaption} from './Composer.js';
import {captionVoiceProfile} from './CaptionVoice.js';
import {styleSheetFor} from './StyleSheet.js';

describe('free maintained caption quality', () => {
  it('rejects the actual compound-source repetition independently of literal headlines', () => {
    const subject = 'the $8.1 million guarantee';
    const bad = `The result alone does not settle ${subject}. What are the terms of ${subject}?`;
    expect(captionQuality(bad, {subject}).reasons).toContain('repeated_source_subject');
    expect(captionQuality(`For ${subject}, what are the published terms?`, {subject}).pass).toBe(true);
  });
  it('rejects repeated phrases and nearly identical ideas in separate clauses', () => {
    expect(captionQuality('I want the ranges reaching the river. Check the ranges reaching the river.').reasons).toContain('repeated_phrase');
    expect(captionQuality('Examine the represented value range carefully. Examine the represented value range carefully again.').reasons).toContain('repeated_idea');
    expect(captionQuality('Reading from ESPN News: a headline').reasons).toContain('headline_wrapper');
    expect(captionQuality('What are the pot odds for that call? I would examine the equity required by the price.').reasons).toContain('repeated_focus');
    expect(captionQuality('').pass).toBe(false);
    expect(captionQuality('Looking beyond the result of the $100,000 guarantee for Trailblazer Warm-Up: Which details of the terms of the guarantee matter when assessing that guarantee?', {subject:'the $100,000 guarantee for Trailblazer Warm-Up'}).reasons).toContain('circular_event_focus');
    expect(captionQuality('I would separate the outcome of the $30,000 guarantee for Trailblazer Warm-Up from the details attached to the stated minimum', {subject:'the $30,000 guarantee for Trailblazer Warm-Up'}).reasons).toContain('guarantee_realized_result');
    expect(captionQuality('The result alone does not settle that call', {subject:"Phil Ivey's river call"}).pass).toBe(true);
  });
  it('does not equate two genuine grounded considerations or repeated rank/suit words', () => {
    expect(captionQuality('The price is my starting point for that call. I would work back through the ranges.').pass).toBe(true);
    expect(captionQuality('As Ks on Qs Js Ts. The spade holding matters.').pass).toBe(true);
  });
  it('measures repeated grammar softly without turning finite syntax into an embargo', () => {
    const a = 'I would check the effective stacks for the $50/$100 stakes';
    const b = 'I would examine the stack depth for the $10/$20 stakes';
    expect(captionShape(a)).toBe(captionShape(b));
    expect(captionConvergencePenalty(a, [b,b])).toBe(1);
    expect(captionConvergencePenalty('Which ranges reach that river?', [b,b])).toBe(0);
    expect(captionQuality(a).pass).toBe(true);
    expect(captionConvergencePenalty(a, [])).toBe(0);
  });
  it('realizes distinct stable lexical and question habits across 1000 multi-context profiles', () => {
    const contexts = [
      ['Phil Ivey fires a river bluff','poker'], ['Phil Ivey makes a huge river call','poker'],
      ['Daniel Negreanu folds the river','poker'], ['Phil Ivey wins his 11th WSOP bracelet','poker'],
      ['Stephen Curry hits a three pointer','sports'], ['LeBron James dunks from the baseline','sports'],
    ] as const;
    const vectors: string[] = [];
    const habits = new Set<number>();
    for (let i=0; i<1000; i++) {
      const style = styleSheetFor(`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`);
      habits.add(captionVoiceProfile(style).questionHabit);
      const outputs = contexts.map(([title,domainHint]) => {
        const brief = briefForAsset({kind:'video',title,domainHint,source:domainHint==='poker'?'PokerGO':'NBA'});
        const out = composeCaption(brief,style);
        expect(out.text).not.toBe('');
        expect(captionQuality(out.text).pass).toBe(true);
        expect(out.semanticKey).toMatch(/^meaning:subject:/);
        expect(out.text).not.toMatch(/I (?:watched|played|won|lost)|last night|when I was|Reading from|reports:/i);
        expect(composeCaption(brief,style)).toEqual(out);
        return out.text.toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ');
      });
      vectors.push(outputs.join('|'));
    }
    expect(habits).toEqual(new Set([0,1,2,3]));
    expect(new Set(vectors).size).toBe(1000);
  });
});
