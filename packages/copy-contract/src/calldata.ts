/**
 * Typed calldata for every function of ValuescanCopyTrading (as exposed by the PROXY), and typed decoders for the
 * return data of every view. Built on the generic codec in abiCodec.ts and the committed ABI in abi.ts.
 *
 *   const data = calls.subscribeWithSig(follower, venue, leader, sodexAccountId, terms, stopEpoch, expectedLastId, sig);
 *   // eth_call / eth_sendRawTransaction { to: proxy, data, value: 0 }   (the app sends; this package never does)
 *
 *   const raw = await rpc('eth_call', [{ to: proxy, data: calls.getSubscription(7n) }, blockTag]);
 *   const record = results.getSubscription(raw);   // effective status (a kill switch shows as STOPPED)
 *
 * No call ever carries value: the contract has no payable function of its own, and `upgradeToAndCall` (payable by the
 * UUPS standard) reverts with FundsNotAccepted on any value.
 *
 * Checked byte for byte against viem in test/abi.test.ts, and against the contract itself: the Foundry cross-check
 * submits this package's calldata and compares return data, revert data and logs.
 */
import { valuescanCopyTradingAbi } from './abi.ts';
import {
  type Abi,
  decodeErrorResult,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  getAbiItem,
  selectorOf,
} from './abiCodec.ts';
import { type Address, type Hex, isHex, toUint } from './bytes.ts';
import { termsMessage } from './eip712.ts';
import type {
  BuilderTerms,
  Commitment,
  EffectiveBuilderFee,
  Eip712DomainInfo,
  ExecutorInfo,
  KillSwitch,
  Page,
  SignatureParams,
  Status,
  StopDetails,
  StopReason,
  Subscription,
  Terms,
  VenueInfo,
} from './types.ts';

/** The implementation ABI, typed for the generic codec. */
export const ABI = valuescanCopyTradingAbi as unknown as Abi;

const enc = (name: string, args: readonly unknown[] = []): Hex => encodeFunctionData(ABI, name, args);

/** Normalise `SignatureParams` for the ABI tuple `(uint256 nonce, uint256 deadline, bytes signature)`. */
export function sigTuple(s: SignatureParams): { nonce: bigint; deadline: bigint; signature: Hex } {
  if (!isHex(s.signature)) throw new TypeError('sig.signature must be 0x hex bytes');
  return { nonce: toUint(s.nonce, 256, 'sig.nonce'), deadline: toUint(s.deadline, 256, 'sig.deadline'), signature: s.signature };
}

/** Calldata builders, one per function: follower (direct, then signed), executors, governance, views. */
export const calls = {
  // ---- follower, direct (msg.sender = follower; needs SOSO for gas) ----
  subscribe: (venue: number, leader: Address, sodexAccountId: bigint, terms: Terms) =>
    enc('subscribe', [venue, leader, sodexAccountId, termsMessage(terms)]),
  updateSubscription: (subscriptionId: bigint, terms: Terms) => enc('updateSubscription', [subscriptionId, termsMessage(terms)]),
  pauseSubscription: (subscriptionId: bigint) => enc('pauseSubscription', [subscriptionId]),
  resumeSubscription: (subscriptionId: bigint) => enc('resumeSubscription', [subscriptionId]),
  unsubscribe: (subscriptionId: bigint, closePositions: boolean) => enc('unsubscribe', [subscriptionId, closePositions]),
  unsubscribeAll: (closePositions: boolean) => enc('unsubscribeAll', [closePositions]),
  invalidateNonces: (word: bigint, mask: bigint) => enc('invalidateNonces', [word, mask]),

  // ---- follower, signed (anyone submits; ValueDesk's relayer pays the gas) ----
  subscribeWithSig: (
    follower: Address,
    venue: number,
    leader: Address,
    sodexAccountId: bigint,
    terms: Terms,
    stopEpoch: bigint,
    expectedLastId: bigint,
    sig: SignatureParams,
  ) =>
    enc('subscribeWithSig', [follower, venue, leader, sodexAccountId, termsMessage(terms), stopEpoch, expectedLastId, sigTuple(sig)]),
  updateSubscriptionWithSig: (subscriptionId: bigint, expectedVersion: number, terms: Terms, sig: SignatureParams) =>
    enc('updateSubscriptionWithSig', [subscriptionId, expectedVersion, termsMessage(terms), sigTuple(sig)]),
  pauseSubscriptionWithSig: (subscriptionId: bigint, sig: SignatureParams) =>
    enc('pauseSubscriptionWithSig', [subscriptionId, sigTuple(sig)]),
  resumeSubscriptionWithSig: (subscriptionId: bigint, expectedVersion: number, sig: SignatureParams) =>
    enc('resumeSubscriptionWithSig', [subscriptionId, expectedVersion, sigTuple(sig)]),
  unsubscribeWithSig: (subscriptionId: bigint, closePositions: boolean, sig: SignatureParams) =>
    enc('unsubscribeWithSig', [subscriptionId, closePositions, sigTuple(sig)]),
  unsubscribeAllWithSig: (follower: Address, closePositions: boolean, sig: SignatureParams) =>
    enc('unsubscribeAllWithSig', [follower, closePositions, sigTuple(sig)]),
  invalidateNoncesWithSig: (follower: Address, word: bigint, mask: bigint, sig: SignatureParams) =>
    enc('invalidateNoncesWithSig', [follower, word, mask, sigTuple(sig)]),

  // ---- executors (msg.sender must be an authorised executor) ----
  commitExecutions: (epoch: bigint, merkleRoot: Hex, count: number, uri: string) =>
    enc('commitExecutions', [epoch, merkleRoot, count, uri]),

  // ---- governance (owner = the TimelockController; see timelock.ts to wrap these into proposals) ----
  setBuilderTerms: (builderId: bigint, perpsFee: number, spotFee: number) => enc('setBuilderTerms', [builderId, perpsFee, spotFee]),
  setVenue: (venue: number, enabled: boolean, name: string) => enc('setVenue', [venue, enabled, name]),
  setExecutor: (executor: Address, authorised: boolean) => enc('setExecutor', [executor, authorised]),
  pause: () => enc('pause'),
  unpause: () => enc('unpause'),
  transferOwnership: (newOwner: Address) => enc('transferOwnership', [newOwner]),
  acceptOwnership: () => enc('acceptOwnership'),
  /** Always reverts (RenounceDisabled for the owner). Present for completeness only. */
  renounceOwnership: () => enc('renounceOwnership'),
  /** UUPS upgrade; send with value 0 (any value reverts FundsNotAccepted). `data` = the new version's reinitializer call or 0x. */
  upgradeToAndCall: (newImplementation: Address, data: Hex = '0x') => enc('upgradeToAndCall', [newImplementation, data]),
  /** The proxy constructor's `_data` (atomic initialisation; runs once). Documentation and tests only. */
  initialize: (initialOwner: Address, builderId: bigint, perpsFee: number, spotFee: number, initialExecutors: readonly Address[]) =>
    enc('initialize', [initialOwner, builderId, perpsFee, spotFee, initialExecutors]),

  // ---- views ----
  VERSION: () => enc('VERSION'),
  UPGRADE_INTERFACE_VERSION: () => enc('UPGRADE_INTERFACE_VERSION'),
  DOMAIN_SEPARATOR: () => enc('DOMAIN_SEPARATOR'),
  eip712Domain: () => enc('eip712Domain'),
  /** Reverts through the proxy (UUPSUnauthorizedCallContext); answers only on the implementation. */
  proxiableUUID: () => enc('proxiableUUID'),
  owner: () => enc('owner'),
  pendingOwner: () => enc('pendingOwner'),
  paused: () => enc('paused'),
  getSubscription: (subscriptionId: bigint) => enc('getSubscription', [subscriptionId]),
  statusOf: (subscriptionId: bigint) => enc('statusOf', [subscriptionId]),
  stopDetails: (subscriptionId: bigint) => enc('stopDetails', [subscriptionId]),
  subscriptionCount: () => enc('subscriptionCount'),
  subscriptionsOfFollower: (follower: Address, offset: bigint, limit: bigint) =>
    enc('subscriptionsOfFollower', [follower, offset, limit]),
  liveSubscriptionsOfFollower: (follower: Address, offset: bigint, limit: bigint) =>
    enc('liveSubscriptionsOfFollower', [follower, offset, limit]),
  subscriptionsOfLeader: (venue: number, leader: Address, offset: bigint, limit: bigint) =>
    enc('subscriptionsOfLeader', [venue, leader, offset, limit]),
  liveSubscriptionFor: (follower: Address, sodexAccountId: bigint, venue: number, leader: Address) =>
    enc('liveSubscriptionFor', [follower, sodexAccountId, venue, leader]),
  lastSubscriptionFor: (follower: Address, sodexAccountId: bigint, venue: number, leader: Address) =>
    enc('lastSubscriptionFor', [follower, sodexAccountId, venue, leader]),
  isCopyable: (subscriptionId: bigint) => enc('isCopyable', [subscriptionId]),
  stopEpochOf: (follower: Address) => enc('stopEpochOf', [follower]),
  killSwitchInfo: (follower: Address, stopEpoch: bigint) => enc('killSwitchInfo', [follower, stopEpoch]),
  effectiveBuilderFee: (subscriptionId: bigint) => enc('effectiveBuilderFee', [subscriptionId]),
  builderTerms: () => enc('builderTerms'),
  isExecutor: (account: Address) => enc('isExecutor', [account]),
  executorInfo: (executor: Address) => enc('executorInfo', [executor]),
  commitment: (executor: Address, epoch: bigint) => enc('commitment', [executor, epoch]),
  venueInfo: (venue: number) => enc('venueInfo', [venue]),
  isNonceUsed: (signer: Address, nonce: bigint) => enc('isNonceUsed', [signer, nonce]),
  nonceBitmap: (signer: Address, word: bigint) => enc('nonceBitmap', [signer, word]),
} as const;

export type CallName = keyof typeof calls;

const dec = (name: string, data: Hex): unknown => decodeFunctionResult(ABI, name, data);

function page(v: unknown): Page {
  const [ids, total] = v as [bigint[], bigint];
  return { ids, total };
}

/** Typed decoders for return data (`eth_call` results, or a simulated write's return value). */
export const results = {
  VERSION: (d: Hex) => dec('VERSION', d) as string,
  UPGRADE_INTERFACE_VERSION: (d: Hex) => dec('UPGRADE_INTERFACE_VERSION', d) as string,
  DOMAIN_SEPARATOR: (d: Hex) => dec('DOMAIN_SEPARATOR', d) as Hex,
  eip712Domain: (d: Hex): Eip712DomainInfo => {
    const [fields, name, version, chainId, verifyingContract, salt, extensions] = dec('eip712Domain', d) as [
      Hex,
      string,
      string,
      bigint,
      Address,
      Hex,
      bigint[],
    ];
    return { fields, name, version, chainId, verifyingContract, salt, extensions };
  },
  proxiableUUID: (d: Hex) => dec('proxiableUUID', d) as Hex,
  owner: (d: Hex) => dec('owner', d) as Address,
  pendingOwner: (d: Hex) => dec('pendingOwner', d) as Address,
  paused: (d: Hex) => dec('paused', d) as boolean,
  /** The record with its EFFECTIVE status. Reverts UnknownSubscription for an unknown id (decode the revert). */
  getSubscription: (d: Hex) => dec('getSubscription', d) as Subscription,
  statusOf: (d: Hex) => dec('statusOf', d) as Status,
  stopDetails: (d: Hex): StopDetails => {
    const [reason, closePositions, stoppedAt] = dec('stopDetails', d) as [StopReason, boolean, number];
    return { reason, closePositions, stoppedAt };
  },
  subscriptionCount: (d: Hex) => dec('subscriptionCount', d) as bigint,
  subscriptionsOfFollower: (d: Hex) => page(dec('subscriptionsOfFollower', d)),
  liveSubscriptionsOfFollower: (d: Hex) => page(dec('liveSubscriptionsOfFollower', d)),
  subscriptionsOfLeader: (d: Hex) => page(dec('subscriptionsOfLeader', d)),
  liveSubscriptionFor: (d: Hex) => dec('liveSubscriptionFor', d) as bigint,
  lastSubscriptionFor: (d: Hex) => dec('lastSubscriptionFor', d) as bigint,
  isCopyable: (d: Hex) => dec('isCopyable', d) as boolean,
  stopEpochOf: (d: Hex) => dec('stopEpochOf', d) as bigint,
  killSwitchInfo: (d: Hex) => dec('killSwitchInfo', d) as KillSwitch,
  effectiveBuilderFee: (d: Hex): EffectiveBuilderFee => {
    const [builderId, perpsFee, spotFee] = dec('effectiveBuilderFee', d) as [bigint, number, number];
    return { builderId, perpsFee, spotFee };
  },
  builderTerms: (d: Hex) => dec('builderTerms', d) as BuilderTerms,
  isExecutor: (d: Hex) => dec('isExecutor', d) as boolean,
  executorInfo: (d: Hex) => dec('executorInfo', d) as ExecutorInfo,
  commitment: (d: Hex) => dec('commitment', d) as Commitment,
  venueInfo: (d: Hex) => dec('venueInfo', d) as VenueInfo,
  isNonceUsed: (d: Hex) => dec('isNonceUsed', d) as boolean,
  nonceBitmap: (d: Hex) => dec('nonceBitmap', d) as bigint,
  /** Return value of subscribe / subscribeWithSig (from a simulation; the Subscribed event is authoritative). */
  subscriptionId: (d: Hex) => dec('subscribeWithSig', d) as bigint,
  /** Return value of unsubscribeAll / unsubscribeAllWithSig: the follower's new stop epoch. */
  stopEpoch: (d: Hex) => dec('unsubscribeAllWithSig', d) as bigint,
} as const;

/** Decode calldata sent to the contract (relayer audit logs, explorers, upgrade proposals). */
export const decodeCall = (data: Hex): { functionName: string; args: unknown[] } => decodeFunctionData(ABI, data);

/** Decode revert data from eth_call / eth_estimateGas into the contract's (or OpenZeppelin's) custom error. */
export const decodeRevert = (data: Hex): { errorName: string; args: Record<string, unknown> } => decodeErrorResult(ABI, data);

/** 4-byte selector of a function of this contract. */
export const functionSelector = (name: CallName): Hex => selectorOf(getAbiItem(ABI, 'function', name));
