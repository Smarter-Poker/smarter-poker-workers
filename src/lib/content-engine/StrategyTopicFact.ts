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
   ['GTO Wizard',/^Solve Like a Pro: Run Your Solves and Study Your Hands$/i,'solver_study_workflow','Running solves and studying poker hands'],
   ['GTO Wizard',/^Flop Checks Through\. Now What\?$/i,'flop_check_through_turn','Navigating the turn after the flop checks through'],
   ['GTO Wizard',/^Espen Jorstad - \$10k WCOOP Final Table Review$/i,'wcoop_ft_review','Reviewing a $10K WCOOP final table'],
   ['GTO Wizard',/^Espen - \$200K Invitational Final Table Review$/i,'invitational_ft_review','Reviewing a $200K Invitational final table'],
   ['GTO Wizard',/^Chip Leader 3-Bets You at the Final Table\. What Now\?$/i,'ft_chip_leader_3bet','Facing a chip leader three-bet at a final table'],
   ['Phil Galfond',/^(?:How Much Should Poker Players Study\?|Want to Get Better at Poker\? Play Less and Study More)$/i,'study_balance','Balancing poker study and playing time'],
   ['Phil Galfond',/^The Biggest Mistake Poker Players Make With Their Bankroll$/i,'bankroll_mistakes','Bankroll mistakes in poker'],
   ['Phil Galfond',/^When Shot Taking Can Be a Mistake$/i,'shot_taking','When taking a shot can be a mistake'],
   ['Phil Galfond',/^The Right Way to Approach Poker Strategy Decisions$/i,'decision_process','Approaching poker strategy decisions'],
   ['Phil Galfond',/^Why You Need to Understand GTO to Play Poker$/i,'understanding_gto','Understanding GTO in poker'],
   ['Phil Galfond',/^(?:Poker Players: )?Why a Higher Win Rate Can Be Better Than Higher Stakes$/i,'winrate_vs_stakes','Higher win rate versus higher stakes in poker'],
   ['Phil Galfond',/^What is the Biggest Lever in Your Poker Career\?$/i,'career_lever','Identifying the biggest lever in a poker career'],
   ['Phil Galfond',/^How Do You Know If You're a Winning Poker Player\?$/i,'winning_player_assessment','Evaluating whether you are a winning poker player'],
   ['Phil Galfond',/^Why You Should Simplify Your Poker Strategy$/i,'simplifying_strategy','Simplifying poker strategy'],
   ['Phil Galfond',/^Why Poker Downswings Can Be So Different$/i,'poker_downswings','Understanding why poker downswings differ'],
   ['Phil Galfond',/^How Much Should You Adjust to a Poker Read\?$/i,'adjusting_to_reads','Adjusting to poker reads'],
   ['Phil Galfond',/^Rest Makes You a Better Poker Player$/i,'rest_and_performance','How rest affects poker performance'],
   ['Phil Galfond',/^Poker Players: What's The Cost Of Your C-Game\?$/i,'c_game_cost','The cost of playing your C-game in poker'],
   ['Phil Galfond',/^Don't Blame Luck for Your Poker Losses$/i,'luck_vs_skill','Separating luck from poker losses'],
   ['Phil Galfond',/^How to Choose the Right Poker Career Path$/i,'poker_career_path','Choosing a poker career path'],
   ['Phil Galfond',/^The Worst Poker Mistake: Failing to Try Your Best$/i,'effort_and_focus','Bringing full effort to the poker table'],
   ['Phil Galfond',/^Poker Players: Not Knowing Is Part of the Game$/i,'incomplete_information','Accepting incomplete information in poker'],
   ['Phil Galfond',/^The Best Way to Redefine Poker Wins$/i,'redefining_wins','Redefining what counts as a poker win'],
   ['Daniel Negreanu',/^Why Doesn't Daniel Negreanu Travel To Poker Tournaments\?$/i,'tournament_travel','Daniel Negreanu on traveling to poker tournaments'],
   ['Daniel Negreanu',/^Too Many WSOP Bracelets\? The Bracelet Prestige Debate$/i,'wsop_bracelet_prestige','The debate over WSOP bracelet volume and prestige'],
   ['Daniel Negreanu',/^Poker Wisdom vs\. GTO: Experience's Edge Against Young Pros$/i,'experience_vs_gto','Live poker experience versus GTO study'],
   ['Daniel Negreanu',/^Poker Tournament Payouts: Why More Players Should Cash$/i,'tournament_payout_structures','Poker tournament payout structures'],
   ['Daniel Negreanu',/^Poker Losing Streak\? Focus on What You Can Control!?$/i,'losing_streak_mindset','Managing a poker losing streak'],
   ['Daniel Negreanu',/^Want to Go Pro in Poker\? Know What It Takes!?$/i,'going_pro_poker','What it takes to play poker professionally'],
   ['Daniel Negreanu',/^How I Exploited GTO Players With Unorthodox Plays$/i,'exploiting_gto','Exploiting GTO tendencies with unorthodox plays'],
   ['PokerCoaching',/^THE TOURNAMENT MASTERCLASS(?: \[Run Deep in MTTs\])?$/i,'mtt_deep_runs','Running deep in multi-table tournaments'],
   ['PokerCoaching',/^How To Adjust To Recreational Poker Players!?$/i,'adjusting_to_recreationals','Adjusting to recreational poker players'],
   ['PokerCoaching',/^The 5 BIG Mistakes I Saw Playing Small Stakes Live Cash Games!?$/i,'small_stakes_live_mistakes','Common mistakes in small-stakes live cash games'],
   ['PokerCoaching',/^Mastering Preflop Exploits in Live Cash Games$/i,'live_preflop_exploits','Preflop exploits in live cash games'],
   ['Hungry Horse Poker',/^how i'd beat the trappy nits$/i,'beating_trappy_nits','Adjusting against trappy tight players'],
   ['Hungry Horse Poker',/^how i choose when to shot take$/i,'shot_taking','Deciding when to take a shot at higher stakes'],
   ['Hungry Horse Poker',/^if you play scared when up, watch this$/i,'playing_scared_up','Avoiding scared play when ahead in a session'],
   ['Hungry Horse Poker',/^how i avoid tilting$/i,'avoiding_tilt','Managing and avoiding tilt at the table'],
   ['Hungry Horse Poker',/^should you lead the river\? ask this first$/i,'leading_river','When to consider leading the river'],
   ['Hungry Horse Poker',/^how i'd attack the maniacs$/i,'attacking_maniacs','Adjusting against overly aggressive players'],
   ['Hungry Horse Poker',/^ask yourself these two questions in every hand$/i,'in_hand_thought_process','Structuring a thought process during a poker hand'],
   ['Upswing Poker',/^You Don't Need the Nuts to Overbet$/i,'overbetting','Overbetting without the nuts'],
   ['Upswing Poker',/^Punish wide opens with aggressive 3-bets$/i,'aggressive_3betting','Punishing wide opens with three-bets'],
   ['Upswing Poker',/^Losing money doesn't mean you made the wrong play$/i,'results_oriented_thinking','Separating short-term results from decision quality'],
   ['Bart Hanson',/^Know When Your Flush Is CRUSHED: Bart's River Raise Rule$/i,'river_raise_flush','Evaluating flushes facing a river raise'],
   ['Sethy Poker',/^How To DESTROY Low Stakes Poker!?$/i,'low_stakes_strategy','Low-stakes poker strategy'],
   ['Natural8',/^5 Mistakes to Avoid in Low Stakes Online Poker$/i,'low_stakes_online_mistakes','Common mistakes in low-stakes online poker'],
   ['Run It Once',/^Stop Studying Poker Like This$/i,'poker_study_habits','Effective poker study habits'],
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
