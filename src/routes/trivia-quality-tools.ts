/**
 * GET/POST /cron/trivia-embed-backfill
 * GET/POST /cron/trivia-theme-backfill
 * GET/POST /cron/trivia-player-retag
 * GET/POST /cron/trivia-regression-tests
 *
 * Phase 50 (2026-05-12) — trivia quality maintenance routes.
 *
 * triviaEmbedBackfill   — backfills the `embedding` vector(384) column for
 *                         un-embedded questions, 100 per cron tick.
 * triviaThemeBackfill   — classifies `theme` TEXT for questions where theme
 *                         IS NULL, 50 per tick. Fast-paths det: and grok:
 *                         subcategory prefixes; falls back to Grok-3-mini
 *                         for unknown sources.
 * triviaPlayerRetag     — updates `retagged_difficulty` from live
 *                         times_correct / times_shown signal, 500 per tick.
 * triviaRegressionTests — runs position-bias, theme-density, and pool-health
 *                         regression checks; writes to trivia_regression_runs.
 *
 * Root-cause fix: index.ts imported these four handlers but this file did
 * not exist, causing the workers process to 404 every request to these
 * routes (~192 failures/day in cron_execution_log).
 *
 * Auth: /cron/* middleware chain (Bearer CRON_SECRET).
 *
 * Env vars required:
 *   XAI_API_KEY (embed backfill + theme Grok classification)
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const EMBED_BATCH_SIZE = 100;
const THEME_BATCH_SIZE = 50;
const RETAG_BATCH_SIZE = 500;
const RETAG_MIN_SHOWN = 10;

// ─── Embed Backfill ───────────────────────────────────────────────────────

/**
 * Fetches up to EMBED_BATCH_SIZE questions with a NULL embedding column and
 * writes the xAI vector(384) embedding for each one. Fires every 2h at :15
 * via Open Claw → WORKERS_PREFERRED routing.
 */
export async function triviaEmbedBackfill(c: Context) {
  const startedAt = new Date().toISOString();
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return c.json({ ok: false, error: 'XAI_API_KEY not configured', started_at: startedAt }, 500);
  }

  const sb = getSupabase();
  const { data: rows, error } = await sb
    .from('trivia_questions')
    .select('id, question, category')
    .is('embedding', null)
    .limit(EMBED_BATCH_SIZE);

  if (error) {
    return c.json({ ok: false, error: error.message, started_at: startedAt }, 500);
  }

  const questions = (rows ?? []) as Array<{ id: string; question: string; category: string }>;
  let embedded = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const row of questions) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch('https://api.x.ai/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: ctrl.signal,
        body: JSON.stringify({ model: 'v1', input: row.question.slice(0, 4000) }),
      });
      clearTimeout(timer);

      if (!res.ok) {
        failed++;
        errors.push(`${row.id}: HTTP ${res.status}`);
        continue;
      }

      const data = (await res.json()) as any;
      const arr: number[] | undefined = data?.data?.[0]?.embedding;
      if (!Array.isArray(arr)) {
        failed++;
        errors.push(`${row.id}: no embedding in response`);
        continue;
      }

      // Normalise to exactly 384 dimensions to match trivia_questions.embedding vector(384)
      let vec: number[];
      if (arr.length === 384) vec = arr;
      else if (arr.length > 384) vec = arr.slice(0, 384);
      else vec = [...arr, ...new Array(384 - arr.length).fill(0)];

      const { error: upErr } = await sb
        .from('trivia_questions')
        .update({ embedding: vec as any })
        .eq('id', row.id);

      if (upErr) {
        failed++;
        errors.push(`${row.id}: update failed — ${upErr.message}`);
      } else {
        embedded++;
      }
    } catch (err) {
      failed++;
      errors.push(`${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const { count: remaining } = await sb
    .from('trivia_questions')
    .select('*', { count: 'exact', head: true })
    .is('embedding', null);

  return c.json({
    ok: failed === 0,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    scanned: questions.length,
    embedded,
    failed,
    remaining_unembedded: remaining ?? 0,
    errors: errors.slice(0, 10),
  });
}

// ─── Theme Backfill ───────────────────────────────────────────────────────

const THEME_SYSTEM_PROMPT =
  'You are a poker trivia classifier. Given a trivia question, output a short theme label (2-4 words, lowercase, underscores for spaces) capturing the core topic. Output ONLY the theme string, no quotes, no punctuation.';

const CATEGORY_THEME_FALLBACK: Record<string, string> = {
  poker_history: 'poker_history',
  famous_hands: 'famous_hand',
  player_profiles: 'player_career',
  tournament_facts: 'tournament',
  rule_knowledge: 'poker_rules',
  gto_theory: 'gto_strategy',
  gto_scenarios: 'gto_strategy',
  cash_game_situations: 'cash_game',
  mtt_situations: 'tournament_play',
  icm_chip_ev: 'icm_strategy',
};

async function classifyThemeViaGrok(question: string, category: string): Promise<string> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return CATEGORY_THEME_FALLBACK[category] ?? 'general';

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: 'grok-3-mini',
        messages: [
          { role: 'system', content: THEME_SYSTEM_PROMPT },
          { role: 'user', content: question.slice(0, 500) },
        ],
        temperature: 0.1,
        max_tokens: 20,
        reasoning_effort: 'low',
      }),
    });
    clearTimeout(timer);

    if (!res.ok) return CATEGORY_THEME_FALLBACK[category] ?? 'general';

    const data = (await res.json()) as any;
    const raw: string = data?.choices?.[0]?.message?.content?.trim() ?? '';
    if (!raw) return CATEGORY_THEME_FALLBACK[category] ?? 'general';

    // Sanitise: lowercase, spaces/hyphens → underscores, strip non-alphanum, cap length
    const theme = raw
      .toLowerCase()
      .replace(/[\s\-]+/g, '_')
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 40);
    return theme || (CATEGORY_THEME_FALLBACK[category] ?? 'general');
  } catch {
    return CATEGORY_THEME_FALLBACK[category] ?? 'general';
  }
}

/**
 * Classifies `theme` for up to THEME_BATCH_SIZE questions where theme IS NULL.
 * Fast-paths:
 *   det:* subcategory → use the category-level fallback theme (GTO/cash/MTT)
 *   grok:* subcategory → strip prefix and slug-ify as the theme
 * Unknown sources → call Grok-3-mini (reasoning_effort: low) to classify.
 * Fires every 2h at :45 via Open Claw → WORKERS_PREFERRED routing.
 */
export async function triviaThemeBackfill(c: Context) {
  const startedAt = new Date().toISOString();
  const sb = getSupabase();

  const { data: rows, error } = await sb
    .from('trivia_questions')
    .select('id, question, category, subcategory')
    .is('theme', null)
    .limit(THEME_BATCH_SIZE);

  if (error) {
    return c.json({ ok: false, error: error.message, started_at: startedAt }, 500);
  }

  const questions = (rows ?? []) as Array<{
    id: string;
    question: string;
    category: string;
    subcategory: string | null;
  }>;
  let themed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const row of questions) {
    try {
      let theme: string;

      if (row.subcategory?.startsWith('det:')) {
        // Deterministic Track A — use category-level fallback
        theme = CATEGORY_THEME_FALLBACK[row.category] ?? 'gto_strategy';
      } else if (row.subcategory?.startsWith('grok:')) {
        // Track B — subcategory text after the prefix is already descriptive
        const subText = row.subcategory
          .slice(5)
          .toLowerCase()
          .replace(/[\s\-]+/g, '_')
          .replace(/[^a-z0-9_]/g, '')
          .slice(0, 40);
        theme = subText || (CATEGORY_THEME_FALLBACK[row.category] ?? 'general');
      } else {
        // Unknown source — classify via Grok
        theme = await classifyThemeViaGrok(row.question, row.category);
      }

      const { error: upErr } = await sb
        .from('trivia_questions')
        .update({ theme })
        .eq('id', row.id);

      if (upErr) {
        failed++;
        errors.push(`${row.id}: update failed — ${upErr.message}`);
      } else {
        themed++;
      }
    } catch (err) {
      failed++;
      errors.push(`${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const { count: remaining } = await sb
    .from('trivia_questions')
    .select('*', { count: 'exact', head: true })
    .is('theme', null);

  return c.json({
    ok: failed === 0,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    scanned: questions.length,
    themed,
    failed,
    remaining_unthemed: remaining ?? 0,
    errors: errors.slice(0, 10),
  });
}

// ─── Player Retag ─────────────────────────────────────────────────────────

/**
 * Updates `retagged_difficulty` for questions that have been shown at least
 * RETAG_MIN_SHOWN times, based on the live correct-rate signal:
 *   >= 70% correct → easy
 *   <  40% correct → hard
 *   otherwise      → medium
 * Processes up to RETAG_BATCH_SIZE rows per tick. Skips rows where the
 * retagged value wouldn't change.
 */
export async function triviaPlayerRetag(c: Context) {
  const startedAt = new Date().toISOString();
  const sb = getSupabase();

  const { data: rows, error } = await sb
    .from('trivia_questions')
    .select('id, times_shown, times_correct, retagged_difficulty')
    .gte('times_shown', RETAG_MIN_SHOWN)
    .limit(RETAG_BATCH_SIZE);

  if (error) {
    return c.json({ ok: false, error: error.message, started_at: startedAt }, 500);
  }

  const questions = (rows ?? []) as Array<{
    id: string;
    times_shown: number;
    times_correct: number | null;
    retagged_difficulty: string | null;
  }>;

  let retagged = 0;
  let unchanged = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const row of questions) {
    try {
      if (!row.times_shown || row.times_shown < RETAG_MIN_SHOWN) {
        unchanged++;
        continue;
      }

      const correctRate = (row.times_correct ?? 0) / row.times_shown;

      let newTag: 'easy' | 'medium' | 'hard';
      if (correctRate >= 0.70) newTag = 'easy';
      else if (correctRate < 0.40) newTag = 'hard';
      else newTag = 'medium';

      if (row.retagged_difficulty === newTag) {
        unchanged++;
        continue;
      }

      const { error: upErr } = await sb
        .from('trivia_questions')
        .update({ retagged_difficulty: newTag })
        .eq('id', row.id);

      if (upErr) {
        failed++;
        errors.push(`${row.id}: ${upErr.message}`);
      } else {
        retagged++;
      }
    } catch (err) {
      failed++;
      errors.push(`${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return c.json({
    ok: failed === 0,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    scanned: questions.length,
    retagged,
    unchanged,
    failed,
    errors: errors.slice(0, 10),
  });
}

// ─── Regression Tests ─────────────────────────────────────────────────────

const ALL_CATEGORIES = [
  'gto_theory',
  'gto_scenarios',
  'cash_game_situations',
  'mtt_situations',
  'icm_chip_ev',
  'poker_history',
  'famous_hands',
  'player_profiles',
  'tournament_facts',
  'rule_knowledge',
];

// Position-bias: no correct_index value should appear in >35% of questions
const POSITION_BIAS_THRESHOLD = 0.35;
// Theme density: no single theme should represent >5% of a category
const THEME_DENSITY_THRESHOLD = 0.05;
// Pool health: each category should be at least 50% filled toward 1500 target
const POOL_FILL_THRESHOLD = 0.50;
const TARGET_PER_CATEGORY = 1500;

/**
 * Runs three regression checks across all categories and writes results to
 * trivia_regression_runs. Fails non-destructively — individual test errors
 * are collected and returned without aborting the run.
 *
 * Tests:
 *   position_bias   — correct_index distribution ≤ 35% on any single index
 *   theme_density   — no theme > 5% of category questions
 *   pool_health     — each category ≥ 50% full (global run, category = 'all')
 */
export async function triviaRegressionTests(c: Context) {
  const startedAt = new Date().toISOString();
  const sb = getSupabase();
  const ranAt = new Date().toISOString();
  const inserted: Array<{ test: string; category: string; passed: boolean; metric: number }> = [];
  const errors: string[] = [];

  for (const category of ALL_CATEGORIES) {
    // ── Test 1: Position bias ────────────────────────────────────────
    const { data: posRows } = await sb
      .from('trivia_questions')
      .select('correct_index')
      .eq('category', category)
      .limit(1000);

    if (posRows && posRows.length >= 40) {
      const counts = [0, 0, 0, 0];
      for (const r of posRows as Array<{ correct_index: number }>) {
        const idx = r.correct_index;
        if (idx >= 0 && idx <= 3) counts[idx]!++;
      }
      const total = counts.reduce((a, b) => a + b, 0);
      const maxShare = total > 0 ? Math.max(...counts) / total : 0;
      const passed = maxShare <= POSITION_BIAS_THRESHOLD;

      const { error: insErr } = await sb.from('trivia_regression_runs').insert({
        ran_at: ranAt,
        test_name: 'position_bias',
        category,
        passed,
        metric: Number(maxShare.toFixed(4)),
        threshold: POSITION_BIAS_THRESHOLD,
        sample_size: total,
        details: {
          index_counts: counts,
          index_shares: counts.map(n => Number((n / total).toFixed(3))),
          worst_index: counts.indexOf(Math.max(...counts)),
        },
      });
      if (insErr) errors.push(`position_bias/${category}: ${insErr.message}`);
      else inserted.push({ test: 'position_bias', category, passed, metric: maxShare });
    }

    // ── Test 2: Theme density ────────────────────────────────────────
    const { data: themeRows } = await sb
      .from('trivia_questions')
      .select('theme')
      .eq('category', category)
      .not('theme', 'is', null)
      .limit(2000);

    if (themeRows && themeRows.length >= 40) {
      const themeMap: Record<string, number> = {};
      for (const r of themeRows as Array<{ theme: string }>) {
        if (r.theme) themeMap[r.theme] = (themeMap[r.theme] ?? 0) + 1;
      }
      const total = themeRows.length;
      const themeCounts = Object.values(themeMap);
      const maxShare = total > 0 && themeCounts.length > 0
        ? Math.max(...themeCounts) / total
        : 0;
      const worstTheme =
        Object.entries(themeMap).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const passed = maxShare <= THEME_DENSITY_THRESHOLD;

      const { error: insErr } = await sb.from('trivia_regression_runs').insert({
        ran_at: ranAt,
        test_name: 'theme_density',
        category,
        passed,
        metric: Number(maxShare.toFixed(4)),
        threshold: THEME_DENSITY_THRESHOLD,
        sample_size: total,
        details: {
          theme_count: Object.keys(themeMap).length,
          worst_theme: worstTheme,
          worst_theme_share: Number(maxShare.toFixed(3)),
          top_themes: Object.entries(themeMap)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([t, n]) => ({
              theme: t,
              count: n,
              share: Number((n / total).toFixed(3)),
            })),
        },
      });
      if (insErr) errors.push(`theme_density/${category}: ${insErr.message}`);
      else inserted.push({ test: 'theme_density', category, passed, metric: maxShare });
    }
  }

  // ── Test 3: Pool health (global) ────────────────────────────────────
  const { data: poolRows } = await sb
    .from('trivia_questions')
    .select('category')
    .limit(20000);

  if (poolRows && poolRows.length > 0) {
    const catCounts: Record<string, number> = {};
    for (const r of poolRows as Array<{ category: string }>) {
      catCounts[r.category] = (catCounts[r.category] ?? 0) + 1;
    }

    // Score by the worst-performing category
    const entries = Object.entries(catCounts).sort((a, b) => a[1] - b[1]);
    const lowestEntry = entries[0];
    const lowestFill = lowestEntry ? lowestEntry[1] / TARGET_PER_CATEGORY : 0;
    const passed = lowestFill >= POOL_FILL_THRESHOLD;

    const { error: insErr } = await sb.from('trivia_regression_runs').insert({
      ran_at: ranAt,
      test_name: 'pool_health',
      category: 'all',
      passed,
      metric: Number(lowestFill.toFixed(4)),
      threshold: POOL_FILL_THRESHOLD,
      sample_size: poolRows.length,
      details: {
        category_counts: catCounts,
        target_per_category: TARGET_PER_CATEGORY,
        lowest_category: lowestEntry?.[0] ?? null,
        lowest_count: lowestEntry?.[1] ?? 0,
        fill_pct_by_category: Object.fromEntries(
          Object.entries(catCounts).map(([cat, n]) => [
            cat,
            Number((n / TARGET_PER_CATEGORY).toFixed(3)),
          ]),
        ),
      },
    });
    if (insErr) errors.push(`pool_health: ${insErr.message}`);
    else inserted.push({ test: 'pool_health', category: 'all', passed, metric: lowestFill });
  }

  const totalPassed = inserted.filter(r => r.passed).length;
  const totalFailed = inserted.filter(r => !r.passed).length;

  return c.json({
    ok: errors.length === 0,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    tests_run: inserted.length,
    passed: totalPassed,
    failed_tests: totalFailed,
    results: inserted,
    errors: errors.slice(0, 10),
  });
}
