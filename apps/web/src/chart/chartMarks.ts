/**
 * Marks the chart puts on the candles by itself - never drawings:
 *
 *   Executions  the account's own fills on this market, TradingView's arrows:
 *               a buy points up at its price from below, a sell down from
 *               above; fills of one side in one bar are one arrow (their
 *               size-weighted price, their total size, how many).
 *   News        SoSoValue stories (server /api/vs/news) on the bar they came
 *               out in, as a badge along the foot of the price pane - this
 *               coin's stories, or the macro ones (category 5). A click lists
 *               them; each opens the story.
 *
 * Both are overlays the user cannot select, move, style or save: Chart.tsx
 * keeps them out of everything that handles drawings (SYSTEM_OVERLAYS), so
 * "remove all", "hide all", the object list and the snapshot never see them.
 *
 * The grouping below is pure and covered by chartMarks.test.ts.
 */
import type { OverlayTemplate } from 'klinecharts';
import { ORDER_LINE_OVERLAY } from './orderOverlays';
import { FAMILY, T } from './theme';
import { intervalToMs } from './timeAxis';

export const EXEC_OVERLAY = 'vs_exec';
export const NEWS_OVERLAY = 'vs_news';
/** Overlays that are the chart's own, not the user's drawings. */
export const SYSTEM_OVERLAYS: ReadonlySet<string> = new Set([ORDER_LINE_OVERLAY, EXEC_OVERLAY, NEWS_OVERLAY]);

const DAY = 86_400_000;

/**
 * Open time of the bar a moment falls in. Up to a day, bars open on whole
 * multiples of their length since the epoch (UTC midnight for 1D); weeks open
 * on Monday 00:00 UTC, months on the 1st. `lookup` (the loaded bars) wins
 * where it knows the answer.
 */
export function barOpen(ts: number, interval: string, lookup?: (ts: number) => number | null): number {
  const known = lookup?.(ts);
  if (known !== null && known !== undefined) return known;
  if (/M$/.test(interval)) {
    const d = new Date(ts);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  const ms = intervalToMs(interval);
  if (/W$/.test(interval)) {
    // The epoch was a Thursday; Monday is four days later.
    const monday = 4 * DAY;
    return Math.floor((ts - monday) / ms) * ms + monday;
  }
  return Math.floor(ts / ms) * ms;
}

// --- executions ------------------------------------------------------------------

export interface FillMark {
  key: string;
  /** The bar's open time. */
  timestamp: number;
  side: 'buy' | 'sell';
  /** Size-weighted price of the fills. */
  price: number;
  /** Their total size, base units. */
  qty: number;
  count: number;
  /** The newest fill's time. */
  last: number;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN);
const sideOf = (v: unknown): 'buy' | 'sell' | null => {
  const s = typeof v === 'string' ? v.toUpperCase() : v;
  return s === 'BUY' || s === 1 ? 'buy' : s === 'SELL' || s === 2 ? 'sell' : null;
};

/** The gateway's trade rows (account trades) of one market as one arrow per bar and side. */
export function fillMarks(rows: readonly unknown[], symbol: string, interval: string, lookup?: (ts: number) => number | null): FillMark[] {
  const by = new Map<string, { m: FillMark; notional: number }>();
  for (const r of rows) {
    const row = r as Record<string, unknown> | null;
    if (!row || row.symbol !== symbol) continue;
    const side = sideOf(row.side);
    const price = num(row.price);
    const qty = Math.abs(num(row.quantity ?? row.qty ?? row.size));
    const time = num(row.time ?? row.createdAt);
    if (!side || !(price > 0) || !(qty > 0) || !(time > 0)) continue;
    const timestamp = barOpen(time, interval, lookup);
    const key = `${timestamp}:${side}`;
    const g = by.get(key);
    if (g) {
      g.notional += price * qty;
      g.m.qty += qty;
      g.m.count += 1;
      g.m.price = g.notional / g.m.qty;
      g.m.last = Math.max(g.m.last, time);
    } else {
      by.set(key, { m: { key, timestamp, side, price, qty, count: 1, last: time }, notional: price * qty });
    }
  }
  return [...by.values()].map((g) => g.m).sort((a, b) => a.timestamp - b.timestamp || a.side.localeCompare(b.side));
}

// --- news ---------------------------------------------------------------------------

/** What a news badge needs of a story (vsApi NewsItem). */
export interface NewsStory {
  id: string;
  title: string;
  href: string;
  /** Publish time, ms; 0 when unknown. */
  time: number;
  author?: string | null;
  post?: boolean;
}

export interface NewsMark {
  key: string;
  timestamp: number;
  /** Newest first. */
  stories: NewsStory[];
}

/**
 * Stories grouped onto the bar each came out in; a story without a time has no
 * bar. `mergeMs`: bars closer than that to a group's first bar join it - at a
 * zoom where badges a bar apart would overlap, they are one badge.
 */
export function newsMarks(stories: readonly NewsStory[], interval: string, lookup?: (ts: number) => number | null, mergeMs = 0): NewsMark[] {
  const by = new Map<number, NewsStory[]>();
  const seen = new Set<string>();
  for (const s of stories) {
    if (!(s.time > 0) || seen.has(s.id)) continue;
    seen.add(s.id);
    const t = barOpen(s.time, interval, lookup);
    by.set(t, [...(by.get(t) ?? []), s]);
  }
  const out: NewsMark[] = [];
  for (const [timestamp, list] of [...by.entries()].sort((a, b) => a[0] - b[0])) {
    const prev = out[out.length - 1];
    if (prev && mergeMs > 0 && timestamp - prev.timestamp < mergeMs) prev.stories.push(...list);
    else out.push({ key: `news:${timestamp}`, timestamp, stories: [...list] });
  }
  for (const m of out) m.stories.sort((a, b) => b.time - a.time);
  return out;
}

/** A market's coin as the news names it: BTC for a spot market's vBTC too, PEPE for 1000PEPE. */
export function newsCoin(base: string | null | undefined): string {
  return String(base ?? '')
    .trim()
    .replace(/^v(?=[A-Z0-9])/, '')
    .toUpperCase()
    .replace(/^1000+(?=[A-Z])/, '');
}

// --- overlays ----------------------------------------------------------------------

const ARROW_W = 9;
const ARROW_H = 7;
/** Gap between the fill's price and the arrow's tip. */
const ARROW_GAP = 2;

/** One fill arrow; its FillMark rides in extendData. */
const execTemplate: OverlayTemplate = {
  name: EXEC_OVERLAY,
  totalStep: 2,
  lock: true,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, overlay }) => {
    const p = coordinates[0];
    const m = overlay.extendData as FillMark | undefined;
    if (!p || !m) return [];
    const up = m.side === 'buy';
    const color = up ? T.pos : T.neg;
    const tip = up ? p.y + ARROW_GAP : p.y - ARROW_GAP;
    const base = up ? tip + ARROW_H : tip - ARROW_H;
    const figures: ReturnType<NonNullable<OverlayTemplate['createPointFigures']>> = [
      {
        type: 'polygon',
        attrs: { coordinates: [{ x: p.x, y: tip }, { x: p.x - ARROW_W / 2, y: base }, { x: p.x + ARROW_W / 2, y: base }] },
        styles: { style: 'fill', color },
      },
    ];
    if (m.count > 1) {
      (figures as unknown[]).push({
        type: 'text',
        ignoreEvent: true,
        attrs: { x: p.x, y: up ? base + 2 : base - 2, text: String(m.count), align: 'center', baseline: up ? 'top' : 'bottom' },
        styles: { color, size: 10, family: FAMILY, weight: 600, backgroundColor: 'transparent', borderSize: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 },
      });
    }
    return figures;
  },
};

const BADGE_R = 7;

/** One news badge at the foot of the price pane; its NewsMark rides in extendData. */
const newsTemplate: OverlayTemplate = {
  name: NEWS_OVERLAY,
  totalStep: 2,
  lock: true,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, overlay, bounding }) => {
    const p = coordinates[0];
    const m = overlay.extendData as NewsMark | undefined;
    if (!p || !m) return [];
    const y = bounding.height - BADGE_R - 6;
    const n = m.stories.length;
    return [
      { type: 'circle', attrs: { x: p.x, y, r: BADGE_R }, styles: { style: 'stroke_fill', color: T.elevated, borderColor: T.muted, borderSize: 1 } },
      {
        type: 'text',
        ignoreEvent: true,
        attrs: { x: p.x, y: y + 0.5, text: n > 9 ? '9+' : n > 1 ? String(n) : 'N', align: 'center', baseline: 'middle' },
        styles: { color: T.text, size: n > 9 ? 8 : 9, family: FAMILY, weight: 700, backgroundColor: 'transparent', borderSize: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 },
      },
    ];
  },
};

/** Idempotent, like the other registrations. */
export function registerMarkOverlays(kc: typeof import('klinecharts')): void {
  kc.registerOverlay(execTemplate);
  kc.registerOverlay(newsTemplate);
}

// --- what the chart shows besides the candles -----------------------------------------

export type NewsMode = 'off' | 'coin' | 'macro';

/** The chart's own layers, each on or off (the object list and the snapshot). */
export interface ChartShow {
  /** The open position's entry line. */
  position: boolean;
  /** Resting orders' lines. */
  orders: boolean;
  /** The account's fills as arrows. */
  executions: boolean;
  /** News badges: this coin's, the macro ones, or none. */
  news: NewsMode;
}

/** Where the chart keeps them. */
export const SHOW_KEY = 'chart.show.v1';

export const DEFAULT_SHOW: ChartShow = { position: true, orders: true, executions: true, news: 'off' };

export function sanitizeShow(raw: unknown): ChartShow {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ChartShow, unknown>>;
  return {
    position: r.position !== false,
    orders: r.orders !== false,
    executions: r.executions !== false,
    news: r.news === 'coin' || r.news === 'macro' ? r.news : 'off',
  };
}
