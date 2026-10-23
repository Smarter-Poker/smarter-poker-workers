import type {CaptionFact} from './CaptionVoice.js';
import {publicFigureDomain,type PostBrief} from './PostBrief.js';

// Positive public identities only. Additional full names occur in the retained
// NBA inventory; nicknames are explicit aliases, never guessed surnames.
// J-Dub: official Thunder biography identifies Jalen Williams explicitly:
// https://www.nba.com/thunder/news/the-drive-and-the-rise-220811
const ACTORS:Record<string,string>={
  'chet holmgren':'Chet Holmgren','aaron gordon':'Aaron Gordon',
  'caleb wilson':'Caleb Wilson','jalen williams':'Jalen Williams','j-dub':'Jalen Williams',
  'luka':'Luka Doncic','luka dončić':'Luka Doncic','luka doncic':'Luka Doncic',
};
const TEAMS:Record<string,string>={
  '76ers':'76ers','sixers':'76ers','philadelphia 76ers':'76ers',
  'cavs':'Cavaliers','cavaliers':'Cavaliers','cleveland cavaliers':'Cavaliers',
  'lakers':'Lakers','los angeles lakers':'Lakers','warriors':'Warriors',
  'golden state warriors':'Warriors','celtics':'Celtics','boston celtics':'Celtics',
};
const key=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
function actor(value:string):string|null {
  const lower=value.toLowerCase();
  return ACTORS[lower]??(publicFigureDomain(value)==='sports'
    ?lower.split(' ').map(word=>word==='lebron'?'LeBron':word[0]!.toUpperCase()+word.slice(1)).join(' '):null);
}
const QUARTERS=['first','second','third','fourth'];

/** Whole positive role clauses, not raw-title fallback or upload-based novelty. */
export function typedSportsActionFact(brief:PostBrief):CaptionFact|null {
  if(brief.kind!=='video'||brief.domain!=='sports'||brief.isQuestion)return null;
  if(!['nba','lakers','bleacher report nba','house of highlights','espn nba'].includes(brief.source?.toLowerCase()??''))return null;
  const original=brief.title.replace(/[\u2018\u2019]/g,"'");
  if(/[?]|\b(?:not|no|never|didn't|doesn't|don't|isn't|wasn't|weren't|won't|can't|cannot|could|would|should|might|may|if|unless|without)\b/i.test(original))return null;
  const title=original.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,' ')
    .replace(/(?:\s+#[a-z0-9_]+)+\s*$/i,'').replace(/\s+/g,' ').replace(/[.!]+$/,'').trim();
  const result=(identity:string,subject:string):CaptionFact=>({person:'',action:'sports_technical_context',identity:`typed_sports_action:${identity}`,subject});
  const blockBucket=title.match(/^(.+?) goes from (?:a )?block to (?:a )?bucket(?: in seconds)?$/i);
  if(blockBucket){const who=actor(blockBucket[1]!);return who?result(`block_bucket:actor:${key(who)}`,`${who} goes from a block to a bucket`):null;}
  const blockDunk=title.match(/^(.+?) blocks the shot and (.+?) (?:throws it down|dunks)$/i);
  if(blockDunk){
    const blocker=actor(blockDunk[1]!),dunker=actor(blockDunk[2]!);
    return blocker&&dunker&&blocker!==dunker?result(`block_dunk:blocker:${key(blocker)}:dunker:${key(dunker)}`,`${blocker} blocks the shot and ${dunker} dunks`):null;
  }
  const halfCourt=title.match(/^(?:"?I work on those\."? )?(.+?) makes half-court shots(?: look easy)?$/i);
  if(halfCourt){const who=actor(halfCourt[1]!);return who?result(`half_court_makes:actor:${key(who)}`,`${who} makes half-court shots`):null;}
  const paired=title.match(/^(.+?) (?:&|and) (.+?) go dunk for dunk(?: back-to-back slams)?$/i);
  if(paired){
    const first=actor(paired[1]!),second=actor(paired[2]!);
    if(!first||!second||first===second)return null;
    const actors=[first,second].sort((a,b)=>a.localeCompare(b));
    return result(`paired_dunks:actors:${actors.map(key).join(':')}`,`${actors[0]} and ${actors[1]} dunk`);
  }
  const points=title.match(/^(.+?) (?:dropped|scores|scored) ([1-9][0-9]?) points in the (first|second|third|fourth) quarter$/i);
  if(points){
    const who=actor(points[1]!);if(!who)return null;
    const quarter=points[3]!.toLowerCase();
    return result(`quarter_points:actor:${key(who)}:points:${Number(points[2])}:quarter:${QUARTERS.indexOf(quarter)+1}`,`${who} scores ${Number(points[2])} points in the ${quarter} quarter`);
  }
  const comeback=title.match(/^(?:the )?(.+?) come back from down ([1-9][0-9]?) to stun (?:the )?(.+?)$/i);
  if(comeback){
    const team=TEAMS[comeback[1]!.toLowerCase()],opponent=TEAMS[comeback[3]!.toLowerCase()];
    if(!team||!opponent||team===opponent)return null;
    return result(`comeback:team:${key(team)}:opponent:${key(opponent)}:deficit:${Number(comeback[2])}`,`The ${team} come back from ${Number(comeback[2])} points down against the ${opponent}`);
  }
  return null;
}
