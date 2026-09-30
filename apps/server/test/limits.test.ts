/**
 * The keyed fixed-window limiter behind hosted mode's per-client limits, and
 * the local write/money classification it also serves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyedLimiter, classify, reset, take, MONEY_LIMIT, WRITE_LIMIT } from '../src/rateLimit.js';

const L = { max: 3, windowMs: 1_000 };

test('keyed limiter: max per window per key, then the wait in whole seconds', () => {
  const l = new KeyedLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(l.take('a', L, t0 + i), null);
  assert.equal(l.take('a', L, t0 + 10), 1);
  assert.equal(l.take('b', L, t0 + 10), null, 'another key has its own window');
  assert.equal(l.take('a', L, t0 + 1_000), null, 'a new window starts after windowMs');
});

test('keyed limiter: a long wait is reported in whole seconds, never zero', () => {
  const l = new KeyedLimiter();
  const minute = { max: 1, windowMs: 60_000 };
  assert.equal(l.take('k', minute, 0), null);
  assert.equal(l.take('k', minute, 1), 60);
  assert.equal(l.take('k', minute, 59_999), 1);
});

test('keyed limiter: expired windows are swept, so memory follows the live keys', () => {
  const l = new KeyedLimiter(100_000, 1_000);
  for (let i = 0; i < 50; i++) l.take(`k${i}`, L, 0);
  assert.equal(l.size, 50);
  l.take('late', L, 5_000);
  assert.equal(l.size, 1, 'the sweep on the next take dropped every ended window');
});

test('keyed limiter: at the key cap the oldest client is evicted, not the new one refused', () => {
  const l = new KeyedLimiter(3, 60_000);
  const minute = { max: 1, windowMs: 60_000 };
  for (const k of ['a', 'b', 'c']) assert.equal(l.take(k, minute, 10), null);
  assert.equal(l.take('d', minute, 11), null, 'a new client still gets through');
  assert.equal(l.size, 3);
  assert.equal(l.take('a', minute, 12), null, "'a' was the oldest, so it starts a fresh window");
  assert.equal(l.take('c', minute, 13), 60, "'c' kept its window");
});

test('local limits keep their meaning: one shared bucket per class', () => {
  reset();
  for (let i = 0; i < MONEY_LIMIT.max; i++) assert.equal(take('money', MONEY_LIMIT), null);
  assert.ok((take('money', MONEY_LIMIT) ?? 0) > 0);
  assert.equal(take('write', WRITE_LIMIT), null, 'the write bucket is separate');
  reset();
  assert.equal(take('money', MONEY_LIMIT), null, 'reset clears every bucket');
  reset();
});

test('money classification works on the matched route pattern', () => {
  // index.ts now classifies by req.routeOptions.url: the percent-encoded
  // /api/%6Doney/withdraw matches the route /api/money/withdraw.
  assert.deepEqual(classify('/api/money/withdraw').map((c) => c.key), ['write', 'money']);
  assert.deepEqual(classify('/api/%6Doney/withdraw').map((c) => c.key), ['write'], 'the raw path alone would miss it');
});
