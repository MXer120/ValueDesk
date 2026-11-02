/**
 * The historical heatmap's wallet filter at a fine step (liqRead.ts walletHistoryFine): exactly the
 * $100 history of those wallets, finer (owner 2026-11-02: "The fine steps need to be EXACTLY like
 * $100 just finer steps. No feature missing"). Summed back to the snapshots' step, every cell equals
 * liqHistory's with the same wallets - longs, shorts and leverage bands.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vs-liqwalletfine-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ } });

const Q = 15 * 60_000;
const P = 78_000;
const W = Array.from({ length: 6 }, (_, k) => `0x${String(k + 1).repeat(40)}`);

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

test('wallets at $1 and $10, summed to $100: every snapshot\'s cells as the $100 wallet history has them', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const { liqHistory, walletHistoryFine } = await import('../src/indexer/liqRead.js');
  const s = new IndexStore(process.env.VALUESCAN_INDEX_DB!);
  const t0 = Math.floor((Date.now() - 6 * 3_600_000) / Q) * Q;
  const r = rng(11);
  const snaps: Array<{ t: number; p: number }> = [];
  let ids = new Map<string, number>();
  for (let k = 0; k < 20; k++) {
    const t = t0 + k * Q;
    const p = P + 400 * Math.sin(k / 3);
    snaps.push({ t, p });
    s.putLiqHist(t, [['BTC', JSON.stringify({ p, st: 100, v: {} })]]);
    // Each step some positions move, open or close, on two venues, with and without leverage data.
    const changed = W.flatMap((w, i) => {
      if (k > 0 && r() < 0.4) return [];
      const long = i % 2 === 0;
      const liq = P * (long ? 1 - 0.05 * r() : 1 + 0.05 * r());
      return [{ aid: ids.get(w) ?? w, coin: 'BTC', venue: i % 3 === 0 ? 1 : 0, side: long ? 1 : -1, liq, usd: Math.round(1_000 + r() * 2e6), sz: 1, mark: p, iso: r() < 0.5, lev: r() < 0.8 ? 1 + r() * 40 : null, eq: 1e6 }];
    });
    const closed = k > 3 && r() < 0.3 && ids.has(W[1]!) ? [{ aid: ids.get(W[1]!)!, coin: 'BTC', venue: 0 }] : [];
    const got = s.putLiqLog(t, k === 0 ? W : [], changed, closed);
    if (k === 0) ids = got;
  }
  const venues = ['hyperliquid', 'sodex'] as const;
  const wallets = W.slice(0, 5);
  const h100 = liqHistory('BTC', [...venues], '1d', wallets)!;
  assert.ok(h100.points.length > 10);
  for (const step of [1, 10]) {
    const fine = walletHistoryFine('BTC', [...venues], wallets, snaps, { step, from: 60_000, to: 100_000 })!;
    assert.equal(fine.points.length, snaps.length, 'every snapshot answered');
    for (const q of h100.points) {
      const f = fine.points.find((x) => x.t === q.t)!;
      const sum = new Map<number, number[]>();
      for (const row of f.b) {
        const i = Math.floor((row[0] * step) / 100 + 1e-9);
        const a = sum.get(i) ?? [0, 0, 0, 0, 0, 0, 0, 0];
        for (let c = 1; c < 9; c++) a[c - 1]! += row[c] ?? 0;
        sum.set(i, a);
      }
      const want = new Map(q.b.map((row) => [row[0], Array.from({ length: 8 }, (_, c) => row[c + 1] ?? 0)]));
      assert.deepEqual([...sum.keys()].sort(), [...want.keys()].sort(), `cells at ${new Date(q.t).toISOString()}, $${step}`);
      for (const [i, a] of want) a.forEach((v, c) => assert.ok(Math.abs(sum.get(i)![c]! - v) < 1e-6, `cell ${i} column ${c}, $${step}`));
    }
  }
  s.close();
});
