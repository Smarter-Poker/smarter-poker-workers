import { describe, expect, it, vi } from 'vitest';

import {
  PINNED_YT_DLP_VERSION,
  YT_DLP_METADATA_TIMEOUT_MS,
  classifyYtDlpFailure,
  classifyYtDlpMetadata,
  verifyYouTubeMetadata,
  type YtDlpProcessResult,
  type YtDlpRunner,
} from './YouTubeMetadataVerifier.js';

const VIDEO_ID = 'AAAAAAAAAAA';

function successfulRunner(metadata: Record<string, unknown>): YtDlpRunner & ReturnType<typeof vi.fn> {
  return vi.fn(async (args: readonly string[]): Promise<YtDlpProcessResult> => {
    if (args.includes('--version')) {
      return { code: 0, stdout: `${PINNED_YT_DLP_VERSION}\n`, stderr: '' };
    }
    return { code: 0, stdout: JSON.stringify(metadata), stderr: '' };
  });
}

describe('classifyYtDlpMetadata', () => {
  const eligible = {
    id: VIDEO_ID,
    availability: 'public',
    age_limit: 0,
    playable_in_embed: true,
    live_status: 'not_live',
  };

  it.each(['public', 'unlisted'])('accepts an explicitly %s, age-free, embeddable video', (availability) => {
    expect(classifyYtDlpMetadata({ ...eligible, availability }, VIDEO_ID)).toEqual({
      verdict: 'verified',
      reason: 'yt_dlp_public_embeddable',
    });
  });

  it.each([
    ['premium_only', 'restricted', 'youtube_premium_only'],
    ['subscriber_only', 'restricted', 'youtube_subscriber_only'],
    ['needs_auth', 'restricted', 'youtube_needs_auth'],
    ['private', 'private', 'youtube_private'],
  ])('fails closed for availability=%s', (availability, verdict, reason) => {
    expect(classifyYtDlpMetadata({ ...eligible, availability }, VIDEO_ID)).toEqual({ verdict, reason });
  });

  it('rejects age-gated metadata', () => {
    expect(classifyYtDlpMetadata({ ...eligible, age_limit: 18 }, VIDEO_ID)).toEqual({
      verdict: 'restricted',
      reason: 'youtube_age_restricted',
    });
  });

  it('rejects metadata that is not explicitly playable in an embed', () => {
    expect(classifyYtDlpMetadata({ ...eligible, playable_in_embed: false }, VIDEO_ID)).toEqual({
      verdict: 'embed_disabled',
      reason: 'youtube_embed_disabled',
    });
    expect(classifyYtDlpMetadata({ ...eligible, playable_in_embed: undefined }, VIDEO_ID)).toEqual({
      verdict: 'unknown',
      reason: 'youtube_embed_status_unknown',
    });
  });

  it.each(['is_kids_content', 'made_for_kids', 'self_declared_made_for_kids']) (
    'rejects the optional positive Made-for-Kids signal %s',
    (field) => {
      expect(classifyYtDlpMetadata({ ...eligible, [field]: true }, VIDEO_ID)).toEqual({
        verdict: 'restricted',
        reason: 'youtube_made_for_kids',
      });
    },
  );

  it.each([
    [{ ...eligible, id: 'BBBBBBBBBBB' }, 'yt_dlp_video_identity_mismatch'],
    [{ ...eligible, availability: undefined }, 'youtube_availability_unknown'],
    [{ ...eligible, age_limit: undefined }, 'youtube_age_limit_unknown'],
    [{ ...eligible, live_status: 'is_upcoming' }, 'youtube_upcoming'],
  ])('keeps incomplete or mismatched metadata unknown', (metadata, reason) => {
    expect(classifyYtDlpMetadata(metadata, VIDEO_ID)).toEqual({ verdict: 'unknown', reason });
  });
});

describe('classifyYtDlpFailure', () => {
  it.each([
    ['This video is available to members-only subscribers', 'restricted', 'youtube_subscription_restricted'],
    ['Premium subscription required', 'restricted', 'youtube_subscription_restricted'],
    ['Sign in to continue', 'restricted', 'youtube_auth_restricted'],
    ['Sign in to confirm your age', 'restricted', 'youtube_age_restricted'],
    ['The uploader has not made this video available in your country', 'restricted', 'youtube_region_restricted'],
    ['This video is private', 'private', 'youtube_private'],
    ['Playback on other websites has been disabled', 'embed_disabled', 'youtube_embed_disabled'],
    ['Video unavailable: removed by uploader', 'unavailable', 'youtube_unavailable'],
  ])('maps a definitive yt-dlp failure to %s', (detail, verdict, reason) => {
    expect(classifyYtDlpFailure(detail)).toEqual({ verdict, reason });
  });

  it.each([
    'HTTP Error 403',
    'HTTP Error 429',
    'connection reset',
    'network timeout',
    'Sign in to confirm you’re not a bot',
  ]) (
    'preserves transient failure %s as unknown',
    (detail) => {
      expect(classifyYtDlpFailure(detail)).toEqual({
        verdict: 'unknown',
        reason: 'yt_dlp_transient_failure',
      });
    },
  );
});

describe('verifyYouTubeMetadata', () => {
  it('uses the exact runtime and metadata-only command without cookies or AV output options', async () => {
    const runner = successfulRunner({
      id: VIDEO_ID,
      availability: 'public',
      age_limit: 0,
      playable_in_embed: true,
      live_status: 'not_live',
    });

    await expect(verifyYouTubeMetadata(VIDEO_ID, runner)).resolves.toEqual({
      verdict: 'verified',
      reason: 'yt_dlp_public_embeddable',
    });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0]).toEqual([[
      '-s',
      '-m',
      'yt_dlp',
      '--ignore-config',
      '--no-plugin-dirs',
      '--no-cache-dir',
      '--version',
    ], 10_000]);
    const [metadataArgs, timeout] = runner.mock.calls[1] as [string[], number];
    expect(timeout).toBe(YT_DLP_METADATA_TIMEOUT_MS);
    expect(metadataArgs).toEqual(expect.arrayContaining([
      '-s',
      '-m',
      'yt_dlp',
      '--skip-download',
      '--no-playlist',
      '--ignore-config',
      '--no-plugin-dirs',
      '--no-cache-dir',
      '--print',
      `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    ]));
    expect(metadataArgs).not.toEqual(expect.arrayContaining([
      '--cookies', '--cookies-from-browser', '--username', '--password', '--output', '-o', '--format', '-f',
    ]));
  });

  it('fails closed when the vendored runtime is absent, mismatched, or times out', async () => {
    const absent = vi.fn(async () => ({ code: null, stdout: '', stderr: '', spawnError: 'ENOENT' }));
    const mismatch = vi.fn(async () => ({ code: 0, stdout: '2026.08.18\n', stderr: '' }));
    const timeout = vi.fn(async () => ({ code: null, stdout: '', stderr: '', timedOut: true }));

    await expect(verifyYouTubeMetadata(VIDEO_ID, absent)).resolves.toEqual({
      verdict: 'unknown', reason: 'yt_dlp_runtime_unavailable',
    });
    await expect(verifyYouTubeMetadata(VIDEO_ID, mismatch)).resolves.toEqual({
      verdict: 'unknown', reason: 'yt_dlp_version_mismatch',
    });
    await expect(verifyYouTubeMetadata(VIDEO_ID, timeout)).resolves.toEqual({
      verdict: 'unknown', reason: 'yt_dlp_self_check_timeout',
    });
  });

  it('fails closed on malformed output or a transient metadata probe', async () => {
    const malformed = vi.fn(async (args: readonly string[]) => (
      args.includes('--version')
        ? { code: 0, stdout: `${PINNED_YT_DLP_VERSION}\n`, stderr: '' }
        : { code: 0, stdout: 'not-json', stderr: '' }
    ));
    const transient = vi.fn(async (args: readonly string[]) => (
      args.includes('--version')
        ? { code: 0, stdout: `${PINNED_YT_DLP_VERSION}\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: 'HTTP Error 429: Too Many Requests' }
    ));

    await expect(verifyYouTubeMetadata(VIDEO_ID, malformed)).resolves.toEqual({
      verdict: 'unknown', reason: 'yt_dlp_invalid_json',
    });
    await expect(verifyYouTubeMetadata(VIDEO_ID, transient)).resolves.toEqual({
      verdict: 'unknown', reason: 'yt_dlp_transient_failure',
    });
  });
});
