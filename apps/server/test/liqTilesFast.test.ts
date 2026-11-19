/**
 * Run: npx tsx --test test/liqTilesFast.test.ts   (from apps/server)
 *
 * The heatmap tiles' phone pass (2026-11-17, indexer/liqTiles.ts): a cold venue set no longer times out (one walk per
 * set, a set with and without a venue that holds no row is one, range reads, the scales by selection, an answer of how
 * far it is past the budget, the sets asked warmed), and a tile can be cut to what a view draws (fields=ls, one snapshot
 * per bar, one snapshot alone) - the same numbers wherever it draws.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vs-liqtiles-fast-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ } });

const Q = 15 * 60_000;
const H = 3_600_000;

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

/** A snapshot as the indexer writes one (levels.ts LiqSnap) on hyperliquid, sodex and lighter: none on tradexyz or arcus. */
function snapOf(p: number, st: number, seed: number) {
  const r = rng(seed);
  const v: Record<string, number[][]> = {};
  for (const venue of ['hyperliquid', 'sodex', 'lighter']) {
    const rows = new Map<number, number[]>();
    for (let k = 0; k < 300; k++) {
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

async function store() {
  const { IndexStore } = await import('../src/indexer/store.js');
  return new IndexStore(process.env.VALUESCAN_INDEX_DB!);
}

/** `n` snapshots of `coin` 15 minutes apart, the newest before now. */
async function seed(coin: string, n: number, base = 1_000, at = Math.floor((Date.now() - Q) / Q) * Q): Promise<number[]> {
  const s = await store();
  const ts: number[] = [];
  for (let k = n - 1; k >= 0; k--) ts.push(at - k * Q);
  ts.forEach((t, k) => s.putLiqHist(t, [[coin, JSON.stringify(snapOf(base + 10 * Math.sin(k / 9), base / 400, k + base))]]));
  s.close();
  return ts;
}

function countParses<T>(run: () => Promise<T>): Promise<{ value: T; parsed: number }> {
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = ((text: string, rev?: Parameters<typeof JSON.parse>[1]) => { parsed++; return parse(text, rev); }) as typeof JSON.parse;
  return run().then((value) => ({ value, parsed }), (e) => { throw e; }).finally(() => { JSON.parse = parse; });
}

test('the scales by selection are the sorted reference: duplicates, ties, outliers and small sets', async () => {
  const T = await import('../src/indexer/liqTiles.js');
  const r = rng(3);
  for (let trial = 0; trial < 500; trial++) {
    const n = trial < 12 ? trial : Math.floor(r() * 4000);
    const vals = Array.from({ length: n }, () => (r() < 0.35 ? 1000 * Math.floor(r() * 4) + 100 : r() < 0.02 ? 9e9 : Math.round(r() ** 5 * 1e7) + 1));
    const buf = Float64Array.from(vals);
    assert.equal(T.robustMaxOf(buf, buf.length), T.robustMax95(vals), `trial ${trial} (${n} values)`);
  }
  const same = new Float64Array(5000).fill(7);
  assert.equal(T.robustMaxOf(same, same.length), 7, 'all equal: linear, and the value');
});

test('asks while a cold index is read join its one walk, each snapshot read once; a finished one is answered again for a moment', async () => {
  const T = await import('../src/indexer/liqTiles.js');
  T.resetLiqTiles();
  const ts = await seed('JOIN', 40);
  const V = ['hyperliquid', 'sodex'] as const;
  const now = Date.now();
  // The three asks of 2026-11-17 (a retry, the poll, another viewer), 12 and 25 s apart: one walk, not three.
  const { value: [a, b, c], parsed } = await countParses(() => Promise.all([T.liqTileIndex('JOIN', [...V], now), T.liqTileIndex('JOIN', [...V], now + 12_000), T.liqTileIndex('JOIN', [...V], now + 25_000)]));
  assert.equal(parsed, ts.length, 'each snapshot parsed once');
  assert.equal(a!.points.length, ts.length);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  const again = await countParses(() => T.liqTileIndex('JOIN', [...V], now + 3_000));
  assert.equal(again.value, a, 'within INDEX_MEMO_MS: the same answer');
  assert.equal(again.parsed, 0);
});

test('a cold walk reads runs of the listing in one range scan each, not a point lookup per snapshot', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const T = await import('../src/indexer/liqTiles.js');
  T.resetLiqTiles();
  const ts = await seed('RANGE', 50);
  const point = IndexStore.prototype.liqHistAt;
  const range = IndexStore.prototype.liqHistRange;
  let points = 0;
  let ranges = 0;
  IndexStore.prototype.liqHistAt = function (this: InstanceType<typeof IndexStore>, coin: string, t: number) { if (coin === 'RANGE') points++; return point.call(this, coin, t); };
  IndexStore.prototype.liqHistRange = function (this: InstanceType<typeof IndexStore>, coin: string, a: number, b: number) { if (coin === 'RANGE') ranges++; return range.call(this, coin, a, b); };
  try {
    const idx = (await T.liqTileIndex('RANGE', ['hyperliquid']))!;
    assert.equal(idx.points.length, ts.length);
    assert.equal(points, 0);
    assert.equal(ranges, Math.ceil(ts.length / 24), 'one per batch');
  } finally {
    IndexStore.prototype.liqHistAt = point;
    IndexStore.prototype.liqHistRange = range;
  }
});

test('a venue holding no row changes nothing: a set with and without it is one set, held once, as exact as the one-piece history', async () => {
  const { liqHistory } = await import('../src/indexer/liqRead.js');
  const T = await import('../src/indexer/liqTiles.js');
  const { VENUES } = await import('../src/valuedesk/types.js');
  T.resetLiqTiles();
  await seed('CANON', 30);
  const a = (await T.liqTileIndex('CANON', ['hyperliquid', 'sodex']))!;
  const whole = liqHistory('CANON', ['hyperliquid', 'sodex', 'tradexyz'], '30d')!;
  const b = await countParses(() => T.liqTileIndex('CANON', ['sodex', 'tradexyz', 'hyperliquid']));
  assert.equal(b.parsed, 0, 'held already: trade.xyz holds no row of CANON');
  assert.deepEqual(b.value!.venues, ['sodex', 'tradexyz', 'hyperliquid'], 'the answer names the set asked');
  assert.deepEqual(b.value!.points, a.points);
  assert.deepEqual(b.value!.scale, a.scale);
  assert.deepEqual(b.value!.points, whole.points.map((q) => ({ t: q.t, p: q.p, st: q.st })));
  const full = (await T.liqTileIndex('CANON', [...VENUES]))!;
  const four = await countParses(() => T.liqTileIndex('CANON', ['sodex', 'hyperliquid', 'lighter']));
  assert.equal(four.parsed, 0);
  assert.deepEqual(four.value!.scale, full.scale);
  // A tile of the set with the venue is the tile without it.
  const ask = { tl: 0, tt: Math.floor(a.newest! / T.tileMs(0)) * T.tileMs(0), pl: 0, band: 0, bw: a.bw, v: a.newest! };
  assert.deepEqual((await T.liqTile('CANON', ['hyperliquid', 'sodex', 'tradexyz'], ask))!.points, (await T.liqTile('CANON', ['hyperliquid', 'sodex'], ask))!.points);
});

test('an index not ready within the budget is answered with how far it is, and its walk goes on to the full answer', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const T = await import('../src/indexer/liqTiles.js');
  T.resetLiqTiles();
  const ts = await seed('SLOW', 60);
  const range = IndexStore.prototype.liqHistRange;
  // A disk read while the indexer checkpoints (the 5-28 s of 2026-11-07), shrunk: 30 ms a batch.
  IndexStore.prototype.liqHistRange = function (this: InstanceType<typeof IndexStore>, coin: string, a: number, b: number) {
    const until = performance.now() + 30;
    while (performance.now() < until) { /* busy */ }
    return range.call(this, coin, a, b);
  };
  try {
    const r = await T.liqTileIndexIn('SLOW', ['hyperliquid'], 1);
    assert.ok(r && 'building' in r, 'past the budget: how far it is');
    assert.equal(r.building.of, ts.length);
    assert.ok(r.building.done >= 0 && r.building.done < ts.length, JSON.stringify(r.building));
    const done = await T.liqTileIndexIn('SLOW', ['hyperliquid'], 60_000);
    assert.ok(done && !('building' in done) && done.points.length === ts.length, 'the next ask joins the walk and gets the index');
  } finally {
    IndexStore.prototype.liqHistRange = range;
  }
});

test('a venue set asked is warmed with every venue from then on, each new snapshot parsed once for all, and kept across restarts', async () => {
  const T = await import('../src/indexer/liqTiles.js');
  process.env.VALUESCAN_LIQ_METAS_FILE = join(dir, 'metas-asked.bin');
  try {
    T.resetLiqTiles();
    // The newest snapshots of the file: the coins of the newest are the ones the warm goes over.
    const t1 = Math.floor(Date.now() / Q) * Q + Q;
    await seed('REG', 8, 2_000, t1 - Q);
    await T.liqTileIndex('REG', ['sodex']);
    assert.ok(T._liqAskedSets.has('REG|sodex'));
    await T.liqTileIndex('REG', ['hyperliquid', 'lighter', 'sodex', 'tradexyz', 'arcus']);
    assert.ok(!T._liqAskedSets.has('REG|arcus,hyperliquid,lighter,sodex,tradexyz'), 'every venue is always warmed, not listed');
    const s = await store();
    s.putLiqHist(t1, [['REG', JSON.stringify(snapOf(2_001, 5, 77))]]);
    s.close();
    const warm = await countParses(() => T.warmLiqMetas(Date.now(), 0));
    assert.ok(warm.value >= 1);
    assert.equal(warm.parsed, 1, 'the new snapshot, once for both sets');
    const idx = await countParses(() => T.liqTileIndex('REG', ['sodex'], Date.now() + 20_000));
    assert.equal(idx.parsed, 0, 'the set asked has it already');
    assert.equal(idx.value!.newest, t1);
    await T.saveLiqMetas();
    T.resetLiqTiles();
    await T.liqTileIndex('REG', ['hyperliquid'], Date.now() + 40_000);
    assert.ok(T._liqAskedSets.has('REG|sodex'), 'read back from the file');
  } finally {
    delete process.env.VALUESCAN_LIQ_METAS_FILE;
    T.resetLiqTiles();
  }
});

test('a metas file of version 2 (no venues per snapshot) is still read: no rebuild after the release', async () => {
  const T = await import('../src/indexer/liqTiles.js');
  const ts = await seed('OLDV', 3, 500);
  const s = await store();
  const lens = ts.map((t) => Buffer.byteLength(s.liqHistAt('OLDV', t)!, 'utf8'));
  s.close();
  const W = 21;
  const nums = new Float64Array(ts.length * (4 + W));
  ts.forEach((t, k) => { nums.set([t, lens[k]!, 111 + k, 1.25], k * (4 + W)); nums.fill(5 + k, k * (4 + W) + 4, (k + 1) * (4 + W)); });
  const head = Buffer.from(JSON.stringify({ v: 2, w: 4 + W, keys: [['OLDV|hyperliquid', ts.length]] }), 'utf8');
  const pre = Buffer.alloc(Math.ceil((4 + head.length) / 8) * 8);
  pre.writeUInt32LE(head.length, 0);
  head.copy(pre, 4);
  const file = join(dir, 'metas-v2.bin');
  writeFileSync(file, Buffer.concat([pre, Buffer.from(nums.buffer)]));
  process.env.VALUESCAN_LIQ_METAS_FILE = file;
  try {
    T.resetLiqTiles();
    const r = await countParses(() => T.liqTileIndex('OLDV', ['hyperliquid']));
    assert.equal(r.parsed, 1, 'the file only');
    assert.deepEqual(r.value!.points.map((q) => q.p), [111, 112, 113], 'the metas of the file');
  } finally {
    delete process.env.VALUESCAN_LIQ_METAS_FILE;
    T.resetLiqTiles();
  }
});

test('a tile cut to what a view draws holds exactly those numbers of the full tile: slim rows, the newest snapshot per bar, one snapshot alone', async () => {
  const T = await import('../src/indexer/liqTiles.js');
  T.resetLiqTiles();
  const ts = await seed('CUT', 2 * 96 + 7, 80_000);
  const V = ['hyperliquid', 'sodex', 'lighter'] as const;
  const idx = (await T.liqTileIndex('CUT', [...V]))!;
  const span = T.bandSpan(idx.bw, 0);
  const bands = [...new Set([79_000, 80_000, 85_000, 120_000].map((p) => Math.floor(p / span)))];
  let checked = 0;
  for (const tl of [0, 1]) {
    const ms = T.tileMs(tl);
    for (let tt = Math.floor(ts[0]! / ms) * ms; tt <= ts.at(-1)!; tt += ms) {
      for (const band of bands) {
        const base = { tl, tt, pl: 0, band, bw: idx.bw, ...(tt + ms > idx.newest! ? { v: idx.newest! } : {}) };
        const full = (await T.liqTile('CUT', [...V], base))!;
        const slim = (await T.liqTile('CUT', [...V], { ...base, fields: 'ls' }))!;
        assert.deepEqual(slim.points, full.points.map((q) => ({ ...q, b: q.b.map((r) => r.slice(0, 3)) })), 'slim: the first three fields of each row');
        assert.equal(slim.final, full.final);
        for (const [every, off] of [[H, 0], [4 * H, 0], [86_400_000, 0], [2 * H, 30 * 60_000], [30 * 60_000, 15 * 60_000]] as const) {
          const cut = (await T.liqTile('CUT', [...V], { ...base, fields: 'ls', every, off }))!;
          const want = full.points.filter((q, k) => {
            const next = full.points[k + 1];
            return !next || Math.floor((next.t - off) / every) !== Math.floor((q.t - off) / every);
          }).map((q) => ({ ...q, b: q.b.map((r) => r.slice(0, 3)) }));
          assert.deepEqual(cut.points, want, `tl ${tl} tt ${tt} band ${band} every ${every} off ${off}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 50, `${checked} cuts`);
  // The slot still filling as single snapshots: each the v= tile's own, final once it exists.
  const cur = Math.floor(idx.newest! / T.SLOT_MS) * T.SLOT_MS;
  const band = Math.floor(idx.points.at(-1)!.p / span);
  const open = (await T.liqTile('CUT', [...V], { tl: 0, tt: cur, pl: 0, band, bw: idx.bw, v: idx.newest! }))!;
  assert.ok(open.points.length > 1);
  for (const q of open.points) {
    const one = (await T.liqTile('CUT', [...V], { tl: 0, tt: cur, pl: 0, band, bw: idx.bw, at: q.t }))!;
    assert.deepEqual(one.points, [q]);
    assert.equal(one.final, true);
  }
  const ahead = (await T.liqTile('CUT', [...V], { tl: 0, tt: cur, pl: 0, band, bw: idx.bw, at: idx.newest! + Q }))!;
  assert.equal(ahead.final, false, 'a snapshot not written yet');
  assert.deepEqual(ahead.points, []);
});

test('the new asks the route takes, and the ones it refuses', async () => {
  const T = await import('../src/indexer/liqTiles.js');
  const now = Date.UTC(2026, 10, 17, 18);
  const tt = Math.floor(now / T.SLOT_MS) * T.SLOT_MS;
  const q = { tl: '0', tt: String(tt), pl: '0', band: '15', bw: '5000' };
  assert.deepEqual(T.tileAskOf({ ...q, fields: 'ls', every: String(H), off: String(-H + 60_000) }, now), { tl: 0, tt, pl: 0, band: 15, bw: 5000, fields: 'ls', every: H, off: 60_000 });
  assert.deepEqual(T.tileAskOf({ ...q, at: String(tt + Q) }, now), { tl: 0, tt, pl: 0, band: 15, bw: 5000, at: tt + Q });
  assert.deepEqual(T.tileAskOf({ ...q, every: '0' }, now), { tl: 0, tt, pl: 0, band: 15, bw: 5000 }, 'every=0: every snapshot');
  assert.equal(typeof T.tileAskOf({ ...q, fields: 'all' }, now), 'string');
  assert.equal(typeof T.tileAskOf({ ...q, at: String(tt + T.SLOT_MS) }, now), 'string', 'at= outside its slot');
  assert.equal(typeof T.tileAskOf({ ...q, at: String(tt), v: String(tt) }, now), 'string', 'at= with v=');
  assert.equal(typeof T.tileAskOf({ ...q, tl: '1', tt: String(Math.floor(now / T.tileMs(1)) * T.tileMs(1)), at: String(tt) }, now), 'string', 'at= only at level 0');
  assert.equal(typeof T.tileAskOf({ ...q, every: String(8 * 86_400_000) }, now), 'string', 'longer than a week');
  assert.equal(typeof T.tileAskOf({ ...q, every: '1.5' }, now), 'string');
});
