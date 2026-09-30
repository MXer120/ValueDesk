/**
 * The executor's gates: copyMode (with the stop-epoch rule), the per-signal gate (scope, symbol filter, cycle
 * protection, staleness, reduce-only), the builder fee to attach, the preflight, and the ClobGateway calldata.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi } from 'viem';

import {
  type Address,
  CopyTradingIndex,
  type KeyIssuance,
  MarketScope,
  type PreflightInput,
  SkipReason,
  Status,
  StopReason,
  SymbolMode,
  builderForOrder,
  copyMode,
  decodeAccountsByAddress,
  engineInScope,
  evaluatePreflight,
  gateSignal,
  isServiceable,
  sodexGatewayCalls,
  stopDeadline,
  storedSubscription,
  symbolAllowed,
} from '../src/index.ts';
import { FOLLOWER, KEY, LEADER, NOW, PROXY, mkEvent, validTerms } from './helpers.ts';

const KEY2: Address = '0x6666666666666666666666666666666666666666';

function indexWith(terms = validTerms(), extra: Array<[string, Record<string, unknown>]> = []): CopyTradingIndex {
  const idx = new CopyTradingIndex(PROXY);
  const record = storedSubscription({ follower: FOLLOWER, venue: 2, leader: LEADER, sodexAccountId: 1n }, terms, {
    status: Status.ACTIVE,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    stopEpoch: 0n,
  });
  idx.apply(mkEvent('Subscribed', { subscriptionId: 1n, follower: FOLLOWER, leader: LEADER, subscription: record, symbols: terms.symbols }, { block: 1, timestamp: NOW }));
  extra.forEach(([name, args], i) => idx.apply(mkEvent(name, args, { block: 2 + i, timestamp: NOW + 10 + i })));
  return idx;
}

test('copyMode: open, reduce-only (paused, expired), wind-down (follower or kill switch), ignore', () => {
  assert.equal(copyMode(indexWith(), 1n, NOW + 1).mode, 'open');
  assert.equal(copyMode(indexWith(), 9n, NOW).mode, 'ignore');
  const paused = copyMode(indexWith(validTerms(), [['SubscriptionPaused', { subscriptionId: 1n, follower: FOLLOWER, version: 2, updatedAt: NOW + 5 }]]), 1n, NOW + 6);
  assert.deepEqual([paused.mode, paused.mode === 'reduce-only' && paused.reason], ['reduce-only', 'paused']);
  const expired = copyMode(indexWith(validTerms({ expiry: NOW + 100 })), 1n, NOW + 100);
  assert.deepEqual([expired.mode, expired.mode === 'reduce-only' && expired.reason], ['reduce-only', 'expired']);
  assert.equal(copyMode(indexWith(validTerms({ expiry: 0 })), 1n, 2 ** 40 - 1).mode, 'open', '0 never expires');
  const stopped = copyMode(indexWith(validTerms(), [['SubscriptionStopped', { subscriptionId: 1n, follower: FOLLOWER, closePositions: true, version: 2, updatedAt: NOW + 7 }]]), 1n, NOW + 8);
  assert.deepEqual(stopped.mode === 'wind-down' && [stopped.reason, stopped.closePositions, stopped.stoppedAt], [StopReason.FOLLOWER, true, NOW + 7]);
  const killed = copyMode(indexWith(validTerms(), [['KillSwitchTriggered', { follower: FOLLOWER, stopEpoch: 1n, closePositions: true }]]), 1n, NOW + 20);
  assert.deepEqual(killed.mode === 'wind-down' && [killed.reason, killed.closePositions, killed.stoppedAt], [StopReason.KILL_SWITCH, true, NOW + 10]);
});

test('engineInScope and symbolAllowed', () => {
  assert.deepEqual([engineInScope(MarketScope.PERPS, 'perps'), engineInScope(MarketScope.PERPS, 'spot')], [true, false]);
  assert.deepEqual([engineInScope(MarketScope.SPOT, 'perps'), engineInScope(MarketScope.SPOT, 'spot')], [false, true]);
  assert.deepEqual([engineInScope(MarketScope.PERPS_AND_SPOT, 'perps'), engineInScope(MarketScope.PERPS_AND_SPOT, 'spot')], [true, true]);
  assert.equal(engineInScope(MarketScope.NONE, 'perps'), false);
  const sub = (symbolMode: SymbolMode, symbols: string[]) => ({ record: { symbolMode }, symbols });
  assert.equal(symbolAllowed(sub(SymbolMode.ALL, []), 'ANY'), true);
  assert.equal(symbolAllowed(sub(SymbolMode.ALLOW, ['BTC-USD']), 'BTC-USD'), true);
  assert.equal(symbolAllowed(sub(SymbolMode.ALLOW, ['BTC-USD']), 'btc-usd'), false, 'exact, case-sensitive');
  assert.equal(symbolAllowed(sub(SymbolMode.DENY, ['BTC-USD']), 'BTC-USD'), false);
  assert.equal(symbolAllowed(sub(SymbolMode.DENY, ['BTC-USD']), 'ETH-USD'), true);
});

/** The key store: KEY is the one key Valuescan issued (for FOLLOWER, account 1). */
const issued = new Map<string, KeyIssuance>([[KEY.toLowerCase(), { delegatedKey: KEY, follower: FOLLOWER, sodexAccountId: 1n }]]);
const issuanceOf = (key: Address): KeyIssuance | undefined => issued.get(key.toLowerCase());

test('gateSignal: every skip reason, and reduce-only while paused', () => {
  const idx = indexWith(validTerms({ symbols: ['BTC-USD'] }));
  const base = { sodexSymbol: 'BTC-USD', engine: 'perps' as const, increases: true, signalTimeMs: NOW * 1000, nowMs: NOW * 1000 + 100 };
  assert.deepEqual(gateSignal(idx, 1n, base, issuanceOf).go, true);
  const skip = (i: Partial<typeof base> & { leaderOrderSigner?: Address }, id = 1n, index = idx) => {
    const d = gateSignal(index, id, { ...base, ...i }, issuanceOf);
    return d.go ? 'go' : d.skipReason;
  };
  assert.equal(skip({}, 9n), SkipReason.NOT_COPYABLE);
  assert.equal(skip({ leaderOrderSigner: KEY }), SkipReason.COPY_OF_COPY, 'a fill from a Valuescan delegated key is a copy');
  assert.equal(skip({ nowMs: NOW * 1000 + 2_001 }), SkipReason.STALE_SIGNAL);
  assert.equal(skip({ sodexSymbol: null as never }), SkipReason.UNMAPPED_SYMBOL);
  assert.equal(skip({ engine: 'spot' as never }), SkipReason.OUT_OF_SCOPE);
  assert.equal(skip({ sodexSymbol: 'ETH-USD' }), SkipReason.SYMBOL_FILTERED);
  const paused = indexWith(validTerms({ symbols: ['BTC-USD'] }), [['SubscriptionPaused', { subscriptionId: 1n, follower: FOLLOWER, version: 2, updatedAt: NOW + 1 }]]);
  assert.equal(skip({}, 1n, paused), SkipReason.REDUCE_ONLY);
  assert.equal(skip({ increases: false }, 1n, paused), 'go', 'reductions are mirrored while paused');
  const killed = indexWith(validTerms(), [['KillSwitchTriggered', { follower: FOLLOWER, stopEpoch: 1n, closePositions: false }]]);
  assert.equal(skip({ increases: false }, 1n, killed), SkipReason.NOT_COPYABLE, 'STOPPED: only the wind-down path trades');
});

test('gateSignal: naming a leader\'s own signer as a delegated key does not silence that leader (audit C-1)', () => {
  // Mallory records a subscription whose delegatedKey is the LEADER's order signer. The contract accepts it (any key
  // but zero or the follower), so the index now lists that address as "a delegated key".
  const idx = indexWith(validTerms({ symbols: ['BTC-USD'], delegatedKey: LEADER }));
  assert.equal(idx.isDelegatedKey(LEADER), true, 'the planted flag is in the index');
  const base = { sodexSymbol: 'BTC-USD', engine: 'perps' as const, signalTimeMs: NOW * 1000, nowMs: NOW * 1000 + 100 };
  // The leader's fills - opens AND closes - are still copied: Valuescan never issued that key.
  for (const increases of [true, false]) {
    const d = gateSignal(idx, 1n, { ...base, increases, leaderOrderSigner: LEADER }, issuanceOf);
    assert.equal(d.go, true, `increases=${increases}`);
  }
  // A fill signed by a key Valuescan did issue is still recognised as a copy.
  const d = gateSignal(idx, 1n, { ...base, increases: true, leaderOrderSigner: KEY }, issuanceOf);
  assert.equal(d.go ? 'go' : d.skipReason, SkipReason.COPY_OF_COPY);
});

test('isServiceable: only keys Valuescan issued for exactly this follower and account (spam costs nothing)', () => {
  const issuance = new Map<string, KeyIssuance>([[KEY.toLowerCase(), { delegatedKey: KEY, follower: FOLLOWER, sodexAccountId: 1n }]]);
  const lookup = (k: Address) => issuance.get(k.toLowerCase());
  const rec = { delegatedKey: KEY, follower: FOLLOWER, sodexAccountId: 1n };
  assert.equal(isServiceable(rec, lookup), true);
  assert.equal(isServiceable({ ...rec, sodexAccountId: 2n }, lookup), false, 'another account');
  assert.equal(isServiceable({ ...rec, follower: LEADER }, lookup), false, 'someone else naming our key');
  assert.equal(isServiceable({ ...rec, delegatedKey: KEY2 }, lookup), false, 'a key we never issued');
  // A huge list is matched through a set.
  const big = { record: { symbolMode: SymbolMode.DENY }, symbols: Array.from({ length: 50_000 }, (_, i) => `S${i}`) };
  assert.equal(symbolAllowed(big, 'S49999'), false);
  assert.equal(symbolAllowed(big, 'BTC-USD'), true);
});

test('builderForOrder: min(effective fee, SoDEX approval); no fee on reduce-only by default; refuse unapproved opens', () => {
  const effective = { builderId: 231_000n, perpsFee: 50, spotFee: 100 };
  assert.deepEqual(builderForOrder({ effective, engine: 'perps', reduceOnly: false, approvedMaxFeeRate: 100 }), { trade: true, builder: { id: 231_000n, fee: 50 } });
  assert.deepEqual(builderForOrder({ effective, engine: 'spot', reduceOnly: false, approvedMaxFeeRate: 60 }), { trade: true, builder: { id: 231_000n, fee: 60 } });
  assert.deepEqual(builderForOrder({ effective, engine: 'perps', reduceOnly: true, approvedMaxFeeRate: 100 }), { trade: true, builder: null });
  assert.deepEqual(builderForOrder({ effective, engine: 'perps', reduceOnly: true, approvedMaxFeeRate: 100, feeOnReduceOnly: true }), { trade: true, builder: { id: 231_000n, fee: 50 } });
  assert.deepEqual(builderForOrder({ effective, engine: 'perps', reduceOnly: false, approvedMaxFeeRate: null }), { trade: false, reason: 'no-builder-approval' });
  assert.deepEqual(builderForOrder({ effective, engine: 'perps', reduceOnly: true, approvedMaxFeeRate: 0 }), { trade: true, builder: null }, 'never block a reduction');
  assert.deepEqual(builderForOrder({ effective: { ...effective, perpsFee: 0 }, engine: 'perps', reduceOnly: false, approvedMaxFeeRate: null }), { trade: true, builder: null }, 'consent 0: no builder');
  assert.equal(stopDeadline(NOW), NOW + 10);
});

test('evaluatePreflight: account ownership, key per engine, key store, builder approval', () => {
  const terms = validTerms({ marketScope: MarketScope.PERPS_AND_SPOT, maxLeverage: 1, maxPositionNotional: 1_000_000_000n, maxBuilderFeePerps: 50, maxBuilderFeeSpot: 100 });
  const subscription = storedSubscription({ follower: FOLLOWER, venue: 2, leader: LEADER, sodexAccountId: 224_678n }, terms, {
    status: Status.ACTIVE,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    stopEpoch: 0n,
  });
  const key = { name: terms.keyName, publicKey: KEY.toLowerCase(), expiresAt: (NOW + 3600) * 1000, permissions: 14 };
  const ok: PreflightInput = {
    subscription,
    now: NOW,
    followerAccounts: [224_678n],
    apiKeys: { perps: [key], spot: [key] },
    keyStoreHasKey: true,
    builderApproval: { builderId: 231_000n, maxFeeRate: 100 },
    effective: { builderId: 231_000n, perpsFee: 50, spotFee: 100 },
  };
  assert.deepEqual(evaluatePreflight(ok), { ok: true, problems: [], notes: [], feeCeiling: { perps: 50, spot: 100 } });
  const problems = (over: Partial<typeof ok>) => evaluatePreflight({ ...ok, ...over }).problems;
  assert.match(problems({ followerAccounts: [1n] })[0]!, /not owned/);
  assert.match(problems({ apiKeys: { perps: [key] } })[0]!, /no spot API key/);
  assert.match(problems({ apiKeys: { perps: [{ ...key, publicKey: KEY2 }], spot: [key] } })[0]!, /is not/);
  assert.match(problems({ apiKeys: { perps: [{ ...key, expiresAt: NOW * 1000 }], spot: [key] } })[0]!, /expired/);
  assert.match(problems({ keyStoreHasKey: false })[0]!, /key store/);
  assert.match(problems({ builderApproval: null })[0]!, /no SoDEX builder approval/);
  assert.match(problems({ builderApproval: { builderId: 1n, maxFeeRate: 100 } })[0]!, /no SoDEX builder approval/, 'approval for another builder');
  const low = evaluatePreflight({ ...ok, builderApproval: { builderId: 231_000n, maxFeeRate: 60 } });
  assert.equal(low.ok, true);
  assert.deepEqual(low.feeCeiling, { perps: 50, spot: 60 });
  assert.match(low.notes[0]!, /below the effective fee/);
  const ordinary = evaluatePreflight({ ...ok, apiKeys: { perps: [{ ...key, permissions: null }], spot: [key] } });
  assert.equal(ordinary.ok, true);
  assert.match(ordinary.notes[0]!, /full-permission/);
  assert.equal(evaluatePreflight({ ...ok, apiKeys: { perps: [{ ...key, expiresAt: 0 }], spot: [{ ...key, expiresAt: 0 }] } }).ok, true, 'expiresAt 0 never expires');
});

test('ClobGateway calldata matches viem, and getAccountsByAddress decodes', () => {
  const abi = parseAbi([
    'function getAccountsByAddress(address owner) view returns (uint256[])',
    'function addAPIKey(uint256 destination, string name, bytes pubkey)',
    'function revokeAPIKey(uint256 destination, string name)',
  ]);
  assert.equal(sodexGatewayCalls.getAccountsByAddress(FOLLOWER), encodeFunctionData({ abi, functionName: 'getAccountsByAddress', args: [FOLLOWER] }));
  assert.equal(sodexGatewayCalls.addAPIKey('perps', 'vs-1', KEY), encodeFunctionData({ abi, functionName: 'addAPIKey', args: [1n, 'vs-1', KEY] }));
  assert.equal(sodexGatewayCalls.revokeAPIKey('spot', 'vs-1'), encodeFunctionData({ abi, functionName: 'revokeAPIKey', args: [0n, 'vs-1'] }));
  assert.deepEqual(decodeFunctionData({ abi, data: sodexGatewayCalls.revokeAPIKey('perps', 'vs-1') }).args, [1n, 'vs-1']);
  assert.deepEqual(decodeAccountsByAddress(encodeAbiParameters([{ type: 'uint256[]' }], [[224_678n, 230_775n]])), [224_678n, 230_775n]);
});
