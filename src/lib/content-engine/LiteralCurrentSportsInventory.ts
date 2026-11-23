import type { SportsVideoFact } from './SportsVideoFact.js';

const key = (value: string) =>
  value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const fact = (identity: string, subject: string): SportsVideoFact => ({
  person: '',
  action: 'sports_technical_context',
  identity,
  subject,
});

const NBA_THREE_ACTORS: Record<string, string> = {
  'draymond green': 'Draymond Green',
  'shai gilgeous-alexander': 'Shai Gilgeous-Alexander',
  sga: 'Shai Gilgeous-Alexander',
  'luka doncic': 'Luka Dončić',
};

const NBA_DUNK_ACTORS: Record<string, string> = {
  'harrison barnes': 'Harrison Barnes',
  'javonte green': 'Javonte Green',
  'davion mitchell': 'Davion Mitchell',
  'tari eason': 'Tari Eason',
  'jayson tatum': 'Jayson Tatum',
  'cooper flagg': 'Cooper Flagg',
  'dylan harper': 'Dylan Harper',
  'jaden mcdaniels': 'Jaden McDaniels',
  'yaxel lendeborg': 'Yaxel Lendeborg',
  yaxel: 'Yaxel Lendeborg',
};

const ORDINAL_WORDS: Record<string, string> = {
  '1': 'first', '1st': 'first', first: 'first',
  '2': 'second', '2nd': 'second', second: 'second',
  '3': 'third', '3rd': 'third', third: 'third',
  '4': 'fourth', '4th': 'fourth', fourth: 'fourth',
  '5': 'fifth', '5th': 'fifth', fifth: 'fifth',
  '6': 'sixth', '6th': 'sixth', sixth: 'sixth',
};

function normalizeSportsTitle(original: string): string {
  return original
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{20E3}]/gu, ' ')
    .replace(/(?:\s+#[A-Za-z0-9_]+)+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!]+$/, '')
    .trim();
}

/**
 * Source-bound, closed-registry literal sports actions from verified live
 * inventory across NBA, NFL/CFB, NHL, MLB, MLS, Premier League and UEFA.
 *
 * Never infers unstated game results, winners, assists or unknown actors.
 * Every returned fact carries a canonical semantic identity independent of
 * video IDs, upload timestamps, punctuation or headline adjectives.
 */
const DECLARATIVE_IDENTITY_PATTERNS: ReadonlyArray<RegExp> = [
  /^basketball:(?:buzzer_beater|game_winner|half_threes|scoring_milestone|perfect_shooting_dunk|ball_handling|scoring_total|and_one_dunk|steal_and_dunk|assist_milestone|outlet_pass|overtime_tying_shot|triple_double|hook_shot|jumper|block_and_dunk|pass_setup|game_win|three_milestone):/,
  /^basketball:made_three:actor:(?:draymond green|shai gilgeous alexander|luka doncic)(?::|$)/,
  /^basketball:dunk:actor:(?:harrison barnes|tari eason|jayson tatum|cooper flagg|dylan harper|jaden mcdaniels|yaxel lendeborg)(?::|$)/,
  /^basketball:made_basket:actor:(?:rudy gobert|lamelo ball)(?::|$)/,
  /^basketball:assist:actor:(?:giannis antetokounmpo|stephen curry):kind:no_look$/,
  /^basketball:block:actor:(?:giannis antetokounmpo|bam adebayo)$/,
  /^basketball:lob_dunk:receiver:deandre jordan$/,
  /^ncaa:game_win:/,
  /^football:(?:receiving_tds|touchdown_pass|game_win|field_goal_record):/,
  /^football:touchdown:(?:actor:(?:justin herbert|ceedee lamb)|team:49ers)(?::|$)/,
  /^baseball:(?:award|championship|signing|move):/,
  /^soccer:(?:save|penalty_shootout|award|cross):/,
  /^soccer:goal:actor:(?:christian pulisic|mohamed salah|diego gomez|evanilson|liam delap|morgan rogers|bruno caicedo|samuel gidi)(?::(?!location:halfway_line)|$)/,
  /^soccer:score_recap:aston villa:4:manchester united:4$/,
  /^soccer:goal_total:actor:gonzalo tapia:/,
  /^hockey:(?:hat_trick|career_milestone|save|shootout_winner|power_play|top_shelf):/,
  /^hockey:overtime_winner:actor:(?:josh morrissey|cole caufield)$/,
  /^hockey:goal:actor:connor bedard:shot:snipe$/,
];

export function isDeclarativeCurrentSportsIdentity(identity: string): boolean {
  return DECLARATIVE_IDENTITY_PATTERNS.some((pattern) => pattern.test(identity));
}

export function literalCurrentSportsInventory(
  original: string,
  source: string | undefined,
): SportsVideoFact | null {
  if (!source) return null;
  const t = normalizeSportsTitle(original);
  if (!t) return null;
  const guardText = t.replace(/\bno\.\s*[1-9]\d*\b/gi, 'ranked');
  if (
    /[?]|\b(?:not|no|never|didn't|doesn't|don't|isn't|wasn't|weren't|won't|can't|cannot|could|would|should|couldn't|wouldn't|shouldn't|might|may|if|unless|without|watches|reacts|denies)\b/i.test(
      guardText,
    )
  ) {
    return null;
  }

  // ── NBA & team/highlight basketball channels ──────────────────────────
  if (source === 'nba') {
    if (/^Buddy Hield Beats the First-Half Buzzer With a (?:COLD-BLOODED )?Pull-Up (?:3|three)$/i.test(t)) {
      return fact(
        'basketball:buzzer_beater:actor:buddy hield:period:first_half:shot:pull_up_three',
        'Buddy Hield beat the first-half buzzer with a pull-up three-pointer',
      );
    }
    if (/^Cooper Flagg Pulls Up and Beats the Buzzer from DEEP$/i.test(t)) {
      return fact(
        'basketball:buzzer_beater:actor:cooper flagg:shot:deep_pull_up',
        'Cooper Flagg pulled up and beat the buzzer from deep',
      );
    }
    if (/^Mikal Bridges hits the (?:Tissot )?buzzer beater vs\.? (?:the )?Trail Blazers$/i.test(t)) {
      return fact(
        'basketball:buzzer_beater:actor:mikal bridges:opponent:trail blazers',
        'Mikal Bridges hit a buzzer-beater against the Trail Blazers',
      );
    }
    if (/^James Harden with the (?:tough )?bucket at the buzzer$/i.test(t)) {
      return fact(
        'basketball:buzzer_beater:actor:james harden',
        'James Harden scored at the buzzer',
      );
    }
    if (/^Meleek Thomas beats the buzzer with the (?:insane )?shot$/i.test(t)) {
      return fact(
        'basketball:buzzer_beater:actor:meleek thomas',
        'Meleek Thomas beat the buzzer with a shot',
      );
    }
    if (/^Franz Wagner Delivers the Game-Winner$/i.test(t)) {
      return fact(
        'basketball:game_winner:actor:franz wagner',
        'Franz Wagner hit the game-winner',
      );
    }
    if (/^Draymond Green Drains the Corner (?:3|three)(?: and Leaves Steph Curry in TOTAL DISBELIEF)?$/i.test(t)) {
      return fact(
        'basketball:made_three:actor:draymond green:shot:corner',
        'Draymond Green made a corner three-pointer',
      );
    }
    if (/^(?:SGA|Shai Gilgeous-Alexander) gets shifty for the (?:three|3)$/i.test(t)) {
      return fact(
        'basketball:made_three:actor:shai gilgeous alexander',
        'Shai Gilgeous-Alexander made a three-pointer',
      );
    }
    if (/^Luka Don[cč]i[cć] Banks In the Stepback Three(?:\.{1,3}|…) From (?:WAY )?Downtown$/i.test(t)) {
      return fact(
        'basketball:made_three:actor:luka doncic:shot:banked_stepback',
        'Luka Dončić banked in a step-back three-pointer',
      );
    }
    const halfThrees = t.match(/^Luka Don[cč]i[cć] Drains His ([1-9][0-9]?)(?:st|nd|rd|th) Three of the Half From DEEP$/i);
    if (halfThrees) {
      const n = Number(halfThrees[1]);
      const ord = ORDINAL_WORDS[String(n)] ?? `${n}th`;
      return fact(
        `basketball:half_threes:actor:luka doncic:count:${n}`,
        `Luka Dončić made his ${ord} three-pointer of the half`,
      );
    }
    const wemby50 = t.match(/^(?:Wemby|Victor Wembanyama) hits the (?:three|3) for his ([1-9][0-9]?)(?:st|nd|rd|th) 50[- ]point game of the season$/i);
    if (wemby50) {
      const n = Number(wemby50[1]);
      const ord = ORDINAL_WORDS[String(n)] ?? `${n}th`;
      return fact(
        `basketball:scoring_milestone:actor:victor wembanyama:points:50:season_count:${n}:shot:three`,
        `Victor Wembanyama hit a three-pointer for his ${ord} 50-point game of the season`,
      );
    }
    if (/^Cade Cunningham Hits the (?:Three|3) for His 50th Point$/i.test(t)) {
      return fact(
        'basketball:scoring_milestone:actor:cade cunningham:points:50:shot:three',
        'Cade Cunningham hit a three-pointer for his 50th point',
      );
    }
    const reaves = t.match(/^Austin Reaves Hits ([1-9][0-9]?) With a (?:Clutch )?Banked-In (?:Three|3)$/i);
    if (reaves) {
      return fact(
        `basketball:scoring_milestone:actor:austin reaves:points:${Number(reaves[1])}:shot:banked_three`,
        `Austin Reaves reached ${Number(reaves[1])} points with a banked-in three-pointer`,
      );
    }
    const perfectPoster = t.match(/^Scottie Barnes Goes ([1-9][0-9]?)-for-([1-9][0-9]?) and Puts a Defender on a Poster$/i);
    if (perfectPoster && perfectPoster[1] === perfectPoster[2]) {
      return fact(
        `basketball:perfect_shooting_dunk:actor:scottie barnes:made:${Number(perfectPoster[1])}:attempted:${Number(perfectPoster[2])}`,
        `Scottie Barnes went ${Number(perfectPoster[1])}-for-${Number(perfectPoster[2])} and finished a dunk`,
      );
    }
    if (/^James Harden Breaks His Defender Down With (?:FILTHY )?Handles$/i.test(t)) {
      return fact(
        'basketball:ball_handling:actor:james harden',
        'James Harden broke down his defender off the dribble',
      );
    }
    const hardenDrop = t.match(/^James Harden Drops ([1-9][0-9]?)(?: And He's Still Cooking)?$/i);
    if (hardenDrop) {
      return fact(
        `basketball:scoring_total:actor:james harden:points:${Number(hardenDrop[1])}`,
        `James Harden scored ${Number(hardenDrop[1])} points`,
      );
    }
    const pgScore = t.match(/^Paul George Makes The Tough SHOT Look Easy On His Way To ([1-9][0-9]?)$/i);
    if (pgScore) {
      return fact(
        `basketball:scoring_total:actor:paul george:points:${Number(pgScore[1])}`,
        `Paul George reached ${Number(pgScore[1])} points`,
      );
    }
    if (/^Harrison Barnes Takes Flight for the Transition Slam(?: and the Spurs Bench Goes Wild)?$/i.test(t)) {
      return fact(
        `basketball:dunk:actor:${key(NBA_DUNK_ACTORS['harrison barnes']!)}:phase:transition`,
        'Harrison Barnes finished a transition dunk',
      );
    }
    if (/^Javonte Green takes off for the and[- ]1 flush$/i.test(t)) {
      return fact(
        'basketball:and_one_dunk:actor:javonte green',
        'Javonte Green finished an and-one dunk',
      );
    }
    if (/^Davion Mitchell Turns Defense Into Offense With A (?:Huge )?Steal-And-Slam(?: & The Reactions Say It All)?$/i.test(t)) {
      return fact(
        'basketball:steal_and_dunk:actor:davion mitchell',
        'Davion Mitchell turned a steal into a dunk',
      );
    }
    if (/^Rudy Gobert Hangs In The Air For The Tough Finish(?: And Gets The Crowd Going)?$/i.test(t)) {
      return fact(
        'basketball:made_basket:actor:rudy gobert',
        'Rudy Gobert converted a finish in the air',
      );
    }
    if (/^Joki[cć] and Murray Make History With Their 1,000th Career Assist to Each Other$/i.test(t)) {
      return fact(
        'basketball:assist_milestone:actors:jamal murray:nikola jokic:assists:1000',
        'Nikola Jokić and Jamal Murray reached 1,000 career assists to each other',
      );
    }
    if (/^Giannis Throws an (?:INSANE )?Over-the-Head No-Look Assist$/i.test(t)) {
      return fact(
        'basketball:assist:actor:giannis antetokounmpo:kind:no_look',
        'Giannis Antetokounmpo delivered an over-the-head no-look assist',
      );
    }
    if (/^Steph(?:en Curry)? delivers a no-look dime between two defenders$/i.test(t)) {
      return fact(
        'basketball:assist:actor:stephen curry:kind:no_look',
        'Stephen Curry delivered a no-look assist between two defenders',
      );
    }
    if (/^LaMelo Ball Throws a (?:PERFECT )?One-Handed Outlet to McDaniels for the (?:Big-Time )?Slam$/i.test(t)) {
      return fact(
        'basketball:outlet_pass:actor:lamelo ball:result:dunk',
        'LaMelo Ball threw a one-handed outlet pass for a dunk',
      );
    }
    if (/^Tari Eason with the (?:beautiful )?(?:1|one)[- ]hand(?:ed)? catch into the dunk$/i.test(t)) {
      return fact(
        'basketball:dunk:actor:tari eason:setup:one_hand_catch',
        'Tari Eason turned a one-handed catch into a dunk',
      );
    }
    if (/^AJ Dybantsa ties it with 1 second left to head to 2OT$/i.test(t)) {
      return fact(
        'basketball:overtime_tying_shot:actor:aj dybantsa:overtime:2',
        'AJ Dybantsa forced double overtime',
      );
    }
    if (/^Ausar Thompson Finally Gets His First Triple-Double(?:\.{1,3}|…) And Had To Let His Brother Know$/i.test(t)) {
      return fact(
        'basketball:triple_double:actor:ausar thompson:milestone:first',
        'Ausar Thompson recorded his first triple-double',
      );
    }
    if (/^Joki[cć] made this spinning hook look TOO EASY$/i.test(t)) {
      return fact(
        'basketball:hook_shot:actor:nikola jokic',
        'Nikola Jokić made a spinning hook shot',
      );
    }
    if (/^Tyrese Maxey Creates Space and Knocks Down the (?:Tough )?Jumper$/i.test(t)) {
      return fact(
        'basketball:jumper:actor:tyrese maxey',
        'Tyrese Maxey created space and hit a jumper',
      );
    }
    if (/^Jayson Tatum Goes STRAIGHT THROUGH THE CROWD for a One-Handed SLAM$/i.test(t)) {
      return fact(
        'basketball:dunk:actor:jayson tatum:kind:one_handed',
        'Jayson Tatum finished a one-handed dunk',
      );
    }
    if (/^Cooper Flagg Went AIRBORNE with a Windmill Dunk$/i.test(t)) {
      return fact(
        'basketball:dunk:actor:cooper flagg:kind:windmill',
        'Cooper Flagg finished a windmill dunk',
      );
    }
    if (/^Cooper Flagg Goes Airborne For The (?:Big-Time )?Slam$/i.test(t)) {
      return fact(
        'basketball:dunk:actor:cooper flagg',
        'Cooper Flagg finished a dunk',
      );
    }
    if (/^LaMelo Ball Creates Space, Crosses His Defender, and Finishes a (?:Clutch )?4th-Quarter Bucket$/i.test(t)) {
      return fact(
        'basketball:made_basket:actor:lamelo ball:quarter:4',
        'LaMelo Ball crossed his defender and scored in the fourth quarter',
      );
    }
    if (/^Dylan Harper Shakes His Defender With A (?:Slick )?Spin Move And Throws Down The Two-Handed Jam$/i.test(t)) {
      return fact(
        'basketball:dunk:actor:dylan harper:kind:two_handed',
        'Dylan Harper spun past his defender for a two-handed dunk',
      );
    }
    if (/^(?:Wemby|Victor Wembanyama) gets the block and immediately gets the dunk$/i.test(t)) {
      return fact(
        'basketball:block_and_dunk:actor:victor wembanyama',
        'Victor Wembanyama blocked a shot and followed with a dunk',
      );
    }
    if (/^Jaden McDaniels Goes Airborne And Puts Someone On A Poster$/i.test(t)) {
      return fact(
        'basketball:dunk:actor:jaden mcdaniels',
        'Jaden McDaniels finished a dunk',
      );
    }
    if (/^(?:Yaxel|Yaxel Lendeborg) Finishes The Fast Break With A (?:THUNDEROUS )?Lob Jam$/i.test(t)) {
      return fact(
        'basketball:dunk:actor:yaxel lendeborg:kind:lob',
        'Yaxel Lendeborg finished a fast-break lob dunk',
      );
    }
    if (/^Cooper Flagg collapses the defense and finds a wide open teammate for (?:three|3)$/i.test(t)) {
      return fact(
        'basketball:pass_setup:passer:cooper flagg:look:open_three',
        'Cooper Flagg collapsed the defense and found an open teammate for a three-point look',
      );
    }
    const threeAlias = t.match(/^(.+?) makes a corner three-pointer$/i);
    if (threeAlias) {
      const who = NBA_THREE_ACTORS[key(threeAlias[1]!)];
      if (who) return fact(`basketball:made_three:actor:${key(who)}:shot:corner`, `${who} made a corner three-pointer`);
    }
  }

  if (source === 'warriors') {
    if (/^Stephen Curry Was SHOOK After the Draymond Green Three$/i.test(t)) {
      return fact(
        'basketball:made_three:actor:draymond green',
        'Draymond Green made a three-pointer',
      );
    }
    if (/^Yaxel Lendeborg With a (?:Big-Time )?Slam$/i.test(t)) {
      return fact(
        'basketball:dunk:actor:yaxel lendeborg',
        'Yaxel Lendeborg finished a dunk',
      );
    }
  }

  if (source === 'heat') {
    if (/^MIAMI GOT IT DONE VS\.? OKC$/i.test(t)) {
      return fact(
        'basketball:game_win:team:heat:opponent:thunder',
        'Miami defeated Oklahoma City',
      );
    }
    const klayThrees = t.match(/^Klay Thompson has already hit ([1-9][0-9]{1,2}) THREES$/i);
    if (klayThrees) {
      return fact(
        `basketball:three_milestone:actor:klay thompson:count:${Number(klayThrees[1])}`,
        `Klay Thompson reached ${Number(klayThrees[1])} made three-pointers`,
      );
    }
    if (/^Giannis Just Went QB1 to Klay for THREE$/i.test(t)) {
      return fact(
        'basketball:pass_setup:passer:giannis antetokounmpo:receiver:klay thompson:look:three',
        'Giannis Antetokounmpo found Klay Thompson for a three-point look',
      );
    }
    if (/^GIANNIS SENT THAT SHOT BACK$/i.test(t)) {
      return fact(
        'basketball:block:actor:giannis antetokounmpo',
        'Giannis Antetokounmpo blocked the shot',
      );
    }
    if (/^BAM JUST ERASED THAT$/i.test(t)) {
      return fact(
        'basketball:block:actor:bam adebayo',
        'Bam Adebayo blocked the shot',
      );
    }
  }

  if (source === 'bleacher report nba') {
    const harden50 = t.match(/^Vintage Harden ([1-9][0-9])-ball$/i);
    if (harden50) {
      return fact(
        `basketball:scoring_total:actor:james harden:points:${Number(harden50[1])}`,
        `James Harden scored ${Number(harden50[1])} points`,
      );
    }
    if (/^Ice Trae over 2 defenders at the buzzer$/i.test(t)) {
      return fact(
        'basketball:buzzer_beater:actor:trae young:defenders:2',
        'Trae Young hit a shot over two defenders at the buzzer',
      );
    }
  }

  if (source === 'house of highlights') {
    const hardenCooked = t.match(/^Harden COOKED his way to ([1-9][0-9]) POINTS$/i);
    if (hardenCooked) {
      return fact(
        `basketball:scoring_total:actor:james harden:points:${Number(hardenCooked[1])}`,
        `James Harden scored ${Number(hardenCooked[1])} points`,
      );
    }
    if (/^Ice Trae BUZZER BEATER FORCES OT$/i.test(t)) {
      return fact(
        'basketball:buzzer_beater:actor:trae young:effect:overtime',
        'Trae Young hit a buzzer-beater to force overtime',
      );
    }
    if (/^AJ Dybantsa FORCES DOUBLE OT$/i.test(t)) {
      return fact(
        'basketball:overtime_tying_shot:actor:aj dybantsa:overtime:2',
        'AJ Dybantsa forced double overtime',
      );
    }
    if (/^Deandre Jordan is STILL catching lobs$/i.test(t)) {
      return fact(
        'basketball:lob_dunk:receiver:deandre jordan',
        'DeAndre Jordan caught a lob',
      );
    }
    if (/^(?:WILD )?Pulisic BICYCLE KICK opens scoring$/i.test(t)) {
      return fact(
        'soccer:goal:actor:christian pulisic:shot:bicycle_kick:phase:opening',
        'Christian Pulisic opened the scoring with a bicycle kick',
      );
    }
  }

  if (source === 'espn nba') {
    if (/^HARDEN PASSES KOBE ON THE ALL-TIME 50-PIECE LIST His 26th 50-PT game ranks 3rd-most in history$/i.test(t)) {
      return fact(
        'basketball:scoring_milestone:actor:james harden:fifty_point_games:26',
        'James Harden recorded his 26th 50-point game, third-most in NBA history',
      );
    }
    if (/^Georgetown got the W over Clemson$/i.test(t)) {
      return fact(
        'ncaa:game_win:team:georgetown:opponent:clemson',
        'Georgetown defeated Clemson',
      );
    }
  }

  // ── NFL, CFB & MLB awards/moves (FOX Sports, CBS Sports, Cowboys, Eagles, MLB) ──
  if (source === 'fox sports') {
    const shepard = t.match(/^Sterling Shepard records his first career game with ([1-9]) receiving TDs$/i);
    if (shepard) {
      const count = Number(shepard[1]);
      return fact(
        `football:receiving_tds:actor:sterling shepard:count:${count}:milestone:first`,
        `Sterling Shepard recorded his first career game with ${count} receiving touchdowns`,
      );
    }
    if (/^Justin Herbert flips into the end zone(?: and Madison Beer was loving it)?$/i.test(t)) {
      return fact(
        'football:touchdown:actor:justin herbert:kind:end_zone_flip',
        'Justin Herbert flipped into the end zone for a touchdown',
      );
    }
    if (/^49ers connect for an (?:UNREAL )?touchdown$/i.test(t)) {
      return fact(
        'football:touchdown:team:49ers',
        'The 49ers connected for a touchdown',
      );
    }
    const raiola = t.match(/^Dylan Raiola GOES DEEP to Jeremiah McClellan for a ([1-9][0-9]?)-yard SCORE$/i);
    if (raiola) {
      return fact(
        `football:touchdown_pass:passer:dylan raiola:receiver:jeremiah mcclellan:yards:${Number(raiola[1])}`,
        `Dylan Raiola connected with Jeremiah McClellan for a ${Number(raiola[1])}-yard score`,
      );
    }
    if (/^MICHIGAN UPSETS NO\. 4 UCLA IN THE BIG HOUSE IN OT$/i.test(t)) {
      return fact(
        'football:game_win:team:michigan:opponent:ucla:opponent_rank:4:overtime',
        'Michigan upset No. 4 UCLA in overtime',
      );
    }
    if (/^Yordan [AÁ]lvarez (?:adds the 2026 AL MVP award to his trophy case|is the 3rd player in Astros history to be named league MVP)$/i.test(t)) {
      return fact(
        'baseball:award:actor:yordan alvarez:award:al_mvp:year:2026',
        'Yordan Álvarez won the 2026 AL MVP award',
      );
    }
    if (/^Pete Crow-Armstrong is your 2026 NL MVP$/i.test(t)) {
      return fact(
        'baseball:award:actor:pete crow armstrong:award:nl_mvp:year:2026',
        'Pete Crow-Armstrong won the 2026 NL MVP award',
      );
    }
    if (/^Cam Schlittler is the 2026 AL Cy Young Award winner$/i.test(t)) {
      return fact(
        'baseball:award:actor:cam schlittler:award:al_cy_young:year:2026',
        'Cam Schlittler won the 2026 AL Cy Young Award',
      );
    }
    if (/^From World Series champion to the 2026 NL Cy Young Award! What a season for Jacob Misiorowski$/i.test(t)) {
      return fact(
        'baseball:award:actor:jacob misiorowski:award:nl_cy_young:year:2026',
        'Jacob Misiorowski won the 2026 NL Cy Young Award',
      );
    }
    if (/^Kevin McGonigle has won the AL Rookie of the Year! McGonigle hit \.\d{3} with \d+ HR and \d+ RBI in 2026$/i.test(t)) {
      return fact(
        'baseball:award:actor:kevin mcgonigle:award:al_roy:year:2026',
        'Kevin McGonigle won the 2026 AL Rookie of the Year award',
      );
    }
    if (/^Sal Stewart has won the NL Rookie of the Year! Stewart hit \.\d{3} with \d+ HR and \d+ RBI in 2026$/i.test(t)) {
      return fact(
        'baseball:award:actor:sal stewart:award:nl_roy:year:2026',
        'Sal Stewart won the 2026 NL Rookie of the Year award',
      );
    }
    if (/^The Red Sox are signing Jake Bauers to a 4-year, \$58M deal per multiple reports$/i.test(t)) {
      return fact(
        'baseball:signing:team:red sox:actor:jake bauers:years:4:amount:58000000',
        'The Red Sox are signing Jake Bauers to a four-year, $58 million deal',
      );
    }
  }

  if (source === 'cbs sports') {
    if (/^Michigan takes down No\. 4 UCLA$/i.test(t)) {
      return fact(
        'football:game_win:team:michigan:opponent:ucla:opponent_rank:4',
        'Michigan defeated No. 4 UCLA',
      );
    }
    if (/^Tarik Skubal is headed to the Mets$/i.test(t)) {
      return fact(
        'baseball:move:actor:tarik skubal:team:mets',
        'Tarik Skubal is headed to the Mets',
      );
    }
    if (/^Brevard's Alex Araneda just hit the longest field goal in DIII history$/i.test(t)) {
      return fact(
        'football:field_goal_record:actor:alex araneda:team:brevard:division:diii',
        "Brevard's Alex Araneda hit the longest field goal in Division III history",
      );
    }
  }

  if (source === 'cowboys') {
    if (/^TD, CeeDee$/i.test(t)) {
      return fact(
        'football:touchdown:actor:ceedee lamb:team:cowboys',
        'CeeDee Lamb scored a touchdown for the Cowboys',
      );
    }
  }

  if (source === 'eagles') {
    if (/^The Birds won the Battle of PA$/i.test(t)) {
      return fact(
        'football:game_win:team:eagles:rivalry:battle_of_pa',
        'The Eagles won the Battle of Pennsylvania',
      );
    }
  }

  if (source === 'mlb') {
    if (/^The moment that Pete Crow-Armstrong was announced as the National League MVP$/i.test(t)) {
      return fact(
        'baseball:award:actor:pete crow armstrong:award:nl_mvp:year:2026',
        'Pete Crow-Armstrong won the 2026 NL MVP award',
      );
    }
    if (/^Zack Wheeler and Yordan [AÁ]lvarez each win Comeback Player of the Year$/i.test(t)) {
      return fact(
        'baseball:award:actors:yordan alvarez:zack wheeler:award:comeback_player',
        'Zack Wheeler and Yordan Álvarez won Comeback Player of the Year',
      );
    }
    if (/^THE MILWAUKEE BREWERS ARE WORLD SERIES CHAMPS$/i.test(t)) {
      return fact(
        'baseball:championship:team:brewers:title:world_series',
        'The Milwaukee Brewers won the World Series',
      );
    }
    if (/^WILLIAM CONTRERAS IS THE 2026 WORLD SERIES MVP$/i.test(t)) {
      return fact(
        'baseball:award:actor:william contreras:award:world_series_mvp:year:2026',
        'William Contreras won the 2026 World Series MVP award',
      );
    }
  }

  // ── Premier League, MLS & UEFA ────────────────────────────────────────
  if (source === 'premier league') {
    if (/^This Angle Of Mo Salah's Goal v Man Utd$/i.test(t)) {
      return fact(
        'soccer:goal:actor:mohamed salah:opponent:manchester united',
        'Mohamed Salah scored against Manchester United',
      );
    }
    if (/^Diego Gomez's Goal Shocked EVERYONE$/i.test(t)) {
      return fact(
        'soccer:goal:actor:diego gomez',
        'Diego Gomez scored a goal',
      );
    }
    if (/^Evanilson With The No-Look Finish$/i.test(t)) {
      return fact(
        'soccer:goal:actor:evanilson:kind:no_look',
        'Evanilson scored a no-look finish',
      );
    }
    if (/^Man Utd 4-4 Aston Villa LAST-MINUTE SCENES$/i.test(t)) {
      return fact(
        'soccer:score_recap:aston villa:4:manchester united:4',
        'Manchester United and Aston Villa drew 4-4',
      );
    }
    if (/^Liam Delap WONDERGOAL \+ Ronaldo SIU$/i.test(t)) {
      return fact(
        'soccer:goal:actor:liam delap',
        'Liam Delap scored a goal',
      );
    }
    if (/^(?:Zion Suzuki Pulls Off A (?:WONDER )?Save|You MUST SEE This Zion Suzuki Save)$/i.test(t)) {
      return fact(
        'soccer:save:actor:zion suzuki',
        'Zion Suzuki made a save',
      );
    }
    if (/^Xabi Alonso LOVED Morgan Rogers' Goal$/i.test(t)) {
      return fact(
        'soccer:goal:actor:morgan rogers',
        'Morgan Rogers scored a goal',
      );
    }
  }

  if (source === 'mls') {
    if (/^Bruno Caicedo FINISHED A (?:CRAZY )?PLAY for Vancouver$/i.test(t)) {
      return fact(
        'soccer:goal:actor:bruno caicedo:team:vancouver',
        'Bruno Caicedo scored for Vancouver',
      );
    }
    if (/^Gonzalo Tapia's two goals power (?:.+? )?over Inter Miami! \/\/ MLS Cup Playoffs$/i.test(t)) {
      return fact(
        'soccer:goal_total:actor:gonzalo tapia:match:goals:2:opponent:inter miami',
        'Gonzalo Tapia scored two goals against Inter Miami in the MLS Cup Playoffs',
      );
    }
    if (/^Samuel Gidi STRIKE SEALED Audi MLS Cup Playoff win for Cincinnati$/i.test(t)) {
      return fact(
        'soccer:goal:actor:samuel gidi:team:cincinnati:phase:playoffs',
        'Samuel Gidi scored to seal an MLS Cup Playoff win for Cincinnati',
      );
    }
    if (/^RSL took Sea(?:tt|t)le to PKS in the Audi MLS Cup Playoffs$/i.test(t)) {
      return fact(
        'soccer:penalty_shootout:teams:real salt lake:seattle:competition:mls_cup_playoffs',
        'Real Salt Lake took Seattle to penalty kicks in the MLS Cup Playoffs',
      );
    }
    if (/^Maxwell Woldezi is your MLS Defensive Player of the Year! A force all season long$/i.test(t)) {
      return fact(
        'soccer:award:actor:maxwell woldezi:award:mls_dpoy',
        'Maxwell Woldezi won MLS Defensive Player of the Year',
      );
    }
  }

  if (source === 'uefa') {
    if (/^Bale's trivela cross$/i.test(t)) {
      return fact(
        'soccer:cross:actor:gareth bale:kind:trivela',
        'Gareth Bale delivered a trivela cross',
      );
    }
  }

  // ── NHL & Rangers ─────────────────────────────────────────────────────
  if (source === 'nhl') {
    if (/^Cue the Hats for Bennett$/i.test(t)) {
      return fact(
        'hockey:hat_trick:actor:sam bennett',
        'Sam Bennett scored a hat trick',
      );
    }
    if (/^Jamie Benn joins the 1\s*0\s*0\s*0 POINT CLUB$/i.test(t)) {
      return fact(
        'hockey:career_milestone:actor:jamie benn:points:1000',
        'Jamie Benn reached 1,000 NHL career points',
      );
    }
    if (/^Tarasov (?:Absolutely )?Robs Guentzel$/i.test(t)) {
      return fact(
        'hockey:save:goalie:daniil tarasov:shooter:jake guentzel',
        'Daniil Tarasov robbed Jake Guentzel with a save',
      );
    }
    if (/^Morrissey lands the jet in OVERTIME$/i.test(t)) {
      return fact(
        'hockey:overtime_winner:actor:josh morrissey',
        'Josh Morrissey scored in overtime',
      );
    }
    if (/^OT Runs Through Caufield$/i.test(t)) {
      return fact(
        'hockey:overtime_winner:actor:cole caufield',
        'Cole Caufield scored in overtime',
      );
    }
    if (/^Pasta's shootout winner was$/i.test(t)) {
      return fact(
        'hockey:shootout_winner:actor:david pastrnak',
        'David Pastrnak scored a shootout winner',
      );
    }
    if (/^BEDARD SNIPE makes the POST SING$/i.test(t)) {
      return fact(
        'hockey:goal:actor:connor bedard:shot:snipe',
        'Connor Bedard scored off the post',
      );
    }
  }

  if (source === 'rangers') {
    if (/^Power play Mika magic$/i.test(t)) {
      return fact(
        'hockey:power_play:actor:mika zibanejad:team:rangers',
        'Mika Zibanejad created a power-play highlight for the Rangers',
      );
    }
    if (/^Top shelf J\.T\.?$/i.test(t)) {
      return fact(
        'hockey:top_shelf:actor:jt miller:team:rangers',
        'J.T. Miller went top shelf for the Rangers',
      );
    }
  }

  return null;
}
