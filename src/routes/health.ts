import type { Context } from 'hono';
import { tournamentReminderWorker } from '../lib/tournamentReminderWorker.js';

const START_TIME = Date.now();

export async function health(c: Context) {
  return c.json({
    status: 'ok',
    tournamentReminders: tournamentReminderWorker.snapshot(),
    service: 'smarter-poker-workers',
    version: process.env.GIT_SHA ?? 'dev',
    uptime_s: Math.floor((Date.now() - START_TIME) / 1000),
    node: process.version,
    env: process.env.NODE_ENV ?? 'development',
    timestamp: new Date().toISOString(),
    memory: {
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  });
}
