/**
 * GET/POST /cron/horses-stories
 *
 * Ported from pages/api/cron/horses-stories.js (285 LOC).
 *
 * Horses post stories TikTok/Instagram-style. 70% video clip stories
 * from ClipLibrary, 30% text-only stories with topical poker thoughts.
 *
 * Per-horse scheduling:
 *   shouldHorseBeActive (±3 min variance from horse's slot)
 *   isHorseActiveHour (within their 12-hour active window)
 *   getHorseActivityRate('post') gates final selection
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { generateComment } from '../lib/content-engine/HumanVoiceEngine.js';
import {
  shouldHorseBeActive,
  isHorseActiveHour,
  getHorseActivityRate,
} from '../lib/content-engine/HorseScheduler.js';
import { getRandomClip, getRandomCaption } from '../lib/content-engine/ClipLibrary.js';

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
  'just watched the sickest cooler on stream',
  'solver vs exploitative, the debate never ends',
  'hot take: 3bet sizing in live poker is way too small',
  'worst beat I have ever seen at a live table',
  'late night grinding is a different kind of focus',
  'position is everything, been saying this for years',
  'flopping the nuts and nobody gives you action',
  'live reads hit different than online tells',
  'bankroll management is the most underrated skill in poker',
  'the river is always the cruelest street',
  'ran into the top of his range again',
  'three-bet or fold is the laziest range construction',
  'the mental game matters more than the technical game',
  'a good session is one where you made good decisions',
  'variance is real and nobody is immune',
];

interface Horse {
  id: string;
  name: string;
  profile_id: string;
  is_active: boolean;
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

async function postVideoStory(horse: Horse): Promise<{ type: string; story_id?: unknown } | null> {
  try {
    const maxAttempts = 5;
    let validClip = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const clip = getRandomClip();
      if (!clip) continue;
      if (await validateYouTubeThumbnail(clip.video_id)) {
        validClip = clip;
        break;
      }
    }
    if (!validClip) return null;

    const rawCaption = getRandomCaption(validClip.category);
    const caption =
      rawCaption && rawCaption.trim().length >= 5
        ? rawCaption.trim()
        : TEXT_STORY_TOPICS[Math.floor(Math.random() * TEXT_STORY_TOPICS.length)] ?? '';

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
      return null;
    }
    return { type: 'video_story', story_id: storyId };
  } catch (e) {
    console.warn('[horses-stories] video story failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

async function postTextStory(horse: Horse): Promise<{ type: string; story_id?: unknown } | null> {
  try {
    const topic = TEXT_STORY_TOPICS[Math.floor(Math.random() * TEXT_STORY_TOPICS.length)] ?? '';
    const gradient = STORY_GRADIENTS[Math.floor(Math.random() * STORY_GRADIENTS.length)];
    const content = generateComment('general', horse.profile_id) || topic;

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
      return null;
    }
    return { type: 'text_story', story_id: storyId };
  } catch (e) {
    console.warn('[horses-stories] text story failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

export async function horsesStories(c: Context) {
  try {
    const supabase = getSupabase();
    const now = new Date();
    const currentMinute = now.getMinutes();
    const currentHour = now.getHours();

    const { data: allHorsesData, error: horseError } = await supabase
      .from('content_authors')
      .select('*')
      .eq('is_active', true)
      .not('profile_id', 'is', null)
      .limit(100);

    if (horseError) {
      console.warn('[horses-stories] horses fetch error:', horseError.message);
      return c.json({ error: horseError.message }, 500);
    }

    const allHorses = (allHorsesData ?? []) as Horse[];
    if (allHorses.length === 0) {
      return c.json({ success: true, message: 'No horses available', posted: 0 });
    }

    const activeHorses = allHorses.filter(
      (h) =>
        shouldHorseBeActive(h.profile_id, currentMinute, 3) &&
        isHorseActiveHour(h.profile_id, currentHour),
    );

    if (activeHorses.length === 0) {
      return c.json({
        success: true,
        message: 'No horses in their active slot this minute',
        posted: 0,
        activeHorses: 0,
      });
    }

    const selectedHorses = activeHorses
      .filter((h) => Math.random() < getHorseActivityRate(h.profile_id, 'post'))
      .slice(0, CONFIG.HORSES_PER_TRIGGER);

    const results: Array<{ horse: string; type?: string; story_id?: unknown; success: boolean }> = [];

    for (const horse of selectedHorses) {
      await new Promise((r) => setTimeout(r, Math.random() * 2000 + 1000));
      const isVideoStory = Math.random() < CONFIG.VIDEO_STORY_PROBABILITY;
      const result = isVideoStory ? await postVideoStory(horse) : await postTextStory(horse);
      results.push({
        horse: horse.name,
        ...(result ?? {}),
        success: !!result,
      });
    }

    const videoStories = results.filter((r) => r.type === 'video_story').length;
    const textStories = results.filter((r) => r.type === 'text_story').length;

    return c.json({
      success: true,
      posted: results.filter((r) => r.success).length,
      video_stories: videoStories,
      text_stories: textStories,
      results,
      timestamp: now.toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[horses-stories] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
