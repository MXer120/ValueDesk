/**
 * How long the API's one thread is held by the cohort load at production size (2026-11-07 outage).
 *
 *   npx tsx tools/bench-api-stall.ts [scale=1]   (from apps/server; ~2 GB of memory at scale 1)
 *
 * Builds a throwaway index with production's cohort tables as counted on server 1 on 2026-11-07 15:5x UTC
 * (members: SoDEX 13,070, Hyperliquid 228,788, trade.xyz 108,552, Lighter 181,143, Arcus 14,699; books
 * 13,073 / 228,771 / 104,712 / 30,435 / 14,731; 716 marks), then measures the longest time the event loop
 * could not run a 1 ms timer (what a health check waits) through what the API does on its own and on the
 * first asks:
 *   warm       the start's warm-up (a full load, from behind)
 *   minute     a normal minute: 30,235 Hyperliquid members and ~1,500 books rewritten, a third of the marks move
 *   restart    the indexer's restart: every member and book rewritten (as at 15:10-15:12 on 2026-11-07)
 *   new scope  a set of venues and a coin filter nobody asked before (their first read)
 *   wallets    one cohort's wallet list over every venue
 * and, with the copy card cache of feat/copy-instant in mind, a 1,590-card file written while a load runs.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scale = Number(process.argv[2] ?? 1) || 1;
const dir = mkdtempSync(join(tmpdir(), 'vs-stall-bench-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');
process.env.VALUESCAN_LIQ_METAS_FILE = 'off';

const { IndexStore } = await import('../src/indexer/store.js');
const read = await import('../src/indexer/read.js');
const { VENUES } = await import('../src/valuedesk/types.js');
type Venue = (typeof VENUES)[number];

const MEMBERS: Record<Venue, number> = { sodex: 13_070, hyperliquid: 228_788, tradexyz: 108_552, lighter: 181_143, arcus: 14_699 };
const BOOKS: Record<Venue, number> = { sodex: 13_073, hyperliquid: 228_771, tradexyz: 104_712, lighter: 30_435, arcus: 14_731 };
for (const v of VENUES) { MEMBERS[v] = Math.round(MEMBERS[v] * scale); BOOKS[v] = Math.round(BOOKS[v] * scale); }

let seed = 7;
const r = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const COINS = Array.from({ length: 140 }, (_, i) => (i === 0 ? 'BTC' : i === 1 ? 'ETH' : `C${i}`));
const symOf = (v: Venue, c: string) => (v === 'tradexyz' ? `xyz:${c}` : v === 'sodex' || v === 'arcus' ? `${c}-USD` : c);
const PX = new Map(COINS.map((c, i) => [c, i === 0 ? 100_000 : i === 1 ? 3_500 : 0.1 + r() * 200]));
// trade.xyz shares Hyperliquid's accounts; the rest have their own.
const addr = (v: Venue, i: number) => `0x${(v === 'tradexyz' ? 'hy' : v.slice(0, 2))}${i.toString(16).padStart(38, '0')}`;
const member = (v: Venue, i: number) => {
  const tail = v === 'lighter' || r() < 0.4;
  return {
    address: addr(v, i), pnl: Math.round((r() - 0.45) * 3_000_000), equity: tail ? Math.round(r() * 9_000) : Math.round(r() ** 4 * 8_000_000),
    label: null, pnl1d: Math.round((r() - 0.5) * 10_000), pnl7d: Math.round((r() - 0.5) * 50_000), pnl30d: Math.round((r() - 0.5) * 200_000),
  };
};
const book = (v: Venue, i: number) => ({
  venue: v, address: addr(v, i), equity: Math.round(r() ** 4 * 8_000_000), at: Date.now() - Math.floor(r() * 100_000), collateral: null, spotAt: null, cash: null,
  positions: Array.from({ length: Math.floor(r() * 4) }, () => {
    const c = COINS[Math.floor(r() ** 2 * COINS.length)]!;
    return { symbol: symOf(v, c), szi: Math.round((r() - 0.45) * 1_000) / 10, entry: PX.get(c)! * (0.8 + r() * 0.4) };
  }),
});
const marks = (): Array<[string, number]> => VENUES.flatMap((v) => COINS.map((c): [string, number] => [`${v}|${symOf(v, c)}`, PX.get(c)!]));

const w = new IndexStore(process.env.VALUESCAN_INDEX_DB);
const put = (v: Venue, ms: number[], bs: number[]) => {
  for (let k = 0; k < ms.length; k += 5_000) w.putCohortMembers(v, ms.slice(k, k + 5_000).map((i) => member(v, i)), Date.now());
  for (let k = 0; k < bs.length; k += 5_000) w.putCohortBooks(bs.slice(k, k + 5_000).map((i) => book(v, i)));
};
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
let t0 = Date.now();
for (const v of VENUES) put(v, range(MEMBERS[v]), range(BOOKS[v]));
w.putCohortMarks(marks(), Date.now());
console.log(`index written in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${VENUES.map((v) => `${v} ${MEMBERS[v]}/${BOOKS[v]}`).join(', ')}`);

/** The longest a 1 ms timer waited while `fn` ran, and how long `fn` took. */
async function held(what: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  let worst = 0;
  let last = performance.now();
  let on = true;
  const tick = () => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 1);
    last = now;
    if (on) setTimeout(tick, 1);
  };
  setTimeout(tick, 1);
  const s = performance.now();
  await fn();
  const took = performance.now() - s;
  await new Promise((ok) => setTimeout(ok, 20));
  on = false;
  const heap = process.memoryUsage().heapUsed / 2 ** 20;
  console.log(`${what.padEnd(34)} took ${took.toFixed(0).padStart(6)} ms, longest hold ${Math.max(worst, 0).toFixed(0).padStart(5)} ms, heap ${heap.toFixed(0)} MB`);
}

const ALL = [...VENUES];
const prep = (read as Record<string, unknown>).cohortsPrepare as undefined | ((v: readonly Venue[], fs: readonly object[]) => Promise<void>);
const prepWallets = (read as Record<string, unknown>).cohortWalletsPrepare as undefined | ((v: readonly Venue[], c: string, f: object, range: string) => Promise<void>);
console.log(prep ? 'reads prepared from behind (cohortsPrepare)' : 'reads as v0.2.187 (no cohortsPrepare)');

await held('warm (full load)', () => read.warmCohorts(ALL));
await held('first page read', async () => { if (prep) await prep(ALL, [{}]); read.cohortsRead(ALL, {}); });

for (let m = 1; m <= 3; m++) {
  const hl = range(MEMBERS.hyperliquid).filter(() => r() < 30_235 / 228_788);
  put('hyperliquid', hl, range(BOOKS.hyperliquid).filter(() => r() < 0.003));
  for (const v of ['tradexyz', 'lighter', 'arcus', 'sodex'] as const) put(v, [], range(BOOKS[v]).filter(() => r() < 0.003));
  for (const c of COINS) if (r() < 0.33) PX.set(c, PX.get(c)! * (0.995 + r() * 0.01));
  w.putCohortMarks(marks(), Date.now());
  await held(`minute ${m} (rebuild from behind)`, () => read._cohortLoad.rebuild());
}

t0 = Date.now();
for (const v of VENUES) put(v, range(MEMBERS[v]), range(BOOKS[v]));
w.putCohortMarks(marks(), Date.now());
console.log(`(indexer restart: every row rewritten in ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
await held('after indexer restart (rebuild)', () => read._cohortLoad.rebuild());
await held('next minute (rebuild)', () => read._cohortLoad.rebuild());

const SCOPE: Venue[] = ['hyperliquid', 'lighter'];
await held('new scope + coin filter (first ask)', async () => { if (prep) await prep(SCOPE, [{}, { coin: 'ETH' }]); read.cohortsRead(SCOPE, { coin: 'ETH' }); });
await held('new filter on every venue', async () => { if (prep) await prep(ALL, [{ coin: 'BTC' }]); read.cohortFocus(ALL, { coin: 'BTC' }, '7d'); });
await held('cohort wallets (every venue)', async () => {
  if (prepWallets) await prepWallets(ALL, 'whale', {}, '30d');
  read.cohortWallets(ALL, 'whale' as never, {}, { sort: 'equity', dir: 'desc', offset: 0, limit: 50, range: '30d' });
});

// The liquidation history (the outage's route): BTC's 30 days as on server 1, 1,156 snapshots of ~56 KB (64.6 MB).
{
  const now = Date.now();
  const snap = (p: number) => JSON.stringify({ p, st: 20, v: Object.fromEntries(['hyperliquid', 'lighter', 'tradexyz', 'sodex', 'arcus'].map((v) => [v, Array.from({ length: 160 }, (_, i) => [4_900 + i, Math.round(r() * 5e6), Math.round(r() * 5e6), Math.round(r() * 1e6), Math.round(r() * 1e6), Math.round(r() * 1e6), Math.round(r() * 1e6), Math.round(r() * 1e6), Math.round(r() * 1e6)])])) });
  for (let k = 0; k < 1_156; k++) w.putLiqHist(now - (1_156 - k) * 37 * 60_000, [['BTC', snap(100_000 + k)]]);
  const { liqJob, stopLiqThread } = await import('../src/indexer/liqHistThread.js');
  const asks = () => Promise.all([0, 1, 2].map(() => liqJob({ kind: 'history', coin: 'BTC', venues: [...ALL], range: '30d', wallets: [], known: null })));
  process.env.VALUESCAN_LIQ_THREAD = '0';
  await held('3 x history 30d BTC, inline (v0.2.187)', asks);
  process.env.VALUESCAN_LIQ_THREAD = '1';
  await held('3 x history 30d BTC, own thread', asks);
  await stopLiqThread();
}

// feat/copy-instant: its card file (1,590 leaders, a card per window) written with JSON.stringify + writeFileSync.
const cards = Array.from({ length: 1_590 }, (_, i) => [`hyperliquid|${addr('hyperliquid', i)}`, {
  at: Date.now(), cards: Object.fromEntries(['7d', '30d', 'all'].map((wd) => [wd, { pnl: r() * 1e6, roi: r(), equity: r() * 1e6, curve: Array.from({ length: 120 }, () => [Date.now(), r() * 1e6]), trades: 100, winRate: 0.5 }])),
}]);
await held('copy cards file (1,590) saved', () => writeFileSync(join(dir, 'cards.json'), JSON.stringify({ v: 1, entries: cards })));

read._cohortLoad.reset();
w.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
