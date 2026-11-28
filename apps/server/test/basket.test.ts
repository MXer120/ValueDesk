/** SSI baskets read from their contracts (wealth/basket.ts): decoding, names and weights. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAddrUints, decodeString, decodeTokenset, priceOf, tickerOf, weigh } from '../src/wealth/basket.js';

const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const s = (x: string) => { const h = Buffer.from(x, 'utf8').toString('hex'); return w(x.length) + h.padEnd(Math.ceil(h.length / 64) * 64 || 64, '0'); };

test('(address[], uint256[]): ANT Believers Index composition', () => {
  const hex = '0x' + w(64) + w(160) + w(2) + w(0xaa) + w(0xbb) + w(2) + w(10n ** 16n) + w(5n * 10n ** 15n);
  const d = decodeAddrUints(hex);
  assert.deepEqual(d.tokens, ['0x' + 'aa'.padStart(40, '0'), '0x' + 'bb'.padStart(40, '0')]);
  assert.deepEqual(d.units, [10n ** 16n, 5n * 10n ** 15n]);
});

test('a tokenset: (string chain, string symbol, string addr, uint8, uint256)[]', () => {
  // One tuple: head of 5 words, then three strings.
  const tuple = w(160) + w(160 + 64) + w(160 + 128) + w(8) + w(12345) + s('ETH') + s('ETH_LINK') + s('0x1');
  const hex = '0x' + w(32) + w(1) + w(32) + tuple;
  assert.deepEqual(decodeTokenset(hex), [{ chain: 'ETH', symbol: 'ETH_LINK', addr: '0x1', decimals: 8, amount: 12345n }]);
  assert.equal(decodeString('0x' + w(32) + s('vNVDA')), 'vNVDA');
});

test('names: SoDEX tokens lose their v, tokensets their chain and copy number', () => {
  assert.equal(tickerOf('vNVDA'), 'NVDA');
  assert.equal(tickerOf('ETH_LINK'), 'LINK');
  assert.equal(tickerOf('SOL_TRUMP1'), 'TRUMP');
  assert.equal(tickerOf('ETH_UNISWAP'), 'UNI');
  assert.equal(tickerOf('BTC'), 'BTC');
});

test('prices from SoDEX marks (and 1000x perps, and spot), weights only where priced', () => {
  const marks = new Map([['BTC-USD', 60000], ['1000SHIB-USD', 0.004], ['vAVGO_vUSDC', 300]]);
  assert.equal(priceOf('SHIB', marks), 0.000004);
  assert.equal(priceOf('AVGO', marks), 300);
  const r = weigh([{ name: 'BTC', ticker: 'BTC', quantity: 1 }, { name: 'AVGO', ticker: 'AVGO', quantity: 100 }, { name: 'JUP', ticker: 'JUP', quantity: 5 }], marks);
  assert.deepEqual(r.rows.map((x) => [x.ticker, x.weight === null ? null : Math.round(x.weight * 100)]), [['BTC', 67], ['AVGO', 33], ['JUP', null]]);
  assert.deepEqual(r.unpriced, ['JUP']);
});
