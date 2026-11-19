/**
 * Chart feed failsafes - the part that decides, shared by both charts.
 *
 *   components/Chart.tsx  (klinecharts, the default)
 *   chart/tv/datafeed.ts  (TradingView Advanced Charts, behind VITE_CHART)
 *
 * Three jobs, all pure or clock-injected so feedHealth.test.ts can pin them
 * without a network, a socket or a DOM:
 *
 *   1. LOAD WITH RETRY. The first page of bars gets LOAD_TIMEOUT_MS; a timeout
 *      or a failure retries on RETRY_SCHEDULE_MS (1s, 2s, 5s, 10s, then every
 *      15s) for as long as the caller still wants that market. After
 *      ERROR_AFTER_FAILURES the caller shows an error with a "Retry now" button
 *      - and the background retries keep going underneath it.
 *
 *   2. STALE DETECTION. `staleReason` says whether the bars on screen have
 *      stopped tracking the market (see there for the three signals), and
 *      `FeedWatchdog` turns that - plus hub reconnects and the tab becoming
 *      visible again - into rate-limited recovery calls.
 *
 *   3. MERGE. `planMerge` decides how refetched bars go back into a chart that
 *      already holds bars: append/replace at the right edge, or a reload when
 *      a hole in the middle cannot be patched through an append-only API.
 *
 * Nothing here opens a socket or issues a request itself: the callers inject
 * those, so the SoDEX rate limit is spent only where a caller chose to spend it.
 */
import { PERIOD_BY_INTERVAL } from './intervals';

// --- timing ------------------------------------------------------------------

/** A first page that has not arrived by now is treated as failed. */
export const LOAD_TIMEOUT_MS = 8_000;
/** Delay before retry N (1-based). */
export const RETRY_SCHEDULE_MS = [1_000, 2_000, 5_000, 10_000] as const;
/** ...and after the schedule runs out, this, for as long as it takes. */
export const RETRY_STEADY_MS = 15_000;
/** Failures before the "Reconnecting" pill becomes an error with a button. */
export const ERROR_AFTER_FAILURES = 3;

/** How long to wait after `failures` consecutive failures. */
export function retryDelayMs(failures: number): number {
  if (!(failures > 0)) return 0;
  return RETRY_SCHEDULE_MS[failures - 1] ?? RETRY_STEADY_MS;
}

const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  // Nominal. Only ever used to size a request or a staleness window, never to
  // place a bar.
  month: 2_592_000_000,
};

/** Nominal bar length of a gateway interval ("1m", "4h", "1D", ...). */
export function intervalMs(interval: string): number | undefined {
  const p = PERIOD_BY_INTERVAL[interval];
  if (!p) return undefined;
  const unit = UNIT_MS[p.type];
  return unit === undefined ? undefined : unit * p.span;
}

// --- errors ------------------------------------------------------------------

export class FeedTimeout extends Error {
  constructor(readonly ms: number) {
    super(`no bars within ${Math.round(ms / 1000)}s`);
    this.name = 'FeedTimeout';
  }
}

/** Rejection of a load the caller cancelled. Never shown to anyone. */
export class LoadCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'LoadCancelled';
  }
}

export const isCancelled = (e: unknown): boolean => e instanceof LoadCancelled;

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'unknown error';
}

/**
 * A failure retrying cannot fix: the gateway said the request itself is
 * wrong (400 bad interval, 404 unknown market). Such a load goes straight to
 * the error state - but still retries at the steady rate, because "unknown
 * market" is also what a just-listed market looks like for a minute.
 * 408 / 425 / 429 are "try again later", not "wrong".
 */
export function isFatalStatus(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

// --- 1. load with retry -------------------------------------------------------

export type LoadPhase = 'loading' | 'retrying' | 'error';

export interface LoadStatus {
  phase: LoadPhase;
  /** Consecutive failures so far. */
  failures: number;
  /** Wall-clock ms of the next attempt, while waiting for it; else null. */
  nextRetryAt: number | null;
  error: string | null;
  /** HTTP status of the last failure, when it had one (for the logs). */
  status?: number;
}

type Timer = unknown;

export interface RetryOptions<T> {
  /** One attempt. Must honour `signal` (it is aborted on timeout and cancel). */
  attempt: (signal: AbortSignal) => Promise<T>;
  timeoutMs?: number;
  onStatus?: (s: LoadStatus) => void;
  isFatal?: (e: unknown) => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

export interface RetryHandle<T> {
  /** Resolves with the first successful attempt; rejects with LoadCancelled
   *  after cancel(). Never rejects for any other reason - failures retry. */
  promise: Promise<T>;
  /** Skip the wait before the next attempt (the "Retry now" button). */
  retryNow(): void;
  /** Stop for good and abort the attempt in flight. */
  cancel(): void;
}

export function loadWithRetry<T>(o: RetryOptions<T>): RetryHandle<T> {
  const timeoutMs = o.timeoutMs ?? LOAD_TIMEOUT_MS;
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((t: Timer) => clearTimeout(t as ReturnType<typeof setTimeout>));

  let cancelled = false;
  let ctl: AbortController | null = null;
  let wake: (() => void) | null = null;
  let failures = 0;

  const emit = (s: LoadStatus) => {
    if (cancelled) return;
    // A listener that throws must never be what stops a load from retrying.
    try {
      o.onStatus?.(s);
    } catch {
      /* ignored */
    }
  };

  /** One attempt, raced against the timeout. A late answer from an attempt
   *  that already timed out is dropped - its request has been aborted. */
  const once = (): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const c = new AbortController();
      ctl = c;
      let done = false;
      const timer = setTimer(() => {
        if (done) return;
        done = true;
        c.abort();
        reject(new FeedTimeout(timeoutMs));
      }, timeoutMs);
      let p: Promise<T>;
      try {
        p = o.attempt(c.signal);
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(
        (v) => {
          if (done) return;
          done = true;
          clearTimer(timer);
          resolve(v);
        },
        (e) => {
          if (done) return;
          done = true;
          clearTimer(timer);
          reject(e);
        },
      );
    });

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const t = setTimer(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimer(t);
        wake = null;
        resolve();
      };
    });

  const promise = (async (): Promise<T> => {
    emit({ phase: 'loading', failures: 0, nextRetryAt: null, error: null });
    for (;;) {
      if (cancelled) throw new LoadCancelled();
      try {
        const v = await once();
        if (cancelled) throw new LoadCancelled();
        return v;
      } catch (e) {
        if (cancelled) throw new LoadCancelled();
        failures += 1;
        if (o.isFatal?.(e)) failures = Math.max(failures, ERROR_AFTER_FAILURES);
        const phase: LoadPhase = failures >= ERROR_AFTER_FAILURES ? 'error' : 'retrying';
        const delay = retryDelayMs(failures);
        const error = errorText(e);
        const code = (e as { status?: unknown } | null)?.status;
        const status = typeof code === 'number' ? { status: code } : {};
        emit({ phase, failures, nextRetryAt: now() + delay, error, ...status });
        await sleep(delay);
        if (cancelled) throw new LoadCancelled();
        // Attempting again: no countdown while the request is out.
        emit({ phase, failures, nextRetryAt: null, error, ...status });
      }
    }
  })();
  // The caller may cancel without ever awaiting; that must not surface as an
  // unhandled rejection.
  promise.catch(() => undefined);

  return {
    promise,
    retryNow() {
      wake?.();
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      ctl?.abort();
      wake?.();
    },
  };
}

/**
 * One attempt with a deadline and no retries - what a gap-fill uses: if it
 * fails, the watchdog's own pacing decides when to try again. The attempt's
 * signal is aborted on timeout, so a slow request does not keep running.
 */
export function attemptWithTimeout<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = LOAD_TIMEOUT_MS,
  timers: {
    setTimer?: (fn: () => void, ms: number) => Timer;
    clearTimer?: (t: Timer) => void;
  } = {},
): Promise<T> {
  const setTimer = timers.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = timers.clearTimer ?? ((t: Timer) => clearTimeout(t as ReturnType<typeof setTimeout>));
  return new Promise<T>((resolve, reject) => {
    const c = new AbortController();
    let done = false;
    const timer = setTimer(() => {
      if (done) return;
      done = true;
      c.abort();
      reject(new FeedTimeout(timeoutMs));
    }, timeoutMs);
    let p: Promise<T>;
    try {
      p = attempt(c.signal);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimer(timer);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimer(timer);
        reject(e);
      },
    );
  });
}

// --- 2. staleness --------------------------------------------------------------

/** Slack on top of two bar lengths before a missing bar counts. */
export const STALE_MARGIN_MS = 15_000;
/** The shortest silence that can mean anything, whatever the interval. */
export const SILENCE_FLOOR_MS = 30_000;
/** Hidden at least this long -> gap-fill when the tab is shown again. */
export const HIDDEN_REFETCH_MS = 5_000;
/** With the stream down, refresh from REST this often. */
export const STREAM_DOWN_POLL_MS = 15_000;
/** Spacing between stale recoveries that found nothing, escalating. A quiet
 *  market (no trades, so no candles) settles at one small request per 2 min. */
export const RECOVER_COOLDOWN_MS = [15_000, 30_000, 60_000, 120_000] as const;

export type RecoverReason =
  /** The ticker traded after the last candle arrived, and the candle has been
   *  silent past the floor: the candle stream has stalled on a live market. */
  | 'ticker-moving'
  /** The newest bar is more than two bars (plus margin) old. */
  | 'stale-bars'
  /** Nothing from the candle stream for max(2 bars, 30s) while it reports open. */
  | 'stream-silent'
  /** The stream has been down a while: keep the chart current from REST. */
  | 'stream-down'
  /** The hub came back from a dropped connection. */
  | 'reconnect'
  /** The tab was hidden and is visible again. */
  | 'visible'
  /** The stream moved on from a bar it never updated (the one the history load caught half-way):
   *  its final open, high, low, close and volume are read so the bar is not left half-made. */
  | 'settle'
  /** A kept series was put on the chart at once (seriesCache.ts): its right edge - and every bar
   *  the stream had written - is read and merged in. Chart.tsx's own call; the watchdog never asks it. */
  | 'kept';

export interface StaleInput {
  now: number;
  intervalMs: number;
  /** Open time of the newest bar on the chart (ms), or null with no bars. */
  lastBarTime: number | null;
  /** When the chart last heard from the market: a stream tick, or a history
   *  page being applied. Null before either. */
  lastTickAt: number | null;
  /** Hub socket open AND the venue-side stream for this engine open. */
  streamOpen: boolean;
  /** When the last-traded price last changed; null if it never has. */
  tickerMovedAt: number | null;
}

/**
 * Whether the chart has stopped tracking the market, and on which evidence.
 *
 * The ticker comes first because it is the only signal that can tell a
 * stalled stream from a quiet market: candles are built from trades, so a
 * last-traded price that moved while no candle arrived means a candle update
 * was lost - on ANY interval, including 1D, where "two bars of silence" would
 * be two days.
 */
export function staleReason(s: StaleInput): RecoverReason | null {
  const silence = s.lastTickAt === null ? 0 : s.now - s.lastTickAt;
  if (
    s.tickerMovedAt !== null &&
    s.lastTickAt !== null &&
    s.tickerMovedAt > s.lastTickAt &&
    silence > SILENCE_FLOOR_MS
  ) {
    return 'ticker-moving';
  }
  // A closed stream is the watchdog's 'stream-down' path, not a stale verdict.
  if (!s.streamOpen) return null;
  if (s.lastBarTime !== null && s.now - s.lastBarTime > 2 * s.intervalMs + STALE_MARGIN_MS) return 'stale-bars';
  if (silence > Math.max(2 * s.intervalMs, SILENCE_FLOOR_MS)) return 'stream-silent';
  return null;
}

/** What a recovery found. */
export type RecoverResult =
  /** The chart already had everything REST has. */
  | 'current'
  /** REST had bars the chart was missing; they are on the chart now. */
  | 'caught-up'
  /** The recovery could not run or its request failed. */
  | 'failed';

export type FeedHealth = 'live' | 'delayed';

export interface WatchdogOptions {
  intervalMs: number;
  recover: (reason: RecoverReason) => Promise<RecoverResult>;
  onHealth?: (health: FeedHealth, why: string) => void;
  now?: () => number;
}

const WHY_LIVE = 'Live: candles are streaming from the venue.';

/** "0.1230" and 0.123 are the same price. */
function samePrice(a: string, b: string): boolean {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) ? x === y : a === b;
}

/**
 * Turns signals into rate-limited recovery calls, for ONE series (market +
 * interval). The owner creates a new one whenever the series changes, feeds it
 * signals, and calls `check()` on a timer (every few seconds).
 *
 *   noteHistory  a page of history was applied to the chart
 *   noteTick     a realtime candle arrived for this series
 *   noteTicker   the last-traded price, whenever the app has a new one
 *   noteStream   whether the hub (and the venue stream behind it) is open
 *   noteVisible  document visibility
 *
 * Health is `delayed` while the stream is down, while the ticker says candles
 * are missing, and after a recovery had to fetch bars the stream never
 * delivered (or failed) - until the stream proves itself with a tick again.
 */
export class FeedWatchdog {
  private readonly now: () => number;
  private lastBarTime: number | null = null;
  private lastTickAt: number | null = null;
  private tickerPrice: string | null = null;
  private tickerMovedAt: number | null = null;
  private streamOpen: boolean | null = null;
  private wasOpen = false;
  private streamDownSince: number | null = null;
  private hiddenAt: number | null = null;
  private busy = false;
  private step = 0;
  private nextAllowedAt = 0;
  private behind = false;
  private behindWhy = '';
  private health: FeedHealth | null = null;
  private why = '';
  /** A forced recovery (reconnect / visible) that arrived while another was
   *  running. It runs as soon as that one finishes, rather than being lost. */
  private queued: RecoverReason | null = null;
  private disposed = false;

  constructor(private readonly o: WatchdogOptions) {
    this.now = o.now ?? Date.now;
  }

  noteHistory(lastBarTime: number | null): void {
    this.lastBarTime = lastBarTime;
    this.lastTickAt = this.now();
    this.update();
  }

  noteTick(barTime: number): void {
    if (this.lastBarTime === null || barTime > this.lastBarTime) this.lastBarTime = barTime;
    this.lastTickAt = this.now();
    // The stream just proved itself: whatever made us suspicious is over.
    this.behind = false;
    this.step = 0;
    this.nextAllowedAt = 0;
    this.update();
  }

  /** Seed with the chart's own last close first: a price still left over from
   *  the previous market must not read as "this market traded". */
  noteTicker(price: string | number | null | undefined): void {
    if (price === null || price === undefined || price === '') return;
    const p = String(price);
    if (this.tickerPrice !== null && !samePrice(p, this.tickerPrice)) this.tickerMovedAt = this.now();
    this.tickerPrice = p;
  }

  noteStream(open: boolean): void {
    const was = this.streamOpen;
    this.streamOpen = open;
    if (open) {
      this.streamDownSince = null;
      // Back from a DROP - not the first open. Bars that closed while it was
      // down never arrive as ticks, so they are fetched.
      if (was === false && this.wasOpen) this.run('reconnect', true);
      this.wasOpen = true;
    } else if (was !== false) {
      this.streamDownSince = this.now();
    }
    this.update();
  }

  noteVisible(visible: boolean): void {
    if (!visible) {
      if (this.hiddenAt === null) this.hiddenAt = this.now();
      return;
    }
    const hiddenFor = this.hiddenAt === null ? 0 : this.now() - this.hiddenAt;
    this.hiddenAt = null;
    // Background tabs have their timers throttled and may have their sockets
    // frozen; whatever the stream says, re-read the right edge.
    if (hiddenFor >= HIDDEN_REFETCH_MS) this.run('visible', true);
  }

  /** Call every few seconds. */
  check(): void {
    if (this.disposed || this.hiddenAt !== null) return;
    if (this.streamOpen === false) {
      if (this.streamDownSince !== null && this.now() - this.streamDownSince >= STREAM_DOWN_POLL_MS) {
        this.run('stream-down', false, STREAM_DOWN_POLL_MS);
      }
      return;
    }
    const reason = staleReason({
      now: this.now(),
      intervalMs: this.o.intervalMs,
      lastBarTime: this.lastBarTime,
      lastTickAt: this.lastTickAt,
      streamOpen: true, // closed returned above
      tickerMovedAt: this.tickerMovedAt,
    });
    if (!reason) return;
    if (reason === 'ticker-moving' && !this.behind) {
      this.behind = true;
      this.behindWhy = 'Delayed: the market traded but no candle update arrived - refetching.';
      this.update();
    }
    this.run(reason);
  }

  get current(): FeedHealth {
    return this.computeHealth()[0];
  }

  dispose(): void {
    this.disposed = true;
  }

  private run(reason: RecoverReason, force = false, fixedCooldown?: number): void {
    if (this.disposed) return;
    if (this.busy) {
      if (force) this.queued = reason;
      return;
    }
    const t = this.now();
    if (!force && t < this.nextAllowedAt) return;
    this.busy = true;
    let p: Promise<RecoverResult>;
    try {
      p = this.o.recover(reason);
    } catch {
      p = Promise.resolve<RecoverResult>('failed');
    }
    p.catch((): RecoverResult => 'failed').then((res) => {
      this.busy = false;
      if (this.disposed) return;
      const done = this.now();
      if (res === 'current') {
        // REST has nothing the chart lacks: it is current, whatever made it
        // look stale (typically a quiet market with no trades to candle).
        this.behind = false;
        // The ticker's movement has been accounted for.
        this.tickerMovedAt = null;
      } else if (res === 'caught-up') {
        this.behind = true;
        this.behindWhy =
          reason === 'stream-down'
            ? 'Delayed: the stream is reconnecting - the chart is refreshed from REST.'
            : 'Delayed: the candle stream missed updates - the chart was refilled from REST.';
        this.lastTickAt = done;
        this.tickerMovedAt = null;
      } else {
        this.behind = true;
        this.behindWhy = 'Delayed: could not refresh the chart - retrying.';
      }
      if (fixedCooldown !== undefined) {
        this.nextAllowedAt = done + fixedCooldown;
      } else if (!force || res !== 'current') {
        this.nextAllowedAt = done + (RECOVER_COOLDOWN_MS[this.step] ?? RECOVER_COOLDOWN_MS[RECOVER_COOLDOWN_MS.length - 1]!);
        this.step = Math.min(this.step + 1, RECOVER_COOLDOWN_MS.length - 1);
      }
      this.update();
      const next = this.queued;
      this.queued = null;
      if (next) this.run(next, true);
    });
  }

  private computeHealth(): [FeedHealth, string] {
    if (this.streamOpen === false) return ['delayed', 'Delayed: the live stream is reconnecting.'];
    if (this.behind) return ['delayed', this.behindWhy];
    return ['live', WHY_LIVE];
  }

  private update(): void {
    if (this.disposed) return;
    const [h, why] = this.computeHealth();
    if (h === this.health && why === this.why) return;
    this.health = h;
    this.why = why;
    this.o.onHealth?.(h, why);
  }
}

// --- 3. merge --------------------------------------------------------------------

/** The fields a merge decision reads. `time` is the bar OPEN time in ms. */
export interface BarLike {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type MergePlan<B extends BarLike> =
  | { kind: 'none' }
  /** Feed these, oldest first, through the chart's realtime path: a bar at the
   *  chart's last time replaces it, a later one is appended. `newBars` counts
   *  the ones strictly newer than what the chart held. */
  | { kind: 'append'; bars: B[]; newBars: number }
  /** A hole the realtime path cannot fill (it only ever touches the right
   *  edge): rebuild from `mergeBars(held, fetched)`. */
  | { kind: 'reload'; reason: 'empty' | 'gap' | 'incomplete' | 'too-far' };

/**
 * Whether `a` is a newer reading of the same bar than `b`. Volume only ever
 * grows while a bar is open, so it orders two snapshots of one bar without a
 * clock; OHLC is the fallback when either side lacks it.
 */
function newerReading(a: BarLike, b: BarLike): boolean {
  if (a.volume !== undefined && b.volume !== undefined && Number.isFinite(a.volume) && Number.isFinite(b.volume)) {
    return a.volume > b.volume;
  }
  return a.open !== b.open || a.high !== b.high || a.low !== b.low || a.close !== b.close;
}

/**
 * How refetched bars go back into a chart. Both lists ascending by time.
 *
 *   - Bars older than the chart's newest are checked, never re-sent: one the
 *     chart lacks is a gap, one REST has a NEWER reading of (more volume) is a
 *     bar the stream left incomplete. Either needs a reload.
 *   - The chart's newest bar is replaced only by a newer reading, so a REST
 *     snapshot that lags the stream can never pull the live candle backwards.
 *   - Anything newer is appended.
 */
export function planMerge<B extends BarLike>(held: readonly BarLike[], fetched: readonly B[]): MergePlan<B> {
  if (fetched.length === 0) return { kind: 'none' };
  if (held.length === 0) return { kind: 'reload', reason: 'empty' };
  const first = held[0]!.time;
  const lastBar = held[held.length - 1]!;
  const last = lastBar.time;
  const oldest = fetched[0]!.time;
  // The page does not reach back to the chart's newest bar: whatever lies
  // between is unknown. (Callers size the page so this means "too far behind".)
  if (oldest > last) return { kind: 'reload', reason: 'too-far' };

  const byTime = new Map<number, BarLike>();
  for (let i = held.length - 1; i >= 0; i--) {
    const h = held[i]!;
    if (h.time < oldest) break;
    byTime.set(h.time, h);
  }
  const bars: B[] = [];
  let newBars = 0;
  for (const f of fetched) {
    if (f.time < first) continue; // older than anything on the chart
    if (f.time < last) {
      const h = byTime.get(f.time);
      if (!h) return { kind: 'reload', reason: 'gap' };
      if (newerReading(f, h)) return { kind: 'reload', reason: 'incomplete' };
      continue;
    }
    if (f.time === last) {
      if (newerReading(f, lastBar)) bars.push(f);
      continue;
    }
    bars.push(f);
    newBars += 1;
  }
  return bars.length ? { kind: 'append', bars, newBars } : { kind: 'none' };
}

/** The chart's bars older than the refetched page, then the page itself: the
 *  page is authoritative for every time it covers. */
export function mergeBars<B extends BarLike>(held: readonly B[], fetched: readonly B[]): B[] {
  if (fetched.length === 0) return [...held];
  const oldest = fetched[0]!.time;
  return [...held.filter((h) => h.time < oldest), ...fetched];
}

/**
 * Page size for a gap-fill: every bar that could have closed since the
 * chart's newest one, plus slack, within [min, max]. A market with empty
 * periods has fewer bars than this, so the page reaches further back - which
 * is what lets `planMerge` verify the bars before the chart's newest one.
 */
export function gapFillLimit(
  lastBarTime: number | null,
  now: number,
  intervalMs: number,
  min = 10,
  max = 500,
): number {
  if (lastBarTime === null || !(intervalMs > 0)) return max;
  const missing = Math.ceil(Math.max(0, now - lastBarTime) / intervalMs);
  return Math.min(max, Math.max(min, missing + 3));
}
