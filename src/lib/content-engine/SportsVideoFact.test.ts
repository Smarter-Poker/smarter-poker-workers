import { describe, expect, it } from 'vitest';
import { briefForAsset } from './PostBrief.js';
import { sportsVideoFact } from './SportsVideoFact.js';
import { captionFact } from './CaptionVoice.js';
import { composeCaption, RELEVANCE_FLOOR } from './Composer.js';
import { styleSheetFor } from './StyleSheet.js';
const fact=(title:string)=>sportsVideoFact(briefForAsset({kind:'video',domainHint:'sports',source:'MLB',title}));

// Verified/global-asset-fresh short inventory observed October16 22:13UTC.
const LITERAL_ACTIONS=[
  ['969O2r2Sjlo','MLB','The Brewers take a 3-0 series lead in the NLCS!','baseball:series_lead:team:brewers:series:nlcs:wins:3:opponent_wins:0'],
  ['7bDfzZcxEFY','MLB','Game 1 of the ALCS belongs to Cleveland!','baseball:game_win:team:guardians:series:alcs:game:1'],
  ['c2bLJCKA7xw','MLB','The ALCS is tied going back to Cleveland 👀','baseball:series_tied:series:alcs:return_team:guardians'],
  ['RM9NG9WyWFY','MLB','Trevor Megill closes out a Game 1 win for the Brewers!','baseball:close:actor:trevor megill:team:brewers:game:1:win'],
  ['-Vrl-Cup7oA','MLB','William Contreras gets the Brewers on the board in Game 3!','baseball:first_scoring:actor:william contreras:team:brewers:game:3'],
  ['w0l0mcuBD94','MLB','Luis Lara puts the Brewers in front of the Dodgers in Game 1!','baseball:go_ahead:actor:luis lara:team:brewers:opponent:dodgers:game:1'],
  ['6Ek4z7CS3jY','FOX Sports','Brewers Take Game 1 of NLCS Over Dodgers ⚾️ #baseball #mlb','baseball:game_win:team:brewers:series:nlcs:game:1'],
  ['p3kXb96WMXw','Bleacher Report NBA','Brewers sweep the Dodgers in the NLCS 🚨','team:brewers:opponent:dodgers:series:nlcs:sweep'],
  ['PzocaJTzMHg','MLB','JAKE BAUERS BATTLES THROUGH AN 11-PITCH AT-BAT TO PUT THE BREWERS AHEAD!','baseball:go_ahead_at_bat:actor:jake bauers:team:brewers:pitches:11'],
  ['joBfuGGEEqY','MLB','Munetaka Murakami executes the 3-6-3 double play to perfection!','baseball:double_play:actor:munetaka murakami:sequence:3-6-3'],
  ['yuz5nFkbj5E','NBA','Keaton Wagler Hits the Brakes and Drains the Tough Step-Back Triple','basketball:made_three:actor:keaton wagler:shot:step_back'],
  ['BQmi0FOVDv4','UEFA','Arda Güler free-kick 💫','soccer:free_kick:actor:arda guler'],
  ['jR_DYAntPeQ','NHL','Connor McDavid with the casual 1-on-3 DANGLE','hockey:puck_handling:actor:connor mcdavid:defenders:3'],
  ['pPp6k3eV8-M','Rangers','SEAN DURZI SCORES! HIS FIRST AS A RANGER!','hockey:goal:actor:sean durzi:team:rangers:milestone:first'],
] as const;

describe('literal retained sports contexts',()=>{
  it.each(LITERAL_ACTIONS)('grounds %s without a title identity',(_id,source,title,identity)=>{
    const b=briefForAsset({kind:'video',domainHint:'sports',source,title,sportHint:'nba'});
    expect(sportsVideoFact(b)?.identity).toBe(identity);
    expect(captionFact(b)?.identity).toBe(identity);
    for(const author of ['1cdb67d7-27af-4709-817c-9270bd915249','48ada431-72b1-4cdb-8abe-541b9f6b179c']){
      const out=composeCaption(b,styleSheetFor(author));
      expect(out.text).not.toBe('');expect(out.relevance).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
      expect(out.semanticKey).not.toContain(_id);
    }
  });
  it('coalesces aliases and the existing news sweep namespace across media',()=>{
    expect(fact('Guardians take Game 1 of ALCS over Rays')?.identity).toBe(fact('Game 1 of the ALCS belongs to Cleveland!')?.identity);
    expect(fact('The Milwaukee Brewers take a 3-0 series lead in the NLCS!')?.identity).toBe(fact(LITERAL_ACTIONS[0][2])?.identity);
    const title=LITERAL_ACTIONS[7][2];
    const video=captionFact(briefForAsset({kind:'video',domainHint:'sports',source:'MLB',title}));
    const news=captionFact(briefForAsset({kind:'link',domainHint:'sports',source:'MLB',title:'Brewers sweep Dodgers in NLCS'}));
    expect(video?.identity).toBe(news?.identity);expect(video?.action).toBe(news?.action);
  });
  it('does not convert literal technical context into stronger results',()=>{
    const get=(index:number)=>sportsVideoFact(briefForAsset({kind:'video',domainHint:'sports',source:LITERAL_ACTIONS[index]![1],title:LITERAL_ACTIONS[index]![2]}))!;
    expect(get(3).subject).not.toMatch(/save|strikeout|shutout/i);
    expect(get(8).subject).not.toMatch(/home run|single|walk|double|triple/i);
    expect(get(9).subject).not.toMatch(/score|win|assist/i);
    expect(get(11).subject).not.toMatch(/goal|scored|finish/i);
    expect(get(12).subject).not.toMatch(/goal|scored|beat|finish/i);
  });
  it.each([
    ['MLB','The Brewers take a 0-3 series lead in the NLCS!'],
    ['MLB','The Brewers take a 3-0 series lead in the NLDS!'],
    ['MLB','The Brewers take a 4-0 series lead in the NLCS!'],
    ['MLB','Game 6 of the NLDS belongs to Cleveland!'],
    ['MLB','Game 1 of the ALCS belongs to Unknown Team!'],
    ['MLB','Brewers take Game 1 of NLCS over Brewers'],
    ['MLB','The ALCS is tied going back to Atlantis'],
    ['MLB','Unknown Person closes out a Game 1 win for the Brewers!'],
    ['MLB','Jake Bauers battles through an 11-pitch at-bat to put the Brewers ahead and wins'],
    ['MLB','Munetaka Murakami executes the 3-6-3 double play and scores'],
    ['NBA','Keaton Wagler might drain the tough step-back triple'],
    ['UEFA','Arda Güler free-kick goal'],
    ['NHL','Connor McDavid with the casual 1-on-3 DANGLE and scores'],
    ['Rangers','Sean Durzi never scores! His first as a Ranger!'],
    ['Unknown source','The Brewers take a 3-0 series lead in the NLCS!'],
    ['NBA','Munetaka Murakami executes the 3-6-3 double play to perfection!'],
  ])('rejects unsupported or compound context %s %s',(source,title)=>expect(sportsVideoFact(briefForAsset({kind:'video',domainHint:'sports',source,title}))).toBeNull());
});

// Actual verified/global30day-unused titles read October16 22:13UTC. IDs
// retain fixture provenance only; no identity below is keyed by video ID.
const REAL_CONTEXTS = [
  ['BiRzubR8t1k','MLB','Dodgers vs. Brewers NLCS Game 2 Shorts Recap','baseball_matchup_context'],
  ['3iWikIagV4c','MLB','Dodgers vs. Braves NLDS Game 4 Shorts Recap','baseball_matchup_context'],
  ['RUE9f5tAKK0','MLB','Dodgers vs. Braves NLDS Game 3 Shorts Recap','baseball_matchup_context'],
  ['aryR-pcFb9w','MLB','White Sox vs. Guardians ALDS Game 2 Shorts Recap','baseball_matchup_context'],
  ['u8GhCndnMhk','MLB','Padres vs. Brewers NLDS Game 2 Shorts Recap','baseball_matchup_context'],
  ['xMdOeW6IdQE','NBA','Aaron Gordon’s Fancy Handle Finds Cam Johnson for the Open Three','basketball_passing_context'],
  ['FlyWwBI3dD0','NBA','Jamal Murray goes behind the back to set up the Jokić pass to Aaron Gordon for the corner three 🔥','basketball_passing_context'],
  ['NxZuh01o-o0','House of Highlights','WHAT A MOMENT. 🤯 USWNT GOAL TO TIE SPAIN 🇺🇸🔥','soccer_equalizer_context'],
] as const;

describe('actual fresh video contexts without invented results',()=>{
  it.each(REAL_CONTEXTS)('writes a genuinely bound subject for %s',(_id,source,title,action)=>{
    const brief=briefForAsset({kind:'video',domainHint:'sports',source,title});
    const bound=captionFact(brief);
    expect(bound).toMatchObject({action});
    expect(bound?.subject).not.toMatch(/\b(?:wins?|winner|scored|made|assist|final score)\b/i);
    const composed=composeCaption(brief,styleSheetFor('1cdb67d7-27af-4709-817c-9270bd915249'));
    expect(composed.text).not.toBe('');
    expect(composed.relevance).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
    expect(composed.semanticKey).toContain(`:${action}:`);
    expect(composed.semanticKey).not.toContain(_id);
  });
  it('canonicalizes equivalent matchup wording/order and aliases, not arbitrary title words',()=>{
    const first=fact('Dodgers vs. Braves NLDS Game 3 Shorts Recap');
    expect(first?.identity).toBe('baseball:matchup:braves:dodgers:series:nlds:game:3');
    expect(fact('Atlanta Braves versus Los Angeles Dodgers NLDS Game 3 Recap')?.identity).toBe(first?.identity);
    expect(fact('Dodgers vs. Braves NLDS Game 4 Shorts Recap')?.identity).not.toBe(first?.identity);
    expect(first?.subject).toBe('the Braves versus Dodgers NLDS Game 3 matchup');
  });
  it('describes only passing and the open look, not a made shot or credited assist',()=>{
    const first=sportsVideoFact(briefForAsset({kind:'video',domainHint:'sports',source:'NBA',title:REAL_CONTEXTS[5][2]}));
    expect(first?.subject).toBe('Aaron Gordon finding Cam Johnson for an open three-point look');
    const chain=sportsVideoFact(briefForAsset({kind:'video',domainHint:'sports',source:'NBA',title:REAL_CONTEXTS[6][2]}));
    expect(chain?.identity).toBe('basketball:pass_chain:jamal murray:jokic:aaron gordon:look:corner three');
    expect(chain?.subject).not.toMatch(/made|assist|win|scored/i);
  });
  it('retains the equalizer without inventing a final score or winner',()=>{
    // This actual pool row carries nba/dunk metadata from a mixed channel.
    // Retain that provenance hint without overriding the literal soccer fact.
    const b=briefForAsset({kind:'video',domainHint:'sports',source:'House of Highlights',title:REAL_CONTEXTS[7][2],sportHint:'nba'});
    expect(sportsVideoFact(b)).toEqual({person:'',action:'soccer_equalizer_context',identity:'soccer:team_goal:uswnt:opponent:spain:effect:equalizer',subject:'the USWNT equalizing goal against Spain'});
    const composed=composeCaption(b,styleSheetFor('1cdb67d7-27af-4709-817c-9270bd915249'));
    expect(composed.text).toMatch(/USWNT|Spain/i);
    expect(composed.text).not.toMatch(/basket|dunk|three.pointer|rebound|assist|final score/i);
    expect(composed.relevance).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
  });
  it.each([
    ['MLB','Dodgers vs. Unknown Team NLDS Game 3 Shorts Recap'],
    ['MLB','Dodgers vs. Dodgers NLDS Game 3 Shorts Recap'],
    ['MLB','Dodgers vs. Braves NLDS Game 6 Shorts Recap'],
    ['MLB','Dodgers vs. Braves NLCS Game 8 Shorts Recap'],
    ['MLB','Dodgers vs. Braves World Series Game 0 Shorts Recap'],
    ['MLB','Dodgers might beat Braves NLDS Game 3 Shorts Recap'],
    ['MLB','Dodgers vs. Braves NLDS Game 3 Shorts Recap and Dodgers win'],
    ['MLB','Dodgers vs. Braves NLDS Game 3 Shorts Recap and Yankees vs. Mets NLCS Game 2 Recap'],
    ['Unregistered source','Dodgers vs. Braves NLDS Game 3 Shorts Recap'],
    ['NBA','Aaron Gordon did not find Cam Johnson for the Open Three'],
    ['NBA','Aaron Gordon could find Cam Johnson for the Open Three'],
    ['NBA','Aaron Gordon’s Fancy Handle Finds Unknown Person for the Open Three'],
    ['NBA','Aaron Gordon’s Fancy Handle Finds Cam Johnson for the Open Three and he makes it'],
    ['NBA','Aaron Gordon goes behind the back to set up the Jokić pass to Jamal Murray for the corner three'],
    ['House of Highlights','USWNT GOAL TO TIE SPAIN AND WIN THE GAME'],
    ['House of Highlights','USWNT GOAL TO TIE FRANCE'],
    ['House of Highlights','USWNT might score a goal to tie Spain'],
  ])('refuses unsupported extra context %s: %s',(source,title)=>expect(sportsVideoFact(briefForAsset({kind:'video',domainHint:'sports',source,title}))).toBeNull());
});

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
