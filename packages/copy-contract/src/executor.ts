/**
 * The executor's per-signal decisions (COPY-TRADING.md §4.4-§4.6, §8.1-§8.3) as pure functions over the
 * event-sourced `CopyTradingIndex`, plus the preflight evaluation and the ClobGateway calldata an executor or a follower
 * needs. Nothing here sends anything.
 *
 *   copyMode(index, id, now)          open, reduce-only, wind-down (stopped, by the follower or a kill switch), ignore
 *   gateSignal(...)                    scope, symbol filter, cycle protection, staleness: trade or skip (with a code)
 *   builderForOrder(...)               the `builder {id, fee}` to attach (never above the consent or the SoDEX approval)
 *   evaluatePreflight(...)             account ownership, key registered and unexpired, builder approval
 *
 * What the contract guarantees and what it does not: it records the follower's consent and stop; SoDEX enforces the
 * follower's builder APPROVAL, the per-engine fee caps and (per its docs) the key's permission mask. Everything else
 * here is executor honesty, made auditable by the execution commitments (merkle.ts) and clobscan.
 *
 * Engine names are SoDEX's ('spot' | 'perps'), as in @valuescan/sodex-core, so a decision can be passed straight to
 * `perpsActions.newOrder(accountID, symbolID, orders, builder)` / `spotActions.batchNewOrder(accountID, orders, builder)`.
 */
import { encodeAbiParameters, decodeAbiParameters, type AbiParameter } from './abiCodec.ts';
import { type Address, type Hex, sameAddress, toUint } from './bytes.ts';
import { SIGNAL_STALENESS_MS, SODEX_GATEWAY_ENGINE, SODEX_GATEWAY_SELECTORS, STOP_SLA_SECONDS } from './constants.ts';
import type { CopyTradingIndex, IndexedSubscription } from './state.ts';
import { MarketScope, Status, StopReason, type EffectiveBuilderFee, type Subscription, SymbolMode } from './types.ts';
import { isExpired } from './validate.ts';
import { SkipReason } from './merkle.ts';

/** A SoDEX engine, spelled as @valuescan/sodex-core spells it. */
export type SodexEngine = 'spot' | 'perps';

/** What the executor may do for one subscription right now. */
export type CopyMode =
  /** Effective ACTIVE and not expired (the contract's `isCopyable`): mirror opens, increases, reductions and closes. */
  | { mode: 'open'; subscription: IndexedSubscription }
  /** Live but not copyable: mirror only reductions and closes; keep enforcing stop loss, drawdown and take profit. */
  | { mode: 'reduce-only'; reason: 'paused' | 'expired'; subscription: IndexedSubscription }
  /**
   * STOPPED (terminal), by `unsubscribe` (FOLLOWER) or by a kill switch (KILL_SWITCH, whatever the stored record says):
   * cancel resting copy orders; if `closePositions`, flatten with reduce-only orders; stop using the key.
   */
  | { mode: 'wind-down'; reason: StopReason; closePositions: boolean; stoppedAt: number; subscription: IndexedSubscription }
  /** Unknown id. */
  | { mode: 'ignore'; reason: 'unknown' };

/**
 * The executor's gate for subscription `id` at unix time `now` (seconds). `open` is exactly the contract's
 * `isCopyable`. A kill switch is applied through the stop-epoch rule: an older ACTIVE or PAUSED record is STOPPED.
 *
 * A drawdown or take-profit HALT is off-chain executor state and is not visible here: treat a halted subscription as
 * reduce-only until the follower re-arms it (an update while ACTIVE, or pause then resume; see `armedAt`).
 */
export function copyMode(index: CopyTradingIndex, id: bigint, now: number): CopyMode {
  const s = index.get(id);
  if (!s) return { mode: 'ignore', reason: 'unknown' };
  const status = index.statusOf(id);
  if (status === Status.STOPPED) {
    const d = index.stopDetails(id)!;
    return { mode: 'wind-down', reason: d.reason, closePositions: d.closePositions, stoppedAt: d.stoppedAt, subscription: s };
  }
  if (status === Status.PAUSED) return { mode: 'reduce-only', reason: 'paused', subscription: s };
  if (isExpired(s.record.expiry, now)) return { mode: 'reduce-only', reason: 'expired', subscription: s };
  return { mode: 'open', subscription: s };
}

/** Whether `marketScope` lets the executor trade on `engine`. */
export function engineInScope(scope: number, engine: SodexEngine): boolean {
  if (scope === MarketScope.PERPS_AND_SPOT) return true;
  if (scope === MarketScope.PERPS) return engine === 'perps';
  if (scope === MarketScope.SPOT) return engine === 'spot';
  return false;
}

const symbolSets = new WeakMap<readonly string[], ReadonlySet<string>>();

/**
 * Whether the subscription's symbol filter admits the SoDEX symbol the executor would trade (for a Hyperliquid leader:
 * AFTER mapping the HL coin to a SoDEX symbol; skip if there is no mapping). Exact, case-sensitive match against the
 * list from the latest Subscribed / SubscriptionUpdated event (the index checked it against `symbolsHash`). Lists
 * have no size limit, so the lookup uses a set built once per list.
 */
export function symbolAllowed(sub: { record: Pick<Subscription, 'symbolMode'>; symbols: readonly string[] }, sodexSymbol: string): boolean {
  const mode = sub.record.symbolMode;
  if (mode === SymbolMode.ALL) return true;
  let set = symbolSets.get(sub.symbols);
  if (!set) symbolSets.set(sub.symbols, (set = new Set(sub.symbols)));
  const listed = set.has(sodexSymbol);
  if (mode === SymbolMode.ALLOW) return listed;
  if (mode === SymbolMode.DENY) return !listed;
  return false;
}

/** A delegated key ValueDesk's key service generated, and for whom (one key per follower and SoDEX account). */
export interface KeyIssuance {
  delegatedKey: Address;
  follower: Address;
  sodexAccountId: bigint;
}

/**
 * Whether ValueDesk serves this subscription at all: its delegated key was issued by ValueDesk's key service for
 * exactly this follower and SoDEX account. Anyone can record a subscription to any leader with any key and any
 * account (the contract cannot tell), so the executor filters on this BEFORE preflight, fan-out and reconciliation;
 * everything else costs it nothing (audit: leader spam). `issuanceOf` looks the key up in the key store.
 */
export function isServiceable(
  record: Pick<Subscription, 'delegatedKey' | 'follower' | 'sodexAccountId'>,
  issuanceOf: (delegatedKey: Address) => KeyIssuance | undefined,
): boolean {
  const i = issuanceOf(record.delegatedKey);
  return !!i && sameAddress(i.delegatedKey, record.delegatedKey) && sameAddress(i.follower, record.follower) && i.sodexAccountId === record.sodexAccountId;
}

export interface SignalInput {
  /** The SoDEX symbol the copy would trade (after the HL -> SoDEX mapping); null when unmapped. */
  sodexSymbol: string | null;
  engine: SodexEngine;
  /** Whether the copy order would open or increase exposure (false: it only reduces or closes). */
  increases: boolean;
  /** The address that signed the LEADER's order, when known (SoDEX: recovered from clobscan / the order feed). */
  leaderOrderSigner?: Address;
  /** Leader fill time and now, in ms: signals older than `maxAgeMs` are skipped. */
  signalTimeMs: number;
  nowMs: number;
  maxAgeMs?: number;
}

export type SignalDecision =
  | { go: true; mode: 'open' | 'reduce-only'; subscription: IndexedSubscription }
  | { go: false; skipReason: SkipReason; detail: string };

/**
 * Gate one leader signal for one subscription (spec §8.3 "per leader event", steps 1-3; sizing and clipping, §4.5,
 * are the executor's own). Record every `go: false` as a SKIP leaf with `skipReason` (merkle.ts).
 *
 * CYCLE PROTECTION ASKS THE KEY STORE, NOT THE INDEX. `issuanceOf` is the same lookup `isServiceable` takes. The
 * contract accepts any `delegatedKey` in anyone's subscription, so "some subscription names this key" is a flag
 * anyone can plant on any address: one cheap subscription naming a leader's own order signer used to make every
 * fill of that leader a "copy of a copy" for every follower - closes included, leaving followers in positions the
 * leader had left (security audit 2026-09-30, C-1). Only a key ValueDesk's key service issued signs copy orders.
 */
export function gateSignal(
  index: CopyTradingIndex,
  id: bigint,
  i: SignalInput,
  issuanceOf: (delegatedKey: Address) => KeyIssuance | undefined,
): SignalDecision {
  const m = copyMode(index, id, Math.floor(i.nowMs / 1000));
  if (m.mode === 'ignore') return { go: false, skipReason: SkipReason.NOT_COPYABLE, detail: 'unknown subscription' };
  if (m.mode === 'wind-down') return { go: false, skipReason: SkipReason.NOT_COPYABLE, detail: 'subscription is STOPPED' };
  const signerIssuance = i.leaderOrderSigner ? issuanceOf(i.leaderOrderSigner) : undefined;
  if (i.leaderOrderSigner && signerIssuance && sameAddress(signerIssuance.delegatedKey, i.leaderOrderSigner)) {
    return { go: false, skipReason: SkipReason.COPY_OF_COPY, detail: 'the leader fill came from a ValueDesk copy order' };
  }
  if (i.nowMs - i.signalTimeMs > (i.maxAgeMs ?? SIGNAL_STALENESS_MS)) {
    return { go: false, skipReason: SkipReason.STALE_SIGNAL, detail: `signal older than ${i.maxAgeMs ?? SIGNAL_STALENESS_MS} ms` };
  }
  if (i.sodexSymbol === null) return { go: false, skipReason: SkipReason.UNMAPPED_SYMBOL, detail: 'no SoDEX symbol for this coin' };
  if (!engineInScope(m.subscription.record.marketScope, i.engine)) {
    return { go: false, skipReason: SkipReason.OUT_OF_SCOPE, detail: `${i.engine} is outside marketScope` };
  }
  if (!symbolAllowed(m.subscription, i.sodexSymbol)) {
    return { go: false, skipReason: SkipReason.SYMBOL_FILTERED, detail: `${i.sodexSymbol} is filtered out` };
  }
  if (i.increases && m.mode !== 'open') {
    return { go: false, skipReason: SkipReason.REDUCE_ONLY, detail: `subscription is ${m.reason}: reductions only` };
  }
  return { go: true, mode: m.mode, subscription: m.subscription };
}

export interface BuilderForOrderInput {
  /** `effectiveBuilderFee(id)` from the index (or the view): min(current fee, the follower's consent). */
  effective: EffectiveBuilderFee;
  engine: SodexEngine;
  /** Whether the order only reduces or closes a position. */
  reduceOnly: boolean;
  /**
   * The follower's current SoDEX approval for `effective.builderId` (`maxFeeRate` from
   * GET /api/v1/user/{follower}/builders), tenths of a bp; null or 0 when there is none.
   */
  approvedMaxFeeRate: number | null;
  /**
   * ValueDesk policy: charge the builder fee on reduce-only orders too. Default false ("opens only", report 08): the
   * executor MAY attach less than the effective fee, never more.
   */
  feeOnReduceOnly?: boolean;
}

export type BuilderDecision =
  /** Trade; attach `builder` (null = omit the builder field from the order). */
  | { trade: true; builder: { id: bigint; fee: number } | null }
  /** Do not place this order: it would carry a fee the follower never approved on SoDEX (SoDEX would reject it). */
  | { trade: false; reason: 'no-builder-approval' };

/**
 * The builder code for one order: never above the effective fee (the on-chain consent, capped by the current fee) and
 * never above the follower's SoDEX approval. A zero fee means no builder field at all.
 *
 * Missing approval: an OPENING order that should carry a fee is refused (§8.3 preflight: "none and the effective fee
 * is > 0: do not trade"); a REDUCE-ONLY order is still placed, without a builder, because reducing risk must never be
 * blocked by fee plumbing.
 */
export function builderForOrder(i: BuilderForOrderInput): BuilderDecision {
  let fee = i.engine === 'perps' ? i.effective.perpsFee : i.effective.spotFee;
  if (i.reduceOnly && !i.feeOnReduceOnly) fee = 0;
  if (fee <= 0) return { trade: true, builder: null };
  const approval = i.approvedMaxFeeRate ?? 0;
  if (approval <= 0) return i.reduceOnly ? { trade: true, builder: null } : { trade: false, reason: 'no-builder-approval' };
  return { trade: true, builder: { id: i.effective.builderId, fee: Math.min(fee, approval) } };
}

/**
 * Stop SLA (§8.3): the latest unix time (seconds) at which the executor may still place an opening or increasing order
 * after a stop-type event (SubscriptionStopped, SubscriptionPaused, KillSwitchTriggered, or a key-changing or tightening
 * SubscriptionUpdated) in a block with timestamp `blockTimestamp`.
 */
export const stopDeadline = (blockTimestamp: number, slaSeconds = STOP_SLA_SECONDS): number => blockTimestamp + slaSeconds;

// ---------------------------------------------------------------------------
// Preflight (§8.3): before the first order of a subscription and after every update
// ---------------------------------------------------------------------------

/** An API key as SoDEX lists it (GET /api/v1/{engine}/accounts/{id}/api-keys or /api/v1/user/{addr}/api-keys). */
export interface SodexApiKeyInfo {
  name: string;
  publicKey: string;
  /** MILLISECONDS; 0 = never. */
  expiresAt: number;
  /** Disable mask; absent = an ordinary (full-permission) key. */
  permissions?: number | null;
}

export interface PreflightInput {
  subscription: Subscription;
  /** Unix seconds. */
  now: number;
  /** ClobGateway `getAccountsByAddress(follower)` (eth_call; decode with `decodeAccountsByAddress`). */
  followerAccounts: readonly bigint[];
  /** The keys SoDEX lists for the account, per engine the subscription's scope needs. */
  apiKeys: { perps?: readonly SodexApiKeyInfo[]; spot?: readonly SodexApiKeyInfo[] };
  /** Whether ValueDesk's key store holds the private key of `subscription.delegatedKey`. */
  keyStoreHasKey: boolean;
  /** The follower's SoDEX approval for the builder id (GET /api/v1/user/{follower}/builders), or null. */
  builderApproval: { builderId: bigint; maxFeeRate: number } | null;
  effective: EffectiveBuilderFee;
}

export interface PreflightResult {
  ok: boolean;
  problems: string[];
  /** Informational findings (for example an ordinary, full-permission key where a mask-14 key was expected). */
  notes: string[];
  /** The highest fee the executor may attach per engine: min(effective fee, SoDEX approval). */
  feeCeiling: { perps: number; spot: number };
}

/** The spec's preflight: if any check fails, do not trade, report why, re-check at most every 60 s. */
export function evaluatePreflight(i: PreflightInput): PreflightResult {
  const problems: string[] = [];
  const notes: string[] = [];
  const r = i.subscription;
  if (!i.followerAccounts.includes(r.sodexAccountId)) {
    problems.push(`SoDEX account ${r.sodexAccountId} is not owned by the follower ${r.follower}`);
  }
  const engines: SodexEngine[] = [];
  if (engineInScope(r.marketScope, 'perps')) engines.push('perps');
  if (engineInScope(r.marketScope, 'spot')) engines.push('spot');
  for (const e of engines) {
    const key = (i.apiKeys[e] ?? []).find((x) => x.name === r.keyName);
    if (!key) problems.push(`no ${e} API key named ${r.keyName}`);
    else if (!sameAddress(key.publicKey, r.delegatedKey)) problems.push(`the ${e} key ${r.keyName} is not ${r.delegatedKey}`);
    else if (key.expiresAt !== 0 && key.expiresAt <= i.now * 1000) problems.push(`the ${e} key ${r.keyName} has expired`);
    else if (key.permissions === undefined || key.permissions === null) {
      notes.push(`the ${e} key ${r.keyName} is an ordinary (full-permission) key, not a mask-14 trade-only key`);
    } else if (key.permissions !== 14) notes.push(`the ${e} key ${r.keyName} has permission mask ${key.permissions}, not 14`);
  }
  if (!i.keyStoreHasKey) problems.push(`ValueDesk's key store does not hold ${r.delegatedKey}`);
  const approval = i.builderApproval && i.builderApproval.builderId === i.effective.builderId ? i.builderApproval.maxFeeRate : 0;
  const feeCeiling = { perps: Math.min(i.effective.perpsFee, approval), spot: Math.min(i.effective.spotFee, approval) };
  const wantsFee = engines.some((e) => (e === 'perps' ? i.effective.perpsFee : i.effective.spotFee) > 0);
  if (wantsFee && approval === 0) problems.push(`no SoDEX builder approval for builder ${i.effective.builderId}`);
  else if (wantsFee && engines.some((e) => (e === 'perps' ? i.effective.perpsFee : i.effective.spotFee) > approval)) {
    notes.push(`the SoDEX approval (${approval}) is below the effective fee; attach at most the approval`);
  }
  return { ok: problems.length === 0, problems, notes, feeCeiling };
}

// ---------------------------------------------------------------------------
// ClobGateway calldata (never sent by this package)
// ---------------------------------------------------------------------------

const P = (type: string, name: string): AbiParameter => ({ type, name });

/** Calldata for SoDEX's ClobGateway at SODEX_CLOB_GATEWAY. */
export const sodexGatewayCalls = {
  /** Read-only `eth_call`: the follower's SoDEX account ids (preflight check 1). */
  getAccountsByAddress: (owner: Address): Hex =>
    (SODEX_GATEWAY_SELECTORS.getAccountsByAddress + encodeAbiParameters([P('address', 'owner')], [owner]).slice(2)) as Hex,
  /** Sent BY THE ACCOUNT OWNER (needs SOSO): register a key on-chain (no permission mask, never expires). */
  addAPIKey: (engine: SodexEngine, name: string, publicKey: Address): Hex =>
    (SODEX_GATEWAY_SELECTORS.addAPIKey +
      encodeAbiParameters([P('uint256', 'destination'), P('string', 'name'), P('bytes', 'pubkey')], [
        BigInt(SODEX_GATEWAY_ENGINE[engine]),
        name,
        publicKey,
      ]).slice(2)) as Hex,
  /** Sent BY THE ACCOUNT OWNER (needs SOSO): the on-chain hard stop; call it for spot AND perps. */
  revokeAPIKey: (engine: SodexEngine, name: string): Hex =>
    (SODEX_GATEWAY_SELECTORS.revokeAPIKey +
      encodeAbiParameters([P('uint256', 'destination'), P('string', 'name')], [BigInt(SODEX_GATEWAY_ENGINE[engine]), name]).slice(2)) as Hex,
} as const;

/** Decode the return data of `getAccountsByAddress`. */
export function decodeAccountsByAddress(data: Hex): bigint[] {
  const [ids] = decodeAbiParameters([P('uint256[]', 'ids')], data) as [bigint[]];
  return ids.map((v) => toUint(v, 256));
}
