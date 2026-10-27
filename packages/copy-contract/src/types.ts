/**
 * TypeScript mirrors of the enums and structs of IValuescanCopyTrading.
 *
 * Integer convention (the same as viem, so values pass between the two unchanged):
 *   - uint8 .. uint48  -> number
 *   - uint56 .. uint256 -> bigint
 * So uint40 timestamps, uint32 versions and fees are numbers; uint64 amounts, account ids, stop epochs and commitment
 * epochs, and uint256 ids, nonces and deadlines are bigints. Enums are their Solidity ordinal (a number).
 *
 * Struct field order below is the Solidity declaration order. It matters for ABI tuples (the codec encodes by name, but
 * decoding returns keys in this order) and, for `Subscription`, it is the storage packing order.
 */
import type { Address, Hex } from './bytes.ts';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Lifecycle status. NONE = the id does not exist. Views return the EFFECTIVE status: a stored ACTIVE or PAUSED record
 * whose `stopEpoch` is below its follower's current stop epoch (a later kill switch) is STOPPED.
 */
export const Status = { NONE: 0, ACTIVE: 1, PAUSED: 2, STOPPED: 3 } as const;
export type Status = (typeof Status)[keyof typeof Status];

/** SoDEX engines the executor may trade. NONE is invalid in terms. */
export const MarketScope = { NONE: 0, PERPS: 1, SPOT: 2, PERPS_AND_SPOT: 3 } as const;
export type MarketScope = (typeof MarketScope)[keyof typeof MarketScope];

/** Sizing rule (spec §4.5). NONE is invalid in terms. */
export const SizingMode = { NONE: 0, PROPORTIONAL: 1, FIXED_RATIO: 2, FIXED_NOTIONAL: 3 } as const;
export type SizingMode = (typeof SizingMode)[keyof typeof SizingMode];

/** How the symbol list is applied to the SoDEX symbol the executor would trade. */
export const SymbolMode = { ALL: 0, ALLOW: 1, DENY: 2 } as const;
export type SymbolMode = (typeof SymbolMode)[keyof typeof SymbolMode];

/** Why a subscription is STOPPED: `unsubscribe` (FOLLOWER) or `unsubscribeAll` (KILL_SWITCH). */
export const StopReason = { FOLLOWER: 0, KILL_SWITCH: 1 } as const;
export type StopReason = (typeof StopReason)[keyof typeof StopReason];

/** The offending field of an `InvalidTerms(field)` revert. */
export const TermsField = {
  LEADER: 0,
  SODEX_ACCOUNT: 1,
  DELEGATED_KEY: 2,
  KEY_NAME: 3,
  MARKET_SCOPE: 4,
  SIZING_MODE: 5,
  SIZING_VALUE: 6,
  ALLOCATION_CAP: 7,
  MAX_POSITION_NOTIONAL: 8,
  MAX_LEVERAGE: 9,
  TRADE_STOP_LOSS: 10,
  MAX_DRAWDOWN: 11,
  SLIPPAGE: 12,
  SYMBOL_MODE: 13,
  SYMBOLS: 14,
  BUILDER_FEE_PERPS: 15,
  BUILDER_FEE_SPOT: 16,
  EXPIRY: 17,
} as const;
export type TermsField = (typeof TermsField)[keyof typeof TermsField];
export type TermsFieldName = keyof typeof TermsField;

/** Name of an enum value, e.g. `enumName(Status, 2) === 'PAUSED'`; undefined for an unknown ordinal. */
export function enumName<E extends Record<string, number>>(e: E, value: number): keyof E | undefined {
  for (const k of Object.keys(e)) if (e[k] === value) return k as keyof E;
  return undefined;
}

// ---------------------------------------------------------------------------
// Structs
// ---------------------------------------------------------------------------

/**
 * Follower-chosen rules, as submitted and as signed (EIP-712 type `Terms`). Units and bounds: NatSpec of
 * `IValuescanCopyTrading.Terms` and COPY-TRADING.md §4.2; `termsProblems` checks them in the contract's order.
 */
export interface Terms {
  /** EVM address of the SoDEX API key the follower authorised for ValueDesk's executor. Not the follower. */
  delegatedKey: Address;
  /** SoDEX key name: `^[0-9a-zA-Z_-]{1,36}$`, not "default". */
  keyName: string;
  marketScope: MarketScope;
  sizingMode: SizingMode;
  /** uint64: ppm for PROPORTIONAL/FIXED_RATIO, USD 6 dec for FIXED_NOTIONAL (<= maxPositionNotional). */
  sizingValue: bigint;
  /** uint64 USD 6 dec, > 0. */
  allocationCap: bigint;
  /** uint64 USD 6 dec, 1..allocationCap x maxLeverage. */
  maxPositionNotional: bigint;
  /** uint8 whole multiples, >= 1; exactly 1 for SPOT. */
  maxLeverage: number;
  /** uint16 bps of entry price; 0 = off, else <= 10000. */
  tradeStopLossBps: number;
  /** uint16 bps of allocationCap; 0 = off, else <= 10000. */
  maxDrawdownBps: number;
  /** uint32 bps of allocationCap; 0 = off. No upper bound. */
  takeProfitBps: number;
  /** uint16 bps, 1..10000. */
  slippageBps: number;
  symbolMode: SymbolMode;
  /** SoDEX symbol names, exactly as signed (order and duplicates are the follower's choice). Empty for ALL. */
  symbols: readonly string[];
  copyExisting: boolean;
  /** uint16 tenths of a bp, 0..200. */
  maxBuilderFeePerps: number;
  /** uint16 tenths of a bp, 0..2000. */
  maxBuilderFeeSpot: number;
  /** uint40 unix seconds; 0 = never expires, else in the future when stored. */
  expiry: number;
}

/**
 * A stored subscription as returned by `getSubscription` (with the effective status) and carried by `Subscribed` /
 * `SubscriptionUpdated` (with the stored status, which is the effective one at that moment).
 */
export interface Subscription {
  follower: Address;
  status: Status;
  venue: number;
  marketScope: MarketScope;
  sizingMode: SizingMode;
  symbolMode: SymbolMode;
  copyExisting: boolean;
  maxLeverage: number;
  /** Set by `unsubscribe`; false otherwise (for a kill switch see `killSwitchInfo` / `stopDetails`). */
  closePositions: boolean;
  /** Starts at 1, +1 on every change of the record (update, pause, resume, unsubscribe). A kill switch changes none. */
  version: number;
  leader: Address;
  createdAt: number;
  updatedAt: number;
  slippageBps: number;
  delegatedKey: Address;
  expiry: number;
  takeProfitBps: number;
  tradeStopLossBps: number;
  sodexAccountId: bigint;
  /** The follower's stop epoch when the subscription was created. */
  stopEpoch: bigint;
  sizingValue: bigint;
  maxDrawdownBps: number;
  maxBuilderFeePerps: number;
  maxBuilderFeeSpot: number;
  allocationCap: bigint;
  maxPositionNotional: bigint;
  /** EIP-712 `string[]` hash of the symbol list (keccak256("") when empty); the list itself is in the events. */
  symbolsHash: Hex;
  keyName: string;
}

/** Nonce, deadline and signature of a `...WithSig` call. */
export interface SignatureParams {
  /** uint256, unordered: bit `nonce & 0xff` of word `nonce >> 8`. */
  nonce: bigint;
  /** uint256 unix seconds, inclusive. */
  deadline: bigint;
  /** 65-byte r||s||v (v 27/28, low s) for EOAs, or whatever the signer's ERC-1271 wallet accepts. */
  signature: Hex;
}

/** `killSwitchInfo(follower, stopEpoch)`. */
export interface KillSwitch {
  /** Timestamp of the `unsubscribeAll` that raised the epoch to this value; 0 if never reached. */
  triggeredAt: number;
  closePositions: boolean;
}

/** `executorInfo(executor)`. */
export interface ExecutorInfo {
  authorised: boolean;
  updatedAt: number;
  /** Highest committed epoch; kept when de-authorised. */
  lastEpoch: bigint;
}

/** `builderTerms()`. */
export interface BuilderTerms {
  builderId: bigint;
  perpsFee: number;
  spotFee: number;
  updatedAt: number;
}

/** `venueInfo(venue)` (the Solidity struct is called `Venue`). */
export interface VenueInfo {
  enabled: boolean;
  name: string;
}

/** `commitment(executor, epoch)`. */
export interface Commitment {
  merkleRoot: Hex;
  count: number;
  committedAt: number;
}

/** `effectiveBuilderFee(id)`: what the executor may attach as `builder{id, fee}` per engine (at most). */
export interface EffectiveBuilderFee {
  builderId: bigint;
  perpsFee: number;
  spotFee: number;
}

/** `stopDetails(id)`. */
export interface StopDetails {
  reason: StopReason;
  closePositions: boolean;
  stoppedAt: number;
}

/** A page of ids and the list's total length (`subscriptionsOfFollower`, `liveSubscriptionsOfFollower`, ...). */
export interface Page {
  ids: bigint[];
  total: bigint;
}

/** ERC-5267 `eip712Domain()`. */
export interface Eip712DomainInfo {
  fields: Hex;
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: Address;
  salt: Hex;
  extensions: bigint[];
}
