/**
 * Older bars that land while their spot is already on screen - the user
 * scrolled through a whole prefetched page (historyPager.ts) faster than the
 * next one arrived - come up quickly out of the empty chart instead of
 * popping in.
 *
 * Each plot pane gets a cover canvas for REVEAL_MS, stacked between
 * klinecharts' main canvas (grid, candles, indicators, the last-price rule)
 * and its overlay canvas (crosshair, drawings, order lines), over the part of
 * the pane left of the bar that was the oldest a moment ago. The cover holds
 * exactly what that part showed before the bars came - the background, the
 * pane's grid lines, the last-price rule - redrawn every frame as the plot
 * moves (a drag may still be going on), and fades out: the new candles and
 * their indicator values come up under it while the grid and the rule, drawn
 * identically on both, never flicker. The covers are removed when done.
 *
 * One reveal at a time: a second late page cuts the first one short.
 */
import type { Chart as KChart, Coordinate, KLineData } from 'klinecharts';
import { CANDLE_PANE_ID, T } from './theme';
import { gridLines, parseColor, type RGBA } from './morph';
import { drawGrid } from './gridStroke';
import { drawPriceLine, readPriceLine } from './priceLine';
import { easeOutCubic } from './morph';
import { logger } from '../log';

const log = logger('chart');

/** How long the late bars take to come up. */
export const REVEAL_MS = 220;
/** klinecharts' x-axis pane (PaneIdConstants.X_AXIS): no plot of its own. */
const X_AXIS_PANE = 'x_axis_pane';

/** Index of the first bar at or after `ts` (the list is oldest first). */
export function indexAtOrAfter(list: readonly { timestamp: number }[], ts: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.timestamp < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function background(el: HTMLElement | null): string {
  for (let e = el; e; e = e.parentElement) {
    const bg = getComputedStyle(e).backgroundColor;
    const c = parseColor(bg);
    if (c && c[3] > 0.99) return bg;
  }
  return T.panel;
}

interface Cover {
  paneId: string;
  canvas: HTMLCanvasElement;
}

export class HistoryReveal {
  private covers: Cover[] = [];
  private raf = 0;
  private t0 = 0;
  private boundary = 0;
  private bg = '';
  private disposed = false;

  constructor(private readonly c: KChart) {}

  /**
   * Bars older than the one stamped `boundaryTs` have just been handed to
   * klinecharts while their place is on screen: bring them up. Call right
   * after the library's callback; the first cover goes up before its next
   * paint (klinecharts lays out in a microtask queued ahead of this one).
   */
  start(boundaryTs: number): void {
    if (this.disposed) return;
    this.stop();
    this.boundary = boundaryTs;
    this.t0 = performance.now();
    queueMicrotask(() => {
      if (this.disposed || this.boundary !== boundaryTs) return;
      if (!this.draw(performance.now())) return;
      this.raf = requestAnimationFrame(this.tick);
    });
  }

  /** Take every cover down now. */
  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const { canvas } of this.covers) canvas.remove();
    this.covers = [];
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  private readonly tick = (now: number) => {
    this.raf = 0;
    if (this.draw(now)) this.raf = requestAnimationFrame(this.tick);
  };

  /** One frame; false once the reveal is over (and the covers are gone). */
  private draw(now: number): boolean {
    const t = Math.min(1, (now - this.t0) / REVEAL_MS);
    if (t >= 1) {
      this.stop();
      return false;
    }
    const c = this.c;
    const list: KLineData[] = c.getDataList();
    const idx = indexAtOrAfter(list, this.boundary);
    if (idx <= 0 || idx >= list.length) {
      this.stop();
      return false;
    }
    const at = c.convertToPixel({ dataIndex: idx }, { paneId: CANDLE_PANE_ID }) as Partial<Coordinate>;
    const half = c.getBarSpace().bar / 2;
    const edge = typeof at.x === 'number' && Number.isFinite(at.x) ? Math.floor(at.x - half) : 0;
    if (edge <= 0) {
      // The new bars have scrolled off to the left already: nothing to cover.
      this.stop();
      return false;
    }
    let panes: string[] = [];
    try {
      const all = c.getPaneOptions();
      const opts = Array.isArray(all) ? all : all ? [all] : [];
      panes = opts.map((p) => p.id).filter((id): id is string => !!id && id !== X_AXIS_PANE);
    } catch (e) {
      log.warn('history reveal: panes unreadable', { error: String(e) });
      this.stop();
      return false;
    }
    const opacity = String(1 - easeOutCubic(t));
    const live = new Set<string>();
    for (const paneId of panes) {
      const main = c.getDom(paneId, 'main');
      const canvases = main ? [...main.querySelectorAll<HTMLCanvasElement>(':scope > canvas:not(.kc-reveal)')] : [];
      const lib = canvases[0];
      if (!main || !lib || !(lib.width > 0) || !(lib.height > 0)) continue;
      let cover = this.covers.find((k) => k.paneId === paneId)?.canvas;
      if (!cover) {
        cover = document.createElement('canvas');
        cover.className = 'kc-reveal';
        this.covers.push({ paneId, canvas: cover });
      }
      if (cover.parentElement !== main) main.insertBefore(cover, canvases[1] ?? null);
      live.add(paneId);
      const w = main.clientWidth;
      const h = main.clientHeight;
      if (cover.width !== lib.width || cover.height !== lib.height) {
        cover.width = lib.width;
        cover.height = lib.height;
      }
      cover.style.width = `${w}px`;
      cover.style.height = `${h}px`;
      cover.style.opacity = opacity;
      const ctx = cover.getContext('2d');
      if (!ctx || !(w > 0) || !(h > 0)) continue;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cover.width, cover.height);
      ctx.setTransform(cover.width / w, 0, 0, cover.height / h, 0, 0);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, Math.min(edge, w), h);
      ctx.clip();
      this.bg ||= background(main);
      ctx.fillStyle = this.bg;
      ctx.fillRect(0, 0, Math.min(edge, w), h);
      const lines = gridLines(c, paneId);
      if (lines) drawGrid(ctx, lines, w, h);
      if (paneId === CANDLE_PANE_ID) {
        const rule = readPriceLine(c, h);
        if (rule) drawPriceLine(ctx, w, rule.y, rule.color as RGBA);
      }
      ctx.restore();
    }
    for (const k of this.covers.filter((k) => !live.has(k.paneId))) k.canvas.remove();
    this.covers = this.covers.filter((k) => live.has(k.paneId));
    return this.covers.length > 0;
  }
}
