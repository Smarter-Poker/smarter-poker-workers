/**
 * POST /cron/auto-settlement-distribute
 *
 * Ported from pages/api/cron/auto-settlement-distribute.js (2026-04-24, 398 lines).
 *
 * Monday 10:10 UTC (staggered to 10:15 on Hetzner secondary).
 * Phase 2 of the weekly settlement flow — runs AFTER auto-settlement closes
 * the periods and generates agent-to-player invoices, runs BEFORE
 * union-rakeback redistributes the union pool.
 *
 * FLOW:
 *   1. Load pending rakeback_distributions (limit 100 per run)
 *   2. Group by club → group by agent within club
 *   3. Per player distribution:
 *        a. DEBIT agent FIRST via fn_debit_chips — if this fails, NO chips move
 *        b. CREDIT player via fn_credit_chips
 *        c. On player-credit failure: ROLLBACK (re-credit agent so chips
 *           aren't created out of nothing)
 *        d. Record chip_transactions row + settlement_invoices update
 *        e. Best-effort notification insert
 *   4. Per agent: best-effort "rakeback distributed" notification
 *   5. PHASE 2: Deactivate all active settlement_locks
 *   6. Post "all clear" club_announcements per auto_settlement_enabled club
 *
 * Safety invariants preserved from monolith:
 *   - Debit-before-credit so failures never mint chips
 *   - Rollback path re-credits agent if player credit fails
 *   - Emergency unfreeze in the outer catch: if ANYTHING crashes after
 *     the freeze happened, unlock everything so normal ops resume
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

interface Distribution {
  id: string;
  club_id: string;
  agent_user_id: string;
  player_user_id: string;
  rakeback_amount: number;
  rakeback_percentage: number;
  player_rake_contributed: number;
  period_id: string;
  status: string;
}

interface Results {
  phase: string;
  distributions_processed: number;
  distributions_failed: number;
  total_rakeback_distributed: number;
  players_paid: number;
  clubs_unfrozen: number;
  messages_sent: number;
  errors: Array<Record<string, unknown>>;
  duration_ms?: number;
  fatal_error?: string;
}

export async function autoSettlementDistribute(c: Context) {
  const supabase = getSupabase();
  const startTime = Date.now();

  const markDistributionFailed = async (distId: string, errorMessage: string) => {
    await supabase
      .from('rakeback_distributions')
      .update({ status: 'failed', error_message: errorMessage })
      .eq('id', distId)
      .then(() => undefined, () => undefined);
  };

  const results: Results = {
    phase: 'started',
    distributions_processed: 0,
    distributions_failed: 0,
    total_rakeback_distributed: 0,
    players_paid: 0,
    clubs_unfrozen: 0,
    messages_sent: 0,
    errors: [],
  };

  try {
    // ═══ PHASE 1: PROCESS PENDING RAKEBACK DISTRIBUTIONS ═══
    results.phase = 'distributing';

    const { data: pendingData } = await supabase
      .from('rakeback_distributions')
      .select('*')
      .eq('status', 'pending')
      .order('club_id', { ascending: true })
      .limit(100);
    const pendingDistributions = (pendingData ?? []) as Distribution[];

    if (pendingDistributions.length === 0) {
      results.phase = 'no_distributions';
    } else {
      // Group by club
      const byClub: Record<string, Distribution[]> = {};
      for (const d of pendingDistributions) {
        (byClub[d.club_id] ??= []).push(d);
      }

      for (const [clubId, distributions] of Object.entries(byClub)) {
        // Group by agent within club
        const byAgent: Record<string, Distribution[]> = {};
        for (const d of distributions) {
          (byAgent[d.agent_user_id] ??= []).push(d);
        }

        for (const [agentUserId, agentDists] of Object.entries(byAgent)) {
          try {
            // Verify agent is a member of this club
            const { data: agentMember } = await supabase
              .from('club_members')
              .select('chip_balance')
              .eq('club_id', clubId)
              .eq('user_id', agentUserId)
              .maybeSingle();

            if (!agentMember) {
              for (const dist of agentDists) {
                await markDistributionFailed(dist.id, 'Agent not found in club');
                results.distributions_failed++;
              }
              continue;
            }

            let agentTotalDeducted = 0;
            let playersDistributed = 0;

            for (const dist of agentDists) {
              if (dist.rakeback_amount <= 0) {
                await markDistributionFailed(dist.id, 'Zero or negative amount after adjustment');
                results.distributions_failed++;
                continue;
              }

              try {
                // Verify player still in club
                const { data: playerMember } = await supabase
                  .from('club_members')
                  .select('chip_balance, nickname')
                  .eq('club_id', clubId)
                  .eq('user_id', dist.player_user_id)
                  .maybeSingle();

                if (!playerMember) {
                  await markDistributionFailed(dist.id, 'Player not found in club');
                  results.distributions_failed++;
                  continue;
                }

                // STEP 1 — Debit agent FIRST. If this fails, no chips move.
                const { error: debitErr } = await supabase.rpc('fn_debit_chips', {
                  p_club_id: clubId,
                  p_user_id: agentUserId,
                  p_amount: dist.rakeback_amount,
                });
                if (debitErr) {
                  await markDistributionFailed(dist.id, `Agent debit failed: ${debitErr.message}`);
                  results.distributions_failed++;
                  continue;
                }

                // STEP 2 — Credit player. If this fails, roll back the debit.
                const { error: creditErr } = await supabase.rpc('fn_credit_chips', {
                  p_club_id: clubId,
                  p_user_id: dist.player_user_id,
                  p_amount: dist.rakeback_amount,
                });
                if (creditErr) {
                  // ROLLBACK — re-credit agent so chips aren't minted
                  try {
                    await supabase.rpc('fn_credit_chips', {
                      p_club_id: clubId,
                      p_user_id: agentUserId,
                      p_amount: dist.rakeback_amount,
                    });
                  } catch (rbErr) {
                    console.warn(
                      '[auto-settlement-distribute] rollback failed:',
                      rbErr instanceof Error ? rbErr.message : rbErr,
                    );
                  }
                  await markDistributionFailed(dist.id, `Player credit failed: ${creditErr.message}`);
                  results.distributions_failed++;
                  continue;
                }

                // Record the chip_transactions row
                const { data: txn } = await supabase
                  .from('chip_transactions')
                  .insert({
                    club_id: clubId,
                    from_user_id: agentUserId,
                    to_user_id: dist.player_user_id,
                    amount: dist.rakeback_amount,
                    transaction_type: 'rakeback',
                    notes: `Auto-rakeback: ${dist.rakeback_amount.toLocaleString()} chips (${(dist.rakeback_percentage * 100).toFixed(1)}% of ${dist.player_rake_contributed.toLocaleString()} rake contributed)`,
                    metadata: {
                      period_id: dist.period_id,
                      distribution_id: dist.id,
                      settlement_type: 'auto_rakeback',
                    },
                  })
                  .select('id')
                  .maybeSingle();
                const txnId = (txn as { id?: string } | null)?.id ?? null;

                // Mark distribution as transferred
                await supabase
                  .from('rakeback_distributions')
                  .update({
                    status: 'transferred',
                    transferred_at: new Date().toISOString(),
                    chip_transfer_id: txnId,
                  })
                  .eq('id', dist.id);

                // Update the agent→player invoice
                await supabase
                  .from('settlement_invoices')
                  .update({
                    chips_transferred: true,
                    transferred_at: new Date().toISOString(),
                    chip_transfer_id: txnId,
                    status: 'paid',
                  })
                  .eq('club_id', clubId)
                  .eq('period_id', dist.period_id)
                  .eq('invoice_type', 'agent_to_player')
                  .eq('to_entity_id', dist.player_user_id);

                // Best-effort player notification
                try {
                  await supabase.from('notifications').insert({
                    user_id: dist.player_user_id,
                    type: 'rakeback',
                    title: '💰 Rakeback Received!',
                    message: `You received ${dist.rakeback_amount.toLocaleString()} chips rakeback (${(dist.rakeback_percentage * 100).toFixed(1)}% of your ${dist.player_rake_contributed.toLocaleString()} rake). Chips added to your balance!`,
                    data: {
                      club_id: clubId,
                      period_id: dist.period_id,
                      rakeback_amount: dist.rakeback_amount,
                      agent_user_id: agentUserId,
                    },
                    read: false,
                  });
                } catch (notifyErr) {
                  console.warn(
                    '[auto-settlement-distribute] notify error:',
                    notifyErr instanceof Error ? notifyErr.message : notifyErr,
                  );
                }

                agentTotalDeducted += dist.rakeback_amount;
                playersDistributed++;
                results.distributions_processed++;
                results.total_rakeback_distributed += dist.rakeback_amount;
                results.players_paid++;
              } catch (playerErr) {
                const msg = playerErr instanceof Error ? playerErr.message : String(playerErr);
                await markDistributionFailed(dist.id, msg);
                results.distributions_failed++;
                results.errors.push({ phase: 'player_distribution', player: dist.player_user_id, error: msg });
              }
            }

            // Best-effort agent notification
            try {
              await supabase.from('notifications').insert({
                user_id: agentUserId,
                type: 'rakeback_sent',
                title: '📤 Rakeback Distributed to Players',
                message: `Auto-rakeback complete: ${agentTotalDeducted.toLocaleString()} chips distributed to ${playersDistributed} player${playersDistributed !== 1 ? 's' : ''}.`,
                data: {
                  club_id: clubId,
                  total_distributed: agentTotalDeducted,
                  player_count: playersDistributed,
                },
                read: false,
              });
              results.messages_sent++;
            } catch (notifyErr) {
              console.warn(
                '[auto-settlement-distribute] agent-notify error:',
                notifyErr instanceof Error ? notifyErr.message : notifyErr,
              );
            }
          } catch (agentErr) {
            results.errors.push({
              phase: 'agent_distribution',
              agent: agentUserId,
              club_id: clubId,
              error: agentErr instanceof Error ? agentErr.message : String(agentErr),
            });
          }
        }
      }
    }

    // ═══ PHASE 2: UNFREEZE CLUBS — release settlement locks ═══
    results.phase = 'unfreezing';

    const { data: activeLocksData } = await supabase
      .from('settlement_locks')
      .select('id, club_id')
      .eq('is_active', true)
      .limit(100);
    const activeLocks = (activeLocksData ?? []) as Array<{ id: string; club_id: string }>;

    for (const lock of activeLocks) {
      await supabase
        .from('settlement_locks')
        .update({ is_active: false, unlocked_at: new Date().toISOString() })
        .eq('id', lock.id);

      await supabase
        .from('clubs')
        .update({ settlement_locked: false, settlement_locked_until: null })
        .eq('id', lock.club_id);

      results.clubs_unfrozen++;
    }

    // Post "all clear" announcements
    const { data: clubsData } = await supabase
      .from('clubs')
      .select('id, name, owner_id')
      .eq('auto_settlement_enabled', true);
    const lockedClubs = (clubsData ?? []) as Array<{ id: string; name: string | null; owner_id: string | null }>;

    for (const club of lockedClubs) {
      try {
        await supabase.from('club_announcements').insert({
          club_id: club.id,
          title: '✅ Settlement Complete — Operations Resumed',
          content: [
            'Weekly settlement is complete. All operations have been restored.',
            '',
            results.distributions_processed > 0
              ? `💰 ${results.total_rakeback_distributed.toLocaleString()} chips in rakeback distributed to ${results.players_paid} players.`
              : 'No rakeback distributions this period.',
            '',
            'Send, receive, buy-in, and cashout operations are now fully available.',
          ].join('\n'),
          author_id: club.owner_id,
          pinned: false,
        });
      } catch (unfreezeErr) {
        console.warn(
          '[auto-settlement-distribute] unfreeze-msg error:',
          unfreezeErr instanceof Error ? unfreezeErr.message : unfreezeErr,
        );
      }
    }

    results.phase = 'complete';
    results.duration_ms = Date.now() - startTime;

    return c.json({
      success: true,
      message: `Distribution complete. ${results.distributions_processed} rakeback distributions, ${results.clubs_unfrozen} clubs unfrozen.`,
      results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[auto-settlement-distribute] fatal:', msg);

    // EMERGENCY UNFREEZE — if anything crashed after freeze, release locks so ops resume
    try {
      await supabase
        .from('settlement_locks')
        .update({ is_active: false, unlocked_at: new Date().toISOString() })
        .eq('is_active', true);

      await supabase
        .from('clubs')
        .update({ settlement_locked: false, settlement_locked_until: null })
        .eq('settlement_locked', true);
    } catch (unlockErr) {
      results.errors.push({
        phase: 'emergency_unlock',
        error: unlockErr instanceof Error ? unlockErr.message : String(unlockErr),
      });
    }

    results.phase = 'failed';
    results.fatal_error = msg;
    results.duration_ms = Date.now() - startTime;
    return c.json({ error: 'Distribution failed', results }, 500);
  }
}
