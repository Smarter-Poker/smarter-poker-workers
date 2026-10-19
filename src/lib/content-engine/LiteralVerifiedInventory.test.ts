import {describe,it,expect} from 'vitest';
import {sportsVideoFact} from './SportsVideoFact.js';
import {briefForAsset} from './PostBrief.js';
const get=(title:string,source='NBA')=>sportsVideoFact(briefForAsset({kind:'video',domainHint:'sports',source,title}));
describe('verified literal action supply',()=>{
 it.each([
  ['Darryn Peterson lobs it up, Ace Bailey throws it down 🔥','basketball:lob_dunk:passer:darryn peterson:receiver:ace bailey'],
  ['Damian Lillard Starts His Blazers Return With Back-to-Back Threes','basketball:consecutive_threes:actor:damian lillard:count:2'],
  ['JOKIĆ IS PERFECT FROM THE FIELD 👀🔥 5/5 FG IN Q1!','basketball:quarter_field_goals:actor:nikola jokic:made:5:attempted:5:quarter:1'],
  ['Tobe Awaka Drains the Three, Then Can’t Believe It 😳😂','basketball:made_three:actor:tobe awaka'],
  ['Yaxel Lendeborg Powers Through for a Tough And-1 Finish','basketball:and_one:actor:yaxel lendeborg'],
  ['Keaton Wagler Drills the Go-Ahead Shot to Give the Clippers the lead','basketball:go_ahead_shot:actor:keaton wagler:team:clippers'],
 ])('reads only literal action %s',(title,identity)=>expect(get(title)?.identity).toBe(identity));
 it('uses existing named game-win namespace',()=>expect(get('The Rays claim victory in ALCS Game 5!','MLB')?.identity).toBe('baseball:game_win:team:rays:series:alcs:game:5'));
 it('retains only literal pitching and RBI roles',()=>{
  expect(get('Chris Sale strikes out Bryce Harper!','MLB')?.identity).toBe('baseball:strikeout:pitcher:chris sale:batter:bryce harper');
  expect(get('José Ramírez drives in another for the Guardians in the 9th!','MLB')?.subject).toBe('José Ramírez driving in one more run for the Guardians in inning 9');
 });
 it('parses structured score recaps without inferring a final result or salting aliases',()=>{
  const a=get('REAL MADRID 4 - 1 SEVILLA FC | RESUMEN LALIGA EA SPORTS','LaLiga');
  expect(a?.subject).toBe('the Real Madrid 4-1 Sevilla FC score recap');
  expect(a?.identity).toBe(get('SEVILLA FC 1 - 4 REAL MADRID | RESUMEN LALIGA EA SPORTS','LaLiga')?.identity);
  expect(get('UNKNOWN FC 4 - 1 SEVILLA FC | RESUMEN LALIGA EA SPORTS','LaLiga')).toBeNull();
 });
 it('keeps soccer totals and named hockey results in their literal roles',()=>{
  expect(get('Kelvin Yeboah 15 GOALS on the season!','MLS')?.identity).toBe('soccer:goal_total:actor:kelvin yeboah:season:goals:15');
  expect(get('Messi BAGGED A BRACE against D.C.!!','MLS')?.subject).toBe("Lionel Messi's two-goal match against D.C.");
  expect(get('JJ Peterka Wins It in OT for Boston!','NHL')?.identity).toBe('hockey:overtime_winner:actor:jj peterka:team:boston');
 });
 it.each(['Unknown Person Drains the Three','Tobe Awaka might drain the Three','Tobe Awaka does not drain the Three','Tobe Awaka watches OG Anunoby drain the Three','Tobe Awaka Drains the Three?','OG Anunoby Throws Down','JOKIĆ IS PERFECT FROM THE FIELD 6/5 FG IN Q1!'])('rejects incomplete/negated/foreign agency %s',title=>expect(get(title)).toBeNull());
 it('rejects wrong sources and aliases do not manufacture freshness',()=>{
  expect(get('Tobe Awaka Drains the Three','MLB')).toBeNull();
  expect(get('Tobe Awaka Drains the Three')?.identity).toBe(get('Tobe Awaka makes a three-pointer')?.identity);
 });
});
