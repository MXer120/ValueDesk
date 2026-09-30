/**
 * signAndBuild: the assembled request must carry exactly the Go SDK's bytes
 * (body == bodyJSON, X-API-Sign == signature) and Opentrade's header names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as A from '../src/actions.ts';
import {
  bytesToHex,
  eip712Digest,
  exchangeActionStructHash,
  hexToBytes,
  keccak256,
  makeDomain,
  recoverWireSigner,
  utf8,
} from '../src/eip712.ts';
import { generateTradingKey, tradingKeyFromHex, DAY_MS } from '../src/keys.ts';
import { createMemoryNonceManager, nonceKey } from '../src/nonce.ts';
import {
  HEADER,
  SigningError,
  signAndBuild,
  signAndBuildWithNonceManager,
  signingKeyFrom,
} from '../src/request.ts';
import { PK, S, V, vec } from './fixtures.ts';

const limitOrder = () =>
  A.perpsActions.newOrder(43933, 1, [
    {
      clOrdID: 'opentrade-limit-1',
      side: A.OrderSide.BUY,
      type: A.OrderType.LIMIT,
      timeInForce: A.TimeInForce.GTC,
      price: '70000.5',
      quantity: '0.01',
    },
  ]);

test('perps newOrder: body and X-API-Sign are the Go SDK bytes; headers are Opentrade\'s', () => {
  const v = vec(V, 'perps_limit_order');
  const req = signAndBuild(limitOrder(), { privateKey: PK, name: 'vs-key' }, { chainId: V.chainID, nonce: BigInt(v.nonce), now: v.nonce });
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/sodex/api/v1/perps/trade/orders');
  assert.equal(req.gatewayPath, '/api/v1/perps/trade/orders');
  assert.equal(req.body, v.bodyJSON);
  assert.equal(req.headers['X-API-Sign'], v.signature.toLowerCase());
  assert.equal(req.headers['X-API-Nonce'], String(v.nonce));
  assert.equal(req.headers['X-API-Chain'], String(V.chainID));
  assert.equal(req.headers['X-API-Key'], 'vs-key');
  assert.equal(req.headers['Content-Type'], 'application/json');
  assert.deepEqual(Object.values(HEADER), ['X-API-Key', 'X-API-Sign', 'X-API-Nonce', 'X-API-Chain']);
  assert.equal(req.meta.payloadHash, v.payloadHash.toLowerCase());
  assert.equal(req.meta.signer, V.address.toLowerCase());
});

test('the HTTP body is NOT the signing payload: the signature covers {type, params}', () => {
  const v = vec(V, 'perps_limit_order');
  const req = signAndBuild(limitOrder(), { privateKey: PK, name: 'k' }, { chainId: V.chainID, nonce: BigInt(v.nonce), now: v.nonce });
  assert.notEqual(req.body, v.payloadJSON);
  const payloadHash = keccak256(utf8(v.payloadJSON));
  const digest = eip712Digest(makeDomain('futures', V.chainID), exchangeActionStructHash(payloadHash, BigInt(v.nonce)));
  assert.equal(recoverWireSigner(digest, req.headers['X-API-Sign']!, 1), V.address.toLowerCase());
  // ...and the domain is 'futures' - a 'perps' domain would recover someone else.
  const wrong = eip712Digest(makeDomain('perps', V.chainID), exchangeActionStructHash(payloadHash, BigInt(v.nonce)));
  assert.notEqual(recoverWireSigner(wrong, req.headers['X-API-Sign']!), V.address.toLowerCase());
});

test('every Go vector round-trips through signAndBuild for its engine', () => {
  const builders: Record<string, () => A.SignableAction> = {
    spot_batch_new_order: () =>
      A.spotActions.batchNewOrder(43933, [
        { symbolID: 1, clOrdID: 'opentrade-spot-1', side: 1, type: 1, timeInForce: 1, price: '95000', quantity: '0.406' },
      ]),
    spot_batch_cancel: () =>
      A.spotActions.batchCancelOrder(43933, [
        { symbolID: 1, clOrdID: 'ot-cancel-1', orderID: 555 },
        { symbolID: 2, clOrdID: 'ot-cancel-2', origClOrdID: 'opentrade-spot-1' },
      ]),
    perps_cancel: () =>
      A.perpsActions.cancelOrder(43933, [
        { symbolID: 1, orderID: 987654321 },
        { symbolID: 2, clOrdID: 'opentrade-limit-1' },
      ]),
    perps_leverage: () => A.perpsActions.updateLeverage(43933, 1, 10, A.MarginMode.CROSS),
    perps_schedule_cancel_clear: () => A.perpsActions.scheduleCancel(43933),
    spot_batch_new_order_builder: () =>
      A.spotActions.batchNewOrder(
        43933,
        [{ symbolID: 1, clOrdID: 'vs-spot-builder', side: 2, type: 1, timeInForce: 1, price: '95000', quantity: '0.406' }],
        { id: 456, fee: 1000 },
      ),
    perps_cancel_twap_order: () => A.perpsActions.cancelTwapOrder(43933, 1, 424242),
  };
  const expectPath: Record<string, string> = {
    spot_batch_new_order: 'POST /api/v1/spot/trade/orders/batch',
    spot_batch_cancel: 'DELETE /api/v1/spot/trade/orders/batch',
    perps_cancel: 'DELETE /api/v1/perps/trade/orders',
    perps_leverage: 'POST /api/v1/perps/trade/leverage',
    perps_schedule_cancel_clear: 'POST /api/v1/perps/trade/orders/schedule-cancel',
    spot_batch_new_order_builder: 'POST /api/v1/spot/trade/orders/batch',
    perps_cancel_twap_order: 'DELETE /api/v1/perps/trade/twaps',
  };
  for (const [name, build] of Object.entries(builders)) {
    const v = vec(S, name);
    const req = signAndBuild(build(), { privateKey: PK, name: 'k' }, { chainId: S.chainID, nonce: BigInt(v.nonce), now: v.nonce, base: '' });
    assert.equal(req.body, v.bodyJSON, `${name} body`);
    assert.equal(req.headers['X-API-Sign'], v.signature.toLowerCase(), `${name} signature`);
    assert.equal(`${req.method} ${req.path}`, expectPath[name], `${name} route`);
  }
});

test('master-wallet direct signing omits X-API-Key entirely', () => {
  const v = vec(V, 'perps_limit_order');
  const req = signAndBuild(limitOrder(), { privateKey: PK }, { chainId: V.chainID, nonce: BigInt(v.nonce), now: v.nonce });
  assert.equal('X-API-Key' in req.headers, false);
  assert.throws(() => signAndBuild(limitOrder(), { privateKey: PK, name: '' }, { chainId: V.chainID, nonce: BigInt(v.nonce), now: v.nonce }), SigningError);
});

test('an expired key is refused locally - expiresAt is MILLISECONDS', () => {
  const now = 1_760_000_000_000;
  const ok = { privateKey: PK, name: 'k', expiresAt: now + 60_000 };
  assert.doesNotThrow(() => signAndBuild(limitOrder(), ok, { chainId: 138565, nonce: BigInt(now), now }));
  const expired = { privateKey: PK, name: 'k', expiresAt: now - 1 };
  assert.throws(() => signAndBuild(limitOrder(), expired, { chainId: 138565, nonce: BigInt(now), now }), /expired/);
  // Opentrade's browser signer compared ms against SECONDS, so this never tripped.
  assert.doesNotThrow(() => signAndBuild(limitOrder(), { ...ok, expiresAt: 0 }, { chainId: 138565, nonce: BigInt(now), now }));
});

test('nonces outside (now - 2d, now + 1d) are refused before signing', () => {
  const now = 1_760_000_000_000;
  const key = { privateKey: PK, name: 'k' };
  assert.throws(() => signAndBuild(limitOrder(), key, { chainId: 138565, nonce: BigInt(now - 2 * DAY_MS), now }), /behind/);
  assert.throws(() => signAndBuild(limitOrder(), key, { chainId: 138565, nonce: BigInt(now + DAY_MS), now }), /ahead/);
  assert.throws(() => signAndBuild(limitOrder(), key, { chainId: 0, nonce: BigInt(now), now }), /chainId/);
});

test('actions that do not exist on an engine fail at build time', () => {
  assert.throws(() => A.endpointFor('spot', 'newOrder'), /does not exist on the spot engine/);
  assert.throws(() => A.endpointFor('perps', 'batchNewOrder'), /does not exist/);
  assert.throws(() => A.endpointFor('spot', 'updateLeverage'), /does not exist/);
  assert.equal(A.endpointFor('spot', 'revokeAPIKey').method, 'DELETE');
});

test('batch limits: empty and >100 orders are refused', () => {
  assert.throws(() => A.perpsNewOrder(1, 1, []), /cannot be empty/);
  const many = Array.from({ length: 101 }, (_, i) => ({ clOrdID: `o${i}`, side: 1, type: 1, timeInForce: 1, price: '1', quantity: '1' }));
  assert.throws(() => A.perpsNewOrder(1, 1, many), /at most 100/);
  assert.throws(() => A.perpsCancelOrder(1, [{ symbolID: 1 }]), /orderID or a clOrdID/);
  assert.throws(() => A.perpsNewOrder(-1, 1, many.slice(0, 1)), /non-negative/);
  assert.throws(() => A.perpsNewOrder(2 ** 53, 1, many.slice(0, 1)), /safe integer/);
});

test('signAndBuildWithNonceManager works with a TradingKey (non-enumerable privateKey survives)', async () => {
  let t = 1_760_000_000_000;
  const nonces = createMemoryNonceManager({ now: () => t, sleep: async () => void (t += 1) });
  const tk = generateTradingKey();
  const key = signingKeyFrom(tk, { name: 'vs-test', expiresAt: t + DAY_MS });
  assert.equal(JSON.stringify(key).includes('privateKey'), false);
  const a = await signAndBuildWithNonceManager(limitOrder(), key, { chainId: 138565, nonces, now: t });
  const b = await signAndBuildWithNonceManager(limitOrder(), key, { chainId: 138565, nonces, now: t });
  assert.ok(BigInt(b.meta.nonce) > BigInt(a.meta.nonce));
  assert.equal(a.meta.signer, tk.address);
  assert.equal(nonces.highWater(nonceKey(tk.address, 138565)), BigInt(b.meta.nonce));
  // The request recovers to the trading key.
  const digest = hexToBytes(a.meta.digest);
  assert.equal(recoverWireSigner(digest, a.headers['X-API-Sign']!), tk.address);
});

test('tradingKeyFromHex reproduces the vector signer', () => {
  const tk = tradingKeyFromHex(V.privateKey);
  assert.equal(tk.address, V.address.toLowerCase());
  assert.equal(bytesToHex(tk.privateKey), V.privateKey.toLowerCase());
});
