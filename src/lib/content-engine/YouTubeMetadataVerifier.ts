/**
 * Metadata-only YouTube eligibility verification for horse-authored Reels.
 *
 * oEmbed proves that a title and iframe can be returned, but it cannot prove
 * that a viewer will not hit a Premium, members-only, sign-in, age, or region
 * gate. The canonical Video Library publisher uses yt-dlp's extracted info
 * dictionary for those decisions. This worker uses the same pinned extractor
 * and only asks for a small JSON projection while `--skip-download` is set.
 * No cookies, media formats, output paths, audio, or video bytes are requested.
 */
import { execFile } from 'node:child_process';

export const PINNED_YT_DLP_VERSION = '2026.08.19';
export const YT_DLP_METADATA_TIMEOUT_MS = 40_000;
export const YT_DLP_MAX_OUTPUT_BYTES = 256 * 1024;

export type YouTubeMetadataVerdict =
  | 'verified'
  | 'private'
  | 'restricted'
  | 'unavailable'
  | 'embed_disabled'
  | 'unknown';

export interface YouTubeMetadataVerification {
  verdict: YouTubeMetadataVerdict;
  reason: string;
}

export interface YtDlpProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  spawnError?: string;
}

export type YtDlpRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<YtDlpProcessResult>;

interface YtDlpMetadata {
  id?: unknown;
  availability?: unknown;
  age_limit?: unknown;
  playable_in_embed?: unknown;
  live_status?: unknown;
  is_kids_content?: unknown;
  made_for_kids?: unknown;
  self_declared_made_for_kids?: unknown;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_DLP_PRINT_TEMPLATE =
  '%(.{id,availability,age_limit,playable_in_embed,live_status,is_kids_content,made_for_kids,self_declared_made_for_kids})j';

function verifierEnvironment(): NodeJS.ProcessEnv {
  const vendorRoot = process.env.YT_DLP_VENDOR_ROOT?.trim() || '/opt/ytdlp/vendor';
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/nonexistent',
    TMPDIR: '/tmp',
    PYTHONPATH: vendorRoot,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
  };
}

/** Execute only the pinned, vendored yt-dlp module with a credential-free env. */
export const runVendoredYtDlp: YtDlpRunner = (args, timeoutMs) => new Promise((resolve) => {
  const python = process.env.YT_DLP_PYTHON?.trim() || '/usr/bin/python3';
  execFile(
    python,
    [...args],
    {
      encoding: 'utf8',
      env: verifierEnvironment(),
      maxBuffer: YT_DLP_MAX_OUTPUT_BYTES,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true,
      cwd: '/tmp',
    },
    (error, stdout, stderr) => {
      if (!error) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      const details = error as NodeJS.ErrnoException & {
        code?: string | number;
        killed?: boolean;
        signal?: string;
      };
      resolve({
        code: typeof details.code === 'number' ? details.code : null,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        timedOut: details.killed === true || details.signal === 'SIGKILL',
        spawnError: typeof details.code === 'string' ? details.code : undefined,
      });
    },
  );
});

let runtimeCheck: Promise<YouTubeMetadataVerification> | null = null;

async function checkRuntime(runner: YtDlpRunner): Promise<YouTubeMetadataVerification> {
  const check = async (): Promise<YouTubeMetadataVerification> => {
    const result = await runner([
      '-s',
      '-m',
      'yt_dlp',
      '--ignore-config',
      '--no-plugin-dirs',
      '--no-cache-dir',
      '--version',
    ], 10_000);
    if (result.code !== 0) {
      return {
        verdict: 'unknown',
        reason: result.timedOut ? 'yt_dlp_self_check_timeout' : 'yt_dlp_runtime_unavailable',
      };
    }
    if (result.stdout.trim() !== PINNED_YT_DLP_VERSION) {
      return { verdict: 'unknown', reason: 'yt_dlp_version_mismatch' };
    }
    return { verdict: 'verified', reason: 'yt_dlp_runtime_verified' };
  };

  // The image is immutable. Rechecking the same executable for every clip
  // adds process churn without adding evidence. Injected test runners stay
  // isolated and therefore do not share the production cache.
  if (runner !== runVendoredYtDlp) return check();
  runtimeCheck ??= check();
  return runtimeCheck;
}

/** Test hook for exercising a restarted immutable worker process. */
export function _resetYtDlpRuntimeCheck(): void {
  runtimeCheck = null;
}

export function classifyYtDlpFailure(detail: string): YouTubeMetadataVerification {
  const text = detail.toLowerCase();
  // YouTube's IP-level anti-bot challenge is not evidence that this specific
  // video requires authentication. Keep it unknown so a shared negative
  // verdict cannot poison otherwise public supply.
  if (/sign in to confirm (?:you(?:'|’)?re|you are) not a bot|not a bot|po token|visitor data/.test(text)) {
    return { verdict: 'unknown', reason: 'yt_dlp_transient_failure' };
  }
  if (/not (?:made (?:this )?video )?available in (?:your|this) (?:country|region|location)|geo(?:graphically)?[- ]restricted|region[- ]restricted/.test(text)) {
    return { verdict: 'restricted', reason: 'youtube_region_restricted' };
  }
  if (/members?[- ]only|premium(?:[- ]only)?|subscriber[- ]only|subscription required/.test(text)) {
    return { verdict: 'restricted', reason: 'youtube_subscription_restricted' };
  }
  if (/age[- ]restricted|sign in to confirm your age|age verification/.test(text)) {
    return { verdict: 'restricted', reason: 'youtube_age_restricted' };
  }
  if (/login required|sign in to (?:confirm|continue|watch)|authentication required|needs[_ -]auth/.test(text)) {
    return { verdict: 'restricted', reason: 'youtube_auth_restricted' };
  }
  if (/private video|video is private/.test(text)) {
    return { verdict: 'private', reason: 'youtube_private' };
  }
  if (/embedding disabled|playback on other websites has been disabled/.test(text)) {
    return { verdict: 'embed_disabled', reason: 'youtube_embed_disabled' };
  }
  if (/video unavailable|video is not available|removed|deleted/.test(text)) {
    return { verdict: 'unavailable', reason: 'youtube_unavailable' };
  }
  if (/http error 403|http error 429|too many requests|timed? out|timeout|network|connection|econnreset|temporary/.test(text)) {
    return { verdict: 'unknown', reason: 'yt_dlp_transient_failure' };
  }
  return { verdict: 'unknown', reason: 'yt_dlp_unclassified_failure' };
}

export function classifyYtDlpMetadata(
  raw: unknown,
  expectedVideoId: string,
): YouTubeMetadataVerification {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { verdict: 'unknown', reason: 'yt_dlp_invalid_json' };
  }
  const metadata = raw as YtDlpMetadata;
  if (metadata.id !== expectedVideoId) {
    return { verdict: 'unknown', reason: 'yt_dlp_video_identity_mismatch' };
  }

  // yt-dlp does not currently promise one stable Made-for-Kids field. If its
  // extracted metadata supplies any known spelling, a positive value is a
  // hard rejection. Missing optional MFK metadata is not promoted to proof;
  // the Phase 1 authority remains the fields yt-dlp documents below.
  if (
    metadata.is_kids_content === true
    || metadata.made_for_kids === true
    || metadata.self_declared_made_for_kids === true
  ) {
    return { verdict: 'restricted', reason: 'youtube_made_for_kids' };
  }

  const availability = typeof metadata.availability === 'string'
    ? metadata.availability.toLowerCase()
    : '';
  if (availability === 'private') {
    return { verdict: 'private', reason: 'youtube_private' };
  }
  if (['premium_only', 'subscriber_only', 'needs_auth'].includes(availability)) {
    return { verdict: 'restricted', reason: `youtube_${availability}` };
  }
  if (!['public', 'unlisted'].includes(availability)) {
    return { verdict: 'unknown', reason: 'youtube_availability_unknown' };
  }

  if (typeof metadata.age_limit !== 'number' || !Number.isFinite(metadata.age_limit)) {
    return { verdict: 'unknown', reason: 'youtube_age_limit_unknown' };
  }
  if (metadata.age_limit > 0) {
    return { verdict: 'restricted', reason: 'youtube_age_restricted' };
  }
  if (metadata.age_limit < 0) {
    return { verdict: 'unknown', reason: 'youtube_age_limit_invalid' };
  }

  if (metadata.playable_in_embed === false) {
    return { verdict: 'embed_disabled', reason: 'youtube_embed_disabled' };
  }
  if (metadata.playable_in_embed !== true) {
    return { verdict: 'unknown', reason: 'youtube_embed_status_unknown' };
  }
  if (metadata.live_status === 'is_upcoming') {
    return { verdict: 'unknown', reason: 'youtube_upcoming' };
  }
  return { verdict: 'verified', reason: 'yt_dlp_public_embeddable' };
}

/**
 * Ask yt-dlp for only the fields used by the World Hub publication gate.
 * `--skip-download` and the absence of output/format arguments are deliberate
 * safety boundaries: this process verifies metadata and never downloads AV.
 */
export async function verifyYouTubeMetadata(
  videoId: string,
  runner: YtDlpRunner = runVendoredYtDlp,
): Promise<YouTubeMetadataVerification> {
  if (!YOUTUBE_ID.test(videoId)) {
    return { verdict: 'unavailable', reason: 'invalid_youtube_id' };
  }
  const runtime = await checkRuntime(runner);
  if (runtime.verdict !== 'verified') return runtime;

  const result = await runner([
    '-s',
    '-m',
    'yt_dlp',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '--ignore-config',
    '--no-plugin-dirs',
    '--no-cache-dir',
    '--socket-timeout',
    '15',
    '--extractor-retries',
    '1',
    '--retries',
    '1',
    '--print',
    YT_DLP_PRINT_TEMPLATE,
    `https://www.youtube.com/watch?v=${videoId}`,
  ], YT_DLP_METADATA_TIMEOUT_MS);

  if (result.timedOut || result.spawnError) {
    return {
      verdict: 'unknown',
      reason: result.timedOut ? 'yt_dlp_timeout' : 'yt_dlp_execution_error',
    };
  }
  if (result.code !== 0) {
    return classifyYtDlpFailure(`${result.stderr}\n${result.stdout}`);
  }
  try {
    return classifyYtDlpMetadata(JSON.parse(result.stdout), videoId);
  } catch {
    return { verdict: 'unknown', reason: 'yt_dlp_invalid_json' };
  }
}
