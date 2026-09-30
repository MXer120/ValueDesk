/**
 * The event-sourced CopyTradingIndex on hand-built event sequences: the stop-epoch rule (a kill switch STOPS every
 * older live subscription without an event per subscription), the live set's swap-and-pop order, the uniqueness key,
 * consistency guards, block timestamps, and the reorg-aware ChainView. The same index is checked against the REAL
 * contract's views through the Foundry-verified vectors in test/vectors.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  type Address,
  ChainView,
  CopyTradingIndex,
  type CopyTradingEvent,
  DeepReorgError,
  IndexConsistencyError,
  IndexInputError,
  IndexOrderError,
  Status,
  StopReason,
  type Terms,
  storedSubscription,
  symbolsHash,
} from '../src/index.ts';
import { FOLLOWER, LEADER, NOW, PROXY, mkEvent, validTerms } from './helpers.ts';

const OTHER: Address = '0x9999999999999999999999999999999999999999';
const L2: Address = '0x8888888888888888888888888888888888888888';

/** A little event factory with an auto-incrementing position. */
function chain() {
  let block = 1n;
  let id = 0n;
  const events: CopyTradingEvent[] = [];
  const at = (eventName: string, args: Record<string, unknown>, timestamp = NOW + Number(block)) => {
    const e = mkEvent(eventName, args, { block, logIndex: 0, timestamp });
    block++;
    events.push(e);
    return e;
  };
  const subscribe = (follower: Address, leader: Address, epoch: bigint, terms: Terms = validTerms(), venue = 2, account = 1n) => {
    id++;
    const ts = NOW + Number(block);
    const record = storedSubscription({ follower, venue, leader, sodexAccountId: account }, terms, {
      status: Status.ACTIVE,
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      stopEpoch: epoch,
    });
    at('Subscribed', { subscriptionId: id, follower, leader, subscription: record, symbols: terms.symbols }, ts);
    return id;
  };
  return { events, at, subscribe, get block() { return block; } };
}

test('the kill switch: one event stops every older live subscription; new ones live in the new epoch', () => {
  const c = chain();
  const a = c.subscribe(FOLLOWER, LEADER, 0n);
  const b = c.subscribe(FOLLOWER, L2, 0n);
  c.at('SubscriptionPaused', { subscriptionId: b, follower: FOLLOWER, version: 2, updatedAt: NOW + 3 });
  const other = c.subscribe(OTHER, LEADER, 0n);
  const ks = c.at('KillSwitchTriggered', { follower: FOLLOWER, stopEpoch: 1n, closePositions: true }, NOW + 50);
  const idx = new CopyTradingIndex(PROXY);
  idx.applyAll(c.events);

  for (const id of [a, b]) {
    assert.equal(idx.statusOf(id), Status.STOPPED, `#${id} effective`);
    assert.equal(idx.getSubscription(id)!.status, Status.STOPPED);
    assert.notEqual(idx.get(id)!.record.status, Status.STOPPED, 'the stored record is untouched');
    assert.deepEqual(idx.stopDetails(id), { reason: StopReason.KILL_SWITCH, closePositions: true, stoppedAt: NOW + 50 });
    assert.equal(idx.isCopyable(id, NOW + 60), false);
  }
  assert.equal(idx.getSubscription(b)!.version, 2, 'a kill switch changes no version');
  assert.equal(idx.statusOf(other), Status.ACTIVE, 'another follower is unaffected');
  assert.deepEqual(idx.killedBy(FOLLOWER, 1n), [a, b]);
  assert.equal(idx.stopEpochOf(FOLLOWER), 1n);
  assert.deepEqual(idx.killSwitchInfo(FOLLOWER, 1n), { triggeredAt: ks.blockTimestamp, closePositions: true });
  assert.deepEqual(idx.liveSubscriptionsOfFollower(FOLLOWER), { ids: [], total: 0n });
  assert.equal(idx.liveSubscriptionFor(FOLLOWER, 1n, 2, LEADER), 0n, 'the uniqueness key is free');
  assert.deepEqual(idx.subscriptionsForLeader(2, LEADER).map((s) => s.id), [other]);

  // A new subscription in epoch 1 is live; the next kill switch stops it too.
  const d = c.subscribe(FOLLOWER, LEADER, 1n);
  idx.apply(c.events.at(-1)!);
  assert.equal(idx.statusOf(d), Status.ACTIVE);
  assert.equal(idx.liveSubscriptionFor(FOLLOWER, 1n, 2, LEADER), d);
  assert.deepEqual(idx.liveSubscriptionsOfFollower(FOLLOWER).ids, [d]);
  assert.equal(idx.statusOf(a), Status.STOPPED, 'nothing revives a killed subscription');
  idx.apply(c.at('KillSwitchTriggered', { follower: FOLLOWER, stopEpoch: 2n, closePositions: false }, NOW + 90));
  assert.deepEqual(idx.stopDetails(d), { reason: StopReason.KILL_SWITCH, closePositions: false, stoppedAt: NOW + 90 });
  assert.deepEqual(idx.stopDetails(a), { reason: StopReason.KILL_SWITCH, closePositions: true, stoppedAt: NOW + 50 }, 'the FIRST kill switch after creation');
  assert.deepEqual(idx.killedBy(FOLLOWER, 2n), [d]);
});

test('the live set has the contract’s swap-and-pop order; history lists are append-only', () => {
  const c = chain();
  const ids = [c.subscribe(FOLLOWER, LEADER, 0n), c.subscribe(FOLLOWER, L2, 0n), c.subscribe(FOLLOWER, OTHER, 0n), c.subscribe(FOLLOWER, PROXY, 0n)];
  c.at('SubscriptionStopped', { subscriptionId: ids[0], follower: FOLLOWER, closePositions: false, version: 2, updatedAt: NOW + 9 });
  const idx = new CopyTradingIndex(PROXY);
  idx.applyAll(c.events);
  assert.deepEqual(idx.liveSubscriptionsOfFollower(FOLLOWER).ids, [4n, 2n, 3n], 'the last id moved into the hole');
  assert.deepEqual(idx.liveSubscriptionsOfFollower(FOLLOWER, 1n, 1n), { ids: [2n], total: 3n });
  assert.deepEqual(idx.liveSubscriptionsOfFollower(FOLLOWER, 3n, 5n), { ids: [], total: 3n }, 'offset at the end');
  assert.deepEqual(idx.subscriptionsOfFollower(FOLLOWER), { ids: [1n, 2n, 3n, 4n], total: 4n });
  assert.deepEqual(idx.subscriptionsOfFollower(FOLLOWER, 1n, 2n), { ids: [2n, 3n], total: 4n });
  assert.deepEqual(idx.subscriptionsOfFollower(FOLLOWER, 0n, (1n << 256n) - 1n).ids.length, 4, 'an uncapped limit');
  assert.deepEqual(idx.subscriptionsOfLeader(2, LEADER), { ids: [1n], total: 1n });
  assert.deepEqual(idx.stopDetails(1n), { reason: StopReason.FOLLOWER, closePositions: false, stoppedAt: NOW + 9 });
  assert.equal(idx.stopDetails(2n), undefined, 'the view reverts for a live subscription');
  assert.equal(idx.stopDetails(99n), undefined);
  assert.equal(idx.statusOf(99n), Status.NONE);
});

test('lifecycle: versions, armedAt, effective fee = min(fee, consent), nonces, executors, commitments', () => {
  const c = chain();
  c.at('BuilderTermsUpdated', { builderId: 7n, perpsFee: 50, spotFee: 100 }, NOW);
  c.at('ExecutorSet', { executor: OTHER, authorised: true }, NOW);
  const id = c.subscribe(FOLLOWER, LEADER, 0n, validTerms({ maxBuilderFeePerps: 30, maxBuilderFeeSpot: 500 }));
  const t2 = validTerms({ symbols: ['SOL-USD'], maxBuilderFeePerps: 200 });
  const updated = storedSubscription({ follower: FOLLOWER, venue: 2, leader: LEADER, sodexAccountId: 1n }, t2, {
    status: Status.ACTIVE,
    version: 2,
    createdAt: NOW + 3,
    updatedAt: NOW + 20,
    stopEpoch: 0n,
  });
  const idx = new CopyTradingIndex(PROXY);
  idx.applyAll(c.events);
  assert.deepEqual(idx.effectiveBuilderFee(id), { builderId: 7n, perpsFee: 30, spotFee: 100 });
  assert.equal(idx.get(id)!.armedAt, NOW + 3);
  idx.apply(c.at('SubscriptionUpdated', { subscriptionId: id, follower: FOLLOWER, subscription: updated, symbols: t2.symbols }, NOW + 20));
  assert.deepEqual(idx.get(id)!.symbols, ['SOL-USD']);
  assert.equal(idx.get(id)!.armedAt, NOW + 20, 'an update while ACTIVE re-arms');
  assert.deepEqual(idx.effectiveBuilderFee(id), { builderId: 7n, perpsFee: 50, spotFee: 0 });
  idx.apply(c.at('SubscriptionPaused', { subscriptionId: id, follower: FOLLOWER, version: 3, updatedAt: NOW + 30 }));
  assert.equal(idx.isCopyable(id, NOW + 31), false);
  idx.apply(c.at('SubscriptionResumed', { subscriptionId: id, follower: FOLLOWER, version: 4, updatedAt: NOW + 40 }));
  assert.equal(idx.get(id)!.armedAt, NOW + 40, 'a resume re-arms');
  assert.equal(idx.isCopyable(id, NOW + 41), true);
  assert.equal(idx.isCopyable(id, validTerms().expiry), false, 'expired at expiry');

  idx.apply(c.at('NonceUsed', { signer: FOLLOWER, nonce: 0n }));
  idx.apply(c.at('NonceUsed', { signer: FOLLOWER, nonce: 2n }));
  idx.apply(c.at('NoncesInvalidated', { signer: FOLLOWER, word: 0n, mask: 0b10n }));
  assert.equal(idx.nonceBitmap(FOLLOWER, 0n), 0b111n);
  assert.equal(idx.nextNonce(FOLLOWER), 3n);
  assert.equal(idx.isNonceUsed(FOLLOWER, 256n), false);

  idx.apply(c.at('ExecutionsCommitted', { executor: OTHER, epoch: 5n, merkleRoot: `0x${'ab'.repeat(32)}`, count: 3, uri: 'ipfs://x' }, NOW + 60));
  assert.deepEqual(idx.commitment(OTHER, 5n), { merkleRoot: `0x${'ab'.repeat(32)}`, count: 3, committedAt: NOW + 60 });
  assert.equal(idx.executorInfo(OTHER).lastEpoch, 5n);
  assert.throws(() => idx.apply(c.at('ExecutionsCommitted', { executor: OTHER, epoch: 5n, merkleRoot: `0x${'00'.repeat(32)}`, count: 1, uri: '' })), IndexConsistencyError);
  const idx2 = new CopyTradingIndex(PROXY);
  idx2.applyAll(c.events.slice(0, -1));
  idx2.apply(c.at('ExecutorSet', { executor: OTHER, authorised: false }, NOW + 70));
  assert.deepEqual(idx2.executorInfo(OTHER), { authorised: false, updatedAt: NOW + 70, lastEpoch: 5n }, 'lastEpoch is kept');
  assert.deepEqual(idx2.authorisedExecutors(), []);
  assert.equal(idx2.isDelegatedKey(validTerms().delegatedKey), true);
  assert.deepEqual(idx2.liveSubscriptionsUsingKey(validTerms().delegatedKey), [id]);
});

test('governance events: pause, venues, ownership, upgrades, domain changes', () => {
  const c = chain();
  const idx = new CopyTradingIndex(PROXY);
  idx.apply(c.at('Upgraded', { implementation: OTHER }));
  idx.apply(c.at('OwnershipTransferred', { previousOwner: '0x0000000000000000000000000000000000000000', newOwner: FOLLOWER }));
  idx.apply(c.at('Initialized', { version: 1n }));
  idx.apply(c.at('VenueUpdated', { venue: 2, enabled: true, name: 'Hyperliquid' }));
  idx.apply(c.at('Paused', { account: FOLLOWER }));
  idx.apply(c.at('OwnershipTransferStarted', { previousOwner: FOLLOWER, newOwner: L2 }));
  assert.equal(idx.paused, true);
  assert.equal(idx.pendingOwner.toLowerCase(), L2);
  idx.apply(c.at('OwnershipTransferred', { previousOwner: FOLLOWER, newOwner: L2 }));
  idx.apply(c.at('Unpaused', { account: L2 }));
  idx.apply(c.at('Upgraded', { implementation: LEADER }));
  idx.apply(c.at('EIP712DomainChanged', {}));
  assert.equal(idx.paused, false);
  assert.equal(idx.owner.toLowerCase(), L2);
  assert.equal(idx.pendingOwner, '0x0000000000000000000000000000000000000000');
  assert.equal(idx.implementation.toLowerCase(), LEADER);
  assert.equal(idx.upgrades.length, 2);
  assert.equal(idx.initializedVersion, 1n);
  assert.ok(idx.domainChanged, 'the UI must re-read eip712Domain and ask for new signatures');
  assert.deepEqual(idx.venueInfo(2), { enabled: true, name: 'Hyperliquid' });
  assert.deepEqual(idx.venueInfo(9), { enabled: false, name: '' });
});

test('consistency and ordering guards', () => {
  const c = chain();
  c.subscribe(FOLLOWER, LEADER, 0n);
  const idx = new CopyTradingIndex(PROXY);
  idx.applyAll(c.events);
  assert.throws(() => idx.apply(c.events[0]!), IndexOrderError, 'duplicate / out of order');
  assert.throws(() => idx.apply({ ...c.at('Paused', { account: FOLLOWER }), removed: true }), IndexOrderError, 'removed log');
  assert.throws(() => idx.apply({ ...c.at('Paused', { account: FOLLOWER }), address: OTHER }), IndexOrderError, 'foreign contract');
  assert.throws(() => idx.apply(c.at('SubscriptionPaused', { subscriptionId: 1n, follower: FOLLOWER, version: 5, updatedAt: NOW })), IndexConsistencyError, 'version gap');
  assert.throws(() => idx.apply(c.at('SubscriptionResumed', { subscriptionId: 1n, follower: FOLLOWER, version: 2, updatedAt: NOW })), IndexConsistencyError, 'resume of ACTIVE');
  assert.throws(() => idx.apply(c.at('SubscriptionStopped', { subscriptionId: 9n, follower: FOLLOWER, closePositions: false, version: 2, updatedAt: NOW })), IndexConsistencyError, 'unknown id');
  assert.throws(() => idx.apply(c.at('KillSwitchTriggered', { follower: FOLLOWER, stopEpoch: 2n, closePositions: false })), IndexConsistencyError, 'epoch gap');
  const noTs = mkEvent('KillSwitchTriggered', { follower: FOLLOWER, stopEpoch: 1n, closePositions: false }, { block: 999 });
  assert.throws(() => idx.apply(noTs), IndexInputError, 'a kill switch needs its block time');
  // A Subscribed whose symbol list does not match its commitment is rejected.
  const t = validTerms();
  const rec = storedSubscription({ follower: FOLLOWER, venue: 2, leader: L2, sodexAccountId: 1n }, t, { status: Status.ACTIVE, version: 1, createdAt: NOW, updatedAt: NOW, stopEpoch: 0n });
  assert.equal(rec.symbolsHash, symbolsHash(t.symbols));
  const bad = mkEvent('Subscribed', { subscriptionId: 2n, follower: FOLLOWER, leader: L2, subscription: rec, symbols: ['DOGE-USD'] }, { block: 1000 });
  assert.throws(() => idx.apply(bad), IndexConsistencyError);
});

test('clone() is a deep, independent snapshot', () => {
  const c = chain();
  c.subscribe(FOLLOWER, LEADER, 0n);
  const idx = new CopyTradingIndex(PROXY);
  idx.applyAll(c.events);
  const snap = idx.clone();
  idx.apply(c.at('KillSwitchTriggered', { follower: FOLLOWER, stopEpoch: 1n, closePositions: false }));
  assert.equal(idx.statusOf(1n), Status.STOPPED);
  assert.equal(snap.statusOf(1n), Status.ACTIVE);
  assert.deepEqual(snap.liveSubscriptionsOfFollower(FOLLOWER).ids, [1n]);
  snap.apply(c.events.at(-1)!);
  assert.equal(snap.statusOf(1n), Status.STOPPED);
});

test('ChainView: stops at the tip, activations only once confirmed, reorgs within the window', () => {
  const c = chain();
  const v = new ChainView(PROXY, 2);
  c.subscribe(FOLLOWER, LEADER, 0n); // block 1
  v.update(1n, c.events.slice(0, 1));
  assert.equal(v.tip().statusOf(1n), Status.ACTIVE);
  assert.equal(v.mayOpen(1n, NOW + 10), false, 'not yet confirmed: no opening orders');
  v.update(3n, []);
  assert.equal(v.confirmed().statusOf(1n), Status.ACTIVE);
  assert.equal(v.mayOpen(1n, NOW + 10), true, 'confirmed 2 deep');
  // A stop is honoured at 0 confirmations.
  c.at('SubscriptionStopped', { subscriptionId: 1n, follower: FOLLOWER, closePositions: true, version: 2, updatedAt: NOW + 4 }); // block 2 in our factory
  const stop = { ...c.events.at(-1)!, blockNumber: 4n };
  v.update(4n, [stop]);
  assert.equal(v.tip().statusOf(1n), Status.STOPPED);
  assert.equal(v.confirmed().statusOf(1n), Status.ACTIVE);
  assert.equal(v.mayOpen(1n, NOW + 10), false, 'the tip wins for stops');
  // The stop is reorged out and re-mined one block later.
  v.update(5n, [{ ...stop, blockNumber: 5n }], 4n);
  assert.equal(v.tip().statusOf(1n), Status.STOPPED);
  assert.equal(v.confirmedBlock, 3n);
  v.update(7n, []);
  assert.equal(v.confirmed().statusOf(1n), Status.STOPPED, 'settled');
  assert.throws(() => v.update(8n, [], 3n), DeepReorgError);
  assert.throws(() => v.update(8n, [{ ...stop, blockNumber: 5n }]), IndexOrderError);
});
