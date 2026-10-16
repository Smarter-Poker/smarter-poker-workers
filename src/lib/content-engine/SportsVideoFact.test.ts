import { describe, expect, it } from 'vitest';
import { briefForAsset } from './PostBrief.js';
import { sportsVideoFact } from './SportsVideoFact.js';
const fact=(title:string)=>sportsVideoFact(briefForAsset({kind:'video',domainHint:'sports',source:'MLB',title}));

describe('source-bound typed sports quantities',()=>{
  it('preserves the actual solo homer, deficit and inning without inventing the final result',()=>{
    expect(fact("Cedric Mullins' solo shot draws the Rays within 1 in the 8th!")).toEqual({person:'',action:'baseball_home_run_context',identity:'baseball:home_run:actor:cedric mullins:runs:1:team:rays:deficit:1:inning:8',subject:"Cedric Mullins' solo home run that brings the Rays within 1 run in inning 8"});
    expect(fact("Cedric Mullins' one-run homer draws the Rays within one in the eighth")?.identity).toBe(fact("Cedric Mullins' solo shot draws the Rays within 1 in the 8th!")?.identity);
  });
  it('canonicalizes explicit game-tying two-run homers without guessing a score',()=>{
    const first=fact('Jackson Chourio ties the game with a 2-run blast 💥');
    expect(first).toMatchObject({action:'baseball_home_run_context',identity:'baseball:home_run:actor:jackson chourio:runs:2:game_tying'});
    expect(fact('Jackson Chourio ties the game with a two-run home run')?.identity).toBe(first?.identity);
    expect(fact('Jackson Chourio ties the game with a three-run homer')?.identity).not.toBe(first?.identity);
  });
  it('binds the game and series in the literal closing win without crediting a save',()=>{
    const first=fact("Bryan Baker closes out the Rays' ALCS Game 2 win!");
    expect(first).toMatchObject({action:'baseball_close_context',identity:'baseball:close:actor:bryan baker:team:rays:series:alcs:game:2:win'});
    expect(fact("Bryan Baker closes out the Rays' ALCS Game two win")?.identity).toBe(first?.identity);
    expect(first?.subject).not.toMatch(/save|strikeout|shutout/i);
  });
  it('binds a season goal total, not goals in one game',()=>{
    const first=fact('Kelvin Yeboah 15 GOALS🔥 on the season!');
    expect(first).toMatchObject({action:'soccer_goal_total_context',identity:'soccer:goal_total:actor:kelvin yeboah:season:goals:15'});
    expect(fact('Kelvin Yeboah has fifteen goals in his season')?.identity).toBe(first?.identity);
    expect(fact('Kelvin Yeboah 1 goal on the season')?.identity).toContain(':goals:1');
  });
  it.each([
    'Unknown Person hits a solo home run',
    'Mullins hits a solo home run',
    'Cedric Mullins might hit a solo home run',
    'Did Cedric Mullins hit a solo home run?',
    "Cedric Mullins didn't hit a solo home run",
    'Cedric Mullins hits a solo home run and Jackson Chourio hits a solo home run',
    'Cedric Mullins hits a solo two-run homer',
    "Cedric Mullins' solo shot draws the Rays within 0 in the 8th",
    "Cedric Mullins' solo shot draws the Rays within 1 in the 0th",
    "Cedric Mullins' solo shot draws the Rays within 1 in the 13rd",
    "Cedric Mullins' solo shot draws the Rays within 1 in the 8th and wins the game",
    'Jackson Chourio ties the game with a 5-run blast',
    "Bryan Baker closes out the Rays' ALCS Game 8 win",
    "Bryan Baker closes out the Rays' ALDS Game 6 win",
    "Bryan Baker closes out the Rays' ALCS Game 2 win and earns a save",
    'Kelvin Yeboah 0 goals on the season',
    'Kelvin Yeboah 15.5 goals on the season',
    'Kelvin Yeboah 15 goals in one game',
    'Kelvin Yeboah 15 goal on the season',
    'Kelvin Yeboah 1 goals on the season',
    'Kelvin Yeboah 15 goals on the season and 18 in his career',
  ])('refuses unsupported, hypothetical or conflicting claims: %s',title=>expect(fact(title)).toBeNull());
  it('does not enable these sports-video facts for news, poker or an explicit question',()=>{
    const b=briefForAsset({kind:'video',domainHint:'sports',title:'Kelvin Yeboah 15 goals on the season',source:'MLS'});
    expect(sportsVideoFact({...b,kind:'link'})).toBeNull();
    expect(sportsVideoFact({...b,domain:'poker'})).toBeNull();
    expect(sportsVideoFact({...b,isQuestion:true})).toBeNull();
  });
});
