/**
 * History rows and the backward pager, pure: no Node, no DOM, no fetch.
 *
 * Moved out of history.ts (which re-exports all of it) so the browser's
 * exchange layer walks a wallet's fills with the very same pager and the very
 * same row identity the server uses. history.ts keeps the SQLite cache, the
 * sync scheduler and the aggregation; this file only knows what a row is and
 * how to page backwards through a newest-first endpoint.
 */
import { sha1 } from '@noble/hashes/legacy';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

// --- tunables ----------------------------------------------------------------

/**
 * Upstream's maximum page size, and the only sane choice for a full walk.
 *
 * History pages are billed `20 + limit/20`, so a 1000-row page costs 70 weight
 * (0.07/row) while a 100-row page costs 25 (0.25/row). Paging small would burn
 * three and a half times the weight of the shared per-minute budget for the
 * same history.
 *
 * The budget is shared with the live UI polls, so a long walk does slow the rest
 * of the app down while it runs. That is the deliberate trade: the alternative is
 * a walk that never finishes.
 */
export const PAGE_LIMIT = 1000;

/**
 * Hard ceiling on pages per walk phase - a million rows at PAGE_LIMIT.
 *
 * Not an expected outcome: it exists so a gateway that pages in a circle cannot
 * spin forever. Hitting it is reported as `truncated`, never as `complete`.
 */
export const MAX_PAGES = 1000;

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

export const asString = (v: unknown): string | null =>
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

/** sha1 of the row's JSON, hex. The server swaps in node:crypto (same bytes, native speed). */
let hashRow = (raw: string): string => bytesToHex(sha1(utf8ToBytes(raw)));

/** Replace the row hasher. It MUST be sha1-hex: the on-disk cache keys rows by it. */
export function setRowHasher(fn: (raw: string) => string): void {
  hashRow = fn;
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
 * (sha1 here is a dedupe key, not a security primitive.)
 */
export function rowId(raw: string): string {
  return hashRow(raw);
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
 * purpose - see the note at the top of history.ts.
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
