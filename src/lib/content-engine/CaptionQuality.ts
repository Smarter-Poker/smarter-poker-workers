/** Free, bounded caption checks. History affects ranking, never factual freshness. */
const words = (text: string) => text.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
const STOP = new Set('a an the that those this these i id would we you my our for of on in to with and or is are be it its before about at as from'.split(' '));

export interface CaptionQualityOptions { subject?: string }

/** A rhetorical skeleton, not a semantic identity or a publication veto. */
export function captionShape(text: string, options: CaptionQualityOptions = {}): string {
  let value = text.toLowerCase().replace(/[’]/g, "'");
  if (options.subject) value = value.split(options.subject.toLowerCase().replace(/[’]/g, "'")).join(' subject ');
  value = value.replace(/\b(?:i'd|i would|we'd|we would)\b/g, 'speaker would')
    .replace(/\b(?:my|our)\b/g, 'speaker')
    .replace(/\b(?:assessment|read|take|verdict|conclusions?)\b/g, 'judgment')
    .replace(/\b(?:look at|examine|check|consider|discuss)\b/g, 'examine')
    .replace(/\b(?:starting point|start|begin|focus)\b/g, 'focus')
    .replace(/\b(?:opposing ranges|opposing combinations|value combinations|effective stacks|stack depth|pot odds|payout structure|payout schedule|pitch sequence|at bat context|buildup to the goal|setup before the finish)\b/g, 'context')
    .replace(/\$?[0-9]+(?:[.,/][0-9]+)*/g, 'quantity');
  const tokens = words(value);
  // Bound the shape to its opening grammar and punctuation rhythm. Proper
  // source details farther down must not make a stock opening look novel.
  return `${tokens.slice(0, 5).join(' ')}|${text.includes('?') ? 'question' : 'statement'}|${Math.min(3, text.split(/[.!?\n]+/).filter(x => x.trim()).length)}`;
}

export function captionQuality(text: string, options: CaptionQualityOptions = {}) {
  const reasons: string[] = [];
  const tokens = words(text);
  if (!tokens.length) reasons.push('empty');
  if (tokens.length > 160) reasons.push('caption_too_long');
  if (options.subject) {
    const subject = words(options.subject).join(' ');
    const normalized = tokens.join(' ');
    if (subject && normalized.split(subject).length > 2) reasons.push('repeated_source_subject');
    // Compound guarantee frames previously repeated the event noun in the
    // fact, the focus and a typed reference despite mentioning the full
    // source phrase only once. Permit a necessary two-way distinction,
    // refuse the observed circular three-or-more rendering.
    if (/\bguarantee\b/.test(subject) && tokens.filter(token => token === 'guarantee').length >= 3) reasons.push('circular_event_focus');
    // A published prize-pool minimum has terms, not an already realized
    // outcome. Do not apply this restriction to actual hand/sports results.
    // Remove the source itself first: an event name can contain "Result".
    if (/\bguarantee\b/.test(subject) && /\b(?:outcome|result)\b/.test(normalized.split(subject).join(' '))) reasons.push('guarantee_realized_result');
  }
  const phrases = new Set<string>();
  for (let i = 0; i + 5 <= tokens.length; i++) {
    const slice = tokens.slice(i, i + 5);
    if (slice.filter(token => !STOP.has(token)).length < 2) continue;
    const key = slice.join(' ');
    if (phrases.has(key)) { reasons.push('repeated_phrase'); break; }
    phrases.add(key);
  }
  const ideas = text.split(/[.!?\n]+/).map(sentence => new Set(words(sentence
    .replace(/\b(?:pot odds|price being offered|price relative to the pot|equity required by the price)\b/gi, 'price')
    .replace(/\b(?:opposing ranges|opposing combinations|hands in the opposing ranges)\b/gi, 'ranges'))
    .filter(token => !STOP.has(token) && token.length > 2))).filter(set => set.size >= 4);
  for (let i = 0; i < ideas.length; i++) for (let j = i + 1; j < ideas.length; j++) {
    const a = ideas[i]!, b = ideas[j]!;
    const common = [...a].filter(token => b.has(token)).length;
    if (common / new Set([...a, ...b]).size >= .8) reasons.push('repeated_idea');
  }
  // A repeated question can use different words and defeat n-grams. These
  // narrowly authored equivalences describe the SAME consideration, not a
  // blanket synonym soup that would collapse distinct ranges/size angles.
  const focusFamilies = [
    /\b(?:pot odds|price being offered|equity required by the price|price relative to the pot)\b/i,
    /\b(?:effective stacks|stack depth in big blinds|available stack depth)\b/i,
    /\b(?:payout schedule|wider payout structure|distribution around the top prize)\b/i,
  ];
  const sentences = text.split(/[.!?\n]+/).filter(sentence => sentence.trim());
  if (focusFamilies.some(pattern => sentences.filter(sentence => pattern.test(sentence)).length > 1)) reasons.push('repeated_focus');
  if (/\b(?:reading from|(?:news|espn|pokernews|poker\.org) reports):?/i.test(text)) reasons.push('headline_wrapper');
  return { pass: reasons.length === 0, reasons: [...new Set(reasons)], shapeKey: captionShape(text, options) };
}

/** Soft recent-shape pressure. A finite grammar is never globally forbidden. */
export function captionConvergencePenalty(candidate: string, recent: readonly string[], options: CaptionQualityOptions = {}): number {
  const sample = recent.slice(0, 48);
  if (!sample.length) return 0;
  const key = captionShape(candidate, options);
  return sample.filter(text => captionShape(text, options) === key).length / sample.length;
}
