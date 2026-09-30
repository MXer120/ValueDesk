/**
 * An event-sourced, in-memory model of ValuescanCopyTrading: the executor's subscription cache and the UI's read
 * model. It applies the rebuild rules of COPY-TRADING.md §9 and answers every view exactly as the contract does
 * (the Foundry-verified vectors prove it: test/vectors.test.ts), without touching the chain:
 *
 *   getSubscription / statusOf       the EFFECTIVE status: a kill switch makes every older live subscription STOPPED
 *   stopDetails                      FOLLOWER (unsubscribe) or KILL_SWITCH (the first kill switch after creation)
 *   liveSubscriptionsOfFollower      the contract's own page order (an EnumerableSet with swap-and-pop removal)
 *   liveSubscriptionFor, isCopyable, effectiveBuilderFee, nonces, executors, commitments, venues, builder terms, ...
 *
 * plus what an executor asks on every leader fill: `subscriptionsForLeader(venue, leader)`, `killedBy(follower, epoch)`,
 * `isDelegatedKey(signer)` (cycle protection) and `armedAt` (drawdown / take-profit counters).
 *
 * The contract is not in the per-trade hot path (a ValueChain block takes ~2 s; a copy ~0.1 s): follow the logs, apply
 * them here in (blockNumber, logIndex) order, reconcile with the views every hour. For reorgs, use `ChainView` below.
 */
import { type Address, type Hex, ZERO_ADDRESS, lowerAddress, sameAddress } from './bytes.ts';
import { ACTIVATION_CONFIRMATIONS } from './constants.ts';
import { symbolsHash } from './eip712.ts';
import { type CopyTradingEvent, compareLogPosition, needsBlockTimestamp } from './events.ts';
import {
  type BuilderTerms,
  type Commitment,
  type EffectiveBuilderFee,
  type ExecutorInfo,
  type KillSwitch,
  type Page,
  Status,
  type StopDetails,
  StopReason,
  type Subscription,
  type VenueInfo,
} from './types.ts';
import { isExpired } from './validate.ts';

export class IndexConsistencyError extends Error {
  override name = 'IndexConsistencyError';
}
export class IndexOrderError extends Error {
  override name = 'IndexOrderError';
}
export class IndexInputError extends Error {
  override name = 'IndexInputError';
}

export interface IndexedSubscription {
  id: bigint;
  /**
   * The STORED record, as the events describe it. A kill switch does not change it (no per-subscription event): use
   * `index.getSubscription(id)` or `index.statusOf(id)` for the effective status.
   */
  record: Subscription;
  /** The symbol list from the latest Subscribed / SubscriptionUpdated (its hash equals `record.symbolsHash`). */
  symbols: string[];
  /**
   * When the drawdown and take-profit counters were last (re)armed (§4.6): the latest of Subscribed,
   * SubscriptionResumed, and SubscriptionUpdated while ACTIVE. Unix seconds.
   */
  armedAt: number;
}

export interface CommitmentEntry extends Commitment {
  uri: string;
  transactionHash?: Hex;
}

export interface UpgradeEntry {
  implementation: Address;
  blockNumber: bigint;
  logIndex: number;
  blockTimestamp?: number;
}

/** OpenZeppelin EnumerableSet.UintSet, value for value: append on add, swap-and-pop on remove. */
class OrderedIdSet {
  readonly values: bigint[] = [];
  private readonly pos = new Map<bigint, number>();

  has(v: bigint): boolean {
    return this.pos.has(v);
  }
  add(v: bigint): void {
    if (this.pos.has(v)) return;
    this.values.push(v);
    this.pos.set(v, this.values.length - 1);
  }
  remove(v: bigint): void {
    const i = this.pos.get(v);
    if (i === undefined) return;
    const last = this.values.length - 1;
    if (i !== last) {
      const moved = this.values[last]!;
      this.values[i] = moved;
      this.pos.set(moved, i);
    }
    this.values.pop();
    this.pos.delete(v);
  }
  clone(): OrderedIdSet {
    const c = new OrderedIdSet();
    for (const v of this.values) c.add(v);
    return c;
  }
}

const k = (a: string): string => lowerAddress(a);
const leaderKey = (venue: number, leader: string): string => `${venue}:${k(leader)}`;
const liveKey = (follower: string, account: bigint, venue: number, leader: string): string =>
  `${k(follower)}:${account}:${venue}:${k(leader)}`;
const isLive = (s: Status): boolean => s === Status.ACTIVE || s === Status.PAUSED;
const cmpBig = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

/** `_pageLength` of the contract: min(limit, total - offset), or 0 if offset >= total. */
function pageOf(list: readonly bigint[], offset: bigint, limit: bigint): Page {
  const total = BigInt(list.length);
  if (offset < 0n || limit < 0n) throw new RangeError('offset and limit are uint256');
  if (offset >= total) return { ids: [], total };
  const remaining = total - offset;
  const n = limit < remaining ? limit : remaining;
  return { ids: list.slice(Number(offset), Number(offset + n)), total };
}

export class CopyTradingIndex {
  readonly subscriptions = new Map<bigint, IndexedSubscription>();
  readonly venues = new Map<number, VenueInfo>();
  readonly executors = new Map<string, ExecutorInfo & { address: Address }>();
  readonly commitments = new Map<string, CommitmentEntry>();
  /** Nonce bitmaps per signer (lower-case) and word, from NonceUsed / NoncesInvalidated. */
  readonly nonceWords = new Map<string, Map<bigint, bigint>>();
  readonly upgrades: UpgradeEntry[] = [];
  builderTerms: BuilderTerms | null = null;
  paused = false;
  owner: Address = ZERO_ADDRESS;
  pendingOwner: Address = ZERO_ADDRESS;
  implementation: Address = ZERO_ADDRESS;
  initializedVersion = 0n;
  /** Set when an upgrade bumped the EIP-712 domain: re-read eip712Domain() and ask followers to re-sign (§10.4). */
  domainChanged: { blockNumber: bigint; logIndex: number } | null = null;
  /** Highest subscription id seen (`subscriptionCount()`). */
  subscriptionCount = 0n;
  /** Position of the last applied log. */
  cursor: { blockNumber: bigint; logIndex: number } | null = null;

  private readonly followerIds = new Map<string, bigint[]>();
  private readonly leaderIds = new Map<string, bigint[]>();
  private readonly liveSets = new Map<string, OrderedIdSet>(); // `${follower}:${epoch}`
  private readonly liveByKey = new Map<string, bigint>();
  private readonly stopEpochs = new Map<string, bigint>();
  private readonly killSwitches = new Map<string, KillSwitch>(); // `${follower}:${epoch}`
  private readonly killed = new Map<string, bigint[]>(); // `${follower}:${epoch}` -> ids that kill switch stopped
  private readonly leaderLive = new Map<string, Set<bigint>>(); // `${venue}:${leader}` -> ids live in the stored sense
  private readonly delegatedKeys = new Map<string, Set<bigint>>(); // delegated key -> every id that ever used it

  /** @param address the proxy whose logs this index accepts. */
  constructor(readonly address: Address) {}

  // -------------------------------------------------------------------------
  // Applying events
  // -------------------------------------------------------------------------

  applyAll(events: readonly CopyTradingEvent[]): void {
    for (const e of events) this.apply(e);
  }

  /** Apply one decoded log. Logs must come in chain order, once each, from `address`, and not be `removed`. */
  apply(ev: CopyTradingEvent): void {
    if (!sameAddress(ev.address, this.address)) throw new IndexOrderError(`log from ${ev.address}, index is for ${this.address}`);
    if (ev.removed) throw new IndexOrderError('removed (reorged) log: roll back (ChainView) and re-apply');
    const c = this.cursor;
    if (c && compareLogPosition(ev, c) <= 0) {
      throw new IndexOrderError(`log ${ev.blockNumber}:${ev.logIndex} is not after the cursor ${c.blockNumber}:${c.logIndex}`);
    }
    if (needsBlockTimestamp(ev.eventName) && ev.blockTimestamp === undefined) {
      throw new IndexInputError(`${ev.eventName} at block ${ev.blockNumber} needs blockTimestamp (see attachBlockTimestamps)`);
    }
    this.reduce(ev);
    this.cursor = { blockNumber: ev.blockNumber, logIndex: ev.logIndex };
  }

  private reduce(ev: CopyTradingEvent): void {
    switch (ev.eventName) {
      case 'Subscribed': {
        const { subscriptionId: id, follower, leader, subscription: r, symbols } = ev.args;
        if (id !== this.subscriptionCount + 1n) throw new IndexConsistencyError(`Subscribed ${id} is not id ${this.subscriptionCount + 1n}`);
        if (r.status !== Status.ACTIVE || r.version !== 1) throw new IndexConsistencyError(`Subscribed ${id} is not ACTIVE v1`);
        if (!sameAddress(r.follower, follower) || !sameAddress(r.leader, leader)) {
          throw new IndexConsistencyError(`Subscribed ${id}: topics disagree with the record`);
        }
        if (r.stopEpoch !== this.stopEpochOf(r.follower)) {
          throw new IndexConsistencyError(`Subscribed ${id}: stopEpoch ${r.stopEpoch} is not the follower's ${this.stopEpochOf(r.follower)}`);
        }
        this.checkSymbols(id, r, symbols);
        this.subscriptionCount = id;
        this.subscriptions.set(id, { id, record: { ...r }, symbols: [...symbols], armedAt: r.updatedAt });
        push(this.followerIds, k(r.follower), id);
        push(this.leaderIds, leaderKey(r.venue, r.leader), id);
        this.liveSet(r.follower, r.stopEpoch).add(id);
        this.liveByKey.set(liveKey(r.follower, r.sodexAccountId, r.venue, r.leader), id);
        addTo(this.leaderLive, leaderKey(r.venue, r.leader), id);
        addTo(this.delegatedKeys, k(r.delegatedKey), id);
        return;
      }
      case 'SubscriptionUpdated': {
        const { subscriptionId: id, subscription: r, symbols } = ev.args;
        const s = this.mustBeLive(id, 'SubscriptionUpdated');
        const o = s.record;
        if (r.version !== o.version + 1) throw new IndexConsistencyError(`SubscriptionUpdated ${id}: version ${r.version} after ${o.version}`);
        if (
          r.status !== o.status ||
          !sameAddress(r.follower, o.follower) ||
          !sameAddress(r.leader, o.leader) ||
          r.venue !== o.venue ||
          r.sodexAccountId !== o.sodexAccountId ||
          r.createdAt !== o.createdAt ||
          r.stopEpoch !== o.stopEpoch
        ) {
          throw new IndexConsistencyError(`SubscriptionUpdated ${id} changed an immutable field or the status`);
        }
        this.checkSymbols(id, r, symbols);
        s.record = { ...r };
        s.symbols = [...symbols];
        if (r.status === Status.ACTIVE) s.armedAt = r.updatedAt;
        addTo(this.delegatedKeys, k(r.delegatedKey), id);
        return;
      }
      case 'SubscriptionPaused':
      case 'SubscriptionResumed': {
        const { subscriptionId: id, version, updatedAt } = ev.args;
        const pausing = ev.eventName === 'SubscriptionPaused';
        const s = this.mustBeLive(id, ev.eventName);
        if (s.record.status !== (pausing ? Status.ACTIVE : Status.PAUSED)) {
          throw new IndexConsistencyError(`${ev.eventName} ${id} from status ${s.record.status}`);
        }
        this.checkVersion(s, version, ev.eventName);
        s.record = { ...s.record, status: pausing ? Status.PAUSED : Status.ACTIVE, version, updatedAt };
        if (!pausing) s.armedAt = updatedAt;
        return;
      }
      case 'SubscriptionStopped': {
        const { subscriptionId: id, closePositions, version, updatedAt } = ev.args;
        const s = this.mustBeLive(id, 'SubscriptionStopped');
        this.checkVersion(s, version, 'SubscriptionStopped');
        const r = s.record;
        this.liveSet(r.follower, r.stopEpoch).remove(id);
        // The key keeps pointing at this id (the contract never clears liveByKey; audit SEC-04).
        removeFrom(this.leaderLive, leaderKey(r.venue, r.leader), id);
        s.record = { ...r, status: Status.STOPPED, closePositions, version, updatedAt };
        return;
      }
      case 'KillSwitchTriggered': {
        const { follower, stopEpoch, closePositions } = ev.args;
        const prev = this.stopEpochOf(follower);
        if (stopEpoch !== prev + 1n) throw new IndexConsistencyError(`KillSwitchTriggered ${follower}: epoch ${stopEpoch} after ${prev}`);
        // Everything live in the previous epoch is now STOPPED (the stop-epoch rule); the new epoch starts empty.
        const stopped = [...this.liveSet(follower, prev).values];
        for (const id of stopped) {
          const r = this.subscriptions.get(id)!.record;
          removeFrom(this.leaderLive, leaderKey(r.venue, r.leader), id);
        }
        this.liveSets.delete(`${k(follower)}:${prev}`);
        this.stopEpochs.set(k(follower), stopEpoch);
        this.killSwitches.set(`${k(follower)}:${stopEpoch}`, { triggeredAt: ev.blockTimestamp!, closePositions });
        this.killed.set(`${k(follower)}:${stopEpoch}`, stopped);
        return;
      }
      case 'NonceUsed': {
        const { signer, nonce } = ev.args;
        this.setNonceBits(signer, nonce >> 8n, 1n << (nonce & 0xffn));
        return;
      }
      case 'NoncesInvalidated':
        this.setNonceBits(ev.args.signer, ev.args.word, ev.args.mask);
        return;
      case 'ExecutorSet': {
        const x = this.executors.get(k(ev.args.executor)) ?? { address: ev.args.executor, authorised: false, updatedAt: 0, lastEpoch: 0n };
        this.executors.set(k(ev.args.executor), { ...x, authorised: ev.args.authorised, updatedAt: ev.blockTimestamp! });
        return;
      }
      case 'ExecutionsCommitted': {
        const a = ev.args;
        const x = this.executors.get(k(a.executor));
        if (!x?.authorised) throw new IndexConsistencyError(`ExecutionsCommitted by ${a.executor}, which is not an authorised executor`);
        if (a.epoch <= x.lastEpoch) throw new IndexConsistencyError(`ExecutionsCommitted: epoch ${a.epoch} not after ${x.lastEpoch}`);
        this.executors.set(k(a.executor), { ...x, lastEpoch: a.epoch });
        const entry: CommitmentEntry = { merkleRoot: a.merkleRoot, count: a.count, committedAt: ev.blockTimestamp!, uri: a.uri };
        if (ev.transactionHash) entry.transactionHash = ev.transactionHash;
        this.commitments.set(`${k(a.executor)}:${a.epoch}`, entry);
        return;
      }
      case 'BuilderTermsUpdated':
        this.builderTerms = { ...ev.args, updatedAt: ev.blockTimestamp! };
        return;
      case 'VenueUpdated':
        this.venues.set(ev.args.venue, { enabled: ev.args.enabled, name: ev.args.name });
        return;
      case 'Paused':
        this.paused = true;
        return;
      case 'Unpaused':
        this.paused = false;
        return;
      case 'OwnershipTransferStarted':
        this.pendingOwner = ev.args.newOwner;
        return;
      case 'OwnershipTransferred':
        this.owner = ev.args.newOwner;
        this.pendingOwner = ZERO_ADDRESS;
        return;
      case 'Upgraded': {
        this.implementation = ev.args.implementation;
        const u: UpgradeEntry = { implementation: ev.args.implementation, blockNumber: ev.blockNumber, logIndex: ev.logIndex };
        if (ev.blockTimestamp !== undefined) u.blockTimestamp = ev.blockTimestamp;
        this.upgrades.push(u);
        return;
      }
      case 'Initialized':
        this.initializedVersion = ev.args.version;
        return;
      case 'EIP712DomainChanged':
        this.domainChanged = { blockNumber: ev.blockNumber, logIndex: ev.logIndex };
        return;
      default: {
        const never: never = ev;
        throw new IndexConsistencyError(`unhandled event ${(never as { eventName: string }).eventName}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // The contract's views
  // -------------------------------------------------------------------------

  /** `statusOf(id)`: the effective status; NONE for an unknown id. */
  statusOf(id: bigint): Status {
    const s = this.subscriptions.get(id);
    if (!s) return Status.NONE;
    const r = s.record;
    return isLive(r.status) && r.stopEpoch < this.stopEpochOf(r.follower) ? Status.STOPPED : r.status;
  }

  /** `getSubscription(id)`: the record with its effective status; undefined for an unknown id (the view reverts). */
  getSubscription(id: bigint): Subscription | undefined {
    const s = this.subscriptions.get(id);
    return s ? { ...s.record, status: this.statusOf(id) } : undefined;
  }

  /** The indexed entry (stored record, symbol list, armedAt). */
  get(id: bigint): IndexedSubscription | undefined {
    return this.subscriptions.get(id);
  }

  /** `stopDetails(id)`; undefined where the view reverts (unknown id, or not STOPPED). */
  stopDetails(id: bigint): StopDetails | undefined {
    const s = this.subscriptions.get(id);
    if (!s) return undefined;
    const r = s.record;
    if (r.status === Status.STOPPED) return { reason: StopReason.FOLLOWER, closePositions: r.closePositions, stoppedAt: r.updatedAt };
    if (!(isLive(r.status) && r.stopEpoch < this.stopEpochOf(r.follower))) return undefined;
    const ks = this.killSwitchInfo(r.follower, r.stopEpoch + 1n); // the first kill switch after creation
    return { reason: StopReason.KILL_SWITCH, closePositions: ks.closePositions, stoppedAt: ks.triggeredAt };
  }

  /** `subscriptionsOfFollower(follower, offset, limit)`: every id ever created, oldest first. */
  subscriptionsOfFollower(follower: Address, offset = 0n, limit = 2n ** 256n - 1n): Page {
    return pageOf(this.followerIds.get(k(follower)) ?? [], offset, limit);
  }

  /** `liveSubscriptionsOfFollower(follower, offset, limit)`: the current epoch's live set, in the contract's order. */
  liveSubscriptionsOfFollower(follower: Address, offset = 0n, limit = 2n ** 256n - 1n): Page {
    const set = this.liveSets.get(`${k(follower)}:${this.stopEpochOf(follower)}`);
    return pageOf(set ? set.values : [], offset, limit);
  }

  /** `subscriptionsOfLeader(venue, leader, offset, limit)`: every id ever created to it, oldest first. */
  subscriptionsOfLeader(venue: number, leader: Address, offset = 0n, limit = 2n ** 256n - 1n): Page {
    return pageOf(this.leaderIds.get(leaderKey(venue, leader)) ?? [], offset, limit);
  }

  /** `liveSubscriptionFor(follower, account, venue, leader)`: the live id or 0n (the uniqueness guard's key). */
  liveSubscriptionFor(follower: Address, sodexAccountId: bigint, venue: number, leader: Address): bigint {
    const id = this.liveByKey.get(liveKey(follower, sodexAccountId, venue, leader)) ?? 0n;
    return id !== 0n && isLive(this.statusOf(id)) ? id : 0n;
  }

  /**
   * `lastSubscriptionFor(follower, account, venue, leader)`: the last id ever created for the key, live or not, or
   * 0n. A signed Subscribe must carry it as `expectedLastId`.
   */
  lastSubscriptionFor(follower: Address, sodexAccountId: bigint, venue: number, leader: Address): bigint {
    return this.liveByKey.get(liveKey(follower, sodexAccountId, venue, leader)) ?? 0n;
  }

  /** `isCopyable(id)` at unix time `now`: effective status ACTIVE and not expired. */
  isCopyable(id: bigint, now: number): boolean {
    const s = this.subscriptions.get(id);
    return !!s && this.statusOf(id) === Status.ACTIVE && !isExpired(s.record.expiry, now);
  }

  /** `stopEpochOf(follower)`: 0 until its first kill switch. */
  stopEpochOf(follower: Address): bigint {
    return this.stopEpochs.get(k(follower)) ?? 0n;
  }

  /** `killSwitchInfo(follower, epoch)` (all-zero if that epoch was never reached). */
  killSwitchInfo(follower: Address, stopEpoch: bigint): KillSwitch {
    return this.killSwitches.get(`${k(follower)}:${stopEpoch}`) ?? { triggeredAt: 0, closePositions: false };
  }

  /** `effectiveBuilderFee(id)`: min(current fee, the follower's consent) per engine; undefined for an unknown id. */
  effectiveBuilderFee(id: bigint): EffectiveBuilderFee | undefined {
    const s = this.subscriptions.get(id);
    if (!s) return undefined;
    const b = this.builderTerms ?? { builderId: 0n, perpsFee: 0, spotFee: 0, updatedAt: 0 };
    return {
      builderId: b.builderId,
      perpsFee: Math.min(b.perpsFee, s.record.maxBuilderFeePerps),
      spotFee: Math.min(b.spotFee, s.record.maxBuilderFeeSpot),
    };
  }

  isExecutor(account: Address): boolean {
    return this.executors.get(k(account))?.authorised ?? false;
  }

  /** `executorInfo(executor)` (all-zero if never set). */
  executorInfo(executor: Address): ExecutorInfo {
    const x = this.executors.get(k(executor));
    return x ? { authorised: x.authorised, updatedAt: x.updatedAt, lastEpoch: x.lastEpoch } : { authorised: false, updatedAt: 0, lastEpoch: 0n };
  }

  /** `commitment(executor, epoch)` (all-zero if none). */
  commitment(executor: Address, epoch: bigint): Commitment {
    const c = this.commitments.get(`${k(executor)}:${epoch}`);
    return c ? { merkleRoot: c.merkleRoot, count: c.count, committedAt: c.committedAt } : { merkleRoot: `0x${'00'.repeat(32)}`, count: 0, committedAt: 0 };
  }

  /** `venueInfo(venue)` (all-zero if never set). */
  venueInfo(venue: number): VenueInfo {
    return this.venues.get(venue) ?? { enabled: false, name: '' };
  }

  /** `isNonceUsed(signer, nonce)`. */
  isNonceUsed(signer: Address, nonce: bigint): boolean {
    return (this.nonceBitmap(signer, nonce >> 8n) & (1n << (nonce & 0xffn))) !== 0n;
  }

  /** `nonceBitmap(signer, word)`. */
  nonceBitmap(signer: Address, word: bigint): bigint {
    return this.nonceWords.get(k(signer))?.get(word) ?? 0n;
  }

  /** The lowest unused nonce of `signer` from `from` upwards (what a UI signs next; 256 fit one storage word). */
  nextNonce(signer: Address, from = 0n): bigint {
    let n = from;
    while (this.isNonceUsed(signer, n)) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // Executor queries
  // -------------------------------------------------------------------------

  /**
   * Live (effective ACTIVE or PAUSED) subscriptions copying (venue, leader), ascending: the fan-out of one leader
   * event. Decide per subscription with `copyMode` (executor.ts): ACTIVE and unexpired may open; the rest reduce only.
   */
  subscriptionsForLeader(venue: number, leader: Address): IndexedSubscription[] {
    const ids = [...(this.leaderLive.get(leaderKey(venue, leader)) ?? [])].filter((id) => isLive(this.statusOf(id))).sort(cmpBig);
    return ids.map((id) => this.subscriptions.get(id)!);
  }

  /** Every (venue, leader) with at least one live subscription: what the executor's venue feeds must watch. */
  watchedLeaders(): Array<{ venue: number; leader: Address; subscriptionIds: bigint[] }> {
    const out: Array<{ venue: number; leader: Address; subscriptionIds: bigint[] }> = [];
    for (const ids of this.leaderLive.values()) {
      const live = [...ids].filter((id) => isLive(this.statusOf(id))).sort(cmpBig);
      if (!live.length) continue;
      const r = this.subscriptions.get(live[0]!)!.record;
      out.push({ venue: r.venue, leader: r.leader, subscriptionIds: live });
    }
    return out.sort((a, b) => a.venue - b.venue || (k(a.leader) < k(b.leader) ? -1 : 1));
  }

  /** The ids a kill switch stopped (those live when `KillSwitchTriggered(follower, stopEpoch)` was applied). */
  killedBy(follower: Address, stopEpoch: bigint): bigint[] {
    return [...(this.killed.get(`${k(follower)}:${stopEpoch}`) ?? [])];
  }

  /** Whether `key` is (or was) the delegated key of any subscription: fills signed by it are copies (cycle protection). */
  isDelegatedKey(key: Address): boolean {
    return this.delegatedKeys.has(k(key));
  }

  /** Live subscriptions that use `key` now (destroy the key once this is empty, §8.3). */
  liveSubscriptionsUsingKey(key: Address): bigint[] {
    return [...(this.delegatedKeys.get(k(key)) ?? [])]
      .filter((id) => isLive(this.statusOf(id)) && sameAddress(this.subscriptions.get(id)!.record.delegatedKey, key))
      .sort(cmpBig);
  }

  /** Every authorised executor (the set is rebuilt from ExecutorSet events; there is no on-chain list). */
  authorisedExecutors(): Address[] {
    return [...this.executors.values()].filter((x) => x.authorised).map((x) => x.address);
  }

  /** A deep copy (for reorg snapshots). */
  clone(): CopyTradingIndex {
    const c = new CopyTradingIndex(this.address);
    for (const [id, s] of this.subscriptions) c.subscriptions.set(id, { ...s, record: { ...s.record }, symbols: [...s.symbols] });
    for (const [key, v] of this.venues) c.venues.set(key, { ...v });
    for (const [key, x] of this.executors) c.executors.set(key, { ...x });
    for (const [key, cm] of this.commitments) c.commitments.set(key, { ...cm });
    for (const [key, words] of this.nonceWords) c.nonceWords.set(key, new Map(words));
    c.upgrades.push(...this.upgrades.map((u) => ({ ...u })));
    c.builderTerms = this.builderTerms ? { ...this.builderTerms } : null;
    c.paused = this.paused;
    c.owner = this.owner;
    c.pendingOwner = this.pendingOwner;
    c.implementation = this.implementation;
    c.initializedVersion = this.initializedVersion;
    c.domainChanged = this.domainChanged ? { ...this.domainChanged } : null;
    c.subscriptionCount = this.subscriptionCount;
    c.cursor = this.cursor ? { ...this.cursor } : null;
    for (const [key, ids] of this.followerIds) c.followerIds.set(key, [...ids]);
    for (const [key, ids] of this.leaderIds) c.leaderIds.set(key, [...ids]);
    for (const [key, set] of this.liveSets) c.liveSets.set(key, set.clone());
    for (const [key, id] of this.liveByKey) c.liveByKey.set(key, id);
    for (const [key, e] of this.stopEpochs) c.stopEpochs.set(key, e);
    for (const [key, ks] of this.killSwitches) c.killSwitches.set(key, { ...ks });
    for (const [key, ids] of this.killed) c.killed.set(key, [...ids]);
    for (const [key, ids] of this.leaderLive) c.leaderLive.set(key, new Set(ids));
    for (const [key, ids] of this.delegatedKeys) c.delegatedKeys.set(key, new Set(ids));
    return c;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private liveSet(follower: Address, epoch: bigint): OrderedIdSet {
    const key = `${k(follower)}:${epoch}`;
    let s = this.liveSets.get(key);
    if (!s) this.liveSets.set(key, (s = new OrderedIdSet()));
    return s;
  }

  private mustBeLive(id: bigint, what: string): IndexedSubscription {
    const s = this.subscriptions.get(id);
    if (!s) throw new IndexConsistencyError(`${what}: unknown subscription ${id}`);
    if (!isLive(this.statusOf(id))) throw new IndexConsistencyError(`${what}: subscription ${id} is not live`);
    return s;
  }

  private checkVersion(s: IndexedSubscription, version: number, what: string): void {
    if (version !== s.record.version + 1) {
      throw new IndexConsistencyError(`${what}: subscription ${s.id} version ${version}, expected ${s.record.version + 1}`);
    }
  }

  private checkSymbols(id: bigint, r: Subscription, symbols: readonly string[]): void {
    if (symbolsHash(symbols) !== r.symbolsHash.toLowerCase()) {
      throw new IndexConsistencyError(`subscription ${id}: the event's symbol list does not match symbolsHash`);
    }
  }

  private setNonceBits(signer: Address, word: bigint, mask: bigint): void {
    let words = this.nonceWords.get(k(signer));
    if (!words) this.nonceWords.set(k(signer), (words = new Map()));
    words.set(word, (words.get(word) ?? 0n) | mask);
  }
}

function push(m: Map<string, bigint[]>, key: string, id: bigint): void {
  const l = m.get(key);
  if (l) l.push(id);
  else m.set(key, [id]);
}
function addTo(m: Map<string, Set<bigint>>, key: string, id: bigint): void {
  let s = m.get(key);
  if (!s) m.set(key, (s = new Set()));
  s.add(id);
}
function removeFrom(m: Map<string, Set<bigint>>, key: string, id: bigint): void {
  const s = m.get(key);
  if (!s) return;
  s.delete(id);
  if (s.size === 0) m.delete(key);
}

// ---------------------------------------------------------------------------
// Reorg-aware view for executors
// ---------------------------------------------------------------------------

export class DeepReorgError extends Error {
  override name = 'DeepReorgError';
}

/**
 * Two views of the chain for an executor (spec §8.3): the TIP (every log seen, 0 confirmations) and the CONFIRMED
 * view (logs at least `confirmations` blocks deep). Stops, pauses and tightenings are acted on at the tip; activations
 * only once confirmed. `mayOpen(id, now)` is the conservative merge: copyable at the tip AND in the confirmed view.
 *
 * Feed it `update(head, logs, reorgFrom?)` after each poll: `logs` are the decoded logs of blocks you have not fed yet
 * (or, after a reorg, of every block from `reorgFrom`). A reorg deeper than the confirmed line throws DeepReorgError:
 * rebuild from a persisted snapshot (or from the deployment block).
 */
export class ChainView {
  private base: CopyTradingIndex;
  private recent: CopyTradingEvent[] = [];
  private tipIndex: CopyTradingIndex;
  private confirmedThrough = -1n;

  constructor(
    readonly address: Address,
    readonly confirmations: number = ACTIVATION_CONFIRMATIONS,
    base?: CopyTradingIndex,
  ) {
    this.base = base ? base.clone() : new CopyTradingIndex(address);
    if (base?.cursor) this.confirmedThrough = base.cursor.blockNumber;
    this.tipIndex = this.base.clone();
  }

  update(head: bigint, events: readonly CopyTradingEvent[], reorgFrom?: bigint): void {
    if (reorgFrom !== undefined) {
      if (reorgFrom <= this.confirmedThrough) {
        throw new DeepReorgError(`reorg from block ${reorgFrom} reaches confirmed block ${this.confirmedThrough}`);
      }
      this.recent = this.recent.filter((e) => e.blockNumber < reorgFrom);
    }
    const fresh = events.filter((e) => !e.removed).sort(compareLogPosition);
    const last = this.recent[this.recent.length - 1];
    if (last && fresh[0] && compareLogPosition(fresh[0], last) <= 0) {
      throw new IndexOrderError('events overlap what was already fed: pass reorgFrom to replace blocks');
    }
    this.recent.push(...fresh);
    const line = head - BigInt(this.confirmations);
    const settle = this.recent.filter((e) => e.blockNumber <= line);
    if (settle.length) {
      this.base.applyAll(settle);
      this.recent = this.recent.filter((e) => e.blockNumber > line);
    }
    if (line > this.confirmedThrough) this.confirmedThrough = line;
    const tip = this.base.clone();
    tip.applyAll(this.recent);
    this.tipIndex = tip;
  }

  /** Every log seen (0 confirmations). Use it for stops. */
  tip(): CopyTradingIndex {
    return this.tipIndex;
  }

  /** Logs at least `confirmations` deep. Persist snapshots of this one. */
  confirmed(): CopyTradingIndex {
    return this.base;
  }

  /** Highest block number whose logs are in the confirmed view. */
  get confirmedBlock(): bigint {
    return this.confirmedThrough;
  }

  /** Open or increase only if copyable at the tip (no stop seen) AND in the confirmed view (activation settled). */
  mayOpen(id: bigint, now: number): boolean {
    return this.tipIndex.isCopyable(id, now) && this.base.isCopyable(id, now);
  }
}
