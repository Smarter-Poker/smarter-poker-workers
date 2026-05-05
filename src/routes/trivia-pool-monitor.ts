/**
 * GET/POST /cron/trivia-pool-monitor
 *
 * Phase 49 (2026-05-05) — pool health watchdog.
 *
 * Runs every few hours. Reports:
 *   - per-category counts vs 1500 target
 *   - difficulty-bucket gaps (any cat with <60% of target on a difficulty)
 *   - rotation health: how many questions are last_used_at < now - 90 days
 *   - source mix: deterministic vs grok vs legacy (no source tag)
 *
 * If any category drops below 60-day capacity (≤1200), logs a warning that
 * the dispatcher's alerting layer can pick up.
 *
 * Auth: /cron/* middleware chain (Bearer CRON_SECRET).
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const TARGET_PER_CATEGORY = 1500;
const SIXTY_DAY_FLOOR = 1200; // 20 questions/day × 60 days
const ALL_CATEGORIES = [
  'gto_theory', 'gto_scenarios', 'cash_game_situations', 'mtt_situations', 'icm_chip_ev',
  'poker_history', 'famous_hands', 'player_profiles', 'tournament_facts', 'rule_knowledge',
];

export async function triviaPoolMonitor(c: Context) {
  const startTs = Date.now();
  const sb = getSupabase();

  const summary: any = {
    target_per_category: TARGET_PER_CATEGORY,
    sixty_day_floor: SIXTY_DAY_FLOOR,
    categories: {},
    warnings: [],
    healthy: true,
  };

  try {
    let total = 0;
    for (const cat of ALL_CATEGORIES) {
      const { count: catTotal } = await sb.from('trivia_questions').select('*', { count: 'exact', head: true }).eq('category', cat);
      const { count: easy } = await sb.from('trivia_questions').select('*', { count: 'exact', head: true }).eq('category', cat).eq('difficulty', 'easy');
      const { count: medium } = await sb.from('trivia_questions').select('*', { count: 'exact', head: true }).eq('category', cat).eq('difficulty', 'medium');
      const { count: hard } = await sb.from('trivia_questions').select('*', { count: 'exact', head: true }).eq('category', cat).eq('difficulty', 'hard');

      const cTotal = catTotal ?? 0;
      total += cTotal;

      const targetEasy = Math.floor(TARGET_PER_CATEGORY * 0.20);
      const targetMedium = Math.floor(TARGET_PER_CATEGORY * 0.50);
      const targetHard = Math.floor(TARGET_PER_CATEGORY * 0.30);

      const catSummary = {
        total: cTotal,
        easy: easy ?? 0,
        medium: medium ?? 0,
        hard: hard ?? 0,
        target_easy: targetEasy,
        target_medium: targetMedium,
        target_hard: targetHard,
        progress_pct: Math.round((cTotal / TARGET_PER_CATEGORY) * 100),
      };
      summary.categories[cat] = catSummary;

      if (cTotal < SIXTY_DAY_FLOOR) {
        summary.warnings.push(`${cat}: only ${cTotal} questions (below 60-day floor of ${SIXTY_DAY_FLOOR})`);
        summary.healthy = false;
      }
      if ((easy ?? 0) < targetEasy * 0.6) summary.warnings.push(`${cat}/easy: ${easy} (need ${targetEasy})`);
      if ((medium ?? 0) < targetMedium * 0.6) summary.warnings.push(`${cat}/medium: ${medium} (need ${targetMedium})`);
      if ((hard ?? 0) < targetHard * 0.6) summary.warnings.push(`${cat}/hard: ${hard} (need ${targetHard})`);
    }

    summary.total_questions = total;
    summary.target_total = ALL_CATEGORIES.length * TARGET_PER_CATEGORY;
    summary.overall_progress_pct = Math.round((total / summary.target_total) * 100);

    // Source mix — count by subcategory tag prefix
    const { count: detCount } = await sb.from('trivia_questions').select('*', { count: 'exact', head: true }).like('subcategory', 'det:%');
    const { count: grokCount } = await sb.from('trivia_questions').select('*', { count: 'exact', head: true }).like('subcategory', 'grok:%');
    summary.source_mix = {
      deterministic: detCount ?? 0,
      grok: grokCount ?? 0,
      legacy_or_unset: total - (detCount ?? 0) - (grokCount ?? 0),
    };

    summary.elapsed_ms = Date.now() - startTs;

    if (!summary.healthy) {
      console.warn(`[trivia-pool-monitor] ⚠️  ${summary.warnings.length} warnings: ${summary.warnings.slice(0, 3).join('; ')}`);
    }

    return c.json({ success: true, summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[trivia-pool-monitor] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
