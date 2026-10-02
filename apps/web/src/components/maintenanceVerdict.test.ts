import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bannerMessage } from './maintenanceVerdict';

test('banner: silent when healthy, and silent when the status service could not be reached', () => {
  assert.equal(bannerMessage({ maintenance: false, reason: null, status: 'NORMAL' }), null);
  // Unreachable: the server reports status null and maintenance false - that is not an outage.
  assert.equal(bannerMessage({ maintenance: false, reason: null, status: null }), null);
  assert.equal(bannerMessage(null), null);
});

test('banner: says which evidence it has', () => {
  assert.match(bannerMessage({ maintenance: true, reason: 'status', status: 'ALL_MAINTENANCE' })!, /^SoDEX reports maintenance\./);
  assert.match(bannerMessage({ maintenance: true, reason: 'status', status: 'CHAIN_MAINTENANCE' })!, /chain maintenance/);
  // A value never seen before is still a declared, non-normal status.
  assert.match(bannerMessage({ maintenance: true, reason: 'status', status: 'SOMETHING_NEW' })!, /^SoDEX reports maintenance\./);
  assert.match(bannerMessage({ maintenance: true, reason: 'http-503', status: null })!, /HTTP 503/);
});
