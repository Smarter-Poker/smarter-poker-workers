import {describe,it,expect} from 'vitest';
import {sportsVideoFact} from './SportsVideoFact.js';
import {briefForAsset} from './PostBrief.js';
const get=(title:string,source:string)=>sportsVideoFact(briefForAsset({kind:'video',domainHint:'sports',source,title}));
// These fixtures expose missing literal roles, role reversal and unsafe actor
// promotion through the real brief -> fact boundary, without network or mocks.
describe('additional verified literal roles',()=>{
 it.each([
  ['Cam Skattebo recorded 0 carries on 6 snaps 😳','Bleacher Report NBA','football:usage:actor:cam skattebo:carries:0:snaps:6'],
  ["Damien Pierce barrels through the Panthers' defense for the touchdown #shorts",'Eagles','football:touchdown:actor:damien pierce:opponent:panthers'],
  ['Kenny Clark gets the third down sack 💪 | 📺: #DALvsGB on NBC📲: Stream on NFL+ #NFL #shorts','Cowboys','football:sack:actor:kenny clark:down:3'],
  ['Jalen Duren had 24 PTS in 15 minutes 😮‍💨','Bleacher Report NBA','basketball:points_in_minutes:actor:jalen duren:points:24:minutes:15'],
  ['Steal by Paul George','Celtics','basketball:steal:actor:paul george'],
  ['Scoot Henderson’s INSANE Chasedown Block Leads to a Krejci 3️⃣','NBA','basketball:block:actor:scoot henderson:kind:chasedown'],
  ['Leonard Miller Saves It, Caleb Wilson FINISHES With the BIG JAM 😤💥','NBA','basketball:dunk:actor:caleb wilson'],
  ['DeMar DeRozan splits the defense and converts 😮‍💨','NBA','basketball:made_basket:actor:demar derozan'],
  ['Darryn Peterson Keeps the Hot Hand Rolling With Back-to-Back And-1 Buckets','NBA','basketball:consecutive_and_ones:actor:darryn peterson:count:2'],
  ['Darius Acuff Jr. with the ball on a string for his first NBA bucket 🔥','NBA','basketball:first_basket:actor:darius acuff jr:competition:nba'],
  ['30 Years in the Making: John Elmore Gets His First Bucket as a Spur 🏀','NBA','basketball:first_team_basket:actor:john elmore:team:spurs'],
  ['LeBron James gets his first bucket as a 76er 🌟','NBA','basketball:first_team_basket:actor:lebron james:team:76ers'],
  ['LeBron with the tough layup for his first 76er points','NBA','basketball:first_team_basket:actor:lebron james:team:76ers'],
  ['Giannis gets downhill for his first Heat bucket! 🔥','NBA','basketball:first_team_basket:actor:giannis antetokounmpo:team:heat'],
  ["PANDEMONIUM for Matthews' OT WINNER! 🫨",'NHL','hockey:overtime_winner:actor:auston matthews'],
  ['IGOR SHESTERKIN HAS SCORED A GOALIE GOAL!!! #nyr #nhl #hockey #igorshesterkin','Rangers','hockey:goal:actor:igor shesterkin:role:goalie'],
  ['Didier Fuentes struck out Shohei Ohtani and the fans behind home plate went CRAZY 😤','FOX Sports','baseball:strikeout:pitcher:didier fuentes:batter:shohei ohtani'],
  ["Fred VanVleet's Slick Between-The-Legs Assist Gets Bogdanovic A Three 🔥",'NBA','basketball:assist:actor:fred vanvleet:kind:between_legs'],
  ['Abner Uribe gets a big strikeout with two runners on to escape the jam!','MLB','baseball:strikeout:pitcher:abner uribe:runners_on:2'],
  ['The Dodgers grab the lead off the bat of Will Smith!','MLB','baseball:go_ahead:actor:will smith:team:dodgers'],
  ['Jake Cronenworth puts the Padres back in front!!','MLB','baseball:go_ahead:actor:jake cronenworth:team:padres'],
  ['Jokić casually throws a dime behind his back 🥶😮‍💨','NBA','basketball:pass:actor:nikola jokic:kind:behind_back'],
  ['The AUDACITY of This Brady Tkachuk Pass 😳','NHL','hockey:pass:actor:brady tkachuk'],
 ])('retains the explicit role in %s',(title,source,identity)=>expect(get(title,source)?.identity).toBe(identity));
 it('binds statistical values to their roles',()=>{
  expect(get('Cam Skattebo recorded 6 carries on 0 snaps','Bleacher Report NBA')).toBeNull();
  expect(get('Cam Skattebo recorded 2 carries on 6 snaps','Bleacher Report NBA')?.identity).toBe('football:usage:actor:cam skattebo:carries:2:snaps:6');
  expect(get('Jalen Duren had 15 PTS in 24 minutes','Bleacher Report NBA')?.identity).toBe('basketball:points_in_minutes:actor:jalen duren:points:15:minutes:24');
 });
 it('keeps the dunk recipient distinct from the player saving the ball',()=>{
  expect(get('Caleb Wilson Saves It, Leonard Miller FINISHES With the BIG JAM','NBA')?.identity).toBe('basketball:dunk:actor:leonard miller');
  expect(get('Caleb Wilson Saves It, Caleb Wilson FINISHES With the BIG JAM','NBA')).toBeNull();
 });
 it('retains only the explicitly credited assist and block roles',()=>{
  const assist=get("Fred VanVleet's Slick Between-The-Legs Assist Gets Bogdanovic A Three",'NBA');
  expect(assist?.subject).toBe("Fred VanVleet's between-the-legs assist");
  expect(assist?.identity).not.toMatch(/bogdanovic/);
  expect(get('Scoot Henderson Chasedown Block','NBA')?.subject).toBe("Scoot Henderson's chasedown block");
  expect(get('Chris Sale strikes out Bryce Harper','MLB')?.identity).toBe('baseball:strikeout:pitcher:chris sale:batter:bryce harper');
  expect(get('Bryce Harper strikes out Chris Sale','MLB')).toBeNull();
 });
 it('coalesces alternate literal grammar into the same existing action namespace',()=>{
  expect(get('Caleb Wilson dunks','NBA')?.identity).toBe('basketball:dunk:actor:caleb wilson');
  expect(get('DeMar DeRozan makes a basket','NBA')?.identity).toBe('basketball:made_basket:actor:demar derozan');
  expect(get('Paul George steals the ball','Celtics')?.identity).toBe('basketball:steal:actor:paul george');
  expect(get('Fred VanVleet makes a between-the-legs assist','NBA')?.identity).toBe('basketball:assist:actor:fred vanvleet:kind:between_legs');
  expect(get('Jake Cronenworth puts the Padres in front','MLB')?.identity).toBe('baseball:go_ahead:actor:jake cronenworth:team:padres');
 });
 it.each([
  ['Unknown Person recorded 0 carries on 6 snaps','Bleacher Report NBA'],
  ['Cam Skattebo recorded 0 snaps on 6 carries','Bleacher Report NBA'],
  ['Cam Skattebo might have recorded 0 carries on 6 snaps','Bleacher Report NBA'],
  ['Cam Skattebo recorded 0 carries on 6 snaps?','Bleacher Report NBA'],
  ['Cam Skattebo never recorded 0 carries on 6 snaps','Bleacher Report NBA'],
  ['Cam Skattebo recorded 0 carries on 6 snaps','MLB'],
  ['Paul George watches a steal','Celtics'],
  ['Steal by Paul George and Unknown Person','Celtics'],
  ['Paul George steals the ball','MLB'],
  ['Crowd Was Ready for Goalie Goal No. 2','NHL'],
  ["Mikel Arteta’s Reaction To Madueke’s Winner",'Premier League'],
  ['LeBron James gets his first bucket as a Celtic','NBA'],
  ['Leonard Miller Saves It, Unknown Person FINISHES With the BIG JAM','NBA'],
  ['Scoot Henderson’s INSANE Chasedown Block Leads to a Krejci 3','MLB'],
  ['Abner Uribe gets a big strikeout with two runners on to escape the jam?','MLB'],
  ['The Dodgers grab the lead off the bat of Unknown Person','MLB'],
  ["Fred VanVleet's Slick Between-The-Legs Assist Gets Unknown Person A Three",'NBA'],
  ['Jokić casually throws a dime behind his back','NHL'],
  ['Abner Uribe gets a big strikeout with zero runners on','MLB'],
  ['Cam Skattebo recorded 99 carries on 6 snaps','Bleacher Report NBA'],
  ['Jalen Duren had 0 PTS in 15 minutes','Bleacher Report NBA'],
  ['Kenny Clark gets the fifth down sack','Cowboys'],
  ['Auston Matthews watches an OT WINNER','NHL'],
  ['Igor Shesterkin may have scored a goalie goal','Rangers'],
  ["Fred VanVleet's Slick Between-The-Legs Pass Gets Bogdanovic A Three",'NBA'],
 ])('refuses unsupported or ambiguous claims %s',(title,source)=>expect(get(title,source)).toBeNull());
});
