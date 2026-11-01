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
 * scales for as long as it is listed.
 */
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Venue } from '../valuedesk/types.js';
import { LEV_BANDS, type LevBand } from '../valuedesk/liquidations/math.js';
import { snapBand, trimRow, type LiqSnap, type SnapRow } from '../valuedesk/liquidations/levels.js';
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
  const v = values.filter((x) => x > 0 && Number.isFinite(x)).sort((a, b) => a - b);
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
  COMBOS.forEach((c, k) => { out[k] = robustMax95(rows.map((r) => cellV(r, c.side, c.set))); });
  return out;
}

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
  const m: Meta = { t: at.t, n: at.n, p: snap.p, st: snap.st, sc: snapScales(rows) };
  if (!byT) { byT = new Map(); metas.set(vk, byT); }
  byT.set(at.t, m);
  keepRows(`${vk}|${at.t}`, rows);
  return { meta: m, rows };
}

/** Each listed snapshot, read where needed, the loop given back every YIELD_MS of work. */
async function walk(s: IndexStore, coin: string, venues: readonly Venue[], list: ReadonlyArray<{ t: number; n: number }>, wantRows: boolean): Promise<Array<{ meta: Meta; rows: SnapRow[] | null }>> {
  const vk = venueKey(coin, venues);
  const out: Array<{ meta: Meta; rows: SnapRow[] | null }> = [];
  let since = performance.now();
  for (const at of list) {
    const x = snapOf(s, coin, venues, vk, at, wantRows);
    if (x) out.push(x);
    if (performance.now() - since > YIELD_MS) {
      await nextTurn();
      since = performance.now();
    }
  }
  return out;
}

/** Forget the metas no longer listed (pruned or thinned), keeping the newest MAX_METAS. */
function trimMetas(vk: string, listedTs: ReadonlySet<number>): void {
  const byT = metas.get(vk);
  if (!byT) return;
  for (const t of byT.keys()) if (!listedTs.has(t)) byT.delete(t);
  if (byT.size > MAX_METAS) {
    const ts = [...byT.keys()].sort((a, b) => a - b);
    for (const t of ts.slice(0, ts.length - MAX_METAS)) byT.delete(t);
  }
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
    let list: Array<{ t: number; n: number }> = [];
    let coins: string[] = [];
    try {
      list = listed(s, coin, now - RANGE_MS, Number.MAX_SAFE_INTEGER);
      coins = s.liqHistCoins();
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
    const end = ask.tt + tileMs(ask.tl);
    let after: Array<{ t: number; n: number }> = [];
    try { after = listed(s, coin, ask.tt, Number.MAX_SAFE_INTEGER); } catch { /* no table yet */ }
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

/** Tests: forget every parsed snapshot. */
export function resetLiqTiles(): void {
  metas.clear();
  rowsLru.clear();
  rowsHeld = 0;
  inflight.clear();
  lengthFn = 'octet_length';
}
