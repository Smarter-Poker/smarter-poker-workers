import { describe, it, expect } from 'vitest';
import { captionFact, captionHolding, captionVoiceProfile, subjectCaption } from './CaptionVoice.js';
import { briefForAsset } from './PostBrief.js';
import { composeCaption } from './Composer.js';
import { styleId, styleSheetFor } from './StyleSheet.js';

const brief = (title: string, domainHint: 'poker' | 'sports' = 'poker') => briefForAsset({kind:'video', title, domainHint, source:domainHint==='poker'?'PokerGO':'NBA'});
const ids = Array.from({ length: 1000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12,'0')}`);

describe('source-bound individual caption voices', () => {
  it('covers every one of 1000 identities with a stable full specification, not an id-only fingerprint', () => {
    const styles = ids.map(styleSheetFor);
    expect(new Set(styles.map(styleId)).size).toBe(1000);
    expect(new Set(styles.map(s=>JSON.stringify(captionVoiceProfile(s)))).size).toBe(1000);
    expect(styles.map(s=>s.captionSyntax)).toEqual(ids.map(id=>styleSheetFor(id).captionSyntax));
    expect(new Set(styles.map(s=>s.captionSyntax)).size).toBe(12);
    const same = styles[0]!;
    expect(styleId(same)).toBe(styleId({...same,profileId:'different-id-only'}));
    expect(styleId({...same,captionSyntax:(same.captionSyntax+1)%6})).not.toBe(styleId(same));
  });

  it.each([
    ['Phil Ivey fires a river bluff at the final table','bluff','poker'],
    ['Phil Ivey makes a huge river call','river_call','poker'],
    ['Daniel Negreanu folds the river','fold','poker'],
    ['Phil Ivey wins his 11th WSOP bracelet','bracelet','poker'],
    ['Stephen Curry hits a three pointer at the buzzer','three','sports'],
    ['LeBron James dunks from the baseline','dunk','sports'],
    ['This PLO River Decision Is Brutal','river_decision','poker'],
    ['Bluffing With Nine Seven!','bluff','poker'],
    ['He Put $2 Into a $130 Pot!','pot_contribution','poker'],
  ] as const)('binds only a supported source actor/action: %s', (title,action,domain) => {
    expect(captionFact(brief(title,domain))?.action).toBe(action);
  });

  it.each([
    ['Phil Ivey finds a bluff catcher on the river','poker'],
    ['Phil Ivey finds a bluff on the river','poker'],
    ['Phil Ivey attempts to catch a bluff','poker'],
    ['Phil Ivey watches Doug Polk fire a bluff','poker'],
    ['Phil Ivey never finds a river bluff','poker'],
    ['Could Phil Ivey find a river bluff?','poker'],
    ['Phil Ivey says someone attempts a bluff','poker'],
    ['Stephen Curry makes his teammate hit a three','sports'],
    ['Stephen Curry could hit a three pointer','sports'],
    ['Stephen Curry reacts to a dunk','sports'],
    ['Stephen Curry throws down the gauntlet','sports'],
    ['Phil Ivey wins support for a bracelet bid','poker'],
    ["I didn't put $2 into a $130 pot",'poker'],
    ['I didn’t put $2 into a $130 pot','poker'],
    ["I don't go bluffing with nine seven",'poker'],
  ] as const)('rejects ambiguous, conditional, negated or other-actor claims: %s', (title,domain) => {
    expect(captionFact(brief(title,domain))).toBeNull();
  });

  it('coalesces equivalent source facts and rhetorical rewrites without using video identity', () => {
    const b = brief('Phil Ivey makes a huge river call');
    const a = subjectCaption(b,styleSheetFor(ids[0]!))!;
    const c = subjectCaption({...b,postId:'another-video',title:'PHIL IVEY makes a huge river call!!!'},styleSheetFor(ids[0]!))!;
    expect(a.semanticKey).toBe(c.semanticKey);
    const syntaxes = Array.from({length:12},(_,captionSyntax)=>subjectCaption(b,{...styleSheetFor(ids[0]!),length:'medium',captionSyntax})!);
    expect(new Set(syntaxes.map(x=>x.text)).size).toBe(12);
    expect(new Set(syntaxes.map(x=>x.semanticKey)).size).toBe(1);
    const otherActor = subjectCaption(brief('Daniel Negreanu makes a huge river call'),styleSheetFor(ids[0]!))!;
    expect(otherActor.semanticKey).not.toBe(a.semanticKey);
  });

  it('canonicalizes real unnamed context facts without binding a claim to a guessed actor', () => {
    const a=subjectCaption(brief('He Put $2 Into a $130 Pot!'),styleSheetFor(ids[0]!))!;
    const b=subjectCaption(brief('Someone put $2.00 into a $130.00 pot'),styleSheetFor(ids[0]!))!;
    expect(a.semanticKey).toBe(b.semanticKey);
    expect(a.grounding).toContain('context:contribution:2:pot:130');
    expect(subjectCaption(brief('He Put $3 Into a $130 Pot!'),styleSheetFor(ids[0]!))!.semanticKey).not.toBe(a.semanticKey);
    expect(subjectCaption(brief('Bluffing With Nine Seven!'),styleSheetFor(ids[0]!))!.semanticKey)
      .toBe(subjectCaption(brief('bluffing with 9-7'),styleSheetFor(ids[0]!))!.semanticKey);
    expect(captionFact(brief('Could he put $2 into a $130 pot?'))).toBeNull();
  });

  it('parses general real holding notation with existing poker validation, not one supply-specific holding', () => {
    expect(captionHolding('nine seven')).toEqual(captionHolding('79'));
    expect(captionHolding('ace king suited')).toEqual({key:'aks',spoken:'ace-king suited'});
    expect(captionHolding('KQo')).toEqual({key:'kqo',spoken:'king-queen offsuit'});
    expect(captionFact(brief('Bluffing with Ace King Suited!'))?.identity).toBe('holding:aks');
    for(const value of ['AAs','king eleven','9Z','nine seven three','AK diamonds','97xyz']) expect(captionHolding(value)).toBeNull();
  });

  it('keeps plural focus phrases grammatical and uses action-appropriate references', () => {
    const b=brief('Phil Ivey makes a huge river call');
    for(const id of ids.slice(0,100)) {
      const out=subjectCaption(b,{...styleSheetFor(id),length:'medium',captionSyntax:3})!;
      expect(out.text).toContain('the discussion starts with');
      expect(out.text).not.toContain('pot odds belongs');
    }
    expect(subjectCaption(brief('Stephen Curry hits a three pointer','sports'),styleSheetFor(ids[0]!))?.reference).toBe('that shot');
    expect(subjectCaption(brief('LeBron James dunks from the baseline','sports'),styleSheetFor(ids[0]!))?.reference).toBe('that finish');
    expect(subjectCaption(brief('Phil Ivey wins his 11th WSOP bracelet'),styleSheetFor(ids[0]!))?.reference).toBe('that win');
  });

  it('real rendering carries the actor and develops grounded angles for longer voices without stock padding', () => {
    const b = brief('Phil Ivey fires a river bluff at the final table');
    const rows = ids.map(id=>({style:styleSheetFor(id),out:composeCaption(b,styleSheetFor(id))}));
    for(const {out} of rows) {
      expect(out.text.toLowerCase()).toContain('ivey');
      expect(out.grounding).toContain('actor:Phil Ivey');
      expect(out.relevance).toBeGreaterThanOrEqual(.3);
      expect(out.text).not.toMatch(/reading from|reports:|worth a look|that detail matters|plenty to discuss/i);
      expect(out.semanticKey).toMatch(/^meaning:subject:phil ivey:bluff:/);
    }
    expect(rows.some(({style,out})=>style.layout==='double_break' && out.text.includes('\n\n'))).toBe(true);
    expect(rows.some(({style,out})=>style.length==='two_sentence' && out.text.split(/\n|[.?]/).filter(Boolean).length>=2)).toBe(true);
    // This is measurable syntax diversity, NOT a claim that one source fact
    // permits 1000 different meanings. Semantic gates intentionally coalesce.
    const bare = new Set(rows.map(({out})=>out.text.toLowerCase().replace(/[^a-z ]/g,'').replace(/\s+/g,' ')));
    expect(bare.size).toBeGreaterThan(20);
    expect(new Set(rows.map(({out})=>out.semanticKey)).size).toBe(3);
  });
});
