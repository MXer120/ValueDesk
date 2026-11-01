/**
 * After each redraw of the chart's candle pane, a callback: for the HTML layers that follow the
 * chart (DraftOrderLines, SelectionMarks, NewsMarkers), which read where a price or a time sits
 * on screen.
 *
 * Those layers read it on every animation frame (owner 2026-11-01: "optimize everything ...
 * device hardware usage"): on /trade, with the ticket's draft line on the chart, ~60 frames a
 * second were asked for with nothing moving - measured on www, the renderer 14 ms/s busier for
 * it. Where a price or a time sits changes only when the chart draws it somewhere else, and
 * klinecharts redraws a pane's canvas for every pan, zoom, scale drag, resize and price tick
 * (Canvas._scheduleDraw: a frame that starts with clearRect over the canvas). So the layers now
 * read once after each such draw - the same frame, the same positions - and nothing in between.
 *
 * A pane's canvases are found when the callback is added and again every RECHECK_MS, which also
 * covers what moves with the clock (NewsMarkers' "Next" event) and a canvas klinecharts replaced.
 */
import type { Chart as KChart } from 'klinecharts';

/** Read again this often whatever was drawn: a canvas replaced, a clock in the layer. */
export const RECHECK_MS = 1_000;

interface CtxLike { clearRect: (...a: never[]) => unknown }
interface Hooked { cbs: Set<() => void>; own: CtxLike['clearRect'] }
const hooked = new WeakMap<CtxLike, Hooked>();

/** Run `cb` whenever `ctx` starts a frame (klinecharts clears the whole canvas first). */
function hook(ctx: CtxLike, cb: () => void): () => void {
  let h = hooked.get(ctx);
  if (!h) {
    const own = ctx.clearRect;
    const cbs = new Set<() => void>();
    h = { cbs, own };
    hooked.set(ctx, h);
    ctx.clearRect = function (this: CtxLike, ...a: never[]) {
      const r = own.apply(this, a);
      for (const f of cbs) f();
      return r;
    } as CtxLike['clearRect'];
  }
  h.cbs.add(cb);
  const mine = h;
  return () => {
    mine.cbs.delete(cb);
    if (!mine.cbs.size && hooked.get(ctx) === mine) {
      ctx.clearRect = mine.own;
      hooked.delete(ctx);
    }
  };
}

function canvasesOf(chart: KChart, paneId: string): CtxLike[] {
  const dom = chart.getDom(paneId, 'main') as unknown as { querySelectorAll?: (s: string) => ArrayLike<{ getContext?: (k: string) => unknown }> } | null;
  const out: CtxLike[] = [];
  const list = dom?.querySelectorAll?.('canvas');
  if (!list) return out;
  for (let i = 0; i < list.length; i++) {
    const ctx = list[i]!.getContext?.('2d') as CtxLike | null | undefined;
    if (ctx && typeof ctx.clearRect === 'function') out.push(ctx);
  }
  return out;
}

/**
 * Call `read` now, after every redraw of `paneId` on `chart` (once per frame, after the draw has
 * run: a microtask), and every RECHECK_MS. Returns the unsubscribe.
 */
export function followChart(chart: KChart, paneId: string, read: () => void, recheckMs = RECHECK_MS): () => void {
  let queued = false;
  let alive = true;
  const drawn = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (alive) read();
    });
  };
  const offs = new Map<CtxLike, () => void>();
  const attach = () => {
    const now = new Set(canvasesOf(chart, paneId));
    for (const [ctx, off] of offs) if (!now.has(ctx)) { off(); offs.delete(ctx); }
    for (const ctx of now) if (!offs.has(ctx)) offs.set(ctx, hook(ctx, drawn));
  };
  attach();
  read();
  const timer = setInterval(() => {
    if (!alive) return;
    attach();
    read();
  }, recheckMs);
  return () => {
    alive = false;
    clearInterval(timer);
    for (const off of offs.values()) off();
    offs.clear();
  };
}
