/**
 * The historical heatmap's tile grid, without React (the tests run it in node): which tiles a window
 * takes, and the snapshots put back together from the tiles held. The hook and the why: histTiles.ts.
 */
import type { LiqTile, LiqTileIndex, TileAsk } from '@sign/indexer/liqTiles.js';
import type { HeatPoint } from '../../chart/liqHeatIndicator';
import { isAllLev, type LevFilter } from '../../chart/liqLev';

/** The window on screen: times (ms) and prices. */
export interface TileWindow { t0: number; t1: number; lo: number; hi: number }
export type TileGrid = Pick<LiqTileIndex, 'newest' | 'slot' | 'bw' | 'tLevels' | 'pLevels'>;
export interface TileKey extends TileAsk {
  /** On screen (read first), or around it. */
  near: boolean;
  /** Its time slot and price band. */
  t0: number; t1: number; lo: number; hi: number;
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
 * slots one level down it holds, down to the 6 h slot still filling, asked up to the newest snapshot.
 */
export function tilesFor(g: TileGrid, w: TileWindow): TileKey[] {
  const newest = g.newest;
  if (newest === null || !(g.bw > 0) || !(w.t1 > w.t0) || !(w.hi > w.lo)) return [];
  const tSpan = Math.max(w.t1 - w.t0, g.slot);
  const pSpan = w.hi - w.lo;
  let tl = 0;
  while (tl < g.tLevels - 1 && tSpan / tileMsOf(g, tl) > TIME_TILES) tl++;
  let pl = 0;
  while (pl < g.pLevels - 1 && pSpan / bandSpanOf(g.bw, pl) > PRICE_TILES) pl++;
  const from = Math.max(w.t0 - tSpan * MARGIN, newest - RANGE_MS);
  const to = Math.min(w.t1 + tSpan * MARGIN, newest + 1);
  if (!(to > from)) return [];
  const span = bandSpanOf(g.bw, pl);
  const b0 = Math.max(0, Math.floor(Math.max(0, w.lo - pSpan * MARGIN) / span));
  const b1 = Math.max(b0, Math.floor((w.hi + pSpan * MARGIN) / span));
  const slots: Array<{ tl: number; tt: number; v?: number }> = [];
  const cover = (level: number, tt: number) => {
    const ms = tileMsOf(g, level);
    if (tt + ms <= newest) slots.push({ tl: level, tt });
    else if (level === 0) slots.push({ tl: 0, tt, v: newest });
    else for (let s = tt; s < Math.min(tt + ms, to); s += ms / 4) cover(level - 1, s);
  };
  const ms = tileMsOf(g, tl);
  for (let tt = Math.floor(from / ms) * ms; tt < to; tt += ms) cover(tl, tt);
  const out: TileKey[] = [];
  for (const s of slots) {
    const t1 = s.tt + tileMsOf(g, s.tl);
    for (let band = b0; band <= b1; band++) {
      const lo = band * span;
      const hi = lo + span;
      const near = s.tt < w.t1 && t1 > w.t0 && lo < w.hi && hi > w.lo;
      out.push({ ...s, pl, band, bw: g.bw, near, t0: s.tt, t1, lo, hi });
    }
  }
  // On screen first, the newest first (the right edge is where the eye is).
  return out.sort((a, b) => Number(b.near) - Number(a.near) || b.tt - a.tt || a.band - b.band);
}

/** A tile's cache key: the URL's parts. */
export const tileId = (coin: string, vkey: string, k: TileAsk): string => `${coin}|${vkey}|${k.tl}|${k.tt}|${k.pl}|${k.band}|${k.bw}|${k.v ?? ''}`;

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
