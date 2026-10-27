/**
 * Every derived number on the Hyperliquid view of Scan and Portfolio.
 *
 * Pure functions over the multi-venue contract (`TraderProfile`, `VsPosition`,
 * `VsFill`, `EquityPoint`), so the panels in HlCards.tsx only format and the
 * arithmetic is testable on its own (hlModel.test.ts).
 *
 * THE SAME RULES AS Portfolio.tsx. A figure with no source is null and renders
 * as an em-dash, never as zero; a figure computed here rather than published by
 * the venue is called derived in its tooltip; and a sum that had to skip rows
 * says how many it skipped, so a partial total is never read as the whole.
 */
import type { EquityPoint, TraderProfile, VsFill, VsPosition, Window } from '../../vsApi';

/**
 * The muted line shown in place of a SoDEX history chart the server flagged
 * (`TraderProfile.analyticsSuspect`): then only live equity is shown. Null when
 * the history is usable.
 */
export function analyticsSuspectNote(flag: TraderProfile['analyticsSuspect'] | undefined): string | null {
  if (!flag) return null;
  if (flag === 'no-deposits-recorded') {
    return "SoDEX's history for this account is incomplete: it records no deposits, so its account value equals its PnL. Showing live equity only.";
  }
  if (flag === 'live-mismatch') {
    return "SoDEX's history for this account is incomplete: its history stopped following this account. Showing live equity only.";
  }
  return "SoDEX's history for this account is incomplete. Showing live equity only.";
}

/**
 * The server's first check (valuedesk/sodex/mappers.ts `chartSuspect`), run on
 * the SoDEX chart the page already holds: every point with a balance has account
 * value == PnL, i.e. SoDEX's analytics never recorded a deposit. The server's
 * profile can take a while for a big account; until it answers, this keeps the
 * page from headlining the analytics' false account value. The server's verdict
 * replaces it as soon as it arrives.
 */
export function chartValueIsPnl(points: ReadonlyArray<{ accountValue: number; pnl: number }> | null | undefined): 'no-deposits-recorded' | null {
  const funded = (points ?? []).filter((p) => Number.isFinite(p.accountValue) && p.accountValue > 0);
  return funded.length >= 3 && funded.every((p) => Math.abs(p.accountValue - p.pnl) < Math.max(1, 1e-6 * p.accountValue))
    ? 'no-deposits-recorded'
    : null;
}

/** The contract's windows, in the order the period switch shows them. */
export const HL_WINDOWS: readonly Window[] = ['1d', '7d', '30d', 'all'];
export const HL_WINDOW_LABEL: Record<Window, string> = { '1d': '1D', '7d': '7D', '30d': '30D', all: 'ALL' };

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Whether a profile shows any trading on the venue at all.
 *
 * `trader()` returns null for "no such trader", but a venue may also answer
 * with an empty shell - no balance, no positions, no volume in any window. Both
 * mean "nothing here" to someone deciding which venue tab to read, so both are
 * inactive. Any one real signal is enough to count as active.
 */
export function hasActivity(p: TraderProfile | null | undefined): boolean {
  if (!p) return false;
  const s = p.summary;
  if (p.positions.length > 0) return true;
  if (finite(s.accountValue) && s.accountValue > 0) return true;
  if (finite(s.lastActive)) return true;
  if (finite(s.trades) && s.trades > 0) return true;
  return Object.values(s.volume ?? {}).some((v) => finite(v) && v > 0);
}

/* ---------------------------------------------------------------------------
 * EXPOSURE - the same shape Portfolio.tsx's ExposurePanel reads.
 * ------------------------------------------------------------------------ */

export interface HlExposure {
  long: number;
  short: number;
  gross: number;
  net: number;
  /** gross / account value. null without a positive account value. */
  grossLeverage: number | null;
  /** Positions left out of the sums because their notional is not a number. */
  unpriced: number;
  byMarket: Array<{ symbol: string; dir: 'long' | 'short'; notional: number; share: number }>;
}

export function exposureOf(positions: VsPosition[], accountValue: number | null): HlExposure | null {
  if (positions.length === 0) return null;
  let long = 0;
  let short = 0;
  let unpriced = 0;
  const rows: Array<{ symbol: string; dir: 'long' | 'short'; notional: number }> = [];
  for (const p of positions) {
    const n = finite(p.notional) ? Math.abs(p.notional) : null;
    if (n === null) { unpriced++; continue; }
    if (p.side === 'long') long += n; else short += n;
    rows.push({ symbol: p.symbol, dir: p.side, notional: n });
  }
  const gross = long + short;
  return {
    long,
    short,
    gross,
    net: long - short,
    grossLeverage: finite(accountValue) && accountValue > 0 ? gross / accountValue : null,
    unpriced,
    byMarket: rows
      .sort((a, b) => b.notional - a.notional)
      .map((r) => ({ ...r, share: gross > 0 ? r.notional / gross : 0 })),
  };
}

/** Sum of the venue's own per-position unrealised PnL; null if any position lacks one. */
export function unrealizedOf(positions: VsPosition[]): number | null {
  if (positions.length === 0) return null;
  let sum = 0;
  for (const p of positions) {
    if (!finite(p.uPnl)) return null;
    sum += p.uPnl;
  }
  return sum;
}

/* ---------------------------------------------------------------------------
 * MARGIN - estimated, because the contract carries leverage but no margin.
 * ------------------------------------------------------------------------ */

export interface HlMargin {
  cross: number;
  isolated: number;
  /** Positions whose margin mode the venue did not report, counted as cross. */
  unknownMode: number;
  /** Positions with no usable leverage, left out of the sums. */
  skipped: number;
  used: number;
  /** account value - used, floored at zero. null without an account value. */
  free: number | null;
  accountValue: number | null;
}

/**
 * Margin held per position, as notional / leverage.
 *
 * That is how the venue sizes initial margin, so it is a close estimate rather
 * than a guess - but it is still an estimate: an isolated position can carry
 * extra margin added by hand, which this cannot see. The panel labels it so.
 */
export function marginOf(positions: VsPosition[], accountValue: number | null): HlMargin | null {
  if (positions.length === 0 && !finite(accountValue)) return null;
  let cross = 0;
  let isolated = 0;
  let unknownMode = 0;
  let skipped = 0;
  for (const p of positions) {
    if (!finite(p.notional) || !finite(p.leverage) || p.leverage <= 0) { skipped++; continue; }
    const m = Math.abs(p.notional) / p.leverage;
    if (p.marginMode === 'isolated') isolated += m;
    else {
      if (p.marginMode !== 'cross') unknownMode++;
      cross += m;
    }
  }
  const used = cross + isolated;
  const av = finite(accountValue) ? accountValue : null;
  return {
    cross,
    isolated,
    unknownMode,
    skipped,
    used,
    free: av === null ? null : Math.max(0, av - used),
    accountValue: av,
  };
}

/* ---------------------------------------------------------------------------
 * CURVES - an EquityPoint series as the `CurveWindow` EquityCurve draws.
 * ------------------------------------------------------------------------ */

export interface HlCurve {
  points: Array<{ t: number; v: number }>;
  /** The unrebased level at the first point: what the window opened at. */
  baseline: number;
  change: number | null;
  maxDrawdown: number | null;
}

/** Biggest fall from a peak to a later low. Same definition as Portfolio.tsx. */
export function maxDrawdownOf(values: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (v - peak < worst) worst = v - peak;
  }
  return worst;
}

/**
 * One window of the venue's series, rebased so zero is where the window opened.
 *
 * The contract already says `pnl` is relative to the window's start, so for PnL
 * the rebase is a no-op on a well-behaved venue; it is done anyway so that
 * account value (which is absolute) and PnL go through one path and the chart's
 * zero line means the same thing on both cards. Points whose value is null are
 * dropped rather than drawn as zero.
 */
export function curveOf(points: EquityPoint[] | undefined, field: 'pnl' | 'accountValue'): HlCurve | null {
  if (!points) return null;
  const pts = points
    .filter((p) => finite(p.t) && finite(p[field]))
    .sort((a, b) => a.t - b.t)
    .map((p) => ({ t: p.t, v: p[field] as number }));
  if (pts.length < 2) return null;
  const baseline = pts[0]!.v;
  const rebased = pts.map((p) => ({ t: p.t, v: p.v - baseline }));
  return {
    points: rebased,
    baseline,
    change: rebased[rebased.length - 1]!.v,
    maxDrawdown: maxDrawdownOf(rebased.map((q) => q.v)),
  };
}

const WINDOW_MS: Partial<Record<Window, number>> = { '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

/**
 * The window's curve, even when the venue sent fewer than two points for it.
 *
 * A quiet account gets one point (or none) per window: nothing moved. Every
 * point the profile holds, from any window, is one series of the same account,
 * so the window is read from all of them: the last value before the window
 * opens is where it started, and the newest value holds until now. A flat line
 * is then the truth - no change in this window - instead of "fewer than two
 * points". Null only when the venue sent no value at all.
 */
export function windowCurve(
  equity: Partial<Record<Window, EquityPoint[]>> | undefined,
  w: Window,
  field: 'pnl' | 'accountValue',
  now = Date.now(),
): HlCurve | null {
  const own = curveOf(equity?.[w], field);
  if (own || !equity) return own;
  const byT = new Map<number, number>();
  for (const list of Object.values(equity)) {
    for (const p of list ?? []) if (finite(p.t) && finite(p[field])) byT.set(p.t, p[field] as number);
  }
  const all = [...byT.entries()].sort((a, b) => a[0] - b[0]);
  if (!all.length) return null;
  const span = WINDOW_MS[w];
  const start = span === undefined ? all[0]![0] : now - span;
  const before = all.filter(([t]) => t < start).pop();
  const inside = all.filter(([t]) => t >= start);
  const pts: EquityPoint[] = [];
  if (before) pts.push({ t: start, accountValue: null, pnl: null, [field]: before[1] });
  for (const [t, v] of inside) pts.push({ t, accountValue: null, pnl: null, [field]: v });
  const last = pts[pts.length - 1];
  if (last && last.t < now) pts.push({ t: now, accountValue: null, pnl: null, [field]: last[field] });
  return curveOf(pts, field);
}

/* ---------------------------------------------------------------------------
 * FILLS - what the loaded page of fills adds up to.
 * ------------------------------------------------------------------------ */

export interface HlFillStats {
  count: number;
  volume: number;
  /** null when no fill reported a fee. */
  fees: number | null;
  /** null when no fill reported a realised PnL. */
  realised: number | null;
  /** Fills that closed something: realised PnL reported and non-zero. */
  closing: number;
  wins: number;
  oldest: number | null;
  newest: number | null;
}

export function fillStats(fills: VsFill[]): HlFillStats {
  let volume = 0;
  let fees: number | null = null;
  let realised: number | null = null;
  let closing = 0;
  let wins = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  for (const f of fills) {
    if (finite(f.notional)) volume += Math.abs(f.notional);
    if (finite(f.fee)) fees = (fees ?? 0) + f.fee;
    if (finite(f.closedPnl)) {
      realised = (realised ?? 0) + f.closedPnl;
      if (f.closedPnl !== 0) {
        closing++;
        if (f.closedPnl > 0) wins++;
      }
    }
    if (finite(f.time)) {
      oldest = oldest === null ? f.time : Math.min(oldest, f.time);
      newest = newest === null ? f.time : Math.max(newest, f.time);
    }
  }
  return { count: fills.length, volume, fees, realised, closing, wins, oldest, newest };
}

/* ---------------------------------------------------------------------------
 * PRICES - Hyperliquid quotes to five significant figures.
 * ------------------------------------------------------------------------ */

/**
 * Decimal places that show a price to six significant figures, clamped to 0..8.
 *
 * One fixed precision cannot serve a book that holds BTC at 75,921.5 and a
 * memecoin at 0.0001234: two places turns the second into 0.00. The venue has
 * no tick size in the contract, so the precision follows the magnitude.
 */
export function priceDp(v: number): number {
  if (!Number.isFinite(v) || v === 0) return 2;
  const mag = Math.floor(Math.log10(Math.abs(v)));
  return Math.max(0, Math.min(8, 5 - mag));
}
