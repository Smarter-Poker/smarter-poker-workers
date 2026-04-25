/**
 * GET/POST /cron/training-daily-report
 *
 * Ported from pages/api/cron/training-daily-report.js (192 lines).
 *
 * Daily 08:00 UTC: read jarvis_training_sessions over the last 24h,
 * group by user_id, generate a personalized Grok coaching report per
 * user, upsert into jarvis_weekly_reports ON CONFLICT (user_id,
 * report_week). Despite the legacy "week" column name, the report is
 * keyed by date.
 *
 * Idempotent: same window + same data → same Grok prompt input →
 * upsert overwrites with fresh analysis. Repeated runs cost more
 * Grok tokens but don't corrupt state.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { getGrokClient } from '../lib/grok.js';

interface TrainingSession {
  user_id: string;
  game_id: string | null;
  category: string | null;
  accuracy: number | null;
  questions_answered: number;
  questions_correct: number;
  answers_data: unknown;
  leaks_detected: string[] | null;
}

interface ReportData {
  leaks: string[];
  improvements: string[];
  recommendations: string[];
  analysis: string;
}

function calculateAverageAccuracy(sessions: TrainingSession[]): number {
  const total = sessions.reduce((sum, s) => sum + (s.questions_answered ?? 0), 0);
  const correct = sessions.reduce((sum, s) => sum + (s.questions_correct ?? 0), 0);
  return total > 0 ? (correct / total) * 100 : 0;
}

async function generateWeeklyReport(
  sessions: TrainingSession[],
  _userId: string,
): Promise<ReportData> {
  const totalQuestions = sessions.reduce((sum, s) => sum + (s.questions_answered ?? 0), 0);
  const totalCorrect = sessions.reduce((sum, s) => sum + (s.questions_correct ?? 0), 0);
  const avgAccuracy =
    totalQuestions > 0 ? ((totalCorrect / totalQuestions) * 100).toFixed(1) : '0';

  const allLeaks = sessions.flatMap((s) => s.leaks_detected ?? []);
  const categories = [...new Set(sessions.map((s) => s.category).filter((c): c is string => !!c))];

  const prompt = `You are Jarvis, the personal poker AI coach. Generate a weekly training report.

USER'S WEEK:
- Sessions: ${sessions.length}
- Questions Answered: ${totalQuestions}
- Correct Answers: ${totalCorrect}
- Accuracy: ${avgAccuracy}%
- Categories Trained: ${categories.join(', ')}
- Detected Leaks: ${allLeaks.slice(0, 5).join(', ') || 'None'}

Generate a personalized weekly coaching report in JSON:
{
    "leaks": ["Top 3 most important leaks to fix"],
    "improvements": ["Areas where they improved this week"],
    "recommendations": ["3 specific drills or games to play next week"],
    "analysis": "2-3 sentence personalized coaching message"
}

Be encouraging but specific. Reference their actual performance.`;

  try {
    const grok = getGrokClient();
    const response = await grok.chat.completions.create({
      model: 'grok-3',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 400,
    });

    const content = response.choices[0]?.message?.content ?? '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch && jsonMatch[0]) {
      const parsed = JSON.parse(jsonMatch[0]) as Partial<ReportData>;
      return {
        leaks: Array.isArray(parsed.leaks) ? parsed.leaks : allLeaks.slice(0, 3),
        improvements: Array.isArray(parsed.improvements) ? parsed.improvements : [],
        recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
        analysis: typeof parsed.analysis === 'string' ? parsed.analysis : '',
      };
    }
  } catch (err) {
    console.warn(
      '[training-daily-report] Grok error:',
      err instanceof Error ? err.message : err,
    );
  }

  // Fallback
  const accuracyNum = parseFloat(avgAccuracy);
  return {
    leaks: allLeaks.slice(0, 3),
    improvements: accuracyNum >= 70 ? ['Overall accuracy is solid'] : ['Keep practicing!'],
    recommendations: ['Continue with your current training games'],
    analysis: `You completed ${sessions.length} training sessions this week with ${avgAccuracy}% accuracy. ${accuracyNum >= 70 ? 'Great progress!' : 'Keep working on the fundamentals.'}`,
  };
}

export async function trainingDailyReport(c: Context) {
  try {
    const supabase = getSupabase();

    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setHours(dayStart.getHours() - 24);
    const reportDate = now.toISOString().split('T')[0]!;
    const reportWeek = reportDate;

    const { data: sessionsData, error: sessionsError } = await supabase
      .from('jarvis_training_sessions')
      .select(
        'user_id, game_id, category, accuracy, questions_answered, questions_correct, answers_data, leaks_detected',
      )
      .gte('created_at', dayStart.toISOString())
      .order('user_id')
      .limit(100);

    if (sessionsError) {
      console.warn('[training-daily-report] sessions fetch error:', sessionsError.message);
      return c.json({ error: sessionsError.message }, 500);
    }

    const sessions = (sessionsData ?? []) as TrainingSession[];

    if (sessions.length === 0) {
      return c.json({
        success: true,
        message: 'No training sessions this week',
        reportsGenerated: 0,
      });
    }

    const userSessions: Record<string, TrainingSession[]> = {};
    for (const session of sessions) {
      if (!userSessions[session.user_id]) userSessions[session.user_id] = [];
      userSessions[session.user_id]!.push(session);
    }

    let reportsGenerated = 0;

    for (const [userId, userSessionList] of Object.entries(userSessions)) {
      try {
        const report = await generateWeeklyReport(userSessionList, userId);

        await supabase
          .from('jarvis_weekly_reports')
          .upsert(
            {
              user_id: userId,
              report_week: reportWeek,
              sessions_count: userSessionList.length,
              questions_count: userSessionList.reduce(
                (sum, s) => sum + (s.questions_answered ?? 0),
                0,
              ),
              accuracy: calculateAverageAccuracy(userSessionList),
              primary_leaks: report.leaks,
              improvements: report.improvements,
              recommendations: report.recommendations,
              grok_analysis: report.analysis,
              created_at: new Date().toISOString(),
            },
            { onConflict: 'user_id,report_week' },
          );

        reportsGenerated++;
      } catch (err) {
        console.warn(
          `[training-daily-report] error for user ${userId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return c.json({
      success: true,
      message: 'Weekly reports generated',
      reportsGenerated,
      reportWeek,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[training-daily-report] fatal:', msg);
    return c.json({ error: msg }, 500);
  }
}
