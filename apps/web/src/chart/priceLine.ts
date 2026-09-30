/**
 * klinecharts' dotted last-price rule, as the chart's own layers draw it
 * while klinecharts' is hidden or covered: the candle morph (CandleMorph.tsx)
 * greys it and glides it with the newest candle, and the history reveal
 * (historyReveal.ts) keeps it on screen over bars that are fading in. Drawn
 * with exactly klinecharts' calls, so a hand-over to the library's own rule is
 * pixel for pixel.
 */
import type { Chart as KChart, Coordinate, KLineData } from 'klinecharts';
import { CANDLE_PANE_ID } from './theme';
import { LAST_PRICE_STYLE, lastPriceDir, niceY, parseColor, type RGBA } from './morph';

/** Where the rule is and in which colour. */
export interface PriceLine {
  y: number;
  color: RGBA;
}

/**
 * The rule exactly as klinecharts would draw it now (CandleLastPriceView: the
 * last close, nice-pixel rounded, coloured against the previous close or the
 * open per the theme's rule), or null when there is no bar or the theme has
 * no rule. Read from the theme, not the live styles: the layers hide the live
 * rule while they draw their own.
 */
export function readPriceLine(c: KChart, height: number): PriceLine | null {
  const style = LAST_PRICE_STYLE;
  if (!style || style.line?.show === false || !(height > 0)) return null;
  const list: KLineData[] = c.getDataList();
  const last = list[list.length - 1];
  if (!last) return null;
  const dir = lastPriceDir(last.close, last.open, list[list.length - 2]?.close, (style as { compareRule?: string }).compareRule);
  const raw = dir === 'up' ? style.upColor : dir === 'down' ? style.downColor : style.noChangeColor;
  const color = parseColor(String(raw ?? ''));
  const px = (c.convertToPixel({ dataIndex: list.length - 1, value: last.close }, { paneId: CANDLE_PANE_ID }) as Partial<Coordinate>).y;
  if (!color || typeof px !== 'number' || !Number.isFinite(px)) return null;
  return { y: niceY(px, height), color };
}

const cssRgb = (c: RGBA) => `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;

/** The rule as klinecharts strokes it (drawLine: odd width on the half pixel,
 *  butt caps, the theme's dash, from the left edge so the dots fall where the
 *  library's do). */
export function drawPriceLine(ctx: CanvasRenderingContext2D, width: number, y: number, color: RGBA, alpha = 1): void {
  if (!(alpha > 0) || !(width > 0)) return;
  const size = LAST_PRICE_STYLE?.line?.size ?? 1;
  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.lineWidth = size;
  ctx.strokeStyle = cssRgb(color);
  ctx.lineCap = 'butt';
  ctx.setLineDash(LAST_PRICE_STYLE?.line?.style === 'dashed' ? [...(LAST_PRICE_STYLE?.line?.dashedValue ?? [2, 2])] : []);
  const off = size % 2 === 1 ? 0.5 : 0;
  ctx.beginPath();
  ctx.moveTo(0, y + off);
  ctx.lineTo(width, y + off);
  ctx.stroke();
  ctx.restore();
}

const lerpN = (a: number, b: number, e: number) => a + (b - a) * e;

/** Part-way from one rule to another: row and colour on the same progress. */
export function lerpLine(a: PriceLine, b: PriceLine, e: number): PriceLine {
  if (e >= 1) return b;
  if (e <= 0) return a;
  return { y: lerpN(a.y, b.y, e), color: [lerpN(a.color[0], b.color[0], e), lerpN(a.color[1], b.color[1], e), lerpN(a.color[2], b.color[2], e), 1] };
}
