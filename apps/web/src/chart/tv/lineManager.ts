/**
 * Keeps the TradingView chart's order and position lines in step with the
 * venue, using nothing but the free drawings API:
 *
 *   sync(wanted)            diff by signature: create what is new or changed,
 *                           remove what is gone, leave the rest untouched
 *   setLiveText(last)       rewrite a position line's PnL text IN PLACE
 *                           (setProperties) - a price tick never redraws
 *   handleDrawingEvent      the widget's `drawing_event`: a dragged order line
 *                           is read back with getShapeById(id).getPoints(),
 *                           snapped to the tick, and reported through `onMove`.
 *                           NOTHING IS SENT HERE - TvChart asks for a confirm,
 *                           and only then calls the host's modify callback.
 *   hold / release / restore
 *                           keep a moved line where the user put it while the
 *                           confirm (or the venue) is pending, or put it back
 *                           on the price the venue last stated.
 *
 * DOM-free and chart-agnostic (a `LineChart` is three methods), so
 * lines.test.ts drives it with a fake.
 */
import { diffShapes, droppedPrice, horizontalLineOptions, liveText, shapeSig, type LineShape } from './lines';
import type { DrawingEventType, EntityId, IChartWidgetApi } from './types';

export type LineChart = Pick<IChartWidgetApi, 'createMultipointShape' | 'removeEntity' | 'getShapeById'>;

export interface LineManagerOptions {
  chart: () => LineChart | null;
  /** The market's tick size, for snapping a dropped line. */
  tickSize?: () => string | undefined;
  /** A draggable line was dropped at a new, tick-snapped price. Nothing has
   *  been sent; the line is held there until `release` or `restore`. */
  onMove?: (shape: LineShape, price: string) => void;
  /** Unix seconds for the anchor point (a horizontal line ignores the time,
   *  but a point needs one). */
  nowSec?: () => number;
  /** How long a burst of move events is collapsed into one report. */
  settleMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Drawn {
  id: EntityId | null;
  sig: string;
  shape: LineShape;
  /** Text currently on the chart. */
  text: string;
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export class LineManager {
  private readonly drawn = new Map<string, Drawn>();
  private readonly byId = new Map<EntityId, string>();
  private wanted: LineShape[] = [];
  /** key -> the price the user moved it to, while that is pending. */
  private readonly held = new Map<string, string>();
  private readonly timers = new Map<string, unknown>();
  private lastText: { last: string | number | null | undefined; quote?: string } = { last: null };
  private disposed = false;

  constructor(private readonly o: LineManagerOptions) {}

  private nowSec(): number {
    return this.o.nowSec?.() ?? Math.floor(Date.now() / 1000);
  }

  /** Keys currently on the chart (or being created). */
  keys(): string[] {
    return [...this.drawn.keys()];
  }

  idOf(key: string): EntityId | null {
    return this.drawn.get(key)?.id ?? null;
  }

  isHeld(key: string): boolean {
    return this.held.has(key);
  }

  sync(wanted: readonly LineShape[]): void {
    if (this.disposed) return;
    this.wanted = [...wanted];
    const chart = this.o.chart();
    if (!chart) return;
    const sigs = new Map([...this.drawn].map(([k, d]) => [k, d.sig]));
    const { add, remove } = diffShapes(sigs, wanted);
    for (const key of remove) this.removeKey(chart, key);
    for (const s of add) this.create(chart, s);
  }

  /** Rewrite live texts (the position PnL) wherever they changed. */
  setLiveText(last: string | number | null | undefined, quoteCoin?: string): void {
    this.lastText = quoteCoin === undefined ? { last } : { last, quote: quoteCoin };
    const chart = this.o.chart();
    if (!chart) return;
    for (const d of this.drawn.values()) this.applyText(chart, d);
  }

  handleDrawingEvent(id: EntityId, type: DrawingEventType | string): void {
    if (this.disposed) return;
    const key = this.byId.get(id);
    if (key === undefined) return; // not one of ours
    const d = this.drawn.get(key);
    if (!d || d.id !== id) return;

    if (type === 'remove') {
      // The user deleted one of our lines (Delete on a selected order line).
      // The ORDER did not change: forget the drawing and put it back.
      this.byId.delete(id);
      this.drawn.delete(key);
      this.held.delete(key);
      queueMicrotask(() => this.sync(this.wanted));
      return;
    }
    if (type !== 'move' && type !== 'points_changed') return;

    // A drag fires several of these; report once, when it has settled.
    const set = this.o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clear = this.o.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
    const prev = this.timers.get(key);
    if (prev !== undefined) clear(prev);
    this.timers.set(
      key,
      set(() => {
        this.timers.delete(key);
        this.readMove(key, id);
      }, this.o.settleMs ?? 150),
    );
  }

  /** Keep `key` drawn at `price` (the user's, not yet the venue's). */
  hold(key: string, price: string): void {
    this.held.set(key, price);
    this.place(key, Number(price));
  }

  /** The pending move is over (settled, or superseded by fresh server data). */
  release(key: string): void {
    this.held.delete(key);
  }

  /** Put `key` back on the price the venue last stated. */
  restore(key: string): void {
    this.held.delete(key);
    const d = this.drawn.get(key);
    if (d) this.place(key, d.shape.price);
  }

  /** Remove every line from the chart. */
  clear(): void {
    const chart = this.o.chart();
    for (const key of [...this.drawn.keys()]) this.removeKey(chart, key);
    this.held.clear();
  }

  /** Forget every line WITHOUT touching the chart - after the library has
   *  dropped them itself (it clears a symbol's drawings on a symbol change). */
  forget(): void {
    this.drawn.clear();
    this.byId.clear();
    this.held.clear();
  }

  dispose(): void {
    this.disposed = true;
    const clear = this.o.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
    for (const t of this.timers.values()) clear(t);
    this.timers.clear();
    this.clear();
  }

  // --- internals ---------------------------------------------------------------

  private readMove(key: string, id: EntityId): void {
    if (this.disposed) return;
    const d = this.drawn.get(key);
    const chart = this.o.chart();
    if (!d || d.id !== id || !chart) return;
    if (!d.shape.draggable) {
      // A line the session cannot modify must not appear to have moved.
      this.restore(key);
      return;
    }
    const points = safe(() => chart.getShapeById(id)?.getPoints());
    const price = droppedPrice(points, this.o.tickSize?.());
    if (price === null) {
      this.restore(key);
      return;
    }
    const heldAt = this.held.get(key);
    if (heldAt === price) return; // already reported
    if (heldAt === undefined && Number(price) === d.shape.price) return; // dropped where it was
    this.hold(key, price); // snap the drawing onto the tick it will be sent at
    this.o.onMove?.(d.shape, price);
  }

  private place(key: string, price: number): void {
    const d = this.drawn.get(key);
    const chart = this.o.chart();
    if (!d?.id || !chart || !(price > 0)) return;
    const id = d.id;
    safe(() => chart.getShapeById(id)?.setPoints([{ time: this.nowSec(), price }]));
  }

  private applyText(chart: LineChart, d: Drawn): void {
    if (!d.id) return;
    const text = liveText(d.shape, this.lastText.last, this.lastText.quote);
    if (text === d.text) return;
    const id = d.id;
    const shape = safe(() => chart.getShapeById(id));
    if (shape?.setProperties) {
      safe(() => shape.setProperties!({ text }));
      d.text = text;
    }
  }

  private create(chart: LineChart, s: LineShape): void {
    const entry: Drawn = { id: null, sig: shapeSig(s), shape: s, text: s.text };
    this.drawn.set(s.key, entry);
    const made = safe(() =>
      chart.createMultipointShape([{ time: this.nowSec(), price: s.price }], horizontalLineOptions(s)),
    );
    Promise.resolve(made)
      .then((id) => {
        if (this.disposed || this.drawn.get(s.key) !== entry) {
          // Superseded while it was being created.
          if (id) safe(() => chart.removeEntity(id));
          return;
        }
        entry.id = id ?? null;
        if (id) {
          this.byId.set(id, s.key);
          this.applyText(chart, entry);
        } else {
          this.drawn.delete(s.key); // the library refused it; the next sync retries
        }
      })
      .catch(() => {
        if (this.drawn.get(s.key) === entry) this.drawn.delete(s.key);
      });
  }

  private removeKey(chart: LineChart | null, key: string): void {
    const d = this.drawn.get(key);
    this.drawn.delete(key);
    this.held.delete(key);
    if (!d?.id) return;
    const id = d.id;
    this.byId.delete(id);
    if (chart) safe(() => chart.removeEntity(id));
  }
}
