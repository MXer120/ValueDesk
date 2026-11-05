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
import { hlInfo, hlLeaderboard } from '../valuedesk/hyperliquid/index.js';
import type { LbSnapshot } from '../valuedesk/hyperliquid/leaderboard.js';
import { sodex } from '../sodex/rest.js';
import { gatewayWeightLimit, gatewayWeightSpent } from '../valuedesk/sodex/gateway.js';
import { knownAddress, resolveIds, seedAddress } from '../valuedesk/sodex/resolver.js';
import { cooldownLeftMs } from '../valuedesk/sodex/util.js';
import { VENUES, WINDOWS, type BoardWindow, type Venue, type Window } from '../valuedesk/types.js';
import { pickBoard, spanCovers, tradeCheck, type Candidate, type TradeCheck } from './boards.js';
import { hlCandidates, hlChartWindows, hlQuickCheck, hlSyncFills } from './hlSource.js';
import { Lane } from './lanes.js';
import { ArcusVenue } from './ext/arcus.js';
import { LighterVenue } from './ext/lighter.js';
import { TradexyzVenue } from './ext/tradexyz.js';
import type { ExtVenue } from './ext/types.js';
import { CohortTracker } from './cohortTracker.js';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { STALL_LOG_MS, gcWithin, mark, noteGc, startedBefore } from './busy.js';
import { SlicedWork } from './slicedWork.js';
import { hlCoinName } from '../valuedesk/extra/account.js';
import { accountValue as fetchAccountValue, chartWindows, lookupPnl, syncCloses, syncLists, syncTrades } from './sodexSource.js';
import type { BoardRow, Coverage, HistoryKind, IndexStore, TraderStatsRow, TraderWin } from './store.js';
import { winRateOf } from '../valuedesk/winRate.js';
import { HlStream, SodexStream, streamLog, type Print } from './streams.js';
import { mayPrune } from '../retention.js';
import { FlowRecorder } from '../flow/recorder.js';
import { FlowStore } from '../flow/store.js';
import { dirname, join } from 'node:path';
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
/** A flush keeps the thread this long at a time: 40 ms when it is keeping up, up to 500 ms when it is not. */
export const flushBudget = (backlog: number): number => Math.min(500, 40 + backlog);
/** Rows per transaction in a flush: at ~2 ms a row, 150 fills are a third of a second of the thread. */
const FLUSH_FILLS = 150;
const FLUSH_ACTIVITY = 300;
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
interface StreamGap { from: number; to: number; broke: boolean }
/** One board pick's figures from what the index holds. */
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
  readonly strades: Lane;
  readonly sdata: Lane;
  private hlStream: HlStream | null = null;
  private sodexStream: SodexStream | null = null;
  private timers: NodeJS.Timeout[] = [];
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
  /** Every print kept for the per-candle breakdown (flow/recorder.ts); off with VALUESCAN_FLOW=0. */
  flow: FlowRecorder | null = null;
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
  private pendingStats: TraderStatsRow[] = [];
  /** SoDEX accounts whose analytics booked a balance as profit (sodex/mappers.ts chartSuspect). */
  private suspectSodex = new Set<string>();

  constructor(readonly store: IndexStore, private readonly now: () => number = Date.now) {
    this.hl = new Lane({ name: 'hl', perMin: INDEXER_ENV.hlWeightPerMin() });
    // SoDEX gateway lanes count requests. Both stand back while any cooldown
    // runs (the trading UI shares the IP) or this process has spent a third of
    // the gateway's minute (the limit SoDEX reports: 6000 on 2026-10-31), and
    // pause 15 minutes after a 429.
    const sodexGate = () => Math.max(cooldownLeftMs(), sodex.cooldownLeft(), gatewayWeightSpent() > gatewayWeightLimit() / 3 ? 5_000 : 0);
    this.sgw = new Lane({ name: 'sgw', perMin: INDEXER_ENV.sodexClosesPerMin(), gate: sodexGate, rateLimitPauseMs: 15 * 60_000 });
    // The indexer's only SoDEX `/trades` reader (off unless VALUESCAN_INDEX_SODEX_TRADES
    // is set). Each task reads ONE page (syncTrades maxPages: 1) and the lane then
    // rests, so its rate is `perMin`, capped at SODEX_HISTORY_PAIR_PER_MIN: the
    // measured /trades + /orders/history counter (~4 per 60 s per IP, then 1015).
    this.strades = new Lane({ name: 'strades', perMin: INDEXER_ENV.sodexTradesPerMin(), gate: sodexGate, rateLimitPauseMs: 30 * 60_000 });
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

  start(): void {
    this.stopped = false;
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
    this.hl.start();
    this.sgw.start();
    this.strades.start();
    this.sdata.start();
    for (const x of this.ext.values()) {
      x.start({ store: this.store, now: this.now, streamSince: (v) => this.streamSince(v), onPrint: (p) => this.onPrint(p), hlLane: this.hl });
    }
    lap('lanes and venues');
    if (INDEXER_ENV.streams() && process.env.VALUESCAN_FLOW !== '0' && !this.flow) {
      try {
        const path = process.env.VALUESCAN_FLOW_DB?.trim() || join(dirname(this.store.path), 'valuescan-flow.db');
        this.flow = new FlowRecorder(new FlowStore(path), (venue, acct) =>
          venue === 'sodex' ? this.sodexAddrOf.get(Number(acct)) ?? null : this.ext.get(venue)?.addressOf?.(acct) ?? null);
      } catch (e) {
        this.lastError = `flow: ${String(e)}`;
      }
    }
    lap('who traded recorder');
    if (INDEXER_ENV.streams()) {
      this.hlStream = new HlStream((p) => this.onPrint(p));
      this.sodexStream = new SodexStream((p) => this.onPrint(p));
      this.hlStream.start();
      this.sodexStream.start();
    }
    const every = (ms: number, fn: () => void | Promise<void>, name = 'timer') => {
      const t = setInterval(() => { mark(name); void Promise.resolve(fn()).catch((e) => (this.lastError = String(e))); }, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(FLUSH_MS, () => this.flush(), 'flush');
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
    every(REBUILD_MS, () => this.rebuild(), 'rebuild');
    try {
      this.gcWatch = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) noteGc(performance.timeOrigin + e.startTime, e.duration);
      });
      this.gcWatch.observe({ entryTypes: ['gc'] });
    } catch { /* the stall lines then say 0 s of it */ }
    let tick = Date.now();
    every(500, () => {
      const now = Date.now();
      const late = Math.max(0, now - tick - 500);
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
    setTimeout(() => void this.rebuild().catch((e) => (this.lastError = String(e))), 3_000).unref?.();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.gcWatch?.disconnect();
    this.hl.stop();
    this.sgw.stop();
    this.strades.stop();
    this.sdata.stop();
    this.hlStream?.stop();
    this.sodexStream?.stop();
    for (const x of this.ext.values()) x.stop();
    this.cohorts.stop();
    this.flush();
    if (this.flow) {
      this.flow.stop();
      try { this.flow.store.close(); } catch { /* closed */ }
      this.flow = null;
    }
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
   * STREAM_GAP_MS (kept across restarts). Every trade of every account since
   * then is in the activity tables, and every fill of a tracked trader in
   * `fills`. Null while the stream is down.
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
      if (st.since === null || up - st.lastUp > STREAM_GAP_MS) st.since = up;
      st.lastUp = now;
      this.store.setMeta(`stream_since:${venue}`, String(st.since));
      this.store.setMeta(`stream_up:${venue}`, String(st.lastUp));
    }
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
      aggregates: this.store.aggBacklog,
      heldPartials: this.store.heldPartials,
      checkpoint: this.store.checkpointStatus,
      flushBacklog: this.writes.backlog,
      retention: this.store.retention(this.now()),
      lanes: { hl: lane(this.hl), sgw: lane(this.sgw), strades: lane(this.strades), sdata: lane(this.sdata) },
      venues: Object.fromEntries([...this.ext].map(([v, x]) => [v, x.status()])),
      tracked: {
        hyperliquid: this.trackedHl.size,
        sodex: this.trackedSodex.size,
        ...Object.fromEntries([...this.trackedExt].map(([v, s]) => [v, s.size])),
      },
      lastBuildAt: this.lastBuildAt,
      lastBuildMs: this.lastBuildMs,
      lastBuildVenueMs: this.lastBuildVenueMs,
      lastBuildStepMs: this.lastBuildStepMs,
      lastError: this.lastError,
      loopLagMs: { lastMinute: this.lag.window, sinceStart: this.lag.max, spikes: this.spikes },
      hlBudget: Math.round(hlInfo.budget.available()),
      cohorts: this.cohorts.status(),
    };
  }

  // --- streams ----------------------------------------------------------------------

  private onPrint(p: Print): void {
    // Hyperliquid's HIP-3 dex "xyz" is also ranked on its own as trade.xyz.
    if (p.venue === 'hyperliquid' && p.symbol.startsWith('xyz:')) this.onPrint({ ...p, venue: 'tradexyz' });
    // Cohorts: the print moves both parties' books (SoDEX prints carry account ids).
    mark(`print:${p.venue}`);
    this.flow?.add(p);
    const ext = this.ext.get(p.venue);
    const addressOf = (acct: string): string | null =>
      p.venue === 'sodex' ? this.sodexAddrOf.get(Number(acct)) ?? null : ext?.addressOf ? ext.addressOf(acct) : acct;
    this.cohorts.onPrint(p, addressOf);
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
      if (address) {
        this.pendingFills.push({
          venue: p.venue, address, id: p.id, t: p.t, symbol: p.symbol, side, px: p.px, sz: p.sz,
          fee: null, closedPnl: null, oid: null, src: 0,
        });
      }
    }
    if (this.lastOrder.size > 300_000) this.lastOrder.clear();
  }

  private flush(): void {
    const rows: Array<{ venue: Venue; acct: string; hour: number; trades: number; volume: number }> = [];
    for (const [k, v] of this.act) {
      const [venue, acct, hour] = k.split('|');
      rows.push({ venue: venue as Venue, acct: acct!, hour: Number(hour), trades: v.trades, volume: v.volume });
    }
    this.act.clear();
    const fills = this.pendingFills;
    this.pendingFills = [];
    const at = this.now();
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
    for (let i = 0; i < rows.length; i += FLUSH_ACTIVITY) steps.push(write(() => this.store.addActivity(rows.slice(i, i + FLUSH_ACTIVITY))));
    for (let i = 0; i < fills.length; i += FLUSH_FILLS) steps.push(write(() => this.store.putFills(fills.slice(i, i + FLUSH_FILLS))));
    // Days with new fills: re-summed a slice at a time, never holding the loop.
    steps.push(write(() => { this.store.flushAggregates(40); }));
    // After this flush's rows are written, and as of the time they were taken: what the coverage claims is stored.
    steps.push(() => {
      if (failed) return;
      this.store.tx(() => {
        this.trackStreams(at);
        this.advanceCoverage(at);
      });
    });
    steps.push(() => {
      if (!this.pendingStats.length) return;
      const stats = this.pendingStats;
      this.pendingStats = [];
      this.store.putTraderStats(stats);
    });
    this.writes.add(steps);
    if (this.stopped) this.writes.drain();
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
    return Math.min(MAX_REUSE_MS, Math.max(CACHE_MS, Math.round(this.lastBuildMs * 1.5)));
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
      this.hl.add({ key: `q:${address}`, prio, run: () => hlQuickCheck(this.store, address, from, this.now()) });
      return;
    }
    // SoDEX: closed positions first (not rate limited like /trades). A wallet
    // they cannot prove stays pending until the stream covers the window.
    const closes = this.store.coverage('sodex', address, 'closes');
    if (closes && closes.fromT <= from && now - closes.restAt < RESYNC_MS) return;
    this.sgw.add({
      key: `q:${address}`,
      prio,
      run: async () => (await syncCloses(this.store, address, from, { maxPages: 1, now: this.now() })).pages,
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
            const r = await hlSyncFills(this.store, address, this.now(), { maxPages: 1, now: this.now() });
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
            const r = await hlSyncFills(this.store, address, f, { maxPages: 6, now: this.now() });
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
    // Fills: the stream records them from now on. /trades only when explicitly enabled.
    if (!INDEXER_ENV.sodexTradesEnabled()) return;
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

  // --- sources ------------------------------------------------------------------------

  private async hlSnapshot(): Promise<LbSnapshot | null> {
    try {
      return await hlLeaderboard.snapshot();
    } catch (e) {
      this.lastError = `hl leaderboard: ${String(e)}`;
      return hlLeaderboard.peek();
    }
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
    const active = this.store.activeAccounts('sodex', HOUR_WINDOWS.has(w) ? { hour: hourOf(from) } : { day: dayOf(from) }, 1, LOOKUP_ACTIVE);
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
   * Hand the event loop back if this build has held it for 40 ms. The build is
   * a long run of synchronous SQLite reads chained by `await`s of settled
   * promises - microtasks, which never let timers or sockets in. Without this a
   * cold build held the loop for ~110 s and every upstream request in that
   * time failed as a timeout (profiled 2026-09-29).
   */
  private async breathe(): Promise<void> {
    if (Date.now() - this.lastBreath < 40) return;
    await new Promise<void>((r) => setImmediate(r));
    this.lastBreath = Date.now();
    // What runs after this is the build again, not whatever marked last.
    mark(this.step ? `rebuild:${this.step}` : 'rebuild');
  }

  async rebuild(): Promise<void> {
    if (this.building || this.stopped) return;
    this.building = true;
    const t0 = Date.now();
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
    const res = pickBoard(cands, (c) => this.check(venue, c.address, window, from, now), {
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
    for (const venue of VENUES) {
      const all = this.store.indexedAddresses(venue);
      if (!all.length) continue;
      let i = this.statsSweep[venue] % all.length;
      for (let k = 0; k < Math.min(STATS_SWEEP, all.length); k++, i = (i + 1) % all.length) {
        const address = all[i]!;
        for (const window of STATS_WINDOWS) {
          const from = statsFrom(window, now);
          this.step = `sweep ${venue}`;
          const st = await this.pickStatsAsync(venue, address, window, from, now);
          const t = await this.tradeStateAsync(venue, address, window, from, now);
          this.pendingStats.push({
            venue, window, address, trades: t.n, tradesExact: t.exact && !st.capped,
            wins: st.stats.wins, closes: st.stats.closes, winExact: st.wrExact, winFrom: st.wrFrom, at: now,
          });
        }
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
    this.strades.retain(keep);
    // Forget histories no board has wanted for two weeks (checked once a day).
    if (dayOf(now) !== dayOf(now - REBUILD_MS)) {
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
