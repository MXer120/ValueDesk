/**
 * The historical heatmap at a step finer than its snapshots keep (BTC $10, $1), in tiles - so every
 * column on screen is drawn at the step picked, every time (owner 2026-11-02: "Granulairity selected
 * but sometimes it just doesnt load the granularity everywhere ... autogranularity doesnt work it
 * just loads the last snaphot instead of changing all!").
 *
 * It was one answer for the window (server liqRead.ts liqHistoryFine), cut at 80k rows: on a wide
 * window most columns came back without their fine levels and stayed at the snapshots' $100 (BTC,
 * $10, 1H: 572 of 625). And each zoom or pan asked a new one (0.7-1.6 s), the columns it did not
 * hold at $100 meanwhile, while the newest - the stream's - switched at once.
 *
 * Now the window's tiles, on the snapshots' own grid (tileGrid.ts tilesFor), each:
 *   one snapshot per bar   the one the chart draws for it (`every`, `off`: liqHeatIndicator.ts
 *                          snapshotFor), not the three a 1H bar would skip;
 *   pooled to the pixel    finer than a pixel, the strongest cell of each group of `pool` (at most
 *                          a pixel) as the view counts it - the cell the chart draws there (it
 *                          draws the strongest cell of a pixel row, liqHeatIndicator.ts);
 * read on screen first, then around it, kept in the tab and a final one a day at the edge.
 * The step drawn is one for every column: the step asked once its tiles on screen are in, until
 * then the step drawn before if its tiles cover the window (a zoom, a pan), else the columns wait
 * (blank, "Reading the $10 levels…"), never their $100.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiqHistoryFine } from '@sign/indexer/liqRead.js';
import type { HeatPoint } from '../../chart/liqHeatIndicator';
import type { LevFilter } from '../../chart/liqLev';
import { vsApi, type Venue } from '../../vsApi';
import { mergeRows, tileId, tilesFor, type TileGrid, type TileKey, type TileWindow } from './tileGrid';

/** What the fine tiles are cut to: the step, the chart's bars, the pooling, the counting. */
export interface FineView {
  step: number;
  /** The chart's bar (ms) and where its bars begin modulo it; 0: every snapshot. */
  every: number;
  off: number;
  /** Price width a pooled group spans (a whole number of steps, at most a pixel); 0: every cell. */
  pool: number;
  side: 'long' | 'short' | 'both';
  lev: LevFilter;
  /** Some wallets only (their levels from the change log, as at $100); none: every wallet. */
  wallets: readonly string[];
}

/** A snapshot's fine part as drawn (HeatPoint f). */
export type FinePart = NonNullable<HeatPoint['f']>;

/** Tests: how long a failed tile waits before it is asked again. */
export const FINE_RETRY_MS = 20_000;
/** Tiles asked at once: the server reads three at a time (liqHistThread.ts THREADS). */
const PARALLEL = 4;
/** A window that rests this long is read (histTiles.ts). */
const SETTLE_MS = 350;

/**
 * The pool for a step and the price a pixel spans: the largest power of two of steps within a
 * pixel (0 below two steps a pixel: every cell is read).
 */
export function poolOf(step: number, perPx: number): number {
  const g = perPx / step;
  if (!(g >= 2) || !Number.isFinite(g)) return 0;
  return +(step * 2 ** Math.floor(Math.log2(g))).toPrecision(12);
}

/** The key of a view's tiles (everything but the tile itself). */
export const viewKey = (coin: string, vkey: string, v: FineView): string =>
  `${coin}|${vkey}|${v.step}|${v.every}|${v.off}|${v.pool}|${v.side}|${[...v.lev].sort().join(',')}|${v.wallets.join(',')}`;
export const fineTileId = (vk: string, k: TileKey): string => `${vk}#${tileId('', '', k)}`;

/** One snapshot's parts from several price bands: the contiguous run of them that is longest. */
export function mergeParts(parts: ReadonlyArray<{ lo: number; hi: number; st: number; b: HeatPoint['b'] }>): FinePart | null {
  if (!parts.length) return null;
  const sorted = [...parts].sort((a, b) => a.lo - b.lo);
  const eps = 1e-9 * Math.max(1, sorted[0]!.st);
  let best: typeof sorted = [];
  let run: typeof sorted = [];
  for (const p of sorted) {
    if (run.length && p.lo > run.at(-1)!.hi + eps) run = [];
    run.push(p);
    const span = (r: typeof sorted) => (r.length ? r.at(-1)!.hi - r[0]!.lo : -1);
    if (span(run) > span(best)) best = [...run];
  }
  return { st: best[0]!.st, lo: best[0]!.lo, hi: Math.max(...best.map((p) => p.hi)), b: mergeRows(best.map((p) => p.b)) };
}

/** The parts the tiles held for one view hold, by snapshot time. */
export function partsOf(tiles: ReadonlyArray<Pick<LiqHistoryFine, 'points'>>): Map<number, FinePart> {
  const by = new Map<number, Array<{ lo: number; hi: number; st: number; b: HeatPoint['b'] }>>();
  for (const tile of tiles) {
    for (const q of tile.points) {
      let a = by.get(q.t);
      if (!a) by.set(q.t, (a = []));
      a.push({ lo: q.lo, hi: q.hi, st: q.st, b: q.b as HeatPoint['b'] });
    }
  }
  const out = new Map<number, FinePart>();
  for (const [t, a] of by) { const f = mergeParts(a); if (f) out.set(t, f); }
  return out;
}

/**
 * The snapshots as drawn at the fine step: each the chart draws (`drawn`) with its part; one from
 * `since` on without a part yet waits (drawn blank: no cell of its own step shows through). Before
 * `since` the fine levels were never kept: its own step.
 */
export function withParts(points: readonly HeatPoint[], parts: ReadonlyMap<number, FinePart>, since: number | null, step: number, waiting: boolean): HeatPoint[] {
  return points.map((q) => {
    const f = parts.get(q.t);
    if (f) return { ...q, f };
    if (waiting && (since === null || q.t >= since)) return { ...q, f: { st: step, lo: 0, hi: Number.POSITIVE_INFINITY, b: [] } };
    return q;
  });
}

// --- the tiles held in this tab ------------------------------------------------------------------

interface Held { tile: LiqHistoryFine | null; failedAt: number; loading: Promise<void> | null; rows: number }
const held = new Map<string, Held>();
let rowsHeld = 0;
/** Rows kept (as histTiles.ts MAX_ROWS). */
const MAX_ROWS = 600_000;

function trim(keep: ReadonlySet<string>): void {
  for (const [id, h] of held) {
    if (rowsHeld <= MAX_ROWS) break;
    if (keep.has(id) || !h.tile) continue;
    held.delete(id);
    rowsHeld -= h.rows;
  }
}

/** Tests: forget every tile. */
export function resetHistFine(): void {
  held.clear();
  rowsHeld = 0;
}

/** A tile as held: read (its answer), failed (asked again later), or neither yet. */
export type TileState = { tile: LiqHistoryFine | null; failed: boolean } | undefined;
const heldState = (id: string): TileState => { const h = held.get(id); return h && { tile: h.tile, failed: h.failedAt > 0 }; };

export interface HistFine {
  /** The snapshots with the parts of the step drawn. */
  points: HeatPoint[];
  /** The step every column is drawn at (null: the snapshots' own). */
  step: number | null;
  /** The step asked is still being read (what is drawn is the step before, or blank). */
  waiting: boolean;
  /** The tiles of it on screen, while some are not in (null: all in, or none asked). */
  reading: { done: number; of: number } | null;
  /** When the coin's fine levels begin (null: not known yet). */
  since: number | null;
}

/**
 * `points` (the snapshots, histTiles.ts) at `view`'s step over the window `w`, on `grid`'s tiles.
 * Null view: the snapshots as they are.
 */
export function useHistFine(coin: string, venues: readonly Venue[], grid: TileGrid | null, w: TileWindow | null, view: FineView | null, points: readonly HeatPoint[]): HistFine {
  const vkey = venues.join(',');
  const vk = view ? viewKey(coin, vkey, view) : null;
  const ks = useMemo(() => (grid && w && view ? tilesFor(grid, w, { dense: true }) : []), [grid?.newest, grid?.bw, grid?.slot, grid?.points?.[0]?.t, w?.t0, w?.t1, w?.lo, w?.hi, !!view]); // eslint-disable-line react-hooks/exhaustive-deps
  const wantKey = vk ? `${vk}~${ks.map((k) => tileId('', '', k)).join(' ')}` : '';
  const [ver, setVer] = useState(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  const venuesRef = useRef(venues);
  venuesRef.current = venues;

  useEffect(() => {
    const v = viewRef.current;
    if (!vk || !v || !ks.length) return;
    let alive = true;
    const bump = () => { if (alive) setVer((n) => n + 1); };
    /** A tile's read, also when the window before began it (its redraw is off by then: histTiles.ts); null: nothing to wait for. */
    const read = (k: TileKey): Promise<void> | null => {
      const id = fineTileId(vk, k);
      const h = held.get(id);
      if (h?.loading) return h.loading;
      if (h && (h.tile || Date.now() - h.failedAt < FINE_RETRY_MS)) return null;
      const e: Held = { tile: null, failedAt: 0, loading: null, rows: 0 };
      held.set(id, e);
      // Inclusive times (store.liqHistFineBands): the slot's last millisecond, not the next slot's first snapshot.
      e.loading = vsApi.liquidationHistoryFine(coin, venuesRef.current, {
        step: v.step, from: k.lo, to: k.hi, t0: k.t0, t1: k.t1 - 1,
        every: v.every, off: v.off, pool: v.pool || undefined, side: v.side, lev: v.lev, v: k.v, wallets: v.wallets,
      }).then(
        (tile) => { e.tile = tile; e.loading = null; e.rows = tile.points.reduce((n, q) => n + q.b.length, 0); rowsHeld += e.rows; },
        () => { e.failedAt = Date.now(); e.loading = null; },
      );
      return e.loading;
    };
    // A few at once, in order (on screen, newest first), as histTiles.ts: each drawn as it lands.
    const waiting = new Set<string>();
    let nearLeft = 0;
    const pump = () => {
      if (!alive) return;
      for (const k of ks) {
        if (waiting.size >= PARALLEL || (!k.near && nearLeft > 0)) return;
        const id = fineTileId(vk, k);
        if (waiting.has(id)) continue;
        const p = read(k);
        if (!p) continue;
        waiting.add(id);
        if (k.near) nearLeft++;
        void p.then(() => { waiting.delete(id); if (k.near) nearLeft--; bump(); pump(); });
      }
    };
    const rest = window.setTimeout(pump, SETTLE_MS);
    trim(new Set(ks.map((k) => fineTileId(vk, k))));
    const again = window.setInterval(pump, FINE_RETRY_MS);
    return () => { alive = false; window.clearTimeout(rest); window.clearInterval(again); };
  }, [wantKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The view whose tiles on screen were last all in: drawn while another is read.
  const shown = useRef<{ vk: string; step: number } | null>(null);
  return useMemo((): HistFine => {
    if (!vk || !view) return { points: points as HeatPoint[], step: null, waiting: false, reading: null, since: null };
    const r = fineFrame(points, vk, view.step, ks, shown.current, heldState);
    if (!r.waiting) shown.current = { vk, step: view.step };
    return r;
  }, [vk, ver, wantKey, points]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * What is drawn for a view (`vk` at `step`) over the tiles `ks`: once every tile on screen is in,
 * every column at its step; until then the view drawn before (`prev`) if its tiles cover the
 * screen, every column at that step; else the step asked, a column without its part yet blank.
 */
export function fineFrame(points: readonly HeatPoint[], vk: string, step: number, ks: readonly TileKey[], prev: { vk: string; step: number } | null, get: (id: string) => TileState): HistFine {
  const near = ks.filter((k) => k.near);
  if (!near.length) return { points: points as HeatPoint[], step: null, waiting: false, reading: null, since: null };
  const nearIn = near.reduce((n, k) => n + (get(fineTileId(vk, k))?.tile ? 1 : 0), 0);
  const reading = nearIn < near.length ? { done: nearIn, of: near.length } : null;
  // A tile that failed counts as in: it is asked again, its columns at their own step meanwhile.
  const allIn = (v: string) => near.every((k) => { const h = get(fineTileId(v, k)); return !!h && (!!h.tile || h.failed); });
  const tiles = (v: string) => ks.flatMap((k) => { const t = get(fineTileId(v, k))?.tile; return t ? [t] : []; });
  const frame = (v: string, st: number, waiting: boolean, blank: boolean): HistFine => {
    const ts = tiles(v);
    const since = ts.find((t) => t.since !== null)?.since ?? null;
    return { points: withParts(points, partsOf(ts), since, st, blank), step: st, waiting, reading, since };
  };
  if (allIn(vk)) return frame(vk, step, false, false);
  if (prev && prev.vk !== vk && allIn(prev.vk)) return frame(prev.vk, prev.step, true, false);
  return frame(vk, step, true, true);
}
