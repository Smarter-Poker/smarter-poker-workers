/**
 * GET/POST /cron/union-rakeback
 *
 * Ported from pages/api/cron/union-rakeback.js in World Hub (2026-04-24, 304 lines).
 *
 * Weekly (Mon 10:20 UTC, staggered to 10:25 on Hetzner secondary):
 * distribute each union's rake_wallet balance proportionally to its
 * member clubs' commission rates, then debit the union wallet.
 *
 * Replay safety: every union gets an idempotency slot via
 * fn_claim_settlement_period({union_id, period_start}) BEFORE any writes.
 * If the slot is already claimed (same Monday), the union is skipped.
 * After writes succeed, fn_finalize_settlement_period closes the claim.
 *
 * The Postgres RPCs do the atomic arbitration — this handler is just the
 * orchestration shell. That's why it's safe even if Mac and Hetzner both
 * fire within minutes of each other (plus we stagger as belt-and-suspenders
 * per .memory/context/phase-2a2-full-cron-audit.md).
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

interface Union {
  id: string;
  name: string | null;
  rake_wallet: number | null;
  settings: Record<string, unknown> | null;
}

interface UnionClub {
  club_id: string;
  club_commission_rate: number | null;
}

interface Club {
  id: string;
  name: string | null;
  auto_settlement_enabled: boolean;
  chip_treasury: number | null;
}

interface ClaimResult {
  ok: boolean;
  id?: string;
}

interface Results {
  unions_processed: number;
  unions_skipped: number;
  unions_already_settled: number;
  clubs_credited: number;
  total_redistributed: number;
  period_start: string;
  period_end: string;
  errors: string[];
}

/**
 * Returns the ISO timestamp of the most recent Monday 00:00 UTC at or before `now`.
 * Used as the period_start for the weekly idempotency key.
 */
function lastMondayUtc(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay(); // 0=Sun .. 1=Mon
  const daysBack = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString();
}

export async function unionRakeback(c: Context) {
  const supabase = getSupabase();
  const startedAt = new Date().toISOString();
  const periodStart = lastMondayUtc();
  const periodEnd = startedAt;

  const results: Results = {
    unions_processed: 0,
    unions_skipped: 0,
    unions_already_settled: 0,
    clubs_credited: 0,
    total_redistributed: 0,
    period_start: periodStart,
    period_end: periodEnd,
    errors: [],
  };

  try {
    // MONEY BUG FIX 2026-08-19: this read `unions.rake_wallet`, which is a
    // dead legacy column — every row is 0. The live balance lives in
    // `union_wallets.rake_wallet` (the same table `fn_union_debit_wallet`
    // below already debits). So the filter `.gt('rake_wallet', 0)` matched
    // NOTHING and this job returned "No unions with rake balance" every week:
    // the weekly 90% rakeback has never actually paid a club, while the rake
    // kept accumulating (470k+ found stranded in the union wallet).
    // Read the balance from union_wallets, which is the source of truth.
    const { data: walletRows, error: walletErr } = await supabase
      .from('union_wallets')
      .select('union_id, rake_wallet, unions!inner(id, name, settings)')
      .gt('rake_wallet', 0);

    if (walletErr) {
      // Fail loudly: a silent empty result here is exactly how this bug hid.
      return c.json(
        { success: false, error: `union_wallets read failed: ${walletErr.message}`, results },
        500,
      );
    }

    const unions: Union[] = (walletRows ?? []).map((row: any) => ({
      id: row.union_id,
      name: row.unions?.name ?? null,
      rake_wallet: Number(row.rake_wallet ?? 0),
      settings: row.unions?.settings ?? null,
    }));

    if (unions.length === 0) {
      return c.json({ success: true, message: 'No unions with rake balance', results });
    }

    for (const union of unions) {
      let claimId: string | null = null;
      try {
        const rakeBalance = Number(union.rake_wallet ?? 0);
        if (rakeBalance <= 0) {
          results.unions_skipped++;
          continue;
        }

        // Claim idempotency slot
        const idempotencyKey = `union_rakeback:${union.id}:${periodStart}`;
        const { data: claimData, error: claimErr } = await supabase.rpc('fn_claim_settlement_period', {
          p_idempotency_key: idempotencyKey,
          p_period_kind: 'union_rakeback',
          p_union_id: union.id,
          p_period_start: periodStart,
          p_period_end: periodEnd,
        });
        if (claimErr) {
          results.errors.push(`Union ${union.id} claim error: ${claimErr.message}`);
          results.unions_skipped++;
          continue;
        }
        const claim = claimData as ClaimResult | null;
        if (!claim?.ok) {
          results.unions_already_settled++;
          continue;
        }
        claimId = claim.id ?? null;

        // Load member clubs + commission rates
        const { data: unionClubsData } = await supabase
          .from('union_clubs')
          .select('club_id, club_commission_rate')
          .eq('union_id', union.id)
          .limit(500);
        const unionClubs = (unionClubsData ?? []) as UnionClub[];

        if (unionClubs.length === 0) {
          if (claimId) {
            try {
              await supabase.rpc('fn_finalize_settlement_period', {
                p_id: claimId,
                p_status: 'settled',
                p_clubs_affected: 0,
                p_players_affected: 0,
                p_total_rake: rakeBalance,
                p_total_rakeback: 0,
                p_summary: { note: 'no union_clubs rows' },
                p_error_detail: null,
              });
            } catch { /* best-effort — ignore */ }
          }
          results.unions_skipped++;
          continue;
        }

        const clubIds = unionClubs.map((uc) => uc.club_id);
        const { data: clubsData } = await supabase
          .from('clubs')
          .select('id, name, auto_settlement_enabled, chip_treasury')
          .in('id', clubIds)
          .eq('auto_settlement_enabled', true)
          .limit(500);
        const clubs = (clubsData ?? []) as Club[];

        if (clubs.length === 0) {
          if (claimId) {
            try {
              await supabase.rpc('fn_finalize_settlement_period', {
                p_id: claimId,
                p_status: 'settled',
                p_clubs_affected: 0,
                p_players_affected: 0,
                p_total_rake: rakeBalance,
                p_total_rakeback: 0,
                p_summary: { note: 'no auto_settlement_enabled clubs' },
                p_error_detail: null,
              });
            } catch { /* best-effort — ignore */ }
          }
          results.unions_skipped++;
          continue;
        }

        // Commission rate map
        const rateMap: Record<string, number> = {};
        for (const uc of unionClubs) rateMap[uc.club_id] = Number(uc.club_commission_rate ?? 0);

        const totalWeight = clubs.reduce((s, cl) => s + (rateMap[cl.id] ?? 0), 0);
        if (totalWeight <= 0) {
          results.unions_skipped++;
          continue;
        }

        // Distribute proportionally
        let totalDistributed = 0;
        const distributions = clubs
          .map((club) => {
            const share = (rateMap[club.id] ?? 0) / totalWeight;
            const amount = Math.floor(rakeBalance * share * 100) / 100;
            return { club, amount };
          })
          .filter((d) => d.amount > 0);

        for (const { club, amount } of distributions) {
          try {
            const { error: creditErr } = await supabase.rpc('fn_credit_treasury', {
              p_club_id: club.id,
              p_amount: amount,
            });
            if (creditErr) throw creditErr;

            // Best-effort ledger entries (non-fatal)
            await supabase
              .from('chip_transactions')
              .insert({
                club_id: club.id,
                amount,
                transaction_type: 'union_rakeback',
                notes: `Weekly union rakeback from ${union.name ?? 'union'} — ${(((rateMap[club.id] ?? 0)) * 100).toFixed(1)}% share of ${rakeBalance.toLocaleString()} rake wallet`,
                metadata: {
                  union_id: union.id,
                  commission_rate: rateMap[club.id] ?? 0,
                  started_at: startedAt,
                },
              })
              .then(() => undefined, () => undefined);

            await supabase
              .from('union_wallet_transactions')
              .insert({
                union_id: union.id,
                wallet: 'rake_wallet',
                direction: 'debit',
                amount,
                tx_type: 'rakeback_distribution',
                club_id: club.id,
                notes: `Rakeback to ${club.name ?? 'club'} — ${(((rateMap[club.id] ?? 0)) * 100).toFixed(1)}% share`,
              })
              .then(() => undefined, () => undefined);

            totalDistributed += amount;
            results.clubs_credited++;
          } catch (clubErr) {
            results.errors.push(`Club ${club.id}: ${clubErr instanceof Error ? clubErr.message : String(clubErr)}`);
          }
        }

        // Debit the union's rake_wallet by the total actually distributed
        if (totalDistributed > 0) {
          try {
            await supabase.rpc('fn_union_debit_wallet', {
              p_union_id: union.id,
              p_wallet: 'rake_wallet',
              p_amount: totalDistributed,
            });
          } catch (debitErr) {
            results.errors.push(
              `Union ${union.id} debit error: ${debitErr instanceof Error ? debitErr.message : String(debitErr)}`,
            );
          }
          try {
            await supabase.rpc('fn_finalize_settlement_period', {
              p_id: claimId,
              p_status: 'settled',
              p_clubs_affected: distributions.length,
              p_players_affected: 0,
              p_total_rake: rakeBalance,
              p_total_rakeback: totalDistributed,
              p_summary: {
                union_name: union.name,
                distributions: distributions.map((d) => ({
                  club_id: d.club.id,
                  club_name: d.club.name,
                  amount: d.amount,
                })),
              },
              p_error_detail: null,
            });
          } catch (e) {
            results.errors.push(
                          `Union ${union.id} finalize error: ${e instanceof Error ? e.message : String(e)}`,
                        );
          }
        }

        results.unions_processed++;
        results.total_redistributed += totalDistributed;
      } catch (unionErr) {
        const msg = unionErr instanceof Error ? unionErr.message : String(unionErr);
        results.errors.push(`Union ${union.id}: ${msg}`);
        results.unions_skipped++;
        // Best-effort: mark claim as failed so future replay can proceed
        if (claimId) {
          try {
            await supabase.rpc('fn_finalize_settlement_period', {
              p_id: claimId,
              p_status: 'failed',
              p_clubs_affected: 0,
              p_players_affected: 0,
              p_total_rake: 0,
              p_total_rakeback: 0,
              p_summary: {},
              p_error_detail: msg,
            });
          } catch { /* best-effort — ignore */ }
        }
      }
    }

    return c.json({
      success: true,
      message: `Rakeback complete. ${results.unions_processed} unions processed, ${results.clubs_credited} clubs credited, ${results.total_redistributed.toLocaleString()} chips distributed.`,
      results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[union-rakeback] fatal:', msg);
    return c.json({ success: false, error: msg, results }, 500);
  }
}
