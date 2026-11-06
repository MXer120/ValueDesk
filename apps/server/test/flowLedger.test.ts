/**
 * The coverage ledger (flow/ledger.ts): SoDEX's own count against the prints held, and what the flow may claim from it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { CHUNK_MS, DAY_MS } from '../src/flow/codec.js';
import {
  CoverageLedger, LedgerStore, PAGE, SETTLE_MS, SLOT_MS, VISIT_EVERY_MS, slotDown,
  activityDays, coverageOf, dayState, joinSpans, ledgerPathFor, provenSpans, subtractSpans,
  type DayRow, type Kline, type MarketWindow,
} from '../src/flow/ledger.js';
import { FlowStore, closeFlowReader } from '../src/flow/store.js';
import { FlowRecorder, CLOSE_MS, FLUSH_MS, READY_MS } from '../src/flow/recorder.js';
import { activityCoverage, clearFlowCaches, closeLedgerReader, flowWalletFills, flowWindow } from '../src/flow/read.js';
import { startLedgerThread } from '../src/flow/ledgerWorker.js';
import { setCandleRead } from '../src/flow/venueCheck.js';
import { clearTradeNotes, markSodexTrades } from '../src/indexer/read.js';
import type { TraderRow } from '../src/valuedesk/types.js';
import { RestReader } from '../src/indexer/sodexCatchup.js';
import type { Print } from '../src/indexer/streams.js';

const DAY = 20_400 * DAY_MS;
// No venue's candles are read from here: flowVenues.test.ts has its own.
setCandleRead(async () => null);
const tmp = () => mkdtempSync(join(tmpdir(), 'ledger-'));
const row = (t: number, n: number, q = n * 10): Kline => ({ t, n, v: String(n), q: String(q) });

/** A fake SoDEX: candles per symbol, answered as it answers (newest first, `endTime` inclusive, at most `limit`). */
function fakeVenue(candles: Record<string, Kline[]>) {
  const calls: Array<{ symbol: string; q: { limit: number; startTime?: number; endTime?: number } }> = [];
  return {
    calls,
    symbols: async (engine: 'perps' | 'spot') => (engine === 'perps' ? Object.keys(candles).filter((s) => !s.includes('_')) : Object.keys(candles).filter((s) => s.includes('_'))),
    klines: async (_e: 'perps' | 'spot', symbol: string, q: { limit: number; startTime?: number; endTime?: number }) => {
      calls.push({ symbol, q });
      const rows = (candles[symbol] ?? [])
        .filter((r) => (q.startTime === undefined || r.t >= q.startTime) && (q.endTime === undefined || r.t <= q.endTime))
        .sort((a, b) => b.t - a.t)
        .slice(0, q.limit);
      return { rows };
    },
  };
}

function setup(candles: Record<string, Kline[]>, held: Record<string, Map<number, number>>, start: number, activity: (d: number) => number | null = () => null) {
  const dir = tmp();
  const store = new LedgerStore(join(dir, 'ledger.db'));
  const venue = fakeVenue(candles);
  const clock = { now: start };
  const ledger = new CoverageLedger({
    store,
    symbols: venue.symbols,
    klines: venue.klines,
    heldOf: (symbol, from, to) => [...(held[symbol] ?? new Map<number, number>())].filter(([t]) => t >= from && t < to).map(([t, n]) => ({ t, n })),
    flowSince: () => DAY,
    activityOf: activity,
    now: () => clock.now,
  });
  return { dir, store, venue, clock, ledger };
}

test('a slot is what a flow chunk is', () => {
  assert.equal(SLOT_MS, CHUNK_MS);
});

test('held equal to the count is whole; one short is a hole; a hole fills when the catch-up fills it', async () => {
  const t0 = DAY + 3_600_000;
  const candles = { 'BTC-USD': [row(t0, 10), row(t0 + SLOT_MS, 20), row(t0 + 2 * SLOT_MS, 30)] };
  const held = { 'BTC-USD': new Map([[t0, 10], [t0 + SLOT_MS, 19], [t0 + 2 * SLOT_MS, 30]]) };
  const { store, clock, ledger, dir } = setup(candles, held, t0 + 3 * SLOT_MS + SETTLE_MS);
  await ledger.tick(); // the symbols
  await ledger.tick(); // the market
  const w = store.window('BTC-USD', t0, t0 + 3 * SLOT_MS);
  assert.equal(w.expected, 60);
  assert.equal(w.held, 59);
  assert.deepEqual(w.off, [{ t: t0 + SLOT_MS, held: 19, venue: 20 }]);
  const cov = coverageOf(['BTC-USD'], t0, t0 + 3 * SLOT_MS, clock.now, (s, a, b) => store.window(s, a, b));
  assert.equal(cov.holeSlots, 1);
  assert.deepEqual(cov.holes, [{ from: t0 + SLOT_MS, to: t0 + 2 * SLOT_MS, held: 19, venue: 20 }]);
  // The catch-up adds the print: the next visit sees it, with no new candle read needed for the old slot.
  held['BTC-USD']!.set(t0 + SLOT_MS, 20);
  clock.now += VISIT_EVERY_MS;
  await ledger.tick();
  const again = coverageOf(['BTC-USD'], t0, t0 + 3 * SLOT_MS, clock.now, (s, a, b) => store.window(s, a, b));
  assert.equal(again.holeSlots, 0);
  assert.equal(again.held, 60);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('held above the count is off too, and a row with no count is not judged', () => {
  const read = (): MarketWindow => ({
    market: { symbol: 'X-USD', engine: 'perps', checkedFrom: DAY, checkedTo: DAY + 10 * SLOT_MS, backDone: true },
    held: 5,
    expected: 4,
    off: [{ t: DAY, held: 5, venue: 4 }, { t: DAY + SLOT_MS, held: 0, venue: null }],
  });
  const c = coverageOf(['X-USD'], DAY, DAY + 2 * SLOT_MS, DAY + DAY_MS, read);
  assert.equal(c.holeSlots, 1);
  assert.deepEqual(c.unchecked, [[DAY + SLOT_MS, DAY + 2 * SLOT_MS]]);
});

test('touching slots join; a candle under 5 minutes is judged by its slot; a forming slot is not compared', () => {
  const read = (): MarketWindow => ({
    market: { symbol: 'X-USD', engine: 'perps', checkedFrom: DAY, checkedTo: DAY + 10 * SLOT_MS, backDone: true },
    held: 3,
    expected: 9,
    off: [{ t: DAY, held: 1, venue: 3 }, { t: DAY + SLOT_MS, held: 1, venue: 3 }, { t: DAY + 3 * SLOT_MS, held: 1, venue: 3 }],
  });
  const c = coverageOf(['X-USD'], DAY, DAY + 4 * SLOT_MS, DAY + DAY_MS, read);
  assert.deepEqual(c.holes.map((h) => [h.from, h.to, h.held, h.venue]), [[DAY, DAY + 2 * SLOT_MS, 2, 6], [DAY + 3 * SLOT_MS, DAY + 4 * SLOT_MS, 1, 3]]);
  const oneMinute = coverageOf(['X-USD'], DAY + 60_000, DAY + 120_000, DAY + DAY_MS, read);
  assert.equal(oneMinute.from, DAY);
  assert.equal(oneMinute.to, DAY + SLOT_MS);
  // Still forming: the slot that has not settled is neither compared nor unchecked.
  const forming = coverageOf(['X-USD'], DAY, DAY + SLOT_MS, DAY + SLOT_MS + SETTLE_MS - 1, read);
  assert.equal(forming.to, DAY);
  assert.deepEqual(forming.unchecked, []);
});

test('a market not reached, or not walked back that far, is unchecked; one whose history ran out is not', () => {
  const none = coverageOf(['X-USD'], DAY, DAY + 2 * SLOT_MS, DAY + DAY_MS, () => ({ market: null, held: 0, expected: 0, off: [] }));
  assert.deepEqual(none.unchecked, [[DAY, DAY + 2 * SLOT_MS]]);
  const market = (backDone: boolean): MarketWindow => ({ market: { symbol: 'X-USD', engine: 'perps', checkedFrom: DAY + SLOT_MS, checkedTo: DAY + 2 * SLOT_MS, backDone }, held: 0, expected: 0, off: [] });
  assert.deepEqual(coverageOf(['X-USD'], DAY, DAY + 3 * SLOT_MS, DAY + DAY_MS, () => market(false)).unchecked, [[DAY, DAY + SLOT_MS], [DAY + 2 * SLOT_MS, DAY + 3 * SLOT_MS]]);
  assert.deepEqual(coverageOf(['X-USD'], DAY, DAY + 3 * SLOT_MS, DAY + DAY_MS, () => market(true)).unchecked, [[DAY + 2 * SLOT_MS, DAY + 3 * SLOT_MS]]);
});

test('spans join and subtract; proven spans leave out holes and unchecked slots', () => {
  assert.deepEqual(joinSpans([[5, 7], [1, 3], [3, 4]]), [[1, 4], [5, 7]]);
  assert.deepEqual(subtractSpans([[0, 10]], [[2, 3], [5, 7]]), [[0, 2], [3, 5], [7, 10]]);
  assert.deepEqual(subtractSpans([[0, 10]], [[0, 10]]), []);
  assert.deepEqual(provenSpans({ venue: 'sodex', from: 0, to: 4 * SLOT_MS, held: 0, expected: 0, holes: [{ from: SLOT_MS, to: 2 * SLOT_MS, held: 0, venue: 1 }], holeSlots: 1, unchecked: [[3 * SLOT_MS, 4 * SLOT_MS]] }), [[0, SLOT_MS], [2 * SLOT_MS, 3 * SLOT_MS]]);
  // More holes than listed: nothing can be said of what lies between.
  assert.deepEqual(provenSpans({ venue: 'sodex', from: 0, to: 4 * SLOT_MS, held: 0, expected: 0, holes: [], holeSlots: 3, unchecked: [] }), []);
});

test('the first visit reads a page, the walk back reads on until history runs out, at most one call a tick', async () => {
  const end = DAY + 2 * DAY_MS;
  const all: Kline[] = [];
  for (let i = 1; i <= 2_100; i++) all.push(row(end - i * SLOT_MS, 1));
  const { store, venue, clock, ledger, dir } = setup({ 'BTC-USD': all }, {}, end + SETTLE_MS);
  await ledger.tick(); // the symbols (two calls of another kind: not candles)
  assert.equal(venue.calls.length, 0);
  await ledger.tick();
  assert.equal(venue.calls.length, 1);
  assert.equal(venue.calls[0]!.q.limit, PAGE);
  let m = store.market('BTC-USD')!;
  assert.equal(m.checkedTo, end);
  assert.equal(m.checkedFrom, end - PAGE * SLOT_MS);
  assert.equal(m.backDone, false);
  await ledger.tick();
  assert.equal(venue.calls.length, 2);
  assert.equal(venue.calls[1]!.q.endTime, end - PAGE * SLOT_MS - SLOT_MS);
  m = store.market('BTC-USD')!;
  assert.equal(m.checkedFrom, end - 2 * PAGE * SLOT_MS);
  await ledger.tick();
  m = store.market('BTC-USD')!;
  assert.equal(m.backDone, true);
  assert.equal(m.checkedFrom, end - 2_100 * SLOT_MS);
  // Nothing left to walk, nothing due: no call.
  const before = venue.calls.length;
  await ledger.tick();
  assert.equal(venue.calls.length, before);
  // Down for two days: the span comes back in pages with no hole in it.
  clock.now = end + 2 * DAY_MS + SETTLE_MS;
  all.push(...Array.from({ length: 576 }, (_, i) => row(end + i * SLOT_MS, 2)));
  await ledger.tick(); // the symbols, an hour on
  await ledger.tick();
  m = store.market('BTC-USD')!;
  assert.equal(m.checkedTo, end + 2 * DAY_MS);
  assert.equal(store.window('BTC-USD', end, end + 2 * DAY_MS).expected, 1_152);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('an idle market stores nothing but its span; prints with no candle are off', async () => {
  const t0 = DAY + 3_600_000;
  const { store, ledger, dir } = setup(
    { 'TON-USD': [row(t0, 0), row(t0 + SLOT_MS, 0)], 'TAO-USD': [] },
    { 'TAO-USD': new Map([[t0, 2]]) },
    t0 + 2 * SLOT_MS + SETTLE_MS,
  );
  await ledger.tick();
  await ledger.tick();
  await ledger.tick();
  assert.equal(store.slots('TON-USD', 0, Infinity).length, 0);
  assert.ok(store.market('TON-USD'));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('candles that have not got there yet prove nothing: the slots after the newest row stay unchecked', async () => {
  const t0 = DAY + 3_600_000;
  const candles = { 'BTC-USD': [row(t0, 10)] };
  const { store, clock, ledger, dir } = setup(candles, {}, t0 + SLOT_MS + SETTLE_MS);
  await ledger.tick();
  await ledger.tick();
  assert.equal(store.market('BTC-USD')!.checkedTo, t0 + SLOT_MS);
  // SoDEX's candles stop; our clock goes on an hour. No row, and it has had rows: not a quiet slot.
  clock.now += 3_600_000;
  await ledger.tick(); // the symbols
  await ledger.tick();
  assert.equal(store.market('BTC-USD')!.checkedTo, t0 + SLOT_MS);
  const c = coverageOf(['BTC-USD'], t0, t0 + 3 * SLOT_MS, clock.now, (s, a, b) => store.window(s, a, b));
  assert.deepEqual(c.unchecked, [[t0 + SLOT_MS, t0 + 3 * SLOT_MS]]);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a market whose candles stopped goes on with the others, so it does not hold every day back as unchecked', async () => {
  const t0 = DAY + 3_600_000;
  const now = t0 + SLOT_MS + SETTLE_MS;
  const later = now + DAY_MS;
  const btc = [row(t0, 10)];
  const { store, clock, ledger, dir } = setup({ 'BTC-USD': btc, 'vADA_vUSDC': [row(t0, 1)] }, {}, now);
  await ledger.tick();
  await ledger.tick();
  await ledger.tick();
  clock.now = later;
  for (let i = 1; i <= Math.floor(DAY_MS / SLOT_MS); i++) btc.push(row(t0 + i * SLOT_MS, 1));
  await ledger.tick(); // the symbols
  await ledger.tick();
  await ledger.tick();
  const end = slotDown(later - SETTLE_MS);
  assert.equal(store.market('BTC-USD')!.checkedTo, end);
  assert.equal(store.market('vADA_vUSDC')!.checkedTo, end);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a restart does not take in again what the snapshot repeats, and takes what is really new', () => {
  const dir = tmp();
  const t0 = DAY + 3_600_000;
  const clock = { now: t0 + 60_000 };
  const flow = new FlowStore(join(dir, 'flow.db'));
  const a = new FlowRecorder(flow, () => null, () => clock.now);
  const print = (id: string, t: number, symbol = 'DYDX', sz = 1): Print => ({ venue: 'hyperliquid', id, t, symbol, px: 1, sz, buyer: '0xA', seller: '0xB', taker: 'buyer' });
  a.add(print('1', t0 + 1));
  a.add(print('2', t0 + 1)); // twins: the same in every field
  a.add({ ...print('3', t0 + 2, 'xyz:TSLA'), venue: 'tradexyz' });
  clock.now += FLUSH_MS + 1;
  a.stop();
  clock.now += 60_000;
  const b = new FlowRecorder(flow, () => null, () => clock.now);
  assert.equal(b.repeatOfHeld(print('1', t0 + 1)), true);
  assert.equal(b.repeatOfHeld(print('2', t0 + 1)), true);
  assert.equal(b.repeatOfHeld(print('9', t0 + 1)), false, 'a third of the same was not held');
  assert.equal(b.repeatOfHeld(print('8', t0 + 5, 'DYDX', 2)), false, 'held by nobody: the gap it fills');
  assert.equal(b.repeatOfHeld(print('3', t0 + 2, 'xyz:TSLA')), true, 'as Hyperliquid hands it in, held under trade.xyz');
  assert.equal(b.repeatOfHeld(print('7', clock.now + 1)), false, 'newer than this run');
  flow.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a 429 stops the calls for five minutes and moves nothing', async () => {
  const t0 = DAY + 3_600_000;
  const dir = tmp();
  const store = new LedgerStore(join(dir, 'ledger.db'));
  let calls = 0;
  const clock = { now: t0 };
  const ledger = new CoverageLedger({
    store,
    symbols: async (e) => (e === 'perps' ? ['BTC-USD'] : []),
    klines: async () => { calls++; return { rows: [], limited: true }; },
    heldOf: () => [],
    flowSince: () => DAY,
    activityOf: () => null,
    now: () => clock.now,
  });
  await ledger.tick();
  await ledger.tick();
  assert.equal(calls, 1);
  assert.equal(store.market('BTC-USD'), null);
  clock.now += 60_000;
  await ledger.tick();
  assert.equal(calls, 1);
  assert.equal(ledger.status().limited, 1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a day is complete only if its prints match and its volume is within the tolerance', () => {
  const today = 100;
  const d = (o: Partial<DayRow>): DayRow => ({ day: 90, venuePrints: 100, heldPrints: 100, venueUsd: 1_000, activityUsd: 1_000, known: true, at: 0, ...o });
  assert.equal(dayState(undefined, today), 'unchecked');
  assert.equal(dayState(d({}), today), 'complete');
  assert.equal(dayState(d({ known: false }), today), 'unchecked');
  // Short needs no whole day: a slot read so far, or activity under the part of the venue read so far.
  assert.equal(dayState(d({ known: false, heldPrints: 17, venuePrints: 100 }), today), 'short');
  assert.equal(dayState(d({ known: false, heldPrints: null, activityUsd: 500 }), today), 'short');
  assert.equal(dayState(d({ known: false, heldPrints: null, activityUsd: 5_000 }), today), 'unchecked', 'all of activity against part of the venue says nothing');
  assert.equal(dayState(d({ day: today, known: false, activityUsd: null, heldPrints: 50 }), today), 'short');
  assert.equal(dayState(d({ heldPrints: 99 }), today), 'short');
  assert.equal(dayState(d({ activityUsd: 130 }), today), 'short', '13 % of the venue, as on 11-04');
  assert.equal(dayState(d({ heldPrints: null, activityUsd: 70 }), today), 'short', 'before the flow began: volume alone');
  assert.equal(dayState(d({ heldPrints: null, activityUsd: 999.5 }), today), 'complete');
  assert.equal(dayState(d({ heldPrints: null, activityUsd: 995 }), today), 'short');
  assert.equal(dayState(d({ activityUsd: 1_200 }), today), 'short', 'more than the venue is not whole either');
  assert.equal(dayState(d({ activityUsd: null, heldPrints: 100 }), today), 'unchecked');
  // The day still forming: prints alone, its volumes are read at different moments.
  assert.equal(dayState(d({ day: today, activityUsd: null }), today), 'complete');
  assert.equal(dayState(d({ day: today, activityUsd: null, heldPrints: 50 }), today), 'short');
});

test('days the ledger has no row for are there, as not checked; shares are one side over the venue', async () => {
  const days = activityDays([{ day: 11, venuePrints: 5, heldPrints: null, venueUsd: 100, activityUsd: 7, known: true, at: 0 }], 10, 12, 20);
  assert.deepEqual(days.map((d) => d.state), ['unchecked', 'short', 'unchecked']);
  assert.equal(days[1]!.share, 0.07);
  assert.equal(days[1]!.t, 11 * DAY_MS);

  const t0 = DAY + 3_600_000;
  const now = DAY + DAY_MS + 3_600_000;
  const { store, ledger, dir } = setup({ 'BTC-USD': [row(t0, 10, 100), row(DAY + DAY_MS, 0, 0)], 'ETH-USD': [row(t0, 5, 50), row(DAY + DAY_MS, 0, 0)] }, { 'BTC-USD': new Map([[t0, 10]]), 'ETH-USD': new Map([[t0, 5]]) }, now, () => 300);
  await ledger.tick();
  await ledger.tick();
  await ledger.tick();
  ledger.refreshDays(now);
  const [day] = store.days(DAY / DAY_MS, DAY / DAY_MS);
  assert.equal(day!.venuePrints, 15);
  assert.equal(day!.heldPrints, 15);
  assert.equal(day!.venueUsd, 150);
  assert.equal(day!.activityUsd, 150, 'written to both parties, so halved');
  assert.equal(day!.known, true);
  assert.equal(dayState(day, Math.floor(now / DAY_MS)), 'complete');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// --- through the flow's reads ----------------------------------------------------------------------------

test('a past window is final only when SoDEX\'s count agrees: short slots are gaps, never cached as final, and heal', async () => {
  const dir = tmp();
  const flowPath = join(dir, 'flow.db');
  process.env.VALUESCAN_FLOW_DB = flowPath;
  closeFlowReader();
  closeLedgerReader();
  clearFlowCaches();
  const t0 = DAY + 3_600_000;
  const clock = { now: t0 };
  const flow = new FlowStore(flowPath);
  const rec = new FlowRecorder(flow, () => null, () => clock.now);
  const print = (t: number, id: number): Print => ({ venue: 'sodex', id: String(id), t, symbol: 'BTC-USD', px: 100, sz: 1, buyer: '1', seller: '2', taker: 'buyer' });
  rec.add(print(t0 + 1, 1));
  rec.add(print(t0 + SLOT_MS + 1, 2));
  rec.add({ venue: 'hyperliquid', id: 'h', t: t0 + 1, symbol: 'BTC', px: 100, sz: 1, buyer: '0xa', seller: '0xb', taker: 'buyer' });
  clock.now = t0 + 2 * SLOT_MS + CLOSE_MS + FLUSH_MS + 1_000;
  rec.tick();
  rec.tick();
  const ledgerStore = new LedgerStore(ledgerPathFor(flowPath));
  const put = (heldSecond: number) => {
    ledgerStore.putSlot('BTC-USD', { t: t0, venueN: 1, held: 1, venueUsd: 100 });
    ledgerStore.putSlot('BTC-USD', { t: t0 + SLOT_MS, venueN: 3, held: heldSecond, venueUsd: 300 });
    ledgerStore.putMarket({ symbol: 'BTC-USD', engine: 'perps', checkedFrom: t0, checkedTo: t0 + 2 * SLOT_MS, backDone: true });
  };
  put(1);
  const ask = { coin: 'BTC', venues: ['sodex'] as const, kind: 'perp' as const, from: t0, to: t0 + 2 * SLOT_MS, role: 'all' as const, side: 'all' as const, sort: 'volume' as const, limit: 10 };
  const later = t0 + 2 * SLOT_MS + READY_MS + CLOSE_MS + FLUSH_MS + 10 * 60_000;
  rec.stop(); // the run log reaches past the window's end
  flow.setMeta('since', String(t0 - 1));
  flow.setMeta('runs', JSON.stringify([[t0 - 1, later]]));

  const short = await flowWindow(ask, later);
  assert.ok(short);
  assert.equal(short.final, false, 'a short slot is not final, however long ago');
  assert.deepEqual(short.gaps, [[t0 + SLOT_MS, t0 + 2 * SLOT_MS]]);
  assert.deepEqual(short.down, []);
  assert.equal(short.coverage!.held, 2);
  assert.equal(short.coverage!.expected, 4);
  const fills = await flowWalletFills({ coin: 'BTC', venues: ['sodex'], kind: 'perp', from: t0, to: t0 + 2 * SLOT_MS, wallet: '1' }, later);
  assert.equal(fills!.final, false);
  assert.deepEqual(fills!.gaps, short.gaps);

  // Read again past the 5 s an unsettled answer may be reused: filled now, so whole and final.
  put(3);
  const whole = await flowWindow(ask, later + 6_000);
  assert.equal(whole!.final, true);
  assert.deepEqual(whole!.gaps, []);
  assert.equal(whole!.coverage!.holeSlots, 0);

  // A recorder gap the count proves was filled is no gap for SoDEX alone...
  clearFlowCaches();
  flow.setMeta('runs', JSON.stringify([[t0 - 1, t0 + 60_000], [t0 + 2 * SLOT_MS, later]]));
  const proved = await flowWindow(ask, later + 12_000);
  assert.deepEqual(proved!.down, []);
  assert.equal(proved!.final, true);
  // ...and stays one where the other venues are asked too.
  clearFlowCaches();
  const mixed = await flowWindow({ ...ask, venues: ['sodex', 'hyperliquid'] }, later + 12_000);
  assert.ok(mixed!.down.length > 0);
  assert.equal(mixed!.final, false);

  // Per day, through the route's read.
  ledgerStore.putDay({ day: DAY / DAY_MS, venuePrints: 4, heldPrints: 2, venueUsd: 400, activityUsd: 200, known: true, at: later });
  const cov = activityCoverage(DAY, DAY + DAY_MS - 1, later);
  assert.equal(cov.checked, true);
  assert.deepEqual(cov.days.map((d) => [d.state, d.share]), [['short', 0.5]]);

  closeLedgerReader();
  closeFlowReader();
  clearFlowCaches();
  ledgerStore.close();
  flow.close();
  delete process.env.VALUESCAN_FLOW_DB;
  rmSync(dir, { recursive: true, force: true });
});

test('no ledger yet: SoDEX is said to be unchecked and not final; another venue goes by its own figures', async () => {
  const dir = tmp();
  const flowPath = join(dir, 'flow.db');
  process.env.VALUESCAN_FLOW_DB = flowPath;
  closeFlowReader();
  closeLedgerReader();
  clearFlowCaches();
  const t0 = DAY + 3_600_000;
  const clock = { now: t0 };
  const flow = new FlowStore(flowPath);
  const rec = new FlowRecorder(flow, () => null, () => clock.now);
  rec.add({ venue: 'sodex', id: '1', t: t0 + 1, symbol: 'BTC-USD', px: 100, sz: 1, buyer: '1', seller: '2', taker: 'buyer' });
  rec.add({ venue: 'hyperliquid', id: '2', t: t0 + 1, symbol: 'BTC', px: 100, sz: 1, buyer: '0xa', seller: '0xb', taker: 'buyer' });
  clock.now = t0 + SLOT_MS + CLOSE_MS + FLUSH_MS + 1_000;
  rec.tick();
  rec.stop();
  const later = t0 + DAY_MS;
  flow.setMeta('since', String(t0 - 1));
  flow.setMeta('runs', JSON.stringify([[t0 - 1, later]]));
  const ask = { coin: 'BTC', kind: 'perp' as const, from: t0, to: t0 + SLOT_MS, role: 'all' as const, side: 'all' as const, sort: 'volume' as const, limit: 10 };
  const sodex = await flowWindow({ ...ask, venues: ['sodex'] }, later);
  assert.equal(sodex!.final, false);
  assert.deepEqual(sodex!.coverage!.unchecked, [[t0, t0 + SLOT_MS]]);
  setCandleRead(async () => ({ unit: 'prints', rows: [{ t: t0, v: 1, final: true }] }));
  const hl = await flowWindow({ ...ask, venues: ['hyperliquid'] }, later);
  assert.equal(hl!.final, true, 'compared and equal');
  assert.equal(hl!.coverage, null);
  setCandleRead(async () => null);
  closeFlowReader();
  clearFlowCaches();
  flow.close();
  delete process.env.VALUESCAN_FLOW_DB;
  rmSync(dir, { recursive: true, force: true });
});

test('the thread starts under tsx, reads a local SoDEX through RestReader, and writes its own file', async () => {
  const dir = tmp();
  const flowPath = join(dir, 'flow.db');
  const indexPath = join(dir, 'index.db');
  new FlowStore(flowPath).close();
  const now = Date.now();
  const t = Math.floor(now / SLOT_MS) * SLOT_MS - 2 * SLOT_MS;
  const urls: string[] = [];
  const server = createServer((req, res) => {
    urls.push(req.url!);
    res.setHeader('content-type', 'application/json');
    if (req.url!.includes('/perps/markets/symbols')) res.end(JSON.stringify({ data: [{ symbol: 'BTC-USD' }] }));
    else if (req.url!.includes('/spot/markets/symbols')) res.end(JSON.stringify({ data: [] }));
    else res.end(JSON.stringify({ data: [{ t, n: 7, v: '1', q: '70' }] }));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const thread = startLedgerThread({ flow: flowPath, index: indexPath, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tickMs: 50 });
  try {
    const path = ledgerPathFor(flowPath);
    let slot = null as { venueN: number | null } | null;
    for (let i = 0; i < 200 && !slot; i++) {
      await wait(100);
      try {
        const s = new LedgerStore(path, { readOnly: true });
        try { if (s.ready()) slot = s.slots('BTC-USD', t, t + 1)[0] ?? null; } finally { s.close(); }
      } catch { /* not made yet */ }
    }
    assert.equal(slot?.venueN, 7);
    assert.ok(urls.some((u) => u.includes('/perps/markets/BTC-USD/klines?interval=5m&limit=1000')), urls.join(' '));
  } finally {
    thread.stop();
    server.close();
    await wait(100);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('SoDEX trade counts read as floors over days not proved whole; other venues are left alone', () => {
  const dir = tmp();
  process.env.VALUESCAN_FLOW_DB = join(dir, 'none.db');
  closeLedgerReader();
  clearTradeNotes();
  const row = (venue: 'sodex' | 'hyperliquid', venues?: Array<'sodex' | 'hyperliquid'>): TraderRow => ({ venue, ...(venues ? { venues } : {}), address: '0xa', pnl: {}, roi: {}, volume: {}, trades: 5, tradesCapped: false } as unknown as TraderRow);
  const rows = [row('sodex'), row('hyperliquid'), row('hyperliquid', ['hyperliquid', 'sodex'])];
  const note = markSodexTrades(rows, '7d');
  assert.ok(note);
  assert.equal(note.short, 0);
  assert.equal(note.unchecked, note.days);
  assert.deepEqual(rows.map((r) => r.tradesCapped), [true, false, true]);
  const none = [row('hyperliquid')];
  assert.equal(markSodexTrades(none, '7d'), undefined);
  assert.equal(none[0]!.tradesCapped, false);
  delete process.env.VALUESCAN_FLOW_DB;
  clearTradeNotes();
  rmSync(dir, { recursive: true, force: true });
});

test('RestReader passes the window on and reads a 429 as limited', async () => {
  const urls: string[] = [];
  let answer = 200;
  const server = createServer((req, res) => {
    urls.push(req.url!);
    res.statusCode = answer;
    res.end(JSON.stringify({ data: [{ t: 1, n: 1 }] }));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const reader = new RestReader(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  try {
    const got = await reader.klines('spot', 'vBTC_vUSDC', { limit: 10, startTime: 5, endTime: 9 });
    assert.equal(got.rows.length, 1);
    assert.equal(urls[0], '/api/v1/spot/markets/vBTC_vUSDC/klines?interval=5m&limit=10&startTime=5&endTime=9');
    answer = 429;
    assert.equal((await reader.klines('perps', 'BTC-USD', { limit: 10 })).limited, true);
  } finally {
    reader.stop();
    server.close();
  }
});
