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
import { VENUES, type Venue } from '../valuedesk/types.js';
import type { LbSnapshot } from '../valuedesk/hyperliquid/leaderboard.js';
import type { Pacer } from '../valuedesk/extra/http.js';
import {
  Aggregator, COHORTS, MARGIN_SIBLING, TAIL_EQUITY, coinOf, netWallet, perpEquity, sampleRule, sampledVenue, scopeKey, sectorTotals,
  type CohortRange, type Position, type WalletVenue,
} from '../valuedesk/cohorts/model.js';
import { Lane } from './lanes.js';
import { WeightBudget } from '../valuedesk/hyperliquid/info.js';
import { mark } from './busy.js';
import type { Print } from './streams.js';
import { defaultDbPath, type IndexStore } from './store.js';
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DAY_MS, dayOf } from './windows.js';
import {
  PNL_READ_COST, READ_COST, arcusPositions, hlEquityHistory, hlFundingRows, hlHourlyPrices, hlPortfolioPnl, hlPositions,
  lighterPositions, sodexPositions, type PositionRead,
} from './cohortSource.js';
import {
  HOUR_MS, REBUILD_WINDOW_MS, REBUILT_VENUES, checkEdges, histOf, missingSpans, needsEquityHistory, peakNotional, priceAt,
  OUTAGE_GAP_MS, readRange, rebuildHour, rebuildSample, resumedAfterOutage, sizeProxy, venueOfSymbol,
  type Bridge, type RebuildCheck, type RebuildWallet, type Span, type WalletHist,
} from './cohortRebuild.js';
import type { BookPosition, CohortPnlRow, LiqLogExtra } from './store.js';
import { accountLiqs, addDrift, calibrate, emptyDrift, feeCash, fillCash, fundingCash, niceStep, type DriftStats, type Tiers } from '../valuedesk/liquidations/math.js';
import { hlInfo } from '../valuedesk/hyperliquid/index.js';
import { ARCUS_FEES_COST, ASK_MIN_USD, BASE_FEES, FEES_TTL_MS, HL_FEES_COST, SODEX_FEES_COST, arcusFees, fillRate, hlFees, sodexFees, spotSellRate, xyzScales, type FeeRates, type MarketScale } from './feeRates.js';
import { marketsNow, setRulesPacers, venueMarkets } from '../valuedesk/liquidations/rules.js';
import { liqCoin, snapOfNow } from '../valuedesk/liquidations/levels.js';
import { LiqLive } from '../valuedesk/liquidations/live.js';
import { LiqFeedServer } from './liqFeed.js';
import { deflateRawSync } from 'node:zlib';
import { loadSeeds, type Seeds } from './archiveSeed.js';
import { mayPrune } from '../retention.js';
import { OI_EXCESS, oiCheck, oiOver, oiRereads, oiStatus } from './oiCheck.js';

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
/** An archive holder's notional from which its first read ranks with a trader's (USD). */
const SEED_BONUS_MIN = 1_000;
/** Coins kept per cohort in the hourly mix. */
const MIX_COINS = 120;

/** Every coin's liquidation levels (liq_now) this often; a snapshot (liq_hist) every LIQ_STEP_MS. */
/** Every 2 minutes: a pass over ~90k books took 14-26 s of a disk-bound loop (2026-10-25); the edge serves the row in between. */
/** The liquidation backlog takes the reads above this many books (updateLiqBoost)... */
export const LIQ_BOOST_MIN = 300;
/** A book counts toward that from this much notional (USD). */
const LIQ_BOOST_NOTIONAL = 10_000;
/** ...with the boards lane's loan to the history rebuild, and the PnL reads' share cut to this. */
const LIQ_BOOST_LEND = 200;
const LIQ_BOOST_PNL_SHARE = 0.1;
/** The live engine's beat, and how many changed accounts one beat prices at most (a start primes ~90k books in ~20 beats). */
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
const OPENED_REREAD_MS = 2 * 60_000;
/** Crossed books held between beats at most (a burst after a start is read over the next passes). */
const CROSSED_MAX = 50_000;
/** Per venue, the newest print time the saved books hold (printApplies after a restart). */
const PRINTS_THROUGH_META = 'cohort_prints_through';
/** The open interest check (checkOi): how often, and how many holders of a coin over it are read per check. */
const OI_CHECK_MS = 5 * 60_000;
const OI_REREAD_BATCH: Record<Venue, number> = { hyperliquid: 200, tradexyz: 100, sodex: 50, arcus: 50, lighter: 60 };
const OI_PRIO = 870;
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
 * Hyperliquid and trade.xyz books are paid their funding every hour (fundingTick), so
 * only fees and money moved in or out drift them: 24 h ($1M+) and 3 days ($100K+) since
 * 2026-10-27, from 6 h and 24 h, which freed the reads for the archive's new holders.
 */
export function reconcileTtl(equity: number, venue?: Venue): number {
  const funded = venue === 'hyperliquid' || venue === 'tradexyz';
  if (equity >= 1_000_000) return (funded ? 24 : 6) * 60 * 60_000;
  if (equity >= 100_000) return funded ? 3 * DAY_MS : 24 * 60 * 60_000;
  if (venue === 'sodex') return 24 * 60 * 60_000;
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

/** Position notional above this multiple of the perps account value: the equity is uncertain (needsSpot). */
export const SPOT_LEVERAGE = 5;

/**
 * Whether a Hyperliquid read with positions also reads the spot state (weight 2): whenever the
 * account's equity is uncertain - a unified / portfolio-margin account runs its perps on its spot,
 * and its perps account value is only the margin in use there.
 *
 *   - a book already found unified (`unified`): every read looks again, so its collateral follows
 *     the schedule of its reads instead of standing as first read (0xb8e4...a206, 2026-10-30:
 *     $96,459 kept against $110,785 now - medium instead of large);
 *   - off the leaderboard (`total` null): nothing says what its spot holds (0x591e...9657, $952K
 *     perps value against $5.75M of spot - large instead of apex; 0xcb84...52cd, whale);
 *   - position notional above SPOT_LEVERAGE times the perps value;
 *   - on the leaderboard, its account value (perps + spot + staked) well above the perps value.
 */
export function needsSpot(total: number | null | undefined, perpsValue: number | null, positions: number, o: { notional?: number; unified?: boolean } = {}): boolean {
  if (!positions) return false;
  if (o.unified) return true;
  if (total == null || !(total > 0)) return true;
  if ((o.notional ?? 0) > SPOT_LEVERAGE * Math.max(0, perpsValue ?? 0)) return true;
  return total - Math.max(0, perpsValue ?? 0) > Math.max(1_000, 0.1 * total);
}

/** A read's position notional at its own marks (needsSpot). */
export function readNotional(r: { positions: ReadonlyArray<{ symbol: string; szi: number; entry: number | null }>; marks: ReadonlyArray<[string, number]> }): number {
  const mk = new Map(r.marks);
  let n = 0;
  for (const p of r.positions) n += Math.abs(p.szi) * (mk.get(p.symbol) ?? p.entry ?? 0);
  return n;
}

/** From here a unified account's spot is valued token by token (cohortSource.ts spotCollateral); before, stablecoins only. */
export const SPOT_VALUE_SINCE = Date.UTC(2026, 9, 25);

/**
 * A Hyperliquid book whose spot state should be read ahead of its schedule: never looked at
 * while its equity is uncertain (needsSpot: `total` is the leaderboard's account value, null off
 * it; `notional` the book's now), or a unified account's spot valued by the rule before
 * SPOT_VALUE_SINCE (once). A book found unified is looked at again by every read after.
 */
export function spotDue(book: { spotAt?: number | null; collateral?: number | null; equity: number | null; pos: { size: number } }, total: number | null | undefined, notional?: number): boolean {
  if (book.spotAt == null) return needsSpot(total, book.equity, book.pos.size, { notional });
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
/**
 * How often a book is read again for its liquidation prices, by its notional: what
 * prints and prices cannot move (spot collateral, fees, deposits) drifts them. Found
 * 2026-10-28: a 2,613 BTC short read 6 h before stood 1.9% from Hyperliquid's figure,
 * the largest level on the BTC map.
 *
 * 2026-10-30, Hyperliquid against its own liquidationPx (drift between reads, 76.8% within 0.1%
 * overall): the $5M+ positions (read every 30 min) 31 of 36 within 0.1%; positions of $50K-$3M
 * (read at their reconcile, 3 to 7 days) 18 of 30 within 0.1% and 23 within 1% - 29 of the 30
 * the right size, so the drift is margin no print shows (transfers, spot collateral). Now: $5M+
 * every 15 min, $1M+ hourly, $250K+ every 6 h, $50K+ daily (about 40 more reads a minute, weight
 * 2 each, of the lane's 400); smaller books keep their reconcile.
 */
export function liqRefreshTtl(notional: number): number {
  return notional >= 5_000_000 ? 15 * 60_000
    : notional >= 1_000_000 ? 60 * 60_000
      : notional >= 250_000 ? 6 * 60 * 60_000
        : notional >= 50_000 ? 24 * 60 * 60_000
          : Infinity;
}

/**
 * A book whose positions changed by a fill since its read: its cross figures move with every
 * fill, and what the fill did to its margin (fees, an isolated top-up, a flip) is the model's
 * until a read says. From $250K of notional, read again 15 min after the read - only once per
 * read (the read clears it), so an account trading all day is read every 15 min at most.
 */
export const FILLED_REREAD_MS = 15 * 60_000;
export const FILLED_REREAD_MIN = 250_000;
export function liqChangedDue(book: { at: number; filledAt?: number }, notional: number, now: number): boolean {
  return book.filledAt !== undefined && book.filledAt > book.at && notional >= FILLED_REREAD_MIN && now - book.at >= FILLED_REREAD_MS;
}

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
  /** A market it did not hold was opened since the read (its margin mode and leverage are unknown): read again soon. */
  opened?: boolean;
  /** When the snapshot was read (its answer came back). */
  at: number;
  /** When its read was asked (this process only): a print before it is in the read already (printApplies). */
  reqAt?: number;
  /** When a print last moved it (this process only): liqChangedDue. */
  filledAt?: number;
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


/** What a fill of `d` at `px` realizes on the book's position: the part it closes, against the entry. */
export function realizedOf(book: Pick<Book, 'pos'>, symbol: string, d: number, px: number): number {
  const cur = book.pos.get(symbol);
  if (!cur || !cur.szi || cur.entry === null || !Number.isFinite(cur.entry) || Math.sign(cur.szi) === Math.sign(d)) return 0;
  return Math.min(Math.abs(d), Math.abs(cur.szi)) * (px - cur.entry) * Math.sign(cur.szi);
}

/**
 * A book outside its venue's tail sample (sampleRule) that still holds positions: read again once
 * its schedule says so (`ttl`), lowest of all reads. Until 2026-10-30 it was never read again, and
 * kept whatever it held in the live map for good (Lighter samples 10% of its small wallets).
 */
export function tailBookDue(book: { at: number; pos: { size: number } } | undefined, now: number, ttl: number): boolean {
  return !!book && book.pos.size > 0 && now - book.at >= ttl;
}

/** A print this much before a read was asked is in the read for certain (clocks: the venue's against ours). */
export const PRINT_SKEW_MS = 2_000;

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
function bookable(venue: Venue, symbol: string): boolean {
  if (symbol.includes('/') || symbol.startsWith('@')) return false;
  if (venue === 'hyperliquid') return !symbol.includes(':');
  if (venue === 'tradexyz') return symbol.startsWith('xyz:');
  return true;
}

interface Member {
  pnl: number | null;
  /** Hyperliquid: the leaderboard's account value when `ranked`, else the last read's perps value. */
  equity: number | null;
  /** Hyperliquid: on the leaderboard (its equity counts spot and staked too). */
  ranked?: boolean;
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
/** While more perp PnL reads than PNL_BACKLOG wait (the switch to perp PnL, 2026-10-28), they get this share. */
export const PNL_BACKLOG_SHARE = 0.7;
const PNL_BACKLOG = 1_000;
/** How often the due list is scanned again (it is handed out a minute at a time in between). */
const PNL_SCAN_MS = 5 * 60_000;
/** Meta keys: when perp PnL reads began, and the accounts' PnL flows since their reads (saved every PNL_FLOW_SAVE_MS). */
const PERP_SINCE_META = 'cohort_pnl_perp_since';
const PNL_FLOW_META = 'cohort_pnl_flow';
const PNL_FLOW_SAVE_MS = 5 * 60_000;
/** A position's level is logged again once it moved this much (relative), or its USD this much: the history draws 0.25% cells. */
/** Set once every open position has been written with the extra fields (logLevels). */
const LIQ_LOG_FULL_META = 'liq_log_full_v2';
const LIQ_LOG_MOVE = 0.0005;
const USD_LOG_MOVE = 0.002;
const NO_WALLETS: ReadonlySet<string> = new Set();
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
    wanted: (coin) => this.sodexCoins.has(coin),
    crossed: (venue, address, usd) => {
      const k = `${venue}|${address}`;
      if (this.crossed.size < CROSSED_MAX) this.crossed.set(k, Math.max(usd, this.crossed.get(k) ?? 0));
    },
  });
  /** Per venue, the newest print time applied (saved with the books: PRINTS_THROUGH_META), and the one the saved books held at the start. */
  private printsThrough = new Map<Venue, number>();
  private replayBefore = new Map<Venue, number>();
  private printsSkipped = 0;
  /** The last open interest check (checkOi): per venue, the worst ratio and the coins over. */
  private oiLast: { at: number; venues: ReturnType<typeof oiStatus>; queued: number } | null = null;
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

  /** Whether a book holds any coin the heatmap covers. */
  private holdsSodexCoin(b: Book): boolean {
    for (const sym of b.pos.keys()) if (this.sodexCoins.has(liqCoin(sym))) return true;
    return false;
  }
  private feed = new LiqFeedServer(() => this.live.resendAll());
  /** Every book priced into the engine once since the start. */
  private liveReady = false;
  /** The engine's `processed` count at which the books touched at the start are all in (liveTick). */
  private liveBarrier: number | null = null;
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
  private pnlDueList: Array<[string, number]> | null = null;
  private pnlDueNext = 0;
  private pnlDueAt = 0;
  /** The change log's last logged state per position (aid|coin|venue), and the address ids (logLevels). */
  private levelState: Map<string, { side: number; liq: number; usd: number }> | null = null;
  private levelAddr: Map<string, number> | null = null;
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
  private lastNowAt = 0;
  /** How long the last liquidation pass took (status). */
  private liqMs = 0;
  /** When this tracker started (books read before it without liquidation data are read once more). */
  private startedAt = 0;
  /** Holders the Hyperliquid fills archive found (archiveSeed.ts): read once each, the largest first. */
  private seeds: Seeds = new Map();
  private seedsAt: number | null = null;
  /** How long Hyperliquid's stream was down across this start (its `stream_up`); Infinity = never up before. */
  private downAtStart = Number.POSITIVE_INFINITY;
  /** The hour's funding rates, taken in its last minutes and applied when it ends (fundingTick). */
  private fundingNext: { end: number; rates: Map<Venue, Map<string, { rate: number; px: number }>> } | null = null;
  private fundingLast: { end: number; books: number; paid: number; error?: string } | null = null;
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
        if (v === 'hyperliquid') this.downAtStart = lastUp > 0 ? now - lastUp : Number.POSITIVE_INFINITY;
        this.gapFloor.set(v, gapRereadFloor(lastUp > 0 ? now - lastUp : Number.POSITIVE_INFINITY));
      }
    }
    for (const [k, px] of s.cohortMarks()) { this.marks.set(k, px); this.noteCoinPx(k, px); }
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
      const saved = JSON.parse(s.getMeta(PNL_FLOW_META) ?? '{}') as Record<string, [number, number]>;
      for (const [a, [flow, u0]] of Object.entries(saved)) if (Number.isFinite(flow) && Number.isFinite(u0)) this.pnlFlow.set(a, { flow, u0 });
    } catch { /* starts afresh: the PnL stands as read until the next read */ }
    void loadSeeds().then((r) => { this.seeds = r.seeds; this.seedsAt = r.at; }).catch((e) => (this.lastError = `archive seeds: ${String(e)}`));
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
    every(30_000, () => this.fundingTick(), 'coh:funding');
    every(6 * 60 * 60_000, () => this.loadSpotPairs(), 'coh:spot');
    every(60 * 60_000, () => this.loadXyzScales(), 'coh:xyzfees');
    every(PNL_FLOW_SAVE_MS, () => this.saveFlows(), 'coh:pnlflow');
    every(OI_CHECK_MS, () => this.checkOi(), 'coh:oi');
    void this.loadXyzScales().catch((e) => (this.lastError = `xyz fee terms: ${String(e)}`));
    void this.loadSpotPairs().catch((e) => (this.lastError = `spot pairs: ${String(e)}`));
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
    this.saveFlows();
  }

  /** The PnL flows to the index (they survive a restart; a write that fails keeps the last). */
  private saveFlows(): void {
    try {
      const out: Record<string, [number, number]> = {};
      for (const [a, f] of this.pnlFlow) out[a] = [Math.round(f.flow * 100) / 100, Math.round(f.u0 * 100) / 100];
      this.d.store.setMeta(PNL_FLOW_META, JSON.stringify(out));
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
    if (f && Number.isFinite(x)) f.flow += x;
  }

  // --- the streams ----------------------------------------------------------------------

  /** Every print: a price, and each party's book moved (or queued for its first read). */
  onPrint(p: Print, addressOf: (acct: string) => string | null): void {
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
      const book = books.get(address);
      if (!book) {
        const k = `${p.venue}|${address}`;
        if (!this.wanted.has(k)) this.wanted.set(k, this.d.now());
        continue;
      }
      if (!printApplies(book, p.t, this.replayBefore.get(p.venue) ?? 0)) { this.printsSkipped++; continue; }
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
    if (this.wanted.size > 100_000) this.wanted.clear();
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

  status(): Record<string, unknown> {
    return {
      members: Object.fromEntries(VENUES.map((v) => [v, this.members.get(v)?.size ?? 0])),
      books: Object.fromEntries(VENUES.map((v) => [v, this.books.get(v)?.size ?? 0])),
      waiting: this.wanted.size,
      printsApplied: this.applied,
      planMs: this.planMs,
      recordMs: this.recordMs,
      liqMs: this.liqMs,
      printsSkipped: this.printsSkipped,
      liq: { crossedQueued: this.crossedQueued, oi: this.oiLast, boost: this.liqBoost, due: Object.fromEntries(this.liqDue), live: { ready: this.liveReady, pending: this.live.pending, ms: this.liveMs, readers: this.feed.readers, error: this.feed.lastError }, nowAt: this.lastNowAt || null, since: this.startedAt },
      hlc: { queued: this.hlc.size, done: this.hlc.done, failed: this.hlc.failed, lastError: this.hlc.lastError },
      pnl: { perpSince: this.perpSince, due: this.pnlDue, flows: this.pnlFlow.size, imported: this.pnlImported },
      levels: { open: this.levelState?.size ?? null, lastRows: this.levelRows },
      scoh: { queued: this.scoh.size, done: this.scoh.done, failed: this.scoh.failed, lastError: this.scoh.lastError },
      hlh: { queued: this.hlh.size, done: this.hlh.done, failed: this.hlh.failed, lastError: this.hlh.lastError, lent: this.lent },
      staleBefore: this.staleBefore,
      funding: this.fundingLast,
      seeds: { at: this.seedsAt, ...Object.fromEntries([...this.seeds].map(([v, m]) => {
        const books = this.books.get(v);
        let unread = 0;
        for (const k of m.keys()) if (!books?.has(k)) unread++;
        return [v, { wallets: m.size, unread }];
      })) },
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
    if (!this.pnlRead) this.pnlRead = this.d.store.cohortPnl('hyperliquid');
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
            done.set(row.address, { ...row, at });
            const b = books?.get(row.address);
            if (row.pnl != null) this.pnlFlow.set(row.address, { flow: 0, u0: b ? this.unrealized('hyperliquid', b) : 0 });
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

  /** Every Hyperliquid / trade.xyz holder whose perp PnL read is due, largest first (planPnl). */
  private scanPnlDue(members: Map<string, Member>, done: Map<string, CohortPnlRow & { at: number }>, now: number): Array<[string, number]> {
    const due: Array<[string, number]> = [];
    // After an outage the flows miss what traded meanwhile: the large accounts are read again.
    const outage = this.downAtStart >= OUTAGE_GAP_MS;
    // Holders on the main dex and on trade.xyz (the same accounts: accountPnl), every one of them -
    // the leaderboard's PnL is the whole account's, so a ranked holder is read too. By what it
    // holds (notional), the larger of that and its equity: the money in a PnL cohort is there.
    const seen = new Set<string>();
    for (const [venue, books] of [['hyperliquid', this.books.get('hyperliquid')!], ['tradexyz', this.books.get('tradexyz')!]] as const) {
      for (const [address, book] of books) {
        if (!book.pos.size || seen.has(address)) continue;
        seen.add(address);
        const m = members.get(address);
        const read = done.get(address);
        let ntl = 0;
        for (const [symbol, p] of book.pos) ntl += Math.abs(p.szi) * (this.marks.get(`${venue}|${symbol}`) ?? p.entry ?? 0);
        const eq = Math.max(ntl, m?.equity ?? book.equity ?? 0);
        const fresh = read && read.at >= this.perpSince && now - read.at < pnlTtl(eq)
          && !(outage && eq >= 100_000 && read.at < this.startedAt);
        if (fresh) continue;
        due.push([address, pnlPrio(eq)]);
      }
    }
    return due.sort((a, b) => b[1] - a[1]);
  }

  private planPnl(members: Map<string, Member>, now: number): void {
    this.importPnlDrops();
    const lane = this.hlc;
    const queued = lane.countPrefix('cohpnl:');
    if (queued >= PNL_QUEUE_CAP) return;
    const done = this.pnls();
    // The holders due, largest first: scanned every PNL_SCAN_MS (a pass over ~300k books, 9% of
    // the thread when it ran every minute - 2026-10-28), handed out from the list in between.
    if (!this.pnlDueList || now - this.pnlDueAt >= PNL_SCAN_MS || this.pnlDueList.length - this.pnlDueNext < PNL_QUEUE_CAP) {
      this.pnlDueList = this.scanPnlDue(members, done, now);
      this.pnlDueNext = 0;
      this.pnlDueAt = now;
    }
    this.pnlDue = this.pnlDueList.length - this.pnlDueNext;
    this.pnlShare();
    const take: Array<[string, number]> = [];
    while (take.length < PNL_QUEUE_CAP - queued && this.pnlDueNext < this.pnlDueList.length) {
      const x = this.pnlDueList[this.pnlDueNext++]!;
      const read = done.get(x[0]);
      // Read meanwhile (the backfill's drops, a read here): not again.
      if (read && read.at >= this.perpSince && read.at >= this.pnlDueAt) continue;
      if (!lane.has(`cohpnl:${x[0]}`)) take.push(x);
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
          done.set(address, { ...row, at });
          // The flow starts over from this read, at the unrealized PnL the book holds now.
          const book = this.books.get('hyperliquid')?.get(address);
          if (row.pnl != null) this.pnlFlow.set(address, { flow: 0, u0: book ? this.unrealized('hyperliquid', book) : 0 });
          else this.pnlFlow.delete(address);
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
    // Three significant digits: a PnL kept current by its flow moves with every mark, and was
    // rewritten every minute for every such holder (2026-10-28); a cohort boundary is a round number.
    const r = (v: number | null | undefined) => (v == null ? '' : Math.abs(v) < 100 ? Math.round(v) : Number(v.toPrecision(3)));
    for (const [address, m] of members) {
      const sig = `${r(m.pnl)}|${r(m.equity)}|${m.label ?? ''}|${r(m.pnlRange?.['1d'])}|${r(m.pnlRange?.['7d'])}|${r(m.pnlRange?.['30d'])}`;
      const k = `${venue}|${address}`;
      if (this.memberSig.get(k) === sig) continue;
      this.memberSig.set(k, sig);
      changed.push({ address, pnl: m.pnl, equity: m.equity, label: m.label, pnl1d: m.pnlRange?.['1d'] ?? null, pnl7d: m.pnlRange?.['7d'] ?? null, pnl30d: m.pnlRange?.['30d'] ?? null });
    }
    // Members that left the set leave the table too: until 2026-10-28 nothing removed them, and the
    // API counted 218 Hyperliquid and 15.8k trade.xyz wallets that had left up to 29 days before (no
    // book: shown as not covered, their old PnL and equity still in the cohorts). A set far smaller
    // than the table is a partial read upstream, not wallets leaving: nothing is removed then.
    let saved = this.savedMembers.get(venue);
    if (!saved) { saved = new Set(this.d.store.cohortMemberAddresses(venue)); this.savedMembers.set(venue, saved); }
    const gone = saved.size && members.size >= MEMBERS_KEPT_MIN * saved.size ? [...saved].filter((a) => !members.has(a)) : [];
    for (let i = 0; i < gone.length; i += 5_000) {
      this.d.store.dropCohortMembers(venue, gone.slice(i, i + 5_000));
      await new Promise<void>((r) => setImmediate(r));
      mark('coh:plan');
    }
    for (const a of gone) { saved.delete(a); this.memberSig.delete(`${venue}|${a}`); }
    for (const a of members.keys()) saved.add(a);
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

  /** `total`: the leaderboard's account value (Hyperliquid; null off it), for needsSpot. */
  private readOne(venue: Venue, address: string, total: number | null): Promise<PositionRead> {
    switch (venue) {
      case 'hyperliquid': {
        const prev = this.books.get('hyperliquid')?.get(address);
        return hlPositions(address, undefined, (r) => needsSpot(total, r.equity, r.positions.length, { notional: readNotional(r), unified: prev?.collateral != null }));
      }
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
        if (venue === 'hyperliquid') this.planPnl(hlMembers, now);
        continue;
      }
      this.plannedAt.set(venue, now);
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
      const since = sinceOf.get(venue) ?? null;
      const streamed = STREAMED.has(venue) && since !== null && (this.d.socketUp?.(venue) ?? true);

      const lane = this.laneOf(venue);
      const queued = lane.countPrefix(`coh:${venue}:`);
      if (queued >= QUEUE_CAP) {
        this.dueLeft.set(venue, 0);
        continue;
      }
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
        // A wallet never read and never valued: the archive's notional orders it among the others.
        const size = Math.round(Math.log10(Math.max(1, eq || (book ? 0 : this.seeds.get(venue)?.get(address) ?? 0))) * 100);
        // A tail wallet outside the sample is never read, traded or not (it would count twice) - but a
        // book it already has (read while it was larger, or before the sample) still holds positions
        // the live map counts: it is read again on its schedule, and a read that finds them closed drops them.
        if (!sampleRule(TAIL_RATE[venue], address, eq).counts) {
          const follows = streamed && (venue !== 'lighter' || (this.d.lighter.known?.(address) ?? false));
          if (tailBookDue(book, now, follows ? reconcileTtl(eq, venue) : pollTtl(eq))) due.push([address, 300 + Math.round(Math.log10(Math.max(1, eq)) * 100)]);
          return;
        }
        const push = (prio: number) => {
          due.push([address, prio]);
          if (venue === 'hyperliquid') totals.set(address, m?.ranked ? m.equity : null);
        };
        if (!book) {
          // Never read: one the stream saw trade, or one the archive found holding $1K or more, before
          // any re-read. Dust from the archive (13.9k wallets under $33, 2026-10-28) waits its turn: with
          // the bonus it outranked the books still missing liquidation data, and the history rebuild,
          // paused until those are read, never ran.
          push(1_000 + size + (traded || (this.seeds.get(venue)?.get(address) ?? 0) >= SEED_BONUS_MIN ? 300 : 0));
          return;
        }
        const age = now - book.at;
        // A market it did not hold opened since the read: cross or isolated, and at what leverage, is
        // the venue's to say - booked as cross until then, which moved trade.xyz books' cash by
        // thousands (most of its markets are isolated). Read again within minutes.
        if (book.opened && age >= OPENED_REREAD_MS) { push(970 + size); return; }
        // Lighter prints name sub-accounts: a book follows them only once its indices are known.
        const follows = streamed && (venue !== 'lighter' || (this.d.lighter.known?.(address) ?? false));
        // Read before the books kept liquidation prices (2026-10-25): once, the most leveraged first -
        // their liquidations sit nearest the price, where the heatmap is read.
        if (book.pos.size && !liqKnown(book) && (book.at < this.startedAt || book.liqMiss) && this.holdsSodexCoin(book)) {
          const n = notional(book);
          push(liqBacklogPrio(n, book.collateral ?? book.equity));
          // Only books that show on the map hold the rebuild back: ~540 nearly empty accounts
          // (equity under $3, 2026-10-28) never came up in the queue and paused it for good.
          if (n >= LIQ_BOOST_NOTIONAL) liqDue++;
        }
        else if (book.pos.size && staleEquity(book, notional(book), now)) push(950 + size);
        else if (follows && eq >= floor && book.at < gap) push(900 + size);
        // Read before the last outage ended: it missed that outage's prints, at any size.
        else if (follows && book.at < this.staleBefore) push(900 + size);
        // Read before the spot state was looked at, and its equity uncertain: the leaderboard sees more
        // first; off it (needsSpot), below the heatmap's refreshes, largest first.
        else if (venue === 'hyperliquid' && spotDue(book, m?.ranked ? m.equity : null, notional(book))) push((m?.ranked ? 900 : 860) + size);
        // A book of $250K+ a fill moved since its read: its figures are the model's until a read (liqChangedDue).
        else if (book.pos.size && liqKnown(book) && this.holdsSodexCoin(book) && liqChangedDue(book, notional(book), now)) push(885 + size);
        // A large book whose liquidation prices sit on the heatmap: read again sooner than its reconcile (liqRefreshTtl).
        else if (book.pos.size && liqKnown(book) && age >= liqRefreshTtl(notional(book)) && this.holdsSodexCoin(book)) push(880 + size);
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
      // The archive's holders not read yet (once read, their book makes them members).
      for (const address of this.seeds.get(venue)?.keys() ?? []) {
        if (members.has(address) || books.has(address) || this.wanted.has(`${venue}|${address}`)) continue;
        consider(address, undefined);
        if (Date.now() - t0 > SLICE_MS) {
          await new Promise<void>((r) => setImmediate(r));
          mark('coh:plan');
          t0 = Date.now();
        }
      }
      this.liqDue.set(venue, liqDue);
      due.sort((a, b) => b[1] - a[1]);
      this.dueLeft.set(venue, Math.max(0, due.length - (QUEUE_CAP - queued)));
      for (const [address, prio] of due.slice(0, QUEUE_CAP - queued)) this.queueRead(venue, address, prio, totals.get(address) ?? null);
    }
  }

  /**
   * One book read, queued on its venue's lane (one task per wallet: a second ask raises its
   * priority). The read replaces the book whole: what the venue no longer reports is gone.
   * `total`: Hyperliquid's leaderboard account value (null off it), for needsSpot.
   */
  private queueRead(venue: Venue, address: string, prio: number, total: number | null): void {
    const books = this.books.get(venue)!;
    this.laneOf(venue).add({
      key: `coh:${venue}:${address}`,
      prio,
      run: async () => {
        const reqAt = this.d.now();
        const r = await this.readOne(venue, address, total);
        if (venue === 'lighter' && r.indices?.length) this.d.lighter.learn?.(address, r.indices);
        const at = this.d.now();
        const book: Book = {
          equity: r.equity, at, reqAt, collateral: r.collateral ?? null, spotAt: r.spotAt ?? null,
          pos: new Map(r.positions.map((p) => [p.symbol, { szi: p.szi, entry: p.entry }])),
        };
        await this.liquidationSide(venue, r, books.get(address), book);
        books.set(address, book);
        // The read holds every spot trade before it: what waited for the account's mode is in it.
        if (venue === 'hyperliquid') this.spotPending.delete(address);
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
    if (!cur || rank <= cur.rank) this.coinPx.set(coin, { px, rank: rank < 0 ? 99 : rank });
  }

  /** Every LIVE_TICK_MS: price what changed (a bounded slice), and send the changes to the API. */
  /**
   * The books' size per coin and venue (the live engine's totals) against the venue's open
   * interest (oiCheck.ts): over OI_EXCESS it is logged (once an hour per coin), shown in the
   * status (cohorts.liq.oi) and the coin's holders on that venue are read again, oldest first.
   */
  private async checkOi(): Promise<void> {
    if (!this.liveReady) return;
    const totals = this.live.totals();
    const markets = new Map<Venue, Map<string, number>>();
    for (const v of VENUES) {
      const m = await venueMarkets(v, { oi: true }).catch(() => null);
      const per = new Map<string, number>();
      for (const [symbol, x] of m?.oi ?? []) {
        const c = liqCoin(symbol);
        per.set(c, (per.get(c) ?? 0) + x.oi);
      }
      markets.set(v, per);
    }
    const rows = oiCheck(totals, (v, coin) => markets.get(v)?.get(coin) ?? null);
    const now = this.d.now();
    let queued = 0;
    for (const r of oiOver(rows)) {
      const k = `${r.venue}|${r.coin}`;
      if (now - (this.oiLogged.get(k) ?? 0) >= OI_LOG_EVERY_MS) {
        this.oiLogged.set(k, now);
        console.warn(`cohorts: ${r.venue} ${r.coin} books hold ${(r.ratio * 100).toFixed(1)}% of the open interest (long ${r.long.toPrecision(6)}, short ${r.short.toPrecision(6)}, open ${r.oi.toPrecision(6)}; over ${Math.round(OI_EXCESS * 100)}%): reading its holders again`);
      }
      const books = this.books.get(r.venue);
      if (!books) continue;
      for (const address of oiRereads(books, r.coin, liqCoin, now, OI_REREAD_BATCH[r.venue])) {
        const m = this.members.get(r.venue)?.get(address);
        this.queueRead(r.venue, address, OI_PRIO, r.venue === 'hyperliquid' && m?.ranked ? m.equity : null);
        queued++;
      }
    }
    this.oiLast = { at: now, venues: oiStatus(rows), queued };
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
    const t0 = Date.now();
    this.refreshSodexCoins();
    // Nothing is bucketed before SoDEX's list is known (the first seconds after a start).
    if (!this.sodexCoins.size) return;
    // Every coin whole once a minute: the deltas leave out moves under 1% (live.ts SEND_MOVE: 1%), this puts the API's copy back to exact.
    if (t0 - this.liveWholeAt >= 60_000) { this.liveWholeAt = t0; this.live.resendAll(); }
    // Ready once the books waiting at the first beat (every book: start() touches them all) are
    // priced. Waiting for nothing to be left never came on a busy day: prints touch books faster
    // than a beat's budget prices them, and from 2026-10-27 23:16 UTC no liq_now row was written
    // for 16 hours (the heatmap answered from that one).
    if (this.liveBarrier === null) this.liveBarrier = this.live.processed + this.live.pending;
    const left = this.live.work(LIVE_SLICE, liveBudget(this.live.pending));
    this.rereadCrossed();
    if (!this.liveReady && (!left || this.live.processed >= this.liveBarrier)) this.liveReady = true;
    const deltas = this.live.flush();
    this.feed.send(deltas, { at: this.d.now(), ready: this.liveReady });
    this.liveMs = Date.now() - t0;
  }

  /**
   * Every position's liquidation level into the change log (store liq_log): a row only when a
   * position opens, flips, closes, or its level moves past LIQ_LOG_MOVE or its size past
   * USD_LOG_MOVE since its last row - the history draws 0.25% cells, the level is the live
   * engine's 0.02% bucket, so nothing it shows is lost. Compared with the last logged state
   * (liq_cur, read once at the first step): a restart neither repeats every position nor misses
   * what closed while it was down. Pruned daily to LIQ_KEEP_MS (a row superseded before then).
   */
  private logLevels(t: number, coins: ReadonlySet<string>): void {
    const s = this.d.store;
    if (!this.levelState) {
      // Where the log begins, for the history's details (liqRead.ts liqAt: nothing before it is by position).
      if (!s.getMeta('liq_log_from')) s.setMeta('liq_log_from', String(s.liqLogFrom() ?? t));
      this.levelAddr = s.liqAddrs();
      this.levelState = new Map();
      for (const r of s.liqCur()) this.levelState.set(`${r.aid}|${r.coin}|${r.venue}`, { side: r.side, liq: r.liq, usd: r.usd });
    }
    const state = this.levelState;
    const addr = this.levelAddr!;
    const byCoin = this.live.positionsByCoin(0, NO_WALLETS);
    // One state per address, coin and venue: two symbols of one coin on one venue keep the larger.
    const now = new Map<string, { aid: number | string; coin: string; venue: number; side: number; liq: number; usd: number; address: string; v: Venue } & LiqLogExtra>();
    const fresh = new Set<string>();
    for (const coin of coins) {
      for (const x of byCoin.get(coin) ?? []) {
        const vi = VENUES.indexOf(x.venue);
        let id: number | string | undefined = addr.get(x.address);
        if (id === undefined) { fresh.add(x.address); id = x.address; }
        const key = `${id}|${coin}|${vi}`;
        const usd = Math.round(x.usd);
        const prev = now.get(key);
        if (prev && prev.usd >= usd) continue;
        now.set(key, { aid: id, coin, venue: vi, side: x.long ? 1 : -1, liq: +x.liq.toPrecision(8), usd, address: x.address, v: x.venue });
      }
    }
    // Once: every open position written in full, so each carries the fields the log keeps since 2026-10-29
    // (size, entry, margin, account) - not only the ones that changed since. About 170k rows, one step.
    const full = !s.getMeta(LIQ_LOG_FULL_META);
    const changed: Array<{ aid: number | string; coin: string; venue: number; side: number; liq: number; usd: number; address: string; v: Venue } & LiqLogExtra> = [];
    for (const [key, x] of now) {
      const was = state.get(key);
      if (!full && was && was.side === x.side && Math.abs(x.liq - was.liq) <= LIQ_LOG_MOVE * was.liq && Math.abs(x.usd - was.usd) <= USD_LOG_MOVE * Math.max(1, was.usd)) continue;
      // The rest of the position as it stands, from its book (only for the rows written).
      changed.push(Object.assign(x, this.logExtra(x.v, x.address, x.coin)));
    }
    const closed: Array<{ aid: number; coin: string; venue: number; mark: number | null }> = [];
    for (const key of state.keys()) {
      if (now.has(key)) continue;
      const [aid, coin, venue] = key.split('|');
      if (!coins.has(coin!)) continue;
      closed.push({ aid: Number(aid), coin: coin!, venue: Number(venue), mark: this.coinPx.get(coin!)?.px ?? null });
    }
    if (!changed.length && !closed.length) return;
    const ids = s.putLiqLog(t, [...fresh], changed, closed);
    if (full) s.setMeta(LIQ_LOG_FULL_META, String(t));
    for (const [a, id] of ids) addr.set(a, id);
    for (const x of changed) {
      const aid = typeof x.aid === 'number' ? x.aid : ids.get(x.aid)!;
      state.set(`${aid}|${x.coin}|${x.venue}`, { side: x.side, liq: x.liq, usd: x.usd });
    }
    for (const c of closed) state.delete(`${c.aid}|${c.coin}|${c.venue}`);
    if (t - this.levelPrunedAt >= DAY_MS) {
      if (mayPrune('liq-log')) s.pruneLiqLog(t - LIQ_KEEP_MS);
      this.levelPrunedAt = t;
    }
    this.levelRows = changed.length + closed.length;
  }

  /**
   * What the change log keeps of a position besides its level (store LiqLogExtra), from the
   * account's book now: its symbol (the largest of the coin's, as the level keeps), signed size,
   * entry, the mark, isolated or cross and the leverage, the account's equity and cross cash, and
   * when the book was read.
   */
  private logExtra(venue: Venue, address: string, coin: string): LiqLogExtra {
    const b = this.books.get(venue)?.get(address);
    if (!b) return {};
    let sym: string | null = null;
    for (const [s, p] of b.pos) if (p.szi && liqCoin(s) === coin && (sym === null || Math.abs(p.szi) > Math.abs(b.pos.get(sym)!.szi))) sym = s;
    const acct = { eq: b.equity, cash: b.cash ?? null, readAt: b.at };
    if (sym === null) return acct;
    const p = b.pos.get(sym)!;
    // LiqPos: `iso` present (a number, or null when not known) is isolated; absent is cross.
    return { ...acct, sym, sz: p.szi, entry: p.entry, mark: this.marks.get(`${venue}|${sym}`) ?? null, iso: p.iso !== undefined, lev: p.lev ?? null };
  }

  private async recordLiq(): Promise<void> {
    const now = this.d.now();
    if (this.liqRecording || !this.members.size || now - this.lastNowAt < LIQ_NOW_MS - 5_000) return;
    this.liqRecording = true;
    const started = Date.now();
    try {
      // Until every book is priced into the engine once (seconds after a start), the last rows stand.
      if (!this.liveReady) return;
      const rows = this.live.rows();
      const s = this.d.store;
      s.putLiqNow(now, [...rows].map(([coin, row]): [string, Uint8Array] => [coin, deflateRawSync(JSON.stringify(row))]));
      this.lastNowAt = now;
      const t = Math.floor(now / LIQ_STEP_MS) * LIQ_STEP_MS;
      if (t > this.lastLiqT) {
        const keep = this.sodexCoins;
        const hist: Array<[string, string]> = [];
        for (const coin of keep) {
          const row = rows.get(coin);
          if (row) hist.push([coin, JSON.stringify(snapOfNow(row))]);
        }
        if (hist.length) s.putLiqHist(t, hist);
        // Every position's level at the same step, as a change log (the history's wallet filter).
        this.logLevels(t, keep);
        // Older snapshots - and the 15-minute ones thinned to hourly - go only with the owner's word.
        if (mayPrune('liq-history')) s.pruneLiqHist(now - LIQ_KEEP_MS, now - LIQ_THIN_MS, 60 * 60_000);
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
      // One pass over the wallets for every scope at once. A wallet is netted once per set of
      // venues it is on that a scope selects (most are on one venue: once in all), and that
      // result is added to each such scope. Scope by scope it was netted up to 31 times, and
      // with ~300k wallets (2026-10-27) a pass took 100 minutes on a busy loop.
      const scopes = allScopes();
      const maskOf = (vs: readonly Venue[]) => vs.reduce((m, v) => m | (1 << VENUES.indexOf(v)), 0);
      const scopeMasks = scopes.map(maskOf);
      const aggs = scopes.map(() => new Aggregator());
      const addresses = new Set<string>();
      for (const m of per.values()) for (const a of m.keys()) addresses.add(a);
      let t1 = Date.now();
      for (const address of addresses) {
        let held = 0;
        // Listed on a venue counts it in that venue's scopes (as a member), its figures only where it has them.
        const wv: Array<WalletVenue | undefined> = VENUES.map((v, i) => {
          const m = per.get(v)!;
          if (m.has(address)) held |= 1 << i;
          return m.get(address);
        });
        const netted = new Map<number, ReturnType<typeof netWallet>>();
        for (let i = 0; i < scopes.length; i++) {
          const u = held & scopeMasks[i]!;
          if (!u) continue;
          let n = netted.get(u);
          if (!n) {
            const mine = new Map<Venue, WalletVenue>();
            VENUES.forEach((v, j) => { const w = wv[j]; if (u & (1 << j) && w) mine.set(v, w); });
            n = netWallet(address, mine, priceOf);
            netted.set(u, n);
          }
          aggs[i]!.add(n);
        }
        if (Date.now() - t1 > RECORD_SLICE_MS) {
          await new Promise<void>((r) => setImmediate(r));
          mark('coh:record');
          t1 = Date.now();
        }
      }
      for (let i = 0; i < scopes.length; i++) {
        const key = scopeKey(scopes[i]!);
        const agg = aggs[i]!;
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
