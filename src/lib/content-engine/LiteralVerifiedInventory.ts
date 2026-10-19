import type {SportsVideoFact} from './SportsVideoFact.js';
import {literalAdditionalInventory} from './LiteralAdditionalInventory.js';
const key=(s:string)=>s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
const NBA_PLAYERS=['OG Anunoby','Darryn Peterson','Ace Bailey','Damian Lillard','Tobe Awaka','Yaxel Lendeborg','Keaton Wagler','DeMar DeRozan','Jaren Jackson Jr.','Caleb Wilson','Leonard Miller','Aaron Gordon','Brayden Burries','AJ Dybantsa','Darius Acuff Jr.','Tyler Kolek','Scoot Henderson','Fred VanVleet'] as const;
const escaped=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const actorPattern=NBA_PLAYERS.map(escaped).join('|');
const LALIGA_TEAMS=['Málaga CF','Real Sociedad','Real Madrid','Sevilla FC','Real Betis','FC Barcelona','RCD Espanyol','Atlético de Madrid','Levante UD','RC Deportivo','CA Osasuna','Getafe CF','Villarreal CF','Deportivo Alavés'];
const fact=(identity:string,subject:string):SportsVideoFact=>({person:'',identity,subject,action:'sports_technical_context'});
/** Whole verified-source clauses, closed actors and explicit action roles only.
 * No title/video salt, result inference, arbitrary name extraction or adjective
 * claims. A made shot, lob recipient and quarter statistic are distinct roles.
 */
export function literalVerifiedInventory(original:string,source:string|undefined):SportsVideoFact|null{
 const t=original.replace(/[\u2018\u2019]/g,"'").replace(/[\u2010-\u2015]/g,'-')
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,' ').replace(/\s+/g,' ').trim().replace(/[.!]+$/,'');
 if(/[?]|\b(?:not|never|might|could|would|should|watches|reacts|denies|without|if|unless)\b/i.test(t))return null;
 if(source==='laliga'){
  const score=t.match(/^(.+?) ([0-9])\s*-\s*([0-9]) (.+?)(?: \| RESUMEN LALIGA EA SPORTS)?$/i);
  if(score){
   const first=LALIGA_TEAMS.find(team=>key(team)===key(score[1]!)),second=LALIGA_TEAMS.find(team=>key(team)===key(score[4]!));
   if(!first||!second||first===second)return null;
   const ordered=[{team:first,goals:score[2]!},{team:second,goals:score[3]!}].sort((a,b)=>key(a.team).localeCompare(key(b.team)));
   return fact(`soccer:score_recap:${ordered.map(x=>`${key(x.team)}:${x.goals}`).join(':')}`,`the ${first} ${score[2]}-${score[3]} ${second} score recap`);
  }
 }
 if(source==='mls'){
  if(/^Messi bagged a brace against D\.C$/i.test(t))return fact('soccer:goal_total:actor:lionel messi:match:goals:2:opponent:dc',"Lionel Messi's two-goal match against D.C.");
  if(/^Sebastian Gomez first goal for Seattle$/i.test(t))return fact('soccer:goal:actor:sebastian gomez:team:seattle:milestone:first',"Sebastian Gomez's first goal for Seattle");
 }
 if(source==='nhl'){
  if(/^Malkin scores in mid-fall$/i.test(t))return fact('hockey:goal:actor:evgeni malkin:position:falling',"Evgeni Malkin's goal while falling");
  if(/^JJ Peterka wins it in OT for Boston$/i.test(t))return fact('hockey:overtime_winner:actor:jj peterka:team:boston',"JJ Peterka's overtime winner for Boston");
 }
 if(source==='premier league'&&/^Diego Gomez scores from the halfway line$/i.test(t))return fact('soccer:goal:actor:diego gomez:location:halfway_line',"Diego Gomez's goal from the halfway line");
 if(source==='nba'){
  const stat=t.match(/^Joki[cć] is perfect from the field ([1-9][0-9]?)\/([1-9][0-9]?) FG in Q([1-4])$/i);
  if(stat&&stat[1]===stat[2])return fact(`basketball:quarter_field_goals:actor:nikola jokic:made:${stat[1]}:attempted:${stat[2]}:quarter:${stat[3]}`,`Nikola Jokić making ${stat[1]} of ${stat[2]} field-goal attempts in quarter ${stat[3]}`);
  const lob=t.match(new RegExp(`^(${actorPattern}) lobs it up, (${actorPattern}) throws it down$`,'i'));
  if(lob&&key(lob[1]!)!==key(lob[2]!))return fact(`basketball:lob_dunk:passer:${key(lob[1]!)}:receiver:${key(lob[2]!)}`,`${lob[1]} passing a lob to ${lob[2]} for a dunk`);
  const dunk=t.match(new RegExp(`^(${actorPattern}) (?:turns the corner and throws down a (?:powerful )?slam|throws down the hammer with a left-handed poster jam(?: teammates go wild)?|rises up and destroys the rim)$`,'i'));
  // OG Anunoby's maintained CaptionVoice action owns this existing semantic
  // key. Do not shadow it with a new technical-context identity.
  if(dunk&&key(dunk[1]!)!=='og anunoby')return fact(`basketball:dunk:actor:${key(dunk[1]!)}`,`${dunk[1]}'s dunk`);
  const consecutive=t.match(new RegExp(`^(${actorPattern}) (?:starts his Blazers return with back-to-back threes|drains back to back triples)$`,'i'));
  if(consecutive)return fact(`basketball:consecutive_threes:actor:${key(consecutive[1]!)}:count:2`,`${consecutive[1]}'s back-to-back three-pointers`);
  const three=t.match(new RegExp(`^(${actorPattern}) (?:drains the three(?:, then can't believe it)?|makes a three-pointer|hits the 3 for his first preseason bucket)$`,'i'));
  if(three)return fact(`basketball:made_three:actor:${key(three[1]!)}`,`${three[1]}'s made three-pointer`);
  const andOne=t.match(new RegExp(`^(${actorPattern}) (?:powers through for a tough and-1 finish|with the tough and-one)$`,'i'));
  if(andOne)return fact(`basketball:and_one:actor:${key(andOne[1]!)}`,`${andOne[1]}'s and-one basket`);
  const lead=t.match(new RegExp(`^(${actorPattern}) drills the go-ahead shot to give the (Clippers) the lead$`,'i'));
  if(lead)return fact(`basketball:go_ahead_shot:actor:${key(lead[1]!)}:team:${key(lead[2]!)}`,`${lead[1]}'s go-ahead shot for the ${lead[2]}`);
 }
 if(source==='mlb'){
  const win=t.match(/^The (Rays|Brewers|Dodgers|Guardians|Braves|Padres|Yankees) claim victory in (ALCS|NLCS|ALDS|NLDS) Game ([1-7])$/i);
  if(win&&(!/DS$/i.test(win[2]!)||Number(win[3])<=5))return {person:'',action:'baseball_series_context',identity:`baseball:game_win:team:${key(win[1]!)}:series:${key(win[2]!)}:game:${win[3]}`,subject:`the ${win[1]}' ${win[2]!.toUpperCase()} Game ${win[3]} win`};
  const strikeout=t.match(/^(Chris Sale) strikes out (Bryce Harper)$/i);
  if(strikeout)return fact(`baseball:strikeout:pitcher:${key(strikeout[1]!)}:batter:${key(strikeout[2]!)}`,`${strikeout[1]} striking out ${strikeout[2]}`);
  const rbi=t.match(/^(Jos[eé] Ram[ií]rez) drives in another for the (Guardians) in the ([1-9])(?:st|nd|rd|th)$/i);
  if(rbi)return fact(`baseball:runs_batted_in:actor:jose ramirez:team:guardians:runs:1:inning:${rbi[3]}`,`José Ramírez driving in one more run for the Guardians in inning ${rbi[3]}`);
 }
 return literalAdditionalInventory(original,source);
}
