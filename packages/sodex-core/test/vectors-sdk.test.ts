/**
 * Valuescan additions, pinned against bytes produced by the OFFICIAL Go SDK
 * (tools/genvectors/main.go run inside a checkout of sodex-go-sdk-public; the
 * commit is in test/vectors-sdk.commit).
 *
 * What each vector proves, precisely:
 *   perps_new_order_builder_batch, perps_market_ioc_builder_cap,
 *   spot_batch_new_order_builder, perps_new_twap_order, perps_cancel_twap_order,
 *   spot_revoke_api_key                 -> official Go structs + official signer
 *   perps_new_order_builder_per_order   -> Go encoding/json + official signer over a
 *                                          LOCAL struct mirroring the Python SDK
 *                                          layout (the Go SDK has no per-order builder)
 *   user_add_api_key, user_add_api_key_with_builder_*, user_approve_builder_fee*
 *                                       -> official SDK Sign* methods + action.Hash
 *                                          (the *_mainnet_* ones are asserted in
 *                                          builders.test.ts)
 *   user_revoke_api_key_universal       -> composed from SDK primitives (Python SDK route)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DomainName,
  actionPayloadHash,
  bytesToHex,
  domainSeparator,
  exchangeActionTypedData,
  goJSONStringify,
  hashTypedData,
  makeDomain,
  signExchangeAction,
} from '../src/eip712.ts';
import * as A from '../src/actions.ts';
import { canonicalDecimal } from '../src/decimal.ts';
import { APIKeyPermission } from '../src/permissions.ts';
import {
  addAPIKeyTypedData,
  addAPIKeyWithBuilderTypedData,
  approveBuilderFeeTypedData,
  signTypedDataWithKey,
  userSignedAddAPIKeyTypedData,
} from '../src/userSigned.ts';
import { PK, S, SDK_COMMIT, V, uvec, vec } from './fixtures.ts';

const domainFor = (engine: string) => (engine === 'spot' ? DomainName.spot : DomainName.perps);

function assertSdkVector(name: string, params: unknown) {
  const v = vec(S, name);
  assert.equal(goJSONStringify(params), v.bodyJSON, `${name}: body JSON must match Go json.Marshal`);
  assert.equal(goJSONStringify({ type: v.actionType, params }), v.payloadJSON, `${name}: signing payload`);
  assert.equal(bytesToHex(actionPayloadHash(v.actionType, params)), v.payloadHash.toLowerCase(), `${name}: payloadHash`);
  assert.equal(
    signExchangeAction(domainFor(v.engine), S.chainID, v.actionType, params, BigInt(v.nonce), PK),
    v.signature.toLowerCase(),
    `${name}: wire signature`,
  );
}

test('fixtures were generated from a pinned SDK commit', () => {
  assert.match(SDK_COMMIT, /^[0-9a-f]{40}$/);
});

test("today's SDK still reproduces Opentrade's 19 pinned vectors byte-for-byte", () => {
  for (const v of V.vectors) {
    const w = vec(S, v.name);
    for (const k of ['engine', 'actionType', 'nonce', 'payloadJSON', 'payloadHash', 'bodyJSON', 'signature'] as const) {
      assert.equal(w[k], v[k], `${v.name}.${k}`);
    }
  }
  for (const k of ['address', 'chainID', 'domainSpot', 'domainPerps', 'domainUniv'] as const) {
    assert.equal(S[k], V[k], k);
  }
});

test('mainnet and universal-network domain separators match the Go SDK', () => {
  const sep = (n: string, c: number) => bytesToHex(domainSeparator(makeDomain(n, c)));
  assert.equal(sep(DomainName.perps, 286623), S.domainPerpsMainnet.toLowerCase());
  assert.equal(sep(DomainName.spot, 286623), S.domainSpotMainnet.toLowerCase());
  assert.equal(sep(DomainName.universal, S.chainID), S.domainUnivNet.toLowerCase());
});

test('permission bit values match the Go enum (Mask() = 1 << bit)', () => {
  assert.deepEqual(S.permissionMasks, { ...APIKeyPermission });
});

// ---------------------------------------------------------------------------
// Go encoding/json parity
// ---------------------------------------------------------------------------

test('goJSONStringify matches Go 1.26 encoding/json string escaping', () => {
  for (const [input, expected] of Object.entries(S.goJSONStrings)) {
    assert.equal(goJSONStringify(input), expected, JSON.stringify(input));
  }
});

test('canonicalDecimal matches shopspring/decimal on the extra cases', () => {
  for (const [input, expected] of Object.entries(S.decimalsExtra)) {
    assert.equal(canonicalDecimal(input), expected, input);
  }
});

// ---------------------------------------------------------------------------
// Builder codes on orders
// ---------------------------------------------------------------------------

test('perps: batch-level builder is the LAST key, id before fee (official struct)', () => {
  const params = A.perpsNewOrder(
    43933,
    1,
    [
      {
        clOrdID: 'vs-builder-1',
        side: A.OrderSide.BUY,
        type: A.OrderType.LIMIT,
        timeInForce: A.TimeInForce.GTC,
        price: '70000.5',
        quantity: '0.01',
      },
    ],
    { id: 456, fee: 50 },
  );
  assertSdkVector('perps_new_order_builder_batch', params);
  assert.ok(vec(S, 'perps_new_order_builder_batch').bodyJSON.endsWith(',"builder":{"id":456,"fee":50}}'));
});

test('perps: market IOC with a price cap and the max perps builder fee (copy-trade shape)', () => {
  assertSdkVector(
    'perps_market_ioc_builder_cap',
    A.perpsNewOrder(
      43933,
      2,
      [
        {
          clOrdID: 'vs-copy-1',
          side: A.OrderSide.SELL,
          type: A.OrderType.MARKET,
          timeInForce: A.TimeInForce.IOC,
          price: '2450.1',
          quantity: '0.25',
        },
      ],
      { id: 456, fee: 200 },
    ),
  );
});

test('perps: per-order override (Python SDK layout) plus batch default', () => {
  assertSdkVector(
    'perps_new_order_builder_per_order',
    A.perpsNewOrder(
      43933,
      1,
      [
        {
          clOrdID: 'vs-po-a',
          side: A.OrderSide.BUY,
          type: A.OrderType.LIMIT,
          timeInForce: A.TimeInForce.GTC,
          price: '69000',
          quantity: '0.02',
          builder: { id: 789, fee: 20 },
        },
        {
          clOrdID: 'vs-po-b',
          side: A.OrderSide.BUY,
          type: A.OrderType.LIMIT,
          timeInForce: A.TimeInForce.GTC,
          price: '68000',
          quantity: '0.02',
        },
      ],
      { id: 456, fee: 50 },
    ),
  );
});

test('spot: batch-level builder after `orders` (official struct)', () => {
  assertSdkVector(
    'spot_batch_new_order_builder',
    A.spotBatchNewOrder(
      43933,
      [
        {
          symbolID: 1,
          clOrdID: 'vs-spot-builder',
          side: A.OrderSide.SELL,
          type: A.OrderType.LIMIT,
          timeInForce: A.TimeInForce.GTC,
          price: '95000',
          quantity: '0.406',
        },
      ],
      { id: 456, fee: 1000 },
    ),
  );
});

test('builder fee caps: perps 200, spot 2000; id must be non-zero', () => {
  assert.throws(() => A.builderFragment({ id: 1, fee: 201 }, 'perps'), /0\.\.200/);
  assert.doesNotThrow(() => A.builderFragment({ id: 1, fee: 200 }, 'perps'));
  assert.doesNotThrow(() => A.builderFragment({ id: 1, fee: 2000 }, 'spot'));
  assert.throws(() => A.builderFragment({ id: 1, fee: 2001 }, 'spot'), /0\.\.2000/);
  assert.throws(() => A.builderFragment({ id: 0, fee: 10 }, 'spot'), /non-zero/);
  assert.throws(() => A.builderFragment({ id: 1, fee: 1.5 }, 'spot'), /integer/);
  // No builder => no key at all (Go omitempty on a nil pointer).
  const plain = goJSONStringify(A.perpsNewOrder(1, 1, [{ clOrdID: 'a', side: 1, type: 1, timeInForce: 1, price: '1', quantity: '1' }]));
  assert.ok(!plain.includes('builder'));
});

// ---------------------------------------------------------------------------
// TWAP and spot revoke
// ---------------------------------------------------------------------------

test('perps TWAP order (reduceOnly present when false - Go *bool)', () => {
  assertSdkVector(
    'perps_new_twap_order',
    A.newTwapOrder({ accountID: 43933, symbolID: 1, side: A.OrderSide.BUY, quantity: '1.5', minutes: 30, randomize: true, reduceOnly: false }),
  );
  assert.throws(() => A.newTwapOrder({ accountID: 1, symbolID: 1, side: 1, quantity: '1', minutes: 4, randomize: false }), /5\.\.1440/);
});

test('perps TWAP cancel', () => {
  assertSdkVector('perps_cancel_twap_order', A.cancelTwapOrder(43933, 1, 424242));
});

test('spot revokeAPIKey under the spot domain', () => {
  assertSdkVector('spot_revoke_api_key', A.revokeAPIKey(43933, 'vs-key-1'));
});

test('spot -> own ValueChain wallet (EVM_WITHDRAW to the treasury account 999)', () => {
  assertSdkVector(
    'spot_evm_withdraw',
    A.transferAsset({ id: 1760300000123, fromAccountID: 43933, toAccountID: 999, coinID: 0, amount: '12.5', type: A.TransferType.EVM_WITHDRAW }),
  );
});

// ---------------------------------------------------------------------------
// Master-wallet (universal) typed data - the OBJECTS handed to wallets
// ---------------------------------------------------------------------------

const KEY_ADDR = '0x3d4595c8742d0a58173a9963c05755b59a8f8256';

test('AddAPIKey (ordinary key) typed data hashes to the Go digest and signs identically', () => {
  const u = uvec('user_add_api_key');
  const td = addAPIKeyTypedData(
    { accountID: 43933, name: 'vs-trading-1', publicKey: KEY_ADDR, expiresAt: 1760186400000 },
    BigInt(u.nonce),
    u.domainChainID,
  );
  assert.equal(bytesToHex(hashTypedData(td)), u.digest.toLowerCase());
  assert.equal(signTypedDataWithKey(td, PK), u.signature.toLowerCase());
  // No message-level chainID on the ordinary action.
  assert.ok(!('chainID' in td.message));
  assert.equal(td.primaryType, 'AddAPIKey');
});

for (const name of ['user_signed_add_api_key_wallet_chain_1', 'user_signed_add_api_key_wallet_chain_42161', 'user_signed_add_api_key_wallet_chain_138565']) {
  test(`UserSignedAddAPIKeyAction (${name.replace('user_signed_add_api_key_', '')}) - the registration sodex.com signs - matches the Go digest`, () => {
    const u = uvec(name);
    const td = userSignedAddAPIKeyTypedData(
      { accountID: 43933, name: 'vs-trading-1', publicKey: KEY_ADDR, expiresAt: 1760186400000 },
      u.messageChainID,
      BigInt(u.nonce),
      u.domainChainID,
    );
    assert.equal(td.primaryType, 'UserSignedAddAPIKeyAction');
    assert.equal(td.domain.chainId, u.domainChainID, 'domain chainId = the wallet chain: no network switch');
    assert.equal(td.message['chainID'], String(u.messageChainID), 'message chainID = SoDEX network id');
    assert.equal(bytesToHex(hashTypedData(td)), u.digest.toLowerCase());
    assert.equal(signTypedDataWithKey(td, PK), u.signature.toLowerCase());
  });
}

for (const name of ['user_add_api_key_with_builder_wallet_chain_1', 'user_add_api_key_with_builder_network_chain']) {
  test(`AddAPIKeyWithBuilder (${name.replace('user_add_api_key_with_builder_', '')}) matches the Go digest`, () => {
    const u = uvec(name);
    const td = addAPIKeyWithBuilderTypedData(
      { accountID: 43933, name: 'vs-trading-2', publicKey: KEY_ADDR, expiresAt: 1760186400000, builderID: 456, maxFeeRate: 50 },
      u.messageChainID,
      BigInt(u.nonce),
      u.domainChainID,
    );
    assert.equal(td.domain.chainId, u.domainChainID, 'domain chainId = wallet chain / X-API-Chain');
    assert.equal(td.message['chainID'], String(u.messageChainID), 'message chainID = SoDEX network id');
    assert.equal(bytesToHex(hashTypedData(td)), u.digest.toLowerCase());
    assert.equal(signTypedDataWithKey(td, PK), u.signature.toLowerCase());
  });
}

for (const name of ['user_approve_builder_fee', 'user_approve_builder_fee_clear']) {
  test(`ApproveBuilderFeeAction (${name}) matches the Go digest`, () => {
    const u = uvec(name);
    const td = approveBuilderFeeTypedData(
      { accountID: 43933, builderID: 456, maxFeeRate: Number(u.message['maxFeeRate']) },
      u.messageChainID,
      BigInt(u.nonce),
      u.domainChainID,
    );
    assert.equal(bytesToHex(hashTypedData(td)), u.digest.toLowerCase());
    assert.equal(signTypedDataWithKey(td, PK), u.signature.toLowerCase());
  });
}

test('revokeAPIKey as a universal ExchangeAction (Python SDK route) matches Go primitives', () => {
  const u = uvec('user_revoke_api_key_universal');
  const payloadHash = actionPayloadHash('revokeAPIKey', A.revokeAPIKey(43933, 'vs-key-1'));
  assert.equal(bytesToHex(payloadHash), String(u.message['payloadHash']).toLowerCase());
  const td = exchangeActionTypedData(DomainName.universal, u.domainChainID, payloadHash, BigInt(u.nonce));
  assert.equal(bytesToHex(hashTypedData(td)), u.digest.toLowerCase());
  assert.equal(signTypedDataWithKey(td, PK), u.signature.toLowerCase());
});

test('every SDK vector is covered', () => {
  const covered = new Set([
    ...V.vectors.map((v) => v.name),
    'perps_new_order_builder_batch', 'perps_market_ioc_builder_cap', 'perps_new_order_builder_per_order',
    'spot_batch_new_order_builder', 'perps_new_twap_order', 'perps_cancel_twap_order', 'spot_revoke_api_key', 'spot_evm_withdraw',
    // The three take-profit / stop-loss shapes: asserted against the app's own order builder in
    // apps/web/src/trading/orderParams.test.ts.
    'perps_bracket_tp_sl', 'perps_position_tp', 'perps_standalone_stop',
  ]);
  const missing = S.vectors.map((v) => v.name).filter((n) => !covered.has(n));
  assert.deepEqual(missing, []);
  const users = new Set([
    'user_add_api_key', 'user_add_api_key_with_builder_wallet_chain_1', 'user_add_api_key_with_builder_network_chain',
    'user_signed_add_api_key_wallet_chain_1', 'user_signed_add_api_key_wallet_chain_42161', 'user_signed_add_api_key_wallet_chain_138565',
    'user_approve_builder_fee', 'user_approve_builder_fee_clear', 'user_revoke_api_key_universal',
    // Mainnet builder vectors: asserted in builders.test.ts.
    'user_approve_builder_fee_mainnet_wallet_chain_42161', 'user_approve_builder_fee_mainnet_wallet_chain_1_max',
    'user_approve_builder_fee_mainnet_network_chain', 'user_approve_builder_fee_mainnet_clear_wallet_chain_42161',
    'user_add_api_key_with_builder_mainnet_wallet_chain_8453',
  ]);
  assert.deepEqual(S.userVectors.map((u) => u.name).filter((n) => !users.has(n)), []);
});
