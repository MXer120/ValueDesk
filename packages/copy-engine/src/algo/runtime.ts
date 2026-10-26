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
import { randomId, timers, type Logger, type WebSocketFactory } from '../io.ts';
import { MarketBook, snapPrice } from '../markets.ts';
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
  mid,
  minChildQty,
  newSeed,
  nextSlice,
  profileCandles,
  spreadBps,
  takerPrice,
  trail,
  volumeProfile,
  type Candle,
  type Quote,
  type TrailState,
} from './math.ts';
import { combineOracle, type OracleVenue, type VenueQuote } from '../oracle.ts';
import { SWEEP_MAX_AGE_MS, sweepRefFor, sweepStep } from './sweep.ts';
import { exitLevels, scaleLadder, swarmClips, twapSchedule, vwapSchedule } from './plan.ts';
import type { AlgoSink, ChildRequest, ChildResult, StopRequest } from './sink.ts';
import { ALGO_NAMES, algoQuantity, algoSymbols, opensPosition, parseAlgoSpec } from './spec.ts';
import type { AlgoStore } from './store.ts';
import {
  FINAL_STATUSES,
  SLIP_FROM_NAMES,
  type AlgoEvent,
  type AlgoEventKind,
  type AlgoRecord,
  type AlgoSpec,
  type AlgoStatus,
  type AlgoView,
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
const DONE_KEPT = 60;
const MAX_CONSEC_REJECTS = 25;
const PROBLEM_RECHECK_MS = 60_000;
/** POV and DCA hybrids: due quantity older than this is taken. */
const LATE_MS = 30_000;
/** After a taker child that filled nothing, the next one waits this long. */
const TAKER_RETRY_MS = 1_000;
/** Positions are read again after this (position conditions). */
const POSITIONS_MS = 5_000;
/** The account (equity, gross exposure) is read again after this (the region's leverage ceiling). */
const ACCOUNT_MS = 10_000;
/** While an entry is filling, its exits are resized at most this often. */
const EXITS_RESIZE_MS = 5_000;

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
  /** The owner's signed position on `symbol` (default: read from SoDEX). */
  position?(a: AlgoRecord, symbol: string): Promise<number | null>;
  /** The owner's positions: signed size and entry per market (default: read from SoDEX). Position conditions read these. */
  positions?(a: AlgoRecord): Promise<Record<string, { size: number; entry: number }>>;
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
  log: Logger;
  onChange?(id: string): void;
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

const dec = (n: number): string => canonicalDecimal(numberToPlainString(Number(n.toPrecision(12))));

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
  private leverageSet = new Set<string>();
  private problems = new Map<string, { at: number; problem: string | null }>();
  private lastHistoryAt = 0;
  private lookupBusy = false;
  /** Algos that raised a hold in the step now running (steps of one algo never overlap). */
  private heldNow = new Set<string>();
  private eventSeq = 0;
  /** Each owner's positions and account, read at most every few seconds (conditions, closes, the leverage ceiling). */
  private positionsOf = new Map<string, { at: number; data: Record<string, { size: number; entry: number }>; loading: boolean }>();
  private accounts = new Map<string, { at: number; equity: number; gross: number }>();
  /** Algos whose exits are being placed or resized right now. */
  private exitsBusy = new Set<string>();
  private paper = new Map<string, PaperOrder>();
  private timers: unknown[] = [];
  private running = false;
  /** The sweep oracle's last quotes per coin, and the read in flight. */
  private oracleQuotes = new Map<string, { quotes: VenueQuote[]; at: number; busy: boolean }>();

  constructor(private readonly host: AlgoHost) {
    if (host.market) this.market = host.market;
    else {
      if (!host.factory) throw new Error('an algo runtime needs a market feed or a WebSocket factory');
      this.market = new AlgoFeed({ network: host.network, factory: host.factory, log: host.log });
    }
    this.market.onOrder((u) => this.onOrderUpdate(u));
    this.market.onPrint((p) => this.onPrint(p));
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
      if (FINAL_STATUSES.has(a.status)) continue;
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
    const owners = new Set<string>();
    for (const a of this.algos.values()) {
      const exits = this.liveExits(a).length > 0;
      if (FINAL_STATUSES.has(a.status) && !exits) continue;
      for (const s of algoSymbols(a.spec)) symbols.add(s);
      if (!a.spec.paper) owners.add(a.owner);
    }
    this.market.watch([...symbols], [...owners]);
  }

  /** Exits still on SoDEX (or on the paper book), not yet settled. */
  private liveExits(a: AlgoRecord): ChildOrder[] {
    return (a.exitOrders ?? []).filter((x) => LIVE.has(x.state));
  }

  /* ------------------------------------------------------------- the API ----- */

  get(id: string): AlgoRecord | null {
    return this.algos.get(id) ?? null;
  }

  list(owner?: string): AlgoRecord[] {
    const o = owner?.toLowerCase();
    return [...this.algos.values()].filter((a) => !o || a.owner === o).sort((x, y) => y.createdAt - x.createdAt);
  }

  /** Start an algo. The spec is validated here as everywhere (parseAlgoSpec); its market must be listed. */
  async add(n: NewAlgo): Promise<AlgoRecord> {
    const spec = parseAlgoSpec(n.spec);
    if (!this.markets.size) await this.loadMarkets();
    for (const sym of algoSymbols(spec)) {
      const m = this.markets.get(sym);
      if (!m) throw new Error(`${sym} is not listed on SoDEX perps.`);
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

  async pause(id: string): Promise<AlgoRecord> {
    const a = this.need(id);
    if (FINAL_STATUSES.has(a.status)) throw new Error('This algo has ended.');
    if (a.status === 'paused') return a;
    a.k.pausedFrom = a.status;
    await this.setStatus(a, 'paused', 'Paused by you.');
    await this.pullResting(a);
    for (const c of this.legsOf(a)) if (!FINAL_STATUSES.has(c.status)) await this.pause(c.id);
    return a;
  }

  async resume(id: string): Promise<AlgoRecord> {
    const a = this.need(id);
    if (a.status !== 'paused') return a;
    const back = a.k.pausedFrom === 'scheduled' ? 'scheduled' : 'running';
    delete a.k.pausedFrom;
    await this.setStatus(a, back, null);
    for (const c of this.legsOf(a)) if (c.status === 'paused') await this.resume(c.id);
    return a;
  }

  /**
   * Cancel an algo: its resting children are cancelled on SoDEX; what filled
   * stays filled, and its exits stay on SoDEX to protect that (the log says so).
   */
  async cancel(id: string): Promise<AlgoRecord> {
    const a = this.need(id);
    if (FINAL_STATUSES.has(a.status)) return a;
    for (const c of this.legsOf(a)) if (!FINAL_STATUSES.has(c.status)) await this.cancel(c.id);
    await this.end(a, 'cancelled', 'Cancelled by you.');
    return a;
  }

  /** A basket's legs (the algos it started). */
  private legsOf(a: AlgoRecord): AlgoRecord[] {
    return ((a.k.legs as string[] | undefined) ?? []).map((id) => this.algos.get(id)).filter((x): x is AlgoRecord => !!x);
  }

  /** The kill switch: every algo of `owner` is cancelled. */
  async cancelAll(owner: string): Promise<AlgoRecord[]> {
    const out: AlgoRecord[] = [];
    for (const a of this.list(owner)) if (!FINAL_STATUSES.has(a.status)) out.push(await this.cancel(a.id));
    return out;
  }

  /**
   * Change a running algo where that is safe: its limit price, bounds, spread
   * guard and label any time; its size only upward of what has filled (and,
   * for a schedule, from the next slice on).
   */
  async update(id: string, patch: Partial<Pick<AlgoSpec, 'limitPrice' | 'upper' | 'lower' | 'maxSpreadBps' | 'label'>> & { quantity?: string }): Promise<AlgoRecord> {
    const a = this.need(id);
    if (FINAL_STATUSES.has(a.status)) throw new Error('This algo has ended.');
    const next = { ...a.spec, ...patch } as Record<string, unknown>;
    if (patch.quantity !== undefined) {
      if (!('quantity' in a.spec) || a.spec.kind === 'trailing') throw new Error('The size of this kind of algo cannot be changed.');
      if (Number(patch.quantity) <= a.filled) throw new Error('The new size must be more than what has filled.');
    }
    const spec = parseAlgoSpec(next);
    a.spec = spec;
    await this.save(a);
    await this.event(a, 'info', 'Changed by you.');
    return a;
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
      if (FINAL_STATUSES.has(a.status) || this.busy.has(a.id)) continue;
      this.busy.add(a.id);
      void this.step(a, now)
        .catch(async (e) => {
          this.host.log.error('algo: a step failed', { algo: a.id, error: String(e) });
          await this.event(a, 'error', `Step failed: ${e instanceof Error ? e.message : String(e)}`).catch(() => {});
        })
        .finally(() => this.busy.delete(a.id));
    }
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
      const problem = await this.problemOf(a, now);
      if (problem) {
        await this.hold(a, problem);
        return;
      }
      // The region rules apply to live algos as to copies: a blocked region holds it (policy.ts).
      const policy = this.host.policyFor?.(a) ?? null;
      if (policy && !policy.allowed) {
        await this.hold(a, `Held: ${policy.reason ?? 'not available in your region.'}`);
        return;
      }
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
      await this.begin(a, m, now);
      if (FINAL_STATUSES.has(a.status)) return;
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
    const key = `${coin}|${venues?.length ? [...venues].sort().join(',') : '*'}`;
    let o = this.oracleQuotes.get(key);
    if (!o) {
      o = { quotes: [], at: 0, busy: false };
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

  /** Fill fast (sweep.ts): an IOC at the band edge for the rest, each round re-priced from the reference. */
  private async stepSweep(a: AlgoRecord, m: MarketInfo, now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'sweep' }>;
    const coin = s.symbol.replace(/-USD$/, '');
    const mark = this.market.mark(s.symbol);
    // SoDEX's own prices only when the spec asks for them or as the fallback: the oracle is not read for a mark or index sweep.
    const own = s.reference === 'mark' || s.reference === 'index';
    const book = this.market.quote(s.symbol);
    const ref = sweepRefFor(s, own ? [] : this.oracleFor(coin, now, s.venues), mark ? { mark: mark.mark, index: mark.index, at: mark.at } : null, now, SWEEP_MAX_AGE_MS);
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
    });
    switch (act.type) {
      case 'done':
        return this.end(a, 'done', a.filled > 0 ? 'Filled.' : 'Nothing left to fill.');
      case 'expired':
        return this.end(a, 'expired', `Gave up: ${dec(act.left)} ${m.base} left unfilled inside the band.`);
      case 'wait':
        if (act.reason) await this.hold(a, act.reason);
        return;
      case 'send': {
        a.k.roundAt = now;
        a.k.round = Number(a.k.round ?? 0) + 1;
        a.k.ref = ref?.price ?? null;
        this.dirty.add(a.id);
        await this.send(a, m, [{ side: s.side, price: act.price, quantity: act.qty, tif: 'ioc', tag: `round ${a.k.round}${ref?.fallback ? ' (SoDEX mark, no fresh oracle)' : ''}` }]);
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

  /** Start working: the arrival price, the schedule, the profile. */
  private async begin(a: AlgoRecord, m: MarketInfo, now: number): Promise<void> {
    const s = a.spec;
    const q = this.market.quote(s.symbol);
    a.startedAt = now;
    a.arrival = q ? mid(q) : (this.market.mark(s.symbol)?.mark ?? null);
    if (s.kind === 'twap') {
      if (s.closeShare !== null) {
        // A time-sliced close: its size and side are the position's, now.
        const pos = await this.positionOf(a, s.symbol);
        const size = pos === null ? 0 : floorStep(Math.abs(pos) * s.closeShare, m);
        if (!pos || size < Number(m.stepSize)) {
          a.startedAt = null;
          await this.end(a, 'expired', pos === null ? `Your position on ${m.name} could not be read; nothing was closed.` : `There is no position on ${m.name} to close.`);
          return;
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
    } else if (s.kind === 'swarm') {
      a.k.clips = swarmClips(s, m, a.seed);
      a.k.next = 0;
      a.k.retriesLeft = s.retries;
      a.k.waveAt = now;
    }
    await this.setStatus(a, 'running', null);
    await this.event(a, 'status', a.arrival ? `Started. Arrival price ${a.arrival}.` : 'Started.');
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
    o: { due: number; late: number; total: number; exec: ExecSpec; tag: string; maxChild?: number | null; minChild?: number | null; minRepriceMs?: number; side?: Side; reduceOnly?: boolean; more?: boolean },
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
    const cap = o.maxChild !== undefined && o.maxChild !== null ? o.maxChild : Infinity;
    const room = Math.max(0, o.total - a.filled);
    const need = Math.min(room, o.due - a.filled);
    const lateNeed = Math.min(need, o.late - a.filled);
    const resting = live.find((c) => c.tif !== 'ioc') ?? null;
    const taking = live.find((c) => c.tif === 'ioc') ?? null;
    if (taking) return;

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
      let qty = floorStep(lateNeed, m);
      if (need - qty < minQ) qty = floorStep(need, m);
      qty = Math.min(qty, floorStep(cap, m));
      if (qty < minQ) {
        // Less than SoDEX takes in one order: what is left at the very end is dust.
        if (room < minQ && o.late >= o.total && !o.more) await this.end(a, 'done', a.filled > 0 ? `Filled; ${dec(room)} ${m.base} under SoDEX's minimum order was left.` : 'Under SoDEX\'s minimum order size: nothing could be sent.');
        return;
      }
      const from = this.slipBase(s.symbol, o.exec, q);
      if (from === undefined) {
        await this.hold(a, `Held: no fresh ${SLIP_FROM_NAMES[o.exec.slipFrom ?? 'touch'].toLowerCase()} to measure your max slippage from.`);
        return;
      }
      const price = takerPrice(side, q, o.exec.slippageBps, m, mk, limit, from);
      if (price === null) {
        await this.hold(a, `Held: the price is past your limit of ${limit}.`);
        return;
      }
      await this.send(a, m, [{ side, price, quantity: qty, tif: 'ioc', tag: o.tag, reduceOnly }]);
      return;
    }

    if (o.exec.style === 'taker') return;
    const want = floorStep(Math.min(need, cap), m);
    const price = makerPrice(side, q, o.exec.offsetTicks, null, m, limit);
    if (resting) {
      const tick = Number(m.tickSize);
      const left = resting.quantity - resting.filled;
      const off = Math.abs(resting.price - price) / tick;
      const since = Date.now() - resting.placedAt;
      const reprice = off >= o.exec.chaseTicks - 1e-9 && since >= (o.minRepriceMs ?? 1_500);
      const grow = want - left >= minQ;
      const shrink = left - want > 1e-12 && want < minQ;
      if (reprice || grow || shrink) await this.cancelChildren(a, m, [resting]);
      return;
    }
    if (want < minChildQty(m, price)) return;
    await this.send(a, m, [{ side, price, quantity: want, tif: 'gtx', tag: o.tag, reduceOnly }]);
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
    const vol = s.maxParticipation !== null ? this.market.volume(s.symbol, Math.max(interval, 5_000)).qty : null;
    let maxChild = vol !== null && !finishing ? Math.max(0, vol * s.maxParticipation!) : Infinity;
    if (s.kind === 'twap' && s.maxSliceQty !== null) maxChild = Math.min(maxChild, Number(s.maxSliceQty));
    await this.work(a, m, q, mk, {
      due: finishing ? total : total * share,
      late: finishing ? total : total * lateShare,
      total,
      exec: s.exec,
      tag: finishing ? 'finish' : `slice ${i + 1}/${times.length}`,
      maxChild: Number.isFinite(maxChild) ? maxChild : null,
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
    // What everyone else traded since it began, times the rate.
    const due = Math.min(total, s.rate * a.marketQty);
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

  private async stepDca(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number, now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'dca' }>;
    const start = a.startedAt!;
    let done = Number(a.k.done ?? 0);
    let skipped = Number(a.k.skipped ?? 0);
    let spent = Number(a.k.spentUsd ?? 0);
    let target = Number(a.k.targetQty ?? 0);
    const budget = s.maxTotalUsd ?? Infinity;
    // Every installment whose time has come, in order.
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
      target += usd / px;
      spent += usd;
      done++;
    }
    a.k.done = done;
    a.k.skipped = skipped;
    a.k.spentUsd = spent;
    a.k.targetQty = target;
    this.dirty.add(a.id);
    const over = done + skipped >= s.orders || spent >= budget - 1e-9;
    const left = target - a.filled - this.pendingQty(a);
    if (over && left < minChildQty(m, mk) && !this.live(a).length) return this.end(a, 'done', `${done} order${done === 1 ? '' : 's'} filled${skipped ? `, ${skipped} skipped` : ''}.`);
    const h = this.dueHistory(a, now, target);
    const late = s.exec.style === 'taker' ? target : s.exec.style === 'hybrid' ? this.dueAgo(h, now - Math.min(LATE_MS * 4, s.exec.makerShare * s.intervalMs)) : over ? target : 0;
    await this.work(a, m, q, mk, { due: target, late: a.k.rush ? target : late, total: target, exec: s.exec, tag: `order ${done}/${s.orders}`, more: !over });
  }

  private async stepIceberg(a: AlgoRecord, m: MarketInfo, q: Quote, now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'iceberg' }>;
    const total = Number(s.quantity);
    const live = this.live(a);
    if (!live.length && this.isDone(a, m)) return this.end(a, 'done', 'Filled.');
    const pegged = s.price === null;
    const tif: ChildTif = s.postOnly ? 'gtx' : 'gtc';
    const desired = pegged ? makerPrice(s.side, q, s.pegOffsetTicks, null, m, s.limitPrice) : s.price!;
    if (live.length) {
      const c = live[0]!;
      if (c.state !== 'open' || c.cancelling) return;
      if (pegged && Math.abs(c.price - desired) / Number(m.tickSize) >= s.chaseTicks - 1e-9 && now - c.placedAt >= 1_000) {
        a.k.clipLeft = Math.max(0, c.quantity - c.filled);
        await this.cancelChildren(a, m, [c]);
      }
      return;
    }
    if (a.k.rush) {
      return this.work(a, m, q, this.market.mark(s.symbol)?.mark ?? mid(q), { due: total, late: total, total, exec: { style: 'taker', slippageBps: 50, offsetTicks: 0, chaseTicks: 1, makerShare: 0.5 }, tag: 'rush' });
    }
    if (typeof a.k.refillAt === 'number' && now < a.k.refillAt) return;
    const room = total - a.filled;
    const minQ = minChildQty(m, desired);
    const refill = typeof a.k.clipLeft === 'number' && a.k.clipLeft > 0;
    let qty = refill ? (a.k.clipLeft as number) : floorStep(jitter(Number(s.displayQty), s.displayJitter, makeRng(a.seed + a.childCount)), m);
    qty = Math.max(qty, minQ);
    if (room - qty < minQ) qty = room;
    qty = floorStep(Math.min(qty, room), m);
    if (qty < minQ) return this.end(a, 'done', a.filled > 0 ? 'Filled (the rest is under SoDEX\'s minimum order).' : 'Under SoDEX\'s minimum order size.');
    delete a.k.clipLeft;
    if (!refill) a.k.clip = Number(a.k.clip ?? 0) + 1;
    await this.send(a, m, [{ side: s.side, price: desired, quantity: qty, tif, tag: `clip ${a.k.clip}` }]);
  }

  private async stepChase(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number, now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'chase' }>;
    const total = Number(s.quantity);
    const live = this.live(a);
    if (!live.length && this.isDone(a, m)) return this.end(a, 'done', 'Filled.');
    const timedOut = s.timeoutMs !== null && now - a.startedAt! >= s.timeoutMs;
    if (timedOut || a.k.rush || a.k.ending) {
      const how = a.k.rush ? 'take' : s.onEnd;
      a.k.ending = true;
      if (how === 'take') return this.work(a, m, q, mk, { due: total, late: total, total, exec: { style: 'taker', slippageBps: 50, offsetTicks: 0, chaseTicks: 1, makerShare: 0.5 }, tag: 'take the rest' });
      if (how === 'rest') {
        const c = live.find((x) => x.tif !== 'ioc');
        if (c) c.tag = 'left resting';
        return this.end(a, 'expired', c ? `Time is up: left resting at ${c.price} on SoDEX, as you chose.` : 'Time is up.', { keep: c ? [c.clOrdID] : [] });
      }
      return this.end(a, 'expired', `Time is up; ${dec(total - a.filled)} ${m.base} left unfilled.`);
    }
    // How far it may chase: from where it started, and never past the limit price.
    const startRef = typeof a.k.startRef === 'number' ? a.k.startRef : s.side === 'buy' ? q.bid : q.ask;
    let cap = s.limitPrice;
    if (s.maxChaseBps !== null) {
      const c = s.side === 'buy' ? startRef * (1 + s.maxChaseBps / 10_000) : startRef * (1 - s.maxChaseBps / 10_000);
      cap = cap === null ? c : s.side === 'buy' ? Math.min(cap, c) : Math.max(cap, c);
    }
    const price = makerPrice(s.side, q, s.offsetTicks, s.offsetBps, m, cap);
    const room = total - a.filled;
    if (live.length) {
      const c = live[0]!;
      if (c.state !== 'open' || c.cancelling) return;
      const off = Math.abs(c.price - price) / Number(m.tickSize);
      if (off >= s.chaseTicks - 1e-9 && now - c.placedAt >= s.minRepriceMs) await this.cancelChildren(a, m, [c]);
      return;
    }
    const qty = floorStep(room, m);
    if (qty < minChildQty(m, price)) return this.end(a, 'done', a.filled > 0 ? 'Filled.' : 'Under SoDEX\'s minimum order size.');
    await this.send(a, m, [{ side: s.side, price, quantity: qty, tif: 'gtx', tag: 'chase' }]);
  }

  private async stepScale(a: AlgoRecord, m: MarketInfo, _q: Quote, _now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'scale' }>;
    if (!a.k.placed) {
      const ladder = scaleLadder(s, m, a.seed).filter((l) => l.qty >= minChildQty(m, l.price));
      if (!ladder.length) return this.end(a, 'failed', 'No level of this ladder reaches SoDEX\'s minimum order.');
      a.k.placed = true;
      a.k.levels = ladder.length;
      const tif: ChildTif = s.postOnly ? 'gtx' : 'gtc';
      for (let i = 0; i < ladder.length; i += 50) {
        const chunk = ladder.slice(i, i + 50);
        await this.send(a, m, chunk.map((l, j) => ({ side: s.side, price: l.price, quantity: l.qty, tif, tag: `level ${i + j + 1}/${ladder.length}` })));
      }
      return;
    }
    if (this.live(a).length) return;
    const total = Number(s.quantity);
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
    const wave: number[] = [];
    if (next < clips.length) {
      while (wave.length < s.inFlight && next < clips.length && pool >= minQ) {
        let qty = Math.min(clips[next]!, pool);
        if (pool - qty < minQ) qty = pool;
        qty = floorStep(qty, m);
        next++;
        if (qty < minQ) continue;
        wave.push(qty);
        pool -= qty;
      }
      a.k.next = next;
    } else {
      // Every planned clip went out; what did not fill goes again, `retries` times.
      const left = Number(a.k.retriesLeft ?? 0);
      if (left <= 0 || pool < minQ) return this.end(a, 'expired', `${dec(pool)} ${m.base} did not fill after ${s.retries} retr${s.retries === 1 ? 'y' : 'ies'}.`);
      a.k.retriesLeft = left - 1;
      const avg = total / Math.max(1, clips.length);
      const n = Math.max(1, Math.min(s.inFlight, Math.round(pool / avg)));
      for (let i = 0; i < n && pool >= minQ; i++) {
        let qty = i === n - 1 ? pool : floorStep(pool / (n - i), m);
        if (pool - qty < minQ) qty = pool;
        qty = floorStep(qty, m);
        if (qty < minQ) break;
        wave.push(qty);
        pool -= qty;
      }
      await this.event(a, 'info', `Retrying ${dec(total - a.filled)} ${m.base} that did not fill.`);
    }
    if (!wave.length) return;
    a.k.waveAt = now + s.waveMs;
    a.k.wave = Number(a.k.wave ?? 0) + 1;
    await this.send(a, m, wave.map((qty) => ({ side: s.side, price, quantity: qty, tif: 'ioc' as ChildTif, tag: `wave ${a.k.wave}` })));
  }

  private async stepConditional(a: AlgoRecord, m: MarketInfo, q: Quote, mk: number, now: number): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'conditional' }>;
    if (a.k.fired) return this.afterFire(a, m, q, mk);
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
    a.k.fired = now;
    const t = s.then;
    await this.event(a, 'info', `Conditions held${s.holdMs ? ` for ${Math.round(s.holdMs / 1000)} s` : ''}: acting.`);
    if (t.type === 'market') a.k.takeQty = Number(t.quantity);
    else if (t.type === 'close') {
      const pos = await this.positionOf(a, s.symbol);
      if (!pos) return this.end(a, 'expired', `There was no position on ${s.symbol} to close.`);
      a.k.takeQty = floorStep(Math.abs(pos) * t.share, m);
      a.k.closeSide = pos > 0 ? 'sell' : 'buy';
    } else if (t.type === 'limit') {
      await this.send(a, m, [{ side: s.side, price: t.price, quantity: Number(t.quantity), tif: t.postOnly ? 'gtx' : 'gtc', tag: 'trigger', reduceOnly: s.reduceOnly }]);
      return this.end(a, 'done', `Placed a limit ${s.side} of ${t.quantity} at ${t.price}; it rests on SoDEX.`, { keep: a.children.filter((c) => LIVE.has(c.state)).map((c) => c.clOrdID) });
    } else {
      try {
        const child = await this.add({ owner: a.owner, accountId: a.accountId, mode: a.mode, spec: t.algo, parentId: a.id, consent: a.consent });
        return this.end(a, 'done', `Started a ${ALGO_NAMES[child.spec.kind]} on ${child.spec.symbol}.`);
      } catch (e) {
        return this.end(a, 'failed', `Could not start the ${ALGO_NAMES[t.algo.kind]}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.dirty.add(a.id);
    return this.afterFire(a, m, q, mk);
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
    if (a.k.fired) return this.afterFire(a, m, q, mk);
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
    if (s.quantity !== null) a.k.takeQty = Number(s.quantity);
    else {
      const pos = await this.positionOf(a, s.symbol);
      const right = pos !== null && (s.side === 'sell' ? pos > 0 : pos < 0);
      if (!right) return this.end(a, 'expired', `Fired at ${price}, but there was no ${s.side === 'sell' ? 'long' : 'short'} position on ${s.symbol} to close.`);
      a.k.takeQty = floorStep(Math.abs(pos!), m);
    }
    await this.event(a, 'info', `Fired: ${s.source} ${price} reached the stop at ${r.stop?.toFixed(6).replace(/\.?0+$/, '')}.`);
    return this.afterFire(a, m, q, mk);
  }

  /**
   * A basket: each market becomes an algo of its own (a swarm or a TWAP),
   * sized from its USD at the mark when it starts, all started together; the
   * basket ends when every leg has.
   */
  private async stepBasket(a: AlgoRecord): Promise<void> {
    const s = a.spec as Extract<AlgoSpec, { kind: 'basket' }>;
    if (!a.k.legs) {
      const specs: Array<Record<string, unknown>> = [];
      for (const l of s.legs) {
        const lm = this.markets.get(l.symbol);
        const lq = this.market.quote(l.symbol);
        const px = this.market.mark(l.symbol)?.mark ?? (lq ? mid(lq) : null);
        if (!lm || !px) return this.hold(a, `Waiting for a price of ${l.symbol}.`);
        const qty = floorStep(l.usd / px, lm);
        if (qty < minChildQty(lm, px)) return this.end(a, 'failed', `${l.symbol}: $${l.usd} is under SoDEX's minimum order.`);
        const common = { symbol: l.symbol, side: l.side, reduceOnly: s.reduceOnly, leverage: s.leverage, marginMode: s.marginMode, paper: s.paper, maxSpreadBps: s.maxSpreadBps, label: `${s.label ?? 'Basket'}: ${l.symbol}` };
        specs.push(
          s.style === 'swarm'
            ? { ...common, kind: 'swarm', quantity: dec(qty), clips: s.clips, inFlight: s.inFlight, waveMs: s.waveMs, sizeJitter: 0.2, slippageBps: s.slippageBps, retries: 2 }
            : { ...common, kind: 'twap', quantity: dec(qty), durationMs: s.durationMs, slices: s.slices, sizeJitter: 0.15, timeJitter: 0.2, exec: { style: 'taker', slippageBps: s.slippageBps }, finish: 'take' },
        );
      }
      const ids: string[] = [];
      for (const [i, spec] of specs.entries()) {
        const child = await this.add({ owner: a.owner, accountId: a.accountId, mode: a.mode, spec, parentId: a.id, consent: a.consent, seed: (a.seed + i + 1) >>> 0, country: a.country, observedCountry: a.observedCountry });
        ids.push(child.id);
      }
      a.k.legs = ids;
      this.dirty.add(a.id);
      await this.event(a, 'info', `Started ${ids.length} legs: ${s.legs.map((l) => `${l.side} $${l.usd} ${l.symbol}`).join(', ')}.`);
      return;
    }
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
      a.k.placed = true;
      await this.send(a, m, [{ side: s.side, price: s.price!, quantity: total, tif: 'gtc', tag: 'entry' }]);
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

  private async loadPositions(a: AlgoRecord): Promise<Record<string, { size: number; entry: number }> | null> {
    const prev = this.positionsOf.get(a.owner);
    this.positionsOf.set(a.owner, { at: prev?.at ?? 0, data: prev?.data ?? {}, loading: true });
    try {
      let data: Record<string, { size: number; entry: number }>;
      if (this.host.positions) data = await this.host.positions(a);
      else {
        const snap = await this.host.sodex.follower(a.owner);
        data = Object.fromEntries(Object.entries(snap.positions).map(([s, p]) => [s, { size: p.size, entry: p.entry }]));
      }
      this.positionsOf.set(a.owner, { at: Date.now(), data, loading: false });
      return data;
    } catch (e) {
      this.host.log.warn('algo: positions read failed', { owner: a.owner, error: String(e) });
      this.positionsOf.set(a.owner, { at: prev?.at ?? 0, data: prev?.data ?? {}, loading: false });
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

  /** Sign and send children (one batch on one market) and book them as live. */
  private async send(a: AlgoRecord, m: MarketInfo, list: Array<{ side: Side; price: number; quantity: number; tif: ChildTif; tag: string; reduceOnly?: boolean }>): Promise<void> {
    const s = a.spec;
    const sink = s.paper ? null : this.host.sinkFor(a);
    if (!s.paper && !sink) {
      await this.hold(a, 'The trading key for this algo is not available here.');
      return;
    }
    const opening = list.some((x) => !(x.reduceOnly ?? s.reduceOnly));
    // The region's leverage ceiling (EEA 2x): on the leverage set, and on the gross exposure an opening child may reach.
    const ceiling = !s.paper ? (this.host.policyFor?.(a)?.maxLeverage ?? null) : null;
    const leverage = ceiling !== null ? Math.min(s.leverage ?? ceiling, ceiling) : s.leverage;
    if (sink && opening && leverage !== null && !this.leverageSet.has(`${a.owner}|${m.name}`)) {
      this.leverageSet.add(`${a.owner}|${m.name}`);
      await sink.setLeverage(a, m, Math.min(leverage, m.maxLeverage), s.marginMode ?? 'cross').catch((e) => this.event(a, 'error', `Leverage not set: ${e instanceof Error ? e.message : String(e)}`));
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
          return;
        }
        list = [{ ...one, quantity: fit }];
      }
      // Counted at once, so the next child before the next read does not overshoot.
      const row = this.accounts.get(a.owner);
      if (row) row.gross += list.reduce((x, c) => x + (c.reduceOnly ?? s.reduceOnly ? 0 : c.quantity * c.price), 0);
    }
    const now = Date.now();
    const children: ChildOrder[] = [];
    const reqs: ChildRequest[] = [];
    for (const x of list) {
      const clOrdID = this.clOrdIdFor(a);
      const price = Number(dec(x.price));
      const quantity = Number(dec(x.quantity));
      const c: ChildOrder = { clOrdID, orderId: null, side: x.side, price, quantity, tif: x.tif, reduceOnly: x.reduceOnly ?? s.reduceOnly, filled: 0, value: 0, state: 'sending', placedAt: now, updatedAt: now, cancelling: false, tag: x.tag };
      children.push(c);
      reqs.push({ clOrdID, side: c.side, price: dec(price), quantity: dec(quantity), tif: c.tif, reduceOnly: c.reduceOnly });
      a.children.push(c);
      this.byClOrd.set(clOrdID, a.id);
    }
    this.trimChildren(a);
    this.dirty.add(a.id);
    // Logged before it leaves: a fill can come back on the socket before the request's own answer.
    for (const c of children) await this.event(a, 'order', `${c.tif === 'ioc' ? 'Take' : 'Rest'} ${c.side} ${c.quantity} @ ${c.price} (${c.tag}).`, c);
    let results: ChildResult[];
    if (s.paper) results = this.paperPlace(a, m, children);
    else results = await sink!.place(a, m, reqs);
    for (const c of children) {
      const r = results.find((x) => x.clOrdID === c.clOrdID) ?? { clOrdID: c.clOrdID, ok: false, orderId: null, error: 'no answer for this order', outcomeUnknown: true };
      c.updatedAt = Date.now();
      if (r.orderId) c.orderId = r.orderId;
      if (r.ok) {
        if (c.state === 'sending') c.state = 'open';
        a.k.consecRejects = 0;
      } else if (r.outcomeUnknown) {
        c.state = 'unknown';
        await this.event(a, 'error', `No answer from SoDEX for ${c.tag}; checking what happened (never re-sent).`, c);
      } else {
        c.state = 'done';
        a.rejects++;
        a.k.consecRejects = Number(a.k.consecRejects ?? 0) + 1;
        await this.event(a, 'error', `SoDEX refused ${c.tag}: ${r.error}`, c);
      }
    }
    if (Number(a.k.consecRejects ?? 0) >= MAX_CONSEC_REJECTS) await this.end(a, 'failed', `SoDEX refused ${MAX_CONSEC_REJECTS} orders in a row; stopped. The last reason is in the log.`);
    this.host.onChange?.(a.id);
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
    const resting = this.live(a).filter((c) => !keep.includes(c.clOrdID) && c.state === 'open' && !c.cancelling);
    if (resting.length) await this.cancelChildren(a, m, resting);
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
    this.applyFill(a, c, u.filledQty, u.filledValue, u.maker);
    // A fill that lands after the algo ended still gets its exits resized.
    if (a.filled > before && FINAL_STATUSES.has(a.status) && a.spec.exits) {
      const m = this.markets.get(a.spec.symbol);
      if (m) void this.syncExits(a, m, true);
    }
    if (u.orderId) c.orderId = u.orderId;
    c.updatedAt = Date.now();
    if (FINAL_ORDER.test(u.status)) {
      const was = c.state;
      c.state = 'done';
      c.cancelling = false;
      if (c.tif === 'ioc' && c.filled <= 1e-12) a.k.missAt = Date.now();
      if (u.status === 'REJECTED' && was !== 'done') {
        a.rejects++;
        a.k.consecRejects = Number(a.k.consecRejects ?? 0) + 1;
        void this.event(a, 'error', `SoDEX rejected ${c.tag}${u.reason ? `: ${u.reason}` : ''}.`, c);
      }
      this.onChildDone(a, c);
    } else if (c.state === 'sending' || c.state === 'unknown') c.state = 'open';
    // A resting child that turns up after its algo ended is cancelled (unless it was left on purpose).
    if (FINAL_STATUSES.has(a.status) && c.state === 'open' && c.tif !== 'ioc' && !c.cancelling && !((a.k.kept as string[] | undefined) ?? []).includes(c.clOrdID)) {
      const m = this.markets.get(a.spec.symbol);
      if (m) void this.cancelChildren(a, m, [c]);
    }
    this.dirty.add(a.id);
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
    const isMaker = maker ?? c.tif !== 'ioc';
    if (isMaker) a.makerQty += dq;
    const m = this.markets.get(a.spec.symbol);
    const rate = (isMaker ? (m?.makerFee ?? (m?.takerFee ?? 0.0004) / 2) : (m?.takerFee ?? 0.0004)) + (this.host.builderRate?.(a) ?? 0);
    a.fees += dv * rate;
    if (a.k.consecRejects) a.k.consecRejects = 0;
    void this.event(a, 'fill', `Filled ${dec(dq)} @ ${(dv / dq).toPrecision(8).replace(/\.?0+$/, '')}${isMaker ? ' (maker)' : ''}.`, { ...c, quantity: dq, price: dv / dq });
  }

  /* --------------------------------------------------------------- exits ----- */

  /**
   * Keep the exits in line with what the entry filled: a take-profit and/or a
   * stop-loss, SoDEX position stops sized to the filled amount at the levels
   * the spec names (a price, or a distance from the average fill). Resized at
   * most every EXITS_RESIZE_MS while the entry fills (cancel, then place), at
   * once when it ends (`final`). Nothing once one of them has filled.
   */
  private async syncExits(a: AlgoRecord, m: MarketInfo, final: boolean): Promise<void> {
    const s = a.spec;
    if (!s.exits || !opensPosition(s) || a.k.exitsDone || this.exitsBusy.has(a.id)) return;
    this.exitsBusy.add(a.id);
    try {
      a.exitOrders ??= [];
      const live = this.liveExits(a);
      if (live.some((x) => x.state !== 'open' || x.cancelling)) return;
      const size = floorStep(a.filled, m);
      if (size < Math.max(Number(m.stepSize), Number(m.minQuantity) || 0)) return;
      const covered = Number(a.k.exitsSize ?? 0);
      if (live.length && Math.abs(size - covered) < Number(m.stepSize) / 2) return;
      const now = Date.now();
      if (!final && live.length && now - Number(a.k.exitsAt ?? 0) < EXITS_RESIZE_MS) return;
      if (live.length) {
        await this.cancelExits(a, m, live);
        if (!final) return;
      }
      const lv = exitLevels(s.side, s.exits, a.filledValue / a.filled);
      const close: Side = s.side === 'buy' ? 'sell' : 'buy';
      const stops: StopRequest[] = [];
      const xs: ChildOrder[] = [];
      for (const kind of ['tp', 'sl'] as const) {
        const p = kind === 'tp' ? lv.tp : lv.sl;
        if (p === null || !(p > 0)) continue;
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
      this.dirty.add(a.id);
      await this.event(a, 'order', `Exits for ${dec(size)} ${m.base}: ${xs.map((x) => `${x.tag} at ${x.price}`).join(', ')} (${s.paper ? 'paper: watched against the mark' : 'SoDEX holds them'}; when one fills the other is cancelled).`);
      const sink = s.paper ? null : this.host.sinkFor(a);
      const results: ChildResult[] = s.paper
        ? stops.map((st) => ({ clOrdID: st.clOrdID, ok: true, orderId: `paper-${st.clOrdID}`, error: null, outcomeUnknown: false }))
        : sink
          ? await sink.placeStops(a, m, stops)
          : stops.map((st) => ({ clOrdID: st.clOrdID, ok: false, orderId: null, error: 'the trading key is not available here', outcomeUnknown: false }));
      for (const x of xs) {
        const r = results.find((y) => y.clOrdID === x.clOrdID);
        x.updatedAt = Date.now();
        if (r?.orderId) x.orderId = r.orderId;
        if (r?.ok) x.state = 'open';
        else if (r?.outcomeUnknown) x.state = 'unknown';
        else {
          x.state = 'done';
          await this.event(a, 'error', `SoDEX refused the ${x.tag}: ${r?.error ?? 'no answer'}`);
        }
      }
      const done = a.exitOrders.filter((x) => !LIVE.has(x.state));
      if (done.length > 12) a.exitOrders = a.exitOrders.filter((x) => LIVE.has(x.state) || done.slice(-12).includes(x));
      this.syncWatch();
      this.host.onChange?.(a.id);
    } finally {
      this.exitsBusy.delete(a.id);
    }
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
    if (!sink) return;
    try {
      await sink.cancel(a, m, open.map((x) => x.clOrdID));
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
    if (a.spec.kind === 'iceberg' && c.filled >= c.quantity - 1e-12) {
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
   * order history (drip-limited) only when an order is gone from them.
   */
  private async settleStale(a: AlgoRecord, m: MarketInfo, now: number): Promise<void> {
    if (a.spec.paper || this.lookupBusy) return;
    for (const c of a.children) if (c.state === 'sending' && now - c.placedAt > SENDING_MAX_MS) c.state = 'unknown';
    const stale = a.children.filter((c) => c.state === 'unknown' || (c.state === 'open' && ((c.tif === 'ioc' && now - c.updatedAt > STALE_IOC_MS) || (c.cancelling && now - c.updatedAt > STALE_IOC_MS))));
    if (!stale.length) return;
    this.lookupBusy = true;
    try {
      const open = await this.lookupOrders(a, m.name, false);
      const missing: ChildOrder[] = [];
      for (const c of stale) {
        const row = open.find((r) => r.clOrdID === c.clOrdID);
        if (row) {
          this.applyFill(a, c, row.executedQty, row.executedValue, null);
          c.state = 'open';
          c.orderId = row.orderId;
          c.updatedAt = now;
          if (c.cancelling) {
            c.cancelling = false;
            await this.cancelChildren(a, m, [c]);
          }
        } else missing.push(c);
      }
      if (missing.length && now - this.lastHistoryAt >= HISTORY_EVERY_MS) {
        this.lastHistoryAt = now;
        const hist = await this.lookupOrders(a, m.name, true);
        for (const c of missing) {
          const row = hist.find((r) => r.clOrdID === c.clOrdID);
          if (row) this.applyFill(a, c, row.executedQty, row.executedValue, null);
          if (row || now - c.placedAt > 120_000) {
            if (!row) await this.event(a, 'info', `SoDEX does not list ${c.tag}; counted as filled ${dec(c.filled)}.`, c);
            c.state = 'done';
            c.cancelling = false;
            this.onChildDone(a, c);
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
      problem = hit?.problem ?? null;
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

  private async setStatus(a: AlgoRecord, status: AlgoStatus, reason: string | null): Promise<void> {
    if (a.status === status && a.statusReason === reason) return;
    const changed = a.status !== status;
    a.status = status;
    a.statusReason = reason;
    a.updatedAt = Date.now();
    await this.save(a);
    if (changed && status !== 'running') await this.event(a, 'status', reason ?? status);
    else if (reason && changed) await this.event(a, 'status', reason);
    this.host.onChange?.(a.id);
  }

  private async hold(a: AlgoRecord, reason: string): Promise<void> {
    this.heldNow.add(a.id);
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
