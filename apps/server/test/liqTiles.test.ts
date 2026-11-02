/**
 * Run: npx tsx --test test/liqTiles.test.ts   (from apps/server)
 *
 * The historical heatmap in tiles (indexer/liqTiles.ts; owner 2026-11-01: "only what the user sees
 * gets loaded"): the bands of a slot hold exactly the rows the one-piece history sends (liqRead.ts
 * liqHistory), the index lists exactly its snapshots, a slot still filling is never final, and a
 * snapshot is parsed once until it is written again.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vs-liqtiles-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ } });

const Q = 15 * 60_000;
const H = 3_600_000;

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

/** A snapshot as the indexer writes one (levels.ts LiqSnap): rows 0.2x-3x the price, some with bands, some past the price. */
function snapOf(p: number, st: number, seed: number) {
  const r = rng(seed);
  const v: Record<string, number[][]> = {};
  for (const venue of ['hyperliquid', 'sodex', 'lighter']) {
    const rows = new Map<number, number[]>();
    for (let k = 0; k < 400; k++) {
      const px = p * (0.2 + 2.8 * r() ** 2);
      const i = Math.floor(px / st);
      const long = px < p !== r() < 0.05;
      const usd = Math.round(100 + r() ** 3 * 5e6);
      const row = rows.get(i) ?? [i, 0, 0];
      row[long ? 1 : 2]! += usd;
      if (r() < 0.6) { const at = (long ? 3 : 6) + Math.floor(r() * 3); while (row.length <= at) row.push(0); row[at]! += usd; }
      rows.set(i, row);
    }
    v[venue] = [...rows.values()].sort((a, b) => a[0]! - b[0]!);
  }
  return { p, st, v };
}

test('bands, slots and the index give back exactly the one-piece history', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const { liqHistory } = await import('../src/indexer/liqRead.js');
  const T = await import('../src/indexer/liqTiles.js');
  const s = new IndexStore(process.env.VALUESCAN_INDEX_DB!);
  const now = Date.now();
  // 2 days of 15-minute snapshots, the step changing once (0.25% -> 0.125% of the price, as on 2026-10-31).
  const t0 = Math.floor((now - 2 * 86_400_000) / Q) * Q;
  const ts: number[] = [];
  for (let t = t0; t <= now - Q; t += Q) ts.push(t);
  ts.forEach((t, k) => {
    const p = 78_000 + 2_000 * Math.sin(k / 20);
    s.putLiqHist(t, [['BTC', JSON.stringify(snapOf(p, k < ts.length / 2 ? 200 : 100, k + 1))], ['ETH', JSON.stringify(snapOf(3_000, 5, k + 7))]]);
  });
  const venues = ['hyperliquid', 'sodex'] as const;
  const whole = liqHistory('BTC', [...venues], '30d')!;
  assert.equal(whole.points.length, ts.length);

  const idx = (await T.liqTileIndex('BTC', [...venues], now))!;
  assert.deepEqual(idx.points, whole.points.map((q) => ({ t: q.t, p: q.p, st: q.st })), 'the index lists every snapshot');
  assert.equal(idx.newest, ts.at(-1));
  assert.equal(idx.bw, T.bandWidth(whole.points.at(-1)!.p));
  assert.ok(T.isBandWidth(idx.bw) && idx.bw % 200 === 0 && idx.bw % 100 === 0, 'a band is a whole number of every step');
  assert.equal(Object.keys(idx.scale).length, 21, 'a scale for each side and leverage filter');

  for (const tl of [0, 1]) {
    for (const pl of [0, 2]) {
      const span = T.bandSpan(idx.bw, pl);
      const got = new Map<number, number[][]>();
      for (let tt = Math.floor(t0 / T.tileMs(tl)) * T.tileMs(tl); tt <= now; tt += T.tileMs(tl)) {
        const bands = new Set<number>();
        for (const q of whole.points) for (const r of q.b) bands.add(T.bandOf(r[0], q.st, span));
        for (const band of bands) {
          const tile = (await T.liqTile('BTC', [...venues], { tl, tt, pl, band, bw: idx.bw }))!;
          for (const q of tile.points) {
            assert.ok(q.t >= tt && q.t < tt + T.tileMs(tl), 'a tile holds its own slot');
            for (const r of q.b) assert.ok(r[0] * q.st >= band * span - 1e-6 && r[0] * q.st < (band + 1) * span, 'and its own band');
            got.set(q.t, [...(got.get(q.t) ?? []), ...q.b]);
          }
        }
      }
      for (const q of whole.points) {
        const rows = (got.get(q.t) ?? []).sort((a, b) => a[0]! - b[0]!);
        assert.deepEqual(rows, q.b, `tl ${tl} pl ${pl}: snapshot ${q.t} whole`);
      }
    }
  }
  s.close();
});

test('a slot still filling is final only up to a snapshot that exists; a passed slot is final', async () => {
  const T = await import('../src/indexer/liqTiles.js');
  const idx = (await T.liqTileIndex('ETH', ['hyperliquid']))!;
  const newest = idx.newest!;
  const ms = T.tileMs(0);
  const cur = Math.floor(newest / ms) * ms;
  const open = (await T.liqTile('ETH', ['hyperliquid'], { tl: 0, tt: cur, pl: 0, band: 0, bw: idx.bw }))!;
  assert.equal(open.final, false, 'the newest slot, asked without v=, may still grow');
  const upTo = (await T.liqTile('ETH', ['hyperliquid'], { tl: 0, tt: cur, pl: 0, band: 0, bw: idx.bw, v: newest }))!;
  assert.equal(upTo.final, true, 'up to the newest snapshot, it can no longer change');
  const ahead = (await T.liqTile('ETH', ['hyperliquid'], { tl: 0, tt: cur, pl: 0, band: 0, bw: idx.bw, v: newest + Q }))!;
  assert.equal(ahead.final, false, 'up to a snapshot not written yet: not final');
  const past = (await T.liqTile('ETH', ['hyperliquid'], { tl: 0, tt: cur - ms, pl: 0, band: 0, bw: idx.bw }))!;
  assert.equal(past.final, true);
  assert.ok(past.points.length > 0);
});

test('the asks the route takes, and the round band widths', async () => {
  const T = await import('../src/indexer/liqTiles.js');
  const now = Date.UTC(2026, 10, 1, 18);
  const tt = Math.floor(now / T.tileMs(1)) * T.tileMs(1);
  assert.deepEqual(T.tileAskOf({ tl: '1', tt: String(tt), pl: '0', band: '15', bw: '5000' }, now), { tl: 1, tt, pl: 0, band: 15, bw: 5000 });
  assert.equal(typeof T.tileAskOf({ tl: '1', tt: String(tt + H), pl: '0', band: '15', bw: '5000' }, now), 'string', 'not a slot start');
  assert.equal(typeof T.tileAskOf({ tl: '0', tt: String(tt), pl: '0', band: '15', bw: '3000' }, now), 'string', 'not a round width');
  assert.equal(typeof T.tileAskOf({ tl: '3', tt: String(tt), pl: '0', band: '1', bw: '5000' }, now), 'string', 'no such level');
  assert.equal(typeof T.tileAskOf({ tl: '0', tt: String(tt - 40 * 86_400_000), pl: '0', band: '1', bw: '5000' }, now), 'string', 'older than the history');
  assert.equal(T.bandWidth(77_924), 5000);
  assert.equal(T.bandWidth(3_000), 200);
  assert.equal(T.bandWidth(180), 10);
  assert.equal(T.bandWidth(0.0412), 0.002);
  assert.equal(T.bandOf(437, 200, 5000), 17, '437 x $200 = $87,400: the band from $85,000');
  assert.equal(T.bandOf(874, 100, 5000), 17);
  assert.equal(T.bandOf(16, 0.0025, 0.02), 2, 'small steps stay exact');
});

test('a snapshot is parsed once, and again when it is written again', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const T = await import('../src/indexer/liqTiles.js');
  T.resetLiqTiles();
  const s = new IndexStore(process.env.VALUESCAN_INDEX_DB!);
  const t = Math.floor((Date.now() - H) / Q) * Q;
  s.putLiqHist(t, [['SOL', JSON.stringify({ p: 180, st: 0.25, v: { hyperliquid: [[700, 1000, 0]] } })]]);
  const a = (await T.liqTileIndex('SOL', ['hyperliquid']))!;
  assert.equal(a.points.at(-1)!.p, 180);
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = ((text: string, rev?: Parameters<typeof JSON.parse>[1]) => { parsed++; return parse(text, rev); }) as typeof JSON.parse;
  try {
    await T.liqTileIndex('SOL', ['hyperliquid'], Date.now() + 20_000);
    assert.equal(parsed, 0, 'held: not parsed again');
    s.putLiqHist(t, [['SOL', JSON.stringify({ p: 181.5, st: 0.25, v: { hyperliquid: [[700, 1000, 0], [701, 5, 0]] } })]]);
    const b = (await T.liqTileIndex('SOL', ['hyperliquid'], Date.now() + 40_000))!;
    assert.equal(parsed, 1, 'written again: parsed again');
    assert.equal(b.points.at(-1)!.p, 181.5);
  } finally {
    JSON.parse = parse;
  }
  s.close();
});

test('after a restart the index reads the metas file, not the snapshots, and answers the same', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const T = await import('../src/indexer/liqTiles.js');
  process.env.VALUESCAN_LIQ_METAS_FILE = join(dir, 'metas.json');
  try {
    T.resetLiqTiles();
    const s = new IndexStore(process.env.VALUESCAN_INDEX_DB!);
    const t0 = Math.floor((Date.now() - 30 * H) / Q) * Q;
    for (let i = 0; i < 12; i++) s.putLiqHist(t0 + i * 2 * H, [['DOGE', JSON.stringify(snapOf(0.2 + i * 0.001, 0.0005, 900 + i))]]);
    const venues = ['hyperliquid', 'sodex'] as const;
    const a = (await T.liqTileIndex('DOGE', [...venues]))!;
    await T.saveLiqMetas();
    T.resetLiqTiles(); // the API restarted
    const parse = JSON.parse;
    const texts: number[] = [];
    JSON.parse = ((text: string, rev?: Parameters<typeof JSON.parse>[1]) => { texts.push(text.length); return parse(text, rev); }) as typeof JSON.parse;
    let b;
    try {
      b = (await T.liqTileIndex('DOGE', [...venues], Date.now() + 20_000))!;
    } finally {
      JSON.parse = parse;
    }
    assert.equal(texts.length, 1, 'one parse: the metas file, no snapshot');
    assert.deepEqual(b.points, a.points);
    assert.deepEqual(b.scale, a.scale);
    // An older snapshot written again is listed again at the next full listing (RELIST_MS: the
    // newest is listed on every ask) and parsed again then (its length moved).
    s.putLiqHist(t0, [['DOGE', JSON.stringify(snapOf(0.25, 0.0005, 1))]]);
    const held = (await T.liqTileIndex('DOGE', [...venues], Date.now() + 40_000))!;
    assert.equal(held.points[0]!.p, a.points[0]!.p, 'within RELIST_MS: the listing held');
    const c = (await T.liqTileIndex('DOGE', [...venues], Date.now() + T.RELIST_MS + 40_000))!;
    assert.equal(c.points[0]!.p, 0.25);
    s.close();
  } finally {
    delete process.env.VALUESCAN_LIQ_METAS_FILE;
    T.resetLiqTiles();
  }
});

test('some wallets: their index and tiles are cut from one rebuilt history and give it back exactly', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const { liqHistory } = await import('../src/indexer/liqRead.js');
  const T = await import('../src/indexer/liqTiles.js');
  const s = new IndexStore(process.env.VALUESCAN_INDEX_DB!);
  const now = Date.now();
  const listed = liqHistory('BTC', ['hyperliquid', 'sodex'], '30d')!.points;
  const W = [`0x${'a'.repeat(40)}`, `0x${'b'.repeat(40)}`];
  // Two wallets open, move and close levels across the snapshots on sodex (0), hyperliquid (1) and arcus (4, not asked: left out) - types.ts VENUES.
  const r = rng(21);
  let ids = new Map<string, number>();
  for (let k = 0; k < listed.length; k += 7) {
    const t = listed[k]!.t;
    const changed = W.flatMap((w, j) => [0, 1, 4].map((venue) => ({ aid: ids.get(w) ?? w, coin: 'BTC', venue, side: (j + venue) % 2 ? 1 : -1, liq: 78_000 * (0.3 + 2.5 * r()), usd: Math.round(1_000 + r() * 2e6), lev: 3 + r() * 40 })));
    const got = s.putLiqLog(t, k ? [] : W, changed, k % 21 === 14 ? [{ aid: ids.get(W[0]!)!, coin: 'BTC', venue: 1 }] : []);
    if (!k) ids = got;
  }
  const venues = ['hyperliquid', 'sodex'];
  const whole = liqHistory('BTC', venues as never, '30d', W)!;
  assert.ok(whole.points.length > 10, 'the wallets hold levels in many snapshots');
  const idx = (await T.liqTileIndexOf('BTC', venues as never, W, now))!;
  assert.deepEqual(idx.points, whole.points.map((q) => ({ t: q.t, p: q.p, st: q.st })), 'the index lists their snapshots');
  assert.deepEqual(idx.scale, T.histScales(whole.points.map((q) => ({ st: q.st, sc: T.snapScales(q.b) }))), 'their scales');
  assert.equal(Object.keys(idx.scale).length, 21);
  for (const pl of [0, 1]) {
    const span = T.bandSpan(idx.bw, pl);
    const got = new Map<number, number[][]>();
    for (let tt = Math.floor(whole.points[0]!.t / T.tileMs(0)) * T.tileMs(0); tt <= now; tt += T.tileMs(0)) {
      const bands = new Set<number>();
      for (const q of whole.points) for (const row of q.b) bands.add(T.bandOf(row[0], q.st, span));
      for (const band of bands) {
        const tile = (await T.liqTileOf('BTC', venues as never, W, { tl: 0, tt, pl, band, bw: idx.bw }, now))!;
        for (const q of tile.points) got.set(q.t, [...(got.get(q.t) ?? []), ...q.b]);
      }
    }
    for (const q of whole.points) assert.deepEqual((got.get(q.t) ?? []).sort((a, b) => a[0]! - b[0]!), q.b, `pl ${pl}: snapshot ${q.t}`);
  }
  // Rebuilt once: a new level within WALLET_HIST_MS is not in the answers held; after it, it is.
  s.putLiqLog(listed.at(-1)!.t, [], [{ aid: ids.get(W[1]!)!, coin: 'BTC', venue: 1, side: 1, liq: 50_000, usd: 7_777_777 }], []);
  const held = (await T.liqTileIndexOf('BTC', venues as never, W, now + 1_000))!;
  assert.deepEqual(held.scale, idx.scale, 'the same answer within the minute');
  T.resetWalletTiles();
  s.close();
});

test('an index ask lists only from the newest snapshot held on, and still sees one added since', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const T = await import('../src/indexer/liqTiles.js');
  T.resetLiqTiles();
  const s = new IndexStore(process.env.VALUESCAN_INDEX_DB!);
  const t0 = Math.floor((Date.now() - 10 * H) / Q) * Q;
  for (let i = 0; i < 6; i++) s.putLiqHist(t0 + i * H, [['WIF', JSON.stringify(snapOf(2 + i * 0.01, 0.005, 300 + i))]]);
  const meta = IndexStore.prototype.liqHistMeta;
  const froms: number[] = [];
  IndexStore.prototype.liqHistMeta = function (this: InstanceType<typeof IndexStore>, coin: string, from: number, to: number) { if (coin === 'WIF') froms.push(from); return meta.call(this, coin, from, to); };
  try {
    const a = (await T.liqTileIndex('WIF', ['hyperliquid']))!;
    assert.equal(a.points.length, 6);
    s.putLiqHist(t0 + 6 * H, [['WIF', JSON.stringify(snapOf(2.1, 0.005, 400))]]);
    const b = (await T.liqTileIndex('WIF', ['hyperliquid'], Date.now() + 20_000))!;
    assert.equal(b.points.length, 7, 'the new snapshot is in');
    assert.equal(froms.length, 2);
    assert.equal(froms[1], t0 + 5 * H, 'the second ask lists from the newest held on');
  } finally {
    IndexStore.prototype.liqHistMeta = meta;
    s.close();
    T.resetLiqTiles();
  }
});
