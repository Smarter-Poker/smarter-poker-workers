import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clips: [] as Array<{ id: string; video_id: string; category?: string | null; oembed_checked_at?: string | null }>,
  updates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  verifyYouTubeMetadata: vi.fn(),
  recordYouTubeVerification: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table !== 'poker_clips') throw new Error(`unexpected table ${table}`);
      const state: {
        op: 'select' | 'update';
        head?: boolean;
        patch?: Record<string, unknown>;
        id?: string;
        excludeSlots: boolean;
      } = { op: 'select', excludeSlots: false };
      const b: Record<string, unknown> = {};
      b.select = (_cols?: string, opts?: { head?: boolean }) => {
        if (opts?.head) state.head = true;
        return b;
      };
      b.eq = (col: string, val: unknown) => {
        if (col === 'id') state.id = String(val);
        return b;
      };
      b.or = (expr: string) => {
        if (expr === 'category.is.null,category.neq.slots') state.excludeSlots = true;
        return b;
      };
      b.order = () => b;
      b.limit = () => b;
      b.update = (patch: Record<string, unknown>) => {
        state.op = 'update';
        state.patch = patch;
        return b;
      };
      b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        if (state.op === 'update') {
          mocks.updates.push({ id: state.id!, patch: state.patch! });
          return Promise.resolve({ error: null }).then(resolve, reject);
        }
        const filtered = state.excludeSlots
          ? mocks.clips.filter((c) => c.category == null || c.category !== 'slots')
          : mocks.clips;
        if (state.head) {
          return Promise.resolve({ count: filtered.length, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      };
      return b;
    },
  }),
}));

vi.mock('../lib/content-engine/YouTubeMetadataVerifier.js', () => ({
  verifyYouTubeMetadata: mocks.verifyYouTubeMetadata,
}));

vi.mock('../lib/content-engine/HorseVideoPublication.js', () => ({
  recordYouTubeVerification: mocks.recordYouTubeVerification,
}));

import { askYouTube, revalidatePokerClips } from './revalidate-poker-clips.js';

function context() {
  let captured: { body: Record<string, unknown>; status: number } = { body: {}, status: 200 };
  return {
    json: (body: Record<string, unknown>, status = 200) => {
      captured = { body, status };
      return captured;
    },
    get captured() {
      return captured;
    },
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.clips = [];
  mocks.updates = [];
  mocks.verifyYouTubeMetadata.mockReset();
  mocks.recordYouTubeVerification.mockReset();
  mocks.verifyYouTubeMetadata.mockResolvedValue({ verdict: 'verified', reason: 'yt_dlp_public_embeddable' });
  mocks.recordYouTubeVerification.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe('revalidate-poker-clips', () => {
  it('breaks the single-403 poison-pill deadlock when a subsequent clip answers 200 and records shared verification', async () => {
    mocks.clips = [
      { id: 'c1', video_id: 'ljxB8MLl2qk', category: 'clip' },
      { id: 'c2', video_id: '1ZhDk_dOCd8', category: 'clip' },
      { id: 's1', video_id: 'slotsvid001', category: 'slots' },
    ];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('ljxB8MLl2qk')) return new Response('Forbidden', { status: 403 });
      if (url.includes('1ZhDk_dOCd8')) {
        return new Response(JSON.stringify({ html: '<iframe src="https://youtube.com/embed/1ZhDk_dOCd8"></iframe>' }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const c = context();
    const pending = revalidatePokerClips(c as never);
    await vi.runAllTimersAsync();
    await pending;

    expect(c.captured.status).toBe(200);
    expect(c.captured.body).toMatchObject({
      success: true,
      candidates: 2,
      checked: 2,
      still_ok: 1,
      retired: 1,
      pending_forbidden_held: 0,
      metadata_checked: 1,
      metadata_verified: 1,
      metadata_unknown: 0,
      metadata_unknown_reasons: {},
      stopped_early_blocked: false,
      pool_size: 2,
    });
    expect(mocks.updates).toEqual([
      { id: 'c1', patch: expect.objectContaining({ oembed_ok: false, is_active: false }) },
      { id: 'c2', patch: expect.objectContaining({ oembed_ok: true, is_active: true }) },
    ]);
    expect(mocks.recordYouTubeVerification).toHaveBeenCalledWith('ljxB8MLl2qk', 'embed_disabled', expect.any(String));
    expect(mocks.recordYouTubeVerification).toHaveBeenCalledWith('1ZhDk_dOCd8', 'verified', expect.any(String));
  });

  it('halts safely without retiring any clip on three consecutive 403 responses (IP bot block)', async () => {
    mocks.clips = [
      { id: 'c1', video_id: 'AAAAAAAAAAA', category: 'clip' },
      { id: 'c2', video_id: 'BBBBBBBBBBB', category: 'clip' },
      { id: 'c3', video_id: 'CCCCCCCCCCC', category: 'clip' },
      { id: 'c4', video_id: 'DDDDDDDDDDD', category: 'clip' },
    ];
    globalThis.fetch = vi.fn(async () => new Response('Forbidden', { status: 403 })) as unknown as typeof fetch;

    const c = context();
    const pending = revalidatePokerClips(c as never);
    await vi.runAllTimersAsync();
    await pending;

    expect(c.captured.body).toMatchObject({
      success: true,
      checked: 0,
      retired: 0,
      pending_forbidden_held: 3,
      stopped_early_blocked: true,
    });
    expect(mocks.updates).toEqual([]);
    expect(mocks.recordYouTubeVerification).not.toHaveBeenCalled();
  });

  it('retires an oEmbed-200 clip when yt-dlp metadata proves embed_disabled', async () => {
    mocks.clips = [{ id: 'c1', video_id: '1ZhDk_dOCd8', category: 'clip' }];
    mocks.verifyYouTubeMetadata.mockResolvedValueOnce({ verdict: 'embed_disabled', reason: 'youtube_embed_disabled' });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ html: '<iframe></iframe>' }), { status: 200 }),
    ) as unknown as typeof fetch;

    const c = context();
    const pending = revalidatePokerClips(c as never);
    await vi.runAllTimersAsync();
    await pending;

    expect(c.captured.body).toMatchObject({
      checked: 1,
      still_ok: 0,
      retired: 1,
      metadata_rejected: 1,
    });
    expect(mocks.updates).toEqual([
      { id: 'c1', patch: expect.objectContaining({ oembed_ok: false, is_active: false }) },
    ]);
    expect(mocks.recordYouTubeVerification).toHaveBeenCalledWith('1ZhDk_dOCd8', 'embed_disabled', expect.any(String));
  });

  it('records metadata_unknown_reasons counts for unknown metadata verdicts and failed verification writes', async () => {
    mocks.clips = [
      { id: 'c1', video_id: 'AAAAAAAAAAA', category: 'clip' },
      { id: 'c2', video_id: 'BBBBBBBBBBB', category: 'clip' },
      { id: 'c3', video_id: 'CCCCCCCCCCC', category: 'clip' },
      { id: 'c4', video_id: 'DDDDDDDDDDD', category: 'clip' },
    ];
    mocks.verifyYouTubeMetadata
      .mockResolvedValueOnce({ verdict: 'unknown', reason: 'yt_dlp_transient_failure' })
      .mockResolvedValueOnce({ verdict: 'unknown', reason: 'yt_dlp_transient_failure' })
      .mockResolvedValueOnce({ verdict: 'unknown', reason: 'yt_dlp_runtime_unavailable' })
      .mockResolvedValueOnce({ verdict: 'verified', reason: 'yt_dlp_public_embeddable' });
    mocks.recordYouTubeVerification.mockResolvedValueOnce(false);
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ html: '<iframe></iframe>' }), { status: 200 }),
    ) as unknown as typeof fetch;

    const c = context();
    const pending = revalidatePokerClips(c as never);
    await vi.runAllTimersAsync();
    await pending;

    expect(c.captured.status).toBe(200);
    expect(c.captured.body).toMatchObject({
      checked: 4,
      still_ok: 4,
      retired: 0,
      metadata_checked: 4,
      metadata_verified: 0,
      metadata_rejected: 0,
      metadata_unknown: 4,
      metadata_unknown_reasons: {
        yt_dlp_transient_failure: 2,
        yt_dlp_runtime_unavailable: 1,
        verification_record_failed: 1,
      },
    });
  });

  it('classifies HTTP 403 as forbidden and HTTP 429 as no-answer in askYouTube', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    expect(await askYouTube('AAAAAAAAAAA')).toBe('forbidden');
    globalThis.fetch = vi.fn(async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    expect(await askYouTube('AAAAAAAAAAA')).toBe('no-answer');
  });
});
