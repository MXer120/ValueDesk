/**
 * A drag on the chart keeps going wherever the pointer goes while the button
 * is held - across the price axis, over the order book, off the chart, out of
 * the window - the way TradingView's does. Panning the plot, dragging the
 * price axis to scale it and dragging the time axis to zoom all follow the
 * pointer until it is released.
 *
 * WHY IT STOPPED. klinecharts already listens on the whole document while a
 * button is down (EventHandlerImp subscribes the root element's mousemove and
 * mouseup on mousedown), but Event.pressedMouseMoveEvent looks the widget up
 * under the pointer on every move and drops the move unless it is the widget
 * the press began on. So a pan died the moment the pointer crossed onto the
 * price axis, into another pane or off the chart; a release out there never
 * reached the widget either, and a touch lifted off the chart left the scroll
 * state behind.
 *
 * THE FIX. A press that started a pan or an axis drag owns its widget until
 * it is released: every pressed move, and the release, is handed to that
 * widget with coordinates relative to it (they may lie outside it - the
 * library's scroll and scale maths only read the distance from where the
 * press began, or page coordinates). A press an overlay took (an order line,
 * a drawing, a tool being placed) is left exactly as the library handles it.
 *
 * While such a drag is on, the page does not select text under the pointer
 * and keeps the cursor the drag began with (`html.kc-drag`, chart.css), and
 * the crosshair is hidden whenever the pointer is off the pane being panned.
 *
 * klinecharts 10's Event is internal: everything here is feature-checked, and
 * a build without these members keeps the library's own behaviour (logged).
 */
import type { Chart as KChart } from 'klinecharts';
import { logger } from '../log';

const log = logger('chart.drag');

interface Widget {
  getName(): string;
  getPane(): { getId(): string };
}
interface Found {
  pane: unknown;
  widget: Widget | null;
}
type Handler = (e: unknown) => unknown;

interface ChartEvent {
  _findWidgetByEvent: (e: unknown) => Found;
  _mouseDownWidget: Widget | null;
  _startScrollCoordinate: unknown;
  _chart?: { getChartStore?: () => { setCrosshair?: (c?: unknown, o?: unknown) => void } };
  mouseDownEvent: Handler;
  pressedMouseMoveEvent: Handler;
  mouseUpEvent: Handler;
  touchStartEvent?: Handler;
  touchMoveEvent?: Handler;
  touchEndEvent?: Handler;
  __vsDragAnywhere?: true;
}

/** klinecharts' widget names (WidgetNameConstants). */
const MAIN = 'main';
const X_AXIS = 'xAxis';
const Y_AXIS = 'yAxis';

/** The cursor a drag keeps, per widget it began on (klinecharts' own). */
const CURSOR: Record<string, string> = { [MAIN]: 'crosshair', [X_AXIS]: 'ew-resize', [Y_AXIS]: 'ns-resize' };

const root = () => (typeof document !== 'undefined' ? document.documentElement : null);

function dragClass(on: boolean, widget?: Widget | null): void {
  const el = root();
  if (!el) return;
  if (on) {
    el.style.setProperty('--kc-drag-cursor', CURSOR[widget?.getName() ?? ''] ?? 'default');
    el.classList.add('kc-drag');
  } else if (el.classList.contains('kc-drag')) {
    el.classList.remove('kc-drag');
    el.style.removeProperty('--kc-drag-cursor');
  }
}

/**
 * Make `c`'s drags follow the pointer anywhere. Idempotent; returns false (and
 * leaves the library alone) when this klinecharts build lacks the internals.
 */
export function dragAnywhere(c: KChart): boolean {
  const ev = (c as unknown as { _chartEvent?: ChartEvent })._chartEvent;
  const ok =
    !!ev &&
    typeof ev._findWidgetByEvent === 'function' &&
    typeof ev.mouseDownEvent === 'function' &&
    typeof ev.pressedMouseMoveEvent === 'function' &&
    typeof ev.mouseUpEvent === 'function' &&
    '_mouseDownWidget' in ev &&
    '_startScrollCoordinate' in ev;
  if (!ok || !ev) {
    log.warn('drag-anywhere unavailable: this klinecharts build has a different event core; drags stop at the pane edge');
    return false;
  }
  if (ev.__vsDragAnywhere) return true;
  ev.__vsDragAnywhere = true;

  const find = ev._findWidgetByEvent;
  const down = ev.mouseDownEvent;
  const pressedMove = ev.pressedMouseMoveEvent;
  const up = ev.mouseUpEvent;
  const touchStart = ev.touchStartEvent;
  const touchMove = ev.touchMoveEvent;
  const touchEnd = ev.touchEndEvent;

  /** The widget a mouse drag belongs to, while it is on. */
  let mouseOwner: Found | null = null;
  /** The same for a one-finger touch drag. */
  let touchOwner: Found | null = null;

  /** Is the press that just went through a pan or an axis drag (not an overlay's)? */
  const owns = (w: Widget | null, consumed: unknown): boolean => {
    if (!w) return false;
    const name = w.getName();
    if (name === MAIN) return ev._startScrollCoordinate !== null && ev._startScrollCoordinate !== undefined;
    return (name === X_AXIS || name === Y_AXIS) && consumed === false;
  };

  const hideCrosshair = () => {
    try {
      ev._chart?.getChartStore?.()?.setCrosshair?.();
    } catch (e) {
      log.debug('crosshair could not be hidden', { error: String(e) });
    }
  };

  /** Run the library's handler as if the pointer were over `owner`. */
  const routed = (owner: Found, handler: Handler, e: unknown): unknown => {
    const here = find.call(ev, e);
    const away = here.widget !== owner.widget;
    ev._findWidgetByEvent = () => owner;
    let out: unknown;
    try {
      out = handler.call(ev, e);
    } finally {
      // Back to the prototype's lookup.
      delete (ev as Partial<ChartEvent>)._findWidgetByEvent;
      if (ev._findWidgetByEvent !== find) ev._findWidgetByEvent = find;
    }
    if (away && owner.widget?.getName() === MAIN) hideCrosshair();
    return out;
  };

  ev.mouseDownEvent = function (e: unknown) {
    // A release the page never delivered (the window lost focus mid-drag)
    // must not leave a pan armed for this press.
    ev._startScrollCoordinate = null;
    const consumed = down.call(ev, e);
    const w = ev._mouseDownWidget;
    mouseOwner = owns(w, consumed) ? { pane: w!.getPane(), widget: w } : null;
    dragClass(!!mouseOwner, w);
    return consumed;
  };

  ev.pressedMouseMoveEvent = function (e: unknown) {
    const owner = mouseOwner;
    if (!owner || ev._mouseDownWidget !== owner.widget) return pressedMove.call(ev, e);
    return routed(owner, pressedMove, e);
  };

  ev.mouseUpEvent = function (e: unknown) {
    const owner = mouseOwner;
    mouseOwner = null;
    dragClass(false);
    if (!owner || ev._mouseDownWidget !== owner.widget) return up.call(ev, e);
    return routed(owner, up, e);
  };

  if (touchStart && touchMove && touchEnd) {
    ev.touchStartEvent = function (e: unknown) {
      ev._startScrollCoordinate = null;
      const found = find.call(ev, e);
      const consumed = touchStart.call(ev, e);
      touchOwner = found.widget && owns(found.widget, found.widget.getName() === MAIN ? undefined : consumed) ? found : null;
      return consumed;
    };
    ev.touchMoveEvent = function (e: unknown) {
      const owner = touchOwner;
      return owner ? routed(owner, touchMove, e) : touchMove.call(ev, e);
    };
    ev.touchEndEvent = function (e: unknown) {
      const owner = touchOwner;
      touchOwner = null;
      return owner ? routed(owner, touchEnd, e) : touchEnd.call(ev, e);
    };
  }

  if (!blurHooked && typeof window !== 'undefined') {
    // A drag the page loses (the window blurs with the button still down)
    // must not leave text selection off for the whole page.
    blurHooked = true;
    window.addEventListener('blur', () => dragClass(false));
  }
  log.debug('drags follow the pointer beyond the chart');
  return true;
}

let blurHooked = false;
