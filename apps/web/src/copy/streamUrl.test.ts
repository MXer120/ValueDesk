/**
 * Where the bots page opens its live stream (copy/executor.ts streamUrlOf): in production straight to the instance,
 * not through the site's /api function (2026-11-13: the stream was 95% of that function's billed memory).
 *   npx tsx --test src/copy/streamUrl.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOSTED_BASE, VIP_BASE, streamUrlOf } from './executor';

test('stream: production goes straight to the instance, for the standard and the VIP executor', () => {
  assert.equal(streamUrlOf(HOSTED_BASE, 'https://api.valuedesk.so'), 'https://api.valuedesk.so/api/copy/v1/algos/stream');
  assert.equal(streamUrlOf(VIP_BASE, 'https://api.valuedesk.so/'), 'https://api.valuedesk.so/api/copy-vip/v1/algos/stream');
});

test('stream: no origin set (dev, tests) keeps the site path; a self-hosted executor keeps its own address', () => {
  assert.equal(streamUrlOf(HOSTED_BASE, undefined), '/api/copy/v1/algos/stream');
  assert.equal(streamUrlOf(HOSTED_BASE, '  '), '/api/copy/v1/algos/stream');
  assert.equal(streamUrlOf('http://127.0.0.1:8799/api/copy/v1', 'https://api.valuedesk.so'), 'http://127.0.0.1:8799/api/copy/v1/algos/stream');
});
