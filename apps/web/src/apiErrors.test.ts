/**
 * How an exchange failure reaches a panel (api.ts toApiError): the status a
 * panel decides on. A 4xx means "retrying cannot help" to the chart
 * (chart/feedHealth.ts isFatalStatus), so only SoDEX's definite refusals may
 * be one - not its bad moments.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SodexApiError } from '@sodex-core';
import { isFatalStatus } from './chart/feedHealth';
import { toApiError } from './api';
import { RateLimitedError, UnreachableError } from './exchange/errors';

const path = '/api/v1/perps/markets/BTC-USD/klines?interval=1m&limit=300';

test('api errors: an HTTP 200 "internal error" envelope that outlived the retries is a 503 - the chart keeps retrying', () => {
  const e = toApiError(new SodexApiError(-1, "internal server error: invalid character 'R' looking for beginning of value", 200, path));
  assert.equal(e.status, 503);
  assert.equal(isFatalStatus(e), false);
  assert.equal(toApiError(new SodexApiError(-1, 'service unavailable', 200, path)).status, 503);
});

test('api errors: a definite refusal stays a 4xx, a rate limit a 429', () => {
  // As the gateway answers an unknown market (measured 2026-10-29: HTTP 200, code -1).
  const unknown = toApiError(new SodexApiError(-1, 'symbol not found', 200, path));
  assert.equal(unknown.status, 400);
  assert.equal(isFatalStatus(unknown), true);
  assert.equal(toApiError(new SodexApiError(400, 'bad symbol', 400, path)).status, 400);
  assert.equal(toApiError(new SodexApiError(429, 'too many requests', 200, path)).status, 429);
  assert.equal(toApiError(new SodexApiError(-1, 'upstream down', 503, path)).status, 503);
  assert.equal(toApiError(new RateLimitedError('mainnet-gw.sodex.dev', 15_000)).status, 429);
  assert.equal(toApiError(new UnreachableError('mainnet-gw.sodex.dev', false)).status, 0);
});
