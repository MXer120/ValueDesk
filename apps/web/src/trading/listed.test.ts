/**
 * A market SoDEX does not list is never traded here (listed.ts): the one line every place
 * says, the coin it names, and when a market counts as known not to be listed - never while
 * SoDEX's list has not come in, or is the other engine's.
 * Run (from apps/web): npx tsx --test src/trading/listed.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notListedLine } from '@copy-engine';
import { knownUnlisted, linkedMarket, marketCoin, notListed } from './listed';

test('the line names the coin, in the copy engine\'s own words', () => {
  assert.equal(notListed('PURR-USD'), "PURR is not listed on SoDEX, so it can't be traded here.");
  assert.equal(notListed('PURR-USD'), notListedLine('PURR'));
  assert.deepEqual(['1000PEPE-USD', 'vPURR_vUSDC', 'WSOSO_vUSDC', 'BTC/USDC', ' HYPE-USD '].map(marketCoin), ['1000PEPE', 'PURR', 'WSOSO', 'BTC/USDC', 'HYPE']);
});

test('known not listed: only on this engine\'s own list once it is in; not knowing is not "unlisted"', () => {
  const perps = { engine: 'perps', symbols: [{ name: 'BTC-USD' }, { name: 'ETH-USD' }] };
  assert.equal(knownUnlisted('PURR-USD', 'perps', perps), true);
  assert.equal(knownUnlisted('BTC-USD', 'perps', perps), false);
  assert.equal(knownUnlisted('btc-usd', 'perps', perps), false, 'names compare without case, as SoDEX\'s do');
  assert.equal(knownUnlisted('PURR-USD', 'perps', null), false, 'the list has not come in');
  assert.equal(knownUnlisted('PURR-USD', 'perps', { engine: 'perps', symbols: [] }), false, 'an empty list is a failed read');
  assert.equal(knownUnlisted('vBTC_vUSDC', 'spot', perps), false, 'for a moment after a switch the poll still holds the other engine\'s list');
  assert.equal(knownUnlisted('', 'perps', perps), false);
});

test('a link names a market (/trade?symbol=): its engine from the name; anything else is no market', () => {
  assert.deepEqual(linkedMarket('?symbol=BTC-USD'), { engine: 'perps', symbol: 'BTC-USD' });
  assert.deepEqual(linkedMarket('?tab=positions&symbol=vBTC_vUSDC'), { engine: 'spot', symbol: 'vBTC_vUSDC' });
  assert.deepEqual(linkedMarket('?symbol=PURR-USD'), { engine: 'perps', symbol: 'PURR-USD' }, "listed or not is the trade page's to judge");
  assert.equal(linkedMarket(''), null);
  assert.equal(linkedMarket('?symbol='), null);
  assert.equal(linkedMarket('?symbol=%3Cscript%3E'), null);
});
