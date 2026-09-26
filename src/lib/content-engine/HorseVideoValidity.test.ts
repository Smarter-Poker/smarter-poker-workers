import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  candidateClips: vi.fn(),
  filterUnusedAssets: vi.fn(),
  postModeEnabled: vi.fn(),
  recordValidity: vi.fn(),
  recordYouTubeVerification: vi.fn(),
}));

vi.mock('./HorseVideoPublication.js', () => ({
  recordYouTubeVerification: mocks.recordYouTubeVerification,
  publishHorseVideoAtomically: vi.fn(),
}));
vi.mock('./Fleet.js', () => ({ postModeEnabled: mocks.postModeEnabled }));
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
  normalizePhrase: vi.fn(),
  recordAssetUse: vi.fn(),
  recordPhrase: vi.fn(),
}));

import {
  _resetValidityCache,
  publishVideoClip,
  YOUTUBE_OEMBED_TIMEOUT_MS,
  youtubeValidity,
} from './HorsePublisher.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  _resetValidityCache();
  vi.clearAllMocks();
  mocks.postModeEnabled.mockResolvedValue(true);
  mocks.filterUnusedAssets.mockResolvedValue(new Set(['yt:AAAAAAAAAAA']));
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
});
