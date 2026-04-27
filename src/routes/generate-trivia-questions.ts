/**
 * GET/POST /cron/generate-trivia-questions
 *
 * Ported from monolith pages/api/cron/generate-trivia-questions.js (560 LOC).
 * Phase 2B.3 Option B port (2026-04-27) — closes the last monolith cron
 * exception. After this lands, pages/api/cron/ is empty.
 *
 * Behavior unchanged from monolith:
 * - Manual admin trigger (called by pages/api/admin/trivia-pool-status.js)
 * - Generates trivia questions via Grok in batches (3 per run, 30 questions/batch)
 * - 5-layer QA validation gate before any DB insert
 * - 60-day non-repeat dedup via keyword-overlap heuristic
 *
 * Auth: /cron/* middleware chain (Bearer CRON_SECRET).
 *
 * Env vars required:
 *   XAI_API_KEY (Grok)
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { getGrokClient } from '../lib/grok.js';
import { validateBatch, type TriviaQuestion } from '../lib/triviaValidator.js';

// ─── Category definitions (verbatim from monolith) ────────────────────────
interface Category {
  id: string;
  name: string;
  subcategories: string[];
}

const CATEGORIES: Category[] = [
  {
    id: 'poker_history',
    name: 'Poker History',
    subcategories: [
      'Origins and evolution of poker',
      'Important dates in poker history',
      'Historic poker venues and casinos',
      'Poker in pop culture and media',
      'Evolution of online poker',
      'Historic WSOP moments',
      'Legendary poker games',
    ],
  },
  {
    id: 'famous_hands',
    name: 'Famous Hands',
    subcategories: [
      'WSOP Main Event famous hands',
      'High Stakes Poker iconic moments',
      'Poker After Dark memorable plays',
      'Bad beats and coolers',
      'Bluffs that made history',
      'Heads-up championship hands',
      'Notable tournament final table hands',
    ],
  },
  {
    id: 'player_profiles',
    name: 'Player Profiles',
    subcategories: [
      'WSOP bracelet winners',
      'Poker Hall of Fame members',
      'International poker champions',
      'Online poker legends',
      'Cash game specialists',
      'Tournament grinders',
      'Poker commentators and personalities',
    ],
  },
  {
    id: 'tournament_facts',
    name: 'Tournament Facts',
    subcategories: [
      'WSOP history and records',
      'WPT history and champions',
      'EPT and international tours',
      'High roller events',
      'Online tournament milestones',
      'Prize pool records',
      'Biggest poker tournaments ever',
    ],
  },
  {
    id: 'rule_knowledge',
    name: 'Rules & Etiquette',
    subcategories: [
      'Hand rankings and terminology',
      'Betting rules and structures',
      'Tournament rules (TDA)',
      'Cash game procedures',
      'Dealer responsibilities',
      'Poker etiquette',
      'Angle shooting and illegal moves',
    ],
  },
  {
    id: 'gto_theory',
    name: 'GTO Theory',
    subcategories: [
      'Range construction basics',
      'Pot odds and equity',
      'Position and relative position',
      'Bet sizing theory',
      'Balance and polarization',
      'Exploitative vs GTO play',
      'Solver concepts',
    ],
  },
  {
    id: 'mtt_situations',
    name: 'MTT Situations',
    subcategories: [
      'Bubble play and ICM pressure',
      'Short stack strategy (10-15BB)',
      'Medium stack strategy (25-40BB)',
      'Big stack bullying',
      'Final table dynamics',
      'Pay jump considerations',
      'Blind defense in tournaments',
      'Late registration strategy',
      'Multi-table dynamics',
      'Satellite tournament strategy',
    ],
  },
  {
    id: 'cash_game_situations',
    name: 'Cash Game Situations',
    subcategories: [
      'Deep stack postflop play (200+ BB)',
      'Set mining and implied odds',
      'Float and probe betting',
      'Stack-to-pot ratio decisions',
      '3-bet pots strategy',
      'Multi-way pot navigation',
      'Table selection and game selection',
      'Session management',
      'Exploiting recreational players',
      'Live vs online adjustments',
    ],
  },
  {
    id: 'icm_chip_ev',
    name: 'ICM & Chip EV',
    subcategories: [
      'Risk premium calculations',
      'Bubble factor adjustments',
      'Nash equilibrium push/fold',
      'Final table ICM spots',
      'Satellite ICM strategy',
      'Chip EV vs $EV differences',
      'Deal-making and ICM chops',
      'Big blind ante ICM effects',
      'Short stack ICM decisions',
      'Chip leader ICM advantages',
    ],
  },
  {
    id: 'gto_scenarios',
    name: 'GTO Scenarios',
    subcategories: [
      'Minimum defense frequency applications',
      'Polarized vs linear betting',
      'Solver-based river decisions',
      'Optimal 3-bet/4-bet frequencies',
      'Board texture and c-betting',
      'Multi-street planning',
      'Blocker effects in bluffing',
      'Node locking and exploitation',
      'Mixed strategy applications',
      'GTO vs exploitative balance',
    ],
  },
];

const DIFFICULTY_DISTRIBUTION: Record<string, number> = { easy: 25, medium: 50, hard: 25 };
const TARGET_PER_CATEGORY = 3000;
const BATCH_SIZE = 30;
const MAX_BATCHES_PER_RUN = 3;

const AG1_SYSTEM_PROMPT = `*** SYSTEM MESSAGE: ANTI-GRAVITY AGENT V12 ACTIVATED ***
*** CLASSIFICATION: ELITE STRATEGY ONLY ***
*** INTEGRITY PROTOCOL: ZERO FABRICATION ***
*** SYNC PROTOCOL: ANSWER KEY = EXPLANATION ***

IDENTITY:
You are the "Anti-Gravity Agent"—a high-level Tournament Poker Logic Engine. You do not deal in "luck," "feel," or vague definitions. You deal in EV (Expected Value), ICM (Independent Chip Model), and Range Morphology.

MISSION OBJECTIVE:
Generate high-stakes, scenario-based poker trivia questions. You must reject lazy content. Every question must be a tactical puzzle.

MANDATORY RULES OF ENGAGEMENT (The 7 Commandments):

1.  **CONTEXT IS KING (The Setup):**
    Never ask "What should you do with AK?" or "What is a donk bet?"
    ALWAYS specify the environment:
    -   **Tournament Stage:** (e.g., Bubble, Final Table, Level 1, Satellite).
    -   **Effective Stack:** (e.g., 12BB, 35BB, 100BB deep).
    -   **Position:** (e.g., Hero on CO, Villain on BTN).
    -   **The Action:** (e.g., "Villain opens 2.2x, Hero 3-bets to 8BB...").

2.  **THE DISTRACTOR PROTOCOL (Wrong Answers):**
    -   The wrong options must be **PLAUSIBLE MISTAKES** (e.g., a "Nit fold" or a "Maniac shove").
    -   Do not use joke answers (e.g., "Cry," "Flip the table," "It's all luck").
    -   Distractors should represent common leaks players actually have.

3.  **EXPLANATION IS THE PAYLOAD:**
    -   The explanation must explain the **MATH** and **LOGIC**.
    -   Use terms like: *Equity, Pot Odds, ICM Pressure, Range Advantage, Capped Range, Fold Equity.*
    -   Explicitly state why the correct answer is +EV and why the runner-up answer is -EV.
    -   ALWAYS refer to options as A, B, C, D — NEVER use zero-indexed references (0, 1, 2, 3).

4.  **ZERO FABRICATION PROTOCOL (Historical Integrity):**
    -   For historical/factual categories: NEVER invent cards, dates, dollar amounts, or player names.
    -   If you are not 100% certain of a specific fact, DO NOT include it.
    -   VERIFY BOARD PHYSICS: If you claim a hand makes a straight/flush, verify it on the board.

5.  **ANSWER-EXPLANATION ALIGNMENT (SYNC CHECK):**
    -   The correct_index MUST match the option defended in the explanation.
    -   MANDATORY PRE-OUTPUT CHECK: Read the option at correct_index. Read the first sentence of the explanation. They MUST refer to the SAME option letter and SAME action.
    -   If explanation argues Option B is correct, correct_index MUST be 1.

6.  **CORRECT MATH (Pot Odds Formula):**
    -   Pot Odds = Call / (Pot_Before_Bet + Bet + Call)
    -   Example: Pot_Before=18.5BB, Bet=10BB, Call=10BB → 10/(18.5+10+10) = 10/38.5 = ~26%
    -   The denominator is EVERYTHING in the pot after your call.
    -   DO NOT omit your call from the denominator.

7.  **STRICT JSON OUTPUT:**
    -   Output pure, unformatted JSON only. No markdown fences.

TARGET PARAMETERS:
-   Focus on creating "Trap" scenarios where the intuitive play is wrong.
-   Ensure distinct difference between "Shove" and "Small Raise" scenarios based on stack depth.
-   SPR Check: If raising creates SPR < 2, SHOVE instead.
-   10-15BB on bubble: SHOVE or FOLD — never min-raise into awkward SPR.

EXECUTE GENERATION.`;

// ─── Helpers ──────────────────────────────────────────────────────────────

interface PoolStat {
  total: number;
  easy: number;
  medium: number;
  hard: number;
  target: number;
  progress: number;
}

interface NeedItem {
  category: Category;
  difficulty: string;
  needed: number;
  priority: number;
}

async function checkForDuplicates(newQuestion: string, category: string): Promise<boolean> {
  const keywords = newQuestion
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(' ')
    .filter(w => w.length > 4)
    .slice(0, 5);

  if (keywords.length === 0) return false;

  const { data: existing } = await getSupabase()
    .from('trivia_questions')
    .select('question')
    .eq('category', category)
    .limit(500);

  if (!existing) return false;

  for (const eq of existing as { question: string }[]) {
    const existingWords = eq.question
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(' ')
      .filter(w => w.length > 4);

    const overlap = keywords.filter(k => existingWords.includes(k)).length;
    if (overlap >= 3 || (keywords.length <= 3 && overlap === keywords.length)) {
      return true;
    }
  }

  return false;
}

async function generateBatch(
  category: Category,
  subcategory: string,
  difficulty: string,
  count: number,
): Promise<TriviaQuestion[]> {
  const grok = getGrokClient();

  const prompt = `Generate exactly ${count} unique poker trivia questions.

CATEGORY: ${category.name}
TOPIC FOCUS: ${subcategory}
DIFFICULTY: ${difficulty}

${difficulty === 'easy' ? 'DIFFICULTY LEVEL: Clear-cut situations. The correct play is well-established.' : ''}
${difficulty === 'medium' ? 'DIFFICULTY LEVEL: Multiple options are plausible but one is clearly best.' : ''}
${difficulty === 'hard' ? 'DIFFICULTY LEVEL: "Trap" scenarios where the intuitive play is WRONG. Expert-level.' : ''}

CRITICAL REMINDERS:
- Every wrong answer must be a PLAUSIBLE MISTAKE a real player would make — NO joke answers
- Explanations must include MATH and LOGIC (equity %, pot odds, fold equity, ICM pressure)
- RANDOMIZE which option (A/B/C/D) is correct — distribute evenly
- Each question must be completely unique — no duplicate scenarios

Return ONLY valid JSON:
{"questions":[{"question":"...","options":["A","B","C","D"],"correct_index":0,"explanation":"...","subcategory":"${subcategory}"}]}`;

  try {
    const response = await grok.chat.completions.create({
      model: 'grok-3',
      messages: [
        { role: 'system', content: AG1_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.85,
      max_tokens: 8000,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('No content in Grok response');

    const parsed = JSON.parse(content);
    const questions: any[] = Array.isArray(parsed) ? parsed : parsed.questions || [];

    return questions
      .filter(q =>
        q.question &&
        q.options?.length === 4 &&
        typeof q.correct_index === 'number' &&
        q.correct_index >= 0 && q.correct_index <= 3 &&
        q.explanation &&
        q.explanation.length > 50,
      )
      .map(q => ({
        category: category.id,
        difficulty,
        question: q.question.trim(),
        options: q.options.map((o: string) => o.trim()),
        correct_index: q.correct_index,
        explanation: q.explanation.trim(),
        subcategory,
        created_at: new Date().toISOString(),
        last_used_at: null,
      }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[AG-1 Pool] Generation error for ${category.name}/${subcategory}:`, msg);
    return [];
  }
}

async function getPoolStats(): Promise<Record<string, PoolStat>> {
  const stats: Record<string, PoolStat> = {};

  for (const cat of CATEGORIES) {
    const { count: total } = await getSupabase()
      .from('trivia_questions')
      .select('*', { count: 'exact', head: true })
      .eq('category', cat.id)
      .limit(100);

    const { count: easy } = await getSupabase()
      .from('trivia_questions')
      .select('*', { count: 'exact', head: true })
      .eq('category', cat.id)
      .eq('difficulty', 'easy')
      .limit(100);

    const { count: medium } = await getSupabase()
      .from('trivia_questions')
      .select('*', { count: 'exact', head: true })
      .eq('category', cat.id)
      .eq('difficulty', 'medium')
      .limit(100);

    const { count: hard } = await getSupabase()
      .from('trivia_questions')
      .select('*', { count: 'exact', head: true })
      .eq('category', cat.id)
      .eq('difficulty', 'hard')
      .limit(100);

    stats[cat.id] = {
      total: total ?? 0,
      easy: easy ?? 0,
      medium: medium ?? 0,
      hard: hard ?? 0,
      target: TARGET_PER_CATEGORY,
      progress: Math.round(((total ?? 0) / TARGET_PER_CATEGORY) * 100),
    };
  }

  return stats;
}

function determineNeededQuestions(stats: Record<string, PoolStat>): NeedItem[] {
  const needs: NeedItem[] = [];

  for (const cat of CATEGORIES) {
    const catStats = stats[cat.id];
    if (!catStats || catStats.total >= TARGET_PER_CATEGORY) continue;

    const totalNeeded = TARGET_PER_CATEGORY - catStats.total;

    for (const [diff, targetPercent] of Object.entries(DIFFICULTY_DISTRIBUTION)) {
      const targetCount = Math.floor(TARGET_PER_CATEGORY * (targetPercent / 100));
      const currentCount = (catStats[diff as keyof PoolStat] as number) ?? 0;
      const needed = Math.max(0, targetCount - currentCount);

      if (needed > 0) {
        needs.push({
          category: cat,
          difficulty: diff,
          needed,
          priority: needed / totalNeeded,
        });
      }
    }
  }

  return needs.sort((a, b) => b.priority - a.priority);
}

// ─── Hono handler ─────────────────────────────────────────────────────────

export async function generateTriviaQuestions(c: Context) {
  try {
    const stats = await getPoolStats();
    const totalQuestions = Object.values(stats).reduce((sum, s) => sum + s.total, 0);
    const targetTotal = CATEGORIES.length * TARGET_PER_CATEGORY;

    if (totalQuestions >= targetTotal) {
      return c.json({
        success: true,
        message: 'Question pool is complete!',
        stats,
        totalQuestions,
        targetTotal,
      });
    }

    const needs = determineNeededQuestions(stats);

    if (needs.length === 0) {
      return c.json({
        success: true,
        message: 'All categories balanced',
        stats,
      });
    }

    let generated = 0;
    const results: Array<{ category: string; subcategory: string; difficulty: string; generated: number }> = [];

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN && needs.length > 0; batch++) {
      const need = needs[batch % needs.length];
      if (!need) break;

      const subcategory = need.category.subcategories[
        Math.floor(Math.random() * need.category.subcategories.length)
      ]!;

      const batchCount = Math.min(BATCH_SIZE, need.needed);

      const questions = await generateBatch(need.category, subcategory, need.difficulty, batchCount);

      if (questions.length > 0) {
        const uniqueQuestions: TriviaQuestion[] = [];
        for (const q of questions) {
          const isDupe = await checkForDuplicates(q.question, need.category.id);
          if (!isDupe) uniqueQuestions.push(q);
        }

        if (uniqueQuestions.length > 0) {
          const { valid: validQuestions, rejected } = validateBatch(uniqueQuestions);
          if (rejected.length > 0) {
            for (const r of rejected) {
              for (const e of r.errors) console.warn(`  → ${e}`);
            }
          }

          if (validQuestions.length > 0) {
            const { data, error } = await getSupabase()
              .from('trivia_questions')
              .insert(validQuestions)
              .select();

            if (error) {
              console.warn('[Question Pool] Insert error:', error);
            } else {
              generated += data?.length ?? 0;
              results.push({
                category: need.category.name,
                subcategory,
                difficulty: need.difficulty,
                generated: data?.length ?? 0,
              });
            }
          }
        }
      }

      if (batch < MAX_BATCHES_PER_RUN - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    const updatedStats = await getPoolStats();
    const newTotal = Object.values(updatedStats).reduce((sum, s) => sum + s.total, 0);

    return c.json({
      success: true,
      message: `Generated ${generated} new questions`,
      results,
      previousTotal: totalQuestions,
      newTotal,
      targetTotal,
      progress: `${Math.round((newTotal / targetTotal) * 100)}%`,
      stats: updatedStats,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[generate-trivia-questions] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
