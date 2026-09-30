/**
 * The relayer: the wire format (strict, bigint-safe), transaction building with policy problems and ECDSA
 * normalisation, reading signed calls back (idempotency), revert classification, and the rate limiter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ABI,
  type CopyTradingAction,
  FixedWindowLimiter,
  type Hex,
  PRIMARY_TYPES,
  RELAYER_GAS_CAP,
  RelayError,
  actionFromCalldata,
  buildRelayTransaction,
  bytesToHex,
  classifyRevert,
  decodeCall,
  encodeErrorResult,
  hexToBytes,
  isIdBased,
  isSameSignedAction,
  isStopAction,
  nextFreeNonce,
  parseSignedAction,
  randomNonce,
  prepareAction,
  privateKeyToAddress,
  serializeSignedAction,
  signDigest,
  withSigCalldata,
  worksWhilePaused,
} from '../src/index.ts';
import { LEADER, NOW, PROXY, validTerms } from './helpers.ts';

/** A TEST-ONLY key for this file (public; never funded). */
const PK: Hex = `0x${'42'.repeat(32)}`;
const F = privateKeyToAddress(PK);
const deadline = BigInt(NOW + 900);

const actions: CopyTradingAction[] = [
  { type: 'Subscribe', follower: F, venue: 2, leader: LEADER, sodexAccountId: 224_678n, terms: validTerms({ sizingValue: (1n << 64n) - 1n, maxPositionNotional: 2_000_000_000n }), stopEpoch: 3n, expectedLastId: 5n, nonce: 1n << 200n, deadline },
  { type: 'UpdateSubscription', follower: F, subscriptionId: 7n, expectedVersion: 4, terms: validTerms(), nonce: 2n, deadline },
  { type: 'PauseSubscription', follower: F, subscriptionId: 7n, nonce: 3n, deadline },
  { type: 'ResumeSubscription', follower: F, subscriptionId: 7n, expectedVersion: 5, nonce: 4n, deadline },
  { type: 'Unsubscribe', follower: F, subscriptionId: 7n, closePositions: true, nonce: 5n, deadline },
  { type: 'UnsubscribeAll', follower: F, closePositions: false, nonce: 6n, deadline },
  { type: 'InvalidateNonces', follower: F, word: 0n, mask: 0xffn, nonce: 7n, deadline },
];

const signed = (a: CopyTradingAction, sig?: Hex) => {
  const prep = prepareAction({ verifyingContract: PROXY }, a);
  return { action: a, signature: sig ?? signDigest(prep.digest, PK), chainId: 286_623, verifyingContract: PROXY };
};

test('the wire format round-trips every action type exactly (bigints as decimal strings)', () => {
  assert.deepEqual([...PRIMARY_TYPES].sort(), actions.map((a) => a.type).sort());
  for (const a of actions) {
    const s = signed(a);
    const back = parseSignedAction(serializeSignedAction(s));
    assert.deepEqual(back, s, a.type);
  }
});

test('parseSignedAction is strict about untrusted input', () => {
  const good = JSON.parse(serializeSignedAction(signed(actions[0]!)));
  const bad = (mut: (o: Record<string, any>) => void, re: RegExp) => {
    const o = structuredClone(good);
    mut(o);
    assert.throws(() => parseSignedAction(JSON.stringify(o)), re);
  };
  bad((o) => (o.action.type = 'SetLeaderProfile'), /action.type/);
  bad((o) => (o.action.follower = '0x12'), /follower/);
  bad((o) => (o.action.nonce = '-1'), /nonce/);
  bad((o) => (o.action.stopEpoch = (1n << 64n).toString()), /uint64/);
  bad((o) => (o.action.terms.symbols = 'BTC-USD'), /symbols/);
  bad((o) => (o.action.terms.copyExisting = 'true'), /boolean/);
  bad((o) => (o.action.terms.maxLeverage = 256), /uint8/);
  bad((o) => (o.signature = '0x'), /signature/);
  bad((o) => (o.signature = 'nothex'), /signature/);
  assert.throws(() => parseSignedAction('{'), /not JSON/);
  assert.throws(() => parseSignedAction('x'.repeat(2_000_001)), /too large/);
  const many = structuredClone(good);
  many.action.terms.symbols = Array.from({ length: 10_001 }, () => 'A');
  assert.throws(() => parseSignedAction(JSON.stringify(many)), RelayError);
  assert.doesNotThrow(() => parseSignedAction(JSON.stringify(many), { maxSymbols: 20_000 }), 'relayer policy, not protocol');
});

test('buildRelayTransaction: calldata, digest, gas cap, the ECDSA path, and policy problems', () => {
  for (const a of actions) {
    const s = signed(a);
    const tx = buildRelayTransaction(s, { contract: PROXY, now: NOW });
    assert.deepEqual(tx.problems, [], a.type);
    assert.equal(tx.path, 'ecdsa');
    assert.equal(tx.gasLimit, RELAYER_GAS_CAP);
    assert.equal(tx.value, 0n);
    assert.equal(tx.data, withSigCalldata(a, { nonce: a.nonce, deadline: a.deadline, signature: s.signature }));
    assert.equal(decodeCall(tx.data).functionName.endsWith('WithSig'), true);
  }
  const sub = signed(actions[0]!);
  const p = (ctx: Partial<Parameters<typeof buildRelayTransaction>[1]>, s = sub) => buildRelayTransaction(s, { contract: PROXY, now: NOW, ...ctx }).problems;
  assert.match(p({ chainId: 1 })[0]!, /chainId/);
  assert.match(p({ contract: LEADER })[0]!, /another contract/);
  assert.match(p({ now: NOW + 880 })[0]!, /deadline/);
  assert.match(p({ currentStopEpoch: 4n })[0]!, /stop epoch 3/);
  assert.match(p({ paused: true })[0]!, /paused/);
  const unsub = signed(actions[4]!);
  assert.deepEqual(p({ paused: true }, unsub), [], 'stops work while paused');
  assert.match(p({ subscriptionFollower: LEADER }, unsub)[0]!, /not the follower/);
  assert.match(p({ currentVersion: 9 }, signed(actions[1]!))[0]!, /version 4/);
});

test('buildRelayTransaction normalises v = 0/1, high-s and EIP-2098 signatures to what OpenZeppelin accepts', () => {
  const a = actions[5]!;
  const good = signed(a).signature;
  const raw = hexToBytes(good);
  const v01 = bytesToHex(Uint8Array.from([...raw.subarray(0, 64), raw[64]! - 27]));
  const tx = buildRelayTransaction(signed(a, v01), { contract: PROXY, now: NOW });
  assert.equal(tx.path, 'ecdsa');
  assert.equal(tx.signature, good);
  // Not an ECDSA signature for the follower: passed through for an ERC-1271 wallet (simulate first).
  const other = buildRelayTransaction(signed(a, `0x${'ab'.repeat(100)}`), { contract: PROXY, now: NOW });
  assert.equal(other.path, 'erc1271?');
  assert.equal(other.signature, `0x${'ab'.repeat(100)}`);
});

test('actionFromCalldata and isSameSignedAction: the idempotency check after NonceAlreadyUsed', () => {
  for (const a of actions) {
    const s = signed(a);
    const data = withSigCalldata(a, { nonce: a.nonce, deadline: a.deadline, signature: s.signature });
    const back = actionFromCalldata(data, () => F);
    assert.ok(back);
    assert.deepEqual(back.action, a, a.type);
    assert.equal(back.signature, s.signature);
    assert.equal(isSameSignedAction({ verifyingContract: PROXY }, a, data, () => F), true);
    if (isIdBased(a.type)) assert.throws(() => actionFromCalldata(data, () => undefined), /unknown follower/);
  }
  const other = { ...actions[5]!, closePositions: true } as CopyTradingAction;
  const data = withSigCalldata(other, { nonce: other.nonce, deadline: other.deadline, signature: '0x01' });
  assert.equal(isSameSignedAction({ verifyingContract: PROXY }, actions[5]!, data, () => F), false, 'same nonce, another message');
  assert.equal(actionFromCalldata('0x12345678', () => F), null);
});

test('audit SEC-03: a NonceUsed for the same nonce is NOT proof that OUR stop landed; the digest check tells them apart', () => {
  // A resume and a stop signed before either landed, both with the first unused nonce (sequential choice).
  const resume: CopyTradingAction = { type: 'ResumeSubscription', follower: F, subscriptionId: 7n, expectedVersion: 2, nonce: 0n, deadline };
  const stop: CopyTradingAction = { type: 'Unsubscribe', follower: F, subscriptionId: 7n, closePositions: true, nonce: 0n, deadline };
  const landed = withSigCalldata(resume, { nonce: 0n, deadline, signature: signed(resume).signature });
  // The stop then reverts NonceAlreadyUsed(F, 0): the landed transaction is the resume, so the stop did NOT land.
  assert.equal(classifyRevert(encodeErrorResult(ABI, 'NonceAlreadyUsed', [F, 0n])).class, 'already-used');
  assert.equal(isSameSignedAction({ verifyingContract: PROXY }, stop, landed, () => F), false, 'report: not landed, re-sign');
  // The fix on the UI side: never let two pending messages share a nonce, and give stops random nonces.
  const reserved = new Set([0n]);
  assert.equal(nextFreeNonce(() => false, reserved), 1n);
  assert.equal(nextFreeNonce((n) => n < 5n, new Set([5n, 6n])), 7n);
  const r1 = randomNonce();
  const r2 = randomNonce();
  assert.notEqual(r1, r2);
  assert.ok(r1 >= 0n && r1 < 1n << 256n);
  assert.equal(randomNonce(() => new Uint8Array(32).fill(0xff)), (1n << 256n) - 1n);
  assert.throws(() => randomNonce(() => new Uint8Array(31)), RelayError);
});

test('relayer spam policy: only keys Valuescan issued for this follower and account are relayed', () => {
  const issued = new Map([[validTerms().delegatedKey.toLowerCase(), { follower: F.toLowerCase(), account: 224_678n }]]);
  const isValuescanKey = (key: string, follower: string, account: bigint | undefined) => {
    const i = issued.get(key.toLowerCase());
    return !!i && i.follower === follower.toLowerCase() && (account === undefined || i.account === account);
  };
  const sub = actions[0]!;
  assert.deepEqual(buildRelayTransaction(signed(sub), { contract: PROXY, now: NOW, isValuescanKey }).problems, []);
  const foreign = { ...sub, sodexAccountId: 1n } as CopyTradingAction;
  assert.match(buildRelayTransaction(signed(foreign), { contract: PROXY, now: NOW, isValuescanKey }).problems[0]!, /not issued by Valuescan/);
  const upd = actions[1]!;
  assert.deepEqual(buildRelayTransaction(signed(upd), { contract: PROXY, now: NOW, isValuescanKey, subscriptionAccount: 224_678n }).problems, []);
  assert.match(buildRelayTransaction(signed(upd), { contract: PROXY, now: NOW, isValuescanKey, subscriptionAccount: 9n }).problems[0]!, /not issued/);
  assert.deepEqual(buildRelayTransaction(signed(actions[4]!), { contract: PROXY, now: NOW, isValuescanKey: () => false }).problems, [], 'stops are always relayed');
});

test('classifyRevert maps every contract error a relayer can meet', () => {
  const c = (name: string, args: unknown[]) => classifyRevert(encodeErrorResult(ABI, name, args)).class;
  assert.equal(c('NonceAlreadyUsed', [F, 1n]), 'already-used');
  assert.equal(c('SignatureExpired', [1n]), 'expired');
  assert.equal(c('InvalidSignature', [F]), 'bad-signature');
  assert.equal(c('VersionMismatch', [1n, 1, 2]), 'stale');
  assert.equal(c('InvalidStatus', [1n, 3]), 'stale');
  assert.equal(c('StopEpochMismatch', [F, 0n, 1n]), 'stale');
  assert.equal(c('EnforcedPause', []), 'paused');
  for (const [n, a] of [
    ['InvalidTerms', [3]],
    ['UnknownSubscription', [1n]],
    ['DuplicateSubscription', [1n]],
    ['VenueDisabled', [2]],
    ['NotFollower', [1n, F]],
    ['FundsNotAccepted', []],
  ] as const) {
    assert.equal(c(n, [...a]), 'rejected', n);
  }
  assert.equal(classifyRevert('0x').class, 'unknown');
  assert.equal(classifyRevert(undefined).class, 'unknown');
  assert.equal(classifyRevert('0xdeadbeef').class, 'unknown');
  assert.deepEqual(classifyRevert(encodeErrorResult(ABI, 'StopEpochMismatch', [F, 0n, 1n])).args, { follower: F, expected: 0n, actual: 1n });
});

test('stop classification and the rate limiter', () => {
  assert.deepEqual(PRIMARY_TYPES.filter(isStopAction), ['PauseSubscription', 'Unsubscribe', 'UnsubscribeAll']);
  assert.deepEqual(PRIMARY_TYPES.filter(worksWhilePaused), ['PauseSubscription', 'Unsubscribe', 'UnsubscribeAll', 'InvalidateNonces']);
  const l = new FixedWindowLimiter(2, 1000);
  assert.equal(l.take('a', 0), true);
  assert.equal(l.take('a', 1), true);
  assert.equal(l.take('a', 2), false);
  assert.equal(l.retryAfterMs('a', 2), 998);
  assert.equal(l.take('a', 1000), true, 'a new window');
  l.prune(5000);
  assert.equal(l.size, 0);
  assert.throws(() => new FixedWindowLimiter(0, 1), RangeError);
});
