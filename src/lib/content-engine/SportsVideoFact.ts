import type { PostBrief } from './PostBrief.js';
import {literalSportsInventory} from './LiteralSportsInventory.js';
import {literalVerifiedInventory} from './LiteralVerifiedInventory.js';

export interface SportsVideoFact {
  person: '';
  identity: string;
  action: 'baseball_home_run_context' | 'baseball_close_context' | 'soccer_goal_total_context'
    | 'baseball_matchup_context' | 'basketball_passing_context' | 'soccer_equalizer_context'
    | 'baseball_series_context' | 'sports_technical_context' | 'news_sweep';
  subject: string;
}

// Actual full names in the retained verified source inventory. No heuristic
// title-cased name or surname is promoted into a canonical public identity.
const BASEBALL_BATTERS = ['Cedric Mullins', 'Jackson Chourio'] as const;
// Real team entities, not arbitrary title substrings or video/date identities.
const MLB_TEAMS = ['Angels','Astros','Athletics','Blue Jays','Braves','Brewers','Cardinals','Cubs',
  'Diamondbacks','Dodgers','Giants','Guardians','Mariners','Marlins','Mets','Nationals','Orioles',
  'Padres','Phillies','Pirates','Rangers','Rays','Red Sox','Reds','Rockies','Royals','Tigers',
  'Twins','White Sox','Yankees'] as const;
const MLB_ALIASES: Record<string,string> = Object.fromEntries(MLB_TEAMS.map(team=>[team.toLowerCase(),team]));
Object.assign(MLB_ALIASES, {'los angeles dodgers':'Dodgers','atlanta braves':'Braves','milwaukee brewers':'Brewers',
  'chicago white sox':'White Sox','cleveland guardians':'Guardians','cleveland':'Guardians','san diego padres':'Padres'});
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
  const verified=literalVerifiedInventory(original,b.source?.toLowerCase());
  if(verified)return verified;
  const inventory=literalSportsInventory(original,b.source?.toLowerCase());
  if(inventory)return inventory;
  if(/[?]|\b(?:not|no|never|didn't|doesn't|don't|isn't|wasn't|weren't|won't|can't|cannot|could|would|should|might|may|if|unless|without|before|after|then|reacts|watches|denies)\b/i.test(original)) return null;
  const title=original.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,' ')
    .replace(/(?:\s+#[A-Za-z0-9_]+)+\s*$/,'').replace(/\s+/g,' ').replace(/[.!]+$/,'').trim();

  // Closed source/entity grammars. Numbers bind their literal roles; a game
  // lead is not a final result, a closing win is not a credited save, and a
  // series state is not the series winner. No upload/date/title fingerprints.
  const source=b.source?.toLowerCase();
  const context=(identity:string,subject:string,action:SportsVideoFact['action']='sports_technical_context'):SportsVideoFact=>({person:'',identity,subject,action});
  const seriesName=(value:string)=>/world series/i.test(value)?'World Series':value.toUpperCase();
  const seriesPattern='(ALCS|NLCS|ALDS|NLDS|World Series)';
  if(['mlb','fox sports','bleacher report nba'].includes(source??'')) {
    const lead=title.match(new RegExp(`^(?:the )?(.+?) take(?:s)? a ([0-3])-([0-3]) series lead in (?:the )?${seriesPattern}$`,'i'));
    if(lead){
      const team=MLB_ALIASES[lead[1]!.toLowerCase()],a=Number(lead[2]),z=Number(lead[3]),series=seriesName(lead[4]!);
      if(!team||a<=z||(/DS$/.test(series)&&a>2))return null;
      return context(`baseball:series_lead:team:${key(team)}:series:${key(series)}:wins:${a}:opponent_wins:${z}`,`the ${team}' ${a}-${z} ${series} series lead`,'baseball_series_context');
    }
    const gameWin=title.match(new RegExp(`^Game ([1-7]) of (?:the )?${seriesPattern} belongs to (.+?)$`,'i'));
    const teamWin=title.match(new RegExp(`^(.+?) take(?:s)? Game ([1-7]) of (?:the )?${seriesPattern} over (.+?)$`,'i'));
    if(gameWin||teamWin){
      const team=MLB_ALIASES[(gameWin?.[3]??teamWin?.[1])!.toLowerCase()];
      const game=Number(gameWin?.[1]??teamWin?.[2]),series=seriesName((gameWin?.[2]??teamWin?.[3])!);
      const opponent=teamWin?MLB_ALIASES[teamWin[4]!.toLowerCase()]:undefined;
      if(!team||(/DS$/.test(series)&&game>5)||(teamWin&&(!opponent||opponent===team)))return null;
      // A known opponent is retained in prose, not used to salt an otherwise
      // equivalent named team's series/game win identity.
      return context(`baseball:game_win:team:${key(team)}:series:${key(series)}:game:${game}`,`the ${team==='Guardians'?'Cleveland Guardians':team}' ${series} Game ${game} win${opponent?` over the ${opponent}`:''}`,'baseball_series_context');
    }
    const tied=title.match(new RegExp(`^(?:the )?${seriesPattern} is tied going back to (.+?)$`,'i'));
    if(tied){
      const team=MLB_ALIASES[tied[2]!.toLowerCase()],series=seriesName(tied[1]!);
      if(!team)return null;
      return context(`baseball:series_tied:series:${key(series)}:return_team:${key(team)}`,`the tied ${series} returning to ${team==='Guardians'?'Cleveland':team}`,'baseball_series_context');
    }
    const sweep=title.match(new RegExp(`^(.+?) sweep(?:s)? (?:the )?(.+?) in (?:the )?${seriesPattern}$`,'i'));
    if(sweep){
      const team=MLB_ALIASES[sweep[1]!.toLowerCase()],opponent=MLB_ALIASES[sweep[2]!.toLowerCase()],series=seriesName(sweep[3]!);
      if(!team||!opponent||team===opponent)return null;
      // Identical to the maintained news fact namespace: a second source or
      // media format cannot turn this same series result into fresh meaning.
      return context(`team:${key(team)}:opponent:${key(opponent)}:series:${key(series)}:sweep`,`the ${team} sweep of the ${opponent} in the ${series}`,'news_sweep');
    }
  }
  if(source==='mlb'){
    // Literal maintained MLB source titles, not category-triggered opinions.
    // A lead or two RBI is not a final score, a win or a claim about technique.
    if(/^The Rays snatch the lead behind a Junior Caminero double down the line$/i.test(title))
      return context('baseball:go_ahead_double:actor:junior caminero:team:rays', "Junior Caminero's go-ahead double down the line for the Rays");
    if(/^Jonathan Aranda brings home another two runs for the Rays$/i.test(title))
      return context('baseball:runs_batted_in:actor:jonathan aranda:team:rays:runs:2', 'Jonathan Aranda driving in two more runs for the Rays');
    if(/^Yandy D[ií]az with a 2-run shot$/i.test(title))
      return context('baseball:home_run:actor:yandy diaz:runs:2', "Yandy Díaz's two-run home run", 'baseball_home_run_context');
    const close=title.match(/^Trevor Megill closes out a Game ([1-7]) win for the (.+?)$/i);
    if(close){
      const team=MLB_ALIASES[close[2]!.toLowerCase()];if(!team)return null;
      return context(`baseball:close:actor:trevor megill:team:${key(team)}:game:${close[1]}:win`,`Trevor Megill closing out the ${team}' Game ${close[1]} win`,'baseball_close_context');
    }
    const board=title.match(/^William Contreras gets the (.+?) on the board in Game ([1-7])$/i);
    if(board){
      const team=MLB_ALIASES[board[1]!.toLowerCase()];if(!team)return null;
      return context(`baseball:first_scoring:actor:william contreras:team:${key(team)}:game:${board[2]}`,`William Contreras getting the ${team} on the board in Game ${board[2]}`);
    }
    const front=title.match(/^Luis Lara puts the (.+?) in front of the (.+?) in Game ([1-7])$/i);
    if(front){
      const team=MLB_ALIASES[front[1]!.toLowerCase()],opponent=MLB_ALIASES[front[2]!.toLowerCase()];if(!team||!opponent||team===opponent)return null;
      return context(`baseball:go_ahead:actor:luis lara:team:${key(team)}:opponent:${key(opponent)}:game:${front[3]}`,`Luis Lara putting the ${team} ahead of the ${opponent} in Game ${front[3]}`);
    }
    const pitches=title.match(/^Jake Bauers battles through an? ([1-9][0-9]?)-pitch at-bat to put the (.+?) ahead$/i);
    if(pitches){
      const team=MLB_ALIASES[pitches[2]!.toLowerCase()];if(!team)return null;
      return context(`baseball:go_ahead_at_bat:actor:jake bauers:team:${key(team)}:pitches:${pitches[1]}`,`Jake Bauers' ${pitches[1]}-pitch at-bat that puts the ${team} ahead`);
    }
    if(/^Munetaka Murakami executes the 3-6-3 double play(?: to perfection)?$/i.test(title))return context('baseball:double_play:actor:munetaka murakami:sequence:3-6-3',"Munetaka Murakami's 3-6-3 double-play sequence");
  }
  if(source==='nba'&&/^Keaton Wagler (?:hits the brakes and )?(?:drains|makes) (?:the |a )?(?:tough )?step-back (?:triple|three-pointer)$/i.test(title))return context('basketball:made_three:actor:keaton wagler:shot:step_back',"Keaton Wagler's made step-back three-pointer");
  if(source==='uefa'&&/^Arda G[uü]ler free[- ]kick$/i.test(title))return context('soccer:free_kick:actor:arda guler',"Arda Güler's free-kick");
  if(source==='nhl'&&/^Connor McDavid with (?:the |a )?(?:casual )?1-on-3 dangle$/i.test(title))return context('hockey:puck_handling:actor:connor mcdavid:defenders:3',"Connor McDavid's one-on-three puck-handling sequence");
  if(source==='rangers'&&/^Sean Durzi scores[.!] (?:his )?first as a Ranger$/i.test(title))return context('hockey:goal:actor:sean durzi:team:rangers:milestone:first',"Sean Durzi's first goal as a Ranger");

  // An explicit recap names a fixture, not a winner, final score or a made
  // basket. The same teams in reversed order name the same semantic subject.
  if (b.source?.toLowerCase() === 'mlb') {
    const recap=title.match(/^(.+?) (?:vs\.?|versus) (.+?) (ALCS|NLCS|ALDS|NLDS|World Series) Game ([1-7]) (?:Shorts )?Recap$/i);
    if(recap) {
      const first=MLB_ALIASES[recap[1]!.toLowerCase()],second=MLB_ALIASES[recap[2]!.toLowerCase()];
      const series=/world series/i.test(recap[3]!)?'World Series':recap[3]!.toUpperCase(),game=Number(recap[4]);
      if(!first||!second||first===second||(/DS$/.test(series)&&game>5)) return null;
      const teams=[first,second].sort((a,b)=>a.localeCompare(b));
      return {person:'',action:'baseball_matchup_context',
        identity:`baseball:matchup:${teams.map(key).join(':')}:series:${key(series)}:game:${game}`,
        subject:`the ${teams[0]} versus ${teams[1]} ${series} Game ${game} matchup`};
    }
  }
  // These exact whole-title grammars establish passing relationships only.
  // An open/corner three-point look does not establish a made basket or assist.
  if (b.source?.toLowerCase() === 'nba') {
    if(/^Aaron Gordon(?:'s|') fancy handle finds Cam Johnson for (?:the |an |a )?open three(?:-point look)?$/i.test(title)) {
      return {person:'',action:'basketball_passing_context',
        identity:'basketball:pass_setup:passer:aaron gordon:receiver:cam johnson:look:open three',
        subject:'Aaron Gordon finding Cam Johnson for an open three-point look'};
    }
    if(/^Jamal Murray goes behind the back to set up the Joki[cć] pass to Aaron Gordon for (?:the |a )?corner three(?:-point look)?$/i.test(title)) {
      return {person:'',action:'basketball_passing_context',
        identity:'basketball:pass_chain:jamal murray:jokic:aaron gordon:look:corner three',
        subject:'the Jamal Murray-to-Jokić-to-Aaron Gordon passing sequence for a corner three-point look'};
    }
  }
  if(b.source?.toLowerCase()==='house of highlights'
    && /^(?:what a moment[.!] ?)?USWNT goal to tie Spain$/i.test(title)) {
    return {person:'',action:'soccer_equalizer_context',
      identity:'soccer:team_goal:uswnt:opponent:spain:effect:equalizer',
      subject:'the USWNT equalizing goal against Spain'};
  }

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
