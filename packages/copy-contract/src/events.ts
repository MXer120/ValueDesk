/**
 * Typed decoding of ValuescanCopyTrading logs (the proxy's logs), for indexers, executors and relayers.
 *
 *   const logs = await rpc('eth_getLogs', [logFilter(proxy, fromBlock, toBlock)]);
 *   const events = attachBlockTimestamps(decodeCopyTradingLogs(logs, proxy), timestampOfBlock);
 *   index.applyAll(events);                                   // state.ts: the rebuild rules of spec §9
 *
 * Every state change emits an event, `Subscribed` / `SubscriptionUpdated` carry the complete record and the symbol
 * list, and the kill switch is ONE event (`KillSwitchTriggered`) whose effect is a rule, not a list: every subscription
 * of that follower with `stopEpoch < event.stopEpoch` that was ACTIVE or PAUSED is now STOPPED. Nothing else is
 * emitted per subscription, so an indexer MUST apply that rule (CopyTradingIndex does).
 *
 * Events whose rebuild needs the block time (KillSwitchTriggered, ExecutorSet, ExecutionsCommitted,
 * BuilderTermsUpdated) require `blockTimestamp`; most nodes do not put it in eth_getLogs results, so fetch the block
 * headers and use `attachBlockTimestamps`.
 */
import { ABI } from './calldata.ts';
import { decodeEventLog, eventTopicOf, getAbiItem } from './abiCodec.ts';
import { type Address, type Hex, assertAddress, bigIntToHex32, sameAddress } from './bytes.ts';
import { symbolsHash } from './eip712.ts';
import type { Subscription } from './types.ts';

/** Where a log sits in the chain. JSON-RPC hex quantities are converted by `decodeCopyTradingLog`. */
export interface LogPosition {
  blockNumber: bigint;
  logIndex: number;
  transactionHash?: Hex;
  blockHash?: Hex;
  /** Unix seconds of the block. Not in eth_getLogs results on most nodes: see `attachBlockTimestamps`. */
  blockTimestamp?: number;
  /** eth_getLogs / eth_subscribe set this on logs removed by a reorg. */
  removed?: boolean;
}

/** A log as JSON-RPC returns it. */
export interface RpcLog {
  address: string;
  topics: readonly Hex[];
  data: Hex;
  blockNumber?: Hex | bigint | number | null;
  logIndex?: Hex | number | null;
  transactionHash?: Hex | null;
  blockHash?: Hex | null;
  blockTimestamp?: Hex | number | null;
  removed?: boolean;
}

type E<N extends string, A> = { eventName: N; args: A };

/** Every event the proxy can emit, with typed args (OpenZeppelin's included). */
export type CopyTradingEventData =
  | E<'Subscribed', { subscriptionId: bigint; follower: Address; leader: Address; subscription: Subscription; symbols: string[] }>
  | E<'SubscriptionUpdated', { subscriptionId: bigint; follower: Address; subscription: Subscription; symbols: string[] }>
  | E<'SubscriptionPaused', { subscriptionId: bigint; follower: Address; version: number; updatedAt: number }>
  | E<'SubscriptionResumed', { subscriptionId: bigint; follower: Address; version: number; updatedAt: number }>
  | E<
      'SubscriptionStopped',
      { subscriptionId: bigint; follower: Address; closePositions: boolean; version: number; updatedAt: number }
    >
  | E<'KillSwitchTriggered', { follower: Address; stopEpoch: bigint; closePositions: boolean }>
  | E<'NonceUsed', { signer: Address; nonce: bigint }>
  | E<'NoncesInvalidated', { signer: Address; word: bigint; mask: bigint }>
  | E<'ExecutorSet', { executor: Address; authorised: boolean }>
  | E<'ExecutionsCommitted', { executor: Address; epoch: bigint; merkleRoot: Hex; count: number; uri: string }>
  | E<'BuilderTermsUpdated', { builderId: bigint; perpsFee: number; spotFee: number }>
  | E<'VenueUpdated', { venue: number; enabled: boolean; name: string }>
  | E<'Paused', { account: Address }>
  | E<'Unpaused', { account: Address }>
  | E<'OwnershipTransferStarted', { previousOwner: Address; newOwner: Address }>
  | E<'OwnershipTransferred', { previousOwner: Address; newOwner: Address }>
  | E<'Upgraded', { implementation: Address }>
  | E<'Initialized', { version: bigint }>
  | E<'EIP712DomainChanged', Record<string, never>>;

export type CopyTradingEventName = CopyTradingEventData['eventName'];

/** A decoded log with its position and emitter. */
export type CopyTradingEvent = CopyTradingEventData & LogPosition & { address: Address };

export const EVENT_NAMES: readonly CopyTradingEventName[] = [
  'Subscribed',
  'SubscriptionUpdated',
  'SubscriptionPaused',
  'SubscriptionResumed',
  'SubscriptionStopped',
  'KillSwitchTriggered',
  'NonceUsed',
  'NoncesInvalidated',
  'ExecutorSet',
  'ExecutionsCommitted',
  'BuilderTermsUpdated',
  'VenueUpdated',
  'Paused',
  'Unpaused',
  'OwnershipTransferStarted',
  'OwnershipTransferred',
  'Upgraded',
  'Initialized',
  'EIP712DomainChanged',
];

/** Events that change a subscription, directly or (KillSwitchTriggered) by the stop-epoch rule. */
export const SUBSCRIPTION_EVENTS: readonly CopyTradingEventName[] = [
  'Subscribed',
  'SubscriptionUpdated',
  'SubscriptionPaused',
  'SubscriptionResumed',
  'SubscriptionStopped',
  'KillSwitchTriggered',
];

/**
 * Events an executor must act on within the stop SLA (spec §8.3), at 0 confirmations: a reorg that removes them only
 * made the executor more conservative. (A SubscriptionUpdated that changes the key or tightens a bound counts too.)
 */
export const STOP_EVENTS: readonly CopyTradingEventName[] = ['SubscriptionStopped', 'SubscriptionPaused', 'KillSwitchTriggered'];

/** topic0 of every event, by name. */
export const EVENT_TOPICS: Readonly<Record<CopyTradingEventName, Hex>> = Object.freeze(
  Object.fromEntries(EVENT_NAMES.map((n) => [n, eventTopicOf(getAbiItem(ABI, 'event', n))])) as Record<CopyTradingEventName, Hex>,
);

const TOPIC_TO_NAME = new Map<string, CopyTradingEventName>(EVENT_NAMES.map((n) => [EVENT_TOPICS[n].toLowerCase(), n]));

/** Events whose rebuild rule uses the block timestamp (spec §9). */
const NEEDS_BLOCK_TIME: ReadonlySet<CopyTradingEventName> = new Set([
  'KillSwitchTriggered',
  'ExecutorSet',
  'ExecutionsCommitted',
  'BuilderTermsUpdated',
]);
export const needsBlockTimestamp = (name: CopyTradingEventName): boolean => NEEDS_BLOCK_TIME.has(name);

const toBig = (v: Hex | bigint | number | null | undefined): bigint | undefined =>
  v === null || v === undefined ? undefined : BigInt(v);
const toNum = (v: Hex | number | null | undefined): number | undefined =>
  v === null || v === undefined ? undefined : Number(BigInt(v));

/** Decode only the event data (no position). Throws for unknown topics and malformed data. */
export function decodeCopyTradingEventData(log: { topics: readonly Hex[]; data: Hex }): CopyTradingEventData {
  return decodeEventLog(ABI, log) as CopyTradingEventData;
}

/** Whether `log` is an event of this contract (by topic0). */
export const isCopyTradingLog = (log: { topics: readonly Hex[] }): boolean =>
  !!log.topics[0] && TOPIC_TO_NAME.has(log.topics[0].toLowerCase());

/**
 * Decode one RPC log. Returns null for a log whose topic0 is not an event of this contract, or whose address differs
 * from `expectedAddress` when given. Throws if a known event's data is malformed: never skip those silently.
 */
export function decodeCopyTradingLog(log: RpcLog, expectedAddress?: Address): CopyTradingEvent | null {
  if (expectedAddress && !sameAddress(log.address, expectedAddress)) return null;
  if (!isCopyTradingLog(log)) return null;
  const data = decodeCopyTradingEventData(log);
  const blockNumber = toBig(log.blockNumber);
  const logIndex = toNum(log.logIndex);
  if (blockNumber === undefined || logIndex === undefined) throw new Error('log is missing blockNumber/logIndex (pending log?)');
  const pos: LogPosition = { blockNumber, logIndex };
  if (log.transactionHash) pos.transactionHash = log.transactionHash;
  if (log.blockHash) pos.blockHash = log.blockHash;
  const ts = toNum(log.blockTimestamp);
  if (ts !== undefined) pos.blockTimestamp = ts;
  if (log.removed) pos.removed = true;
  return { ...data, ...pos, address: assertAddress(log.address, 'log.address') };
}

/** Decode many logs, dropping foreign ones, sorted by (blockNumber, logIndex). */
export function decodeCopyTradingLogs(logs: readonly RpcLog[], expectedAddress?: Address): CopyTradingEvent[] {
  const out: CopyTradingEvent[] = [];
  for (const l of logs) {
    const e = decodeCopyTradingLog(l, expectedAddress);
    if (e) out.push(e);
  }
  return out.sort(compareLogPosition);
}

/** Order of two logs in the chain. */
export const compareLogPosition = (a: LogPosition, b: LogPosition): number =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1;

/**
 * Attach block timestamps (unix seconds) from headers the caller fetched (`eth_getBlockByNumber(n, false).timestamp`).
 * Returns new objects; events that already carry a timestamp keep it.
 */
export function attachBlockTimestamps<T extends LogPosition>(
  events: readonly T[],
  timestampOf: ReadonlyMap<bigint, number> | ((blockNumber: bigint) => number | undefined),
): T[] {
  const get = typeof timestampOf === 'function' ? timestampOf : (b: bigint) => timestampOf.get(b);
  return events.map((e) => {
    if (e.blockTimestamp !== undefined) return e;
    const ts = get(e.blockNumber);
    return ts === undefined ? e : { ...e, blockTimestamp: ts };
  });
}

/** The block numbers whose timestamps `attachBlockTimestamps` still needs (only for events that use them). */
export const blocksNeedingTimestamps = (events: readonly CopyTradingEvent[]): bigint[] =>
  [...new Set(events.filter((e) => e.blockTimestamp === undefined && needsBlockTimestamp(e.eventName)).map((e) => e.blockNumber))].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );

/**
 * For Subscribed and SubscriptionUpdated: whether the emitted symbol list hashes to the record's `symbolsHash`
 * (spec §4.4: the executor filters with the list from the latest such event, whose hash MUST equal symbolsHash).
 */
export function symbolsMatchCommitment(ev: CopyTradingEventData): boolean {
  if (ev.eventName !== 'Subscribed' && ev.eventName !== 'SubscriptionUpdated') return true;
  return symbolsHash(ev.args.symbols) === ev.args.subscription.symbolsHash.toLowerCase();
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const hexQty = (n: bigint | number): Hex => `0x${BigInt(n).toString(16)}` as Hex;

export interface LogFilter {
  address: Address;
  fromBlock: Hex;
  toBlock: Hex | 'latest' | 'safe' | 'finalized';
  topics?: Array<Hex | Hex[] | null>;
}

/**
 * `eth_getLogs` parameters for the contract's events in [fromBlock, toBlock] (all events, or only `events`). Keep ranges
 * to a few thousand blocks and page forward; public RPCs cap the range and the result size.
 */
export function logFilter(
  address: Address,
  fromBlock: bigint | number,
  toBlock: bigint | number | 'latest' | 'safe' | 'finalized',
  events?: readonly CopyTradingEventName[],
): LogFilter {
  const f: LogFilter = {
    address,
    fromBlock: hexQty(fromBlock),
    toBlock: typeof toBlock === 'string' ? toBlock : hexQty(toBlock),
  };
  if (events && events.length) f.topics = [events.map((e) => EVENT_TOPICS[e])];
  return f;
}

/** A 32-byte topic for an indexed address. */
export const addressTopic = (a: Address): Hex => `0x${'0'.repeat(24)}${assertAddress(a).slice(2).toLowerCase()}` as Hex;
/** A 32-byte topic for an indexed uint (subscription id, stop epoch, commitment epoch, nonce, venue). */
export const uintTopic = (v: bigint | number): Hex => bigIntToHex32(BigInt(v));

/**
 * The filters that fetch everything about one follower (for a UI or a per-follower audit): the follower is topic2 of
 * the subscription events and topic1 of KillSwitchTriggered, NonceUsed and NoncesInvalidated.
 */
export function followerLogFilters(address: Address, follower: Address, fromBlock: bigint | number, toBlock: bigint | number | 'latest'): LogFilter[] {
  const f = addressTopic(follower);
  const subscriptionEvents: CopyTradingEventName[] = [
    'Subscribed',
    'SubscriptionUpdated',
    'SubscriptionPaused',
    'SubscriptionResumed',
    'SubscriptionStopped',
  ];
  const signerEvents: CopyTradingEventName[] = ['KillSwitchTriggered', 'NonceUsed', 'NoncesInvalidated'];
  const a = logFilter(address, fromBlock, toBlock);
  const b = logFilter(address, fromBlock, toBlock);
  a.topics = [subscriptionEvents.map((e) => EVENT_TOPICS[e]), null, f];
  b.topics = [signerEvents.map((e) => EVENT_TOPICS[e]), f];
  return [a, b];
}

/** The events of this contract in a transaction receipt's logs (e.g. the relayer reading back `Subscribed`). */
export function eventsFromReceipt(receipt: { logs: readonly RpcLog[] }, address: Address): CopyTradingEvent[] {
  return decodeCopyTradingLogs(receipt.logs, address);
}

/** The new subscription id from a receipt of subscribe / subscribeWithSig (undefined if it has no Subscribed log). */
export function subscriptionIdFromReceipt(receipt: { logs: readonly RpcLog[] }, address: Address): bigint | undefined {
  const ev = eventsFromReceipt(receipt, address).find((e) => e.eventName === 'Subscribed');
  return ev && ev.eventName === 'Subscribed' ? ev.args.subscriptionId : undefined;
}
