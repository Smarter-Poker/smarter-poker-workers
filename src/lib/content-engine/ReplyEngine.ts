/**
 * ReplyEngine: when a horse answers, and when it lets a thread end.
 *
 * WHY (Dan, 2026-09-05): "A DETERMINISTIC ENGINE THAT CAN REPLY TO THE REPLIES
 * (WHEN NEEDED, NOT AN ENDLESS STREAM OF CONVERSATION ON A POST)."
 *
 * The old `replyToComments` picked a random top-level comment and answered it
 * with one of five hardcoded prefixes ("fr tho", "this ^^"). It had no notion
 * of who said what to whom, so it could not tell an unanswered human from a
 * horse it had already replied to twice. The only thing stopping an infinite
 * chain was that it refused to read nested replies at all, which also meant a
 * human who answered a horse was never answered back.
 *
 * THE RULES, in priority order.
 *
 *   1. A HUMAN ALWAYS GETS EXACTLY ONE ANSWER. If a human replied to this
 *      horse and the horse has not answered that reply, it answers, once.
 *      This is the whole point of the feature: a person who says something
 *      gets a response, and does not get pestered afterwards.
 *   2. A horse answers another horse only for a REASON: it was addressed by
 *      alias, it was asked a question, or the reply disagrees with the claim
 *      in its own comment.
 *   3. HARD CEILINGS. At most MAX_TURNS_PER_HORSE replies from one horse in
 *      one thread, and at most MAX_HORSE_TURNS horse turns in a thread
 *      whoever they come from. A conversation between two horses cannot run
 *      past a handful of lines however interesting the machinery finds it.
 *   4. Nothing at all after THREAD_COOLDOWN_HOURS: an old thread that gets a
 *      new horse reply reads as a bot patrolling history.
 *
 * Every decision is a pure function of the thread's rows, so a run can be
 * replayed and the reason is always nameable in the log.
 */

export const MAX_TURNS_PER_HORSE = 2;
export const MAX_HORSE_TURNS = 3;
export const THREAD_COOLDOWN_HOURS = 48;

export interface ThreadComment {
  id: string;
  post_id: string;
  parent_id: string | null;
  author_id: string;
  content: string;
  created_at: string;
  /** Is the author one of ours? */
  isHorse: boolean;
}

export type ReplyReason = 'human_unanswered' | 'addressed' | 'question' | 'disagreement';

export interface ReplyDecision {
  reply: boolean;
  reason?: ReplyReason;
  /** The comment being answered. */
  target?: ThreadComment;
  /** Why we are NOT replying, for the run log. */
  skipped?:
    | 'no_incoming'
    | 'already_answered'
    | 'horse_turn_cap'
    | 'thread_turn_cap'
    | 'thread_too_old'
    | 'no_reason';
}

const QUESTION = /\?\s*$|^(what|why|how|when|where|who|which|do|does|did|is|are|would|should|could|can)\b/i;

const DISAGREEMENT = new RegExp(
  [
    '\\bdisagree\\b', '\\bwrong\\b', '\\bnot really\\b', '\\bnah\\b', '\\bno chance\\b',
    '\\bhard disagree\\b', '\\bthat is not\\b', '\\bthats not\\b', '\\bactually\\b',
    '\\bi doubt\\b', '\\bnot sure about\\b', '\\bterrible take\\b', '\\bbad take\\b',
    '\\bmiss(ing|ed)? the point\\b', '\\byou are wrong\\b',
  ].join('|'),
  'i',
);

/** Does this text address the horse by its alias? */
export function addressesAlias(text: string, alias: string | null | undefined): boolean {
  const handle = (alias ?? '').trim();
  if (!handle) return false;
  const re = new RegExp(`(^|[^a-z0-9_])@?${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return re.test(text);
}

export function isQuestion(text: string): boolean {
  return QUESTION.test(text.trim());
}

export function isDisagreement(text: string): boolean {
  return DISAGREEMENT.test(text);
}

/**
 * Should `horseId` reply in this thread, and to what?
 *
 * `thread` is every comment on the post, in any order. `myAlias` is the
 * horse's social handle, used to notice being addressed.
 */
export function decideReply(
  horseId: string,
  myAlias: string | null | undefined,
  thread: ThreadComment[],
  now: Date = new Date(),
): ReplyDecision {
  const mine = thread.filter((c) => c.author_id === horseId);
  if (!mine.length) return { reply: false, skipped: 'no_incoming' };

  // Ceilings first: cheapest checks, and they end the conversation.
  const myReplies = mine.filter((c) => c.parent_id !== null);
  if (myReplies.length >= MAX_TURNS_PER_HORSE) return { reply: false, skipped: 'horse_turn_cap' };
  const horseTurns = thread.filter((c) => c.isHorse && c.parent_id !== null).length;
  if (horseTurns >= MAX_HORSE_TURNS) return { reply: false, skipped: 'thread_turn_cap' };

  const myIds = new Set(mine.map((c) => c.id));
  // Everything said in answer to something this horse wrote.
  const incoming = thread
    .filter((c) => c.parent_id && myIds.has(c.parent_id) && c.author_id !== horseId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (!incoming.length) return { reply: false, skipped: 'no_incoming' };

  // Already answered? One answer per incoming comment, ever.
  const answered = new Set(
    thread.filter((c) => c.author_id === horseId && c.parent_id).map((c) => c.parent_id!),
  );

  const cutoff = now.getTime() - THREAD_COOLDOWN_HOURS * 3_600_000;
  const fresh = incoming.filter((c) => new Date(c.created_at).getTime() >= cutoff);
  if (!fresh.length) return { reply: false, skipped: 'thread_too_old' };

  // Rule 1: an unanswered human wins over everything.
  const human = fresh.find((c) => !c.isHorse && !answered.has(c.id));
  if (human) return { reply: true, reason: 'human_unanswered', target: human };

  // Rule 2: another horse needs a reason.
  for (const c of fresh) {
    if (answered.has(c.id)) continue;
    if (addressesAlias(c.content, myAlias)) return { reply: true, reason: 'addressed', target: c };
    if (isQuestion(c.content)) return { reply: true, reason: 'question', target: c };
    if (isDisagreement(c.content)) return { reply: true, reason: 'disagreement', target: c };
  }

  const anyUnanswered = fresh.some((c) => !answered.has(c.id));
  return { reply: false, skipped: anyUnanswered ? 'no_reason' : 'already_answered' };
}

/** The Composer's reason parameter, from ours. */
export function composerReason(r: ReplyReason): 'addressed' | 'question' | 'disagreement' {
  if (r === 'question') return 'question';
  if (r === 'disagreement') return 'disagreement';
  return 'addressed';
}
