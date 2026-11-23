import { describe, expect, it } from 'vitest';
import { briefForAsset } from './PostBrief.js';
import { sportsVideoFact } from './SportsVideoFact.js';
import { captionFact, subjectCaption } from './CaptionVoice.js';
import { composeCaption, RELEVANCE_FLOOR } from './Composer.js';
import { captionQuality } from './CaptionQuality.js';
import { styleSheetFor } from './StyleSheet.js';
import { isCaptionableSharedVideoClip } from './HorsePublisher.js';

const testAuthors = [
  '1cdb67d7-27af-4709-817c-9270bd915249',
  '48ada431-72b1-4cdb-8abe-541b9f6b179c',
  '00000000-0000-4000-8000-000000000002',
];

const VERIFIED_SPORTS_CASES: ReadonlyArray<readonly [string, string, string, string]> = [
  // NBA & basketball channels
  ['NBA', 'Buddy Hield Beats the First-Half Buzzer With a COLD-BLOODED Pull-Up 3🎯', 'basketball:buzzer_beater:actor:buddy hield:period:first_half:shot:pull_up_three', 'Buddy Hield beat the first-half buzzer with a pull-up three-pointer'],
  ['NBA', 'Cooper Flagg Pulls Up and Beats the Buzzer from DEEP', 'basketball:buzzer_beater:actor:cooper flagg:shot:deep_pull_up', 'Cooper Flagg pulled up and beat the buzzer from deep'],
  ['NBA', 'Mikal Bridges hits the Tissot buzzer beater vs Trail Blazers! 🚨', 'basketball:buzzer_beater:actor:mikal bridges:opponent:trail blazers', 'Mikal Bridges hit a buzzer-beater against the Trail Blazers'],
  ['NBA', 'Draymond Green Drains the Corner 3 and Leaves Steph Curry in TOTAL DISBELIEF', 'basketball:made_three:actor:draymond green:shot:corner', 'Draymond Green made a corner three-pointer'],
  ['NBA', 'Wemby hits the three for his 3rd 50 point game of the season', 'basketball:scoring_milestone:actor:victor wembanyama:points:50:season_count:3:shot:three', 'Victor Wembanyama hit a three-pointer for his third 50-point game of the season'],
  ['NBA', 'Scottie Barnes Goes 9-for-9 and Puts a Defender on a Poster!', 'basketball:perfect_shooting_dunk:actor:scottie barnes:made:9:attempted:9', 'Scottie Barnes went 9-for-9 and finished a dunk'],
  ['NBA', 'James Harden Drops 40 And He’s Still Cooking 🔥', 'basketball:scoring_total:actor:james harden:points:40', 'James Harden scored 40 points'],
  ['NBA', 'Franz Wagner Delivers the Game-Winner', 'basketball:game_winner:actor:franz wagner', 'Franz Wagner hit the game-winner'],
  ['NBA', 'Jokic and Murray Make History With Their 1,000th Career Assist to Each Other 🤝', 'basketball:assist_milestone:actors:jamal murray:nikola jokic:assists:1000', 'Nikola Jokić and Jamal Murray reached 1,000 career assists to each other'],
  ['NBA', 'Cade Cunningham Hits the Three for His 50th Point 🎯', 'basketball:scoring_milestone:actor:cade cunningham:points:50:shot:three', 'Cade Cunningham hit a three-pointer for his 50th point'],
  ['NBA', 'Ausar Thompson Finally Gets His First Triple-Double… And Had To Let His Brother Know 😂', 'basketball:triple_double:actor:ausar thompson:milestone:first', 'Ausar Thompson recorded his first triple-double'],
  ['NBA', 'Luka Dončić Drains His 6th Three of the Half From DEEP! 🎯🔥', 'basketball:half_threes:actor:luka doncic:count:6', 'Luka Dončić made his sixth three-pointer of the half'],
  ['NBA', 'Cooper Flagg collapses the defense and finds a wide open teammate for three 👌', 'basketball:pass_setup:passer:cooper flagg:look:open_three', 'Cooper Flagg collapsed the defense and found an open teammate for a three-point look'],
  ['Warriors', 'Stephen Curry Was SHOOK After the Draymond Green Three 😭 | #shorts', 'basketball:made_three:actor:draymond green', 'Draymond Green made a three-pointer'],
  ['Warriors', 'Yaxel Lendeborg With a Big-Time Slam 💥 | #shorts', 'basketball:dunk:actor:yaxel lendeborg', 'Yaxel Lendeborg finished a dunk'],
  ['Heat', 'MIAMI GOT IT DONE VS. OKC 😤', 'basketball:game_win:team:heat:opponent:thunder', 'Miami defeated Oklahoma City'],
  ['Heat', 'Klay Thompson has already hit 60 THREES 🎯🔥', 'basketball:three_milestone:actor:klay thompson:count:60', 'Klay Thompson reached 60 made three-pointers'],
  ['Heat', 'BAM JUST ERASED THAT 😳🚫', 'basketball:block:actor:bam adebayo', 'Bam Adebayo blocked the shot'],
  ['Bleacher Report NBA', 'Vintage Harden 50-ball 😮‍💨', 'basketball:scoring_total:actor:james harden:points:50', 'James Harden scored 50 points'],
  ['House of Highlights', 'Ice Trae BUZZER BEATER FORCES OT🥶', 'basketball:buzzer_beater:actor:trae young:effect:overtime', 'Trae Young hit a buzzer-beater to force overtime'],
  ['House of Highlights', 'WILD Pulisic BICYCLE KICK opens scoring😳', 'soccer:goal:actor:christian pulisic:shot:bicycle_kick:phase:opening', 'Christian Pulisic opened the scoring with a bicycle kick'],
  ['ESPN NBA', 'HARDEN PASSES KOBE ON THE ALL-TIME 50-PIECE LIST 🚨 His 26th 50-PT game ranks 3rd-most in history!', 'basketball:scoring_milestone:actor:james harden:fifty_point_games:26', 'James Harden recorded his 26th 50-point game, third-most in NBA history'],
  ['ESPN NBA', 'Georgetown got the W over Clemson 🔥', 'ncaa:game_win:team:georgetown:opponent:clemson', 'Georgetown defeated Clemson'],
  // NFL, CFB & MLB
  ['FOX Sports', 'Sterling Shepard records his first career game with 2 receiving TDs! #NFL #Jets', 'football:receiving_tds:actor:sterling shepard:count:2:milestone:first', 'Sterling Shepard recorded his first career game with 2 receiving touchdowns'],
  ['FOX Sports', 'Justin Herbert flips into the end zone and Madison Beer was loving it! #NFL #Chargers', 'football:touchdown:actor:justin herbert:kind:end_zone_flip', 'Justin Herbert flipped into the end zone for a touchdown'],
  ['FOX Sports', 'Dylan Raiola GOES DEEP to Jeremiah McClellan for a 60-yard SCORE! #CFB #Oregon', 'football:touchdown_pass:passer:dylan raiola:receiver:jeremiah mcclellan:yards:60', 'Dylan Raiola connected with Jeremiah McClellan for a 60-yard score'],
  ['FOX Sports', 'MICHIGAN UPSETS NO. 4 UCLA IN THE BIG HOUSE IN OT! #michigan #cfb #ucla', 'football:game_win:team:michigan:opponent:ucla:opponent_rank:4:overtime', 'Michigan upset No. 4 UCLA in overtime'],
  ['FOX Sports', 'The Red Sox are signing Jake Bauers to a 4-year, $58M deal per multiple reports', 'baseball:signing:team:red sox:actor:jake bauers:years:4:amount:58000000', 'The Red Sox are signing Jake Bauers to a four-year, $58 million deal'],
  ['CBS Sports', 'Michigan takes down No. 4 UCLA! #collegefootball', 'football:game_win:team:michigan:opponent:ucla:opponent_rank:4', 'Michigan defeated No. 4 UCLA'],
  ['CBS Sports', 'Tarik Skubal is headed to the Mets 👀 🚨 #hqsocial', 'baseball:move:actor:tarik skubal:team:mets', 'Tarik Skubal is headed to the Mets'],
  ['Cowboys', 'TD, CeeDee 😏 | 📺: #TENvsDAL on FOX📲: Stream on NFL+ | #DallasCowboys #NFL #shorts', 'football:touchdown:actor:ceedee lamb:team:cowboys', 'CeeDee Lamb scored a touchdown for the Cowboys'],
  ['Eagles', 'The Birds won the Battle of PA #shorts', 'football:game_win:team:eagles:rivalry:battle_of_pa', 'The Eagles won the Battle of Pennsylvania'],
  ['MLB', 'THE MILWAUKEE BREWERS ARE WORLD SERIES CHAMPS!', 'baseball:championship:team:brewers:title:world_series', 'The Milwaukee Brewers won the World Series'],
  ['MLB', 'WILLIAM CONTRERAS IS THE 2026 WORLD SERIES MVP!', 'baseball:award:actor:william contreras:award:world_series_mvp:year:2026', 'William Contreras won the 2026 World Series MVP award'],
  // Premier League, MLS & UEFA
  ['Premier League', "This Angle Of Mo Salah's Goal v Man Utd 😮‍💨", 'soccer:goal:actor:mohamed salah:opponent:manchester united', 'Mohamed Salah scored against Manchester United'],
  ['Premier League', 'Man Utd 4-4 Aston Villa 🤯 LAST-MINUTE SCENES!', 'soccer:score_recap:aston villa:4:manchester united:4', 'Manchester United and Aston Villa drew 4-4'],
  ['Premier League', 'Zion Suzuki Pulls Off A WONDER Save 😳🇯🇵', 'soccer:save:actor:zion suzuki', 'Zion Suzuki made a save'],
  ['MLS', 'Bruno Caicedo FINISHED A CRAZY PLAY🤯 for Vancouver!', 'soccer:goal:actor:bruno caicedo:team:vancouver', 'Bruno Caicedo scored for Vancouver'],
  ['MLS', 'Gonzalo Tapia’s two goals power @ColumbusCrew over Inter Miami!😱 // @AudiUSA MLS Cup Playoffs', 'soccer:goal_total:actor:gonzalo tapia:match:goals:2:opponent:inter miami', 'Gonzalo Tapia scored two goals against Inter Miami in the MLS Cup Playoffs'],
  ['MLS', 'Samuel Gidi STRIKE💥 SEALED Audi MLS Cup Playoff win for Cincinnati!!', 'soccer:goal:actor:samuel gidi:team:cincinnati:phase:playoffs', 'Samuel Gidi scored to seal an MLS Cup Playoff win for Cincinnati'],
  ['MLS', 'RSL took Seatle to PKS in the Audi MLS Cup Playoffs!🚨', 'soccer:penalty_shootout:teams:real salt lake:seattle:competition:mls_cup_playoffs', 'Real Salt Lake took Seattle to penalty kicks in the MLS Cup Playoffs'],
  ['UEFA', 'Bale’s trivela cross', 'soccer:cross:actor:gareth bale:kind:trivela', 'Gareth Bale delivered a trivela cross'],
  // NHL & Rangers
  ['NHL', 'Cue the Hats for Bennett 🎩🎩🎩', 'hockey:hat_trick:actor:sam bennett', 'Sam Bennett scored a hat trick'],
  ['NHL', 'Jamie Benn joins the 1️⃣0️⃣0️⃣0️⃣ POINT CLUB! 🥳', 'hockey:career_milestone:actor:jamie benn:points:1000', 'Jamie Benn reached 1,000 NHL career points'],
  ['NHL', 'Tarasov Absolutely Robs Guentzel 🚔😱', 'hockey:save:goalie:daniil tarasov:shooter:jake guentzel', 'Daniil Tarasov robbed Jake Guentzel with a save'],
  ['NHL', 'Morrissey lands the jet in OVERTIME! 🛬👨‍✈️', 'hockey:overtime_winner:actor:josh morrissey', 'Josh Morrissey scored in overtime'],
  ['NHL', 'BEDARD SNIPE makes the POST SING 🎶', 'hockey:goal:actor:connor bedard:shot:snipe', 'Connor Bedard scored off the post'],
  ['Rangers', 'Power play Mika magic 🪄 #mikazibanejad #nyr #nhl #hockey #goal', 'hockey:power_play:actor:mika zibanejad:team:rangers', 'Mika Zibanejad created a power-play highlight for the Rangers'],
  ['Rangers', 'Top shelf J.T. 🎯 #jtmiller #nyr #nhl #goal', 'hockey:top_shelf:actor:jt miller:team:rangers', 'J.T. Miller went top shelf for the Rangers'],
];

describe('current verified literal sports inventory', () => {
  it.each(VERIFIED_SPORTS_CASES)(
    'grounds %s: %s with valid caption quality and relevance',
    (source, title, identity, clause) => {
      const brief = briefForAsset({ kind: 'video', domainHint: 'sports', source, title });
      const fact = sportsVideoFact(brief);
      expect(fact?.identity).toBe(identity);
      expect(captionFact(brief)?.identity).toBe(identity);
      expect(
        isCaptionableSharedVideoClip(
          {
            id: 'test-clip',
            video_id: 'AAAAAAAAAAA',
            source_url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
            source,
            title,
            category: 'highlight',
            oembed_ok: null,
          },
          'sports',
        ),
      ).toBe(true);

      for (const author of testAuthors) {
        const style = styleSheetFor(author);
        const raw = subjectCaption(brief, style);
        expect(raw?.text).toBe(`${clause}.`);
        const composed = composeCaption(brief, style);
        expect(composed.text).not.toBe('');
        expect(composed.relevance).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
        expect(captionQuality(composed.text, { subject: fact!.subject }).pass).toBe(true);
      }
    },
  );

  it('coalesces equivalent wording and multi-source aliases into one canonical semantic identity', () => {
    const a = sportsVideoFact(
      briefForAsset({
        kind: 'video',
        domainHint: 'sports',
        source: 'NBA',
        title: 'AJ Dybantsa ties it with 1 second left to head to 2OT',
      }),
    );
    const b = sportsVideoFact(
      briefForAsset({
        kind: 'video',
        domainHint: 'sports',
        source: 'House of Highlights',
        title: 'AJ Dybantsa FORCES DOUBLE OT🚨',
      }),
    );
    expect(a?.identity).toBe('basketball:overtime_tying_shot:actor:aj dybantsa:overtime:2');
    expect(b?.identity).toBe(a?.identity);

    const suzuki1 = sportsVideoFact(
      briefForAsset({
        kind: 'video',
        domainHint: 'sports',
        source: 'Premier League',
        title: 'Zion Suzuki Pulls Off A WONDER Save 😳🇯🇵',
      }),
    );
    const suzuki2 = sportsVideoFact(
      briefForAsset({
        kind: 'video',
        domainHint: 'sports',
        source: 'Premier League',
        title: 'You MUST SEE This Zion Suzuki Save 😳',
      }),
    );
    expect(suzuki1?.identity).toBe('soccer:save:actor:zion suzuki');
    expect(suzuki2?.identity).toBe(suzuki1?.identity);

    const mvpFox = sportsVideoFact(
      briefForAsset({
        kind: 'video',
        domainHint: 'sports',
        source: 'FOX Sports',
        title: 'Pete Crow-Armstrong is your 2026 NL MVP!',
      }),
    );
    const mvpMlb = sportsVideoFact(
      briefForAsset({
        kind: 'video',
        domainHint: 'sports',
        source: 'MLB',
        title: 'The moment that Pete Crow-Armstrong was announced as the National League MVP!',
      }),
    );
    expect(mvpFox?.identity).toBe('baseball:award:actor:pete crow armstrong:award:nl_mvp:year:2026');
    expect(mvpMlb?.identity).toBe(mvpFox?.identity);
  });

  it.each([
    ['NBA', 'Buddy Hield might beat the first-half buzzer with a pull-up 3'],
    ['NBA', 'Did Buddy Hield beat the first-half buzzer with a pull-up 3?'],
    ['NBA', 'Scottie Barnes Goes 8-for-9 and Puts a Defender on a Poster!'],
    ['FOX Sports', 'Sterling Shepard never records his first career game with 2 receiving TDs'],
    ['Unknown Source', 'Buddy Hield Beats the First-Half Buzzer With a COLD-BLOODED Pull-Up 3'],
    ['MLB', 'TD, CeeDee'],
    ['NHL', 'Power play Mika magic'],
    ['NBA', 'MIAMI GOT IT DONE VS. OKC'],
  ])('refuses negated, hypothetical, mismatched-source or invalid claims: %s — %s', (source, title) => {
    const brief = briefForAsset({ kind: 'video', domainHint: 'sports', source, title });
    expect(sportsVideoFact(brief)).toBeNull();
  });
});
