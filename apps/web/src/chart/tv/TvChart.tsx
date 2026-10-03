/**
 * TradingView Advanced Charts in the chart panel.
 *
 * Mounted only by switch.tsx, and only when VITE_CHART=tradingview AND the
 * library files are present. Any failure here - the widget constructor
 * throwing, the browser refusing to frame the library's page, the chart never
 * becoming ready - calls `onFail`, and the switch puts the klinecharts chart
 * back. A broken integration costs a console warning, never an empty panel.
 *
 * What it shares with the klinecharts chart:
 *   - the same data paths and the same FAILSAFES (datafeed.ts, ../feedHealth):
 *     skeleton while loading, "Reconnecting…" / error + "Retry now" when the
 *     first page will not come, Live / Delayed in the footer, and gap-fills on
 *     a stalled stream, a hub reconnect and the tab becoming visible again
 *   - the same colours and fonts (theme.ts)
 *   - your resting orders and position entry as lines (lines.ts,
 *     lineManager.ts): the position line is locked and shows a live PnL; an
 *     order line can be DRAGGED when the host passes `onModifyOrder` and the
 *     session could modify it anyway (perps, unlocked). A drop opens a confirm;
 *     only the confirm calls `onModifyOrder`. Nothing is ever sent from here.
 *   - a Mark toggle (perps) and a Last-price toggle
 * See docs/TRADINGVIEW.md for what the paid Trading Platform would add.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { logger } from '../../log';
import { api, type Engine } from '../../api';
import { bumpAccountResource, useAccountResource } from '../../accountFeeds';
import { useChannel } from '../../hooks';
import { fmtPrice, fmtQty } from '../../format';
import type { ChartProps } from '../../components/Chart';
import { orderLines, positionLines } from '../orderOverlays';
import { intervalLabel } from '../intervals';
import type { FeedHealth } from '../feedHealth';
import { FEED_LOADING, FeedBadge, FeedOverlay, type FeedView } from '../FeedOverlay';
import { createDatafeed, type Datafeed } from './datafeed';
import { parseTicker, tickerOf } from './datafeedCore';
import { LIBRARY_PATH, loadTradingView } from './loader';
import { horizontalLineOptions, lineShapes, modifyRequestFor, type LineShape } from './lines';
import { LineManager } from './lineManager';
import { buildWidgetOptions, pickInterval } from './options';
import { createSaveLoadAdapter, safeLocalStorage, STORAGE_PREFIX } from './saveLoad';
import { browserDatafeedDeps, hubStreamOpen, onHubState } from './sources';
import {
  FALLBACK_PALETTE,
  collectFontFaceCss,
  cssProperties,
  primaryFamily,
  readPalette,
  type TvPalette,
} from './theme';
import type { EntityId, IChartWidgetApi, IChartingLibraryWidget } from './types';
import themeCssUrl from './tv-theme.css?url';
import './tv.css';

const log = logger('chart.tv');

/** Generous: first paint waits on symbol resolve + first history page, and
 *  the backend's weight queue can hold a request for a while. The datafeed's
 *  own retries keep going past it; this only catches a widget that never
 *  starts at all. */
const READY_TIMEOUT_MS = 30_000;
const MARK_THROTTLE_MS = 500;
const PNL_THROTTLE_MS = 500;
/** How long a submitted modify may go unconfirmed before the line goes back. */
const SETTLE_TIMEOUT_MS = 15_000;
const LAYOUT_NAME = 'ValueDesk';
const INTERVAL_KEY = `${STORAGE_PREFIX}interval`;
const TOGGLES_KEY = `${STORAGE_PREFIX}toggles`;
const FRAME_BLOCKED =
  'the browser refused to frame /charting_library/ (X-Frame-Options / frame-ancestors / frame-src) - see docs/TRADINGVIEW.md, "Headers"';

interface Toggles {
  mark: boolean;
  last: boolean;
}
const DEFAULT_TOGGLES: Toggles = { mark: true, last: true };

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a preference that does not persist is not an error */
  }
}
function readToggles(): Toggles {
  try {
    const v = JSON.parse(readStored(TOGGLES_KEY) ?? 'null') as Partial<Toggles> | null;
    return {
      mark: typeof v?.mark === 'boolean' ? v.mark : DEFAULT_TOGGLES.mark,
      last: typeof v?.last === 'boolean' ? v.last : DEFAULT_TOGGLES.last,
    };
  } catch {
    return DEFAULT_TOGGLES;
  }
}

/** Library calls are wrapped: a shape that TradingView already dropped (it
 *  clears a symbol's drawings on a symbol change) must not throw into React. */
function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function removeShape(chart: IChartWidgetApi | null, id: EntityId | null | undefined): void {
  if (chart && id) safe(() => chart.removeEntity(id));
}

/** The chart's current symbol as a ticker. `symbol()` returns a string on
 *  older builds and a LibrarySymbolInfo on current ones. */
function currentTicker(chart: IChartWidgetApi, fallbackEngine: Engine): string | null {
  const s = safe(() => chart.symbol?.());
  let raw: string | undefined;
  if (typeof s === 'string') raw = s;
  else if (s && typeof s === 'object') {
    const o = s as { ticker?: string; full_name?: string; name?: string };
    raw = o.ticker ?? o.full_name ?? o.name;
  }
  if (!raw) return null;
  const { engine, name } = parseTicker(raw, fallbackEngine);
  return tickerOf(engine, name);
}

/** Resolves when the library's iframe finishes loading; calls `blocked` if
 *  what loaded is not a document we can reach - which is what a framing
 *  refusal (X-Frame-Options: DENY on the dev server today) looks like. */
function watchFrame(el: HTMLElement, blocked: () => void): () => void {
  let frame: HTMLIFrameElement | null = null;
  const check = () => {
    try {
      if (!frame?.contentDocument) blocked();
    } catch {
      blocked();
    }
  };
  const attach = (f: HTMLIFrameElement) => {
    frame = f;
    f.addEventListener('load', check);
  };
  const first = el.querySelector('iframe');
  if (first) attach(first);
  const mo = new MutationObserver(() => {
    if (frame) return;
    const f = el.querySelector('iframe');
    if (f) attach(f);
  });
  mo.observe(el, { childList: true, subtree: true });
  return () => {
    mo.disconnect();
    frame?.removeEventListener('load', check);
  };
}

/** Copy the app's font faces into the chart frame - see collectFontFaceCss. */
function adoptFonts(el: HTMLElement, p: TvPalette): void {
  const doc = safe(() => el.querySelector('iframe')?.contentDocument ?? null);
  if (!doc || doc.querySelector('style[data-vs-fonts]')) return;
  const css = collectFontFaceCss(
    document.styleSheets,
    [primaryFamily(p.fontText), primaryFamily(p.fontNum)],
    location.href,
  );
  if (!css) return;
  const style = doc.createElement('style');
  style.dataset.vsFonts = '';
  style.textContent = css;
  doc.head.appendChild(style);
}

/** "BTC-USD · 1m" from a datafeed series key ("perps|BTC-USD|1m"). */
function seriesLabel(key: string, fallback: string): string {
  const [, name, interval] = key.split('|');
  return name && interval ? `${name} · ${intervalLabel(interval)}` : fallback;
}

export interface TvChartProps extends ChartProps {
  /** Called once, with a reason, when this chart cannot work. */
  onFail: (reason: string) => void;
  /** Lets a symbol picked inside the chart drive the app. Without it the
   *  chart's own symbol search is disabled so the two cannot drift apart. */
  onSymbolChange?: (engine: Engine, symbol: string) => void;
}

/** A drag the user has not confirmed, or a modify the venue has not echoed. */
interface Move {
  shape: LineShape;
  price: string;
}

export function TvChart({
  engine,
  symbol,
  sym,
  address = null,
  unlocked = false,
  refreshToken = 0,
  lastPrice,
  onChanged,
  onModifyOrder,
  onFail,
  onSymbolChange,
}: TvChartProps) {
  const holder = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<IChartingLibraryWidget | null>(null);
  const feedRef = useRef<Datafeed | null>(null);
  const paletteRef = useRef<TvPalette>(FALLBACK_PALETTE);
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const initial = useRef({ engine, symbol, sym });
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;
  const onSymbolRef = useRef(onSymbolChange);
  onSymbolRef.current = onSymbolChange;
  const searchable = useRef(!!onSymbolChange).current;
  const tickRef = useRef(sym?.tickSize);
  tickRef.current = sym?.tickSize;

  /** Ticker the app asked for last. */
  const applied = useRef('');
  const [ready, setReady] = useState(false);
  const [headerReady, setHeaderReady] = useState(false);
  /** Ticker the chart has FINISHED switching to. Shapes wait for it, or they
   *  would be drawn onto the symbol being left and vanish with it. */
  const [settled, setSettled] = useState('');
  const [toggles, setToggles] = useState<Toggles>(readToggles);
  const toggleEls = useRef<{ mark?: HTMLElement; last?: HTMLElement }>({});

  // --- feed failsafes ---------------------------------------------------------
  const [feed, setFeed] = useState<FeedView & { key: string }>({ key: '', ...FEED_LOADING });
  const [health, setHealth] = useState<{ health: FeedHealth; why: string }>({
    health: 'live',
    why: 'Live: candles are streaming from the venue.',
  });

  // --- DIY order lines --------------------------------------------------------
  const [pending, setPending] = useState<Move | null>(null);
  const [awaiting, setAwaiting] = useState<Move | null>(null);
  const [sending, setSending] = useState(false);
  const [lineMsg, setLineMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const settleTimer = useRef(0);

  const chartApi = useCallback((): IChartWidgetApi | null => {
    const w = widgetRef.current;
    return w ? (safe(() => w.activeChart()) ?? null) : null;
  }, []);

  const onMoveRef = useRef<(shape: LineShape, price: string) => void>(() => undefined);
  const lines = useMemo(
    () =>
      new LineManager({
        chart: () => chartApi(),
        tickSize: () => tickRef.current,
        onMove: (shape, price) => onMoveRef.current(shape, price),
      }),
    [chartApi],
  );
  // clear(), not dispose(): StrictMode runs this cleanup once on mount, and the
  // manager (held by useMemo) has to keep working after it.
  useEffect(() => () => lines.clear(), [lines]);

  // --- create the widget once ------------------------------------------------
  useEffect(() => {
    let disposed = false;
    let failed = false;
    let readyTimer = 0;
    let stopWatch: () => void = () => undefined;
    const fail = (why: string) => {
      if (disposed || failed) return;
      failed = true;
      onFailRef.current(why);
    };

    const feed = createDatafeed(
      browserDatafeedDeps(
        () => engineRef.current,
        // A hole in the middle of the bars: the datafeed has already told the
        // library to drop its cache; this makes it re-read now.
        () => safe(() => chartApi()?.resetData?.()),
      ),
    );
    feedRef.current = feed;
    if (initial.current.sym) feed.primeSymbol(initial.current.engine, initial.current.sym);
    const stopStatus = feed.onStatus((key, view) => setFeed({ key, ...view }));
    const stopHealth = feed.onHealth((h, why) => setHealth({ health: h, why }));
    const stopHub = onHubState(() => feed.noteStream(hubStreamOpen(engineRef.current)));
    const onVis = () => feed.noteVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    const checkTimer = window.setInterval(() => feed.check(), 5_000);

    void loadTradingView().then((r) => {
      if (disposed) return;
      if (!r.ok) return fail(r.reason);
      const el = holder.current;
      if (!el) return;
      const palette = readPalette((v) => getComputedStyle(document.documentElement).getPropertyValue(v));
      paletteRef.current = palette;

      const ticker = tickerOf(initial.current.engine, initial.current.symbol);
      applied.current = ticker;
      let widget: IChartingLibraryWidget;
      try {
        widget = new r.tv.widget(
          buildWidgetOptions({
            container: el,
            libraryPath: LIBRARY_PATH,
            datafeed: feed,
            ticker,
            interval: pickInterval(readStored(INTERVAL_KEY)),
            palette,
            customCssUrl: new URL(themeCssUrl, location.href).href,
            saveLoad: createSaveLoadAdapter(safeLocalStorage()),
            allowSymbolSearch: searchable,
          }),
        );
      } catch (e) {
        return fail(`widget constructor threw: ${(e as Error).message}`);
      }
      widgetRef.current = widget;
      stopWatch = watchFrame(el, () => fail(FRAME_BLOCKED));
      readyTimer = window.setTimeout(
        () => fail(`chart not ready after ${READY_TIMEOUT_MS / 1000}s`),
        READY_TIMEOUT_MS,
      );

      const applyCss = () => {
        if (typeof widget.setCSSCustomProperty !== 'function') return;
        for (const [k, v] of Object.entries(cssProperties(palette))) safe(() => widget.setCSSCustomProperty?.(k, v));
      };

      widget
        .headerReady()
        .then(() => {
          if (disposed) return;
          applyCss();
          const make = (label: string, title: string, key: keyof Toggles) => {
            const b = safe(() => widget.createButton({ align: 'left' }));
            if (!b) return undefined;
            b.textContent = label;
            b.title = title;
            b.classList.add('vs-tv-toggle');
            b.setAttribute('role', 'button');
            b.addEventListener('click', () => {
              if (b.getAttribute('aria-disabled') === 'true') return;
              setToggles((t) => ({ ...t, [key]: !t[key] }));
            });
            return b;
          };
          toggleEls.current = {
            last: make('Last', 'Last traded price line', 'last'),
            mark: make('Mark', 'Mark price line (perps)', 'mark'),
          };
          setHeaderReady(true);
        })
        .catch(() => undefined);

      widget.onChartReady(() => {
        if (disposed) return;
        window.clearTimeout(readyTimer);
        applyCss();
        safe(() => adoptFonts(el, palette));
        const chart = safe(() => widget.activeChart());
        if (chart) {
          safe(() =>
            chart.onIntervalChanged().subscribe(null, (res) => writeStored(INTERVAL_KEY, String(res))),
          );
          if (searchable) {
            safe(() =>
              chart.onSymbolChanged?.().subscribe(null, () => {
                const t = currentTicker(chart, engineRef.current);
                if (!t || t === applied.current) return;
                applied.current = t;
                setSettled(t);
                const { engine: e, name } = parseTicker(t, engineRef.current);
                onSymbolRef.current?.(e, name);
              }),
            );
          }
        }
        // A dragged order line is read back here (lineManager.ts).
        safe(() =>
          widget.subscribe('drawing_event', (id, type) => lines.handleDrawingEvent(id as EntityId, String(type))),
        );
        // Drawings persist through the save/load adapter: the library asks for
        // a save a few seconds after every change.
        safe(() =>
          widget.subscribe('onAutoSaveNeeded', () =>
            safe(() => widget.saveChartToServer(undefined, undefined, { defaultChartName: LAYOUT_NAME })),
          ),
        );
        // `load_last_chart` may have restored a layout on another symbol;
        // clearing this makes the symbol effect put the app's symbol back.
        applied.current = '';
        setReady(true);
      });
    });

    return () => {
      disposed = true;
      window.clearTimeout(readyTimer);
      window.clearInterval(checkTimer);
      document.removeEventListener('visibilitychange', onVis);
      stopWatch();
      stopHub();
      stopStatus();
      stopHealth();
      const w = widgetRef.current;
      widgetRef.current = null;
      if (w) safe(() => w.remove());
      feed.dispose();
      feedRef.current = null;
    };
  }, [chartApi, searchable, lines]);

  // The last traded price tells the watchdog whether the market is trading.
  useEffect(() => {
    feedRef.current?.noteTicker(engine, symbol, lastPrice);
  }, [engine, symbol, lastPrice]);

  // --- follow the app's symbol ----------------------------------------------
  useEffect(() => {
    if (!ready) return;
    if (sym) feedRef.current?.primeSymbol(engine, sym);
    const chart = chartApi();
    const t = tickerOf(engine, symbol);
    if (!chart || applied.current === t) return;
    applied.current = t;
    if (currentTicker(chart, engine) === t) {
      setSettled(t);
      return;
    }
    Promise.resolve(safe(() => chart.setSymbol(t))).then(
      () => {
        if (applied.current === t) setSettled(t);
      },
      (e) => log.warn('setSymbol failed', { ticker: t, error: e }),
    );
  }, [ready, engine, symbol, sym, chartApi]);

  const current = tickerOf(engine, symbol);
  const onSymbol = ready && settled === current;

  // --- Last / Mark toggles ----------------------------------------------------
  useEffect(() => {
    writeStored(TOGGLES_KEY, JSON.stringify(toggles));
    const { mark, last } = toggleEls.current;
    last?.setAttribute('aria-pressed', String(toggles.last));
    mark?.setAttribute('aria-pressed', String(toggles.mark && engine === 'perps'));
    mark?.setAttribute('aria-disabled', String(engine !== 'perps'));
    if (mark) mark.title = engine === 'perps' ? 'Mark price line' : 'Spot markets have no mark price';
    if (ready) {
      safe(() => widgetRef.current?.applyOverrides({ 'mainSeriesProperties.showPriceLine': toggles.last }));
    }
  }, [ready, headerReady, toggles, engine]);

  const markWanted = onSymbol && toggles.mark && engine === 'perps';
  const markPx = useRef(0);
  const markShape = useRef<{ id: EntityId | null; creating: boolean }>({ id: null, creating: false });
  const markTimer = useRef(0);

  const drawMark = useCallback(async () => {
    markTimer.current = 0;
    const chart = chartApi();
    const price = markPx.current;
    if (!chart || !(price > 0)) return;
    const time = Math.floor(Date.now() / 1000);
    const m = markShape.current;
    if (m.id) {
      const shape = safe(() => chart.getShapeById(m.id as EntityId));
      if (shape && safe(() => (shape.setPoints([{ time, price }]), true))) return;
      m.id = null; // dropped by the library - draw a new one
    }
    if (m.creating) return;
    m.creating = true;
    try {
      const p = paletteRef.current;
      const id = await Promise.resolve(
        chart.createMultipointShape(
          [{ time, price }],
          horizontalLineOptions({ key: 'mark', price, text: 'Mark', color: p.muted, dashed: true }),
        ),
      );
      if (markShape.current !== m) removeShape(chart, id); // switched off meanwhile
      else m.id = id ?? null;
    } catch {
      /* the chart may be mid symbol change; the next tick retries */
    } finally {
      m.creating = false;
    }
  }, [chartApi]);

  useEffect(() => {
    if (!markWanted) return;
    const slot = { id: null as EntityId | null, creating: false };
    markShape.current = slot;
    return () => {
      window.clearTimeout(markTimer.current);
      markTimer.current = 0;
      markPx.current = 0;
      removeShape(chartApi(), slot.id);
      markShape.current = { id: null, creating: false };
    };
  }, [markWanted, current, chartApi]);

  useChannel('perps', markWanted ? { channel: 'markPrice', symbols: [symbol] } : null, (d) => {
    const row = Array.isArray(d) ? d.find((e: { s?: string }) => e?.s === symbol) : d;
    const price = Number(row?.p ?? row?.markPrice);
    if (!(price > 0)) return;
    markPx.current = price;
    if (!markTimer.current) {
      markTimer.current = window.setTimeout(() => void drawMark(), markShape.current.id ? MARK_THROTTLE_MS : 0);
    }
  });

  // --- your orders and position -----------------------------------------------
  // Same shared feeds and keys as the klinecharts chart (accountFeeds.ts), so
  // the Open orders / Positions panels and this chart share one poll.
  const ordersKey = address ? `orders:${engine}:${address}` : null;
  const orders = useAccountResource(ordersKey, () => api.openOrders(engine, address!), 10_000);
  const posKey = address && engine === 'perps' ? `pos:${address}` : null;
  const positions = useAccountResource(posKey, () => api.positions(address!), 10_000);
  const refreshOrders = orders.refresh;
  const refreshPositions = positions.refresh;
  useEffect(() => {
    refreshOrders();
    refreshPositions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);
  const onAccountEvent = useCallback(() => {
    bumpAccountResource(ordersKey);
    bumpAccountResource(posKey);
  }, [ordersKey, posKey]);
  useChannel(engine, address ? { channel: 'accountOrderUpdate', user: address } : null, onAccountEvent);
  useChannel(engine, address ? { channel: 'accountTrade', user: address } : null, onAccountEvent);

  /** The same two gates the klinecharts chart applies, plus the one only this
   *  chart has: a host that handed over its modify path. */
  const modifyBlocked =
    !unlocked
      ? 'Read-only - unlock a signing key to move orders from the chart.'
      : !onModifyOrder
        ? 'Moving orders from the TradingView chart is not wired up here - move them from Open orders.'
        : null;
  const canModify = modifyBlocked === null;

  const wanted = useMemo(() => {
    const rawOrders = address ? (orders.data?.orders ?? []) : [];
    const rawPositions = address && engine === 'perps' ? (positions.data?.positions ?? []) : [];
    const opts = { symbol, sym, canModify, ...(modifyBlocked === null ? {} : { cannotModifyReason: modifyBlocked }) };
    return lineShapes([...orderLines(rawOrders, opts), ...positionLines(rawPositions, opts)], paletteRef.current);
    // `ready` re-derives once the palette has been read from the live tokens.
  }, [ready, address, engine, symbol, sym, orders.data, positions.data, canModify, modifyBlocked]);

  useEffect(() => {
    if (onSymbol) lines.sync(wanted);
  }, [onSymbol, wanted, lines]);

  // Leaving a symbol: the library drops that symbol's drawings itself.
  useEffect(() => () => lines.forget(), [current, lines]);

  // Live PnL on the position line, rewritten in place - at most twice a second.
  const pnlTimer = useRef(0);
  const pnlArgs = useRef<{ last?: string; quote?: string }>({});
  pnlArgs.current = { ...(lastPrice ? { last: lastPrice } : {}), ...(sym?.quoteCoin ? { quote: sym.quoteCoin } : {}) };
  useEffect(() => {
    if (!onSymbol || pnlTimer.current) return;
    pnlTimer.current = window.setTimeout(() => {
      pnlTimer.current = 0;
      lines.setLiveText(pnlArgs.current.last, pnlArgs.current.quote);
    }, PNL_THROTTLE_MS);
  }, [onSymbol, lastPrice, wanted, lines]);
  useEffect(() => () => window.clearTimeout(pnlTimer.current), []);

  // --- drag -> confirm -> the host's modify ------------------------------------
  const abandon = useCallback(
    (key: string) => {
      window.clearTimeout(settleTimer.current);
      lines.restore(key);
      setPending(null);
      setAwaiting(null);
    },
    [lines],
  );
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  onMoveRef.current = (shape, price) => {
    if (!canModify || !shape.line) {
      lines.restore(shape.key);
      if (modifyBlocked) setLineMsg({ kind: 'info', text: modifyBlocked });
      return;
    }
    setLineMsg(null);
    setAwaiting(null);
    setPending({ shape, price });
  };

  // Server truth moved under a pending or awaited move.
  useEffect(() => {
    const m = pending ?? awaiting;
    if (!m) return;
    const now = wanted.find((s) => s.key === m.shape.key);
    if (!now) {
      abandon(m.shape.key);
      setLineMsg({
        kind: 'err',
        text: `${m.shape.text} is no longer open - it filled or was cancelled. Nothing was sent.`,
      });
      return;
    }
    if (awaiting && now.price === Number(awaiting.price)) {
      window.clearTimeout(settleTimer.current);
      lines.release(awaiting.shape.key);
      setAwaiting(null);
      setLineMsg({ kind: 'ok', text: `Order moved. The venue reports it at ${fmtPrice(awaiting.price, sym?.tickSize)}.` });
    }
  }, [wanted, pending, awaiting, abandon, lines, sym?.tickSize]);

  // A market switch invalidates every price on screen, including a drag.
  useEffect(() => {
    window.clearTimeout(settleTimer.current);
    setPending(null);
    setAwaiting(null);
  }, [engine, symbol]);

  const cancelPending = useCallback(() => {
    if (pending) abandon(pending.shape.key);
  }, [pending, abandon]);

  /** The only path that leads to a send - and it is the HOST's callback. */
  const confirmPending = useCallback(async () => {
    const p = pending;
    if (!p?.shape.line) return;
    const body = modifyRequestFor(p.shape.line, p.price);
    // The gates are re-checked at the moment of sending: the session can
    // lock between a drop and a click.
    if (!body || !canModify || !onModifyOrder) {
      abandon(p.shape.key);
      setLineMsg({ kind: 'err', text: modifyBlocked ?? 'This line cannot be modified.' });
      return;
    }
    setSending(true);
    setPending(null);
    setAwaiting(p);
    try {
      await onModifyOrder(body);
      setLineMsg({ kind: 'info', text: `Modify submitted - waiting for the venue to confirm ${fmtPrice(p.price, sym?.tickSize)}.` });
      onChanged?.();
      refreshOrders();
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => {
        abandon(p.shape.key);
        setLineMsg({
          kind: 'err',
          text: `The venue has not reported the order at ${fmtPrice(p.price, sym?.tickSize)} yet. The line is back on the last confirmed price - check Open orders.`,
        });
      }, SETTLE_TIMEOUT_MS);
    } catch (e) {
      abandon(p.shape.key);
      setLineMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  }, [pending, canModify, onModifyOrder, modifyBlocked, abandon, sym?.tickSize, onChanged, refreshOrders]);

  // --- render ---------------------------------------------------------------------
  const view: FeedView = !ready ? (feed.phase === 'ready' ? FEED_LOADING : feed) : feed;
  const masked = !ready || view.phase !== 'ready';
  const label = seriesLabel(feed.key, `${sym?.displayName ?? symbol}`);
  const move = pending ?? awaiting;

  return (
    <section className="panel chart kc-panel tv-panel">
      <div className="tv-stage">
        <div ref={holder} className="tv-holder" />
        {/* Always rendered: while loading it shows the same text-free
            skeleton candles as the klinecharts chart, and at 'ready' it fades
            them out over the chart instead of cutting to it (FeedOverlay.tsx).
            The klinecharts chart goes further and MORPHS its skeleton into
            the loaded candles (CandleMorph.tsx); that is NOT possible here:
            this plot is drawn inside the library's iframe, where neither its
            canvas, its bar positions nor its price scale can be reached from
            this page, so there is nothing to morph into and the crossfade is
            the hand-over. `masked` stays true until the library reports its
            first bars, so the crossfade still starts on a drawn chart. */}
        <FeedOverlay view={view} label={label} onRetry={() => feedRef.current?.retryNow()} />
        {(move || lineMsg) && (
          <div className="kc-notices">
            {move && (
              <div className="kc-movebar">
                <span className="kc-movebar-title">{pending ? 'Move this order?' : 'Submitted'}</span>
                <span className="kc-readout">
                  <span className="muted">{fmtPrice(move.shape.line?.price ?? move.shape.price, sym?.tickSize)} →</span>
                  <span className="kc-v">{fmtPrice(move.price, sym?.tickSize)}</span>
                  {move.shape.line?.quantity && (
                    <span className="muted">size {fmtQty(move.shape.line.quantity, sym?.stepSize)}</span>
                  )}
                </span>
                {pending ? (
                  <>
                    <button className="btn-primary kc-confirm" onClick={() => void confirmPending()} disabled={sending}>
                      {sending ? 'Sending…' : 'Confirm - send live modify'}
                    </button>
                    <button onClick={cancelPending} disabled={sending}>
                      Cancel
                    </button>
                    <span className="muted">Nothing has been sent yet.</span>
                  </>
                ) : (
                  <span className="muted">Waiting for the venue. The line stays here until the order is confirmed.</span>
                )}
              </div>
            )}
            {lineMsg && (
              <p className={`status ${lineMsg.kind} kc-note`}>
                {lineMsg.text}{' '}
                <button className="link" onClick={() => setLineMsg(null)}>
                  dismiss
                </button>
              </p>
            )}
          </div>
        )}
      </div>
      <div className="tv-foot">
        {ready && view.phase === 'ready' ? (
          <FeedBadge health={health.health} why={health.why} />
        ) : (
          <span className="tv-note kc-hint">Loading chart…</span>
        )}
        {/* Attribution. Required by the Advanced Charts licence together
            with the logo inside the chart; do not remove. The link carries
            no rel="nofollow" - the licence asks for a followed link. */}
        <span className="tv-attrib">
          Chart by{' '}
          <a href="https://www.tradingview.com/" target="_blank" rel="noopener">
            TradingView
          </a>
        </span>
      </div>
    </section>
  );
}
