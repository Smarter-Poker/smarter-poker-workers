/**
 * GET/POST /cron/trivia-quality-audit
 *
 * Phase 52 (2026-05-05) — daily fact-check pass over Track B (Grok-generated)
 * trivia questions.
 *
 * Why this exists: Track B questions ("Phil Hellmuth has 17 bracelets",
 * "1970 was the first WSOP", etc.) are facts. The structural validator only
 * checks that there are 4 options and the index points to one of them — it
 * cannot detect "Hellmuth has 18 bracelets" hallucinations. Without a
 * verification step, weeks of cron-driven generation could silently pollute
 * the pool with wrong answers.
 *
 * What it does each tick:
 *   1. Pull up to AUDIT_PER_RUN un-audited questions where source='grok-3-mini'
 *      or source='grok-3', ordered by oldest-unaudited first.
 *   2. For each, ask Grok-3 (the FULL model, not mini) to fact-check:
 *        - Is the question factually answerable?
 *        - Is the marked correct option actually correct?
 *        - What's your confidence (0-1)?
 *   3. Update quality_score:
 *        - verified=true, confidence ≥ 0.85 → 9 (great)
 *        - verified=false, confidence ≥ 0.70 → 2 (excluded by minQualityScore=6 filter)
 *        - everything else → 5 (kept but de-prioritized; surfaces in dashboard)
 *   4. Log every decision to trivia_quality_audits with full reasoning.
 *   5. Mark last_audited_at so we don't re-check.
 *
 * Cost: ~$0.0025 per audit (Grok-3 full, ~500 tokens). At AUDIT_PER_RUN=200
 * once daily = ~$0.50/day = ~$15/month. With 4-hour generation cadence at
 * ~30 questions/tick = ~180 questions/day, this audit fully keeps up.
 *
 * Auth: /cron/* middleware chain (Bearer CRON_SECRET).
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { getGrokClient } from '../lib/grok.js';

const AUDIT_PER_RUN = 200;
const VERIFIER_MODEL = 'grok-3'; // full model — higher reasoning, catches subtle errors
const HIGH_CONFIDENCE = 0.85;
const FAIL_CONFIDENCE = 0.70;

const AUDIT_SYSTEM_PROMPT = `You are a quality-assurance reviewer for a poker trivia game. For each multiple-choice question you receive, you must verify FOUR things and reject the question if ANY fail.

CHECK 1 — FACTUAL ACCURACY (most important):
- Is the marked-correct answer actually correct? Verify against publicly known facts (WSOP/EPT/WPT records, player career stats, dollar amounts, dates, TDA rules).
- If the explanation contradicts the marked answer, reject.
- If you can't verify due to insufficient public info, set verified=false and confidence ≤ 0.5.

CHECK 2 — NO ANSWER-REVEALING TEXT:
- The question must NOT contain words or phrases that give away the answer.
  Bad: "What major poker event did Doyle Brunson win, called the World Series Main Event?" (the answer is in the question)
  Good: "What major event did Doyle Brunson win in 1976 and 1977 back-to-back?"
- If the question text leaks the answer, reject (verified=false, confidence ≥ 0.8).

CHECK 3 — DISTRACTOR PARITY:
- All four options must be in the same category and roughly the same length.
  Bad: ["1970", "1971", "the moon", "purple"] — non-numeric distractors when the answer is a year
  Bad: ["Phil Hellmuth", "Doyle Brunson", "X", "Y"] — name distractors when the question asks for a year
  Good: distractors that are PLAUSIBLE WRONG ANSWERS a real player might pick.
- Joke distractors that obviously aren't real answers → reject.

CHECK 4 — DIFFICULTY HONESTY:
- If marked "hard" but only one option could plausibly be the answer (others are absurd), the question is too easy → reject.
- If marked "easy" but requires obscure knowledge, label is wrong → still verify=true if factually correct, but knock confidence down to 0.7.

Output ONLY valid JSON in this exact shape (no markdown, no extra fields):
{
  "verified": true | false,
  "confidence": 0.00 to 1.00,
  "reasoning": "1-2 sentences. Cite the actual fact AND/OR which check failed (factual / reveals-answer / distractor-quality / difficulty-mismatch)",
  "failure_modes": ["factual"|"reveals_answer"|"distractor_quality"|"difficulty_mismatch"|null],
  "corrected_answer_text": "if verified=false and you know the right answer, put it here; otherwise null"
}`;

function buildVerifyPrompt(q: any): string {
  return `Question: ${q.question}
Options:
  A) ${q.options[0]}
  B) ${q.options[1]}
  C) ${q.options[2]}
  D) ${q.options[3]}
Marked correct: ${'ABCD'[q.correct_index]}) ${q.options[q.correct_index]}
Explanation: ${q.explanation}
Category: ${q.category}${q.subcategory ? ` (subcategory: ${q.subcategory})` : ''}`;
}

interface AuditDecision {
  verified: boolean;
  confidence: number;
  reasoning: string;
  failure_modes: string[]; // Phase 53 — categorize WHY a question failed
  corrected_answer_text: string | null;
}

interface AuditOutcome {
  questionId: string;
  decision: AuditDecision | null;
  newQualityScore: number;
  prevQualityScore: number | null;
  costUsd: number;
  error?: string;
}

async function auditOne(grok: any, q: any): Promise<AuditOutcome> {
  const prevQS = q.quality_score ?? null;
  try {
    const response = await grok.chat.completions.create({
      model: VERIFIER_MODEL,
      messages: [
        { role: 'system', content: AUDIT_SYSTEM_PROMPT },
        { role: 'user', content: buildVerifyPrompt(q) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.0,
      max_tokens: 600,
    });
    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      return { questionId: q.id, decision: null, newQualityScore: prevQS ?? 5, prevQualityScore: prevQS, costUsd: 0, error: 'empty response' };
    }
    const parsed = JSON.parse(content);
    const decision: AuditDecision = {
      verified: !!parsed.verified,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      reasoning: String(parsed.reasoning || '').slice(0, 1000),
      failure_modes: Array.isArray(parsed.failure_modes)
        ? parsed.failure_modes.filter((f: any) => f && typeof f === 'string').map((f: string) => f.slice(0, 30))
        : [],
      corrected_answer_text: parsed.corrected_answer_text ? String(parsed.corrected_answer_text).slice(0, 200) : null,
    };

    let newQS: number;
    if (decision.verified && decision.confidence >= HIGH_CONFIDENCE) {
      newQS = 9; // gold-tier
    } else if (!decision.verified && decision.confidence >= FAIL_CONFIDENCE) {
      newQS = 2; // soft-exclude (below the minQualityScore=6 floor used by all gameplay routes)
    } else {
      newQS = 5; // uncertain — surface in dashboard for human review
    }

    // Cost: Grok-3 full ~$5/M input + $15/M output
    const usage = response.usage || {};
    const callCost =
      ((usage.prompt_tokens || 0) / 1e6) * 5.0 +
      ((usage.completion_tokens || 0) / 1e6) * 15.0;

    return { questionId: q.id, decision, newQualityScore: newQS, prevQualityScore: prevQS, costUsd: callCost };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { questionId: q.id, decision: null, newQualityScore: prevQS ?? 5, prevQualityScore: prevQS, costUsd: 0, error: msg };
  }
}

export async function triviaQualityAudit(c: Context) {
  const startTs = Date.now();
  const sb = getSupabase();
  const grok = getGrokClient();

  // Pull oldest un-audited Grok rows. Order matters: prioritize fact-categories.
  const { data: candidates, error } = await sb
    .from('trivia_questions')
    .select('id, category, subcategory, difficulty, question, options, correct_index, explanation, source, quality_score')
    .in('source', ['grok-3-mini', 'grok-3'])
    .is('last_audited_at', null)
    .order('created_at', { ascending: true })
    .limit(AUDIT_PER_RUN);

  if (error) {
    console.warn('[trivia-quality-audit] candidate fetch failed:', error.message);
    return c.json({ success: false, error: error.message }, 500);
  }

  if (!candidates || candidates.length === 0) {
    return c.json({ success: true, message: 'no un-audited Grok questions in pool', audited: 0, elapsedMs: Date.now() - startTs });
  }

  // Audit sequentially — Grok-3 has rate limits, and we don't need parallelism for 200/day.
  // Could parallelize 3-5 at a time later if backlog grows. For now, simple is correct.
  const outcomes: AuditOutcome[] = [];
  let totalCost = 0;
  let verifiedTrue = 0;
  let verifiedFalse = 0;
  let uncertain = 0;
  let errors = 0;

  for (const q of candidates) {
    const o = await auditOne(grok, q);
    outcomes.push(o);
    totalCost += o.costUsd;
    if (o.error) { errors++; continue; }
    if (!o.decision) continue;
    if (o.decision.verified && o.decision.confidence >= HIGH_CONFIDENCE) verifiedTrue++;
    else if (!o.decision.verified && o.decision.confidence >= FAIL_CONFIDENCE) verifiedFalse++;
    else uncertain++;
  }

  // Bulk-update trivia_questions and bulk-insert audit log rows
  const auditRows = outcomes.filter(o => o.decision !== null).map(o => ({
    question_id: o.questionId,
    verifier_model: VERIFIER_MODEL,
    verified: o.decision!.verified,
    confidence: o.decision!.confidence,
    reasoning: o.decision!.reasoning,
    failure_modes: o.decision!.failure_modes,
    corrected_answer_text: o.decision!.corrected_answer_text,
    previous_quality_score: o.prevQualityScore,
    new_quality_score: o.newQualityScore,
    cost_usd: o.costUsd,
  }));

  if (auditRows.length > 0) {
    const { error: insErr } = await sb.from('trivia_quality_audits').insert(auditRows);
    if (insErr) console.warn('[trivia-quality-audit] audit log insert failed:', insErr.message);
  }

  // Update each trivia_question — must be one update per row because PostgREST
  // doesn't support arbitrary bulk update sets. Group by new_quality_score for
  // efficiency: update all rows with the same target score in one .in() query.
  const byScore: Record<number, string[]> = {};
  for (const o of outcomes) {
    if (!o.decision) continue;
    (byScore[o.newQualityScore] ||= []).push(o.questionId);
  }

  for (const [scoreStr, ids] of Object.entries(byScore)) {
    const score = parseInt(scoreStr, 10);
    const audited = outcomes.find(o => ids.includes(o.questionId) && o.decision)?.decision;
    const { error: upErr } = await sb
      .from('trivia_questions')
      .update({
        quality_score: score,
        last_audited_at: new Date().toISOString(),
        audit_verified: audited?.verified ?? null,
        audit_confidence: audited?.confidence ?? null,
      })
      .in('id', ids);
    if (upErr) console.warn(`[trivia-quality-audit] qs=${score} update failed:`, upErr.message);
  }

  // Phase 54 #4 — write a per-category health snapshot the generation handler
  // reads from to decide whether to pause that category.
  const perCategory: Record<string, { audited: number; verifiedTrue: number; verifiedFalse: number }> = {};
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    if (!cand) continue;
    const cat = cand.category;
    const o = outcomes[i];
    if (!perCategory[cat]) perCategory[cat] = { audited: 0, verifiedTrue: 0, verifiedFalse: 0 };
    perCategory[cat]!.audited++;
    if (!o?.decision) continue;
    if (o.decision.verified && o.decision.confidence >= HIGH_CONFIDENCE) perCategory[cat]!.verifiedTrue++;
    else if (!o.decision.verified && o.decision.confidence >= FAIL_CONFIDENCE) perCategory[cat]!.verifiedFalse++;
  }
  const healthRows = Object.entries(perCategory).map(([category, s]) => {
    const passRate = s.audited > 0 ? Number((s.verifiedTrue / s.audited).toFixed(3)) : null;
    const pause = passRate !== null && passRate < 0.85;
    return {
      category,
      audited_count: s.audited,
      verified_true_count: s.verifiedTrue,
      verified_false_count: s.verifiedFalse,
      pass_rate: passRate,
      generation_paused: pause,
      pause_reason: pause ? `audit pass rate ${Math.round((passRate || 0) * 100)}% < 85% threshold` : null,
    };
  });
  if (healthRows.length > 0) {
    const { error: hErr } = await sb.from('trivia_category_health').insert(healthRows);
    if (hErr) console.warn('[trivia-quality-audit] health snapshot insert failed:', hErr.message);
  }

  const elapsedMs = Date.now() - startTs;
  console.log(`[trivia-quality-audit] audited ${candidates.length} (✓${verifiedTrue} ✗${verifiedFalse} ?${uncertain} err${errors}) cost $${totalCost.toFixed(4)} in ${elapsedMs}ms`);

  return c.json({
    success: true,
    audited: candidates.length,
    breakdown: { verified_true: verifiedTrue, verified_false: verifiedFalse, uncertain, errors },
    cost_usd: Number(totalCost.toFixed(4)),
    elapsed_ms: elapsedMs,
    sample_flagged: outcomes
      .filter(o => o.decision && !o.decision.verified && o.decision.confidence >= FAIL_CONFIDENCE)
      .slice(0, 5)
      .map(o => ({ questionId: o.questionId, reasoning: o.decision!.reasoning })),
  });
}
