/**
 * Run: node --import tsx --test test/liqLev.test.ts   (from apps/server)
 *
 * The heatmap's leverage (owner 2026-10-31: colour and filter by leverage): each position's
 * leverage (math.ts accountLevs) and band (levBand), the bands in the engine's rows, the
 * snapshots and the API's sums - and rows and snapshots from before the bands still read,
 * their USD as unknown leverage.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountLevs, flatTiers, levBand } from '../src/valuedesk/liquidations/math.js';
import { LiqLive, type LiveAccount } from '../src/valuedesk/liquidations/live.js';
import { addRow, rowBand, snapOfNow, trimRow, type LiqNow, type LiqRow } from '../src/valuedesk/liquidations/levels.js';
import { aggregate } from '../src/routes/liqWs.js';

const dir = mkdtempSync(join(tmpdir(), 'vs-liqlev-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');
process.env.VALUESCAN_LIQ_FEED = '0';
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ } });

const T = flatTiers(0.0125);

test('bands: low up to 5x, mid over 5x to 20x, high over 20x; unknown stays unknown', () => {
  assert.equal(levBand(1), 0);
  assert.equal(levBand(5), 0);
  assert.equal(levBand(5.01), 1);
  assert.equal(levBand(20), 1);
  assert.equal(levBand(20.5), 2);
  assert.equal(levBand(Infinity), 2, 'no margin left: high');
  for (const x of [null, undefined, 0, -3, Number.NaN]) assert.equal(levBand(x), null);
});

test('leverage per position: isolated on its own margin, cross on the account', () => {
  const px = (s: string) => ({ BTC: 1_000, ETH: 50 } as Record<string, number>)[s] ?? null;
  // Isolated: 1 BTC at 1,000 with 100 of margin (iso = margin - s·p): 10x, whatever it was set at.
  assert.deepEqual(accountLevs(null, null, [{ symbol: 'BTC', szi: 1, iso: 100 - 1_000, lev: 20 }], px), [10]);
  // Isolated without its margin known: the venue's set leverage is the only figure.
  assert.deepEqual(accountLevs(null, null, [{ symbol: 'BTC', szi: 1, iso: null, lev: 7 }], px), [7]);
  // A short's margin: iso + s·p = 50 for a 1 BTC short: 20x.
  assert.deepEqual(accountLevs(null, null, [{ symbol: 'BTC', szi: -1, iso: 50 + 1_000 }], px), [20]);
  // Cross, one position: equity = cash + s·p = -900 + 1,000 = 100 -> 10x.
  assert.deepEqual(accountLevs(-900, null, [{ symbol: 'BTC', szi: 1 }], px), [10]);
  // Cross, two positions: notional 1,000 + 500, equity -200 + 1,000 - 500 = 300 -> both run 5x.
  assert.deepEqual(accountLevs(-200, null, [{ symbol: 'BTC', szi: 1 }, { symbol: 'ETH', szi: -10 }], px), [5, 5]);
  // Cross beside an isolated one: the isolated one keeps its own figure and is out of the account's.
  assert.deepEqual(accountLevs(-900, null, [{ symbol: 'BTC', szi: 1 }, { symbol: 'ETH', szi: 10, iso: 100 - 500 }], px), [10, 5]);
  // No cash (a split Lighter wallet): the read's account value stands in.
  assert.deepEqual(accountLevs(null, 250, [{ symbol: 'BTC', szi: 1, fix: 800 }], px), [4]);
  // A cross price not known: the account's notional is not either.
  assert.deepEqual(accountLevs(-900, null, [{ symbol: 'BTC', szi: 1 }, { symbol: 'DOGE', szi: 5 }], px), [null, null]);
  // Equity at or below zero, a margin used up: Infinity (high).
  assert.deepEqual(accountLevs(-1_000, null, [{ symbol: 'BTC', szi: 1 }], px), [Infinity]);
  assert.deepEqual(accountLevs(null, null, [{ symbol: 'BTC', szi: 1, iso: -1_000 }], px), [Infinity]);
  // The SoDEX mirrored pair (2026-05-15): 908.65525 BTC each, cross, 25x -> high.
  const n = 908.65525 * 77_500;
  const [lev] = accountLevs(n / 25 - n, null, [{ symbol: 'BTC', szi: 908.65525 }], () => 77_500);
  assert.ok(Math.abs(lev! - 25) < 1e-9);
  assert.equal(levBand(lev), 2);
});

test('the engine sums each bucket per band; a book whose leverage is not known adds none', () => {
  const books = new Map<string, LiveAccount>([
    ['hyperliquid|0xlow', { cash: -76_000, priced: true, positions: [{ symbol: 'BTC', szi: 1 }] }], // equity 4,000 on 80,000: 20x (mid)
    ['hyperliquid|0xiso', { cash: null, priced: true, positions: [{ symbol: 'BTC', szi: -1, iso: 3_200 + 80_000 }] }], // margin 3,200: 25x
    ['hyperliquid|0xfix', { cash: null, priced: true, positions: [{ symbol: 'BTC', szi: 1, fix: 70_000 }] }], // no cash, no equity: unknown
  ]);
  const live = new LiqLive({
    account: (v, a) => books.get(`${v}|${a}`), priceOf: () => 80_000, tiersOf: () => T, priceOfCoin: () => 80_000,
  });
  for (const k of books.keys()) live.touch('hyperliquid', k.slice('hyperliquid|'.length));
  live.work();
  const btc = live.rows().get('BTC')!;
  const rows = btc.v.hyperliquid!.b;
  const long = rows.filter((r) => r[1] > 0);
  const short = rows.filter((r) => r[2] > 0);
  const lowLong = long.find((r) => r[rowBand(true, 1)]);
  assert.ok(lowLong, 'the 20x cross long is mid');
  assert.equal(lowLong![rowBand(true, 1)], lowLong![1]);
  const fixed = long.find((r) => r[0] === Math.floor(70_000 / btc.st));
  assert.ok(fixed && fixed.length === 5, `the kept figure without a cash: no band (${JSON.stringify(fixed)})`);
  assert.equal(short.length, 1);
  assert.equal(short[0]![rowBand(false, 2)], short[0]![2], 'the 25x isolated short is high');
  assert.equal(short[0]!.length, 11);
});

test('rows of any length sum exactly: a row without bands adds its USD as unknown', () => {
  const x: number[] = [7, 100, 0, 1, 0, 60, 40];
  addRow(x, [7, 50, 0, 2, 0]);
  addRow(x, [7, 0, 30, 0, 1, 0, 0, 0, 0, 0, 30]);
  assert.deepEqual(x, [7, 150, 30, 3, 1, 60, 40, 0, 0, 0, 30]);
  // Long: 150, bands 100 -> 50 unknown; short: all high.
  assert.deepEqual(trimRow([1, 5, 0, 1, 0, 5, 0, 0, 0, 0, 0]), [1, 5, 0, 1, 0, 5]);
  assert.deepEqual(trimRow([1, 5, 0, 1, 0, 0, 0, 0, 0, 0, 0]), [1, 5, 0, 1, 0], 'no band known: the old five');
  assert.deepEqual(trimRow([1, 0, 0], 3), [1, 0, 0]);
  // The stream's widths sum bands too.
  assert.deepEqual(aggregate([[10, 100, 0, 1, 0, 100], [11, 50, 0, 1, 0], [12, 0, 40, 0, 1, 0, 0, 0, 0, 40]], 5), [[2, 150, 40, 2, 1, 100, 0, 0, 0, 40]]);
});

test('snapshots keep the bands of the levels they keep; an old minute row gives the old rows', () => {
  const row: LiqNow = {
    p: 1_000, st: 0.2,
    v: {
      hyperliquid: { b: [[4_000, 800, 0, 1, 0, 0, 800], [5_500, 0, 1_100, 0, 1, 0, 0, 0, 1_000]], c: [1, 1, 1, 1, 2, 0, 0, 0], o: [0, 0, 0, 0] },
      lighter: { b: [[4_000, 400, 0, 1, 0]], c: [1, 0, 1, 0, 1, 0, 0, 0], o: [0, 0, 0, 0] },
    },
  };
  const snap = snapOfNow(row);
  assert.deepEqual(snap.v.hyperliquid, [[320, 800, 0, 0, 800], [440, 0, 1_100, 0, 0, 0, 1_000]], 'mid longs; 1,000 of the shorts low, 100 unknown');
  assert.deepEqual(snap.v.lighter, [[320, 400, 0]], 'an old row: no bands');
});

test('the API: venues of old and new rows sum, old snapshots read as unknown, the lev= of the lists reads', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  // The store first: the API's reader opens the index file on its first use.
  const s = new IndexStore(process.env.VALUESCAN_INDEX_DB!);
  const { heatOf, liqHistory, levFilterOf, logLev } = await import('../src/indexer/liqRead.js');
  const rows: Record<string, LiqRow[]> = {
    hyperliquid: [[900, 9_000, 0, 1, 0, 0, 0, 9_000]],
    lighter: [[900, 1_000, 0, 1, 0]],
  };
  const h = heatOf('BTC', ['hyperliquid', 'lighter'], { at: 1, p: 10_000, st: 10, v: (v) => (rows[v] ? { b: rows[v]!, c: [1, 0, 1, 0, 1], o: [0, 0, 0, 0] } : undefined) }, new Map());
  assert.deepEqual(h.buckets, [[900, 10_000, 0, 2, 0, 0, 0, 9_000]], '9,000 high, 1,000 of unknown leverage');

  const Q = 15 * 60_000;
  const t0 = Math.floor((Date.now() - 60 * 60_000) / Q) * Q;
  s.putLiqHist(t0, [['BTC', JSON.stringify({ p: 1_000, st: 10, v: { hyperliquid: [[90, 500, 0]] } })]]);
  s.putLiqHist(t0 + Q, [['BTC', JSON.stringify({ p: 1_000, st: 10, v: { hyperliquid: [[90, 500, 0, 200, 300]], lighter: [[90, 100, 0]] } })]]);
  const hist = liqHistory('BTC', ['hyperliquid', 'lighter'], '1d')!;
  assert.deepEqual(hist.points.map((p) => p.b), [[[90, 500, 0]], [[90, 600, 0, 200, 300]]], 'before the bands: none; after: 100 of lighter unknown');

  assert.equal(levFilterOf(undefined), null);
  assert.equal(levFilterOf('low,mid,high'), null, 'all three: no filter');
  assert.deepEqual([...levFilterOf('high,Low,x')!].sort(), [0, 2]);
  assert.equal(logLev({ iso: 1, lev: 25, sz: 1, mark: 100, eq: 1 }), 25);
  assert.equal(logLev({ iso: 0, lev: null, sz: -2, mark: 100, eq: 40 }), 5);
  assert.equal(logLev({ iso: 0, lev: null, sz: -2, mark: 100, eq: 0 }), Infinity);
  assert.equal(logLev({ iso: null, lev: 10, sz: 1, mark: 1, eq: 1 }), null);
});
