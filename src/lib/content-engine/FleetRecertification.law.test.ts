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

const routeSource = (name: string) => fs.readFileSync(
  fileURLToPath(new URL(`../../routes/${name}`, import.meta.url)),
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
    // 2026-09-21: the read lives in engineSwitch, which names the reason.
    const read = fleet.slice(fleet.indexOf('export async function engineSwitch'));
    const body = read.slice(0, read.indexOf('\n}\n'));
    expect(body).toMatch(/if \(error \|\| !data\) \{[\s\S]*?state = 'unreadable';/);
    expect(body).toMatch(/catch \(err\) \{[\s\S]*?state = 'unreadable';/);
    expect(fleet).toMatch(/return \(await engineSwitch\(opts\)\) === 'on';/);
  });

  it('the master switch stops every horse social route before any mutation', () => {
    const routes = [
      ['horses-social-all.ts', 'export async function horsesSocialAll', 'likePosts'],
      ['horses-social-friends.ts', 'export async function horsesSocialFriends', 'sendFriendRequests'],
      ['video-library-reels.ts', 'export async function videoLibraryReels', 'getSupabase'],
      ['horse-posts.ts', 'export async function horsePosts', 'loadFleet'],
      ['pokernews-videos.ts', 'export async function pokernewsVideos', 'ingestLatestVideos('],
    ] as const;
    for (const [name, handlerMarker, firstMutation] of routes) {
      const route = routeSource(name);
      const handler = route.slice(route.indexOf(handlerMarker));
      const gate = handler.indexOf('if (!(await engineEnabled()))');
      expect(gate, `${name} is missing the master gate`).toBeGreaterThan(-1);
      expect(
        handler.indexOf(firstMutation),
        `${name} mutates before the master gate`,
      ).toBeGreaterThan(gate);
    }
  });

  it('the publish loop asks the switch again, fresh, before every horse', () => {
    const route = routeSource('horse-posts.ts');
    const loop = route.slice(route.indexOf('const worker = async'));
    const ask = loop.indexOf('await engineSwitch({ fresh: true })');
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(loop.indexOf('publishForHorse('));
  });

  it('the horse-batch shim is gone and nothing registers it', () => {
    const shim = fileURLToPath(new URL('../../routes/horse-by-index.ts', import.meta.url));
    expect(fs.existsSync(shim)).toBe(false);
    const index = fs.readFileSync(fileURLToPath(new URL('../../index.ts', import.meta.url)), 'utf8');
    expect(index).not.toMatch(/app\.(get|post)\('\/cron\/horse(-batch)?\//);
    expect(index).not.toMatch(/routes\/horse-by-index/);
  });

  it('official PokerNews reels cannot fall back to an arbitrary horse author', () => {
    const route = routeSource('pokernews-videos.ts');
    expect(route).not.toMatch(/data: fallback/);
    expect(route).toMatch(/refusing arbitrary attribution/);
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

describe('fleet duplicate protection lives in the database', () => {
  it('every social_posts insert carries the slot key in metadata, never the reserved column', () => {
    const publisher = source('HorsePublisher.ts');
    // Grounded text remains the only direct insert. News and video each write
    // through an atomic RPC, checked below.
    const inserts = publisher
      .split(".from('social_posts')")
      .slice(1)
      .filter((s) => s.trimStart().startsWith('.insert('));
    expect(inserts).toHaveLength(1);
    for (const block of inserts) {
      const body = block.slice(0, block.indexOf('.select('));
      const metadata = body.match(/metadata: \{[\s\S]*?\}/)?.[0] ?? '';
      expect(metadata).toMatch(/publication_key: publicationKey/);
      // social_posts_managed_library_integrity_check reserves the column.
      expect(body.replace(metadata, '')).not.toMatch(/publication_key/);
      // 23505 on the key is a duplicate, handled before any ledger write.
      expect(block.slice(block.indexOf('.maybeSingle();'))).toMatch(
        /^\.maybeSingle\(\);\s+if \(isDuplicateSlot\(error\)\) return \{[^}]*skipped: 'duplicate_slot'/,
      );
    }
  });

  it('the fleet news write delegates its slot and every freshness key to one atomic RPC', () => {
    const publisher = source('HorsePublisher.ts');
    const calls = publisher.split('await publishHorseNewsAtomically({').slice(1);
    expect(calls).toHaveLength(1);
    const call = calls[0]!.slice(0, calls[0]!.indexOf('});'));
    expect(call).toMatch(/publicationKey,/);
    expect(call).toMatch(/assetKey: articleKey/);
    expect(call).toMatch(/phraseNorm: picked\.norm/);
    expect(call).toMatch(/semanticKey: written\.semanticKey/);
    expect(call).toMatch(/brief: written\.brief/);
    expect(publisher).not.toMatch(/recordAssetUse\(key, horse\.profile_id, postId\)/);
  });

  it('the fleet video write carries the slot key in p_metadata and reads 23505 on it as a duplicate', () => {
    const publisher = source('HorsePublisher.ts');
    const calls = publisher.split('await publishHorseVideoAtomically({').slice(1);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const metadata = call.match(/metadata: \{[\s\S]*?\n      \}/)?.[0] ?? '';
    expect(metadata).toMatch(/publication_key: publicationKey/);
    // The RPC has no publication_key argument; the reserved column stays NULL.
    expect(call.slice(0, call.indexOf('});')).replace(metadata, '')).not.toMatch(/publication_key/);
    // Handled before the generic failure return, so no brief is recorded.
    // The code decides (23505 on the named index); the message is the fallback.
    const after = call.slice(call.indexOf('});'));
    expect(after.indexOf("isDuplicateSlotPublication(published)")).toBeGreaterThan(-1);
    expect(publisher).toMatch(/if \(published\.code\) return published\.code === '23505';\s+return isDuplicateSlotMessage\(message\);/);
    expect(after.indexOf("skipped: 'duplicate_slot'")).toBeLessThan(after.indexOf('recordBrief('));
    // A video write without its key is refused before the RPC, whichever
    // producer is writing (2026-09-29: the isolated route carries it too).
    const video = publisher.slice(publisher.indexOf('export async function publishVideoClip('));
    expect(video.indexOf('if (!publicationKey) {')).toBeLessThan(
      video.indexOf('await publishHorseVideoAtomically('),
    );
    expect(video).not.toMatch(/scheduler === 'fleet' && !publicationKey/);
    // The isolated producer builds the same key from the same slot.
    const isolated = publisher.slice(publisher.indexOf('export async function publishVideoForHorse('));
    const isolatedBody = isolated.slice(0, isolated.indexOf('\nasync function postNewsLink'));
    expect(isolatedBody).toMatch(/const slot = opts\.slot \?\? fleetSlotId\(horse\.profile_id, horse\.timezone, /);
    expect(isolatedBody).toMatch(/if \(!slot\) return \{ \.\.\.base, success: false, skipped: 'no_slot' \};/);
    expect(isolatedBody).toMatch(/const publicationKey = fleetPublicationKey\(horse\.profile_id, slot\);/);
    expect(isolatedBody).toMatch(/'horse-video-reels',\s+opts\.sharedSupply,\s+publicationKey,/);
  });

  it('the recent-post guard fails closed', () => {
    const publisher = source('HorsePublisher.ts');
    const guard = publisher.slice(publisher.indexOf('export async function recentPostGuard'));
    const body = guard.slice(0, guard.indexOf('\n}\n'));
    expect(body).toMatch(/if \(error\) \{[\s\S]*?return 'guard_unreadable';/);
    expect(body).toMatch(/catch \(e\) \{[\s\S]*?return 'guard_unreadable';/);
    expect(publisher).toMatch(/return \(await recentPostGuard\(profileId, hours\)\) !== 'clear';/);
  });
});

describe('the promised reply contract is actually wired', () => {
  const social = source('HorseSocialEngine.ts');
  const fleet = source('Fleet.ts');
  const replies = social.slice(social.indexOf('export async function replyToComments'));

  // 2026-09-21 (P2C-03, A1): the contract this block pinned was the defect.
  // "The whole 48-hour decision window" let a horse's older replies fall out
  // of the caps. Now 48 hours only chooses the posts; each thread is read
  // whole, and aliases come from the paged roster. HorseSocialEngine.live
  // .test.ts drives the behaviour; this keeps the wiring from drifting.
  it('loads aliases from the paged roster and whole threads, not a 48-hour slice', () => {
    expect(replies).toMatch(/rosterOrNull\('replyToComments'\)/);
    expect(fleet).toMatch(/select\('id, name, alias, profile_id, timezone/);
    expect(social).toMatch(/THREAD_DISCOVERY_HOURS = 48/);
    expect(replies).toMatch(/pagedSelect\([\s\S]*\.in\('post_id', chunk\)/);
  });

  it('never samples away a mandatory human reply', () => {
    expect(social).toMatch(/if \(reason !== 'human_unanswered'\)[\s\S]*Math\.random\(\) > activityRate/);
  });

  it('records the inserted reply id and its real turn number', () => {
    expect(replies).toMatch(/const replyId = insertedReply\?\.id \?\? await findReplyId\(/);
    expect(replies).toMatch(/commentId: replyId,/);
    expect(replies).toMatch(/const turnIndex = decided\.decision\.turnIndex/);
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
