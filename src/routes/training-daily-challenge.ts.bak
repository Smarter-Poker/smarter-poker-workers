/**
 * GET/POST /cron/training-daily-challenge
 *
 * Ported from pages/api/cron/training-daily-challenge.js (206 lines).
 *
 * Daily 06:05 UTC: generate a training_daily_challenges row with a
 * Grok-generated community scenario shared across all users.
 *
 * Idempotent — early exit if today's row exists. Grok failure is
 * non-fatal: row still created with community_scenario=null.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { getGrokClient } from '../lib/grok.js';

const CATEGORIES = ['MTT', 'CASH', 'ADVANCED', 'SPINS', 'PSYCHOLOGY'] as const;
type Category = typeof CATEGORIES[number];

const CHALLENGE_GAMES: Record<Category, string[]> = {
  MTT: ['mtt-004', 'mtt-010', 'mtt-013', 'mtt-015', 'mtt-021'],
  CASH: ['cash-005', 'cash-008', 'cash-012', 'cash-014', 'cash-021'],
  ADVANCED: ['adv-002', 'adv-005', 'adv-007', 'adv-014', 'adv-018'],
  SPINS: ['spins-002', 'spins-005', 'spins-007', 'spins-010'],
  PSYCHOLOGY: ['psy-003', 'psy-004', 'psy-007', 'psy-016', 'psy-020'],
};

const GAME_TYPE_MAP: Record<Category, string> = {
  MTT: 'deep-stack MTT tournament',
  CASH: '6-max high-stakes cash game',
  ADVANCED: 'advanced mixed-game (PLO/MTT)',
  SPINS: '3-max hyper-turbo Spin & Go',
  PSYCHOLOGY: 'high-pressure final table',
};

async function generateCommunityScenario(
  category: Category,
  level: number,
  date: string,
): Promise<unknown | null> {
  const grok = getGrokClient();
  const gameType = GAME_TYPE_MAP[category];

  const prompt = `Create a challenging GTO poker scenario for today's GLOBAL COMMUNITY CHALLENGE.

DATE: ${date}
CATEGORY: ${category}
GAME TYPE: ${gameType}
DIFFICULTY: ${level}/10 (expert level - all community members compete)

Requirements:
1. This SAME scenario will be played by ALL users worldwide
2. Must be genuinely difficult and test advanced concepts
3. Include a clear GTO-optimal answer with solver reasoning
4. Make it memorable and discussion-worthy

Generate in this EXACT JSON format:
{
    "title": "Community Challenge: [Catchy title for this spot]",
    "question": "Detailed scenario question",
    "scenario": {
        "heroPosition": "[Position]",
        "heroHand": "[Specific hand]",
        "heroStack": [Stack in bb],
        "villainPosition": "[Position]",
        "villainStack": [Stack in bb],
        "board": "[Board cards or 'Preflop']",
        "pot": [Pot in bb],
        "action": "[What villain just did]",
        "context": "[Any additional context like 'bubble of WSOP ME']"
    },
    "options": [
        {"id": "a", "text": "[Option]", "frequency": "[GTO frequency %]"},
        {"id": "b", "text": "[Option]", "frequency": "[GTO frequency %]"},
        {"id": "c", "text": "[Option]", "frequency": "[GTO frequency %]"},
        {"id": "d", "text": "[Option]", "frequency": "[GTO frequency %]"}
    ],
    "correctAnswer": "[letter]",
    "explanation": "Detailed solver explanation with EV and range analysis",
    "discussionPoints": ["Point 1", "Point 2", "Point 3"]
}`;

  const response = await grok.chat.completions.create({
    model: 'grok-3',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.85,
    max_tokens: 800,
  });

  const content = response.choices[0]?.message?.content ?? '';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
  return null;
}

export async function trainingDailyChallenge(c: Context) {
  try {
    const supabase = getSupabase();
    const today = new Date();
    const challengeDate = today.toISOString().split('T')[0]!;

    const { data: existing } = await supabase
      .from('training_daily_challenges')
      .select('id')
      .eq('challenge_date', challengeDate)
      .maybeSingle();

    if (existing) {
      return c.json({
        success: true,
        message: 'Challenge already exists for today',
        date: challengeDate,
      });
    }

    const dayOfWeek = today.getDay();
    const selectedCategory = CATEGORIES[dayOfWeek % CATEGORIES.length] as Category;
    const categoryGames = CHALLENGE_GAMES[selectedCategory];
    const randomIndex = Math.floor(Math.random() * categoryGames.length);
    const selectedGameId = categoryGames[randomIndex] ?? categoryGames[0]!;
    const level = 5 + Math.floor(Math.random() * 4);

    let communityScenario: unknown = null;
    try {
      communityScenario = await generateCommunityScenario(selectedCategory, level, challengeDate);
    } catch (grokError) {
      console.warn(
        '[training-daily-challenge] Grok generation failed (non-fatal):',
        grokError instanceof Error ? grokError.message : grokError,
      );
    }

    const { data: challenge, error } = await supabase
      .from('training_daily_challenges')
      .insert({
        challenge_date: challengeDate,
        game_id: selectedGameId,
        level,
        required_accuracy: 80,
        bonus_xp_multiplier: 2.0,
        bonus_diamonds: 50,
        community_scenario: communityScenario,
      })
      .select()
      .maybeSingle();

    if (error || !challenge) {
      console.warn('[training-daily-challenge] insert error:', error?.message);
      return c.json(
        { error: 'Failed to create challenge', details: error?.message ?? 'No data returned' },
        500,
      );
    }

    return c.json({
      success: true,
      message: 'Daily community challenge created',
      challenge: {
        date: challengeDate,
        gameId: selectedGameId,
        level,
        category: selectedCategory,
        hasCommunityScenario: communityScenario !== null,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[training-daily-challenge] fatal:', msg);
    return c.json({ error: 'Internal server error', details: msg }, 500);
  }
}
