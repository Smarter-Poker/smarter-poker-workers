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
 *   getRandomComment(type)
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
import { getHorseActivityRate, applyWritingStyle } from './HorseScheduler.js';
import { isOnlineNow } from './FleetScheduler.js';

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
import { generateComment } from './HumanVoiceEngine.js';

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
const COMMENT_TEMPLATES = {
    video: [
        // Fire reactions
        "insane", "this is SICK", "bro this hand is insane", "absolute madness",
        "ice cold", "legendary play", "unreal", "that was beautiful",

        // Strategic observations
        "need to study this spot more", "the read tho", "exploitative poker at its finest",
        "GTO says fold but soul says call", "this is a solved spot actually",
        "the sizing tells the story", "perfect bet sizing", "range advantage is real",

        // Personal reactions
        "this is why i love poker", "sending this to my home game group",
        "been watching this on repeat", "i would've folded pre tbh",
        "imagine being at that table", "the tank was so painful to watch",
        "studying this for my next session", "taking notes rn",

        // Player specific
        "mariano is built different", "airball is a menace fr", "garret is on another level",
        "wesley plays so aggro", "henry always finds a fold", "polk is a sicko",
        "dwan would've called here", "negreanu reads are insane",

        // Commentary
        "the commentary makes it 10x better", "bart's analysis is spot on",
        "love the hand breakdown", "this is textbook poker",

        // Hero calls/folds
        "hero call of the year", "discipline on display", "soul read fr",
        "he knew. HE KNEW.", "the read was too good", "heart of a champion"
    ],

    photo: [
        // Stack pics
        "nice hit", "stack looking good", "get that bread",
        "that's a nice tower", "love to see it", "congrats on the session!",
        "jeez thats a lot of chips", "rack em up!", "casino hates this guy",

        // Grind culture
        "grind never stops", "LFG lets go", "lets gooo", "back at it",
        "the commitment is real", "outwork everyone", "session god",

        // Curiosity
        "what stakes?", "where is this?", "that bellagio?", "commerce?",
        "jealous of that action", "been there, feels good", "wish my games ran this good"
    ],

    bad_beat: [
        // Sympathy
        "brutal", "pain.", "been there way too many times", "variance is cruel",
        "you got coolered so hard", "thats poker unfortunately", "i felt that in my soul",
        "RIP bankroll", "F in chat", "happens to the best of us",

        // Dark humor
        "at least its not real money... wait", "poker is not a game of skill i guess",
        "dealer had other plans", "the deck hates you fr", "run bad is real",
        "one outer strikes again", "runner runner gods were angry",

        // Encouragement
        "recovery session incoming?", "bouncing back soon", "next session different",
        "variance evens out", "you played it right tho", "long run will be kind",
        "shake it off king/queen", "book says you won that pot"
    ],

    general: [
        "facts", "hundred percent", "this is the way", "couldn't agree more", "real talk",
        "same tbh", "underrated take", "big if true", "W post", "based",
        "fr fr", "no cap", "lowkey valid", "kinda true", "honest",
        "vibes", "very true", "deadass", "literally me", "i felt this",
        "let's GOOO", "banger post", "needed this today", "saving this",
        "legendary content", "chef's kiss", "immaculate", "perfect"
    ],
    hcl: [
        "HCL never disappoints", "hustler games are different",
        "this is why HCL is the best stream", "RIP production budget",
        "dgaf about entertainment value", "peak HCL content"
    ],
    tournament: [
        "ICM nightmare", "bubble factor is wild", "chip leader mentality",
        "final table vibes", "bracelet or bust", "deep run loading",
        "satellite paid off", "field was tough", "that final table was stacked"
    ],
    plo: [
        "PLO is a different beast", "wrap city", "double suited for value",
        "thats so PLO", "aces cracked as usual", "runout was brutal",
        "running it twice saved him"
    ],
    // Phase 26: Keyword-based contextual comment categories
    cash_game: [
        "what stakes?", "cash game life", "reload button is dangerous",
        "session was wild", "grinding the live tables", "the action was insane tonight",
        "miss these stakes", "love a good cash session", "how deep were you?"
    ],
    bluff: [
        "absolute stone cold bluff", "that takes guts", "heart of a lion",
        "risky but respect it", "he had to fold there", "the balls on this guy",
        "bluff of the year candidate", "fearless at the table"
    ],
    river: [
        "river card always has something to say", "the river giveth and taketh",
        "classic one-outer", "river brings the drama every time",
        "that runout was disgusting", "nothing like a river card to ruin your day",
        "the river was a movie", "river rat strikes again"
    ],
    strategy: [
        "interesting line here", "the bet sizing tells a story",
        "think about this from a range perspective", "EV is king",
        "this is a textbook spot", "solver would approve",
        "the math checks out", "optimal play right there"
    ],
    session_report: [
        "solid session", "the grind pays off", "congrats on the win",
        "love seeing positive results", "keep stacking",
        "nice profit", "good to book a win", "the hours put in show"
    ],
    grind: [
        "grinder mentality", "respect the grind", "putting in volume",
        "every hand counts", "the work ethic is real",
        "outwork outgrind outplay", "this is what dedication looks like"
    ],
    wsop: [
        "WSOP dreams", "bracelet hunting season", "the Rio is calling",
        "one time for the bracelet", "main event vibes",
        "that WSOP energy is unmatched", "bracelet or nothing"
    ],
    variance: [
        "variance is a beast", "long run will sort it out",
        "standard deviation in action", "the swings are real",
        "trust the process", "keep playing your game", "sample size matters"
    ],
    sports: [
        // Win reactions
        "well deserved", "that W was earned", "nobody gave them a chance and here we are",
        "statement game right there", "momentum is real now", "squeezed that one out",
        // Loss/adversity
        "tough one to watch", "that one stings", "gotta bounce back fast",
        "the season just got more interesting", "rough timing for that result",
        // Record/Achievement
        "history being made", "generational stuff right there",
        "the record stood for a reason", "you have to see it to believe it",
        // Game commentary
        "always tune in for games like this", "every week is a movie in this league",
        "the talent level right now is insane", "coaching mattered a lot in this one",
        "this league never has a slow stretch", "parity is wild this season",
        // Roster/transactions
        "front office making moves", "bold move", "someone got a steal here",
        "depth is going to be tested now", "ripple effects from this are gonna be felt",
        // General engagement
        "love watching this play out", "the sport keeps delivering",
        "athletes at this level are just built different", "respect the grind",
        "could watch this all day", "the storylines this season are unreal",
        "good time to be a fan honestly", "wild to see",
    ],
    bankroll: [
        "bankroll management is key", "protect the roll",
        "smart money management", "never risk more than you can afford",
        "the roll is healthy", "responsible grinding"
    ]
};

// Horse personality modifiers for comments
const PERSONALITY_MODIFIERS = {
    aggressive: ["fr fr", "no cap", "straight up", "period", "on god", "deadass"],
    chill: ["honestly", "ngl", "lowkey", "vibes", "kinda", "maybe"],
    analytical: ["mathematically", "from a GTO perspective", "if we think about ranges", "+EV move", "solver approved"],
    funny: ["haha", "lmaooo", "bro", "dead", "crying", "i cant"],
    supportive: ["king", "legend", "goated", "built different", "respect"],
    skeptical: ["idk about this one", "sus play ngl", "questionable", "risky but ok"]
};

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
async function checkDailyLimit(horseProfileId, actionType) {
    const today = new Date().toISOString().split('T')[0];

    // Check different tables based on action type
    let count = 0;

    if (actionType === 'likes') {
        const { count: likeCount } = await getSupabase()
            .from('social_likes')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', horseProfileId)
            .gte('created_at', today);
        count = likeCount || 0;
    } else if (actionType === 'comments' || actionType === 'replies') {
        const { count: commentCount } = await getSupabase()
            .from('social_comments')
            .select('*', { count: 'exact', head: true })
            .eq('author_id', horseProfileId)
            .gte('created_at', today);
        count = commentCount || 0;
    } else if (actionType === 'friend_requests') {
        const { count: friendCount } = await getSupabase()
            .from('friendships')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', horseProfileId)
            .gte('created_at', today);
        count = friendCount || 0;
    }

    const limit = DAILY_LIMITS[actionType] || 20;
    return count < limit;
}

// Check cooldown - has horse interacted with this target recently?
async function checkCooldown(horseProfileId, targetId, actionType) {
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
        return true; // No cooldown defined, allow
    }

    const cutoffTime = new Date(Date.now() - cooldownMs).toISOString();

    const { data } = await getSupabase()
        .from(tableName)
        .select('id')
        .eq(targetColumn === 'post_id' ? (tableName === 'social_likes' ? 'post_id' : 'post_id') : 'parent_id', targetId)
        .eq(tableName === 'social_likes' ? 'user_id' : 'author_id', horseProfileId)
        .gte('created_at', cutoffTime)
        .limit(1);

    return !data || data.length === 0; // Return true if no recent interaction
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

/**
 * Send friend requests from horses to other horses AND real users
 */
export async function sendFriendRequests(maxRequests = 10) {
    console.debug('\n🤝 SENDING FRIEND REQUESTS...');

    // Get all horses
    const { data: horses } = await getSupabase()
        .from('content_authors')
        .select('id, name, profile_id')
        .eq('is_active', true)
        .not('profile_id', 'is', null);

    if (!horses || horses.length < 2) return { sent: 0 };

    const horseIds = horses.map(h => h.profile_id);

    // Get real users (non-horse profiles) for horses to befriend
    const { data: realUsers } = await getSupabase()
        .from('profiles')
        .select('id, username, full_name')
        .not('id', 'in', `(${horseIds.join(',')})`)
        .limit(50);

    // Combine potential targets: other horses + real users
    const allTargets = [
        ...horses.map(h => ({ profile_id: h.profile_id, name: h.name, isHorse: true })),
        ...(realUsers || []).map(u => ({ profile_id: u.id, name: u.full_name || u.username, isHorse: false }))
    ];

    let requestsSent = 0;

    // Each horse sends a few friend requests
    for (const horse of horses.slice(0, maxRequests * 2)) {
        // Pick a random target to befriend (prioritize real users 70% of time)
        const targetPool = Math.random() < 0.7
            ? allTargets.filter(t => !t.isHorse && t.profile_id !== horse.profile_id)
            : allTargets.filter(t => t.profile_id !== horse.profile_id);

        const target = targetPool[Math.floor(Math.random() * targetPool.length)];

        if (!target) continue;

        // Check if already friends or pending (use limit(1) — bidirectional rows produce 2 results, breaking maybeSingle)
        const { data: existingRows } = await getSupabase()
            .from('friendships')
            .select('id')
            .or(`and(user_id.eq.${horse.profile_id},friend_id.eq.${target.profile_id}),and(user_id.eq.${target.profile_id},friend_id.eq.${horse.profile_id})`)
            .limit(1);

        if (existingRows && existingRows.length > 0) continue; // Already have relationship

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
        }

        await new Promise(r => setTimeout(r, 500)); // Rate limit
    }

    console.debug(`   Sent: ${requestsSent} friend requests`);
    return { sent: requestsSent };
}

/**
 * Accept pending friend requests
 */
export async function acceptFriendRequests(maxAccepts = 15) {
    console.debug('\n✅ ACCEPTING FRIEND REQUESTS...');

    // Get all horses
    const { data: horses } = await getSupabase()
        .from('content_authors')
        .select('id, name, profile_id')
        .eq('is_active', true)
        .not('profile_id', 'is', null);

    if (!horses) return { accepted: 0 };

    const horseIds = horses.map(h => h.profile_id);

    // Find pending requests TO horses
    const { data: pending } = await getSupabase()
        .from('friendships')
        .select('id, user_id, friend_id')
        .eq('status', 'pending')
        .in('friend_id', horseIds)
        .limit(maxAccepts * 2);

    if (!pending?.length) {
        console.debug('   No pending requests to accept');
        return { accepted: 0 };
    }

    let accepted = 0;

    for (const request of pending) {
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
            }
        }

        await new Promise(r => setTimeout(r, 300));
    }

    console.debug(`   Accepted: ${accepted} requests`);
    return { accepted };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMENT ENGINE
// ═══════════════════════════════════════════════════════════════════════════

export function getRandomComment(type = 'general') {
    const templates = COMMENT_TEMPLATES[type] || COMMENT_TEMPLATES.general;
    return templates[Math.floor(Math.random() * templates.length)];
}

/**
 * Horses comment on posts from horses AND real users
 * Uses per-horse scheduling and writing styles
 */
export async function commentOnPosts(maxComments = 20, includeRealUsers = true) {
    const now = new Date();

    console.debug(`\n💬 HORSES COMMENTING ON POSTS...`);

    // Get all horses
    const { data: allHorses } = await getSupabase()
        .from('content_authors')
        .select('id, name, profile_id, avatar_url, timezone')
        .eq('is_active', true)
        .not('profile_id', 'is', null);

    if (!allHorses) return { commented: 0, activeHorses: 0 };

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
        return { commented: 0, activeHorses: 0 };
    }

    const horseIds = allHorses.map(h => h.profile_id);

    // Get recent posts
    let postsQuery = getSupabase()
        .from('social_posts')
        .select('id, author_id, content_type, content, link_site_name, metadata')
        .order('created_at', { ascending: false })
        .limit(50);

    // Phase 12 - Inter-Bot Drama: Allow horses to also see all horse posts
    const { data: posts } = await postsQuery;

    if (!posts?.length) {
        console.debug('   No posts to comment on');
        return { commented: 0, activeHorses: activeHorses.length };
    }

    let commented = 0;

    // Each ACTIVE horse may comment on some posts
    for (const horse of activeHorses) {
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

        // Check anti-spam cooldown
        const canComment = await checkCooldown(horse.profile_id, post.id, 'comment_post');
        if (!canComment) continue;

        // Check daily limit
        const withinLimit = await checkDailyLimit(horse.profile_id, 'comments');
        if (!withinLimit) continue;

        // Keyword-based contextual comment type selection
        // Priority: explicit clip_type metadata > link_site_name > content text keywords
        let commentType = 'general';
        const lc = (post.content || '').toLowerCase();

        // BUG FIX 2026-04-28: Sports video posts (from sports_clips) have content_type='video'
        // and metadata.clip_type='sports' but NO link_site_name. Without this check they fell
        // through to commentType='video' which uses poker-lingo COMMENT_TEMPLATES.
        const isSportsByMeta = post.metadata?.clip_type === 'sports';
        const isSportsBySource = post.link_site_name && (
            post.link_site_name.includes('ESPN') ||
            post.link_site_name.includes('Yahoo') ||
            post.link_site_name.includes('CBS') ||
            post.link_site_name.includes('Sports')
        );
        const isSports = isSportsByMeta || isSportsBySource;

        // Route to correct HumanVoiceEngine pool:
        // Sports content never gets poker pools. Poker video only if explicitly poker clip.
        if (isSports) commentType = 'sports';
        else if (post.content_type === 'video' && post.metadata?.clip_type === 'poker') commentType = 'video';
        else if (post.content_type === 'video') commentType = 'video'; // fallback for untagged video
        else if (post.content_type === 'photo') commentType = 'photo';
        else if (/\b(bad beat|suck.?out|cooler|one.?outer|runner.?runner)\b/.test(lc)) commentType = 'bad_beat';
        else if (/\b(wsop|bracelet|world series of poker)\b/.test(lc)) commentType = 'tournament';
        else if (/\b(tournament|final table|bubble|mtt)\b/.test(lc)) commentType = 'tournament';
        else if (/\b(bluff|hero.?call|hero.?fold)\b/.test(lc)) commentType = 'bluff';
        else if (/\b(session|profit|cashed)\b/.test(lc)) commentType = 'session_report';
        else if (/\b(grind|grinding|volume|hours played)\b/.test(lc)) commentType = 'grind';
        else if (/\b(variance|downswing|upswing|run bad|run good)\b/.test(lc)) commentType = 'variance';
        else if (/\b(strategy|gto|solver|ev|bet sizing)\b/.test(lc)) commentType = 'strategy';

        // Use HumanVoiceEngine.generateComment — has full dedup, per-horse archetype system,
        // proper capitalization, punctuation, and NO slang/GTO flair on sports content.
        // This replaces the old getRandomComment() + applyWritingStyle() pipeline which
        // produced poker lingo on sports posts and short slang-only phrases.
        let comment = generateComment(commentType, horse.profile_id, post.id);
        // Safety: if the engine returns something too short, use a general fallback
        if (!comment || comment.trim().length < 5) {
            comment = generateComment('general', horse.profile_id, post.id);
        }

        // 🟢 DYNAMIC TYPING INDICATOR (Phase 11)
        // Broadcast a typing payload to all connected clients viewing this post
        try {
            await getSupabase().channel('social-feed').send({
                type: 'broadcast',
                event: 'typing',
                payload: {
                    post_id: post.id,
                    user_id: horse.profile_id,
                    name: horse.name,
                    avatar_url: horse.avatar_url || null,
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

        // Insert comment
        const { error } = await getSupabase()
            .from('social_comments')
            .insert({
                post_id: post.id,
                author_id: horse.profile_id,
                content: comment
            });

        // Phase 28: @Mention — 15% chance to tag a horse friend
        if (!error && Math.random() < 0.15) {
            const otherHorses = allHorses.filter(h => h.profile_id !== horse.profile_id);
            if (otherHorses.length > 0) {
                const friend = otherHorses[Math.floor(Math.random() * otherHorses.length)];
                const { data: friendProfile } = await getSupabase()
                    .from('profiles').select('username').eq('id', friend.profile_id).maybeSingle();
                if (friendProfile?.username) {
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
        }

        if (!error) {
            // Trigger push notification to the post author
            await sendSocialPush(post.author_id, horseIds, 'New Comment', `${horse.name} commented on your post: "${comment}"`, `/hub/social-media?post_id=${post.id}`);

            const author = allHorses.find(h => h.profile_id === post.author_id);
            console.debug(`   ${horse.name} → ${author?.name || 'User'}'s post: "${comment}"`);
            commented++;
            
            // Sync denormalized comment_count on social_posts (fire-and-forget)
            // NOTE: Wrap in Promise.resolve() — Supabase v2 PostgrestBuilder is a thenable
            // but not a native Promise; calling .catch() directly on it throws TypeError
            // in newer Supabase versions.
            void Promise.resolve(getSupabase().rpc('increment_post_count', { p_post_id: post.id, p_field: 'comment_count' })).catch(() => {
                void getSupabase().from('social_posts').select('comment_count').eq('id', post.id).maybeSingle().then(({ data: p }) => {
                    if (p) void getSupabase().from('social_posts').update({ comment_count: (p.comment_count || 0) + 1 }).eq('id', post.id);
                }).catch(e => console.warn('[App] Handled promise rejection:', e?.message || e));
            });

            if (commented >= maxComments) break;
        }

        // Reduced delay between horses (0.5-2 seconds) for cron efficiency
        await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
    }

    console.debug(`   Posted: ${commented} comments from ${activeHorses.length} active horses`);
    return { commented, activeHorses: activeHorses.length };
}

/**
 * Horses like posts from horses AND real users
 * Now uses per-horse scheduling - each horse only acts during their unique time slot
 */
export async function likePosts(maxLikes = 30, includeRealUsers = true) {
    const now = new Date();

    console.debug(`\n❤️ HORSES LIKING POSTS...`);

    // Get all horses
    const { data: allHorses } = await getSupabase()
        .from('content_authors')
        .select('id, name, profile_id, timezone')
        .eq('is_active', true)
        .not('profile_id', 'is', null);

    if (!allHorses) return { liked: 0, activeHorses: 0 };

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
        return { liked: 0, activeHorses: 0 };
    }

    const horseIds = allHorses.map(h => h.profile_id);

    // Get recent posts
    let postsQuery = getSupabase()
        .from('social_posts')
        .select('id, author_id')
        .order('created_at', { ascending: false })
        .limit(100);

    // Phase 12 - Inter-Bot Drama: Allow horses to also like all horse posts
    const { data: posts } = await postsQuery;

    if (!posts?.length) return { liked: 0, activeHorses: activeHorses.length };

    let liked = 0;

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

            // Check cooldown
            const canLike = await checkCooldown(horse.profile_id, post.id, 'like_post');
            if (!canLike) continue;

            // Check for existing like
            const { data: existing } = await getSupabase()
                .from('social_likes')
                .select('id')
                .eq('post_id', post.id)
                .eq('user_id', horse.profile_id)
                .maybeSingle();

            if (existing) continue;

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
                
                // Sync denormalized like_count on social_posts (fire-and-forget)
                // NOTE: Wrap in Promise.resolve() — see comment on increment_post_count above.
                void Promise.resolve(getSupabase().rpc('increment_post_count', { p_post_id: post.id, p_field: 'like_count' })).catch(() => {
                    void getSupabase().from('social_posts').select('like_count').eq('id', post.id).maybeSingle().then(({ data: p }) => {
                        if (p) void getSupabase().from('social_posts').update({ like_count: (p.like_count || 0) + 1 }).eq('id', post.id);
                    }).catch(e => console.warn('[App] Handled promise rejection:', e?.message || e));
                });
            }
        }

        // Reduced delay between horses (0.5-2 seconds) for cron efficiency
        await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
    }

    console.debug(`   Liked: ${liked} posts from ${activeHorses.length} active horses`);
    return { liked, activeHorses: activeHorses.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// REPLY TO COMMENTS ENGINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Horses reply to comments on posts (both horse and real user comments)
 * Uses per-horse scheduling and writing styles
 */
export async function replyToComments(maxReplies = 15) {
    const now = new Date();

    console.debug(`\n💬 HORSES REPLYING TO COMMENTS...`);

    // Get all horses
    const { data: allHorses } = await getSupabase()
        .from('content_authors')
        .select('id, name, profile_id, voice, timezone')
        .eq('is_active', true)
        .not('profile_id', 'is', null);

    if (!allHorses) return { replied: 0, activeHorses: 0 };

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
        return { replied: 0, activeHorses: 0 };
    }

    const horseIds = allHorses.map(h => h.profile_id);

    // Get recent TOP-LEVEL comments only (no replies)
    // BUG-WR04 FIX: without .is('parent_id', null), horses were replying to replies,
    // creating infinite nested reply chains (reply → reply → reply...)
    const { data: comments } = await getSupabase()
        .from('social_comments')
        .select('id, post_id, author_id, content, created_at')
        .is('parent_id', null)
        .order('created_at', { ascending: false })
        .limit(50);

    if (!comments?.length) {
        console.debug('   No comments to reply to');
        return { replied: 0, activeHorses: activeHorses.length };
    }

    let replied = 0;

    // Each ACTIVE horse may reply to comments
    for (const horse of activeHorses) {
        // Check probability
        const activityRate = getHorseActivityRate(horse.profile_id, 'reply');
        if (Math.random() > activityRate) {
            console.debug(`   ${horse.name} chose not to reply (rate: ${(activityRate * 100).toFixed(0)}%)`);
            continue;
        }

        // Pick a comment to reply to (not their own)
        const eligibleComments = comments.filter(c =>
            c.author_id !== horse.profile_id &&
            // Reduce horse-to-horse reply spam
            (!horseIds.includes(c.author_id) || Math.random() < 0.3)
        );
        const comment = eligibleComments[Math.floor(Math.random() * eligibleComments.length)];

        if (!comment) continue;

        // Check cooldown
        const canReply = await checkCooldown(horse.profile_id, comment.id, 'reply_comment');
        if (!canReply) continue;

        // Check for existing reply
        const { data: existingReply } = await getSupabase()
            .from('social_comments')
            .select('id')
            .eq('parent_id', comment.id)
            .eq('author_id', horse.profile_id)
            .maybeSingle();

        if (existingReply) continue;

        // Generate reply using HumanVoiceEngine — proper voice, dedup, no slang noise.
        // Detect if the comment being replied to is DEFINITELY sports context.
        // BUG-FIX 2026-04-28: Original regex included 'game','player','team','season','coach',
        // 'trade','athlete','roster' — all of which appear frequently in poker commentary
        // ("the mental game", "the player tanked", "this team at the table").
        // This caused poker reply threads to incorrectly get sports comment pool content
        // ("Athletes at this level are just built different", "Is this the best player in the world?").
        // Fix: only match unambiguously sport-specific league/sport names, never generic nouns.
        const replyToSports = comment.content && (
            /\b(nba|nfl|mlb|nhl|ufc|mma|basketball|football|baseball|hockey|soccer|mls|pga|wnba|ncaa|lakers|celtics|chiefs|patriots|yankees|dodgers|curry|lebron|mahomes)\b/i.test(comment.content)
        );
        const replyCommentType = replyToSports ? 'sports' : 'general';
        let replyText = generateComment(replyCommentType, horse.profile_id, comment.post_id);
        if (!replyText || replyText.trim().length < 5) {
            replyText = generateComment('general', horse.profile_id, comment.post_id);
        }

        // Insert reply
        const { error } = await getSupabase()
            .from('social_comments')
            .insert({
                post_id: comment.post_id,
                author_id: horse.profile_id,
                content: replyText,
                parent_id: comment.id
            });

        if (!error) {
            // Trigger push notification to the original comment author
            await sendSocialPush(comment.author_id, horseIds, 'New Reply', `${horse.name} replied to your comment: "${replyText}"`, `/hub/social-media?post_id=${comment.post_id}`);

            console.debug(`   ${horse.name} replied: "${replyText}"`);
            replied++;
            
            // Sync denormalized comment_count on social_posts (fire-and-forget)
            // NOTE: Wrap in Promise.resolve() — see comment on increment_post_count above.
            void Promise.resolve(getSupabase().rpc('increment_post_count', { p_post_id: comment.post_id, p_field: 'comment_count' })).catch(() => {
                void getSupabase().from('social_posts').select('comment_count').eq('id', comment.post_id).maybeSingle().then(({ data: p }) => {
                    if (p) void getSupabase().from('social_posts').update({ comment_count: (p.comment_count || 0) + 1 }).eq('id', comment.post_id);
                }).catch(e => console.warn('[App] Handled promise rejection:', e?.message || e));
            });

            if (replied >= maxReplies) break;
        }

        // Reduced delay between horses (0.5-2 seconds) for cron efficiency
        await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
    }

    console.debug(`   Replied: ${replied} times from ${activeHorses.length} active horses`);
    return { replied, activeHorses: activeHorses.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SOCIAL INTERACTION LOOP
// ═══════════════════════════════════════════════════════════════════════════

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
        if (includeFriends) {
            const friendResults = await sendFriendRequests(10);
            const acceptResults = await acceptFriendRequests(15);
            results.friendsSent = friendResults.sent;
            results.friendsAccepted = acceptResults.accepted;
        }

        // 2. Comment on posts
        if (includeComments) {
            const commentResults = await commentOnPosts(20, includeRealUsers);
            results.commented = commentResults.commented;
        }

        // 3. Like posts
        if (includeLikes) {
            const likeResults = await likePosts(30, includeRealUsers);
            results.liked = likeResults.liked;
        }

        // 4. Reply to comments
        if (includeReplies) {
            const replyResults = await replyToComments(15);
            results.replied = replyResults.replied;
        }

        // 5. React to comments (Phase 27)
        if (includeCommentReactions) {
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

    console.debug(`\n🔥 HORSES REACTING TO COMMENTS...`);

    const { data: allHorses } = await getSupabase()
        .from('content_authors')
        .select('id, name, profile_id, timezone')
        .eq('is_active', true)
        .not('profile_id', 'is', null);

    if (!allHorses) return { reacted: 0 };

    const activeHorses = allHorses.filter(horse => {
        // 2026-09-05: hour-granular gate over the whole fleet. The minute-slot
        // gate this replaced admitted ~8% of horses (see FleetScheduler.ts).
        return isOnlineNow(horse.profile_id, horse.timezone, now);
    });
    shuffleHorses(activeHorses);

    if (activeHorses.length === 0) return { reacted: 0 };

    const horseIds = allHorses.map(h => h.profile_id);

    // Get recent comments from other horses (need post_id for social_interactions write)
    const { data: recentComments } = await getSupabase()
        .from('social_comments')
        .select('id, post_id, author_id')
        .in('author_id', horseIds)
        .order('created_at', { ascending: false })
        .limit(50);

    if (!recentComments?.length) return { reacted: 0 };

    let reacted = 0;

    for (const horse of activeHorses) {
        if (Math.random() > 0.3) continue; // 30% chance to react

        const eligibleComments = recentComments.filter(c => c.author_id !== horse.profile_id);
        if (eligibleComments.length === 0) continue;

        const comment = eligibleComments[Math.floor(Math.random() * eligibleComments.length)];

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
        }

        if (reacted >= maxReactions) break;
        await new Promise(r => setTimeout(r, 500));
    }

    console.debug(`   Reacted to ${reacted} comments`);
    return { reacted };
}

// Run if called directly
if (typeof window === 'undefined' && process.argv[1]?.includes('HorseSocialEngine')) {
    runSocialInteractions();
}

