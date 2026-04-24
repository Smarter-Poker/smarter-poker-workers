/**
 * GET/POST /cron/trivia-daily-generator
 *
 * Ported from pages/api/cron/trivia-daily-generator.js (206 lines).
 *
 * Daily 11:59 PM CST: select 20 questions per category (10 categories →
 * 200 total questions) from the existing trivia_questions pool for
 * tomorrow. Tags each selected question with tomorrow's CST date in
 * daily_date column. 60-day uniqueness — no question repeats within 60 days.
 *
 * If not enough "fresh" questions in a category, recycles from oldest-used.
 *
 * Idempotent: if 200 questions are already tagged for tomorrow,
 * short-circuits with alreadyDone: true.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const QUESTIONS_PER_CATEGORY = 20;

const CATEGORIES = [
  'poker_history',
  'famous_hands',
  'player_profiles',
  'rule_knowledge',
  'tournament_facts',
  'gto_theory',
  'mtt_situations',
  'cash_game_situations',
  'icm_chip_ev',
  'gto_scenarios',
];

function getTomorrowCST(): string {
  const now = new Date();
  const cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  cst.setDate(cst.getDate() + 1);
  const year = cst.getFullYear();
  const month = String(cst.getMonth() + 1).padStart(2, '0');
  const day = String(cst.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getSixtyDaysAgoCST(): string {
  const now = new Date();
  const cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  cst.setDate(cst.getDate() - 60);
  const year = cst.getFullYear();
  const month = String(cst.getMonth() + 1).padStart(2, '0');
  const day = String(cst.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shuffleArray<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

async function selectDailyForCategory(
  category: string,
  targetDate: string,
  sixtyDaysAgo: string,
): Promise<{ selected: number; recycled: boolean }> {
  const supabase = getSupabase();

  const { data: freshData, error: freshError } = await supabase
    .from('trivia_questions')
    .select('id')
    .eq('category', category)
    .or(`daily_date.is.null,daily_date.lt.${sixtyDaysAgo}`)
    .limit(500);

  if (freshError) {
    console.warn(`[trivia-daily-generator] fresh-fetch error for ${category}:`, freshError.message);
    return { selected: 0, recycled: false };
  }

  let pool = ((freshData ?? []) as Array<{ id: string }>);
  let recycled = false;

  if (pool.length < QUESTIONS_PER_CATEGORY) {
    const { data: allData, error: allError } = await supabase
      .from('trivia_questions')
      .select('id')
      .eq('category', category)
      .neq('daily_date', targetDate)
      .order('daily_date', { ascending: true, nullsFirst: true })
      .limit(500);
    if (!allError && allData) {
      pool = allData as Array<{ id: string }>;
      recycled = true;
    }
  }

  const selected = shuffleArray(pool).slice(0, QUESTIONS_PER_CATEGORY);
  const selectedIds = selected.map((q) => q.id);
  if (selectedIds.length === 0) {
    console.warn(`[trivia-daily-generator] ${category}: no questions available`);
    return { selected: 0, recycled };
  }

  const { error: updateError } = await supabase
    .from('trivia_questions')
    .update({ daily_date: targetDate })
    .in('id', selectedIds);

  if (updateError) {
    console.warn(`[trivia-daily-generator] ${category}: tagging failed:`, updateError.message);
    return { selected: 0, recycled };
  }

  return { selected: selectedIds.length, recycled };
}

export async function triviaDailyGenerator(c: Context) {
  try {
    const targetDate = getTomorrowCST();
    const sixtyDaysAgo = getSixtyDaysAgoCST();
    const results: {
      date: string;
      categorySummary: Record<string, { selected: number; recycled: boolean }>;
      totalSelected: number;
      totalRecycled: number;
    } = {
      date: targetDate,
      categorySummary: {},
      totalSelected: 0,
      totalRecycled: 0,
    };

    const supabase = getSupabase();
    const { count: existingCount } = await supabase
      .from('trivia_questions')
      .select('*', { count: 'exact', head: true })
      .eq('daily_date', targetDate);

    if ((existingCount ?? 0) >= QUESTIONS_PER_CATEGORY * CATEGORIES.length) {
      return c.json({
        success: true,
        message: `Already rotated for ${targetDate}`,
        alreadyDone: true,
        existingCount,
      });
    }

    for (const category of CATEGORIES) {
      const { selected, recycled } = await selectDailyForCategory(category, targetDate, sixtyDaysAgo);
      results.categorySummary[category] = { selected, recycled };
      results.totalSelected += selected;
      if (recycled) results.totalRecycled++;
    }

    return c.json({
      success: true,
      message: `Rotated ${results.totalSelected} questions for ${targetDate}`,
      ...results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[trivia-daily-generator] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
