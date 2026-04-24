/**
 * GET /cron/clawbot-orchestrator
 *
 * Ported from pages/api/clawbot/orchestrator.js in World Hub (2026-04-24).
 *
 * Daily at 07:00 UTC: dispatches to enabled ClawBot task endpoints.
 * Each task is self-contained and lives at its own URL on World Hub —
 * currently only cb-01-sentry-triage is enabled.
 *
 * Idempotence: the orchestrator calls sub-tasks via HTTP. Sub-tasks are
 * responsible for their own dedup. Running the orchestrator twice just
 * means sub-tasks get called twice; their internal guards should catch it.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { logAudit, CLAWBOT_VERSION } from '../lib/clawbot-audit.js';

// Task registry — mirrors monolith's TASK_REGISTRY.
// The endpoint is relative to WORLD_HUB_URL; sub-tasks still live in the
// monolith until they're separately ported.
const TASK_REGISTRY: Array<{
  id: string;
  name: string;
  endpoint: string;
  enabled: boolean;
}> = [
  { id: 'cb-01-sentry-triage', name: 'Sentry Error Triage', endpoint: '/api/clawbot/sentry-triage', enabled: true },
];

interface TaskResult {
  task_id: string;
  name: string;
  status: 'success' | 'failed' | 'error';
  http_status?: number;
  duration_ms?: number;
  summary?: unknown;
  error?: string;
}

export async function clawbotOrchestrator(c: Context) {
  const startTime = Date.now();
  await logAudit('orchestrator', 'orchestrator_started', {
    version: CLAWBOT_VERSION,
    tasks_registered: TASK_REGISTRY.length,
    tasks_enabled: TASK_REGISTRY.filter((t) => t.enabled).length,
  });

  const baseUrl = process.env.WORLD_HUB_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://smarter.poker';
  const authHeader = c.req.header('Authorization') ?? '';

  const results: TaskResult[] = [];
  const enabled = TASK_REGISTRY.filter((t) => t.enabled);

  for (const task of enabled) {
    const taskUrl = `${baseUrl}${task.endpoint}`;
    console.log(`[clawbot-orchestrator] dispatching: ${task.name} → ${taskUrl}`);
    const taskStart = Date.now();

    try {
      const response = await fetch(taskUrl, {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          'x-clawbot-orchestrator': 'true',
        },
      });

      let body: { data?: { summary?: unknown }; summary?: unknown; error?: string } = {};
      try {
        body = await response.json();
      } catch {
        body = { error: 'Failed to parse response' };
      }

      results.push({
        task_id: task.id,
        name: task.name,
        status: response.ok ? 'success' : 'failed',
        http_status: response.status,
        duration_ms: Date.now() - taskStart,
        summary: body?.data?.summary ?? body?.summary ?? (response.ok ? 'OK' : body?.error),
      });
    } catch (err) {
      results.push({
        task_id: task.id,
        name: task.name,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const totalDuration = Date.now() - startTime;
  const successCount = results.filter((r) => r.status === 'success').length;
  const failCount = results.length - successCount;

  await logAudit('orchestrator', 'orchestrator_completed', {
    duration_ms: totalDuration,
    tasks_run: results.length,
    successes: successCount,
    failures: failCount,
  });

  return c.json({
    success: true,
    version: CLAWBOT_VERSION,
    duration_ms: totalDuration,
    summary: `${successCount}/${enabled.length} tasks succeeded`,
    results,
  });
}
