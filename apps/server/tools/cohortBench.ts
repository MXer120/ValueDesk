/**
 * The API thread while cohorts load and rebuild, inline against on the cohort thread (indexer/cohortThread.ts).
 *   node --import tsx tools/cohortBench.ts <inline|thread> [wallets=400000]
 * Seeds a temporary index (members + books on two venues), then loads, rebuilds three times and asks a few routes'
 * jobs, while a 10 ms timer measures how late this thread runs; prints the longest lateness, its p99, and the heap.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mode = process.argv[2] === 'thread' ? 'thread' : 'inline';
const N = Number(process.argv[3]) || 400_000;
const dir = mkdtempSync(join(tmpdir(), 'vs-cohort-bench-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');
process.env.VALUESCAN_COHORT_THREAD = mode === 'thread' ? '1' : '0';

const { IndexStore } = await import('../src/indexer/store.js');
const COINS = ['BTC', 'ETH', 'SOL', 'DOGE', 'HYPE', 'LINK', 'PEPE', 'xyz:TSLA'];
const w = new IndexStore(process.env.VALUESCAN_INDEX_DB);
let s = 7;
const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
const now = Date.now();
for (const [venue, n] of [['hyperliquid', Math.round(N * 0.6)], ['lighter', Math.round(N * 0.4)]] as const) {
  for (let off = 0; off < n; off += 20_000) {
    const members = [];
    const books = [];
    for (let i = off; i < Math.min(n, off + 20_000); i++) {
      const address = `0x${venue.slice(0, 2)}${String(i).padStart(38, '0')}`;
      const equity = Math.round(r() ** 4 * 8_000_000);
      members.push({ address, pnl: Math.round((r() - 0.45) * 3e6), equity, label: null, pnl1d: null, pnl7d: Math.round((r() - 0.5) * 5e4), pnl30d: Math.round((r() - 0.5) * 2e5) });
      if (i % 3) books.push({ venue, address, equity, at: now - 1_000, positions: Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ symbol: COINS[Math.floor(r() * COINS.length)]!, szi: (r() - 0.45) * 100, entry: 100 })) });
    }
    w.putCohortMembers(venue, members, now);
    w.putCohortBooks(books);
  }
}
w.putCohortMarks(['hyperliquid', 'lighter'].flatMap((v) => COINS.map((c): [string, number] => [`${v}|${c}`, 100])), now);
w.close();
console.log(`${mode}: seeded ${N} wallets`);

const C = await import('../src/indexer/cohortThread.js');
const R = await import('../src/indexer/read.js');
let last = performance.now();
const lates: number[] = [];
const tick = setInterval(() => { const t = performance.now(); lates.push(t - last - 10); last = t; }, 10);
let heapMax = 0;
const heap = setInterval(() => { heapMax = Math.max(heapMax, process.memoryUsage().heapUsed); }, 50);
const t0 = performance.now();
await C.cohortJob({ op: 'warm', venues: ['hyperliquid', 'lighter'] });
// 150 s of use: the load's own timer rebuilds it about every minute (read.ts LOAD_TTL_MS), books move every 20 s.
for (let k = 0; k < 30; k++) {
  if (k % 4 === 0) {
    const ww = new IndexStore(process.env.VALUESCAN_INDEX_DB!);
    ww.putCohortBooks(Array.from({ length: 5_000 }, (_, i) => ({ venue: 'hyperliquid' as const, address: `0xhy${String(i * 7).padStart(38, '0')}`, equity: 1e6, at: Date.now() + k, positions: [{ symbol: 'BTC', szi: k + 1, entry: 100 }] })));
    ww.close();
  }
  await C.cohortJob({ op: 'cohorts', venues: ['hyperliquid', 'lighter'], f: {} });
  if (k % 3 === 0) await C.cohortJob({ op: 'cohorts', venues: ['hyperliquid'], f: { coin: 'ETH' } });
  if (k % 5 === 0) await C.cohortJob({ op: 'wallets', venues: ['hyperliquid', 'lighter'], cohort: 'whale' as never, f: {}, o: { sort: 'equity', dir: 'desc', offset: 0, limit: 50, range: '30d' } });
  await new Promise((res) => setTimeout(res, 5_000));
}
const took = performance.now() - t0;
clearInterval(tick);
clearInterval(heap);
lates.sort((a, b) => a - b);
console.log(JSON.stringify({ mode, wallets: N, seconds: +(took / 1000).toFixed(1), longestLateMs: Math.round(lates.at(-1)!), p99LateMs: Math.round(lates[Math.floor(lates.length * 0.99)]!), heapMaxMb: Math.round(heapMax / 1048576), stats: C.cohortThreadStats }));
await C.stopCohortThread();
R._cohortLoad?.reset?.();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
process.exit(0);
