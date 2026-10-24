/**
 * Drawings are kept per MARKET, in this browser: a trend line drawn on
 * BTC-USD perps is there again on BTC-USD perps after a reload, on another
 * timeframe, in another chart tab of the same market, and never on ETH.
 *
 * A drawing is stored as what the user made of it - the tool, its anchors as
 * (bar time, price), its style, its text, whether it is locked or hidden on
 * its own, and where it sits in the stack - and
 * nothing the library derives. Anchors are positioned by timestamp
 * (klinecharts maps a point's timestamp to the bar under it on every draw), so
 * the same drawing lands on the same candles on any timeframe and survives the
 * history being reloaded or paged.
 *
 * Kept out: order and position lines (they are the venue's, redrawn from the
 * account), the drawing being drawn right now, and "hide all" (a view toggle,
 * not a property of the drawing - unlike hiding one drawing from its menu).
 */
import type { Overlay } from 'klinecharts';

export interface StoredPoint {
  timestamp: number;
  value: number;
}

export interface StoredDrawing {
  name: string;
  points: StoredPoint[];
  styles?: Record<string, unknown>;
  extendData?: string;
  lock?: boolean;
  /** Hidden on its own (its menu's Hide), not by "hide all". */
  hidden?: boolean;
  /** Stacking order (Bring to front / Send to back); 0 when absent. */
  z?: number;
}

const PREFIX = 'chart.drawings.v1';
/** More than anyone draws on one market; a cap so a runaway can't fill storage. */
export const MAX_DRAWINGS = 300;

/** The storage key of one market's drawings. The price SOURCE (latest / mark /
 *  index) is not part of it: a level drawn on the mark chart is the same level. */
export const drawingsKey = (engine: string, symbol: string): string => `${PREFIX}:${engine}:${symbol}`;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A drawing's own place in the stack. While a drawing is clicked klinecharts
 * lifts it to Number.MAX_SAFE_INTEGER and keeps the real level aside
 * (getPrevZLevel, on the instance, not in the public type), putting it back on
 * deselect - so the real level is the one to read, and to write.
 */
type Stacked = { zLevel?: number; getPrevZLevel?: () => number; setPrevZLevel?: (z: number) => void };
export function realZ(o: object): number {
  const s = o as Stacked;
  const z = s.zLevel ?? 0;
  return z === Number.MAX_SAFE_INTEGER && typeof s.getPrevZLevel === 'function' ? s.getPrevZLevel() : z;
}
/** A level worth keeping: a real one, never the selection's lift. */
const isLevel = (z: unknown): z is number => isNum(z) && z !== 0 && Math.abs(z) < 1e6;

/** Set it: on the instance's aside while lifted, so the deselect restores it. */
export function setRealZ(o: object, z: number, override: (z: number) => void): void {
  const s = o as Stacked;
  if (s.zLevel === Number.MAX_SAFE_INTEGER && typeof s.setPrevZLevel === 'function') s.setPrevZLevel(z);
  else override(z);
}

/** What is kept of one overlay, or null when it has no anchor worth keeping. */
export function toStored(
  o: Pick<Overlay, 'name' | 'points' | 'styles' | 'extendData' | 'lock'> & Partial<Pick<Overlay, 'zLevel'>>,
  hidden = false,
): StoredDrawing | null {
  const points = o.points
    .filter((p) => isNum(p.timestamp) && isNum(p.value))
    .map((p) => ({ timestamp: p.timestamp as number, value: p.value as number }));
  if (points.length === 0) return null;
  return {
    name: o.name,
    points,
    ...(o.styles && Object.keys(o.styles).length > 0 ? { styles: JSON.parse(JSON.stringify(o.styles)) as Record<string, unknown> } : {}),
    ...(typeof o.extendData === 'string' ? { extendData: o.extendData } : {}),
    ...(o.lock ? { lock: true } : {}),
    ...(hidden ? { hidden: true } : {}),
    ...(isLevel(realZ(o)) ? { z: realZ(o) } : {}),
  };
}

/** A stored list, with anything malformed or of an unknown tool dropped. */
export function parseDrawings(raw: unknown, known: ReadonlySet<string>): StoredDrawing[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredDrawing[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const d = r as Partial<StoredDrawing>;
    if (typeof d.name !== 'string' || !known.has(d.name) || !Array.isArray(d.points)) continue;
    const points = d.points.filter((p): p is StoredPoint => !!p && isNum(p.timestamp) && isNum(p.value));
    if (points.length === 0) continue;
    out.push({
      name: d.name,
      points: points.map((p) => ({ timestamp: p.timestamp, value: p.value })),
      ...(d.styles && typeof d.styles === 'object' && !Array.isArray(d.styles) ? { styles: d.styles } : {}),
      ...(typeof d.extendData === 'string' ? { extendData: d.extendData } : {}),
      ...(d.lock === true ? { lock: true } : {}),
      ...(d.hidden === true ? { hidden: true } : {}),
      ...(isLevel(d.z) ? { z: d.z } : {}),
    });
    if (out.length >= MAX_DRAWINGS) break;
  }
  return out;
}

export function loadDrawings(key: string, known: ReadonlySet<string>): StoredDrawing[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? parseDrawings(JSON.parse(raw), known) : [];
  } catch {
    return [];
  }
}

export function saveDrawings(key: string, drawings: StoredDrawing[]): void {
  try {
    if (drawings.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(drawings.slice(0, MAX_DRAWINGS)));
  } catch {
    /* private mode or full storage; the drawings stay on screen this session */
  }
}
