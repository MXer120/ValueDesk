/**
 * Order entry.
 *
 * WHAT GOES ON THE WIRE
 * ---------------------
 * Values are passed to the backend as the raw strings typed here. The backend
 * snaps them to the symbol's tick/step grid and canonicalises them for signing;
 * doing arithmetic in the browser would risk a float artefact reaching the
 * signature. The ONE place that rule cannot hold is the quote-denominated size
 * unit, where a division is unavoidable - see `quantity` below for how that is
 * kept honest.
 *
 * ORDER OF THE TICKET, AND WHY
 * ----------------------------
 * Action high, read-out low:
 *   leverage/margin -> type -> price -> size -> % -> flags -> WARNINGS -> BUY/SELL
 * and only then the value/margin/liquidation/fee read-out, which is a
 * confirmation of what you just built rather than a prerequisite for building
 * it. The two irreversible controls are therefore reachable without scrolling
 * at the dashboard's default panel height, and the warnings deliberately stay
 * ABOVE them: a guardrail underneath the control it guards is decoration.
 *
 * The read-out is pinned to the BOTTOM of the panel (margin-top:auto) rather
 * than floating directly under the buttons. It is reference material you check,
 * so it wants a fixed place on the panel edge; letting it ride up and down with
 * the ticket's height made the fee line move every time a stop field appeared.
 *
 * EVERY FIGURE HAS A SOURCE
 * -------------------------
 * Nothing in the read-out is allowed to be a plausible-looking zero. Available
 * balance, current position and slippage each come from a live feed and render
 * an em-dash - not 0, not a guess - the moment that feed is missing, thin or
 * not applicable. Liquidation is a client-side ESTIMATE and says so in the
 * label, not only in a tooltip.
 *
 * WHY THIS PANEL IS `panel oe` AND NOT `panel entry`
 * --------------------------------------------------
 * styles.css carries five `.panel.entry ...` rules written for the old markup
 * (uppercase captions on every bare <label>, the auto-width .kv summary, the
 * TIF caption row). Every one of them is at (0,3,1) or higher and styles.css is
 * injected LAST, so a component-local sheet cannot override them without a
 * specificity arms race. This panel therefore drops the `entry` hook entirely
 * and states its own chrome in OrderEntry.css. Those five rules in styles.css
 * now match nothing and can be deleted by whoever owns that file.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type Engine, type OrderBook, type Symbol } from '../api';
import { useAccountResource } from '../accountFeeds';
import { useAsync, useChannel, useStatus } from '../hooks';
import { DASH, USD_WHOLE_FROM, fmt, fmtPrice, fmtQty, fmtQuote, num, pick, precisionOf, shortAddr, coinLabel } from '../format';
import { useMask } from '../privacy';
import { checkStopAgainstLiquidation, estimateLiquidationPrice } from '../risk';
import { useConfirm } from './Modal';
import { ReviewPosition, setReviewSuppressed, shouldReview, type ReviewOrder } from './ReviewPosition';
import { useTradeGate } from './account/useTradeGate';
import { DraftInput, decimalInput, integerInput, tickInput, trimZeros } from './numberInput';
import { Collapse } from './motion';
import { couldntLoad } from './LoadFailed';
import { notifyTrade } from '../toast';
import { ApproveLabel } from './funds/ui';
import { mulDecimal, roundToStep } from '@sodex-core';
import { notify } from '../toast';
import { publishOrderImpact, type RawTake } from '../orderImpact';

/** A market order cannot ask for more than this. The field refuses anything higher. */
const SLIP_CAP_PCT = 2.5;
import './OrderEntry.css';

interface Props {
  engine: Engine;
  symbol: string;
  sym?: Symbol;
  /** 'mainnet' means real money; orders get an explicit confirmation. */
  network?: string;
  unlocked: boolean;
  /**
   * False when a parent already renders a title for this panel - the dashboard
   * draws one in the panel header, and without this the heading appeared twice.
   * Same convention as Book/Trades/Positions/OpenOrders/Balances/History.
   */
  showTitle?: boolean;
  /** Wallet selected in the UI - drives every account READ. */
  connectedAddress?: string | null;
  /** Address the backend's unlocked key actually signs as - drives every WRITE. */
  signingAddress?: string | null;
  price: string;
  onPrice: (p: string) => void;
  lastPrice?: string;
  onPlaced: () => void;
}

type OrdType = 'market' | 'limit' | 'stop';
type SizeUnit = 'base' | 'quote';
type Pop = null | 'margin' | 'leverage';

/** Notch positions on the size slider, in percent. */
const NOTCHES = [0, 25, 50, 75, 100];
/**
 * Free buying power, read from the venue's own account state - never inferred.
 *
 * Perps cross: `am`, free margin in quote units. SoDEX already folds
 * multi-asset collateral into `am` (balance × index × collateral ratio).
 * Isolated positions cannot use that collateral, so isolated sizing uses
 * `ami` — USDC only. Spot: the free balance of the side's coin.
 *
 * Returns null - not 0 - whenever the number is genuinely unknown: no wallet,
 * no SoDEX account, a read error, or a payload without the field. A percentage
 * slider that quietly computes against zero produces a ticket that looks sized
 * and sends nothing, which is exactly the class of confident-wrong number this
 * app refuses to render.
 */
/**
 * The balance 100% on the slider sizes against.
 *
 * SPOT IS SIDE-AWARE, AND IT WAS NOT.
 *
 * Perps size against free margin, which has no side. Spot does: a BUY spends the
 * quote balance, a SELL spends the base one. This read the quote balance for
 * both, so with Sell selected the panel stated quote buying power and MAX sized
 * an order to 100% of it - an order the account cannot fill. The comment that
 * used to sit here said the caveat was "printed rather than papered over"; it
 * was printed nowhere, and the ticket has had an explicit side since the
 * Buy/Sell switch went in above it.
 */
function readAvailable(
  payload: any,
  engine: Engine,
  quoteCoin: string | undefined,
  baseCoin?: string | undefined,
  side?: 'buy' | 'sell',
  marginMode: 'cross' | 'isolated' = 'cross',
): number | null {
  const s = payload?.state;
  if (!s) return null;

  if (engine === 'perps') {
    const raw = pick(s, marginMode === 'isolated' ? 'ami' : 'am');
    const n = Number.parseFloat(String(raw ?? ''));
    if (Number.isFinite(n)) return n;
    if (marginMode !== 'isolated') return null;
    // Older payloads omit `ami`. Isolated margin is USDC only, so the USDC
    // row's available balance is the honest fallback — never `am`, which
    // includes BTC and the other collateral coins isolated cannot spend.
    const rows: any[] = Array.isArray(s.B) ? s.B : [];
    const usdc = rows.find((b) => /^(v)?usdc$/i.test(String(pick(b, 'a', 'coin', 'name') ?? '')));
    const aw = Number.parseFloat(String(pick(usdc, 'aw', 'wb') ?? ''));
    return Number.isFinite(aw) ? aw : null;
  }

  const coin = side === 'sell' ? baseCoin : quoteCoin;
  if (!coin) return null;
  return spotFree(s, coin);
}

/** Free balance for one coin on the spot engine: total minus locked. */
function spotFree(s: any, coin: string): number | null {
  const rows: any[] = Array.isArray(s.B) ? s.B : [];
  // The gateway spells the coin key three ways depending on the surface, the
  // same reason `pick` exists at all.
  const row = rows.find(
    (b) => String(pick(b, 'a', 'coin', 'name') ?? '').toUpperCase() === coin.toUpperCase(),
  );
  if (!row) return null;
  const total = Number.parseFloat(String(pick(row, 't', 'total', 'wb') ?? ''));
  if (!Number.isFinite(total)) return null;
  const lockedRaw = pick(row, 'l', 'locked');
  const locked = lockedRaw === undefined ? 0 : Number.parseFloat(String(lockedRaw));
  return total - (Number.isFinite(locked) ? locked : 0);
}

/**
 * Whether an open position is long or short.
 *
 * The venue's enum is `{ BOTH: 1, LONG: 2, SHORT: 3 }`. Under hedge mode
 * `positionSide` states the direction outright; under one-way mode (`BOTH`) it
 * carries no direction and the sign of `size` encodes it. Reading the sign
 * alone is only correct when `size` is signed, so the explicit field wins and
 * the sign is the fallback. Returns null rather than guessing - here that only
 * costs a colour, but the same rule is what keeps Positions' close button from
 * doubling a position instead of flattening it.
 */
function positionDirection(p: any): 'long' | 'short' | null {
  const side = num(pick(p, 'positionSide', 'ps'));
  if (side === 2) return 'long';
  if (side === 3) return 'short';
  const amt = num(pick(p, 'size', 'positionAmt', 'pa', 'q'));
  if (amt > 0) return 'long';
  if (amt < 0) return 'short';
  return null;
}

/**
 * Average fill price for `qty` walked against one side of the book.
 *
 * Returns null when the visible depth cannot fill the order: a partial walk
 * would report a flattering slippage figure computed against the part of the
 * order the book CAN absorb, which is worse than admitting we do not know.
 */
function slipTone(est: number | null, max: number, sized: boolean): string {
  if (!sized || est === null || !(est > 0)) return '';
  if (max > 0 && est >= max) return 'is-neg';
  if (max > 0 && est >= max * 0.7) return 'is-warn';
  return 'is-pos';
}

/** Keep a typed slippage at or under `cap`. An unfinished "2." is left alone. */
function clampSlipDraft(raw: string, cap: number): string {
  const s = decimalInput(raw);
  if (s === '' || s === '.') return s;
  const n = Number(s);
  if (!Number.isFinite(n)) return '';
  if (n > cap) return cap.toFixed(2);
  return s;
}

function walkBook(
  levels: [string, string][] | undefined,
  qty: number,
  side: 'buy' | 'sell',
  limit: number | null,
): { avg: number | null; takes: RawTake[] } {
  if (!levels?.length || !(qty > 0)) return { avg: null, takes: [] };
  let left = qty;
  let cost = 0;
  let filled = 0;
  const takes: RawTake[] = [];
  for (const [priceStr, qtyStr] of levels) {
    const px = Number.parseFloat(priceStr);
    const avail = Number.parseFloat(qtyStr);
    if (!Number.isFinite(px) || !Number.isFinite(avail) || px <= 0 || avail <= 0) continue;
    // A resting limit does not trade through prices worse than itself.
    if (limit !== null && (side === 'buy' ? px > limit : px < limit)) break;
    const taken = Math.min(left, avail);
    if (!(taken > 0)) continue;
    takes.push({ price: px, taken, qty: avail });
    cost += taken * px;
    filled += taken;
    left -= taken;
    if (left <= 1e-12) break;
  }
  return { avg: filled > 0 ? cost / filled : null, takes };
}

/**
 * Close a popover on an outside press or Escape.
 *
 * `pointerdown` in the CAPTURE phase, not `click`: the leverage popover holds a
 * range input, and a drag that starts on the thumb but ends outside the popover
 * fires `click` on the document - which would slam the popover shut the instant
 * you released the thumb. The close callback is held in a ref so an inline
 * arrow at the call site does not re-bind two document listeners every render.
 *
 * "Inside" is a LIST of regions, not one subtree. The leverage popover is
 * portalled to <body> (see `useFloatPop`), so the trigger and the surface it
 * opens are no longer in one DOM ancestor: containment against the anchor alone
 * would treat every press inside the popover as an outside press and close it
 * on the first click of the preset you were aiming for. The list is held in a
 * ref for the same reason the callback is - the call site passes an array
 * literal, which is a new object every render.
 */
function useDismiss(
  open: boolean,
  refs: Array<React.RefObject<HTMLElement>>,
  close: () => void,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  const refsRef = useRef(refs);
  refsRef.current = refs;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!refsRef.current.some((r) => r.current?.contains(t))) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
}

/** Clearance between the trigger and the popover it opens - the same 4px the
 *  in-flow popover carries as `calc(100% + 4px)`. */
const POP_GAP = 4;
/** The popover never touches the window edge. */
const POP_EDGE = 8;
/** The floating popover's measure. It prefers the ticket's own content width so
 *  it keeps the measure it has always had, but a 185px phone column is narrower
 *  than the leverage row can be read at, and a 700px ultrawide ticket would
 *  give it a line length nothing in it needs. */
const POP_MIN_W = 216;
const POP_MAX_W = 320;
/**
 * The shortest band the sheet will hang in before it gives up the side of the
 * trigger it prefers.
 *
 * A sheet hung above the trigger scrolls when the band is short, and scrolling
 * is a fair price for not covering the ticket - but past a point the box is
 * more scrollbar than content, and a leverage slider inside a scroller is a
 * control that fights the gesture used to reach it. 180px is this popover's own
 * irreducible content: title, multiplier row, one row of presets, Confirm.
 *
 * Below that the sheet hangs the other way, off the trigger's BOTTOM edge -
 * still never over the trigger, still fully on screen, but over the fields.
 * That is the last resort and it is unreachable in the layout that ships:
 * measured at 390x844 and 320x400, the leverage row sits 266px down the window,
 * so the band above is 254px and the sheet is 198px tall. It takes moving the
 * panel to within 180px of the top of the window - which nothing in the app
 * does - to reach it.
 */
const POP_BAND_MIN = 180;

interface FloatPos {
  left: number;
  top: number;
  width: number;
  /** Clamps the box into the band it was placed in; it scrolls past this. */
  maxHeight: number;
  /** 'side' = beside the trigger. 'sheet' = centred and hung off one edge of
   *  it, for windows too narrow to have room on either side. */
  mode: 'side' | 'sheet';
}

/**
 * Position a portalled popover to the LEFT of its trigger, in viewport
 * coordinates.
 *
 * WHY THIS IS NOT `position: absolute` ON THE ROW
 * ----------------------------------------------
 * The leverage popover is as tall as the ticket's whole top half, and opened
 * downward it landed squarely on the price and size fields - it covered the
 * form it exists to configure. Opening it sideways puts it over the order book
 * instead, which is a read-only surface, and leaves the execution panel
 * completely visible while you drag the slider.
 *
 * Sideways is only possible OUT of the panel, and out of the panel means out of
 * the flow, twice over: this panel's body is `overflow: auto`, so an absolutely
 * positioned box reaching past its left edge is clipped or turned into a
 * scrollbar, and react-grid-layout places every panel with
 * `transform: translate(...)`, which makes each panel the containing block for
 * its own `position: fixed` descendants. Modal.tsx hit the second of those and
 * answered it exactly this way - portal to <body>, then position from the
 * trigger's own `getBoundingClientRect()`.
 *
 * FLIP, OR STOP TRYING TO SIT BESIDE IT AT ALL
 * --------------------------------------------
 * Left is the preference, not a promise. Below the xs breakpoint the book is
 * not beside the ticket at all and there is no room on that side, so the
 * popover flips to the right of its trigger.
 *
 * And on a phone there is no room on EITHER side: at 390 the card is 185px
 * wide, the popover's minimum readable measure is 216, and the trigger sits in
 * the right-hand column - 193px of room on its left, 92 on its right. The old
 * code answered that by clamping a left-placed box into the viewport, which
 * parked it squarely on the ticket: it covered its own trigger and both the
 * Price and Size fields, which is the exact failure the sideways placement was
 * built to avoid, arrived at from the other direction.
 *
 * So when neither side fits, the box stops trying to sit beside the trigger and
 * becomes a SHEET: centred horizontally, and hung off the trigger's top edge
 * with a 4px gap, taking as much of the window's width as it is allowed. Above,
 * because in this ticket everything the popover configures - price, size, the
 * percentage slider, both order buttons - is BELOW the leverage row, so the
 * band above the trigger is the one band that is guaranteed to hold nothing the
 * popover must not cover. It scrolls if the band is short (see POP_BAND_MIN)
 * rather than growing into the form.
 *
 * The vertical is clamped in both modes, so a short window cannot push the
 * Confirm button below the fold. It is never offscreen, and it never covers the
 * control that opened it.
 *
 * THE TRIGGER IS WATCHED, NOT SUBSCRIBED TO
 * -----------------------------------------
 * Every placement reads the trigger's rect at the moment it places. That alone
 * is not enough, and the reason is worth writing down because three obvious
 * wirings all fail here:
 *
 *   - `resize` fires BEFORE the grid has moved anything. react-grid-layout
 *     re-measures from its own window listener and then re-renders, so a
 *     listener that happens to run first reads the trigger exactly where it was
 *     before the window changed size. Measured: with the popover open, going
 *     1920 -> 1100 left the trigger at (568, 724) and the popover at (772, 94),
 *     630px adrift and squarely over the form.
 *   - Waiting a frame or two after `resize` does not fix it either. Measured on
 *     the same drag, the trigger was at (826, 556) 100ms in and at (568, 724) a
 *     second later - the panels are still sliding into place long after the
 *     event, because the grid transitions its transforms.
 *   - A ResizeObserver on the trigger sees none of that. Between those two
 *     samples the trigger was 252x24 the whole time; it MOVED, and a
 *     ResizeObserver is not told about movement.
 *
 * What all three miss is that "where the trigger is" is not an event. So while
 * the popover is open - and only then - a frame loop reads the trigger's rect
 * and the viewport's size, and re-places when either has changed since the last
 * placement. One `getBoundingClientRect()` per frame on one small element, for
 * the few seconds a popover is up, in exchange for a box that cannot come
 * unstuck from its trigger for any reason: window resize, grid reflow, a
 * neighbouring panel being dragged, an ancestor scrolling, or the transition
 * that follows any of them. `place()` itself is idempotent and the state is
 * only written when the placement actually differs, so a still trigger costs
 * one rect read a frame and nothing else.
 */
function useFloatPop(
  open: boolean,
  btnRef: React.RefObject<HTMLElement>,
  popRef: React.RefObject<HTMLElement>,
  measureRef: React.RefObject<HTMLElement>,
): FloatPos | null {
  const [pos, setPos] = useState<FloatPos | null>(null);

  const place = useCallback(() => {
    const btn = btnRef.current;
    const pop = popRef.current;
    if (!btn || !pop) return;

    // Read now, every time. Nothing about the trigger is remembered between
    // placements - see the note on stale geometry above.
    const b = btn.getBoundingClientRect();
    // clientWidth, not innerWidth: innerWidth counts a classic scrollbar as
    // usable, which would let the clamp park the popover under it.
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    // Width BEFORE height: the presets wrap, so the height a placement is
    // clamped against is only true once the box is the width it will be painted
    // at. `offsetHeight`, not the bounding rect, because the enter animation is
    // a transform and a rect read mid-animation is a percent short. The
    // max-height goes to `none` first: measuring against the clamp a PREVIOUS
    // placement applied would ratchet the box smaller on every re-place.
    const measure = (want: number) => {
      pop.style.maxHeight = 'none';
      pop.style.width = `${Math.round(want)}px`;
      return { w: pop.offsetWidth, h: pop.offsetHeight };
    };
    // Written imperatively as well as through state: React skips a DOM write
    // when the value it last RENDERED is unchanged, which is not the same as
    // the value currently on the node after `measure` cleared it.
    //
    // The state is written only when the placement actually moved. The frame
    // loop below calls this on every change to the trigger's rect, and a
    // sub-pixel wobble that rounds to the same four numbers should not be a
    // React render - during a grid transition that is a render a frame for
    // nothing.
    const commit = (p: FloatPos) => {
      pop.style.maxHeight = `${p.maxHeight}px`;
      setPos((prev) =>
        prev &&
        prev.left === p.left &&
        prev.top === p.top &&
        prev.width === p.width &&
        prev.maxHeight === p.maxHeight &&
        prev.mode === p.mode
          ? prev
          : p,
      );
    };

    const preferred = measureRef.current?.getBoundingClientRect().width ?? POP_MIN_W;
    const side = measure(
      Math.min(Math.max(POP_MIN_W, Math.min(POP_MAX_W, preferred)), vw - POP_EDGE * 2),
    );

    // Room for the BOX on each side of the trigger, with the gap and the window
    // edge already paid for. Asked before placing rather than after clamping:
    // "it did not fit, so it is now on top of the thing it configures" is not a
    // placement, it is a fallback that should never have been reachable.
    const roomLeft = b.left - POP_GAP - POP_EDGE;
    const roomRight = vw - POP_EDGE - POP_GAP - b.right;

    if (roomLeft >= side.w || roomRight >= side.w) {
      const left = roomLeft >= side.w ? b.left - POP_GAP - side.w : b.right + POP_GAP;
      // Top-aligned with the trigger, then pulled up only as far as it has to.
      let top = b.top;
      if (top + side.h + POP_EDGE > vh) top = vh - POP_EDGE - side.h;
      commit({
        left: Math.round(Math.max(POP_EDGE, Math.min(left, vw - POP_EDGE - side.w))),
        top: Math.round(Math.max(POP_EDGE, top)),
        width: side.w,
        maxHeight: vh - POP_EDGE * 2,
        mode: 'side',
      });
      return;
    }

    // Neither side fits: sheet. Re-measured at the wider sheet measure, because
    // the presets wrap and a wider box is a SHORTER one - which is most of what
    // makes it fit in the band above the trigger on a phone.
    const sheet = measure(Math.min(POP_MAX_W, vw - POP_EDGE * 2));
    const bandAbove = b.top - POP_GAP - POP_EDGE;
    const bandBelow = vh - b.bottom - POP_GAP - POP_EDGE;
    const above = bandAbove >= Math.min(sheet.h, POP_BAND_MIN) || bandAbove >= bandBelow;
    commit({
      left: Math.round(Math.max(POP_EDGE, (vw - sheet.w) / 2)),
      // Hung, not stacked: the edge that touches the trigger is pinned 4px off
      // it and the box grows away from it, so a box too tall for the band is
      // clipped at the window edge and scrolls - it never grows across the
      // trigger.
      top: Math.round(above ? Math.max(POP_EDGE, b.top - POP_GAP - sheet.h) : b.bottom + POP_GAP),
      width: sheet.w,
      maxHeight: Math.max(0, above ? bandAbove : bandBelow),
      mode: 'sheet',
    });
  }, [btnRef, popRef, measureRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    // A layout effect, so the corrected position is committed in the same frame
    // the popover first paints in - the box is rendered `visibility: hidden`
    // until then and never flashes at 0,0.
    place();

    // Then watch, rather than subscribe - see the note above for the three
    // event wirings this replaces and why each of them misses. The rect read is
    // the only work done on a frame where nothing moved; `place()` runs, and a
    // render can follow, only when the trigger or the viewport has actually
    // changed since the last placement.
    let raf = 0;
    let last = '';
    const watch = () => {
      raf = requestAnimationFrame(watch);
      const b = btnRef.current?.getBoundingClientRect();
      if (!b) return;
      const now = `${b.left} ${b.top} ${b.width} ${b.height} ${document.documentElement.clientWidth} ${document.documentElement.clientHeight}`;
      if (now === last) return;
      last = now;
      place();
    };
    watch();

    return () => cancelAnimationFrame(raf);
  }, [open, place, btnRef]);

  return pos;
}

export function OrderEntry({
  engine, symbol, sym, network, unlocked, showTitle = true,
  connectedAddress, signingAddress, price, onPrice, lastPrice, onPlaced,
}: Props) {
  const [type, setType] = useState<OrdType>('limit');
  /** While the ticket cannot trade, the order button connects or enables instead. */
  const gate = useTradeGate(connectedAddress, unlocked);
  const [sizeInput, setSizeInput] = useState('');
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>('base');
  const [stopPrice, setStopPrice] = useState('');
  const [stopKind, setStopKind] = useState<'sl' | 'tp'>('sl');
  const [trigger, setTrigger] = useState<'mark' | 'last' | 'index'>('mark');
  /** A stop can execute as a market order (fills on trigger) or a limit order. */
  const [stopExec, setStopExec] = useState<'market' | 'limit'>('market');
  /*
   * TIF is GTC or IOC, and nothing else.
   *
 * GTC, IOC or GTX. FOK is gone: all-or-nothing on a book this thin is an
   * option whose usual outcome is "nothing happened".
   *
   * GTX IS POST-ONLY, as a time-in-force rather than as a separate checkbox -
   * which is what it always was on the wire (server/src/routes/trade.ts maps
   * post-only to GTX). One control now, because a checkbox that silently
   * overrode the TIF select beside it was two controls for one field.
   *
   * NOT ALL-OR-NOTHING: a SoDEX GTX order can partially fill and then have the
   * remainder rejected, so it is not a guarantee of a maker fee on the whole
   * size. The row says so when it is selected.
   *
   * A market order can never rest on the book, so it is IOC and the control is
   * not offered. `effectiveTif` is what actually gets sent.
   */
  const [tif, setTif] = useState<'gtc' | 'ioc' | 'gtx'>('gtc');
  const [reduceOnly, setReduceOnly] = useState(false);
  /**
   * WHICH WAY THE TRADE GOES, chosen at the top of the ticket rather than by
   * which of two submit buttons you press.
   *
   * The two-button ending made the direction the LAST thing you decided, and
   * left every number above it - margin, liquidation estimate, the exits -
   * describing a trade whose direction was still unknown. It leads now, and one
   * submit button reads back the choice.
   */
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  /** Whether the fee row is expanded to show which tier produced it. */
  /* The two account facts at the top of the ticket are the balance and the
     position - both named incognito categories, and both on screen whenever
     the trade page is. */
  const maskFunds = useMask('funds');
  const maskPositions = useMask('positions');
  const [feesOpen, setFeesOpen] = useState(false);
  /** One switch for both exits, per the ticket's own layout. */
  const [useExits, setUseExits] = useState(false);
  /** Whether gain/loss beside each exit is a quote amount or a percentage. */
  const [exitUnit, setExitUnit] = useState<'usd' | 'pct'>('usd');
  const [tpPrice, setTpPrice] = useState('');
  const [slPrice, setSlPrice] = useState('');
  const [leverage, setLeverage] = useState('');
  const [marginMode, setMarginMode] = useState<'cross' | 'isolated'>('cross');
  const [busy, setBusy] = useState(false);
  /** Which of the two header popovers is open; at most one, ever. */
  const [pop, setPop] = useState<Pop>(null);
  /** Leverage being edited in the popover, committed only on Confirm. */
  const [levDraft, setLevDraft] = useState(1);
  const { msg, show, fromError } = useStatus();
  const { confirm, dialog } = useConfirm();
  /* The dashboard is a registry of panels and nothing stops a layout holding
     two tickets, so the label/input pairing cannot use literal ids. */
  const uid = useId();
  const marginRef = useRef<HTMLDivElement>(null);
  const levRef = useRef<HTMLDivElement>(null);
  /* The leverage popover is portalled out of the panel, so it needs three more
     handles than an in-flow popover does: the trigger it is anchored to, its
     own box (for the measure, and for the containment check that keeps a press
     inside it from reading as an outside press), and the mode row, whose width
     is the measure it inherits. */
  const modeRowRef = useRef<HTMLDivElement>(null);
  const levBtnRef = useRef<HTMLButtonElement>(null);
  const levPopRef = useRef<HTMLDivElement>(null);
  /**
   * The review's "don't show again" tick, held until the order is actually
   * confirmed. Persisting it on change instead would mean opening the review,
   * ticking the box and then cancelling silently disabled every future review -
   * a preference change the user never agreed to.
   */
  const suppressPending = useRef(false);

  const closePop = useCallback(() => setPop(null), []);
  useDismiss(pop === 'margin', [marginRef], closePop);
  useDismiss(pop === 'leverage', [levRef, levPopRef], closePop);
  const levPos = useFloatPop(pop === 'leverage', levBtnRef, levPopRef, modeRowRef);

  /**
   * Keyboard focus follows the leverage popover out of the panel.
   *
   * A portal moves the box in the DOM but not in the React tree, and TAB ORDER
   * is the DOM's. Left alone, tabbing off the leverage button would walk into
   * the order type tabs while its popover sat open somewhere at the end of
   * <body>. So focus moves to the popover on open (the box itself, not the
   * multiplier field - focusing an input summons the on-screen keyboard on
   * touch, and a container at tabIndex -1 puts the next Tab inside it anyway)
   * and returns to the trigger on close, which is what makes Escape leave the
   * keyboard where it started.
   *
   * GATED ON THE POSITION, NOT ON `pop`, and that is not a detail. The popover's
   * first commit renders it `visibility: hidden` until the layout effect has
   * measured it, and `focus()` on a hidden element is a silent no-op - React
   * flushes this passive effect BEFORE the re-render that reveals the box, so
   * keyed on `pop` alone the call lands in the one commit where it cannot work
   * and Tab walks into the panel exactly as if none of this were here. Verified
   * in a real browser: focus stayed on the pill, and Tab went to the margin
   * button. Waiting for `levPos` waits for the visible box.
   *
   * Restored only when nothing else has claimed focus: dismissing by pressing
   * on the size field must not have the ticket yank the caret back out of it.
   */
  const levPlaced = pop === 'leverage' && levPos !== null;
  useEffect(() => {
    if (!levPlaced) return;
    const btn = levBtnRef.current;
    levPopRef.current?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body) btn?.focus({ preventScroll: true });
    };
  }, [levPlaced]);

  /** The symbol's published cap, or null when it publishes none. */
  const maxLev =
    typeof sym?.maxLeverage === 'number' && Number.isFinite(sym.maxLeverage) && sym.maxLeverage > 0
      ? Math.floor(sym.maxLeverage)
      : null;
  const clampLev = useCallback(
    (n: number) => Math.max(1, Math.round(maxLev === null ? n : Math.min(maxLev, n))),
    [maxLev],
  );

  /**
   * Seed leverage from the symbol, and - the part that matters - pull it back
   * down when you switch into a market with a lower cap. Carrying 50x from a
   * major into a symbol capped at 10x used to leave the ticket previewing a
   * margin requirement and a liquidation price that the venue would never let
   * you take.
   */
  useEffect(() => {
    if (!sym) return;
    const cur = num(leverage);
    if (!(cur > 0)) {
      if (sym.initLeverage) setLeverage(String(clampLev(sym.initLeverage)));
      return;
    }
    if (maxLev !== null && cur > maxLev) setLeverage(String(maxLev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sym?.name]);

  /**
   * Reads and writes resolve the account through two independent paths: every
   * read is keyed on the wallet selected in the UI, while every write is signed
   * by whichever key the backend currently holds unlocked. Nothing upstream
   * reconciles them, so they can silently disagree - you would be reading one
   * account's positions while your orders execute on another. Refuse to trade
   * in that state rather than let a confident-looking ticket hit the wrong
   * account.
   */
  const accountMismatch = Boolean(
    unlocked && connectedAddress && signingAddress &&
    connectedAddress.toLowerCase() !== signingAddress.toLowerCase(),
  );

  // Account state, keyed on the CONNECTED wallet like every other read in the
  // app. Shared with Balances (Account.tsx) via accountFeeds.ts - this used
  // to be its own independent poll; when both were mounted (the normal case
  // on the trade page) that was two identical requests every 20s for the
  // same address. This subscribes to the SAME feed, at no extra REST cost,
  // and also now benefits from Balances' WS-triggered refresh even though
  // this component itself listens to no channel.
  const acctKey = connectedAddress ? `state:${engine}:${connectedAddress}` : null;
  const acct = useAccountResource(acctKey, () => api.state(engine, connectedAddress!), 20_000);
  const available = readAvailable(acct.data, engine, sym?.quoteCoin, sym?.baseCoin, side, marginMode);

  // Current position in THIS market, for the read-out. Shared with the
  // Positions panel and Chart.tsx via accountFeeds.ts - previously documented
  // here as "one extra request every 15s" when both were mounted; now zero.
  const posKey = connectedAddress && engine === 'perps' ? `pos:${connectedAddress}` : null;
  const posQ = useAccountResource(posKey, () => api.positions(connectedAddress!), 10_000);
  const positionRow = (posQ.data?.positions ?? []).find(
    (p) => String(pick(p, 'symbol', 's') ?? '') === symbol,
  );
  /**
   * null = we have no answer (no wallet, still loading, read failed).
   * 0     = the venue answered and there is no position in this market, which
   *         is a real fact and prints as a real zero.
   */
  const positionQty =
    posQ.data == null ? null : positionRow ? num(pick(positionRow, 'size', 'positionAmt', 'pa', 'q')) : 0;
  const positionDir = positionRow ? positionDirection(positionRow) : null;

  // A stop that executes at market has no limit price, so value it at last.
  /* Switching perps -> spot with the Stop tab selected would leave a type this
     engine cannot express. Fall back to Limit rather than carrying it across. */
  useEffect(() => {
    if (engine !== 'perps' && type === 'stop') setType('limit');
  }, [engine, type]);

  // A book or chart click can land off the grid. Correct it here so the box
  // never shows a price the tick would refuse if it had been typed.
  useEffect(() => {
    if (!sym?.tickSize || price === '') return;
    const next = tickInput(price, sym.tickSize);
    if (next !== price) onPrice(next);
  }, [price, sym?.tickSize, onPrice]);

  const marketExec = type === 'market' || (type === 'stop' && stopExec === 'market');
  /**
   * The price the order will actually carry. The field itself refuses an
   * off-tick keystroke, and the signing path snaps again (sodex-core
   * normaliseOrder, 'nearest'). This still values the ticket at the snapped
   * price when a click or a feed lands one that is not on the grid yet.
   */
  const snappedPrice = (() => {
    if (!sym?.tickSize || !(num(price) > 0)) return null;
    try {
      const snapped = roundToStep(price, sym.tickSize, 'nearest');
      return num(snapped) !== num(price) ? snapped : null;
    } catch {
      return null;
    }
  })();
  const effectivePrice = marketExec ? num(lastPrice) : num(snappedPrice ?? price);

  /**
   * What actually goes on the wire: base units, always.
   *
   * In base mode this is the raw string as typed - unparsed, unrounded - which
   * is the rule stated at the top of this file. Quote mode cannot honour that
   * rule (a division is the whole point of the unit), so it does the next best
   * thing: divide once, round to the symbol's own step precision, and RENDER
   * that exact string back to the user under the field. What you see is what is
   * signed. With no usable price there is nothing to divide by, so the size is
   * empty and both order buttons stay disabled rather than sending a guess.
   */
  const quoteAmount = sizeUnit === 'quote' ? num(sizeInput) : 0;
  const quantity =
    sizeUnit === 'base'
      ? sizeInput
      : quoteAmount > 0 && effectivePrice > 0
        ? (quoteAmount / effectivePrice).toFixed(precisionOf(sym?.stepSize))
        : '';

  const notional = effectivePrice * num(quantity);
  /*
   * The order value EXACTLY: price x size as decimal strings (BigInt, no float),
   * shown with every decimal it has - "1,052.6375 USDC", not a rounded
   * "$1,052.64". The float above is only for comparisons (min notional, %).
   */
  const notionalExact = (() => {
    const px = marketExec ? lastPrice : (snappedPrice ?? price);
    if (!px || !(num(quantity) > 0) || !(num(px) > 0)) return null;
    try {
      return mulDecimal(String(px), String(quantity));
    } catch {
      return null;
    }
  })();
  const minNotional = sym && num(sym.minNotional) > 0 ? sym.minNotional : null;
  const maxNotional = sym?.maxNotional && num(sym.maxNotional) > 0 ? sym.maxNotional : null;
  const belowMin = minNotional !== null && notional > 0 && notional < num(minNotional);
  const aboveMax = maxNotional !== null && notional > num(maxNotional);
  const lev = num(leverage);

  /*
   * A market order must not rest on the book, so it is IOC whatever the control
   * last said. Derived rather than forced into state: flipping to Market and back
   * to Limit would otherwise leave the user's GTC silently changed to IOC.
   */
  const effectiveTif: 'gtc' | 'ioc' | 'gtx' = marketExec ? 'ioc' : tif;

  /*
   * TP/SL gain and loss.
   *
   * Both directions, because the two fields are one number seen two ways: type a
   * target price and read the money, or type the money and read the price back.
   *
   * A LONG gains when the price rises and a SHORT when it falls, which is why
   * `side` is in the formula rather than an absolute difference - a stop above
   * entry is a loss on a long and a profit on a short.
   *
   * The percentage is RETURN ON MARGIN, not a price move: the money is already
   * shown beside it, so a second reading of the same price distance adds
   * nothing, whereas "this trade risks 40% of what it ties up" is the figure
   * leverage actually changes. Spot has no margin, so there it is return on cost.
   */
  const exitBasis = engine === 'perps' && lev > 0 ? notional / lev : notional;

  const pnlAtPrice = (target: string): number | null => {
    const t = num(target);
    const q = num(quantity);
    if (!(t > 0 && effectivePrice > 0 && q > 0)) return null;
    return (side === 'buy' ? t - effectivePrice : effectivePrice - t) * q;
  };

  /*
   * A price for an INPUT, not for a label.
   *
   * `fmtPrice` groups thousands - it is a display formatter - and writing
   * "78,140" into the price box made the ticket read it as 78: an order value of
   * $1.00 for a whole BTC. Anything that fills a field has to produce a bare
   * decimal at the symbol's own precision.
   */
  const toFieldPrice = (v: number): string => tickInput(v.toFixed(precisionOf(sym?.tickSize)), sym?.tickSize);

  const priceAtPnl = (pnl: number): number | null => {
    const q = num(quantity);
    if (!(effectivePrice > 0 && q > 0)) return null;
    return side === 'buy' ? effectivePrice + pnl / q : effectivePrice - pnl / q;
  };

  /** The money field's displayed value, in whichever unit is selected. */
  const exitAmountText = (target: string): string => {
    const pnl = pnlAtPrice(target);
    if (pnl === null) return '';
    if (exitUnit === 'usd') return pnl.toFixed(2);
    return exitBasis > 0 ? ((pnl / exitBasis) * 100).toFixed(2) : '';
  };

  /** Typing in the money field back-solves the trigger price. */
  const setExitFromAmount = (raw: string, apply: (price: string) => void): void => {
    if (raw.trim() === '') { apply(''); return; }
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    const pnl = exitUnit === 'usd' ? v : (v / 100) * exitBasis;
    const t = priceAtPnl(pnl);
    if (t === null || !(t > 0)) return;
    apply(toFieldPrice(t));
  };

  // --- slippage, walked against real depth ----------------------------------
  //
  // Slippage is only a real quantity for an order that crosses the spread, and
  // only against a book deep enough to fill it. The subscription is therefore
  // conditional: it costs nothing while the ticket is empty or priced as a
  // limit, and ws.ts refcounts the topic, so when the book panel is on screen
  // this is free. Both sides are shown because this panel has no side until a
  // button is pressed.
  const [book, setBook] = useState<OrderBook | null>(null);
  const needsDepth = marketExec && num(quantity) > 0;
  /*
   * A LIMIT ticket wants top-of-book too, for the MID button beside the price.
   * That is one refcounted `l2Book` topic - and on the trade page the book panel
   * is already holding it, so this adds no subscription at all there. It buys a
   * button that can name a real mid instead of quietly substituting last price,
   * which on a wide spread is a different number.
   */
  const wantsTop = !marketExec;
  const subscribeBook = needsDepth || wantsTop;
  const bookSeed = useAsync(
    () => api.orderbook(engine, symbol, 100),
    [engine, symbol],
    { enabled: subscribeBook },
  );
  // Depth from another market is worse than no depth - every figure derived
  // from it would be confidently wrong - so drop it the instant the symbol
  // changes rather than waiting for the next push to replace it.
  useEffect(() => setBook(null), [engine, symbol]);
  useEffect(() => { if (bookSeed.data?.book) setBook(bookSeed.data.book); }, [bookSeed.data]);
  useChannel(engine, subscribeBook ? { channel: 'l2Book', symbol, level: 100 } : null, (d) => {
    if (d?.b || d?.a) setBook({ bids: d.b ?? [], asks: d.a ?? [], updateID: d.u, blockTime: d.E });
  });

  /*
   * TWO fee schedules, and the difference between them is the whole point.
   *
   * `sym.makerFee` / `sym.takerFee` is the market's PUBLISHED default. The
   * account's own rate comes from the venue's fee-rate endpoint and is what will
   * actually be charged - lower when volume or staking has earned a tier. Showing
   * only the symbol default told a discounted account the wrong number; showing
   * only the account rate hid the discount it had earned.
   */
  const feeRes2 = useAsync(
    () => api.feeRate(engine, connectedAddress!),
    [engine, connectedAddress],
    { enabled: !!connectedAddress },
  );
  const acctFee = (() => {
    const r = (feeRes2.data?.feeRate ?? feeRes2.data) as
      | { takerFeeRate?: string; makerFeeRate?: string; feeTier?: number; stakingTier?: number }
      | undefined;
    return r && r.takerFeeRate !== undefined && r.makerFeeRate !== undefined ? r : null;
  })();

  const defTaker = sym ? num(sym.takerFee) : null;
  const defMaker = sym ? num(sym.makerFee) : null;
  const ownTaker = acctFee ? num(acctFee.takerFeeRate) : null;
  const ownMaker = acctFee ? num(acctFee.makerFeeRate) : null;
  /* A discount only counts if it is actually cheaper - an account on the base
     tier reports the same numbers, and striking those through would invent a
     saving that is not there. A hair of tolerance because these are decimal
     strings from two different endpoints. */
  const discounted =
    ownTaker !== null && ownMaker !== null && defTaker !== null && defMaker !== null
    && (ownTaker < defTaker - 1e-9 || ownMaker < defMaker - 1e-9);

  const pctRate = (v: number) => `${fmt(v * 100, 4)}%`;
  /** Taker first: it is the higher number and the one a market order pays. */
  const feePair = (t: number, m: number) => `${pctRate(t)} / ${pctRate(m)}`;

  const orderQty = num(quantity);
  const bestAsk = num(book?.asks?.[0]?.[0]);
  const bestBid = num(book?.bids?.[0]?.[0]);
  /** True mid, or null when either side of the book is missing. */
  const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : null;
  /** Max slippage the user will accept, as a percent. 1 means 1%. */
  const [maxSlip, setMaxSlip] = useState('1.00');
  const [slipOpen, setSlipOpen] = useState(false);
  const [slipDraft, setSlipDraft] = useState('1.00');
  const slipRef = useRef<HTMLDivElement>(null);
  useDismiss(slipOpen, [slipRef], () => setSlipOpen(false));
  // Quote size with an empty price box is converted at the mid so the field
  // still means something. A limit is not sent until a price is typed.
  const sizingPx = effectivePrice > 0 ? effectivePrice : (midPrice ?? 0);
  const liveQtyStr = sizeUnit === 'base'
    ? sizeInput
    : quoteAmount > 0 && sizingPx > 0
      ? (quoteAmount / sizingPx).toFixed(precisionOf(sym?.stepSize))
      : '';
  const liveQty = num(liveQtyStr);
  const levels = side === 'buy' ? book?.asks : book?.bids;
  const limitPx = marketExec ? null : (num(price) > 0 ? num(price) : null);
  // One walk, of the order actually being built. A resting limit stops at its
  // own price, so the estimate is 0 when it does not cross. The book does not
  // use this walk for a limit: a limit only thickens the level it would join.
  const walked = liveQty > 0
    ? walkBook(levels, liveQty, side, marketExec ? null : limitPx)
    : { avg: null, takes: [] as RawTake[] };
  const resting = !marketExec && limitPx !== null && liveQty > 0
    ? { price: limitPx, qty: liveQty }
    : null;
  const touch = side === 'buy' ? bestAsk : bestBid;
  const estSlip = liveQty <= 0
    ? 0
    : !levels?.length
      ? null
      : walked.avg !== null && touch > 0
        ? (Math.abs(walked.avg - touch) / touch) * 100
        : 0;
  const maxSlipN = num(maxSlip);
  const venueMaxPct = sym?.marketDeviationRatio && num(sym.marketDeviationRatio) > 0
    ? num(sym.marketDeviationRatio) * 100
    : null;
  const slipCap = venueMaxPct !== null ? Math.min(SLIP_CAP_PCT, venueMaxPct) : SLIP_CAP_PCT;
  const depthTakes = marketExec ? walked.takes : [];
  const takeKey = depthTakes.map((t) => `${t.price}:${t.taken}`).join(',');
  const restKey = resting ? `${resting.price}:${resting.qty}` : '';
  useEffect(() => {
    if (depthTakes.length === 0 && !resting) {
      publishOrderImpact(null);
      return;
    }
    publishOrderImpact({ symbol, side, takes: depthTakes, rest: resting });
    // takeKey / restKey are the published values; the objects are new every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, side, takeKey, restKey]);
  useEffect(() => () => publishOrderImpact(null), []);
  useEffect(() => {
    if (num(maxSlip) > slipCap) setMaxSlip(slipCap.toFixed(2));
  }, [slipCap, maxSlip]);

  /**
   * Notional that 100% on the slider corresponds to.
   *
   * Perps: free margin x leverage - the position you could open with everything
   * that is not already committed. Spot: the free quote balance, which sizes a
   * BUY; a sell is capped by your base balance instead, and this ticket has no
   * side until a button is pressed, so that caveat is printed rather than
   * papered over.
   */
  const sliderBasis =
    available === null || available <= 0
      ? null
      : engine === 'perps'
        ? (lev > 0 ? available * lev : null)
        : available;
  const sliderReady = sliderBasis !== null && effectivePrice > 0 && Boolean(sym);
  const usedPct = sliderReady && notional > 0 ? (notional / sliderBasis!) * 100 : 0;
  // The thumb is clamped at 100; the printed figure is not. Over-committing is
  // a thing you should be able to SEE, not a number that silently saturates.
  const thumbPct = Math.max(0, Math.min(100, Math.round(usedPct)));

  const sliderBlocked = !connectedAddress
    ? 'Connect a wallet to size by percentage.'
    : acct.loading && !acct.data
      ? 'Reading available balance…'
      : acct.error && !acct.data
        ? couldntLoad(`Available ${engine === 'perps' ? 'margin' : 'balance'}`)
      : available === null
        ? `Available ${engine === 'perps' ? 'margin' : 'balance'} unavailable — size manually.`
        : available <= 0
          ? 'No free balance to size against.'
          : engine === 'perps' && !(lev > 0)
            ? 'Set a leverage to size by percentage.'
            : !(effectivePrice > 0) || !sym
              ? 'No price to size against yet.'
              : null;

  /** Write a percentage of the slider basis into whichever unit is selected. */
  function setPct(pct: number) {
    if (!sliderReady) return;
    // 0% is no order: an empty field, not "0.00000" sitting in the size box.
    if (!(pct > 0)) {
      setSizeInput('');
      return;
    }
    const target = (sliderBasis! * pct) / 100;
    setSizeInput(
      sizeUnit === 'quote'
        ? target.toFixed(2)
        : trimZeros((target / effectivePrice).toFixed(precisionOf(sym?.stepSize))),
    );
  }

  /**
   * Switch units WITHOUT changing the order.
   *
   * Naively flipping the dropdown would reinterpret "0.5" from half a bitcoin
   * to fifty cents. The typed figure is converted through the same price the
   * ticket is already valued at, so the order you built survives the switch.
   * Without a price there is nothing to convert with, so the field is cleared -
   * an empty field is honest, a stale one is not.
   */
  function switchUnit(next: SizeUnit) {
    if (next === sizeUnit) return;
    const cur = num(sizeInput);
    if (!(cur > 0) || !(effectivePrice > 0)) setSizeInput('');
    else if (next === 'quote') setSizeInput((cur * effectivePrice).toFixed(2));
    else setSizeInput(trimZeros((cur / effectivePrice).toFixed(precisionOf(sym?.stepSize))));
    setSizeUnit(next);
  }

  // --- liquidation risk (perps only) ---------------------------------------
  //
  // The stop is checked against the side selected at the top of the ticket.
  // A stop on the profitable side of that entry fires immediately; one past
  // or on the estimated liquidation cannot protect the position.
  //
  // Cross margin is deliberately evaluated with isolated-margin math (no extra
  // collateral folded in). Under cross the account's spare balance pushes
  // liquidation further away, so this errs toward warning slightly early rather
  // than reassuring the user and being wrong - the safe direction for a guardrail.
  const riskBase = {
    entryPrice: effectivePrice,
    quantity: num(quantity),
    leverage: lev,
    sym,
    marginMode,
  };
  const liqLong = engine === 'perps' ? estimateLiquidationPrice({ ...riskBase, side: 'buy' as const }) : null;
  const liqShort = engine === 'perps' ? estimateLiquidationPrice({ ...riskBase, side: 'sell' as const }) : null;

  /* Each exit is "on" when the combined switch is on AND that box has a price -
     so an empty field is simply not attached, rather than a second checkbox. */
  const useTp = useExits && num(tpPrice) > 0;
  const useSl = useExits && num(slPrice) > 0;
  const activeSl = num(useSl ? slPrice : type === 'stop' && stopKind === 'sl' ? stopPrice : '');
  const stopCheck =
    engine === 'perps' && activeSl > 0 && effectivePrice > 0
      ? checkStopAgainstLiquidation(activeSl, { ...riskBase, side })
      : null;
  const stopWarn = stopCheck?.severity === 'warn' ? stopCheck.verdict : null;
  const warned = useRef<string | null>(null);
  useEffect(() => {
    if (!stopWarn || !stopCheck?.message) {
      warned.current = null;
      return;
    }
    if (warned.current === stopWarn) return;
    warned.current = stopWarn;
    notify('warn', stopCheck.message);
  }, [stopWarn, stopCheck?.message]);

  const liveNotional = sizingPx * liveQty;
  const liveBelow = minNotional !== null && liveNotional > 0 && liveNotional < num(minNotional);
  const liveAbove = maxNotional !== null && liveNotional > num(maxNotional);
  const canSend = !busy && unlocked && !accountMismatch && !liveBelow && !liveAbove
    && liveQty > 0 && (marketExec || num(price) > 0) && !(type === 'stop' && !stopPrice);

  async function place(side: 'buy' | 'sell') {
    if (!unlocked) return show('err', 'Enable trading first.');
    if (!marketExec && !(num(price) > 0)) return show('err', 'Enter a price.');
    if (liveBelow) return show('err', `Below minimum ${fmt(minNotional)} ${coinLabel(sym?.quoteCoin)}.`);
    if (liveAbove) return show('err', `Above maximum ${fmt(maxNotional)} ${coinLabel(sym?.quoteCoin)}.`);
    if (accountMismatch) {
      return show(
        'err',
        `Refusing to trade: this screen shows ${shortAddr(connectedAddress ?? undefined)} but the unlocked key signs as ${shortAddr(signingAddress ?? undefined)}. The order would execute on a different account than the one you are looking at.`,
      );
    }

    // An order is never one click away. The review is suppressible for the
    // routine case, but `shouldReview` keeps it unconditional for real money
    // above a floor - see ALWAYS_REVIEW_NOTIONAL_USD in ReviewPosition.tsx.
    if (shouldReview(network, liveNotional)) {
      const review: ReviewOrder = {
        side,
        engine,
        symbol,
        sym,
        orderType: type,
        marketExec,
        entryPrice: effectivePrice > 0 ? effectivePrice : sizingPx,
        quantity: liveQty,
        notional: liveNotional,
        leverage: lev,
        marginMode,
        triggerPrice: type === 'stop' ? num(stopPrice) : undefined,
        triggerKind: type === 'stop' ? stopKind : undefined,
        triggerOn: type === 'stop' ? trigger : undefined,
        // Attached exits are perps-only and are only sent when their checkbox is
        // on, so the review must gate on exactly the same conditions the request
        // body does - otherwise it would show a TP that never gets submitted.
        tpPrice: engine === 'perps' && useTp ? num(tpPrice) : 0,
        slPrice: engine === 'perps' && useSl ? num(slPrice) : 0,
        reduceOnly,
        tif: effectiveTif,
        network,
        signingAddress,
      };

      // Re-run the stop check for the side actually being placed. The panel's
      // own check has to infer a side (there is no side until a button is
      // pressed); here there is no ambiguity, so a genuinely unprotectable stop
      // can be gated behind a separate acknowledgement rather than warned about.
      const reviewStopLevel = useSl && slPrice ? num(slPrice) : type === 'stop' && stopKind === 'sl' ? num(stopPrice) : 0;
      const reviewStop =
        engine === 'perps' && !reduceOnly && reviewStopLevel > 0 && effectivePrice > 0
          ? checkStopAgainstLiquidation(reviewStopLevel, { ...riskBase, side })
          : null;

      suppressPending.current = false;
      const ok = await confirm({
        title: network === 'mainnet' ? 'Review order — real funds' : 'Review order',
        size: 'md',
        danger: network === 'mainnet',
        confirmLabel: side === 'buy' ? 'Place buy / long' : 'Place sell / short',
        cancelLabel: 'Back to ticket',
        requireAck:
          reviewStop?.verdict === 'beyond-liquidation'
            ? 'I understand liquidation would happen before this stop loss.'
            : undefined,
        body: <ReviewPosition order={review} onSuppressChange={(v) => { suppressPending.current = v; }} />,
      });
      if (!ok) return;
      if (suppressPending.current) setReviewSuppressed(true);
    }

    setBusy(true);
    try {
      // A stop order is market-or-limit in its own right; only the plain
      // "limit" tab is unconditionally a limit order.
      const asMarket = type === 'market' || (type === 'stop' && stopExec === 'market');
      const body: any = {
        symbol,
        side,
        type: asMarket ? 'market' : 'limit',
        quantity: liveQtyStr || undefined,
        reduceOnly: reduceOnly || undefined,
      };
      if (!asMarket) body.price = price;
      else if (touch > 0 && maxSlipN > 0) {
        // A market order's price is the slippage cap, and it cannot sit above slipCap.
        const slip = Math.min(maxSlipN, slipCap);
        const cap = touch * (side === 'buy' ? 1 + slip / 100 : 1 - slip / 100);
        body.price = tickInput(cap.toFixed(Math.max(precisionOf(sym?.tickSize), 0)), sym?.tickSize);
      }
      if (type === 'stop') {
        body.stopPrice = stopPrice;
        body.stopType = stopKind;
        body.triggerType = trigger;
      }
      body.tif = effectiveTif;
      if (engine === 'perps') {
        if (useTp && tpPrice) body.takeProfit = { price: tpPrice };
        if (useSl && slPrice) body.stopLoss = { price: slPrice };
      }

      const res = await api.placeOrder(engine, body);
      const sideWord = engine === 'perps' ? (side === 'buy' ? 'Long' : 'Short') : (side === 'buy' ? 'Buy' : 'Sell');
      const base = coinLabel(sym?.baseCoin) || (sym?.displayName ?? symbol);
      notifyTrade('placed', {
        coin: sym?.baseCoin ?? undefined,
        title: `${type === 'stop' ? 'Stop' : asMarket ? 'Market' : 'Limit'} ${sideWord.toLowerCase()} placed`,
        detail: `${quantity} ${base} @ ${asMarket ? 'market' : fmtPrice(price, sym?.tickSize)}${res.orderCount > 1 ? ` · +${res.orderCount - 1} exit order${res.orderCount > 2 ? 's' : ''}` : ''}`,
      });
      onPlaced();
    } catch (e) {
      fromError(e);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Push margin mode / leverage to the venue.
   *
   * Read-only is a legitimate state to sit in - you can still build and price a
   * ticket - so a locked session changes the LOCAL value (which is what the
   * margin and liquidation read-out is computed from) and simply does not call
   * the venue. The popovers say so, because a preview that silently disagrees
   * with the exchange is the same class of bug as the account mismatch above.
   */
  async function pushLeverage(nextLev: number, nextMode: 'cross' | 'isolated') {
    if (!unlocked || !(nextLev > 0)) return;
    // Not `busy`: that flag is the Long/Short button's "Working…" state, and
    // changing leverage or margin mode is not placing an order.
    try {
      await api.setLeverage(symbol, nextLev, nextMode);
    } catch (e) {
      fromError(e);
    }
  }

  function openLeveragePop() {
    setLevDraft(clampLev(lev > 0 ? lev : (sym?.initLeverage ?? 1)));
    setPop((p) => (p === 'leverage' ? null : 'leverage'));
  }

  function chooseMargin(mode: 'cross' | 'isolated') {
    setMarginMode(mode);
    setPop(null);
    void pushLeverage(lev, mode);
  }

  function commitLeverage() {
    const next = clampLev(levDraft);
    setLeverage(String(next));
    setPop(null);
    void pushLeverage(next, marginMode);
  }

  // Presets, capped by the symbol's own maximum so the popover never offers a
  // leverage the venue would reject.
  const levPresets = [1, 2, 5, 10, 20, 50, 100]
    .filter((n) => maxLev === null || n < maxLev)
    .concat(maxLev === null ? [] : [maxLev]);

  /* What the venue signs, and what a person reads. `quoteCoin` still goes on
     the wire; `quoteLabel` is the only one that reaches the screen. */
  const quoteCoin = sym?.quoteCoin ?? '';
  const baseCoin = sym?.baseCoin ?? '';
  const quoteLabel = coinLabel(quoteCoin);
  const baseLabel = coinLabel(baseCoin);
  const availText =
    available === null ? DASH : `${fmt(available, engine === 'perps' ? 2 : 6)}${quoteLabel ? ` ${quoteLabel}` : ''}`;
  const positionText =
    positionQty === null
      ? DASH
      : `${fmtQty(Math.abs(positionQty), sym?.stepSize)}${baseCoin ? ` ${baseCoin}` : ''}`;

  const shownLev = pop === 'leverage' ? levDraft : lev;
  const heat = !(shownLev > 1)
    ? 0
    : maxLev !== null && maxLev > 1
      ? Math.min(1, (shownLev - 1) / (maxLev - 1))
      : Math.min(1, shownLev / 40);

  return (
    <section
      className={`panel oe is-${side}`}
      style={{
        ['--oe-wash' as string]: `${Math.round(7 + heat * 11)}%`,
        ['--oe-edge' as string]: `${Math.round(22 + heat * 28)}%`,
      }}
    >
      <div className="oe-fx" aria-hidden="true">
        <span className="oe-fx__rim">
          <span className="oe-fx__glare" />
        </span>
      </div>
      {showTitle && <h2>Order entry</h2>}

      {/*
        DIRECTION FIRST, above leverage and margin mode.
        The words differ by venue because the positions differ: a perp is a
        LONG or a SHORT, a spot trade is a BUY or a SELL of a coin you hold.
        Calling a spot buy "long" implies a position that can be closed at a
        profit or a loss, which is not what owning the coin is.
      */}
      <div className="oe-dir oe-dir--tabs" role="radiogroup" aria-label="Direction">
        {(['buy', 'sell'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={side === v}
            className={`oe-dir__btn is-${v}${side === v ? ' is-on' : ''}`}
            onClick={() => setSide(v)}
          >
            {engine === 'perps'
              ? (v === 'buy' ? 'Long' : 'Short')
              : (v === 'buy' ? 'Buy' : 'Sell')}
          </button>
        ))}
      </div>

      {/* 1. Leverage and margin mode: two equal buttons, each opening a popover.
       *
       * LEVERAGE LEADS. It is the figure that scales every other number on the
       * ticket - the margin requirement, the liquidation estimate, the notional
       * the percentage slider sizes against - and it is the one of the two you
       * change per trade rather than per account. Reading order puts the thing
       * you set most often first. */}
      {engine === 'perps' && (
        <div className="oe-mode" ref={modeRowRef}>
          <div className="oe-anchor" ref={levRef}>
            {/* The modifier exists for ONE reason: the font.
                Both pills share `.oe-mode__btn`, but the other one carries a
                WORD ("Cross") and this one carries a FIGURE ("20x"). The app
                splits its two families by content type - text in --font-text,
                every numeral in --font-num - so a class that renders both kinds
                cannot be mapped, and the leverage figure was the last numeral on
                the page still set in the text face. The mapping itself stays in
                the numeral block at the end of styles.css. */}
            <button
              ref={levBtnRef}
              type="button"
              className="oe-mode__btn oe-mode__btn--lev"
              aria-haspopup="dialog"
              aria-expanded={pop === 'leverage'}
              onClick={openLeveragePop}
            >
              {lev > 0 ? `${lev}x` : DASH}
            </button>
            {/* Portalled to <body> and placed from the button's own rect - see
                `useFloatPop`. Rendered here in the React tree so it stays next
                to the control it belongs to; only the DOM node moves. */}
            {pop === 'leverage' &&
              createPortal(
                <div
                  ref={levPopRef}
                  className={`oe-pop oe-pop--float${levPos?.mode === 'sheet' ? ' oe-pop--sheet' : ''}`}
                  role="dialog"
                  aria-label="Leverage"
                  tabIndex={-1}
                  style={{
                    left: levPos?.left ?? 0,
                    top: levPos?.top ?? 0,
                    width: levPos?.width,
                    maxHeight: levPos?.maxHeight,
                    // Hidden for exactly one commit: the layout effect that
                    // measures it runs before the browser paints, so this is
                    // never a visible frame - it only stops a box at 0,0.
                    visibility: levPos ? undefined : 'hidden',
                  }}
                >
                  <div className="oe-pop__title">
                    Leverage <span className="oe-pop__max">max {maxLev === null ? DASH : `${maxLev}x`}</span>
                  </div>
                  <div className="oe-pop__row">
                    <input
                      className="oe-input oe-input--lev"
                      autoComplete="off"
                      value={String(levDraft)}
                      inputMode="numeric"
                      aria-label="Leverage multiplier"
                      onChange={(e) => {
                        const n = Number.parseInt(e.target.value.replace(/[^\d]/g, ''), 10);
                        setLevDraft(Number.isFinite(n) ? clampLev(n) : 1);
                      }}
                    />
                    <span className="oe-pop__x">x</span>
                    <input
                      className="oe-lev-range"
                      type="range"
                      min={1}
                      max={maxLev ?? 100}
                      step={1}
                      value={levDraft}
                      disabled={maxLev === null}
                      aria-label="Leverage slider"
                      onChange={(e) => setLevDraft(clampLev(Number(e.target.value)))}
                    />
                  </div>
                  <div className="oe-pop__presets">
                    {levPresets.map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`oe-mini${levDraft === n ? ' is-on' : ''}`}
                        onClick={() => setLevDraft(n)}
                      >
                        {n}x
                      </button>
                    ))}
                  </div>
                  {maxLev === null && (
                    <p className="oe-pop__note">This symbol publishes no maximum leverage, so nothing here is clamped.</p>
                  )}
                  {!unlocked && <p className="oe-pop__note">Read-only — the change stays local until you enable trading.</p>}
                  <button type="button" className="oe-confirm" onClick={commitLeverage} disabled={busy}>
                    Confirm {clampLev(levDraft)}x
                  </button>
                </div>,
                document.body,
              )}
          </div>

          {/* The margin popover stays in flow. It is four lines tall, it is a
              pick-one-and-go chooser rather than something you sit and drag, and
              it opens over the order type tabs rather than over the price and
              size fields - so it does not have the problem that moved the
              leverage popover out of the panel. */}
          <div className="oe-anchor" ref={marginRef}>
            <button
              type="button"
              className="oe-mode__btn"
              aria-haspopup="dialog"
              aria-expanded={pop === 'margin'}
              onClick={() => setPop((p) => (p === 'margin' ? null : 'margin'))}
            >
              {marginMode === 'cross' ? 'Cross' : 'Isolated'}
            </button>
            {pop === 'margin' && (
              <div className="oe-pop" role="dialog" aria-label="Margin mode">
                <div className="oe-pop__title">Margin mode</div>
                {(['cross', 'isolated'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`oe-pop__opt${marginMode === m ? ' is-on' : ''}`}
                    onClick={() => chooseMargin(m)}
                  >
                    <b>{m === 'cross' ? 'Cross' : 'Isolated'}</b>
                    <span>
                      {m === 'cross'
                        ? 'The whole account backs the position.'
                        : 'Only this position’s margin is at risk.'}
                    </span>
                  </button>
                ))}
                {!unlocked && <p className="oe-pop__note">Read-only — the change stays local until you enable trading.</p>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. Order type. Market leads because it is the common ticket; the third
          tab says Stop because that is what it places - our advanced type is a
          trigger order, and naming it anything vaguer would be a control that
          does not say what it does. */}
      {/*
        STOP IS PERPS-ONLY, because on this venue it does not exist for spot.
        `spotBatchNewOrder` signs {symbolID, clOrdID, side, type, timeInForce,
        price, quantity, funds} and has no trigger field at all, so a spot "stop"
        was collected in this form, sent, and silently dropped by the server -
        leaving a plain order that executed IMMEDIATELY. A stop-loss that fires
        at once is the worst possible failure for the thing it is meant to do, so
        the tab is not offered rather than being offered and ignored.
      */}
      <div className="oe-tabs" role="tablist" aria-label="Order type">
        {((engine === 'perps' ? ['market', 'limit', 'stop'] : ['market', 'limit']) as OrdType[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={type === t}
            className={`oe-tab${type === t ? ' is-on' : ''}`}
            onClick={() => setType(t)}
          >
            {t === 'market' ? 'Market' : t === 'limit' ? 'Limit' : 'Stop'}
          </button>
        ))}
      </div>

      <div className="oe-body">
        {/*
          THE TWO NUMBERS THE TICKET IS SIZED AGAINST, stated before the fields
          rather than under them. "Available" used to sit beneath the size box and
          the open position was six rows further down in the read-out, so the two
          facts you check before typing were the two furthest from where you type.
        */}
        <dl className="oe-facts">
          <div className="oe-facts__row">
            <dt>Available to Trade</dt>
            <dd className={available === null ? 'is-dim' : ''}>{maskFunds(availText)}</dd>
          </div>
          {engine === 'perps' && (
            <div className="oe-facts__row">
              <dt>Current Position</dt>
              <dd className={positionDir === 'long' ? 'is-pos' : positionDir === 'short' ? 'is-neg' : ''}>
                {maskPositions(positionText)}
              </dd>
            </div>
          )}
        </dl>

        {/* 3. Price, then size. */}
        {(type === 'limit' || (type === 'stop' && stopExec === 'limit')) && (
          <div className="oe-field">
            {/* The name of the field lives INSIDE it. A caption above cost a
                17px row per input and put the label further from its own box
                than from the box above. */}
            <div className="oe-inputrow">
              <label className="oe-inlabel" htmlFor={`${uid}-price`}>Price</label>
              <input
                id={`${uid}-price`}
                autoComplete="off"
                className="oe-input"
                value={price}
                onChange={(e) => onPrice(tickInput(e.target.value, sym?.tickSize))}
                inputMode="decimal"
                placeholder="0.00"
              />
              {quoteLabel && <span className="oe-suffix">{quoteLabel}</span>}
              {/* Fills the field with the real mid, and says so: it is disabled
                  rather than falling back to last price when one side of the
                  book is missing, because those are different numbers. */}
              <button
                type="button"
                className="oe-chip"
                disabled={midPrice === null}
                title={midPrice === null ? 'No two-sided book to take a mid from' : 'Use the mid price'}
                onClick={() => midPrice !== null && onPrice(toFieldPrice(midPrice))}
              >
                MID
              </button>
            </div>
          </div>
        )}

        {type === 'stop' && (
          <>
            <div className="oe-field">
              <div className="oe-inputrow">
                <label className="oe-inlabel" htmlFor={`${uid}-stop`}>Trigger</label>
                <input
                  id={`${uid}-stop`}
                  autoComplete="off"
                  className="oe-input"
                  value={stopPrice}
                  onChange={(e) => setStopPrice(tickInput(e.target.value, sym?.tickSize))}
                  inputMode="decimal"
                  placeholder="0.00"
                />
                {quoteLabel && <span className="oe-suffix">{quoteLabel}</span>}
              </div>
            </div>
            <div className="oe-compactrow">
              <label className="oe-compact">
                <span>Kind</span>
                <select className="oe-select" value={stopKind} onChange={(e) => setStopKind(e.target.value as 'sl' | 'tp')}>
                  <option value="sl">Stop loss</option>
                  <option value="tp">Take profit</option>
                </select>
              </label>
              <label className="oe-compact">
                <span>Executes as</span>
                <select className="oe-select" value={stopExec} onChange={(e) => setStopExec(e.target.value as any)}>
                  <option value="market">Market</option>
                  <option value="limit">Limit</option>
                </select>
              </label>
              <label className="oe-compact">
                <span>Trigger on</span>
                <select className="oe-select" value={trigger} onChange={(e) => setTrigger(e.target.value as any)}>
                  <option value="mark">Mark</option>
                  <option value="last">Last</option>
                  <option value="index">Index</option>
                </select>
              </label>
            </div>
          </>
        )}

        <div className="oe-field">
          <div className={`oe-inputrow${liveBelow || liveAbove ? ' is-bad' : ''}`}>
            <label className="oe-inlabel" htmlFor={`${uid}-size`}>Amount</label>
            <button
              type="button"
              className="oe-chip"
              disabled={Boolean(sliderBlocked)}
              title="Size to the whole available balance"
              onClick={() => setPct(100)}
            >
              MAX
            </button>
            <input
              id={`${uid}-size`}
              autoComplete="off"
              className="oe-input"
              value={sizeInput}
              onChange={(e) => setSizeInput(decimalInput(e.target.value))}
              inputMode="decimal"
              placeholder="0.00" 
            />
            {/* TWO units, so a toggle rather than a select: a dropdown that
                always holds exactly two options is two clicks to do what one
                does, and it cannot show which one you are about to get. */}
            <span className="oe-unitlabel">
              {(sizeUnit === 'base' ? baseLabel : quoteLabel) || 'Unit'}
            </span>
            <button
              type="button"
              className="oe-swap"
              disabled={!sym}
              aria-label={`Size in ${sizeUnit === 'base' ? quoteLabel : baseLabel}`}
              title={`Switch to ${sizeUnit === 'base' ? quoteLabel : baseLabel}`}
              onClick={() => switchUnit(sizeUnit === 'base' ? 'quote' : 'base')}
            >
              <SwapIcon />
            </button>
          </div>
          {liveBelow && (
            <p className="oe-hint oe-hint--under oe-hint--bad">Below minimum {fmt(minNotional)} {quoteLabel}</p>
          )}
          {liveAbove && (
            <p className="oe-hint oe-hint--under oe-hint--bad">Above maximum {fmt(maxNotional)} {quoteLabel}</p>
          )}
        </div>

        {/* 4. Percentage of buying power. Disabled, never zero-based, when the
            basis is not a real number. */}
        <div className={`oe-slider${sliderBlocked ? ' is-off' : ''}`}>
          <div className="oe-slider__rail" style={{ ['--oe-p' as any]: sliderReady ? thumbPct / 100 : 0 }}>
            <div className="oe-slider__fill" />
            {NOTCHES.map((n) => (
              <i
                key={n}
                className={`oe-slider__notch${sliderReady && thumbPct >= n ? ' is-past' : ''}`}
                style={{ left: `${n}%` }}
                aria-hidden="true"
              />
            ))}
            <input
              className="oe-slider__input"
              type="range"
              min={0}
              max={100}
              step={1}
              value={sliderReady ? thumbPct : 0}
              disabled={Boolean(sliderBlocked)}
              aria-label="Size as a percentage of available balance"
              onChange={(e) => setPct(Number(e.target.value))}
            />
          </div>
          <div className="oe-inputrow oe-pctbox">
            <DraftInput
              className="oe-input"
              value={sliderReady && notional > 0 ? String(Math.min(100, Math.round(usedPct))) : ''}
              onDraft={(t) => setPct(t === '' ? 0 : Math.min(100, Number(t)))}
              sanitize={(raw) => integerInput(raw)}
              inputMode="numeric"
              disabled={Boolean(sliderBlocked)}
              aria-label="Size as a percentage of available balance"
              placeholder="0"
            />
            <span className="oe-suffix">%</span>
          </div>
          {sliderBlocked ? (
            <p className="oe-note">{sliderBlocked}</p>
          ) : null}
        </div>

        {/* 5. Flags, TIF and the attached exits.
            Two rows, each a checkbox on the left and its own control on the
            right: reduce-only with the TIF, then the exits with their unit. The
            TIF used to sit on a line of its own BETWEEN the two checkboxes,
            which read as a third flag rather than as a property of the order. */}
        <div className="oe-opts">
          <label className="oe-switch">
            <span>Reduce only</span>
            <input type="checkbox" role="switch" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} />
          </label>
          {marketExec ? (
            <span className="oe-compact oe-compact--fixed" title="A market order cannot rest on the book.">
              <span>TIF</span>
              <b>IOC</b>
            </span>
          ) : (
            <label className="oe-compact">
              <span>TIF</span>
              <select
                className="oe-select"
                value={tif}
                onChange={(e) => setTif(e.target.value as 'gtc' | 'ioc' | 'gtx')}
              >
                <option value="gtc">GTC</option>
                <option value="ioc">IOC</option>
                <option value="gtx">GTX</option>
              </select>
            </label>
          )}
        </div>

        {effectiveTif === 'gtx' && (
          <p className="oe-note">
            GTX rests as a maker order and is rejected if it would take. SoDEX does not treat it as
            all-or-nothing: part of the order can fill before the remainder is rejected.
          </p>
        )}

        {engine === 'perps' && (
          <div className="oe-exits">
            <div className="oe-exits__head">
              <label className="oe-check">
                <input
                  type="checkbox"
                  checked={useExits}
                  onChange={(e) => setUseExits(e.target.checked)}
                />
                Take Profit / Stop Loss
              </label>
              {useExits && (
                <div className="oe-unitswap">
                  <span className="oe-unitswap__now">{exitUnit === 'usd' ? '$' : '%'}</span>
                  <button
                    type="button"
                    className="oe-swap"
                    aria-label={exitUnit === 'usd' ? 'Show as a percentage' : 'Show as an amount'}
                    title={
                      exitUnit === 'usd'
                        ? 'Switch to percent - return on the margin this order ties up'
                        : 'Switch to an amount in the quote coin'
                    }
                    onClick={() => setExitUnit(exitUnit === 'usd' ? 'pct' : 'usd')}
                  >
                    <SwapIcon />
                  </button>
                </div>
              )}
            </div>
            <Collapse open={useExits}>
              <div className="oe-exitgrid">
                <div className="oe-inputrow">
                  <label className="oe-inlabel" htmlFor={`${uid}-tp`}>TP Price</label>
                  <input
                    id={`${uid}-tp`}
                    autoComplete="off"
                    className="oe-input"
                    value={tpPrice}
                    onChange={(e) => setTpPrice(tickInput(e.target.value, sym?.tickSize))}
                    inputMode="decimal"
                    placeholder="0"
                  />
                </div>
                <div className="oe-inputrow">
                  <label className="oe-inlabel" htmlFor={`${uid}-tp-amt`}>Gain</label>
                  <DraftInput
                    id={`${uid}-tp-amt`}
                    className="oe-input"
                    value={exitAmountText(tpPrice)}
                    onDraft={(t) => setExitFromAmount(t, setTpPrice)}
                    sanitize={(raw) => decimalInput(raw, { signed: true })}
                    inputMode="decimal"
                    placeholder="0"
                  />
                  <span className="oe-suffix">{exitUnit === 'usd' ? '$' : '%'}</span>
                </div>

                <div className="oe-inputrow">
                  <label className="oe-inlabel" htmlFor={`${uid}-sl`}>SL Price</label>
                  <input
                    id={`${uid}-sl`}
                    autoComplete="off"
                    className="oe-input"
                    value={slPrice}
                    onChange={(e) => setSlPrice(tickInput(e.target.value, sym?.tickSize))}
                    inputMode="decimal"
                    placeholder="0"
                  />
                </div>
                <div className="oe-inputrow">
                  <label className="oe-inlabel" htmlFor={`${uid}-sl-amt`}>Loss</label>
                  <DraftInput
                    id={`${uid}-sl-amt`}
                    className="oe-input"
                    value={exitAmountText(slPrice)}
                    onDraft={(t) => setExitFromAmount(t, setSlPrice)}
                    sanitize={(raw) => decimalInput(raw, { signed: true })}
                    inputMode="decimal"
                    placeholder="0"
                  />
                  <span className="oe-suffix">{exitUnit === 'usd' ? '$' : '%'}</span>
                </div>
              </div>
            </Collapse>
          </div>
        )}

        {/* Guardrails sit ABOVE the two buttons they guard. The size bound
            is the amount field's own border and the line under it. */}
        {accountMismatch && (
          <p className="status err">
            Trading disabled: viewing{' '}
            <strong>{shortAddr(connectedAddress ?? undefined)}</strong>, key signs as{' '}
            <strong>{shortAddr(signingAddress ?? undefined)}</strong>.
          </p>
        )}
        {stopCheck?.message && (
          <p className={`status ${stopCheck.severity === 'error' ? 'err' : 'warn'}`}>
            {stopCheck.message}
            {stopCheck.liquidationPrice !== null && (
              <>
                {' '}
                <span className="muted">
                  (est. liquidation {fmtPrice(stopCheck.liquidationPrice, sym?.tickSize)} for a{' '}
                  {side === 'buy' ? 'long' : 'short'})
                </span>
              </>
            )}
          </p>
        )}

        {/* 6. The irreversible control.
         *
         * ONE button. The direction is already chosen at the top of the
            ticket, so a second pair of side buttons here would be a second
            place to change it - and the two could disagree. */}
        <div className="oe-side">
          {/* Read-only, the same button is the fix: its words become
              "Connect wallet" / "Reconnect wallet" / "Enable trading"
              (account/useTradeGate.ts) and pressing it does that. */}
          <button
            type="button"
            className={`oe-side__btn is-${side}${gate?.busy ? ' is-wait' : ''}`}
            onClick={gate ? gate.act : () => place(side)}
            disabled={gate ? gate.busy : !canSend}
            aria-busy={gate?.busy || busy || undefined}
            title={gate?.why}
          >
            {gate
              ? (gate.approving ? <ApproveLabel /> : gate.label)
              : busy
                ? 'Working…'
                : engine === 'perps'
                  ? (side === 'buy' ? 'Long' : 'Short')
                  : (side === 'buy' ? 'Buy' : 'Sell')}
          </button>
        </div>

        {/* 7. Read-out. Confirmation of the ticket above it, not a prerequisite,
            and pinned to the bottom edge of the panel so it keeps one place.
            The position you already hold is a summary, not a seventh metric, so
            it leads and the group's one hairline sits UNDER it. */}
        <dl className="oe-out">
          {/* Current position is stated at the TOP of the ticket now - see
              `.oe-facts` - because it is something you check before typing, not
              a result of what you typed. */}
          {/* Liquidation is a CLIENT-SIDE ESTIMATE from the symbol's published
              margin tiers - the venue liquidates against the whole account - so
              it carries the tag in the label itself, not only in a tooltip
              nobody hovers. */}
          {engine === 'perps' && (
            <div className="oe-out__row">
              <dt
                className="oe-out__k"
                title="Estimated from the symbol's published margin tiers. The exchange liquidates against your whole account, so treat this as a guide, not an exact trigger."
              >
                Liq. price <span className="oe-tag">est.</span>
              </dt>
              <dd className="oe-out__v oe-out__v--small">
                {(side === 'buy' ? liqLong : liqShort)?.price
                  ? fmtPrice((side === 'buy' ? liqLong : liqShort)!.price!, sym?.tickSize)
                  : DASH}
              </dd>
            </div>
          )}
          <div className="oe-out__row">
            <dt className="oe-out__k">Order value</dt>
            <dd className={`oe-out__v oe-out__v--small${liveBelow ? ' is-neg' : ''}`}>
              {notionalExact !== null && effectivePrice > 0 ? fmtExactQuote(notionalExact, sym?.quoteCoin) : liveNotional > 0 ? fmtQuote(liveNotional, sym?.quoteCoin) : DASH}
            </dd>
          </div>
          {engine === 'perps' && (
            <div className="oe-out__row">
              <dt className="oe-out__k">Margin required</dt>
              <dd className="oe-out__v oe-out__v--small">{liveNotional > 0 && lev > 0 ? fmtQuote(liveNotional / lev, sym?.quoteCoin) : DASH}</dd>
            </div>
          )}
          {/*
            FEES, as taker / maker with no words.
            The pair is always in that order and always in that place, so the
            labels were two words restating a convention the numbers already
            carry - and they cost the row the width it needed to show a discount.

            A DISCOUNTED ACCOUNT SEES BOTH: the published default struck through
            in grey, then what it will actually pay, behind a flame. An account on
            the base tier sees one pair, because there is no saving to point at.

            The row is a button: it opens which tier produced the number, which is
            the only question the figure prompts.
          */}
          <div className="oe-out__row oe-sliprow" ref={slipRef}>
            <dt className="oe-out__k" title="Estimated from walking this order through the live book. Max is the slippage you are willing to accept.">
              Slippage
            </dt>
            <dd className="oe-out__v oe-slip">
              <button
                type="button"
                className="oe-sliplink"
                aria-expanded={slipOpen}
                onClick={() => { setSlipDraft(maxSlip); setSlipOpen((v) => !v); }}
              >
                <span className={slipTone(estSlip, Math.min(maxSlipN, slipCap), liveQty > 0)}>
                  Est: {estSlip === null ? DASH : `${estSlip.toFixed(liveQty > 0 ? 4 : 2)}%`}
                </span>
                <span className="oe-out__sep">/</span>
                <span>Max {Math.min(maxSlipN > 0 ? maxSlipN : 1, slipCap).toFixed(2)}%</span>
              </button>
            </dd>
            {slipOpen && (
              <div className="oe-pop oe-slippop" role="dialog" aria-label="Max slippage">
                <div className="oe-slider">
                  <div
                    className="oe-slider__rail"
                    style={{ ['--oe-p' as string]: slipCap > 0 ? Math.min(1, Math.max(0, num(slipDraft) / slipCap)) : 0 }}
                  >
                    <div className="oe-slider__fill" />
                    <input
                      className="oe-slider__input"
                      type="range"
                      min={0}
                      max={slipCap}
                      step={0.01}
                      value={Math.min(slipCap, Math.max(0, num(slipDraft)))}
                      aria-label="Maximum slippage percent"
                      onChange={(e) => {
                        const s = Math.min(slipCap, Math.max(0, Number(e.target.value))).toFixed(2);
                        setSlipDraft(s);
                        setMaxSlip(s);
                      }}
                    />
                  </div>
                  <div className="oe-inputrow oe-pctbox">
                    <input
                      className="oe-input"
                      autoComplete="off"
                      inputMode="decimal"
                      aria-label="Maximum slippage percent"
                      value={slipDraft}
                      onChange={(e) => {
                        const s = clampSlipDraft(e.target.value, slipCap);
                        setSlipDraft(s);
                        if (s !== '' && s !== '.') setMaxSlip(Number(s).toFixed(2));
                      }}
                      onBlur={() => {
                        let n = num(slipDraft);
                        if (!(n >= 0)) n = 0;
                        if (n > slipCap) n = slipCap;
                        const s = n.toFixed(2);
                        setSlipDraft(s);
                        setMaxSlip(s);
                      }}
                    />
                    <span className="oe-suffix">%</span>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="oe-out__row">
            <dt className="oe-out__k">
              <button
                type="button"
                className="oe-feebtn"
                aria-expanded={feesOpen}
                onClick={() => setFeesOpen((v) => !v)}
                title={feesOpen ? 'Hide fee tier' : 'Show which tier this rate comes from'}
              >
                Fees
              </button>
              {/*
                WHICH NUMBER IS WHICH. The value renders as `0.0450% / 0.0180%`
                and nothing on screen said the first was taker - not the label,
                not a title, not the expanded note. Order-as-convention is only
                disclosure if the convention is stated.
              */}
              <span className="oe-tag">taker / maker</span>
            </dt>
            <dd className="oe-out__v">
              {!sym ? DASH : discounted ? (
                <span className="oe-fee">
                  <span className="oe-fee__flame" aria-hidden="true">🔥</span>
                  <s className="oe-fee__was">{feePair(defTaker!, defMaker!)}</s>
                  <span className="oe-fee__now">{feePair(ownTaker!, ownMaker!)}</span>
                </span>
              ) : (
                feePair(ownTaker ?? defTaker!, ownMaker ?? defMaker!)
              )}
            </dd>
          </div>
          {feesOpen && (
            <div className="oe-out__row oe-out__row--note">
              <dd className="oe-out__v oe-out__v--note">
                {acctFee
                  ? <>Fee tier {acctFee.feeTier ?? 0} · staking tier {acctFee.stakingTier ?? 0}
                      {discounted ? ' — better than this market\u2019s published rate.' : ' — this market\u2019s published rate.'}</>
                  : connectedAddress
                    ? 'The venue has not reported a rate for this account; the market default is shown.'
                    : 'Connect a wallet to see the rate this account actually pays.'}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {msg && <p className={`status ${msg.kind}`}>{msg.text}</p>}
      {dialog}
    </section>
  );
}

/** Two arrows passing, for the base/quote unit toggle. 14px in a 24px hit box. */
const SwapIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M2 5.5h9M8.5 3 11 5.5 8.5 8" fill="none" stroke="currentColor" strokeWidth="1.4"
      strokeLinecap="round" strokeLinejoin="round" />
    <path d="M14 10.5H5M7.5 8 5 10.5 7.5 13" fill="none" stroke="currentColor" strokeWidth="1.4"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * An exact decimal string as a quote value: grouped, at least two decimals,
 * every further decimal it really has (trailing zeros dropped).
 */
function fmtExactQuote(v: string, quoteCoin: string | undefined | null): string {
  const n = Number(v);
  // Five figures and up: no cents. The exact-decimal path below is for the
  // smaller notionals, where a fraction is the difference between two orders.
  if (Number.isFinite(n) && Math.abs(n) >= USD_WHOLE_FROM) return fmtQuote(n, quoteCoin, 0);
  const neg = v.startsWith('-');
  const [w = '0', f = ''] = (neg ? v.slice(1) : v).split('.');
  const frac = f.replace(/0+$/, '').padEnd(2, '0');
  const body = `${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
  return fmtQuote(0, quoteCoin).replace(/0\.00/, `${neg ? '−' : ''}${body}`);
}
