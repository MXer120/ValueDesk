/**
 * The algo runtime: one per runner (a browser tab, the hosted executor, a
 * self-hosted executor), working every algo of every wallet it serves.
 *
 * THE LOOP. Twice a second every live algo takes one step: it reads the
 * book, its bounds and guards, works out what should be working on SoDEX now
 * (a taker child for what is overdue, one resting child for what is due, a
 * ladder, a wave of clips...), and sends at most one request to get there.
 * An algo is never stepped while its previous step is still in flight.
 *
 * THE BOOKS FOLLOW SODEX. A child counts as filled only by SoDEX's own order
 * updates (cumulative per client order id, on the socket); a write without an
 * answer is never re-sent: the child is `unknown` until SoDEX's open orders
 * (or, sparingly, its order history) say what became of it. Nothing is ever
 * sent that could take the algo past its size: whatever might still fill
 * (sending, open, unknown, cancelling) counts as filled until it is settled.
 *
 * PAPER. A paper algo runs the same steps against the live book and tape;
 * its children are filled here (takers at the touch, resting orders when
 * the tape trades through them), and nothing is signed or sent.
 */
import { canonicalDecimal, numberToPlainString, type Network } from '../../../sodex-core/src/index.ts';
import { CONFIRM_READS, CONFIRM_GAP_MS, confirmRead, sizeView } from '../confirm.ts';
import { randomId, sleep, timers, type Logger, type WebSocketFactory } from '../io.ts';
import { MarketBook, notListedLine, snapPrice } from '../markets.ts';
import type { RegionPolicy } from '../policy.ts';
import type { SodexClient } from '../sodex.ts';
import type { MarketInfo } from '../types.ts';
import { AlgoFeed, type AlgoMarket, type OrderUpdate, type Print } from './feed.ts';
import {
  DAY_MS,
  adaptiveShare,
  dueShare,
  floorStep,
  jitter,
  makeRng,
  makerPrice,
  maxOrderQty,
  mid,
  minChildQty,
  newSeed,
  nextSlice,
  povDue,
  profileCandles,
  snapDown,
  snapNearest,
  snapUp,
  spreadBps,
  takerPrice,
  trail,
  volumeProfile,
  type Candle,
  type Quote,
  type TrailState,
} from './math.ts';
import { combineOracle, type OracleVenue, type VenueQuote } from '../oracle.ts';
import { algoClosedNotice, algoNotice, type EngineNotice } from '../notices.ts';
import { SWEEP_MAX_AGE_MS, sweepRefFor, sweepStep } from './sweep.ts';
import { bandRefused, exitLevels, scaleLadder, swarmClips, twapSchedule, vwapSchedule } from './plan.ts';
import { checkLimits, limitLeverage, oiHeadroom, oiRoomWords, positionCapUsd, limitRefusal, type AlgoLimitNotice, type LimitRefusal } from './limits.ts';
import { checkSizes, coins, maxWords, minWords, money } from './sizes.ts';
import type { AlgoSink, ChildRequest, ChildResult, StopRequest } from './sink.ts';
import { ALGO_NAMES, algoClosesOnly, algoQuantity, algoSymbols, opensPosition, parseAlgoSpec } from './spec.ts';
import type { AlgoStore } from './store.ts';
import type { AlgoUpdatePatch } from '../api.ts';
import { bookFill, bookGross, bookInventory, bookNet, bookVolume, costPerMillion, emptyBook, gridAfterFill, gridPrices, gridQty, gridStart, mmQuotes, pastFair, sampleBook, type GridSide } from './bots.ts';
import { FairBasis, REF_MAX_AGE_MS, type ReferenceSource } from './reference.ts';
import {
  FINAL_STATUSES,
  SLIP_FROM_NAMES,
  type AlgoEvent,
  type AlgoEventKind,
  type AlgoRecord,
  type AlgoSpec,
  type AlgoStatus,
  type AlgoView,
  type BotView,
  type ChildOrder,
  type ChildTif,
  type Condition,
  type ExecSpec,
  type Side,
} from './types.ts';

export const ALGO_TICK_MS = 500;
const FLUSH_MS = 2_000;
const MARKETS_REFRESH_MS = 10 * 60_000;
/** On stop, how long a step that is placing or cancelling an order is waited for. */
const STOP_DRAIN_MS = 8_000;
/** An IOC with no final update after this is looked up on SoDEX. */
const STALE_IOC_MS = 8_000;
/** A request with no answer after this is `unknown`. */
const SENDING_MAX_MS = 20_000;
/** At most one order-history read per this (SoDEX's history is drip-limited per IP). */
const HISTORY_EVERY_MS = 20_000;
/**
 * A child SoDEX lists nowhere (open orders, order history) is cancelled by its client id once it
 * was placed this long ago (sooner, the reads are most likely only behind)...
 */
const UNLISTED_CANCEL_MS = 120_000;
/**
 * ...and settled for what SoDEX's trades show it filled only this long after SoDEX took that
 * cancel, when CONFIRM_READS more trades reads agree (settleUnlisted). SoDEX answered with
 * accounts 10-17 min old on 2026-10-29: a read this long after the cancel shows every fill the
 * order can ever have. Until then it counts as live in full (pendingQty): nothing is sent in its place.
 */
const UNLISTED_SETTLE_MS = 20 * 60_000;
/** The trades read for unlisted children: a full page may have left fills out, so it confirms nothing. */
const FILLS_PAGE = 100;
const DONE_KEPT = 60;
const MAX_CONSEC_REJECTS = 25;
/** A refusal by SoDEX's open-interest cap, position limit or open-order cap holds the algo this long (doubling, at most 15 min)... */
const LIMIT_RETRY_MS = 60_000;
/** ...and stops it at the this-many-th with no fill in between: no retry storm against a limit. */
const LIMIT_MAX_HITS = 4;
/** A limit hold keeps its words (and a limit notice is not repeated) for this long. */
const LIMIT_WORDS_MS = 10 * 60_000;
const PROBLEM_RECHECK_MS = 60_000;
/** pollOrders: at most one REST read of open orders this often for the whole runtime (60 a minute, a fraction of the per-IP budget)... */
const ORDER_POLL_SPACING_MS = 1_000;
/** ...each algo at most this often... */
const ORDER_POLL_MIN_MS = 3_000;
/** ...and the socket's places are given out again (by what each wallet has on the book) this often. */
const ORDER_WATCH_EVERY_MS = 30_000;
/** POV and DCA hybrids: due quantity older than this is taken. */
const LATE_MS = 30_000;
/** After a taker child that filled nothing, the next one waits this long. */
const TAKER_RETRY_MS = 1_000;

/** One DCA installment (k.inst): its number, its own size and due time, what its settled children filled (each counted once). */
interface DcaInstallment {
  n: number;
  qty: number;
  at: number;
  filled: number;
  counted: string[];
}
/** Positions are read again after this (position conditions). */
const POSITIONS_MS = 5_000;
/** The account (equity, gross exposure) is read again after this (the region's leverage ceiling). */
const ACCOUNT_MS = 10_000;
/** While an entry is filling, its exits are resized at most this often. */
const EXITS_RESIZE_MS = 5_000;
/** An ended algo's exits are held against its position this often (one positions read per wallet, weight 5): gone, closed outside it, they are cancelled (watchExits). */
const EXITS_WATCH_MS = 60_000;
/** A position read counts for that only when it started this long after the exits were placed (SoDEX's account follows the fills). */
const EXITS_SETTLE_MS = 3_000;
/** The fills that cut an ended algo's position are read from this long before its exits were placed (the clocks differ). */
const EXITS_FILLS_SLACK_MS = 30_000;
/**
 * A position that reads agree is gone, with no fill in SoDEX's trades that cut it, has its exits
 * cancelled only after this: the trades lag the matching by tens of seconds, and a backend that
 * missed the opening fills reads the account flat while it holds the position (confirm.ts).
 */
const EXITS_NO_FILL_MS = 15 * 60_000;
/** After SoDEX's reads of a position disagreed, an algo reads it again for a decision no sooner than this. */
const CONFIRM_RETRY_MS = 15_000;

export interface AlgoHost {
  store: AlgoStore;
  sodex: SodexClient;
  network: Network;
  /** For the default feed. */
  factory?: WebSocketFactory;
  /** Market data and order updates (default: an AlgoFeed on `factory`). */
  market?: AlgoMarket;
  /** The live sink for an algo, or null when its key is not available here. */
  sinkFor(a: AlgoRecord): AlgoSink | null;
  /** The builder fee on this algo's orders, as a fraction of the notional (for the fee estimate). */
  builderRate?(a: AlgoRecord): number;
  /** Why a live algo cannot trade right now (key, region, approval), or null. It waits while there is one. */
  problem?(a: AlgoRecord): Promise<string | null>;
  /**
   * The operator's emergency brake: while it returns a reason, a live algo is
   * held - nothing new is sent (asked on every step and before every send, so it
   * bites at once). Its exits (take-profit, stop-loss) are still placed and kept:
   * they only ever reduce a position. Released, it goes on by itself.
   */
  brake?(a: AlgoRecord): string | null;
  /** The owner's signed position on `symbol` (default: read from SoDEX). */
  position?(a: AlgoRecord, symbol: string): Promise<number | null>;
  /** The owner's positions: signed size and entry per market (default: read from SoDEX). Position conditions read these. */
  positions?(a: AlgoRecord): Promise<Record<string, { size: number; entry: number; leverage?: number }>>;
  /** The pause between reads of SoDEX that confirm a position (confirm.ts CONFIRM_GAP_MS; tests pass 0). */
  confirmGapMs?: number;
  /**
   * The region rules for a live algo (policy.ts regionPolicy): a blocked
   * region holds it; a leverage ceiling (EEA 2x) caps the leverage it sets and
   * the account's gross exposure its opening children may reach. null = none.
   */
  policyFor?(a: AlgoRecord): RegionPolicy | null;
  /** Equity and gross notional of the owner's account (default: read from SoDEX), for the leverage ceiling. */
  account?(a: AlgoRecord): Promise<{ equity: number; gross: number }>;
  /** Volume candles (default: SoDEX REST). */
  candles?(symbol: string, interval: string, startTime: number, endTime: number): Promise<Candle[]>;
  /** Order lookups (default: SoDEX REST). `history` reads are drip-limited; the runtime asks rarely. */
  lookup?(a: AlgoRecord, symbol: string, history: boolean): Promise<Array<{ clOrdID: string; orderId: string; status: string; executedQty: number; executedValue: number }>>;
  /**
   * A sweep's outside reference: every oracle venue's quote for the coin
   * ('BTC') - oracle.ts, read through OracleFeed on an executor and through
   * the API's GET /api/vs/oracle in a browser. The sweep combines the venues
   * its spec chose. Absent, or failing: it falls back to SoDEX's own mark
   * while that is fresh.
   */
  oracle?(coin: string, venues?: readonly OracleVenue[]): Promise<VenueQuote[]>;
  /**
   * The Binance-led maker's reference (MmSpec.ref; reference.ts): on an executor the box's shared Binance feed.
   * Absent: such a maker holds.
   */
  reference?: ReferenceSource;
  log: Logger;
  onChange?(id: string): void;
  /** An algo failed, ended, finished, or was stopped or held without the follower asking (notices.ts): the bell, the inbox. */
  onNotice?(n: EngineNotice): void;
  /** false: no timers (tests drive `tick`). */
  autoTick?: boolean;
}

export interface NewAlgo {
  owner: string;
  accountId: number;
  mode: AlgoRecord['mode'];
  spec: unknown;
  consent?: AlgoRecord['consent'];
  parentId?: string | null;
  seed?: number;
  id?: string;
  country?: string | null;
  observedCountry?: string | null;
}

const LIVE: ReadonlySet<ChildOrder['state']> = new Set(['sending', 'open', 'unknown']);
const FINAL_ORDER = /^(FILLED|CANCELED|CANCELLED|REJECTED|EXPIRED|REPLACED)$/;

/** A ladder child's level (0-based, from its tag 'level 3/10'), or -1. */
const levelOf = (c: Pick<ChildOrder, 'tag'>): number => {
  const x = /^level (\d+)\//.exec(c.tag);
  return x ? Number(x[1]) - 1 : -1;
};

/** How long a sweep waits for the oracle's first answer before it takes SoDEX's mark as the fallback. */
const ORACLE_FIRST_WAIT_MS = 3_000;

/** A refused exit is tried again after this, doubling each time, and given up after EXITS_MAX_REFUSALS. */
const EXITS_RETRY_MS = 30_000;
const EXITS_MAX_REFUSALS = 5;

/** What update() may change on a running algo. */
const UPDATABLE: ReadonlySet<string> = new Set(['limitPrice', 'upper', 'lower', 'maxSpreadBps', 'label', 'quantity']);
/** ...and on a running bot (its market, range and levels are what it is: a different one is a new bot). */
const BOT_UPDATABLE: Readonly<Record<'mm' | 'grid', ReadonlySet<string>>> = {
  mm: new Set(['label', 'maxSpreadBps', 'upper', 'lower', 'orderUsd', 'maxInventoryUsd', 'offsetTicks', 'chaseTicks', 'minRepriceMs', 'skewTicks', 'edgeBps', 'queueGuard', 'levels', 'moveGuard', 'refBps', 'pullBps', 'volumeTargetUsd', 'maxLossUsd', 'endAt', 'onStop']),
  grid: new Set(['label', 'maxSpreadBps', 'upper', 'lower', 'orderUsd', 'volumeTargetUsd', 'maxLossUsd', 'endAt', 'onStop', 'outOfRange']),
};
/** A bot closing what it holds rests at the touch this long before it takes... */
const BOT_CLOSE_REST_MS = 60_000;
/** ...and then takes with at most this slippage. */
const BOT_CLOSE_SLIP_BPS = 30;
/** A grid level SoDEX refused (a post-only that would take) is tried again no sooner than this. */
const GRID_RETRY_MS = 3_000;
/** A volume maker side SoDEX refused waits this long first (doubling to a minute while it keeps being refused). */
const MM_RETRY_MS = 500;

/** A grid child's level (0-based, from its tag 'grid 3/10'), or -1. */
const gridLevelOf = (c: Pick<ChildOrder, 'tag'>): number => {
  const x = /^grid (\d+)\//.exec(c.tag);
  return x ? Number(x[1]) - 1 : -1;
};

/** A bot that is stopping: how it ends once what it holds is closed. */
interface BotClosing {
  status: AlgoStatus;
  reason: string;
  at: number;
  rejects?: number;
}

const dec = (n: number): string => canonicalDecimal(numberToPlainString(Number(n.toPrecision(12))));

/** A price on the tick: as it is when it is on it (float dust aside), else rounded the trader's way (a buy down, a sell up). */
function onTick(p: number, side: Side, tickSize: string): number {
  const k = p / Number(tickSize);
  if (Math.abs(k - Math.round(k)) < 1e-6) return snapNearest(p, tickSize);
  return side === 'buy' ? snapDown(p, tickSize) || Number(tickSize) : snapUp(p, tickSize);
}

interface PaperOrder {
  algoId: string;
  clOrdID: string;
  symbol: string;
  side: Side;
  price: number;
  left: number;
  filled: number;
  value: number;
}

export class AlgoRuntime {
  readonly markets = new MarketBook();
  readonly market: AlgoMarket;
  private algos = new Map<string, AlgoRecord>();
  private byClOrd = new Map<string, string>();
  private busy = new Set<string>();
  private dirty = new Set<string>();
  /** The leverage and margin mode last sent per owner and market: an algo asking for others sends them again. */
  private leverageSet = new Map<string, string>();
  private problems = new Map<string, { at: number; problem: string | null; unchecked?: boolean }>();
  private lastHistoryAt = 0;
  /** The next history turn reads SoDEX's trades for unlisted children instead (never both in one burst: docs/ARCH-traffic.md). */
  private tradesTurn = false;
  private lookupBusy = false;
  /** pollOrders' state: a read in flight, when the last one left, when each algo was read, the algos to read whatever the socket follows (it was down). */
  private polling = false;
  private lastPollAt = 0;
  private watchedAt = 0;
  private polledAt = new Map<string, number>();
  private resync = new Set<string>();
  private socketWasUp = false;
  /** Algos that raised a hold in the step now running (steps of one algo never overlap). */
  private heldNow = new Set<string>();
  private eventSeq = 0;
  /** Each owner's positions and account, read at most every few seconds (conditions, closes, the leverage ceiling); `from`: when that read left. */
  private positionsOf = new Map<string, { at: number; from?: number; data: Record<string, { size: number; entry: number; leverage?: number }>; loading: boolean }>();
  private accounts = new Map<string, { at: number; equity: number; gross: number }>();
  /** Algos whose exits are being placed or resized right now. */
  private exitsBusy = new Set<string>();
  /** Algos whose final exits were asked for while a placement was out: placed again once it is back. */
  private exitsAgain = new Set<string>();
  /** Ended algos whose exits are being held against the position right now, when each was last, and when its position was last found held (watchExits). */
  private exitsWatching = new Set<string>();
  private exitsWatchAt = new Map<string, number>();
  private exitsHeldAt = new Map<string, number>();
  /** Ended algos whose position reads agree is gone while SoDEX's trades show no fill that cut it: since when (exitsGone). */
  private exitsFlatSince = new Map<string, number>();
  /** Algos whose position reads disagreed: not read again for a decision before this (positionConfirmed). */
  private confirmRetryAt = new Map<string, number>();
  private paper = new Map<string, PaperOrder>();
  private timers: unknown[] = [];
  private running = false;
  /** The sweep oracle's last quotes per coin, and the read in flight. */
  private oracleQuotes = new Map<string, { quotes: VenueQuote[]; at: number; busy: boolean; first: number }>();
  /** The Binance-led makers' basis per market (reference.ts). */
  private fairs = new Map<string, FairBasis>();

  constructor(private readonly host: AlgoHost) {
    if (host.market) this.market = host.market;
    else {
      if (!host.factory) throw new Error('an algo runtime needs a market feed or a WebSocket factory');
      this.market = new AlgoFeed({ network: host.network, factory: host.factory, log: host.log });
    }
    this.market.onOrder((u) => this.onOrderUpdate(u));
    this.market.onPrint((p) => this.onPrint(p));
    // Back after a drop: an order update sent meanwhile was lost, so every algo with an order on SoDEX is read once by REST (pollOrders).
    this.market.onState((up) => {
      if (up && this.socketWasUp) for (const a of this.algos.values()) if (!a.spec.paper && [...this.live(a), ...this.liveExits(a)].length) this.resync.add(a.id);
      if (up) this.socketWasUp = true;
    });
  }

  /* ------------------------------------------------------------ lifecycle ----- */

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.loadMarkets();
    for (const a of await this.host.store.algos()) {
      this.algos.set(a.id, a);
      // Exits outlive their algo: their fills still cancel the other one (OCO).
      for (const x of a.exitOrders ?? []) {
        this.byClOrd.set(x.clOrdID, a.id);
        if (x.state === 'sending') x.state = 'unknown';
      }
      if (FINAL_STATUSES.has(a.status)) {
        // A child it left resting on purpose (a conditional's limit, a chase left at its price) still fills: its fills still count and move its exits.
        for (const c of this.keptLive(a)) this.byClOrd.set(c.clOrdID, a.id);
        continue;
      }
      for (const c of a.children) {
        this.byClOrd.set(c.clOrdID, a.id);
        // What happened while nothing ran is not known: SoDEX is asked.
        if (LIVE.has(c.state) && !a.spec.paper) c.state = 'unknown';
        // A paper order rests nowhere but here: a resting one goes back on the simulated book, a taker is over.
        if (a.spec.paper && LIVE.has(c.state)) {
          if (c.tif !== 'ioc' && !c.cancelling) {
            c.state = 'open';
            this.paper.set(c.clOrdID, { algoId: a.id, clOrdID: c.clOrdID, symbol: a.spec.symbol, side: c.side, price: c.price, left: Math.max(0, c.quantity - c.filled), filled: c.filled, value: c.value });
          } else {
            c.state = 'done';
            c.cancelling = false;
          }
        }
      }
    }
    this.market.start();
    this.host.reference?.onQuote((market) => this.onReference(market));
    this.syncWatch();
    if (this.host.autoTick !== false) {
      this.timers.push(
        timers.every(ALGO_TICK_MS, () => this.tick()),
        timers.every(FLUSH_MS, () => void this.flush()),
        timers.every(MARKETS_REFRESH_MS, () => void this.loadMarkets()),
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) timers.cancel(t);
    this.timers = [];
    // A step may be placing or cancelling an order right now: let it finish and
    // record what it did, so the next start resumes from the truth (bounded: the
    // service manager stops waiting after 20 s).
    for (let i = 0; this.busy.size && i < STOP_DRAIN_MS / 25; i++) await new Promise((r) => timers.after(25, () => r(undefined)));
    this.market.stop();
    await this.flush();
  }

  private async loadMarkets(): Promise<void> {
    try {
      const list = await this.host.sodex.markets();
      if (list.length) this.markets.load(list);
    } catch (e) {
      this.host.log.warn('algo: market list failed', { error: String(e) });
    }
  }

  /** Subscribe the markets and wallets the live algos need. */
  private syncWatch(): void {
    const symbols = new Set<string>();
    // How much each wallet has on SoDEX's book: the socket's few places (feed.ts ACCOUNT_USERS_PER_IP) go to the most first.
    const weight = new Map<string, number>();
    for (const a of this.algos.values()) {
      const exits = this.liveExits(a).length > 0 || this.keptLive(a).length > 0;
      if (FINAL_STATUSES.has(a.status) && !exits) continue;
      for (const s of algoSymbols(a.spec)) symbols.add(s);
      if (a.spec.paper) continue;
      const live = this.live(a);
      const resting = live.filter((c) => c.tif !== 'ioc').length + this.liveExits(a).length;
      weight.set(a.owner, (weight.get(a.owner) ?? 0) + 1 + live.length * 10 + resting * 100);
    }
    const owners = [...weight.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([o]) => o);
    this.market.watch([...symbols], owners);
    if (this.host.reference) {
      const refs = new Set<string>();
      for (const a of this.algos.values()) if (!FINAL_STATUSES.has(a.status) && a.spec.kind === 'mm' && a.spec.ref) refs.add(a.spec.symbol);
      this.host.reference.watch([...refs]);
    }
  }

  /**
   * The fair price of a Binance-led maker's market now (reference.ts): the reference's mid times the basis, the basis
   * fed with this pair of mids. null: no reference here, none for this market, or older than REF_MAX_AGE_MS.
   */
  private fairFor(symbol: string, q: Quote, now: number): number | null {
    const r = this.host.reference?.quote(symbol);
    if (!r || now - r.at > REF_MAX_AGE_MS || !(r.bid > 0) || !(r.ask > 0)) return null;
    let b = this.fairs.get(symbol);
    if (!b) this.fairs.set(symbol, (b = new FairBasis()));
    const refMid = (r.bid + r.ask) / 2;
    b.update(mid(q), refMid, now);
    return b.fair(refMid);
  }

  /**
   * A reference tick (the fast pull): every running Binance-led maker on that market cancels at once a quote the fair
   * price came past its line (bots.ts pastFair) - before the next step, and before SoDEX's takers who watch Binance
   * reach it. Only cancels: new quotes go out with the steps.
   */
  private onReference(market: string): void {
    if (!this.running) return;
    const q = this.market.quote(market);
    const m = this.markets.get(market);
    if (!q || !m) return;
    const now = Date.now();
    let fair: number | null | undefined;
    for (const a of this.algos.values()) {
      const s = a.spec;
      if (s.kind !== 'mm' || !s.ref || s.symbol !== market || a.status !== 'running') continue;
      if (fair === undefined) fair = this.fairFor(market, q, now);
      if (fair === null) return;
      const inv = bookInventory(a.book!);
      const stale = this.live(a).filter((c) => c.state === 'open' && !c.cancelling && c.tif !== 'ioc' && pastFair(c.side, c.price, fair!, c.side === 'buy' ? inv >= 0 : inv <= 0, s.pullBps ?? 0));
      if (stale.length) void this.cancelChildren(a, m, stale).catch((e) => this.host.log.warn('algo: fast pull failed', { algo: a.id, error: String(e) }));
    }
  }

  /**
   * Orders of wallets the socket does not follow (SoDEX lets one IP follow 10;
   * feed.ts), read by REST instead - and every wallet's after the socket was
   * down: at most one read every ORDER_POLL_SPACING_MS for the whole runtime,
   * through the client's shared per-IP budget, the algo with resting orders
   * that was read longest ago first, each at most every ORDER_POLL_MIN_MS.
   * What SoDEX lists is booked as its order update would have been (by client
   * order id); a child no longer listed is asked of the order history
   * (settleStale), so no fill is lost.
   */
  async pollOrders(now = Date.now()): Promise<void> {
    if (this.polling || now - this.lastPollAt < ORDER_POLL_SPACING_MS) return;
    if (now - this.watchedAt >= ORDER_WATCH_EVERY_MS) {
      this.watchedAt = now;
      this.syncWatch();
    }
    const follows = this.market.followsOrders?.bind(this.market);
    const due = [...this.algos.values()].filter((a) => {
      if (a.spec.paper || this.busy.has(a.id)) return false;
      const open = [...this.live(a), ...this.liveExits(a)].filter((c) => c.state === 'open');
      if (!open.length) return false;
      if (!this.resync.has(a.id) && (!follows || follows(a.owner))) return false;
      return now - (this.polledAt.get(a.id) ?? 0) >= ORDER_POLL_MIN_MS;
    });
    if (!due.length) return;
    // An open-orders read weighs 5 (sodex-core weightFor): 60 a minute is a quarter of the per-IP budget. When the budget is
    // already half spent (copies, orders, closes), the poll waits - except a read after the socket dropped.
    const budget = (this.host.sodex as { budget?: { used(now?: number): number; perMinute: number } }).budget;
    if (budget && budget.used(now) > budget.perMinute * 0.5 && !due.some((a) => this.resync.has(a.id))) return;
    const resting = (a: AlgoRecord) => this.live(a).some((c) => c.tif !== 'ioc') || this.liveExits(a).length > 0;
    due.sort((x, y) => Number(this.resync.has(y.id)) - Number(this.resync.has(x.id)) || Number(resting(y)) - Number(resting(x)) || (this.polledAt.get(x.id) ?? 0) - (this.polledAt.get(y.id) ?? 0));
    const a = due[0]!;
    const m = this.markets.get(a.spec.symbol);
    if (!m) return;
    this.polling = true;
    this.lastPollAt = now;
    this.polledAt.set(a.id, now);
    try {
      const rows = await this.lookupOrders(a, m.name, false);
      this.resync.delete(a.id);
      const gone: ChildOrder[] = [];
      for (const c of [...this.live(a), ...this.liveExits(a)].filter((x) => x.state === 'open')) {
        const row = rows.find((r) => r.clOrdID === c.clOrdID);
        if (row) this.onOrderUpdate({ clOrdID: c.clOrdID, orderId: row.orderId || null, symbol: m.name, status: (row.status || 'NEW').toUpperCase(), filledQty: row.executedQty, filledValue: row.executedValue, maker: null, reason: null, at: now });
        else gone.push(c);
      }
      // Gone from the open orders: filled, cancelled or expired. A running algo asks the history on its next step (settleStale);
      // an ended one steps no more, so its kept order or exit is asked here.
      if (gone.length && !FINAL_STATUSES.has(a.status)) for (const c of gone) c.state = 'unknown';
      else if (gone.length) {
        const hist = await this.lookupOrders(a, m.name, true);
        for (const c of gone) {
          const row = hist.find((r) => r.clOrdID === c.clOrdID);
          if (row) this.onOrderUpdate({ clOrdID: c.clOrdID, orderId: row.orderId || null, symbol: m.name, status: FINAL_ORDER.test((row.status || '').toUpperCase()) ? row.status.toUpperCase() : 'FILLED', filledQty: row.executedQty, filledValue: row.executedValue, maker: null, reason: null, at: now });
        }
      }
      this.dirty.add(a.id);
    } catch (e) {
      this.host.log.warn('algo: order poll failed', { algo: a.id, error: String(e) });
    } finally {
      this.polling = false;
    }
  }

  /** Exits still on SoDEX (or on the paper book), not yet settled. */
  private liveExits(a: AlgoRecord): ChildOrder[] {
    return (a.exitOrders ?? []).filter((x) => LIVE.has(x.state));
  }

  /** Children an ended algo left on SoDEX on purpose (`end`'s keep), still live. */
  private keptLive(a: AlgoRecord): ChildOrder[] {
    const kept = (a.k.kept as string[] | undefined) ?? [];
    return kept.length ? a.children.filter((c) => kept.includes(c.clOrdID) && LIVE.has(c.state)) : [];
  }

  /** Paused or ended: nothing new may be sent for it. */
  private stopped(a: AlgoRecord): boolean {
    return FINAL_STATUSES.has(a.status) || a.status === 'paused';
  }

  /* ------------------------------------------------------------- the API ----- */

  get(id: string): AlgoRecord | null {
    return this.algos.get(id) ?? null;
  }

  list(owner?: string): AlgoRecord[] {
    const o = owner?.toLowerCase();
    return [...this.algos.values()].filter((a) => !o || a.owner === o).sort((x, y) => y.createdAt - x.createdAt);
  }

  /**
   * Start an algo. The spec is validated here as everywhere (parseAlgoSpec); every market it
   * names must be listed - its own, a basket's legs, a conditional's markets and the algo it
   * starts - or nothing starts (never on another market). A list that could not be read is
   * said as that, not as "not listed".
   */
  async add(n: NewAlgo): Promise<AlgoRecord> {
    const spec = parseAlgoSpec(n.spec);
    if (!this.markets.size) await this.loadMarkets();
    if (!this.markets.size) throw new Error("SoDEX's market list could not be read, so the market cannot be checked. Try again in a moment.");
    for (const sym of algoSymbols(spec)) {
      const m = this.markets.get(sym);
      if (!m) throw new Error(notListedLine(sym));
    }
    const m = this.markets.get(spec.symbol)!;
    if (m.status !== 'TRADING') throw new Error(`SoDEX is not trading ${m.name} right now.`);
    const now = Date.now();
    const a: AlgoRecord = {
      id: n.id ?? randomId('a'),
      owner: n.owner.toLowerCase(),
      accountId: n.accountId,
      mode: n.mode,
      spec,
      status: 'scheduled',
      statusReason: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      endedAt: null,
      parentId: n.parentId ?? null,
      consent: n.consent ?? null,
      seed: n.seed ?? newSeed(),
      filled: 0,
      filledValue: 0,
      makerQty: 0,
      fees: 0,
      arrival: null,
      marketQty: 0,
      marketValue: 0,
      children: [],
      childCount: 0,
      rejects: 0,
      exitOrders: [],
      country: n.country ?? null,
      observedCountry: n.observedCountry ?? null,
      k: {},
    };
    // Every child an order SoDEX takes, as the ticket said (sizes.ts): under its smallest or over its largest is refused, never merged or split.
    await this.startSizes(a);
    await this.startLimits(a);
    if (spec.triggerPrice !== null) {
      const mk = this.market.mark(spec.symbol)?.mark ?? null;
      if (mk !== null) a.k.triggerFrom = mk;
    }
    this.algos.set(a.id, a);
    await this.host.store.saveAlgo(a);
    this.syncWatch();
    const what = spec.kind === 'basket' ? `Basket of ${spec.legs.length} markets` : `${ALGO_NAMES[spec.kind]} ${spec.side === 'buy' ? 'buy' : 'sell'} on ${spec.symbol}`;
    await this.event(a, 'status', `${what} placed${spec.paper ? ' (paper: nothing is sent)' : ''}.`);
    this.host.onChange?.(a.id);
    return a;
  }

  /**
   * SoDEX's limits at the start (limits.ts), checked here - the authority, on
   * the executor as in a browser: a position over its limit at the leverage,
   * or a resting price outside its limit band, refuses the start. The
   * open-interest cap only warns on the ticket (it moves); the runtime holds
   * at it (fitLimits). Without a price or a position nothing is refused here.
   */
  private async startLimits(a: AlgoRecord): Promise<void> {
    const s = a.spec;
    if (s.reduceOnly) return;
    const legs: Array<{ symbol: string; side: Side; qty: number | null; usd: number | null }> =
      s.kind === 'basket' ? s.legs.map((l) => ({ symbol: l.symbol, side: l.side, qty: null, usd: l.usd }))
      : !opensPosition(s) ? []
      : [{ symbol: s.symbol, side: s.side, qty: algoQuantity(s), usd: s.kind === 'dca' ? (s.maxTotalUsd ?? s.perOrderUsd * s.orders) : null }];
    for (const l of legs) {
      const m = this.markets.get(l.symbol);
      const ref = m ? await this.refOf(l.symbol) : null;
      if (!m || !ref) continue;
      const priced = s.kind === 'scale' ? scaleLadder(s, m, a.seed) : (s.kind === 'bracket' && s.entry === 'limit') || s.kind === 'iceberg' ? (s.price !== null ? [{ price: s.price }] : []) : [];
      const off = bandRefused(l.side, priced, m, ref.mark);
      if (off) throw new Error(`${off} order${off === 1 ? ' is' : 's are'} priced too far from the price: SoDEX refuses a limit ${l.side} more than ${Math.round((l.side === 'buy' ? m.buyLimitUpRatio : m.sellLimitDownRatio) * 100)}% ${l.side === 'buy' ? 'over' : 'under'} the mark.`);
      const qty = l.qty ?? (l.usd !== null ? l.usd / ref.mark : null);
      if (!qty) continue;
      const pos = s.paper ? 0 : await this.positionOf(a, l.symbol);
      // A position SoDEX did not report is not "none": the limit cannot be checked, so the start is refused (owner, 2026-10-28).
      if (pos === null && m.marginTiers?.length) throw new Error(`SoDEX did not report your position on ${l.symbol}, so the position limit cannot be checked. Try again in a moment.`);
      // The leverage it trades at: its own, else the open position's (as SoDEX reports it), else SoDEX's default for the market.
      const lev = limitLeverage(m, s.leverage, s.paper ? null : this.positionLeverage(a, l.symbol));
      const lim = checkLimits(m, { side: l.side, quantity: qty, price: ref.mark, position: pos, leverage: lev, oi: ref.oi });
      if (lim.errors.length) throw new Error(s.kind === 'basket' ? `${l.symbol}: ${lim.errors[0]}` : lim.errors[0]);
    }
  }

  /**
   * The plan's children against SoDEX's smallest and largest order (sizes.ts),
   * at the mark now: the same check and the same words as the ticket's. A
   * VWAP's profile is read for it (the slices it will have); a time-sliced
   * close is checked when it begins (its size is the position's then).
   */
  private async startSizes(a: AlgoRecord): Promise<void> {
    const s = a.spec;
    const m = this.markets.get(s.symbol)!;
    const refs = new Map<string, number | null>();
    for (const sym of algoSymbols(s)) refs.set(sym, (await this.refOf(sym))?.mark ?? null);
    const start = Math.max(Date.now(), s.startAt ?? 0);
    const profile = s.kind === 'vwap' ? await this.profileFor(s.symbol, start, s.durationMs, s.slices, s.lookbackDays).catch(() => null) : null;
    const check = checkSizes(s, m, { price: refs.get(s.symbol) ?? null, seed: a.seed, now: start, profile, market: (x) => this.markets.get(x) ?? null, prices: (x) => refs.get(x) ?? null });
    if (check.errors.length) throw new Error(check.errors.join(' '));
  }

  /** A market's mark and open interest: the feed's, else read once from SoDEX (a market not watched yet). null: not known. */
  private async refOf(symbol: string): Promise<{ mark: number; oi: number | null } | null> {
    const mk = this.market.mark(symbol);
    if (mk) return { mark: mk.mark, oi: mk.oi };
    try {
      const rows = await this.host.sodex.markPrices();
      const r = rows.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase());
      return r ? { mark: r.price, oi: r.oi ?? null } : null;
    } catch {
      return null;
    }
  }

  async pause(id: string): Promise<AlgoRecord> {
    const a = this.need(id);
    if (FINAL_STATUSES.has(a.status)) throw new Error('This algo has ended.');
    if (a.status === 'paused') return a;
    a.k.pausedFrom = a.status;
    await this.setStatus(a, 'paused', 'Paused by you.');
    await this.pullResting(a);
    for (const c of this.linkedOf(a)) if (!FINAL_STATUSES.has(c.status)) await this.pause(c.id);
    return a;
  }

  async resume(id: string): Promise<AlgoRecord> {
    const a = this.need(id);
    if (a.status !== 'paused') return a;
    const back = a.k.pausedFrom === 'scheduled' ? 'scheduled' : 'running';
    delete a.k.pausedFrom;
    await this.setStatus(a, back, null);
    for (const c of this.linkedOf(a)) if (c.status === 'paused') await this.resume(c.id);
    return a;
  }

  /**
   * Stop an algo for a reason that is not the follower's (the browser tab that ran it was
   * closed): ended as a cancel is - its resting children cancelled on SoDEX, its exits kept for
   * what filled - with `reason` in its log and in the notice the follower gets.
   */
  async stopFor(id: string, reason: string): Promise<AlgoRecord> {
    const a = this.need(id);
    if (FINAL_STATUSES.has(a.status)) return a;
    for (const c of this.linkedOf(a)) if (!FINAL_STATUSES.has(c.status)) await this.stopFor(c.id, reason);
    await this.end(a, 'cancelled', reason);
    return a;
  }

  /**
   * Cancel an algo: its resting children are cancelled on SoDEX; what filled
   * stays filled, and its exits stay on SoDEX to protect that (the log says so).
   * `pullAll` (the kill switch) pulls its exits and anything it left resting too.
   */
  async cancel(id: string, o: { pullAll?: boolean } = {}): Promise<AlgoRecord> {
    const a = this.need(id);
    if (FINAL_STATUSES.has(a.status)) {
      // An ended algo keeps only what protects or finishes what it filled (its exits, a child left resting): cancelling it pulls those.
      await this.pullLeftovers(a);
      return a;
    }
    for (const c of this.linkedOf(a)) if (!FINAL_STATUSES.has(c.status)) await this.cancel(c.id, o);
    // A bot set to close what it holds stops by closing it first (the next steps); a second stop, or the kill switch, ends it at once.
    if (!o.pullAll && !a.k.closing && (await this.stopBot(a, 'cancelled', 'Stopped by you.'))) return a;
    await this.end(a, 'cancelled', a.k.closing ? 'Stopped by you; what it still holds is left as it is.' : a.spec.bot ? 'Stopped by you.' : 'Cancelled by you.');
    if (o.pullAll) {
      for (const c of this.linkedOf(a)) if (this.hasLeftovers(c)) await this.pullLeftovers(c);
      await this.pullLeftovers(a);
    }
    return a;
  }

  /**
   * Take an ended algo off the wallet's list (the Bots page's Delete). Nothing is deleted: the record and its
   * log stay in the store (no data loss), `k.archived` only hides it from list().
   */
  async archive(id: string): Promise<AlgoRecord> {
    const a = this.need(id);
    if (!FINAL_STATUSES.has(a.status)) throw new Error('Stop it first: only an ended bot or algo can be removed from the list.');
    if (this.hasLeftovers(a)) throw new Error('It still has orders or exits on SoDEX: cancel those first.');
    if (a.k.archived) return a;
    a.k.archived = true;
    a.updatedAt = Date.now();
    await this.save(a);
    await this.event(a, 'info', 'Removed from your list by you (kept on record).');
    this.host.onChange?.(a.id);
    return a;
  }

  /** Whether an ended algo still has something on SoDEX (or the paper book): live exits, or a child it left resting. */
  private hasLeftovers(a: AlgoRecord): boolean {
    return this.liveExits(a).some((x) => !x.cancelling) || this.keptLive(a).some((c) => !c.cancelling);
  }

  /** Cancel an ended algo's live exits and kept children; its exits are not placed again. Its final status stays. */
  private async pullLeftovers(a: AlgoRecord): Promise<void> {
    if (!this.hasLeftovers(a)) return;
    a.k.exitsDone = true;
    a.k.kept = [];
    const m = this.markets.get(a.spec.symbol);
    const exits = this.liveExits(a);
    const kept = a.children.filter((c) => LIVE.has(c.state) && c.tif !== 'ioc');
    if (m) {
      await this.cancelExits(a, m, exits);
      await this.cancelChildren(a, m, kept);
    }
    // A paper exit rests nowhere but here: it is simply over.
    if (a.spec.paper) for (const x of exits) x.state = 'done';
    await this.save(a);
    await this.event(a, 'cancel', 'Exits and orders left on SoDEX cancelled by you.');
    this.syncWatch();
    this.host.onChange?.(a.id);
  }

  /** A basket's legs (the algos it started). */
  private legsOf(a: AlgoRecord): AlgoRecord[] {
    return ((a.k.legs as string[] | undefined) ?? []).map((id) => this.algos.get(id)).filter((x): x is AlgoRecord => !!x);
  }

  /**
   * The algos that follow this one's pause, resume and cancel: a basket's
   * legs, and the algo a conditional started while it was paused (until the
   * conditional ends, it waits with it).
   */
  private linkedOf(a: AlgoRecord): AlgoRecord[] {
    const out = this.legsOf(a);
    const child = typeof a.k.child === 'string' ? this.algos.get(a.k.child) : undefined;
    if (child) out.push(child);
    return out;
  }

  /**
   * The kill switch: every algo of `owner` is cancelled, and with it
   * everything it has on SoDEX - its resting orders, the exits of a running
   * algo as of one that had ended, a child left resting. One press leaves
   * nothing behind (a plain cancel keeps the exits that protect what filled).
   */
  async cancelAll(owner: string): Promise<AlgoRecord[]> {
    const out: AlgoRecord[] = [];
    for (const a of this.list(owner)) if (!FINAL_STATUSES.has(a.status) || this.hasLeftovers(a)) out.push(await this.cancel(a.id, { pullAll: true }));
    return out;
  }

  /**
   * Change a running algo where that is safe: its limit price, bounds, spread
   * guard and label any time; its size only upward of what has filled (and,
   * for a schedule, from the next slice on).
   */
  async update(id: string, patch: AlgoUpdatePatch & Partial<Pick<AlgoSpec, 'upper' | 'lower'>>): Promise<AlgoRecord> {
    const a = this.need(id);
    if (FINAL_STATUSES.has(a.status)) throw new Error('This algo has ended.');
    // Only these: what the algo is (its kind, market, side, practice or live, reduce-only...) was signed and checked when it started.
    const allowed = a.spec.kind === 'mm' || a.spec.kind === 'grid' ? BOT_UPDATABLE[a.spec.kind] : UPDATABLE;
    const other = Object.keys(patch).filter((k) => !allowed.has(k) && (patch as Record<string, unknown>)[k] !== undefined);
    if (other.length) {
      throw new Error(a.spec.kind === 'grid'
        ? `A grid's market, range and levels are what it is: start a new bot for others (not ${other.join(', ')}).`
        : a.spec.kind === 'mm'
          ? `A volume maker's market is what it is: start a new bot for another (not ${other.join(', ')}).`
          : `Only the limit price, bounds, spread guard, label and size of a running algo can be changed (not ${other.join(', ')}).`);
    }
    const next = { ...a.spec, ...patch } as Record<string, unknown>;
    const before = this.targetOf(a);
    if (patch.quantity !== undefined) {
      if (!('quantity' in a.spec) || a.spec.kind === 'trailing') throw new Error('The size of this kind of algo cannot be changed.');
      if (a.spec.kind === 'twap' && a.spec.closeShare !== null) throw new Error('A close is sized from the position: its size cannot be changed.');
      const want = Number(patch.quantity);
      if (want <= a.filled) throw new Error('The new size must be more than what has filled.');
      // A taker in flight cannot be pulled, nor one whose fate SoDEX has not told (it may have filled): the new size must leave room for all of it.
      const taking = this.live(a).filter((c) => c.tif === 'ioc' || c.cancelling || c.state === 'unknown').reduce((x, c) => x + Math.max(0, c.quantity - c.filled), 0);
      if (a.filled + taking >= want - 1e-12) throw new Error(`An order is filling right now: the new size must be more than ${dec(a.filled + taking)}.`);
    }
    const spec = parseAlgoSpec(next);
    a.spec = spec;
    // A bot's new sizes and distances apply at once: what rests is pulled, and placed again as they say.
    if ((spec.kind === 'mm' || spec.kind === 'grid') && ['orderUsd', 'offsetTicks', 'skewTicks', 'maxInventoryUsd', 'edgeBps'].some((k) => k in patch)) {
      const m = this.markets.get(spec.symbol);
      const resting = this.live(a).filter((c) => c.tif !== 'ioc' && !c.cancelling);
      if (m && resting.length) await this.cancelChildren(a, m, resting);
    }
    const after = this.targetOf(a);
    if (patch.quantity !== undefined && before !== null && after !== null && a.startedAt !== null && (spec.kind === 'twap' || spec.kind === 'vwap')) {
      // A schedule spreads the change over what is still to come (from the next slice on): nothing extra is due at once.
      const steps = (a.k.resize as number[][] | undefined) ?? [];
      steps.push([Math.min(1, Number(a.k.share ?? 0)), after - before]);
      a.k.resize = steps;
    }
    if (patch.quantity !== undefined && after !== null) {
      // Lowered under what may still fill: resting children past the new size are pulled, the last placed first (the next step re-sends what is due).
      let over = a.filled + this.pendingQty(a) - after;
      const pull: ChildOrder[] = [];
      for (const c of [...this.live(a)].reverse()) {
        if (over <= 1e-12) break;
        if (c.tif === 'ioc' || c.cancelling) continue;
        pull.push(c);
        over -= Math.max(0, c.quantity - c.filled);
      }
      const m = this.markets.get(spec.symbol);
      if (pull.length && m) await this.cancelChildren(a, m, pull);
    }
    if (patch.quantity !== undefined && a.startedAt !== null) {
      // What rests at a size of its own goes back for the new one: a ladder's levels are cut from its size (each is put
      // back for its new size less what it filled), a bracket's limit entry is the size. Each is placed again once SoDEX
      // confirmed the old one gone - as after a pause. Without this a raise was never worked and a lowered entry ended it.
      const m = this.markets.get(spec.symbol);
      const resting = this.live(a).filter((c) => c.tif !== 'ioc' && !c.cancelling && c.state === 'open');
      if (spec.kind === 'scale') {
        if (resting.length && m) await this.cancelChildren(a, m, resting);
        delete a.k.queue;
        a.k.placed = false;
      } else if (spec.kind === 'bracket' && spec.entry === 'limit') {
        const entry = resting.filter((c) => c.tag === 'entry');
        if (entry.length && m) await this.cancelChildren(a, m, entry);
        a.k.placed = false;
      }
    }
    await this.save(a);
    await this.event(a, 'info', 'Changed by you.');
    return a;
  }

  /** What a schedule should have filled by `share` of it, with the size changes spread over the rest of it. */
  private scheduleDue(a: AlgoRecord, total: number, share: number): number {
    const steps = (a.k.resize as number[][] | undefined) ?? [];
    let base = total;
    let due = 0;
    for (const [from, delta] of steps) {
      base -= delta!;
      due += delta! * (from! >= 1 - 1e-9 ? 1 : Math.min(1, Math.max(0, (share - from!) / (1 - from!))));
    }
    return base * share + due;
  }

  async events(id: string, q: { limit?: number; before?: number } = {}): Promise<AlgoEvent[]> {
    return this.host.store.algoEvents({ algoId: id, limit: q.limit ?? 200, before: q.before });
  }

  /* ---------------------------------------------------------------- views ----- */

  view(id: string): AlgoView | null {
    const a = this.algos.get(id);
    if (!a) return null;
    const s = a.spec;
    const target = this.targetOf(a);
    const avg = a.filled > 0 ? a.filledValue / a.filled : null;
    const sign = s.side === 'buy' ? 1 : -1;
    const bps = (ref: number | null) => (avg !== null && ref ? ((ref - avg) / ref) * 10_000 * sign : null);
    const marketVwap = a.marketQty > 0 ? a.marketValue / a.marketQty : null;
    let progress = target ? Math.min(1, a.filled / target) : 0;
    if (s.kind === 'dca') progress = Math.min(1, (Number(a.k.done ?? 0) + Number(a.k.skipped ?? 0)) / s.orders);
    if ((s.kind === 'mm' || s.kind === 'grid') && a.book) progress = s.volumeTargetUsd ? Math.min(1, bookVolume(a.book) / s.volumeTargetUsd) : 0;
    // A basket's progress is its legs' filled value against what each leg is to trade.
    const legs = this.legsOf(a);
    if (s.kind === 'basket') {
      const want = s.legs.reduce((x, l) => x + l.usd, 0);
      progress = want > 0 ? Math.min(1, legs.reduce((x, c) => x + c.filledValue, 0) / want) : 0;
    }
    if (a.status === 'done') progress = 1;
    const now = Date.now();
    let nextAt: number | null = null;
    let endsAt: number | null = null;
    if (s.kind === 'twap' && a.startedAt !== null) {
      const times = (a.k.times as number[] | undefined) ?? [];
      const i = nextSlice(times, now);
      nextAt = i >= 0 ? times[i]! : null;
      endsAt = a.startedAt + s.durationMs;
    } else if (s.kind === 'basket' && a.startedAt !== null && s.style === 'twap') endsAt = a.startedAt + s.durationMs;
    else if (s.kind === 'vwap' && a.startedAt !== null) {
      const times = (a.k.times as number[] | undefined) ?? [];
      const i = nextSlice(times, now);
      nextAt = i >= 0 ? times[i]! : null;
      endsAt = a.startedAt + s.durationMs;
    } else if (s.kind === 'dca' && a.startedAt !== null) {
      const i = Number(a.k.done ?? 0) + Number(a.k.skipped ?? 0);
      nextAt = i < s.orders ? a.startedAt + i * s.intervalMs : null;
      endsAt = a.startedAt + (s.orders - 1) * s.intervalMs;
    } else if (s.kind === 'pov') endsAt = s.endAt;
    else if ((s.kind === 'chase' || s.kind === 'sweep') && a.startedAt !== null && s.timeoutMs) endsAt = a.startedAt + s.timeoutMs;
    else if (s.kind === 'swarm') nextAt = (a.k.waveAt as number | undefined) ?? null;
    else if (s.kind === 'conditional') endsAt = s.expiresAt;
    else if (s.kind === 'mm' || s.kind === 'grid') endsAt = s.endAt;
    if (s.startAt && a.status === 'scheduled') nextAt = s.startAt;
    const live = a.children.filter((c) => LIVE.has(c.state));
    const working = live.length
      ? live.length === 1
        ? `${live[0]!.tif === 'ioc' ? 'Taking' : 'Resting'} ${live[0]!.quantity - live[0]!.filled} at ${live[0]!.price}`
        : `${live.length} orders working`
      : null;
    return {
      algo: a,
      target,
      progress,
      avgPrice: avg,
      vsArrivalBps: bps(a.arrival),
      vsMarketVwapBps: bps(marketVwap),
      marketVwap,
      nextAt,
      endsAt,
      working,
      triggerPrice: s.kind === 'trailing' ? ((a.k.stop as number | undefined) ?? null) : null,
      conditions: s.kind === 'conditional' ? s.conditions.map((c, i) => ({ text: this.describeCondition(c), ok: Boolean((a.k.ok as boolean[] | undefined)?.[i]) })) : null,
      exits: (a.exitOrders ?? []).length
        ? (a.exitOrders ?? []).filter((x) => LIVE.has(x.state) || x.filled > 0).map((x) => ({ kind: x.exit ?? 'sl', price: x.price, quantity: x.quantity, filled: x.filled, live: LIVE.has(x.state) }))
        : null,
      legs: s.kind === 'basket' ? legs.map((c) => ({ id: c.id, symbol: c.spec.symbol, side: c.spec.side, status: c.status, filledValue: c.filledValue, avgPrice: c.filled > 0 ? c.filledValue / c.filled : null })) : null,
      bot: s.bot ? this.botView(a) : null,
    };
  }

  /** A bot's figures at the mark now (the mid, else its average fill, while no mark is known). */
  private botView(a: AlgoRecord): BotView {
    const b = a.book ?? emptyBook();
    const q = this.market.quote(a.spec.symbol);
    const mark = this.market.mark(a.spec.symbol)?.mark ?? (q ? mid(q) : a.filled > 0 ? a.filledValue / a.filled : null);
    const px = mark ?? 0;
    const volume = bookVolume(b);
    return {
      volume,
      inventory: bookInventory(b),
      inventoryUsd: bookInventory(b) * px,
      grossPnl: bookGross(b, px),
      netPnl: bookNet(b, px),
      tradeFees: b.tradeFees,
      builderFees: b.builderFees,
      makerShare: volume > 0 ? b.makerValue / volume : 0,
      costPerMillion: costPerMillion(b, px),
      fills: b.fills,
      mark,
      orders: this.live(a).filter((c) => c.tif !== 'ioc' && !c.cancelling).map((c) => ({ side: c.side, price: c.price, quantity: c.quantity - c.filled, tag: c.tag })),
      closing: !!a.k.closing,
    };
  }

  /** The base quantity the algo is to fill, as far as it is known. */
  private targetOf(a: AlgoRecord): number | null {
    const s = a.spec;
    if (s.kind === 'dca') return typeof a.k.targetQty === 'number' && a.k.targetQty > 0 ? a.k.targetQty : null;
    if (s.kind === 'trailing' || s.kind === 'conditional') return typeof a.k.takeQty === 'number' ? a.k.takeQty : algoQuantity(s);
    if (s.kind === 'twap' && s.closeShare !== null) return typeof a.k.total === 'number' ? a.k.total : null;
    return algoQuantity(s);
  }

  /* ---------------------------------------------------------------- ticks ----- */

  /** One step for every live algo (the timer calls this; tests call it directly). */
  tick(now = Date.now()): void {
    this.checkPaperExits();
    for (const a of this.algos.values()) {
      // An ended algo is not stepped, but its exits still follow what it filled (a resize whose cancel came late, a refusal tried
      // again), and are held against its position: gone, closed outside it, they are cancelled instead (watchExits).
      if (FINAL_STATUSES.has(a.status)) {
        const m = this.markets.get(a.spec.symbol);
        if (m && this.exitsWatchDue(a, now)) void this.watchExits(a, m, now).catch((e) => this.host.log.error('algo: exits watch failed', { algo: a.id, error: String(e) }));
        else if (m && !this.exitsWatching.has(a.id) && !this.exitsUnchecked(a) && this.exitsDue(a, now)) {
          void this.syncExits(a, m, true).catch((e) => this.host.log.error('algo: exits failed', { algo: a.id, error: String(e) }));
        }
      }
      if (FINAL_STATUSES.has(a.status) || this.busy.has(a.id)) continue;
      this.busy.add(a.id);
      void this.step(a, now)
        .catch(async (e) => {
          this.host.log.error('algo: a step failed', { algo: a.id, error: String(e) });
          await this.event(a, 'error', `Step failed: ${e instanceof Error ? e.message : String(e)}`).catch(() => {});
        })
        .finally(() => this.busy.delete(a.id));
    }
    // Wallets beyond the socket's places, and all of them after a drop: their orders by REST.
    void this.pollOrders(now).catch((e) => this.host.log.warn('algo: order poll failed', { error: String(e) }));
  }

  /** Run one step of one algo and wait for it (tests). */
  async stepNow(id: string, now = Date.now()): Promise<void> {
    this.checkPaperExits();
    const a = this.need(id);
    if (FINAL_STATUSES.has(a.status)) return;
    while (this.busy.has(id)) await new Promise((r) => timers.after(5, () => r(undefined)));
    this.busy.add(id);
    try {
      await this.step(a, now);
    } finally {
      this.busy.delete(id);
    }
  }

  private async step(a: AlgoRecord, now: number): Promise<void> {
    const s = a.spec;
    const m = this.markets.get(s.symbol);
    if (!m) {
      if (this.markets.size) await this.end(a, 'failed', `${s.symbol} is no longer listed on SoDEX perps.`);
      return;
    }
    await this.settleStale(a, m, now);
    if (a.status === 'paused') {
      await this.pullResting(a);
      return;
    }
    if (!s.paper) {
      const brake = this.host.brake?.(a) ?? null;
      if (brake) {
        await this.hold(a, `Held: ${brake}`);
        // Nothing new is sent, but what filled meanwhile (a child left resting) still gets its exits: they only protect (brake.ts).
        if (!this.stopped(a)) await this.syncExits(a, m, false);
        return;
      }
      const problem = await this.problemOf(a, now);
      // A cancel or a pause may have landed while it was being checked.
      if (this.stopped(a)) return;
      if (problem) {
        await this.hold(a, problem);
        return;
      }
      // The region rules apply to live algos as to copies: a blocked region holds it (policy.ts) - but a
      // close-only place may close: an algo that only makes a position smaller runs there (owner, 2026-10-29).
      const policy = this.host.policyFor?.(a) ?? null;
      if (policy && !policy.allowed && !(policy.closeOnly && algoClosesOnly(s))) {
        await this.hold(a, `Held: ${policy.reason ?? 'not available in your region.'}`);
        return;
      }
    }
    // SoDEX refused it at one of its limits (onLimit): nothing goes out until the wait is over.
    if (typeof a.k.limitUntil === 'number' && now < a.k.limitUntil) {
      await this.hold(a, String(a.k.limitReason ?? 'Held: a SoDEX limit is reached.'));
      return;
    }
    if (m.status !== 'TRADING') {
      await this.hold(a, `SoDEX is not trading ${m.name} right now.`);
      return;
    }
    const q = this.market.quote(s.symbol);
    if (!q) {
      await this.hold(a, 'Waiting for a price from SoDEX.');
      return;
    }
    // It begins only with a price in hand: the arrival price and a chase's reference are taken here.
    if (a.status === 'scheduled') {
      if (!(await this.ready(a, now))) return;
      const began = await this.begin(a, m, now);
      if (!began || this.stopped(a)) return;
    }
    const mk = this.market.mark(s.symbol)?.mark ?? mid(q);
    // The trader's bounds, on the mark.
    const b = s.upper && mk >= s.upper.price ? { ...s.upper, which: 'upper' } : s.lower && mk <= s.lower.price ? { ...s.lower, which: 'lower' } : null;
    if (b) {
      const words = `the price is ${b.which === 'upper' ? 'at or above' : 'at or below'} your ${b.which} bound of ${b.price}`;
      if (b.then === 'stop' || s.kind === 'scale') {
        await this.end(a, this.isDone(a, m) ? 'done' : 'expired', `Stopped: ${words}.`);
        return;
      }
      if (b.then === 'hold') {
        await this.pullResting(a);
        await this.hold(a, `Held: ${words}.`);
        return;
      }
      if (!a.k.rush) {
        a.k.rush = true;
        await this.event(a, 'info', `Taking the rest now: ${words}.`);
      }
    }
    // Back to running only after a step that raised no hold of its own (no flapping, no log line per tick).
    this.heldNow.delete(a.id);
    if (s.bot && a.book && sampleBook(a.book, mk, now)) this.dirty.add(a.id);
    if (a.k.closing) {
      await this.stepBotClose(a, m, q, mk, now);
      if (!this.heldNow.has(a.id) && !FINAL_STATUSES.has(a.status)) await this.run(a);
      return;
    }
    await this.stepKind(a, m, q, mk, now);
    if (!this.heldNow.has(a.id) && !FINAL_STATUSES.has(a.status)) await this.run(a);
    if (!FINAL_STATUSES.has(a.status)) await this.syncExits(a, m, false);
  }

  private async stepKind(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number, now: number): Promise<void> {
    const s = a.spec;
    switch (s.kind) {
      case 'twap':
      case 'vwap':
        return this.stepSchedule(a, m, q, mk, now);
      case 'pov':
        return this.stepPov(a, m, q, mk, now);
      case 'dca':
        return this.stepDca(a, m, q, mk, now);
      case 'iceberg':
        return this.stepIceberg(a, m, q, now);
      case 'chase':
        return this.stepChase(a, m, q, mk, now);
      case 'scale':
        return this.stepScale(a, m, q, now);
      case 'swarm':
        return this.stepSwarm(a, m, q, mk, now);
      case 'conditional':
        return this.stepConditional(a, m, q, mk, now);
      case 'trailing':
        return this.stepTrailing(a, m, q, mk, now);
      case 'basket':
        return this.stepBasket(a);
      case 'bracket':
        return this.stepBracket(a, m, q, mk);
      case 'sweep':
        return this.stepSweep(a, m, now);
      case 'mm':
        return this.stepMm(a, m, q, mk, now);
      case 'grid':
        return this.stepGrid(a, m, q, mk, now);
    }
  }

  /** What a taker leg's slippage is measured from: null for the touch, a price, or undefined when that price is not fresh. */
  private slipBase(symbol: string, exec: ExecSpec, q: Quote): number | null | undefined {
    const from = exec.slipFrom ?? 'touch';
    if (from === 'touch') return null;
    if (from === 'mid') return mid(q);
    const now = Date.now();
    if (from === 'mark' || from === 'index') {
      const mk = this.market.mark(symbol);
      const p = mk && now - mk.at <= SWEEP_MAX_AGE_MS ? (from === 'mark' ? mk.mark : mk.index) : null;
      return p && p > 0 ? p : undefined;
    }
    const c = combineOracle(this.oracleFor(symbol.replace(/-USD$/, ''), now), now, { maxAgeMs: SWEEP_MAX_AGE_MS });
    const p = from === 'oracleFair' ? c.fair : c.mid;
    return p !== null && p > 0 ? p : undefined;
  }

  /** The oracle's quotes for a coin, read again in the background at most once a second (a step never waits on it). */
  private oracleFor(coin: string, now: number, venues?: readonly OracleVenue[]): VenueQuote[] {
    // Per coin and venue set: a browser's API gives several venues only as their combined price.
    const key = this.oracleKey(coin, venues);
    let o = this.oracleQuotes.get(key);
    if (!o) {
      o = { quotes: [], at: 0, busy: false, first: now };
      this.oracleQuotes.set(key, o);
    }
    if (this.host.oracle && !o.busy && now - o.at >= 1_000) {
      const slot = o;
      slot.busy = true;
      this.host
        .oracle(coin, venues?.length ? venues : undefined)
        .then((q) => {
          slot.quotes = q;
        })
        .catch(() => {
          /* missing: the quotes age out and the sweep falls back or pauses */
        })
        .finally(() => {
          slot.busy = false;
          slot.at = Date.now();
        });
    }
    return o.quotes;
  }

  private oracleKey(coin: string, venues?: readonly OracleVenue[]): string {
    return `${coin}|${venues?.length ? [...venues].sort().join(',') : '*'}`;
  }

  /**
   * Whether the oracle has not answered for this coin and venue set yet: its first read is still on its
   * way (oracleFor never waits). A failed read counts as an answer, after which SoDEX's mark is the fallback.
   */
  private oracleUnread(coin: string, now: number, venues?: readonly OracleVenue[]): boolean {
    const o = this.oracleQuotes.get(this.oracleKey(coin, venues));
    // Not for long: an oracle that does not answer within a few seconds is one that is not fresh.
    return !!this.host.oracle && (!o || (o.at === 0 && now - o.first < ORACLE_FIRST_WAIT_MS));
  }

  /** Fill fast (sweep.ts): an IOC at the band edge for the rest, each round re-priced from the reference. */
  private async stepSweep(a: AlgoRecord, m: MarketInfo, now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'sweep' }>;
    const coin = s.symbol.replace(/-USD$/, '');
    const mark = this.market.mark(s.symbol);
    // SoDEX's own prices only when the spec asks for them or as the fallback: the oracle is not read for a mark or index sweep.
    const own = s.reference === 'mark' || s.reference === 'index';
    const book = this.market.quote(s.symbol);
    const quotes = own ? [] : this.oracleFor(coin, now, s.venues);
    // The oracle's first answer is on its way: the round waits for it (a step or two), rather than going
    // out on SoDEX's own mark - the fallback for an oracle that is not fresh, not for one not asked yet.
    if (!own && this.oracleUnread(coin, now, s.venues)) return;
    const ref = sweepRefFor(s, quotes, mark ? { mark: mark.mark, index: mark.index, at: mark.at } : null, now, SWEEP_MAX_AGE_MS);
    const act = sweepStep({
      side: s.side,
      total: Number(s.quantity),
      filled: a.filled,
      pending: this.pendingQty(a),
      startedAt: a.startedAt ?? now,
      now,
      timeoutMs: s.timeoutMs,
      roundMs: s.roundMs,
      lastRoundAt: typeof a.k.roundAt === 'number' ? a.k.roundAt : null,
      slippageBps: s.slippageBps,
      tickSize: m.tickSize,
      stepSize: m.stepSize,
      minQty: (p) => minChildQty(m, p),
      ref,
      touch: book ? (s.side === 'buy' ? book.ask : book.bid) : null,
      limitPrice: s.limitPrice,
      maxQty: (p) => maxOrderQty(m, p),
    });
    switch (act.type) {
      case 'done':
        return this.end(a, 'done', a.filled > 0 ? 'Filled.' : 'Nothing left to fill.');
      case 'expired':
        if (a.filled <= 0 && act.left < minChildQty(m, ref?.price ?? 0)) return this.end(a, 'failed', 'Under SoDEX\'s minimum order size: nothing could be sent.');
        return this.end(a, 'expired', `Gave up: ${dec(act.left)} ${m.base} left unfilled inside the band.`);
      case 'wait':
        if (act.reason) await this.hold(a, act.reason);
        return;
      case 'send': {
        const round = Number(a.k.round ?? 0) + 1;
        await this.send(a, m, [{ side: s.side, price: act.price, quantity: act.qty, tif: 'ioc', tag: `round ${round}${ref?.fallback ? ' (SoDEX mark, no fresh oracle)' : ''}` }], () => {
          a.k.roundAt = now;
          a.k.round = round;
          a.k.ref = ref?.price ?? null;
        });
        return;
      }
    }
  }

  /** Whether a scheduled algo may begin: its start time and its start price. */
  private async ready(a: AlgoRecord, now: number): Promise<boolean> {
    const s = a.spec;
    if (s.startAt !== null && now < s.startAt) return false;
    if (s.triggerPrice !== null) {
      const mk = this.market.mark(s.symbol)?.mark ?? null;
      if (mk === null) return false;
      if (typeof a.k.triggerFrom !== 'number') {
        a.k.triggerFrom = mk;
        this.dirty.add(a.id);
      }
      const from = a.k.triggerFrom as number;
      const hit = from >= s.triggerPrice ? mk <= s.triggerPrice : mk >= s.triggerPrice;
      if (!hit) return false;
      await this.event(a, 'info', `The mark reached your start price of ${s.triggerPrice}.`);
    }
    return true;
  }

  /** Start working: the arrival price, the schedule, the profile. false: it did not start (yet). */
  private async begin(a: AlgoRecord, m: MarketInfo, now: number): Promise<boolean> {
    const s = a.spec;
    const q = this.market.quote(s.symbol);
    a.startedAt = now;
    a.arrival = q ? mid(q) : (this.market.mark(s.symbol)?.mark ?? null);
    if (s.kind === 'twap') {
      if (s.closeShare !== null) {
        // A time-sliced close: its size and side are the position's, now (reads that agree: positionConfirmed).
        const pos = await this.positionConfirmed(a, s.symbol);
        // Cancelled while the position was read: it stays cancelled.
        if (FINAL_STATUSES.has(a.status)) return false;
        if (pos === null || pos === 'disagree') {
          // A read that failed is not "no position": it stays scheduled and reads again on the next step.
          a.startedAt = null;
          await this.hold(a, pos === null ? `Waiting: your position on ${m.name} could not be read; trying again.` : `Waiting: SoDEX's reads of your position on ${m.name} disagree; reading again.`);
          return false;
        }
        const size = floorStep(Math.abs(pos) * s.closeShare, m);
        if (!pos || size < Number(m.stepSize)) {
          a.startedAt = null;
          await this.end(a, 'expired', `There is no position on ${m.name} to close.`);
          return false;
        }
        // Its slices as SoDEX takes them, now that the size is known: refused in words, never merged or split.
        const sized = checkSizes(s, m, { price: a.arrival, seed: a.seed, now, positionSize: pos });
        if (sized.errors.length) {
          await this.end(a, 'failed', `Not started: ${sized.errors[0]}`);
          return false;
        }
        a.k.total = size;
        a.k.closeSide = pos > 0 ? 'sell' : 'buy';
        await this.event(a, 'info', `Closing ${Math.round(s.closeShare * 100)}% of your ${pos > 0 ? 'long' : 'short'}: ${dec(size)} ${m.base}.`);
      }
      const { times, weights } = twapSchedule(s, now, a.seed);
      a.k.times = times;
      a.k.weights = weights;
    } else if (s.kind === 'vwap') {
      const profile = await this.profileFor(s.symbol, now, s.durationMs, s.slices, s.lookbackDays).catch((e) => {
        this.host.log.warn('algo: volume profile failed', { symbol: s.symbol, error: String(e) });
        return null;
      });
      const { times, weights } = vwapSchedule(s, now, a.seed, profile);
      a.k.times = times;
      a.k.weights = weights;
      a.k.expectedTotal = profile ? profile.expected.reduce((x, y) => x + y, 0) : 0;
      if (!profile) await this.event(a, 'info', 'No volume history could be read: the schedule is even (a TWAP).');
    } else if (s.kind === 'chase') {
      a.k.startRef = q ? (s.side === 'buy' ? q.bid : q.ask) : null;
    } else if (s.kind === 'grid') {
      const prices = gridPrices(s, m.tickSize);
      a.k.gp = prices;
      a.k.gs = gridStart(prices, a.arrival ?? (s.low + s.high) / 2);
    } else if (s.kind === 'swarm') {
      a.k.clips = swarmClips(s, m, a.seed);
      a.k.next = 0;
      a.k.retriesLeft = s.retries;
      a.k.waveAt = now;
    }
    if (s.bot) a.book ??= emptyBook();
    if (FINAL_STATUSES.has(a.status)) return false;
    if (a.status === 'paused') {
      // Paused while it was starting: it is set up, and resumes as running.
      a.k.pausedFrom = 'running';
      await this.save(a);
      return true;
    }
    await this.setStatus(a, 'running', null);
    await this.event(a, 'status', a.arrival ? `Started. Arrival price ${a.arrival}.` : 'Started.');
    return true;
  }

  /* ---------------------------------------------------------- the worker ----- */

  /** Live children: sent and not settled. */
  private live(a: AlgoRecord): ChildOrder[] {
    return a.children.filter((c) => LIVE.has(c.state));
  }

  /** What could still fill: everything live, in full. */
  private pendingQty(a: AlgoRecord): number {
    return this.live(a).reduce((x, c) => x + Math.max(0, c.quantity - c.filled), 0);
  }

  /**
   * Keep the working order in line with the plan: `due` is what should be
   * filled by now, `late` how much of it is overdue (taken at once), the rest
   * of what is due may rest as one post-only child at the touch.
   */
  private async work(
    a: AlgoRecord,
    m: MarketInfo,
    q: Quote,
    mk: number,
    // more: the total grows later (a DCA installment still to come), so dust now is not the end.
    // part: what max participation still lets out in this interval (null: no such cap).
    o: { due: number; late: number; total: number; exec: ExecSpec; tag: string; maxChild?: number | null; minChild?: number | null; minRepriceMs?: number; side?: Side; reduceOnly?: boolean; more?: boolean; part?: number | null },
  ): Promise<void> {
    const s = a.spec;
    const side = o.side ?? s.side;
    const reduceOnly = o.reduceOnly ?? s.reduceOnly;
    const live = this.live(a);
    if (live.some((c) => c.state !== 'open' || c.cancelling)) return;
    // A limit price belongs to the algo's own side; a close on the other side has none.
    const limit = side === s.side ? s.limitPrice : null;
    const ref = side === 'buy' ? q.ask : q.bid;
    // The smallest child: SoDEX's minimum, or the trader's smallest slice - except at the very end.
    const finishing = o.late >= o.total;
    const minQ = Math.max(minChildQty(m, ref), o.minChild && !finishing ? o.minChild : 0);
    // The trader's largest child is never under what SoDEX takes in one order: a cap under it would stall the algo for good.
    const capOf = (min: number) => (o.maxChild !== undefined && o.maxChild !== null ? Math.max(floorStep(o.maxChild, m), min) : Infinity);
    const part = o.part !== undefined && o.part !== null ? floorStep(Math.max(0, o.part), m) : Infinity;
    const room = Math.max(0, o.total - a.filled);
    const need = Math.min(room, o.due - a.filled);
    const lateNeed = Math.min(need, o.late - a.filled);
    const resting = live.find((c) => c.tif !== 'ioc') ?? null;
    const taking = live.find((c) => c.tif === 'ioc') ?? null;
    if (taking) return;
    // More could fill than the algo is to (its size was lowered): the resting child is pulled; the next step sends the right size.
    if (resting && a.filled + this.pendingQty(a) > o.total + 1e-12) {
      await this.cancelChildren(a, m, [resting]);
      return;
    }

    if (lateNeed >= minQ - 1e-12 || (lateNeed > 0 && need >= room - 1e-12 && room > 0 && o.late >= o.total)) {
      if (resting) {
        await this.cancelChildren(a, m, [resting]);
        return;
      }
      if (s.maxSpreadBps !== null && spreadBps(q) > s.maxSpreadBps) {
        await this.hold(a, `Held: the spread (${spreadBps(q).toFixed(1)} bp) is wider than your ${s.maxSpreadBps} bp.`);
        return;
      }
      // A taker that filled nothing (the book is past the cap) is not sent again on the very next tick.
      if (Date.now() - Number(a.k.missAt ?? 0) < TAKER_RETRY_MS) return;
      const from = this.slipBase(s.symbol, o.exec, q);
      const price = from === undefined ? null : takerPrice(side, q, o.exec.slippageBps, m, mk, limit, from);
      // SoDEX's minimum at the child's own price (a sell's limit is under the bid), and its largest order there.
      const minAt = Math.max(minQ, minChildQty(m, price !== null ? Math.min(ref, price) : ref));
      const most = Math.min(capOf(minAt), part, price !== null ? maxOrderQty(m, price) : Infinity);
      let qty = floorStep(lateNeed, m);
      if (need - qty < minAt) qty = floorStep(need, m);
      if (qty < minAt && room >= minAt && lateNeed >= minQ - 1e-12) {
        // Due, but under SoDEX's minimum at this price: a little ahead of the plan rather than not at all (all of it when the rest would be under the minimum too).
        qty = room - minAt < minAt ? floorStep(room, m) : minAt;
        await this.noteOnce(a, 'min', `What was due was under ${minWords(m, price ?? ref)} at this price, so it went out with what is due next.`);
      }
      if (qty > most + 1e-12 && price !== null && most >= maxOrderQty(m, price) - 1e-12) await this.noteOnce(a, 'max', `What is due is over ${maxWords(m, price)}: it goes out in several orders, one after the other.`);
      qty = Math.min(qty, most);
      if (qty < minAt) {
        if (qty > 0 && room >= minAt) await this.noteOnce(a, 'wait', `What is due waits until it reaches ${minWords(m, price ?? ref)}.`);
        // Less than SoDEX takes in one order: what is left at the very end is dust. If nothing ever filled, nothing could be sent: that is no fill.
        if (room < minAt && o.late >= o.total && !o.more) {
          if (a.filled > 0) await this.end(a, 'done', `Filled; ${dec(room)} ${m.base} under SoDEX's minimum order was left.`);
          else await this.end(a, 'failed', 'Under SoDEX\'s minimum order size: nothing could be sent.');
        }
        return;
      }
      if (from === undefined) {
        await this.hold(a, `Held: no fresh ${SLIP_FROM_NAMES[o.exec.slipFrom ?? 'touch'].toLowerCase()} to measure your max slippage from.`);
        return;
      }
      if (price === null) {
        await this.hold(a, `Held: the price is past your limit of ${limit}.`);
        return;
      }
      await this.send(a, m, [{ side, price, quantity: qty, tif: 'ioc', tag: o.tag, reduceOnly }]);
      return;
    }

    // Due, but less than SoDEX takes in one order (POV's pace, a participation cap): it waits and grows - said once.
    if (o.exec.style === 'taker' && lateNeed > 1e-12 && room >= minQ && !o.more) await this.noteOnce(a, 'wait', `What is due waits until it reaches ${minWords(m, ref)}.`);
    if (o.exec.style === 'taker') return;
    const price = makerPrice(side, q, o.exec.offsetTicks, null, m, limit);
    const want = floorStep(Math.min(need, capOf(minQ), part, maxOrderQty(m, price)), m);
    if (resting) {
      const tick = Number(m.tickSize);
      const left = resting.quantity - resting.filled;
      const off = Math.abs(resting.price - price) / tick;
      const since = Date.now() - resting.placedAt;
      // Already the best price on its side: the touch it would follow is its own, so it stays (no walking up over itself).
      const reprice = !this.atOwnTouch(side, resting.price, q) && off >= o.exec.chaseTicks - 1e-9 && since >= (o.minRepriceMs ?? 1_500);
      const grow = want - left >= minQ;
      const shrink = left - want > 1e-12 && want < minQ;
      if (reprice || grow || shrink) await this.cancelChildren(a, m, [resting]);
      return;
    }
    if (want < minChildQty(m, price)) return;
    // The spread guard holds a resting child as it holds a taker: no new child while the spread is wider than the trader allows.
    if (s.maxSpreadBps !== null && spreadBps(q) > s.maxSpreadBps) {
      await this.hold(a, `Held: the spread (${spreadBps(q).toFixed(1)} bp) is wider than your ${s.maxSpreadBps} bp.`);
      return;
    }
    await this.send(a, m, [{ side, price, quantity: want, tif: 'gtx', tag: o.tag, reduceOnly }]);
  }

  /**
   * Whether a resting order is the best price on its own side (a buy at or
   * above the best bid): SoDEX's book then shows the order itself, and pricing
   * off that touch would chase its own price.
   */
  /* ------------------------------------------------------------- the bots ----- */

  /**
   * A bot reached one of its limits, or was stopped: with `onStop: 'close'` and something held, it pulls its
   * quotes and closes that first (stepBotClose). Returns whether it is now closing (false: end it here).
   */
  private async stopBot(a: AlgoRecord, status: AlgoStatus, reason: string): Promise<boolean> {
    const s = a.spec;
    if (!(s.kind === 'mm' || s.kind === 'grid') || s.onStop !== 'close' || !a.book) return false;
    const m = this.markets.get(s.symbol);
    const held = Math.abs(bookInventory(a.book));
    const px = this.market.mark(s.symbol)?.mark ?? null;
    if (!m || held < Number(m.stepSize) || (px !== null && held < minChildQty(m, px) - 1e-12)) return false;
    const closing: BotClosing = { status, reason, at: Date.now() };
    a.k.closing = closing;
    await this.pullResting(a);
    await this.save(a);
    await this.event(a, 'info', `${reason} Closing what it holds: ${dec(held)} ${m.base}.`);
    this.host.onChange?.(a.id);
    return true;
  }

  /** A bot's limits, checked every step: true when it stopped (or began closing). */
  private async botLimitsHit(a: AlgoRecord, mk: number, now: number): Promise<boolean> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'mm' | 'grid' }>;
    const b = (a.book ??= emptyBook());
    let hit: { status: AlgoStatus; reason: string } | null = null;
    if (s.volumeTargetUsd !== null && bookVolume(b) >= s.volumeTargetUsd) hit = { status: 'done', reason: `Reached its volume target of ${money(s.volumeTargetUsd)}.` };
    else if (s.maxLossUsd !== null && bookNet(b, mk) <= -s.maxLossUsd) hit = { status: 'expired', reason: `Stopped at its loss limit: net PnL ${money(bookNet(b, mk))} (limit -${money(s.maxLossUsd)}).` };
    else if (s.endAt !== null && now >= s.endAt) hit = { status: 'expired', reason: 'Its end time came.' };
    if (!hit) return false;
    sampleBook(b, mk, now, true);
    if (!(await this.stopBot(a, hit.status, hit.reason))) await this.end(a, hit.status, hit.reason);
    return true;
  }

  /**
   * Closing what a stopping bot holds (its own fills, never more: reduce-only): post-only at the touch,
   * re-priced as it moves, for BOT_CLOSE_REST_MS; then a taker within BOT_CLOSE_SLIP_BPS. It ends with the
   * status it was stopping for once what is left is under SoDEX's minimum, or once SoDEX refused the close
   * three times (the position is not there any more: closed outside the bot).
   */
  private async stepBotClose(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number, now: number): Promise<void> {
    const closing = a.k.closing as BotClosing;
    const b = (a.book ??= emptyBook());
    const inv = bookInventory(b);
    const live = this.live(a);
    const stray = live.filter((c) => !c.tag.startsWith('close') && !c.cancelling);
    if (stray.length) await this.cancelChildren(a, m, stray);
    const qty = floorStep(Math.abs(inv), m);
    const rejects = closing.rejects ?? 0;
    if (!live.length && (qty < minChildQty(m, mk) - 1e-12 || rejects >= 3)) {
      const left = qty >= Number(m.stepSize) ? ` ${dec(qty)} ${m.base} is left${rejects >= 3 ? ' (SoDEX shows nothing more to close)' : ' (under SoDEX\'s minimum order)'}.` : '';
      delete a.k.closing;
      sampleBook(b, mk, now, true);
      return this.end(a, closing.status, `${closing.reason}${left}`);
    }
    if (live.length && !live.some((c) => c.tag.startsWith('close'))) return;
    const side: Side = inv > 0 ? 'sell' : 'buy';
    const taking = now - closing.at >= BOT_CLOSE_REST_MS;
    const mine = live.find((c) => c.tag.startsWith('close'));
    if (mine) {
      if (mine.state !== 'open' || mine.cancelling || mine.tif === 'ioc') return;
      const want = makerPrice(side, q, 0, null, m, null);
      if (taking || (Math.abs(mine.price - want) / Number(m.tickSize) >= 1 && !this.atOwnTouch(side, mine.price, q) && now - mine.placedAt >= 2_000)) await this.cancelChildren(a, m, [mine]);
      return;
    }
    let price = taking ? takerPrice(side, q, BOT_CLOSE_SLIP_BPS, m, mk, null) : makerPrice(side, q, 0, null, m, null);
    if (price === null) return;
    let take = taking;
    if (take) {
      // Never into another user's bot (terms 2026-11-02): the taker stops one tick short of their resting orders; when
      // that leaves nothing to take at the touch, it rests at the touch instead and tries again.
      const wall = this.otherBotWall(a, m.name, side);
      if (wall !== null) {
        const tick = Number(m.tickSize);
        price = side === 'sell' ? Math.max(price, wall + tick) : Math.min(price, wall - tick);
        if (side === 'sell' ? price > q.bid : price < q.ask) {
          take = false;
          price = makerPrice(side, q, 0, null, m, null);
        }
      }
    }
    const before = a.rejects;
    await this.send(a, m, [{ side, price, quantity: qty, tif: take ? 'ioc' : 'gtx', tag: take ? 'close (take)' : 'close', reduceOnly: true }]);
    if (a.rejects > before && a.k.closing) (a.k.closing as BotClosing).rejects = rejects + 1;
  }

  /**
   * The nearest price another user's bot rests at, on the side a taker `side` of this bot would fill against (the
   * highest bid for a sell, the lowest ask for a buy), live bots against live, practice against practice; null: none.
   */
  otherBotWall(a: AlgoRecord, symbol: string, side: Side): number | null {
    let wall: number | null = null;
    for (const x of this.algos.values()) {
      if (x.owner === a.owner || !x.spec.bot || x.spec.symbol !== symbol || x.spec.paper !== a.spec.paper || FINAL_STATUSES.has(x.status)) continue;
      for (const c of x.children) {
        if (!LIVE.has(c.state) || c.tif === 'ioc' || c.side === side) continue;
        if (wall === null || (side === 'sell' ? c.price > wall : c.price < wall)) wall = c.price;
      }
    }
    return wall;
  }

  /** Volume maker: one post-only bid and one post-only ask where mmQuotes puts them (bots.ts). */
  private async stepMm(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number, now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'mm' }>;
    if (await this.botLimitsHit(a, mk, now)) return;
    if (s.maxSpreadBps !== null && spreadBps(q) > s.maxSpreadBps) {
      await this.pullResting(a);
      return this.hold(a, `Held: the spread (${spreadBps(q).toFixed(1)} bp) is wider than your ${s.maxSpreadBps} bp.`);
    }
    const inv = bookInventory(a.book!);
    const tick = Number(m.tickSize);
    // The Binance-led maker: no fair price (no feed here, or it went quiet), no quotes.
    const fair = s.ref ? this.fairFor(s.symbol, q, now) : null;
    if (s.ref && fair === null) {
      await this.pullResting(a);
      return this.hold(a, this.host.reference ? 'Held: waiting for the Binance price (it quotes only with a fresh one).' : 'Held: the Binance-led maker runs on the ValueDesk executor only.');
    }
    // The move guard: the mid's move over the last 2 s, in ticks; the side it moves toward waits where it would add.
    const ago = (s.moveGuard ?? 0) > 0 ? this.market.priceAgo(s.symbol, 'mid', 2_000) : null;
    const moved = ago ? (mid(q) - ago) / tick : 0;
    const movesInto = (side: Side) => (s.moveGuard ?? 0) > 0 && (side === 'sell' ? moved >= s.moveGuard! : moved <= -s.moveGuard!) && (side === 'buy' ? inv >= 0 : inv <= 0);
    const want = mmQuotes(s, q, m, inv, mk, fair).filter((x) => !movesInto(x.side));
    // A ladder's front line: where a quote may stand at most (the touch, the skew and the edge as they are now, with no
    // step back). A ladder quote the touch came to is kept up to it - near the front of that queue is where its fills
    // are the bounce (a level that holds), not the sweep - and only one past it is pulled.
    const front = (s.levels ?? 1) > 1 ? mmQuotes({ ...s, offsetTicks: Math.min(0, s.offsetTicks), queueGuard: 0 }, q, m, inv, mk, fair) : want;
    // What it would quote without the guards: a side missing only because of a guard is pulled no sooner than half
    // a second after it went out, and quoted again no sooner than minRepriceMs after (no cancel storm on a queue or a
    // price that flickers around the line).
    const unguarded = (s.queueGuard ?? 0) > 0 || (s.moveGuard ?? 0) > 0 ? mmQuotes({ ...s, queueGuard: 0 }, q, m, inv, mk, fair) : want;
    const guardedAt = { ...((a.k.mguard as Record<string, number> | undefined) ?? {}) };
    const levels = Math.max(1, s.levels ?? 1);
    const live = this.live(a);
    const send: Array<{ side: Side; price: number; quantity: number; tif: ChildTif; tag: string }> = [];
    const pull: ChildOrder[] = [];
    for (const side of ['buy', 'sell'] as const) {
      const w = want.find((x) => x.side === side);
      const mine = live.filter((c) => c.side === side);
      const standing = mine.filter((c) => !c.cancelling);
      if (!w) {
        const guarded = unguarded.some((x) => x.side === side);
        if (guarded) {
          const ripe = standing.filter((c) => now - c.placedAt >= 500);
          if (ripe.length) guardedAt[side] = now;
          pull.push(...ripe);
        } else pull.push(...standing);
        continue;
      }
      if (!standing.length && !mine.length && (guardedAt[side] ?? 0) + s.minRepriceMs > now) continue;
      // How many quotes this side may have resting: one, or up to the ladder - never more than the cap could take
      // (the adding side) or than it holds (the unwinding side) if all of them filled.
      const adds = side === 'buy' ? inv >= 0 : inv <= 0;
      const room = adds ? Math.floor((s.maxInventoryUsd - Math.abs(inv) * mk) / s.orderUsd + 1e-9) : Math.ceil((Math.abs(inv) * mk) / s.orderUsd - 1e-9);
      const allowed = Math.max(1, Math.min(levels, room));
      const kept: ChildOrder[] = [];
      for (const c of [...standing].sort((x, y) => (side === 'buy' ? y.price - x.price : x.price - y.price))) {
        if (c.state !== 'open' || c.tif === 'ioc') {
          kept.push(c);
          continue;
        }
        const off = Math.abs(c.price - w.price) / tick;
        // In front of where it should be (the price came to it, the skew or the mark wants it further back): the one
        // a fill would hurt - pulled after a quarter second, not the re-price pause. A ladder's limit is its front line.
        const lim = levels > 1 ? front.find((x) => x.side === side)?.price ?? w.price : w.price;
        const ahead = side === 'buy' ? c.price > lim + 1e-12 : c.price < lim - 1e-12;
        if (ahead) {
          if ((levels > 1 || off >= s.chaseTicks - 1e-9) && now - c.placedAt >= 250) pull.push(c);
          else kept.push(c);
          continue;
        }
        // Behind: one quote a side re-prices after the pause; a ladder keeps it while it is within its levels.
        const old = now - c.placedAt >= s.minRepriceMs;
        const back = (side === 'buy' ? w.price - c.price : c.price - w.price) / tick;
        const tooFar = levels > 1 ? back > levels - 1 + 1e-9 : off >= s.chaseTicks - 1e-9 && !this.atOwnTouch(side, c.price, q);
        if (old && tooFar) pull.push(c);
        else kept.push(c);
      }
      // More than it may have: the farthest go.
      while (kept.length > allowed) pull.push(kept.pop()!);
      // A cancel not confirmed yet - sent before or now - still counts (it may still fill); and one quote at the price wanted is enough.
      const cancelling = mine.length - kept.length;
      if (kept.length + cancelling >= allowed || kept.some((c) => Math.abs(c.price - w.price) < tick / 2)) continue;
      // A side SoDEX refused waits (3 s, doubling to a minute) instead of going out again every step.
      if (Number((a.k.mretry as Record<string, number> | undefined)?.[side] ?? 0) > now) continue;
      // The unwinding side's new quote: what is left to unwind after the ones already resting.
      const restingQty = kept.reduce((x, c) => x + Math.max(0, c.quantity - c.filled), 0);
      const qty = adds ? w.quantity : Math.min(w.quantity, Math.max(minChildQty(m, w.price), floorStep(Math.abs(inv) - restingQty, m)));
      if (!adds && restingQty >= Math.abs(inv) - 1e-12) continue;
      send.push({ side, price: w.price, quantity: qty, tif: 'gtx', tag: side === 'buy' ? 'bid' : 'ask' });
    }
    a.k.mguard = guardedAt;
    if (pull.length) await this.cancelChildren(a, m, pull);
    if (!send.length || this.stopped(a)) return;
    const sent = await this.send(a, m, send);
    const back = { ...((a.k.mback as Record<string, number> | undefined) ?? {}) };
    const at = { ...((a.k.mretry as Record<string, number> | undefined) ?? {}) };
    for (const c of sent) {
      if (c.state === 'done' && c.filled <= 1e-12) {
        // Half a second first: most refusals are post-only ones (the touch moved under the quote), and the next step
        // prices from the fresh book; a refusal that repeats (a 429) still doubles to a minute.
        back[c.side] = Math.min(60_000, (back[c.side] ?? MM_RETRY_MS / 2) * 2);
        at[c.side] = Date.now() + back[c.side]!;
      } else delete back[c.side];
    }
    a.k.mback = back;
    a.k.mretry = at;
  }

  /** Grid: every level with a side rests there post-only; a fill moves the gap (onChildDone, bots.ts gridAfterFill). */
  private async stepGrid(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number, now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'grid' }>;
    if (await this.botLimitsHit(a, mk, now)) return;
    const prices = a.k.gp as number[];
    const sides = a.k.gs as GridSide[];
    if ((mk < s.low || mk > s.high) && s.outOfRange === 'stop') {
      const why = `The price (${mk}) left the range ${s.low}-${s.high}.`;
      if (!(await this.stopBot(a, 'expired', why))) await this.end(a, 'expired', why);
      return;
    }
    if (s.maxSpreadBps !== null && spreadBps(q) > s.maxSpreadBps) return this.hold(a, `Held: the spread (${spreadBps(q).toFixed(1)} bp) is wider than your ${s.maxSpreadBps} bp.`);
    const n = prices.length;
    const byLevel = new Map<number, ChildOrder[]>();
    for (const c of this.live(a)) {
      const i = gridLevelOf(c);
      if (i >= 0) byLevel.set(i, [...(byLevel.get(i) ?? []), c]);
    }
    const retry = (a.k.gretry as Record<string, number> | undefined) ?? {};
    const pull: ChildOrder[] = [];
    const send: Array<{ side: Side; price: number; quantity: number; tif: ChildTif; tag: string }> = [];
    for (let i = 0; i < n; i++) {
      const want = sides[i] ?? null;
      const here = byLevel.get(i) ?? [];
      // A level whose side changed (a fill moved the gap onto it) loses what rests there on the old side.
      pull.push(...here.filter((c) => !c.cancelling && c.side !== want));
      if (!want || here.length) continue;
      if ((retry[i] ?? 0) > now) continue;
      const p = prices[i]!;
      // Post-only: a level the price is at or through waits until it would rest (SoDEX would refuse it).
      if (want === 'buy' ? p >= q.ask : p <= q.bid) continue;
      send.push({ side: want, price: p, quantity: gridQty(s.orderUsd, p, m), tif: 'gtx', tag: `grid ${i + 1}/${n}` });
    }
    if (pull.length) await this.cancelChildren(a, m, pull);
    // One signed batch a step, at most 50 orders (the rest the next step).
    if (!send.length || this.stopped(a)) return;
    const sent = await this.send(a, m, send.slice(0, 50));
    // A level SoDEX refused in its answer waits before it goes out again - 3 s, doubling to a minute while it keeps
    // being refused - so one level it will not take never runs the whole grid into its refusal limit.
    const back = { ...((a.k.gback as Record<string, number> | undefined) ?? {}) };
    const at = { ...((a.k.gretry as Record<string, number> | undefined) ?? {}) };
    for (const c of sent) {
      const i = gridLevelOf(c);
      if (i < 0) continue;
      if (c.state === 'done' && c.filled <= 1e-12) {
        back[i] = Math.min(60_000, (back[i] ?? GRID_RETRY_MS / 2) * 2);
        at[i] = Date.now() + back[i]!;
      } else delete back[i];
    }
    a.k.gback = back;
    a.k.gretry = at;
  }

  private atOwnTouch(side: Side, price: number, q: Quote): boolean {
    return side === 'buy' ? price >= q.bid : price <= q.ask;
  }

  /* ----------------------------------------------------------- the kinds ----- */

  private async stepSchedule(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number, now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'twap' | 'vwap' }>;
    // A time-sliced close works the size and side the position had when it began.
    const total = typeof a.k.total === 'number' ? a.k.total : Number(s.quantity);
    const closeSide = a.k.closeSide as Side | undefined;
    if (this.isDone(a, m)) return this.end(a, 'done', 'Filled.');
    const start = a.startedAt!;
    const end = start + s.durationMs;
    const times = (a.k.times as number[]) ?? [];
    const weights = (a.k.weights as number[]) ?? [];
    const interval = s.durationMs / s.slices;
    let share = dueShare(times, weights, now);
    let lateShare = s.exec.style === 'taker' ? share : s.exec.style === 'hybrid' ? dueShare(times, weights, now - s.exec.makerShare * interval) : 0;
    if (s.kind === 'vwap' && s.adaptive) {
      const exp = Number(a.k.expectedTotal ?? 0);
      share = adaptiveShare(share, a.marketQty, exp);
      if (s.exec.style === 'taker') lateShare = share;
    }
    const finishing = now >= end || a.k.rush === true;
    if (now >= end && s.finish === 'leave' && !a.k.rush) {
      if (this.live(a).length) {
        await this.pullResting(a);
        return;
      }
      return this.end(a, this.isDone(a, m) ? 'done' : 'expired', `Time is up; ${dec(Math.max(0, total - a.filled))} ${m.base} left unfilled, as you chose.`);
    }
    const i = Math.max(0, nextSlice(times, now) < 0 ? times.length - 1 : nextSlice(times, now) - 1);
    // Where the schedule stands: a size change made now is spread from here on.
    if (a.k.share !== share) {
      a.k.share = share;
      this.dirty.add(a.id);
    }
    // Max participation caps what it fills per interval: its share of what the market traded, less what it filled itself in that time.
    let part: number | null = null;
    if (s.maxParticipation !== null && !finishing) {
      const win = Math.max(interval, 5_000);
      const vol = this.market.volume(s.symbol, win).qty;
      const mine = ((a.k.recent as number[][] | undefined) ?? []).filter((x) => x[0]! > now - win).reduce((x, y) => x + y[1]!, 0);
      part = Math.max(0, vol * s.maxParticipation - mine);
    }
    await this.work(a, m, q, mk, {
      due: finishing ? total : this.scheduleDue(a, total, share),
      late: finishing ? total : this.scheduleDue(a, total, lateShare),
      total,
      exec: s.exec,
      tag: finishing ? 'finish' : `slice ${i + 1}/${times.length}`,
      maxChild: s.kind === 'twap' && s.maxSliceQty !== null ? Number(s.maxSliceQty) : null,
      part,
      minChild: s.kind === 'twap' && s.minSliceQty !== null ? Number(s.minSliceQty) : null,
      ...(closeSide ? { side: closeSide, reduceOnly: true } : {}),
    });
  }

  private dueHistory(a: AlgoRecord, now: number, due: number): number[][] {
    const h = ((a.k.hist as number[][] | undefined) ?? []).filter((x) => x[0]! >= now - 10 * 60_000);
    if (!h.length || h[h.length - 1]![1] !== due) h.push([now, due]);
    a.k.hist = h.slice(-300);
    return a.k.hist as number[][];
  }

  private dueAgo(h: number[][], at: number): number {
    let v = 0;
    for (const [t, d] of h) if (t! <= at) v = d!;
    return v;
  }

  private async stepPov(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number, now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'pov' }>;
    const total = Number(s.quantity);
    if (this.isDone(a, m)) return this.end(a, 'done', 'Filled.');
    const ended = s.endAt !== null && now >= s.endAt;
    if (ended && s.finish === 'leave' && !a.k.rush) {
      if (this.live(a).length) return this.pullResting(a);
      return this.end(a, 'expired', `End time reached; ${dec(total - a.filled)} ${m.base} left unfilled, as you chose.`);
    }
    // Its share of ALL the market traded since it began, its own fills included (the usual POV and FIX's
    // OrderPercentOfTotalVolume): filled = rate x (others + filled), so filled = others x rate / (1 - rate).
    // What others traded is counted print by print from the live trade stream (onPrint), never a forecast.
    const due = Math.min(total, povDue(s.rate, a.marketQty));
    const h = this.dueHistory(a, now, due);
    const late = s.exec.style === 'taker' ? due : s.exec.style === 'hybrid' ? this.dueAgo(h, now - LATE_MS) : 0;
    const finishing = ended || a.k.rush === true;
    await this.work(a, m, q, mk, {
      due: finishing ? total : due,
      late: finishing ? total : late,
      total,
      exec: s.exec,
      tag: finishing ? 'finish' : `${Math.round(s.rate * 100)}% of volume`,
      maxChild: s.maxChildQty !== null ? Number(s.maxChildQty) : null,
    });
  }

  /**
   * A DCA: each installment is an order of its own - its own size (its USD at
   * the price when it came due), its own time, its own child on SoDEX - and is
   * never merged into another (owner, 2026-10-28). A maker installment that has
   * not filled keeps resting by itself while the next one is placed beside it;
   * installments that come due together (after a wait) go out together, each
   * as its own order. SoDEX refusing one more resting order (its open-order or
   * margin limits) holds the algo with the reason (onLimit), never merges.
   */
  private async stepDca(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number, now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'dca' }>;
    const start = a.startedAt!;
    let done = Number(a.k.done ?? 0);
    let skipped = Number(a.k.skipped ?? 0);
    let spent = Number(a.k.spentUsd ?? 0);
    let target = Number(a.k.targetQty ?? 0);
    const budget = s.maxTotalUsd ?? Infinity;
    // An algo from before installments were kept apart: what it had due is one installment.
    if (!Array.isArray(a.k.inst)) a.k.inst = done > 0 ? [{ n: done, qty: target, at: start, filled: Math.max(0, a.filled - this.live(a).reduce((x, c) => x + c.filled, 0)), counted: [] }] : [];
    const insts = a.k.inst as DcaInstallment[];
    const tagOf = (n: number) => `order ${n}/${s.orders}`;
    // Every installment whose time has come, in order: each with its own size.
    while (done + skipped < s.orders && start + (done + skipped) * s.intervalMs <= now && spent < budget - 1e-9) {
      const px = s.side === 'buy' ? q.ask : q.bid;
      const outside = s.limitPrice !== null && (s.side === 'buy' ? mk > s.limitPrice : mk < s.limitPrice);
      if (outside) {
        if (s.outOfBand === 'wait') {
          await this.hold(a, `Waiting: the price is ${s.side === 'buy' ? 'above' : 'below'} your limit of ${s.limitPrice}.`);
          break;
        }
        skipped++;
        await this.event(a, 'skip', `Order ${done + skipped} of ${s.orders} skipped: the price ${mk} is ${s.side === 'buy' ? 'above' : 'below'} your limit.`);
        continue;
      }
      let usd = s.perOrderUsd;
      const avg = a.filled > 0 ? a.filledValue / a.filled : null;
      if (s.dipPct !== null && avg !== null && (s.side === 'buy' ? px <= avg * (1 - s.dipPct) : px >= avg * (1 + s.dipPct))) {
        usd *= s.dipMultiplier;
        await this.event(a, 'info', `Dip boost: ${s.dipMultiplier}x this order (the price is ${(Math.abs(px / avg - 1) * 100).toFixed(1)}% from your average).`);
      }
      usd = Math.min(usd, budget - spent);
      // Its USD at the price, on the step - raised by less than a step where the rounding alone would put it under SoDEX's minimum.
      const raw = floorStep(usd / px, m);
      const qty = raw < minChildQty(m, px) && usd >= m.minNotional - 1e-9 ? minChildQty(m, px) : raw;
      done++;
      spent += usd;
      target += qty;
      insts.push({ n: done, qty, at: start + (done + skipped - 1) * s.intervalMs, filled: 0, counted: [] });
    }
    a.k.done = done;
    a.k.skipped = skipped;
    a.k.spentUsd = spent;
    a.k.targetQty = target;
    this.dirty.add(a.id);
    const over = done + skipped >= s.orders || spent >= budget - 1e-9;
    const liveOf = (n: number) => this.live(a).filter((c) => c.tag === tagOf(n));
    // What an installment still has to fill: under SoDEX's smallest order it is over (dust that one order cannot carry).
    const leftOf = (i: DcaInstallment) => i.qty - i.filled - liveOf(i.n).reduce((x, c) => x + c.filled, 0);
    const open = insts.filter((i) => leftOf(i) >= minChildQty(m, mk) - 1e-12 || liveOf(i.n).length);
    if (over && !open.length && !this.live(a).length) return this.end(a, 'done', `${done} order${done === 1 ? '' : 's'} filled${skipped ? `, ${skipped} skipped` : ''}.`);
    const list: Array<{ side: Side; price: number; quantity: number; tif: ChildTif; tag: string }> = [];
    const lateAfter = Math.min(LATE_MS * 4, s.exec.makerShare * s.intervalMs);
    for (const i of open) {
      const kids = liveOf(i.n);
      const late = a.k.rush === true || s.exec.style === 'taker' || (s.exec.style === 'hybrid' && now - i.at >= lateAfter);
      if (kids.length) {
        const c = kids[0]!;
        if (c.state !== 'open' || c.cancelling || c.tif === 'ioc') continue;
        // Its own resting order: re-priced when the touch moved away, pulled to take when it is overdue (hybrid) or rushed.
        const price = makerPrice(s.side, q, s.exec.offsetTicks, null, m, s.limitPrice);
        const off = Math.abs(c.price - price) / Number(m.tickSize);
        if (late || (!this.atOwnTouch(s.side, c.price, q) && off >= s.exec.chaseTicks - 1e-9 && now - c.placedAt >= 1_500)) await this.cancelChildren(a, m, [c]);
        continue;
      }
      const left = floorStep(leftOf(i), m);
      if (late) {
        if (now - Number(a.k.missAt ?? 0) < TAKER_RETRY_MS) continue;
        const from = this.slipBase(s.symbol, s.exec, q);
        if (from === undefined) {
          await this.hold(a, `Held: no fresh ${SLIP_FROM_NAMES[s.exec.slipFrom ?? 'touch'].toLowerCase()} to measure your max slippage from.`);
          return;
        }
        const price = takerPrice(s.side, q, s.exec.slippageBps, m, mk, s.limitPrice, from);
        if (price === null) {
          await this.hold(a, `Held: the price is past your limit of ${s.limitPrice}.`);
          return;
        }
        list.push({ side: s.side, price, quantity: Math.min(left, maxOrderQty(m, price)), tif: 'ioc', tag: tagOf(i.n) });
      } else {
        const price = makerPrice(s.side, q, s.exec.offsetTicks, null, m, s.limitPrice);
        list.push({ side: s.side, price, quantity: Math.min(left, maxOrderQty(m, price)), tif: 'gtx', tag: tagOf(i.n) });
      }
    }
    if (!list.length) return;
    if (s.maxSpreadBps !== null && spreadBps(q) > s.maxSpreadBps) {
      await this.hold(a, `Held: the spread (${spreadBps(q).toFixed(1)} bp) is wider than your ${s.maxSpreadBps} bp.`);
      return;
    }
    await this.send(a, m, list.filter((x) => x.quantity >= minChildQty(m, x.price) - 1e-12));
  }

  /** A DCA child settled: what it filled is its installment's (counted once, however many final updates SoDEX sends). */
  private dcaChildDone(a: AlgoRecord, c: ChildOrder): void {
    const i = ((a.k.inst as DcaInstallment[] | undefined) ?? []).find((x) => c.tag === `order ${x.n}/${(a.spec as Extract<AlgoSpec, { kind: 'dca' }>).orders}`);
    if (!i || i.counted.includes(c.clOrdID)) return;
    i.counted.push(c.clOrdID);
    if (i.counted.length > 50) i.counted.splice(0, i.counted.length - 50);
    i.filled += c.filled;
    this.dirty.add(a.id);
  }

  private async stepIceberg(a: AlgoRecord, m: MarketInfo, q: Quote, now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'iceberg' }>;
    const total = Number(s.quantity);
    const live = this.live(a);
    if (!live.length && this.isDone(a, m)) return this.end(a, 'done', 'Filled.');
    if (a.k.rush) {
      // A rush takes the rest: a clip still resting (pegged or at a fixed price) is pulled first.
      const c = live.find((x) => x.tif !== 'ioc' && x.state === 'open' && !x.cancelling);
      if (c) return this.cancelChildren(a, m, [c]);
      return this.work(a, m, q, this.market.mark(s.symbol)?.mark ?? mid(q), { due: total, late: total, total, exec: { style: 'taker', slippageBps: 50, offsetTicks: 0, chaseTicks: 1, makerShare: 0.5 }, tag: 'rush' });
    }
    const pegged = s.price === null;
    const tif: ChildTif = s.postOnly ? 'gtx' : 'gtc';
    const desired = pegged ? makerPrice(s.side, q, s.pegOffsetTicks, null, m, s.limitPrice) : s.price!;
    if (live.length) {
      const c = live[0]!;
      if (c.state !== 'open' || c.cancelling) return;
      // A clip that is the best price on its side is not re-priced off its own price.
      if (pegged && !this.atOwnTouch(s.side, c.price, q) && Math.abs(c.price - desired) / Number(m.tickSize) >= s.chaseTicks - 1e-9 && now - c.placedAt >= 1_000) {
        // What is left of it shows again at the new price - counted when SoDEX confirms the cancel, since a fill may land meanwhile (onChildDone).
        a.k.reprice = c.clOrdID;
        await this.cancelChildren(a, m, [c]);
      }
      return;
    }
    if (typeof a.k.refillAt === 'number' && now < a.k.refillAt) return;
    // A fixed post-only price at or through the book would only be refused: it waits for the book to move off it.
    if (!pegged && s.postOnly && (s.side === 'buy' ? desired >= q.ask : desired <= q.bid)) return this.hold(a, `Waiting: your price of ${desired} is at or through the book, where a post-only clip would be refused.`);
    if (s.maxSpreadBps !== null && spreadBps(q) > s.maxSpreadBps) return this.hold(a, `Held: the spread (${spreadBps(q).toFixed(1)} bp) is wider than your ${s.maxSpreadBps} bp.`);
    const room = total - a.filled;
    const minQ = minChildQty(m, desired);
    const refill = typeof a.k.clipLeft === 'number' && a.k.clipLeft > 0;
    let qty = refill ? (a.k.clipLeft as number) : floorStep(jitter(Number(s.displayQty), s.displayJitter, makeRng(a.seed + a.childCount)), m);
    qty = Math.max(qty, minQ);
    if (room - qty < minQ) qty = room;
    qty = floorStep(Math.min(qty, room, maxOrderQty(m, desired)), m);
    if (qty < minQ) return a.filled > 0 ? this.end(a, 'done', 'Filled (the rest is under SoDEX\'s minimum order).') : this.end(a, 'failed', 'Under SoDEX\'s minimum order size: nothing could be sent.');
    const clip = Number(a.k.clip ?? 0) + (refill ? 0 : 1);
    await this.send(a, m, [{ side: s.side, price: desired, quantity: qty, tif, tag: `clip ${clip}` }], () => {
      delete a.k.clipLeft;
      a.k.clip = clip;
    });
  }

  private async stepChase(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number, now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'chase' }>;
    const total = Number(s.quantity);
    const live = this.live(a);
    if (!live.length && this.isDone(a, m)) return this.end(a, 'done', 'Filled.');
    // How far it may chase: from where it started, and never past the limit price.
    const startRef = typeof a.k.startRef === 'number' ? a.k.startRef : s.side === 'buy' ? q.bid : q.ask;
    let cap = s.limitPrice;
    let chaseCap: number | null = null;
    if (s.maxChaseBps !== null) {
      chaseCap = s.side === 'buy' ? startRef * (1 + s.maxChaseBps / 10_000) : startRef * (1 - s.maxChaseBps / 10_000);
      cap = cap === null ? chaseCap : s.side === 'buy' ? Math.min(cap, chaseCap) : Math.max(cap, chaseCap);
    }
    // The max chase is reached once the price it would follow is past it (types.ts: onEnd applies "when the cap or the time is reached").
    // The order's own price at the touch does not count: that touch is the order itself.
    const mine = live.find((c) => c.tif !== 'ioc');
    const free = makerPrice(s.side, q, s.offsetTicks, s.offsetBps, m, s.limitPrice);
    const capped = chaseCap !== null && !(mine && this.atOwnTouch(s.side, mine.price, q)) && (s.side === 'buy' ? free > chaseCap : free < chaseCap);
    const timedOut = s.timeoutMs !== null && now - a.startedAt! >= s.timeoutMs;
    if (timedOut || capped || a.k.rush || a.k.ending) {
      const how = a.k.rush ? 'take' : s.onEnd;
      if (!a.k.ending) {
        a.k.ending = true;
        a.k.endWhy = a.k.rush ? 'rush' : timedOut ? 'time' : 'cap';
        this.dirty.add(a.id);
      }
      const why = a.k.endWhy === 'cap' ? `The price moved past your max chase of ${s.maxChaseBps} bp` : 'Time is up';
      if (how === 'take') return this.work(a, m, q, mk, { due: total, late: total, total, exec: { style: 'taker', slippageBps: 50, offsetTicks: 0, chaseTicks: 1, makerShare: 0.5 }, tag: 'take the rest' });
      if (how === 'rest') {
        const c = live.find((x) => x.tif !== 'ioc');
        // Time ran out in the middle of a re-price: wait for the cancel to settle, then leave the rest at the
        // price it would have gone back at - never end with nothing resting when the trader chose "rest".
        if (c && (c.state !== 'open' || c.cancelling)) return;
        if (!c && !a.k.restSent && !this.isDone(a, m)) {
          const price = makerPrice(s.side, q, s.offsetTicks, s.offsetBps, m, cap);
          const qty = floorStep(Math.min(total - a.filled, maxOrderQty(m, price)), m);
          if (qty >= minChildQty(m, price)) {
            a.k.restSent = true;
            await this.send(a, m, [{ side: s.side, price, quantity: qty, tif: 'gtx', tag: 'left resting' }]);
            return;
          }
        }
        if (c) c.tag = 'left resting';
        return this.end(a, 'expired', c ? `${why}: left resting at ${c.price} on SoDEX, as you chose.` : `${why}.`, { keep: c ? [c.clOrdID] : [] });
      }
      return this.end(a, 'expired', `${why}; ${dec(total - a.filled)} ${m.base} left unfilled.`);
    }
    const price = makerPrice(s.side, q, s.offsetTicks, s.offsetBps, m, cap);
    const room = total - a.filled;
    if (live.length) {
      const c = live[0]!;
      if (c.state !== 'open' || c.cancelling) return;
      const off = Math.abs(c.price - price) / Number(m.tickSize);
      // The best price on its side already: the touch it would follow is its own, so it stays.
      if (!this.atOwnTouch(s.side, c.price, q) && off >= s.chaseTicks - 1e-9 && now - c.placedAt >= s.minRepriceMs) await this.cancelChildren(a, m, [c]);
      return;
    }
    const qty = floorStep(Math.min(room, maxOrderQty(m, price)), m);
    if (qty < minChildQty(m, price)) return a.filled > 0 ? this.end(a, 'done', 'Filled.') : this.end(a, 'failed', 'Under SoDEX\'s minimum order size: nothing could be sent.');
    if (s.maxSpreadBps !== null && spreadBps(q) > s.maxSpreadBps) return this.hold(a, `Held: the spread (${spreadBps(q).toFixed(1)} bp) is wider than your ${s.maxSpreadBps} bp.`);
    await this.send(a, m, [{ side: s.side, price, quantity: qty, tif: 'gtx', tag: 'chase' }]);
  }

  /**
   * A ladder: every level rests at its price. `k.queue` holds the levels
   * still to go out - all of them at first (in signed batches of 50), the ones
   * a pause pulled after it, each sent again for what it has not filled once
   * SoDEX no longer has it. A batch held (the region's cap, no key) waits for
   * the next step; it is never counted as gone out.
   */
  private async stepScale(a: AlgoRecord, m: MarketInfo, _q: Quote, _now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'scale' }>;
    const total = Number(s.quantity);
    const ladder = scaleLadder(s, m, a.seed).filter((l) => l.qty >= minChildQty(m, l.price));
    if (!ladder.length) return this.end(a, 'failed', 'No level of this ladder reaches SoDEX\'s minimum order.');
    a.k.levels = ladder.length;
    if (!Array.isArray(a.k.queue)) a.k.queue = a.k.placed ? [] : ladder.map((_, i) => i);
    const tif: ChildTif = s.postOnly ? 'gtx' : 'gtc';
    while ((a.k.queue as number[]).length) {
      if (this.stopped(a)) return;
      const queue = a.k.queue as number[];
      // A level still on SoDEX (its cancel not yet confirmed) is not placed a second time.
      const working = new Set(this.live(a).map(levelOf));
      if (queue.some((i) => working.has(i))) return;
      const batch = queue.slice(0, 50);
      const rest = queue.slice(batch.length);
      const fills = (a.k.lvl as number[] | undefined) ?? [];
      let budget = total - a.filled - this.pendingQty(a);
      const list: Array<{ side: Side; price: number; quantity: number; tif: ChildTif; tag: string }> = [];
      for (const i of batch) {
        const l = ladder[i];
        if (!l) continue;
        const qty = floorStep(Math.min(l.qty - (fills[i] ?? 0), budget), m);
        if (qty < minChildQty(m, l.price)) continue;
        list.push({ side: s.side, price: l.price, quantity: qty, tif, tag: `level ${i + 1}/${ladder.length}` });
        budget -= qty;
      }
      const commit = () => {
        a.k.queue = rest;
        if (!rest.length) a.k.placed = true;
      };
      if (!list.length) {
        commit();
        this.dirty.add(a.id);
        continue;
      }
      const sent = await this.send(a, m, list, commit);
      if (!sent.length) return;
    }
    if (this.live(a).length) return;
    if (this.isDone(a, m)) return this.end(a, 'done', 'Every level filled.');
    return this.end(a, 'expired', `${dec(total - a.filled)} ${m.base} of the ladder did not fill (cancelled or refused).`);
  }

  private async stepSwarm(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number, now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'swarm' }>;
    const total = Number(s.quantity);
    if (this.live(a).length) return;
    if (this.isDone(a, m)) return this.end(a, 'done', 'Filled.');
    const waveAt = Number(a.k.waveAt ?? 0);
    if (now < waveAt && !a.k.rush) return;
    if (s.maxSpreadBps !== null && spreadBps(q) > s.maxSpreadBps) return this.hold(a, `Held: the spread (${spreadBps(q).toFixed(1)} bp) is wider than your ${s.maxSpreadBps} bp.`);
    const price = takerPrice(s.side, q, s.slippageBps, m, mk, s.limitPrice);
    if (price === null) return this.hold(a, `Held: the price is past your limit of ${s.limitPrice}.`);
    const clips = (a.k.clips as number[]) ?? [];
    let next = Number(a.k.next ?? 0);
    let pool = total - a.filled;
    const minQ = minChildQty(m, price);
    const most = maxOrderQty(m, price);
    const wave: number[] = [];
    let retriesLeft = Number(a.k.retriesLeft ?? 0);
    if (next < clips.length) {
      // Clips under SoDEX's minimum are merged into the next one, never dropped; the last ones, still under it, go with the child before them.
      let carry = 0;
      while (wave.length < s.inFlight && next < clips.length && pool >= minQ) {
        carry += clips[next]!;
        next++;
        if (carry < minQ - 1e-12 && next < clips.length) {
          await this.noteOnce(a, 'min', `Clip ${next} is under ${minWords(m, price)} at this price, so it goes out with the next one.`);
          continue;
        }
        let qty = Math.min(carry, pool);
        if (pool - qty < minQ) qty = pool;
        qty = floorStep(Math.min(qty, most), m);
        carry = 0;
        if (qty < minQ) {
          if (wave.length) {
            const add = floorStep(Math.min(qty, most - wave[wave.length - 1]!), m);
            wave[wave.length - 1]! += add;
            pool -= add;
          }
          break;
        }
        wave.push(qty);
        pool -= qty;
      }
    } else {
      // Every planned clip went out; what did not fill goes again, `retries` times.
      if (retriesLeft <= 0 || pool < minQ) return this.end(a, 'expired', `${dec(pool)} ${m.base} did not fill after ${s.retries} retr${s.retries === 1 ? 'y' : 'ies'}.`);
      retriesLeft--;
      const avg = total / Math.max(1, clips.length);
      const n = Math.max(1, Math.min(s.inFlight, Math.round(pool / avg)));
      for (let i = 0; i < n && pool >= minQ; i++) {
        let qty = i === n - 1 ? pool : floorStep(pool / (n - i), m);
        if (pool - qty < minQ) qty = pool;
        qty = floorStep(Math.min(qty, most), m);
        if (qty < minQ) break;
        wave.push(qty);
        pool -= qty;
      }
      if (wave.length) await this.event(a, 'info', `Retrying ${dec(total - a.filled)} ${m.base} that did not fill.`);
    }
    if (!wave.length) {
      // What is left can never be one order: the end, not a wait.
      if (pool < minQ) return a.filled > 0 ? this.end(a, 'done', `Filled; ${dec(pool)} ${m.base} under SoDEX's minimum order was left.`) : this.end(a, 'failed', 'Under SoDEX\'s minimum order size: nothing could be sent.');
      return;
    }
    const n = Number(a.k.wave ?? 0) + 1;
    await this.send(a, m, wave.map((qty) => ({ side: s.side, price, quantity: qty, tif: 'ioc' as ChildTif, tag: `wave ${n}` })), () => {
      a.k.next = next;
      a.k.retriesLeft = retriesLeft;
      a.k.waveAt = now + s.waveMs;
      a.k.wave = n;
    });
  }

  private async stepConditional(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number, now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'conditional' }>;
    if (a.k.fired) return this.act(a, m, q, mk);
    if (s.expiresAt !== null && now >= s.expiresAt) return this.end(a, 'expired', 'Its time ran out before the conditions held.');
    const ok = s.conditions.map((c, i) => this.conditionHolds(a, c, i, now));
    a.k.ok = ok;
    const met = s.match === 'all' ? ok.every(Boolean) : ok.some(Boolean);
    if (!met) {
      if (a.k.holdSince) delete a.k.holdSince;
      this.dirty.add(a.id);
      return;
    }
    if (typeof a.k.holdSince !== 'number') a.k.holdSince = now;
    if (now - (a.k.holdSince as number) < s.holdMs) return;
    if (!s.paper && s.conditions.some((c) => c.type === 'position') && !(await this.positionsAgree(a, s, now))) return;
    if (this.stopped(a)) return;
    a.k.fired = now;
    // Written before it acts: after a crash it carries on from here, it never fires a second time.
    await this.save(a);
    await this.event(a, 'info', `Conditions held${s.holdMs ? ` for ${Math.round(s.holdMs / 1000)} s` : ''}: acting.`);
    return this.act(a, m, q, mk);
  }

  /**
   * What a fired conditional does. Every branch may run again after a
   * restart: whatever it sent was in the store before it left (send), so it
   * picks up from there instead of acting twice.
   */
  private async act(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'conditional' }>;
    const t = s.then;
    if (t.type === 'market') {
      if (typeof a.k.takeQty !== 'number') a.k.takeQty = Number(t.quantity);
      return this.afterFire(a, m, q, mk);
    }
    if (t.type === 'close') {
      if (typeof a.k.takeQty !== 'number') {
        const pos = await this.positionConfirmed(a, s.symbol);
        if (this.stopped(a)) return;
        // A read that failed is not "no position": it holds and reads again on the next step; only a confirmed 0 ends it.
        if (pos === null) return this.hold(a, `Fired; your position on ${s.symbol} could not be read - trying again.`);
        if (pos === 'disagree') return this.hold(a, `Fired; SoDEX's reads of your position on ${s.symbol} disagree - reading again.`);
        if (!pos) return this.end(a, 'expired', `There was no position on ${s.symbol} to close.`);
        a.k.takeQty = floorStep(Math.abs(pos) * t.share, m);
        a.k.closeSide = pos > 0 ? 'sell' : 'buy';
        this.dirty.add(a.id);
      }
      return this.afterFire(a, m, q, mk);
    }
    if (t.type === 'limit') {
      if (!a.children.length) {
        const sent = await this.send(a, m, [{ side: s.side, price: t.price, quantity: Number(t.quantity), tif: t.postOnly ? 'gtx' : 'gtc', tag: 'trigger', reduceOnly: s.reduceOnly }]);
        // Held (no key here, the region's cap): it tries again on the next step.
        if (!sent.length) return;
      }
      const c = a.children[a.children.length - 1]!;
      if (LIVE.has(c.state)) return this.end(a, 'done', `Placed a limit ${s.side} of ${t.quantity} at ${t.price}; it rests on SoDEX.`, { keep: [c.clOrdID] });
      if (c.filled > 0) return this.end(a, 'done', `The limit ${s.side} at ${t.price} filled ${dec(c.filled)}.`);
      return this.end(a, 'failed', `SoDEX refused the limit ${s.side} of ${t.quantity} at ${t.price}; the reason is in the log.`);
    }
    // Started already (before a restart): it is not started twice.
    const started = [...this.algos.values()].find((x) => x.parentId === a.id);
    if (started) {
      delete a.k.child;
      return this.end(a, 'done', `Started a ${ALGO_NAMES[started.spec.kind]} on ${started.spec.symbol}.`);
    }
    try {
      // It runs as its parent does: a practice run starts a practice run, under the same region rules.
      const child = await this.add({ owner: a.owner, accountId: a.accountId, mode: a.mode, spec: { ...t.algo, paper: s.paper || t.algo.paper }, parentId: a.id, consent: a.consent, country: a.country, observedCountry: a.observedCountry });
      if (FINAL_STATUSES.has(a.status)) {
        await this.cancel(child.id);
        return;
      }
      if (a.status === 'paused') {
        // Paused while it was starting the algo: the algo waits with it, and both go on (or are cancelled) together.
        a.k.child = child.id;
        await this.save(a);
        await this.pause(child.id);
        return;
      }
      return this.end(a, 'done', `Started a ${ALGO_NAMES[child.spec.kind]} on ${child.spec.symbol}${child.spec.paper ? ' (paper)' : ''}.`);
    } catch (e) {
      return this.end(a, 'failed', `Could not start the ${ALGO_NAMES[t.algo.kind]}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** A fired conditional or trailing stop: take `k.takeQty` (a chase first, for a trailing stop that asks for one). */
  private async afterFire(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number): Promise<void> {
    const s = a.spec;
    const total = Number(a.k.takeQty ?? 0);
    if (!(total > 0)) return this.end(a, 'expired', 'Nothing to send.');
    if (!this.live(a).length && a.filled >= total - Number(m.stepSize) / 2) return this.end(a, 'done', 'Filled.');
    const side = (a.k.closeSide as Side | undefined) ?? s.side;
    const slip = s.kind === 'conditional' && (s.then.type === 'market' || s.then.type === 'close') ? s.then.slippageBps : s.kind === 'trailing' ? s.slippageBps : 50;
    const chasing = s.kind === 'trailing' && s.exit === 'chase' && Date.now() - Number(a.k.fired) < s.chaseMs;
    // A close works on the position's side, reduce-only, whatever side the algo was placed with.
    await this.work(a, m, q, mk, {
      side,
      reduceOnly: a.k.closeSide !== undefined ? true : undefined,
      due: total,
      late: chasing ? 0 : total,
      total,
      exec: { style: chasing ? 'maker' : 'taker', slippageBps: slip, offsetTicks: 0, chaseTicks: 1, makerShare: 0.5 },
      tag: s.kind === 'trailing' ? 'trailing stop' : 'trigger',
      minRepriceMs: 1_000,
    });
  }

  private async stepTrailing(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number, now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'trailing' }>;
    if (a.k.fired) {
      // Fired, but its size is not known yet (the position read failed, or a pause landed during it): read again.
      if (typeof a.k.takeQty !== 'number' && !(await this.trailingSize(a, m))) return;
      return this.afterFire(a, m, q, mk);
    }
    const price = s.source === 'last' ? (this.market.last(s.symbol)?.price ?? mk) : mk;
    const st = (a.k.trail as TrailState | undefined) ?? { armed: false, extreme: null };
    const r = trail(st, s.side, price, s);
    const wasArmed = st.armed;
    a.k.trail = r.state;
    a.k.stop = r.stop;
    this.dirty.add(a.id);
    if (!wasArmed && r.state.armed && s.activationPrice !== null) await this.event(a, 'info', `Activated at ${price}; trailing from here.`);
    if (!r.fired) return;
    a.k.fired = now;
    // Written before it reads or sends: a stop that fired stays fired (after a pause, a failed read, a restart).
    await this.save(a);
    await this.event(a, 'info', `Fired: ${s.source} ${price} reached the stop at ${r.stop?.toFixed(6).replace(/\.?0+$/, '')}.`);
    if (!(await this.trailingSize(a, m))) return;
    return this.afterFire(a, m, q, mk);
  }

  /**
   * A fired trailing stop's size: its own, or the whole position it closes.
   * false: not known yet - the read failed (it holds and reads again on the
   * next step), it was paused or cancelled meanwhile, or there is no such
   * position (a confirmed 0: it ends).
   */
  private async trailingSize(a: AlgoRecord, m: MarketInfo): Promise<boolean> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'trailing' }>;
    if (s.quantity !== null) {
      a.k.takeQty = Number(s.quantity);
      return true;
    }
    const pos = await this.positionConfirmed(a, s.symbol);
    if (this.stopped(a)) return false;
    if (pos === null || pos === 'disagree') {
      await this.hold(a, pos === null ? `Fired; your position on ${s.symbol} could not be read - trying again.` : `Fired; SoDEX's reads of your position on ${s.symbol} disagree - reading again.`);
      return false;
    }
    const right = s.side === 'sell' ? pos > 0 : pos < 0;
    if (!right) {
      await this.end(a, 'expired', `Fired, but there was no ${s.side === 'sell' ? 'long' : 'short'} position on ${s.symbol} to close.`);
      return false;
    }
    a.k.takeQty = floorStep(Math.abs(pos), m);
    this.dirty.add(a.id);
    return true;
  }

  /**
   * A basket: each market becomes an algo of its own (a swarm or a TWAP),
   * sized from its USD at the mark when it starts, all started together; the
   * basket ends when every leg has.
   */
  private async stepBasket(a: AlgoRecord): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'basket' }>;
    // Paused while its legs were starting: the legs not yet started start once it runs again.
    const resuming = a.k.legsPaused === true && Array.isArray(a.k.legs);
    if (!a.k.legs || resuming) {
      const specs: Array<Record<string, unknown>> = [];
      for (const l of s.legs) {
        const lm = this.markets.get(l.symbol);
        if (!lm) return this.end(a, 'failed', `${l.symbol} is not listed on SoDEX perps; no leg was started.`);
        // Every leg must be able to start before any is: a basket never runs on some of its markets only.
        if (lm.status !== 'TRADING') return this.end(a, 'failed', `SoDEX is not trading ${lm.name} right now; no leg was started.`);
        const lq = this.market.quote(l.symbol);
        const px = this.market.mark(l.symbol)?.mark ?? (lq ? mid(lq) : null);
        if (!px) return this.hold(a, `Waiting for a price of ${l.symbol}.`);
        const qty = floorStep(l.usd / px, lm);
        if (qty < minChildQty(lm, px)) return this.end(a, 'failed', `${l.symbol}: $${l.usd} is under SoDEX's minimum order.`);
        const common = { symbol: l.symbol, side: l.side, reduceOnly: s.reduceOnly, leverage: s.leverage, marginMode: s.marginMode, paper: s.paper, maxSpreadBps: s.maxSpreadBps, label: `${s.label ?? 'Basket'}: ${l.symbol}` };
        const spec =
          s.style === 'swarm'
            ? { ...common, kind: 'swarm', quantity: dec(qty), clips: s.clips, inFlight: s.inFlight, waveMs: s.waveMs, sizeJitter: 0.2, slippageBps: s.slippageBps, retries: 2 }
            : { ...common, kind: 'twap', quantity: dec(qty), durationMs: s.durationMs, slices: s.slices, sizeJitter: 0.15, timeJitter: 0.2, exec: { style: 'taker', slippageBps: s.slippageBps }, finish: 'take' };
        try {
          parseAlgoSpec(spec);
        } catch (e) {
          return this.end(a, 'failed', `${l.symbol}: ${e instanceof Error ? e.message : String(e)}; no leg was started.`);
        }
        specs.push(spec);
      }
      // Each leg is written down as it starts: after a crash half-way, the legs that started are known (and stopped).
      if (!a.k.legs) {
        a.k.legs = [];
        await this.save(a);
      }
      const ids = a.k.legs as string[];
      if (resuming) {
        // A leg written to the store but not yet to the basket's list (the pause landed in between) is adopted, not started twice.
        for (const x of this.list(a.owner).reverse()) if (x.parentId === a.id && !ids.includes(x.id)) ids.push(x.id);
        delete a.k.legsPaused;
      }
      // Legs start in order: the first ids.length of them are running already.
      for (const [i, spec] of specs.entries()) {
        if (i < ids.length) continue;
        if (this.stopped(a)) break;
        try {
          const child = await this.add({ owner: a.owner, accountId: a.accountId, mode: a.mode, spec, parentId: a.id, consent: a.consent, seed: (a.seed + i + 1) >>> 0, country: a.country, observedCountry: a.observedCountry });
          ids.push(child.id);
          await this.save(a);
          // Cancelled or paused while this leg was being added (after the basket passed it on to its legs): the leg follows at once, it never trades on its own.
          if (FINAL_STATUSES.has(a.status)) {
            await this.end(child, 'cancelled', `Stopped with its basket: ${a.statusReason ?? 'it ended'}`);
            return;
          }
          if (a.status === 'paused') await this.pause(child.id);
        } catch (e) {
          return this.end(a, 'failed', `${String(spec.symbol)} could not start (${e instanceof Error ? e.message : String(e)}); the legs already started are stopped.`);
        }
      }
      if (FINAL_STATUSES.has(a.status)) return;
      if (ids.length < specs.length) {
        // Paused half-way: the rest start on the next step after it is resumed (not "stopped while its legs were starting").
        a.k.legsPaused = true;
        await this.save(a);
        return;
      }
      a.k.legsStarted = true;
      await this.save(a);
      await this.event(a, 'info', `Started ${specs.length} legs: ${s.legs.map((l) => `${l.side} $${l.usd} ${l.symbol}`).join(', ')}.`);
      return;
    }
    // Legs written down but not all started: it stopped half-way (a crash). It is not left running on some markets only.
    if (!a.k.legsStarted && (a.k.legs as string[]).length < s.legs.length) return this.end(a, 'failed', 'The basket stopped while its legs were starting; the legs already started are stopped.');
    const legs = this.legsOf(a);
    if (legs.length && legs.every((c) => FINAL_STATUSES.has(c.status))) {
      const short = legs.filter((c) => c.status !== 'done');
      return this.end(a, short.length ? 'expired' : 'done', short.length ? `${short.length} of ${legs.length} markets did not fill in full (${short.map((c) => c.spec.symbol).join(', ')}).` : 'Every market filled.');
    }
  }

  /** A bracket: the entry (a taker with a slippage cap, or one resting limit); its exits follow what fills. */
  private async stepBracket(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'bracket' }>;
    const total = Number(s.quantity);
    if (!this.live(a).length && this.isDone(a, m)) return this.end(a, 'done', s.paper ? 'Entered; its exits are watched on the paper book.' : 'Entered; its exits are on SoDEX.');
    if (s.entry === 'market') {
      return this.work(a, m, q, mk, { due: total, late: total, total, exec: { style: 'taker', slippageBps: s.slippageBps, offsetTicks: 0, chaseTicks: 1, makerShare: 0.5 }, tag: 'entry' });
    }
    if (!a.k.placed) {
      // An entry pulled by a pause is placed again only once SoDEX confirmed it gone (its last fills counted).
      if (this.live(a).length) return;
      const qty = floorStep(total - a.filled, m);
      if (qty < minChildQty(m, s.price!)) return this.end(a, a.filled > 0 ? 'done' : 'failed', a.filled > 0 ? `Entered ${dec(a.filled)}; the rest is under SoDEX's minimum order.` : 'Under SoDEX\'s minimum order size: nothing could be sent.');
      // Counted as placed only once it went out: an entry held (no key, the region's cap) waits for the next step.
      await this.send(a, m, [{ side: s.side, price: s.price!, quantity: qty, tif: 'gtc', tag: 'entry' }], () => {
        a.k.placed = true;
      });
      return;
    }
    if (this.live(a).length) return;
    return this.end(a, 'expired', a.filled > 0 ? `The entry filled ${dec(a.filled)} of ${s.quantity} and is no longer on SoDEX; its exits cover what filled.` : 'The entry order is no longer on SoDEX (cancelled or refused).');
  }

  /* ---------------------------------------------------------- conditions ----- */

  private conditionHolds(a: AlgoRecord, c: Condition, i: number, now: number): boolean {
    const mk = this.market;
    switch (c.type) {
      case 'time':
        return now >= c.at;
      case 'price': {
        const p = mk.price(c.symbol, c.source);
        return p !== null && (c.op === 'above' ? p >= c.value : p <= c.value);
      }
      case 'cross': {
        const p = mk.price(c.symbol, c.source);
        if (p === null) return false;
        const key = `x${i}`;
        const other = c.dir === 'up' ? p < c.value : p > c.value;
        if (other) {
          a.k[key] = true;
          return false;
        }
        return a.k[key] === true;
      }
      case 'move': {
        const p = mk.price(c.symbol, c.source);
        const then = mk.priceAgo(c.symbol, c.source, c.windowMs);
        if (p === null || then === null || !(then > 0)) return false;
        const ch = p / then - 1;
        return c.dir === 'up' ? ch >= c.pct : c.dir === 'down' ? ch <= -c.pct : Math.abs(ch) >= c.pct;
      }
      case 'funding': {
        const f = mk.mark(c.symbol)?.funding ?? null;
        return f !== null && (c.op === 'above' ? f >= c.value : f <= c.value);
      }
      case 'oi': {
        const now0 = mk.mark(c.symbol)?.oi ?? null;
        const then = mk.oiAgo(c.symbol, c.windowMs);
        if (now0 === null || then === null || !(then > 0)) return false;
        const ch = now0 / then - 1;
        return c.dir === 'up' ? ch >= c.pct : c.dir === 'down' ? ch <= -c.pct : Math.abs(ch) >= c.pct;
      }
      case 'spread': {
        const q = mk.quote(c.symbol);
        if (!q) return false;
        const b = spreadBps(q);
        return c.op === 'above' ? b >= c.bps : b <= c.bps;
      }
      case 'volume':
        return mk.volume(c.symbol, c.windowMs).usd >= c.aboveUsd;
      case 'ratio': {
        const x = mk.mark(c.symbol)?.mark ?? null;
        const y = mk.mark(c.other)?.mark ?? null;
        if (x === null || y === null || !(y > 0)) return false;
        return c.op === 'above' ? x / y >= c.value : x / y <= c.value;
      }
      case 'position': {
        // The positions as last read (refreshed in the background every few seconds); unknown never holds.
        const book = this.cachedPositions(a, now);
        if (!book) return false;
        const p = book[c.symbol] ?? { size: 0, entry: 0 };
        const size = p.size;
        switch (c.op) {
          case 'long':
            return size > 0;
          case 'short':
            return size < 0;
          case 'flat':
            return size === 0;
          case 'sizeAbove':
            return Math.abs(size) >= c.value;
          case 'sizeBelow':
            return Math.abs(size) <= c.value;
          case 'pnlAbove':
          case 'pnlBelow': {
            const px = mk.mark(c.symbol)?.mark ?? null;
            if (px === null || size === 0) return false;
            const pnl = size * (px - p.entry);
            return c.op === 'pnlAbove' ? pnl >= c.value : pnl <= c.value;
          }
        }
        return false;
      }
    }
  }

  /** The owner's positions as last read; a read starts in the background when they are older than POSITIONS_MS. */
  private cachedPositions(a: AlgoRecord, now: number): Record<string, { size: number; entry: number }> | null {
    const hit = this.positionsOf.get(a.owner);
    if ((!hit || now - hit.at > POSITIONS_MS) && !hit?.loading) void this.loadPositions(a);
    return hit && hit.at > 0 ? hit.data : null;
  }

  private async loadPositions(a: AlgoRecord): Promise<Record<string, { size: number; entry: number; leverage?: number }> | null> {
    const prev = this.positionsOf.get(a.owner);
    const from = Date.now();
    this.positionsOf.set(a.owner, { at: prev?.at ?? 0, from: prev?.from, data: prev?.data ?? {}, loading: true });
    try {
      let data: Record<string, { size: number; entry: number; leverage?: number }>;
      if (this.host.positions) data = await this.host.positions(a);
      else {
        const snap = await this.host.sodex.follower(a.owner);
        data = Object.fromEntries(Object.entries(snap.positions).map(([s, p]) => [s, { size: p.size, entry: p.entry, ...(p.leverageReported ? { leverage: p.leverage } : {}) }]));
      }
      this.positionsOf.set(a.owner, { at: Date.now(), from, data, loading: false });
      return data;
    } catch (e) {
      this.host.log.warn('algo: positions read failed', { owner: a.owner, error: String(e) });
      this.positionsOf.set(a.owner, { at: prev?.at ?? 0, from: prev?.from, data: prev?.data ?? {}, loading: false });
      return null;
    }
  }

  describeCondition(c: Condition): string {
    const mins = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
    const pct = (x: number) => `${(x * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
    switch (c.type) {
      case 'time':
        return `At ${new Date(c.at).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
      case 'price':
        return `${c.symbol} ${c.source} ${c.op === 'above' ? '≥' : '≤'} ${c.value}`;
      case 'cross':
        return `${c.symbol} ${c.source} crosses ${c.dir === 'up' ? 'up through' : 'down through'} ${c.value}`;
      case 'move':
        return `${c.symbol} moves ${c.dir === 'either' ? '±' : c.dir === 'up' ? '+' : '−'}${pct(c.pct)} within ${mins(c.windowMs)}`;
      case 'funding':
        return `${c.symbol} funding ${c.op === 'above' ? '≥' : '≤'} ${pct(c.value)}`;
      case 'oi':
        return `${c.symbol} open interest ${c.dir === 'either' ? '±' : c.dir === 'up' ? '+' : '−'}${pct(c.pct)} within ${mins(c.windowMs)}`;
      case 'spread':
        return `${c.symbol} spread ${c.op === 'above' ? '≥' : '≤'} ${c.bps} bp`;
      case 'volume':
        return `${c.symbol} trades $${Math.round(c.aboveUsd).toLocaleString('en-US')} within ${mins(c.windowMs)}`;
      case 'ratio':
        return `${c.symbol} / ${c.other} ${c.op === 'above' ? '≥' : '≤'} ${c.value}`;
      case 'position': {
        const what: Record<typeof c.op, string> = {
          long: 'is long',
          short: 'is short',
          flat: 'is flat',
          sizeAbove: `is at least ${c.value}`,
          sizeBelow: `is at most ${c.value}`,
          pnlAbove: `PnL ≥ $${c.value}`,
          pnlBelow: `PnL ≤ $${c.value}`,
        };
        return `Your ${c.symbol} position ${what[c.op]}`;
      }
    }
  }

  /* -------------------------------------------------------------- sending ----- */

  private clOrdIdFor(a: AlgoRecord): string {
    a.childCount += 1;
    return `va-${a.id.slice(1, 13)}-${a.childCount.toString(36)}`;
  }

  /** Equity and gross exposure of the owner's account, read at most every ACCOUNT_MS. null: not readable. */
  private async accountOf(a: AlgoRecord): Promise<{ equity: number; gross: number } | null> {
    const hit = this.accounts.get(a.owner);
    if (hit && Date.now() - hit.at < ACCOUNT_MS) return hit;
    try {
      let v: { equity: number; gross: number };
      if (this.host.account) v = await this.host.account(a);
      else {
        const snap = await this.host.sodex.follower(a.owner);
        const gross = Object.entries(snap.positions).reduce((x, [sym, p]) => x + Math.abs(p.size) * (this.market.mark(sym)?.mark ?? p.entry), 0);
        v = { equity: snap.equity, gross };
      }
      const row = { at: Date.now(), ...v };
      this.accounts.set(a.owner, row);
      return row;
    } catch (e) {
      this.host.log.warn('algo: account read failed', { owner: a.owner, error: String(e) });
      return null;
    }
  }

  /**
   * Sign and send children (one batch on one market) and book them as live.
   * Write-ahead: the children (and `commit`, the algo's own state that goes
   * with them) are in the store before the request leaves, and their answer is
   * written as soon as it is back - a crash in between leaves them `unknown`
   * (asked of SoDEX), never forgotten and sent again. Nothing goes out for an
   * algo that was paused or ended meanwhile. Returns the children sent ([] when
   * held or stopped: nothing went out, and `commit` did not run).
   */
  private async send(a: AlgoRecord, m: MarketInfo, list: Array<{ side: Side; price: number; quantity: number; tif: ChildTif; tag: string; reduceOnly?: boolean }>, commit?: () => void): Promise<ChildOrder[]> {
    const s = a.spec;
    if (this.stopped(a)) return [];
    const sink = s.paper ? null : this.host.sinkFor(a);
    if (!s.paper && !sink) {
      await this.hold(a, 'The trading key for this algo is not available here.');
      return [];
    }
    const brake = s.paper ? null : this.host.brake?.(a) ?? null;
    if (brake) {
      await this.hold(a, `Held: ${brake}`);
      return [];
    }
    const opening = list.some((x) => !(x.reduceOnly ?? s.reduceOnly));
    // The region's leverage ceiling (EEA 2x): on the leverage set, and on the gross exposure an opening child may reach.
    const ceiling = !s.paper ? (this.host.policyFor?.(a)?.maxLeverage ?? null) : null;
    const leverage = ceiling !== null ? Math.min(s.leverage ?? ceiling, ceiling) : s.leverage;
    const lev = leverage !== null ? Math.min(leverage, m.maxLeverage) : null;
    const want = lev !== null ? `${lev}|${s.marginMode ?? 'cross'}` : null;
    // Per algo: each sets its leverage and margin mode at its first opening child. Shared by the wallet's algos on the
    // market, one algo trusted what an earlier one set although the follower may have changed it since (the same
    // live run as the copier's: an isolated position opened on cross, 2026-10-30).
    if (sink && opening && lev !== null && this.leverageSet.get(`${a.id}|${m.name}`) !== want) {
      this.leverageSet.set(`${a.id}|${m.name}`, want!);
      await sink.setLeverage(a, m, lev, s.marginMode ?? 'cross').catch((e) => {
        // Not set: the next opening child asks again.
        this.leverageSet.delete(`${a.id}|${m.name}`);
        this.event(a, 'error', `Leverage not set: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    if (opening && ceiling !== null) {
      const acct = await this.accountOf(a);
      const room = acct ? acct.equity * ceiling - acct.gross : null;
      const notional = list.reduce((x, c) => x + (c.reduceOnly ?? s.reduceOnly ? 0 : c.quantity * c.price), 0);
      if (room === null || notional > room) {
        // One child is cut down to fit; a batch (a ladder, a wave) waits until it fits whole.
        const one = list.length === 1 ? list[0]! : null;
        const fit = one && room !== null && room > 0 ? floorStep(room / one.price, m) : 0;
        if (!one || fit < minChildQty(m, one.price)) {
          await this.hold(a, room === null ? 'Held: your account could not be read for the leverage cap of your region.' : `Held: the ${ceiling}x leverage cap for your region is reached.`);
          return [];
        }
        list = [{ ...one, quantity: fit }];
      }
    }
    if (opening) {
      const fit = await this.fitLimits(a, m, list, leverage);
      if (!fit) return [];
      list = fit;
    }
    if (this.stopped(a)) return [];
    if (opening && ceiling !== null) {
      // Counted at once, so the next child before the next read does not overshoot.
      const row = this.accounts.get(a.owner);
      if (row) row.gross += list.reduce((x, c) => x + (c.reduceOnly ?? s.reduceOnly ? 0 : c.quantity * c.price), 0);
    }
    const now = Date.now();
    const children: ChildOrder[] = [];
    const reqs: ChildRequest[] = [];
    for (const x of list) {
      const clOrdID = this.clOrdIdFor(a);
      // On SoDEX's tick, never worse for the trader: a price a trader typed (an iceberg's, a bracket's or a
      // conditional's limit) may be off it, and SoDEX takes only prices on it. A buy rounds down, a sell up.
      const price = Number(dec(onTick(x.price, x.side, m.tickSize)));
      const quantity = Number(dec(x.quantity));
      const c: ChildOrder = { clOrdID, orderId: null, side: x.side, price, quantity, tif: x.tif, reduceOnly: x.reduceOnly ?? s.reduceOnly, filled: 0, value: 0, state: 'sending', placedAt: now, updatedAt: now, cancelling: false, tag: x.tag };
      children.push(c);
      reqs.push({ clOrdID, side: c.side, price: dec(price), quantity: dec(quantity), tif: c.tif, reduceOnly: c.reduceOnly });
      a.children.push(c);
      this.byClOrd.set(clOrdID, a.id);
    }
    commit?.();
    this.trimChildren(a);
    // In the store before it leaves.
    await this.save(a);
    // Logged before it leaves: a fill can come back on the socket before the request's own answer.
    for (const c of children) await this.event(a, 'order', `${c.tif === 'ioc' ? 'Take' : 'Rest'} ${c.side} ${c.quantity} @ ${c.price} (${c.tag}).`, c);
    if (this.stopped(a)) {
      // Paused or cancelled while it was being written: it never leaves.
      for (const c of children) {
        c.state = 'done';
        c.cancelling = false;
      }
      await this.save(a);
      return [];
    }
    let results: ChildResult[];
    if (s.paper) results = this.paperPlace(a, m, children);
    else results = await sink!.place(a, m, reqs);
    let limit: LimitRefusal | null = null;
    for (const c of children) {
      const r = results.find((x) => x.clOrdID === c.clOrdID) ?? { clOrdID: c.clOrdID, ok: false, orderId: null, error: 'no answer for this order', outcomeUnknown: true };
      c.updatedAt = Date.now();
      if (r.orderId) c.orderId = r.orderId;
      if (r.ok) {
        if (c.state === 'sending') c.state = 'open';
        a.k.consecRejects = 0;
      } else if (r.outcomeUnknown) {
        if (c.state === 'sending') c.state = 'unknown';
        await this.event(a, 'error', `No answer from SoDEX for ${c.tag}; checking what happened (never re-sent).`, c);
      } else {
        c.state = 'done';
        c.cancelling = false;
        a.rejects++;
        a.k.consecRejects = Number(a.k.consecRejects ?? 0) + 1;
        await this.event(a, 'error', `SoDEX refused ${c.tag}: ${r.error}`, c);
        limit ??= limitRefusal(r.error, m.name);
      }
    }
    // Paused or ended while it was on its way: a cancel sent then may have reached SoDEX before the order did, so what rests is cancelled again now.
    if (!s.paper && this.stopped(a)) {
      const kept = (a.k.kept as string[] | undefined) ?? [];
      const late = children.filter((c) => c.tif !== 'ioc' && c.state !== 'done' && !kept.includes(c.clOrdID));
      const again = children.filter((c) => c.tif !== 'ioc' && !kept.includes(c.clOrdID) && results.some((r) => r.clOrdID === c.clOrdID && (r.ok || r.outcomeUnknown)));
      for (const c of late) c.cancelling = true;
      if (again.length) await sink!.cancel(a, m, again.map((c) => c.clOrdID)).catch((e) => this.event(a, 'error', `Cancel failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    await this.save(a);
    if (limit) await this.onLimit(a, limit);
    if (Number(a.k.consecRejects ?? 0) >= MAX_CONSEC_REJECTS) await this.end(a, 'failed', `SoDEX refused ${MAX_CONSEC_REJECTS} orders in a row; stopped. The last reason is in the log.`);
    this.host.onChange?.(a.id);
    return children;
  }

  /**
   * Opening children inside SoDEX's position limit at the leverage and the
   * market's open-interest cap (limits.ts), with what the algo has working:
   * one child is cut down to fit, a batch waits whole. null: held, nothing
   * goes out to be refused. The position is the last one read (live), or the
   * paper fills' (paper); the open interest the feed's.
   */
  private async fitLimits(a: AlgoRecord, m: MarketInfo, list: Array<{ side: Side; price: number; quantity: number; tif: ChildTif; tag: string; reduceOnly?: boolean }>, leverage: number | null): Promise<typeof list | null> {
    const s = a.spec;
    const open = list.filter((c) => !(c.reduceOnly ?? s.reduceOnly));
    if (!open.length || (!m.marginTiers?.length && !m.openInterestCap && !m.openInterestCapUSD)) return list;
    const side = open[0]!.side;
    const sum = open.reduce((x, c) => x + c.quantity, 0);
    const working = this.live(a).filter((c) => !c.reduceOnly && c.side === side).reduce((x, c) => x + Math.max(0, c.quantity - c.filled), 0);
    const price = open.reduce((x, c) => x + c.quantity * c.price, 0) / sum;
    let pos: number | null = null;
    if (s.paper) pos = typeof a.k.paperPos === 'number' ? a.k.paperPos : 0;
    else {
      // Read again when older than POSITIONS_MS (the trader may have traded by hand); a read in flight: the last one.
      const hit = this.positionsOf.get(a.owner);
      const book = hit && (hit.loading || Date.now() - hit.at <= POSITIONS_MS) ? hit.data : await this.loadPositions(a);
      pos = book ? (book[m.name]?.size ?? 0) : null;
    }
    const lev = limitLeverage(m, leverage, s.paper ? null : this.positionLeverage(a, m.name));
    const oiNow = this.market.mark(m.name)?.oi ?? null;
    const lim = checkLimits(m, { side, quantity: sum + working, price, position: pos, leverage: lev, oi: oiNow });
    const most = Math.min(lim.maxByPosition, lim.maxByOi) - working;
    if (sum <= most + 1e-12) {
      if (a.k.limitHold) {
        delete a.k.limitHold;
        this.dirty.add(a.id);
      }
      return list;
    }
    const kind: 'oi' | 'position' = lim.maxByOi < lim.maxByPosition ? 'oi' : 'position';
    // How much can still be added, in USD and in the coin: the open interest market-wide, or this position at its leverage.
    const head = oiHeadroom(m, oiNow, price);
    const cap = positionCapUsd(m, lev);
    const roomQty = Math.max(0, lim.maxByPosition - working);
    const can = roomQty < Number(m.stepSize) ? 'nothing more can be added' : `about ${money(roomQty * price)} (${coins(roomQty)} ${m.base}) can still be added`;
    const posWords = cap === null ? '' : `Your ${m.name} position is about ${money(Math.abs(pos ?? 0) * price)}${pos ? ` ${pos > 0 ? 'long' : 'short'}` : ''} and SoDEX's limit${lev !== null ? ` at ${lev}x` : ''} is ${money(cap)}: ${can}.`;
    const room = kind === 'oi' && head ? oiRoomWords(m, head, price) : posWords;
    const one = list.length === 1 ? list[0]! : null;
    const cut = one ? floorStep(Math.max(0, most), m) : 0;
    if (one && cut >= minChildQty(m, one.price)) {
      const which = kind === 'oi' ? `SoDEX's open-interest cap on ${m.name}` : `SoDEX's position limit on ${m.name}`;
      const text = `${one.tag[0]!.toUpperCase()}${one.tag.slice(1)} was cut from ${dec(one.quantity)} to ${dec(cut)} ${m.base} (about ${money(cut * one.price)}) to stay under ${which}. ${room}`;
      delete a.k.limitHold;
      this.dirty.add(a.id);
      await this.event(a, 'info', text);
      await this.limitNotice(a, m, kind, 'cut', text);
      return [{ ...one, quantity: cut }];
    }
    const left = kind === 'oi' ? (head?.room ?? 0) : roomQty;
    const none = left < Number(m.stepSize);
    const small = one ? ` That is under ${minWords(m, one.price)}.` : ` That is too little for the next ${list.length} orders, which go out together.`;
    const fresh = kind === 'oi'
      ? `Held: ${room || `open interest on ${m.name} is at SoDEX's cap.`}${none ? '' : small} Nothing goes out until there is ${none ? '' : 'more '}room.`
      : `Held: ${room || `your ${m.name} position is at SoDEX's limit.`}${none ? '' : small} It goes on when there is room (a smaller position, or lower leverage).`;
    // The same words while it stays held for the same reason (a hold logs a line only when its words change): read again every 10 min.
    const was = a.k.limitHold as { kind: string; reason: string; at: number } | undefined;
    const now = Date.now();
    const reason = was && was.kind === kind && now - was.at < LIMIT_WORDS_MS ? was.reason : fresh;
    if (reason === fresh) {
      a.k.limitHold = { kind, reason, at: now };
      this.dirty.add(a.id);
      if (!was || was.kind !== kind) await this.limitNotice(a, m, kind, 'held', reason.replace(/^Held: /, ''));
    }
    await this.hold(a, reason);
    return null;
  }

  /**
   * Tell the trader that one of SoDEX's limits held the algo or cut a child
   * (limits.ts AlgoLimitNotice): on the algo itself, so whichever browser shows
   * it - the one running it, or one reading an executor's algos - puts it in
   * the bell once. The same kind of notice at most once every 10 minutes.
   */
  private async limitNotice(a: AlgoRecord, m: MarketInfo, kind: AlgoLimitNotice['kind'], what: AlgoLimitNotice['what'], text: string): Promise<void> {
    const now = Date.now();
    const prev = a.k.limitNotice as AlgoLimitNotice | undefined;
    if (prev && prev.kind === kind && prev.what === what && now - prev.at < LIMIT_WORDS_MS) return;
    const name = a.spec.label ?? ALGO_NAMES[a.spec.kind];
    const title = what === 'cut' ? `${name} on ${m.name}: an order was cut` : `${name} on ${m.name} is held`;
    a.k.limitNotice = { id: randomId('n'), at: now, kind, what, title, text } satisfies AlgoLimitNotice;
    this.dirty.add(a.id);
    this.host.onChange?.(a.id);
  }

  /**
   * SoDEX refused a child at one of its limits (limits.ts limitRefusal): the
   * algo waits a minute (doubling), and stops at the LIMIT_MAX_HITS-th refusal
   * with no fill in between - never a refusal every tick.
   */
  private async onLimit(a: AlgoRecord, lim: LimitRefusal): Promise<void> {
    if (FINAL_STATUSES.has(a.status)) return;
    const n = Number(a.k.limitHits ?? 0) + 1;
    a.k.limitHits = n;
    if (n >= LIMIT_MAX_HITS) {
      await this.end(a, 'failed', `Stopped: ${lim.text} SoDEX refused it ${n} times with nothing filled in between.`);
      return;
    }
    const wait = Math.min(LIMIT_RETRY_MS * 2 ** (n - 1), 15 * 60_000);
    a.k.limitUntil = Date.now() + wait;
    // What can still be added, where it is known (the open interest market-wide).
    const m = this.markets.get(a.spec.symbol);
    const mk = this.market.mark(a.spec.symbol);
    const head = m && mk && lim.kind === 'oi' ? oiHeadroom(m, mk.oi, mk.mark) : null;
    const room = head && m && mk ? ` ${oiRoomWords(m, head, mk.mark)}` : '';
    a.k.limitReason = `Held: ${lim.text}${room} Trying again in ${Math.round(wait / 60_000)} min.`;
    this.dirty.add(a.id);
    if (m) await this.limitNotice(a, m, lim.kind, 'held', `SoDEX refused an order: ${lim.text}${room} It tries again in ${Math.round(wait / 60_000)} min.`);
    await this.hold(a, a.k.limitReason as string);
  }

  private async cancelChildren(a: AlgoRecord, m: MarketInfo, list: ChildOrder[]): Promise<void> {
    const open = list.filter((c) => LIVE.has(c.state) && !c.cancelling);
    if (!open.length) return;
    for (const c of open) {
      c.cancelling = true;
      c.updatedAt = Date.now();
    }
    this.dirty.add(a.id);
    if (a.spec.paper) {
      for (const c of open) this.paperCancel(c.clOrdID);
      return;
    }
    const sink = this.host.sinkFor(a);
    if (!sink) return;
    try {
      await sink.cancel(a, m, open.map((c) => c.clOrdID));
    } catch (e) {
      for (const c of open) c.cancelling = false;
      await this.event(a, 'error', `Cancel failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Cancel every resting child (pause, hold, end). */
  private async pullResting(a: AlgoRecord, keep: readonly string[] = []): Promise<void> {
    const m = this.markets.get(a.spec.symbol);
    if (!m) return;
    // Not only what SoDEX confirmed: an order still on its way, or one whose placement got no answer, may rest there too (a cancel by id is harmless if it does not).
    const resting = this.live(a).filter((c) => !keep.includes(c.clOrdID) && (c.state === 'open' || c.tif !== 'ioc') && !c.cancelling);
    if (!resting.length) return;
    if (a.spec.kind === 'scale' && !FINAL_STATUSES.has(a.status)) {
      // A ladder puts the levels it pulls back when it carries on (resume), for what they have not filled.
      const queue = new Set((a.k.queue as number[] | undefined) ?? []);
      for (const c of resting) if (levelOf(c) >= 0) queue.add(levelOf(c));
      a.k.queue = [...queue].sort((x, y) => x - y);
    }
    // A bracket's limit entry pulled by a pause or a hold goes back on the book when it carries on, for what it has not filled.
    if (a.spec.kind === 'bracket' && a.spec.entry === 'limit' && !FINAL_STATUSES.has(a.status) && resting.some((c) => c.tag === 'entry')) a.k.placed = false;
    await this.cancelChildren(a, m, resting);
  }

  private trimChildren(a: AlgoRecord): void {
    const done = a.children.filter((c) => !LIVE.has(c.state));
    if (done.length <= DONE_KEPT) return;
    const drop = new Set(done.slice(0, done.length - DONE_KEPT).map((c) => c.clOrdID));
    a.children = a.children.filter((c) => !drop.has(c.clOrdID));
  }

  /* ------------------------------------------------------------- the books ----- */

  private onOrderUpdate(u: OrderUpdate): void {
    const id = this.byClOrd.get(u.clOrdID);
    const a = id ? this.algos.get(id) : undefined;
    if (!a) return;
    const c = a.children.find((x) => x.clOrdID === u.clOrdID);
    if (!c) {
      const x = (a.exitOrders ?? []).find((e) => e.clOrdID === u.clOrdID);
      if (x) this.onExitUpdate(a, x, u);
      return;
    }
    const before = a.filled;
    const was = c.state;
    this.applyFill(a, c, u.filledQty, u.filledValue, u.maker);
    // Something filled: SoDEX's limits let it through, so a refusal before counts no more.
    if (a.filled > before && a.k.limitHits) delete a.k.limitHits;
    // A fill that lands after the algo ended still gets its exits resized.
    if (a.filled > before && FINAL_STATUSES.has(a.status) && a.spec.exits) {
      const m = this.markets.get(a.spec.symbol);
      if (m) void this.syncExits(a, m, true);
    }
    if (u.orderId) c.orderId = u.orderId;
    c.updatedAt = Date.now();
    // SoDEX told of it: whatever the reads missed, it is accounted for as usual again.
    delete c.unlisted;
    if (FINAL_ORDER.test(u.status)) {
      const ours = c.cancelling;
      c.state = 'done';
      c.cancelling = false;
      // An order the algo ended leaving on SoDEX (a conditional's limit, a chase left resting) that SoDEX took off itself -
      // a post-only price that would have taken, a margin check - no longer rests: the algo says so, not "it rests on SoDEX".
      if (was !== 'done' && !ours && c.filled <= 1e-12 && FINAL_STATUSES.has(a.status) && ((a.k.kept as string[] | undefined) ?? []).includes(c.clOrdID)) {
        const how = u.status === 'REJECTED' ? 'rejected' : 'cancelled';
        a.statusReason = `${a.statusReason ? `${a.statusReason} ` : ''}SoDEX then ${how} it${u.reason ? ` (${u.reason})` : ''}: nothing filled, nothing rests.`;
        void this.event(a, 'error', `SoDEX ${how} ${c.tag} at ${c.price}${u.reason ? `: ${u.reason}` : ''}; it no longer rests (nothing filled).`, c);
      }
      if (c.tif === 'ioc' && c.filled <= 1e-12) a.k.missAt = Date.now();
      if (u.status === 'REJECTED' && was !== 'done') {
        a.rejects++;
        a.k.consecRejects = Number(a.k.consecRejects ?? 0) + 1;
        void this.event(a, 'error', `SoDEX rejected ${c.tag}${u.reason ? `: ${u.reason}` : ''}.`, c);
        const lim = limitRefusal(u.reason, a.spec.symbol);
        if (lim) void this.onLimit(a, lim);
        // A grid level refused (a post-only the price reached meanwhile) goes out again after a moment, not on the next step.
        if (a.spec.kind === 'grid' && gridLevelOf(c) >= 0) a.k.gretry = { ...((a.k.gretry as Record<string, number> | undefined) ?? {}), [gridLevelOf(c)]: Date.now() + GRID_RETRY_MS };
      }
      this.onChildDone(a, c);
    } else if (c.state === 'sending' || c.state === 'unknown') c.state = 'open';
    // A resting child that turns up after its algo ended is cancelled (unless it was left on purpose).
    if (FINAL_STATUSES.has(a.status) && c.state === 'open' && c.tif !== 'ioc' && !c.cancelling && !((a.k.kept as string[] | undefined) ?? []).includes(c.clOrdID)) {
      const m = this.markets.get(a.spec.symbol);
      if (m) void this.cancelChildren(a, m, [c]);
    }
    // A fill or a settled order is written at once, not at the next flush: a crash must not forget what SoDEX already did.
    if (a.filled > before || c.state !== was) void this.save(a);
    else this.dirty.add(a.id);
    this.host.onChange?.(a.id);
  }

  private applyFill(a: AlgoRecord, c: ChildOrder, cumQty: number, cumValue: number, maker: boolean | null): void {
    const dq = cumQty - c.filled;
    if (!(dq > 1e-12)) return;
    const dv = cumValue > c.value ? cumValue - c.value : dq * c.price;
    c.filled = cumQty;
    c.value = cumValue > 0 ? cumValue : c.value + dv;
    a.filled += dq;
    a.filledValue += dv;
    if (a.spec.kind === 'scale' && levelOf(c) >= 0) {
      // Each level's own fill: a level put back after a pause rests for what it has not filled.
      const lvl = (a.k.lvl as number[] | undefined) ?? [];
      lvl[levelOf(c)] = (lvl[levelOf(c)] ?? 0) + dq;
      a.k.lvl = lvl.map((x) => x ?? 0);
    }
    const sp = a.spec;
    if ((sp.kind === 'twap' || sp.kind === 'vwap') && sp.maxParticipation !== null) {
      // What it filled lately, for max participation (per interval).
      const win = Math.max(sp.durationMs / sp.slices, 5_000);
      const recent = ((a.k.recent as number[][] | undefined) ?? []).filter((x) => x[0]! > Date.now() - win);
      recent.push([Date.now(), dq]);
      a.k.recent = recent.slice(-1000);
    }
    const isMaker = maker ?? c.tif !== 'ioc';
    if (isMaker) a.makerQty += dq;
    const m = this.markets.get(a.spec.symbol);
    const rate = (isMaker ? (m?.makerFee ?? (m?.takerFee ?? 0.0004) / 2) : (m?.takerFee ?? 0.0004)) + (this.host.builderRate?.(a) ?? 0);
    a.fees += dv * rate;
    if (a.spec.bot) {
      a.book ??= emptyBook();
      bookFill(a.book, c.side, dq, dv, isMaker, isMaker ? (m?.makerFee ?? (m?.takerFee ?? 0.0004) / 2) : (m?.takerFee ?? 0.0004), this.host.builderRate?.(a) ?? 0);
    }
    if (a.k.consecRejects) a.k.consecRejects = 0;
    void this.event(a, 'fill', `Filled ${dec(dq)} @ ${(dv / dq).toPrecision(8).replace(/\.?0+$/, '')}${isMaker ? ' (maker)' : ''}.`, { ...c, quantity: dq, price: dv / dq });
  }

  /* --------------------------------------------------------------- exits ----- */

  /**
   * Keep the exits in line with what the entry filled: a take-profit and/or a
   * stop-loss, SoDEX position stops sized to the filled amount at the levels
   * the spec names (a price, or a distance from the average fill). Resized at
   * most every EXITS_RESIZE_MS while the entry fills (cancel, then place, once
   * SoDEX has answered for the old pair), at once when it ends (`final`: what
   * is still live is cancelled and the final pair placed without waiting).
   * Written to the store before the stops leave and after their answer. A
   * refusal is tried again after EXITS_RETRY_MS (doubling), and given up after
   * EXITS_MAX_REFUSALS with an error in the log. Nothing once one of them has
   * filled, or once the trader cancelled them.
   */
  private async syncExits(a: AlgoRecord, m: MarketInfo, final: boolean): Promise<void> {
    const s = a.spec;
    if (!s.exits || !opensPosition(s) || a.k.exitsDone || a.k.exitsGaveUp) return;
    if (this.exitsBusy.has(a.id)) {
      // Asked at the end while a placement is out: done again once it is back, for the fill as it is then.
      if (final) this.exitsAgain.add(a.id);
      return;
    }
    const now = Date.now();
    if (now < Number(a.k.exitsRetryAt ?? 0)) return;
    this.exitsBusy.add(a.id);
    try {
      a.exitOrders ??= [];
      const live = this.liveExits(a);
      if (!final && live.some((x) => x.state !== 'open' || x.cancelling)) return;
      const size = floorStep(a.filled, m);
      if (size < Math.max(Number(m.stepSize), Number(m.minQuantity) || 0)) return;
      const covered = Number(a.k.exitsSize ?? 0);
      const standing = live.filter((x) => !x.cancelling);
      if (standing.length && Math.abs(size - covered) < Number(m.stepSize) / 2) return;
      if (!final && standing.length && now - Number(a.k.exitsAt ?? 0) < EXITS_RESIZE_MS) return;
      if (live.length) {
        await this.cancelExits(a, m, live);
        if (!final) return;
      }
      const avg = a.filledValue / a.filled;
      const lv = exitLevels(s.side, s.exits, avg);
      const close: Side = s.side === 'buy' ? 'sell' : 'buy';
      const stops: StopRequest[] = [];
      const xs: ChildOrder[] = [];
      for (const kind of ['tp', 'sl'] as const) {
        const p = kind === 'tp' ? lv.tp : lv.sl;
        if (p === null || !(p > 0)) continue;
        // A price exit the fills ended up past (a take-profit under a long's average, a stop over it)
        // would close the position the moment it lands: not sent, and said once.
        const above = (s.side === 'buy') === (kind === 'tp');
        if (above ? p <= avg : p >= avg) {
          if (a.k[`exitSkip_${kind}`] !== p) {
            a.k[`exitSkip_${kind}`] = p;
            await this.event(a, 'error', `The ${kind === 'tp' ? 'take-profit' : 'stop-loss'} at ${p} is on the wrong side of the average fill ${snapPrice(avg, m)}: not placed, it would close the position at once.`);
          }
          continue;
        }
        const clOrdID = this.clOrdIdFor(a);
        const triggerPrice = snapPrice(p, m);
        stops.push({ clOrdID, side: close, quantity: dec(size), triggerPrice, kind });
        xs.push({ clOrdID, orderId: null, side: close, price: Number(triggerPrice), quantity: size, tif: 'ioc', reduceOnly: true, filled: 0, value: 0, state: 'sending', placedAt: now, updatedAt: now, cancelling: false, tag: kind === 'tp' ? 'take-profit' : 'stop-loss', exit: kind });
        this.byClOrd.set(clOrdID, a.id);
      }
      if (!stops.length) return;
      a.exitOrders.push(...xs);
      a.k.exitsSize = size;
      a.k.exitsAt = now;
      // In the store before they leave.
      await this.save(a);
      await this.event(a, 'order', `Exits for ${dec(size)} ${m.base}: ${xs.map((x) => `${x.tag} at ${x.price}`).join(', ')} (${s.paper ? 'paper: watched against the mark' : 'SoDEX holds them'}; when one fills the other is cancelled).`);
      const sink = s.paper ? null : this.host.sinkFor(a);
      const results: ChildResult[] = s.paper
        ? stops.map((st) => ({ clOrdID: st.clOrdID, ok: true, orderId: `paper-${st.clOrdID}`, error: null, outcomeUnknown: false }))
        : sink
          ? await sink.placeStops(a, m, stops)
          : stops.map((st) => ({ clOrdID: st.clOrdID, ok: false, orderId: null, error: 'the trading key is not available here', outcomeUnknown: false }));
      let refused = false;
      for (const x of xs) {
        const r = results.find((y) => y.clOrdID === x.clOrdID);
        x.updatedAt = Date.now();
        if (r?.orderId) x.orderId = r.orderId;
        if (r?.ok) {
          if (x.state === 'sending') x.state = 'open';
        } else if (r?.outcomeUnknown) {
          // Asked of SoDEX in settleStale; never sent again blind.
          if (x.state === 'sending') x.state = 'unknown';
        } else {
          x.state = 'done';
          refused = true;
          await this.event(a, 'error', `SoDEX refused the ${x.tag}: ${r?.error ?? 'no answer'}`);
        }
      }
      if (refused) {
        const n = Number(a.k.exitsRefused ?? 0) + 1;
        a.k.exitsRefused = n;
        a.k.exitsRefusedAt = now;
        // The pair goes out whole again next time.
        a.k.exitsSize = 0;
        if (n >= EXITS_MAX_REFUSALS) {
          a.k.exitsGaveUp = true;
          await this.event(a, 'error', `SoDEX refused the exits ${n} times; they are no longer tried. What filled has no take-profit / stop-loss from this algo: set one in your open orders.`);
        } else a.k.exitsRetryAt = now + EXITS_RETRY_MS * 2 ** (n - 1);
      } else {
        delete a.k.exitsRefused;
        delete a.k.exitsRetryAt;
      }
      const done = a.exitOrders.filter((x) => !LIVE.has(x.state));
      if (done.length > 12) a.exitOrders = a.exitOrders.filter((x) => LIVE.has(x.state) || done.slice(-12).includes(x));
      await this.save(a);
      this.syncWatch();
      this.host.onChange?.(a.id);
    } finally {
      this.exitsBusy.delete(a.id);
      if (this.exitsAgain.delete(a.id)) void this.syncExits(a, m, true);
    }
  }

  /** Whether an ended algo's exits are behind what it filled (none standing, or a size they do not cover) and may be placed now. */
  private exitsDue(a: AlgoRecord, now: number): boolean {
    const s = a.spec;
    if (!s.exits || !opensPosition(s) || a.k.exitsDone || a.k.exitsGaveUp || a.filled <= 0 || this.exitsBusy.has(a.id)) return false;
    if (now < Number(a.k.exitsRetryAt ?? 0)) return false;
    const m = this.markets.get(s.symbol);
    if (!m) return false;
    const size = floorStep(a.filled, m);
    if (size < Math.max(Number(m.stepSize), Number(m.minQuantity) || 0)) return false;
    const standing = this.liveExits(a).filter((x) => !x.cancelling);
    return !standing.length || Math.abs(size - Number(a.k.exitsSize ?? 0)) >= Number(m.stepSize) / 2;
  }

  /**
   * Whether an ended live algo's exits are to be held against its position now: they rest on
   * SoDEX (every EXITS_WATCH_MS, the first read one that left EXITS_SETTLE_MS after they were
   * placed), SoDEX cancelled them (once), or a pair is about to go out again after SoDEX refused
   * or expired one (once per refusal, before it is placed: it may have had nothing to reduce).
   */
  private exitsWatchDue(a: AlgoRecord, now: number): boolean {
    const s = a.spec;
    if (s.paper || !s.exits || !opensPosition(s) || a.filled <= 0 || a.k.exitsOutside || a.k.exitsGaveUp) return false;
    if (this.exitsWatching.has(a.id) || this.exitsBusy.has(a.id)) return false;
    const placed = Math.max(0, ...(a.exitOrders ?? []).map((x) => x.placedAt));
    if (now < placed + EXITS_SETTLE_MS) return false;
    const last = this.exitsWatchAt.get(a.id) ?? 0;
    const periodic = now - last >= EXITS_WATCH_MS;
    if (a.k.exitsDone) return a.k.exitsPulled === true && periodic;
    if (this.exitsUnchecked(a) && now >= Number(a.k.exitsRetryAt ?? 0) && (periodic || last < Number(a.k.exitsRefusedAt ?? 0))) return true;
    return periodic && this.liveExits(a).some((x) => x.state === 'open' && !x.cancelling);
  }

  /** A refused or expired pair whose position was not found held since: it is not placed again before (watchExits). */
  private exitsUnchecked(a: AlgoRecord): boolean {
    return !a.spec.paper && !a.k.exitsDone && Number(a.k.exitsRefused ?? 0) > 0 && Number(a.k.exitsRefusedAt ?? 0) >= (this.exitsHeldAt.get(a.id) ?? 0);
  }

  /**
   * An ended algo's exits held against its position (exitsWatchDue). Flat, or on the other side:
   * the position the exits protect is gone, closed outside the algo (a liquidation, or by hand),
   * so they are cancelled, not placed again, and the trader is told (exitsOutside). Still held:
   * a pair that is due goes out again. A position that cannot be read changes nothing.
   */
  private async watchExits(a: AlgoRecord, m: MarketInfo, now: number): Promise<void> {
    this.exitsWatching.add(a.id);
    this.exitsWatchAt.set(a.id, now);
    try {
      const placed = Math.max(0, ...(a.exitOrders ?? []).map((x) => x.placedAt));
      const size = await this.positionSince(a, m.name, placed + EXITS_SETTLE_MS);
      const held = size === null ? null : (a.spec.side === 'buy' ? size : -size) >= Number(m.stepSize) / 2;
      // Gone on one read is not gone (exitsGone): nothing is done this round unless more says so.
      if (held === false) return (await this.exitsGone(a, m, size!, placed)) ? await this.exitsOutside(a, m, now) : undefined;
      // Held, or not readable (the exits then go on protecting it).
      if (held) this.exitsFlatSince.delete(a.id);
      this.exitsHeldAt.set(a.id, now);
      if (a.k.exitsPulled) {
        // The trader cancelled them (the position is still there): as the log says, they are not placed again.
        if (held) delete a.k.exitsPulled;
        return;
      }
      if (!a.k.exitsDone && this.exitsDue(a, Date.now())) await this.syncExits(a, m, true);
    } finally {
      this.exitsWatching.delete(a.id);
    }
  }

  /**
   * Whether the position an ended algo's exits protect is gone, as a read (`size`) says: only when
   * CONFIRM_READS more reads agree on its size (confirm.ts) and SoDEX's trades hold a fill since the
   * exits were placed that cut it - a liquidation, the trader's close. A backend that missed the
   * opening fills reads the account flat while it holds the position: cancelling the exits then
   * would leave a real position without its take-profit and stop-loss. Reads that agree with no
   * such fill (the trades lag the matching, or cannot be read) are taken after EXITS_NO_FILL_MS.
   */
  private async exitsGone(a: AlgoRecord, m: MarketInfo, size: number, placed: number): Promise<boolean> {
    const c = await confirmRead<number | null>(size, () => this.positionOf(a, m.name), sizeView, { gapMs: this.host.confirmGapMs });
    if (!c.ok) {
      this.host.log.warn('algo: SoDEX\'s reads of the position disagree; the exits stay', { algo: a.id, symbol: m.name, reads: c.seen });
      return false;
    }
    const close: Side = a.spec.side === 'buy' ? 'sell' : 'buy';
    let cut: boolean | null = null;
    try {
      cut = (await this.host.sodex.fills(a.owner, m.name, placed - EXITS_FILLS_SLACK_MS)).some((f) => f.side === close);
    } catch (e) {
      this.host.log.warn('algo: fills read failed', { algo: a.id, symbol: m.name, error: String(e) });
    }
    if (cut) {
      this.exitsFlatSince.delete(a.id);
      return true;
    }
    const now = Date.now();
    const since = this.exitsFlatSince.get(a.id) ?? now;
    this.exitsFlatSince.set(a.id, since);
    if (now - since >= EXITS_NO_FILL_MS) {
      this.host.log.warn('algo: the position reads gone without a fill that cut it; its exits are taken as outside it', { algo: a.id, symbol: m.name, sinceMs: now - since, fills: cut === null ? 'unread' : 'none' });
      this.exitsFlatSince.delete(a.id);
      return true;
    }
    this.host.log.debug('algo: the position reads gone, with no fill in SoDEX\'s trades that cut it yet; the exits stay', { algo: a.id, symbol: m.name, fills: cut === null ? 'unread' : 'none' });
    return false;
  }

  /** The owner's signed position on `symbol` from a read that left at `from` or later (one is made when the last is older). null: not readable. */
  private async positionSince(a: AlgoRecord, symbol: string, from: number): Promise<number | null> {
    try {
      if (this.host.position) return await this.host.position(a, symbol);
      const hit = this.positionsOf.get(a.owner);
      const book = hit && !hit.loading && (hit.from ?? 0) >= from && Date.now() - hit.at <= POSITIONS_MS ? hit.data : await this.loadPositions(a);
      return book ? (book[symbol]?.size ?? 0) : null;
    } catch (e) {
      this.host.log.warn('algo: position read failed', { algo: a.id, error: String(e) });
      return null;
    }
  }

  /**
   * The position an ended algo's exits protect is gone. An exit that fired while its update was
   * lost is asked of SoDEX's order history first (it closed the position: booked, the other one
   * cancelled). Otherwise it was closed outside the algo: what rests is cancelled, nothing is
   * placed again, the log says why and the trader gets an error notice.
   */
  private async exitsOutside(a: AlgoRecord, m: MarketInfo, now: number): Promise<void> {
    const live = this.liveExits(a).filter((x) => !x.cancelling);
    if (live.length) {
      // The history is drip-limited: asked again at the next watch when another read just went.
      if (this.lookupBusy || now - this.lastHistoryAt < HISTORY_EVERY_MS) return;
      this.lastHistoryAt = now;
      let hist: Awaited<ReturnType<AlgoRuntime['lookupOrders']>>;
      try {
        hist = await this.lookupOrders(a, m.name, true);
      } catch (e) {
        this.host.log.warn('algo: order lookup failed', { algo: a.id, error: String(e) });
        return;
      }
      let fired = false;
      for (const x of live) {
        const row = hist.find((r) => r.clOrdID === x.clOrdID);
        if (row && row.executedQty > 1e-12) {
          this.onExitUpdate(a, x, { clOrdID: x.clOrdID, orderId: row.orderId, symbol: m.name, status: 'FILLED', filledQty: row.executedQty, filledValue: row.executedValue, maker: false, reason: null, at: now });
          fired = true;
        }
      }
      if (fired) return;
    }
    const pulled = a.k.exitsPulled === true;
    a.k.exitsDone = true;
    a.k.exitsOutside = true;
    delete a.k.exitsPulled;
    await this.cancelExits(a, m, live);
    const what = live.length
      ? `its ${live.map((x) => x.tag).join(' and ')} ${live.length === 1 ? 'is' : 'are'} cancelled on SoDEX and not placed again`
      : pulled
        ? 'its exits, cancelled on SoDEX, are not placed again'
        : 'its exits are not placed again';
    const text = `Your ${m.name} position is gone: it was closed outside this algo (a liquidation, or by hand), so ${what}.`;
    await this.event(a, 'error', text);
    await this.save(a);
    try {
      this.host.onNotice?.(algoClosedNotice(a, text));
    } catch (e) {
      this.host.log.warn('algo: notice not taken', { error: String(e) });
    }
    this.syncWatch();
    this.host.onChange?.(a.id);
  }

  private async cancelExits(a: AlgoRecord, m: MarketInfo, list: ChildOrder[]): Promise<void> {
    const open = list.filter((x) => LIVE.has(x.state) && !x.cancelling);
    if (!open.length) return;
    for (const x of open) x.cancelling = true;
    this.dirty.add(a.id);
    if (a.spec.paper) {
      for (const x of open) {
        x.state = 'done';
        x.cancelling = false;
      }
      return;
    }
    const sink = this.host.sinkFor(a);
    if (!sink) {
      // No key here (now): nothing was sent, so they are not "being cancelled" - they are tried again when one is back (pullLeftovers, the kill switch).
      for (const x of open) x.cancelling = false;
      await this.event(a, 'error', `The ${open.map((x) => x.tag).join(' and ')} could not be cancelled: the trading key is not available here. Cancel ${open.length === 1 ? 'it' : 'them'} in your open orders.`);
      return;
    }
    try {
      await sink.cancel(a, m, open.map((x) => x.clOrdID));
      // Pulled for good (the trader's cancel, the kill switch, one cancels the other) and SoDEX took the cancel: they are over.
      // A fill that raced the cancel still comes as an order update and is booked (onExitUpdate reads the fill, not the state).
      if (FINAL_STATUSES.has(a.status) && a.k.exitsDone) {
        for (const x of open) {
          x.state = 'done';
          x.cancelling = false;
        }
      }
    } catch (e) {
      for (const x of open) x.cancelling = false;
      await this.event(a, 'error', `The exits could not be cancelled: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** An exit's update: its fill, and the other one cancelled when it fills (one cancels the other). */
  private onExitUpdate(a: AlgoRecord, x: ChildOrder, u: OrderUpdate): void {
    const dq = u.filledQty - x.filled;
    if (dq > 1e-12) {
      const dv = u.filledValue > x.value ? u.filledValue - x.value : dq * x.price;
      x.filled = u.filledQty;
      x.value += dv;
      void this.event(a, 'fill', `${x.tag === 'take-profit' ? 'Take-profit' : 'Stop-loss'} filled ${dec(dq)} @ ${(dv / dq).toPrecision(8).replace(/\.?0+$/, '')}.`, { ...x, quantity: dq, price: dv / dq });
    }
    if (u.orderId) x.orderId = u.orderId;
    x.updatedAt = Date.now();
    if (FINAL_ORDER.test(u.status)) {
      // Gone without a fill and without a cancel from here: the trader cancelled it (or SoDEX dropped it). It is not placed again.
      // Refused or expired by SoDEX after it took it: placed again, after the same wait as a refusal.
      if (!x.cancelling && x.filled <= 1e-12 && x.state !== 'done' && !a.k.exitsDone) {
        if (/^CANCEL/.test(u.status)) {
          a.k.exitsDone = true;
          // By the trader, or by SoDEX with the position (a liquidation): an ended algo asks the position once (watchExits).
          a.k.exitsPulled = true;
          void this.event(a, 'info', `The ${x.tag} was cancelled on SoDEX; its exits are not placed again.`);
        } else {
          // Nothing to reduce, maybe: an ended algo asks the position before it places a pair again (watchExits).
          const n = Number(a.k.exitsRefused ?? 0) + 1;
          a.k.exitsRefused = n;
          a.k.exitsRefusedAt = Date.now();
          a.k.exitsSize = 0;
          a.k.exitsRetryAt = Date.now() + EXITS_RETRY_MS * 2 ** (n - 1);
          if (n >= EXITS_MAX_REFUSALS) a.k.exitsGaveUp = true;
          void this.event(a, 'error', `SoDEX ${u.status.toLowerCase()} the ${x.tag}${u.reason ? `: ${u.reason}` : ''}.`);
        }
      }
      x.state = 'done';
      x.cancelling = false;
    } else if (x.state === 'sending' || x.state === 'unknown') x.state = 'open';
    if (x.filled > 1e-12 && !a.k.exitsDone) {
      a.k.exitsDone = true;
      const others = this.liveExits(a).filter((o) => o.clOrdID !== x.clOrdID);
      const m = this.markets.get(a.spec.symbol);
      if (others.length && m) {
        void this.cancelExits(a, m, others);
        void this.event(a, 'info', `${x.tag === 'take-profit' ? 'Take-profit' : 'Stop-loss'} hit: the ${others.map((o) => o.tag).join(' and ')} is cancelled (one cancels the other).`);
      }
    }
    if (!this.liveExits(a).length) this.syncWatch();
    this.dirty.add(a.id);
    this.host.onChange?.(a.id);
  }

  /** Paper exits fire here, on the mark, as SoDEX would fire the real ones. */
  private checkPaperExits(): void {
    for (const a of this.algos.values()) {
      if (!a.spec.paper || a.k.exitsDone) continue;
      const live = this.liveExits(a).filter((x) => x.state === 'open' && !x.cancelling);
      if (!live.length) continue;
      const mk = this.market.mark(a.spec.symbol)?.mark ?? null;
      if (mk === null) continue;
      const long = a.spec.side === 'buy';
      const hit = live.find((x) => (x.exit === 'tp' ? (long ? mk >= x.price : mk <= x.price) : long ? mk <= x.price : mk >= x.price));
      if (hit) this.onOrderUpdate({ clOrdID: hit.clOrdID, orderId: hit.orderId, symbol: a.spec.symbol, status: 'FILLED', filledQty: hit.quantity, filledValue: hit.quantity * mk, maker: false, reason: null, at: Date.now() });
    }
  }

  private onChildDone(a: AlgoRecord, c: ChildOrder): void {
    if (a.spec.kind === 'dca') return this.dcaChildDone(a, c);
    if (a.spec.kind === 'grid') {
      const i = gridLevelOf(c);
      const sides = a.k.gs as GridSide[] | undefined;
      if (i < 0 || !sides) return;
      // Filled whole: the level becomes the gap and the next one over takes the other side. Cut short (a pause, a re-size,
      // a refusal: onOrderUpdate holds it back a moment) the level keeps its side and goes out again.
      if (c.filled >= c.quantity - 1e-12 && sides[i] === c.side) a.k.gs = gridAfterFill(sides, i, c.side);
      return;
    }
    if (a.spec.kind !== 'iceberg') return;
    if (a.k.reprice === c.clOrdID) {
      // A clip cancelled to be re-priced shows again with what it had left once SoDEX confirmed the cancel (a fill may have landed meanwhile).
      delete a.k.reprice;
      const left = c.quantity - c.filled;
      if (left > 1e-12) a.k.clipLeft = left;
      else delete a.k.clipLeft;
    }
    if (c.filled >= c.quantity - 1e-12) {
      const s = a.spec;
      a.k.refillAt = Date.now() + Math.max(0, jitter(s.refillMs, s.refillJitter, makeRng(a.seed ^ a.childCount)));
    }
  }

  private onPrint(p: Print): void {
    for (const a of this.algos.values()) {
      if (a.status !== 'running' && a.status !== 'waiting') continue;
      if (a.spec.symbol !== p.symbol || a.startedAt === null || p.at < a.startedAt) continue;
      if (p.buyer === a.accountId || p.seller === a.accountId) continue;
      a.marketQty += p.qty;
      a.marketValue += p.qty * p.price;
      this.dirty.add(a.id);
    }
    if (this.paper.size) this.paperOnPrint(p);
  }

  /**
   * Settle children SoDEX has not told us about: an IOC with no final update,
   * a cancel with no answer, a write with no answer. Open orders first; the
   * order history (drip-limited) only when an order is gone from them. Only a
   * final order in the history settles a child: one listed nowhere is never
   * taken as over for its absence (settleUnlisted).
   */
  private async settleStale(a: AlgoRecord, m: MarketInfo, now: number): Promise<void> {
    if (a.spec.paper || this.lookupBusy) return;
    for (const c of a.children) if (c.state === 'sending' && now - c.placedAt > SENDING_MAX_MS) c.state = 'unknown';
    const stale = a.children.filter((c) => c.state === 'unknown' || (c.state === 'open' && ((c.tif === 'ioc' && now - c.updatedAt > STALE_IOC_MS) || (c.cancelling && now - c.updatedAt > STALE_IOC_MS))));
    // Exits too: a placement with no answer, or a cancel SoDEX never confirmed, would hold their resize back for good.
    for (const x of a.exitOrders ?? []) if (x.state === 'sending' && now - x.placedAt > SENDING_MAX_MS) x.state = 'unknown';
    const staleExits = (a.exitOrders ?? []).filter((x) => x.state === 'unknown' || (x.state === 'open' && x.cancelling && now - x.updatedAt > STALE_IOC_MS));
    if (!stale.length && !staleExits.length) return;
    // Children the reads already listed nowhere are read again only on the history's turn: no read per tick while they wait.
    if (!staleExits.length && stale.every((c) => c.unlisted) && now - this.lastHistoryAt < HISTORY_EVERY_MS) return;
    this.lookupBusy = true;
    try {
      const open = await this.lookupOrders(a, m.name, false);
      const missingExits: ChildOrder[] = [];
      for (const x of staleExits) {
        const row = open.find((r) => r.clOrdID === x.clOrdID);
        if (!row) {
          missingExits.push(x);
          continue;
        }
        x.state = 'open';
        x.orderId = row.orderId || x.orderId;
        x.updatedAt = now;
        if (x.cancelling) {
          x.cancelling = false;
          await this.cancelExits(a, m, [x]);
        }
      }
      const missing: ChildOrder[] = [];
      for (const c of stale) {
        const row = open.find((r) => r.clOrdID === c.clOrdID);
        if (row) {
          this.applyFill(a, c, row.executedQty, row.executedValue, null);
          c.state = 'open';
          c.orderId = row.orderId;
          c.updatedAt = now;
          delete c.unlisted;
          if (c.cancelling) {
            c.cancelling = false;
            await this.cancelChildren(a, m, [c]);
          }
        } else missing.push(c);
      }
      if ((missing.length || missingExits.length) && now - this.lastHistoryAt >= HISTORY_EVERY_MS) {
        this.lastHistoryAt = now;
        // Younger ones are only asked of the history again (it is most likely only behind).
        const unlisted = missing.filter((c) => c.unlisted && now - c.placedAt >= UNLISTED_CANCEL_MS);
        if (unlisted.length && this.tradesTurn) {
          // This turn reads SoDEX's trades for what the history did not list; the next reads the history again.
          this.tradesTurn = false;
          await this.settleUnlisted(a, m, unlisted, now);
        } else {
          this.tradesTurn = true;
          const hist = await this.lookupOrders(a, m.name, true);
          for (const x of missingExits) {
            const row = hist.find((r) => r.clOrdID === x.clOrdID);
            if (row && row.executedQty > 1e-12) {
              // It fired: booked as SoDEX's update would have been (the other one is cancelled).
              this.onExitUpdate(a, x, { clOrdID: x.clOrdID, orderId: row.orderId, symbol: m.name, status: 'FILLED', filledQty: row.executedQty, filledValue: row.executedValue, maker: false, reason: null, at: now });
            } else if (row || now - x.placedAt > 120_000) {
              // Not on SoDEX: never placed, or gone. The exits are placed again for what filled.
              x.state = 'done';
              x.cancelling = false;
              if (Number(a.k.exitsSize ?? 0) > 0 && !this.liveExits(a).some((y) => !y.cancelling)) a.k.exitsSize = 0;
            }
          }
          for (const c of missing) {
            const row = hist.find((r) => r.clOrdID === c.clOrdID);
            if (!row) {
              // Listed nowhere: proves nothing (a read that lags, a backend minutes behind). It stays live in full; its trades are read on the next turn.
              c.unlisted ??= { at: now };
              continue;
            }
            this.applyFill(a, c, row.executedQty, row.executedValue, null);
            delete c.unlisted;
            // Over only when the history says so: one it lists as NEW or PARTIALLY_FILLED (an open-orders read that lagged) may still rest and fill.
            if (FINAL_ORDER.test(row.status.toUpperCase())) this.settleChild(a, c);
          }
        }
      }
      this.dirty.add(a.id);
    } catch (e) {
      this.host.log.warn('algo: order lookup failed', { algo: a.id, error: String(e) });
    } finally {
      this.lookupBusy = false;
    }
  }

  /** A child SoDEX accounted for (a final order, or filled in full): over, for what it filled. */
  private settleChild(a: AlgoRecord, c: ChildOrder): void {
    c.state = 'done';
    c.cancelling = false;
    delete c.unlisted;
    this.onChildDone(a, c);
  }

  /**
   * Children neither SoDEX's open orders nor its order history list. That proves nothing: on
   * 2026-10-29 the history and the trades lagged the fills by tens of seconds and some backends
   * answered with an account 10-17 min old, so an order that rests or fills can be missing from
   * every read for minutes - booked as over, it and the child sent in its place could both fill.
   * So one stays live in full (pendingQty: the algo sends nothing in its place). Placed
   * UNLISTED_CANCEL_MS ago (younger, it is only asked of the history again), it is accounted for
   * from SoDEX's trades, by its client id, on every other history turn:
   *   - what the trades show it filled is booked; filled in full, it is over (it cannot fill more);
   *   - else it is cancelled by its id: from SoDEX's answer on it can neither rest nor fill (one
   *     SoDEX never had answers "not found", which the sink takes);
   *   - UNLISTED_SETTLE_MS after that cancel it is over for what the trades show, once CONFIRM_READS
   *     more trades reads agree on that fill with no read listing it in between (confirm.ts) - the
   *     trades read ends shortly after the cancel, and a full page confirms nothing.
   * Any read or update that lists it meanwhile books it as usual and starts this over.
   */
  private async settleUnlisted(a: AlgoRecord, m: MarketInfo, list: ChildOrder[], now: number): Promise<void> {
    const since = Math.min(...list.map((c) => c.placedAt)) - EXITS_FILLS_SLACK_MS;
    // Nothing of theirs fills after their cancels: the read stops there (with the clocks' slack), so its page holds a short window.
    const until = list.every((c) => c.unlisted?.cancelAt !== undefined) ? Math.max(...list.map((c) => c.unlisted!.cancelAt!)) + EXITS_FILLS_SLACK_MS : undefined;
    let fills: Awaited<ReturnType<SodexClient['fills']>> | null = null;
    try {
      fills = await this.host.sodex.fills(a.owner, m.name, since, until);
    } catch (e) {
      this.host.log.warn('algo: fills read failed', { algo: a.id, symbol: m.name, error: String(e) });
    }
    const full = fills !== null && fills.length >= FILLS_PAGE;
    for (const c of list) {
      const u = (c.unlisted ??= { at: now });
      let seen: number | null = null;
      if (fills) {
        const own = fills.filter((f) => f.clOrdID === c.clOrdID);
        seen = own.reduce((x, f) => x + f.qty, 0);
        // Booked as an update would have been: applyFill only ever adds.
        if (own.length) this.applyFill(a, c, seen, own.reduce((x, f) => x + f.qty * f.price, 0), null);
        if (c.filled >= c.quantity - 1e-12) {
          await this.event(a, 'info', `SoDEX's trades show ${c.tag} filled in full (${dec(c.filled)}).`, c);
          this.settleChild(a, c);
          continue;
        }
      }
      if (u.cancelAt === undefined) {
        const sink = this.host.sinkFor(a);
        if (!sink) continue;
        try {
          await sink.cancel(a, m, [c.clOrdID]);
        } catch (e) {
          this.host.log.warn('algo: cancel of an unlisted child failed', { algo: a.id, child: c.clOrdID, error: String(e) });
          continue;
        }
        u.cancelAt = Date.now();
        c.cancelling = true;
        c.updatedAt = u.cancelAt;
        await this.event(a, 'info', `SoDEX does not list ${c.tag}: cancelled by its id, so it can neither rest nor fill. Nothing is sent in its place until SoDEX's trades agree on what it filled (about ${Math.round(UNLISTED_SETTLE_MS / 60_000)} min).`, c);
        continue;
      }
      if (now - u.cancelAt < UNLISTED_SETTLE_MS) continue;
      if (seen === null || full) {
        // Unread, or a page that may have left fills out: confirms nothing, and breaks the agreement so far.
        delete u.agree;
        if (full) this.host.log.warn('algo: the trades read for an unlisted child is a full page; not settled on it', { algo: a.id, child: c.clOrdID });
        continue;
      }
      // Each agreeing read after the wait counts; one that shows another fill starts over (sizeView: float noise is no disagreement).
      u.agree = u.fill !== undefined && sizeView(u.fill) === sizeView(seen) ? (u.agree ?? 0) + 1 : 1;
      u.fill = seen;
      if (u.agree <= CONFIRM_READS) continue;
      await this.event(a, 'info', `SoDEX never listed ${c.tag} again after its cancel; its trades agree it filled ${dec(c.filled)}, so it is over.`, c);
      this.settleChild(a, c);
    }
    this.dirty.add(a.id);
  }

  private async lookupOrders(a: AlgoRecord, symbol: string, history: boolean) {
    if (this.host.lookup) return this.host.lookup(a, symbol, history);
    const path = `/api/v1/perps/accounts/${a.owner}/orders${history ? '/history' : ''}?symbol=${encodeURIComponent(symbol)}${history ? '&limit=100' : ''}`;
    const data = await this.host.sodex.get<unknown>(path);
    const list = Array.isArray(data) ? data : ((data as { orders?: unknown[] } | null)?.orders ?? []);
    return (list as Array<Record<string, unknown>>)
      .filter((r) => typeof r.clOrdID === 'string')
      .map((r) => ({ clOrdID: r.clOrdID as string, orderId: String(r.orderID ?? ''), status: String(r.status ?? ''), executedQty: Number(r.executedQty ?? 0) || 0, executedValue: Number(r.executedValue ?? 0) || 0 }));
  }

  /**
   * The owner's signed position on `symbol`, read now. A paper algo uses what
   * its own paper fills built, and otherwise the real position (only read).
   */
  /** The leverage of the owner's open position on `symbol`, as SoDEX last reported it (null: no open position, or none reported). */
  private positionLeverage(a: AlgoRecord, symbol: string): number | null {
    const p = this.positionsOf.get(a.owner)?.data[symbol];
    return p && p.size !== 0 && typeof p.leverage === 'number' && p.leverage > 0 ? p.leverage : null;
  }

  /**
   * The owner's position on `symbol` for a decision that is not taken back - the size of a close
   * (it closes that much), an algo ended for want of a position: read, then confirmed by
   * CONFIRM_READS more reads that agree on it (confirm.ts). null: not readable; 'disagree': the
   * reads did not agree (read again on a later step, no sooner than CONFIRM_RETRY_MS). Paper uses
   * its own position, as positionOf does.
   */
  private async positionConfirmed(a: AlgoRecord, symbol: string): Promise<number | null | 'disagree'> {
    if (a.spec.paper) return this.positionOf(a, symbol);
    if (Date.now() < (this.confirmRetryAt.get(a.id) ?? 0)) return 'disagree';
    const first = await this.positionOf(a, symbol);
    if (first === null) return null;
    const c = await confirmRead<number | null>(first, () => this.positionOf(a, symbol), sizeView, { gapMs: this.host.confirmGapMs });
    if (c.ok) {
      this.confirmRetryAt.delete(a.id);
      return c.value;
    }
    this.confirmRetryAt.set(a.id, Date.now() + CONFIRM_RETRY_MS);
    this.host.log.warn('algo: SoDEX\'s reads of the position disagree; nothing decided on it this step', { algo: a.id, symbol, reads: c.seen });
    return 'disagree';
  }

  /**
   * A conditional with a position condition fires (once, for good) only when CONFIRM_READS more
   * reads of the positions, CONFIRM_GAP_MS apart, still meet its conditions: a backend that is
   * behind reads a position closed minutes ago, or none where one was just opened (confirm.ts).
   */
  private async positionsAgree(a: AlgoRecord, s: Extract<AlgoSpec, { kind: 'conditional' }>, now: number): Promise<boolean> {
    if (Date.now() < (this.confirmRetryAt.get(a.id) ?? 0)) return false;
    for (let i = 0; i < CONFIRM_READS; i++) {
      const gap = this.host.confirmGapMs ?? CONFIRM_GAP_MS;
      if (gap > 0) await sleep(gap);
      const book = await this.loadPositions(a);
      if (this.stopped(a)) return false;
      const ok = book ? s.conditions.map((c, j) => this.conditionHolds(a, c, j, now)) : [];
      if (!book || !(s.match === 'all' ? ok.every(Boolean) : ok.some(Boolean))) {
        this.confirmRetryAt.set(a.id, Date.now() + CONFIRM_RETRY_MS);
        this.host.log.warn('algo: a position condition held on one read of SoDEX and not on the next; not fired', { algo: a.id, read: i + 2 });
        return false;
      }
    }
    this.confirmRetryAt.delete(a.id);
    return true;
  }

  private async positionOf(a: AlgoRecord, symbol: string): Promise<number | null> {
    const paperPos = a.k.paperPos;
    if (a.spec.paper && typeof paperPos === 'number' && paperPos !== 0) return paperPos;
    try {
      if (this.host.position) return await this.host.position(a, symbol);
      const book = await this.loadPositions(a);
      return book ? (book[symbol]?.size ?? 0) : null;
    } catch (e) {
      this.host.log.warn('algo: position read failed', { algo: a.id, error: String(e) });
      return null;
    }
  }

  private async profileFor(symbol: string, start: number, durationMs: number, slices: number, lookbackDays: number) {
    const { interval, ms } = profileCandles(lookbackDays);
    const from = start - lookbackDays * DAY_MS;
    const to = start - DAY_MS + durationMs;
    const candles: Candle[] = [];
    if (this.host.candles) candles.push(...(await this.host.candles(symbol, interval, from, to)));
    else {
      for (let t = from; t < to; t += 1000 * ms) {
        const data = await this.host.sodex.get<unknown>(`/api/v1/perps/markets/${encodeURIComponent(symbol)}/klines?interval=${interval}&limit=1000&startTime=${t}&endTime=${Math.min(to, t + 1000 * ms)}`);
        const list = Array.isArray(data) ? data : ((data as { klines?: unknown[] } | null)?.klines ?? []);
        for (const k of list as Array<Record<string, unknown> | unknown[]>) {
          const t0 = Array.isArray(k) ? Number(k[0]) : Number((k as Record<string, unknown>).t ?? (k as Record<string, unknown>).openTime);
          const v = Array.isArray(k) ? Number(k[5]) : Number((k as Record<string, unknown>).v ?? (k as Record<string, unknown>).volume);
          if (Number.isFinite(t0) && Number.isFinite(v)) candles.push({ t: t0, v });
        }
      }
    }
    if (!candles.length) return null;
    return volumeProfile(candles, ms, start, durationMs, slices, lookbackDays);
  }

  private async problemOf(a: AlgoRecord, now: number): Promise<string | null> {
    if (!this.host.problem) return null;
    const hit = this.problems.get(a.id);
    if (hit && now - hit.at < PROBLEM_RECHECK_MS) return hit.problem;
    let problem: string | null = null;
    try {
      problem = await this.host.problem(a);
    } catch (e) {
      this.host.log.warn('algo: readiness check failed', { algo: a.id, error: String(e) });
      // The last answer stands; with none yet, it is not "no problem": a live algo never trades unchecked. Checked again soon.
      if (!hit || hit.unchecked) {
        const why = 'Held: whether this algo may trade (key, fee approval) could not be checked with SoDEX; trying again.';
        this.problems.set(a.id, { at: now - PROBLEM_RECHECK_MS + 5_000, problem: why, unchecked: true });
        return why;
      }
      problem = hit.problem;
    }
    this.problems.set(a.id, { at: now, problem });
    return problem;
  }

  private isDone(a: AlgoRecord, m: MarketInfo): boolean {
    const t = this.targetOf(a);
    if (t === null) return false;
    return t - a.filled < Math.max(Number(m.stepSize), Number(m.minQuantity) || 0) - 1e-12 && !this.live(a).length;
  }

  /* -------------------------------------------------------------- paper ----- */

  private paperPlace(a: AlgoRecord, m: MarketInfo, children: ChildOrder[]): ChildResult[] {
    const q = this.market.quote(m.name);
    const out: ChildResult[] = [];
    for (const c of children) {
      out.push({ clOrdID: c.clOrdID, ok: true, orderId: `paper-${c.clOrdID}`, error: null, outcomeUnknown: false });
      const touch = q ? (c.side === 'buy' ? q.ask : q.bid) : null;
      const crosses = touch !== null && (c.side === 'buy' ? c.price >= touch : c.price <= touch);
      const emit = (status: string, filled: number, value: number, maker: boolean | null) =>
        timers.after(0, () => this.onOrderUpdate({ clOrdID: c.clOrdID, orderId: `paper-${c.clOrdID}`, symbol: m.name, status, filledQty: filled, filledValue: value, maker, reason: status === 'REJECTED' ? 'post-only order would take' : null, at: Date.now() }));
      if (c.tif === 'ioc') {
        if (crosses) {
          this.paperPosition(a, c.side, c.quantity);
          emit('FILLED', c.quantity, c.quantity * touch!, false);
        } else emit('CANCELED', 0, 0, null);
        continue;
      }
      if (crosses) {
        if (c.tif === 'gtx') emit('REJECTED', 0, 0, null);
        else {
          this.paperPosition(a, c.side, c.quantity);
          emit('FILLED', c.quantity, c.quantity * touch!, false);
        }
        continue;
      }
      this.paper.set(c.clOrdID, { algoId: a.id, clOrdID: c.clOrdID, symbol: m.name, side: c.side, price: c.price, left: c.quantity, filled: 0, value: 0 });
      emit('NEW', 0, 0, null);
    }
    return out;
  }

  private paperPosition(a: AlgoRecord, side: Side, qty: number): void {
    a.k.paperPos = Number(a.k.paperPos ?? 0) + (side === 'buy' ? qty : -qty);
  }

  private paperCancel(clOrdID: string): void {
    const o = this.paper.get(clOrdID);
    this.paper.delete(clOrdID);
    const id = this.byClOrd.get(clOrdID);
    const a = id ? this.algos.get(id) : undefined;
    const c = a?.children.find((x) => x.clOrdID === clOrdID);
    timers.after(0, () => this.onOrderUpdate({ clOrdID, orderId: `paper-${clOrdID}`, symbol: o?.symbol ?? a?.spec.symbol ?? '', status: 'CANCELED', filledQty: o?.filled ?? c?.filled ?? 0, filledValue: o?.value ?? c?.value ?? 0, maker: null, reason: null, at: Date.now() }));
  }

  /** A resting paper order fills as the tape trades through its price (a sell print at or under a buy, and so on). */
  private paperOnPrint(p: Print): void {
    for (const o of this.paper.values()) {
      if (o.symbol !== p.symbol) continue;
      const through = o.side === 'buy' ? p.price <= o.price && p.taker === 'sell' : p.price >= o.price && p.taker === 'buy';
      if (!through) continue;
      const q = Math.min(o.left, p.qty);
      o.left -= q;
      o.filled += q;
      o.value += q * o.price;
      const a = this.algos.get(o.algoId);
      if (a) this.paperPosition(a, o.side, q);
      const done = o.left <= 1e-12;
      if (done) this.paper.delete(o.clOrdID);
      this.onOrderUpdate({ clOrdID: o.clOrdID, orderId: `paper-${o.clOrdID}`, symbol: o.symbol, status: done ? 'FILLED' : 'PARTIALLY_FILLED', filledQty: o.filled, filledValue: o.value, maker: true, reason: null, at: p.at });
    }
  }

  /* -------------------------------------------------------------- status ----- */

  /** The follower hears of it (notices.ts algoNotice decides what is worth it); a host that throws never stops the algo. */
  private notice(a: AlgoRecord, status: AlgoStatus, reason: string | null): void {
    const n = algoNotice(a, status, reason);
    if (!n) return;
    try {
      this.host.onNotice?.(n);
    } catch (e) {
      this.host.log.warn('algo: notice not taken', { error: String(e) });
    }
  }

  private async setStatus(a: AlgoRecord, status: AlgoStatus, reason: string | null): Promise<void> {
    if (a.status === status && a.statusReason === reason) return;
    // An ended algo stays ended (a step that was in flight when it was cancelled cannot bring it back).
    if (FINAL_STATUSES.has(a.status)) return;
    const changed = a.status !== status;
    a.status = status;
    a.statusReason = reason;
    a.updatedAt = Date.now();
    await this.save(a);
    if (changed && status !== 'running') await this.event(a, 'status', reason ?? status);
    else if (reason && changed) await this.event(a, 'status', reason);
    if (changed) this.notice(a, status, reason);
    this.host.onChange?.(a.id);
  }

  /** A line in the algo's activity, once per algo: a child size it had to decide as it runs (sizes.ts head). */
  private async noteOnce(a: AlgoRecord, key: string, text: string): Promise<void> {
    const noted = (a.k.noted as Record<string, true> | undefined) ?? {};
    if (noted[key]) return;
    a.k.noted = { ...noted, [key]: true };
    this.dirty.add(a.id);
    await this.event(a, 'info', text);
  }

  private async hold(a: AlgoRecord, reason: string): Promise<void> {
    this.heldNow.add(a.id);
    // Paused or ended meanwhile: that stands; a hold does not overwrite it.
    if (this.stopped(a)) return;
    if (a.status === 'scheduled') {
      if (a.statusReason !== reason) {
        a.statusReason = reason;
        this.dirty.add(a.id);
      }
      return;
    }
    if (a.status === 'waiting' && a.statusReason === reason) return;
    a.status = 'waiting';
    a.statusReason = reason;
    a.updatedAt = Date.now();
    this.dirty.add(a.id);
    await this.event(a, 'status', reason);
    this.host.onChange?.(a.id);
  }

  private async run(a: AlgoRecord): Promise<void> {
    if (a.status === 'running') return;
    if (a.status === 'waiting') {
      a.status = 'running';
      a.statusReason = null;
      a.updatedAt = Date.now();
      this.dirty.add(a.id);
      this.host.onChange?.(a.id);
    }
  }

  private async end(a: AlgoRecord, status: AlgoStatus, reason: string, o: { keep?: string[] } = {}): Promise<void> {
    if (FINAL_STATUSES.has(a.status)) return;
    // A basket's legs end with it (a bound that stops it, a leg that could not start): none runs on alone.
    for (const leg of this.legsOf(a)) if (!FINAL_STATUSES.has(leg.status)) await this.end(leg, status === 'failed' ? 'cancelled' : 'expired', `Stopped with its basket: ${reason}`);
    await this.pullResting(a, o.keep ?? []);
    if (o.keep?.length) a.k.kept = o.keep;
    for (const id of o.keep ?? []) this.paper.delete(id);
    // What it filled keeps its exits, sized to the final fill - whatever the reason it ended.
    const m = this.markets.get(a.spec.symbol);
    if (m && a.spec.exits && a.filled > 0) await this.syncExits(a, m, true);
    a.status = status;
    a.statusReason = reason;
    a.endedAt = Date.now();
    a.updatedAt = a.endedAt;
    await this.save(a);
    await this.event(a, 'status', reason);
    this.notice(a, status, reason);
    if (status === 'cancelled' && this.liveExits(a).length) await this.event(a, 'info', 'Its exits stay on SoDEX for what filled; cancel them in your open orders if you do not want them.');
    this.syncWatch();
    this.host.onChange?.(a.id);
  }

  private need(id: string): AlgoRecord {
    const a = this.algos.get(id);
    if (!a) throw new Error('No such algo.');
    return a;
  }

  private async save(a: AlgoRecord): Promise<void> {
    this.dirty.delete(a.id);
    await this.host.store.saveAlgo(a).catch((e) => this.host.log.error('algo: not saved', { algo: a.id, error: String(e) }));
  }

  private async flush(): Promise<void> {
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const a = this.algos.get(id);
      if (a) await this.host.store.saveAlgo(a).catch((e) => this.host.log.error('algo: not saved', { algo: id, error: String(e) }));
      this.host.onChange?.(id);
    }
  }

  private async event(a: AlgoRecord, kind: AlgoEventKind, text: string, c?: Partial<ChildOrder>): Promise<void> {
    const at = Date.now();
    const e: AlgoEvent = {
      // Sorts by time, then by the order it was written: lines of one millisecond keep their order.
      id: `e${at.toString(36)}${(++this.eventSeq).toString(36).padStart(6, '0')}${randomId().slice(0, 4)}`,
      algoId: a.id,
      owner: a.owner,
      at,
      kind,
      text,
      clOrdID: c?.clOrdID ?? null,
      side: c?.side ?? null,
      price: c?.price ?? null,
      qty: c?.quantity ?? null,
      paper: a.spec.paper,
    };
    await this.host.store.addAlgoEvent(e).catch((err) => this.host.log.error('algo: event not saved', { error: String(err) }));
  }
}
