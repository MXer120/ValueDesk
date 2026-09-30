/**
 * Key lifecycle: prepare (typed data + unsigned request) -> wallet signs ->
 * assemble. The "wallet" here is the SDK's throwaway test key signing the
 * prepared typed data exactly as eth_signTypedData_v4 would (65 bytes, v 27/28).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bytesToHex, hashTypedData, hexToBytes, signDigest, type TypedData } from '../src/eip712.ts';
import { generateTradingKey, DAY_MS } from '../src/keys.ts';
import {
  assembleExchangeRequests,
  assembleWalletSignedRequest,
  prepareApiKeyRegistration,
  prepareApiKeyRegistrationExchange,
  prepareApiKeyRevocationExchange,
  prepareApiKeyRevocation,
  prepareApiKeyRevocationBothEngines,
  prepareBuilderFeeApproval,
  prepareEngineApiKeyRegistration,
} from '../src/registration.ts';
import { PermissionMaskError } from '../src/permissions.ts';
import { PK, S, V, uvec, vec } from './fixtures.ts';

const USER = V.address.toLowerCase();
const KEY_ADDR = '0x3d4595c8742d0a58173a9963c05755b59a8f8256';

/** What a browser wallet returns for eth_signTypedData_v4: r||s||v with v in {27, 28}. */
function walletSign(td: TypedData, pk: Uint8Array = PK): string {
  const wire = signDigest(hashTypedData(td), pk, 0);
  const raw = wire.slice(1);
  raw[64] = raw[64]! + 27;
  return bytesToHex(raw);
}

test('ordinary key via AddAPIKey: digest, body and assembled request', () => {
  const u = uvec('user_add_api_key');
  const p = prepareApiKeyRegistration({
    userAddress: USER,
    accountID: 43933,
    name: 'vs-trading-1',
    publicKey: KEY_ADDR,
    expiresAt: 1760186400000,
    nonce: BigInt(u.nonce),
    sodexChainId: 138565,
    now: u.nonce,
  });
  assert.equal(p.kind, 'addAPIKey');
  assert.equal(p.route, 'user');
  assert.equal(p.confidence, 'documented');
  assert.equal(p.digest, u.digest.toLowerCase());
  assert.equal(p.request.method, 'POST');
  assert.equal(p.request.gatewayPath, `/api/v1/user/${USER}/api-keys`);
  assert.equal(
    p.request.body,
    `{"accountID":43933,"name":"vs-trading-1","type":1,"publicKey":"${KEY_ADDR}","expiresAt":1760186400000}`,
  );
  assert.equal(p.request.headers['X-API-Chain'], '138565');
  assert.equal(p.request.headers['X-API-Nonce'], String(u.nonce));
  assert.equal('X-API-Key' in p.request.headers, false, 'wallet-signed: no API key header');
  assert.ok(p.caveats.some((c) => /move funds/.test(c) && /Unverified/i.test(c)));

  const req = assembleWalletSignedRequest(p, walletSign(p.typedData));
  assert.equal(req.headers['X-API-Sign'], u.signature.toLowerCase(), 'v normalised, 0x02 prefix, == Go');
  assert.equal(req.path, `/sodex/api/v1/user/${USER}/api-keys`);
  // The typed data survives the JSON round trip a wallet call implies.
  assert.equal(bytesToHex(hashTypedData(JSON.parse(JSON.stringify(p.typedData)))), p.digest);
});

test('ordinary key + builder via AddAPIKeyWithBuilder: ONE signature, domain = wallet chain', () => {
  const u = uvec('user_add_api_key_with_builder_wallet_chain_1');
  const p = prepareApiKeyRegistration({
    userAddress: USER,
    accountID: 43933,
    name: 'vs-trading-2',
    publicKey: KEY_ADDR,
    expiresAt: 1760186400000,
    builder: { id: 456, maxFeeRate: 50 },
    nonce: BigInt(u.nonce),
    sodexChainId: 138565,
    signatureChainId: 1,
    now: u.nonce,
  });
  assert.equal(p.kind, 'addAPIKeyWithBuilder');
  assert.equal(p.digest, u.digest.toLowerCase());
  assert.equal(p.request.headers['X-API-Chain'], '1', 'X-API-Chain == domain chainId (wallet chain)');
  assert.ok(p.request.body.endsWith(',"builder":{"id":456,"fee":50}}'), p.request.body);
  const req = assembleWalletSignedRequest(p, walletSign(p.typedData));
  assert.equal(req.headers['X-API-Sign'], u.signature.toLowerCase());
});

test('builder and permissions are mutually exclusive; permissions must disable TRADE or CANCEL', () => {
  const base = {
    userAddress: USER,
    accountID: 43933,
    name: 'vs-k',
    publicKey: KEY_ADDR,
    expiresAt: 1760186400000,
    nonce: 1760100000000n,
    sodexChainId: 138565,
    now: 1760100000000,
  };
  assert.throws(() => prepareApiKeyRegistration({ ...base, builder: { id: 1, maxFeeRate: 1 }, permissions: 3 }), /mutually exclusive/);
  // 12 = WITHDRAW|TRANSFER disabled = "trade+cancel only" - NOT creatable today.
  assert.throws(() => prepareApiKeyRegistration({ ...base, permissions: 12 }), PermissionMaskError);
  assert.throws(() => prepareApiKeyRegistration({ ...base, permissions: 0 }), /must DISABLE TRADE, CANCEL or both/);
  assert.throws(() => prepareApiKeyRegistration({ ...base, permissions: 16 }), /only use bits/);
  const p = prepareApiKeyRegistration({ ...base, permissions: 13 }); // cancel-only key
  assert.equal(p.kind, 'addPermissionedAPIKey');
  assert.ok(p.request.body.endsWith(',"permissions":13}'));
  assert.equal(p.typedData.primaryType, 'UserSignedAddPermissionedAPIKeyAction');
});

test('registration guards: separate key, key name, short MILLISECOND expiry, fee range', () => {
  const base = {
    userAddress: USER,
    accountID: 43933,
    name: 'vs-k',
    publicKey: KEY_ADDR,
    expiresAt: 1760100000000 + DAY_MS,
    nonce: 1760100000000n,
    sodexChainId: 138565,
    now: 1760100000000,
  };
  assert.throws(() => prepareApiKeyRegistration({ ...base, publicKey: USER }), /separate key/);
  assert.throws(() => prepareApiKeyRegistration({ ...base, name: 'default' }), /reserved/);
  assert.throws(() => prepareApiKeyRegistration({ ...base, name: 'bad name' }), /must match/);
  assert.throws(() => prepareApiKeyRegistration({ ...base, expiresAt: 0 }), /never expires/);
  // Opentrade's early fixture used SECONDS (1800000000). Refused.
  assert.throws(() => prepareApiKeyRegistration({ ...base, expiresAt: 1800000000 }), /SECONDS/);
  assert.throws(() => prepareApiKeyRegistration({ ...base, expiresAt: base.now + 30 * DAY_MS }), /more than 7 days/);
  assert.doesNotThrow(() =>
    prepareApiKeyRegistration({ ...base, expiresAt: base.now + 30 * DAY_MS, expiryPolicy: { maxTtlMs: 31 * DAY_MS } }),
  );
  assert.throws(() => prepareApiKeyRegistration({ ...base, builder: { id: 1, maxFeeRate: 2001 } }), /0\.\.2000/);
  assert.throws(() => prepareApiKeyRegistration({ ...base, builder: { id: 0, maxFeeRate: 10 } }), /non-zero/);
  assert.throws(() => prepareApiKeyRegistration({ ...base, sodexChainId: 1 }), /not a SoDEX chain id/);
  assert.throws(() => prepareApiKeyRegistration({ ...base, nonce: 1n }), /behind/);
});

test('a signature from the wrong wallet account is refused at assembly', () => {
  const u = uvec('user_add_api_key');
  const p = prepareApiKeyRegistration({
    userAddress: USER,
    accountID: 43933,
    name: 'vs-trading-1',
    publicKey: KEY_ADDR,
    expiresAt: 1760186400000,
    nonce: BigInt(u.nonce),
    sodexChainId: 138565,
    now: u.nonce,
  });
  const other = generateTradingKey();
  assert.throws(() => assembleWalletSignedRequest(p, walletSign(p.typedData, other.privateKey)), /must be signed by the account owner/);
  assert.throws(() => assembleWalletSignedRequest(p, '0x1234'), /65-byte/);
});

test('standalone builder approval (and clearing with maxFeeRate 0)', () => {
  for (const name of ['user_approve_builder_fee', 'user_approve_builder_fee_clear']) {
    const u = uvec(name);
    const p = prepareBuilderFeeApproval({
      userAddress: USER,
      accountID: 43933,
      builderID: 456,
      maxFeeRate: Number(u.message['maxFeeRate']),
      nonce: BigInt(u.nonce),
      sodexChainId: 138565,
      signatureChainId: 1,
      now: u.nonce,
    });
    assert.equal(p.digest, u.digest.toLowerCase());
    assert.equal(p.request.gatewayPath, `/api/v1/user/${USER}/builders`);
    assert.equal(p.request.body, `{"accountID":43933,"builderID":456,"maxFeeRate":${u.message['maxFeeRate']}}`);
    const req = assembleWalletSignedRequest(p, walletSign(p.typedData));
    assert.equal(req.headers['X-API-Sign'], u.signature.toLowerCase());
  }
});

test("Opentrade's engine-route registration: permissioned only, one engine, legacy headers", () => {
  const v = vec(V, 'user_signed_add_permissioned_api_key');
  // Same typed data Opentrade's vector pins; ms expiry here because the policy
  // refuses seconds. The digest is checked against an independent recompute.
  const p = prepareEngineApiKeyRegistration({
    engine: 'spot',
    userAddress: USER,
    accountID: 43933,
    name: 'opentrade-trading',
    publicKey: '0x1234567890abcdef1234567890abcdef12345678',
    expiresAt: v.nonce + DAY_MS,
    permissions: 3,
    nonce: BigInt(v.nonce),
    sodexChainId: 138565,
    signatureChainId: 1,
    now: v.nonce,
  });
  assert.equal(p.route, 'engine');
  assert.equal(p.confidence, 'opentrade-legacy');
  assert.equal(p.request.gatewayPath, '/api/v1/spot/accounts/api-keys');
  assert.equal(p.request.headers['X-API-Chain'], '138565', 'Opentrade relays the SoDEX chain id');
  assert.equal(p.typedData.domain.chainId, 1);
  assert.ok(p.caveats.some((c) => /ONE engine/.test(c)));
  assert.ok(p.caveats.some((c) => /must be equal|required them|require them/.test(c)));
  assert.throws(() => prepareEngineApiKeyRegistration({ ...{
    engine: 'perps' as const, userAddress: USER, accountID: 1, name: 'x', publicKey: KEY_ADDR,
    expiresAt: v.nonce + DAY_MS, nonce: BigInt(v.nonce), sodexChainId: 138565, now: v.nonce,
  }, permissions: 12 }), PermissionMaskError);
  const req = assembleWalletSignedRequest(p, walletSign(p.typedData));
  assert.equal(req.headers['X-API-Sign']!.slice(0, 4), '0x02');
});

test('documented revocation: DELETE per engine, master wallet, engine domain 0x01 == Go bytes', () => {
  const pv = vec(V, 'perps_revoke_api_key');
  const p = prepareApiKeyRevocation({
    route: 'engine-delete',
    engine: 'perps',
    userAddress: USER,
    accountID: 43933,
    name: 'opentrade-key',
    nonce: BigInt(pv.nonce),
    sodexChainId: 138565,
    now: pv.nonce,
  });
  assert.equal(p.confidence, 'documented');
  assert.equal(p.request.method, 'DELETE');
  assert.equal(p.request.gatewayPath, '/api/v1/perps/accounts/api-keys');
  assert.equal(p.request.body, pv.bodyJSON);
  assert.equal(p.typedData.domain.name, 'futures');
  assert.equal(p.typedData.message['payloadHash'], pv.payloadHash.toLowerCase());
  const req = assembleWalletSignedRequest(p, walletSign(p.typedData));
  assert.equal(req.headers['X-API-Sign'], pv.signature.toLowerCase(), 'master-signed revoke == Go SignRevokeAPIKeyRequest');
  assert.equal('X-API-Key' in req.headers, false);

  const sv = vec(S, 'spot_revoke_api_key');
  const [spot, perps] = prepareApiKeyRevocationBothEngines({
    userAddress: USER, accountID: 43933, name: 'vs-key-1', nonces: [BigInt(sv.nonce), BigInt(sv.nonce) + 7n],
    sodexChainId: 138565, now: sv.nonce,
  });
  assert.equal(spot.request.gatewayPath, '/api/v1/spot/accounts/api-keys');
  assert.equal(perps.request.gatewayPath, '/api/v1/perps/accounts/api-keys');
  assert.equal(BigInt(perps.nonce), BigInt(sv.nonce) + 7n);
  assert.throws(
    () => prepareApiKeyRevocationBothEngines({ userAddress: USER, accountID: 1, name: 'k', nonces: [5n, 5n], sodexChainId: 138565 }),
    /distinct nonces/,
  );
  assert.equal(assembleWalletSignedRequest(spot, walletSign(spot.typedData)).headers['X-API-Sign'], sv.signature.toLowerCase());
});

test('the undocumented revocation routes are labelled as such', () => {
  const u = uvec('user_revoke_api_key_universal');
  const py = prepareApiKeyRevocation({
    route: 'user-delete-universal',
    userAddress: USER, accountID: 43933, name: 'vs-key-1', nonce: BigInt(u.nonce), sodexChainId: 138565, now: u.nonce,
  });
  assert.equal(py.confidence, 'python-sdk');
  assert.equal(py.request.gatewayPath, `/api/v1/user/${USER}/api-keys`);
  assert.equal(py.digest, u.digest.toLowerCase());
  assert.equal(assembleWalletSignedRequest(py, walletSign(py.typedData)).headers['X-API-Sign'], u.signature.toLowerCase());
  assert.ok(py.caveats.some((c) => /UNVERIFIED/.test(c)));

  const ot = prepareApiKeyRevocation({
    route: 'engine-post-revoke', engine: 'spot',
    userAddress: USER, accountID: 43933, name: 'vs-key-1', nonce: BigInt(u.nonce), sodexChainId: 138565, now: u.nonce,
  });
  assert.equal(ot.confidence, 'undocumented');
  assert.equal(`${ot.request.method} ${ot.request.gatewayPath}`, 'POST /api/v1/spot/accounts/api-keys/revoke');
  assert.throws(
    () => prepareApiKeyRevocation({ route: 'engine-delete', userAddress: USER, accountID: 1, name: 'k', nonce: BigInt(u.nonce), sodexChainId: 138565, now: u.nonce }),
    /needs an engine/,
  );
});

test('prepared digests always equal the hash of the typed data handed to the wallet', () => {
  const now = 1_760_000_000_000;
  const p = prepareApiKeyRegistration({
    userAddress: USER, accountID: 7, name: 'vs-x', publicKey: generateTradingKey().address,
    expiresAt: now + DAY_MS, builder: { id: 99, maxFeeRate: 25 }, nonce: BigInt(now), sodexChainId: 286623, signatureChainId: 8453, now,
  });
  assert.equal(p.digest, bytesToHex(hashTypedData(p.typedData)));
  assert.equal(hexToBytes(p.digest).length, 32);
});

// ---------------------------------------------------------------------------
// The /exchange route - what sodex.com's web app sends
// ---------------------------------------------------------------------------

test("exchange registration: sodex.com's body, one wallet signature on the wallet's own chain", () => {
  const u = uvec('user_signed_add_api_key_wallet_chain_42161');
  const p = prepareApiKeyRegistrationExchange({
    userAddress: USER,
    accountID: 43933,
    name: 'vs-trading-1',
    publicKey: KEY_ADDR,
    expiresAt: 1760186400000,
    nonce: u.nonce,
    sodexChainId: u.messageChainID,
    signatureChainId: 42161,
    now: 1760180000000,
  });
  assert.equal(p.typedData.primaryType, 'UserSignedAddAPIKeyAction');
  assert.equal(p.digest, u.digest.toLowerCase(), 'the Go SDK digest');
  const reqs = assembleExchangeRequests(p, walletSign(p.typedData), { base: 'https://gw.test' });
  assert.deepEqual(reqs.map((r) => [r.engine, r.method, r.path]), [
    ['spot', 'POST', 'https://gw.test/api/v1/spot/exchange'],
    ['perps', 'POST', 'https://gw.test/api/v1/perps/exchange'],
  ]);
  const body = JSON.parse(reqs[0]!.body);
  assert.deepEqual(Object.keys(body), ['type', 'params', 'nonce', 'signature', 'signatureChainID'], 'sodex.com key order');
  assert.deepEqual(body, {
    type: 'addAPIKey',
    params: { accountID: 43933, name: 'vs-trading-1', type: 1, publicKey: KEY_ADDR, expiresAt: 1760186400000 },
    nonce: u.nonce,
    signature: u.signature.toLowerCase(),
    signatureChainID: 42161,
  });
  assert.equal(reqs[1]!.body, reqs[0]!.body, 'both engines get the same signed body');
  assert.equal(reqs[0]!.headers['X-API-Sign'], undefined, 'no X-API-* headers on this route');
});

test('exchange registration: a signature from another account never leaves the browser', () => {
  const p = prepareApiKeyRegistrationExchange({
    userAddress: USER, accountID: 43933, name: 'vs-trading-1', publicKey: KEY_ADDR,
    expiresAt: Date.now() + DAY_MS, nonce: Date.now(), sodexChainId: 286623, signatureChainId: 1,
  });
  assert.throws(() => assembleExchangeRequests(p, walletSign(p.typedData, generateTradingKey().privateKey)), /must be signed by the account owner/);
});

test('exchange registration: refuses the master wallet as key, "default", a 0/long expiry, no account', () => {
  const base = { userAddress: USER, accountID: 43933, name: 'vs-trading-1', publicKey: KEY_ADDR, expiresAt: Date.now() + DAY_MS, nonce: Date.now(), sodexChainId: 286623, signatureChainId: 1 };
  assert.throws(() => prepareApiKeyRegistrationExchange({ ...base, publicKey: USER }), /separate key/);
  assert.throws(() => prepareApiKeyRegistrationExchange({ ...base, name: 'default' }), /reserved/);
  assert.throws(() => prepareApiKeyRegistrationExchange({ ...base, expiresAt: 0 }), /never expires/);
  assert.throws(() => prepareApiKeyRegistrationExchange({ ...base, expiresAt: Date.now() + 8 * DAY_MS }), /7 days/);
  assert.throws(() => prepareApiKeyRegistrationExchange({ ...base, accountID: 0 }), /account id/);
});

test("exchange revocation: engine domain, 0x01, the documented revoke bytes in sodex.com's envelope", () => {
  const v = vec(S, 'spot_revoke_api_key');
  const p = prepareApiKeyRevocationExchange({
    userAddress: USER, engine: 'spot', accountID: 43933, name: 'vs-key-1',
    nonce: v.nonce, sodexChainId: 138565, now: v.nonce,
  });
  const [req] = assembleExchangeRequests(p, walletSign(p.typedData));
  assert.equal(req!.gatewayPath, '/api/v1/spot/exchange');
  const body = JSON.parse(req!.body);
  assert.deepEqual(body, {
    type: 'revokeAPIKey',
    params: { accountID: 43933, name: 'vs-key-1' },
    nonce: v.nonce,
    signature: v.signature.toLowerCase(),
  });
});
