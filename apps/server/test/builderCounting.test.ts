/**
 * What counts as volume, as pure rules (src/builder/counting.ts,
 * docs/BUILDER-TIERS.md §5): reading a fill, the fee a wallet owed at a time,
 * adding fills up per order, and deciding an order once the explorer has shown
 * its signed request.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  APP_ORDER_ID, CLOCK_SLACK_MS, MAX_NOTED, OrderState, addMicro, applyFills, dayOf, awaitsExplorer, defaultsOf, dollarQuoted, feeOwedAt, graceMs, judgeOrder, readFill,
  type FeeRow, type Fill, type OrderFacts, type OrderRow,
} from '../src/builder/counting.js';
import { TERMS_TTL_MS } from '../src/builder/terms.js';

const FX = JSON.parse(readFileSync(new URL('./builderExplorer.fixture.json', import.meta.url), 'utf8')) as { fills: Array<Record<string, unknown>> };

const BUILDER = 123456;
const T = 1_790_000_000_000;
const MIN = 60_000;
const DFLT = defaultsOf({ perps: 20, spot: 20 });

// --- reading a fill -----------------------------------------------------------------

test('fill: real spot fills - the builder fee is exactly notional x rate, the notional is exact', () => {
  assert.equal(FX.fills.length, 9);
  for (const raw of FX.fills) {
    const f = readFill(raw, 'spot')!;
    assert.ok(f, JSON.stringify(raw));
    assert.equal(f.rate, 100, 'these orders named a builder at 10 bp');
    assert.equal(f.paid, true);
    assert.equal(f.charging, true);
    assert.equal(f.sell, true);
    assert.equal(f.symbol, 'vSOL_vUSDC');
    assert.equal(f.key, `vSOL_vUSDC:${raw.tradeID}:${raw.orderID}`);
    assert.equal(f.orderKey, `vSOL_vUSDC:${raw.orderID}`);
  }
  // 123 x 0.025 = 3.075; 121.67 x 10.315 = 1255.02605 - no float in between.
  assert.equal(readFill(FX.fills.find((r) => r.tradeID === 1512431), 'spot')!.notionalMicro, 3_075_000);
  assert.equal(readFill(FX.fills.find((r) => r.tradeID === 1512355), 'spot')!.notionalMicro, 1_255_026_050);
  // The three fills of order s1129 add up to what its order record says it executed: 1731.84.
  const s1129 = FX.fills.filter((r) => r.orderID === 6896407749).map((r) => readFill(r, 'spot')!.notionalMicro);
  assert.equal(s1129.reduce(addMicro, 0), 1_731_840_000);
});

const fill = (o: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  symbol: 'BTC-USD', tradeID: 1, orderID: 77, clOrdID: 'vs-abc', side: 'BUY', price: '50000', quantity: '0.001', fee: '0.0325', builderFee: '0.01', feeCoin: 'vUSDC', time: T, isMaker: false, ...o,
});

test('fill: perps pays on both sides, spot only on sells, and only dollar pairs are counted in dollars', () => {
  const perpsBuy = readFill(fill(), 'perps')!;
  assert.deepEqual(
    { n: perpsBuy.notionalMicro, rate: perpsBuy.rate, paid: perpsBuy.paid, charging: perpsBuy.charging, sell: perpsBuy.sell },
    { n: 50_000_000, rate: 20, paid: true, charging: true, sell: false },
  );
  assert.equal(readFill(fill({ side: 'SELL' }), 'perps')!.paid, true);
  // 1.5 bp.
  assert.equal(readFill(fill({ builderFee: '0.0075' }), 'perps')!.rate, 15);

  // A spot buy is never charged a builder fee: not a fill that counts, and not one that should have paid.
  const spotBuy = readFill(fill({ symbol: 'vETH_vUSDC', side: 'BUY', builderFee: undefined, feeCoin: 'vETH' }), 'spot')!;
  assert.deepEqual({ paid: spotBuy.paid, charging: spotBuy.charging, charged: spotBuy.charged, rate: spotBuy.rate }, { paid: false, charging: false, charged: false, rate: 0 });
  // Even if a buy row carried one, it is not counted.
  assert.equal(readFill(fill({ symbol: 'vETH_vUSDC', side: 'BUY' }), 'spot')!.paid, false);
  const spotSell = readFill(fill({ symbol: 'vETH_vUSDC', side: 'SELL' }), 'spot')!;
  assert.deepEqual({ paid: spotSell.paid, charging: spotSell.charging }, { paid: true, charging: true });
  // No builder fee on a fill that carries one whenever the order names a builder.
  const bare = readFill(fill({ builderFee: undefined }), 'perps')!;
  assert.deepEqual({ paid: bare.paid, charging: bare.charging, charged: bare.charged }, { paid: false, charging: true, charged: false });
  assert.equal(readFill(fill({ builderFee: '0' }), 'perps')!.charged, false);

  // A pair quoted in another coin: a fee was charged, but nothing is counted in dollars.
  const cross = readFill(fill({ symbol: 'vBTC_vETH', side: 'SELL', feeCoin: 'vETH' }), 'spot')!;
  assert.deepEqual({ paid: cross.paid, charged: cross.charged, n: cross.notionalMicro }, { paid: false, charged: true, n: 0 });
  assert.equal(readFill(fill({ symbol: 'vETH_vUSDC', side: 'SELL', feeCoin: 'WSOSO' }), 'spot')!.paid, false, 'a fee in another coin is not a dollar fee');
  assert.equal(dollarQuoted('perps', 'DOGE-USD'), true);
  assert.equal(dollarQuoted('spot', 'vBTC_vUSDC'), true);
  assert.equal(dollarQuoted('spot', 'WSOSO_vUSDC'), true);
  assert.equal(dollarQuoted('spot', 'vBTC_vETH'), false);
  assert.equal(dollarQuoted('spot', 'vUSDC'), false);
});

test('fill: tolerant of spellings, strict about what it cannot read', () => {
  // Numbers where strings are documented, enum integers for the side, exponent notation.
  const f = readFill(fill({ side: 2, price: 50000, quantity: '1e-3', orderID: '77', tradeID: '9', builderFee: 0.01 }), 'perps')!;
  assert.deepEqual({ sell: f.sell, n: f.notionalMicro, rate: f.rate, key: f.key }, { sell: true, n: 50_000_000, rate: 20, key: 'BTC-USD:9:77' });
  assert.equal(readFill(fill({ side: 'sell' }), 'perps')!.sell, true);
  // Dust: a notional below a millionth of a dollar counts as nothing.
  assert.equal(readFill(fill({ price: '0.0000001', quantity: '1' }), 'perps')!.notionalMicro, 0);
  // A huge fill stays an exact, safe number.
  assert.equal(readFill(fill({ price: '99999999', quantity: '99999999' }), 'perps')!.notionalMicro, Number.MAX_SAFE_INTEGER);
  for (const bad of [
    null, 'row', 7, {}, fill({ symbol: undefined }), fill({ orderID: undefined }), fill({ tradeID: -1 }), fill({ side: 'HOLD' }), fill({ time: 'now' }),
    fill({ time: 0 }), fill({ price: 'abc' }), fill({ price: '-1' }), fill({ quantity: undefined }), fill({ orderID: 1.5 }), fill({ symbol: 'x'.repeat(65) }),
    fill({ price: '9'.repeat(40) }),
  ]) {
    assert.equal(readFill(bad, 'perps'), null, JSON.stringify(bad)?.slice(0, 80));
  }
  // A builder fee that cannot be read is no builder fee.
  assert.equal(readFill(fill({ builderFee: 'lots' }), 'perps')!.paid, false);
  assert.equal(readFill(fill({ clOrdID: 12 }), 'perps')!.clOrdID, null);
});

// --- the fee owed over time ---------------------------------------------------------------

test('fee owed: a wallet with no history owes the default, per engine', () => {
  assert.equal(graceMs(), TERMS_TTL_MS + CLOCK_SLACK_MS);
  assert.equal(graceMs(), 12 * MIN);
  assert.equal(feeOwedAt([], DFLT, 'perps', T), 20);
  assert.equal(feeOwedAt([], defaultsOf({ perps: 20, spot: 100 }), 'spot', T), 100);
  assert.throws(() => feeOwedAt([], [], 'perps', T), RangeError);
});

test('fee owed: a lower fee counts from the moment it is on record - and two minutes before, for the clocks', () => {
  const h: FeeRow[] = [{ at: T, perps: 15, spot: 20 }];
  // Before the tier was reached nobody could hold terms at 15.
  assert.equal(feeOwedAt(h, DFLT, 'perps', T - CLOCK_SLACK_MS - 1), 20);
  // SoDEX's clock may be behind ours: an order stamped up to two minutes before the record owes 15.
  assert.equal(feeOwedAt(h, DFLT, 'perps', T - CLOCK_SLACK_MS), 15);
  assert.equal(feeOwedAt(h, DFLT, 'perps', T), 15);
  assert.equal(feeOwedAt(h, DFLT, 'perps', T + 365 * 86_400_000), 15, 'it stays in force until the next change');
  assert.equal(feeOwedAt(h, DFLT, 'spot', T), 20, 'spot did not change');
});

test('fee owed: a higher fee is owed only once terms signed before the change have run out', () => {
  // 15 from T on; back to 20 an hour later (the underpaid policy, a changed file, a removed override).
  const up = T + 60 * MIN;
  const h: FeeRow[] = [{ at: T, perps: 15, spot: 20 }, { at: up, perps: 20, spot: 20 }];
  assert.equal(feeOwedAt(h, DFLT, 'perps', up - 1), 15);
  assert.equal(feeOwedAt(h, DFLT, 'perps', up), 15, 'terms signed a moment before are still valid');
  assert.equal(feeOwedAt(h, DFLT, 'perps', up + TERMS_TTL_MS), 15);
  assert.equal(feeOwedAt(h, DFLT, 'perps', up + graceMs() - 1), 15);
  assert.equal(feeOwedAt(h, DFLT, 'perps', up + graceMs()), 20, 'ttl plus two minutes after the change the old fee is no excuse');
  assert.equal(feeOwedAt(h, DFLT, 'perps', up + 24 * 60 * MIN), 20);
});

test('fee owed: the lowest fee in force anywhere in the window', () => {
  const h: FeeRow[] = [
    { at: T, perps: 15, spot: 18 },
    { at: T + 5 * MIN, perps: 10, spot: 18 },
    { at: T + 6 * MIN, perps: 20, spot: 20 },
    { at: T + 100 * MIN, perps: 12, spot: 12 },
  ];
  assert.equal(feeOwedAt(h, DFLT, 'perps', T + 2 * MIN), 15);
  assert.equal(feeOwedAt(h, DFLT, 'perps', T + 3 * MIN), 10, 'the fee recorded two minutes later already excuses it (slack)');
  assert.equal(feeOwedAt(h, DFLT, 'perps', T + 10 * MIN), 10, 'a fee that was in force for one minute still excuses orders within the grace');
  assert.equal(feeOwedAt(h, DFLT, 'perps', T + 18 * MIN - 1), 10);
  assert.equal(feeOwedAt(h, DFLT, 'perps', T + 18 * MIN), 20);
  assert.equal(feeOwedAt(h, DFLT, 'spot', T + 10 * MIN), 18);
  assert.equal(feeOwedAt(h, DFLT, 'spot', T + 50 * MIN), 20);
  assert.equal(feeOwedAt(h, DFLT, 'spot', T + 99 * MIN), 12);
  // The default itself is part of the window when the first record is recent.
  assert.equal(feeOwedAt([{ at: T, perps: 25, spot: 25 }], DFLT, 'perps', T + MIN), 20);
});

test('fee owed: a wallet without a row owes the default of that moment - a raised default is not owed backwards', () => {
  const raised: FeeRow[] = [{ at: T - 100 * MIN, perps: 20, spot: 20 }, { at: T, perps: 50, spot: 50 }];
  // An order from before the default was raised owed the old default ...
  assert.equal(feeOwedAt([], raised, 'perps', T - 30 * MIN), 20);
  // ... so does one inside the grace after it; later ones owe the new one.
  assert.equal(feeOwedAt([], raised, 'perps', T + graceMs() - 1), 20);
  assert.equal(feeOwedAt([], raised, 'perps', T + graceMs()), 50);
  // Before the first record there is only that record to go by.
  assert.equal(feeOwedAt([], raised, 'perps', T - 1000 * MIN), 20);
  // A lowered default is owed from the moment it is on record.
  const lowered: FeeRow[] = [{ at: T - 100 * MIN, perps: 50, spot: 50 }, { at: T, perps: 20, spot: 20 }];
  assert.equal(feeOwedAt([], lowered, 'perps', T - CLOCK_SLACK_MS - 1), 50);
  assert.equal(feeOwedAt([], lowered, 'perps', T), 20);
  // A wallet with a row of its own is not moved by the default: its row is what was signed ...
  const own: FeeRow[] = [{ at: T - 50 * MIN, perps: 15, spot: 20 }];
  assert.equal(feeOwedAt(own, raised, 'perps', T + 60 * MIN), 15);
  // ... and before that row it owed the default of the time.
  assert.equal(feeOwedAt(own, raised, 'perps', T - 80 * MIN), 20);
});

// --- adding fills up per order ---------------------------------------------------------------

let seq = 100;
const mk = (orderID: number, o: Partial<Record<string, unknown>> = {}, engine: 'perps' | 'spot' = 'perps'): Fill =>
  readFill(fill({ orderID, tradeID: seq++, ...o }), engine)!;
const noRow = () => null;
const owes20 = () => 20;

test('fills: fills that paid a builder fee wait in a pending row - nothing counts before the order is looked up', () => {
  const r = applyFills({ fills: [mk(1), mk(1, { price: '50100', builderFee: '0.01002' }), mk(2, { builderFee: '0.0075' })], row: noRow, owedAt: owes20, checks: 0 });
  assert.equal(r.addMicro, 0);
  assert.equal(r.queued, 2);
  assert.deepEqual(r.noBuilder, { n: 0, at: 0 });
  const [a, b] = r.rows;
  assert.deepEqual(
    { key: a!.key, state: a!.state, paid: a!.paidMicro, rate: a!.rate, counted: a!.countedMicro, cl: a!.clOrdID },
    { key: 'BTC-USD:1', state: OrderState.pending, paid: 100_100_000, rate: 20, counted: 0, cl: 'vs-abc' },
  );
  assert.deepEqual({ key: b!.key, rate: b!.rate, paid: b!.paidMicro }, { key: 'BTC-USD:2', rate: 15, paid: 50_000_000 });
  assert.ok(awaitsExplorer(a!.state));
});

test('fills: an order known to be ours that fills further adds its new fills at once; a pending one just grows', () => {
  const counted: OrderRow = { key: 'BTC-USD:1', orderId: '1', symbol: 'BTC-USD', clOrdID: 'vs-abc', t: T, lastT: T, state: OrderState.counted, paidMicro: 50_000_000, rate: 20, countedMicro: 50_000_000, tries: 1, nextAt: 0 };
  const pending: OrderRow = { ...counted, key: 'BTC-USD:2', orderId: '2', state: OrderState.pending, countedMicro: 0 };
  const rows = new Map([[counted.key, counted], [pending.key, pending]]);
  const r = applyFills({
    fills: [mk(1, { time: T + 5 }), mk(1, { time: T + 9, quantity: '0.002', builderFee: '0.02' }), mk(2, { time: T + 7 })],
    row: (k) => rows.get(k) ?? null, owedAt: owes20, checks: 0,
  });
  assert.equal(r.addMicro, 150_000_000, 'the counted order\'s two new fills');
  // By the UTC day of each fill, for a volume window: here both on the day of T.
  assert.deepEqual([...r.byDay], [[dayOf(T + 5), 150_000_000]]);
  assert.equal(r.queued, 0, 'nothing new for the explorer');
  const c = r.rows.find((x) => x.key === 'BTC-USD:1')!;
  assert.deepEqual({ counted: c.countedMicro, paid: c.paidMicro, lastT: c.lastT, t: c.t }, { counted: 200_000_000, paid: 200_000_000, lastT: T + 9, t: T });
  const p = r.rows.find((x) => x.key === 'BTC-USD:2')!;
  assert.deepEqual({ counted: p.countedMicro, paid: p.paidMicro, state: p.state }, { counted: 0, paid: 100_000_000, state: OrderState.pending });
  // A fill of a counted order that paid less than the order's fee is left out.
  const less = applyFills({ fills: [mk(1, { time: T + 20, builderFee: '0.005' })], row: (k) => rows.get(k) ?? null, owedAt: owes20, checks: 0 });
  assert.equal(less.addMicro, 0);
});

test('fills: orders decided as another builder\'s, underpaid or unknown never count, however much they fill', () => {
  for (const state of [OrderState.other, OrderState.underpaid, OrderState.unknown, OrderState.checked] as const) {
    const held: OrderRow = { key: 'BTC-USD:1', orderId: '1', symbol: 'BTC-USD', clOrdID: null, t: T, lastT: T, state, paidMicro: 50_000_000, rate: 100, countedMicro: 0, tries: 1, nextAt: 0 };
    const r = applyFills({ fills: [mk(1, { time: T + 5, builderFee: '0.05' })], row: () => held, owedAt: owes20, checks: 5 });
    assert.equal(r.addMicro, 0, String(state));
    assert.equal(r.queued, 0);
    assert.equal(r.rows[0]!.state, state);
  }
});

test('fills: spot buys never count and are never held against the wallet', () => {
  const buy = (id: number) => mk(id, { symbol: 'vETH_vUSDC', side: 'BUY', builderFee: undefined, feeCoin: 'vETH' }, 'spot');
  const r = applyFills({ fills: [buy(1), buy(2)], row: noRow, owedAt: owes20, checks: 5 });
  assert.deepEqual(r, { addMicro: 0, byDay: new Map(), rows: [], queued: 0, noBuilder: { n: 0, at: 0 } });
});

test('fills: builder-less orders where a fee was owed - the app\'s own client order ids first, a bounded number, each once', () => {
  const bare = (id: number, cl: string, at: number) => mk(id, { clOrdID: cl, builderFee: undefined, time: at });
  const fills = [bare(1, 'bot-1', T + 1), bare(2, 'vs-x1', T + 2), bare(3, 'bot-3', T + 3), bare(4, 'tp-x2', T + 4), bare(5, 'sl-x3', T + 5), bare(6, 'bot-6', T + 6)];
  const two = applyFills({ fills, row: noRow, owedAt: owes20, checks: 2 });
  // Two go to the explorer - the newest two with the app's ids; the third app id is noted, not looked up.
  assert.deepEqual(two.rows.map((r) => [r.key, r.state]), [['BTC-USD:5', OrderState.check], ['BTC-USD:4', OrderState.check], ['BTC-USD:2', OrderState.checked]]);
  assert.equal(two.queued, 2);
  assert.deepEqual(two.noBuilder, { n: 3, at: T + 5 });
  assert.equal(two.addMicro, 0);

  // With room for more, other client order ids are looked at too (a tampered copy can change the prefix) - but never flagged.
  const five = applyFills({ fills, row: noRow, owedAt: owes20, checks: 5 });
  assert.deepEqual(five.rows.map((r) => r.key), ['BTC-USD:5', 'BTC-USD:4', 'BTC-USD:2', 'BTC-USD:6', 'BTC-USD:3']);
  assert.equal(five.queued, 5);
  assert.deepEqual(five.noBuilder, { n: 3, at: T + 5 });

  // No lookups wanted: the prefix is still worth a flag, and a row keeps it from being raised again.
  const none = applyFills({ fills, row: noRow, owedAt: owes20, checks: 0 });
  assert.deepEqual(none.rows.map((r) => [r.key, r.state]), [['BTC-USD:5', OrderState.checked], ['BTC-USD:4', OrderState.checked], ['BTC-USD:2', OrderState.checked]]);
  assert.equal(none.queued, 0);
  const held = new Map(none.rows.map((r) => [r.key, r]));
  const again = applyFills({ fills, row: (k) => held.get(k) ?? null, owedAt: owes20, checks: 0 });
  assert.deepEqual(again, { addMicro: 0, byDay: new Map(), rows: [], queued: 0, noBuilder: { n: 0, at: 0 } }, 'the same fills again raise nothing');

  // Where no fee is owed (a fee of 0 attaches no builder) there is nothing to miss.
  assert.deepEqual(applyFills({ fills, row: noRow, owedAt: () => 0, checks: 5 }), { addMicro: 0, byDay: new Map(), rows: [], queued: 0, noBuilder: { n: 0, at: 0 } });
  // A flood of them is noted up to a bound.
  const many = Array.from({ length: 60 }, (_, i) => bare(1000 + i, `vs-${i}`, T + i));
  assert.equal(applyFills({ fills: many, row: noRow, owedAt: owes20, checks: 0 }).rows.length, MAX_NOTED);
  for (const id of ['vs-1', 'tp-1', 'sl-1']) assert.ok(APP_ORDER_ID.test(id));
  for (const id of ['vsx-1', 'webkey', 's1129', 'xvs-1', '']) assert.ok(!APP_ORDER_ID.test(id), id);
});

// --- deciding an order -------------------------------------------------------------------------

const APP_KEY = '0x' + 'aa'.repeat(20);
const OWN_KEY = '0x' + 'bb'.repeat(20);
const pendingRow = (o: Partial<OrderRow> = {}): OrderRow => ({
  key: 'BTC-USD:1', orderId: '1', symbol: 'BTC-USD', clOrdID: 'vs-abc', t: T, lastT: T, state: OrderState.pending, paidMicro: 12_400_000, rate: 20, countedMicro: 0, tries: 0, nextAt: 0, ...o,
});
const facts = (o: Partial<OrderFacts> = {}): OrderFacts => ({ createdAt: T, builder: { id: String(BUILDER), fee: 20 }, signer: APP_KEY, txHash: '0x' + '1'.repeat(64), ...o });
const ctx = (o: Partial<{ owed: number; since: number; keys: string[] }> = {}) => ({ builderId: BUILDER, owed: o.owed ?? 20, appKeys: new Set(o.keys ?? [APP_KEY]), since: o.since ?? 0 });

test('order: our builder at the fee owed - its paid fills count', () => {
  assert.deepEqual(judgeOrder(pendingRow(), facts(), ctx()), { state: OrderState.counted, addMicro: 12_400_000, rate: 20, underpaid: false, tampered: false });
  // More than owed counts too, and the order's own fee becomes the row's rate.
  assert.deepEqual(judgeOrder(pendingRow(), facts(), ctx({ owed: 15 })), { state: OrderState.counted, addMicro: 12_400_000, rate: 20, underpaid: false, tampered: false });
  // Signed by a key that is not our app's: the user's own program, naming our builder. It paid; it counts.
  assert.equal(judgeOrder(pendingRow(), facts({ signer: OWN_KEY }), ctx()).state, OrderState.counted);
  assert.equal(judgeOrder(pendingRow(), facts({ signer: null }), ctx()).state, OrderState.counted);
});

test('order: our builder below the fee owed is underpaid - not counted; sent by our app\'s key it is tampered too', () => {
  const low = facts({ builder: { id: String(BUILDER), fee: 15 } });
  assert.deepEqual(judgeOrder(pendingRow({ rate: 15 }), low, ctx()), { state: OrderState.underpaid, addMicro: 0, rate: 15, underpaid: true, tampered: true });
  assert.deepEqual(judgeOrder(pendingRow({ rate: 15 }), { ...low, signer: OWN_KEY }, ctx()), { state: OrderState.underpaid, addMicro: 0, rate: 15, underpaid: true, tampered: false });
  // One tenth of a basis point short is short.
  assert.equal(judgeOrder(pendingRow({ rate: 19 }), facts({ builder: { id: String(BUILDER), fee: 19 } }), ctx()).underpaid, true);
});

test('order: another builder\'s order never counts; it is the user\'s business unless our app\'s key sent it', () => {
  const other = facts({ builder: { id: '223169', fee: 100 }, signer: OWN_KEY });
  assert.deepEqual(judgeOrder(pendingRow({ rate: 100 }), other, ctx()), { state: OrderState.other, addMicro: 0, rate: 100, underpaid: false, tampered: false });
  assert.equal(judgeOrder(pendingRow({ rate: 100 }), { ...other, signer: APP_KEY }, ctx()).tampered, true);
  // The ids are compared as text: 123456 is not 1234560, and a number equals its string.
  assert.equal(judgeOrder(pendingRow(), facts({ builder: { id: '1234560', fee: 20 } }), ctx()).state, OrderState.other);
});

test('order: a builder-less order is tampered only with proof - our app\'s key, a fee owed, after the ledger began', () => {
  const check = pendingRow({ state: OrderState.check, paidMicro: 0, rate: 0 });
  const bare = facts({ builder: null });
  assert.deepEqual(judgeOrder(check, bare, ctx()), { state: OrderState.checked, addMicro: 0, rate: 0, underpaid: false, tampered: true });
  // Any other key: nothing is concluded. The user's other keys are theirs to use.
  assert.equal(judgeOrder(check, { ...bare, signer: OWN_KEY }, ctx()).tampered, false);
  assert.equal(judgeOrder(check, { ...bare, signer: null }, ctx()).tampered, false);
  assert.equal(judgeOrder(check, bare, ctx({ keys: [] })).tampered, false, 'no key of ours on record for this wallet');
  // Nothing was owed on that engine: the app attaches no builder there.
  assert.equal(judgeOrder(check, bare, ctx({ owed: 0 })).tampered, false);
  // An order from before the ledger existed.
  assert.equal(judgeOrder(check, bare, ctx({ since: T + 1 })).tampered, false);
  assert.equal(judgeOrder(check, bare, ctx({ since: T })).tampered, true);
  // The order does carry our builder at the fee owed after all: nothing wrong.
  assert.equal(judgeOrder(check, facts(), ctx()).tampered, false);
});

test('order: fills that paid less than the fee the order names were misread - nothing is counted', () => {
  assert.deepEqual(judgeOrder(pendingRow({ rate: 10 }), facts(), ctx({ owed: 15 })), { state: OrderState.unknown, addMicro: 0, rate: 10, underpaid: false, tampered: false });
  // One unit of rounding is allowed.
  assert.equal(judgeOrder(pendingRow({ rate: 19 }), facts(), ctx({ owed: 15 })).state, OrderState.counted);
});

test('the pure rules run twice change nothing: a decided order adds nothing again', () => {
  const first = applyFills({ fills: [mk(1), mk(1)], row: noRow, owedAt: owes20, checks: 0 });
  const row = first.rows[0]!;
  const verdict = judgeOrder(row, facts(), ctx());
  const counted: OrderRow = { ...row, state: verdict.state, rate: verdict.rate, countedMicro: verdict.addMicro };
  assert.equal(verdict.addMicro, 100_000_000);
  // The same fills are not handed in again (the ledger knows them); an empty batch is a no-op.
  assert.deepEqual(applyFills({ fills: [], row: () => counted, owedAt: owes20, checks: 0 }), { addMicro: 0, byDay: new Map(), rows: [], queued: 0, noBuilder: { n: 0, at: 0 } });
  assert.equal(addMicro(Number.MAX_SAFE_INTEGER, 5), Number.MAX_SAFE_INTEGER, 'sums never leave the exact range');
});

test('fills: a counted order filling over midnight adds each fill to its own UTC day', () => {
  const midnight = Math.ceil(T / 86_400_000) * 86_400_000;
  const held: OrderRow = { key: 'BTC-USD:1', orderId: '1', symbol: 'BTC-USD', clOrdID: 'vs-abc', t: midnight - 1000, lastT: midnight - 1000, state: OrderState.counted, paidMicro: 50_000_000, rate: 20, countedMicro: 50_000_000, tries: 1, nextAt: 0 };
  const r = applyFills({ fills: [mk(1, { time: midnight - 10 }), mk(1, { time: midnight + 10 })], row: () => held, owedAt: owes20, checks: 0 });
  assert.equal(r.addMicro, 100_000_000);
  assert.deepEqual([...r.byDay].sort((a, b) => a[0] - b[0]), [[dayOf(midnight - 10), 50_000_000], [dayOf(midnight + 10), 50_000_000]]);
});
