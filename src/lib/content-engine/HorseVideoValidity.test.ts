import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  candidateClips: vi.fn(),
  filterUnusedAssets: vi.fn(),
  postModeEnabled: vi.fn(),
  publishHorseVideoAtomically: vi.fn(),
  recordValidity: vi.fn(),
  recordYouTubeVerification: vi.fn(),
  verifyYouTubeMetadata: vi.fn(),
  writeCaption: vi.fn(),
}));

vi.mock('./HorseVideoPublication.js', () => ({
  recordYouTubeVerification: mocks.recordYouTubeVerification,
  publishHorseVideoAtomically: mocks.publishHorseVideoAtomically,
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
  recordValidity: mocks.recordValidity,
  sliceForHorse: vi.fn(),
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
  publishVideoClip,
  publishVideoForHorse,
  YOUTUBE_OEMBED_TIMEOUT_MS,
  youtubeValidity,
} from './HorsePublisher.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  _resetValidityCache();
  vi.clearAllMocks();
  mocks.postModeEnabled.mockResolvedValue(true);
  mocks.verifyYouTubeMetadata.mockResolvedValue({
    verdict: 'verified',
    reason: 'yt_dlp_public_embeddable',
  });
  mocks.filterUnusedAssets.mockResolvedValue(new Set(['yt:AAAAAAAAAAA']));
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
        title: 'Test clip',
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
        title: 'Test clip',
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

  it('does not attempt an alternate topic after an atomic outcome becomes unknown', async () => {
    mocks.candidateClips.mockResolvedValue({
      clips: [{
        id: 'clip-a',
        video_id: 'AAAAAAAAAAA',
        source_url: 'https://youtube.com/watch?v=AAAAAAAAAAA',
        source: 'Test channel',
        title: 'Test clip',
        category: 'cash',
        oembed_ok: null,
      }],
      widened: false,
    });
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      html: '<iframe src="https://www.youtube.com/embed/AAAAAAAAAAA"></iframe>',
      title: 'Test clip',
    }), { status: 200 })) as typeof fetch;
    mocks.recordYouTubeVerification.mockResolvedValue(true);
    mocks.publishHorseVideoAtomically.mockResolvedValue({
      success: false,
      outcome: 'unknown',
      error: 'atomic horse video publication outcome unknown: request aborted',
    });

    await expect(publishVideoForHorse(
      { id: 1, name: 'Alpha', profile_id: 'horse-a' },
      { skipGuard: true, now: new Date('2026-09-26T14:00:00Z'), allowedTypes: ['poker', 'sports'] },
    )).resolves.toMatchObject({
      success: false,
      outcome: 'unknown',
      error: expect.stringContaining('outcome unknown'),
    });
    expect(mocks.candidateClips).toHaveBeenCalledTimes(1);
    expect(mocks.candidateClips).toHaveBeenCalledWith('poker', 'horse-a');
    expect(mocks.publishHorseVideoAtomically).toHaveBeenCalledTimes(1);
  });
});
