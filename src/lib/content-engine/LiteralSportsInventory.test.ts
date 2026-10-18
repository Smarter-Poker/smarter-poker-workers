import {describe,it,expect} from 'vitest';
import {literalSportsInventory} from './LiteralSportsInventory.js';
import {briefForAsset} from './PostBrief.js';
import {captionFact} from './CaptionVoice.js';
const rows=[
 ['Warriors',"Count 'Em! Brandin Podziemski with the 4-Point Play 🤯 | #shorts",'basketball:four_point_play:actor:brandin podziemski'],
 ['Warriors','Stephen Curry Crazy 4-Point Play 🤯 | #shorts','basketball:four_point_play:actor:stephen curry'],
 ['NBA','Caleb Wilson dropped 12 points in the third quarter 🔥','basketball:quarter_points:actor:caleb wilson:points:12:quarter:third'],
 ['UEFA','Troy Parrott’s solo goal','soccer:goal:actor:troy parrott:run:solo'],
 ['NHL','MUST-SEE goal by Mikko Rantanen 😱🚨','hockey:goal:actor:mikko rantanen'],
 ['MLS','Hany Mukhtar SCRAPPY REBOUND GOAL😤 for Nashville!','soccer:goal:actor:hany mukhtar:team:nashville:phase:rebound'],
 ['MLS','Josuha Guilavogui collects his second goal for the BRACE!✌️','soccer:goal_total:actor:josuha guilavogui:match:goals:2'],
 ['MLB','The Guardians erase an 0-2 series deficit and advance to the ALCS!','baseball:advance:team:guardians:target:alcs:prior_series_deficit:0-2'],
 ['MLB','The Rays are one win away from the ALCS!','baseball:advancement_distance:team:rays:target:alcs:wins_needed:1'],
 ['FOX Sports','The Padres are down 2-0 in the NLDS and lost by one run in each game in Milwaukee','baseball:series_deficit:team:padres:series:nlds:wins:0:opponent_wins:2'],
 ['MLB','Jo Adell knocks in two for the Guardians in ALDS Game 4 as Cleveland tries to force a Game 5!','baseball:runs_batted_in:actor:jo adell:team:guardians:runs:2:series:alds:game:4'],
 ['MLB','Michael Harris II tripled and then scored to give the Braves a lead in NLDS Game 2!','baseball:triple_and_run:actor:michael harris ii:team:braves:series:nlds:game:2'],
] as const;
describe('literal official-source inventory facts',()=>{
 it.each(rows)('preserves actual actor/statistic/role via the ordinary brief %s %s',(source,title,identity)=>{
  const brief=briefForAsset({kind:'video',source,title,domainHint:'sports'});
  expect(captionFact(brief)?.identity).toBe(identity);
 });
 it.each([
  ['NBA','Caleb Wilson dropped 12 points in the third quarter?'],
  ['NBA','Caleb Wilson did not drop 12 points in the third quarter'],
  ['NBA','Caleb Wilson dropped 12 points in the fifth quarter'],
  ['Unknown','Caleb Wilson dropped 12 points in the third quarter'],
  ['MLS','Hany Mukhtar could score a rebound goal for Nashville'],
  ['MLB','The Rays are one win away from the ALCS and will win it'],
  ['MLB','Jo Adell knocks in two for the Guardians in ALDS Game 4 as Cleveland tries to force a Game 4'],
 ])('refuses questions, denial, inference and wrong-source claims %s %s',(source,title)=>{
  expect(literalSportsInventory(title,source.toLowerCase())).toBeNull();
 });
});
