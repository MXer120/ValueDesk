/**
 * The chart as data, for its "Download snapshot" (ExportSheet.tsx, Chart.tsx).
 *
 *   buildSnapshot       the chart as data: market, interval, price source,
 *                       visible range, drawings, studies - and, only when the
 *                       user includes them, the position and the fills, frozen.
 *   snapshotFileName    what the file is called.
 */
import { MAX_DRAWINGS, type StoredDrawing } from './drawingStore';
import type { IndicatorSpec } from './indicators';

/** Everything needed to describe the same chart again - not a picture of it. */
export interface ChartSnapshot {
  v: 1;
  engine: 'perps' | 'spot';
  /** The market as the app names it (BTC-USD). */
  symbol: string;
  /** The timeframe (chart/intervals.ts: 1m … 1M). */
  interval: string;
  /** Which price the candles show; 'latest' when absent. */
  priceSource?: 'latest' | 'mark' | 'index';
  /** The stretch on screen when it was taken (bar times, ms). */
  range?: { from: number; to: number };
  /** The market's drawings (drawingStore.ts), as kept per market. */
  drawings: StoredDrawing[];
  /** The studies (indicators.ts), in their panes. */
  indicators: IndicatorSpec[];
  /** What the user chose to include when exporting. */
  include: { position: boolean; executions: boolean };
  /** The position at the time, frozen; only with include.position. */
  position?: { side: 'long' | 'short'; size: string; entry: string; liquidation?: string; mark?: string } | null;
  /** The fills drawn as execution arrows, frozen; only with include.executions. At most MAX_EXECUTIONS. */
  executions?: Array<{ time: number; side: 'buy' | 'sell'; price: string; size: string }>;
  /** When it was taken (ms). */
  at: number;
}

/** The cap on frozen fills. */
export const MAX_EXECUTIONS = 500;

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN);
/** A positive decimal as text, or null. */
const decimal = (v: unknown): string | null => {
  const n = num(v);
  return Number.isFinite(n) && n > 0 ? String(v).trim() : null;
};

export interface SnapshotParts {
  engine: 'perps' | 'spot';
  symbol: string;
  interval: string;
  priceSource: 'latest' | 'mark' | 'index';
  range: { from: number; to: number } | null;
  drawings: StoredDrawing[];
  indicators: IndicatorSpec[];
  /** The open position on this market, frozen (frozenPosition), or null. */
  position: ChartSnapshot['position'];
  /** The gateway's trade rows (account trades), any market. */
  fills: readonly unknown[];
  at: number;
}

/** The open position of `symbol` in the gateway's positions payload, frozen; null when there is none. */
export function frozenPosition(positions: readonly unknown[], symbol: string): NonNullable<ChartSnapshot['position']> | null {
  for (const raw of positions) {
    const p = raw as Record<string, unknown> | null;
    if (!p || (p.symbol ?? p.s) !== symbol) continue;
    const size = num(p.size ?? p.positionAmt ?? p.pa ?? p.q);
    const entry = decimal(p.avgEntryPrice);
    if (!Number.isFinite(size) || size === 0 || !entry) continue;
    const ps = num(p.positionSide ?? p.ps);
    const side = ps === 3 || (ps !== 2 && size < 0) ? 'short' : 'long';
    return { side, size: String(Math.abs(size)), entry };
  }
  return null;
}

/** The fills of `symbol` as a snapshot keeps them, newest first, at most MAX_EXECUTIONS. */
export function frozenFills(rows: readonly unknown[], symbol: string): NonNullable<ChartSnapshot['executions']> {
  const out: NonNullable<ChartSnapshot['executions']> = [];
  for (const raw of rows) {
    const r = raw as Record<string, unknown> | null;
    if (!r || r.symbol !== symbol) continue;
    const s = typeof r.side === 'string' ? r.side.toUpperCase() : r.side;
    const side = s === 'BUY' || s === 1 ? 'buy' : s === 'SELL' || s === 2 ? 'sell' : null;
    const price = decimal(r.price);
    const size = decimal(r.quantity ?? r.qty ?? r.size);
    const time = num(r.time ?? r.createdAt);
    if (side && price && size && time > 0) out.push({ time, side, price, size });
  }
  return out.sort((a, b) => b.time - a.time).slice(0, MAX_EXECUTIONS);
}

/** The snapshot of a chart, with the position and the fills only when included. */
export function buildSnapshot(p: SnapshotParts, include: { position: boolean; executions: boolean }): ChartSnapshot {
  const position = include.position ? p.position : null;
  return {
    v: 1,
    engine: p.engine,
    symbol: p.symbol,
    interval: p.interval,
    priceSource: p.priceSource,
    ...(p.range ? { range: p.range } : {}),
    drawings: p.drawings.slice(0, MAX_DRAWINGS),
    indicators: p.indicators,
    include: { position: include.position && !!position, executions: include.executions },
    ...(include.position && position ? { position } : {}),
    ...(include.executions ? { executions: frozenFills(p.fills, p.symbol) } : {}),
    at: p.at,
  };
}

/** A file name for a snapshot: chart-BTC-USD-1h-2026-10-24-1730.json. */
export function snapshotFileName(s: Pick<ChartSnapshot, 'symbol' | 'interval' | 'at'>): string {
  const d = new Date(s.at || Date.now());
  const p = (n: number) => String(n).padStart(2, '0');
  return `chart-${s.symbol}-${s.interval}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}
