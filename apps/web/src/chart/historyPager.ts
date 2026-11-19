/**
 * Older candles, fetched before the user scrolls to them.
 *
 * klinecharts asks for more history only once the oldest bar it holds is
 * already on screen (StoreImp._adjustVisibleRange: `from === 0`), and waits
 * for the answer - so a request made then would always show the chart's edge
 * while it loads. Instead this keeps `ahead` pages of older bars fetched in
 * the background from the moment a series loads. When klinecharts asks, the
 * next page is handed over in the same call (klinecharts adds it before the
 * frame is drawn: the user never sees the edge), and the next fetch starts at
 * once to top the runway up again.
 *
 * Only a scroll through a whole page (a thousand bars) faster than the next
 * page arrives can reach the end of what is fetched; `next()` then answers as
 * soon as it lands, and Chart.tsx fades the late bars in (historyReveal.ts).
 *
 * Pages are contiguous: each is fetched to end just before the oldest bar
 * already held (the gateway's `endTime` is inclusive). If the chart's oldest
 * bar ever stops matching what was handed over (it was rebuilt with fewer
 * bars), what is held no longer joins onto it and is dropped. A fetch that
 * fails is retried with backoff; the history is at its start when a page
 * comes back with nothing older in it.
 *
 * DOM-free and unit-tested: historyPager.test.ts.
 */
import type { KLineData } from 'klinecharts';

export interface HistoryPagerOptions {
  /** The series served (Chart.tsx's feed key). */
  key: string;
  /** The oldest bar the chart holds when the pager starts. */
  firstTimestamp: number;
  /** Up to `limit` bars ending at `endTime` (inclusive), oldest first. */
  fetchOlder: (endTime: number, limit: number, signal: AbortSignal) => Promise<KLineData[]>;
  /** Bars per request - and per hand-over. */
  pageSize: number;
  /** Pages kept fetched ahead of the chart's oldest bar. */
  ahead: number;
  /** A fetch failed; it is retried in `retryInMs`. */
  onError?: (error: unknown, failures: number, retryInMs: number) => void;
  /** Timers (a seam for tests). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface HistoryPage {
  /** Oldest first, all older than the chart's oldest bar, joining onto it. */
  rows: KLineData[];
  /** Whether anything older may still come. */
  more: boolean;
}

/** Backoff after consecutive failures. */
export const HISTORY_RETRY_MS = [1_000, 2_000, 5_000, 10_000, 15_000] as const;

/**
 * NARROW PLOTS WAIT FOR THE FIRST TOUCH. A 375 px phone shows about 38 bars, and the first load
 * already holds 500: some thirteen screens. Fetching two more pages of 1,000 at every load and every
 * switch cost two reads (61 KB brotli, measured 2026-11-18 on BTC-USD 1m) and 40 of the IP's
 * 1,200-a-minute weight right when the book and trades load too - for users who mostly never scroll
 * back. When the bars held are more than this many screens, the runway is fetched at the user's
 * first touch, wheel or key on the plot instead, or as soon as the view comes within
 * PREFETCH_NEAR_BARS of the oldest bar (a zoom out from the toolbar); a faster fling still ends at
 * the late-page path (`next()`, historyReveal.ts). A wide plot keeps fetching it at load.
 */
export const PREFETCH_AT_LOAD_SCREENS = 4;
export const PREFETCH_NEAR_BARS = 250;

/** Whether the runway is fetched as the series loads: `bars` held, `visibleBars` across the plot (null: unknown). */
export function prefetchAtLoad(bars: number, visibleBars: number | null | undefined): boolean {
  if (visibleBars === null || visibleBars === undefined || !(visibleBars > 0)) return true;
  return bars <= visibleBars * PREFETCH_AT_LOAD_SCREENS;
}

/** The view has come close enough to the oldest bar held (`from`: the first visible index) to fetch the runway. */
export const nearOldest = (from: number): boolean => Number.isFinite(from) && from < PREFETCH_NEAR_BARS;

export class HistoryPager {
  readonly key: string;
  /** Fetched, not yet handed over; oldest first, all older than `edge`. */
  private cache: KLineData[] = [];
  /** The oldest bar handed to the chart (or the chart's first when it began). */
  private edge: number;
  private exhausted = false;
  private running = false;
  private ctl: AbortController | null = null;
  private retry: unknown = null;
  private failures = 0;
  private waiters: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly o: HistoryPagerOptions) {
    this.key = o.key;
    this.edge = o.firstTimestamp;
  }

  /** The oldest bar handed over so far. */
  get oldest(): number {
    return this.edge;
  }

  /** Bars fetched and waiting. */
  get held(): number {
    return this.cache.length;
  }

  /** Whether anything older may still come. */
  get more(): boolean {
    return !this.disposed && !(this.exhausted && this.cache.length === 0);
  }

  /**
   * The page that joins onto the chart's oldest bar `first`, handed over now,
   * or null when it has not been fetched yet (a fetch is then running).
   */
  take(first: number): HistoryPage | null {
    if (this.disposed) return { rows: [], more: false };
    if (first !== this.edge) this.rebase(first);
    if (!this.cache.length) {
      if (this.exhausted) return { rows: [], more: false };
      this.prefetch();
      return null;
    }
    const n = Math.min(this.cache.length, this.o.pageSize);
    const rows = this.cache.slice(this.cache.length - n);
    this.cache = this.cache.slice(0, this.cache.length - n);
    this.edge = rows[0]!.timestamp;
    this.prefetch();
    return { rows, more: this.more };
  }

  /** `take`, waiting for the page if it is still on its way. Null once disposed. */
  async next(first: number): Promise<HistoryPage | null> {
    for (;;) {
      if (this.disposed) return null;
      const page = this.take(first);
      if (page) return page;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** Keep `ahead` pages fetched (no-op while one is on its way or backing off). */
  prefetch(): void {
    if (this.disposed || this.exhausted || this.running || this.retry !== null) return;
    if (this.cache.length >= this.o.ahead * this.o.pageSize) return;
    const before = this.cache[0]?.timestamp ?? this.edge;
    const ctl = new AbortController();
    this.ctl = ctl;
    this.running = true;
    let ok = false;
    this.o
      .fetchOlder(before - 1, this.o.pageSize, ctl.signal)
      .then(
        (rows) => {
          if (this.disposed || ctl.signal.aborted) return;
          ok = true;
          this.failures = 0;
          const oldest = this.cache[0]?.timestamp ?? this.edge;
          // Strictly older than what is held, oldest first, no repeats.
          const fresh: KLineData[] = [];
          let last = -Infinity;
          for (const r of [...rows].sort((a, b) => a.timestamp - b.timestamp)) {
            if (!(r.timestamp < oldest) || r.timestamp === last) continue;
            fresh.push(r);
            last = r.timestamp;
          }
          if (!fresh.length) this.exhausted = true;
          else this.cache = fresh.concat(this.cache);
        },
        (error: unknown) => {
          if (this.disposed || ctl.signal.aborted) return;
          this.failures++;
          const ms = HISTORY_RETRY_MS[Math.min(this.failures, HISTORY_RETRY_MS.length) - 1]!;
          this.o.onError?.(error, this.failures, ms);
          const set = this.o.setTimer ?? ((fn: () => void, t: number) => setTimeout(fn, t));
          this.retry = set(() => {
            this.retry = null;
            this.prefetch();
          }, ms);
        },
      )
      .finally(() => {
        if (this.ctl === ctl) this.ctl = null;
        if (ctl.signal.aborted) return;
        this.running = false;
        this.wake();
        // Top the runway up to `ahead` pages.
        if (ok) this.prefetch();
      });
  }

  /** Stop: abort the fetch, drop what is held, release every waiter. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ctl?.abort();
    this.ctl = null;
    this.running = false;
    if (this.retry !== null) (this.o.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.retry);
    this.retry = null;
    this.cache = [];
    this.wake();
  }

  /** The chart's oldest bar is not the one handed over: what is held no
   *  longer joins onto it. Start again from the chart's. */
  private rebase(first: number): void {
    this.ctl?.abort();
    this.ctl = null;
    this.running = false;
    if (this.retry !== null) (this.o.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.retry);
    this.retry = null;
    this.failures = 0;
    this.cache = [];
    this.exhausted = false;
    this.edge = first;
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const resolve of w) resolve();
  }
}
