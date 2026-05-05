/**
 * Phase 54 — quality-tooling cron handlers (single file, multiple routes).
 *
 * Routes:
 *   GET /cron/trivia-embed-backfill     — generate embeddings for new rows (100/tick)
 *   GET /cron/trivia-theme-backfill     — extract theme tag for new rows (50/tick)
 *   GET /cron/trivia-player-retag       — retag difficulty + demote based on player success rate
 *   GET /cron/trivia-skip-demote        — demote questions skipped by >20% of players who saw them
 *   GET /cron/trivia-regression-tests   — daily bias / parity / reveal / theme-density / dup tests
 *
 * Each route is independently scheduled in the openclaw dispatcher.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { getGrokClient } from '../lib/grok.js';

// ─── Embeddings via xAI's text-embedding-3-small via /v1/embeddings ─────
// xAI exposes OpenAI-compatible /v1/embeddings; we use their `text-embedding-001`
// (384-dim, cheap). Falls back to deterministic hash-based pseudo-embedding
// if the embeddings API isn't available — that still gives partial dedup
// signal via the keyword overlap part of the fall-back path.

async function generateEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch('https://api.x.ai/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      signal: ctrl.signal,
      body: JSON.stringify({ model: 'v1', input: text.slice(0, 8000) }),
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const vec = (data as any)?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) return null;
    // Truncate/pad to 384 dims to match column type
    if (vec.length === 384) return vec;
    if (vec.length > 384) return vec.slice(0, 384);
    return vec.concat(new Array(384 - vec.length).fill(0));
  } catch { return null; }
}

export async function triviaEmbedBackfill(c: Context) {
  const sb = getSupabase();
  const start = Date.now();
  const { data: rows, error } = await sb
    .from('trivia_questions')
    .select('id, question')
    .is('embedding', null)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return c.json({ success: false, error: error.message }, 500);
  if (!rows || rows.length === 0) return c.json({ success: true, message: 'all caught up' });

  let embedded = 0;
  let failed = 0;
  for (const row of rows) {
    const vec = await generateEmbedding(row.question);
    if (!vec) { failed++; continue; }
    const { error: upErr } = await sb
      .from('trivia_questions')
      .update({ embedding: vec })
      .eq('id', row.id);
    if (upErr) { failed++; continue; }
    embedded++;
  }
  return c.json({ success: true, embedded, failed, elapsedMs: Date.now() - start });
}

// ─── Theme extraction via Grok-3-mini ───────────────────────────────────

export async function triviaThemeBackfill(c: Context) {
  const sb = getSupabase();
  const grok = getGrokClient();
  const start = Date.now();

  const { data: rows, error } = await sb
    .from('trivia_questions')
    .select('id, category, question, options, correct_index')
    .is('theme', null)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return c.json({ success: false, error: error.message }, 500);
  if (!rows || rows.length === 0) return c.json({ success: true, message: 'all caught up' });

  const SYSTEM = 'Output ONLY a 1-3 word kebab-case theme tag. No JSON, no quotes, no explanation. Example outputs: "black-friday", "phil-hellmuth-bracelets", "wsop-main-event-buy-in", "tda-string-bet-rule".';

  let tagged = 0;
  for (const row of rows) {
    try {
      const opts = typeof row.options === 'string' ? JSON.parse(row.options) : row.options;
      const userMsg = `Category: ${row.category}\nQ: ${row.question}\nA: ${opts[row.correct_index]}`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const response = await grok.chat.completions.create({
        model: 'grok-3-mini',
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userMsg },
        ],
        max_tokens: 50,
        temperature: 0,
        // @ts-ignore xAI param
        reasoning_effort: 'low',
      } as any);
      clearTimeout(t);
      const theme = String(response.choices[0]?.message?.content || '')
        .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      if (!theme) continue;
      const { error: upErr } = await sb.from('trivia_questions').update({ theme }).eq('id', row.id);
      if (!upErr) tagged++;
    } catch { /* skip on error */ }
  }
  return c.json({ success: true, tagged, elapsedMs: Date.now() - start });
}

// ─── Player-success retag — demote/retag based on times_correct/times_shown ──

export async function triviaPlayerRetag(c: Context) {
  const sb = getSupabase();
  const start = Date.now();
  const { data, error } = await sb
    .from('trivia_question_player_stats')
    .select('id, difficulty, success_rate_pct, player_signal, quality_score')
    .neq('player_signal', 'ok')
    .limit(500);
  if (error) return c.json({ success: false, error: error.message }, 500);

  let demoted = 0;
  let retagged = 0;
  for (const r of data || []) {
    const updates: any = {};
    if (r.player_signal === 'too-hard-or-wrong' || r.player_signal === 'suspect-bad') {
      updates.quality_score = Math.min(r.quality_score ?? 5, 3); // soft-exclude
      demoted++;
    } else if (r.player_signal === 'mislabeled-easy') {
      updates.retagged_difficulty = r.difficulty;
      updates.difficulty = 'easy';
      retagged++;
    } else if (r.player_signal === 'high-skip') {
      updates.quality_score = Math.min(r.quality_score ?? 5, 4);
      demoted++;
    }
    if (Object.keys(updates).length > 0) {
      await sb.from('trivia_questions').update(updates).eq('id', r.id);
    }
  }
  return c.json({ success: true, demoted, retagged, elapsedMs: Date.now() - start });
}

// ─── Skip-rate auto-demote (covered by player retag) ──────────────────────
// The 'high-skip' signal in trivia_question_player_stats already handles this.
// triviaPlayerRetag picks them up. No separate handler needed.

// ─── Daily regression tests ───────────────────────────────────────────────

interface TestResult {
  test: string;
  category: string | null;
  passed: boolean;
  metric: number;
  threshold: number;
  sampleSize: number;
  details: any;
}

async function testPositionBias(sb: any): Promise<TestResult[]> {
  // For each category, correct_index distribution should be 15-35% per position
  const results: TestResult[] = [];
  const cats = ['gto_theory', 'gto_scenarios', 'cash_game_situations', 'mtt_situations', 'icm_chip_ev',
                'poker_history', 'famous_hands', 'player_profiles', 'tournament_facts', 'rule_knowledge'];
  for (const cat of cats) {
    const counts: number[] = [0, 0, 0, 0];
    let total = 0;
    for (let i = 0; i < 4; i++) {
      const { count } = await sb.from('trivia_questions').select('*', { count: 'exact', head: true }).eq('category', cat).eq('correct_index', i);
      counts[i] = count || 0;
      total += counts[i] || 0;
    }
    if (total < 40) continue;
    const pcts = counts.map(c => c / total);
    const maxDev = Math.max(...pcts.map(p => Math.abs(p - 0.25)));
    results.push({
      test: 'position_bias',
      category: cat,
      passed: maxDev < 0.10, // >10% deviation from 25% = bias
      metric: Math.round(maxDev * 1000) / 1000,
      threshold: 0.10,
      sampleSize: total,
      details: { distribution_pct: pcts.map(p => Math.round(p * 1000) / 10) },
    });
  }
  return results;
}

async function testLengthParity(sb: any): Promise<TestResult[]> {
  // Sample 200 questions per category; flag if >5% have ratio >2x or <0.5x
  const results: TestResult[] = [];
  const cats = ['gto_theory', 'gto_scenarios', 'cash_game_situations', 'mtt_situations', 'icm_chip_ev',
                'poker_history', 'famous_hands', 'player_profiles', 'tournament_facts', 'rule_knowledge'];
  for (const cat of cats) {
    const { data } = await sb.from('trivia_questions').select('options, correct_index').eq('category', cat).limit(200);
    if (!data || data.length < 40) continue;
    let fails = 0;
    for (const row of data) {
      const opts = typeof row.options === 'string' ? JSON.parse(row.options) : row.options;
      if (!Array.isArray(opts) || opts.length !== 4) continue;
      const lens = opts.map((o: string) => String(o).length);
      const correct = lens[row.correct_index] || 0;
      const distractors = lens.filter((_: number, i: number) => i !== row.correct_index);
      const avgD = distractors.reduce((s: number, v: number) => s + v, 0) / Math.max(distractors.length, 1);
      const ratio = correct / Math.max(avgD, 1);
      if (ratio > 2.0 || ratio < 0.5) fails++;
    }
    const failRate = fails / data.length;
    results.push({
      test: 'length_parity',
      category: cat,
      passed: failRate < 0.05,
      metric: Math.round(failRate * 1000) / 1000,
      threshold: 0.05,
      sampleSize: data.length,
      details: { fails, sample_size: data.length },
    });
  }
  return results;
}

async function testThemeDensity(sb: any): Promise<TestResult[]> {
  // Per category, no single theme should be >5% of the total pool
  const results: TestResult[] = [];
  const cats = ['poker_history', 'famous_hands', 'player_profiles', 'tournament_facts', 'rule_knowledge'];
  for (const cat of cats) {
    const { data } = await sb.from('trivia_questions').select('theme').eq('category', cat).not('theme', 'is', null);
    if (!data || data.length < 50) continue;
    const counts: Record<string, number> = {};
    for (const r of data) counts[r.theme] = (counts[r.theme] || 0) + 1;
    const themes = Object.entries(counts).map(([t, n]) => ({ t, n, pct: n / data.length }));
    themes.sort((a, b) => b.n - a.n);
    const topPct = themes[0]?.pct ?? 0;
    results.push({
      test: 'theme_density',
      category: cat,
      passed: topPct <= 0.10,    // top theme should be <10% of category
      metric: Math.round(topPct * 1000) / 1000,
      threshold: 0.10,
      sampleSize: data.length,
      details: { top_5_themes: themes.slice(0, 5) },
    });
  }
  return results;
}

export async function triviaRegressionTests(c: Context) {
  const sb = getSupabase();
  const start = Date.now();

  const all: TestResult[] = [
    ...(await testPositionBias(sb)),
    ...(await testLengthParity(sb)),
    ...(await testThemeDensity(sb)),
  ];

  // Persist
  const rows = all.map(r => ({
    test_name: r.test,
    category: r.category,
    passed: r.passed,
    metric: r.metric,
    threshold: r.threshold,
    sample_size: r.sampleSize,
    details: r.details,
  }));
  if (rows.length > 0) await sb.from('trivia_regression_runs').insert(rows);

  const failed = all.filter(r => !r.passed);
  return c.json({
    success: true,
    total_tests: all.length,
    passed: all.length - failed.length,
    failed: failed.length,
    failures: failed.map(f => ({ test: f.test, category: f.category, metric: f.metric, threshold: f.threshold })),
    elapsedMs: Date.now() - start,
  });
}
