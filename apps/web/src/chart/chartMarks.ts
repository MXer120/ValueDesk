/**
 * Marks the chart puts on the candles by itself - never drawings:
 *
 *   Executions  the account's recent fills on this market, B or S in a circle:
 *               a buy below its price, a sell above; fills of one side in
 *               one bar are one mark (their size-weighted price, their total
 *               size, how many, in its tip).
 *   News        SoSoValue stories (server /api/vs/news) on the bar they came
 *               out in - this coin's, or the macro ones (category 5) - as
 *               markers along the foot of the price pane (NewsMarkers.tsx,
 *               a DOM layer: a marker shows what it is - a coin's logo, an X
 *               post, macro, research... - and a count only where several
 *               stories share it). The same story twice is shown once.
 *   Calendar    the economic calendar's releases (server valuedesk/calendar.ts:
 *               the FOMC, CPI, jobs, GDP, PCE...) on the bar they are due,
 *               the coming ones in the space right of the last bar.
 *
 * The marks are an overlay the user cannot select, move, style or save:
 * Chart.tsx keeps the chart's own overlays out of everything that handles
 * drawings (SYSTEM_OVERLAYS), so "remove all", "hide all", the object list and
 * the snapshot never see them.
 *
 * The grouping below is pure and covered by chartMarks.test.ts.
 */
import type { OverlayTemplate } from 'klinecharts';
import type { CalendarEvent, CalendarSource } from '../vsApi';
import { ORDER_LINE_OVERLAY } from './orderOverlays';
import { isLight } from '../theme';
import { FAMILY, T } from './theme';
import { intervalToMs } from './timeAxis';

export const EXEC_OVERLAY = 'vs_exec';
export const NEWS_OVERLAY = 'vs_news';
/** The candle "Who traded" is breaking down (flow/TradeFlow.tsx): a lit column over it. */
export const FLOW_PICK_OVERLAY = 'vs_flowpick';
/** Overlays that are the chart's own, not the user's drawings. */
export const SYSTEM_OVERLAYS: ReadonlySet<string> = new Set([ORDER_LINE_OVERLAY, EXEC_OVERLAY, NEWS_OVERLAY, FLOW_PICK_OVERLAY]);

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

/** How many bar-and-side marks a chart shows, the newest. */
export const MAX_FILL_MARKS = 40;

/** The gateway's trade rows (account trades) of one market as one mark per bar and side. */
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
  // Only the recent ones (owner 2026-11-05: "Limited ofcourse only recent not ALL"): a bot's thousands would bury the candles.
  return [...by.values()].map((g) => g.m).sort((a, b) => a.timestamp - b.timestamp || a.side.localeCompare(b.side)).slice(-MAX_FILL_MARKS);
}

// --- news ---------------------------------------------------------------------------

/** What a news marker needs of a story (vsApi NewsItem). */
export interface NewsStory {
  id: string;
  title: string;
  href: string;
  /** Publish time, ms; 0 when unknown. */
  time: number;
  author?: string | null;
  post?: boolean;
  /** SoSoValue's category (1 news, 2 research, 3 institution, 4 insights, 5 macro, 7 announcements, 13 crypto stocks). */
  category?: number | null;
  /** Its coins (BTC), SoSoValue's match. */
  symbols?: string[];
  summary?: string | null;
  /** It came as macro news (the server's macro topic). */
  topic?: 'macro';
  /** Its place on SoSoValue's hot list now (1 is the hottest), where it is on it. */
  rank?: number;
  /** A post's views and likes on X when SoSoValue read it. */
  views?: number;
  likes?: number;
  /** A release on the economic calendar rather than a story. */
  event?: { short: string; importance: 'high' | 'medium' | 'low'; allDay: boolean; source: CalendarSource };
}

export type NewsKind = 'news' | 'research' | 'institution' | 'insight' | 'macro' | 'announcement' | 'stocks' | 'post' | 'event';

export const NEWS_KIND_LABEL: Record<NewsKind, string> = {
  news: 'News',
  research: 'Research',
  institution: 'Institution',
  insight: 'Insights',
  macro: 'Macro',
  announcement: 'Announcement',
  stocks: 'Crypto stocks',
  post: 'Post on X',
  event: 'Economic calendar',
};

const BY_CATEGORY: Record<number, NewsKind> = { 1: 'news', 2: 'research', 3: 'institution', 4: 'insight', 5: 'macro', 7: 'announcement', 13: 'stocks' };

/** What a story is: a calendar release, macro news (Bloomberg's come as posts), a post on X, else its SoSoValue category. */
export const newsKind = (s: NewsStory): NewsKind =>
  s.event ? 'event' : s.topic === 'macro' || s.category === 5 ? 'macro' : s.post ? 'post' : BY_CATEGORY[s.category ?? 1] ?? 'news';

/** A title as two copies of one story share it: its letters and digits, case, punctuation and spacing aside. */
export const sameStory = (title: string) =>
  title
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 80);

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
  // Newest first, so the copy kept of a story told twice is its latest.
  for (const s of [...stories].sort((a, b) => b.time - a.time)) {
    // Two FOMC decisions share a title and are two events.
    const same = s.event ? '' : sameStory(s.title);
    if (!(s.time > 0) || seen.has(s.id) || (same && seen.has(same))) continue;
    seen.add(s.id);
    if (same) seen.add(same);
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

/**
 * What a marker shows for its newest story: the logo of the coin it is about
 * where that says something (another coin than the chart's; among the macro
 * stories, pass '' and any coin does), else X's mark for a post, the globe for
 * macro, or the icon of its kind.
 */
export function markFace(m: Pick<NewsMark, 'stories'>, chartCoin: string): { kind: NewsKind; coin: string | null } {
  const s = m.stories[0];
  if (!s) return { kind: 'news', coin: null };
  if (s.event) return { kind: 'event', coin: null };
  const coin = (s.symbols ?? []).find((c) => c && c !== chartCoin) ?? null;
  return { kind: newsKind(s), coin };
}

/** A marker on screen: where, and the stories it holds. */
export interface PlacedNews {
  key: string;
  x: number;
  timestamp: number;
  stories: NewsStory[];
}

/**
 * Markers closer than `gap` pixels become one (at the first one's place,
 * holding all their stories, newest first) - so zoomed out, a run of them is
 * one marker with a count rather than a row of overlapping ones.
 */
export function clusterNews(placed: ReadonlyArray<PlacedNews>, gap: number): PlacedNews[] {
  const out: PlacedNews[] = [];
  for (const p of [...placed].sort((a, b) => a.x - b.x)) {
    const prev = out[out.length - 1];
    if (prev && p.x - prev.x < gap) prev.stories = [...prev.stories, ...p.stories];
    else out.push({ ...p, stories: [...p.stories] });
  }
  for (const p of out) p.stories.sort((a, b) => b.time - a.time);
  return out;
}

/**
 * The economic calendar's releases as marker entries: titled, linked to the
 * publisher's page, credited to it, the minor ones only when asked for.
 */
export function calendarStories(
  events: readonly CalendarEvent[],
  sourceNames: Partial<Record<CalendarSource, string>>,
  minor: boolean,
): NewsStory[] {
  return events
    .filter((e) => minor || e.importance !== 'low')
    .map((e) => ({
      id: e.id,
      title: e.title,
      href: e.href,
      time: e.time,
      author: sourceNames[e.source] ?? e.source,
      summary: e.detail,
      event: { short: e.short, importance: e.importance, allDay: e.allDay, source: e.source },
    }));
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

/** A fill: B or S in a circle, a buy below its price and a sell above. */
const MARK_R = 9;
const MARK_GAP = 2;

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
    const buy = m.side === 'buy';
    const y = buy ? p.y + MARK_R + MARK_GAP : p.y - MARK_R - MARK_GAP;
    const figures = [
      { type: 'circle', attrs: { x: p.x, y, r: MARK_R }, styles: { style: 'fill', color: buy ? T.pos : T.neg } },
      {
        type: 'text',
        ignoreEvent: true,
        attrs: { x: p.x, y, text: buy ? 'B' : 'S', align: 'center', baseline: 'middle' },
        styles: { color: isLight() ? '#ffffff' : T.bg, size: 11, family: FAMILY, weight: 600, backgroundColor: 'transparent', borderColor: 'transparent', borderSize: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 },
      },
    ] as ReturnType<NonNullable<OverlayTemplate['createPointFigures']>>;
    return figures;
  },
};

/**
 * The picked candle - or the picked range of candles - outlined in white, from the highest wick to the
 * lowest (owner 2026-11-03: "a white outline on the candle not the whole area"). Two points: the first
 * candle's open time and the last one's (the same for one candle). The bars are read from the chart on
 * every draw, so a forming candle's outline grows with it and a zoom or rescale keeps it fitted; clicks
 * go through it.
 */
const flowPickTemplate: OverlayTemplate = {
  name: FLOW_PICK_OVERLAY,
  totalStep: 3,
  lock: true,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ chart, overlay, coordinates, yAxis }) => {
    const p0 = coordinates[0];
    const p1 = coordinates[1] ?? p0;
    const t0 = overlay.points[0]?.timestamp;
    const t1 = overlay.points[1]?.timestamp ?? t0;
    if (!p0 || !p1 || !yAxis || typeof t0 !== 'number' || typeof t1 !== 'number') return [];
    const bars = chart.getDataList();
    // The first bar at or after t0, then every bar up to t1 (at most a few thousand are ever on screen).
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid]!.timestamp < t0) lo = mid + 1;
      else hi = mid;
    }
    let high = -Infinity;
    let low = Infinity;
    for (let k = lo; k < bars.length && bars[k]!.timestamp <= t1 && k - lo < 20_000; k++) {
      high = Math.max(high, bars[k]!.high);
      low = Math.min(low, bars[k]!.low);
    }
    if (!(high >= low)) return [];
    const space = chart.getBarSpace();
    const half = Math.max(2.5, space.gapBar / 2 + 2);
    const left = Math.min(p0.x, p1.x) - half;
    const right = Math.max(p0.x, p1.x) + half;
    const top = yAxis.convertToPixel(high) - 3;
    const bottom = yAxis.convertToPixel(low) + 3;
    return [{
      type: 'rect',
      ignoreEvent: true,
      attrs: { x: Math.round(left) + 0.5, y: Math.round(top) + 0.5, width: Math.max(5, Math.round(right - left)), height: Math.max(6, Math.round(bottom - top)) },
      styles: { style: 'stroke', color: T.text, borderColor: T.text, borderSize: 1.5, borderRadius: 2 },
    }];
  },
};

/** Idempotent, like the other registrations. */
export function registerMarkOverlays(kc: typeof import('klinecharts')): void {
  kc.registerOverlay(execTemplate);
  kc.registerOverlay(flowPickTemplate);
}

// --- what the chart shows besides the candles -----------------------------------------

/** Whose news: this coin's, the macro (economy) stories, or all of crypto. */
export type NewsScope = 'coin' | 'macro' | 'all';

/** Every kind of story, in the order the settings list them. */
export const NEWS_KINDS: readonly NewsKind[] = ['news', 'post', 'research', 'insight', 'institution', 'announcement', 'macro', 'stocks'];

/** The chart's own layers, each on or off (the object list and the toolbar). */
export interface ChartShow {
  /** The open position's entry line. */
  position: boolean;
  /** Resting orders' lines. */
  orders: boolean;
  /** The account's fills as arrows. */
  executions: boolean;
  /** News on the chart, on or off (the toolbar's button). */
  news: boolean;
  /** Whose news (its right-click settings). */
  newsScope: NewsScope;
  /** Which kinds of story show; never none. */
  newsKinds: NewsKind[];
  /** The economic calendar's releases, with the news. */
  calendar: boolean;
  /** Its minor releases too (PMIs, home sales), not only the ones that move markets. */
  calendarMinor: boolean;
}

/** Where the chart keeps them. */
export const SHOW_KEY = 'chart.show.v1';

export const DEFAULT_SHOW: ChartShow = {
  position: true,
  orders: true,
  executions: true,
  news: false,
  newsScope: 'coin',
  newsKinds: [...NEWS_KINDS],
  calendar: true,
  calendarMinor: false,
};

export function sanitizeShow(raw: unknown): ChartShow {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ChartShow, unknown>>;
  // Before the switch: news was 'off', 'coin' or 'macro' in one.
  const legacy = r.news === 'coin' || r.news === 'macro' ? r.news : null;
  const scope = r.newsScope === 'coin' || r.newsScope === 'macro' || r.newsScope === 'all' ? r.newsScope : (legacy ?? 'coin');
  const kinds = Array.isArray(r.newsKinds) ? NEWS_KINDS.filter((k) => (r.newsKinds as unknown[]).includes(k)) : [];
  return {
    position: r.position !== false,
    orders: r.orders !== false,
    executions: r.executions !== false,
    news: r.news === true || legacy !== null,
    newsScope: scope,
    newsKinds: kinds.length ? kinds : [...NEWS_KINDS],
    calendar: r.calendar !== false,
    calendarMinor: r.calendarMinor === true,
  };
}

// --- the calendar's timing ------------------------------------------------------------------

const HOUR = 3_600_000;

/**
 * A release past the right edge shows at it ("Next") while it is within one
 * screen's width of time ahead - so on a minute chart next week's CPI stays
 * off it - or a high-impact one within a day, whatever the zoom.
 * `x` is where it would be, `width` the pane's.
 */
export function showsAhead(x: number, width: number, s: Pick<NewsStory, 'time' | 'event'>, now: number): boolean {
  if (!s.event || s.time < now) return false;
  return x <= 2 * width || (s.event.importance === 'high' && s.time - now <= 24 * HOUR);
}

/** From two hours before a release to an hour and a half after: its marker opens by itself. */
export const nearRelease = (time: number, now: number): boolean => time - now <= 2 * HOUR && now - time <= 1.5 * HOUR;

/**
 * An FOMC decision on the chart. The Fed sets two times - the statement at
 * 2:00 pm ET and the chair's press conference at 2:30 pm ET - and not the
 * end: the press conference has run about an hour, so its end is marked as
 * an estimate.
 */
export function fomcWindow(statement: number): { statement: [number, number]; press: [number, number]; endEstimated: true } {
  const press = statement + 30 * 60_000;
  return { statement: [statement, press], press: [press, press + HOUR], endEstimated: true };
}

/** The FOMC's live stream: the Fed's own YouTube channel (the Live Feed has it too). */
export const FED_LIVE_URL = 'https://www.youtube.com/@federalreserve/live';
export const isFomc = (s: Pick<NewsStory, 'event'>): boolean => s.event?.short === 'FOMC' && s.event.source === 'fed';

/** Bars of an hour or longer: an FOMC window is under an hour and too narrow to see there. */
export const showsFomcWindow = (barMs: number): boolean => barMs > 0 && barMs < HOUR;

export type Heat = 0 | 1 | 2 | 3;

/**
 * How hot a story is, from what is measured and nothing guessed: its place on
 * SoSoValue's hot list now (its top 50), or a post's views and likes on X past
 * what nearly every post reaches (a coin feed's posts: ~15k views at the median,
 * ~130k at the 97th percentile). Articles carry no counts, so an article off
 * the hot list is 0 - it is not known to be hot.
 */
export function storyHeat(s: Pick<NewsStory, 'rank' | 'views' | 'likes' | 'event'>): Heat {
  if (s.event) return 0;
  const byRank: Heat = !s.rank ? 0 : s.rank <= 10 ? 3 : s.rank <= 25 ? 2 : s.rank <= 50 ? 1 : 0;
  const v = s.views ?? 0;
  const l = s.likes ?? 0;
  const byReach: Heat = v >= 1_000_000 || l >= 10_000 ? 3 : v >= 300_000 || l >= 3_000 ? 2 : v >= 150_000 || l >= 1_000 ? 1 : 0;
  return Math.max(byRank, byReach) as Heat;
}

/** A marker's heat: its hottest story's. */
export const markHeat = (stories: readonly NewsStory[]): Heat => stories.reduce<Heat>((h, s) => Math.max(h, storyHeat(s)) as Heat, 0);

/** A marker's stories for its card: the hot ones first (hottest, then highest on the list), then newest first. */
export function hotFirst(stories: readonly NewsStory[]): NewsStory[] {
  return [...stories].sort((a, b) => storyHeat(b) - storyHeat(a) || (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.time - a.time);
}

/** What a list points at (NewsFocus): this story, or the same story told under another id (the hot list's). */
export function isFocused(s: Pick<NewsStory, 'id' | 'title'>, focus: { id: string; title: string } | null): boolean {
  return !!focus && (s.id === focus.id || (!!focus.title && sameStory(s.title) === sameStory(focus.title)));
}
