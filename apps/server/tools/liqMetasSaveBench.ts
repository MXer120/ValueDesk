/**
 * How long saveLiqMetas (indexer/liqTiles.ts) holds the API thread, at production's size.
 *
 *   node --expose-gc --import tsx tools/liqMetasSaveBench.ts [--coins=120] [--sets=2] [--snaps=2880]
 *
 * Holds `coins` x `sets` venue sets of `snaps` metas (30 days at 15 minutes: 2,880), each with its scales, then writes
 * the metas' file three times and reports the longest time a 1 ms timer on this thread could not run, the GC in it and
 * the file's size. The file goes to a temporary directory, removed after.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';

const arg = (name: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? d);
const dir = mkdtempSync(join(tmpdir(), 'vs-metas-bench-'));
process.env.VALUESCAN_LIQ_METAS_FILE = join(dir, 'metas.bin');
const T = await import('../src/indexer/liqTiles.js');
const gc = (globalThis as { gc?: () => void }).gc;
const W = T.histScales([{ st: 1, sc: new Float64Array(64) }]) && Object.keys(T.histScales([{ st: 1, sc: new Float64Array(64) }])).length;
let n = 0;
for (let c = 0; c < arg('coins', 120); c++) {
  for (let s = 0; s < arg('sets', 2); s++) {
    const byT = new Map();
    for (let k = 0; k < arg('snaps', 2_880); k++) {
      const t = 1_760_000_000_000 + k * 900_000;
      byT.set(t, { t, n: 70_000 + k, p: 100 + k, st: 0.02, vm: 3, sc: Float64Array.from({ length: W }, (_, j) => j + k) });
      n++;
    }
    T._liqMetasHeld.set(`C${c}|${s ? 'hyperliquid' : 'hyperliquid,sodex'}`, byT);
  }
}
let maxGap = 0;
let last = performance.now();
const probe = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last - 1); last = now; }, 1);
let gcTotal = 0;
let gcMax = 0;
new PerformanceObserver((l) => { for (const e of l.getEntries()) { gcTotal += e.duration; gcMax = Math.max(gcMax, e.duration); } }).observe({ entryTypes: ['gc'] });
console.log(`${n} metas of ${W} scales held, heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB`);
for (let k = 0; k < 3; k++) {
  gc?.();
  await new Promise((ok) => setTimeout(ok, 50));
  maxGap = 0; gcTotal = 0; gcMax = 0; last = performance.now();
  const t0 = performance.now();
  await T.saveLiqMetas();
  const ms = performance.now() - t0;
  await new Promise((ok) => setTimeout(ok, 20));
  console.log(`save ${k + 1}: done in ${ms.toFixed(0)} ms   longest hold ${maxGap.toFixed(1)} ms   gc ${gcTotal.toFixed(0)} ms (longest ${gcMax.toFixed(1)} ms)   file ${(statSync(process.env.VALUESCAN_LIQ_METAS_FILE!).size / 1048576).toFixed(1)} MB`);
}
clearInterval(probe);
rmSync(dir, { recursive: true, force: true });
