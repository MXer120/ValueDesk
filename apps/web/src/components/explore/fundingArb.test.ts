import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aprPct, asMs, bestPair, buildPairs, filterPairs, hlLegs, per8h, sodexLegs, sortPairs,
  type FundLeg,
} from './fundingArb';

const leg = (over: Partial<FundLeg> & Pick<FundLeg, 'venue' | 'symbol' | 'rate'>): FundLeg => ({
  coin: over.coin ?? over.symbol,
  intervalSec: 3600,
  nextFundingMs: null,
  mark: 100,
  bid: null,
  ask: null,
  volumeUsd: 1_000_000,
  oiUsd: 2_000_000,
  changePct: null,
  maxLev: 20,
  ...over,
});

test('8h scaling and APR use the interval, not a fixed hour', () => {
  assert.equal(per8h(0.0001, 3600), 0.0008);
  assert.equal(per8h(0.0008, 8 * 3600), 0.0008);
  assert.equal(aprPct(0.0016), 0.0016 * 1095 * 100);
});

test('unix seconds become milliseconds; milliseconds stay', () => {
  assert.equal(asMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(asMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(asMs(0), null);
});

test('the long leg is the lower rate, across different clocks', () => {
  const pair = bestPair([
    leg({ venue: 'sodex', symbol: 'BTC-USD', coin: 'BTC', rate: 0.0001, ask: 100, bid: 99.9, mark: 100 }),
    leg({ venue: 'hyperliquid', symbol: 'BTC', coin: 'BTC', rate: 0.0003, mark: 102, bid: null, ask: null }),
  ]);
  assert.ok(pair);
  assert.equal(pair.long.venue, 'sodex');
  assert.equal(pair.short.venue, 'hyperliquid');
  assert.ok(Math.abs(pair.spread8h - 0.0016) < 1e-12);
  assert.ok(Math.abs(pair.apr - 175.2) < 1e-9);
  // Hyperliquid has no book, so the spread is the two marks.
  assert.equal(pair.priceBasis, 'mark');
  assert.equal(pair.priceSpread, (102 - 100) / 100);
});

test('a two-sided book is the entry spread: sell the short bid, buy the long ask', () => {
  const pair = bestPair([
    leg({ venue: 'sodex', symbol: 'ETH-USD', coin: 'ETH', rate: 0.0001, ask: 100, bid: 99 }),
    leg({ venue: 'hyperliquid', symbol: 'ETH', coin: 'ETH', rate: 0.0002, ask: 103, bid: 102, mark: 102.5 }),
  ]);
  assert.equal(pair?.priceBasis, 'book');
  assert.equal(pair?.priceSpread, (102 - 100) / 100);
});

test('one venue, or a missing rate, is not a pair; kPEPE and 1000PEPE are one coin; xyz is not', () => {
  const rows = buildPairs([
    ...sodexLegs(
      [
        { name: 'BTC-USD', status: 'TRADING', fundingInterval: 3600 },
        { name: '1000PEPE-USD', status: 'TRADING', fundingInterval: 3600 },
        { name: 'TSLA-USD', status: 'TRADING', fundingInterval: 3600 },
        { name: 'HALT-USD', status: 'HALT', fundingInterval: 3600 },
      ],
      [
        { symbol: 'BTC-USD', fundingRate: '0.0001', markPrice: '100', quoteVolume: '5000000', openInterest: '10' },
        { symbol: '1000PEPE-USD', fundingRate: '0.0002', markPrice: '1' },
        { symbol: 'TSLA-USD', fundingRate: '0.0001', markPrice: '200' },
        { symbol: 'HALT-USD', fundingRate: '0.01', markPrice: '1' },
      ],
    ),
    ...hlLegs([
      { symbol: 'BTC', funding: 0.0003, price: 101, volume24h: 9_000_000, openInterestUsd: 40_000_000 },
      { symbol: 'kPEPE', funding: -0.0001, price: 1, volume24h: 100_000 },
      { symbol: 'xyz:TSLA', funding: 0.001, price: 210, volume24h: 1_000_000 },
      { symbol: 'SOL', funding: 0.0001, price: 150 },
      { symbol: '', funding: 0.1 },
    ]),
  ]);
  const coins = rows.map((r) => r.coin).sort();
  assert.deepEqual(coins, ['1000PEPE', 'BTC']);
  const pepe = rows.find((r) => r.coin === '1000PEPE');
  assert.equal(pepe?.long.venue, 'hyperliquid');
  assert.equal(pepe?.short.symbol, '1000PEPE-USD');
  const btc = rows.find((r) => r.coin === 'BTC');
  assert.equal(btc?.long.oiUsd, 10 * 100);
});

test('filters keep a coin whose thinner book clears the volume, and sort by price', () => {
  const rows = buildPairs([
    leg({ venue: 'sodex', symbol: 'A', coin: 'A', rate: 0, volumeUsd: 50_000, mark: 100 }),
    leg({ venue: 'hyperliquid', symbol: 'A', coin: 'A', rate: 0.0001, volumeUsd: 5_000_000, mark: 110 }),
    leg({ venue: 'sodex', symbol: 'B', coin: 'B', rate: 0, volumeUsd: 2_000_000, mark: 100 }),
    leg({ venue: 'hyperliquid', symbol: 'B', coin: 'B', rate: 0.00005, volumeUsd: 2_000_000, mark: 101 }),
  ]);
  assert.deepEqual(filterPairs(rows, { minVol: 100_000 }).map((r) => r.coin), ['B']);
  assert.deepEqual(filterPairs(rows, { q: 'a' }).map((r) => r.coin), ['A']);
  const byPrice = sortPairs(rows, 'price');
  assert.equal(byPrice[0]?.coin, 'A');
});
