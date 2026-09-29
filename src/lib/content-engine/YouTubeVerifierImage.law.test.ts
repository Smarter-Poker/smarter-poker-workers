import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PINNED_YT_DLP_VERSION } from './YouTubeMetadataVerifier.js';

const rootUrl = new URL('../../../', import.meta.url);

function read(path: string): string {
  return fs.readFileSync(fileURLToPath(new URL(path, rootUrl)), 'utf8');
}

describe('YouTube verifier production image contract', () => {
  it('hash-locks the exact yt-dlp release used by the verifier', () => {
    const requirements = read('scripts/youtube-verifier/yt-dlp.requirements.txt');
    const version = read('scripts/youtube-verifier/yt-dlp.version').trim();
    expect(version).toBe(PINNED_YT_DLP_VERSION);
    expect(requirements).toContain(`yt-dlp==${PINNED_YT_DLP_VERSION}`);
    expect(requirements).toContain(
      '--hash=sha256:1d57897e94c6665a0a6f9bc54b34e584284e32c034ffab3a7df25d8f7b24eedf',
    );
  });

  it('installs during image build and proves the runtime executable after the final-stage copy', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('FROM python:3.12-alpine AS youtube-verifier');
    expect(dockerfile).toContain('--no-deps');
    expect(dockerfile).toContain('--require-hashes');
    expect(dockerfile).toContain('--target /verifier/vendor');
    expect(dockerfile).toContain('apk add --no-cache dumb-init curl python3');
    expect(dockerfile).toContain('COPY --from=youtube-verifier --chown=workers:workers /verifier/vendor /opt/ytdlp/vendor');
    expect(dockerfile).toContain('PYTHONPATH=/opt/ytdlp/vendor /usr/bin/python3 -s -m yt_dlp --version');
    expect(dockerfile).toContain('ENV YT_DLP_PYTHON=/usr/bin/python3');
    expect(dockerfile).toContain('ENV YT_DLP_VENDOR_ROOT=/opt/ytdlp/vendor');
  });

  it('keeps the runtime probe metadata-only and credential-free', () => {
    const verifier = read('src/lib/content-engine/YouTubeMetadataVerifier.ts');
    expect(verifier).toContain("'--skip-download'");
    expect(verifier).toContain("'--no-playlist'");
    expect(verifier).toContain("'--ignore-config'");
    expect(verifier).toContain("'--no-plugin-dirs'");
    expect(verifier).toContain("'--no-cache-dir'");
    expect(verifier).not.toMatch(/'--cookies(?:-from-browser)?'/);
    expect(verifier).not.toMatch(/'--(?:output|format|username|password)'/);
  });
});
