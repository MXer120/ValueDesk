/**
 * Steps run in order, with the event loop let in once a slice of time is used up.
 *
 * The indexer's flush wrote everything of the last 5 s in one go: one call held its only thread up to 12 s
 * (profile 2026-11-05), and a long flush let more rows gather for the next one. A small flush still runs at
 * once, within the call.
 */
const NOOP = (): void => {};
/** Steps run before the queue is cut down to those still waiting. */
const COMPACT_AT = 1_024;

export class SlicedWork {
  private queue: Array<() => void> = [];
  private next = 0;
  private waiting = false;
  /** When the last turn ended (0: no turn is waiting for another). */
  private turnEnd = 0;
  /** Steps ever added and ever run, and when each add came: how long the oldest waiting step has waited (oldestWaitMs). */
  private added = 0;
  private ran = 0;
  private marks: Array<{ through: number; at: number }> = [];

  constructor(private readonly o: {
    /**
     * How long a turn may run. A function of the steps waiting (work that falls behind must get more of the thread)
     * and of how long everything else held the thread since the last turn.
     */
    budgetMs: number | ((backlog: number, gapMs: number) => number);
    onError: (e: unknown) => void;
    /** After the loop was let in: what runs now is this work again. */
    onResume?: () => void;
    now?: () => number;
  }) {}

  /** Steps not run yet. */
  get backlog(): number {
    return this.queue.length - this.next;
  }

  /**
   * How long the oldest step not run yet has waited (ms; 0 when none waits). Steps run in the order added, so it is
   * the age of the oldest row a flush handed over and has not written (the status page's write target, 2026-11-09).
   */
  get oldestWaitMs(): number {
    while (this.marks.length && this.marks[0]!.through <= this.ran) this.marks.shift();
    const first = this.marks[0];
    return first ? Math.max(0, (this.o.now ?? Date.now)() - first.at) : 0;
  }

  add(steps: ReadonlyArray<() => void>): void {
    this.mark(steps.length);
    this.queue.push(...steps);
    if (!this.waiting) this.run();
  }

  /** Queued behind the rest without running any of it now (a stop that hands the rows elsewhere first). */
  enqueue(steps: ReadonlyArray<() => void>): void {
    this.mark(steps.length);
    this.queue.push(...steps);
  }

  private mark(n: number): void {
    if (!n) return;
    this.added += n;
    this.marks.push({ through: this.added, at: (this.o.now ?? Date.now)() });
  }

  /** Everything left, now, in this call (a stop). */
  drain(): void {
    while (this.next < this.queue.length) this.step();
    this.reset();
  }

  private step(): void {
    const s = this.queue[this.next]!;
    // Let go of a step once it runs. Kept until the queue next stood empty, every row of every flush stayed on the heap for as
    // long as a backlog lasted, and the old space it filled came back as long garbage collections (8-14 s on 2026-11-06).
    this.queue[this.next++] = NOOP;
    this.ran++;
    try {
      s();
    } catch (e) {
      this.o.onError(e);
    }
    if (this.next >= COMPACT_AT) {
      this.queue = this.queue.slice(this.next);
      this.next = 0;
    }
  }

  private reset(): void {
    this.queue = [];
    this.next = 0;
    this.marks = [];
  }

  private run(): void {
    const now = this.o.now ?? Date.now;
    const b = this.o.budgetMs;
    const start = now();
    const until = start + (typeof b === 'function' ? b(this.backlog, this.turnEnd ? Math.max(0, start - this.turnEnd) : 0) : b);
    while (this.next < this.queue.length) {
      this.step();
      if (this.next < this.queue.length && now() >= until) {
        this.waiting = true;
        this.turnEnd = now();
        setImmediate(() => {
          this.waiting = false;
          this.o.onResume?.();
          this.run();
        });
        return;
      }
    }
    this.turnEnd = 0;
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
