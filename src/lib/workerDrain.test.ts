import { afterEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { request, type ClientRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerDrain } from './workerDrain.js';

const children: ChildProcess[] = [];
const directories: string[] = [];
const requests: ClientRequest[] = [];
afterEach(async () => {
  for (const request of requests.splice(0)) request.destroy();
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function start(extra: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'worker-drain-'));
  directories.push(directory);
  const record = join(directory, 'receipt.txt');
  const child = fork(fileURLToPath(new URL('./fixtures/workerDrain.child.ts', import.meta.url)), {
    execArgv: ['--import', 'tsx'], silent: true,
    env: { ...process.env, DRAIN_RECORD: record, ...extra },
  });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (data) => { output += data; });
  child.stderr?.on('data', (data) => { output += data; });
  const seen: unknown[] = [];
  const waits = new Set<() => void>();
  child.on('message', (message) => { seen.push(message); for (const wake of waits) wake(); });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  async function until(predicate: (message: unknown) => boolean) {
    if (seen.some(predicate)) return seen.find(predicate);
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => { waits.delete(wake); reject(new Error(`child IPC timeout: ${output}`)); }, 4000);
      const wake = () => {
        if (seen.some(predicate)) { clearTimeout(timeout); waits.delete(wake); resolve(seen.find(predicate)); }
      };
      waits.add(wake);
    });
  }
  const ready = await until((message) => typeof message === 'object' && message !== null && 'port' in message) as { port: number };
  function work() {
    const req = request(`http://127.0.0.1:${ready.port}/work`, { agent: false });
    requests.push(req);
    const response = new Promise<string>((resolve, reject) => {
      req.on('response', (res) => {
        let body = '';
        res.on('data', (data) => { body += data; });
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
    });
    req.end();
    return { req, response };
  }
  return { child, exited, until, seen, work, record, output: () => output };
}

describe('worker deployment drain with real Hono HTTP and OS signals', () => {
  it('reproduces the predecessor losing an accepted job while reporting exit zero', async () => {
    const probe = await start({ DRAIN_LEGACY: '1' });
    const active = probe.work();
    const disconnected = active.response.catch(() => 'disconnected');
    await probe.until((x) => x === 'accepted');
    probe.child.kill('SIGTERM');
    expect(await probe.exited).toBe(0);
    expect(await disconnected).toBe('disconnected');
    await expect(readFile(probe.record, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('finishes an accepted request and detached completion record before exit, even after a repeated signal', async () => {
    const probe = await start();
    const active = probe.work();
    await probe.until((x) => x === 'accepted');
    probe.child.kill('SIGTERM');
    await probe.until((x) => x === 'stopping');
    probe.child.kill('SIGINT');
    probe.child.send('release');
    expect(await active.response).toBe('completed');
    await probe.until((x) => x === 'job-finished');
    expect(probe.child.exitCode).toBeNull();
    expect(await readFile(probe.record, 'utf8')).toBe('job\n');
    probe.child.send('receipt');
    expect(await probe.exited).toBe(0);
    expect(await readFile(probe.record, 'utf8')).toBe('job\nreceipt\nflush\n');
    expect(probe.seen.filter((x) => x === 'stopping')).toHaveLength(1);
  });

  it('retains work when the dispatcher disconnects before deployment', async () => {
    const probe = await start();
    const active = probe.work();
    const disconnected = active.response.catch(() => 'disconnected');
    await probe.until((x) => x === 'accepted');
    active.req.destroy(new Error('dispatcher disconnected'));
    expect(await disconnected).toBe('disconnected');
    probe.child.kill('SIGTERM');
    await probe.until((x) => x === 'stopping');
    probe.child.send('release');
    await probe.until((x) => x === 'job-finished');
    probe.child.send('receipt');
    expect(await probe.exited).toBe(0);
    expect(await readFile(probe.record, 'utf8')).toBe('job\nreceipt\nflush\n');
  });

  it('exits unsuccessfully at the deadline for an accepted hung job', async () => {
    const probe = await start({ DRAIN_DEADLINE: '250' });
    const active = probe.work();
    const disconnected = active.response.catch(() => 'disconnected');
    await probe.until((x) => x === 'accepted');
    probe.child.kill('SIGTERM');
    expect(await probe.exited).toBe(1);
    await disconnected;
    expect(probe.output()).toContain('shutdown deadline exceeded');
  });

  it('reports a failed telemetry flush instead of a successful shutdown', async () => {
    const probe = await start({ DRAIN_FLUSH_FAIL: '1' });
    probe.child.kill('SIGTERM');
    expect(await probe.exited).toBe(1);
    expect(probe.output()).toContain('shutdown failed');
  });

  it('rejects queued/new fetches during drain before starting any handler', async () => {
    const drain = new WorkerDrain();
    drain.begin();
    let called = false;
    const response = await drain.fetch(() => { called = true; return new Response('bad'); });
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(called).toBe(false);
  });

  it('drains rejected jobs without leaking a rejected cleanup promise', async () => {
    const drain = new WorkerDrain();
    const failed = drain.fetch(async () => { throw new Error('job failure'); });
    await expect(failed).rejects.toThrow('job failure');
    drain.begin();
    await drain.whenIdle();
  });
});
