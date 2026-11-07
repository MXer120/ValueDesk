/**
 * A tracked wallet's fills from the index, in the shape the venues' own fill
 * reads answer (VsFill), for the Copy page's charts and Scan's cards
 * (GET /api/vs/wallet/fills, routes/valuedesk.ts).
 *
 * The browser otherwise walks the venue's own fill history for every chart: up
 * to 5,000 fills, and SoDEX serves a couple of trade pages a minute per IP. The
 * indexer already holds the fills of every wallet it tracks (store `fills`),
 * and `coverage` says which span of them is COMPLETE: [from_t, to_t] per
 * history kind (SoDEX: perps and spot; Hyperliquid: fills). SoDEX and
 * Hyperliquid only (FILL_KINDS).
 *
 * NOT IDENTICAL ROWS. Hyperliquid's REST fills are stored aggregated per order
 * and millisecond (aggregateByTime), so a held span has fewer, larger rows than
 * the browser's unaggregated read - the same sizes and prices once the replay
 * groups a millisecond's prints (sim/adapt.ts), which it does. The index keeps
 * no direction label (`dir` null), so the replay's label check is skipped.
 *
 * WHAT IS ANSWERED. Only the held span, never a guess:
 *   - `covered: false` when the wallet is not indexed, or the window starts
 *     before what the index holds and the newest `limit` fills do not all fall
 *     inside it - the browser then reads the venue as before;
 *   - otherwise the newest `limit` fills in [from, min(to, heldTo)], newest
 *     first, and `heldTo`: the fills after it (the stream may have caught up
 *     less far than now) are the browser's to read from the venue - a short
 *     tail instead of the whole walk.
 * The held span starts at the coverage's from_t, or earlier when the venue has
 * nothing older (exhausted, and not just its cap), but never before the raw
 * rows the retention kept (a frozen day has only its day sums).
 *
 * Reads: the coverage rows and the frozen-day bound (primary-key lookups), and
 * one backwards walk of fills_t bounded by `limit`, in slices. A copy of each
 * answer is kept five minutes per (venue, address, from rounded to five
 * minutes, to, limit); when the held span grows at its end meanwhile, only the
 * new rows are read onto it.
 */
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Venue, VsFill } from '../valuedesk/types.js';
import { reader } from './reader.js';
import type { HistoryKind, IndexStore, WalletFillRow } from './store.js';

const DAY_MS = 86_400_000;
export const WALLET_FILLS_TTL_MS = 5 * 60_000;
/** The most fills one answer carries (the Copy page asks 5,000); a larger ask is left to the venue. */
export const WALLET_FILLS_MAX = 10_000;
const FROM_STEP_MS = 5 * 60_000;
const CACHE_MAX = 2_000;
/** Rows per synchronous read (about 150 ms when none is in the page cache). */
const SLICE = 250;

export type WalletFillsBody =
  | { ok: true; covered: false; reason: string }
  | { ok: true; covered: true; heldTo: number; fills: VsFill[] };

export interface WalletFillsQuery {
  from?: number;
  to?: number;
  limit: number;
}

/**
 * The venues answered, and the history kinds that together make one's fill list (the browser's read
 * merges SoDEX's two engines). Only the two a copy follows, compared fill by fill with the venues'
 * own reads (2026-11-07). Not Arcus: its held span still carries stream prints beside the REST fill
 * of the same order (both counted, 11 of 566 in a month); Lighter and trade.xyz were not compared.
 */
export const FILL_KINDS: Partial<Record<Venue, readonly HistoryKind[]>> = {
  sodex: ['perps', 'spot'],
  hyperliquid: ['fills'],
};

/** [lo, hi]: the span whose fills the index holds completely (lo 0: from the wallet's first fill), or null when not indexed. */
export function heldSpan(store: IndexStore, venue: Venue, address: string): { lo: number; hi: number } | null {
  const kinds = FILL_KINDS[venue];
  if (!kinds) return null;
  const rawFrom = store.rawFromDay(venue, address) * DAY_MS;
  let lo = 0;
  let hi = Number.POSITIVE_INFINITY;
  for (const kind of kinds) {
    const c = store.coverage(venue, address, kind);
    if (!c) return null;
    const start = c.exhausted && !c.capped && c.fromT >= rawFrom ? 0 : Math.max(c.fromT, rawFrom);
    lo = Math.max(lo, start);
    hi = Math.min(hi, c.toT);
  }
  return { lo, hi };
}

/** One row as the venue reads answer it: the same members in the same order (valuedesk/hyperliquid/mappers.ts mapFill). */
export function rowToFill(r: WalletFillRow): VsFill {
  return {
    id: String(r.id),
    time: r.t,
    symbol: r.symbol,
    side: r.side > 0 ? 'buy' : 'sell',
    px: r.px,
    sz: r.sz,
    notional: r.px * r.sz,
    fee: r.fee ?? null,
    closedPnl: r.closed_pnl ?? null,
    dir: null,
    oid: r.oid ?? null,
  };
}

const notCovered = (reason: string): WalletFillsBody => ({ ok: true, covered: false, reason });

/**
 * The newest `limit` rows in [lower, upper], a slice at a time with the event loop handed back
 * between slices: 5,000 rows not in the page cache took up to 3 s on production's file (2026-11-07),
 * which in one piece would hold every other request of the API that long. Each slice is its own
 * snapshot: a REST read landing in between (it replaces stream prints) can leave one answer with
 * both copies of a few prints, for the five minutes it is kept.
 */
async function readRows(store: IndexStore, venue: Venue, address: string, lower: number, upper: number, limit: number): Promise<WalletFillRow[]> {
  const out: WalletFillRow[] = [];
  if (upper < lower) return out;
  let at: { t: number; id: string } | null = null;
  while (out.length < limit) {
    const n = Math.min(SLICE, limit - out.length);
    const got: WalletFillRow[] = at ? store.walletFillRows(venue, address, lower, at.t, n, at.id) : store.walletFillRows(venue, address, lower, upper, n);
    for (const r of got) out.push(r);
    if (got.length < n) break;
    const last = got[got.length - 1]!;
    at = { t: last.t, id: String(last.id) };
    await nextTurn();
  }
  return out;
}

async function answer(store: IndexStore, venue: Venue, address: string, q: WalletFillsQuery, span: Span): Promise<WalletFillsBody> {
  const from = q.from ?? 0;
  const rows = await readRows(store, venue, address, Math.max(from, span.lo), Math.min(q.to ?? Number.POSITIVE_INFINITY, span.hi), q.limit);
  // The window starts before the held span: only complete if the newest `limit` fills all fall inside it.
  if (from < span.lo && rows.length < q.limit) return notCovered('the index holds this wallet from a later time');
  return { ok: true, covered: true, heldTo: span.hi, fills: rows.map(rowToFill) };
}

type Span = { lo: number; hi: number };

interface Kept {
  at: number;
  span: Span;
  body: Promise<WalletFillsBody>;
}

const kept = new Map<string, Kept>();

/**
 * A kept answer brought up to a held span that has grown at its end (the stream moves to_t up every 30 s):
 * only the rows in between are read. Anything else is read again.
 */
async function moveUp(store: IndexStore, venue: Venue, address: string, q: WalletFillsQuery, prev: Promise<WalletFillsBody>, was: Span, span: Span): Promise<WalletFillsBody> {
  const body = await prev;
  if (!body.covered) return answer(store, venue, address, q, span);
  const to = q.to ?? Number.POSITIVE_INFINITY;
  const lower = Math.max(q.from ?? 0, span.lo, Math.min(to, was.hi) + 1);
  const fresh = await readRows(store, venue, address, lower, Math.min(to, span.hi), q.limit);
  return { ok: true, covered: true, heldTo: span.hi, fills: [...fresh.map(rowToFill), ...body.fills].slice(0, q.limit) };
}

/** The route's answer: the index this process reads, through the five-minute copy (requests for the same one share its read). */
export async function walletFills(venue: Venue, address: string, q: WalletFillsQuery, now = Date.now(), store: IndexStore | null = reader()): Promise<WalletFillsBody> {
  if (q.limit > WALLET_FILLS_MAX) return notCovered('more fills than the index answers at once');
  if (!store) return notCovered('the index is not open yet');
  const span = heldSpan(store, venue, address);
  if (!span) return notCovered('this wallet is not indexed');
  // Read from the five-minute step at or before `from`, then cut at `from`: the newest `limit` of a
  // longer window, cut, are still the newest of the shorter one.
  const from5 = q.from === undefined ? undefined : Math.floor(q.from / FROM_STEP_MS) * FROM_STEP_MS;
  const q5 = { ...q, from: from5 };
  const key = `${venue}|${address}|${from5 ?? ''}|${q.to ?? ''}|${q.limit}`;
  let k = kept.get(key);
  if (!k || now - k.at >= WALLET_FILLS_TTL_MS || k.span.lo !== span.lo || k.span.hi > span.hi) {
    k = { at: now, span, body: answer(store, venue, address, q5, span) };
  } else if (k.span.hi < span.hi) {
    k = { at: k.at, span, body: moveUp(store, venue, address, q5, k.body, k.span, span) };
  }
  if (kept.get(key) !== k) {
    kept.delete(key);
    if (kept.size >= CACHE_MAX) kept.delete(kept.keys().next().value!);
    kept.set(key, k);
    // A read that failed is not kept.
    const mine = k;
    mine.body.catch(() => { if (kept.get(key) === mine) kept.delete(key); });
  }
  const body = await k.body;
  if (q.from === undefined || q.from === from5) return body;
  // The shorter window can be complete when the rounded one was not (it starts inside the held span): decide on the real `from`.
  if (!body.covered) return answer(store, venue, address, q, span);
  const fromT = q.from;
  return { ...body, fills: body.fills.filter((f) => f.time >= fromT) };
}

/** Forget every kept answer (tests). */
export function clearWalletFills(): void {
  kept.clear();
}
