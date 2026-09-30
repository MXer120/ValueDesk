/**
 * The CORRECTED permission model: `permissions` is a DISABLE mask.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_PERMISSION_BITS,
  APIKeyPermission,
  ORDINARY_KEY_MASK,
  ORDINARY_KEY_SCOPE,
  assertPermissionedMask,
  assertRegistrationScope,
  canMoveFunds,
  describeKeyScope,
  disableAllBut,
  disabledPermissions,
  enabledPermissions,
  isPermissionedKeyMask,
  permits,
} from '../src/permissions.ts';

const { TRADE, CANCEL, WITHDRAW, TRANSFER } = APIKeyPermission;

test('bit values are the documented ones', () => {
  assert.deepEqual({ TRADE, CANCEL, WITHDRAW, TRANSFER }, { TRADE: 1, CANCEL: 2, WITHDRAW: 4, TRANSFER: 8 });
  assert.equal(ALL_PERMISSION_BITS, 15);
});

test('a SET bit DISABLES; an absent mask is an ordinary key with EVERYTHING enabled', () => {
  for (const absent of [undefined, null, ORDINARY_KEY_MASK]) {
    assert.equal(permits(absent, TRADE), true);
    assert.equal(permits(absent, WITHDRAW), true, 'an ordinary key CAN withdraw (per docs)');
    assert.equal(canMoveFunds(absent), true);
  }
  assert.deepEqual(enabledPermissions(undefined), ['TRADE', 'CANCEL', 'WITHDRAW', 'TRANSFER']);
  assert.deepEqual(disabledPermissions(3), ['TRADE', 'CANCEL']);
  assert.deepEqual(enabledPermissions(3), ['WITHDRAW', 'TRANSFER']);
});

test('the registrable masks are exactly those that disable TRADE or CANCEL', () => {
  const ok: number[] = [];
  for (let m = 0; m < 16; m++) if (isPermissionedKeyMask(m)) ok.push(m);
  // Every mask with bit 0 or bit 1 set.
  assert.deepEqual(ok, [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15]);
  for (const bad of [0, 4, 8, 12, -1, 16, 1.5, Number.NaN]) {
    assert.equal(isPermissionedKeyMask(bad), false, String(bad));
    assert.throws(() => assertPermissionedMask(bad));
  }
  assert.equal(isPermissionedKeyMask('3'), false, 'strings are not masks');
});

test('"trade + cancel, cannot withdraw" cannot be registered today', () => {
  const wanted = disableAllBut(TRADE | CANCEL); // = WITHDRAW | TRANSFER disabled
  assert.equal(wanted, 12);
  assert.throws(() => assertPermissionedMask(wanted), /must DISABLE TRADE, CANCEL or both/);
});

test('builder XOR permissions', () => {
  assert.doesNotThrow(() => assertRegistrationScope({}));
  assert.doesNotThrow(() => assertRegistrationScope({ builder: { id: 1, fee: 1 } }));
  assert.doesNotThrow(() => assertRegistrationScope({ permissions: 13 }));
  assert.throws(() => assertRegistrationScope({ builder: { id: 1, fee: 1 }, permissions: 13 }), /mutually exclusive/);
  assert.throws(() => assertRegistrationScope({ permissions: 12 }));
});

test('describeKeyScope is honest about the ordinary key and about verification', () => {
  const d = describeKeyScope(undefined);
  assert.equal(d.ordinary, true);
  assert.equal(d.canMoveFunds, true);
  assert.equal(d.verified, false);
  assert.equal(d.summary, ORDINARY_KEY_SCOPE);
  assert.match(ORDINARY_KEY_SCOPE, /per SoDEX docs \(unverified\)/i);
  assert.match(ORDINARY_KEY_SCOPE, /your own EVM wallet/);
  const cancelOnly = describeKeyScope(disableAllBut(CANCEL));
  assert.equal(cancelOnly.canTrade, false);
  assert.equal(cancelOnly.canCancel, true);
  assert.equal(cancelOnly.canMoveFunds, false);
  assert.match(cancelOnly.summary, /unverified/);
  assert.match(describeKeyScope(3).summary, /can move funds/);
});
