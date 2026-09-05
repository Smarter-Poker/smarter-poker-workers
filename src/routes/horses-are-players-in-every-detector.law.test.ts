import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HORSES ARE PLAYERS IN EVERY DETECTOR (CLAUDE.md 10.5)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim, 2026-08-27: "HORSES ARE NEVER EVER DISCLUDED BY DESIGN ON
 * ANYTHING! THEY MUST ALWAYS BE TREATED LIKE REAL LIVE PLAYERS!" 10.5 spells
 * out that a horse "IS SUBJECT TO every rule a human is subject to - nit/VPIP
 * eviction, limits, guards, integrity checks" and "IS NEVER silently filtered
 * out of a report".
 *
 * WHY THIS FILE IS IN THE WORKERS REPO. The law was pinned by four tests in
 * Club Arena - spinLeaderboards, drainProtectsEveryHand, horsesAreTreatedIdentically,
 * prizePoolCountsHorses - and by nothing here. Phase 5 spans both repos, and on
 * 2026-09-01 the violation landed in this one: collusion-scan grew a lookup
 * that dropped every finding where both players were horses. It ran for three
 * days, suppressed every finding it produced, and the daily horse audit
 * stopped on 2026-09-04 to ask which rule won. There was only ever one rule.
 * An unenforced law in a second repo is not a law, it is a preference.
 *
 * WHAT IS STILL ALLOWED, because 10.5 says so explicitly: identification
 * (surfacing the flag as data, or the plumbing that creates, seats, funds and
 * steers the fleet) and the horse's input device. HorseSocialEngine picking a
 * friend request target is identification - it denies a horse nothing a human
 * gets. So this law is scoped to the DETECTORS, where an exclusion means a
 * horse escapes a check a human would face.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

// Every integrity detector in this repo. A new one belongs on this list; a
// detector nobody added here is the gap that let the last one through.
const DETECTORS = [
  'collusion-scan.ts',
  'anti-cheat-bot-timing.ts',
  'anti-cheat-chip-dump.ts',
  'anti-cheat-multi-account.ts',
];

/** Source with comments stripped: the law is about code, and the explanation
 *  of why the filter was wrong necessarily mentions the filter. */
function codeOf(file: string): string {
  const path = resolve(HERE, file);
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('horses are players in every detector', () => {
  it('every detector on the list exists (a renamed file must not silently leave)', () => {
    for (const file of DETECTORS) {
      expect(existsSync(resolve(HERE, file)), `${file} is listed but missing`).toBe(true);
    }
  });

  it.each(DETECTORS)('%s does not branch on is_horse', (file) => {
    const code = codeOf(file);
    expect(code, `${file} reads the is_horse column`).not.toMatch(/['"`]is_horse['"`]/);
    expect(code, `${file} branches on a horse flag`).not.toMatch(/\bisHorse\b/);
  });

  it.each(DETECTORS)('%s does not look a player up in profiles to decide whether to keep them', (file) => {
    // The shape the retired filter used: read profiles, then drop findings.
    // Naming the shape rather than the column catches the next spelling of it.
    const code = codeOf(file);
    const readsProfiles = /from\(\s*['"`]profiles['"`]\s*\)/.test(code);
    if (!readsProfiles) return;
    expect(
      /horse/i.test(code),
      `${file} joins profiles and mentions horses - if that is an exclusion it is a 10.5 violation; ` +
        'if it is identification, say so here and narrow this law rather than deleting it',
    ).toBe(false);
  });

  it('collusion-scan says out loud that it filters nobody by identity', () => {
    // Not decoration. PHASE5-CONTRACTS section 0 rule 3 requires a queue to say
    // what it filtered and why, and the honest answer here has to stay "nothing".
    const raw = readFileSync(resolve(HERE, 'collusion-scan.ts'), 'utf8');
    expect(raw).toMatch(/identity_filtered:\s*false/);
    expect(raw).toMatch(/CLAUDE\.md 10\.5/);
  });
});
