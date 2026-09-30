/**
 * The committed cross-implementation vectors (test/vectors.json), which contracts/test/CrossCheckVectors.t.sol replays
 * against the REAL contract behind an ERC1967Proxy:
 *   - both committed files are exactly what tools/gen-vectors.ts produces now;
 *   - every signed vector checks out with viem (digest, recovered signer, calldata);
 *   - every expected log decodes the same with the package and with viem;
 *   - an index rebuilt ONLY from the decoded logs answers every view exactly as the contract did (the Foundry-verified
 *     return data), including the stop-epoch rule and the live set's swap-and-pop order;
 *   - the execution tree, the governance operations and the invalid-terms cases are reproduced independently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  concat,
  decodeEventLog as viemDecodeEventLog,
  decodeFunctionData as viemDecodeFunctionData,
  encodeAbiParameters,
  hashTypedData as viemHashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
} from 'viem';
import { privateKeyToAddress as viemPrivateKeyToAddress } from 'viem/accounts';

import {
  type Address,
  ChainView,
  CopyTradingIndex,
  type CopyTradingAction,
  type CopyTradingEvent,
  EXECUTION_LEAF_PARAMS,
  EXECUTION_LEAF_TAG,
  type Hex,
  WITH_SIG_FUNCTION,
  actionFromCalldata,
  buildMerkleTree,
  classifyRevert,
  decodeCopyTradingLog,
  decodeTimelockLog,
  describeScheduledCall,
  executionLeaf,
  keccakUtf8,
  results,
  sameAddress,
  subscriptionProblems,
  timelockControllerAbi,
  valuescanCopyTradingAbi,
  verifyMerkleProof,
} from '../src/index.ts';
import { FOUNDRY_TEST, buildVectors, renderFoundryTest, renderVectorsJson, sameSolidity } from '../tools/gen-vectors.ts';
import { type Json, norm, reviveBigints, reviveTypedData, vectors } from './helpers.ts';

const BIG_KEYS = new Set([
  'sodexAccountId',
  'sizingValue',
  'allocationCap',
  'maxPositionNotional',
  'stopEpoch',
  'expectedLastId',
  'nonce',
  'deadline',
  'subscriptionId',
  'word',
  'mask',
  'quantity',
  'limitPrice',
  'leaderFillTimeMs',
  'followerOrderTimeMs',
  'epoch',
]);
const PROXY: Address = vectors.contracts.proxy;
const TIMELOCK: Address = vectors.contracts.timelock;

test('the committed vectors.json and CrossCheckVectors.t.sol are what the generator produces now', () => {
  const v = buildVectors();
  assert.equal(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8').replace(/\r\n/g, '\n'), renderVectorsJson(v), 'run npm run vectors');
  assert.ok(sameSolidity(readFileSync(FOUNDRY_TEST, 'utf8'), renderFoundryTest(v)), 'contracts/test/CrossCheckVectors.t.sol is stale: run npm run vectors');
});

test('TEST-ONLY keys are keccak256 of their public labels', () => {
  for (const k of Object.values(vectors.testKeys) as Json[]) {
    assert.equal(k.privateKey, keccakUtf8(k.label));
    assert.equal(k.address, viemPrivateKeyToAddress(k.privateKey));
    assert.match(k.label, /TEST-ONLY .* never fund/);
  }
});

test('every signed vector: viem digest, viem-recovered signer, calldata, and the action read back from calldata', async () => {
  assert.ok(vectors.signed.length >= 14);
  const types = new Set<string>();
  const followers = new Map<bigint, Address>();
  for (const s of vectors.steps as Json[]) {
    for (const l of s.logs) if (l.eventName === 'Subscribed') followers.set(BigInt(l.args.subscriptionId), l.args.follower);
  }
  for (const s of vectors.signed as Json[]) {
    types.add(`${s.primaryType}/${s.signerRole}`);
    const td = reviveTypedData(s.typedData);
    assert.equal(viemHashTypedData(td), s.digest, `${s.name}: digest`);
    const recovered = await recoverTypedDataAddress({ ...td, signature: s.signature });
    assert.ok(sameAddress(recovered, s.keyAddress), `${s.name}: signer`);
    if (s.signerRole === 'follower') assert.ok(sameAddress(s.keyAddress, s.follower));
    else assert.ok(!sameAddress(s.keyAddress, s.follower), 'a wallet owner or a wrong key signs for another address');
    const call = viemDecodeFunctionData({ abi: valuescanCopyTradingAbi, data: s.callData });
    assert.equal(call.functionName, WITH_SIG_FUNCTION[s.primaryType as keyof typeof WITH_SIG_FUNCTION]);
    assert.equal((call.args!.at(-1) as { signature: Hex }).signature, s.signature);
    const back = actionFromCalldata(s.callData, (id) => followers.get(id));
    assert.ok(back);
    assert.deepEqual(norm(back.action), norm(reviveBigints<CopyTradingAction>(s.action, BIG_KEYS)), `${s.name}: action`);
  }
  for (const t of ['Subscribe', 'UpdateSubscription', 'PauseSubscription', 'ResumeSubscription', 'Unsubscribe', 'UnsubscribeAll', 'InvalidateNonces']) {
    assert.ok(types.has(`${t}/follower`), `${t} signed by the EOA follower`);
    assert.ok(types.has(`${t}/wallet`), `${t} signed through the ERC-1271 wallet`);
  }
});

/** Every expected log decodes identically with the package and viem; returns the decoded contract events in order. */
function decodedEvents(): CopyTradingEvent[] {
  const out: CopyTradingEvent[] = [];
  let block = 1n;
  const push = (logs: Json[], timestamp: number) => {
    let i = 0;
    for (const l of logs) {
      if (l.emitter !== PROXY) continue;
      const ev = decodeCopyTradingLog({ address: PROXY, topics: l.topics, data: l.data, blockNumber: block, logIndex: i++, blockTimestamp: timestamp });
      assert.ok(ev, l.eventName);
      const viem = viemDecodeEventLog({ abi: valuescanCopyTradingAbi, topics: l.topics, data: l.data });
      assert.equal(ev.eventName, viem.eventName);
      assert.deepEqual(norm(ev.args), norm(viem.args ?? {}), l.eventName);
      assert.deepEqual(norm(ev.args), l.args, `${l.eventName}: the vector's decoded args`);
      out.push(ev);
    }
    block++;
  };
  push(vectors.deployment.logs, vectors.deployment.time);
  for (const s of vectors.steps as Json[]) {
    if (s.success) push(s.logs, s.timestamp);
    else {
      assert.equal(s.logs.length, 0);
      assert.equal(classifyRevert(s.returnData).errorName, s.errorName, s.name);
    }
  }
  return out;
}

/** Canonical JSON: bigints as decimal strings, hex (addresses included) in lower case. */
const canon = (v: unknown): Json =>
  v === undefined
    ? undefined
    : JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : typeof x === 'string' && /^0x[0-9a-fA-F]*$/.test(x) ? x.toLowerCase() : x)));

/**
 * One view vector (the contract's Foundry-verified answer) against the index's answer: [contract, index], or null when
 * the view is not event state (VERSION, DOMAIN_SEPARATOR, eip712Domain, proxiableUUID).
 */
function viewPair(idx: CopyTradingIndex, w: Json, now: number): [Json, Json] | null {
  const a: Json[] = (w.args as unknown[]).map((x) => (typeof x === 'string' && /^\d+$/.test(x) ? BigInt(x) : x));
  if (!w.success) {
    const reverting: Record<string, () => unknown> = {
      getSubscription: () => idx.getSubscription(a[0]),
      stopDetails: () => idx.stopDetails(a[0]),
      effectiveBuilderFee: () => idx.effectiveBuilderFee(a[0]),
    };
    const f = reverting[w.functionName];
    return f ? ['reverts', f() === undefined ? 'reverts' : canon(f())] : null;
  }
  const mine: Record<string, () => unknown> = {
    getSubscription: () => idx.getSubscription(a[0]),
    statusOf: () => idx.statusOf(a[0]),
    stopDetails: () => idx.stopDetails(a[0]),
    subscriptionCount: () => idx.subscriptionCount,
    subscriptionsOfFollower: () => idx.subscriptionsOfFollower(a[0], a[1], a[2]),
    liveSubscriptionsOfFollower: () => idx.liveSubscriptionsOfFollower(a[0], a[1], a[2]),
    subscriptionsOfLeader: () => idx.subscriptionsOfLeader(Number(a[0]), a[1], a[2], a[3]),
    liveSubscriptionFor: () => idx.liveSubscriptionFor(a[0], a[1], Number(a[2]), a[3]),
    isCopyable: () => idx.isCopyable(a[0], now),
    stopEpochOf: () => idx.stopEpochOf(a[0]),
    killSwitchInfo: () => idx.killSwitchInfo(a[0], a[1]),
    effectiveBuilderFee: () => idx.effectiveBuilderFee(a[0]),
    builderTerms: () => idx.builderTerms,
    isExecutor: () => idx.isExecutor(a[0]),
    executorInfo: () => idx.executorInfo(a[0]),
    commitment: () => idx.commitment(a[0], a[1]),
    venueInfo: () => idx.venueInfo(Number(a[0])),
    isNonceUsed: () => idx.isNonceUsed(a[0], a[1]),
    nonceBitmap: () => idx.nonceBitmap(a[0], a[1]),
    owner: () => idx.owner,
    pendingOwner: () => idx.pendingOwner,
    paused: () => idx.paused,
  };
  const f = mine[w.functionName];
  if (!f) return null;
  const decode = (results as Record<string, (d: Hex) => unknown>)[w.functionName]!;
  return [canon(decode(w.returnData)), canon(f())];
}

test('an index rebuilt only from the logs answers every view exactly as the contract did (stop epochs, live-set order, fees)', () => {
  const events = decodedEvents();
  const idx = new CopyTradingIndex(PROXY);
  idx.applyAll(events);
  let compared = 0;
  for (const w of vectors.views as Json[]) {
    const pair = viewPair(idx, w, vectors.finalTimestamp);
    if (!pair) continue;
    assert.deepEqual(pair[1], pair[0], w.name);
    compared++;
  }
  assert.ok(compared > 80);
  // The headline facts, spelled out.
  const follower = vectors.actors.follower as Address;
  const wallet = vectors.contracts.erc1271Wallet as Address;
  assert.equal(idx.statusOf(2n), 3, '#2 is STOPPED by the kill switch...');
  assert.equal(idx.get(2n)!.record.status, 1, '...while its stored record still says ACTIVE');
  assert.deepEqual(idx.killedBy(follower, 1n), [2n]);
  assert.deepEqual(idx.killedBy(wallet, 1n), [3n]);
  assert.deepEqual(idx.liveSubscriptionsOfFollower(follower).ids, [7n, 6n], 'swap-and-pop order');
});

test('ChainView over the same logs (2 confirmations, one poll per block) settles to the same state', () => {
  const events = decodedEvents();
  const v = new ChainView(PROXY, 2);
  const last = events.at(-1)!.blockNumber;
  for (let b = 1n; b <= last + 2n; b++) v.update(b, events.filter((e) => e.blockNumber === b));
  const full = new CopyTradingIndex(PROXY);
  full.applyAll(events);
  for (const w of vectors.views as Json[]) {
    const pair = viewPair(v.confirmed(), w, vectors.finalTimestamp);
    if (pair) assert.deepEqual(pair[1], pair[0], w.name);
  }
  assert.deepEqual(norm(v.tip().liveSubscriptionsOfFollower(vectors.actors.follower)), norm(full.liveSubscriptionsOfFollower(vectors.actors.follower)));
});

test('execution commitment: leaves re-encoded with viem, the root, and every proof', () => {
  const e = vectors.executions;
  const records = reviveBigints<Json[]>(e.records, BIG_KEYS);
  records.forEach((r: Json, i: number) => {
    const enc = encodeAbiParameters(EXECUTION_LEAF_PARAMS as never, [
      EXECUTION_LEAF_TAG,
      r.copyTradingContract,
      r.subscriptionId,
      r.subscriptionVersion,
      r.action,
      r.leaderVenue,
      r.leaderFillRef,
      r.leaderFillTimeMs,
      r.engine,
      keccak256(toBytes(r.symbol)),
      r.side,
      r.reduceOnly,
      r.quantity,
      r.limitPrice,
      r.builderFee,
      r.followerTxHash,
      r.followerOrderTimeMs,
      r.skipReason,
    ] as never);
    assert.equal(keccak256(keccak256(enc)), e.leaves[i]);
    assert.equal(executionLeaf(r), e.leaves[i]);
    assert.ok(verifyMerkleProof(e.root, e.leaves[i], e.proofs[i]));
    let h: Hex = e.leaves[i];
    for (const p of e.proofs[i] as Hex[]) h = keccak256(BigInt(h) <= BigInt(p) ? concat([h, p]) : concat([p, h]));
    assert.equal(h, e.root, 'independent sorted-pair verification');
  });
  assert.equal(buildMerkleTree(e.leaves).root, e.root);
});

test('governance: operation ids (viem), CallScheduled explained as an upgrade, the timelock logs decode', () => {
  const g = vectors.governance;
  for (const op of Object.values(g.operations) as Json[]) {
    const id = keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bytes32' }, { type: 'bytes32' }],
        [op.target, BigInt(op.value), op.data, op.predecessor, op.salt],
      ),
    );
    assert.equal(id, op.id);
    assert.equal(op.delay, '172800');
  }
  const scheduled: Json[] = [];
  for (const s of g.steps as Json[]) {
    for (const l of s.logs) {
      if (l.emitter !== TIMELOCK) continue;
      const ev = decodeTimelockLog({ address: TIMELOCK, topics: l.topics, data: l.data }, TIMELOCK);
      assert.ok(ev, l.eventName);
      const viem = viemDecodeEventLog({ abi: timelockControllerAbi, topics: l.topics, data: l.data });
      assert.deepEqual(norm(ev.args), norm(viem.args));
      if (ev.eventName === 'CallScheduled') scheduled.push(describeScheduledCall(ev.args, PROXY));
    }
  }
  assert.deepEqual(scheduled.map((d) => d.kind), ['owner-call', 'upgrade']);
  assert.ok(sameAddress(scheduled[1].newImplementation, vectors.contracts.implementationV2));
  const early = (g.steps as Json[]).find((s) => !s.success && s.to === TIMELOCK);
  assert.equal(early.errorName, 'TimelockUnexpectedOperationState');
});

test('invalid-terms cases: the package’s first problem is the contract’s revert', () => {
  assert.ok(vectors.termsCases.length >= 50);
  const follower = vectors.actors.follower as Address;
  for (const c of vectors.termsCases as Json[]) {
    const terms = reviveBigints<Json>(c.terms, BIG_KEYS);
    const problems = subscriptionProblems(
      { follower, venue: c.venue, leader: c.leader, sodexAccountId: BigInt(c.sodexAccountId) },
      terms,
      vectors.deployment.time,
      { venueEnabled: c.venue === 1 || c.venue === 2 },
    );
    assert.equal(problems[0]!.field, c.field, c.name);
    const err = classifyRevert(c.revertData);
    assert.equal(err.class, 'rejected');
    assert.equal(err.errorName, c.field === 'VENUE_DISABLED' ? 'VenueDisabled' : 'InvalidTerms', c.name);
  }
});
