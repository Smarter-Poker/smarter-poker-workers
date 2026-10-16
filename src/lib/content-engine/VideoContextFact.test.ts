import {describe,it,expect} from 'vitest';
import {pokerVideoContextFact} from './VideoContextFact.js';
import {captionFact,subjectCaption} from './CaptionVoice.js';
import {briefForAsset} from './PostBrief.js';
import {styleSheetFor} from './StyleSheet.js';
import {composeCaption} from './Composer.js';
const brief=(title:string)=>briefForAsset({kind:'video',title,source:'PokerGO',domainHint:'poker'});
const style=styleSheetFor('46887b99-8cd6-45db-861c-ad24232efbfe');

describe('literal video context facts',()=>{
 it.each([
  ['CRACKING ACES TO WIN THE TOURNAMENT!','holding:aa:cracked','aces_cracked_context'],
  ['DRAMATIC RIVER CARD FOR DANIEL NEGREANU!','river:player:daniel negreanu:card','river_context'],
 ] as const)('grounds additional literal source facts without inferred agency: %s',(title,identity,action)=>{
  expect(captionFact(brief(title))).toMatchObject({identity,action,person:''});
  const out=subjectCaption(brief(title),style)!;
  expect(out.grounding).toContain(`context:${identity}`);
  expect(out.text).not.toMatch(/won|lost|wins|loses|called|folded/i);
  expect(composeCaption(brief(title),style).relevance).toBeGreaterThanOrEqual(.3);
 });
 it.each([
  ['CRACKING ACES TO WIN THE TOURNAMENT!','Pocket aces are cracked'],
  ['Dramatic river card for Daniel Negreanu!','The river card for DANIEL NEGREANU'],
 ] as const)('canonicalizes the same new literal fact without title novelty: %s',(first,second)=>{
  expect(pokerVideoContextFact(first)?.identity).toBe(pokerVideoContextFact(second)?.identity);
  expect(subjectCaption(brief(first),style)?.semanticKey).toBe(subjectCaption(brief(second),style)?.semanticKey);
 });
 it.each([
  'Could cracking aces win the tournament?','Never cracking aces to win the tournament',
  'Pocket aces were not cracked','If pocket aces are cracked','Cracking aces before kings are cracked',
  'Dramatic river card for Daniel Negreanu?','No river card for Daniel Negreanu',
  'River card for Mystery Player','Phil Ivey watches a river card for Daniel Negreanu',
  'Daniel Negreanu might get a dramatic river card','River card for Daniel Negreanu and Phil Ivey',
 ])('refuses unsupported additional context: %s',title=>{
  expect(pokerVideoContextFact(title)).toBeNull();
 });
 it.each([
  ['Rampage is ALL IN with ACES 3 ways','all_in:holding:aa:players:3','all_in_context'],
  ['Navigating A Chaos 5-Way All-In','all_in:players:5','all_in_context'],
  ['Rampage Play a HUGE pot with JACKS!','pot:holding:jj','pot_context'],
  ['Aces In A Bizarre Multi-Way Pot','pot:holding:aa:multiway','pot_context'],
  ['Insane Multi-Way Side Pot Drama','pot:side:multiway','pot_context'],
  ['$5 MILLION River!','river:amount:5000000','river_context'],
 ] as const)('grounds current real source context %s',(title,identity,action)=>{
  expect(captionFact(brief(title))).toMatchObject({identity,action,person:''});
  const out=subjectCaption(brief(title),style)!;
  expect(out.grounding).toContain(`context:${identity}`);
  expect(out.text).not.toMatch(/won|lost|wins|loses|called|folded|Ram[p]?age/i);
 });
 it.each([
  ['Rampage is all-in with aces three ways','ALL IN WITH ACES 3-WAY!'],
  ['Navigating a chaos five-way all-in','The 5 way all in'],
  ['$5 million river','$5,000,000 River'],
  ['$5M river','$5000k river'],
  ['a multiway side-pot','a multi-way side pot'],
 ] as const)('collapses equivalent facts instead of using titles as novelty %s',(a,b)=>{
  const first=pokerVideoContextFact(a);expect(first).not.toBeNull();
  expect(first?.identity).toBe(pokerVideoContextFact(b)?.identity);
  expect(subjectCaption(brief(a),style)?.semanticKey).toBe(subjectCaption(brief(b),style)?.semanticKey);
 });
 it.each(['Could he go all-in with aces three ways?','If he goes all-in with aces three ways','He never went all-in with aces three ways','He couldn’t get all-in with aces three ways','He wouldn’t get all-in with aces three ways','He shouldn’t get all-in with aces three ways','He watches the five-way all-in','Three-way pot, then a heads-up all-in','A pot with jacks before a pot with aces','No five-way all-in','A pot without jacks','A $5 million river?','Monster Flush Draw: Flat Or Shove?','He could put a $5 million river in his vlog','$5,00 million river','$2,,000 river'])('refuses condition, denial, questions and agency ambiguity: %s',title=>{
  expect(pokerVideoContextFact(title)).toBeNull();
 });
 it('does not alter existing typed fact identities',()=>{
  expect(captionFact(brief('This PLO River Decision Is Brutal'))?.identity).toBe('variant:plo');
  expect(captionFact(brief('Bluffing With Nine Seven!'))?.identity).toBe('holding:97');
  expect(captionFact(brief('He Put $2 Into a $130 Pot!'))?.identity).toBe('contribution:2:pot:130');
 });
 it('does not borrow a pot player-count for a separate heads-up all-in',()=>{
  expect(pokerVideoContextFact('five-way pot and all-in heads-up')).toBeNull();
  expect(pokerVideoContextFact('Five-way all-in and an all-in with aces')).toBeNull();
  expect(pokerVideoContextFact('a three-way pot and a pot with jacks')).toBeNull();
 });
 it('does not borrow multi-way from an earlier street for a different pot context',()=>{
  expect(pokerVideoContextFact('Multi-way flop but heads-up pot with jacks')).toMatchObject({identity:'pot:holding:jj',subject:'the pot with pocket jacks'});
 });
 it('preserves genuinely distinct holding, player-count and amount propositions',()=>{
  const titles=['all-in with aces three ways','all-in with kings three ways','all-in with aces four ways','$5 million river','$4 million river'];
  expect(new Set(titles.map(title=>pokerVideoContextFact(title)?.identity)).size).toBe(titles.length);
 });
});
