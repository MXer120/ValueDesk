/**
 * The historical heatmap's tile grid, without React (the tests run it in node): which tiles a window
 * takes, and the snapshots put back together from the tiles held. The hook and the why: histTiles.ts.
 */
import type { KLineData } from 'klinecharts';
import type { LiqTile, LiqTileIndex, TileAsk } from '@sign/indexer/liqTiles.js';
import { barMsOf, type HeatPoint } from '../../chart/liqHeatIndicator';
import { isAllLev, type LevFilter } from '../../chart/liqLev';

/** The window on screen: times (ms) and prices. */
export interface TileWindow { t0: number; t1: number; lo: number; hi: number }
export type TileGrid = Pick<LiqTileIndex, 'newest' | 'slot' | 'bw' | 'tLevels' | 'pLevels'> & Partial<Pick<LiqTileIndex, 'points'>>;
export interface TileKey extends TileAsk {
  /** On screen (read first), or around it. */
  near: boolean;
  /** Its time slot (one snapshot alone: [at, at + 1)) and price band. */
  t0: number; t1: number; lo: number; hi: number;
}

/**
 * The chart's bars as the layer draws them: `every` ms long, starting at `off` modulo it (chart/liqHeatIndicator.ts
 * snapshotFor draws the newest snapshot before each bar's end). A tile asked with them holds only those (server
 * liqTiles.ts every/off). Null: every snapshot.
 */
export interface DrawGrid { every: number; off: number }

/** The snapshots' interval: a bar this long or shorter draws every snapshot, nothing to cut. */
export const SNAPSHOT_MS = 15 * 60_000;
/** The longest bar the server cuts to (server liqTiles.ts EVERY_MAX_MS: a week). */
export const DRAW_MAX_MS = 7 * 86_400_000;

/**
 * The bars a chart's data draws as the heatmap layer reads them (liqHeatIndicator.ts: barMsOf, and snapshotFor of each
 * bar's start): `every` the bar, `off` where the bars begin modulo it - only when every bar starts on that grid (a month
 * is no fixed length, a gap at the end changes barMsOf), and the bar is longer than a snapshot. Else null: every snapshot.
 */
export function drawGridOf(list: ReadonlyArray<{ timestamp: number }>): DrawGrid | null {
  if (list.length < 2) return null;
  const every = barMsOf(list as KLineData[]);
  if (!(every > SNAPSHOT_MS) || every > DRAW_MAX_MS || !Number.isInteger(every)) return null;
  const last = list[list.length - 1]!.timestamp;
  for (const k of list) if ((last - k.timestamp) % every !== 0) return null;
  return { every, off: ((last % every) + every) % every };
}

/** What a view's tiles are cut to (server liqTiles.ts): its bars, slim rows, the slot still filling grown by single snapshots. */
export interface TileCut {
  draw?: DrawGrid | null;
  /** Rows of [bucket, long, short] only: a view by side with every leverage band reads nothing else. */
  slim?: boolean;
  /**
   * The 6 h slot still filling, once a tile of it up to `v` is held (heldV): that tile and one tile per snapshot drawn
   * since (`at`, each final once it exists), not the whole slot again; and the slot once passed, while the singles of
   * what it gained since are held, those instead of its 6 h tile. Needs the index's points.
   */
  singles?: boolean;
  /** Is this tile held? */
  has?: (k: TileKey) => boolean;
  /** The newest `v` of a tile held for this key's 6 h slot, band and cut (its own `v` aside); null: none. */
  heldV?: (k: TileKey) => number | null;
}

/** The snapshots of [t0, t1) the bars draw (the newest of each, liqRead.ts FineDraw's rule), oldest first. */
export function drawnIn(points: ReadonlyArray<{ t: number }>, t0: number, t1: number, draw: DrawGrid | null | undefined): number[] {
  const out: number[] = [];
  let bar = Number.NaN;
  for (const q of points) {
    if (q.t < t0 || q.t >= t1) continue;
    const b = draw ? Math.floor((q.t - draw.off) / draw.every) : q.t;
    if (b === bar) out[out.length - 1] = q.t; else { out.push(q.t); bar = b; }
  }
  return out;
}

/** The history the index lists (server liqTiles.ts RANGE_MS). */
export const RANGE_MS = 30 * 86_400_000;
/** Tiles across the window at most, before a level of wider ones is taken. */
const TIME_TILES = 4;
const PRICE_TILES = 3;
/** Read around the window, this share of it each side (to the left in time: the right edge is now). */
export const MARGIN = 0.5;

export const tileMsOf = (g: Pick<TileGrid, 'slot'>, tl: number): number => g.slot * 4 ** tl;
export const bandSpanOf = (bw: number, pl: number): number => +(bw * 4 ** pl).toPrecision(12);

/** A filter's key in the index's scales (server liqTiles.ts scaleKey). */
export const scaleKeyOf = (side: 'both' | 'long' | 'short', lev: LevFilter): string => `${side}|${isAllLev(lev) ? 'all' : lev.join(',')}`;

/**
 * The tiles a window needs, on screen first: time slots of the level that keeps the window within
 * TIME_TILES of them, price bands of the level within PRICE_TILES, and MARGIN of the window around
 * it. A slot of a wider level is taken only once final; the one still filling is taken as the final
 * slots one level down it holds, down to the 6 h slot still filling, asked up to the newest snapshot -
 * with `cut.singles` once: then the snapshots added since one tile each (2026-11-17: the slot's tile was
 * read whole again at every new snapshot, 1 to 24 of them; a single is final and shared at once).
 * `cut.draw` / `cut.slim` go on every slot's tile (a single is one snapshot whatever the bars).
 */
export function tilesFor(g: TileGrid, w: TileWindow, cut: TileCut = {}): TileKey[] {
  const newest = g.newest;
  if (newest === null || !(g.bw > 0) || !(w.t1 > w.t0) || !(w.hi > w.lo)) return [];
  const tSpan = Math.max(w.t1 - w.t0, g.slot);
  const pSpan = w.hi - w.lo;
  let tl = 0;
  while (tl < g.tLevels - 1 && tSpan / tileMsOf(g, tl) > TIME_TILES) tl++;
  let pl = 0;
  while (pl < g.pLevels - 1 && pSpan / bandSpanOf(g.bw, pl) > PRICE_TILES) pl++;
  // Never before the oldest snapshot listed: a daily chart spans months, and the tiles before it are empty.
  const from = Math.max(w.t0 - tSpan * MARGIN, newest - RANGE_MS, g.points?.[0]?.t ?? -Infinity);
  const to = Math.min(w.t1 + tSpan * MARGIN, newest + 1);
  if (!(to > from)) return [];
  const span = bandSpanOf(g.bw, pl);
  const b0 = Math.max(0, Math.floor(Math.max(0, w.lo - pSpan * MARGIN) / span));
  const b1 = Math.max(b0, Math.floor((w.hi + pSpan * MARGIN) / span));
  const fields = cut.slim ? { fields: 'ls' as const } : {};
  const bars = cut.draw ? { every: cut.draw.every, off: cut.draw.off } : {};
  const singlesOn = !!cut.singles && !!g.points?.length && !!cut.heldV;
  type Slot = { tl: number; tt: number; v?: number; at?: number };
  const keyOf = (s: Slot, band: number): TileKey => {
    const t0 = s.at ?? s.tt;
    const t1 = s.at !== undefined ? s.at + 1 : s.tt + tileMsOf(g, s.tl);
    const lo = band * span;
    const hi = lo + span;
    const near = t0 < w.t1 && t1 > w.t0 && lo < w.hi && hi > w.lo;
    return { ...s, pl, band, bw: g.bw, ...fields, ...(s.at === undefined ? bars : {}), near, t0, t1, lo, hi };
  };
  /**
   * A 6 h slot in one band. Still filling: up to the newest snapshot, or the tile of it held up to `v` and the snapshots
   * drawn since as singles. Passed: its tile - or, unless that is held, the tile up to `v` and the singles after it while
   * every one of them is held (a view that watched it fill reads nothing more for it).
   */
  const slot0 = (tt: number, open: boolean, band: number): Slot[] => {
    const whole: Slot = open ? { tl: 0, tt, v: newest } : { tl: 0, tt };
    if (!singlesOn) return [whole];
    if (!open && cut.has?.(keyOf(whole, band))) return [whole];
    const v = cut.heldV!(keyOf({ tl: 0, tt, v: newest }, band));
    if (v === null || (open && v >= newest)) return [whole];
    const since: Slot[] = drawnIn(g.points!, tt, open ? newest + 1 : tt + g.slot, cut.draw).filter((t) => t > v).map((at) => ({ tl: 0, tt, at }));
    if (!open && !since.every((x) => cut.has?.(keyOf(x, band)))) return [whole];
    return [{ tl: 0, tt, v }, ...since];
  };
  const slots: Array<Slot | { open: boolean; tt: number }> = [];
  const cover = (level: number, tt: number) => {
    const ms = tileMsOf(g, level);
    if (tt + ms <= newest) slots.push(level === 0 ? { open: false, tt } : { tl: level, tt });
    else if (level === 0) slots.push({ open: true, tt });
    else for (let s = tt; s < Math.min(tt + ms, to); s += ms / 4) cover(level - 1, s);
  };
  const ms = tileMsOf(g, tl);
  for (let tt = Math.floor(from / ms) * ms; tt < to; tt += ms) cover(tl, tt);
  const out: TileKey[] = [];
  for (const s of slots) {
    for (let band = b0; band <= b1; band++) {
      if ('open' in s) for (const x of slot0(s.tt, s.open, band)) out.push(keyOf(x, band));
      else out.push(keyOf(s, band));
    }
  }
  // On screen first, the newest first (the right edge is where the eye is).
  return out.sort((a, b) => Number(b.near) - Number(a.near) || b.t0 - a.t0 || a.band - b.band);
}

/** A tile's cache key: the URL's parts. */
export const tileId = (coin: string, vkey: string, k: TileAsk): string => {
  const base = `${coin}|${vkey}|${k.tl}|${k.tt}|${k.pl}|${k.band}|${k.bw}|${k.v ?? ''}`;
  return k.at === undefined && k.fields === undefined && !k.every ? base : `${base}|${k.at ?? ''}|${k.fields ?? ''}|${k.every ?? ''}|${k.off ?? ''}`;
};

/** A tile's slot, band and cut without its `v` / `at`: the tiles of one slot still filling that grow it (TileCut heldV). */
export const slotId = (coin: string, vkey: string, k: TileAsk): string =>
  `${coin}|${vkey}|${k.tl}|${k.tt}|${k.pl}|${k.band}|${k.bw}|${k.fields ?? ''}|${k.every ?? ''}|${k.off ?? ''}`;

/** A snapshot's rows from several tiles: merged by bucket, lowest first (a bucket two tiles hold is the same row). */
export function mergeRows(parts: ReadonlyArray<HeatPoint['b']>): HeatPoint['b'] {
  if (parts.length === 1) return parts[0]!;
  const all = parts.flat().sort((a, b) => a[0] - b[0]);
  const out: HeatPoint['b'] = [];
  let last = Number.NaN;
  for (const r of all) if (r[0] !== last) { out.push(r); last = r[0]; }
  return out;
}

export type Memo = Map<number, { sig: string; q: HeatPoint }>;

/**
 * The snapshots the tiles hold, oldest first, each from every tile that has it. A snapshot whose
 * tiles have not changed keeps its object (the layer caches its cells per point).
 */
export function assemble(tiles: ReadonlyArray<{ id: string; tile: Pick<LiqTile, 'points'> }>, prev: Memo): { points: HeatPoint[]; memo: Memo } {
  const byT = new Map<number, { p: number; st: number; ids: string[]; parts: HeatPoint['b'][] }>();
  for (const { id, tile } of tiles) {
    for (const q of tile.points) {
      let e = byT.get(q.t);
      if (!e) { e = { p: q.p, st: q.st, ids: [], parts: [] }; byT.set(q.t, e); }
      e.ids.push(id);
      e.parts.push(q.b as HeatPoint['b']);
    }
  }
  const memo: Memo = new Map();
  const points: HeatPoint[] = [];
  for (const t of [...byT.keys()].sort((a, b) => a - b)) {
    const e = byT.get(t)!;
    const sig = [...e.ids].sort().join(' ');
    const old = prev.get(t);
    const q = old && old.sig === sig ? old.q : { t, p: e.p, st: e.st, b: mergeRows(e.parts) };
    memo.set(t, { sig, q });
    points.push(q);
  }
  return { points, memo };
}
