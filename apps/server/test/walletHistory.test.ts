import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normaliseFunding, normaliseTrade, type NormalRow } from '../src/historyRows.js';
import { scopeKey, type ScopeKind } from '../src/historySync.js';
import { WalletBackfill, WalletHistoryDb, backfillOrder, type BackfillAccount } from '../src/indexer/walletHistory.js';

const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const C = '0x00000000000000000000000000000000000000cc';

const fill = (i: number, time: number): NormalRow => normaliseTrade({ symbol: 'BTC-USD', tradeID: i, orderID: i, side: 'BUY', price: '100', quantity: '1', fee: '0.1', feeCoin: 'vUSDC', time, isMaker: true });
const pay = (time: number): NormalRow => normaliseFunding({ symbol: 'BTC-USD', positionID: 1, positionSide: 'LONG', fundingFee: '-0.5', feeCoin: 'vUSDC', timestamp: time });

function dbInTemp(): { db: WalletHistoryDb; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wh-'));
  const db = new WalletHistoryDb(join(dir, 'h.db'));
  return { db, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A venue answering newest first with an inclusive endTime, counting its reads. Time and sleep are virtual. */
function harness(db: WalletHistoryDb, rows: (kind: ScopeKind, address: string) => NormalRow[], accounts: BackfillAccount[], o: { gate?: () => number; fail?: () => Error | null } = {}) {
  let clock = 1_000_000;
  const reads: Array<{ kind: ScopeKind; address: string; at: number }> = [];
  const backfill = new WalletBackfill({
    db,
    tradesPerMin: 2,
    accounts: () => accounts,
    gate: o.gate ?? (() => 0),
    isRateLimited: (e) => /429/.test(String(e)),
    log: () => {},
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    pageSource: (kind, address) => async (q) => {
      reads.push({ kind, address, at: clock });
      const failure = o.fail?.();
      if (failure) throw failure;
      return rows(kind, address)
        .filter((r) => (q.endTime === undefined || r.time <= q.endTime) && (q.startTime === undefined || r.time >= q.startTime))
        .sort((x, y) => y.time - x.time)
        .slice(0, q.limit);
    },
  });
  return { backfill, reads, advance: (ms: number) => { clock += ms; } };
}

test('the most recently active go first, then those with no activity; market makers not at all', () => {
  const order = backfillOrder([
    { address: A, trades: 5, lastDay: 100 },
    { address: B, trades: 50, lastDay: 200 },
    { address: C, trades: 0, lastDay: null },
    { address: '0xMM', trades: 20_000, lastDay: 300 },
  ], 10_000);
  assert.deepEqual(order, [B, A, C]);
});

test('a small wallet costs one read per scope, and its rows round-trip exactly', async () => {
  const { db, done } = dbInTemp();
  try {
    const rows = [fill(1, 1000), fill(2, 2000)];
    const { backfill, reads } = harness(db, (k) => (k === 'funding' ? [pay(1500)] : k === 'trades-perps' ? rows : []), []);
    await backfill.walk(A);
    assert.equal(reads.length, 3, 'perps, spot, funding: no second page to confirm the end');
    assert.ok(db.isDone(A));
    const held = db.loadRows(scopeKey('trades-perps', A));
    assert.deepEqual(held.map((r) => r.id).sort(), rows.map((r) => r.id).sort(), 'the same ids as the browser computes');
    assert.equal(held[0]!.time, 2000);
    assert.equal(held[0]!.price, '100');
    assert.equal(held[0]!.fee, '0.1');
    assert.equal(held[0]!.isMaker, true);
    assert.equal(db.readState(scopeKey('funding', A)).complete, true);
  } finally { done(); }
});

test('a long history still pages to the end, keeping fills of one millisecond across a page', async () => {
  const { db, done } = dbInTemp();
  try {
    const rows: NormalRow[] = [];
    for (let i = 0; i < 1000; i++) rows.push(fill(i, 100_000 + i));
    for (let i = 0; i < 5; i++) rows.push(fill(5000 + i, 100_000));
    for (let i = 0; i < 300; i++) rows.push(fill(6000 + i, 50_000 + i));
    const { backfill } = harness(db, (k) => (k === 'trades-perps' ? rows : []), []);
    await backfill.walk(A);
    assert.equal(db.cachedCount(scopeKey('trades-perps', A)), 1305);
    assert.equal(db.readState(scopeKey('trades-perps', A)).complete, true);
  } finally { done(); }
});

test('reads of /trades keep the rate, and funding does not wait for them', async () => {
  const { db, done } = dbInTemp();
  try {
    const { backfill, reads } = harness(db, () => [], []);
    await backfill.walk(A);
    await backfill.walk(B);
    const trades = reads.filter((r) => r.kind !== 'funding').map((r) => r.at);
    for (let i = 1; i < trades.length; i++) assert.ok(trades[i]! - trades[i - 1]! >= 30_000, `gap ${trades[i]! - trades[i - 1]!}`);
  } finally { done(); }
});

test('a wallet someone asks for goes before the list, and a finished one is not read again', async () => {
  const { db, done } = dbInTemp();
  try {
    const { backfill } = harness(db, () => [], [{ address: A, trades: 1, lastDay: 1 }, { address: B, trades: 1, lastDay: 2 }]);
    db.demand(C);
    assert.equal(backfill.next(), C);
    assert.equal(backfill.next(), B);
    await backfill.walk(A);
    assert.equal(backfill.next(), null, 'A is done and B was handed out');
  } finally { done(); }
});

test('after a rate limit nothing is read for 30 minutes, and the wallet stays unfinished', async () => {
  const { db, done } = dbInTemp();
  try {
    let refuse = true;
    const { backfill, reads, advance } = harness(db, () => [], [], { fail: () => (refuse ? new Error('429') : null) });
    await backfill.walk(A);
    assert.equal(db.isDone(A), false);
    assert.match(db.readState(scopeKey('trades-spot', A)).lastError ?? '', /429/);
    refuse = false;
    const before = reads.length;
    advance(60_000);
    await backfill.walk(A);
    assert.ok(reads.length > before);
    assert.ok(reads[before]!.at - reads[before - 1]!.at >= 30 * 60_000, 'waited out the pause');
    assert.ok(db.isDone(A));
  } finally { done(); }
});
