/**
 * An axis drag that leaves the chart keeps the pace it had on it.
 *   node --import tsx --test src/chart/dragAnywhere.test.ts
 *
 * The fake below is klinecharts 10.0.2's Event core cut down to the axis
 * drags (Event.prototype._processXAxisScrollStartEvent / ScrollingEvent and
 * the y-axis pair, same fields, same maths), so what is measured is what the
 * library would do with the moves dragAnywhere hands it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chart as KChart } from 'klinecharts';
import { dragAnywhere } from './dragAnywhere';

interface Ev {
  x: number;
  y: number;
  pageX: number;
  pageY: number;
}
const widget = (name: string) => ({ getName: () => name, getPane: () => ({ getId: () => 'candle_pane' }) });
const X = widget('xAxis');
const Y = widget('yAxis');

/** The library's SCALE_MULTIPLIER and StoreImp.zoom's bar space step. */
const SCALE_MULTIPLIER = 10;

class FakeEvent {
  _mouseDownWidget: ReturnType<typeof widget> | null = null;
  _startScrollCoordinate: unknown = null;
  _xAxisStartScaleDistance = 0;
  _xAxisScale = 1;
  _yAxisStartScaleDistance = 0;
  barSpace = 8;
  yRange = 100;
  readonly yStart = 100;
  /** Where the pointer is, i.e. which widget the library finds under it. */
  under: ReturnType<typeof widget> | null = null;

  _findWidgetByEvent() {
    return { pane: this.under?.getPane() ?? null, widget: this.under };
  }
  mouseDownEvent(e: Ev) {
    const w = this._findWidgetByEvent().widget;
    this._mouseDownWidget = w;
    if (w === X) this._xAxisStartScaleDistance = e.pageX;
    if (w === Y) this._yAxisStartScaleDistance = e.pageY;
    return false;
  }
  pressedMouseMoveEvent(e: Ev) {
    const w = this._findWidgetByEvent().widget;
    if (!w || w !== this._mouseDownWidget) return false;
    if (w === X && this._xAxisStartScaleDistance !== 0) {
      const scale = this._xAxisStartScaleDistance / e.pageX;
      if (Number.isFinite(scale)) {
        const zoomScale = (scale - this._xAxisScale) * 10;
        this._xAxisScale = scale;
        this.barSpace = Math.max(1, Math.min(50, this.barSpace + zoomScale * (this.barSpace / SCALE_MULTIPLIER)));
      }
    }
    if (w === Y && this._yAxisStartScaleDistance !== 0) {
      this.yRange = this.yStart * (e.pageY / this._yAxisStartScaleDistance);
    }
    return false;
  }
  mouseUpEvent() {
    this._mouseDownWidget = null;
    this._xAxisStartScaleDistance = 0;
    this._xAxisScale = 1;
    this._yAxisStartScaleDistance = 0;
    return false;
  }
}

const setup = () => {
  const ev = new FakeEvent();
  assert.ok(dragAnywhere({ _chartEvent: ev } as unknown as KChart));
  return ev;
};
const at = (pageX: number, pageY = 500): Ev => ({ x: pageX, y: pageY, pageX, pageY });

test('a time-axis drag off the chart zooms at the pace it had on it, not faster and faster', () => {
  const ev = setup();
  ev.under = X;
  ev.mouseDownEvent(at(400));
  // Each 100 px to the left, measured as the bar space ratio it causes.
  const steps: number[] = [];
  let prev = ev.barSpace = 2;
  ev.under = null; // the press owns the drag; below the axis, then off the page
  for (let px = 300; px >= -200; px -= 100) {
    ev.pressedMouseMoveEvent(at(px));
    steps.push(ev.barSpace / prev);
    prev = ev.barSpace;
    if (ev.barSpace >= 50) break;
  }
  // The library's own p0/pageX: 100 px = x1.28 at first, x2.7 by pageX 100,
  // nothing at 0 and a sign flip past the window's left edge.
  for (const r of steps) {
    assert.ok(Number.isFinite(r) && r >= 1, `zoomed in, never out, on a drag to the left: ${steps}`);
    assert.ok(r < 1.4, `each 100 px zooms about as much as the first did: ${steps.map((s) => s.toFixed(2))}`);
  }
});

test('dragged the other way, past the right edge, the time axis keeps zooming out', () => {
  const ev = setup();
  ev.under = X;
  ev.mouseDownEvent(at(400));
  ev.barSpace = 40;
  ev.under = null;
  let prev = ev.barSpace;
  for (let px = 600; px <= 2000; px += 200) {
    ev.pressedMouseMoveEvent(at(px));
    assert.ok(ev.barSpace < prev || ev.barSpace === 1, `still zooming out at pageX ${px}`);
    prev = ev.barSpace;
  }
});

test('a price-axis drag above the window never turns the range inside out', () => {
  const ev = setup();
  ev.under = Y;
  ev.mouseDownEvent(at(1000, 400));
  ev.under = null;
  let prev = ev.yRange;
  for (const py of [300, 200, 100, 0, -100, -300]) {
    ev.pressedMouseMoveEvent(at(1000, py));
    assert.ok(ev.yRange > 0 && ev.yRange < prev, `range shrinks and stays positive at pageY ${py}: ${ev.yRange}`);
    prev = ev.yRange;
  }
  ev.mouseUpEvent();
});

test('on the axis itself a short drag zooms like the library does (first order)', () => {
  const ev = setup();
  ev.under = X;
  ev.mouseDownEvent(at(400));
  ev.barSpace = 10;
  ev.pressedMouseMoveEvent(at(396));
  // The library: 400/396 - 1 = 1.01 % of a scale unit -> bar space +1.01 %.
  assert.ok(Math.abs(ev.barSpace / 10 - 1.0101) < 0.001, String(ev.barSpace));
  ev.mouseUpEvent();
});
