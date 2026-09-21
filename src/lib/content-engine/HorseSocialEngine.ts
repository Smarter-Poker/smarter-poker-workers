// @ts-nocheck — JS-port file, runtime behavior verified against monolith JS source

/**
 * HorseSocialEngine — Phase 2B.2-followup full port (2026-04-26)
 *
 * Ported from src/content-engine/pipeline/HorseSocialEngine.js (1162 LOC).
 *
 * Replaces the earlier slim port (only 2 friend functions). Now includes
 * ALL social interaction functions: friend requests, comments, likes,
 * replies, reactions, plus the orchestration runner.
 *
 * Functions:
 *   sendFriendRequests(maxRequests)
 *   acceptFriendRequests(maxAccepts)
 *   commentOnPosts(maxComments, includeRealUsers)
 *   likePosts(maxLikes, includeRealUsers)
 *   replyToComments(maxReplies)
 *   reactToComments(maxReactions)
 *   runSocialInteractions(options)
 */

/**
 * 🐴 HORSE SOCIAL ENGINE - Automated Social Interactions
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Makes Horses interact with each other autonomously:
 * - Friend requests (send, accept)
 * - Comments on each other's posts
 * - Likes on posts
 * - Responses to comments
 * 
 * Uses per-horse scheduling so each horse acts on its own unique time slot,
 * preventing all horses from acting simultaneously.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { getSupabase } from '../supabase.js';
import { pagedSelect } from '../pagedSelect.js';
import { getHorseActivityRate } from './HorseScheduler.js';
import { isOnlineNow } from './FleetScheduler.js';
import { loadFleet, engineEnabled } from './Fleet.js';
import { writeComment, writeReply, recordBrief, recordThreadTurn } from './VoiceWriter.js';
import { tagCandidateFor } from './FriendGraph.js';
import { normalizePhrase, recordPhrase, ledgerReadFailureTotal } from './ContentLedger.js';
import { decideReply, composerReason, type ThreadComment } from './ReplyEngine.js';

// 2026-09-05: every per-run cap below (maxComments, maxLikes...) breaks out of a
// loop over activeHorses. With the whole fleet eligible that loop would always
// serve the same horses at the front of the roster, so the roster is shuffled
// first. Fisher-Yates; sort(() => Math.random() - 0.5) is biased.
function shuffleHorses<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
}

// Lazy-init Supabase client (RAT-AUTH-NUCLEAR compliant)
// Prevents "supabaseKey is required" crash when env vars aren't yet available at module load
// Helper function to send PWA push notifications to real users for social interactions
async function sendSocialPush(targetId, horseIds, title, message, urlString) {
    if (!targetId || horseIds.includes(targetId)) return; // Do not push to other horses

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://smarter.poker';
    const finalUrl = urlString.startsWith('http') ? urlString : `${baseUrl}${urlString}`;

    try {
        await fetch(`${baseUrl}/api/notifications/send`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
            },
            body: JSON.stringify({
                title,
                message,
                url: finalUrl,
                externalUserIds: [targetId],
                category: 'social_mentions'
            })
        });
    } catch (e) {
        console.warn('Failed to send social interaction push:', e.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTHENTIC COMMENT TEMPLATES (100+ phrases)
// ═══════════════════════════════════════════════════════════════════════════

// Horse personality modifiers for comments

// ═══════════════════════════════════════════════════════════════════════════
// ANTI-SPAM GUARD SYSTEM - Database backed for persistence
// ═══════════════════════════════════════════════════════════════════════════

// Daily limits per horse - prevent unrealistic spam
const DAILY_LIMITS = {
    likes: 50,        // Max 50 likes per day per horse
    comments: 15,     // Max 15 comments per day per horse  
    replies: 10,      // Max 10 replies per day per horse
    friend_requests: 5 // Max 5 friend requests per day per horse
};

// Cooldowns in milliseconds - minimum time between same interaction type
const COOLDOWNS = {
    like_same_post: 24 * 60 * 60 * 1000,  // Can't like same post twice in 24h
    comment_same_post: 6 * 60 * 60 * 1000, // Can't comment on same post twice in 6h
    reply_same_comment: 12 * 60 * 60 * 1000, // Can't reply to same comment twice in 12h
    like_same_author: 30 * 60 * 1000,  // Wait 30min before liking same author again
    comment_same_author: 2 * 60 * 60 * 1000, // Wait 2h before commenting on same author again
};

// Check if horse has hit daily limit
//
// 2026-09-21 (P2C-09): fails closed. A count that could not be read came back
// as 0, "well under the limit", so a database hiccup lifted the cap for the
// whole run. The caller now learns the read failed, skips, and counts it.
async function checkDailyLimit(horseProfileId, actionType): Promise<'within' | 'reached' | 'unreadable'> {
    const today = new Date().toISOString().split('T')[0];

    // Check different tables based on action type
    let count = 0;
    let unreadable = false;

    if (actionType === 'likes') {
        const { count: likeCount, error } = await getSupabase()
            .from('social_likes')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', horseProfileId)
            .gte('created_at', today);
        unreadable = Boolean(error) || typeof likeCount !== 'number';
        count = likeCount || 0;
    } else if (actionType === 'comments' || actionType === 'replies') {
        const { count: commentCount, error } = await getSupabase()
            .from('social_comments')
            .select('*', { count: 'exact', head: true })
            .eq('author_id', horseProfileId)
            .gte('created_at', today);
        unreadable = Boolean(error) || typeof commentCount !== 'number';
        count = commentCount || 0;
    } else if (actionType === 'friend_requests') {
        const { count: friendCount, error } = await getSupabase()
            .from('friendships')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', horseProfileId)
            .gte('created_at', today);
        unreadable = Boolean(error) || typeof friendCount !== 'number';
        count = friendCount || 0;
    }

    if (unreadable) {
        console.warn(`[HorseSocial] daily ${actionType} count unreadable; skipping this horse`);
        return 'unreadable';
    }
    const limit = DAILY_LIMITS[actionType] || 20;
    return count < limit ? 'within' : 'reached';
}

// Check cooldown - has horse interacted with this target recently?
//
// 2026-09-21 (P2C-09): fails closed. `!data` used to mean "no recent
// interaction", so a failed read waved the horse through and an outage turned
// into repeat comments and replies on the same post. Unreadable now means
// cooling down, and the caller counts it.
async function checkCooldown(horseProfileId, targetId, actionType): Promise<'clear' | 'cooling' | 'unreadable'> {
    let cooldownMs;
    let tableName;
    let targetColumn;

    if (actionType === 'like_post') {
        cooldownMs = COOLDOWNS.like_same_post;
        tableName = 'social_likes';
        targetColumn = 'post_id';
    } else if (actionType === 'comment_post') {
        cooldownMs = COOLDOWNS.comment_same_post;
        tableName = 'social_comments';
        targetColumn = 'post_id';
    } else if (actionType === 'reply_comment') {
        cooldownMs = COOLDOWNS.reply_same_comment;
        tableName = 'social_comments';
        targetColumn = 'parent_id';
    } else {
        return 'clear'; // No cooldown defined, allow
    }

    const cutoffTime = new Date(Date.now() - cooldownMs).toISOString();

    const { data, error } = await getSupabase()
        .from(tableName)
        .select('id')
        .eq(targetColumn === 'post_id' ? (tableName === 'social_likes' ? 'post_id' : 'post_id') : 'parent_id', targetId)
        .eq(tableName === 'social_likes' ? 'user_id' : 'author_id', horseProfileId)
        .gte('created_at', cutoffTime)
        .limit(1);

    if (error || !Array.isArray(data)) {
        console.warn(`[HorseSocial] ${actionType} cooldown unreadable; treating as cooling down:`, error?.message ?? 'no rows returned');
        return 'unreadable';
    }
    return data.length === 0 ? 'clear' : 'cooling'; // clear when no recent interaction
}

// ═══════════════════════════════════════════════════════════════════════════
// RUN GUARDS (2026-09-21 recertification)
// ═══════════════════════════════════════════════════════════════════════════

/** Why a step did not write, by reason. Returned as `skip_reasons`. */
type SkipReasons = Record<string, number>;

function bump(skips: SkipReasons, reason: string, n = 1): void {
    skips[reason] = (skips[reason] ?? 0) + n;
}

function describeError(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/**
 * The whole roster (A1). Every step used to read content_authors with no
 * .range(), and PostgREST answers that with at most 1,000 rows. The fleet is
 * exactly 1,000 today, so horse 1,001 would silently have had no likes,
 * comments, replies, reactions or friend requests. loadFleet() pages.
 * Null when it cannot be read: a step that cannot establish who the horses
 * are does nothing.
 */
async function rosterOrNull(step: string) {
    try {
        return await loadFleet();
    } catch (e) {
        console.warn(`[HorseSocial] ${step}: roster unreadable, skipping:`, describeError(e));
        return null;
    }
}

/**
 * The kill switch, re-read between steps and before every write (D2). It was
 * read once at the top of the route, so turning the engine off did nothing to
 * a run already in its loops, and a run can write for up to 540s.
 * engineEnabled() fails closed and caches for 30s, so this is one read per
 * half minute, not one per write.
 */
async function switchStillOn(): Promise<boolean> {
    try {
        return await engineEnabled();
    } catch (e) {
        console.warn('[HorseSocial] engine switch unreadable; stopping:', describeError(e));
        return false;
    }
}

/**
 * Live content only (P2C-04): not soft-deleted, public, not flagged. A horse
 * must never answer something a person can no longer see.
 */
function liveSocialPosts(query) {
    return query.eq('is_deleted', false).eq('visibility', 'public').eq('is_flagged', false);
}

function liveSocialComments(query) {
    return query.eq('is_deleted', false).eq('is_flagged', false);
}

type Liveness = 'live' | 'gone' | 'unreadable';

/** The post, re-read immediately before a comment or reply is written. */
async function postLiveness(postId: string): Promise<Liveness> {
    const { data, error } = await getSupabase()
        .from('social_posts')
        .select('id, is_deleted, visibility, is_flagged')
        .eq('id', postId)
        .maybeSingle();
    if (error) return 'unreadable';
    if (!data) return 'gone';
    return data.is_deleted === false && data.visibility === 'public' && data.is_flagged === false ? 'live' : 'gone';
}

/** The comment being answered, re-read immediately before the reply is written. */
async function commentLiveness(commentId: string, postId: string): Promise<Liveness> {
    const { data, error } = await getSupabase()
        .from('social_comments')
        .select('id, post_id, is_deleted, is_flagged')
        .eq('id', commentId)
        .maybeSingle();
    if (error) return 'unreadable';
    if (!data) return 'gone';
    return data.post_id === postId && data.is_deleted === false && data.is_flagged === false ? 'live' : 'gone';
}

/**
 * Ledger reads that failed during a step. Each one blocked a draft (the
 * ledger fails closed), so they are reported with the step's skips. The
 * counter is per process, so a concurrent run can add to it.
 */
function noteLedgerFailures(skips: SkipReasons, before: number): void {
    const failed = ledgerReadFailureTotal() - before;
    if (failed > 0) bump(skips, 'ledger_unreadable', failed);
}

// Get random delay for natural pacing (1-5 seconds)
function getRandomDelay() {
    return 1000 + Math.random() * 4000;
}

// Add randomness to skip some actions (makes behavior less robotic)
function shouldAct(probability = 0.7) {
    return Math.random() < probability;
}

// ═══════════════════════════════════════════════════════════════════════════
// FRIEND REQUEST ENGINE
// ═══════════════════════════════════════════════════════════════════════════

// Pending requests to horses are read in chunks of this many recipients: a
// GET with 1,000 UUIDs in it is refused by PostgREST, 100 (about 3.7 KB) is not.
const PENDING_RECIPIENT_CHUNK = 100;
// Ceiling on pending requests read per chunk. Production holds 1,886 pending
// requests to horses in total (2026-09-21), so this does not bind.
const PENDING_READ_MAX = 10_000;

/**
 * Send friend requests from horses to other horses AND real users
 */
export async function sendFriendRequests(maxRequests = 10) {
    console.debug('\n🤝 SENDING FRIEND REQUESTS...');
    const skips: SkipReasons = {};

    if (!(await switchStillOn())) return { sent: 0, skip_reasons: { engine_disabled: 1 } };

    // Get all horses (A1: the paged roster, not the first 1,000 rows)
    const horses = await rosterOrNull('sendFriendRequests');

    if (!horses) return { sent: 0, skip_reasons: { roster_unreadable: 1 } };
    if (horses.length < 2) return { sent: 0, skip_reasons: skips };

    // A2 (2026-09-21): the loop below walks at most maxRequests * 2 horses, and
    // it walked them in storage order, so the same twenty or so horses sent
    // every request on every run. Senders are now the horses awake this hour,
    // in random order, which is how every other step picks who acts.
    const now = new Date();
    const senders = shuffleHorses(horses.filter(h => isOnlineNow(h.profile_id, h.timezone, now)));

    // Get real users (non-horse profiles) for horses to befriend.
    //
    // A3 (2026-09-21): filtered on the profile flag in the database. This sent
    // every horse id as a NOT IN list on a GET, 1,000 UUIDs in one URL (the
    // request PostgREST refused in reactToComments), and ignored the error. An
    // unreadable list now means no human targets this run, counted.
    const horseIdSet = new Set(horses.map(h => h.profile_id));
    const { data: realUsers, error: realUsersErr } = await getSupabase()
        .from('profiles')
        .select('id, username, full_name')
        .eq('is_horse', false)
        .limit(50);
    if (realUsersErr) {
        console.warn('[sendFriendRequests] real-user read failed; horse targets only this run:', realUsersErr.message);
        bump(skips, 'real_users_unreadable');
    }
    const humans = realUsersErr ? [] : (realUsers ?? []).filter(u => !horseIdSet.has(u.id));

    // Combine potential targets: other horses + real users
    const allTargets = [
        ...horses.map(h => ({ profile_id: h.profile_id, name: h.name, isHorse: true })),
        ...humans.map(u => ({ profile_id: u.id, name: u.full_name || u.username, isHorse: false }))
    ];

    let requestsSent = 0;

    // Each horse sends a few friend requests
    for (const horse of senders.slice(0, maxRequests * 2)) {
        // D2: the switch is re-read before every write.
        if (!(await switchStillOn())) {
            bump(skips, 'engine_disabled');
            break;
        }

        // Pick a random target to befriend (prioritize real users 70% of time)
        const targetPool = Math.random() < 0.7
            ? allTargets.filter(t => !t.isHorse && t.profile_id !== horse.profile_id)
            : allTargets.filter(t => t.profile_id !== horse.profile_id);

        const target = targetPool[Math.floor(Math.random() * targetPool.length)];

        if (!target) continue;

        // Check if already friends or pending (use limit(1) — bidirectional rows produce 2 results, breaking maybeSingle)
        const { data: existingRows, error: existingErr } = await getSupabase()
            .from('friendships')
            .select('id')
            .or(`and(user_id.eq.${horse.profile_id},friend_id.eq.${target.profile_id}),and(user_id.eq.${target.profile_id},friend_id.eq.${horse.profile_id})`)
            .limit(1);

        // Fail closed: a relationship that cannot be read is not "none".
        if (existingErr || !Array.isArray(existingRows)) {
            bump(skips, 'relationship_unreadable');
            continue;
        }
        if (existingRows.length > 0) continue; // Already have relationship

        // Send friend request
        const { error } = await getSupabase()
            .from('friendships')
            .insert({
                user_id: horse.profile_id,
                friend_id: target.profile_id,
                status: 'pending'
            });

        if (!error) {
            console.debug(`   ${horse.name} → ${target.name} ${target.isHorse ? '🐴' : '👤'} ✓`);
            requestsSent++;

            if (requestsSent >= maxRequests) break;
        } else {
            bump(skips, error.code === '23505' ? 'already_related' : 'insert_failed');
        }

        await new Promise(r => setTimeout(r, 500)); // Rate limit
    }

    console.debug(`   Sent: ${requestsSent} friend requests`);
    return { sent: requestsSent, skip_reasons: skips };
}

/**
 * Accept pending friend requests
 */
export async function acceptFriendRequests(maxAccepts = 15) {
    console.debug('\n✅ ACCEPTING FRIEND REQUESTS...');
    const skips: SkipReasons = {};

    if (!(await switchStillOn())) return { accepted: 0, skip_reasons: { engine_disabled: 1 } };

    // Get all horses (A1: the paged roster, not the first 1,000 rows)
    const horses = await rosterOrNull('acceptFriendRequests');

    if (!horses) return { accepted: 0, skip_reasons: { roster_unreadable: 1 } };

    const horseIds = horses.map(h => h.profile_id);

    // Find pending requests TO horses.
    //
    // A3 (2026-09-21): this read the oldest 500 pending requests to ANYONE and
    // filtered to horses afterwards. Requests to people are never accepted
    // here, so they sat at the front of that window for good (362 of them in
    // production, the oldest from January), and at 500 of them no horse would
    // ever be reached again. The read is now addressed to horses: their ids in
    // chunks PostgREST accepts, every page of each chunk, oldest first across
    // the fleet, so every request eventually becomes the oldest.
    const pendingAll = [];
    for (let i = 0; i < horseIds.length; i += PENDING_RECIPIENT_CHUNK) {
        const chunk = horseIds.slice(i, i + PENDING_RECIPIENT_CHUNK);
        try {
            const { rows, truncated } = await pagedSelect(
                () => getSupabase()
                    .from('friendships')
                    .select('id, user_id, friend_id, created_at')
                    .eq('status', 'pending')
                    .in('friend_id', chunk)
                    .order('created_at', { ascending: true })
                    .order('id', { ascending: true }),
                PENDING_READ_MAX,
            );
            if (truncated) bump(skips, 'pending_truncated');
            pendingAll.push(...rows);
        } catch (e) {
            console.warn('[acceptFriendRequests] pending read failed for a chunk of horses:', describeError(e));
            bump(skips, 'pending_unreadable');
        }
    }
    pendingAll.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
    const pending = pendingAll.slice(0, maxAccepts * 2);

    if (!pending.length) {
        console.debug('   No pending requests to accept');
        return { accepted: 0, skip_reasons: skips };
    }

    let accepted = 0;

    for (const request of pending) {
        // D2: the switch is re-read before every write.
        if (!(await switchStillOn())) {
            bump(skips, 'engine_disabled');
            break;
        }

        // Random chance to accept (80%)
        if (Math.random() < 0.8) {
            const { error } = await getSupabase()
                .from('friendships')
                .update({ status: 'accepted' })
                .eq('id', request.id);

            if (!error) {
                // Create reverse friendship row (matches friends.js bidirectional pattern)
                await getSupabase()
                    .from('friendships')
                    .insert({ user_id: request.friend_id, friend_id: request.user_id, status: 'accepted' })
                    .then(() => {})
                    .catch(e => console.warn('[HorseSocial] Reverse row insert (may exist):', e?.message));

                const horse = horses.find(h => h.profile_id === request.friend_id);
                const senderIsHorse = horses.find(h => h.profile_id === request.user_id);
                console.debug(`   ${horse?.name || 'Horse'} accepted ${senderIsHorse?.name || 'User'} ✓`);
                accepted++;

                // Send "friend_accepted" notification to the requester (real user or horse)
                // so they get the same notification experience as human-accepted requests
                if (!senderIsHorse) {
                    // Real user — look up their profile for a rich notification
                    const { data: horseProfile } = await getSupabase()
                        .from('profiles')
                        .select('username, full_name')
                        .eq('id', request.friend_id)
                        .maybeSingle();
                    const horseName = horseProfile?.username || horseProfile?.full_name || horse?.name || 'Your Friend';
                    await getSupabase().from('notifications').insert({
                        user_id: request.user_id,
                        type: 'friend_accepted',
                        title: horseName,
                        message: 'accepted your friend request',
                        actor_id: request.friend_id,
                        link: `/hub/user/${horseProfile?.username || request.friend_id}`,
                        data: { friend_id: request.friend_id }
                    }).then(() => {}).catch(e => console.warn('[HorseSocial] Notification insert failed:', e?.message));
                }

                if (accepted >= maxAccepts) break;
            } else {
                bump(skips, 'update_failed');
            }
        }

        await new Promise(r => setTimeout(r, 300));
    }

    console.debug(`   Accepted: ${accepted} requests`);
    return { accepted, skip_reasons: skips };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMENT ENGINE
// ═══════════════════════════════════════════════════════════════════════════


/**
 * Horses comment on posts from horses AND real users
 * Uses per-horse scheduling and writing styles
 */
export async function commentOnPosts(maxComments = 20, includeRealUsers = true) {
    const now = new Date();
    const skips: SkipReasons = {};
    const ledgerBefore = ledgerReadFailureTotal();

    console.debug(`\n💬 HORSES COMMENTING ON POSTS...`);

    if (!(await switchStillOn())) return { commented: 0, activeHorses: 0, skip_reasons: { engine_disabled: 1 } };

    // Get all horses (A1: the paged roster, not the first 1,000 rows)
    const allHorses = await rosterOrNull('commentOnPosts');

    if (!allHorses) return { commented: 0, activeHorses: 0, skip_reasons: { roster_unreadable: 1 } };

    // FILTER: Only horses in their active time slot
    const activeHorses = allHorses.filter(horse => {
        // 2026-09-05: hour-granular gate over the whole fleet. The minute-slot
        // gate this replaced admitted ~8% of horses (see FleetScheduler.ts).
        return isOnlineNow(horse.profile_id, horse.timezone, now);
    });
    shuffleHorses(activeHorses);

    console.debug(`   Active horses this hour: ${activeHorses.length}/${allHorses.length}`);

    if (activeHorses.length === 0) {
        console.debug('   No horses in their active slot this minute');
        return { commented: 0, activeHorses: 0, skip_reasons: skips };
    }

    const horseIds = allHorses.map(h => h.profile_id);

    // Get recent posts. P2C-04 (2026-09-21): live ones only, so a deleted,
    // hidden or flagged post is never picked in the first place.
    let postsQuery = liveSocialPosts(getSupabase()
        .from('social_posts')
        .select('id, author_id, content_type, content, link_title, link_site_name, metadata'))
        .order('created_at', { ascending: false })
        .limit(50);

    // Phase 12 - Inter-Bot Drama: Allow horses to also see all horse posts
    const { data: posts, error: postsErr } = await postsQuery;

    if (postsErr) {
        console.warn('[commentOnPosts] post read failed; skipping:', postsErr.message);
        return { commented: 0, activeHorses: activeHorses.length, skip_reasons: { posts_unreadable: 1 } };
    }

    if (!posts?.length) {
        console.debug('   No posts to comment on');
        return { commented: 0, activeHorses: activeHorses.length, skip_reasons: skips };
    }

    let commented = 0;
    let skippedNoContent = 0;
    let belowFloor = 0;
    let staleDrafts = 0;
    let relevanceSum = 0;
    let relevanceCount = 0;

    // Each ACTIVE horse may comment on some posts
    for (const horse of activeHorses) {
        // D2: the switch is re-read before every horse, so turning the engine
        // off stops a run that is already inside this loop.
        if (!(await switchStillOn())) {
            bump(skips, 'engine_disabled');
            break;
        }

        // Check probability based on this horse's activity rate
        const activityRate = getHorseActivityRate(horse.profile_id, 'comment');
        if (Math.random() > activityRate) {
            console.debug(`   ${horse.name} chose not to comment (rate: ${(activityRate * 100).toFixed(0)}%)`);
            continue;
        }

        // Pick a random post to comment on (not their own)
        const eligiblePosts = posts.filter(p => p.author_id !== horse.profile_id);
        const post = eligiblePosts[Math.floor(Math.random() * eligiblePosts.length)];

        if (!post) continue;

        // Check anti-spam cooldown (fails closed: unreadable is cooling down)
        const cooldown = await checkCooldown(horse.profile_id, post.id, 'comment_post');
        if (cooldown !== 'clear') {
            bump(skips, cooldown === 'unreadable' ? 'cooldown_unreadable' : 'cooldown');
            continue;
        }

        // Check daily limit (fails closed as well)
        const dailyLimit = await checkDailyLimit(horse.profile_id, 'comments');
        if (dailyLimit !== 'within') {
            bump(skips, dailyLimit === 'unreadable' ? 'daily_limit_unreadable' : 'daily_limit');
            continue;
        }

        // Phase 2 (2026-09-05): read the post before writing about it.
        // The ladder this replaces guessed a CATEGORY from regexes over the
        // post text and then drew a whole sentence from a pool for that
        // category, so a comment was never about the post, only about its
        // genre. writeComment() builds a brief (subject, people, teams,
        // concepts, tone) and composes from it in this horse's own style,
        // with the relevance floor and the phrase ledger as gates.
        const written = await writeComment(horse, {
            postId: post.id,
            contentType: post.content_type,
            content: post.content,
            linkTitle: post.link_title ?? null,
            linkSiteName: post.link_site_name ?? null,
            metadata: post.metadata ?? null,
        });
        let comment = written.text;
        if (!comment || comment.trim().length < 5) {
            // Nothing composable: skip rather than publish filler. Phase 1's
            // lesson is that a bad post is worse than no post.
            skippedNoContent++;
            // 2026-09-21: these two counters sat below this `continue` and so
            // could never move (writeGated returns '' for exactly these
            // drafts). Here, a phrase ledger that cannot be read, which now
            // reads as "used", shows up as comment_stale in the run log.
            if (written.belowFloor) belowFloor++;
            if (written.stale) staleDrafts++;
            bump(skips, 'no_text');
            continue;
        }
        relevanceSum += written.relevance;
        relevanceCount += 1;
        // Only a brief we DERIVED is written. A stored brief comes back
        // sanitised by loadBrief(), and writing that copy back would make
        // every read a small permanent downgrade (2026-09-06: grounded posts
        // went from confidence 1.00 to 0.35 the first time anybody commented).
        if (!written.briefWasStored) await recordBrief(post.id, written.brief);

        // 🟢 DYNAMIC TYPING INDICATOR (Phase 11)
        // Broadcast a typing payload to all connected clients viewing this post
        try {
            // The paged roster does not carry avatars; one row for the horse that is typing.
            const { data: avatarRows } = await getSupabase()
                .from('content_authors')
                .select('avatar_url')
                .eq('profile_id', horse.profile_id)
                .limit(1);
            await getSupabase().channel('social-feed').send({
                type: 'broadcast',
                event: 'typing',
                payload: {
                    post_id: post.id,
                    user_id: horse.profile_id,
                    name: horse.name,
                    avatar_url: avatarRows?.[0]?.avatar_url || null,
                    isTyping: true
                }
            });
            
            // Simulate human typing delay (1s - 3s based on comment length, reduced for cron efficiency)
            const typingMs = Math.max(1000, Math.min(3000, comment.length * 50));
            console.debug(`   [Live] ${horse.name} is typing on post ${post.id.substring(0,6)}... (${Math.round(typingMs/1000)}s)`);
            await new Promise(r => setTimeout(r, typingMs));
            
            // Send stop typing event
            await getSupabase().channel('social-feed').send({
                type: 'broadcast',
                event: 'typing',
                payload: { post_id: post.id, user_id: horse.profile_id, isTyping: false }
            });
        } catch (err) {
            console.warn(`   [Live] Failed to broadcast typing indicator for ${horse.name}`);
        }

        // P2C-04 (2026-09-21): the post is re-read immediately before the
        // comment is written, and it must still be live. The list above is a
        // draft and a typing pause old by now, and a post deleted or hidden in
        // that time must not collect a comment. The switch is re-read too.
        if (!(await switchStillOn())) {
            bump(skips, 'engine_disabled');
            break;
        }
        const postState = await postLiveness(post.id);
        if (postState !== 'live') {
            bump(skips, postState === 'unreadable' ? 'post_unreadable' : 'post_not_live');
            continue;
        }

        // Insert comment
        const { error } = await getSupabase()
            .from('social_comments')
            .insert({
                post_id: post.id,
                author_id: horse.profile_id,
                content: comment
            });
        if (error) bump(skips, 'insert_failed');

        // Phase 2 (2026-09-06): a mention goes to a FRIEND, by alias.
        //
        // This used to pick a uniformly random horse out of the whole fleet
        // and address it by profiles.username, which produced
        // "@sophie andersson 2 ..." in production - a display name with
        // spaces, from a horse this one has never interacted with. Dan:
        // "HORSES NEED TO BE ADDING AND TAGGING OTHER HORSES IN POSTS THAT
        // THEY ARE FRIENDS WITH. BUT NOT EVERY HORSE SHOULD BE FRIENDS WITH
        // EVERY OTHER HORSE, THAT WOULD BE WEIRD AND SUSPICIOUS."
        if (!error && Math.random() < 0.15) {
            const cand = tagCandidateFor(
                horse,
                allHorses,
                { domain: written.brief.domain, concepts: written.brief.concepts, sport: written.brief.sport },
                `${horse.profile_id}:${post.id}`,
            );
            const friend = cand?.friend;
            if (friend?.alias) {
                const friendProfile = { username: friend.alias };
                    const mentionComment = `@${friendProfile.username} ${comment}`;
                    // BUG-WR03 FIX: match by author+post+timestamp window instead of content string
                    // (content-match was fragile: two horses posting same text to same post → wrong row updated)
                    const nowIso = new Date(Date.now() - 5000).toISOString(); // last 5s
                    await getSupabase().from('social_comments')
                        .update({ content: mentionComment })
                        .eq('post_id', post.id)
                        .eq('author_id', horse.profile_id)
                        .gte('created_at', nowIso);
                    comment = mentionComment;
                    console.debug(`   ${horse.name} tagged @${friendProfile.username}`);

                    // Phase 28 Fix: Insert notification for the mentioned friend
                    await getSupabase().from('notifications').insert({
                        user_id: friend.profile_id,
                        actor_id: horse.profile_id,
                        type: 'mention',
                        title: horse.name,           // NOT NULL — was missing, caused silent insert fail
                        reference_id: post.id,
                        message: `mentioned you in a comment`
                    });

                    // Trigger push notification to mentioned user
                    await sendSocialPush(friend.profile_id, horseIds, 'New Mention', `${horse.name} mentioned you in a comment.`, `/hub/social-media?post_id=${post.id}`);
            }
        }

        if (!error) {
            // Trigger push notification to the post author
            await sendSocialPush(post.author_id, horseIds, 'New Comment', `${horse.name} commented on your post: "${comment}"`, `/hub/social-media?post_id=${post.id}`);

            const author = allHorses.find(h => h.profile_id === post.author_id);
            console.debug(`   ${horse.name} → ${author?.name || 'User'}'s post: "${comment}"`);
            // Comments share the freshness ledger with captions. Before Phase 2
            // nothing recorded them, so one line could reappear across the feed
            // all day and no counter would show it.
            await recordPhrase(normalizePhrase(comment), horse.profile_id, post.id);
            if (written.semanticKey) await recordPhrase(written.semanticKey, horse.profile_id, post.id);
            commented++;

            // comment_count is kept by the database: the AFTER INSERT trigger
            // trig_update_post_comment_count adds 1 for this row. 2026-09-21: the
            // engine also called increment_post_count here, so every horse
            // comment was counted twice on the post.

            if (commented >= maxComments) break;
        }

        // Reduced delay between horses (0.5-2 seconds) for cron efficiency
        await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
    }

    noteLedgerFailures(skips, ledgerBefore);
    console.debug(`   Posted: ${commented} comments from ${activeHorses.length} active horses`);
    return {
        commented,
        activeHorses: activeHorses.length,
        // Phase 2 telemetry: how well the writer understood what it commented on.
        avg_relevance: relevanceCount ? Number((relevanceSum / relevanceCount).toFixed(2)) : 0,
        below_floor: belowFloor,
        stale_drafts: staleDrafts,
        skipped_no_content: skippedNoContent,
        // 2026-09-21: why each horse that could have commented did not.
        skip_reasons: skips,
    };
}

/**
 * Horses like posts from horses AND real users
 * Now uses per-horse scheduling - each horse only acts during their unique time slot
 */
export async function likePosts(maxLikes = 30, includeRealUsers = true) {
    const now = new Date();
    const skips: SkipReasons = {};

    console.debug(`\n❤️ HORSES LIKING POSTS...`);

    if (!(await switchStillOn())) return { liked: 0, activeHorses: 0, skip_reasons: { engine_disabled: 1 } };

    // Get all horses (A1: the paged roster, not the first 1,000 rows)
    const allHorses = await rosterOrNull('likePosts');

    if (!allHorses) return { liked: 0, activeHorses: 0, skip_reasons: { roster_unreadable: 1 } };

    // FILTER: Only horses whose time slot matches current minute (variance ±2)
    const activeHorses = allHorses.filter(horse => {
        // 2026-09-05: hour-granular gate over the whole fleet. The minute-slot
        // gate this replaced admitted ~8% of horses (see FleetScheduler.ts).
        return isOnlineNow(horse.profile_id, horse.timezone, now);
    });
    shuffleHorses(activeHorses);

    console.debug(`   Active horses this hour: ${activeHorses.length}/${allHorses.length}`);

    if (activeHorses.length === 0) {
        console.debug('   No horses in their active slot this minute');
        return { liked: 0, activeHorses: 0, skip_reasons: skips };
    }

    const horseIds = allHorses.map(h => h.profile_id);

    // Get recent posts. P2C-04 (2026-09-21): live ones only.
    let postsQuery = liveSocialPosts(getSupabase()
        .from('social_posts')
        .select('id, author_id'))
        .order('created_at', { ascending: false })
        .limit(100);

    // Phase 12 - Inter-Bot Drama: Allow horses to also like all horse posts
    const { data: posts, error: postsErr } = await postsQuery;

    if (postsErr) {
        console.warn('[likePosts] post read failed; skipping:', postsErr.message);
        return { liked: 0, activeHorses: activeHorses.length, skip_reasons: { posts_unreadable: 1 } };
    }
    if (!posts?.length) return { liked: 0, activeHorses: activeHorses.length, skip_reasons: skips };

    let liked = 0;
    let switchedOff = false;

    // Each ACTIVE horse may like some posts
    for (const horse of activeHorses) {
        // Check probability based on this horse's activity rate
        const activityRate = getHorseActivityRate(horse.profile_id, 'like');
        if (Math.random() > activityRate) {
            console.debug(`   ${horse.name} chose not to engage (rate: ${(activityRate * 100).toFixed(0)}%)`);
            continue;
        }

        // Pick 1-3 random posts for this horse to like
        const numToLike = 1 + Math.floor(Math.random() * 3);
        const shuffledPosts = posts.filter(p => p.author_id !== horse.profile_id).sort(() => Math.random() - 0.5);

        for (let i = 0; i < numToLike && liked < maxLikes; i++) {
            const post = shuffledPosts[i];
            if (!post) break;

            // D2: the switch is re-read before every write.
            if (!(await switchStillOn())) {
                bump(skips, 'engine_disabled');
                switchedOff = true;
                break;
            }

            // Check cooldown (fails closed: unreadable is cooling down)
            const cooldown = await checkCooldown(horse.profile_id, post.id, 'like_post');
            if (cooldown !== 'clear') {
                bump(skips, cooldown === 'unreadable' ? 'cooldown_unreadable' : 'cooldown');
                continue;
            }

            // Check for existing like. limit(1), not maybeSingle(): two reactions
            // from one horse on one post made maybeSingle() error, which read as
            // "no like yet". An unreadable answer skips.
            const { data: existing, error: existingErr } = await getSupabase()
                .from('social_likes')
                .select('id')
                .eq('post_id', post.id)
                .eq('user_id', horse.profile_id)
                .limit(1);

            if (existingErr || !Array.isArray(existing)) {
                bump(skips, 'like_unreadable');
                continue;
            }
            if (existing.length) continue;

            // Phase 16: Pick a weighted reaction type
            const reactionRoll = Math.random();
            let reaction = 'like';
            if (reactionRoll > 0.90) reaction = 'wow';        // 10%
            else if (reactionRoll > 0.80) reaction = 'fire';  // 10%
            else if (reactionRoll > 0.65) reaction = 'haha';  // 15%
            else if (reactionRoll > 0.40) reaction = 'love';  // 25%
            // else: 'like' (40%)

            // Insert like with reaction type
            const { error } = await getSupabase()
                .from('social_likes')
                .insert({
                    post_id: post.id,
                    user_id: horse.profile_id,
                    reaction_type: reaction
                });

            if (!error) {
                // Trigger push notification to post author
                const reactionEmoji = reaction === 'love' ? '❤️' : reaction === 'fire' ? '🔥' : reaction === 'wow' ? '😲' : reaction === 'haha' ? '😂' : '👍';
                await sendSocialPush(post.author_id, horseIds, `New Reaction`, `${horse.name} reacted ${reactionEmoji} to your post.`, `/hub/social-media?post_id=${post.id}`);

                console.debug(`   ${horse.name} liked a post ❤️`);
                liked++;

                // like_count is kept by the database: the AFTER INSERT trigger
                // trg_sync_like_count adds 1 for this row. 2026-09-21: the engine
                // also called increment_post_count here, so every horse like was
                // counted twice.
            } else {
                bump(skips, error.code === '23505' ? 'already_liked' : 'insert_failed');
            }
        }

        if (switchedOff) break;

        // 2026-09-05: the cap ends the run. Without this break the loop kept
        // walking every remaining active horse with a 0.5-2s sleep each, so a
        // run with 8 likes done still spent the whole deadline sleeping and
        // comments, replies and reactions were skipped on every fire.
        if (liked >= maxLikes) break;

        // Reduced delay between horses (0.5-2 seconds) for cron efficiency
        await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
    }

    console.debug(`   Liked: ${liked} posts from ${activeHorses.length} active horses`);
    return { liked, activeHorses: activeHorses.length, skip_reasons: skips };
}

// ═══════════════════════════════════════════════════════════════════════════
// REPLY TO COMMENTS ENGINE
// ═══════════════════════════════════════════════════════════════════════════

// Which posts are looked at: those with a live comment in this window.
const THREAD_DISCOVERY_HOURS = 48;
// Ceiling on the live comments read to find those posts (every page up to it).
const THREAD_DISCOVERY_MAX = 20_000;
// Post ids per IN list: a URL PostgREST accepts.
const POST_ID_CHUNK = 100;
// Candidate posts whose threads are read together, and the ceiling on the
// comments read for one such chunk. A chunk that hits it is skipped whole: a
// thread that cannot be read to its end cannot have its turns counted.
const THREAD_POST_CHUNK = 50;
const THREAD_READ_MAX = 20_000;

/** The id of the reply just written, when the insert did not hand it back. */
async function findReplyId(postId: string, horseId: string, parentId: string): Promise<string | null> {
    const { data, error } = await getSupabase()
        .from('social_comments')
        .select('id')
        .eq('post_id', postId)
        .eq('author_id', horseId)
        .eq('parent_id', parentId)
        .order('created_at', { ascending: false })
        .limit(1);
    if (error || !Array.isArray(data) || !data.length) return null;
    return data[0]?.id ?? null;
}

/**
 * Horses reply to comments on posts (both horse and real user comments)
 * Uses per-horse scheduling and writing styles
 */
export async function replyToComments(maxReplies = 15) {
    const now = new Date();
    const skips: SkipReasons = {};
    const ledgerBefore = ledgerReadFailureTotal();

    console.debug(`\n💬 HORSES REPLYING TO COMMENTS...`);

    if (!(await switchStillOn())) return { replied: 0, activeHorses: 0, reply_reasons: {}, skip_reasons: { engine_disabled: 1 } };

    // Get all horses (A1: the paged roster; alias is how a horse notices it was addressed)
    const allHorses = await rosterOrNull('replyToComments');

    if (!allHorses) return { replied: 0, activeHorses: 0, reply_reasons: {}, skip_reasons: { roster_unreadable: 1 } };

    // FILTER: Only horses in their active time slot
    const activeHorses = allHorses.filter(horse => {
        // 2026-09-05: hour-granular gate over the whole fleet. The minute-slot
        // gate this replaced admitted ~8% of horses (see FleetScheduler.ts).
        return isOnlineNow(horse.profile_id, horse.timezone, now);
    });
    shuffleHorses(activeHorses);

    console.debug(`   Active horses this hour: ${activeHorses.length}/${allHorses.length}`);

    if (activeHorses.length === 0) {
        console.debug('   No horses in their active slot this minute');
        return { replied: 0, activeHorses: 0, reply_reasons: {}, skip_reasons: skips };
    }

    const horseIds = allHorses.map(h => h.profile_id);

    // Phase 2 (2026-09-05): a thread is a state machine, not a random pick.
    //
    // What this replaces: the old version read ONLY top-level comments
    // (`.is('parent_id', null)`) and answered one at random. That guard was
    // added because replying to replies produced infinite chains - but it
    // also meant a human who answered a horse was never answered back, which
    // is the one case that actually matters. ReplyEngine reads whole threads
    // and applies real rules: an unanswered human always gets exactly one
    // reply; another horse gets one only if it addressed us, asked something
    // or disagreed; and hard ceilings end the conversation either way.
    //
    // P2C-03 (2026-09-21): and the threads really are whole now. They were
    // built from the comments of the last 48 hours only, so a horse's older
    // replies fell out of the count: replies at 49h and 47h looked like one,
    // a third went out past MAX_TURNS_PER_HORSE, and the turn index recorded
    // was short by the same amount. The window now only decides WHICH posts
    // are looked at; every comment on them, however old, is loaded before
    // anything is decided.
    const threadCutoff = new Date(now.getTime() - THREAD_DISCOVERY_HOURS * 3_600_000).toISOString();
    let recentRows;
    try {
        const recent = await pagedSelect(
            () => liveSocialComments(getSupabase()
                .from('social_comments')
                .select('id, post_id, created_at')
                .gte('created_at', threadCutoff))
                .order('created_at', { ascending: false })
                .order('id', { ascending: false }),
            THREAD_DISCOVERY_MAX,
        );
        recentRows = recent.rows;
        if (recent.truncated) bump(skips, 'discovery_truncated');
    } catch (e) {
        console.warn('[replyToComments] thread read failed:', describeError(e));
        return { replied: 0, activeHorses: activeHorses.length, reply_reasons: {}, skip_reasons: { threads_unreadable: 1 } };
    }

    if (!recentRows.length) {
        console.debug('   No comments to reply to');
        return { replied: 0, activeHorses: activeHorses.length, reply_reasons: {}, skip_reasons: skips };
    }

    // P2C-04: only posts that are still live are candidates. A post that
    // cannot be read is not engaged with this run.
    const candidateIds = [...new Set(recentRows.map(r => r.post_id).filter(Boolean))];
    const livePosts = new Map();
    let postsUnreadable = 0;
    for (let i = 0; i < candidateIds.length; i += POST_ID_CHUNK) {
        const chunk = candidateIds.slice(i, i + POST_ID_CHUNK);
        const { data, error } = await liveSocialPosts(getSupabase()
            .from('social_posts')
            .select('id, content_type, content, link_title, link_site_name, metadata')
            .in('id', chunk));
        if (error) {
            console.warn('[replyToComments] post read failed:', error.message);
            postsUnreadable += chunk.length;
            continue;
        }
        for (const p of data ?? []) livePosts.set(p.id, p);
    }
    if (postsUnreadable) bump(skips, 'post_unreadable', postsUnreadable);
    const postsGone = candidateIds.length - livePosts.size - postsUnreadable;
    if (postsGone > 0) bump(skips, 'post_not_live', postsGone);

    // Every comment on every live candidate post. Deleted and flagged rows
    // are read too: they still count toward the caps (a reply a moderator
    // removed was still a turn), they just can never be answered.
    const horseIdSet = new Set(horseIds);
    const threads = new Map<string, ThreadComment[]>();
    const livePostIds = [...livePosts.keys()];
    for (let i = 0; i < livePostIds.length; i += THREAD_POST_CHUNK) {
        const chunk = livePostIds.slice(i, i + THREAD_POST_CHUNK);
        try {
            const { rows, truncated } = await pagedSelect(
                () => getSupabase()
                    .from('social_comments')
                    .select('id, post_id, parent_id, author_id, content, created_at, is_deleted, is_flagged')
                    .in('post_id', chunk)
                    .order('post_id', { ascending: true })
                    .order('created_at', { ascending: true })
                    .order('id', { ascending: true }),
                THREAD_READ_MAX,
            );
            if (truncated) {
                bump(skips, 'thread_truncated', chunk.length);
                continue;
            }
            for (const r of rows) {
                const list = threads.get(r.post_id) ?? [];
                list.push({
                    id: r.id,
                    post_id: r.post_id,
                    parent_id: r.parent_id ?? null,
                    author_id: r.author_id,
                    content: r.content ?? '',
                    created_at: r.created_at ?? '',
                    isHorse: horseIdSet.has(r.author_id),
                    live: r.is_deleted === false && r.is_flagged === false,
                });
                threads.set(r.post_id, list);
            }
        } catch (e) {
            console.warn('[replyToComments] whole-thread read failed:', describeError(e));
            bump(skips, 'thread_unreadable', chunk.length);
        }
    }

    let replied = 0;
    const reasons: Record<string, number> = {};

    for (const horse of activeHorses) {
        // D2: the switch is re-read before every horse.
        if (!(await switchStillOn())) {
            bump(skips, 'engine_disabled');
            break;
        }

        // Threads this horse is actually in.
        let decided: { postId: string; decision: ReturnType<typeof decideReply> } | null = null;
        for (const [postId, list] of threads) {
            if (!list.some((c) => c.author_id === horse.profile_id)) continue;
            const decision = decideReply(horse.profile_id, horse.alias, list, now);
            if (decision.reply) {
                decided = { postId, decision };
                break;
            }
            // Why a thread this horse is in got no reply: the caps are visible
            // in the run log now, not only the replies that went out.
            if (decision.skipped && decision.skipped !== 'no_incoming') bump(skips, decision.skipped);
        }
        if (!decided || !decided.decision.target) continue;

        const target = decided.decision.target;
        const reason = decided.decision.reason!;
        // Counted by decideReply over the whole thread (P2C-03).
        const turnIndex = decided.decision.turnIndex ?? 1;

        // A human reply is mandatory during the horse's next awake hour.
        // Optional horse-to-horse chatter still observes the activity rate.
        if (reason !== 'human_unanswered') {
            const activityRate = getHorseActivityRate(horse.profile_id, 'reply');
            if (Math.random() > activityRate) continue;
        }

        // Fails closed: an unreadable cooldown is a cooldown.
        const cooldown = await checkCooldown(horse.profile_id, target.id, 'reply_comment');
        if (cooldown !== 'clear') {
            bump(skips, cooldown === 'unreadable' ? 'cooldown_unreadable' : 'cooldown');
            continue;
        }

        // The post being discussed, so the reply is about the subject and not
        // just about the sentence above it (read above, live filter applied).
        const parentPost = livePosts.get(decided.postId);

        const written = await writeReply(
            horse,
            {
                postId: decided.postId,
                contentType: parentPost?.content_type,
                content: parentPost?.content,
                linkTitle: parentPost?.link_title ?? null,
                linkSiteName: parentPost?.link_site_name ?? null,
                metadata: parentPost?.metadata ?? null,
            },
            target.content,
            composerReason(reason),
        );
        const replyText = written.text;
        if (!replyText || replyText.trim().length < 2) {
            bump(skips, 'no_text');
            continue;
        }

        // P2C-04: the post and the comment being answered are re-read
        // immediately before the reply is written, and both must still be
        // live; either may have been deleted or hidden since the thread read.
        if (!(await switchStillOn())) {
            bump(skips, 'engine_disabled');
            break;
        }
        const postState = await postLiveness(decided.postId);
        if (postState !== 'live') {
            bump(skips, postState === 'unreadable' ? 'post_unreadable' : 'post_not_live');
            continue;
        }
        const targetState = await commentLiveness(target.id, decided.postId);
        if (targetState !== 'live') {
            bump(skips, targetState === 'unreadable' ? 'target_unreadable' : 'target_not_live');
            continue;
        }

        const comment = { id: target.id, post_id: decided.postId, author_id: target.author_id };

        // Insert reply
        const { data: insertedReply, error } = await getSupabase()
            .from('social_comments')
            .insert({
                post_id: comment.post_id,
                author_id: horse.profile_id,
                content: replyText,
                parent_id: comment.id
            })
            .select('id, created_at')
            .maybeSingle();

        if (error) bump(skips, 'insert_failed');

        if (!error) {
            reasons[reason] = (reasons[reason] ?? 0) + 1;

            // Trigger push notification to the original comment author
            await sendSocialPush(comment.author_id, horseIds, 'New Reply', `${horse.name} replied to your comment: "${replyText}"`, `/hub/social-media?post_id=${comment.post_id}`);

            console.debug(`   ${horse.name} replied: "${replyText}"`);
            // horse_thread_state carries the id of the reply just written. The
            // six production rows with comment_id NULL (2026-09-05 23:33 to
            // 09-06 02:34) were written by #84/#85, which never passed it; #108
            // added it later that day. If the insert does not hand the row
            // back, the reply is looked up rather than recorded as NULL.
            const replyId = insertedReply?.id ?? await findReplyId(comment.post_id, horse.profile_id, comment.id);
            if (!replyId) bump(skips, 'thread_state_comment_unknown');
            const recorded = await recordThreadTurn({
                postId: comment.post_id,
                horseId: horse.profile_id,
                commentId: replyId,
                parentId: comment.id,
                reason,
                turnIndex,
            });
            if (recorded === false) bump(skips, 'thread_state_write_failed');
            await recordPhrase(normalizePhrase(replyText), horse.profile_id, comment.post_id);
            replied++;

            // This run's copy of the thread moves with it, so the next horse in
            // the loop counts this reply. Without it, several horses could each
            // take "the last" turn of one thread in a single run and overrun
            // MAX_HORSE_TURNS.
            threads.get(comment.post_id)?.push({
                id: replyId ?? `unrecorded:${horse.profile_id}:${comment.id}`,
                post_id: comment.post_id,
                parent_id: comment.id,
                author_id: horse.profile_id,
                content: replyText,
                created_at: insertedReply?.created_at ?? new Date().toISOString(),
                isHorse: true,
                live: true,
            });

            // comment_count is kept by the database trigger
            // trig_update_post_comment_count; the engine no longer adds a second 1
            // (2026-09-21, the same double count as top-level comments).

            if (replied >= maxReplies) break;
        }

        // Reduced delay between horses (0.5-2 seconds) for cron efficiency
        await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
    }

    noteLedgerFailures(skips, ledgerBefore);
    console.debug(`   Replied: ${replied} times from ${activeHorses.length} active horses`);
    return {
        replied,
        activeHorses: activeHorses.length,
        // Phase 2: why each reply happened, so the thread rules are auditable.
        reply_reasons: reasons,
        // 2026-09-21: and why the others did not (caps, liveness, fail-closed reads).
        skip_reasons: skips,
        threads_read: threads.size,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SOCIAL INTERACTION LOOP
// ═══════════════════════════════════════════════════════════════════════════

/**
 * D2 (2026-09-21): the kill switch is re-read before every step, so an engine
 * turned off mid-run stops at the next step (each step also re-reads it
 * before every write). Once stopped, no later step starts.
 */
async function stepAllowed(results): Promise<boolean> {
    if (results.stopped) return false;
    if (await switchStillOn()) return true;
    results.stopped = 'engine_disabled';
    return false;
}

export async function runSocialInteractions(options = {}) {
    console.debug('\n🐴🐴🐴 HORSE SOCIAL ENGINE 🐴🐴🐴');
    console.debug('═'.repeat(60));

    const {
        includeFriends = true,
        includeComments = true,
        includeLikes = true,
        includeReplies = true,
        includeCommentReactions = true,
        includeRealUsers = true
    } = options;

    try {
        const results = { success: true };

        // 1. Send friend requests
        if (includeFriends && await stepAllowed(results)) {
            const friendResults = await sendFriendRequests(10);
            const acceptResults = await acceptFriendRequests(15);
            results.friendsSent = friendResults.sent;
            results.friendsAccepted = acceptResults.accepted;
        }

        // 2. Comment on posts
        if (includeComments && await stepAllowed(results)) {
            const commentResults = await commentOnPosts(20, includeRealUsers);
            results.commented = commentResults.commented;
        }

        // 3. Like posts
        if (includeLikes && await stepAllowed(results)) {
            const likeResults = await likePosts(30, includeRealUsers);
            results.liked = likeResults.liked;
        }

        // 4. Reply to comments
        if (includeReplies && await stepAllowed(results)) {
            const replyResults = await replyToComments(15);
            results.replied = replyResults.replied;
        }

        // 5. React to comments (Phase 27)
        if (includeCommentReactions && await stepAllowed(results)) {
            const reactResults = await reactToComments(15);
            results.commentReactions = reactResults.reacted;
        }

        // Summary
        console.debug('\n' + '═'.repeat(60));
        console.debug('📊 SOCIAL INTERACTION SUMMARY');
        console.debug('═'.repeat(60));
        console.debug(`   Friend Requests Sent: ${results.friendsSent || 0}`);
        console.debug(`   Friend Requests Accepted: ${results.friendsAccepted || 0}`);
        console.debug(`   Comments Posted: ${results.commented || 0}`);
        console.debug(`   Posts Liked: ${results.liked || 0}`);
        console.debug(`   Comment Replies: ${results.replied || 0}`);
        console.debug(`   Comment Reactions: ${results.commentReactions || 0}`);
        console.debug('\n🎉 Horses are socializing!');

        return results;

    } catch (error) {
        console.warn('Social engine error:', error.message);
        return { success: false, error: error.message };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 27: HORSE-TO-HORSE COMMENT REACTIONS
// ═══════════════════════════════════════════════════════════════════════════

export async function reactToComments(maxReactions = 15) {
    const now = new Date();
    const skips: SkipReasons = {};

    console.debug(`\n🔥 HORSES REACTING TO COMMENTS...`);

    if (!(await switchStillOn())) return { reacted: 0, skip_reasons: { engine_disabled: 1 } };

    // A1: the paged roster, not the first 1,000 rows
    const allHorses = await rosterOrNull('reactToComments');

    if (!allHorses) return { reacted: 0, skip_reasons: { roster_unreadable: 1 } };

    const activeHorses = allHorses.filter(horse => {
        // 2026-09-05: hour-granular gate over the whole fleet. The minute-slot
        // gate this replaced admitted ~8% of horses (see FleetScheduler.ts).
        return isOnlineNow(horse.profile_id, horse.timezone, now);
    });
    shuffleHorses(activeHorses);

    if (activeHorses.length === 0) return { reacted: 0, skip_reasons: skips };

    const horseIds = allHorses.map(h => h.profile_id);

    // Get recent comments from other horses (need post_id for social_interactions write)
    // 2026-09-05: `.in('author_id', horseIds)` put 1,000 UUIDs into a GET query
    // string; PostgREST refused it and this step returned reacted: 0 on every
    // fire. Read the recent comments and filter with a Set instead.
    //
    // P2C-04 (2026-09-21): live comments only, on live posts (22,363 horse
    // comments in production sit on posts that no longer exist), and a read
    // that fails skips the step instead of reacting to whatever came back.
    const horseIdSet = new Set(horseIds);
    const { data: recentCommentsRaw, error: recentCommentsErr } = await liveSocialComments(getSupabase()
        .from('social_comments')
        .select('id, post_id, author_id'))
        .order('created_at', { ascending: false })
        .limit(200);
    if (recentCommentsErr) {
        console.warn('[reactToComments] comments read failed:', recentCommentsErr.message);
        return { reacted: 0, skip_reasons: { comments_unreadable: 1 } };
    }
    const horseComments = (recentCommentsRaw ?? []).filter(c => horseIdSet.has(c.author_id));
    const commentPostIds = [...new Set(horseComments.map(c => c.post_id).filter(Boolean))];
    const livePostIds = new Set();
    for (let i = 0; i < commentPostIds.length; i += POST_ID_CHUNK) {
        const chunk = commentPostIds.slice(i, i + POST_ID_CHUNK);
        const { data: livePostRows, error: livePostErr } = await liveSocialPosts(getSupabase()
            .from('social_posts')
            .select('id')
            .in('id', chunk));
        if (livePostErr) {
            console.warn('[reactToComments] post read failed:', livePostErr.message);
            return { reacted: 0, skip_reasons: { posts_unreadable: 1 } };
        }
        for (const p of livePostRows ?? []) livePostIds.add(p.id);
    }
    const recentComments = horseComments.filter(c => livePostIds.has(c.post_id)).slice(0, 50);

    if (!recentComments.length) return { reacted: 0, skip_reasons: skips };

    let reacted = 0;

    for (const horse of activeHorses) {
        if (Math.random() > 0.3) continue; // 30% chance to react

        const eligibleComments = recentComments.filter(c => c.author_id !== horse.profile_id);
        if (eligibleComments.length === 0) continue;

        const comment = eligibleComments[Math.floor(Math.random() * eligibleComments.length)];

        // D2: the switch is re-read before every write.
        if (!(await switchStillOn())) {
            bump(skips, 'engine_disabled');
            break;
        }

        // Weighted reaction type
        const roll = Math.random();
        let reaction = 'like';
        if (roll > 0.85) reaction = 'wow';
        else if (roll > 0.70) reaction = 'fire';
        else if (roll > 0.50) reaction = 'haha';
        else if (roll > 0.30) reaction = 'love';

        // BUG-SI01 FIX: onConflict='metadata->>comment_id' is NOT valid PostgREST syntax
        // (JSON path expressions are not column names). This caused silent INSERT duplicates
        // or a 42703 error. Use atomic delete+insert instead for guaranteed idempotency.
        const postId = comment.post_id || comment.id;
        await getSupabase()
            .from('social_interactions')
            .delete()
            .eq('user_id', horse.profile_id)
            .eq('post_id', postId)
            .eq('interaction_type', 'comment_like')
            .filter('metadata->>comment_id', 'eq', comment.id);

        const { error } = await getSupabase()
            .from('social_interactions')
            .insert({
                user_id: horse.profile_id,
                post_id: postId,
                interaction_type: 'comment_like',
                metadata: { comment_id: comment.id, reaction_type: reaction }
            });

        if (!error) {
            reacted++;
            console.debug(`   ${horse.name} reacted ${reaction} to a comment`);
        } else {
            bump(skips, 'insert_failed');
        }

        if (reacted >= maxReactions) break;
        await new Promise(r => setTimeout(r, 500));
    }

    console.debug(`   Reacted to ${reacted} comments`);
    return { reacted, skip_reasons: skips };
}

// Run if called directly
if (typeof window === 'undefined' && process.argv[1]?.includes('HorseSocialEngine')) {
    runSocialInteractions();
}
