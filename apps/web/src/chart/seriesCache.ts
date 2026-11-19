/**
 * THE SERIES THE TRADE CHART HAS SEEN, KEPT: a switch back to one (1m -> 5m -> 1m, BTC -> ETH ->
 * BTC, or a return to the Trade tab, which unmounts the chart) draws it in the next frame instead
 * of after a round trip and a 500-bar read.
 *
 * WHAT IS KEPT IS ONLY WHAT CANNOT CHANGE. A series' closed bars are final at the venue; the newest
 * bar the chart held may still be forming, so it is never kept. Bars the candle STREAM wrote are
 * kept too (they are what the chart was showing), but marked: `unverifiedFrom` is the oldest bar
 * the stream may have written since a REST answer last confirmed the bars, and a restore reads a
 * page reaching back over every such bar (`restorePlan`), which feedHealth.ts's planMerge checks
 * bar by bar - a bar the stream left incomplete makes the chart rebuild from REST's.
 *
 * HOW A KEPT SERIES IS SHOWN (Chart.tsx, the stale-data rule the owner set for every page): its
 * closed bars go on at once with the footer reading "As of hh:mm:ss" (asOf.ts) in place of "Live",
 * nothing newer drawn and the live ticks held, until the right edge - the forming bar and any that
 * closed since - lands from REST in one small read; then "Live" again and the held ticks replay.
 * Only a series at most KEPT_GAP_BARS behind is shown that way (the room those bars take is kept
 * free at the right edge so nothing shifts when they land); one further behind loads as before.
 *
 * Module state: up to KEPT_SERIES series, the least recently left dropped first, KEPT_BARS_MAX
 * bars each (a few MB at most). DOM-free and unit-tested: seriesCache.test.ts.
 */
import type { KLineData } from 'klinecharts';
import { gapFillLimit } from './feedHealth';
import { KLINE_LIMIT } from './series';

export interface KeptSeries {
  /** The chart's series key (klines.ts seriesKey). */
  key: string;
  /** Closed bars, oldest first: never the newest bar the chart held. */
  bars: KLineData[];
  /** The oldest bar the candle stream may have written since REST last confirmed the bars; null when none. */
  unverifiedFrom: number | null;
  /** Older history exists before bars[0]. */
  more: boolean;
  /** When these bars were last the live series' (ms): the "As of" time. */
  at: number;
}

/** Series kept in memory. */
export const KEPT_SERIES = 8;
/** Bars kept per series: the first load (500) and two pages scrolled back (2 x 1,000). */
export const KEPT_BARS_MAX = 2_500;
/**
 * The furthest a kept series may be behind - bar slots between its newest kept bar and now, the
 * forming one included - to be shown at once. The room those bars take is held free at the right
 * edge until they land: three bars on a phone is 18 px.
 */
export const KEPT_GAP_BARS = 3;

/** What the chart keeps of the series it leaves; null when there is nothing closed to keep. */
export function keepOf(key: string, list: readonly KLineData[], unverifiedFrom: number | null, more: boolean, at: number): KeptSeries | null {
  if (list.length < 2) return null;
  let bars = list.slice(0, -1);
  let older = more;
  if (bars.length > KEPT_BARS_MAX) {
    bars = bars.slice(bars.length - KEPT_BARS_MAX);
    older = true;
  }
  const first = bars[0]!.timestamp;
  // A mark older than every kept bar means "all of them".
  const from = unverifiedFrom === null ? null : Math.max(unverifiedFrom, first);
  const last = bars[bars.length - 1]!.timestamp;
  return { key, bars, unverifiedFrom: from !== null && from > last ? null : from, more: older, at };
}

export interface RestorePlan {
  /** Bar slots after the newest kept bar, up to now (the forming one included). */
  gap: number;
  /** The right-edge read: the newest `limit` bars, reaching back over every unverified kept bar. */
  limit: number;
}

/**
 * Whether a kept series can be shown now, and the read that completes it. Null when it is more
 * than KEPT_GAP_BARS behind, or when the bars to re-check reach back further than one read can.
 */
export function restorePlan(e: KeptSeries, now: number, intervalMs: number, maxLimit = KLINE_LIMIT): RestorePlan | null {
  const last = e.bars[e.bars.length - 1]?.timestamp;
  if (last === undefined || !(intervalMs > 0) || !Number.isFinite(now)) return null;
  const gap = Math.max(1, Math.floor((now - last) / intervalMs));
  if (gap > KEPT_GAP_BARS) return null;
  const from = Math.min(e.unverifiedFrom ?? last, last);
  // Every slot from `from` to now, plus the slack gapFillLimit adds; a market with empty
  // periods has fewer bars than slots, so the page reaches further back still.
  if (Math.ceil(Math.max(0, now - from) / intervalMs) + 1 > maxLimit) return null;
  return { gap, limit: gapFillLimit(from, now, intervalMs, 10, maxLimit) };
}

/**
 * The oldest bar still unconfirmed after a right-edge read was merged in (planMerge 'none',
 * 'append' or a rebuild): the read checked every held bar from `fetchedFirst` on, so when the
 * unconfirmed ones all lie inside it only its own newest bar - and the chart's newest, which the
 * stream may be ahead on - are left unconfirmed. Otherwise the mark stays where it was.
 */
export function unverifiedAfterRead(prev: number | null, fetchedFirst: number, fetchedLast: number, heldLast: number | null): number | null {
  if (prev !== null && prev < fetchedFirst) return prev;
  return heldLast === null ? fetchedLast : Math.min(fetchedLast, heldLast);
}

/** The kept series: least recently left first out. */
export class SeriesCache {
  private readonly map = new Map<string, KeptSeries>();

  constructor(private readonly cap = KEPT_SERIES) {}

  put(e: KeptSeries | null): void {
    if (!e) return;
    this.map.delete(e.key);
    this.map.set(e.key, e);
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** Offer a series kept elsewhere (IndexedDB at boot): it never replaces a newer one held here. */
  offer(e: KeptSeries): void {
    const held = this.map.get(e.key);
    if (held && held.at >= e.at) return;
    if (!held && this.map.size >= this.cap) return;
    this.map.set(e.key, e);
  }

  /** The kept series for `key`, taken out: it goes back in, newer, when the chart leaves it again. */
  take(key: string): KeptSeries | null {
    const e = this.map.get(key) ?? null;
    if (e) this.map.delete(key);
    return e;
  }

  peek(key: string): KeptSeries | null {
    return this.map.get(key) ?? null;
  }

  /** Newest first. */
  list(): KeptSeries[] {
    return [...this.map.values()].reverse();
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

/** The trade chart's kept series (one per tab). */
export const seriesCache = new SeriesCache();
