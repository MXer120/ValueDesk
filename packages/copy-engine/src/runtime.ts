/**
 * The copy runtime: feeds in, orders out, books kept.
 *
 * One runtime runs every subscription of one copier (a browser tab, the
 * hosted executor, a self-hosted executor). Its loop:
 *
 *   1. LEADERS. Each followed leader is seeded from REST, then moved by its
 *      venue's public stream (feeds.ts) and re-read every RECONCILE_MS; every
 *      change is a LeaderEvent.
 *   2. PLAN. Each event is planned for every subscription following that
 *      leader (planner.ts), with the SoDEX mark captured once per event, so
 *      every follower gets the same limit price. Followers are served in a
 *      random order, each follower's orders strictly one after another (one
 *      key, one nonce sequence).
 *   3. SEND. Through the subscription's sink: a key sink signs and sends to
 *      SoDEX, the paper sink simulates. A write without a readable answer is
 *      never resent; the next account read and reconciliation settle it.
 *   4. BOOKS. Fills of copied orders (seen on the public stream by the
 *      follower's account id) move the copy's position, entry and realised
 *      PnL; the follower's account is re-read after orders and on a timer and
 *      the copy's positions follow what SoDEX says.
 *   5. GUARDS. At the marks: stop-loss / take-profit per copied position and
 *      the copy's drawdown stop. Where the follower set a stop-loss or take-
 *      profit, the copier also keeps a SoDEX position stop for each copied
 *      position, so it closes on SoDEX even while no copier is running.
 *   6. READINESS. A live subscription needs a registered, unexpired copy key
 *      and a builder-fee approval that covers the copy fee; without them it
 *      is `blocked` (and resumes by itself once they are there). The region
 *      and "ask me each time" (which needs a host that can ask) are checked
 *      without SoDEX, on every change. A blocked or halted copy still follows
 *      the leader's closes and keeps its guards (reduce-only).
 *   7. CATCH-UP. After a restart, what the leader did while no copier ran is
 *      planned like a missed print; on every reconcile (and on resume), what a
 *      copy still holds where its leader is flat or on the other side - a close
 *      that filled only in part, a close missed while paused - is closed.
 */
import { bytesToHex, keccak256, utf8, type BuilderParams, type Network } from '../../sodex-core/src/index.ts';
import { LeaderBook, SodexFeed, HyperliquidFeed, type FollowerFill } from './feeds.ts';
import { randomId, sleep, timers, type Logger, type WebSocketFactory } from './io.ts';
import { MarketBook, floorQuantity, hlDexOf, limitPrice, snapPrice, sodexNamesFor } from './markets.ts';
import type { OrderSink, SendResult } from './orders.ts';
import {
  applyFill,
  clientOrderId,
  copyEquity,
  directionSign,
  freshState,
  grossNotional,
  guardTrigger,
  noteSeen,
  planGuards,
  planLeaderEvent,
  unrealized,
} from './planner.ts';
import { effectiveLeverage, type RegionPolicy } from './policy.ts';
import { HL_DEXES, type HyperliquidClient, type SodexClient } from './sodex.ts';
import type { CopyStore } from './store.ts';
import { copyAssetNotice, copyClosedNotice, copyDelistedNotice, copyNotCopiedNotice, copyNotice, delistedDetail, type EngineNotice } from './notices.ts';
import type {
  ActivityEntry,
  AssetVerdict,
  DetachReason,
  FollowerSnapshot,
  Intent,
  LeaderEvent,
  LeaderRead,
  LeaderRef,
  MarketInfo,
  SkipReason,
  SubState,
  Subscription,
  SubscriptionStatus,
} from './types.ts';

export const RECONCILE_MS = 60_000;
export const FOLLOWER_REFRESH_MS = 30_000;
export const GUARD_MS = 2_000;
export const READY_CHECK_MS = 10 * 60_000;
export const MARKETS_REFRESH_MS = 10 * 60_000;
/** Firehose mode: Hyperliquid's coin list is read again this often (new listings, new HIP-3 dexes). */
export const HL_COINS_REFRESH_MS = 10 * 60_000;
/** ... and this soon after a read failed or left the list empty, doubling up to HL_COINS_REFRESH_MS. */
export const HL_COINS_RETRY_MS = 30_000;
/** Hyperliquid allows 1,000 websocket subscriptions per IP. */
export const HL_MAX_COINS = 990;
/** How long a sent order may still be matched to fills on the stream. */
const PENDING_MS = 30_000;
/** Why a copy with approval 'confirm' cannot run on a host that has no one to ask. */
export const CONFIRM_UNAVAILABLE =
  '"Ask me each time" needs a copier that can ask you (the browser copier). Choose automatic approval to copy here.';
/** Skips not worth a line in the activity log. */
const QUIET_SKIPS: ReadonlySet<SkipReason> = new Set(['duplicate', 'at-target', 'no-follower-position', 'spot-not-copied']);

export interface RuntimeHost {
  store: CopyStore;
  sodex: SodexClient;
  hyperliquid: HyperliquidClient;
  factory: WebSocketFactory;
  network: Network;
  /** 'user' in a browser (a few leaders), 'firehose' in an executor. */
  hlMode: 'user' | 'firehose';
  /** The sink for a subscription: paper, or a key sink; null when no key is available. */
  sinkFor(sub: Subscription): OrderSink | null;
  /** The builder to attach to this subscription's orders (the copy fee), or null when no builder is configured. */
  builderFor(sub: Subscription): Promise<BuilderParams | null>;
  /** The region policy that applies to this subscription. */
  policyFor(sub: Subscription): RegionPolicy;
  /** For a live subscription: why its key cannot trade (missing, replaced, expired), or null. */
  keyProblem?(sub: Subscription): Promise<string | null>;
  /**
   * The operator's emergency brake: while it returns a reason, a live copy sends
   * no order at all (it is asked before every batch, so it bites at once). Stops
   * already resting on SoDEX stay, and so does everything the follower does by
   * hand (stop, close, pause). Released, the copy goes on from the next trade of
   * its leader; what the leader did meanwhile is not copied after the fact.
   */
  brake?(sub: Subscription): string | null;
  /** Approval mode 'confirm': ask the follower; resolve false to decline. */
  confirm?(sub: Subscription, intents: Intent[], event: LeaderEvent): Promise<boolean>;
  /** Something about this subscription changed (state, activity, status). */
  onChange?(subId: string): void;
  /**
   * A copy halted, was held, paused or stopped without the follower asking, a copied position was closed by its stop or
   * outside the copier, a leader's coin cannot be copied (not on SoDEX, another asset there), or a market it holds was delisted (notices.ts).
   */
  onNotice?(n: EngineNotice): void;
  log: Logger;
}

export interface CopyPosition {
  symbol: string;
  size: number;
  entry: number;
  mark: number | null;
  notionalUsd: number;
  unrealizedPnl: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

/** What a follower sees about one copy. */
export interface CopyView {
  subscription: Subscription;
  equity: number;
  /** Equity - allocation. */
  pnl: number;
  pnlPct: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fees: number;
  grossNotional: number;
  leverage: number;
  peakEquity: number;
  drawdownPct: number;
  positions: CopyPosition[];
  leader: { positions: Record<string, number>; equity: number | null };
  orders: number;
  skips: number;
  lastEventAt: number | null;
  feeds: { sodex: boolean; hyperliquid: boolean | null };
}

interface Pending {
  subId: string;
  symbol: string;
  side: 'buy' | 'sell';
  reduceOnly: boolean;
  remaining: number;
  clOrdID: string;
  until: number;
  builderFee: number;
  leg: string;
}

const lk = (l: LeaderRef): string => `${l.venue}:${l.address.toLowerCase()}`;

/** The two prices of a 'different-asset' skip, for its activity line. */
const assetDetail = (leaderSymbol: string, v: AssetVerdict): string =>
  `Hyperliquid ${leaderSymbol} ${Number(v.leaderPrice.toPrecision(6))}, SoDEX ${v.market} ${Number(v.sodexPrice.toPrecision(6))}: ${(Math.abs(v.deviation) * 100).toFixed(1)}% apart`;

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export class CopyRuntime {
  readonly markets = new MarketBook();
  readonly leaders = new LeaderBook();
  private subs = new Map<string, Subscription>();
  private states = new Map<string, SubState>();
  private followers = new Map<string, FollowerSnapshot>();
  private followerAccounts = new Map<number, string>();
  private sodexIds = new Map<string, number>();
  private queues = new Map<string, Promise<void>>();
  private pending: Pending[] = [];
  /** `${subId}|${symbol}` -> the last order that opened or added, so a fill the stream missed is still adopted. */
  private recentGrow = new Map<string, { side: 'buy' | 'sell'; at: number }>();
  private leverageSet = new Map<string, { leverage: number; margin: string }>();
  private refreshTimers = new Map<string, unknown>();
  private stopTimers = new Map<string, unknown>();
  private timers: unknown[] = [];
  private sodexFeed: SodexFeed | null = null;
  private hlFeed: HyperliquidFeed | null = null;
  private hlCoins: string[] = [];
  /** Firehose mode: each Hyperliquid dex's live coins ('' = the main dex), as last read. */
  private hlCoinsByDex = new Map<string, string[]>();
  private hlCoinsTimer: unknown = null;
  private hlCoinsRetry = HL_COINS_RETRY_MS;
  /** Copies whose leader could not be read when they started (or were restored): caught up once it is seeded. */
  private awaitingSeed = new Set<string>();
  private running = false;
  private feedUp = { sodex: false, hyperliquid: false };
  private dirty = new Set<string>();

  constructor(private readonly host: RuntimeHost) {}

  /* ------------------------------------------------------------ lifecycle ----- */

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.loadMarkets();
    const restored: string[] = [];
    for (const s of await this.host.store.subscriptions()) {
      this.subs.set(s.id, s);
      const saved = await this.host.store.state(s.id);
      this.states.set(s.id, saved ?? freshState(s.id, s.settings.allocationUsd));
      if (saved) restored.push(s.id);
    }
    this.sodexFeed = new SodexFeed({
      network: this.host.network,
      factory: this.host.factory,
      book: this.leaders,
      log: this.host.log,
      symbols: () => this.markets.all().map((m) => m.name),
      sink: {
        leader: (e) => this.onLeaderEvent(e),
        follower: (f) => this.onFollowerFill(f),
        mark: (s, p, at) => this.markets.setMark(s, p, at),
        state: (_f, up) => {
          this.feedUp.sodex = up;
          // Back up after a gap: what the stream missed, a reconcile finds.
          if (up) void this.reconcileAll();
        },
      },
    });
    this.sodexFeed.start();
    await this.syncFeeds();
    for (const s of [...this.subs.values()]) await this.applyLocalRules(s.id);
    // A notice is never a reason not to start (as on every market reload below).
    await this.noteDelisted().catch((e) => this.host.log.warn('copy: delisting check failed', { error: String(e) }));
    for (const id of restored) this.catchUp(id);
    for (const s of this.subs.values()) if (this.live(s)) void this.checkReady(s);
    this.timers.push(
      timers.every(RECONCILE_MS, () => void this.reconcileAll()),
      timers.every(FOLLOWER_REFRESH_MS, () => void this.refreshAllFollowers()),
      timers.every(GUARD_MS, () => void this.runGuards()),
      timers.every(READY_CHECK_MS, () => {
        for (const s of this.subs.values()) if (this.live(s)) void this.checkReady(s);
      }),
      timers.every(MARKETS_REFRESH_MS, () => void this.loadMarkets().then(() => this.sodexFeed?.refreshSymbols())),
      timers.every(5_000, () => void this.flush()),
    );
    void this.reconcileAll();
    void this.refreshAllFollowers();
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) timers.cancel(t);
    this.timers = [];
    for (const t of this.refreshTimers.values()) timers.cancel(t);
    for (const t of this.stopTimers.values()) timers.cancel(t);
    timers.cancel(this.hlCoinsTimer);
    this.sodexFeed?.stop();
    this.hlFeed?.stop();
    await Promise.allSettled([...this.queues.values()]);
    await this.flush();
  }

  /* ------------------------------------------------------- subscriptions ----- */

  get(id: string): Subscription | null {
    return this.subs.get(id) ?? null;
  }

  list(owner?: string): Subscription[] {
    return [...this.subs.values()].filter((s) => !owner || s.owner === owner.toLowerCase());
  }

  /**
   * Start a subscription. The leader is read now: positions it already holds
   * are joined (copyExisting) or left alone until it is flat on them.
   */
  async add(sub: Subscription): Promise<Subscription> {
    const s: Subscription = { ...sub, owner: sub.owner.toLowerCase() };
    this.subs.set(s.id, s);
    const st = freshState(s.id, s.settings.allocationUsd);
    this.states.set(s.id, st);
    await this.host.store.saveSubscription(s);
    await this.syncFeeds();
    await this.seedLeader(s.settings.leader);
    // Not readable now: once it is, what the leader holds then is pre-existing to this copy (catchUp).
    if (!this.leaders.seeded(s.settings.leader)) this.awaitingSeed.add(s.id);
    const positions = this.leaders.positions(s.settings.leader);
    st.leaderPos = { ...positions };
    st.leaderEquity = this.leaders.equity(s.settings.leader)?.value ?? null;
    st.leaderEquityAt = this.leaders.equity(s.settings.leader)?.at ?? null;
    const now = Date.now();
    if (!s.settings.copyExisting) {
      for (const sym of Object.keys(positions)) st.detached[sym] = 'pre-existing';
    }
    await this.host.store.saveState(st);
    await this.activity(s, { kind: 'status', reason: s.status, detail: s.settings.paper ? 'Paper copy started.' : 'Copying started.' });
    await this.applyLocalRules(s.id);
    if (this.live(s)) await this.checkReady(s);
    if (s.settings.copyExisting) {
      for (const [sym, size] of Object.entries(positions)) {
        const price = this.priceFor(s.settings.leader.venue, sym) ?? 0;
        this.dispatch(s, { leader: s.settings.leader, symbol: sym, before: 0, after: size, price, time: now, id: `join:${sym}:${now}`, source: 'reconcile' });
      }
    }
    void this.refreshFollower(s.owner);
    return s;
  }

  /** New rules for a running subscription (the leader cannot change: that is a new subscription). */
  async update(id: string, patch: Partial<Pick<Subscription, 'settings' | 'consent' | 'country' | 'observedCountry' | 'termsVersion'>>): Promise<Subscription> {
    const s = this.need(id);
    if (patch.settings && lk(patch.settings.leader) !== lk(s.settings.leader)) throw new Error('The trader of a copy cannot change; start a new copy instead.');
    if (patch.settings && patch.settings.paper !== s.settings.paper) throw new Error('A copy cannot switch between paper and live; start a new copy instead.');
    if (patch.settings && (patch.settings.direction ?? 'copy') !== (s.settings.direction ?? 'copy')) {
      throw new Error('A copy cannot switch between copying and counter-trading; start a new copy instead.');
    }
    // Nobody can be asked here: refused, so a copy never trades "ask me each time" without asking.
    if (patch.settings?.approval === 'confirm' && !this.host.confirm) throw new Error(CONFIRM_UNAVAILABLE);
    if (patch.settings && patch.settings.allocationUsd !== s.settings.allocationUsd) {
      // The drawdown stop measures from the peak equity: it moves with the allocation, or a
      // lower allocation would read as a loss (and close everything).
      const st = this.stateOf(s);
      st.peakEquity = Math.max(0, st.peakEquity + patch.settings.allocationUsd - s.settings.allocationUsd);
      this.dirty.add(id);
    }
    const next: Subscription = { ...s, ...patch, updatedAt: Date.now() };
    this.subs.set(id, next);
    await this.host.store.saveSubscription(next);
    await this.activity(next, { kind: 'status', reason: 'updated', detail: 'Copy rules changed.' });
    // A new region or approval mode may block the copy, or lift what blocked it.
    await this.applyLocalRules(id);
    const cur = this.need(id);
    if (this.live(cur) && cur.status === 'blocked') await this.checkReady(cur);
    return this.need(id);
  }

  async setStatus(id: string, status: SubscriptionStatus, reason: string | null): Promise<Subscription> {
    const s = this.need(id);
    if (s.status === 'stopped' && status !== 'stopped') throw new Error('A stopped copy cannot be restarted; start a new copy.');
    if (s.status === status && s.statusReason === reason) return s;
    const next: Subscription = { ...s, status, statusReason: reason, updatedAt: Date.now() };
    this.subs.set(id, next);
    await this.host.store.saveSubscription(next);
    await this.activity(next, { kind: 'status', reason: status, detail: reason });
    this.notice(copyNotice(next, status, reason));
    if (status === 'active') void this.refreshFollower(next.owner);
    // A stopped copy's SoDEX stops are not touched here: stopCopy cancels those of the
    // positions it closed, and the positions it keeps keep theirs.
    if (status === 'stopped') await this.syncFeeds();
    this.host.onChange?.(id);
    return next;
  }

  pause = (id: string) => this.setStatus(id, 'paused', 'Paused by you.');

  async resume(id: string): Promise<Subscription> {
    const s = this.need(id);
    if (s.status === 'halted' || s.status === 'blocked') {
      // Re-check what blocked it; a drawdown halt resumes from the current equity.
      if (s.status === 'halted') {
        const st = this.stateOf(s);
        st.peakEquity = copyEquity(s.settings, st, (m) => this.markets.mark(m));
        this.dirty.add(s.id);
      }
    }
    const next = await this.setStatus(id, 'active', null);
    await this.applyLocalRules(id);
    if (this.live(next)) await this.checkReady(this.need(id));
    // What the leader closed while the copy was paused (or halted) is closed now.
    this.enqueue(next.owner, () => this.closeStrays(id));
    return this.need(id);
  }

  /**
   * Stop a copy for good. With `close`, its positions are closed at the market (reduce-only);
   * it says "positions closed" only for positions known to be flat, and the SoDEX stop-loss of
   * a position that may still be open is kept. Without `close`, the positions and their SoDEX
   * stops stay as they are (the copier no longer manages them).
   */
  async stopCopy(id: string, o: { close: boolean }): Promise<Subscription> {
    const s = this.need(id);
    if (!o.close) return this.setStatus(id, 'stopped', 'Stopped by you; positions kept.');
    const open = await this.closeAll(s, 'stop-all');
    const keep = new Set(open);
    this.cancelStopsWhere(s, (sym) => !keep.has(sym));
    return this.setStatus(
      id,
      'stopped',
      open.length
        ? `Stopped by you; not confirmed closed: ${open.join(', ')}. ${open.length > 1 ? 'They' : 'It'} may still be open on SoDEX, with any stop-loss the copier placed there; check your SoDEX account.`
        : 'Stopped by you; positions closed.',
    );
  }

  /** The kill switch: every copy of `owner` stops. */
  async stopAll(owner: string, o: { close: boolean }): Promise<Subscription[]> {
    const out: Subscription[] = [];
    for (const s of this.list(owner)) if (s.status !== 'stopped') out.push(await this.stopCopy(s.id, o));
    return out;
  }

  view(id: string): CopyView | null {
    const s = this.subs.get(id);
    if (!s) return null;
    const st = this.stateOf(s);
    const markOf = (m: string) => this.markets.mark(m, 10 * 60_000);
    const equity = copyEquity(s.settings, st, markOf);
    const policy = this.host.policyFor(s);
    const positions: CopyPosition[] = Object.entries(st.owned).map(([sym, p]) => {
      const mark = markOf(sym);
      const m = this.markets.get(sym);
      const lev = m ? effectiveLeverage(s.settings.maxLeverage, policy, m.maxLeverage) : s.settings.maxLeverage;
      return {
        symbol: sym,
        size: p.size,
        entry: p.entry,
        mark,
        notionalUsd: Math.abs(p.size) * (mark ?? p.entry),
        unrealizedPnl: mark === null ? 0 : p.size * (mark - p.entry),
        stopLoss: guardTrigger('stop-loss', p, s.settings, lev),
        takeProfit: guardTrigger('take-profit', p, s.settings, lev),
      };
    });
    const gross = grossNotional(st, markOf);
    const peak = Math.max(st.peakEquity, equity);
    return {
      subscription: s,
      equity,
      pnl: equity - s.settings.allocationUsd,
      pnlPct: s.settings.allocationUsd > 0 ? (equity - s.settings.allocationUsd) / s.settings.allocationUsd : 0,
      realizedPnl: st.realizedPnl,
      unrealizedPnl: unrealized(st, markOf),
      fees: st.fees,
      grossNotional: gross,
      leverage: equity > 0 ? gross / equity : 0,
      peakEquity: peak,
      drawdownPct: peak > 0 ? Math.max(0, (peak - equity) / peak) : 0,
      positions,
      leader: { positions: this.leaders.positions(s.settings.leader), equity: this.leaders.equity(s.settings.leader)?.value ?? null },
      orders: st.orders,
      skips: st.skips,
      lastEventAt: st.lastEventAt,
      feeds: { sodex: this.feedUp.sodex, hyperliquid: this.hlFeed ? this.feedUp.hyperliquid : null },
    };
  }

  /* --------------------------------------------------------------- events ----- */

  private onLeaderEvent(e: LeaderEvent): void {
    // A Hyperliquid print is Hyperliquid's price (a reconcile's may be SoDEX's): the same-asset check compares it.
    if (e.source === 'stream') this.markets.observeLeaderPrice(e.leader.venue, e.symbol, e.price, Math.min(e.time, Date.now()));
    for (const s of shuffle(this.list())) {
      if (lk(s.settings.leader) !== lk(e.leader)) continue;
      if (s.status === 'stopped') continue;
      this.dispatch(s, e);
    }
  }

  private dispatch(s: Subscription, e: LeaderEvent): void {
    // Captured once: every follower of this change gets the same reference price.
    const market = this.markets.sodexMarketFor(e.leader.venue, e.symbol);
    const mark = market ? this.markets.mark(market.name) : null;
    const asset = market ? this.markets.sameAsset(e.leader.venue, e.symbol) : null;
    this.enqueue(s.owner, () => this.process(s.id, e, market, mark, asset));
  }

  private enqueue(owner: string, fn: () => Promise<void>): void {
    const prev = this.queues.get(owner) ?? Promise.resolve();
    const next = prev.then(fn).catch((err) => this.host.log.error('copy: a step failed', { owner, error: String(err) }));
    this.queues.set(owner, next);
    void next.finally(() => {
      if (this.queues.get(owner) === next) this.queues.delete(owner);
    });
  }

  private async process(subId: string, e: LeaderEvent, market: MarketInfo | null, mark: number | null, asset: AssetVerdict | null = null): Promise<void> {
    let s = this.subs.get(subId);
    if (!s || s.status === 'stopped') return;
    // The region and the approval mode are checked on every change, not only by the readiness
    // check (which reads SoDEX, and does nothing when that read fails).
    if (s.status === 'active' && this.localProblem(s)) {
      await this.applyLocalRules(s.id);
      s = this.need(subId);
    }
    const st = this.stateOf(s);
    const markOf = (sym: string) => (market && sym === market.name && mark !== null ? mark : this.markets.mark(sym));
    const plan = planLeaderEvent({
      sub: s,
      state: st,
      event: e,
      market,
      markOf,
      policy: this.host.policyFor(s),
      heldBy: market ? this.heldBy(s, market.name) : 'nobody',
      // A paper copy is not gated on the follower's real account.
      follower: this.live(s) ? (this.followers.get(s.owner) ?? null) : null,
      inFlight: this.inFlightOf(s.id),
      ...(market && e.leader.venue === 'hyperliquid' ? { sameAsset: asset?.same ?? null } : {}),
    });
    if (asset && (plan.skip === 'different-asset' || asset.same)) this.noteAsset(s, e.symbol, asset);
    if (plan.skip === 'not-on-sodex') this.noteNotCopied(s, e.symbol);
    const detail = plan.skip === 'different-asset' && asset ? assetDetail(e.symbol, asset) : null;
    st.leaderPos[e.symbol] = plan.leaderAfter;
    if (plan.leaderAfter === 0) delete st.leaderPos[e.symbol];
    if (plan.attach) delete st.detached[e.symbol];
    if (plan.detach) st.detached[e.symbol] = plan.detach;
    if (plan.skip !== 'duplicate') noteSeen(st, e.id);
    st.lastEventAt = e.time;
    const leader = { symbol: e.symbol, before: e.before ?? 0, after: e.after, price: e.price, time: e.time };
    if (!plan.intents.length) {
      if (plan.skip && plan.skip !== 'duplicate') st.skips++;
      if (plan.skip && !QUIET_SKIPS.has(plan.skip)) await this.activity(s, { kind: 'skip', reason: plan.skip, symbol: market?.name ?? e.symbol, leader, detail });
      this.dirty.add(s.id);
      return;
    }
    if (s.settings.approval === 'confirm' && this.host.confirm) {
      let yes = false;
      try {
        yes = await this.host.confirm(s, plan.intents, e);
      } catch {
        yes = false;
      }
      if (!yes) {
        st.skips++;
        await this.activity(s, { kind: 'skip', reason: 'declined', symbol: market!.name, leader });
        this.dirty.add(s.id);
        return;
      }
    }
    await this.execute(s, market!, plan.intents, markOf(market!.name) ?? e.price, leader);
    if (plan.skip && !QUIET_SKIPS.has(plan.skip)) await this.activity(s, { kind: 'skip', reason: plan.skip, symbol: market!.name, leader, detail });
  }

  /**
   * A copy hears once that a leader market of its is not copied as a different asset (when
   * that holds back a change, or a position it holds there), and once that it is copied
   * again when the prices agree (st.differentAssets keeps what it was told, across restarts).
   */
  private noteAsset(s: Subscription, leaderSymbol: string, v: AssetVerdict): void {
    const st = this.stateOf(s);
    const told = st.differentAssets?.[leaderSymbol] !== undefined;
    if (v.same === told) {
      if (v.same) delete st.differentAssets![leaderSymbol];
      else (st.differentAssets ??= {})[leaderSymbol] = Date.now();
      this.dirty.add(s.id);
      this.notice(copyAssetNotice(s, leaderSymbol, v));
    }
  }

  /**
   * A copy hears once per leader market that SoDEX lists none for it, the first time a trade
   * of the leader's there is skipped (st.notCopied keeps what it was told, across restarts);
   * its activity keeps a line for every skipped trade. A market the copy still holds a position
   * on (SoDEX delisted it) has its own notice (noteDelisted).
   */
  private noteNotCopied(s: Subscription, leaderSymbol: string): void {
    const st = this.stateOf(s);
    if (st.notCopied?.[leaderSymbol] !== undefined) return;
    if (sodexNamesFor(s.settings.leader.venue, leaderSymbol).some((n) => st.owned[n])) return;
    (st.notCopied ??= {})[leaderSymbol] = Date.now();
    this.dirty.add(s.id);
    this.notice(copyNotCopiedNotice(s, leaderSymbol));
  }

  /**
   * A copied position on a market SoDEX no longer lists: the copier does not close it, reduce
   * it or add to it any more (closeStrays, the guards and the planner all need the market), and
   * the follower is told once - a notice and a line in the copy's activity. A delisting is the
   * follower's to act on (owner, 2026-10-29). Told again only after SoDEX lists the market again
   * and drops it once more. A market list that could not be read (empty) says nothing.
   */
  private async noteDelisted(): Promise<void> {
    if (!this.markets.size) return;
    for (const s of this.list()) {
      if (s.status === 'stopped') continue;
      const st = this.stateOf(s);
      for (const sym of Object.keys(st.delisted ?? {})) {
        if (!this.markets.get(sym) && st.owned[sym]) continue;
        delete st.delisted![sym];
        this.dirty.add(s.id);
      }
      for (const [sym, p] of Object.entries(st.owned)) {
        if (this.markets.get(sym) || st.delisted?.[sym] !== undefined || !(Math.abs(p.size) > 1e-12)) continue;
        (st.delisted ??= {})[sym] = Date.now();
        this.dirty.add(s.id);
        await this.activity(s, { kind: 'status', reason: 'delisted', symbol: sym, detail: delistedDetail(sym, p.size) });
        this.notice(copyDelistedNotice(s, sym, p.size));
      }
    }
  }

  /**
   * After a read of a Hyperliquid leader: the same-asset check again for what its copies
   * hold or were told about, so a market whose prices part stops growing and one whose
   * prices meet again is copied again - each told to the copy.
   */
  private recheckAssets(l: LeaderRef): void {
    if (l.venue !== 'hyperliquid') return;
    const book = this.leaders.positions(l);
    for (const s of this.list()) {
      if (lk(s.settings.leader) !== lk(l) || s.status === 'stopped') continue;
      const st = this.stateOf(s);
      for (const sym of new Set([...Object.keys(book), ...Object.keys(st.differentAssets ?? {})])) {
        const v = this.markets.sameAsset(l.venue, sym);
        if (!v) continue;
        // A market the copy holds nothing on is told when a change there is held back.
        if (!v.same && !st.owned[v.market]) continue;
        this.noteAsset(s, sym, v);
      }
    }
  }

  /** Who holds the follower's position on `symbol` when this copy does not. */
  private heldBy(s: Subscription, symbol: string): 'nobody' | 'follower' | 'other-copy' {
    if (this.stateOf(s).owned[symbol]) return 'nobody';
    for (const o of this.list(s.owner)) {
      if (o.id === s.id || o.status === 'stopped') continue;
      if (o.settings.paper !== s.settings.paper) continue;
      if (this.stateOf(o).owned[symbol]) return 'other-copy';
    }
    if (s.settings.paper) return 'nobody';
    const f = this.followers.get(s.owner);
    return f?.positions[symbol] ? 'follower' : 'nobody';
  }

  private async execute(
    s: Subscription,
    market: MarketInfo,
    intents: Intent[],
    reference: number,
    leader: ActivityEntry['leader'],
  ): Promise<SendResult[]> {
    const st = this.stateOf(s);
    const sink = this.host.sinkFor(s);
    if (!sink) {
      if (s.status === 'active') await this.setStatus(s.id, 'blocked', 'The copy key is not available here.');
      return [];
    }
    const brake = sink.paper ? null : this.host.brake?.(s) ?? null;
    if (brake) {
      await this.activity(s, { kind: 'error', reason: 'brake', symbol: market.name, detail: `Not copied: ${brake}`, leader });
      this.dirty.add(s.id);
      return [];
    }
    const builder = await this.host.builderFor(s).catch(() => null);
    let send = intents;
    if (!sink.paper && intents.some((i) => !i.reduceOnly) && !(await this.ensureLeverage(s, market, sink))) {
      // Never open at whatever leverage the account happens to have (the EEA 2x cap, the
      // follower's own cap): only what reduces goes out until SoDEX takes the leverage.
      send = intents.filter((i) => i.reduceOnly);
      const lev = effectiveLeverage(s.settings.maxLeverage, this.host.policyFor(s), market.maxLeverage);
      await this.activity(s, {
        kind: 'error',
        reason: 'leverage-not-set',
        symbol: market.name,
        detail: `SoDEX did not take the copy's leverage (${lev}x) on ${market.name}; nothing is opened or added there until it does.`,
        leader,
      });
      if (!send.length) {
        this.dirty.add(s.id);
        return [];
      }
    }
    const results = await sink.place(s.accountId, market, send, builder, reference);
    for (let i = 0; i < send.length; i++) {
      const it = send[i]!;
      const r = results[i] ?? { clOrdID: it.clOrdID, ok: false, orderId: null, error: 'no result', outcomeUnknown: false };
      st.orders += r.ok ? 1 : 0;
      await this.activity(s, {
        kind: r.ok ? 'order' : 'error',
        reason: r.ok ? it.leg : r.outcomeUnknown ? 'outcome-unknown' : 'rejected',
        detail: r.ok ? (it.clampedBy ? `Smaller than the rule asked: ${it.clampedBy}.` : null) : r.error,
        symbol: it.symbol,
        side: it.side,
        size: Number(it.quantity),
        price: Number(it.limitPrice),
        notionalUsd: it.notionalUsd,
        reduceOnly: it.reduceOnly,
        clOrdID: it.clOrdID,
        orderId: r.orderId,
        builderFee: builder?.fee ?? 0,
        leader,
      });
      if (r.paperFill) {
        const fee = r.paperFill.qty * r.paperFill.price * (market.takerFee + (builder?.fee ?? 0) / 100_000);
        this.fillBooks(s, it.symbol, it.side, r.paperFill.qty, r.paperFill.price, fee, it.reduceOnly);
        await this.activity(s, {
          kind: 'fill',
          reason: it.leg,
          symbol: it.symbol,
          side: it.side,
          size: r.paperFill.qty,
          price: r.paperFill.price,
          notionalUsd: r.paperFill.qty * r.paperFill.price,
          reduceOnly: it.reduceOnly,
          clOrdID: it.clOrdID,
          builderFee: builder?.fee ?? 0,
          leader,
        });
      } else if (r.ok || r.outcomeUnknown) {
        if (!it.reduceOnly) this.recentGrow.set(`${s.id}|${it.symbol}`, { side: it.side, at: Date.now() });
        this.pending.push({
          subId: s.id,
          symbol: it.symbol,
          side: it.side,
          reduceOnly: it.reduceOnly,
          remaining: Number(it.quantity),
          clOrdID: it.clOrdID,
          until: Date.now() + PENDING_MS,
          builderFee: builder?.fee ?? 0,
          leg: it.leg,
        });
      }
    }
    if (!sink.paper) this.scheduleRefresh(s.owner, 1_500);
    this.dirty.add(s.id);
    this.host.onChange?.(s.id);
    return results;
  }

  /** Apply a fill to the copy's books; a reduce-only fill never opens the other side. */
  private fillBooks(s: Subscription, symbol: string, side: 'buy' | 'sell', qty: number, price: number, fee: number, reduceOnly: boolean): void {
    const st = this.stateOf(s);
    let q = qty;
    if (reduceOnly) {
      const held = Math.abs(st.owned[symbol]?.size ?? 0);
      q = Math.min(q, held);
      if (!(q > 0)) return;
    }
    applyFill(st, symbol, side, q, price, fee, Date.now());
    const left = st.owned[symbol];
    const m = this.markets.get(symbol);
    if (reduceOnly && left && m && floorQuantity(left.size, m) === '0') {
      // Less than one lot left: no SoDEX position is that small, so it is booking dust (of a
      // fill that was not a whole number of steps); it is closed in the books at this price.
      st.realizedPnl += left.size * (price - left.entry);
      delete st.owned[symbol];
    }
    if (st.owned[symbol]) this.recentGrow.delete(`${s.id}|${symbol}`);
    this.dirty.add(s.id);
    if (!s.settings.paper) this.scheduleStops(s, symbol);
  }

  private onFollowerFill(f: FollowerFill): void {
    if (!f.taker) return;
    const now = Date.now();
    this.pending = this.pending.filter((p) => p.until > now && p.remaining > 1e-12);
    let left = f.qty;
    for (const p of this.pending) {
      if (left <= 0) break;
      if (p.symbol !== f.symbol || p.side !== f.side) continue;
      const s = this.subs.get(p.subId);
      if (!s || s.accountId !== f.accountId) continue;
      const q = Math.min(left, p.remaining);
      p.remaining -= q;
      left -= q;
      const m = this.markets.get(p.symbol);
      const fee = q * f.price * ((m?.takerFee ?? 0.0004) + p.builderFee / 100_000);
      this.fillBooks(s, p.symbol, p.side, q, f.price, fee, p.reduceOnly);
      void this.activity(s, {
        kind: 'fill',
        reason: p.leg,
        symbol: p.symbol,
        side: p.side,
        size: q,
        price: f.price,
        notionalUsd: q * f.price,
        reduceOnly: p.reduceOnly,
        clOrdID: p.clOrdID,
        builderFee: p.builderFee,
      });
      this.host.onChange?.(s.id);
    }
  }

  /* ------------------------------------------------------------- follower ----- */

  private scheduleRefresh(owner: string, ms: number): void {
    if (this.refreshTimers.has(owner)) return;
    this.refreshTimers.set(
      owner,
      timers.after(ms, () => {
        this.refreshTimers.delete(owner);
        void this.refreshFollower(owner);
      }),
    );
  }

  private async refreshAllFollowers(): Promise<void> {
    const owners = new Set(this.list().filter((s) => this.live(s) && s.status !== 'stopped').map((s) => s.owner));
    for (const o of owners) await this.refreshFollower(o);
  }

  /** Re-read the follower's account; the copy's positions follow what SoDEX says. */
  async refreshFollower(owner: string): Promise<void> {
    const subs = this.list(owner).filter((s) => this.live(s) && s.status !== 'stopped');
    if (!subs.length) return;
    let snap: FollowerSnapshot;
    try {
      snap = await this.host.sodex.follower(owner);
    } catch (e) {
      this.host.log.warn('copy: follower read failed', { owner, error: String(e) });
      return;
    }
    this.followers.set(owner, snap);
    if (snap.accountId) this.followerAccounts.set(snap.accountId, owner);
    this.sodexFeed?.setFollowers([...this.followerAccounts.keys()]);
    const now = Date.now();
    const inFlight = (subId: string, sym: string) => this.pending.some((x) => x.subId === subId && x.symbol === sym && x.until > now && x.remaining > 1e-12);
    for (const s of subs) {
      const st = this.stateOf(s);
      // An open whose fill the stream did not show: SoDEX holds it, so the copy does.
      for (const [k, g] of this.recentGrow) {
        if (!k.startsWith(`${s.id}|`)) continue;
        const sym = k.slice(s.id.length + 1);
        if (now - g.at > 10 * 60_000) {
          this.recentGrow.delete(k);
          continue;
        }
        const actual = snap.positions[sym];
        if (st.owned[sym] || !actual || inFlight(s.id, sym) || Math.sign(actual.size) !== (g.side === 'buy' ? 1 : -1)) continue;
        if (this.list(s.owner).some((o) => o.id !== s.id && this.states.get(o.id)?.owned[sym])) continue;
        st.owned[sym] = { size: actual.size, entry: actual.entry, openedAt: g.at };
        this.recentGrow.delete(k);
        this.scheduleStops(s, sym);
        this.dirty.add(s.id);
      }
      for (const [sym, p] of Object.entries(st.owned)) {
        if (inFlight(s.id, sym)) continue;
        const actual = snap.positions[sym];
        const mark = this.markets.mark(sym) ?? p.entry;
        if (!actual || Math.sign(actual.size) !== Math.sign(p.size)) {
          // Closed outside the copier's own orders: a SoDEX stop, the follower, or a liquidation.
          st.realizedPnl += p.size * (mark - p.entry);
          delete st.owned[sym];
          this.recentGrow.delete(`${s.id}|${sym}`);
          const why = this.closedWhy(s, p, mark, sym);
          for (const lsym of this.leaderSymbolsFor(s, sym)) if (st.leaderPos[lsym]) st.detached[lsym] = why;
          this.cancelStops(s, sym);
          // SoDEX's leverage there may no longer be the copy's (raised by hand before a liquidation):
          // it is set again before the next order that opens, never assumed.
          this.leverageSet.delete(`${s.owner}|${sym}`);
          const detail = why === 'own-position' ? 'This copied position was closed outside the copier (by you, or by SoDEX). It resumes when the leader is flat.' : `Your ${why} closed this copied position.`;
          await this.activity(s, { kind: 'status', reason: why === 'own-position' ? 'closed-outside' : why, symbol: sym, detail });
          this.notice(copyClosedNotice(s, sym, why, detail));
          this.dirty.add(s.id);
        } else if (Math.abs(actual.size - p.size) > 1e-12 * Math.max(1, Math.abs(p.size))) {
          // Smaller on SoDEX (a partial liquidation, ADL, a part closed by hand, a close of the copier's
          // whose fill the stream missed): the part that went is booked at the mark, as a whole close
          // outside is, so the copy's equity does not keep a loss that was taken.
          if (Math.abs(actual.size) < Math.abs(p.size)) st.realizedPnl += (p.size - actual.size) * (mark - p.entry);
          st.owned[sym] = { size: actual.size, entry: actual.entry || p.entry, openedAt: p.openedAt };
          this.scheduleStops(s, sym);
          this.dirty.add(s.id);
        }
      }
    }
  }

  private closedWhy(s: Subscription, p: { size: number; entry: number }, mark: number, sym: string): DetachReason {
    const m = this.markets.get(sym);
    const lev = m ? effectiveLeverage(s.settings.maxLeverage, this.host.policyFor(s), m.maxLeverage) : s.settings.maxLeverage;
    const sl = guardTrigger('stop-loss', p, s.settings, lev);
    const tp = guardTrigger('take-profit', p, s.settings, lev);
    if (sl !== null && (p.size > 0 ? mark <= sl * 1.002 : mark >= sl * 0.998)) return 'stop-loss';
    if (tp !== null && (p.size > 0 ? mark >= tp * 0.998 : mark <= tp * 1.002)) return 'take-profit';
    return 'own-position';
  }

  /** Leader symbols (in this copy's books) that map to a SoDEX market. */
  private leaderSymbolsFor(s: Subscription, sodexSymbol: string): string[] {
    const st = this.stateOf(s);
    return Object.keys(st.leaderPos).filter((l) => this.markets.sodexMarketFor(s.settings.leader.venue, l)?.name === sodexSymbol);
  }

  /**
   * Set the copy's leverage and margin mode on the market before an order that opens or adds.
   * Remembered only once SoDEX took it; a failure is tried once more at once, and then again
   * before the next such order. False: not set (the caller sends nothing that opens).
   */
  private async ensureLeverage(s: Subscription, market: MarketInfo, sink: OrderSink): Promise<boolean> {
    const policy = this.host.policyFor(s);
    const leverage = effectiveLeverage(s.settings.maxLeverage, policy, market.maxLeverage);
    const k = `${s.owner}|${market.name}`;
    const want = { leverage, margin: s.settings.marginMode };
    const had = this.leverageSet.get(k);
    if (had && had.leverage === want.leverage && had.margin === want.margin) return true;
    // SoDEX refuses a margin-mode change while a position is open; the leverage then stays as it is.
    if (this.followers.get(s.owner)?.positions[market.name] && !this.stateOf(s).owned[market.name]) return true;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await sink.setLeverage(s.accountId, market, leverage, s.settings.marginMode);
        this.leverageSet.set(k, want);
        return true;
      } catch (e) {
        this.host.log.warn('copy: leverage not set', { owner: s.owner, symbol: market.name, leverage, attempt, error: String(e) });
      }
    }
    this.leverageSet.delete(k);
    return false;
  }

  /* --------------------------------------------------------------- guards ----- */

  private async runGuards(): Promise<void> {
    for (const s of this.list()) {
      // A halted or blocked copy is guarded too: its stop-loss, take-profit and drawdown closes are reduce-only.
      if (s.status === 'stopped') continue;
      const st = this.stateOf(s);
      if (!Object.keys(st.owned).length) {
        st.peakEquity = Math.max(st.peakEquity, copyEquity(s.settings, st, (m) => this.markets.mark(m)));
        continue;
      }
      const g = planGuards({
        sub: s,
        state: st,
        markets: (m) => this.markets.get(m),
        markOf: (m) => this.markets.mark(m),
        policy: this.host.policyFor(s),
        now: Date.now(),
      });
      if (g.peak !== st.peakEquity) {
        st.peakEquity = g.peak;
        this.dirty.add(s.id);
      }
      if (!g.intents.length && !g.halt) continue;
      // Not twice: a guard close in flight is a pending reduce on that market.
      const now = Date.now();
      const intents = g.intents.filter((i) => !this.pending.some((p) => p.subId === s.id && p.symbol === i.symbol && p.reduceOnly && p.until > now));
      const byMarket = new Map<string, Intent[]>();
      for (const i of intents) byMarket.set(i.symbol, [...(byMarket.get(i.symbol) ?? []), i]);
      this.enqueue(s.owner, async () => {
        for (const [sym, list] of byMarket) {
          const m = this.markets.get(sym);
          if (!m) continue;
          const results = await this.execute(s, m, list, this.markets.mark(sym) ?? Number(list[0]!.limitPrice), null);
          // Detached only once SoDEX took the close: a refused one is tried again at the next pass, and
          // whatever an accepted one leaves open is closed with the leader (planner.ts).
          const why = g.closed[sym];
          if (why && results.some((r) => r.ok || r.outcomeUnknown)) for (const lsym of this.leaderSymbolsFor(s, sym)) st.detached[lsym] = why;
        }
        if (g.halt) await this.setStatus(s.id, 'halted', `Your drawdown stop (${Math.round((s.settings.drawdownStopPct ?? 0) * 100)}%) closed this copy.`);
      });
    }
  }

  /**
   * Close every position of the copy at the market (reduce-only). Resolves with the markets
   * not known to be flat afterwards: refused, unpriced, or (live) still on SoDEX when re-read.
   */
  private async closeAll(s: Subscription, leg: 'stop-all'): Promise<string[]> {
    const st = this.stateOf(s);
    const tag = `${leg}:${Date.now()}`;
    return new Promise<string[]>((resolve) => {
      this.enqueue(s.owner, async () => {
        const open: string[] = [];
        const sent: string[] = [];
        try {
          for (const [sym, p] of Object.entries(st.owned)) {
            const m = this.markets.get(sym);
            const mark = this.markets.mark(sym);
            if (!m || mark === null) {
              open.push(sym);
              continue;
            }
            const q = floorQuantity(p.size, m);
            if (q === '0') continue;
            const side = p.size > 0 ? 'sell' : 'buy';
            const clOrdID = clientOrderId(s.id, `${tag}:${sym}`, leg);
            const [r] = await this.execute(s, m, [{ symbol: sym, side, quantity: q, limitPrice: limitPrice(side, mark, Math.max(100, s.settings.slippageBps), m, mark), reduceOnly: true, leg, notionalUsd: Number(q) * mark, clampedBy: null, clOrdID }], mark, null);
            if (r?.paperFill) {
              if (st.owned[sym]) open.push(sym);
            } else if (r && (r.ok || r.outcomeUnknown)) sent.push(sym);
            else open.push(sym);
          }
          if (sent.length) open.push(...(await this.stillOpenOnSodex(s, sent)));
          resolve(open);
        } catch (e) {
          resolve([...new Set([...open, ...sent, ...Object.keys(st.owned)])]);
          throw e;
        }
      });
    });
  }

  /** Of `symbols`, those the follower's SoDEX account still holds (re-read up to three times; unread counts as held). */
  private async stillOpenOnSodex(s: Subscription, symbols: string[]): Promise<string[]> {
    let open = symbols;
    let read = false;
    for (let attempt = 0; attempt < 3 && open.length; attempt++) {
      if (attempt) await sleep(500);
      try {
        const snap = await this.host.sodex.follower(s.owner);
        this.followers.set(s.owner, snap);
        open = open.filter((sym) => !!snap.positions[sym]);
        read = true;
      } catch (e) {
        this.host.log.warn('copy: follower read failed', { owner: s.owner, error: String(e) });
      }
    }
    return read ? open : symbols;
  }

  /**
   * Close what a copy holds where its leader is flat or on the other side (reduce-only): a
   * close that filled only in part, a close missed while the copy was paused or while no
   * copier ran. Not for a paused copy (its positions stay as they are), nor for a market with
   * one of its orders in flight or a leader print still being merged (the stream is about to
   * say more). A synchronous fill (paper) that leaves some open is tried again at once; a live
   * close is booked from the stream, and what it leaves is tried at the next reconcile.
   */
  private async closeStrays(subId: string): Promise<void> {
    const s = this.subs.get(subId);
    if (!s || s.status === 'stopped' || s.status === 'paused') return;
    const l = s.settings.leader;
    if (!this.leaders.seeded(l)) return;
    const st = this.stateOf(s);
    const dir = directionSign(s.settings);
    const now = Date.now();
    const want = new Map<string, number>();
    const leaderSymbols = new Map<string, string[]>();
    const book = this.leaders.positions(l);
    for (const lsym of new Set([...Object.keys(book), ...Object.keys(st.leaderPos)])) {
      const m = this.markets.sodexMarketFor(l.venue, lsym);
      if (!m) continue;
      leaderSymbols.set(m.name, [...(leaderSymbols.get(m.name) ?? []), lsym]);
      if (book[lsym]) want.set(m.name, dir * Math.sign(book[lsym]!));
    }
    const inFlight = this.inFlightOf(s.id);
    for (const sym of Object.keys(st.owned)) {
      const p0 = st.owned[sym];
      if (!p0 || Math.abs(p0.size) < 1e-12) continue;
      const expected = want.get(sym) ?? 0;
      if (expected !== 0 && expected === Math.sign(p0.size)) continue;
      if (inFlight[sym]) continue;
      const lsyms = leaderSymbols.get(sym) ?? (l.venue === 'sodex' ? [sym] : []);
      if (lsyms.some((x) => this.leaders.isMerging(l, x))) continue;
      const m = this.markets.get(sym);
      const mark = this.markets.mark(sym);
      if (!m || mark === null) continue;
      for (let attempt = 0; attempt < 20; attempt++) {
        const p = st.owned[sym];
        if (!p) break;
        const q = floorQuantity(p.size, m);
        if (q === '0') break;
        const side = p.size > 0 ? 'sell' : 'buy';
        const clOrdID = clientOrderId(s.id, `sweep:${sym}:${now}:${attempt}`, 'reconcile');
        const intent: Intent = { symbol: sym, side, quantity: q, limitPrice: limitPrice(side, mark, s.settings.slippageBps, m, mark), reduceOnly: true, leg: 'reconcile', notionalUsd: Number(q) * mark, clampedBy: null, clOrdID };
        const [r] = await this.execute(s, m, [intent], mark, null);
        if (!r?.paperFill || !(r.paperFill.qty > 0)) break;
      }
    }
  }

  /**
   * After a restart: what the leader did while no copier ran. Every market where the saved
   * leader position differs from the leader's position now is planned as a 'reconcile' event,
   * as a missed print is while running - except a position opened meanwhile, which is
   * pre-existing (joined only with "copy existing"), as when a copy starts.
   */
  private catchUp(subId: string): void {
    const s = this.subs.get(subId);
    if (!s || s.status === 'stopped') return;
    const l = s.settings.leader;
    if (!this.leaders.seeded(l)) {
      this.awaitingSeed.add(subId);
      return;
    }
    const st = this.stateOf(s);
    const now = Date.now();
    const current = this.leaders.positions(l);
    for (const sym of new Set([...Object.keys(st.leaderPos), ...Object.keys(current)])) {
      const before = st.leaderPos[sym] ?? 0;
      const after = current[sym] ?? 0;
      if (Math.abs(before - after) <= 1e-9 * Math.max(1, Math.abs(before), Math.abs(after))) continue;
      if (before === 0 && !s.settings.copyExisting) {
        st.leaderPos[sym] = after;
        st.detached[sym] = 'pre-existing';
        this.dirty.add(s.id);
        continue;
      }
      const price = this.priceFor(l.venue, sym) ?? 0;
      this.dispatch(s, { leader: l, symbol: sym, before, after, price, time: now, id: `restart:${sym}:${now}`, source: 'reconcile' });
    }
  }

  /** SoDEX symbol -> signed size of this copy's orders sent but not booked yet. */
  private inFlightOf(subId: string): Record<string, number> {
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const p of this.pending) {
      if (p.subId !== subId || p.until <= now || !(p.remaining > 1e-12)) continue;
      out[p.symbol] = (out[p.symbol] ?? 0) + (p.side === 'buy' ? p.remaining : -p.remaining);
    }
    return out;
  }

  /* -------------------------------------------------- SoDEX position stops ----- */

  private scheduleStops(s: Subscription, symbol: string): void {
    if (s.settings.paper || (s.settings.stopLossPct === null && s.settings.takeProfitPct === null)) return;
    const k = `${s.id}|${symbol}`;
    timers.cancel(this.stopTimers.get(k));
    this.stopTimers.set(
      k,
      timers.after(2_000, () => {
        this.stopTimers.delete(k);
        this.enqueue(s.owner, () => this.refreshStops(s.id, symbol));
      }),
    );
  }

  /** Keep one SoDEX stop-loss (and take-profit) per copied position, sized to it. */
  private async refreshStops(subId: string, symbol: string): Promise<void> {
    const s = this.subs.get(subId);
    if (!s || s.status === 'stopped') return;
    const st = this.stateOf(s);
    const sink = this.host.sinkFor(s);
    const m = this.markets.get(symbol);
    if (!sink || sink.paper || !m) return;
    const p = st.owned[symbol];
    const cur = st.stops[symbol];
    if (p && cur && Math.abs(cur.size - p.size) < 1e-12) return;
    if (cur) {
      for (const id of [cur.sl, cur.tp]) if (id) await sink.cancel(s.accountId, m, id).catch((e) => this.host.log.warn('copy: stop not cancelled', { id, error: String(e) }));
      delete st.stops[symbol];
    }
    if (!p) return;
    const q = floorQuantity(p.size, m);
    if (q === '0') return;
    const lev = effectiveLeverage(s.settings.maxLeverage, this.host.policyFor(s), m.maxLeverage);
    const builder = await this.host.builderFor(s).catch(() => null);
    const next = { sl: null as string | null, tp: null as string | null, size: p.size, at: Date.now() };
    for (const kind of ['stop-loss', 'take-profit'] as const) {
      const trigger = guardTrigger(kind, p, s.settings, lev);
      if (trigger === null) continue;
      const clOrdID = `vds-${bytesToHex(keccak256(utf8(`${s.id}|${symbol}|${kind}|${p.size}|${next.at}`))).slice(2, 26)}`;
      const r = await sink.placeStop(s.accountId, m, { clOrdID, side: p.size > 0 ? 'sell' : 'buy', quantity: q, triggerPrice: snapPrice(trigger, m), kind }, builder);
      if (r.ok) next[kind === 'stop-loss' ? 'sl' : 'tp'] = clOrdID;
      else await this.activity(s, { kind: 'error', reason: `${kind}-not-placed`, symbol, detail: r.error });
    }
    st.stops[symbol] = next;
    this.dirty.add(s.id);
  }

  private cancelStops(s: Subscription, symbol: string): void {
    if (s.settings.paper || !this.stateOf(s).stops[symbol]) return;
    this.enqueue(s.owner, () => this.refreshStops(s.id, symbol));
  }

  /** Cancel the SoDEX stops the copier placed on the markets `which` picks. */
  private cancelStopsWhere(s: Subscription, which: (symbol: string) => boolean): void {
    for (const sym of Object.keys(this.stateOf(s).stops)) {
      if (!which(sym)) continue;
      this.enqueue(s.owner, async () => {
        const st = this.stateOf(s);
        const cur = st.stops[sym];
        const sink = this.host.sinkFor(s);
        const m = this.markets.get(sym);
        if (!cur || !sink || !m) return;
        for (const id of [cur.sl, cur.tp]) if (id) await sink.cancel(s.accountId, m, id).catch(() => {});
        delete st.stops[sym];
        this.dirty.add(s.id);
      });
    }
  }

  /* ----------------------------------------------------------- readiness ----- */

  /** A live copy needs its key registered and a builder approval covering the copy fee. */
  async checkReady(s0: Subscription): Promise<void> {
    const s = this.subs.get(s0.id);
    if (!s || s.settings.paper || s.status === 'stopped' || s.status === 'paused' || s.status === 'halted') return;
    // The region (and the approval mode) first, without SoDEX: a failed read must never leave a
    // follower from a blocked region active.
    let problem: string | null = this.localProblem(s);
    if (!problem) {
      try {
        problem = (await this.host.keyProblem?.(s)) ?? null;
        if (!problem) {
          const builder = await this.host.builderFor(s);
          if (builder) {
            const approved = await this.host.sodex.builderApproval(s.owner, Number(builder.id));
            if (approved === null || approved < builder.fee) {
              problem = `Your SoDEX account does not approve the ValueDesk copy fee (${builder.fee / 10} bp). Approve it in copy setup.`;
            }
          }
        }
      } catch (e) {
        this.host.log.warn('copy: readiness check failed', { sub: s.id, error: String(e) });
        return;
      }
    }
    // The copy may have been stopped, paused or removed while SoDEX answered: then there is nothing to set.
    // (This runs unawaited - `void checkReady` - so a throw here would be an unhandled rejection.)
    const cur = this.subs.get(s.id);
    if (!cur || cur.status === 'stopped' || cur.status === 'paused' || cur.status === 'halted') return;
    try {
      if (problem && (cur.status !== 'blocked' || cur.statusReason !== problem)) await this.setStatus(cur.id, 'blocked', problem);
      else if (!problem && cur.status === 'blocked') await this.setStatus(cur.id, 'active', null);
    } catch (e) {
      this.host.log.warn('copy: readiness status not set', { sub: cur.id, error: String(e) });
    }
  }

  /** Why this copier may not trade a copy, known without asking SoDEX: the region, or "ask me each time" with nobody to ask. */
  private localProblem(s: Subscription): string | null {
    const policy = this.host.policyFor(s);
    if (!policy.allowed) return policy.reason ?? 'Copy trading is not available in your region.';
    if (s.settings.approval === 'confirm' && !this.host.confirm) return CONFIRM_UNAVAILABLE;
    return null;
  }

  /**
   * Block a copy for a local problem. A paper copy blocked by one resumes once it is gone
   * (a live one through checkReady, which also checks its key and fee approval).
   */
  private async applyLocalRules(id: string): Promise<void> {
    const s = this.subs.get(id);
    if (!s || s.status === 'stopped' || s.status === 'paused' || s.status === 'halted') return;
    const problem = this.localProblem(s);
    if (problem) {
      if (s.status !== 'blocked' || s.statusReason !== problem) await this.setStatus(id, 'blocked', problem);
    } else if (s.status === 'blocked' && !this.live(s)) await this.setStatus(id, 'active', null);
  }

  /* ------------------------------------------------------------- leaders ----- */

  private followedLeaders(): LeaderRef[] {
    const seen = new Map<string, LeaderRef>();
    for (const s of this.subs.values()) if (s.status !== 'stopped') seen.set(lk(s.settings.leader), s.settings.leader);
    return [...seen.values()];
  }

  /** Point the feeds at the followed leaders (and start Hyperliquid's when one is needed). */
  private async syncFeeds(): Promise<void> {
    const leaders = this.followedLeaders();
    const sodex: Array<{ ref: LeaderRef; accountId: number }> = [];
    for (const l of leaders.filter((x) => x.venue === 'sodex')) {
      let id = this.sodexIds.get(l.address);
      if (id === undefined) {
        id = await this.host.sodex.accountId(l.address).catch(() => 0);
        if (id) this.sodexIds.set(l.address, id);
      }
      sodex.push({ ref: l, accountId: id });
    }
    this.sodexFeed?.setLeaders(sodex);
    const hl = leaders.filter((x) => x.venue === 'hyperliquid');
    if (hl.length && !this.hlFeed && this.running) {
      this.hlFeed = new HyperliquidFeed({
        factory: this.host.factory,
        book: this.leaders,
        mode: this.host.hlMode,
        coins: () => this.hlCoins,
        log: this.host.log,
        sink: {
          leader: (e) => this.onLeaderEvent(e),
          state: (_f, up) => {
            this.feedUp.hyperliquid = up;
            if (up) void this.reconcileAll();
          },
        },
      });
      this.hlFeed.start();
      if (this.host.hlMode === 'firehose') void this.refreshHlCoins();
    }
    this.hlFeed?.setLeaders(hl);
    for (const l of leaders) if (!this.leaders.seeded(l)) await this.seedLeader(l);
  }

  /** Firehose mode: read the coin list, subscribe what is new, and plan the next read. */
  private async refreshHlCoins(): Promise<void> {
    timers.cancel(this.hlCoinsTimer);
    this.hlCoinsTimer = null;
    const ok = await this.loadHlCoins();
    if (!this.running) return;
    this.hlFeed?.refreshCoins();
    const ms = ok ? HL_COINS_REFRESH_MS : this.hlCoinsRetry;
    this.hlCoinsRetry = ok ? HL_COINS_RETRY_MS : Math.min(this.hlCoinsRetry * 2, HL_COINS_REFRESH_MS);
    this.hlCoinsTimer = timers.after(ms, () => void this.refreshHlCoins());
  }

  /**
   * Firehose mode: the coins whose `trades` the feed follows - every live perp of
   * Hyperliquid's main dex and of every HIP-3 dex (perpDexs, then meta per dex; trade.xyz
   * is 'xyz'), those that map to a SoDEX market first, at most HL_MAX_COINS. A dex whose
   * read fails keeps the coins it had. True when every read answered and the list is not empty.
   */
  private async loadHlCoins(): Promise<boolean> {
    const hl = this.host.hyperliquid;
    let ok = true;
    let dexes: string[];
    try {
      dexes = ['', ...(await hl.perpDexs())];
      for (const d of [...this.hlCoinsByDex.keys()]) if (!dexes.includes(d)) this.hlCoinsByDex.delete(d);
    } catch (e) {
      ok = false;
      dexes = [...new Set([...HL_DEXES, ...this.hlCoinsByDex.keys()])];
      this.host.log.warn('copy: hyperliquid dex list failed', { error: String(e) });
    }
    await Promise.all(
      dexes.map(async (dex) => {
        try {
          this.hlCoinsByDex.set(dex, await hl.perpCoins(dex));
        } catch (e) {
          ok = false;
          this.host.log.warn('copy: hyperliquid coin list failed', { dex: dex || 'main', error: String(e) });
        }
      }),
    );
    const all = [...new Set([...this.hlCoinsByDex.values()].flat())];
    const listed = (c: string) => this.markets.sodexMarketFor('hyperliquid', c) !== null;
    const coins = [...all.filter(listed), ...all.filter((c) => !listed(c))];
    if (coins.length > HL_MAX_COINS) {
      this.host.log.warn('copy: more Hyperliquid coins than one IP may follow; coins SoDEX does not list are left out first', { coins: coins.length, limit: HL_MAX_COINS });
    }
    this.hlCoins = coins.slice(0, HL_MAX_COINS);
    if (!this.hlCoins.length) {
      this.host.log.error('copy: the Hyperliquid coin list is empty; Hyperliquid leaders move only by reconciliation until it loads', { reconcileMs: RECONCILE_MS });
    }
    return ok && this.hlCoins.length > 0;
  }

  private async readLeader(l: LeaderRef): Promise<LeaderRead> {
    return l.venue === 'sodex' ? this.host.sodex.leaderPositions(l.address) : this.host.hyperliquid.leaderPositions(l.address, this.hlDexesFor(l));
  }

  /**
   * The Hyperliquid dexes to read for a leader: the main dex and trade.xyz (HL_DEXES), and
   * any other HIP-3 dex where the leader (as the books have it) or one of its copies holds
   * a market SoDEX lists - so a position the stream learned there is reconciled, not left.
   */
  private hlDexesFor(l: LeaderRef): string[] {
    const out = new Set(HL_DEXES);
    const symbols = new Set(Object.keys(this.leaders.positions(l)));
    for (const s of this.subs.values()) {
      if (lk(s.settings.leader) === lk(l)) for (const sym of Object.keys(this.states.get(s.id)?.leaderPos ?? {})) symbols.add(sym);
    }
    for (const sym of symbols) {
      const dex = hlDexOf(sym);
      if (dex && !out.has(dex) && this.markets.sodexMarketFor('hyperliquid', sym)) out.add(dex);
    }
    return [...out];
  }

  private async seedLeader(l: LeaderRef): Promise<void> {
    if (this.leaders.seeded(l)) return;
    try {
      this.resyncLeader(l, await this.readLeader(l));
    } catch (e) {
      this.host.log.warn('copy: leader read failed', { leader: lk(l), error: String(e) });
    }
  }

  /**
   * A leader read into the books: its 'reconcile' events (none when it seeds), or null when
   * it could not seed (a dex it asked for failed). Seeded, the copies that waited for it
   * (awaitingSeed) are caught up: what the leader holds now is pre-existing to a new one.
   */
  private resyncLeader(l: LeaderRef, r: LeaderRead, readStart?: number): LeaderEvent[] | null {
    const wasSeeded = this.leaders.seeded(l);
    // Hyperliquid's marks of the positions read: what the same-asset check compares.
    const readAt = Date.now();
    for (const [sym, price] of Object.entries(r.marks)) this.markets.observeLeaderPrice(l.venue, sym, price, readAt);
    const events = this.leaders.resync(l, r, Date.now(), (sym) => this.priceFor(l.venue, sym), readStart);
    if (events === null) {
      this.host.log.warn('copy: leader not seeded: a Hyperliquid dex could not be read', { leader: lk(l), read: r.dexes ?? null });
      return null;
    }
    if (!wasSeeded) {
      for (const id of [...this.awaitingSeed]) {
        const s = this.subs.get(id);
        if (!s) this.awaitingSeed.delete(id);
        else if (lk(s.settings.leader) === lk(l)) {
          this.awaitingSeed.delete(id);
          this.catchUp(id);
        }
      }
    }
    return events;
  }

  private reconciling = false;

  /** Re-read every followed leader: what the stream missed becomes a 'reconcile' event. */
  async reconcileAll(): Promise<void> {
    if (this.reconciling || !this.running) return;
    this.reconciling = true;
    try {
      for (const l of this.followedLeaders()) {
        try {
          // The answer is as old as the read's start: markets the stream changed since are left to it.
          const readStart = Date.now();
          const events = this.resyncLeader(l, await this.readLeader(l), readStart);
          if (events === null) continue;
          const eq = this.leaders.equity(l);
          for (const s of this.list()) {
            if (lk(s.settings.leader) !== lk(l)) continue;
            const st = this.stateOf(s);
            if (eq) {
              st.leaderEquity = eq.value;
              st.leaderEquityAt = eq.at;
            }
            st.lastReconcileAt = Date.now();
            this.dirty.add(s.id);
          }
          for (const e of events) this.onLeaderEvent(e);
          this.recheckAssets(l);
          // Then what a copy still holds where the leader is flat or on the other side.
          for (const s of this.list()) if (lk(s.settings.leader) === lk(l) && s.status !== 'stopped') this.enqueue(s.owner, () => this.closeStrays(s.id));
        } catch (e) {
          this.host.log.warn('copy: reconcile read failed', { leader: lk(l), error: String(e) });
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  /** A price for a leader market: the SoDEX mark of the market it maps to. */
  private priceFor(venue: LeaderRef['venue'], leaderSymbol: string): number | null {
    const m = this.markets.sodexMarketFor(venue, leaderSymbol);
    return m ? this.markets.mark(m.name, 10 * 60_000) : null;
  }

  private async loadMarkets(): Promise<void> {
    try {
      const list = await this.host.sodex.markets();
      if (list.length) this.markets.load(list);
      for (const p of await this.host.sodex.markPrices()) this.markets.setMark(p.symbol, p.price);
    } catch (e) {
      this.host.log.warn('copy: market list failed', { error: String(e) });
    }
    // A copied position on a market that left the list: the follower hears of it once.
    await this.noteDelisted().catch((e) => this.host.log.warn('copy: delisting check failed', { error: String(e) }));
  }

  /* ---------------------------------------------------------------- books ----- */

  private stateOf(s: Subscription): SubState {
    let st = this.states.get(s.id);
    if (!st) this.states.set(s.id, (st = freshState(s.id, s.settings.allocationUsd)));
    return st;
  }

  private live(s: Subscription): boolean {
    return !s.settings.paper;
  }

  private need(id: string): Subscription {
    const s = this.subs.get(id);
    if (!s) throw new Error('No such copy.');
    return s;
  }

  private async flush(): Promise<void> {
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const st = this.states.get(id);
      if (st) await this.host.store.saveState(st).catch((e) => this.host.log.error('copy: state not saved', { sub: id, error: String(e) }));
      this.host.onChange?.(id);
    }
  }

  /** The follower hears of it (notices.ts); a host that throws never stops the copy. */
  private notice(n: EngineNotice | null): void {
    if (!n) return;
    try {
      this.host.onNotice?.(n);
    } catch (e) {
      this.host.log.warn('copy: notice not taken', { error: String(e) });
    }
  }

  private async activity(s: Subscription, e: Partial<ActivityEntry> & Pick<ActivityEntry, 'kind' | 'reason'>): Promise<void> {
    const entry: ActivityEntry = {
      id: randomId('a'),
      subId: s.id,
      owner: s.owner,
      at: Date.now(),
      detail: null,
      symbol: null,
      side: null,
      size: null,
      price: null,
      notionalUsd: null,
      reduceOnly: null,
      clOrdID: null,
      orderId: null,
      builderFee: null,
      leader: null,
      paper: s.settings.paper,
      ...e,
    };
    await this.host.store.addActivity(entry).catch((err) => this.host.log.error('copy: activity not saved', { error: String(err) }));
    this.host.onChange?.(s.id);
  }
}
