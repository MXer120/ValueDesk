/**
 * Run: npx tsx --test test/liqLiveFine.test.ts   (from apps/server)
 *
 * The live engine's fine layer (owner 2026-11-01: $10 and $1 "as accurate / updating as the normal
 * heatmap"): the same entries as the buckets, at the snapshot step over a hundred (BTC $1) over
 * FINE_REACH of the price, laid out again as the price moves, streamed in the same flush - and the
 * API's feed state keeps it whole from those frames. Checked against a brute-force bucketing of the
 * engine's own positions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Venue } from '../src/valuedesk/types.js';
import { FINE_REACH, LiqLive, fineStepOf, type LiveAccount, type LiveDelta } from '../src/valuedesk/liquidations/live.js';
import { flatTiers } from '../src/valuedesk/liquidations/math.js';
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
  assert.ok(Math.abs(d.f!.lo - px.v * (1 - FINE_REACH)) < 1e-6 && Math.abs(d.f!.hi - px.v * (1 + FINE_REACH)) < 1e-6);
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
  assert.ok(Math.abs(d2.f!.lo - px.v * (1 - FINE_REACH)) < 1e-6);
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
