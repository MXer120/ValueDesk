import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normaliseFunding, normaliseTrade, type NormalRow, type PageQuery } from '@sign/historyRows.js';
import { EMPTY_STATE, MemoryHistoryStore, createHistorySync, scopeKey, type PageFetcher } from '@sign/historySync.js';
import { coverOf, fundingFigures, tradeFigures } from './activityWindows';

const fill = (o: Record<string, unknown>): NormalRow => normaliseTrade({ symbol: 'BTC-USD', tradeID: 1, orderID: 1, side: 'BUY', price: '100', quantity: '2', fee: '0.1', feeCoin: 'vUSDC', time: 1000, isMaker: true, ...o });
const pay = (o: Record<string, unknown>): NormalRow => normaliseFunding({ symbol: 'BTC-USD', positionID: 1, positionSide: 'LONG', fundingFee: '-0.5', feeCoin: 'vUSDC', timestamp: 1000, ...o });

test('trade figures match a hand sum, split by side', () => {
  const f = tradeFigures([
    fill({ tradeID: 1, side: 'BUY', price: '100', quantity: '2', fee: '0.1', time: 1000 }),
    fill({ tradeID: 2, side: 'SELL', price: '110.5', quantity: '1', fee: '0.2', time: 2000 }),
    fill({ tradeID: 3, side: 'SELL', price: '1', quantity: '0.1', fee: '0.01', time: 3000 }),
  ], null, 3000);
  assert.equal(f.trades, 3);
  assert.equal(f.buys, 1);
  assert.equal(f.sells, 2);
  assert.equal(f.buyVolume, 200);
  assert.equal(f.sellVolume, 110.6);
  assert.equal(f.volume, 310.6);
  assert.equal(f.commission, 0.31);
  assert.equal(f.latestCommission, 0.01);
  assert.equal(f.unreadable, 0);
});

test('money adds up exactly, not through floats', () => {
  const rows = Array.from({ length: 10 }, (_, i) => fill({ tradeID: i, price: '0.1', quantity: '1', fee: '0.1', time: 1000 + i }));
  const f = tradeFigures(rows, null, 2000);
  assert.equal(f.volume, 1);
  assert.equal(f.commission, 1);
});

test('the window holds its start and leaves out what is older or above the covered top', () => {
  const rows = [fill({ tradeID: 1, time: 999 }), fill({ tradeID: 2, time: 1000 }), fill({ tradeID: 3, time: 2000 }), fill({ tradeID: 4, time: 2001 })];
  assert.equal(tradeFigures(rows, 1000, 2000).trades, 2);
  assert.equal(tradeFigures(rows, null, 2000).trades, 3);
  assert.equal(tradeFigures(rows, null, null).trades, 0, 'nothing is covered yet');
});

test('a spot fee in the coin bought is valued at that fill\'s price; any other coin stays out of the dollars', () => {
  const f = tradeFigures([
    fill({ symbol: 'vAVAX_vUSDC', side: 'BUY', price: '20', quantity: '1', fee: '0.05', feeCoin: 'vAVAX', time: 1000 }),
    fill({ symbol: 'vAVAX_vUSDC', side: 'SELL', price: '20', quantity: '1', fee: '0.4', feeCoin: 'vUSDC', time: 1001 }),
    fill({ symbol: 'vAVAX_vUSDC', side: 'SELL', price: '20', quantity: '1', fee: '3', feeCoin: 'WSOSO', time: 1002 }),
  ], null, 2000);
  assert.equal(f.commission, 1.4);
  assert.equal(f.latestCommission, 0.4);
  assert.deepEqual(f.otherFees, [{ coin: 'WSOSO', amount: 3 }]);
});

test('a rebate lowers the commission', () => {
  const f = tradeFigures([fill({ tradeID: 1, fee: '1', time: 1000 }), fill({ tradeID: 2, fee: '-0.25', time: 1001 })], null, 2000);
  assert.equal(f.commission, 0.75);
});

test('a row without a side, price or fee is counted as unreadable, never as zero', () => {
  const f = tradeFigures([fill({ side: 'BUY', fee: undefined, tradeID: 1 }), fill({ side: undefined, tradeID: 2 }), fill({ price: 'x', tradeID: 3 })], null, 2000);
  assert.equal(f.unreadable, 3);
});

test('funding keeps SoDEX\'s sign and splits received from paid', () => {
  const f = fundingFigures([
    pay({ fundingFee: '-0.5', timestamp: 1000 }),
    pay({ fundingFee: '0.2', timestamp: 2000 }),
    pay({ fundingFee: '-0.1', timestamp: 3000 }),
    pay({ fundingFee: '-9', timestamp: 500 }),
  ], 1000, 3000);
  assert.equal(f.payments, 3);
  assert.equal(f.total, -0.4);
  assert.equal(f.received, 0.2);
  assert.equal(f.paid, -0.6);
  assert.equal(f.latest, -0.1);
});

test('a window is final only once the walk went strictly past its start', () => {
  const s = { ...EMPTY_STATE, oldest: 1000, newest: 5000, updatedAt: 6000, pages: 1, syncedAt: 6000 };
  assert.equal(coverOf(s, true, 1000, 10).state, 'reading', 'more rows of the same millisecond may follow');
  assert.equal(coverOf(s, true, 1001, 10).state, 'final');
  assert.equal(coverOf(s, true, null, 10).state, 'reading', 'all time needs the whole history');
  assert.equal(coverOf({ ...s, complete: true }, false, null, 10).state, 'final');
  assert.equal(coverOf(EMPTY_STATE, false, 1001, 0).state, 'reading');
  assert.deepEqual(coverOf({ ...s, lastError: 'refused' }, false, null, 10), { state: 'incomplete', reason: 'refused' });
  assert.equal(coverOf({ ...s, lastError: 'refused' }, false, 2000, 10).state, 'final', 'older pages failing does not touch a covered window');
});

// --- the walk itself, against a venue that pages as SoDEX does ------------------------------

const venue = (all: () => NormalRow[], calls: PageQuery[] = []): PageFetcher => async (q) => {
  calls.push(q);
  return all()
    .filter((r) => (q.endTime === undefined || r.time <= q.endTime) && (q.startTime === undefined || r.time >= q.startTime))
    .sort((a, b) => b.time - a.time)
    .slice(0, q.limit);
};

const syncOver = (source: PageFetcher) => {
  const store = new MemoryHistoryStore();
  let clock = 1_000_000;
  const sync = createHistorySync({ store, pageSource: () => source, paced: (f) => f, resyncAfterMs: 0, now: () => clock++ });
  return { store, sync };
};
const ADDRESS = '0x00000000000000000000000000000000000000aa';
const SCOPE = scopeKey('trades-perps', ADDRESS);

test('paging keeps distinct fills of one millisecond across a page boundary, and adds each once', async () => {
  // Five more fills share the millisecond the first full page of 1000 ends on, so they fall onto the next page.
  const rows: NormalRow[] = [];
  for (let i = 0; i < 1000; i++) rows.push(fill({ tradeID: i, orderID: i, time: 100_000 + i, price: '1', quantity: '1', fee: '0.01' }));
  for (let i = 0; i < 5; i++) rows.push(fill({ tradeID: 5000 + i, orderID: 5000 + i, time: 100_000, price: '1', quantity: '1', fee: '0.01' }));
  for (let i = 0; i < 700; i++) rows.push(fill({ tradeID: 6000 + i, orderID: 6000 + i, time: 50_000 + i, price: '1', quantity: '1', fee: '0.01' }));
  const { store, sync } = syncOver(venue(() => rows));
  sync.ensureSync('trades-perps', ADDRESS);
  await sync.settled('trades-perps', ADDRESS);
  const state = store.readState(SCOPE);
  assert.equal(state.complete, true);
  assert.equal(store.cachedCount(SCOPE), 1705);
  const f = tradeFigures(store.loadRows(SCOPE), null, state.newest);
  assert.equal(f.trades, 1705);
  assert.equal(f.volume, 1705);
  assert.equal(f.commission, 17.05);
});

test('a catch-up that fails halfway leaves a hole, and no row above the hole is counted until it is filled', async () => {
  // Past one full page, so the catch-up has to step down through the gap.
  let rows = [fill({ tradeID: 1, time: 1000 })];
  const burst = Array.from({ length: 1500 }, (_, i) => fill({ tradeID: 10 + i, time: 2000 + i }));
  let refuse = false;
  const inner = venue(() => rows);
  const source: PageFetcher = async (q) => {
    if (refuse && q.endTime !== undefined) throw new Error('refused');
    return inner(q);
  };
  const { store, sync } = syncOver(source);
  sync.ensureSync('trades-perps', ADDRESS);
  await sync.settled('trades-perps', ADDRESS);
  assert.equal(store.readState(SCOPE).newest, 1000);

  rows = [...rows, ...burst];
  refuse = true;
  sync.ensureSync('trades-perps', ADDRESS);
  await sync.settled('trades-perps', ADDRESS);
  let state = store.readState(SCOPE);
  assert.equal(state.lastError, 'refused');
  assert.equal(state.newest, 1000, 'the hole is not recorded as covered');
  assert.equal(tradeFigures(store.loadRows(SCOPE), null, state.newest).trades, 1, 'exact as of the last good catch-up');

  refuse = false;
  sync.ensureSync('trades-perps', ADDRESS);
  await sync.settled('trades-perps', ADDRESS);
  state = store.readState(SCOPE);
  assert.equal(state.newest, 3499);
  assert.equal(tradeFigures(store.loadRows(SCOPE), null, state.newest).trades, 1501);
  assert.equal(coverOf(state, false, null, 1501).state, 'final');
});

test('rows too old to answer a rolling window are read first, not shown', () => {
  const s = { ...EMPTY_STATE, oldest: 1000, newest: 5000, updatedAt: 6000, pages: 1, complete: true, syncedAt: 6000 };
  assert.equal(coverOf(s, false, null, 10, 6000 + 59 * 60_000).state, 'final');
  assert.equal(coverOf(s, true, null, 10, 6000 + 61 * 60_000).state, 'reading');
});

test('a walk that ends at SoDEX\'s row limit is not all of history, though what it reached still counts', async () => {
  // The venue keeps the newest 10,000 and answers empty below them; there are 15,000.
  const rows = Array.from({ length: 15_000 }, (_, i) => fill({ tradeID: i, time: 100_000 + i }));
  const kept = () => [...rows].sort((a, b) => b.time - a.time).slice(0, 10_000);
  const { store, sync } = syncOver(venue(kept));
  sync.ensureSync('trades-perps', ADDRESS);
  await sync.settled('trades-perps', ADDRESS);
  const state = store.readState(SCOPE);
  assert.equal(state.complete, true);
  assert.equal(state.limited, true);
  assert.equal(coverOf(state, false, null, 10_000).state, 'incomplete');
  assert.equal(coverOf(state, false, 100, 10_000).state, 'incomplete', 'a window older than the limit');
  assert.equal(coverOf(state, false, 110_000, 10_000).state, 'final', 'a window inside what was reached');
});

test('a wallet below the limit stays complete, also once it trades past the limit later', async () => {
  let rows = Array.from({ length: 1_500 }, (_, i) => fill({ tradeID: i, time: 100_000 + i }));
  const { store, sync } = syncOver(venue(() => rows));
  sync.ensureSync('trades-perps', ADDRESS);
  await sync.settled('trades-perps', ADDRESS);
  assert.ok(!store.readState(SCOPE).limited);
  rows = [...rows, ...Array.from({ length: 9_000 }, (_, i) => fill({ tradeID: 20_000 + i, time: 200_000 + i }))];
  sync.ensureSync('trades-perps', ADDRESS);
  await sync.settled('trades-perps', ADDRESS);
  const state = store.readState(SCOPE);
  assert.equal(store.cachedCount(SCOPE), 10_500);
  assert.ok(!state.limited);
  assert.equal(coverOf(state, false, null, 10_500).state, 'final');
});

test('more new rows between visits than SoDEX keeps leaves a gap, and nothing is claimed across it', async () => {
  let rows = Array.from({ length: 50 }, (_, i) => fill({ tradeID: i, time: 1_000 + i }));
  const kept = () => [...rows].sort((a, b) => b.time - a.time).slice(0, 10_000);
  const { store, sync } = syncOver(venue(kept));
  sync.ensureSync('trades-perps', ADDRESS);
  await sync.settled('trades-perps', ADDRESS);
  rows = [...rows, ...Array.from({ length: 12_000 }, (_, i) => fill({ tradeID: 100 + i, time: 50_000 + i }))];
  sync.ensureSync('trades-perps', ADDRESS);
  await sync.settled('trades-perps', ADDRESS);
  const state = store.readState(SCOPE);
  assert.equal(state.limited, true);
  assert.equal(state.coveredFrom, 52_000);
  assert.equal(state.newest, 61_999);
  assert.equal(coverOf(state, false, null, 10_050).state, 'incomplete');
  assert.equal(coverOf(state, false, 1_500, 10_050).state, 'incomplete', 'the window reaches across the gap');
  assert.equal(coverOf(state, false, 55_000, 10_050).state, 'final');
});

test('a short page answers at once, and the next sync reads below it, so a row it missed still counts', async () => {
  // A venue that cut the first answer short, and has older rows.
  const rows = [fill({ tradeID: 1, time: 5000 }), fill({ tradeID: 2, time: 4000 }), fill({ tradeID: 3, time: 3000 })];
  const inner = venue(() => rows);
  let cut = true;
  const source: PageFetcher = async (q) => {
    const page = await inner(q);
    if (cut) { cut = false; return page.slice(0, 2); }
    return page;
  };
  const store = new MemoryHistoryStore();
  let clock = 1_000_000;
  const sync = createHistorySync({ store, pageSource: () => source, paced: (f) => f, resyncAfterMs: 0, now: () => clock++, shortPageEnds: true });
  sync.ensureSync('trades-perps', ADDRESS);
  await sync.settled('trades-perps', ADDRESS);
  let state = store.readState(SCOPE);
  assert.equal(state.complete, true);
  assert.equal(state.unconfirmed, true);
  assert.equal(store.cachedCount(SCOPE), 2);
  sync.ensureSync('trades-perps', ADDRESS);
  await sync.settled('trades-perps', ADDRESS);
  state = store.readState(SCOPE);
  assert.equal(store.cachedCount(SCOPE), 3, 'the confirming read found it');
  assert.equal(state.complete, true);
  assert.ok(!state.unconfirmed);
  assert.equal(tradeFigures(store.loadRows(SCOPE), null, state.newest).trades, 3);
});

test('funding never ends on a short page: SoDEX answered 993 of 1,000 with older rows still below', async () => {
  const rows = [pay({ timestamp: 5000 }), pay({ timestamp: 4000 }), pay({ timestamp: 3000 })];
  const inner = venue(() => rows);
  let cut = true;
  const source: PageFetcher = async (q) => {
    const page = await inner(q);
    if (cut) { cut = false; return page.slice(0, 2); }
    return page;
  };
  const store = new MemoryHistoryStore();
  let clock = 1_000_000;
  const sync = createHistorySync({ store, pageSource: () => source, paced: (f) => f, resyncAfterMs: 0, now: () => clock++, shortPageEnds: true });
  sync.ensureSync('funding', ADDRESS);
  await sync.settled('funding', ADDRESS);
  const scope = scopeKey('funding', ADDRESS);
  assert.equal(store.cachedCount(scope), 3, 'read on until a page added nothing');
  assert.ok(!store.readState(scope).unconfirmed);
});

test('a walk that cannot pass a full page of one millisecond is incomplete, not final', async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => fill({ tradeID: i, time: 1000 }));
  const { store, sync } = syncOver(venue(() => rows));
  sync.ensureSync('trades-perps', ADDRESS);
  await sync.settled('trades-perps', ADDRESS);
  const state = store.readState(SCOPE);
  assert.equal(state.complete, false);
  assert.equal(coverOf(state, false, null, store.cachedCount(SCOPE)).state, 'incomplete');
});
