/**
 * Run: npx tsx --test test/liqLiveFine.test.ts   (from apps/server)
 *
 * The live engine's fine layer (owner 2026-11-01: $10 and $1 "as accurate / updating as the normal
 * heatmap"): the same entries as the buckets, at the snapshot step over a hundred (BTC $1) over
 * the buckets' range (NOW_LO-NOW_HI of the price), laid out again as the price moves, streamed in the same flush - and the
 * API's feed state keeps it whole from those frames. Checked against a brute-force bucketing of the
 * engine's own positions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Venue } from '../src/valuedesk/types.js';
import { LiqLive, fineStepOf, type LiveAccount, type LiveDelta } from '../src/valuedesk/liquidations/live.js';
import { flatTiers } from '../src/valuedesk/liquidations/math.js';
import { NOW_HI, NOW_LO } from '../src/valuedesk/liquidations/levels.js';
import { LiqFeedState } from '../src/indexer/liqFeed.js';

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

const T = flatTiers(0.0125);
const VS: Venue[] = ['hyperliquid', 'lighter', 'sodex'];

/** Isolated-like books: one BTC position each, cash spread so levels fall 1-40% away. */
function books(n: number, px: number, seed = 5): Map<string, LiveAccount> {
  const r = rng(seed);
  const m = new Map<string, LiveAccount>();
  for (let k = 0; k < n; k++) {
    const long = r() < 0.5;
    const sz = 0.01 + r() * 2;
    const away = 0.01 + 0.39 * r();
    // A one-position cross account: its cash (the notional bought is out of it, sold is in it) leaves the level about `away` from the price.
    const cash = long ? -sz * px * (1 - away) : sz * px * (1 + away);
    m.set(`${VS[k % 3]}|0x${k.toString(16).padStart(40, '0')}`, { cash, priced: true, positions: [{ symbol: 'BTC', szi: long ? sz : -sz }] });
  }
  return m;
}

function engine(b: Map<string, LiveAccount>, px: { v: number }) {
  const live = new LiqLive({ account: (v, a) => b.get(`${v}|${a}`), priceOf: () => px.v, tiersOf: () => T, priceOfCoin: () => px.v });
  for (const k of b.keys()) { const [v, a] = k.split('|') as [Venue, string]; live.touch(v, a); }
  live.work(Number.MAX_SAFE_INTEGER);
  return live;
}

/** The fine layer as the deltas leave it: venue -> index -> row (rows without counts are gone). */
function apply(held: Map<Venue, Map<number, number[]>>, f: NonNullable<LiveDelta['f']>) {
  if (f.whole) held.clear();
  for (const [v, rows] of Object.entries(f.v) as Array<[Venue, number[][]]>) {
    let m = held.get(v);
    if (!m) { m = new Map(); held.set(v, m); }
    for (const r of rows) { if (!r[3] && !r[4]) m.delete(r[0]!); else m.set(r[0]!, r); }
  }
}

/** Every position the engine holds, bucketed at `st` over [lo, hi): venue -> index -> [long USD, short USD, long n, short n]. */
function brute(live: LiqLive, st: number, lo: number, hi: number) {
  const out = new Map<Venue, Map<number, number[]>>();
  for (const x of live.positionsByCoin(0, new Set()).get('BTC') ?? []) {
    if (x.liq < lo || x.liq >= hi) continue;
    let m = out.get(x.venue);
    if (!m) { m = new Map(); out.set(x.venue, m); }
    const i = Math.floor(x.liq / st);
    const b = m.get(i) ?? [0, 0, 0, 0];
    b[x.long ? 0 : 1]! += x.usd;
    b[x.long ? 2 : 3]!++;
    m.set(i, b);
  }
  return out;
}

function same(held: Map<Venue, Map<number, number[]>>, want: Map<Venue, Map<number, number[]>>, msg: string) {
  for (const v of VS) {
    const a = held.get(v) ?? new Map();
    const w = want.get(v) ?? new Map();
    assert.equal(a.size, w.size, `${msg}: ${v} cells`);
    for (const [i, x] of w) {
      const r = a.get(i);
      assert.ok(r, `${msg}: ${v} cell ${i}`);
      assert.ok(Math.abs(r[1] - x[0]!) <= 1 && Math.abs(r[2] - x[1]!) <= 1, `${msg}: ${v} USD at ${i}`);
      assert.deepEqual([r[3], r[4]], [x[2], x[3]], `${msg}: ${v} counts at ${i}`);
    }
  }
}

test('the fine layer: the engine\'s own positions at a hundredth of the snapshot step, over its reach, in the same flush', () => {
  const px = { v: 78_000 };
  const b = books(3_000, px.v);
  const live = engine(b, px);
  const d = live.flush().find((x) => x.coin === 'BTC')!;
  assert.ok(d.f?.whole, 'a new coin: its fine layer whole');
  assert.equal(d.f!.st, fineStepOf(px.v));
  assert.equal(d.f!.st, 1, 'BTC near $78K: $1');
  assert.ok(Math.abs(d.f!.lo - px.v * NOW_LO) < 1e-6 && Math.abs(d.f!.hi - px.v * NOW_HI) < 1e-6, 'over the buckets range: a step picked holds zoomed out');
  const held = new Map<Venue, Map<number, number[]>>();
  apply(held, d.f!);
  same(held, brute(live, d.f!.st, d.f!.lo, d.f!.hi), 'first');
  assert.ok([...held.values()].reduce((n, m) => n + m.size, 0) > 500, 'cells near the price');

  // An account gone and one moved: only their cells change, in the next flush.
  const [gone, moved] = [...b.keys()];
  b.delete(gone!);
  const m = b.get(moved!)!;
  b.set(moved!, { ...m, cash: (m.cash ?? 0) * 0.5 });
  for (const k of [gone!, moved!]) { const [v, a] = k.split('|') as [Venue, string]; live.touch(v, a); }
  live.work();
  const d2 = live.flush().find((x) => x.coin === 'BTC')!;
  assert.ok(d2.f && !d2.f.whole, 'a delta of the layer');
  assert.ok(Object.values(d2.f.v).reduce((n, r) => n + r!.length, 0) <= 4, 'only the cells that moved');
  apply(held, d2.f);
  same(held, brute(live, d2.f.st, d2.f.lo, d2.f.hi), 'after a change');
  assert.equal(live.flush().length, 0, 'nothing more');
});

test('the price moving a tenth lays the fine layer out again around it, whole, with every position in reach', () => {
  const px = { v: 78_000 };
  const b = books(2_000, px.v, 9);
  const live = engine(b, px);
  const d = live.flush().find((x) => x.coin === 'BTC')!;
  px.v = 78_000 * 1.12;
  // A move with no account changing: the layer follows it at the next flush, whole.
  const d2 = live.flush().find((x) => x.coin === 'BTC')!;
  assert.ok(d2.f?.whole, 'laid out again, sent whole');
  assert.notEqual(d2.f!.ep, d.f!.ep);
  assert.ok(Math.abs(d2.f!.lo - px.v * NOW_LO) < 1e-6);
  const held = new Map<Venue, Map<number, number[]>>();
  apply(held, d2.f!);
  same(held, brute(live, d2.f!.st, d2.f!.lo, d2.f!.hi), 'new layout');
  // Taking an account out after the new layout leaves nothing behind of it.
  const k = [...b.keys()].find((x) => { const [v, a] = x.split('|') as [Venue, string]; return live.positionsByCoin(0, new Set()).get('BTC')!.some((p) => p.venue === v && p.address === a && p.liq >= d2.f!.lo && p.liq < d2.f!.hi); })!;
  b.delete(k);
  const [v, a] = k.split('|') as [Venue, string];
  live.touch(v, a);
  live.work();
  apply(held, live.flush().find((x) => x.coin === 'BTC')!.f!);
  same(held, brute(live, d2.f!.st, d2.f!.lo, d2.f!.hi), 'after a removal');
});

test('the API keeps the fine layer whole from the frames; a new layout of it replaces what is held', () => {
  const s = new LiqFeedState(0);
  const changes: Array<{ fine?: { whole: boolean; venues: Map<Venue, number[]> } }> = [];
  s.on('change', (c) => changes.push(c));
  const frame = (f: object) => s.data(`${JSON.stringify({ t: 'd', coin: 'BTC', p: 78_000, st: 20, ep: 1, whole: false, v: {}, ...f })}\n`);
  frame({ whole: true, f: { st: 1, lo: 58_500, hi: 97_500, ep: 2, whole: true, v: { hyperliquid: [[70_000, 500, 0, 1, 0], [80_000, 0, 700, 0, 1]] } } });
  assert.deepEqual([...s.coins.get('BTC')!.f!.v.get('hyperliquid')!.keys()], [70_000, 80_000]);
  assert.equal(changes.at(-1)!.fine!.whole, true);
  frame({ f: { st: 1, lo: 58_500, hi: 97_500, ep: 2, whole: false, v: { hyperliquid: [[70_000, 0, 0, 0, 0], [70_001, 300, 0, 1, 0]] } } });
  assert.deepEqual([...s.coins.get('BTC')!.f!.v.get('hyperliquid')!.keys()].sort(), [70_001, 80_000]);
  assert.deepEqual(changes.at(-1)!.fine!.venues.get('hyperliquid'), [70_000, 70_001]);
  assert.equal(changes.at(-1)!.fine!.whole, false);
  // A bucket frame without a fine part keeps the layer.
  frame({ v: { hyperliquid: { b: [[3_900, 1, 0, 1, 0]] } } });
  assert.equal(s.coins.get('BTC')!.f!.v.get('hyperliquid')!.size, 2);
  // A new epoch of the layer: what was held goes.
  frame({ f: { st: 1, lo: 65_000, hi: 108_000, ep: 3, whole: false, v: { sodex: [[90_000, 0, 10, 0, 1]] } } });
  const f = s.coins.get('BTC')!.f!;
  assert.equal(f.ep, 3);
  assert.equal(f.v.get('hyperliquid'), undefined);
  assert.equal(changes.at(-1)!.fine!.whole, true);
});

test('every coin keeps its fine layer, and a reprice that leaves a position in its cells moves it in place: after drift, size changes and closes the layer and the buckets equal a brute bucketing and an engine built fresh', () => {
  const px = { v: 78_000 };
  const b = books(3_000, px.v, 21);
  // And books whose level is the venue's own (fix): it stays in its cells as the price drifts - a
  // size change moves the entry in place.
  const r0 = rng(8);
  for (let k = 0; k < 3_000; k++) {
    const long = r0() < 0.5;
    const level = px.v * (long ? 1 - 0.3 * r0() - 0.01 : 1 + 0.3 * r0() + 0.01);
    b.set(`${VS[k % 3]}|0x${(k + 1e6).toString(16).padStart(40, '0')}`, { cash: 0, priced: true, positions: [{ symbol: 'BTC', szi: (long ? 1 : -1) * (0.01 + r0()), iso: 0, fix: level }] });
  }
  const live = engine(b, px);
  const held = new Map<Venue, Map<number, number[]>>();
  apply(held, live.flush().find((x) => x.coin === 'BTC')!.f!);
  const r = rng(4);
  const keys = [...b.keys()];
  for (let round = 0; round < 30; round++) {
    // The price drifts (cross levels follow it a little: most stay in their cells), some sizes change, a few close.
    px.v *= 1 + (r() - 0.5) * 0.002;
    for (const k of keys) {
      const m = b.get(k);
      if (!m) continue;
      const u = r();
      if (u < 0.01) b.delete(k);
      else if (u < 0.05) b.set(k, { ...m, positions: m.positions.map((p) => ({ ...p, szi: p.szi * (0.9 + 0.2 * r()) })) });
      const [v, a] = k.split('|') as [Venue, string];
      live.touch(v, a);
    }
    live.work(Number.MAX_SAFE_INTEGER);
    for (const d of live.flush()) if (d.coin === 'BTC' && d.f) apply(held, d.f);
  }
  // The deltas send a cell again once it moved 1% (SEND_MOVE): the layer itself, whole.
  live.resendAll();
  const whole = live.flush().find((x) => x.coin === 'BTC')!.f!;
  assert.ok(whole.whole);
  held.clear();
  apply(held, whole);
  const fresh = engine(b, px);
  const ff = fresh.flush().find((x) => x.coin === 'BTC')!.f!;
  assert.equal(whole.st, ff.st);
  same(held, brute(live, ff.st, ff.lo, ff.hi), 'kept through 30 reprices');
  const freshHeld = new Map<Venue, Map<number, number[]>>();
  apply(freshHeld, ff);
  same(held, new Map([...freshHeld].map(([v, m]) => [v, new Map([...m].map(([i, row]) => [i, [row[1]!, row[2]!, row[3]!, row[4]!]]))])), 'as an engine built fresh');
});

test('a backlog of feed frames is worked off in slices (the API thread given back between them), ending where one piece would', async () => {
  const { LiqFeedState } = await import('../src/indexer/liqFeed.js');
  const coins = 400;
  const rows = (k: number) => Array.from({ length: 300 }, (_, i) => [i, 1000 + k + i, 500 + i, 1, 1]);
  let burst = '';
  for (let k = 0; k < coins; k++) burst += `${JSON.stringify({ t: 'd', coin: `C${k}`, p: 100 + k, st: 1, ep: 1, whole: true, v: { hyperliquid: { b: rows(k) } } })}\n`;
  burst += `${JSON.stringify({ t: 'tick', at: 1, ready: true })}\n`;
  // Split mid-line, as a socket does.
  const cut = Math.floor(burst.length / 3) + 7;
  const s = new LiqFeedState();
  let ticks = 0;
  s.on('tick', () => { ticks++; });
  s.data(burst.slice(0, cut));
  s.data(burst.slice(cut));
  // Not all of it at once: the rest waits for the next turns.
  const first = s.coins.size;
  let turns = 0;
  while (ticks === 0 && turns < 10_000) { await new Promise<void>((r) => setImmediate(r)); turns++; }
  assert.equal(ticks, 1);
  assert.equal(s.coins.size, coins);
  assert.equal(s.ready, true);
  assert.equal(s.coins.get('C7')!.v.get('hyperliquid')!.b.get(3)![0], 1010);
  assert.ok(first < coins || turns === 0, `first=${first} turns=${turns}`);
});
