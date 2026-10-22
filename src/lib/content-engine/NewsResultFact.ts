import type { CaptionFact } from './CaptionVoice.js';
import type { PostBrief } from './PostBrief.js';

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Explicit public names retained from the source snapshot. Capitalisation,
// URL text and heuristic proper nouns never expand this registry.
const ACTORS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Aaron Barone', ['Aaron Barone']], ['Grantas Naujokas', ['Grantas Naujokas']],
  ['Joe Hachem', ['Joe Hachem']], ['Marius Conan', ['Marius Conan']],
  ['Adrian Mateos', ['Adrian Mateos']], ['Vitalijs Zavorotnijs', ['Vitalijs Zavorotnijs']],
  ['Joey Weissman', ['Joey Weissman']], ['Nicholas Palma', ['Nicholas Palma', 'Nick Palma']],
  ['Myles Mullaly', ['Myles Mullaly']], ['Robert Gianquitti', ['Robert Gianquitti']],
  ['Brandon Wilson', ['Brandon Wilson']], ['Bryan Taylor', ['Bryan Taylor']],
  ['Keith Lehr', ['Keith Lehr']], ['Jeremy Ausmus', ['Jeremy Ausmus']],
  ['Justin Vaysman', ['Justin Vaysman']], ['Ivelin Kolev', ['Ivelin Kolev']],
  ['Shawn Murphy', ['Shawn Murphy']], ['Sam Chartier', ['Sam Chartier']],
  ['Umut Ozturk', ['Umut Ozturk']],
];
const EVENTS = [
  'PokerNews Online Championship', 'Kings of Tallinn', 'Victorian Poker Championship',
  '888LIVE London Main Event', 'Poker Masters', 'WSOP Circuit Pompano Beach Main Event',
  'Super High Roller Bowl XI', '888LIVE London High Roller',
  'WPT Prime Cyprus Champions', 'RGPS Houston $600 Main Event',
  'MSPT Canadian Poker Championship',
] as const;
const ordinal = '(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|[1-9][0-9]?(?:st|nd|rd|th))';
const money = '(?:\\d+|\\d{1,3}(?:,\\d{3})+)(?:\\.\\d+)?';

function report(identity: string, subject: string): CaptionFact {
  return { person: '', action: 'news_report_context', identity, subject };
}

// Compile once: each source is considered by six drafts for many authors.
const WIN_RULES = ACTORS.flatMap(([actor, aliases]) => EVENTS.map(event => {
  const name = `(?:${aliases.map(escape).join('|')})`;
  const tournament = escape(event);
  const patterns = [
    `(?:888's )?${name} (?:wins |takes home (?:the )?)${tournament}(?: title| event(?: no\\. [1-9][0-9]?)?)?(?: \\(£${money}\\)| for \\$${money}(?: million|[mk])?)?`,
    `${name} (?:secures|scores) ${ordinal} PGT (?:title|trophy) at ${tournament}(?:, leads race for purple jacket)?`,
    `${name} opens 2026 ${tournament} with ${ordinal} PGT title`,
    `${name} joins poker royalty with ${tournament} title`,
    `${name} back in the winner's circle at ${tournament}`,
    `${name} wins ${tournament} title after three money bubbles`,
    `${name} captures ${tournament} event no\\. [1-9][0-9]? title`,
    `${name} wins ${tournament} event #[1-9][0-9]? for ${ordinal} PGT title`,
    `${name} locks up ${ordinal} PGT trophy at (?:2026 )?${tournament}`,
    `${name} comes back from (?:0\\.25|[1-9][0-9]?) big blinds to win a ${tournament} title`,
    `${name} mounts chip-and-a-chair comeback to win ${ordinal} PGT title at ${tournament}`,
    `${name} dominates day [1-9] to win ${tournament} for \\$${money}`,
    `${name} wins ${tournament} at Playground for largest-ever score on home soil`,
  ];
  if (event === '888LIVE London High Roller') patterns.push(`London proves ${name}'s (?:"Lucky Charm"|Lucky Charm) on his way to the 888LIVE High Roller title`);
  return {
    pattern: new RegExp(`^(?:${patterns.join('|')})$`, 'i'),
    identity: `news:win:actor:${key(actor)}:event:${key(event)}`,
    subject: `${actor}'s ${event} win`,
  };
}));
const EXTENSIONS = [
  ['Thunder', 'Wallace', new RegExp(`^Thunder agree to [1-9]-year, \\$${money}[mk] extension with guard Wallace$`, 'i')],
  ['Suns', 'Ighodaro', new RegExp(`^Suns, center Ighodaro agree to [1-9]-year, \\$${money}[mk] extension$`, 'i')],
] as const;

/** Closed literal outcomes/actions; never a general headline attribution. */
export function newsResultFact(b: PostBrief, title: string): CaptionFact | null {
  if (b.kind !== 'link' || b.isQuestion || /[?]|\b(?:not|never|didn't|doesn't|don't|isn't|wasn't|weren't|won't|can't|cannot|could|would|should|might|may|if|unless|denies|rumou?r)\b/i.test(title)) return null;
  if (b.domain === 'poker') {
    // Career PGT ordinals and event numbers coalesce to actor/event. This
    // deliberately merges separate wins when a headline omits detail.
    const win = WIN_RULES.find(rule => rule.pattern.test(title));
    if (win) return report(win.identity, win.subject);
    if (/^Umut Ozturk Conquers FireKeepers For Second MSPT Main Event Title Of 2026$/i.test(title))
      return report('news:win:actor:umut ozturk:event:mspt firekeepers main event', "Umut Ozturk's MSPT FireKeepers Main Event win");
  }
  if (b.domain === 'sports') {
    // Only source-established team/role/surname bindings. These are report
    // contexts, not invented full names, recovery timelines or diagnoses.
    for (const [team, actor, pattern] of EXTENSIONS) if (pattern.test(title)) {
      return report(`news:contract_extension:team:${key(team)}:actor:${key(actor)}`, `the ${team} agreement on a contract extension with ${actor}`);
    }
    if (/^Kings guard Simmons has torn Achilles tendon, will undergo surgery$/i.test(title)) {
      return report('news:injury:team:kings:actor:simmons:injury:torn achilles tendon', "Kings guard Simmons's torn Achilles tendon and planned surgery");
    }
    if (/^Warriors'? Curry (?:'fine'|fine) after tweaking right ankle in practice$/i.test(title)) {
      return report('news:ankle_practice_update:team:warriors:actor:curry', "the Warriors' report that Curry is 'fine' after tweaking his right ankle in practice");
    }
  }
  return null;
}
