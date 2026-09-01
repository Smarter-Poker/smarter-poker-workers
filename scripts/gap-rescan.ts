/**
 * One-shot driver for re-running an integrity sweep over a historical window.
 *
 * Exists because the 2026-08-31/09-01 CRON_SECRET outage left a window that no
 * scheduled run would ever look at again. Invoked by hand, never scheduled.
 *
 *   npx tsx scripts/gap-rescan.ts <route> <since> <until> [--write]
 *
 * Defaults to dry run. --write is required to persist findings.
 */
import type { Context } from 'hono';
import { collusionScan } from '../src/routes/collusion-scan.js';
import { antiCheatChipDump } from '../src/routes/anti-cheat-chip-dump.js';
import { antiCheatMultiAccount } from '../src/routes/anti-cheat-multi-account.js';
import { antiCheatBotTiming } from '../src/routes/anti-cheat-bot-timing.js';

const ROUTES: Record<string, (c: Context) => Promise<unknown>> = {
  'collusion-scan': collusionScan as never,
  'anti-cheat-chip-dump': antiCheatChipDump as never,
  'anti-cheat-multi-account': antiCheatMultiAccount as never,
  'anti-cheat-bot-timing': antiCheatBotTiming as never,
};

const [route, since, until] = process.argv.slice(2);
const write = process.argv.includes('--write');
const handler = route ? ROUTES[route] : undefined;
if (!handler || !since) {
  console.error(`usage: gap-rescan.ts <${Object.keys(ROUTES).join('|')}> <since> [until] [--write]`);
  process.exit(2);
}

const query: Record<string, string> = { since };
if (until && !until.startsWith('--')) query.until = until;
if (!write) query.dry_run = '1';

let captured: unknown = null;
const ctx = {
  req: { method: 'GET', query: () => query, json: async () => ({}) },
  json: (body: unknown, status?: number) => {
    captured = { status: status ?? 200, body };
    return captured;
  },
} as unknown as Context;

await handler(ctx);
console.log(JSON.stringify(captured, null, 2));
