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
 * The wallet filter reads tiles too (`wallets`: the server rebuilds the wallets' history from the
 * change log once a minute and cuts the same tiles from it, kept five minutes); every view reads
 * the one-piece history only while the tile route answers nothing (an API before it).
 *
 * WHAT IS DRAWN ONLY (perf pass 2026-11-17, phones on slow links; server liqTiles.ts). A view with
 * a chart reads nothing before the chart reports its window (`waitForView`: a 1m phone chart needs 2
 * tiles of 11 KB, the default day window was 15 of 258 KB); a view by side with every band reads
 * slim rows (`slim`: -49%); a chart of bars longer than a snapshot reads the snapshot each bar draws
 * (`draw`: a 1 h chart a quarter of them); the slot still filling is read whole once, then a
 * snapshot at a time, each final at once. A view by leverage reads whole rows and never draws a slim tile's.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiqHistory } from '@sign/indexer/liqRead.js';
import type { LiqTile, LiqTileIndex } from '@sign/indexer/liqTiles.js';
import type { Chart as KChart } from 'klinecharts';
import { barMsOf, heatScale, type HeatPoint } from '../../chart/liqHeatIndicator';
import { CANDLE_PANE_ID } from '../../chart/theme';
import { followChart } from '../../chart/candleDraws';
import type { LevFilter } from '../../chart/liqLev';
import { usePolled } from '../explore/cohorts/parts';
import { VsError, vsApi, type Venue } from '../../vsApi';
import { MARGIN, assemble, drawGridOf, scaleKeyOf, slotId, tileId, tilesFor, type DrawGrid, type Memo, type TileGrid, type TileKey, type TileWindow } from './tileGrid';

export { drawGridOf } from './tileGrid';
export type { DrawGrid, TileWindow } from './tileGrid';

/** The index a minute apart: a snapshot every 15 minutes. */
export const INDEX_POLL_MS = 60_000;
/** Rows kept in the tab (~60 bytes each): BTC's 30 days at every price are ~0.4M. */
export const MAX_ROWS = 600_000;
/** A tile that failed is asked again after this, doubling to RETRY_MAX_MS. */
const RETRY_MS = 3_000;
const RETRY_MAX_MS = 24_000;
/** Tiles asked at once: in the order wanted (on screen, newest first), so what is looked at is never behind what is not. */
const PARALLEL = 6;
/** A window that rests this long is read. */
const SETTLE_MS = 350;
/** An index the server is still reading (its answer 'building': a venue set read for the first time) is asked again after this. */
export const BUILD_RETRY_MS = 2_000;

// --- the tiles held in this tab ------------------------------------------------------------

interface Held { tile: LiqTile | null; rows: number; failedAt: number; fails: number; loading: Promise<void> | null; t0: number; t1: number; lo: number; hi: number; slot?: string; v?: number }
const held = new Map<string, Held>();
let rowsHeld = 0;
/** The `v` of each tile held of a 6 h slot still filling, by slot, band and cut (tileGrid.ts slotId): what singles grow it from. */
const heldVs = new Map<string, Set<number>>();

function forget(id: string, h: Held): void {
  held.delete(id);
  rowsHeld -= h.rows;
  if (h.slot !== undefined && h.v !== undefined) heldVs.get(h.slot)?.delete(h.v);
}

/** The newest `v` held for a key's slot (TileCut heldV). */
function heldV(coin: string, vkey: string, k: TileKey): number | null {
  const vs = heldVs.get(slotId(coin, vkey, k));
  if (!vs?.size) return null;
  let v = Number.NEGATIVE_INFINITY;
  for (const x of vs) if (x > v) v = x;
  return v;
}

function touch(id: string, h: Held): void {
  held.delete(id);
  held.set(id, h);
}

/** Drop the least recently used tiles past MAX_ROWS, never one of `keep`. */
function trim(keep: ReadonlySet<string>): void {
  for (const [id, h] of held) {
    if (rowsHeld <= MAX_ROWS) break;
    if (keep.has(id) || !h.tile) continue;
    forget(id, h);
  }
}

/**
 * Read a tile unless held: its promise, also when it is already on its way - asked by the window before, whose own
 * redraw is off by then (2026-11-23: a tile that landed after the window moved was held but not drawn). Null: nothing to wait for.
 */
function fetchTile(coin: string, venues: readonly Venue[], vkey: string, k: TileKey, wallets: readonly string[]): Promise<void> | null {
  const id = tileId(coin, vkey, k);
  const h = held.get(id);
  if (h?.tile) { touch(id, h); return null; }
  if (h?.loading) return h.loading;
  if (h && Date.now() - h.failedAt < Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (h.fails - 1))) return null;
  const entry: Held = { tile: null, rows: 0, failedAt: 0, fails: h?.fails ?? 0, loading: null, t0: k.t0, t1: k.t1, lo: k.lo, hi: k.hi, ...(k.v !== undefined ? { slot: slotId(coin, vkey, k), v: k.v } : {}) };
  entry.loading = vsApi.liquidationTile(coin, venues, { tl: k.tl, tt: k.tt, pl: k.pl, band: k.band, bw: k.bw, v: k.v, at: k.at, fields: k.fields, every: k.every, off: k.off }, undefined, wallets).then(
    (tile) => {
      entry.tile = tile;
      entry.rows = tile.points.reduce((n, q) => n + q.b.length, 0);
      entry.loading = null;
      rowsHeld += entry.rows;
      if (entry.slot !== undefined && entry.v !== undefined) {
        let vs = heldVs.get(entry.slot);
        if (!vs) { vs = new Set(); heldVs.set(entry.slot, vs); }
        vs.add(entry.v);
      }
    },
    () => { entry.failedAt = Date.now(); entry.fails++; entry.loading = null; },
  );
  held.set(id, entry);
  return entry.loading;
}

/**
 * The tiles held for a coin and venue set that reach a window (any level, any bars: each holds real snapshots, the same
 * rows wherever two hold one). A slim tile only for a slim view: a view by leverage reads a row's bands.
 */
function heldIn(coin: string, vkey: string, bw: number, w: TileWindow, slim: boolean): Array<{ id: string; tile: LiqTile }> {
  const pre = `${coin}|${vkey}|`;
  const out: Array<{ id: string; tile: LiqTile }> = [];
  for (const [id, h] of held) {
    if (!h.tile || !id.startsWith(pre) || h.tile.bw !== bw) continue;
    if (!slim && h.tile.fields === 'ls') continue;
    if (h.t0 < w.t1 && h.t1 > w.t0 && h.lo < w.hi && h.hi > w.lo) out.push({ id, tile: h.tile });
  }
  return out;
}

/** Tests: forget every tile. */
export function resetHistTiles(): void {
  held.clear();
  heldVs.clear();
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
  /** The tile grid the index gives (null: none, or the one-piece history): the fine tiles' too (histFine.ts). */
  grid: TileGrid | null;
  /** The server is reading the index for the first time: how many of its snapshots are done (asked again shortly). */
  building: { done: number; of: number } | null;
  /** The tiles on screen: how many are in, while some are not (null: all in). */
  reading: { done: number; of: number } | null;
  error: string | null;
}

export interface HistTileOpts {
  /** The caller's chart reports its window (useChartWindow, LiqHeatmap's ChartPanel): nothing is read until it has. */
  waitForView?: boolean;
  /** Only [bucket, long, short] is drawn (by side, every leverage band): slim tiles. */
  slim?: boolean;
  /** The chart's bars (drawGridOf), or that from the newest snapshot (null: every snapshot). */
  draw?: DrawGrid | null | ((newest: { st: number; p: number } | null) => DrawGrid | null);
}

const EMPTY: HeatPoint[] = [];

/**
 * `coin`'s history over `venues` for the window on screen (null: not measured yet - unless `o.waitForView`, the newest
 * day around the newest price is read meanwhile). `wallets`: those wallets' history. Null coin: nothing read.
 */
export function useHistTiles(coin: string | null, venues: readonly Venue[], view: TileWindow | null, wallets: readonly string[] = [], o: HistTileOpts = {}): HistTiles {
  const wkey = wallets.join(',');
  // The tiles held are keyed by the venues and, with the wallet filter, its wallets.
  const vkey = wallets.length ? `${venues.join(',')}|w:${wkey}` : venues.join(',');
  const tiled = !!coin;
  const ikey = tiled ? `${coin}|${vkey}|tiles` : null;
  // A venue set the server reads for the first time answers how far it is ('building') within a few seconds: asked again
  // BUILD_RETRY_MS later, not at the next poll a minute on (it was a 504 after 30 s).
  const [building, setBuilding] = useState<{ key: string; done: number; of: number } | null>(null);
  const ir = usePolled<LiqTileIndex>(ikey, (s) => vsApi.liquidationTiles(coin!, venues, s, wallets).then(
    (x) => { setBuilding(null); return x; },
    (e: unknown) => {
      if (e instanceof VsError && e.code === 'building') {
        const b = (e.body ?? {}) as { done?: unknown; of?: unknown };
        setBuilding({ key: ikey!, done: Number(b.done) || 0, of: Number(b.of) || 0 });
      }
      throw e;
    },
  ), INDEX_POLL_MS);
  const idx = tiled && ir.data && ir.data.coin === coin && !ir.stale ? ir.data : null;
  const buildingNow = building && building.key === ikey && !idx && !!ir.error ? building : null;
  useEffect(() => {
    if (!building || building.key !== ikey) return;
    const t = window.setTimeout(ir.retry, BUILD_RETRY_MS);
    return () => window.clearTimeout(t);
  }, [building]); // eslint-disable-line react-hooks/exhaustive-deps
  // An index still being read ('partial'): every snapshot listed, so the tiles on screen are asked now; its scale follows.
  const partial = !!idx?.partial;
  useEffect(() => {
    if (!partial) return;
    const t = window.setTimeout(ir.retry, BUILD_RETRY_MS);
    return () => window.clearTimeout(t);
  }, [idx]); // eslint-disable-line react-hooks/exhaustive-deps
  // The one-piece history: only for a server without the tile route (404). Not when the tile index failed or timed out:
  // then every open view asked the heaviest answer there is (30 days of snapshots: BTC 64.6 MB) of a server already
  // slow - on 2026-11-07, while tiles took 4-19 s, history asks held the API 12-53 s each.
  const whole = !!coin && !!ir.error && !idx && /\b404\b|not found/i.test(ir.error);
  const hr = usePolled<LiqHistory>(whole ? `${coin}|${vkey}|30d|${wkey}` : null, (s) => vsApi.liquidationHistory(coin!, venues, '30d', s, wallets), 5 * 60_000);
  const hist = whole && hr.data && hr.data.coin === coin ? hr.data : null;

  const last = idx?.points.at(-1);
  const w = view ?? (!o.waitForView && idx && last && idx.newest !== null ? { t0: idx.newest - 86_400_000, t1: idx.newest + idx.slot, lo: last.p * 0.97, hi: last.p * 1.03 } : null);
  const draw = typeof o.draw === 'function' ? o.draw(last ? { st: last.st, p: last.p } : null) : o.draw ?? null;
  const slim = !!o.slim;
  const want = useMemo(() => (idx && w && coin
    ? tilesFor(idx, w, { slim, draw, singles: true, dense: true, has: (k) => !!held.get(tileId(coin, vkey, k))?.tile, heldV: (k) => heldV(coin, vkey, k) })
    : []), [idx?.newest, idx?.bw, idx?.slot, idx?.points[0]?.t, idx?.points.length, w?.t0, w?.t1, w?.lo, w?.hi, slim, draw?.every, draw?.off]); // eslint-disable-line react-hooks/exhaustive-deps
  const wantKey = idx ? want.map((k) => tileId(coin!, vkey, k)).join(' ') : '';
  const [ver, setVer] = useState(0);
  const venuesRef = useRef(venues);
  venuesRef.current = venues;
  const walletsRef = useRef(wallets);
  walletsRef.current = wallets;
  useEffect(() => {
    if (!idx || !want.length || !coin) return;
    let alive = true;
    const bump = () => { if (alive) setVer((v) => v + 1); };
    // A few at once, in order: on screen first, around it once none of those is on its way; each drawn as it lands. A tile
    // that failed is asked again while it is wanted; one not begun when the window moves is never asked.
    const waiting = new Set<string>();
    let nearLeft = 0;
    const pump = () => {
      if (!alive) return;
      for (const k of want) {
        if (waiting.size >= PARALLEL || (!k.near && nearLeft > 0)) return;
        const id = tileId(coin, vkey, k);
        if (waiting.has(id)) continue;
        const p = fetchTile(coin, venuesRef.current, vkey, k, walletsRef.current);
        if (!p) continue;
        waiting.add(id);
        if (k.near) nearLeft++;
        void p.then(() => {
          waiting.delete(id);
          if (k.near) nearLeft--;
          bump();
          pump();
        });
      }
    };
    // Once the window rests: a timeframe switch or a drag passes through windows nobody looks at.
    const rest = window.setTimeout(pump, SETTLE_MS);
    trim(new Set(want.map((k) => tileId(coin, vkey, k))));
    const again = window.setInterval(pump, RETRY_MS);
    return () => { alive = false; window.clearTimeout(rest); window.clearInterval(again); };
  }, [wantKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const memo = useRef<Memo>(new Map());
  const points = useMemo(() => {
    if (hist) return hist.points as HeatPoint[];
    if (!idx || !w || !coin) return EMPTY;
    const tSpan = Math.max(w.t1 - w.t0, idx.slot);
    const pSpan = w.hi - w.lo;
    const reach: TileWindow = { t0: w.t0 - tSpan * MARGIN, t1: w.t1 + tSpan * MARGIN, lo: w.lo - pSpan * MARGIN, hi: w.hi + pSpan * MARGIN };
    const r = assemble(heldIn(coin, vkey, idx.bw, reach, slim), memo.current);
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

  const near = coin && idx && !hist ? want.filter((k) => k.near) : [];
  const nearIn = near.reduce((n, k) => n + (held.get(tileId(coin!, vkey, k))?.tile ? 1 : 0), 0);

  return {
    list: hist ? hist.points : idx?.points ?? EMPTY,
    points,
    scale,
    ready: !!(hist || idx),
    grid: hist ? null : idx,
    building: buildingNow ? { done: buildingNow.done, of: buildingNow.of } : null,
    reading: nearIn < near.length ? { done: nearIn, of: near.length } : null,
    error: whole ? (hist ? null : hr.error) : idx || buildingNow ? null : ir.error,
  };
}

/**
 * The window a chart shows on its candle pane - the visible bars' times and the price axis - read
 * after each redraw of the pane while `on` (a wheel, a drag, a scale switch or a new bar move it,
 * and each redraws it: chart/candleDraws.ts), and its bars (drawGridOf). For the trade chart's heatmap layer
 * (chart/liqIndicators.tsx); the heatmap widget's chart reports its own (LiqHeatmap.tsx ChartPanel).
 */
export function useChartWindow(chart: KChart | null, on: boolean): (TileWindow & { draw: DrawGrid | null }) | null {
  const [w, setW] = useState<(TileWindow & { draw: DrawGrid | null }) | null>(null);
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
      const d = drawGridOf(list);
      const l0 = Math.max(0, lo);
      setW((x) => (x && x.t0 === t0 && x.t1 === t1 && x.lo === l0 && x.hi === hi && x.draw?.every === d?.every && x.draw?.off === d?.off ? x : { t0, t1, lo: l0, hi, draw: d }));
    };
    return followChart(chart, CANDLE_PANE_ID, read);
  }, [chart, on]);
  return w;
}
