// @ts-nocheck — JS-port file, runtime behavior verified against monolith JS source

/**
 * HorseMessengerEngine — Phase 2B.2-followup port (2026-04-26)
 *
 * Ported from src/content-engine/pipeline/HorseMessengerEngine.js (207 LOC).
 *
 * Automates 2-3 turn realistic DM conversations between horses and
 * real users. Triggered by users liking/commenting on a horse's post,
 * or directly DMing a horse. Uses HumanVoiceEngine for zero-cost,
 * personality-driven, emoji-free responses.
 *
 * Functions exported:
 *   processDirectMessages()
 */

/**
 * 🐴 HORSE MESSENGER ENGINE - Automated Direct Messaging via HumanVoiceEngine
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Automates 2-3 turn realistic DM conversations between Horses and real users.
 * Triggered by users liking or commenting on a horse's post, or directly DMing a horse.
 * Uses HumanVoiceEngine to generate zero-cost, personality-driven, emoji-free responses.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { getSupabase } from '../supabase.js';
import { pagedSelect } from '../pagedSelect.js';
import { loadFleet, engineEnabled } from './Fleet.js';
import { generateDMReply, seedHorseMemory } from './HumanVoiceEngine.js';

// Messages from the last 15 minutes are read to the end, up to this ceiling.
const RECENT_MESSAGES_MAX = 5_000;
// One conversation is read to the end, up to this ceiling, before a horse
// answers in it. A longer one is skipped: its reply count cannot be known.
const CONVERSATION_MAX = 2_000;

/** D2: the kill switch, re-read here and before every write below. */
async function switchStillOn(): Promise<boolean> {
    try {
        return await engineEnabled();
    } catch {
        return false;
    }
}

function bump(skips: Record<string, number>, reason: string): void {
    skips[reason] = (skips[reason] ?? 0) + 1;
}

/**
 * Horse replies to people's direct messages stay OFF until the owner settles
 * the DM product contract (Fleet Content Programme, Phase 3B: resolve the
 * product contract before building horse DMs). This step never replied to
 * anyone in production: its human-message read put every horse id into a GET
 * NOT IN list, PostgREST refused it, and the error was ignored, so it always
 * found nothing. Repairing that read (2026-09-21) must not switch horse DMs on
 * as a side effect, so the run says why it did nothing. The repaired path is
 * exercised by tests through `repliesEnabled`.
 */
export const HORSE_DM_REPLIES_ENABLED = false;

export async function processDirectMessages(options: { repliesEnabled?: boolean } = {}) {
    console.debug('\n💬 HORSE MESSENGER ENGINE RUNNING...');
    const skips: Record<string, number> = {};

    if (!(await switchStillOn())) return { replied: 0, skip_reasons: { engine_disabled: 1 } };
    if (!(options.repliesEnabled ?? HORSE_DM_REPLIES_ENABLED)) {
        return { replied: 0, skip_reasons: { dm_replies_held: 1 } };
    }

    // 1. Get all active horses.
    // A1 (2026-09-21): the paged roster. This read had no .range(), so the
    // PostgREST page of 1,000 rows was the whole fleet today and one horse
    // short tomorrow: a person writing to horse 1,001 would never hear back.
    let horses;
    try {
        horses = await loadFleet();
    } catch (e) {
        console.warn('[HorseMessenger] roster unreadable; skipping:', e instanceof Error ? e.message : e);
        return { replied: 0, skip_reasons: { roster_unreadable: 1 } };
    }

    if (!horses?.length) return { replied: 0, skip_reasons: skips };
    const horseIdSet = new Set(horses.map(h => h.profile_id));
    const horseMap = Object.fromEntries(horses.map(h => [h.profile_id, h]));

    // 2. Find eligible conversations where a horse needs to reply
    // We look for messages sent TO a horse within the last 15 minutes, where the horse hasn't replied yet.
    // For simplicity, we just look at the most recent message in all active conversations involving a horse.
    //
    // 2026-09-21: "only messages FROM humans" was a NOT IN list of every
    // horse id on a GET, 1,000 UUIDs in one URL (the request PostgREST
    // refused in reactToComments), and its error was ignored, so this step
    // found no messages at all. The 15-minute window is read to the end and
    // filtered here instead; a window that cannot be read skips the step.
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60000).toISOString();

    let humanMsgs;
    try {
        const { rows, truncated } = await pagedSelect(
            () => getSupabase()
                .from('social_messages')
                .select('id, conversation_id, sender_id, content, created_at')
                .gte('created_at', fifteenMinsAgo)
                .order('created_at', { ascending: false })
                .order('id', { ascending: false }),
            RECENT_MESSAGES_MAX,
        );
        if (truncated) bump(skips, 'messages_truncated');
        humanMsgs = rows.filter(m => !horseIdSet.has(m.sender_id)); // Only messages FROM humans
    } catch (e) {
        console.warn('[HorseMessenger] recent messages unreadable; skipping:', e instanceof Error ? e.message : e);
        return { replied: 0, skip_reasons: { messages_unreadable: 1 } };
    }

    if (humanMsgs.length === 0) {
        console.debug('   No recent human messages found.');
        return { replied: 0, skip_reasons: skips };
    }

    // Group by conversation
    const convMap = {};
    for (const msg of humanMsgs) {
        if (!convMap[msg.conversation_id]) {
            convMap[msg.conversation_id] = msg; // Store the most recent human message
        }
    }

    let repliesSent = 0;
    // BUG-R8-03 FIX: unbounded conversation loop blows Vercel 60s limit
    // Cap at 3 conversations per cron run (each takes 4-12s with delays)
    const MAX_CONVS_PER_RUN = 3;
    let convsProcessed = 0;

    for (const convId of Object.keys(convMap || {})) {
        if (convsProcessed >= MAX_CONVS_PER_RUN) break; // BUG-R8-03: deadline guard
        // Fetch the conversation details to see who is in it
        const { data: convInfo, error: convErr } = await getSupabase()
            .from('social_conversations')
            .select('user1_id, user2_id')
            .eq('id', convId)
            .maybeSingle();

        if (convErr) {
            bump(skips, 'conversation_unreadable');
            continue;
        }
        if (!convInfo) continue;

        // Is a horse involved?
        const isUser1Horse = horseIdSet.has(convInfo.user1_id);
        const isUser2Horse = horseIdSet.has(convInfo.user2_id);
        
        // If neither or both are horses, skip (we don't want horses DMing each other right now)
        if (!isUser1Horse && !isUser2Horse) continue;
        if (isUser1Horse && isUser2Horse) continue;

        const targetHorseId = isUser1Horse ? convInfo.user1_id : convInfo.user2_id;
        const horse = horseMap[targetHorseId];
        const humanId = isUser1Horse ? convInfo.user2_id : convInfo.user1_id;

        // 3. Fetch the WHOLE conversation to see if the horse already replied.
        // 2026-09-21: this read the FIRST ten messages (ascending, limit 10)
        // while its comment said "last 10", so in a longer conversation the
        // three-reply cap counted only the opening and "was the last message
        // from the human" looked at message ten. Read to the end, or skip.
        let history;
        try {
            const { rows, truncated } = await pagedSelect(
                () => getSupabase()
                    .from('social_messages')
                    .select('id, sender_id, content, read_at, created_at')
                    .eq('conversation_id', convId)
                    .order('created_at', { ascending: true })
                    .order('id', { ascending: true }),
                CONVERSATION_MAX,
            );
            if (truncated) {
                bump(skips, 'conversation_truncated');
                continue;
            }
            history = rows;
        } catch {
            bump(skips, 'conversation_unreadable');
            continue;
        }

        if (!history.length) continue;

        // HARD LIMIT: Max 3 horse replies per conversation (prevents infinite bot messaging)
        const horseReplyCount = history.filter(h => h.sender_id === targetHorseId).length;
        if (horseReplyCount >= 3) {
            console.debug(`   ${horse.name}: conversation capped at ${horseReplyCount} replies, skipping.`);
            bump(skips, 'conversation_cap');
            continue;
        }

        // Ensure the LAST message was from the human. If the horse already replied, skip.
        if (history[history.length - 1].sender_id === targetHorseId) continue;

        // D2: the switch is re-read before the first write in a conversation.
        if (!(await switchStillOn())) {
            bump(skips, 'engine_disabled');
            break;
        }

        // Phase 17: Read Receipt — Mark the human's last message as "Seen"
        const lastHumanMsg = [...history].reverse().find(h => h.sender_id !== targetHorseId);
        if (lastHumanMsg && !lastHumanMsg.read_at) {
            await getSupabase().from('social_messages')
                .update({ read_at: new Date().toISOString() })
                .eq('conversation_id', convId)
                .eq('sender_id', lastHumanMsg.sender_id)
                .is('read_at', null);
            console.debug(`   ${horse.name} read the message (Seen)`);
        }

        // BUG-R8-03 FIX: 2-8s delay was too long when processing multiple convs
        // Reduced to 1-4s — still feels human, fits within deadline
        const thinkDelay = 1000 + Math.random() * 3000;
        await new Promise(r => setTimeout(r, thinkDelay));

        // 4. Generate AI Reply
        console.debug(`   Generating DM reply for ${horse.name} (Conv ~ ${history.length} msgs)...`);
        
        // Seed horse memory from recent DMs (prevents cross-session repeats)
        const { data: recentDMs } = await getSupabase()
            .from('social_messages')
            .select('content')
            .eq('sender_id', targetHorseId)
            .order('created_at', { ascending: false })
            .limit(15);
        if (recentDMs?.length) {
            seedHorseMemory(targetHorseId, recentDMs.map(p => p.content || '').filter(Boolean));
        }

        const replyContent = generateDMReply(history.length, targetHorseId);

        if (!replyContent) continue;

        // D2: and again immediately before the message is sent.
        if (!(await switchStillOn())) {
            bump(skips, 'engine_disabled');
            break;
        }

        // 5. Send the reply
        const { error: insertErr } = await getSupabase()
            .from('social_messages')
            .insert({
                conversation_id: convId,
                sender_id: targetHorseId,
                content: replyContent
            });

        if (!insertErr) {
            // Update conversation preview
            await getSupabase().from('social_conversations')
                .update({ 
                    last_message_preview: replyContent, 
                    updated_at: new Date().toISOString() 
                })
                .eq('id', convId);

            console.debug(`   ${horse.name} 💬: "${replyContent}" ✓`);
            repliesSent++;
            convsProcessed++;
        } else {
            bump(skips, 'insert_failed');
        }

        // Delay between replies
        await new Promise(r => setTimeout(r, 2000));
    }

    console.debug(`   Sent ${repliesSent} automated responses.`);
    // An object, so the route no longer lists "DMs" as skipped on every run
    // (it treats a falsy result as a step that did not run).
    return { replied: repliesSent, skip_reasons: skips };
}
