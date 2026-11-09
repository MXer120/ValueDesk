/**
 * The API thread's longest hold while it reads the indexer's heatmap feed (indexer/liqFeed.ts), at production's shape.
 *
 *   node --expose-gc --import tsx tools/liqFeedBench.ts [--buckets=5000] [--fine=50000] [--coins=140] [--venues=5] [--inline]
 *
 * A feed server on a thread of its own (the indexer is another process: its JSON and socket writes are not this
 * thread's) sends what the engine sends: BTC with `buckets` levels per venue and a fine layer of `fine` cells per venue,
 * and `coins` small coins (300 levels, 2,000 fine cells per venue), as
 *   connect   every coin whole at once (a new reader, or the API after a restart: the indexer's backlog in one piece)
 *   refresh   every coin whole again in the same layout, a tenth of the values moved (the minute refresh)
 *   deltas    40 frames of 400 changed BTC levels per venue, 250 ms apart
 * and reports per phase the longest time a 1 ms timer on this thread could not run (the stall the API's loop watch
 * measures), the garbage collection on this thread in it (total and longest pause) and this thread's heap after.
 * `--inline`: the feed read on this thread (VALUESCAN_LIQ_FEED_THREAD=0), as before 2026-11-09.
 */
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { LiqFeedState } from '../src/indexer/liqFeed.js';

const arg = (name: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? d);
const opts = { buckets: arg('buckets', 5_000), fine: arg('fine', 50_000), coins: arg('coins', 140), venues: arg('venues', 5), port: 19_500 + Math.floor(Math.random() * 400) };
const inline = process.argv.includes('--inline');
const gc = (globalThis as { gc?: () => void }).gc;

// The indexer's side, plain JavaScript on its own thread.
const server = new Worker(`
const { parentPort, workerData: o } = require('node:worker_threads');
const net = require('node:net');
const VENUES = ['hyperliquid', 'sodex', 'tradexyz', 'lighter', 'arcus'].slice(0, o.venues);
let seed = 7;
const r = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const row = (i) => [i, Math.round(r() * 1e6), Math.round(r() * 1e6), 1 + Math.floor(r() * 9), 1 + Math.floor(r() * 9), Math.round(r() * 1e5), Math.round(r() * 1e5), Math.round(r() * 1e5), Math.round(r() * 1e5), Math.round(r() * 1e5), Math.round(r() * 1e5)];
const cov = () => [r(), r(), r(), r(), 100, 0, r(), r()];
const coins = [];
for (let n = 0; n < o.coins + 1; n++) {
  const nb = n === 0 ? o.buckets : 300, nf = n === 0 ? o.fine : 2000;
  coins.push({ coin: n === 0 ? 'BTC' : 'C' + n, ep: n + 1,
    b: new Map(VENUES.map((v) => [v, Array.from({ length: nb }, (_, i) => row(5000 + i))])),
    f: new Map(VENUES.map((v) => [v, Array.from({ length: nf }, (_, i) => row(70000 + i))])) });
}
const whole = (c) => JSON.stringify({ t: 'd', coin: c.coin, p: 100000, st: 20, ep: c.ep, whole: true,
  v: Object.fromEntries(VENUES.map((v) => [v, { b: c.b.get(v), c: cov(), o: [1, 2, 3, 4] }])),
  f: { st: 1, lo: 20000, hi: 300000, ep: c.ep, whole: true, v: Object.fromEntries(VENUES.map((v) => [v, c.f.get(v)])) } });
const tick = (at) => JSON.stringify({ t: 'tick', at, ready: true });
let sock = null;
const srv = net.createServer((s) => { sock = s; s.on('error', () => {}); parentPort.postMessage('reader'); });
srv.listen(o.port, '127.0.0.1', () => parentPort.postMessage({ listening: true, bytes: coins.reduce((s, c) => s + whole(c).length, 0) }));
parentPort.on('message', async (m) => {
  if (m === 'connect') sock.write(coins.map(whole).join('\\n') + '\\n' + tick(1) + '\\n');
  else if (m === 'refresh') {
    for (const c of coins) for (const mm of [c.b, c.f]) for (const rows of mm.values()) for (const x of rows) if (r() < 0.1) x[1] = Math.round(r() * 1e6);
    sock.write(coins.map(whole).join('\\n') + '\\n' + tick(2) + '\\n');
  } else if (m === 'deltas') {
    const btc = coins[0];
    for (let k = 0; k < 40; k++) {
      const v = {};
      for (const venue of VENUES) v[venue] = { b: Array.from({ length: 400 }, () => { const x = btc.b.get(venue)[Math.floor(r() * o.buckets)]; x[1] = Math.round(r() * 1e6); return x; }) };
      sock.write(JSON.stringify({ t: 'd', coin: 'BTC', p: 100000, st: 20, ep: btc.ep, whole: false, v }) + '\\n' + tick(3 + k) + '\\n');
      await new Promise((ok) => setTimeout(ok, 250));
    }
  } else if (m === 'stop') { sock && sock.destroy(); srv.close(); parentPort.close(); }
});
`, { eval: true, workerData: opts });
const ready = await new Promise<{ bytes: number }>((ok) => server.on('message', (m) => { if (m && (m as { listening?: boolean }).listening) ok(m as { bytes: number }); }));
console.log(`BTC ${opts.buckets} levels + ${opts.fine} fine cells per venue, ${opts.coins} coins, ${opts.venues} venues: ${(ready.bytes / 1048576).toFixed(1)} MB whole; feed read ${inline ? 'inline' : 'on its thread'}`);

const feed = new LiqFeedState(opts.port, { thread: !inline });
let ticks = 0;
feed.on('tick', () => { ticks++; });
let changes = 0;
feed.on('change', () => { changes++; });
feed.start();
while (!feed.connected) await new Promise((ok) => setTimeout(ok, 10));

// The probe: the longest gap between two runs of a 1 ms timer, and the GC inside the phase.
let maxGap = 0;
let last = performance.now();
const probe = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last - 1); last = now; }, 1);
let gcTotal = 0;
let gcMax = 0;
const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) { gcTotal += e.duration; gcMax = Math.max(gcMax, e.duration); } });
obs.observe({ entryTypes: ['gc'] });

async function phase(name: string, wantTicks: number): Promise<void> {
  gc?.();
  await new Promise((ok) => setTimeout(ok, 50));
  maxGap = 0; gcTotal = 0; gcMax = 0; last = performance.now();
  const t0 = performance.now();
  server.postMessage(name);
  while (ticks < wantTicks) await new Promise((ok) => setTimeout(ok, 2));
  const ms = performance.now() - t0;
  await new Promise((ok) => setTimeout(ok, 50));
  const heap = process.memoryUsage().heapUsed / 1048576;
  console.log(`${name.padEnd(8)} done in ${ms.toFixed(0).padStart(6)} ms   longest hold ${maxGap.toFixed(1).padStart(7)} ms   gc ${gcTotal.toFixed(0).padStart(5)} ms (longest ${gcMax.toFixed(1)} ms)   heap ${heap.toFixed(0)} MB`);
}

await phase('connect', 1);
await phase('refresh', 2);
await phase('deltas', 42);
console.log(`changes ${changes}, coins held ${feed.coins.size}`);
clearInterval(probe);
obs.disconnect();
feed.stop();
server.postMessage('stop');
