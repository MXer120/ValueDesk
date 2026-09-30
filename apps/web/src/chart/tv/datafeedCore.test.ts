/**
 * Pure datafeed logic: resolution mapping, price format, bar mapping, paging.
 *   npx tsx --test src/chart/tv/datafeedCore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Symbol as MarketSymbol } from '../../api';
import {
  DAILY_MULTIPLIERS,
  INTRADAY_MULTIPLIERS,
  MONTHLY_MULTIPLIERS,
  PAGE_MAX,
  PAGE_MIN,
  SUPPORTED_RESOLUTIONS,
  WEEKLY_MULTIPLIERS,
  candleToBars,
  decimalsOf,
  historyMeta,
  intervalForResolution,
  klineToBar,
  normalizeBars,
  normalizeResolution,
  parseTicker,
  planHistory,
  priceFormatOf,
  resolutionForInterval,
  searchSymbols,
  tickerOf,
  toSymbolInfo,
  volumePrecisionOf,
} from './datafeedCore';

const sym = (over: Partial<MarketSymbol> = {}): MarketSymbol =>
  ({
    id: 1,
    name: 'BTC-USD',
    displayName: 'BTC-USD',
    baseCoin: 'BTC',
    quoteCoin: 'vUSDC',
    quoteCoinID: 1,
    pricePrecision: 0,
    tickSize: '1',
    quantityPrecision: 5,
    stepSize: '0.00001',
    minQuantity: '0.00001',
    minNotional: '10',
    makerFee: '0',
    takerFee: '0',
    status: 'TRADING',
    ...over,
  }) as MarketSymbol;

// --- resolutions --------------------------------------------------------------

test('every gateway interval has a TradingView resolution and back', () => {
  const pairs: [string, string][] = [
    ['1m', '1'], ['3m', '3'], ['5m', '5'], ['15m', '15'], ['30m', '30'],
    ['1h', '60'], ['2h', '120'], ['4h', '240'], ['6h', '360'], ['8h', '480'], ['12h', '720'],
    ['1D', '1D'], ['3D', '3D'], ['1W', '1W'], ['1M', '1M'],
  ];
  for (const [interval, res] of pairs) {
    assert.equal(resolutionForInterval(interval), res, interval);
    assert.equal(intervalForResolution(res), interval, res);
  }
  assert.equal(SUPPORTED_RESOLUTIONS.length, pairs.length);
});

test('resolutions come out shortest first', () => {
  assert.deepEqual(SUPPORTED_RESOLUTIONS, ['1', '3', '5', '15', '30', '60', '120', '240', '360', '480', '720', '1D', '3D', '1W', '1M']);
});

test('the library\'s alternate spellings fold onto the canonical ones', () => {
  assert.equal(intervalForResolution('D'), '1D');
  assert.equal(intervalForResolution('1d'), '1D');
  assert.equal(intervalForResolution('W'), '1W');
  assert.equal(intervalForResolution('M'), '1M');
  assert.equal(intervalForResolution('060'), '1h');
  assert.equal(normalizeResolution(' 240 '), '240');
});

test('resolutions the gateway does not serve map to nothing', () => {
  for (const r of ['1S', '10S', '1T', '2', '10', '45', '90', '2D', '2W', '3M', '0', '', 'abc']) {
    assert.equal(intervalForResolution(r), undefined, r);
  }
});

test('multipliers per unit match the table', () => {
  assert.deepEqual(INTRADAY_MULTIPLIERS, ['1', '3', '5', '15', '30', '60', '120', '240', '360', '480', '720']);
  assert.deepEqual(DAILY_MULTIPLIERS, ['1', '3']);
  assert.deepEqual(WEEKLY_MULTIPLIERS, ['1']);
  assert.deepEqual(MONTHLY_MULTIPLIERS, ['1']);
});

// --- price format -------------------------------------------------------------

test('pricescale / minmov from the tick size', () => {
  assert.deepEqual(priceFormatOf('0.01'), { pricescale: 100, minmov: 1 });
  assert.deepEqual(priceFormatOf('0.00001'), { pricescale: 100000, minmov: 1 });
  assert.deepEqual(priceFormatOf('0.5'), { pricescale: 10, minmov: 5 });
  assert.deepEqual(priceFormatOf('0.00025'), { pricescale: 100000, minmov: 25 });
  assert.deepEqual(priceFormatOf('1'), { pricescale: 1, minmov: 1 });
  assert.deepEqual(priceFormatOf('10'), { pricescale: 1, minmov: 10 });
  assert.deepEqual(priceFormatOf('0.0100'), { pricescale: 100, minmov: 1 });
  assert.deepEqual(priceFormatOf('1.0'), { pricescale: 1, minmov: 1 });
  assert.deepEqual(priceFormatOf('1e-8'), { pricescale: 100000000, minmov: 1 });
  assert.deepEqual(priceFormatOf(0.1), { pricescale: 10, minmov: 1 });
});

test('an unusable tick size falls back to the given precision', () => {
  assert.deepEqual(priceFormatOf(undefined, 3), { pricescale: 1000, minmov: 1 });
  assert.deepEqual(priceFormatOf('0', 2), { pricescale: 100, minmov: 1 });
  assert.deepEqual(priceFormatOf('-0.01', 2), { pricescale: 100, minmov: 1 });
  assert.deepEqual(priceFormatOf('abc', 4), { pricescale: 10000, minmov: 1 });
});

test('volume precision is the lot step\'s decimals', () => {
  assert.equal(volumePrecisionOf('0.001'), 3);
  assert.equal(volumePrecisionOf('1'), 0);
  assert.equal(volumePrecisionOf('0.10'), 1);
  assert.equal(volumePrecisionOf(undefined, 5), 5);
  assert.equal(decimalsOf('x'), null);
});

// --- symbols ------------------------------------------------------------------

test('ticker carries the engine and parses back', () => {
  assert.equal(tickerOf('perps', 'BTC-USD'), 'perps:BTC-USD');
  assert.deepEqual(parseTicker('perps:BTC-USD', 'spot'), { engine: 'perps', name: 'BTC-USD' });
  assert.deepEqual(parseTicker('SPOT:BTC_USDC', 'perps'), { engine: 'spot', name: 'BTC_USDC' });
  assert.deepEqual(parseTicker('BTC-USD', 'perps'), { engine: 'perps', name: 'BTC-USD' });
  assert.deepEqual(parseTicker('SoDEX:ETH-USD', 'spot'), { engine: 'spot', name: 'ETH-USD' });
});

test('symbol info: 24x7 UTC, tick-derived format, every resolution', () => {
  const info = toSymbolInfo('perps', sym({ tickSize: '0.5', stepSize: '0.001' }));
  assert.equal(info.name, 'BTC-USD');
  assert.equal(info.ticker, 'perps:BTC-USD');
  assert.equal(info.session, '24x7');
  assert.equal(info.timezone, 'Etc/UTC');
  assert.equal(info.pricescale, 10);
  assert.equal(info.minmov, 5);
  assert.equal(info.volume_precision, 3);
  assert.equal(info.has_intraday, true);
  assert.equal(info.has_weekly_and_monthly, true);
  assert.deepEqual(info.supported_resolutions, SUPPORTED_RESOLUTIONS);
  assert.equal(info.exchange, 'SoDEX');
  assert.match(info.description, /Futures$/);
  assert.match(toSymbolInfo('spot', sym()).description, /Spot$/);
});

test('search ranks exact > base coin > prefix > substring and filters by type', () => {
  const entries = [
    { engine: 'perps' as const, sym: sym({ name: 'WBTC-USD', displayName: 'WBTC-USD', baseCoin: 'WBTC' }) },
    { engine: 'perps' as const, sym: sym({ name: 'BTC-USD' }) },
    { engine: 'spot' as const, sym: sym({ name: 'BTC_USDC', displayName: 'BTC/USDC' }) },
    { engine: 'perps' as const, sym: sym({ name: 'ETH-USD', displayName: 'ETH-USD', baseCoin: 'ETH' }) },
  ];
  const all = searchSymbols(entries, 'btc', '', '');
  assert.deepEqual(all.map((r) => r.ticker), ['perps:BTC-USD', 'spot:BTC_USDC', 'perps:WBTC-USD']);
  assert.deepEqual(searchSymbols(entries, 'btc', '', 'spot').map((r) => r.ticker), ['spot:BTC_USDC']);
  assert.deepEqual(searchSymbols(entries, 'ETH-USD', '', '').map((r) => r.symbol), ['ETH-USD']);
  assert.equal(searchSymbols(entries, '', '', '').length, 4);
  assert.equal(searchSymbols(entries, 'btc', 'BINANCE', '').length, 0);
  assert.equal(searchSymbols(entries, 'zzz', '', '').length, 0);
});

// --- bars ---------------------------------------------------------------------

const k = (t: number, c = '100', extra: Record<string, unknown> = {}) => ({
  t, o: '99', h: '101', l: '98', c, v: '2.5', q: '250', n: 3, ...extra,
});

test('a gateway kline becomes a numeric bar', () => {
  assert.deepEqual(klineToBar(k(1000, '100.5')), {
    time: 1000, open: 99, high: 101, low: 98, close: 100.5, volume: 2.5,
  });
  const noVol = klineToBar({ t: 1, o: '1', h: '1', l: '1', c: '1' });
  assert.deepEqual(noVol, { time: 1, open: 1, high: 1, low: 1, close: 1 });
});

test('malformed klines are dropped, not passed through as NaN', () => {
  assert.equal(klineToBar(null), null);
  assert.equal(klineToBar({ t: 1, o: 'x', h: '1', l: '1', c: '1' }), null);
  assert.equal(klineToBar({ t: 0, o: '1', h: '1', l: '1', c: '1' }), null);
  assert.equal(klineToBar({ o: '1', h: '1', l: '1', c: '1' }), null);
  assert.equal(klineToBar({ t: 5, o: '', h: '1', l: '1', c: '1' }), null);
});

test('newest-first rows come out ascending and de-duplicated', () => {
  const bars = normalizeBars([k(3000), k(2000), k(1000), k(2000, '7'), { junk: true }]);
  assert.deepEqual(bars.map((b) => b.time), [1000, 2000, 3000]);
  assert.equal(bars[1]?.close, 7); // last occurrence of a duplicate wins
});

test('the exclusive `to` of a page is enforced', () => {
  const bars = normalizeBars([k(3000), k(2000), k(1000)], { beforeMs: 2000 });
  assert.deepEqual(bars.map((b) => b.time), [1000]);
});

test('live candles for another symbol or interval are dropped', () => {
  assert.equal(candleToBars(k(1, '1', { s: 'ETH-USD', i: '1m' }), 'BTC-USD', '1m').length, 0);
  assert.equal(candleToBars(k(1, '1', { s: 'BTC-USD', i: '5m' }), 'BTC-USD', '1m').length, 0);
  assert.equal(candleToBars(k(1, '1', { s: 'BTC-USD', i: '1m' }), 'BTC-USD', '1m').length, 1);
  // No symbol on the push (the hub does not always echo it) is accepted.
  assert.equal(candleToBars(k(1), 'BTC-USD', '1m').length, 1);
  const arr = candleToBars([k(2000), k(1000)], 'BTC-USD', '1m');
  assert.deepEqual(arr.map((b) => b.time), [1000, 2000]);
  assert.deepEqual(candleToBars(undefined, 'BTC-USD', '1m'), []);
});

// --- paging -------------------------------------------------------------------

test('first request: newest bars, no endTime, at least a full page', () => {
  const plan = planHistory({ from: 0, to: 1_700_000_000, countBack: 120, firstDataRequest: true }, '1m');
  assert.deepEqual(plan, { interval: '1m', limit: PAGE_MIN });
});

test('paging: endTime is `to` minus 1ms, results filtered below `to`', () => {
  const plan = planHistory({ from: 1_699_000_000, to: 1_700_000_000, countBack: 500, firstDataRequest: false }, '1h');
  assert.deepEqual(plan, {
    interval: '1h',
    limit: 500,
    endTime: 1_700_000_000_000 - 1,
    beforeMs: 1_700_000_000_000,
  });
});

test('countBack beyond the backend cap is clamped', () => {
  const plan = planHistory({ from: 0, to: 10, countBack: 5000, firstDataRequest: false }, '1m');
  assert.equal(plan.limit, PAGE_MAX);
});

test('without countBack the count is estimated from the range', () => {
  // 600 one-minute bars between from and to
  const plan = planHistory({ from: 0, to: 36_000, countBack: 0, firstDataRequest: false }, '1m');
  assert.equal(plan.limit, 600);
  const tiny = planHistory({ from: 100, to: 100, countBack: 0, firstDataRequest: false }, '1D');
  assert.equal(tiny.limit, PAGE_MIN);
});

test('an empty page ends history; a non-empty one does not', () => {
  assert.deepEqual(historyMeta([]), { noData: true });
  assert.deepEqual(historyMeta([{ time: 1, open: 1, high: 1, low: 1, close: 1 }]), { noData: false });
});
