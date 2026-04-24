/**
 * GET/POST /cron/venue-review-prompts
 *
 * Ported from pages/api/cron/venue-review-prompts.js (2026-04-24).
 *
 * Every 6 hours: find check-ins older than 6h that haven't been prompted
 * for a review yet. Send push (currently no-op — see src/lib/push.ts) and
 * flag the row so it doesn't get re-prompted.
 *
 * Idempotence: gates on review_prompt_sent=false, flips to true after
 * send. Double-fire finds nothing to send on the second pass.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { sendPushNotification } from '../lib/push.js';

interface Checkin {
  id: string;
  user_id: string;
  venue_id: string | null;
}

interface Venue {
  id: string;
  name: string;
}

export async function venueReviewPrompts(c: Context) {
  try {
    const supabase = getSupabase();
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    // Note: no FK from user_venue_checkins.venue_id → venues.id, so we do a
    // second-pass lookup manually (matches monolith behavior exactly).
    const { data: eligibleCheckins, error } = await supabase
      .from('user_venue_checkins')
      .select('id, user_id, venue_id')
      .eq('review_prompt_sent', false)
      .eq('review_completed', false)
      .lt('checkin_time', sixHoursAgo)
      .limit(100);

    if (error) {
      console.warn('[venue-review-prompts] fetch error:', error.message);
      return c.json({ success: false, error: 'Database fetch error' }, 500);
    }

    if (!eligibleCheckins || eligibleCheckins.length === 0) {
      return c.json({ success: true, processed: 0, message: 'No pending review prompts.' });
    }

    const checkins = eligibleCheckins as Checkin[];

    // Batch-load venue names for all distinct venue_ids in one shot.
    const venueIds = [...new Set(checkins.map((c) => c.venue_id).filter((x): x is string => !!x))];
    const venueNameById: Record<string, string> = {};
    if (venueIds.length > 0) {
      const { data: venues, error: venuesError } = await supabase
        .from('venues')
        .select('id, name')
        .in('id', venueIds);
      if (venuesError) {
        console.warn('[venue-review-prompts] venue lookup error:', venuesError.message);
      } else if (venues) {
        for (const v of venues as Venue[]) venueNameById[v.id] = v.name;
      }
    }

    let processed = 0;
    for (const checkin of checkins) {
      try {
        const venueName = (checkin.venue_id && venueNameById[checkin.venue_id]) || 'the venue';

        await sendPushNotification(checkin.user_id, 'venue_review', {
          title: '⭐ How was your session?',
          body: `Rate your experience at ${venueName} and earn 50 Diamonds!`,
          url: `/hub/venues/${checkin.venue_id}?action=review`,
        });

        await supabase
          .from('user_venue_checkins')
          .update({ review_prompt_sent: true })
          .eq('id', checkin.id);

        processed++;
      } catch (err) {
        console.warn(
          `[venue-review-prompts] failed for checkin ${checkin.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return c.json({ success: true, processed, message: `Sent ${processed} review prompts.` });
  } catch (err) {
    console.error(
      '[venue-review-prompts] fatal:',
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
}
