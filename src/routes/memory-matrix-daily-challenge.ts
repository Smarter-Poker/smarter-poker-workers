/**
 * GET/POST /cron/memory-matrix-daily-challenge
 *
 * Ported from pages/api/cron/memory-matrix-daily-challenge.js (356 lines).
 *
 * Daily 00:00 UTC: generate one row in memory_daily_challenges with a
 * Grok-generated GTO range scenario. Level scales with day-of-month
 * (1-10). Weekend bumps target_accuracy and rewards.
 *
 * Idempotent — early exit if today's challenge_date row exists. Grok
 * failure falls back to a deterministic scenario keyed by (level,
 * position, stackDepth, scenarioType) so the row still gets written.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { getGrokClient } from '../lib/grok.js';

type Level = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

const POSITION_CONFIGS: Record<Level, string[]> = {
  1: ['UTG', 'MP', 'HJ'],
  2: ['UTG', 'MP', 'HJ', 'CO'],
  3: ['UTG', 'MP', 'HJ', 'CO', 'BTN'],
  4: ['CO', 'BTN', 'SB', 'BB'],
  5: ['UTG', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  6: ['CO', 'BTN', 'SB', 'BB'],
  7: ['SB', 'BB'],
  8: ['UTG', 'MP', 'HJ', 'CO', 'BTN'],
  9: ['BTN', 'SB', 'BB'],
  10: ['UTG', 'CO', 'BTN', 'BB'],
};

const STACK_DEPTHS: Record<Level, number[]> = {
  1: [100],
  2: [100, 50],
  3: [100, 50, 200],
  4: [100, 50, 30],
  5: [100, 50, 200, 30],
  6: [100, 50, 30],
  7: [20, 25, 30],
  8: [100, 200, 150],
  9: [30, 40, 50],
  10: [100, 200, 30, 50],
};

const SCENARIO_TYPES: Record<Level, string[]> = {
  1: ['Open Raise Range'],
  2: ['Open Raise Range', '3-Bet Defense'],
  3: ['Open Raise Range', '3-Bet Defense', 'Squeeze Range'],
  4: ['3-Bet Range', 'vs 4-Bet', 'Blind vs Blind'],
  5: ['Open Raise Range', 'Squeeze Range', 'vs 4-Bet'],
  6: ['3-Bet Range', 'Cold 4-Bet', 'Mixed Frequency'],
  7: ['Push/Fold', 'ICM Spots', 'Bubble Play'],
  8: ['Deep Stack 3-Bet', 'Pot Control'],
  9: ['Final Table ICM', 'Short Stack Play'],
  10: ['Expert Mixed', 'GTO vs Exploit'],
};

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const;
type Rank = typeof RANKS[number];

interface Scenario {
  id: string;
  level: number;
  title: string;
  position: string;
  stackDepth: number;
  description: string;
  tip: string;
  solution: Record<string, string>;
}

function pickRandom<T>(arr: readonly T[]): T {
  if (arr.length === 0) throw new Error('pickRandom: empty array');
  const i = Math.floor(Math.random() * arr.length);
  return arr[i] ?? arr[0]!;
}

function dayLevel(dayOfMonth: number): Level {
  let level: number;
  if (dayOfMonth <= 3) level = Math.min(dayOfMonth, 3);
  else if (dayOfMonth <= 10) level = Math.min(3 + Math.floor((dayOfMonth - 3) / 2), 6);
  else if (dayOfMonth <= 20) level = Math.min(5 + Math.floor((dayOfMonth - 10) / 3), 8);
  else if (dayOfMonth <= 28) level = Math.min(7 + Math.floor((dayOfMonth - 20) / 3), 9);
  else level = 10;
  return Math.max(1, Math.min(10, level)) as Level;
}

function buildScenarioPrompt(
  level: number,
  position: string,
  stackDepth: number,
  scenarioType: string,
): string {
  const difficultyDescriptions: Record<number, string> = {
    1: 'Beginner - Simple, clear ranges',
    2: 'Beginner+ - Slightly wider ranges',
    3: 'Intermediate - Multiple positions',
    4: 'Intermediate+ - 4-bet pots',
    5: 'Advanced - Full position awareness',
    6: 'Advanced+ - Complex 3-bet trees',
    7: 'Expert - MTT/ICM considerations',
    8: 'Expert+ - Deep stack play',
    9: 'Master - Final table ICM',
    10: 'GTO Master - Mixed strategies',
  };

  return `Generate a GTO poker DAILY CHALLENGE scenario:

Level: ${level} (${difficultyDescriptions[level] ?? 'Advanced'})
Position: ${position}
Stack Depth: ${stackDepth}bb
Scenario Type: ${scenarioType}

Create a unique, engaging challenge in this JSON format:
{
    "id": "daily-${Date.now()}",
    "level": ${level},
    "title": "[Creative, descriptive title - make it sound exciting!]",
    "position": "${position}",
    "stackDepth": ${stackDepth},
    "description": "[2-3 sentences about this spot and what makes it interesting]",
    "tip": "[Helpful memory tip for this range]",
    "solution": {
        [Map of hands to actions: "AA": "raise", "AKs": "raise", etc.]
        [Include ${15 + level * 3}-${20 + level * 5} hands]
        [Actions: "raise", "call", "3bet", "fold", or mixed like "raise70"]
    }
}

Make it fresh and unique for today! Return ONLY the JSON.`;
}

function isRank(c: string): c is Rank {
  return (RANKS as readonly string[]).includes(c);
}

function normalizeHandNotation(hand: unknown): string | null {
  if (!hand || typeof hand !== 'string') return null;
  const upper = hand.toUpperCase().trim();
  const c0 = upper[0];
  const c1 = upper[1];
  const c2 = upper[2];

  if (upper.length === 2 && c0 && c1 && isRank(c0) && c0 === c1) return upper;

  if (upper.length === 3 && c0 && c1 && c2 && isRank(c0) && isRank(c1)) {
    const suffix = c2.toLowerCase();
    if (suffix === 's' || suffix === 'o') return c0 + c1 + suffix;
  }

  if (upper.length === 2 && c0 && c1 && isRank(c0) && isRank(c1)) {
    if (c0 === c1) return upper;
    return upper + 's';
  }

  return null;
}

function isValidAction(action: unknown): boolean {
  if (!action || typeof action !== 'string') return false;
  const lower = action.toLowerCase();
  if (['raise', 'call', '3bet', '4bet', 'fold', 'check', 'allin', 'jam'].includes(lower)) {
    return true;
  }
  return /^(raise|call|3bet|4bet|fold|check)\d+$/.test(lower);
}

function validateScenario(
  raw: Record<string, unknown>,
  level: number,
  position: string,
  stackDepth: number,
): Scenario {
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `daily-${Date.now()}`;
  const lvl = typeof raw.level === 'number' ? raw.level : level;
  const pos = typeof raw.position === 'string' && raw.position ? raw.position : position;
  const sd = typeof raw.stackDepth === 'number' ? raw.stackDepth : stackDepth;
  const title = typeof raw.title === 'string' ? raw.title : `${pos} ${sd}bb Challenge`;
  const description = typeof raw.description === 'string' ? raw.description : '';
  const tip = typeof raw.tip === 'string' ? raw.tip : '';

  const validatedSolution: Record<string, string> = {};
  const rawSolution = raw.solution;
  if (rawSolution && typeof rawSolution === 'object') {
    for (const [hand, action] of Object.entries(rawSolution as Record<string, unknown>)) {
      const normalizedHand = normalizeHandNotation(hand);
      if (normalizedHand && isValidAction(action)) {
        validatedSolution[normalizedHand] = String(action);
      }
    }
  }

  return {
    id,
    level: lvl,
    title,
    position: pos,
    stackDepth: sd,
    description,
    tip,
    solution: validatedSolution,
  };
}

function createFallbackScenario(
  level: number,
  position: string,
  stackDepth: number,
  scenarioType: string,
): Scenario {
  const basicSolutions: Record<number, Record<string, string>> = {
    1: { AA: 'raise', KK: 'raise', QQ: 'raise', JJ: 'raise', TT: 'raise', AKs: 'raise', AQs: 'raise', AKo: 'raise' },
    2: {
      AA: 'raise', KK: 'raise', QQ: 'raise', JJ: 'raise', TT: 'raise', '99': 'raise',
      AKs: 'raise', AQs: 'raise', AJs: 'raise', AKo: 'raise', AQo: 'raise',
    },
    3: {
      AA: 'raise', KK: 'raise', QQ: 'raise', JJ: 'raise', TT: 'raise', '99': 'raise', '88': 'raise',
      AKs: 'raise', AQs: 'raise', AJs: 'raise', ATs: 'raise', KQs: 'raise', AKo: 'raise', AQo: 'raise',
    },
  };
  const solution = basicSolutions[Math.min(level, 3)] ?? basicSolutions[3]!;

  return {
    id: `fallback-${Date.now()}`,
    level,
    title: `${position} ${scenarioType} (${stackDepth}bb)`,
    position,
    stackDepth,
    description: `Practice your ${scenarioType.toLowerCase()} from ${position} position with a ${stackDepth}bb stack.`,
    tip: 'Focus on premium hands and position-appropriate raises.',
    solution,
  };
}

async function generateGrokScenario(
  level: number,
  position: string,
  stackDepth: number,
  scenarioType: string,
): Promise<Scenario> {
  try {
    const grok = getGrokClient();
    const prompt = buildScenarioPrompt(level, position, stackDepth, scenarioType);

    const completion = await grok.chat.completions.create({
      model: 'grok-3',
      messages: [
        {
          role: 'system',
          content: `You are a GTO poker expert creating daily training challenges. Your solutions must be solver-accurate. Respond with valid JSON only.`,
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 2000,
    });

    const responseText = completion.choices[0]?.message?.content;
    if (!responseText) throw new Error('Empty response from Grok');

    const cleanedResponse = responseText
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    const parsed = JSON.parse(cleanedResponse) as Record<string, unknown>;
    return validateScenario(parsed, level, position, stackDepth);
  } catch (err) {
    console.warn(
      '[memory-matrix-daily-challenge] Grok generation failed, using fallback:',
      err instanceof Error ? err.message : err,
    );
    return createFallbackScenario(level, position, stackDepth, scenarioType);
  }
}

export async function memoryMatrixDailyChallenge(c: Context) {
  try {
    const supabase = getSupabase();
    const today = new Date();
    const challengeDate = today.toISOString().split('T')[0]!;

    const { data: existing } = await supabase
      .from('memory_daily_challenges')
      .select('id')
      .eq('challenge_date', challengeDate)
      .maybeSingle();

    if (existing) {
      return c.json({
        message: 'Daily challenge already exists for today',
        challengeDate,
        id: (existing as { id: string }).id,
      });
    }

    const dayOfMonth = today.getDate();
    const level = dayLevel(dayOfMonth);
    const dayOfWeek = today.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const targetAccuracy = isWeekend ? 90 : 85;
    const diamondReward = isWeekend ? 75 : 50;
    const bonusReward = isWeekend ? 150 : 100;

    const positions = POSITION_CONFIGS[level];
    const depths = STACK_DEPTHS[level];
    const types = SCENARIO_TYPES[level];

    const position = pickRandom(positions);
    const stackDepth = pickRandom(depths);
    const scenarioType = pickRandom(types);

    const scenario = await generateGrokScenario(level, position, stackDepth, scenarioType);

    const { data: challengeData, error } = await supabase
      .from('memory_daily_challenges')
      .insert({
        challenge_date: challengeDate,
        game_mode: 'range',
        level,
        scenario_id: JSON.stringify(scenario),
        target_accuracy: targetAccuracy,
        target_time: 90 + (10 - level) * 10,
        diamond_reward: diamondReward,
        bonus_reward: bonusReward,
      })
      .select()
      .maybeSingle();

    if (error || !challengeData) {
      const errMsg = error?.message ?? 'No data returned from insert';
      console.warn('[memory-matrix-daily-challenge] insert error:', errMsg);
      return c.json({ error: errMsg }, 500);
    }

    const challenge = challengeData as { id: string };
    return c.json({
      success: true,
      challenge: {
        id: challenge.id,
        date: challengeDate,
        level,
        title: scenario.title,
        position,
        stackDepth,
        targetAccuracy,
        diamondReward,
        bonusReward,
        isWeekend,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[memory-matrix-daily-challenge] fatal:', msg);
    return c.json({ error: msg }, 500);
  }
}
