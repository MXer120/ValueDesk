/**
 * Grid presets and the grid estimate, from our grid backtest (bots/gridBacktest.ts, generated; docs/BOTS.md "Grid
 * backtest").
 *
 * A grid's step is set in units of the market's own volatility (k x the hourly sd), so one preset fits BTC and a
 * jumpy alt alike: the range is the step times the levels, around the price when it starts. The estimate is what
 * the same grid did in the backtest, on this market where it was tested (else over every tested market), with the
 * wallet's own fee in place of the backtest's - price moves included, which a step count alone leaves out.
 *
 * Pure but for useHourlyVol (5-minute candles of the last 24 h).
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { GRID_BT, GRID_BT_FEE_BPS, type GridRow, type GridStat } from './gridBacktest';

/** Half of a centred geometric grid's range, as a fraction of the price: (1 + step)^((levels - 1) / 2) - 1. */
export function gridHalfRange(stepBps: number, levels: number): number {
  return Math.pow(1 + stepBps / 10_000, (Math.max(2, levels) - 1) / 2) - 1;
}

/** A geometric grid's step, bp, from its range and levels. */
export function gridStepBps(low: number, high: number, levels: number): number {
  if (!(low > 0) || !(high > low) || levels < 2) return 0;
  return (Math.pow(high / low, 1 / (levels - 1)) - 1) * 10_000;
}

/** The hourly volatility (bp) the presets scale by: sd of the 5-minute returns over the past 24 h, x sqrt 12 (gfeat.mjs). */
export function hourlyVolBps(closes: readonly number[]): number | null {
  if (closes.length < 30) return null;
  let s = 0;
  let n = 0;
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]!;
    const b = closes[i]!;
    if (!(a > 0) || !(b > 0)) continue;
    const r = Math.log(b / a);
    s += r * r;
    n++;
  }
  return n ? Math.sqrt((s / n) * 12) * 10_000 : null;
}

/** The market's hourly volatility now (bp), read again every 10 minutes; null while unknown. */
export function useHourlyVol(symbol: string | null): number | null {
  const [v, setV] = useState<{ symbol: string; bps: number | null } | null>(null);
  useEffect(() => {
    if (!symbol) return;
    let gone = false;
    const load = () => {
      api
        .klines('perps', symbol, '5m', 289)
        .then((r) => {
          if (gone) return;
          const rows = (r.klines ?? []).map((k) => ({ t: Number(k.t), c: Number(k.c) })).filter((x) => Number.isFinite(x.t) && x.c > 0).sort((a, b) => a.t - b.t);
          setV({ symbol, bps: hourlyVolBps(rows.map((x) => x.c)) });
        })
        .catch(() => !gone && setV((x) => x ?? { symbol, bps: null }));
    };
    load();
    const id = setInterval(load, 600_000);
    return () => { gone = true; clearInterval(id); };
  }, [symbol]);
  return v && v.symbol === symbol ? v.bps : null;
}

export type GridPresetId = 'gridc' | 'grid' | 'gridv';
export interface GridPreset { id: GridPresetId; k: number; levels: number; outOfRange: 'wait' | 'stop'; runHours: number | null }
/**
 * The three grids (docs/BOTS.md "Grid backtest"): the step k x the hourly volatility, the levels, the out-of-range rule
 * and the run each was tested for. Owner 2026-11-12: the first presets (2-4x the volatility) took a day or more for a
 * first fill, "we need them way smaller/tighter for shorter timeframes" - so two run a day with steps of 0.5x and 1x
 * the hourly swing (fills within the hour), and one runs a week. Over 1-day runs waiting out of the range lost less
 * than stopping for the tight grid (stopping lost less in the 7-day runs).
 */
export const GRID_PRESETS: Readonly<Record<GridPresetId, GridPreset>> = {
  gridv: { id: 'gridv', k: 0.5, levels: 20, outOfRange: 'wait', runHours: 24 },
  grid: { id: 'grid', k: 1, levels: 40, outOfRange: 'stop', runHours: 24 },
  gridc: { id: 'gridc', k: 3, levels: 10, outOfRange: 'stop', runHours: 168 },
};

/** Runs up to this long read the backtest's 1-day runs, longer ones its 7-day runs. */
export const GRID_DAY_RUN_MAX_H = 48;

/** The tested grid closest to a step (in k) and a level count, with the same out-of-range rule. */
export function nearestGridRow(k: number, levels: number, pol: 'wait' | 'stop'): GridRow | null {
  let best: GridRow | null = null;
  let bd = Infinity;
  for (const r of GRID_BT) {
    if (r.pol !== pol) continue;
    const dist = Math.abs(Math.log(Math.max(1e-6, k) / r.k)) + 0.5 * Math.abs(Math.log(Math.max(2, levels) / r.L));
    if (dist < bd) { bd = dist; best = r; }
  }
  return best;
}

export interface GridEstimate {
  /** The step now, bp, and in units of the hourly volatility. */
  stepBps: number;
  k: number | null;
  /** What one round trip keeps after the two fills' fees, bp of the order (negative: the step does not pay the fees). */
  netStepBps: number;
  /** The backtest's row (row.all is the reading; row.m[symbol] the market's own, where it was tested). */
  row: GridRow | null;
  /** This market was among the tested ones. */
  market: boolean;
  /** Which runs the reading is from: 1-day runs (a run of up to 2 days) or 7-day runs. */
  horizon: '1d' | '7d';
  /** Per $1M traded, bp (negative earns), at the wallet's fee. */
  bp: number | null;
  /** Mean result a day, bp of the grid's notional (levels x order), at the wallet's fee. */
  dayBps: number | null;
  /** Share of 7-day runs that lost, and the 10th percentile bp a day. */
  ploss: number | null;
  p10: number | null;
  /** Daily volume as a multiple of the notional. */
  turn: number | null;
  runs: number;
}

/**
 * The estimate for a grid on `symbol` with this range and level count, at `feeBps` a fill (maker + bot fee), where
 * the hourly volatility is `volBps`. Without a volatility reading the backtest is not read (bp null).
 */
export function gridEstimate(o: { symbol: string; stepBps: number; levels: number; outOfRange: 'wait' | 'stop'; volBps: number | null; feeBps: number; runHours?: number | null }): GridEstimate {
  const stepBps = o.stepBps > 0 ? o.stepBps : 0;
  const k = o.volBps && o.volBps > 0 && stepBps > 0 ? stepBps / o.volBps : null;
  const netStepBps = stepBps - 2 * o.feeBps;
  const row = k !== null ? nearestGridRow(k, o.levels, o.outOfRange) : null;
  // Every tested market together: one market's own 120 days flip sign from the 1-day to the 7-day runs (noise), the
  // pooled reading does not. The market's own is shown beside it (own).
  // A short run reads the 1-day runs (a tight grid's 7-day reading is mostly the days after its range was left).
  const short = o.runHours !== undefined && o.runHours !== null && o.runHours <= GRID_DAY_RUN_MAX_H && !!row?.day;
  const horizon: '1d' | '7d' = short ? '1d' : '7d';
  const st: GridStat | null = (short ? row?.day : row?.all) ?? null;
  if (!st) return { stepBps, k, netStepBps, row, market: false, horizon, bp: null, dayBps: null, ploss: null, p10: null, turn: null, runs: 0 };
  const [mean, ploss, p10, turn, per1m, runs] = st;
  const dFee = o.feeBps - GRID_BT_FEE_BPS;
  // per1m is $ per $1M traded, + earned: as bp of volume, + cost.
  const bp = -per1m / 100 + dFee;
  return { stepBps, k, netStepBps, row, market: !!row?.m[o.symbol], horizon, bp, dayBps: mean - dFee * turn, ploss, p10: p10 - dFee * turn, turn, runs };
}

/**
 * A grid draft's step now, bp: its own prices where it names them, else k x the volatility (a preset), else its
 * range around the price (rangePct either way, as presets.ts gridRange lays it out).
 */
export function draftStepBps(d: { low: number | null; high: number | null; levels: number; gridK: number | null; rangePct: number }, volBps: number | null): number {
  if (d.low !== null && d.high !== null) return gridStepBps(d.low, d.high, d.levels);
  if (d.gridK !== null && volBps && volBps > 0) return d.gridK * volBps;
  const p = Math.min(0.95, Math.max(0, d.rangePct));
  return gridStepBps(1 - p, 1 + p, d.levels);
}

/** The draft's range half-width for a preset step (k x volatility): what rangePct becomes once the volatility is read. */
export function presetRangePct(k: number, levels: number, volBps: number): number {
  return Number(gridHalfRange(k * volBps, levels).toPrecision(4));
}
