import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'collusion-memory-'));
try {
 const bundle=join(temp,'scan.mjs');
 await build({entryPoints:[join(root,'scripts/ci/collusion-memory-worker.ts')],outfile:bundle,bundle:true,platform:'node',format:'esm',target:'node20'});
 const run=(mode,heap)=>spawnSync(process.execPath,[`--max-old-space-size=${heap}`,'--max-semi-space-size=1',bundle,mode],{cwd:temp,encoding:'utf8',timeout:90000,maxBuffer:1024*1024});
 const oracle=run('retained',1024); assert.equal(oracle.status,0,oracle.stderr);
 const before=run('retained',256); assert.notEqual(before.status,0,'Fixture must reproduce retained-action exhaustion');
 assert.match(before.stderr,/heap out of memory|Reached heap limit/);
 const after=run('streamed',256); assert.equal(after.status,0,after.stderr);
 const expected=JSON.parse(oracle.stdout.trim());const actual=JSON.parse(after.stdout.trim());
 assert.equal(actual.heapLimitMiB<=260,true);
 assert.equal(actual.actions,800000);assert.ok(expected.findings>0,'Oracle must contain real positive timing findings');assert.equal(actual.digest,expected.digest);
 assert.ok(actual.peakHeapMiB<100,`Page fold retains too much: ${actual.peakHeapMiB}MiB`);
 console.log(JSON.stringify({retained:'production-sized heap exhausted',oracle:expected,pageFold:actual},null,2));
}finally{await rm(temp,{recursive:true,force:true});}
