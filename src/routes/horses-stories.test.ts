/**
 * Stories fail closed (2026-09-30, the first hour of the engine being on).
 *
 *   - when the story writer declines, the horse posts nothing: the seed
 *     sentence never reaches fn_create_story (it used to);
 *   - a video story with no clip, or with a caption the writer would not
 *     sign, is a counted skip;
 *   - fn_create_story returning NULL is a refusal, not a story;
 *   - every quiet horse carries a reason and the run counts them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  writeStory: vi.fn(),
  writeCaption: vi.fn(),
  candidateClips: vi.fn(),
  random: [] as number[],
}));

vi.mock('../lib/supabase.js', () => ({ getSupabase: () => ({ rpc: m.rpc }) }));
vi.mock('../lib/content-engine/Fleet.js', () => ({
  engineEnabled: vi.fn(async () => true),
  loadFleet: vi.fn(async () => [
    { id: 1, name: 'Horse a', profile_id: 'pid-a', timezone: 'UTC' },
    { id: 2, name: 'Horse b', profile_id: 'pid-b', timezone: 'UTC' },
  ]),
}));
vi.mock('../lib/content-engine/FleetScheduler.js', () => ({ isOnlineNow: () => true }));
vi.mock('../lib/content-engine/HorseScheduler.js', () => ({ getHorseActivityRate: () => 1 }));
vi.mock('../lib/content-engine/VoiceWriter.js', () => ({ writeStory: m.writeStory, writeCaption: m.writeCaption }));
vi.mock('../lib/content-engine/ClipSupply.js', () => ({ candidateClips: m.candidateClips }));

import { horsesStories } from './horses-stories.js';

async function run() {
  const app = new Hono();
  app.get('/cron/horses-stories', horsesStories);
  const res = await app.request('/cron/horses-stories');
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// Math.random drives, in order: the roster shuffle (one draw for two horses),
// the activity gate (one per horse), then per horse the pacing delay (0 gives
// the one-second minimum), the video/text choice (below
// VIDEO_STORY_PROBABILITY is video), and on the text path the seed and the
// gradient picks. The queue makes the whole run deterministic.
function fixRandom(path: 'text' | 'video') {
  const perHorse = path === 'text' ? [0, 0.95, 0.5, 0.5] : [0, 0.1];
  m.random = [0.5, 0.5, 0.5, ...perHorse, ...perHorse];
  vi.spyOn(Math, 'random').mockImplementation(() => (m.random.length ? m.random.shift()! : 0.5));
}

beforeEach(() => {
  m.rpc.mockReset();
  m.writeStory.mockReset();
  m.writeCaption.mockReset();
  m.candidateClips.mockReset();
  m.random = [];
  m.rpc.mockResolvedValue({ data: 'story-1', error: null });
  m.candidateClips.mockResolvedValue({ clips: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a declined text story posts nothing', () => {
  it('never sends the seed sentence to fn_create_story when the writer returns no text', async () => {
    fixRandom('text');
    m.writeStory.mockResolvedValue({ text: '', stale: true, belowFloor: false, attempts: 3 });
    const r = await run();
    expect(r.status).toBe(200);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({ success: true, selected: 2, posted: 0, text_stories: 0, skip_reasons: { story_stale: 2 } });
    const results = r.body.results as Array<Record<string, unknown>>;
    expect(results.map((x) => x.reason)).toEqual(['story_stale', 'story_stale']);
  });

  it('names the composer refusal when the writer gives one', async () => {
    fixRandom('text');
    m.writeStory.mockResolvedValue({ text: '', skipReason: 'ungrounded', stale: false, belowFloor: false, attempts: 1 });
    const r = await run();
    expect(m.rpc).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({ posted: 0, skip_reasons: { story_ungrounded: 2 } });
  });

  it('posts the written text, capitalised, when the writer signs it', async () => {
    fixRandom('text');
    m.writeStory.mockResolvedValue({ text: 'river is the cruellest street, again', stale: false, belowFloor: false, attempts: 1 });
    const r = await run();
    expect(m.rpc).toHaveBeenCalledTimes(2);
    expect(m.rpc.mock.calls[0]![0]).toBe('fn_create_story');
    expect(m.rpc.mock.calls[0]![1]).toMatchObject({ p_user_id: 'pid-a', p_content: 'River is the cruellest street, again', p_media_url: null });
    expect(r.body).toMatchObject({ posted: 2, text_stories: 2, video_stories: 0, skip_reasons: {} });
  });

  it('counts a NULL from fn_create_story as a refusal, not a story', async () => {
    fixRandom('text');
    m.writeStory.mockResolvedValue({ text: 'still grinding', stale: false, belowFloor: false, attempts: 1 });
    m.rpc.mockResolvedValue({ data: null, error: null });
    const r = await run();
    expect(r.body).toMatchObject({ posted: 0, skip_reasons: { rpc_refused: 2 } });
  });
});

describe('a video story with nothing to show posts nothing', () => {
  it('counts an empty clip pool', async () => {
    fixRandom('video');
    const r = await run();
    expect(m.writeCaption).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({ posted: 0, skip_reasons: { no_clip: 2 } });
  });
});
