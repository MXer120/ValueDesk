/**
 * Non-signing logic, ported from Opentrade/server/test/logic.test.ts: order
 * validation, decimal helpers, WebSocket subscription shaping and endpoint
 * weights. (Keystore tests are not ported: this package has no keystore -
 * keys live in memory only.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseOrder, mulDecimal, resolveSymbol, OrderValidationError, SymbolNotFoundError } from '../src/symbols.ts';
import { ACCOUNT_CHANNELS, CHANNEL_PARAM_STYLE, normaliseSubParams, subKey } from '../src/types/ws.ts';
import type { PerpsSymbol } from '../src/types/rest.ts';
import { BTC } from './fixtures.ts';
import { canonicalDecimal, roundToStep } from '../src/decimal.ts';
import { weightFor } from '../src/envelope.ts';

// WLD-USD has integer quantities (stepSize "1") - a good precision edge case.
const WLD = {
  ...BTC, id: 24, name: 'WLD-USD', displayName: 'WLD-USD', baseCoin: 'WLD',
  tickSize: '0.0001', minPrice: '0.0001', quantityPrecision: 0, stepSize: '1',
  minQuantity: '1', maxQuantity: '10000000', marketMinQuantity: '1', marketMaxQuantity: '10000000',
  minNotional: '10', maxNotional: '1000000', maxLeverage: 10,
} satisfies PerpsSymbol;

// --- order validation --------------------------------------------------------

test('price snaps to the tick grid', () => {
  assert.equal(normaliseOrder(BTC, { price: '70000.567', type: 1 }).price, '70000.6');
  assert.equal(normaliseOrder(WLD, { price: '1.23456789', type: 1 }).price, '1.2346');
});

test('quantity floors to the step grid, never rounding up', () => {
  // Rounding a quantity UP could exceed the user's balance, so floor is required.
  assert.equal(normaliseOrder(BTC, { quantity: '0.123456789', type: 1 }).quantity, '0.12345');
  assert.equal(normaliseOrder(WLD, { quantity: '99.9', type: 1 }).quantity, '99');
});

test('normalised values never carry trailing zeros', () => {
  for (const q of ['0.10000', '1.000', '0.4060']) {
    const out = normaliseOrder(BTC, { quantity: q, type: 1 }).quantity!;
    assert.ok(!/\.\d*0$/.test(out), `${q} -> ${out} still has a trailing zero`);
  }
  assert.equal(normaliseOrder(BTC, { price: '70000.00', type: 1 }).price, '70000');
});

test('a quantity that floors to zero is rejected, not silently sent', () => {
  assert.throws(
    () => normaliseOrder(WLD, { quantity: '0.5', type: 1 }),
    (e: Error) => e instanceof OrderValidationError && /rounds to zero/.test(e.message),
  );
});

test('sub-minimum notional is rejected before a signature is spent', () => {
  assert.throws(
    () => normaliseOrder(BTC, { price: '70000', quantity: '0.00001', type: 1 }),
    (e: Error) => e instanceof OrderValidationError && /notional/.test(e.message),
  );
});

test('a legal order passes untouched', () => {
  const out = normaliseOrder(BTC, { price: '70000', quantity: '0.01', type: 1 });
  assert.deepEqual(out, { price: '70000', quantity: '0.01' });
});

test('maxPrice/maxQuantity of "0" means unbounded, not "reject everything"', () => {
  // Live symbols really do use "0" as a sentinel for "no maximum".
  assert.doesNotThrow(() => normaliseOrder(BTC, { price: '9999999', quantity: '0.01', type: 1 }));
});

test('market orders use the market min/max quantity band', () => {
  assert.doesNotThrow(() => normaliseOrder(BTC, { quantity: '0.001', type: 2 }));
});

test('mulDecimal is exact and sign-correct', () => {
  assert.equal(mulDecimal('70000.5', '0.01'), '700.005');
  assert.equal(mulDecimal('0.1', '0.2'), '0.02'); // 0.1*0.2 is 0.020000000000000004 in float
  assert.equal(mulDecimal('-2.5', '4'), '-10');
  assert.equal(mulDecimal('-2.5', '-4'), '10');
  assert.equal(mulDecimal('0', '123.45'), '0');
  assert.equal(mulDecimal('123', '2'), '246');
});

test('roundToStep never emits exponent notation for tiny ticks', () => {
  const out = roundToStep('0.000000123', '0.00000001', 'floor');
  assert.ok(!out.includes('e'), out);
  assert.equal(out, '0.00000012');
});

test('resolveSymbol by id, name and display name, case-insensitively', () => {
  const list = [BTC, WLD];
  assert.equal(resolveSymbol(list, 24).name, 'WLD-USD');
  assert.equal(resolveSymbol(list, '1').name, 'BTC-USD');
  assert.equal(resolveSymbol(list, 'btc-usd').id, 1);
  assert.throws(() => resolveSymbol(list, 'DOGE-USD'), SymbolNotFoundError);
  assert.throws(() => resolveSymbol(list, 99), SymbolNotFoundError);
});

// --- websocket subscription shaping -----------------------------------------

test('channels are sent in the shape the gateway actually accepts', () => {
  // Empirically verified against testnet; the published docs are wrong for
  // `trade` and `markPrice`, which need arrays.
  assert.deepEqual(normaliseSubParams({ channel: 'trade', symbol: 'BTC-USD' }), {
    channel: 'trade', symbols: ['BTC-USD'],
  });
  assert.deepEqual(normaliseSubParams({ channel: 'markPrice', symbol: 'BTC-USD' }), {
    channel: 'markPrice', symbols: ['BTC-USD'],
  });
  assert.deepEqual(normaliseSubParams({ channel: 'l2Book', symbols: ['BTC-USD'], level: 10 }), {
    channel: 'l2Book', symbol: 'BTC-USD', level: 10,
  });
  assert.deepEqual(normaliseSubParams({ channel: 'candle', symbol: 'BTC-USD', interval: '1m' }), {
    channel: 'candle', symbol: 'BTC-USD', interval: '1m',
  });
  assert.deepEqual(normaliseSubParams({ channel: 'allTicker' }), { channel: 'allTicker' });
});

test('every documented channel has an explicit param style', () => {
  for (const ch of ['trade', 'l2Book', 'candle', 'ticker', 'bookTicker', 'markPrice', 'allTicker', 'allMarkPrice']) {
    assert.ok(CHANNEL_PARAM_STYLE[ch], `${ch} has no param style`);
  }
});

test('symbol and symbols forms collapse to one upstream subscription', () => {
  // Otherwise two panels asking for the same data would open two upstream subs.
  assert.equal(
    subKey({ channel: 'trade', symbol: 'BTC-USD' }),
    subKey({ channel: 'trade', symbols: ['BTC-USD'] }),
  );
  assert.equal(
    subKey({ channel: 'l2Book', symbol: 'BTC-USD', level: 10 }),
    subKey({ channel: 'l2Book', symbols: ['BTC-USD'], level: 10 }),
  );
});

test('different markets never share a subscription key', () => {
  assert.notEqual(subKey({ channel: 'l2Book', symbol: 'BTC-USD' }), subKey({ channel: 'l2Book', symbol: 'ETH-USD' }));
  assert.notEqual(
    subKey({ channel: 'candle', symbol: 'BTC-USD', interval: '1m' }),
    subKey({ channel: 'candle', symbol: 'BTC-USD', interval: '5m' }),
  );
});

test('account channels key on the wallet, ignoring symbol noise', () => {
  assert.deepEqual(normaliseSubParams({ channel: 'accountOrderUpdate', user: '0xAbC' }), {
    channel: 'accountOrderUpdate', user: '0xAbC',
  });
  // Address case must not fragment the key.
  assert.equal(subKey({ channel: 'accountTrade', user: '0xABC' }), subKey({ channel: 'accountTrade', user: '0xabc' }));
  for (const c of ['accountOrderUpdate', 'accountTrade', 'accountUpdate', 'accountState', 'accountEvent']) {
    assert.ok(ACCOUNT_CHANNELS.has(c));
  }
  // Sub-account scoping survives normalisation.
  assert.deepEqual(normaliseSubParams({ channel: 'accountUpdate', user: '0xa', accountID: 7, symbol: 'X' }), {
    channel: 'accountUpdate', user: '0xa', accountID: 7,
  });
});

// --- rate-limit weights ------------------------------------------------------

test('endpoint weights follow the documented table', () => {
  assert.equal(weightFor('/api/v1/perps/markets/symbols'), 2);
  assert.equal(weightFor('/api/v1/perps/markets/tickers'), 2);
  assert.equal(weightFor('/api/v1/perps/markets/BTC-USD/orderbook', 20), 5);
  assert.equal(weightFor('/api/v1/perps/markets/BTC-USD/orderbook', 200), 10);
  assert.equal(weightFor('/api/v1/perps/markets/BTC-USD/klines'), 20);
  assert.equal(weightFor('/api/v1/perps/accounts/0xabc/balances'), 5);
  assert.equal(weightFor('/api/v1/perps/accounts/0xabc/trades', 100), 25);
});

// --- canonical decimal sanity (guards the signing path) ----------------------

test('every value that reaches a signature is exponent-free', () => {
  const nasty = ['1e-7', '1E-12', '0.00000000001', '1e21', '0.4060', '000.5', '-0.000'];
  for (const v of nasty) {
    const c = canonicalDecimal(v);
    assert.ok(!/[eE]/.test(c), `${v} -> ${c}`);
    assert.ok(!/\.\d*0$/.test(c), `${v} -> ${c} has a trailing zero`);
  }
});
