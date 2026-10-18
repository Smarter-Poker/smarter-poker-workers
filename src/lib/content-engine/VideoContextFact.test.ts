import {describe,it,expect} from 'vitest';
import {pokerVideoContextFact,pokerVideoQuestionFact} from './VideoContextFact.js';
import {captionFact,subjectCaption} from './CaptionVoice.js';
import {briefForAsset,cleanTitle} from './PostBrief.js';
import {styleSheetFor} from './StyleSheet.js';
import {composeCaption} from './Composer.js';
const brief=(title:string)=>briefForAsset({kind:'video',title,source:'PokerGO',domainHint:'poker'});
const style=styleSheetFor('46887b99-8cd6-45db-861c-ad24232efbfe');

describe('literal question topics, never asserted decisions',()=>{
 it.each([
  ['Folding the 3rd Nuts? 🤔','decision:fold:hand_rank:third_nuts'],
  ['No Pair Call All-in? 😱','decision:call:wager:all_in:holding:no_pair'],
  ['Representing Top Pair as Bluff? 🤔','decision:bluff:represented_holding:top_pair'],
  ['What Does This River Bet Mean? 🤔','decision:interpret_bet:street:river'],
  ['Monster Flush Draw: Flat Or Shove ? 🤔','decision:flat_or_shove:holding:flush_draw'],
  ['Can We Fold Top Set Here? 😱','decision:fold:holding:top_set'],
  ['Should Hero Call This Flop Jam? 😬','decision:call:street:flop:wager:jam'],
  ['Did The River Overbet Save This Hand? 💸','decision:overbet:street:river'],
 ])('binds only the actual question topic %s',(title,identity)=>{
  const f=pokerVideoQuestionFact(title,'Bart Hanson');expect(f?.identity).toBe(`poker_question:${identity}`);
  expect(f?.subject).not.toMatch(/won|winning|saved|folded|called/i);
 });
 it.each(['Can We Fold Top Set Here','Can We Fold Bottom Set Here?','He folded top set?','Can We Fold Top Set Here and win?'])('refuses changed assertion, cards and extra outcome %s',title=>expect(pokerVideoQuestionFact(title,'Bart Hanson')).toBeNull());
 it('does not borrow a wrong source or promote arbitrary headline questions',()=>{
  expect(pokerVideoQuestionFact('Can We Fold Top Set Here?','Unknown')).toBeNull();
  expect(pokerVideoQuestionFact('Bet or Fold?','Bart Hanson')).toBeNull();
 });
 it('grounds an official literal actor all-in without a win or holding claim',()=>{
  expect(pokerVideoContextFact('DANIEL NEGREANU ALL-IN!','PokerGO')).toMatchObject({identity:'all_in:actor:daniel negreanu',subject:"Daniel Negreanu's all-in"});
  expect(pokerVideoContextFact('DANIEL NEGREANU ALL-IN?','PokerGO')).toBeNull();
  expect(pokerVideoContextFact('DANIEL NEGREANU ALL-IN!','Unknown')).toBeNull();
 });
});

describe('source-bound named tournament stages from actual verified inventory',()=>{
 it.each([
  ['Poker Masters 2026 | Event #5 - Final Table with Adrian Mateos & Nick Schulman','poker_event:poker masters:year:2026:event:5:stage:final_table'],
  ['Poker Masters 2026 | Event #5 - Day 1 with Adrian Mateos & Nick Schulman','poker_event:poker masters:year:2026:event:5:stage:day_1'],
  ["Poker Masters 2026 | Event #3 $10K No-Limit Hold'em - Day 1",'poker_event:poker masters:year:2026:event:3:stage:day_1'],
  ['Super High Roller Bowl $100,000 Pot-Limit Omaha | Day 2','poker_event:super high roller bowl:variant:plo:stage:day_2'],
 ])('grounds the explicit event and stage without guessing standings: %s',(title,key)=>{
  const fact=pokerVideoContextFact(title,'PokerGO');expect(fact?.identity).toBe(key);
  expect(fact?.subject).not.toMatch(/won|winner|leader|\$|stack/i);
  expect(fact?.subject).toMatch(/^the /);
  const b=brief(title);expect(captionFact(b)?.identity).toBe(key);
 });
 it('preserves numeric event facts while removing actual hashtags and channel tails',()=>{
  expect(cleanTitle('Poker Masters 2026 | Event #5 - Day 1 | PokerGO #poker #shorts'))
   .toBe('Poker Masters 2026 | Event #5 - Day 1');
  expect(cleanTitle('A specific poker title | PokerGO')).toBe('A specific poker title');
 });
 it('coalesces punctuation, coverage labels and participants instead of inventing extra supply',()=>{
  const a=pokerVideoContextFact('Poker Masters 2026 | Event #5 - Final Table with Adrian Mateos & Nick Schulman','PokerGO');
  const b=pokerVideoContextFact('2026 Poker Masters Event 5 Final Table Highlights with Nick Schulman','PokerGO');
  expect(a).not.toBeNull();expect(b?.identity).toBe(a?.identity);
 });
 it.each([
  ['Poker Masters 2026 | Event #5 - Final Table','Unknown source'],
  ['Poker Masters 2026 Event #5 Day 1 and Final Table','PokerGO'],
  ['Poker Masters 2026 Event #5 Day 1 and Event #6 Day 2','PokerGO'],
  ['Poker Masters Event #5 highlights','PokerGO'],
  ['Poker Masters Event #1 Final Table','PokerGO'],
  ['Poker Masters 2026 Event #5 Day 1 predictions','PokerGO'],
 ])('does not manufacture a stage or resolve ambiguous metadata: %s',(title,source)=>expect(pokerVideoContextFact(title,source)).toBeNull());
});

describe('literal made hands and explicitly bound holding pot',()=>{
 const rows=[
  ['xzEo_fyDjOI','PokerGO','STRAIGHT FLUSH VS NUT FLUSH IN $100,000 SUPER HIGH ROLLER BOWL!','made_hand:matchup:nut flush:straight flush:event:super high roller bowl'],
  ['uvGjZfmcxg8','Doug Polk Poker','Straight vs Set on Hustler #poker #shorts','made_hand:matchup:set:straight'],
  ['PwEnLbkjxJg','Bart Hanson','Middle Set Gets Checked Raised! 😱','made_hand:middle_set:facing:check_raise'],
  ['d3BTrUNEcXY','Mariano','King 10 In A $98KPot! 💸','pot:holding:kt:amount:98000:unit:dollars'],
 ] as const;
 it.each(rows)('preserves actual source context %s',(_id,source,title,identity)=>{
  expect(pokerVideoContextFact(title,source)?.identity).toBe(identity);
  const b=briefForAsset({kind:'video',domainHint:'poker',title,source});
  expect(captionFact(b)?.identity).toBe(identity);
  for(const author of ['1cdb67d7-27af-4709-817c-9270bd915249','48ada431-72b1-4cdb-8abe-541b9f6b179c']){
   const out=composeCaption(b,styleSheetFor(author));expect(out.text).not.toBe('');expect(out.relevance).toBeGreaterThanOrEqual(.3);
   expect(out.semanticKey).not.toContain(_id);expect(out.text).not.toMatch(/won|lost|wins|loses|suited|offsuit|100,000/i);
  }
 });
 it('canonicalizes reversal, punctuation and money spelling without source salting',()=>{
  expect(pokerVideoContextFact('Set versus Straight on Hustler','PokerGO')?.identity).toBe(pokerVideoContextFact(rows[1][2],rows[1][1])?.identity);
  expect(pokerVideoContextFact('KT in the $98,000 pot','Mariano')?.identity).toBe(pokerVideoContextFact(rows[3][2],rows[3][1])?.identity);
  expect(pokerVideoContextFact('Middle set gets check-raised','Bart Hanson')?.identity).toBe(pokerVideoContextFact(rows[2][2],rows[2][1])?.identity);
 });
 it.each([
  ['PokerGO','Straight flush vs nut flush and wins Super High Roller Bowl'],
  ['PokerGO','Straight flush vs straight flush'],
  ['PokerGO','Could straight flush beat nut flush?'],
  ['Unknown source',rows[0][2]],
  ['Bart Hanson','Middle set gets checked raised and folds'],
  ['Mariano','King 10 in a $98K prize'],
  ['Mariano','King 10 in a $98KPot and $99KPot'],
  ['Mariano','King 10 in a $9,8KPot'],
  ['Mariano','King 10 suited in a $98KPot'],
 ])('rejects unsupported or compounded context %s %s',(source,title)=>expect(pokerVideoContextFact(title,source)).toBeNull());
});

describe('literal video context facts',()=>{
 it.each([
  ['3-Betting Pocket Threes Out Of Position','holding:33:bet_level:3:position:oop'],
  ['4-Betting 9-7 Suited Into $141K','holding:97s:bet_level:4'],
  ['J-8 Offsuit In A 4-Way Nightmare','holding:j8o:players:4'],
  ['Baiting The Trap With Pocket Threes','holding:33'],
  ['ONE TIME POCKET JACKS','holding:jj'],
  ['THREE WAY ALL IN FOR A $25K POT','all_in:players:3:pot:25000:unit:dollars'],
  ['Jacks vs. Threes For a 14K Pot','pot:matchup:33:jj:amount:14000:unit:unspecified'],
  ['Lucas Jumalon is ALL IN for 22k On The Lodge Livestream!','all_in:amount:22000:unit:unspecified'],
  ['$4000 ALL IN!','all_in:amount:4000:unit:dollars'],
  ['Winning a 33k Pot Live On Stream Has To Feel Sooooooo Good','pot:amount:33000:unit:unspecified'],
  ['Big Mike Plays HIGH STAKES $50/100 - Commentary by Raver','stakes:50:100:unit:dollars'],
  ["LIVE POKER | $10/$25 No-Limit Hold'em Cash Game | TCH Social Austin",'stakes:10:25:unit:dollars'],
  ["LIVE POKER | $2/$5 No Limit Hold'em Cash Game | TCHLIVE Dallas",'stakes:2:5:unit:dollars'],
  ['Super High Roller Bowl Final Table with $1,150,000 Top Prize!','event:super high roller bowl:top_prize:1150000:unit:dollars'],
  ['PGT PLO Series $25,000 Championship! $420,000 1st-Place Prize!','event:pgt plo series:top_prize:420000:unit:dollars'],
  ['$250,000GTD Trailblazer Signature Final Table','event:trailblazer signature:guarantee:250000:unit:dollars'],
 ])('grounds a reusable literal holding/quantity role: %s',(title,identity)=>{
  expect(pokerVideoContextFact(title)?.identity).toBe(identity);
  expect(captionFact(brief(title))?.identity).toBe(identity);
  const out=composeCaption(brief(title),style);
  expect(out.text).not.toBe('');
  expect(out.relevance).toBeGreaterThanOrEqual(.3);
  expect(out.grounding).toContain(`context:${identity}`);
 });
 it.each([
  ['3-Betting Pocket Threes Out Of Position','three-betting pocket threes out of position!'],
  ['4-Betting 9-7 Suited Into $141K','four-betting 7-9 suited'],
  ['J-8 Offsuit In A 4-Way Nightmare','8-J offsuit in a four-way hand'],
  ['Jacks vs. Threes For a 14K Pot','Threes versus Jacks for a 14000 pot'],
  ['THREE WAY ALL IN FOR A $25K POT','3-way all-in for a $25,000 pot'],
  ['$4k all-in','$4,000 all in'],
  ['High stakes $50/100','High stakes $50/$100'],
  ['Super High Roller Bowl $1.15 million top prize','Super High Roller Bowl $1,150,000 first-place prize'],
  ['$250K GTD Trailblazer Signature Final Table','$250,000 guaranteed Trailblazer Signature Final Table'],
 ])('coalesces equivalent typed facts instead of minting caption novelty: %s',(first,second)=>{
  const a=pokerVideoContextFact(first),b=pokerVideoContextFact(second);
  expect(a).not.toBeNull();expect(b?.identity).toBe(a?.identity);
 });
 it.each([
  'Could he be all-in for $4,000?','He never went all-in for $4,000',
  'He is all-in for -$4,000','He is all-in for $-4,000','-$4,000 ALL IN','$-4,000 ALL IN',
  '$4.000.000 ALL IN','$5,00 ALL IN','$2,,000 ALL IN',
  '$4,000 all-in and $5,000 all-in',
  'Jacks vs Threes for a $14K pot and Aces vs Kings for a $15K pot',
  'Super High Roller Bowl $1 million top prize and $2 million top prize',
  'Super High Roller Bowl $1 million guaranteed and $2 million guaranteed',
  'Super High Roller Bowl $1 million guaranteed and $100,000 top prize',
  'Unknown Event $1 million guaranteed','High stakes $50/100/200',
  'High stakes $100/50','3-betting pocket threes before four-betting kings',
  'Four-betting ace ace suited','If four-betting nine seven suited',
 ])('refuses unsafe quantity/holding claims: %s',title=>{
  expect(pokerVideoContextFact(title)).toBeNull();
 });
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
