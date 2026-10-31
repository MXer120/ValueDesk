/**
 * Run: npx tsx --test test/liqFine.test.ts   (from apps/server)
 *
 * Exact steps (owner 2026-10-31: "down to $1 (min tick on sodex) if the user wants"): the fine
 * route buckets the books' exact liquidation prices at any step for a price window
 * (liqRead.ts levelRows / liqHeatmapFine), at most FINE_MAX_BUCKETS of them, with the heatmap's
 * filters. Checked against a brute-force bucketing of the same positions.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LevelPos } from '../src/valuedesk/liquidations/levels.js';
import { FINE_MAX_BUCKETS } from '../src/valuedesk/liquidations/levels.js';
import { levBand, type LevBand } from '../src/valuedesk/liquidations/math.js';
import type { Venue } from '../src/valuedesk/types.js';

const dir = mkdtempSync(join(tmpdir(), 'vs-liqfine-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');
process.env.VALUESCAN_LIQ_FEED = '0';
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ } });

/** A seeded generator: the same positions every run. */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

const VS: Venue[] = ['hyperliquid', 'sodex', 'lighter'];
const P = 77_545;

/** BTC-like books: levels spread 0.7x-1.3x around the price, some without a price, some past, some unknown leverage. */
function books(n: number, seed = 7): LevelPos[] {
  const r = rng(seed);
  const out: LevelPos[] = [];
  for (let k = 0; k < n; k++) {
    const long = r() < 0.5;
    const away = 0.3 * r();
    // One in twenty past (a long priced above the price, a short below), one in twenty with no price.
    const past = r() < 0.05;
    const liq = r() < 0.05 ? null : P * (long !== past ? 1 - away : 1 + away);
    const levRoll = r();
    out.push({
      venue: VS[k % VS.length]!, address: `0x${(k % 50).toString(16).padStart(40, '0')}`, symbol: 'BTC',
      szi: (long ? 1 : -1) * (0.001 + r() * 3), liq, lev: levRoll < 0.1 ? null : 1 + levRoll * 40,
    });
  }
  return out;
}

/** The brute force: every position on its own, as the docs of levelRows say. */
function brute(levels: LevelPos[], p: number, step: number, from: number, to: number, f: { wallets?: Set<string>; side?: 'long' | 'short'; lev?: Set<LevBand> } = {}) {
  const m = new Map<number, number[]>();
  for (const l of levels) {
    if (f.wallets && !f.wallets.has(l.address)) continue;
    if (l.liq === null) continue;
    const long = l.szi > 0;
    if (long ? l.liq >= p : l.liq <= p) continue;
    if (f.side && f.side !== (long ? 'long' : 'short')) continue;
    if (f.lev) { const b = levBand(l.lev); if (b === null || !f.lev.has(b)) continue; }
    if (l.liq < from || l.liq >= to) continue;
    const i = Math.floor(l.liq / step);
    const b = m.get(i) ?? [0, 0, 0, 0];
    const usd = Math.abs(l.szi) * l.liq;
    if (long) { b[0]! += usd; b[2]!++; } else { b[1]! += usd; b[3]!++; }
    m.set(i, b);
  }
  return [...m].sort((a, b) => a[0] - b[0]);
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

function sameAs(rows: number[][], want: Array<[number, number[]]>, msg: string) {
  assert.equal(rows.length, want.length, `${msg}: buckets`);
  rows.forEach((r, k) => {
    const [i, w] = want[k]!;
    assert.equal(r[0], i, `${msg}: index`);
    assert.ok(near(r[1]!, w[0]!) && near(r[2]!, w[1]!), `${msg}: USD at ${i}`);
    assert.equal(r[3], w[2], `${msg}: long n at ${i}`);
    assert.equal(r[4], w[3], `${msg}: short n at ${i}`);
  });
}

test('the fine route asks: a step and a window, never more than FINE_MAX_BUCKETS buckets of it', async () => {
  const { fineAskOf } = await import('../src/indexer/liqRead.js');
  assert.equal(fineAskOf({}), null, 'no step: the stream-width heatmap as before');
  assert.equal(fineAskOf({ step: '' }), null);
  assert.deepEqual(fineAskOf({ step: '1', from: '76000', to: '80000' }), { step: 1, from: 76_000, to: 80_000 }, '4,000 buckets: the cap itself');
  assert.match(String(fineAskOf({ step: '1', from: '76000', to: '80001' })), /at most 4000/, 'one past the cap');
  assert.equal(FINE_MAX_BUCKETS, 4_000);
  assert.match(String(fineAskOf({ step: '0.1', from: '0', to: '1000' })), /at most/, 'a fine step over a wide window');
  assert.ok(typeof fineAskOf({ step: '0.0001', from: '0.07', to: '0.08' }) === 'object', 'a cheap coin at its tick: 100 buckets');
  for (const bad of [{ step: '0', from: '1', to: '2' }, { step: '-1', from: '1', to: '2' }, { step: 'x', from: '1', to: '2' }, { step: '1', from: '5', to: '5' }, { step: '1', from: '-1', to: '5' }, { step: '1' }]) {
    assert.equal(typeof fineAskOf(bad), 'string', JSON.stringify(bad));
  }
});

test('fine buckets match a brute-force bucketing of the same positions, at $1, $10 and $100', async () => {
  const { levelRows } = await import('../src/indexer/liqRead.js');
  const lv = books(3_000);
  for (const [step, from, to] of [[1, 75_545, 79_545], [10, 60_000, 95_000], [100, 0, 400_000], [0.5, 77_000, 78_000]] as const) {
    const r = levelRows(lv, P, step, from, to);
    sameAs(r.buckets, brute(lv, P, step, from, to), `$${step}`);
    // Every priced, not-past level is in a bucket or outside: nothing lost, nothing counted twice.
    const inside = r.buckets.reduce((a, b) => a + b[1] + b[2], 0);
    const all = brute(lv, P, step, 0, Infinity).reduce((a, [, b]) => a + b[0]! + b[1]!, 0);
    assert.ok(near(inside + r.outside.long + r.outside.short, all), `$${step}: inside + outside = every level`);
  }
});

test('the coverage counts every position of the wallets kept; past and no-price sizes are counted, not bucketed', async () => {
  const { levelRows } = await import('../src/indexer/liqRead.js');
  const lv = books(600, 11);
  const r = levelRows(lv, P, 1, P * 0.99, P * 1.01);
  for (const v of VS) {
    const mine = lv.filter((l) => l.venue === v);
    const c = r.counts.get(v)!;
    assert.equal(c.positions, mine.length, `${v}: positions`);
    const past = mine.filter((l) => l.liq !== null && (l.szi > 0 ? l.liq >= P : l.liq <= P)).reduce((a, l) => a + Math.abs(l.szi), 0);
    assert.ok(near(c.past, past), `${v}: past size`);
  }
});

test('filters: wallets, side and leverage bands, as the heatmap and the wallet lists apply them', async () => {
  const { levelRows } = await import('../src/indexer/liqRead.js');
  const lv = books(2_000, 3);
  const wallets = new Set(lv.slice(0, 5).map((l) => l.address));
  const cases: Array<[string, Parameters<typeof brute>[5]]> = [
    ['wallets', { wallets }],
    ['longs', { side: 'long' }],
    ['shorts', { side: 'short' }],
    ['high leverage', { lev: new Set<LevBand>([2]) }],
    ['low and mid, shorts, two wallets', { lev: new Set<LevBand>([0, 1]), side: 'short', wallets }],
  ];
  for (const [name, f] of cases) {
    const r = levelRows(lv, P, 5, 60_000, 95_000, { wallets: f!.wallets ?? null, side: f!.side ?? null, lev: f!.lev ?? null });
    const want = brute(lv, P, 5, 60_000, 95_000, f);
    sameAs(r.buckets, want, name);
    assert.ok(want.length > 0, `${name}: the case holds levels`);
  }
  // A side filter keeps no bucket of the other side; a band filter leaves out unknown leverage.
  const longs = levelRows(lv, P, 5, 60_000, 95_000, { side: 'long' });
  assert.ok(longs.buckets.every((b) => b[2] === 0 && b[4] === 0));
  const hi = levelRows(lv, P, 5, 0, Infinity, { lev: new Set<LevBand>([2]) });
  const unknown = levelRows([{ venue: 'sodex', address: '0x1', symbol: 'BTC', szi: 1, liq: P * 0.9, lev: null }], P, 5, 0, Infinity, { lev: new Set<LevBand>([2]) });
  assert.equal(unknown.buckets.length, 0, 'unknown leverage only with every band');
  // The bands of a row add to its side (every position here has its leverage known or not at all).
  for (const b of hi.buckets) assert.ok(near((b[5] ?? 0) + (b[6] ?? 0) + (b[7] ?? 0), b[1]) && near((b[8] ?? 0) + (b[9] ?? 0) + (b[10] ?? 0), b[2]));
});

test('no price: nothing is bucketed (a past level cannot be told), every position still counted', async () => {
  const { levelRows } = await import('../src/indexer/liqRead.js');
  const lv = books(100);
  const r = levelRows(lv, null, 1, 0, Infinity);
  assert.equal(r.buckets.length, 0);
  assert.equal([...r.counts.values()].reduce((a, c) => a + c.positions, 0), 100);
});
