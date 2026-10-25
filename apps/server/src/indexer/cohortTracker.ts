/**
 * Cohorts in the index: who is in each cohort, what they hold, how that moves.
 *
 * THE EFFICIENT PART: A WALLET IS READ ONCE. Its positions only change when it
 * trades - liquidations and deleveraging are trades too - and the live streams
 * this indexer already runs carry every trade with BOTH parties (Hyperliquid
 * with its xyz dex, SoDEX, Arcus). So after one snapshot (cohortSource.ts) a
 * wallet's book is moved by its own prints: size, and a size-weighted entry
 * for the unrealised PnL. Prices are the streams' last prints. Ongoing cost is
 * the reads of wallets never seen before, plus a slow reconciliation:
 *
 *   - after any stream outage, every account of $100K+ on that venue is read
 *     again (anything it did during the gap is unknown);
 *   - otherwise every book is re-read after 6 h ($1M+), 24 h ($100K+) or 7 days,
 *     which bounds drift from anything a print cannot show (funding does not
 *     change size; transfers do not touch positions).
 * Lighter's stream names sub-accounts, so a Lighter book follows prints once
 * the wallet's indices are known (its first read learns them); until then,
 * and whenever that stream is down, books are re-read on a size schedule
 * (30 min for $5M+ ... 2 days for small). Below TAIL_EQUITY only a fixed 10%
 * sample of its ~100k accounts is read at all (each standing for ten; see
 * model.ts sampleRule).
 *
 * PERP EQUITY (model.ts perpEquity) sizes the cohorts, so two more reads:
 *   - a book whose read equity cannot carry what it now holds (read while the
 *     wallet was empty or small, funded and opened since) is read again:
 *     after 30 min at an equity of 0, after 6 h above 60x leverage;
 *   - a Hyperliquid read that finds positions while the leaderboard puts the
 *     account well above its perps value also reads the spot state (weight
 *     2): a unified account keeps its perps collateral there. Books read
 *     before this existed are read again once, largest first (needsSpot).
 *
 * PNL. A PnL cohort needs a wallet's all-time PnL. Hyperliquid's leaderboard file
 * ranks ~47k accounts; the books hold positions for several times that. Every
 * other Hyperliquid holder's PnL - trade.xyz's included, the same accounts
 * (accountPnl) - is read from its portfolio (weight 20), largest
 * first, with a guaranteed share of the cohort lane's spend (PNL_SHARE), and read
 * again daily ($1M+), every 3 days ($100K+) or weekly (planPnl, cohort_pnl).
 * Before this (2026-10-24) the PnL cohorts held some 10k wallets against the
 * size cohorts' 51k.
 *
 * MEMBERS. Every wallet the index can value: Hyperliquid's leaderboard file
 * (equity + all-time PnL), SoDEX's and Lighter's lists, Arcus portfolios,
 * trade.xyz traders the stream saw, and any wallet a read has valued.
 * Written to `cohort_member` for the API thread, which nets and filters on
 * request (indexer/read.ts); this worker only records the history:
 * `cohort_series` every 15 minutes, `cohort_mix` (per coin and sector) hourly -
 * and rebuilds the hours it missed while it was down, from Hyperliquid's funding
 * history (cohortRebuild.ts, planRebuild), in a lane the boards lend 200 weight
 * a minute to while it reads.
 */
import { VENUES, type Venue } from '../valuescan/types.js';
import type { LbSnapshot } from '../valuescan/hyperliquid/leaderboard.js';
import type { Pacer } from '../valuescan/extra/http.js';
import {
  Aggregator, COHORTS, MARGIN_SIBLING, TAIL_EQUITY, coinOf, netWallet, perpEquity, sampleRule, sampledVenue, scopeKey, sectorTotals,
  type CohortRange, type Position, type WalletVenue,
} from '../valuescan/cohorts/model.js';
import { Lane } from './lanes.js';
import { WeightBudget } from '../valuescan/hyperliquid/info.js';
import { mark } from './busy.js';
import type { Print } from './streams.js';
import type { IndexStore } from './store.js';
import { DAY_MS, dayOf } from './windows.js';
import {
  PNL_READ_COST, READ_COST, arcusPositions, hlEquityHistory, hlFundingRows, hlHourlyPrices, hlPortfolioPnl, hlPositions,
  lighterPositions, sodexPositions, type PositionRead,
} from './cohortSource.js';
import {
  HOUR_MS, REBUILD_WINDOW_MS, REBUILT_VENUES, checkEdges, histOf, missingSpans, needsEquityHistory, peakNotional, priceAt,
  readRange, rebuildHour, rebuildSample, resumedAfterOutage, sizeProxy, venueOfSymbol,
  type Bridge, type RebuildCheck, type RebuildWallet, type Span, type WalletHist,
} from './cohortRebuild.js';
import type { BookPosition, CohortPnlRow } from './store.js';
import { accountLiqs, addDrift, calibrate, emptyDrift, fillCash, type DriftStats, type Tiers } from '../valuescan/liquidations/math.js';
import { marketsNow, setRulesPacers, venueMarkets } from '../valuescan/liquidations/rules.js';
import { liqCoin, snapOfNow } from '../valuescan/liquidations/levels.js';
import { LiqLive } from '../valuescan/liquidations/live.js';
import { LiqFeedServer } from './liqFeed.js';
import { deflateRawSync } from 'node:zlib';

const envNum = (name: string, dflt: number, min: number, max: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : dflt;
};

const PLAN_MS = 60_000;
const FLUSH_MS = 10_000;
export const SERIES_STEP_MS = 15 * 60_000;
export const MIX_STEP_MS = 60 * 60_000;
const SERIES_KEEP_MS = 35 * DAY_MS;
/** Queued reads per venue at a time: the plan tops the queue up every minute. */
const QUEUE_CAP = 400;
/** Coins kept per cohort in the hourly mix. */
const MIX_COINS = 120;

/** Every coin's liquidation levels (liq_now) this often; a snapshot (liq_hist) every LIQ_STEP_MS, for SoDEX's perps and this many more coins. */
/** Every 2 minutes: a pass over ~90k books took 14-26 s of a disk-bound loop (2026-10-25); the edge serves the row in between. */
/** The liquidation backlog takes the reads above this many books (updateLiqBoost)... */
export const LIQ_BOOST_MIN = 300;
/** ...with the boards lane's loan to the history rebuild, and the PnL reads' share cut to this. */
const LIQ_BOOST_LEND = 200;
const LIQ_BOOST_PNL_SHARE = 0.1;
/** The live engine's beat, and how many changed accounts one beat prices at most (a start primes ~90k books in ~20 beats). */
const LIVE_TICK_MS = 1_000;
const LIVE_SLICE = 5_000;
export const LIQ_NOW_MS = 2 * 60_000;
export const LIQ_STEP_MS = 15 * 60_000;
const LIQ_COINS = 30;
/** Kept 30 days; past 3 days only the hourly ones. */
const LIQ_KEEP_MS = 30 * DAY_MS;
const LIQ_THIN_MS = 3 * DAY_MS;
/** Where the liquidation math's accuracy is kept for the API (DriftStats per venue). */
export const LIQ_ACC_META = 'liq_acc';
const LIQ_PRICE_ORDER: readonly Venue[] = ['hyperliquid', 'tradexyz', 'lighter', 'sodex', 'arcus'];

/** Venues whose trades the indexer streams (their books follow the prints). */
const STREAMED: ReadonlySet<Venue> = new Set(['hyperliquid', 'tradexyz', 'sodex', 'arcus', 'lighter']);
/** Window PnL no older than this stands for the range (older is "not known", never all-time). */
const RANGE_MAX_AGE: Record<CohortRange, number> = { '1d': 6 * 60 * 60_000, '7d': 24 * 60 * 60_000, '30d': 48 * 60 * 60_000 };
/** Hand the loop back after this much synchronous work in a long pass. */
const SLICE_MS = 30;

/** Share of wallets under TAIL_EQUITY that are read (the rest are counted, not read). */
export const TAIL_RATE: Record<Venue, number> = { hyperliquid: 1, tradexyz: 1, sodex: 1, arcus: 1, lighter: 0.1 };

/**
 * After a stream outage, books from this equity up are read again: $1M+ after
 * a short outage (a restart: seconds of missed prints), $100K+ after a long
 * one. Re-reading every $100K+ Hyperliquid book after each restart took the
 * cohort lane ~3.5 h (13k reads) before any new wallet was read.
 */
export function gapRereadFloor(downMs: number): number {
  return downMs <= SHORT_OUTAGE_MS ? 1_000_000 : 100_000;
}
const SHORT_OUTAGE_MS = 2 * 60_000;

/**
 * A streamed book: re-read to reconcile after this long. Every SoDEX book daily:
 * they are few (~11k, 20 reads a minute is the lane) and its stream misses prints
 * (2026-10-25: 2 of 8 random holders off after a day or more, one flipped side).
 */
export function reconcileTtl(equity: number, venue?: Venue): number {
  if (equity >= 1_000_000) return 6 * 60 * 60_000;
  if (equity >= 100_000 || venue === 'sodex') return 24 * 60 * 60_000;
  return 7 * DAY_MS;
}

/** No venue here lends more than 50x: a book above this against its read equity was read before it was funded. */
export const MAX_LEVERAGE = 60;
const STALE_EMPTY_MS = 30 * 60_000;
const STALE_LEVERAGE_MS = 6 * 60 * 60_000;

/**
 * A book whose read equity cannot carry the positions it holds now: the read
 * found the wallet empty or small, and prints opened positions since (a
 * deposit moves no print). Waits a while after a read, so a book that really
 * is that thin is not read in a loop.
 */
export function staleEquity(book: Pick<Book, 'equity' | 'collateral' | 'at'>, notional: number, now: number): boolean {
  if (!(notional > 0)) return false;
  const eq = book.collateral ?? book.equity ?? 0;
  const age = now - book.at;
  if (!(eq > 0)) return age >= (book.collateral == null ? STALE_EMPTY_MS : STALE_LEVERAGE_MS);
  return notional > MAX_LEVERAGE * eq && age >= STALE_LEVERAGE_MS;
}

/**
 * A Hyperliquid read with positions also reads the spot state when the
 * leaderboard's account value (perps + spot + staked) is well above the perps
 * account value: the gap may be a unified account's collateral. Off the
 * leaderboard the two are the same figure, and nothing is read.
 */
export function needsSpot(total: number | null | undefined, perpsValue: number | null, positions: number): boolean {
  if (!positions || total == null || !(total > 0)) return false;
  return total - Math.max(0, perpsValue ?? 0) > Math.max(1_000, 0.1 * total);
}

/** From here a unified account's spot is valued token by token (cohortSource.ts spotCollateral); before, stablecoins only. */
export const SPOT_VALUE_SINCE = Date.UTC(2026, 9, 25);

/**
 * A Hyperliquid book whose spot state should be read: never looked at while the
 * leaderboard says the account holds more than its perps (needsSpot), or a
 * unified account's spot valued by the rule before SPOT_VALUE_SINCE (once).
 */
export function spotDue(book: { spotAt?: number | null; collateral?: number | null; equity: number | null; pos: { size: number } }, total: number | null | undefined): boolean {
  if (book.spotAt == null) return needsSpot(total, book.equity, book.pos.size);
  return book.collateral != null && book.spotAt < SPOT_VALUE_SINCE && book.pos.size > 0;
}

/** A book no stream moves: re-read after this long. */
export function pollTtl(equity: number): number {
  if (equity >= 5_000_000) return 30 * 60_000;
  if (equity >= 1_000_000) return 60 * 60_000;
  if (equity >= 100_000) return 3 * 60 * 60_000;
  if (equity >= 10_000) return 12 * 60 * 60_000;
  return 48 * 60 * 60_000;
}

/**
 * Where a book without liquidation data queues for its read: by what it adds to
 * the heatmap - its notional times its leverage (capped at 25x), so a large
 * leveraged book first, a large unleveraged one (whose longs never liquidate) and
 * a tiny one late. Above the stale and gap re-reads, below a new wallet the stream
 * saw trade. History: largest-first (by equity) took the big low-leverage books
 * first, and the buckets next to the price stayed thin; leverage-first (v0.2.24)
 * then read thousands of tiny books that hardly move the map - 2026-10-25 15:15,
 * 51k of 55k Hyperliquid books holding positions still unpriced, though they held
 * under half the size.
 */
export function liqBacklogPrio(notional: number, equity: number | null): number {
  const lev = equity && equity > 0 ? Math.min(25, notional / equity) : 25;
  return 1100 + Math.min(500, Math.max(0, Math.round(Math.log10(Math.max(1, notional * lev)) * 60)));
}

/** Whether a book carries liquidation data (a calibrated read): a cross cash, or an isolated / kept figure. */
export function liqKnown(b: Pick<Book, 'cash' | 'pos'>): boolean {
  if (b.cash != null) return true;
  for (const p of b.pos.values()) if (p.iso !== undefined || p.fix != null) return true;
  return false;
}

/** Every non-empty set of venues, as scopes. */
export function allScopes(venues: readonly Venue[] = VENUES): Venue[][] {
  const out: Venue[][] = [];
  for (let m = 1; m < 1 << venues.length; m++) out.push(venues.filter((_, i) => m & (1 << i)));
  return out;
}

export interface Book {
  /** The read's perps account value (that dex's own on Hyperliquid / trade.xyz). */
  equity: number | null;
  /** Size and entry, and the liquidation extras (liquidations/math.ts LiqPos: iso, lev, fix). */
  pos: Map<string, { szi: number; entry: number | null; iso?: number | null; lev?: number | null; fix?: number | null }>;
  /** The account's cross cash for its liquidation prices (liquidations/math.ts calibrate); null = not known. */
  cash?: number | null;
  /** A read that could not be priced (the venue's margin rules were not loaded yet): read again soon. */
  liqMiss?: boolean;
  /** When the snapshot was read. */
  at: number;
  /** Hyperliquid: a unified account's stablecoin collateral (model.ts perpEquity), when the read looked. */
  collateral?: number | null;
  /** Hyperliquid: when the read looked at the spot state. */
  spotAt?: number | null;
}

/**
 * One print applied to a book: `d` is the signed size change. Adding to a
 * position averages the entry in; reducing keeps it; flipping starts it again
 * at the print's price.
 */
export function applyFill(book: Book, symbol: string, d: number, px: number): void {
  fillCash(book, symbol, d, px);
  const cur = book.pos.get(symbol) ?? { szi: 0, entry: null };
  const s = cur.szi;
  const n = s + d;
  if (Math.abs(n) < 1e-12 * Math.max(1, Math.abs(s))) {
    book.pos.delete(symbol);
    return;
  }
  let entry = cur.entry;
  if (s === 0 || Math.sign(s) === Math.sign(d)) {
    entry = s === 0 || entry === null ? px : (Math.abs(s) * entry + Math.abs(d) * px) / Math.abs(n);
  } else if (Math.sign(n) !== Math.sign(s)) {
    entry = px;
  }
  book.pos.set(symbol, { ...cur, szi: n, entry });
}

/** Which prints move which venue's books: spot never, and a HIP-3 market only its own dex's book. */
function bookable(venue: Venue, symbol: string): boolean {
  if (symbol.includes('/') || symbol.startsWith('@')) return false;
  if (venue === 'hyperliquid') return !symbol.includes(':');
  if (venue === 'tradexyz') return symbol.startsWith('xyz:');
  return true;
}

interface Member {
  pnl: number | null;
  equity: number | null;
  label: string | null;
  pnlRange?: Partial<Record<CohortRange, number | null>>;
}

export interface CohortDeps {
  store: IndexStore;
  now: () => number;
  hlSnapshot: () => Promise<LbSnapshot | null>;
  streamSince: (v: Venue) => number | null;
  /** Lighter's and Arcus's index lanes and pacers (their budgets are shared with the rankings). */
  lighter: { lane: Lane; pacer: Pacer; learn?: (address: string, indices: number[]) => void; known?: (address: string) => boolean };
  /** Whether the venue's stream runs right now (its books follow prints; a Lighter stream can be down while others run). */
  socketUp?: (v: Venue) => boolean;
  arcus: { lane: Lane; pacer: Pacer };
  /** SoDEX's shared gateway gate (cooldowns, busy budget). */
  sodexGate: () => number;
  /** Lend this much of the Hyperliquid boards lane's weight a minute to the history rebuild (0 = give it back). */
  lendHl?: (weight: number) => void;
}

/** History rebuild reads (cohortRebuild.ts), weight / minute: lent by the boards lane while a rebuild has reads to do. */
export const REBUILD_PER_MIN = 200;
/** Rebuild reads queued at a time (the plan tops them up every minute). */
const REBUILD_QUEUE = 120;

interface RebuildState {
  span: Span;
  /** The wallets to read and how many each stands for (cohortRebuild.ts rebuildSample). */
  plan: Map<string, number>;
  read: Set<string>;
  phase: 'reads' | 'prices' | 'writing';
  /** Symbols the reads hold, and those whose prices are read. */
  symbols: Set<string>;
  priced: Set<string>;
  startedAt: number;
  check: RebuildCheck | null;
  lastError: string | null;
  /** Failed reads per wallet: after REBUILD_TRIES the wallet is left out (counted in `skipped`). */
  fails: Map<string, number>;
  skipped: number;
}
const REBUILD_TRIES = 3;

/** Portfolio reads queued at a time (the plan tops them up every minute). */
const PNL_QUEUE_CAP = 60;
/** A holder's portfolio PnL is read again after this long: often for the large, weekly for the rest. */
export function pnlTtl(equity: number): number {
  return equity >= 1_000_000 ? DAY_MS : equity >= 100_000 ? 3 * DAY_MS : 7 * DAY_MS;
}
/**
 * Where a portfolio read queues among the position reads, on their scale (size =
 * log10(equity) x 100; new 1,000 + size, stale 950 + size, gap and spot 900 +
 * size, reconcile 400 + size): a $100K+ holder's just under a stale book of its
 * size - it moves the money in the PnL cohorts - and the rest of the tail after
 * every position read. (Until 2026-10-25 the size here was x10: a $100K+
 * holder's read sat below every gap re-read and most reconciles.)
 */
export function pnlPrio(equity: number): number {
  const size = Math.round(Math.log10(Math.max(1, equity)) * 100);
  return equity >= 100_000 ? 940 + size : 300 + Math.round(size / 10);
}
/**
 * The share of the cohort lane's spend portfolio reads are guaranteed while any
 * wait: a portfolio read is 20 weight against a position read's 2, so 40% is one
 * for every 15 position reads - at the lane's 400, 8 a minute, 11k a day.
 * Without it they waited behind a queue the plan refills every minute: two
 * written in the first 70 minutes after v0.2.13.
 */
export const PNL_SHARE = 0.4;
/**
 * Cohort reads in flight at once (lanes.ts CONCURRENCY). One at a time made ~20
 * a minute; 8 made ~46 (v0.2.16, 2026-10-24), still bound by the event loop's
 * stalls on the disk rather than by the 400 weight - a read waits out a stall
 * whatever else is in flight. The spend cap is the lane's either way.
 */
export const HLC_CONCURRENCY = 24;

export class CohortTracker {
  /**
   * Hyperliquid + its xyz dex: clearinghouseState reads (2) and, for a holder the
   * leaderboard does not rank, portfolio reads (20), weight / minute. 400 by
   * default (raised from 200 on 2026-10-24 for the portfolio reads): with the
   * boards' 500 and the API's 200 that is 1,100 of HL's 1,200 per IP.
   */
  readonly hlc = new Lane({
    name: 'hlc',
    perMin: envNum('VALUESCAN_INDEX_HL_COHORT', 400, 20, 800),
    concurrency: HLC_CONCURRENCY,
    shares: [{ prefix: 'cohpnl:', share: PNL_SHARE }],
  });
  /** History rebuild reads, weight / minute (lent by the boards lane while it reads). */
  private readonly rebuildRate = envNum('VALUESCAN_INDEX_HL_REBUILD', REBUILD_PER_MIN, 20, 400);
  /**
   * History rebuild reads (userFunding, candles): a lane of its own, so a rebuild
   * never slows the books or the PnL reads. It does not rest by itself: every
   * request takes its weight from `histPace` first (cohortSource.ts HistPace), so
   * a wallet of many pages spends at the rebuild's rate, not in one burst.
   */
  readonly hlh = new Lane({ name: 'hlh', perMin: 1e9, concurrency: 4 });
  private readonly histPace = new WeightBudget(this.rebuildRate, 40);
  private rebuild: RebuildState | null = null;
  /** The lanes' own rates, to come back to after the liquidation backlog (updateLiqBoost). */
  private readonly hlcBase = this.hlc.perMin;
  private readonly hlhBase = this.hlh.perMin;
  /** Books per venue waiting for liquidation data at the last plan, and whether the backlog has the reads. */
  private liqDue = new Map<Venue, number>();
  private liqBoost = false;
  /** coin -> its reference price and the venue rank it came from (LIQ_PRICE_ORDER: Hyperliquid's first). */
  private coinPx = new Map<string, { px: number; rank: number }>();
  /**
   * The live liquidation levels (valuescan/liquidations/live.ts): every account
   * priced into its coins' buckets, re-priced when a print or a read moves its
   * book or another of its prices moves; flushed to the API every second (liqFeed.ts).
   */
  readonly live = new LiqLive({
    account: (venue, address) => {
      const b = this.books.get(venue)?.get(address);
      return b ? { cash: b.cash ?? null, priced: liqKnown(b), positions: [...b.pos].map(([symbol, p]) => ({ symbol, ...p })) } : undefined;
    },
    priceOf: (venue, symbol) => this.marks.get(`${venue}|${symbol}`) ?? null,
    tiersOf: (venue, symbol) => marketsNow(venue)?.tiers.get(symbol) ?? null,
    priceOfCoin: (coin) => this.coinPx.get(coin)?.px ?? null,
  });
  private feed = new LiqFeedServer(() => this.live.resendAll());
  /** Every book priced into the engine once since the start. */
  private liveReady = false;
  private liveMs = 0;
  private liveWholeAt = 0;
  /** What the boards lane lends the rebuild now. */
  private lent = 0;
  /** SoDEX perps state reads, requests / minute (weight 5 each). */
  readonly scoh: Lane;
  private books = new Map<Venue, Map<string, Book>>();
  private marks = new Map<string, number>();
  private dirtyBooks = new Set<string>();
  private dirtyMarks = new Set<string>();
  private members = new Map<Venue, Map<string, Member>>();
  private memberSig = new Map<string, string>();
  /** Wallets a stream saw trade that have no book yet. */
  private wanted = new Map<string, number>();
  /** Hyperliquid holders' PnL from their portfolio (cohort_pnl), loaded at the first plan. */
  private pnlRead: Map<string, CohortPnlRow & { at: number }> | null = null;
  private span = new Map<Venue, number | null>();
  private gapAt = new Map<Venue, number>();
  /** Per venue, the equity from which books are re-read after its last outage. */
  private gapFloor = new Map<Venue, number>();
  /** When the recording resumed after its last outage (cohortRebuild.ts resumedAfterOutage): streamed books read before are re-read. */
  private staleBefore = 0;
  private timers: NodeJS.Timeout[] = [];
  private lastSeriesT = 0;
  private lastMixT = 0;
  private recording = false;
  private applied = 0;
  /** The liquidation math against the venues' figures, per venue (liquidations/math.ts DriftStats): this day's and the last. */
  private liqAcc = new Map<Venue, { cur: DriftStats; prev: DriftStats | null }>();
  private liqAccDirty = false;
  private lastLiqT = 0;
  private liqRecording = false;
  private lastNowAt = 0;
  /** How long the last liquidation pass took (status). */
  private liqMs = 0;
  /** When this tracker started (books read before it without liquidation data are read once more). */
  private startedAt = 0;
  private planMs = 0;
  private recordMs = 0;
  lastError: string | null = null;

  constructor(private readonly d: CohortDeps) {
    setRulesPacers({ lighter: d.lighter.pacer, arcus: d.arcus.pacer });
    this.scoh = new Lane({ name: 'scoh', perMin: envNum('VALUESCAN_INDEX_SODEX_COHORT', 20, 1, 60), gate: d.sodexGate, rateLimitPauseMs: 15 * 60_000 });
  }

  start(): void {
    const s = this.d.store;
    const now = this.d.now();
    this.startedAt = now;
    for (const v of VENUES) {
      const m = new Map<string, Book>();
      for (const [a, b] of s.cohortBooks(v)) {
        m.set(a, {
          equity: b.equity, at: b.at, collateral: b.collateral, spotAt: b.spotAt, cash: b.cash,
          pos: new Map(b.positions.map(({ symbol, ...p }) => [symbol, p])),
        });
      }
      this.books.set(v, m);
      // Whatever traded while the indexer was down is unknown: large books are re-read.
      if (STREAMED.has(v)) {
        this.gapAt.set(v, now);
        // How long the stream was down across this restart (the engine keeps `stream_up`).
        const lastUp = Number(s.getMeta(`stream_up:${v}`)) || 0;
        this.gapFloor.set(v, gapRereadFloor(lastUp > 0 ? now - lastUp : Number.POSITIVE_INFINITY));
      }
    }
    for (const [k, px] of s.cohortMarks()) { this.marks.set(k, px); this.noteCoinPx(k, px); }
    this.lastSeriesT = s.cohortSeriesLastT();
    this.lastMixT = s.cohortMixLastT();
    this.lastLiqT = s.liqHistLastT();
    for (const v of VENUES) void venueMarkets(v).catch(() => null);
    try {
      const saved = JSON.parse(s.getMeta(LIQ_ACC_META) ?? '{}') as Record<string, { cur: DriftStats; prev: DriftStats | null }>;
      for (const v of VENUES) if (saved[v]?.cur) this.liqAcc.set(v, saved[v]!);
    } catch { /* starts afresh */ }
    this.hlc.start();
    this.hlh.start();
    this.scoh.start();
    const every = (ms: number, fn: () => Promise<void> | void, name: string) => {
      const t = setInterval(() => { mark(name); void Promise.resolve(fn()).catch((e) => (this.lastError = String(e))); }, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(PLAN_MS, () => this.plan(), 'coh:plan');
    every(FLUSH_MS, () => this.flush(), 'coh:flush');
    every(60_000, () => this.record(), 'coh:record');
    every(60_000, () => this.recordLiq(), 'coh:liq');
    // The live engine: every book in at the start (priced a few thousand a second), then what changes.
    for (const v of VENUES) for (const [a, b] of this.books.get(v) ?? []) if (b.pos.size) this.live.touch(v, a);
    this.feed.start();
    every(LIVE_TICK_MS, () => this.liveTick(), 'coh:live');
    const first = setTimeout(() => void this.plan().catch((e) => (this.lastError = String(e))), 15_000);
    first.unref?.();
    this.timers.push(first);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.hlc.stop();
    this.hlh.stop();
    this.lend(0);
    this.scoh.stop();
    this.feed.stop();
    this.flush();
  }

  // --- the streams ----------------------------------------------------------------------

  /** Every print: a price, and each party's book moved (or queued for its first read). */
  onPrint(p: Print, addressOf: (acct: string) => string | null): void {
    if (!bookable(p.venue, p.symbol)) return;
    const mk = `${p.venue}|${p.symbol}`;
    this.marks.set(mk, p.px);
    this.noteCoinPx(mk, p.px);
    this.live.mark(p.venue, p.symbol, p.px);
    this.dirtyMarks.add(mk);
    const books = this.books.get(p.venue);
    if (!books) return;
    for (const [acct, d] of [[p.buyer, p.sz], [p.seller, -p.sz]] as const) {
      const address = addressOf(acct);
      if (!address) continue;
      const book = books.get(address);
      if (!book) {
        const k = `${p.venue}|${address}`;
        if (!this.wanted.has(k)) this.wanted.set(k, this.d.now());
        continue;
      }
      applyFill(book, p.symbol, d, p.px);
      this.live.touch(p.venue, address);
      this.dirtyBooks.add(`${p.venue}|${address}`);
      this.applied++;
    }
    if (this.wanted.size > 100_000) this.wanted.clear();
  }

  status(): Record<string, unknown> {
    return {
      members: Object.fromEntries(VENUES.map((v) => [v, this.members.get(v)?.size ?? 0])),
      books: Object.fromEntries(VENUES.map((v) => [v, this.books.get(v)?.size ?? 0])),
      waiting: this.wanted.size,
      printsApplied: this.applied,
      planMs: this.planMs,
      recordMs: this.recordMs,
      liqMs: this.liqMs,
      liq: { boost: this.liqBoost, due: Object.fromEntries(this.liqDue), live: { ready: this.liveReady, pending: this.live.pending, ms: this.liveMs, readers: this.feed.readers, error: this.feed.lastError } },
      hlc: { queued: this.hlc.size, done: this.hlc.done, failed: this.hlc.failed, lastError: this.hlc.lastError },
      scoh: { queued: this.scoh.size, done: this.scoh.done, failed: this.scoh.failed, lastError: this.scoh.lastError },
      hlh: { queued: this.hlh.size, done: this.hlh.done, failed: this.hlh.failed, lastError: this.hlh.lastError, lent: this.lent },
      staleBefore: this.staleBefore,
      rebuild: this.rebuild
        ? {
          span: this.rebuild.span, phase: this.rebuild.phase, planned: this.rebuild.plan.size, read: this.rebuild.read.size,
          symbols: this.rebuild.symbols.size, priced: this.rebuild.priced.size, startedAt: this.rebuild.startedAt,
          skipped: this.rebuild.skipped, lastError: this.rebuild.lastError,
        }
        : null,
      lastSeriesT: this.lastSeriesT,
      lastMixT: this.lastMixT,
      lastError: this.lastError,
    };
  }

  // --- members ------------------------------------------------------------------------

  private async membersOf(venue: Venue): Promise<Map<string, Member>> {
    const s = this.d.store;
    const out = new Map<string, Member>();
    const put = (a: string, m: Partial<Member>) => {
      const cur = out.get(a) ?? { pnl: null, equity: null, label: null };
      if (m.pnl != null) cur.pnl = m.pnl;
      if (m.equity != null) cur.equity = m.equity;
      if (m.label != null) cur.label = m.label;
      if (m.pnlRange) cur.pnlRange = m.pnlRange;
      out.set(a, cur);
    };
    const num = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? null : v);
    if (venue === 'hyperliquid') {
      const snap = await this.d.hlSnapshot();
      if (snap) {
        const { addresses, accountValue, cols, labels } = snap.data;
        const pnl = cols['pnl:all'];
        const d1 = cols['pnl:1d'];
        const d7 = cols['pnl:7d'];
        const d30 = cols['pnl:30d'];
        for (let i = 0; i < addresses.length; i++) {
          const p = pnl[i]!;
          const av = accountValue[i]!;
          put(addresses[i]!, {
            pnl: Number.isNaN(p) ? null : p, equity: Number.isNaN(av) ? null : av, label: labels[i] ?? null,
            pnlRange: { '1d': num(d1?.[i]), '7d': num(d7?.[i]), '30d': num(d30?.[i]) },
          });
        }
      }
    } else {
      for (const [a, p] of s.pnlAll(venue)) put(a, { pnl: p });
      for (const [a, v] of s.accountValues(venue)) put(a, { equity: v });
      if (venue === 'tradexyz' || venue === 'arcus') {
        for (const a of s.activeAccounts(venue, { day: dayOf(this.d.now() - 30 * DAY_MS) }, 1, 50_000)) put(a.acct, {});
      }
      // Each range's PnL where the venue's lists (or the index) have a fresh one.
      const now = this.d.now();
      for (const r of ['1d', '7d', '30d'] as const) {
        for (const [a, p] of s.pnlWindow(venue, r, now - RANGE_MAX_AGE[r])) {
          const cur = out.get(a);
          if (!cur) continue;
          cur.pnlRange = { ...cur.pnlRange, [r]: p };
        }
      }
    }
    // A read values the wallet too (and on a venue with a stream, is the fresher figure).
    for (const [a, b] of this.books.get(venue) ?? []) {
      if (venue === 'hyperliquid' && out.get(a)?.equity != null) continue;
      put(a, { equity: b.equity });
    }
    // A holder the leaderboard does not rank: its PnL as its portfolio last read it,
    // so it sits in a PnL cohort as it does in a size cohort.
    if (venue === 'hyperliquid') {
      for (const [a, r] of this.pnls()) {
        const cur = out.get(a);
        if (!cur || cur.pnl != null || r.pnl == null) continue;
        cur.pnl = r.pnl;
        cur.pnlRange = { '1d': r.pnl1d, '7d': r.pnl7d, '30d': r.pnl30d };
      }
    }
    return out;
  }

  private pnls(): Map<string, CohortPnlRow & { at: number }> {
    if (!this.pnlRead) this.pnlRead = this.d.store.cohortPnl('hyperliquid');
    return this.pnlRead;
  }

  /**
   * Portfolio reads for Hyperliquid holders the leaderboard does not rank (its
   * file has ~47k accounts; the books hold positions for far more): without an
   * all-time PnL a holder is in a size cohort but in no PnL cohort. Largest
   * first; each read again after pnlTtl.
   */
  private planPnl(members: Map<string, Member>, now: number): void {
    const lane = this.hlc;
    const queued = lane.countPrefix('cohpnl:');
    if (queued >= PNL_QUEUE_CAP) return;
    const done = this.pnls();
    const due: Array<[string, number]> = [];
    // Holders on the main dex and on trade.xyz (the same accounts: accountPnl).
    const seen = new Set<string>();
    for (const [address, book] of [...this.books.get('hyperliquid')!, ...this.books.get('tradexyz')!]) {
      if (!book.pos.size || seen.has(address)) continue;
      seen.add(address);
      const m = members.get(address);
      const read = done.get(address);
      // Ranked by the leaderboard (its PnL is the leaderboard's), unless only our read gave it.
      if (m?.pnl != null && !read) continue;
      const eq = m?.equity ?? book.equity ?? 0;
      if (read && now - read.at < pnlTtl(eq)) continue;
      due.push([address, pnlPrio(eq)]);
    }
    due.sort((a, b) => b[1] - a[1]);
    for (const [address, prio] of due.slice(0, PNL_QUEUE_CAP - queued)) {
      lane.add({
        key: `cohpnl:${address}`,
        prio,
        run: async () => {
          const r = await hlPortfolioPnl(address);
          const at = this.d.now();
          const row: CohortPnlRow = r ?? { address, pnl: null, pnl1d: null, pnl7d: null, pnl30d: null };
          this.d.store.putCohortPnl('hyperliquid', [row], at);
          done.set(address, { ...row, at });
          return PNL_READ_COST;
        },
      });
    }
  }

  /**
   * trade.xyz is a dex of Hyperliquid accounts: its wallets sit in the PnL cohort
   * of the account's all-time PnL (the leaderboard's, else its portfolio's - the
   * measure Hyperdash places the same address by), the venue's own figure only
   * where the account has none. Before 2026-10-25 only the ~80 holders the boards
   * track had one, from their xyz fills.
   */
  private accountPnl(members: Map<string, Member>, hlMembers: Map<string, Member>): void {
    const read = this.pnls();
    for (const [a, m] of members) {
      const h = hlMembers.get(a);
      const r = read.get(a);
      if (h?.pnl != null) {
        m.pnl = h.pnl;
        m.pnlRange = h.pnlRange;
      } else if (r?.pnl != null) {
        m.pnl = r.pnl;
        m.pnlRange = { '1d': r.pnl1d, '7d': r.pnl7d, '30d': r.pnl30d };
      }
    }
  }

  /** Changed members to the table the API thread reads, a slice at a time. */
  private async saveMembers(venue: Venue, members: Map<string, Member>): Promise<void> {
    const changed: import('./store.js').CohortMemberRow[] = [];
    const r = (v: number | null | undefined) => (v == null ? '' : Math.round(v));
    for (const [address, m] of members) {
      const sig = `${r(m.pnl)}|${r(m.equity)}|${m.label ?? ''}|${r(m.pnlRange?.['1d'])}|${r(m.pnlRange?.['7d'])}|${r(m.pnlRange?.['30d'])}`;
      const k = `${venue}|${address}`;
      if (this.memberSig.get(k) === sig) continue;
      this.memberSig.set(k, sig);
      changed.push({ address, pnl: m.pnl, equity: m.equity, label: m.label, pnl1d: m.pnlRange?.['1d'] ?? null, pnl7d: m.pnlRange?.['7d'] ?? null, pnl30d: m.pnlRange?.['30d'] ?? null });
    }
    for (let i = 0; i < changed.length; i += 5_000) {
      this.d.store.putCohortMembers(venue, changed.slice(i, i + 5_000), this.d.now());
      await new Promise<void>((r) => setImmediate(r));
      mark('coh:plan');
    }
  }

  // --- reads --------------------------------------------------------------------------

  private laneOf(venue: Venue): Lane {
    if (venue === 'sodex') return this.scoh;
    if (venue === 'lighter') return this.d.lighter.lane;
    if (venue === 'arcus') return this.d.arcus.lane;
    return this.hlc;
  }

  /** `total`: the member's account value (Hyperliquid: the leaderboard's), for needsSpot. */
  private readOne(venue: Venue, address: string, total: number | null): Promise<PositionRead> {
    switch (venue) {
      case 'hyperliquid': return hlPositions(address, undefined, (r) => needsSpot(total, r.equity, r.positions.length));
      case 'tradexyz': return hlPositions(address, 'xyz');
      case 'sodex': return sodexPositions(address);
      case 'lighter': return lighterPositions(address, this.d.lighter.pacer);
      case 'arcus': return arcusPositions(address, this.d.arcus.pacer);
    }
  }

  private async plan(): Promise<void> {
    const t0 = Date.now();
    this.updateLiqBoost();
    try {
      await this.planVenues();
    } finally {
      this.planMs = Date.now() - t0;
    }
    try {
      await this.planRebuild();
    } catch (e) {
      if (this.rebuild) this.rebuild.lastError = String(e);
      this.lastError = `cohort rebuild: ${String(e)}`;
    }
  }

  // --- history rebuild (cohortRebuild.ts) --------------------------------------------------

  private lend(weight: number): void {
    if (weight === this.lent) return;
    this.lent = weight;
    this.applyLending();
  }

  /**
   * What the boards lane lends now: to the history rebuild while it reads, or -
   * while the liquidation backlog is on (liqBoost) - to the cohort lane instead.
   */
  private applyLending(): void {
    const liq = this.liqBoost ? LIQ_BOOST_LEND : 0;
    this.d.lendHl?.((this.liqBoost ? 0 : this.lent) + liq);
    this.hlc.setPerMin(this.hlcBase + liq);
  }

  /**
   * The liquidation backlog (Hyperliquid and trade.xyz books holding positions with
   * no liquidation data) gets the reads first while it is large: the history rebuild
   * pauses and lends its 200 a minute to the cohort lane, and the PnL reads' share
   * drops to LIQ_BOOST_PNL_SHARE. Both come back once it is down to LIQ_BOOST_MIN.
   * (The owner, 2026-10-25: a fully indexed liquidation map first.)
   */
  private updateLiqBoost(): void {
    const due = (this.liqDue.get('hyperliquid') ?? 0) + (this.liqDue.get('tradexyz') ?? 0);
    const on = this.liqBoost ? due > LIQ_BOOST_MIN / 2 : due > LIQ_BOOST_MIN;
    if (on === this.liqBoost) return;
    this.liqBoost = on;
    this.hlc.setShare('cohpnl:', on ? LIQ_BOOST_PNL_SHARE : PNL_SHARE);
    // A rebuild task already running finishes on its own budget; no new one starts.
    this.hlh.setPerMin(on ? 1 : this.hlhBase);
    this.applyLending();
  }

  /**
   * The newest span the recording missed: read wallet by wallet in the rebuild
   * lane, then priced, then written - every minute, the next step. The reads
   * are kept (cohort_hist), so a restart carries on where it stopped.
   */
  private async planRebuild(): Promise<void> {
    // Paused while the liquidation backlog takes the reads (updateLiqBoost); it carries on after.
    if (this.liqBoost) return;
    const s = this.d.store;
    const now = this.d.now();
    if (!this.rebuild) {
      if (!this.members.size || !this.lastSeriesT) return;
      const recorded = s.cohortSeriesRecorded(scopeKey(VENUES), COHORTS[0]!.id, now - REBUILD_WINDOW_MS);
      const span = missingSpans(recorded, now).filter((x) => s.getMeta(`cohort_rebuilt:${x.from}`) == null).at(-1);
      for (const old of s.cohortHistSpans()) if (old !== span?.from) s.dropCohortHist(old);
      if (!span) {
        this.lend(0);
        return;
      }
      this.rebuild = {
        span, plan: await this.rebuildPlan(), read: s.cohortHistKeys(span.from, 'w'), phase: 'reads',
        symbols: new Set(), priced: new Set(), startedAt: now, check: null, lastError: null, fails: new Map(), skipped: 0,
      };
    }
    const r = this.rebuild;
    if (r.phase === 'writing') return;
    if (r.phase === 'reads') {
      const unread = [...r.plan].filter(([a]) => !r.read.has(a));
      if (unread.length) {
        this.lend(this.rebuildRate);
        this.queueRebuildReads(r, unread);
        return;
      }
      for (const data of s.cohortHist(r.span.from, 'w').values()) {
        for (const sym of Object.keys((JSON.parse(data) as WalletHist).p)) if (venueOfSymbol(sym)) r.symbols.add(sym);
      }
      r.priced = s.cohortHistKeys(r.span.from, 'px');
      r.phase = 'prices';
    }
    const unpriced = [...r.symbols].filter((x) => !r.priced.has(x));
    if (unpriced.length) {
      this.lend(this.rebuildRate);
      const { from, to } = readRange(r.span);
      for (const symbol of unpriced) {
        this.hlh.add({
          key: `hpx:${symbol}`,
          prio: 2_000,
          run: async () => {
            const { px, cost } = await hlHourlyPrices(symbol, from - HOUR_MS, to + HOUR_MS, this.histPace);
            s.putCohortHist(r.span.from, 'px', [[symbol, JSON.stringify(px)]], this.d.now());
            r.priced.add(symbol);
            return cost;
          },
        });
      }
      return;
    }
    this.lend(0);
    r.phase = 'writing';
    try {
      await this.writeRebuild(r);
      s.setMeta(`cohort_rebuilt:${r.span.from}`, JSON.stringify({ to: r.span.to, at: this.d.now(), wallets: r.read.size - r.skipped, skipped: r.skipped, check: r.check }));
      s.dropCohortHist(r.span.from);
      this.rebuild = null;
    } catch (e) {
      r.phase = 'prices';
      throw e;
    }
  }

  /** Which Hyperliquid / trade.xyz wallets a rebuild reads (cohortRebuild.ts WHICH WALLETS). */
  private async rebuildPlan(): Promise<Map<string, number>> {
    const vol = new Map<string, number>();
    const snap = await this.d.hlSnapshot();
    const v30 = snap?.data.cols['volume:30d'];
    if (snap && v30) snap.data.addresses.forEach((a, i) => { if (!Number.isNaN(v30[i]!)) vol.set(a, v30[i]!); });
    const hl = this.members.get('hyperliquid') ?? new Map<string, Member>();
    const xyz = this.members.get('tradexyz') ?? new Map<string, Member>();
    const hb = this.books.get('hyperliquid')!;
    const xb = this.books.get('tradexyz')!;
    const out = new Map<string, number>();
    let t0 = Date.now();
    for (const a of new Set([...hl.keys(), ...xyz.keys(), ...hb.keys(), ...xb.keys()])) {
      const eq = Math.max(hl.get(a)?.equity ?? 0, perpEquity('hyperliquid', hb.get(a), xb.get(a)) ?? 0);
      const pick = rebuildSample(a, sizeProxy(eq, vol.get(a)));
      if (pick.counts) out.set(a, pick.weight);
      if (Date.now() - t0 > SLICE_MS) {
        await new Promise<void>((res) => setImmediate(res));
        mark('coh:plan');
        t0 = Date.now();
      }
    }
    return out;
  }

  /** A wallet's equity now on Hyperliquid: its perp equity, else the leaderboard's account value. */
  private equityNow(address: string): number | null {
    const hb = this.books.get('hyperliquid')!.get(address);
    const xb = this.books.get('tradexyz')!.get(address);
    return perpEquity('hyperliquid', hb, xb) ?? this.members.get('hyperliquid')?.get(address)?.equity ?? null;
  }

  private queueRebuildReads(r: RebuildState, unread: Array<[string, number]>): void {
    const queued = this.hlh.countPrefix('hist:');
    if (queued >= REBUILD_QUEUE) return;
    // Largest first: the money the charts show.
    const ranked = unread
      .filter(([a]) => !this.hlh.has(`hist:${a}`))
      .map(([a, w]) => [a, w, this.equityNow(a) ?? 0] as const)
      .sort((x, y) => y[2] - x[2]);
    const { from, to } = readRange(r.span);
    const s = this.d.store;
    for (const [address, weight, eq] of ranked.slice(0, REBUILD_QUEUE - queued)) {
      this.hlh.add({
        key: `hist:${address}`,
        prio: 1_000 + Math.round(Math.log10(Math.max(1, eq)) * 100),
        run: async () => {
          // Half an hour either side: a funding row is stamped a little after its hour,
          // so a read ending on the hour missed that hour (seen 2026-10-25 checking it).
          const read = await hlFundingRows(address, from - HOUR_MS / 2, to + HOUR_MS / 2, this.histPace).catch((e: unknown) => {
            const n = (r.fails.get(address) ?? 0) + 1;
            r.fails.set(address, n);
            if (n >= REBUILD_TRIES) {
              r.read.add(address);
              r.skipped++;
            }
            throw e;
          });
          const { rows, cost } = read;
          const hist = histOf(rows, weight);
          let extra = 0;
          const peak = peakNotional(hist, (sym) => this.marks.get(`${venueOfSymbol(sym)}|${sym}`) ?? null);
          if (needsEquityHistory(peak, this.equityNow(address))) {
            hist.eq = (await hlEquityHistory(address, this.histPace)) ?? undefined;
            extra = PNL_READ_COST;
          }
          s.putCohortHist(r.span.from, 'w', [[address, JSON.stringify(hist)]], this.d.now());
          r.read.add(address);
          return cost + extra;
        },
      });
    }
  }

  /** The venues the reads do not rebuild, at their recorded points either side of the span (cohortRebuild.ts Bridge). */
  private bridges(span: Span): Map<Venue, Bridge> {
    const s = this.d.store;
    const out = new Map<Venue, Bridge>();
    const near = 3 * HOUR_MS;
    for (const v of VENUES) {
      if (REBUILT_VENUES.includes(v)) continue;
      const before = s.cohortSeries(v, span.from - near, undefined, span.from).filter((x) => !x.rebuilt);
      const after = s.cohortSeries(v, span.to, undefined, span.to + near).filter((x) => !x.rebuilt);
      const lt = before.at(-1)?.t;
      const rt = after[0]?.t;
      if (lt === undefined || rt === undefined) continue;
      const at = (rows: typeof before, t: number) => ({ t, series: new Map(rows.filter((x) => x.t === t).map((x) => [x.cohort, [x.long, x.short] as [number, number]])) });
      const mb = s.cohortMix(v, span.from - near, undefined, span.from).filter((x) => !x.rebuilt);
      const ma = s.cohortMix(v, span.to, undefined, span.to + near).filter((x) => !x.rebuilt);
      const mixAt = (rows: typeof mb, t: number | undefined) =>
        t === undefined ? null : { t, mix: new Map(rows.filter((x) => x.t === t).map((x) => [x.cohort, { c: x.c, s: x.s }])) };
      out.set(v, { left: at(before, lt), right: at(after, rt), mixLeft: mixAt(mb, mb.at(-1)?.t), mixRight: mixAt(ma, ma[0]?.t) });
    }
    return out;
  }

  /** Every missing hour of the span from the reads: checked against the recording at its edges, then written. */
  private async writeRebuild(r: RebuildState): Promise<void> {
    const s = this.d.store;
    const px = new Map<string, Map<number, number>>();
    for (const [symbol, data] of s.cohortHist(r.span.from, 'px')) px.set(symbol, new Map(JSON.parse(data) as Array<[number, number]>));
    const price = (symbol: string, t: number) => priceAt(px.get(symbol), t);
    const hl = this.members.get('hyperliquid') ?? new Map<string, Member>();
    const xyz = this.members.get('tradexyz') ?? new Map<string, Member>();
    const hb = this.books.get('hyperliquid')!;
    const xb = this.books.get('tradexyz')!;
    const wallets: RebuildWallet[] = [];
    for (const [address, data] of s.cohortHist(r.span.from, 'w')) {
      const m = hl.get(address);
      const x = xyz.get(address);
      const now: RebuildWallet['now'] = {
        hyperliquid: { pnl: m?.pnl ?? null, equity: perpEquity('hyperliquid', hb.get(address), xb.get(address)) ?? m?.equity ?? null, label: m?.label ?? null },
      };
      if (x || xb.has(address)) {
        now.tradexyz = { pnl: x?.pnl ?? null, equity: perpEquity('tradexyz', xb.get(address), hb.get(address)) ?? x?.equity ?? null, label: x?.label ?? null };
      }
      wallets.push({ address, hist: JSON.parse(data) as WalletHist, now });
    }
    const bridges = this.bridges(r.span);
    const breath = async () => {
      await new Promise<void>((res) => setImmediate(res));
      mark('coh:rebuild');
    };
    // The edges: the rebuild against what was recorded there (Hyperliquid's own scope).
    const { from, to } = readRange(r.span);
    const recorded = new Map<number, Map<string, [number, number]>>();
    for (const x of s.cohortSeries('hyperliquid', from, undefined, to)) {
      if (x.rebuilt || (x.t >= r.span.from && x.t <= r.span.to)) continue;
      const m = recorded.get(x.t) ?? new Map<string, [number, number]>();
      m.set(x.cohort, [x.long, x.short]);
      recorded.set(x.t, m);
    }
    const rebuilt = new Map<number, Map<string, [number, number]>>();
    for (const t of recorded.keys()) {
      if (t % HOUR_MS) continue;
      rebuilt.set(t, rebuildHour(t, wallets, price, bridges, false).base.get('hyperliquid')!);
      await breath();
    }
    r.check = checkEdges(rebuilt, recorded);
    for (let t = r.span.from; t <= r.span.to; t += HOUR_MS) {
      const h = rebuildHour(t, wallets, price, bridges, true);
      s.putCohortSeries(h.series);
      s.putCohortMix(h.mix);
      await breath();
    }
  }

  private async planVenues(): Promise<void> {
    const now = this.d.now();
    this.staleBefore = resumedAfterOutage(this.d.store.cohortSeriesRecorded(scopeKey(VENUES), COHORTS[0]!.id, now - REBUILD_WINDOW_MS));
    const hlMembers = await this.membersOf('hyperliquid');
    const breath = async () => {
      await new Promise<void>((r) => setImmediate(r));
      mark('coh:plan');
    };
    for (const venue of VENUES) {
      await breath();
      const members = venue === 'hyperliquid' ? hlMembers : await this.membersOf(venue);
      if (venue === 'tradexyz') this.accountPnl(members, hlMembers);
      await breath();
      this.members.set(venue, members);
      await this.saveMembers(venue, members);
      if (venue === 'hyperliquid') {
        this.planPnl(members, now);
        await breath();
      }
      // A new continuous stream span means an outage: large books are unknown again.
      const since = this.d.streamSince(venue);
      if (STREAMED.has(venue) && since !== null && this.span.has(venue) && this.span.get(venue) !== since) {
        // The activity span broke: an outage longer than the tolerance.
        this.gapAt.set(venue, now);
        this.gapFloor.set(venue, 100_000);
      }
      this.span.set(venue, since);
      const streamed = STREAMED.has(venue) && since !== null && (this.d.socketUp?.(venue) ?? true);

      const lane = this.laneOf(venue);
      const queued = lane.countPrefix(`coh:${venue}:`);
      if (queued >= QUEUE_CAP) continue;
      const books = this.books.get(venue)!;
      const gap = this.gapAt.get(venue) ?? 0;
      const floor = this.gapFloor.get(venue) ?? 100_000;
      const due: Array<[string, number]> = [];
      let liqDue = 0;
      const totals = new Map<string, number | null>();
      const notional = (book: Book): number => {
        let v = 0;
        for (const [symbol, p] of book.pos) v += Math.abs(p.szi) * (this.marks.get(`${venue}|${symbol}`) ?? p.entry ?? 0);
        return v;
      };
      const consider = (address: string, m: Member | undefined) => {
        const eq = m?.equity ?? (venue === 'tradexyz' ? hlMembers.get(address)?.equity ?? 0 : 0);
        const book = books.get(address);
        const traded = this.wanted.has(`${venue}|${address}`);
        const size = Math.round(Math.log10(Math.max(1, eq)) * 100);
        // A tail wallet outside the sample is never read, traded or not (it would count twice).
        if (!sampleRule(TAIL_RATE[venue], address, eq).counts) return;
        const push = (prio: number) => {
          due.push([address, prio]);
          if (venue === 'hyperliquid') totals.set(address, m?.equity ?? null);
        };
        if (!book) {
          push(1_000 + size + (traded ? 300 : 0));
          return;
        }
        const age = now - book.at;
        // Lighter prints name sub-accounts: a book follows them only once its indices are known.
        const follows = streamed && (venue !== 'lighter' || (this.d.lighter.known?.(address) ?? false));
        // Read before the books kept liquidation prices (2026-10-25): once, the most leveraged first -
        // their liquidations sit nearest the price, where the heatmap is read.
        if (book.pos.size && !liqKnown(book) && (book.at < this.startedAt || book.liqMiss)) {
          push(liqBacklogPrio(notional(book), book.collateral ?? book.equity));
          liqDue++;
        }
        else if (book.pos.size && staleEquity(book, notional(book), now)) push(950 + size);
        else if (follows && eq >= floor && book.at < gap) push(900 + size);
        // Read before the last outage ended: it missed that outage's prints, at any size.
        else if (follows && book.at < this.staleBefore) push(900 + size);
        // Read before the spot state was looked at, and the leaderboard says it may matter.
        else if (venue === 'hyperliquid' && spotDue(book, m?.equity)) push(900 + size);
        else if (age >= (follows ? reconcileTtl(eq, venue) : pollTtl(eq))) push(400 + size);
      };
      let t0 = Date.now();
      for (const [address, m] of members) {
        consider(address, m);
        if (Date.now() - t0 > SLICE_MS) {
          await new Promise<void>((r) => setImmediate(r));
          mark('coh:plan');
          t0 = Date.now();
        }
      }
      for (const k of this.wanted.keys()) {
        if (!k.startsWith(`${venue}|`)) continue;
        const address = k.slice(venue.length + 1);
        if (!members.has(address)) consider(address, undefined);
      }
      this.liqDue.set(venue, liqDue);
      due.sort((a, b) => b[1] - a[1]);
      for (const [address, prio] of due.slice(0, QUEUE_CAP - queued)) {
        lane.add({
          key: `coh:${venue}:${address}`,
          prio,
          run: async () => {
            const r = await this.readOne(venue, address, totals.get(address) ?? null);
            if (venue === 'lighter' && r.indices?.length) this.d.lighter.learn?.(address, r.indices);
            const at = this.d.now();
            const book: Book = {
              equity: r.equity, at, collateral: r.collateral ?? null, spotAt: r.spotAt ?? null,
              pos: new Map(r.positions.map((p) => [p.symbol, { szi: p.szi, entry: p.entry }])),
            };
            await this.liquidationSide(venue, r, books.get(address), book);
            books.set(address, book);
            this.live.touch(venue, address);
            this.dirtyBooks.add(`${venue}|${address}`);
            this.wanted.delete(`${venue}|${address}`);
            for (const [sym, px] of r.marks) {
              const mk = `${venue}|${sym}`;
              if (!this.marks.has(mk)) { this.marks.set(mk, px); this.dirtyMarks.add(mk); }
            }
            return READ_COST[venue] + (r.extraCost ?? 0);
          },
        });
      }
    }
  }

  private flush(): void {
    const s = this.d.store;
    try {
      if (this.dirtyBooks.size) {
        const rows: Array<{ venue: Venue; address: string; equity: number | null; positions: BookPosition[]; at: number; collateral: number | null; spotAt: number | null; cash: number | null }> = [];
        for (const k of this.dirtyBooks) {
          const i = k.indexOf('|');
          const venue = k.slice(0, i) as Venue;
          const address = k.slice(i + 1);
          const b = this.books.get(venue)?.get(address);
          if (!b) continue;
          rows.push({
            venue, address, equity: b.equity, at: b.at, collateral: b.collateral ?? null, spotAt: b.spotAt ?? null, cash: b.cash ?? null,
            positions: [...b.pos].map(([symbol, p]) => ({ symbol, ...p })),
          });
        }
        this.dirtyBooks.clear();
        s.putCohortBooks(rows);
      }
      if (this.liqAccDirty) {
        this.liqAccDirty = false;
        s.setMeta(LIQ_ACC_META, JSON.stringify(Object.fromEntries(this.liqAcc)));
      }
      if (this.dirtyMarks.size) {
        const rows: Array<[string, number]> = [];
        for (const k of this.dirtyMarks) rows.push([k, this.marks.get(k)!]);
        this.dirtyMarks.clear();
        s.putCohortMarks(rows, this.d.now());
      }
    } catch (e) {
      this.lastError = `cohort flush: ${String(e)}`;
    }
  }

  // --- liquidation prices -----------------------------------------------------------------

  private accOf(venue: Venue): DriftStats {
    const now = this.d.now();
    let a = this.liqAcc.get(venue);
    if (!a) { a = { cur: emptyDrift(now), prev: null }; this.liqAcc.set(venue, a); }
    if (now - a.cur.since >= DAY_MS) a = { cur: emptyDrift(now), prev: a.cur };
    this.liqAcc.set(venue, a);
    return a.cur;
  }

  /**
   * A fresh read's liquidation side: the book's cash and isolated extras from the
   * venue's own figures (liquidations/math.ts calibrate), and how far the book it
   * replaces had drifted from them - the old book's figures at the read's marks
   * against the venue's new ones, for positions whose size is unchanged.
   */
  private async liquidationSide(venue: Venue, r: PositionRead, prev: Book | undefined, book: Book): Promise<void> {
    if (!r.liq) return;
    const m = await venueMarkets(venue).catch(() => null);
    // No margin rules yet (the first minutes after a start: 14% of Hyperliquid's reads after v0.2.22 went unpriced and stayed so).
    if (!m || !m.tiers.size) { if (book.pos.size) book.liqMiss = true; return; }
    const tiersFor = (s: string): Tiers | null => m.tiers.get(s) ?? null;
    const cal = calibrate(r.liq, tiersFor);
    book.cash = cal.cash;
    r.liq.positions.forEach((p, i) => {
      const x = book.pos.get(p.symbol);
      const c = cal.pos[i]!;
      if (!x) return;
      if (c.iso !== undefined) { x.iso = c.iso; x.lev = c.lev ?? null; }
      if (c.fix != null) x.fix = c.fix;
    });
    const st = this.accOf(venue);
    st.checked += cal.checked;
    st.matched += cal.matched;
    this.liqAccDirty = true;
    if (!prev || !liqKnown(prev) || r.liq.split) return;
    const now = new Map(r.liq.positions.map((p) => [p.symbol, p]));
    const was = [...prev.pos].map(([symbol, p]) => ({ symbol, ...p }));
    const liq = accountLiqs(prev.cash ?? null, was, (s) => now.get(s)?.mark ?? this.marks.get(`${venue}|${s}`) ?? null, tiersFor);
    was.forEach((p, i) => {
      const q = now.get(p.symbol);
      if (!q || Math.abs(q.szi - p.szi) > 1e-9 * Math.abs(p.szi)) { st.moved++; return; }
      if (q.vliq === undefined) return;
      addDrift(st, liq[i] ?? null, q.vliq ?? null, Math.abs(q.szi) * (q.vliq ?? q.mark ?? 0));
    });
  }

  /**
   * Every LIQ_NOW_MS: every coin's levels, as the live engine holds them, to the
   * index file (liq_now, deflated: what the API answers from when the live feed is
   * not there). Every LIQ_STEP_MS also a snapshot for the historical view
   * (liq_hist) of every coin SoDEX lists as a perp and of the LIQ_COINS others with
   * the most open notional tracked.
   */
  /** A venue's price for a symbol: its coin's reference price when the venue ranks first among those seen. */
  private noteCoinPx(key: string, px: number): void {
    if (!(px > 0)) return;
    const i = key.indexOf('|');
    const rank = LIQ_PRICE_ORDER.indexOf(key.slice(0, i) as Venue);
    const coin = liqCoin(key.slice(i + 1));
    const cur = this.coinPx.get(coin);
    if (!cur || rank <= cur.rank) this.coinPx.set(coin, { px, rank: rank < 0 ? 99 : rank });
  }

  /** Every LIVE_TICK_MS: price what changed (a bounded slice), and send the changes to the API. */
  private liveTick(): void {
    const t0 = Date.now();
    // Every coin whole once a minute: the deltas leave out moves under 1% (live.ts SEND_MOVE: 1%), this puts the API's copy back to exact.
    if (t0 - this.liveWholeAt >= 60_000) { this.liveWholeAt = t0; this.live.resendAll(); }
    const left = this.live.work(LIVE_SLICE);
    if (!left && !this.liveReady) this.liveReady = true;
    const deltas = this.live.flush();
    this.feed.send(deltas, { at: this.d.now(), ready: this.liveReady });
    this.liveMs = Date.now() - t0;
  }

  private async recordLiq(): Promise<void> {
    const now = this.d.now();
    if (this.liqRecording || !this.members.size || now - this.lastNowAt < LIQ_NOW_MS - 5_000) return;
    this.liqRecording = true;
    const started = Date.now();
    try {
      // Until every book is priced into the engine once (seconds after a start), the last rows stand.
      if (!this.liveReady) return;
      const sodexCoins = new Set<string>();
      for (const sym of (await venueMarkets('sodex').catch(() => null))?.tiers.keys() ?? []) sodexCoins.add(liqCoin(sym));
      const rows = this.live.rows();
      const s = this.d.store;
      s.putLiqNow(now, [...rows].map(([coin, row]): [string, Uint8Array] => [coin, deflateRawSync(JSON.stringify(row))]));
      this.lastNowAt = now;
      const t = Math.floor(now / LIQ_STEP_MS) * LIQ_STEP_MS;
      if (t > this.lastLiqT) {
        const keep = new Set([...sodexCoins, ...this.live.ranked().slice(0, LIQ_COINS)]);
        const hist: Array<[string, string]> = [];
        for (const coin of keep) {
          const row = rows.get(coin);
          if (row) hist.push([coin, JSON.stringify(snapOfNow(row))]);
        }
        if (hist.length) s.putLiqHist(t, hist);
        s.pruneLiqHist(now - LIQ_KEEP_MS, now - LIQ_THIN_MS, 60 * 60_000);
        this.lastLiqT = t;
      }
    } catch (e) {
      this.lastError = `liquidations: ${String(e)}`;
    } finally {
      this.liqRecording = false;
      this.liqMs = Date.now() - started;
    }
  }

  // --- history ------------------------------------------------------------------------

  /** The netted input for every scope, from the books in memory (yielding between slices). */
  private async perVenue(): Promise<Map<Venue, Map<string, WalletVenue>>> {
    const per = new Map<Venue, Map<string, WalletVenue>>();
    let t0 = Date.now();
    for (const venue of VENUES) {
      const m = new Map<string, WalletVenue>();
      const books = this.books.get(venue)!;
      const sib = MARGIN_SIBLING[venue];
      const sibBooks = sib ? this.books.get(sib) : undefined;
      const members = this.members.get(venue) ?? new Map<string, Member>();
      const addresses = new Set([...members.keys(), ...books.keys()]);
      for (const address of addresses) {
        const b = books.get(address);
        m.set(address, sampledVenue(TAIL_RATE[venue], address, members.get(address),
          b ? { equity: b.equity, at: b.at, positions: [...b.pos].map(([symbol, p]) => ({ symbol, szi: p.szi, entry: p.entry })) } : undefined,
          perpEquity(venue, b, sibBooks?.get(address))));
        if (Date.now() - t0 > SLICE_MS) {
          await new Promise<void>((r) => setImmediate(r));
          mark('coh:record');
          t0 = Date.now();
        }
      }
      per.set(venue, m);
    }
    return per;
  }

  private async record(): Promise<void> {
    const now = this.d.now();
    const seriesT = Math.floor(now / SERIES_STEP_MS) * SERIES_STEP_MS;
    const mixT = Math.floor(now / MIX_STEP_MS) * MIX_STEP_MS;
    if (this.recording || (seriesT <= this.lastSeriesT && mixT <= this.lastMixT) || !this.members.size) return;
    this.recording = true;
    const t0 = Date.now();
    try {
      const per = await this.perVenue();
      const priceOf = (v: Venue, sym: string) => this.marks.get(`${v}|${sym}`) ?? null;
      const series: Array<{ scope: string; cohort: string; t: number; long: number; short: number }> = [];
      const mix: Array<{ scope: string; cohort: string; t: number; data: string }> = [];
      const doMix = mixT > this.lastMixT;
      for (const scope of allScopes()) {
        const key = scopeKey(scope);
        // Netted and summed in batches, handing the loop back between them: one
        // scope is ~120k wallets, which in one go held it for about two seconds.
        const agg = new Aggregator();
        const addresses = new Set<string>();
        for (const v of scope) for (const a of per.get(v)!.keys()) addresses.add(a);
        let t0 = Date.now();
        for (const address of addresses) {
          const mine = new Map<Venue, WalletVenue>();
          for (const v of scope) {
            const w = per.get(v)!.get(address);
            if (w) mine.set(v, w);
          }
          agg.add(netWallet(address, mine, priceOf));
          if (Date.now() - t0 > SLICE_MS) {
            await new Promise<void>((r) => setImmediate(r));
            mark('coh:record');
            t0 = Date.now();
          }
        }
        for (const st of agg.result()) {
          series.push({ scope: key, cohort: st.id, t: seriesT, long: st.long, short: st.short });
          if (doMix) {
            const c: Record<string, [number, number]> = {};
            for (const m of st.markets.slice(0, MIX_COINS)) c[m.coin] = [Math.round(m.long), Math.round(m.short)];
            const sct: Record<string, [number, number]> = {};
            for (const x of sectorTotals(st.markets)) sct[x.sector] = [Math.round(x.long), Math.round(x.short)];
            mix.push({ scope: key, cohort: st.id, t: mixT, data: JSON.stringify({ c, s: sct }) });
          }
        }
        await new Promise<void>((r) => setImmediate(r));
      }
      const s = this.d.store;
      if (seriesT > this.lastSeriesT) {
        s.putCohortSeries(series);
        s.pruneCohortSeries(now - SERIES_KEEP_MS);
        this.lastSeriesT = seriesT;
      }
      if (doMix) {
        s.putCohortMix(mix);
        s.pruneCohortMix(now - SERIES_KEEP_MS);
        this.lastMixT = mixT;
      }
    } finally {
      this.recording = false;
      this.recordMs = Date.now() - t0;
    }
  }
}
