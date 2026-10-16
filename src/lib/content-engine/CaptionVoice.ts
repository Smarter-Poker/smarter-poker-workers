/**
 * Authored rhetorical alternatives for facts the title actually establishes.
 * A video id is NEVER a freshness fact. The semantic identity is the named
 * subject, the explicitly stated action and the question/claim being made.
 * All alternatives for that proposition share one key across videos/styles.
 */
import { fleetHash } from './FleetScheduler.js';
import { publicFigureDomain, type PostBrief } from './PostBrief.js';
import type { StyleSheet } from './StyleSheet.js';
import { RANKS, rankWord } from './PokerEvaluator.js';
import { sayHolding } from './HandVoice.js';
import { pokerVideoContextFact } from './VideoContextFact.js';

export interface CaptionFact {
  person: string;
  identity?: string;
  action: 'bluff' | 'river_call' | 'river_fold' | 'river_decision' | 'pot_contribution' | 'three' | 'dunk' | 'fold' | 'bracelet' | 'all_in_context' | 'pot_context' | 'river_context';
  subject: string;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const possessive = (value: string) => `${value}${/s$/i.test(value) ? "'" : "'s"}`;

/** Caption-source notation, validated and spoken by the existing poker rules. */
export function captionHolding(value: string): { key: string; spoken: string } | null {
  const raw=value.trim().toLowerCase();
  let notation=raw.replace(/[\s-]+/g,'');
  if (!/^[akqjt2-9]{2}[so]?$/.test(notation)) {
    const words=raw.replace(/-/g,' ').split(/\s+/);
    const ranks=new Map(RANKS.map(rank=>[rankWord(rank),rank]));
    if (words.length < 2 || words.length > 3 || !ranks.has(words[0]!) || !ranks.has(words[1]!)) return null;
    const suffix=words[2] === 'suited' ? 's' : words[2] === 'offsuit' ? 'o' : words[2] ? null : '';
    if (suffix === null) return null;
    notation=`${ranks.get(words[0]!)}${ranks.get(words[1]!)}${suffix}`;
  }
  const a=notation[0]!.toUpperCase();const b=notation[1]!.toUpperCase();
  const suffix=notation.slice(2).toLowerCase();
  if (a===b && suffix) return null;
  const ordered=RANKS.indexOf(a as typeof RANKS[number])>=RANKS.indexOf(b as typeof RANKS[number])?`${a}${b}`:`${b}${a}`;
  const canonical=`${ordered}${suffix}`;
  const spoken=sayHolding(canonical,'NLH');
  return spoken?{key:canonical.toLowerCase(),spoken}:null;
}

/** Conservative actor/action binding, not entity presence mistaken for agency. */
export function captionFact(b: PostBrief): CaptionFact | null {
  if ((b.kind !== 'video' && b.kind !== 'link') || b.isQuestion) return null;
  const titleForGuards = b.title.replace(/[\u2018\u2019]/g,"'");
  if (/\b(?:not|never|didn't|doesn't|don't|isn't|wasn't|weren't|won't|can't|cannot|could|would|should|might)\b/i.test(titleForGuards)) return null;
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
    const context = pokerVideoContextFact(b.title);
    if (context) return context;
  }
  const people = b.people.filter(person=>publicFigureDomain(person)===b.domain);
  if (people.length !== 1) return null;
  const person = people[0]!;
  // The extractor can retain a surname alongside its canonical full name.
  // A genuinely different additional person still makes actor binding unsafe.
  if (b.people.some(p=>!person.toLowerCase().includes(p.toLowerCase()))) return null;
  if (publicFigureDomain(person) !== b.domain || !b.title.toLowerCase().includes(person.toLowerCase())) return null;
  if (/\b(?:not|never|didn't|doesn't|could|would|should|might|can|watches|reacts|against|versus|vs)\b/i.test(b.title)) return null;
  const actor = escape(person);
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
  'all_in_context:ranges': ['the ranges involved', 'the hands reaching the all-in', 'the possible opposing holdings', 'the ranges rather than the result'],
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
export function captionVoiceProfile(style: StyleSheet) {
  return {
    version: 1,
    speech: style.captionSyntax,
    intent: fleetHash(style.profileId,'voice-intent:v1') % 6,
    preface: fleetHash(style.profileId,'voice-preface:v1') % 8,
    contrast: fleetHash(style.profileId,'voice-contrast:v1') % 4,
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
      key, fleetHash(style.profileId, `voice-focus:${key}`) % values.length,
    ])),
    questions: Object.fromEntries(Object.entries(ANGLES).map(([family, angles])=>[
      family, angles.map(a=>fleetHash(style.profileId, `voice-question:${family}`) % a.variants('subject').filter(t=>t.endsWith('?')).length),
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
  const question = questions[plan.questions[family]?.[ANGLES[family].findIndex(a=>a.key===angle.key)] ?? 0]!;
  const judgement = style.slang === 'none' ? 'assessment' : style.slang === 'heavy' ? 'read' : 'take';
  const aJudgement = `${judgement === 'assessment' ? 'an' : 'a'} ${judgement}`;
  const relation = judgement === 'assessment' ? 'of' : 'on';
  const intent = {
    first: ["I'd start with", 'I want to check', 'I would look at', 'My starting point is', "I'm interested in", "I'd begin with"],
    impersonal: ['Start with', 'The starting point is', 'The useful context is', 'First, consider', 'Begin with', 'The focus belongs on'],
    second: ['Start with', 'Look at', 'Check', 'Consider', 'Put the focus on', 'Go back to'],
    plural: ["We'd start with", 'We should check', 'We can look at', 'Our starting point is', 'We need to consider', "We'd begin with"],
  }[style.voice][plan.intent]!;
  const starting = `${intent} ${focus} for ${fact.subject}`;
  const preface = [
    `Before judging ${fact.subject}`, `Before settling on ${aJudgement} ${relation} ${fact.subject}`,
    `To get a read on ${fact.subject}`, `For a closer look at ${fact.subject}`,
    `When assessing ${fact.subject}`, `Before deciding about ${fact.subject}`,
    `To understand ${fact.subject}`, `For context on ${fact.subject}`,
  ][plan.preface]!;
  const contrast = [
    `The result alone doesn't settle ${fact.subject}`,
    `A result isn't the whole story with ${fact.subject}`,
    `I'd separate the outcome from the reasoning behind ${fact.subject}`,
    `There's more than the outcome to consider with ${fact.subject}`,
  ][plan.contrast]!;
  const wanting = style.voice === 'plural' ? `we'd want` : style.voice === 'impersonal' ? 'the missing context is' : style.voice === 'second' ? 'consider' : "I'd want";
  // Typed clauses, not arbitrary word reordering: a question has a question
  // slot, a noun phrase has a noun slot, and an imperative stays complete.
  const structures = [
    question,
    starting,
    `${preface}, ${wanting} ${focus}`,
    `For ${fact.subject}, the discussion starts with ${focus}`,
    `${contrast}. ${question}`,
    `Hard to judge ${fact.subject} without ${focus}`,
    `${question} ${starting}`,
    `For ${aJudgement} ${relation} ${fact.subject}, put ${focus} first`,
    `I'd separate the outcome of ${fact.subject} from ${focus}`,
    `What would ${focus} add to ${aJudgement} ${relation} ${fact.subject}?`,
    `${starting}. ${question}`,
    `${aJudgement.charAt(0).toUpperCase() + aJudgement.slice(1)} ${relation} ${fact.subject} needs context: ${focus}`,
  ];
  let text = structures[style.captionSyntax % structures.length]!;
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
  if (style.length === 'terse' || style.length === 'short') text = compact[style.captionSyntax % compact.length]!;
  // A stable contraction register is grammatical variation, not random noise.
  if (!style.contractions) text = text.replace(/I'd\b/g, 'I would').replace(/I'm\b/g, 'I am');
  const reference = fact.action === 'river_call' ? 'that call'
    : fact.action === 'river_fold' || fact.action === 'fold' ? 'that fold'
      : fact.action === 'bluff' ? 'that bluff' : fact.action === 'three' ? 'that shot'
        : fact.action === 'dunk' ? 'that finish' : fact.action === 'bracelet' ? 'that win'
          : fact.action === 'pot_contribution' ? 'that contribution' : fact.action === 'pot_context' ? 'that pot'
            : fact.action === 'all_in_context' ? 'that all-in' : fact.action === 'river_context' ? 'that river' : 'that decision';
  return {
    text,
    subject: fact.subject,
    reference,
    statement: alternatives[1]!.replace(fact.subject, reference),
    semanticKey: `meaning:subject:${(fact.identity ?? fact.person).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}:${fact.action}:${angle.key}`,
    grounding: [fact.person ? `actor:${fact.person}` : `context:${fact.identity}`, `title_action:${fact.action}`, `angle:${angle.key}`],
  };
}
