/**
 * Steps run in order, with the event loop let in once a slice of time is used up.
 *
 * The indexer's flush wrote everything of the last 5 s in one go: one call held its only thread up to 12 s
 * (profile 2026-11-05), and a long flush let more rows gather for the next one. A small flush still runs at
 * once, within the call.
 */
export class SlicedWork {
  private queue: Array<() => void> = [];
  private next = 0;
  private waiting = false;

  constructor(private readonly o: {
    budgetMs: number;
    onError: (e: unknown) => void;
    /** After the loop was let in: what runs now is this work again. */
    onResume?: () => void;
    now?: () => number;
  }) {}

  /** Steps not run yet. */
  get backlog(): number {
    return this.queue.length - this.next;
  }

  add(steps: ReadonlyArray<() => void>): void {
    this.queue.push(...steps);
    if (!this.waiting) this.run();
  }

  /** Everything left, now, in this call (a stop). */
  drain(): void {
    while (this.next < this.queue.length) this.step();
    this.reset();
  }

  private step(): void {
    const s = this.queue[this.next++]!;
    try {
      s();
    } catch (e) {
      this.o.onError(e);
    }
  }

  private reset(): void {
    this.queue = [];
    this.next = 0;
  }

  private run(): void {
    const now = this.o.now ?? Date.now;
    const until = now() + this.o.budgetMs;
    while (this.next < this.queue.length) {
      this.step();
      if (this.next < this.queue.length && now() >= until) {
        this.waiting = true;
        setImmediate(() => {
          this.waiting = false;
          this.o.onResume?.();
          this.run();
        });
        return;
      }
    }
    this.reset();
  }
}

/**
 * Pages read one after another with the event loop let in once the budget is used up. Everything runs within the
 * call when it fits (a small index, a test). `done` runs once, after the last page, unless `stopped` says otherwise.
 */
export function readInSlices(o: {
  /** The next page; empty: the end. */
  page: () => number;
  budgetMs: number;
  done: () => void;
  onError: (e: unknown) => void;
  stopped?: () => boolean;
  now?: () => number;
}): void {
  const now = o.now ?? Date.now;
  const run = (): void => {
    const until = now() + o.budgetMs;
    try {
      for (;;) {
        if (o.stopped?.()) return;
        if (o.page() === 0) break;
        if (now() >= until) {
          setImmediate(run);
          return;
        }
      }
      o.done();
    } catch (e) {
      o.onError(e);
    }
  };
  run();
}
