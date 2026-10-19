import type {SportsVideoFact} from './SportsVideoFact.js';

const key=(value:string)=>value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
const NBA_ACTORS=['Caleb Wilson','Leonard Miller','DeMar DeRozan','Darryn Peterson','Darius Acuff Jr.','John Elmore','LeBron James','Giannis Antetokounmpo','Scoot Henderson','Paul George','Jalen Duren'];
const aliases:Record<string,string>={'lebron':'LeBron James','giannis':'Giannis Antetokounmpo'};
const actor=(value:string)=>NBA_ACTORS.find(name=>key(name)===key(value))??aliases[key(value)];
const fact=(identity:string,subject:string):SportsVideoFact=>({person:'',action:'sports_technical_context',identity,subject});
const teams:Record<string,string>={spur:'Spurs',spurs:'Spurs','76er':'76ers','76ers':'76ers',heat:'Heat'};

/** Additional closed source/actor/action grammars from the verified catalogue.
 * Role-labelled numbers and named action subjects own identity. Optional source
 * decoration never contributes identity, nor do adjectives, upload IDs or dates.
 * A block remains a block: its subsequent shot is not promoted to an assist.
 */
export function literalAdditionalInventory(original:string,source:string|undefined):SportsVideoFact|null{
 const t=original.replace(/[\u2018\u2019]/g,"'").replace(/[\u2010-\u2015]/g,'-')
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{20E3}]/gu,' ')
  .replace(/(?:\s*#[A-Za-z0-9_]+)+\s*$/,'').replace(/\s+/g,' ').trim().replace(/[.!]+$/,'');
 if(/[?]|\b(?:not|no|never|didn't|doesn't|don't|isn't|wasn't|weren't|won't|can't|cannot|could|would|should|might|may|if|unless|without|reacts|watches|denies)\b/i.test(t))return null;
 if(source==='bleacher report nba'){
  const usage=t.match(/^(Cam Skattebo) recorded (0|[1-9][0-9]?) carries on ([1-9][0-9]?) snaps$/i);
  if(usage&&Number(usage[2])<=Number(usage[3]))return fact(`football:usage:actor:${key(usage[1]!)}:carries:${usage[2]}:snaps:${usage[3]}`,`${usage[1]}'s ${usage[2]} carries on ${usage[3]} snaps`);
  const points=t.match(/^(Jalen Duren) had ([1-9][0-9]?) (?:PTS|points) in ([1-9][0-9]?) minutes$/i);
  if(points)return fact(`basketball:points_in_minutes:actor:${key(points[1]!)}:points:${points[2]}:minutes:${points[3]}`,`${points[1]}'s ${points[2]} points in ${points[3]} minutes`);
 }
 if(source==='eagles'){
  const td=t.match(/^(Damien Pierce) (?:barrels through the (Panthers)'? defense for the touchdown|scores a touchdown against the (Panthers))$/i);
  if(td)return fact(`football:touchdown:actor:${key(td[1]!)}:opponent:${key((td[2]??td[3])!)}`,`${td[1]}'s touchdown against the Panthers`);
 }
 if(source==='cowboys'){
  const sack=t.match(/^(Kenny Clark) gets the (first|second|third|fourth) down sack(?:[.!]* \| : #DALvsGB on NBC : Stream on NFL\+)?$/i);
  if(sack){const down=['first','second','third','fourth'].indexOf(sack[2]!.toLowerCase())+1;return fact(`football:sack:actor:${key(sack[1]!)}:down:${down}`,`${sack[1]}'s sack on down ${down}`);}
 }
 if(source==='celtics'||source==='nba'){
  const steal=t.match(/^(?:Steal by (.+?)|(.+?) steals the ball)$/i);
  const name=steal&&actor((steal[1]??steal[2])!);
  if(name)return fact(`basketball:steal:actor:${key(name)}`,`${name}'s steal`);
 }
 if(source==='nba'){
  const assist=t.match(/^(Fred VanVleet)(?:'s (?:Slick )?Between-The-Legs Assist Gets Bogdanovic A Three| makes a between-the-legs assist)$/i);
  // Bogdanovic is not disambiguated by this source. Retain the explicitly
  // credited passer's assist only; do not invent the receiver's full identity.
  if(assist)return fact('basketball:assist:actor:fred vanvleet:kind:between_legs',"Fred VanVleet's between-the-legs assist");
  const pass=t.match(/^(?:Joki[cć]|Nikola Joki[cć]) (?:casually )?throws a dime behind his back$/i);
  if(pass)return fact('basketball:pass:actor:nikola jokic:kind:behind_back',"Nikola Jokić's behind-the-back pass");
  const first=t.match(/^(?:30 Years in the Making: )?(.+?) (?:(?:gets his first bucket as a (Spur|76er))|(?:with the tough layup for his first (76er) points)|(?:gets downhill for his first (Heat) bucket))$/i);
  const firstActor=first&&actor(first[1]!);
  if(firstActor){const team=teams[(first![2]??first![3]??first![4])!.toLowerCase()]!;return fact(`basketball:first_team_basket:actor:${key(firstActor)}:team:${key(team)}`,`${firstActor}'s first basket for the ${team}`);}
  const debut=t.match(/^(.+?) with the ball on a string for his first NBA bucket$/i);
  const debutActor=debut&&actor(debut[1]!);
  if(debutActor)return fact(`basketball:first_basket:actor:${key(debutActor)}:competition:nba`,`${debutActor}'s first NBA basket`);
  const block=t.match(/^(.+?)(?:'s)? (?:INSANE )?Chasedown Block(?: Leads to a Krejci 3)?$/i);
  const blocker=block&&actor(block[1]!);
  if(blocker)return fact(`basketball:block:actor:${key(blocker)}:kind:chasedown`,`${blocker}'s chasedown block`);
  const pair=t.match(/^(.+?) Saves It, (.+?) FINISHES With the (?:BIG )?JAM$/i);
  if(pair&&actor(pair[1]!)&&actor(pair[2]!)&&actor(pair[1]!)!==actor(pair[2]!))return fact(`basketball:dunk:actor:${key(actor(pair[2]!)!)}`,`${actor(pair[2]!)}'s dunk`);
  const dunk=t.match(/^(.+?) dunks$/i),dunker=dunk&&actor(dunk[1]!);
  if(dunker)return fact(`basketball:dunk:actor:${key(dunker)}`,`${dunker}'s dunk`);
  const made=t.match(/^(.+?) (?:splits the defense and converts|makes a basket)$/i),scorer=made&&actor(made[1]!);
  if(scorer)return fact(`basketball:made_basket:actor:${key(scorer)}`,`${scorer}'s made basket`);
  const andOnes=t.match(/^(.+?) (?:Keeps the Hot Hand Rolling With )?Back-to-Back And-1 Buckets$/i),finisher=andOnes&&actor(andOnes[1]!);
  if(finisher)return fact(`basketball:consecutive_and_ones:actor:${key(finisher)}:count:2`,`${finisher}'s back-to-back and-one baskets`);
 }
 if(source==='nhl'){
  const pass=t.match(/^(?:The AUDACITY of This )?(Brady Tkachuk) Pass$/i);
  if(pass)return fact('hockey:pass:actor:brady tkachuk',"Brady Tkachuk's pass");
  const winner=t.match(/^(?:PANDEMONIUM for )?(Matthews|Auston Matthews)(?:'s|')? OT WINNER$/i);
  if(winner)return fact('hockey:overtime_winner:actor:auston matthews',"Auston Matthews' overtime winner");
 }
 if(source==='rangers'){
  const goal=t.match(/^(Igor Shesterkin) (?:HAS SCORED A GOALIE GOAL|scores a goalie goal)$/i);
  if(goal)return fact('hockey:goal:actor:igor shesterkin:role:goalie',"Igor Shesterkin's goalie goal");
 }
 if(source==='fox sports'||source==='mlb'){
  const strikeout=t.match(/^(Didier Fuentes|Chris Sale) (?:struck|strikes) out (Shohei Ohtani|Bryce Harper)(?: and the fans behind home plate went CRAZY)?$/i);
  if(strikeout)return fact(`baseball:strikeout:pitcher:${key(strikeout[1]!)}:batter:${key(strikeout[2]!)}`,`${strikeout[1]} striking out ${strikeout[2]}`);
 }
 if(source==='mlb'){
  const strikeout=t.match(/^(Abner Uribe) gets a (?:big )?strikeout with (one|two|three|[1-3]) runners? on(?: to escape the jam)?$/i);
  if(strikeout){const count:Record<string,number>={one:1,two:2,three:3};const runners=count[strikeout[2]!.toLowerCase()]??Number(strikeout[2]);return fact(`baseball:strikeout:pitcher:${key(strikeout[1]!)}:runners_on:${runners}`,`${strikeout[1]}'s strikeout with ${runners} runners on`);}
  const lead=t.match(/^(?:The (Dodgers|Padres) grab the lead off the bat of (Will Smith|Jake Cronenworth)|(Will Smith|Jake Cronenworth) puts the (Dodgers|Padres) (?:back )?in front)$/i);
  if(lead){const team=(lead[1]??lead[4])!,name=(lead[2]??lead[3])!;return fact(`baseball:go_ahead:actor:${key(name)}:team:${key(team)}`,`${name} putting the ${team} ahead`);}
 }
 return null;
}
