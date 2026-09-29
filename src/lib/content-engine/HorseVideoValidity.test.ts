import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  candidateClips: vi.fn(),
  filterUnusedAssets: vi.fn(),
  platformCandidateClips: vi.fn(),
  postModeEnabled: vi.fn(),
  publishHorseVideoAtomically: vi.fn(),
  readFreshSharedYouTubeVerificationIds: vi.fn(),
  recordValidity: vi.fn(),
  recordYouTubeVerification: vi.fn(),
  sliceForHorse: vi.fn(),
  verifyYouTubeMetadata: vi.fn(),
  writeCaption: vi.fn(),
}));

vi.mock('./HorseVideoPublication.js', () => ({
  recordYouTubeVerification: mocks.recordYouTubeVerification,
  publishHorseVideoAtomically: mocks.publishHorseVideoAtomically,
  readFreshSharedYouTubeVerificationIds: mocks.readFreshSharedYouTubeVerificationIds,
}));
vi.mock('./YouTubeMetadataVerifier.js', () => ({
  verifyYouTubeMetadata: mocks.verifyYouTubeMetadata,
}));
vi.mock('./Fleet.js', () => ({ postModeEnabled: mocks.postModeEnabled }));
vi.mock('../supabase.js', () => ({
  getSupabase: () => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(() => query),
      limit: vi.fn(async () => ({ data: [], error: null })),
    };
    return { from: vi.fn(() => query) };
  },
}));
vi.mock('./HumanVoiceEngine.js', () => ({ seedHorseMemory: vi.fn() }));
vi.mock('./VoiceWriter.js', () => ({
  writeCaption: mocks.writeCaption,
  writeGrounded: vi.fn(),
  summarise: vi.fn(() => 'brief'),
  recordBrief: vi.fn(),
}));
vi.mock('./ClipSupply.js', () => ({
  candidateClips: mocks.candidateClips,
  newsSources: vi.fn(),
  platformCandidateClips: mocks.platformCandidateClips,
  recordValidity: mocks.recordValidity,
  sliceForHorse: mocks.sliceForHorse,
  sportsShareFor: vi.fn(() => 0.1),
}));
vi.mock('./ContentLedger.js', () => ({
  assetKeyFor: (url: string | null | undefined) => {
    const match = String(url ?? '').match(/[?&]v=([A-Za-z0-9_-]{11})/);
    return match ? `yt:${match[1]}` : null;
  },
  filterUnusedAssets: mocks.filterUnusedAssets,
  normalizePhrase: vi.fn(() => 'a real caption'),
  recordAssetUse: vi.fn(),
  recordPhrase: vi.fn(),
}));

import {
  _resetValidityCache,
  MAX_VIDEO_CAPTION_CANDIDATES,
  prepareSharedHorseVideoSupply,
  publishVideoClip,
  publishVideoForHorse,
  YOUTUBE_OEMBED_TIMEOUT_MS,
  youtubeValidity,
} from './HorsePublisher.js';

const originalFetch = globalThis.fetch;
/** The FleetScheduler slot the route found the horse due for. */
const SLOT = '2026-09-26T14';

beforeEach(() => {
  _resetValidityCache();
  vi.clearAllMocks();
  mocks.postModeEnabled.mockResolvedValue(true);
  mocks.verifyYouTubeMetadata.mockResolvedValue({
    verdict: 'verified',
    reason: 'yt_dlp_public_embeddable',
  });
  mocks.filterUnusedAssets.mockResolvedValue(new Set(['yt:AAAAAAAAAAA']));
  mocks.sliceForHorse.mockImplementation((all: string[]) => all.slice(0, 8));
  mocks.platformCandidateClips.mockResolvedValue({ status: 'ok', clips: [] });
  mocks.readFreshSharedYouTubeVerificationIds.mockResolvedValue({
    status: 'ok',
    videoIds: new Set<string>(),
  });
  mocks.writeCaption.mockResolvedValue({
    text: 'A real caption',
    semanticKey: 'semantic:poker:aces',
    stale: false,
    brief: {},
    relevance: 1,
    grounding: ['title'],
    attempts: 1,
    belowFloor: false,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('horse video oEmbed proof', () => {
  it('prepares one shared-registry batch per enabled category and retains category purity', async () => {
    mocks.platformCandidateClips.mockImplementation(async (domain: 'poker' | 'sports') => ({
      status: 'ok',
      clips: [{
        id: `${domain}-clip`,
        video_id: domain === 'poker' ? 'AAAAAAAAAAA' : 'BBBBBBBBBBB',
        source_url: `https://youtube.com/watch?v=${domain === 'poker' ? 'AAAAAAAAAAA' : 'BBBBBBBBBBB'}`,
        source: `${domain} source`,
        title: domain === 'poker' ? 'All in on the river' : 'Buzzer beater game winner',
        category: domain,
        oembed_ok: null,
      }],
    }));
    mocks.readFreshSharedYouTubeVerificationIds.mockImplementation(async (ids: string[]) => ({
      status: 'ok',
      videoIds: new Set(ids),
    }));

    await expect(prepareSharedHorseVideoSupply(['poker', 'sports'])).resolves.toMatchObject({
      status: 'ok',
      availableTypes: ['poker', 'sports'],
      supply: {
        poker: [{ video_id: 'AAAAAAAAAAA', category: 'poker' }],
        sports: [{ video_id: 'BBBBBBBBBBB', category: 'sports' }],
      },
      counts: {
        poker: { scanned: 1, verified: 1 },
        sports: { scanned: 1, verified: 1 },
      },
    });
    expect(mocks.platformCandidateClips).toHaveBeenCalledTimes(2);
    expect(mocks.readFreshSharedYouTubeVerificationIds).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a registry outage from a successful zero-positive answer', async () => {
    mocks.platformCandidateClips.mockResolvedValue({
      status: 'ok',
      clips: [{
        id: 'clip-a', video_id: 'AAAAAAAAAAA',
        source_url: 'https://youtube.com/watch?v=AAAAAAAAAAA',
        source: 'Poker source', title: 'Poker title', category: 'poker', oembed_ok: null,
      }],
    });
    mocks.readFreshSharedYouTubeVerificationIds.mockResolvedValueOnce({
      status: 'unknown',
      error: 'registry transport failed',
    });
    await expect(prepareSharedHorseVideoSupply(['poker'])).resolves.toEqual({
      status: 'unknown',
      error: 'poker: registry transport failed',
    });

    mocks.readFreshSharedYouTubeVerificationIds.mockResolvedValueOnce({
      status: 'ok',
      videoIds: new Set(),
    });
    await expect(prepareSharedHorseVideoSupply(['poker'])).resolves.toMatchObject({
      status: 'ok',
      availableTypes: [],
      supply: { poker: [] },
      counts: { poker: { scanned: 1, verified: 0 } },
    });
  });

  it('keeps unproven and subscription-gated candidates out of the scheduled snapshot', async () => {
    mocks.platformCandidateClips.mockResolvedValue({
      status: 'ok',
      clips: ['AAAAAAAAAAA', 'BBBBBBBBBBB'].map((videoId) => ({
        id: `clip-${videoId}`,
        video_id: videoId,
        source_url: `https://youtube.com/watch?v=${videoId}`,
        source: 'Poker source',
        title: `All in on the river ${videoId}`,
        category: 'poker',
        oembed_ok: null,
      })),
    });
    // Only A has a fresh positive proof. B may be negative, stale, private,
    // subscriber-only, or simply not yet proven; none is a publishable state.
    mocks.readFreshSharedYouTubeVerificationIds.mockResolvedValue({
      status: 'ok',
      videoIds: new Set(['AAAAAAAAAAA']),
    });

    await expect(prepareSharedHorseVideoSupply(['poker'])).resolves.toMatchObject({
      status: 'ok',
      availableTypes: ['poker'],
      supply: { poker: [{ video_id: 'AAAAAAAAAAA' }] },
      counts: { poker: { scanned: 2, verified: 1 } },
    });
  });

  it('separates fresh verifier proof from grounded-caption readiness before horses run', async () => {
    const poker = [
      ['8IseCEZyIxU', 'Rampage Poker', 'Dreams do come true 🙏 ✨️', 'vlog'],
      ['rcMpnCfR2UM', 'PokerGO', 'JENNIFER TILLY REACTS TO EPIC POKER HAND VS ANTONIO ESFANDIARI', 'stream'],
      ['RYZXl4LBlZc', 'The Lodge', 'The Kind Of River Card You Think About On Your Drive Home...', 'stream'],
      ['faH94pxMH6U', 'Bart Hanson', 'The $1,700 Bet That Put Pocket Aces in Hell', 'training'],
    ].map(([videoId, source, title, category]) => ({
      id: `clip-${videoId}`,
      video_id: videoId!,
      source_url: `https://youtube.com/watch?v=${videoId}`,
      source: source!,
      title: title!,
      category: category!,
      oembed_ok: null,
    }));
    const sports = ['NwvvRR71abM', 'bnoADRClYs4', 'k72VZZX2yY8'].map((videoId) => ({
      id: `clip-${videoId}`,
      video_id: videoId,
      source_url: `https://youtube.com/watch?v=${videoId}`,
      source: 'ESPN NBA',
      title: 'Keyboard shortcuts',
      category: 'highlight',
      oembed_ok: null,
    }));
    mocks.platformCandidateClips.mockImplementation(async (domain: 'poker' | 'sports') => ({
      status: 'ok',
      clips: domain === 'poker' ? poker : sports,
    }));
    mocks.readFreshSharedYouTubeVerificationIds.mockImplementation(async (ids: string[]) => ({
      status: 'ok',
      videoIds: new Set(ids),
    }));

    await expect(prepareSharedHorseVideoSupply(['poker', 'sports'])).resolves.toMatchObject({
      status: 'ok',
      availableTypes: ['poker'],
      supply: {
        poker: [
          { video_id: 'rcMpnCfR2UM' },
          { video_id: 'RYZXl4LBlZc' },
          { video_id: 'faH94pxMH6U' },
        ],
        sports: [],
      },
      counts: {
        poker: { scanned: 4, verified: 4, captionable: 3 },
        sports: { scanned: 3, verified: 3, captionable: 0 },
      },
    });
  });

  it('scheduled publication consumes only shared positives and performs no YouTube fanout', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    mocks.filterUnusedAssets.mockResolvedValue(new Set(['yt:AAAAAAAAAAA']));
    mocks.publishHorseVideoAtomically.mockResolvedValue({
      success: true,
      postId: 'post-1',
      reelId: 'reel-1',
      created: true,
    });
    const supply = {
      poker: [{
        id: 'clip-a', video_id: 'AAAAAAAAAAA',
        source_url: 'https://youtube.com/watch?v=AAAAAAAAAAA',
        source: 'Poker source', title: 'All in on the river', category: 'poker', oembed_ok: null,
      }],
      sports: [],
    };

    await expect(publishVideoForHorse(
      { id: 1, name: 'Alpha', profile_id: 'horse-a' },
      {
        skipGuard: true, slot: SLOT,
        now: new Date('2026-09-26T14:00:00Z'),
        allowedTypes: ['poker'],
        sharedSupply: supply,
      },
    )).resolves.toMatchObject({ success: true, type: 'poker_video' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.verifyYouTubeMetadata).not.toHaveBeenCalled();
    expect(mocks.candidateClips).not.toHaveBeenCalled();
    expect(mocks.publishHorseVideoAtomically).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'poker',
      videoUrl: 'https://youtube.com/watch?v=AAAAAAAAAAA',
      metadata: expect.objectContaining({ scheduler: 'horse-video-reels' }),
    }));
  });

  it('publishes a verified sports snapshot as sports without a poker relabel or native processing', async () => {
    globalThis.fetch = vi.fn() as typeof fetch;
    mocks.filterUnusedAssets.mockResolvedValue(new Set(['yt:BBBBBBBBBBB']));
    mocks.publishHorseVideoAtomically.mockResolvedValue({
      success: true, postId: 'post-s', reelId: 'reel-s', created: true,
    });
    const sports = [{
      id: 'sports-b', video_id: 'BBBBBBBBBBB',
      source_url: 'https://youtube.com/watch?v=BBBBBBBBBBB',
      source: 'Sports source', title: 'Buzzer beater game winner', category: 'football', oembed_ok: null,
    }];

    await expect(publishVideoForHorse(
      { id: 1, name: 'Alpha', profile_id: 'horse-a' },
      { skipGuard: true, slot: SLOT, allowedTypes: ['sports'], sharedSupply: { poker: [], sports } },
    )).resolves.toMatchObject({ success: true, type: 'sports_video' });
    expect(mocks.publishHorseVideoAtomically).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'sports',
      videoUrl: 'https://youtube.com/watch?v=BBBBBBBBBBB',
      metadata: expect.objectContaining({ clip_type: 'sports', scheduler: 'horse-video-reels' }),
    }));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mocks.verifyYouTubeMetadata).not.toHaveBeenCalled();
  });

  it('ignores a stale process-wide YouTube backoff when a fresh shared positive exists', async () => {
    const fetchMock = vi.fn(async () => new Response('rate limited', { status: 429 }));
    globalThis.fetch = fetchMock as typeof fetch;
    await expect(youtubeValidity('https://youtube.com/watch?v=AAAAAAAAAAA')).resolves.toBe('unknown');

    mocks.filterUnusedAssets.mockResolvedValue(new Set(['yt:BBBBBBBBBBB']));
    mocks.publishHorseVideoAtomically.mockResolvedValue({
      success: true, postId: 'post-b', reelId: 'reel-b', created: true,
    });
    const poker = [{
      id: 'clip-b', video_id: 'BBBBBBBBBBB',
      source_url: 'https://youtube.com/watch?v=BBBBBBBBBBB',
      source: 'Poker source', title: 'All in on the river', category: 'poker', oembed_ok: null,
    }];

    await expect(publishVideoForHorse(
      { id: 1, name: 'Alpha', profile_id: 'horse-a' },
      { skipGuard: true, slot: SLOT, allowedTypes: ['poker'], sharedSupply: { poker, sports: [] } },
    )).resolves.toMatchObject({ success: true, type: 'poker_video' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.verifyYouTubeMetadata).not.toHaveBeenCalled();
  });

  it('widens once from the horse slice to the full verified platform pool', async () => {
    const supply = {
      poker: Array.from({ length: 10 }, (_, index) => {
        const videoId = `${String(index).padStart(11, 'A')}`.slice(-11);
        return {
          id: `clip-${index}`, video_id: videoId,
          source_url: `https://youtube.com/watch?v=${videoId}`,
          source: `Source ${index}`, title: `All in on the river ${index}`, category: 'poker', oembed_ok: null,
        };
      }),
      sports: [],
    };
    const allKeys = new Set(supply.poker.map((clip) => `yt:${clip.video_id}`));
    mocks.filterUnusedAssets
      .mockResolvedValueOnce(new Set())
      .mockResolvedValueOnce(allKeys);
    mocks.publishHorseVideoAtomically.mockResolvedValue({
      success: true, postId: 'post-1', reelId: 'reel-1', created: true,
    });

    await expect(publishVideoForHorse(
      { id: 1, name: 'Alpha', profile_id: 'horse-a' },
      { skipGuard: true, slot: SLOT, allowedTypes: ['poker'], sharedSupply: supply },
    )).resolves.toMatchObject({ success: true });
    expect(mocks.filterUnusedAssets).toHaveBeenCalledTimes(2);
  });

  it('tries the next caption-ready shared clip when the first exhausts the freshness gate', async () => {
    const poker = ['AAAAAAAAAAA', 'BBBBBBBBBBB'].map((videoId) => ({
      id: `clip-${videoId}`,
      video_id: videoId,
      source_url: `https://youtube.com/watch?v=${videoId}`,
      source: 'Poker source',
      title: 'All in on the river',
      category: 'poker',
      oembed_ok: null,
    }));
    mocks.filterUnusedAssets.mockResolvedValue(new Set(['yt:AAAAAAAAAAA', 'yt:BBBBBBBBBBB']));
    mocks.writeCaption
      .mockResolvedValueOnce({
        text: '', semanticKey: 'caption:stale', stale: true, brief: {}, relevance: 1,
        grounding: ['title'], attempts: 6, belowFloor: false,
      })
      .mockResolvedValueOnce({
        text: 'A fresh grounded caption', semanticKey: 'caption:fresh', stale: false, brief: {}, relevance: 1,
        grounding: ['title'], attempts: 1, belowFloor: false,
      });
    mocks.publishHorseVideoAtomically.mockResolvedValue({
      success: true, postId: 'post-next', reelId: 'reel-next', created: true,
    });
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      await expect(publishVideoForHorse(
        { id: 1, name: 'Alpha', profile_id: 'horse-a' },
        {
          skipGuard: true, slot: SLOT,
          now: new Date('2026-09-26T14:00:00Z'),
          allowedTypes: ['poker'],
          sharedSupply: { poker, sports: [] },
        },
      )).resolves.toMatchObject({ success: true, postId: 'post-next', reelId: 'reel-next' });
    } finally {
      random.mockRestore();
    }
    expect(mocks.writeCaption).toHaveBeenCalledTimes(2);
    expect(mocks.publishHorseVideoAtomically).toHaveBeenCalledTimes(1);
    expect(mocks.publishHorseVideoAtomically).toHaveBeenCalledWith(expect.objectContaining({
      videoUrl: 'https://youtube.com/watch?v=BBBBBBBBBBB',
      semanticKey: 'caption:fresh',
    }));
  });

  it('bounds caption fallbacks and never converts them into YouTube fanout', async () => {
    globalThis.fetch = vi.fn() as typeof fetch;
    const poker = Array.from({ length: 10 }, (_, index) => {
      const videoId = String(index).padStart(11, 'A');
      return {
        id: `clip-${videoId}`,
        video_id: videoId,
        source_url: `https://youtube.com/watch?v=${videoId}`,
        source: 'Poker source',
        title: 'All in on the river',
        category: 'poker',
        oembed_ok: null,
      };
    });
    mocks.filterUnusedAssets.mockResolvedValue(new Set(poker.map((clip) => `yt:${clip.video_id}`)));
    mocks.writeCaption.mockResolvedValue({
      text: '', semanticKey: 'caption:stale', stale: true, brief: {}, relevance: 1,
      grounding: ['title'], attempts: 6, belowFloor: false,
    });

    await expect(publishVideoForHorse(
      { id: 1, name: 'Alpha', profile_id: 'horse-a' },
      {
        skipGuard: true, slot: SLOT,
        allowedTypes: ['poker'],
        sharedSupply: { poker, sports: [] },
      },
    )).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining(`candidates=${MAX_VIDEO_CAPTION_CANDIDATES}`),
    });
    expect(mocks.writeCaption).toHaveBeenCalledTimes(MAX_VIDEO_CAPTION_CANDIDATES);
    expect(mocks.publishHorseVideoAtomically).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mocks.verifyYouTubeMetadata).not.toHaveBeenCalled();
  });

  it('fails scheduled publication closed without a shared snapshot and never falls back to live verification', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    await expect(publishVideoForHorse(
      { id: 1, name: 'Alpha', profile_id: 'horse-a' },
      { skipGuard: true, slot: SLOT, allowedTypes: ['poker', 'sports'] },
    )).resolves.toMatchObject({
      success: false,
      outcome: 'unknown',
      error: 'shared verified video supply unavailable',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.candidateClips).not.toHaveBeenCalled();
  });

  it('treats an empty verified category as definite zero supply, not transport unknown', async () => {
    await expect(publishVideoForHorse(
      { id: 1, name: 'Alpha', profile_id: 'horse-a' },
      { skipGuard: true, slot: SLOT, allowedTypes: ['poker'], sharedSupply: { poker: [], sports: [] } },
    )).resolves.toMatchObject({
      success: false,
      error: 'poker_video: No fresh public verified caption-ready poker clips in supply',
    });
    expect(mocks.candidateClips).not.toHaveBeenCalled();
  });

  it('returns ok only after the positive verdict is durable in the shared registry', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      html: '<iframe src="https://www.youtube.com/embed/AAAAAAAAAAA"></iframe>',
      title: 'A real title',
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    mocks.recordYouTubeVerification.mockResolvedValue(true);

    await expect(youtubeValidity('https://youtube.com/watch?v=AAAAAAAAAAA')).resolves.toBe('ok');
    expect(mocks.recordYouTubeVerification).toHaveBeenCalledWith(
      'AAAAAAAAAAA',
      'verified',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
    expect(mocks.verifyYouTubeMetadata).toHaveBeenCalledWith('AAAAAAAAAAA');
  });

  it.each([
    ['premium/subscriber-only', 'restricted', 'youtube_subscriber_only'],
    ['authentication-only', 'restricted', 'youtube_needs_auth'],
    ['age-restricted', 'restricted', 'youtube_age_restricted'],
    ['region-restricted', 'restricted', 'youtube_region_restricted'],
    ['Made-for-Kids when yt-dlp exposes it', 'restricted', 'youtube_made_for_kids'],
    ['embed-disabled', 'embed_disabled', 'youtube_embed_disabled'],
  ])('refuses %s metadata before recording a positive verdict', async (_label, verdict, reason) => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      html: '<iframe src="https://www.youtube.com/embed/AAAAAAAAAAA"></iframe>',
      title: 'A real title',
    }), { status: 200 })) as typeof fetch;
    mocks.verifyYouTubeMetadata.mockResolvedValue({ verdict, reason });
    mocks.recordYouTubeVerification.mockResolvedValue(true);

    await expect(youtubeValidity('https://youtube.com/watch?v=AAAAAAAAAAA')).resolves.toBe('bad');
    expect(mocks.recordYouTubeVerification).toHaveBeenCalledTimes(1);
    expect(mocks.recordYouTubeVerification).toHaveBeenCalledWith(
      'AAAAAAAAAAA',
      verdict,
      expect.any(String),
    );
    expect(mocks.recordYouTubeVerification).not.toHaveBeenCalledWith(
      'AAAAAAAAAAA',
      'verified',
      expect.any(String),
    );
  });

  it('keeps a transient yt-dlp/runtime failure unknown and never writes a positive verdict', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      html: '<iframe src="https://www.youtube.com/embed/AAAAAAAAAAA"></iframe>',
    }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    mocks.verifyYouTubeMetadata.mockResolvedValue({
      verdict: 'unknown',
      reason: 'yt_dlp_transient_failure',
    });

    await expect(youtubeValidity('https://youtube.com/watch?v=AAAAAAAAAAA')).resolves.toBe('unknown');
    await expect(youtubeValidity('https://youtube.com/watch?v=BBBBBBBBBBB')).resolves.toBe('unknown');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.verifyYouTubeMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.recordYouTubeVerification).not.toHaveBeenCalled();
  });

  it('returns unknown and does not cache a local success when the shared write fails', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      html: '<iframe src="https://www.youtube.com/embed/AAAAAAAAAAA"></iframe>',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchMock as typeof fetch;
    mocks.recordYouTubeVerification.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(youtubeValidity('https://youtube.com/watch?v=AAAAAAAAAAA')).resolves.toBe('unknown');
    await expect(youtubeValidity('https://youtube.com/watch?v=AAAAAAAAAAA')).resolves.toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never turns a throttle into public eligibility', async () => {
    globalThis.fetch = vi.fn(async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    await expect(youtubeValidity('https://youtube.com/watch?v=AAAAAAAAAAA')).resolves.toBe('unknown');
    expect(mocks.recordYouTubeVerification).not.toHaveBeenCalled();
  });

  it('records an embed-disabled response and refuses it', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ html: '' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    mocks.recordYouTubeVerification.mockResolvedValue(true);
    await expect(youtubeValidity('https://youtube.com/watch?v=AAAAAAAAAAA')).resolves.toBe('bad');
    expect(mocks.recordYouTubeVerification).toHaveBeenCalledWith(
      'AAAAAAAAAAA',
      'embed_disabled',
      expect.any(String),
    );
  });

  it('bounds a hung oEmbed request and returns unknown', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch;
      const verdict = youtubeValidity('https://youtube.com/watch?v=AAAAAAAAAAA');
      await vi.advanceTimersByTimeAsync(YOUTUBE_OEMBED_TIMEOUT_MS);
      await expect(verdict).resolves.toBe('unknown');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('AAAAAAAAAAA'),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retire poker supply when oEmbed cannot answer', async () => {
    mocks.candidateClips.mockResolvedValue({
      clips: [{
        id: 'clip-a',
        video_id: 'AAAAAAAAAAA',
        source_url: 'https://youtube.com/watch?v=AAAAAAAAAAA',
        source: 'Test channel',
        title: 'All in on the river',
        category: 'cash',
        oembed_ok: null,
      }],
      widened: false,
    });
    globalThis.fetch = vi.fn(async () => new Response('rate limited', { status: 429 })) as typeof fetch;

    await expect(publishVideoClip({ id: 1, name: 'Alpha', profile_id: 'horse-a' }, 'poker', []))
      .resolves.toMatchObject({ success: false, error: 'No valid poker clips found' });
    expect(mocks.recordValidity).not.toHaveBeenCalled();
  });

  it('never retires the first, second, or third clip behind a 403 block', async () => {
    mocks.candidateClips.mockResolvedValue({
      clips: ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC'].map((videoId) => ({
        id: `clip-${videoId}`,
        video_id: videoId,
        source_url: `https://youtube.com/watch?v=${videoId}`,
        source: 'Test channel',
        title: 'Test clip',
        category: 'cash',
        oembed_ok: null,
      })),
      widened: false,
    });
    mocks.filterUnusedAssets.mockResolvedValue(new Set([
      'yt:AAAAAAAAAAA',
      'yt:BBBBBBBBBBB',
      'yt:CCCCCCCCCCC',
    ]));
    globalThis.fetch = vi.fn(async () => new Response('forbidden', { status: 403 })) as typeof fetch;
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      await expect(publishVideoClip({ id: 1, name: 'Alpha', profile_id: 'horse-a' }, 'poker', []))
        .resolves.toMatchObject({ success: false, error: 'No valid poker clips found' });
    } finally {
      random.mockRestore();
    }
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.recordValidity).not.toHaveBeenCalled();
  });

  it('retires poker supply only after a definitive negative', async () => {
    mocks.candidateClips.mockResolvedValue({
      clips: [{
        id: 'clip-a',
        video_id: 'AAAAAAAAAAA',
        source_url: 'https://youtube.com/watch?v=AAAAAAAAAAA',
        source: 'Test channel',
        title: 'All in on the river',
        category: 'cash',
        oembed_ok: null,
      }],
      widened: false,
    });
    globalThis.fetch = vi.fn(async () => new Response('missing', { status: 404 })) as typeof fetch;
    mocks.recordYouTubeVerification.mockResolvedValue(true);

    await expect(publishVideoClip({ id: 1, name: 'Alpha', profile_id: 'horse-a' }, 'poker', []))
      .resolves.toMatchObject({ success: false, error: 'No valid poker clips found' });
    expect(mocks.recordValidity).toHaveBeenCalledWith('clip-a', false);
  });

  it('reads a slot-index duplicate from the atomic result by code first, then by message', async () => {
    const sharedSupply = {
      poker: [{
        id: 'clip-a', video_id: 'AAAAAAAAAAA',
        source_url: 'https://youtube.com/watch?v=AAAAAAAAAAA',
        source: 'Poker source', title: 'All in on the river', category: 'poker', oembed_ok: null,
      }],
      sports: [],
    };
    const opts = { skipGuard: true, slot: SLOT, allowedTypes: ['poker' as const], sharedSupply };
    const horse = { id: 1, name: 'Alpha', profile_id: 'horse-a' };
    const duplicate = { success: false, skipped: 'duplicate_slot', publicationKey: `fleet:horse-a:${SLOT}` };

    // The database's own code, with the index named: a duplicate of the slot.
    mocks.publishHorseVideoAtomically.mockResolvedValueOnce({
      success: false,
      code: '23505',
      error: 'atomic horse video publication failed: duplicate key value violates unique constraint "uq_social_posts_metadata_publication_key"',
    });
    await expect(publishVideoForHorse(horse, opts)).resolves.toMatchObject(duplicate);

    // A result without a code (an older shape) still decides by the message.
    mocks.publishHorseVideoAtomically.mockResolvedValueOnce({
      success: false,
      error: 'atomic horse video publication failed: duplicate key value violates unique constraint "uq_social_posts_metadata_publication_key"',
    });
    await expect(publishVideoForHorse(horse, opts)).resolves.toMatchObject(duplicate);

    // Naming the key under another code is not a duplicate: the code decides.
    mocks.publishHorseVideoAtomically.mockResolvedValueOnce({
      success: false,
      code: '23514',
      error: 'atomic horse video publication failed: duplicate key value on publication_key is not what this is',
    });
    await expect(publishVideoForHorse(horse, opts)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('not what this is'),
    });
    expect(mocks.publishHorseVideoAtomically).toHaveBeenCalledTimes(3);
    for (const call of mocks.publishHorseVideoAtomically.mock.calls) {
      expect(call[0].metadata).toMatchObject({ publication_key: `fleet:horse-a:${SLOT}`, scheduler: 'horse-video-reels' });
    }
  });

  it('does not attempt an alternate topic after an atomic outcome becomes unknown', async () => {
    const sharedSupply = {
      poker: ['AAAAAAAAAAA', 'BBBBBBBBBBB'].map((videoId) => ({
        id: `clip-${videoId}`,
        video_id: videoId,
        source_url: `https://youtube.com/watch?v=${videoId}`,
        source: 'Test channel',
        title: 'All in on the river',
        category: 'cash',
        oembed_ok: null,
      })),
      sports: [],
    };
    mocks.filterUnusedAssets.mockResolvedValue(new Set(['yt:AAAAAAAAAAA', 'yt:BBBBBBBBBBB']));
    mocks.publishHorseVideoAtomically.mockResolvedValue({
      success: false,
      outcome: 'unknown',
      error: 'atomic horse video publication outcome unknown: request aborted',
    });

    await expect(publishVideoForHorse(
      { id: 1, name: 'Alpha', profile_id: 'horse-a' },
      {
        skipGuard: true, slot: SLOT,
        now: new Date('2026-09-26T14:00:00Z'),
        allowedTypes: ['poker', 'sports'],
        sharedSupply,
      },
    )).resolves.toMatchObject({
      success: false,
      outcome: 'unknown',
      error: expect.stringContaining('outcome unknown'),
    });
    expect(mocks.candidateClips).not.toHaveBeenCalled();
    expect(mocks.publishHorseVideoAtomically).toHaveBeenCalledTimes(1);
    expect(mocks.writeCaption).toHaveBeenCalledTimes(1);
  });
});
