import type { CaptionFact } from './CaptionVoice.js';
import { publicFigureDomain } from './PostBrief.js';
import {captionHolding} from './CaptionHolding.js';

const PAIRS: Record<string, string> = {
  aces: 'aa', kings: 'kk', queens: 'qq', jacks: 'jj', tens: 'tt',
  nines: '99', eights: '88', sevens: '77', sixes: '66', fives: '55',
  fours: '44', threes: '33', twos: '22', deuces: '22',
};
const COUNTS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const pairPattern = Object.keys(PAIRS).join('|');
const HOLDING=`(?:pocket (?:${pairPattern})|[akqjt2-9][- ]?[akqjt2-9](?: (?:suited|offsuit))?)`;
const MONEY = '(?<![a-z0-9.$,-])(\\$?)([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(million|thousand|m|k)?(?:(?![a-z0-9.,])|(?=gtd\\b))';

const QUESTION_COACHING_SOURCES = new Set([
  'bart hanson',
  'mariano',
  'hungry horse poker',
  'jonathan little',
  'gto wizard',
  'phil galfond',
  'pokercoaching',
  'upswing poker',
  'raise your edge',
  'pokerstars',
]);

/** Literal questions remain questions: no fold, call or result is asserted. */
export function pokerVideoQuestionFact(rawTitle:string,source?:string):CaptionFact|null{
 const sourceName=source?.toLowerCase();
 if(!sourceName||!QUESTION_COACHING_SOURCES.has(sourceName))return null;
 const clean=rawTitle.toLowerCase().replace(/[\u2018\u2019]/g,"'")
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,' ').replace(/\s+/g,' ').trim();
 if(!clean.endsWith('?'))return null;
 const title=clean.slice(0,-1).trim();
 const extra=sourceName==='mariano'?[
  [/^trapping with pocket aces$/,'decision:trap:holding:aa','the trapping decision with pocket aces'],
  [/^flatting a (?:3|three)[- ]bet out of position madness$/,'decision:flat:bet_level:3:position:oop','the decision about flatting a three-bet out of position'],
  [/^will pair of fives be enough$/,'decision:evaluate:holding:55','the decision with a pair of fives'],
  [/^trust the math or trust your gut$/,'decision:math_or_gut','the decision between trusting the math or a read'],
  [/^is river all[- ]in too thin$/,'decision:thin_value:street:river:wager:all_in','the river all-in thin-value decision'],
  [/^call or raise this shove$/,'decision:call_or_raise:facing:shove','the call-or-raise decision facing a shove'],
  [/^is calling an? \$13k all[- ]in too risky$/,'decision:call:amount:13000:wager:all_in','the decision about calling a $13,000 all-in'],
  [/^\$55k top pair mistake$/,'decision:evaluate:holding:top_pair:amount:55000','the $55,000 decision with top pair'],
 ] as const:sourceName==='bart hanson'?[
  [/^would you fold (?:5[- ]4|five[- ]four) suited here$/,'decision:fold:holding:54s','the folding decision with five-four suited'],
  [/^would you flat or (?:4|four)[- ]bet here$/,'decision:flat_or_four_bet','the flat-or-four-bet decision'],
  [/^bet or fold$/,'decision:bet_or_fold','the bet-or-fold decision'],
  [/^mystery hand turns straight(?:\.{1,3}|…) trouble$/,'decision:turned_straight','the decision after turning a straight'],
  [/^would you fold a flush here$/,'decision:fold:holding:flush','the folding decision with a flush'],
  [/^is this river shove ever a bluff$/,'decision:interpret_shove:street:river','the decision facing a river shove'],
  [/^is trip tens too weak$/,'decision:evaluate:holding:trip_tens','the decision with trip tens'],
  [/^overplaying pocket queens$/,'decision:sizing:holding:qq','the sizing decision with pocket queens'],
  [/^can hero fold top two pair$/,'decision:fold:holding:top_two_pair','the folding decision with top two pair'],
  [/^smaller bluff can work better$/,'decision:bluff_sizing','the smaller-bluff sizing decision'],
  [/^did hero miss a value bet against villain$/,'decision:value_bet','the value-betting decision'],
 ] as const:sourceName==='upswing poker'?[
  [/^would you go for thin value on the river in a (?:5|five)[- ]bet pot$/,'decision:thin_value:street:river:pot_bet_level:5','the river thin-value decision in a five-bet pot'],
 ] as const:sourceName==='raise your edge'?[
  [/^would you open jam or open limp with aa$/,'decision:open_jam_or_limp:holding:aa','the open-jam-or-limp decision with pocket aces'],
 ] as const:sourceName==='pokerstars'?[
  [/^would you fold kings to doug polk$/,'decision:fold:holding:kk:opponent:doug_polk','the folding decision with pocket kings against Doug Polk'],
  [/^would you play pocket fours like this$/,'decision:play:holding:44','the decision with pocket fours'],
 ] as const:[] as const;
 const added=extra.find(([pattern])=>pattern.test(title));
 if(added)return {person:'',action:'poker_question_context',identity:`poker_question:${added[1]}`,subject:added[2]};
 // General structural poker decision questions from verified coaching channels.
 const sizingPair=title.match(/^(small bet or large bet|bet or check|check or bet|call or fold|raise or call|check or raise)$/);
 if(sizingPair){
  const choice=sizingPair[1]!;
  return {person:'',action:'poker_question_context',identity:`poker_question:decision:${choice.replace(/\s+/g,'_')}`,subject:`the ${choice.replace(/\s+/g,'-')} decision`};
 }
 const streetDecision=title.match(/^(?:would|should) you (raise|call|fold|bluff|bet|check) this (flop|turn|river)(?: bet| shove| jam)?$/);
 if(streetDecision){
  const verb=streetDecision[1]!,street=streetDecision[2]!;
  const gerund=verb==='raise'?'raising':verb==='fold'?'folding':verb==='bluff'?'bluffing':verb==='bet'?'betting':verb==='check'?'checking':'calling';
  return {person:'',action:'poker_question_context',identity:`poker_question:decision:${verb}:street:${street}`,subject:`the ${street} ${gerund} decision`};
 }
 if(sourceName!=='bart hanson')return null;
 const rules:Array<[RegExp,string,string]>=[
  [/^folding the (?:3rd|third) nuts$/,'decision:fold:hand_rank:third_nuts','the decision about folding the third nuts'],
  [/^no pair call all[- ]in$/,'decision:call:wager:all_in:holding:no_pair','the all-in calling question with no pair'],
  [/^representing top pair as (?:a )?bluff$/,'decision:bluff:represented_holding:top_pair','the question of representing top pair as a bluff'],
  [/^what does this river bet mean$/,'decision:interpret_bet:street:river','the question about interpreting a river bet'],
  [/^monster flush draw: flat or shove$/,'decision:flat_or_shove:holding:flush_draw','the flat-or-shove question with a flush draw'],
  [/^can we fold top set here$/,'decision:fold:holding:top_set','the question of folding top set'],
  [/^should hero call this flop jam$/,'decision:call:street:flop:wager:jam','the calling decision facing a flop jam'],
  [/^did the river overbet save this hand$/,'decision:overbet:street:river','the question about the river overbet'],
 ];
 const rule=rules.find(([pattern])=>pattern.test(title));
 return rule?{person:'',action:'poker_question_context',identity:`poker_question:${rule[1]}`,subject:rule[2]}:null;
}

function quantity(raw:string, scale:string|undefined):number|null {
  if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) return null;
  const multiplier=/^(?:million|m)$/.test(scale??'')?1_000_000:/^(?:thousand|k)$/.test(scale??'')?1_000:1;
  const value=Number(raw.replace(/,/g,''))*multiplier;
  return Number.isSafeInteger(value)&&value>0?value:null;
}
function denomination(symbol:string):string {return symbol?'dollars':'unspecified';}
function displayAmount(value:number,symbol:string):string {return `${symbol?'$':''}${value.toLocaleString('en-US')}`;}
function parsedHolding(raw:string){
  const pair=raw.match(/^pocket (.+)$/)?.[1];
  return captionHolding(pair?PAIRS[pair]??'':raw);
}

function holdingContext(title:string):CaptionFact|null {
  const literal=title.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,'').replace(/\s*#[\s\S]*$/,'').replace(/[.!]+$/,'').trim();
  const bet=literal.match(new RegExp(`^([34]|three|four)[- ]betting (${HOLDING})(?: (out of position|in position))?(?: into \\$[0-9,.]+[mk]?)?$`));
  if(bet) {
    const holding=parsedHolding(bet[2]!);
    const level=bet[1]==='three'?3:bet[1]==='four'?4:Number(bet[1]);
    const position=bet[3]==='out of position'?'oop':bet[3]==='in position'?'ip':null;
    if(holding)return {person:'',action:'holding_context',identity:`holding:${holding.key}:bet_level:${level}${position?`:position:${position}`:''}`,subject:`the ${level===3?'three':'four'}-bet with ${holding.spoken}${bet[3]?` ${bet[3]}`:''}`};
  }
  const multi=literal.match(new RegExp(`^(${HOLDING}) in (?:a |the )?([2-9]|two|three|four|five|six|seven|eight|nine)[- ]way (?:hand|pot|nightmare)$`));
  if(multi) {
    const holding=parsedHolding(multi[1]!),count=COUNTS[multi[2]!]??Number(multi[2]);
    if(holding)return {person:'',action:'holding_context',identity:`holding:${holding.key}:players:${count}`,subject:`${holding.spoken} in a ${count}-way hand`};
  }
  const pair=literal.match(new RegExp(`^(?:(?:one time|baiting the trap with|trapping with|playing) )?(pocket (?:${pairPattern}))$`));
  if(pair) {
    const holding=parsedHolding(pair[1]!);
    if(holding)return {person:'',action:'holding_context',identity:`holding:${holding.key}`,subject:holding.spoken};
  }
  return null;
}

// These are event entities, not source brands, arbitrary title fingerprints or
// entire fixture strings. Values/roles still have to bind explicitly below.
const EVENTS:Array<[RegExp,string,string]>=[
  [/\bsuper high roller bowl\b/,'super high roller bowl','Super High Roller Bowl'],
  [/\bpgt plo (?:series|event|championship)\b/,'pgt plo series','PGT PLO Series'],
  [/\btrailblazer signature\b/,'trailblazer signature','Trailblazer Signature'],
  [/\btrailblazer warm[- ]up\b/,'trailblazer warm up','Trailblazer Warm-Up'],
  [/\blone star showdown\b/,'lone star showdown','Lone Star Showdown'],
  [/\bpokeratlas value town\b/,'pokeratlas value town','PokerAtlas Value Town'],
  [/\bpokeratlas kickoff\b/,'pokeratlas kickoff','PokerAtlas Kickoff'],
  [/\btexas trailblazer\b/,'texas trailblazer','Texas Trailblazer'],
  [/\beven bigger one\b/,'even bigger one','Even Bigger One'],
  [/\bwsopc\b.*\bmain event\b|\bmain event\b.*\bwsopc\b/,'wsopc main event','WSOPC Main Event'],
  [/\bwsopc\b.*\bplo ring event\b|\bplo ring event\b.*\bwsopc\b/,'wsopc plo ring event','WSOPC PLO Ring Event'],
];

const TRITON_DAILY_EVENTS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/^invitational x$/i, 'invitational_x', 'Invitational X'],
  [/^nlh 8[- ]handed$/i, 'nlh_8_handed', 'NLH 8-Handed'],
  [/^nlh 7[- ]handed$/i, 'nlh_7_handed', 'NLH 7-Handed'],
  [/^nlh mystery bounty$/i, 'nlh_mystery_bounty', 'NLH Mystery Bounty'],
  [/^nlh titi poker$/i, 'nlh_titi_poker', 'NLH Titi Poker'],
  [/^(?:nlh )?main event(?:\s+ft)?$/i, 'nlh_main_event', 'NLH Main Event'],
  [/^nlh qqpk(?: genesis)?$/i, 'nlh_qqpk_genesis', 'NLH QQPK Genesis'],
];

/** Official coverage supplies a literal event/stage, not an inferred result.
 * Entrants, hype, source labels and video identity do not create new meaning.
 */
function tournamentStageContext(title:string,source?:string):CaptionFact|null {
  const src=source?.toLowerCase();
  if(/\b(?:prediction|predictions|preview|previews)\b/.test(title))return null;
  if(src==='triton poker'){
    const hasTriton=/\btriton\b/.test(title);
    if(!hasTriton)return null;
    const isOne=/\btriton\s+one\b/.test(title);
    const seriesKey=isOne?'triton_one':'triton';
    const seriesLabel=isOne?'Triton ONE':'Triton';
    const years=[...title.matchAll(/\b(20\d{2})\b/g)].map(m=>m[1]!);
    const numbers=[...title.matchAll(/\bevent\s*#?\s*(\d{1,3})\b/g)].map(m=>Number(m[1]));
    const stages=[...title.matchAll(/\bfinal\s*table\b|\bfinal\s*day\b|\bday\s+([1-9]\d?[a-d]?)\b/g)]
      .map(m=>m[1]?`day_${m[1].toLowerCase()}`:/final\s*day/.test(m[0])?'final_day':'final_table');
    if(years.length<=1&&numbers.length===1&&stages.length===1&&!numbers.some(n=>n<1)){
      const stage=stages[0]!,year=years[0],number=numbers[0]!;
      const variant=/\bplo\b|\bpot[- ]limit omaha\b/.test(title)?'plo':null;
      const stageLabel=stage==='final_table'?'final table':stage==='final_day'?'final day':`Day ${stage.slice(4).toUpperCase()}`;
      return {person:'',action:'poker_event_context',
        identity:`poker_event:${seriesKey}${year?`:year:${year}`:''}:event:${number}${variant?`:variant:${variant}`:''}:stage:${stage}`,
        subject:`the ${year?`${year} `:''}${seriesLabel} Event #${number}${variant?' PLO':''} ${stageLabel}`};
    }
    const daily=title.match(/^(?:day\s+([1-9]\d?)\s+highlights|best\s+moments\s+day\s+([1-9]\d?))\s+triton\s+(shrs|one)\s+\$([1-9]\d{0,2})k\s+(.+)$/);
    if(daily&&numbers.length===0){
      const day=Number(daily[1]??daily[2]);
      const series=daily[3]!.toLowerCase();
      const buyin=Number(daily[4]);
      const rawEvent=daily[5]!.trim();
      const isFt=/\bft$/i.test(rawEvent);
      const matched=TRITON_DAILY_EVENTS.find(([pattern])=>pattern.test(rawEvent));
      if(matched){
        const [,eventKey,eventLabel]=matched;
        const label=series==='shrs'?'Triton SHRS':'Triton ONE';
        return {person:'',action:'poker_event_context',
          identity:`poker_event:triton_${series}:buyin:${buyin}k:${eventKey}:stage:day_${day}${isFt?':final_table':''}`,
          subject:`the ${label} $${buyin}K ${eventLabel} Day ${day}${isFt?' final table':''} coverage`};
      }
    }
    return null;
  }
  if(src==='tch live'){
    if(!/\bpokeratlas tour\b/.test(title)||!/\bfinal\s*table\b/.test(title))return null;
    const variant=/\bplo\b|\bpot[- ]limit omaha\b/.test(title)?'plo':/\bnlh\b/.test(title)?'nlh':null;
    return {person:'',action:'poker_event_context',
      identity:`poker_event:pokeratlas_tour${variant?`:variant:${variant}`:''}:stage:final_table`,
      subject:`the PokerAtlas Tour${variant?` ${variant.toUpperCase()}`:''} final table`};
  }
  if(src!=='pokergo')return null;
  if(/^high stakes poker live \| day ([1-9]\d?)$/.test(title)){
    const day=Number(title.match(/day ([1-9]\d?)$/)![1]);
    return {person:'',action:'poker_event_context',
      identity:`poker_event:high stakes poker:stage:day_${day}`,
      subject:`High Stakes Poker Live Day ${day}`};
  }
  const names=[...title.matchAll(/\b(poker masters|super high roller bowl)\b/g)];
  if(names.length!==1)return null;
  const event=names[0]![1]!;
  const years=[...title.matchAll(/\b(20\d{2})\b/g)].map(m=>m[1]!);
  const numbers=[...title.matchAll(/\bevent\s*#?\s*(\d{1,3})\b/g)].map(m=>Number(m[1]));
  const stages=[...title.matchAll(/\bfinal\s*table\b|\bday\s+([1-9]\d?)\b/g)]
    .map(m=>m[1]?`day_${Number(m[1])}`:'final_table');
  if(years.length>1||numbers.length>1||stages.length!==1||numbers.some(n=>n<1))return null;
  if(event==='poker masters'&&numbers.length===0){
    const stage=stages[0]!;
    if(/\bgrand finale\b/.test(title)){
      return {person:'',action:'poker_event_context',
        identity:`poker_event:poker masters:grand_finale:stage:${stage}`,
        subject:`the Poker Masters Grand Finale ${stage==='final_table'?'final table':`Day ${stage.slice(4)}`}`};
    }
    const hr=title.match(/\$(25,000|25k)\s+high roller\b/);
    if(hr&&years.length===1){
      return {person:'',action:'poker_event_context',
        identity:`poker_event:poker masters:year:${years[0]}:high_roller:25000:stage:${stage}`,
        subject:`the ${years[0]} Poker Masters $25,000 High Roller ${stage==='final_table'?'final table':`Day ${stage.slice(4)}`}`};
    }
    return null;
  }
  // An unidentified Masters edition must not become extra supply alongside
  // the same explicitly dated event. SHRB names the event itself.
  if(event==='poker masters'&&(numbers.length!==1||years.length!==1))return null;
  const variant=/\bpot[- ]limit omaha\b/.test(title)?'plo':null;
  const stage=stages[0]!,year=event==='poker masters'?years[0]:undefined,number=numbers[0];
  const name=event==='poker masters'?'Poker Masters':'Super High Roller Bowl';
  return {person:'',action:'poker_event_context',
    identity:`poker_event:${event}${year?`:year:${year}`:''}${number?`:event:${number}`:''}${variant?`:variant:${variant}`:''}:stage:${stage}`,
    subject:`the ${year?`${year} `:''}${name}${number?` Event #${number}`:''}${variant?' Pot-Limit Omaha':''} ${stage==='final_table'?'final table':`Day ${stage.slice(4)}`}`};
}

/** Bound quantities have distinct roles: pot, commitment, stakes and prize. */
function quantifiedContext(title:string):CaptionFact|null {
  if(/(?:-\s*\$|\$\s*-)\s*\d/.test(title))return null;
  const amountAllIn=title.match(new RegExp(`\\ball[- ]in for ${MONEY}(?![a-z0-9])`))
    ?? title.match(new RegExp(`${MONEY}\\s+all[- ]in\\b`));
  if(amountAllIn && !/\bpot\b/.test(title)) {
    const value=quantity(amountAllIn[2]!,amountAllIn[3]);
    // An additional monetary amount would make the selected role ambiguous.
    const amounts=[...title.matchAll(/\$[\d,.]+|\b\d+(?:\.\d+)?\s*(?:k|m|million|thousand)\b/g)];
    if(value && amounts.length<=1) return {person:'',action:'all_in_context',identity:`all_in:amount:${value}:unit:${denomination(amountAllIn[1]!)}`,subject:`the ${displayAmount(value,amountAllIn[1]!)} all-in`};
  }
  const matchup=title.match(new RegExp(`\\b(${pairPattern}) (?:vs\\.?|versus) (${pairPattern}) for (?:a |the )?${MONEY}\\s+pot\\b`));
  if(matchup && PAIRS[matchup[1]!]!==PAIRS[matchup[2]!]) {
    if((title.match(/\bpot\b/g)?.length??0)!==1)return null;
    const value=quantity(matchup[4]!,matchup[5]);
    const holdings=[PAIRS[matchup[1]!]!,PAIRS[matchup[2]!]!].sort();
    if(value) return {person:'',action:'pot_context',identity:`pot:matchup:${holdings.join(':')}:amount:${value}:unit:${denomination(matchup[3]!)}`,subject:`the ${displayAmount(value,matchup[3]!)} pot with pocket ${matchup[1]} and pocket ${matchup[2]}`};
  }
  const wonPot=title.match(new RegExp(`\\bwinning (?:a |the )?${MONEY}\\s+pot\\b`));
  if(wonPot) {
    const value=quantity(wonPot[2]!,wonPot[3]);
    if(value) return {person:'',action:'pot_context',identity:`pot:amount:${value}:unit:${denomination(wonPot[1]!)}`,subject:`the ${displayAmount(value,wonPot[1]!)} pot`};
  }
  const stakes=title.match(/(?:\bhigh stakes\s+|\bcash (?:game )?)(\$?)([\d,]+)\s*\/\s*\$?([\d,]+)(?![\d/])/)
    ?? title.match(/(?<![\d.$,-])(\$?)([\d,]+)\s*\/\s*\$?([\d,]+)(?![\d/])\s+(?:nlh|nlhe|plo|pot[- ]limit omaha)\b/)
    ?? title.match(/(?<![\d.$,-])(\$)([\d,]+)\s*\/\s*\$?([\d,]+)(?![\d/])\s+(?:no[- ]limit hold'?em|no[- ]limit 2-7 single draw)\s+cash game\b/)
    ?? title.match(/(?<![\d.$,-])(\$)([\d,]+)\s*\/\s*\$?([\d,]+)\+?\s+cash game\b/);
  if(stakes) {
    const small=quantity(stakes[2]!,undefined),big=quantity(stakes[3]!,undefined);
    if(small && big && big>small) return {person:'',action:'stakes_context',identity:`stakes:${small}:${big}:unit:${denomination(stakes[1]!)}`,subject:`the ${displayAmount(small,stakes[1]!)}/${displayAmount(big,stakes[1]!)} stakes`};
  }
  const events=EVENTS.filter(([pattern])=>pattern.test(title));
  if(events.length!==1) return null;
  const [,eventKey,eventName]=events[0]!;
  const prizes=[...title.matchAll(new RegExp(`${MONEY}\\s+(?:top|1st[- ]place|first[- ]place) prize\\b`,'g'))];
  const guarantees=[...title.matchAll(new RegExp(`${MONEY}\\s*(?:gtd|guaranteed)\\b`,'g'))];
  if(prizes.length>1||guarantees.length>1)return null;
  const prize=prizes[0],guarantee=guarantees[0];
  if(prize && guarantee) return null;
  const amount=prize??guarantee;
  if(!amount) return null;
  const value=quantity(amount[2]!,amount[3]);
  if(!value) return null;
  const role=prize?'top_prize':'guarantee';
  return {person:'',action:prize?'prize_context':'news_guarantee',identity:`event:${eventKey}:${role}:${value}:unit:${denomination(amount[1]!)}`,subject:`the ${displayAmount(value,amount[1]!)} ${prize?'listed top prize':'guarantee'} for ${eventName}`};
}

/** Literal context only: no actor, winner, bet size or cards are inferred. */
export function pokerVideoContextFact(rawTitle: string, source?: string): CaptionFact | null {
  const title = rawTitle.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').trim();
  const sourceLiteral=title.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,' ').replace(/(?:\s+#[a-z0-9_]+)+\s*$/,'').replace(/\s+/g,' ').replace(/[.!]+$/,'').trim();
  const literalFact=(identity:string,subject:string,action:CaptionFact['action']='holding_context'):CaptionFact=>({person:'',identity,subject,action});
  // Complete clauses from maintained sources only. Money roles are bound to
  // their verb/noun; punctuation, scale and episode metadata cannot salt keys.
  const srcLower=source?.toLowerCase();
  if(srcLower==='mariano'){
    const firing=sourceLiteral.match(/^firing \$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|thousand)? with pure ten high$/);
    if(firing){const amount=quantity(firing[1]!,firing[2]);if(amount)return literalFact(`wager:amount:${amount}:unit:dollars:holding:t_high`,`the $${amount.toLocaleString('en-US')} wager with ten-high`);}
    const kingBluff=sourceLiteral.match(/^a \$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|thousand)? bluff with king[- ]high$/);
    if(kingBluff){const amount=quantity(kingBluff[1]!,kingBluff[2]);if(amount)return literalFact(`wager:bluff:amount:${amount}:unit:dollars:holding:k_high`,`the $${amount.toLocaleString('en-US')} bluff with king-high`);}
    const q10Pot=sourceLiteral.match(/^(?:q10|queen[- ]ten) suited in ([2-9])[- ]way pot$/);
    if(q10Pot)return literalFact(`pot:holding:qts:players:${Number(q10Pot[1])}`,`the ${Number(q10Pot[1])}-way pot with queen-ten suited`,'pot_context');
    const akWar=sourceLiteral.match(/^ace[- ]king war for (?:a )?\$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|thousand)? pot$/);
    if(akWar){const amount=quantity(akWar[1]!,akWar[2]);if(amount)return literalFact(`pot:holding:ak:amount:${amount}:unit:dollars`,`the $${amount.toLocaleString('en-US')} pot with ace-king`,'pot_context');}
    const flushDec=sourceLiteral.match(/^a \$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|thousand)? decision with a flush$/);
    if(flushDec){const amount=quantity(flushDec[1]!,flushDec[2]);if(amount)return literalFact(`made_hand:flush:amount:${amount}:unit:dollars`,`the $${amount.toLocaleString('en-US')} decision with a flush`,'made_hand_context');}
    const eightTwo=sourceLiteral.match(/^the \$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|thousand)? 8[- ]2 suited punt$/);
    if(eightTwo){const amount=quantity(eightTwo[1]!,eightTwo[2]);if(amount)return literalFact(`wager:amount:${amount}:unit:dollars:holding:82s`,`the $${amount.toLocaleString('en-US')} hand with eight-two suited`);}
    if(/^turning 8[- ]7 into a monster pot$/.test(sourceLiteral))return literalFact('pot:holding:87','the pot with eight-seven','pot_context');
    const firstPlace=sourceLiteral.match(/^final table! \$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|thousand)? for 1st place$/);
    if(firstPlace){const amount=quantity(firstPlace[1]!,firstPlace[2]);if(amount)return literalFact(`event:mariano_tournament:top_prize:${amount}:unit:dollars`,`the $${amount.toLocaleString('en-US')} first-place prize at the final table`,'prize_context');}
  }
  if(srcLower==='bart hanson'){
    if(/^turned top pair in a (?:3|three)[- ]bet pot$/.test(sourceLiteral))return literalFact('made_hand:top_pair:street:turn:pot_bet_level:3','the top pair made on the turn in a three-bet pot','made_hand_context');
    if(/^facing a river all[- ]in$/.test(sourceLiteral))return literalFact('all_in:street:river:facing','the decision facing a river all-in','all_in_context');
    if(/^hero refused to fold top pair$/.test(sourceLiteral))return literalFact('holding:top_pair:decision:not_fold','the decision not to fold top pair');
    const shove=sourceLiteral.match(/^reg shoved \$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|thousand)? into hero's kings$/);
    if(shove){const amount=quantity(shove[1]!,shove[2]);if(amount)return literalFact(`holding:kk:facing:shove:amount:${amount}:unit:dollars`,`the pocket kings facing a $${amount.toLocaleString('en-US')} shove`);}
    if(/^bet sizing with pocket queens$/.test(sourceLiteral))return literalFact('holding:qq:topic:bet_sizing','bet sizing with pocket queens');
    const aaPot=sourceLiteral.match(/^aa in an? \$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|thousand)? pot$/);
    if(aaPot){const amount=quantity(aaPot[1]!,aaPot[2]);if(amount)return literalFact(`pot:holding:aa:amount:${amount}:unit:dollars`,`the $${amount.toLocaleString('en-US')} pot with pocket aces`,'pot_context');}
    if(/^ace[- ]king on mono[- ]heart flop$/.test(sourceLiteral))return literalFact('holding:ak:board:monotone_heart_flop','ace-king on a monotone heart flop');
    if(/^aa gets raised on the river$/.test(sourceLiteral))return literalFact('holding:aa:street:river:facing:raise','pocket aces facing a river raise');
    const bullyPot=sourceLiteral.match(/^standing up to the table bully in an? \$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|thousand)? pot$/);
    if(bullyPot){const amount=quantity(bullyPot[1]!,bullyPot[2]);if(amount)return literalFact(`pot:amount:${amount}:unit:dollars`,`the $${amount.toLocaleString('en-US')} pot`,'pot_context');}
    const turnedBoat=sourceLiteral.match(/^calling \$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|thousand)? into a turned boat$/);
    if(turnedBoat){const amount=quantity(turnedBoat[1]!,turnedBoat[2]);if(amount)return literalFact(`made_hand:turned_full_house:call:${amount}:unit:dollars`,`calling $${amount.toLocaleString('en-US')} into a turned full house`,'made_hand_context');}
    if(/^i flopped a full house(?:\.{1,3}|…) then he shoved 3x the pot$/.test(sourceLiteral))return literalFact('made_hand:flopped_full_house:facing:3x_pot_shove','a flopped full house facing a 3x pot shove','made_hand_context');
  }
  if(srcLower==='brad owen'){
    if(/^i flop quads! incredibly rare! opponent is coming after me$/.test(sourceLiteral))return literalFact('made_hand:flopped_quads','flopping quads','made_hand_context');
    if(/^i flop quad kings! unbelievable first hand! massive win in canada! running the hottest all year$/.test(sourceLiteral))return literalFact('made_hand:flopped_quad_kings','flopping quad kings','made_hand_context');
  }
  if(srcLower==='pokerstars'){
    const appt=sourceLiteral.match(/^(main event|super high roller) [-|] (day ?[1-9]\d?|final day) \| appt championship manila$/)
      ?? sourceLiteral.match(/^(main event|super high roller)\s+(final day)\s*-\s*appt championship manila$/);
    if(appt){const event=appt[1]==='main event'?'main':'super_high_roller',stage=appt[2]==='final day'?'final_day':`day_${Number(appt[2]!.replace(/day ?/,''))}`;return literalFact(`poker_event:appt championship manila:event:${event}:stage:${stage}`,`the APPT Championship Manila ${appt[1]} ${stage==='final_day'?'final day':`Day ${stage.slice(4)}`}`,'poker_event_context');}
    const heat=sourceLiteral.match(/^big game on tour \| s([1-9]\d?) heat ([1-9]\d?)(?: \| hands only, no breaks)?$/);
    if(heat)return literalFact(`poker_event:big game on tour:season:${Number(heat[1])}:heat:${Number(heat[2])}`,`Big Game on Tour Season ${Number(heat[1])} Heat ${Number(heat[2])}`,'poker_event_context');
    const ep=sourceLiteral.match(/\| big game on tour \| s([1-9]\d?) e([1-9]\d?)$/);
    if(ep)return literalFact(`poker_event:big game on tour:season:${Number(ep[1])}:episode:${Number(ep[2])}`,`Big Game on Tour Season ${Number(ep[1])} Episode ${Number(ep[2])}`,'poker_event_context');
  }
  if(srcLower==='pokergo'){
    const hartBluff=sourceLiteral.match(/^kevin hart makes \$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|thousand)? bluff on high stakes poker$/);
    if(hartBluff){const amount=quantity(hartBluff[1]!,hartBluff[2]);if(amount)return literalFact(`wager:bluff:actor:kevin hart:amount:${amount}:unit:dollars:show:high stakes poker`,`Kevin Hart's $${amount.toLocaleString('en-US')} bluff on High Stakes Poker`);}
    const hartHand=sourceLiteral.match(/^kevin hart plays \$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|thousand)? poker hand$/);
    if(hartHand){const amount=quantity(hartHand[1]!,hartHand[2]);if(amount)return literalFact(`pot:actor:kevin hart:amount:${amount}:unit:dollars`,`Kevin Hart's $${amount.toLocaleString('en-US')} hand`,'pot_context');}
    if(/^quads in huge pot at 2026 poker masters$/.test(sourceLiteral))return literalFact('made_hand:quads:event:poker masters:year:2026','quads in a big pot at the 2026 Poker Masters','made_hand_context');
    const upTop=sourceLiteral.match(/^poker masters grand finale with \$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|thousand)? up top\b/);
    if(upTop){const amount=quantity(upTop[1]!,upTop[2]);if(amount)return literalFact(`event:poker masters grand finale:top_prize:${amount}:unit:dollars`,`the $${amount.toLocaleString('en-US')} listed top prize for Poker Masters Grand Finale`,'prize_context');}
  }
  if(srcLower==='spraggy'){
    const bounty=sourceLiteral.match(/^final table! \$([1-9][0-9,]*) mystery bounty$/);
    if(bounty){const buyin=quantity(bounty[1]!,undefined);if(buyin)return literalFact(`poker_event:mystery_bounty:buyin:${buyin}:stage:final_table`,`the $${buyin.toLocaleString('en-US')} Mystery Bounty final table`,'poker_event_context');}
  }
  if(srcLower==='conscious poker'){
    const ept=sourceLiteral.match(/\| ept day ([1-9]\d?)$/);
    if(ept)return literalFact(`poker_event:ept:stage:day_${Number(ept[1])}`,`EPT Day ${Number(ept[1])}`,'poker_event_context');
  }
  if(srcLower==='doug polk poker'){
    const riverBet=sourceLiteral.match(/^\$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|thousand)? river bet vs\.? dwan$/);
    if(riverBet){const amount=quantity(riverBet[1]!,riverBet[2]);if(amount)return literalFact(`river:amount:${amount}:bet`,`the $${amount.toLocaleString('en-US')} river bet`,'river_context');}
    if(/^pocket aces first hand at triton$/.test(sourceLiteral))return literalFact('holding:aa:event:triton','pocket aces at Triton');
  }
  if(srcLower==='raise your edge'){
    if(/^final table: \$[0-9,]+ wsop millionaire maker win$/.test(sourceLiteral))return literalFact('poker_event:wsop_millionaire_maker:stage:final_table','the WSOP Millionaire Maker final table','poker_event_context');
    if(/^turn fold overpair with kk - most painful spot for adr(?:ai|ia)n mateos$/.test(sourceLiteral))return literalFact('holding:kk:street:turn:fold','the turn fold with pocket kings');
  }
  if(srcLower==='poker night in america'){
    if(/^jungleman hits quads twice against texas mike$/.test(sourceLiteral))return literalFact('made_hand:quads:count:2:actor:jungleman','Jungleman making quads twice','made_hand_context');
  }
  if(srcLower==='world series of poker'){
    if(/^terrible flop for pocket kings$/.test(sourceLiteral))return literalFact('holding:kk:street:flop','pocket kings on the flop');
    if(/^crazy runout for 2 sets$/.test(sourceLiteral))return literalFact('made_hand:set_over_set','two sets on the runout','made_hand_context');
  }
  const guardedTitle=title.replace(/\bno[- ]limit (?:hold'?em|2-7 single draw)\b/g,'nl_game');
  if (/[?]|\b(?:not|no|never|didn't|doesn't|don't|isn't|wasn't|weren't|won't|can't|cannot|can|may|could|would|should|couldn't|wouldn't|shouldn't|might|if|unless|without|reacts|watches|then|before|after|followed)\b/.test(guardedTitle)) return null;
  const literalContext=title.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,' ')
    .replace(/(?:\s+#[a-z0-9_]+)+\s*$/,'').replace(/\s+/g,' ').trim().replace(/[.!]+$/,'').trim();
  const sourceName=source?.toLowerCase();
  if(sourceName==='pokergo'&&/^daniel negreanu all[- ]in[.!]*$/.test(literalContext))return {
    person:'',action:'all_in_context',identity:'all_in:actor:daniel negreanu',subject:"Daniel Negreanu's all-in",
  };
  // Whole source-bound made-hand contexts, not guessed holdings, results or
  // monetary roles. Reversing a matchup never creates a new meaning.
  if(sourceName==='pokergo'||sourceName==='doug polk poker'){
    const matchup=literalContext.match(/^(straight flush|nut flush|straight|set) (?:vs\.?|versus) (straight flush|nut flush|straight|set)(?: in (?:\$[0-9][0-9,]* )?super high roller bowl| on hustler)?$/);
    if(matchup&&matchup[1]!==matchup[2]){
      const event=/super high roller bowl/.test(literalContext)?'super high roller bowl':null;
      const hands=[matchup[1]!,matchup[2]!].sort();
      return {person:'',action:'made_hand_context',identity:`made_hand:matchup:${hands.join(':')}${event?`:event:${event}`:''}`,subject:`the ${hands[0]} versus ${hands[1]} matchup${event?' at Super High Roller Bowl':''}`};
    }
  }
  if(sourceName==='bart hanson'&&/^middle set gets check(?:ed)?[- ]raised$/.test(literalContext))return {
    person:'',action:'made_hand_context',identity:'made_hand:middle_set:facing:check_raise',subject:'the check-raise faced by middle set',
  };
  if(sourceName==='mariano'){
    const pot=literalContext.match(/^(?:king[- ](?:10|ten)|k[- ]?t) in (?:a |the )?\$([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|thousand)?\s*pot$/);
    if(pot){
      const amount=quantity(pot[1]!,pot[2]);
      if(amount)return {person:'',action:'pot_context',identity:`pot:holding:kt:amount:${amount}:unit:dollars`,subject:`the $${pot[1]}${pot[2]??''} pot with king-ten`};
    }
  }
  // A literal pair-v-pair matchup is not ambiguous actor agency. Other use of
  // versus/against still fails closed in the pre-existing context grammar.
  if(/\b(?:versus|vs|against)\b/.test(title)) {
    const matchup=quantifiedContext(title);
    return matchup?.identity?.startsWith('pot:matchup:')?matchup:null;
  }
  // Bind the count to its own noun phrase, not any number elsewhere in a title.
  const countPattern = '(two|three|four|five|six|seven|eight|nine|[2-9])';
  const allInCount = title.match(new RegExp(`\\b${countPattern}[- ]ways? all[- ]in\\b`))?.[1]
    ?? title.match(new RegExp(`\\ball[- ]in(?: with (?:pocket )?(?:${pairPattern}))? ${countPattern}[- ]ways?\\b`))?.[1];
  const potCount = title.match(new RegExp(`\\b${countPattern}[- ]ways? (?:side[- ])?pot\\b`))?.[1];
  const countToken = /\ball[- ]in\b/.test(title) ? allInCount : potCount;
  const count = countToken ? (COUNTS[countToken] ?? Number(countToken)) : null;
  const multiway = count !== null || /\bmulti[- ]?way (?:side[- ])?pot\b/.test(title);
  const allIn = /\ball[- ]in\b/.test(title);
  const sidePot = /\bside[- ]pot\b/.test(title);
  if (allIn && /\bpot\b/.test(title)) {
    const combined=title.match(new RegExp(`^(?:the )?${countPattern}[- ]ways? all[- ]in for (?:a |the )?${MONEY}\\s+pot[.!]*$`));
    const value=combined?quantity(combined[3]!,combined[4]):null;
    const players=combined?(COUNTS[combined[1]!]??Number(combined[1])):null;
    return combined&&value&&players?{person:'',action:'all_in_context',identity:`all_in:players:${players}:pot:${value}:unit:${denomination(combined[2]!)}`,subject:`the ${players}-way all-in for a ${displayAmount(value,combined[2]!)} pot`}:null;
  }
  if ((title.match(/\ball[- ]in\b/g)?.length ?? 0) > 1 || (title.match(/\bpot\b/g)?.length ?? 0) > 1) return null;
  const allInPair = title.match(new RegExp(`\\ball[- ]in with (?:pocket )?(${pairPattern})\\b`))?.[1];
  const potPair = title.match(new RegExp(`\\bpot with (?:pocket )?(${pairPattern})\\b`))?.[1]
    ?? title.match(new RegExp(`\\b(${pairPattern}) in (?:a |the )?(?:bizarre |huge |big )?multi[- ]?way pot\\b`))?.[1];
  if (allIn && (count !== null || allInPair)) {
    const holding = allInPair ? PAIRS[allInPair] : null;
    return {
      person: '', action: 'all_in_context',
      identity: `all_in${holding ? `:holding:${holding}` : ''}${count ? `:players:${count}` : ''}`,
      subject: `the ${count ? `${count}-way ` : ''}all-in${allInPair ? ` with pocket ${allInPair === 'deuces' ? 'twos' : allInPair}` : ''}`,
    };
  }
  if (/\bpot\b/.test(title) && (potPair || sidePot || multiway)) {
    const holding = potPair ? PAIRS[potPair] : null;
    return {
      person: '', action: 'pot_context',
      identity: `pot${sidePot ? ':side' : ''}${holding ? `:holding:${holding}` : ''}${count ? `:players:${count}` : multiway ? ':multiway' : ''}`,
      subject: `the ${count ? `${count}-way ` : multiway ? 'multi-way ' : ''}${sidePot ? 'side ' : ''}pot${potPair ? ` with pocket ${potPair === 'deuces' ? 'twos' : potPair}` : ''}`,
    };
  }
  const riverAmount = title.match(/\$([\d,]+(?:\.\d+)?)\s*(million|thousand|m|k)?\s+river\b/);
  if (riverAmount) {
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(riverAmount[1]!)) return null;
    const scale = /^(?:million|m)$/.test(riverAmount[2] ?? '') ? 1_000_000 : /^(?:thousand|k)$/.test(riverAmount[2] ?? '') ? 1_000 : 1;
    const amount = Number(riverAmount[1]!.replace(/,/g, '')) * scale;
    if (Number.isSafeInteger(amount) && amount > 0) return {
      person: '', action: 'river_context', identity: `river:amount:${amount}`,
      subject: `the $${amount.toLocaleString('en-US')} river`,
    };
  }
  // Whole literal claims only. "Cracked" establishes that aces are beaten,
  // not who held them, a winning holding, or how the chips went in.
  const literal=title.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,'').replace(/[.!]+$/,'').trim();
  if(/^(?:cracking (?:pocket )?aces|(?:pocket )?aces (?:are |were |get )?cracked)(?: to win (?:the |a )?tournament)?$/.test(literal)) return {
    person:'',action:'aces_cracked_context',identity:'holding:aa:cracked',subject:`the ${/\btournament\b/.test(literal)?'tournament ':''}hand where pocket aces are cracked`,
  };
  const riverPerson=literal.match(/^(?:dramatic |the |a )?river card for ([a-z]+ [a-z]+)$/)?.[1];
  if(riverPerson && publicFigureDomain(riverPerson)==='poker') return {
    person:'',action:'river_context',identity:`river:player:${riverPerson}:card`,
    subject:`the river card for ${riverPerson.replace(/\b[a-z]/g,letter=>letter.toUpperCase())}`,
  };
  return holdingContext(title)??quantifiedContext(title)??tournamentStageContext(title,source);
}
