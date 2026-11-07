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
 * CACHING. A slot a newer snapshot has passed is final and kept a day by the edge and the browser
 * (thinning past 3 days later drops some of its snapshots; a copy already made keeps them - real
 * snapshots either way). The slot still filling is asked with `v=` its newest snapshot: a new
 * snapshot is a new URL, and every URL keeps one answer. The index moves with each snapshot
 * (every 15 min) and is kept a minute.
 *
 * THE API THREAD. A snapshot is parsed once per venue set (keyed by its time and data length, so a
 * snapshot written again is read again), and the loop is given back between snapshots (YIELD_MS).
 * Its rows are kept in a LRU bounded by rows (MAX_ROWS); its time, price, step and per-filter
 * scales for as long as it is listed, and in a file across restarts (metasPath): the first index
 * after the 2026-11-01 release took 7.1 s, every snapshot of 30 days parsed again for its scales.
 */
import { mark } from './busy.js';
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as pause } from 'node:timers/promises';
import { dataDir } from '../builder/paths.js';
import { VENUES, type Venue } from '../valuedesk/types.js';
import { LEV_BANDS, type LevBand } from '../valuedesk/liquidations/math.js';
import { snapBand, trimRow, type LiqSnap, type SnapRow } from '../valuedesk/liquidations/levels.js';
import type { LiqHistory } from './liqRead.js';
import { liqJob } from './liqHistThread.js';
import { reader } from './reader.js';
import type { IndexStore } from './store.js';

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

/** web liqLev.ts robustMax at the heat scale's settings (q 0.95, ratio 3, keep 2). */
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

/** A snapshot's own robust scale per filter, at its own step (COMBOS order). */
export function snapScales(rows: readonly SnapRow[]): Float64Array {
  const out = new Float64Array(COMBOS.length);
  // One buffer, sorted as numbers: an array mapped, filtered and sorted with a comparator for each of
  // the 21 filters was most of a coin's first read (production 2026-11-05: XRP's first index 8.2 s).
  if (scaleBuf.length < rows.length) scaleBuf = new Float64Array(rows.length * 2);
  for (let k = 0; k < COMBOS.length; k++) {
    const { side, set } = COMBOS[k]!;
    let m = 0;
    for (const r of rows) {
      const x = cellV(r, side, set);
      if (x > 0 && Number.isFinite(x)) scaleBuf[m++] = x;
    }
    out[k] = robustOfSorted(scaleBuf.subarray(0, m).sort());
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

// --- the snapshots, parsed once ------------------------------------------------------------

interface Meta { t: number; n: number; p: number; st: number; sc: Float64Array }

/** Rows kept parsed at most (~80 bytes each: about 120 MB). BTC's 30 days are ~0.4M. */
export const MAX_ROWS = 1_500_000;
/** Work this long between two turns of the loop given back. */
const YIELD_MS = 8;
/** The background read (warmLiqMetas): this long of rest after each YIELD_MS of work, a quarter of the thread at most. */
const WARM_REST_MS = 24;
/** Snapshot metas kept per coin and venue set (30 days at 15 minutes is 2,880). */
const MAX_METAS = 4_000;

const metas = new Map<string, Map<number, Meta>>();
const rowsLru = new Map<string, SnapRow[]>();
let rowsHeld = 0;

const venueKey = (coin: string, venues: readonly Venue[]): string => `${coin}|${[...venues].sort().join(',')}`;

function keepRows(key: string, rows: SnapRow[]): void {
  const old = rowsLru.get(key);
  if (old) { rowsLru.delete(key); rowsHeld -= old.length; }
  rowsLru.set(key, rows);
  rowsHeld += rows.length;
  for (const [k, v] of rowsLru) {
    if (rowsHeld <= MAX_ROWS) break;
    rowsLru.delete(k);
    rowsHeld -= v.length;
  }
}

function heldRows(key: string): SnapRow[] | undefined {
  const v = rowsLru.get(key);
  if (v) { rowsLru.delete(key); rowsLru.set(key, v); }
  return v;
}

/** Times and data lengths of a coin's snapshots in [from, to). octet_length reads no overflow page (SQLite 3.43+). */
let lengthFn: 'octet_length' | 'length' = 'octet_length';
function listed(s: IndexStore, coin: string, from: number, to: number): Array<{ t: number; n: number }> {
  try {
    return lengthFn === 'octet_length' ? s.liqHistMeta(coin, from, to) : s.liqHistMetaSlow(coin, from, to);
  } catch (e) {
    if (lengthFn === 'octet_length' && /octet_length/i.test(String((e as Error).message))) {
      lengthFn = 'length';
      return s.liqHistMetaSlow(coin, from, to);
    }
    throw e;
  }
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

function listing(s: IndexStore, coin: string, now: number): Array<{ t: number; n: number }> {
  const from = now - RANGE_MS - tileMs(T_LEVELS - 1);
  const held = lists.get(coin);
  const last = held?.rows.at(-1);
  if (held && last && now - held.at < RELIST_MS && from >= held.from) {
    const tail = listed(s, coin, last.t, Number.MAX_SAFE_INTEGER);
    const keep = held.rows.filter((x) => x.t >= from && x.t < last.t);
    held.rows = keep.concat(tail);
    return held.rows;
  }
  const rows = listed(s, coin, from, Number.MAX_SAFE_INTEGER);
  lists.set(coin, { at: now, from, rows });
  return rows;
}

/** The coins with snapshots, kept a minute: the statement scans the whole table (its key is coin, t). */
const COINS_MS = 60_000;
let coinsHeld: { at: number; coins: string[] } | null = null;
function coinsOf(s: IndexStore, now: number): string[] {
  if (!coinsHeld || now - coinsHeld.at >= COINS_MS || now < coinsHeld.at) coinsHeld = { at: now, coins: s.liqHistCoins() };
  return coinsHeld.coins;
}

/** A snapshot's meta and rows: held, else read and parsed (null: gone, or not JSON). */
function snapOf(s: IndexStore, coin: string, venues: readonly Venue[], vk: string, at: { t: number; n: number }, wantRows: boolean): { meta: Meta; rows: SnapRow[] | null } | null {
  let byT = metas.get(vk);
  const meta = byT?.get(at.t);
  if (meta && meta.n === at.n) {
    if (!wantRows) return { meta, rows: null };
    const rows = heldRows(`${vk}|${at.t}`);
    if (rows) return { meta, rows };
  }
  const data = s.liqHistAt(coin, at.t);
  if (data === null) return null;
  let snap: LiqSnap;
  try { snap = JSON.parse(data) as LiqSnap; } catch { return null; }
  const rows = snapRows(snap, venues);
  // Its meta known and unchanged, only its rows were wanted: its scales are not worked out again.
  if (meta && meta.n === at.n) {
    keepRows(`${vk}|${at.t}`, rows);
    return { meta, rows };
  }
  const m: Meta = { t: at.t, n: at.n, p: snap.p, st: snap.st, sc: snapScales(rows) };
  if (!byT) { byT = new Map(); metas.set(vk, byT); }
  byT.set(at.t, m);
  if (wantRows) keepRows(`${vk}|${at.t}`, rows);
  metasChanged();
  return { meta: m, rows };
}

// --- the metas across restarts -------------------------------------------------------------

/** Bump when snapRows, snapScales or COMBOS change: a file of another version is not read. */
const METAS_V = 2;
/** Written this long after a change (a snapshot every 15 minutes; the first read of every coin adds ~100k). */
const SAVE_MS = 120_000;
/** A meta in the file: t, n, p, st, then its scales. */
const META_W = 4 + COMBOS.length;

let metasFile: string | null | undefined;
/**
 * The metas' file in the server's data directory (production /var/lib/valuescan/state, which the
 * API's unit may write). VALUESCAN_LIQ_METAS_FILE names another, 'off' none; under the test runner
 * (NODE_TEST_CONTEXT) there is none unless it is named. A meta read back is used only while its
 * snapshot's data length is unchanged (snapOf), so a snapshot written again is parsed again.
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
  // [header length (u32), the header (JSON: version, width, each key's count), padding to 8, the
  // numbers]: every coin's 30 days are ~2.4M numbers, as JSON a parse that holds the API at each start.
  let nums: Float64Array;
  let saved: { v?: number; w?: number; keys?: Array<[string, number]> };
  try {
    const buf = readFileSync(file);
    const len = buf.readUInt32LE(0);
    saved = JSON.parse(buf.toString('utf8', 4, 4 + len)) as typeof saved;
    const at = Math.ceil((4 + len) / 8) * 8;
    nums = new Float64Array(buf.buffer.slice(buf.byteOffset + at, buf.byteOffset + buf.length));
  } catch { return; }
  if (saved.v !== METAS_V || saved.w !== META_W || !Array.isArray(saved.keys)) return;
  let o = 0;
  for (const [vk, count] of saved.keys) {
    let byT = metas.get(vk);
    if (!byT) { byT = new Map(); metas.set(vk, byT); }
    for (let i = 0; i < count && o + META_W <= nums.length; i++, o += META_W) {
      const t = nums[o]!;
      if (!byT.has(t)) byT.set(t, { t, n: nums[o + 1]!, p: nums[o + 2]!, st: nums[o + 3]!, sc: nums.subarray(o + 4, o + META_W) });
    }
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function metasChanged(): void {
  if (saveTimer || !metasPath()) return;
  saveTimer = setTimeout(() => { saveTimer = null; void saveLiqMetas(); }, SAVE_MS);
  saveTimer.unref?.();
}

/** Write the metas now (a temporary file renamed over the last: never half a file). */
export async function saveLiqMetas(): Promise<void> {
  const file = metasPath();
  if (!file) return;
  const keys: Array<[string, number]> = [];
  let total = 0;
  for (const [vk, byT] of metas) { keys.push([vk, byT.size]); total += byT.size; }
  const nums = new Float64Array(total * META_W);
  let o = 0;
  for (const byT of metas.values()) {
    for (const m of byT.values()) {
      nums[o] = m.t; nums[o + 1] = m.n; nums[o + 2] = m.p; nums[o + 3] = m.st;
      nums.set(m.sc, o + 4);
      o += META_W;
    }
  }
  const head = Buffer.from(JSON.stringify({ v: METAS_V, w: META_W, keys }), 'utf8');
  const at = Math.ceil((4 + head.length) / 8) * 8;
  const pre = Buffer.alloc(at);
  pre.writeUInt32LE(head.length, 0);
  head.copy(pre, 4);
  try {
    await writeFile(`${file}.tmp`, Buffer.concat([pre, Buffer.from(nums.buffer)]));
    await rename(`${file}.tmp`, file);
  } catch { /* a read-only directory: the metas are rebuilt after a restart, as before */ }
}

/** Each listed snapshot, read where needed, the loop given back every YIELD_MS of work. */
async function walk(s: IndexStore, coin: string, venues: readonly Venue[], list: ReadonlyArray<{ t: number; n: number }>, wantRows: boolean, restMs = 0): Promise<Array<{ meta: Meta; rows: SnapRow[] | null }>> {
  const vk = venueKey(coin, venues);
  const out: Array<{ meta: Meta; rows: SnapRow[] | null }> = [];
  let since = performance.now();
  for (const at of list) {
    const x = snapOf(s, coin, venues, vk, at, wantRows);
    if (x) out.push(x);
    if (performance.now() - since > YIELD_MS) {
      if (restMs > 0) await pause(restMs, undefined, { ref: false });
      else await nextTurn();
      mark(restMs > 0 ? 'liq:warm' : 'liq:tiles');
      since = performance.now();
    }
  }
  return out;
}

/** Forget the metas no longer listed (pruned or thinned), keeping the newest MAX_METAS. */
function trimMetas(vk: string, listedTs: ReadonlySet<number>): void {
  const byT = metas.get(vk);
  if (!byT) return;
  const had = byT.size;
  for (const t of byT.keys()) if (!listedTs.has(t)) byT.delete(t);
  if (byT.size > MAX_METAS) {
    const ts = [...byT.keys()].sort((a, b) => a - b);
    for (const t of ts.slice(0, ts.length - MAX_METAS)) byT.delete(t);
  }
  if (byT.size !== had) metasChanged();
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

export interface TileAsk { tl: number; tt: number; pl: number; band: number; bw: number; v?: number }

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

/** The index of `coin`'s history over `venues` (null: no index file yet). */
export function liqTileIndex(coin: string, venues: readonly Venue[], now = Date.now()): Promise<LiqTileIndex | null> {
  const vk = venueKey(coin, venues);
  return shared(`i|${vk}|${Math.floor(now / 10_000)}`, async () => {
    const s = reader();
    if (!s) return null;
    readMetas();
    let list: Array<{ t: number; n: number }> = [];
    let coins: string[] = [];
    try {
      list = listing(s, coin, now).filter((x) => x.t >= now - RANGE_MS);
      coins = coinsOf(s, now);
    } catch { /* the table arrives with the indexer's first start */ }
    const snaps = (await walk(s, coin, venues, list, false)).map((x) => x.meta);
    trimMetas(vk, new Set(list.map((x) => x.t)));
    const last = snaps.at(-1);
    return {
      coin, venues: [...venues],
      newest: last?.t ?? null,
      slot: SLOT_MS, bw: last ? bandWidth(last.p) : 0, tLevels: T_LEVELS, pLevels: P_LEVELS,
      points: snaps.map((q) => ({ t: q.t, p: q.p, st: q.st })),
      scale: histScales(snaps),
      coins,
    };
  });
}

/**
 * Every coin's snapshots read ahead over every venue (what the view asks unless a venue is switched
 * off), so no visitor waits for a coin's first read (owner 2026-11-05: "it takes a long time
 * snapshots are read/shown"; production: SOL's first index 13.8 s, XRP's 8.2 s, BNB's 9.1 s - only
 * coins already viewed were held). At most a quarter of the thread; the first round reads ~100
 * coins' 30 days, kept on disk across releases, each later one only the snapshots written since.
 * Returns how many coins it went over.
 */
export async function warmLiqMetas(now = Date.now(), restMs = WARM_REST_MS): Promise<number> {
  const s = reader();
  if (!s) return 0;
  readMetas();
  let coins: string[] = [];
  try { coins = coinsOf(s, now); } catch { return 0; }
  const venues = [...VENUES];
  for (const coin of coins) {
    let list: Array<{ t: number; n: number }>;
    try { list = listing(s, coin, now).filter((x) => x.t >= now - RANGE_MS); } catch { continue; }
    if (!list.length) continue;
    await walk(s, coin, venues, list, false, restMs);
    trimMetas(venueKey(coin, venues), new Set(list.map((x) => x.t)));
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

/** `tl= tt= pl= band= bw= [v=]` checked: a TileAsk, or what is wrong. */
export function tileAskOf(q: Record<string, string | undefined>, now = Date.now()): TileAsk | string {
  const num = (k: string) => (q[k] === undefined || q[k] === '' ? NaN : Number(q[k]));
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
  if (q.v === undefined || q.v === '') return { tl, tt, pl, band, bw };
  const v = num('v');
  if (!Number.isInteger(v) || v < tt) return 'v= must be a snapshot time in the slot';
  return { tl, tt, pl, band, bw, v };
}

/** One tile of `coin`'s history over `venues` (null: no index file yet). */
export function liqTile(coin: string, venues: readonly Venue[], ask: TileAsk): Promise<LiqTile | null> {
  const vk = venueKey(coin, venues);
  return shared(`t|${vk}|${ask.tl}|${ask.tt}|${ask.pl}|${ask.band}|${ask.bw}|${ask.v ?? ''}`, async () => {
    const s = reader();
    if (!s) return null;
    readMetas();
    const end = ask.tt + tileMs(ask.tl);
    let after: Array<{ t: number; n: number }> = [];
    try { after = listing(s, coin, Date.now()).filter((x) => x.t >= ask.tt); } catch { /* no table yet */ }
    const newest = after.at(-1)?.t ?? null;
    const upTo = Math.min(end - 1, ask.v ?? Number.MAX_SAFE_INTEGER);
    const list = after.filter((x) => x.t <= upTo);
    const span = bandSpan(ask.bw, ask.pl);
    const points: LiqTile['points'] = [];
    for (const { meta, rows } of await walk(s, coin, venues, list, true)) {
      const b = (rows ?? []).filter((r) => bandOf(r[0], meta.st, span) === ask.band);
      points.push({ t: meta.t, p: meta.p, st: meta.st, b });
    }
    const final = newest !== null && (newest >= end || (ask.v !== undefined && newest >= ask.v));
    return { coin, venues: [...venues], ...ask, final, points };
  });
}

/** Tests: forget every parsed snapshot, as a restart does (the metas' file is read again). */
export function resetLiqTiles(): void {
  metas.clear();
  rowsLru.clear();
  rowsHeld = 0;
  inflight.clear();
  lengthFn = 'octet_length';
  lists.clear();
  coinsHeld = null;
  metasFile = undefined;
  metasRead = false;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

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

/** One tile of some wallets' history, cut from the same answer as their index. */
export async function liqTileOf(coin: string, venues: readonly Venue[], wallets: readonly string[], ask: TileAsk, now = Date.now()): Promise<LiqTile | null> {
  const h = await walletHistory(coin, venues, wallets, now);
  if (!h) return null;
  const end = ask.tt + tileMs(ask.tl);
  const upTo = Math.min(end - 1, ask.v ?? Number.MAX_SAFE_INTEGER);
  const span = bandSpan(ask.bw, ask.pl);
  const points: LiqTile['points'] = [];
  for (const q of h.points) {
    if (q.t < ask.tt || q.t > upTo) continue;
    points.push({ t: q.t, p: q.p, st: q.st, b: q.b.filter((r) => bandOf(r[0], q.st, span) === ask.band) });
  }
  const newest = h.points.at(-1)?.t ?? null;
  const final = newest !== null && (newest >= end || (ask.v !== undefined && newest >= ask.v));
  return { coin, venues: [...venues], ...ask, final, points };
}

/** Tests: forget the wallet histories held. */
export function resetWalletTiles(): void {
  walletHists.clear();
}
