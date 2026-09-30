/**
 * Regression tests ported from Opentrade/server/test/regressions.test.ts (the
 * decimal/validation/transport-classification ones - origin checks belong to
 * Opentrade's local server and are not ported), plus envelope parsing.
 *
 * Each test names the bug it locks down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseOrder, OrderValidationError, type SymbolRules } from '../src/symbols.ts';
import { failedOrders, isTransientFailure, parseEnvelope, SodexApiError, unwrapList, weightFor } from '../src/envelope.ts';
import { hexToBytes } from '../src/eip712.ts';
import { BTC } from './fixtures.ts';

// --- finding 8: `funds` was signed with no validation at all ------------------

test('funds must be positive (a negative funds order used to be signed)', () => {
  assert.throws(
    () => normaliseOrder(BTC, { funds: '-500', type: 2 }),
    (e: Error) => e instanceof OrderValidationError && /positive/.test(e.message),
  );
});

test('zero funds is rejected here, because "0" is truthy in the caller guard', () => {
  // routes/trade.ts guards with `!norm.quantity && !norm.funds`. The string "0"
  // is truthy, so a zero-funds order slipped straight through to be signed.
  assert.throws(
    () => normaliseOrder(BTC, { funds: '0', type: 2 }),
    (e: Error) => e instanceof OrderValidationError && /positive/.test(e.message),
  );
});

test('funds above the max notional is rejected', () => {
  assert.throws(
    () => normaliseOrder(BTC, { funds: '9999999', type: 2 }),
    (e: Error) => e instanceof OrderValidationError && /maximum notional/.test(e.message),
  );
});

test('a legal funds order still passes', () => {
  assert.deepEqual(normaliseOrder(BTC, { funds: '500', type: 2 }), { funds: '500' });
});

// --- finding 9: minNotional "0" disabled the maxNotional check too -----------

test('maxNotional is enforced even when minNotional is the "0" sentinel', () => {
  const noMin: SymbolRules = { ...BTC, minNotional: '0', maxNotional: '1000' };
  assert.throws(
    () => normaliseOrder(noMin, { price: '70000', quantity: '1', type: 1 }),
    (e: Error) => e instanceof OrderValidationError && /above the maximum/.test(e.message),
  );
  // ...and a small order is still allowed, since there is genuinely no minimum.
  assert.doesNotThrow(() => normaliseOrder(noMin, { price: '70000', quantity: '0.001', type: 1 }));
});

test('minNotional is still enforced when it is set', () => {
  assert.throws(
    () => normaliseOrder(BTC, { price: '70000', quantity: '0.00001', type: 1 }),
    (e: Error) => e instanceof OrderValidationError && /below the minimum/.test(e.message),
  );
});

// --- absent symbol rules must not throw a raw DecimalError -------------------

test('a symbol payload missing rule fields is treated as unbounded, not a 500', () => {
  const sparse: SymbolRules = { ...BTC };
  for (const k of ['minPrice', 'maxPrice', 'minNotional', 'maxNotional', 'minQuantity', 'maxQuantity', 'marketMinQuantity', 'marketMaxQuantity'] as const) {
    delete sparse[k];
  }
  assert.doesNotThrow(() => normaliseOrder(sparse, { price: '70000', quantity: '0.01', type: 1 }));
});

// --- wave 1: retry safety, envelope disambiguation, weight accounting --------

test('a signed write is never classified as retryable, whatever the failure', () => {
  // Every one of these is a real failure shape a write can hit. None may be
  // replayed: a nonce is one-shot, and "no response" is not evidence the engine
  // did not act - a resend could double-fill.
  for (const [status, code, msg] of [
    [400, -1, 'invalid symbol'],
    [401, -1, 'X-API-Sign is invalid'],
    [403, -1, 'forbidden'],
    [404, -1, 'not found'],
    [422, -1, 'insufficient balance'],
  ] as [number, number, string][]) {
    const err = new SodexApiError(code, msg, status, '/trade/order');
    assert.equal(isTransientFailure(err), false, `${status} ${msg} must not retry`);
  }
});

test('genuinely transient upstream faults are retryable', () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(isTransientFailure(new SodexApiError(-1, 'bad gateway', status, '/x')), true, String(status));
  }
  assert.equal(isTransientFailure(new SodexApiError(429, 'slow down', 429, '/x')), true);
});

test('the HTTP-200 error envelope is retryable but a plain 4xx is not', () => {
  // ~8% of history pages return HTTP 200 whose *body* is an error envelope.
  const envelope = new SodexApiError(
    -1,
    "internal server error: invalid character 'R' looking for beginning of value",
    200,
    '/accounts/0x/trades',
  );
  assert.equal(isTransientFailure(envelope), true);
  assert.equal(isTransientFailure(new SodexApiError(-1, 'invalid symbol', 400, '/accounts/0x/trades')), false);
});

test('funding history is priced at the paged-history weight, not the flat floor', () => {
  // The published reference calls this `funding-history`; the live route is `/fundings`.
  const real = '/api/v1/perps/accounts/0xabc/fundings';
  assert.equal(weightFor(real, 500), 45);
  assert.equal(weightFor(real, 1000), 70);
  assert.equal(weightFor('/api/v1/perps/accounts/0xabc/funding-history', 500), 45);
});

test('the measured weight curve is preserved exactly', () => {
  const p = '/api/v1/perps/accounts/0xabc/orders/history';
  for (const [limit, expected] of [[1, 20], [20, 21], [100, 25], [200, 30], [500, 45], [1000, 70]] as [number, number][]) {
    assert.equal(weightFor(p, limit), expected, `limit ${limit}`);
  }
});

// --- envelope parsing (Opentrade rest.ts `send`) ------------------------------

test('an HTTP-200 error envelope is an error, never an empty page', () => {
  assert.throws(
    () => parseEnvelope(200, '{"code":-1,"error":"internal server error: invalid character \'R\'"}', '/x'),
    (e: Error) => e instanceof SodexApiError && e.httpStatus === 200 && isTransientFailure(e),
  );
  assert.throws(() => parseEnvelope(200, '{"error":"nonce is invalid"}'), SodexApiError);
  assert.throws(() => parseEnvelope(200, '{"something":1}'), SodexApiError, 'no data, no code: not an envelope');
  assert.throws(() => parseEnvelope(502, '<html>bad gateway</html>'), /non-JSON/);
});

test('code 0 is trusted, including with a cosmetic msg:"success" and empty pages', () => {
  assert.deepEqual(parseEnvelope(200, '{"code":0,"data":[],"timestamp":1}'), []);
  assert.deepEqual(parseEnvelope(200, '{"code":0,"msg":"success","data":{"a":1}}'), { a: 1 });
  assert.equal(parseEnvelope(200, ''), undefined, 'bare 2xx ack on some writes');
});

test('hints: a missing key is named as such, not as a signing bug', () => {
  assert.match(new SodexApiError(-1, 'api key not found', 401, '/x').hint!, /no longer registered/);
  assert.match(new SodexApiError(-1, 'nonce is invalid', 400, '/x').hint!, /Nonce/);
});

test('unwrapList handles wrapped and bare lists; failedOrders finds per-order rejects', () => {
  assert.deepEqual(unwrapList({ blockTime: 1, blockHeight: 2, orders: [1, 2] }, 'orders'), [1, 2]);
  assert.deepEqual(unwrapList([3], 'orders'), [3]);
  assert.deepEqual(unwrapList(null, 'orders'), []);
  assert.deepEqual(
    failedOrders([
      { code: 0, clOrdID: 'a', orderID: 1 },
      { code: -1, clOrdID: 'b', error: 'insufficient margin' },
    ]).map((r) => r.clOrdID),
    ['b'],
  );
});

test('hexToBytes refuses non-hex instead of signing over zeros', () => {
  assert.throws(() => hexToBytes('0xzz'), /not a hex string/);
  assert.throws(() => hexToBytes('0x123'), /odd-length/);
});
