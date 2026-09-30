/**
 * TradingView JS-API datafeed over the app's EXISTING data paths.
 *
 *   symbols   GET /api/md/{engine}/symbols            (or the `sym` the app
 *                                                       already holds - no fetch)
 *   history   GET /api/md/{engine}/klines?symbol&interval&limit[&endTime]
 *   realtime  the hub's `candle` channel, subscribed exactly the way
 *             Chart.tsx does it: { channel: 'candle', symbol, interval }
 *
 * FAILSAFES - the same rules as the klinecharts chart, from ../feedHealth.ts:
 *   - the FIRST page of a series retries (8s deadline; 1s, 2s, 5s, 10s, then
 *     every 15s) until it lands, the series changes, or the chart goes away.
 *     Its state is published through `onStatus` for the loading / reconnecting
 *     / error overlay, and `retryNow` is the overlay's button. A load for a
 *     series the chart has left is cancelled, so its answer can never land.
 *   - older pages get one attempt with the same deadline; the library asks
 *     again when the user scrolls.
 *   - every realtime subscription has a FeedWatchdog. Stalled candles on a
 *     trading market, a hub reconnect, the tab coming back: the right edge is
 *     refetched and merged through onTick (append / replace, never a duplicate
 *     and never a bar older than the library's newest), or - for a hole in the
 *     middle - the library is told to drop its cache and re-read history.
 *
 * Every I/O edge is injected (`DatafeedDeps`), so this file has no import of
 * api.ts, ws.ts or the DOM and runs under `npx tsx --test` with fakes. The
 * browser wiring lives in sources.ts.
 *
 * No socket is opened here: the app's hub owns the one connection and
 * refcounts subscriptions, so a TradingView chart and any other panel
 * watching the same candles share a single upstream subscription.
 */
import type { Engine, Symbol as MarketSymbol } from '../../api';
import type { KlineQuery } from '../klines';
import type { FeedView } from '../FeedOverlay';
import {
  FeedWatchdog,
  LOAD_TIMEOUT_MS,
  attemptWithTimeout,
  errorText,
  gapFillLimit,
  intervalMs as intervalMsOf,
  isCancelled,
  isFatalStatus,
  loadWithRetry,
  planMerge,
  type FeedHealth,
  type RecoverReason,
  type RecoverResult,
  type RetryHandle,
} from '../feedHealth';
import {
  DATAFEED_CONFIG,
  PAGE_MAX,
  candleToBars,
  historyMeta,
  intervalForResolution,
  normalizeBars,
  parseTicker,
  planHistory,
  searchSymbols,
  toSymbolInfo,
  type SearchEntry,
} from './datafeedCore';
import type { Bar, IBasicDataFeed, SubscribeBarsCallback } from './types';

export type { KlineQuery };

type Timer = unknown;

export interface DatafeedDeps {
  /** The engine a bare name (no "perps:" prefix) belongs to - the app's. */
  defaultEngine: () => Engine;
  loadSymbols: (engine: Engine) => Promise<MarketSymbol[]>;
  /** Raw gateway rows, any order. Must honour `signal`. */
  loadKlines: (q: KlineQuery, signal?: AbortSignal) => Promise<unknown[]>;
  /** Returns the unsubscribe function. */
  subscribeCandles: (
    engine: Engine,
    symbol: string,
    interval: string,
    onData: (data: unknown) => void,
  ) => () => void;
  /** Make the chart drop its bars and request history again. Called right
   *  after the library's `onResetCacheNeeded`, for a hole ticks cannot fill. */
  resetChart?: () => void;
  /** How to call a library callback "later". setTimeout(0) by default; tests
   *  pass a synchronous one. */
  defer?: (fn: () => void) => void;
  /** Clock and timers - injected by tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

export interface Datafeed extends IBasicDataFeed {
  /** Hand the datafeed a symbol the app already has, so resolving it costs no
   *  request. */
  primeSymbol(engine: Engine, sym: MarketSymbol): void;
  /** Ask every live subscription's chart to drop its cache and re-request
   *  history. */
  resetCache(): void;
  /** Load state of the series the chart asked for last (the overlay's input). */
  onStatus(cb: (seriesKey: string, view: FeedView) => void): () => void;
  /** Live / Delayed, across the chart's realtime subscriptions. */
  onHealth(cb: (health: FeedHealth, why: string) => void): () => void;
  /** The overlay's "Retry now": skip the wait before the next attempt. */
  retryNow(): void;
  /** The app's last traded price for a market - the signal that tells a
   *  stalled candle stream from a quiet market. */
  noteTicker(engine: Engine, symbol: string, price: string | number | null | undefined): void;
  /** Hub socket (and venue stream) open. */
  noteStream(open: boolean): void;
  noteVisible(visible: boolean): void;
  /** Run the staleness checks. Call every few seconds. */
  check(): void;
  dispose(): void;
}

export const seriesKey = (engine: Engine, name: string, interval: string): string => `${engine}|${name}|${interval}`;

interface Sub {
  guid: string;
  key: string;
  engine: Engine;
  name: string;
  interval: string;
  onTick: SubscribeBarsCallback;
  onReset: () => void;
  unsub: () => void;
  listen: () => () => void;
  watchdog: FeedWatchdog;
  health: FeedHealth;
  why: string;
}

interface FirstLoad {
  key: string;
  reqKey: string;
  handle: RetryHandle<unknown[]>;
}

export function createDatafeed(deps: DatafeedDeps): Datafeed {
  const defer = deps.defer ?? ((fn: () => void) => void setTimeout(fn, 0));
  const now = deps.now ?? Date.now;
  const timers = {
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
  };
  let disposed = false;

  const known = new Map<string, MarketSymbol>();
  const lists = new Map<Engine, Promise<MarketSymbol[]>>();
  const inflight = new Map<string, Promise<unknown[]>>();
  /** Newest bar time handed to the library per series. A realtime bar older
   *  than this would be rejected as a time-order violation. */
  const lastTime = new Map<string, number>();
  /** The newest bars the library holds per series (at most a page): what a
   *  gap-fill is merged against. */
  const tails = new Map<string, Bar[]>();
  const subs = new Map<string, Sub>();
  let first: FirstLoad | null = null;
  let stream: boolean | null = null;
  let visible = true;

  const statusCbs = new Set<(key: string, view: FeedView) => void>();
  let lastStatus: { key: string; view: FeedView } | null = null;
  const emitStatus = (key: string, view: FeedView) => {
    lastStatus = { key, view };
    for (const cb of statusCbs) cb(key, view);
  };

  const healthCbs = new Set<(h: FeedHealth, why: string) => void>();
  let lastHealth: [FeedHealth, string] = ['live', ''];
  const emitHealth = () => {
    let h: [FeedHealth, string] = ['live', 'Live: candles are streaming from the venue.'];
    for (const s of subs.values()) {
      if (s.health === 'delayed') {
        h = ['delayed', s.why];
        break;
      }
    }
    if (h[0] === lastHealth[0] && h[1] === lastHealth[1]) return;
    lastHealth = h;
    for (const cb of healthCbs) cb(h[0], h[1]);
  };

  const knownKey = (engine: Engine, name: string) => `${engine}|${name.toUpperCase()}`;

  function listFor(engine: Engine): Promise<MarketSymbol[]> {
    let p = lists.get(engine);
    if (!p) {
      p = deps.loadSymbols(engine);
      lists.set(engine, p);
      // A failed list must not be cached, or one bad request would make every
      // later resolve fail until reload.
      p.catch(() => lists.delete(engine));
    }
    return p;
  }

  async function findSymbol(engine: Engine, name: string): Promise<MarketSymbol | undefined> {
    const hit = known.get(knownKey(engine, name));
    if (hit) return hit;
    const list = await listFor(engine);
    const up = name.toUpperCase();
    const found =
      list.find((s) => s.name.toUpperCase() === up) ??
      list.find((s) => (s.displayName || '').toUpperCase() === up);
    if (found) known.set(knownKey(engine, found.name), found);
    return found;
  }

  /** One page, shared by identical concurrent requests, with a deadline. */
  function fetchPage(q: KlineQuery): Promise<unknown[]> {
    const key = `${q.engine}|${q.symbol}|${q.interval}|${q.endTime ?? 'head'}|${q.limit}`;
    let p = inflight.get(key);
    if (!p) {
      p = attemptWithTimeout((signal) => deps.loadKlines(q, signal), LOAD_TIMEOUT_MS, timers);
      inflight.set(key, p);
      const clear = () => inflight.delete(key);
      p.then(clear, clear);
    }
    return p;
  }

  /** Remember the newest bars of a series, capped at one page. */
  function rememberPage(key: string, bars: readonly Bar[]) {
    tails.set(key, bars.slice(-PAGE_MAX));
  }
  function rememberBar(key: string, bar: Bar) {
    const t = tails.get(key);
    if (!t) {
      tails.set(key, [bar]);
      return;
    }
    const last = t[t.length - 1];
    if (last && last.time === bar.time) t[t.length - 1] = bar;
    else if (!last || bar.time > last.time) {
      t.push(bar);
      if (t.length > PAGE_MAX) t.splice(0, t.length - PAGE_MAX);
    }
  }

  /** Hand one bar to a subscription, if the library can take it. */
  function deliver(sub: Sub, bar: Bar): boolean {
    const last = lastTime.get(sub.key);
    if (last !== undefined && bar.time < last) return false; // stale / out of order
    lastTime.set(sub.key, bar.time);
    rememberBar(sub.key, bar);
    sub.onTick(bar);
    return true;
  }

  async function recover(sub: Sub, reason: RecoverReason): Promise<RecoverResult> {
    if (disposed || subs.get(sub.guid) !== sub) return 'current';
    if (reason === 'ticker-moving' || reason === 'stale-bars' || reason === 'stream-silent') {
      // A quiet stream on a live market: ask the hub for the channel afresh.
      sub.unsub();
      sub.unsub = sub.listen();
    }
    const tail = tails.get(sub.key) ?? [];
    const limit = gapFillLimit(tail[tail.length - 1]?.time ?? null, now(), intervalMsOf(sub.interval) ?? 60_000, 10, PAGE_MAX);
    let rows: unknown[];
    try {
      rows = await attemptWithTimeout(
        (signal) => deps.loadKlines({ engine: sub.engine, symbol: sub.name, interval: sub.interval, limit }, signal),
        LOAD_TIMEOUT_MS,
        timers,
      );
    } catch {
      return 'failed';
    }
    if (disposed || subs.get(sub.guid) !== sub) return 'current';
    const plan = planMerge(tails.get(sub.key) ?? [], normalizeBars(rows));
    if (plan.kind === 'none') return 'current';
    if (plan.kind === 'append') {
      for (const bar of plan.bars) deliver(sub, bar);
      return plan.newBars > 0 ? 'caught-up' : 'current';
    }
    // A hole in the middle: onTick can only touch the right edge, so the
    // library re-reads history (and our first-page path refills the tail).
    tails.delete(sub.key);
    lastTime.delete(sub.key);
    sub.onReset();
    deps.resetChart?.();
    return 'caught-up';
  }

  function dropSub(guid: string) {
    const s = subs.get(guid);
    if (!s) return;
    s.unsub();
    s.watchdog.dispose();
    subs.delete(guid);
  }

  return {
    onReady(callback) {
      defer(() => callback(DATAFEED_CONFIG));
    },

    searchSymbols(userInput, exchange, symbolType, onResult) {
      const engines: Engine[] = symbolType === 'perps' || symbolType === 'spot' ? [symbolType] : ['perps', 'spot'];
      Promise.all(
        engines.map((e) =>
          listFor(e).then(
            (list) => list.map((sym): SearchEntry => ({ engine: e, sym })),
            () => [] as SearchEntry[], // one book failing still lets the other answer
          ),
        ),
      ).then((groups) => {
        if (!disposed) onResult(searchSymbols(groups.flat(), userInput, exchange, symbolType));
      });
    },

    resolveSymbol(symbolName, onResolve, onError) {
      const { engine, name } = parseTicker(symbolName, deps.defaultEngine());
      findSymbol(engine, name).then(
        (sym) => {
          if (disposed) return;
          if (sym) defer(() => onResolve(toSymbolInfo(engine, sym)));
          else defer(() => onError('unknown_symbol'));
        },
        (e) => {
          if (!disposed) defer(() => onError(errorText(e)));
        },
      );
    },

    getBars(symbolInfo, resolution, periodParams, onResult, onError) {
      const interval = intervalForResolution(resolution);
      if (!interval) {
        defer(() => onError(`unsupported resolution ${resolution}`));
        return;
      }
      const { engine, name } = parseTicker(symbolInfo.ticker ?? symbolInfo.name, deps.defaultEngine());
      const key = seriesKey(engine, name, interval);
      const plan = planHistory(periodParams, interval);
      const q: KlineQuery = {
        engine,
        symbol: name,
        interval,
        limit: plan.limit,
        ...(plan.endTime === undefined ? {} : { endTime: plan.endTime }),
      };

      if (!periodParams.firstDataRequest) {
        // A page further back. One attempt; the library asks again on scroll.
        fetchPage(q).then(
          (rows) => {
            if (disposed) return;
            const bars = normalizeBars(rows, plan.beforeMs === undefined ? {} : { beforeMs: plan.beforeMs });
            onResult(bars, historyMeta(bars));
          },
          (e) => {
            if (!disposed) onError(errorText(e));
          },
        );
        return;
      }

      // The first page of a series: retried until it lands. Identical
      // concurrent asks share one load; a different series cancels it.
      const reqKey = `${key}|${q.limit}`;
      let f = first;
      if (!f || f.reqKey !== reqKey) {
        f?.handle.cancel();
        const load: FirstLoad = { key, reqKey, handle: null as unknown as RetryHandle<unknown[]> };
        first = load;
        emitStatus(key, { phase: 'loading', failures: 0, nextRetryAt: null, error: null });
        load.handle = loadWithRetry({
          attempt: (signal) => deps.loadKlines(q, signal),
          isFatal: isFatalStatus,
          onStatus: (s) => {
            // (The first, synchronous 'loading' is the one emitted above.)
            if (first !== load || disposed || s.phase === 'loading') return;
            emitStatus(key, { phase: s.phase, failures: s.failures, nextRetryAt: s.nextRetryAt, error: s.error });
          },
          now,
          ...timers,
        });
        f = load;
      }
      const mine = f;
      mine.handle.promise.then(
        (rows) => {
          if (disposed) return;
          if (first === mine) first = null;
          const bars = normalizeBars(rows);
          rememberPage(key, bars);
          const newest = bars[bars.length - 1];
          // A first request (re)starts the series in the library, so the
          // realtime guard restarts from its newest bar.
          if (newest) lastTime.set(key, newest.time);
          else lastTime.delete(key);
          for (const s of subs.values()) if (s.key === key) s.watchdog.noteHistory(newest?.time ?? null);
          emitStatus(key, { phase: bars.length ? 'ready' : 'empty', failures: 0, nextRetryAt: null, error: null });
          onResult(bars, historyMeta(bars));
        },
        (e) => {
          // Cancelled: the chart has moved to another series and will not
          // look at this request again. Anything else cannot happen - the
          // load retries - but is reported rather than swallowed.
          if (!disposed && !isCancelled(e)) onError(errorText(e));
        },
      );
    },

    subscribeBars(symbolInfo, resolution, onTick, listenerGuid, onResetCacheNeeded) {
      const interval = intervalForResolution(resolution);
      if (!interval) return;
      const { engine, name } = parseTicker(symbolInfo.ticker ?? symbolInfo.name, deps.defaultEngine());
      const key = seriesKey(engine, name, interval);
      dropSub(listenerGuid);
      const sub = {
        guid: listenerGuid,
        key,
        engine,
        name,
        interval,
        onTick,
        onReset: onResetCacheNeeded,
        health: 'live',
        why: '',
      } as Sub;
      sub.listen = () =>
        deps.subscribeCandles(engine, name, interval, (data) => {
          if (disposed || subs.get(listenerGuid) !== sub) return;
          for (const bar of candleToBars(data, name, interval)) {
            if (deliver(sub, bar)) sub.watchdog.noteTick(bar.time);
          }
        });
      sub.watchdog = new FeedWatchdog({
        intervalMs: intervalMsOf(interval) ?? 60_000,
        now,
        recover: (r) => recover(sub, r),
        onHealth: (h, why) => {
          sub.health = h;
          sub.why = why;
          emitHealth();
        },
      });
      subs.set(listenerGuid, sub);
      sub.unsub = sub.listen();
      if (stream !== null) sub.watchdog.noteStream(stream);
      sub.watchdog.noteVisible(visible);
      const tail = tails.get(key);
      const newest = tail?.[tail.length - 1];
      sub.watchdog.noteHistory(newest?.time ?? null);
      // Ticker baseline: this market's own last close (see FeedWatchdog.noteTicker).
      if (newest) sub.watchdog.noteTicker(newest.close);
    },

    unsubscribeBars(listenerGuid) {
      dropSub(listenerGuid);
      emitHealth();
    },

    primeSymbol(engine, sym) {
      known.set(knownKey(engine, sym.name), sym);
    },

    resetCache() {
      for (const s of subs.values()) s.onReset();
    },

    onStatus(cb) {
      statusCbs.add(cb);
      if (lastStatus) cb(lastStatus.key, lastStatus.view);
      return () => statusCbs.delete(cb);
    },

    onHealth(cb) {
      healthCbs.add(cb);
      if (lastHealth[1]) cb(lastHealth[0], lastHealth[1]);
      return () => healthCbs.delete(cb);
    },

    retryNow() {
      first?.handle.retryNow();
    },

    noteTicker(engine, symbol, price) {
      for (const s of subs.values()) if (s.engine === engine && s.name === symbol) s.watchdog.noteTicker(price);
    },

    noteStream(open) {
      stream = open;
      for (const s of subs.values()) s.watchdog.noteStream(open);
    },

    noteVisible(v) {
      visible = v;
      for (const s of subs.values()) s.watchdog.noteVisible(v);
    },

    check() {
      if (disposed) return;
      for (const s of subs.values()) s.watchdog.check();
    },

    dispose() {
      disposed = true;
      first?.handle.cancel();
      first = null;
      for (const guid of [...subs.keys()]) dropSub(guid);
      inflight.clear();
      statusCbs.clear();
      healthCbs.clear();
    },
  };
}
