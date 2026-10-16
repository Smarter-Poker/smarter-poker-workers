/**
 * Authored rhetorical alternatives for facts the title actually establishes.
 * A video id is NEVER a freshness fact. The semantic identity is the named
 * subject, the explicitly stated action and the question/claim being made.
 * All alternatives for that proposition share one key across videos/styles.
 */
import { fleetHash } from './FleetScheduler.js';
import { publicFigureDomain, type PostBrief } from './PostBrief.js';
import type { StyleSheet } from './StyleSheet.js';
import {captionHolding} from './CaptionHolding.js';
export {captionHolding} from './CaptionHolding.js';
import { pokerVideoContextFact } from './VideoContextFact.js';
import { newsTitleFact } from './NewsTitleFact.js';
import {sportsVideoFact} from './SportsVideoFact.js';

export interface CaptionFact {
  person: string;
  identity?: string;
  action: 'bluff' | 'river_call' | 'river_fold' | 'river_decision' | 'pot_contribution' | 'three' | 'dunk' | 'goal' | 'fold' | 'bracelet' | 'all_in_context' | 'pot_context' | 'river_context' | 'aces_cracked_context' | 'news_guarantee' | 'news_bubble' | 'news_sweep' | 'stakes_context' | 'prize_context' | 'holding_context' | 'baseball_home_run_context' | 'baseball_close_context' | 'soccer_goal_total_context' | 'baseball_matchup_context' | 'basketball_passing_context' | 'soccer_equalizer_context' | 'baseball_series_context' | 'sports_technical_context' | 'made_hand_context';
  subject: string;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const possessive = (value: string) => `${value}${/s$/i.test(value) ? "'" : "'s"}`;

/** Conservative actor/action binding, not entity presence mistaken for agency. */
export function captionFact(b: PostBrief): CaptionFact | null {
  if ((b.kind !== 'video' && b.kind !== 'link') || b.isQuestion) return null;
  const titleForGuards = b.title.replace(/[\u2018\u2019]/g,"'");
  if (/\b(?:not|never|didn't|doesn't|don't|isn't|wasn't|weren't|won't|can't|cannot|could|would|should|couldn't|wouldn't|shouldn't|might|may|if|unless)\b/i.test(titleForGuards)) return null;
  if (b.kind === 'link') {
    const report = newsTitleFact(b);
    if (report) return report;
  }
  if(b.kind==='video'&&b.domain==='sports'){
    const context=sportsVideoFact(b);
    if(context)return context;
  }
  // Typed context facts do not assign an unnamed action to a person. These
  // are literal variant/holding/amount bindings, not a title or video-id salt.
  if (b.domain === 'poker' && !/\b(?:not|never|could|would|should|might|can|reacts|watches)\b/i.test(b.title)) {
    const variant = b.title.match(/\b(PLO[456]?)\s+river decision\b/i)?.[1]?.toUpperCase();
    if (variant) return {person:'',identity:`variant:${variant.toLowerCase()}`,action:'river_decision',subject:`the ${variant} river decision`};
    const holdingText = b.title.match(/\bbluffing with ([^.!?]+)(?:[.!?]|$)/i)?.[1];
    const holding = holdingText ? captionHolding(holdingText) : null;
    if (holding) return {person:'',identity:`holding:${holding.key}`,action:'bluff',subject:`the ${holding.spoken} bluff`};
    const contribution = b.title.match(/\bput\s+\$([\d,]+(?:\.\d{1,2})?)\s+into\s+(?:a\s+)?\$([\d,]+(?:\.\d{1,2})?)\s+pot\b/i);
    if (contribution) {
      const amount = Number(contribution[1]!.replace(/,/g,''));
      const pot = Number(contribution[2]!.replace(/,/g,''));
      if (Number.isFinite(amount) && Number.isFinite(pot) && amount > 0 && pot > amount) return {
        person:'',identity:`contribution:${amount}:pot:${pot}`,action:'pot_contribution',subject:`the $${amount} contribution to a $${pot} pot`,
      };
    }
    const context = pokerVideoContextFact(b.title,b.source);
    if (context) return context;
  }
  const people = b.people.filter(person=>publicFigureDomain(person)===b.domain);
  if (people.length !== 1) return null;
  const person = people[0]!;
  // The extractor can retain a surname alongside its canonical full name.
  // A genuinely different additional person still makes actor binding unsafe.
  if (b.people.some(p=>!person.toLowerCase().includes(p.toLowerCase().replace(/['’]s$/,'')))) return null;
  if (publicFigureDomain(person) !== b.domain || !b.title.toLowerCase().includes(person.toLowerCase())) return null;
  if (/\b(?:not|never|didn't|doesn't|could|would|should|might|can|watches|reacts|against|versus|vs)\b/i.test(b.title)) return null;
  const actor = escape(person);
  // Additional literal sports bindings are whole titles, not entity presence
  // mistaken for agency. The canonical known-person registry owns identity.
  const literalTitle=titleForGuards.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,'').trim();
  if(b.domain==='sports') {
    const literalActions: Array<[CaptionFact['action'],RegExp,string]> = [
      ['goal',new RegExp(`^${actor}'s (?:trademark )?goal[.!]*$`,'i'),`${possessive(person)} goal`],
      ['dunk',new RegExp(`^${actor} (?:turns the corner and )?throws down (?:a |the )?(?:powerful |huge |big )?slam[.!]*$`,'i'),`${possessive(person)} dunk`],
      ['three',new RegExp(`^${actor} gets (?:the |a )?friendly bounce on (?:a |the )?(?:clutch )?(?:go-ahead )?three[.!]*$`,'i'),`${possessive(person)} three-pointer`],
    ];
    for(const [action,pattern,subject] of literalActions) if(pattern.test(literalTitle)) return {person,action,subject};
  }
  const bluffObject = '(?:(?:a|an|the) )?(?:(?:river|huge|big|bold|massive|crazy|insane|audacious|triple-barrel) ){0,3}bluff(?![a-z]|[- ]catch)';
  const patterns: Array<[CaptionFact['action'], RegExp, string]> = b.domain === 'poker' ? [
    ['bluff', new RegExp(`${actor}\\s+(?:runs|fires|attempts|pulls off) ${bluffObject}`, 'i'), `${possessive(person)} bluff`],
    ['river_call', new RegExp(`${actor}\\s+(?:makes|finds) (?:(?:a|the) )?(?:(?:huge|tough|big|brutal) )?river call\\b`, 'i'), `${possessive(person)} river call`],
    ['river_fold', new RegExp(`${actor}\\s+(?:makes|finds) (?:(?:a|the) )?(?:(?:huge|tough|big|brutal) )?river fold\\b`, 'i'), `${possessive(person)} river fold`],
    ['river_decision', new RegExp(`${actor}\\s+(?:faces|makes|considers|finds) (?:(?:a|the) )?(?:(?:huge|tough|big|brutal) )?river decision\\b`, 'i'), `${possessive(person)} river decision`],
    ['fold', new RegExp(`${actor}\\s+(?:folds|makes (?:a |the )?(?:huge |big |tough )?fold)\\b`, 'i'), `${possessive(person)} fold`],
    ['bracelet', new RegExp(`${actor}\\s+wins (?:(?:his|her|a|the) )?(?:[0-9]+(?:st|nd|rd|th)? )?(?:WSOP )?bracelet\\b`, 'i'), `${possessive(person)} bracelet win`],
  ] : [
    ['three', new RegExp(`${actor}\\s+(?:hits|makes|drains|sinks) (?:(?:a|the) )?(?:(?:deep|huge|contested|game-winning|clutch|long) )?three(?: pointer|-pointer)?\\b`, 'i'), `${possessive(person)} three-pointer`],
    ['dunk', new RegExp(`${actor}\\s+(?:dunks|throws down (?:a |the )?(?:huge |big )?dunk|finishes (?:a |the )?dunk)\\b`, 'i'), `${possessive(person)} dunk`],
  ];
  for (const [action, pattern, subject] of patterns) if (pattern.test(b.title)) return { person, action, subject };
  return null;
}

type Angle = { key: string; variants: (subject: string) => string[] };
const ANGLES: Record<Exclude<CaptionFact['action'], 'river_call' | 'river_fold'>, Angle[]> = {
  baseball_series_context: [
    {key:'series_game_context',variants:s=>[`What game context accompanies ${s}?`,`I'd examine the games around ${s}.`,`Which game details matter when discussing ${s}?`]},
  ],
  sports_technical_context: [
    {key:'literal_sequence',variants:s=>[`What stands out in the sequence around ${s}?`,`I'd follow the sequence around ${s}.`,`Which details are worth examining in ${s}?`]},
  ],
  made_hand_context: [
    {key:'board_context',variants:s=>[`What board context accompanies ${s}?`,`I'd examine the board around ${s}.`,`Which board details matter when discussing ${s}?`]},
  ],
  baseball_matchup_context: [
    {key:'game_sequence',variants:s=>[`Which innings are worth examining in ${s}?`,`I'd follow the inning-by-inning sequence in ${s}.`,`What changes across the innings in ${s}?`]},
  ],
  basketball_passing_context: [
    {key:'passing_movement',variants:s=>[`Which movement creates the opening in ${s}?`,`I'd follow the ball movement in ${s}.`,`How does the passing sequence develop in ${s}?`]},
  ],
  soccer_equalizer_context: [
    {key:'equalizer_buildup',variants:s=>[`What creates the opening for ${s}?`,`I'd follow the buildup to ${s}.`,`Which movement leads to ${s}?`]},
  ],
  baseball_home_run_context: [
    {key:'at_bat_context',variants:s=>[`What is the at-bat context for ${s}?`,`I'd examine the pitch sequence around ${s}.`,`What leads up to ${s}?`]},
  ],
  baseball_close_context: [
    {key:'closing_context',variants:s=>[`What is the closing context for ${s}?`,`I'd look at the final-inning sequence around ${s}.`,`How does the final inning develop in ${s}?`]},
  ],
  soccer_goal_total_context: [
    {key:'season_context',variants:s=>[`What season context sits behind ${s}?`,`I'd look at the chances behind ${s}.`,`What is the scoring context for ${s}?`]},
  ],
  holding_context: [
    {key:'opposing_ranges',variants:s=>[`What opposing ranges belong in a discussion of ${s}?`,`I'd consider the opposing ranges when looking at ${s}.`,`Which ranges are relevant to ${s}?`]},
  ],
  stakes_context: [
    {key:'effective_stacks',variants:s=>[`What effective stacks sit behind ${s}?`,`I'd look at the effective stacks when discussing ${s}.`,`How much stack depth is available at ${s}?`]},
  ],
  prize_context: [
    {key:'payout_structure',variants:s=>[`What payout structure accompanies ${s}?`,`I'd examine the payout schedule around ${s}.`,`How is ${s} situated within the payout structure?`]},
  ],
  news_guarantee: [
    {key:'guarantee_terms',variants:s=>[`What are the terms behind ${s}?`,`I'd distinguish the guarantee from the eventual payouts when reading about ${s}.`,`Which details define ${s}?`]},
  ],
  news_bubble: [
    {key:'bubble_decisions',variants:s=>[`What decision context belongs alongside ${s}?`,`I'd examine the decisions around the bubbles in ${s}.`,`What context is available for ${s}?`]},
  ],
  news_sweep: [
    {key:'series_context',variants:s=>[`Which parts of the series help explain ${s}?`,`I'd look at the individual games when discussing ${s}.`,`What is the series context for ${s}?`]},
  ],
  aces_cracked_context: [
    {key:'runout',variants:s=>[`Which part of the runout explains ${s}?`,`I'd examine the runout when discussing ${s}.`,`What changes for pocket aces during ${s}?`]},
  ],
  goal: [
    {key:'setup',variants:s=>[`What creates the opening for ${s}?`,`I'd look at the buildup before judging ${s}.`,`Which movement sets up ${s}?`]},
    {key:'space',variants:s=>[`Where does the space for ${s} come from?`,`I'd examine the space available before ${s}.`,`What room is available for the finish on ${s}?`]},
  ],
  all_in_context: [
    { key: 'ranges', variants: s => [`Which ranges meet in ${s}?`, `I'd start with the ranges involved in ${s}.`, `What hands reach ${s}?`] },
  ],
  pot_context: [
    { key: 'structure', variants: s => [`How is ${s} structured?`, `I'd examine the pot structure before judging ${s}.`, `What do the contributions establish in ${s}?`] },
  ],
  river_context: [
    { key: 'earlier_action', variants: s => [`What earlier action leads to ${s}?`, `I'd trace the earlier action before assessing ${s}.`, `How do the ranges get to ${s}?`] },
  ],
  bluff: [
    { key: 'range', variants: s => [`What value range does ${s} represent?`, `The value range behind ${s} is my starting point.`, `Before the result, what value hands belong in ${s}?`, `I'd start with the value hands represented by ${s}.`, `For ${s}, I'm interested in value combinations first.`, `Which value combinations make sense alongside ${s}?`] },
    { key: 'sizing', variants: s => [`How does the sizing affect ${s}?`, `The sizing is the detail I want to examine in ${s}.`, `With ${s}, I'd separate the sizing decision from the result.`, `Sizing first, outcome second when I think about ${s}.`, `Would another size change the argument for ${s}?`, `I want to compare the sizing options for ${s}.`] },
    { key: 'opponent', variants: s => [`Who is the target for ${s}?`, `The opponent matters as much as the cards when considering ${s}.`, `I'd want the opponent's range before judging ${s}.`, `What folding range is needed for ${s}?`, `For ${s}, the first question is what the opponent can fold.`, `Which hands is ${s} trying to move off the pot?`] },
  ],
  river_decision: [
    { key: 'range', variants: s => [`What range reaches ${s}?`, `I'd work back through the ranges before judging ${s}.`, `The earlier range construction is my question about ${s}.`, `For ${s}, I want to account for the hands that got there.`, `Which combinations survive to ${s}?`, `Ranges before results is how I'd approach ${s}.`] },
    { key: 'price', variants: s => [`What price is being offered at ${s}?`, `I'd check the pot odds before judging ${s}.`, `The price is my starting point for ${s}.`, `How much equity does the price require at ${s}?`, `For ${s}, I want the price before the verdict.`, `Pot odds first when considering ${s}.`] },
  ],
  pot_contribution: [
    { key: 'size', variants: s => [`What changes with ${s}?`, `I'd compare the contribution with the pot before judging ${s}.`, `How much pressure comes from ${s}?`, `For ${s}, I want the size in relation to the pot.`, `What does ${s} ask the next player to do?`, `The ratio is the useful starting point for ${s}.`] },
  ],
  fold: [
    { key: 'range', variants: s => [`Which range makes ${s} reasonable?`, `I'd want the opposing range before judging ${s}.`, `The range, not the revealed cards, is my question about ${s}.`, `For ${s}, which hands are still in the opposing range?`, `What range would change the case for ${s}?`, `I'd start with combinations when assessing ${s}.`] },
  ],
  bracelet: [
    { key: 'turning_point', variants: s => [`Which decision mattered most on the way to ${s}?`, `I'd like to trace the key decisions behind ${s}.`, `For ${s}, the path interests me more than the final photo.`, `What was the turning point behind ${s}?`, `The decisions leading to ${s} are what I want to unpack.`, `Which part of the run explains ${s} best?`] },
  ],
  three: [
    { key: 'space', variants: s => [`How much space was available for ${s}?`, `I'd look at the space before judging ${s}.`, `The room to release is my question about ${s}.`, `For ${s}, I want to compare the space and the closeout.`, `Where does the room for ${s} come from?`, `Space before the release is what I'd examine in ${s}.`] },
    { key: 'setup', variants: s => [`What sets up ${s}?`, `The setup for ${s} interests me as much as the shot.`, `I'd start a beat earlier when looking at ${s}.`, `For ${s}, what happens before the ball arrives?`, `Which movement creates the opportunity for ${s}?`, `I'd want the lead-in to ${s}, not just the release.`] },
  ],
  dunk: [
    { key: 'setup', variants: s => [`What creates the opening for ${s}?`, `I'd look at the setup before the finish on ${s}.`, `The route to the rim is my question about ${s}.`, `For ${s}, how is the opening created?`, `I'd start before takeoff when considering ${s}.`, `Which movement opens the lane for ${s}?`] },
  ],
};

const FOCUS: Record<string, string[]> = {
  'baseball_series_context:series_game_context': ['the game context','the individual games','the games around the series state','the game details'],
  'sports_technical_context:literal_sequence': ['the sequence of the play','the movement in the sequence','the details of the play','the sequence rather than an assumed result'],
  'made_hand_context:board_context': ['the board context','the board around the hands','the relevant board details','the cards on the board'],
  'baseball_matchup_context:game_sequence': ['the inning-by-inning sequence','the decisions across the innings','the course of the game','the inning context'],
  'basketball_passing_context:passing_movement': ['the ball movement','the passing sequence','the off-ball movement','the opening for the pass'],
  'soccer_equalizer_context:equalizer_buildup': ['the buildup to the goal','the movement before the finish','the opening for the shot','the play before the finish'],
  'baseball_home_run_context:at_bat_context': ['the pitch sequence','the count before the swing','the at-bat context','the pitches leading to the swing'],
  'baseball_close_context:closing_context': ['the final-inning sequence','the closing situation','the final-inning context','the sequence leading to the final out'],
  'soccer_goal_total_context:season_context': ['the chances behind the goal total','the scoring opportunities across the season','the context of the goal total','the chances rather than just the total'],
  'holding_context:opposing_ranges': ['the opposing ranges','the hands in the opposing ranges','the ranges around the holding','the relevant opposing combinations'],
  'stakes_context:effective_stacks': ['the effective stacks','the stack depth in big blinds','the available stack depth','the effective stacks rather than just the stake label'],
  'prize_context:payout_structure': ['the payout schedule','the distribution around the top prize','the wider payout structure','the distinction between the top prize and the total pool'],
  'news_guarantee:guarantee_terms': ['the published terms', 'the stated minimum prize pool', 'the distinction between a stated minimum and an eventual payout', 'the details attached to the stated minimum'],
  'news_bubble:bubble_decisions': ['the decisions around the bubbles','the context of the bubble finishes','the decisions around those bubbles','the circumstances of those bubble finishes'],
  'news_sweep:series_context': ['the individual games of the series','the matchups across the series','the course of the series','the games behind the series result'],
  'aces_cracked_context:runout': ['the runout of the hand','the board runout','the cards that change the hand','the progression of the board'],
  'goal:setup': ['the buildup to the goal','the movement before the finish','the opening for the shot','the play before the finish'],
  'goal:space': ['the space for the finish','the room available for the shot','the space before the shot','the distance to the defenders'],
  'all_in_context:ranges': ['the ranges involved', 'the hands still available', 'the possible opposing holdings', 'the ranges rather than the result'],
  'pot_context:structure': ['the pot structure', 'the contributions to the pot', 'the structure before the outcome', 'the amounts each player contributes'],
  'river_context:earlier_action': ['the earlier action', 'the ranges reaching the river', 'the decisions leading to the river', 'the route to the river'],
  'bluff:range': ['the represented value range', 'the value combinations', 'the value side of the range', 'the hands being represented'],
  'bluff:sizing': ['the sizing choice', 'the bet size', 'the available sizing options', 'the size relative to the pot'],
  'bluff:opponent': ['the opponent\'s folding range', 'the hands being targeted', 'the possible folds', 'the opponent\'s continuing range'],
  'river_decision:range': ['the earlier action', 'the ranges reaching the river', 'the combinations still available', 'the way the ranges narrowed'],
  'river_decision:price': ['the price being offered', 'the pot odds', 'the equity required by the price', 'the price relative to the pot'],
  'pot_contribution:size': ['the contribution relative to the pot', 'the size compared with the pot', 'the ratio between those two amounts', 'the next decision at that price'],
  'fold:range': ['the opposing range', 'the combinations still in the range', 'the hands represented by the opposing range', 'the range rather than the revealed cards'],
  'bracelet:turning_point': ['the key decisions along the way', 'the turning points of the run', 'the choices behind the result', 'the path through the event'],
  'three:space': ['the space before the release', 'the room available for the shot', 'the space and the closeout', 'the distance to the defender'],
  'three:setup': ['the setup before the shot', 'the movement before the release', 'the lead-in rather than just the shot', 'the way the opportunity develops'],
  'dunk:setup': ['the opening before takeoff', 'the route to the rim', 'the setup before the finish', 'the movement that opens the lane'],
};

/** Only grammar choices actually consumed below, never id-only decoration. */
function voiceChoice(profileId: string, habit: string, count: number): number {
  // FNV's low bits correlate across salts, especially in sequential profile
  // cohorts. Avalanche before taking a small modulus so cadence and diction
  // are independent habits rather than different labels for the same split.
  let value = fleetHash(profileId, habit);
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return ((value ^ (value >>> 16)) >>> 0) % count;
}

export function captionVoiceProfile(style: StyleSheet) {
  return {
    version: 7,
    speech: style.captionSyntax,
    // These select complete authored clauses below, not an invisible identity
    // token. A horse keeps its cadence across subjects and bounded retries.
    cadence: voiceChoice(style.profileId,'voice-cadence:v2',3),
    intent: voiceChoice(style.profileId,'voice-intent:v1',10),
    preface: voiceChoice(style.profileId,'voice-preface:v1',12),
    questionHabit: voiceChoice(style.profileId,'voice-question-habit:v1',4),
    contrast: voiceChoice(style.profileId,'voice-contrast:v1',4),
    density: style.length === 'terse' ? 'terse' : style.length === 'short' ? 'short' : style.length === 'two_sentence' || style.length === 'three_sentence' ? 'developed' : 'single',
    viewpoint: style.voice,
    register: style.slang,
    contractions: style.contractions,
    casing: style.casing,
    punctuation: style.punctuation,
    layout: style.layout,
    preferredAngles: Object.fromEntries(Object.entries(ANGLES).map(([family, angles])=>[
      family, fleetHash(style.profileId, `voice-angle:${family}`) % angles.length,
    ])),
    focus: Object.fromEntries(Object.entries(FOCUS).map(([key, values])=>[
      key, voiceChoice(style.profileId, `voice-focus:${key}`, values.length),
    ])),
    questions: Object.fromEntries(Object.entries(ANGLES).map(([family, angles])=>[
      family, angles.map(a=>voiceChoice(style.profileId, `voice-question:${family}:${a.key}`, a.variants('subject').filter(t=>t.endsWith('?')).length)),
    ])),
  };
}

/** Habits belong to the horse; the bounded retry changes angle, not identity. */
export function subjectCaption(b: PostBrief, style: StyleSheet, variant = '0') {
  const sourceFact = captionFact(b);
  if (!sourceFact) return null;
  // Some voices use the full public name, some the familiar surname. The
  // source identity in the ledger remains the full canonical person.
  const familiar = sourceFact.person && style.slang === 'heavy' ? sourceFact.person.split(' ').at(-1)! : sourceFact.person;
  const fact = { ...sourceFact, subject: sourceFact.person ? sourceFact.subject.replace(sourceFact.person, familiar) : sourceFact.subject };
  const family = fact.action === 'river_call' || fact.action === 'river_fold' ? 'river_decision' : fact.action;
  const plan = captionVoiceProfile(style);
  // A generic decision might be a check or a bet. Price questions are only
  // supported once the title actually establishes a call/fold decision.
  const angles = family === 'river_decision' && fact.action === 'river_decision'
    ? ANGLES.river_decision.filter(a=>a.key!=='price') : ANGLES[family];
  const retry = /^\d+$/.test(variant) ? Number(variant) : 0;
  const angle = angles[((plan.preferredAngles[family] ?? 0) + retry) % angles.length]!;
  const alternatives = angle.variants(fact.subject);
  const focusOptions = FOCUS[`${family}:${angle.key}`]!;
  const focus = focusOptions[plan.focus[`${family}:${angle.key}`]!]!;
  const questions = alternatives.filter(x=>x.endsWith('?'));
  const sourceQuestion = questions[plan.questions[family]?.[ANGLES[family].findIndex(a=>a.key===angle.key)] ?? 0]!;
  // A stable question habit is actually spoken across topics, not an unused
  // profile fingerprint. Every alternative asks about an established fact;
  // none asserts an unseen play, experience, motive or result.
  const question = plan.questionHabit < 2 ? sourceQuestion : plan.questionHabit === 2
    ? `For ${fact.subject}, what should we examine about ${focus}?`
    : `Which details of ${focus} matter when assessing ${fact.subject}?`;
  // In a compound frame the opening already establishes the source fact.
  // A context-only question develops it without circling through the same
  // event noun in a source, a typed reference and a focus phrase.
  const followupQuestion = [
    `What should we examine about ${focus}?`,
    `How should ${focus} inform the assessment?`,
    `Which details of ${focus} matter?`,
    `What context is missing about ${focus}?`,
  ][plan.questionHabit]!;
  const judgement = style.slang === 'none' ? 'assessment' : style.slang === 'heavy' ? 'read' : 'take';
  const aJudgement = `${judgement === 'assessment' ? 'an' : 'a'} ${judgement}`;
  const relation = judgement === 'assessment' ? 'of' : 'on';
  const intent = {
    first: ["I'd start with", 'I want to check', 'I would look at', 'My starting point is', "I'm interested in", "I'd begin with", 'My first question concerns', 'I would examine', 'My attention goes to', 'I want to understand'],
    impersonal: ['Start with', 'The starting point is', 'The useful context is', 'First, consider', 'Begin with', 'The focus belongs on', 'The first question concerns', 'Examine', 'Give some attention to', 'Try to understand'],
    second: ['Start with', 'Look at', 'Check', 'Consider', 'Put the focus on', 'Go back to', 'Ask first about', 'Examine', 'Pay attention to', 'Try to understand'],
    plural: ["We'd start with", 'We should check', 'We can look at', 'Our starting point is', 'We need to consider', "We'd begin with", 'Our first question concerns', 'We could examine', 'Our attention goes to', 'We need to understand'],
  }[style.voice][plan.intent]!;
  const starting = `${intent} ${focus} for ${fact.subject}`;
  const preface = [
    `Before judging ${fact.subject}`, `Before settling on ${aJudgement} ${relation} ${fact.subject}`,
    `To get a read on ${fact.subject}`, `For a closer look at ${fact.subject}`,
    `When assessing ${fact.subject}`, `Before deciding about ${fact.subject}`,
    `To understand ${fact.subject}`, `For context on ${fact.subject}`,
    `Before drawing conclusions about ${fact.subject}`, `For a discussion of ${fact.subject}`,
    `To put ${fact.subject} in perspective`, `When looking more closely at ${fact.subject}`,
  ][plan.preface]!;
  const contrast = [
    `The result alone doesn't settle ${fact.subject}`,
    `A result isn't the whole story with ${fact.subject}`,
    `I'd separate the outcome from the reasoning behind ${fact.subject}`,
    `There's more than the outcome to consider with ${fact.subject}`,
  ][plan.contrast]!;
  const wanting = style.voice === 'plural' ? `we'd want` : style.voice === 'impersonal' ? 'the missing context is' : style.voice === 'second' ? 'consider' : "I'd want";
  const continuingIntent = /^I(?:\b|')/.test(intent) ? intent : intent.charAt(0).toLowerCase() + intent.slice(1);
  // Typed clauses, not arbitrary word reordering: a question has a question
  // slot, a noun phrase has a noun slot, and an imperative stays complete.
  const structures = [
    question,
    starting,
    `${preface}, ${wanting} ${focus}`,
    `For ${fact.subject}, the discussion starts with ${focus}`,
    fact.action === 'news_guarantee' ? `${fact.subject}: ${followupQuestion}` : `${contrast}. ${followupQuestion}`,
    `Hard to judge ${fact.subject} without ${focus}`,
    `${intent} ${focus} when considering ${fact.subject}`,
    `For ${aJudgement} ${relation} ${fact.subject}, put ${focus} first`,
    fact.action === 'news_guarantee' ? `For ${fact.subject}, I'd want to understand ${focus}` : `I'd separate the outcome of ${fact.subject} from ${focus}`,
    `What would ${focus} add to ${aJudgement} ${relation} ${fact.subject}?`,
    `${preface}, ${continuingIntent} ${focus}`,
    `${aJudgement.charAt(0).toUpperCase() + aJudgement.slice(1)} ${relation} ${fact.subject} needs context: ${focus}`,
  ];
  const conversational = [
    `On ${fact.subject}, what about ${focus}?`,
    `${fact.subject} has me asking about ${focus}`,
    `I need ${focus} to form ${aJudgement} ${relation} ${fact.subject}`,
    `${fact.subject} is where I'd ask about ${focus}`,
    fact.action === 'news_guarantee' ? `${fact.subject} raises a question. ${followupQuestion}` : `The outcome of ${fact.subject} is one thing. ${followupQuestion}`,
    `My read on ${fact.subject} would depend on ${focus}`,
    `${fact.subject} is a question about ${focus} for me`,
    `For me, ${focus} comes before a verdict on ${fact.subject}`,
    fact.action === 'news_guarantee' ? `My question about ${fact.subject} concerns ${focus}` : `I'd rather discuss ${focus} than just the outcome of ${fact.subject}`,
    `Anyone looking at ${focus} when assessing ${fact.subject}?`,
    `${fact.subject}: ${continuingIntent} ${focus}`,
    `A little context for ${fact.subject} first: ${focus}`,
  ];
  const analytical = [
    `How should ${focus} inform a read on ${fact.subject}?`,
    `The question behind ${fact.subject} is ${focus}`,
    `Assessing ${fact.subject} starts with a look at ${focus}`,
    `${focus} is the starting point I'd use for ${fact.subject}`,
    fact.action === 'news_guarantee' ? `Looking more closely at ${fact.subject}: ${followupQuestion}` : `Looking beyond the result of ${fact.subject}: ${followupQuestion}`,
    `${fact.subject} needs to be considered alongside ${focus}`,
    `With ${fact.subject}, my focus would be ${focus}`,
    `Context before conclusions on ${fact.subject}: ${focus}`,
    fact.action === 'news_guarantee' ? `An assessment of ${fact.subject} should account for ${focus}` : `Separate the outcome from the analysis of ${fact.subject}: consider ${focus}`,
    `What would a closer look at ${focus} change about a read on ${fact.subject}?`,
    `Put ${focus} at the centre of the discussion of ${fact.subject}`,
    `The context I'd ask for on ${fact.subject} is ${focus}`,
  ];
  let text = [structures, conversational, analytical][plan.cadence]![style.captionSyntax % structures.length]!;
  // Terse and short voices choose a whole short clause. Never truncate a
  // fact or add a generic sentence just to match a word-count target.
  const compact = [
    question,
    `${intent} ${focus} for ${fact.subject}`,
    `${fact.subject}: ${focus} first`,
    `What about ${focus} in ${fact.subject}?`,
    `${preface}, ${wanting} ${focus}`,
    `I'd check ${focus} for ${fact.subject}`,
    `For ${fact.subject}, start with ${focus}`,
    `How would ${focus} change a read on ${fact.subject}?`,
    `${fact.subject}, with ${focus} in mind`,
    `${focus} before a verdict on ${fact.subject}`,
    `My question on ${fact.subject}: ${focus}`,
    `${fact.subject}: I want ${focus}`,
  ];
  const compactConversational = [
    `What about ${focus} for ${fact.subject}?`,
    `${fact.subject}: I'd check ${focus}`,
    `${focus} first for ${fact.subject}`,
    `${fact.subject}: where does ${focus} fit?`,
    `For me, ${fact.subject} needs ${focus}`,
    `${fact.subject}? Start with ${focus}`,
    `I'd want ${focus} before judging ${fact.subject}`,
    `Anyone else asking about ${focus} for ${fact.subject}?`,
    `My focus for ${fact.subject}: ${focus}`,
    `Before judging ${fact.subject}: ${focus}`,
    `${fact.subject} has me asking about ${focus}`,
    `I'm interested in ${focus} for ${fact.subject}`,
  ];
  const compactAnalytical = [
    `${fact.subject}: how does ${focus} fit?`,
    `Start with ${fact.subject}, then examine ${focus}`,
    `${fact.subject}, viewed through ${focus}`,
    `How does ${focus} inform ${fact.subject}?`,
    `Assess ${fact.subject} in light of ${focus}`,
    `${fact.subject} needs context: ${focus}`,
    `Put ${focus} first when considering ${fact.subject}`,
    `What does ${focus} clarify about ${fact.subject}?`,
    `For ${fact.subject}, the context is ${focus}`,
    `${focus}: the question behind ${fact.subject}`,
    `A closer look at ${fact.subject}: ${focus}`,
    fact.action === 'news_guarantee' ? `${fact.subject}, with attention to ${focus}` : `${fact.subject}, beyond the result: ${focus}`,
  ];
  if (style.length === 'terse' || style.length === 'short') {
    text = [compact, compactConversational, compactAnalytical][plan.cadence]![style.captionSyntax % compact.length]!;
  }
  // A stable contraction register is grammatical variation, not random noise.
  if (!style.contractions) text = text.replace(/I'd\b/g, 'I would').replace(/I'm\b/g, 'I am');
  const reference = fact.action === 'river_call' ? 'that call'
    : fact.action === 'river_fold' || fact.action === 'fold' ? 'that fold'
      : fact.action === 'bluff' ? 'that bluff' : fact.action === 'three' ? 'that shot' : fact.action === 'goal' ? 'that goal'
        : fact.action === 'dunk' ? 'that finish' : fact.action === 'bracelet' ? 'that win'
          : fact.action === 'pot_contribution' ? 'that contribution' : fact.action === 'pot_context' ? 'that pot'
            : fact.action === 'all_in_context' ? 'that all-in' : fact.action === 'river_context' ? 'that river' : fact.action === 'aces_cracked_context' ? 'that hand'
              : fact.action === 'news_guarantee' ? 'that guarantee' : fact.action === 'news_bubble' ? 'that bubble run' : fact.action === 'news_sweep' ? 'that series'
                : fact.action === 'stakes_context' ? 'those stakes' : fact.action === 'prize_context' ? 'that listed prize' : fact.action === 'holding_context' ? 'that holding'
                  : fact.action === 'baseball_home_run_context' ? 'that home run' : fact.action === 'baseball_close_context' ? 'that close' : fact.action === 'soccer_goal_total_context' ? 'that goal total'
                    : fact.action === 'baseball_matchup_context' ? 'that matchup' : fact.action === 'basketball_passing_context' ? 'that passing sequence' : fact.action === 'soccer_equalizer_context' ? 'that equalizer'
                      : fact.action === 'baseball_series_context' ? 'that series context' : fact.action === 'sports_technical_context' ? 'that play' : fact.action === 'made_hand_context' ? 'that hand context' : 'that decision';
  // Compound frames already establish the full source fact in their preface.
  // Refer back to it in the question instead of repeating the whole headline.
  // Keep the source fact once, and never change its canonical meaning key.
  const [opening, ...mentions] = text.split(fact.subject);
  if (mentions.length > 1) text = `${opening}${fact.subject}${mentions.join(reference)}`;
  return {
    text,
    subject: fact.subject,
    reference,
    statement: alternatives[1]!.replace(fact.subject, reference),
    semanticKey: `meaning:subject:${(fact.identity ?? fact.person).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}:${fact.action}:${angle.key}`,
    grounding: [fact.person ? `actor:${fact.person}` : `context:${fact.identity}`, `title_action:${fact.action}`, `angle:${angle.key}`],
  };
}
