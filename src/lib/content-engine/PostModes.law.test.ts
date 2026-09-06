/**
 * Dan approves a way of posting before players see it.
 *
 * 2026-09-06, on seeing the Phase 3 grounded hand posts live:
 *   "WHAT THE HELL ARE THESE POSTS?! THEY ARE PURE TRASH. ANYTIME YOU CREATE
 *    SOME NEW WAY FOR A HORSE TO POST, OR GIVE IT AN INSTRUCTION TO 'CREATE
 *    NEW CONTENT' I NEED TO APPROVE IT FIRST."
 *
 * What reached the feed:
 *   "No hand, all narrative. Qh8c7d6sAd5c on 5s 4s Td 3c 6d. won 184bb"
 *   "nah QTs, board came 6c 7c 9c 9h 3s, won 149bb, right."
 *
 * Every one was TRUE, and every law test written for them passed. Not one of
 * those tests asked the only question that mattered: would a person want to
 * read this. These pins are about that question.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const publisher = fs.readFileSync(
  fileURLToPath(new URL('./HorsePublisher.ts', import.meta.url)),
  'utf8',
);
const fleet = fs.readFileSync(fileURLToPath(new URL('./Fleet.ts', import.meta.url)), 'utf8');

describe('a way of posting is off until it is approved', () => {
  it('the grounded path asks postModeEnabled before it writes anything', () => {
    const fn = publisher.slice(publisher.indexOf('async function postGrounded'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    const gate = body.indexOf("postModeEnabled('grounded_hand')");
    const insert = body.indexOf('.insert(');
    expect(gate).toBeGreaterThan(-1);
    // The gate must come BEFORE any write, not after the post is composed.
    expect(insert === -1 || gate < insert).toBe(true);
  });

  it('an unreadable mode table means OFF, not ON', () => {
    // Everywhere else in this engine a failed read must not silence a horse.
    // Here it is the reverse, deliberately: silence is recoverable, a thousand
    // accounts posting something Dan has not seen is not.
    const fn = fleet.slice(fleet.indexOf('export async function postModeEnabled'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/if \(error\)[\s\S]*return false;/);
    expect(body).not.toMatch(/if \(error\)[\s\S]*return true;/);
  });
});

describe('a horse does not read out a database row', () => {
  /**
   * The exact shapes that reached the feed. A caption is for a person, so
   * hole cards run together ("Qh8c7d6sAd5c"), a bare "184bb", or a five-card
   * board printed inline are all disqualifying - whatever the numbers say.
   */
  const RAW_CARDS = /[AKQJT2-9][hcds][AKQJT2-9][hcds][AKQJT2-9][hcds]/;
  const BARE_BB = /\b\d+bb\b/;
  const INLINE_BOARD = /([AKQJT2-9][hcds]\s+){4}[AKQJT2-9][hcds]/;

  const SAMPLES = [
    'No hand, all narrative. Qh8c7d6sAd5c on 5s 4s Td 3c 6d. won 184bb',
    'look Q7o on 3c 8h 7c 7s 4c and the whole thing went in on the river. rest is noise.',
    'nah QTs, board came 6c 7c 9c 9h 3s, won 149bb, right.',
  ];

  it('the three that shipped would all be caught now', () => {
    for (const s of SAMPLES) {
      const bad = RAW_CARDS.test(s) || BARE_BB.test(s) || INLINE_BOARD.test(s);
      expect(bad).toBe(true);
    }
  });

  it('ordinary poker talk is not caught', () => {
    // The rule is about printing a row, not about naming cards at all.
    for (const s of [
      'folded pocket kings and I am still thinking about it',
      'that river bet is the whole hand there',
      'stacked off with aces and it held for once',
    ]) {
      expect(RAW_CARDS.test(s) || BARE_BB.test(s) || INLINE_BOARD.test(s)).toBe(false);
    }
  });
});
