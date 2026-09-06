/**
 * Phase 1 to 4 recertification pins, written from production output on
 * 2026-09-06. These are acceptance tests for the failures that green unit
 * tests missed: unsafe fallbacks, sentence fragments treated as people,
 * replies sampled away, and one approval gate enabling two content modes.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { briefForAsset } from './PostBrief.js';
import { composeCaption, relevanceOf, RELEVANCE_FLOOR } from './Composer.js';
import { styleSheetFor } from './StyleSheet.js';
import { fleetHash } from './FleetScheduler.js';

const source = (name: string) => fs.readFileSync(
  fileURLToPath(new URL(`./${name}`, import.meta.url)),
  'utf8',
);

function fleetIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const a = fleetHash(String(i), 'recert-a').toString(16).padStart(8, '0');
    const b = fleetHash(String(i), 'recert-b').toString(16).padStart(8, '0');
    return `${a}-${b.slice(0, 4)}-4${b.slice(4, 7)}-8${a.slice(1, 4)}-${b}${a.slice(0, 4)}`;
  });
}

describe('captions read like a person sharing the actual item', () => {
  const titles = [
    ['poker', 'Uploading to YouTube CHANGED my life'],
    ['sports', 'He pulled out the backflip at the end'],
    ['sports', "George Lombard Jr.'s parents were jumping for joy"],
    ['sports', 'Dillon the Villain staying in Phoenix'],
    ['poker', 'Daniel Negreanu is literally trying to give his money away'],
    ['sports', 'Who had the best dunk? DUNKMAN IS BACK TUESDAY'],
  ] as const;
  const forbidden = [
    /still thinking about/i,
    /deserves more attention/i,
    /again with the sound off/i,
    /anyone else watch/i,
    /nobody in the building blinked/i,
    /the box score will not show/i,
    /looked routine at full speed/i,
  ];

  it('the malformed production templates cannot recur', () => {
    for (const [domain, title] of titles) {
      const brief = briefForAsset({ kind: 'video', title, domainHint: domain });
      for (const id of fleetIds(80)) {
        const caption = composeCaption(brief, styleSheetFor(id)).text;
        for (const pattern of forbidden) expect(caption).not.toMatch(pattern);
        expect(caption).not.toMatch(/\.\.\?$/);
        expect(caption).not.toMatch(/\.\?$/);
      }
    }
  });

  it('an unsupported topic stays silent instead of receiving a generic wrapper', () => {
    for (const [domain, title] of titles.slice(0, 5)) {
      const brief = briefForAsset({ kind: 'video', title, domainHint: domain });
      const captions = fleetIds(80).map((id) => composeCaption(brief, styleSheetFor(id)).text);
      expect(captions.every((caption) => caption === '')).toBe(true);
    }
  });

  it('a supported concept earns a real take instead of a headline wrapper', () => {
    const [domain, title] = titles[5]!;
    const brief = briefForAsset({ kind: 'video', title, domainHint: domain });
    const captions = fleetIds(80).map((id) => composeCaption(brief, styleSheetFor(id)).text);
    expect(captions.filter((caption) => caption.includes(':')).length).toBe(0);
    for (const caption of captions) expect(relevanceOf(caption, brief)).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
  });
});

describe('quality controls fail closed', () => {
  it('the fleet kill switch treats an unreadable control table as OFF', () => {
    const fleet = source('Fleet.ts');
    const fn = fleet.slice(fleet.indexOf('export async function engineEnabled'));
    expect(fn).toMatch(/if \(error \|\| !data\)[\s\S]*return false;/);
    expect(fn).not.toMatch(/error \|\| !data \? true/);
  });

  it('same-post semantic duplicates are checked and recorded', () => {
    const writer = source('VoiceWriter.ts');
    const social = source('HorseSocialEngine.ts');
    expect(writer).toMatch(/phraseUsedOnPost\(draft\.semanticKey, postId\)/);
    expect(writer).toMatch(/composeComment\(brief, style, variant\)[\s\S]*post\.postId/);
    expect(social).toMatch(/recordPhrase\(written\.semanticKey, horse\.profile_id, post\.id\)/);
  });

  it('below-floor or repeated drafts are never inserted as empty-quality posts', () => {
    const writer = source('VoiceWriter.ts');
    const fallback = writer.slice(writer.indexOf('// Nothing cleared both gates'));
    expect(fallback.slice(0, 700)).toMatch(/text: ''/);

    const publisher = source('HorsePublisher.ts');
    expect(publisher.match(/No fresh caption cleared the quality gate/g)).toHaveLength(2);
  });
});

describe('the promised reply contract is actually wired', () => {
  const social = source('HorseSocialEngine.ts');

  it('loads aliases and the whole 48-hour decision window', () => {
    expect(social).toMatch(/select\('id, name, alias, profile_id, voice, timezone'\)/);
    expect(social).toMatch(/48 \* 3_600_000/);
    expect(social).toMatch(/\.range\(from, from \+ 999\)/);
  });

  it('never samples away a mandatory human reply', () => {
    expect(social).toMatch(/if \(reason !== 'human_unanswered'\)[\s\S]*Math\.random\(\) > activityRate/);
  });

  it('records the inserted reply id and its real turn number', () => {
    expect(social).toMatch(/commentId: insertedReply\?\.id \?\? null/);
    expect(social).toMatch(/turnIndex: decided\.turnIndex/);
  });
});

describe('approval scope cannot leak between grounded modes', () => {
  const publisher = source('HorsePublisher.ts');

  it('checks hands and sessions independently before composition', () => {
    const fn = publisher.slice(publisher.indexOf('async function postGrounded'));
    expect(fn).toMatch(/postModeEnabled\('grounded_hand'\)/);
    expect(fn).toMatch(/postModeEnabled\('grounded_session'\)/);
    expect(fn).toMatch(/writeGrounded\([\s\S]*\{ hand: handEnabled, session: sessionEnabled \}/);
  });
});
