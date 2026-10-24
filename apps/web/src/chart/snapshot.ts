/**
 * A chart's state as data: for research folders (the Knowledge folders
 * session builds the folders, their storage and server; this is the chart's
 * side of the contract, agreed with it).
 *
 *   ChartSnapshot        the market, interval, price source, clock, visible
 *                        range, every drawing, every indicator and what the
 *                        chart shows besides (position, orders, executions,
 *                        news) - JSON, 1 to 30 KB as a rule.
 *   captureChart()       the chart the user last touched, as a snapshot
 *                        (null when no chart is mounted).
 *   captureChartImage()  that chart as a PNG data URL, drawings included.
 *   restoreChart(s)      puts a snapshot back: 'applied' when a chart on its
 *                        market is on screen and now shows it; 'stored' when
 *                        none is - the caller opens that market and its chart
 *                        picks the snapshot up as it mounts.
 *   parseChartSnapshot   validates anything read back (storage, a server).
 *   CHART_SAVE_EVENT     the chart's "Save to folder" asks the folders UI to
 *                        file a snapshot (window CustomEvent, ChartSaveDetail);
 *                        a listener sets `handled`, else the chart downloads it.
 *
 * Indicators are one setup for every chart in this app (chart.indicators.v1),
 * so restoring a snapshot replaces that setup, as picking studies by hand
 * would. Drawings belong to their market and replace only its drawings.
 *
 * No React; parse and the snapshot shape are covered by snapshot.test.ts.
 */
import { SYSTEM_OVERLAYS, sanitizeShow, type ChartShow } from './chartMarks';
import { MAX_DRAWINGS, drawingsKey, parseDrawings, saveDrawings, type StoredDrawing } from './drawingStore';
import { STORAGE_KEY as INDICATORS_KEY, sanitizeSpecs, type IndicatorSpec } from './indicators';
import type { TimeZoneMode } from './timeAxis';

export type SnapshotSource = 'latest' | 'mark' | 'index';

export interface ChartSnapshot {
  kind: 'valuedesk.chart';
  v: 1;
  /** ms epoch. */
  takenAt: number;
  engine: 'perps' | 'spot';
  /** 'BTC-USD'. */
  symbol: string;
  /** '1m' | '5m' | '1h' | '1D' ... */
  interval: string;
  priceSource: SnapshotSource;
  tz: TimeZoneMode;
  /** The visible bars' open times, ms. */
  view: { from: number; to: number } | null;
  /** The newest bar's close when taken. */
  lastPrice: number | null;
  drawings: StoredDrawing[];
  indicators: IndicatorSpec[];
  show: ChartShow;
}

/** detail of CHART_SAVE_EVENT. */
export interface ChartSaveDetail {
  snapshot: ChartSnapshot;
  /** "BTC-USD · 1h · 24 Oct 2026 17:30". */
  title: string;
  /** PNG data URL of the chart, drawings included; null when it could not be drawn. */
  image: string | null;
  /** Set true by the listener that files it; left false, the chart downloads the JSON. */
  handled: boolean;
}

export const CHART_SAVE_EVENT = 'chart:save-to-folder';

/** Keys the chart keeps its own settings under (Chart.tsx). */
export const SHOW_KEY = 'chart.show.v1';
export const TZ_KEY = 'chart.tz';
export const SOURCE_KEY = 'vs.chart.priceSource';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Any tool name a chart could have registered - never one of the chart's own marks. */
const ANY_TOOL = { has: (n: string) => /^[A-Za-z][\w]{0,40}$/.test(n) && !SYSTEM_OVERLAYS.has(n) } as unknown as ReadonlySet<string>;

/** A snapshot, or null when `raw` is not one. Unknown extras are dropped; lists are capped. */
export function parseChartSnapshot(raw: unknown): ChartSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'valuedesk.chart' || r.v !== 1) return null;
  if (r.engine !== 'perps' && r.engine !== 'spot') return null;
  if (typeof r.symbol !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(r.symbol)) return null;
  if (typeof r.interval !== 'string' || !/^\d{1,3}[mhDWM]$/.test(r.interval)) return null;
  const view = r.view as { from?: unknown; to?: unknown } | null | undefined;
  return {
    kind: 'valuedesk.chart',
    v: 1,
    takenAt: isNum(r.takenAt) ? r.takenAt : 0,
    engine: r.engine,
    symbol: r.symbol,
    interval: r.interval,
    priceSource: r.priceSource === 'mark' || r.priceSource === 'index' ? r.priceSource : 'latest',
    tz: r.tz === 'utc' ? 'utc' : 'local',
    view: view && isNum(view.from) && isNum(view.to) && view.to >= view.from ? { from: view.from, to: view.to } : null,
    lastPrice: isNum(r.lastPrice) ? r.lastPrice : null,
    drawings: parseDrawings(r.drawings, ANY_TOOL).slice(0, MAX_DRAWINGS),
    indicators: Array.isArray(r.indicators) ? sanitizeSpecs(r.indicators, null).slice(0, 20) : [],
    show: sanitizeShow(r.show),
  };
}

/** A file name for a snapshot: chart-BTC-USD-1h-2026-10-24-1730.json. */
export function snapshotFileName(s: Pick<ChartSnapshot, 'symbol' | 'interval' | 'takenAt'>): string {
  const d = new Date(s.takenAt || Date.now());
  const p = (n: number) => String(n).padStart(2, '0');
  return `chart-${s.symbol}-${s.interval}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

// --- the charts on screen ---------------------------------------------------------

/** What a mounted chart offers this module (Chart.tsx registers one). */
export interface LiveChart {
  engine: () => string;
  symbol: () => string;
  capture: () => ChartSnapshot | null;
  image: () => string | null;
  /** Show this snapshot (its market is this chart's). */
  apply: (s: ChartSnapshot) => void;
}

const live = new Map<LiveChart, number>();
const pending = new Map<string, ChartSnapshot>();
const marketKey = (engine: string, symbol: string) => `${engine}:${symbol}`;

/** A chart came on screen; the function it gets back takes it off. */
export function registerLiveChart(c: LiveChart): () => void {
  live.set(c, 0);
  return () => {
    live.delete(c);
  };
}

/** The user worked in this chart: it is the one captureChart() means. */
export function touchChart(c: LiveChart): void {
  if (live.has(c)) live.set(c, Date.now());
}

function lastTouched(): LiveChart | null {
  let best: LiveChart | null = null;
  let at = -1;
  for (const [c, t] of live) {
    if (t > at) {
      best = c;
      at = t;
    }
  }
  return best;
}

export function captureChart(): ChartSnapshot | null {
  return lastTouched()?.capture() ?? null;
}

export function captureChartImage(): string | null {
  return lastTouched()?.image() ?? null;
}

const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or full storage */
  }
};

export function restoreChart(raw: ChartSnapshot): 'applied' | 'stored' {
  const s = parseChartSnapshot(raw);
  if (!s) throw new Error('Not a chart snapshot');
  // What a chart reads when it mounts: so a chart opened next shows it too.
  saveDrawings(drawingsKey(s.engine, s.symbol), s.drawings);
  if (s.indicators.length) write(INDICATORS_KEY, s.indicators);
  write(SHOW_KEY, s.show);
  write(TZ_KEY, s.tz);
  write(SOURCE_KEY, s.priceSource);
  const target = [...live.keys()].find((c) => c.engine() === s.engine && c.symbol() === s.symbol);
  if (target) {
    pending.delete(marketKey(s.engine, s.symbol));
    target.apply(s);
    return 'applied';
  }
  pending.set(marketKey(s.engine, s.symbol), s);
  return 'stored';
}

/** A snapshot waiting for its market's chart (restoreChart said 'stored'); taken once. */
export function takePendingSnapshot(engine: string, symbol: string): ChartSnapshot | null {
  const k = marketKey(engine, symbol);
  const s = pending.get(k) ?? null;
  pending.delete(k);
  return s;
}
