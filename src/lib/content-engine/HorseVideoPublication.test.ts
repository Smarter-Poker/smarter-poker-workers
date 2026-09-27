import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());

vi.mock('../supabase.js', () => ({
  getSupabase: () => ({ rpc }),
}));

import {
  publishHorseVideoAtomically,
  readFreshSharedYouTubeVerificationIds,
  recordYouTubeVerification,
} from './HorseVideoPublication.js';

beforeEach(() => rpc.mockReset());

describe('shared YouTube verification', () => {
  it('sanitizes and batches candidate ids through the service-role verification RPC', async () => {
    rpc.mockResolvedValue({
      data: [
        { youtube_video_id: 'AAAAAAAAAAA' },
        { youtube_video_id: 'BBBBBBBBBBB' },
      ],
      error: null,
    });

    await expect(readFreshSharedYouTubeVerificationIds([
      ' AAAAAAAAAAA ',
      'too-short',
      'AAAAAAAAAAA',
      'BBBBBBBBBBB',
    ])).resolves.toEqual({
      status: 'ok',
      videoIds: new Set(['AAAAAAAAAAA', 'BBBBBBBBBBB']),
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('fn_fresh_public_youtube_verification_ids', {
      p_youtube_video_ids: ['AAAAAAAAAAA', 'BBBBBBBBBBB'],
    });
  });

  it('keeps a registry error or malformed response unknown instead of calling it empty supply', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'registry unavailable' } });
    await expect(readFreshSharedYouTubeVerificationIds(['AAAAAAAAAAA'])).resolves.toEqual({
      status: 'unknown',
      error: 'shared YouTube verification registry unavailable: registry unavailable',
    });

    rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(readFreshSharedYouTubeVerificationIds(['AAAAAAAAAAA'])).resolves.toEqual({
      status: 'unknown',
      error: 'shared YouTube verification registry returned a malformed payload',
    });

    rpc.mockRejectedValueOnce(new Error('request aborted'));
    await expect(readFreshSharedYouTubeVerificationIds(['AAAAAAAAAAA'])).resolves.toEqual({
      status: 'unknown',
      error: 'shared YouTube verification registry outcome unknown: request aborted',
    });
  });

  it('treats a successful empty registry answer as definite zero eligible supply', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(readFreshSharedYouTubeVerificationIds(['AAAAAAAAAAA'])).resolves.toEqual({
      status: 'ok',
      videoIds: new Set(),
    });
  });

  it('records a fresh positive oEmbed verdict with the race boundary', async () => {
    rpc.mockResolvedValue({
      data: [{ video_id: 'AAAAAAAAAAA', verification_status: 'resolved', resolved: true }],
      error: null,
    });

    await expect(
      recordYouTubeVerification('AAAAAAAAAAA', 'verified', '2026-09-26T14:00:00.000Z'),
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('record_youtube_embed_failure_verdict', {
      p_video_id: 'AAAAAAAAAAA',
      p_verdict: 'verified',
      p_error_code: null,
      p_surface: 'horse_video_reels',
      p_verification_started_at: '2026-09-26T14:00:00.000Z',
    });
  });

  it('fails closed when the shared registry rejects or cannot prove the verdict', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'database unavailable' } });
    await expect(
      recordYouTubeVerification('AAAAAAAAAAA', 'verified', '2026-09-26T14:00:00.000Z'),
    ).resolves.toBe(false);

    rpc.mockResolvedValueOnce({
      data: [{ video_id: 'AAAAAAAAAAA', verification_status: 'confirmed', resolved: false }],
      error: null,
    });
    await expect(
      recordYouTubeVerification('AAAAAAAAAAA', 'verified', '2026-09-26T14:00:00.000Z'),
    ).resolves.toBe(false);
  });
});

describe('atomic horse video publication', () => {
  const input = {
    authorId: '00000000-0000-4000-8000-000000000001',
    videoUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
    caption: 'A real caption',
    topic: 'poker' as const,
    assetKey: 'yt:AAAAAAAAAAA',
    phraseNorm: 'a real caption',
    semanticKey: 'semantic:poker:aces',
    metadata: { clip_type: 'poker', scheduler: 'horse-video-reels' },
  };

  it('delegates the complete write boundary to one RPC and returns both identities', async () => {
    rpc.mockResolvedValue({
      data: [{ social_post_id: 'post-1', social_reel_id: 'reel-1', created: true }],
      error: null,
    });

    await expect(publishHorseVideoAtomically(input)).resolves.toEqual({
      success: true,
      postId: 'post-1',
      reelId: 'reel-1',
      created: true,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('publish_horse_video_reel', {
      p_author_id: input.authorId,
      p_video_url: input.videoUrl,
      p_caption: input.caption,
      p_topic: input.topic,
      p_asset_key: input.assetKey,
      p_phrase_norm: input.phraseNorm,
      p_semantic_key: input.semanticKey,
      p_metadata: input.metadata,
    });
  });

  it('never accepts a post without its linked Reel', async () => {
    rpc.mockResolvedValue({
      data: [{ social_post_id: 'post-1', social_reel_id: null, created: true }],
      error: null,
    });
    await expect(publishHorseVideoAtomically(input)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('no linked post/Reel pair'),
    });
  });

  it('does not call the database for a mismatched or non-YouTube identity', async () => {
    await expect(
      publishHorseVideoAtomically({ ...input, assetKey: 'yt:BBBBBBBBBBB' }),
    ).resolves.toMatchObject({ success: false });
    await expect(
      publishHorseVideoAtomically({
        ...input,
        videoUrl: 'https://example.com/video.mp4',
        assetKey: 'url:example.com/video.mp4',
      }),
    ).resolves.toMatchObject({ success: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('fails closed before the RPC when semantic identity is absent', async () => {
    await expect(
      publishHorseVideoAtomically({ ...input, semanticKey: '   ' }),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('semantic'),
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('surfaces the authoritative transaction failure without a local retry', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '23514', message: 'reel mirror missing' } });
    await expect(publishHorseVideoAtomically(input)).resolves.toEqual({
      success: false,
      error: 'atomic horse video publication failed: reel mirror missing',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('retains an unknown outcome when the RPC acknowledgement is lost', async () => {
    rpc.mockRejectedValue(new Error('supabase request exceeded 20000ms and was aborted'));
    await expect(publishHorseVideoAtomically(input)).resolves.toEqual({
      success: false,
      outcome: 'unknown',
      error: 'atomic horse video publication outcome unknown: supabase request exceeded 20000ms and was aborted',
    });
    expect(rpc).toHaveBeenCalledTimes(1);

    rpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST002', message: 'database connection unavailable' },
    });
    await expect(publishHorseVideoAtomically(input)).resolves.toMatchObject({
      success: false,
      outcome: 'unknown',
    });
  });
});
