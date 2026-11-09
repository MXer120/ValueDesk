/**
 * Run: npx tsx --test test/liqWsDelta.test.ts   (from apps/server)
 *
 * The heatmap socket's per-second delta looks up only the changed buckets' cells (routes/liqWs.ts deltaFor, fineRows),
 * and gives what walking every held bucket gave.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VALUESCAN_LIQ_FEED = '0';

test('a delta from the changed cells only is the sum walking every bucket gives, on both paths', async () => {
  const { liqFeed } = await import('../src/indexer/liqFeed.js');
  const { _deltaFor, _fineRows } = await import('../src/routes/liqWs.js');
  const feed = liqFeed();
  const rows = (n: number, off: number) => Array.from({ length: n }, (_, i) => [i * 3, 100 + off + i, 50 + i, 1, 1]);
  const fine = (n: number) => Array.from({ length: n }, (_, i) => [1000 + i, 10 + i, 5, 1, 1]);
  // A large frame is written in turns (liqFeed.ts, 2026-11-09): read the coin once its change is out, not right after the
  // hand-in - GitHub's runner was slow enough to read it before the first turn (v0.2.201's CI).
  const applied = new Promise((r) => feed.once('change', r));
  feed.data(`${JSON.stringify({ t: 'd', coin: 'BTC', p: 1, st: 1, ep: 1, whole: true, v: { hyperliquid: { b: rows(2000, 0) }, sodex: { b: rows(1500, 7) } }, f: { st: 1, lo: 1000, hi: 3000, ep: 1, whole: true, v: { hyperliquid: fine(1500), sodex: fine(900) } } })}\n`);
  await applied;
  const brute = (k: number, idx: Set<number>) => {
    const out = new Map<number, number[]>();
    for (const v of ['hyperliquid', 'sodex'] as const) {
      for (const [i, y] of feed.coins.get('BTC')!.v.get(v)!.b) {
        const j = Math.floor(i / k);
        if (!idx.has(j)) continue;
        const x = out.get(j);
        if (x) y.forEach((z, n) => { x[n + 1] = (x[n + 1] ?? 0) + z; }); else out.set(j, [j, ...y]);
      }
    }
    return out;
  };
  for (const [k, changed] of [[10, [30, 31, 300]], [1, [3, 6, 4500]], [1000, [0, 3000, 5999]]] as Array<[number, number[]]>) {
    const g = { coin: 'BTC', venues: ['hyperliquid', 'sodex'], k, conns: new Set(), snapAt: 0, sent: new Map(), fine: null, fineSent: new Map() };
    const ch = { b: new Map([['hyperliquid', new Set(changed)], ['sodex', new Set(changed)]]), c: new Set() };
    const msg = JSON.parse(_deltaFor(g as never, ch as never)!) as { b: number[][] };
    const idx = new Set(changed.map((i) => Math.floor(i / k)));
    const want = brute(k, idx);
    assert.equal(msg.b.length, want.size, `k=${k}`);
    for (const r of msg.b) assert.deepEqual(r.slice(0, 3), [r[0], Math.round(want.get(r[0]!)![1]!), Math.round(want.get(r[0]!)![2]!)], `k=${k} j=${r[0]}`);
  }
  const g = { coin: 'BTC', venues: ['hyperliquid', 'sodex'], k: 1, conns: new Set(), snapAt: 0, sent: new Map(), fine: { k: 4, from: 1000, to: 3000 }, fineSent: new Map() };
  const all = _fineRows(g as never, null);
  const only = new Set([250, 251, 400]);
  const some = _fineRows(g as never, only);
  assert.deepEqual([...some.keys()].sort(), [...only].filter((j) => all.has(j)).sort());
  for (const j of some.keys()) assert.deepEqual(some.get(j), all.get(j));
  feed.stop();
});
