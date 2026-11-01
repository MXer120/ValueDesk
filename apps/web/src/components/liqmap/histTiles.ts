/**
 * The historical heatmap's snapshots, read in tiles (owner 2026-11-01: "only what the user sees gets
 * loaded and only when he moves or zooms in/out new gets loaded. Also we should use smart caching").
 *
 * The view read 30 days of every price in one answer: BTC 8.3 MB of JSON (3.0 MB on the wire),
 * 2.9-19 s when the edge had no copy, then parsed whole in the tab, and again every five minutes.
 * Now (server indexer/liqTiles.ts):
 *   the INDEX   every snapshot's time, price and step, and the colour scale per side and leverage
 *               filter - the same heatScale over the same 30 days, so the colours do not move as
 *               tiles arrive. Read a minute apart.
 *   TILES       one time slot x one price band of rows, exact. tilesFor picks the tiles on screen
 *               (read first) and those around them (read next: a pan or a zoom out finds them in),
 *               at the levels that keep them few - a wide window takes wider tiles, not more.
 * Tiles are kept in this tab (a LRU of MAX_ROWS rows, shared by every view of the coin) and a final
 * one by the browser and the edge for a day: a view revisited, a coin switched back, a page opened
 * again draws at once. The slot still filling is asked up to the index's newest snapshot (`v`), so
 * it is read again only when a snapshot was added.
 *
 * A snapshot is drawn from every tile held that reaches the window, of any level, its rows merged by
 * bucket (the same rows, so nothing is counted twice): a zoom shows what it held until its own tiles
 * arrive. A part of the window not read yet has no cells for the moment it takes.
 *
 * The wallet filter reads the one-piece history (its levels are rebuilt from the change log per
 * request), and so does every view while the tile route answers nothing (an API before it).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiqHistory } from '@sign/indexer/liqRead.js';
import type { LiqTile, LiqTileIndex } from '@sign/indexer/liqTiles.js';
import type { Chart as KChart } from 'klinecharts';
import { barMsOf, heatScale, type HeatPoint } from '../../chart/liqHeatIndicator';
import { CANDLE_PANE_ID } from '../../chart/theme';
import type { LevFilter } from '../../chart/liqLev';
import { usePolled } from '../explore/cohorts/parts';
import { vsApi, type Venue } from '../../vsApi';
import { MARGIN, assemble, scaleKeyOf, tileId, tilesFor, type Memo, type TileKey, type TileWindow } from './tileGrid';

export type { TileWindow } from './tileGrid';

/** The index a minute apart: a snapshot every 15 minutes. */
export const INDEX_POLL_MS = 60_000;
/** Rows kept in the tab (~60 bytes each): BTC's 30 days at every price are ~0.4M. */
export const MAX_ROWS = 600_000;
/** A tile that failed is asked again after this. */
const RETRY_MS = 20_000;

// --- the tiles held in this tab ------------------------------------------------------------

interface Held { tile: LiqTile | null; rows: number; failedAt: number; loading: Promise<void> | null; t0: number; t1: number; lo: number; hi: number }
const held = new Map<string, Held>();
let rowsHeld = 0;

function touch(id: string, h: Held): void {
  held.delete(id);
  held.set(id, h);
}

/** Drop the least recently used tiles past MAX_ROWS, never one of `keep`. */
function trim(keep: ReadonlySet<string>): void {
  for (const [id, h] of held) {
    if (rowsHeld <= MAX_ROWS) break;
    if (keep.has(id) || !h.tile) continue;
    held.delete(id);
    rowsHeld -= h.rows;
  }
}

/** Read a tile unless held or on its way: a promise when a read starts, null when there is nothing to do. */
function fetchTile(coin: string, venues: readonly Venue[], vkey: string, k: TileKey): Promise<void> | null {
  const id = tileId(coin, vkey, k);
  const h = held.get(id);
  if (h?.tile) { touch(id, h); return null; }
  if (h?.loading) return null;
  if (h && Date.now() - h.failedAt < RETRY_MS) return null;
  const entry: Held = { tile: null, rows: 0, failedAt: 0, loading: null, t0: k.t0, t1: k.t1, lo: k.lo, hi: k.hi };
  entry.loading = vsApi.liquidationTile(coin, venues, { tl: k.tl, tt: k.tt, pl: k.pl, band: k.band, bw: k.bw, v: k.v }).then(
    (tile) => {
      entry.tile = tile;
      entry.rows = tile.points.reduce((n, q) => n + q.b.length, 0);
      entry.loading = null;
      rowsHeld += entry.rows;
    },
    () => { entry.failedAt = Date.now(); entry.loading = null; },
  );
  held.set(id, entry);
  return entry.loading;
}

/** The tiles held for a coin and venue set that reach a window (any level). */
function heldIn(coin: string, vkey: string, bw: number, w: TileWindow): Array<{ id: string; tile: LiqTile }> {
  const pre = `${coin}|${vkey}|`;
  const out: Array<{ id: string; tile: LiqTile }> = [];
  for (const [id, h] of held) {
    if (!h.tile || !id.startsWith(pre) || h.tile.bw !== bw) continue;
    if (h.t0 < w.t1 && h.t1 > w.t0 && h.lo < w.hi && h.hi > w.lo) out.push({ id, tile: h.tile });
  }
  return out;
}

/** Tests: forget every tile. */
export function resetHistTiles(): void {
  held.clear();
  rowsHeld = 0;
}

// --- the hook ------------------------------------------------------------------------------

export interface HistTiles {
  /** Every snapshot over the 30 days, oldest first: time, price, step (the newest is the history's step now). */
  list: ReadonlyArray<{ t: number; p: number; st: number }>;
  /** The snapshots with their rows over the window (and around it), oldest first. */
  points: HeatPoint[];
  /** The notional a cell is drawn full at, for a side and leverage filter. */
  scale: (side: 'both' | 'long' | 'short', lev: LevFilter) => number;
  /** The index (or the one-piece history) has been read. */
  ready: boolean;
  error: string | null;
}

const EMPTY: HeatPoint[] = [];

/**
 * `coin`'s history over `venues` for the window on screen (null: not measured yet - the newest day
 * around the newest price is read meanwhile, as the chart's candles load). `wallets`: those wallets'
 * history, in one piece. Null coin: nothing read.
 */
export function useHistTiles(coin: string | null, venues: readonly Venue[], view: TileWindow | null, wallets: readonly string[] = []): HistTiles {
  const vkey = venues.join(',');
  const wkey = wallets.join(',');
  const tiled = !!coin && !wallets.length;
  const ir = usePolled<LiqTileIndex>(tiled ? `${coin}|${vkey}|tiles` : null, (s) => vsApi.liquidationTiles(coin!, venues, s), INDEX_POLL_MS);
  const idx = tiled && ir.data && ir.data.coin === coin && ir.data.venues.join(',') === vkey ? ir.data : null;
  // The one-piece history: the wallet filter, or every view while the tile route answers nothing.
  const whole = !!coin && (!!wallets.length || (!!ir.error && !idx));
  const hr = usePolled<LiqHistory>(whole ? `${coin}|${vkey}|30d|${wkey}` : null, (s) => vsApi.liquidationHistory(coin!, venues, '30d', s, wallets), 5 * 60_000);
  const hist = whole && hr.data && hr.data.coin === coin ? hr.data : null;

  const last = idx?.points.at(-1);
  const w = view ?? (idx && last && idx.newest !== null ? { t0: idx.newest - 86_400_000, t1: idx.newest + idx.slot, lo: last.p * 0.97, hi: last.p * 1.03 } : null);
  const want = useMemo(() => (idx && w ? tilesFor(idx, w) : []), [idx?.newest, idx?.bw, idx?.slot, idx?.points[0]?.t, w?.t0, w?.t1, w?.lo, w?.hi]); // eslint-disable-line react-hooks/exhaustive-deps
  const wantKey = idx ? want.map((k) => tileId(coin!, vkey, k)).join(' ') : '';
  const [ver, setVer] = useState(0);
  const venuesRef = useRef(venues);
  venuesRef.current = venues;
  useEffect(() => {
    if (!idx || !want.length || !coin) return;
    let alive = true;
    const bump = () => { if (alive) setVer((v) => v + 1); };
    const read = (ks: readonly TileKey[]) => ks.map((k) => fetchTile(coin, venuesRef.current, vkey, k)).filter((p): p is Promise<void> => !!p).map((p) => p.then(bump));
    // On screen first; around it once that is in. A tile that failed is asked again while it is wanted.
    void Promise.allSettled(read(want.filter((k) => k.near))).then(() => { if (alive) read(want.filter((k) => !k.near)); });
    trim(new Set(want.map((k) => tileId(coin, vkey, k))));
    const again = window.setInterval(() => read(want), RETRY_MS);
    return () => { alive = false; window.clearInterval(again); };
  }, [wantKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const memo = useRef<Memo>(new Map());
  const points = useMemo(() => {
    if (hist) return hist.points as HeatPoint[];
    if (!idx || !w || !coin) return EMPTY;
    const tSpan = Math.max(w.t1 - w.t0, idx.slot);
    const pSpan = w.hi - w.lo;
    const reach: TileWindow = { t0: w.t0 - tSpan * MARGIN, t1: w.t1 + tSpan * MARGIN, lo: w.lo - pSpan * MARGIN, hi: w.hi + pSpan * MARGIN };
    const r = assemble(heldIn(coin, vkey, idx.bw, reach), memo.current);
    memo.current = r.memo;
    return r.points;
  }, [hist, idx, ver, wantKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const scale = useMemo(() => {
    if (hist) {
      const pts = hist.points as HeatPoint[];
      return (side: 'both' | 'long' | 'short', lev: LevFilter) => heatScale(pts, side, lev);
    }
    const sc = idx?.scale;
    return (side: 'both' | 'long' | 'short', lev: LevFilter) => sc?.[scaleKeyOf(side, lev)] ?? 1;
  }, [hist, idx]);

  return {
    list: hist ? hist.points : idx?.points ?? EMPTY,
    points,
    scale,
    ready: !!(hist || idx),
    error: whole ? (hist ? null : hr.error) : idx ? null : ir.error,
  };
}

/**
 * The window a chart shows on its candle pane - the visible bars' times and the price axis - read a
 * few times a second while `on` (a wheel, a drag, a scale switch or a new bar move it, and none of
 * them tells). For the trade chart's heatmap layer (chart/liqIndicators.tsx); the heatmap widget's
 * chart reports its own (LiqHeatmap.tsx ChartPanel).
 */
export function useChartWindow(chart: KChart | null, on: boolean): TileWindow | null {
  const [w, setW] = useState<TileWindow | null>(null);
  useEffect(() => {
    if (!chart || !on) { setW(null); return; }
    const read = () => {
      const pane = chart.getSize(CANDLE_PANE_ID);
      const list = chart.getDataList();
      if (!pane || !(pane.height > 0) || !list.length) return;
      const [top, bot] = chart.convertFromPixel([{ x: 0, y: 0 }, { x: 0, y: pane.height }], { paneId: CANDLE_PANE_ID }) as Array<{ value?: number }>;
      const hi = top?.value;
      const lo = bot?.value;
      if (lo === undefined || hi === undefined || !Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return;
      const r = chart.getVisibleRange();
      const t0 = list[Math.max(0, Math.min(list.length - 1, Math.floor(r.realFrom)))]!.timestamp;
      const t1 = list[Math.max(0, Math.min(list.length - 1, Math.ceil(r.realTo) - 1))]!.timestamp + barMsOf(list);
      setW((x) => (x && x.t0 === t0 && x.t1 === t1 && x.lo === lo && x.hi === hi ? x : { t0, t1, lo: Math.max(0, lo), hi }));
    };
    read();
    const t = window.setInterval(read, 400);
    return () => window.clearInterval(t);
  }, [chart, on]);
  return w;
}
