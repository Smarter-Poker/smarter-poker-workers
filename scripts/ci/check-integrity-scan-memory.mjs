import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'integrity-memory-'));
try {
  const bundle = join(temp, 'scan.mjs');
  await build({ entryPoints: [join(root, 'scripts/ci/integrity-scan-memory-worker.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'esm', target: 'node20' });
  const run = (mode, oldSpace) => spawnSync(process.execPath,
    [`--max-old-space-size=${oldSpace}`, '--max-semi-space-size=1', bundle, mode],
    { cwd: temp, encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024 });
  const resultOf = (r) => JSON.parse(r.stdout.trim().split('\n').at(-1));
  // Large-heap oracle retains exactly the old raw pages and delta arrays.
  const oracleRun = run('retained', 1024);
  assert.equal(oracleRun.status, 0, oracleRun.stderr);
  const oracle = resultOf(oracleRun);
  const oldLimited = run('retained', 256);
  assert.notEqual(oldLimited.status, 0, 'Stress fixture must expose the original heap failure');
  assert.match(oldLimited.stderr, /heap out of memory|Reached heap limit/, 'Baseline must fail from heap exhaustion, not an unrelated error');
  const fixedRun = run('streamed', 256);
  assert.equal(fixedRun.status, 0, fixedRun.stderr);
  const fixed = resultOf(fixedRun);
  const fixture = JSON.parse(fixedRun.stdout.trim().split('\n')[0]);
  assert.ok(fixture.heapLimitMiB <= 260, 'Memory regression must run at the production-sized heap limit');
  assert.deepEqual(fixed.counts, [20000, 50000]);
  assert.equal(fixed.digest, oracle.digest, 'Every count, rounded timing statistic, severity and chip-pair finding must match');
  assert.ok(fixed.peakHeapMiB < 150, `Streamed peak heap unexpectedly high: ${fixed.peakHeapMiB}MiB`);
  console.log(JSON.stringify({ fixture, oracle, retainedAt259MiB: 'heap exhaustion reproduced', streamedAt259MiB: fixed }, null, 2));
} finally {
  await rm(temp, { recursive: true, force: true });
}
