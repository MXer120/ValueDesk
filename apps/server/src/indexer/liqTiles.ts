/**
 * THE HISTORICAL HEATMAP IN TILES (owner 2026-11-01: "the historical map is taking very long to
 * load. Each snapshot should be split into price levels or something. So only what the user sees
 * gets loaded and only when he moves or zooms in/out new gets loaded").
 *
 * Measured on production before (2026-11-01, through www.valuedesk.so): the view read 30 days in
 * one answer - BTC 8.3 MB of JSON, 3.0 MB brotli, 2.9 s cold (ETH 19 s), and again every five
 * minutes - and while the API parsed those 600 snapshots (45 MB of JSON) on its one thread, every
 * other request waited: a 0.17 s read took 1.95 s beside one cold HYPE history. 70% of BTC's rows
 * lie more than 20% from the price, while the view's price axis follows the candles, a few percent.
 *
 * So the view reads:
 *   the INDEX   every snapshot's time, price and step over RANGE_MS, and the colour scale the view
 *               draws with (web liqHeatIndicator.ts heatScale over those 30 days, for each side and
 *               leverage filter it offers) - a few KB;
 *   TILES       the rows of the snapshots in one time slot and one price band. Slots of 6 h, 1 d or
 *               4 d (tileMs: level `tl`), bands of bw, 4bw, 16bw or 64bw (bandSpan: level `pl`),
 *               bw a round width near 8% of the price (bandWidth). The view asks for the tiles on
 *               screen and those beside them, at the levels that keep them few.
 * A tile holds each snapshot's exact rows - the sums liqRead.ts liqHistory sends (snapRows) - whose
 * low edge falls in its band: nothing summed coarser, nothing left out. Every wallet only: the
 * wallet filter's history is rebuilt from the change log per request (liqHistory).
 *
 * WHAT A VIEW DRAWS ONLY (perf pass 2026-11-17, phones on slow links). A tile may be asked cut to it,
 * the same numbers where it draws:
 *   fields=ls   rows of [bucket, long USD, short USD]: a view by side with every leverage band reads
 *               nothing else of a row (web liqHeatIndicator.ts cellOf). BTC's 1-day band at the price
 *               42.1 KB -> 21.3 KB br5;
 *   every off   the newest snapshot of each bar of `every` ms starting at `off` modulo it - the one the
 *               chart draws for that bar (web snapshotFor; liqRead.ts FineDraw, the fine tiles' rule).
 *               A 1 h chart: a quarter of the snapshots, a 4 h one a sixteenth;
 *   at          one snapshot: the slot still filling as single snapshots, each final once it exists
 *               (kept a day, shared by every viewer) instead of the whole slot again per snapshot.
 * An ask without them is answered as before.
 *
 * NOT DONE, ON PURPOSE: a binary codec (delta + varint, with or without differencing against the snapshot before).
 * Measured 2026-11-17 on the laptop's BTC index: the one-piece /liquidations/history?range=1d (1.43 MB br5 on production;
 * read by the web only while this route answers 404) is 4.2% rows within 5% of the price - its bytes are rows no view
 * draws, not JSON overhead - and the codec takes -11% after brotli 11 there and -4% on the tiles, against -49% for
 * fields=ls and -72% / -91% for one snapshot per 1 h / 4 h bar above, all exact. Brotli on JSON is kept.
 *
 * CACHING. A slot a newer snapshot has passed is final and kept a day by the edge and the browser
 * (thinning past 3 days later drops some of its snapshots; a copy already made keeps them - real
 * snapshots either way). The slot still filling is asked with `v=` its newest snapshot: a new
 * snapshot is a new URL, and every URL keeps one answer. The index moves with each snapshot
 * (every 15 min) and is kept a minute.
 *
 * THE API THREAD. A snapshot's meta - time, price, step, the venues with rows (`vm`) and per-filter
 * scales - is worked out on the snapshot reader's thread (liqReadThread.ts) once per venue set, kept for as
 * long as it is listed, and in a file across restarts (metasPath): the first index after the
 * 2026-11-01 release took 7.1 s, every snapshot of 30 days parsed again for its scales. A venue with
 * no row in a snapshot adds nothing to it, so a set is kept as the venues of it the snapshot holds
 * (presentVenues): BTC has no trade.xyz rows, and every set with and without it is one. A tile's rows
 * are cut there too (tileRowsOf), kept parsed in a LRU of MAX_ROWS rows on that thread: this one only
 * gets the band's rows.
 *
 * A COLD SET (2026-11-17: `venues=sodex,hyperliquid` on BTC answered 504 after 30 s three times over -
 * each ask 10 s apart began its own walk, the walks read the same snapshots in lockstep). One walk per
 * set: a later ask joins it, a finished index is kept INDEX_MEMO_MS, and the walks of two sets wait on
 * each other's reads of one snapshot. A set asked is warmed with the full one from then on (asked),
 * and an index not ready in INDEX_BUDGET_MS is answered with how far it is (the route: 'building').
 */
import { mark } from './busy.js';
import { readFileSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as pause } from 'node:timers/promises';
import { dataDir } from '../builder/paths.js';
import { VENUES, type Venue } from '../valuedesk/types.js';
import { LEV_BANDS, type LevBand } from '../valuedesk/liquidations/math.js';
import { snapBand, trimRow, type LiqSnap, type SnapRow } from '../valuedesk/liquidations/levels.js';
import type { LiqHistory } from './liqRead.js';
import { liqJob } from './liqHistThread.js';
import { liqRead, resetLiqReadThread, setMetaOf, setTileRowsOf, type MetaWire, type SnapReader, type TileRowsAsk, type TileRowsWire } from './liqReadThread.js';
import { reader } from './reader.js';

/** The history the index lists (the view's 30 days). */
export const RANGE_MS = 30 * 86_400_000;
/** A level-0 time slot. Level `tl` is 4^tl of them: 6 h, 1 d, 4 d. */
export const SLOT_MS = 6 * 3_600_000;
export const T_LEVELS = 3;
/** Price bands: level `pl` is 4^pl level-0 bands. */
export const P_LEVELS = 4;
/** A level-0 band is about this share of the price, rounded down to 1, 2 or 5 x 10^n. */
export const BAND_SHARE = 0.08;

export const tileMs = (tl: number): number => SLOT_MS * 4 ** tl;
export const bandSpan = (bw: number, pl: number): number => +(bw * 4 ** pl).toPrecision(12);

/** Cache-Control: the index and a slot still filling (one snapshot every 15 minutes). */
export const TILE_INDEX_CACHE = 'public, max-age=60, stale-while-revalidate=120';
/** Cache-Control: a final tile (its slot passed, or asked up to a snapshot that exists). */
export const TILE_FINAL_CACHE = 'public, max-age=86400, stale-while-revalidate=86400';
/** Cache-Control: the index and tiles of some wallets (rebuilt from the change log; a snapshot every 15 minutes). */
export const TILE_WALLET_CACHE = 'public, max-age=300, stale-while-revalidate=300';

/**
 * The level-0 band width for a price: the largest 1, 2 or 5 x 10^n at most BAND_SHARE of it (BTC
 * at $78K: $5,000). A multiple of every snapshot step (math.ts niceStep: 1, 2, 2.5, 5 x 10^n, about
 * 0.125-0.25% of the price), so no cell straddles two bands. 0: no price.
 */
export function bandWidth(p: number): number {
  if (!(p > 0) || !Number.isFinite(p)) return 0;
  const raw = p * BAND_SHARE;
  const e = Math.floor(Math.log10(raw));
  const base = 10 ** e;
  const f = raw / base;
  return +((f >= 5 ? 5 : f >= 2 ? 2 : 1) * base).toPrecision(12);
}

/** Is `bw` a width bandWidth could give (1, 2 or 5 x 10^n)? */
export function isBandWidth(bw: number): boolean {
  if (!(bw > 0) || !Number.isFinite(bw)) return false;
  const f = +(bw / 10 ** Math.floor(Math.log10(bw))).toPrecision(9);
  return f === 1 || f === 2 || f === 5;
}

/** The band (at width `span`) of bucket `i` of step `st`: by its low edge, exactly when `span` is a whole number of steps. */
export function bandOf(i: number, st: number, span: number): number {
  const m = span / st;
  const k = Math.round(m);
  return k >= 1 && Math.abs(m - k) < 1e-9 * m ? Math.floor(i / k) : Math.floor((i * st) / span + 1e-9);
}

/**
 * A snapshot's rows summed over `venues`, exactly as liqRead.ts liqHistory sums them (a test holds
 * the two equal): a level the price had crossed when it was taken is left out, the bands added
 * field by field, trailing zeros off.
 */
export function snapRows(snap: LiqSnap, venues: readonly Venue[]): SnapRow[] {
  const sum = new Map<number, SnapRow>();
  for (const v of venues) {
    for (const r of snap.v[v] ?? []) {
      const i = r[0];
      const keepL = i * snap.st < snap.p;
      const keepS = (i + 1) * snap.st > snap.p;
      const l = keepL ? r[1] : 0;
      const sh = keepS ? r[2] : 0;
      if (!l && !sh) continue;
      const b = sum.get(i) ?? [i, 0, 0, 0, 0, 0, 0, 0, 0];
      b[1] += l;
      b[2] += sh;
      for (const band of LEV_BANDS) {
        if (keepL) b[snapBand(true, band)]! += r[snapBand(true, band)] ?? 0;
        if (keepS) b[snapBand(false, band)]! += r[snapBand(false, band)] ?? 0;
      }
      sum.set(i, b);
    }
  }
  return [...sum.values()].sort((a, b) => a[0] - b[0]).map((b) => trimRow(b, 3));
}

/** The venues of a snapshot that hold a row, a bit per types.ts VENUES (bit i: VENUES[i]). */
export function venueMask(snap: LiqSnap): number {
  let m = 0;
  for (let i = 0; i < VENUES.length; i++) if ((snap.v[VENUES[i]!]?.length ?? 0) > 0) m |= 1 << i;
  return m;
}

/**
 * The venues of `venues` a snapshot of mask `vm` holds rows of, in VENUES order (vm -1: not known, every one kept).
 * Exact for every sum: a venue without a row adds nothing to any (snapRows), and the rows are whole dollars (levels.ts
 * snapOfNow sums rounded LiqNow rows), so the order they are added in does not matter either.
 */
export function presentVenues(venues: readonly Venue[], vm: number): Venue[] {
  return VENUES.filter((v, i) => venues.includes(v) && (vm < 0 || (vm & (1 << i)) !== 0));
}

const isEveryVenue = (venues: readonly Venue[]): boolean => VENUES.every((v) => venues.includes(v));

// --- the colour scales ---------------------------------------------------------------------

export type ScaleSide = 'both' | 'long' | 'short';
const LEV_NAMES = ['low', 'mid', 'high'] as const;
/** The leverage filters the view offers: null is every band (no filter), else the bands named. */
const LEV_SETS: ReadonlyArray<readonly LevBand[] | null> = [null, [0], [1], [2], [0, 1], [0, 2], [1, 2]];
const SIDES: readonly ScaleSide[] = ['both', 'long', 'short'];

/** A filter's key in the index's `scale`: `both|all`, `long|low,high` (web: liqTileKey). */
export const scaleKey = (side: ScaleSide, set: readonly LevBand[] | null): string =>
  `${side}|${set ? set.map((b) => LEV_NAMES[b]).join(',') : 'all'}`;

const COMBOS = SIDES.flatMap((side) => LEV_SETS.map((set) => ({ side, set, key: scaleKey(side, set) })));

/** A cell's notional under a filter (web liqHeatIndicator.ts cellOf().v). */
function cellV(r: SnapRow, side: ScaleSide, set: readonly LevBand[] | null): number {
  const useL = side !== 'short' && r[1] > 0;
  const useS = side !== 'long' && r[2] > 0;
  if (!set) return (useL ? r[1] : 0) + (useS ? r[2] : 0);
  let v = 0;
  for (const b of set) {
    if (useL) v += r[3 + b] ?? 0;
    if (useS) v += r[6 + b] ?? 0;
  }
  return v;
}

/** web liqLev.ts robustMax at the heat scale's settings (q 0.95, ratio 3, keep 2): the reference, by a sort. */
export function robustMax95(values: number[]): number {
  return robustOfSorted(values.filter((x) => x > 0 && Number.isFinite(x)).sort((a, b) => a - b));
}

/** robustMax95 of values above 0, ascending. */
function robustOfSorted(v: ArrayLike<number>): number {
  const n = v.length;
  if (!n) return 0;
  if (n < 5) return v[n - 1]!;
  const ref = v[Math.max(0, Math.min(Math.floor((n - 1) * 0.95), n - 1 - 2))]!;
  for (let i = n - 1; i >= 0; i--) if (v[i]! <= ref * 3) return v[i]!;
  return ref;
}

/**
 * The k-th smallest (0-based) of v[0..n), v reordered in place: selection with a three-way split around a median of
 * three, so a run of equal values (many cells hold the same round sum) stays linear.
 */
function selectK(v: Float64Array, n: number, k: number): number {
  let lo = 0;
  let hi = n - 1;
  while (hi > lo) {
    const a = v[lo]!;
    const b = v[(lo + hi) >>> 1]!;
    const c = v[hi]!;
    const pivot = a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b;
    let lt = lo;
    let i = lo;
    let gt = hi;
    while (i <= gt) {
      const x = v[i]!;
      if (x < pivot) { v[i] = v[lt]!; v[lt] = x; lt++; i++; }
      else if (x > pivot) { v[i] = v[gt]!; v[gt] = x; gt--; }
      else i++;
    }
    if (k < lt) hi = lt - 1;
    else if (k > gt) lo = gt + 1;
    else return pivot;
  }
  return v[lo]!;
}

/**
 * robustMax95 of the n values above 0 in v (any order, reordered): the same element robustOfSorted reads off the sorted
 * values - the 95th-percentile one by selection, then the largest within 3x of it in one pass - without the sort, which
 * was most of a cold meta (measured 2026-11-17: 0.23 ms against 0.76 ms per BTC snapshot, all 15,498 values equal).
 */
export function robustMaxOf(v: Float64Array, n: number): number {
  if (!n) return 0;
  if (n < 5) {
    let m = v[0]!;
    for (let i = 1; i < n; i++) if (v[i]! > m) m = v[i]!;
    return m;
  }
  const ref = selectK(v, n, Math.max(0, Math.min(Math.floor((n - 1) * 0.95), n - 1 - 2)));
  const lim = ref * 3;
  let best = ref;
  for (let i = 0; i < n; i++) { const x = v[i]!; if (x <= lim && x > best) best = x; }
  return best;
}

/** A snapshot's own robust scale per filter, at its own step (COMBOS order). */
export function snapScales(rows: readonly SnapRow[]): Float64Array {
  const out = new Float64Array(COMBOS.length);
  // One buffer, no comparator: an array mapped, filtered and sorted with a comparator for each of the 21 filters was
  // most of a coin's first read (production 2026-11-05: XRP's first index 8.2 s).
  if (scaleBuf.length < rows.length) scaleBuf = new Float64Array(rows.length * 2);
  for (let k = 0; k < COMBOS.length; k++) {
    const { side, set } = COMBOS[k]!;
    let m = 0;
    for (const r of rows) {
      const x = cellV(r, side, set);
      if (x > 0 && Number.isFinite(x)) scaleBuf[m++] = x;
    }
    out[k] = robustMaxOf(scaleBuf, m);
  }
  return out;
}
let scaleBuf = new Float64Array(4096);

/**
 * web heatScale per filter: each snapshot's robust scale read per the newest snapshot's step
 * (stepNorm), the median over the snapshots; 1 when none has a cell.
 */
export function histScales(snaps: ReadonlyArray<{ st: number; sc: Float64Array }>): Record<string, number> {
  const ref = snaps.at(-1)?.st ?? null;
  const out: Record<string, number> = {};
  COMBOS.forEach((c, k) => {
    const per: number[] = [];
    for (const q of snaps) {
      const s = q.sc[k]! * (ref && q.st > 0 ? ref / q.st : 1);
      if (s > 0) per.push(s);
    }
    per.sort((a, b) => a - b);
    out[c.key] = per[per.length >> 1] || 1;
  });
  return out;
}

// --- the snapshots' metas ------------------------------------------------------------------

/** A snapshot's meta: time, data length, price, step, its scales over one venue set, and its venues with rows (-1: not known). */
interface Meta { t: number; n: number; p: number; st: number; sc: Float64Array; vm: number }

/** Work this long between two turns of the loop given back. */
const YIELD_MS = 8;
/** The background read (warmLiqMetas): this long of rest after each YIELD_MS of work, a quarter of the thread at most. */
const WARM_REST_MS = 24;
/** Snapshot metas kept per coin and venue set (30 days at 15 minutes is 2,880). */
const MAX_METAS = 4_000;

/** coin|venues (the venues a snapshot holds of the set asked, presentVenues) -> time -> meta. */
const metas = new Map<string, Map<number, Meta>>();
/** The keys of `metas` per coin (a coin's sets are trimmed together). */
const vksOf = new Map<string, Set<string>>();
/** Per coin, each snapshot's data length and venues with rows, once read for any set. */
const presence = new Map<string, Map<number, { n: number; vm: number }>>();

const venueKey = (coin: string, venues: readonly Venue[]): string => `${coin}|${[...venues].sort().join(',')}`;
const coinOfKey = (vk: string): string => vk.slice(0, vk.indexOf('|'));

/** A snapshot's meta over `venues`, when held and its data unchanged. */
function heldMeta(coin: string, venues: readonly Venue[], at: { t: number; n: number }): Meta | undefined {
  const pr = presence.get(coin)?.get(at.t);
  if (pr && pr.n === at.n) {
    const m = metas.get(venueKey(coin, presentVenues(venues, pr.vm)))?.get(at.t);
    if (m && m.n === at.n) return m;
  }
  // A meta whose venues are not known (a file written before them): under the set as asked.
  const m = metas.get(venueKey(coin, venues))?.get(at.t);
  return m && m.n === at.n ? m : undefined;
}

function putMeta(coin: string, venues: readonly Venue[], m: Meta): void {
  const vk = venueKey(coin, presentVenues(venues, m.vm));
  let byT = metas.get(vk);
  if (!byT) { byT = new Map(); metas.set(vk, byT); }
  byT.set(m.t, m);
  let vks = vksOf.get(coin);
  if (!vks) { vks = new Set(); vksOf.set(coin, vks); }
  vks.add(vk);
  if (m.vm >= 0) {
    let pr = presence.get(coin);
    if (!pr) { pr = new Map(); presence.set(coin, pr); }
    pr.set(m.t, { n: m.n, vm: m.vm });
  }
  metasChanged();
}

/**
 * Times and data lengths of a coin's snapshots in [from, to), read on the snapshot reader's thread (liqReadThread.ts):
 * one page per snapshot, seconds from disk, so never on this one.
 */
async function listed(coin: string, from: number, to: number): Promise<Array<{ t: number; n: number }>> {
  return (await liqRead({ op: 'list', coin, from, to }, reader)) ?? [];
}

/**
 * A coin's listed snapshots over the index's reach (RANGE_MS and a widest slot before it, which
 * a tile may start in), kept between asks: an ask lists only from the newest held on (the
 * snapshot being written and any after it: a row or two), and the whole reach again every
 * RELIST_MS (snapshots thinned past 3 days drop out then; a tile skips one gone meanwhile).
 * Listed in full on every ask, it was 3% of the API's thread in the 2026-11-01 profile, in one
 * synchronous statement per ask.
 */
export const RELIST_MS = 10 * 60_000;
const lists = new Map<string, { at: number; from: number; rows: Array<{ t: number; n: number }> }>();

async function listing(coin: string, now: number): Promise<Array<{ t: number; n: number }>> {
  const from = now - RANGE_MS - tileMs(T_LEVELS - 1);
  const held = lists.get(coin);
  const last = held?.rows.at(-1);
  if (held && last && now - held.at < RELIST_MS && from >= held.from) {
    const tail = await listed(coin, last.t, Number.MAX_SAFE_INTEGER);
    const keep = held.rows.filter((x) => x.t >= from && x.t < last.t);
    held.rows = keep.concat(tail);
    return held.rows;
  }
  const rows = await listed(coin, from, Number.MAX_SAFE_INTEGER);
  lists.set(coin, { at: now, from, rows });
  return rows;
}

/** The coins with snapshots, kept a minute. */
const COINS_MS = 60_000;
let coinsHeld: { at: number; coins: string[] } | null = null;
async function coinsOf(now: number): Promise<string[]> {
  if (!coinsHeld || now - coinsHeld.at >= COINS_MS || now < coinsHeld.at) coinsHeld = { at: now, coins: (await liqRead({ op: 'coins' }, reader)) ?? [] };
  return coinsHeld.coins;
}

/**
 * What a snapshot's meta holds besides its time and length, for each venue set of `sets` (null: not JSON): parsed once,
 * each set's scales worked out over the venues of it the snapshot holds (two sets that come to the same, once). Pure:
 * the reader thread runs it.
 */
export function metaOfData(data: string, sets: ReadonlyArray<readonly Venue[]>): MetaWire | null {
  let snap: LiqSnap;
  try { snap = JSON.parse(data) as LiqSnap; } catch { return null; }
  const vm = venueMask(snap);
  const done = new Map<string, Float64Array>();
  const sc = sets.map((venues) => {
    const c = presentVenues(venues, vm);
    const k = c.join(',');
    let x = done.get(k);
    if (!x) { x = snapScales(snapRows(snap, c)); done.set(k, x); }
    return x;
  });
  return { p: snap.p, st: snap.st, vm, sc };
}
setMetaOf(metaOfData);

// --- a tile's rows, cut where the snapshots are read ---------------------------------------

/** Rows kept parsed at most where tiles are cut (~80 bytes each: about 80 MB of the reader thread's 512). BTC's 30 days are ~0.4M per set. */
export const MAX_ROWS = 1_000_000;
const PRESENCE_MAX = 200_000;
const tileLru = new Map<string, { p: number; st: number; rows: SnapRow[] }>();
let tileRowsHeld = 0;
const tilePresence = new Map<string, { n: number; vm: number }>();

function keepTileRows(key: string, h: { p: number; st: number; rows: SnapRow[] }): void {
  const old = tileLru.get(key);
  if (old) { tileLru.delete(key); tileRowsHeld -= old.rows.length; }
  tileLru.set(key, h);
  tileRowsHeld += h.rows.length;
  for (const [k, v] of tileLru) {
    if (tileRowsHeld <= MAX_ROWS) break;
    tileLru.delete(k);
    tileRowsHeld -= v.rows.length;
  }
}

function heldTileRows(key: string): { p: number; st: number; rows: SnapRow[] } | undefined {
  const v = tileLru.get(key);
  if (v) { tileLru.delete(key); tileLru.set(key, v); }
  return v;
}

/**
 * A tile's snapshots as asked (TileRowsAsk), on the thread that reads them: each snapshot's rows over the venues summed
 * (snapRows) and kept, then the band's cut - [bucket, long, short] only when `slim`. Null: gone or not JSON.
 */
export function tileRowsOf(r: TileRowsAsk, read: SnapReader): Array<TileRowsWire | null> {
  const out: Array<TileRowsWire | null> = r.ts.map(() => null);
  const keyOf = (k: number, vm: number) => `${r.coin}|${r.ts[k]}|${r.ns[k]}|${presentVenues(r.venues, vm).join(',')}`;
  const cut = (h: { p: number; st: number; rows: SnapRow[] }): TileRowsWire => {
    const b: SnapRow[] = [];
    for (const row of h.rows) if (bandOf(row[0], h.st, r.span) === r.band) b.push(r.slim ? (row.length > 3 ? row.slice(0, 3) as SnapRow : row) : row);
    return { p: h.p, st: h.st, b };
  };
  const miss: number[] = [];
  r.ts.forEach((t, k) => {
    const pr = tilePresence.get(`${r.coin}|${t}`);
    const h = pr && pr.n === r.ns[k] ? heldTileRows(keyOf(k, pr.vm)) : undefined;
    if (h) out[k] = cut(h);
    else miss.push(k);
  });
  if (!miss.length) return out;
  const datas = read(miss.map((k) => r.ts[k]!), r.range);
  miss.forEach((k, j) => {
    const d = datas[j];
    if (d === null || d === undefined) return;
    let snap: LiqSnap;
    try { snap = JSON.parse(d) as LiqSnap; } catch { return; }
    const vm = venueMask(snap);
    const pk = `${r.coin}|${r.ts[k]}`;
    tilePresence.delete(pk);
    tilePresence.set(pk, { n: r.ns[k]!, vm });
    if (tilePresence.size > PRESENCE_MAX) tilePresence.delete(tilePresence.keys().next().value!);
    const h = { p: snap.p, st: snap.st, rows: snapRows(snap, presentVenues(r.venues, vm)) };
    keepTileRows(keyOf(k, vm), h);
    out[k] = cut(h);
  });
  return out;
}
setTileRowsOf(tileRowsOf);

// --- the metas across restarts -------------------------------------------------------------

/**
 * Bump when snapRows, snapScales or COMBOS change: a file of another version is not read. 3 (2026-11-17): each meta
 * carries its venues with rows (`vm`) and the header the venue sets asked; a version 2 file is still read (its metas
 * with venues not known, under the set they were made for).
 */
const METAS_V = 3;
/** Written this long after a change (a snapshot every 15 minutes; the first read of every coin adds ~100k). */
const SAVE_MS = 120_000;
/** A meta in the file: t, n, p, st, vm, then its scales (version 2: no vm). */
const META_W = 5 + COMBOS.length;
const META_W_V2 = 4 + COMBOS.length;

let metasFile: string | null | undefined;
/**
 * The metas' file in the server's data directory (production /var/lib/valuescan/state, which the
 * API's unit may write). VALUESCAN_LIQ_METAS_FILE names another, 'off' none; under the test runner
 * (NODE_TEST_CONTEXT) there is none unless it is named. A meta read back is used only while its
 * snapshot's data length is unchanged (heldMeta), so a snapshot written again is parsed again.
 */
function metasPath(): string | null {
  if (metasFile === undefined) {
    const named = process.env.VALUESCAN_LIQ_METAS_FILE?.trim();
    if (named) metasFile = named === 'off' ? null : named;
    else if (process.env.NODE_TEST_CONTEXT) metasFile = null;
    else { try { metasFile = join(dataDir(), 'liq-tile-metas.bin'); } catch { metasFile = null; } }
  }
  return metasFile;
}

let metasRead = false;
/** Once per process, before the first index or tile: the metas written before a restart. */
function readMetas(): void {
  if (metasRead) return;
  metasRead = true;
  const file = metasPath();
  if (!file) return;
  // [header length (u32), the header (JSON: version, width, each key's count, the sets asked), padding to 8, the
  // numbers]: every coin's 30 days are ~2.4M numbers, as JSON a parse that holds the API at each start.
  let nums: Float64Array;
  let saved: { v?: number; w?: number; keys?: Array<[string, number]>; asked?: Array<[string, number]> };
  try {
    const buf = readFileSync(file);
    const len = buf.readUInt32LE(0);
    saved = JSON.parse(buf.toString('utf8', 4, 4 + len)) as typeof saved;
    const at = Math.ceil((4 + len) / 8) * 8;
    nums = new Float64Array(buf.buffer.slice(buf.byteOffset + at, buf.byteOffset + buf.length));
  } catch { return; }
  const v3 = saved.v === METAS_V;
  const w = v3 ? META_W : META_W_V2;
  if (!(v3 || saved.v === 2) || saved.w !== w || !Array.isArray(saved.keys)) return;
  let o = 0;
  for (const [vk, count] of saved.keys) {
    const coin = coinOfKey(vk);
    let byT = metas.get(vk);
    if (!byT) { byT = new Map(); metas.set(vk, byT); }
    let vks = vksOf.get(coin);
    if (!vks) { vks = new Set(); vksOf.set(coin, vks); }
    vks.add(vk);
    for (let i = 0; i < count && o + w <= nums.length; i++, o += w) {
      const t = nums[o]!;
      if (byT.has(t)) continue;
      const vm = v3 ? nums[o + 4]! : -1;
      const m: Meta = { t, n: nums[o + 1]!, p: nums[o + 2]!, st: nums[o + 3]!, vm, sc: nums.subarray(o + (v3 ? 5 : 4), o + w) };
      byT.set(t, m);
      if (vm >= 0) {
        let pr = presence.get(coin);
        if (!pr) { pr = new Map(); presence.set(coin, pr); }
        pr.set(t, { n: m.n, vm });
      }
    }
  }
  const now = Date.now();
  if (Array.isArray(saved.asked)) for (const [k, at] of saved.asked) if (typeof k === 'string' && typeof at === 'number' && now - at < ASKED_KEEP_MS) asked.set(k, at);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function metasChanged(): void {
  if (saveTimer || !metasPath()) return;
  saveTimer = setTimeout(() => { saveTimer = null; void saveLiqMetas(); }, SAVE_MS);
  saveTimer.unref?.();
}

/** Metas packed per write of the file (~1.7 MB at 26 numbers each). */
const SAVE_CHUNK = 8_192;
let saving: Promise<void> = Promise.resolve();

/**
 * Write the metas now (a temporary file renamed over the last: never half a file); one write at a time, a second asked
 * meanwhile writes after it. In slices (2026-11-09: one save was 10.1 s of an API stall, all of it here - every meta
 * packed into one array of the whole file, ~130 MB at 700,000 metas, and copied once more behind the header, on a heap
 * near its limit): the metas listed per key, then packed SAVE_CHUNK at a time into one reused array and written, the
 * thread given back every YIELD_MS. The same bytes as one piece. A meta is never changed once made (a newer one replaces
 * it in its map), so the ones listed are written as they were.
 */
export function saveLiqMetas(): Promise<void> {
  saving = saving.catch(() => {}).then(writeMetas);
  return saving;
}

async function writeMetas(): Promise<void> {
  const file = metasPath();
  if (!file) return;
  let since = performance.now();
  const breathe = async () => {
    if (performance.now() - since < YIELD_MS) return;
    await nextTurn();
    mark('liq:metas');
    since = performance.now();
  };
  const keys: Array<[string, number]> = [];
  const lists: Meta[][] = [];
  for (const [vk, byT] of [...metas]) {
    const list = [...byT.values()];
    keys.push([vk, list.length]);
    lists.push(list);
    await breathe();
  }
  const head = Buffer.from(JSON.stringify({ v: METAS_V, w: META_W, keys, asked: [...asked] }), 'utf8');
  const at = Math.ceil((4 + head.length) / 8) * 8;
  const pre = Buffer.alloc(at);
  pre.writeUInt32LE(head.length, 0);
  head.copy(pre, 4);
  const nums = new Float64Array(SAVE_CHUNK * META_W);
  const bytes = new Uint8Array(nums.buffer);
  try {
    const fh = await open(`${file}.tmp`, 'w');
    try {
      await fh.write(pre);
      let o = 0;
      for (const list of lists) {
        for (const m of list) {
          nums[o] = m.t; nums[o + 1] = m.n; nums[o + 2] = m.p; nums[o + 3] = m.st; nums[o + 4] = m.vm;
          nums.set(m.sc, o + 5);
          o += META_W;
          if (o === nums.length) {
            await fh.write(bytes);
            o = 0;
            await breathe();
          }
        }
      }
      if (o) await fh.write(bytes, 0, o * 8);
    } finally {
      await fh.close();
    }
    await rename(`${file}.tmp`, file);
  } catch { /* a read-only directory: the metas are rebuilt after a restart, as before */ }
}

// --- the venue sets asked -------------------------------------------------------------------

/**
 * The venue sets other than every venue asked for an index (coin|venues -> last ask), warmed with every venue from then
 * on (warmLiqMetas), so a set's next viewer does not wait for its 30 days. Kept in the metas' file; at most ASKED_MAX,
 * the least recent dropped, and one not asked for ASKED_KEEP_MS forgotten. Each costs ~0.4 ms of the reader thread per
 * new BTC snapshot and ~0.9 MB of this heap per coin.
 */
const asked = new Map<string, number>();
export const ASKED_MAX = 64;
export const ASKED_KEEP_MS = 7 * 86_400_000;

function noteAsked(coin: string, venues: readonly Venue[], now: number): void {
  const k = venueKey(coin, venues);
  const had = asked.has(k);
  asked.delete(k);
  asked.set(k, now);
  while (asked.size > ASKED_MAX) asked.delete(asked.keys().next().value!);
  if (!had) metasChanged();
}

/** The venue sets of a coin warmed besides every venue. */
function askedSets(coin: string, now: number): Venue[][] {
  const out: Venue[][] = [];
  for (const [k, at] of asked) {
    if (now - at >= ASKED_KEEP_MS) { asked.delete(k); continue; }
    if (coinOfKey(k) !== coin) continue;
    const vs = k.slice(coin.length + 1).split(',').filter((v): v is Venue => (VENUES as readonly string[]).includes(v));
    if (vs.length) out.push(vs);
  }
  return out;
}

// --- reading the metas ---------------------------------------------------------------------

/** Snapshots read in one go on the reader's thread (~75 KB each). */
const READ_BATCH = 24;
/** A read under way, per coin, snapshot, data length and venue set: another walk that needs it waits for it. */
const pendingMetas = new Map<string, Promise<Meta | null>>();

/**
 * The metas of the listed snapshots for each venue set of `sets` (per set, oldest first; a snapshot gone is left out):
 * held ones as they are, the rest read on the reader's thread a run of the listing at a time, each snapshot parsed once
 * for every set that needs it. A snapshot another walk is reading is waited for, not read again. `prog`: how far it is.
 */
async function walkMetas(coin: string, sets: ReadonlyArray<readonly Venue[]>, list: ReadonlyArray<{ t: number; n: number }>, restMs = 0, prog?: { done: number; of: number }): Promise<Meta[][]> {
  const setKeys = sets.map((s) => [...s].sort().join(','));
  const out: Array<Array<Meta | null>> = sets.map(() => list.map(() => null));
  // This thread's work since it was last given back: the stretches between waits (a read run inline is one of them).
  let worked = 0;
  let since = performance.now();
  for (let i = 0; i < list.length;) {
    const end = Math.min(list.length, i + READ_BATCH);
    const need: number[] = [];
    const needPairs: Array<[number, number]> = [];
    const needSets = new Set<number>();
    const joins: Array<Promise<void>> = [];
    for (let j = i; j < end; j++) {
      const at = list[j]!;
      let wants = false;
      for (let s = 0; s < sets.length; s++) {
        const m = heldMeta(coin, sets[s]!, at);
        if (m) { out[s]![j] = m; continue; }
        const p = pendingMetas.get(`${coin}|${at.t}|${at.n}|${setKeys[s]}`);
        if (p) { joins.push(p.then((x) => { out[s]![j] = x; })); continue; }
        wants = true;
        needSets.add(s);
        needPairs.push([j, s]);
      }
      if (wants) need.push(j);
    }
    if (need.length) {
      const ss = [...needSets];
      // One range scan when the run read is most of the listing between its ends (a cold walk: all of it).
      const range = need.at(-1)! - need[0]! + 1 <= 2 * need.length;
      const read = liqRead({ op: 'metas', coin, sets: ss.map((s) => [...sets[s]!]), ts: need.map((j) => list[j]!.t), range }, reader).then((got) => {
        const byJ = new Map<number, MetaWire | null>(need.map((j, k) => [j, got?.[k] ?? null]));
        return byJ;
      });
      for (const [j, s] of needPairs) {
        const at = list[j]!;
        const key = `${coin}|${at.t}|${at.n}|${setKeys[s]}`;
        const p = read.then((byJ) => {
          const w = byJ.get(j);
          if (!w) return null;
          const m: Meta = { t: at.t, n: at.n, p: w.p, st: w.st, vm: w.vm, sc: w.sc[ss.indexOf(s)]! };
          putMeta(coin, sets[s]!, m);
          return m;
        });
        pendingMetas.set(key, p);
        void p.catch(() => {}).finally(() => { if (pendingMetas.get(key) === p) pendingMetas.delete(key); });
        joins.push(p.then((x) => { out[s]![j] = x; }));
      }
    }
    // The waits are not this thread's work.
    if (joins.length) {
      worked += performance.now() - since;
      await Promise.all(joins);
      since = performance.now();
    }
    i = end;
    if (prog) prog.done = i;
    if (worked + performance.now() - since > YIELD_MS) {
      if (restMs > 0) await pause(restMs, undefined, { ref: false });
      else await nextTurn();
      mark(restMs > 0 ? 'liq:warm' : 'liq:tiles');
      worked = 0;
      since = performance.now();
    }
  }
  return out.map((a) => a.filter((m): m is Meta => m !== null));
}

/** Forget a coin's metas no longer listed (pruned or thinned), keeping the newest MAX_METAS of each set. */
function trimCoin(coin: string, listedTs: ReadonlySet<number>): void {
  let changed = false;
  const vks = vksOf.get(coin);
  for (const vk of vks ?? []) {
    const byT = metas.get(vk);
    if (!byT) { vks!.delete(vk); continue; }
    const had = byT.size;
    for (const t of byT.keys()) if (!listedTs.has(t)) byT.delete(t);
    if (byT.size > MAX_METAS) {
      const ts = [...byT.keys()].sort((a, b) => a - b);
      for (const t of ts.slice(0, ts.length - MAX_METAS)) byT.delete(t);
    }
    if (byT.size !== had) changed = true;
    if (!byT.size) { metas.delete(vk); vks!.delete(vk); }
  }
  const pr = presence.get(coin);
  if (pr) for (const t of pr.keys()) if (!listedTs.has(t)) pr.delete(t);
  if (changed) metasChanged();
}

// --- the index and the tiles ---------------------------------------------------------------

export interface LiqTileIndex {
  coin: string;
  venues: Venue[];
  /** The newest snapshot's time (null: none yet). */
  newest: number | null;
  /** The tile grid: a level-0 slot (ms), a level-0 band (from the newest price; 0: none), and how many levels of each. */
  slot: number;
  bw: number;
  tLevels: number;
  pLevels: number;
  /** Every snapshot over the 30 days, oldest first: time, price, step. */
  points: Array<{ t: number; p: number; st: number }>;
  /** The colour scale per filter (scaleKey): the notional a cell is drawn full at, per the newest step. */
  scale: Record<string, number>;
  /** Coins with snapshots (as the history route's `coins`). */
  coins: string[];
}

export interface TileAsk {
  tl: number; tt: number; pl: number; band: number; bw: number;
  /** The slot still filling, up to this snapshot (the index's newest). */
  v?: number;
  /** This one snapshot only (tl 0, its slot's start as tt): final once it exists. */
  at?: number;
  /** 'ls': rows of [bucket, long USD, short USD] only. */
  fields?: 'ls';
  /** The newest snapshot of each bar of `every` ms, the bars starting at `off` modulo it. */
  every?: number;
  off?: number;
}

export interface LiqTile extends TileAsk {
  coin: string;
  venues: Venue[];
  /** No snapshot will change this answer: its slot is passed, or it was asked up to a snapshot that exists. */
  final: boolean;
  /** The snapshots of the slot (up to `v`), oldest first: time, price, step and the rows in the band. */
  points: Array<{ t: number; p: number; st: number; b: SnapRow[] }>;
}

const inflight = new Map<string, Promise<unknown>>();
function shared<T>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = inflight.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** A finished index is answered again for this long (the edge keeps it a minute; this stops asks between). */
export const INDEX_MEMO_MS = 10_000;
/** A BTC index is ~160 KB of heap (2,880 points): a handful of sets within 10 s, these at most. */
const INDEX_MEMO_MAX = 64;
const indexMemo = new Map<string, { at: number; body: LiqTileIndex }>();
/** An index walk under way: how many of its listed snapshots are done. */
const building = new Map<string, { done: number; of: number }>();

/**
 * The index of `coin`'s history over `venues` (null: no index file yet). One walk per set at a time: an ask while one
 * runs waits for it, however long ago it began (it was one walk per 10 s, each re-reading the lane's batches).
 */
export function liqTileIndex(coin: string, venues: readonly Venue[], now = Date.now()): Promise<LiqTileIndex | null> {
  const vk = venueKey(coin, venues);
  const memo = indexMemo.get(vk);
  if (memo && now >= memo.at && now - memo.at < INDEX_MEMO_MS) return Promise.resolve(memo.body);
  if (!isEveryVenue(venues)) noteAsked(coin, venues, now);
  return shared(`i|${vk}`, async () => {
    if (!reader()) return null;
    readMetas();
    let list: Array<{ t: number; n: number }> = [];
    let coins: string[] = [];
    try {
      list = (await listing(coin, now)).filter((x) => x.t >= now - RANGE_MS);
      coins = await coinsOf(now);
    } catch { /* the table arrives with the indexer's first start */ }
    const prog = { done: 0, of: list.length };
    building.set(vk, prog);
    let snaps: Meta[];
    try {
      snaps = (await walkMetas(coin, [venues], list, 0, prog))[0]!;
    } finally {
      if (building.get(vk) === prog) building.delete(vk);
    }
    trimCoin(coin, new Set(list.map((x) => x.t)));
    const last = snaps.at(-1);
    const body: LiqTileIndex = {
      coin, venues: [...venues],
      newest: last?.t ?? null,
      slot: SLOT_MS, bw: last ? bandWidth(last.p) : 0, tLevels: T_LEVELS, pLevels: P_LEVELS,
      points: snaps.map((q) => ({ t: q.t, p: q.p, st: q.st })),
      scale: histScales(snaps),
      coins,
    };
    indexMemo.delete(vk);
    for (const [k, m] of indexMemo) if (!(now >= m.at && now - m.at < INDEX_MEMO_MS)) indexMemo.delete(k);
    indexMemo.set(vk, { at: now, body });
    while (indexMemo.size > INDEX_MEMO_MAX) indexMemo.delete(indexMemo.keys().next().value!);
    return body;
  });
}

/** The route waits this long for an index; past it, the answer is how far the walk is, and the walk goes on. */
export const INDEX_BUDGET_MS = 4_000;

/**
 * liqTileIndex within `budgetMs`: the index, null (no index file), or how far its walk is ('building': the route answers
 * that, never cached, and the view asks again shortly). The walk is never stopped: the next ask joins it. Through the
 * proxy an index cold for 30 s was a 504 and nothing to show for it.
 */
export async function liqTileIndexIn(coin: string, venues: readonly Venue[], budgetMs = INDEX_BUDGET_MS, now = Date.now()): Promise<LiqTileIndex | null | { building: { done: number; of: number } }> {
  const p = liqTileIndex(coin, venues, now);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((ok) => { timer = setTimeout(() => ok('late'), budgetMs); timer.unref?.(); });
  const r = await Promise.race([p, late]);
  clearTimeout(timer);
  if (r !== 'late') return r;
  void p.catch(() => {});
  const prog = building.get(venueKey(coin, venues));
  return { building: { done: prog?.done ?? 0, of: prog?.of ?? 0 } };
}

/**
 * Every coin's snapshots read ahead over every venue (what the view asks unless a venue is switched
 * off), so no visitor waits for a coin's first read (owner 2026-11-05: "it takes a long time
 * snapshots are read/shown"; production: SOL's first index 13.8 s, XRP's 8.2 s, BNB's 9.1 s - only
 * coins already viewed were held), and with it each venue set asked of the coin (asked), each new
 * snapshot parsed once for all of them. At most a quarter of the thread; the first round reads ~100
 * coins' 30 days, kept on disk across releases, each later one only the snapshots written since.
 * Returns how many coins it went over.
 */
export async function warmLiqMetas(now = Date.now(), restMs = WARM_REST_MS): Promise<number> {
  if (!reader()) return 0;
  readMetas();
  let coins: string[] = [];
  try { coins = await coinsOf(now); } catch { return 0; }
  for (const coin of coins) {
    let list: Array<{ t: number; n: number }>;
    try { list = (await listing(coin, now)).filter((x) => x.t >= now - RANGE_MS); } catch { continue; }
    if (!list.length) continue;
    await walkMetas(coin, [[...VENUES], ...askedSets(coin, now)], list, restMs);
    trimCoin(coin, new Set(list.map((x) => x.t)));
    if (restMs > 0) await pause(restMs, undefined, { ref: false });
  }
  return coins.length;
}

/** warmLiqMetas soon after the start and every WARM_EVERY_MS (a snapshot every 15 minutes); returns the stop. VALUESCAN_LIQ_WARM=off: none. */
export const WARM_EVERY_MS = 15 * 60_000;
export function keepLiqMetasWarm(): () => void {
  if (process.env.VALUESCAN_LIQ_WARM === 'off') return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const next = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => { void warmLiqMetas().catch(() => 0).finally(() => next(WARM_EVERY_MS)); }, ms);
    timer.unref?.();
  };
  next(30_000);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

/** The longest bar `every=` may name (a week: the chart's longest bar of a fixed length). */
export const EVERY_MAX_MS = 7 * 86_400_000;

/** `tl= tt= pl= band= bw= [v= | at=] [fields=ls] [every= off=]` checked: a TileAsk, or what is wrong. */
export function tileAskOf(q: Record<string, string | undefined>, now = Date.now()): TileAsk | string {
  const has = (k: string) => q[k] !== undefined && q[k] !== '';
  const num = (k: string) => (has(k) ? Number(q[k]) : NaN);
  const tl = num('tl');
  const pl = num('pl');
  const tt = num('tt');
  const band = num('band');
  const bw = num('bw');
  if (!Number.isInteger(tl) || tl < 0 || tl >= T_LEVELS) return `tl= must be 0..${T_LEVELS - 1}`;
  if (!Number.isInteger(pl) || pl < 0 || pl >= P_LEVELS) return `pl= must be 0..${P_LEVELS - 1}`;
  if (!Number.isInteger(tt) || tt % tileMs(tl) !== 0) return 'tt= must be the start of a slot of level tl (ms)';
  if (tt < now - RANGE_MS - tileMs(tl) || tt > now + SLOT_MS) return 'tt= is outside the history';
  if (!Number.isInteger(band) || band < 0 || band > 1e9) return 'band= must be a whole number';
  if (!isBandWidth(bw)) return 'bw= must be the index\'s band width';
  const ask: TileAsk = { tl, tt, pl, band, bw };
  if (has('v')) {
    const v = num('v');
    if (!Number.isInteger(v) || v < tt) return 'v= must be a snapshot time in the slot';
    ask.v = v;
  }
  if (has('at')) {
    const at = num('at');
    if (ask.v !== undefined) return 'at= and v= are not asked together';
    if (tl !== 0 || !Number.isInteger(at) || at < tt || at >= tt + SLOT_MS) return 'at= must be a snapshot time in a slot of level 0';
    ask.at = at;
  }
  if (has('fields')) {
    if (q.fields !== 'ls') return 'fields= must be ls';
    ask.fields = 'ls';
  }
  if (has('every')) {
    const every = num('every');
    if (!Number.isInteger(every) || every < 0 || every > EVERY_MAX_MS) return `every= must be a bar length in ms, at most ${EVERY_MAX_MS}`;
    const off = has('off') ? num('off') : 0;
    if (!Number.isInteger(off)) return 'off= must be a time in ms';
    if (every > 0) { ask.every = every; ask.off = ((off % every) + every) % every; }
  }
  return ask;
}

const askKey = (a: TileAsk): string => `${a.tl}|${a.tt}|${a.pl}|${a.band}|${a.bw}|${a.v ?? ''}|${a.at ?? ''}|${a.fields ?? ''}|${a.every ?? 0}|${a.off ?? 0}`;

/**
 * The snapshots a tile holds of those listed in its slot (oldest first): every one, `at` alone, or with `every` the
 * newest of each bar (liqRead.ts FineDraw's rule: bar floor((t - off) / every)) - in groups per bar, newest last, so
 * one gone by the time it is read gives way to the one before it.
 */
export function tileGroups<T extends { t: number }>(list: readonly T[], ask: Pick<TileAsk, 'at' | 'every' | 'off'>): T[][] {
  const xs = ask.at !== undefined ? list.filter((x) => x.t === ask.at) : list;
  if (!ask.every) return xs.map((x) => [x]);
  const every = ask.every;
  const off = ask.off ?? 0;
  const out: T[][] = [];
  let bar = Number.NaN;
  for (const x of xs) {
    const b = Math.floor((x.t - off) / every);
    if (b !== bar) { out.push([x]); bar = b; } else out[out.length - 1]!.push(x);
  }
  return out;
}

/** Snapshots cut per ask of the reader thread (a 1-day tile at 15 minutes: 96). */
const TILE_BATCH = 48;

/** The tile's rows of each group's newest snapshot (the one before it when that is gone), read and cut on the reader's thread. */
async function tilePoints(coin: string, venues: readonly Venue[], list: ReadonlyArray<{ t: number; n: number }>, groups: ReadonlyArray<ReadonlyArray<{ t: number; n: number }>>, span: number, band: number, slim: boolean): Promise<LiqTile['points']> {
  const pos = new Map(list.map((x, i) => [x.t, i]));
  const got = new Map<number, TileRowsWire>();
  const at = groups.map((g) => g.length - 1);
  let todo = groups.map((_, i) => i);
  let worked = 0;
  let since = performance.now();
  while (todo.length) {
    const next: number[] = [];
    for (let k = 0; k < todo.length; k += TILE_BATCH) {
      const part = todo.slice(k, k + TILE_BATCH);
      const xs = part.map((g) => groups[g]![at[g]!]!);
      const first = pos.get(xs[0]!.t) ?? 0;
      const last = pos.get(xs.at(-1)!.t) ?? 0;
      const ask = liqRead({ op: 'tileRows', coin, venues: [...venues], ts: xs.map((x) => x.t), ns: xs.map((x) => x.n), span, band, slim, range: last - first + 1 <= 2 * xs.length }, reader);
      worked += performance.now() - since;
      const res = (await ask) ?? [];
      since = performance.now();
      part.forEach((g, j) => {
        const w = res[j];
        if (w) got.set(xs[j]!.t, w);
        else if (--at[g]! >= 0) next.push(g);
      });
      if (worked + performance.now() - since > YIELD_MS) { await nextTurn(); mark('liq:tiles'); worked = 0; since = performance.now(); }
    }
    todo = next;
  }
  return [...got].sort((a, b) => a[0] - b[0]).map(([t, w]) => ({ t, p: w.p, st: w.st, b: w.b }));
}

/** One tile of `coin`'s history over `venues` (null: no index file yet). */
export function liqTile(coin: string, venues: readonly Venue[], ask: TileAsk): Promise<LiqTile | null> {
  const vk = venueKey(coin, venues);
  return shared(`t|${vk}|${askKey(ask)}`, async () => {
    if (!reader()) return null;
    readMetas();
    const end = ask.tt + tileMs(ask.tl);
    let after: Array<{ t: number; n: number }> = [];
    try { after = (await listing(coin, Date.now())).filter((x) => x.t >= ask.tt); } catch { /* no table yet */ }
    const newest = after.at(-1)?.t ?? null;
    const upTo = Math.min(end - 1, ask.v ?? Number.MAX_SAFE_INTEGER);
    const list = after.filter((x) => x.t <= upTo);
    const points = await tilePoints(coin, venues, list, tileGroups(list, ask), bandSpan(ask.bw, ask.pl), ask.band, ask.fields === 'ls');
    return { coin, venues: [...venues], ...ask, final: finalOf(ask, end, newest), points };
  });
}

/** A tile no snapshot will change: its slot passed, or it ends at a snapshot that exists (`v`, `at`). */
const finalOf = (ask: TileAsk, end: number, newest: number | null): boolean =>
  newest !== null && (newest >= end || (ask.v !== undefined && newest >= ask.v) || (ask.at !== undefined && newest >= ask.at));

/** Tests: forget every parsed snapshot, as a restart does (the metas' file is read again). */
export function resetLiqTiles(): void {
  metas.clear();
  vksOf.clear();
  presence.clear();
  tileLru.clear();
  tileRowsHeld = 0;
  tilePresence.clear();
  inflight.clear();
  indexMemo.clear();
  building.clear();
  asked.clear();
  pendingMetas.clear();
  resetLiqReadThread();
  lists.clear();
  coinsHeld = null;
  metasFile = undefined;
  metasRead = false;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

/** Tests: the venue sets warmed besides every venue (coin|venues -> last ask). */
export const _liqAskedSets = asked;

// --- some wallets (the wallet filter) ------------------------------------------------------

/**
 * The wallet filter in tiles too (perf session 2026-11-01, the owner's "optimize everything ...
 * loading times + device hardware usage"): its history was one answer of 30 days, re-read every
 * five minutes. A wallet set's history is rebuilt from the change log once (liqRead.ts liqHistory
 * with `wallets`) and kept WALLET_HIST_MS; its index and every tile are cut from that one answer,
 * on the same grid as every wallet's. Kept TILE_WALLET_CACHE by the edge and the browser.
 */
export const WALLET_HIST_MS = 60_000;
const WALLET_HIST_MAX = 32;
const walletHists = new Map<string, { at: number; h: Promise<LiqHistory | null> }>();

function walletHistory(coin: string, venues: readonly Venue[], wallets: readonly string[], now: number): Promise<LiqHistory | null> {
  const key = `${venueKey(coin, venues)}|${[...wallets].sort().join(',')}`;
  const hit = walletHists.get(key);
  if (hit && now - hit.at < WALLET_HIST_MS) return hit.h;
  if (walletHists.size >= WALLET_HIST_MAX) for (const [k, v] of walletHists) if (now - v.at >= WALLET_HIST_MS || walletHists.size >= WALLET_HIST_MAX) walletHists.delete(k);
  // The snapshots' times, prices and steps from the index, held: read from the snapshots themselves
  // this was 30 days of JSON in one blocking statement, again each minute (production 2026-11-05: 3.6-4.6 s).
  // The change log read and summed on the liquidation history's thread (liqHistThread.ts), not this one.
  const h = liqTileIndex(coin, venues, now).then(async (idx) => (idx
    ? JSON.parse(await liqJob({ kind: 'history', coin, venues: [...venues], range: '30d', wallets: [...wallets], known: { points: idx.points, coins: idx.coins } })) as LiqHistory | null
    : null));
  walletHists.set(key, { at: now, h });
  h.catch(() => walletHists.delete(key));
  return h;
}

/** The index of some wallets' history: their snapshots (those where they held a level), the scales over them. */
export async function liqTileIndexOf(coin: string, venues: readonly Venue[], wallets: readonly string[], now = Date.now()): Promise<LiqTileIndex | null> {
  const h = await walletHistory(coin, venues, wallets, now);
  if (!h) return null;
  const last = h.points.at(-1);
  return {
    coin, venues: [...venues],
    newest: last?.t ?? null,
    slot: SLOT_MS, bw: last ? bandWidth(last.p) : 0, tLevels: T_LEVELS, pLevels: P_LEVELS,
    points: h.points.map((q) => ({ t: q.t, p: q.p, st: q.st })),
    scale: histScales(h.points.map((q) => ({ st: q.st, sc: snapScales(q.b) }))),
    coins: h.coins,
  };
}

/** One tile of some wallets' history, cut from the same answer as their index (and to `at`, `every`, `fields` as every wallet's). */
export async function liqTileOf(coin: string, venues: readonly Venue[], wallets: readonly string[], ask: TileAsk, now = Date.now()): Promise<LiqTile | null> {
  const h = await walletHistory(coin, venues, wallets, now);
  if (!h) return null;
  const end = ask.tt + tileMs(ask.tl);
  const upTo = Math.min(end - 1, ask.v ?? Number.MAX_SAFE_INTEGER);
  const span = bandSpan(ask.bw, ask.pl);
  const inSlot = h.points.filter((q) => q.t >= ask.tt && q.t <= upTo);
  const points: LiqTile['points'] = [];
  for (const g of tileGroups(inSlot, ask)) {
    const q = g.at(-1)!;
    const b = q.b.filter((r) => bandOf(r[0], q.st, span) === ask.band);
    points.push({ t: q.t, p: q.p, st: q.st, b: ask.fields === 'ls' ? b.map((r) => (r.length > 3 ? r.slice(0, 3) as SnapRow : r)) : b });
  }
  const newest = h.points.at(-1)?.t ?? null;
  return { coin, venues: [...venues], ...ask, final: finalOf(ask, end, newest), points };
}

/** Tests: forget the wallet histories held. */
export function resetWalletTiles(): void {
  walletHists.clear();
}

/** Benches and tests: the metas held, per coin and venue set (snapshot time -> meta). */
export const _liqMetasHeld = metas;
