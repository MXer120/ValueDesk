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
 * other Hyperliquid holder's PnL is read from its portfolio (weight 20), $100K+
 * holders just behind new wallets' first reads and the tail after the position
 * reads, and read again daily ($1M+), every 3 days ($100K+) or weekly
 * (planPnl, cohort_pnl). Before this (2026-10-24) the PnL cohorts held some
 * 10k wallets against the size cohorts' 51k.
 *
 * MEMBERS. Every wallet the index can value: Hyperliquid's leaderboard file
 * (equity + all-time PnL), SoDEX's and Lighter's lists, Arcus portfolios,
 * trade.xyz traders the stream saw, and any wallet a read has valued.
 * Written to `cohort_member` for the API thread, which nets and filters on
 * request (indexer/read.ts); this worker only records the history:
 * `cohort_series` every 15 minutes, `cohort_mix` (per coin and sector) hourly.
 */
import { VENUES, type Venue } from '../valuescan/types.js';
import type { LbSnapshot } from '../valuescan/hyperliquid/leaderboard.js';
import type { Pacer } from '../valuescan/extra/http.js';
import {
  Aggregator, MARGIN_SIBLING, TAIL_EQUITY, netWallet, perpEquity, sampleRule, sampledVenue, scopeKey, sectorTotals,
  type CohortRange, type Position, type WalletVenue,
} from '../valuescan/cohorts/model.js';
import { Lane } from './lanes.js';
import { mark } from './busy.js';
import type { Print } from './streams.js';
import type { IndexStore } from './store.js';
import { DAY_MS, dayOf } from './windows.js';
import { PNL_READ_COST, READ_COST, arcusPositions, hlPortfolioPnl, hlPositions, lighterPositions, sodexPositions, type PositionRead } from './cohortSource.js';
import type { CohortPnlRow } from './store.js';

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

/** A streamed book: re-read to reconcile after this long. */
export function reconcileTtl(equity: number): number {
  if (equity >= 1_000_000) return 6 * 60 * 60_000;
  if (equity >= 100_000) return 24 * 60 * 60_000;
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

/** Every non-empty set of venues, as scopes. */
export function allScopes(venues: readonly Venue[] = VENUES): Venue[][] {
  const out: Venue[][] = [];
  for (let m = 1; m < 1 << venues.length; m++) out.push(venues.filter((_, i) => m & (1 << i)));
  return out;
}

export interface Book {
  /** The read's perps account value (that dex's own on Hyperliquid / trade.xyz). */
  equity: number | null;
  pos: Map<string, { szi: number; entry: number | null }>;
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
  book.pos.set(symbol, { szi: n, entry });
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
}

/** Portfolio reads queued at a time (the plan tops them up every minute). */
const PNL_QUEUE_CAP = 60;
/** A holder's portfolio PnL is read again after this long: often for the large, weekly for the rest. */
export function pnlTtl(equity: number): number {
  return equity >= 1_000_000 ? DAY_MS : equity >= 100_000 ? 3 * DAY_MS : 7 * DAY_MS;
}
/**
 * Where a portfolio read queues among the position reads (new 1,000+, re-reads
 * 400-1,300): a $100K+ holder's just under a new wallet's first read - it moves
 * the money in the PnL cohorts - and the rest of the tail after every position read.
 */
export function pnlPrio(equity: number): number {
  const size = Math.round(Math.log10(Math.max(1, equity)) * 10);
  return equity >= 100_000 ? 920 + size : 300 + size;
}

export class CohortTracker {
  /**
   * Hyperliquid + its xyz dex: clearinghouseState reads (2) and, for a holder the
   * leaderboard does not rank, portfolio reads (20), weight / minute. 400 by
   * default (raised from 200 on 2026-10-24 for the portfolio reads): with the
   * boards' 500 and the API's 200 that is 1,100 of HL's 1,200 per IP.
   */
  readonly hlc = new Lane({ name: 'hlc', perMin: envNum('VALUESCAN_INDEX_HL_COHORT', 400, 20, 800) });
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
  private timers: NodeJS.Timeout[] = [];
  private lastSeriesT = 0;
  private lastMixT = 0;
  private recording = false;
  private applied = 0;
  private planMs = 0;
  private recordMs = 0;
  lastError: string | null = null;

  constructor(private readonly d: CohortDeps) {
    this.scoh = new Lane({ name: 'scoh', perMin: envNum('VALUESCAN_INDEX_SODEX_COHORT', 20, 1, 60), gate: d.sodexGate, rateLimitPauseMs: 15 * 60_000 });
  }

  start(): void {
    const s = this.d.store;
    const now = this.d.now();
    for (const v of VENUES) {
      const m = new Map<string, Book>();
      for (const [a, b] of s.cohortBooks(v)) {
        m.set(a, {
          equity: b.equity, at: b.at, collateral: b.collateral, spotAt: b.spotAt,
          pos: new Map(b.positions.map((p) => [p.symbol, { szi: p.szi, entry: p.entry }])),
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
    for (const [k, px] of s.cohortMarks()) this.marks.set(k, px);
    this.lastSeriesT = s.cohortSeriesLastT();
    this.lastMixT = s.cohortMixLastT();
    this.hlc.start();
    this.scoh.start();
    const every = (ms: number, fn: () => Promise<void> | void, name: string) => {
      const t = setInterval(() => { mark(name); void Promise.resolve(fn()).catch((e) => (this.lastError = String(e))); }, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(PLAN_MS, () => this.plan(), 'coh:plan');
    every(FLUSH_MS, () => this.flush(), 'coh:flush');
    every(60_000, () => this.record(), 'coh:record');
    const first = setTimeout(() => void this.plan().catch((e) => (this.lastError = String(e))), 15_000);
    first.unref?.();
    this.timers.push(first);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.hlc.stop();
    this.scoh.stop();
    this.flush();
  }

  // --- the streams ----------------------------------------------------------------------

  /** Every print: a price, and each party's book moved (or queued for its first read). */
  onPrint(p: Print, addressOf: (acct: string) => string | null): void {
    if (!bookable(p.venue, p.symbol)) return;
    const mk = `${p.venue}|${p.symbol}`;
    this.marks.set(mk, p.px);
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
      hlc: { queued: this.hlc.size, done: this.hlc.done, failed: this.hlc.failed, lastError: this.hlc.lastError },
      scoh: { queued: this.scoh.size, done: this.scoh.done, failed: this.scoh.failed, lastError: this.scoh.lastError },
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
  private planPnl(members: Map<string, Member>, books: Map<string, Book>, now: number): void {
    const lane = this.hlc;
    const queued = lane.countPrefix('cohpnl:');
    if (queued >= PNL_QUEUE_CAP) return;
    const done = this.pnls();
    const due: Array<[string, number]> = [];
    for (const [address, book] of books) {
      if (!book.pos.size) continue;
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
    try {
      await this.planVenues();
    } finally {
      this.planMs = Date.now() - t0;
    }
  }

  private async planVenues(): Promise<void> {
    const now = this.d.now();
    const hlMembers = await this.membersOf('hyperliquid');
    const breath = async () => {
      await new Promise<void>((r) => setImmediate(r));
      mark('coh:plan');
    };
    for (const venue of VENUES) {
      await breath();
      const members = venue === 'hyperliquid' ? hlMembers : await this.membersOf(venue);
      await breath();
      this.members.set(venue, members);
      await this.saveMembers(venue, members);
      if (venue === 'hyperliquid') {
        this.planPnl(members, this.books.get(venue)!, now);
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
        if (book.pos.size && staleEquity(book, notional(book), now)) push(950 + size);
        else if (follows && eq >= floor && book.at < gap) push(900 + size);
        // Read before the spot state was looked at, and the leaderboard says it may matter.
        else if (venue === 'hyperliquid' && spotDue(book, m?.equity)) push(900 + size);
        else if (age >= (follows ? reconcileTtl(eq) : pollTtl(eq))) push(400 + size);
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
      due.sort((a, b) => b[1] - a[1]);
      for (const [address, prio] of due.slice(0, QUEUE_CAP - queued)) {
        lane.add({
          key: `coh:${venue}:${address}`,
          prio,
          run: async () => {
            const r = await this.readOne(venue, address, totals.get(address) ?? null);
            if (venue === 'lighter' && r.indices?.length) this.d.lighter.learn?.(address, r.indices);
            const at = this.d.now();
            books.set(address, {
              equity: r.equity, at, collateral: r.collateral ?? null, spotAt: r.spotAt ?? null,
              pos: new Map(r.positions.map((p) => [p.symbol, { szi: p.szi, entry: p.entry }])),
            });
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
        const rows: Array<{ venue: Venue; address: string; equity: number | null; positions: Position[]; at: number; collateral: number | null; spotAt: number | null }> = [];
        for (const k of this.dirtyBooks) {
          const i = k.indexOf('|');
          const venue = k.slice(0, i) as Venue;
          const address = k.slice(i + 1);
          const b = this.books.get(venue)?.get(address);
          if (!b) continue;
          rows.push({
            venue, address, equity: b.equity, at: b.at, collateral: b.collateral ?? null, spotAt: b.spotAt ?? null,
            positions: [...b.pos].map(([symbol, p]) => ({ symbol, szi: p.szi, entry: p.entry })),
          });
        }
        this.dirtyBooks.clear();
        s.putCohortBooks(rows);
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
