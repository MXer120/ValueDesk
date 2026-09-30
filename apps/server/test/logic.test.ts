/**
 * Tests for the non-signing logic: order validation, WebSocket subscription
 * shaping/routing, and the keystore.
 *
 * (The signing layer is covered separately by vectors.test.ts, which asserts
 * byte equality against the official Go SDK.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normaliseOrder, mulDecimal, OrderValidationError, type Symbol } from '../src/sodex/symbols.js';
import {
  ACCOUNT_CHANNELS,
  CHANNEL_PARAM_STYLE,
  normaliseSubParams,
  routeKeys,
  subKey,
  symbolsIn,
} from '../src/sodex/ws.js';
import { encryptKeystore, decryptKeystore, KeystoreError, load, save, remove, type KeystoreMeta } from '../src/keystore.js';
import { canonicalDecimal, roundToStep } from '../src/decimal.js';
import { weightFor } from '../src/sodex/rest.js';

// A realistic perps symbol, copied from live testnet /markets/symbols.
const BTC: Symbol = {
  id: 1, name: 'BTC-USD', displayName: 'BTC-USD', baseCoin: 'BTC', quoteCoin: 'vUSDC',
  quoteCoinID: 0, pricePrecision: 1, tickSize: '0.1', minPrice: '0.1', maxPrice: '0',
  quantityPrecision: 5, stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000',
  marketMinQuantity: '0.00001', marketMaxQuantity: '1000',
  minNotional: '10', maxNotional: '1000000', makerFee: '0.00012', takerFee: '0.0004',
  status: 'TRADING', maxLeverage: 50,
};

// WLD-USD has integer quantities (stepSize "1") - a good precision edge case.
const WLD: Symbol = {
  ...BTC, id: 24, name: 'WLD-USD', displayName: 'WLD-USD', baseCoin: 'WLD',
  tickSize: '0.0001', minPrice: '0.0001', quantityPrecision: 0, stepSize: '1',
  minQuantity: '1', maxQuantity: '10000000', marketMinQuantity: '1', marketMaxQuantity: '10000000',
  minNotional: '10', maxNotional: '1000000', maxLeverage: 10,
};

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
  assert.notEqual(
    subKey({ channel: 'l2Book', symbol: 'BTC-USD' }),
    subKey({ channel: 'l2Book', symbol: 'ETH-USD' }),
  );
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
  assert.equal(
    subKey({ channel: 'accountTrade', user: '0xABC' }),
    subKey({ channel: 'accountTrade', user: '0xabc' }),
  );
  for (const c of ['accountOrderUpdate', 'accountTrade', 'accountUpdate', 'accountState']) {
    assert.ok(ACCOUNT_CHANNELS.has(c));
  }
});

// --- push routing ------------------------------------------------------------

test('symbols are read from inside the payload, not the envelope', () => {
  // The gateway does NOT echo the subscribed symbol at the top level.
  assert.deepEqual(symbolsIn({ channel: 'l2Book', data: { s: 'BTC-USD' } }), ['BTC-USD']);
  assert.deepEqual(
    symbolsIn({ channel: 'ticker', data: [{ s: 'BTC-USD' }, { s: 'ETH-USD' }, { s: 'BTC-USD' }] }),
    ['BTC-USD', 'ETH-USD'],
  );
  assert.deepEqual(symbolsIn({ channel: 'x', data: null }), []);
});

test('a push routes to the key its own subscription produced', () => {
  const key = subKey({ channel: 'candle', symbol: 'BTC-USD', interval: '1m' });
  const keys = routeKeys({ channel: 'candle', type: 'update', data: { s: 'BTC-USD', i: '1m' } });
  assert.ok(keys.includes(key), `${JSON.stringify(keys)} should include ${key}`);
});

test('an array push routes to every symbol it carries', () => {
  const keys = routeKeys({ channel: 'ticker', type: 'update', data: [{ s: 'BTC-USD' }, { s: 'ETH-USD' }] });
  assert.ok(keys.includes(subKey({ channel: 'ticker', symbols: ['BTC-USD'] })));
  assert.ok(keys.includes(subKey({ channel: 'ticker', symbols: ['ETH-USD'] })));
});

test('account pushes route by user', () => {
  const keys = routeKeys({ channel: 'accountState', type: 'snapshot', data: { user: '0xABC' } });
  assert.deepEqual(keys, [subKey({ channel: 'accountState', user: '0xabc' })]);
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

// --- keystore ----------------------------------------------------------------

const META: KeystoreMeta = {
  apiKeyName: 'valuetrade', accountId: 43933, address: '0x' + 'a'.repeat(40),
  keyAddress: '0x' + 'b'.repeat(40), network: 'testnet', permissions: 3,
  expiresAt: 0, createdAt: 1730000000000,
};

const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

test('keystore round-trips the key', () => {
  const file = encryptKeystore(KEY, 'correct horse battery staple', META);
  assert.equal(decryptKeystore(file, 'correct horse battery staple'), KEY);
});

test('the plaintext key never appears in the keystore file', () => {
  const file = encryptKeystore(KEY, 'pw', META);
  const serialised = JSON.stringify(file);
  assert.ok(!serialised.includes(KEY.slice(2)), 'raw key leaked into the keystore');
  assert.ok(!serialised.toLowerCase().includes(KEY.slice(2).toLowerCase()));
});

test('a wrong passphrase fails closed', () => {
  const file = encryptKeystore(KEY, 'right', META);
  assert.throws(() => decryptKeystore(file, 'wrong'), KeystoreError);
});

test('a tampered ciphertext is rejected by the GCM tag', () => {
  const file = encryptKeystore(KEY, 'pw', META);
  const flipped = file.ciphertext.slice(0, -2) + (file.ciphertext.endsWith('00') ? '11' : '00');
  assert.throws(() => decryptKeystore({ ...file, ciphertext: flipped }, 'pw'), KeystoreError);
});

test('metadata stays readable without the passphrase', () => {
  // The UI shows which key/account is stored before the user unlocks.
  const file = encryptKeystore(KEY, 'pw', META);
  assert.equal(file.meta.apiKeyName, 'valuetrade');
  assert.equal(file.meta.permissions, 3);
});

test('save/load/remove round-trip on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-ks-'));
  const path = join(dir, 'ks.json');
  try {
    assert.equal(load(path), null);
    save(path, encryptKeystore(KEY, 'pw', META));
    const back = load(path);
    assert.ok(back);
    assert.equal(decryptKeystore(back!, 'pw'), KEY);
    remove(path);
    assert.equal(load(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
