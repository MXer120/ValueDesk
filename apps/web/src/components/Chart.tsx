/**
 * Candlestick chart (klinecharts 10 — Apache-2.0, zero runtime deps).
 *
 * Replaces lightweight-charts. The reason for the swap is not the candles, it
 * is the overlay layer: klinecharts ships 27 indicators, ~16 drawing tools, and
 * — the part that matters most — overlays that emit drag events
 * (onPressedMoveStart / onPressedMoving / onPressedMoveEnd), which is what
 * drag-to-modify hangs off.
 *
 * ORDER INTERACTION lives half here and half in ../chart/orderOverlays.ts. The
 * split is deliberate: that file knows how to draw a line and how to snap a
 * price; this one owns every decision about whether anything is SENT. Three
 * rules hold that line, and none of them is optional on a screen that signs
 * real mainnet orders:
 *
 *   1. A drag never submits. Releasing the mouse opens a confirm box and
 *      nothing else; the modify goes out on an explicit click.
 *   2. What you see is what gets signed. The dragged price is snapped to the
 *      symbol's tick before it is displayed, and the displayed string is the
 *      one that goes on the wire.
 *   3. A line is never optimistic. Between "submitted" and "the venue agrees"
 *      it is drawn amber and labelled as unsent; on rejection, on the order
 *      being filled out from under the drag, or on the venue simply not
 *      confirming, it snaps back to the last price the server stated.
 *
 * Right-clicking a line is intercepted for a fourth reason: klinecharts' own
 * right-click handler DELETES the overlay by default, which on a stop-loss
 * would erase the line while the order kept resting at the venue.
 *
 * The data path is unchanged from the previous implementation: seeded from
 * REST /api/md/{engine}/klines, then updated live from the `candle` channel via
 * useChannel. What changed is the seam — v10 has no applyNewData/updateData;
 * history and live ticks both flow through a single `setDataLoader()` object,
 * so the REST fetch lives in `getBars` and the WS tick is handed to the
 * `subscribeBar` callback the library gives us.
 *
 * The library is imported dynamically so it lands in its own chunk and never
 * blocks first paint.
 */
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useLatched, usePresence } from './motion';
import { createPortal } from 'react-dom';
import type {
  AxisRange,
  CandleType,
  Chart as KChart,
  DataLoader,
  DataLoaderGetBarsParams,
  Indicator,
  IndicatorSeries,
  KLineData,
  Overlay,
  OverlayEvent,
  Point,
} from 'klinecharts';
import { api, type Engine, type Kline, type Symbol } from '../api';
import { bumpAccountResource, useAccountResource } from '../accountFeeds';
import { useAsync, useChannel, useStatus, useStored } from '../hooks';
import { fmtPct, fmtPrice, fmtQty, fmtQuote, num, precisionOf, signClass } from '../format';
import {
  AXIS_FONT_SIZE,
  AXIS_FONT_WEIGHT,
  CANDLE_PANE_ID,
  DEFAULT_BAR_SPACE,
  DEFAULT_OFFSET_RIGHT,
  NUM_FAMILY,
  chartStyles,
  createDenseYTicks,
  formatBigNumber,
  registerChartAxes,
  T,
  X_AXIS_NAME,
} from '../chart/theme';
import {
  clockText,
  crosshairLabel,
  intervalToMs,
  timeTicks,
  timestampLookup,
  utcOffsetLabel,
  type TimeZoneMode,
} from '../chart/timeAxis';
import { createVolumeTicks } from '../chart/volumeAxis';
import { decimalFoldOption, followNumStyle, thousandsSeparatorOption } from '../chart/klineNumbers';
import {
  DEFAULT_INDICATORS,
  INDICATOR_INFO,
  STORAGE_KEY as INDICATORS_KEY,
  indicatorShort,
  indicatorTitle,
  legendName,
  sanitizeSpecs,
  stylesFor,
  withSource,
  type IndicatorSpec,
} from '../chart/indicators';
import { IndicatorLegend } from '../chart/IndicatorLegend';
import { LIQ_HEAT, liqHeatTemplate } from '../chart/liqHeatIndicator';
import { LiqIndicatorFeed } from '../chart/liqIndicators';
import { LIQ_INDICATORS, liqMapTemplate } from '../chart/liqMap';
import { IndicatorSettings } from '../chart/IndicatorSettings';
import {
  DRAWING_OVERLAYS,
  NOTE,
  PATH,
  drawingStyles,
  finishDrawing,
  paintOf,
  registerDrawingOverlays,
} from '../chart/drawingOverlays';
import { drawingsKey, loadDrawings, parseDrawings, realZ, saveDrawings, setRealZ, toStored, type StoredDrawing } from '../chart/drawingStore';
import { DrawingStyleBar } from '../chart/DrawingStyleBar';
import { boxOf, marqueeHits, type Pt } from '../chart/marquee';
import { SelectionMarks } from '../chart/SelectionMarks';
import { DraftOrderLines } from '../chart/DraftOrderLines';
import { DrawingSettings, type DrawingDraft } from '../chart/DrawingSettings';
import {
  EXEC_OVERLAY,
  FLOW_PICK_OVERLAY,
  SHOW_KEY,
  SYSTEM_OVERLAYS,
  fillMarks,
  newsCoin,
  newsMarks,
  registerMarkOverlays,
  sanitizeShow,
  type ChartShow,
  calendarStories,
  newsKind,
  type FillMark,
  type NewsStory,
} from '../chart/chartMarks';
import { NewsMarkers } from '../chart/NewsMarkers';
import { NewsSettings } from '../chart/NewsSettings';
import { ChartSidebar } from '../chart/ChartSidebar';
import { CHART_ICONS } from '../chart/chartIcons';
import { candleAt, flowSpan } from './flow/flowWindow';
import {
  buildSnapshot,
  frozenFills,
  frozenPosition,
  registerLiveChart,
  snapshotFileName,
  snapshotFills,
  snapshotPosition,
  takePendingSnapshot,
  thumbOf,
  type ChartSnapshot,
  type LiveChart,
} from '../chart/snapshot';
import { ExportSheet } from '../chart/ExportSheet';
import { foldersAvailable, onBridgeChange, saveToFolder } from '../folders/bridge';
import { vsApi } from '../vsApi';
import { account as sodexAccount } from '../exchange/sodexAccount';
import { MENU_ICONS, TabMenu, type TabMenuItem } from '../dashboard/tabExtras';
import {
  INTERVAL_GROUPS,
  PERIOD_BY_INTERVAL,
  QUICK_INTERVALS,
  intervalLabel,
  intervalOf,
} from '../chart/intervals';
import {
  OrderLineLayer,
  orderLines,
  positionLines,
  registerOrderLineOverlay,
  snapToTick,
  type OrderLine,
  type OrderLineHandlers,
} from '../chart/orderOverlays';
import {
  MEASURE_OVERLAY,
  finishMeasure,
  registerMeasureOverlay,
} from '../chart/measureOverlay';
import { DrawingRail, overlayLabel, type MagnetMode } from '../chart/DrawingRail';
import { DepthView, MarketInfoView } from './MarketPanels';
import { withTradingView } from '../chart/tv/switch';
import { fetchKlineRows } from '../chart/klines';
import {
  FeedWatchdog,
  LOAD_TIMEOUT_MS,
  gapFillLimit,
  intervalMs,
  isFatalStatus,
  loadWithRetry,
  mergeBars,
  planMerge,
  retryDelayMs,
  type FeedHealth,
  type RecoverReason,
  type RecoverResult,
  type RetryHandle,
} from '../chart/feedHealth';
import { FEED_LOADING, FeedBadge, FeedOverlay, type FeedView } from '../chart/FeedOverlay';
import { CandleMorph, type CandleLayerState } from '../chart/CandleMorph';
import { ChartBoundary } from '../chart/ChartBoundary';
import {
  MORPH_HIDDEN,
  MORPH_HIDDEN_CANDLES,
  MORPH_SHOWN,
  badgeStyles,
  gridLines,
  MORPH_MS,
  morphable,
  prefersReducedMotion,
  type RGBA,
} from '../chart/morph';
import { dragAnywhere } from '../chart/dragAnywhere';
import { holdFrame } from '../chart/switchFrame';
import { captureAxis, type AxisHold } from '../chart/axisHandoff';
import { HistoryPager } from '../chart/historyPager';
import { HistoryReveal } from '../chart/historyReveal';
import { ViewTween, defaultView, readView } from '../chart/viewTween';
import {
  INITIAL_SCALE,
  PriceFit,
  holdRange,
  isAutoFit,
  resumeAutoFit,
  kindOf,
  pannedRange,
  priceAxis,
  scaleReducer,
  templateRange,
} from '../chart/yScale';
import { hub } from '../ws';
import '../chart/chart.css';
import { useLoadFailedToast } from './LoadFailed';
import { shownError } from './readState';
import { notify } from '../toast';
import { logger, recentLogs } from '../log';
import { plotViolation, readPlot, type Violation } from '../chart/invariant';
import { pollEvery } from '../exchange/visibility';

/** Who traded a candle (flow/TradeFlow.tsx): its own chunk, loaded when the panel is first opened. */
const TradeFlowView = lazy(() => import('./flow/TradeFlow').then((m) => ({ default: m.TradeFlowView })));

/** error = the user sees something broken; warn = degraded or recovering;
 *  info = lifecycle; debug = high-volume detail (`?debug=chart`). */
const log = logger('chart');

/** How much history to seed. Matches the previous implementation. */
const KLINE_LIMIT = 500;
/** Older bars per request when scrolling back (the backend's maximum) -
 *  and how many such pages are kept fetched ahead of the user
 *  (chart/historyPager.ts). */
const HISTORY_PAGE = 1000;
const HISTORY_AHEAD = 2;

/* VOLUME IS ON BY DEFAULT AGAIN - as a plain histogram, the way SoDEX and
 * TradingView open a chart. What once got it switched off was everything
 * around the bars: three moving averages, a "VOL(5,10,20) MA5/MA10/MA20"
 * legend line and a price-style scale reading 0.2000 / 0.1200 / 0.0400. The
 * default study now carries no MAs (chart/indicators.ts), its legend is one
 * "Volume 3.25035" row, and its pane has a 0-based compact scale
 * (chart/volumeAxis.ts). It is an ordinary study: hide, move, configure or
 * remove it like any other, and the choice is remembered. */

/** A new pane's share of the plot height, and its bounds. */
const PANE_SHARE = 0.2;
const PANE_HEIGHT_MIN = 40;
/** A pane whose studies are all hidden folds to its legend row. */
const PANE_FOLDED = 26;
const PANE_HEIGHT_MAX = 400;
/** Indicator panes are ordered after the candle pane (order 0). */
const PANE_ORDER_BASE = 10;

/* The price scale is the footer's `% A L`, left to right (chart/yScale.ts):
 *
 *   %  percentage scale, relative to the leftmost visible bar
 *   A  autoscale: the axis fits the candles on screen as the view moves. On by
 *      default; it goes off by itself when the user takes the axis - a drag or
 *      a scroll on the price axis, or a vertical drag on the plot - and the
 *      range then holds while the chart pans sideways.
 *   L  logarithmic scale
 *
 * % and L are klinecharts y-axis behaviours selected by the *name* of a
 * registered axis ('percentage', 'logarithm'; neither = 'normal'), and exclude
 * each other. */

/** How far a drag on the plot has to go vertically - and more vertically than
 *  sideways - before it pans the price axis and switches A off. One pixel, per
 *  the owner: a vertical drag moves the axis from its first pixel. The
 *  "more vertical than sideways" half of the rule still keeps a horizontal
 *  pan's wobble from switching A off. */
const V_PAN_PX = 1;
/** Below this card width Who traded sits under the plot, not beside it. */
const FLOW_UNDER_PX = 640;

/**
 * The toolbar's views. Chart is the klinecharts canvas this file has always
 * owned; the other two render MarketPanels.tsx components fed by data this
 * app already fetches for every listed symbol - the deep order book (Depth)
 * and the symbol's own trading rules (Market info).
 */
const VIEWS = [
  { id: 'chart', label: 'Chart' },
  { id: 'depth', label: 'Depth' },
  { id: 'market', label: 'Market info' },
] as const;
type ViewId = (typeof VIEWS)[number]['id'];

/** How the price series is drawn. Every one of these is a `CandleType` the
 *  installed build renders natively — nothing here is a mode we implement
 *  ourselves, so the menu cannot offer a style the canvas will not paint. */
const CANDLE_STYLES: { id: CandleType; label: string }[] = [
  { id: 'candle_solid', label: 'Candles' },
  { id: 'candle_stroke', label: 'Hollow candles' },
  { id: 'ohlc', label: 'Bars' },
  { id: 'area', label: 'Line' },
];

/* --- toolbar glyphs --------------------------------------------------------
   Hand-written on the same 24x24 grid the drawing rail uses, drawn with
   `currentColor` so the whole hover/active model is one CSS `color` property.

   Drawn at 20px, not 16. Measured against the reference, its toolbar icons
   carry 16-17px of ink; ours carried 12-14 and sat a whole step below the
   14px text beside them, which is what made the strip read as two rows of
   different importance rather than one. The grid moved from 16 to 24 with the
   size bump so the strokes stay ~1.25px instead of thickening to 1.6. */
const SVG = {
  viewBox: '0 0 24 24',
  width: 20,
  height: 20,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
} as const;

/**
 * The overflow caret. A STROKED chevron, and a real element rather than the
 * '⌄' character it replaces: that glyph carries its own font metrics, which
 * sat its ink 5px below the centreline of the timeframe labels next to it and
 * gave the toolbar two competing baselines. An SVG box centres like a box.
 *
 * IT HAS ITS OWN GRID, and that is the fix rather than a tidy-up. Squeezing the
 * shared 24-unit viewBox into a 14px box scales the stroke down with it: 1.5
 * units became 0.875 device px, so the caret could not reach the token colour
 * however it was aligned — measured, it topped out at #423b3b against the
 * #544a4c of the '1D' label two pixels to its left, and read as a fainter rank
 * of control than the thing it belongs to. A 12-unit grid drawn at 12px is 1:1
 * with the screen, so the stroke below is stated in real device pixels.
 *
 * 1.25px, matching the rest of the strip, and NOT the 1px the fullscreen
 * brackets use. That is not an inconsistency, it is what a diagonal costs: an
 * axis-aligned 1px stroke can own a whole pixel column, but a sloped one is
 * spread across the width of its own slope, so a 1px diagonal tops out around
 * 80% of the token however it is placed. 1.25 on this 4:3 chevron puts just
 * over two pixels of ink on each scanline, which saturates the middle one —
 * the same reason the toolbar's other glyphs already reach #544a4c. */
const chevron = {
  ...SVG,
  viewBox: '0 0 12 12',
  width: 12,
  height: 12,
  strokeWidth: 1.25,
} as const;
const ChevronIcon = (
  <svg {...chevron}>
    <path d="M3 4.5 6 8l3-3.5" />
  </svg>
);

/** Series style. THREE FILLED candlesticks with wicks, not two hollow outlines:
 *  measured, the reference's glyph is three solid bodies across 16px, and the
 *  outlined pair we drew read as a pair of empty boxes at this size — the one
 *  icon in the strip whose whole job is to say "candles" did not look like
 *  candles. Filled, so it carries the same ink weight as its neighbours. */
const StyleIcon = (
  <svg {...SVG}>
    <path d="M4.75 4v16M12 2.5v19M19.25 5.5v13" />
    <path
      d="M2.75 8h4v8h-4zM10 6.5h4v11h-4zM17.25 9.5h4v5h-4z"
      fill="currentColor"
      stroke="none"
    />
  </svg>
);
/** Indicators. An `fx` mark, matching the reference — a function applied to the
 *  series, which is what an indicator is, rather than the generic line-chart
 *  squiggle that could equally mean "chart". Drawn narrow (10px of ink, the
 *  measured reference width) so it reads as a typographic mark sitting next to
 *  the word it labels rather than as a third icon button. */
const IndicatorIcon = (
  <svg {...SVG}>
    <path d="M9 20c0-9.5.3-13.5 2.6-14.5.7-.3 1.4-.2 1.9.2" />
    <path d="M7 12.5h5" />
    <path d="M14.5 15 18.5 19.5M18.5 15 14.5 19.5" />
  </svg>
);
/**
 * Fullscreen. FOUR CORNER BRACKETS ON A 1:1 GRID, and the grid is the point.
 *
 * This glyph is nothing but axis-aligned hairlines, which makes it the strictest
 * test of the toolbar's rendering in the whole strip — and it was failing it.
 * The shared 24-unit viewBox drawn into a 20px box scales a 1.5-unit stroke to
 * 1.25 device px and puts every coordinate on a fraction, so each arm spread
 * across two columns at partial coverage: measured, this one control topped out
 * at #463e3e while every neighbour (the candle icon, the fit/zoom/goto trio, the
 * Depth/Margin/Market info tabs) sat at a full #544a4c. One faded button beside
 * correctly-valued siblings reads as a bug, not as a design.
 *
 * So: a 20-unit grid drawn at 20px, a 1px stroke, integer coordinates, and a
 * viewBox origin of -0.5 so those integers land on pixel CENTRES rather than on
 * the boundaries between pixels. Geometry follows the measured reference — ink
 * spans 16x16, arms are 5px, and the clear cross through the middle is 6px.
 *
 * The corners are ARCS, not mitres. `strokeLinejoin: round` does nothing at a
 * 1px stroke — there is no join width to round — so the brackets came out
 * square against the reference's visibly curved ones, which is the difference
 * between a crop mark and a viewport. A 2-unit radius is what the reference's
 * corner profile measures.
 */
const fsIcon = {
  ...SVG,
  viewBox: '-0.5 -0.5 20 20',
  width: 20,
  height: 20,
  strokeWidth: 1,
} as const;
const FullscreenIcon = (
  <svg {...fsIcon}>
    <path d="M2 6V4a2 2 0 0 1 2-2h2M13 2h2a2 2 0 0 1 2 2v2M17 13v2a2 2 0 0 1-2 2h-2M6 17H4a2 2 0 0 1-2-2v-2" />
  </svg>
);
const ExitFullscreenIcon = (
  <svg {...fsIcon}>
    <path d="M2 6h2a2 2 0 0 0 2-2V2M17 6h-2a2 2 0 0 1-2-2V2M17 13h-2a2 2 0 0 0-2 2v2M2 13h2a2 2 0 0 1 2 2v2" />
  </svg>
);

interface ActiveIndicator {
  id: string;
  name: string;
  series: IndicatorSeries;
  /** 'candle_pane' for price-series overlays, else the pane created for it. */
  paneId: string;
  visible: boolean;
  /** A scale of its own, unseen, when the study shares a pane it does not
   *  own - so RSI over the volume bars keeps 0-100 and the bars keep theirs. */
  yAxisId?: string;
  /** What the user set - the thing that is stored and re-mounted. */
  spec: IndicatorSpec;
}

/** One row of the chart's right-click menus: the app's own menu item. */
type ChartMenuItem = TabMenuItem;

/** The tools that carry words, and the words they start with. */
const DEFAULT_TEXT = new Map<string, string>([
  ['simpleAnnotation', 'Text'],
  [NOTE, 'Note'],
]);
const TEXT_TOOLS = new Set(['simpleAnnotation', 'simpleTag', NOTE]);

/** What the armed-tool hint says, for the tools that are not drawn by clicks. */
const DRAW_HINT = new Map<string, string>([
  ...DRAWING_OVERLAYS.map((d) => [d.name, d.hint] as const),
  [MEASURE_OVERLAY, 'drag across the chart'],
  ['brush', 'drag across the chart'],
]);

const toKLineData = (k: Kline): KLineData => ({
  timestamp: k.t,
  open: +k.o,
  high: +k.h,
  low: +k.l,
  close: +k.c,
  volume: +k.v,
  turnover: +k.q,
});

/**
 * Raw gateway rows -> ascending, de-duplicated bars. The gateway answers
 * newest-first; klinecharts needs ascending time. A row with a non-number in
 * a price is dropped: one NaN poisons the autoscale for the whole range.
 */
function toRows(raw: readonly unknown[]): KLineData[] {
  const byTime = new Map<number, KLineData>();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const bar = toKLineData(r as Kline);
    bar.timestamp = Number((r as Kline).t);
    if (![bar.timestamp, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) || bar.timestamp <= 0) continue;
    byTime.set(bar.timestamp, bar);
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** The shape feedHealth's merge reads, carrying the chart's own row along. */
const asBar = (k: KLineData) => ({
  time: k.timestamp,
  open: k.open,
  high: k.high,
  low: k.low,
  close: k.close,
  ...(Number.isFinite(k.volume) ? { volume: k.volume as number } : {}),
  row: k,
});

/** Which series a load or a live candle belongs to. */
const feedKey = (engine: string, symbol: string, interval: string): string => `${engine}|${symbol}|${interval}`;

/** Which price the candles show. */
type PriceSource = 'latest' | 'mark' | 'index';
const SOURCE_LABEL: Record<PriceSource, string> = { latest: 'Latest', mark: 'Mark', index: 'Index' };
const SOURCE_HINT: Record<PriceSource, string> = {
  latest: 'Candles of the last traded price on SoDEX',
  mark: 'Candles of the mark price - what PnL and liquidation are measured against',
  index: 'Candles of the index price - the weighted average of external spot prices',
};
/** SoDEX's price-data series start at 5m, and skip 8h and 3D. */
const NO_MARK_INDEX = new Set(['1m', '3m', '8h', '3D']);

/** Why Mark / Index cannot be shown on this chart, in one sentence. */
function markIndexNotice(engine: Engine, interval: string): string {
  if (engine !== 'perps') return 'Mark and index prices exist for perpetuals only.';
  if (interval === '1m' || interval === '3m') {
    return `Mark and index aren't on the ${intervalLabel(interval)} chart. Switch to 5m or higher.`;
  }
  return `Mark and index aren't published for ${intervalLabel(interval)}. Switch to 5m or another supported timeframe.`;
}

/** Hub socket open AND the venue stream behind it for this engine. */
const streamOpen = (engine: Engine): boolean =>
  hub.state === 'open' && (hub.upstream[engine] ?? 'open') === 'open';

interface Series {
  key: string;
  engine: Engine;
  symbol: string;
  interval: string;
}

/** How long to wait for the venue to report a submitted modify before giving up
 *  and putting the line back on the last confirmed price. Generous enough for a
 *  10s poll plus a round trip; short enough that a silently-dropped modify does
 *  not leave a pending line on screen indefinitely. */
const SETTLE_TIMEOUT_MS = 15_000;

/** How long a touch is held to open the chart's menu - the news button's long press too. */
const LONG_PRESS_MS = 500;

export interface ChartProps {
  engine: Engine;
  symbol: string;
  sym?: Symbol;
  /**
   * Optional escape hatch for features that need the live chart instance.
   * Called with the instance once it exists and with null on teardown.
   */
  onChartReady?: (chart: KChart | null) => void;
  /**
   * The chart and its controls only - timeframes, scroll, zoom, the scales, the clock - with
   * nothing of the user's on it: no drawings, studies, news, fills or order lines, and none of
   * their settings touched (the liquidation heatmap's historical view draws its cells on it).
   * Always the traded price (no Latest / Mark / Index switch) and the chart view only (no
   * Depth or Market info).
   */
  bare?: boolean;

  // --- order lines ----------------------------------------------------------
  // All optional: the chart renders candles perfectly well without any of them,
  // and a caller that passes none simply gets no order layer.

  /** Wallet selected in the UI. Drives the order/position READS the lines come
   *  from. Without it there is nothing to draw and nothing is fetched. */
  address?: string | null;
  /** False = read-only. Lines are still drawn (reading your own resting orders
   *  is not a write), but nothing can be dragged and the right-click menu does
   *  not open — a read-only session must not offer actions it cannot take. */
  unlocked?: boolean;
  /** Bumped by the app whenever account state changed elsewhere. */
  refreshToken?: number;
  /** Tell the app an order moved, so the other panels re-read. */
  onChanged?: () => void;
  /** Prefill the shared order-ticket price. Never submits anything. */
  onPrice?: (p: string) => void;
  /** Last traded price, for the distance readout while dragging - and the
   *  feed watchdog's "is the market trading?" signal. */
  lastPrice?: string;
  /**
   * The app's modify-order path, for the TradingView chart's DIY order lines
   * (chart/tv/, behind VITE_CHART=tradingview). That chart never sends
   * anything itself: a dragged line becomes a confirm, and only the confirm
   * calls this. Without it the TradingView lines stay read-only. The
   * klinecharts chart does not use it.
   */
  onModifyOrder?: (body: Record<string, unknown>) => Promise<unknown>;
}

/** A price the user dragged to and has not sent. Held here, never on the wire. */
interface PendingMove {
  line: OrderLine;
  price: string;
}

/* VITE_CHART=tradingview swaps in TradingView Advanced Charts when its files are
   installed in public/charting_library/ (chart/tv/, docs/TRADINGVIEW.md). With
   the flag unset - the default - withTradingView returns `Chart` itself, so the
   export below IS this component, unchanged. */
/** How long a view-control move takes: the tween's own duration, or a
 *  one-frame cut when the user asked for less motion. */
const viewMs = (): number | undefined => (prefersReducedMotion() ? 0 : undefined);

const ChartOrTradingView = withTradingView(Chart);

/** The chart behind its own error boundary (chart/ChartBoundary.tsx): a crash
 *  stays inside the chart card instead of taking its panel with it. */
function GuardedChart(props: ChartProps) {
  return (
    <ChartBoundary>
      <ChartOrTradingView {...props} />
    </ChartBoundary>
  );
}
export { GuardedChart as Chart };

/**
 * Wall clock for the chart's footer strip, in the chart's zone.
 *
 * It used to be UTC while the axis above it was drawn in the browser's local
 * time, so the footer and the last candle disagreed by the zone offset. Both
 * now read `tz`, the footer names the zone ("UTC" or "UTC+2", as SoDEX's chart
 * does), and a click on it switches.
 *
 * Its own component: the tick a second re-renders these few characters, not the
 * whole chart (it did until 2026-11-01, once a second on every open chart). A
 * tick that lands during a view move still waits for the move to end.
 */
function ChartClock({ tz, moving, afterMove }: { tz: TimeZoneMode; moving: { current: boolean }; afterMove: { current: Array<() => void> } }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = window.setInterval(() => {
      if (moving.current) afterMove.current.push(tick);
      else tick();
    }, 1000);
    return () => window.clearInterval(id);
  }, [moving, afterMove]);
  return <>{clockText(now, tz)} {tz === 'utc' ? 'UTC' : `(${utcOffsetLabel(now)})`}</>;
}

function Chart({
  engine, symbol, sym, onChartReady, bare = false,
  address = null, unlocked = false, refreshToken = 0, onChanged, onPrice, lastPrice,
}: ChartProps) {
  const root = useRef<HTMLElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const chart = useRef<KChart | null>(null);
  const lib = useRef<typeof import('klinecharts') | null>(null);
  /** The price axis' createRange wrapper and the y half of a move
   *  (chart/yScale.ts). */
  const fit = useRef<PriceFit | null>(null);
  fit.current ??= new PriceFit();
  /** A move is running: work the frames can do without (the legend, the
   *  clock) waits for it to end. */
  const moving = useRef(false);
  const afterMove = useRef<Array<() => void>>([]);
  /** Every programmatic view change - double-click reset, jump to latest, the
   *  zoom buttons, A switching back on - is one smooth move, x and y together
   *  (chart/viewTween.ts). */
  const tween = useRef<ViewTween | null>(null);
  tween.current ??= new ViewTween(() => chart.current, fit.current, (m) => {
    moving.current = m;
    if (m) return;
    const queued = afterMove.current;
    afterMove.current = [];
    for (const run of queued) run();
  });

  /** Set by the library's `subscribeBar`, cleared by `unsubscribeBar`. Doubles
   *  as the "history for the CURRENT symbol+period is loaded" flag — see the
   *  stale-tick guard below. */
  const pushBar = useRef<((d: KLineData) => void) | null>(null);
  const lastBar = useRef<KLineData | null>(null);
  const hovering = useRef(false);
  /** Monotonic id so a slow history fetch can never overwrite a newer one. */
  const loadSeq = useRef(0);

  // --- feed failsafes (chart/feedHealth.ts) ----------------------------------
  /** The initial load in flight, with its retries. A newer load cancels it -
   *  aborting its request - so a late answer for the market we left can never
   *  reach the chart. */
  const loadHandle = useRef<RetryHandle<unknown[]> | null>(null);
  /** The series `loadHandle` is loading. */
  const loadingKey = useRef('');
  /** The series whose bars are on the chart right now; null while loading. */
  const series = useRef<Series | null>(null);
  /** Bars for a silent rebuild (gap repair): the next `init` load of this key
   *  takes them instead of fetching, and without the loading mask. */
  const primed = useRef<{ key: string; rows: KLineData[] } | null>(null);
  /** Older bars of the series on the chart, fetched ahead of the user
   *  (chart/historyPager.ts); replaced with the series. */
  const pager = useRef<HistoryPager | null>(null);
  /** Brings up older bars that land where the user is already looking. */
  const reveal = useRef<HistoryReveal | null>(null);
  /** The newest request klinecharts made for older bars: an older one still
   *  waiting was superseded (a reset re-armed the library) and is dropped. */
  const forwardSeq = useRef(0);
  const watchdog = useRef<FeedWatchdog | null>(null);
  const watchdogKey = useRef('');
  /** A line is being dragged or awaits a confirm: no rebuild may run under it. */
  const interacting = useRef(false);
  /** The plot is masked (loading / failed / empty): nothing on it is real. */
  const maskedRef = useRef(true);
  const lastPriceRef = useRef(lastPrice);
  lastPriceRef.current = lastPrice;
  /** Load state of the series in `feed.key`. The render compares that key with
   *  the one on screen, so a switch shows the mask on its very first frame. */
  const [feed, setFeed] = useState<FeedView & { key: string }>({ key: '', ...FEED_LOADING });
  const [health, setHealth] = useState<{ health: FeedHealth; why: string }>({
    health: 'live',
    why: 'Live: candles are streaming from the venue.',
  });
  /** Bumped to re-subscribe the candle channel after a stall. */
  const [resub, setResub] = useState(0);
  /** A freshly loaded series whose candles are due to take over from the
   *  loading skeleton (chart/CandleMorph.tsx): 'morph' grows the placeholder
   *  candles into them, 'fade' crossfades (reduced motion, or a series style
   *  with no candles to grow into). Set only by a FRESH load - first load, or
   *  a symbol / interval switch - in the same batch that unmasks the plot. A
   *  gap repair, a reconnect catch-up and a precision-only reload take the
   *  other two paths through getBars and never set it. */
  const [arrival, setArrival] = useState<{ key: string; mode: 'morph' | 'fade' } | null>(null);
  /** The series whose candles (and grid) klinecharts leaves to the morph
   *  layer while it draws them instead (morph.ts, MORPH_HIDDEN). */
  const hiddenCandles = useRef<string | null>(null);
  /** A switch is holding the chart's frame: indicator and overlay drawings
   *  are faded out while the grid and axes stay (chart/switchFrame.ts). */
  const frameHeld = useRef(false);
  /** The colour the last-price badge was last given while the candle layer
   *  owns the rule (null: the theme's own colours). */
  const badgeCss = useRef<string | null>(null);
  /** The switch's wait is over: indicators and overlays fade back in. */
  const releaseFrame = useCallback(() => {
    if (!frameHeld.current) return;
    frameHeld.current = false;
    const c = chart.current;
    if (c) holdFrame(c, false);
  }, []);
  /** Give klinecharts its candles, grid and badge colours back: on the
   *  morph's hand-over frame, or when a morph is cut short. */
  const showCandles = useCallback(() => {
    releaseFrame();
    const tinted = badgeCss.current !== null;
    badgeCss.current = null;
    if (hiddenCandles.current === null && !tinted) return;
    hiddenCandles.current = null;
    chart.current?.setStyles(MORPH_SHOWN);
  }, [releaseFrame]);
  /** The morph out takes klinecharts' candles (and grid) over on a switch:
   *  the layer draws them from here, in their place. The frame - grid, price
   *  and time axes - stays on screen; what belongs to the old data or the new
   *  market's overlays fades. */
  const hideCandles = useCallback(() => {
    const c = chart.current;
    if (!c) return;
    if (hiddenCandles.current === null) c.setStyles(gridLines(c) ? MORPH_HIDDEN : MORPH_HIDDEN_CANDLES);
    hiddenCandles.current ??= '(switch)';
    if (!frameHeld.current) {
      frameHeld.current = true;
      holdFrame(c, true);
    }
  }, []);
  /** The badge on the price axis takes the rule's colour, frame by frame,
   *  while the candle layer draws the rule (grey through a switch, then the
   *  new price's colour). One restyle per actual change of colour. */
  const tintBadge = useCallback((color: RGBA) => {
    const c = chart.current;
    if (!c) return;
    const css = `rgb(${Math.round(color[0])}, ${Math.round(color[1])}, ${Math.round(color[2])})`;
    if (css === badgeCss.current) return;
    badgeCss.current = css;
    c.setStyles(badgeStyles(css));
  }, []);
  /** The chart library itself failed to start (its chunk did not load). */
  const [initFailed, setInitFailed] = useState<{ error: string; failures: number; nextRetryAt: number } | null>(null);
  const [initAttempt, setInitAttempt] = useState(0);
  const initFailures = useRef(0);
  /** name -> series and library-default inputs, so the probe-create below runs
   *  at most once per indicator. */
  const seriesCache = useRef(new Map<string, { series: IndicatorSeries; defaults: number[] }>());
  const paneSeq = useRef(0);
  const drawingId = useRef<string | null>(null);
  /** The drawing the user last clicked, for Delete / Backspace. */
  const selectedDrawing = useRef<string | null>(null);
  /** Clock the axis, the crosshair and the footer read (chart/timeAxis.ts). */
  const [tz, setTz] = useStored<TimeZoneMode>('chart.tz', 'local');
  /** The chart's own layers: position, orders, executions, news (chartMarks.ts). */
  const [storedShow, setStoredShow] = useStored<ChartShow>(SHOW_KEY, sanitizeShow(null));
  const show = bare ? { ...sanitizeShow(storedShow), position: false, orders: false, executions: false, news: false, calendar: false } : sanitizeShow(storedShow);
  const showRef = useRef(show);
  showRef.current = show;
  const patchShow = useCallback((p: Partial<ChartShow>) => setStoredShow({ ...showRef.current, ...p }), [setStoredShow]);
  /** The object list on the right (ChartSidebar.tsx). */
  const [sidebar, setSidebar] = useStored<boolean>('chart.sidebar', false);
  const [newsMenu, setNewsMenu] = useState(false);
  const nm = useLatched(newsMenu);
  const newsPress = useRef(0);
  /** The long press opened the settings: the click that follows is not a toggle. */
  const newsHeld = useRef(false);
  useEffect(() => {
    if (!newsMenu) return;
    const away = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') setNewsMenu(false);
        return;
      }
      if (e.target instanceof Element && e.target.closest('.kc-news-tb')) return;
      setNewsMenu(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', away);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', away);
    };
  }, [newsMenu]);

  /** Re-mount the studies / re-load the drawings (a snapshot view opened or closed). */
  const [indGen, setIndGen] = useState(0);
  const [drawGen, setDrawGen] = useState(0);
  /**
   * A snapshot from a research folder on screen (chart/snapshot.ts): its
   * drawings, studies, interval, price source and range, with the frozen
   * position and fills it was saved with. The user's own drawings and studies
   * are set aside, not touched - nothing is saved while it shows - until Keep
   * (they become the user's) or Close (the user's come back).
   */
  const [snapView, setSnapView] = useState<ChartSnapshot | null>(null);
  const snapViewRef = useRef<ChartSnapshot | null>(null);
  /** The interval and price source to go back to when the snapshot closes. */
  const beforeSnap = useRef<{ interval: string; priceSource: PriceSource } | null>(null);
  const folders = useSyncExternalStore(onBridgeChange, foldersAvailable, () => false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const tzRef = useRef(tz);
  tzRef.current = tz;
  /** Drawing modes on the rail. Magnet and stay-in-drawing persist; lock and
   *  hide are about the drawings on screen now, which are not stored. */
  const [magnet, setMagnet] = useStored<MagnetMode>('chart.draw.magnet', 'normal');
  const [stayDrawing, setStayDrawing] = useStored<boolean>('chart.draw.stay', false);
  const [drawLocked, setDrawLocked] = useState(false);
  const [drawHidden, setDrawHidden] = useState(false);
  const drawModes = useRef({ magnet, stay: stayDrawing, locked: drawLocked });
  drawModes.current = { magnet, stay: stayDrawing, locked: drawLocked };
  /** The stored indicator list (chart/indicators.ts). */
  const [storedSpecs, setStoredSpecs] = useStored<IndicatorSpec[]>(INDICATORS_KEY, DEFAULT_INDICATORS);
  const storedRef = useRef(storedSpecs);
  storedRef.current = storedSpecs;
  /** Settings dialog: which indicator, and its spec when the dialog opened. */
  const [settingsFor, setSettingsFor] = useState<{ id: string; original: IndicatorSpec } | null>(null);
  const onReady = useRef(onChartReady);
  onReady.current = onChartReady;

  const [interval, setIntervalValue] = useState('1m');
  /*
   * PRICE SOURCE: Latest (traded - the gateway's candles), Mark, or Index
   * (sodex.com's stats series; perps only, 5m and up). Carried to the loader
   * in the chart's ticker (`BTC-USD@mark`, chart/klines.ts).
   */
  const [priceSource, setPriceSource] = useStored<PriceSource>('vs.chart.priceSource', 'latest');
  const sourceOk = engine === 'perps' && !NO_MARK_INDEX.has(interval);
  // A bare chart (the liquidation heatmap's historical view) has no switch: always the traded price.
  const src: PriceSource = !bare && priceSource !== 'latest' && sourceOk ? priceSource : 'latest';
  // A timeframe change that drops Mark/Index (1m, 3m, 8h, 3D) says so. The
  // first run is the stored choice meeting the default 1m chart — that toast
  // would fire on every visit, so it waits for a change.
  const skipSourceNotice = useRef(true);
  useEffect(() => {
    if (skipSourceNotice.current) {
      skipSourceNotice.current = false;
      return;
    }
    if (!bare && priceSource !== 'latest' && !sourceOk) notify('info', markIndexNotice(engine, interval));
  }, [interval, engine, sourceOk, priceSource, bare]);
  const seriesTicker = src === 'latest' ? symbol : `${symbol}@${src}`;
  /** Which of the toolbar's views is showing - see VIEWS above. The
   *  klinecharts canvas stays mounted regardless (see the render below): it
   *  is parked, still at its real size, while another view is active, never
   *  torn down and never `display: none`. Disposing it would cost a flicker
   *  and a fresh history fetch; collapsing it to 0×0 makes klinecharts refit
   *  the price axis to 0–10. */
  const [view, setView] = useState<ViewId>('chart');
  /** The object list slides in and out (usePresence keeps it while it leaves). */
  const side = usePresence(sidebar && view === 'chart' && !bare, 240);
  const [ready, setReady] = useState(false);
  /**
   * Which klinecharts instance the effects below are wired to: bumped every
   * time one is created. The instance is created again after a failed start,
   * and during development on every hot update of this file or of anything it
   * imports - and `ready` alone does not re-run effects when it is already
   * true. That was a way to an empty chart with a 0-10 price scale: a fresh
   * instance nobody had asked for bars, unmasked because the feed state still
   * described the instance before it.
   */
  const [chartGen, setChartGen] = useState(0);
  /**
   * THE PLOT INVARIANT (chart/invariant.ts): the key of a series the guard is
   * holding masked because the plot was about to show nothing true, until a
   * fresh load of it answers. `reload` re-runs the market effect for it.
   */
  const [guard, setGuard] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const guardCount = useRef(0);
  const guardTimer = useRef<number>();
  const [error, setError] = useState<string | null>(null);
  // 'draw' is gone: the drawing tools moved out of the toolbar into the rail
  // down the left edge of the chart pane (chart/DrawingRail.tsx), which is where
  // every professional charting terminal puts them and which keeps the armed
  // tool visible instead of hiding it behind a closed popup.
  const [openMenu, setOpenMenu] = useState<'timeframe' | 'indicators' | 'style' | null>(null);
  /** The toolbar menu on screen - kept while it fades out (motion.tsx). */
  const mm = useLatched(openMenu);
  const [supported, setSupported] = useState<{ indicators: string[]; overlays: string[] }>({
    indicators: [],
    overlays: [],
  });
  const [indicators, setIndicators] = useState<ActiveIndicator[]>([]);
  /** The Indicators menu's search box. */
  const [indQuery, setIndQuery] = useState('');
  /** What the menu offers (the liquidation layers on perps only), and what matches the search, A to Z. */
  const offerable = supported.indicators.filter((n) => engine === 'perps' || !LIQ_INDICATORS.has(n));
  const indMatch = (name: string) => {
    const q = indQuery.trim().toLowerCase();
    return !q || name.toLowerCase().includes(q) || indicatorTitle(name).toLowerCase().includes(q);
  };
  const offered = offerable.filter(indMatch).sort((a, b) => indicatorTitle(a).localeCompare(indicatorTitle(b)));
  /** The footer's % A L (chart/yScale.ts). */
  const [scale, dispatchScale] = useReducer(scaleReducer, INITIAL_SCALE);
  /** A, for the pointer handlers below, which are bound once. */
  const autoRef = useRef(scale.auto);
  autoRef.current = scale.auto;
  /** With A off, a new series or scale type refits the axis; hold that fit
   *  once bars are on screen so A stays off (see the pin effect). */
  const pinAfterLoad = useRef(false);
  /** The scale kind, for a switch that eases the price axis (axisHandoff.ts). */
  const scaleKind = useRef(kindOf(scale.mode));
  scaleKind.current = kindOf(scale.mode);
  /** Labels and span from the series being left. A newer switch bumps the generation. */
  const handoff = useRef<AxisHold | null>(null);
  const handoffGen = useRef(0);
  /** Which generation already started its glide, so a later reload does not start it again. */
  const handoffUsed = useRef(0);
  const motionOk = () => !prefersReducedMotion() && !document.documentElement.classList.contains('is-potato');
  const [candleStyle, setCandleStyle] = useState<CandleType>('candle_solid');
  /** Read by getBars, which is built once and must not close over state. */
  const candleStyleRef = useRef(candleStyle);
  candleStyleRef.current = candleStyle;
  const [drawing, setDrawing] = useState<string | null>(null);
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  const [legendBar, setLegendBarNow] = useState<KLineData | null>(null);
  /** The legend follows the crosshair and the live bar - except while a view
   *  move runs, when it catches up as the move ends: a render of this whole
   *  component per crosshair event or tick is exactly the work a move's
   *  frames cannot spare. */
  const legendWait = useRef<{ bar: KLineData | null } | null>(null);
  const setLegendBar = useCallback((bar: KLineData | null) => {
    if (!moving.current) {
      setLegendBarNow(bar);
      return;
    }
    if (!legendWait.current) {
      afterMove.current.push(() => {
        const w = legendWait.current;
        legendWait.current = null;
        if (w) setLegendBarNow(w.bar);
      });
    }
    legendWait.current = { bar };
  }, []);
  const [tzMenu, setTzMenu] = useState(false);
  /** Whether THIS panel is the fullscreen element. Read from the document
   *  rather than tracked optimistically: the user can leave fullscreen with
   *  Escape, which never goes through our button. */
  const [isFull, setIsFull] = useState(false);
  /** Some embedding contexts (an iframe without `allowfullscreen`) refuse the
   *  request outright. A button that cannot work is not rendered at all. */
  const [canFullscreen] = useState(
    () => typeof document !== 'undefined' && document.fullscreenEnabled,
  );

  // --- order-line interaction state -----------------------------------------
  const layer = useRef<OrderLineLayer | null>(null);
  /**
   * Who traded, a panel beside the plot so the chart stays in view (owner 2026-11-03: "I want the who
   * traded to be a sidebar so chart stays visible"). Its candle is the chart's: right-click one, or
   * click one while the panel is open; the timeframe is the chart's interval. flowAt is a time inside
   * that candle (null: the last closed one).
   */
  const [flowOpen, setFlowOpen] = useState(false);
  const [flowAt, setFlowAt] = useState<number | null>(null);
  /**
   * A range of candles (owner 2026-11-03: "possible by pressing cmd + mouse or dragging the mouse for
   * multiple candles"): a time inside the other end candle, null for one candle. Cmd/Ctrl-click a candle
   * extends to it, Shift-drag across the plot picks a range (a plain drag still pans), and on touch the
   * long-press menu offers "to here".
   */
  const [flowEnd, setFlowEnd] = useState<number | null>(null);
  const pickFlow = useCallback((at: number, end: number | null) => {
    setFlowAt(at);
    setFlowEnd(end);
  }, []);
  const [flowSize, setFlowSize] = useStored<{ w: number; h: number }>('chart.flowSize', { w: 460, h: 0.45 });
  const flowWrap = useRef<HTMLDivElement | null>(null);
  /** A plain click on the plot while the panel is open picks its candle (not a pan, not a drag). */
  const flowDown = useRef<{ x: number; y: number; t: number } | null>(null);
  /** Live readout while a line is under the cursor. */
  const [drag, setDrag] = useState<PendingMove | null>(null);
  /** Dropped, snapped, and awaiting an explicit confirm. Nothing sent yet. */
  const [pending, setPending] = useState<PendingMove | null>(null);
  /** Submitted, waiting for the venue to report it back. */
  const [awaiting, setAwaiting] = useState<PendingMove | null>(null);
  const [sending, setSending] = useState(false);
  /** What the last context-menu pick put into the order ticket. */
  const [ticket, setTicket] = useState<{ kind: 'buy' | 'sell' | 'stop'; price: string } | null>(null);
  const settleTimer = useRef<number>();
  const { msg: lineMsg, show: showLine, fromError: lineError, clear: clearLine } = useStatus();
  /** Measured height of the floating notice stack, so the OHLC legend can move
   *  out from under it instead of being half-covered by an opaque bar. */
  const notices = useRef<HTMLDivElement>(null);
  /** The OHLC legend, so the indicator rows under it start where it ends
   *  (it wraps to two lines on a narrow panel). */
  const ohlcLegend = useRef<HTMLDivElement>(null);
  const [noticeH, setNoticeH] = useState(0);

  // --- order data ------------------------------------------------------------
  // Read directly rather than through props: the lines have to stay in step with
  // the venue on their own, including while the Positions/Orders panels are on a
  // different tab of the dashboard and not mounted at all.
  //
  // Shared with Account.tsx (and OrderEntry.tsx for positions) - see
  // accountFeeds.ts. This used to fetch its OWN symbol-scoped order list
  // (`api.openOrders(engine, address, symbol)`), a narrower REST call nobody
  // else made, duplicating work every time the Positions/Open Orders panels
  // were ALSO mounted. It now reads the same full, unfiltered feed those
  // panels use; `orderLines()` in chart/orderOverlays.ts already filters to
  // the current symbol internally (`pick(raw,'symbol','s') !== o.symbol`), so
  // nothing downstream of this needs to change.
  const ordersKey = address ? `orders:${engine}:${address}` : null;
  const orders = useAccountResource(ordersKey, () => api.openOrders(engine, address!), 10_000);
  const posKey = address && engine === 'perps' ? `pos:${address}` : null;
  const positions = useAccountResource(posKey, () => api.positions(address!), 10_000);

  /* Failures land in the toast rail, not in a line of red prose that reflows
     the chart panel every time a poll misses - and only when there are no
     lines to draw: a refresh that misses keeps the last good ones (readState.ts),
     and the next poll or push usually lands. */
  useLoadFailedToast(shownError(orders), 'Open orders', orders.refresh);
  useLoadFailedToast(shownError(positions), 'Positions', positions.refresh);
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

  /**
   * Whether a chart drag may modify anything.
   *
   * One gate, and its reason is stated to the user rather than left as a dead
   * line that will not move: a locked signing key cannot sign anything at all.
   * Spot and perps alike - the move goes through changeOrder, which picks
   * SoDEX's request for the order (or refuses it, before signing, with a reason).
   */
  const modifyBlocked = !unlocked ? 'Read-only — enable trading to move orders from the chart.' : null;
  const canModify = modifyBlocked === null;
  /** Placing is the same gate minus the perps-only part: the ticket can prefill
   *  for either engine, but not while the session is read-only. */
  const canPlace = unlocked;

  // Close an open dropdown on outside click.
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!toolbar.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openMenu]);

  // --- order-line callbacks --------------------------------------------------

  /**
   * Put a line back onto the price the server last stated and drop every trace
   * of the move.
   *
   * This is the one function that has to be right. It runs on cancel, on a
   * rejected modify, on the order vanishing mid-drag, and on the settle timeout
   * — i.e. on every path where the line is showing a price the venue has not
   * agreed to. Leaving a line where the user dragged it after any of those would
   * tell them an order moved when it did not.
   */
  const abandon = useCallback((key: string) => {
    window.clearTimeout(settleTimer.current);
    layer.current?.release(key);
    setDrag(null);
    setPending(null);
    setAwaiting(null);
  }, []);

  /**
   * The overlay layer is built once, inside the create-the-chart effect, so its
   * callbacks cannot close over props or state — they would be frozen at first
   * render. They are routed through this ref, which is rewritten every render.
   */
  const lineHandlers = useRef<OrderLineHandlers | null>(null);
  lineHandlers.current = {
    onDragStart: (line) => {
      clearLine();
      setPending(null);
      setAwaiting(null);
      setDrag({ line, price: line.price });
    },
    onDragMove: (line, price) => {
      if (price !== null) setDrag({ line, price });
    },
    onDrop: (line, price) => {
      setDrag(null);
      if (price === null) {
        // The axis could not name a price for where the line landed. There is
        // nothing honest to offer, so it goes back where it was.
        abandon(line.key);
        showLine('err', 'Could not read a price for that point on the axis — the line was put back.');
        return;
      }
      setPending({ line, price });
    },
    onGone: (line) => {
      abandon(line.key);
      showLine(
        'err',
        `${line.label} is no longer open — it filled or was cancelled while you were moving it. Nothing was sent.`,
      );
    },
    onSettled: (line) => {
      window.clearTimeout(settleTimer.current);
      setAwaiting(null);
      showLine('ok', `Order moved. The venue reports it at ${fmtPrice(line.price, sym?.tickSize)}.`);
    },
    onLineClick: (line) => {
      if (!line.draggable && line.lockedReason) showLine('info', line.lockedReason);
    },
  };

  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  // A new time zone re-labels the axis and the crosshair at once: the resize
  // re-lays the chart, which rebuilds the time ticks now rather than on the
  // next scroll.
  useEffect(() => {
    const c = chart.current;
    if (!ready || !c) return;
    c.setTimezone(tz === 'utc' ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone);
    c.resize();
  }, [tz, ready, chartGen]);
  useEffect(() => {
    if (!tzMenu) return;
    const close = () => setTzMenu(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setTzMenu(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [tzMenu]);

  // The notice stack floats over the canvas, so nothing in the layout knows how
  // tall it is. Measure it and hand the number to the legend, which would
  // otherwise sit half-hidden behind an opaque bar. A ResizeObserver rather than
  // a one-shot read: the bar re-wraps as the panel is resized.
  useEffect(() => {
    const el = notices.current;
    if (!el) {
      setNoticeH(0);
      return;
    }
    const measure = () => setNoticeH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [drag, pending, awaiting, ticket, lineMsg, snapView]);

  // --- create the chart once -------------------------------------------------
  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | undefined;
    let unNumStyle: (() => void) | undefined;
    let initRetryTimer = 0;

    /**
     * A page of history is on the chart for `s`: unmask, and (re)arm the
     * watchdog for that series. A silent rebuild of the SAME series keeps its
     * watchdog, so the recovery pacing is not reset by the recovery itself.
     */
    const applyHistory = (s: Series, rows: KLineData[]) => {
      series.current = s;
      lastBar.current = rows[rows.length - 1] ?? null;
      // Every bar on the chart now is the history's; the stream has written none of them.
      streamTs.current = null;
      if (!hovering.current) setLegendBar(lastBar.current);
      setFeed({ key: s.key, phase: rows.length ? 'ready' : 'empty', failures: 0, nextRetryAt: null, error: null });
      let w = watchdog.current;
      if (!w || watchdogKey.current !== s.key) {
        w?.dispose();
        w = new FeedWatchdog({
          intervalMs: intervalMs(s.interval) ?? 60_000,
          recover,
          onHealth: (h, why) => {
            if (h === 'delayed') log.warn('feed delayed', { key: s.key, why });
            else log.info('feed live again', { key: s.key });
            setHealth({ health: h, why });
          },
        });
        watchdog.current = w;
        watchdogKey.current = s.key;
        w.noteStream(streamOpen(s.engine));
        w.noteVisible(document.visibilityState === 'visible');
        // The baseline is THIS market's last close: `lastPrice` may still be
        // the previous market's for a moment after a switch.
        w.noteTicker(lastBar.current?.close ?? lastPriceRef.current);
      }
      w.noteHistory(lastBar.current?.timestamp ?? null);
      // Older bars, fetched ahead of the user. The pager goes with the series
      // and keeps its runway while the chart's oldest bar is the one it handed
      // over (a silent rebuild hands every bar back, history included).
      const first = rows[0]?.timestamp;
      const pg = pager.current;
      if (first === undefined) {
        pg?.dispose();
        pager.current = null;
      } else if (!pg || pg.key !== s.key || pg.oldest !== first) {
        pg?.dispose();
        const next = new HistoryPager({
          key: s.key,
          firstTimestamp: first,
          pageSize: HISTORY_PAGE,
          ahead: HISTORY_AHEAD,
          fetchOlder: async (endTime, limit, signal) =>
            toRows(await fetchKlineRows({ engine: s.engine, symbol: s.symbol, interval: s.interval, limit, endTime }, { signal, timeoutMs: LOAD_TIMEOUT_MS })),
          onError: (error, failures, retryInMs) =>
            (failures >= 3 ? log.error : log.warn)('older bars failed to load; retrying', { key: s.key, failures, retryInMs, error }),
        });
        pager.current = next;
        next.prefetch();
        log.debug('history: fetching older bars ahead', { key: s.key, from: first, pages: HISTORY_AHEAD, pageSize: HISTORY_PAGE });
      }
    };

    /**
     * klinecharts has scrolled to the oldest bar it holds: hand it the next
     * page of older ones - from the pager's runway at once (the library adds
     * it before it paints: the user never sees the edge), or, when the user
     * outran the runway, as soon as it lands, brought up by the reveal.
     */
    const loadOlder = async (callback: DataLoaderGetBarsParams['callback']) => {
      const seq = ++forwardSeq.current;
      const c = chart.current;
      const pg = pager.current;
      const s = series.current;
      const first = c?.getDataList()[0]?.timestamp;
      if (!c || !pg || !s || pg.key !== s.key || first === undefined) {
        callback([], false);
        return;
      }
      let page = pg.take(first);
      const late = page === null;
      if (!page) {
        log.debug('history: the oldest bar came into view before the next page; waiting for it', { key: s.key, first });
        page = await pg.next(first);
        // A reset re-armed the library (it asked again) or another series
        // owns it now: this answer belongs to nobody.
        if (!page || disposed || seq !== forwardSeq.current || pager.current !== pg || chart.current !== c || c.getDataList()[0]?.timestamp !== first) {
          log.debug('history: a late page was dropped', { key: pg.key });
          return;
        }
      }
      callback(page.rows, { forward: page.more, backward: false });
      if (!page.rows.length) {
        log.info('history: reached the start of this market\'s history', { key: s.key });
        return;
      }
      log.debug('history: older bars added', { key: s.key, bars: page.rows.length, late, more: page.more, ahead: pg.held });
      // The user is looking at where they landed: bring them up - unless the
      // candle layer is drawing the plot, which fades in bars of its own.
      if (late && hiddenCandles.current === null) reveal.current?.start(first);
    };

    /**
     * Put the chart back in step with the venue: re-subscribe the candle
     * stream when it has gone quiet, refetch the right edge, and merge it in
     * without duplicating a bar (feedHealth.ts, planMerge).
     */
    /** The ticks kept while the history loaded, for the series now on the chart, in order. */
    const replayTicks = () => {
      const key = series.current?.key;
      if (!key || !pushBar.current || !pendingTicks.current.length) return;
      const mine = pendingTicks.current.filter((x) => x.key === key);
      pendingTicks.current = [];
      for (const x of mine) onCandle.current(x.d);
    };

    const recover = async (reason: RecoverReason): Promise<RecoverResult> => {
      const s = series.current;
      const c = chart.current;
      if (disposed || !s || !c || !pushBar.current) return 'failed';
      log.info('recovering the feed', { key: s.key, reason });
      if (reason === 'ticker-moving' || reason === 'stale-bars' || reason === 'stream-silent') {
        log.info('candle stream resubscribed', { key: s.key, reason });
        setResub((n) => n + 1);
      }
      const before = c.getDataList();
      const last = before[before.length - 1] ?? null;
      const ivMs = intervalMs(s.interval) ?? 60_000;
      const limit = gapFillLimit(last?.timestamp ?? null, Date.now(), ivMs, 10, KLINE_LIMIT);
      let raw: unknown[];
      const t0 = performance.now();
      try {
        raw = await fetchKlineRows(
          { engine: s.engine, symbol: s.symbol, interval: s.interval, limit },
          { timeoutMs: LOAD_TIMEOUT_MS },
        );
      } catch (error) {
        log.warn('gap-fill request failed; the watchdog retries', { key: s.key, reason, limit, error });
        return 'failed';
      }
      log.debug('gap-fill response', { key: s.key, limit, bars: raw.length, ms: Math.round(performance.now() - t0) });
      // The market, the interval or the chart itself moved on meanwhile.
      if (disposed || series.current !== s || chart.current !== c || !pushBar.current) return 'current';

      const held = c.getDataList().map(asBar);
      const fetched = toRows(raw).map(asBar);
      const plan = planMerge(held, fetched);
      if (plan.kind === 'none') return 'current';
      if (plan.kind === 'append') {
        // The chart's realtime path: a bar at its last time replaces it, a
        // later one is appended - so nothing is ever drawn twice.
        for (const b of plan.bars) pushBar.current?.(b.row);
        const newest = plan.bars[plan.bars.length - 1]!.row;
        if (!lastBar.current || newest.timestamp >= lastBar.current.timestamp) lastBar.current = newest;
        if (!hovering.current) setLegendBar(lastBar.current);
        log.info('gap filled at the right edge', { key: s.key, bars: plan.bars.length, newBars: plan.newBars });
        return plan.newBars > 0 ? 'caught-up' : 'current';
      }
      // A hole the realtime path cannot fill. Never under a line the user is
      // holding or has not confirmed yet; the watchdog comes back later.
      if (interacting.current) return 'failed';
      const rows = (plan.reason === 'too-far' ? fetched : mergeBars(held, fetched)).map((b) => b.row);
      // A rebuild onto nothing would empty a chart that was showing bars.
      if (!rows.length) {
        log.warn('gap repair produced no bars; keeping the bars on screen', { key: s.key, reason: plan.reason });
        return 'failed';
      }
      log.info('gap repair: reloading the series from merged bars', { key: s.key, reason: plan.reason, bars: rows.length });
      // Keep the user where they were if they had scrolled back into history.
      const range = c.getVisibleRange();
      const anchor = range.realTo < before.length ? before[Math.max(0, range.realTo - 1)]?.timestamp : undefined;
      primed.current = { key: s.key, rows };
      c.resetData();
      if (anchor !== undefined) c.scrollToTimestamp(anchor, 0);
      return 'caught-up';
    };
    recoverRef.current = recover;

    /**
     * v10's single data seam. `getBars` is deliberately a pure function of its
     * own params (klinecharts hands it the SymbolInfo and Period it is asking
     * about) rather than of React state, so a fetch can never be answered with
     * the wrong market's candles.
     */
    const loader: DataLoader = {
      getBars: async (params: DataLoaderGetBarsParams) => {
        const { type, symbol: info, period, callback } = params;
        // 'forward' is klinecharts' word for OLDER bars (they go in front of
        // the list): the pager has them ready (loadOlder). Nothing newer than
        // the live bar exists - the stream brings it - so 'backward' is empty.
        if (type === 'forward') {
          await loadOlder(callback);
          return;
        }
        if (type !== 'init') {
          callback([], false);
          return;
        }
        const seq = ++loadSeq.current;
        const eng = info.engine as Engine | undefined;
        const iv = intervalOf(period);
        if (!eng || !iv) {
          // klinecharts has to be answered, and there is nothing honest to
          // answer with. The plot stays masked: no feed state is ready for it.
          log.error('bars asked for an unknown engine or interval', { engine: info.engine, ticker: info.ticker, period });
          callback([], false);
          return;
        }
        const key = feedKey(eng, info.ticker, iv);
        log.debug('bars requested', { key, generation: seq });

        // A silent rebuild (gap repair, see `recover` below) hands over bars
        // it already holds: no request, and no loading mask over a chart that
        // was showing good candles a moment ago.
        const p = primed.current;
        if (p && p.key === key) {
          primed.current = null;
          log.debug('gap repair: bars handed back', { key, bars: p.rows.length });
          applyHistory({ key, engine: eng, symbol: info.ticker, interval: iv }, p.rows);
          callback(p.rows, { forward: pager.current?.more ?? p.rows.length > 0, backward: false });
          return;
        }
        primed.current = null;

        // The SAME series reloaded - klinecharts resets the store when only the
        // symbol's precision changed (the market's rules arrived after its
        // candles). The bars on the chart are this series' bars, live-updated:
        // hand them straight back. No request, no mask.
        const cur = series.current;
        const onChart = chart.current?.getDataList() ?? [];
        if (cur && cur.key === key && onChart.length) {
          const rows = onChart.slice();
          log.debug('same series reloaded (precision change): bars handed back', { key, bars: rows.length });
          applyHistory(cur, rows);
          callback(rows, { forward: pager.current?.more ?? rows.length > 0, backward: false });
          return;
        }

        let handle = loadHandle.current;
        if (!handle || loadingKey.current !== key) {
          // A new series. Whatever was loading for the previous one is
          // cancelled - its request aborted, its retries stopped - and the
          // mask goes up.
          log.info('series switch', { from: series.current?.key ?? (loadingKey.current || null), to: key, generation: seq });
          if (handle) log.debug('stale load cancelled', { key: loadingKey.current });
          handle?.cancel();
          series.current = null;
          pager.current?.dispose();
          pager.current = null;
          reveal.current?.stop();
          watchdog.current?.dispose();
          watchdog.current = null;
          watchdogKey.current = '';
          setError(null);
          // A morph still running belongs to the market being left. Its
          // candles stay with the candle layer, which morphs them out into the
          // placeholders and owes klinecharts its candles back (CandleMorph).
          setArrival(null);
          tween.current?.cancel();
          setFeed({ key, ...FEED_LOADING });
          lastBar.current = null;
          if (!hovering.current) setLegendBar(null);
          handle = null;
        }

        /*
         * WHY THE CALLBACK WAITS THROUGH EVERY RETRY. klinecharts sets its
         * internal `_loading` before calling getBars and clears it only in the
         * callback. It used to be answered with an empty set on the first
         * failure, which drew a bare 0-10 price scale with nothing to say why.
         * Now the load keeps retrying (1s, 2s, 5s, 10s, then every 15s) and
         * the store keeps waiting; the mask covers the canvas the whole time,
         * so the previous market's candles that klinecharts still holds are
         * never visible under the new market's name, and nothing under the
         * mask can be clicked. A switch to another market cancels this load
         * and klinecharts' own reset re-arms the store for the new one.
         */
        if (!handle) {
          handle = loadWithRetry({
            attempt: async (signal) => {
              const t0 = performance.now();
              log.debug('klines request', { key, limit: KLINE_LIMIT });
              const rows = await fetchKlineRows({ engine: eng, symbol: info.ticker, interval: iv, limit: KLINE_LIMIT }, { signal });
              log.debug('klines response', { key, bars: rows.length, ms: Math.round(performance.now() - t0) });
              return rows;
            },
            isFatal: isFatalStatus,
            onStatus: (s) => {
              if (loadingKey.current !== key || disposed) return;
              if (s.nextRetryAt !== null) {
                const retry = { key, status: s.status, attempt: s.failures, nextRetryInMs: Math.max(0, s.nextRetryAt - Date.now()), error: s.error };
                if (s.phase === 'error') log.error('klines keep failing; the chart shows an error and keeps retrying', retry);
                else log.warn('klines request failed; retrying', retry);
              }
              setFeed({ key, phase: s.phase, failures: s.failures, nextRetryAt: s.nextRetryAt, error: s.error });
            },
          });
          loadHandle.current = handle;
          loadingKey.current = key;
        }
        // (Same series asked for twice while loading: the second call shares
        // the first one's request, and only the newest callback is answered.)
        let raw: unknown[];
        try {
          raw = await handle.promise;
        } catch {
          // Cancelled: a newer load owns the callback, and calling this one
          // would clear the store out from under it.
          return;
        }
        if (seq !== loadSeq.current || disposed) {
          log.debug('stale bars dropped', { key, generation: seq, latest: loadSeq.current });
          return;
        }
        if (loadHandle.current === handle) {
          loadHandle.current = null;
          loadingKey.current = '';
        }
        const rows = toRows(raw);
        if (!rows.length) log.warn('klines response is empty', { key, rows: raw.length });
        else if (rows.length < raw.length) log.warn('klines response had unusable rows', { key, rows: raw.length, usable: rows.length });
        // All the bars go in at once - scale, layout and axes are final before
        // the plot is unmasked - and the candle layer takes them over from the
        // skeleton. Batched with applyHistory's setFeed, so the commit that
        // unmasks the plot is the one that starts the morph.
        const mode = !rows.length
          ? null
          : morphable(candleStyleRef.current) && !prefersReducedMotion()
            ? 'morph'
            : 'fade';
        if (mode === 'morph' && chart.current) {
          // Hidden in the same tick the bars go in, so klinecharts never draws
          // them before the morph layer does; CandleMorph hands them back.
          // The grid goes too: the layer draws it UNDER its candles, where the
          // finished chart has it (morph.ts, MORPH_HIDDEN).
          chart.current.setStyles(gridLines(chart.current) ? MORPH_HIDDEN : MORPH_HIDDEN_CANDLES);
          hiddenCandles.current = key;
        }
        setArrival(mode ? { key, mode } : null);
        // A switch held the frame: indicators and overlays come back with the
        // new bars, over the first part of the morph.
        releaseFrame();
        applyHistory({ key, engine: eng, symbol: info.ticker, interval: iv }, rows);
        if (rows.length) {
          // A reload the invariant guard asked for has answered.
          guardCount.current = 0;
          setGuard((g) => (g === key ? null : g));
        }
        callback(rows, { forward: rows.length > 0, backward: false });
        replayTicks();
        // klinecharts sizes the price range to the visible bars BEFORE it
        // re-measures the price axis for the new labels, and a first load
        // widens that axis (from "10" to "84,000"): fewer bars fit, and the
        // range can still include some that are gone. The next forced layout
        // corrects it - which used to be the morph's landing restyle, so every
        // candle jumped at the hand-over (measured at 390px). resize() asks for
        // the library's second measuring pass, folded into this same pending
        // layout, so the range is final before the first frame is drawn.
        if (rows.length) chart.current?.resize();
        // A timeframe or market switch kept the old axis labels up. Ease the
        // price scale from the span they showed, and crossfade the time labels.
        // Precision reloads and gap repair return above, so they never start this.
        const pending = handoff.current;
        const gen = handoffGen.current;
        if (pending && handoffUsed.current !== gen && rows.length) {
          handoffUsed.current = gen;
          const startGlide = () => {
            if (handoff.current !== pending || handoffGen.current !== gen) return;
            const c2 = chart.current;
            const tw = tween.current;
            const fitY = fit.current;
            if (!c2 || !tw || !fitY) {
              pending.clear();
              if (handoff.current === pending) handoff.current = null;
              return;
            }
            const settle = () => {
              if (gen !== handoffGen.current) return;
              if (!autoRef.current) {
                const axis = priceAxis(c2);
                if (axis) holdRange(axis);
              }
              pinAfterLoad.current = false;
            };
            fitY.prime(pending.span);
            tw.start(readView(c2), {
              ms: MORPH_MS,
              fitY: true,
              onEnd: (completed) => {
                if (gen !== handoffGen.current) return;
                if (!completed) pending.clear();
                settle();
                if (handoff.current === pending) handoff.current = null;
              },
            });
            const reveal = () => {
              if (handoffGen.current !== gen || handoff.current !== pending) return;
              pending.releasePrice();
              pending.fadeTime(MORPH_MS);
            };
            if (tw.running) requestAnimationFrame(reveal);
            else {
              // Already on the new fit, or the move could not start. onEnd is
              // not called then. Drop a prime begin() never saw.
              fitY.prime({ from: Number.NaN, to: Number.NaN });
              reveal();
              settle();
              if (handoff.current === pending) handoff.current = null;
            }
          };
          queueMicrotask(() => requestAnimationFrame(startGlide));
        } else if (pending && handoffUsed.current !== gen) {
          handoffUsed.current = gen;
          pending.clear();
          if (handoff.current === pending) handoff.current = null;
        }
      },
      // klinecharts calls these around every reload (setSymbol/setPeriod both
      // reset the store). We do not open a socket here — the app's hub already
      // owns that — we just park the callback the live tick will be fed into.
      subscribeBar: ({ callback }) => {
        pushBar.current = callback;
        replayTicks();
      },
      unsubscribeBar: () => {
        pushBar.current = null;
      },
    };

    /**
     * Legend source. The action fires with `{ x, y, paneId }` only — the
     * KLineData on the internal crosshair is NOT passed through — so the bar is
     * resolved from the x pixel via the public convert API.
     */
    const onCrosshair = (data?: unknown) => {
      const c = chart.current;
      if (!c) return;
      const cr = data as { x?: number; paneId?: string } | null | undefined;
      if (!cr || typeof cr.x !== 'number') {
        hovering.current = false;
        setLegendBar(lastBar.current);
        return;
      }
      const points = c.convertFromPixel([{ x: cr.x }], { paneId: cr.paneId ?? CANDLE_PANE_ID }) as Array<
        Partial<Point>
      >;
      const idx = points[0]?.dataIndex;
      const list = c.getDataList();
      const bar = typeof idx === 'number' && idx >= 0 && idx < list.length ? list[idx] : undefined;
      hovering.current = bar !== undefined;
      setLegendBar(bar ?? lastBar.current);
    };

    (async () => {
      const kc = await import('klinecharts');
      if (disposed || !holder.current) return;

      // Global, name-keyed and idempotent. Must happen before the first order
      // line is created; it is filtered out of the Draw menu below, because an
      // order line drawn by hand would look exactly like a real resting order.
      registerOrderLineOverlay(kc);
      // The measure tool. Registered into the SAME global overlay registry the
      // library's own sixteen live in, and deliberately before the rail's tool
      // list is read below — so it arrives in the rail through
      // getSupportedOverlays() like every other overlay rather than being
      // appended by hand, and a build where the registration failed would show
      // no measure button rather than a button that does nothing.
      registerMeasureOverlay(kc);
      // The rest of the TradingView set (chart/drawingOverlays.ts), the same way.
      registerDrawingOverlays(kc);
      // The chart's own marks (fills, news): registered, never offered as tools.
      registerMarkOverlays(kc);
      // The liquidation heatmap's layers as studies (chart/liqIndicators.tsx): before the
      // Indicators menu reads getSupportedIndicators() below, so they are in it.
      kc.registerIndicator(liqHeatTemplate);
      kc.registerIndicator(liqMapTemplate);
      // Same shape: registers the x-axis whose tick filter drops a time label
      // that would be drawn half outside the canvas. Must land before init, so
      // the name is in the registry by the time the axis is overridden below.
      registerChartAxes(kc);

      const c = kc.init(holder.current, {
        styles: chartStyles,
        // The app's number format (Settings): klinecharts has no decimal-sign
        // option, so its grouping step localizes (chart/klineNumbers.ts).
        thousandsSeparator: thousandsSeparatorOption(),
        decimalFold: decimalFoldOption(),
        // v9's `customApi` is `formatter` in v10.
        formatter: {
          formatBigNumber,
          // The crosshair's time tag reads "Fri 24 Oct '26  14:45" in the
          // chart's zone (chart/timeAxis.ts); everything else keeps the
          // library's own templates.
          formatDate: ({ dateTimeFormat, timestamp, template, type }) =>
            type === 'crosshair' ?
              crosshairLabel(timestamp, intervalToMs(intervalOf(chart.current?.getPeriod()) ?? '1m'), tzRef.current)
            : kc.utils.formatDate(dateTimeFormat, timestamp, template),
        },
      });
      if (!c) {
        setError('klinecharts failed to initialise (empty container)');
        return;
      }
      if (disposed) {
        kc.dispose(c);
        return;
      }

      // klinecharts measures the container inside its constructor and caches
      // that bounding; every later re-measure of its own is requestAnimationFrame
      // gated. If the container was not laid out yet at that instant the chart
      // sizes itself to the stale numbers (observed: a 14px-tall candle pane).
      // One synchronous resize here re-reads the real box before first paint.
      c.resize();
      unNumStyle = followNumStyle(c);

      // A pan or an axis drag follows the pointer anywhere until it is
      // released, not just while it is over the pane it began on.
      dragAnywhere(c);
      reveal.current?.dispose();
      reveal.current = new HistoryReveal(c);

      // Swapping the x-axis rebuilds the axis component from the registry, and
      // the rebuilt one only carries the flags this call passes — so
      // `scrollZoomEnabled` has to be restated or drag-to-zoom on the time axis
      // is silently lost with it.
      //
      // The ticks are TradingView's (chart/timeAxis.ts): round times, named by
      // the largest unit that turns over there - 2026, Oct, 24, 14:00 - rather
      // than the library's every-N-bars "2026-08-16". Passed here rather than
      // in the registered template because they read this instance's bars.
      const measureLabel = (text: string) =>
        kc.utils.calcTextWidth(text, AXIS_FONT_SIZE, AXIS_FONT_WEIGHT, NUM_FAMILY);
      c.overrideXAxis({
        name: X_AXIS_NAME,
        scrollZoomEnabled: true,
        createTicks: ({ range, bounding }) => {
          const list = c.getDataList();
          const iv = intervalOf(c.getPeriod()) ?? '1m';
          return timeTicks({
            from: range.realFrom,
            to: range.realTo,
            timestampAt: timestampLookup(list.length, (i) => list[i]!.timestamp, iv),
            coordAt: (i) => (c.convertToPixel({ dataIndex: i }, { paneId: CANDLE_PANE_ID }) as { x?: number }).x ?? Number.NaN,
            barSpace: c.getBarSpace().bar,
            intervalMs: intervalToMs(iv),
            width: bounding.width,
            tz: tzRef.current,
            measure: measureLabel,
          });
        },
      });

      // Candle width. See DEFAULT_BAR_SPACE — the library's own default draws
      // 7px bodies where the reference draws 5, so the same plot width shows
      // noticeably less history. Set once; the user's wheel owns it after that.
      c.setBarSpace(DEFAULT_BAR_SPACE);
      // Where every load puts the newest bar, and where the double-click reset
      // lands (chart/viewTween.ts) - stated, not assumed to be the library's.
      c.setOffsetRightDistance(DEFAULT_OFFSET_RIGHT);

      c.setDataLoader(loader);
      c.subscribeAction('onCrosshairChange', onCrosshair);

      lib.current = kc;
      chart.current = c;
      layer.current = new OrderLineLayer(c, {
        onDragStart: (l) => lineHandlers.current?.onDragStart(l),
        onDragMove: (l, p) => lineHandlers.current?.onDragMove(l, p),
        onDrop: (l, p) => lineHandlers.current?.onDrop(l, p),
        onGone: (l) => lineHandlers.current?.onGone(l),
        onSettled: (l) => lineHandlers.current?.onSettled(l),
        onLineClick: (l) => lineHandlers.current?.onLineClick(l),
      });
      // Menus are built from what this build ACTUALLY registers, not a
      // hardcoded list — a name that is not in here can never be created. Our
      // own order-line template is registered in the same list and is stripped:
      // it is not a drawing tool.
      setSupported({
        indicators: kc.getSupportedIndicators(),
        overlays: kc.getSupportedOverlays().filter((n) => !SYSTEM_OVERLAYS.has(n)),
      });
      if (tzRef.current === 'utc') c.setTimezone('UTC');
      // A fresh instance holds no bars: the plot stays masked until the load
      // the effects below start for it has answered.
      setFeed({ key: '', ...FEED_LOADING });
      setArrival(null);
      hiddenCandles.current = null;
      setChartGen((g) => g + 1);
      setReady(true);
      log.info('chart created', { attempt: initAttempt });
      onReady.current?.(c);

      // The chart sizes itself from the container; this re-measures when the
      // surrounding flex layout changes (panel resize, viewport breakpoints).
      ro = new ResizeObserver(() => c.resize());
      ro.observe(holder.current);
      initFailures.current = 0;
      setInitFailed(null);
    })().catch((e) => {
      // Typically the klinecharts chunk failing to download (a dev-server
      // restart, a flaky connection, a deploy that replaced the chunk). The
      // mask says so, and the chart retries on the load schedule by itself.
      if (disposed) return;
      initFailures.current += 1;
      const delay = retryDelayMs(initFailures.current);
      log.error('the chart failed to start; retrying', { error: e, failures: initFailures.current, nextRetryInMs: delay });
      setInitFailed({ error: String(e), failures: initFailures.current, nextRetryAt: Date.now() + delay });
      initRetryTimer = window.setTimeout(() => setInitAttempt((n) => n + 1), delay);
    });

    return () => {
      disposed = true;
      window.clearTimeout(initRetryTimer);
      loadHandle.current?.cancel();
      loadHandle.current = null;
      loadingKey.current = '';
      watchdog.current?.dispose();
      watchdog.current = null;
      watchdogKey.current = '';
      series.current = null;
      primed.current = null;
      pager.current?.dispose();
      pager.current = null;
      reveal.current?.dispose();
      reveal.current = null;
      frameHeld.current = false;
      badgeCss.current = null;
      ro?.disconnect();
      unNumStyle?.();
      const c = chart.current;
      if (c) {
        c.unsubscribeAction('onCrosshairChange');
        layer.current?.removeAll();
        lib.current?.dispose(c);
      }
      layer.current = null;
      onReady.current?.(null);
      chart.current = null;
      lib.current = null;
      pushBar.current = null;
      lastBar.current = null;
      // A new instance starts with nothing applied, whatever this one had,
      // and nothing on it is ready until it has been told what to load.
      applied.current = { period: '', symbol: '' };
      hiddenCandles.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initAttempt]);

  // --- market / timeframe ----------------------------------------------------
  // setPeriod and setSymbol EACH reset the store and trigger a fresh getBars, so
  // only the one that actually changed is touched — otherwise a single click on
  // a timeframe button fires two identical history fetches.
  const applied = useRef({ period: '', symbol: '' });
  useEffect(() => {
    const c = chart.current;
    if (!ready || !c) return;
    const period = PERIOD_BY_INTERVAL[interval];
    if (!period) return;

    const pricePrecision = sym ? precisionOf(sym.tickSize) : undefined;
    const volumePrecision = sym ? precisionOf(sym.stepSize) : undefined;
    const symbolKey = `${engine}|${seriesTicker}|${pricePrecision}|${volumePrecision}`;

    // Anything the legend was showing belongs to the market we are leaving.
    if (applied.current.symbol !== symbolKey || applied.current.period !== interval) {
      lastBar.current = null;
      hovering.current = false;
      setLegendBar(null);
    }

    // Precision arriving later changes symbolKey without changing the market.
    // That reload hands the same bars back and must not glide the axis.
    const marketId = `${engine}|${seriesTicker}`;
    const prevKey = applied.current.symbol;
    const pipe = prevKey.indexOf('|');
    const pipe2 = pipe < 0 ? -1 : prevKey.indexOf('|', pipe + 1);
    const prevMarket = pipe2 < 0 ? '' : prevKey.slice(0, pipe2);
    const switching =
      (applied.current.period !== '' && applied.current.period !== interval) ||
      (prevMarket !== '' && prevMarket !== marketId);
    // The new bars are not here yet. Keep the axes that are on screen and
    // ease the price scale across once they land (chart/axisHandoff.ts).
    if (switching && c.getDataList().length > 0 && motionOk()) {
      handoff.current?.clear();
      handoffGen.current += 1;
      const shot = captureAxis(c, scaleKind.current);
      handoff.current = shot;
      tween.current?.cancel();
    }
    if (applied.current.period !== interval) {
      applied.current.period = interval;
      c.setPeriod(period);
    }
    if (applied.current.symbol !== symbolKey) {
      applied.current.symbol = symbolKey;
      c.setSymbol({
        ticker: seriesTicker,
        // Read back inside getBars — see the note there about not closing over
        // React state. SymbolInfo carries arbitrary extra keys by design.
        engine,
        ...(pricePrecision === undefined ? {} : { pricePrecision }),
        ...(volumePrecision === undefined ? {} : { volumePrecision }),
      });
    }
    // setPeriod rebuilds the axis DOM in a microtask. Paint the saved labels
    // onto whatever widgets are there now, and once more after that rebuild.
    const shot = handoff.current;
    if (shot && switching) {
      const gen = handoffGen.current;
      const stick = () => {
        if (handoff.current === shot && handoffGen.current === gen) shot.stick(c);
      };
      stick();
      queueMicrotask(stick);
      requestAnimationFrame(stick);
    }
    // A new market or interval puts klinecharts' price axis back on auto-fit
    // (setSymbol resets it, and a range from another series means nothing).
    // A is the user's alone: with A off, the new series' fit is held once its
    // bars are on screen (the pin effect below), so A stays off.
    if (!autoRef.current) pinAfterLoad.current = true;
  }, [ready, chartGen, reload, engine, symbol, seriesTicker, interval, sym?.tickSize, sym?.stepSize]);

  // --- order lines -----------------------------------------------------------
  //
  // Server truth in, drawn lines out. The derivation is a pure function of the
  // payloads (see chart/orderOverlays.ts), so "what should be on screen" is
  // answered in one place; OrderLineLayer decides which of those actually need
  // redrawing, and refuses to touch a line that is mid-drag or under an open
  // confirm box.
  useEffect(() => {
    const l = layer.current;
    if (!ready || !l) return;
    l.setSymbol(sym);
    // useAsync keeps its last payload when it is disabled, so a disconnected
    // wallet would otherwise keep the previous account's lines on the chart.
    const rawOrders = address ? (orders.data?.orders ?? []) : [];
    const rawPositions = address && engine === 'perps' ? (positions.data?.positions ?? []) : [];
    const opts = {
      symbol,
      sym,
      canModify,
      ...(modifyBlocked === null ? {} : { cannotModifyReason: modifyBlocked }),
    };
    l.sync(
      snapView ? positionLines(snapshotPosition(snapView), opts)
      : [...(show.orders ? orderLines(rawOrders, opts) : []), ...(show.position ? positionLines(rawPositions, opts) : [])],
    );
    const px = Number(lastBar.current?.close ?? lastPriceRef.current ?? Number.NaN);
    l.notePrice(Number.isFinite(px) ? px : null);
  }, [ready, chartGen, address, engine, orders.data, positions.data, symbol, sym, canModify, modifyBlocked, show.orders, show.position, snapView]);

  // Switching market invalidates every price on screen, including any the user
  // was in the middle of dragging. Drop the interaction state rather than let a
  // confirm box for BTC survive onto an ETH chart.
  useEffect(() => {
    window.clearTimeout(settleTimer.current);
    setCtxMenu(null);
    setDrag(null);
    setPending(null);
    setAwaiting(null);
    setTicket(null);
  }, [engine, symbol]);

  // --- live candle -----------------------------------------------------------
  // Subscribed on the shared hub exactly as `useChannel` would, but by hand, so
  // the watchdog can force a fresh subscription (`resub`) when the stream has
  // gone quiet on a market that is still trading. The hub refcounts, so this
  // never opens a second upstream subscription beside another panel's.
  const onCandle = useRef<(d: any) => void>(() => undefined);
  /** The feed repair (`recover` in the chart's effect), for the live path to ask for. */
  const recoverRef = useRef<((reason: RecoverReason) => Promise<RecoverResult>) | null>(null);
  /** Open time of the last bar the candle STREAM itself wrote (null: none since the history load). */
  const streamTs = useRef<number | null>(null);
  /** Ticks that arrived while the history was loading, kept for that series and replayed once it lands. */
  const pendingTicks = useRef<Array<{ key: string; d: any }>>([]);
  useEffect(() => {
    if (!ready) return;
    return hub.subscribe(engine, { channel: 'candle', symbol, interval }, (d) => onCandle.current(d));
  }, [ready, chartGen, engine, symbol, interval, resub]);

  onCandle.current = (d) => {
    // The hub's fan-out matches engine, channel and interval but NOT symbol
    // (ws.ts), so a candle for another market on the same interval would
    // otherwise be drawn onto this one.
    if (d?.s && d.s !== symbol) return;
    if (d?.i && d.i !== interval) return;
    const want = feedKey(engine, seriesTicker, interval);
    // A tick for this series while its history is still loading (no store yet, or the old series'):
    // kept and replayed once the history lands, never dropped - the bar the load caught half-way
    // gets its later values, and no trade between the snapshot and the first push is lost.
    if (series.current?.key !== want || !pushBar.current) {
      if (d?.t) pendingTicks.current = [...pendingTicks.current.filter((x) => x.key === want).slice(-50), { key: want, d }];
      return;
    }
    // Two independent guards, both load-bearing:
    //
    // 1. `pushBar` is null from the moment klinecharts resets the store until
    //    the new history lands, which is exactly the window in which a tick for
    //    the symbol/interval we just left can still arrive. Dropping those is
    //    what kept the old implementation from throwing "Cannot update oldest
    //    data" when the timeframe changed mid-stream.
    // 2. Even inside one stream a tick can arrive out of order; a timestamp
    //    older than the last bar is stale, not an error. (klinecharts silently
    //    ignores it, but the legend would still regress, and the legend is a
    //    price a human reads.)
    if (!d?.t || !pushBar.current) return;
    const last = lastBar.current;
    if (last && d.t < last.timestamp) return;
    // The stream starts a new bar while the one before it was only ever the history's snapshot of it
    // (taken mid-bar): that bar's final values are read from the venue a moment later (recover 'settle').
    const settle = last !== null && d.t > last.timestamp && streamTs.current !== last.timestamp;

    const bar: KLineData = {
      timestamp: d.t,
      open: +d.o,
      high: +d.h,
      low: +d.l,
      close: +d.c,
      volume: +d.v,
      turnover: +d.q,
    };
    if (![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) return;
    lastBar.current = bar;
    if (!hovering.current) setLegendBar(bar);
    layer.current?.notePrice(bar.close);
    pushBar.current(bar);
    streamTs.current = bar.timestamp;
    watchdog.current?.noteTick(bar.timestamp);
    if (settle) window.setTimeout(() => void recoverRef.current?.('settle'), 1_500);
    // The first trade on a market that had no candles: there is a chart now.
    setFeed((f) => (f.phase === 'empty' && f.key === series.current?.key ? { ...f, phase: 'ready' } : f));
  };

  // --- feed watchdog signals (chart/feedHealth.ts) ---------------------------
  // The hub's reconnection signal, and the venue-side stream status it relays.
  useEffect(() => hub.onState(() => watchdog.current?.noteStream(streamOpen(engine))), [engine]);
  // A tab coming back from the background re-reads the right edge.
  useEffect(() => {
    const onVis = () => watchdog.current?.noteVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  // The last traded price: the one signal that tells a stalled candle stream
  // from a quiet market.
  useEffect(() => {
    // Only the latest-price series moves with the traded price.
    if (src === 'latest') watchdog.current?.noteTicker(lastPrice);
    // Before the first candle, the ticker is the only price the entry can be
    // compared with. Once candles exist, they own that comparison.
    if (lastBar.current) return;
    const px = Number(lastPrice ?? Number.NaN);
    layer.current?.notePrice(Number.isFinite(px) ? px : null);
  }, [lastPrice, src]);

  // Mark / index have no candle stream: the right edge is re-read every 10 s
  // and pushed through the same realtime path a streamed candle takes. Not
  // while the tab is hidden: it is read the moment the tab is shown again.
  useEffect(() => {
    if (!ready || src === 'latest') return;
    const key = feedKey(engine, seriesTicker, interval);
    let off = false;
    const poll = async () => {
      try {
        const rows = toRows(await fetchKlineRows({ engine, symbol: seriesTicker, interval, limit: 2 }, { timeoutMs: LOAD_TIMEOUT_MS }));
        if (off || series.current?.key !== key || !pushBar.current) return;
        for (const bar of rows) {
          const last = lastBar.current;
          if (last && bar.timestamp < last.timestamp) continue;
          lastBar.current = bar;
          pushBar.current(bar);
          layer.current?.notePrice(bar.close);
          watchdog.current?.noteTick(bar.timestamp);
        }
        if (!hovering.current && lastBar.current) setLegendBar(lastBar.current);
      } catch {
        /* the next poll tries again; the watchdog repairs gaps */
      }
    };
    const stop = pollEvery(10_000, () => void poll());
    return () => {
      off = true;
      stop();
    };
  }, [ready, src, engine, seriesTicker, interval]);
  useEffect(() => {
    const id = window.setInterval(() => watchdog.current?.check(), 5_000);
    return () => window.clearInterval(id);
  }, []);

  // --- price scale -----------------------------------------------------------
  useEffect(() => {
    const c = chart.current;
    const f = fit.current;
    if (!ready || !c || !f) return;
    // A move in flight belongs to the scale being left.
    tween.current?.cancel();
    // v10 picks the y-axis behaviour by the name of a registered axis; passing a
    // new name rebuilds the axis component for that pane. `createTicks` has to
    // be restated on every one of those rebuilds — it is a property of the axis
    // instance, not of the registered template, so a scale change would drop it.
    c.overrideYAxis({ paneId: CANDLE_PANE_ID, name: scale.mode, createTicks: createDenseYTicks });
    // So does `createRange`: the rebuilt axis carries its template's own
    // (plain auto-fit for that scale), and PriceFit wraps it so a view move
    // can carry the axis along (chart/yScale.ts). Both calls leave the axis
    // fitting the data, which is what A shows after a scale change.
    const axis = priceAxis(c);
    if (axis) {
      c.overrideYAxis({ paneId: CANDLE_PANE_ID, createRange: f.wrap(templateRange(axis.createRange), kindOf(scale.mode)) });
    }
    // The rebuilt axis fits the data; with A off that fit is held once laid
    // out, so a scale change never switches A on (the pin effect).
    if (!autoRef.current) pinAfterLoad.current = true;
  }, [ready, chartGen, scale.mode]);

  /** A follows klinecharts: a drag or a scroll on the price axis, or its own
   *  double-click on the axis, changes whether the axis fits the data. */
  const syncAuto = useCallback(() => {
    const c = chart.current;
    const axis = c && priceAxis(c);
    // Not while a move carries the axis, nor while a refit waits to be held
    // (pinAfterLoad): in both the axis auto-fits on purpose with A off.
    if (!axis || fit.current?.moving || pinAfterLoad.current) return;
    const auto = isAutoFit(axis);
    if (auto === autoRef.current) return;
    log.debug(auto ? 'autoscale on: klinecharts refitted the price axis' : 'autoscale off: the price axis was dragged or scrolled');
    dispatchScale({ type: auto ? 'fit' : 'manual' });
  }, []);

  // --- how the price series is drawn ----------------------------------------
  useEffect(() => {
    const c = chart.current;
    if (!ready || !c) return;
    c.setStyles({ candle: { type: candleStyle } });
  }, [ready, chartGen, candleStyle]);

  // --- view controls ---------------------------------------------------------
  // Every one is ONE smooth move (chart/viewTween.ts): bar space and scroll
  // interpolated together, painted once per frame in the frame that moved
  // them - and, with A on, the price axis on the same clock, from the range it
  // shows to the range the destination fits (chart/yScale.ts), instead of
  // re-fitting in jumps as highs and lows enter the window. With A off the
  // axis holds its range, as it does when the user pans.
  // With reduced motion they are a one-frame cut instead (viewMs).

  /** When the last reset started: one double click reaches resetView twice
   *  (its release, below, and the `dblclick` fallback on the pane). */
  const lastReset = useRef(-Infinity);
  /** When a double click last landed on a drawing: that one is not a reset. */
  const drawingDblAt = useRef(-Infinity);
  /** Double-click anywhere on the chart resets zoom, pan AND the price axis -
   *  back to exactly what a fresh chart shows (`DEFAULT_BAR_SPACE`, newest bar
   *  `DEFAULT_OFFSET_RIGHT` from the axis, the axis fitting the candles),
   *  in one eased move, whatever was done to the axis - any vertical offset,
   *  even a pixel. It never changes the modes (owner's rule): A, L and % stay
   *  as they are. With A off the axis eases onto the same fit and is then
   *  held there, so A is still off afterwards. */
  const resetView = useCallback(() => {
    // With a tool armed a double click belongs to the drawing: it finishes a
    // path, and never throws the view out from under the anchors being placed.
    if (drawingRef.current) {
      finishPathRef.current();
      return;
    }
    const now = performance.now();
    // A double click on a drawing opens its settings (drawingEvents).
    if (now - drawingDblAt.current < 600) return;
    if (now - lastReset.current < 600) return;
    lastReset.current = now;
    const keepManual = !autoRef.current;
    log.debug('view reset (double-click)', { autoscale: autoRef.current });
    // The y half of the move hands the axis to auto-fit while it runs
    // (PriceFit.begin); with A off, take it back when the move ends - done or
    // cut short by the user - so the fitted range stays and A stays off.
    const holdIfManual = () => {
      const c = chart.current;
      const axis = c && priceAxis(c);
      if (keepManual && axis && !autoRef.current) holdRange(axis);
    };
    tween.current?.start(defaultView(), { ms: viewMs(), fitY: true, onEnd: holdIfManual });
    // Nothing to move at all (already the default view): PriceFit may still
    // have handed the axis to auto-fit, so hold it right away.
    if (!tween.current?.running) holdIfManual();
  }, []);

  /** A. On -> off pins the range on screen; off -> on eases the axis onto the
   *  fit of what is on screen - the same move, with nothing to scroll. */
  const toggleAuto = useCallback(() => {
    const c = chart.current;
    const axis = c && priceAxis(c);
    if (!c || !axis) return;
    if (autoRef.current) {
      tween.current?.cancel();
      if (holdRange(axis)) {
        log.debug('autoscale off (A): the price range is held', { from: axis.getRange().from, to: axis.getRange().to });
        dispatchScale({ type: 'auto' });
      } else log.warn('autoscale cannot be switched off: this klinecharts build has no axis setRange');
      return;
    }
    log.debug('autoscale on (A): fitting the price axis');
    dispatchScale({ type: 'auto' });
    tween.current?.start((from) => from, { ms: viewMs(), fitY: true });
  }, []);

  // The user takes the chart back: a wheel, a press, a touch or a key on the
  // plot stops a running move dead, where its last frame left it.
  //
  // And a double click must not ALSO drag. klinecharts starts a scroll on
  // every press on the plot, so a pixel of travel between the second press and
  // its release nudged the chart just before the reset took it. Scrolling is
  // off for exactly that press (the click count says which one it is); the
  // library has no mouse inertia to suppress, only touch flings, and a touch
  // double-tap is not a dblclick.
  //
  // Such a press (click count 2 or more) is part of a click, not a grab, so it
  // does not stop the move either: the third press of a quick triple click
  // used to cancel the reset its double click had just started, leaving the
  // chart frozen a few frames in.
  //
  // Autoscale follows the pointer too. klinecharts itself stops fitting the
  // axis when it is dragged or scrolled on (A reads that back, syncAuto); a
  // drag on the plot that goes clearly vertical pans the axis and switches A
  // off, TradingView's rule - klinecharts only pans an axis that was already
  // off when the press began, so that first drag is done here.
  useEffect(() => {
    const el = holder.current;
    if (!ready || !el) return;
    const stop = () => tween.current?.cancel();
    /** A has to be read back once klinecharts has handled the event. */
    const syncSoon = () => window.setTimeout(syncAuto, 0);
    /** The chart whose scrolling is off for a second press, if any. */
    let held: KChart | null = null;
    /** A press on the chart is down (so a move anywhere is its drag). */
    let pressed = false;
    /** A drag on the plot, A on, that may yet go vertical; `from` once it has. */
    let pan: { x: number; y: number; height: number; from: { range: AxisRange; dy: number } | null } | null = null;
    const onDown = (e: MouseEvent) => {
      const c = chart.current;
      pressed = e.button === 0;
      pan = null;
      if (c && e.button === 0 && e.detail >= 2) {
        held = c;
        c.setScrollEnabled(false);
        return;
      }
      stop();
      // A plain press on the plot itself: not on an order line or a drawing
      // (klinecharts shows the pointer cursor over those), no tool armed.
      const main = c?.getDom(CANDLE_PANE_ID, 'main');
      const axis = c && priceAxis(c);
      if (!main || !axis || e.button !== 0 || !autoRef.current || drawingRef.current) return;
      if (main.style.cursor === 'pointer' || !isAutoFit(axis)) return;
      const r = main.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom) return;
      pan = { x: e.clientX, y: e.clientY, height: r.height, from: null };
    };
    const onMove = (e: MouseEvent) => {
      if (!pressed || !(e.buttons & 1)) return;
      if (!pan) {
        // A drag on the price axis switches A off as it happens.
        syncAuto();
        return;
      }
      const c = chart.current;
      const axis = c && priceAxis(c);
      if (!axis) return;
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (!pan.from) {
        if (Math.abs(dy) < V_PAN_PX || Math.abs(dy) <= Math.abs(dx) * 0.5) return;
        // Gone vertical. From here the axis follows the pointer, starting
        // from the range on screen now (auto-fit may have moved it while the
        // drag was still sideways) so nothing jumps; klinecharts' own scroll
        // of this same event lays it out.
        pan.from = { range: { ...axis.getRange() }, dy };
        log.debug('autoscale off: a vertical drag pans the price axis');
        dispatchScale({ type: 'manual' });
      }
      holdRange(axis, pannedRange(axis, pan.from.range, dy - pan.from.dy, pan.height));
    };
    /** Mouse presses are judged by their click count, in onDown. */
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') stop();
    };
    const onUp = (e: MouseEvent) => {
      held?.setScrollEnabled(true);
      held = null;
      pan = null;
      const wasPressed = pressed;
      pressed = false;
      // The second release of a double click on the chart: reset. Here, in
      // the capture phase, rather than on `dblclick`: klinecharts acts on this
      // same release (a price axis the user dragged goes back to auto-fit, in
      // one jump), and starting first means the move eases from the range the
      // user left - klinecharts then finds the axis fitting already and leaves
      // it alone.
      if (wasPressed && e.button === 0 && e.detail === 2 && el.contains(e.target as Node)) resetView();
      if (wasPressed) syncSoon();
    };
    const onWheel = () => {
      stop();
      syncSoon();
    };
    const passive = { capture: true, passive: true } as const;
    el.addEventListener('wheel', onWheel, passive);
    el.addEventListener('touchstart', stop, passive);
    el.addEventListener('touchend', syncSoon, passive);
    el.addEventListener('pointerdown', onPointerDown, true);
    el.addEventListener('keydown', stop, true);
    el.addEventListener('mousedown', onDown, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    return () => {
      el.removeEventListener('wheel', onWheel, passive);
      el.removeEventListener('touchstart', stop, passive);
      el.removeEventListener('touchend', syncSoon, passive);
      el.removeEventListener('pointerdown', onPointerDown, true);
      el.removeEventListener('keydown', stop, true);
      el.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      held?.setScrollEnabled(true);
      held = null;
      stop();
    };
  }, [ready, chartGen, resetView, syncAuto]);

  // Fullscreen is read back from the document rather than assumed: Escape and
  // the browser's own chrome both leave fullscreen without touching our button,
  // and an icon stuck in the wrong state is worse than no icon.
  useEffect(() => {
    if (!canFullscreen) return;
    const sync = () => setIsFull(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', sync);
    sync();
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [canFullscreen]);

  const toggleFullscreen = useCallback(() => {
    const el = root.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void el.requestFullscreen().catch(() => undefined);
  }, []);

  // --- indicators ------------------------------------------------------------
  /**
   * Mirror of `indicators` kept in a ref.
   *
   * Every mutation below has to happen OUTSIDE a setState updater: React
   * double-invokes updaters under StrictMode, and `createIndicator` is not a
   * pure function - running it twice really does build two panes (it did,
   * before this ref existed). The ref is what lets the handlers read the
   * current list without a stale closure and still keep the updaters pure.
   */
  const indicatorsRef = useRef<ActiveIndicator[]>([]);
  /** A new pane's height: a fifth of the plot, within bounds. */
  const paneHeight = useCallback((): number => {
    const h = holder.current?.clientHeight ?? 0;
    return Math.max(PANE_HEIGHT_MIN, Math.min(140, Math.round(h * PANE_SHARE) || 80));
  }, []);
  /** Own panes folded down to their legend row: every study in them is hidden. */
  const foldedPanes = useRef(new Set<string>());
  /** Fold the panes whose studies are all hidden; give the others back their height. */
  const fitPanes = useCallback(
    (c: KChart, list: ActiveIndicator[]) => {
      const byPane = new Map<string, ActiveIndicator[]>();
      for (const i of list) if (i.paneId !== CANDLE_PANE_ID) byPane.set(i.paneId, [...(byPane.get(i.paneId) ?? []), i]);
      for (const p of [...foldedPanes.current]) if (!byPane.has(p)) foldedPanes.current.delete(p);
      for (const [paneId, studies] of byPane) {
        const hidden = studies.every((i) => !i.visible);
        if (hidden === foldedPanes.current.has(paneId)) continue;
        if (hidden) {
          foldedPanes.current.add(paneId);
          c.setPaneOptions({ id: paneId, height: PANE_FOLDED, minHeight: PANE_FOLDED, dragEnabled: false });
        } else {
          foldedPanes.current.delete(paneId);
          const h = studies.find((i) => i.spec.height)?.spec.height ?? paneHeight();
          c.setPaneOptions({ id: paneId, height: Math.max(PANE_HEIGHT_MIN, Math.min(PANE_HEIGHT_MAX, h)), minHeight: PANE_HEIGHT_MIN, dragEnabled: true });
        }
      }
    },
    [paneHeight],
  );
  const commitIndicators = useCallback(
    (next: ActiveIndicator[], persist = true) => {
      indicatorsRef.current = next;
      setIndicators(next);
      if (chart.current) fitPanes(chart.current, next);
      // The pane is stored as a group key - the pane id it has now - so studies
      // that share a pane come back sharing one (mountIndicator).
      if (persist && !snapViewRef.current) {
        setStoredSpecs(
          next.map((i) => ({ ...i.spec, visible: i.visible, pane: i.paneId === CANDLE_PANE_ID ? 'main' : i.paneId })),
        );
      }
    },
    [setStoredSpecs, fitPanes],
  );


  /** Each study's own calculation, before any price source wrapped it. */
  const baseCalc = useRef(new Map<string, Indicator['calc']>());
  /** The calc a spec computes with: the study's own, fed the chosen price. */
  const calcFor = (name: string, spec: IndicatorSpec): Indicator['calc'] | undefined => {
    const own = baseCalc.current.get(name);
    if (!own) return undefined;
    const source = INDICATOR_INFO[name]?.source ? spec.source : undefined;
    if (!source || source === 'close') return own;
    return (list, ind) => own(withSource(list, source), ind);
  };

  /** Give a new indicator pane its scale rules. */
  const paneAxis = (c: KChart, paneId: string, volume: boolean) => {
    // Volume reads like SoDEX's: 0-based round steps, compact labels. And a
    // pane whose studies are all hidden shows no scale at all - with nothing
    // visible to fit, the library's range is arbitrary ("3,200.0000").
    c.overrideYAxis({
      paneId,
      createTicks: (p) => {
        const inds = c.getIndicators({ paneId });
        if (inds.length > 0 && inds.every((i) => !i.visible)) return [];
        return volume ? createVolumeTicks(p) : p.defaultTicks;
      },
    });
  };

  /**
   * Put one indicator on the chart from its spec, in `paneId` when given (an
   * existing pane it joins), else in its own home. Returns null when this
   * build has no such indicator.
   *
   * klinecharts does not expose an indicator's `series` without instantiating
   * it, and the series is what decides where it belongs: 'price' (MA/EMA/BOLL/
   * SAR/...) overlays the candles, everything else needs its own pane. So the
   * first time we see a name we create a probe on the candle pane, read the
   * series (and the library's default inputs and calculation) back and remove
   * the probe, all in one synchronous block, so it never reaches the screen;
   * the answer is then cached per name and the real one is created where it
   * belongs.
   *
   * isStack MUST be true: with isStack false, createIndicator wipes every
   * other indicator already on the target pane.
   */
  const mountIndicator = useCallback(
    (c: KChart, spec: IndicatorSpec, order: number, into?: string): ActiveIndicator | null => {
      const { name } = spec;
      let known = seriesCache.current.get(name);
      if (known === undefined) {
        const probeId = c.createIndicator({ name, paneId: CANDLE_PANE_ID }, true);
        if (!probeId) return null;
        const probe = c.getIndicators({ id: probeId, paneId: CANDLE_PANE_ID })[0];
        known = {
          series: probe?.series ?? 'normal',
          defaults: ((probe?.calcParams as unknown[]) ?? []).filter((p): p is number => typeof p === 'number'),
        };
        seriesCache.current.set(name, known);
        if (probe && !baseCalc.current.has(name)) baseCalc.current.set(name, probe.calc);
        c.removeIndicator({ id: probeId, paneId: CANDLE_PANE_ID });
      }
      const calc = calcFor(name, spec);
      const base = {
        name,
        visible: spec.visible,
        styles: stylesFor(spec),
        ...(spec.calcParams ? { calcParams: spec.calcParams } : {}),
        ...(calc ? { calc } : {}),
      };
      // Over the candles: a price study at home, or one the user put there.
      const main =
        into === CANDLE_PANE_ID ||
        (into === undefined && (spec.pane === 'main' || (spec.pane === undefined && known.series === 'price')));
      if (main || into) {
        const paneId = main ? CANDLE_PANE_ID : into!;
        // Joining a pane another study already reads its scale from - or the
        // candles, for anything that is not a price - gets an unseen scale of
        // its own (TradingView's "no scale"), so neither is squashed into the
        // other's range. A price study over the candles reads the price scale.
        const shares = paneId === CANDLE_PANE_ID ? known.series === 'price' : c.getIndicators({ paneId }).length === 0;
        const yAxisId = shares ? undefined : (c.createYAxis({ paneId, needWidget: false }) ?? undefined);
        const id = c.createIndicator({ ...base, paneId, ...(yAxisId ? { yAxisId } : {}) }, true);
        if (!id) {
          if (yAxisId) c.removeYAxis({ paneId, id: yAxisId });
          return null;
        }
        return { id, name, series: known.series, paneId, visible: spec.visible, spec, ...(yAxisId ? { yAxisId } : {}) };
      }
      const paneId = `ind_${name}_${++paneSeq.current}`;
      const id = c.createIndicator({ ...base, paneId }, true);
      if (!id) return null;
      const height = Math.max(PANE_HEIGHT_MIN, Math.min(PANE_HEIGHT_MAX, spec.height ?? paneHeight()));
      c.setPaneOptions({ id: paneId, height, minHeight: PANE_HEIGHT_MIN, dragEnabled: true, order });
      paneAxis(c, paneId, known.series === 'volume');
      return { id, name, series: known.series, paneId, visible: spec.visible, spec: { ...spec, height } };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paneHeight],
  );

  // Every new chart instance gets the stored studies back, in their order and
  // in their panes: studies stored with the same pane key share one again.
  useEffect(() => {
    const c = chart.current;
    if (!ready || !c) return;
    // Idempotent: whatever this instance already carries is taken off first.
    // Idempotent: whatever this instance already carries is taken off first - but on a bare chart
    // a layer the caller drew on it (the liquidation heatmap: chart/liqHeatIndicator.ts) is the caller's.
    for (const i of c.getIndicators()) if (!(bare && i.name === LIQ_HEAT)) c.removeIndicator({ id: i.id, paneId: i.paneId });
    const specs = bare ? [] : sanitizeSpecs(snapViewRef.current?.indicators ?? storedRef.current, new Set(lib.current?.getSupportedIndicators() ?? []));
    const out: ActiveIndicator[] = [];
    const paneOf = new Map<string, string>([['main', CANDLE_PANE_ID]]);
    let order = PANE_ORDER_BASE;
    for (const spec of specs) {
      const into = spec.pane ? paneOf.get(spec.pane) : undefined;
      const ind = mountIndicator(c, spec, order, into);
      if (!ind) continue;
      if (!into && ind.paneId !== CANDLE_PANE_ID) {
        order += 1;
        if (spec.pane) paneOf.set(spec.pane, ind.paneId);
      }
      out.push(ind);
    }
    commitIndicators(out, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, chartGen, indGen]);

  /** Distinct indicator panes, top to bottom. */
  const paneList = (list: ActiveIndicator[]) => [...new Set(list.map((i) => i.paneId))].filter((p) => p !== CANDLE_PANE_ID);

  const addIndicator = useCallback(
    (name: string) => {
      const c = chart.current;
      if (!c) return;
      const current = indicatorsRef.current;
      if (current.some((i) => i.name === name)) return;
      const spec: IndicatorSpec = name === 'VOL' ? { name, calcParams: [], visible: true } : { name, visible: true };
      const ind = mountIndicator(c, spec, PANE_ORDER_BASE + paneList(current).length);
      if (!ind) {
        setError(`Indicator "${name}" is not available in this build`);
        return;
      }
      commitIndicators([...current, ind]);
    },
    [commitIndicators, mountIndicator],
  );

  const byId = (id: string) => indicatorsRef.current.find((i) => i.id === id);

  /** Put the panes in this order on screen, and the list in display order:
   *  the candle pane's studies first, then each pane's, top to bottom. */
  const orderPanes = (c: KChart, list: ActiveIndicator[], panes: string[]): ActiveIndicator[] => {
    panes.forEach((p, k) => c.setPaneOptions({ id: p, order: PANE_ORDER_BASE + k }));
    // An order-only change re-sorts the panes on screen but leaves their
    // measured tops as they were, so getSize (and with it every legend row)
    // would keep reporting the old positions until the next resize.
    c.resize();
    return [
      ...list.filter((i) => i.paneId === CANDLE_PANE_ID),
      ...panes.flatMap((p) => list.filter((i) => i.paneId === p)),
    ];
  };

  /**
   * Take a study off the chart (its unseen scale with it). When it was the one
   * whose scale a shared pane shows, the studies left there are mounted again,
   * so one of them owns that scale rather than the pane showing a scale that
   * nothing is drawn against. Returns the list without it.
   */
  const unmountIndicator = (c: KChart, ind: ActiveIndicator, list: ActiveIndicator[]): ActiveIndicator[] => {
    c.removeIndicator({ id: ind.id, paneId: ind.paneId });
    if (ind.yAxisId) c.removeYAxis({ paneId: ind.paneId, id: ind.yAxisId });
    const rest = list.filter((i) => i.id !== ind.id);
    const left = rest.filter((i) => i.paneId === ind.paneId);
    if (ind.yAxisId || ind.paneId === CANDLE_PANE_ID || left.length === 0) return rest;
    const panes = paneList(list).filter((p) => p !== ind.paneId);
    for (const l of left) {
      c.removeIndicator({ id: l.id, paneId: l.paneId });
      if (l.yAxisId) c.removeYAxis({ paneId: l.paneId, id: l.yAxisId });
    }
    const height = Math.round(c.getSize(ind.paneId)?.height ?? 0) || ind.spec.height;
    const rebuilt: ActiveIndicator[] = [];
    for (const l of left) {
      const into = rebuilt[0]?.paneId;
      const m = mountIndicator(c, { ...l.spec, height, pane: into ? undefined : 'own' }, PANE_ORDER_BASE + panes.length, into);
      if (m) rebuilt.push(m);
    }
    const at = paneList(list).indexOf(ind.paneId);
    if (rebuilt[0]) panes.splice(Math.max(0, at), 0, rebuilt[0].paneId);
    const next = [...rest.filter((i) => i.paneId !== ind.paneId), ...rebuilt];
    return orderPanes(c, next, panes);
  };

  const removeIndicator = useCallback(
    (id: string) => {
      const c = chart.current;
      const ind = byId(id);
      if (!c || !ind) return;
      commitIndicators(unmountIndicator(c, ind, indicatorsRef.current));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commitIndicators, mountIndicator],
  );

  const toggleIndicator = useCallback(
    (id: string) => {
      const ind = byId(id);
      if (!ind) return;
      const next = !ind.visible;
      chart.current?.overrideIndicator({ name: ind.name, id: ind.id, paneId: ind.paneId, visible: next });
      // The pane's scale is blank while its studies are hidden (see paneAxis);
      // the library does not rebuild ticks on a visibility change, so it is
      // asked to.
      if (ind.paneId !== CANDLE_PANE_ID) chart.current?.resize();
      commitIndicators(
        indicatorsRef.current.map((i) => (i.id === id ? { ...i, visible: next, spec: { ...i.spec, visible: next } } : i)),
      );
    },
    [commitIndicators],
  );

  /** Swap a study's pane with the pane above (-1) or below (+1). */
  const moveIndicator = useCallback(
    (id: string, dir: -1 | 1) => {
      const c = chart.current;
      const ind = byId(id);
      if (!c || !ind) return;
      const list = indicatorsRef.current;
      const panes = paneList(list);
      const at = panes.indexOf(ind.paneId);
      const to = at + dir;
      if (at < 0 || to < 0 || to >= panes.length) return;
      [panes[at], panes[to]] = [panes[to]!, panes[at]!];
      commitIndicators(orderPanes(c, list, panes));
    },
    [commitIndicators],
  );

  /**
   * Move a study to another pane: over the candles ('main', price studies
   * only - anything else would be read against the price scale), into a pane
   * of its own ('new'), or into another study's pane (its id), where the two
   * share that pane's scale. The study is re-created there with its spec.
   */
  const moveIndicatorTo = useCallback(
    (id: string, target: string) => {
      const c = chart.current;
      const ind = byId(id);
      if (!c || !ind) return;
      const into =
        target === 'main' ? CANDLE_PANE_ID
        : target === 'new' ? undefined
        : byId(target)?.paneId;
      if (into === ind.paneId || (target !== 'new' && into === undefined)) return;
      const panesBefore = paneList(indicatorsRef.current);
      // Only the pane left can be rebuilt (unmountIndicator); the one joined keeps its id.
      const rest = unmountIndicator(c, ind, indicatorsRef.current);
      const spec: IndicatorSpec = { ...ind.spec, pane: target === 'main' ? 'main' : target === 'new' ? 'own' : undefined };
      const moved = mountIndicator(c, spec, PANE_ORDER_BASE + panesBefore.length, into);
      if (!moved) {
        commitIndicators(rest);
        return;
      }
      const next = [...rest, moved];
      // A new pane goes right under the one the study left; the order of the
      // others is kept.
      const panes = paneList(rest);
      if (into === undefined) {
        const was = panesBefore.indexOf(ind.paneId);
        panes.splice(was < 0 ? panes.length : Math.min(was + 1, panes.length), 0, moved.paneId);
      }
      commitIndicators(orderPanes(c, next, panes));
    },
    [commitIndicators, mountIndicator],
  );

  /** Apply a spec to a mounted indicator (the settings dialog, live). */
  const applySpec = useCallback(
    (id: string, spec: IndicatorSpec, persist: boolean) => {
      const c = chart.current;
      const ind = byId(id);
      if (!c || !ind) return;
      const defaults = seriesCache.current.get(ind.name)?.defaults ?? [];
      const calc = calcFor(ind.name, spec);
      c.overrideIndicator({
        name: ind.name,
        id: ind.id,
        paneId: ind.paneId,
        calcParams: spec.calcParams ?? defaults,
        styles: stylesFor(spec),
        visible: spec.visible,
        ...(calc ? { calc } : {}),
      });
      commitIndicators(
        indicatorsRef.current.map((i) => (i.id === id ? { ...i, visible: spec.visible, spec } : i)),
        persist,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commitIndicators],
  );

  /** A dragged pane separator: remember the heights it left. */
  const syncPaneHeights = useCallback(() => {
    const c = chart.current;
    if (!c) return;
    let changed = false;
    const next = indicatorsRef.current.map((i) => {
      // A folded pane's height is not the user's: theirs comes back on show.
      if (i.paneId === CANDLE_PANE_ID || foldedPanes.current.has(i.paneId)) return i;
      const h = Math.round(c.getSize(i.paneId)?.height ?? 0);
      if (h <= 0 || h === i.spec.height) return i;
      changed = true;
      return { ...i, spec: { ...i.spec, height: h } };
    });
    if (changed) commitIndicators(next);
  }, [commitIndicators]);

  /** Line titles for the settings dialog's Style tab. */
  const lineTitles = useCallback((id: string, params: number[]): string[] => {
    const ind = byId(id);
    const live = ind && chart.current?.getIndicators({ id: ind.id })[0];
    if (!ind || !live) return [];
    const info = INDICATOR_INFO[ind.name];
    if (info?.list) return params.map((p) => `${ind.name === 'VOL' ? 'MA' : ind.name}${p}`);
    return live.figures.filter((f) => f.type === 'line').map((f) => (f.title ?? f.key).replace(/[:：]\s*$/, ''));
  }, []);

  // --- drawing tools ---------------------------------------------------------
  /** Every overlay the user drew - never an order or position line. */
  const userDrawings = (c: KChart) => c.getOverlays().filter((o) => !SYSTEM_OVERLAYS.has(o.name));

  /** Storage key of the market whose drawings are on the chart (drawingStore.ts). */
  const drawingsKeyRef = useRef<string | null>(null);
  /** Set while one market's drawings are swapped for another's: the removals
   *  that fires must not be saved over the market being left. */
  const restoringDrawings = useRef(false);
  /** Drawings hidden one by one from their menu ("hide all" is drawHidden). */
  const hiddenDrawings = useRef(new Set<string>());
  /** The drawing just finished, and when: the library selects it, and the
   *  click that finished it reaches it as a click too; neither opens the bar. */
  const justDrew = useRef<{ id: string; at: number } | null>(null);
  const fresh = (id: string) => justDrew.current?.id === id && performance.now() - justDrew.current.at < 300;
  /**
   * A right-click on a drawing, waiting for its contextmenu event.
   *
   * klinecharts reports the right-click on mousedown; the browser's
   * contextmenu event follows on release, and a menu opened in between would
   * take that event as a click outside itself and close at once. So the press
   * only notes the drawing, and the menu opens on the contextmenu event (the
   * plot's own order menu stands down for it) - or after a moment, where no
   * such event comes.
   */
  const pendingDrawingMenu = useRef<{ id: string; at: { x: number; y: number }; t: number } | null>(null);
  /** Opens a drawing's menu (set below, read by the overlay events). */
  const drawingMenuRef = useRef<(id: string, at: { x: number; y: number }) => void>(() => undefined);
  /** The object list reads the overlays themselves: this re-renders it. */
  const [, bumpList] = useReducer((n: number) => n + 1, 0);
  /** Save the drawings on screen as this market's. Never the one being drawn. */
  const persistDrawings = useCallback(() => {
    // A snapshot view is not the user's chart: Keep saves it, nothing before.
    if (snapViewRef.current) {
      bumpList();
      return;
    }
    const c = chart.current;
    const key = drawingsKeyRef.current;
    if (!c || !key || restoringDrawings.current) return;
    const list = userDrawings(c)
      .filter((o) => o.id !== drawingId.current)
      .map((o) => toStored(o, hiddenDrawings.current.has(o.id)))
      .filter((d): d is StoredDrawing => d !== null);
    saveDrawings(key, list);
    bumpList();
  }, []);

  /** The drawing whose style bar is open, if any. */
  const [selected, setSelected] = useState<{ id: string; focusText: boolean } | null>(null);
  /** Re-render after a style change: the bar reads the overlay itself. */
  const [, bumpStyle] = useReducer((n: number) => n + 1, 0);
  /** Drawings picked together: a marked area (Ctrl / ⌘ + drag) or Ctrl / ⌘ + click. */
  const [multi, setMulti] = useState<string[]>([]);
  const multiRef = useRef(multi);
  multiRef.current = multi;
  /** The area while it is dragged: drawn straight into the DOM, no render per move. */
  const marqueeEl = useRef<HTMLDivElement>(null);
  /** Ctrl / ⌘ is down over the chart: the plot's cursor says an area can be marked. */
  const [marking, setMarking] = useState(false);
  /** A drawing's settings dialog, and the drawing as it was when it opened (Cancel). */
  const [drawingSettings, setDrawingSettings] = useState<{ id: string; original: DrawingDraft } | null>(null);
  /** A drawing (or one of its handles) is being dragged: the style bar steps
   *  aside so it never covers the handle under the pointer. */
  const [movingDrawing, setMovingDrawing] = useState(false);
  /** Opens a drawing's settings (set below, read by the overlay events). */
  const drawingSettingsRef = useRef<(id: string) => void>(() => undefined);

  /** The events every user drawing carries, whether drawn now or restored. */
  const drawingEvents = useCallback(
    () => ({
      onSelected: (e: OverlayEvent<unknown>) => {
        selectedDrawing.current = e.overlay.id;
        // Still being placed: nothing opens over the chart until it is done.
        if (e.overlay.currentStep !== -1 || e.overlay.id === drawingId.current) return;
        // The library selects what it just finished drawing. Nothing opens
        // over the chart for that (the owner's rule: no words at the top of
        // the chart while drawing); a click on the drawing opens its bar.
        if (fresh(e.overlay.id)) return;
        // A text tool keeps the "type over the words" onDrawEnd asked for.
        setSelected((s) => (s?.id === e.overlay.id ? s : { id: e.overlay.id, focusText: false }));
      },
      onClick: (e: OverlayEvent<unknown>) => {
        if (fresh(e.overlay.id) || e.overlay.currentStep !== -1 || e.overlay.id === drawingId.current) return;
        setMulti((m) => (m.length ? [] : m));
        selectedDrawing.current = e.overlay.id;
        setSelected((s) => (s?.id === e.overlay.id ? s : { id: e.overlay.id, focusText: false }));
      },
      // Right-click never deletes (the library's default does, unless told
      // not to): it opens the drawing's menu.
      onRightClick: (e: OverlayEvent<unknown>) => {
        e.preventDefault?.();
        const pend = {
          id: e.overlay.id,
          at: { x: (e.pageX ?? 0) - window.scrollX, y: (e.pageY ?? 0) - window.scrollY },
          t: performance.now(),
        };
        pendingDrawingMenu.current = pend;
        window.setTimeout(() => {
          if (pendingDrawingMenu.current !== pend) return;
          pendingDrawingMenu.current = null;
          drawingMenuRef.current(pend.id, pend.at);
        }, 700);
      },
      onDeselected: (e: OverlayEvent<unknown>) => {
        if (selectedDrawing.current === e.overlay.id) selectedDrawing.current = null;
        setSelected((s) => (s?.id === e.overlay.id ? null : s));
      },
      // TradingView's: a double click on a drawing opens its settings.
      onDoubleClick: (e: OverlayEvent<unknown>) => {
        if (e.overlay.currentStep !== -1 || e.overlay.id === drawingId.current) return;
        drawingDblAt.current = performance.now();
        drawingSettingsRef.current(e.overlay.id);
      },
      onPressedMoveStart: () => setMovingDrawing(true),
      // A drawing dragged to a new place, or one of its handles moved.
      onPressedMoveEnd: () => {
        setMovingDrawing(false);
        persistDrawings();
      },
      onRemoved: (e: OverlayEvent<unknown>) => {
        hiddenDrawings.current.delete(e.overlay.id);
        setMulti((m) => (m.includes(e.overlay.id) ? m.filter((x) => x !== e.overlay.id) : m));
        if (selectedDrawing.current === e.overlay.id) selectedDrawing.current = null;
        setSelected((s) => (s?.id === e.overlay.id ? null : s));
        if (drawingId.current === e.overlay.id || drawingId.current === null) {
          drawingId.current = null;
          setDrawing(null);
        }
        // After the library has let go of it, so it is not saved back.
        window.setTimeout(persistDrawings, 0);
      },
    }),
    [persistDrawings],
  );

  const applyToDrawings = useCallback(
    (patch: Omit<Parameters<KChart['overrideOverlay']>[0], 'id'>) => {
      const c = chart.current;
      if (!c) return;
      for (const o of userDrawings(c)) c.overrideOverlay({ ...patch, id: o.id });
      persistDrawings();
    },
    [persistDrawings],
  );
  const onMagnet = useCallback(
    (mode: MagnetMode) => {
      setMagnet(mode);
      applyToDrawings({ mode });
    },
    [setMagnet, applyToDrawings],
  );
  const onLockDrawings = useCallback(
    (on: boolean) => {
      setDrawLocked(on);
      applyToDrawings({ lock: on });
    },
    [applyToDrawings],
  );
  const onHideDrawings = useCallback(
    (on: boolean) => {
      setDrawHidden(on);
      // Showing all shows every drawing, the ones hidden one by one too:
      // a hidden drawing has no surface left to right-click.
      if (!on) hiddenDrawings.current.clear();
      applyToDrawings({ visible: !on });
      bumpStyle();
    },
    [applyToDrawings],
  );
  const drawHiddenRef = useRef(drawHidden);
  drawHiddenRef.current = drawHidden;

  // This market's drawings, back on screen - on every new chart instance and
  // on every market change (the mobile carousel keeps one instance across
  // markets; the chart card remounts per market tab).
  useEffect(() => {
    const c = chart.current;
    if (!ready || !c) return;
    const key = drawingsKey(engine, symbol);
    restoringDrawings.current = true;
    for (const o of userDrawings(c)) c.removeOverlay({ id: o.id });
    drawingId.current = null;
    selectedDrawing.current = null;
    setDrawing(null);
    setSelected(null);
    drawingsKeyRef.current = key;
    hiddenDrawings.current.clear();
    setMulti([]);
    const known = new Set(lib.current?.getSupportedOverlays() ?? []);
    // Another market leaves the snapshot view (the mobile carousel keeps one
    // chart across markets): that market's own drawings and the studies return.
    const sv = snapViewRef.current;
    if (sv && (sv.engine !== engine || sv.symbol !== symbol)) {
      snapViewRef.current = null;
      setSnapView(null);
      beforeSnap.current = null;
      setIndGen((g) => g + 1);
    }
    const stored = bare ? [] : snapViewRef.current ? parseDrawings(snapViewRef.current.drawings, known) : loadDrawings(key, known);
    for (const d of stored) {
      const id = c.createOverlay({
        name: d.name,
        points: d.points,
        ...(d.styles ? { styles: d.styles } : {}),
        ...(d.extendData !== undefined ? { extendData: d.extendData } : {}),
        ...(d.z !== undefined ? { zLevel: d.z } : {}),
        lock: d.lock === true,
        visible: !drawHiddenRef.current && !d.hidden,
        mode: drawModes.current.magnet,
        ...drawingEvents(),
      });
      if (d.hidden && typeof id === 'string') hiddenDrawings.current.add(id);
    }
    // The rail's lock reflects what came back: all locked reads as locked.
    setDrawLocked(stored.length > 0 && stored.every((d) => d.lock === true));
    restoringDrawings.current = false;
    bumpList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, chartGen, engine, symbol, drawGen]);

  const startRef = useRef<(name: string) => void>(() => undefined);
  const startDrawing = useCallback(
    (name: string) => {
      const c = chart.current;
      if (!c) return;
      // Switching tools mid-draw drops the half-drawn one.
      if (drawingId.current) c.removeOverlay({ id: drawingId.current });
      setOpenMenu(null);
      setDrawing(name);
      setSelected(null);
      setMulti([]);
      // Drawing while everything is hidden would draw something you cannot see.
      if (drawHiddenRef.current) onHideDrawings(false);
      const text = DEFAULT_TEXT.get(name);
      const id = c.createOverlay({
        name,
        // Magnet: snap the anchors to the nearest open / high / low / close.
        mode: drawModes.current.magnet,
        ...(text !== undefined ? { extendData: text } : {}),
        ...drawingEvents(),
        // Confirmed present on every overlay in klinecharts 10.0.2:
        // onPressedMoveStart / onPressedMoving / onPressedMoveEnd, plus
        // onDrawStart/onDrawing/onDrawEnd/onSelected/onRemoved. The drag trio is
        // what the stop-loss-modify feature will use to read a line's new price
        // while the user is still holding it.
        onDrawEnd: (e) => {
          drawingId.current = null;
          setDrawing(null);
          // The measure tool is drawn by dragging, so a click that never moved
          // leaves an overlay with one anchor, no span and nothing to report;
          // and a real drag leaves one anchor per animation frame. Both are the
          // measure's own business — see finishMeasure — but only this callback
          // knows the drag is over, because the template's own onDrawEnd is
          // replaced by the one on this create call. The position tools get
          // their stop the same way (drawingOverlays.ts finishDrawing).
          if (name === MEASURE_OVERLAY) finishMeasure(c, e.overlay);
          else finishDrawing(c, e.overlay);
          if (drawModes.current.locked) c.overrideOverlay({ id: e.overlay.id, lock: true });
          persistDrawings();
          // A text tool opens its style bar with the words selected to type
          // over; anything else leaves the chart clear (justDrew).
          if (TEXT_TOOLS.has(name)) {
            selectedDrawing.current = e.overlay.id;
            setSelected({ id: e.overlay.id, focusText: true });
          } else {
            justDrew.current = { id: e.overlay.id, at: performance.now() };
            setSelected((s) => (s?.id === e.overlay.id ? null : s));
          }
          // Stay in drawing mode: the same tool is armed again for the next one.
          if (drawModes.current.stay) window.setTimeout(() => startRef.current(name), 0);
        },
      });
      drawingId.current = typeof id === 'string' ? id : null;
    },
    [onHideDrawings, drawingEvents, persistDrawings],
  );
  startRef.current = startDrawing;

  /**
   * End a path at the last click (double click, Enter or Escape). klinecharts
   * knows a fixed step count, so the path is re-created, finished, from the
   * points clicked so far - the double click's second press and the point
   * trailing the pointer are not among them.
   */
  const finishPath = useCallback((): boolean => {
    const c = chart.current;
    const id = drawingId.current;
    if (!c || !id || drawingRef.current !== PATH) return false;
    const o = c.getOverlays({ id })[0];
    const clicked = (o?.points ?? []).slice(0, Math.max(0, (o?.currentStep ?? 1) - 1));
    const pts = clicked.filter(
      (p, i) => i === 0 || p.timestamp !== clicked[i - 1]!.timestamp || p.value !== clicked[i - 1]!.value,
    );
    drawingId.current = null;
    c.removeOverlay({ id });
    setDrawing(null);
    if (pts.length >= 2) {
      const done = c.createOverlay({
        name: PATH,
        points: pts,
        mode: drawModes.current.magnet,
        lock: drawModes.current.locked,
        ...drawingEvents(),
      });
      if (typeof done === 'string') persistDrawings();
      if (drawModes.current.stay) window.setTimeout(() => startRef.current(PATH), 0);
    }
    return true;
  }, [drawingEvents, persistDrawings]);
  const finishPathRef = useRef(finishPath);
  finishPathRef.current = finishPath;

  /** Restyle one drawing from the style bar, and save it. */
  const styleDrawing = useCallback(
    (id: string, patch: { color?: string; size?: number; dashed?: boolean }) => {
      const c = chart.current;
      const o = c?.getOverlays({ id })[0];
      if (!c || !o) return;
      const now = paintOf(o);
      c.overrideOverlay({
        id,
        styles: drawingStyles(patch.color ?? now.color, patch.size ?? now.size, patch.dashed ?? now.dashed),
      });
      persistDrawings();
      bumpStyle();
    },
    [persistDrawings],
  );
  const textDrawing = useCallback(
    (id: string, text: string) => {
      const c = chart.current;
      const o = c?.getOverlays({ id })[0];
      if (!c || !o) return;
      // An empty tag goes back to showing its price (the library's own rule
      // for a tag with no text), which takes null rather than ''.
      c.overrideOverlay({ id, extendData: o.name === 'simpleTag' && text === '' ? null : text });
      persistDrawings();
      bumpStyle();
    },
    [persistDrawings],
  );

  /** A drawing as its settings dialog edits it. */
  const draftOf = (o: Overlay<unknown>): DrawingDraft => {
    const p = paintOf(o);
    return {
      color: p.color,
      size: p.size,
      dashed: p.dashed,
      text: TEXT_TOOLS.has(o.name) ? (typeof o.extendData === 'string' ? o.extendData : '') : null,
      points: o.points
        .filter((q) => typeof q.timestamp === 'number' && typeof q.value === 'number')
        .map((q) => ({ timestamp: q.timestamp as number, value: q.value as number })),
      lock: o.lock,
      visible: !hiddenDrawings.current.has(o.id),
    };
  };
  /** Puts a draft on the chart and saves it. */
  const applyDraft = useCallback(
    (id: string, d: DrawingDraft) => {
      const c = chart.current;
      const o = c?.getOverlays({ id })[0];
      if (!c || !o) return;
      if (d.visible) hiddenDrawings.current.delete(id);
      else hiddenDrawings.current.add(id);
      c.overrideOverlay({
        id,
        styles: drawingStyles(d.color, d.size, d.dashed),
        lock: d.lock,
        visible: d.visible && !drawHiddenRef.current,
        ...(d.points.length === o.points.length ? { points: d.points } : {}),
        ...(d.text !== null ? { extendData: o.name === 'simpleTag' && d.text === '' ? null : d.text } : {}),
      });
      persistDrawings();
      bumpStyle();
    },
    [persistDrawings],
  );
  drawingSettingsRef.current = (id: string) => {
    const o = chart.current?.getOverlays({ id })[0];
    if (!o) return;
    setSelected(null);
    setDrawingSettings({ id, original: draftOf(o) });
  };

  // --- several drawings at once ----------------------------------------------------
  /**
   * The drawings a marked area takes in (chart/marquee.ts: whatever of them
   * crosses it, as drawn) join the group; a Ctrl / ⌘ + click without a drag
   * adds or drops the topmost drawing under the pointer. Points are the
   * holder's, which are the price pane's.
   */
  const pickArea = (a: Pt, b: Pt) => {
    const c = chart.current;
    if (!c) return;
    const click = Math.abs(a.x - b.x) < 4 && Math.abs(a.y - b.y) < 4;
    const box = click ? boxOf({ x: a.x - 5, y: a.y - 5 }, { x: a.x + 5, y: a.y + 5 }) : boxOf(a, b);
    const pane = c.getSize(CANDLE_PANE_ID);
    const items = userDrawings(c)
      .filter((o) => o.visible && o.id !== drawingId.current)
      .map((o) => ({
        id: o.id,
        name: o.name,
        z: realZ(o),
        pts: c.convertToPixel(
          o.points.map((p) => ({ timestamp: p.timestamp, value: p.value })),
          { paneId: CANDLE_PANE_ID },
        ) as Array<Partial<Pt>>,
      }));
    const hit = marqueeHits(items, box, pane?.width ?? 0, pane?.height ?? 0);
    selectedDrawing.current = null;
    setSelected(null);
    if (click) {
      const top = items.filter((i) => hit.includes(i.id)).sort((x, y) => y.z - x.z)[0];
      if (top) setMulti((m) => (m.includes(top.id) ? m.filter((x) => x !== top.id) : [...m, top.id]));
      return;
    }
    if (hit.length) setMulti((m) => [...new Set([...m, ...hit])]);
  };
  const pickAreaRef = useRef(pickArea);
  pickAreaRef.current = pickArea;
  // Ctrl / ⌘ + drag on the plot marks an area. The press never reaches the
  // library (capture phase, stopped), so the chart does not pan meanwhile; a
  // plain press anywhere on the plot lets the group go.
  useEffect(() => {
    const el = holder.current;
    if (!ready || !el) return;
    const down = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (!(e.ctrlKey || e.metaKey)) {
        if (multiRef.current.length) setMulti([]);
        return;
      }
      if (drawingRef.current || maskedRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      const a = { x: e.clientX - r.left, y: e.clientY - r.top };
      let b = a;
      const shape = marqueeEl.current;
      const move = (m: MouseEvent) => {
        m.preventDefault();
        m.stopPropagation();
        b = { x: Math.max(0, Math.min(r.width, m.clientX - r.left)), y: Math.max(0, Math.min(r.height, m.clientY - r.top)) };
        if (!shape) return;
        const q = boxOf(a, b);
        shape.style.display = 'block';
        shape.style.left = `${el.offsetLeft + q.left}px`;
        shape.style.top = `${el.offsetTop + q.top}px`;
        shape.style.width = `${q.right - q.left}px`;
        shape.style.height = `${q.bottom - q.top}px`;
      };
      const up = (u: MouseEvent) => {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        // Not a click on whatever drawing the release lands on.
        u.stopPropagation();
        if (shape) shape.style.display = 'none';
        pickAreaRef.current(a, b);
      };
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
    };
    // A Mac turns Ctrl + click into a right-click: not here.
    const menu = (e: MouseEvent) => {
      if (e.ctrlKey && e.button === 0) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    el.addEventListener('mousedown', down, true);
    el.addEventListener('contextmenu', menu, true);
    return () => {
      el.removeEventListener('mousedown', down, true);
      el.removeEventListener('contextmenu', menu, true);
    };
  }, [ready, chartGen]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => setMarking(e.ctrlKey || e.metaKey);
    const off = () => setMarking(false);
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
      window.removeEventListener('blur', off);
    };
  }, []);

  /** The group's drawings that are still on the chart. */
  const groupOf = (): Array<Overlay<unknown>> => {
    const c = chart.current;
    return c ? multiRef.current.map((id) => c.getOverlays({ id })[0]).filter((o): o is Overlay<unknown> => !!o) : [];
  };
  const styleGroup = (patch: { color?: string; size?: number; dashed?: boolean }) => {
    const c = chart.current;
    if (!c) return;
    for (const o of groupOf()) {
      const now = paintOf(o);
      c.overrideOverlay({ id: o.id, styles: drawingStyles(patch.color ?? now.color, patch.size ?? now.size, patch.dashed ?? now.dashed) });
    }
    persistDrawings();
    bumpStyle();
  };
  const lockGroup = (lock: boolean) => {
    const c = chart.current;
    if (!c) return;
    for (const o of groupOf()) c.overrideOverlay({ id: o.id, lock });
    persistDrawings();
    bumpStyle();
  };
  const hideGroup = () => {
    const c = chart.current;
    if (!c) return;
    for (const o of groupOf()) {
      c.overrideOverlay({ id: o.id, visible: false });
      hiddenDrawings.current.add(o.id);
    }
    setMulti([]);
    persistDrawings();
  };
  const deleteGroup = () => {
    const c = chart.current;
    if (!c) return;
    for (const o of groupOf()) c.removeOverlay({ id: o.id });
    setMulti([]);
  };

  // --- right-click menus --------------------------------------------------------
  /** The chart's right-click menu - a drawing's or a study's - at a viewport point. */
  const [ctxMenu, setCtxMenu] = useState<{ at: { x: number; y: number }; items: ChartMenuItem[] } | null>(null);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const openDrawingMenu = (id: string, at: { x: number; y: number }) => {
    const c = chart.current;
    const o = c?.getOverlays({ id })[0];
    if (!c || !o) return;
    if (multiRef.current.length > 1 && multiRef.current.includes(id)) {
      const n = multiRef.current.length;
      const allLocked = groupOf().every((d) => d.lock);
      setCtxMenu({
        at,
        items: [
          { label: `Hide ${n} drawings`, icon: MENU_ICONS.hide, onClick: hideGroup },
          { label: `${allLocked ? 'Unlock' : 'Lock'} ${n} drawings`, icon: allLocked ? MENU_ICONS.unlock : MENU_ICONS.lock, onClick: () => lockGroup(!allLocked) },
          { label: `Delete ${n} drawings`, icon: MENU_ICONS.remove, danger: true, onClick: deleteGroup },
        ],
      });
      return;
    }
    const stack = (dir: 1 | -1) => {
      const zs = userDrawings(c).filter((d) => d.id !== id).map(realZ);
      const z = dir > 0 ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - 1;
      setRealZ(o, z, (zLevel) => c.overrideOverlay({ id, zLevel }));
      persistDrawings();
    };
    const clone = () => {
      // Three bars to the right of the original, so the copy is seen.
      const shift = 3 * intervalToMs(interval);
      const points = o.points
        .filter((p) => typeof p.timestamp === 'number' && typeof p.value === 'number')
        .map((p) => ({ timestamp: (p.timestamp as number) + shift, value: p.value as number }));
      if (points.length === 0) return;
      const copy = c.createOverlay({
        name: o.name,
        points,
        ...(o.styles ? { styles: o.styles } : {}),
        ...(o.extendData !== undefined ? { extendData: o.extendData } : {}),
        mode: drawModes.current.magnet,
        visible: !drawHiddenRef.current,
        ...drawingEvents(),
      });
      persistDrawings();
      if (typeof copy === 'string') {
        selectedDrawing.current = copy;
        setSelected({ id: copy, focusText: false });
      }
    };
    setCtxMenu({
      at,
      items: [
        { label: 'Settings…', icon: MENU_ICONS.settings, onClick: () => drawingSettingsRef.current(id) },
        {
          label: 'Hide',
          icon: MENU_ICONS.hide,
          onClick: () => {
            c.overrideOverlay({ id, visible: false });
            hiddenDrawings.current.add(id);
            setSelected((s) => (s?.id === id ? null : s));
            persistDrawings();
            bumpStyle();
          },
        },
        {
          label: 'Lock',
          icon: MENU_ICONS.lock,
          onClick: () => {
            // A locked drawing takes no pointer at all; "unlock all" on the
            // rail (lit while anything is locked) gives it back.
            c.overrideOverlay({ id, lock: true });
            setSelected((s) => (s?.id === id ? null : s));
            persistDrawings();
            bumpStyle();
          },
        },
        { label: 'Bring to front', icon: MENU_ICONS.front, onClick: () => stack(1) },
        { label: 'Send to back', icon: MENU_ICONS.back, onClick: () => stack(-1) },
        { label: 'Clone', icon: MENU_ICONS.duplicate, onClick: clone },
        { label: 'Delete', icon: MENU_ICONS.remove, danger: true, onClick: () => c.removeOverlay({ id }) },
      ],
    });
  };
  drawingMenuRef.current = openDrawingMenu;

  const openIndicatorMenu = (id: string, at: { x: number; y: number }) => {
    const c = chart.current;
    const ind = byId(id);
    if (!c || !ind) return;
    const list = indicatorsRef.current;
    const panes = paneList(list);
    const own = ind.paneId !== CANDLE_PANE_ID;
    const at0 = panes.indexOf(ind.paneId);
    const shared = list.filter((i) => i.paneId === ind.paneId).length > 1;
    const nameOf = (i: ActiveIndicator) =>
      legendName(i.name, c.getIndicators({ id: i.id })[0]?.calcParams ?? i.spec.calcParams ?? [], i.spec.source);
    const items: ChartMenuItem[] = [
      { label: 'Settings…', icon: MENU_ICONS.settings, onClick: () => setSettingsFor({ id, original: ind.spec }) },
      { label: ind.visible ? 'Hide' : 'Show', icon: ind.visible ? MENU_ICONS.hide : MENU_ICONS.show, onClick: () => toggleIndicator(id) },
    ];
    if (own) {
      items.push(
        { label: 'Move pane up', icon: MENU_ICONS.up, disabled: at0 <= 0, onClick: () => moveIndicator(id, -1) },
        { label: 'Move pane down', icon: MENU_ICONS.down, disabled: at0 < 0 || at0 >= panes.length - 1, onClick: () => moveIndicator(id, 1) },
      );
    }
    if (!own || shared) items.push({ label: 'Move to a new pane', icon: MENU_ICONS.newPane, onClick: () => moveIndicatorTo(id, 'new') });
    if (own) items.push({ label: 'Move to the main chart', icon: MENU_ICONS.mainChart, onClick: () => moveIndicatorTo(id, 'main') });
    for (const p of panes) {
      if (p === ind.paneId) continue;
      const first = list.find((i) => i.paneId === p);
      if (first) items.push({ label: `Move to the pane with ${nameOf(first)}`, icon: MENU_ICONS.intoPane, onClick: () => moveIndicatorTo(id, first.id) });
    }
    items.push({ label: 'Remove', icon: MENU_ICONS.remove, danger: true, onClick: () => removeIndicator(id) });
    setCtxMenu({ at, items });
  };

  // Delete / Backspace removes the drawing that was clicked last, as in every
  // charting terminal. Never an order line, never a locked drawing, and never
  // while a text field has the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && multiRef.current.length) {
        setMulti([]);
        return;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const c = chart.current;
      // A group: every drawing in it that is not locked, as for one.
      if (c && multiRef.current.length) {
        e.preventDefault();
        for (const id of multiRef.current) {
          const o = c.getOverlays({ id })[0];
          if (o && !SYSTEM_OVERLAYS.has(o.name) && !o.lock) c.removeOverlay({ id });
        }
        setMulti([]);
        return;
      }
      const id = selectedDrawing.current;
      if (!c || !id) return;
      const o = c.getOverlays({ id })[0];
      if (!o || SYSTEM_OVERLAYS.has(o.name) || o.lock) return;
      e.preventDefault();
      c.removeOverlay({ id });
      selectedDrawing.current = null;
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /** Auto-fit was on when the rail started moving, so the end can give it back. */
  const railWasAuto = useRef(false);
  const onRailMotion = useCallback((phase: 'start' | 'end') => {
    const c = chart.current;
    const axis = c && priceAxis(c);
    if (!c || !axis) return;
    if (phase === 'end') {
      if (railWasAuto.current) resumeAutoFit(c, axis);
      railWasAuto.current = false;
      return;
    }
    railWasAuto.current = isAutoFit(axis);
    // Reduced motion skips the width transition, so there is no end event to
    // put auto-fit back. A short timer covers that, and a normal transition
    // ends first and clears the flag.
    if (!railWasAuto.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    holdRange(axis);
    window.setTimeout(() => {
      const live = chart.current;
      const ax = live && priceAxis(live);
      if (railWasAuto.current && live && ax) resumeAutoFit(live, ax);
      railWasAuto.current = false;
    }, 280);
  }, []);
  const cancelDrawing = useCallback(() => {
    const c = chart.current;
    if (c && drawingId.current) c.removeOverlay({ id: drawingId.current });
    drawingId.current = null;
    setDrawing(null);
  }, []);

  const clearDrawings = useCallback(() => {
    const c = chart.current;
    if (!c) return;
    // NOT `removeOverlay()` with no filter: that removes EVERY overlay, order
    // lines included, and a "clear drawings" click that silently wipes your
    // resting orders off the chart is the kind of thing you only notice after
    // you have stopped watching a stop-loss.
    for (const o of c.getOverlays()) {
      if (!SYSTEM_OVERLAYS.has(o.name)) c.removeOverlay({ id: o.id });
    }
    drawingId.current = null;
    selectedDrawing.current = null;
    setDrawing(null);
    setSelected(null);
    setOpenMenu(null);
    persistDrawings();
  }, [persistDrawings]);

  // Escape disarms. With the tools on a rail rather than behind a dropdown it is
  // much easier to leave one armed by accident, and an armed overlay silently
  // eats the next click on the chart — including a click the user meant for an
  // order line. The keyboard out has to exist, and it has to be the key everyone
  // already tries. A path in progress is finished instead (Enter too), at its
  // last click - or dropped, when that leaves fewer than two points.
  useEffect(() => {
    if (!drawing) return;
    const onKey = (e: KeyboardEvent) => {
      if (drawing === PATH && (e.key === 'Escape' || e.key === 'Enter')) {
        finishPath();
        return;
      }
      if (e.key === 'Escape') cancelDrawing();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawing, cancelDrawing, finishPath]);

  // --- right-click: the chart's menu ------------------------------------------

  /**
   * The chart's menu at a viewport point: "Who traded this candle" and the
   * order prefills at the price under the pointer, then the chart's settings
   * (the price source, the scale), which have no switches on the chart itself
   * (owner 2026-11-02). A long press opens it on touch.
   *
   * klinecharts already calls preventDefault on the canvas's contextmenu event
   * but does not stop it propagating, so this DOM handler still sees it — and it
   * sees it for clicks on an order line too, where the overlay's own
   * onRightClick has meanwhile stopped the library deleting that line.
   */
  const openChartMenu = (x: number, y: number): boolean => {
    const c = chart.current;
    const el = holder.current;
    if (!ready || !c || !el || drawing) return false;
    const items: ChartMenuItem[] = [];

    // Only the candle pane's own y-axis carries a price. A right-click down in
    // a volume or MACD pane would convert against THAT pane's scale and name a
    // number that is not a price at all. Nothing to place while the plot is masked.
    const rect = el.getBoundingClientRect();
    const py = y - rect.top;
    const pane = c.getSize(CANDLE_PANE_ID);
    if (!maskedRef.current && pane && py >= pane.top && py <= pane.top + pane.height) {
      const pt = c.convertFromPixel([{ x: x - rect.left, y: py }], { paneId: CANDLE_PANE_ID, absolute: true }) as Array<Partial<Point>>;
      // A read-only session is offered only "Who traded this candle": every
      // other prefill is a step towards signing an order.
      const price = canPlace ? snapToTick(pt[0]?.value ?? Number.NaN, sym?.tickSize) : null;
      const t = !bare && typeof pt[0]?.timestamp === 'number' && Number.isFinite(pt[0].timestamp) ? pt[0].timestamp : null;
      if (t !== null) items.push({ label: 'Who traded this candle', icon: MENU_ICONS.traders, onClick: () => { pickFlow(t, null); setFlowOpen(true); } });
      // The touch way to a range (and the right-click one): from the picked candle to this one.
      if (t !== null && flowOpen && candleAt(interval, t).from !== flowSpan(interval, flowAt, null).from) {
        const anchor = flowSpan(interval, flowAt, null).from;
        items.push({ label: 'Who traded from the picked candle to here', icon: MENU_ICONS.traders, onClick: () => pickFlow(anchor, t) });
      }
      if (price !== null) {
        const note = 'Prefills the order price only. Nothing is submitted from here.';
        items.push(
          { head: `At ${fmtPrice(price, sym?.tickSize)}`, label: 'Limit buy here', icon: MENU_ICONS.limitBuy, title: note, onClick: () => prefill('buy', price) },
          { label: 'Limit sell here', icon: MENU_ICONS.limitSell, title: note, onClick: () => prefill('sell', price) },
          { label: 'Stop here', icon: MENU_ICONS.stop, title: note, onClick: () => prefill('stop', price) },
        );
      }
    }

    // A bare chart (the heatmap's history) is always the traded price: no source to pick.
    if (!bare) {
      for (const s of ['latest', 'mark', 'index'] as const) {
        const off = s !== 'latest' && !sourceOk;
        items.push({
          head: s === 'latest' ? 'Price source' : undefined,
          label: SOURCE_LABEL[s],
          checked: src === s,
          radio: true,
          title: off ? markIndexNotice(engine, interval) : SOURCE_HINT[s],
          // A source this timeframe cannot serve stays pickable, and says why it is not shown.
          onClick: () => (off ? notify('info', markIndexNotice(engine, interval)) : setPriceSource(s)),
        });
      }
    }
    items.push(
      { head: 'Scale', label: 'Auto fit', checked: scale.auto, title: 'Fits the price axis to the candles on screen', onClick: toggleAuto },
      { label: 'Percentage', checked: scale.mode === 'percentage', onClick: () => dispatchScale({ type: 'percent' }) },
      { label: 'Logarithmic', checked: scale.mode === 'logarithm', onClick: () => dispatchScale({ type: 'log' }) },
    );
    setCtxMenu({ at: { x, y }, items });
    return true;
  };

  /** A long press (touch) that opened the menu, so the native contextmenu that may follow does not reopen it. */
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  const pressedAt = useRef(0);
  const endPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  const onPanePointerDown = (e: ReactPointerEvent) => {
    endPress();
    flowDown.current = e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
    // A bare chart's long press is its host's (the heatmap's hover card); its right-click stays the menu.
    if (e.pointerType !== 'touch' || bare) return;
    const { clientX: x, clientY: y } = e;
    press.current = {
      x,
      y,
      timer: window.setTimeout(() => {
        press.current = null;
        if (!openChartMenu(x, y)) return;
        pressedAt.current = performance.now();
        // The finger lifting off is a click under it, in the menu that just opened: not a pick.
        const swallow = (ev: MouseEvent) => {
          ev.preventDefault();
          ev.stopPropagation();
        };
        window.addEventListener('click', swallow, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 800);
      }, LONG_PRESS_MS),
    };
  };
  /**
   * Drag the panel's edge: its width beside the plot, its height where it sits under the plot (a
   * narrow card, chart.css). Written to the element while dragging, so the chart does not re-render
   * per move; stored on release. Double-click the edge for the default.
   */
  const onFlowResize = (e: ReactPointerEvent) => {
    const el = flowWrap.current;
    const host = el?.parentElement;
    if (!el || !host || e.button !== 0) return;
    e.preventDefault();
    const under = el.classList.contains('is-under');
    const box = host.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, w: el.offsetWidth, h: el.offsetHeight };
    let next = { ...flowSize };
    const move = (ev: PointerEvent) => {
      if (under) {
        const h = Math.min(0.85, Math.max(0.3, (start.h + start.y - ev.clientY) / box.height));
        next = { ...next, h };
        el.style.setProperty('--flow-h', `${h * 100}%`);
      } else {
        const w = Math.round(Math.min(Math.max(340, box.width - 320), Math.max(340, start.w + start.x - ev.clientX)));
        next = { ...next, w };
        el.style.setProperty('--flow-w', `${w}px`);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('kc-flow-resizing');
      setFlowSize(next);
    };
    document.body.classList.add('kc-flow-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  /** Beside the plot, or under it where the card is too narrow for both. */
  const [flowUnder, setFlowUnder] = useState(false);
  const [flowEl, setFlowEl] = useState<HTMLDivElement | null>(null);
  const flowRef = useCallback((el: HTMLDivElement | null) => {
    flowWrap.current = el;
    setFlowEl(el);
  }, []);
  useEffect(() => {
    // The dock is in the body (under) or in the stage inside it (beside): the body either way.
    const body = flowEl?.closest('.kc-body');
    if (!body) return;
    const fit = () => setFlowUnder(body.clientWidth < FLOW_UNDER_PX);
    // Measured now too: the observer's first call waits for a frame, and a frame of the wrong place shows.
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(body);
    return () => ro.disconnect();
  }, [flowEl]);
  const flowDock = (under: boolean) => (
    <div
      ref={flowRef}
      className={`kc-flow-wrap${under ? ' is-under' : ''}`}
      style={{ '--flow-w': `${flowSize.w}px`, '--flow-h': `${flowSize.h * 100}%` } as CSSProperties}
    >
      <div
        className="kc-flow-grip"
        role="separator"
        aria-orientation={under ? 'horizontal' : 'vertical'}
        aria-label="Resize Who traded"
        title="Drag to resize (double-click: default size)"
        onPointerDown={onFlowResize}
        onDoubleClick={() => setFlowSize({ w: 460, h: 0.45 })}
      />
      <Suspense fallback={<div className="kc-flow-wait" aria-busy="true" />}>
        <TradeFlowView symbol={symbol} spot={engine === 'spot'} interval={interval} at={flowAt} end={flowEnd} onPick={pickFlow} onClose={() => setFlowOpen(false)} />
      </Suspense>
    </div>
  );
  /** The candle time under a viewport x (null off the series or in the future). */
  const flowTimeAt = (clientX: number): number | null => {
    const c = chart.current;
    const el = holder.current;
    const pane = c?.getSize(CANDLE_PANE_ID);
    if (!c || !el || !pane) return null;
    const rect = el.getBoundingClientRect();
    const pt = c.convertFromPixel([{ x: clientX - rect.left, y: pane.top + 1 }], { paneId: CANDLE_PANE_ID, absolute: true }) as Array<Partial<Point>>;
    const t = pt[0]?.timestamp;
    return typeof t === 'number' && Number.isFinite(t) ? Math.min(t, Date.now()) : null;
  };
  /** The candle under a click, for Who traded: a press that did not move and was not held. Cmd/Ctrl extends the pick. */
  const pickFlowCandle = (e: ReactPointerEvent) => {
    const d = flowDown.current;
    flowDown.current = null;
    if (!flowOpen || !d || drawing || maskedRef.current) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || performance.now() - d.t > 450) return;
    const t = flowTimeAt(e.clientX);
    if (t === null) return;
    if (e.metaKey || e.ctrlKey) pickFlow(flowSpan(interval, flowAt, null).from, t);
    else pickFlow(t, null);
  };
  /**
   * Shift-drag across the plot: a range of candles, outlined while it is dragged. Taken in the capture
   * phase, before the chart's own pan sees the press, so a plain drag keeps panning.
   */
  const onFlowDragStart = (e: ReactPointerEvent) => {
    if (!flowOpen || !e.shiftKey || e.button !== 0 || e.pointerType === 'touch' || drawing || maskedRef.current) return;
    const t0 = flowTimeAt(e.clientX);
    if (t0 === null) return;
    e.preventDefault();
    e.stopPropagation();
    flowDown.current = null;
    let t1 = t0;
    const move = (ev: PointerEvent) => {
      const t = flowTimeAt(ev.clientX);
      if (t === null || candleAt(interval, t).from === candleAt(interval, t1).from) return;
      t1 = t;
      showFlowPick(flowSpan(interval, t0, t1));
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      document.body.classList.remove('kc-flow-picking');
      pickFlow(t0, candleAt(interval, t1).from === candleAt(interval, t0).from ? null : t1);
    };
    document.body.classList.add('kc-flow-picking');
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  };
  const onPanePointerMove = (e: ReactPointerEvent) => {
    const p = press.current;
    // A pan or a crosshair drag, not a press.
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) endPress();
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    endPress();
    // The right-click landed on a drawing: its menu opens, not this one.
    const pend = pendingDrawingMenu.current;
    if (pend && performance.now() - pend.t < 700) {
      pendingDrawingMenu.current = null;
      e.preventDefault();
      drawingMenuRef.current(pend.id, { x: e.clientX, y: e.clientY });
      return;
    }
    // A long press already opened it (Android sends its own contextmenu after one).
    if (performance.now() - pressedAt.current < 1000) {
      e.preventDefault();
      return;
    }
    if (openChartMenu(e.clientX, e.clientY)) e.preventDefault();
  };

  /**
   * Hand a price to the order ticket. This is the whole of what a menu pick
   * does — the ticket's own Buy/Sell buttons remain the only thing that submits
   * anything, and the note rendered afterwards says exactly which fields were
   * and were not filled in.
   */
  const prefill = useCallback(
    (kind: 'buy' | 'sell' | 'stop', price: string) => {
      onPrice?.(price);
      setTicket({ kind, price });
    },
    [onPrice],
  );

  // --- drag to modify --------------------------------------------------------

  const cancelPending = useCallback(() => {
    if (pending) abandon(pending.line.key);
    setPending(null);
  }, [pending, abandon]);

  /** The only path in this file that sends anything. */
  const confirmPending = useCallback(async () => {
    const p = pending;
    const l = layer.current;
    if (!p || !l || p.line.orderID === undefined) return;

    // Re-check the gate at the moment of sending, not just when the line was
    // drawn: the session can lock between a drop and a click.
    if (!canModify) {
      abandon(p.line.key);
      showLine('err', modifyBlocked ?? 'Modifying orders is not available here.');
      return;
    }

    // Everything NOT being changed is re-sent verbatim from the strings the
    // gateway gave us — including the OTHER leg of a stop-limit order, so that
    // moving one price can never be read by the venue as clearing the other.
    // Only the dragged leg carries a new value, and it is already on the tick
    // grid, so the number in the confirm box is the number that gets signed.
    const body: { symbol: string; orderID?: number; quantity?: string; price?: string; stopPrice?: string } = {
      symbol: p.line.symbol,
      orderID: p.line.orderID,
    };
    if (p.line.quantity) body.quantity = p.line.quantity;
    if (p.line.kind === 'trigger') {
      body.stopPrice = p.price;
      if (p.line.restPrice) body.price = p.line.restPrice;
    } else {
      body.price = p.price;
      if (p.line.stopPrice) body.stopPrice = p.line.stopPrice;
    }

    setSending(true);
    setPending(null);
    setAwaiting(p);
    // Hold the line at the submitted price, drawn as pending, until the venue
    // reports it back. `hold` tells the layer what to watch for.
    l.place(p.line.key, p.price, 'sending');
    l.hold(p.line.key, p.price);
    try {
      // The one way the app changes an order (trading/actions.ts changeOrder): modify for a take-profit /
      // stop-loss, replace for a plain limit order - or cancel + new where that could drop the builder fee.
      const r = await api.changeOrder(engine, { symbol: body.symbol, orderID: body.orderID }, { price: body.price, quantity: body.quantity, stopPrice: body.stopPrice });
      if (r.route === 'recreate' || r.route === 'replace') {
        // A NEW order (new id) replaced this one - SoDEX's replace request creates one too
        // (trading/feeGuard.ts): there is no line to wait for, the new one is drawn on the
        // next read. Waiting would end in "no longer open" for an order that moved.
        abandon(p.line.key);
        showLine('ok', r.route === 'recreate'
          ? `Order moved: it was cancelled and placed again at ${fmtPrice(p.price, sym?.tickSize)}.`
          : `Order moved: SoDEX replaced it with a new order at ${fmtPrice(p.price, sym?.tickSize)}.`);
        onChanged?.();
        refreshOrders();
        return;
      }
      showLine('info', `Modify submitted — waiting for the venue to confirm ${fmtPrice(p.price, sym?.tickSize)}.`);
      onChanged?.();
      refreshOrders();
      // A submitted modify that is never reported back is not a success. Give up
      // after a bounded wait and put the line on the last confirmed price, so
      // the chart never claims an order is somewhere the venue never said it is.
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => {
        abandon(p.line.key);
        // 'err', not a softer kind: an unconfirmed modify is an open question
        // about where a live order is resting, and the user has to go and look.
        showLine(
          'err',
          `The venue has not reported ${p.line.label} at ${fmtPrice(p.price, sym?.tickSize)} yet. The line is back on the last confirmed price — check Open orders before assuming it moved.`,
        );
      }, SETTLE_TIMEOUT_MS);
    } catch (err) {
      abandon(p.line.key);
      lineError(err);
    } finally {
      setSending(false);
    }
  }, [pending, canModify, modifyBlocked, engine, sym?.tickSize, onChanged, refreshOrders, abandon, showLine, lineError]);

  const change = legendBar ? legendBar.close - legendBar.open : 0;
  /** Direction class for the whole OHLC row — one reading, one colour. */
  const dir = signClass(change);
  // Whether the selected interval is one of the buttons in the strip. When it is
  // not, the overflow chevron is carrying the selection and takes the amber.
  const quickInterval = QUICK_INTERVALS.includes(interval as (typeof QUICK_INTERVALS)[number]);
  // Mutually exclusive by construction: a drop clears `drag` and sets `pending`,
  // a confirm clears `pending` and sets `awaiting`.
  const active = drag ?? pending ?? awaiting;
  interacting.current = active !== null;

  // What the plot shows. `feed` describes the series it was last told about;
  // until that is the series on screen - the very first frame after a click on
  // a timeframe - the answer is "loading", so a switch masks immediately.
  const wantKey = feedKey(engine, seriesTicker, interval);
  const shownFeed: FeedView = initFailed
    ? { phase: 'error', failures: initFailed.failures, nextRetryAt: initFailed.nextRetryAt, error: initFailed.error }
    : !ready || feed.key !== wantKey
      ? FEED_LOADING
      : feed;
  const guarded = guard !== null && guard === wantKey;
  const masked = shownFeed.phase !== 'ready' || guarded;
  maskedRef.current = masked;

  // --- the chart's own marks: executions and news (chartMarks.ts) ------------
  /** The bar a moment falls in, from the loaded bars (null outside them). */
  const barLookup = (ts: number): number | null => {
    const list = chart.current?.getDataList() ?? [];
    if (list.length === 0 || ts < list[0]!.timestamp) return null;
    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid]!.timestamp <= ts) lo = mid;
      else hi = mid - 1;
    }
    const last = list.length - 1;
    // Past the newest bar by more than a bar: not loaded, the arithmetic decides.
    if (lo === last && ts >= list[last]!.timestamp + 2 * intervalToMs(interval)) return null;
    return list[lo]!.timestamp;
  };
  /** A hovered or clicked mark: its tip (executions) or its story list (news). */
  const [markTip, setMarkTip] = useState<{ kind: 'exec'; mark: FillMark; x: number; y: number } | null>(null);
  const markAt = (e: OverlayEvent<unknown>) => ({ x: (e.pageX ?? 0) - window.scrollX, y: (e.pageY ?? 0) - window.scrollY });

  // The account's fills on this market: one read per market, wallet and
  // account change - through the exchange layer's background queue, so it
  // waits behind every table on screen.
  const [fills, setFills] = useState<unknown[]>([]);
  useEffect(() => {
    if (!address) {
      setFills([]);
      return;
    }
    const ctl = new AbortController();
    sodexAccount
      .trades(engine, address, { symbol, limit: 200, priority: 'background', signal: ctl.signal })
      .then((r) => {
        if (!ctl.signal.aborted) setFills(r.trades);
      })
      .catch(() => {
        /* no arrows this time; the next account change asks again */
      });
    return () => ctl.abort();
  }, [address, engine, symbol, refreshToken]);

  useEffect(() => {
    const c = chart.current;
    if (!ready || !c) return;
    c.removeOverlay({ name: EXEC_OVERLAY });
    setMarkTip((t) => (t?.kind === 'exec' ? null : t));
    const rows = snapView ? snapshotFills(snapView) : show.executions ? fills : [];
    if (masked || rows.length === 0) return;
    for (const m of fillMarks(rows, symbol, interval, barLookup)) {
      c.createOverlay({
        name: EXEC_OVERLAY,
        points: [{ timestamp: m.timestamp, value: m.price }],
        extendData: m,
        lock: true,
        onRightClick: (e) => e.preventDefault?.(),
        // klinecharts 10 never calls onMouseEnter for these (measured); the
        // first move over the arrow opens its tip instead.
        onMouseMove: (e) => setMarkTip((t) => (t?.kind === 'exec' && t.mark.key === m.key ? t : { kind: 'exec', mark: m, ...markAt(e) })),
        onMouseLeave: () => setMarkTip((t) => (t?.kind === 'exec' && t.mark.key === m.key ? null : t)),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, chartGen, fills, show.executions, symbol, interval, masked, wantKey, snapView]);

  // The candles Who traded is breaking down, outlined on the plot while the panel is open.
  const showFlowPick = (w: { from: number; to: number } | null) => {
    const c = chart.current;
    if (!c) return;
    c.removeOverlay({ name: FLOW_PICK_OVERLAY });
    if (!w) return;
    const last = candleAt(interval, w.to - 1).from;
    c.createOverlay({ name: FLOW_PICK_OVERLAY, points: [{ timestamp: w.from, value: 0 }, { timestamp: last, value: 0 }], lock: true, zLevel: -1 });
  };
  useEffect(() => {
    if (!ready || !chart.current) return;
    showFlowPick(flowOpen && !bare && !masked ? flowSpan(interval, flowAt, flowEnd) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, chartGen, flowOpen, flowAt, flowEnd, interval, bare, masked]);

  // News: this coin's stories, or the macro ones, as far back as the server
  // keeps them (history: up to SoSoValue's 7 days, hot ones ranked) - one read
  // per market and choice (the server caches it a minute), again every ten minutes.
  const coin = newsCoin(sym?.baseCoin);
  const news = useAsync(
    () =>
      show.newsScope === 'macro' ? vsApi.news({ feed: 'latest', topic: 'macro', limit: 300, history: 1 })
      : show.newsScope === 'all' ? vsApi.news({ feed: 'latest', limit: 300, history: 1 })
      : vsApi.news({ feed: 'latest', coin, limit: 300, history: 1 }),
    [show.newsScope, coin],
    { enabled: show.news && (show.newsScope !== 'coin' || !!coin), pollMs: 10 * 60_000 },
  );
  // The economic calendar (the Fed, BLS, BEA, SoSoValue): the official calendars
  // reach back to last December - eleven months back, two ahead, from the day's
  // start so the address (and the CDN's copy) holds all day; read again hourly.
  const cal = useAsync(
    () => {
      const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
      return vsApi.calendar({ from: day - 330 * 86_400_000, to: day + 61 * 86_400_000 });
    },
    [],
    { enabled: show.news && show.calendar, pollMs: 60 * 60_000 },
  );
  /** The stories on the bars they came out in (NewsMarkers.tsx places and merges them). */
  const newsList = useMemo(
    () =>
      !show.news || masked ? []
      : newsMarks(
          [
            ...((news.data?.items ?? []) as NewsStory[]).filter((n) => show.newsKinds.includes(newsKind(n))),
            ...(show.calendar ? calendarStories(cal.data?.events ?? [], cal.data?.sourceNames ?? {}, show.calendarMinor) : []),
          ],
          interval,
          barLookup,
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [news.data, cal.data, show.news, show.newsKinds.join(), show.calendar, show.calendarMinor, interval, masked, wantKey],
  );
  /** The markers stay a moment as news goes off, to fade out. */
  const newsLayer = useLatched(newsList.length ? newsList : null, 200);
  /** A story into a knowledge folder, as the News widget saves one. */
  const saveStory = async (n: NewsStory) => {
    const saved = await saveToFolder({
      kind: 'news',
      title: n.title.length > 120 ? `${n.title.slice(0, 117)}…` : n.title,
      data: { id: n.id, title: n.title, href: n.href, time: n.time, author: n.author ?? null, symbols: n.symbols ?? [], summary: n.summary ?? null, ...(n.post ? { post: true } : {}) },
    });
    if (saved) notify('ok', 'Story saved to the folder');
  };

  // --- snapshot: this chart for a research folder, and back (chart/snapshot.ts) -
  /** A range to show once the snapshot's bars are on screen. */
  const pendingView = useRef<{ key: string; from: number; to: number } | null>(null);
  const captureImage = (): string | null => {
    try {
      return chart.current?.getConvertPictureUrl(true, 'png', T.bg) ?? null;
    } catch {
      return null;
    }
  };
  /** The position and fills an export can freeze: the snapshot's own while one shows. */
  const exportPositions = snapView ? snapshotPosition(snapView) : address && engine === 'perps' ? (positions.data?.positions ?? []) : [];
  const exportFills = snapView ? snapshotFills(snapView) : fills;
  const exportOf = (include: { position: boolean; executions: boolean }): ChartSnapshot | null => {
    const c = chart.current;
    if (!c) return null;
    const list = c.getDataList();
    const range = c.getVisibleRange();
    const first = list[Math.max(0, Math.min(list.length - 1, range.realFrom))];
    const last = list[Math.max(0, Math.min(list.length - 1, range.realTo - 1))];
    return buildSnapshot(
      {
        engine,
        symbol,
        interval,
        priceSource: src,
        range: first && last ? { from: first.timestamp, to: last.timestamp } : null,
        drawings: userDrawings(c)
          .filter((o) => o.id !== drawingId.current)
          .map((o) => toStored(o, hiddenDrawings.current.has(o.id)))
          .filter((d): d is StoredDrawing => d !== null),
        indicators: indicatorsRef.current.map((i) => ({ ...i.spec, visible: i.visible, pane: i.paneId === CANDLE_PANE_ID ? 'main' : i.paneId })),
        position: frozenPosition(exportPositions, symbol),
        fills: exportFills,
        at: Date.now(),
      },
      include,
    );
  };
  /** Save: into a folder through the folders' picker, or - without folders - as a file. */
  const exportChart = async (include: { position: boolean; executions: boolean }) => {
    const snap = exportOf(include);
    if (!snap) return;
    const title = `${sym?.displayName ?? symbol} · ${intervalLabel(interval)} · ${new Date(snap.at).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    if (!folders) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = snapshotFileName(snap);
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportOpen(false);
      return;
    }
    setExportBusy(true);
    const thumb = await thumbOf(captureImage());
    // The folders' picker takes it from here (it may ask the wallet to sign in).
    setExportOpen(false);
    const saved = await saveToFolder({ kind: 'chart', title, data: snap, ...(thumb ? { thumb } : {}) });
    setExportBusy(false);
    if (saved) notify('ok', `Saved ${title} to the folder`);
  };

  /** Show a snapshot of this market as the snapshot view. */
  const openHere = (snap: ChartSnapshot) => {
    if (!snapViewRef.current) beforeSnap.current = { interval, priceSource };
    snapViewRef.current = snap;
    setSnapView(snap);
    setSelected(null);
    setDrawingSettings(null);
    const to = PERIOD_BY_INTERVAL[snap.interval] ? snap.interval : interval;
    const source: PriceSource = snap.priceSource ?? 'latest';
    if (to !== interval) setIntervalValue(to);
    setPriceSource(source);
    setIndGen((g) => g + 1);
    setDrawGen((g) => g + 1);
    const shownSource = source !== 'latest' && engine === 'perps' && !NO_MARK_INDEX.has(to) ? source : 'latest';
    pendingView.current = snap.range ? { key: feedKey(engine, shownSource === 'latest' ? symbol : `${symbol}@${shownSource}`, to), ...snap.range } : null;
  };
  /** Keep: the snapshot's drawings and studies become the user's. Close: the user's come back. */
  const closeSnapshot = (keep: boolean) => {
    if (!snapViewRef.current) return;
    snapViewRef.current = null;
    setSnapView(null);
    const before = beforeSnap.current;
    beforeSnap.current = null;
    if (keep) {
      persistDrawings();
      commitIndicators(indicatorsRef.current);
      return;
    }
    if (before) {
      if (before.interval !== interval) setIntervalValue(before.interval);
      setPriceSource(before.priceSource);
    }
    pendingView.current = null;
    setIndGen((g) => g + 1);
    setDrawGen((g) => g + 1);
  };
  const snapRef = useRef({ open: openHere, engine, symbol });
  snapRef.current = { open: openHere, engine, symbol };
  const liveChart = useRef<LiveChart | null>(null);
  if (!liveChart.current) {
    liveChart.current = {
      engine: () => snapRef.current.engine,
      symbol: () => snapRef.current.symbol,
      open: (snap) => snapRef.current.open(snap),
    };
  }
  useEffect(() => registerLiveChart(liveChart.current!), []);
  // A snapshot opened from a folder while this market's chart was not on screen.
  useEffect(() => {
    if (!ready) return;
    const snap = takePendingSnapshot(engine, symbol);
    if (snap) openHere(snap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, engine, symbol]);
  // The snapshot's range, once its bars are on screen.
  useEffect(() => {
    const c = chart.current;
    const v = pendingView.current;
    if (!c || !v || masked || v.key !== wantKey) return;
    pendingView.current = null;
    const list = c.getDataList();
    const bars = Math.max(1, list.filter((b) => b.timestamp >= v.from && b.timestamp <= v.to).length);
    const width = c.getSize(CANDLE_PANE_ID)?.width ?? 0;
    if (width > 0) c.setBarSpace(Math.max(1, Math.min(50, width / (bars + DEFAULT_OFFSET_RIGHT / 4))));
    c.scrollToTimestamp(v.to);
  }, [masked, wantKey]);

  // A stays off across a new series or scale type (the owner's rule: only the
  // user switches A). klinecharts refits the rebuilt or reloaded axis; once
  // real bars are on screen, hold that fit so the axis is manual again.
  useEffect(() => {
    if (!pinAfterLoad.current || masked || shownFeed.phase !== 'ready') return;
    const c = chart.current;
    if (!c || c.getDataList().length === 0) return;
    const id = requestAnimationFrame(() => {
      // A glide is carrying the axis onto the new fit. Holding now would
      // freeze it; the glide pins the landed range when A is off.
      if (fit.current?.moving) return;
      const axis = priceAxis(c);
      if (!axis || autoRef.current) {
        pinAfterLoad.current = false;
        return;
      }
      const r = axis.getRange();
      // Never hold an empty or invalid range (e.g. klinecharts' 0-10 default).
      if (![r.from, r.to].every(Number.isFinite) || !(r.to > r.from)) return;
      pinAfterLoad.current = false;
      if (isAutoFit(axis) && holdRange(axis)) log.debug('autoscale stays off: holding the fit of the new series or scale', { from: r.from, to: r.to });
    });
    return () => cancelAnimationFrame(id);
  });
  // The candle layer: the skeleton under every masked state that is waiting
  // for bars (not 'empty' - there are none coming), then the arrival.
  const candleLayer: CandleLayerState =
    arrival !== null && arrival.key === wantKey && !masked
      ? arrival.mode
      : masked && shownFeed.phase !== 'empty'
        ? 'skeleton'
        : 'off';
  // A switch keeps the chart's frame - grid, price and time axes - on screen
  // while the candles wait for the new series in grey (chart/switchFrame.ts):
  // the plot is not faded out. Only while the new series is on its way, the
  // old one's bars are still with the library, and the candle layer is the
  // one restyling them (the same test CandleMorph opens its morph out on).
  const keepFrame =
    masked &&
    !guarded &&
    (shownFeed.phase === 'loading' || shownFeed.phase === 'retrying') &&
    candleLayer === 'skeleton' &&
    morphable(candleStyle) &&
    !prefersReducedMotion() &&
    (chart.current?.getDataList().length ?? 0) > 0;
  const endArrival = () => {
    showCandles();
    setArrival((a) => (a?.key === wantKey ? null : a));
  };
  // Room for the loading market's price axis, which klinecharts sizes to its
  // labels - the last price at the symbol's precision, give or take.
  const priceHint = () => {
    const price = Number.parseFloat(lastPriceRef.current ?? '');
    return price > 0 && sym ? { price, precision: precisionOf(sym.tickSize) } : null;
  };
  const retryNow = () => {
    if (initFailed) {
      setInitAttempt((n) => n + 1);
      return;
    }
    loadHandle.current?.retryNow();
  };

  /** What the guard's error snapshot reports, as of this render. */
  const diag = useRef({ engine, symbol, interval, wantKey, feed, health: health.health, scale: scale.mode, layer: candleLayer });
  diag.current = { engine, symbol, interval, wantKey, feed, health: health.health, scale: scale.mode, layer: candleLayer };

  /*
   * THE GUARD. Before the first frame that shows the plot, and every half
   * second while it is shown, the plot must show something true (invariant.ts).
   * If it does not - whatever the path that got it there - the placeholders
   * go back up, the console gets an error with everything needed to find the
   * path, and the series reloads (the load's own backoff applies; repeated
   * violations back off too).
   */
  useLayoutEffect(() => {
    if (masked || !ready) return;
    const check = (when: 'unmask' | 'watch') => {
      const c = chart.current;
      if (!c) return;
      const d = diag.current;
      const plot = readPlot(c, d.layer !== 'off');
      // A price-axis move in progress may start from a range away from the
      // bars (a dragged axis easing home): not a fault.
      if (fit.current?.moving) plot.auto = false;
      const v: Violation | null = plotViolation(plot);
      if (!v) return;
      const key = d.wantKey;
      guardCount.current += 1;
      log.error('the plot was about to show nothing true: masked, reloading the series', {
        violation: v,
        when,
        engine: d.engine,
        symbol: d.symbol,
        interval: d.interval,
        key,
        generation: loadSeq.current,
        chart: chartGen,
        bars: plot.bars,
        visibleRange: c.getVisibleRange(),
        yRange: plot.range,
        autoscale: plot.auto,
        scale: d.scale,
        barsInView: plot.low === null ? null : { low: plot.low, high: plot.high },
        candlesHidden: plot.candlesHidden,
        layer: d.layer,
        feed: { key: d.feed.key, phase: d.feed.phase, failures: d.feed.failures, error: d.feed.error },
        health: d.health,
        series: series.current?.key ?? null,
        loading: loadingKey.current || null,
        occurrence: guardCount.current,
        recent: recentLogs()
          .filter((e) => e.ns === 'chart')
          .slice(-15)
          .map((e) => `${new Date(e.t).toISOString().slice(11, 23)} ${e.level} ${e.msg}`),
      });
      setGuard(key);
      window.clearTimeout(guardTimer.current);
      guardTimer.current = window.setTimeout(() => {
        if (diag.current.wantKey !== key) return;
        // Reload from scratch: a fresh request, the new-series path.
        series.current = null;
        primed.current = null;
        loadHandle.current?.cancel();
        loadHandle.current = null;
        loadingKey.current = '';
        applied.current = { period: '', symbol: '' };
        setReload((n) => n + 1);
      }, retryDelayMs(guardCount.current - 1));
    };
    check('unmask');
    const id = window.setInterval(() => check('watch'), 500);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masked, ready, wantKey, chartGen, candleLayer]);
  useEffect(() => () => window.clearTimeout(guardTimer.current), []);

  const settingsInd = settingsFor ? indicators.find((i) => i.id === settingsFor.id) : undefined;
  const selDrawing = selected ? chart.current?.getOverlays({ id: selected.id })[0] : undefined;
  const selPaint = selDrawing ? paintOf(selDrawing) : null;
  /*
   * Where the style bar sits: the top centre of the plot - unless a handle of
   * the drawing is up there, where the bar would cover the very point to be
   * grabbed. Then it sits at the foot of the price pane instead (and back at
   * the top if handles are at both).
   */
  const styleBarTop = (() => {
    const c = chart.current;
    if (!c || !selDrawing || selDrawing.points.length === 0) return undefined;
    const pane = c.getSize(CANDLE_PANE_ID);
    if (!pane) return undefined;
    const px = c.convertToPixel(
      selDrawing.points.map((p) => ({ timestamp: p.timestamp, value: p.value })),
      { paneId: CANDLE_PANE_ID },
    ) as Array<{ x?: number; y?: number }>;
    const ys = px.map((p) => p.y).filter((y): y is number => typeof y === 'number' && Number.isFinite(y));
    const BAND = 56;
    const atTop = ys.some((y) => y < BAND);
    const atFoot = ys.some((y) => y > pane.height - BAND);
    return atTop && !atFoot ? pane.top + pane.height - 40 : undefined;
  })();

  return (
    <section className="panel chart kc-panel" ref={root}>
      <div className="kc-toolbar" ref={toolbar}>
        <div className="kc-tb-group">
          {/* The selected timeframe is WHITE, not amber — see chart.css. Colour
              is the entire signal: no box, no fill, no rule under it. */}
          {QUICK_INTERVALS.map((i) => (
            <button
              key={i}
              className={`kc-tf${i === interval ? ' on' : ''}`}
              aria-pressed={i === interval}
              onClick={() => setIntervalValue(i)}
            >
              {intervalLabel(i)}
            </button>
          ))}

          <div className="menu">
            <button
              className={`kc-tf${openMenu === 'timeframe' || !quickInterval ? ' on' : ''}`}
              title="More timeframes"
              aria-label="More timeframes"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'timeframe'}
              onClick={() => setOpenMenu((m) => (m === 'timeframe' ? null : 'timeframe'))}
            >
              {quickInterval ? null : intervalLabel(interval)}
              {ChevronIcon}
            </button>
            {mm.value === 'timeframe' && (
              <div className={`menu-popup${mm.closing ? ' is-closing' : ''}`} role="menu" onAnimationEnd={mm.onExit}>
                {INTERVAL_GROUPS.map((g) => (
                  <div className="kc-section" key={g.label}>
                    <div className="kc-menu-label">{g.label}</div>
                    <div className="kc-menu-grid">
                      {g.items.map((i) => (
                        <button
                          key={i}
                          role="menuitem"
                          className={i === interval ? 'on' : ''}
                          onClick={() => {
                            setIntervalValue(i);
                            setOpenMenu(null);
                          }}
                        >
                          {intervalLabel(i)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="menu">
            <button
              className={`kc-ico${openMenu === 'style' ? ' on' : ''}`}
              title="Series style"
              aria-label="Series style"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'style'}
              disabled={!ready}
              onClick={() => setOpenMenu((m) => (m === 'style' ? null : 'style'))}
            >
              {StyleIcon}
            </button>
            {mm.value === 'style' && (
              <div className={`menu-popup${mm.closing ? ' is-closing' : ''}`} role="menu" onAnimationEnd={mm.onExit}>
                <div className="kc-menu-label">Series style</div>
                <div className="kc-menu-list">
                  {CANDLE_STYLES.map((s) => (
                    <button
                      key={s.id}
                      role="menuitem"
                      className={s.id === candleStyle ? 'on' : ''}
                      onClick={() => {
                        setCandleStyle(s.id);
                        setOpenMenu(null);
                      }}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="menu" style={bare ? { display: 'none' } : undefined}>
            <button
              className={openMenu === 'indicators' ? 'kc-tf on' : 'kc-tf'}
              disabled={!ready}
              aria-haspopup="menu"
              aria-expanded={openMenu === 'indicators'}
              onClick={() => setOpenMenu((m) => (m === 'indicators' ? null : 'indicators'))}
            >
              {/* No count suffix. It changed the button's width every time an
                  indicator was added or removed, which re-flowed the whole
                  strip under the pointer, and the list inside the popup already
                  says what is on. */}
              {IndicatorIcon}
              Indicators
            </button>
          {mm.value === 'indicators' && (
            // The app's View panel look (ViewPop: title, labelled sections, the same search field).
            <div
              className={`menu-popup kc-menu-wide kc-ind-pop${mm.closing ? ' is-closing' : ''}`}
              onAnimationEnd={mm.onExit}
              // No taller than the chart card below it (the card clips what overflows): the Add list takes what is left.
              ref={(el) => {
                const card = el?.closest('.kc-panel');
                if (el && card) el.style.maxHeight = `${Math.max(220, Math.floor(card.getBoundingClientRect().bottom - el.getBoundingClientRect().top - 8))}px`;
              }}
            >
              <div className="kc-ind-head"><span>Indicators</span></div>
              <div className="kc-ind-sec">
                <div className="kc-ind-lbl"><span>On the chart</span>{indicators.length > 0 && <span className="kc-ind-aside">{indicators.length}</span>}</div>
                <div className="kc-menu-list">
                  {indicators.length === 0 && <div className="kc-empty">None</div>}
                  {indicators.map((ind) => (
                    <div className="kc-row" key={ind.id}>
                      <span className={`kc-row-name${ind.visible ? '' : ' off'}`} title={indicatorTitle(ind.name)}>
                        {indicatorTitle(ind.name)}
                      </span>
                      <button
                        className="kc-icon"
                        title={ind.visible ? 'Hide' : 'Show'}
                        aria-label={ind.visible ? `Hide ${ind.name}` : `Show ${ind.name}`}
                        onClick={() => toggleIndicator(ind.id)}
                      >
                        {ind.visible ? MENU_ICONS.show : MENU_ICONS.hide}
                      </button>
                      <button
                        className="kc-icon"
                        title="Settings"
                        aria-label={`${ind.name} settings`}
                        onClick={() => {
                          setOpenMenu(null);
                          setSettingsFor({ id: ind.id, original: ind.spec });
                        }}
                      >
                        {MENU_ICONS.settings}
                      </button>
                      <button
                        className="kc-icon kc-remove"
                        title="Remove"
                        aria-label={`Remove ${ind.name}`}
                        onClick={() => removeIndicator(ind.id)}
                      >
                        {MENU_ICONS.remove}
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="kc-ind-sec">
                <div className="kc-ind-lbl"><span>Add</span></div>
                <input
                  className="kc-ind-search"
                  type="search"
                  placeholder={`Search ${offerable.length} indicators`}
                  aria-label="Search indicators"
                  value={indQuery}
                  onChange={(e) => setIndQuery(e.target.value)}
                  autoFocus
                />
                <div className="kc-scroll kc-ind-list">
                  {/* The liquidation layers first, on their own; then the studies, A to Z. */}
                  {([['Liquidations', offered.filter((n) => LIQ_INDICATORS.has(n))], ['Studies', offered.filter((n) => !LIQ_INDICATORS.has(n))]] as const).map(([label, names]) => names.length > 0 && (
                    <div key={label} className="kc-ind-group" role="group" aria-label={label}>
                      <div className="kc-ind-lbl is-sub"><span>{label}</span></div>
                      {names.map((name) => (
                        <button
                          key={name}
                          className="kc-ind-add"
                          disabled={indicators.some((i) => i.name === name)}
                          onClick={() => addIndicator(name)}
                        >
                          <span>{indicatorTitle(name)}</span>
                          <span className="kc-ind-short">{indicatorShort(name)}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                  {offerable.length > 0 && offered.length === 0 && <div className="kc-empty">No indicator matches.</div>}
                </div>
              </div>
            </div>
          )}
          </div>

        </div>

        {/* Transient strip. It lives in the flexible middle so that a hint
            appearing can never push the right-hand group onto a second row. */}
        <div className="kc-tb-mid">
          {/* No words over the chart while drawing (the owner's rule): the
              armed tool is lit on the rail, Escape or the cursor disarms it,
              and what to click is said to screen readers only. */}
          <span className="kc-sr" aria-live="polite">
            {drawing ? `Drawing ${overlayLabel(drawing)}: ${DRAW_HINT.get(drawing) ?? 'click on the chart'}. Escape cancels.` : ''}
          </span>
        </div>

        <div className="kc-tb-group kc-tb-right">
          {/* The view group. A single tab was worse than four: with nothing
              beside it there was no active/inactive contrast, so "Chart" read
              as a label rather than as the selected one of a set. */}
          {/* A bare chart is the chart view only: no Depth or Market info. */}
          {!bare && VIEWS.map((v) => (
            <button
              key={v.id}
              className={`kc-view${v.id === view ? ' on' : ''}`}
              aria-pressed={v.id === view}
              aria-label={`${v.label} view`}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
          {/* `kc-fs` only sets it apart from the view group beside it — see
              chart.css. It is not a fifth view, so it does not sit on the
              group's rhythm. */}
          <div className="menu kc-news-tb" style={bare ? { display: 'none' } : undefined} onMouseDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={`kc-ico kc-tb-ico${show.news ? ' on' : ''}`}
              title={show.news ? 'News on the chart: on (right-click for settings)' : 'News on the chart: off (right-click for settings)'}
              aria-label="News on the chart"
              aria-pressed={show.news}
              onClick={() => {
                if (newsHeld.current) {
                  newsHeld.current = false;
                  return;
                }
                patchShow({ news: !show.news });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setNewsMenu((o) => !o);
              }}
              onPointerDown={(e) => {
                // A long press is the right-click on touch.
                if (e.pointerType !== 'touch') return;
                window.clearTimeout(newsPress.current);
                newsPress.current = window.setTimeout(() => {
                  newsHeld.current = true;
                  setNewsMenu(true);
                }, LONG_PRESS_MS);
              }}
              onPointerUp={() => window.clearTimeout(newsPress.current)}
              onPointerLeave={() => window.clearTimeout(newsPress.current)}
            >
              {CHART_ICONS.news}
            </button>
            {nm.value && (
              <div className={`menu-popup kc-news-menu${nm.closing ? ' is-closing' : ''}`} role="dialog" aria-label="News settings" onAnimationEnd={nm.onExit}>
                <NewsSettings show={show} coin={coin} onChange={patchShow} />
              </div>
            )}
          </div>
          <button
            style={bare ? { display: 'none' } : undefined}
            type="button"
            className={`kc-ico kc-tb-ico${flowOpen ? ' on' : ''}`}
            title={flowOpen ? 'Hide Who traded' : 'Who traded: every wallet in a candle (click a candle to pick it)'}
            aria-label="Who traded"
            aria-pressed={flowOpen}
            onClick={() => setFlowOpen(!flowOpen)}
          >
            {CHART_ICONS.traders}
          </button>
          <button
            style={bare ? { display: 'none' } : undefined}
            type="button"
            className={`kc-ico kc-tb-ico${sidebar ? ' on' : ''}`}
            title={sidebar ? 'Hide the object list' : 'Object list: drawings, indicators, what the chart shows'}
            aria-label="Object list"
            aria-pressed={sidebar}
            onClick={() => setSidebar(!sidebar)}
          >
            {CHART_ICONS.sidebar}
          </button>
          {canFullscreen && (
            <button
              className={`kc-ico kc-fs${isFull ? ' on' : ''}`}
              title={isFull ? 'Leave fullscreen' : 'Fullscreen'}
              aria-label={isFull ? 'Leave fullscreen' : 'Fullscreen'}
              aria-pressed={isFull}
              onClick={toggleFullscreen}
            >
              {isFull ? ExitFullscreenIcon : FullscreenIcon}
            </button>
          )}
        </div>
      </div>


      {/*
        Stage = rail | pane. The rail is a flex SIBLING of the canvas rather than
        an overlay floated on top of it, because klinecharts measures its drawable
        area from the holder's own box and re-measures through a ResizeObserver on
        that element. An overlay would leave the chart convinced it owns the full
        width and draw the leftmost candles under the buttons; taking the 52px in
        the flex row means the holder's box IS the drawable area.
      */}
      {/* Kept mounted - see the `view` state comment above for why the
          klinecharts instance has to survive a toggle away from Chart. Depth
          and Market info are plain conditional renders: neither owns an
          imperative library instance, so mounting only while selected is the
          cheaper default (their data hooks stop when the view is hidden). */}
      {/* The chart stays laid out while another view is up. `display: none`
          collapsed the canvas to 0×0, and klinecharts then refit the price
          axis to its empty default — the 0–10 scale on the way back. Parked,
          it keeps the body's size, so the range the user left is the range
          they come back to. */}
      <div className="kc-body">
      <div className={`chartholder-wrap kc-stage${view === 'chart' ? '' : ' is-parked'}`}>
        {!bare && <DrawingRail
          tools={supported.overlays}
          active={drawing}
          onSelect={startDrawing}
          onCancel={cancelDrawing}
          onClear={clearDrawings}
          disabled={!ready}
          onMotion={onRailMotion}
          magnet={magnet}
          onMagnet={onMagnet}
          stay={stayDrawing}
          onStay={setStayDrawing}
          // Lit while anything is locked or hidden, so the same button
          // gives back what a drawing's own menu took away.
          locked={drawLocked || (chart.current ? userDrawings(chart.current).some((o) => o.lock) : false)}
          onLock={onLockDrawings}
          hidden={drawHidden || hiddenDrawings.current.size > 0}
          onHide={onHideDrawings}
        />}
        {/* Plot column. The footer strip lives in here rather than beside the
            whole stage so the rail keeps the full height of the card — see
            .kc-col in rail.css. */}
        <div className="kc-col">
        <div
          className="kc-pane"
          onContextMenu={onContextMenu}
          onPointerDownCapture={onFlowDragStart}
          onPointerDown={onPanePointerDown}
          onPointerMove={onPanePointerMove}
          onPointerCancel={endPress}
          onPointerLeave={endPress}
          // The chart itself resets on the double click's second release (the
          // pointer effect above); this covers the rest of the pane.
          onDoubleClick={resetView}
          onPointerUp={(e) => {
            endPress();
            syncPaneHeights();
            pickFlowCandle(e);
          }}
          onMouseLeave={() => {
            // klinecharts only emits onCrosshairChange while the pointer is over a
            // pane, so "left the chart" has to come from the DOM. Scoped to the
            // canvas side of the stage, not the whole wrap: moving the pointer
            // onto the rail really has left the chart.
            hovering.current = false;
            setLegendBar(lastBar.current);
          }}
        >
        {/* The candle layer: the text-free skeleton while the series loads,
            then the morph of it into the loaded candles (chart/CandleMorph.tsx).
            BEFORE the canvas on purpose: it draws the grid and the candles
            under the plot, so the library's lines, overlays and crosshair stay
            over them exactly as they stay over its own. */}
        <CandleMorph
          state={candleLayer}
          chart={chart}
          priceHint={priceHint}
          hollow={candleStyle === 'candle_stroke'}
          morphable={morphable(candleStyle)}
          onHide={hideCandles}
          onBadge={tintBadge}
          onLand={showCandles}
          onDone={endArrival}
        />
        <div ref={holder} className={`chartholder kc-canvas${masked && !keepFrame ? ' kc-masked' : ''}${marking ? ' is-marking' : ''}`} />
        <div ref={marqueeEl} className="kc-marquee" aria-hidden />
        <SelectionMarks chart={ready ? chart.current : null} ids={multi} left={holder.current?.offsetLeft ?? 0} top={holder.current?.offsetTop ?? 0} />
        {!bare && <DraftOrderLines chart={ready ? chart.current : null} engine={engine} symbol={symbol} left={holder.current?.offsetLeft ?? 0} top={holder.current?.offsetTop ?? 0} />}
        {!bare && <LiqIndicatorFeed chart={ready ? chart.current : null} engine={engine} symbol={symbol} names={indicators.map((i) => i.name)} ids={indicators.map((i) => i.id).join(',')} />}
        {!bare && newsLayer.value && (
          <NewsMarkers
            chart={ready ? chart.current : null}
            marks={newsLayer.value}
            leaving={newsLayer.closing}
            left={holder.current?.offsetLeft ?? 0}
            top={holder.current?.offsetTop ?? 0}
            barMs={intervalToMs(interval)}
            coin={coin}
            mode={show.newsScope}
            tz={tz}
            canSave={folders}
            onSave={(n) => void saveStory(n)}
          />
        )}
        <FeedOverlay
          bare
          // While the invariant guard is reloading, the feed can still say
          // 'ready' - report it as loading so the overlay (and its screen-reader
          // status) matches the placeholders on screen.
          view={guarded ? FEED_LOADING : shownFeed}
          label={`${sym?.displayName ?? symbol} · ${intervalLabel(interval)}`}
          onRetry={retryNow}
        />
        {legendBar && !masked && (
          <div
            className="kc-legend"
            ref={ohlcLegend}
            style={noticeH ? { top: `calc(${noticeH}px + var(--sp-2))` } : undefined}
          >
            <span className="kc-legend-sym">
              {sym?.displayName ?? symbol} · {interval}
            </span>
            {/* Colour roles, corrected against the reference: the LETTER is
                chrome and stays --text; the NUMBER carries the bar's direction.
                They butt together with no space so each pair reads as one
                token. The change shows the absolute move first and the
                percentage in parentheses after it — a percentage alone is not
                actionable on a contract quoted in dollars. */}
            <span className="kc-legend-ohlc">
              <span>
                O<span className={`kc-v ${dir}`}>{fmtPrice(legendBar.open, sym?.tickSize)}</span>
              </span>
              <span>
                H<span className={`kc-v ${dir}`}>{fmtPrice(legendBar.high, sym?.tickSize)}</span>
              </span>
              <span>
                L<span className={`kc-v ${dir}`}>{fmtPrice(legendBar.low, sym?.tickSize)}</span>
              </span>
              <span>
                C<span className={`kc-v ${dir}`}>{fmtPrice(legendBar.close, sym?.tickSize)}</span>
              </span>
              <span className={dir}>
                {change >= 0 ? '+' : ''}
                {fmtPrice(change, sym?.tickSize)} (
                {fmtPct((change / (legendBar.open || 1)) * 100)})
              </span>
            </span>
          </div>
        )}
        {multi.length > 0 && !selected && !drawingSettings && (() => {
          const group = groupOf();
          if (group.length === 0) return null;
          const paints = group.map((o) => paintOf(o));
          const first = paints[0]!;
          return (
            <DrawingStyleBar
              key="group"
              label={`${group.length} drawing${group.length === 1 ? '' : 's'}`}
              count={group.length}
              color={first.color}
              // Mixed widths light none of the width buttons.
              size={paints.every((p) => p.size === first.size) ? first.size : 0}
              dashed={paints.every((p) => p.dashed)}
              locked={group.every((o) => o.lock)}
              text={null}
              focusText={false}
              onColor={(color) => styleGroup({ color })}
              onSize={(size) => styleGroup({ size })}
              onDashed={(dashed) => styleGroup({ dashed })}
              onText={() => undefined}
              onLock={lockGroup}
              onHide={hideGroup}
              onDelete={deleteGroup}
              onClose={() => setMulti([])}
            />
          );
        })()}
        {selected && selDrawing && !drawingSettings && (
          <DrawingStyleBar
            key={selected.id}
            hidden={movingDrawing}
            top={styleBarTop}
            onSettings={() => drawingSettingsRef.current(selected.id)}
            label={overlayLabel(selDrawing.name)}
            color={selPaint!.color}
            size={selPaint!.size}
            dashed={selPaint!.dashed}
            locked={selDrawing.lock}
            text={TEXT_TOOLS.has(selDrawing.name) ? (typeof selDrawing.extendData === 'string' ? selDrawing.extendData : '') : null}
            focusText={selected.focusText}
            onColor={(color) => styleDrawing(selected.id, { color })}
            onSize={(size) => styleDrawing(selected.id, { size })}
            onDashed={(dashed) => styleDrawing(selected.id, { dashed })}
            onText={(text) => textDrawing(selected.id, text)}
            onLock={(lock) => {
              chart.current?.overrideOverlay({ id: selected.id, lock });
              persistDrawings();
              bumpStyle();
            }}
            onDelete={() => chart.current?.removeOverlay({ id: selected.id })}
            onClose={() => setSelected(null)}
          />
        )}
        {ready && !masked && (
          <IndicatorLegend
            chart={chart.current}
            indicators={indicators}
            bar={legendBar}
            candleTop={
              ohlcLegend.current ?
                ohlcLegend.current.offsetTop + ohlcLegend.current.offsetHeight + 4
              : (noticeH ? noticeH + 8 : 8) + 26
            }
            holder={holder.current}
            volumeDecimals={sym ? precisionOf(sym.stepSize) : 4}
            paneOrder={indicators.map((i) => i.paneId)}
            onToggle={toggleIndicator}
            onSettings={(id) => {
              const ind = indicators.find((i) => i.id === id);
              if (ind) setSettingsFor({ id, original: ind.spec });
            }}
            onRemove={removeIndicator}
            onMenu={openIndicatorMenu}
          />
        )}

        {/*
          Transient notices FLOAT over the chart rather than sitting above it in
          flow. That is not a styling preference: the chart sizes its canvas from
          this container and re-measures on every resize, so a bar appearing
          in-flow shrinks the pane, redraws the price range, and slides the line
          out from under the cursor at exactly the moment the user is dragging
          it. Persistent errors stay in flow above — a broken account feed is not
          transient and should keep its space.
        */}
        {(active || ticket || lineMsg || snapView) && (
          <div ref={notices} className="kc-notices">
            {snapView && (
              <div className="kc-snapbar" role="status">
                <span className="kc-snapbar-title">Snapshot</span>
                <span className="kc-snapbar-when">
                  saved {new Date(snapView.at).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  {snapView.include.position ? ' · with the position' : ''}
                  {snapView.include.executions ? ' · with the fills' : ''}
                </span>
                <span className="kc-snapbar-note">Your own drawings and indicators are set aside.</span>
                <span className="kc-snapbar-actions">
                  <button
                    type="button"
                    className="kc-snapbar-keep"
                    title={`Make these your drawings on ${sym?.displayName ?? symbol} and your indicators (replaces the ones set aside)`}
                    onClick={() => closeSnapshot(true)}
                  >
                    Keep
                  </button>
                  <button type="button" onClick={() => closeSnapshot(false)} title="Back to your own chart">
                    Close
                  </button>
                </span>
              </div>
            )}
            {active && (
              <div className="kc-movebar">
                <span className="kc-movebar-title">
                  {pending ? 'Move this order?' : awaiting ? 'Submitted' : 'Moving'}
                </span>
                <MoveReadout line={active.line} to={active.price} sym={sym} lastPrice={lastPrice} />
                {pending && (
                  <>
                    <button className="btn-primary kc-confirm" onClick={() => void confirmPending()} disabled={sending}>
                      {sending ? 'Sending…' : 'Confirm — send live modify'}
                    </button>
                    <button onClick={cancelPending} disabled={sending}>
                      Cancel
                    </button>
                    <span className="muted">Nothing has been sent yet.</span>
                  </>
                )}
                {drag && <span className="muted">Release to review. Nothing is sent while you drag.</span>}
                {awaiting && (
                  <span className="muted">
                    Waiting for the venue. The line stays highlighted until the order is confirmed here.
                  </span>
                )}
              </div>
            )}


            {lineMsg && <p className={`status ${lineMsg.kind} kc-note`}>{lineMsg.text}</p>}
          </div>
        )}

        </div>

        {/* Footer strip, under the time axis: the feed's state and the clock,
         * the only thing on the panel that says which zone the axis above is
         * drawn in. The scale (`% A L`) and the price source are no switches on
         * the chart any more: they are in its right-click menu (owner 2026-11-02). */}
        <div className="kc-status">
          {!masked && <FeedBadge health={health.health} why={health.why} />}
          {/* mousedown stays inside: the outside-click close would otherwise
              shut the menu and the same click reopen it. */}
          <div className="menu kc-tz" onMouseDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="kc-clock"
              title="Time zone of the chart"
              aria-haspopup="menu"
              aria-expanded={tzMenu}
              onClick={() => setTzMenu((o) => !o)}
            >
              <ChartClock tz={tz} moving={moving} afterMove={afterMove} />
            </button>
            {tzMenu && (
              <div className="menu-popup kc-tz-menu" role="menu">
                <div className="kc-menu-label">Time zone</div>
                <div className="kc-menu-list">
                  {(['utc', 'local'] as const).map((z) => (
                    <button
                      key={z}
                      type="button"
                      role="menuitemradio"
                      aria-checked={tz === z}
                      className={tz === z ? 'on' : ''}
                      onClick={() => {
                        setTz(z);
                        setTzMenu(false);
                      }}
                    >
                      {z === 'utc' ? 'UTC' : `Local (${utcOffsetLabel(Date.now())})`}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        </div>
        {side.mounted && chart.current && (() => {
          const c = chart.current!;
          const front = [...userDrawings(c)]
            .filter((o) => o.id !== drawingId.current)
            .sort((a, b) => realZ(b) - realZ(a));
          const text = (o: (typeof front)[number]) => (typeof o.extendData === 'string' && o.extendData.trim() ? `: ${o.extendData.trim().slice(0, 24)}` : '');
          return (
            <div
              className={`kc-side-wrap${side.closing ? ' is-closing' : ''}`}
              onAnimationEnd={(e) => {
                if (e.target === e.currentTarget && side.closing) side.done();
              }}
            >
            <ChartSidebar
              symbol={sym?.displayName ?? symbol}
              coin={coin}
              drawings={front.map((o) => ({
                id: o.id,
                label: `${overlayLabel(o.name)}${text(o)}`,
                color: paintOf(o).color,
                visible: !hiddenDrawings.current.has(o.id) && !drawHidden,
                locked: o.lock,
              }))}
              selectedIds={multi.length ? multi : selected ? [selected.id] : []}
              indicators={indicators.map((i) => ({ id: i.id, label: legendName(i.name, i.spec.calcParams ?? [], i.spec.source), visible: i.visible }))}
              show={show}
              why={{
                position: !address ? 'Connect a wallet to see it' : engine !== 'perps' ? 'Spot has no positions' : undefined,
                orders: !address ? 'Connect a wallet to see them' : undefined,
                executions: !address ? 'Connect a wallet to see your fills' : undefined,
                news: news.error && show.news ? 'News did not load' : undefined,
              }}
              onShow={patchShow}
              onSelect={(id, add) => {
                if (add) {
                  const from = multiRef.current.length ? multiRef.current : selected ? [selected.id] : [];
                  selectedDrawing.current = null;
                  setSelected(null);
                  setMulti(from.includes(id) ? from.filter((x) => x !== id) : [...from, id]);
                  return;
                }
                setMulti([]);
                selectedDrawing.current = id;
                setSelected({ id, focusText: false });
              }}
              onToggle={(id) => {
                const hidden = hiddenDrawings.current.has(id) || drawHidden;
                if (hidden) {
                  hiddenDrawings.current.delete(id);
                  if (drawHidden) onHideDrawings(false);
                  else c.overrideOverlay({ id, visible: true });
                } else {
                  hiddenDrawings.current.add(id);
                  c.overrideOverlay({ id, visible: false });
                  setSelected((x) => (x?.id === id ? null : x));
                }
                persistDrawings();
              }}
              onLock={(id) => {
                const o = c.getOverlays({ id })[0];
                if (!o) return;
                c.overrideOverlay({ id, lock: !o.lock });
                persistDrawings();
              }}
              onDelete={(id) => c.removeOverlay({ id })}
              onMove={(id, to) => {
                const order = front.filter((o) => o.id !== id);
                const moved = front.find((o) => o.id === id);
                if (!moved) return;
                order.splice(Math.max(0, Math.min(order.length, to)), 0, moved);
                // Front first: the top of the list gets the highest level.
                order.forEach((o, i) => setRealZ(o, order.length - i, (zLevel) => c.overrideOverlay({ id: o.id, zLevel })));
                persistDrawings();
              }}
              onIndicatorToggle={toggleIndicator}
              onIndicatorSettings={(id) => {
                const ind = indicators.find((i) => i.id === id);
                if (ind) setSettingsFor({ id, original: ind.spec });
              }}
              onIndicatorRemove={removeIndicator}
              folders={folders}
              onSave={() => setExportOpen(true)}
              onClose={() => setSidebar(false)}
            />
            </div>
          );
        })()}
        {flowOpen && !bare && !flowUnder && flowDock(false)}
      </div>

      {/* A narrow card keeps Who traded under the plot instead of beside it. */}
      {flowOpen && !bare && flowUnder && view === 'chart' && flowDock(true)}
      {/* Depth and Market info mount only while selected. The chart above
          stays mounted and parked so its price range survives the switch. */}
      {view === 'depth' && <DepthView engine={engine} symbol={symbol} sym={sym} />}
      {view === 'market' && <MarketInfoView engine={engine} symbol={symbol} sym={sym} />}
      </div>

      {ctxMenu && <TabMenu at={ctxMenu.at} items={ctxMenu.items} onClose={closeCtxMenu} />}

      {markTip && createPortal(
        <div className="kc-mark-tip" role="tooltip" style={{ left: markTip.x + 12, top: markTip.y + 12 }}>
          <span className={markTip.mark.side === 'buy' ? 'pos' : 'neg'}>{markTip.mark.side === 'buy' ? 'Bought' : 'Sold'}</span>{' '}
          {fmtQty(markTip.mark.qty, sym?.stepSize)} at {fmtPrice(markTip.mark.price, sym?.tickSize)}
          {markTip.mark.count > 1 && <span className="kc-mark-dim"> · {markTip.mark.count} fills</span>}
          <span className="kc-mark-dim"> · {clockText(markTip.mark.last, tz)}</span>
        </div>,
        document.body,
      )}

      {exportOpen && (
        <ExportSheet
          market={`${sym?.displayName ?? symbol} · ${intervalLabel(interval)}`}
          drawings={chart.current ? userDrawings(chart.current).filter((o) => o.id !== drawingId.current).length : 0}
          indicators={indicators.length}
          position={(() => {
            const p = frozenPosition(exportPositions, symbol);
            return p ? `${p.side === 'long' ? 'Long' : 'Short'} ${fmtQty(p.size, sym?.stepSize)} at ${fmtPrice(p.entry, sym?.tickSize)}` : null;
          })()}
          fills={frozenFills(exportFills, symbol).length}
          folders={folders}
          busy={exportBusy}
          onSave={(include) => void exportChart(include)}
          onClose={() => !exportBusy && setExportOpen(false)}
        />
      )}

      {drawingSettings && (() => {
        const o = chart.current?.getOverlays({ id: drawingSettings.id })[0];
        if (!o) return null;
        return (
          <DrawingSettings
            key={drawingSettings.id}
            label={overlayLabel(o.name)}
            name={o.name}
            draft={draftOf(o)}
            tz={tz}
            intervalMs={intervalToMs(interval)}
            precision={sym ? precisionOf(sym.tickSize) : 2}
            onChange={(d) => applyDraft(drawingSettings.id, d)}
            onClose={(keep) => {
              if (!keep) applyDraft(drawingSettings.id, drawingSettings.original);
              setDrawingSettings(null);
            }}
          />
        );
      })()}

      {settingsFor && settingsInd && (
        <IndicatorSettings
          spec={settingsInd.spec}
          defaults={settingsInd.name === 'VOL' ? [] : (seriesCache.current.get(settingsInd.name)?.defaults ?? [])}
          lineTitles={(params) => lineTitles(settingsInd.id, params)}
          hasBars={chart.current?.getIndicators({ id: settingsInd.id })[0]?.figures.some((f) => f.type === 'bar') ?? false}
          onChange={(next) => applySpec(settingsInd.id, next, false)}
          onClose={(keep) => {
            applySpec(settingsInd.id, keep ? settingsInd.spec : settingsFor.original, keep);
            setSettingsFor(null);
          }}
        />
      )}
    </section>
  );
}

/**
 * What a dragged price actually costs, in numbers the user can act on.
 *
 * Two figures are always honest and always shown: the distance moved, and where
 * the new price sits relative to the last trade. The third — the cash effect —
 * is offered ONLY for a limit line, because a limit order fills AT its price and
 * so the arithmetic is exact. A trigger price is not a fill price: a stop that
 * executes at market fills wherever the market happens to be when it trips, so
 * any cash figure attached to moving one would be a confident guess. A guess is
 * worse than a blank on this screen, so triggers get the blank.
 */
function MoveReadout({
  line, to, sym, lastPrice,
}: {
  line: OrderLine;
  to: string;
  sym?: Symbol;
  lastPrice?: string;
}) {
  const from = num(line.price);
  const next = num(to);
  const diff = next - from;
  const last = num(lastPrice);
  const vsLast = last > 0 ? ((next - last) / last) * 100 : null;
  const qty = num(line.quantity);
  const cash = line.kind === 'limit' && line.side !== null && qty > 0 ? diff * qty : null;

  return (
    <span className="kc-readout">
      <span className="muted">{fmtPrice(line.price, sym?.tickSize)} →</span>
      <span className="kc-v">{fmtPrice(to, sym?.tickSize)}</span>
      <span className={signClass(diff)}>
        {diff >= 0 ? '+' : ''}
        {fmtPrice(diff, sym?.tickSize)}
      </span>
      {vsLast !== null && <span className="muted">{fmtPct(vsLast)} from last</span>}
      {line.quantity !== null && (
        <span className="muted">
          size {fmtQty(line.quantity, sym?.stepSize)}
        </span>
      )}
      {cash !== null && (
        // Sign convention: a higher price makes a buy cost more and a sell
        // receive more, so the word is the same for both sides; only whether
        // that is good or bad flips, which is what the colour says.
        <span className={signClass(line.side === 'buy' ? -diff : diff)}>
          {line.side === 'buy' ? 'costs' : 'receives'} {fmtQuote(Math.abs(cash), sym?.quoteCoin)}{' '}
          {diff >= 0 ? 'more' : 'less'}
        </span>
      )}
    </span>
  );
}
