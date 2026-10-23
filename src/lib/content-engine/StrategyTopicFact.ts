import type {CaptionFact} from './CaptionVoice.js';
import type {PostBrief} from './PostBrief.js';
// Whole instructional clauses bind curated concepts; counts and publishers
// never enter identity. These advertise a guide's topic, not proven results.
const rules:ReadonlyArray<readonly [RegExp,string,string]>=[
 [/^[1-9][0-9]? ways to barrel the turn(?: more effectively)?$/i,'turn_barreling','turn barreling'],
 [/^You (?:do not|don't) need the nuts to overbet$/i,'overbetting','overbetting without the nuts'],
 [/^(?:Lose Less, Win More: )?(?:The )?Fundamentals of Big[- ]Blind Defense$/i,'big_blind_defense','big-blind defense'],
 [/^Stop Playing GTO Against Blinds That Fold Too Much$/i,'overfolding_blinds','adjusting against blinds that fold too much'],
 [/^Single[- ]Board Bomb Pots ?- ?(?:The )?Complete NLH Strategy Guide$/i,'single_board_bomb_pots','single-board no-limit hold’em bomb pots'],
 [/^[1-9][0-9]? Common Spots Where Poker Players (?:are not|aren't) Aggressive Enough$/i,'aggression_spots','aggression in common poker spots'],
 [/^[1-9][0-9]? Hidden River Mistakes That Are Costing You Money$/i,'river_mistakes','river mistakes'],
 [/^Garrett Adelstein's [1-9][0-9]? Live Poker Tips(?: To Boost Your Win Rate)?$/i,'live_poker_tips',"Garrett Adelstein's live poker tips"],
 [/^[1-9][0-9]? Flop Mistakes (?:You Are|You're) Making Without Knowing It$/i,'flop_mistakes','flop mistakes'],
 [/^(?:Exclusive book extract: )?[1-9][0-9]{0,2} Essential Tips to Master Pot[- ]Limit Omaha$/i,'plo_tips','pot-limit Omaha tips'],
];
export function strategyTopicFact(brief:PostBrief):CaptionFact|null{
 const title=brief.title.replace(/[‘’]/g,"'").replace(/[‐‑‒–—]/g,'-').replace(/\s+/g,' ').trim();
 if(brief.domain!=='poker')return null;
 if(brief.kind==='video'){
  // Questions here identify a lesson only. They never authorize an answer,
  // described hand, recommendation or inferred clip outcome.
  const lessons:ReadonlyArray<readonly [string,RegExp,string,string]>=[
   ['GTO Wizard',/^(?:Preflop Mechanics in PLO|Is every hand playable\? PLO Preflop mechanics(?: #shorts)?)$/i,'plo_preflop_mechanics','PLO preflop mechanics'],
   ['Phil Galfond',/^(?:How Much Should Poker Players Study\?|Want to Get Better at Poker\? Play Less and Study More)$/i,'study_balance','Balancing poker study and playing time'],
   ['Phil Galfond',/^The Biggest Mistake Poker Players Make With Their Bankroll$/i,'bankroll_mistakes','Bankroll mistakes in poker'],
   ['Phil Galfond',/^When Shot Taking Can Be a Mistake$/i,'shot_taking','When taking a shot can be a mistake'],
   ['Phil Galfond',/^The Right Way to Approach Poker Strategy Decisions$/i,'decision_process','Approaching poker strategy decisions'],
   ['Mariano',/^The Nut Flush Draw Trap!$/i,'nut_flush_draw','A nut-flush-draw scenario'],
  ];
  const lesson=lessons.find(([source,pattern])=>brief.source?.toLowerCase()===source.toLowerCase()&&pattern.test(title));
  return lesson?{person:'',action:'news_report_context',identity:'poker_strategy:'+lesson[2],subject:lesson[3]}:null;
 }
 if(brief.kind!=='link'||brief.isQuestion)return null;
 if(/[?]|\b(?:cancer|diagnos\w*|injur\w*|arrest\w*|criminal|murder|stabbing|charged|alleged|buy|subscribe|discount|promo)\b/i.test(title))return null;
 const aliases:ReadonlyArray<readonly [RegExp,string]>=[
  [/^How to barrel the turn(?: more effectively)?$/i,'turn_barreling'],
  [/^(?:A |The )?(?:strategy )?guide to big[- ]blind defen[cs]e$/i,'big_blind_defense'],
  [/^River mistakes: (?:a |the )?poker strategy guide$/i,'river_mistakes'],
  [/^Pot[- ]limit Omaha tips: (?:a |the )?strategy guide$/i,'plo_tips'],
 ];
 const topic=rules.find(([pattern])=>pattern.test(title))?.[1]??aliases.find(([pattern])=>pattern.test(title))?.[1];
 if(!topic)return null;
 const count=title.match(/^(\d+)\b/)?.[1];
 const number=({3:'Three',5:'Five',7:'Seven'} as Record<string,string>)[count??'']??count;
 const subjects:Record<string,string>={
  turn_barreling:count?`${number} ways to barrel the turn more effectively`:'How to barrel the turn more effectively',
  overbetting:'Overbetting without the nuts',
  big_blind_defense:'Big-blind defense from the fundamentals up',
  overfolding_blinds:'Adjusting against blinds that fold too much',
  single_board_bomb_pots:'A no-limit hold’em strategy guide for single-board bomb pots',
  aggression_spots:count?`${number} common spots where poker players miss aggression`:'Common spots where poker players miss aggression',
  river_mistakes:count?`${number} hidden river mistakes that cost money`:'River mistakes to recognize',
  live_poker_tips:title.match(/Adelstein's (\d+)/i)?.[1]?`${title.match(/Adelstein's (\d+)/i)![1]} live poker tips from Garrett Adelstein`:'Live poker tips from Garrett Adelstein',
  flop_mistakes:count?`${number} flop mistakes to recognize`:'Flop mistakes to recognize',
  plo_tips:title.match(/(?:extract: )?(\d+) Essential/i)?.[1]?`${title.match(/(?:extract: )?(\d+) Essential/i)![1]} pot-limit Omaha tips from the book extract`:'Pot-limit Omaha tips',
 };
 return {person:'',action:'news_report_context',identity:'poker_strategy:'+topic,subject:subjects[topic]!};
}
