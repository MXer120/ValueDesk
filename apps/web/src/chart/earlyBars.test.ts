/**
 * The trade page's first reads, started as its code arrives (earlyBars.ts): only on a load that
 * lands on the trade page, for the series the chart will ask first, handed over once.
 *   npx tsx --test src/chart/earlyBars.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KLineData } from 'klinecharts';
import { _resetEarly, isTradeLanding, keptForStore, keptSignature, returnEarly, setLiveSeries, startEarlyReads, takeEarly, type EarlyEnv } from './earlyBars';

test('early: a periodic write that would store the same series is skipped; a new bar or another series is not', () => {
  const bar = (t: number): KLineData => ({ timestamp: t, open: 1, high: 1, low: 1, close: 1 });
  const s = (key: string, n: number, unverifiedFrom: number | null = null): KeptSeries => ({ key, at: Date.now(), more: true, unverifiedFrom, bars: Array.from({ length: n }, (_, i) => bar((i + 1) * 60_000)) });
  const a = keptSignature([s('perps|BTC-USD|1m', 499)]);
  assert.equal(keptSignature([{ ...s('perps|BTC-USD|1m', 499), at: 1 }]), a, 'only the time it was taken differs');
  assert.notEqual(keptSignature([s('perps|BTC-USD|1m', 500)]), a, 'a bar closed since');
  assert.notEqual(keptSignature([s('perps|BTC-USD|1m', 499, 400 * 60_000)]), a, 'the stream wrote a bar');
  assert.notEqual(keptSignature([s('perps|BTC-USD|1m', 499), s('perps|ETH-USD|1m', 10)]), a, 'another series left');
});
import { seriesCache, type KeptSeries } from './seriesCache';
import { KLINE_LIMIT } from './series';

function env(over: Partial<EarlyEnv> & { stored?: Record<string, string> } = {}) {
  const reads: Array<{ engine: string; symbol: string; interval: string; limit: number }> = [];
  const tickers: string[] = [];
  const stored = over.stored ?? {};
  let answer!: (rows: unknown[]) => void;
  const e: EarlyEnv = {
    pathname: '/trade',
    search: '',
    read: (k) => stored[k] ?? null,
    now: () => 1_000,
    store: { read: async () => [], write: async () => undefined },
    klines: ((q: { engine: string; symbol: string; interval: string; limit: number }) => {
      reads.push(q);
      return new Promise<unknown[]>((r) => (answer = r));
    }) as EarlyEnv['klines'],
    tickers: (eng) => tickers.push(eng),
    ...over,
  };
  return { e, reads, tickers, answer: (rows: unknown[]) => answer(rows) };
}

test('early: a load landing on the trade page reads the 1m chart of the stored market, and the tickers', async () => {
  _resetEarly();
  const { e, reads, tickers, answer } = env({ stored: { 'ot.engine': JSON.stringify('perps'), 'ot.symbol': JSON.stringify('ETH-USD') } });
  startEarlyReads(e);
  startEarlyReads(e);
  assert.deepEqual(reads, [{ engine: 'perps', symbol: 'ETH-USD', interval: '1m', limit: KLINE_LIMIT }], 'once per page');
  assert.deepEqual(tickers, ['perps']);
  assert.equal(takeEarly('perps|BTC-USD|1m'), null, 'another series does not take it');
  const r = takeEarly('perps|ETH-USD|1m')!;
  assert.ok(r);
  assert.equal(takeEarly('perps|ETH-USD|1m'), null, 'handed over once');
  answer([{ t: 60_000 }]);
  await r.promise;
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(r.answeredAt, 1_000);
  assert.deepEqual(r.rows, [{ t: 60_000 }]);
  returnEarly(r);
  assert.equal(takeEarly('perps|ETH-USD|1m'), r, 'a superseded load gives it back');
});

test('early: a link names the market; the default when nothing is stored', () => {
  _resetEarly();
  const a = env({ search: '?symbol=vSOL_vUSDC' });
  startEarlyReads(a.e);
  assert.deepEqual(a.reads[0], { engine: 'spot', symbol: 'vSOL_vUSDC', interval: '1m', limit: KLINE_LIMIT });
  _resetEarly();
  const b = env({ pathname: '/' });
  startEarlyReads(b.e);
  assert.deepEqual(b.reads[0], { engine: 'perps', symbol: 'BTC-USD', interval: '1m', limit: KLINE_LIMIT });
});

test('early: nothing is read on a load that lands anywhere else', () => {
  for (const path of ['/explore', '/bots', '/points', '/terms', '/status', '/portfolio']) {
    _resetEarly();
    const x = env({ pathname: path });
    startEarlyReads(x.e);
    assert.equal(x.reads.length, 0, path);
    assert.equal(x.tickers.length, 0, path);
    assert.equal(isTradeLanding(path), false, path);
  }
  assert.equal(isTradeLanding('/trade'), true);
  assert.equal(isTradeLanding('/'), true);
});

test('early: the series kept across a reload come into the cache; the store gets the one on screen first', async () => {
  _resetEarly();
  seriesCache.clear();
  const bar = (t: number): KLineData => ({ timestamp: t, open: 1, high: 1, low: 1, close: 1 });
  const kept = (key: string, at: number): KeptSeries => ({ key, at, more: true, unverifiedFrom: null, bars: [bar(60_000)] });
  const x = env({ pathname: '/explore', store: { read: async () => [kept('perps|ETH-USD|5m', 5)], write: async () => undefined } });
  startEarlyReads(x.e);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(seriesCache.peek('perps|ETH-USD|5m')?.at, 5);
  seriesCache.put(kept('perps|SOL-USD|1m', 7));
  const off = setLiveSeries(() => kept('perps|BTC-USD|1m', 9));
  assert.deepEqual(keptForStore().map((k) => k.key), ['perps|BTC-USD|1m', 'perps|SOL-USD|1m', 'perps|ETH-USD|5m']);
  off();
  assert.deepEqual(keptForStore().map((k) => k.key), ['perps|SOL-USD|1m', 'perps|ETH-USD|5m']);
  seriesCache.clear();
});
