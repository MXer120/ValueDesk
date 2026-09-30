/**
 * All-time account history: a backward pager over the gateway's history
 * endpoints, an on-disk cache of what it found, and the per-coin aggregation the
 * Stats panel renders.
 *
 * Three things here are load-bearing and were each learned the hard way:
 *
 *  1. A FAILED PAGE IS NOT THE END OF HISTORY. Roughly one history page in twelve
 *     comes back HTTP 200 carrying an error envelope. `SodexClient.send` already
 *     refuses to read that as data and `request` already replays it, but the walk
 *     must also never wrap a page fetch in a try/catch that falls through to
 *     "no more rows" - that is precisely how a 50-page walk truncated in silence
 *     and reported a confidently wrong all-time total. A throw here aborts the
 *     walk, is recorded as an error, and leaves `complete = false` so the next
 *     run resumes instead of enshrining a partial number as final.
 *
 *  2. `endTime` IS INCLUSIVE. The next page is requested with
 *     `endTime = min(time)` of the page just read - NOT `min(time) - 1`.
 *     Same-millisecond fills are real and common on this venue, so subtracting a
 *     millisecond drops every trade that shared the boundary instant. The cost of
 *     the inclusive bound is that the boundary rows come back again, which is
 *     what the `seen` set is for.
 *
 *  3. FEES ARE PER-COIN, NOT DOLLARS. Over a thousand live spot fills, every BUY
 *     was charged in the base coin (WSOSO, vAVAX, vARB...) and every SELL in
 *     vUSDC. Summing those into a single "$" figure would be arithmetic on
 *     unrelated units. Every fee and funding total here is therefore a bucket
 *     keyed by coin, and stays one all the way to the screen.
 *
 * Amounts are accumulated as exact decimal strings (see DecimalSum), not floats:
 * these are money totals over tens of thousands of rows, and the repo already
 * pays for exact decimal handling everywhere else.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deviceKeyPath } from './deviceKey.js';
import { isRateLimited, sodex, weightFor, unwrapList } from './sodex/rest.js';
import { enginePath, type Engine } from './config.js';
import { canonicalDecimal } from './decimal.js';
import { mulDecimal, symbols } from './sodex/symbols.js';

// --- tunables ----------------------------------------------------------------

/**
 * Upstream's maximum page size, and the only sane choice for a full walk.
 *
 * History pages are billed `20 + limit/20`, so a 1000-row page costs 70 weight
 * (0.07/row) while a 100-row page costs 25 (0.25/row). Paging small would burn
 * three and a half times the shared 1200/min budget for the same history.
 *
 * The budget is shared with the live UI polls, so a long walk does slow the rest
 * of the app down while it runs. That is the deliberate trade: the alternative is
 * a walk that never finishes.
 */
const PAGE_LIMIT = 1000;

/**
 * Hard ceiling on pages per walk phase - a million rows at PAGE_LIMIT.
 *
 * Not an expected outcome: it exists so a gateway that pages in a circle cannot
 * spin forever. Hitting it is reported as `truncated`, never as `complete`.
 */
const MAX_PAGES = 1000;

/** How long a completed sync is considered fresh before an auto re-sync. */
const RESYNC_AFTER_MS = 5 * 60_000;

// --- exact decimal accumulation ---------------------------------------------

/**
 * Sums decimal STRINGS exactly, by keeping a bigint of scaled units and growing
 * the scale to whatever the widest value seen needs.
 *
 * Floats would be roughly fine for display, but "roughly fine" on a fee total is
 * how a trading screen starts lying quietly. `canonicalDecimal` already exists to
 * keep decimals off the float path; this keeps them off it while adding up too.
 */
export class DecimalSum {
  private scale = 0;
  private units = 0n;
  private n = 0;

  /** Number of values that were actually readable and added. */
  get count(): number {
    return this.n;
  }

  /** Returns false (and adds nothing) for a missing or unparseable value. */
  add(value: string | number | undefined | null): boolean {
    if (value === undefined || value === null || value === '') return false;
    let c: string;
    try {
      c = canonicalDecimal(value);
    } catch {
      return false;
    }
    const neg = c.startsWith('-');
    const body = neg ? c.slice(1) : c;
    const dot = body.indexOf('.');
    const intPart = dot < 0 ? body : body.slice(0, dot);
    const fracPart = dot < 0 ? '' : body.slice(dot + 1);

    if (fracPart.length > this.scale) {
      this.units *= 10n ** BigInt(fracPart.length - this.scale);
      this.scale = fracPart.length;
    }
    const digits = BigInt(intPart + fracPart.padEnd(this.scale, '0'));
    this.units += neg ? -digits : digits;
    this.n++;
    return true;
  }

  toString(): string {
    if (this.scale === 0) return this.units.toString();
    const neg = this.units < 0n;
    const raw = (neg ? -this.units : this.units).toString().padStart(this.scale + 1, '0');
    const s = raw.slice(0, raw.length - this.scale) + '.' + raw.slice(raw.length - this.scale);
    return canonicalDecimal((neg ? '-' : '') + s);
  }
}

// --- field access ------------------------------------------------------------

/**
 * Read the first present field from a list of candidate spellings.
 *
 * Same reasoning as web/src/format.ts's `pick`: the gateway's key names differ
 * between surfaces and are terse on some of them. Guessing one name and silently
 * reading `undefined` is how a column turns into a confident zero.
 */
function pick<T = unknown>(row: Record<string, unknown> | null, ...names: string[]): T | undefined {
  if (!row) return undefined;
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== null && v !== '') return v as T;
  }
  return undefined;
}

const asNumber = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : NaN;
};

const asString = (v: unknown): string | null =>
  v === undefined || v === null || v === '' ? null : String(v);

// --- row shapes --------------------------------------------------------------

/**
 * A history row reduced to the fields this module needs.
 *
 * `null` means "the venue did not give us this", and every consumer below treats
 * it as such - it is never defaulted to 0 or to a guessed coin. The Stats panel
 * renders a blank instead, which is the correct thing to show for a number
 * nobody actually reported.
 */
export interface NormalRow {
  id: string;
  time: number;
  symbol: string | null;
  side: string | null;
  price: string | null;
  qty: string | null;
  /** Explicit quote-side notional if the venue reported one. */
  quote: string | null;
  fee: string | null;
  feeCoin: string | null;
  /** Fills only. null when the row carried no maker flag. */
  isMaker: boolean | null;
  raw: string;
}

/**
 * Dedupe key: a hash of the WHOLE row, deliberately not `tradeID`.
 *
 * `tradeID` looks like the obvious key and is not one. Measured against a live
 * account, a single 1000-row page of perps fills contained 1000 distinct fills
 * under only 989 distinct tradeIDs - 11 collisions, and the colliding rows
 * differed in symbol, orderID, price, quantity, fee AND time. The id is evidently
 * scoped to something narrower than the account (per symbol, or per matching
 * shard), so keying on it would have silently discarded ~1.1% of every fill,
 * every fee and every dollar of volume in the all-time totals - understating them
 * with total confidence.
 *
 * Hashing the entire row cannot do that. The only rows it collapses are
 * byte-identical ones, which is exactly and only what the inclusive `endTime`
 * bound re-delivers at each page boundary. Fill records are immutable, so a
 * re-fetch of the same fill is the same bytes and the key is stable across runs
 * too - which is what makes the on-disk cache's primary key work.
 *
 * (sha1 here is a dedupe key, not a security primitive. `node:crypto` is a
 * built-in, so this stays dependency-free.)
 */
function rowId(raw: string): string {
  return createHash('sha1').update(raw).digest('hex');
}
const TIME_KEYS = ['time', 'timestamp', 'createdAt', 'tradeTime', 'transactTime', 'T', 'ts'];
/**
 * Fee-coin candidates. There is no single-letter candidate on purpose: the terse
 * WebSocket alphabet reuses letters across surfaces, and mislabelling which coin
 * a fee was charged in is worse than admitting we do not know.
 */
const FEE_COIN_KEYS = ['feeCoin', 'feeAsset', 'feeCurrency', 'commissionAsset', 'commissionCoin'];
const FEE_KEYS = ['fee', 'commission', 'tradingFee', 'f'];
/**
 * Speculative only, and expected to miss.
 *
 * A fill's OBSERVED shape on both engines is exactly
 *   { symbol, tradeID, orderID, clOrdID, side, price, quantity, fee, feeCoin,
 *     time, isMaker }
 * - there is no quote-side notional in it, so traded volume is always DERIVED as
 * price x quantity (exactly, via mulDecimal) and is labelled as derived in the
 * response. These names are kept so that a venue that starts reporting a quote
 * quantity is preferred over our own multiplication rather than ignored.
 */
const QUOTE_KEYS = ['quoteQty', 'quoteQuantity', 'quoteVolume', 'cumQuote', 'notional', 'turnover'];

/**
 * The confirmed spellings above are FIRST in every candidate list below; the
 * alternates behind them cost nothing and cover the terse WebSocket surface.
 */
export function normaliseTrade(row: Record<string, unknown>): NormalRow {
  const raw = JSON.stringify(row);
  const maker = row.isMaker ?? row.maker;
  return {
    id: rowId(raw),
    time: asNumber(pick(row, ...TIME_KEYS)),
    symbol: asString(pick(row, 'symbol', 's')),
    side: asString(pick(row, 'side', 'S')),
    price: asString(pick(row, 'price', 'p', 'avgPrice')),
    qty: asString(pick(row, 'quantity', 'qty', 'q', 'size', 'executedQty', 'origQty')),
    quote: asString(pick(row, ...QUOTE_KEYS)),
    fee: asString(pick(row, ...FEE_KEYS)),
    feeCoin: asString(pick(row, ...FEE_COIN_KEYS)),
    isMaker: typeof maker === 'boolean' ? maker : null,
    raw,
  };
}

/**
 * A funding record is exactly
 *   { symbol, positionID, positionSide, fundingFee, feeCoin, timestamp }
 * - observed directly, and notably WITHOUT a rate field, so nothing here tries to
 * report one.
 *
 * It carries no id at all, so it uses the same whole-row hash as a fill - which
 * for funding is not just a fallback but the right key anyway: a position settles
 * once per funding interval, so two byte-identical funding records cannot both be
 * real.
 */
export function normaliseFunding(row: Record<string, unknown>): NormalRow {
  const raw = JSON.stringify(row);
  const symbol = asString(pick(row, 'symbol'));
  const side = asString(pick(row, 'positionSide'));
  const time = asNumber(pick(row, 'timestamp', 'time', 'createdAt'));
  return {
    id: rowId(raw),
    time,
    symbol,
    side,
    price: null,
    qty: null,
    quote: null,
    fee: asString(pick(row, 'fundingFee', 'fee')),
    feeCoin: asString(pick(row, 'feeCoin')),
    isMaker: null,
    raw,
  };
}

// --- the backward pager ------------------------------------------------------

export interface PageQuery {
  limit: number;
  startTime?: number;
  endTime?: number;
}

export interface WalkResult {
  rows: NormalRow[];
  pages: number;
  oldest: number | null;
  newest: number | null;
  /** True only when a page came back genuinely empty - the real end of the range. */
  complete: boolean;
  /** True when the walk stopped because it reached the caller's `floorTime`. */
  reachedFloor: boolean;
  /** Non-null when the walk stopped for any other reason. Never treat as complete. */
  truncated: string | null;
}

/**
 * Walk a history endpoint backwards until it runs out of rows.
 *
 * `fetchPage` is expected to THROW on a failed page (which is what `sodex.get`
 * does after its retries are exhausted). That throw propagates out of here on
 * purpose - see the note at the top of the file.
 */
export async function walkBackwards(
  fetchPage: (q: PageQuery) => Promise<NormalRow[]>,
  opts: {
    startTime?: number;
    endTime?: number;
    /**
     * Stop once a page reaches back to this timestamp. Used by the incremental
     * catch-up, which only wants rows newer than what the cache already holds.
     *
     * Necessary as well as `startTime`, not instead of it: with only a lower
     * bound the walk would keep asking for [startTime, minT] and get the same
     * boundary rows forever, which the stall guard would then report as a
     * truncation rather than the ordinary completion it actually is.
     */
    floorTime?: number;
    limit?: number;
    maxPages?: number;
    /**
     * Called after every page, with the rows from THAT page that were not already
     * seen. The sink exists so a caller can persist as it goes: a full walk can
     * run for minutes, and a failure on page 40 must not throw away the first 39.
     */
    onPage?: (p: { pages: number; rows: number; oldest: number | null; fresh: NormalRow[] }) => void;
  } = {},
): Promise<WalkResult> {
  const limit = opts.limit ?? PAGE_LIMIT;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const seen = new Set<string>();
  const rows: NormalRow[] = [];

  let endTime = opts.endTime;
  let pages = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  let complete = false;
  let reachedFloor = false;
  let truncated: string | null = null;

  for (;;) {
    const page = await fetchPage({ limit, startTime: opts.startTime, endTime });
    pages++;

    // An empty page is unambiguous: nothing at or below `endTime` exists.
    if (page.length === 0) {
      complete = true;
      break;
    }

    let minT = Number.POSITIVE_INFINITY;
    let maxT = Number.NEGATIVE_INFINITY;
    const freshRows: NormalRow[] = [];
    for (const row of page) {
      if (Number.isFinite(row.time)) {
        if (row.time < minT) minT = row.time;
        if (row.time > maxT) maxT = row.time;
      }
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
      freshRows.push(row);
    }
    const fresh = freshRows.length;
    if (Number.isFinite(minT)) oldest = oldest === null ? minT : Math.min(oldest, minT);
    if (Number.isFinite(maxT)) newest = newest === null ? maxT : Math.max(newest, maxT);

    opts.onPage?.({ pages, rows: rows.length, oldest, fresh: freshRows });

    if (!Number.isFinite(minT)) {
      // Without a timestamp there is no way to ask for the next page back. Stop,
      // and say so - do not pretend the history ended here.
      truncated = 'a page carried no readable timestamp, so the walk could not step further back';
      break;
    }

    if (opts.floorTime !== undefined && minT <= opts.floorTime) {
      reachedFloor = true;
      break;
    }

    /*
     * End of history, confirmed in two steps.
     *
     * A page SHORTER than the limit means the gateway had nothing else at or
     * below `endTime` - that is the whole contract of a limit. But a short page
     * is also what a degraded upstream could hand back, so a short page on its
     * own is not enough: the walk steps back once more and only calls it
     * complete when that follow-up page ALSO comes up short and adds nothing new.
     *
     * The follow-up always happens in practice, because the inclusive `endTime`
     * guarantees the boundary-millisecond rows come back one more time. It is
     * this pair - short and entirely already-seen - that is the real terminator;
     * a literally empty page is the rarer case, reachable only for an account
     * with no history at all.
     */
    if (page.length < limit && fresh === 0) {
      complete = true;
      break;
    }

    /*
     * Stall guard.
     *
     * Because `endTime` is inclusive, a FULL page whose rows all share the
     * boundary millisecond comes back identical every time and the walk cannot
     * advance. That needs a whole page of fills inside one millisecond, so it is
     * not expected - but an unreported infinite loop would be far worse than an
     * honest "we stopped here", and it must never be mistaken for the
     * short-page terminator above.
     */
    if (endTime !== undefined && minT >= endTime && fresh === 0) {
      truncated = `stalled at ${minT}: a full page of ${limit} rows shares a single millisecond`;
      break;
    }
    if (pages >= maxPages) {
      truncated = `stopped at the ${maxPages}-page ceiling`;
      break;
    }

    // INCLUSIVE bound - see the header note. Not minT - 1.
    endTime = minT;
  }

  return { rows, pages, oldest, newest, complete, reachedFloor, truncated };
}

// --- page sources ------------------------------------------------------------

const qsOf = (q: PageQuery): string => {
  const p = new URLSearchParams();
  if (q.startTime !== undefined) p.set('startTime', String(q.startTime));
  if (q.endTime !== undefined) p.set('endTime', String(q.endTime));
  p.set('limit', String(q.limit));
  return p.toString();
};

/**
 * Calls the gateway through `sodex.get`, not through our own HTTP routes.
 *
 * Same upstream path and same query contract as routes/account.ts, but going
 * through the client directly inherits its retry, its backoff and - critically -
 * its refusal to read an error envelope as an empty page. Looping back through
 * our own server would add a hop and lose the typed failure.
 *
 * The explicit weight is required: `request` would otherwise call `weightFor`
 * with no limit and bill a 1000-row page at the 20-weight floor, overdrawing the
 * shared budget and earning a 429 that looks like it came from nowhere.
 */
/**
 * One caveat worth knowing about, recorded rather than worked around: the spot
 * `/trades` endpoint has been reported (mid-2026) to reject a `limit` sent
 * WITHOUT a `symbol`. It did not reproduce on re-testing - an unfiltered
 * limit=1000 page answers `code: 0` - so the walk sends the limit, which it needs
 * for the weight arithmetic to be honest. If the venue ever regresses, the page
 * throws and the walk records an error; it does NOT come back as an empty page
 * and quietly zero the spot totals, which is how that bug hid last time.
 */
function tradePage(engine: Engine, address: string) {
  return async (q: PageQuery): Promise<NormalRow[]> => {
    const path = `${enginePath(engine)}/accounts/${address}/trades?${qsOf(q)}`;
    const data = await sodex.get<unknown>(path, weightFor(path, q.limit));
    return unwrapList<Record<string, unknown>>(data, 'trades').map(normaliseTrade);
  };
}

function fundingPage(address: string) {
  return async (q: PageQuery): Promise<NormalRow[]> => {
    // `/fundings`, not the documented `/funding-history` - the latter 404s.
    const path = `${enginePath('perps')}/accounts/${address}/fundings?${qsOf(q)}`;
    const data = await sodex.get<unknown>(path, weightFor(path, q.limit));
    return unwrapList<Record<string, unknown>>(data, 'fundings').map(normaliseFunding);
  };
}

// --- aggregation -------------------------------------------------------------

export interface CoinTotal {
  coin: string | null;
  amount: string;
  count: number;
}

export interface SymbolTotal {
  symbol: string;
  count: number;
  volume: string | null;
  volumeCoin: string | null;
}

export interface TradeStats {
  count: number;
  firstTime: number | null;
  lastTime: number | null;
  /** Per-coin, never summed together. `coin: null` means the venue did not label it. */
  fees: CoinTotal[];
  /** Notional per quote coin. */
  volume: CoinTotal[];
  volumeSource: { reported: number; derived: number; unavailable: number };
  /** Fee tiers differ maker vs taker, so the split is the context for the fees above. */
  liquidity: { maker: number; taker: number; unknown: number };
  bySymbol: SymbolTotal[];
  /** Rows whose fee had a value but no coin label. */
  feeCoinUnlabelled: number;
  /** Rows we could not read a fee or a notional from at all. */
  unreadable: { fee: number; volume: number };
}

export interface FundingStats {
  count: number;
  firstTime: number | null;
  lastTime: number | null;
  totals: CoinTotal[];
  feeCoinUnlabelled: number;
  bySymbol: SymbolTotal[];
}

const sortedTotals = (m: Map<string | null, DecimalSum>): CoinTotal[] =>
  [...m.entries()]
    .map(([coin, sum]) => ({ coin, amount: sum.toString(), count: sum.count }))
    .sort((a, b) => b.count - a.count);

/**
 * Map symbol -> quote coin, so notional can be bucketed by the unit it is
 * actually denominated in. A symbol we cannot resolve buckets under `null`
 * rather than being folded into whichever coin happens to be most common.
 */
async function quoteCoins(engine: Engine): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    for (const s of await symbols(engine)) {
      if (s.name && s.quoteCoin) out.set(s.name, s.quoteCoin);
    }
  } catch {
    // Symbol metadata is a nicety here, not a prerequisite. Losing it costs the
    // volume bucket its label, which the panel shows as "unlabelled".
  }
  return out;
}

export async function aggregateTrades(engine: Engine, rows: NormalRow[]): Promise<TradeStats> {
  const quotes = await quoteCoins(engine);
  const fees = new Map<string | null, DecimalSum>();
  const volume = new Map<string | null, DecimalSum>();
  const perSymbol = new Map<string, { count: number; sum: DecimalSum; coin: string | null }>();

  let firstTime: number | null = null;
  let lastTime: number | null = null;
  let feeCoinUnlabelled = 0;
  let unreadableFee = 0;
  let unreadableVolume = 0;
  const source = { reported: 0, derived: 0, unavailable: 0 };
  const liquidity = { maker: 0, taker: 0, unknown: 0 };

  for (const r of rows) {
    if (Number.isFinite(r.time)) {
      if (firstTime === null || r.time < firstTime) firstTime = r.time;
      if (lastTime === null || r.time > lastTime) lastTime = r.time;
    }
    if (r.isMaker === null) liquidity.unknown++;
    else if (r.isMaker) liquidity.maker++;
    else liquidity.taker++;

    // -- fees, bucketed by the coin they were charged in --------------------
    if (r.fee !== null) {
      const key = r.feeCoin;
      if (key === null) feeCoinUnlabelled++;
      let bucket = fees.get(key);
      if (!bucket) fees.set(key, (bucket = new DecimalSum()));
      if (!bucket.add(r.fee)) unreadableFee++;
    }

    // -- notional -----------------------------------------------------------
    // Prefer a reported quote quantity; fall back to an EXACT price x quantity
    // (mulDecimal, no float), and record which of the two produced the number so
    // the panel can label the volume figure as derived where it is.
    let notional: string | null = null;
    if (r.quote !== null) {
      notional = r.quote;
      source.reported++;
    } else if (r.price !== null && r.qty !== null) {
      try {
        notional = mulDecimal(r.price, r.qty);
        source.derived++;
      } catch {
        source.unavailable++;
        unreadableVolume++;
      }
    } else {
      source.unavailable++;
    }

    const coin = r.symbol ? (quotes.get(r.symbol) ?? null) : null;
    if (notional !== null) {
      let bucket = volume.get(coin);
      if (!bucket) volume.set(coin, (bucket = new DecimalSum()));
      bucket.add(notional);
    }

    if (r.symbol) {
      let s = perSymbol.get(r.symbol);
      if (!s) perSymbol.set(r.symbol, (s = { count: 0, sum: new DecimalSum(), coin }));
      s.count++;
      if (notional !== null) s.sum.add(notional);
    }
  }

  return {
    count: rows.length,
    firstTime,
    lastTime,
    fees: sortedTotals(fees),
    volume: sortedTotals(volume),
    volumeSource: source,
    liquidity,
    bySymbol: [...perSymbol.entries()]
      .map(([symbol, s]) => ({
        symbol,
        count: s.count,
        volume: s.sum.count > 0 ? s.sum.toString() : null,
        volumeCoin: s.coin,
      }))
      .sort((a, b) => b.count - a.count),
    feeCoinUnlabelled,
    unreadable: { fee: unreadableFee, volume: unreadableVolume },
  };
}

export function aggregateFunding(rows: NormalRow[]): FundingStats {
  const totals = new Map<string | null, DecimalSum>();
  const perSymbol = new Map<string, { count: number; sum: DecimalSum; coin: string | null }>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  let feeCoinUnlabelled = 0;

  for (const r of rows) {
    if (Number.isFinite(r.time)) {
      if (firstTime === null || r.time < firstTime) firstTime = r.time;
      if (lastTime === null || r.time > lastTime) lastTime = r.time;
    }
    if (r.fee === null) continue;
    if (r.feeCoin === null) feeCoinUnlabelled++;

    // Summed with the venue's own sign. We do not flip it to a "paid/received"
    // convention of our own invention - the record does not say which it means.
    let bucket = totals.get(r.feeCoin);
    if (!bucket) totals.set(r.feeCoin, (bucket = new DecimalSum()));
    bucket.add(r.fee);

    if (r.symbol) {
      let s = perSymbol.get(r.symbol);
      if (!s) perSymbol.set(r.symbol, (s = { count: 0, sum: new DecimalSum(), coin: r.feeCoin }));
      s.count++;
      s.sum.add(r.fee);
    }
  }

  return {
    count: rows.length,
    firstTime,
    lastTime,
    totals: sortedTotals(totals),
    feeCoinUnlabelled,
    bySymbol: [...perSymbol.entries()]
      .map(([symbol, s]) => ({
        symbol,
        count: s.count,
        volume: s.sum.count > 0 ? s.sum.toString() : null,
        volumeCoin: s.coin,
      }))
      .sort((a, b) => b.count - a.count),
  };
}

// --- on-disk cache -----------------------------------------------------------

/**
 * Cache location: the per-user data directory, NOT beside the source.
 *
 * This file holds the account's full order and trade history, and it used to
 * live at `server/.stats-cache.db` - inside the OneDrive-synced project folder,
 * where it grew past half a gigabyte and replicated every rewrite to Microsoft's
 * cloud and to every other machine on the account. `.gitignore` does not stop
 * cloud sync; only the path does.
 *
 * Same directory as the device key and the local API token, for the same
 * reason. It holds no secret material, so this is a privacy and sync-churn fix
 * rather than a key-compromise one - but the reasoning that put device.key
 * outside the project applies here just as directly.
 *
 * `node:sqlite` is a Node built-in on this runtime, so this adds no dependency -
 * which is the whole reason it is used instead of a real database driver.
 */
export const statsDbPath = (): string => {
  const override = process.env.VALUETRADE_STATS_DB?.trim();
  if (override) return override;
  const dir = dirname(deviceKeyPath());
  mkdirSync(dir, { recursive: true });
  return join(dir, 'stats-cache.db');
};

/**
 * Bumped whenever a change to the normalisers would make already-cached columns
 * mean something different. A mismatch wipes the cache and re-walks rather than
 * mixing two vintages of parsing into one total.
 */
const SCHEMA_VERSION = 1;

let db: DatabaseSync | null = null;
let dbError: string | null = null;
let dbTried = false;
/** Resolved on first open, so a late `.env` load still wins. */
let dbPath = '';

/**
 * Opens the cache lazily and never throws.
 *
 * A cache that cannot be opened must degrade to "walk every time", not to "the
 * Stats panel is broken", so every caller below treats `null` as simply having
 * no cache.
 */
function store(): DatabaseSync | null {
  if (dbTried) return db;
  dbTried = true;
  dbPath = statsDbPath();
  try {
    const d = new DatabaseSync(dbPath);
    d.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const got = d.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as
      | { value?: string }
      | undefined;
    if (got?.value !== String(SCHEMA_VERSION)) {
      d.exec(`DROP TABLE IF EXISTS rows_; DROP TABLE IF EXISTS sync_state;`);
      d.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)`).run(
        String(SCHEMA_VERSION),
      );
    }
    d.exec(`
      CREATE TABLE IF NOT EXISTS rows_ (
        scope TEXT NOT NULL,
        id TEXT NOT NULL,
        time INTEGER NOT NULL,
        symbol TEXT,
        side TEXT,
        price TEXT,
        qty TEXT,
        quote TEXT,
        fee TEXT,
        fee_coin TEXT,
        is_maker INTEGER,
        raw TEXT NOT NULL,
        PRIMARY KEY (scope, id)
      );
      CREATE INDEX IF NOT EXISTS rows_scope_time ON rows_ (scope, time);
      CREATE TABLE IF NOT EXISTS sync_state (
        scope TEXT PRIMARY KEY,
        oldest INTEGER,
        newest INTEGER,
        complete INTEGER NOT NULL DEFAULT 0,
        pages INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
    `);
    db = d;
  } catch (e) {
    dbError = (e as Error).message;
    db = null;
  }
  return db;
}

export const cacheStatus = (): { path: string; ok: boolean; error: string | null } => {
  store();
  return { path: dbPath, ok: db !== null, error: dbError };
};

interface ScopeState {
  oldest: number | null;
  newest: number | null;
  complete: boolean;
  pages: number;
  updatedAt: number;
  lastError: string | null;
}

const EMPTY_STATE: ScopeState = {
  oldest: null,
  newest: null,
  complete: false,
  pages: 0,
  updatedAt: 0,
  lastError: null,
};

function readState(scope: string): ScopeState {
  const d = store();
  if (!d) return { ...EMPTY_STATE };
  const r = d.prepare(`SELECT * FROM sync_state WHERE scope = ?`).get(scope) as
    | Record<string, unknown>
    | undefined;
  if (!r) return { ...EMPTY_STATE };
  return {
    oldest: typeof r.oldest === 'number' ? r.oldest : null,
    newest: typeof r.newest === 'number' ? r.newest : null,
    complete: Number(r.complete ?? 0) === 1,
    pages: Number(r.pages ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
    lastError: typeof r.last_error === 'string' ? r.last_error : null,
  };
}

function writeState(scope: string, s: ScopeState): void {
  const d = store();
  if (!d) return;
  d.prepare(
    `INSERT OR REPLACE INTO sync_state (scope, oldest, newest, complete, pages, updated_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(scope, s.oldest, s.newest, s.complete ? 1 : 0, s.pages, s.updatedAt, s.lastError);
}

function saveRows(scope: string, rows: NormalRow[]): number {
  const d = store();
  if (!d || rows.length === 0) return 0;
  const stmt = d.prepare(
    `INSERT OR REPLACE INTO rows_ (scope, id, time, symbol, side, price, qty, quote, fee, fee_coin, is_maker, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // One transaction: tens of thousands of individual commits would make a long
  // walk disk-bound rather than network-bound.
  d.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(
        scope,
        r.id,
        Number.isFinite(r.time) ? r.time : 0,
        r.symbol,
        r.side,
        r.price,
        r.qty,
        r.quote,
        r.fee,
        r.feeCoin,
        // node:sqlite binds only null/number/bigint/string/Uint8Array - a boolean
        // would throw and abort the whole transaction.
        r.isMaker === null ? null : r.isMaker ? 1 : 0,
        r.raw,
      );
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

function loadRows(scope: string): NormalRow[] {
  const d = store();
  if (!d) return [];
  const out: NormalRow[] = [];
  for (const r of d.prepare(`SELECT * FROM rows_ WHERE scope = ? ORDER BY time DESC`).all(scope)) {
    const o = r as Record<string, unknown>;
    out.push({
      id: String(o.id ?? ''),
      time: Number(o.time ?? 0),
      symbol: asString(o.symbol),
      side: asString(o.side),
      price: asString(o.price),
      qty: asString(o.qty),
      quote: asString(o.quote),
      fee: asString(o.fee),
      feeCoin: asString(o.fee_coin),
      isMaker: o.is_maker === null || o.is_maker === undefined ? null : Number(o.is_maker) === 1,
      raw: String(o.raw ?? ''),
    });
  }
  return out;
}

function dropScope(scope: string): void {
  const d = store();
  if (!d) return;
  d.prepare(`DELETE FROM rows_ WHERE scope = ?`).run(scope);
  d.prepare(`DELETE FROM sync_state WHERE scope = ?`).run(scope);
}

// --- sync jobs ---------------------------------------------------------------

export type ScopeKind = 'trades-spot' | 'trades-perps' | 'funding';

export const SCOPE_KINDS: ScopeKind[] = ['trades-spot', 'trades-perps', 'funding'];

const scopeKey = (kind: ScopeKind, address: string): string => `${kind}|${address.toLowerCase()}`;

export interface SyncProgress {
  kind: ScopeKind;
  status: 'never' | 'running' | 'done' | 'error';
  /** Pages fetched in the run currently in flight (or the last one). */
  pages: number;
  /** New rows fetched in that run. */
  fetched: number;
  /** Rows in the cache for this scope. */
  cached: number;
  /** Oldest timestamp the walk has reached. */
  oldest: number | null;
  newest: number | null;
  /** True only once a walk hit the genuine end of history. */
  complete: boolean;
  /** Non-null when a walk stopped for a reason other than running out of rows. */
  truncated: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
}

const running = new Map<string, SyncProgress>();

function cachedCount(scope: string): number {
  const d = store();
  if (!d) return 0;
  const r = d.prepare(`SELECT COUNT(*) AS n FROM rows_ WHERE scope = ?`).get(scope) as
    | { n?: number }
    | undefined;
  return Number(r?.n ?? 0);
}

/** Current progress for one scope, whether or not a walk is in flight. */
export function progressOf(kind: ScopeKind, address: string): SyncProgress {
  const scope = scopeKey(kind, address);
  const live = running.get(scope);
  if (live) return live;
  const s = readState(scope);
  return {
    kind,
    status: s.updatedAt === 0 ? 'never' : s.lastError ? 'error' : 'done',
    pages: s.pages,
    fetched: 0,
    cached: cachedCount(scope),
    oldest: s.oldest,
    newest: s.newest,
    complete: s.complete,
    truncated: null,
    error: s.lastError,
    startedAt: null,
    finishedAt: s.updatedAt || null,
    updatedAt: s.updatedAt,
  };
}

function pageSource(kind: ScopeKind, address: string): (q: PageQuery) => Promise<NormalRow[]> {
  if (kind === 'trades-spot') return tradePage('spot', address);
  if (kind === 'trades-perps') return tradePage('perps', address);
  return fundingPage(address);
}

/**
 * Bring one scope up to date.
 *
 * Two phases, either of which may be a no-op:
 *
 *  1. CATCH UP. If we already have a `newest`, ask only for rows at or after it
 *     (`startTime` is a real lower bound upstream). On a warm cache this is
 *     normally a single page.
 *  2. EXTEND. If the backward walk has never reached the end of history, resume
 *     from the oldest row we hold and keep going.
 *
 * `complete` is only ever set by phase 2 reaching an empty page. Phase 1
 * completing means "complete down to startTime", which is a different claim and
 * must not be allowed to mark the whole history as walked.
 */
async function syncScope(kind: ScopeKind, address: string, rebuild: boolean): Promise<void> {
  const scope = scopeKey(kind, address);
  if (rebuild) dropScope(scope);

  const prior = readState(scope);
  const prog: SyncProgress = {
    kind,
    status: 'running',
    pages: 0,
    fetched: 0,
    cached: cachedCount(scope),
    oldest: prior.oldest,
    newest: prior.newest,
    complete: prior.complete,
    truncated: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    updatedAt: Date.now(),
  };
  running.set(scope, prog);

  const fetchPage = paced(pageSource(kind, address));

  let oldest = prior.oldest;
  let newest = prior.newest;
  let complete = prior.complete;
  let pages = 0;
  let error: string | null = null;
  let truncated: string | null = null;

  /**
   * Persist after EVERY page, not at the end of the phase.
   *
   * A full walk is minutes long, and page ~8% of the time comes back as an error
   * envelope that survives its retries. If the rows only landed when the phase
   * returned, a failure on the fortieth page would discard the thirty-nine
   * before it AND leave `oldest` where it started - so the retry would re-fetch
   * the same history, hit the same odds, and could realistically never finish.
   * Saving per page makes the walk genuinely resumable: progress is monotonic,
   * and a failure costs one page.
   */
  const savePage = (p: { pages: number; rows: number; fresh: NormalRow[] }) => {
    prog.pages += 1;
    prog.fetched = p.rows;
    prog.updatedAt = Date.now();
    saveRows(scope, p.fresh);
  };

  const checkpoint = (lastError: string | null = null) => {
    prog.oldest = oldest;
    prog.newest = newest;
    writeState(scope, { oldest, newest, complete, pages: prog.pages, updatedAt: Date.now(), lastError });
  };

  /**
   * Phase 2's checkpoint. Safe to advance the covered window on every page
   * BECAUSE phase 2 descends contiguously: at any moment everything between the
   * current `oldest` and the top has been fetched, so the recorded window is
   * always a true statement about what is on disk.
   *
   * `complete` is carried through untouched - a checkpoint must never upgrade the
   * completeness claim, nor undo one the phase already earned.
   */
  const onExtendPage = (p: { pages: number; rows: number; oldest: number | null; fresh: NormalRow[] }) => {
    savePage(p);
    for (const r of p.fresh) {
      if (!Number.isFinite(r.time)) continue;
      if (oldest === null || r.time < oldest) oldest = r.time;
      if (newest === null || r.time > newest) newest = r.time;
    }
    checkpoint();
  };

  try {
    if (newest !== null) {
      /*
       * Phase 1 saves its rows per page but does NOT move `newest` until the
       * phase finishes.
       *
       * It descends from now down to the floor, so a failure halfway leaves a
       * HOLE between the old `newest` and where it got to. Advancing `newest`
       * mid-phase would record that hole as covered, and the next catch-up would
       * start above it - the gap would never be filled and the totals would be
       * quietly short by exactly those fills. Leaving `newest` alone costs a
       * repeat of a page or two and is always correct; the rows already written
       * are simply deduped on the retry.
       *
       * `startTime` keeps the pages small; `floorTime` is what ends the phase.
       */
      const r = await walkBackwards(fetchPage, { startTime: newest, floorTime: newest, onPage: savePage });
      pages += r.pages;
      prog.fetched = 0; // phase 2 restarts the per-run row counter
      if (r.newest !== null) newest = Math.max(newest, r.newest);
      if (r.truncated) truncated = r.truncated;
      checkpoint();
    }

    if (!complete) {
      const r = await walkBackwards(fetchPage, {
        // Resume from the oldest row already held. `endTime` is inclusive, so the
        // boundary row comes back and is deduped rather than skipped.
        endTime: oldest ?? undefined,
        onPage: onExtendPage,
      });
      pages += r.pages;
      complete = r.complete;
      if (r.truncated) truncated = r.truncated;
    }
  } catch (e) {
    // Every page fetched before the failure is already on disk (see savePage),
    // and `complete` stays false - so the next run resumes from the checkpointed
    // `oldest` rather than publishing this partial walk as an all-time total.
    error = (e as Error).message;
  }

  // `complete` is the narrow claim "the backward walk reached the beginning of
  // history" and nothing else. A truncation is recorded separately so it shows
  // up in the UI and re-arms the next sync, but it does not get to rewrite a
  // completeness that phase 2 legitimately established.
  writeState(scope, {
    oldest,
    newest,
    complete,
    pages,
    updatedAt: Date.now(),
    lastError: error ?? truncated,
  });

  prog.status = error ? 'error' : 'done';
  prog.pages = pages;
  prog.cached = cachedCount(scope);
  prog.oldest = oldest;
  prog.newest = newest;
  prog.complete = complete;
  prog.truncated = truncated;
  prog.error = error;
  prog.finishedAt = Date.now();
  prog.updatedAt = Date.now();
  running.delete(scope);
}

/**
 * BACKGROUND WALKS ARE THE LOWEST PRIORITY TRAFFIC. A market maker's history is
 * thousands of pages; walked flat out it spent the shared budget and got this
 * IP rate-limited by SoDEX's Cloudflare, so every panel on every page stopped
 * loading. Now every walk page (all scopes together) waits:
 *   - at least WALK_GAP_MS after the previous one,
 *   - while the shared budget is more than half spent (interactive reads first),
 *   - while a rate-limit cooldown is running (and gives up if it is long - the
 *     next sync resumes from the checkpoint).
 */
const WALK_GAP_MS = 6_000;
/** After SoDEX rate-limits a walk page, every background walk stays off this long. */
const WALK_PAUSE_AFTER_429_MS = 30 * 60_000;
let lastWalkPage = 0;
let walksPausedUntil = 0;
function paced<Q, R>(fetchPage: (q: Q) => Promise<R>): (q: Q) => Promise<R> {
  return async (q: Q) => {
    for (;;) {
      if (Date.now() < walksPausedUntil) throw new Error('SoDEX rate-limited this server - background history walks are paused.');
      const cool = sodex.cooldownLeft();
      // Any endpoint cooling down: a background walk does not add to it.
      if (cool > 0) {
        walksPausedUntil = Math.max(walksPausedUntil, Date.now() + Math.min(WALK_PAUSE_AFTER_429_MS, cool * 4));
        throw new Error('SoDEX is rate limiting this server - the walk resumes later.');
      }
      const gap = lastWalkPage + WALK_GAP_MS - Date.now();
      const wait = Math.max(gap, sodex.budgetSpent() > 600 ? 3_000 : 0);
      if (wait <= 0) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    lastWalkPage = Date.now();
    try {
      return await fetchPage(q);
    } catch (e) {
      if (isRateLimited(e)) walksPausedUntil = Date.now() + WALK_PAUSE_AFTER_429_MS;
      throw e;
    }
  };
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Start a sync for one scope if one is not already running and the cache is
 * stale, incomplete, or absent. Returns immediately - the walk continues in the
 * background and the caller polls `progressOf`.
 */
export function ensureSync(kind: ScopeKind, address: string, rebuild = false): void {
  const scope = scopeKey(kind, address);
  if (inFlight.has(scope)) return;

  const s = readState(scope);
  const stale = Date.now() - s.updatedAt > RESYNC_AFTER_MS;
  // A recorded error or truncation re-arms the sync even inside the freshness
  // window: an incomplete answer is exactly the thing worth retrying.
  if (!rebuild && s.complete && !s.lastError && !stale) return;

  const p = syncScope(kind, address, rebuild)
    .catch((e) => {
      // syncScope handles its own errors; this is the belt-and-braces path so an
      // unexpected throw can never leave the scope permanently "in flight".
      const prog = running.get(scope);
      if (prog) {
        prog.status = 'error';
        prog.error = (e as Error).message;
        running.delete(scope);
      }
    })
    .finally(() => inFlight.delete(scope));
  inFlight.set(scope, p);
}

export const isSyncing = (address: string): boolean =>
  SCOPE_KINDS.some((k) => inFlight.has(scopeKey(k, address)));

/** Everything cached for one scope, newest first. */
export const rowsFor = (kind: ScopeKind, address: string): NormalRow[] =>
  loadRows(scopeKey(kind, address));

/** Test/maintenance hook: forget everything cached for an address. */
export function clearAddress(address: string): void {
  for (const kind of SCOPE_KINDS) dropScope(scopeKey(kind, address));
}
