/**
 * FriendGraph: who a horse actually knows.
 *
 * WHY (Dan, 2026-09-05): "HORSES NEED TO BE ADDING AND TAGGING OTHER HORSES IN
 * POSTS THAT THEY ARE FRIENDS WITH. BUT NOT EVERY HORSE SHOULD BE FRIENDS WITH
 * EVERY OTHER HORSE, THAT WOULD BE WEIRD AND SUSPICIOUS."
 *
 * A fleet where everyone knows everyone is the single most obvious tell there
 * is: 1,000 accounts with 999 friends each and a fully connected mention
 * graph. Real communities are sparse and clustered - people know the players
 * in their city, at their stakes, in their format, and a handful of others.
 *
 * FRIENDSHIP IS A SYMMETRIC PREDICATE, NOT A TABLE. `areFriends(a, b)` hashes
 * the ORDERED PAIR, so both horses agree without anyone storing a row, and the
 * answer cannot drift when the roster changes. The probability is raised by
 * what the two horses have in common (city, stakes, specialty) and capped, so
 * the graph is clustered by geography and stakes the way a real one is.
 *
 * Degree lands around 8 to 40 per horse and is asserted by the tests, along
 * with symmetry, sparsity (the graph must be nowhere near complete) and
 * clustering (same-city pairs are friends far more often than strangers).
 */
import { fleetHash } from './FleetScheduler.js';

export interface FriendCandidate {
  profile_id: string;
  name?: string;
  alias?: string | null;
  location?: string | null;
  stakes?: string | null;
  specialty?: string | null;
}

/** Base chance any two horses know each other at all. */
const BASE_PER_MILLE = 9;
/** Bonuses, in parts per thousand, for what they have in common. */
const SAME_CITY = 26;
const SAME_STAKES = 12;
const SAME_SPECIALTY = 8;
/** Nobody knows more than this share of the fleet, whatever they share. */
const MAX_PER_MILLE = 60;

function cityOf(loc: string | null | undefined): string {
  return (loc ?? '').split(',')[0]!.trim().toLowerCase();
}

/**
 * Do these two horses know each other? Symmetric, deterministic, no storage.
 */
export function areFriends(a: FriendCandidate, b: FriendCandidate): boolean {
  if (a.profile_id === b.profile_id) return false;
  const [lo, hi] = a.profile_id < b.profile_id
    ? [a.profile_id, b.profile_id]
    : [b.profile_id, a.profile_id];

  let perMille = BASE_PER_MILLE;
  const cityA = cityOf(a.location);
  const cityB = cityOf(b.location);
  if (cityA && cityA === cityB) perMille += SAME_CITY;
  if (a.stakes && a.stakes === b.stakes) perMille += SAME_STAKES;
  if (a.specialty && a.specialty === b.specialty) perMille += SAME_SPECIALTY;
  perMille = Math.min(MAX_PER_MILLE, perMille);

  return fleetHash(`${lo}|${hi}`, 'friend') % 1000 < perMille;
}

/** Everyone in the roster this horse knows. */
export function friendsOf(me: FriendCandidate, fleet: FriendCandidate[]): FriendCandidate[] {
  return fleet.filter((other) => areFriends(me, other));
}

/**
 * The friend this horse would tag on this post, if any.
 *
 * A tag needs a REASON, not a coin flip: someone from the same city, at the
 * same stakes, or who plays the format the post is about. A horse with no
 * plausible friend for this subject tags nobody, which is why the tag rate in
 * the wild is well under the style sheet's nominal rate.
 */
export function tagCandidateFor(
  me: FriendCandidate,
  fleet: FriendCandidate[],
  subject: { domain: string; concepts: string[]; sport?: string },
  seed: string,
): { friend: FriendCandidate; reason: string } | null {
  const friends = friendsOf(me, fleet);
  if (!friends.length) return null;

  const myCity = cityOf(me.location);
  const scored = friends.map((f) => {
    let score = 0;
    let reason = 'friend';
    if (myCity && cityOf(f.location) === myCity) {
      score += 3;
      reason = `same city (${myCity})`;
    }
    if (me.stakes && f.stakes === me.stakes) {
      score += 2;
      if (score === 2) reason = `same stakes (${me.stakes})`;
    }
    // A poker post about a format the friend actually plays is the strongest
    // reason of all to pull them in.
    if (subject.domain === 'poker' && f.specialty) {
      const spec = f.specialty.toLowerCase();
      if (subject.concepts.some((c) => spec.includes(c.replace(/_/g, ' ')))) {
        score += 4;
        reason = `plays ${f.specialty}`;
      }
    }
    return { f, score, reason };
  });

  const best = scored.filter((x) => x.score > 0);
  if (!best.length) return null;
  const top = best.sort((x, y) => y.score - x.score || (x.f.profile_id < y.f.profile_id ? -1 : 1));
  const band = top.filter((x) => x.score === top[0]!.score);
  const chosen = band[fleetHash(seed, 'tagpick') % band.length]!;
  return { friend: chosen.f, reason: chosen.reason };
}

/** How the tag reads in a post. Horse aliases only; never a human. */
export function renderTag(alias: string | null | undefined, lead: string): string | null {
  const handle = (alias ?? '').trim();
  if (!handle) return null;
  return `${lead} @${handle}`;
}
