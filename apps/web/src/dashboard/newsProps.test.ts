/**
 * What the News widget takes from the trade page (newsProps.ts).
 *   npx tsx --test src/dashboard/newsProps.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { newsProps } from './newsProps';
import type { TradeContext } from './registry';

const sym = (name: string, baseCoin: string) => ({ name, baseCoin });
function ctx(markets: Array<[string, string]>, chart: string | null, onSelectSymbol?: (name: string) => void): TradeContext {
  return {
    byName: new Map(markets.map(([n, b]) => [n, sym(n, b)])),
    sym: chart === null ? undefined : sym('X', chart),
    engine: 'perps',
    onSelectSymbol,
  } as unknown as TradeContext;
}

test('a market\'s coin as the news names it: no v prefix, no 1000 multiplier, upper case', () => {
  const p = newsProps(ctx([['vBTC_vUSDC', 'vBTC'], ['1000PEPE-USD', '1000PEPE'], ['1000000MOG-USD', '1000000MOG'], ['1INCH-USD', '1INCH'], ['VET-USD', 'VET'], ['wif-USD', 'wif']], 'vETH'));
  assert.equal(p.coin, 'ETH');
  assert.deepEqual(p.markets.map((m) => m.symbol).sort(), ['1INCH', 'BTC', 'MOG', 'PEPE', 'VET', 'WIF']);
});

test('the majors first in their own order, then A to Z; one entry per coin, its first market kept', () => {
  const p = newsProps(ctx([['AAVE-USD', 'AAVE'], ['ETH-USD', 'ETH'], ['ZEC-USD', 'ZEC'], ['BTC-USD', 'BTC'], ['HYPE-USD', 'HYPE'], ['vBTC_vUSDC', 'vBTC'], ['ADA-USD', 'ADA']], 'BTC'));
  assert.deepEqual(p.markets.map((m) => m.symbol), ['BTC', 'ETH', 'HYPE', 'AAVE', 'ADA', 'ZEC']);
  assert.equal(p.prices.market('BTC'), 'BTC-USD', 'the first market for a coin is the one read and opened');
  assert.equal(p.prices.market('DOGE'), undefined);
  assert.equal(p.prices.engine, 'perps');
});

test('a story\'s coin opens its market; a coin this book does not trade does nothing; no switch, no opener', () => {
  const opened: string[] = [];
  const p = newsProps(ctx([['SOL-USD', 'SOL']], 'SOL', (n) => opened.push(n)));
  p.onCoin!('SOL');
  p.onCoin!('XRP');
  assert.deepEqual(opened, ['SOL-USD']);
  assert.equal(newsProps(ctx([['SOL-USD', 'SOL']], 'SOL')).onCoin, undefined);
});

test('no market on screen: no coin', () => {
  assert.equal(newsProps(ctx([], null)).coin, null);
  assert.deepEqual(newsProps(ctx([], null)).markets, []);
  assert.equal(newsProps(ctx([], '')).coin, null);
});
