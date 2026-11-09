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
 *   - otherwise every book is re-read after 6 h ($1M+), 24 h ($100K+) or 7 days
 *     (Hyperliquid and trade.xyz, paid their funding hourly: 24 h, 3 days, 7 days),
 *     which bounds drift from anything a print cannot show (funding does not
 *     change size; transfers do not touch positions).
 * Lighter's stream names sub-accounts, so a Lighter book follows prints once
 * the wallet's indices are known (its first read learns them); until then,
 * and whenever that stream is down, books are re-read on a size schedule
 * (30 min for $5M+ ... 2 days for small). Below TAIL_EQUITY only a fixed 10%
 * sample of its ~100k accounts was read until 2026-10-31 (each standing for ten;
 * model.ts sampleRule); every one is read since, and the sample counts until
 * nearly all are (TAIL_SAMPLED_BEFORE).
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
import { VENUES, type Venue } from '../valuedesk/types.js';
import { activeAccountsAsync } from './activeScan.js';
import type { LbSnapshot } from '../valuedesk/hyperliquid/leaderboard.js';
import type { Pacer } from '../valuedesk/extra/http.js';
import {
  COHORTS, coinOf, perpEquity, scopeKey,
  type CohortRange, type Position,
} from '../valuedesk/cohorts/model.js';
import { readInSlices } from './slicedWork.js';
import { Lane } from './lanes.js';
import { WeightBudget } from '../valuedesk/hyperliquid/info.js';
import { mark, within } from './busy.js';
import type { Print } from './streams.js';
import { defaultDbPath, type IndexStore } from './store.js';
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DAY_MS, dayOf } from './windows.js';
import {
  PNL_READ_COST, READ_COST, arcusPositions, hlEquityHistory, hlFundingRows, hlHourlyPrices, hlPortfolioPnl, hlPositions,
  lighterPositions, sodexPositionsOf, type BookRead, type PositionRead,
} from './cohortSource.js';
import {
  HOUR_MS, REBUILD_WINDOW_MS, REBUILT_VENUES, checkEdges, histOf, missingSpans, needsEquityHistory, peakNotional, priceAt,
  OUTAGE_GAP_MS, readRange, rebuildHour, rebuildSample, resumedAfterOutage, sizeProxy, venueOfSymbol,
  type Bridge, type RebuildCheck, type RebuildWallet, type Span, type WalletHist,
} from './cohortRebuild.js';
import type { BookPosition, CohortMemberRow, CohortPnlRow, LiqLogExtra } from './store.js';
import { accountLiqs, addDrift, calibrate, emptyDrift, feeCash, fillCash, fundingCash, niceStep, type DriftStats, type Tiers } from '../valuedesk/liquidations/math.js';
import { hlInfo } from '../valuedesk/hyperliquid/index.js';
import { ARCUS_FEES_COST, ASK_MIN_USD, BASE_FEES, FEES_TTL_MS, HL_FEES_COST, SODEX_FEES_COST, arcusFees, fillRate, hlFees, sodexFees, spotSellRate, xyzScales, type FeeRates, type MarketScale } from './feeRates.js';
import { marketsNow, setRulesPacers, venueMarkets } from '../valuedesk/liquidations/rules.js';
import { liqCoin } from '../valuedesk/liquidations/levels.js';
import { liveLink, type LiveLink } from './liqLiveThread.js';
import { logExtraOf } from './liqLiveCore.js';
import { loadReadList, loadSeeds, type Seeds } from './archiveSeed.js';
import { mayPrune } from '../retention.js';
import { OI_EXCESS, oiCheck, oiOver, oiStatus, overSides } from './oiCheck.js';
import { RestReader } from './sodexCatchup.js';
import type { PerpsState } from '../valuedesk/sodex/mappers.js';
import { chargeGatewayWeight } from '../valuedesk/sodex/gateway.js';
import { excludedOf, isExcluded } from '../valuedesk/internalWallets.js';
import { sodexInternalNow } from '../valuedesk/sodex/oiExcluded.js';
import {
  MembersEncoder, MemberSigs, cohortWorkerOn, decodeRows, encodeMembers, planDue, pnlScan, recordCompute, liqKnown,
  type Book, type CohortIn, type CohortView, type DueList, type Member, type MembersWire, type PlanAsk, type PlanOut, type RecordAsk, type RecordOut,
} from './cohortCore.js';
import { oiRereadsMany, type OiAsk } from './oiCheck.js';

// The rules a book is read by live in cohortCore.ts (they run on the heatmap thread too); here as before for every caller.
export {
  EMPTY_RECONCILE_MS, FILLED_REREAD_MIN, FILLED_REREAD_MS, MAX_LEVERAGE, READ_LIST_PRIO, SODEX_BOOK_MAX_MS, SPOT_LEVERAGE, SPOT_VALUE_SINCE,
  TAIL_FULL_SHARE, TAIL_RATE, TAIL_SAMPLED_BEFORE, allScopes, liqBacklogPrio, liqChangedDue, liqKnown, liqRefreshTtl, needsSpot, pnlPrio, pnlTtl,
  pollTtl, readNotional, reconcileTtl, routineTtl, sodexBookPrio, sodexBookTtl, spotDue, staleEquity, tailBookDue, tailCountRate, tailOf,
  type Book,
} from './cohortCore.js';
import { needsSpot, readNotional } from './cohortCore.js';

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
/**
 * A venue's full pass (its members worked out and saved, every book and archive holder
 * considered) at most this often (planVenues) - sooner when its queue has run below
 * PLAN_LOW while the last pass found more due, or a stream outage made its large books
 * unknown. Every minute it held 20-32% of the indexer's one thread, and the boards were
 * built in what was left: the first after a restart took 1,100 s (2026-10-28).
 */
export const PLAN_FULL_MS = 5 * 60_000;
export const PLAN_LOW = 100;

/** Whether a venue gets its full pass this minute (planVenues). */
export function fullPassDue(o: { lastAt: number | undefined; now: number; queued: number; dueLeft: number; outage: boolean }): boolean {
  if (o.outage || o.lastAt === undefined || o.now - o.lastAt >= PLAN_FULL_MS) return true;
  // Its queue ran low and the last pass had more than fitted: the reads would wait for nothing.
  return o.queued < PLAN_LOW && o.dueLeft > 0;
}

/** Every coin's liquidation levels (liq_now) this often; a snapshot (liq_hist) every LIQ_STEP_MS. */
/** Every 2 minutes: a pass over ~90k books took 14-26 s of a disk-bound loop (2026-10-25); the edge serves the row in between. */
/** The liquidation backlog takes the reads above this many books (updateLiqBoost)... */
export const LIQ_BOOST_MIN = 300;
/** ...with the boards lane's loan to the history rebuild, and the PnL reads' share cut to this. */
const LIQ_BOOST_LEND = 200;
const LIQ_BOOST_PNL_SHARE = 0.1;
/** The live engine's beat, and how many changed accounts one beat prices at most (a start primes ~90k books in ~20 beats). */
/** The books read at a start: a page, and the thread is let go once this much is used. */
const BOOKS_LOAD_PAGE = 2_000;
const BOOKS_LOAD_SLICE_MS = 40;
/** Kept while they load: minutes of every venue's prints. Past it the re-read after a gap covers what is missed. */
const EARLY_PRINTS_MAX = 1_000_000;
const LIVE_TICK_MS = 1_000;
const LIVE_SLICE = 5_000;
/** ...and at most this long a beat (live.ts work): what is left waits for the next beat. */
const LIVE_BUDGET_MS = 150;
/** With a backlog, up to this long: 30k books waited ~2 minutes at 150 ms (2026-10-28). */
const LIVE_BUDGET_MAX_MS = 300;
/** A member set at least this share of the table it replaces: smaller is a partial read, and nothing is removed. */
const MEMBERS_KEPT_MIN = 0.8;
/** An account's mode read (userAbstraction): its weight, its place in the cohort lane, and how many are kept. */
const MODE_READ_COST = 20;
const MODE_PRIO = 960;
const HL_MODE_MAX = 300_000;
/** Accounts kept in the fee maps at most (cleared past it). */
const TRADED_MAX = 400_000;
/** Where a newly opened market's margin mode is the account's choice, and how soon its book is read again. */
const OPENED_REREAD: ReadonlySet<Venue> = new Set(['hyperliquid', 'tradexyz', 'sodex']);
/** Crossed books held between beats at most (a burst after a start is read over the next passes). */
const CROSSED_MAX = 50_000;
/** Per venue, the newest print time the saved books hold (printApplies after a restart). */
const PRINTS_THROUGH_META = 'cohort_prints_through';
/** The open interest check (checkOi): how often, and how many holders of a coin over it are read per check. */
const OI_CHECK_MS = 5 * 60_000;
/** SoDEX's documented weight of a perps state read. */
const STATE_WEIGHT = 5;
/** Open interest older than this judges nothing (VenueMarkets.at: a failed read leaves the last good one). */
const OI_FRESH_MS = 3 * 60_000;
const OI_REREAD_BATCH: Record<Venue, number> = { hyperliquid: 200, tradexyz: 100, sodex: 50, arcus: 50, lighter: 60 };
/**
 * Over-OI rereads queued per venue per check (OI_CHECK_MS), split over its coins that are over. Hyperliquid and
 * trade.xyz share one lane of ~66 tasks a minute (measured 2026-11-07: 45,238 in ~11.4 h): 2 x 100 every 5 minutes
 * is ~60% of it, run within ~3 minutes at OI_PRIO. Lighter's cohort share is ~13 reads a minute.
 */
export const OI_REREAD_TOTAL: Record<Venue, number> = { hyperliquid: 100, tradexyz: 100, sodex: 50, arcus: 50, lighter: 30 };
/**
 * A book behind an excess over open interest is known wrong: read before everything but the crossed books
 * (crossedPrio, 1,700+). At 870 (until 2026-11-07) it waited behind the gap, staleness and never-read reads
 * (900-1,900): trade.xyz ORCL stayed at 116% with 800 rereads queued.
 */
export const OI_PRIO = 1_650;
const OI_LOG_EVERY_MS = 60 * 60_000;
/** A trade.xyz market whose terms are not read yet: the usual xyz market's (scale 1, growth mode). */
const XYZ_SCALE_UNKNOWN: MarketScale = { scale: 1, growth: true };
/** A beat's budget for `pending` changed accounts: the base, doubled from 10k waiting on. */
const liveBudget = (pending: number): number => (pending > 10_000 ? LIVE_BUDGET_MAX_MS : LIVE_BUDGET_MS);
export const LIQ_NOW_MS = 2 * 60_000;
export const LIQ_STEP_MS = 15 * 60_000;
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
/** The recording pass's slices: longer, as every hand-back waits out whatever else holds the loop. */
const RECORD_SLICE_MS = 150;


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
 * A book the live engine priced with a level the price has already crossed (a long at or above
 * its price, a short at or below): proof its figures are stale - a liquidation or a close the
 * stream missed, margin moved, fees, a transfer. Audit 2026-10-30: $29.7M of BTC longs on
 * Hyperliquid priced above the price, up to $226,960. Read again first, the most notional
 * first, unless it was read within CROSSED_MIN_AGE_MS (the venue itself may be liquidating it:
 * a crossed level just read is the venue's, not ours to chase in a loop).
 */
export const CROSSED_MIN_AGE_MS = 10 * 60_000;
export function crossedDue(bookAt: number | undefined, now: number): boolean {
  return bookAt === undefined || now - bookAt >= CROSSED_MIN_AGE_MS;
}
export function crossedPrio(usd: number): number {
  return 1_700 + Math.min(200, Math.max(0, Math.round(Math.log10(Math.max(1, usd)) * 20)));
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


/** What a fill of `d` at `px` realizes on the book's position: the part it closes, against the entry. */
export function realizedOf(book: Pick<Book, 'pos'>, symbol: string, d: number, px: number): number {
  const cur = book.pos.get(symbol);
  if (!cur || !cur.szi || cur.entry === null || !Number.isFinite(cur.entry) || Math.sign(cur.szi) === Math.sign(d)) return 0;
  return Math.min(Math.abs(d), Math.abs(cur.szi)) * (px - cur.entry) * Math.sign(cur.szi);
}


/** A print this much before a read was asked is in the read for certain (clocks: the venue's against ours). */
export const PRINT_SKEW_MS = 2_000;

/**
 * Whether a read already holds a print. SoDEX gives each position's last change (`ut`, BookRead): a print up to it is in the
 * read, a later one is not. A market flat in the read has no `ut`: a print well before the ask is in it, one well after the
 * answer is not, and between the two it cannot be told ('unknown'): the print is left out and the book is read again soon.
 */
export function printInRead(read: BookRead, symbol: string, t: number): boolean | 'unknown' {
  if (t < read.sent - PRINT_SKEW_MS) return true;
  const ut = read.ut.get(symbol);
  if (ut !== undefined) return t <= ut;
  return t > read.got + PRINT_SKEW_MS ? false : 'unknown';
}


/**
 * Whether a print still moves a book: not when the book's read already holds it (the print is
 * older than the read was asked, by PRINT_SKEW_MS), and not when it is a print this indexer
 * applied before a restart (`replayBefore`: the newest print time the saved books hold) - each
 * stream's first message per market after subscribing is a snapshot of recent prints, and the
 * dedup that drops it on a reconnect starts empty in a new process. Applied twice, a print grows a
 * position that was closed (Lighter, 2026-10-30: books 155-205% of the open interest).
 */
export function printApplies(book: { reqAt?: number }, t: number, replayBefore: number): boolean {
  // Not a time in ms (a venue that ever sent seconds): nothing to compare, applied as before.
  if (!(t > 1e11)) return true;
  if (t <= replayBefore) return false;
  if (book.reqAt !== undefined && t < book.reqAt - PRINT_SKEW_MS) return false;
  return true;
}

/** Which prints move which venue's books: spot never, and a HIP-3 market only its own dex's book. */
export function bookable(venue: Venue, symbol: string): boolean {
  if (symbol.includes('/') || symbol.startsWith('@')) return false;
  // SoDEX spot pairs (`vETH_vUSDC`) come down the same stream. Until 2026-11-06 they went into perps books as positions in the coin (62 in 14 books).
  if (venue === 'sodex') return !symbol.includes('_');
  if (venue === 'hyperliquid') return !symbol.includes(':');
  if (venue === 'tradexyz') return symbol.startsWith('xyz:');
  return true;
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
  /** A SoDEX book read on another thread (default: the tracker's own reader). */
  sodexState?: (address: string) => Promise<PositionRead>;
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
/**
 * The share of the cohort lane's spend portfolio reads are guaranteed while any
 * wait: a portfolio read is 20 weight against a position read's 2, so 40% is one
 * for every 15 position reads - at the lane's 400, 8 a minute, 11k a day.
 * Without it they waited behind a queue the plan refills every minute: two
 * written in the first 70 minutes after v0.2.13.
 */
export const PNL_SHARE = 0.4;
/** While more perp PnL reads than PNL_BACKLOG wait (the switch to perp PnL, 2026-10-28), they get this share. */
export const PNL_BACKLOG_SHARE = 0.7;
const PNL_BACKLOG = 1_000;
/** How often the due list is scanned again (it is handed out a minute at a time in between). */
const PNL_SCAN_MS = 5 * 60_000;
/** Meta keys: when perp PnL reads began, and the accounts' PnL flows since their reads (saved every PNL_FLOW_SAVE_MS). */
const PERP_SINCE_META = 'cohort_pnl_perp_since';
const PNL_FLOW_META = 'cohort_pnl_flow';
const PNL_FLOW_SAVE_MS = 5 * 60_000;
/** Changed flows written per transaction (saveFlows), the loop free between batches. */
const FLOW_SAVE_BATCH = 2_000;
/** Members written or dropped per transaction (saveMembers): 5,000 random inserts into the member table held the indexer 10-17 s (profiles 2026-11-08). */
const MEMBER_SAVE_BATCH = 1_000;
/** Set once every open position has been written with the extra fields (logLevels; the moves that log a level again: liqLiveCore.ts). */
const LIQ_LOG_FULL_META = 'liq_log_full_v2';
/**
 * Cohort reads in flight at once (lanes.ts CONCURRENCY). One at a time made ~20
 * a minute; 8 made ~46 (v0.2.16, 2026-10-24), still bound by the event loop's
 * stalls on the disk rather than by the 400 weight - a read waits out a stall
 * whatever else is in flight. The spend cap is the lane's either way.
 * VALUESCAN_INDEX_HLC_CONCURRENCY sets it (up to 128): the archive's ~80k unread holders
 * (2026-10-27) were read at ~22 a minute with 24 in flight against a loop 3-5 s late.
 */
export const HLC_CONCURRENCY = envNum('VALUESCAN_INDEX_HLC_CONCURRENCY', 24, 1, 128);

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
   * The live liquidation levels (valuedesk/liquidations/live.ts): every account
   * priced into its coins' buckets, re-priced when a print or a read moves its
   * book or another of its prices moves; streamed to the API (liqFeed.ts). On its
   * own thread (liqLiveThread.ts), which this one hands the books' changes to;
   * inline with VALUESCAN_LIQ_LIVE_THREAD=0 and in the tests.
   */
  readonly live: LiveLink = liveLink({
    source: {
      account: (venue, address) => {
        // A venue's own accounts are no level on the map (internalWallets.ts).
        if (isExcluded(venue, address)) return undefined;
        const b = this.books.get(venue)?.get(address);
        return b ? { cash: b.cash ?? null, priced: liqKnown(b), positions: [...b.pos].map(([symbol, p]) => ({ symbol, ...p })), equity: b.equity } : undefined;
      },
      priceOf: (venue, symbol) => this.marks.get(`${venue}|${symbol}`) ?? null,
      tiersOf: (venue, symbol) => marketsNow(venue)?.tiers.get(symbol) ?? null,
      priceOfCoin: (coin) => this.coinPx.get(coin)?.px ?? null,
      wanted: (coin) => this.sodexCoins.has(coin),
      extra: (venue, address, coin) => this.logExtra(venue, address, coin),
    },
    crossed: (venue, address, usd) => {
      const k = `${venue}|${address}`;
      if (this.crossed.size < CROSSED_MAX) this.crossed.set(k, Math.max(usd, this.crossed.get(k) ?? 0));
    },
    now: () => this.d.now(),
    breathe: () => this.breathe(),
    // Every book goes to the thread's copy (the cohort passes count them all); a venue's own accounts stay off the map there.
    book: (venue, address) => this.books.get(venue)?.get(address),
    noLive: (venue, address) => isExcluded(venue, address),
    allKeys: () => this.bookKeys(),
    allMarks: () => this.marks,
    allCoinPx: () => [...this.coinPx].map(([c, x]): [string, number] => [c, x.px]),
    wanted: () => this.sodexCoins,
    cohortState: () => this.cohortState(),
  });
  /**
   * The cohort passes (cohortCore.ts) on the heatmap thread, which holds a copy of every book already (2026-11-09: the
   * history step alone took 1,661 s of this thread after a restart, at 99.7% busy); VALUESCAN_COHORT_WORKER=0, the heatmap
   * inline, and the tests run them here on the books in place (`view`).
   */
  private readonly cohortThreaded = this.live.threaded && cohortWorkerOn();
  private readonly view: CohortView = {
    books: (v) => this.books.get(v) ?? new Map<string, Book>(),
    members: (v) => this.members.get(v),
    mark: (k) => this.marks.get(k),
    pnlAt: (a) => this.pnlRead?.get(a)?.at,
    seeds: (v) => this.seeds.get(v),
    readList: () => this.readList,
    sodexCoins: () => this.sodexCoins,
  };
  /** Inline: the members' last written signatures (threaded, the thread keeps them). */
  private readonly sigs = new MemberSigs();
  /** Per venue, the member set last written whole (a restarted thread takes its signatures from it). */
  private savedFrom = new Map<Venue, Map<string, Member>>();
  /** The status's counts, from the last full pass (cohortCore.ts planDue): archive holders and read-list wallets without a book. */
  private seedsUnread = new Map<Venue, number>();
  private readListUnread: number | null = null;
  /** Cohort passes the thread failed and this thread ran instead (status). */
  private cohortInline = 0;
  /** Per venue, the newest print time applied (saved with the books: PRINTS_THROUGH_META), and the one the saved books held at the start. */
  private printsThrough = new Map<Venue, number>();
  private replayBefore = new Map<Venue, number>();
  private printsSkipped = 0;
  /** The last open interest check (checkOi): per venue, the worst ratio and the coins over. */
  private oiLast: { at: number; venues: ReturnType<typeof oiStatus>; queued: number; staleOi: Venue[] } | null = null;
  /** venue|coin -> when its excess was last logged. */
  private oiLogged = new Map<string, number>();
  /** Books priced with a crossed level since the last beat (venue|address -> USD), read again first (liveTick). */
  private crossed = new Map<string, number>();
  /** Crossed books queued for a read since the start (status). */
  private crossedQueued = 0;
  /**
   * The coins the heatmap covers: every perp SoDEX lists (liqCoin of its symbols, so
   * Hyperliquid's kPEPE counts as 1000PEPE). The owner, 2026-10-25: maps for SoDEX's
   * coins only. A wallet's positions in other coins still count toward its margin.
   */
  private sodexCoins = new Set<string>();
  /** Hyperliquid spot pairs quoted in USDC (spotMeta), whose prints move a unified account's cash. */
  private spotUsdc = new Set<string>();
  /** Per account: is its perps margin its spot USDC (unified, portfolio margin) or not (classic). */
  private hlMode = new Map<string, 'unified' | 'classic'>();
  /** Spot cash an account traded while its mode was being asked. */
  private spotPending = new Map<string, number>();
  /** Per venue|address: the account's own fee rates once asked (feeRates.ts); traded since the last ask. */
  private feeRates = new Map<string, FeeRates>();
  private traded = new Map<string, number>();
  /** trade.xyz market -> its fee terms. */
  private xyzScale = new Map<string, MarketScale>();

  /** SoDEX's list, as its markets read gives it; books holding a coin new to it are priced in. */
  /** The spot pairs quoted in USDC, by the names the trades stream uses (`@107`, `PURR/USDC`). */
  private async loadSpotPairs(): Promise<void> {
    const meta = await hlInfo.post<{ universe?: Array<{ name?: string; tokens?: number[] }>; tokens?: Array<{ name?: string; index?: number }> } | null>(
      { type: 'spotMeta' }, { ttlMs: 6 * 60 * 60_000 },
    );
    const usdc = meta?.tokens?.find((t) => t.name === 'USDC')?.index;
    if (usdc === undefined) return;
    const next = new Set((meta?.universe ?? []).flatMap((u) => (u.name && u.tokens?.[1] === usdc ? [u.name] : [])));
    if (next.size) this.spotUsdc = next;
  }

  private refreshSodexCoins(): void {
    const tiers = marketsNow('sodex')?.tiers;
    if (!tiers?.size) return;
    const next = new Set([...tiers.keys()].map(liqCoin));
    const added = [...next].filter((c) => !this.sodexCoins.has(c));
    if (!added.length && next.size === this.sodexCoins.size) return;
    this.sodexCoins = next;
    const fresh = new Set(added);
    for (const v of VENUES) {
      for (const [a, b] of this.books.get(v) ?? []) {
        for (const sym of b.pos.keys()) if (fresh.has(liqCoin(sym))) { this.live.touch(v, a); break; }
      }
    }
  }

  /** Every book, as venue|address, in the books' order (a restarted heatmap thread is handed them all again). */
  private *bookKeys(): Iterable<string> {
    for (const v of VENUES) for (const a of this.books.get(v)?.keys() ?? []) yield `${v}|${a}`;
  }

  /** Everything the cohort passes read besides the books, for a new heatmap thread (sent before the books). */
  private cohortState(): CohortIn[] {
    if (!this.cohortThreaded) return [];
    const out: CohortIn[] = [];
    for (const [venue, members] of this.members) {
      out.push({ k: 'members', venue, w: encodeMembers(members) });
      const saved = this.savedFrom.get(venue);
      if (saved) out.push(saved === members ? { k: 'sigBase', venue } : { k: 'sigBase', venue, w: encodeMembers(saved) });
    }
    if (this.pnlRead) out.push(this.pnlAtAll());
    if (this.seeds.size) out.push(this.seedsIn());
    if (this.readList.length) out.push({ k: 'readList', a: this.readList });
    return out;
  }

  private pnlAtAll(): CohortIn {
    const a: string[] = [];
    const at: number[] = [];
    for (const [k, r] of this.pnlRead ?? []) { a.push(k); at.push(r.at); }
    return { k: 'pnlAt', a, at: Float64Array.from(at), all: true };
  }

  private seedsIn(): CohortIn {
    return { k: 'seeds', v: [...this.seeds].map(([v, m]): [Venue, string[], Float64Array] => [v, [...m.keys()], Float64Array.from(m.values())]) };
  }

  /** A PnL read noted (cohort_pnl): kept, and its time to the thread's copy. */
  private pnlDone(address: string, row: CohortPnlRow, at: number): void {
    this.pnls().set(address, { ...row, at });
    if (this.cohortThreaded) this.live.cohortIn({ k: 'pnlAt', a: [address], at: Float64Array.of(at) });
  }

  /**
   * A cohort pass: on the heatmap thread when it runs them, else `here` (the same function on the books in place). A pass
   * the thread fails (it died, hung, or is starting again) runs here instead: the figures go on being written.
   */
  private async pass<T>(ask: Parameters<LiveLink['cohort']>[0], here: () => Promise<T>): Promise<T> {
    if (!this.cohortThreaded) return here();
    try {
      return (await this.live.cohort(ask)) as T;
    } catch (e) {
      this.cohortInline++;
      this.lastError = `cohort ${ask.op} on the heatmap thread: ${String((e as Error)?.message ?? e)} - ran here`;
      return here();
    }
  }
  /** What the boards lane lends the rebuild now. */
  private lent = 0;
  /** SoDEX perps state reads, requests / minute (weight 5 each). */
  readonly scoh: Lane;
  /** The reader thread behind `scoh`'s reads: on this thread a read took 4-15 s while prints went on arriving. */
  private stateReader: RestReader | null = null;
  /**
   * SoDEX books being read: every print of theirs since the read was asked. A read replaces the book, and a print that came
   * in meanwhile went with the old one if SoDEX's answer predates it. Measured 2026-11-06 on two wallets read minutes
   * before: the book was off by exactly the print 5 s and 7 s before the read ended, and 95 of 245 positions settled
   * for 30 s on 44 books read in the 20 minutes before were off.
   */
  private flying = new Map<string, Array<{ p: Print; d: number }>>();
  private books = new Map<Venue, Map<string, Book>>();
  private marks = new Map<string, number>();
  private dirtyBooks = new Set<string>();
  private dirtyMarks = new Set<string>();
  private members = new Map<Venue, Map<string, Member>>();
  /** Per venue, the addresses its member table holds (read once, then kept with each save). */
  private savedMembers = new Map<Venue, Set<string>>();
  /** Wallets a stream saw trade that have no book yet. */
  private wanted = new Map<string, number>();
  /** Hyperliquid holders' PnL from their portfolio (cohort_pnl), loaded at the first plan. */
  private pnlRead: Map<string, CohortPnlRow & { at: number }> | null = null;
  /**
   * When perp PnL reads began (meta PERP_SINCE_META): a cohort_pnl row older holds the whole
   * account's PnL, spot included - provisional until read again.
   */
  private perpSince = 0;
  /**
   * Per Hyperliquid account since its perp PnL read: what its fills realized less fees and
   * funding (`flow`), and its unrealized PnL at the read (`u0`). Its all-time PnL now is the
   * read's + flow + (unrealized now - u0): current between reads, transfers left out as PnL does.
   */
  private pnlFlow = new Map<string, { flow: number; u0: number }>();
  /** Perp PnL reads still due (planPnl): their share of the lane rises while many wait. */
  private pnlDue = 0;
  /** The due list (scanPnlDue), the next entry to hand out, and when it was scanned. */
  private pnlDueList: DueList | null = null;
  private pnlDueNext = 0;
  private pnlDueAt = 0;
  /** When the change log was last pruned (its state lives with the engine: liqLiveCore.ts). */
  private levelPrunedAt = 0;
  /** Rows the last step wrote. */
  private levelRows = 0;
  /** Perp PnL rows taken from the backfill's drops (importPnlDrops). */
  private pnlImported = 0;
  private span = new Map<Venue, number | null>();
  /** Per venue, its last full pass (planVenues) and how many of the reads it found due did not fit the queue. */
  private plannedAt = new Map<Venue, number>();
  private dueLeft = new Map<Venue, number>();
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
  /** A 15-minute step's writes are in flight (writeLiqStep): the next step waits, the heatmap rows do not. */
  private liqStepWriting = false;
  private liqStepMs = 0;
  private lastNowAt = 0;
  /** How long the last liquidation pass took (status). */
  private liqMs = 0;
  /** When this tracker started (books read before it without liquidation data are read once more). */
  private startedAt = 0;
  /** Holders the Hyperliquid fills archive found (archiveSeed.ts): read once each, the largest first. */
  private seeds: Seeds = new Map();
  private seedsAt: number | null = null;
  /** Hyperliquid wallets to read once, without positions (archiveSeed.ts loadReadList), at READ_LIST_PRIO. */
  private readList: string[] = [];
  /** How long Hyperliquid's stream was down across this start (its `stream_up`); Infinity = never up before. */
  private downAtStart = Number.POSITIVE_INFINITY;
  /** The hour's funding rates, taken in its last minutes and applied when it ends (fundingTick). */
  private fundingNext: { end: number; rates: Map<Venue, Map<string, { rate: number; px: number }>> } | null = null;
  private fundingLast: { end: number; books: number; paid: number; error?: string } | null = null;
  private planMs = 0;
  private recordMs = 0;
  lastError: string | null = null;
  private booksLoading = false;
  private stopped = false;
  private earlyPrints: Array<[Print, (acct: string) => string | null]> = [];

  constructor(private readonly d: CohortDeps) {
    setRulesPacers({ lighter: d.lighter.pacer, arcus: d.arcus.pacer });
    this.scoh = new Lane({ name: 'scoh', perMin: envNum('VALUESCAN_INDEX_SODEX_COHORT', 20, 1, 60), gate: d.sodexGate, rateLimitPauseMs: 15 * 60_000, creditTaskTime: true });
  }

  start(): void {
    const s = this.d.store;
    const now = this.d.now();
    this.startedAt = now;
    for (const v of VENUES) {
      this.books.set(v, new Map<string, Book>());
      // Whatever traded while the indexer was down is unknown: large books are re-read.
      // Read here, before the load: the engine's flush moves stream_up on while the books come in.
      if (STREAMED.has(v)) {
        this.gapAt.set(v, now);
        // How long the stream was down across this restart (the engine keeps `stream_up`).
        const lastUp = Number(s.getMeta(`stream_up:${v}`)) || 0;
        if (v === 'hyperliquid') this.downAtStart = lastUp > 0 ? now - lastUp : Number.POSITIVE_INFINITY;
        this.gapFloor.set(v, gapRereadFloor(lastUp > 0 ? now - lastUp : Number.POSITIVE_INFINITY));
      }
    }
    // The books a page at a time: ~300k read in one go held the thread 107 s at each start (2026-11-05 16:03:51 to
    // 16:05:38), while the streams' sockets waited to open. The gap in the prints was 136 s, over the 120 s a stream
    // may be away and still count as continuous, and most of it was this.
    this.booksLoading = true;
    let v = 0;
    let after = '';
    readInSlices({
      budgetMs: BOOKS_LOAD_SLICE_MS,
      stopped: () => this.stopped,
      page: () => {
        for (; v < VENUES.length; v++, after = '') {
          const venue = VENUES[v]!;
          const rows = s.cohortBooksPage(venue, after, BOOKS_LOAD_PAGE);
          if (!rows.length) continue;
          const m = this.books.get(venue)!;
          for (const [a, b] of rows) {
            const held = b.positions.filter((p) => bookable(venue, p.symbol));
            m.set(a, {
              equity: b.equity, at: b.at, collateral: b.collateral, spotAt: b.spotAt, cash: b.cash,
              pos: new Map(held.map(({ symbol, ...p }) => [symbol, p])),
            });
            if (held.length !== b.positions.length) this.dirtyBooks.add(`${venue}|${a}`);
          }
          after = rows[rows.length - 1]![0];
          return rows.length;
        }
        return 0;
      },
      done: () => {
        this.booksLoading = false;
        this.startRest(now);
      },
      onError: (e) => {
        // Not started on half the books: the process restarts and reads them again.
        console.error('[indexer] cohort books could not be read:', e);
        process.exitCode = 1;
        throw e;
      },
    });
  }

  private startRest(now: number): void {
    const s = this.d.store;
    for (const [k, px] of s.cohortMarks()) { this.marks.set(k, px); this.live.price(k, px); this.noteCoinPx(k, px); }
    // Prints the saved books already hold: a stream's snapshot of recent prints after this start
    // must not apply them again (printApplies).
    try {
      const saved = JSON.parse(s.getMeta(PRINTS_THROUGH_META) ?? '{}') as Record<string, number>;
      for (const v of VENUES) if (Number(saved[v]) > 0) { this.replayBefore.set(v, Number(saved[v])); this.printsThrough.set(v, Number(saved[v])); }
    } catch { /* none saved: as before */ }
    this.lastSeriesT = s.cohortSeriesLastT();
    this.lastMixT = s.cohortMixLastT();
    this.lastLiqT = s.liqHistLastT();
    for (const v of VENUES) void venueMarkets(v).catch(() => null);
    try {
      const saved = JSON.parse(s.getMeta(LIQ_ACC_META) ?? '{}') as Record<string, { cur: DriftStats; prev: DriftStats | null }>;
      for (const v of VENUES) if (saved[v]?.cur) this.liqAcc.set(v, saved[v]!);
    } catch { /* starts afresh */ }
    // Perp PnL: since when the reads hold it (first start of this code: now), and each account's
    // flow since its read as last saved. Prints missed while down are not in a flow: after an
    // outage the accounts that hold the most are read again first (planPnl).
    this.perpSince = Number(s.getMeta(PERP_SINCE_META)) || 0;
    if (!this.perpSince) { this.perpSince = now; s.setMeta(PERP_SINCE_META, String(now)); }
    try {
      const rows = s.pnlFlowRows();
      for (const r of rows) if (Number.isFinite(r.flow) && Number.isFinite(r.u0)) this.pnlFlow.set(r.address, { flow: r.flow, u0: r.u0 });
      if (!rows.length) {
        // Before the table (2026-11-08): the whole map as one meta value; carried over by the next save.
        const saved = JSON.parse(s.getMeta(PNL_FLOW_META) ?? '{}') as Record<string, [number, number]>;
        for (const [a, [flow, u0]] of Object.entries(saved)) {
          if (Number.isFinite(flow) && Number.isFinite(u0)) { this.pnlFlow.set(a, { flow, u0 }); this.flowDirty.add(a); }
        }
      }
    } catch { /* starts afresh: the PnL stands as read until the next read */ }
    void loadSeeds().then((r) => {
      this.seeds = r.seeds;
      this.seedsAt = r.at;
      if (this.cohortThreaded) this.live.cohortIn(this.seedsIn());
    }).catch((e) => (this.lastError = `archive seeds: ${String(e)}`));
    void loadReadList().then((r) => {
      this.readList = r;
      if (this.cohortThreaded) this.live.cohortIn({ k: 'readList', a: r });
    }).catch((e) => (this.lastError = `archive read list: ${String(e)}`));
    this.hlc.start();
    this.hlh.start();
    this.scoh.start();
    const every = (ms: number, fn: () => Promise<void> | void, name: string) => {
      const t = setInterval(() => within(name, () => { void Promise.resolve(fn()).catch((e) => (this.lastError = String(e))); }), ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(PLAN_MS, () => this.plan(), 'coh:plan');
    every(FLUSH_MS, () => this.flush(), 'coh:flush');
    every(60_000, () => this.record(), 'coh:record');
    every(60_000, () => this.recordLiq(), 'coh:liq');
    every(30_000, () => this.fundingTick(), 'coh:funding');
    every(6 * 60 * 60_000, () => this.loadSpotPairs(), 'coh:spot');
    every(60 * 60_000, () => this.loadXyzScales(), 'coh:xyzfees');
    every(PNL_FLOW_SAVE_MS, () => this.saveFlows(), 'coh:pnlflow');
    every(OI_CHECK_MS, () => this.checkOi(), 'coh:oi');
    void this.loadXyzScales().catch((e) => (this.lastError = `xyz fee terms: ${String(e)}`));
    void this.loadSpotPairs().catch((e) => (this.lastError = `spot pairs: ${String(e)}`));
    // The live engine: every book in at the start (priced a few thousand a second), then what changes. The empty ones go to
    // the heatmap thread's copy too (the cohort passes count them), in the books' order.
    for (const v of VENUES) for (const [a, b] of this.books.get(v) ?? []) { if (b.pos.size) this.live.touch(v, a); else this.live.changed(v, a); }
    this.live.start();
    every(LIVE_TICK_MS, () => this.liveTick(), 'coh:live');
    const first = setTimeout(() => void this.plan().catch((e) => (this.lastError = String(e))), 15_000);
    first.unref?.();
    this.timers.push(first);
    // What the streams brought while the books came in, in the order it came.
    const early = this.earlyPrints;
    this.earlyPrints = [];
    let i = 0;
    readInSlices({
      budgetMs: BOOKS_LOAD_SLICE_MS,
      stopped: () => this.stopped,
      page: () => {
        const end = Math.min(i + 2_000, early.length);
        const n = end - i;
        for (; i < end; i++) this.onPrint(early[i]![0], early[i]![1]);
        return n;
      },
      done: () => {},
      onError: (e) => { this.lastError = `early prints: ${String(e)}`; },
    });
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    // Stopped while the books came in: nothing was changed, and half of them must not be written back.
    if (this.booksLoading) return;
    this.hlc.stop();
    this.hlh.stop();
    this.lend(0);
    this.scoh.stop();
    this.stateReader?.stop();
    void this.live.stop();
    this.flush();
    this.saveFlowsNow();
  }

  /** Accounts whose flow moved, started or ended since the last save. */
  private flowDirty = new Set<string>();
  private flowSaving = false;

  /** The next batch of changed flows as rows, and the accounts whose flow ended (taken out of flowDirty). */
  private takeFlows(max: number): { rows: Array<[string, number, number]>; gone: string[] } {
    const rows: Array<[string, number, number]> = [];
    const gone: string[] = [];
    for (const a of this.flowDirty) {
      if (rows.length + gone.length >= max) break;
      this.flowDirty.delete(a);
      const f = this.pnlFlow.get(a);
      if (f) rows.push([a, Math.round(f.flow * 100) / 100, Math.round(f.u0 * 100) / 100]);
      else gone.push(a);
    }
    return { rows, gone };
  }

  /**
   * The changed PnL flows to the index in batches of FLOW_SAVE_BATCH, the loop free between them (they survive a
   * restart; a batch that fails goes back to flowDirty for the next save).
   */
  private async saveFlows(): Promise<void> {
    if (this.flowSaving) return;
    this.flowSaving = true;
    try {
      while (this.flowDirty.size) {
        const { rows, gone } = this.takeFlows(FLOW_SAVE_BATCH);
        try {
          this.d.store.putPnlFlows(rows, gone);
        } catch (e) {
          for (const [a] of rows) this.flowDirty.add(a);
          for (const a of gone) this.flowDirty.add(a);
          this.lastError = `pnl flows: ${String(e)}`;
          return;
        }
        await new Promise<void>((ok) => setImmediate(ok));
      }
    } finally {
      this.flowSaving = false;
    }
  }

  /** At stop: every changed flow at once. */
  private saveFlowsNow(): void {
    try {
      while (this.flowDirty.size) {
        const { rows, gone } = this.takeFlows(FLOW_SAVE_BATCH * 10);
        this.d.store.putPnlFlows(rows, gone);
      }
    } catch (e) {
      this.lastError = `pnl flows: ${String(e)}`;
    }
  }

  /** A book's unrealized PnL at the marks the index holds (a position without a mark or an entry adds nothing). */
  private unrealized(venue: Venue, book: Book): number {
    let u = 0;
    for (const [symbol, p] of book.pos) {
      const px = this.marks.get(`${venue}|${symbol}`);
      if (px === undefined || p.entry === null || !Number.isFinite(p.entry)) continue;
      u += p.szi * (px - p.entry);
    }
    return u;
  }

  /**
   * The portfolio reads' share of the cohort lane: cut while the liquidation backlog takes the
   * reads, raised while many perp PnL reads wait (the switch: ~120k holders, 20 weight each).
   */
  private pnlShare(): void {
    this.hlc.setShare('cohpnl:', this.liqBoost ? LIQ_BOOST_PNL_SHARE : this.pnlDue > PNL_BACKLOG ? PNL_BACKLOG_SHARE : PNL_SHARE);
  }

  /** A Hyperliquid account's flow since its perp PnL read moves by `x` (none before its first read). */
  private addFlow(address: string, x: number): void {
    const f = this.pnlFlow.get(address);
    if (f && Number.isFinite(x)) { f.flow += x; this.flowDirty.add(address); }
  }

  // --- the streams ----------------------------------------------------------------------

  /** Every print: a price, and each party's book moved (or queued for its first read). */
  onPrint(p: Print, addressOf: (acct: string) => string | null): void {
    if (this.booksLoading) {
      if (this.earlyPrints.length < EARLY_PRINTS_MAX) this.earlyPrints.push([p, addressOf]);
      return;
    }
    if (p.venue === 'hyperliquid' && (p.symbol.startsWith('@') || p.symbol.includes('/'))) { this.onSpotPrint(p); return; }
    if (!bookable(p.venue, p.symbol)) return;
    const mk = `${p.venue}|${p.symbol}`;
    this.marks.set(mk, p.px);
    this.noteCoinPx(mk, p.px);
    this.live.mark(p.venue, p.symbol, p.px);
    this.dirtyMarks.add(mk);
    const books = this.books.get(p.venue);
    if (!books) return;
    if (p.t > (this.printsThrough.get(p.venue) ?? 0)) this.printsThrough.set(p.venue, p.t);
    for (const [acct, d] of [[p.buyer, p.sz], [p.seller, -p.sz]] as const) {
      const address = addressOf(acct);
      if (!address) continue;
      // Whatever the book holds now, a read under way decides afresh (settleFlying).
      this.flying.get(`${p.venue}|${address}`)?.push({ p, d });
      const book = books.get(address);
      if (!book) {
        const k = `${p.venue}|${address}`;
        if (!this.wanted.has(k)) this.wanted.set(k, this.d.now());
        continue;
      }
      if (!printApplies(book, p.t, this.replayBefore.get(p.venue) ?? 0)) { this.printsSkipped++; continue; }
      if (book.read) {
        const inRead = printInRead(book.read, p.symbol, p.t);
        if (inRead !== false) {
          this.printsSkipped++;
          if (inRead === 'unknown') { book.opened = true; this.live.changed(p.venue, address); }
          continue;
        }
      }
      this.moveBook(p, address, book, d);
    }
    if (this.wanted.size > 100_000) this.wanted.clear();
  }

  private moveBook(p: Print, address: string, book: Book, d: number): void {
    if (!book.pos.has(p.symbol) && OPENED_REREAD.has(p.venue)) book.opened = true;
    const fee = this.fillFee(p, address, d > 0);
    if (p.venue === 'hyperliquid') this.addFlow(address, realizedOf(book, p.symbol, d, p.px) - fee);
    feeCash(book, p.symbol, fee);
    applyFill(book, p.symbol, d, p.px);
    book.filledAt = this.d.now();
    this.live.touch(p.venue, address);
    this.dirtyBooks.add(`${p.venue}|${address}`);
    this.applied++;
  }

  /** The prints that came in during a read and are not in it go onto the new book, in the order they came. */
  private settleFlying(key: string, venue: Venue, address: string, book: Book): void {
    const list = this.flying.get(key) ?? [];
    this.flying.delete(key);
    const read = book.read;
    if (!read) return;
    for (const { p, d } of list) {
      if (p.t <= (this.replayBefore.get(venue) ?? 0)) { this.printsSkipped++; continue; }
      const inRead = printInRead(read, p.symbol, p.t);
      if (inRead === false) this.moveBook(p, address, book, d);
      else {
        this.printsSkipped++;
        if (inRead === 'unknown') { book.opened = true; this.live.changed(venue, address); }
      }
    }
  }

  /** A SoDEX book on the reader thread: no turn of this thread is in the read, and it knows what it holds to the millisecond. */
  private async readSodexState(address: string): Promise<PositionRead> {
    if (this.d.sodexState) return this.d.sodexState(address);
    const reader = this.stateReader ?? (this.stateReader = new RestReader());
    const { status, data, sentAt, gotAt } = await reader.get(`/api/v1/perps/accounts/${address}/state`);
    chargeGatewayWeight(STATE_WEIGHT);
    if (status !== 200) throw Object.assign(new Error(`SoDEX state: HTTP ${status}`), { status });
    // No account answers `aid: 0`. An answer with no state at all says nothing, and must not empty the book.
    if (data === null || typeof data !== 'object') throw new Error('SoDEX state: no state in the answer');
    const now = this.d.now();
    return sodexPositionsOf(data as PerpsState | null, { sent: sentAt ?? now, got: gotAt ?? now });
  }

  /**
   * A Hyperliquid spot print. In a unified (or portfolio-margin) account the perps' margin IS the
   * spot USDC, so a spot trade quoted in USDC moves the cross cash: the buyer pays size x price,
   * the seller receives it less its fee. In a classic account it does not. Skipped until
   * 2026-10-28, it was most of the drift between reads: of 17 sampled books more than 0.1% off,
   * 12 had no perp fill and no transfer since their read. Which mode an account is in is asked
   * once, only for an account that trades spot; what it traded meanwhile waits for the answer.
   */
  private onSpotPrint(p: Print): void {
    if (!this.spotUsdc.has(p.symbol)) return;
    const books = this.books.get('hyperliquid');
    if (!books) return;
    const ntl = p.sz * p.px;
    for (const [address, buys] of [[p.buyer, true], [p.seller, false]] as const) {
      const book = books.get(address);
      if (!book || book.cash == null) continue;
      const fee = buys || !p.taker ? 0 : ntl * spotSellRate(this.feeRates.get(`hyperliquid|${address}`) ?? BASE_FEES.hyperliquid, p.taker === 'seller');
      const delta = buys ? -ntl : ntl - fee;
      const mode = this.hlMode.get(address);
      if (mode === 'classic') continue;
      if (mode === 'unified') { this.spotCash(address, book, delta); continue; }
      this.spotPending.set(address, (this.spotPending.get(address) ?? 0) + delta);
      this.askMode(address);
    }
  }

  /**
   * What one side of a print paid (USD): the trade's own figure where it has one (Lighter), else
   * the account's rate for its role (feeRates.ts) - asked of the venue once it trades enough -
   * else the venue's base tier. trade.xyz is a Hyperliquid account's: its rates, the market's scale.
   */
  private fillFee(p: Print, address: string, buys: boolean): number {
    if (p.fee) return buys ? p.fee.buyer : p.fee.seller;
    if (!p.taker) return 0;
    const ntl = p.sz * p.px;
    const acct: Venue = p.venue === 'tradexyz' ? 'hyperliquid' : p.venue;
    const r = this.feeRates.get(`${acct}|${address}`) ?? BASE_FEES[p.venue];
    this.noteTraded(acct, address, ntl);
    return ntl * fillRate(r, (p.taker === 'buyer') === buys, p.venue === 'tradexyz' ? this.xyzScale.get(p.symbol) ?? XYZ_SCALE_UNKNOWN : null);
  }

  /** An account that traded ASK_MIN_USD since its rates were last asked (a day ago at least) is asked again. */
  private noteTraded(acct: Venue, address: string, ntl: number): void {
    const min = ASK_MIN_USD[acct];
    if (!min) return;
    const key = `${acct}|${address}`;
    const t = (this.traded.get(key) ?? 0) + ntl;
    const r = this.feeRates.get(key);
    if (t < min || (r && this.d.now() - r.at < FEES_TTL_MS)) {
      if (this.traded.size > TRADED_MAX) this.traded.clear();
      this.traded.set(key, t);
      return;
    }
    this.traded.delete(key);
    const lane = acct === 'sodex' ? this.scoh : acct === 'arcus' ? this.d.arcus.lane : this.hlc;
    const k = `cohfee:${key}`;
    if (lane.has(k)) return;
    lane.add({
      key: k,
      prio: MODE_PRIO,
      run: async () => {
        const now = this.d.now();
        const got = acct === 'sodex' ? await sodexFees(address, now)
          : acct === 'arcus' ? await arcusFees(address, now, this.d.arcus.pacer)
            : await hlFees(address, now);
        if (got) {
          if (this.feeRates.size > TRADED_MAX) this.feeRates.clear();
          this.feeRates.set(key, got);
        }
        return acct === 'sodex' ? SODEX_FEES_COST : acct === 'arcus' ? ARCUS_FEES_COST : HL_FEES_COST;
      },
    });
  }

  /** trade.xyz's markets' fee terms (deployerFeeScale, growth mode). */
  private async loadXyzScales(): Promise<void> {
    const m = await xyzScales();
    if (m.size) this.xyzScale = m;
  }

  private spotCash(address: string, book: Book, delta: number): void {
    if (book.cash == null || !delta) return;
    book.cash += delta;
    if (book.equity != null) book.equity += delta;
    this.live.touch('hyperliquid', address);
    this.dirtyBooks.add(`hyperliquid|${address}`);
  }

  /** Asks Hyperliquid whether the account's perps margin is its spot USDC (once; kept for the process). */
  private askMode(address: string): void {
    const key = `cohmode:${address}`;
    if (this.hlc.has(key) || this.hlMode.size > HL_MODE_MAX) return;
    this.hlc.add({
      key,
      prio: MODE_PRIO,
      run: async () => {
        const r = await hlInfo.post<string | null>({ type: 'userAbstraction', user: address }, { ttlMs: 0 });
        const mode = r === 'unifiedAccount' || r === 'portfolioMargin' ? 'unified' : 'classic';
        this.hlMode.set(address, mode);
        const pending = this.spotPending.get(address) ?? 0;
        this.spotPending.delete(address);
        const book = this.books.get('hyperliquid')?.get(address);
        if (mode === 'unified' && book) this.spotCash(address, book, pending);
        return MODE_READ_COST;
      },
    });
  }

  /**
   * Read by the 30 s status publish and the minute's log line: no pass over the books or the archive's lists here (the
   * unread counts over ~100k holders and the read list held this thread 1.5-3.5% of a profile, 2026-11-08) - they come
   * from the last full pass (planDue), null before it.
   */
  status(): Record<string, unknown> {
    const live = this.live.status();
    return {
      members: Object.fromEntries(VENUES.map((v) => [v, this.members.get(v)?.size ?? 0])),
      books: Object.fromEntries(VENUES.map((v) => [v, this.books.get(v)?.size ?? 0])),
      waiting: this.wanted.size,
      printsApplied: this.applied,
      planMs: this.planMs,
      recordMs: this.recordMs,
      liqMs: this.liqMs,
      printsSkipped: this.printsSkipped,
      liq: { crossedQueued: this.crossedQueued, oi: this.oiLast, boost: this.liqBoost, due: Object.fromEntries(this.liqDue), live, nowAt: this.lastNowAt || null, since: this.startedAt },
      thread: { cohorts: this.cohortThreaded, ranHere: this.cohortInline },
      hlc: { queued: this.hlc.size, done: this.hlc.done, failed: this.hlc.failed, lastError: this.hlc.lastError },
      pnl: { perpSince: this.perpSince, due: this.pnlDue, flows: this.pnlFlow.size, imported: this.pnlImported },
      levels: { open: live.levels, lastRows: this.levelRows },
      scoh: { queued: this.scoh.size, done: this.scoh.done, failed: this.scoh.failed, lastError: this.scoh.lastError },
      hlh: { queued: this.hlh.size, done: this.hlh.done, failed: this.hlh.failed, lastError: this.hlh.lastError, lent: this.lent },
      staleBefore: this.staleBefore,
      funding: this.fundingLast,
      seeds: { at: this.seedsAt, ...Object.fromEntries([...this.seeds].map(([v, m]) => [v, { wallets: m.size, unread: this.seedsUnread.get(v) ?? null }])) },
      readList: { wallets: this.readList.length, unread: this.readListUnread },
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
      if (m.ranked) cur.ranked = true;
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
            pnl: Number.isNaN(p) ? null : p, equity: Number.isNaN(av) ? null : av, label: labels[i] ?? null, ranked: !Number.isNaN(av),
            pnlRange: { '1d': num(d1?.[i]), '7d': num(d7?.[i]), '30d': num(d30?.[i]) },
          });
        }
      }
    } else {
      for (const [a, p] of s.pnlAll(venue)) put(a, { pnl: p });
      for (const [a, v] of s.accountValues(venue)) put(a, { equity: v });
      if (venue === 'tradexyz' || venue === 'arcus') {
        for (const a of await activeAccountsAsync(s, venue, { day: dayOf(this.d.now() - 30 * DAY_MS) }, 1, 50_000)) put(a.acct, {});
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
    // A read values the wallet too (and on a venue with a stream, is the fresher figure). A slice at a time: ~300k books.
    let t0 = Date.now();
    for (const [a, b] of this.books.get(venue) ?? []) {
      if (Date.now() - t0 > SLICE_MS) {
        await new Promise<void>((r) => setImmediate(r));
        mark('coh:plan');
        t0 = Date.now();
      }
      if (venue === 'hyperliquid' && out.get(a)?.equity != null) continue;
      put(a, { equity: b.equity });
    }
    // Perp PnL: a read since the switch (perpSince) decides the PnL cohort - the leaderboard's
    // figure is the whole account's, spot included - kept current by the account's flow since
    // the read (pnlFlow). A row from before the switch, or the leaderboard's figure, stands
    // only until the account is read (provisional: largest first, planPnl).
    if (venue === 'hyperliquid') {
      const books = this.books.get('hyperliquid');
      for (const [a, r] of this.pnls()) {
        const cur = out.get(a);
        if (!cur || r.pnl == null) continue;
        const perp = r.at >= this.perpSince;
        if (!perp && cur.pnl != null) continue;
        const f = perp ? this.pnlFlow.get(a) : undefined;
        const b = books?.get(a);
        cur.pnl = r.pnl + (f ? f.flow + (b ? this.unrealized('hyperliquid', b) : 0) - f.u0 : 0);
        cur.pnlRange = { '1d': r.pnl1d, '7d': r.pnl7d, '30d': r.pnl30d };
      }
    }
    return out;
  }

  private pnls(): Map<string, CohortPnlRow & { at: number }> {
    if (!this.pnlRead) {
      this.pnlRead = this.d.store.cohortPnl('hyperliquid');
      if (this.cohortThreaded) this.live.cohortIn(this.pnlAtAll());
    }
    return this.pnlRead;
  }

  /**
   * Portfolio reads for Hyperliquid holders the leaderboard does not rank (its
   * file has ~47k accounts; the books hold positions for far more): without an
   * all-time PnL a holder is in a size cohort but in no PnL cohort. Largest
   * first; each read again after pnlTtl.
   */
  /**
   * Perp PnL reads made elsewhere (the one-off backfill on the second server, at its own
   * Hyperliquid budget: deploy/release/pnl-backfill.mjs), dropped as JSON lines into
   * `pnl-import/` beside the index: {address, pnl, pnl1d, pnl7d, pnl30d, at}. A row is taken as
   * a read of its own (`at`, perp figures) - not over a newer read here - and its file removed.
   */
  private importPnlDrops(): void {
    const dir = join(dirname(defaultDbPath()), 'pnl-import');
    let files: string[];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return; }
    const done = this.pnls();
    const books = this.books.get('hyperliquid');
    const isNum = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));
    for (const f of files.slice(0, 20)) {
      const path = join(dir, f);
      let n = 0;
      try {
        const byAt = new Map<number, CohortPnlRow[]>();
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          let r: Record<string, unknown>;
          try { r = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          const address = typeof r.address === 'string' ? r.address.toLowerCase() : '';
          const at = Number(r.at);
          if (!/^0x[0-9a-f]{40}$/.test(address) || !(at >= this.perpSince) || at > this.d.now() + 60_000) continue;
          if (!isNum(r.pnl) || !isNum(r.pnl1d) || !isNum(r.pnl7d) || !isNum(r.pnl30d)) continue;
          if ((done.get(address)?.at ?? 0) >= at) continue;
          const row: CohortPnlRow = { address, pnl: r.pnl, pnl1d: r.pnl1d, pnl7d: r.pnl7d, pnl30d: r.pnl30d };
          const t = Math.floor(at / 60_000) * 60_000;
          byAt.set(t, [...(byAt.get(t) ?? []), row]);
        }
        for (const [at, rows] of byAt) {
          this.d.store.putCohortPnl('hyperliquid', rows, at);
          for (const row of rows) {
            this.pnlDone(row.address, row, at);
            const b = books?.get(row.address);
            if (row.pnl != null) { this.pnlFlow.set(row.address, { flow: 0, u0: b ? this.unrealized('hyperliquid', b) : 0 }); this.flowDirty.add(row.address); }
            n++;
          }
        }
        unlinkSync(path);
        this.pnlImported += n;
      } catch (e) {
        this.lastError = `pnl import ${f}: ${String(e)}`;
      }
    }
  }

  /** Let timers and sockets run between two slices of a plan (busy.ts names the stall's starter). */
  private async breathePlan(): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
    mark('coh:plan');
  }

  /** A venue's members for the heatmap thread, a slice at a time (~400k Hyperliquid members). */
  private async membersWire(members: ReadonlyMap<string, Member>): Promise<MembersWire> {
    const e = new MembersEncoder();
    let t0 = Date.now();
    for (const [a, m] of members) {
      e.add(a, m);
      if (Date.now() - t0 > SLICE_MS) { await this.breathePlan(); t0 = Date.now(); }
    }
    return e.take();
  }

  private async planPnl(now: number): Promise<void> {
    this.importPnlDrops();
    const lane = this.hlc;
    if (lane.countPrefix('cohpnl:') >= PNL_QUEUE_CAP) return;
    const done = this.pnls();
    // The holders due, largest first (cohortCore.ts pnlScan): scanned every PNL_SCAN_MS (a pass over ~300k books, 9% of
    // the thread when it ran every minute - 2026-10-28; on the heatmap thread since 2026-11-09), handed out from the list in between.
    if (!this.pnlDueList || now - this.pnlDueAt >= PNL_SCAN_MS || this.pnlDueList.a.length - this.pnlDueNext < PNL_QUEUE_CAP) {
      const ask = { now, perpSince: this.perpSince, outage: this.downAtStart >= OUTAGE_GAP_MS, startedAt: this.startedAt };
      this.pnlDueList = await this.pass<DueList>({ op: 'pnl', ask }, () => pnlScan(this.view, ask, () => this.breathePlan(), SLICE_MS));
      this.pnlDueNext = 0;
      this.pnlDueAt = now;
    }
    const list = this.pnlDueList;
    this.pnlDue = list.a.length - this.pnlDueNext;
    this.pnlShare();
    const queued = lane.countPrefix('cohpnl:');
    const take: Array<[string, number]> = [];
    while (take.length < PNL_QUEUE_CAP - queued && this.pnlDueNext < list.a.length) {
      const i = this.pnlDueNext++;
      const address = list.a[i]!;
      const read = done.get(address);
      // Read meanwhile (the backfill's drops, a read here): not again.
      if (read && read.at >= this.perpSince && read.at >= this.pnlDueAt) continue;
      if (!lane.has(`cohpnl:${address}`)) take.push([address, list.p[i]!]);
    }
    for (const [address, prio] of take) {
      lane.add({
        key: `cohpnl:${address}`,
        prio,
        run: async () => {
          const r = await hlPortfolioPnl(address);
          const at = this.d.now();
          const row: CohortPnlRow = r ?? { address, pnl: null, pnl1d: null, pnl7d: null, pnl30d: null };
          this.d.store.putCohortPnl('hyperliquid', [row], at);
          this.pnlDone(address, row, at);
          // The flow starts over from this read, at the unrealized PnL the book holds now.
          const book = this.books.get('hyperliquid')?.get(address);
          if (row.pnl != null) this.pnlFlow.set(address, { flow: 0, u0: book ? this.unrealized('hyperliquid', book) : 0 });
          else this.pnlFlow.delete(address);
          this.flowDirty.add(address);
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

  /**
   * Changed members to the table the API thread reads, a slice at a time. Which changed (cohortCore.ts MemberSigs) is worked
   * out on the heatmap thread when it runs the passes: a signature built for each of ~400k members held this thread
   * every Hyperliquid pass. A pass the thread fails writes nothing: the next pass writes what changed since the last
   * set written whole (savedFrom, handed to a restarted thread).
   */
  private async saveMembers(venue: Venue, members: Map<string, Member>): Promise<void> {
    let changed: CohortMemberRow[];
    if (this.cohortThreaded) {
      try {
        changed = decodeRows(await this.live.cohort({ op: 'members', venue, w: await this.membersWire(members) }) as MembersWire);
      } catch (e) {
        this.lastError = `cohort members (${venue}) on the heatmap thread: ${String((e as Error)?.message ?? e)} - written at the next pass`;
        return;
      }
    } else {
      changed = await this.sigs.changes(venue, members, () => this.breathePlan(), SLICE_MS);
    }
    // Members that left the set leave the table too: until 2026-10-28 nothing removed them, and the
    // API counted 218 Hyperliquid and 15.8k trade.xyz wallets that had left up to 29 days before (no
    // book: shown as not covered, their old PnL and equity still in the cohorts). A set far smaller
    // than the table is a partial read upstream, not wallets leaving: nothing is removed then.
    let saved = this.savedMembers.get(venue);
    if (!saved) { saved = new Set(this.d.store.cohortMemberAddresses(venue)); this.savedMembers.set(venue, saved); }
    const gone = saved.size && members.size >= MEMBERS_KEPT_MIN * saved.size ? [...saved].filter((a) => !members.has(a)) : [];
    for (let i = 0; i < gone.length; i += MEMBER_SAVE_BATCH) {
      this.d.store.dropCohortMembers(venue, gone.slice(i, i + MEMBER_SAVE_BATCH));
      await this.breathePlan();
    }
    for (const a of gone) saved.delete(a);
    if (gone.length) {
      if (this.cohortThreaded) this.live.cohortIn({ k: 'gone', venue, a: gone });
      else this.sigs.drop(venue, gone);
    }
    for (const a of members.keys()) saved.add(a);
    for (let i = 0; i < changed.length; i += MEMBER_SAVE_BATCH) {
      this.d.store.putCohortMembers(venue, changed.slice(i, i + MEMBER_SAVE_BATCH), this.d.now());
      await this.breathePlan();
    }
    this.savedFrom.set(venue, members);
  }

  // --- reads --------------------------------------------------------------------------

  private laneOf(venue: Venue): Lane {
    if (venue === 'sodex') return this.scoh;
    if (venue === 'lighter') return this.d.lighter.lane;
    if (venue === 'arcus') return this.d.arcus.lane;
    return this.hlc;
  }

  /** `total`: the leaderboard's account value (Hyperliquid; null off it), for needsSpot. */
  private readOne(venue: Venue, address: string, total: number | null): Promise<PositionRead> {
    switch (venue) {
      case 'hyperliquid': {
        const prev = this.books.get('hyperliquid')?.get(address);
        return hlPositions(address, undefined, (r) => needsSpot(total, r.equity, r.positions.length, { notional: readNotional(r), unified: prev?.collateral != null }));
      }
      case 'tradexyz': return hlPositions(address, 'xyz');
      case 'sodex': return this.readSodexState(address);
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
    this.pnlShare();
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
    // A restart with the streams back within the hour missed minutes of prints, which the
    // large books' gap re-reads cover; only a longer one leaves every book unknown.
    this.staleBefore = this.downAtStart < OUTAGE_GAP_MS ? 0
      : resumedAfterOutage(this.d.store.cohortSeriesRecorded(scopeKey(VENUES), COHORTS[0]!.id, now - REBUILD_WINDOW_MS), this.startedAt);
    // Which venues get their full pass this minute (PLAN_FULL_MS); the stream spans are looked at every minute.
    const full = new Set<Venue>();
    const sinceOf = new Map<Venue, number | null>();
    for (const venue of VENUES) {
      // A new continuous stream span means an outage: large books are unknown again.
      const since = this.d.streamSince(venue);
      sinceOf.set(venue, since);
      const outage = STREAMED.has(venue) && since !== null && this.span.has(venue) && this.span.get(venue) !== since;
      if (outage) {
        // The activity span broke: an outage longer than the tolerance.
        this.gapAt.set(venue, now);
        this.gapFloor.set(venue, 100_000);
      }
      this.span.set(venue, since);
      const queued = this.laneOf(venue).countPrefix(`coh:${venue}:`);
      if (fullPassDue({ lastAt: this.plannedAt.get(venue), now, queued, dueLeft: this.dueLeft.get(venue) ?? 0, outage })) full.add(venue);
    }
    // trade.xyz's pass takes Hyperliquid's members as they were at its last pass in between.
    const hlMembers = full.has('hyperliquid') || !this.members.has('hyperliquid') ? await this.membersOf('hyperliquid') : this.members.get('hyperliquid')!;
    const breath = async () => {
      await new Promise<void>((r) => setImmediate(r));
      mark('coh:plan');
    };
    for (const venue of VENUES) {
      if (!full.has(venue)) {
        // Between passes the PnL reads still get their minute's share (planPnl hands them out from its list).
        if (venue === 'hyperliquid') await this.planPnl(now);
        continue;
      }
      this.plannedAt.set(venue, now);
      await breath();
      const members = venue === 'hyperliquid' ? hlMembers : await this.membersOf(venue);
      // A venue's own accounts are no cohort member (internalWallets.ts): they leave the table too (saveMembers).
      for (const a of excludedOf(venue)) members.delete(a);
      if (venue === 'tradexyz') this.accountPnl(members, hlMembers);
      await breath();
      this.members.set(venue, members);
      await this.saveMembers(venue, members);
      if (venue === 'hyperliquid') {
        await this.planPnl(now);
        await breath();
      }
      const since = sinceOf.get(venue) ?? null;
      const streamed = STREAMED.has(venue) && since !== null && (this.d.socketUp?.(venue) ?? true);

      const lane = this.laneOf(venue);
      const queued = lane.countPrefix(`coh:${venue}:`);
      // Which of its members, traded wallets, archive holders and read-list wallets are due a read (cohortCore.ts planDue,
      // on the heatmap thread when it runs the passes). A full queue: only the status's counts.
      const ask: PlanAsk = {
        venue, now, cap: QUEUE_CAP - queued, scan: queued < QUEUE_CAP, streamed,
        gap: this.gapAt.get(venue) ?? 0, floor: this.gapFloor.get(venue) ?? 100_000, staleBefore: this.staleBefore, startedAt: this.startedAt,
      };
      const known = this.d.lighter.known;
      const out = await this.pass<PlanOut>(
        {
          op: 'plan', ask,
          wanted: [...this.wantedOf(venue)],
          // Lighter: the books whose prints are not followed yet (their indices unknown); every one when nothing says.
          unknown: venue !== 'lighter' ? null : known ? [...this.books.get('lighter')!.keys()].filter((a) => !known(a)) : null,
        },
        () => planDue(this.view, ask, {
          wanted: { has: (a) => this.wanted.has(`${venue}|${a}`), list: () => this.wantedOf(venue) },
          known: (a) => known?.(a) ?? false,
        }, () => this.breathePlan(), SLICE_MS),
      );
      this.seedsUnread.set(venue, out.seedsUnread);
      if (out.readListUnread !== null) this.readListUnread = out.readListUnread;
      if (!ask.scan) {
        this.dueLeft.set(venue, 0);
        continue;
      }
      this.liqDue.set(venue, out.liqDue);
      this.dueLeft.set(venue, Math.max(0, out.dueLen - ask.cap));
      for (const [address, prio, total] of out.due) this.queueRead(venue, address, prio, total);
    }
  }

  /**
   * One book read, queued on its venue's lane (one task per wallet: a second ask raises its
   * priority). The read replaces the book whole: what the venue no longer reports is gone.
   * `total`: Hyperliquid's leaderboard account value (null off it), for needsSpot.
   */
  private queueRead(venue: Venue, address: string, prio: number, total: number | null): void {
    const books = this.books.get(venue)!;
    const flyKey = `${venue}|${address}`;
    this.laneOf(venue).add({
      key: `coh:${venue}:${address}`,
      prio,
      run: async () => {
        const reqAt = this.d.now();
        if (venue === 'sodex') this.flying.set(flyKey, []);
        const r = await this.readOne(venue, address, total).catch((e: unknown) => { this.flying.delete(flyKey); throw e; });
        if (venue === 'lighter' && r.indices?.length) this.d.lighter.learn?.(address, r.indices);
        const at = this.d.now();
        const book: Book = {
          equity: r.equity, at, reqAt: r.read?.sent ?? reqAt, ...(r.read ? { read: r.read } : {}), collateral: r.collateral ?? null, spotAt: r.spotAt ?? null,
          pos: new Map(r.positions.map((p) => [p.symbol, { szi: p.szi, entry: p.entry }])),
        };
        await this.liquidationSide(venue, r, books.get(address), book);
        books.set(address, book);
        if (venue === 'sodex') this.settleFlying(flyKey, venue, address, book);
        // The read holds every spot trade before it: what waited for the account's mode is in it.
        if (venue === 'hyperliquid') this.spotPending.delete(address);
        this.live.touch(venue, address);
        this.dirtyBooks.add(`${venue}|${address}`);
        this.wanted.delete(`${venue}|${address}`);
        for (const [sym, px] of r.marks) {
          const mk = `${venue}|${sym}`;
          if (!this.marks.has(mk)) { this.marks.set(mk, px); this.live.price(mk, px); this.dirtyMarks.add(mk); }
        }
        return READ_COST[venue] + (r.extraCost ?? 0);
      },
    });
  }

  /**
   * Hyperliquid's and trade.xyz's hourly funding, applied to every book: the rates are taken
   * in the hour's last two minutes (the hour's own rate by then) and paid when it ends, by the
   * books read before that (a read after it already holds the payment). Without this a book's
   * cash and equity drifted by the funding until its next re-read.
   */
  private async fundingTick(): Promise<void> {
    const now = this.d.now();
    const end = Math.ceil(now / HOUR_MS) * HOUR_MS;
    if (!this.fundingNext && end - now <= 2 * 60_000) {
      const rates = new Map<Venue, Map<string, { rate: number; px: number }>>();
      try {
        for (const [venue, dex] of [['hyperliquid', null], ['tradexyz', 'xyz']] as const) {
          const raw = await hlInfo.post<[{ universe?: Array<{ name?: string }> }, Array<{ funding?: string; oraclePx?: string; markPx?: string }>] | null>(
            dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }, { ttlMs: 30_000 });
          if (!Array.isArray(raw)) throw new Error(`no market list for ${venue}`);
          const m = new Map<string, { rate: number; px: number }>();
          (raw[0]?.universe ?? []).forEach((u, i) => {
            const c = raw[1]?.[i];
            const rate = Number(c?.funding);
            const px = Number(c?.oraclePx ?? c?.markPx);
            if (u.name && Number.isFinite(rate) && px > 0) m.set(u.name, { rate, px });
          });
          rates.set(venue, m);
        }
        this.fundingNext = { end, rates };
      } catch (e) {
        this.fundingLast = { end, books: 0, paid: 0, error: String(e) };
      }
      return;
    }
    const f = this.fundingNext;
    if (!f || now < f.end) return;
    this.fundingNext = null;
    let n = 0;
    let paid = 0;
    let t0 = Date.now();
    for (const [venue, rates] of f.rates) {
      for (const [address, book] of this.books.get(venue) ?? []) {
        if (!book.pos.size || book.at >= f.end) continue;
        const p = fundingCash(book, (sym) => rates.get(sym) ?? null);
        if (!p) continue;
        if (venue === 'hyperliquid') this.addFlow(address, -p);
        paid += p;
        n++;
        this.live.touch(venue, address);
        this.dirtyBooks.add(`${venue}|${address}`);
        if (Date.now() - t0 > SLICE_MS) {
          await new Promise<void>((r) => setImmediate(r));
          mark('coh:funding');
          t0 = Date.now();
        }
      }
    }
    this.fundingLast = { end: f.end, books: n, paid };
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
        s.setMeta(PRINTS_THROUGH_META, JSON.stringify(Object.fromEntries(this.printsThrough)));
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
   * (liq_hist) of every coin SoDEX lists as a perp (the only coins the heatmap covers).
   */
  /** A venue's price for a symbol: its coin's reference price when the venue ranks first among those seen. */
  private noteCoinPx(key: string, px: number): void {
    if (!(px > 0)) return;
    const i = key.indexOf('|');
    const rank = LIQ_PRICE_ORDER.indexOf(key.slice(0, i) as Venue);
    const coin = liqCoin(key.slice(i + 1));
    const cur = this.coinPx.get(coin);
    if (!cur || rank <= cur.rank) {
      this.coinPx.set(coin, { px, rank: rank < 0 ? 99 : rank });
      this.live.coinPx(coin, px);
    }
  }

  /** Every LIVE_TICK_MS: price what changed (a bounded slice), and send the changes to the API. */
  /**
   * The books' size per coin and venue (the live engine's totals) against the venue's open
   * interest (oiCheck.ts): over OI_EXCESS it is logged (once an hour per coin), shown in the
   * status (cohorts.liq.oi) and the coin's holders on that venue are read again, oldest first.
   */
  private async checkOi(): Promise<void> {
    if (!this.live.ready) return;
    // The heatmap thread restarting: the next check (OI_CHECK_MS) asks again.
    const totals = await this.live.totals().catch(() => null);
    if (!totals) return;
    const markets = new Map<Venue, Map<string, number>>();
    const staleOi: Venue[] = [];
    // The books leave SoDEX's internal pair out, so the check must too: against the whole figure the 36 markets the pair holds
    // could never read over (BTC: books 14 of 908 until 2026-11-06). Without the pair's size SoDEX is judged on nothing.
    const sodexInternal = await sodexInternalNow();
    for (const v of VENUES) {
      const m = await venueMarkets(v, { oi: true }).catch(() => null);
      if (v === 'sodex' && !sodexInternal) { staleOi.push(v); markets.set(v, new Map()); continue; }
      // A failed read answers with the last good one. Judged against that, books are "over" what the market held minutes ago:
      // WIF 2,496 against 153 at 12:03 on 2026-11-06, when a real print of 2,414 at 11:57 had made it so and the books were right.
      if (m && Date.now() - m.at > OI_FRESH_MS) { staleOi.push(v); markets.set(v, new Map()); continue; }
      const per = new Map<string, number>();
      for (const [symbol, x] of m?.oi ?? []) {
        const c = liqCoin(symbol);
        per.set(c, (per.get(c) ?? 0) + x.oi);
      }
      if (v === 'sodex') for (const [c, size] of sodexInternal ?? []) per.set(c, Math.max(0, (per.get(c) ?? 0) - size));
      markets.set(v, per);
    }
    const rows = oiCheck(totals, (v, coin) => markets.get(v)?.get(coin) ?? null);
    const now = this.d.now();
    let queued = 0;
    const over = oiOver(rows);
    const overOn = new Map<Venue, number>();
    for (const r of over) overOn.set(r.venue, (overOn.get(r.venue) ?? 0) + 1);
    const asks = new Map<Venue, OiAsk[]>();
    const picked = new Map<string, string[]>();
    for (const r of over) {
      const k = `${r.venue}|${r.coin}`;
      if (now - (this.oiLogged.get(k) ?? 0) >= OI_LOG_EVERY_MS) {
        this.oiLogged.set(k, now);
        console.warn(`cohorts: ${r.venue} ${r.coin} books hold ${(r.ratio * 100).toFixed(1)}% of the open interest (long ${r.long.toPrecision(6)}, short ${r.short.toPrecision(6)}, open ${r.oi.toPrecision(6)}; over ${Math.round(OI_EXCESS * 100)}%): reading its holders again`);
      }
      if (!this.books.get(r.venue)) continue;
      const limit = Math.min(OI_REREAD_BATCH[r.venue], Math.ceil(OI_REREAD_TOTAL[r.venue] / (overOn.get(r.venue) ?? 1)));
      asks.set(r.venue, [...(asks.get(r.venue) ?? []), { coin: r.coin, limit, sides: overSides(r), gapAt: this.gapAt.get(r.venue) }]);
    }
    // Each venue's coins over in one pass over its books (oiCheck.ts oiRereadsMany), on the heatmap thread when it runs the passes.
    for (const [venue, list] of asks) {
      const got = await this.pass<string[][]>({ op: 'oi', venue, asks: list, now },
        () => oiRereadsMany(this.books.get(venue)!.entries(), list, liqCoin, now, () => this.breathePlan(), SLICE_MS));
      list.forEach((a, i) => picked.set(`${venue}|${a.coin}`, got[i] ?? []));
    }
    for (const r of over) {
      for (const address of picked.get(`${r.venue}|${r.coin}`) ?? []) {
        const m = this.members.get(r.venue)?.get(address);
        this.queueRead(r.venue, address, OI_PRIO, r.venue === 'hyperliquid' && m?.ranked ? m.equity : null);
        queued++;
      }
    }
    this.oiLast = { at: now, venues: oiStatus(rows, 50), queued, staleOi };
  }

  /** The books the engine found crossed: read again first (crossedPrio), a recent read excepted (crossedDue). */
  private rereadCrossed(): void {
    if (!this.crossed.size) return;
    const now = this.d.now();
    for (const [k, usd] of this.crossed) {
      const i = k.indexOf('|');
      const venue = k.slice(0, i) as Venue;
      const address = k.slice(i + 1);
      const book = this.books.get(venue)?.get(address);
      if (!book || !crossedDue(book.at, now)) continue;
      const m = this.members.get(venue)?.get(address);
      this.queueRead(venue, address, crossedPrio(usd), venue === 'hyperliquid' && m?.ranked ? m.equity : null);
      this.crossedQueued++;
    }
    this.crossed.clear();
  }

  private liveTick(): void {
    this.refreshSodexCoins();
    // Nothing is bucketed before SoDEX's list is known (the first seconds after a start).
    if (!this.sodexCoins.size) return;
    // Inline: the engine's beat (prices a bounded slice, sends the changes). Threaded: the coins and tiers to the thread
    // if they changed; it prices and sends on its own beat (liqLiveThread.ts).
    this.live.beat(LIVE_SLICE, liveBudget(this.live.pending));
    this.rereadCrossed();
  }

  /**
   * What the change log keeps of a position besides its level (store LiqLogExtra), from the
   * account's book now (liqLiveCore.ts logExtraOf; the heatmap thread reads its copy of the books the same way).
   */
  private logExtra(venue: Venue, address: string, coin: string): LiqLogExtra {
    const b = this.books.get(venue)?.get(address);
    if (!b) return {};
    return logExtraOf({ equity: b.equity, cash: b.cash ?? null, at: b.at }, b.pos, liqCoin, coin, (sym) => this.marks.get(`${venue}|${sym}`) ?? null);
  }

  /** Let timers and sockets run between two slices of a liquidation step. */
  private async breathe(): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
    mark('coh:liq');
  }

  /**
   * Every LIQ_NOW_MS: every coin's levels, as the live engine holds them, to the index file (liq_now, deflated: what
   * the API answers from when the live feed is not there). Every LIQ_STEP_MS also a snapshot for the historical view
   * (liq_hist, fine bands) of every coin SoDEX lists as a perp (the only coins the heatmap covers), and every
   * position's level into the change log (store liq_log): a row only when a position opens, flips, closes, or its
   * level or size moved (liqLiveCore.ts levelDiff). Pruned daily to LIQ_KEEP_MS (a row superseded before then).
   *
   * What needs the live positions is computed by the engine (on the heatmap thread: a step took 54 minutes on this
   * thread at 99.7% busy, 2026-11-08); this thread only writes what comes back, in today's order.
   */
  private async recordLiq(): Promise<void> {
    const now = this.d.now();
    if (this.liqRecording || !this.members.size || now - this.lastNowAt < LIQ_NOW_MS - 5_000) return;
    this.liqRecording = true;
    const started = Date.now();
    try {
      // Until every book is priced into the engine once (seconds after a start), the last rows stand.
      if (!this.live.ready) return;
      const s = this.d.store;
      const t = Math.floor(now / LIQ_STEP_MS) * LIQ_STEP_MS;
      // A step whose writes are still going holds back only the next STEP, never the 2-minute heatmap rows:
      // both used to wait on one flag, and a 45-min step write left the heatmap frozen as long (2026-11-09 00:15).
      const stepT = t > this.lastLiqT && !this.liqStepWriting ? t : null;
      const ticks = new Map<string, number>();
      if (stepT !== null) for (const [sym, tick] of marketsNow('sodex')?.ticks ?? []) ticks.set(liqCoin(sym), tick);
      let init: { cur: ReturnType<IndexStore['liqCur']>; addrs: Map<string, number> } | undefined;
      if (stepT !== null && this.live.needsLevelInit) {
        // Where the log begins, for the history's details (liqRead.ts liqAt: nothing before it is by position).
        if (!s.getMeta('liq_log_from')) s.setMeta('liq_log_from', String(s.liqLogFrom() ?? t));
        init = { cur: s.liqCur(), addrs: s.liqAddrs() };
      }
      // Once: every open position written in full, so each carries the fields the log keeps since 2026-10-29.
      const full = stepT !== null && !s.getMeta(LIQ_LOG_FULL_META);
      const askedAt = Date.now();
      const out = await this.live.step({ now, t: stepT, coins: [...this.sodexCoins], ticks, full, ...(init ? { init } : {}) });
      if (!out.ready || !out.now) return;
      s.putLiqNow(now, out.now);
      this.lastNowAt = now;
      const step = out.step;
      if (stepT === null || !step) return;
      this.liqStepWriting = true;
      void this.writeLiqStep(stepT, step, full, now, askedAt).finally(() => { this.liqStepWriting = false; });
    } catch (e) {
      this.lastError = `liquidations: ${String(e)}`;
    } finally {
      this.liqRecording = false;
      this.liqMs = Date.now() - started;
    }
  }

  /** A step's writes, in today's order, beside the heatmap rows (recordLiq goes on writing those meanwhile). */
  private async writeLiqStep(stepT: number, step: NonNullable<Awaited<ReturnType<CohortTracker['live']['step']>>['step']>, full: boolean, now: number, askedAt: number): Promise<void> {
    const s = this.d.store;
    try {
      const loggingAt = Date.now();
      // Every position's level at the same step, as a change log (the history's wallet filter).
      // Before the snapshot: a snapshot at `t` says the step is there, and its log is by then whole.
      if (step.log) {
        const ids = await s.putLiqLogSliced(stepT, step.log.fresh, step.log.changed, step.log.closed, () => this.breathe());
        if (full) s.setMeta(LIQ_LOG_FULL_META, String(stepT));
        this.live.commit(ids);
        if (stepT - this.levelPrunedAt >= DAY_MS) {
          if (mayPrune('liq-log')) s.pruneLiqLog(stepT - LIQ_KEEP_MS);
          this.levelPrunedAt = stepT;
        }
        this.levelRows = step.log.changed.length + step.log.closed.length;
      }
      const loggedAt = Date.now();
      if (step.fine.length) s.putLiqHistFineBands(stepT, step.fine);
      await this.breathe();
      if (step.hist.length) s.putLiqHist(stepT, step.hist);
      // Older snapshots - and the 15-minute ones thinned to hourly - go only with the owner's word.
      if (mayPrune('liq-history')) s.pruneLiqHist(now - LIQ_KEEP_MS, now - LIQ_THIN_MS, 60 * 60_000);
      this.lastLiqT = stepT;
      const stepMs = Date.now() - askedAt;
      // What the step took and in which part: a step's cost grows with the positions held.
      if (stepMs >= 5_000) {
        console.log(`[indexer] liq step ${Math.round(stepMs / 1000)} s: computed ${loggingAt - askedAt} ms (${this.live.threaded ? 'heatmap thread' : 'inline'}: positions ${step.positionsMs} ms, layers ${step.layersMs} ms, diff ${step.diffMs} ms), log ${loggedAt - loggingAt} ms (${this.levelRows} rows), snapshots ${Date.now() - loggedAt} ms`);
      }
    } catch (e) {
      this.lastError = `liquidations: ${String(e)}`;
    } finally {
      this.liqStepMs = Date.now() - askedAt;
    }
  }

  // --- history ------------------------------------------------------------------------

  /** The wallets the streams saw trade on a venue, without a book yet (addresses, in the order seen). */
  private *wantedOf(venue: Venue): Iterable<string> {
    const p = `${venue}|`;
    for (const k of this.wanted.keys()) if (k.startsWith(p)) yield k.slice(p.length);
  }

  /** Let timers and sockets run between two slices of a history step. */
  private async breatheRecord(): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
    mark('coh:record');
  }

  /**
   * Every 15 minutes the cohorts' figures for every scope (cohort_series), on the hour each cohort's coins and sectors too
   * (cohort_mix). Netted on the heatmap thread when it runs the passes (cohortCore.ts recordCompute: 1,661 s of this
   * thread after one restart, 2026-11-08); written here, as before.
   */
  private async record(): Promise<void> {
    const now = this.d.now();
    const seriesT = Math.floor(now / SERIES_STEP_MS) * SERIES_STEP_MS;
    const mixT = Math.floor(now / MIX_STEP_MS) * MIX_STEP_MS;
    if (this.recording || (seriesT <= this.lastSeriesT && mixT <= this.lastMixT) || !this.members.size) return;
    this.recording = true;
    const t0 = Date.now();
    try {
      const doMix = mixT > this.lastMixT;
      const ask: RecordAsk = { seriesT, mixT, doMix };
      const { series, mix } = await this.pass<RecordOut>({ op: 'record', ask }, () => recordCompute(this.view, ask, () => this.breatheRecord(), RECORD_SLICE_MS));
      const s = this.d.store;
      if (seriesT > this.lastSeriesT) {
        s.putCohortSeries(series);
        if (mayPrune('cohort-history')) s.pruneCohortSeries(now - SERIES_KEEP_MS);
        this.lastSeriesT = seriesT;
      }
      if (doMix) {
        s.putCohortMix(mix);
        if (mayPrune('cohort-history')) s.pruneCohortMix(now - SERIES_KEEP_MS);
        this.lastMixT = mixT;
      }
    } finally {
      this.recording = false;
      this.recordMs = Date.now() - t0;
    }
  }
}
