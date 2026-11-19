/**
 * Live bars for a chart that is out of view.
 *
 * On a phone the trade chart is page 1 of the carousel and stays mounted while the Book or the
 * Ticket page is shown; every streamed tick made klinecharts add the bar and redraw a canvas no
 * one could see. While the chart's page is marked off (MobileCarousel's `data-off`), only the
 * newest push for each bar time is kept, in order; the moment the page is on again they go to the
 * chart in one task, before anything else is pushed. Each push replaces its bar, so the bars the
 * chart ends with are exactly the ones it would have had. The caller's own state (the last bar,
 * the legend, the watchdog) is still updated on every tick: only the library's draw waits.
 */
export interface Bar {
  timestamp: number;
}

export class HeldPush<B extends Bar> {
  private held = new Map<number, B>();
  private sink: ((b: B) => void) | null = null;
  private off = false;

  /** klinecharts' callback for a fresh store; bars held for the old one are dropped. */
  bind(sink: (b: B) => void): void {
    this.sink = sink;
    this.held.clear();
  }

  unbind(): void {
    this.sink = null;
    this.held.clear();
  }

  get bound(): boolean {
    return this.sink !== null;
  }

  /** How many bar times are waiting (tests, logs). */
  get waiting(): number {
    return this.held.size;
  }

  push(b: B): void {
    if (!this.sink) return;
    if (this.off) {
      // A later push for the same time replaces the held one in its place: times only rise.
      this.held.set(b.timestamp, b);
      return;
    }
    this.flush();
    this.sink(b);
  }

  setOff(off: boolean): void {
    this.off = off;
    if (!off) this.flush();
  }

  flush(): void {
    const sink = this.sink;
    if (!sink || !this.held.size) return;
    const rows = [...this.held.values()];
    this.held.clear();
    for (const r of rows) sink(r);
  }
}
