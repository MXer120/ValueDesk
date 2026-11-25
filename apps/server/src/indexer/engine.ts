/**
 * The leaderboard indexer.
 *
 * Output: for each venue, window (1d 7d 30d 90d ytd all) and side (top /
 * worst), the hundred traders by PnL - once among traders with more than one
 * trade in the window (`active`) and once without that filter (`any`). Each
 * board is rebuilt every 30 s from what the index holds and written to the
 * store, where the API reads it.
 *
 * How a board fills (boards.ts): candidates come best first from the venue's
 * PnL for that window. The first wallets whose trades are not known yet are
 * queued for a check; everyone who makes a board is then indexed in full
 * over the window: every fill (and, on SoDEX, every closed position) from the
 * window start to now. After that the live trade streams keep them complete.
 *
 * Work runs on three lanes, one per upstream budget, each paced to a share
 * of it (env, see INDEXER_ENV below):
 *   hl     Hyperliquid /info         fills, 90d/ytd portfolio reads
 *   sgw    SoDEX gateway             fills, closed positions
 *   sdata  SoDEX data host           published lists, rank lookups, charts
 *
 * Nothing here signs, trades or moves funds; every request is a public read.
 */
import { WalletBackfill, WalletHistoryDb } from './walletHistory.js';
import { activeAccountsAsync } from './activeScan.js';
import { pageSource } from '../history.js';
import { hlInfo, hlLeaderboard } from '../valuedesk/hyperliquid/index.js';
import type { LbSnapshot } from '../valuedesk/hyperliquid/leaderboard.js';
import { isRateLimited, sodex } from '../sodex/rest.js';
import { gatewayWeightLimit, gatewayWeightSpent } from '../valuedesk/sodex/gateway.js';
import { knownAddress, resolveIds, seedAddress } from '../valuedesk/sodex/resolver.js';
import { cooldownLeftMs } from '../valuedesk/sodex/util.js';
import { VENUES, WINDOWS, type BoardWindow, type Venue, type Window } from '../valuedesk/types.js';
import { pickBoardAsync, spanCovers, tradeCheck, type Candidate, type TradeCheck } from './boards.js';
import { hlCandidates, hlChartWindows, hlQuickCheck, hlSyncFills } from './hlSource.js';
import { Lane } from './lanes.js';
import { ArcusVenue } from './ext/arcus.js';
import { LighterVenue } from './ext/lighter.js';
import { TradexyzVenue } from './ext/tradexyz.js';
import type { ExtVenue } from './ext/types.js';
import { CohortTracker } from './cohortTracker.js';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { STALL_LOG_MS, gcWithin, mark, noteGc, startedBefore, within } from './busy.js';
import { SlicedWork } from './slicedWork.js';
import { hlCoinName } from '../valuedesk/extra/account.js';
import { accountValue as fetchAccountValue, chartWindows, lookupPnl, peekTrades, syncCloses, syncLists, syncTrades } from './sodexSource.js';
import type { BoardRow, Coverage, HistoryKind, IndexStore, TraderStatsRow, TraderWin } from './store.js';
import { winRateOf } from '../valuedesk/winRate.js';
import { HlStream, SodexStream, streamLog, type ArcusWsTrade, type Dedup, type Print } from './streams.js';
import { BoundaryFilter, FILTER_TAIL_MS, FROM_MARGIN_MS, KEEP_IDS, PrintTap, type Boundary, type PrintBuffer } from './handover.js';
import { sourceFactory, type Sources } from './printSources.js';
import { SodexCatchup } from './sodexCatchup.js';
import { ArcusCatchup } from './arcusCatchup.js';
import { startLedgerThread, type LedgerThread } from '../flow/ledgerWorker.js';
import { mayPrune } from '../retention.js';
import { startFlow, type FlowFeed } from '../flow/thread.js';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { StallProfiler } from './stallProfiler.js';
import { loadLeaderboardFile, saveLeaderboardFile } from '../valuedesk/hyperliquid/leaderboardFile.js';
import {
  BOARD_SIZE,
  dayOf,
  DAY_MS,
  HOUR_MS,
  hourOf,
  MIN_TRADES,
  FILTERS,
  INDEX_WINDOWS,
  SIDES,
  windowStart,
  yearStartUtc,
  type BoardFilter,
  type Side,
} from './windows.js';

const envNum = (name: string, dflt: number, min: number, max: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : dflt;
};

/** Where the SoDEX stream's unanswered breaks are kept (settleBreaks). */
const STREAM_PENDING_META = 'stream_pending:sodex';
/** How far each Arcus market has been read over REST (arcusCatchup.ts), in the who-traded database. */
const ARCUS_CATCHUP_META = 'catchup:arcus';
/** Arcus's REST time against its stream's: 2 to 16 ms measured, wide on purpose (FlowRecorder.missingNear). */
const ARCUS_NEAR_MS = 2_000;
/** Older than this, a print the catch-up found no longer moves books and marks. */
const CATCHUP_BOOK_MS = 30 * 60_000;
/** One trade check read per wallet and window for this long, and not again sooner when it could not decide. */
const CHECK_BUCKET_MS = 6 * 60 * 60_000;
const CHECK_AGAIN_MS = 60 * 60_000;

/**
 * SoDEX's history limit, MEASURED 2026-09-30 (docs/ARCH-traffic.md §2):
 * `/trades` and `/orders/history` - both engines - share ONE Cloudflare
 * counter of about 4 requests per ~60 s per IP. The fifth gets `error code:
 * 1015`, and the block holds for as long as requests keep coming - for the
 * whole IP's history reads. Cloudflare weighs the previous minute into the
 * current one, so any two adjacent minutes must stay at 4 or fewer: the safe
 * drip is 2 per 60 s for the PAIR together (3 per minute was seen to trip it).
 *
 * The indexer's `/trades` lane can never be configured above this. Anything else
 * on the same IP that reads either path (the local API's account-history
 * routes, the all-time history walk) spends the same counter, so run the drip
 * only where nothing else reads SoDEX history.
 */
export const SODEX_HISTORY_PAIR_PER_MIN = 2;

export const INDEXER_ENV = {
  /**
   * HL /info weight per minute for the boards' fill reads. HL allows 1,200 per
   * IP: 500 here + 400 for the cohorts' position and portfolio reads
   * (VALUESCAN_INDEX_HL_COHORT) leaves ~300 for the app's own reads (it is given
   * 200). Raised from 300 on 2026-09-29 - the
   * boards' histories (and trade.xyz, which is computed from them) lagged by hours.
   */
  hlWeightPerMin: () => envNum('VALUESCAN_INDEX_HL_WEIGHT', 500, 30, 900),
  /** SoDEX `/positions/history` requests per minute (closed positions). */
  sodexClosesPerMin: () => envNum('VALUESCAN_INDEX_SODEX_CLOSES', 6, 0.2, 30),
  /**
   * SoDEX `/trades` requests per minute: a drip, never above
   * SODEX_HISTORY_PAIR_PER_MIN (2 per 60 s - the measured rule above; the cap
   * used to be 6, three times what trips a 1015).
   */
  sodexTradesPerMin: () => envNum('VALUESCAN_INDEX_SODEX_TRADES', 0.05, 0.05, SODEX_HISTORY_PAIR_PER_MIN),
  /**
   * SoDEX `/trades` backfill is OFF unless this is set: Cloudflare answers the
   * path with 1015 (whole IP, trading UI included) even at a drip - verified
   * 2026-09-28 by an audit that saw the drip hit 429. The stream records every
   * fill of a tracked trader from the moment it is tracked.
   */
  sodexTradesEnabled: () => Number(process.env.VALUESCAN_INDEX_SODEX_TRADES) > 0,
  /**
   * SoDEX account-trades reads per minute that answer a wallet's trade check. They spend the `/trades` counter above, so with
   * the backfill on the two together stay at SODEX_HISTORY_PAIR_PER_MIN. Two such reads on 2026-11-06 answered 200.
   */
  sodexChecksPerMin: () => Math.max(0.2, Math.min(envNum('VALUESCAN_INDEX_SODEX_CHECKS', 1, 0.2, SODEX_HISTORY_PAIR_PER_MIN), SODEX_HISTORY_PAIR_PER_MIN - (INDEXER_ENV.sodexTradesEnabled() ? INDEXER_ENV.sodexTradesPerMin() : 0))),
  /**
   * The wallet backfill's `/trades` reads a minute (walletHistory.ts): off at 0, and never more than what the trade
   * checks and the board reads leave of SODEX_HISTORY_PAIR_PER_MIN.
   */
  walletBackfillPerMin: () => {
    const asked = Number(process.env.VALUESCAN_WALLET_BACKFILL);
    if (!(asked > 0)) return 0;
    return Math.max(0.1, Math.min(asked, SODEX_HISTORY_PAIR_PER_MIN - INDEXER_ENV.sodexChecksPerMin() - (INDEXER_ENV.sodexTradesEnabled() ? INDEXER_ENV.sodexTradesPerMin() : INDEXER_ENV.sodexLeaderTradesPerMin())));
  },
  /**
   * SoDEX `/trades` pages a minute for the Copy page's leaders only (the 'any' boards of COPY_WINDOWS, top and worst),
   * back COPY_BACK_DAYS, while the boards' full backfill above is off: their copy setup then replays the index's fills
   * (/api/vs/wallet/fills) instead of walking SoDEX in the browser, a couple of pages a minute per visitor. What the
   * board's trade checks leave of SODEX_HISTORY_PAIR_PER_MIN, and never above it: 0.5 with the checks' 1 (1.5 of 2). 0 turns it off.
   */
  sodexLeaderTradesPerMin: () => {
    const raw = process.env.VALUESCAN_INDEX_SODEX_LEADER_TRADES;
    const asked = raw === undefined || raw.trim() === '' ? 0.5 : Number(raw);
    if (!(asked > 0)) return 0;
    const left = SODEX_HISTORY_PAIR_PER_MIN - INDEXER_ENV.sodexChecksPerMin();
    return left >= 0.05 ? Math.max(0.05, Math.min(asked, left)) : 0;
  },
  /** How far back `/trades` reaches for a SoDEX board member (days). The stream covers everything after. */
  sodexTradesBackDays: () => envNum('VALUESCAN_INDEX_SODEX_TRADES_DAYS', 30, 1, 400),
  /**
   * SoDEX data-host requests per minute (rankings, rank lookups, charts). One a
   * second: a list refresh alone is 20-40 pages, and at 30 the rank lookups of
   * stream-seen wallets waited hours behind them.
   */
  sodexDataPerMin: () => envNum('VALUESCAN_INDEX_SODEX_DATA', 60, 6, 240),
  /** Set to 0 to run without the live streams (REST only). */
  streams: () => process.env.VALUESCAN_INDEX_STREAMS !== '0',
};

/** The Copy page's windows (web copy/gridModel.ts GRID_WINDOWS): their 'any' boards, top and worst, are its leaders. */
export const COPY_WINDOWS: ReadonlySet<BoardWindow> = new Set(['7d', '30d', 'all']);
/** How far back a SoDEX copy leader's fills are read (the copy setup replays 30 days for 24H, 7D and 30D). */
export const COPY_BACK_DAYS = 30;
/** The fills one copy setup replays (web copy/useCopy.ts FILL_LIMIT): a leader holding this many since its held start needs no older page. */
export const COPY_FILLS = 5_000;
/** A copy leader's place in the leader backfill: the default view's (30D top) first, then 30D worst, 7D, All. */
export function copyLeaderPrio(window: BoardWindow, side: Side, i: number): number {
  return (window === '30d' ? 3_000 : window === '7d' ? 2_000 : 1_000) + (side === 'top' ? 500 : 0) + Math.max(0, 100 - i);
}

const REBUILD_MS = 60_000;
/** Per-trader answers are reused this long unless the trader's data changed. */
const CACHE_MS = 5 * 60_000;
/**
 * An answer for a trader with no new data since is reused across one whole
 * build (1.5x the last one), up to this long. A build on a cold disk outlasts
 * CACHE_MS, and without this every build recomputed every trader from the
 * disk, which kept the next build just as slow (Tokyo, 2026-10-23: 11-25 min).
 */
const MAX_REUSE_MS = 30 * 60_000;
/** Above this many cached answers, the ones too old to be reused are dropped. */
const CACHE_MAX = 50_000;
/**
 * A board's window start for its trade counts and win rates: rounded down to a quarter of an hour, so
 * it holds across the builds of that quarter and a window's first, partial day is read once per quarter
 * (store.ts partialDayAsync keeps it while that day's rows stand). Moving with every build, it was read
 * for every candidate on every build - 20% of the indexer's thread (profiled 2026-10-31). A window takes
 * in up to 15 minutes more: under 1% of a day, 0.15% of a week.
 */
const STATS_FROM_STEP = 15 * 60_000;
export function statsFrom(window: BoardWindow, now: number): number {
  const f = windowStart(window, now);
  return f > 0 ? Math.floor(f / STATS_FROM_STEP) * STATS_FROM_STEP : f;
}

/** Stream-discovered SoDEX wallets are re-queued for lookups this often per window. */
const LOOKUP_SCAN_MS = 10 * 60_000;
const FLUSH_MS = 5_000;
/**
 * How long a flush keeps the thread at a time. 40 ms when it is keeping up, and as long as everything else held the thread
 * since its last turn (so about half of it, whatever the turns cost), both up to FLUSH_TURN_MS. That is what a flat 40 ms
 * lacked: other sliced work takes a fixed piece each turn, so a much shorter slice starves. Two seconds a turn, the cap until
 * 2026-11-06, was the lag itself: every socket, timer and request waited 4-14 s a turn, and requests timed out on it.
 * Only far behind (past FLUSH_FAR steps, about ten minutes of rows) does it climb back to 2 s: rows waiting are data users
 * do not have (at 500 ms flat the queue grew at 5,600 steps on 2026-11-05, at twice today's cost a row).
 */
export const FLUSH_TURN_MS = 400;
const FLUSH_FAR = 2_000;
export const flushBudget = (backlog: number, gapMs = 0): number =>
  Math.min(2_000, Math.min(FLUSH_TURN_MS, Math.max(40 + backlog, gapMs)) + Math.max(0, backlog - FLUSH_FAR) / 2);

/**
 * In the fills' key order: rows of one wallet then go to the same pages in one transaction, instead of each
 * touching and rewriting its own. The same rows, and the sort is stable: copies of one id keep their order.
 */
export const inKeyOrder = <T extends { venue: string; address: string; id: string }>(rows: T[]): T[] =>
  rows.sort((a, b) => (a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : a.address < b.address ? -1 : a.address > b.address ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
/**
 * How long a board build holds the thread before it lets the loop in. At 40 ms and a turn of everything else taking hundreds of ms,
 * a build got about a tenth of the thread: the first one after a restart took 41 minutes on 2026-11-06, and users read 1d PnL off
 * boards that old. The build's own reads were 5-8% of a 30 s profile, so it is starved, not heavy.
 */
const BUILD_TURN_MS = 120;
/**
 * Rows per transaction in a flush. A step is the least the thread can be held for, and a fill is no fixed cost: 150 of them were up
 * to 1.2 s on production (profile 2026-11-06). The rows are in key order across steps, and a laptop's file wrote 50 rows a
 * transaction no slower than 500 a row (0.08 ms against 0.10 ms), so the shorter hold costs no throughput.
 */
const FLUSH_FILLS = 50;
const FLUSH_ACTIVITY = 300;
/** This thread's heap: near its limit it is all garbage collection, then a crash (2026-11-25: 8.37 of 8.79 GB, stalls of 10-70 s for hours). */
const heapMb = (): { used: number; limit: number } => {
  const h = getHeapStatistics();
  return { used: Math.round(h.used_heap_size / 1048576), limit: Math.round(h.heap_size_limit / 1048576) };
};
/** How long the SoDEX checks wait for the catch-up to cover the newest break. */
const BREAK_FRESH_MS = 20 * 60_000;
/**
 * The writer thread's queue is kept short (2026-11-23: every 5 s flush went to it at once; it fell behind and held 14.5M rows
 * twice over, 18 GB, each flush's rows sorted among themselves only). Past WRITER_HOLD_ROWS the next flush waits here:
 * activity of one account and hour adds up to one row, and the fills of all the waiting time go in one key order.
 */
export const WRITER_HOLD_ROWS = 20_000;
/** Rows of one op to the thread: a longer list holds this thread while it is copied over. */
const WRITER_SEND_ROWS = 5_000;
/** Fills held past this go to the spill on disk (appends) and come back as the thread catches up. */
export const FILLS_HELD_MAX = 400_000;
const OVERFLOW_PART = 200;
const OVERFLOW_TURN = 4_000;
/** Spilled parts with the writer thread at once (all at once read the whole spill into memory: 22,003 parts on 2026-11-23). */
const REPLAY_WINDOW = 64;
/** A start's replay: parts a batch, sent once fewer than this many rows wait at the thread. */
const REPLAY_BATCH = 60;
const REPLAY_IDLE_ROWS = 4_000;
/** With live rows always waiting (2026-11-25: 8.3M spilled rows and not one written back in hours): a small batch this often, unless the flushes wait. */
const REPLAY_BUSY_MS = 10_000;
const REPLAY_BUSY_BATCH = 10;
/** A held range this fresh answers for "now" even without the stream. */
const STALE_MS = 10 * 60_000;
/** Candidates waiting for a trade check per board before the walk stops. */
const MAX_PENDING = 60;
/** Board members' histories are re-synced this often (fees, PnL, closes). */
const RESYNC_MS = 2 * 60 * 60_000;
const AV_MS = 2 * 60 * 60_000;
/** 90d / ytd candidates from charts are re-read this often. */
const CHART_POOL_MS = 12 * 60 * 60_000;
/** HL 90d / ytd chart pool: this many from each end of the all-time and 30-day PnL lists. */
const HL_CHART_POOL_EACH = 250;
/** SoDEX rank lookups are refreshed after this long, per window. */
const LOOKUP_TTL: Record<Window, number> = { '1d': 3 * 3600_000, '7d': 6 * 3600_000, '30d': 12 * 3600_000, all: 24 * 3600_000 };
/**
 * Stream-seen SoDEX wallets looked up per window, most volume first. At 3,000
 * the lookups alone needed ~40 of the data host's 60 requests a minute and the
 * lane never caught up; 1,500 is ~16 a minute.
 */
const LOOKUP_ACTIVE = 1_500;
/** Traders not wanted by any board for this long lose their history. */
const FORGET_AFTER_MS = 14 * DAY_MS;

/**
 * A stream outage shorter than this does not break the continuity of the
 * ALL-ACCOUNT activity counts (restarts, reconnects). Per-wallet fill
 * coverage is stricter: it follows the socket itself (advanceCoverage), and a
 * wallet whose held range stops before the socket came up is read again for
 * exactly the gap (queueHistory's catch-up).
 */
const STREAM_GAP_MS = 2 * 60_000;
/** How often held ranges of streamed wallets are moved up to "now". */
const ADVANCE_MS = 30_000;
/** Rank change compares with the board about this long ago (or the oldest snapshot at least an hour old). */
const RANK_BACK_MS = DAY_MS;
/** Indexed wallets per venue whose figures are refreshed per pass beyond the boards (trader_stats). */
const STATS_SWEEP = 50;
/** The most one build spends on sweepStats (all venues together); VALUESCAN_INDEX_SWEEP_MS, 30 s to 30 min. */
const sweepBudgetMs = () => envNum('VALUESCAN_INDEX_SWEEP_MS', 4 * 60_000, 30_000, 30 * 60_000);
const STATS_WINDOWS: readonly BoardWindow[] = ['1d', '7d', '30d', 'all'];
/** History kinds whose fills the streams write for a tracked wallet. */
const STREAM_KINDS: Record<Venue, HistoryKind[]> = { hyperliquid: ['fills'], tradexyz: ['fills'], sodex: ['perps', 'spot'], lighter: ['fills'], arcus: ['fills'] };
/** Hour buckets serve windows up to this long; longer ones use day buckets. */
const HOUR_WINDOWS: ReadonlySet<BoardWindow> = new Set(['1d', '7d', '30d']);
const HOUR_RETAIN = 36 * 24;
/**
 * Daily all-time PnL snapshots kept: the 90d window reads the one 90 days
 * back (ten days of slack for days the indexer was down), ytd the one at 1
 * January, which is kept apart. They were kept 400 days: ~150k rows a day.
 */
const CUM_KEEP_DAYS = 100;
/**
 * Retention (store.pruneStep): raw fills and closes older than the kept days
 * are frozen into their day rows and deleted, this many ms of work a second.
 * Not in the first minute after a start.
 */
const PRUNE_EVERY_MS = 1_000;
const PRUNE_BUDGET_MS = 20;
const PRUNE_START_MS = 60_000;

/** Each venue's netting pool: this many from each end of its PnL ranking. */
const POOL_EACH = 300;
/** Of those, this many from each end get their PnL looked up on the other venues. */
const CROSS_EACH = 150;
/** A SoDEX wallet the rank lookup does not know is not asked again for this long. */
const UNRANKED_TTL = 12 * 60 * 60_000;

const WINDOW_WEIGHT: Record<BoardWindow, number> = { '30d': 600, '7d': 500, '1d': 400, all: 300, '90d': 200, ytd: 100 };

/**
 * Read priorities, highest first. Every lane serves the highest priority
 * queued, so these tiers decide what a budget is spent on:
 *   WATCH_PRIO   rows on a page someone is looking at right now
 *   VIS_PRIO+    the top 100 of the 30d, 7d and 1d boards (what the
 *                leaderboard opens on), 30d first, rank 1 first
 *   <= ~8,000    trade checks of candidates, other boards, bulk work
 * (Until 2026-09-30 a visible row's read could sit forever behind endless
 * trade checks: a read first queued from a lower board kept its low
 * priority, and a 30d top-100 row on HL had no history 10 h later.)
 */
export const WATCH_PRIO = 30_000;
export const VIS_PRIO = 20_000;
const VIS_WINDOW: Partial<Record<BoardWindow, number>> = { '30d': 3_000, '7d': 2_000, '1d': 1_000 };

/** The priority of a board row's reads: the visible tier for the top 100 of 30d / 7d / 1d, else `dflt`. */
/**
 * A read's priority from what it is for. For a visible row (prio >= VIS_PRIO):
 * a wallet with NOTHING held goes first (+4,000: one cheap newest page gives it
 * trades, closes and a range to now), then catch-ups of what the stream
 * missed, then the periodic resync (-8,000), then reaching back to the window
 * start (-10,000: the expensive part, many pages). All stay above the trade
 * checks (<= ~8,000). Other rows keep `prio`.
 */
export function readPrio(prio: number, need: 'first' | 'catchup' | 'resync' | 'back'): number {
  if (prio < VIS_PRIO || prio >= WATCH_PRIO) return need === 'first' && prio >= WATCH_PRIO ? prio + 1 : prio;
  if (need === 'first') return prio + 4_000;
  if (need === 'catchup') return prio;
  return prio - (need === 'resync' ? 8_000 : 10_000);
}

export function rowPrio(window: BoardWindow, side: 'top' | 'worst', rank0: number, dflt: number): number {
  const w = VIS_WINDOW[window];
  return w !== undefined && side === 'top' && rank0 < BOARD_SIZE ? VIS_PRIO + w + (BOARD_SIZE - rank0) * 5 : dflt;
}
/** Addresses watched (on screen) stay urgent this long. */
const WATCH_MS = 15 * 60_000;

const isPublished = (w: BoardWindow): w is Window => (WINDOWS as readonly string[]).includes(w);

/**
 * Whether a stream-seen SoDEX wallet's rank lookup is due: not while its PnL
 * is fresh, and not while SoDEX said "not ranked" less than UNRANKED_TTL ago
 * (those were asked again every 10 minutes, ~3.6k lookups of the data host).
 */
export function lookupDue(heldAt: number | null, unrankedAt: number | null, now: number, ttl: number): boolean {
  if (heldAt !== null && now - heldAt < ttl) return false;
  if (unrankedAt !== null && now - unrankedAt < UNRANKED_TTL) return false;
  return true;
}

interface ActRec { trades: number; volume: number }
interface StreamState { since: number | null; lastUp: number }
/** A stream outage seen on (re)connect: [down from, up again], and whether it broke the activity span. */
interface StreamGap { from: number; to: number; broke: boolean; covered?: boolean }
/** One board pick's figures from what the index holds. */
/** Rows of a flush not written yet; `spilled` tells the flush they went to the spill instead. */
type UnwrittenPart =
  | { kind: 'activity'; rows: Array<{ venue: Venue; acct: string; hour: number; trades: number; volume: number }>; spilled: () => void }
  | { kind: 'fills'; rows: import('./store.js').FillRow[]; spilled: () => void };

/**
 * The per-trader answers a build reuses (cache), handed from a stop to the next start: the first build after a start
 * computed every candidate again (pools 78.8 s of a 352 s build on 2026-11-06 against 2-18 s after). Only answers this
 * young are kept, and one whose trader changed since it was computed is reused only as long as a changed one ever is.
 */
const WARM_FILE = 'warm-cache.json';
const WARM_FORMAT = 'warm-1';
/** A handover's buffer is applied this long at a time, the loop let in between (sockets keep delivering to its end). */
const HANDOVER_SLICE_MS = 20;

/** What a handover's standby hands the engine (handover.ts): its sockets, what they buffered, and the boundary. */
export interface HandoverStart {
  tap: PrintTap;
  buffer: PrintBuffer;
  sources: Sources;
  /** The outgoing process's (null: it ended without one - a crash midway). */
  boundary: Boundary | null;
  /** Buffered prints older than this are snapshots of what the outgoing process took. */
  floor: number;
}
const WARM_MAX_AGE_MS = MAX_REUSE_MS;

interface PickStats {
  stats: import('./store.js').WindowStats;
  covered: boolean;
  capped: boolean;
  /** Every close in the window is held. */
  wrExact: boolean;
  /** The oldest held close of an estimate (the later of window start and held range). */
  wrFrom: number | null;
}

export class Indexer {
  readonly hl: Lane;
  readonly sgw: Lane;
  /** One account-trades read for a wallet its closes and the stream cannot answer for (queueCheck). */
  readonly scheck: Lane;
  /** When each check was last asked (key -> ms): a wallet the read could not decide is not asked again at once. */
  private checkAsked = new Map<string, number>();
  /**
   * SoDEX stream breaks the catch-up may yet answer for, oldest first; `since`: the span they cut short. Kept in the
   * index (STREAM_PENDING_META), as a restart comes on top of a restart when several releases follow each other.
   */
  private sodexBreaks: Array<{ from: number; to: number; since: number }> = [];
  readonly strades: Lane;
  /** SoDEX Copy page leaders (copyLeaderPrio), with the build that last listed them. */
  private copyLeaders = new Map<string, { prio: number; at: number }>();
  /** `h:<engine>:<address>` -> the held start at which the leader was found to hold COPY_FILLS fills (queueLeaderTrades). */
  private leaderDeep = new Map<string, number>();
  readonly sdata: Lane;
  private hlStream: HlStream | null = null;
  private sodexStream: SodexStream | null = null;
  /** Where sockets this engine adopts or a test factory makes deliver (printSources.ts). */
  private readonly tap = new PrintTap();
  /** The handover this process started from: what its buffer held and what the boundary did (status, tests). */
  handover: { prints: number; applyMs: number; dropped: number; filter: string; at: number } | null = null;
  private timers: NodeJS.Timeout[] = [];
  private walletBackfill: WalletBackfill | null = null;
  private listSnap: Partial<Record<Window, number>> = {};
  private listCheckAt: Partial<Record<Window, number>> = {};
  private chartPoolAt = Object.fromEntries(VENUES.map((v) => [v, 0])) as Record<Venue, number>;
  private cumDay = Object.fromEntries(VENUES.map((v) => [v, 0])) as Record<Venue, number>;
  /** trade.xyz, Lighter and Arcus: ranked through the generic machinery (ext/). */
  readonly ext = new Map<Venue, ExtVenue>([
    ['tradexyz', new TradexyzVenue()],
    ['lighter', new LighterVenue()],
    ['arcus', new ArcusVenue()],
  ]);
  private trackedExt = new Map<Venue, Set<string>>();
  /** Addresses a board wants indexed, with when they were last wanted. */
  private wanted = new Map<string, number>();
  private watchedHl = new Set<string>();
  /** On-screen rows per venue: address -> [window start it is shown for, when]. */
  private watched = new Map<Venue, Map<string, { from: number; at: number }>>();
  /** The earliest window start a queued history read must reach (a read may be raised by a longer board). */
  private histFrom = new Map<string, number>();
  /** What the build is doing, for the loop-lag spikes. */
  private step = '';
  private trackedHl = new Set<string>();
  private trackedSodex = new Map<number, string>();
  private act = new Map<string, ActRec>();
  private lastOrder = new Map<string, string>();
  private pendingFills: import('./store.js').FillRow[] = [];
  /** Rows handed to `writes` and not written yet, in the order they were queued. */
  private unwritten = new Set<UnwrittenPart>();
  /** A stop is moving the unwritten rows to the spill: the flush only queues. */
  private spilling = false;
  /** Flushes through the writer thread, each one's rest after the one before (flushThrough). */
  private flushChain: Promise<void> = Promise.resolve();
  /** Rows of the flush being handed to the writer thread and not sent yet (a stop spills them). */
  private unsentFills: import('./store.js').FillRow[] = [];
  private unsentActivity: Array<{ venue: Venue; acct: string; hour: number; trades: number; volume: number }> = [];
  private handing = false;
  /** When each flush not written yet was taken, and since when rows wait here for the thread. */
  private openFlushes: number[] = [];
  private heldSince = 0;
  /** Rows moved to the spill while running; replays of it under way (the coverage stands still meanwhile). */
  private overflowed = 0;
  private overflowing = false;
  private replaying = 0;
  /** Rows overflow() has not written to the spill yet (a stop spills them). */
  private overflowLeft: import('./store.js').FillRow[] = [];
  /** When the last flush took its rows (a stop moves the streams' span to it). */
  private lastFlushAt = 0;
  /** Rows the last stop spilled (its timing line). */
  private spilledRows = 0;
  /** Samples the thread all the time and keeps the last minute when it stalls (stallProfiler.ts). */
  private stallProfiler: StallProfiler | null = null;
  /** What a flush writes, with the loop let in between slices. */
  private writes = new SlicedWork({
    // v0.2.165 ran a flat 40 ms a turn: on a busy thread each turn took long enough that writes fell behind for
    // good (781 steps queued, then 1,041 three minutes later). The more waits, the longer it may run.
    budgetMs: flushBudget,
    onError: (e) => { this.lastError = `flush: ${String(e)}`; },
    onResume: () => mark('flush'),
  });
  private streamState = Object.fromEntries(VENUES.map((v) => [v, { since: null, lastUp: 0 }])) as Record<Venue, StreamState>;
  private sodexIdOf = new Map<string, number>();
  private building = false;
  private buildStartedAt = 0;
  private lookupScanAt: Partial<Record<Window, number>> = {};
  private cache = new Map<string, { ver: number; at: number; value: unknown }>();
  private unranked = new Map<string, number>();
  /** Hyperliquid spot `@107` -> `HYPE/USDC`, refreshed each pass. */
  private coinName: (c: string) => string = (c) => c;
  private stopped = false;
  lastBuildMs = 0;
  lastBuildAt = 0;
  /** venue -> how long its boards took in the last build (ms). */
  lastBuildVenueMs: Partial<Record<Venue, number>> = {};
  /**
   * The last build's steps (ms), in order. Only the total and the boards per venue were kept until
   * 2026-10-31, when builds went from under a minute to 8-33 min and no step could be named.
   */
  lastBuildStepMs: Record<string, number> = {};
  lastError: string | null = null;
  /** Cohorts: members, their positions, and the figures per set of venues. */
  readonly cohorts: CohortTracker;
  /** SoDEX account id -> address, for stream prints (they carry ids). */
  private sodexAddrOf = new Map<number, string>();
  /** Every print kept for the per-candle breakdown (flow/recorder.ts, on its own thread: flow/thread.ts); off with VALUESCAN_FLOW=0. */
  flow: FlowFeed | null = null;
  private sodexCatchup: SodexCatchup | null = null;
  private arcusCatchup: ArcusCatchup | null = null;
  private coverageLedger: LedgerThread | null = null;
  /**
   * Event-loop health: the worst delay a 500 ms tick saw in the last minute.
   * A long synchronous stretch here makes every upstream request look like a
   * timeout (the abort timer runs before the late response is read).
   */
  private lag = { max: 0, maxAt: 0, window: 0 };
  /** The last long stalls, each with what was running when it began. */
  private spikes: Array<{ late: number; at: number; by: string | null }> = [];
  private gcWatch: PerformanceObserver | null = null;
  private gaps = Object.fromEntries(VENUES.map((v) => [v, [] as StreamGap[]])) as Record<Venue, StreamGap[]>;
  private advancedAt = 0;
  /** Board key -> the hour its ranks were last snapshotted. */
  private rankSnapAt = new Map<string, number>();
  private statsSweep = Object.fromEntries(VENUES.map((v) => [v, 0])) as Record<Venue, number>;
  /** Which venue sweepStats starts with this build. */
  private sweepTurn = 0;
  private pendingStats: TraderStatsRow[] = [];
  /** SoDEX accounts whose analytics booked a balance as profit (sodex/mappers.ts chartSuspect). */
  private suspectSodex = new Set<string>();

  constructor(readonly store: IndexStore, private readonly now: () => number = Date.now) {
    this.tap.sink = (p) => this.onPrint(p);
    // The read's own time counts toward its rest (2026-11-08: 12,148 weight in 2.6 h, ~78 of the 200 a minute it may spend -
    // each page's write takes seconds on the busy thread, and the full rest came on top). Still at most perMin on average.
    this.hl = new Lane({ name: 'hl', perMin: INDEXER_ENV.hlWeightPerMin(), creditTaskTime: true });
    // SoDEX gateway lanes count requests. Both stand back while any cooldown
    // runs (the trading UI shares the IP) or this process has spent a third of
    // the gateway's minute (the limit SoDEX reports: 6000 on 2026-10-31), and
    // pause 15 minutes after a 429.
    const sodexGate = () => Math.max(cooldownLeftMs(), sodex.cooldownLeft(), gatewayWeightSpent() > gatewayWeightLimit() / 3 ? 5_000 : 0);
    this.sgw = new Lane({ name: 'sgw', perMin: INDEXER_ENV.sodexClosesPerMin(), gate: sodexGate, rateLimitPauseMs: 15 * 60_000, creditTaskTime: true });
    // Not while a break may yet be answered: the check will not need the read.
    this.scheck = new Lane({ name: 'scheck', perMin: INDEXER_ENV.sodexChecksPerMin(), gate: () => Math.max(sodexGate(), this.breakFresh() ? 5_000 : 0), rateLimitPauseMs: 30 * 60_000 });
    // The indexer's only SoDEX `/trades` reader (off unless VALUESCAN_INDEX_SODEX_TRADES
    // is set). Each task reads ONE page (syncTrades maxPages: 1) and the lane then
    // rests, so its rate is `perMin`, capped at SODEX_HISTORY_PAIR_PER_MIN: the
    // measured /trades + /orders/history counter (~4 per 60 s per IP, then 1015).
    // With that off, the same lane reads the Copy page's leaders only (sodexLeaderTradesPerMin, queueHistory).
    this.strades = new Lane({
      name: 'strades',
      perMin: INDEXER_ENV.sodexTradesEnabled() ? INDEXER_ENV.sodexTradesPerMin() : Math.max(0.05, INDEXER_ENV.sodexLeaderTradesPerMin()),
      gate: sodexGate,
      rateLimitPauseMs: 30 * 60_000,
    });
    this.sdata = new Lane({ name: 'sdata', perMin: INDEXER_ENV.sodexDataPerMin(), gate: () => cooldownLeftMs() });
    const lighter = this.ext.get('lighter') as LighterVenue;
    const arcus = this.ext.get('arcus') as ArcusVenue;
    this.cohorts = new CohortTracker({
      store,
      now,
      hlSnapshot: () => this.hlSnapshot(),
      streamSince: (v) => this.streamSince(v),
      lighter: { lane: lighter.lane, pacer: lighter.pacer, learn: (a, idx) => lighter.learn(a, idx), known: (a) => lighter.accountsOf(a) !== null },
      arcus: { lane: arcus.lane, pacer: arcus.pacer },
      sodexGate,
      socketUp: (v) => this.socketOf(v) !== null,
      // A history rebuild's reads come out of the boards' share while they run (cohortTracker REBUILD_PER_MIN).
      lendHl: (w) => this.hl.setPerMin(Math.max(60, INDEXER_ENV.hlWeightPerMin() - w)),
    });
  }

  /**
   * `handover`: this process takes over from a running one (handover.ts) - its sockets are the standby's, already up, and
   * what they buffered goes in through the boundary once everything else has started.
   */
  start(opts: { handover?: HandoverStart } = {}): void {
    this.stopped = false;
    const pre: Sources | null = opts.handover?.sources ?? sourceFactory()?.(this.tap.emit) ?? null;
    // What keeps the thread before the sockets can open is named in the journal: a restart's gap is mostly this.
    let lapAt = Date.now();
    const lap = (name: string) => {
      const t = Date.now();
      if (t - lapAt >= 1_000) console.log(`[indexer] start: ${name} ${t - lapAt} ms`);
      lapAt = t;
    };
    for (const [id, a] of this.store.accountIds('sodex')) {
      seedAddress(id, a);
      this.sodexIdOf.set(a, id);
      this.sodexAddrOf.set(id, a);
    }
    for (const venue of VENUES) {
      const since = Number(this.store.getMeta(`stream_since:${venue}`));
      const lastUp = Number(this.store.getMeta(`stream_up:${venue}`));
      this.streamState[venue] = { since: since > 0 ? since : null, lastUp: lastUp > 0 ? lastUp : 0 };
      try {
        const g = JSON.parse(this.store.getMeta(`stream_gaps:${venue}`) ?? '[]');
        if (Array.isArray(g)) this.gaps[venue] = g.slice(-10);
      } catch { /* none */ }
    }
    try {
      const b = JSON.parse(this.store.getMeta(STREAM_PENDING_META) ?? '[]');
      if (Array.isArray(b)) this.sodexBreaks = b.filter((x) => x && x.from > 0 && x.to > 0 && x.since > 0);
    } catch { /* none */ }
    // Every wallet with a held range is tracked BEFORE the streams open: a print
    // for it must land in its fills from the first second, or a range moved up
    // with the socket (advanceCoverage) would claim fills it never got.
    this.trackedHl = new Set(this.store.indexedAddresses('hyperliquid'));
    for (const venue of this.ext.keys()) this.trackedExt.set(venue, new Set(this.store.indexedAddresses(venue)));
    const sodexHeld = new Set(this.store.indexedAddresses('sodex'));
    for (const [id, a] of this.store.accountIds('sodex')) if (sodexHeld.has(a)) this.trackedSodex.set(id, a);
    // Day aggregates built under the older close definition are re-summed in the background.
    lap('accounts and tracked wallets');
    this.store.migrateCloses();
    lap('closes migration');
    // "Not ranked" answers survive restarts: those wallets are not asked again for UNRANKED_TTL.
    this.unranked = this.store.unrankedSince('sodex', this.now() - UNRANKED_TTL);
    // What the last stop handed over: its rows not yet written (first in the write queue), its build answers and its
    // Hyperliquid leaderboard (the first build waited 84.5 s for a fresh download on 2026-11-06).
    this.replaySpill();
    const warm = this.loadWarm();
    const lb = this.loadHlSnapshot();
    if (warm || lb) console.log(`[indexer] start: ${warm} build answers kept from the last stop${lb ? `, its HL leaderboard (${Math.round(lb / 60_000)} min old)` : ''}`);
    lap('last stop handover');
    this.hl.start();
    this.sgw.start();
    this.scheck.start();
    this.strades.start();
    this.sdata.start();
    for (const x of this.ext.values()) {
      x.start({
        store: this.store, now: this.now, streamSince: (v) => this.streamSince(v), onPrint: (p) => this.onPrint(p), hlLane: this.hl,
        // A standby without a socket for one (Lighter's market list not read yet): the venue opens its own, as on any start.
        ...(pre ? { adopt: { lighter: pre.lighter ?? (opts.handover ? undefined : null), arcus: pre.arcus ?? (opts.handover ? undefined : null) } } : {}),
      });
    }
    lap('lanes and venues');
    if ((INDEXER_ENV.streams() || pre) && process.env.VALUESCAN_FLOW !== '0' && !this.flow) {
      try {
        const path = process.env.VALUESCAN_FLOW_DB?.trim() || join(dirname(this.store.path), 'valuescan-flow.db');
        this.flow = startFlow(path, (venue, acct) =>
          venue === 'sodex' ? this.sodexAddrOf.get(Number(acct)) ?? null : this.ext.get(venue)?.addressOf?.(acct) ?? null);
      } catch (e) {
        this.lastError = `flow: ${String(e)}`;
      }
    }
    lap('who traded recorder');
    if (INDEXER_ENV.streams() || pre) {
      if (pre) {
        this.hlStream = pre.hyperliquid;
        this.sodexStream = pre.sodex;
      } else {
        this.hlStream = new HlStream((p) => this.onPrint(p));
        this.sodexStream = new SodexStream((p) => this.onPrint(p));
        this.hlStream.start();
        this.sodexStream.start();
      }
      if (this.flow && this.sodexStream && process.env.VALUESCAN_SODEX_CATCHUP !== '0') {
        const stream = this.sodexStream;
        const flow = this.flow;
        this.sodexCatchup = new SodexCatchup((rows) => this.heldChecked(flow, () => stream.catchUp(rows, (prints) => flow.missing(prints))), streamLog);
        this.sodexCatchup.start();
      }
      if (this.flow && process.env.VALUESCAN_ARCUS_CATCHUP !== '0') {
        const flow = this.flow;
        const arcus = this.ext.get('arcus') as ArcusVenue;
        // Who traded and activity take a print of any age. The books and marks only a recent one: an hour-old price is no mark,
        // and a book read since already holds it.
        const sink = (p: Print) => this.onPrint(p, this.now() - p.t > CATCHUP_BOOK_MS);
        this.arcusCatchup = new ArcusCatchup(
          (rows) => this.heldChecked(flow, () => arcus.catchUp(rows as ArcusWsTrade[], (prints) => flow.missingNear(prints, ARCUS_NEAR_MS), sink)),
          streamLog,
          {
            load: () => { try { return JSON.parse(flow.getMeta(ARCUS_CATCHUP_META) ?? '{}') as Record<string, number>; } catch { return {}; } },
            save: (through) => flow.setMeta(ARCUS_CATCHUP_META, JSON.stringify(through)),
          },
        );
        this.arcusCatchup.start();
      }
      if (this.flow && process.env.VALUESCAN_SODEX_LEDGER !== '0') this.coverageLedger = startLedgerThread({ flow: this.flow.path, index: this.store.path }, streamLog);
    }
    const backfillRate = INDEXER_ENV.walletBackfillPerMin();
    if (backfillRate > 0) {
      this.walletBackfill = new WalletBackfill({
        db: new WalletHistoryDb(),
        tradesPerMin: backfillRate,
        pageSource,
        accounts: () => this.store.backfillAccounts(),
        gate: () => Math.max(cooldownLeftMs(), sodex.cooldownLeft(), gatewayWeightSpent() > gatewayWeightLimit() / 3 ? 5_000 : 0),
        isRateLimited,
        log: (line) => console.log(`[indexer] ${line}`),
      });
      this.walletBackfill.start();
    }
    const every = (ms: number, fn: () => void | Promise<void>, name = 'timer') => {
      const t = setInterval(() => within(name, () => { void Promise.resolve(fn()).catch((e) => (this.lastError = String(e))); }), ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(FLUSH_MS, () => this.flushTick(), 'flush');
    if (this.flow) every(1_000, () => this.flow?.tick(), 'flow');
    // Traders' day aggregates build in the background, ~40 ms at a time.
    // (Both are synchronous: an error is noted, never thrown out of the timer - that would end the worker.)
    let aggTick = Date.now();
    every(250, () => {
      // Re-sums (housekeeping) run only in steps that start on time: a late step means the loop is busy.
      const late = Date.now() - aggTick - 250;
      aggTick = Date.now();
      try {
        this.store.buildAggregates(40, late > 150 ? 0 : 25);
      } catch (e) {
        this.lastError = `aggregates: ${String(e)}`;
      }
    }, 'aggregates');
    // Retention: a slice of pruning a second, once the start has settled.
    const prune = setTimeout(() => {
      if (this.stopped) return;
      every(PRUNE_EVERY_MS, () => {
        try {
          this.store.pruneStep(PRUNE_BUDGET_MS, this.now());
        } catch (e) {
          this.lastError = `retention: ${String(e)}`;
        }
      }, 'prune');
    }, PRUNE_START_MS);
    prune.unref?.();
    this.timers.push(prune);
    // VALUESCAN_INDEX_BUILD=0: no board builds (the handover test runs real indexer processes with no venue to read).
    const builds = process.env.VALUESCAN_INDEX_BUILD !== '0';
    if (builds) every(REBUILD_MS, () => this.rebuild(), 'rebuild');
    try {
      this.gcWatch = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) noteGc(performance.timeOrigin + e.startTime, e.duration);
      });
      this.gcWatch.observe({ entryTypes: ['gc'] });
    } catch { /* the stall lines then say 0 s of it */ }
    // Off unless asked for (2026-11-25): each profile's end and start held the thread ~3 s (61 s over the last 20), a stall of its own after each stall.
    if (process.env.VALUESCAN_STALL_PROFILE === '1' && this.store.path !== ':memory:') {
      this.stallProfiler = new StallProfiler(join(dirname(this.store.path), 'profiles'), 'indexer-stall');
      this.stallProfiler.start();
    }
    let tick = Date.now();
    every(500, () => {
      const now = Date.now();
      const late = Math.max(0, now - tick - 500);
      this.stallProfiler?.onLag(late, now);
      if (late >= 1_000) {
        const by = startedBefore(tick + 500);
        this.spikes.push({ late, at: now, by });
        if (this.spikes.length > 8) this.spikes.shift();
        if (late >= STALL_LOG_MS) {
          // A second later: the observer's entries for the stall are delivered after it.
          const from = now - late;
          const said = setTimeout(() => streamLog(`thread stalled ${Math.round(late / 1000)} s, started by ${by ?? 'unknown'}, of it garbage collection ${Math.round(gcWithin(from, now) / 1000)} s`), 1_000);
          said.unref?.();
        }
      }
      tick = now;
      if (now - this.lag.maxAt > 60_000) this.lag.window = 0;
      if (late >= this.lag.window) { this.lag.window = late; this.lag.maxAt = now; }
      this.lag.max = Math.max(this.lag.max, late);
    });
    lap('streams and timers');
    if (process.env.VALUESCAN_INDEX_COHORTS !== '0') this.cohorts.start();
    lap('cohorts');
    if (builds) setTimeout(() => void this.rebuild().catch((e) => (this.lastError = String(e))), 3_000).unref?.();
    if (opts.handover) this.applyHandover(opts.handover);
  }

  /**
   * The standby's buffer through the boundary (handover.ts BoundaryFilter), a slice at a time with the loop let in: the
   * sockets keep adding to the buffer until it is empty, then deliver here directly, through the filter for
   * FILTER_TAIL_MS more. The outgoing process's "one trade per account and block" goes on here, and the flow recorder
   * trusts the boundary instead of its restart check.
   */
  private applyHandover(h: HandoverStart): void {
    const filter = new BoundaryFilter(h.boundary, h.floor);
    for (const [k, v] of h.boundary?.lastOrder ?? []) this.lastOrder.set(k, v);
    if (h.boundary) {
      const froms = Object.values(h.boundary.venues).map((v) => v!.from);
      this.flow?.continueHandover(froms.length ? Math.min(...froms) : h.boundary.stoppedAt);
    }
    // Every Hyperliquid market on this socket now: the outgoing one's subscriptions went with its socket.
    this.hlStream?.takeAll?.();
    for (const after of [5_000, 30_000]) {
      const t = setTimeout(() => {
        const n = this.hlStream?.subscribeMissing?.() ?? 0;
        if (n) streamLog(`handover: ${n} Hyperliquid markets not confirmed ${after / 1000} s after the takeover, asked again`);
      }, after);
      t.unref?.();
      this.timers.push(t);
    }
    const buf = h.buffer.prints;
    const t0 = Date.now();
    let i = 0;
    let tail = true;
    const step = () => {
      if (this.stopped) return;
      const end = Date.now() + HANDOVER_SLICE_MS;
      while (i < buf.length && Date.now() < end) {
        const p = buf[i++]!;
        if (filter.admit(p)) this.onPrint(p);
      }
      if (i < buf.length) { setImmediate(step); return; }
      buf.length = 0;
      h.tap.sink = (p) => { if (!tail || filter.admit(p)) this.onPrint(p); };
      this.handover = { prints: i, applyMs: Date.now() - t0, dropped: h.buffer.dropped, filter: filter.line(), at: Date.now() };
      streamLog(`handover: ${i} buffered prints through the boundary in ${Date.now() - t0} ms${h.buffer.dropped ? ` (${h.buffer.dropped} NOT buffered: over the cap)` : ''}${h.boundary ? '' : ' (no boundary: the outgoing process ended without one)'}: ${filter.line() || 'none'}`);
      const t = setTimeout(() => {
        tail = false;
        streamLog(`handover: boundary filter off after ${Math.round(FILTER_TAIL_MS / 60_000)} min: ${filter.line()}`);
      }, FILTER_TAIL_MS);
      t.unref?.();
      this.timers.push(t);
    };
    step();
  }

  /** Each socket's memory of print ids, by venue (a handover names them). */
  private dedups(): Partial<Record<Venue, Dedup>> {
    const out: Partial<Record<Venue, Dedup>> = {};
    if (this.hlStream) out.hyperliquid = this.hlStream.dedup;
    if (this.sodexStream) out.sodex = this.sodexStream.dedup;
    for (const [v, x] of this.ext) {
      const d = x.dedup?.();
      if (d) out[v] = d;
    }
    return out;
  }

  /** A standby said hello (handover.ts): from now on keep every id it may buffer. */
  prepareHandover(): void {
    for (const d of Object.values(this.dedups())) d!.keepAtLeast(KEEP_IDS);
  }

  /** The standby has these Hyperliquid markets: stop taking them here. */
  lendHl(coins: readonly string[]): void {
    this.hlStream?.lend?.(coins);
  }

  /** The standby went away: every lent market back here. */
  unlendHl(): number {
    return this.hlStream?.unlendAll?.() ?? 0;
  }

  /**
   * After stop(), for the standby: per venue every print id taken at its `from` (less FROM_MARGIN_MS) or later and the time
   * it can no longer name prints before, and the "one trade per account and block" memory over the same span.
   */
  handoverBoundary(from: Partial<Record<Venue, number>>, now = Date.now()): Pick<Boundary, 'venues' | 'lastOrder'> {
    const venues: Boundary['venues'] = {};
    let min = Infinity;
    for (const [v, d] of Object.entries(this.dedups()) as Array<[Venue, Dedup]>) {
      const f = from[v] ?? now;
      venues[v] = { from: f, ids: d.since(f - FROM_MARGIN_MS), forgotThrough: d.forgotThrough };
      min = Math.min(min, f);
    }
    const lastOrder = [...this.lastOrder].filter(([, tag]) => Number(tag.slice(0, tag.indexOf('|'))) >= min - FROM_MARGIN_MS);
    return { venues, lastOrder };
  }

  /**
   * `lap`: called after each step with its name, for the stop's timing line (worker.ts). Six stops on 2026-11-06 took
   * 36 s to 19.5 min with nothing in the journal to say which step held them.
   */
  stop(lap: (step: string) => void = () => {}): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.gcWatch?.disconnect();
    this.stallProfiler?.stop();
    this.hl.stop();
    this.sgw.stop();
    this.scheck.stop();
    this.strades.stop();
    this.sdata.stop();
    this.hlStream?.stop();
    this.sodexStream?.stop();
    this.sodexCatchup?.stop();
    void this.walletBackfill?.stop();
    this.arcusCatchup?.stop();
    this.coverageLedger?.stop();
    for (const x of this.ext.values()) x.stop();
    lap('lanes and streams');
    this.cohorts.stop();
    lap('cohorts');
    // The rows still waiting go to the spill in one sequential write (store.spillWrites), not into the fills a slice at a
    // time: written out here, a backlog of minutes of rows took minutes of the stop. The next start writes them first.
    const backlog = this.writes.backlog + (this.store.writerStatus?.pendingOps ?? 0);
    this.spilling = true;
    try {
      const thread = this.store.writerOn;
      this.flush();
      this.spillUnwritten();
      lap(`write backlog (${backlog} steps; spilled ${this.spilledRows} rows)`);
      this.writes.drain();
      if (thread && this.lastFlushAt) {
        // What the drain did for an inline flush, for the flushes the thread was writing: the streams' span moves (their rows
        // are written or spilled; the held ranges stay where they are), and the stats waiting go in.
        try {
          this.store.tx(() => this.trackStreams(this.lastFlushAt));
          this.writeStats();
        } catch (e) {
          this.lastError = `stop: ${String(e)}`;
        }
      }
    } finally {
      this.spilling = false;
    }
    lap('last writes');
    this.saveWarm();
    lap('warm cache');
    if (this.flow) {
      this.flow.stop();
      this.flow = null;
    }
    lap('who traded recorder');
  }

  /** Addresses on screen (profiles, searches) that should be indexed too. */
  watch(venue: Venue, addresses: readonly string[], window: BoardWindow = '30d'): void {
    const now = this.now();
    const from = windowStart(window, now);
    let m = this.watched.get(venue);
    if (!m) this.watched.set(venue, (m = new Map()));
    for (const raw of addresses.slice(0, 100)) {
      const a = raw.toLowerCase();
      const cur = m.get(a);
      m.set(a, { from: Math.min(from, cur && now - cur.at < WATCH_MS ? cur.from : from), at: now });
      this.queueHistory(venue, a, m.get(a)!.from, WATCH_PRIO);
    }
    while (m.size > 300) m.delete(m.keys().next().value!);
    if (venue !== 'hyperliquid') return;
    for (const a of addresses) this.watchedHl.add(a.toLowerCase());
    while (this.watchedHl.size > 200) this.watchedHl.delete(this.watchedHl.values().next().value!);
  }

  /**
   * Since when the venue's stream has run without a gap longer than
   * STREAM_GAP_MS (kept across restarts): since then the stream was connected.
   * That is not every trade: a socket can stay up and lose prints, and only what
   * SoDEX still serves gets added back (measured 2026-11-06, activity held 7-33 %
   * of SoDEX's volume on days inside such a span; per day: flow/ledger.ts,
   * /api/vs/activity/coverage). Null while the stream is down.
   */
  streamSince(venue: Venue): number | null {
    const st = this.streamState[venue];
    if (!st) return null;
    if (this.socketOf(venue) === null && this.now() - st.lastUp > STREAM_GAP_MS) return null;
    return st.since;
  }

  /** When the socket carrying a venue's prints came up (trade.xyz rides Hyperliquid's). */
  private socketOf(venue: Venue): number | null {
    if (venue === 'hyperliquid' || venue === 'tradexyz') return this.hlStream?.since ?? null;
    if (venue === 'sodex') return this.sodexStream?.since ?? null;
    return this.ext.get(venue)?.socketSince() ?? null;
  }

  /**
   * Every ADVANCE_MS: each streamed venue's held ranges that reach into its
   * socket's current connection are moved up to now (store.advanceCoverage).
   * The fills written up to this flush are already stored.
   */
  private advanceCoverage(now: number): void {
    if (now - this.advancedAt < ADVANCE_MS) return;
    this.advancedAt = now;
    for (const venue of VENUES) {
      const up = this.socketOf(venue);
      if (up === null) continue;
      // Markets lent to a standby (handover.ts): their prints go to it, not here, until it takes over or gives them back.
      if ((venue === 'hyperliquid' || venue === 'tradexyz') && (this.hlStream?.lentCount ?? 0) > 0) continue;
      // Lighter prints name sub-accounts: only wallets whose indices are known get their prints.
      this.store.advanceCoverage(venue, STREAM_KINDS[venue], up, now, venue === 'lighter');
    }
  }

  /** Called on every flush: extend or restart each stream's continuous span, and note outages. */
  private trackStreams(now: number): void {
    for (const venue of VENUES) {
      const up = this.socketOf(venue);
      if (up === null) continue;
      const st = this.streamState[venue];
      // A (re)connection after a real outage: remembered, so the status shows what was missed.
      if (st.lastUp > 0 && up - st.lastUp > 5_000 && !this.gaps[venue].some((g) => g.to === up)) {
        this.gaps[venue].push({ from: st.lastUp, to: up, broke: up - st.lastUp > STREAM_GAP_MS });
        if (this.gaps[venue].length > 10) this.gaps[venue].shift();
        this.store.setMeta(`stream_gaps:${venue}`, JSON.stringify(this.gaps[venue]));
      }
      // This connection came up after an outage longer than the tolerance: a new span.
      if (st.since === null || up - st.lastUp > STREAM_GAP_MS) {
        if (venue === 'sodex' && this.sodexCatchup && st.since !== null && st.lastUp > 0) {
          this.sodexBreaks.push({ from: st.lastUp, to: up, since: st.since });
          this.store.setMeta(STREAM_PENDING_META, JSON.stringify(this.sodexBreaks));
        }
        st.since = up;
      }
      if (venue === 'sodex') this.settleBreaks(st);
      st.lastUp = now;
      this.store.setMeta(`stream_since:${venue}`, String(st.since));
      this.store.setMeta(`stream_up:${venue}`, String(st.lastUp));
    }
  }

  /**
   * A break the catch-up has covered is no break: every print of it went in as if the stream had brought it, activity and
   * fills included, so the span runs on from before it. Until then it counts as one. Newest first, as the older ones' spans
   * end where the newer ones' begin; one that is lost ends the span there for good, and whatever came before it with it.
   */
  /** A break the catch-up may still cover soon. Older ones hold no check back (2026-11-23: 540 of them, no check in 16 h). */
  private breakFresh(): boolean {
    const b = this.sodexBreaks[this.sodexBreaks.length - 1];
    return b !== undefined && this.now() - b.to < BREAK_FRESH_MS;
  }

  private settleBreaks(st: { since: number | null }): void {
    const c = this.sodexCatchup;
    if (!c || !this.sodexBreaks.length) return;
    let changed = false;
    while (this.sodexBreaks.length) {
      const b = this.sodexBreaks[this.sodexBreaks.length - 1]!;
      const state = st.since === b.to ? c.watch(b.from, b.to) : 'lost';
      if (state === 'waiting') break;
      c.forget(b.from, b.to);
      this.sodexBreaks.pop();
      changed = true;
      if (state === 'lost') {
        for (const o of this.sodexBreaks) c.forget(o.from, o.to);
        this.sodexBreaks = [];
        break;
      }
      st.since = b.since;
      const g = this.gaps.sodex.find((x) => x.to === b.to);
      if (g) {
        g.broke = false;
        g.covered = true;
        this.store.setMeta('stream_gaps:sodex', JSON.stringify(this.gaps.sodex));
      }
      streamLog(`sodex stream: the ${Math.round((b.to - b.from) / 1000)} s break is covered by the catch-up, the span runs on from ${new Date(b.since).toISOString()}`);
    }
    if (changed) this.store.setMeta(STREAM_PENDING_META, JSON.stringify(this.sodexBreaks));
  }

  status() {
    const lane = (l: Lane) => ({
      queued: l.size, done: l.done, failed: l.failed, spent: l.spent, lastError: l.lastError, current: l.current,
      byKind: l.byKind(), visible: l.urgentByKind(VIS_PRIO), backoffMs: Math.max(0, l.backoffUntil - Date.now()),
    });
    return {
      streams: Object.fromEntries(VENUES.map((v) => [v, this.streamSince(v)])),
      sockets: Object.fromEntries(VENUES.map((v) => [v, this.socketOf(v)])),
      gaps: this.gaps,
      flow: this.flow?.status() ?? null,
      sodexCatchup: this.sodexCatchup?.status() ?? null,
      arcusCatchup: this.arcusCatchup?.status() ?? null,
      coverageLedger: this.coverageLedger?.status() ?? null,
      aggregates: this.store.aggBacklog,
      heldPartials: this.store.heldPartials,
      dayScans: this.store.dayScanStatus,
      // The build in flight: since when and where (2026-11-10: a 30+ min build showed nothing of where it was).
      building: this.building ? { since: this.buildStartedAt, step: this.step ?? null } : null,
      checkpoint: this.store.checkpointStatus,
      flushBacklog: this.writes.backlog,
      writer: this.store.writerStatus,
      lockWaits: { n: this.store.lockWaits.n, maxMs: Math.round(this.store.lockWaits.maxMs), over100: this.store.lockWaits.over100 },
      // How long the oldest of those steps has waited (ms): the status page's write target (statusModel.ts FRESH_TARGETS).
      // With the writer thread on, also its flushes and the rows held for it: until 2026-11-23 they were not counted, and the
      // status said "0 ms" with 14.5M rows waiting.
      flushOldestMs: this.oldestUnwrittenMs(),
      warm: this.store.warmStatus,
      flushHeld: { fills: this.pendingFills.length + this.unsentFills.length, activity: this.act.size, overflowed: this.overflowed, replaying: this.replaying },
      streamUnderRest: this.store.streamUnderRest,
      retention: this.store.retention(this.now()),
      sodexBreaks: this.sodexBreaks.length,
      lanes: { hl: lane(this.hl), sgw: lane(this.sgw), scheck: lane(this.scheck), strades: lane(this.strades), sdata: lane(this.sdata) },
      venues: Object.fromEntries([...this.ext].map(([v, x]) => [v, x.status()])),
      tracked: {
        hyperliquid: this.trackedHl.size,
        sodex: this.trackedSodex.size,
        ...Object.fromEntries([...this.trackedExt].map(([v, s]) => [v, s.size])),
      },
      lastBuildAt: this.lastBuildAt,
      prevBuildAt: this.prevBuildAt,
      handover: this.handover,
      lastBuildMs: this.lastBuildMs,
      lastBuildVenueMs: this.lastBuildVenueMs,
      lastBuildStepMs: this.lastBuildStepMs,
      lastError: this.lastError,
      heapMb: heapMb(),
      loopLagMs: { lastMinute: this.lag.window, sinceStart: this.lag.max, spikes: this.spikes },
      hlBudget: Math.round(hlInfo.budget.available()),
      cohorts: this.cohorts.status(),
    };
  }

  // --- streams ----------------------------------------------------------------------

  /** `missing` answers "none" when it cannot read a chunk. For a read that must not count as having looked. */
  private heldChecked(flow: FlowFeed, run: () => Print[]): Print[] {
    const was = flow.lastError;
    flow.lastError = null;
    const added = run();
    const err = flow.lastError as string | null;
    flow.lastError = err ?? was;
    if (err?.startsWith('missing:')) throw new Error(err);
    return added;
  }

  private onPrint(p: Print, past = false): void {
    // A restart's snapshot of what the last run already took: not again, here or in activity and the cohorts.
    if (this.flow?.repeatOfHeld(p)) return;
    // Hyperliquid's HIP-3 dex "xyz" is also ranked on its own as trade.xyz.
    if (p.venue === 'hyperliquid' && p.symbol.startsWith('xyz:')) this.onPrint({ ...p, venue: 'tradexyz' }, past);
    // Cohorts: the print moves both parties' books (SoDEX prints carry account ids).
    mark(`print:${p.venue}`);
    this.flow?.add(p);
    const ext = this.ext.get(p.venue);
    const addressOf = (acct: string): string | null =>
      p.venue === 'sodex' ? this.sodexAddrOf.get(Number(acct)) ?? null : ext?.addressOf ? ext.addressOf(acct) : acct;
    if (!past) this.cohorts.onPrint(p, addressOf);
    const hour = hourOf(p.t);
    const notional = p.px * p.sz;
    for (const [acct, side] of [[p.buyer, 1], [p.seller, -1]] as const) {
      const k = `${p.venue}|${acct}|${hour}`;
      const rec = this.act.get(k) ?? { trades: 0, volume: 0 };
      // One trade per account, block and market (see MIN_TRADES).
      const orderTag = `${p.t}|${p.symbol}`;
      const lk = `${p.venue}|${acct}`;
      if (this.lastOrder.get(lk) !== orderTag) {
        rec.trades++;
        this.lastOrder.set(lk, orderTag);
      }
      rec.volume += notional;
      this.act.set(k, rec);
      const extAddress = ext ? addressOf(acct) : null;
      const address =
        p.venue === 'hyperliquid' ? (this.trackedHl.has(acct) ? acct : null)
        : p.venue === 'sodex' ? (this.trackedSodex.get(Number(acct)) ?? null)
        : extAddress && this.trackedExt.get(p.venue)?.has(extAddress) ? extAddress : null;
      // An xyz print of a wallet Hyperliquid tracks too: store.putFills files that row under both venues from its Hyperliquid
      // copy. A second copy here changed nothing, and was a quarter of the rows written (2026-11-06).
      if (address && !(p.venue === 'tradexyz' && this.trackedHl.has(address))) {
        this.pendingFills.push({
          venue: p.venue, address, id: p.id, t: p.t, symbol: p.symbol, side, px: p.px, sz: p.sz,
          fee: null, closedPnl: null, oid: null, src: 0,
        });
      }
    }
    if (this.lastOrder.size > 300_000) this.lastOrder.clear();
  }

  /** How long the oldest row not in the file yet has waited. */
  private oldestUnwrittenMs(): number {
    const now = this.now();
    const held = this.heldSince ? now - this.heldSince : 0;
    const open = this.openFlushes.length ? now - this.openFlushes[0]! : 0;
    return Math.max(0, this.writes.oldestWaitMs, held, open);
  }

  /** The timer's flush: waits while the writer thread has enough to do, so its queue never grows past a few flushes. */
  private flushTick(): void {
    if (this.store.writerOn && !this.stopped && (this.handing || this.store.writerPendingRows > WRITER_HOLD_ROWS)) {
      if (!this.heldSince) this.heldSince = this.now();
      if (this.pendingFills.length > FILLS_HELD_MAX) void this.overflow();
      return;
    }
    this.flush();
    this.heldSince = 0;
  }

  /** The fills held past FILLS_HELD_MAX go to the spill, a turn at a time, and back once the thread has room. */
  private async overflow(): Promise<void> {
    if (this.overflowing || this.stopped) return;
    this.overflowing = true;
    this.replaying++;
    const ids: number[] = [];
    this.overflowLeft = inKeyOrder(this.pendingFills);
    this.pendingFills = [];
    try {
      while (this.overflowLeft.length) {
        const turn = this.overflowLeft.slice(0, OVERFLOW_TURN);
        const parts: Array<{ kind: 'fills'; rows: typeof turn }> = [];
        for (let i = 0; i < turn.length; i += OVERFLOW_PART) parts.push({ kind: 'fills', rows: turn.slice(i, i + OVERFLOW_PART) });
        for (const id of this.store.spillWrites(parts)) ids.push(id);
        this.overflowLeft = this.overflowLeft.slice(turn.length);
        this.overflowed += turn.length;
        await new Promise<void>((ok) => setImmediate(ok));
        // A stop came first: it spilled what was left and the next start writes the parts back.
        if (this.stopped) return;
      }
    } catch (e) {
      this.lastError = `overflow: ${String(e)}`;
      this.pendingFills = this.overflowLeft.concat(this.pendingFills);
      this.overflowLeft = [];
    } finally {
      this.overflowing = false;
    }
    await this.replayParts(ids);
    this.replaying--;
  }

  /** Every spilled part, read a batch at a time, behind the live rows: the next batch only once the thread has little left. */
  private async replayAll(): Promise<void> {
    let after = 0;
    let n = 0;
    const t0 = Date.now();
    let last = 0;
    while (!this.stopped) {
      const busy = this.store.writerPendingRows > REPLAY_IDLE_ROWS;
      if (busy && (this.heldSince > 0 || Date.now() - last < REPLAY_BUSY_MS)) { await new Promise<void>((ok) => { setTimeout(ok, 50).unref?.(); }); continue; }
      try {
        last = Date.now();
        const parts = this.store.spillBatch(after, busy ? REPLAY_BUSY_BATCH : REPLAY_BATCH);
        if (!parts.length) break;
        if (!n) console.log('[indexer] start: rows spilled by the last stop, written back as the writer has room');
        await this.store.replayBatch(parts);
        after = parts[parts.length - 1]!.id;
        n += parts.length;
      } catch (e) {
        if (this.stopped) return;
        this.lastError = `spill replay: ${String(e)}`;
        await new Promise<void>((ok) => { setTimeout(ok, 1_000).unref?.(); });
      }
      await new Promise<void>((ok) => setImmediate(ok));
    }
    if (n) console.log(`[indexer] spill written back: ${n} parts in ${Math.round((Date.now() - t0) / 1000)} s`);
  }

  /** Spilled parts written back through the writer thread, REPLAY_WINDOW at a time and behind the live rows. */
  private async replayParts(ids: readonly number[]): Promise<void> {
    let next = 0;
    const one = async (): Promise<void> => {
      while (next < ids.length && !this.stopped) {
        const id = ids[next++]!;
        try {
          await this.store.replaySpillAsync(id);
        } catch (e) {
          if (!this.stopped) this.lastError = `spill replay: ${String(e)}`;
        }
        // With the writer thread off the part was written in this turn: the loop gets its turn too.
        await new Promise<void>((ok) => setImmediate(ok));
      }
    };
    await Promise.all(Array.from({ length: Math.min(REPLAY_WINDOW, ids.length) }, one));
  }

  private flush(): void {
    const rows: Array<{ venue: Venue; acct: string; hour: number; trades: number; volume: number }> = [];
    for (const [k, v] of this.act) {
      const [venue, acct, hour] = k.split('|');
      rows.push({ venue: venue as Venue, acct: acct!, hour: Number(hour), trades: v.trades, volume: v.volume });
    }
    this.act.clear();
    const fills = inKeyOrder(this.pendingFills);
    this.pendingFills = [];
    const at = this.now();
    if (this.store.writerOn) return this.flushThrough(rows, fills, at);
    // A write that failed: this flush's coverage does not move, as the rows it speaks for are not held.
    let failed = false;
    const write = (fn: () => void) => () => {
      try {
        fn();
      } catch (e) {
        failed = true;
        throw e;
      }
    };
    const steps: Array<() => void> = [];
    // Rows not written yet are kept as parts, so a stop can hand them to the spill instead (spillUnwritten).
    let spilled = false;
    const part = (p: UnwrittenPart) => {
      this.unwritten.add(p);
      return write(() => {
        if (!this.unwritten.delete(p)) return;
        if (p.kind === 'activity') this.store.addActivity(p.rows);
        else this.store.putFills(p.rows);
      });
    };
    const parts: UnwrittenPart[] = [];
    for (let i = 0; i < rows.length; i += FLUSH_ACTIVITY) parts.push({ kind: 'activity', rows: rows.slice(i, i + FLUSH_ACTIVITY), spilled: () => { spilled = true; } });
    for (let i = 0; i < fills.length; i += FLUSH_FILLS) parts.push({ kind: 'fills', rows: fills.slice(i, i + FLUSH_FILLS), spilled: () => { spilled = true; } });
    for (const p of parts) steps.push(part(p));
    // Days with new fills: re-summed a slice at a time, never holding the loop. Not on the way out: those days are kept
    // on disk (fill_dirty) and the next start sums them.
    steps.push(write(() => { if (!this.stopped) this.store.flushAggregates(40); }));
    // After this flush's rows are written, and as of the time they were taken: what the coverage claims is stored.
    // Rows in the spill are not stored yet, so nothing moves the held ranges over them (at a stop the sockets are closed
    // and advanceCoverage moved nothing anyway); the streams' own span is the sockets', and moves as before.
    steps.push(() => {
      if (failed) return;
      this.store.tx(() => {
        this.trackStreams(at);
        if (!spilled) this.advanceCoverage(at);
      });
    });
    steps.push(() => {
      if (!this.pendingStats.length) return;
      const stats = this.pendingStats;
      this.pendingStats = [];
      this.store.putTraderStats(stats);
    });
    if (this.spilling) return this.writes.enqueue(steps);
    this.writes.add(steps);
    if (this.stopped) this.writes.drain();
  }

  /**
   * A flush with the writer thread on (writerThread.ts): all of it in one op of activity and one of fills, not FLUSH_FILLS
   * steps - that cut was only there so this thread was never held long, and the thread cuts its transactions by time. The
   * rest of the flush (day sums, coverage, stats) runs here once both are answered, flushes in the order they were taken:
   * what the coverage claims is in the file by then. A stop spills what is not (store.stopWriter).
   */
  private flushThrough(rows: Array<{ venue: Venue; acct: string; hour: number; trades: number; volume: number }>, fills: import('./store.js').FillRow[], at: number): void {
    const sent = Promise.allSettled([this.handOver(rows, fills)]);
    this.openFlushes.push(this.heldSince || at);
    this.heldSince = 0;
    this.lastFlushAt = at;
    this.flushChain = this.flushChain.then(() => sent).then((r) => {
      const bad = r.find((x): x is PromiseRejectedResult => x.status === 'rejected');
      this.openFlushes.shift();
      if (bad) this.lastError = `flush: ${String(bad.reason)}`;
      if (this.stopped) return;
      this.writes.add([
        () => { if (!this.stopped) this.store.flushAggregates(40); },
        () => {
          if (bad) return;
          this.store.tx(() => {
            this.trackStreams(at);
            // Rows in the spill are not in the file yet: nothing moves the held ranges over them.
            if (!this.replaying) this.advanceCoverage(at);
          });
        },
        () => this.writeStats(),
      ]);
    });
  }

  /**
   * A flush's rows to the writer thread, WRITER_SEND_ROWS at a time and no faster than it writes. Rows not sent yet stay in
   * unsentFills / unsentActivity, where a stop finds them. Resolves once all of them are in the file.
   */
  private async handOver(rows: Array<{ venue: Venue; acct: string; hour: number; trades: number; volume: number }>, fills: import('./store.js').FillRow[]): Promise<void> {
    this.unsentFills = this.unsentFills.concat(fills);
    this.unsentActivity = this.unsentActivity.concat(rows);
    // A stop's last flush: spillUnwritten takes them all.
    if (this.spilling || this.handing) return;
    this.handing = true;
    const sent: Array<Promise<void>> = [];
    const guard = (p: Promise<void>): void => {
      p.catch(() => {});
      sent.push(p);
    };
    try {
      while (this.unsentActivity.length || this.unsentFills.length) {
        while (!this.stopped && this.store.writerOn && this.store.writerPendingRows > WRITER_HOLD_ROWS) await new Promise<void>((ok) => setTimeout(ok, 50));
        if (this.stopped) throw new Error('stopped before these rows were sent');
        // Taken and sent in one turn: a stop finds a row in one place or the other.
        if (this.unsentActivity.length) {
          await this.store.warmActivity(this.unsentActivity.slice(0, WRITER_SEND_ROWS));
          if (this.stopped) throw new Error('stopped before these rows were sent');
          const part = this.unsentActivity.slice(0, WRITER_SEND_ROWS);
          this.unsentActivity = this.unsentActivity.slice(part.length);
          guard(this.store.addActivityAsync(part));
        } else {
          await this.store.warmFills(this.unsentFills.slice(0, WRITER_SEND_ROWS));
          if (this.stopped) throw new Error('stopped before these rows were sent');
          const part = this.unsentFills.slice(0, WRITER_SEND_ROWS);
          this.unsentFills = this.unsentFills.slice(part.length);
          guard(this.store.putFillsAsync(part, { stream: true }));
        }
        if (this.unsentActivity.length || this.unsentFills.length) await new Promise<void>((ok) => setImmediate(ok));
      }
    } finally {
      this.handing = false;
    }
    await Promise.all(sent);
  }

  private writeStats(): void {
    if (!this.pendingStats.length) return;
    const stats = this.pendingStats;
    this.pendingStats = [];
    this.store.putTraderStats(stats);
  }

  /**
   * At a stop: every row not written yet goes to the spill in one transaction, and the steps that would have written them
   * do nothing. Should the spill fail, they are written as before (the drain after it). With the writer thread, its rows
   * not written go in the same transaction, which holds the write lock while it settles what the thread wrote.
   */
  private spillUnwritten(): void {
    const parts = [...this.unwritten];
    const thread = this.store.hasWriter;
    if (!parts.length && !thread) return;
    const spill = (more: { fills: import('./store.js').FillRow[]; activity: Array<{ venue: Venue; acct: string; hour: number; trades: number; volume: number }> }) => {
      // The fills of every waiting flush in one key order, cut again into FLUSH_FILLS: the next start writes each wallet's
      // rows of the whole backlog together (stable: copies of one id keep their order).
      const held = this.unsentFills.concat(this.overflowLeft);
      const activity = this.unsentActivity.concat(more.activity);
      const fills = inKeyOrder(parts.flatMap((p) => (p.kind === 'fills' ? p.rows : [])).concat(held, more.fills));
      const out: Parameters<IndexStore['spillWrites']>[0][number][] = parts.flatMap((p) => (p.kind === 'activity' ? [{ kind: 'activity' as const, rows: p.rows }] : []));
      for (let i = 0; i < activity.length; i += FLUSH_ACTIVITY) out.push({ kind: 'activity', rows: activity.slice(i, i + FLUSH_ACTIVITY) });
      for (let i = 0; i < fills.length; i += FLUSH_FILLS) out.push({ kind: 'fills', rows: fills.slice(i, i + FLUSH_FILLS) });
      this.store.spillWrites(out);
      this.spilledRows += held.length + more.fills.length + activity.length;
      this.unsentFills = [];
      this.unsentActivity = [];
      this.overflowLeft = [];
    };
    try {
      if (thread) this.store.stopWriter(spill);
      else spill({ fills: [], activity: [] });
    } catch (e) {
      this.lastError = `spill: ${String(e)}`;
      console.warn(`[indexer] stop: spill failed, writing the rows instead: ${String(e)}`);
      const fills = this.unsentFills.concat(this.overflowLeft);
      const activity = this.unsentActivity;
      this.unsentFills = [];
      this.unsentActivity = [];
      this.overflowLeft = [];
      this.store.putFills(fills);
      this.store.addActivity(activity);
      return;
    }
    for (const p of parts) {
      this.unwritten.delete(p);
      p.spilled();
      this.spilledRows += p.rows.length;
    }
  }

  /**
   * At a start: rows a stop spilled are written first, a part a step, ahead of anything new. Each part leaves the spill in
   * the transaction that writes it (store.replaySpill), so a stop or a crash midway leaves only the rest, and nothing is
   * written twice. Not tracked as unwritten: a stop meanwhile leaves them where they are.
   */
  private replaySpill(): number {
    if (this.store.writerOn) {
      // Beside the new rows: a fill is an upsert, and activity adds up in any order. A stop before a part is written leaves
      // it there; the coverage does not move until all are in.
      this.replaying++;
      void this.replayAll().finally(() => { this.replaying--; });
      return 0;
    }
    let parts: number[];
    try {
      parts = this.store.spilledIds();
    } catch (e) {
      this.lastError = `spill: ${String(e)}`;
      return 0;
    }
    if (!parts.length) return 0;
    this.writes.add(parts.map((id) => () => { if (!this.stopped) this.store.replaySpill(id); }));
    console.log(`[indexer] start: ${parts.length} parts of rows spilled by the last stop, written back as the writer has room`);
    return parts.length;
  }

  // --- trade checks -------------------------------------------------------------------

  private kinds(venue: Venue): HistoryKind[] {
    return venue === 'sodex' ? ['perps', 'spot'] : ['fills'];
  }

  /**
   * Every fill kind is held from the window start to now. "To now" through the
   * stream only while ONE socket connection has run since the held range ends
   * (a reconnect loses prints; the tolerant span is for activity counts only).
   */
  private covered(venue: Venue, address: string, from: number, now: number): boolean {
    const socket = this.socketOf(venue);
    return this.kinds(venue).every((k) => spanCovers(this.store.coverage(venue, address, k), from, now, { staleMs: STALE_MS, streamSince: socket }));
  }

  /** A held range that no longer reaches now (a stream gap, or no stream): it needs a catch-up read. */
  private behind(venue: Venue, cov: Coverage | null, now: number): boolean {
    if (!cov) return false;
    const socket = this.socketOf(venue);
    return !(cov.toT >= now - STALE_MS || (socket !== null && socket <= cov.toT));
  }

  /**
   * Whether the held CLOSES cover the whole window (exact win rate), and where
   * an estimate's closes start. Closes come from REST reads only (SoDEX
   * positions/history; the fills' realised PnL elsewhere), so this is about
   * reaching back, not about the stream.
   */
  private winCoverage(venue: Venue, address: string, from: number): { exact: boolean; from: number | null } {
    const cov = this.store.coverage(venue, address, venue === 'sodex' ? 'closes' : 'fills');
    if (!cov) return { exact: false, from: null };
    const back = cov.fromT <= from || cov.exhausted;
    const cut = cov.capped && cov.fromT > from;
    return { exact: back && !cut, from: back && !cut ? null : Math.max(from, cov.fromT) };
  }

  /** How long an answer for a trader whose data has not changed is reused: one build, within bounds. */
  private reuseMs(): number {
    return Math.min(MAX_REUSE_MS, Math.max(CACHE_MS, Math.round((this.lastBuildMs || this.warmBuildMs) * 1.5)));
  }

  /** The last process's build time, until this one has built (loadWarm). */
  private warmBuildMs = 0;
  /**
   * When the last process's last build ended (loadWarm): the boards on disk are that build's until this one's first ends,
   * so the status says how old they really are (ops/status.ts), not "no build yet".
   */
  prevBuildAt = 0;

  private warmPath(): string | null {
    return this.store.path === ':memory:' ? null : join(dirname(this.store.path), WARM_FILE);
  }

  /**
   * At a stop: the answers young enough to reuse, each with whether its trader is unchanged since. A trader's version
   * starts at 0 in the next process and moves with its first new row (the spill's too), so "unchanged" holds as long as
   * it would have here.
   */
  private saveWarm(): void {
    const file = this.warmPath();
    if (!file) return;
    const tmp = `${file}.tmp`;
    try {
      const now = this.now();
      const entries: Array<[string, number, 0 | 1, unknown]> = [];
      for (const [k, e] of this.cache) {
        if (!(now - e.at < WARM_MAX_AGE_MS)) continue;
        const [, venue, address] = k.split('|');
        if (!venue || !address) continue;
        entries.push([k, e.at, e.ver === this.store.version(venue as Venue, address) ? 1 : 0, e.value]);
      }
      writeFileSync(tmp, JSON.stringify({ format: WARM_FORMAT, savedAt: now, buildMs: this.lastBuildMs, builtAt: this.lastBuildAt || this.prevBuildAt, entries }));
      renameSync(tmp, file);
    } catch (e) {
      console.warn(`[indexer] warm cache not written: ${String(e)}`);
      try { rmSync(tmp, { force: true }); } catch { /* none */ }
    }
  }

  /** At a start: the last stop's answers (the file is taken, like the held rows: a second start finds none). */
  private loadWarm(): number {
    const file = this.warmPath();
    if (!file || !existsSync(file)) return 0;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as { format?: string; buildMs?: number; builtAt?: number; entries?: Array<[string, number, 0 | 1, unknown]> };
      if (j.format !== WARM_FORMAT || !Array.isArray(j.entries)) return 0;
      const now = this.now();
      let n = 0;
      for (const [k, at, fresh, value] of j.entries) {
        if (typeof k !== 'string' || !(now - at < WARM_MAX_AGE_MS) || at > now) continue;
        // -1: never this process's version, so only the age rule can reuse it (a changed trader's answer, as before).
        this.cache.set(k, { ver: fresh === 1 ? 0 : -1, at, value });
        n++;
      }
      this.warmBuildMs = Number(j.buildMs) || 0;
      this.prevBuildAt = Number(j.builtAt) || 0;
      return n;
    } catch (e) {
      console.warn(`[indexer] warm cache not read: ${String(e)}`);
      return 0;
    } finally {
      try { rmSync(file, { force: true }); } catch { /* gone */ }
    }
  }

  /** Fresh enough, or the trader's data is unchanged since and it is not older than one build. */
  private reusable(hit: { ver: number; at: number }, ver: number, now: number, sticky: boolean): boolean {
    const age = now - hit.at;
    if (age < CACHE_MS && (sticky || hit.ver === ver)) return true;
    return hit.ver === ver && age < this.reuseMs();
  }

  /** Reuse a per-trader answer until the trader's data changes or it is CACHE_MS old. */
  /**
   * `sticky`: reuse for CACHE_MS even when the trader has new fills since (the
   * board's window stats: a few minutes behind is fine, and recomputing them on
   * every fill of an active trader kept the worker busy).
   */
  private cached<T>(key: string, venue: Venue, address: string, now: number, fn: () => T, sticky = false): T {
    const ver = this.store.version(venue, address);
    const hit = this.cache.get(key);
    if (hit && this.reusable(hit, ver, now, sticky)) return hit.value as T;
    const value = fn();
    this.cache.set(key, { ver, at: now, value });
    return value;
  }

  /**
   * Stream trades inside the window. `exact` when the stream has run without
   * a gap since the window started; otherwise the count covers only the part
   * since the stream came up, which still proves "more than one" when it is.
   */
  private streamTrades(venue: Venue, address: string, window: BoardWindow, from: number): { n: number; exact: boolean } | null {
    const since = this.streamSince(venue);
    if (since === null) return null;
    const ext = this.ext.get(venue);
    const accts = venue === 'sodex'
      ? (this.sodexIdOf.has(address) ? [String(this.sodexIdOf.get(address))] : null)
      : ext?.accountsOf ? ext.accountsOf(address) : [address];
    if (!accts || !accts.length) return null;
    const start = Math.max(from, since);
    const at = HOUR_WINDOWS.has(window) || since > from ? { hour: hourOf(start) } : { day: dayOf(start) };
    let n = 0;
    for (const a of accts) n += this.store.activityTrades(venue, a, at);
    return { n, exact: since <= from };
  }

  private check(venue: Venue, address: string, window: BoardWindow, from: number, now: number): TradeCheck {
    return this.cached(`c|${venue}|${address}|${window}`, venue, address, now, () => {
      // Only "at least MIN_TRADES?" matters here: stop reading there (a full count stalled on market makers).
      const held = this.store.hasTrades(venue, address, from, MIN_TRADES);
      // The stream saw every trade of every account since it came up.
      const streamed = this.streamTrades(venue, address, window, from);
      if (streamed && Math.max(held, streamed.n) >= MIN_TRADES) return 'yes';
      if (streamed?.exact) return 'no';
      if (venue === 'sodex') {
        // Closed positions prove trades (not their absence: open positions and
        // spot fills do not show there).
        const ev = this.store.closeEvidence('sodex', address, from);
        if (ev.closes >= MIN_TRADES || ev.roundTrips > 0) return 'yes';
      }
      return tradeCheck(held, this.covered(venue, address, from, now));
    });
  }

  /** Trades in the window as far as known, and whether that is the full count. */
  private tradeState(venue: Venue, address: string, window: BoardWindow, from: number, now: number): { n: number | null; exact: boolean } {
    return this.cached(`t|${venue}|${address}|${window}`, venue, address, now, () => this.tradeFrom(venue, address, window, from, now, this.store.orderCount(venue, address, from)), true);
  }

  private tradeFrom(venue: Venue, address: string, window: BoardWindow, from: number, now: number, held: number): { n: number | null; exact: boolean } {
    const streamed = this.streamTrades(venue, address, window, from);
    const exact = !!streamed?.exact || this.covered(venue, address, from, now);
    const n = Math.max(held, streamed?.n ?? 0);
    return { n: held > 0 || streamed || exact ? n : null, exact };
  }

  /** tradeState, computed without holding the loop (the count scans the window's first, partial day). */
  private async tradeStateAsync(venue: Venue, address: string, window: BoardWindow, from: number, now: number): Promise<{ n: number | null; exact: boolean }> {
    const key = `t|${venue}|${address}|${window}`;
    const hit = this.cache.get(key);
    if (hit && this.reusable(hit, this.store.version(venue, address), now, true)) return hit.value as { n: number | null; exact: boolean };
    const held = await this.store.orderCountAsync(venue, address, from, () => this.breathe());
    const value = this.tradeFrom(venue, address, window, from, now, held);
    this.cache.set(key, { ver: this.store.version(venue, address), at: now, value });
    return value;
  }

  /** pickStats, computed without holding the loop. */
  private async pickStatsAsync(venue: Venue, address: string, window: BoardWindow, from: number, now: number): Promise<PickStats> {
    const key = `s|${venue}|${address}|${window}`;
    const hit = this.cache.get(key);
    if (hit && this.reusable(hit, this.store.version(venue, address), now, true)) return hit.value as PickStats;
    const stats = await this.store.windowStatsAsync(venue, address, from, () => this.breathe());
    const wc = this.winCoverage(venue, address, from);
    const value: PickStats = {
      stats,
      covered: this.covered(venue, address, from, now),
      capped: this.kinds(venue).some((k) => {
        const cov = this.store.coverage(venue, address, k);
        return !!cov?.capped && cov.fromT > from;
      }),
      wrExact: wc.exact,
      wrFrom: wc.from,
    };
    this.cache.set(key, { ver: this.store.version(venue, address), at: now, value });
    return value;
  }

  /** Queue the cheapest read that can answer a trade check. */
  private queueCheck(venue: Venue, address: string, from: number, prio: number): void {
    this.track(venue, address);
    const ext = this.ext.get(venue);
    if (ext) return ext.queueCheck(address, from, prio);
    const now = this.now();
    if (venue === 'hyperliquid') {
      this.hl.add({ key: `q:${address}`, prio, run: () => hlQuickCheck(this.store, address, from, this.now(), this.socketOf('hyperliquid')) });
      return;
    }
    // SoDEX: closed positions first (not rate limited like /trades), which prove trades but
    // not their absence, and one account-trades read for what they leave open.
    const closes = this.store.coverage('sodex', address, 'closes');
    if (!closes || closes.fromT > from || now - closes.restAt >= RESYNC_MS) {
      this.sgw.add({
        key: `q:${address}`,
        prio,
        run: async () => (await syncCloses(this.store, address, from, { maxPages: 1, now: this.now() })).pages,
      });
    }
    this.queueTradeRead(address, from, prio, now);
  }

  /**
   * A wallet's own trades over the window, newest first: two prove it passes, and a short page on both engines proves it
   * does not (peekTrades covers the window then), so the check means what it always did. Perps first, as spot only
   * answers what perps could not. Paced by the `/trades` counter's rule; what waits is the board's top first.
   */
  private queueTradeRead(address: string, from: number, prio: number, now: number): void {
    // The window slides: one wallet and window is one read for a while.
    const key = `c:${Math.floor(from / CHECK_BUCKET_MS)}:${address}`;
    if (now - (this.checkAsked.get(key) ?? 0) < CHECK_AGAIN_MS) return;
    if (this.checkAsked.size > 20_000) this.checkAsked.clear();
    this.scheck.add({
      key,
      prio,
      run: async () => {
        this.checkAsked.set(key, this.now());
        await peekTrades(this.store, address, 'perps', from, this.now());
        if (this.store.hasTrades('sodex', address, from, MIN_TRADES) >= MIN_TRADES) return 1;
        await peekTrades(this.store, address, 'spot', from, this.now());
        return 2;
      },
    });
  }

  /** Queue a full read of a board member over [from, now]. */
  /** Stream prints for this wallet are recorded from now on (before its first read lands). */
  private track(venue: Venue, address: string): void {
    if (venue === 'hyperliquid') this.trackedHl.add(address);
    else if (venue === 'sodex') {
      const id = this.sodexIdOf.get(address);
      if (id !== undefined) this.trackedSodex.set(id, address);
    } else {
      let set = this.trackedExt.get(venue);
      if (!set) this.trackedExt.set(venue, (set = new Set()));
      set.add(address);
    }
  }

  private queueHistory(venue: Venue, address: string, from: number, prio: number): void {
    this.track(venue, address);
    const now = this.now();
    const ext = this.ext.get(venue);
    if (ext) {
      // A range the stream stopped extending (restart, reconnect): read the gap now, not at the next resync.
      const cov = this.store.coverage(venue, address, 'fills');
      return ext.queueHistory(address, from, prio, this.behind(venue, cov, now) ? cov!.toT : undefined);
    }
    if (venue === 'hyperliquid') {
      const cov = this.store.coverage('hyperliquid', address, 'fills');
      // Newest page / catch-up (`h:`, one page: hlSyncFills reads a new wallet's
      // newest fills first, and a held one from where it ends) and reaching back
      // to the window start (`b:`, several pages) are separate reads, so the
      // cheap one is never stuck behind the expensive one.
      const need = !cov ? 'first' : this.behind('hyperliquid', cov, now) ? 'catchup' : now - cov.restAt > RESYNC_MS ? 'resync' : null;
      if (need) {
        this.hl.add({
          key: `h:${address}`,
          prio: readPrio(prio, need),
          run: async () => {
            const r = await hlSyncFills(this.store, address, this.now(), { maxPages: 1, now: this.now(), streamSince: this.socketOf('hyperliquid') });
            return r.pages * 20 + Math.ceil(r.rows / 20);
          },
        });
      }
      if (!cov || (cov.fromT > from && !cov.exhausted)) {
        // Already queued: add() only raises the priority; the read reaches the earliest start asked.
        const key = `b:${address}`;
        this.histFrom.set(key, Math.min(from, this.histFrom.get(key) ?? from));
        this.hl.add({
          key,
          prio: readPrio(prio, 'back'),
          run: async () => {
            const f = this.histFrom.get(key) ?? from;
            this.histFrom.delete(key);
            const r = await hlSyncFills(this.store, address, f, { maxPages: 6, now: this.now(), streamSince: this.socketOf('hyperliquid') });
            return r.pages * 20 + Math.ceil(r.rows / 20);
          },
        });
      }
      return;
    }
    // Closed positions (win rate): newest page / catch-up first, reaching back apart.
    const closes = this.store.coverage('sodex', address, 'closes');
    const need = !closes ? 'first' : now - closes.restAt > RESYNC_MS ? 'resync' : null;
    if (need) {
      this.sgw.add({
        key: `h:closes:${address}`,
        prio: readPrio(prio, need) - 50,
        // Newest first down to the window start, one page: the latest 500 closes.
        run: async () => (await syncCloses(this.store, address, from, { maxPages: 1, now: this.now() })).pages,
      });
    }
    if (!closes || (closes.fromT > from && !closes.exhausted)) {
      const key = `b:closes:${address}`;
      this.histFrom.set(key, Math.min(from, this.histFrom.get(key) ?? from));
      this.sgw.add({
        key,
        prio: readPrio(prio, 'back') - 50,
        run: async () => {
          const f = this.histFrom.get(key) ?? from;
          this.histFrom.delete(key);
          return (await syncCloses(this.store, address, f, { maxPages: 2, now: this.now() })).pages;
        },
      });
    }
    // Fills: the stream records them from now on. /trades only when explicitly enabled - or, for the Copy page's leaders, at their own drip.
    if (!INDEXER_ENV.sodexTradesEnabled()) {
      this.queueLeaderTrades(address, now);
      return;
    }
    const back = Math.max(from, now - INDEXER_ENV.sodexTradesBackDays() * DAY_MS);
    for (const engine of ['perps', 'spot'] as const) {
      if (this.strades.has(`h:${engine}:${address}`)) continue;
      const cov = this.store.coverage('sodex', address, engine);
      if (cov && (cov.fromT <= back || cov.exhausted) && spanCovers(cov, back, now, { staleMs: RESYNC_MS, streamSince: this.streamSince('sodex') })) continue;
      this.strades.add({
        key: `h:${engine}:${address}`,
        prio,
        run: async () => (await syncTrades(this.store, address, engine, back, { maxPages: 1, now: this.now() })).pages,
      });
    }
  }

  /**
   * A SoDEX Copy page leader's fills back COPY_BACK_DAYS, one `/trades` page a task on the strades lane at
   * sodexLeaderTradesPerMin: newest first (syncTrades), each engine until its held span reaches the start, the venue
   * has nothing older, or the wallet holds COPY_FILLS fills since that span's start (the copy setup's replay is then
   * answered from the index: walletFills covers a window whose newest FILL_LIMIT fills it holds). Then the stream keeps
   * it, and a gap is read again from where it ends. Not a leader, or the drip off: nothing.
   */
  private queueLeaderTrades(address: string, now: number): void {
    const leader = this.copyLeaders.get(address);
    if (!leader || INDEXER_ENV.sodexLeaderTradesPerMin() <= 0) return;
    const back = now - COPY_BACK_DAYS * DAY_MS;
    for (const engine of ['perps', 'spot'] as const) {
      const key = `h:${engine}:${address}`;
      if (this.strades.has(key)) continue;
      const cov = this.store.coverage('sodex', address, engine);
      const current = !!cov && spanCovers({ ...cov, fromT: Math.min(cov.fromT, back) }, back, now, { staleMs: RESYNC_MS, streamSince: this.streamSince('sodex') });
      if (current && (cov!.fromT <= back || cov!.exhausted)) continue;
      // Counted at most once per held start (up to COPY_FILLS rows of one wallet), not on every build.
      if (current && this.leaderDeep.get(key) === cov!.fromT) continue;
      if (current && this.store.hasTrades('sodex', address, cov!.fromT, COPY_FILLS) >= COPY_FILLS) {
        this.leaderDeep.set(key, cov!.fromT);
        if (this.leaderDeep.size > 5_000) this.leaderDeep.delete(this.leaderDeep.keys().next().value!);
        continue;
      }
      this.strades.add({
        key,
        prio: leader.prio,
        run: async () => (await syncTrades(this.store, address, engine, back, { maxPages: 1, now: this.now() })).pages,
      });
    }
  }

  // --- sources ------------------------------------------------------------------------

  private async hlSnapshot(): Promise<LbSnapshot | null> {
    let snap: LbSnapshot | null;
    try {
      snap = await hlLeaderboard.snapshot();
    } catch (e) {
      this.lastError = `hl leaderboard: ${String(e)}`;
      snap = hlLeaderboard.peek();
    }
    this.saveHlSnapshot(snap);
    return snap;
  }

  /** The snapshot the boards use, on disk once per new HL file, for the next start (leaderboardFile.ts). */
  private lbSaved: LbSnapshot | null = null;

  private lbPath(): string | null {
    return this.store.path === ':memory:' ? null : join(dirname(this.store.path), 'hl-leaderboard.bin');
  }

  private saveHlSnapshot(snap: LbSnapshot | null): void {
    const file = this.lbPath();
    if (!file || !snap || snap === this.lbSaved) return;
    this.lbSaved = snap;
    try {
      saveLeaderboardFile(file, snap);
    } catch (e) {
      this.lastError = `hl leaderboard file: ${String(e)}`;
    }
  }

  /** At a start: the last process's snapshot when its numbers are under an hour old. Returns its age (0: none). */
  private loadHlSnapshot(): number {
    const file = this.lbPath();
    if (!file || hlLeaderboard.peek()) return 0;
    const snap = loadLeaderboardFile(file);
    if (!snap || !hlLeaderboard.seed(snap)) return 0;
    this.lbSaved = snap;
    return Math.max(1, Date.now() - snap.updatedAt);
  }

  /** Keep the SoDEX published lists current (one data-lane task per window). */
  private queueLists(now: number): void {
    for (const w of WINDOWS) {
      if (now - (this.listCheckAt[w] ?? 0) < 5 * 60_000) continue;
      this.listCheckAt[w] = now;
      this.sdata.add({
        key: `list:${w}`,
        prio: 5_000 + WINDOW_WEIGHT[w],
        run: async () => {
          const snap = await syncLists(this.store, w, this.listSnap[w] ?? null, this.now());
          if (snap !== null) this.listSnap[w] = snap;
          return snap === null ? 1 : 40;
        },
      });
    }
  }

  /**
   * SoDEX wallets outside the published lists: the accounts the stream saw
   * trading in the window, most volume first, each looked up once per TTL.
   */
  private async queueLookups(w: Window, now: number): Promise<void> {
    if (now - (this.lookupScanAt[w] ?? 0) < LOOKUP_SCAN_MS) return;
    this.lookupScanAt[w] = now;
    const from = windowStart(w, now);
    const active = await activeAccountsAsync(this.store, 'sodex', HOUR_WINDOWS.has(w) ? { hour: hourOf(from) } : { day: dayOf(from) }, 1, LOOKUP_ACTIVE);
    if (!active.length) return;
    const ids = active.map((a) => Number(a.acct)).filter((n) => Number.isInteger(n) && n > 0);
    const known = this.store.accountIds('sodex');
    const missing = ids.filter((id) => !known.has(id) && !knownAddress(id));
    if (missing.length) {
      const got = await resolveIds(missing.slice(0, 500), 5_000);
      this.store.tx(() => {
        for (const [id, address] of got) {
          this.store.upsertAccount('sodex', address, { accountId: id });
          this.sodexIdOf.set(address, id);
        }
      });
    }
    active.forEach((a, i) => {
      const id = Number(a.acct);
      const address = known.get(id) ?? knownAddress(id);
      if (!address) return;
      const held = this.store.pnlOf('sodex', w, address);
      if (!lookupDue(held?.at ?? null, this.unranked.get(`${w}|${address}`) ?? null, now, LOOKUP_TTL[w])) return;
      this.sdata.add({
        key: `rank:${w}:${address}`,
        prio: 1_000 + WINDOW_WEIGHT[w] - Math.min(900, i),
        run: async () => {
          if (!(await lookupPnl(this.store, w, address, this.now()))) this.markUnranked(w, address);
          return 1;
        },
      });
    });
  }

  private markUnranked(w: Window, address: string): void {
    const at = this.now();
    this.unranked.set(`${w}|${address}`, at);
    this.store.putUnranked('sodex', w, address, at);
  }

  /** 90d / ytd PnL for a pool of candidates, from charts, twice a day. */
  private queueChartPool(venue: Venue, snap: LbSnapshot | null, now: number): void {
    // Twice a day, not on every restart: a restart used to queue ~3,700 chart reads again.
    if (!this.chartPoolAt[venue]) this.chartPoolAt[venue] = Number(this.store.getMeta(`chart_pool_at:${venue}`)) || 0;
    if (now - this.chartPoolAt[venue] < CHART_POOL_MS) return;
    this.chartPoolAt[venue] = now;
    this.store.setMeta(`chart_pool_at:${venue}`, String(now));
    const starts = { d90: windowStart('90d', now), ytd: windowStart('ytd', now) };
    const pool = new Set<string>();
    if (venue === 'hyperliquid') {
      if (!snap) {
        this.chartPoolAt[venue] = 0;
        return;
      }
      for (const w of ['all', '30d'] as const) {
        for (const side of SIDES) {
          let n = 0;
          for (const c of hlCandidates(snap, w, side)) {
            pool.add(c.address);
            if (++n >= HL_CHART_POOL_EACH) break;
          }
        }
      }
      let i = 0;
      for (const address of pool) {
        const prio = 500 - Math.min(400, i++);
        this.hl.add({
          key: `chart:${address}`,
          prio,
          run: async () => {
            const r = await hlChartWindows(address, starts);
            const t = this.now();
            if (r.d90 !== null) this.store.putPnl('hyperliquid', '90d', [{ address, pnl: r.d90, volume: null }], t, t);
            if (r.ytd !== null) this.store.putPnl('hyperliquid', 'ytd', [{ address, pnl: r.ytd, volume: null }], t, t);
            return 20;
          },
        });
      }
      return;
    }
    // SoDEX: everyone the all-time lists or lookups know, largest |PnL| first.
    const rows = [
      ...this.store.pnlRanked('sodex', 'all', 'top', 0, 1_500),
      ...this.store.pnlRanked('sodex', 'all', 'worst', 0, 1_500),
    ];
    if (!rows.length) {
      // The all-time lists have not loaded yet: try again on the next pass.
      this.chartPoolAt[venue] = 0;
      return;
    }
    const ids = this.store.accountIds('sodex');
    const byAddress = new Map([...ids].map(([id, a]) => [a, id]));
    rows.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
    rows.forEach((r, i) => {
      const id = byAddress.get(r.address);
      if (id === undefined || pool.has(r.address)) return;
      pool.add(r.address);
      this.sdata.add({
        key: `chart:${r.address}`,
        prio: 400 - Math.min(300, i),
        run: async () => {
          const c = await chartWindows(id, starts);
          const t = this.now();
          if (c.suspect) this.suspectSodex.add(r.address);
          else this.suspectSodex.delete(r.address);
          if (c.d90 !== null) this.store.putPnl('sodex', '90d', [{ address: r.address, pnl: c.d90, volume: null }], t, t);
          if (c.ytd !== null) this.store.putPnl('sodex', 'ytd', [{ address: r.address, pnl: c.ytd, volume: null }], t, t);
          if (c.accountValue !== null) this.store.setAccountValue('sodex', r.address, c.accountValue, t);
          return 2;
        },
      });
    });
  }

  /**
   * Once per UTC day: every account's all-time PnL, so 90d / ytd become exact
   * over time. Remembered in `meta` (a restart does not write the day again)
   * and written in slices, handing the loop back between them.
   */
  private async recordCumPnl(venue: Venue, snap: LbSnapshot | null, now: number): Promise<void> {
    const day = dayOf(now);
    if (this.cumDay[venue] !== day && Number(this.store.getMeta(`cum_day:${venue}`)) === day) this.cumDay[venue] = day;
    if (this.cumDay[venue] === day) return;
    let rows: Array<{ address: string; pnl: number }> = [];
    if (venue === 'hyperliquid') {
      if (!snap) return;
      const col = snap.data.cols['pnl:all'];
      for (let i = 0; i < snap.n; i++) {
        const v = col[i]!;
        if (!Number.isNaN(v)) rows.push({ address: snap.data.addresses[i]!, pnl: v });
      }
    } else {
      rows = this.store.pnlRanked(venue, 'all', 'top', 0, 1_000_000).map((r) => ({ address: r.address, pnl: r.pnl }));
      if (!rows.length) return;
    }
    for (let i = 0; i < rows.length; i += 5_000) {
      this.store.putCumPnl(venue, day, rows.slice(i, i + 5_000));
      await this.breathe();
    }
    this.cumDay[venue] = day;
    this.store.setMeta(`cum_day:${venue}`, String(day));
    this.pruneDue = true;
  }

  /** Old activity rows go a slice at a time, never in one long DELETE. */
  private pruneDue = true;
  private async pruneSome(now: number): Promise<void> {
    // Old activity and cumulative PnL days go only with the owner's word (retention.ts).
    if (!this.pruneDue || !mayPrune('activity')) return;
    const cum = { beforeDay: dayOf(now) - CUM_KEEP_DAYS, yearStartDay: dayOf(yearStartUtc(now)) };
    for (let k = 0; k < 20; k++) {
      if (!this.store.pruneActivityChunk(hourOf(now) - HOUR_RETAIN, dayOf(now) - 400, 5_000, cum)) {
        this.pruneDue = false;
        return;
      }
      await this.breathe();
    }
  }

  // --- candidates ---------------------------------------------------------------------

  private candidates(venue: Venue, window: BoardWindow, side: Side, snap: LbSnapshot | null, now: number): Iterable<Candidate> {
    const ext = this.ext.get(venue);
    if (ext) {
      // 90d / ytd from daily all-time snapshots where the venue has no own figure.
      if (venue !== 'tradexyz' && !isPublished(window)) return this.fromCumPnl(venue, window, side, now, snap) ?? [];
      return this.store.pnlRanked(venue, window, side, now - ext.maxAgeMs(window), 20_000);
    }
    if (venue === 'hyperliquid') {
      if (isPublished(window)) return snap ? hlCandidates(snap, window, side) : [];
      const exact = this.fromCumPnl('hyperliquid', window, side, now, snap);
      if (exact) return exact;
    } else if (!isPublished(window)) {
      const exact = this.fromCumPnl('sodex', window, side, now, snap);
      if (exact) return exact;
    }
    const maxAge = isPublished(window) ? 3 * LOOKUP_TTL[window] : 3 * CHART_POOL_MS;
    return this.store.pnlRanked(venue, window, side, now - maxAge, 20_000);
  }

  /** Whether the PnL behind a board has loaded (else the board is never called complete). */
  private sourceReady(venue: Venue, window: BoardWindow, snap: LbSnapshot | null, now: number): boolean {
    const ext = this.ext.get(venue);
    if (ext) return ext.sourceReady(window, now) || (venue !== 'tradexyz' && !isPublished(window) && this.fromCumReady(venue, window, now));
    if (venue === 'hyperliquid') {
      if (!snap) return false;
      if (isPublished(window)) return true;
      if (this.fromCumReady(venue, window, now)) return true;
      return this.chartPoolAt.hyperliquid > 0 && this.hl.countPrefix('chart:') === 0;
    }
    // Rank lookups of stream-found wallets never end (new wallets keep trading);
    // they refine a board, they do not hold it open.
    if (isPublished(window)) return this.listSnap[window] !== undefined;
    if (this.fromCumReady(venue, window, now)) return true;
    return this.chartPoolAt.sodex > 0 && this.sdata.countPrefix('chart:') === 0;
  }

  private fromCumReady(venue: Venue, window: BoardWindow, now: number): boolean {
    const since = this.store.cumPnlSince(venue);
    return since !== null && since <= dayOf(windowStart(window, now));
  }

  /** 90d / ytd from daily all-time snapshots, once they reach back to the window start. */
  /**
   * One pass computes each venue's window once, best first; `worst` is the
   * same list read backwards. (Per side and per board it re-read and re-sorted
   * Lighter's ~97k all-time rows every time: 1 s stalls in every pass.)
   */
  private fromCumPnl(venue: Venue, window: BoardWindow, side: Side, now: number, snap: LbSnapshot | null): Candidate[] | null {
    const k = `${venue}|${window}`;
    let hit = this.cumMemo.get(k);
    if (!hit || hit.at !== now) {
      const top = this.fromCumPnlUncached(venue, window, now, snap);
      hit = { at: now, top, worst: null };
      this.cumMemo.set(k, hit);
    }
    if (!hit.top || side === 'top') return hit.top;
    return (hit.worst ??= [...hit.top].reverse());
  }

  private cumMemo = new Map<string, { at: number; top: Candidate[] | null; worst: Candidate[] | null }>();

  private fromCumPnlUncached(venue: Venue, window: BoardWindow, now: number, snap: LbSnapshot | null): Candidate[] | null {
    const since = this.store.cumPnlSince(venue);
    const startDay = dayOf(windowStart(window, now));
    if (since === null || since > startDay) return null;
    const base = this.store.cumPnlAt(venue, startDay);
    const out: Candidate[] = [];
    if (venue === 'hyperliquid' && snap) {
      const col = snap.data.cols['pnl:all'];
      for (let i = 0; i < snap.n; i++) {
        const v = col[i]!;
        if (Number.isNaN(v)) continue;
        const a = snap.data.addresses[i]!;
        out.push({ address: a, pnl: v - (base.get(a) ?? 0), volume: null });
      }
    } else {
      // Unsorted read (the SQL ORDER BY over ~97k rows was most of the cost); one sort below.
      for (const [address, pnl] of this.store.pnlAll(venue)) out.push({ address, pnl: pnl - (base.get(address) ?? 0), volume: null });
    }
    out.sort((a, b) => b.pnl - a.pnl);
    return out;
  }

  // --- boards -------------------------------------------------------------------------

  private lastBreath = 0;

  /**
   * Hand the event loop back if this build has held it for BUILD_TURN_MS. The build is
   * a long run of synchronous SQLite reads chained by `await`s of settled
   * promises - microtasks, which never let timers or sockets in. Without this a
   * cold build held the loop for ~110 s and every upstream request in that
   * time failed as a timeout (profiled 2026-09-29).
   */
  private async breathe(): Promise<void> {
    if (Date.now() - this.lastBreath < BUILD_TURN_MS) return;
    await new Promise<void>((r) => setImmediate(r));
    this.lastBreath = Date.now();
    // What runs after this is the build again, not whatever marked last.
    mark(this.step ? `rebuild:${this.step}` : 'rebuild');
  }

  async rebuild(): Promise<void> {
    if (this.building || this.stopped) return;
    this.building = true;
    const t0 = Date.now();
    this.buildStartedAt = t0;
    const steps: Record<string, number> = {};
    let ts = t0;
    const lap = (name: string) => { const t = Date.now(); steps[name] = (steps[name] ?? 0) + t - ts; ts = t; };
    try {
      const now = this.now();
      const snap = await this.hlSnapshot();
      this.coinName = await hlCoinName().catch(() => this.coinName);
      lap('snapshot');
      this.queueLists(now);
      for (const w of WINDOWS) await this.queueLookups(w, now).catch((e) => (this.lastError = `lookups ${w}: ${String(e)}`));
      this.queueChartPool('hyperliquid', snap, now);
      this.queueChartPool('sodex', snap, now);
      lap('lookups');
      for (const [venue, x] of this.ext) {
        try {
          await x.refresh(now);
        } catch (e) {
          this.lastError = `${venue} refresh: ${String(e)}`;
        }
        lap(`refresh ${venue}`);
      }
      for (const venue of VENUES) if (venue !== 'tradexyz') { await this.recordCumPnl(venue, snap, now); lap(`cumPnl ${venue}`); }
      await this.pruneSome(now);
      lap('prune');

      const want = new Map<Venue, Set<string>>(VENUES.map((v) => [v, new Set<string>()]));
      for (const a of this.watchedHl) want.get('hyperliquid')!.add(a);
      const built = new Map<string, BoardRow>();
      const venueMs: Partial<Record<Venue, number>> = {};
      for (const venue of VENUES) {
        const v0 = Date.now();
        for (const window of INDEX_WINDOWS) {
          for (const side of SIDES) {
            for (const filter of FILTERS) {
              const picked = await this.buildBoard(venue, window, side, filter, snap, now, built);
              for (const a of picked) want.get(venue)!.add(a);
              await this.breathe();
            }
          }
        }
        venueMs[venue] = Date.now() - v0;
        lap(`boards ${venue}`);
      }
      this.lastBuildVenueMs = venueMs;
      for (const window of INDEX_WINDOWS) {
        const pending = await this.writePools(window, snap, now, built);
        for (const [venue, list] of pending) for (const a of list) want.get(venue)!.add(a);
      }
      lap('pools');
      for (const a of this.watchedHl) this.queueHistory('hyperliquid', a, windowStart('30d', now), 50);
      for (const [venue, m] of this.watched) {
        for (const [a, w] of m) {
          if (now - w.at > WATCH_MS) { m.delete(a); continue; }
          want.get(venue)!.add(a);
          this.queueHistory(venue, a, w.from, WATCH_PRIO);
        }
      }
      this.updateTracking(want, now);
      lap('tracking');
      await this.sweepStats(now);
      lap('sweep');
    } finally {
      this.lastBuildStepMs = steps;
      this.building = false;
      this.lastBuildAt = this.now();
      this.lastBuildMs = Date.now() - t0;
    }
  }

  /** Build one board, write it, queue the reads it still needs. Returns every address it wants indexed. */
  private async buildBoard(
    venue: Venue,
    window: BoardWindow,
    side: Side,
    filter: BoardFilter,
    snap: LbSnapshot | null,
    now: number,
    built: Map<string, BoardRow>,
  ): Promise<string[]> {
    const from = statsFrom(window, now);
    const base = WINDOW_WEIGHT[window] * 10 + (side === 'top' ? 200 : 0) + (filter === 'active' ? 100 : 0);
    const raw = this.candidates(venue, window, side, snap, now);
    // SoDEX accounts whose analytics booked a balance as profit rank nowhere.
    const cands = venue === 'sodex' && this.suspectSodex.size ? [...raw].filter((c) => !this.suspectSodex.has(c.address)) : raw;
    // HL publishes volume per window; 0 means no trade. SoDEX's figure is not
    // known to include spot, so there every candidate gets a real check.
    const res = await pickBoardAsync(cands, (c) => this.check(venue, c.address, window, from, now), {
      filter,
      side,
      size: BOARD_SIZE,
      maxPending: MAX_PENDING,
      skipZeroVolume: venue === 'hyperliquid' || venue === 'lighter',
    });
    res.pending.forEach((a, i) => this.queueCheck(venue, a, from, base + 1_000 - i));

    // Each trader's window stats are a scan of its fills (a market maker's can
    // take a while): warm them one by one, handing the event loop back between
    // them, so streams, lanes and requests are never held for the whole build.
    this.step = `${venue} ${window} ${side} ${filter}`;
    const statsOf = (address: string): PickStats => this.pickStats(venue, address, window, from, now);
    // The picks' first days side by side on the reader threads (store.ts prefetchPartials): after 00:00 UTC each was
    // nearly a whole day read row by row here, one pick after another (98 min for the first build of 2026-11-09).
    await this.store.prefetchPartials(venue, res.picks.map((c) => c.address), from, () => this.breathe());
    for (const c of res.picks) {
      await this.pickStatsAsync(venue, c.address, window, from, now);
      await this.tradeStateAsync(venue, c.address, window, from, now);
      await this.breathe();
    }

    const key = { venue, window, side, filter };
    const bk = `${venue}|${window}|${side}|${filter}`;
    // Rank change: against the board a day ago, else its oldest snapshot at least an hour old.
    let ref = this.store.boardRanksAt(key, now - RANK_BACK_MS);
    if (!ref) {
      const first = this.store.boardRanksFirst(key);
      if (first !== null && now - first >= HOUR_MS) ref = this.store.boardRanksAt(key, first);
    }

    if (venue === 'sodex' && filter === 'any' && COPY_WINDOWS.has(window)) {
      res.picks.forEach((c, i) => {
        const p = copyLeaderPrio(window, side, i);
        const was = this.copyLeaders.get(c.address);
        this.copyLeaders.set(c.address, { prio: was && was.at === now ? Math.max(was.prio, p) : p, at: now });
      });
    }
    const rows: BoardRow[] = res.picks.map((c, i) => {
      // Every pick is read in full over its window; the leaderboard's opening boards first.
      const prio = rowPrio(window, side, i, base - i);
      this.queueHistory(venue, c.address, from, prio);
      if (venue === 'tradexyz' && prio >= VIS_PRIO) this.ext.get('tradexyz')?.queueAccountValue?.(c.address, prio);
      const { stats, covered, capped, wrExact, wrFrom } = statsOf(c.address);
      const acct = this.store.account(venue, c.address);
      // A cohort read valued the wallet too (trade.xyz: its xyz margin book).
      let accountValue = acct?.accountValue ?? this.store.cohortEquity(venue, c.address);
      let label: string | null = acct?.label ?? null;
      if (venue === 'hyperliquid' && snap) {
        const idx = snap.indexOf(c.address);
        if (idx !== undefined) {
          const av = snap.data.accountValue[idx]!;
          accountValue = Number.isNaN(av) ? accountValue : av;
          label = snap.data.labels[idx] ?? label;
        }
      }
      if (venue === 'sodex' && acct?.accountId != null && (acct.avAt == null || now - acct.avAt > AV_MS)) {
        const id = acct.accountId;
        this.sdata.add({
          key: `av:${c.address}`,
          prio: Math.max(2_500 - i, rowPrio(window, side, i, 0)),
          run: async () => {
            this.store.setAccountValue('sodex', c.address, await fetchAccountValue(id), this.now());
            return 1;
          },
        });
      }
      // Trades: held fills and the stream's count; `exact` only when either covers the window.
      const t = this.tradeState(venue, c.address, window, from, now);
      const n = t.n ?? (covered ? stats.trades : null);
      const wr = winRateOf(stats.wins, stats.closes, wrExact);
      const rank = i + 1;
      const was = ref?.ranks.get(c.address);
      this.pendingStats.push({
        venue, window, address: c.address, trades: n, tradesExact: t.exact && !capped,
        wins: stats.wins, closes: stats.closes, winExact: wrExact, winFrom: wrFrom, at: now,
      });
      return {
        rank,
        venue,
        address: c.address,
        label,
        accountId: acct?.accountId ?? null,
        pnl: c.pnl,
        volume: c.volume ?? (covered ? stats.volume : null),
        // Qualified by closed positions or the stream while the held fills show fewer: at least MIN_TRADES.
        trades: filter === 'active' ? Math.max(MIN_TRADES, n ?? 0) : n,
        tradesCapped: capped || !t.exact || (filter === 'active' && (n ?? 0) < MIN_TRADES),
        // valuedesk/winRate.ts: exact over the window, or an estimate from enough held closes.
        winRate: wr.winRate,
        winExact: wr.winRateExact,
        winCloses: wr.winRateCloses,
        winFrom: wr.winRate !== null && !wr.winRateExact ? wrFrom : null,
        rankChange: ref ? (was === undefined ? null : was - rank) : null,
        accountValue,
        assets: venue === 'hyperliquid' ? stats.assets.map(this.coinName) : stats.assets,
      };
    });
    const snapHour = hourOf(now) * HOUR_MS;
    if (this.rankSnapAt.get(bk) !== snapHour && rows.length) {
      this.store.snapshotBoardRanks(key, now, rows.map((r) => ({ address: r.address, rank: r.rank })), now - RANK_BACK_MS - 2 * HOUR_MS);
      this.rankSnapAt.set(bk, snapHour);
    }
    for (const r of rows) built.set(`${venue}|${window}|${r.address}`, r);
    const sourceAt = venue === 'hyperliquid' ? (snap?.updatedAt ?? 0) : (isPublished(window) ? (this.listSnap[window] ?? 0) : this.chartPoolAt.sodex);
    this.store.writeBoard(
      {
        venue, window, side, filter,
        updatedAt: now,
        sourceAt,
        complete: res.complete && this.sourceReady(venue, window, snap, now),
        pending: res.pending.length,
        scanned: res.scanned,
        note: null,
        rankSince: ref?.t ?? null,
      },
      rows,
    );
    return [...res.picks.map((c) => c.address), ...res.pending];
  }

  /** A board pick's figures, reused for CACHE_MS (a few minutes behind is fine for a board). */
  private pickStats(venue: Venue, address: string, window: BoardWindow, from: number, now: number): PickStats {
    return this.cached(`s|${venue}|${address}|${window}`, venue, address, now, () => {
      const wc = this.winCoverage(venue, address, from);
      return {
        stats: this.store.windowStats(venue, address, from),
        covered: this.covered(venue, address, from, now),
        capped: this.kinds(venue).some((k) => {
          const cov = this.store.coverage(venue, address, k);
          return !!cov?.capped && cov.fromT > from;
        }),
        wrExact: wc.exact,
        wrFrom: wc.from,
      };
    }, true);
  }

  /**
   * Figures for indexed wallets that are on no board right now (screener,
   * cohorts, Scan read them from trader_stats): a few per venue per pass,
   * round-robin, so every indexed wallet is refreshed within the hour.
   */
  private async sweepStats(now: number): Promise<void> {
    // A TIME BUDGET (2026-11-08): this ran inside the build to the end, 23 min of a 55 min build (busy wallets' fills read
    // whole per window), and builds of 50-70 min tripped "boards not rebuilt for over an hour" though every board was
    // written. Now each venue gets its share of SWEEP_BUDGET_MS and the round-robin carries on from there next build;
    // the venue that starts rotates, so none is always last.
    const t0 = Date.now();
    const order = VENUES.map((_, j) => VENUES[(j + this.sweepTurn) % VENUES.length]!);
    this.sweepTurn = (this.sweepTurn + 1) % VENUES.length;
    for (let vi = 0; vi < order.length; vi++) {
      const venue = order[vi]!;
      const all = this.store.indexedAddresses(venue);
      if (!all.length) continue;
      // What is left of the budget, shared by the venues still to go.
      const until = Date.now() + Math.max(0, (sweepBudgetMs() - (Date.now() - t0)) / (order.length - vi));
      let i = this.statsSweep[venue] % all.length;
      for (let k = 0; k < Math.min(STATS_SWEEP, all.length) && Date.now() < until; k++, i = (i + 1) % all.length) {
        const address = all[i]!;
        const w0 = Date.now();
        for (const window of STATS_WINDOWS) {
          // Inside a wallet too (2026-11-08: one sweep ran 546 s against its 4 min): a market maker's windows each read
          // their partial first day, and on the busy thread that ran on for minutes. The rest of its windows come next time.
          if (Date.now() >= until) break;
          const from = statsFrom(window, now);
          this.step = `sweep ${venue}`;
          const st = await this.pickStatsAsync(venue, address, window, from, now);
          const t = await this.tradeStateAsync(venue, address, window, from, now);
          this.pendingStats.push({
            venue, window, address, trades: t.n, tradesExact: t.exact && !st.capped,
            wins: st.stats.wins, closes: st.stats.closes, winExact: st.wrExact, winFrom: st.wrFrom, at: now,
          });
        }
        if (Date.now() - w0 > 60_000) console.log(`[indexer] sweep: ${venue} ${address} took ${Math.round((Date.now() - w0) / 1000)} s`);
        await this.breathe();
      }
      this.statsSweep[venue] = i;
    }
    if (dayOf(now) !== dayOf(now - REBUILD_MS) && mayPrune('trader-stats')) this.store.pruneTraderStats(now - 3 * DAY_MS);
  }

  /** A venue's PnL and volume for any address in a window, from what the index holds. */
  private pnlLookup(venue: Venue, window: BoardWindow, snap: LbSnapshot | null, now: number): (a: string) => { pnl: number; volume: number | null } | null {
    if (venue === 'hyperliquid' && isPublished(window)) {
      if (!snap) return () => null;
      const pnl = snap.data.cols[`pnl:${window}`];
      const vol = snap.data.cols[`volume:${window}`];
      return (a) => {
        const i = snap.indexOf(a);
        if (i === undefined || Number.isNaN(pnl[i]!)) return null;
        const v = vol[i]!;
        return { pnl: pnl[i]!, volume: Number.isNaN(v) ? null : v };
      };
    }
    const map = new Map<string, { pnl: number; volume: number | null }>();
    for (const c of this.candidates(venue, window, 'top', snap, now)) map.set(c.address, { pnl: c.pnl, volume: c.volume });
    return (a) => map.get(a) ?? null;
  }

  /**
   * Netting pools for one window: each venue's top and worst POOL_EACH, plus
   * every pool address's figures on the other venues. Also walks the netted
   * ranking over all venues and queues trade checks for its unknowns.
   * Returns the addresses those checks want indexed, per venue.
   */
  private async writePools(window: BoardWindow, snap: LbSnapshot | null, now: number, built: Map<string, BoardRow>): Promise<Map<Venue, Set<string>>> {
    const from = statsFrom(window, now);
    const pools = new Map<Venue, Map<string, 'top' | 'worst'>>();
    const cross = new Set<string>();
    for (const venue of VENUES) {
      const pool = new Map<string, 'top' | 'worst'>();
      for (const side of SIDES) {
        let n = 0;
        for (const c of this.candidates(venue, window, side, snap, now)) {
          if (!pool.has(c.address)) pool.set(c.address, side);
          if (n < CROSS_EACH) cross.add(c.address);
          if (++n >= POOL_EACH) break;
        }
      }
      pools.set(venue, pool);
    }
    const all = new Set<string>();
    for (const p of pools.values()) for (const a of p.keys()) all.add(a);

    for (const venue of VENUES) {
      const look = this.pnlLookup(venue, window, snap, now);
      const pool = pools.get(venue)!;
      const rows: TraderWin[] = [];
      for (const address of all) {
        await this.breathe();
        const hit = look(address);
        if (!hit) {
          // Another venue's pool member this venue has not ranked yet: ask SoDEX once.
          if (venue === 'sodex' && isPublished(window) && cross.has(address)) {
            const k = `${window}|${address}`;
            if (now - (this.unranked.get(k) ?? 0) > UNRANKED_TTL) {
              this.sdata.add({
                key: `rank:${window}:${address}`,
                prio: 150,
                run: async () => {
                  if (!(await lookupPnl(this.store, window, address, this.now()))) this.markUnranked(window, address);
                  return 1;
                },
              });
            }
          }
          continue;
        }
        const b = built.get(`${venue}|${window}|${address}`);
        this.step = `pools ${venue} ${window}`;
        const t = venue === 'hyperliquid' && hit.volume === 0 ? { n: 0, exact: true } : await this.tradeStateAsync(venue, address, window, from, now);
        const stats = b ? this.cache.get(`s|${venue}|${address}|${window}`)?.value as PickStats | undefined : undefined;
        let accountValue = b?.accountValue ?? null;
        let label = b?.label ?? null;
        if (!b && venue === 'hyperliquid' && snap) {
          const i = snap.indexOf(address);
          if (i !== undefined) {
            const av = snap.data.accountValue[i]!;
            accountValue = Number.isNaN(av) ? null : av;
            label = snap.data.labels[i] ?? null;
          }
        }
        rows.push({
          venue,
          address,
          pool: pool.get(address) ?? 'x',
          pnl: hit.pnl,
          volume: hit.volume ?? b?.volume ?? null,
          trades: b?.trades ?? t.n,
          exact: t.exact,
          wins: stats ? stats.stats.wins : null,
          closes: stats ? stats.stats.closes : null,
          winExact: stats?.wrExact ?? false,
          accountValue,
          label,
          assets: b?.assets ?? [],
        });
      }
      this.store.writeTraderWin(venue, window, rows);
    }

    // The default view nets every venue: make sure its unknowns get checked.
    const want = new Map<Venue, Set<string>>(VENUES.map((v) => [v, new Set<string>()]));
    const base = WINDOW_WEIGHT[window] * 10 + 250;
    for (const side of SIDES) {
      const net = this.store.netCandidates(VENUES.filter((v) => v !== 'tradexyz'), window, side);
      net.sort((a, b) => (side === 'worst' ? a.pnl - b.pnl : b.pnl - a.pnl));
      let picks = 0;
      let pending = 0;
      for (const r of net) {
        await this.breathe();
        if (picks >= BOARD_SIZE || pending >= MAX_PENDING) break;
        if ((r.trades ?? 0) >= MIN_TRADES) { picks++; continue; }
        if (r.exact) continue;
        pending++;
        for (const venue of r.venues) {
          const t = await this.tradeStateAsync(venue, r.address, window, from, now);
          if (t.exact) continue;
          this.queueCheck(venue, r.address, from, base - pending);
          want.get(venue)!.add(r.address);
        }
      }
    }
    return want;
  }

  /** Point the streams at the wanted traders; forget the long unwanted. */
  private updateTracking(want: Map<Venue, Set<string>>, now: number): void {
    const wantHl = want.get('hyperliquid')!;
    const wantSodex = want.get('sodex')!;
    for (const [venue, set] of want) for (const a of set) this.wanted.set(`${venue}|${a}`, now);
    // A leader no Copy page board listed in this build is not read for it any more (its queued page goes with retain below if no board wants it).
    for (const [a, l] of this.copyLeaders) if (l.at < now) this.copyLeaders.delete(a);
    this.trackedHl = new Set([...wantHl, ...this.store.indexedAddresses('hyperliquid')]);
    for (const venue of this.ext.keys()) {
      this.trackedExt.set(venue, new Set([...want.get(venue)!, ...this.store.indexedAddresses(venue)]));
    }
    const sodex = new Set([...wantSodex, ...this.store.indexedAddresses('sodex')]);
    const ids = this.store.accountIds('sodex');
    for (const [id, a] of ids) this.sodexIdOf.set(a, id);
    const tracked = new Map<number, string>();
    for (const [id, a] of ids) if (sodex.has(a)) tracked.set(id, a);
    this.trackedSodex = tracked;
    if (this.cache.size > CACHE_MAX) {
      // Keep what the next build can still reuse; drop the rest (all of it, if that is not enough).
      const cut = now - this.reuseMs();
      for (const [k, v] of this.cache) if (v.at < cut) this.cache.delete(k);
      if (this.cache.size > CACHE_MAX * 2) this.cache.clear();
    }
    // Drop queued work nobody wants any more.
    const keep = (k: string) => {
      const a = k.split(':').pop()!;
      if (!a.startsWith('0x') || this.watchedHl.has(a)) return true;
      for (const set of want.values()) if (set.has(a)) return true;
      return false;
    };
    this.hl.retain((k) => k.startsWith('chart:') || k.startsWith('xyz:') || k.startsWith('xyzav:') || keep(k));
    for (const x of this.ext.values()) x.lane.retain((k) => !k.startsWith('q:') && !k.startsWith('h:') ? true : keep(k));
    this.sgw.retain(keep);
    this.scheck.retain(keep);
    this.strades.retain(keep);
    // Forget histories no board has wanted for two weeks (checked once a day): their fills and closes are deleted, so only with
    // the owner's word (retention.ts). Ungated until 2026-11-07, it had deleted 3,636,070 rows (retention totals.dropped).
    if (mayPrune('fills') && dayOf(now) !== dayOf(now - REBUILD_MS)) {
      for (const venue of VENUES) {
        for (const a of this.store.indexedAddresses(venue)) {
          const at = this.wanted.get(`${venue}|${a}`) ?? 0;
          const cov = this.store.coverage(venue, a, venue === 'sodex' ? 'perps' : 'fills');
          if (Math.max(at, cov?.restAt ?? 0) < now - FORGET_AFTER_MS) this.store.forget(venue, a);
        }
      }
    }
  }
}
