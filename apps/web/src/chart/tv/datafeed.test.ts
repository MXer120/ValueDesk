/**
 * The datafeed against fake data paths: history paging, realtime guards,
 * symbol resolution, search, teardown - and the failsafes it shares with the
 * klinecharts chart (first-page retries, cancelled loads, gap-fills, health).
 *   npx tsx --test src/chart/tv/datafeed.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Engine, Symbol as MarketSymbol } from '../../api';
import { createDatafeed, type DatafeedDeps, type KlineQuery } from './datafeed';
import type { Bar, HistoryMetadata, LibrarySymbolInfo, PeriodParams } from './types';

const sym = (name: string, over: Partial<MarketSymbol> = {}): MarketSymbol =>
  ({
    id: 1, name, displayName: name, baseCoin: name.split(/[-_]/)[0], quoteCoin: 'vUSDC', quoteCoinID: 1,
    pricePrecision: 2, tickSize: '0.01', quantityPrecision: 3, stepSize: '0.001', minQuantity: '0.001',
    minNotional: '10', makerFee: '0', takerFee: '0', status: 'TRADING', ...over,
  }) as MarketSymbol;

const kline = (t: number, c = 100) => ({ t, o: '1', h: '2', l: '0.5', c: String(c), v: '3', q: '4', n: 1 });

/** A manual clock + timer queue: retries and deadlines run instantly. */
function fakeClock(start = 5_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (id: unknown) => void timers.delete(id as number),
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        await flush();
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
      await flush();
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface Harness {
  deps: DatafeedDeps;
  clock: ReturnType<typeof fakeClock>;
  resets: () => number;
  kl: KlineQuery[];
  symbolCalls: Engine[];
  push: (engine: Engine, symbol: string, interval: string, data: unknown) => void;
  live: () => number;
}

function harness(opts: {
  symbols?: Partial<Record<Engine, MarketSymbol[]>>;
  klines?: (q: KlineQuery) => unknown[] | Promise<unknown[]>;
} = {}): Harness {
  const kl: KlineQuery[] = [];
  const symbolCalls: Engine[] = [];
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  const clock = fakeClock();
  let resets = 0;
  const deps: DatafeedDeps = {
    defaultEngine: () => 'perps',
    defer: (fn) => fn(),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    resetChart: () => void resets++,
    loadSymbols: async (e) => {
      symbolCalls.push(e);
      return opts.symbols?.[e] ?? [];
    },
    loadKlines: async (q) => {
      kl.push(q);
      return (opts.klines ?? (() => []))(q);
    },
    subscribeCandles: (engine, symbol, interval, onData) => {
      const key = `${engine}|${symbol}|${interval}`;
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(onData);
      return () => set!.delete(onData);
    },
  };
  return {
    deps,
    clock,
    resets: () => resets,
    kl,
    symbolCalls,
    push: (engine, symbol, interval, data) => {
      for (const l of listeners.get(`${engine}|${symbol}|${interval}`) ?? []) l(data);
    },
    live: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

const info = (ticker = 'perps:BTC-USD'): LibrarySymbolInfo =>
  ({ name: ticker.split(':')[1], ticker } as LibrarySymbolInfo);

function getBars(
  feed: ReturnType<typeof createDatafeed>,
  resolution: string,
  params: PeriodParams,
  symbolInfo = info(),
): Promise<{ bars: Bar[]; meta?: HistoryMetadata } | { error: string }> {
  return new Promise((resolve) =>
    feed.getBars(symbolInfo, resolution, params, (bars, meta) => resolve({ bars, meta }), (error) => resolve({ error })),
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('onReady hands over the configuration', () => {
  const feed = createDatafeed(harness().deps);
  let config: unknown;
  feed.onReady((c) => (config = c));
  assert.ok(config && (config as { supported_resolutions: string[] }).supported_resolutions.includes('1D'));
});

test('first history request asks for the newest bars and returns them ascending', async () => {
  const h = harness({ klines: () => [kline(3_000), kline(2_000), kline(1_000)] });
  const feed = createDatafeed(h.deps);
  const r = await getBars(feed, '60', { from: 0, to: 4, countBack: 300, firstDataRequest: true });
  assert.ok('bars' in r);
  assert.deepEqual(r.bars.map((b) => b.time), [1_000, 2_000, 3_000]);
  assert.deepEqual(r.meta, { noData: false });
  assert.equal(h.kl.length, 1);
  assert.deepEqual(h.kl[0], { engine: 'perps', symbol: 'BTC-USD', interval: '1h', limit: 300 });
});

test('paging back sends endTime = to - 1ms and ends with noData on an empty page', async () => {
  const h = harness({ klines: (q) => (q.endTime !== undefined && q.endTime < 1_000 ? [] : [kline(1_000)]) });
  const feed = createDatafeed(h.deps);
  const r1 = await getBars(feed, '1', { from: 0, to: 2, countBack: 50, firstDataRequest: false });
  assert.equal(h.kl[0]?.endTime, 1_999);
  assert.ok('bars' in r1);
  assert.deepEqual(r1.bars.map((b) => b.time), [1_000]);
  assert.deepEqual(r1.meta, { noData: false });
  const r2 = await getBars(feed, '1', { from: 0, to: 1, countBack: 50, firstDataRequest: false });
  assert.ok('bars' in r2);
  assert.deepEqual(r2.bars, []);
  assert.deepEqual(r2.meta, { noData: true });
});

test('a gateway that ignored endTime cannot produce duplicates - it ends history instead', async () => {
  // Always returns the newest bars, whatever it was asked.
  const h = harness({ klines: () => [kline(10_000), kline(9_000)] });
  const feed = createDatafeed(h.deps);
  const r = await getBars(feed, '1', { from: 0, to: 9, countBack: 300, firstDataRequest: false });
  assert.ok('bars' in r);
  assert.deepEqual(r.bars, []);
  assert.deepEqual(r.meta, { noData: true });
});

test('identical concurrent history requests share one HTTP call', async () => {
  const h = harness({ klines: () => [kline(1_000)] });
  const feed = createDatafeed(h.deps);
  const p = { from: 0, to: 10, countBack: 300, firstDataRequest: true };
  await Promise.all([getBars(feed, '5', p), getBars(feed, '5', p)]);
  assert.equal(h.kl.length, 1);
});

test('an unsupported resolution is an error, not a guessed timeframe', async () => {
  const h = harness();
  const feed = createDatafeed(h.deps);
  const r = await getBars(feed, '10', { from: 0, to: 10, countBack: 300, firstDataRequest: true });
  assert.ok('error' in r);
  assert.equal(h.kl.length, 0);
});

test('a failed OLDER page reports the error at once (the library asks again on scroll)', async () => {
  const h = harness({ klines: () => Promise.reject(new Error('HTTP 429')) });
  const feed = createDatafeed(h.deps);
  const r = await getBars(feed, '1', { from: 0, to: 10, countBack: 300, firstDataRequest: false });
  assert.deepEqual(r, { error: 'HTTP 429' });
});

test('a failed FIRST page retries on the schedule, reports its state, and lands', async () => {
  let fail = true;
  const h = harness({ klines: () => (fail ? Promise.reject(new Error('HTTP 502')) : [kline(1_000)]) });
  const feed = createDatafeed(h.deps);
  const states: string[] = [];
  feed.onStatus((key, v) => states.push(`${key}:${v.phase}:${v.failures}`));
  let got: Bar[] | null = null;
  feed.getBars(info(), '1', { from: 0, to: 10, countBack: 300, firstDataRequest: true }, (b) => (got = b), () => assert.fail('no onError while retrying'));
  await h.clock.advance(0);
  await h.clock.advance(1_000); // retry 1
  await h.clock.advance(2_000); // retry 2 -> third failure
  assert.deepEqual(states, [
    'perps|BTC-USD|1m:loading:0',
    'perps|BTC-USD|1m:retrying:1',
    'perps|BTC-USD|1m:retrying:1',
    'perps|BTC-USD|1m:retrying:2',
    'perps|BTC-USD|1m:retrying:2',
    'perps|BTC-USD|1m:error:3',
  ]);
  assert.equal(got, null);
  fail = false;
  feed.retryNow(); // the overlay's button: no 5s wait
  await h.clock.advance(0);
  assert.deepEqual((got as Bar[] | null)?.map((b) => b.time), [1_000]);
  assert.equal(states.at(-1), 'perps|BTC-USD|1m:ready:0');
  assert.equal(h.kl.length, 4);
});

test('a first page that never answers times out after 8s and is retried', async () => {
  let calls = 0;
  const aborted: boolean[] = [];
  const h = harness({
    klines: () => {
      calls += 1;
      return calls === 1 ? new Promise(() => undefined) : [kline(1_000)];
    },
  });
  h.deps.loadKlines = (q, signal) => {
    signal?.addEventListener('abort', () => aborted.push(true));
    h.kl.push(q);
    calls += 1;
    return calls === 1 ? new Promise(() => undefined) : Promise.resolve([kline(1_000)]);
  };
  const feed = createDatafeed(h.deps);
  let got: Bar[] | null = null;
  feed.getBars(info(), '1', { from: 0, to: 10, countBack: 300, firstDataRequest: true }, (b) => (got = b), () => undefined);
  await h.clock.advance(7_999);
  assert.equal(got, null);
  await h.clock.advance(1 + 1_000);
  assert.equal(aborted.length, 1, 'the stuck request was aborted');
  assert.deepEqual((got as Bar[] | null)?.map((b) => b.time), [1_000]);
});

test('switching series cancels the old first load: its late answer never lands', async () => {
  const release: Record<string, (rows: unknown[]) => void> = {};
  const h = harness();
  h.deps.loadKlines = (q) => {
    h.kl.push(q);
    return new Promise((r) => (release[q.interval] = r));
  };
  const feed = createDatafeed(h.deps);
  const got: string[] = [];
  feed.getBars(info(), '1', { from: 0, to: 10, countBack: 300, firstDataRequest: true }, () => got.push('1m'), () => got.push('1m-err'));
  feed.getBars(info(), '5', { from: 0, to: 10, countBack: 300, firstDataRequest: true }, () => got.push('5m'), () => got.push('5m-err'));
  release['1m']?.([kline(60_000)]);
  release['5m']?.([kline(300_000)]);
  await h.clock.advance(0);
  assert.deepEqual(got, ['5m']);
});

test('the engine comes from the ticker, not from whatever the app shows now', async () => {
  const h = harness({ klines: () => [] });
  const feed = createDatafeed(h.deps);
  await getBars(feed, '1', { from: 0, to: 10, countBack: 1, firstDataRequest: true }, info('spot:BTC_USDC'));
  assert.equal(h.kl[0]?.engine, 'spot');
  assert.equal(h.kl[0]?.symbol, 'BTC_USDC');
});

test('realtime: ticks flow, stale and foreign ones do not, unsubscribe stops them', async () => {
  const h = harness({ klines: () => [kline(2_000)] });
  const feed = createDatafeed(h.deps);
  await getBars(feed, '1', { from: 0, to: 10, countBack: 300, firstDataRequest: true });
  const got: number[] = [];
  feed.subscribeBars(info(), '1', (b) => got.push(b.time), 'g1', () => undefined);
  h.push('perps', 'BTC-USD', '1m', { ...kline(1_000), s: 'BTC-USD', i: '1m' }); // older than history
  h.push('perps', 'BTC-USD', '1m', { ...kline(2_000), s: 'BTC-USD', i: '1m' }); // same bar, updated
  h.push('perps', 'BTC-USD', '1m', { ...kline(3_000), s: 'ETH-USD', i: '1m' }); // another market
  h.push('perps', 'BTC-USD', '1m', { ...kline(3_000), s: 'BTC-USD', i: '1m' }); // next bar
  h.push('perps', 'BTC-USD', '1m', { ...kline(2_000), s: 'BTC-USD', i: '1m' }); // out of order
  assert.deepEqual(got, [2_000, 3_000]);
  assert.equal(h.live(), 1);
  feed.unsubscribeBars('g1');
  assert.equal(h.live(), 0);
  h.push('perps', 'BTC-USD', '1m', kline(4_000));
  assert.deepEqual(got, [2_000, 3_000]);
});

test('resolve uses a primed symbol without fetching the list', async () => {
  const h = harness();
  const feed = createDatafeed(h.deps);
  feed.primeSymbol('perps', sym('BTC-USD', { tickSize: '0.5' }));
  const resolved = await new Promise<LibrarySymbolInfo>((res, rej) => feed.resolveSymbol('perps:BTC-USD', res, rej));
  assert.equal(resolved.pricescale, 10);
  assert.equal(resolved.minmov, 5);
  assert.equal(h.symbolCalls.length, 0);
});

test('resolve falls back to the symbol list once, and rejects unknown names', async () => {
  const h = harness({ symbols: { perps: [sym('ETH-USD')] } });
  const feed = createDatafeed(h.deps);
  const eth = await new Promise<LibrarySymbolInfo>((res, rej) => feed.resolveSymbol('ETH-USD', res, rej));
  assert.equal(eth.ticker, 'perps:ETH-USD');
  const err = await new Promise<string>((res) => feed.resolveSymbol('perps:NOPE-USD', () => res('resolved?'), res));
  assert.equal(err, 'unknown_symbol');
  assert.deepEqual(h.symbolCalls, ['perps']);
});

test('search covers both books unless a type is chosen', async () => {
  const h = harness({ symbols: { perps: [sym('BTC-USD')], spot: [sym('BTC_USDC')] } });
  const feed = createDatafeed(h.deps);
  const both = await new Promise<string[]>((res) =>
    feed.searchSymbols('btc', '', '', (items) => res(items.map((i) => i.ticker ?? ''))),
  );
  assert.deepEqual(both, ['perps:BTC-USD', 'spot:BTC_USDC']);
  const spot = await new Promise<string[]>((res) =>
    feed.searchSymbols('btc', '', 'spot', (items) => res(items.map((i) => i.ticker ?? ''))),
  );
  assert.deepEqual(spot, ['spot:BTC_USDC']);
});

test('resetCache asks every live subscription to reload', () => {
  const feed = createDatafeed(harness().deps);
  let resets = 0;
  feed.subscribeBars(info(), '1', () => undefined, 'a', () => resets++);
  feed.subscribeBars(info(), '5', () => undefined, 'b', () => resets++);
  feed.resetCache();
  assert.equal(resets, 2);
});

test('dispose drops every subscription and silences late answers', async () => {
  let release: (rows: unknown[]) => void = () => undefined;
  const h = harness({ klines: () => new Promise((r) => (release = r)) });
  const feed = createDatafeed(h.deps);
  feed.subscribeBars(info(), '1', () => undefined, 'a', () => undefined);
  let answered = false;
  feed.getBars(info(), '1', { from: 0, to: 10, countBack: 1, firstDataRequest: true }, () => (answered = true), () => (answered = true));
  feed.dispose();
  assert.equal(h.live(), 0);
  release([kline(1)]);
  await tick();
  assert.equal(answered, false);
});


// --- realtime failsafes (shared with the klinecharts chart, ../feedHealth.ts) ---

const kv = (t: number, v: number, c = 100) => ({ t, o: '1', h: '2', l: '0.5', c: String(c), v: String(v), q: '4', n: 1 });

/** First page loaded, one realtime subscription, stream open. */
async function live(pages: unknown[][]) {
  const h = harness();
  const calls: KlineQuery[] = [];
  h.deps.loadKlines = async (q) => {
    calls.push(q);
    return pages.shift() ?? [];
  };
  const feed = createDatafeed(h.deps);
  const ticks: Bar[] = [];
  let resets = 0;
  const health: string[] = [];
  feed.onHealth((hh) => health.push(hh));
  await getBars(feed, '1', { from: 0, to: 10, countBack: 300, firstDataRequest: true });
  feed.subscribeBars(info(), '1', (b) => ticks.push(b), 'g', () => resets++);
  feed.noteStream(true);
  return { h, feed, calls, ticks, health, resets: () => resets };
}

test('stalled candles on a trading market: refilled through onTick, no duplicates, Delayed until the stream is back', async () => {
  const now = fakeClock().now();
  const T = (k: number) => now - 180_000 + k * 60_000;
  const r = await live([
    [kv(T(0), 5), kv(T(1), 5), kv(T(2), 1)],
    [kv(T(1), 5), kv(T(2), 4), kv(T(3), 2)], // the gap-fill: bar 2 grew, bar 3 is new
  ]);
  r.feed.noteTicker('perps', 'BTC-USD', '100');
  await r.h.clock.advance(5_000);
  r.feed.noteTicker('perps', 'BTC-USD', '101'); // a trade...
  await r.h.clock.advance(31_000); // ...and no candle since
  const live0 = r.h.live();
  r.feed.check();
  await r.h.clock.advance(0);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1]?.limit, 10);
  assert.deepEqual(r.ticks.map((b) => [b.time, b.volume]), [[T(2), 4], [T(3), 2]]);
  assert.equal(r.h.live(), live0, 'resubscribed, not doubled');
  assert.equal(r.health.at(-1), 'delayed');
  r.h.push('perps', 'BTC-USD', '1m', { ...kv(T(3), 3), s: 'BTC-USD', i: '1m' });
  assert.equal(r.health.at(-1), 'live');
});

test('a bar the stream skipped makes the library re-read history', async () => {
  const now = fakeClock().now();
  const T = (k: number) => now - 240_000 + k * 60_000;
  const r = await live([
    [kv(T(0), 1), kv(T(1), 1), kv(T(2), 1)],
    [kv(T(1), 1), kv(T(2), 1), kv(T(3), 1), kv(T(4), 1)],
  ]);
  r.h.push('perps', 'BTC-USD', '1m', { ...kv(T(4), 1), s: 'BTC-USD', i: '1m' }); // T3 never came
  r.feed.noteStream(false);
  r.feed.noteStream(true); // reconnect -> gap-fill
  await r.h.clock.advance(0);
  assert.equal(r.resets(), 1, 'onResetCacheNeeded');
  assert.equal(r.h.resets(), 1, 'and the chart was asked to reload');
});

test('a hub reconnect gap-fills once; a quiet market stays Live', async () => {
  const now = fakeClock().now();
  const r = await live([[kv(now - 60_000, 1)], [kv(now - 60_000, 1)]]);
  r.feed.noteStream(false);
  assert.equal(r.health.at(-1), 'delayed');
  r.feed.noteStream(true);
  await r.h.clock.advance(0);
  assert.equal(r.calls.length, 2);
  assert.equal(r.health.at(-1), 'live');
  assert.deepEqual(r.ticks, [], 'nothing new, nothing re-sent');
});
