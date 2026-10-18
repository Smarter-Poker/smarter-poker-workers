import type {SportsVideoFact} from './SportsVideoFact.js';

const TEAMS=['Brewers','Dodgers','Padres','Rays','Guardians'] as const;
const team=(raw:string)=>TEAMS.find(name=>name.toLowerCase()===raw.toLowerCase());
const key=(text:string)=>text.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const fact=(identity:string,subject:string,action:SportsVideoFact['action']='sports_technical_context'):SportsVideoFact=>({person:'',identity,subject,action});

/** Closed source/entity/role grammars observed in the verified catalogue.
 * These preserve only an explicit named action/statistic. No title hashes,
 * inferred game results, speculative agency or anonymous capitalized names.
 */
export function literalSportsInventory(title:string,source:string|undefined):SportsVideoFact|null{
 const clean=title.replace(/[\u2018\u2019]/g,"'").replace(/[\u2010-\u2015]/g,'-')
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,' ').replace(/\s+/g,' ').trim().replace(/[.!]+$/,'');
 if(source==='warriors'){
  const m=clean.match(/^(?:Count '?Em! )?(Brandin Podziemski|Stephen Curry) (?:with the |Crazy )4-Point Play$/i);
  if(m){const actor=/stephen/i.test(m[1]!)?'Stephen Curry':'Brandin Podziemski';return fact(`basketball:four_point_play:actor:${key(actor)}`,`${actor}'s four-point play`);}
 }
 if(source==='nba'){
  const m=clean.match(/^Caleb Wilson dropped ([1-9][0-9]?) points in the (first|second|third|fourth) quarter$/i);
  if(m)return fact(`basketball:quarter_points:actor:caleb wilson:points:${m[1]}:quarter:${m[2]!.toLowerCase()}`,`Caleb Wilson's ${m[1]} points in the ${m[2]!.toLowerCase()} quarter`);
 }
 if(source==='uefa'&&/^Troy Parrott's solo goal$/i.test(clean))return fact('soccer:goal:actor:troy parrott:run:solo',"Troy Parrott's solo goal");
 if(source==='nhl'&&/^MUST-SEE goal by Mikko Rantanen$/i.test(clean))return fact('hockey:goal:actor:mikko rantanen',"Mikko Rantanen's goal");
 if(source==='mls'){
  if(/^Hany Mukhtar SCRAPPY REBOUND GOAL for Nashville$/i.test(clean))return fact('soccer:goal:actor:hany mukhtar:team:nashville:phase:rebound',"Hany Mukhtar's rebound goal for Nashville");
  if(/^Josuha Guilavogui collects his second goal for the BRACE$/i.test(clean))return fact('soccer:goal_total:actor:josuha guilavogui:match:goals:2',"Josuha Guilavogui's two-goal match");
 }
 if(source==='mlb'||source==='fox sports'||source==='bleacher report nba'){
  const lead=clean.match(/^(?:The )?(Brewers|Dodgers|Padres|Rays|Guardians) (?:are now up|take the) ([0-3])-([0-3]) (?:on the (Brewers|Dodgers|Padres|Rays|Guardians)|series lead)(?: after getting swept by them last year)?$/i);
  if(lead){
   const actor=team(lead[1]!)!,a=Number(lead[2]),b=Number(lead[3]),opponent=lead[4]?team(lead[4]):undefined;
   if(a<=b||actor===opponent)return null;
   return fact(`baseball:series_lead:team:${key(actor)}:wins:${a}:opponent_wins:${b}${opponent?`:opponent:${key(opponent)}`:''}`,`the ${actor}' ${a}-${b} series lead${opponent?` over the ${opponent}`:''}`,'baseball_series_context');
  }
  const deficit=clean.match(/^The Padres are down ([1-3])-([0-2]) in the NLDS and lost by one run in each game in Milwaukee$/i);
  if(deficit&&Number(deficit[1])>Number(deficit[2]))return fact(`baseball:series_deficit:team:padres:series:nlds:wins:${deficit[2]}:opponent_wins:${deficit[1]}`,`the Padres trailing ${deficit[1]}-${deficit[2]} in the NLDS`,'baseball_series_context');
  if(/^The Rays are one win away from the ALCS$/i.test(clean))return fact('baseball:advancement_distance:team:rays:target:alcs:wins_needed:1',"the Rays needing one more win to reach the ALCS",'baseball_series_context');
  if(/^The Guardians erase an? 0-2 series deficit and advance to the ALCS$/i.test(clean))return fact('baseball:advance:team:guardians:target:alcs:prior_series_deficit:0-2',"the Guardians reaching the ALCS from a 0-2 series deficit",'baseball_series_context');
 }
 if(source==='mlb'){
  const adell=clean.match(/^Jo Adell knocks in two for the Guardians in ALDS Game ([1-5]) as Cleveland tries to force a Game ([1-5])$/i);
  if(adell&&Number(adell[2])===Number(adell[1])+1)return fact(`baseball:runs_batted_in:actor:jo adell:team:guardians:runs:2:series:alds:game:${adell[1]}`,`Jo Adell driving in two runs for the Guardians in ALDS Game ${adell[1]}`);
  const harris=clean.match(/^Michael Harris II tripled and then scored to give the Braves a lead in NLDS Game ([1-5])$/i);
  if(harris)return fact(`baseball:triple_and_run:actor:michael harris ii:team:braves:series:nlds:game:${harris[1]}`,`Michael Harris II's triple and go-ahead run for the Braves in NLDS Game ${harris[1]}`);
 }
 return null;
}
