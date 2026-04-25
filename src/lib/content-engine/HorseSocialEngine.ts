/**
 * HorseSocialEngine — slim port (friend functions only)
 *
 * Ported from src/content-engine/pipeline/HorseSocialEngine.js (1143 LOC).
 * Only the two friend-management functions used by horses-social-friends
 * are ported here. The rest of the engine (likes, comments, replies,
 * reactions, DMs) stays in the monolith for now — see Task #42 for the
 * full engine port scope.
 */
import { getSupabase } from '../supabase.js';

interface HorseRow {
  id: string;
  name: string;
  profile_id: string;
}

interface ProfileRow {
  id: string;
  username: string | null;
  full_name: string | null;
}

interface PendingRequest {
  id: string;
  user_id: string;
  friend_id: string;
}

/**
 * Each horse sends a few friend requests to other horses or real users
 * (70% bias toward real users). Skip pairs that already have any
 * friendship row in either direction.
 */
export async function sendFriendRequests(maxRequests = 10): Promise<{ sent: number }> {
  const supabase = getSupabase();
  const { data: horsesData } = await supabase
    .from('content_authors')
    .select('id, name, profile_id')
    .eq('is_active', true)
    .not('profile_id', 'is', null);

  const horses = (horsesData ?? []) as HorseRow[];
  if (horses.length < 2) return { sent: 0 };

  const horseIds = horses.map((h) => h.profile_id);

  const { data: realUsersData } = await supabase
    .from('profiles')
    .select('id, username, full_name')
    .not('id', 'in', `(${horseIds.join(',')})`)
    .limit(50);

  const realUsers = (realUsersData ?? []) as ProfileRow[];

  interface Target {
    profile_id: string;
    name: string;
    isHorse: boolean;
  }
  const allTargets: Target[] = [
    ...horses.map((h) => ({ profile_id: h.profile_id, name: h.name, isHorse: true })),
    ...realUsers.map((u) => ({
      profile_id: u.id,
      name: u.full_name ?? u.username ?? 'Unknown',
      isHorse: false,
    })),
  ];

  let requestsSent = 0;

  for (const horse of horses.slice(0, maxRequests * 2)) {
    const targetPool =
      Math.random() < 0.7
        ? allTargets.filter((t) => !t.isHorse && t.profile_id !== horse.profile_id)
        : allTargets.filter((t) => t.profile_id !== horse.profile_id);

    const target = targetPool[Math.floor(Math.random() * targetPool.length)];
    if (!target) continue;

    const { data: existingRows } = await supabase
      .from('friendships')
      .select('id')
      .or(
        `and(user_id.eq.${horse.profile_id},friend_id.eq.${target.profile_id}),and(user_id.eq.${target.profile_id},friend_id.eq.${horse.profile_id})`,
      )
      .limit(1);

    if (existingRows && existingRows.length > 0) continue;

    const { error } = await supabase.from('friendships').insert({
      user_id: horse.profile_id,
      friend_id: target.profile_id,
      status: 'pending',
    });

    if (!error) {
      requestsSent++;
      if (requestsSent >= maxRequests) break;
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  return { sent: requestsSent };
}

/**
 * Accept pending friend requests directed at horses, with 80% acceptance
 * rate. Inserts a reverse friendship row (matches friends.js bidirectional
 * pattern) and sends a "friend_accepted" notification to non-horse senders.
 */
export async function acceptFriendRequests(maxAccepts = 15): Promise<{ accepted: number }> {
  const supabase = getSupabase();

  const { data: horsesData } = await supabase
    .from('content_authors')
    .select('id, name, profile_id')
    .eq('is_active', true)
    .not('profile_id', 'is', null);

  const horses = (horsesData ?? []) as HorseRow[];
  if (horses.length === 0) return { accepted: 0 };

  const horseIds = horses.map((h) => h.profile_id);

  const { data: pendingData } = await supabase
    .from('friendships')
    .select('id, user_id, friend_id')
    .eq('status', 'pending')
    .in('friend_id', horseIds)
    .limit(maxAccepts * 2);

  const pending = (pendingData ?? []) as PendingRequest[];
  if (pending.length === 0) return { accepted: 0 };

  let accepted = 0;

  for (const request of pending) {
    if (Math.random() < 0.8) {
      const { error } = await supabase
        .from('friendships')
        .update({ status: 'accepted' })
        .eq('id', request.id);

      if (!error) {
        // Bidirectional friendship row — best-effort, may already exist
        try {
          await supabase
            .from('friendships')
            .insert({
              user_id: request.friend_id,
              friend_id: request.user_id,
              status: 'accepted',
            });
        } catch (e) {
          console.warn(
            '[HorseSocialEngine] reverse row insert (may exist):',
            e instanceof Error ? e.message : e,
          );
        }

        const senderIsHorse = horses.find((h) => h.profile_id === request.user_id);
        const horse = horses.find((h) => h.profile_id === request.friend_id);
        accepted++;

        // Notify the human sender (horses don't need a notification — they don't read them)
        if (!senderIsHorse) {
          try {
            const { data: horseProfileData } = await supabase
              .from('profiles')
              .select('username, full_name')
              .eq('id', request.friend_id)
              .maybeSingle();

            const horseProfile = horseProfileData as
              | { username: string | null; full_name: string | null }
              | null;
            const horseName =
              horseProfile?.username ?? horseProfile?.full_name ?? horse?.name ?? 'Your Friend';

            await supabase.from('notifications').insert({
              user_id: request.user_id,
              type: 'friend_accepted',
              title: horseName,
              message: 'accepted your friend request',
              actor_id: request.friend_id,
              link: `/hub/user/${horseProfile?.username ?? request.friend_id}`,
              data: { friend_id: request.friend_id },
            });
          } catch (e) {
            console.warn(
              '[HorseSocialEngine] notification insert failed:',
              e instanceof Error ? e.message : e,
            );
          }
        }

        if (accepted >= maxAccepts) break;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return { accepted };
}
