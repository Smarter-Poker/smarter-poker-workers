import {describe,it,expect} from 'vitest';
import {briefForAsset} from './PostBrief.js';
import {strategyTopicFact} from './StrategyTopicFact.js';
const fact=(title:string)=>strategyTopicFact(briefForAsset({kind:'link',domainHint:'poker',source:'Upswing Poker',title}));
describe('source-bound instructional topics',()=>{
 it.each([
 ['Preflop Mechanics in PLO','GTO Wizard','plo_preflop_mechanics'],
 ['Is every hand playable? PLO Preflop mechanics #shorts','GTO Wizard','plo_preflop_mechanics'],
 ['How Much Should Poker Players Study?','Phil Galfond','study_balance'],
 ['Want to Get Better at Poker? Play Less and Study More','Phil Galfond','study_balance'],
 ['The Biggest Mistake Poker Players Make With Their Bankroll','Phil Galfond','bankroll_mistakes'],
 ['When Shot Taking Can Be a Mistake','Phil Galfond','shot_taking'],
 ['The Right Way to Approach Poker Strategy Decisions','Phil Galfond','decision_process'],
 ['The Nut Flush Draw Trap!','Mariano','nut_flush_draw'],
 ])('binds approved video lesson without answering or inventing results %s',(title,source,topic)=>expect(strategyTopicFact(briefForAsset({kind:'video',domainHint:'poker',source,title}))?.identity).toBe('poker_strategy:'+topic));
 it.each(['Unknown channel','PokerNews'])('rejects video lesson from unqualified source %s',source=>expect(strategyTopicFact(briefForAsset({kind:'video',domainHint:'poker',source,title:'Preflop Mechanics in PLO'}))).toBeNull());
 const cases=[
 ['7 ways to barrel the turn more effectively','turn_barreling'],
 ['You Don’t Need The Nuts To Overbet','overbetting'],
 ['Lose Less, Win More: The Fundamentals of Big Blind Defense','big_blind_defense'],
 ['Stop Playing GTO Against Blinds That Fold Too Much','overfolding_blinds'],
 ['Single Board Bomb Pots – The Complete NLH Strategy Guide','single_board_bomb_pots'],
 ['3 Common Spots Where Poker Players Aren’t Aggressive Enough','aggression_spots'],
 ['3 Hidden River Mistakes That Are Costing You Money','river_mistakes'],
 ['Garrett Adelstein’s 5 Live Poker Tips To Boost Your Win Rate','live_poker_tips'],
 ['3 Flop Mistakes You’re Making Without Knowing It','flop_mistakes'],
 ['Exclusive book extract: 100 Essential Tips to Master Pot-Limit Omaha','plo_tips'],
 ] as const;
 it.each(cases)('binds actual instructional topic %s',(title,topic)=>expect(fact(title)?.identity).toBe('poker_strategy:'+topic));
 it('coalesces list counts without claiming extra supply',()=>{expect(fact('5 ways to barrel the turn more effectively')?.identity).toBe('poker_strategy:turn_barreling');expect(fact('10 Flop Mistakes You’re Making Without Knowing It')?.identity).toBe('poker_strategy:flop_mistakes');});
 it('keeps source-bound instructional subjects distinct instead of ten identical guide frames',()=>{
  const outputs=cases.map(([title])=>fact(title)!.subject!);
  expect(outputs.filter(s=>s.startsWith('The guide covers')).length).toBe(0);
  expect(new Set(outputs.map(s=>s.split(' ').slice(0,3).join(' '))).size).toBeGreaterThanOrEqual(8);
  expect(fact('7 ways to barrel the turn more effectively')?.subject).toBe('Seven ways to barrel the turn more effectively');
 });
 it.each([['A guide to big-blind defense','big_blind_defense'],['How to barrel the turn more effectively','turn_barreling'],['River mistakes: a poker strategy guide','river_mistakes'],['Pot-limit Omaha tips: a strategy guide','plo_tips']])('coalesces supported instructional aliases %s',(title,topic)=>expect(fact(title)?.identity).toBe('poker_strategy:'+topic));
 it.each(['Can you overbet without the nuts?','Overbetting cures cancer','Poker tips after arrest','Buy our poker tips now','7 ways to barrel the turn more effectively and win $500','3 Hidden River Mistakes That Are Costing You Money; player wins title','Sneak Peek Inside Destroy Live Cash by Garrett Adelstein','Amazing poker story'])('refuses unsupported or ambiguous title %s',title=>expect(fact(title)).toBeNull());
 it('refuses video and non-poker contexts',()=>{for(const b of [briefForAsset({kind:'video',domainHint:'poker',source:'Upswing',title:cases[0][0]}),briefForAsset({kind:'link',domainHint:'sports',source:'ESPN',title:cases[0][0]})])expect(strategyTopicFact(b)).toBeNull();});
});
