/**
 * Client-side validation mirrors the contract's `_checkSubscribe` / `_validateTerms` / `_checkSymbols`: the same bounds
 * (SoDEX's rules and validity only, no product limits), the same order (problems[0] is the contract's revert), and the
 * same stored record. The contract's side of these rules is tested in contracts/test/unit/Subscribe.t.sol and fuzzed in
 * contracts/test/fuzz/Bounds.t.sol; the Foundry cross-check replays the stored records produced here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MarketScope,
  SizingMode,
  Status,
  SymbolMode,
  type Terms,
  TermsValidationError,
  Venue,
  assertValidSubscription,
  assertValidTerms,
  delegatedKeyExpiresAtMs,
  expiryAfter,
  isExpired,
  keyNameProblem,
  recommendedBuilderApproval,
  storedSubscription,
  subscriptionProblems,
  symbolProblem,
  symbolsHash,
  targetProblems,
  termsOf,
  termsProblems,
} from '../src/index.ts';
import { FOLLOWER, KEY, LEADER, NOW, validTerms } from './helpers.ts';

const fields = (t: Terms, now = NOW) => termsProblems(t, FOLLOWER, now).map((p) => p.field);
const first = (t: Terms, now = NOW) => fields(t, now)[0];

test('valid terms have no problems; the fixture is the spec §6.8 vector', () => {
  assert.deepEqual(termsProblems(validTerms(), FOLLOWER, NOW), []);
  assertValidTerms(validTerms(), FOLLOWER, NOW);
});

test('no product limits: huge values, long symbols, many symbols, 255x, uint32 take profit, never expiring', () => {
  const U64 = (1n << 64n) - 1n;
  const t = validTerms({
    sizingValue: U64,
    allocationCap: U64,
    maxPositionNotional: U64,
    maxLeverage: 255,
    takeProfitBps: 2 ** 32 - 1,
    symbols: Array.from({ length: 300 }, (_, i) => `SYMBOL-${i}-${'X'.repeat(40)}`),
    expiry: 0,
  });
  assert.deepEqual(fields(t), []);
  assert.deepEqual(fields(validTerms({ expiry: 2 ** 40 - 1 })), [], 'uint40 max expiry');
  assert.deepEqual(fields(validTerms({ symbols: ['BTC-USD', 'BTC-USD'] })), [], 'duplicates are the follower’s choice');
  assert.deepEqual(fields(validTerms({ symbols: ['ETH-USD', 'BTC-USD'] })), [], 'any order');
  assert.deepEqual(fields(validTerms({ sizingMode: SizingMode.FIXED_RATIO, sizingValue: U64 })), [], 'no ratio cap');
});

test('each bound, with the contract’s field', () => {
  const cases: Array<[Partial<Terms>, string]> = [
    [{ delegatedKey: '0x0000000000000000000000000000000000000000' }, 'DELEGATED_KEY'],
    [{ delegatedKey: FOLLOWER }, 'DELEGATED_KEY'],
    [{ keyName: '' }, 'KEY_NAME'],
    [{ keyName: 'x'.repeat(37) }, 'KEY_NAME'],
    [{ keyName: 'default' }, 'KEY_NAME'],
    [{ keyName: 'has space' }, 'KEY_NAME'],
    [{ keyName: 'ünï' }, 'KEY_NAME'],
    [{ marketScope: MarketScope.NONE }, 'MARKET_SCOPE'],
    [{ sizingMode: SizingMode.NONE }, 'SIZING_MODE'],
    [{ allocationCap: 0n }, 'ALLOCATION_CAP'],
    [{ maxLeverage: 0 }, 'MAX_LEVERAGE'],
    [{ marketScope: MarketScope.SPOT, maxLeverage: 2, maxPositionNotional: 1_000_000_000n }, 'MAX_LEVERAGE'],
    [{ maxPositionNotional: 0n }, 'MAX_POSITION_NOTIONAL'],
    [{ maxPositionNotional: 5_000_000_001n }, 'MAX_POSITION_NOTIONAL'],
    [{ sizingValue: 0n }, 'SIZING_VALUE'],
    [{ sizingMode: SizingMode.FIXED_NOTIONAL, sizingValue: 2_500_000_001n }, 'SIZING_VALUE'],
    [{ tradeStopLossBps: 10_001 }, 'TRADE_STOP_LOSS'],
    [{ maxDrawdownBps: 10_001 }, 'MAX_DRAWDOWN'],
    [{ slippageBps: 0 }, 'SLIPPAGE'],
    [{ slippageBps: 10_001 }, 'SLIPPAGE'],
    [{ symbolMode: SymbolMode.ALL }, 'SYMBOL_MODE'],
    [{ symbols: [] }, 'SYMBOLS'],
    [{ symbols: ['BTC USD'] }, 'SYMBOLS'],
    [{ symbols: [''] }, 'SYMBOLS'],
    [{ symbols: ['BTC-€'] }, 'SYMBOLS'],
    [{ maxBuilderFeePerps: 201 }, 'BUILDER_FEE_PERPS'],
    [{ maxBuilderFeeSpot: 2001 }, 'BUILDER_FEE_SPOT'],
    [{ expiry: NOW }, 'EXPIRY'],
    [{ expiry: NOW - 1 }, 'EXPIRY'],
  ];
  for (const [over, field] of cases) assert.deepEqual(fields(validTerms(over)), [field], JSON.stringify(over, (_k, v) => (typeof v === 'bigint' ? `${v}` : v)));
  // Edge values that are valid.
  const edges: Array<Partial<Terms>> = [
    { keyName: 'x'.repeat(36) },
    { keyName: 'A-z_0-9' },
    { tradeStopLossBps: 10_000, maxDrawdownBps: 10_000, slippageBps: 10_000 },
    { maxPositionNotional: 5_000_000_000n },
    { sizingMode: SizingMode.FIXED_NOTIONAL, sizingValue: 2_500_000_000n },
    { marketScope: MarketScope.SPOT, maxLeverage: 1, maxPositionNotional: 1_000_000_000n },
    { maxBuilderFeePerps: 200, maxBuilderFeeSpot: 2000 },
    { expiry: NOW + 1 },
    { symbols: ['!~'] },
  ];
  for (const over of edges) assert.deepEqual(fields(validTerms(over)), [], JSON.stringify(over, (_k, v) => (typeof v === 'bigint' ? `${v}` : v)));
});

test('the reported field is the root cause, in the contract’s order', () => {
  // allocation cap before leverage before max position before sizing value
  assert.equal(first(validTerms({ allocationCap: 0n, maxLeverage: 0, maxPositionNotional: 0n, sizingValue: 0n })), 'ALLOCATION_CAP');
  assert.equal(first(validTerms({ maxLeverage: 0, maxPositionNotional: 0n })), 'MAX_LEVERAGE');
  assert.equal(first(validTerms({ sizingMode: SizingMode.FIXED_NOTIONAL, maxPositionNotional: 10n, sizingValue: 11n })), 'SIZING_VALUE');
  // key before everything, expiry last
  assert.deepEqual(fields(validTerms({ delegatedKey: FOLLOWER, keyName: 'default', expiry: 1 })), ['DELEGATED_KEY', 'KEY_NAME', 'EXPIRY']);
  assert.deepEqual(fields(validTerms({ slippageBps: 0, symbols: [], maxBuilderFeePerps: 999 })), ['SLIPPAGE', 'SYMBOLS', 'BUILDER_FEE_PERPS']);
});

test('values the ABI cannot encode are SHAPE problems (the contract would revert without data)', () => {
  assert.deepEqual(fields(validTerms({ marketScope: 4 as never })), ['SHAPE']);
  assert.deepEqual(fields(validTerms({ symbolMode: 3 as never })), ['SHAPE']);
  assert.deepEqual(fields(validTerms({ maxLeverage: 256 })), ['SHAPE']);
  assert.equal(first(validTerms({ takeProfitBps: 2 ** 32 })), 'SHAPE');
  assert.equal(first(validTerms({ sizingValue: 1n << 64n })), 'SHAPE');
  assert.equal(first(validTerms({ expiry: 2 ** 40 })), 'SHAPE');
});

test('target rules: leader, account, venue 0, and self-copy only on SoDEX', () => {
  const t = { follower: FOLLOWER, venue: Venue.HYPERLIQUID, leader: LEADER, sodexAccountId: 1n };
  assert.deepEqual(targetProblems(t), []);
  assert.deepEqual(targetProblems({ ...t, leader: FOLLOWER }), [], 'mirror your own HL trading into SoDEX');
  assert.deepEqual(targetProblems({ ...t, venue: Venue.SODEX, leader: FOLLOWER }).map((p) => p.field), ['LEADER']);
  assert.deepEqual(targetProblems({ ...t, leader: '0x0000000000000000000000000000000000000000' }).map((p) => p.field), ['LEADER']);
  assert.deepEqual(targetProblems({ ...t, sodexAccountId: 0n }).map((p) => p.field), ['SODEX_ACCOUNT']);
  assert.deepEqual(targetProblems({ ...t, venue: 0 }).map((p) => p.field), ['VENUE_DISABLED']);
});

test('subscriptionProblems: the contract’s full order (pause, venue, target, terms, duplicate, stop epoch)', () => {
  const target = { follower: FOLLOWER, venue: Venue.HYPERLIQUID, leader: LEADER, sodexAccountId: 1n };
  const got = subscriptionProblems(target, validTerms({ slippageBps: 0 }), NOW, { paused: true, venueEnabled: false, existingLiveId: 9n, currentStopEpoch: 2n }, 1n).map(
    (p) => p.field,
  );
  assert.deepEqual(got, ['PAUSED', 'VENUE_DISABLED', 'SLIPPAGE', 'DUPLICATE', 'STOP_EPOCH']);
  assert.deepEqual(subscriptionProblems(target, validTerms(), NOW, { paused: false, venueEnabled: true, existingLiveId: 0n, currentStopEpoch: 1n }, 1n), []);
  assert.throws(() => assertValidSubscription(target, validTerms(), NOW, { existingLiveId: 3n }), (e: unknown) => {
    assert.ok(e instanceof TermsValidationError);
    assert.deepEqual(e.problems.map((p) => p.field), ['DUPLICATE']);
    return true;
  });
});

test('string rules: SoDEX key names and printable-ASCII symbols of any length', () => {
  assert.equal(keyNameProblem('vs-3f9a1c07'), null);
  assert.match(keyNameProblem('x'.repeat(37))!, /1\.\.36/);
  assert.match(keyNameProblem('default')!, /master key/);
  assert.equal(symbolProblem('vBTC_vUSDC'), null);
  assert.equal(symbolProblem('X'.repeat(500)), null, 'no length limit');
  assert.match(symbolProblem('a b')!, /printable ASCII/);
  assert.match(symbolProblem('')!, /empty/);
});

test('storedSubscription is the record the contract stores; termsOf inverts it with the event’s list', () => {
  const terms = validTerms({ symbols: ['ETH-USD', 'BTC-USD'] });
  const r = storedSubscription({ follower: FOLLOWER, venue: 2, leader: LEADER, sodexAccountId: 7n }, terms, {
    status: Status.ACTIVE,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    stopEpoch: 3n,
  });
  assert.equal(r.symbolsHash, symbolsHash(['ETH-USD', 'BTC-USD']));
  assert.equal(r.stopEpoch, 3n);
  assert.equal(r.closePositions, false);
  assert.equal(r.keyName, terms.keyName);
  assert.equal(r.delegatedKey, KEY);
  assert.deepEqual(termsOf(r, ['ETH-USD', 'BTC-USD']), { ...terms, symbols: ['ETH-USD', 'BTC-USD'] });
  assert.throws(() => termsOf(r, ['BTC-USD', 'ETH-USD']), TermsValidationError, 'the list must match the commitment');
});

test('expiry and onboarding helpers', () => {
  assert.equal(isExpired(0, NOW), false, '0 never expires');
  assert.equal(isExpired(NOW, NOW), true, 'expired AT expiry');
  assert.equal(isExpired(NOW + 1, NOW), false);
  assert.equal(expiryAfter(NOW, 86_400 * 3650), NOW + 86_400 * 3650, 'no lifetime cap');
  assert.throws(() => expiryAfter(NOW, 0), RangeError);
  assert.equal(recommendedBuilderApproval({ maxBuilderFeePerps: 50, maxBuilderFeeSpot: 100 }), 100);
  assert.equal(delegatedKeyExpiresAtMs({ expiry: 0 }), 0);
  assert.equal(delegatedKeyExpiresAtMs({ expiry: NOW }), NOW * 1000);
});
