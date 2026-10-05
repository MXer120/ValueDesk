/**
 * Your resting orders and position entry as horizontal lines on the
 * TradingView chart - built from the FREE Advanced Charts drawings API.
 *
 * Advanced Charts has no order/position-line API (createOrderLine /
 * createPositionLine belong to the paid Trading Platform), so these are
 * ordinary `horizontal_line` shapes, and this file is the DIY version:
 *
 *   position entry  locked, unselectable, its text carries a live PnL that
 *                   is rewritten in place (setProperties), never redrawn
 *   order lines     draggable when a modify is possible; a drag is read back
 *                   through `drawing_event` + getShapeById(id).getPoints() and
 *                   becomes a CONFIRM, never a send (lineManager.ts, TvChart)
 *   both            excluded from saved layouts, undo and the objects tree
 *
 * The derivation of WHICH lines exist is chart/orderOverlays.ts's
 * (orderLines / positionLines), shared with the klinecharts chart, so both
 * charts agree on what is resting where. Colours follow that file's rule:
 * green/red = side on an order, and profit/loss on the position entry.
 */
import { fmtQuote } from '../../format';
import { positionInk, snapToTick, unrealisedPnl, type OrderLine } from '../orderOverlays';
import type { CreateMultipointShapeOptions, ShapePoint } from './types';

export interface LineShape {
  key: string;
  price: number;
  /** Structural text (side / size / price). Live additions such as the
   *  position PnL are NOT here - see `liveText` - so they never force a redraw. */
  text: string;
  color: string;
  dashed: boolean;
  /** The user may drag it (an order the session can modify). */
  draggable?: boolean;
  /** Where it came from - what a drag turns into a modify request with. */
  line?: OrderLine;
}

export interface LineColors {
  pos: string;
  neg: string;
  text: string;
  muted: string;
}

export function lineShapes(
  lines: readonly OrderLine[],
  c: LineColors,
  last?: string | number | null,
): LineShape[] {
  const out: LineShape[] = [];
  for (const l of lines) {
    const price = Number(l.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const color =
      l.kind === 'position' ? positionInk(l, last, c) : l.side === 'buy' ? c.pos : l.side === 'sell' ? c.neg : c.muted;
    // Dashed = not a resting limit price (a trigger, or the entry), exactly
    // as orderOverlays draws it.
    out.push({
      key: l.key,
      price,
      text: l.label,
      color,
      dashed: l.kind !== 'limit',
      // orderLines() already folded the session's gates (perps, unlocked) into
      // `draggable`; a position entry is never an order.
      draggable: l.kind !== 'position' && l.draggable && l.orderID !== undefined,
      line: l,
    });
  }
  return out;
}

/** Everything that, if changed, means the shape has to be redrawn. */
export const shapeSig = (s: LineShape): string =>
  `${s.price}|${s.text}|${s.color}|${s.dashed ? 1 : 0}|${s.draggable ? 1 : 0}`;

/** Which drawn shapes to remove and which wanted ones to (re)create. */
export function diffShapes(
  drawn: ReadonlyMap<string, string>,
  wanted: readonly LineShape[],
): { add: LineShape[]; remove: string[] } {
  const next = new Map(wanted.map((s) => [s.key, s]));
  const remove: string[] = [];
  for (const [key, sig] of drawn) {
    const w = next.get(key);
    if (!w || shapeSig(w) !== sig) remove.push(key);
  }
  const add = wanted.filter((s) => drawn.get(s.key) !== shapeSig(s));
  return { add, remove };
}

/** TradingView line style: 0 solid, 2 dashed. */
export function horizontalLineOptions(s: LineShape): CreateMultipointShapeOptions {
  const movable = s.draggable === true;
  return {
    shape: 'horizontal_line',
    text: s.text,
    // A position line - and any order this session cannot modify - is locked
    // and cannot even be selected, so it cannot be moved or deleted by hand.
    lock: !movable,
    disableSelection: !movable,
    disableSave: true,
    disableUndo: true,
    showInObjectsTree: false,
    zOrder: 'top',
    overrides: {
      linecolor: s.color,
      linestyle: s.dashed ? 2 : 0,
      linewidth: movable ? 2 : 1,
      showLabel: true,
      textcolor: s.color,
      horzLabelsAlign: 'right',
      vertLabelsAlign: 'bottom',
      showPrice: true,
    },
  };
}

// --- position PnL ----------------------------------------------------------------

/** +1 long, -1 short, from the direction positionLines() puts in the label. */
export function positionDirection(l: OrderLine): 1 | -1 | null {
  if (l.kind !== 'position') return null;
  const lead = l.label.trim().split(/\s+/)[0]?.toUpperCase();
  return lead === 'LONG' ? 1 : lead === 'SHORT' ? -1 : null;
}

/** Unrealised PnL of the position at `last`, in quote units; null when it
 *  cannot be computed honestly (no direction, no size, no price). */
export function positionPnl(l: OrderLine, last: string | number | null | undefined): number | null {
  return unrealisedPnl(l, last);
}

/** The text a shape should show right now: its label, plus the live PnL for
 *  a position. Rewritten in place when it changes; never part of the sig. */
export function liveText(s: LineShape, last: string | number | null | undefined, quoteCoin?: string): string {
  if (!s.line || s.line.kind !== 'position') return s.text;
  const pnl = positionPnl(s.line, last);
  if (pnl === null) return s.text;
  // fmtQuote writes the minus itself; a gain gets an explicit plus.
  const sign = pnl > 0 ? '+' : '';
  return `${s.text}  PnL ${sign}${fmtQuote(pnl, quoteCoin ?? null)}`;
}

// --- drag -> modify ------------------------------------------------------------------

/** The price a dragged shape was dropped at, on the tick grid, or null. */
export function droppedPrice(points: readonly ShapePoint[] | null | undefined, tickSize?: string): string | null {
  const p = points?.[0]?.price;
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return null;
  return snapToTick(p, tickSize);
}

/**
 * The modify request for moving `line` to `price` - the same body the
 * klinecharts chart sends (components/Chart.tsx, confirmPending). Everything
 * NOT being changed is re-sent verbatim from the venue's own strings, INCLUDING
 * the other leg of a stop-limit, so moving one price can never be read as
 * clearing the other. Null for a line that is not a modifiable order.
 */
export function modifyRequestFor(line: OrderLine, price: string): Record<string, unknown> | null {
  if (line.kind === 'position' || line.orderID === undefined) return null;
  const body: Record<string, unknown> = { symbol: line.symbol, orderID: line.orderID };
  if (line.quantity) body.quantity = line.quantity;
  if (line.kind === 'trigger') {
    body.stopPrice = price;
    if (line.restPrice) body.price = line.restPrice;
  } else {
    body.price = price;
    if (line.stopPrice) body.stopPrice = line.stopPrice;
  }
  return body;
}
