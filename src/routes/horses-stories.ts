/**
 * GET/POST /cron/horses-stories
 *
 * Ported from pages/api/cron/horses-stories.js (285 LOC).
 *
 * Horses post stories TikTok/Instagram-style. 70% video clip stories
 * from ClipLibrary, 30% text-only stories with topical poker thoughts.
 *
 * Phase 2 (2026-09-06): captions and text stories are written by VoiceWriter
 * from a brief, in the horse's own style, and checked against the phrase
 * ledger. This was the last route still drawing from the old category-keyed
 * pools and the 15 fixed TEXT_STORY_TOPICS sentences, at 48 fires a day.
 *
 * Fail closed (2026-09-30, first hour of the engine being back on): when the
 * writer has nothing it is willing to say (stale ledger, below the floor, a
 * refused brief) the horse posts NO story. The text path used to fall back
 * to the seed sentence itself, which is exactly the fixed-pool behaviour
 * Phase 2 removed; the video path returned nothing without saying why. Every
 * outcome now carries a reason and the run counts them (skip_reasons), so a
 * quiet fire is visible as a decision, not an absence.
 *
 * Per-horse scheduling (2026-09-05, whole fleet):
 *   isOnlineNow (awake window in the horse's own timezone, on an online day)
 *   getHorseActivityRate('post') gates final selection
 *   the roster is shuffled so the two picks per fire are not always the
 *   same two horses at the front of it.
 * The old `.limit(100)` with no order (an arbitrary hundred that changed
 * per request) is gone; see FleetScheduler.ts.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { writeCaption, writeStory } from '../lib/content-engine/VoiceWriter.js';
import { getHorseActivityRate } from '../lib/content-engine/HorseScheduler.js';
import { isOnlineNow } from '../lib/content-engine/FleetScheduler.js';
import { loadFleet, engineEnabled } from '../lib/content-engine/Fleet.js';
import { candidateClips } from '../lib/content-engine/ClipSupply.js';


const CONFIG = {
  HORSES_PER_TRIGGER: 2,
  VIDEO_STORY_PROBABILITY: 0.7,
} as const;

const STORY_GRADIENTS = [
  'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
  'linear-gradient(135deg, #000000 0%, #1a1a1a 100%)',
  'linear-gradient(135deg, #1877F2 0%, #0a5dc2 100%)',
  'linear-gradient(135deg, #D4AF37 0%, #AA8C2C 50%, #6B5B1E 100%)',
  'linear-gradient(135deg, #134E5E 0%, #71B280 100%)',
  'linear-gradient(135deg, #833AB4 0%, #FD1D1D 50%, #FCB045 100%)',
];

const TEXT_STORY_TOPICS = [
  'Just watched the sickest cooler on stream.',
  'Solver vs exploitative, the debate never ends.',
  'Hot take: 3bet sizing in live poker is way too small.',
  'Worst beat I have ever seen at a live table.',
  'Late night grinding is a different kind of focus.',
  'Position is everything, been saying this for years.',
  'Flopping the nuts and nobody gives you action.',
  'Live reads hit different than online tells.',
  'Bankroll management is the most underrated skill in poker.',
  'The river is always the cruelest street.',
  'Ran into the top of his range again.',
  'Three-bet or fold is the laziest range construction.',
  'The mental game matters more than the technical game.',
  'A good session is one where you made good decisions.',
  'Variance is real and nobody is immune.',
];


interface Horse {
  id: string | number;
  name: string;
  profile_id: string;
  timezone?: string | null;
  is_active?: boolean;
}

/** One horse's attempt: a story, or the reason there is none. */
export type StoryOutcome =
  | { ok: true; type: 'video_story' | 'text_story'; story_id: string }
  | { ok: false; reason: string };

function writerReason(prefix: string, written: { skipReason?: string; stale?: boolean; belowFloor?: boolean }): string {
  if (written.skipReason) return `${prefix}_${written.skipReason}`;
  if (written.stale) return `${prefix}_stale`;
  if (written.belowFloor) return `${prefix}_below_floor`;
  return `${prefix}_empty`;
}

async function validateYouTubeThumbnail(videoId: string): Promise<boolean> {
  try {
    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    const response = await fetch(thumbnailUrl, { method: 'HEAD' });
    if (!response.ok) return false;
    const imageResponse = await fetch(thumbnailUrl);
    const buffer = await imageResponse.arrayBuffer();
    const sizeKB = buffer.byteLength / 1024;
    return sizeKB > 10;
  } catch (e) {
    console.warn('[horses-stories] thumbnail validation failed:', e instanceof Error ? e.message : e);
    return false;
  }
}

async function postVideoStory(horse: Horse): Promise<StoryOutcome> {
  try {
    // Phase 4: the same renewing supply the feed draws from, and the same
    // per-horse slice, so a horse's stories and its posts come from the
    // channels that horse actually follows. This used to be getRandomClip()
    // over the 150-literal array, which is how a story could show a video
    // that had been deleted since April.
    const { clips: pool } = await candidateClips('poker', horse.profile_id);
    let validClip = null;
    for (let attempt = 0; attempt < 5 && pool.length > 0; attempt++) {
      const idx = Math.floor(Math.random() * pool.length);
      const clip = pool[idx]!;
      pool.splice(idx, 1);
      if (await validateYouTubeThumbnail(clip.video_id)) {
        validClip = clip;
        break;
      }
    }
    if (!validClip) return { ok: false, reason: pool.length === 0 ? 'no_clip' : 'no_valid_thumbnail' };

    // Phase 2 (2026-09-06): the story caption is written from a brief of THIS
    // clip in this horse's own style, like every other surface. It used to
    // draw from the same category-keyed pools the feed used, which is how one
    // sentence reached 26 horses in a month.
    const written = await writeCaption(horse as never, {
      kind: 'video',
      title: validClip.title || '',
      source: validClip.source ?? null,
      domainHint: 'poker',
    });
    const caption = written.text;
    if (!caption || caption.trim().length < 3) return { ok: false, reason: writerReason('caption', written) };


    const thumbnailUrl = `https://img.youtube.com/vi/${validClip.video_id}/hqdefault.jpg`;

    const { data: storyId, error } = await getSupabase().rpc('fn_create_story', {
      p_user_id: horse.profile_id,
      p_content: caption,
      p_media_url: thumbnailUrl,
      p_media_type: 'image',
      p_background_color: null,
      p_link_url: validClip.source_url,
    });

    if (error) {
      console.warn('[horses-stories] story creation failed:', error.message);
      return { ok: false, reason: 'rpc_error' };
    }
    // fn_create_story returns NULL instead of raising when it refuses a row.
    if (!storyId) return { ok: false, reason: 'rpc_refused' };
    return { ok: true, type: 'video_story', story_id: String(storyId) };
  } catch (e) {
    console.warn('[horses-stories] video story failed:', e instanceof Error ? e.message : e);
    return { ok: false, reason: 'video_story_threw' };
  }
}

async function postTextStory(horse: Horse): Promise<StoryOutcome> {
  try {
    // Phase 2 (2026-09-06): the seed still supplies the subject, but the
    // sentence is composed and styled per horse and checked against the
    // phrase ledger, so 15 seeds stop being 15 sentences across the fleet.
    // Stories were the last route on the old pools: 48 fires a day.
    const seed = TEXT_STORY_TOPICS[Math.floor(Math.random() * TEXT_STORY_TOPICS.length)] ?? '';
    const gradient = STORY_GRADIENTS[Math.floor(Math.random() * STORY_GRADIENTS.length)];
    const written = await writeStory(horse as never, seed, 'poker');
    // The seed is a subject for the writer, never a sentence for the feed:
    // when the writer declines, the horse says nothing.
    const raw = written.text ?? '';
    if (!raw.trim()) return { ok: false, reason: writerReason('story', written) };
    const content = raw.charAt(0).toUpperCase() + raw.slice(1);

    const { data: storyId, error } = await getSupabase().rpc('fn_create_story', {
      p_user_id: horse.profile_id,
      p_content: content,
      p_media_url: null,
      p_media_type: null,
      p_background_color: gradient,
      p_link_url: null,
    });

    if (error) {
      console.warn('[horses-stories] text story creation failed:', error.message);
      return { ok: false, reason: 'rpc_error' };
    }
    if (!storyId) return { ok: false, reason: 'rpc_refused' };
    return { ok: true, type: 'text_story', story_id: String(storyId) };
  } catch (e) {
    console.warn('[horses-stories] text story failed:', e instanceof Error ? e.message : e);
    return { ok: false, reason: 'text_story_threw' };
  }
}

export async function horsesStories(c: Context) {
  try {
    const now = new Date();

    if (!(await engineEnabled())) {
      return c.json({ success: true, skipped: 'engine_disabled', timestamp: now.toISOString() });
    }

    let allHorses: Horse[];
    try {
      allHorses = (await loadFleet()) as unknown as Horse[];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[horses-stories] horses fetch error:', msg);
      return c.json({ error: msg }, 500);
    }
    if (allHorses.length === 0) {
      return c.json({ success: true, message: 'No horses available', posted: 0 });
    }

    const activeHorses = allHorses.filter((h) => isOnlineNow(h.profile_id, h.timezone, now));
    for (let i = activeHorses.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [activeHorses[i], activeHorses[j]] = [activeHorses[j]!, activeHorses[i]!];
    }

    if (activeHorses.length === 0) {
      return c.json({
        success: true,
        message: 'No horses online this hour',
        posted: 0,
        activeHorses: 0,
      });
    }

    const selectedHorses = activeHorses
      .filter((h) => Math.random() < getHorseActivityRate(h.profile_id, 'post'))
      .slice(0, CONFIG.HORSES_PER_TRIGGER);

    const results: Array<{ horse: string; type?: string; story_id?: string; success: boolean; reason?: string }> = [];
    const skipReasons: Record<string, number> = {};

    for (const horse of selectedHorses) {
      await new Promise((r) => setTimeout(r, Math.random() * 2000 + 1000));
      const isVideoStory = Math.random() < CONFIG.VIDEO_STORY_PROBABILITY;
      const outcome = isVideoStory ? await postVideoStory(horse) : await postTextStory(horse);
      if (outcome.ok) {
        results.push({ horse: horse.name, type: outcome.type, story_id: outcome.story_id, success: true });
      } else {
        skipReasons[outcome.reason] = (skipReasons[outcome.reason] ?? 0) + 1;
        results.push({ horse: horse.name, success: false, reason: outcome.reason });
      }
    }

    const videoStories = results.filter((r) => r.type === 'video_story').length;
    const textStories = results.filter((r) => r.type === 'text_story').length;

    return c.json({
      success: true,
      selected: selectedHorses.length,
      posted: results.filter((r) => r.success).length,
      video_stories: videoStories,
      text_stories: textStories,
      // Every horse that posted nothing says why (writer declined, no clip,
      // the story RPC refused); a quiet fire is a decision, not an absence.
      skip_reasons: skipReasons,
      results,
      timestamp: now.toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[horses-stories] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
