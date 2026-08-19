/**
 * POST /cron/auto-settlement
 *
 * Ported from pages/api/cron/auto-settlement.js in World Hub
 * (2026-04-24, 767 lines — the heaviest of the 3 Monday settlement jobs).
 *
 * Monday 10:00 UTC (staggered to 10:05 on Hetzner secondary).
 * Phase 1 of the weekly settlement flow — MUST run before
 * auto-settlement-distribute (10:10) and union-rakeback (10:20).
 *
 * SIX PHASES (preserved exactly from monolith):
 *   1. FREEZE   — lock send/receive/cashout per club for 10 minutes
 *   2. SETTLE   — close each club's open settlement_period
 *   3. INVOICE  — generate 4 invoice types:
 *                 union→club (rake hold), club→agent (commission),
 *                 agent→subagent (cascade), agent→player (rakeback)
 *   4. DISTRIBUTE — transfer commission chips to agents (not players —
 *                    that happens in auto-settlement-distribute)
 *   5. MESSAGE  — club_announcements + per-agent notifications
 *   6. OPEN     — create the next settlement_period
 *
 * CRITICAL BUG FIXES preserved:
 *   - BUG #150: debit club treasury BEFORE credit_chips, else chips are
 *     minted from nothing every cycle and club treasury drifts high.
 *   - BUG #238: if fn_credit_chips fails after fn_debit_treasury, roll
 *     back the treasury debit so club_treasury doesn't drift low.
 *
 * Emergency unfreeze in outer catch so clubs never get stuck locked.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

type SupabaseClient = ReturnType<typeof getSupabase>;

interface Club {
  id: string;
  name: string | null;
  owner_id: string | null;
  union_id: string | null;
  chip_treasury: number | null;
  auto_settlement_enabled: boolean;
  settings: Record<string, unknown> | null;
}

interface Agent {
  id: string;
  user_id: string;
  commission_rate: number;
  weekly_rake_generated: number | null;
  is_prepaid: boolean;
  parent_agent_id: string | null;
  auto_rakeback_enabled: boolean;
  rakeback_percentage: number | null;
  active_player_count: number | null;
}

interface SettlementPeriod {
  id: string;
  period_number: number;
  total_rake_collected: number | null;
  total_hands_dealt: number | null;
  start_at: string;
}

interface Results {
  phase: string;
  clubs_processed: number;
  clubs_locked: number;
  periods_closed: number;
  invoices_generated: number;
  commissions_distributed: number;
  messages_sent: number;
  periods_opened: number;
  /** Per-union weekly player win/loss settlement (added 2026-08-19). */
  union_pnl: Array<Record<string, unknown>>;
  /** Broken union governance invariants, if any (added 2026-08-19). */
  governance: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
  duration_ms?: number;
  fatal_error?: string;
}


async function sendSettlementMessages(
  supabase: SupabaseClient,
  club: Club,
  period: SettlementPeriod,
  agents: Agent[],
  totalRake: number,
  unionHold: number,
  totalCommissions: number,
): Promise<void> {
  const periodNum = period.period_number;
  const clubRetained = totalRake - unionHold - totalCommissions;

  // 1. Club-wide announcement
  try {
    await supabase.from('club_announcements').insert({
      club_id: club.id,
      title: `📊 Weekly Settlement Complete — Period #${periodNum}`,
      content: [
        `Settlement Period #${periodNum} has been automatically processed.`,
        '',
        `💰 Total Rake Collected: ${totalRake.toLocaleString()} chips`,
        unionHold > 0 ? `🏢 Union Hold: ${unionHold.toLocaleString()} chips` : null,
        `👥 Agent Commissions: ${totalCommissions.toLocaleString()} chips (${agents.filter((a) => (a.weekly_rake_generated ?? 0) > 0).length} agents)`,
        `🏠 Club Retained: ${clubRetained.toLocaleString()} chips`,
        '',
        'A new settlement period has been opened automatically.',
        'Rakeback distributions to players will complete by 4:10 AM CST.',
      ]
        .filter(Boolean)
        .join('\n'),
      author_id: club.owner_id,
      pinned: false,
    });
  } catch (err) {
    console.warn(
      '[auto-settlement] announcement error:',
      err instanceof Error ? err.message : err,
    );
  }

  // 2. Per-agent notifications
  for (const agent of agents) {
    const grossRake = agent.weekly_rake_generated ?? 0;
    if (grossRake <= 0) continue;

    const commission = Math.round(grossRake * agent.commission_rate * 100) / 100;

    try {
      await supabase.from('notifications').insert({
        user_id: agent.user_id,
        type: 'settlement',
        title: `💰 Commission Received — Period #${periodNum}`,
        message: `You earned ${commission.toLocaleString()} chips commission (${(agent.commission_rate * 100).toFixed(1)}% of ${grossRake.toLocaleString()} rake generated). Chips have been added to your balance.`,
        data: {
          club_id: club.id,
          period_id: period.id,
          period_number: periodNum,
          commission,
          gross_rake: grossRake,
        },
        read: false,
      });
    } catch (err) {
      console.warn(
        `[auto-settlement] agent ${agent.user_id} notif error:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 3. Owner notification
  try {
    await supabase.from('notifications').insert({
      user_id: club.owner_id,
      type: 'settlement',
      title: `📊 Settlement Complete — ${club.name} Period #${periodNum}`,
      message: `Period #${periodNum} auto-settled. Rake: ${totalRake.toLocaleString()}, Commissions: ${totalCommissions.toLocaleString()}, Club retained: ${clubRetained.toLocaleString()} chips.`,
      data: {
        club_id: club.id,
        period_id: period.id,
        total_rake: totalRake,
        union_hold: unionHold,
        total_commissions: totalCommissions,
        club_retained: clubRetained,
      },
      read: false,
    });
  } catch (err) {
    console.warn(
      '[auto-settlement] owner notif error:',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Tell the union's owner and admins when a weekly player-P&L run did not
 * settle. Without this the only record is `results.errors` in the cron's HTTP
 * response — which goes to the Open Claw dispatcher and is read by nobody. A
 * settlement that silently declines to pay is indistinguishable from one that
 * paid, which defeats the point of having a guard at all.
 */
async function notifyUnionSettlementProblem(
  supabase: SupabaseClient,
  unionId: string,
  unionName: string | null,
  title: string,
  message: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const recipients = new Set<string>();

    const { data: unionRow } = await supabase
      .from('unions')
      .select('owner_id')
      .eq('id', unionId)
      .maybeSingle();
    if ((unionRow as any)?.owner_id) recipients.add((unionRow as any).owner_id);

    const { data: admins } = await supabase
      .from('union_admins')
      .select('user_id')
      .eq('union_id', unionId);
    for (const a of admins ?? []) {
      if ((a as any)?.user_id) recipients.add((a as any).user_id);
    }

    if (recipients.size === 0) return;

    await supabase.from('notifications').insert(
      [...recipients].map((uid) => ({
        user_id: uid,
        type: 'settlement',
        title,
        message,
        data: { union_id: unionId, union_name: unionName, ...data },
        read: false,
      })),
    );
  } catch (err) {
    console.warn(
      '[auto-settlement] union settlement alert failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

export async function autoSettlement(c: Context) {
  const supabase = getSupabase();
  const startTime = Date.now();
  const results: Results = {
    phase: 'started',
    clubs_processed: 0,
    clubs_locked: 0,
    periods_closed: 0,
    invoices_generated: 0,
    commissions_distributed: 0,
    messages_sent: 0,
    periods_opened: 0,
    union_pnl: [],
    governance: [],
    errors: [],
  };


  try {
    // ═══ PHASE 1: FREEZE ALL CLUBS ═══
    results.phase = 'freezing';

    const { data: clubsData } = await supabase
      .from('clubs')
      .select('id, name, owner_id, union_id, chip_treasury, auto_settlement_enabled, settings')
      .eq('auto_settlement_enabled', true)
      .limit(100);
    const clubs = (clubsData ?? []) as Club[];

    if (clubs.length === 0) {
      return c.json({
        success: true,
        message: 'No clubs with auto-settlement enabled',
        results,
      });
    }

    const now = new Date();
    const unlockAt = new Date(now.getTime() + 10 * 60 * 1000);

    // Expire stale locks
    try {
      await supabase.rpc('expire_settlement_locks');
    } catch {
      await supabase
        .from('settlement_locks')
        .update({ is_active: false, unlocked_at: now.toISOString() })
        .eq('is_active', true)
        .lt('unlock_at', now.toISOString());
    }

    // Create fresh locks
    for (const club of clubs) {
      try {
        const { data: existingLock } = await supabase
          .from('settlement_locks')
          .select('id')
          .eq('club_id', club.id)
          .eq('is_active', true)
          .maybeSingle();

        if (!existingLock) {
          await supabase.from('settlement_locks').insert({
            club_id: club.id,
            lock_type: 'weekly_settlement',
            locked_at: now.toISOString(),
            unlock_at: unlockAt.toISOString(),
            is_active: true,
            lock_reason: 'Weekly auto-settlement in progress. Operations resume at 4:10 AM CST.',
          });
        }

        await supabase
          .from('clubs')
          .update({
            settlement_locked: true,
            settlement_locked_until: unlockAt.toISOString(),
          })
          .eq('id', club.id);

        results.clubs_locked++;
      } catch (lockErr) {
        results.errors.push({
          club: club.name,
          phase: 'freeze',
          error: lockErr instanceof Error ? lockErr.message : String(lockErr),
        });
      }
    }

    // ═══ PHASE 2-6: per-club settlement ═══
    results.phase = 'settling';

    for (const club of clubs) {
      try {
        const { data: openPeriodData } = await supabase
          .from('settlement_periods')
          .select('*')
          .eq('club_id', club.id)
          .eq('status', 'open')
          .maybeSingle();
        const openPeriod = openPeriodData as SettlementPeriod | null;

        if (!openPeriod) continue;

        // Load active agents for this club
        const { data: agentsData } = await supabase
          .from('agents')
          .select('id, user_id, commission_rate, weekly_rake_generated, is_prepaid, parent_agent_id, auto_rakeback_enabled, rakeback_percentage, active_player_count')
          .eq('club_id', club.id)
          .eq('status', 'active')
          .limit(100);
        const agents = (agentsData ?? []) as Agent[];

        // Union rake-hold settings
        let unionRakeHold = 0.10;
        const unionId = club.union_id;
        if (unionId) {
          const { data: union } = await supabase
            .from('unions')
            .select('id, settings, name')
            .eq('id', unionId)
            .maybeSingle();
          const settings = (union as { settings?: { union_rake_hold?: number } } | null)?.settings;
          unionRakeHold = settings?.union_rake_hold ?? 0.10;
        }

        const actualTotalRake = agents.reduce((s, a) => s + (a.weekly_rake_generated ?? 0), 0);
        const totalRake = actualTotalRake || openPeriod.total_rake_collected || 0;
        const totalHands = openPeriod.total_hands_dealt ?? 0;
        const unionHoldAmount = Math.round(totalRake * unionRakeHold * 100) / 100;

        await supabase
          .from('settlement_periods')
          .update({ total_rake_collected: totalRake })
          .eq('id', openPeriod.id);

        // ─── INVOICE 1: Union → Club (rake hold) ───
        if (unionId && unionHoldAmount > 0) {
          await supabase.from('settlement_invoices').insert({
            club_id: club.id,
            period_id: openPeriod.id,
            invoice_type: 'union_to_club',
            from_entity_type: 'union',
            from_entity_id: String(unionId),
            to_entity_type: 'club',
            to_entity_id: String(club.id),
            gross_amount: totalRake,
            net_amount: unionHoldAmount,
            deductions: 0,
            breakdown: {
              total_rake: totalRake,
              total_hands: totalHands,
              rake_hold_pct: unionRakeHold,
              union_hold_amount: unionHoldAmount,
              club_retained: totalRake - unionHoldAmount,
              period_number: openPeriod.period_number,
            },
            status: 'paid',
            chips_transferred: true,
            transferred_at: now.toISOString(),
          });
          results.invoices_generated++;

          // Debit club treasury for the union hold
          const { error: holdDebitErr } = await supabase.rpc('fn_debit_treasury', {
            p_club_id: club.id,
            p_amount: unionHoldAmount,
          });

          if (holdDebitErr) {
            console.warn(`[auto-settlement] Union hold debit failed for ${club.name}:`, holdDebitErr.message);
            results.errors.push({
              club: club.name,
              phase: 'union_hold_debit',
              error: holdDebitErr.message,
            });
          } else {
            // CONSERVATION FIX 2026-08-19: the treasury was debited but the
            // union wallet was NEVER credited, so every weekly union hold
            // destroyed chips instead of moving them. (The World Hub path
            // already did this correctly via fn_union_credit_wallet, with a
            // treasury refund on failure — mirrored here.)
            const { error: holdCreditErr } = await supabase.rpc('fn_union_credit_wallet', {
              p_union_id: unionId,
              p_wallet: 'rake_wallet',
              p_amount: unionHoldAmount,
              p_tx_type: 'settlement_hold',
              p_club_id: club.id,
              p_period_id: openPeriod.id,
            });
            if (holdCreditErr) {
              console.warn(
                `[auto-settlement] Union hold credit failed for ${club.name}, refunding treasury:`,
                holdCreditErr.message,
              );
              const { error: refundErr } = await supabase.rpc('fn_credit_treasury', {
                p_club_id: club.id,
                p_amount: unionHoldAmount,
              });
              results.errors.push({
                club: club.name,
                phase: 'union_hold_credit',
                error: holdCreditErr.message,
                refunded: !refundErr,
                ...(refundErr ? { refund_error: refundErr.message } : {}),
              });
            }

            await supabase.from('chip_transactions').insert({
              club_id: club.id,
              from_user_id: null,
              to_user_id: null,
              amount: unionHoldAmount,
              transaction_type: 'union_hold',
              notes: `Union rake hold: ${unionHoldAmount.toLocaleString()} chips (${(unionRakeHold * 100).toFixed(1)}% of ${totalRake.toLocaleString()} rake) — Period #${openPeriod.period_number}`,
              metadata: {
                period_id: openPeriod.id,
                period_number: openPeriod.period_number,
                union_id: unionId,
                hold_rate: unionRakeHold,
                settlement_type: 'auto',
              },
            });
          }
        }

        // ─── Per-agent: commission + rakeback setup ───
        type CommissionRecord = {
          period_id: string;
          agent_id: string;
          gross_rake: number;
          commission_rate: number;
          commission_amount: number;
          status: string;
          paid_at?: string;
        };
        type CommissionHistory = {
          club_id: string;
          agent_id: string;
          period_id: string;
          period_start: string;
          period_end: string;
          player_rake_generated: number;
          commission_rate: number;
          commission_earned: number;
          sub_agent_commission: number;
          net_commission: number;
          status: string;
          paid_at?: string;
        };
        const commissionRecords: CommissionRecord[] = [];
        const commissionHistory: CommissionHistory[] = [];
        let totalCommissions = 0;

        for (const agent of agents) {
          const grossRake = agent.weekly_rake_generated ?? 0;
          if (grossRake <= 0) continue;

          const commission = Math.round(grossRake * agent.commission_rate * 100) / 100;

          // Sub-agent deduction if there's a parent
          let subAgentDeduction = 0;
          if (agent.parent_agent_id) {
            const { data: parentData } = await supabase
              .from('agents')
              .select('commission_rate, user_id')
              .eq('id', agent.parent_agent_id)
              .maybeSingle();
            const parentAgent = parentData as { commission_rate: number; user_id: string } | null;

            if (parentAgent) {
              subAgentDeduction =
                Math.round(grossRake * Math.max(0, parentAgent.commission_rate - agent.commission_rate) * 100) / 100;

              if (subAgentDeduction > 0) {
                await supabase.from('settlement_invoices').insert({
                  club_id: club.id,
                  period_id: openPeriod.id,
                  invoice_type: 'agent_to_subagent',
                  from_entity_type: 'agent',
                  from_entity_id: parentAgent.user_id,
                  to_entity_type: 'agent',
                  to_entity_id: agent.user_id,
                  gross_amount: grossRake,
                  net_amount: commission,
                  deductions: subAgentDeduction,
                  breakdown: {
                    parent_rate: parentAgent.commission_rate,
                    sub_rate: agent.commission_rate,
                    rate_diff: parentAgent.commission_rate - agent.commission_rate,
                    gross_rake: grossRake,
                    sub_commission: commission,
                    parent_deduction: subAgentDeduction,
                  },
                  status: 'generated',
                });
                results.invoices_generated++;
              }
            }
          }

          const netCommission = commission - subAgentDeduction;

          // ─── INVOICE 2: Club → Agent ───
          await supabase.from('settlement_invoices').insert({
            club_id: club.id,
            period_id: openPeriod.id,
            invoice_type: 'club_to_agent',
            from_entity_type: 'club',
            from_entity_id: String(club.id),
            to_entity_type: 'agent',
            to_entity_id: agent.user_id,
            gross_amount: grossRake,
            net_amount: netCommission,
            deductions: subAgentDeduction,
            breakdown: {
              gross_rake: grossRake,
              commission_rate: agent.commission_rate,
              gross_commission: commission,
              sub_agent_deduction: subAgentDeduction,
              net_commission: netCommission,
              period_number: openPeriod.period_number,
              is_prepaid: agent.is_prepaid,
            },
            status: 'generated',
          });
          results.invoices_generated++;

          commissionRecords.push({
            period_id: openPeriod.id,
            agent_id: agent.id,
            gross_rake: grossRake,
            commission_rate: agent.commission_rate,
            commission_amount: netCommission,
            status: 'pending',
          });
          commissionHistory.push({
            club_id: club.id,
            agent_id: agent.id,
            period_id: openPeriod.id,
            period_start: openPeriod.start_at,
            period_end: now.toISOString(),
            player_rake_generated: grossRake,
            commission_rate: agent.commission_rate,
            commission_earned: commission,
            sub_agent_commission: subAgentDeduction,
            net_commission: netCommission,
            status: 'pending',
          });

          totalCommissions += netCommission;

          // ─── DISTRIBUTE: club treasury → agent balance ───
          if (netCommission > 0) {
            const { data: agentMember } = await supabase
              .from('club_members')
              .select('chip_balance')
              .eq('club_id', club.id)
              .eq('user_id', agent.user_id)
              .maybeSingle();

            if (agentMember) {
              // BUG #150: debit treasury BEFORE credit chips
              const { error: debitErr } = await supabase.rpc('fn_debit_treasury', {
                p_club_id: club.id,
                p_amount: netCommission,
              });

              if (debitErr) {
                console.warn(`[auto-settlement] treasury debit failed for agent ${agent.user_id}:`, debitErr.message);
                results.errors.push({
                  club: club.name,
                  agent: agent.user_id,
                  phase: 'commission_debit',
                  error: debitErr.message,
                });
              } else {
                const { error: creditErr } = await supabase.rpc('fn_credit_chips', {
                  p_club_id: club.id,
                  p_user_id: agent.user_id,
                  p_amount: netCommission,
                });

                if (creditErr) {
                  // BUG #238: roll back treasury debit if credit fails
                  console.warn(`[auto-settlement] credit failed for agent ${agent.user_id}, rolling back:`, creditErr.message);
                  try {
                    await supabase.rpc('fn_credit_treasury', {
                      p_club_id: club.id,
                      p_amount: netCommission,
                    });
                  } catch (rbErr) {
                    console.warn('[auto-settlement] treasury rollback failed:', rbErr instanceof Error ? rbErr.message : rbErr);
                  }
                  results.errors.push({
                    club: club.name,
                    agent: agent.user_id,
                    phase: 'commission_credit',
                    error: creditErr.message,
                  });
                } else {
                  // Update agents table
                  await supabase
                    .from('agents')
                    .update({ business_balance: 0 })
                    .eq('id', agent.id);

                  // Record chip transaction
                  const { data: txnData } = await supabase
                    .from('chip_transactions')
                    .insert({
                      club_id: club.id,
                      from_user_id: SYSTEM_USER_ID,
                      to_user_id: agent.user_id,
                      amount: netCommission,
                      transaction_type: 'commission',
                      notes: `Auto-settlement Period #${openPeriod.period_number}: Commission ${netCommission.toLocaleString()} chips (${(agent.commission_rate * 100).toFixed(1)}% of ${grossRake.toLocaleString()} rake)`,
                      metadata: {
                        period_id: openPeriod.id,
                        period_number: openPeriod.period_number,
                        settlement_type: 'auto',
                      },
                    })
                    .select('id')
                    .maybeSingle();
                  const txn = txnData as { id?: string } | null;

                  if (txn) {
                    await supabase
                      .from('settlement_invoices')
                      .update({
                        chips_transferred: true,
                        transferred_at: now.toISOString(),
                        chip_transfer_id: txn.id,
                        status: 'paid',
                      })
                      .eq('club_id', club.id)
                      .eq('period_id', openPeriod.id)
                      .eq('invoice_type', 'club_to_agent')
                      .eq('to_entity_id', agent.user_id);
                  }

                  results.commissions_distributed++;

                  const crRef = commissionRecords.find((r) => r.agent_id === agent.id);
                  if (crRef) {
                    crRef.status = 'paid';
                    crRef.paid_at = now.toISOString();
                  }
                  const chRef = commissionHistory.find((r) => r.agent_id === agent.id && r.club_id === club.id);
                  if (chRef) {
                    chRef.status = 'paid';
                    chRef.paid_at = now.toISOString();
                  }
                }
              }
            }
          }

          // ─── Queue player rakeback distributions (executed at 10:10) ───
          const { data: agentPlayersData } = await supabase
            .from('club_members')
            .select('user_id, player_rakeback_pct')
            .eq('club_id', club.id)
            .eq('agent_id', agent.user_id)
            .eq('role', 'player')
            .gt('player_rakeback_pct', 0)
            .limit(200);
          const agentPlayers = (agentPlayersData ?? []) as Array<{ user_id: string; player_rakeback_pct: number | null }>;

          for (const player of agentPlayers) {
            const playerRakebackPct = player.player_rakeback_pct ?? 0;
            if (playerRakebackPct <= 0) continue;

            const { data: rakeContrib } = await supabase
              .from('rake_records')
              .select('player_contributions')
              .eq('club_id', club.id)
              .gte('created_at', openPeriod.start_at)
              .lte('created_at', now.toISOString())
              .limit(100);

            let playerRakeContributed = 0;
            for (const record of (rakeContrib ?? []) as Array<{ player_contributions: Record<string, number | string> | null }>) {
              const contributions = record.player_contributions ?? {};
              const raw = contributions[player.user_id];
              playerRakeContributed += parseFloat(String(raw ?? 0));
            }
            if (playerRakeContributed <= 0) continue;

            const rakebackAmount = Math.round(playerRakeContributed * playerRakebackPct * 100) / 100;
            if (rakebackAmount <= 0) continue;

            await supabase.from('rakeback_distributions').insert({
              club_id: club.id,
              period_id: openPeriod.id,
              agent_id: agent.id,
              agent_user_id: agent.user_id,
              player_user_id: player.user_id,
              player_rake_contributed: playerRakeContributed,
              rakeback_percentage: playerRakebackPct,
              rakeback_amount: rakebackAmount,
              status: 'pending',
            });

            await supabase.from('settlement_invoices').insert({
              club_id: club.id,
              period_id: openPeriod.id,
              invoice_type: 'agent_to_player',
              from_entity_type: 'agent',
              from_entity_id: agent.user_id,
              to_entity_type: 'player',
              to_entity_id: player.user_id,
              gross_amount: playerRakeContributed,
              net_amount: rakebackAmount,
              deductions: 0,
              breakdown: {
                player_rake_contributed: playerRakeContributed,
                rakeback_pct: playerRakebackPct,
                rakeback_amount: rakebackAmount,
                agent_name: agent.user_id,
              },
              status: 'generated',
            });
            results.invoices_generated++;
          }
        }

        // Batch-insert commission records for historical compat
        if (commissionRecords.length > 0) {
          await supabase.from('commission_records').insert(commissionRecords);
          await supabase.from('commission_history').insert(commissionHistory);
        }

        // Close the period
        await supabase
          .from('settlement_periods')
          .update({ status: 'closed', settled_at: now.toISOString(), settled_by: SYSTEM_USER_ID })
          .eq('id', openPeriod.id);

        await supabase
          .from('settlement_locks')
          .update({ settlement_period_id: openPeriod.id })
          .eq('club_id', club.id)
          .eq('is_active', true);

        results.periods_closed++;

        // Send settlement messages
        await sendSettlementMessages(
          supabase,
          club,
          openPeriod,
          agents,
          totalRake,
          unionHoldAmount,
          totalCommissions,
        );
        results.messages_sent++;

        // Open new period
        const { data: lastPeriodData } = await supabase
          .from('settlement_periods')
          .select('period_number')
          .eq('club_id', club.id)
          .order('period_number', { ascending: false })
          .limit(1);
        const lastPeriodArr = (lastPeriodData ?? []) as Array<{ period_number: number }>;
        const firstLast = lastPeriodArr[0];
        const nextPeriodNum = (firstLast?.period_number ?? 0) + 1;
        const nextEndAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        await supabase.from('settlement_periods').insert({
          club_id: club.id,
          union_id: club.union_id,
          period_number: nextPeriodNum,
          year: now.getFullYear(),
          start_at: now.toISOString(),
          end_at: nextEndAt.toISOString(),
          status: 'open',
          total_rake_collected: 0,
          total_hands_dealt: 0,
          total_player_winnings: 0,
          total_player_losses: 0,
        });

        // Reset agents' weekly_rake_generated
        for (const agent of agents) {
          await supabase.from('agents').update({ weekly_rake_generated: 0 }).eq('id', agent.id);
        }

        results.periods_opened++;
        results.clubs_processed++;
      } catch (clubErr) {
        results.errors.push({
          club: club.name,
          club_id: club.id,
          phase: 'settlement',
          error: clubErr instanceof Error ? clubErr.message : String(clubErr),
        });
      }
    }

    // ═══ PHASE 7: UNION PLAYER P&L (added 2026-08-19) ═══
    // Dan's rule: inside a union, players are merged and play each other, so
    // wins/losses are tracked per player and the club and union square up
    // weekly for whatever balances are owed. This runs ONCE PER UNION (not
    // per club) because the settlement is a zero-sum transfer between the
    // member clubs — losers must be collected from before winners are paid,
    // which is only possible union-wide.
    //
    // fn_union_settle_player_pnl_guarded does the whole thing in one
    // transaction and REFUSES to move chips unless the club nets prove
    // zero-sum within tolerance (recording the run as 'needs_review'
    // instead). It is idempotent on (union_id, period_start).
    results.phase = 'union_player_pnl';
    try {
      const { data: unionRows, error: unionListErr } = await supabase
        .from('unions')
        .select('id, name');
      if (unionListErr) throw unionListErr;

      for (const u of unionRows ?? []) {
        try {
          // Self-chaining window: settles from the END of the last settled
          // period to now. Two reasons over a fixed Monday-to-Monday window:
          //   - no gap. A fixed window loses every flow that lands between one
          //     period's end and the next period's start.
          //   - the closing seated stack is measured at the same instant it is
          //     recorded as the next period's opening baseline. A job running
          //     Monday 10:00 for a window ending Monday 00:00 mis-stated every
          //     club's stack by 10 hours of play.
          // Skips automatically if too little time has passed (double-run).
          const { data: pnlRes, error: pnlErr } = await supabase.rpc(
            'fn_union_settle_player_pnl_weekly',
            { p_union_id: (u as any).id },
          );
          if (pnlErr) throw pnlErr;

          const res = pnlRes as any;
          if (res?.skipped) {
            results.union_pnl.push({
              union: (u as any).name,
              status: 'skipped',
              reason: res.reason,
              hours: res.hours,
            });
          } else if (res?.already_settled) {
            results.union_pnl.push({ union: (u as any).name, status: 'already_settled' });
          } else if (res?.needs_review) {
            // Books did not balance — no chips moved, on purpose.
            results.union_pnl.push({
              union: (u as any).name,
              status: 'needs_review',
              imbalance: res.imbalance,
              tolerance: res.tolerance,
            });
            results.errors.push({
              club: (u as any).name,
              phase: 'union_player_pnl',
              error: `P&L parked for review (${res.reason ?? 'unknown'}) — no chips moved`,
            });
            await notifyUnionSettlementProblem(
              supabase,
              (u as any).id,
              (u as any).name,
              'Weekly player P&L needs review',
              `This week's club/union player win-loss settlement was NOT paid. `
                + `Reason: ${res.reason ?? 'unknown'}. `
                + `${res.message ?? ''} No chips were moved. `
                + `Review it on the union dashboard, then it can be re-run for this period.`,
              { reason: res.reason, settlement_id: res.settlement_id, needs_review: true },
            );
          } else {
            results.union_pnl.push({
              union: (u as any).name,
              status: 'settled',
              collected: res?.total_collected,
              paid: res?.total_paid,
              unpaid: res?.total_unpaid,
            });
          }
        } catch (unionErr) {
          const msg = unionErr instanceof Error ? unionErr.message : String(unionErr);
          results.errors.push({
            club: (u as any).name,
            phase: 'union_player_pnl',
            error: msg,
          });
          await notifyUnionSettlementProblem(
            supabase,
            (u as any).id,
            (u as any).name,
            'Weekly player P&L failed',
            `This week's club/union player win-loss settlement did not run: ${msg}. `
              + `No chips were moved.`,
            { error: msg, failed: true },
          );
        }
      }
    } catch (pnlPhaseErr) {
      results.errors.push({
        phase: 'union_player_pnl',
        error: pnlPhaseErr instanceof Error ? pnlPhaseErr.message : String(pnlPhaseErr),
      });
    }

    // ═══ PHASE 8: UNION GOVERNANCE INVARIANTS (added 2026-08-19) ═══
    // Every rule this project enforces fails SILENTLY — as data drift, not as
    // a build error — so no code-level CI gate can see it. These invariants
    // were being checked by hand with ad-hoc SQL, which does not survive a
    // busy repo. fn_union_governance_check() states them once and returns one
    // row per BROKEN invariant; an empty result is a healthy system.
    results.phase = 'union_governance_check';
    try {
      const { data: violations, error: checkErr } = await supabase.rpc(
        'fn_union_governance_check',
      );
      if (checkErr) throw checkErr;

      const rows = (violations ?? []) as Array<{
        invariant: string;
        severity: string;
        offenders: number;
        detail: string;
      }>;
      // Settlement flows are double-entry by construction, so unlike the
      // platform-wide supply (which chip_supply_snapshots already tracks
      // hourly and cannot fully explain), they can be asserted exactly. This
      // is the check that would have caught the union hold destroying chips.
      const { data: conservation, error: consErr } = await supabase.rpc(
        'fn_settlement_conservation_check',
      );
      if (consErr) {
        results.errors.push({
          phase: 'union_governance_check',
          error: `conservation check failed to run: ${consErr.message}`,
        });
      } else {
        for (const c of (conservation ?? []) as Array<{
          issue: string;
          severity: string;
          detail: string;
        }>) {
          rows.push({
            invariant: c.issue,
            severity: c.severity,
            offenders: 1,
            detail: c.detail,
          });
        }
      }

      results.governance = rows;

      const critical = rows.filter((v) => v.severity === 'critical');
      if (rows.length > 0) {
        for (const v of rows) {
          results.errors.push({
            phase: 'union_governance_check',
            error: `${v.severity.toUpperCase()} ${v.invariant}: ${v.detail} (${v.offenders})`,
          });
        }
      }

      // Only page a human for critical breaks — a warning is a nudge, a
      // critical is the hard rule itself being violated in live data.
      if (critical.length > 0) {
        const { data: unionRows } = await supabase.from('unions').select('id, name');
        for (const u of unionRows ?? []) {
          await notifyUnionSettlementProblem(
            supabase,
            (u as any).id,
            (u as any).name,
            'Union rule violation detected',
            critical
              .map((v) => `${v.invariant}: ${v.detail} (${v.offenders} affected)`)
              .join(' | '),
            { violations: critical, governance_check: true },
          );
        }
      }
    } catch (govErr) {
      results.errors.push({
        phase: 'union_governance_check',
        error: govErr instanceof Error ? govErr.message : String(govErr),
      });
    }

    results.phase = 'complete';
    results.duration_ms = Date.now() - startTime;

    return c.json({
      success: true,
      message: `Auto-settlement complete. ${results.clubs_processed} clubs processed, ${results.invoices_generated} invoices generated.`,
      results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[auto-settlement] fatal:', msg);
    results.phase = 'failed';
    results.fatal_error = msg;
    results.duration_ms = Date.now() - startTime;

    // Emergency unlock
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

    return c.json({ error: 'Auto-settlement failed', results }, 500);
  }
}
