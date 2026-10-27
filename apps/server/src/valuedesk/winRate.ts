/**
 * THE win rate. One definition for the leaderboard, the screener (Cmd+K),
 * Scan and the cohorts. Pure and isomorphic (the web reads it through @sign).
 *
 * WHAT ONE CLOSE IS. A run of consecutive position-reducing fills in one
 * market and one direction: it starts with the first fill that realises PnL
 * and ends at the next fill in that market that adds to a position (realises
 * nothing) or reduces in the other direction. So
 *   - a TWAP or a sweep that closes one position in 135 slices is ONE close
 *     (per-order counting made it 135, and a trader closing one losing short
 *     in slices showed 0% over a +$11.8M month);
 *   - partial take-profits in a row are one close; taking profit, adding, and
 *     taking profit again are two;
 *   - a flip (long > short) ends the run it belongs to.
 * SoDEX publishes closed positions (`positions/history`), one row per
 * position closed: each row is one close, the same unit.
 *
 * A WIN is a close whose realised PnL, summed over its fills, is positive -
 * GROSS, before fees (the venues' own `closedPnl` convention; fees are a
 * cost of trading, not of the call). Break-even closes count in neither
 * wins nor the denominator.
 *
 * EXACT OR ESTIMATE. A figure is exact when every close in the window is
 * held (the history reaches back to the window start). Otherwise it is an
 * estimate from the closes held, shown only from WIN_RATE_MIN_CLOSES closes
 * up, and the UI says so ("≈", "from the last N closes").
 */

/** Below this many held closes an estimate is not shown. */
export const WIN_RATE_MIN_CLOSES = 10;

export interface WinRate {
  winRate: number | null;
  winRateExact: boolean;
  winRateCloses: number | null;
}

/**
 * The published figure from wins / closes and whether they cover the whole
 * window. An exact figure shows from one close; an estimate from
 * WIN_RATE_MIN_CLOSES.
 */
export function winRateOf(wins: number | null | undefined, closes: number | null | undefined, exact: boolean): WinRate {
  const n = typeof closes === 'number' && Number.isFinite(closes) && closes > 0 ? closes : 0;
  const w = typeof wins === 'number' && Number.isFinite(wins) ? Math.max(0, Math.min(n, wins)) : 0;
  if (!n) return { winRate: null, winRateExact: exact, winRateCloses: closes == null ? null : 0 };
  if (!exact && n < WIN_RATE_MIN_CLOSES) return { winRate: null, winRateExact: false, winRateCloses: n };
  return { winRate: w / n, winRateExact: exact, winRateCloses: n };
}

/** One fill as the close definition needs it. `closedPnl` null = unknown (a stream print): skipped. */
export interface CloseFill {
  symbol: string;
  t: number;
  /** +1 bought, -1 sold (the account's side). */
  side: number;
  closedPnl: number | null;
}

/**
 * Closes and wins in a set of fills (any order). Fills with unknown PnL are
 * skipped; a fill with zero PnL is an opening fill and ends the market's run.
 */
export function closeRuns(fills: Iterable<CloseFill>): { closes: number; wins: number; runs: Array<{ symbol: string; t: number; pnl: number }> } {
  const bySymbol = new Map<string, CloseFill[]>();
  for (const f of fills) {
    if (f.closedPnl === null || !Number.isFinite(f.closedPnl)) continue;
    const l = bySymbol.get(f.symbol);
    if (l) l.push(f);
    else bySymbol.set(f.symbol, [f]);
  }
  const runs: Array<{ symbol: string; t: number; pnl: number }> = [];
  for (const [symbol, list] of bySymbol) {
    list.sort((a, b) => a.t - b.t);
    let open: { t: number; side: number; pnl: number } | null = null;
    for (const f of list) {
      const pnl = f.closedPnl!;
      if (pnl === 0) {
        if (open) runs.push({ symbol, t: open.t, pnl: open.pnl });
        open = null;
        continue;
      }
      if (open && open.side === Math.sign(f.side)) {
        open.pnl += pnl;
        continue;
      }
      if (open) runs.push({ symbol, t: open.t, pnl: open.pnl });
      open = { t: f.t, side: Math.sign(f.side), pnl };
    }
    if (open) runs.push({ symbol, t: open.t, pnl: open.pnl });
  }
  let closes = 0;
  let wins = 0;
  for (const r of runs) {
    if (r.pnl === 0) continue;
    closes++;
    if (r.pnl > 0) wins++;
  }
  return { closes, wins, runs };
}
