/**
 * Chart-native order lines: your resting orders and your position, drawn on the
 * price axis, draggable to modify.
 *
 * This file owns three things and deliberately nothing else:
 *
 *   1. TICK MATHS      - snapToTick(), a bigint mirror of the backend's
 *                        roundToStep(..., 'nearest') in server/src/decimal.ts.
 *   2. WHAT TO DRAW    - orderLines()/positionLines() turn raw gateway payloads
 *                        into OrderLine records. They never invent a field: a
 *                        line whose price, side or size cannot be read is either
 *                        dropped or drawn without the part that is unknown.
 *   3. THE LIFECYCLE   - OrderLineLayer reconciles those records against
 *                        klinecharts overlays and translates drag events back
 *                        into snapped prices.
 *
 * It owns NO policy. It never calls the API, never decides whether a modify is
 * allowed, and never sends anything. Chart.tsx does that, behind an explicit
 * confirm, because these are live mainnet orders.
 *
 * Two klinecharts behaviours this file exists to contain:
 *
 *   - The library's internal right-click handler REMOVES an overlay unless the
 *     onRightClick callback calls preventDefault(). Without that call, a stray
 *     right-click silently deletes the drawn stop-loss - the line vanishes while
 *     the real order keeps resting at the venue, which is the exact inversion of
 *     the truth a trader needs. Every line we create prevents it.
 *   - A pressed-move mutates overlay.points in place BEFORE onPressedMoving
 *     fires, so `overlay.points[0].value` during a drag is the live price under
 *     the cursor. That is the only value a drag reads; it is snapped to the
 *     symbol's tick before it is shown, and shown before it is ever sent.
 */
import type { Chart as KChart, OverlayEvent, OverlayTemplate, Point } from 'klinecharts';
import type { Symbol as MarketSymbol } from '../api';
import { fmtPrice, fmtQty, num, pick } from '../format';
import { CANDLE_PANE_ID, T } from './theme';

/** Registered overlay name. Prefixed so Chart.tsx can keep it out of the user
 *  facing drawing-tool list - an order line is not a drawing tool, and one drawn
 *  by hand would be a line that looks like an order and is not. */
export const ORDER_LINE_OVERLAY = 'ot_order_line';

/** Order lines sit above user drawings; they are the ones you must not lose. */
const Z_LEVEL = 20;

// --- decimal helpers ---------------------------------------------------------
//
// Prices move through this file as strings, exactly as they arrived from the
// gateway, and only become numbers where the chart demands a number (a pixel
// conversion). The one place a float has to be turned back into a price is the
// drag, and that goes through snapToTick below rather than toFixed().

const fracDigits = (v: string): number => (v.split('.')[1] ?? '').length;

function toScaled(v: string, scale: number): bigint {
  const neg = v.startsWith('-');
  const [int = '0', frac = ''] = (neg ? v.slice(1) : v).split('.');
  return BigInt(`${neg ? '-' : ''}${int}${frac.padEnd(scale, '0').slice(0, scale)}`);
}

function fromScaled(n: bigint, scale: number): string {
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().padStart(scale + 1, '0');
  const body =
    scale === 0
      ? digits
      : `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
  return `${neg ? '-' : ''}${body}`;
}

const trimTrailingZeros = (s: string): string =>
  s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;

/**
 * Snap a price onto the symbol's tick grid.
 *
 * Load-bearing for two independent reasons:
 *
 *   - An off-grid price is rejected by the venue, or silently rounded by it. A
 *     silent round is the worse of the two: the user drags to 63,000.37, the
 *     venue rests the order at 63,000.00, and nothing on screen ever said so.
 *   - The number shown in the confirm box must be the number that gets signed.
 *     The backend snaps too (roundToStep 'nearest' in server/src/decimal.ts);
 *     this is a bit-for-bit mirror of that algorithm - integer arithmetic on
 *     bigints, half rounding up - so the two cannot disagree.
 *
 * Returns null when there is no honest answer (a non-finite input). A tick size
 * the gateway did not publish means "no grid", not "snap to zero", so the value
 * passes through unchanged.
 */
export function snapToTick(value: number | string, tickSize?: string): string | null {
  const raw = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(raw)) return null;

  const step = (tickSize ?? '').trim();
  // 10dp floor: the input is a float that came out of a pixel conversion, so
  // anything beyond that is binary noise, not precision. The tick's own scale
  // wins whenever it is finer.
  const scale = Math.min(20, Math.max(fracDigits(step), 10));
  const asText = raw.toFixed(scale);
  if (!step || !(Number.parseFloat(step) > 0)) return trimTrailingZeros(asText);

  const s = toScaled(step, scale);
  if (s <= 0n) return trimTrailingZeros(asText);
  const v = toScaled(asText, scale);
  let q = v / s;
  if ((v % s) * 2n >= s) q += 1n;
  return trimTrailingZeros(fromScaled(q * s, scale));
}

// --- what a line is ----------------------------------------------------------

/**
 * 'limit'    - the order's resting limit price. A drag re-sends `price`.
 * 'trigger'  - the order's stop/trigger price. A drag re-sends `stopPrice`.
 *              A stop-limit order legitimately has BOTH, and gets both lines.
 * 'position' - the position's average entry. Not an order; never draggable.
 */
export type OrderLineKind = 'limit' | 'trigger' | 'position';

export interface OrderLine {
  /** Stable across polls, so a line is redrawn only when it actually changed. */
  key: string;
  kind: OrderLineKind;
  /** null when the payload's side field was not one we recognise. Never guessed:
   *  a mislabelled side is a line that says "sell" over a resting buy. */
  side: 'buy' | 'sell' | null;
  /** Server truth, verbatim. Everything sent back that is NOT being changed is
   *  re-sent from these strings, never from a reformatted float. */
  price: string;
  quantity: string | null;
  /** Text on the in-chart badge: side / size / price. */
  label: string;
  symbol: string;
  orderID?: number;
  /**
   * The OTHER leg of the same order, carried on both of its lines.
   *
   * A stop-limit order rests at a trigger AND a limit price, and a modify names
   * fields explicitly. Sending only the leg being dragged would leave the venue
   * to decide what an omitted field means — and if it means "clear", a dragged
   * limit price would quietly strip the stop off the order. So whichever leg the
   * user moves, the other is re-sent verbatim. Absent when the order has no
   * second leg, in which case there is nothing to preserve.
   */
  restPrice?: string;
  stopPrice?: string;
  draggable: boolean;
  /** Shown when the user tries to drag a line that cannot be dragged. Always a
   *  reason they can act on, never just "disabled". */
  lockedReason?: string;
}

/**
 * Side, from either the REST spelling or the WebSocket enum.
 *
 * Same mapping as Account.tsx's sideText (1 = BUY, 2 = SELL), but returns null
 * instead of echoing the raw value: this drives a colour and the word on a
 * badge, and "unknown" has to be able to reach the screen as "unknown".
 */
function sideOf(v: unknown): 'buy' | 'sell' | null {
  if (v === 1 || String(v).toUpperCase() === 'BUY') return 'buy';
  if (v === 2 || String(v).toUpperCase() === 'SELL') return 'sell';
  return null;
}

/**
 * Long or short. Lifted from the identical rule in Account.tsx (which is not
 * exported): the venue's enum is { BOTH: 1, LONG: 2, SHORT: 3 }, and only under
 * one-way mode does the sign of `size` carry the direction. Reading the sign
 * alone would render every hedge-mode short as a long.
 */
function directionOf(p: any): 'long' | 'short' | null {
  const side = num(pick(p, 'positionSide', 'ps'));
  if (side === 2) return 'long';
  if (side === 3) return 'short';
  const amt = num(pick(p, 'size', 'positionAmt', 'pa', 'q'));
  if (amt > 0) return 'long';
  if (amt < 0) return 'short';
  return null;
}

/** A price field is usable only if it is a positive finite number. A stop-market
 *  order reports `price: "0"`, which would otherwise draw a confident line along
 *  the bottom of the chart. */
const usable = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  return Number.parseFloat(s) > 0 ? s : null;
};

export interface DeriveOptions {
  symbol: string;
  sym?: MarketSymbol;
  /**
   * Whether a drag may modify anything at all. False on spot (the gateway only
   * exposes /trade/perps/modify) and false while the signing key is locked.
   */
  canModify: boolean;
  /** Why not, when canModify is false. Surfaced verbatim on the line. */
  cannotModifyReason?: string;
}

/** Open orders for the charted market, as lines. Orders for other markets are
 *  dropped - the chart shows one symbol, and a line at another symbol's price
 *  would be a number with no meaning on this axis. */
export function orderLines(orders: any[], o: DeriveOptions): OrderLine[] {
  const out: OrderLine[] = [];
  for (const raw of orders ?? []) {
    if ((pick<string>(raw, 'symbol', 's') ?? '') !== o.symbol) continue;

    const side = sideOf(pick(raw, 'side', 'S'));
    const orderID = num(pick(raw, 'orderID', 'i', 'orderId')) || undefined;
    const qty = usable(pick(raw, 'quantity', 'q', 'origQty'));
    const limit = usable(pick(raw, 'price', 'p'));
    const trigger = usable(pick(raw, 'stopPrice', 'sp', 'triggerPrice'));
    // No id means no way to name this order in a modify or a cancel. Drawing it
    // would offer an action that cannot be carried out.
    if (orderID === undefined) continue;

    // A modify re-sends `quantity` unchanged (the same shape the Modify dialog
    // in Account.tsx already uses). Without a quantity to re-send we can draw
    // the line but must not offer to move it.
    const base = {
      side,
      quantity: qty,
      symbol: o.symbol,
      orderID,
    };
    const lock =
      !o.canModify
        ? (o.cannotModifyReason ?? 'Modifying from the chart is not available here.')
        : side === null
          ? 'This order’s side could not be read from the payload, so the chart will not move it. Use Modify in Open orders.'
          : qty === null
            ? 'This order reports no quantity to re-send with a modify. Use Modify in Open orders.'
            : null;

    if (limit) {
      out.push({
        ...base,
        key: `order:${orderID}:limit`,
        kind: 'limit',
        price: limit,
        // Carry the trigger leg so moving the limit price cannot strip the stop.
        ...(trigger ? { stopPrice: trigger } : {}),
        label: labelFor(side ? side.toUpperCase() : 'ORDER', qty, limit, o.sym),
        draggable: lock === null,
        ...(lock === null ? {} : { lockedReason: lock }),
      });
    }
    if (trigger) {
      out.push({
        ...base,
        key: `order:${orderID}:trigger`,
        kind: 'trigger',
        price: trigger,
        ...(limit ? { restPrice: limit } : {}),
        label: labelFor(`STOP ${side ? side.toUpperCase() : ''}`.trim(), qty, trigger, o.sym),
        draggable: lock === null,
        ...(lock === null ? {} : { lockedReason: lock }),
      });
    }
  }
  return out;
}

/** The position's average entry. One line per open position in this market. */
export function positionLines(positions: any[], o: DeriveOptions): OrderLine[] {
  const out: OrderLine[] = [];
  for (const p of positions ?? []) {
    if ((pick<string>(p, 'symbol', 's') ?? '') !== o.symbol) continue;
    const size = num(pick(p, 'size', 'positionAmt', 'pa', 'q'));
    if (size === 0) continue;
    const entry = usable(pick(p, 'avgEntryPrice'));
    // The gateway's position payload is a known, fixed shape (see the header of
    // Account.tsx). If avgEntryPrice is missing there is no entry to draw, and
    // no other field stands in for it.
    if (!entry) continue;
    const dir = directionOf(p);
    out.push({
      key: `position:${pick(p, 'id') ?? o.symbol}`,
      kind: 'position',
      side: null,
      price: entry,
      quantity: String(Math.abs(size)),
      symbol: o.symbol,
      label: labelFor(dir ? dir.toUpperCase() : 'POSITION', String(Math.abs(size)), entry, o.sym),
      draggable: false,
      lockedReason: 'This is your average entry price, not an order. It moves when you trade.',
    });
  }
  return out;
}

const labelFor = (
  lead: string,
  qty: string | null,
  price: string,
  sym?: MarketSymbol,
): string =>
  [lead, qty === null ? null : fmtQty(qty, sym?.stepSize), '@', fmtPrice(price, sym?.tickSize)]
    .filter((p) => p !== null)
    .join(' ');

// --- drawing -----------------------------------------------------------------

/** How a line is currently being treated. Drives its colour, so the difference
 *  between "this is your order" and "this is a price you have not sent yet" is
 *  never a matter of reading the label carefully. */
export type LineState = 'live' | 'dragging' | 'confirm' | 'sending';

interface LineVisual {
  text: string;
  /** Short form for the y-axis gutter: price only, no room for more. */
  axisText: string;
  color: string;
  dashed: boolean;
  emphasis: boolean;
}

/**
 * Colours come from chart/theme.ts, the canvas-side mirror of the tokens in
 * styles.css - a <canvas> cannot resolve var(--pos), so this is the one place
 * the values are allowed to appear as literals, and they appear there, once.
 *
 * Green/red mean SIDE on an order line, exactly as they do everywhere else in
 * the terminal. The position entry is deliberately NOT green or red: its
 * direction is stated in words on the badge, and borrowing the side colours for
 * it would make an entry line read as a resting order.
 *
 * Amber is the terminal's one attention colour and it is spent here on the
 * single state that needs it: a price the user has moved and the venue has not
 * agreed to. That is why the position entry is plain --text rather than amber -
 * two amber lines on one chart and neither of them means anything.
 */
function colorOf(line: OrderLine, state: LineState): string {
  if (state !== 'live') return T.accent; // an unsent price is a pending state, not a side
  if (line.kind === 'position') return T.text;
  if (line.side === 'buy') return T.pos;
  if (line.side === 'sell') return T.neg;
  return T.muted; // side unknown - say nothing with colour either
}

function visualOf(
  line: OrderLine,
  state: LineState,
  price: string,
  sym?: MarketSymbol,
): LineVisual {
  const priceText = fmtPrice(price, sym?.tickSize);
  const suffix =
    state === 'dragging' ? ' · release to review'
    : state === 'confirm' ? ' · not sent'
    : state === 'sending' ? ' · sending…'
    : '';
  const text =
    state === 'live'
      ? line.label
      : `${line.label.replace(/@.*$/, '').trim()} → ${priceText}${suffix}`;
  return {
    text,
    axisText: priceText,
    color: colorOf(line, state),
    // Dashed = "not a resting limit price": a trigger that has not fired, an
    // entry that is not an order, or a price still being moved.
    dashed: state !== 'live' || line.kind !== 'limit',
    emphasis: state !== 'live',
  };
}

const FALLBACK: LineVisual = {
  text: '',
  axisText: '',
  color: T.muted,
  dashed: true,
  emphasis: false,
};

/**
 * The overlay template.
 *
 * Full-width line rather than the built-in priceLine's "from the click x to the
 * right edge": an order rests at a price, not at a point in time, and a
 * half-width line invites the reading that it starts somewhere. Because every
 * point moves by the same delta on a pressed-move, a one-point full-width line
 * still drags correctly (klinecharts' eventPressedOtherMove).
 *
 * Styles are merged as defaults <- overlay.styles <- figure.styles, and the
 * defaults here are the themed ones from chart/theme.ts, so font family and size
 * are inherited rather than restated.
 */
const template: OverlayTemplate<LineVisual> = {
  name: ORDER_LINE_OVERLAY,
  totalStep: 2,
  // No handle dot: the whole line is the grab target, which is both a bigger hit
  // area and the convention every other terminal uses.
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, bounding, overlay }) => {
    const c = coordinates[0];
    if (!c) return [];
    const v = overlay.extendData ?? FALLBACK;
    return [
      {
        type: 'line',
        attrs: { coordinates: [{ x: 0, y: c.y }, { x: bounding.width, y: c.y }] },
        styles: {
          color: v.color,
          size: v.emphasis ? 2 : 1,
          style: v.dashed ? 'dashed' : 'solid',
          dashedValue: [5, 4],
        },
      },
      {
        type: 'text',
        // The badge is a label, not a handle. Left un-ignored it would swallow
        // the drag whenever the user grabbed the line by its text.
        ignoreEvent: true,
        attrs: { x: 4, y: c.y - 2, text: v.text, align: 'left', baseline: 'bottom' },
        styles: {
          color: T.bg,
          backgroundColor: v.color,
          borderColor: v.color,
          paddingTop: 2,
          paddingBottom: 2,
        },
      },
    ];
  },
  // Price tag in the y-axis gutter, on the same side the axis labels are on.
  createYAxisFigures: ({ coordinates, bounding, overlay, yAxis }) => {
    const c = coordinates[0];
    if (!c) return [];
    const v = overlay.extendData ?? FALLBACK;
    const fromZero = yAxis?.isFromZero() ?? false;
    return {
      type: 'text',
      ignoreEvent: true,
      attrs: {
        x: fromZero ? 0 : bounding.width,
        y: c.y,
        text: v.axisText,
        align: fromZero ? 'left' : 'right',
        baseline: 'middle',
      },
      styles: {
        color: T.bg,
        backgroundColor: v.color,
        borderColor: v.color,
        paddingTop: 2,
        paddingBottom: 2,
      },
    };
  },
};

/** Idempotent: klinecharts' overlay registry is module-global and keyed by name,
 *  so a second call simply replaces the template. */
export function registerOrderLineOverlay(kc: typeof import('klinecharts')): void {
  kc.registerOverlay<LineVisual>(template);
}

// --- the layer ---------------------------------------------------------------

export interface OrderLineHandlers {
  /** A drag started. The line is now held: reconciliation will not touch it. */
  onDragStart: (line: OrderLine) => void;
  /** Live, every mouse move. `price` is already snapped to the tick grid. */
  onDragMove: (line: OrderLine, price: string | null) => void;
  /** Mouse released. NOTHING has been sent - this is the cue to ask. */
  onDrop: (line: OrderLine, price: string | null) => void;
  /** The held order stopped existing (filled, or cancelled elsewhere) while the
   *  user was moving it. The confirm box on screen is now about a dead order. */
  onGone: (line: OrderLine) => void;
  /** A submitted modify was observed landing at the venue. */
  onSettled: (line: OrderLine) => void;
  /**
   * A line was clicked. Locked overlays still deliver clicks (klinecharts only
   * gates pressed-move on `lock`), which is the one chance to explain WHY a line
   * would not move — otherwise a locked stop-loss just silently refuses to drag.
   */
  onLineClick: (line: OrderLine) => void;
}

/** Only price and label decide whether a line has to be redrawn. Anything else
 *  changing on an order (fill progress, a status code) does not move the line. */
const signature = (l: OrderLine): string => `${l.price}|${l.label}|${l.draggable}`;

/**
 * Reconciles OrderLine records against klinecharts overlays.
 *
 * The single rule that makes this safe: a HELD line - one under the cursor, or
 * one sitting under an open confirm box - is never redrawn from a poll. Letting
 * a 10-second refresh yank a line out from under a drag is bad; letting it
 * replace the price a confirm box is about to send with a different one is
 * dangerous.
 */
export class OrderLineLayer {
  private readonly ids = new Map<string, string>();
  private readonly sigs = new Map<string, string>();
  private readonly lines = new Map<string, OrderLine>();
  private held: string | null = null;
  /** key -> the price we asked the venue for, awaiting confirmation in a poll. */
  private expecting: { key: string; price: string } | null = null;
  private tick: string | undefined;
  private sym: MarketSymbol | undefined;

  constructor(
    private readonly chart: KChart,
    private readonly on: OrderLineHandlers,
  ) {}

  setSymbol(sym: MarketSymbol | undefined): void {
    this.sym = sym;
    this.tick = sym?.tickSize;
  }

  /** Server truth in, drawn state out. */
  sync(next: OrderLine[]): void {
    const seen = new Set<string>();
    for (const line of next) {
      seen.add(line.key);
      this.lines.set(line.key, line);

      if (this.held === line.key) {
        // The venue confirming the price we submitted is the ONLY thing that
        // ends a 'sending' hold. Anything else leaves it held and visibly
        // pending rather than quietly claiming success.
        const want = this.expecting;
        if (want && want.key === line.key && samePrice(want.price, line.price)) {
          this.expecting = null;
          this.release(line.key);
          this.on.onSettled(line);
        }
        continue;
      }

      const sig = signature(line);
      if (this.ids.has(line.key) && this.sigs.get(line.key) === sig) continue;
      this.remove(line.key);
      this.create(line);
    }

    for (const key of [...this.ids.keys()]) {
      if (seen.has(key)) continue;
      const gone = this.lines.get(key);
      const wasHeld = this.held === key;
      this.remove(key);
      this.lines.delete(key);
      if (wasHeld) {
        this.held = null;
        this.expecting = null;
        if (gone) this.on.onGone(gone);
      }
    }
  }

  /** Move a line to a price WITHOUT touching the venue, and mark it as a state
   *  the user can tell apart from a resting order at a glance. */
  place(key: string, price: string, state: LineState): void {
    const id = this.ids.get(key);
    const line = this.lines.get(key);
    if (!id || !line) return;
    const value = Number.parseFloat(price);
    if (!Number.isFinite(value)) return;
    this.chart.overrideOverlay({
      id,
      points: [{ value }],
      extendData: visualOf(line, state, price, this.sym),
      // A line awaiting an answer must not be draggable again; a second drag
      // would queue a modify on top of one already in flight.
      lock: state !== 'dragging',
    });
  }

  /** Hold a line against reconciliation, and say what we are waiting for. */
  hold(key: string, expectPrice?: string): void {
    this.held = key;
    this.expecting = expectPrice === undefined ? null : { key, price: expectPrice };
  }

  /**
   * Put a line back onto the server's truth and re-arm it.
   *
   * Called on cancel, on a rejected modify, and on the timeout that gives up
   * waiting for a submitted one. The invariant it exists to keep: when this
   * returns, the line is where the venue says the order is - never where the
   * user dragged it to.
   */
  release(key: string): void {
    if (this.held === key) this.held = null;
    if (this.expecting?.key === key) this.expecting = null;
    const line = this.lines.get(key);
    const id = this.ids.get(key);
    if (!line || !id) return;
    const value = Number.parseFloat(line.price);
    if (!Number.isFinite(value)) return;
    this.chart.overrideOverlay({
      id,
      points: [{ value }],
      extendData: visualOf(line, 'live', line.price, this.sym),
      lock: !line.draggable,
    });
    this.sigs.set(key, signature(line));
  }

  /** Our overlays only. Used by "clear all drawings", which must not take the
   *  order lines with it. */
  removeAll(): void {
    for (const key of [...this.ids.keys()]) this.remove(key);
    this.lines.clear();
    this.held = null;
    this.expecting = null;
  }

  private create(line: OrderLine): void {
    const value = Number.parseFloat(line.price);
    // A line we cannot price is not drawn at all. There is no safe placeholder
    // position for "an order exists somewhere".
    if (!Number.isFinite(value)) return;
    const id = this.chart.createOverlay({
      name: ORDER_LINE_OVERLAY,
      paneId: CANDLE_PANE_ID,
      zLevel: Z_LEVEL,
      lock: !line.draggable,
      points: [{ value }],
      extendData: visualOf(line, 'live', line.price, this.sym),

      // Without this the library deletes the overlay on right-click. See the
      // file header - on a stop-loss that is a one-click lie.
      onRightClick: (e: OverlayEvent<unknown>) => {
        e.preventDefault?.();
      },

      onClick: () => {
        this.on.onLineClick(this.current(line));
      },

      onPressedMoveStart: () => {
        this.held = line.key;
        this.expecting = null;
        this.on.onDragStart(this.current(line));
      },
      onPressedMoving: (e: OverlayEvent<unknown>) => {
        this.on.onDragMove(this.current(line), this.priceOf(e));
      },
      onPressedMoveEnd: (e: OverlayEvent<unknown>) => {
        const snapped = this.priceOf(e);
        // Park the line on the exact tick that would be sent, so the line, the
        // badge and the confirm box all show one number.
        if (snapped !== null) this.place(line.key, snapped, 'confirm');
        this.hold(line.key);
        this.on.onDrop(this.current(line), snapped);
      },
    });
    if (typeof id === 'string') {
      this.ids.set(line.key, id);
      this.sigs.set(line.key, signature(line));
    }
  }

  private remove(key: string): void {
    const id = this.ids.get(key);
    if (id) this.chart.removeOverlay({ id });
    this.ids.delete(key);
    this.sigs.delete(key);
  }

  /** The dragged price, straight off the overlay the library just mutated. */
  private priceOf(e: OverlayEvent<unknown>): string | null {
    const p = e.overlay?.points?.[0] as Partial<Point> | undefined;
    return typeof p?.value === 'number' ? snapToTick(p.value, this.tick) : null;
  }

  /**
   * The freshest record for a line.
   *
   * The event callbacks close over the OrderLine that existed when the overlay
   * was created, and a poll in between may have replaced it (a partial fill
   * changes the quantity a modify has to re-send). Reading through the map means
   * a drag always acts on what the server last said, not on a snapshot.
   */
  private current(line: OrderLine): OrderLine {
    return this.lines.get(line.key) ?? line;
  }
}

/** Decimal-string equality that survives "63000" vs "63000.00". */
export function samePrice(a: string, b: string): boolean {
  const x = Number.parseFloat(a);
  const y = Number.parseFloat(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return x === y;
}
