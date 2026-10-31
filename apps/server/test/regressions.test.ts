/**
 * Regression tests for defects found by the adversarial review pass.
 *
 * Each test names the bug it locks down. 44 findings were raised across five
 * review dimensions; 12 survived an independent refutation round and were fixed.
 * These cover the ones that are unit-testable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseOrder, OrderValidationError, type Symbol } from '../src/sodex/symbols.js';
import { isAllowedOrigin } from '../src/origin.js';
import { isTransientFailure, weightFor, SodexApiError, SodexClient, WeightBudget } from '../src/sodex/rest.js';
import { GATEWAY_WEIGHT_PER_MIN, reportedRateLimit, unbookedWeight } from '../src/sodex/restCore.js';

const BTC: Symbol = {
  id: 1, name: 'BTC-USD', displayName: 'BTC-USD', baseCoin: 'BTC', quoteCoin: 'vUSDC',
  quoteCoinID: 0, pricePrecision: 1, tickSize: '0.1', minPrice: '0.1', maxPrice: '0',
  quantityPrecision: 5, stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000',
  marketMinQuantity: '0.00001', marketMaxQuantity: '1000',
  minNotional: '10', maxNotional: '1000000', makerFee: '0.00012', takerFee: '0.0004',
  status: 'TRADING', maxLeverage: 50,
};

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
  const noMin: Symbol = { ...BTC, minNotional: '0', maxNotional: '1000' };
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
  const sparse = {
    ...BTC, minPrice: undefined, maxPrice: undefined, minNotional: undefined,
    maxNotional: undefined, minQuantity: undefined, maxQuantity: undefined,
    marketMinQuantity: undefined, marketMaxQuantity: undefined,
  } as unknown as Symbol;
  assert.doesNotThrow(() => normaliseOrder(sparse, { price: '70000', quantity: '0.01', type: 1 }));
});

// --- finding 2: /ws accepted upgrades from any origin ------------------------

test('websocket origin check allows loopback only', () => {
  for (const ok of [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:8787',
    'https://localhost:5173',
  ]) {
    assert.equal(isAllowedOrigin(ok), true, ok);
  }
});

test('websocket origin check rejects any remote page', () => {
  for (const bad of [
    'https://evil.example',
    'http://attacker.test:5173',
    // Substring tricks that a naive `includes("localhost")` would wave through.
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
    'https://notlocalhost',
    'null',
    'file://',
  ]) {
    assert.equal(isAllowedOrigin(bad), false, bad);
  }
});

test('a missing origin is allowed, so native clients still work', () => {
  // curl, the sodex CLI and test scripts send no Origin; browsers always do,
  // and a malicious page cannot suppress it.
  assert.equal(isAllowedOrigin(undefined), true);
});

// --- wave 1: retry safety, envelope disambiguation, weight accounting --------
//
// These lock down the properties that make history paging safe to retry at all.
// The dangerous direction is not "a read failed" - it is "a signed write was
// replayed", so the write-never-retries property is asserted explicitly rather
// than left as a comment.

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
  // Treating that as an empty page silently truncates a history walk and
  // reports a confidently wrong total, which is how a PnL figure ends up wrong.
  const envelope = new SodexApiError(
    -1,
    "internal server error: invalid character 'R' looking for beginning of value",
    200,
    '/accounts/0x/trades',
  );
  assert.equal(isTransientFailure(envelope), true);

  // Same shape, but a real client error - must stay fatal.
  assert.equal(
    isTransientFailure(new SodexApiError(-1, 'invalid symbol', 400, '/accounts/0x/trades')),
    false,
  );
});

test('funding history is priced at the paged-history weight, not the flat floor', () => {
  // The published reference calls this `funding-history`; the live route is
  // `/fundings`. While the weight regex only knew the documented spelling, a
  // limit=500 funding page was billed 5 instead of 45 and quietly overdrew the
  // shared per-minute budget.
  const real = '/api/v1/perps/accounts/0xabc/fundings';
  assert.equal(weightFor(real, 500), 45);
  assert.equal(weightFor(real, 1000), 70);
  // The documented spelling still resolves, in case the gateway ever honours it.
  assert.equal(weightFor('/api/v1/perps/accounts/0xabc/funding-history', 500), 45);
});

test('the measured weight curve is preserved exactly', () => {
  // Measured against the live gateway at nine points. If this drifts, the
  // budget silently stops matching what the venue actually charges.
  const p = '/api/v1/perps/accounts/0xabc/orders/history';
  for (const [limit, expected] of [[1, 20], [20, 21], [100, 25], [200, 30], [500, 45], [1000, 70]] as [number, number][]) {
    assert.equal(weightFor(p, limit), expected, `limit ${limit}`);
  }
});

// --- the gateway's reported rate limit (x-ratelimit-*, 6000/min on 2026-10-31) --

const hdrs = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()] ?? null;

test('the reported limit is read only as an integer in 600..60000; remaining only within it', () => {
  assert.deepEqual(reportedRateLimit(hdrs({ 'x-ratelimit-limit': '6000', 'x-ratelimit-remaining': '5995' })), { limit: 6000, remaining: 5995 });
  assert.deepEqual(reportedRateLimit(hdrs({ 'x-ratelimit-limit': '6000', 'x-ratelimit-remaining': '6001' })), { limit: 6000, remaining: null });
  assert.deepEqual(reportedRateLimit(hdrs({ 'x-ratelimit-limit': '6000' })), { limit: 6000, remaining: null });
  for (const v of ['599', '60001', '0', '-1', '6000.5', '6e3', 'x', '']) assert.equal(reportedRateLimit(hdrs({ 'x-ratelimit-limit': v })), null, `'${v}'`);
  assert.equal(reportedRateLimit(undefined), null);
  assert.equal(unbookedWeight({ limit: 6000, remaining: 5000 }, 100), 900);
  assert.equal(unbookedWeight({ limit: 6000, remaining: 5000 }, 1500), 0, 'never negative: nothing is freed');
  assert.equal(unbookedWeight({ limit: 6000, remaining: 0 }, 0), 6000, 'never beyond the limit');
  assert.equal(unbookedWeight({ limit: 6000, remaining: null }, 0), 0);
});

test('the server budget adopts the reported limit, ignores a broken one, and books what others on the IP spent', async () => {
  const b = new WeightBudget();
  assert.equal(b.perMinute, GATEWAY_WEIGHT_PER_MIN);
  b.learn(hdrs({ 'x-ratelimit-limit': '70000', 'x-ratelimit-remaining': '0' }));
  assert.equal(b.perMinute, 1200);
  assert.equal(b.spent(), 0);
  b.learn(hdrs({ 'x-ratelimit-limit': '6000' }));
  assert.equal(b.perMinute, 6000);
  // 1500 fits now; it would have waited under 1200.
  await b.take(1500);
  b.learn(hdrs({ 'x-ratelimit-limit': '6000', 'x-ratelimit-remaining': '4000' })); // 2000 spent, 1500 ours
  assert.equal(b.spent(), 2000);
  b.learn(hdrs({ 'x-ratelimit-limit': '6000', 'x-ratelimit-remaining': '0' }));
  assert.equal(b.spent(), 6000, 'booked up to the limit, not beyond');
});

test('the server client learns the limit from an answer; a 429 still opens the cooldown', async () => {
  const real = globalThis.fetch;
  let status = 200;
  globalThis.fetch = (async () =>
    new Response(status === 200 ? JSON.stringify({ code: 0, data: [] }) : 'error code: 1015', {
      status,
      headers: { 'x-ratelimit-limit': '6000', 'x-ratelimit-remaining': status === 200 ? '5998' : '0' },
    })) as typeof globalThis.fetch;
  try {
    const c = new SodexClient('https://test.invalid', 1);
    assert.equal(c.weightLimit(), 1200);
    await c.get('/api/v1/perps/accounts/0xabc/state');
    assert.equal(c.weightLimit(), 6000);
    assert.equal(c.weightSpent(), 5, 'our 5 and nobody else: nothing booked');
    status = 429;
    await assert.rejects(c.get('/api/v1/perps/accounts/0xdef/orders'), (e: unknown) => e instanceof SodexApiError && e.httpStatus === 429);
    assert.ok(c.cooldownLeft('/api/v1/perps/accounts/0xdef/orders') > 10_000);
    assert.equal(c.weightLimit(), 6000);
  } finally {
    globalThis.fetch = real;
  }
});
