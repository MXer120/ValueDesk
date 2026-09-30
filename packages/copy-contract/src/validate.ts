/**
 * Client-side validation of subscription targets and terms, mirroring the contract (`_checkSubscribe`,
 * `_validateTerms`, `_checkSymbols`) check for check and IN THE SAME ORDER, so the first problem reported here is the
 * revert the contract would produce.
 *
 * There are no product limits (owner decision 3): no cap on subscriptions, symbols, symbol length, lifetime, sizing,
 * leverage or take profit. The only bounds are SoDEX's rules (builder-fee caps, the API-key name rule) and plain
 * validity checks (a percentage of a price or of capital cannot exceed 100 %).
 *
 * The UI runs this before asking for a signature, the relayer before paying gas. The contract still decides: pure
 * checks cannot see chain state (pause, venue enablement, duplicates, the stop epoch, versions). Pass what you read
 * from the views, or from a `CopyTradingIndex`, as `ChainChecks` to include those in the same ordered list.
 */
import { type Address, MAX_UINT64, isAddress, isZeroAddress, sameAddress, toChecksumAddress, utf8 } from './bytes.ts';
import {
  MAX_BPS,
  MAX_KEY_NAME_LENGTH,
  PERPS_BUILDER_FEE_CAP,
  RESERVED_KEY_NAME,
  SPOT_BUILDER_FEE_CAP,
  Venue,
} from './constants.ts';
import { symbolsHash } from './eip712.ts';
import { MarketScope, SizingMode, type Status, type Subscription, SymbolMode, type Terms, type TermsFieldName } from './types.ts';

/** A problem, named after the contract's revert: an `InvalidTerms` field, or the custom error it would raise. */
export interface TermsProblem {
  field:
    | TermsFieldName
    | 'PAUSED' // EnforcedPause
    | 'VENUE_DISABLED' // VenueDisabled(venue)
    | 'DUPLICATE' // DuplicateSubscription(existingId)
    | 'STOP_EPOCH' // StopEpochMismatch(follower, expected, actual)
    | 'LAST_SUBSCRIPTION' // LastSubscriptionMismatch(expected, actual)
    | 'SHAPE'; // not encodable at all (wrong JS type or outside the Solidity type's range)
  message: string;
}

export class TermsValidationError extends Error {
  override name = 'TermsValidationError';
  constructor(readonly problems: readonly TermsProblem[]) {
    super(problems.map((p) => `${p.field}: ${p.message}`).join('; '));
  }
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

const KEY_NAME_RE = /^[0-9A-Za-z_-]{1,36}$/;

/** Why `name` is not a valid delegated-key name, or null: SoDEX's `^[0-9a-zA-Z_-]{1,36}$`, and not "default". */
export function keyNameProblem(name: unknown): string | null {
  if (typeof name !== 'string') return 'keyName must be a string';
  if (name.length === 0 || name.length > MAX_KEY_NAME_LENGTH) return `keyName must be 1..${MAX_KEY_NAME_LENGTH} characters`;
  if (!KEY_NAME_RE.test(name)) return 'keyName may only contain [0-9A-Za-z_-]';
  if (name === RESERVED_KEY_NAME) return 'keyName "default" is the SoDEX master key and is never delegated';
  return null;
}

/**
 * Why `symbol` is not a valid list entry, or null: non-empty printable ASCII 0x21..0x7E (no spaces). There is NO
 * length limit. Use the SoDEX symbol name exactly as SoDEX lists it (for example "BTC-USD"); matching is exact and
 * case-sensitive.
 */
export function symbolProblem(symbol: unknown): string | null {
  if (typeof symbol !== 'string') return 'symbol must be a string';
  const b = utf8(symbol);
  if (b.length === 0) return 'symbol must not be empty';
  for (const c of b) if (c < 0x21 || c > 0x7e) return `symbol "${symbol}" must be printable ASCII without spaces`;
  return null;
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

export interface TargetInput {
  /** The follower (master wallet that owns the SoDEX account). */
  follower: Address;
  venue: number;
  leader: Address;
  sodexAccountId: bigint;
}

const isUintN = (v: unknown, bits: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < 2 ** bits;
const isU64 = (v: unknown): v is bigint => typeof v === 'bigint' && v >= 0n && v <= MAX_UINT64;

/**
 * Every problem with `terms` for `follower` at unix time `now` (seconds; the block that will store them), in the
 * contract's check order. Empty = valid as far as a pure check can tell. `problems[0]` is the field of the
 * `InvalidTerms` revert the contract would raise (a SHAPE problem means the call cannot even be encoded).
 */
export function termsProblems(terms: Terms, follower: Address, now: number): TermsProblem[] {
  const out: TermsProblem[] = [];
  const add = (field: TermsProblem['field'], message: string) => out.push({ field, message });
  const t = terms;

  // Delegated key: non-zero and never the follower's master key.
  if (!isAddress(t.delegatedKey) || isZeroAddress(t.delegatedKey)) add('DELEGATED_KEY', 'delegatedKey must be a non-zero address');
  else if (isAddress(follower) && sameAddress(t.delegatedKey, follower)) {
    add('DELEGATED_KEY', 'delegatedKey must not be the follower: the master key is never delegated');
  }
  const kp = keyNameProblem(t.keyName);
  if (kp) add('KEY_NAME', kp);

  const scopeOk = t.marketScope === MarketScope.PERPS || t.marketScope === MarketScope.SPOT || t.marketScope === MarketScope.PERPS_AND_SPOT;
  if (!scopeOk) {
    // An ordinal above 3 cannot be ABI-decoded: the contract reverts without data before any check.
    add(isUintN(t.marketScope, 8) && t.marketScope <= 3 ? 'MARKET_SCOPE' : 'SHAPE', 'marketScope must be PERPS, SPOT or PERPS_AND_SPOT');
  }
  const modeOk =
    t.sizingMode === SizingMode.PROPORTIONAL || t.sizingMode === SizingMode.FIXED_RATIO || t.sizingMode === SizingMode.FIXED_NOTIONAL;
  if (!modeOk) {
    add(isUintN(t.sizingMode, 8) && t.sizingMode <= 3 ? 'SIZING_MODE' : 'SHAPE', 'sizingMode must be PROPORTIONAL, FIXED_RATIO or FIXED_NOTIONAL');
  }

  // Fields that bound other fields come first, so the reported field is the root cause; a bound is only checked
  // against fields that are themselves valid (the contract stops at the first failure, so it never reports the rest).
  const capOk = isU64(t.allocationCap) && t.allocationCap > 0n;
  if (!capOk) add(isU64(t.allocationCap) ? 'ALLOCATION_CAP' : 'SHAPE', 'allocationCap must be a uint64 > 0 (USD, 6 decimals)');
  const levTyped = isUintN(t.maxLeverage, 8);
  const levOk = levTyped && t.maxLeverage >= 1 && !(t.marketScope === MarketScope.SPOT && t.maxLeverage !== 1);
  if (!levOk) add(levTyped ? 'MAX_LEVERAGE' : 'SHAPE', 'maxLeverage must be 1..255, and exactly 1 for SPOT');
  const posTyped = isU64(t.maxPositionNotional);
  const posOk =
    posTyped &&
    t.maxPositionNotional > 0n &&
    // Compared in unbounded integers, like the contract's uint256(cap) * leverage.
    (!capOk || !levOk || t.maxPositionNotional <= t.allocationCap * BigInt(t.maxLeverage));
  if (!posOk) add(posTyped ? 'MAX_POSITION_NOTIONAL' : 'SHAPE', 'maxPositionNotional must be 1..allocationCap x maxLeverage');
  if (!isU64(t.sizingValue)) add('SHAPE', 'sizingValue must be a uint64');
  else if (t.sizingValue === 0n) add('SIZING_VALUE', 'sizingValue must be > 0');
  else if (t.sizingMode === SizingMode.FIXED_NOTIONAL && posOk && t.sizingValue > t.maxPositionNotional) {
    add('SIZING_VALUE', 'a FIXED_NOTIONAL sizingValue must not exceed maxPositionNotional');
  }

  if (!isUintN(t.tradeStopLossBps, 16)) add('SHAPE', 'tradeStopLossBps must be a uint16');
  else if (t.tradeStopLossBps > MAX_BPS) add('TRADE_STOP_LOSS', `tradeStopLossBps must be 0 (off) .. ${MAX_BPS}`);
  if (!isUintN(t.maxDrawdownBps, 16)) add('SHAPE', 'maxDrawdownBps must be a uint16');
  else if (t.maxDrawdownBps > MAX_BPS) add('MAX_DRAWDOWN', `maxDrawdownBps must be 0 (off) .. ${MAX_BPS}`);
  if (!isUintN(t.takeProfitBps, 32)) add('SHAPE', 'takeProfitBps must be a uint32 (0 = off, no upper bound)');
  if (!isUintN(t.slippageBps, 16)) add('SHAPE', 'slippageBps must be a uint16');
  else if (t.slippageBps < 1 || t.slippageBps > MAX_BPS) add('SLIPPAGE', `slippageBps must be 1..${MAX_BPS}`);

  if (!Array.isArray(t.symbols)) add('SHAPE', 'symbols must be an array of strings');
  else if (t.symbolMode === SymbolMode.ALL) {
    if (t.symbols.length !== 0) add('SYMBOL_MODE', 'symbolMode ALL requires an empty symbol list');
  } else if (t.symbolMode === SymbolMode.ALLOW || t.symbolMode === SymbolMode.DENY) {
    if (t.symbols.length === 0) add('SYMBOLS', 'ALLOW and DENY need at least one symbol');
    else {
      for (const s of t.symbols) {
        const p = symbolProblem(s);
        if (p) {
          add('SYMBOLS', p);
          break;
        }
      }
    }
  } else {
    // An ordinal above 2 cannot be ABI-decoded: the contract reverts without data before any check.
    add('SHAPE', 'symbolMode must be ALL, ALLOW or DENY');
  }

  if (!isUintN(t.maxBuilderFeePerps, 16)) add('SHAPE', 'maxBuilderFeePerps must be a uint16');
  else if (t.maxBuilderFeePerps > PERPS_BUILDER_FEE_CAP) {
    add('BUILDER_FEE_PERPS', `maxBuilderFeePerps must be 0..${PERPS_BUILDER_FEE_CAP} tenths of a bp (SoDEX cap)`);
  }
  if (!isUintN(t.maxBuilderFeeSpot, 16)) add('SHAPE', 'maxBuilderFeeSpot must be a uint16');
  else if (t.maxBuilderFeeSpot > SPOT_BUILDER_FEE_CAP) {
    add('BUILDER_FEE_SPOT', `maxBuilderFeeSpot must be 0..${SPOT_BUILDER_FEE_CAP} tenths of a bp (SoDEX cap)`);
  }
  if (!isUintN(t.expiry, 40)) add('SHAPE', 'expiry must be a uint40 (unix seconds; 0 = never)');
  else if (t.expiry !== 0 && t.expiry <= now) add('EXPIRY', 'expiry must be 0 (never) or later than the block that stores it');
  if (typeof t.copyExisting !== 'boolean') add('SHAPE', 'copyExisting must be a boolean');
  return out;
}

/** Problems with a new subscription's fixed target (leader, account), in the contract's order. */
export function targetProblems(t: TargetInput): TermsProblem[] {
  const out: TermsProblem[] = [];
  if (!isUintN(t.venue, 8)) out.push({ field: 'SHAPE', message: 'venue must be a uint8' });
  else if (t.venue === 0) out.push({ field: 'VENUE_DISABLED', message: 'venue 0 is never valid' });
  if (!isAddress(t.leader) || isZeroAddress(t.leader)) out.push({ field: 'LEADER', message: 'leader must be a non-zero address' });
  else if (t.venue === Venue.SODEX && isAddress(t.follower) && sameAddress(t.leader, t.follower)) {
    out.push({ field: 'LEADER', message: 'on SoDEX the leader cannot be the follower (a feedback loop); allowed from Hyperliquid' });
  }
  if (!isU64(t.sodexAccountId) || t.sodexAccountId === 0n) {
    out.push({ field: isU64(t.sodexAccountId) ? 'SODEX_ACCOUNT' : 'SHAPE', message: 'sodexAccountId must be a non-zero uint64' });
  }
  return out;
}

/** On-chain facts a pure check cannot see. Read them with the views (or a `CopyTradingIndex`) at one block. */
export interface ChainChecks {
  /** `paused()`: subscribe, update and resume revert with EnforcedPause. */
  paused?: boolean;
  /** `venueInfo(venue).enabled`. */
  venueEnabled?: boolean;
  /** `liveSubscriptionFor(follower, account, venue, leader)`; non-zero = duplicate. */
  existingLiveId?: bigint;
  /** `stopEpochOf(follower)`: a signed Subscribe must carry it. */
  currentStopEpoch?: bigint;
  /** `lastSubscriptionFor(follower, account, venue, leader)`: a signed Subscribe must carry it (audit SEC-04). */
  currentLastId?: bigint;
}

/**
 * Every problem of a new subscription in the order the contract checks them: pause, venue, target, terms, duplicate,
 * and, for a signed Subscribe (`signedStopEpoch` / `signedLastId` given), the stop epoch and the key's last
 * subscription. The signature checks (deadline, nonce, ECDSA / ERC-1271) come after all of these on-chain.
 */
export function subscriptionProblems(
  target: TargetInput,
  terms: Terms,
  now: number,
  chain: ChainChecks = {},
  signedStopEpoch?: bigint,
  signedLastId?: bigint,
): TermsProblem[] {
  const out: TermsProblem[] = [];
  if (chain.paused) out.push({ field: 'PAUSED', message: 'the owner paused new activity (stops still work)' });
  const targetIssues = targetProblems(target);
  if (chain.venueEnabled === false && !targetIssues.some((p) => p.field === 'VENUE_DISABLED')) {
    out.push({ field: 'VENUE_DISABLED', message: `venue ${target.venue} is disabled for new subscriptions` });
  }
  out.push(...targetIssues.filter((p) => p.field === 'VENUE_DISABLED' || p.field === 'SHAPE'));
  out.push(...targetIssues.filter((p) => p.field !== 'VENUE_DISABLED' && p.field !== 'SHAPE'));
  out.push(...termsProblems(terms, target.follower, now));
  if (chain.existingLiveId !== undefined && chain.existingLiveId !== 0n) {
    out.push({ field: 'DUPLICATE', message: `a live subscription to this leader, venue and account exists (id ${chain.existingLiveId})` });
  }
  if (signedStopEpoch !== undefined && chain.currentStopEpoch !== undefined && signedStopEpoch !== chain.currentStopEpoch) {
    out.push({
      field: 'STOP_EPOCH',
      message: `signed for stop epoch ${signedStopEpoch}, the follower is at ${chain.currentStopEpoch} (a kill switch happened)`,
    });
  }
  if (signedLastId !== undefined && chain.currentLastId !== undefined && signedLastId !== chain.currentLastId) {
    out.push({
      field: 'LAST_SUBSCRIPTION',
      message: `signed for last subscription ${signedLastId} of this key, it is now ${chain.currentLastId} (a subscription was created since)`,
    });
  }
  return out;
}

/** Throws a `TermsValidationError` listing every problem of a new subscription. */
export function assertValidSubscription(
  target: TargetInput,
  terms: Terms,
  now: number,
  chain: ChainChecks = {},
  signedStopEpoch?: bigint,
): void {
  const problems = subscriptionProblems(target, terms, now, chain, signedStopEpoch);
  if (problems.length) throw new TermsValidationError(problems);
}

/** Throws a `TermsValidationError` listing every problem of an update's new terms. */
export function assertValidTerms(terms: Terms, follower: Address, now: number): void {
  const problems = termsProblems(terms, follower, now);
  if (problems.length) throw new TermsValidationError(problems);
}

// ---------------------------------------------------------------------------
// Expiry and onboarding helpers
// ---------------------------------------------------------------------------

/** "Expired" exactly as the contract means it: `expiry != 0 && now >= expiry`. */
export const isExpired = (expiry: number, now: number): boolean => expiry !== 0 && now >= expiry;

/** An expiry `seconds` after `now`; there is no cap. Use `NEVER_EXPIRES` (0) for none. */
export function expiryAfter(now: number, seconds: number): number {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new RangeError('now and seconds must be integers, seconds > 0');
  }
  const e = now + seconds;
  if (e >= 2 ** 40) throw new RangeError('expiry does not fit uint40');
  return e;
}

/**
 * The `maxFeeRate` the UI requests in SoDEX's ApproveBuilderFee (or AddAPIKeyWithBuilder): SoDEX has ONE approval for
 * both engines, so it is max(maxBuilderFeePerps, maxBuilderFeeSpot) and the two consents agree (spec §8.2).
 */
export const recommendedBuilderApproval = (terms: Pick<Terms, 'maxBuilderFeePerps' | 'maxBuilderFeeSpot'>): number =>
  Math.max(terms.maxBuilderFeePerps, terms.maxBuilderFeeSpot);

/**
 * `expiresAt` (MILLISECONDS, SoDEX's unit) for the delegated key's registration: the subscription's expiry, or 0
 * ("never") for a subscription that never expires (spec §8.3, Path A). @valuescan/sodex-core refuses both long and
 * never-expiring keys by default (they are meant for browser keys): pass `expiryPolicy: { maxTtlMs, allowNeverExpires }`
 * explicitly for this server-held key.
 */
export const delegatedKeyExpiresAtMs = (terms: Pick<Terms, 'expiry'>): number => (terms.expiry === 0 ? 0 : terms.expiry * 1000);

// ---------------------------------------------------------------------------
// The stored record
// ---------------------------------------------------------------------------

/** Lifecycle fields of a stored record that the terms do not determine. */
export interface StoredMeta {
  status: Status;
  version: number;
  createdAt: number;
  updatedAt: number;
  /** The follower's stop epoch at creation. */
  stopEpoch: bigint;
  /** Only an `unsubscribe` sets it. Default false. */
  closePositions?: boolean;
}

/**
 * The record the contract stores for valid `terms` on `target`: exactly what `getSubscription` returns and what
 * `Subscribed` / `SubscriptionUpdated` carry (addresses in checksum form, `symbolsHash` the list commitment).
 * For optimistic UI updates and test fixtures; it assumes `terms` passed `termsProblems`.
 */
export function storedSubscription(target: TargetInput, terms: Terms, meta: StoredMeta): Subscription {
  return {
    follower: toChecksumAddress(target.follower),
    status: meta.status,
    venue: target.venue,
    marketScope: terms.marketScope,
    sizingMode: terms.sizingMode,
    symbolMode: terms.symbolMode,
    copyExisting: terms.copyExisting,
    maxLeverage: terms.maxLeverage,
    closePositions: meta.closePositions ?? false,
    version: meta.version,
    leader: toChecksumAddress(target.leader),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    slippageBps: terms.slippageBps,
    delegatedKey: toChecksumAddress(terms.delegatedKey),
    expiry: terms.expiry,
    takeProfitBps: terms.takeProfitBps,
    tradeStopLossBps: terms.tradeStopLossBps,
    sodexAccountId: target.sodexAccountId,
    stopEpoch: meta.stopEpoch,
    sizingValue: terms.sizingValue,
    maxDrawdownBps: terms.maxDrawdownBps,
    maxBuilderFeePerps: terms.maxBuilderFeePerps,
    maxBuilderFeeSpot: terms.maxBuilderFeeSpot,
    allocationCap: terms.allocationCap,
    maxPositionNotional: terms.maxPositionNotional,
    symbolsHash: symbolsHash(terms.symbols),
    keyName: terms.keyName,
  };
}

/** The terms of a stored record plus its symbol list (from the latest Subscribed / SubscriptionUpdated event). */
export function termsOf(record: Subscription, symbols: readonly string[]): Terms {
  if (symbolsHash(symbols) !== record.symbolsHash.toLowerCase()) {
    throw new TermsValidationError([{ field: 'SYMBOLS', message: 'the symbol list does not match the record symbolsHash' }]);
  }
  return {
    delegatedKey: record.delegatedKey,
    keyName: record.keyName,
    marketScope: record.marketScope,
    sizingMode: record.sizingMode,
    sizingValue: record.sizingValue,
    allocationCap: record.allocationCap,
    maxPositionNotional: record.maxPositionNotional,
    maxLeverage: record.maxLeverage,
    tradeStopLossBps: record.tradeStopLossBps,
    maxDrawdownBps: record.maxDrawdownBps,
    takeProfitBps: record.takeProfitBps,
    slippageBps: record.slippageBps,
    symbolMode: record.symbolMode,
    symbols: [...symbols],
    copyExisting: record.copyExisting,
    maxBuilderFeePerps: record.maxBuilderFeePerps,
    maxBuilderFeeSpot: record.maxBuilderFeeSpot,
    expiry: record.expiry,
  };
}
