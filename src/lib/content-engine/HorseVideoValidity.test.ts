import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordYouTubeVerification = vi.hoisted(() => vi.fn());

vi.mock('./HorseVideoPublication.js', () => ({
  recordYouTubeVerification,
  publishHorseVideoAtomically: vi.fn(),
}));

import { _resetValidityCache, youtubeValidity } from './HorsePublisher.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  _resetValidityCache();
  recordYouTubeVerification.mockReset();
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
    recordYouTubeVerification.mockResolvedValue(true);

    await expect(youtubeValidity('https://youtube.com/watch?v=AAAAAAAAAAA')).resolves.toBe('ok');
    expect(recordYouTubeVerification).toHaveBeenCalledWith(
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
    recordYouTubeVerification.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(youtubeValidity('https://youtube.com/watch?v=AAAAAAAAAAA')).resolves.toBe('unknown');
    await expect(youtubeValidity('https://youtube.com/watch?v=AAAAAAAAAAA')).resolves.toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never turns a throttle into public eligibility', async () => {
    globalThis.fetch = vi.fn(async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    await expect(youtubeValidity('https://youtube.com/watch?v=AAAAAAAAAAA')).resolves.toBe('unknown');
    expect(recordYouTubeVerification).not.toHaveBeenCalled();
  });

  it('records an embed-disabled response and refuses it', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ html: '' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    recordYouTubeVerification.mockResolvedValue(true);
    await expect(youtubeValidity('https://youtube.com/watch?v=AAAAAAAAAAA')).resolves.toBe('bad');
    expect(recordYouTubeVerification).toHaveBeenCalledWith(
      'AAAAAAAAAAA',
      'embed_disabled',
      expect.any(String),
    );
  });
});
