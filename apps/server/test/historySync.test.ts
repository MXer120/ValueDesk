/**
 * The all-time history engine and totals, now shared by the server's Stats
 * route and the browser (historySync.ts, historyStats.ts, statsCore.ts): a walk
 * is resumable page by page, only the backward walk may claim completeness, a
 * catch-up only reads what is new, and fees stay per coin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseTrade, normaliseFunding, type NormalRow, type PageQuery } from '../src/historyRows.js';
import { MemoryHistoryStore, createHistorySync, scopeKey, type PageFetcher } from '../src/historySync.js';
import { aggregateFunding, aggregateTradeRows, quoteCoinMap } from '../src/historyStats.js';
import { allTimeStatsBody, headlineReader } from '../src/statsCore.js';

const ME = '0x48d98beb9dfce0a24f284e7653f05609b058ad96';

/** `n` fills, one per second going back from `top`, newest first. */
function fills(n: number, top = 1_790_000_000_000): NormalRow[] {
  const out: NormalRow[] = [];
  for (let i = 0; i < n; i++) {
    out.push(normaliseTrade({
      symbol: i % 2 ? 'BTC-USD' : 'ETH-USD', tradeID: i, side: 'BUY', price: '2', quantity: '1.5',
      fee: '0.01', feeCoin: 'vUSDC', time: top - i * 1000, isMaker: i % 3 === 0,
    }));
  }
  return out;
}

/** A newest-first history endpoint over `rows` that honours startTime/endTime (both inclusive) and limit. */
function endpoint(rows: () => NormalRow[], opts: { failAt?: number } = {}) {
  const calls: PageQuery[] = [];
  const fetch: PageFetcher = async (q) => {
    calls.push(q);
    if (opts.failAt !== undefined && calls.length === opts.failAt) throw new Error('upstream error envelope');
    return rows()
      .filter((r) => (q.endTime === undefined || r.time <= q.endTime) && (q.startTime === undefined || r.time >= q.startTime))
      .slice(0, q.limit);
  };
  return { fetch, calls };
}

function engine(fetch: PageFetcher, o: { now?: () => number; exclusive?: (s: string, run: () => Promise<void>) => Promise<void>; beforeSync?: (s: string) => Promise<void> } = {}) {
  const store = new MemoryHistoryStore();
  const sync = createHistorySync({
    store,
    pageSource: () => fetch,
    paced: (f) => f,
    resyncAfterMs: 5 * 60_000,
    ...o,
  });
  return { store, sync };
}

test('history sync: a full walk pages back to the start, dedupes the inclusive boundary and claims completeness', async () => {
  const all = fills(2500);
  const { fetch, calls } = endpoint(() => all);
  const { sync } = engine(fetch);
  sync.ensureSync('trades-perps', ME);
  assert.equal(sync.progressOf('trades-perps', ME).status, 'running', 'running as soon as it is asked for');
  assert.equal(sync.isSyncing(ME), true);
  await sync.settled('trades-perps', ME);
  const p = sync.progressOf('trades-perps', ME);
  assert.equal(p.status, 'done');
  assert.equal(p.complete, true);
  assert.equal(p.cached, 2500, 'every fill once, boundary rows deduped');
  assert.equal(sync.rowsFor('trades-perps', ME).length, 2500);
  assert.equal(sync.rowsFor('trades-perps', ME)[0]!.time, all[0]!.time, 'newest first');
  assert.equal(calls[1]!.endTime, all[999]!.time, 'endTime is inclusive: the next page starts AT the oldest time read');
  assert.equal(sync.isSyncing(ME), false);
});

test('history sync: a failed page keeps what was read, stays incomplete, and the next run resumes from there', async () => {
  const all = fills(2500);
  const first = endpoint(() => all, { failAt: 2 });
  const { store, sync } = engine(first.fetch);
  sync.ensureSync('trades-spot', ME);
  await sync.settled('trades-spot', ME);
  let p = sync.progressOf('trades-spot', ME);
  assert.equal(p.status, 'error');
  assert.equal(p.complete, false, 'a failure is never the end of history');
  assert.equal(p.cached, 1000, 'page one is kept');
  assert.match(p.error ?? '', /error envelope/);

  // Same store, a working endpoint: the walk resumes at the checkpointed oldest row.
  const second = endpoint(() => all);
  const again = createHistorySync({ store, pageSource: () => second.fetch, paced: (f) => f, resyncAfterMs: 5 * 60_000 });
  again.ensureSync('trades-spot', ME);
  await again.settled('trades-spot', ME);
  p = again.progressOf('trades-spot', ME);
  assert.equal(p.complete, true);
  assert.equal(p.cached, 2500);
  assert.ok(second.calls.some((q) => q.endTime === all[999]!.time), 'resumed from the checkpoint, not from the top');
});

test('history sync: a fresh complete scope is left alone; later, a catch-up reads only what is new', async () => {
  let rows = fills(300);
  let t = 1_000_000;
  const { fetch, calls } = endpoint(() => rows);
  const { sync } = engine(fetch, { now: () => t });
  sync.ensureSync('funding', ME);
  await sync.settled('funding', ME);
  const walked = calls.length;
  sync.ensureSync('funding', ME);
  assert.equal(sync.isSyncing(ME), false, 'complete and fresh: nothing to do');
  assert.equal(calls.length, walked);

  // Five minutes on, three new rows arrived at the top.
  t += 5 * 60_000 + 1;
  rows = [...fills(3, rows[0]!.time + 3000), ...rows];
  sync.ensureSync('funding', ME);
  await sync.settled('funding', ME);
  const catchUp = calls.slice(walked);
  assert.ok(catchUp.every((q) => q.startTime === 1_790_000_000_000), 'the catch-up asks only for rows at or after the newest held');
  assert.equal(sync.progressOf('funding', ME).cached, 303);
  assert.equal(sync.progressOf('funding', ME).newest, rows[0]!.time);
});

test('history sync: rebuild drops the scope and walks it again', async () => {
  const all = fills(10);
  const { fetch } = endpoint(() => all);
  const { store, sync } = engine(fetch);
  store.saveRows(scopeKey('trades-perps', ME), fills(1, 1));
  sync.ensureSync('trades-perps', ME, true);
  await sync.settled('trades-perps', ME);
  assert.equal(sync.progressOf('trades-perps', ME).cached, 10, 'the stray row is gone');
});

test('history sync: while another holder has the scope it reads as running, and a scope made fresh meanwhile is not walked again', async () => {
  const all = fills(5);
  const { fetch, calls } = endpoint(() => all);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const store = new MemoryHistoryStore();
  let refreshed = 0;
  const sync = createHistorySync({
    store,
    pageSource: () => fetch,
    paced: (f) => f,
    resyncAfterMs: 5 * 60_000,
    exclusive: async (_scope, run) => {
      await gate;
      await run();
    },
    beforeSync: async (scope) => {
      refreshed++;
      // What the other tab stored while this one waited.
      store.load(scope, { oldest: all[4]!.time, newest: all[0]!.time, complete: true, pages: 2, updatedAt: Date.now(), lastError: null }, all);
    },
  });
  sync.ensureSync('trades-perps', ME);
  assert.equal(sync.progressOf('trades-perps', ME).status, 'running', 'waiting for the other holder counts as running');
  release();
  await sync.settled('trades-perps', ME);
  assert.equal(refreshed, 1);
  assert.equal(calls.length, 0, 'the other holder already brought it up to date');
  assert.equal(sync.progressOf('trades-perps', ME).status, 'done');
  assert.equal(sync.progressOf('trades-perps', ME).cached, 5);
});

test('memory store: only new ids count as a change', () => {
  const changes: string[] = [];
  const store = new MemoryHistoryStore((c) => changes.push(c.type));
  const s = scopeKey('trades-spot', ME);
  const rows = fills(3);
  store.saveRows(s, rows);
  const v = store.versionOf(s);
  store.saveRows(s, rows.slice(0, 2));
  assert.equal(store.versionOf(s), v, 'the same rows again change nothing');
  assert.equal(store.cachedCount(s), 3);
  store.dropScope(s);
  assert.ok(store.versionOf(s) > v);
  assert.equal(store.cachedCount(s), 0);
  assert.deepEqual(changes, ['rows', 'drop']);
});

test('history totals: fees per coin, volume per quote coin (exact), funding with the venue sign', () => {
  const rows = [
    normaliseTrade({ symbol: 'vBTC_vUSDC', side: 'BUY', price: '0.1', quantity: '0.2', fee: '0.00001', feeCoin: 'vBTC', time: 3, isMaker: true }),
    normaliseTrade({ symbol: 'vBTC_vUSDC', side: 'SELL', price: '0.1', quantity: '0.2', fee: '0.02', feeCoin: 'vUSDC', time: 2, isMaker: false }),
    normaliseTrade({ symbol: 'NEW_X', side: 'SELL', price: '3', quantity: '1', fee: '0.5', time: 1 }),
  ];
  const t = aggregateTradeRows(quoteCoinMap([{ name: 'vBTC_vUSDC', quoteCoin: 'vUSDC' }]), rows);
  assert.deepEqual(t.fees.map((f) => [f.coin, f.amount]).sort(), [[null, '0.5'], ['vBTC', '0.00001'], ['vUSDC', '0.02']]);
  assert.deepEqual(t.volume.find((v) => v.coin === 'vUSDC'), { coin: 'vUSDC', amount: '0.04', count: 2 }, '0.1 x 0.2, twice, exactly');
  assert.equal(t.volume.find((v) => v.coin === null)?.amount, '3', 'an unknown symbol is unlabelled, not folded in');
  assert.deepEqual(t.volumeSource, { reported: 0, derived: 3, unavailable: 0 });
  assert.deepEqual(t.liquidity, { maker: 1, taker: 1, unknown: 1 });
  assert.equal(t.feeCoinUnlabelled, 1);
  assert.equal(t.firstTime, 1);
  assert.equal(t.lastTime, 3);

  const f = aggregateFunding([
    normaliseFunding({ symbol: 'BTC-USD', positionSide: 'LONG', fundingFee: '-0.25', feeCoin: 'vUSDC', timestamp: 5 }),
    normaliseFunding({ symbol: 'BTC-USD', positionSide: 'LONG', fundingFee: '0.05', feeCoin: 'vUSDC', timestamp: 6 }),
  ]);
  assert.deepEqual(f.totals, [{ coin: 'vUSDC', amount: '-0.2', count: 2 }]);
});

test('stats headline: no account is an answer, failures land in the reason, the curve is optional, answers are memoised', async () => {
  let t = 0;
  const calls: string[] = [];
  const read = headlineReader({
    now: () => t,
    accountId: async (a) => (a === ME ? 42 : 0),
    dataGet: async <T>(path: string): Promise<T> => {
      calls.push(path);
      if (path.includes('daily_stats')) throw new Error('curve unavailable');
      return { ts_ms: 1_790_000_000_000, cumulative_pnl: '12.5', unrealized_pnl: 1, cumulative_quote_volume: '900', first_trade_ts_ms: 0 } as T;
    },
  });
  const none = await read('0x' + '1'.repeat(40));
  assert.equal(none.available, false);
  assert.match(none.reason ?? '', /no SoDEX account/);

  const h = await read(ME);
  assert.equal(h.available, true);
  assert.equal(h.accountId, 42);
  assert.equal(h.cumulativePnl, '12.5');
  assert.equal(h.unrealizedPnl, '1');
  assert.equal(h.firstTradeAt, null);
  assert.deepEqual(h.curve, [], 'losing the curve does not lose the headline');
  assert.deepEqual(calls, ['/api/v1/perps/pnl/overview?account_id=42', '/api/v1/perps/pnl/daily_stats?account_id=42']);
  await read(ME.toUpperCase().replace('0X', '0x'));
  assert.equal(calls.length, 2, 'memoised per wallet for a minute');
  t += 60_001;
  await read(ME);
  assert.equal(calls.length, 4);

  const failing = headlineReader({ accountId: async () => { throw new Error('gateway down'); }, dataGet: async () => ({}) as never });
  assert.equal((await failing(ME)).reason, 'gateway down');
});

test('stats body: the route shape, each part labelled at the source', () => {
  const empty = aggregateTradeRows(new Map(), []);
  const scopes = { 'trades-spot': { status: 'done' }, 'trades-perps': { status: 'running' }, funding: { status: 'done' } } as never;
  const body = allTimeStatsBody({
    address: ME, spot: empty, perps: empty, funding: aggregateFunding([]),
    headline: { available: false, reason: 'x', accountId: null, asOf: null, cumulativePnl: null, unrealizedPnl: null, cumulativeQuoteVolume: null, firstTradeAt: null, curve: [] },
    scopes, cache: { path: 'p', ok: true, error: null },
  });
  assert.equal(body.sync.running, true);
  assert.match(body.trades.spot.provenance, /spot fill history/);
  assert.match(body.headline.provenance, /PERPS ONLY/);
  assert.equal(body.spotRealizedPnl.value, null);
  assert.match(body.spotRealizedPnl.reason, /404/);
});
