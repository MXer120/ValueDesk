import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filledFraction, formatPct, normaliseStatus, orderStatusInfo, statusTitle } from './orderStatus';

const kind = (o: Parameters<typeof orderStatusInfo>[0]) => orderStatusInfo(o).kind;

test('every status SoDEX documents, as REST strings and as stream integers', () => {
  assert.equal(kind({ status: 'NEW', executedQty: '0', origQty: '1' }), 'open');
  assert.equal(kind({ status: 1, executedQty: '0', origQty: '1' }), 'open');
  assert.equal(kind({ status: 'PARTIALLY_FILLED', executedQty: '0.4', origQty: '1' }), 'partial');
  assert.equal(kind({ status: 2 }), 'partial');
  assert.equal(kind({ status: 'FILLED', executedQty: '1', origQty: '1' }), 'filled');
  assert.equal(kind({ status: 3 }), 'filled');
  assert.equal(kind({ status: 'CANCELED', executedQty: '0', origQty: '1' }), 'cancelled');
  assert.equal(kind({ status: 4 }), 'cancelled');
  assert.equal(kind({ status: 'REJECTED' }), 'rejected');
  assert.equal(kind({ status: 5 }), 'rejected');
  assert.equal(kind({ status: 'EXPIRED', executedQty: '0', origQty: '5' }), 'expired');
  assert.equal(kind({ status: 6 }), 'expired');
  assert.equal(kind({ status: 'TRIGGERED' }), 'triggered');
  assert.equal(kind({ status: 10 }), 'triggered');
});

test('the older stream codes never fall through to unknown', () => {
  assert.equal(kind({ status: 7 }), 'pending');
  assert.equal(kind({ status: 8 }), 'pending-cancel');
  assert.equal(orderStatusInfo({ status: 9 }).label, 'Pending modify');
  assert.equal(kind({ status: 11 }), 'replaced');
  assert.equal(orderStatusInfo({ status: 12 }).label, 'Pending replace');
  assert.equal(kind({ status: 'pending cancel' }), 'pending-cancel');
  assert.equal(kind({ status: 'SOMETHING_NEW' }), 'unknown');
  assert.equal(orderStatusInfo({ status: 'SOMETHING_NEW' }).label, 'Something new');
});

test('a cancelled or expired order that had filled keeps its fill', () => {
  const c = orderStatusInfo({ status: 'CANCELED', executedQty: '0.37', origQty: '1' });
  assert.equal(c.kind, 'partial-ended');
  assert.equal(c.label, 'Partially filled · cancelled');
  assert.equal(c.filled, 0.37);
  const e = orderStatusInfo({ status: 'EXPIRED', executedQty: '50', origQty: '200' });
  assert.equal(e.kind, 'partial-ended');
  assert.equal(e.label, 'Partially filled · expired');
  assert.equal(e.filled, 0.25);
});

test('an IOC that expired with nothing filled is the alert, in red', () => {
  const e = orderStatusInfo({ status: 'EXPIRED', executedQty: '0', origQty: '5.11' });
  assert.equal(e.kind, 'expired');
  assert.equal(e.tone, 'neg');
});

test('an open stop waiting for its trigger is untriggered, not open', () => {
  assert.equal(kind({ status: 'NEW', executedQty: '0', origQty: '5', stopPrice: '64.5' }), 'untriggered');
  assert.equal(kind({ status: 'NEW', stopType: 'TAKE_PROFIT' }), 'untriggered');
  assert.equal(kind({ status: 'NEW', executedQty: '0', origQty: '5', stopPrice: '0' }), 'open');
  // NEW that has already filled some is a partial, whatever the status word says.
  assert.equal(kind({ status: 'NEW', executedQty: '1', origQty: '5' }), 'partial');
});

test('the pie is the exact executed / original fraction', () => {
  assert.equal(filledFraction('0.37', '1'), 0.37);
  assert.ok(Math.abs(filledFraction('0.0185', '0.05')! - 0.37) < 1e-12);
  assert.equal(filledFraction('2', '1'), 1, 'clamped');
  assert.equal(filledFraction('1', '0'), null);
  assert.equal(filledFraction(undefined, '1'), null);
});

test('normalising the spellings', () => {
  assert.equal(normaliseStatus('partially_filled'), 'PARTIALLY_FILLED');
  assert.equal(normaliseStatus('Cancelled'), 'CANCELED');
  assert.equal(normaliseStatus('3'), 'FILLED');
  assert.equal(normaliseStatus(undefined), '');
});

test('the tooltip states the status and the filled amount', () => {
  const i = orderStatusInfo({ status: 'CANCELED', executedQty: '0.37', origQty: '1' });
  assert.equal(statusTitle(i, '0.37', '1.00', 'ETH'), 'Partially filled · cancelled - filled 0.37 of 1.00 ETH (37%)');
  assert.equal(statusTitle(orderStatusInfo({ status: 'REJECTED' }), null, null), 'Rejected');
  assert.equal(formatPct(0.0012), '0.12%');
  assert.equal(formatPct(0.055), '5.5%');
  assert.equal(formatPct(1), '100%');
});
