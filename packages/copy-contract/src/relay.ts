/**
 * Gasless relaying of signed follower actions (COPY-TRADING.md §6.7; docs/contracts/INTEGRATION.md, "Relayer").
 *
 *   UI       const req = prepareAction({ verifyingContract: proxy }, action);  // typed data + digest
 *            const signature = await wallet.signTypedData(req.typedData);      // eth_signTypedData_v4
 *            POST /relay   body: serializeSignedAction({ action, signature, chainId, verifyingContract: proxy })
 *
 *   relayer  const signed = parseSignedAction(body);                           // strict, bigint-safe
 *            const tx = buildRelayTransaction(signed, { contract: proxy, now, ...chainFacts });
 *            if (tx.problems.length) reject(tx.problems);
 *            eth_call({ to: tx.to, data: tx.data }) -> on revert: classifyRevert(revertData)
 *            eth_sendRawTransaction({ to: tx.to, data: tx.data, gas <= tx.gasLimit, value: 0 })
 *
 * The relayer is untrusted by design: the signature binds the follower, every argument (symbols included), the nonce,
 * the deadline, the chain and the proxy. It can only submit or withhold, and the follower can always submit the same
 * signature through another relayer or call the contract directly.
 */
import { type Address, type Hex, isAddress, isHex, sameAddress, toUint } from './bytes.ts';
import { calls, decodeCall, decodeRevert } from './calldata.ts';
import { RELAYER_GAS_CAP, VALUECHAIN_CHAIN_ID } from './constants.ts';
import {
  type CopyTradingAction,
  type CopyTradingPrimaryType,
  type DomainInput,
  PRIMARY_TYPES,
  WITH_SIG_FUNCTION,
  actionMessage,
  actionSigner,
  prepareAction,
} from './eip712.ts';
import { normalizeSignature, ozTryRecover } from './signature.ts';
import type { SignatureParams, Terms } from './types.ts';

/** What the UI posts to the relayer. */
export interface SignedAction {
  action: CopyTradingAction;
  /** The wallet's signature over the action's typed data (any shape normalizeSignature accepts, or ERC-1271 bytes). */
  signature: Hex;
  chainId: number;
  /** The proxy the signature is for. */
  verifyingContract: Address;
}

export class RelayError extends Error {
  override name = 'RelayError';
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/** JSON with bigints as decimal strings. */
export const serializeSignedAction = (s: SignedAction): string =>
  JSON.stringify(s, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

const big = (v: unknown, bits: number, what: string): bigint => {
  if (typeof v !== 'string' && typeof v !== 'number') throw new RelayError(`${what} must be a decimal string`);
  try {
    return toUint(v, bits, what);
  } catch (e) {
    throw new RelayError((e as Error).message);
  }
};
const num = (v: unknown, bits: number, what: string): number => Number(big(v, bits, what));
const addr = (v: unknown, what: string): Address => {
  if (!isAddress(v)) throw new RelayError(`${what} must be an address`);
  return v;
};
const bool = (v: unknown, what: string): boolean => {
  if (typeof v !== 'boolean') throw new RelayError(`${what} must be a boolean`);
  return v;
};
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new RelayError(`${what} must be a string`);
  return v;
};

/** Resource limits on untrusted input. They are relayer policy, not protocol limits (the contract has none). */
export interface ParseLimits {
  /** Maximum request body length in characters. Default 1,000,000. */
  maxBodyChars?: number;
  /** Maximum number of symbols. Default 10,000. */
  maxSymbols?: number;
  /** Maximum length of one symbol. Default 256. */
  maxSymbolChars?: number;
  /** Maximum signature length in bytes (ERC-1271 wallets may use long signatures). Default 8,192. */
  maxSignatureBytes?: number;
}

function parseTerms(v: unknown, lim: Required<ParseLimits>): Terms {
  if (!v || typeof v !== 'object') throw new RelayError('terms must be an object');
  const t = v as Record<string, unknown>;
  const symbols = t['symbols'];
  if (!Array.isArray(symbols) || symbols.length > lim.maxSymbols) {
    throw new RelayError(`terms.symbols must be an array of at most ${lim.maxSymbols} strings`);
  }
  return {
    delegatedKey: addr(t['delegatedKey'], 'terms.delegatedKey'),
    keyName: str(t['keyName'], 'terms.keyName'),
    marketScope: num(t['marketScope'], 8, 'terms.marketScope') as Terms['marketScope'],
    sizingMode: num(t['sizingMode'], 8, 'terms.sizingMode') as Terms['sizingMode'],
    sizingValue: big(t['sizingValue'], 64, 'terms.sizingValue'),
    allocationCap: big(t['allocationCap'], 64, 'terms.allocationCap'),
    maxPositionNotional: big(t['maxPositionNotional'], 64, 'terms.maxPositionNotional'),
    maxLeverage: num(t['maxLeverage'], 8, 'terms.maxLeverage'),
    tradeStopLossBps: num(t['tradeStopLossBps'], 16, 'terms.tradeStopLossBps'),
    maxDrawdownBps: num(t['maxDrawdownBps'], 16, 'terms.maxDrawdownBps'),
    takeProfitBps: num(t['takeProfitBps'], 32, 'terms.takeProfitBps'),
    slippageBps: num(t['slippageBps'], 16, 'terms.slippageBps'),
    symbolMode: num(t['symbolMode'], 8, 'terms.symbolMode') as Terms['symbolMode'],
    symbols: symbols.map((s, i) => {
      const x = str(s, `terms.symbols[${i}]`);
      if (x.length > lim.maxSymbolChars) throw new RelayError(`terms.symbols[${i}] is longer than ${lim.maxSymbolChars}`);
      return x;
    }),
    copyExisting: bool(t['copyExisting'], 'terms.copyExisting'),
    maxBuilderFeePerps: num(t['maxBuilderFeePerps'], 16, 'terms.maxBuilderFeePerps'),
    maxBuilderFeeSpot: num(t['maxBuilderFeeSpot'], 16, 'terms.maxBuilderFeeSpot'),
    expiry: num(t['expiry'], 40, 'terms.expiry'),
  };
}

/** Parse and strictly validate a posted signed action (untrusted input). */
export function parseSignedAction(json: string, limits: ParseLimits = {}): SignedAction {
  const lim: Required<ParseLimits> = {
    maxBodyChars: limits.maxBodyChars ?? 1_000_000,
    maxSymbols: limits.maxSymbols ?? 10_000,
    maxSymbolChars: limits.maxSymbolChars ?? 256,
    maxSignatureBytes: limits.maxSignatureBytes ?? 8_192,
  };
  if (typeof json !== 'string' || json.length > lim.maxBodyChars) throw new RelayError('body is missing or too large');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new RelayError('body is not JSON');
  }
  if (!raw || typeof raw !== 'object') throw new RelayError('body must be an object');
  const o = raw as Record<string, unknown>;
  const a = o['action'] as Record<string, unknown> | undefined;
  if (!a || typeof a !== 'object') throw new RelayError('action must be an object');
  const type = a['type'];
  if (typeof type !== 'string' || !PRIMARY_TYPES.includes(type as CopyTradingPrimaryType)) {
    throw new RelayError(`action.type must be one of ${PRIMARY_TYPES.join(', ')}`);
  }
  const follower = addr(a['follower'], 'action.follower');
  const nonce = big(a['nonce'], 256, 'action.nonce');
  const deadline = big(a['deadline'], 256, 'action.deadline');
  let action: CopyTradingAction;
  switch (type as CopyTradingPrimaryType) {
    case 'Subscribe':
      action = {
        type: 'Subscribe',
        follower,
        venue: num(a['venue'], 8, 'action.venue'),
        leader: addr(a['leader'], 'action.leader'),
        sodexAccountId: big(a['sodexAccountId'], 64, 'action.sodexAccountId'),
        terms: parseTerms(a['terms'], lim),
        stopEpoch: big(a['stopEpoch'], 64, 'action.stopEpoch'),
        expectedLastId: big(a['expectedLastId'], 256, 'action.expectedLastId'),
        nonce,
        deadline,
      };
      break;
    case 'UpdateSubscription':
      action = {
        type: 'UpdateSubscription',
        follower,
        subscriptionId: big(a['subscriptionId'], 256, 'action.subscriptionId'),
        expectedVersion: num(a['expectedVersion'], 32, 'action.expectedVersion'),
        terms: parseTerms(a['terms'], lim),
        nonce,
        deadline,
      };
      break;
    case 'PauseSubscription':
      action = { type: 'PauseSubscription', follower, subscriptionId: big(a['subscriptionId'], 256, 'action.subscriptionId'), nonce, deadline };
      break;
    case 'ResumeSubscription':
      action = {
        type: 'ResumeSubscription',
        follower,
        subscriptionId: big(a['subscriptionId'], 256, 'action.subscriptionId'),
        expectedVersion: num(a['expectedVersion'], 32, 'action.expectedVersion'),
        nonce,
        deadline,
      };
      break;
    case 'Unsubscribe':
      action = {
        type: 'Unsubscribe',
        follower,
        subscriptionId: big(a['subscriptionId'], 256, 'action.subscriptionId'),
        closePositions: bool(a['closePositions'], 'action.closePositions'),
        nonce,
        deadline,
      };
      break;
    case 'UnsubscribeAll':
      action = { type: 'UnsubscribeAll', follower, closePositions: bool(a['closePositions'], 'action.closePositions'), nonce, deadline };
      break;
    case 'InvalidateNonces':
      action = {
        type: 'InvalidateNonces',
        follower,
        word: big(a['word'], 256, 'action.word'),
        mask: big(a['mask'], 256, 'action.mask'),
        nonce,
        deadline,
      };
      break;
  }
  const signature = o['signature'];
  if (!isHex(signature) || (signature.length - 2) / 2 > lim.maxSignatureBytes || signature.length <= 2) {
    throw new RelayError('signature must be non-empty hex bytes');
  }
  return {
    action,
    signature,
    chainId: num(o['chainId'], 53, 'chainId'),
    verifyingContract: addr(o['verifyingContract'], 'verifyingContract'),
  };
}

// ---------------------------------------------------------------------------
// Transaction building
// ---------------------------------------------------------------------------

/** Calldata of the `...WithSig` function that carries `action` and `sig`. */
export function withSigCalldata(action: CopyTradingAction, sig: SignatureParams): Hex {
  actionMessage(action); // range-checks every field
  switch (action.type) {
    case 'Subscribe':
      return calls.subscribeWithSig(
        action.follower,
        action.venue,
        action.leader,
        action.sodexAccountId,
        action.terms,
        action.stopEpoch,
        action.expectedLastId,
        sig,
      );
    case 'UpdateSubscription':
      return calls.updateSubscriptionWithSig(action.subscriptionId, action.expectedVersion, action.terms, sig);
    case 'PauseSubscription':
      return calls.pauseSubscriptionWithSig(action.subscriptionId, sig);
    case 'ResumeSubscription':
      return calls.resumeSubscriptionWithSig(action.subscriptionId, action.expectedVersion, sig);
    case 'Unsubscribe':
      return calls.unsubscribeWithSig(action.subscriptionId, action.closePositions, sig);
    case 'UnsubscribeAll':
      return calls.unsubscribeAllWithSig(action.follower, action.closePositions, sig);
    case 'InvalidateNonces':
      return calls.invalidateNoncesWithSig(action.follower, action.word, action.mask, sig);
  }
}

/** Whether an action only reduces risk: never blocked by the owner's pause, never refused for rate reasons first. */
export const isStopAction = (type: CopyTradingPrimaryType): boolean =>
  type === 'PauseSubscription' || type === 'Unsubscribe' || type === 'UnsubscribeAll';

/** Whether an action works while the contract is paused (stops and nonce cancellation). */
export const worksWhilePaused = (type: CopyTradingPrimaryType): boolean => isStopAction(type) || type === 'InvalidateNonces';

/** Actions that name a subscription id instead of the follower: the call does not carry the follower. */
export const isIdBased = (type: CopyTradingPrimaryType): boolean =>
  type === 'UpdateSubscription' || type === 'PauseSubscription' || type === 'ResumeSubscription' || type === 'Unsubscribe';

export interface RelayContext {
  /** The proxy this relayer serves. */
  contract: Address;
  /** Default 286623. */
  chainId?: number;
  /** Unix seconds. */
  now: number;
  /** Refuse signatures that expire within this many seconds (time to land). Default 30. */
  minDeadlineMarginSec?: number;
  /** For id-based actions: the subscription's follower (index or `getSubscription`). Signatures by anyone else revert. */
  subscriptionFollower?: Address;
  /** For Subscribe: `stopEpochOf(follower)`. A signature for another epoch reverts (a kill switch happened). */
  currentStopEpoch?: bigint;
  /**
   * For Subscribe: `lastSubscriptionFor(follower, sodexAccountId, venue, leader)`. A signature for another history of
   * the key reverts (a subscription for it was created since; audit SEC-04).
   */
  currentLastId?: bigint;
  /** For update and resume: the subscription's current `version`. */
  currentVersion?: number;
  /** `paused()`: subscribe, update and resume revert while paused; stops never do. */
  paused?: boolean;
  /**
   * Relayer policy against spam paid by ValueDesk (audit: leader spam): whether `delegatedKey` is a key ValueDesk's
   * key service issued for exactly this follower and SoDEX account. Checked for Subscribe and UpdateSubscription
   * (pass `subscriptionAccount` for updates). A refused follower can still call the contract directly and pay its own
   * gas: this is relay policy, not a protocol rule.
   */
  isValuedeskKey?: (delegatedKey: Address, follower: Address, sodexAccountId: bigint | undefined) => boolean;
  /** For UpdateSubscription: the subscription's `sodexAccountId` (immutable; from the index or `getSubscription`). */
  subscriptionAccount?: bigint;
}

export interface RelayTransaction {
  to: Address;
  data: Hex;
  value: 0n;
  /** Upper bound to set on the transaction (ERC-1271 griefing cap, §6.7). */
  gasLimit: bigint;
  /** EIP-712 digest the signature must be valid for. */
  digest: Hex;
  signer: Address;
  /** 'ecdsa' if the signature recovers to the signer as the contract checks it; 'erc1271?' otherwise (simulate!). */
  path: 'ecdsa' | 'erc1271?';
  /** The signature as it will be submitted (normalised to 65 bytes, v 27/28, low s, when it is an ECDSA signature). */
  signature: Hex;
  /** Reasons not to send. Empty = go ahead with an eth_call simulation, then send. */
  problems: string[];
}

/**
 * Validate a signed action against policy and the chain facts in `ctx`, and build the transaction. Problems are
 * listed so the relayer can answer the UI precisely; it throws only for a malformed action, which `parseSignedAction`
 * already rejects. Always simulate with eth_call before sending: `ctx` may be stale.
 */
export function buildRelayTransaction(signed: SignedAction, ctx: RelayContext): RelayTransaction {
  const problems: string[] = [];
  const a = signed.action;
  const chainId = ctx.chainId ?? VALUECHAIN_CHAIN_ID;
  if (signed.chainId !== chainId) problems.push(`chainId ${signed.chainId} is not ${chainId}`);
  if (!sameAddress(signed.verifyingContract, ctx.contract)) problems.push('signed for another contract');
  const prepared = prepareAction({ verifyingContract: ctx.contract, chainId }, a);
  const margin = BigInt(ctx.minDeadlineMarginSec ?? 30);
  if (a.deadline < BigInt(ctx.now) + margin) problems.push('the signature deadline has passed or is too close');
  const signer = actionSigner(a);
  if (isIdBased(a.type) && ctx.subscriptionFollower && !sameAddress(ctx.subscriptionFollower, signer)) {
    problems.push('the signer is not the follower of this subscription');
  }
  if (a.type === 'Subscribe' && ctx.currentStopEpoch !== undefined && a.stopEpoch !== ctx.currentStopEpoch) {
    problems.push(`signed for stop epoch ${a.stopEpoch}; the follower is at ${ctx.currentStopEpoch} (re-sign)`);
  }
  if (a.type === 'Subscribe' && ctx.currentLastId !== undefined && a.expectedLastId !== ctx.currentLastId) {
    problems.push(`signed for last subscription ${a.expectedLastId} of this key; it is now ${ctx.currentLastId} (void, do not re-sign blindly)`);
  }
  if ((a.type === 'UpdateSubscription' || a.type === 'ResumeSubscription') && ctx.currentVersion !== undefined && a.expectedVersion !== ctx.currentVersion) {
    problems.push(`signed for version ${a.expectedVersion}; the subscription is at ${ctx.currentVersion} (re-sign)`);
  }
  if (ctx.paused && !worksWhilePaused(a.type)) problems.push('the contract is paused for new activity (stops still work)');
  if (ctx.isValuedeskKey && (a.type === 'Subscribe' || a.type === 'UpdateSubscription')) {
    const account = a.type === 'Subscribe' ? a.sodexAccountId : ctx.subscriptionAccount;
    if (!ctx.isValuedeskKey(a.terms.delegatedKey, signer, account)) {
      problems.push('the delegated key was not issued by ValueDesk for this follower and account (not relayed; call directly)');
    }
  }

  // The ECDSA path exactly as the contract checks it; normalise the shapes wallets produce (v 0/1, high s, EIP-2098).
  let signature = signed.signature;
  let path: RelayTransaction['path'] = 'erc1271?';
  try {
    const n = normalizeSignature(signed.signature);
    const got = ozTryRecover(prepared.digest, n);
    if (got && sameAddress(got, signer)) {
      signature = n;
      path = 'ecdsa';
    }
  } catch {
    // not an ECDSA shape: may be an ERC-1271 wallet signature
  }

  const data = withSigCalldata(a, { nonce: a.nonce, deadline: a.deadline, signature });
  return { to: ctx.contract, data, value: 0n, gasLimit: RELAYER_GAS_CAP, digest: prepared.digest, signer, path, signature, problems };
}

// ---------------------------------------------------------------------------
// Nonce choice (spec §6.5; audit SEC-03)
// ---------------------------------------------------------------------------

/**
 * The lowest nonce from `from` up that is neither used on-chain (`isUsed`: the index's `isNonceUsed`, or the view)
 * nor RESERVED by a message this UI already had signed and that may still land (its pending list). Sequential nonces
 * pack 256 per storage word; skipping the reserved ones stops two pending messages from sharing a nonce, where the
 * first to land would silently cancel the other.
 */
export function nextFreeNonce(isUsed: (nonce: bigint) => boolean, reserved: ReadonlySet<bigint> = new Set(), from = 0n): bigint {
  let n = from;
  while (isUsed(n) || reserved.has(n)) n++;
  return n;
}

/**
 * A uniformly random 256-bit nonce from the platform CSPRNG. Use it for STOPS (pause, unsubscribe, the kill switch,
 * and a pre-signed emergency UnsubscribeAll): a random nonce cannot collide with any other signed message, so no
 * earlier resume or update can consume a stop's nonce (audit SEC-03). `random` is injectable for tests.
 */
export function randomNonce(random?: (length: number) => Uint8Array): bigint {
  const bytes = random
    ? random(32)
    : (() => {
        const c = (globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
        if (!c?.getRandomValues) throw new RelayError('no CSPRNG available (globalThis.crypto.getRandomValues)');
        return c.getRandomValues(new Uint8Array(32));
      })();
  if (bytes.length !== 32) throw new RelayError('random source must return 32 bytes');
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

// ---------------------------------------------------------------------------
// Reading signed calls back (idempotency, audit logs)
// ---------------------------------------------------------------------------

interface DecodedSig {
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
}

/**
 * The signed action inside `...WithSig` calldata, and its signature. Id-based calls do not carry the follower:
 * `followerOf(subscriptionId)` supplies it (the index or `getSubscription`). Returns null for other calldata.
 */
export function actionFromCalldata(
  data: Hex,
  followerOf: (subscriptionId: bigint) => Address | undefined,
): { action: CopyTradingAction; signature: Hex } | null {
  let d: { functionName: string; args: unknown[] };
  try {
    d = decodeCall(data);
  } catch {
    return null;
  }
  const type = (Object.keys(WITH_SIG_FUNCTION) as CopyTradingPrimaryType[]).find((t) => WITH_SIG_FUNCTION[t] === d.functionName);
  if (!type) return null;
  const args = d.args;
  const sig = args[args.length - 1] as DecodedSig;
  const common = { nonce: sig.nonce, deadline: sig.deadline };
  const byId = (id: bigint): Address => {
    const f = followerOf(id);
    if (!f) throw new RelayError(`unknown follower of subscription ${id}`);
    return f;
  };
  let action: CopyTradingAction;
  switch (type) {
    case 'Subscribe': {
      const [follower, venue, leader, sodexAccountId, terms, stopEpoch, expectedLastId] = args as [Address, number, Address, bigint, Terms, bigint, bigint];
      action = { type, follower, venue, leader, sodexAccountId, terms, stopEpoch, expectedLastId, ...common };
      break;
    }
    case 'UpdateSubscription': {
      const [subscriptionId, expectedVersion, terms] = args as [bigint, number, Terms];
      action = { type, follower: byId(subscriptionId), subscriptionId, expectedVersion, terms, ...common };
      break;
    }
    case 'PauseSubscription': {
      const [subscriptionId] = args as [bigint];
      action = { type, follower: byId(subscriptionId), subscriptionId, ...common };
      break;
    }
    case 'ResumeSubscription': {
      const [subscriptionId, expectedVersion] = args as [bigint, number];
      action = { type, follower: byId(subscriptionId), subscriptionId, expectedVersion, ...common };
      break;
    }
    case 'Unsubscribe': {
      const [subscriptionId, closePositions] = args as [bigint, boolean];
      action = { type, follower: byId(subscriptionId), subscriptionId, closePositions, ...common };
      break;
    }
    case 'UnsubscribeAll': {
      const [follower, closePositions] = args as [Address, boolean];
      action = { type, follower, closePositions, ...common };
      break;
    }
    case 'InvalidateNonces': {
      const [follower, word, mask] = args as [Address, bigint, bigint];
      action = { type, follower, word, mask, ...common };
      break;
    }
  }
  return { action, signature: sig.signature };
}

/**
 * Idempotency (§6.7): after `NonceAlreadyUsed(signer, nonce)`, fetch the transaction that emitted
 * `NonceUsed(signer, nonce)` and pass its input here. True when it carried the SAME signed action (same digest):
 * treat the request as done. False: the nonce was spent on another message; the follower must re-sign.
 */
export function isSameSignedAction(
  domain: DomainInput,
  ours: CopyTradingAction,
  landedCalldata: Hex,
  followerOf: (subscriptionId: bigint) => Address | undefined,
): boolean {
  const landed = actionFromCalldata(landedCalldata, followerOf);
  if (!landed) return false;
  return prepareAction(domain, landed.action).digest === prepareAction(domain, ours).digest;
}

// ---------------------------------------------------------------------------
// Revert classification
// ---------------------------------------------------------------------------

export type RevertClass =
  /** Someone already submitted this signature: check `isSameSignedAction`; if true, treat as success. */
  | 'already-used'
  /** The signature is past its deadline: ask the user to sign again. */
  | 'expired'
  /** The signature does not match the signer (wrong account, chain or contract, altered fields) or ERC-1271 said no. */
  | 'bad-signature'
  /** The signed state is stale (version moved on, status changed, a kill switch raised the stop epoch): refresh, re-sign. */
  | 'stale'
  /** The owner paused new activity: subscribe, update and resume only. Stops always work. */
  | 'paused'
  /** The terms or target are invalid, or a chain-state rule blocks them: show the error; do not retry. */
  | 'rejected'
  /** Unknown or empty revert data (out of gas, RPC trouble). */
  | 'unknown';

export interface ClassifiedRevert {
  class: RevertClass;
  errorName?: string;
  args?: Record<string, unknown>;
}

/** Map revert data from eth_call / eth_estimateGas to what the relayer should do. */
export function classifyRevert(data: Hex | undefined | null): ClassifiedRevert {
  if (!data || data === '0x') return { class: 'unknown' };
  let d: { errorName: string; args: Record<string, unknown> };
  try {
    d = decodeRevert(data);
  } catch {
    return { class: 'unknown' };
  }
  const c = (cls: RevertClass): ClassifiedRevert => ({ class: cls, errorName: d.errorName, args: d.args });
  switch (d.errorName) {
    case 'NonceAlreadyUsed':
      return c('already-used');
    case 'SignatureExpired':
      return c('expired');
    case 'InvalidSignature':
      return c('bad-signature');
    case 'VersionMismatch':
    case 'InvalidStatus':
    case 'StopEpochMismatch':
    case 'LastSubscriptionMismatch':
      return c('stale');
    case 'EnforcedPause':
      return c('paused');
    case 'InvalidTerms':
    case 'UnknownSubscription':
    case 'DuplicateSubscription':
    case 'VenueDisabled':
    case 'NotFollower':
    case 'FundsNotAccepted':
      return c('rejected');
    default:
      return c('unknown');
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Recommended relayer limits (§6.7). Gas on ValueChain is almost free, so spam is cheap for an attacker too; what it
 * costs is index bloat and the relayer's SOSO float. Stops get their own, looser bucket so that a signer who hit the
 * subscribe limit can still stop.
 */
export const RELAY_LIMITS = {
  perSignerPerMinute: 10,
  perIpPerMinute: 30,
  stopsPerSignerPerMinute: 30,
  windowMs: 60_000,
} as const;

/**
 * Fixed-window counter per key (signer, IP, ...). Pure and clock-injected so it runs the same in a server, a worker or
 * a test. Fixed windows can let up to 2x `max` through across a window boundary; that is fine for spam control.
 */
export class FixedWindowLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('max must be a positive integer');
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new RangeError('windowMs must be a positive integer');
  }

  /** Count one request for `key` at `nowMs`; false when the key is over its limit in the current window. */
  take(key: string, nowMs: number): boolean {
    const b = this.buckets.get(key);
    if (!b || nowMs >= b.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      return true;
    }
    if (b.count >= this.max) return false;
    b.count++;
    return true;
  }

  /** Milliseconds until `key` may try again (0 if it may now). */
  retryAfterMs(key: string, nowMs: number): number {
    const b = this.buckets.get(key);
    return !b || nowMs >= b.resetAt || b.count < this.max ? 0 : b.resetAt - nowMs;
  }

  /** Drop expired buckets (call now and then to bound memory). */
  prune(nowMs: number): void {
    for (const [k, b] of this.buckets) if (nowMs >= b.resetAt) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }
}
