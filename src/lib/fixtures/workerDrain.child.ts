import { appendFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { WorkerDrain, installWorkerShutdown } from '../workerDrain.js';

const drain = new WorkerDrain();
const app = new Hono();
const messages = new Map<string, () => void>();
function barrier(name: string) {
  return new Promise<void>((resolve) => messages.set(name, resolve));
}
process.on('message', (message) => {
  if (typeof message === 'string') messages.get(message)?.();
});
const record = (name: string) => appendFile(process.env.DRAIN_RECORD!, name + '\n');
app.get('/work', async () => {
  const release = barrier('release');
  process.send?.('accepted');
  await release;
  await record('job');
  const receipt = barrier('receipt');
  drain.track(receipt.then(() => record('receipt')));
  process.send?.('job-finished');
  return new Response('completed');
});
const server = serve({
  hostname: '127.0.0.1', port: 0,
  fetch: (request, env) => drain.fetch(() => app.fetch(request, env)),
}, (info) => process.send?.({ port: info.port }));
if (process.env.DRAIN_LEGACY === '1') {
  // Exact predecessor behavior: flush telemetry then exit, with no job drain.
  process.on('SIGTERM', () => { void Promise.resolve().then(() => process.exit(0)); });
} else installWorkerShutdown(server, drain,
  () => {
    if (process.env.DRAIN_STOP_FAIL === '1') throw new Error('background stop failed');
    process.send?.('stopping');
  }, Number(process.env.DRAIN_DEADLINE || '5000'));
