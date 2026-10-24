/**
 * The chart's side of the knowledge folders (folders/bridge.ts holds the
 * contract and the ChartSnapshot type; the folders session owns the folders,
 * their picker, storage and server).
 *
 *   buildSnapshot       the chart as data: market, interval, price source,
 *                       visible range, drawings, studies - and, only when the
 *                       user includes them, the position and the fills, frozen.
 *   parseChartSnapshot  validates a snapshot handed back (a folder, a file).
 *   openSnapshot        shows one: on the chart of its market when that is on
 *                       screen, else held until that chart mounts
 *                       (takePendingSnapshot). The chart shows it as a snapshot
 *                       view - the user's own drawings and studies set aside
 *                       until Keep or Close (Chart.tsx).
 *   snapshotPosition / snapshotFills  the frozen parts as the chart draws them.
 *   thumbOf             a small JPEG of the chart for the folder's card.
 *
 * Everything but thumbOf is pure or module state, covered by snapshot.test.ts.
 */
import type { ChartSnapshot } from '../folders/bridge';
import { SYSTEM_OVERLAYS } from './chartMarks';
import { MAX_DRAWINGS, parseDrawings, type StoredDrawing } from './drawingStore';
import { sanitizeSpecs, type IndicatorSpec } from './indicators';

export type { ChartSnapshot };

/** The bridge's cap on frozen fills. */
export const MAX_EXECUTIONS = 500;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN);
/** A positive decimal as text, or null. */
const decimal = (v: unknown): string | null => {
  const n = num(v);
  return Number.isFinite(n) && n > 0 ? String(v).trim() : null;
};
/** Any tool name a chart could have registered - never one of the chart's own marks. */
const ANY_TOOL = { has: (n: string) => /^[A-Za-z][\w]{0,40}$/.test(n) && !SYSTEM_OVERLAYS.has(n) } as unknown as ReadonlySet<string>;

// --- building ------------------------------------------------------------------------

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

/** The fills of `symbol` as the bridge keeps them, newest first, at most MAX_EXECUTIONS. */
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

// --- reading back ---------------------------------------------------------------------

/** A snapshot, or null when `raw` is not one. Lists are capped, bad entries dropped. */
export function parseChartSnapshot(raw: unknown): ChartSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (r.engine !== 'perps' && r.engine !== 'spot') return null;
  if (typeof r.symbol !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(r.symbol)) return null;
  if (typeof r.interval !== 'string' || !/^\d{1,3}[mhDWM]$/.test(r.interval)) return null;
  const range = r.range as { from?: unknown; to?: unknown } | null | undefined;
  const inc = (r.include ?? {}) as { position?: unknown; executions?: unknown };
  const pos = r.position as Record<string, unknown> | null | undefined;
  const position =
    inc.position === true && pos && (pos.side === 'long' || pos.side === 'short') && decimal(pos.size) && decimal(pos.entry) ?
      {
        side: pos.side as 'long' | 'short',
        size: String(pos.size),
        entry: String(pos.entry),
        ...(decimal(pos.liquidation) ? { liquidation: String(pos.liquidation) } : {}),
        ...(decimal(pos.mark) ? { mark: String(pos.mark) } : {}),
      }
    : null;
  const executions =
    inc.executions === true && Array.isArray(r.executions) ?
      frozenFills(
        r.executions.map((e) => ({ ...(e as object), symbol: r.symbol, quantity: (e as { size?: unknown })?.size })),
        r.symbol,
      )
    : undefined;
  return {
    v: 1,
    engine: r.engine,
    symbol: r.symbol,
    interval: r.interval,
    priceSource: r.priceSource === 'mark' || r.priceSource === 'index' ? r.priceSource : 'latest',
    ...(range && isNum(range.from) && isNum(range.to) && range.to >= range.from ? { range: { from: range.from, to: range.to } } : {}),
    drawings: parseDrawings(r.drawings, ANY_TOOL).slice(0, MAX_DRAWINGS),
    indicators: Array.isArray(r.indicators) ? sanitizeSpecs(r.indicators, null).slice(0, 20) : [],
    include: { position: !!position, executions: executions !== undefined },
    ...(position ? { position } : {}),
    ...(executions ? { executions } : {}),
    at: isNum(r.at) ? r.at : 0,
  };
}

/** The frozen position as the gateway's position row, for the chart's position line. */
export function snapshotPosition(s: ChartSnapshot): unknown[] {
  const p = s.include.position ? s.position : null;
  if (!p) return [];
  const size = Number(p.size);
  return [{ symbol: s.symbol, size: p.side === 'short' ? -size : size, positionSide: p.side === 'short' ? 3 : 2, avgEntryPrice: p.entry }];
}

/** The frozen fills as the gateway's trade rows, for the execution arrows. */
export function snapshotFills(s: ChartSnapshot): unknown[] {
  if (!s.include.executions) return [];
  return (s.executions ?? []).map((e) => ({ symbol: s.symbol, side: e.side === 'buy' ? 'BUY' : 'SELL', price: e.price, quantity: e.size, time: e.time }));
}

/** A file name for a snapshot: chart-BTC-USD-1h-2026-10-24-1730.json. */
export function snapshotFileName(s: Pick<ChartSnapshot, 'symbol' | 'interval' | 'at'>): string {
  const d = new Date(s.at || Date.now());
  const p = (n: number) => String(n).padStart(2, '0');
  return `chart-${s.symbol}-${s.interval}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

// --- opening ----------------------------------------------------------------------------

/** What a mounted chart offers here (Chart.tsx registers one). */
export interface LiveChart {
  engine: () => string;
  symbol: () => string;
  /** Show this snapshot (of this chart's market) as a snapshot view. */
  open: (s: ChartSnapshot) => void;
}

const live = new Set<LiveChart>();
const pending = new Map<string, ChartSnapshot>();
const marketKey = (engine: string, symbol: string) => `${engine}:${symbol}`;

/** A chart came on screen; the function it gets back takes it off. */
export function registerLiveChart(c: LiveChart): () => void {
  live.add(c);
  return () => {
    live.delete(c);
  };
}

/**
 * Show a snapshot: 'shown' when a chart on its market is on screen (it now
 * shows it), 'staged' when none is - the caller opens that market, and its
 * chart picks the snapshot up as it mounts.
 */
export function openSnapshot(s: ChartSnapshot): 'shown' | 'staged' {
  const target = [...live].find((c) => c.engine() === s.engine && c.symbol() === s.symbol);
  if (target) {
    pending.delete(marketKey(s.engine, s.symbol));
    target.open(s);
    return 'shown';
  }
  pending.set(marketKey(s.engine, s.symbol), s);
  return 'staged';
}

/** A snapshot waiting for its market's chart; taken once. */
export function takePendingSnapshot(engine: string, symbol: string): ChartSnapshot | null {
  const k = marketKey(engine, symbol);
  const s = pending.get(k) ?? null;
  pending.delete(k);
  return s;
}

// --- the card's picture -------------------------------------------------------------------

/** Decoded bytes of a data URL. */
export const dataUrlBytes = (url: string): number => Math.floor(((url.length - url.indexOf(',') - 1) * 3) / 4);

/**
 * The chart's picture (a PNG data URL) as a JPEG small enough for a folder
 * card - at most `maxBytes` decoded (the bridge allows 200 KB). Undefined
 * when it cannot be made that small or the browser cannot draw it.
 */
export async function thumbOf(png: string | null, maxBytes = 190_000): Promise<string | undefined> {
  if (!png) return undefined;
  try {
    const img = new Image();
    img.src = png;
    await img.decode();
    for (const [width, quality] of [[720, 0.82], [560, 0.75], [420, 0.7]] as const) {
      const w = Math.min(width, img.naturalWidth);
      const h = Math.round((img.naturalHeight * w) / img.naturalWidth);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
      const jpeg = canvas.toDataURL('image/jpeg', quality);
      if (dataUrlBytes(jpeg) <= maxBytes) return jpeg;
    }
  } catch {
    /* no picture: the card shows the market */
  }
  return undefined;
}
