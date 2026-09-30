/**
 * The ABI codec and the typed calldata/result/event/error wrappers, against viem, over the WHOLE committed ABI (and
 * the TimelockController's): every function (calldata both ways, return data), every event and every custom error,
 * with seeded random values. Plus the strictness a Solidity decoder has (dirty bits, bad bools, truncation).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeErrorResult as viemDecodeError,
  decodeEventLog as viemDecodeEventLog,
  decodeFunctionData as viemDecodeFunctionData,
  decodeFunctionResult as viemDecodeFunctionResult,
  encodeAbiParameters as viemEncodeAbiParameters,
  encodeErrorResult as viemEncodeError,
  encodeEventTopics as viemEncodeEventTopics,
  encodeFunctionData as viemEncodeFunctionData,
  encodeFunctionResult as viemEncodeFunctionResult,
  toEventSelector,
  toFunctionSelector,
} from 'viem';

import {
  ABI,
  type Abi,
  type AbiErrorItem,
  type AbiEventItem,
  type AbiFunctionItem,
  AbiError,
  EVENT_NAMES,
  EVENT_TOPICS,
  type Hex,
  type RpcLog,
  TIMELOCK_ABI,
  addressTopic,
  attachBlockTimestamps,
  blocksNeedingTimestamps,
  calls,
  decodeAbiParameters,
  decodeCall,
  decodeCopyTradingLog,
  decodeCopyTradingLogs,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionData,
  decodeFunctionResult,
  decodeRevert,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventLog,
  encodeFunctionData,
  encodeFunctionResult,
  followerLogFilters,
  functionSelector,
  logFilter,
  results,
  selectorOf,
  signatureOf,
  Status,
  storedSubscription,
  subscriptionIdFromReceipt,
  symbolsHash,
  symbolsMatchCommitment,
  timelockControllerAbi,
  toChecksumAddress,
  uintTopic,
  valuescanCopyTradingAbi,
} from '../src/index.ts';
import { FOLLOWER, LEADER, NOW, PROXY, norm, rng, sampleAbiValue, validTerms } from './helpers.ts';

const both: Array<[string, Abi, unknown]> = [
  ['ValuescanCopyTrading', ABI, valuescanCopyTradingAbi],
  ['TimelockController', TIMELOCK_ABI, timelockControllerAbi],
];

test('selectors and topics equal viem’s', () => {
  for (const [label, abi] of both) {
    for (const f of abi.filter((i): i is AbiFunctionItem => i.type === 'function')) {
      assert.equal(selectorOf(f), toFunctionSelector(signatureOf(f)), `${label}.${f.name}`);
    }
  }
  for (const f of ABI.filter((i): i is AbiFunctionItem => i.type === 'function')) {
    assert.equal(functionSelector(f.name as never), toFunctionSelector(signatureOf(f)), f.name);
  }
  for (const e of ABI.filter((i): i is AbiEventItem => i.type === 'event')) {
    assert.equal(EVENT_TOPICS[e.name as keyof typeof EVENT_TOPICS], toEventSelector(signatureOf(e)), e.name);
  }
  assert.deepEqual(
    [...EVENT_NAMES].sort(),
    ABI.filter((i) => i.type === 'event').map((e) => (e as AbiEventItem).name).sort(),
    'EVENT_NAMES lists every event',
  );
});

for (const [label, abi, raw] of both) {
  const fns = abi.filter((i): i is AbiFunctionItem => i.type === 'function');
  const events = abi.filter((i): i is AbiEventItem => i.type === 'event');
  const errors = abi.filter((i): i is AbiErrorItem => i.type === 'error');

  test(`${label}: every function's random calldata encodes like viem and decodes back`, () => {
    const r = rng(0xabc1 + label.length);
    for (const f of fns) {
      for (let i = 0; i < 20; i++) {
        const args = f.inputs.map((p) => sampleAbiValue(p, r));
        const ours = encodeFunctionData(abi, f.name, args);
        const theirs = viemEncodeFunctionData({ abi: raw, functionName: f.name, args } as never);
        assert.equal(ours, theirs, `${f.name} #${i} calldata`);
        const back = decodeFunctionData(abi, ours);
        assert.equal(back.functionName, f.name);
        assert.deepEqual(norm(back.args), norm(args), `${f.name} #${i} decodes to the inputs`);
        assert.deepEqual(norm(back.args), norm(viemDecodeFunctionData({ abi: raw, data: ours } as never).args ?? []), `${f.name} #${i} vs viem`);
      }
    }
  });

  test(`${label}: every function's random return data decodes like viem`, () => {
    const r = rng(0xabc2 + label.length);
    for (const f of fns) {
      if (f.outputs.length === 0) continue;
      for (let i = 0; i < 20; i++) {
        const values = f.outputs.map((p) => sampleAbiValue(p, r));
        const data = viemEncodeFunctionResult({ abi: raw, functionName: f.name, result: f.outputs.length === 1 ? values[0] : values } as never);
        assert.equal(encodeFunctionResult(abi, f.name, values), data, `${f.name} #${i} encode`);
        assert.deepEqual(norm(decodeFunctionResult(abi, f.name, data)), norm(viemDecodeFunctionResult({ abi: raw, functionName: f.name, data } as never)), `${f.name} #${i}`);
      }
    }
  });

  test(`${label}: every event's random logs encode and decode like viem`, () => {
    const r = rng(0xabc3 + label.length);
    for (const e of events) {
      for (let i = 0; i < 20; i++) {
        const args: Record<string, unknown> = {};
        for (const p of e.inputs) args[p.name!] = sampleAbiValue(p, r);
        const topics = viemEncodeEventTopics({ abi: raw, eventName: e.name, args } as never) as Hex[];
        const plain = e.inputs.filter((p) => !p.indexed);
        const data = viemEncodeAbiParameters(plain as never, plain.map((p) => args[p.name!]) as never);
        assert.deepEqual(encodeEventLog(abi, e.name, args), { topics, data }, `${e.name} #${i} encode`);
        const ours = decodeEventLog(abi, { topics, data });
        const theirs = viemDecodeEventLog({ abi: raw, topics: topics as never, data } as never);
        assert.equal(ours.eventName, e.name);
        assert.deepEqual(norm(ours.args), norm(theirs.args ?? {}), `${e.name} #${i} decode`);
      }
    }
  });

  test(`${label}: every custom error's revert data decodes like viem`, () => {
    const r = rng(0xabc4 + label.length);
    for (const e of errors) {
      const args = e.inputs.map((p) => sampleAbiValue(p, r));
      const data = viemEncodeError({ abi: raw, errorName: e.name, args } as never);
      assert.equal(encodeErrorResult(abi, e.name, args), data, e.name);
      const ours = decodeErrorResult(abi, data);
      const theirs = viemDecodeError({ abi: raw, data } as never);
      assert.equal(ours.errorName, theirs.errorName);
      assert.deepEqual(norm(Object.values(ours.args)), norm(theirs.args ?? []), e.name);
    }
  });
}

test('decodeCopyTradingLog: every contract event through the typed decoder, with its position', () => {
  const r = rng(0xabc5);
  for (const e of ABI.filter((i): i is AbiEventItem => i.type === 'event')) {
    const args: Record<string, unknown> = {};
    for (const p of e.inputs) args[p.name!] = sampleAbiValue(p, r);
    const { topics, data } = encodeEventLog(ABI, e.name, args);
    const ev = decodeCopyTradingLog({ address: PROXY, topics, data, blockNumber: '0x10', logIndex: '0x2', blockTimestamp: '0x6a' });
    assert.ok(ev);
    assert.equal(ev.eventName, e.name);
    assert.deepEqual(norm(ev.args), norm(args), e.name);
    assert.equal(ev.blockNumber, 16n);
    assert.equal(ev.logIndex, 2);
    assert.equal(ev.blockTimestamp, 106);
  }
});

test('Solidity built-in errors and bad revert data', () => {
  assert.deepEqual(
    decodeErrorResult(ABI, viemEncodeError({ abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }], errorName: 'Error', args: ['boom'] })),
    { errorName: 'Error', args: { message: 'boom' } },
  );
  assert.deepEqual(decodeRevert('0x4e487b710000000000000000000000000000000000000000000000000000000000000011'), {
    errorName: 'Panic',
    args: { code: 17n },
  });
  assert.throws(() => decodeRevert('0x'), /no selector/);
  assert.throws(() => decodeRevert('0xdeadbeef'), /unknown error selector/);
  assert.deepEqual(decodeRevert(encodeErrorResult(ABI, 'StopEpochMismatch', [FOLLOWER, 0n, 1n])), {
    errorName: 'StopEpochMismatch',
    args: { follower: FOLLOWER, expected: 0n, actual: 1n },
  });
});

test('typed calls.* builders equal viem with normalised arguments (every ...WithSig and the new functions)', () => {
  const abi = valuescanCopyTradingAbi;
  const terms = validTerms();
  const sig = { nonce: 7n, deadline: 1_790_000_900n, signature: `0x${'11'.repeat(65)}` as Hex };
  const cases: Array<[string, Hex, unknown[]]> = [
    ['subscribe', calls.subscribe(2, LEADER, 5n, terms), [2, LEADER, 5n, terms]],
    ['subscribeWithSig', calls.subscribeWithSig(FOLLOWER, 2, LEADER, 5n, terms, 3n, 9n, sig), [FOLLOWER, 2, LEADER, 5n, terms, 3n, 9n, sig]],
    ['updateSubscription', calls.updateSubscription(3n, terms), [3n, terms]],
    ['updateSubscriptionWithSig', calls.updateSubscriptionWithSig(3n, 4, terms, sig), [3n, 4, terms, sig]],
    ['pauseSubscriptionWithSig', calls.pauseSubscriptionWithSig(3n, sig), [3n, sig]],
    ['resumeSubscriptionWithSig', calls.resumeSubscriptionWithSig(3n, 4, sig), [3n, 4, sig]],
    ['unsubscribeWithSig', calls.unsubscribeWithSig(3n, true, sig), [3n, true, sig]],
    ['unsubscribeAllWithSig', calls.unsubscribeAllWithSig(FOLLOWER, false, sig), [FOLLOWER, false, sig]],
    ['invalidateNoncesWithSig', calls.invalidateNoncesWithSig(FOLLOWER, 0n, 0xffn, sig), [FOLLOWER, 0n, 0xffn, sig]],
    ['commitExecutions', calls.commitExecutions(497_222n, `0x${'ab'.repeat(32)}`, 5, 'ipfs://y'), [497_222n, `0x${'ab'.repeat(32)}`, 5, 'ipfs://y']],
    ['setExecutor', calls.setExecutor(FOLLOWER, true), [FOLLOWER, true]],
    ['upgradeToAndCall', calls.upgradeToAndCall(LEADER), [LEADER, '0x']],
    ['initialize', calls.initialize(FOLLOWER, 1n, 50, 100, [LEADER]), [FOLLOWER, 1n, 50, 100, [LEADER]]],
    ['stopDetails', calls.stopDetails(9n), [9n]],
    ['killSwitchInfo', calls.killSwitchInfo(FOLLOWER, 2n), [FOLLOWER, 2n]],
    ['subscriptionsOfLeader', calls.subscriptionsOfLeader(2, LEADER, 0n, 100n), [2, LEADER, 0n, 100n]],
    ['liveSubscriptionsOfFollower', calls.liveSubscriptionsOfFollower(FOLLOWER, 5n, 10n), [FOLLOWER, 5n, 10n]],
  ];
  for (const [name, ours, args] of cases) {
    assert.equal(ours, viemEncodeFunctionData({ abi, functionName: name, args } as never), name);
    assert.equal(decodeCall(ours).functionName, name);
  }
  // Terms and signature params are range-checked on the way in.
  assert.throws(() => calls.subscribe(2, LEADER, 5n, validTerms({ maxLeverage: 300 })), /uint8/);
  assert.throws(() => calls.pauseSubscriptionWithSig(1n, { ...sig, nonce: -1n }), /uint256/);
  assert.throws(() => calls.pauseSubscriptionWithSig(1n, { ...sig, signature: 'nope' as Hex }), /hex/);
});

test('typed results.* decoders', () => {
  const rec = {
    follower: FOLLOWER,
    status: 1,
    venue: 2,
    marketScope: 1,
    sizingMode: 1,
    symbolMode: 1,
    copyExisting: false,
    maxLeverage: 5,
    closePositions: false,
    version: 1,
    leader: LEADER,
    createdAt: NOW,
    updatedAt: NOW,
    slippageBps: 50,
    delegatedKey: '0x2222222222222222222222222222222222222222',
    expiry: 0,
    takeProfitBps: 5000,
    tradeStopLossBps: 500,
    sodexAccountId: 224_678n,
    stopEpoch: 3n,
    sizingValue: 1_000_000n,
    maxDrawdownBps: 2000,
    maxBuilderFeePerps: 50,
    maxBuilderFeeSpot: 0,
    allocationCap: 1_000_000_000n,
    maxPositionNotional: 2_500_000_000n,
    symbolsHash: symbolsHash(['BTC-USD']),
    keyName: 'vs-000001',
  };
  assert.deepEqual(norm(results.getSubscription(encodeFunctionResult(ABI, 'getSubscription', [rec]))), norm(rec));
  assert.deepEqual(results.effectiveBuilderFee(encodeFunctionResult(ABI, 'effectiveBuilderFee', [7n, 30, 0])), { builderId: 7n, perpsFee: 30, spotFee: 0 });
  assert.deepEqual(results.stopDetails(encodeFunctionResult(ABI, 'stopDetails', [1, true, NOW])), { reason: 1, closePositions: true, stoppedAt: NOW });
  assert.deepEqual(results.subscriptionsOfLeader(encodeFunctionResult(ABI, 'subscriptionsOfLeader', [[3n, 9n], 2n])), { ids: [3n, 9n], total: 2n });
  assert.deepEqual(results.liveSubscriptionsOfFollower(encodeFunctionResult(ABI, 'liveSubscriptionsOfFollower', [[7n, 6n], 2n])), { ids: [7n, 6n], total: 2n });
  assert.deepEqual(results.killSwitchInfo(encodeFunctionResult(ABI, 'killSwitchInfo', [{ triggeredAt: NOW, closePositions: true }])), { triggeredAt: NOW, closePositions: true });
  assert.deepEqual(results.executorInfo(encodeFunctionResult(ABI, 'executorInfo', [{ authorised: true, updatedAt: NOW, lastEpoch: 9n }])), { authorised: true, updatedAt: NOW, lastEpoch: 9n });
  assert.equal(results.stopEpochOf(encodeFunctionResult(ABI, 'stopEpochOf', [4n])), 4n);
  assert.equal(results.statusOf(encodeFunctionResult(ABI, 'statusOf', [3])), 3);
  assert.equal(results.subscriptionId(encodeFunctionResult(ABI, 'subscribeWithSig', [42n])), 42n);
  assert.equal(results.stopEpoch(encodeFunctionResult(ABI, 'unsubscribeAllWithSig', [2n])), 2n);
  const dom = results.eip712Domain(encodeFunctionResult(ABI, 'eip712Domain', ['0x0f', 'ValuescanCopyTrading', '1', 286_623n, PROXY, `0x${'00'.repeat(32)}`, []]));
  assert.deepEqual(norm(dom), norm({ fields: '0x0f', name: 'ValuescanCopyTrading', version: '1', chainId: 286_623n, verifyingContract: toChecksumAddress(PROXY), salt: `0x${'00'.repeat(32)}`, extensions: [] }));
});

test('decoding is strict like Solidity’s decoder', () => {
  const addr = [{ name: 'a', type: 'address' }] as const;
  assert.throws(() => decodeAbiParameters(addr, `0x01${'00'.repeat(11)}${'11'.repeat(20)}`), /dirty/);
  assert.throws(() => decodeAbiParameters([{ type: 'bool' }], `0x${'00'.repeat(31)}02`), /neither 0 nor 1/);
  assert.throws(() => decodeAbiParameters([{ type: 'uint8' }], `0x${'00'.repeat(30)}0100`), /dirty high bits/);
  assert.throws(() => decodeAbiParameters([{ type: 'bytes4' }], `0x12345678${'00'.repeat(27)}01`), /dirty padding/);
  assert.throws(() => decodeAbiParameters([{ type: 'uint256' }], `0x${'00'.repeat(31)}`), /too short/);
  assert.throws(() => decodeAbiParameters([{ type: 'string' }], `0x${'00'.repeat(31)}40`), /exceeds|too short/);
  assert.throws(() => decodeAbiParameters([{ type: 'uint256[]' }], `0x${'00'.repeat(31)}20${'00'.repeat(31)}05`), /exceeds the data/);
  assert.throws(() => encodeAbiParameters([{ type: 'uint16' }], [70_000]), AbiError);
  assert.throws(() => encodeAbiParameters([{ type: 'bytes32' }], ['0x12']), /exactly 32 bytes/);
  assert.throws(() => encodeAbiParameters([{ type: 'address' }], ['0x12']), /address/);
  assert.throws(() => encodeAbiParameters([{ type: 'bool' }], [1]), /boolean/);
  assert.throws(() => decodeCall('0x12'), /shorter than a selector/);
  assert.throws(() => decodeCall('0x12345678'), /unknown function selector/);
});

test('log helpers: foreign logs are skipped, positions are required, sorting, filters, timestamps, receipts', () => {
  const ev = encodeEventLog(ABI, 'ExecutorSet', { executor: FOLLOWER, authorised: false });
  const mk = (blockNumber: Hex, logIndex: Hex, address: string = PROXY): RpcLog => ({ address, ...ev, blockNumber, logIndex });
  assert.equal(decodeCopyTradingLog({ ...mk('0x1', '0x0'), topics: [`0x${'00'.repeat(32)}`] }), null, 'unknown topic');
  assert.equal(decodeCopyTradingLog(mk('0x1', '0x0', '0x0000000000000000000000000000000000000001'), PROXY), null, 'other contract');
  assert.throws(() => decodeCopyTradingLog({ address: PROXY, ...ev }), /blockNumber/);
  const sorted = decodeCopyTradingLogs([mk('0x2', '0x0'), mk('0x1', '0x5'), mk('0x1', '0x1')], PROXY);
  assert.deepEqual(sorted.map((e) => `${e.blockNumber}:${e.logIndex}`), ['1:1', '1:5', '2:0']);
  assert.deepEqual(blocksNeedingTimestamps(sorted), [1n, 2n], 'ExecutorSet needs block timestamps');
  const stamped = attachBlockTimestamps(sorted, new Map([[1n, 100], [2n, 102]]));
  assert.deepEqual(stamped.map((e) => e.blockTimestamp), [100, 100, 102]);
  assert.deepEqual(blocksNeedingTimestamps(stamped), []);
  assert.deepEqual(logFilter(PROXY, 100n, 'latest', ['Subscribed', 'KillSwitchTriggered']), {
    address: PROXY,
    fromBlock: '0x64',
    toBlock: 'latest',
    topics: [[EVENT_TOPICS.Subscribed, EVENT_TOPICS.KillSwitchTriggered]],
  });
  const [a, b] = followerLogFilters(PROXY, FOLLOWER, 1, 'latest');
  assert.deepEqual(a!.topics![2], addressTopic(FOLLOWER));
  assert.equal(a!.topics![1], null);
  assert.deepEqual(b!.topics![1], addressTopic(FOLLOWER));
  assert.equal(uintTopic(5n), `0x${'00'.repeat(31)}05`);
  // A receipt of subscribeWithSig: NonceUsed first, then Subscribed.
  const terms = validTerms();
  const record = storedSubscription({ follower: FOLLOWER, venue: 2, leader: LEADER, sodexAccountId: 1n }, terms, {
    status: Status.ACTIVE,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    stopEpoch: 0n,
  });
  const subscribed = encodeEventLog(ABI, 'Subscribed', { subscriptionId: 42n, follower: FOLLOWER, leader: LEADER, subscription: record, symbols: terms.symbols });
  const nonceUsed = encodeEventLog(ABI, 'NonceUsed', { signer: FOLLOWER, nonce: 3n });
  const receipt: { logs: RpcLog[] } = { logs: [nonceUsed, subscribed].map((l, i) => ({ ...l, address: PROXY, blockNumber: '0x9' as Hex, logIndex: `0x${i}` as Hex })) };
  assert.equal(subscriptionIdFromReceipt(receipt, PROXY), 42n);
  // The event's symbol list against the record's commitment (a tampered list is detected).
  const good = decodeCopyTradingLog(receipt.logs[1]!)!;
  assert.equal(symbolsMatchCommitment(good), true);
  const tampered = encodeEventLog(ABI, 'Subscribed', { subscriptionId: 42n, follower: FOLLOWER, leader: LEADER, subscription: record, symbols: ['ETH-USD', 'BTC-USD'] });
  assert.equal(symbolsMatchCommitment(decodeCopyTradingLog({ ...tampered, address: PROXY, blockNumber: 9n, logIndex: 1 })!), false);
});
