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
  [/\btexas trailblazer\b/,'texas trailblazer','Texas Trailblazer'],
  [/\beven bigger one\b/,'even bigger one','Even Bigger One'],
  [/\bwsopc\b.*\bmain event\b|\bmain event\b.*\bwsopc\b/,'wsopc main event','WSOPC Main Event'],
  [/\bwsopc\b.*\bplo ring event\b|\bplo ring event\b.*\bwsopc\b/,'wsopc plo ring event','WSOPC PLO Ring Event'],
];

/** Official coverage supplies a literal event/stage, not an inferred result.
 * Entrants, hype, source labels and video identity do not create new meaning.
 */
function tournamentStageContext(title:string,source?:string):CaptionFact|null {
  if(source?.toLowerCase()!=='pokergo'||/\b(?:prediction|predictions|preview|previews)\b/.test(title))return null;
  const names=[...title.matchAll(/\b(poker masters|super high roller bowl)\b/g)];
  if(names.length!==1)return null;
  const event=names[0]![1]!;
  const years=[...title.matchAll(/\b(20\d{2})\b/g)].map(m=>m[1]!);
  const numbers=[...title.matchAll(/\bevent\s*#?\s*(\d{1,3})\b/g)].map(m=>Number(m[1]));
  const stages=[...title.matchAll(/\bfinal\s*table\b|\bday\s+([1-9]\d?)\b/g)]
    .map(m=>m[1]?`day_${Number(m[1])}`:'final_table');
  if(years.length>1||numbers.length>1||stages.length!==1||numbers.some(n=>n<1))return null;
  // A Masters event requires its explicit number; SHRB names the event itself.
  if(event==='poker masters'&&numbers.length!==1)return null;
  const variant=/\bpot[- ]limit omaha\b/.test(title)?'plo':null;
  const stage=stages[0]!,year=years[0],number=numbers[0];
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
    ?? title.match(/(?<![\d.$,-])(\$?)([\d,]+)\s*\/\s*\$?([\d,]+)(?![\d/])\s+(?:nlh|nlhe)\b/)
    ?? title.match(/(?<![\d.$,-])(\$)([\d,]+)\s*\/\s*\$?([\d,]+)(?![\d/])\s+no[- ]limit hold'?em cash game\b/);
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
  const guardedTitle=title.replace(/\bno[- ]limit hold'?em\b/g,'holdem');
  if (/[?]|\b(?:not|no|never|didn't|doesn't|don't|isn't|wasn't|weren't|won't|can't|cannot|can|may|could|would|should|couldn't|wouldn't|shouldn't|might|if|unless|without|reacts|watches|then|before|after|followed)\b/.test(guardedTitle)) return null;
  const literalContext=title.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,' ')
    .replace(/(?:\s+#[a-z0-9_]+)+\s*$/,'').replace(/\s+/g,' ').trim().replace(/[.!]+$/,'').trim();
  const sourceName=source?.toLowerCase();
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
