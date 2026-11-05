/**
 * All of a wallet's bots together, for the Bots page's summary and chart: the totals, and one series of volume
 * and net PnL summed over every bot (each bot's book samples every 5 minutes on its own clock, so the sum is
 * taken on a shared 5-minute grid, each bot counted at its last point at or before each step).
 *
 * Pure: the page and its test read the same numbers.
 */
import { BOT_SAMPLE_MS, FINAL_STATUSES, type AlgoView } from '@copy-engine';

/**
 * A read without the series, with each bot's series from the last read that had one. null when a bot has none
 * here yet (just started elsewhere): then the next read asks for them all.
 */
export function keepSeries(views: readonly AlgoView[], before: readonly AlgoView[]): AlgoView[] | null {
  const kept = new Map(before.map((v) => [v.algo.id, v.algo.book?.series]));
  const out: AlgoView[] = [];
  for (const v of views) {
    const book = v.algo.book;
    if (!book) {
      out.push(v);
      continue;
    }
    const series = kept.get(v.algo.id);
    if (!series) return null;
    out.push({ ...v, algo: { ...v.algo, book: { ...book, series } } });
  }
  return out;
}

export interface FleetTotals {
  bots: number;
  running: number;
  volume: number;
  netPnl: number;
  tradeFees: number;
  builderFees: number;
  holdingUsd: number;
  fills: number;
  makerValue: number;
  /** -net per $1M traded; null under $1. */
  costPerMillion: number | null;
}

export function fleetTotals(views: readonly AlgoView[]): FleetTotals {
  const t: FleetTotals = { bots: 0, running: 0, volume: 0, netPnl: 0, tradeFees: 0, builderFees: 0, holdingUsd: 0, fills: 0, makerValue: 0, costPerMillion: null };
  for (const v of views) {
    const b = v.bot;
    t.bots++;
    if (!FINAL_STATUSES.has(v.algo.status)) t.running++;
    if (!b) continue;
    t.volume += b.volume;
    t.netPnl += b.netPnl;
    t.tradeFees += b.tradeFees;
    t.builderFees += b.builderFees;
    t.holdingUsd += b.inventoryUsd;
    t.fills += b.fills;
    t.makerValue += b.volume * b.makerShare;
  }
  t.costPerMillion = t.volume >= 1 ? (-t.netPnl / t.volume) * 1_000_000 : null;
  return t;
}

/** The fleet's series: per 5-minute step, the volume traded in it (bars) and the net PnL so far (line). */
export function fleetSeries(views: readonly AlgoView[], now: number, step = BOT_SAMPLE_MS): { volume: Array<[number, number]>; pnl: Array<[number, number]> } {
  const books = views
    .map((v) => {
      const pts = [...(v.algo.book?.series ?? [])];
      // The figures now, for a bot still running whose last point is older than a minute.
      if (v.bot && !FINAL_STATUSES.has(v.algo.status) && (!pts.length || now - pts[pts.length - 1]![0] > 60_000)) pts.push([now, v.bot.volume, v.bot.netPnl, v.bot.tradeFees + v.bot.builderFees]);
      return pts;
    })
    .filter((p) => p.length > 0);
  if (!books.length) return { volume: [], pnl: [] };
  const first = Math.min(...books.map((p) => p[0]![0]));
  const last = Math.max(...books.map((p) => p[p.length - 1]![0]));
  // At most ~1,500 steps: a fleet with months of history steps in hours, not 5 minutes.
  while ((last - first) / step > 1_500) step *= 2;
  const start = Math.floor(first / step) * step;
  const volume: Array<[number, number]> = [];
  const pnl: Array<[number, number]> = [];
  const at = books.map(() => -1);
  let prevVol = 0;
  for (let t = start + step; ; t += step) {
    const end = Math.min(t, last);
    let vol = 0;
    let net = 0;
    books.forEach((p, i) => {
      while (at[i]! + 1 < p.length && p[at[i]! + 1]![0] <= end) at[i]!++;
      const x = at[i]! >= 0 ? p[at[i]!]! : null;
      if (x) {
        vol += x[1];
        net += x[2];
      }
    });
    volume.push([end, Math.max(0, vol - prevVol)]);
    pnl.push([end, net]);
    prevVol = vol;
    if (t >= last) break;
  }
  return { volume, pnl };
}
