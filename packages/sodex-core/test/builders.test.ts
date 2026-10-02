/**
 * Builder codes, re-verified end to end against three independent references:
 *
 *   1. THE SPEC - the type strings and rules of
 *      https://sodex.com/documentation/for-developers/developers/trading/builder-codes-in-trading
 *      (and .../authentication-and-signing), copied verbatim below.
 *   2. THE OFFICIAL SDKS - Go (`SignApproveBuilderFeeRequest`, vectors-sdk.json,
 *      generated from sodex-go-sdk-public) and Python
 *      (`client.approve_builder_fee`, sodex-python-sdk-public@939f2d6): its
 *      struct hash is ported here LITERALLY (type hash, then one 32-byte word
 *      per field) as a second derivation that shares no code with eip712.ts's
 *      generic typed-data hasher.
 *   3. MAINNET - registrations the engines accepted, read from SoDEX's public
 *      explorer (vectors-live.json): the recovered signer is the account owner.
 *
 * Nothing here talks to a network; every key is a throwaway.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as A from '../src/actions.ts';
import {
  BUILDER_MIN_BALANCE_USDC,
  BUILDER_RATE_DENOMINATOR,
  MAX_BUILDER_APPROVALS,
  approvedBuilderRates,
  attachableBuilderFee,
  builderApprovalCount,
  builderFeeAmount,
  builderFeeCharged,
  builderRateDecimal,
  builderRatePercent,
  builderRateToFraction,
  fillFeeParts,
} from '../src/builders.ts';
import {
  SignatureType,
  bytesToHex,
  concat,
  domainSeparator,
  encodeFlatType,
  goJSONStringify,
  hashTypedData,
  hexToBytes,
  keccak256,
  makeDomain,
  privateKeyToAddress,
  recoverAddress,
  recoverWireSigner,
  signDigest,
  utf8,
  word,
  type TypedData,
} from '../src/eip712.ts';
import { generateTradingKey } from '../src/keys.ts';
import { assembleWalletSignedRequest, prepareBuilderFeeApproval } from '../src/registration.ts';
import {
  ADD_API_KEY_FIELDS,
  ADD_API_KEY_WITH_BUILDER_FIELDS,
  APPROVE_BUILDER_FEE_FIELDS,
  addAPIKeyTypedData,
  addAPIKeyWithBuilderTypedData,
  approveBuilderFeeTypedData,
  recoverTypedDataSigner,
  userSignedAddAPIKeyTypedData,
  walletSignatureToWire,
} from '../src/userSigned.ts';
import { PK, S, V, uvec } from './fixtures.ts';

const here = dirname(fileURLToPath(import.meta.url));
const USER = V.address.toLowerCase();
const MAINNET = 286623;
const TESTNET = 138565;

/** What a browser wallet returns for eth_signTypedData_v4: r || s || v with v in {27, 28}. */
function walletSign(td: TypedData, pk: Uint8Array = PK): string {
  const raw = signDigest(hashTypedData(td), pk, 0).slice(1);
  raw[64] = raw[64]! + 27;
  return bytesToHex(raw);
}

// ---------------------------------------------------------------------------
// 1. The spec's type strings
// ---------------------------------------------------------------------------

test('the EIP-712 type strings are the spec\'s, character for character', () => {
  // builder-codes-in-trading, "Action types": "case-sensitive, and field order is part of the signature".
  assert.equal(
    encodeFlatType('AddAPIKey', ADD_API_KEY_FIELDS),
    'AddAPIKey(uint64 accountID,string name,uint8 keyType,bytes publicKey,uint64 expiresAt,uint64 nonce)',
  );
  assert.equal(
    encodeFlatType('AddAPIKeyWithBuilder', ADD_API_KEY_WITH_BUILDER_FIELDS),
    'AddAPIKeyWithBuilder(uint64 chainID,uint64 nonce,uint64 accountID,string name,uint8 keyType,bytes publicKey,uint64 expiresAt,uint64 builderID,uint64 maxFeeRate)',
  );
  assert.equal(
    encodeFlatType('ApproveBuilderFeeAction', APPROVE_BUILDER_FEE_FIELDS),
    'ApproveBuilderFeeAction(uint64 chainID,uint64 nonce,uint64 accountID,uint64 builderID,uint64 maxFeeRate)',
  );
});

test('the approval typed data: universal domain, version 1, zero verifying contract, and TWO different chain ids', () => {
  const td = approveBuilderFeeTypedData({ accountID: 1010, builderID: 1234, maxFeeRate: 10 }, MAINNET, 1760373925000n, 42161);
  assert.deepEqual(td.domain, { name: 'universal', version: '1', chainId: 42161, verifyingContract: '0x0000000000000000000000000000000000000000' });
  assert.equal(td.primaryType, 'ApproveBuilderFeeAction');
  // The message keys are in the type's field order (wallets do not care, readers do).
  assert.deepEqual(Object.keys(td.message), ['chainID', 'nonce', 'accountID', 'builderID', 'maxFeeRate']);
  assert.equal(td.message['chainID'], '286623', 'message chainID = the SoDEX network id, whatever the wallet is on');
  assert.deepEqual(td.types['EIP712Domain'], [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ]);
  // The network id is not a wallet-chain: a testnet message never hashes like a mainnet one.
  const other = approveBuilderFeeTypedData({ accountID: 1010, builderID: 1234, maxFeeRate: 10 }, TESTNET, 1760373925000n, 42161);
  assert.notEqual(bytesToHex(hashTypedData(td)), bytesToHex(hashTypedData(other)));
  assert.throws(() => approveBuilderFeeTypedData({ accountID: 1, builderID: 2, maxFeeRate: 1 }, MAINNET, 1n, 0), /positive integer chain id/);
});

// ---------------------------------------------------------------------------
// 2a. The official Go SDK on MAINNET
// ---------------------------------------------------------------------------

const MAINNET_APPROVALS = [
  'user_approve_builder_fee_mainnet_wallet_chain_42161',
  'user_approve_builder_fee_mainnet_wallet_chain_1_max',
  'user_approve_builder_fee_mainnet_network_chain',
  'user_approve_builder_fee_mainnet_clear_wallet_chain_42161',
] as const;

for (const name of MAINNET_APPROVALS) {
  test(`mainnet ApproveBuilderFeeAction (${name.replace('user_approve_builder_fee_mainnet_', '')}) == the Go SDK, byte for byte`, () => {
    const u = uvec(name);
    assert.equal(u.messageChainID, MAINNET);
    const maxFeeRate = Number(u.message['maxFeeRate']);
    const p = prepareBuilderFeeApproval({
      userAddress: USER,
      accountID: Number(u.message['accountID']),
      builderID: Number(u.message['builderID']),
      maxFeeRate,
      nonce: BigInt(u.nonce),
      sodexChainId: MAINNET,
      signatureChainId: u.domainChainID,
      now: u.nonce,
    });
    assert.equal(p.digest, u.digest.toLowerCase(), 'the digest the wallet signs');
    assert.equal(p.typedData.domain.chainId, u.domainChainID, 'domain chainId');
    assert.equal(p.typedData.message['chainID'], String(MAINNET), 'message chainID');
    assert.equal(p.request.headers['X-API-Chain'], String(u.domainChainID), 'X-API-Chain == the domain chainId');
    assert.equal(p.request.headers['X-API-Nonce'], String(u.nonce), 'the nonce travels in the message AND the header');
    assert.equal(p.request.body, `{"accountID":1010,"builderID":223169,"maxFeeRate":${maxFeeRate}}`, 'a required 0 is kept, never dropped');
    const req = assembleWalletSignedRequest(p, walletSign(p.typedData), { base: '' });
    assert.equal(req.headers['X-API-Sign'], u.signature.toLowerCase(), '0x02 || r || s || v(0/1) == Go');
    assert.equal(req.method, 'POST');
    assert.equal(req.path, `/api/v1/user/${USER}/builders`);
    assert.equal('X-API-Key' in req.headers, false, 'the master wallet signs: no API key header');
  });
}

test('omitting signatureChainId signs under the SoDEX network id - what the official SDK example does', () => {
  const u = uvec('user_approve_builder_fee_mainnet_network_chain');
  const p = prepareBuilderFeeApproval({
    userAddress: USER, accountID: 1010, builderID: 223169, maxFeeRate: 20,
    nonce: BigInt(u.nonce), sodexChainId: MAINNET, now: u.nonce,
  });
  assert.equal(p.typedData.domain.chainId, MAINNET);
  assert.equal(p.request.headers['X-API-Chain'], String(MAINNET));
  assert.equal(p.digest, u.digest.toLowerCase());
});

test('universal domain separators for mainnet and a wallet chain match the Go SDK', () => {
  const sep = (c: number) => bytesToHex(domainSeparator(makeDomain('universal', c)));
  assert.equal(sep(MAINNET), S.domainUnivMainnet.toLowerCase());
  assert.equal(sep(42161), S.domainUnivArbitrum.toLowerCase());
  assert.notEqual(sep(MAINNET), sep(42161), 'a signature for one wallet chain is not valid under another');
});

test('mainnet AddAPIKeyWithBuilder with the wallet on Base == the Go SDK', () => {
  const u = uvec('user_add_api_key_with_builder_mainnet_wallet_chain_8453');
  const td = addAPIKeyWithBuilderTypedData(
    {
      accountID: 1010, name: 'valuescan-web', publicKey: String(u.message['publicKey']), expiresAt: Number(u.message['expiresAt']),
      builderID: 223169, maxFeeRate: 50,
    },
    MAINNET,
    BigInt(u.nonce),
    8453,
  );
  assert.equal(bytesToHex(hashTypedData(td)), u.digest.toLowerCase());
  assert.equal(walletSignatureToWire(walletSign(td)), u.signature.toLowerCase());
});

// ---------------------------------------------------------------------------
// 2b. The official Python SDK, ported literally
// ---------------------------------------------------------------------------

/** `client.approve_builder_fee`'s digest: keccak(0x1901 || domainSeparator || keccak(typeHash || five 32-byte words)). */
function pythonSdkApprovalDigest(i: { domainChainId: number; messageChainId: number; nonce: bigint; accountID: number; builderID: number; maxFeeRate: number }): Uint8Array {
  const typeHash = keccak256(utf8('ApproveBuilderFeeAction(uint64 chainID,uint64 nonce,uint64 accountID,uint64 builderID,uint64 maxFeeRate)'));
  const structHash = keccak256(concat(typeHash, word(i.messageChainId), word(i.nonce), word(i.accountID), word(i.builderID), word(i.maxFeeRate)));
  return keccak256(concat(new Uint8Array([0x19, 0x01]), domainSeparator(makeDomain('universal', i.domainChainId)), structHash));
}

test('the Python SDK\'s approve_builder_fee, ported literally, gives the same digest as the typed data a wallet signs', () => {
  for (const [domainChainId, messageChainId] of [[MAINNET, MAINNET], [TESTNET, TESTNET], [1, MAINNET], [42161, MAINNET], [8453, TESTNET]] as const) {
    for (const maxFeeRate of [0, 1, 20, 200, 2000]) {
      const args = { accountID: 1010, builderID: 9, maxFeeRate };
      const nonce = 1760373925000n + BigInt(maxFeeRate);
      const td = approveBuilderFeeTypedData(args, messageChainId, nonce, domainChainId);
      assert.equal(
        bytesToHex(hashTypedData(td)),
        bytesToHex(pythonSdkApprovalDigest({ domainChainId, messageChainId, nonce, ...args })),
        `domain ${domainChainId}, message ${messageChainId}, maxFeeRate ${maxFeeRate}`,
      );
    }
  }
});

test('the Python SDK\'s own approval test (tests/test_api_keys.py) passes against our request', () => {
  // _MASTER_PRIVATE_KEY, _NONCE and the call `client.approve_builder_fee(9, 20, account_id=1010)` on chain 286623.
  const pk = hexToBytes('0123456789012345678901234567890123456789012345678901234567890123');
  const address = privateKeyToAddress(pk);
  const nonce = 1760373925000n;
  const p = prepareBuilderFeeApproval({
    userAddress: address, accountID: 1010, builderID: 9, maxFeeRate: 20, nonce, sodexChainId: MAINNET, now: Number(nonce),
  });
  const req = assembleWalletSignedRequest(p, walletSign(p.typedData, pk), { base: 'https://testnet-gw.sodex.dev' });
  // What that test's HTTP callback asserts:
  assert.equal(req.path, `https://testnet-gw.sodex.dev/api/v1/user/${address}/builders`);
  assert.deepEqual(JSON.parse(req.body), { accountID: 1010, builderID: 9, maxFeeRate: 20 });
  assert.equal(req.body, '{"accountID":1010,"builderID":9,"maxFeeRate":20}', 'json.dumps(body, separators=(",", ":"))');
  const signature = hexToBytes(req.headers['X-API-Sign']!);
  assert.equal(signature[0], 2, 'SignatureType.EIP712_UNIVERSAL');
  assert.equal(signature.length, 66);
  const digest = pythonSdkApprovalDigest({ domainChainId: MAINNET, messageChainId: MAINNET, nonce, accountID: 1010, builderID: 9, maxFeeRate: 20 });
  assert.equal(recoverAddress(digest, signature.slice(1)), address, 'recovers the master wallet');
  // ...and the headers `_send_signed` sets.
  assert.equal(req.headers['X-API-Nonce'], String(nonce));
  assert.equal(req.headers['X-API-Chain'], String(MAINNET));
  assert.equal(req.headers['Content-Type'], 'application/json');
  assert.equal(req.headers['Accept'], 'application/json');
  assert.equal('X-API-Key' in req.headers, false);
});

// ---------------------------------------------------------------------------
// 3. Mainnet: what the engines accepted
// ---------------------------------------------------------------------------

interface LiveVector {
  name: string;
  primaryType: 'AddAPIKeyWithBuilder' | 'UserSignedAddAPIKeyAction';
  accepted: Record<string, { status: number }>;
  domainChainID: number;
  messageChainID: number;
  nonce: number;
  params: { accountID: number; name: string; type: number; publicKey: string; expiresAt: number; builder?: { id: number; fee: number } };
  signature: string;
  digest: string;
  ownerKeccak: string;
}
const LIVE = JSON.parse(readFileSync(join(here, 'vectors-live.json'), 'utf8')) as { sodexChainID: number; vectors: LiveVector[] };
const ownerOf = (digest: Uint8Array, wire: string) => bytesToHex(keccak256(hexToBytes(recoverWireSigner(digest, wire, SignatureType.EIP712Universal))));

test('MAINNET: registrations WITH a builder that the engines accepted recover the account owner under AddAPIKeyWithBuilder', () => {
  const withBuilder = LIVE.vectors.filter((v) => v.primaryType === 'AddAPIKeyWithBuilder');
  // Every registration with a builder found on four accounts - four different owners.
  assert.ok(withBuilder.length >= 4);
  assert.equal(new Set(withBuilder.map((v) => v.ownerKeccak)).size, withBuilder.length, 'one per account');
  for (const v of withBuilder) {
    assert.deepEqual(Object.values(v.accepted).map((e) => e.status), [1, 1], `${v.name}: accepted on both engines`);
    const p = v.params;
    const td = addAPIKeyWithBuilderTypedData(
      { accountID: p.accountID, name: p.name, publicKey: p.publicKey, expiresAt: p.expiresAt, keyType: p.type, builderID: p.builder!.id, maxFeeRate: p.builder!.fee },
      LIVE.sodexChainID,
      BigInt(v.nonce),
      v.domainChainID,
    );
    const digest = hashTypedData(td);
    assert.equal(bytesToHex(digest), v.digest);
    assert.equal(ownerOf(digest, v.signature), v.ownerKeccak, `${v.name}: the signer is the account owner`);
    // HTTP `builder.fee` is the EIP-712 `maxFeeRate`; a different value is a different signer.
    const wrong = addAPIKeyWithBuilderTypedData(
      { accountID: p.accountID, name: p.name, publicKey: p.publicKey, expiresAt: p.expiresAt, keyType: p.type, builderID: p.builder!.id, maxFeeRate: p.builder!.fee + 1 },
      LIVE.sodexChainID, BigInt(v.nonce), v.domainChainID,
    );
    assert.notEqual(ownerOf(hashTypedData(wrong), v.signature), v.ownerKeccak);
  }
});

test('MAINNET: ordinary registrations recover the owner under UserSignedAddAPIKeyAction, with the WALLET chain in the domain', () => {
  const ordinary = LIVE.vectors.filter((v) => v.primaryType === 'UserSignedAddAPIKeyAction');
  assert.ok(ordinary.some((v) => v.domainChainID === 1), 'a wallet on Ethereum (domain 1, message 286623)');
  assert.ok(ordinary.some((v) => v.domainChainID === LIVE.sodexChainID), 'a wallet on ValueChain');
  assert.ok(ordinary.some((v) => v.domainChainID === 8453), 'a wallet on Base');
  // The engines take whatever chain id the request names - even one that is no public chain at all.
  assert.ok(ordinary.some((v) => v.domainChainID === 31337), 'a wallet on a local development chain (31337)');
  // Not only sodex.com's own app keys: keys with names their owners chose are verified the same way.
  assert.ok(ordinary.some((v) => !/^(webkey|mobilekey|appkey|qrkey)$/.test(v.params.name)), 'a key with a user-chosen name');
  for (const v of ordinary) {
    assert.deepEqual(Object.values(v.accepted).map((e) => e.status), [1, 1], `${v.name}: accepted on both engines`);
    const p = v.params;
    const fields = { accountID: p.accountID, name: p.name, publicKey: p.publicKey, expiresAt: p.expiresAt, keyType: p.type };
    const digest = hashTypedData(userSignedAddAPIKeyTypedData(fields, LIVE.sodexChainID, BigInt(v.nonce), v.domainChainID));
    assert.equal(ownerOf(digest, v.signature), v.ownerKeccak, `${v.name}: domain chainId = ${v.domainChainID}, message chainID = ${LIVE.sodexChainID}`);
    // Swapping the two chain ids, or signing the documented plain AddAPIKey, recovers a stranger.
    if (v.domainChainID !== LIVE.sodexChainID) {
      const swapped = hashTypedData(userSignedAddAPIKeyTypedData(fields, LIVE.sodexChainID, BigInt(v.nonce), LIVE.sodexChainID));
      assert.notEqual(ownerOf(swapped, v.signature), v.ownerKeccak);
    }
    const documented = hashTypedData(addAPIKeyTypedData(fields, BigInt(v.nonce), v.domainChainID));
    assert.notEqual(ownerOf(documented, v.signature), v.ownerKeccak, 'the documented AddAPIKey struct is not what the engines verify');
  }
});

// ---------------------------------------------------------------------------
// Signature bytes
// ---------------------------------------------------------------------------

test('wire signature: prefix 0x02 (0x01 for an engine action), v normalised 27/28 -> 0/1, anything else refused', () => {
  const td = approveBuilderFeeTypedData({ accountID: 1, builderID: 2, maxFeeRate: 3 }, MAINNET, 1760373925000n, 1);
  const sig = hexToBytes(walletSign(td));
  assert.ok(sig[64] === 27 || sig[64] === 28);
  const wire = hexToBytes(walletSignatureToWire(bytesToHex(sig)));
  assert.equal(wire.length, 66);
  assert.equal(wire[0], 2);
  assert.equal(wire[65], sig[64]! - 27);
  assert.deepEqual([...wire.slice(1, 65)], [...sig.slice(0, 64)], 'r and s untouched');
  // A wallet that already answers 0/1 (hardware wallets do) is left alone.
  const zeroOne = sig.slice();
  zeroOne[64] = sig[64]! - 27;
  assert.equal(walletSignatureToWire(bytesToHex(zeroOne)), bytesToHex(wire));
  assert.equal(hexToBytes(walletSignatureToWire(bytesToHex(sig), SignatureType.EIP712))[0], 1);
  for (const bad of [2, 26, 29, 35, 255]) {
    const b = sig.slice();
    b[64] = bad;
    assert.throws(() => walletSignatureToWire(bytesToHex(b)), /unexpected recovery id/, `v = ${bad}`);
  }
  assert.throws(() => walletSignatureToWire(bytesToHex(sig.slice(0, 64))), /65-byte/);
  assert.throws(() => walletSignatureToWire('0xzz'), /hex/);
  assert.equal(recoverTypedDataSigner(td, bytesToHex(sig)), V.address.toLowerCase());
});

// ---------------------------------------------------------------------------
// The approval request's guards
// ---------------------------------------------------------------------------

test('approval guards: fee range, builder id, chain ids, nonce window, and the wrong wallet account', () => {
  const now = 1_760_400_000_000;
  const base = { userAddress: USER, accountID: 1010, builderID: 223169, maxFeeRate: 50, nonce: BigInt(now), sodexChainId: MAINNET, signatureChainId: 42161, now };
  assert.doesNotThrow(() => prepareBuilderFeeApproval(base));
  assert.doesNotThrow(() => prepareBuilderFeeApproval({ ...base, maxFeeRate: 0 }), 'clearing');
  assert.doesNotThrow(() => prepareBuilderFeeApproval({ ...base, maxFeeRate: 2000 }), 'the ceiling');
  for (const bad of [2001, -1, 1.5, Number.NaN]) {
    assert.throws(() => prepareBuilderFeeApproval({ ...base, maxFeeRate: bad }), /0\.\.2000/, `maxFeeRate ${bad}`);
  }
  assert.throws(() => prepareBuilderFeeApproval({ ...base, builderID: 0 }), /non-zero/);
  assert.throws(() => prepareBuilderFeeApproval({ ...base, builderID: 0n }), /non-zero/);
  assert.throws(() => prepareBuilderFeeApproval({ ...base, sodexChainId: 42161 }), /not a SoDEX chain id/);
  assert.throws(() => prepareBuilderFeeApproval({ ...base, signatureChainId: 0 }), /positive integer chain id/);
  assert.throws(() => prepareBuilderFeeApproval({ ...base, userAddress: '0x1234' }), /master wallet/);
  assert.throws(() => prepareBuilderFeeApproval({ ...base, nonce: 1n }), /behind/);
  // uint64 ids beyond 2^53 travel as bigint and stay exact in the body.
  const big = prepareBuilderFeeApproval({ ...base, builderID: 18446744073709551615n });
  assert.equal(big.request.body, '{"accountID":1010,"builderID":18446744073709551615,"maxFeeRate":50}');
  assert.equal(big.typedData.message['builderID'], '18446744073709551615');

  const p = prepareBuilderFeeApproval(base);
  assert.equal(p.kind, 'approveBuilderFee');
  assert.equal(p.signatureType, 2);
  assert.equal(p.expectedSigner, USER);
  assert.throws(
    () => assembleWalletSignedRequest(p, walletSign(p.typedData, generateTradingKey().privateKey)),
    /must be signed by the account owner/,
    'a signature from another account never leaves the browser',
  );
  // The typed data survives the JSON round trip eth_signTypedData_v4 implies.
  assert.equal(bytesToHex(hashTypedData(JSON.parse(JSON.stringify(p.typedData)))), p.digest);
});

// ---------------------------------------------------------------------------
// Orders: where the builder sits
// ---------------------------------------------------------------------------

test('orders: `builder` is the LAST key of the batch, `id` before `fee`, whatever order the caller wrote them in', () => {
  const order = { clOrdID: 'a', side: A.OrderSide.SELL, type: A.OrderType.LIMIT, timeInForce: A.TimeInForce.GTC, price: '1', quantity: '1' };
  const backwards = { fee: 50, id: 456 };
  const perps = goJSONStringify(A.perpsNewOrder(1, 1, [order], backwards));
  const spot = goJSONStringify(A.spotBatchNewOrder(1, [{ ...order, symbolID: 1 }], backwards));
  for (const body of [perps, spot]) {
    assert.ok(body.endsWith(',"builder":{"id":456,"fee":50}}'), body);
    assert.equal(Object.keys(JSON.parse(body)).at(-1), 'builder');
  }
  // Without one the key is absent (Go omitempty on a nil pointer) - not null, not {}.
  assert.equal(goJSONStringify(A.perpsNewOrder(1, 1, [order])).includes('builder'), false);
  assert.equal(goJSONStringify(A.spotBatchNewOrder(1, [{ ...order, symbolID: 1 }], undefined)).includes('builder'), false);
});

// ---------------------------------------------------------------------------
// Reading approvals, and the numbers
// ---------------------------------------------------------------------------

test('approvedBuilderRates: per engine, for one builder, never an approval out of thin air', () => {
  // The shape mainnet answers with (an approval of 500: spot 500, perps capped at 200).
  const live = {
    spot: [{ userID: 1061, builderID: 223169, feeRate: 500 }],
    perps: [{ userID: 1061, builderID: 223169, feeRate: 200 }],
  };
  assert.deepEqual(approvedBuilderRates(live, 223169), { spot: 500, perps: 200 });
  assert.deepEqual(approvedBuilderRates(live, 223169n), { spot: 500, perps: 200 }, 'a bigint id matches a JSON number');
  assert.deepEqual(approvedBuilderRates(live, 9), { spot: null, perps: null }, 'another builder');
  assert.deepEqual(approvedBuilderRates({ spot: [], perps: [] }, 223169), { spot: null, perps: null }, 'the empty answer a new wallet gets');
  assert.deepEqual(approvedBuilderRates({ spot: live.spot, perps: [] }, 223169), { spot: 500, perps: null }, 'one engine only');
  assert.deepEqual(approvedBuilderRates({ spot: [{ builderID: '223169', feeRate: '50' }] }, 223169), { spot: 50, perps: null }, 'numeric strings');
  for (const junk of [null, undefined, 'x', 5, [], { spot: 'no', perps: null }, { spot: [null, 7, {}], perps: [{ builderID: 223169 }] }, { spot: [{ builderID: 223169, feeRate: 0 }], perps: [{ builderID: 223169, feeRate: -5 }] }]) {
    assert.deepEqual(approvedBuilderRates(junk, 223169), { spot: null, perps: null }, JSON.stringify(junk));
  }
  assert.deepEqual(builderApprovalCount({ spot: [{ builderID: 1 }, { builderID: 2 }, { builderID: 1 }], perps: [{ builderID: 1 }] }), { spot: 2, perps: 1 });
  assert.deepEqual(builderApprovalCount(null), { spot: 0, perps: 0 });
  assert.equal(MAX_BUILDER_APPROVALS, 10);
  assert.equal(BUILDER_MIN_BALANCE_USDC, 100);
});

test('attachableBuilderFee: only within the approval AND the engine cap; spot buys are named but not charged', () => {
  assert.equal(attachableBuilderFee('perps', 50, 50), 50);
  assert.equal(attachableBuilderFee('perps', 50, 200), 50);
  assert.equal(attachableBuilderFee('perps', 51, 50), null, 'above what was approved');
  assert.equal(attachableBuilderFee('perps', 201, 2000), null, 'above the perps cap, whatever was approved');
  assert.equal(attachableBuilderFee('spot', 2000, 2000), 2000);
  assert.equal(attachableBuilderFee('spot', 2001, 2001), null);
  assert.equal(attachableBuilderFee('spot', 0, 2000), null, 'a zero fee attaches nothing');
  assert.equal(attachableBuilderFee('spot', 50, null), null);
  assert.equal(attachableBuilderFee('spot', 50, undefined), null);
  assert.equal(attachableBuilderFee('spot', 1.5, 2000), null);
  assert.equal(builderFeeCharged('perps', 'buy'), true);
  assert.equal(builderFeeCharged('perps', 'SELL'), true);
  assert.equal(builderFeeCharged('spot', 'sell'), true);
  assert.equal(builderFeeCharged('spot', 'BUY'), false, 'not on the buying side of spot trades');
});

test('fee units: tenths of a basis point, exactly', () => {
  assert.equal(BUILDER_RATE_DENOMINATOR, 100_000);
  // The spec's table: 10 = 1 bp = 0.01 %, 50 = 0.05 %, 200 = 0.2 %, 2000 = 2 %.
  assert.deepEqual([10, 50, 200, 2000].map(builderRatePercent), ['0.01', '0.05', '0.2', '2']);
  assert.deepEqual([1, 5, 10, 50, 2000, 0].map(builderRateDecimal), ['0.00001', '0.00005', '0.0001', '0.0005', '0.02', '0']);
  assert.equal(builderRateToFraction(10), 0.0001);
  assert.equal(builderFeeAmount('10000', 10), '1', '"10 means 1 basis point of the order notional"');
  assert.equal(builderFeeAmount('3.075', 100), '0.003075', 'the live fill below');
  assert.equal(builderFeeAmount('0.1', 1), '0.000001');
  assert.throws(() => builderRatePercent(2001), /0\.\.2000/);
  assert.throws(() => builderRateDecimal(-1), /0\.\.2000/);
});

test('fills: `fee` is the total and `builderFee` a PART of it (rows read from mainnet, 2026-10-02)', () => {
  // A maker SELL with a 10 bp builder fee: 123 * 0.025 = 3.075 notional; 13.5 bp charged, 10 bp of it the builder's.
  const makerSell = { symbol: 'vSOL_vUSDC', side: 'SELL', price: '123', quantity: '0.025', fee: '0.00415125', builderFee: '0.003075', feeCoin: 'vUSDC', isMaker: true };
  assert.deepEqual(fillFeeParts(makerSell), { total: '0.00415125', builder: '0.003075', venue: '0.00107625' });
  assert.equal(builderFeeAmount('3.075', 100), makerSell.builderFee, 'the order named fee 100');
  assert.equal(builderFeeAmount('3.075', 35), '0.00107625', 'the venue part is exactly the 3.5 bp maker rate');
  // A taker SELL: 121.64 * 4.355 = 529.7422; 16.5 bp charged = 6.5 venue + 10 builder.
  assert.deepEqual(fillFeeParts({ fee: '0.87407463', builderFee: '0.5297422', feeCoin: 'vUSDC' }), { total: '0.87407463', builder: '0.5297422', venue: '0.34433243' });
  // A BUY from the same builder-tagged account: fee in the base coin, no builderFee key at all.
  assert.deepEqual(fillFeeParts({ side: 'BUY', fee: '0.000476105', feeCoin: 'vETH' }), { total: '0.000476105', builder: '0', venue: '0.000476105' });
  // The WebSocket shape, and the edges.
  assert.deepEqual(fillFeeParts({ f: '1.5', bf: '0.5' }), { total: '1.5', builder: '0.5', venue: '1' });
  assert.deepEqual(fillFeeParts({ fee: '-0.02' }), { total: '-0.02', builder: '0', venue: '-0.02' }, 'a maker rebate stays a rebate');
  assert.deepEqual(fillFeeParts({ fee: '-0.02', builderFee: '0.05' }), { total: '-0.02', builder: '0.05', venue: '-0.07' }, 'rebate net of a builder fee');
  assert.deepEqual(fillFeeParts({ fee: '0.01', builderFee: '0.02' }), { total: '0.01', builder: '0.02', venue: '0' }, 'never an invented rebate');
  assert.deepEqual(fillFeeParts({ builderFee: '0.5' }), { total: null, builder: '0.5', venue: null });
  assert.deepEqual(fillFeeParts({ fee: 'n/a', builderFee: '0' }), { total: null, builder: '0', venue: null });
  assert.deepEqual(fillFeeParts(null), { total: null, builder: '0', venue: null });
  assert.deepEqual(fillFeeParts({ fee: 1.25, builderFee: 0.25 }), { total: '1.25', builder: '0.25', venue: '1' }, 'numbers are tolerated');
});
