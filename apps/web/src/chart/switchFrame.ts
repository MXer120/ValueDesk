/**
 * A symbol or timeframe switch keeps the chart's frame on screen - the grid,
 * the price axis with its labels, the time axis - exactly as it was, while
 * the candles wait for the new series in grey (CandleMorph restyles them
 * where they stand, grid included, and greys the last-price rule and its
 * badge with them). When the new bars land, the axes and grid take the new
 * series' values and the candles morph into its bars.
 *
 * What goes during the wait is what belongs to the old data or would be
 * drawn against the wrong axis: klinecharts' indicator drawing (while the
 * candle layer owns candles, grid and rule, each pane's main canvas carries
 * nothing else) and every overlay canvas - the new market's order lines and
 * the drawings, the crosshair. They fade out with the restyle and back in
 * with the new bars. The axes' own canvases are never touched.
 *
 * klinecharts gives every widget a container with two canvases, main then
 * overlay (DrawWidget); the panes are read through the public API.
 */
import type { Chart as KChart, PaneOptions } from 'klinecharts';
import { logger } from '../log';

const log = logger('chart');

/** klinecharts' x-axis pane id (PaneIdConstants.X_AXIS). */
const X_AXIS_PANE = 'x_axis_pane';
/** Out with the restyle, in over the first part of the morph (chart.css --ease-out). */
const FADE_MS = 180;
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

/** The canvases a switch fades: every pane's main and overlay canvas (the
 *  candle pane's main one only carries indicators while the layer owns the
 *  candles), the axes' overlay canvases - never the axes' labels. */
function dataCanvases(c: KChart): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  let panes: PaneOptions[] = [];
  try {
    const all = c.getPaneOptions();
    panes = Array.isArray(all) ? all : all ? [all] : [];
  } catch (e) {
    log.warn('switch frame: panes unreadable', { error: String(e) });
    return out;
  }
  for (const p of panes) {
    const id = p.id;
    if (!id) continue;
    const main = c.getDom(id, 'main');
    const canvases = main ? [...main.querySelectorAll<HTMLCanvasElement>(':scope > canvas')] : [];
    if (id === X_AXIS_PANE) {
      // The time labels stay; the crosshair's time label goes.
      if (canvases[1]) out.push(canvases[1]);
      continue;
    }
    out.push(...canvases.slice(0, 2));
    const y = c.getDom(id, 'yAxis');
    const yc = y ? [...y.querySelectorAll<HTMLCanvasElement>(':scope > canvas')] : [];
    // The price labels and the last-price badge stay; overlay labels go.
    if (yc[1]) out.push(yc[1]);
  }
  return out;
}

/**
 * Fade out (`hold`) or back in everything on the chart that is not the frame.
 * Idempotent; safe on a chart without the expected DOM (it then does nothing).
 */
export function holdFrame(c: KChart, hold: boolean): void {
  const canvases = dataCanvases(c);
  for (const cv of canvases) {
    cv.style.transition = `opacity ${FADE_MS}ms ${EASE}`;
    cv.style.opacity = hold ? '0' : '';
  }
  if (hold) log.debug('switch: the frame stays, data drawings fade', { canvases: canvases.length });
}
