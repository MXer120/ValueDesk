/**
 * Run: npx tsx --test test/flow.test.ts   (from apps/server)
 *
 * Who traded a candle (flow/; owner 2026-11-01: "trade info & more for each candle & every
 * timeframe across all supported platforms"): chunks and sums pack and unpack exactly; a window
 * read from day + hour + chunk rows equals the same window summed print by print, at every cut;
 * the recorder closes chunks, sums hours and days, and sums an hour again for a late print; a
 * wallet's fills are exactly its prints; recorder downtime shows as gaps.
 */
import { setCandleRead } from '../src/flow/venueCheck.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vs-flow-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');
process.env.VALUESCAN_FLOW_DB = join(dir, 'flow.db');
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ } });

const {
  CHUNK_MS, DAY_MS, HOUR_MS, TAKER_BUYER, TAKER_SELLER,
  addPrints, chunkPrints, decodeChunk, decodeSums, encodeChunk, encodeSums, leanOf, tableOf, cell, ROLE_TAKER, ROLE_MAKER, SIDE_BUY, SIDE_SELL, F_NTL,
} = await import('../src/flow/codec.js');
const { FlowStore, closeFlowReader } = await import('../src/flow/store.js');
const { FlowRecorder, CLOSE_MS, FLUSH_MS, READY_MS } = await import('../src/flow/recorder.js');
const { flowWindow, flowWalletFills, plan, gapsOf, clearFlowCaches } = await import('../src/flow/read.js');
type Print = import('../src/indexer/streams.js').Print;

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

const A = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;

// No venue's candles are read from a test (venueCheck.ts): flowVenues.test.ts gives its own.
setCandleRead(async () => null);

test('a chunk packs and unpacks every print exactly, in time order', () => {
  const r = rng(1);
  const base = 1_700_000_100_000 - (1_700_000_100_000 % CHUNK_MS);
  const prints = Array.from({ length: 500 }, () => ({
    t: base + Math.floor(r() * CHUNK_MS), px: 60_000 + r() * 100, sz: r() * 3, buyer: 1 + Math.floor(r() * 40), seller: 1 + Math.floor(r() * 40), taker: Math.floor(r() * 3),
  }));
  const back = chunkPrints(decodeChunk(encodeChunk(base, prints)));
  const want = [...prints].sort((a, b) => a.t - b.t);
  assert.equal(back.length, want.length);
  for (let i = 0; i < back.length; i++) assert.deepEqual(back[i], want[i]);
});

test('sums pack and unpack exactly; the table counts each print once and splits takers', () => {
  const base = 0;
  const prints = [
    { t: 1, px: 100, sz: 2, buyer: 1, seller: 2, taker: TAKER_BUYER },
    { t: 2, px: 110, sz: 1, buyer: 2, seller: 1, taker: TAKER_SELLER },
    { t: 3, px: 105, sz: 4, buyer: 3, seller: 1, taker: TAKER_BUYER },
  ];
  const sums = new Map<number, Float64Array>();
  assert.equal(addPrints(sums, decodeChunk(encodeChunk(base, prints))), 3);
  const back = decodeSums(encodeSums(sums, 3));
  assert.equal(back.prints, 3);
  assert.deepEqual([...back.sums.keys()].sort(), [1, 2, 3]);
  for (const [k, v] of sums) assert.deepEqual([...back.sums.get(k)!], [...v]);
  // Wallet 1 bought 2 @100 as taker, sold 1 @110 as taker, sold 4 @105 as maker.
  const w1 = sums.get(1)!;
  assert.equal(w1[cell(ROLE_TAKER, SIDE_BUY, F_NTL)], 200);
  assert.equal(w1[cell(ROLE_TAKER, SIDE_SELL, F_NTL)], 110);
  assert.equal(w1[cell(ROLE_MAKER, SIDE_SELL, F_NTL)], 420);
  const { summary, rows } = tableOf(sums, { role: 'all', side: 'all', sort: 'volume', limit: 10 });
  assert.equal(summary.total, 200 + 110 + 420);
  assert.equal(summary.prints, 3);
  assert.equal(summary.takerBuy, 200 + 420);
  assert.equal(summary.takerSell, 110);
  assert.equal(summary.wallets, 3);
  assert.ok(Math.abs(rows.reduce((s, r) => s + r.share, 0) - 1) < 1e-9);
  const r1 = rows.find((r) => r.pid === 1)!;
  assert.equal(r1.buyPx, 100);
  assert.equal(r1.sellPx, 530 / 5);
  assert.equal(r1.net, 2 - 5);
  assert.equal(r1.lean, 'short');
  assert.equal(r1.takerShare, 310 / 730);
  // Takers only: wallet 3 took 420, wallet 1 took 310 (its buy and a sell); wallet 2 only made.
  const tk = tableOf(sums, { role: 'taker', side: 'all', sort: 'volume', limit: 10 });
  assert.deepEqual(tk.rows.map((r) => [r.pid, r.vol]), [[3, 420], [1, 310]]);
  assert.equal(tk.summary.top3, 1);
  assert.equal(tk.summary.top10, 1);
  assert.equal(leanOf({ buySz: 10, sellSz: 9.5 }), 'round');
  assert.equal(leanOf({ buySz: 0, sellSz: 0 }), 'flat');
});

test('a window is planned from whole days, then whole hours, then raw prints', () => {
  const d0 = 20_000 * DAY_MS;
  const days = new Set([d0 + DAY_MS]);
  const hours = new Set([d0 + 3 * HOUR_MS, d0 + 4 * HOUR_MS, d0 + 2 * DAY_MS]);
  const p = plan(d0 + 2 * HOUR_MS + 7 * 60_000, d0 + 2 * DAY_MS + HOUR_MS + 90_000, days, hours);
  assert.deepEqual(p.map((x) => [x.level, (x.from - d0) / 60_000, (x.to - d0) / 60_000]), [
    ['chunk', 127, 180],
    ['hour', 180, 240],
    ['hour', 240, 300],
    ...Array.from({ length: 19 }, (_, i) => ['chunk', 300 + i * 60, 360 + i * 60]),
    ['day', 1440, 2880],
    ['hour', 2880, 2940],
    ['chunk', 2940, 2941.5],
  ]);
  // Covers the window exactly, without overlap.
  for (let i = 1; i < p.length; i++) assert.equal(p[i]!.from, p[i - 1]!.to);
});

test('the recorder sums hours and days, and any window equals the prints summed one by one', async () => {
  const day0 = 20_100 * DAY_MS;
  let now = day0 + 22 * HOUR_MS;
  const store = new FlowStore(process.env.VALUESCAN_FLOW_DB!);
  const rec = new FlowRecorder(store, (_v, acct) => (acct === '77' ? A(77) : null), () => now);
  const r = rng(7);
  const all: Print[] = [];
  // 30 hours of prints on Hyperliquid BTC and SoDEX BTC-USD (account ids), ticking the clock.
  const end = day0 + DAY_MS + 4 * HOUR_MS;
  let id = 0;
  while (now < end) {
    for (let k = 0; k < 3; k++) {
      const sodex = r() < 0.3;
      const b = 1 + Math.floor(r() * 30);
      let s = 1 + Math.floor(r() * 30);
      if (s === b) s = (s % 30) + 1;
      const p: Print = {
        venue: sodex ? 'sodex' : 'hyperliquid', id: String(id++), t: now - Math.floor(r() * 2_000), symbol: sodex ? 'BTC-USD' : 'BTC',
        px: 60_000 + Math.round(r() * 1000) / 10, sz: Math.round(r() * 1000) / 1000 + 0.001,
        buyer: sodex ? String(70 + (b % 10)) : A(b), seller: sodex ? String(70 + (s % 10)) : A(s), taker: r() < 0.5 ? 'buyer' : 'seller',
      };
      rec.add(p);
      all.push(p);
    }
    // The engine hands xyz prints in twice and HL spot once: neither is kept under hyperliquid.
    rec.add({ venue: 'hyperliquid', id: 'x', t: now, symbol: 'xyz:TSLA', px: 400, sz: 1, buyer: A(1), seller: A(2) });
    rec.add({ venue: 'hyperliquid', id: 's', t: now, symbol: '@107', px: 40, sz: 1, buyer: A(1), seller: A(2) });
    now += 20_000;
    rec.tick();
  }
  now += HOUR_MS + READY_MS + CLOSE_MS + FLUSH_MS;
  for (let i = 0; i < 2000; i++) rec.tick();
  assert.equal(rec.status().hourThrough, Math.floor((now - READY_MS) / HOUR_MS) * HOUR_MS);
  assert.equal(rec.status().dayThrough, day0 + DAY_MS);
  assert.ok(store.sums('day', store.markets().find((m) => m.symbol === 'BTC')!.id, day0), 'the first day is summed');
  assert.equal(store.markets().length, 2);
  // A SoDEX account the index knows has its address.
  assert.equal(store.partiesOf(A(77))[0]?.key, '77');

  closeFlowReader();
  clearFlowCaches();
  const venues = ['hyperliquid', 'sodex'] as const;
  const exact = (from: number, to: number) => {
    let total = 0;
    const byWallet = new Map<string, number>();
    for (const p of all) {
      if (p.t < from || p.t >= to) continue;
      total += p.px * p.sz;
      for (const w of [p.buyer, p.seller]) {
        const k = `${p.venue}|${p.venue === 'sodex' && w === '77' ? A(77) : w}`;
        byWallet.set(k, (byWallet.get(k) ?? 0) + p.px * p.sz);
      }
    }
    return { total, byWallet };
  };
  const cuts: Array<[number, number]> = [
    [day0 + 22 * HOUR_MS, end], // spans a whole day row plus hours and chunks
    [day0, day0 + 2 * DAY_MS], // the 1D candles
    [day0 + DAY_MS + HOUR_MS, day0 + DAY_MS + 2 * HOUR_MS], // one hour row
    [day0 + DAY_MS + HOUR_MS + 60_000, day0 + DAY_MS + HOUR_MS + 120_000], // a 1m candle
    [day0 + 23 * HOUR_MS + 17_123, day0 + DAY_MS + 2 * HOUR_MS + 999], // ragged edges
  ];
  for (const [from, to] of cuts) {
    const w = await flowWindow({ coin: 'btc', venues, kind: 'perp', from, to, role: 'all', side: 'all', sort: 'volume', limit: 500 }, now);
    assert.ok(w);
    const x = exact(from, to);
    assert.ok(Math.abs(w.summary.total - x.total) < 1e-6 * Math.max(1, x.total), `total ${from}-${to}`);
    assert.equal(w.rows.length, x.byWallet.size);
    for (const row of w.rows) {
      const k = `${row.venue}|${row.address ?? row.key}`;
      assert.ok(Math.abs(row.vol - (x.byWallet.get(k) ?? -1)) < 1e-6 * row.vol, `wallet ${k}`);
    }
    // Asked with SoDEX and no ledger here: nothing has been compared with its count, so never final (flowLedger.test.ts).
    assert.equal(w.final, false, 'SoDEX unchecked');
    assert.equal(w.coverage?.holeSlots, 0);
    // Hyperliquid too: its candles are not to be read here, so nothing is compared, however long ago.
    const hl = await flowWindow({ coin: 'btc', venues: ['hyperliquid'], kind: 'perp', from, to, role: 'all', side: 'all', sort: 'volume', limit: 1 }, now);
    assert.equal(hl!.final, false, 'no check, not final');
    assert.deepEqual(w.markets.map((m) => m.venue).sort(), ['hyperliquid', 'sodex']);
  }
  // Search, venue filter.
  const only = await flowWindow({ coin: 'BTC', venues: ['sodex'], kind: 'perp', from: day0, to: end, role: 'all', side: 'all', sort: 'fills', limit: 500, q: A(77).slice(-6) }, now);
  assert.ok(only && only.rows.length === 1 && only.rows[0]!.address === A(77) && only.rows[0]!.venue === 'sodex');

  // One wallet's fills are exactly its prints.
  const from = day0 + 23 * HOUR_MS;
  const to = day0 + DAY_MS + 3 * HOUR_MS;
  const f = await flowWalletFills({ coin: 'BTC', venues, kind: 'perp', from, to, wallet: A(5) }, now);
  assert.ok(f);
  const mine = all.filter((p) => p.venue === 'hyperliquid' && p.t >= from && p.t < to && (p.buyer === A(5) || p.seller === A(5)));
  const n = mine.reduce((s, p) => s + (p.buyer === p.seller ? 2 : 1), 0);
  assert.equal(f.fills.t.length, n);
  for (let i = 1; i < f.fills.t.length; i++) assert.ok(f.fills.t[i]! >= f.fills.t[i - 1]!);
  const bought = mine.filter((p) => p.buyer === A(5)).reduce((s, p) => s + p.sz, 0);
  const got = f.fills.sz.reduce((s, z, i) => s + (f.fills.side[i] === 1 ? z : 0), 0);
  assert.ok(Math.abs(bought - got) < 1e-9);
  for (let i = 0; i < f.fills.t.length; i++) {
    const p: Print = mine.find((x) => x.t === f.fills.t[i] && x.px === f.fills.px[i] && x.sz === f.fills.sz[i])!;
    assert.ok(p);
    const buys: boolean = f.fills.side[i] === 1;
    assert.equal(f.fills.role[i], (p.taker === 'buyer') === buys ? 0 : 1);
    assert.equal(f.others[f.fills.other[i]!]!.address, buys ? p.seller : p.buyer);
  }

  // A late print reopens its chunk and the hour and day are summed again.
  const lateT = day0 + 23 * HOUR_MS + 5 * 60_000 + 1;
  const late: Print = { venue: 'hyperliquid', id: 'late', t: lateT, symbol: 'BTC', px: 61_000, sz: 10, buyer: A(99), seller: A(98), taker: 'buyer' };
  rec.add(late);
  all.push(late);
  now += FLUSH_MS + 1;
  for (let i = 0; i < 50; i++) rec.tick();
  clearFlowCaches();
  const w = await flowWindow({ coin: 'BTC', venues, kind: 'perp', from: day0, to: day0 + DAY_MS, role: 'all', side: 'all', sort: 'volume', limit: 3, q: A(99).slice(-8) }, now);
  assert.ok(Math.abs(w!.summary.total - exact(day0, day0 + DAY_MS).total) < 1e-3);
  assert.equal(w!.rows.length, 1);
  assert.equal(w!.rows[0]!.address, A(99));
  assert.equal(w!.rows[0]!.vol, 610_000);
  rec.stop();
  store.close();
});

test('recorder downtime inside a window is reported as gaps', () => {
  // A window wholly inside an outage, or one ending inside it: the next run began after the window.
  assert.deepEqual(gapsOf([[0, 1000], [9000, 12_000]], 3000, 5000, 0), [[3000, 5000]]);
  assert.deepEqual(gapsOf([[0, 1000], [5000, 12_000]], 500, 5000, 0), [[1000, 5000]]);
  const runs: Array<[number, number]> = [[0, 1000_000], [1_600_000, 3_000_000]];
  assert.deepEqual(gapsOf(runs, 500_000, 2_000_000, 0), [[1_000_000, 1_600_000]]);
  assert.deepEqual(gapsOf(runs, 500_000, 4_000_000, 0), [[1_000_000, 1_600_000], [3_000_000, 4_000_000]]);
  assert.deepEqual(gapsOf(runs, 1_700_000, 2_000_000, 0), []);
});

test('the Hyperliquid archive becomes the same rows: one print per tid, the crossed side the taker, xyz as trade.xyz, spot left out', async () => {
  const { HourBuilder, writeHour, writeDay, noteBackfill } = await import('../src/flow/backfillHl.js');
  const store = new FlowStore(join(dir, 'archive.db'));
  const h0 = 20_300 * DAY_MS + 5 * HOUR_MS;
  const b = new HourBuilder();
  const ev = (user: string, coin: string, side: 'A' | 'B', tid: number, t: number, crossed: boolean) => [user, { coin, px: '100.5', sz: '2', side, time: t, tid, crossed }];
  b.line(JSON.stringify({ events: [ev(A(1), 'BTC', 'B', 1, h0 + 10, true), ev(A(2), 'BTC', 'A', 1, h0 + 10, false)] }));
  b.line(JSON.stringify({ events: [ev(A(3), 'BTC', 'A', 2, h0 + 400_000, true), ev(A(1), 'BTC', 'B', 2, h0 + 400_000, false)] }));
  b.line(JSON.stringify({ events: [ev(A(4), 'xyz:TSLA', 'B', 3, h0 + 20, false), ev(A(5), 'xyz:TSLA', 'A', 3, h0 + 20, true)] }));
  b.line(JSON.stringify({ events: [ev(A(4), '@107', 'B', 4, h0 + 30, false), ev(A(5), '@107', 'A', 4, h0 + 30, true)] }));
  b.line('not json');
  assert.equal(writeHour(store, h0, b), 3);
  writeDay(store, 20_300 * DAY_MS);
  noteBackfill(store, h0, h0 + HOUR_MS);
  const btc = store.markets().find((m) => m.symbol === 'BTC')!;
  const xyz = store.markets().find((m) => m.symbol === 'xyz:TSLA')!;
  assert.equal(btc.venue, 'hyperliquid');
  assert.equal(xyz.venue, 'tradexyz');
  assert.equal(xyz.coin, 'TSLA');
  assert.equal(store.markets().length, 2);
  const chunks = store.chunks(btc.id, h0, h0 + HOUR_MS).flatMap((c) => chunkPrints(decodeChunk(c.data)));
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]!.taker, TAKER_BUYER);
  assert.equal(chunks[1]!.taker, TAKER_SELLER);
  assert.equal(decodeSums(store.sums('day', btc.id, 20_300 * DAY_MS)!).prints, 2);
  assert.deepEqual(JSON.parse(store.getMeta('backfill:hyperliquid')!), [h0, h0 + HOUR_MS]);
  assert.equal(b.bad, 1);
  store.close();
});
