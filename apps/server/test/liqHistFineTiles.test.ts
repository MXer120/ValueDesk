/**
 * The historical heatmap's fine tiles (liqRead.ts liqHistoryFine with FineDraw): every snapshot a
 * bar draws has its fine levels however wide the window (owner 2026-11-02: "Granulairity selected
 * but sometimes it just doesnt load the granularity everywhere"), the one per bar the chart draws,
 * pooled to the pixel by the strongest cell as the view counts it.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fineBandWidth, fineBands, fineSnapOf, type FinePos, type SnapRow } from '../src/valuedesk/liquidations/levels.js';
import type { Venue } from '../src/valuedesk/types.js';

const dir = mkdtempSync(join(tmpdir(), 'vs-liqfinetiles-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ } });

const Q = 15 * 60_000;
const H = 3_600_000;
const P = 77_929;
const VS: Venue[] = ['hyperliquid', 'sodex', 'lighter'];

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}
function positions(n: number, seed: number): FinePos[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, k) => {
    const long = r() < 0.5;
    const away = 0.1 * r();
    return { venue: VS[k % VS.length]!, long, liq: P * (long ? 1 - away : 1 + away), usd: 100 + r() * 50_000, band: Math.floor(r() * 4) - 1 };
  });
}

/** `n` 15-minute snapshots' fine bands from `t0`, each its own positions. */
async function seed(n: number, t0: number, per: number) {
  const { IndexStore } = await import('../src/indexer/store.js');
  const s = new IndexStore(process.env.VALUESCAN_INDEX_DB!);
  for (let k = 0; k < n; k++) {
    const bands = fineBands(fineSnapOf(P, 100, positions(per, k + 1), 1)!, fineBandWidth(P));
    s.putLiqHistFineBands(t0 + k * Q, bands.map((b): [string, number, number, Uint8Array] => ['BTC', b.lo, b.hi, deflateRawSync(JSON.stringify(b.f))]));
  }
  s.close();
}

const T0 = 1_000 * H;
const N = 96;

test('a tile: every snapshot of a wide window at the step, where the one answer stopped at 80k rows', async () => {
  await seed(N, T0, 1_500);
  const { liqHistoryFine, FINE_HIST_MAX_ROWS } = await import('../src/indexer/liqRead.js');
  const ask = { step: 1, from: P * 0.9, to: P * 1.1 };
  const whole = liqHistoryFine('BTC', VS, T0, T0 + N * Q, ask)!;
  assert.ok(whole.cut !== null && whole.points.length < N, `the one answer is cut (${whole.points.length} of ${N}): the case that drew $100`);
  const rows = whole.points.reduce((n, q) => n + q.b.length, 0);
  assert.ok(rows <= FINE_HIST_MAX_ROWS);
  const tile = liqHistoryFine('BTC', VS, T0, T0 + N * Q, ask, { every: 0, off: 0, pool: 0, side: 'both', lev: null })!;
  assert.equal(tile.cut, null);
  assert.equal(tile.points.length, N, 'every snapshot');
  assert.ok(tile.points.every((q) => q.st === 1));
});

test('one snapshot per bar: the newest in each, the one the chart draws for it (snapshotFor)', async () => {
  const { liqHistoryFine } = await import('../src/indexer/liqRead.js');
  const ask = { step: 10, from: P * 0.95, to: P * 1.05 };
  const times = Array.from({ length: N }, (_, k) => T0 + k * Q);
  for (const [every, off] of [[H, 0], [4 * H, 0], [H, 30 * 60_000], [Q, 0], [86_400_000, 0]] as const) {
    const got = liqHistoryFine('BTC', VS, T0, T0 + N * Q, ask, { every, off, pool: 0, side: 'both', lev: null })!;
    // The chart: each bar [b, b + every) draws the last snapshot before its end (web liqHeatIndicator.ts snapshotFor).
    const want = new Set<number>();
    for (let b = Math.floor((T0 - off) / every) * every + off; b < T0 + N * Q; b += every) {
      const inBar = times.filter((t) => t >= b && t < b + every);
      if (inBar.length) want.add(inBar.at(-1)!);
    }
    assert.deepEqual(got.points.map((q) => q.t), [...want].sort((a, b) => a - b), `every ${every / 60_000} min, off ${off / 60_000}`);
  }
});

test('pooled: the strongest cell of each group as the view counts it (side, leverage), the rest left out', async () => {
  const { liqHistoryFine, shownValue } = await import('../src/indexer/liqRead.js');
  const ask = { step: 1, from: P * 0.95, to: P * 1.05 };
  const full = liqHistoryFine('BTC', VS, T0, T0 + 4 * Q, ask, { every: 0, off: 0, pool: 0, side: 'both', lev: null })!;
  for (const [side, lev] of [['both', null], ['long', null], ['short', new Set([2] as const)], ['both', new Set([0, 1] as const)]] as const) {
    const pooled = liqHistoryFine('BTC', VS, T0, T0 + 4 * Q, ask, { every: 0, off: 0, pool: 8, side, lev })!;
    assert.equal(pooled.points.length, full.points.length);
    pooled.points.forEach((q, k) => {
      const groups = new Map<number, SnapRow[]>();
      for (const r of full.points[k]!.b) { const g = Math.floor(r[0] / 8); groups.set(g, [...(groups.get(g) ?? []), r]); }
      assert.equal(q.b.length, groups.size, 'a row per group');
      for (const r of q.b) {
        const g = groups.get(Math.floor(r[0] / 8))!;
        assert.ok(g.some((x) => x[0] === r[0]), 'a cell as it is, at the step');
        assert.equal(shownValue(r, side, lev), Math.max(...g.map((x) => shownValue(x, side, lev))), 'the strongest of its group');
      }
    });
  }
});

test('the asks: pool a whole number of steps, every a bar length', async () => {
  const { fineDrawOf } = await import('../src/indexer/liqRead.js');
  assert.equal(fineDrawOf({}, 10), null);
  assert.deepEqual(fineDrawOf({ every: '3600000', off: '-900000', pool: '40', side: 'long', lev: 'high' }, 10), { every: H, off: H - Q, pool: 40, side: 'long', lev: new Set([2]) });
  assert.equal(typeof fineDrawOf({ pool: '25' }, 10), 'string');
  assert.equal(typeof fineDrawOf({ every: '-1' }, 10), 'string');
});
