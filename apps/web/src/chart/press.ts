/**
 * A PRESS STARTS THE READ ITS CLICK WILL MAKE. Between a finger going down on a timeframe button,
 * a market chip or a market row of the search and the click, some 80-120 ms pass in which the
 * candle read the click starts could already be on its way (seriesPrefetch.ts says what it reads).
 *
 * This module is the small half the market pickers import (the order book's chips, the command
 * palette's market rows): no chart code, so the palette's chunk, loaded on every page, stays as it
 * is. The trade chart registers what a press on a market reads while it is mounted
 * (setMarketPrefetch); with no trade chart on screen a press reads nothing.
 *
 * On touch a press is also how a scroll starts: the read waits until the finger has stayed put
 * TOUCH_HOLD_MS (a scroll moves on, or the browser cancels the pointer), or goes at the release of
 * a quicker tap - never for a press that turned into a scroll.
 */
import type { Engine } from '../api';

/** How long a touch stays put before it counts as a press on the control (not a scroll). */
export const TOUCH_HOLD_MS = 40;
/** How far a touch may move and still be a press. */
const TOUCH_SLOP_PX = 10;

interface PressLike {
  pointerType: string;
  clientX: number;
  clientY: number;
  currentTarget: EventTarget | null;
}

/**
 * Call `fire` for a press: at once for a mouse or a pen, for a touch once it has stayed put
 * TOUCH_HOLD_MS (or at its release, if that comes first). A touch that moves past the slop or is
 * cancelled (the browser took it for a scroll) never fires.
 */
export function onPress(e: PressLike, fire: () => void, holdMs = TOUCH_HOLD_MS): void {
  if (e.pointerType !== 'touch') {
    fire();
    return;
  }
  const el = e.currentTarget as HTMLElement | null;
  if (!el || typeof el.addEventListener !== 'function') return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let done = false;
  const end = () => {
    done = true;
    clearTimeout(timer);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointercancel', end);
    el.removeEventListener('pointerup', go);
  };
  function go() {
    if (done) return;
    end();
    fire();
  }
  function move(ev: Event) {
    const p = ev as PointerEvent;
    if (Math.hypot(p.clientX - x0, p.clientY - y0) > TOUCH_SLOP_PX) end();
  }
  const timer = setTimeout(go, holdMs);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerup', go);
}

let marketPrefetch: ((engine: Engine, symbol: string) => void) | null = null;

/** The trade chart's: what a press on a market reads (null: nothing). Returns the unregister. */
export function setMarketPrefetch(fn: ((engine: Engine, symbol: string) => void) | null): () => void {
  marketPrefetch = fn;
  return () => {
    if (marketPrefetch === fn) marketPrefetch = null;
  };
}

/** A press on a market row or chip: its candles are read for the trade chart, if one is up. */
export function pressMarket(e: PressLike, engine: Engine, symbol: string): void {
  const fn = marketPrefetch;
  if (fn) onPress(e, () => fn(engine, symbol));
}
