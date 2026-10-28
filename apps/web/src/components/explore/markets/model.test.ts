import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMarkets, filterMarkets, fundingApr, headline, heldLong, pulseOf, railRows, sectorStats, sortMarkets,
  type HlAsset, type MarketRow,
} from './model';
import { setNumStyle } from '../../../numStyle';
import { fmtRoi as roi, fmtUsdExact as usdExact, fmtUsdShort as usdShort } from '../model';

test('explore figures in the default number format (1.234,56)', () => {
  setNumStyle('dot-comma');
  try {
    assert.equal(usdShort(1_234_567), '$1,23M');
    assert.equal(usdShort(5_000), '$5.000');
    assert.equal(usdExact(1234.5), '$1.234,50');
    assert.equal(roi(0.123), '+12,3%');
  } finally {
    setNumStyle('comma-dot');
  }
});

// These cases read the en-US format (1,234.56); the app's default (1.234,56) is checked separately.
setNumStyle('comma-dot');

const hl: HlAsset[] = [
  { symbol: 'BTC', dex: '', price: 80_000, changePct: 1, volume24h: 2e9, openInterestUsd: 3e9, funding: 0.0000125, maxLeverage: 40 },
  { symbol: 'kPEPE', dex: '', price: 0.01, changePct: -4, volume24h: 5e7, openInterestUsd: 1e7, funding: -0.00002, maxLeverage: 10 },
  { symbol: 'xyz:TSLA', dex: 'xyz', price: 400, changePct: 2, volume24h: 1e8, openInterestUsd: 5e7, funding: 0.00001, maxLeverage: 10 },
  { symbol: 'DEAD', dex: '', price: 0, volume24h: 1 },
];
const tickers = [
  { symbol: 'BTC-USD', markPrice: '80010', changePct: 0.9, quoteVolume: '1000000', openInterest: '10', fundingRate: '0.00001' },
  { symbol: 'TSLA-USD', markPrice: '401', changePct: 2.1, quoteVolume: '50000', openInterest: '100', fundingRate: '0.00002' },
  { symbol: 'AXS-USD', markPrice: '1', changePct: 0.3, quoteVolume: '3000', openInterest: '200', fundingRate: '0.00008' },
  { symbol: 'OFF-USD', markPrice: '1', quoteVolume: '1' },
];
const symbols = [
  { name: 'BTC-USD', status: 'TRADING', fundingInterval: 3600 },
  { name: 'TSLA-USD', status: 'TRADING', fundingInterval: 3600 },
  { name: 'AXS-USD', status: 'TRADING', fundingInterval: 8 * 3600, maxLeverage: 5 },
  { name: 'OFF-USD', status: 'HALT' },
];

test('one row per market: a SoDEX market joins its Hyperliquid or trade.xyz row', () => {
  const rows = buildMarkets(hl, tickers, symbols);
  assert.deepEqual(rows.map((r) => r.key), ['BTC', 'XYZ:TSLA', '1000PEPE', 'AXS']);
  const btc = rows[0]!;
  assert.deepEqual(btc.venues, ['hyperliquid', 'sodex']);
  assert.equal(btc.sodex, 'BTC-USD');
  assert.equal(btc.volume, 2e9 + 1e6);
  assert.equal(btc.oi, 3e9 + 10 * 80010);
  assert.equal(btc.price, 80_000, 'the deepest book prices the row');
  const tsla = rows.find((r) => r.key === 'XYZ:TSLA')!;
  assert.equal(tsla.name, 'TSLA');
  assert.equal(tsla.sodex, 'TSLA-USD');
  assert.equal(tsla.tradfi, true);
  assert.deepEqual(tsla.venues, ['tradexyz', 'sodex']);
});

test('the sector of a 1000x unit is its coin\'s, and the chart asks for the venue\'s name', () => {
  const pepe = buildMarkets(hl, [], []).find((r) => r.key === '1000PEPE')!;
  assert.equal(pepe.sector, 'memes');
  assert.equal(pepe.chartCoin, 'KPEPE');
});

test('a SoDEX-only market: its own row, funding per hour, halted markets left out', () => {
  const rows = buildMarkets(hl, tickers, symbols);
  const axs = rows.find((r) => r.key === 'AXS')!;
  assert.equal(axs.chartCoin, null);
  assert.equal(axs.funding, 0.00001);
  assert.equal(axs.maxLeverage, 5);
  assert.equal(rows.some((r) => r.key === 'OFF'), false);
});

test('tracked wallets: matched by coin, long share', () => {
  const rows = buildMarkets(hl, [], [], [{ coin: 'BTC', long: 300, short: 100, holders: 9 }]);
  const btc = rows.find((r) => r.key === 'BTC')!;
  assert.equal(heldLong(btc), 0.75);
  assert.equal(btc.holders, 9);
  assert.equal(heldLong(rows.find((r) => r.key === 'XYZ:TSLA')!), null);
});

test('pulse and headline', () => {
  const rows = buildMarkets(hl, tickers, symbols);
  const p = pulseOf(rows);
  assert.equal(p.markets, 4);
  assert.equal(p.up, 3);
  assert.equal(p.down, 1);
  const line = headline(rows, 1e7)!;
  assert.match(line, /^Risk-on: 75% of 4 markets are up over 24h; BTC \+1\.00%; kPEPE moves most among liquid markets \(−4\.00%\)\.$/);
  assert.equal(headline([]), null);
});

test('rail lists: movers need volume, the watchlist keeps its order', () => {
  const rows = buildMarkets(hl, tickers, symbols);
  assert.deepEqual(railRows(rows, 'gainers', []).map((r) => r.key), ['XYZ:TSLA', 'BTC']);
  assert.deepEqual(railRows(rows, 'losers', []).map((r) => r.key), ['1000PEPE']);
  assert.deepEqual(railRows(rows, 'watch', ['AXS', 'NOPE', 'BTC']).map((r) => r.key), ['AXS', 'BTC']);
  assert.equal(railRows(rows, 'funding', [])[0]!.key, '1000PEPE');
});

test('filter and sort: a missing figure sorts last both ways', () => {
  const rows = buildMarkets(hl, tickers, symbols);
  assert.deepEqual(filterMarkets(rows, { kind: 'tradfi' }).map((r) => r.key), ['XYZ:TSLA']);
  assert.deepEqual(filterMarkets(rows, { kind: 'all', venues: ['sodex'] }).map((r) => r.key), ['BTC', 'XYZ:TSLA', 'AXS']);
  assert.deepEqual(filterMarkets(rows, { kind: 'all', venues: ['tradexyz'] }).map((r) => r.key), ['XYZ:TSLA']);
  assert.equal(filterMarkets(rows, { kind: 'all', venues: ['sodex', 'hyperliquid', 'tradexyz'] }).length, 4);
  assert.deepEqual(filterMarkets(rows, { kind: 'all', q: 'pep' }).map((r) => r.key), ['1000PEPE']);
  const noChange: MarketRow = { ...rows[0]!, key: 'NULL', changePct: null };
  const asc = sortMarkets([noChange, ...rows], 'change', 'asc').map((r) => r.key);
  const desc = sortMarkets([noChange, ...rows], 'change', 'desc').map((r) => r.key);
  assert.equal(asc.at(-1), 'NULL');
  assert.equal(desc.at(-1), 'NULL');
  assert.equal(desc[0], 'XYZ:TSLA');
});

test('sectors: the busiest first, Other last', () => {
  const stats = sectorStats(buildMarkets(hl, tickers, symbols));
  assert.deepEqual(stats.map((s) => s.id), ['majors', 'equities', 'memes', 'other']);
  assert.equal(stats[0]!.top[0]!.key, 'BTC');
});

test('funding APR', () => {
  assert.equal(fundingApr(null), null);
  assert.ok(Math.abs(fundingApr(0.0000125)! - 10.95) < 1e-9);
});
