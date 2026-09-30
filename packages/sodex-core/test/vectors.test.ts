/**
 * Cross-validation of the TypeScript signer against the OFFICIAL SoDEX Go SDK.
 * Ported from Opentrade/server/test/vectors.test.ts.
 *
 * vectors.json is produced by tools/genvectors.go running against
 * sodex-tech/sodex-go-sdk-public. Every assertion here demands an EXACT match
 * with bytes the reference implementation produced - canonical JSON, payload
 * hash, and final 66-byte wire signature.
 *
 * Regenerate (Valuescan): from packages/sodex-core, `bash tools/genvectors.sh`
 * writes test/vectors-sdk.json; test/vectors.json stays Opentrade's verbatim
 * copy, and vectors-sdk.test.ts proves the SDK still reproduces it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  actionPayloadHash,
  bytesToHex,
  domainSeparator,
  goJSONStringify,
  makeDomain,
  privateKeyToAddress,
  signExchangeAction,
  DomainName,
} from '../src/eip712.ts';
import * as A from '../src/actions.ts';
import { canonicalDecimal, decimalCompare, roundToStep } from '../src/decimal.ts';
import { signPermissionedAPIKey, permissionedAPIKeyDigest } from '../src/userSigned.ts';
import { APIKeyPermission, disableAllBut, permits, isPermissionedKeyMask } from '../src/permissions.ts';
import { PK, V, vec } from './fixtures.ts';

const domainFor = (engine: string) => (engine === 'spot' ? DomainName.spot : DomainName.perps);

/**
 * The core assertion: build `params` with our own builders, then demand that the
 * canonical JSON, payload hash and signature all match the Go SDK exactly.
 */
function assertVector(name: string, params: unknown) {
  const v = vec(V, name);
  assert.equal(goJSONStringify(params), v.bodyJSON, `${name}: body JSON must match Go json.Marshal`);
  assert.equal(
    goJSONStringify({ type: v.actionType, params }),
    v.payloadJSON,
    `${name}: signing payload must match Go`,
  );
  assert.equal(
    bytesToHex(actionPayloadHash(v.actionType, params)),
    v.payloadHash.toLowerCase(),
    `${name}: payloadHash must match Go`,
  );
  assert.equal(
    signExchangeAction(domainFor(v.engine), V.chainID, v.actionType, params, BigInt(v.nonce), PK),
    v.signature.toLowerCase(),
    `${name}: wire signature must match Go`,
  );
}

test('key derivation matches go-ethereum', () => {
  assert.equal(privateKeyToAddress(PK).toLowerCase(), V.address.toLowerCase());
});

test('domain separators match the Go SDK', () => {
  const sep = (n: string, c: number) => bytesToHex(domainSeparator(makeDomain(n, c)));
  assert.equal(sep(DomainName.spot, V.chainID), V.domainSpot.toLowerCase());
  assert.equal(sep(DomainName.perps, V.chainID), V.domainPerps.toLowerCase());
  assert.equal(sep(DomainName.universal, 1), V.domainUniv.toLowerCase());
});

test('signature type bytes match the Go enum', () => {
  assert.equal(V.sigTypeExch, 1);
  assert.equal(V.sigTypeUniv, 2);
});

// ---------------------------------------------------------------------------
// Decimal canonicalisation
// ---------------------------------------------------------------------------

test('canonicalDecimal matches shopspring/decimal String() on every vector', () => {
  for (const [input, expected] of Object.entries(V.decimals)) {
    assert.equal(canonicalDecimal(input), expected, `canonicalDecimal(${JSON.stringify(input)})`);
  }
});

test('canonicalDecimal never emits exponent notation', () => {
  // The failure mode the SoDEX docs' own advice would introduce:
  // parseFloat("0.0000001").toString() === "1e-7", which Go would never produce.
  assert.equal(String(parseFloat('0.0000001')), '1e-7');
  assert.equal(canonicalDecimal('0.0000001'), '0.0000001');
  assert.equal(canonicalDecimal('0.00000000001'), '0.00000000001');
  assert.equal(canonicalDecimal(1e-7), '0.0000001');
  for (const s of ['1e-21', '5e-9', '1.5e-8']) {
    assert.ok(!canonicalDecimal(s).includes('e'), `${s} must not round-trip to exponent form`);
  }
});

test('canonicalDecimal strips the trailing zeros SoDEX rejects', () => {
  assert.equal(canonicalDecimal('0.4060'), '0.406');
  assert.equal(canonicalDecimal('95000.00'), '95000');
  assert.equal(canonicalDecimal('-0.500'), '-0.5');
  assert.equal(canonicalDecimal('0.000'), '0');
  assert.equal(canonicalDecimal('-0'), '0');
});

test('canonicalDecimal rejects junk', () => {
  for (const bad of ['', 'abc', '1.2.3', '0x10', '1,000', 'NaN', 'Infinity']) {
    assert.throws(() => canonicalDecimal(bad), `should reject ${JSON.stringify(bad)}`);
  }
});

test('decimalCompare is exact beyond float precision', () => {
  assert.equal(decimalCompare('0.1', '0.10'), 0);
  assert.equal(decimalCompare('2', '10'), -1);
  assert.equal(decimalCompare('-5', '-10'), 1);
  // Differs only in the 20th significant digit - a float compare would say equal.
  assert.equal(decimalCompare('1.00000000000000000001', '1.00000000000000000002'), -1);
});

test('roundToStep snaps to the tick grid without float error', () => {
  assert.equal(roundToStep('70000.567', '0.1', 'floor'), '70000.5');
  assert.equal(roundToStep('0.15685', '0.0001', 'floor'), '0.1568');
  assert.equal(roundToStep('1.005', '0.01', 'nearest'), '1.01');
  assert.equal(roundToStep('123.456', '1', 'floor'), '123');
});

// ---------------------------------------------------------------------------
// Go-compatible JSON
// ---------------------------------------------------------------------------

test('goJSONStringify escapes HTML like Go encoding/json', () => {
  assert.equal(goJSONStringify({ a: '<&>' }), '{"a":"\\u003c\\u0026\\u003e"}');
});

test('goJSONStringify omits undefined (Go omitempty) but keeps false and 0', () => {
  assert.equal(goJSONStringify({ a: 1, b: undefined, c: false, d: 0 }), '{"a":1,"c":false,"d":0}');
});

test('goJSONStringify refuses non-integer numbers', () => {
  // Decimals must be pre-canonicalised strings; a raw float would silently
  // serialise differently from Go's decimal.
  assert.throws(() => goJSONStringify({ price: 1.5 }), /non-integer/);
});

// ---------------------------------------------------------------------------
// Perps actions
// ---------------------------------------------------------------------------

test('perps limit order', () => {
  assertVector(
    'perps_limit_order',
    A.perpsNewOrder(43933, 1, [
      {
        clOrdID: 'opentrade-limit-1',
        side: A.OrderSide.BUY,
        type: A.OrderType.LIMIT,
        timeInForce: A.TimeInForce.GTC,
        price: '70000.5',
        quantity: '0.01',
      },
    ]),
  );
});

test('perps market order, reduce-only', () => {
  assertVector(
    'perps_market_reduce_only',
    A.perpsNewOrder(43933, 1, [
      {
        clOrdID: 'opentrade-mkt-1',
        side: A.OrderSide.SELL,
        type: A.OrderType.MARKET,
        timeInForce: A.TimeInForce.IOC,
        quantity: '0.001',
        reduceOnly: true,
      },
    ]),
  );
});

test('perps stop-loss carries stopPrice/stopType/triggerType', () => {
  assertVector(
    'perps_stop_loss',
    A.perpsNewOrder(43933, 1, [
      {
        clOrdID: 'opentrade-sl-1',
        side: A.OrderSide.SELL,
        type: A.OrderType.MARKET,
        timeInForce: A.TimeInForce.IOC,
        quantity: '0.5',
        stopPrice: '64000',
        stopType: A.StopType.STOP_LOSS,
        triggerType: A.TriggerType.MARK_PRICE,
        reduceOnly: true,
      },
    ]),
  );
});

test('perps sub-cent price survives canonicalisation', () => {
  assertVector(
    'perps_tiny_price',
    A.perpsNewOrder(43933, 7, [
      {
        clOrdID: 'opentrade-tiny-1',
        side: A.OrderSide.BUY,
        type: A.OrderType.LIMIT,
        timeInForce: A.TimeInForce.GTX,
        price: '0.0000001',
        quantity: '1000000',
      },
    ]),
  );
});

test('perps multi-order batch preserves order', () => {
  assertVector(
    'perps_multi_order',
    A.perpsNewOrder(43933, 2, [
      {
        clOrdID: 'ot-a',
        side: A.OrderSide.BUY,
        type: A.OrderType.LIMIT,
        timeInForce: A.TimeInForce.GTC,
        price: '2500.25',
        quantity: '1.5',
      },
      {
        clOrdID: 'ot-b',
        side: A.OrderSide.SELL,
        type: A.OrderType.LIMIT,
        timeInForce: A.TimeInForce.GTX,
        price: '2600',
        quantity: '0.75',
      },
    ]),
  );
});

test('perps cancel by orderID and by clOrdID', () => {
  assertVector(
    'perps_cancel',
    A.perpsCancelOrder(43933, [
      { symbolID: 1, orderID: 987654321 },
      { symbolID: 2, clOrdID: 'opentrade-limit-1' },
    ]),
  );
});

test('perps modify', () => {
  assertVector(
    'perps_modify',
    A.perpsModifyOrder({
      accountID: 43933,
      symbolID: 1,
      orderID: 987654321,
      price: '71000',
      quantity: '0.02',
    }),
  );
});

test('perps leverage', () => {
  assertVector('perps_leverage', A.perpsUpdateLeverage(43933, 1, 10, A.MarginMode.CROSS));
});

test('perps isolated margin', () => {
  assertVector('perps_margin', A.perpsUpdateMargin(43933, 1, '250.5'));
});

test('perps to spot transfer uses magic account 999', () => {
  assertVector(
    'perps_transfer_to_spot',
    A.transferAsset({
      id: 1,
      fromAccountID: 43933,
      toAccountID: A.CROSS_ENGINE_ACCOUNT_ID,
      coinID: 0,
      amount: '100',
      type: A.TransferType.SPOT_WITHDRAW,
    }),
  );
});

test('schedule cancel (dead-man switch), armed', () => {
  assertVector('perps_schedule_cancel', A.scheduleCancel(43933, 1776000060000));
});

test('schedule cancel, cleared - omits the nil pointer entirely', () => {
  assertVector('perps_schedule_cancel_clear', A.scheduleCancel(43933));
});

test('perps replace', () => {
  assertVector(
    'perps_replace',
    A.replaceOrder(43933, [
      { symbolID: 1, clOrdID: 'ot-replace-1', origOrderID: 987654321, price: '69500' },
    ]),
  );
});

test('revoke API key', () => {
  assertVector('perps_revoke_api_key', A.revokeAPIKey(43933, 'opentrade-key'));
});

// ---------------------------------------------------------------------------
// Spot actions
// ---------------------------------------------------------------------------

test('spot batch new order', () => {
  assertVector(
    'spot_batch_new_order',
    A.spotBatchNewOrder(43933, [
      {
        symbolID: 1,
        clOrdID: 'opentrade-spot-1',
        side: A.OrderSide.BUY,
        type: A.OrderType.LIMIT,
        timeInForce: A.TimeInForce.GTC,
        price: '95000',
        quantity: '0.406',
      },
    ]),
  );
});

test('spot market buy by funds', () => {
  assertVector(
    'spot_market_by_funds',
    A.spotBatchNewOrder(43933, [
      {
        symbolID: 1,
        clOrdID: 'opentrade-spot-funds',
        side: A.OrderSide.BUY,
        type: A.OrderType.MARKET,
        timeInForce: A.TimeInForce.IOC,
        funds: '500',
      },
    ]),
  );
});

test('spot batch cancel', () => {
  assertVector(
    'spot_batch_cancel',
    A.spotBatchCancelOrder(43933, [
      { symbolID: 1, clOrdID: 'ot-cancel-1', orderID: 555 },
      { symbolID: 2, clOrdID: 'ot-cancel-2', origClOrdID: 'opentrade-spot-1' },
    ]),
  );
});

test('spot to perps transfer', () => {
  assertVector(
    'spot_transfer_to_perps',
    A.transferAsset({
      id: 2,
      fromAccountID: 43933,
      toAccountID: A.CROSS_ENGINE_ACCOUNT_ID,
      coinID: 0,
      amount: '42.75',
      type: A.TransferType.PERPS_WITHDRAW,
    }),
  );
});

// ---------------------------------------------------------------------------
// The wallet-signed restricted-API-key flow
// ---------------------------------------------------------------------------

test('user-signed permissioned API key matches the Go SDK', () => {
  const v = vec(V, 'user_signed_add_permissioned_api_key');
  const params = {
    accountID: 43933,
    name: 'opentrade-trading',
    publicKey: '0x1234567890abcdef1234567890abcdef12345678',
    // SECONDS, as Opentrade's early generator used - a fixture only. The live
    // wire unit is MILLISECONDS (keys.ts); registration.ts refuses this value.
    expiresAt: 1800000000,
    // What genvectors.go signed. This test is about digest parity with Go, so
    // the value is just a fixture - it is NOT a mask anyone should mint (3 means
    // TRADE and CANCEL DISABLED; see permissions.ts).
    permissions: 3,
  };

  // The digest the wallet signs.
  assert.equal(
    bytesToHex(permissionedAPIKeyDigest(params, V.chainID, BigInt(v.nonce), 1)),
    v.payloadHash.toLowerCase(),
    'EIP-712 digest must match Go',
  );

  // And the resulting 0x02-prefixed wire signature.
  assert.equal(
    signPermissionedAPIKey(params, V.chainID, BigInt(v.nonce), 1, PK),
    v.signature.toLowerCase(),
    'wire signature must match Go',
  );
});

test('mask 3 - Opentrade\'s old "trade-only" key - really disables TRADE and CANCEL', () => {
  // The inversion this package exists to not repeat: a set bit DISABLES.
  assert.equal(permits(3, APIKeyPermission.TRADE), false);
  assert.equal(permits(3, APIKeyPermission.CANCEL), false);
  assert.equal(permits(3, APIKeyPermission.WITHDRAW), true);
  assert.equal(permits(3, APIKeyPermission.TRANSFER), true);
  // Valid as a permissioned mask (it disables TRADE/CANCEL) - for what it really is.
  assert.equal(isPermissionedKeyMask(3), true);
  // "Trade + cancel, cannot withdraw" = 12 = disables WITHDRAW|TRANSFER only -> NOT registrable.
  assert.equal(disableAllBut(APIKeyPermission.TRADE | APIKeyPermission.CANCEL), 12);
  assert.equal(isPermissionedKeyMask(12), false);
});

test('clOrdID validation matches the gateway regex', () => {
  for (const ok of ['a', 'ot-1', 'A_b-9', 'x'.repeat(36)]) {
    assert.equal(A.assertClOrdID(ok), ok);
  }
  for (const bad of ['', 'x'.repeat(37), 'has space', 'emoji-\u{1F600}', 'dot.dot']) {
    assert.throws(() => A.assertClOrdID(bad), `should reject ${JSON.stringify(bad)}`);
  }
});

test('every generated vector is covered by a test above', () => {
  // Guards against a vector being added to the generator but never asserted.
  const covered = new Set([
    'perps_limit_order', 'perps_market_reduce_only', 'perps_stop_loss', 'perps_tiny_price',
    'perps_multi_order', 'perps_cancel', 'perps_modify', 'perps_leverage', 'perps_margin',
    'perps_transfer_to_spot', 'perps_schedule_cancel', 'perps_schedule_cancel_clear',
    'perps_replace', 'perps_revoke_api_key', 'spot_batch_new_order', 'spot_market_by_funds',
    'spot_batch_cancel', 'spot_transfer_to_perps', 'user_signed_add_permissioned_api_key',
  ]);
  const missing = V.vectors.map((v) => v.name).filter((n) => !covered.has(n));
  assert.deepEqual(missing, [], `uncovered vectors: ${missing.join(', ')}`);
});
