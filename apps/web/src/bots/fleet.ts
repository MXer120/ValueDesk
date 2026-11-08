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

/** A dollar amount that rounds to nothing shown as 0 (not -0.00). */
export const cleanUsd = (x: number): number => (Math.abs(x) < 0.005 ? 0 : x);

/**
 * Stopped runs of one bot as one row (owner 2026-11-08: a test that starts a fresh bot every round showed as 20
 * bots): stopped bots with the same name and market fold into the newest of them, with their volume, PnL, fees and
 * fills added up and the run count in `runs`. Running and paused bots always stand alone.
 */
export function foldRuns(views: readonly AlgoView[], name: (v: AlgoView) => string): { list: AlgoView[]; runs: Map<string, number> } {
  const runs = new Map<string, number>();
  const groups = new Map<string, AlgoView[]>();
  const list: AlgoView[] = [];
  for (const v of views) {
    if (!FINAL_STATUSES.has(v.algo.status)) { list.push(v); continue; }
    const k = `${name(v)}|${v.algo.spec.symbol}`;
    const g = groups.get(k);
    if (g) g.push(v); else groups.set(k, [v]);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => (b.algo.endedAt ?? b.algo.createdAt) - (a.algo.endedAt ?? a.algo.createdAt));
    const top = g[0]!;
    if (g.length === 1) { list.push(top); continue; }
    const sum = (f: (b: NonNullable<AlgoView['bot']>) => number) => g.reduce((t, x) => t + (x.bot ? f(x.bot) : 0), 0);
    const volume = sum((b) => b.volume);
    const netPnl = sum((b) => b.netPnl);
    const merged: AlgoView = {
      ...top,
      algo: { ...top.algo, createdAt: Math.min(...g.map((x) => x.algo.createdAt)), startedAt: Math.min(...g.map((x) => x.algo.startedAt ?? x.algo.createdAt)) },
      bot: top.bot ? {
        ...top.bot, volume, netPnl, grossPnl: sum((b) => b.grossPnl), tradeFees: sum((b) => b.tradeFees), builderFees: sum((b) => b.builderFees), fills: sum((b) => b.fills),
        makerShare: volume > 0 ? sum((b) => b.volume * b.makerShare) / volume : top.bot.makerShare,
        costPerMillion: volume >= 1 ? (-netPnl / volume) * 1_000_000 : null, inventory: 0, inventoryUsd: 0,
      } : top.bot,
    };
    runs.set(top.algo.id, g.length);
    list.push(merged);
  }
  return { list, runs };
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
    // What the fleet holds now: running bots only (a stopped one closed or handed over what it held).
    if (!FINAL_STATUSES.has(v.algo.status)) t.holdingUsd += b.inventoryUsd;
    t.fills += b.fills;
    t.makerValue += b.volume * b.makerShare;
  }
  t.costPerMillion = t.volume >= 1 ? (-t.netPnl / t.volume) * 1_000_000 : null;
  return t;
}

/** The fleet's series: per 5-minute step, the volume traded in it (bars) and the net PnL so far (line). */
export function fleetSeries(views: readonly AlgoView[], now: number, step = BOT_SAMPLE_MS): { volume: Array<[number, number]>; pnl: Array<[number, number]>; fees: Array<[number, number]> } {
  const books = views
    .map((v) => {
      const pts = [...(v.algo.book?.series ?? [])];
      // The figures now, for a bot still running whose last point is older than a minute.
      if (v.bot && !FINAL_STATUSES.has(v.algo.status) && (!pts.length || now - pts[pts.length - 1]![0] > 60_000)) pts.push([now, v.bot.volume, v.bot.netPnl, v.bot.tradeFees + v.bot.builderFees]);
      return pts;
    })
    .filter((p) => p.length > 0);
  if (!books.length) return { volume: [], pnl: [], fees: [] };
  const first = Math.min(...books.map((p) => p[0]![0]));
  const last = Math.max(...books.map((p) => p[p.length - 1]![0]));
  // At most ~1,500 steps: a fleet with months of history steps in hours, not 5 minutes.
  while ((last - first) / step > 1_500) step *= 2;
  const start = Math.floor(first / step) * step;
  const volume: Array<[number, number]> = [];
  const pnl: Array<[number, number]> = [];
  const fees: Array<[number, number]> = [];
  const at = books.map(() => -1);
  let prevVol = 0;
  for (let t = start + step; ; t += step) {
    const end = Math.min(t, last);
    let vol = 0;
    let net = 0;
    let fee = 0;
    books.forEach((p, i) => {
      while (at[i]! + 1 < p.length && p[at[i]! + 1]![0] <= end) at[i]!++;
      const x = at[i]! >= 0 ? p[at[i]!]! : null;
      if (x) {
        vol += x[1];
        net += x[2];
        fee += x[3] ?? 0;
      }
    });
    volume.push([end, Math.max(0, vol - prevVol)]);
    pnl.push([end, net]);
    fees.push([end, fee]);
    prevVol = vol;
    if (t >= last) break;
  }
  return { volume, pnl, fees };
}

/**
 * The fleet over a timeframe (owner 2026-11-08: the Fleet panel shows 24 hours by default): volume traded in it, what
 * the net PnL and the fees moved in it (net PnL at the mark, so an open position counts), and its cost per $1M.
 * `from` -Infinity: everything. The cumulative volume and PnL inside the window, for the cards' sparklines.
 */
export function fleetWindow(s: { volume: Array<[number, number]>; pnl: Array<[number, number]>; fees: Array<[number, number]> }, from: number): { volume: number; netPnl: number; fees: number; costPerMillion: number | null; volTrend: number[]; pnlTrend: number[] } {
  const before = (xs: Array<[number, number]>) => (Number.isFinite(from) ? xs.filter((p) => p[0] < from).at(-1)?.[1] ?? 0 : 0);
  const vols = s.volume.filter((p) => p[0] >= from);
  const pnls = s.pnl.filter((p) => p[0] >= from);
  const fees = s.fees.filter((p) => p[0] >= from);
  const p0 = before(s.pnl);
  const f0 = before(s.fees);
  let acc = 0;
  const volTrend = vols.map((p) => (acc += p[1]));
  const volume = acc;
  const netPnl = pnls.length ? pnls[pnls.length - 1]![1] - p0 : 0;
  return {
    volume, netPnl, fees: fees.length ? fees[fees.length - 1]![1] - f0 : 0,
    costPerMillion: volume >= 1 ? (-netPnl / volume) * 1_000_000 : null,
    volTrend, pnlTrend: pnls.map((p) => p[1] - p0),
  };
}
