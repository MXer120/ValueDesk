/**
 * A timeframe or market switch used to repaint both axes in one frame: the
 * price scale jumped to the new candles' high and low, and the time labels
 * swapped with them. This keeps the labels that were on screen — copied off
 * the axis canvases before the series is replaced — and hands the price span
 * to PriceFit so the scale eases from that span to the new fit.
 *
 * The library may rebuild the axis DOM when the series changes, which drops a
 * cover that was attached too early. `stick` paints the saved labels again
 * onto whatever widgets are there now.
 */
import type { Chart as KChart } from 'klinecharts';
import { CANDLE_PANE_ID } from './theme';
import { gapRates, priceAxis, stripGap, type ScaleKind, type Span } from './yScale';

/** klinecharts' x-axis pane id (PaneIdConstants.X_AXIS). */
const X_AXIS_PANE = 'x_axis_pane';

function copyCanvas(src: HTMLCanvasElement | null): HTMLCanvasElement | null {
  if (!src || src.width < 2 || src.height < 2) return null;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(src, 0, 0);
  } catch {
    return null;
  }
  return out;
}

function firstCanvas(widget: HTMLElement | null): HTMLCanvasElement | null {
  const src = widget?.querySelector(':scope > canvas');
  return src instanceof HTMLCanvasElement ? src : null;
}

function place(widget: HTMLElement | null, src: HTMLCanvasElement | null, which: 'price' | 'time'): HTMLCanvasElement | null {
  if (!widget || !src) return null;
  const snap = document.createElement('canvas');
  snap.className = 'kc-axis-cover';
  snap.dataset.axis = which;
  snap.width = src.width;
  snap.height = src.height;
  const ctx = snap.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0);
  if (getComputedStyle(widget).position === 'static') widget.style.position = 'relative';
  widget.appendChild(snap);
  return snap;
}

/** The span the price axis is showing, gap removed, or null when it is empty. */
export function shownSpan(c: KChart, kind: ScaleKind): Span | null {
  const axis = priceAxis(c);
  if (!axis || c.getDataList().length === 0) return null;
  const r = axis.getRange();
  if (![r.from, r.to].every(Number.isFinite) || !(r.to > r.from)) return null;
  // klinecharts' empty chart. Covering that would freeze a blank scale on screen.
  if (r.from === 0 && r.to === 10) return null;
  const height = c.getSize(CANDLE_PANE_ID, 'main')?.height ?? 0;
  const span = stripGap({ from: r.from, to: r.to }, gapRates(axis.gap, height), kind);
  if (![span.from, span.to].every(Number.isFinite) || !(span.to > span.from)) return null;
  return span;
}

function timeWidget(c: KChart): HTMLElement | null {
  try {
    const all = c.getPaneOptions();
    const panes = Array.isArray(all) ? all : all ? [all] : [];
    const x = panes.find((p) => p.id === X_AXIS_PANE);
    return x?.id ? c.getDom(x.id, 'main') : null;
  } catch {
    return null;
  }
}

/**
 * The previous axes, ready to lay over the chart. Null when there is nothing
 * on screen worth keeping (a first load, an empty scale).
 */
export function captureAxis(c: KChart, kind: ScaleKind): AxisHold | null {
  const span = shownSpan(c, kind);
  if (!span) return null;
  const price = copyCanvas(firstCanvas(c.getDom(CANDLE_PANE_ID, 'yAxis')));
  const time = copyCanvas(firstCanvas(timeWidget(c)));
  return new AxisHold(span, price, time);
}

export class AxisHold {
  private nodes: HTMLCanvasElement[] = [];

  constructor(
    readonly span: Span,
    private price: HTMLCanvasElement | null,
    private time: HTMLCanvasElement | null,
  ) {}

  /** Paint the saved labels over the axes the chart has now. Safe to repeat. */
  stick(c: KChart): void {
    for (const n of this.nodes) n.remove();
    this.nodes = [];
    const price = place(c.getDom(CANDLE_PANE_ID, 'yAxis'), this.price, 'price');
    const time = place(timeWidget(c), this.time, 'time');
    if (price) this.nodes.push(price);
    if (time) this.nodes.push(time);
  }

  /** The real price scale is drawing the saved span, so the cover can go. */
  releasePrice(): void {
    this.price = null;
    this.nodes = this.nodes.filter((n) => {
      if (n.dataset.axis === 'price') {
        n.remove();
        return false;
      }
      return true;
    });
  }

  /** Crossfade the old time labels out. The new ones are already underneath. */
  fadeTime(ms: number): void {
    const el = this.nodes.find((n) => n.dataset.axis === 'time');
    this.time = null;
    if (!el) return;
    el.style.transition = `opacity ${Math.max(0, ms)}ms cubic-bezier(0.25, 0.1, 0.25, 1)`;
    requestAnimationFrame(() => {
      el.style.opacity = '0';
    });
    const done = () => el.remove();
    el.addEventListener('transitionend', done, { once: true });
    window.setTimeout(done, Math.max(0, ms) + 80);
  }

  clear(): void {
    this.price = null;
    this.time = null;
    for (const n of this.nodes) n.remove();
    this.nodes = [];
  }
}
