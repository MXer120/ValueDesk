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
import { bucketOf } from '../components/bookDepth';
import type { Chart as KChart, OverlayEvent, OverlayTemplate, Point } from 'klinecharts';
import type { Symbol as MarketSymbol } from '../api';
import { fmtPrice, fmtQty, fmtQuote, num, pick } from '../format';
import { followChart } from './candleDraws';
import { CANDLE_PANE_ID, FAMILY, NUM_FAMILY, T } from './theme';

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
  /** The whole line in words: side / size / price. */
  label: string;
  /** The word on the chart's label: "Limit", "Stop", "TP", "SL", "Long". */
  tag: string;
  /** The size on the chart's label, formatted; null when the payload has none. */
  amount: string | null;
  /** The account can act on it from the chart: its cancel, close and exit buttons. */
  actionable?: boolean;
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

/**
 * The word for a trigger: an exit closes a position, so it says TP or SL and its side adds
 * nothing; a stop that opens one is "Buy stop". Same stopType spellings as Account.tsx.
 */
function triggerTag(raw: unknown): string {
  const s = String(pick(raw as object, 'stopType', 'st') ?? '').toUpperCase();
  const closes = pick(raw as object, 'reduceOnly', 'R') === true || String(pick(raw as object, 'reduceOnly', 'R')) === 'true';
  if (s === 'TAKE_PROFIT' || s === '2' || s === 'TP') return 'TP';
  if (closes && (s === 'STOP_LOSS' || s === '1' || s === 'SL')) return 'SL';
  return 'Stop';
}

export interface DeriveOptions {
  symbol: string;
  sym?: MarketSymbol;
  /**
   * Whether a drag may modify anything at all: false while the signing key is
   * locked. Spot and perps alike (changeOrder in trading/actions.ts).
   */
  canModify: boolean;
  /** Why not, when canModify is false. Surfaced verbatim on the line. */
  cannotModifyReason?: string;
}

/** Open orders for the charted market, as lines. Orders for other markets are
 *  dropped - the chart shows one symbol, and a line at another symbol's price
 *  would be a number with no meaning on this axis. */
/**
 * The order book rows holding one of the wallet's resting orders, however small: `ask` and `bid` hold the row's
 * price at the book's grouping. A stop waiting for its trigger is not in the book, so it marks nothing.
 */
export function ownBookLevels(orders: readonly any[] | null | undefined, symbol: string, askStep: number, bidStep: number): { ask: Set<number>; bid: Set<number> } {
  const out = { ask: new Set<number>(), bid: new Set<number>() };
  for (const raw of orders ?? []) {
    if ((pick<string>(raw, 'symbol', 's') ?? '') !== symbol) continue;
    if (usable(pick(raw, 'stopPrice', 'sp', 'triggerPrice'))) continue;
    const price = Number(usable(pick(raw, 'price', 'p')));
    const side = sideOf(pick(raw, 'side', 'S'));
    if (!(price > 0) || side === null) continue;
    if (side === 'sell') { if (askStep > 0) out.ask.add(bucketOf(price, askStep, 'ask')); }
    else if (bidStep > 0) out.bid.add(bucketOf(price, bidStep, 'bid'));
  }
  return out;
}

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
      amount: qty === null ? null : fmtQty(qty, o.sym?.stepSize),
      actionable: o.canModify,
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
        tag: 'Limit',
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
        tag: triggerTag(raw),
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
      tag: dir === 'long' ? 'Long' : dir === 'short' ? 'Short' : 'Position',
      amount: fmtQty(String(Math.abs(size)), o.sym?.stepSize),
      actionable: o.canModify,
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

/** A button on a line's label. */
export type LineButton = 'cancel' | 'tp' | 'sl';

/** One box of a label: filled in the line's colour, a value on the plot's colour, or an outlined button. */
interface LabelSeg {
  text: string;
  look: 'solid' | 'value' | 'outline' | 'cross';
  color: string;
  family: string;
  button?: LineButton;
}

interface LineVisual {
  segs: LabelSeg[];
  /** Short form for the y-axis gutter: price only, no room for more. */
  axisText: string;
  color: string;
  emphasis: boolean;
  /** How far off its line the label sits, so that labels never cover each other. */
  dy: number;
}

/** The label: boxes in a row at the left of the plot, centred on the line. */
const LABEL_HEIGHT = 18;
const LABEL_PAD = 5;
const LABEL_SIZE = 11;
const LABEL_WEIGHT = 500;
const LABEL_GAP = 2;
/** Labels are at least this far apart up and down. */
const LABEL_ROW = LABEL_HEIGHT + 1;
/** Every label starts here (owner 2026-11-05: "on the left of the chart always"). */
export const LABEL_X = 6;
const CROSS_WIDTH = 22;
/** Where a label's words start after the cancel button: the preview has none, and lines up with the rest. */
export const LABEL_WORDS_X = LABEL_X + CROSS_WIDTH + LABEL_GAP;

type Measure = (text: string, size: number, weight: number, family: string) => number;
/** klinecharts' own measure once registered; an estimate before that, and in tests. */
let measure: Measure = (text, size) => text.length * size * 0.56;

const segWidth = (seg: LabelSeg): number =>
  seg.look === 'cross' ? CROSS_WIDTH : LABEL_PAD * 2 + Math.ceil(measure(seg.text, LABEL_SIZE, LABEL_WEIGHT, seg.family));

/** One label to place: a line of an order or of the preview. */
export interface LabelRow {
  key: string;
  y: number;
}

/**
 * Labels that would overlap move up and down as little as they can, around where their lines are;
 * the line itself stays on its price. Returns how far each moves.
 */
export function layoutLabels(rows: readonly LabelRow[]): Map<string, number> {
  const sorted = [...rows].sort((a, b) => a.y - b.y || (a.key < b.key ? -1 : 1));
  // `starts`: where each label of the run would have to start, added up. Kept rather than added up again at
  // each join: with a bot's hundreds of orders at about one height that was most of a frame.
  const runs: Array<{ items: LabelRow[]; top: number; starts: number }> = [];
  for (const r of sorted) {
    let run = { items: [r], top: r.y, starts: r.y };
    for (;;) {
      const prev = runs[runs.length - 1];
      if (!prev || prev.top + prev.items.length * LABEL_ROW <= run.top) break;
      runs.pop();
      const starts = prev.starts + run.starts - prev.items.length * run.items.length * LABEL_ROW;
      for (const item of run.items) prev.items.push(item);
      // The top that moves its labels least: the mean of where each would have to start.
      run = { items: prev.items, top: starts / prev.items.length, starts };
    }
    runs.push(run);
  }
  const dy = new Map<string, number>();
  for (const run of runs) run.items.forEach((item, i) => dy.set(item.key, Math.round(run.top + i * LABEL_ROW - item.y)));
  return dy;
}

/** Text on the line's colour: dark on the bright colours of the dark theme, white on the light theme's deeper ones. */
/** `a` over `b`, solid: a label hides what is behind it, so no line or candle shows through its tint. */
const mix = (a: string, b: string, share: number): string => {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  if (x.concat(y).some((n) => !Number.isFinite(n))) return a;
  return `rgb(${x.map((n, i) => Math.round(n * share + y[i]! * (1 - share))).join(', ')})`;
};
/** The owner's version 1 (2026-11-06): a solid tint of the line's colour, a fine border, its colour as the text. */
const labelFill = (color: string): string => mix(color, T.bg, 0.16);
const labelBorder = (color: string): string => mix(color, T.bg, 0.6);
const labelInk = (color: string): string => mix(color, T.text, 0.75);

/**
 * Colours come from chart/theme.ts, the canvas-side mirror of the tokens in
 * styles.css - a <canvas> cannot resolve var(--pos), so this is the one place
 * the values are allowed to appear as literals, and they appear there, once.
 *
 * Green/red mean SIDE on an order line, exactly as they do everywhere else in
 * the terminal. The position entry does not borrow that: a long painted green
 * would read as another resting buy. Its direction is the word on the label
 * (Long / Short). The line itself answers the other question — is that entry
 * ahead — so it is green in profit, red in loss, and plain when the result
 * cannot be read. Compared with the last traded price, which is the price the
 * candles are showing against the line.
 *
 * Amber is the terminal's one attention colour and it is spent here on the
 * single state that needs it: a price the user has moved and the venue has not
 * agreed to.
 */
function colorOf(line: OrderLine, state: LineState, last: number | null): string {
  if (state !== 'live') return T.accent; // an unsent price is a pending state, not a side
  if (line.kind === 'position') return positionInk(line, last);
  if (line.tag === 'TP') return T.pos;
  if (line.tag === 'SL') return T.neg;
  if (line.side === 'buy') return T.pos;
  if (line.side === 'sell') return T.neg;
  return T.muted; // side unknown - say nothing with colour either
}

/** +1 long, -1 short, from the direction positionLines() puts first in the label. */
function positionSign(line: Pick<OrderLine, 'kind' | 'label'>): 1 | -1 | null {
  if (line.kind !== 'position') return null;
  const lead = line.label.trim().split(/\s+/)[0]?.toUpperCase();
  return lead === 'LONG' ? 1 : lead === 'SHORT' ? -1 : null;
}

/**
 * Unrealised PnL of a position line at `last`, in quote units. Null when the
 * direction, size or price cannot be read. An order line has none.
 */
export function unrealisedPnl(
  line: Pick<OrderLine, 'kind' | 'label' | 'price' | 'quantity'>,
  last: string | number | null | undefined,
): number | null {
  const dir = positionSign(line);
  const entry = Number(line.price);
  const qty = Number(line.quantity);
  const px = typeof last === 'number' ? last : Number(last);
  if (dir === null || !(entry > 0) || !(qty > 0) || !(px > 0)) return null;
  return (px - entry) * qty * dir;
}

/** Profit green, loss red, and the plain text colour when it is flat or unknown. */
export function positionInk(
  line: Pick<OrderLine, 'kind' | 'label' | 'price' | 'quantity'>,
  last: string | number | null | undefined,
  ink: { pos: string; neg: string; text: string } = T,
): string {
  const pnl = unrealisedPnl(line, last);
  if (pnl === null || pnl === 0) return ink.text;
  return pnl > 0 ? ink.pos : ink.neg;
}

/** What a line's label also says, from the other lines on the chart. */
interface LineContext {
  dy?: number;
  /** The position this market holds: a TP or SL says what it would make. */
  position?: OrderLine | null;
  /** The exits it has: no "+ TP" where one is working. */
  hasTp?: boolean;
  hasSl?: boolean;
}

const signed = (v: number, sym?: MarketSymbol): string => `${v > 0 ? '+' : ''}${fmtQuote(v, sym?.quoteCoin ?? null)}`;

function visualOf(
  line: OrderLine,
  state: LineState,
  price: string,
  sym?: MarketSymbol,
  last: number | null = null,
  ctx: LineContext = {},
): LineVisual {
  const color = colorOf(line, state, last);
  const words = (text: string, look: LabelSeg['look'], ink = color, button?: LineButton): LabelSeg => ({
    text, look, color: ink, family: look === 'value' || /[0-9]/.test(text) ? NUM_FAMILY : FAMILY, ...(button ? { button } : {}),
  });
  const segs: LabelSeg[] = [];
  const live = state === 'live';
  if (live && line.actionable) segs.push(words('', 'cross', color, 'cancel'));
  if (!live) {
    // A moved line says so: the price it is going to is on the axis tag.
    segs.push(words(state === 'dragging' ? 'Moving' : state === 'confirm' ? 'Not sent' : 'Sending…', 'solid'));
    if (line.amount) segs.push(words(line.amount, 'value'));
  } else if (line.kind === 'position') {
    const pnl = unrealisedPnl(line, last);
    segs.push(words(pnl === null ? line.tag : `PnL ${signed(pnl, sym)}`, 'solid'));
    if (line.amount) segs.push(words(line.amount, 'value'));
    if (line.actionable && !ctx.hasTp) segs.push(words('+ TP', 'outline', T.pos, 'tp'));
    if (line.actionable && !ctx.hasSl) segs.push(words('+ SL', 'outline', T.neg, 'sl'));
  } else {
    segs.push(words(line.tag, 'solid'));
    if (line.amount) segs.push(words(line.amount, 'value'));
    const dir = ctx.position ? positionSign(ctx.position) : null;
    const entry = Number(ctx.position?.price);
    const qty = Number(line.quantity);
    if ((line.tag === 'TP' || line.tag === 'SL') && dir !== null && entry > 0 && qty > 0) {
      segs.push(words(signed((Number(price) - entry) * qty * dir, sym), 'solid'));
    }
  }
  return { segs, axisText: fmtPrice(price, sym?.tickSize), color, emphasis: !live, dy: ctx.dy ?? 0 };
}

const FALLBACK: LineVisual = { segs: [], axisText: '', color: T.muted, emphasis: false, dy: 0 };

/**
 * A line's visual travels as text: overrideOverlay merges objects and arrays element by element,
 * so a label with fewer boxes than before kept the old ones behind the new.
 */
/** Read twice per line per draw, the same text until the line changes. */
const visualsRead = new Map<string, LineVisual>();
const visualIn = (data: string | null | undefined): LineVisual => {
  if (!data) return FALLBACK;
  const known = visualsRead.get(data);
  if (known) return known;
  try {
    const v = JSON.parse(data) as LineVisual;
    if (visualsRead.size >= 4_000) visualsRead.clear();
    visualsRead.set(data, v);
    return v;
  } catch {
    return FALLBACK;
  }
};

/**
 * How far each drawn line's label moved off its line, by overlay id. Read as a line is drawn, so a column
 * that moved rewrites this and asks for one redraw: an override per line clones that overlay and looks it
 * up among all of them, which with a bot's hundreds of lines cost more than drawing them.
 */
const drawnOffsets = new Map<string, number>();

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
const template: OverlayTemplate<string> = {
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
    const v = visualIn(overlay.extendData);
    const top = Math.round(c.y) + (drawnOffsets.get(overlay.id) ?? v.dy) - LABEL_HEIGHT / 2;
    const mid = top + LABEL_HEIGHT / 2;
    // What lies outside the pane is clipped anyway, and working it out is not free: labels pushed apart
    // by hundreds of orders run far past the pane's edges.
    const lineShown = c.y >= -1 && c.y <= bounding.height + 1;
    const labelShown = top + LABEL_HEIGHT >= 0 && top <= bounding.height;
    if (!lineShown && !labelShown) return [];
    const parts: Array<Record<string, unknown>> = [];
    let x = LABEL_X;
    for (const seg of labelShown ? v.segs : []) {
      const width = segWidth(seg);
      const fill = labelFill(seg.color);
      const border = labelBorder(seg.color);
      parts.push({
        type: 'rect',
        // A button answers a click (the layer's onClick); the rest is a label, not a handle, and
        // would otherwise swallow the drag whenever the user grabbed the line by it.
        ...(seg.button ? { key: seg.button } : { ignoreEvent: true }),
        attrs: { x, y: top, width, height: LABEL_HEIGHT },
        styles: { style: 'stroke_fill', color: fill, borderColor: border, borderSize: 1, borderRadius: 4 },
      });
      if (seg.look === 'cross') {
        const cx = x + width / 2;
        const r = 3.5;
        for (const d of [1, -1]) {
          parts.push({
            type: 'line',
            ignoreEvent: true,
            attrs: { coordinates: [{ x: cx - r, y: mid - r * d }, { x: cx + r, y: mid + r * d }] },
            styles: { color: labelInk(seg.color), size: 1, style: 'solid' },
          });
        }
      } else {
        parts.push({
          type: 'text',
          ignoreEvent: true,
          attrs: { x: x + LABEL_PAD, y: mid, text: seg.text, align: 'left', baseline: 'middle' },
          styles: {
            backgroundColor: 'transparent', borderColor: 'transparent', borderSize: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
            size: LABEL_SIZE, weight: LABEL_WEIGHT, family: seg.family,
            color: labelInk(seg.color),
          },
        });
      }
      x += width + LABEL_GAP;
    }
    // The line starts past a label sitting on it, so it cannot show between the label's boxes.
    const onLine = parts.length > 0 && Math.abs(mid - c.y) < LABEL_HEIGHT / 2;
    return [
      ...(lineShown
        ? [{
            type: 'line',
            attrs: { coordinates: [{ x: onLine ? x : 0, y: c.y }, { x: bounding.width, y: c.y }] },
            styles: { color: v.color, size: 1, style: 'dashed', dashedValue: v.emphasis ? [4, 3] : [2, 3] },
          }]
        : []),
      ...parts,
    ] as unknown as ReturnType<NonNullable<OverlayTemplate<string>['createPointFigures']>>;
  },
  // Price tag in the y-axis gutter, on the same side the axis labels are on.
  createYAxisFigures: ({ coordinates, bounding, overlay, yAxis }) => {
    const c = coordinates[0];
    if (!c) return [];
    const v = visualIn(overlay.extendData);
    const fromZero = yAxis?.isFromZero() ?? false;
    const y = Math.round(c.y) + (drawnOffsets.get(overlay.id) ?? v.dy);
    if (y < -LABEL_HEIGHT || y > bounding.height + LABEL_HEIGHT) return [];
    return {
      type: 'text',
      ignoreEvent: true,
      attrs: {
        x: fromZero ? 0 : bounding.width,
        y,
        text: v.axisText,
        align: fromZero ? 'left' : 'right',
        baseline: 'middle',
      },
      styles: {
        color: labelInk(v.color),
        backgroundColor: labelFill(v.color),
        borderColor: labelBorder(v.color),
        borderSize: 1,
        borderRadius: 4,
        size: LABEL_SIZE,
        weight: LABEL_WEIGHT,
        paddingLeft: 5,
        paddingRight: 5,
        paddingTop: 3,
        paddingBottom: 3,
      },
    };
  },
};

/** Idempotent: klinecharts' overlay registry is module-global and keyed by name,
 *  so a second call simply replaces the template. */
export function registerOrderLineOverlay(kc: typeof import('klinecharts')): void {
  measure = (text, size, weight, family) => kc.utils.calcTextWidth(text, size, weight, family);
  kc.registerOverlay<string>(template);
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
  /** A button on a line's label: nothing is sent from here, this is the cue to ask. */
  onLineButton: (line: OrderLine, button: LineButton) => void;
}

/** Only price and label decide whether a line has to be redrawn. Anything else
 *  changing on an order (fill progress, a status code) does not move the line. */
const signature = (l: OrderLine): string => `${l.price}|${l.label}|${l.tag}|${l.draggable}`;

/** A position's PnL on its label is rewritten this often at most: a price tick is many a second, a label is read. */
const PNL_REDRAW_MS = 250;

/**
 * Reconciles OrderLine records against klinecharts overlays.
 *
 * The single rule that makes this safe: a HELD line - one under the cursor, or
 * one sitting under an open confirm box - is never redrawn from a poll. Letting
 * a 10-second refresh yank a line out from under a drag is bad; letting it
 * replace the price a confirm box is about to send with a different one is
 * dangerous.
 */
const layers = new WeakMap<KChart, OrderLineLayer>();

/** The layer on a chart (DraftOrderLines.tsx lays its labels out with it). */
export const orderLineLayerOf = (chart: KChart): OrderLineLayer | undefined => layers.get(chart);

export class OrderLineLayer {
  private readonly ids = new Map<string, string>();
  private readonly sigs = new Map<string, string>();
  private readonly lines = new Map<string, OrderLine>();
  private held: string | null = null;
  /** key -> the price we asked the venue for, awaiting confirmation in a poll. */
  private expecting: { key: string; price: string } | null = null;
  private tick: string | undefined;
  private sym: MarketSymbol | undefined;
  /** Last traded price, so a position line can be recoloured without a redraw. */
  private mark: number | null = null;
  /** Colour and PnL last painted on a position line. The same text skips the override. */
  private tone = new Map<string, string>();
  private tonedAt = 0;
  /** How far each label is off its line, and the state and price of a line off the venue's. */
  private offsets = new Map<string, number>();
  /** What the labels were last placed from, and where that put them (layout). */
  private laid: { rows: LabelRow[]; out: Map<string, number> } | null = null;
  /** What every label reads from the other lines: worked out once per sync, not once per line. */
  private facts: Pick<LineContext, 'position' | 'hasTp' | 'hasSl'> | null = null;
  private moved = new Map<string, { price: string; state: LineState }>();
  /** The preview's labels (DraftOrderLines.tsx): they share the column and take room too. */
  private previewRows: LabelRow[] = [];
  private stopFollow: (() => void) | null = null;
  /** The line under a drag that has really moved. */
  private dragging: string | null = null;

  constructor(
    private readonly chart: KChart,
    private readonly on: OrderLineHandlers,
  ) {
    layers.set(chart, this);
  }

  setSymbol(sym: MarketSymbol | undefined): void {
    this.sym = sym;
    this.tick = sym?.tickSize;
  }

  /**
   * The price the candles are printing. A position line is green while that
   * price is on the profitable side of the entry, red on the other, and stays
   * as it was when the price has not crossed. Orders are not touched.
   */
  notePrice(px: number | null): void {
    const next = px !== null && px > 0 ? px : null;
    this.mark = next;
    const now = Date.now();
    if (now - this.tonedAt < PNL_REDRAW_MS) return;
    this.tonedAt = now;
    for (const [key, line] of this.lines) {
      if (line.kind !== 'position' || this.held === key) continue;
      const id = this.ids.get(key);
      if (!id) continue;
      const visual = visualOf(line, 'live', line.price, this.sym, next, this.context(line));
      const said = `${visual.color}|${visual.segs.map((x) => x.text).join('|')}`;
      if (this.tone.get(key) === said) continue;
      this.tone.set(key, said);
      this.chart.overrideOverlay({ id, extendData: JSON.stringify(visual) });
    }
  }

  /** The visual a line has now: where the user moved it, or the venue's. */
  private visualNow(line: OrderLine): LineVisual {
    const m = this.moved.get(line.key);
    const ctx = this.context(line);
    return m ? visualOf(line, m.state, m.price, this.sym, null, ctx) : visualOf(line, 'live', line.price, this.sym, this.mark, ctx);
  }

  private context(line: OrderLine): LineContext {
    if (!this.facts) {
      const all = [...this.lines.values()];
      this.facts = {
        position: all.find((l) => l.kind === 'position') ?? null,
        hasTp: all.some((l) => l.tag === 'TP'),
        hasSl: all.some((l) => l.tag === 'SL'),
      };
    }
    return { dy: this.offsets.get(line.key) ?? 0, ...this.facts };
  }

  /**
   * No label on another, the preview's included. Called after a redraw while any line is drawn,
   * and by the preview with its rows; repaints only the labels that moved.
   */
  layout(preview: readonly LabelRow[] = this.previewRows): Map<string, number> {
    this.previewRows = [...preview];
    const lines = [...this.ids.keys()].map((k) => this.lines.get(k)).filter((l): l is OrderLine => !!l);
    const points = lines.map((l) => ({ value: Number.parseFloat(this.moved.get(l.key)?.price ?? l.price) }));
    const px = (points.length ? this.chart.convertToPixel(points, { paneId: CANDLE_PANE_ID }) : []) as Array<{ y?: number }>;
    const rows: LabelRow[] = [...this.previewRows];
    lines.forEach((l, i) => {
      const y = px[i]?.y;
      if (typeof y === 'number' && Number.isFinite(y)) rows.push({ key: l.key, y });
    });
    // Nothing moved since the last draw, as on most: a pan along time, a price tick that keeps the scale.
    const was = this.laid;
    if (was && was.rows.length === rows.length && rows.every((r, i) => r.key === was.rows[i]!.key && r.y === was.rows[i]!.y)) return was.out;
    const out = layoutLabels(rows);
    this.laid = { rows, out };
    let moved: OrderLine | null = null;
    for (const l of lines) {
      const dy = out.get(l.key) ?? 0;
      if ((this.offsets.get(l.key) ?? 0) === dy) continue;
      this.offsets.set(l.key, dy);
      const id = this.ids.get(l.key);
      if (id) {
        drawnOffsets.set(id, dy);
        moved = l;
      }
    }
    // One override redraws the pane, and every line reads its offset as it is drawn.
    const id = moved ? this.ids.get(moved.key) : undefined;
    if (moved && id) this.chart.overrideOverlay({ id, extendData: JSON.stringify(this.visualNow(moved)) });
    return out;
  }

  private follow(): void {
    if (this.ids.size > 0) {
      this.stopFollow ??= followChart(this.chart, CANDLE_PANE_ID, () => this.layout());
    } else if (this.stopFollow) {
      this.stopFollow();
      this.stopFollow = null;
    }
  }

  /** Server truth in, drawn state out. */
  sync(next: OrderLine[]): void {
    const seen = new Set<string>();
    // All of them first: a TP's label reads the position beside it.
    for (const line of next) this.lines.set(line.key, line);
    this.facts = null;
    const fresh: OrderLine[] = [];
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
      fresh.push(line);
    }
    this.create(fresh);

    for (const key of [...this.ids.keys()]) {
      if (seen.has(key)) continue;
      const gone = this.lines.get(key);
      const wasHeld = this.held === key;
      this.remove(key);
      this.lines.delete(key);
      this.facts = null;
      if (wasHeld) {
        this.held = null;
        this.expecting = null;
        if (gone) this.on.onGone(gone);
      }
    }
    this.follow();
  }

  /** Move a line to a price WITHOUT touching the venue, and mark it as a state
   *  the user can tell apart from a resting order at a glance. */
  place(key: string, price: string, state: LineState): void {
    const id = this.ids.get(key);
    const line = this.lines.get(key);
    if (!id || !line) return;
    const value = Number.parseFloat(price);
    if (!Number.isFinite(value)) return;
    this.moved.set(key, { price, state });
    this.chart.overrideOverlay({
      id,
      points: [{ value }],
      extendData: JSON.stringify(this.visualNow(line)),
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
    this.moved.delete(key);
    const line = this.lines.get(key);
    const id = this.ids.get(key);
    if (!line || !id) return;
    const value = Number.parseFloat(line.price);
    if (!Number.isFinite(value)) return;
    this.chart.overrideOverlay({
      id,
      points: [{ value }],
      extendData: JSON.stringify(this.visualNow(line)),
      lock: !line.draggable,
    });
    this.sigs.set(key, signature(line));
    this.tone.delete(key);
  }

  /** Our overlays only. Used by "clear all drawings", which must not take the
   *  order lines with it. */
  removeAll(): void {
    this.stopFollow?.();
    this.stopFollow = null;
    for (const key of [...this.ids.keys()]) this.remove(key);
    this.lines.clear();
    this.facts = null;
    this.held = null;
    this.expecting = null;
  }

  /** All of a sync's new lines at once: the library sorts its overlays after each call, and a bot's refresh brings hundreds. */
  private create(lines: readonly OrderLine[]): void {
    // A line we cannot price is not drawn at all. There is no safe placeholder
    // position for "an order exists somewhere".
    const priced = lines.filter((l) => Number.isFinite(Number.parseFloat(l.price)));
    if (!priced.length) return;
    const ids = this.chart.createOverlay(priced.map((l) => this.overlayOf(l))) as Array<string | null>;
    priced.forEach((line, i) => {
      const id = ids[i];
      if (typeof id === 'string') {
        this.ids.set(line.key, id);
        this.sigs.set(line.key, signature(line));
      }
    });
    this.laid = null;
  }

  private overlayOf(line: OrderLine) {
    return {
      name: ORDER_LINE_OVERLAY,
      paneId: CANDLE_PANE_ID,
      zLevel: Z_LEVEL,
      lock: !line.draggable,
      points: [{ value: Number.parseFloat(line.price) }],
      extendData: JSON.stringify(this.visualNow(line)),

      // Without this the library deletes the overlay on right-click. See the
      // file header - on a stop-loss that is a one-click lie.
      onRightClick: (e: OverlayEvent<unknown>) => {
        e.preventDefault?.();
      },

      onClick: (e: OverlayEvent<unknown>) => {
        const button = e.figure?.key as LineButton | undefined;
        if (button === 'cancel' || button === 'tp' || button === 'sl') this.on.onLineButton(this.current(line), button);
        else this.on.onLineClick(this.current(line));
      },

      // A drag begins when the price moves: the library also calls these for a plain click, and a
      // click on a label's button must not read as "moved, not sent".
      onPressedMoving: (e: OverlayEvent<unknown>) => {
        const price = this.priceOf(e);
        if (this.dragging !== line.key) {
          if (price === null || samePrice(price, this.current(line).price)) return;
          this.dragging = line.key;
          this.held = line.key;
          this.expecting = null;
          this.on.onDragStart(this.current(line));
        }
        this.on.onDragMove(this.current(line), price);
      },
      onPressedMoveEnd: (e: OverlayEvent<unknown>) => {
        if (this.dragging !== line.key) {
          this.release(line.key);
          return;
        }
        this.dragging = null;
        const snapped = this.priceOf(e);
        // Park the line on the exact tick that would be sent, so the line, the
        // badge and the confirm box all show one number.
        if (snapped !== null) this.place(line.key, snapped, 'confirm');
        this.hold(line.key);
        this.on.onDrop(this.current(line), snapped);
      },
    };
  }

  private remove(key: string): void {
    const id = this.ids.get(key);
    if (id) {
      this.chart.removeOverlay({ id });
      drawnOffsets.delete(id);
    }
    this.ids.delete(key);
    this.sigs.delete(key);
    this.tone.delete(key);
    this.offsets.delete(key);
    this.laid = null;
    this.moved.delete(key);
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
