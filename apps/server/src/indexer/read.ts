/**
 * What the API reads from the index: finished boards and per-trader stats.
 *
 * Reads the same file the indexer writes (another thread or process) through
 * one READ-ONLY connection (reader.ts): nothing here can write to it or
 * migrate it. A missing file, one the writer has not migrated yet, or a
 * board not built yet reads as `null`, and the route says "indexing".
 */
import type { BoardWindow, TraderRow, Venue } from '../valuedesk/types.js';
import { VENUES } from '../valuedesk/types.js';
import { mergeBoards } from './boards.js';
import { closeReader, reader } from './reader.js';
import type { CohortBookRow, CohortMemberRow, NetRow } from './store.js';
import { IndexStore, type BoardRow, type HistoryKind } from './store.js';
import { BOARD_SIZE, MIN_TRADES, windowStart, type BoardFilter, type Side } from './windows.js';
import {
  Aggregator, MARGIN_SIBLING, TAIL_EQUITY, cohortsOf, filterKey, holdsPosition, longShare, netWallet, perpEquity, scopeKey, scopeWalletSteps, walletRow,
  type CohortSums, type MarkOf,
  type CohortFocusResponse, type CohortMapResponse, type MapSector,
  type CohortDetailResponse, type CohortFilter, type CohortId, type CohortPoint, type CohortRange, type CohortWalletRow,
  type CohortWalletsResponse, type CohortsResponse, type NettedWallet, type Sector, type VenueCoverage, type WalletSort, type WalletVenue,
} from '../valuedesk/cohorts/model.js';
import { tailCountRate, tailOf } from './cohortTracker.js';
import { labelMatches, shownLabel } from '../valuedesk/labels.js';
import { winRateOf } from '../valuedesk/winRate.js';
import { sampledVenue, COHORT_RANGES, type CohortWalletRow as WalletRow } from '../valuedesk/cohorts/model.js';
import { EXCLUDED_FROM, EXCLUDED_WALLETS, isExcluded, outOfCohorts, type ExcludedFrom, type ExcludedWallet } from '../valuedesk/internalWallets.js';
import { liqCoin } from '../valuedesk/liquidations/levels.js';
import { activityCoverage } from '../flow/read.js';

export interface IndexState {
  /** Every board behind this page is final (no unchecked wallet outranks a pick). */
  complete: boolean;
  /** Wallets still waiting for a trade check. */
  pending: number;
  /** When the board was last rebuilt. */
  updatedAt: number;
  /** When the ranks `rankChange` compares against were taken (null = no snapshot old enough yet). */
  rankSince?: number | null;
}

export interface BoardPage {
  rows: TraderRow[];
  total: number;
  updatedAt: number;
  source: string;
  index: IndexState;
  /** Present when SoDEX's trade counts on this page are floors: why. */
  sodexTrades?: SodexTradeNote;
}

/** The days of a window on which SoDEX's activity is not whole (flow/ledger.ts). Trade counts drawn from it are floors. */
export interface SodexTradeNote {
  days: number;
  short: number;
  unchecked: number;
  /** The day with the smallest share of SoDEX's own volume. */
  lowest: { t: number; share: number } | null;
}

const NOTE_MS = 60_000;
const notes = new Map<BoardWindow, { at: number; note: SodexTradeNote | null }>();

/** Null when every day of the window is proved whole. */
function sodexTradeNote(window: BoardWindow, now: number): SodexTradeNote | null {
  const hit = notes.get(window);
  if (hit && now - hit.at < NOTE_MS) return hit.note;
  let from = windowStart(window, now);
  // Before the first activity row there is nothing to be short of.
  const first = reader()?.firstActivity('sodex');
  if (first !== null && first !== undefined) from = Math.max(from, first);
  const { days } = activityCoverage(Math.max(from, now - 400 * 86_400_000), now, now);
  const short = days.filter((d) => d.state === 'short');
  const unchecked = days.filter((d) => d.state === 'unchecked').length;
  let lowest: SodexTradeNote['lowest'] = null;
  for (const d of short) if (d.share !== null && (!lowest || d.share < lowest.share)) lowest = { t: d.t, share: d.share };
  const note = short.length || unchecked ? { days: days.length, short: short.length, unchecked, lowest } : null;
  notes.set(window, { at: now, note });
  return note;
}

/** Tests: forget what was worked out. */
export function clearTradeNotes(): void {
  notes.clear();
}

/**
 * SoDEX's trade counts come from the activity tables (or the fills, which ride the same stream), so a count over a day that
 * is short is a floor however long the socket stayed up: such rows read "n+", and the page says why.
 */
export function markSodexTrades(rows: TraderRow[], window: BoardWindow, now = Date.now()): SodexTradeNote | undefined {
  const onSodex = rows.filter((r) => (r.venues ?? [r.venue]).includes('sodex'));
  if (!onSodex.length) return undefined;
  const note = sodexTradeNote(window, now);
  if (!note) return undefined;
  for (const r of onSodex) if (r.trades !== null && r.trades !== undefined) r.tradesCapped = true;
  return note;
}

function toRow(r: BoardRow, window: BoardWindow, rank: number): TraderRow {
  return {
    venue: r.venue,
    address: r.address,
    label: shownLabel(r.address, r.label),
    accountId: r.accountId,
    accountValue: r.accountValue,
    pnl: { [window]: r.pnl },
    roi: {},
    volume: { [window]: r.volume },
    winRate: r.winRate,
    winRateExact: r.winRate === null ? undefined : !!r.winExact,
    winRateCloses: r.winCloses ?? null,
    winRateFrom: r.winFrom ?? null,
    trades: r.trades,
    tradesCapped: r.tradesCapped,
    assets: r.assets,
    rank,
    // Movement on THIS board; a merged multi-venue page has no single previous board.
    rankChange: r.rankChange ?? null,
  };
}

const WINDOW_WORD: Record<BoardWindow, string> = {
  '1d': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', ytd: 'year to date', all: 'all time',
};

/** One page of a board; `venue: 'all'` merges both venues' hundreds into one. */
export function boardPage(
  venue: Venue | 'all' | readonly Venue[],
  window: BoardWindow,
  side: Side,
  filter: BoardFilter,
  o: { limit: number; offset: number; q?: string },
): BoardPage | null {
  const s = reader();
  if (!s) return null;
  const venues: readonly Venue[] = venue === 'all' ? VENUES : typeof venue === 'string' ? [venue] : venue;
  let boards;
  try {
    boards = venues.map((v) => s.readBoard(v, window, side, filter)).filter((b) => b !== null);
  } catch {
    return null;
  }
  if (!boards.length) return null;
  let rows = boards.length === 1 ? boards[0]!.rows : mergeBoards(boards.map((b) => b.rows), side);
  if (boards.length > 1) rows = rows.map((r) => ({ ...r, rankChange: null }));
  const q = o.q?.trim().toLowerCase();
  if (q) rows = rows.filter((r) => r.address.includes(q) || labelMatches(r.address, r.label, q));
  const which = side === 'worst' ? 'Lowest' : 'Highest';
  const who = filter === 'active' ? 'traders with more than one trade' : 'traders';
  const what = venues.length === 1 && venues[0] === 'tradexyz' ? 'realised PnL (closed trades, net of fees)' : 'PnL';
  const shownRows = rows.slice(o.offset, o.offset + o.limit).map((r, i) => toRow(r, window, o.offset + i + 1));
  const sodexTrades = markSodexTrades(shownRows, window);
  return {
    ...(sodexTrades ? { sodexTrades } : {}),
    rows: shownRows,
    total: rows.length,
    updatedAt: Math.max(...boards.map((b) => b.meta.sourceAt || b.meta.updatedAt)),
    source: `ValueDesk index. ${which} ${what} over ${WINDOW_WORD[window]} among ${who} in that window.`,
    index: {
      complete: boards.every((b) => b.meta.complete) && boards.length === venues.length,
      pending: boards.reduce((n, b) => n + b.meta.pending, 0),
      updatedAt: Math.min(...boards.map((b) => b.meta.updatedAt)),
      rankSince: boards.length === 1 ? boards[0]!.meta.rankSince ?? null : null,
    },
  };
}

const VENUE_WORD: Record<Venue, string> = { sodex: 'SoDEX', hyperliquid: 'Hyperliquid', tradexyz: 'trade.xyz', lighter: 'Lighter', arcus: 'Arcus' };

function netToRow(r: NetRow, window: BoardWindow, rank: number): TraderRow {
  const wr = winRateOf(r.wins, r.closes, r.winExact);
  return {
    venue: r.venues[0]!,
    venues: r.venues,
    address: r.address,
    label: shownLabel(r.address, r.label),
    accountId: r.accountId ?? undefined,
    accountValue: r.accountValue,
    pnl: { [window]: r.pnl },
    roi: {},
    volume: { [window]: r.volume },
    winRate: wr.winRate,
    winRateExact: wr.winRate === null ? undefined : wr.winRateExact,
    winRateCloses: wr.winRateCloses,
    trades: r.trades,
    tradesCapped: !r.exact,
    assets: r.assets.slice(0, 3),
    rank,
    rankChange: null,
  };
}

/**
 * The netted ranking: every address's PnL, volume and trades summed over the
 * selected venues, then ranked. With the trade filter an address needs more
 * than one trade across those venues; one whose count is not final yet is
 * left out and counted as pending.
 */
export function netPage(
  venues: readonly Venue[],
  window: BoardWindow,
  side: Side,
  filter: BoardFilter,
  o: { limit: number; offset: number; q?: string },
): BoardPage | null {
  const s = reader();
  if (!s) return null;
  let rows: NetRow[];
  // Hyperliquid's own figures already include its xyz dex: netting both would count xyz twice.
  const set = venues.includes('hyperliquid') ? venues.filter((v) => v !== 'tradexyz') : venues;
  try {
    rows = s.netCandidates(set, window, side);
  } catch {
    return null;
  }
  if (!rows.length) return null;
  rows.sort((a, b) => (side === 'worst' ? a.pnl - b.pnl : b.pnl - a.pnl));
  const picked: NetRow[] = [];
  let pending = 0;
  for (const r of rows) {
    if (picked.length >= BOARD_SIZE) break;
    if (side === 'top' ? r.pnl <= 0 : r.pnl >= 0) break;
    if (filter === 'active') {
      if ((r.trades ?? 0) < MIN_TRADES) {
        if (!r.exact) pending++;
        continue;
      }
    }
    picked.push(r);
  }
  const q = o.q?.trim().toLowerCase();
  const shown = q ? picked.filter((r) => r.address.includes(q) || labelMatches(r.address, r.label, q)) : picked;
  const metas = venues.map((v) => s.readBoard(v, window, side, filter)?.meta).filter((m) => !!m);
  const which = side === 'worst' ? 'Lowest' : 'Highest';
  const who = filter === 'active' ? ', among traders with more than one trade in that window' : '';
  const shownRows = shown.slice(o.offset, o.offset + o.limit).map((r, i) => netToRow(r, window, o.offset + i + 1));
  const sodexTrades = markSodexTrades(shownRows, window);
  return {
    ...(sodexTrades ? { sodexTrades } : {}),
    rows: shownRows,
    total: shown.length,
    updatedAt: Math.max(0, ...metas.map((m) => m.sourceAt || m.updatedAt)),
    source: `ValueDesk index. ${which} PnL over ${WINDOW_WORD[window]}, netted per address across ${venues.map((v) => VENUE_WORD[v]).join(' + ')}${who}.`,
    index: {
      complete: pending === 0 && metas.length === venues.length && metas.every((m) => m.complete),
      pending,
      updatedAt: Math.min(...metas.map((m) => m.updatedAt), Date.now()),
    },
  };
}

/**
 * Trades, win rate and most-traded assets for rows that came from a venue
 * list (other sorts, searches), for traders the index holds.
 */
export function attachStats(rows: TraderRow[], window: BoardWindow): void {
  const s = reader();
  if (!s) return;
  try {
    const byVenue = new Map<Venue, TraderRow[]>();
    for (const row of rows.slice(0, 500)) byVenue.set(row.venue, [...(byVenue.get(row.venue) ?? []), row]);
    for (const [venue, list] of byVenue) {
      const stats = s.traderStats(venue, window, list.map((r) => r.address));
      for (const row of list) {
        const st = stats.get(row.address);
        if (!st) continue;
        if (st.trades !== null) {
          row.trades = st.trades;
          row.tradesCapped = !st.tradesExact;
        }
        const wr = winRateOf(st.wins, st.closes, st.winExact);
        row.winRate = wr.winRate;
        row.winRateExact = wr.winRateExact;
        row.winRateCloses = wr.winRateCloses;
        row.winRateFrom = wr.winRate !== null && !wr.winRateExact ? st.winFrom : null;
      }
    }
  } catch { /* stats are decoration; the rows stand without them */ }
}

/**
 * The index's win rate for these addresses on one venue and window, by the
 * shared definition (valuedesk/winRate.ts). Missing = not indexed.
 */
export function winRatesFor(venue: Venue, window: BoardWindow, addresses: readonly string[]): Map<string, { winRate: number | null; winRateExact: boolean; winRateCloses: number | null; winRateFrom: number | null; trades: number | null; tradesExact: boolean }> {
  const out = new Map<string, { winRate: number | null; winRateExact: boolean; winRateCloses: number | null; winRateFrom: number | null; trades: number | null; tradesExact: boolean }>();
  const s = reader();
  if (!s) return out;
  try {
    for (const [a, st] of s.traderStats(venue, window, addresses)) {
      const wr = winRateOf(st.wins, st.closes, st.winExact);
      out.set(a, { ...wr, winRateFrom: wr.winRate !== null && !wr.winRateExact ? st.winFrom : null, trades: st.trades, tradesExact: st.tradesExact });
    }
  } catch { /* none */ }
  return out;
}

/**
 * A venue's pool for the screener from the index's own boards (trade.xyz,
 * Lighter, Arcus): every board row of the published windows, both sides,
 * merged per address with each window's PnL. No upstream call.
 */
export function indexPool(venue: Venue): { rows: TraderRow[]; updatedAt: number } | null {
  const s = reader();
  if (!s) return null;
  const by = new Map<string, TraderRow>();
  let updatedAt = 0;
  try {
    for (const window of ['1d', '7d', '30d', 'all'] as const) {
      for (const side of ['top', 'worst'] as const) {
        const b = s.readBoard(venue, window, side, 'any');
        if (!b) continue;
        updatedAt = Math.max(updatedAt, b.meta.sourceAt || b.meta.updatedAt);
        for (const r of b.rows) {
          const row = toRow(r, window, r.rank);
          const cur = by.get(r.address);
          if (!cur) {
            by.set(r.address, { ...row, rank: undefined, rankChange: null });
            continue;
          }
          cur.pnl = { ...cur.pnl, ...row.pnl };
          cur.volume = { ...cur.volume, ...row.volume };
          cur.accountValue = cur.accountValue ?? row.accountValue;
          if (window === '30d') {
            cur.winRate = row.winRate;
            cur.winRateExact = row.winRateExact;
            cur.winRateCloses = row.winRateCloses;
            cur.winRateFrom = row.winRateFrom;
            cur.trades = row.trades;
            cur.tradesCapped = row.tradesCapped;
          }
        }
      }
    }
  } catch {
    return null;
  }
  return by.size ? { rows: [...by.values()], updatedAt } : null;
}

// --- cohorts ---------------------------------------------------------------------
//
// Netted and filtered HERE, from what the worker keeps current: members
// (cohort_member), books moved by the streams (cohort_book) and last prices
// (cohort_mark). One load per venue is shared by every request for a minute;
// one netting per set of venues and one sum per filter likewise.
//
// THE LOAD DOES NOT HOLD A REQUEST WHILE THE PAGES ARE IN USE. Reading some
// 270k wallets takes this thread 3 s and netting five venues 1.4 s more
// (measured 2026-10-02). That used to happen inside whichever request found
// the minute-old load expired, and for those seconds NO route answered - there
// is one event loop. Now the load in use is replaced from behind: a rebuild
// starts before it turns a minute old, does the very same work in slices that
// let requests through in between, nets and sums what the pages asked for
// lately as well, and is swapped in whole. Only the first read, and one after
// nobody asked for KEEP_WARM_MS, still build in place - as every expired read
// did before.

const RANGE_MS: Record<CohortRange, number> = { '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
const SPARK_POINTS = 96;
export const LOAD_TTL_MS = 60_000;
/**
 * No answer comes from a load older than this: cohortsReady rebuilds and waits for it. Once
 * nobody had asked for KEEP_WARM_MS the rebuilds stopped and the next read was answered from
 * the load in use, however old - 18 to 21 hours on 2026-10-30 (a wallet list showing a 500 BTC
 * long closed the evening before, BTC priced at 78,809 against 77,200).
 */
export const STALE_MAX_MS = 2 * LOAD_TTL_MS;
/** How long cohortsReady waits for a rebuild before answering from what it has. */
export const READY_WAIT_MS = 10_000;
/** Rows per statement while a load is built. */
const LOAD_PAGE = 2_000;
/** A rebuild from behind gives the thread back after this much work. */
const SLICE_MS = 8;
/**
 * Sets and filters asked for are summed ahead for this long after their last read. The default
 * page (warmCohorts' scope) is rebuilt always: until 2026-10-31 every rebuild stopped after 5 min
 * without a read, and the next visitor waited 11-16 s for a load 25 min old.
 */
export const KEEP_WARM_MS = 5 * 60_000;
/** A rebuild starts at least this long before the load in use expires (longer once the last one's time is known). */
const REBUILD_LEAD_MS = 15_000;
/** Sets of venues, and filters per set, that are rebuilt ahead. */
const WANT_SCOPES = 12;
const WANT_FILTERS = 24;

/** An excluded wallet's book as the cohort tables hold it. */
interface ExcludedBook {
  equity: number | null;
  positions: ReadonlyArray<{ symbol: string; szi: number; entry: number | null }>;
  at: number;
}

interface CohortLoad {
  at: number;
  /** Which load this is (loadSteps counts them). */
  gen: number;
  per: Map<Venue, Map<string, WalletVenue>>;
  marks: Map<string, number>;
  coverage: Partial<Record<Venue, VenueCoverage>>;
  /** Newest book write (ms). */
  booksAt: number;
  /** `venue|coin` -> the open interest (coins, one side) the excluded wallets hold (internalWallets.ts): not the traders'. */
  internal: Map<string, number>;
  /** `venue|address` -> an excluded wallet's book, for the page that lists them (excludedNow). */
  excluded: Map<string, ExcludedBook>;
  /** Netted wallets per set of venues: built on first use, or ahead by a rebuild. */
  scopes: Map<string, NettedWallet[]>;
  /** Every cohort's figures (and every holding wallet's) per set of venues and filter, likewise. */
  stats: Map<string, CohortSums>;
  /** The rows kept between loads as this load left them; null for a load that keeps none (netted in full). */
  state: CohortState | null;
}

/** What a rebuild nets and sums ahead: the sets and filters asked for lately. */
interface Want {
  venues: Venue[];
  askedAt: number;
  filters: Map<string, { f: CohortFilter; askedAt: number }>;
}

let cohortLoad: CohortLoad | null = null;
const wanted = new Map<string, Want>();
let lastAsked = 0;
let rebuilding = false;
/** The rebuild from behind under way (cohortsReady waits for it while there is no load yet). */
let inflight: Promise<unknown> | null = null;
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let lastRebuildMs = 0;
/** The default page's scope (warmCohorts): kept warm whether or not anyone reads it. */
let warmKey: string | null = null;
/** When a rebuild from behind last failed: the next one waits, instead of spinning. */
let rebuildFailedAt = 0;
/** Counters for tests and diagnostics: loads built inside a read, and from behind. */
const built = { inPlace: 0, behind: 0 };

/** Run steps to the end, here and now. */
function runNow<T>(steps: Generator<void, T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** Run steps to the end, giving the thread back whenever SLICE_MS of work is done. */
async function runBehind<T>(steps: Generator<void, T>): Promise<T> {
  let since = performance.now();
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (performance.now() - since >= SLICE_MS) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      since = performance.now();
    }
  }
}

// --- keeping the load current ------------------------------------------------------
//
// INCREMENTAL (2026-10-31). Every load used to page all ~500k members and ~550k books out of
// SQLite, build a WalletVenue for each and net every wallet again: 56% of the API's one thread
// (profiled 18:19: paging ~19%, netting ~18%), the API at 96-133% of a core. The writer now
// numbers every row it puts and every member it removes (store.ts COHORT_REV_SCHEMA), so a load
// reads only what changed since the last one and keeps the rest:
//   - the rows per venue stay in memory between loads (members, books, both in address order);
//   - a WalletVenue is rebuilt only for an address whose member or book changed, or whose
//     sibling book did (Hyperliquid / trade.xyz perp equity); every one of a venue's when its
//     tail's counting rate flips (tailCountRate, kept from counters);
//   - the per-venue maps are in the full load's order (members by address, then books with no
//     member), reusing every WalletVenue that did not change: the heatmap and the sums iterate
//     them, and a float sum depends on its order. A venue where no address came or went keeps
//     the last map's order, its changed WalletVenues set in place (layOut, 2026-11-02);
//   - a set of venues re-nets only the addresses changed on one of its venues and the holders
//     of a coin whose mark moved, and reuses every other netted wallet: the last list copied and
//     patched by index, with only the addresses that came or went moved (renet, 2026-11-02);
//   - the sums (Aggregator) are redone over the netted list each load: summing in another order,
//     or taking a wallet out of a float sum, would not give the full load's figures bit for bit.
// The first load, one after a gap (tombstones pruned past it), a new sequence (a fresh or restored
// file) or a failed load reads everything, as before. A file whose writer has no sequence yet
// is always loaded in full. cohortsIncremental.test.ts checks every answer against a full load.

/** One venue's rows and what was built from them, kept from load to load. */
interface VenueRows {
  members: Map<string, CohortMemberRow>;
  books: Map<string, CohortBookRow>;
  /** Member addresses, and book addresses, in the tables' (address) order: the full load's. */
  memberOrder: string[];
  bookOrder: string[];
  /** Every address's WalletVenue except the excluded ones (internalWallets.ts). */
  wv: Map<string, WalletVenue>;
  /** tailOf over the members, kept per change; and the rate it gave. */
  tail: { members: number; read: number };
  rate: number;
  /** symbol -> the addresses whose WalletVenue holds it: a mark that moves re-nets them. */
  holders: Map<string, Set<string>>;
  /** The per-venue map layOut made last, and the orders it was made from (null: lay it out in full). */
  laid: Laid | null;
}

/** One venue's part of a load as layOut made it. */
interface Laid {
  memberOrder: string[];
  bookOrder: string[];
  map: Map<string, WalletVenue>;
  covered: number;
  /** Newest book write among the covered wallets. */
  booksAt: number;
  /** The excluded addresses (no WalletVenue), in the order they were met. */
  out: string[];
}

/** A set of venues netted, as of load `gen` (CohortState.nets). */
interface Nets {
  gen: number;
  /** The netted wallets with the excluded taken out, in scopeWalletSteps' order; and each one's index in it. */
  list: NettedWallet[];
  at: Map<string, number>;
  /** The addresses this set leaves out (outOfCohorts): asked once each. */
  out: Set<string>;
}

/** What the load keeps between loads (null: the next one is full). */
interface CohortState {
  epoch: string;
  /** The write sequence's number the rows are current to. */
  rev: number;
  /** The load these rows built, and the one before (whose netted sets this one starts from). */
  gen: number;
  prevGen: number;
  venues: Map<Venue, VenueRows>;
  marks: Map<string, number>;
  /** What this load changed: the addresses whose WalletVenue was rebuilt per venue, and the marks (`venue|symbol`) that moved. */
  changed: Map<Venue, Set<string>>;
  moved: Set<string>;
  /** The addresses per venue that gained or lost a member or a book row: the only ones whose place in a list can move. */
  reshaped: Map<Venue, Set<string>>;
  /** Netted wallets per set of venues. */
  nets: Map<string, Nets>;
}

let cohortState: CohortState | null = null;
/** Bumped by a reset: a load under way from before it keeps its rows to itself. */
let stateToken = 0;
let loadGen = 0;
/** Counters for tests and diagnostics: loads read in full, and from what changed. */
const loadKind = { full: 0, incremental: 0 };
/** Per venue laid out: the last map kept, patched in place, or laid out in full (layOut). */
const layKind = { kept: 0, patched: 0, full: 0 };
/** Per set netted: the last list copied and patched, with addresses moved, in full, or in full as the last list was out of step (renet). */
const netKind = { copied: 0, moved: 0, full: 0, outOfStep: 0 };

/** The order loadSteps builds venues in: Hyperliquid and trade.xyz wait for each other (model.ts perpEquity). */
const BUILD_ORDER: readonly Venue[] = (() => {
  const out: Venue[] = [];
  const seen = new Set<Venue>();
  for (const v of VENUES) {
    seen.add(v);
    const sib = MARGIN_SIBLING[v];
    if (sib && !seen.has(sib)) continue;
    out.push(v);
    if (sib) out.push(sib);
  }
  return out;
})();

const byAddress = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** tailOf's share of one address: [member in the tail, and read]. */
function tailPart(r: VenueRows, address: string): [number, number] {
  const m = r.members.get(address);
  if (!m || (m.equity ?? 0) >= TAIL_EQUITY) return [0, 0];
  return [1, r.books.has(address) ? 1 : 0];
}

/** An address's WalletVenue on a venue as the full load builds it; undefined when it has no row there or is excluded. */
function walletVenue(venue: Venue, r: VenueRows, sib: VenueRows | undefined, address: string): WalletVenue | undefined {
  if (isExcluded(venue, address)) return undefined;
  const mem = r.members.get(address);
  const b = r.books.get(address);
  if (!mem && !b) return undefined;
  return sampledVenue(r.rate, address, mem && {
    pnl: mem.pnl, equity: mem.equity, label: mem.label,
    pnlRange: { '1d': mem.pnl1d ?? null, '7d': mem.pnl7d ?? null, '30d': mem.pnl30d ?? null },
  }, b, perpEquity(venue, b, sib?.books.get(address)));
}

/** Put an address's new WalletVenue (or none) in place, keeping the holders index. */
function setWallet(r: VenueRows, address: string, w: WalletVenue | undefined): void {
  const old = r.wv.get(address);
  for (const p of old?.positions ?? []) r.holders.get(p.symbol)?.delete(address);
  if (!w) { r.wv.delete(address); return; }
  r.wv.set(address, w);
  for (const p of w.positions ?? []) {
    let set = r.holders.get(p.symbol);
    if (!set) { set = new Set(); r.holders.set(p.symbol, set); }
    set.add(address);
  }
}

/** A venue's rows, a page at a time, yielding between pages (the full read). */
function* paged<V>(read: (after: string, limit: number) => Array<[string, V]>, into: Map<string, V>): Generator<void, void> {
  for (let after = ''; ;) {
    const page = read(after, LOAD_PAGE);
    for (const [address, row] of page) into.set(address, row);
    yield;
    if (page.length < LOAD_PAGE) return;
    after = page[page.length - 1]![0];
  }
}

/** Every venue's rows read in full, and every WalletVenue built from them. */
function* readAll(s: IndexStore): Generator<void, Map<Venue, VenueRows>> {
  const venues = new Map<Venue, VenueRows>();
  for (const venue of VENUES) {
    const members = new Map<string, CohortMemberRow>();
    yield* paged((after, limit) => s.cohortMembersPage(venue, after, limit).map((r): [string, CohortMemberRow] => [r.address, r]), members);
    const books = new Map<string, CohortBookRow>();
    yield* paged((after, limit) => s.cohortBooksPage(venue, after, limit), books);
    // A tail still being read in full counts as its old sample until (nearly) all of it is (cohortTracker tailCountRate).
    const tail = tailOf(members, (a) => books.has(a));
    venues.set(venue, {
      members, books, memberOrder: [...members.keys()], bookOrder: [...books.keys()],
      wv: new Map(), tail, rate: tailCountRate(venue, tail), holders: new Map(), laid: null,
    });
  }
  for (const venue of BUILD_ORDER) {
    const r = venues.get(venue)!;
    const sib = MARGIN_SIBLING[venue] ? venues.get(MARGIN_SIBLING[venue]!) : undefined;
    let n = 0;
    for (const address of r.memberOrder) {
      setWallet(r, address, walletVenue(venue, r, sib, address));
      if (++n % 2_000 === 0) yield;
    }
    for (const address of r.bookOrder) {
      if (r.members.has(address)) continue;
      setWallet(r, address, walletVenue(venue, r, sib, address));
      if (++n % 2_000 === 0) yield;
    }
  }
  return venues;
}

/**
 * What changed since `st.rev` (up to `upTo`, which the writer had committed before any of this was
 * read), applied to `st` in place. Rows and tombstones of a venue are applied in write order: a
 * member removed and back, or back and removed, ends as the last write left it. A row rewritten
 * after `upTo` is skipped here and read by the next load with its new number. Returns, per venue,
 * the addresses whose WalletVenue was rebuilt, and those that gained or lost a row.
 */
function* readChanges(
  s: IndexStore, st: CohortState, upTo: number,
): Generator<void, { changed: Map<Venue, Set<string>>; reshaped: Map<Venue, Set<string>> }> {
  const reshaped = new Map<Venue, Set<string>>();
  const touchedBooks = new Map<Venue, Set<string>>();
  const touched = new Map<Venue, Set<string>>();
  for (const venue of VENUES) {
    const r = st.venues.get(venue)!;
    type Ev = { rev: number; address: string; member?: CohortMemberRow; book?: CohortBookRow; tomb?: 'm' | 'b' };
    const evs: Ev[] = [];
    for (let after = st.rev; ;) {
      const page = s.cohortMembersSince(venue, after, upTo, LOAD_PAGE);
      for (const x of page) evs.push({ rev: x.rev, address: x.row.address, member: x.row });
      yield;
      if (page.length < LOAD_PAGE) break;
      after = page[page.length - 1]!.rev;
    }
    for (let after = st.rev; ;) {
      const page = s.cohortBooksSince(venue, after, upTo, LOAD_PAGE);
      for (const x of page) evs.push({ rev: x.rev, address: x.address, book: x.row });
      yield;
      if (page.length < LOAD_PAGE) break;
      after = page[page.length - 1]!.rev;
    }
    for (const t of s.cohortTombsSince(venue, st.rev, upTo)) evs.push({ rev: t.rev, address: t.address, tomb: t.kind });
    if (!evs.length) continue;
    evs.sort((a, b) => a.rev - b.rev);
    // Each address as it was before (its presence and its share of the tail), then the writes.
    const was = new Map<string, { member: boolean; book: boolean }>();
    const books = new Set<string>();
    for (const e of evs) {
      if (!was.has(e.address)) {
        was.set(e.address, { member: r.members.has(e.address), book: r.books.has(e.address) });
        const [n, read] = tailPart(r, e.address);
        r.tail.members -= n;
        r.tail.read -= read;
      }
      if (e.member) r.members.set(e.address, e.member);
      else if (e.book) { r.books.set(e.address, e.book); books.add(e.address); }
      else if (e.tomb === 'm') r.members.delete(e.address);
      else if (e.tomb === 'b') { r.books.delete(e.address); books.add(e.address); }
    }
    const addM: string[] = [];
    const addB: string[] = [];
    const dropM = new Set<string>();
    const dropB = new Set<string>();
    for (const [address, w] of was) {
      const [n, read] = tailPart(r, address);
      r.tail.members += n;
      r.tail.read += read;
      const m = r.members.has(address);
      const b = r.books.has(address);
      if (m && !w.member) addM.push(address);
      if (!m && w.member) dropM.add(address);
      if (b && !w.book) addB.push(address);
      if (!b && w.book) dropB.add(address);
    }
    r.memberOrder = reorder(r.memberOrder, addM, dropM);
    r.bookOrder = reorder(r.bookOrder, addB, dropB);
    if (addM.length || addB.length || dropM.size || dropB.size) reshaped.set(venue, new Set([...addM, ...addB, ...dropM, ...dropB]));
    touched.set(venue, new Set(was.keys()));
    touchedBooks.set(venue, books);
    yield;
  }
  // The WalletVenues to build again: every address written on the venue, and every one whose
  // sibling book was (its perp equity reads both); all of a venue's when its tail's rate flipped.
  const changed = new Map<Venue, Set<string>>();
  for (const venue of BUILD_ORDER) {
    const r = st.venues.get(venue)!;
    const sibV = MARGIN_SIBLING[venue];
    const sib = sibV ? st.venues.get(sibV) : undefined;
    const rate = tailCountRate(venue, r.tail);
    let dirty: Set<string>;
    if (rate !== r.rate) {
      r.rate = rate;
      dirty = new Set([...r.wv.keys(), ...(touched.get(venue) ?? [])]);
    } else {
      dirty = new Set(touched.get(venue) ?? []);
      for (const a of (sibV && touchedBooks.get(sibV)) || []) dirty.add(a);
    }
    let n = 0;
    for (const address of dirty) {
      setWallet(r, address, walletVenue(venue, r, sib, address));
      if (++n % 2_000 === 0) yield;
    }
    changed.set(venue, dirty);
  }
  return { changed, reshaped };
}

/** A sorted address list without `drop`, with `add` merged in (one pass; `add` is a few thousand at most). */
function reorder(order: string[], add: string[], drop: ReadonlySet<string>): string[] {
  if (!add.length && !drop.size) return order;
  const kept = drop.size ? order.filter((a) => !drop.has(a)) : order;
  if (!add.length) return kept;
  add.sort(byAddress);
  const out: string[] = new Array(kept.length + add.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < kept.length && j < add.length) out[k++] = byAddress(kept[i]!, add[j]!) <= 0 ? kept[i++]! : add[j++]!;
  while (i < kept.length) out[k++] = kept[i++]!;
  while (j < add.length) out[k++] = add[j++]!;
  return out;
}

/**
 * The load's per-venue maps, coverage, newest book and excluded wallets from the rows, in the
 * full load's order: venues as BUILD_ORDER, each venue's members by address, then its books with
 * no member (a Set of members' keys then books' keys, as the full load iterated them).
 *
 * A venue none of whose addresses gained or lost a row since the last load (its orders are the
 * very arrays laid out last time) keeps its map's order: the map is the last one as it was, or a
 * copy of it with the rebuilt WalletVenues (`changed`) set in their places. Re-laying ~500k
 * members and books every load was 4% of the API's thread (profiled 2026-11-01 23:56).
 */
function* layOut(
  venues: ReadonlyMap<Venue, VenueRows>, changed?: ReadonlyMap<Venue, ReadonlySet<string>>,
): Generator<void, Pick<CohortLoad, 'per' | 'coverage' | 'booksAt' | 'internal' | 'excluded'>> {
  const per = new Map<Venue, Map<string, WalletVenue>>();
  const coverage: Partial<Record<Venue, VenueCoverage>> = {};
  let booksAt = 0;
  const internal = new Map<string, number>();
  const excluded = new Map<string, ExcludedBook>();
  for (const venue of BUILD_ORDER) {
    const r = venues.get(venue)!;
    const kept = changed && relaid(r, changed.get(venue));
    const laid = kept || (yield* layVenue(r));
    layKind[!kept ? 'full' : kept === r.laid ? 'kept' : 'patched']++;
    r.laid = laid;
    per.set(venue, laid.map);
    coverage[venue] = { members: laid.map.size, covered: laid.covered };
    booksAt = Math.max(booksAt, laid.booksAt);
    // An excluded wallet (internalWallets.ts: a venue's own account, a hedged desk) is neither in a cohort
    // nor on the map; what it holds is taken off the venue's open interest the map's coverage is measured
    // against (internalOiNow), and its book is kept for the page that lists it (excludedNow).
    for (const address of laid.out) {
      const b = r.books.get(address);
      if (b) excluded.set(`${venue}|${address}`, { equity: b.equity, positions: b.positions, at: b.at });
      for (const p of b?.positions ?? []) {
        const k = `${venue}|${liqCoin(p.symbol)}`;
        internal.set(k, (internal.get(k) ?? 0) + Math.abs(p.szi) / 2);
      }
    }
    yield;
  }
  return { per, coverage, booksAt, internal, excluded };
}

/** One venue's map laid out from its orders. */
function* layVenue(r: VenueRows): Generator<void, Laid> {
  const map = new Map<string, WalletVenue>();
  const out: string[] = [];
  let covered = 0;
  let booksAt = 0;
  let n = 0;
  const visit = (address: string): void => {
    const w = r.wv.get(address);
    if (!w) { out.push(address); return; }
    // Covered = wallets whose positions count (a read tail wallet outside the sample does not).
    if (w.positions) { covered++; booksAt = Math.max(booksAt, w.at); }
    map.set(address, w);
  };
  for (const address of r.memberOrder) {
    visit(address);
    if (++n % 5_000 === 0) yield;
  }
  for (const address of r.bookOrder) {
    if (r.members.has(address)) continue;
    visit(address);
    if (++n % 5_000 === 0) yield;
  }
  return { memberOrder: r.memberOrder, bookOrder: r.bookOrder, map, covered, booksAt, out };
}

/** The last map with `changed` set in place, while no address came or went (else null: lay it out again). */
function relaid(r: VenueRows, changed: ReadonlySet<string> | undefined): Laid | null {
  const was = r.laid;
  if (!was || was.memberOrder !== r.memberOrder || was.bookOrder !== r.bookOrder) return null;
  if (!changed?.size) return was;
  const map = new Map(was.map);
  let covered = was.covered;
  let booksAt = was.booksAt;
  let lower = false;
  for (const address of changed) {
    const w = r.wv.get(address);
    const old = map.get(address);
    if (!w !== !old) return null; // a WalletVenue where the map has none, or none where it has one: lay it out again
    if (!w || !old) continue;
    map.set(address, w);
    if (old.positions) {
      covered--;
      if (old.at >= booksAt && !(w.positions && w.at >= old.at)) lower = true;
    }
    if (w.positions) { covered++; booksAt = Math.max(booksAt, w.at); }
  }
  if (lower) {
    // The newest book went back or out of the count: the newest of the rest.
    booksAt = 0;
    for (const w of map.values()) if (w.positions) booksAt = Math.max(booksAt, w.at);
  }
  return { ...was, map, covered, booksAt };
}

/** The `venue|symbol` marks that differ between two reads. */
function movedMarks(was: ReadonlyMap<string, number>, now: ReadonlyMap<string, number>): Set<string> {
  const out = new Set<string>();
  for (const [k, px] of now) if (was.get(k) !== px) out.add(k);
  for (const k of was.keys()) if (!now.has(k)) out.add(k);
  return out;
}

/** The wallets of a set of venues, netted (kept on the load). */
function* netSteps(load: CohortLoad, venues: readonly Venue[]): Generator<void, NettedWallet[]> {
  const key = scopeKey(venues);
  const hit = load.scopes.get(key);
  if (hit) return hit;
  const mark = (v: Venue, sym: string) => load.marks.get(`${v}|${sym}`) ?? null;
  const st = load.state;
  const prev = st?.nets.get(key);
  let wallets: NettedWallet[] | null = null;
  if (st && prev && prev.gen === st.prevGen && st.gen === load.gen) {
    wallets = yield* renet(load, st, venues, prev, mark);
    if (wallets) prev.gen = load.gen;
    else netKind.outOfStep++;
  }
  if (!wallets) {
    netKind.full++;
    const all = yield* scopeWalletSteps(venues, load.per, mark);
    // Hedged desks hold books (the heatmap prices them) but no cohort counts them (internalWallets.ts).
    const out = new Set<string>();
    wallets = all.filter((w) => !(outOfCohorts(venues, w.address) && out.add(w.address)));
    // Kept for the next load to start from: only while these rows are the newest (a request on the
    // load in use while the next one is read nets from it in full, and keeps nothing).
    if (st && st.gen === load.gen && cohortState === st) {
      const at = new Map<string, number>();
      for (let i = 0; i < wallets.length; i++) at.set(wallets[i]!.address, i);
      st.nets.set(key, { gen: load.gen, list: wallets, at, out });
    }
  }
  load.scopes.set(key, wallets);
  return wallets;
}

/**
 * A set of venues netted again from the last load's list (null when that list turns out not to
 * match the maps: netSteps nets in full). The addresses whose WalletVenue was rebuilt on one of
 * its venues, and the holders of a coin whose mark moved, are netted anew; every other wallet is
 * the very object netted last time.
 *
 * A wallet's place in the list (scopeWalletSteps' order: the first of the set's venues whose map
 * holds it, a member there before a book with no member, then the address - layOut's order) moves
 * only when the address gained or lost a row on one of the set's venues (`reshaped`, a few per
 * load). So the new list is the last one copied and patched at the netted-anew wallets' indexes
 * (`at`); an address that came or went is taken out where it was and put in where it now belongs,
 * and the indexes after the first such place are renumbered. Walking every address of every venue
 * of every set instead, asking each earlier venue's map for it, was 15% of the API's thread
 * (profiled 2026-11-01 23:56). The excluded are left out as netSteps does (whether an address is
 * out never changes: asked once, when it is first netted).
 */
function* renet(
  load: CohortLoad, st: CohortState, venues: readonly Venue[], net: Nets, mark: MarkOf,
): Generator<void, NettedWallet[] | null> {
  const { at, out } = net;
  const maps = venues.map((v) => load.per.get(v));
  /** The address over the set's venues; null when it is on none of them, or left out. */
  const netted = (address: string): NettedWallet | null => {
    const mine = new Map<Venue, WalletVenue>();
    for (let j = 0; j < venues.length; j++) {
      const x = maps[j]?.get(address);
      if (x) mine.set(venues[j]!, x);
    }
    if (!mine.size || out.has(address)) return null;
    if (outOfCohorts(venues, address)) { out.add(address); return null; }
    return netWallet(address, mine, mark);
  };
  const reshaped = new Set<string>();
  for (const v of venues) for (const a of st.reshaped.get(v) ?? []) reshaped.add(a);
  const stale = new Set<string>();
  for (const v of venues) for (const a of st.changed.get(v) ?? []) if (!reshaped.size || !reshaped.has(a)) stale.add(a);
  const inScope = new Set<Venue>(venues);
  for (const k of st.moved) {
    const i = k.indexOf('|');
    const v = k.slice(0, i) as Venue;
    if (!inScope.has(v)) continue;
    for (const a of st.venues.get(v)?.holders.get(k.slice(i + 1)) ?? []) if (!reshaped.size || !reshaped.has(a)) stale.add(a);
  }
  yield;
  const list = reshaped.size ? yield* replace(net, reshaped, st, venues, maps, netted) : net.list.slice();
  if (!list) return null;
  netKind[reshaped.size ? 'moved' : 'copied']++;
  let n = 0;
  for (const address of stale) {
    const i = at.get(address);
    const w = netted(address);
    if (i === undefined) {
      // Not listed: left out, or on none of the venues. Anything else is a list out of step with the maps.
      if (w) return null;
      continue;
    }
    if (!w) return null;
    list[i] = w;
    if (++n % 5_000 === 0) yield;
  }
  net.list = list;
  return list;
}

/**
 * The last list with each `reshaped` address taken out where it was and, netted anew, put in where
 * it now belongs; `net.at` renumbered to match. Null when the list is out of step with the maps.
 */
function* replace(
  net: Nets, reshaped: ReadonlySet<string>, st: CohortState, venues: readonly Venue[],
  maps: ReadonlyArray<ReadonlyMap<string, WalletVenue> | undefined>, netted: (address: string) => NettedWallet | null,
): Generator<void, NettedWallet[] | null> {
  const { list, at } = net;
  const rows = venues.map((v) => st.venues.get(v));
  /** Where an address goes: its first venue in the set, then 0 for a member there (1 for a book with no member). */
  const placeOf = (address: string): [number, number] | null => {
    for (let i = 0; i < maps.length; i++) if (maps[i]?.has(address)) return [i, rows[i]?.members.has(address) ? 0 : 1];
    return null;
  };
  const before = (p: [number, number], a: string, q: [number, number], b: string): boolean =>
    p[0] !== q[0] ? p[0] < q[0] : p[1] !== q[1] ? p[1] < q[1] : a < b;
  const gone: number[] = [];
  const put: Array<{ address: string; place: [number, number]; w: NettedWallet; i: number }> = [];
  for (const address of reshaped) {
    const i = at.get(address);
    if (i !== undefined) gone.push(i);
    const place = placeOf(address);
    const w = place && netted(address);
    if (place && w) put.push({ address, place, w, i: 0 });
  }
  gone.sort((x, y) => x - y);
  put.sort((x, y) => (before(x.place, x.address, y.place, y.address) ? -1 : 1));
  yield;
  // Each one's index in the last list: before the first wallet staying in it that comes after it
  // (the list is in that order, and every wallet staying keeps its place).
  let bad = false;
  const indexOf = (place: [number, number], address: string): number => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      let q = mid;
      while (q < hi && reshaped.has(list[q]!.address)) q++;
      if (q === hi) { hi = mid; continue; }
      const b = list[q]!.address;
      const pb = placeOf(b);
      if (!pb) { bad = true; return 0; }
      if (before(pb, b, place, address)) lo = q + 1;
      else hi = q;
    }
    return lo;
  };
  for (const x of put) x.i = indexOf(x.place, x.address);
  if (bad) return null;
  yield;
  // Pushed, not written into a preallocated array: that one stays holey, and the sums iterate it slower.
  const next: NettedWallet[] = [];
  let g = 0;
  let k = 0;
  for (let i = 0; i <= list.length; i++) {
    while (k < put.length && put[k]!.i === i) next.push(put[k++]!.w);
    if (i === list.length) break;
    if (g < gone.length && gone[g] === i) { g++; continue; }
    next.push(list[i]!);
    if (i % 20_000 === 0) yield;
  }
  if (next.length !== list.length - gone.length + put.length) return null;
  const first = Math.min(gone[0] ?? Infinity, put[0]?.i ?? Infinity);
  for (const address of reshaped) at.delete(address);
  for (let i = first; i < next.length; i++) {
    at.set(next[i]!.address, i);
    if (i % 20_000 === 0) yield;
  }
  return next;
}

/** Every cohort's figures for a set of venues under a filter (kept on the load). */
function* sumSteps(load: CohortLoad, venues: readonly Venue[], f: CohortFilter): Generator<void, CohortSums> {
  const k = `${scopeKey(venues)}|${filterKey(f)}`;
  const hit = load.stats.get(k);
  if (hit) return hit;
  const wallets = yield* netSteps(load, venues);
  const sum = new Aggregator(f);
  let n = 0;
  for (const w of wallets) {
    sum.add(w);
    if (++n % 5_000 === 0) yield;
  }
  const stats: CohortSums = { cohorts: sum.result(), all: sum.total() };
  if (load.stats.size > 200) load.stats.clear();
  load.stats.set(k, stats);
  return stats;
}

/**
 * One load, read and (for `ahead`) netted and summed, in steps. From what changed since the last
 * one when that is known (see INCREMENTAL above); `keep` false reads in full and leaves the rows
 * kept between loads alone (a build in place while one from behind is under way).
 */
function* loadSteps(
  s: IndexStore, now: number, ahead: ReadonlyArray<{ venues: readonly Venue[]; filters: readonly CohortFilter[] }>, keep = true,
): Generator<void, CohortLoad> {
  const token = stateToken;
  const seq = keep ? s.cohortRevState() : null;
  const was = keep ? cohortState : null;
  const gen = ++loadGen;
  let venues: Map<Venue, VenueRows>;
  let marks: Map<string, number>;
  let st: CohortState | null = null;
  if (seq && was && was.epoch === seq.epoch && seq.rev >= was.rev && was.rev >= seq.floor) {
    try {
      // Numbered first: the load in use nets nothing more from these rows while they change under it.
      was.prevGen = was.gen;
      was.gen = gen;
      const { changed, reshaped } = yield* readChanges(s, was, seq.rev);
      marks = s.cohortMarks();
      was.moved = movedMarks(was.marks, marks);
      was.marks = marks;
      was.changed = changed;
      was.reshaped = reshaped;
      was.rev = seq.rev;
      // Netted sets the last load did not keep are of no use any more.
      for (const [k, n] of was.nets) if (n.gen !== was.prevGen) was.nets.delete(k);
    } catch (e) {
      // Half applied: the next load reads everything.
      if (token === stateToken) cohortState = null;
      throw e;
    }
    st = was;
    venues = was.venues;
    loadKind.incremental++;
  } else {
    // In full. The sequence's number was read first: a row written while the pages are read is
    // read again by the next load, which is harmless; one missed is not possible. A file with no
    // sequence yet (an indexer from before it) keeps nothing: every load is full.
    venues = yield* readAll(s);
    marks = s.cohortMarks();
    if (seq) st = { epoch: seq.epoch, rev: seq.rev, gen, prevGen: -1, venues, marks, changed: new Map(), moved: new Set(), reshaped: new Map(), nets: new Map() };
    loadKind.full++;
  }
  const laid = yield* layOut(venues, st?.changed);
  if (keep && token === stateToken) cohortState = st;
  else st = null;
  const load: CohortLoad = { at: now, gen, ...laid, marks, scopes: new Map(), stats: new Map(), state: st };
  for (const a of ahead) {
    yield* netSteps(load, a.venues);
    for (const f of a.filters) yield* sumSteps(load, a.venues, f);
  }
  return load;
}

/** Remember that a set of venues (and a filter) is being looked at. */
function note(venues: readonly Venue[], f?: CohortFilter): void {
  const now = Date.now();
  const key = scopeKey(venues);
  let w = wanted.get(key);
  if (!w) {
    if (wanted.size >= WANT_SCOPES) wanted.delete(oldest(new Map([...wanted].filter(([k]) => k !== warmKey))));
    w = { venues: [...venues], askedAt: now, filters: new Map() };
    wanted.set(key, w);
  }
  w.askedAt = now;
  if (!f) return;
  const fk = filterKey(f);
  const e = w.filters.get(fk);
  if (e) e.askedAt = now;
  else {
    if (w.filters.size >= WANT_FILTERS) w.filters.delete(oldest(w.filters));
    w.filters.set(fk, { f, askedAt: now });
  }
}

function oldest<T extends { askedAt: number }>(m: Map<string, T>): string {
  let key = '';
  let at = Infinity;
  for (const [k, v] of m) if (v.askedAt < at) { at = v.askedAt; key = k; }
  return key;
}

/** The sets and filters asked for within KEEP_WARM_MS (older ones are forgotten), and the default page always. */
function wantedNow(now: number): Array<{ venues: Venue[]; filters: CohortFilter[] }> {
  const out: Array<{ venues: Venue[]; filters: CohortFilter[] }> = [];
  for (const [key, w] of wanted) {
    const warm = key === warmKey;
    if (!warm && now - w.askedAt > KEEP_WARM_MS) { wanted.delete(key); continue; }
    const filters: CohortFilter[] = [];
    for (const [fk, e] of w.filters) {
      if (warm && fk === filterKey({})) filters.push(e.f);
      else if (now - e.askedAt > KEEP_WARM_MS) w.filters.delete(fk);
      else filters.push(e.f);
    }
    out.push({ venues: w.venues, filters });
  }
  return out;
}

/** Start the next rebuild from behind in time for it to be ready when the load in use expires. */
function armRebuild(s: IndexStore): void {
  if (rebuildTimer || rebuilding || !cohortLoad) return;
  const lead = Math.min(LOAD_TTL_MS / 2, Math.max(REBUILD_LEAD_MS, lastRebuildMs * 1.5 + 2_000));
  const due = Math.max(cohortLoad.at + LOAD_TTL_MS - lead, rebuildFailedAt + 10_000);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    void rebuildBehind(s);
  }, Math.max(0, due - Date.now()));
  rebuildTimer.unref?.();
}

async function rebuildBehind(s: IndexStore): Promise<void> {
  const started = Date.now();
  if (rebuilding) return;
  rebuilding = true;
  try {
    const p = runBehind(loadSteps(s, started, wantedNow(started)));
    inflight = p;
    cohortLoad = await p;
    built.behind++;
    lastRebuildMs = Date.now() - started;
  } catch {
    // The load in use stays; once it expires a read builds one in place. The rows kept between
    // loads may be half way through a change: the next load reads everything.
    cohortState = null;
    rebuildFailedAt = Date.now();
  } finally {
    rebuilding = false;
    inflight = null;
  }
  armRebuild(s);
}

function loadCohorts(s: IndexStore): CohortLoad {
  const now = Date.now();
  lastAsked = now;
  // Nothing to answer from yet (this process has not built one, and the warm-up
  // at start has not finished): build it here.
  if (!cohortLoad) {
    // While a rebuild from behind is half way through the rows kept between loads, this one reads
    // its own (in full) and leaves them to it.
    cohortLoad = runNow(loadSteps(s, now, [], !rebuilding));
    built.inPlace++;
  } else if (now - cohortLoad.at >= LOAD_TTL_MS && !rebuilding) {
    // It expired while nobody was asking (the rebuilds stop then). Building it
    // here held this request - and, being synchronous, EVERY request on the API -
    // for the whole build: 9 s on the production index (2026-10-23). This one
    // read is answered from the load in use; a rebuild from behind starts now,
    // giving the thread back between slices, and the page's next poll has it.
    if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; }
    void rebuildBehind(s);
  }
  armRebuild(s);
  return cohortLoad;
}

/**
 * At the API's start: build the load from behind for the page as it first
 * opens (every venue, no filter), so the first visitor after a restart is not
 * the one who waits for it. A read that arrives before it is done builds its own.
 */
export async function warmCohorts(venues: readonly Venue[]): Promise<void> {
  const s = reader();
  if (!s || cohortLoad || rebuilding) return;
  warmKey = scopeKey(venues);
  note(venues, {});
  lastAsked = Date.now();
  await rebuildBehind(s);
}

function walletsOf(load: CohortLoad, venues: readonly Venue[]): NettedWallet[] {
  note(venues);
  return runNow(netSteps(load, venues));
}

/**
 * Every cohort's figures for a set of venues under a filter - one aggregation
 * per load, shared by every request (and done ahead by the rebuild for what was
 * asked lately; a set or filter asked for the first time is summed here).
 */
function statsOf(load: CohortLoad, venues: readonly Venue[], f: CohortFilter): CohortSums {
  note(venues, f);
  return runNow(sumSteps(load, venues, f));
}

/** Tests: the cohort load's state, a rebuild from behind on demand, and a clean slate. */
export const _cohortLoad = {
  built,
  /** Loads read in full and from what changed (cohortsIncremental.test.ts). */
  kind: loadKind,
  /** How each venue was laid out and each set netted (cohortsIncremental.test.ts). */
  lay: layKind,
  net: netKind,
  /**
   * Run `fn` with a load read in full from the file in place of the load in use (the rows kept
   * between loads untouched), then put the load in use back: every answer `fn` reads is a full load's.
   */
  withFull: <T>(fn: () => T): T => {
    const s = reader();
    if (!s) throw new Error('no index');
    const was = cohortLoad;
    cohortLoad = runNow(loadSteps(s, Date.now(), [], false));
    try {
      return fn();
    } finally {
      cohortLoad = was;
    }
  },
  /** Drop the rows kept between loads: the next load reads everything (as after a gap). */
  forget: (): void => { cohortState = null; stateToken++; },
  /** The load in use as plain data (per venue maps with their order, and the netted wallets of `scopes`). */
  dump: (scopes: ReadonlyArray<readonly Venue[]> = []) => {
    const load = cohortLoad;
    if (!load) return null;
    return {
      per: [...load.per].map(([v, m]) => [v, [...m]]),
      coverage: load.coverage, booksAt: load.booksAt, marks: [...load.marks],
      internal: [...load.internal], excluded: [...load.excluded],
      scopes: scopes.map((v) => runNow(netSteps(load, v))),
    };
  },
  state: () => ({ at: cohortLoad?.at ?? 0, rebuilding, armed: rebuildTimer !== null, scopes: [...(cohortLoad?.scopes.keys() ?? [])], stats: [...(cohortLoad?.stats.keys() ?? [])] }),
  /** Run the rebuild the timer would start, now; resolves when it has been swapped in. */
  rebuild: async (): Promise<void> => {
    const s = reader();
    if (!s) return;
    if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; }
    await rebuildBehind(s);
  },
  /** Make the load in use look `ms` older (and the last read likewise), to reach expiry without waiting. */
  age: (ms: number): void => {
    if (cohortLoad) cohortLoad.at -= ms;
    lastAsked -= ms;
    for (const w of wanted.values()) { w.askedAt -= ms; for (const e of w.filters.values()) e.askedAt -= ms; }
  },
  reset: (): void => {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = null;
    cohortLoad = null;
    cohortState = null;
    stateToken++;
    loadKind.full = 0;
    loadKind.incremental = 0;
    layKind.kept = layKind.patched = layKind.full = 0;
    netKind.copied = netKind.moved = netKind.full = netKind.outOfStep = 0;
    wanted.clear();
    warmKey = null;
    lastAsked = 0;
    lastRebuildMs = 0;
    rebuildFailedAt = 0;
    built.inPlace = 0;
    built.behind = 0;
    closeReader();
  },
};

function thin<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const out: T[] = [];
  const step = (rows.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(rows[Math.round(i * step)]!);
  return out;
}

/** [t, long, short] over time: the 15-minute series unfiltered, the hourly mix under a filter. */
function history(s: IndexStore, scope: string, fromT: number, f: CohortFilter, cohort?: CohortId): Map<string, CohortPoint[]> {
  const out = new Map<string, CohortPoint[]>();
  const push = (c: string, p: CohortPoint) => {
    const l = out.get(c) ?? [];
    l.push(p);
    out.set(c, l);
  };
  try {
    if (!f.coin && !f.sector) {
      for (const p of s.cohortSeries(scope, fromT, cohort)) push(p.cohort, { t: p.t, long: p.long, short: p.short, ...(p.rebuilt ? { rebuilt: true } : {}) });
    } else {
      for (const r of s.cohortMix(scope, fromT, cohort)) {
        const x = f.coin ? r.c[f.coin] : r.s[f.sector!];
        if (x) push(r.cohort, { t: r.t, long: x[0], short: x[1], ...(r.rebuilt ? { rebuilt: true } : {}) });
      }
    }
  } catch { /* the tables arrive with the worker's first start */ }
  return out;
}

/**
 * The books as the cohort load holds them (per venue, every wallet), with the
 * last prices: for the liquidation heatmap (liqRead.ts). Keeps the load warm
 * like a cohort read, without netting anything.
 */
/**
 * The open interest a venue's own accounts hold in a coin (coins, one side: their longs and shorts
 * halved - SoDEX's BTC pair is 908.65525 each way, 908.65525 of the venue's OI), from the load in use;
 * 0 before there is one (never builds one: the heatmap's request path calls it).
 */
export function internalOiNow(venue: Venue, coin: string): number {
  return cohortLoad?.internal.get(`${venue}|${coin}`) ?? 0;
}

/**
 * Every excluded wallet (internalWallets.ts) with what it holds now, for the page that lists them:
 * equity, long and short USD at the marks, its coins largest first. From the load in use; an empty
 * list before there is one (never builds one).
 */
export function excludedNow(): Array<ExcludedWallet & { from: readonly ExcludedFrom[]; equity: number | null; long: number; short: number; coins: Array<{ coin: string; usd: number }>; at: number | null }> {
  const load = cohortLoad;
  return EXCLUDED_WALLETS.map((w) => {
    const b = load?.excluded.get(`${w.venue}|${w.address}`);
    let long = 0;
    let short = 0;
    const coins = new Map<string, number>();
    for (const p of b?.positions ?? []) {
      const px = load?.marks.get(`${w.venue}|${p.symbol}`) ?? p.entry ?? 0;
      const usd = p.szi * px;
      if (usd > 0) long += usd;
      else short -= usd;
      const c = liqCoin(p.symbol);
      coins.set(c, (coins.get(c) ?? 0) + usd);
    }
    return {
      ...w, from: EXCLUDED_FROM[w.kind], equity: b?.equity ?? null, long, short, at: b?.at ?? null,
      coins: [...coins].map(([coin, usd]) => ({ coin, usd })).sort((x, y) => Math.abs(y.usd) - Math.abs(x.usd)),
    };
  });
}

export function cohortBooksNow(): { at: number; booksAt: number; per: ReadonlyMap<Venue, ReadonlyMap<string, WalletVenue>>; marks: ReadonlyMap<string, number> } | null {
  const s = reader();
  if (!s) return null;
  const load = loadCohorts(s);
  return { at: load.at, booksAt: load.booksAt, per: load.per, marks: load.marks };
}

/** Every cohort for a set of venues (netted when more than one), under a sector / coin filter. */
export function cohortsRead(venues: readonly Venue[], f: CohortFilter): CohortsResponse | null {
  const s = reader();
  if (!s) return null;
  const load = loadCohorts(s);
  const stats = statsOf(load, venues, f).cohorts;
  const series = history(s, scopeKey(venues), Date.now() - RANGE_MS['7d'], f);
  // The asset picker: every coin held in this scope, unfiltered.
  const coins = statsOf(load, venues, {}).all.markets
    .map((m) => ({ coin: m.coin, sector: m.sector, gross: m.long + m.short }))
    .sort((a, b) => b.gross - a.gross);
  return {
    venues: [...venues],
    filter: f,
    at: load.booksAt,
    asOf: load.at,
    coverage: Object.fromEntries(venues.map((v) => [v, load.coverage[v]])),
    coins,
    cohorts: stats.map(({ markets: _m, ...rest }) => ({
      ...rest,
      spark: thin((series.get(rest.id) ?? []).flatMap((p) => {
        const sh = longShare(p.long, p.short);
        return sh === null ? [] : [[p.t, sh] as [number, number]];
      }), SPARK_POINTS),
    })),
  };
}

export function cohortDetail(venues: readonly Venue[], cohort: CohortId, range: CohortRange, f: CohortFilter): CohortDetailResponse | null {
  const s = reader();
  if (!s) return null;
  const load = loadCohorts(s);
  const stat = statsOf(load, venues, f).cohorts.find((x) => x.id === cohort)!;
  const series = history(s, scopeKey(venues), Date.now() - RANGE_MS[range], f, cohort).get(cohort) ?? [];
  return {
    venues: [...venues], filter: f, at: load.booksAt, asOf: load.at, range, cohort: stat,
    series: thin(series, 500), coverage: Object.fromEntries(venues.map((v) => [v, load.coverage[v]])),
  };
}

const SORT_VALUE: Record<WalletSort, (r: CohortWalletRow) => number | null> = {
  equity: (r) => r.equity, value: (r) => r.value, leverage: (r) => r.leverage, upnl: (r) => r.upnl,
  pnl: (r) => r.pnlRange, pnlAll: (r) => r.pnl, winRate: (r) => r.winRate,
};

/**
 * Win rates for cohort wallet rows over a range, netted over each row's
 * venues: wins and closes summed; exact only when every venue's are.
 * Hyperliquid's fills already hold its xyz dex, so trade.xyz is not added again.
 */
function attachWinRates(s: IndexStore, rows: WalletRow[], range: CohortRange): void {
  const byVenue = new Map<Venue, string[]>();
  for (const r of rows) for (const v of r.venues) byVenue.set(v, [...(byVenue.get(v) ?? []), r.address]);
  const stats = new Map<Venue, ReturnType<IndexStore['traderStats']>>();
  for (const [v, list] of byVenue) stats.set(v, s.traderStats(v, range, list));
  for (const r of rows) {
    let wins = 0;
    let closes = 0;
    let exact = true;
    let any = false;
    for (const v of r.venues) {
      if (v === 'tradexyz' && r.venues.includes('hyperliquid')) continue;
      const st = stats.get(v)?.get(r.address);
      if (!st) { exact = false; continue; }
      any = true;
      wins += st.wins;
      closes += st.closes;
      exact = exact && st.winExact;
    }
    if (!any) continue;
    const wr = winRateOf(wins, closes, exact);
    r.winRate = wr.winRate;
    r.winRateExact = wr.winRateExact;
    r.winRateCloses = wr.winRateCloses;
  }
}

/** The market map: every asset held, grouped by sector, for every wallet or one cohort. */
export function cohortMap(venues: readonly Venue[], cohort: CohortId | null): CohortMapResponse | null {
  const s = reader();
  if (!s) return null;
  const load = loadCohorts(s);
  const sums = statsOf(load, venues, {});
  const markets = cohort ? sums.cohorts.find((x) => x.id === cohort)!.markets : sums.all.markets;
  const by = new Map<Sector, MapSector>();
  for (const m of markets) {
    if (!(m.long + m.short > 0)) continue;
    const cur = by.get(m.sector) ?? { sector: m.sector, long: 0, short: 0, upnl: 0, assets: [] };
    cur.long += m.long;
    cur.short += m.short;
    cur.upnl += m.upnl;
    cur.assets.push(m);
    by.set(m.sector, cur);
  }
  return {
    venues: [...venues],
    cohort,
    at: load.booksAt,
    sectors: [...by.values()].sort((a, b) => b.long + b.short - (a.long + a.short)),
    coverage: Object.fromEntries(venues.map((v) => [v, load.coverage[v]])),
  };
}

/** One asset or sector across every cohort: today's figures and each cohort's lean over time. */
export function cohortFocus(venues: readonly Venue[], f: CohortFilter, range: CohortRange): CohortFocusResponse | null {
  const s = reader();
  if (!s) return null;
  const load = loadCohorts(s);
  const { cohorts: stats, all } = statsOf(load, venues, f);
  const total = { long: all.long, short: all.short, upnl: all.upnl, wallets: all.wallets, inProfit: all.inProfit, inLoss: all.inLoss };
  const hist = history(s, scopeKey(venues), Date.now() - RANGE_MS[range], f);
  return {
    venues: [...venues],
    filter: f,
    at: load.booksAt,
    range,
    total,
    cohorts: stats.map((st) => ({
      id: st.id, wallets: st.wallets, long: st.long, short: st.short, upnl: st.upnl, inProfit: st.inProfit, inLoss: st.inLoss,
    })),
    series: Object.fromEntries([...hist].map(([c, pts]) => [c, thin(pts, 400)])),
    assets: f.sector && !f.coin ? all.markets : [],
    coverage: Object.fromEntries(venues.map((v) => [v, load.coverage[v]])),
  };
}

/** A cohort's wallets holding a position (under a filter, one it keeps), sorted and paged. */
export function cohortWallets(
  venues: readonly Venue[], cohort: CohortId, f: CohortFilter,
  o: { sort: WalletSort; dir: 'asc' | 'desc'; offset: number; limit: number; range?: CohortRange },
): CohortWalletsResponse | null {
  const s = reader();
  if (!s) return null;
  const load = loadCohorts(s);
  const range: CohortRange = o.range && COHORT_RANGES.includes(o.range) ? o.range : '30d';
  const rows: CohortWalletRow[] = [];
  for (const w of walletsOf(load, venues)) {
    if (!cohortsOf(w).includes(cohort) || !holdsPosition(w, f)) continue;
    const r = walletRow(w, f, range);
    r.label = shownLabel(r.address, r.label);
    rows.push(r);
  }
  // Sorting by win rate needs it for every row; otherwise only the page gets it.
  if (o.sort === 'winRate') {
    try { attachWinRates(s, rows, range); } catch { /* decoration */ }
  }
  const val = SORT_VALUE[o.sort];
  const sign = o.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x === null && y === null) return (b.equity ?? 0) - (a.equity ?? 0);
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * sign;
  });
  const page = rows.slice(o.offset, o.offset + o.limit);
  if (o.sort !== 'winRate') {
    try { attachWinRates(s, page, range); } catch { /* decoration */ }
  }
  return { total: rows.length, asOf: load.at, range, rows: page };
}

/**
 * That status and when the newest board was written. A process with no build of its own yet says nothing of how old
 * the boards are: 8.7 h of it on 2026-11-06 counted as up on the status page and passed the health check's indexer line.
 */
export function indexerStatusJudged(): unknown {
  const status = indexerStatus();
  if (!status || typeof status !== 'object') return status;
  return { ...(status as Record<string, unknown>), boardsAt: reader()?.newestBoardAt() ?? null };
}

/** The indexer's own status line (lanes, streams), for diagnostics. */
export function indexerStatus(): unknown {
  const s = reader();
  const raw = s?.getMeta('indexer_status');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Before a cohort read: with no load yet and the start's warm-up building one, wait for it -
 * asynchronously, so every other request goes on. Reading straight away built a second load in
 * place: synchronous, it held the whole API 15 s and more after a restart (2026-10-28), and a
 * page that asked then saw "Cohorts couldn't load" or waited half a minute.
 */
export async function cohortsReady(waitMs = READY_WAIT_MS): Promise<void> {
  if (!cohortLoad) {
    if (inflight) await inflight.catch(() => undefined);
    return;
  }
  // Older than STALE_MAX_MS (the rebuilds stopped while nobody asked, or failed): a rebuild now,
  // and the answer waits for it - up to `waitMs`, then the load in use answers, its asOf shown.
  if (Date.now() - cohortLoad.at <= STALE_MAX_MS) return;
  const s = reader();
  if (!s) return;
  lastAsked = Date.now();
  if (!rebuilding && Date.now() - rebuildFailedAt >= 10_000) {
    if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; }
    void rebuildBehind(s);
  }
  const p = inflight;
  if (!p) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    p.catch(() => undefined),
    new Promise<void>((r) => { timer = setTimeout(r, waitMs); timer.unref?.(); }),
  ]);
  if (timer) clearTimeout(timer);
}
