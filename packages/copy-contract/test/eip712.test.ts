/**
 * EIP-712: the spec's published vectors (COPY-TRADING.md §6.8, produced by contracts/test/spec/EIP712Spec.t.sol), and
 * every primary type fuzzed against viem's independent hashTypedData / hashStruct. The contract side of the same
 * digests is checked by Foundry in contracts/test/CrossCheckVectors.t.sol.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concat, hashStruct as viemHashStruct, hashTypedData as viemHashTypedData, keccak256, toBytes } from 'viem';

import {
  type CopyTradingAction,
  type CopyTradingPrimaryType,
  EIP712_NAME,
  PRIMARY_TYPES,
  type Terms,
  TypedDataError,
  VALUECHAIN_CHAIN_ID,
  WITH_SIG_FUNCTION,
  ZERO_BYTES32,
  copyTradingDomain,
  domainFromEip712Domain,
  domainSeparator,
  hashTerms,
  hashTypedData,
  isExpectedDomain,
  prepareAction,
  prepareInvalidateNonces,
  preparePauseSubscription,
  prepareResumeSubscription,
  prepareSubscribe,
  prepareUnsubscribe,
  prepareUnsubscribeAll,
  prepareUpdateSubscription,
  serializeTypedData,
  symbolHash,
  symbolsHash,
  termsMessage,
  typesFor,
} from '../src/index.ts';
import { FOLLOWER, LEADER, PROXY, type Rng, randomAddress, randomString, reviveTypedData, rng, validTerms } from './helpers.ts';

const spec = { verifyingContract: PROXY } as const;
const DEADLINE = 1_790_000_000n;

// ---------------------------------------------------------------------------
// Published vectors (COPY-TRADING.md §6.8)
// ---------------------------------------------------------------------------

test('spec §6.8: domain separator, Terms hash, Subscribe struct hash and digest', () => {
  assert.equal(domainSeparator(spec), '0xfbd6a915ede01c4ff68b16571b7903fa09b3d1adc9eedc87455d299eb8f8e7be');
  assert.equal(copyTradingDomain(spec).chainId, VALUECHAIN_CHAIN_ID, 'defaults to ValueChain');
  const terms = validTerms();
  assert.equal(hashTerms(terms), '0x9f3bb65f95299cbdfce6255b2e72c644174a47be9ce7b196fa6cfdd58eb9fb74');
  const p = prepareSubscribe(spec, {
    follower: FOLLOWER,
    venue: 2,
    leader: LEADER,
    sodexAccountId: 224_678n,
    terms,
    stopEpoch: 0n,
    expectedLastId: 0n,
    nonce: 7n,
    deadline: DEADLINE,
  });
  assert.equal(p.structHash, '0x29c14b18ca1052980458a39bf4368c18cee82e7094fa5db07b4300d6f4b4fd15');
  assert.equal(p.digest, '0xebba0ab9d19db149bb7318d59bfe1af32d251a0ae1673eeb3c78c030e5914e17');
  assert.equal(p.signer, FOLLOWER);
  assert.equal(viemHashTypedData(p.typedData as never), p.digest, 'viem agrees');
});

test('spec §6.8: every other message type', () => {
  const f = FOLLOWER;
  const cases: Array<[string, string, string]> = [
    [
      'UpdateSubscription',
      prepareUpdateSubscription(spec, { follower: f, subscriptionId: 42n, expectedVersion: 3, terms: validTerms(), nonce: 8n, deadline: DEADLINE }).digest,
      '0x0c87513387836c9db403b3894f2e5cbd37d9fdb1208ba33bf8e80927f264b580',
    ],
    [
      'PauseSubscription',
      preparePauseSubscription(spec, { follower: f, subscriptionId: 42n, nonce: 9n, deadline: DEADLINE }).digest,
      '0x1402860d5946a3305b26ecd3e1cb86d91773ed6c9351aecfb1f1bb50bd8b5366',
    ],
    [
      'ResumeSubscription',
      prepareResumeSubscription(spec, { follower: f, subscriptionId: 42n, expectedVersion: 4, nonce: 10n, deadline: DEADLINE }).digest,
      '0x8d3a843eeb7068e26924c76d8cec8a1dcfe6073e17973d6ff2f7e9c4bdee87e0',
    ],
    [
      'Unsubscribe',
      prepareUnsubscribe(spec, { follower: f, subscriptionId: 42n, closePositions: true, nonce: 11n, deadline: DEADLINE }).digest,
      '0xdc731e8c8e3c805234909cb387b33794cc2bd3add352b74110bf2021f28d41c4',
    ],
    [
      'UnsubscribeAll',
      prepareUnsubscribeAll(spec, { follower: f, closePositions: true, nonce: 12n, deadline: DEADLINE }).digest,
      '0xd7ef89ad580b0dd870bb68feca617515f29e6ef2f7c55e169c4a812c2e7ae82f',
    ],
    [
      'InvalidateNonces',
      prepareInvalidateNonces(spec, { follower: f, word: 0n, mask: 255n, nonce: 13n, deadline: DEADLINE }).digest,
      '0x5f7248c2cac4d9524a32ff303bcf0f1509e5b7a68ac2df4ab973f8f8b215d21c',
    ],
  ];
  for (const [name, got, want] of cases) assert.equal(got, want, name);
});

test('the symbol commitment is the EIP-712 string[] hash (viem), keccak256("") when empty', () => {
  const lists: string[][] = [[], ['BTC-USD'], ['ETH-USD', 'BTC-USD'], ['BTC-USD', 'BTC-USD'], ['LONG-SYMBOL-NAME-OVER-32-BYTES-USD', 'vBTC_vUSDC']];
  for (const l of lists) {
    const want = l.length === 0 ? keccak256(new Uint8Array()) : keccak256(concat(l.map((s) => keccak256(toBytes(s)))));
    assert.equal(symbolsHash(l), want, JSON.stringify(l));
  }
  assert.notEqual(symbolsHash(['A', 'B']), symbolsHash(['B', 'A']), 'order is part of the commitment');
  assert.equal(symbolHash('BTC-USD'), keccak256(toBytes('BTC-USD')));
  // symbolsHash is exactly the `symbols` word of hashStruct(Terms).
  const t = validTerms({ symbols: ['X', 'Y', 'Z'] });
  const types = { Terms: typesFor('Subscribe')['Terms']! };
  const viaViem = viemHashStruct({ data: termsMessage(t), primaryType: 'Terms', types } as never);
  assert.equal(hashTerms(t), viaViem);
});

// ---------------------------------------------------------------------------
// Fuzz against viem
// ---------------------------------------------------------------------------

/** Terms with every field random within its SOLIDITY TYPE (protocol bounds do not matter to the encoding). */
function randomTerms(r: Rng): Terms {
  const n = (bits: number) => Number(r.uint(bits));
  return {
    delegatedKey: randomAddress(r),
    keyName: randomString(r, 40),
    marketScope: n(8) as Terms['marketScope'],
    sizingMode: n(8) as Terms['sizingMode'],
    sizingValue: r.uint(64),
    allocationCap: r.uint(64),
    maxPositionNotional: r.uint(64),
    maxLeverage: n(8),
    tradeStopLossBps: n(16),
    maxDrawdownBps: n(16),
    takeProfitBps: n(32),
    slippageBps: n(16),
    symbolMode: n(8) as Terms['symbolMode'],
    symbols: Array.from({ length: r.int(6) }, () => randomString(r, 40)),
    copyExisting: r.bool(),
    maxBuilderFeePerps: n(16),
    maxBuilderFeeSpot: n(16),
    expiry: n(40),
  };
}

function randomAction(type: CopyTradingPrimaryType, r: Rng): CopyTradingAction {
  const common = { follower: randomAddress(r), nonce: r.uint(256), deadline: r.uint(256) };
  switch (type) {
    case 'Subscribe':
      return { type, ...common, venue: Number(r.uint(8)), leader: randomAddress(r), sodexAccountId: r.uint(64), terms: randomTerms(r), stopEpoch: r.uint(64), expectedLastId: r.uint(256) };
    case 'UpdateSubscription':
      return { type, ...common, subscriptionId: r.uint(256), expectedVersion: Number(r.uint(32)), terms: randomTerms(r) };
    case 'PauseSubscription':
      return { type, ...common, subscriptionId: r.uint(256) };
    case 'ResumeSubscription':
      return { type, ...common, subscriptionId: r.uint(256), expectedVersion: Number(r.uint(32)) };
    case 'Unsubscribe':
      return { type, ...common, subscriptionId: r.uint(256), closePositions: r.bool() };
    case 'UnsubscribeAll':
      return { type, ...common, closePositions: r.bool() };
    case 'InvalidateNonces':
      return { type, ...common, word: r.uint(256), mask: r.uint(256) };
  }
}

for (const type of PRIMARY_TYPES) {
  test(`${type}: 150 random messages hash exactly as viem hashes them (and survive the wallet's JSON)`, () => {
    const r = rng(0x5eed + type.length * 131);
    for (let i = 0; i < 150; i++) {
      const chainId = r.bool() ? VALUECHAIN_CHAIN_ID : 1 + r.int(1_000_000);
      const p = prepareAction({ verifyingContract: randomAddress(r), chainId }, randomAction(type, r));
      assert.equal(viemHashTypedData(p.typedData as never), p.digest, `${type} #${i} digest`);
      assert.equal(
        viemHashStruct({ data: p.typedData.message, primaryType: type, types: p.typedData.types } as never),
        p.structHash,
        `${type} #${i} struct hash`,
      );
      const revived = reviveTypedData(JSON.parse(serializeTypedData(p.typedData)));
      assert.equal(hashTypedData(revived), p.digest, `${type} #${i} JSON round trip`);
      assert.equal(viemHashTypedData(revived as never), p.digest, `${type} #${i} JSON round trip (viem)`);
    }
  });
}

// ---------------------------------------------------------------------------
// Binding, domain and strictness
// ---------------------------------------------------------------------------

test('the digest binds the chain, the proxy, the action type, the stop epoch and the version', () => {
  const base = { follower: FOLLOWER, closePositions: true, nonce: 1n, deadline: 2n } as const;
  const sub = { follower: FOLLOWER, venue: 2, leader: LEADER, sodexAccountId: 1n, terms: validTerms(), expectedLastId: 0n, nonce: 1n, deadline: 2n };
  const digests = [
    prepareAction(spec, { type: 'UnsubscribeAll', ...base }).digest,
    prepareAction({ ...spec, chainId: 138_565 }, { type: 'UnsubscribeAll', ...base }).digest,
    prepareAction({ verifyingContract: '0x00000000000000000000000000000000c0ffee02' }, { type: 'UnsubscribeAll', ...base }).digest,
    prepareAction(spec, { type: 'PauseSubscription', follower: FOLLOWER, subscriptionId: 1n, nonce: 1n, deadline: 2n }).digest,
    prepareAction(spec, { type: 'Unsubscribe', follower: FOLLOWER, subscriptionId: 1n, closePositions: true, nonce: 1n, deadline: 2n }).digest,
    prepareAction(spec, { type: 'Subscribe', ...sub, stopEpoch: 0n }).digest,
    prepareAction(spec, { type: 'Subscribe', ...sub, stopEpoch: 1n }).digest,
    prepareAction(spec, { type: 'Subscribe', ...sub, stopEpoch: 0n, expectedLastId: 1n }).digest,
    prepareAction(spec, { type: 'ResumeSubscription', follower: FOLLOWER, subscriptionId: 1n, expectedVersion: 3, nonce: 1n, deadline: 2n }).digest,
    prepareAction(spec, { type: 'ResumeSubscription', follower: FOLLOWER, subscriptionId: 1n, expectedVersion: 4, nonce: 1n, deadline: 2n }).digest,
  ];
  assert.equal(new Set(digests).size, digests.length);
});

test('serializeTypedData keeps uint64/uint256 exact as decimal strings and lists exactly the needed types', () => {
  const p = prepareSubscribe(spec, {
    follower: FOLLOWER,
    venue: 2,
    leader: LEADER,
    sodexAccountId: (1n << 64n) - 1n,
    terms: validTerms({ allocationCap: (1n << 64n) - 1n }),
    stopEpoch: (1n << 64n) - 1n,
    expectedLastId: (1n << 256n) - 2n,
    nonce: (1n << 256n) - 1n,
    deadline: DEADLINE,
  });
  const j = JSON.parse(serializeTypedData(p.typedData));
  assert.equal(j.message.sodexAccountId, '18446744073709551615');
  assert.equal(j.message.stopEpoch, '18446744073709551615');
  assert.equal(j.message.expectedLastId, ((1n << 256n) - 2n).toString());
  assert.equal(j.message.nonce, ((1n << 256n) - 1n).toString());
  assert.equal(j.message.terms.allocationCap, '18446744073709551615');
  assert.equal(j.message.venue, 2, 'small integers stay numbers');
  assert.equal(j.domain.chainId, 286_623);
  assert.deepEqual(Object.keys(j.types).sort(), ['EIP712Domain', 'Subscribe', 'Terms']);
  assert.deepEqual(Object.keys(JSON.parse(serializeTypedData(prepareUnsubscribeAll(spec, { follower: FOLLOWER, closePositions: false, nonce: 0n, deadline: 0n }).typedData)).types).sort(), [
    'EIP712Domain',
    'UnsubscribeAll',
  ]);
  assert.deepEqual(Object.keys(WITH_SIG_FUNCTION).sort(), [...PRIMARY_TYPES].sort());
});

test('domainFromEip712Domain / isExpectedDomain follow the on-chain ERC-5267 domain (a version bump is noticed)', () => {
  const onChain = { fields: '0x0f' as const, name: EIP712_NAME, version: '1', chainId: 286_623n, verifyingContract: PROXY, salt: ZERO_BYTES32, extensions: [] };
  assert.deepEqual(domainFromEip712Domain(onChain), copyTradingDomain(spec));
  assert.equal(isExpectedDomain(onChain, spec), true);
  assert.equal(isExpectedDomain({ ...onChain, version: '2' }, spec), false, 'a deliberate domain bump');
  assert.equal(isExpectedDomain({ ...onChain, verifyingContract: LEADER }, spec), false, 'another contract (e.g. the implementation)');
  assert.equal(isExpectedDomain({ ...onChain, chainId: 1n }, spec), false);
  assert.throws(() => domainFromEip712Domain({ ...onChain, fields: '0x1f' }), /fields/);
  assert.throws(() => domainFromEip712Domain({ ...onChain, extensions: [1n] }), /salt or extensions/);
});

test('termsMessage range-checks every field against its Solidity type', () => {
  const bad: Array<[Partial<Terms>, RegExp]> = [
    [{ maxLeverage: 256 }, /uint8/],
    [{ slippageBps: 65_536 }, /uint16/],
    [{ takeProfitBps: 2 ** 32 }, /uint32/],
    [{ expiry: 2 ** 40 }, /uint40/],
    [{ sizingValue: 1n << 64n }, /uint64/],
    [{ allocationCap: -1n }, /uint64/],
    [{ maxDrawdownBps: 1.5 }, /safe integer|unsigned integer/],
    [{ delegatedKey: '0x1234' as never }, /address/],
    [{ copyExisting: 'yes' as never }, /boolean/],
    [{ symbols: [1 as never] }, /strings/],
  ];
  for (const [over, re] of bad) assert.throws(() => termsMessage(validTerms(over)), re, JSON.stringify(Object.keys(over)));
  for (const [over] of bad) assert.throws(() => termsMessage(validTerms(over)), TypedDataError);
});

test('prepareAction rejects bad domains and malformed actions', () => {
  const ua = { type: 'UnsubscribeAll', follower: FOLLOWER, closePositions: false, nonce: 0n, deadline: 0n } as const;
  assert.throws(() => prepareAction({ verifyingContract: '0xnope' as never }, ua), /verifyingContract/);
  assert.throws(() => copyTradingDomain({ verifyingContract: PROXY, chainId: 0 }), TypedDataError);
  assert.throws(() => prepareAction(spec, { ...ua, closePositions: 1 as never }), /boolean/);
  assert.throws(() => prepareAction(spec, { type: 'Nope' } as never), /unknown action type/);
  assert.throws(() => prepareAction(spec, { type: 'PauseSubscription', follower: FOLLOWER, subscriptionId: 1n << 256n, nonce: 0n, deadline: 0n }), /uint256/);
  assert.throws(() => prepareAction(spec, { type: 'InvalidateNonces', follower: FOLLOWER, word: -1n, mask: 0n, nonce: 0n, deadline: 0n }), /uint256/);
  assert.throws(
    () => prepareAction(spec, { type: 'Subscribe', follower: FOLLOWER, venue: 2, leader: LEADER, sodexAccountId: 1n, terms: validTerms(), stopEpoch: 1n << 64n, expectedLastId: 0n, nonce: 0n, deadline: 0n }),
    /uint64/,
  );
});

test('hashTypedData refuses extra and missing fields (a wallet would sign something else)', () => {
  const p = prepareUnsubscribe(spec, { follower: FOLLOWER, subscriptionId: 1n, closePositions: false, nonce: 0n, deadline: 0n });
  assert.throws(() => hashTypedData({ ...p.typedData, message: { ...p.typedData.message, extra: 1 } }), /not in type/);
  const { closePositions: _drop, ...missing } = p.typedData.message as Record<string, unknown>;
  assert.throws(() => hashTypedData({ ...p.typedData, message: missing }), /missing/);
});
