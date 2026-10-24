import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetReownReportsForTests,
  allowReownReports,
  reownReportsAllowed,
  reownReportsAllowedAt,
  revokeReownReports,
  subscribeReownReports,
} from './reownConsent';

test('Reown\'s usage reports: off until allowed, the first consent\'s time kept, withdrawn at once, listeners told', () => {
  _resetReownReportsForTests();
  assert.equal(reownReportsAllowed(), false, 'nothing is allowed in advance');
  let told = 0;
  const off = subscribeReownReports(() => told++);
  allowReownReports(1_700_000_000_000);
  assert.equal(reownReportsAllowedAt(), 1_700_000_000_000);
  allowReownReports(1_800_000_000_000);
  assert.equal(reownReportsAllowedAt(), 1_700_000_000_000, '"Accept all" again keeps the first consent');
  revokeReownReports();
  assert.equal(reownReportsAllowed(), false);
  assert.equal(told, 3);
  off();
  _resetReownReportsForTests();
});
