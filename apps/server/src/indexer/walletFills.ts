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
 * REST ROWS ONLY. A held span can hold public-stream prints (src 0): after the
 * last REST read (the stream moves to_t up) and, on Hyperliquid, left beside
 * the REST fill of the same order (the REST row is aggregated, so its id is not
 * the print's and the drop missed them - production 2026-11-07: 127 of 2,600
 * fill times of one leader, all on xyz: markets, counted twice; the stream rows
 * carry no fee or closed PnL either). So the answer ends before the OLDEST
 * stream row it meets: `heldTo` is the millisecond before it, every row given
 * is a REST row, and the venue answers the rest in the browser. Met before any
 * REST row could be given: not covered.
 *
 * Reads: the coverage rows and the frozen-day bound (primary-key lookups), and
 * one backwards walk of fills_t bounded by `limit`, in slices, kept as one
 * answer per (venue, address, limit) and topped up as the held span grows
 * (THE KEPT ANSWERS below).
 */
import { setImmediate as nextTurn } from 'node:timers/promises';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Venue, VsFill } from '../valuedesk/types.js';
import { reader } from './reader.js';
import type { HistoryKind, IndexStore, WalletFillRow } from './store.js';

const DAY_MS = 86_400_000;
export const WALLET_FILLS_TTL_MS = 5 * 60_000;
/** The most fills one answer carries (the Copy page asks 5,000); a larger ask is left to the venue. */
export const WALLET_FILLS_MAX = 10_000;
const CACHE_MAX = 2_000;
/** Rows per synchronous read (about 150 ms when none is in the page cache). */
const SLICE = 250;

export type WalletFillsBody =
  | { ok: true; covered: false; reason: string }
  | { ok: true; covered: true; heldTo: number; fills: VsFill[]; positions?: Array<{ symbol: string; side: 'long' | 'short'; size: number }> };

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
async function readRows(store: IndexStore, venue: Venue, address: string, lower: number, upper: number, limit: number): Promise<{ rows: WalletFillRow[]; cut: number | null }> {
  let out: WalletFillRow[] = [];
  // The oldest stream row met (REST ROWS ONLY): nothing at or after it is given.
  let cut: number | null = null;
  if (upper < lower) return { rows: out, cut };
  let at: { t: number; id: string } | null = null;
  // THE NEWEST STREAM ROWS (2026-11-07): the stream's rows newer than every REST row are the only copies of those
  // fills (no REST row beside them to double), and the held span reaches over them only while the stream ran without
  // a break (the engine's advanceCoverage). They are given: without them every answer stopped at the wallet's last
  // REST read and the browser walked the venue from there (median 19 h on the board wallets, 20-30 s per replay).
  // They carry no fee (the replay prices the taker rate instead) and no closed PnL.
  let restSeen = false;
  while (out.length < limit) {
    const n = SLICE;
    const got: WalletFillRow[] = at ? store.walletFillRows(venue, address, lower, at.t, n, at.id) : store.walletFillRows(venue, address, lower, upper, n);
    for (const r of got) {
      if (Number(r.src) === 1) restSeen = true;
      else if (!restSeen) {
        if (cut === null && out.length < limit) out.push(r);
        continue;
      }
      if (Number(r.src) !== 1) {
        // Newest first: every row kept so far is at or after this one.
        cut = r.t;
        out = [];
      } else if (cut === null || r.t < cut) {
        if (out.length < limit) out.push(r);
      }
    }
    if (got.length < n) break;
    const last = got[got.length - 1]!;
    at = { t: last.t, id: String(last.id) };
    await nextTurn();
  }
  return { rows: out, cut };
}

async function answer(store: IndexStore, venue: Venue, address: string, q: WalletFillsQuery, span: Span): Promise<WalletFillsBody> {
  const from = q.from ?? 0;
  const lower = Math.max(from, span.lo);
  const { rows, cut } = await readRows(store, venue, address, lower, Math.min(q.to ?? Number.POSITIVE_INFINITY, span.hi), q.limit);
  const heldTo = cut === null ? span.hi : cut - 1;
  // No REST row below the stream row: nothing the venue's REST answer vouches for.
  if (heldTo < lower || (cut !== null && !rows.length)) return notCovered('the index holds stream prints here that the venue\'s REST answer has not replaced');
  // The window starts before the held span: only complete if the newest `limit` fills all fall inside it.
  if (from < span.lo && rows.length < q.limit) return notCovered('the index holds this wallet from a later time');
  return { ok: true, covered: true, heldTo, fills: rows.map(rowToFill) };
}

type Span = { lo: number; hi: number };

/*
 * THE KEPT ANSWERS (2026-11-07, owner: "focus on fixing loading times for copy trading charts and expected pnl charts
 * first. sub second"). Kept per (venue, address, from rounded to five minutes), the copy setup's `from` (now - 30 days)
 * moved on every five minutes, so nearly every open read 5,000 rows again: 1-7 s each on production, 31 s with eight
 * at once. Now ONE answer per (venue, address, limit) over the last NEWEST_SPAN_MS of the held span, kept as one JSON
 * string of its fills (newest first) with each fill's time and end offset: any `from` inside it is a prefix of that
 * string, nothing parsed or serialized again. When the held span grows, only the rows after it are read and put in
 * front; every REBUILD_MS the answer is read whole again in the background (a REST read may have replaced stream rows).
 * Saved to disk every SAVE_EVERY_MS (one file per answer, warmCopyFills' directory) and read back on first use after a
 * start, then topped up: a release does not start every copy setup cold.
 * The answers held stay under KEEP_BYTES, least recently used out first; the copy leaders are kept warm (warmCopyFills).
 * The JSON is held as a Buffer, outside the JavaScript heap: ~1,200 leaders at up to ~0.9 MB each would otherwise be
 * hundreds of MB the collector walks and counts against the heap limit (its pauses held this thread 8-10 s on 2026-11-07).
 */
const NEWEST_SPAN_MS = 31 * DAY_MS;
/** Read whole again this often (a top-up keeps it current between): ~1,200 warm leaders, so not more. */
export const REBUILD_MS = 60 * 60_000;
const KEEP_BYTES = 700 * 1024 * 1024;

interface Newest {
  at: number;
  span: Span;
  lower: number;
  covered: boolean;
  reason: string;
  heldTo: number;
  /** The fills' JSON objects, newest first, comma-joined (UTF-8). */
  json: Buffer;
  times: Float64Array;
  ends: Uint32Array;
  bytes: number;
  /** The wallet's positions at `heldTo` as a JSON array (positionsAt), or null when the index cannot say them. */
  positions: string | null;
  positionsAt: number | null;
}

/*
 * THE POSITIONS AT THE ANSWER'S END (2026-11-07): the replay recovers each fill's position-before from where the trader
 * stands at the end of its fills, and waited for the venue's profile for that (about 1.5 s from a browser to
 * Hyperliquid). The index has the wallet's book (cohort_book: its positions when it was read) and every fill since:
 * the book plus the net of the fills between its time and `heldTo` is the position at `heldTo`, consistent with the
 * fills given by construction. Only when every book's time lies inside the held span (the fills between are then all
 * held); otherwise null and the browser waits for the venue as before. On Hyperliquid the xyz: dex has its own book
 * (venue tradexyz). The browser runs the replay on these at once and again on the venue's when that arrives.
 */
const XYZ = 'xyz:';
export function positionsAt(store: IndexStore, venue: Venue, address: string, at: number, span: Span): Array<{ symbol: string; side: 'long' | 'short'; size: number }> | null {
  const books: Array<{ dex: 'main' | 'xyz'; book: ReturnType<IndexStore['cohortBook']> }> = venue === 'hyperliquid'
    ? [{ dex: 'main', book: store.cohortBook('hyperliquid', address) }, { dex: 'xyz', book: store.cohortBook('tradexyz', address) }]
    : venue === 'sodex' ? [{ dex: 'main', book: store.cohortBook('sodex', address) }] : [];
  if (!books.length || !books[0]!.book) return null;
  const size = new Map<string, number>();
  for (const { dex, book } of books) {
    if (!book) continue;
    if (book.at < span.lo || book.at > span.hi) return null;
    const mine = (sym: string) => (venue !== 'hyperliquid' ? true : dex === 'xyz' ? sym.startsWith(XYZ) : !sym.startsWith(XYZ));
    for (const p of book.positions) {
      const sym = dex === 'xyz' && !p.symbol.startsWith(XYZ) ? XYZ + p.symbol : p.symbol;
      if (mine(sym)) size.set(sym, (size.get(sym) ?? 0) + p.szi);
    }
    const sign = at >= book.at ? 1 : -1;
    for (const r of store.fillsNetBySymbol(venue, address, Math.min(book.at, at), Math.max(book.at, at))) {
      if (mine(r.symbol)) size.set(r.symbol, (size.get(r.symbol) ?? 0) + sign * r.net);
    }
  }
  const out: Array<{ symbol: string; side: 'long' | 'short'; size: number }> = [];
  for (const [symbol, v] of size) {
    const abs = Math.abs(v);
    if (abs > 1e-9 * Math.max(1, abs)) out.push({ symbol, side: v > 0 ? 'long' : 'short', size: +abs.toPrecision(12) });
  }
  return out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}

function withPositions(store: IndexStore, venue: Venue, address: string, n: Newest): Newest {
  if (!n.covered || n.positionsAt === n.heldTo) return n;
  let p: ReturnType<typeof positionsAt> = null;
  try { p = positionsAt(store, venue, address, n.heldTo, n.span); } catch { p = null; }
  const positions = p ? JSON.stringify(p) : null;
  return { ...n, positions, positionsAt: n.heldTo, bytes: n.bytes - (n.positions?.length ?? 0) + (positions?.length ?? 0) };
}

const newest = new Map<string, Newest>();
const building = new Map<string, Promise<Newest>>();
let keptBytes = 0;

function pack(rows: readonly WalletFillRow[]): { json: Buffer; times: Float64Array; ends: Uint32Array } {
  const parts = rows.map((r) => JSON.stringify(rowToFill(r)));
  const times = new Float64Array(rows.length);
  const ends = new Uint32Array(rows.length);
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    at += (i ? 1 : 0) + Buffer.byteLength(parts[i]!, 'utf8');
    times[i] = rows[i]!.t;
    ends[i] = at;
  }
  return { json: Buffer.from(parts.join(','), 'utf8'), times, ends };
}

function keep(key: string, n: Newest): Newest {
  const was = newest.get(key);
  if (was) { keptBytes -= was.bytes; newest.delete(key); }
  newest.set(key, n);
  keptBytes += n.bytes;
  for (const [k, v] of newest) {
    if (keptBytes <= KEEP_BYTES || k === key) break;
    newest.delete(k);
    keptBytes -= v.bytes;
  }
  return n;
}

async function buildNewest(store: IndexStore, venue: Venue, address: string, limit: number, span: Span, now: number): Promise<Newest> {
  const lower = Math.max(span.lo, now - NEWEST_SPAN_MS);
  const { rows, cut } = await readRows(store, venue, address, lower, span.hi, limit);
  const heldTo = cut === null ? span.hi : cut - 1;
  const bad = heldTo < lower || (cut !== null && !rows.length);
  const p = pack(bad ? [] : rows);
  return { at: now, span, lower, covered: !bad, reason: bad ? 'the index holds stream prints here that the venue\'s REST answer has not replaced' : '', heldTo, ...p, bytes: p.json.length + p.times.byteLength + p.ends.byteLength + 64, positions: null, positionsAt: null };
}

/** A kept answer brought up to a held span that grew at its end: the new rows in front (a stream cut among them: read whole). */
async function topUp(store: IndexStore, venue: Venue, address: string, limit: number, n: Newest, span: Span, now: number): Promise<Newest> {
  if (!n.covered || n.heldTo < n.span.hi) return { ...n, span };
  const { rows, cut } = await readRows(store, venue, address, n.span.hi + 1, span.hi, limit);
  if (cut !== null) return buildNewest(store, venue, address, limit, span, now);
  if (!rows.length) return { ...n, span, heldTo: span.hi };
  const add = pack(rows);
  const total = Math.min(limit, rows.length + n.times.length);
  const times = new Float64Array(total);
  const ends = new Uint32Array(total);
  times.set(add.times.subarray(0, total));
  ends.set(add.ends.subarray(0, total));
  const keepOld = total - rows.length;
  const shift = add.json.length + 1;
  for (let i = 0; i < keepOld; i++) {
    times[rows.length + i] = n.times[i]!;
    ends[rows.length + i] = n.ends[i]! + shift;
  }
  const json = keepOld > 0 ? Buffer.concat([add.json, COMMA, n.json.subarray(0, n.ends[keepOld - 1]!)]) : Buffer.from(add.json.subarray(0, ends[total - 1]!));
  return { ...n, span, heldTo: span.hi, json, times, ends, bytes: json.length + times.byteLength + ends.byteLength + 64 };
}

/* --- on disk ------------------------------------------------------------------------------- */

const FILE_V = 1;
export const SAVE_EVERY_MS = 60 * 60_000;
let saveDir: string | null = null;
const triedLoad = new Set<string>();
const savedAt = new Map<string, number>();
const fileOf = (key: string) => join(saveDir!, `${key.replace(/[^0-9a-zA-Z]+/g, '-')}.bin`);

/** [u32 header length][header JSON][times f64][ends u32][fills JSON]. */
async function saveOne(key: string, n: Newest): Promise<void> {
  const { json, times, ends, ...rest } = n;
  const header = Buffer.from(JSON.stringify({ v: FILE_V, key, n: times.length, ...rest }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length, 0);
  const tmp = `${fileOf(key)}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.write(Buffer.concat([len, header, Buffer.from(times.buffer, times.byteOffset, times.byteLength), Buffer.from(ends.buffer, ends.byteOffset, ends.byteLength), json]));
  } finally {
    await fh.close();
  }
  await rename(tmp, fileOf(key));
}

async function loadSaved(key: string): Promise<Newest | null> {
  let b: Buffer;
  try { b = await readFile(fileOf(key)); } catch { return null; }
  if (b.length < 4) return null;
  const hl = b.readUInt32LE(0);
  const h = JSON.parse(b.subarray(4, 4 + hl).toString('utf8')) as Omit<Newest, 'json' | 'times' | 'ends'> & { v: number; key: string; n: number };
  if (h.v !== FILE_V || h.key !== key) return null;
  let at = 4 + hl;
  // Copied out: a typed array needs its own aligned buffer.
  const times = new Float64Array(h.n);
  Buffer.from(times.buffer).set(b.subarray(at, at + h.n * 8));
  at += h.n * 8;
  const ends = new Uint32Array(h.n);
  Buffer.from(ends.buffer).set(b.subarray(at, at + h.n * 4));
  at += h.n * 4;
  const json = Buffer.from(b.subarray(at));
  if (h.n && ends[h.n - 1] !== json.length) return null;
  const { v: _v, key: _k, n: _n, ...rest } = h;
  return { ...rest, json, times, ends };
}

/** Where the answers are saved (warmCopyFills sets it; tests). */
export function setWalletFillsDir(dir: string | null): void {
  saveDir = dir;
}

/** Every kept answer that changed since it was last saved, one at a time. */
export async function saveWalletFills(): Promise<number> {
  if (!saveDir) return 0;
  await mkdir(saveDir, { recursive: true });
  let n = 0;
  for (const [key, a] of [...newest]) {
    if (savedAt.get(key) === a.heldTo) continue;
    try {
      await saveOne(key, a);
      savedAt.set(key, a.heldTo);
      n++;
    } catch { /* the next save tries again */ }
    await nextTurn();
  }
  return n;
}

/** The kept answer for (venue, address, limit), up to the held span now; built or topped up here, read whole again after REBUILD_MS. */
async function newestOf(store: IndexStore, venue: Venue, address: string, limit: number, span: Span, now: number): Promise<Newest> {
  const key = `${venue}|${address}|${limit}`;
  const going = building.get(key);
  if (going) return going;
  let cur = newest.get(key);
  if (!cur && saveDir && !triedLoad.has(key)) {
    triedLoad.add(key);
    const saved = await loadSaved(key).catch(() => null);
    if (saved && !newest.has(key)) cur = keep(key, saved);
    else cur = newest.get(key);
  }
  let job: Promise<Newest>;
  if (!cur || cur.span.lo !== span.lo || cur.span.hi > span.hi || cur.lower < Math.max(span.lo, now - NEWEST_SPAN_MS) - DAY_MS) {
    job = buildNewest(store, venue, address, limit, span, now);
  } else if (now - cur.at >= REBUILD_MS) {
    // Read whole again behind this answer; this one is topped up meanwhile.
    if (!building.has(`${key}|re`)) {
      const re = buildNewest(store, venue, address, limit, span, now).then((n) => keep(key, withPositions(store, venue, address, n)));
      building.set(`${key}|re`, re);
      re.catch(() => {}).finally(() => building.delete(`${key}|re`));
    }
    job = cur.span.hi < span.hi ? topUp(store, venue, address, limit, cur, span, now) : Promise.resolve(cur);
  } else if (cur.span.hi < span.hi) {
    job = topUp(store, venue, address, limit, cur, span, now);
  } else {
    newest.delete(key);
    newest.set(key, cur); // most recently used
    return cur;
  }
  const kept = job.then((n) => keep(key, withPositions(store, venue, address, n)));
  building.set(key, kept);
  try {
    return await kept;
  } finally {
    building.delete(key);
  }
}

/** The number of kept fills at or after `from` (times newest first). */
function countFrom(times: Float64Array, from: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! >= from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const COMMA = Buffer.from(',');
const TAIL = Buffer.from(']}');
const coveredJson = (heldTo: number, fills: Buffer, positions: string | null = null): Buffer =>
  Buffer.concat([Buffer.from(`{"ok":true,"covered":true,"heldTo":${heldTo},${positions ? `"positions":${positions},` : ''}"fills":[`), fills, TAIL]);

/** The route's answer as the JSON text it sends: from the kept answer when it can say it, else read as before. */
export async function walletFillsJson(venue: Venue, address: string, q: WalletFillsQuery, now = Date.now(), store: IndexStore | null = reader()): Promise<string | Buffer> {
  if (q.limit > WALLET_FILLS_MAX) return JSON.stringify(notCovered('more fills than the index answers at once'));
  if (!store) return JSON.stringify(notCovered('the index is not open yet'));
  const span = heldSpan(store, venue, address);
  if (!span) return JSON.stringify(notCovered('this wallet is not indexed'));
  const from = q.from ?? 0;
  if (q.to === undefined) {
    const n = await newestOf(store, venue, address, q.limit, span, now);
    // The window starts before the held span: complete only when the newest `limit` fills all fall inside it.
    if (from < n.lower) {
      if (n.covered && n.heldTo === span.hi && n.times.length === q.limit) return coveredJson(n.heldTo, n.json, n.positions);
      if (from < span.lo && n.lower === span.lo) return JSON.stringify(n.covered ? notCovered('the index holds this wallet from a later time') : notCovered(n.reason));
    } else {
      // Cut at an old stream row, the window may start after it: read as before (exact), not refused.
      if (n.covered && from <= n.heldTo) {
        const k = countFrom(n.times, from);
        return coveredJson(n.heldTo, k ? n.json.subarray(0, n.ends[k - 1]!) : Buffer.alloc(0), n.positions);
      }
    }
  }
  // A window the kept answer does not reach (an upper bound, or older than its span): read as before.
  return JSON.stringify(await answer(store, venue, address, q, span));
}

/** The same answer as an object (tests, and callers that want one). */
export async function walletFills(venue: Venue, address: string, q: WalletFillsQuery, now = Date.now(), store: IndexStore | null = reader()): Promise<WalletFillsBody> {
  return JSON.parse(String(await walletFillsJson(venue, address, q, now, store))) as WalletFillsBody;
}

/** How much the kept answers hold (the health answer). */
export function walletFillsKept(): { wallets: number; bytes: number } {
  return { wallets: newest.size, bytes: keptBytes };
}

/**
 * The copy leaders' answers kept warm: every WARM_EVERY_MS each is brought up to its held span (a top-up: the rows since
 * the last pass), so a copy setup's first open reads nothing. One wallet at a time, the reads in slices as any answer's.
 */
export const WARM_EVERY_MS = 2 * 60_000;
export function warmCopyFills(leaders: () => Array<{ venue: Venue; address: string }>, limit: number, dir: string | null = null): () => void {
  saveDir = dir;
  let stopped = false;
  let lastSave = Date.now();
  let timer: NodeJS.Timeout | null = null;
  const pass = async () => {
    const store = reader();
    if (store) {
      const seen = new Set<string>();
      for (const l of leaders()) {
        if (stopped) return;
        const key = `${l.venue}|${l.address}`;
        if (seen.has(key) || !FILL_KINDS[l.venue]) continue;
        seen.add(key);
        try {
          const span = heldSpan(store, l.venue, l.address);
          if (span) await newestOf(store, l.venue, l.address, limit, span, Date.now());
        } catch { /* the next pass tries again */ }
        await nextTurn();
      }
    }
    if (Date.now() - lastSave >= SAVE_EVERY_MS) {
      lastSave = Date.now();
      await saveWalletFills().catch(() => 0);
    }
  };
  const next = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => { void pass().finally(() => next(WARM_EVERY_MS)); }, ms);
    timer.unref?.();
  };
  next(20_000);
  return () => { stopped = true; if (timer) clearTimeout(timer); void saveWalletFills().catch(() => 0); };
}

/** Addresses one /api/vs/last-trades read takes (a page of copy cards is 24). */
export const LAST_TRADES_MAX = 50;
const LAST_TTL_MS = 60_000;
const lastKept = new Map<string, { at: number; t: number | null }>();

/**
 * When each wallet's newest fill in the index happened (GET /api/vs/last-trades), Hyperliquid only: a
 * HINT for the copy cards, never shown as such. The card asks Hyperliquid for the fills since then and
 * shows the newest of those (hyperliquid/trader.ts hlPeek) - one small read where it walked up to eight
 * windows - so a stale or wrong hint costs the old walk, not a wrong figure. One step down fills_t per
 * wallet, kept a minute.
 */
export function lastTrades(venue: Venue, addresses: readonly string[], now = Date.now(), store: IndexStore | null = reader()): Record<string, number> {
  const out: Record<string, number> = {};
  if (!store || venue !== 'hyperliquid') return out;
  for (const a of addresses.slice(0, LAST_TRADES_MAX)) {
    const key = `${venue}|${a}`;
    let k = lastKept.get(key);
    if (!k || now - k.at >= LAST_TTL_MS) {
      k = { at: now, t: store.newestRowT(venue, a) };
      if (lastKept.size >= CACHE_MAX) lastKept.delete(lastKept.keys().next().value!);
      lastKept.set(key, k);
    }
    if (k.t !== null) out[a] = k.t;
  }
  return out;
}

/** Forget every kept answer (tests). */
export function clearWalletFills(): void {
  newest.clear();
  triedLoad.clear();
  savedAt.clear();
  building.clear();
  keptBytes = 0;
  lastKept.clear();
}
