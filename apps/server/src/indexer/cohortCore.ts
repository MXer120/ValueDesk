/**
 * The cohorts' computing, in one piece that runs on either thread: the rules a book is read by (moved here from
 * cohortTracker.ts, which re-exports them), and the passes over every book and member that only read - the history
 * step (cohort_series every 15 min, cohort_mix hourly), which books are due a read (planDue), whose perp PnL is due
 * (pnlScan), which members changed since they were written (MemberSigs), and which holders to read again over open
 * interest (oiCheck.ts oiRereadsMany). The writes stay with the indexer (store.ts), in today's order.
 *
 * Why (2026-11-08/09, production): the indexer's one thread was 99.7% busy, and these passes ran on it - `record` took
 * 1,661 s of it after one restart, the plan and the PnL scan 13-16% of a stall profile. They now run on the heatmap
 * thread (liqLiveThread.ts), which already holds a copy of every book (liqLiveCore.ts MirrorSource) - not a second
 * copy of 300-560k books on a thread of their own. CohortMirror is what that thread keeps besides: the members, the
 * PnL reads' times, the archive's holders and read list. VALUESCAN_COHORT_WORKER=0 (or the heatmap inline, and the
 * tests) runs the same functions here on the indexer's books in place.
 */
import { VENUES, type Venue } from '../valuedesk/types.js';
import {
  Aggregator, MARGIN_SIBLING, TAIL_EQUITY, netWallet, perpEquity, sampleRule, sampledVenue, scopeKey, sectorTotals,
  type CohortRange, type WalletVenue,
} from '../valuedesk/cohorts/model.js';
import { liqCoin } from '../valuedesk/liquidations/levels.js';
import { outOfCohorts } from '../valuedesk/internalWallets.js';
import { DAY_MS } from './windows.js';
import type { BookRead } from './cohortSource.js';
import type { CohortMemberRow } from './store.js';
import type { BookLike, MirrorSource } from './liqLiveCore.js';
import { oiRereadsMany, type OiAsk } from './oiCheck.js';

/** An archive holder's notional from which its first read ranks with a trader's (USD). */
export const SEED_BONUS_MIN = 1_000;
/**
 * A wallet of the archive's read list (archiveSeed.ts loadReadList: it traded a perp in an older archive, and
 * nothing says what it holds now) waits below every other read: the tail's (300+), the routine reconciles
 * (400+) and the PnL reads (300+), so the boards' and the cohorts' own figures never wait for it. In the
 * list's order (the most recent trader first). Once read, its book makes it a member like any other.
 */
export const READ_LIST_PRIO = 100;

/** The liquidation backlog (cohortTracker.ts updateLiqBoost) counts a book from this much notional (USD). */
export const LIQ_BOOST_NOTIONAL = 10_000;

/** A book that opened a market it did not hold (its margin mode is the account's choice) is read again this soon. */
export const OPENED_REREAD_MS = 2 * 60_000;

/** Share of wallets under TAIL_EQUITY that are read (the rest are counted, not read). */
export const TAIL_RATE: Record<Venue, number> = { hyperliquid: 1, tradexyz: 1, sodex: 1, arcus: 1, lighter: 1 };

/**
 * A venue that read only a sample of its tail before (Lighter: 10% until 2026-10-31, when the owner
 * asked for every wallet). Its tail is read in full from then on, but counted as the old sample
 * (scaled up) until TAIL_FULL_SHARE of it has a book: counting every wallet at once would have shown
 * Lighter's small wallets at a tenth of the truth for the days the ~140k reads take.
 */
export const TAIL_SAMPLED_BEFORE: Partial<Record<Venue, number>> = { lighter: 0.1 };
/** The share of a venue's tail that must have a book before every one of them counts. */
export const TAIL_FULL_SHARE = 0.99;

/** The sampling rate the cohorts count a venue's tail with, given how much of it holds a book. */
export function tailCountRate(venue: Venue, tail: { members: number; read: number }): number {
  const was = TAIL_SAMPLED_BEFORE[venue];
  if (was === undefined) return TAIL_RATE[venue];
  return tail.members > 0 && tail.read / tail.members >= TAIL_FULL_SHARE ? TAIL_RATE[venue] : was;
}

/** A venue's tail: members under TAIL_EQUITY, and how many of them have a book. */
export function tailOf(members: ReadonlyMap<string, { equity: number | null }>, hasBook: (address: string) => boolean): { members: number; read: number } {
  let n = 0;
  let read = 0;
  for (const [address, m] of members) {
    if ((m.equity ?? 0) >= TAIL_EQUITY) continue;
    n++;
    if (hasBook(address)) read++;
  }
  return { members: n, read };
}

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

/**
 * An EMPTY Hyperliquid or trade.xyz book the stream follows: re-read after this long. It can only come to hold something by a print,
 * and a print opens the book (and asks for a read within minutes, OPENED_REREAD); prints missed in an outage
 * are covered by the outage re-reads (staleBefore, the gap floor). A deposit moves no position. Re-reading
 * them weekly spent ~18k Hyperliquid reads a day on 127k books that were empty (2026-11-07: 32 of 32 sampled
 * still empty on the venue, 96.7k of them already past the week, the lane behind on everything else).
 */
export const EMPTY_RECONCILE_MS = 30 * DAY_MS;

/** A book's routine re-read age (the lowest priority): reconcileTtl when the stream follows it, pollTtl otherwise. */
export function routineTtl(equity: number, venue: Venue, follows: boolean, positions: number): number {
  if (!follows) return pollTtl(equity);
  const ttl = reconcileTtl(equity, venue);
  // Only where every print names the wallet itself: SoDEX's stream misses prints (reconcileTtl), a Lighter print
  // names a sub-account (a new one is not known until a read), Arcus subscribes to its first 100 markets.
  const named = venue === 'hyperliquid' || venue === 'tradexyz';
  return positions > 0 || !named ? ttl : Math.max(ttl, EMPTY_RECONCILE_MS);
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
export function staleEquity(book: { equity: number | null; collateral?: number | null; at: number }, notional: number, now: number): boolean {
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

export function liqBacklogPrio(notional: number, equity: number | null): number {
  const lev = equity && equity > 0 ? Math.min(25, notional / equity) : 25;
  return 1100 + Math.min(500, Math.max(0, Math.round(Math.log10(Math.max(1, notional * lev)) * 60)));
}

/** Whether a book carries liquidation data (a calibrated read): a cross cash, or an isolated / kept figure. */
export function liqKnown(b: { cash?: number | null; pos: ReadonlyMap<string, { iso?: number | null; fix?: number | null }> }): boolean {
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
  /** SoDEX: which prints its read holds, to the millisecond (printInRead; this process only). */
  read?: BookRead;
  /** When a print last moved it (this process only): liqChangedDue. */
  filledAt?: number;
  /** Hyperliquid: a unified account's stablecoin collateral (model.ts perpEquity), when the read looked. */
  collateral?: number | null;
  /** Hyperliquid: when the read looked at the spot state. */
  spotAt?: number | null;
}

/**
 * A book outside its venue's tail sample (sampleRule) that still holds positions: read again once
 * its schedule says so (`ttl`), lowest of all reads. Until 2026-10-30 it was never read again, and
 * kept whatever it held in the live map for good (Lighter samples 10% of its small wallets).
 */
export function tailBookDue(book: { at: number; pos: { size: number } } | undefined, now: number, ttl: number): boolean {
  return !!book && book.pos.size > 0 && now - book.at >= ttl;
}

/**
 * How often a SoDEX holder's book is read whatever its coin's total looks like. The books follow every print, so a read only
 * corrects what the prints could not: a restart's gap beyond the catch-up's reach, transfers, whatever else moves a position.
 * Larger first; a wallet that traded since its read at most an hour.
 */
export function sodexBookTtl(notional: number, filledSinceRead: boolean): number {
  if (notional >= 100_000) return 15 * 60_000;
  if (notional >= 10_000) return 30 * 60_000;
  if (notional >= 1_000 || filledSinceRead) return 60 * 60_000;
  return SODEX_BOOK_MAX_MS;
}
/** The longest a SoDEX holder waits for a read, on schedule. */
export const SODEX_BOOK_MAX_MS = 3 * 60 * 60_000;
/** Above the routine reconciles (400s), below the open interest check (OI_PRIO) and the heatmap's refreshes (880). Largest first. */
export function sodexBookPrio(notional: number): number {
  return 500 + Math.min(360, Math.round(Math.log10(Math.max(1, notional)) * 40));
}

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

// --- what the passes read: the indexer's books in place, or the heatmap thread's copy ------------

/** A cohort member (cohortTracker.ts membersOf). */
export interface Member {
  pnl: number | null;
  /** Hyperliquid: the leaderboard's account value when `ranked`, else the last read's perps value. */
  equity: number | null;
  /** Hyperliquid: on the leaderboard (its equity counts spot and staked too). */
  ranked?: boolean;
  label: string | null;
  pnlRange?: Partial<Record<CohortRange, number | null>>;
}

/** One venue's books: the indexer's Map in place, or the heatmap thread's copy (CohortMirror). */
export interface BooksOf {
  readonly size: number;
  has(address: string): boolean;
  get(address: string): BookLike | undefined;
  keys(): Iterable<string>;
  entries(): Iterable<[string, BookLike]>;
}

export interface CohortView {
  books(venue: Venue): BooksOf;
  members(venue: Venue): ReadonlyMap<string, Member> | undefined;
  /** A mark by its `venue|symbol` key. */
  mark(key: string): number | undefined;
  /** When a Hyperliquid account's portfolio PnL was last read (cohort_pnl), undefined if never. */
  pnlAt(address: string): number | undefined;
  /** The archive's holders per venue (archiveSeed.ts loadSeeds) and its read list (loadReadList). */
  seeds(venue: Venue): ReadonlyMap<string, number> | undefined;
  readList(): readonly string[];
  /** The coins the heatmap covers (SoDEX's perps, liqCoin). */
  sodexCoins(): ReadonlySet<string>;
}

const EMPTY_MEMBERS: ReadonlyMap<string, Member> = new Map();

/** Run `fn` in slices: `late()` says a slice is used up, `rest()` gives the thread back. */
function slicer(breathe: () => Promise<void>, sliceMs: number) {
  let t0 = Date.now();
  return {
    late: () => Date.now() - t0 > sliceMs,
    rest: async () => { await breathe(); t0 = Date.now(); },
  };
}

// --- the history step (cohort_series, cohort_mix) ------------------------------------------------

/** Coins kept per cohort in the hourly mix. */
export const MIX_COINS = 120;

export interface RecordAsk { seriesT: number; mixT: number; doMix: boolean }
export interface SeriesRow { scope: string; cohort: string; t: number; long: number; short: number }
export interface MixRow { scope: string; cohort: string; t: number; data: string }
export interface RecordOut { series: SeriesRow[]; mix: MixRow[] }

/**
 * What one venue's wallets are read from in a history step. A wallet's input is made when its turn comes and let go with it. All of
 * them were made first (about 300k wallets' positions copied) and held through the netting, which took up to 14 minutes on a busy
 * thread (recordMs 847 s, 2026-11-06): long enough to reach the old generation, and a step's collection held the thread 8 s of 12.
 */
function recordSources(view: CohortView): Array<{ has: (a: string) => boolean; wallet: (a: string) => WalletVenue }> {
  return VENUES.map((venue) => {
    const books = view.books(venue);
    const sib = MARGIN_SIBLING[venue];
    const sibBooks = sib ? view.books(sib) : undefined;
    const members = view.members(venue) ?? EMPTY_MEMBERS;
    const rate = tailCountRate(venue, tailOf(members, (a) => books.has(a)));
    return {
      // The cohorts' history counts what the cohorts count (internalWallets.ts outOfCohorts).
      has: (a: string) => (members.has(a) || books.has(a)) && !outOfCohorts([venue], a),
      wallet: (address: string) => {
        const b = books.get(address);
        return sampledVenue(rate, address, members.get(address),
          b ? { equity: b.equity, at: b.at, positions: [...b.pos].map(([symbol, p]) => ({ symbol, szi: p.szi, entry: p.entry })) } : undefined,
          perpEquity(venue, b, sibBooks?.get(address)));
      },
    };
  });
}

/**
 * One history step's rows: every scope's cohort figures (cohort_series) and, on the hour, each cohort's coins and sectors
 * (cohort_mix). One pass over the wallets for every scope at once. A wallet is netted once per set of venues it is on that
 * a scope selects (most are on one venue: once in all), and that result is added to each such scope. Scope by scope it
 * was netted up to 31 times, and with ~300k wallets (2026-10-27) a pass took 100 minutes on a busy loop.
 */
export async function recordCompute(view: CohortView, ask: RecordAsk, breathe: () => Promise<void>, sliceMs: number): Promise<RecordOut> {
  const sources = recordSources(view);
  const priceOf = (v: Venue, sym: string) => view.mark(`${v}|${sym}`) ?? null;
  const series: SeriesRow[] = [];
  const mix: MixRow[] = [];
  const scopes = allScopes();
  const maskOf = (vs: readonly Venue[]) => vs.reduce((m, v) => m | (1 << VENUES.indexOf(v)), 0);
  const scopeMasks = scopes.map(maskOf);
  const aggs = scopes.map(() => new Aggregator());
  const addresses = new Set<string>();
  for (const v of VENUES) {
    for (const a of view.members(v)?.keys() ?? []) addresses.add(a);
    for (const a of view.books(v).keys()) addresses.add(a);
  }
  const s = slicer(breathe, sliceMs);
  for (const address of addresses) {
    let held = 0;
    // Listed on a venue counts it in that venue's scopes (as a member), its figures only where it has them.
    const wv: Array<WalletVenue | undefined> = sources.map((src, i) => {
      if (!src.has(address)) return undefined;
      held |= 1 << i;
      return src.wallet(address);
    });
    if (!held) continue;
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
    if (s.late()) await s.rest();
  }
  for (let i = 0; i < scopes.length; i++) {
    const key = scopeKey(scopes[i]!);
    for (const st of aggs[i]!.result()) {
      series.push({ scope: key, cohort: st.id, t: ask.seriesT, long: st.long, short: st.short });
      if (ask.doMix) {
        const c: Record<string, [number, number]> = {};
        for (const m of st.markets.slice(0, MIX_COINS)) c[m.coin] = [Math.round(m.long), Math.round(m.short)];
        const sct: Record<string, [number, number]> = {};
        for (const x of sectorTotals(st.markets)) sct[x.sector] = [Math.round(x.long), Math.round(x.short)];
        mix.push({ scope: key, cohort: st.id, t: ask.mixT, data: JSON.stringify({ c, s: sct }) });
      }
    }
    if (s.late()) await s.rest();
  }
  return { series, mix };
}

// --- which books are due a read (cohortTracker.ts planVenues) --------------------------------------

export interface PlanAsk {
  venue: Venue;
  now: number;
  /** Reads that fit the venue's queue now (QUEUE_CAP less those queued). */
  cap: number;
  /** False when the queue is full: only the counts (seedsUnread, readListUnread). */
  scan: boolean;
  /** The venue's stream runs (its books follow prints). */
  streamed: boolean;
  /** Its last outage's time and the equity from which books are read again after it. */
  gap: number;
  floor: number;
  /** Streamed books read before this missed an outage's prints (cohortRebuild.ts resumedAfterOutage). */
  staleBefore: number;
  startedAt: number;
}

/** What a plan reads besides the books: the wallets the streams saw trade, and which Lighter wallets' prints are followed. */
export interface PlanExtras {
  wanted: { has(address: string): boolean; list(): Iterable<string> };
  known: (address: string) => boolean;
}

export interface PlanOut {
  /** The reads that fit, highest priority first: address, priority, the leaderboard's account value (Hyperliquid, null off it). */
  due: Array<[string, number, number | null]>;
  /** Every read found due (dueLeft = dueLen - cap). */
  dueLen: number;
  /** Books waiting for liquidation data that show on the map (updateLiqBoost). */
  liqDue: number;
  /** The status's counts: archive holders without a book, read-list wallets without a book (Hyperliquid; null elsewhere). */
  seedsUnread: number;
  readListUnread: number | null;
}

/**
 * Every member, traded wallet, archive holder and read-list wallet of a venue considered for a read, by the rules above
 * (one priority per wallet), largest first.
 */
export async function planDue(view: CohortView, ask: PlanAsk, x: PlanExtras, breathe: () => Promise<void>, sliceMs: number): Promise<PlanOut> {
  const { venue, now, streamed, gap, floor } = ask;
  const members = view.members(venue) ?? EMPTY_MEMBERS;
  const hlMembers = view.members('hyperliquid') ?? EMPTY_MEMBERS;
  const books = view.books(venue);
  const seeds = view.seeds(venue);
  const sodexCoins = view.sodexCoins();
  const holdsSodexCoin = (b: BookLike): boolean => {
    for (const sym of b.pos.keys()) if (sodexCoins.has(liqCoin(sym))) return true;
    return false;
  };
  const due: Array<[string, number]> = [];
  let liqDue = 0;
  const totals = new Map<string, number | null>();
  const notional = (book: BookLike): number => {
    let v = 0;
    for (const [symbol, p] of book.pos) v += Math.abs(p.szi) * (view.mark(`${venue}|${symbol}`) ?? p.entry ?? 0);
    return v;
  };
  const consider = (address: string, m: Member | undefined) => {
    const eq = m?.equity ?? (venue === 'tradexyz' ? hlMembers.get(address)?.equity ?? 0 : 0);
    const book = books.get(address);
    const traded = x.wanted.has(address);
    // A wallet never read and never valued: the archive's notional orders it among the others.
    const size = Math.round(Math.log10(Math.max(1, eq || (book ? 0 : seeds?.get(address) ?? 0))) * 100);
    // A tail wallet outside the sample is never read, traded or not (it would count twice) - but a
    // book it already has (read while it was larger, or before the sample) still holds positions
    // the live map counts: it is read again on its schedule, and a read that finds them closed drops them.
    if (!sampleRule(TAIL_RATE[venue], address, eq).counts) {
      const follows = streamed && (venue !== 'lighter' || x.known(address));
      if (tailBookDue(book, now, follows ? reconcileTtl(eq, venue) : pollTtl(eq))) due.push([address, 300 + Math.round(Math.log10(Math.max(1, eq)) * 100)]);
      return;
    }
    const push = (prio: number) => {
      due.push([address, prio]);
      if (venue === 'hyperliquid') totals.set(address, m?.ranked ? m.equity : null);
    };
    if (!book) {
      // A tail wallet the old sample left out (TAIL_SAMPLED_BEFORE): read after every re-read the
      // heatmap and the books need (880-970), above the routine reconciles (400) - ~140k Lighter
      // wallets at 1000+ would have held Lighter's heatmap re-reads back for days.
      const was = TAIL_SAMPLED_BEFORE[venue];
      if (was !== undefined && eq < TAIL_EQUITY && !sampleRule(was, address, eq).counts) { push(450 + size); return; }
      // Never read: one the stream saw trade, or one the archive found holding $1K or more, before
      // any re-read. Dust from the archive (13.9k wallets under $33, 2026-10-28) waits its turn: with
      // the bonus it outranked the books still missing liquidation data, and the history rebuild,
      // paused until those are read, never ran.
      push(1_000 + size + (traded || (seeds?.get(address) ?? 0) >= SEED_BONUS_MIN ? 300 : 0));
      return;
    }
    const age = now - book.at;
    // A market it did not hold opened since the read: cross or isolated, and at what leverage, is
    // the venue's to say - booked as cross until then, which moved trade.xyz books' cash by
    // thousands (most of its markets are isolated). Read again within minutes.
    if (book.opened && age >= OPENED_REREAD_MS) { push(970 + size); return; }
    // Lighter prints name sub-accounts: a book follows them only once its indices are known.
    const follows = streamed && (venue !== 'lighter' || x.known(address));
    // Read before the books kept liquidation prices (2026-10-25): once, the most leveraged first -
    // their liquidations sit nearest the price, where the heatmap is read.
    if (book.pos.size && !liqKnown(book) && (book.at < ask.startedAt || book.liqMiss) && holdsSodexCoin(book)) {
      const n = notional(book);
      push(liqBacklogPrio(n, book.collateral ?? book.equity));
      // Only books that show on the map hold the rebuild back: ~540 nearly empty accounts
      // (equity under $3, 2026-10-28) never came up in the queue and paused it for good.
      if (n >= LIQ_BOOST_NOTIONAL) liqDue++;
    }
    else if (book.pos.size && staleEquity(book, notional(book), now)) push(950 + size);
    else if (follows && eq >= floor && book.at < gap) push(900 + size);
    // Read before the last outage ended: it missed that outage's prints, at any size.
    else if (follows && book.at < ask.staleBefore) push(900 + size);
    // Read before the spot state was looked at, and its equity uncertain: the leaderboard sees more
    // first; off it (needsSpot), below the heatmap's refreshes, largest first.
    else if (venue === 'hyperliquid' && spotDue(book, m?.ranked ? m.equity : null, notional(book))) push((m?.ranked ? 900 : 860) + size);
    // A book of $250K+ a fill moved since its read: its figures are the model's until a read (liqChangedDue).
    else if (book.pos.size && liqKnown(book) && holdsSodexCoin(book) && liqChangedDue(book, notional(book), now)) push(885 + size);
    // A large book whose liquidation prices sit on the heatmap: read again sooner than its reconcile (liqRefreshTtl).
    else if (book.pos.size && liqKnown(book) && age >= liqRefreshTtl(notional(book)) && holdsSodexCoin(book)) push(880 + size);
    // Every SoDEX holder on its own schedule, whatever its coin's total looks like. Up to the lane to fit: planned from
    // the holders of 2026-11-06 (12 of $100K+, 27 of $10K+, 133 of $1K+, 990 under), 565 reads an hour, 1,225 if every small one trades.
    else if (venue === 'sodex' && book.pos.size && age >= sodexBookTtl(notional(book), (book.filledAt ?? 0) > book.at)) push(sodexBookPrio(notional(book)));
    else if (age >= routineTtl(eq, venue, follows, book.pos.size)) push(400 + size);
  };
  const s = slicer(breathe, sliceMs);
  if (ask.scan) {
    for (const [address, m] of members) {
      consider(address, m);
      if (s.late()) await s.rest();
    }
    for (const address of x.wanted.list()) if (!members.has(address)) consider(address, undefined);
  }
  // The archive's holders not read yet (once read, their book makes them members); counted for the status either way.
  let seedsUnread = 0;
  for (const address of seeds?.keys() ?? []) {
    const has = books.has(address);
    if (!has) seedsUnread++;
    if (ask.scan && !members.has(address) && !has && !x.wanted.has(address)) consider(address, undefined);
    if (s.late()) await s.rest();
  }
  // The read list's wallets not read yet, below every other read (READ_LIST_PRIO).
  let readListUnread: number | null = null;
  if (venue === 'hyperliquid') {
    readListUnread = 0;
    for (const address of view.readList()) {
      const has = books.has(address);
      if (!has) readListUnread++;
      if (ask.scan && !members.has(address) && !has && !x.wanted.has(address) && !(seeds?.has(address) ?? false)) due.push([address, READ_LIST_PRIO]);
      if (s.late()) await s.rest();
    }
  }
  due.sort((a, b) => b[1] - a[1]);
  return {
    due: due.slice(0, Math.max(0, ask.cap)).map(([a, p]): [string, number, number | null] => [a, p, totals.get(a) ?? null]),
    dueLen: due.length,
    liqDue,
    seedsUnread,
    readListUnread,
  };
}

// --- whose perp PnL is due (cohortTracker.ts planPnl) --------------------------------------------

export interface PnlAsk {
  now: number;
  /** When perp PnL reads began: a read before is the whole account's PnL, read again. */
  perpSince: number;
  /** Hyperliquid's stream was down long enough across this start that the flows missed prints (OUTAGE_GAP_MS). */
  outage: boolean;
  startedAt: number;
}

/** A due list as two columns (300k pairs cloned between threads cost the indexer's thread ~10x more than this). */
export interface DueList { a: string[]; p: Float64Array }

/** Every Hyperliquid / trade.xyz holder whose perp PnL read is due, largest first. */
export async function pnlScan(view: CohortView, ask: PnlAsk, breathe: () => Promise<void>, sliceMs: number): Promise<DueList> {
  const members = view.members('hyperliquid') ?? EMPTY_MEMBERS;
  const due: Array<[string, number]> = [];
  // Holders on the main dex and on trade.xyz (the same accounts: accountPnl), every one of them -
  // the leaderboard's PnL is the whole account's, so a ranked holder is read too. By what it
  // holds (notional), the larger of that and its equity: the money in a PnL cohort is there.
  const seen = new Set<string>();
  const s = slicer(breathe, sliceMs);
  for (const venue of ['hyperliquid', 'tradexyz'] as const) {
    for (const [address, book] of view.books(venue).entries()) {
      if (s.late()) await s.rest();
      if (!book.pos.size || seen.has(address)) continue;
      seen.add(address);
      const m = members.get(address);
      const at = view.pnlAt(address);
      let ntl = 0;
      for (const [symbol, p] of book.pos) ntl += Math.abs(p.szi) * (view.mark(`${venue}|${symbol}`) ?? p.entry ?? 0);
      const eq = Math.max(ntl, m?.equity ?? book.equity ?? 0);
      // After an outage the flows miss what traded meanwhile: the large accounts are read again.
      const fresh = at !== undefined && at >= ask.perpSince && ask.now - at < pnlTtl(eq)
        && !(ask.outage && eq >= 100_000 && at < ask.startedAt);
      if (fresh) continue;
      due.push([address, pnlPrio(eq)]);
    }
  }
  due.sort((a, b) => b[1] - a[1]);
  return { a: due.map((x) => x[0]), p: Float64Array.from(due, (x) => x[1]) };
}

// --- which members changed since written (cohortTracker.ts saveMembers) ------------------------------

/**
 * The last written figures of every member, as a signature: a member whose signature moved is written again. Three
 * significant digits: a PnL kept current by its flow moves with every mark, and was rewritten every minute for every such
 * holder (2026-10-28); a cohort boundary is a round number.
 */
export class MemberSigs {
  private sig = new Map<string, string>();

  private static of(m: Member): string {
    const r = (v: number | null | undefined) => (v == null ? '' : Math.abs(v) < 100 ? Math.round(v) : Number(v.toPrecision(3)));
    return `${r(m.pnl)}|${r(m.equity)}|${m.label ?? ''}|${r(m.pnlRange?.['1d'])}|${r(m.pnlRange?.['7d'])}|${r(m.pnlRange?.['30d'])}`;
  }

  /** The members whose figures moved since the last call (their signatures move with it). */
  async changes(venue: Venue, members: ReadonlyMap<string, Member>, breathe: () => Promise<void>, sliceMs: number): Promise<CohortMemberRow[]> {
    const changed: CohortMemberRow[] = [];
    const s = slicer(breathe, sliceMs);
    for (const [address, m] of members) {
      const sig = MemberSigs.of(m);
      const k = `${venue}|${address}`;
      if (this.sig.get(k) !== sig) {
        this.sig.set(k, sig);
        changed.push({ address, pnl: m.pnl, equity: m.equity, label: m.label, pnl1d: m.pnlRange?.['1d'] ?? null, pnl7d: m.pnlRange?.['7d'] ?? null, pnl30d: m.pnlRange?.['30d'] ?? null });
      }
      if (s.late()) await s.rest();
    }
    return changed;
  }

  /** A set already written (a restarted heatmap thread is handed the last one the indexer wrote): nothing to return. */
  base(venue: Venue, members: ReadonlyMap<string, Member>): void {
    for (const [address, m] of members) this.sig.set(`${venue}|${address}`, MemberSigs.of(m));
  }

  /** Members that left the table: written again if they come back. */
  drop(venue: Venue, addresses: Iterable<string>): void {
    for (const a of addresses) this.sig.delete(`${venue}|${a}`);
  }
}

// --- members on the wire -------------------------------------------------------------------------

/** Members as numbers: per member pnl, equity, pnl 1d / 7d / 30d, flags; labels apart (most have none). */
export interface MembersWire { a: string[]; n: Float64Array; l: Array<[number, string]> }

const M_PNL_NULL = 1;
const M_EQ_NULL = 2;
const M_RANKED = 4;
const M_RANGE = 8;
const RANGES = ['1d', '7d', '30d'] as const;
/** Per range: present in pnlRange, and null there. */
const M_R_HAS = [16, 64, 256] as const;
const M_R_NULL = [32, 128, 512] as const;
const M_PER = 6;

export class MembersEncoder {
  private a: string[] = [];
  private n: number[] = [];
  private l: Array<[number, string]> = [];

  add(address: string, m: Member): void {
    let f = (m.pnl === null ? M_PNL_NULL : 0) | (m.equity === null ? M_EQ_NULL : 0) | (m.ranked ? M_RANKED : 0);
    const r = m.pnlRange;
    const nums = [m.pnl ?? 0, m.equity ?? 0, 0, 0, 0];
    if (r) {
      f |= M_RANGE;
      RANGES.forEach((k, i) => {
        const v = r[k];
        if (v === undefined) return;
        f |= M_R_HAS[i]!;
        if (v === null) f |= M_R_NULL[i]!;
        else nums[2 + i] = v;
      });
    }
    if (m.label !== null) this.l.push([this.a.length, m.label]);
    this.a.push(address);
    this.n.push(...nums, f);
  }

  take(): MembersWire {
    const out = { a: this.a, n: Float64Array.from(this.n), l: this.l };
    this.a = [];
    this.n = [];
    this.l = [];
    return out;
  }
}

export function encodeMembers(members: ReadonlyMap<string, Member>): MembersWire {
  const e = new MembersEncoder();
  for (const [a, m] of members) e.add(a, m);
  return e.take();
}

/** Member rows on the wire (the first diff after a start is every member: ~400k objects to clone). */
export function encodeRows(rows: readonly CohortMemberRow[]): MembersWire {
  const e = new MembersEncoder();
  for (const r of rows) e.add(r.address, { pnl: r.pnl, equity: r.equity, label: r.label, pnlRange: { '1d': r.pnl1d, '7d': r.pnl7d, '30d': r.pnl30d } });
  return e.take();
}

export function decodeRows(w: MembersWire): CohortMemberRow[] {
  const out: CohortMemberRow[] = [];
  for (const [address, m] of decodeMembers(w)) out.push({ address, pnl: m.pnl, equity: m.equity, label: m.label, pnl1d: m.pnlRange?.['1d'] ?? null, pnl7d: m.pnlRange?.['7d'] ?? null, pnl30d: m.pnlRange?.['30d'] ?? null });
  return out;
}

export function decodeMembers(w: MembersWire): Map<string, Member> {
  const labels = new Map(w.l);
  const out = new Map<string, Member>();
  for (let i = 0; i < w.a.length; i++) {
    const o = i * M_PER;
    const f = w.n[o + 5]!;
    const m: Member = { pnl: f & M_PNL_NULL ? null : w.n[o]!, equity: f & M_EQ_NULL ? null : w.n[o + 1]!, label: labels.get(i) ?? null };
    if (f & M_RANKED) m.ranked = true;
    if (f & M_RANGE) {
      const r: Partial<Record<CohortRange, number | null>> = {};
      RANGES.forEach((k, j) => { if (f & M_R_HAS[j]!) r[k] = f & M_R_NULL[j]! ? null : w.n[o + 2 + j]!; });
      m.pnlRange = r;
    }
    out.set(w.a[i]!, m);
  }
  return out;
}

// --- the heatmap thread's side ---------------------------------------------------------------------

/** Indexer -> heatmap thread: what the passes read besides the books. */
export type CohortIn =
  /** A venue's members as the last plan made them. */
  | { k: 'members'; venue: Venue; w: MembersWire }
  /** The members last written (a restarted thread): `w` absent = the members just handed in. */
  | { k: 'sigBase'; venue: Venue; w?: MembersWire }
  /** Members that left the table. */
  | { k: 'gone'; venue: Venue; a: string[] }
  /** PnL read times: `all` replaces every one. */
  | { k: 'pnlAt'; a: string[]; at: Float64Array; all?: boolean }
  | { k: 'seeds'; v: Array<[Venue, string[], Float64Array]> }
  | { k: 'readList'; a: string[] };

/** The passes asked of the heatmap thread, and what each takes. */
export type CohortAsk =
  | { op: 'record'; ask: RecordAsk }
  | { op: 'plan'; ask: PlanAsk; wanted: string[]; unknown: string[] | null }
  | { op: 'pnl'; ask: PnlAsk }
  /** A venue's new members: kept, and the ones that changed since written returned. */
  | { op: 'members'; venue: Venue; w: MembersWire }
  | { op: 'oi'; venue: Venue; asks: OiAsk[]; now: number };

/** One venue's books in the heatmap thread's copy, as the passes read them. */
class MirrorBooks implements BooksOf {
  constructor(private readonly src: MirrorSource, private readonly m: ReadonlyMap<string, unknown> | undefined) {}
  get size(): number { return this.m?.size ?? 0; }
  has(a: string): boolean { return this.m?.has(a) ?? false; }
  get(a: string): BookLike | undefined { return this.src.bookOf(this.m?.get(a)); }
  keys(): Iterable<string> { return this.m?.keys() ?? []; }
  *entries(): Iterable<[string, BookLike]> {
    if (!this.m) return;
    for (const [a, x] of this.m) yield [a, this.src.bookOf(x)!];
  }
}

/**
 * What the heatmap thread holds for the cohorts besides its copy of the books (MirrorSource): every venue's members,
 * the PnL reads' times, the archive's holders and read list, and the members' last written signatures.
 */
export class CohortMirror implements CohortView {
  private readonly mem = new Map<Venue, Map<string, Member>>();
  private readonly sigs = new MemberSigs();
  private readonly pnl = new Map<string, number>();
  private readonly seedMap = new Map<Venue, Map<string, number>>();
  private list: string[] = [];

  constructor(private readonly src: MirrorSource) {}

  books(venue: Venue): BooksOf { return new MirrorBooks(this.src, this.src.byVenue.get(venue)); }
  members(venue: Venue): ReadonlyMap<string, Member> | undefined { return this.mem.get(venue); }
  mark(key: string): number | undefined { return this.src.marks.get(key); }
  pnlAt(address: string): number | undefined { return this.pnl.get(address); }
  seeds(venue: Venue): ReadonlyMap<string, number> | undefined { return this.seedMap.get(venue); }
  readList(): readonly string[] { return this.list; }
  sodexCoins(): ReadonlySet<string> { return this.src.wantedSet; }

  apply(m: CohortIn): void {
    switch (m.k) {
      case 'members': this.mem.set(m.venue, decodeMembers(m.w)); return;
      case 'sigBase': {
        const base = m.w ? decodeMembers(m.w) : this.mem.get(m.venue);
        if (base) this.sigs.base(m.venue, base);
        return;
      }
      case 'gone': this.sigs.drop(m.venue, m.a); return;
      case 'pnlAt':
        if (m.all) this.pnl.clear();
        for (let i = 0; i < m.a.length; i++) this.pnl.set(m.a[i]!, m.at[i]!);
        return;
      case 'seeds':
        for (const [v, a, n] of m.v) this.seedMap.set(v, new Map(a.map((x, i) => [x, n[i]!])));
        return;
      case 'readList': this.list = m.a; return;
    }
  }

  async run(x: CohortAsk, breathe: () => Promise<void>, sliceMs: number): Promise<unknown> {
    switch (x.op) {
      case 'record': return recordCompute(this, x.ask, breathe, sliceMs);
      case 'plan': {
        const wanted = new Set(x.wanted);
        const unknown = x.unknown ? new Set(x.unknown) : null;
        return planDue(this, x.ask, { wanted: { has: (a) => wanted.has(a), list: () => x.wanted }, known: (a) => unknown !== null && !unknown.has(a) }, breathe, sliceMs);
      }
      case 'pnl': return pnlScan(this, x.ask, breathe, sliceMs);
      case 'members': {
        const members = decodeMembers(x.w);
        this.mem.set(x.venue, members);
        return encodeRows(await this.sigs.changes(x.venue, members, breathe, sliceMs));
      }
      case 'oi': return oiRereadsMany(this.books(x.venue).entries(), x.asks, liqCoin, x.now, breathe, sliceMs);
    }
  }
}

/** The passes on the heatmap thread (default when the heatmap is on its own thread); VALUESCAN_COHORT_WORKER=0 runs them here. */
export function cohortWorkerOn(): boolean {
  const v = process.env.VALUESCAN_COHORT_WORKER;
  if (v === '0') return false;
  if (v === '1') return true;
  return !process.env.NODE_TEST_CONTEXT;
}
