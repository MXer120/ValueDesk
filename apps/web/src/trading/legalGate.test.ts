import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderSide, type SignableAction } from '@sodex-core';
import { siteAccess } from '../legal/jurisdictions.mjs';
import { isOpening, legalRefusal, type LegalState } from './legalGate';

const act = (engine: 'spot' | 'perps', type: string, params: object = {}): SignableAction => ({ engine, type, params } as SignableAction);
const perps = (...legs: Array<{ reduceOnly?: boolean; side?: number }>) => act('perps', 'newOrder', { orders: legs.map((l) => ({ side: OrderSide.BUY, ...l })) });
const spot = (...sides: number[]) => act('spot', 'batchNewOrder', { orders: sides.map((side) => ({ side })) });

const OPEN: LegalState = { access: siteAccess(), signed: true };
const UNSIGNED: LegalState = { access: siteAccess({ country: 'DE' }), signed: false };
const US: LegalState = { access: siteAccess({ country: 'US' }), signed: true };
const DECLARED_US: LegalState = { access: siteAccess({ country: 'DE', declared: 'US' }), signed: true };
const BLOCKED: LegalState = { access: siteAccess({ country: 'IR' }), signed: true };

const OPENING = [
  perps({}),
  perps({ reduceOnly: true }, { reduceOnly: false }),
  perps({ side: OrderSide.SELL }),
  act('perps', 'batchNewOrder', { orders: [] }),
  act('perps', 'newOrder', {}),
  spot(OrderSide.BUY),
  spot(OrderSide.SELL, OrderSide.BUY),
  act('perps', 'newTwapOrder'),
  act('perps', 'modifyOrder'),
  act('spot', 'replaceOrder'),
];
const NOT_OPENING = [
  perps({ reduceOnly: true }),
  perps({ reduceOnly: true, side: OrderSide.SELL }, { reduceOnly: true }),
  spot(OrderSide.SELL),
  act('perps', 'cancelOrder'),
  act('spot', 'batchCancelOrder'),
  act('perps', 'cancelTwapOrder'),
  act('perps', 'scheduleCancel'),
  act('perps', 'updateLeverage'),
  act('perps', 'updateMargin'),
  act('spot', 'transferAsset'),
  act('perps', 'revokeAPIKey'),
];

test('what opens or increases a position, and what only closes, cancels or moves funds', () => {
  for (const a of OPENING) assert.equal(isOpening(a), true, `${a.engine} ${a.type} ${JSON.stringify(a.params)}`);
  for (const a of NOT_OPENING) assert.equal(isOpening(a), false, `${a.engine} ${a.type} ${JSON.stringify(a.params)}`);
});

test('open and signed: everything is signed', () => {
  for (const a of [...OPENING, ...NOT_OPENING]) assert.equal(legalRefusal(a, OPEN), null);
});

test('close-only (seen in, or declared from, the US) and terms not signed: nothing opening; closing, cancelling and withdrawing still work', () => {
  for (const state of [US, DECLARED_US, UNSIGNED]) {
    for (const a of OPENING) assert.ok(legalRefusal(a, state), `${a.type} must be refused`);
    for (const a of NOT_OPENING) assert.equal(legalRefusal(a, state), null, `${a.type} must stay possible`);
  }
  assert.match(legalRefusal(perps({}), US)!, /United States/);
  assert.match(legalRefusal(perps({}), UNSIGNED)!, /Accept the current Terms of use/);
});

test('a sanctioned place: nothing at all is signed', () => {
  for (const a of [...OPENING, ...NOT_OPENING]) assert.match(legalRefusal(a, BLOCKED)!, /not available in Iran/);
});
