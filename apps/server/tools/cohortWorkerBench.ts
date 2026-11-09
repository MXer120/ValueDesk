/**
 * The cohort passes (indexer/cohortCore.ts) on the indexer's thread against on the heatmap thread, measured on this (the
 * indexer's) thread.
 *   node --import tsx tools/cohortWorkerBench.ts [inline|thread|all] [--books=300000] [--rounds=3]
 *
 * Builds N books over the five venues (a quarter empty, one to three positions, the flags the plan reads), as many
 * members again with a fifth more that hold no book, marks, 100k archive holders, a 200k read list and PnL read times;
 * then runs each pass `rounds` times: the history step (record), every venue's plan, the perp PnL scan, the members'
 * diff of Hyperliquid (the first diff after a start writes everything; the later ones only what moved) and the open
 * interest rereads for three coins. Threaded, the books are handed over first (measured apart: once per start), the
 * members are encoded here as the tracker does.
 *
 * Reports per pass this thread's busy time (perf_hooks event-loop utilization, active ms), its wall time, and the longest
 * this thread was late on a 10 ms timer meanwhile (what a print, a socket or a store write waited at most).
 */
import { performance } from 'node:perf_hooks';
import { VENUES, type Venue } from '../src/valuedesk/types.js';
import { liqCoin } from '../src/valuedesk/liquidations/levels.js';
import { liveLink, type LiveLink } from '../src/indexer/liqLiveThread.js';
import {
  MemberSigs, MembersEncoder, decodeRows, encodeMembers, planDue, pnlScan, recordCompute,
  type Book, type CohortAsk, type CohortIn, type CohortView, type Member, type MembersWire, type PlanAsk,
} from '../src/indexer/cohortCore.js';
import { oiRereadsMany } from '../src/indexer/oiCheck.js';

const arg = (name: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? d);
const which = ['inline', 'thread'].includes(process.argv[2] ?? '') ? [process.argv[2]!] : ['inline', 'thread'];
const N = arg('books', 300_000);
const ROUNDS = arg('rounds', 3);
const NOW = Date.now();
const DAY = 86_400_000;

let seed = 7;
const r = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const SHARE: Record<Venue, number> = { hyperliquid: 0.5, tradexyz: 0.15, lighter: 0.25, sodex: 0.05, arcus: 0.05 };
const COINS = Array.from({ length: 40 }, (_, i) => `C${i}`);
const PX = new Map(COINS.map((c, i) => [c, i === 0 ? 80_000 : 0.5 + r() * 3_000]));
const SODEX = new Set(COINS.slice(0, 30));

function build() {
  seed = 7;
  const books = new Map<Venue, Map<string, Book>>(VENUES.map((v) => [v, new Map()]));
  const members = new Map<Venue, Map<string, Member>>(VENUES.map((v) => [v, new Map()]));
  const marks = new Map<string, number>();
  for (const v of VENUES) for (const [c, px] of PX) marks.set(`${v}|${c}`, px);
  let i = 0;
  for (const v of VENUES) {
    const n = Math.round(N * SHARE[v]);
    for (let j = 0; j < n; j++, i++) {
      const a = v === 'tradexyz' ? `0x${(j * 2).toString(16).padStart(40, '0')}` : `0x${i.toString(16).padStart(40, '0')}`;
      const pos = new Map<string, { szi: number; entry: number | null; iso?: number | null; lev?: number | null }>();
      const k = r() < 0.25 ? 0 : r() < 0.8 ? 1 : 2 + Math.floor(r() * 2);
      let ntl = 0;
      for (let q = 0; q < k; q++) {
        const c = COINS[Math.floor(r() ** 2 * COINS.length)]!;
        const usd = 100 + r() ** 3 * 500_000;
        const p: { szi: number; entry: number | null; iso?: number | null; lev?: number | null } = { szi: (r() < 0.5 ? -1 : 1) * usd / PX.get(c)!, entry: PX.get(c)! };
        if (r() < 0.08) { p.iso = usd * 0.1; p.lev = 10; }
        pos.set(c, p);
        ntl += usd;
      }
      const b: Book = { equity: ntl * 0.2 + r() * 1e5, cash: r() < 0.3 ? null : ntl * 0.2, at: NOW - Math.floor(r() * 10 * DAY), pos };
      if (r() < 0.3) b.filledAt = b.at + 60_000;
      if (v === 'hyperliquid' && r() < 0.5) b.spotAt = NOW - DAY;
      books.get(v)!.set(a, b);
      if (r() < 0.9) members.get(v)!.set(a, { pnl: (r() - 0.4) * 1e6, equity: b.equity, label: null, ...(v === 'hyperliquid' && r() < 0.3 ? { ranked: true } : {}), pnlRange: { '1d': r() * 1e3, '7d': r() * 1e4, '30d': r() * 1e5 } });
    }
    for (let j = 0; j < n / 5; j++) members.get(v)!.set(`0xm${v}${j.toString(16).padStart(30, '0')}`, { pnl: r() * 1e5, equity: r() * 1e6, label: null });
  }
  const hl = [...books.get('hyperliquid')!.keys()];
  const seeds = new Map<Venue, Map<string, number>>([['hyperliquid', new Map(Array.from({ length: 100_000 }, (_, j): [string, number] => [j % 2 ? hl[j]! : `0xs${j}`, r() * 1e5]))]]);
  const readList = Array.from({ length: 200_000 }, (_, j) => (j % 3 ? `0xr${j}` : hl[j % hl.length]!));
  const pnlAt = new Map<string, number>();
  for (const a of hl) if (r() < 0.6) pnlAt.set(a, NOW - Math.floor(r() * 10 * DAY));
  return { books, members, marks, seeds, readList, pnlAt };
}

type World = ReturnType<typeof build>;

function viewOf(w: World): CohortView {
  return {
    books: (v) => w.books.get(v)!, members: (v) => w.members.get(v), mark: (k) => w.marks.get(k), pnlAt: (a) => w.pnlAt.get(a),
    seeds: (v) => w.seeds.get(v), readList: () => w.readList, sodexCoins: () => SODEX,
  };
}

/** This thread's busy ms, wall ms and longest lateness over `fn`. */
async function measure(fn: () => Promise<unknown>): Promise<{ busy: number; wall: number; late: number }> {
  let last = performance.now();
  let late = 0;
  const tick = setInterval(() => { const t = performance.now(); late = Math.max(late, t - last - 10); last = t; }, 10);
  const e0 = performance.eventLoopUtilization();
  const t0 = performance.now();
  await fn();
  // One more turn: the reply's own handling counted, the timer's last lateness read.
  await new Promise((res) => setTimeout(res, 20));
  const wall = performance.now() - t0 - 20;
  const e = performance.eventLoopUtilization(e0);
  clearInterval(tick);
  return { busy: e.active, wall, late: Math.max(late, performance.now() - last - 10) };
}

const breathe = () => new Promise<void>((res) => setImmediate(res));
const SLICE = 30;
const fmt = (x: { busy: number; wall: number; late: number }) => `busy ${x.busy.toFixed(0).padStart(6)} ms  wall ${x.wall.toFixed(0).padStart(6)} ms  late max ${x.late.toFixed(0).padStart(4)} ms`;

async function encodeSliced(m: ReadonlyMap<string, Member>): Promise<MembersWire> {
  const e = new MembersEncoder();
  let t0 = Date.now();
  for (const [a, x] of m) { e.add(a, x); if (Date.now() - t0 > SLICE) { await breathe(); t0 = Date.now(); } }
  return e.take();
}

async function run(mode: 'inline' | 'thread') {
  const w = build();
  const view = viewOf(w);
  const total = VENUES.reduce((s, v) => s + w.books.get(v)!.size, 0);
  const members = VENUES.reduce((s, v) => s + w.members.get(v)!.size, 0);
  console.log(`\n${mode}: ${total} books, ${members} members`);
  let link: LiveLink | null = null;
  if (mode === 'thread') {
    link = liveLink({
      source: { account: () => undefined, priceOf: () => null, tiersOf: () => null, priceOfCoin: () => null, wanted: () => false, extra: () => ({}) },
      crossed: () => {}, now: () => Date.now(), breathe,
      book: (v, a) => w.books.get(v)?.get(a),
      allKeys: () => VENUES.flatMap((v) => [...w.books.get(v)!.keys()].map((a) => `${v}|${a}`)),
      allMarks: () => w.marks, allCoinPx: () => [], wanted: () => SODEX,
      cohortState: (): CohortIn[] => [
        ...VENUES.map((venue): CohortIn => ({ k: 'members', venue, w: encodeMembers(w.members.get(venue)!) })),
        { k: 'seeds', v: [...w.seeds].map(([v, m]): [Venue, string[], Float64Array] => [v, [...m.keys()], Float64Array.from(m.values())]) },
        { k: 'readList', a: w.readList },
        { k: 'pnlAt', a: [...w.pnlAt.keys()], at: Float64Array.from(w.pnlAt.values()), all: true },
      ],
      port: 20_000 + Math.floor(Math.random() * 20_000),
    }, true);
    const l = link;
    const hand = await measure(async () => {
      for (const v of VENUES) for (const [a, b] of w.books.get(v)!) { if (b.pos.size) l.touch(v, a); else l.changed(v, a); }
      l.start();
      // A pass waits for every book: the hand-over is done when the first answers.
      await l.cohort({ op: 'oi', venue: 'arcus', asks: [], now: NOW });
    });
    console.log(`  hand-over of every book (once per start)  ${fmt(hand)}`);
  }
  const pass = <T>(ask: CohortAsk, here: () => Promise<T>) => (link ? link.cohort(ask) : here());
  const sigs = new MemberSigs();
  const rows: Record<string, Array<{ busy: number; wall: number; late: number }>> = {};
  const add = (k: string, x: { busy: number; wall: number; late: number }) => (rows[k] ??= []).push(x);
  for (let round = 0; round < ROUNDS; round++) {
    const rec = { seriesT: NOW, mixT: NOW, doMix: true };
    add('record (series + mix)', await measure(() => pass({ op: 'record', ask: rec }, () => recordCompute(view, rec, breathe, 150))));
    add('plan, every venue', await measure(async () => {
      for (const venue of VENUES) {
        const ask: PlanAsk = { venue, now: NOW, cap: 400, scan: true, streamed: true, gap: NOW - DAY, floor: 100_000, staleBefore: 0, startedAt: NOW - DAY };
        await pass({ op: 'plan', ask, wanted: [], unknown: null }, () => planDue(view, ask, { wanted: { has: () => false, list: () => [] }, known: () => true }, breathe, SLICE));
      }
    }));
    const pnl = { now: NOW, perpSince: NOW - 20 * DAY, outage: false, startedAt: NOW - DAY };
    add('perp PnL scan', await measure(() => pass({ op: 'pnl', ask: pnl }, () => pnlScan(view, pnl, breathe, SLICE))));
    // Every member moves a little each round: the first diff is all of them, the later ones the tenth that moved past 3 digits.
    if (round) for (const [i, m] of [...w.members.get('hyperliquid')!.values()].entries()) if (i % 10 === 0) m.equity = (m.equity ?? 0) * 1.2;
    const hm = w.members.get('hyperliquid')!;
    add(round ? 'members diff (hyperliquid, later)' : 'members diff (hyperliquid, first)', await measure(async () => {
      if (link) decodeRows(await link.cohort({ op: 'members', venue: 'hyperliquid', w: await encodeSliced(hm) }) as MembersWire);
      else await sigs.changes('hyperliquid', hm, breathe, SLICE);
    }));
    const asks = ['C0', 'C1', 'C2'].map((coin) => ({ coin, limit: 100 }));
    add('oi rereads (3 coins, hyperliquid)', await measure(() => pass({ op: 'oi', venue: 'hyperliquid', asks, now: NOW }, () => oiRereadsMany(w.books.get('hyperliquid')!.entries(), asks, liqCoin, NOW, breathe, SLICE))));
  }
  for (const [k, xs] of Object.entries(rows)) {
    const med = (f: (x: { busy: number; wall: number; late: number }) => number) => xs.map(f).sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    console.log(`  ${k.padEnd(36)} ${fmt({ busy: med((x) => x.busy), wall: med((x) => x.wall), late: med((x) => x.late) })}  (median of ${xs.length})`);
  }
  await link?.stop();
}

for (const m of which) await run(m as 'inline' | 'thread');
process.exit(0);
