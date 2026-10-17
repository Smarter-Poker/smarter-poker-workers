import { describe, it, expect } from 'vitest';
import { captionFact, captionHolding, captionVoiceProfile, subjectCaption } from './CaptionVoice.js';
import { briefForAsset } from './PostBrief.js';
import { composeCaption, hasSpecificTake } from './Composer.js';
import { styleId, styleSheetFor } from './StyleSheet.js';
import {captionQuality} from './CaptionQuality.js';

const brief = (title: string, domainHint: 'poker' | 'sports' = 'poker') => briefForAsset({kind:'video', title, domainHint, source:domainHint==='poker'?'PokerGO':'NBA'});
const ids = Array.from({ length: 1000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12,'0')}`);

describe('source-bound individual caption voices', () => {
  it('keeps internal result-guard wording out of natural technical-play captions', () => {
    const b = briefForAsset({kind:'video', title:'William Contreras gets the Brewers on the board in Game 3!', source:'MLB', domainHint:'sports', sportHint:'mlb'});
    for (const id of ['6a48eec0-2efe-447a-b902-13a4de739e53', ...ids]) {
      const out = composeCaption(b, styleSheetFor(id));
      expect(out.text).not.toBe('');
      expect(out.text).not.toMatch(/assumed result|rather than an assumed|unsupported outcome/i);
      expect(out.semanticKey).toBe('meaning:subject:baseball first scoring actor william contreras team brewers game 3:sports_technical_context:literal_sequence');
      expect(out.relevance).toBeGreaterThanOrEqual(0.3);
      expect(out.text).not.toMatch(/won|wins|winner|final score|home run/i);
    }
  });
  it('never frames an announced guarantee as a realized result in any syntax or cadence', () => {
    const b = briefForAsset({kind:'video', title:'Trailblazer Warm-Up $30K GTD', source:'PokerGO', domainHint:'poker'});
    const profiles = [0,1,2].map(cadence => ids.map(styleSheetFor).find(style => captionVoiceProfile(style).cadence === cadence)!);
    for (const profile of profiles) for (const length of ['medium','short','terse'] as const) {
      const outputs = Array.from({length:12},(_,captionSyntax) => subjectCaption(b,{...profile,length,captionSyntax})!);
      for (const out of outputs) {
        expect(out.text).not.toMatch(/\b(?:outcome|result)\b/i);
        expect(out.text.toLowerCase().split(out.subject.toLowerCase())).toHaveLength(2);
        expect(captionQuality(out.text,{subject:out.subject}).pass).toBe(true);
        expect(out.semanticKey).toBe('meaning:subject:event trailblazer warm up guarantee 30000 unit dollars:news_guarantee:guarantee_terms');
      }
      expect(new Set(outputs.map(out=>out.text)).size).toBe(12);
    }
  });
  it('does not circle back to the event noun in compound guarantee questions', () => {
    const b = briefForAsset({kind:'video', title:'Trailblazer Warm-Up $100K GTD', source:'PokerGO', domainHint:'poker'});
    for (const id of ['56315bf9-8a2b-4625-9e53-c7fe4bde9a8c','00000000-0000-4000-8000-000000000004']) {
      const out = subjectCaption(b, {...styleSheetFor(id),length:'medium',captionSyntax:4})!;
      expect(out.text.match(/\bguarantee\b/gi)).toHaveLength(1);
      expect(out.text).not.toMatch(/result|outcome|that guarantee/i);
      expect(out.semanticKey).toBe('meaning:subject:event trailblazer warm up guarantee 100000 unit dollars:news_guarantee:guarantee_terms');
    }
  });
  it('states the source subject once and uses a reference in compound questions', () => {
    for (const title of ['APT Championship Returns to Taiwan in November With $8.1 Million Guaranteed', 'Phil Ivey makes a huge river call']) {
      const b = title.startsWith('APT')
        ? briefForAsset({kind: 'link', title, source: 'PokerNews', domainHint: 'poker'})
        : brief(title);
      for (const id of ids) {
        for (const captionSyntax of [4]) {
          const out = subjectCaption(b, {...styleSheetFor(id), length: 'medium', captionSyntax})!;
          expect(out).not.toBeNull();
          expect(out.text.toLowerCase().split(out.subject.toLowerCase())).toHaveLength(2);
          expect(out.semanticKey).toBe(subjectCaption(b, styleSheetFor(id))!.semanticKey);
        }
      }
    }
  });
  it('does not expand canned stakes takes for vague headlines while retaining quantified stake grounding',()=>{
    const vague=brief('The SICKEST HAND in High Stakes Poker HISTORY!!!');
    expect(vague.concepts).toContain('high_stakes');
    expect(vague.concepts).not.toContain('stakes');
    const quantified=brief('Fun HIGH STAKES $50/100 NLH');
    expect(quantified.concepts).toContain('stakes');
    expect(captionFact(quantified)).toMatchObject({action:'stakes_context',identity:'stakes:50:100:unit:dollars'});
    expect(composeCaption(quantified,styleSheetFor(ids[0]!)).relevance).toBeGreaterThanOrEqual(.3);
  });
  it.each([
    ['If Phil Ivey fires a river bluff','poker'],
    ['Unless Phil Ivey fires a river bluff','poker'],
    ['Phil Ivey fires a river bluff unless his opponent calls','poker'],
    ['Stephen Curry hits a three if the defense switches','sports'],
    ["Phil Ivey couldn’t fire a river bluff",'poker'],
    ['Phil Ivey may fire a river bluff','poker'],
  ] as const)('does not turn a conditional known-actor action into an established fact: %s',(title,domain)=>{
    expect(captionFact(brief(title,domain))).toBeNull();
  });
  it('recognizes the literal folds verb for a source-grounded familiar-name voice',()=>{
    const b=brief('Daniel Negreanu folds the river');
    const familiar=ids.map(styleSheetFor).find(style=>style.slang==='heavy')!;
    expect(b.concepts).toContain('fold');
    const out=composeCaption(b,familiar);
    expect(out.text).toContain('Negreanu');
    expect(out.relevance).toBeGreaterThanOrEqual(.3);
    expect(out.semanticKey).toBe('meaning:subject:daniel negreanu:fold:range');
  });
  it('realizes independent question habits in the formerly identical long impersonal clauses',()=>{
    const pair=['710c13a2-68e6-4530-a9a1-9f9f1274e9d5','f9d1432c-db72-4d02-90be-714269f1111f'].map(styleSheetFor);
    for(const style of pair){
      expect(style.length).toBe('long');expect(style.voice).toBe('impersonal');
      expect(style.captionSyntax).toBe(4);expect(captionVoiceProfile(style).cadence).toBe(1);
    }
    const titles=['Phil Ivey makes a huge river call','Phil Ivey fires a river bluff','Daniel Negreanu folds the river','Phil Ivey wins his 11th WSOP bracelet','Stephen Curry hits a three pointer','LeBron James dunks from the baseline'];
    const rows=pair.map(style=>titles.map(title=>subjectCaption(brief(title,/Curry|James/.test(title)?'sports':'poker'),style)!));
    expect(rows[0]!.map(row=>row.semanticKey)).toEqual(rows[1]!.map(row=>row.semanticKey));
    expect(rows[0]!.map(row=>row.text)).not.toEqual(rows[1]!.map(row=>row.text));
    expect(rows[0]!.some((row,i)=>row.text!==rows[1]![i]!.text)).toBe(true);
  });
  it.each([
    ["Cedric Mullins' solo shot draws the Rays within 1 in the 8th!",'baseball_home_run_context'],
    ['Jackson Chourio ties the game with a 2-run blast','baseball_home_run_context'],
    ["Bryan Baker closes out the Rays' ALCS Game 2 win!",'baseball_close_context'],
    ['Kelvin Yeboah 15 GOALS on the season!','soccer_goal_total_context'],
  ])('wires a strict sports quantity through the real composer: %s',(title,action)=>{
    const b=brief(title,'sports');
    expect(captionFact(b)?.action).toBe(action);
    const out=composeCaption(b,styleSheetFor(ids[0]!));
    expect(out.text).not.toBe('');
    expect(out.relevance).toBeGreaterThanOrEqual(.3);
    expect(out.grounding).toContain(`title_action:${action}`);
    expect(out.text).not.toMatch(/I watched|I played|save|strikeout|ninth|9th|this year|current season/i);
    expect(captionFact({...b,kind:'link'})?.action).not.toBe(action);
  });

  it.each([
    ['Adrian Mateos Completes Unwanted Hat Trick of Poker Masters Bubbles','poker','news_bubble'],
    ['APT Championship Returns to Taiwan in November With $8.1 Million Guaranteed','poker','news_guarantee'],
    ['Brewers sweep Dodgers in NLCS, advance to 1st World Series in 44 years','sports','news_sweep'],
  ] as const)('renders a strict report fact even when the legacy generic take pool has no category: %s',(title,domain,action)=>{
    const b=briefForAsset({kind:'link',title,source:domain==='poker'?'PokerNews':'ESPN',domainHint:domain});
    expect(hasSpecificTake(b)).toBe(false);
    expect(captionFact(b)?.action).toBe(action);
    const out=composeCaption(b,styleSheetFor(ids[0]!));
    expect(out.text).not.toBe('');
    expect(out.relevance).toBeGreaterThanOrEqual(.3);
    expect(out.semanticKey).toMatch(/^meaning:subject:/);
    expect(out.grounding).toContain(`title_action:${action}`);
    expect(out.text).not.toMatch(/Reading from|reports:|won the prize|awarded|I played|I watched/i);
  });
  it.each([
    ["Jeremy Doku’s Trademark Goal ☄️",'Jeremy Doku','goal'],
    ['OG Anunoby Turns The Corner And Throws Down A Powerful Slam 💥','OG Anunoby','dunk'],
    ['Tyler Kolek Gets The Friendly Bounce On A Clutch Go-Ahead Three 🎯','Tyler Kolek','three'],
  ])('binds a literal verified sports title to the correct known actor: %s',(title,person,action)=>{
    const b=brief(title,'sports');
    expect(captionFact(b)).toMatchObject({person,action});
    const out=composeCaption(b,styleSheetFor(ids[0]!));
    expect(out.text).toContain(person);
    expect(out.relevance).toBeGreaterThanOrEqual(.3);
    expect(out.grounding).toContain(`actor:${person}`);
    expect(out.text).not.toMatch(/won|wins|victory|champion|I watched|I played/i);
  });

  it.each([
    "Could Jeremy Doku's trademark goal win the game?",
    "Jeremy Doku's trademark goal never happened",
    "Jeremy Doku watches LeBron James score a goal",
    "If OG Anunoby throws down a powerful slam",
    "OG Anunoby couldn't throw down a powerful slam",
    'OG Anunoby watches Tyler Kolek throw down a powerful slam',
    'Tyler Kolek might get the friendly bounce on a clutch go-ahead three',
    'Did Tyler Kolek get the friendly bounce on a clutch go-ahead three?',
    'A mystery player throws down a powerful slam',
  ])('does not promote a conditional, other-actor or unknown actor sports title: %s',title=>{
    expect(captionFact(brief(title,'sports'))).toBeNull();
  });

  it('coalesces equivalent literal sports actions independently of wording or asset identity',()=>{
    const pairs=[
      ["Jeremy Doku’s Trademark Goal!","Jeremy Doku's goal"],
      ['OG Anunoby turns the corner and throws down a powerful slam','OG Anunoby throws down a slam'],
      ['Tyler Kolek gets the friendly bounce on a clutch go-ahead three','Tyler Kolek gets a friendly bounce on a three'],
    ];
    for(const [first,second] of pairs){
      expect(subjectCaption(brief(first!,'sports'),styleSheetFor(ids[0]!))?.semanticKey)
        .toBe(subjectCaption({...brief(second!,'sports'),postId:'different-asset'},styleSheetFor(ids[0]!))?.semanticKey);
    }
  });

  it('does not stitch the same selected angle into a question and a repeated statement', () => {
    const b=brief('Navigating A Chaos 5-Way All-In');
    const kane=styleSheetFor('2de39d61-a269-451a-9e7c-37fc1aa25ad7');
    const out=composeCaption(b,kane);
    expect(out.text).not.toContain('?');
    expect(out.text.toLowerCase().match(/all[- ]in/g)).toHaveLength(1);
    expect(out.text).toContain('hands still available');
    expect(out.semanticKey).toBe('meaning:subject:all in players 5:all_in_context:ranges');
    for(const captionSyntax of [6,10]){
      const row=subjectCaption(b,{...kane,length:'medium',captionSyntax})!;
      expect(row.text).not.toContain('?');
      expect(row.text.toLowerCase().match(/all[- ]in/g)).toHaveLength(1);
      expect(row.grounding).toEqual(out.grounding);
      expect(row.semanticKey).toBe(out.semanticKey);
    }
  });

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
      expect(out.text).toMatch(/I(?: would|'d) start with|is where I(?: would|'d) ask about|I(?: would|'d) start by looking at/);
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

  it('realizes stable cadence in six-context output, not only unused profile fingerprints', () => {
    const titles = [
      'Phil Ivey makes a huge river call', 'Phil Ivey fires a river bluff',
      'Daniel Negreanu folds the river', 'Phil Ivey wins his 11th WSOP bracelet',
      'Stephen Curry hits a three pointer', 'LeBron James dunks from the baseline',
    ];
    const compose=(id:string)=>titles.map(title=>composeCaption(brief(title,/Curry|James/.test(title)?'sports':'poker'),styleSheetFor(id)));
    const rows=ids.map(id=>({id,outputs:compose(id)}));
    const normalized=(text:string)=>text.toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
    expect(new Set(rows.map(row=>row.outputs.map(out=>normalized(out.text)).join('|'))).size).toBeGreaterThan(900);
    expect(new Set(ids.map(id=>captionVoiceProfile(styleSheetFor(id)).cadence))).toEqual(new Set([0,1,2]));
    for(const row of rows){
      expect(row.outputs).toEqual(compose(row.id));
      for(const out of row.outputs){
        expect(out.text).not.toMatch(/I (?:played|watched|won|lost)|when I was|last night|reading from|reports:/i);
        expect(out.text).not.toMatch(/—/u);
        expect([...out.text.matchAll(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu)].length).toBeLessThanOrEqual(1);
      }
    }
    // Rephrasing never produces a fresh factual proposition.
    expect(new Set(ids.map(id=>subjectCaption(brief(titles[1]!),styleSheetFor(id))!.semanticKey)).size).toBe(3);
  });
});
