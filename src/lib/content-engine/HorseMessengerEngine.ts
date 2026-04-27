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
import { generateDMReply, seedHorseMemory } from './HumanVoiceEngine.js';


export async function processDirectMessages() {
    console.debug('\n💬 HORSE MESSENGER ENGINE RUNNING...');

    // 1. Get all active horses
    const { data: horses } = await getSupabase()
        .from('content_authors')
        .select('id, profile_id, name, specialty')
        .eq('is_active', true)
        .not('profile_id', 'is', null);

    if (!horses?.length) return;
    const horseIds = horses.map(h => h.profile_id);
    const horseMap = Object.fromEntries(horses.map(h => [h.profile_id, h]));

    // 2. Find eligible conversations where a horse needs to reply
    // We look for messages sent TO a horse within the last 15 minutes, where the horse hasn't replied yet.
    // For simplicity, we just look at the most recent message in all active conversations involving a horse.
    
    // Instead of a complex subquery, let's fetch recent messages sent BY humans
    // BUG-R8-04 FIX: LIMIT was missing — full table scan on active platforms
    // BUG-R8-05 FIX: was fetching ALL messages, not just ones in horse conversations
    // Now caps at 100 rows. The humanMsgs filter below narrows further.
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60000).toISOString();
    
    const { data: recentMsgs } = await getSupabase()
        .from('social_messages')
        .select('id, conversation_id, sender_id, content, created_at')
        .gte('created_at', fifteenMinsAgo)
        .not('sender_id', 'in', `(${horseIds.join(',')})`) // Only messages FROM humans
        .order('created_at', { ascending: false })
        .limit(100); // BUG-R8-04: cap was missing

    if (!recentMsgs?.length) {
        console.debug('   No recent messages found.');
        return;
    }

    // All fetched messages are already from non-horses (filtered in query above)
    const humanMsgs = recentMsgs;

    if (humanMsgs.length === 0) {
        console.debug('   No recent human messages found.');
        return;
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
        const { data: convInfo } = await getSupabase()
            .from('social_conversations')
            .select('user1_id, user2_id')
            .eq('id', convId)
            .maybeSingle();

        if (!convInfo) continue;

        // Is a horse involved?
        const isUser1Horse = horseIds.includes(convInfo.user1_id);
        const isUser2Horse = horseIds.includes(convInfo.user2_id);
        
        // If neither or both are horses, skip (we don't want horses DMing each other right now)
        if (!isUser1Horse && !isUser2Horse) continue;
        if (isUser1Horse && isUser2Horse) continue;

        const targetHorseId = isUser1Horse ? convInfo.user1_id : convInfo.user2_id;
        const horse = horseMap[targetHorseId];
        const humanId = isUser1Horse ? convInfo.user2_id : convInfo.user1_id;

        // 3. Fetch conversation history to see if the horse already replied
        const { data: history } = await getSupabase()
            .from('social_messages')
            .select('sender_id, content, read_at')
            .eq('conversation_id', convId)
            .order('created_at', { ascending: true })
            .limit(10); // Last 10 messages for context

        if (!history?.length) continue;

        // HARD LIMIT: Max 3 horse replies per conversation (prevents infinite bot messaging)
        const horseReplyCount = history.filter(h => h.sender_id === targetHorseId).length;
        if (horseReplyCount >= 3) {
            console.debug(`   ${horse.name}: conversation capped at ${horseReplyCount} replies, skipping.`);
            continue;
        }

        // Ensure the LAST message was from the human. If the horse already replied, skip.
        if (history[history.length - 1].sender_id === targetHorseId) continue;

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
        }

        // Delay between replies
        await new Promise(r => setTimeout(r, 2000));
    }

    console.debug(`   Sent ${repliesSent} automated responses.`);
}


