import type { PostBrief } from './PostBrief.js';

export interface SportsVideoFact {
  person: '';
  identity: string;
  action: 'baseball_home_run_context' | 'baseball_close_context' | 'soccer_goal_total_context';
  subject: string;
}

// Actual full names in the retained verified source inventory. No heuristic
// title-cased name or surname is promoted into a canonical public identity.
const BASEBALL_BATTERS = ['Cedric Mullins', 'Jackson Chourio'] as const;
const RUNS: Record<string, number> = { solo: 1, one: 1, two: 2, three: 3, '1': 1, '2': 2, '3': 3 };
const WORDS: Record<string, number> = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20 };
const ORDINALS: Record<string, number> = { first:1,second:2,third:3,fourth:4,fifth:5,sixth:6,seventh:7,eighth:8,ninth:9 };
const escape = (value:string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const key = (value:string) => value.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const number = (value:string):number|null => WORDS[value] ?? (/^[1-9][0-9]?$/.test(value)?Number(value):null);
const runWords = (value:number) => value===1?'solo':value===2?'two-run':'three-run';
const possessive = (value:string) => `${value}${/s$/i.test(value)?"'":"'s"}`;

function inningNumber(value:string):number|null {
  if(ORDINALS[value]) return ORDINALS[value]!;
  const match=value.match(/^([1-9][0-9]?)(st|nd|rd|th)$/);
  if(!match) return null;
  const n=Number(match[1]);
  const suffix=n%100>=11&&n%100<=13?'th':n%10===1?'st':n%10===2?'nd':n%10===3?'rd':'th';
  return match[2]===suffix?n:null;
}

/** Full literal claims only; never infer a winning score, save or extra actor. */
export function sportsVideoFact(b:PostBrief):SportsVideoFact|null {
  if(b.kind!=='video'||b.domain!=='sports'||b.isQuestion) return null;
  const original=b.title.replace(/[\u2018\u2019]/g,"'").replace(/[\u2010-\u2015]/g,'-');
  if(/[?]|\b(?:not|no|never|didn't|doesn't|don't|isn't|wasn't|weren't|won't|can't|cannot|could|would|should|might|may|if|unless|without|before|after|then|reacts|watches|denies)\b/i.test(original)) return null;
  const title=original.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,' ')
    .replace(/(?:\s+#[A-Za-z0-9_]+)+\s*$/,'').replace(/\s+/g,' ').replace(/[.!]+$/,'').trim();

  const run='(solo|(?:one|two|three|[1-3])[- ]run)';
  for(const actor of BASEBALL_BATTERS){
    const prefix=escape(actor);
    const tying=title.match(new RegExp(`^${prefix} ties (?:the )?game with (?:a |the )?${run} (?:home[- ]run|homer|blast|shot)$`,'i'));
    const hit=title.match(new RegExp(`^${prefix}(?:'s|')? (?:hits (?:a |the )?)?${run} (?:home[- ]run|homer|shot)(?: draws (?:the )?(Rays|Brewers|Braves|Dodgers) within (one|[1-9])(?: run)? in (?:the )?([a-z]+|[1-9][0-9]?(?:st|nd|rd|th)))?$`,'i'));
    const match=tying??hit;
    if(!match) continue;
    const runs=RUNS[match[1]!.toLowerCase().replace(/[- ]run$/,'')];
    if(!runs) return null;
    const team=hit?.[2];
    const deficit=hit?.[3]?number(hit[3].toLowerCase()):null;
    const inning=hit?.[4]?inningNumber(hit[4].toLowerCase()):null;
    if(team&&(!deficit||!inning)) return null;
    const base=`baseball:home_run:actor:${key(actor)}:runs:${runs}`;
    return {
      person:'',action:'baseball_home_run_context',
      identity:`${base}${tying?':game_tying':''}${team?`:team:${key(team)}:deficit:${deficit}:inning:${inning}`:''}`,
      subject:`${possessive(actor)} ${tying?'game-tying ':''}${runWords(runs)} home run${team?` that brings the ${team} within ${deficit} run${deficit===1?'':'s'} in inning ${inning}`:''}`,
    };
  }
  const close=title.match(/^Bryan Baker closes out (?:the )?Rays'? (ALCS|NLCS|ALDS|NLDS|World Series) Game ([1-7]|one|two|three|four|five|six|seven) win$/i);
  if(close){
    const series=/world series/i.test(close[1]!)?'World Series':close[1]!.toUpperCase();
    const game=number(close[2]!.toLowerCase())!;
    if(/DS$/.test(series)&&game>5) return null;
    return {person:'',action:'baseball_close_context',identity:`baseball:close:actor:bryan baker:team:rays:series:${key(series)}:game:${game}:win`,subject:`Bryan Baker closing out the Rays' ${series} Game ${game} win`};
  }
  const goals=title.match(new RegExp(`^Kelvin Yeboah (?:has |reaches |records )?([1-9][0-9]?|${Object.keys(WORDS).join('|')}) (goals?) (?:on|in) (?:the |his )?season$`,'i'));
  if(goals){
    const count=number(goals[1]!.toLowerCase());
    if(!count||(count===1)!==(goals[2]!.toLowerCase()==='goal')) return null;
    return {person:'',action:'soccer_goal_total_context',identity:`soccer:goal_total:actor:kelvin yeboah:season:goals:${count}`,subject:`Kelvin Yeboah's ${count}-goal season total`};
  }
  return null;
}
