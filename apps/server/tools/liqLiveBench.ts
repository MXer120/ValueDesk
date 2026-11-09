/**
 * The live heatmap inline against on its own thread (indexer/liqLiveThread.ts), measured on this (the indexer's) thread.
 *   node --expose-gc --import tsx tools/liqLiveBench.ts [inline|thread|none|all] [--accounts=300000] [--prints=2000]
 *        [--seconds=30] [--hold=0] [--every=10000] [--walk=0.0004]
 *
 * Builds N books on 40 coins (one to three positions, a fifth of them cross with several), primes the engine, then for
 * `seconds` applies `prints` prints a second the way cohortTracker.ts does (a book moved and touched, the symbol's mark
 * set) and beats once a second as the indexer does. `--hold=ms` holds this thread that long every `--every` ms, as a
 * long SQLite write does (no prints arrive meanwhile: they come in on this thread too).
 *
 * `none` runs the same prints into a link that drops them: the bench's own share of this thread, to subtract.
 *
 * Reports this thread's event-loop utilization (perf_hooks) over the run, without the holds; the delay from a probe
 * print to its coin's delta arriving at a feed reader (on a thread of its own), p50/p99/max; and, with --expose-gc, the
 * heap the thread's copy of the books takes (MirrorSource, measured on this thread) and the heatmap thread's heap.
 */
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { Venue } from '../src/valuedesk/types.js';
import { _setMarkets, marketsNow } from '../src/valuedesk/liquidations/rules.js';
import { flatTiers } from '../src/valuedesk/liquidations/math.js';
import { liqCoin } from '../src/valuedesk/liquidations/levels.js';
import { liqKnown } from '../src/indexer/cohortTracker.js';
import { liveLink, type LiveLink } from '../src/indexer/liqLiveThread.js';
import { AccountsEncoder, MirrorSource } from '../src/indexer/liqLiveCore.js';

const arg = (name: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? d);
const which = ['inline', 'thread', 'none'].includes(process.argv[2] ?? '') ? [process.argv[2]!] : ['none', 'inline', 'thread'];
const N = arg('accounts', 300_000);
const PRINTS = arg('prints', 2_000);
const SECONDS = arg('seconds', 30);
const HOLD = arg('hold', 0);
const EVERY = arg('every', 10_000);
/** How far one print moves its symbol's mark at most (relative, both ways): past 0.02% it re-prices the accounts holding it beside others. */
const WALK = arg('walk', 0.0004);
const gc = (globalThis as { gc?: () => void }).gc;
const V: Venue = 'hyperliquid';

let seed = 7;
const r = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const COINS = Array.from({ length: 40 }, (_, i) => `C${i}`);
const PX = new Map(COINS.map((c, i) => [c, i === 0 ? 80_000 : 0.5 + r() * 3_000]));
PX.set('PROBE', 1_000);
_setMarkets(V, { tiers: new Map([...PX.keys()].map((c) => [c, flatTiers(0.01 + r() * 0.01)])), oi: new Map(), at: Date.now() });

type Pos = { szi: number; entry: number | null; iso?: number | null; lev?: number | null };
type Book = { equity: number | null; cash: number | null; at: number; pos: Map<string, Pos> };

function makeBooks(): Map<string, Book> {
  const books = new Map<string, Book>();
  for (let i = 0; i < N; i++) {
    const pos = new Map<string, Pos>();
    const n = r() < 0.8 ? 1 : 2 + Math.floor(r() * 2);
    let notional = 0;
    let signed = 0;
    for (let j = 0; j < n; j++) {
      const c = COINS[Math.floor(r() ** 2 * COINS.length)]!;
      const px = PX.get(c)!;
      const usd = 100 + r() ** 3 * 500_000;
      const szi = (r() < 0.5 ? -1 : 1) * usd / px;
      const p: Pos = { szi, entry: px };
      if (r() < 0.08) { p.iso = usd * 0.1; p.lev = 10; }
      pos.set(c, p);
      notional += usd;
      signed += szi * px;
    }
    books.set(`0x${i.toString(16).padStart(40, '0')}`, { equity: notional * 0.2, cash: notional * (0.05 + r() * 0.4) - signed, at: Date.now(), pos });
  }
  return books;
}

const PROBE = '0xprobe';

async function run(mode: 'inline' | 'thread' | 'none') {
  const books = makeBooks();
  const marks = new Map<string, number>([...PX].map(([c, p]) => [`${V}|${c}`, p]));
  const coinPx = new Map(PX);
  const wanted: ReadonlySet<string> = new Set(PX.keys());
  books.set(PROBE, { equity: 1e6, cash: 5e5, at: Date.now(), pos: new Map([['PROBE', { szi: 100, entry: 1_000 }]]) });
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  gc?.(); gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  const real = liveLink({
    source: {
      account: (_v, a) => { const b = books.get(a); return b ? { cash: b.cash, priced: liqKnown(b), positions: [...b.pos].map(([symbol, p]) => ({ symbol, ...p })), equity: b.equity } : undefined; },
      priceOf: (v, s) => marks.get(`${v}|${s}`) ?? null,
      tiersOf: (v, s) => marketsNow(v)?.tiers.get(s) ?? null,
      priceOfCoin: (c) => coinPx.get(c) ?? null,
      wanted: (c) => wanted.has(c),
      extra: () => ({}),
    },
    crossed: () => {},
    now: () => Date.now(),
    breathe: () => new Promise((res) => setImmediate(res)),
    book: (_v, a) => books.get(a),
    allKeys: () => [...books.keys()].map((a) => `${V}|${a}`),
    allMarks: () => marks,
    allCoinPx: () => coinPx,
    wanted: () => wanted,
    port,
  }, mode === 'thread');
  const link: LiveLink = mode === 'none' ? { ...nullLink(), drain: () => real.drain(), start: () => real.start(), stop: () => real.stop() } as LiveLink : real;
  const t0 = performance.now();
  for (const a of books.keys()) link.touch(V, a);
  link.start();
  link.beat(5_000, 300);
  await link.drain();
  const primeMs = performance.now() - t0;
  gc?.(); gc?.();
  // What priming added to this thread's heap: the engine itself inline, the hand-over's leftovers threaded.
  const mainHeapMb = gc ? +((process.memoryUsage().heapUsed - heap0) / 1e6).toFixed(1) : null;
  // The heatmap thread's heap after a collection (it inherits --expose-gc), against this thread's growth inline.
  const th = mode === 'thread' ? await real.heapUsed() : null;
  const threadHeapMb = th === null ? null : th / 1e6;

  // The feed reader, on a thread of its own: when each PROBE delta arrived.
  const reader = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const net = require('node:net');
    const { performance } = require('node:perf_hooks');
    const at = [];
    let buf = '';
    const s = net.connect(workerData.port, '127.0.0.1');
    s.setEncoding('utf8');
    s.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.includes('"coin":"PROBE"')) at.push(performance.timeOrigin + performance.now());
      }
    });
    s.on('connect', () => parentPort.postMessage('up'));
    parentPort.on('message', () => { parentPort.postMessage(at); s.destroy(); });
  `, { eval: true, workerData: { port } });
  await new Promise((res) => reader.once('message', res));
  await new Promise((res) => setTimeout(res, 1_500));

  const keys = [...books.keys()].filter((a) => a !== PROBE);
  const probes: number[] = [];
  let probeSz = 100;
  let prints = 0;
  let held = 0;
  const startAt = performance.now();
  const elu0 = performance.eventLoopUtilization();
  let nextHold = startAt + EVERY;
  let owed = 0;
  let lastAt = startAt;
  const pend: number[] = [];
  const beat = setInterval(() => { link.beat(5_000, link.pending > 10_000 ? 300 : 150); pend.push(real.pending); }, 1_000);
  const step = setInterval(() => {
    // A print: the price walks, both parties' books move (cohortTracker.ts onPrint / moveBook).
    // As many as the time since the last turn owes (Windows timers fire every ~15.6 ms, not 10).
    const t = performance.now();
    owed += ((t - lastAt) / 1000) * PRINTS;
    lastAt = t;
    for (; owed >= 1; owed--) {
      const c = COINS[Math.floor(r() ** 2 * COINS.length)]!;
      const k = `${V}|${c}`;
      const px = marks.get(k)! * (1 + (r() - 0.5) * WALK);
      marks.set(k, px);
      link.mark(V, c, px);
      for (let side = 0; side < 2; side++) {
        const a = keys[Math.floor(r() * keys.length)]!;
        const b = books.get(a)!;
        const [sym, p] = [...b.pos][0]!;
        b.pos.set(sym, { ...p, szi: p.szi * (0.9 + r() * 0.2) });
        if (b.cash !== null) b.cash -= 0.5;
        link.touch(V, a);
      }
      prints++;
    }
    if (performance.now() >= nextHold && HOLD > 0) {
      const h0 = performance.now();
      while (performance.now() - h0 < HOLD) { /* held, as by a long write */ }
      held += performance.now() - h0;
      nextHold = performance.now() + EVERY;
      // No prints arrive while the thread is held (the streams are read on it too).
      lastAt = performance.now();
    }
  }, 10);
  // The probe: its book grows 2% every 200 ms, so its coin's bucket moves past the 1% the deltas skip.
  const probe = setInterval(() => {
    probeSz *= 1.02;
    books.get(PROBE)!.pos.set('PROBE', { szi: probeSz, entry: 1_000 });
    probes.push(performance.timeOrigin + performance.now());
    link.touch(V, PROBE);
  }, 200);
  await new Promise((res) => setTimeout(res, SECONDS * 1_000));
  clearInterval(step);
  clearInterval(probe);
  clearInterval(beat);
  const elu = performance.eventLoopUtilization(elu0);
  const wallMs = performance.now() - startAt;
  await new Promise((res) => setTimeout(res, 2_500));
  reader.postMessage('done');
  const arrivals = await new Promise<number[]>((res) => reader.once('message', res));
  await reader.terminate();
  // A 15-minute liquidation step's computing (liq_now rows, snapshots, fine bands, the change log's first diff: every
  // position), this thread's busy share meanwhile.
  let liqStep: { ms: number; mainBusyPct: number; rows: number; fine: number } | null = null;
  if (mode !== 'none') {
    const e0 = performance.eventLoopUtilization();
    const s0 = performance.now();
    const out = await link.step({ now: Date.now(), t: Math.floor(Date.now() / 900_000) * 900_000, coins: [...wanted], ticks: new Map(), full: false, init: { cur: [], addrs: new Map() } });
    const ms = performance.now() - s0;
    liqStep = { ms: Math.round(ms), mainBusyPct: +(performance.eventLoopUtilization(e0).utilization * 100).toFixed(1), rows: out.step?.log?.changed.length ?? 0, fine: out.step?.fine.length ?? 0 };
  }
  await link.stop();
  const lat: number[] = [];
  let j = 0;
  for (const t of probes) {
    while (j < arrivals.length && arrivals[j]! < t) j++;
    if (j < arrivals.length) lat.push(arrivals[j]! - t);
  }
  lat.sort((a, b) => a - b);
  const q = (p: number) => (lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]!) : NaN);
  // Busy share without the holds (they are the simulated load, not the engine's).
  const busyPct = ((elu.active - held) / (wallMs - held)) * 100;
  return { mode, accounts: N, printsPerS: Math.round(prints / (wallMs / 1000)), primeMs: Math.round(primeMs), mainBusyPct: +busyPct.toFixed(1), heldMs: Math.round(held), probes: probes.length, matched: lat.length, latencyMs: { p50: q(0.5), p99: q(0.99), max: lat.length ? Math.round(lat[lat.length - 1]!) : NaN }, liqStep, pendingAvg: Math.round(pend.reduce((a, b) => a + b, 0) / Math.max(1, pend.length)), pendingMax: Math.max(0, ...pend), mainHeapMb, threadHeapMb: threadHeapMb && +threadHeapMb.toFixed(1) };
}

/** A link that drops everything (mode `none`). */
function nullLink(): Partial<LiveLink> {
  const no = () => {};
  return { threaded: false, touch: no, mark: no, price: no, coinPx: no, beat: no, ready: true, pending: 0 };
}

/** The thread's copy of N books alone: the heap MirrorSource takes (needs --expose-gc). */
function mirrorHeap(): number | null {
  if (!gc) return null;
  const books = makeBooks();
  const enc = new AccountsEncoder();
  const wires = [];
  for (const [a, b] of books) {
    enc.add(`${V}|${a}`, b);
    if (enc.size >= 10_000) wires.push(enc.take());
  }
  if (enc.size) wires.push(enc.take());
  books.clear();
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  const m = new MirrorSource(liqCoin);
  for (const w of wires) m.applyAccounts(w, () => {});
  wires.length = 0;
  gc(); gc();
  const mb = (process.memoryUsage().heapUsed - before) / 1e6;
  if (m.accounts.size !== N) throw new Error('mirror size');
  return +mb.toFixed(1);
}

const out = [];
for (const m of which) out.push(await run(m as 'inline' | 'thread' | 'none'));
console.log(JSON.stringify({ prints: PRINTS, walk: WALK, hold: HOLD ? { ms: HOLD, every: EVERY } : null, runs: out, mirrorHeapMb: mirrorHeap() }, null, 1));
process.exit(0);
