import { describe, it, expect, vi } from 'vitest';
import { videoLibraryReels, extractYouTubeId } from './video-library-reels.js';

// Rows the mocked client hands back. Module-level so each test can reassign
// them before invoking the handler.
let reelRows: Array<{ id: string; video_url: string | null; caption: string | null }> = [];
let videoRows: Array<{ youtube_video_id: string | null; title: string | null }> = [];
const updates: Array<{ id: string; caption: string }> = [];
const inserts: Array<Record<string, unknown>> = [];
let engineOn = true;

vi.mock('../lib/content-engine/Fleet.js', () => ({
  engineEnabled: () => Promise.resolve(engineOn),
}));

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (col: string, val: string) => {
        // update().eq('id', …) is the terminal call on the write path
        if (chain.__pendingCaption !== undefined && col === 'id') {
          updates.push({ id: val, caption: chain.__pendingCaption as string });
          chain.__pendingCaption = undefined;
          return Promise.resolve({ error: null });
        }
        return chain;
      };
      chain.limit = () =>
        Promise.resolve({
          data: table === 'social_reels' ? reelRows : videoRows,
          error: null,
        });
      chain.update = (patch: { caption: string }) => {
        chain.__pendingCaption = patch.caption;
        return chain;
      };
      chain.insert = (row: Record<string, unknown>) => {
        inserts.push(row);
        return Promise.resolve({ error: null });
      };
      return chain;
    },
  }),
}));

const makeCtx = (query: Record<string, string> = {}) => {
  let captured: { body?: unknown; status?: number } = {};
  return {
    req: { method: 'GET', query: (k: string) => query[k] },
    json: (body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return captured;
    },
    get captured() {
      return captured;
    },
  } as unknown as Parameters<typeof videoLibraryReels>[0] & {
    readonly captured: { body: Record<string, number | boolean>; status: number };
  };
};

const reset = () => {
  engineOn = true;
  reelRows = [];
  videoRows = [];
  updates.length = 0;
  inserts.length = 0;
};

describe('extractYouTubeId', () => {
  it('handles all three URL shapes the python matched', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=AAAAAAAAAAA')).toBe('AAAAAAAAAAA');
    expect(extractYouTubeId('https://www.youtube.com/embed/BBBBBBBBBBB')).toBe('BBBBBBBBBBB');
    expect(extractYouTubeId('https://www.youtube.com/shorts/CCCCCCCCCCC')).toBe('CCCCCCCCCCC');
  });

  it('truncates to 11 chars and drops trailing params, as the python did', () => {
    expect(extractYouTubeId('https://youtu.be/watch?v=AAAAAAAAAAA&t=42')).toBe('AAAAAAAAAAA');
    expect(extractYouTubeId('https://www.youtube.com/watch?v=AAAAAAAAAAAEXTRA')).toBe('AAAAAAAAAAA');
  });

  it('returns null rather than throwing on junk', () => {
    expect(extractYouTubeId(null)).toBeNull();
    expect(extractYouTubeId(undefined)).toBeNull();
    expect(extractYouTubeId('')).toBeNull();
    expect(extractYouTubeId('https://example.com/not-a-video')).toBeNull();
  });
});

describe('videoLibraryReels', () => {
  it('does nothing when the fleet master switch is off', async () => {
    reset();
    engineOn = false;
    reelRows = [{ id: 'r1', video_url: 'https://youtube.com/watch?v=AAAAAAAAAAA', caption: 'old' }];
    videoRows = [{ youtube_video_id: 'AAAAAAAAAAA', title: 'new title' }];

    const ctx = makeCtx();
    await videoLibraryReels(ctx);

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
    expect(ctx.captured.body).toMatchObject({ success: true, skipped: 'engine_disabled' });
  });

  it('updates a caption when the title has drifted', async () => {
    reset();
    reelRows = [{ id: 'r1', video_url: 'https://youtube.com/watch?v=AAAAAAAAAAA', caption: 'old' }];
    videoRows = [{ youtube_video_id: 'AAAAAAAAAAA', title: 'new title' }];

    const ctx = makeCtx();
    await videoLibraryReels(ctx);

    expect(updates).toEqual([{ id: 'r1', caption: 'new title' }]);
    expect(ctx.captured.body).toMatchObject({ success: true, mismatched: 1, updated: 1 });
  });

  it('is idempotent — an already-correct caption is skipped, not rewritten', async () => {
    reset();
    reelRows = [{ id: 'r1', video_url: 'https://youtube.com/watch?v=AAAAAAAAAAA', caption: 'same' }];
    videoRows = [{ youtube_video_id: 'AAAAAAAAAAA', title: 'same' }];

    const ctx = makeCtx();
    await videoLibraryReels(ctx);

    expect(updates).toEqual([]);
    expect(ctx.captured.body).toMatchObject({ mismatched: 0, updated: 0, skipped: 1 });
  });

  it('ignores whitespace-only differences, matching the python trim', async () => {
    reset();
    reelRows = [{ id: 'r1', video_url: 'https://youtube.com/watch?v=AAAAAAAAAAA', caption: ' t ' }];
    videoRows = [{ youtube_video_id: 'AAAAAAAAAAA', title: 't' }];

    await videoLibraryReels(makeCtx());

    expect(updates).toEqual([]);
  });

  it('writes nothing in dry_run but still reports the mismatch', async () => {
    reset();
    reelRows = [{ id: 'r1', video_url: 'https://youtube.com/watch?v=AAAAAAAAAAA', caption: 'old' }];
    videoRows = [{ youtube_video_id: 'AAAAAAAAAAA', title: 'new' }];

    const ctx = makeCtx({ dry_run: '1' });
    await videoLibraryReels(ctx);

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
    expect(ctx.captured.body).toMatchObject({ dry_run: true, mismatched: 1, updated: 1 });
  });

  it('skips videos with no matching reel, no id, or an empty title', async () => {
    reset();
    reelRows = [{ id: 'r1', video_url: 'https://example.com/nope', caption: 'old' }];
    videoRows = [
      { youtube_video_id: 'AAAAAAAAAAA', title: 'orphan' },
      { youtube_video_id: null, title: 'no id' },
      { youtube_video_id: 'BBBBBBBBBBB', title: '' },
    ];

    const ctx = makeCtx();
    await videoLibraryReels(ctx);

    expect(updates).toEqual([]);
    expect(ctx.captured.body).toMatchObject({ reels_with_video_id: 0, skipped: 3 });
  });

  it('records an audit row only when it actually changed something', async () => {
    reset();
    reelRows = [{ id: 'r1', video_url: 'https://youtube.com/watch?v=AAAAAAAAAAA', caption: 'old' }];
    videoRows = [{ youtube_video_id: 'AAAAAAAAAAA', title: 'new' }];
    await videoLibraryReels(makeCtx());
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ table_name: 'social_reels', action: 'caption_sync' });

    reset();
    reelRows = [{ id: 'r1', video_url: 'https://youtube.com/watch?v=AAAAAAAAAAA', caption: 'same' }];
    videoRows = [{ youtube_video_id: 'AAAAAAAAAAA', title: 'same' }];
    await videoLibraryReels(makeCtx());
    expect(inserts).toEqual([]);
  });
});
