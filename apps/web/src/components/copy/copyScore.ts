/**
 * The scores on the Copy page's trader cards, 0 to 100, from the PUBLIC
 * figures a board row carries for the window. The same formula for every
 * trader and every viewer; nothing personal goes in, and nothing in it is a
 * recommendation (the page says so next to it).
 *
 * COPY SCORE - how well copying this trader would have worked:
 *
 *   25  return      the window's return, as a percentile of the board's
 *   20  edge        PnL per traded dollar (bps) above what a copier pays per
 *                   traded dollar (taker fee, copy fee, slippage: COPY_COST_BPS).
 *                   A trader who churns for 5 bps a trade loses a copier money
 *                   however big their PnL is: this is what copying is about.
 *   15  profit      the window's PnL, as a percentile of the board's winners
 *   15  win rate    the LOWER end of the win rate's 95% interval (Wilson): 9 of
 *                   10 is not as sure as 900 of 1,000
 *   15  size        account value, $10k = none, $10M and more = full (log)
 *   10  record      closed trades, 20 = a third, 300 and more = full (log)
 *
 * COUNTER SCORE - how well taking the other side would have worked: the same
 * parts turned around (the loss as a percentile of the board's losers, edge
 * below minus the cost, the UPPER end of the win rate interval low), with size
 * and record as they are: a counter-trade needs a trader who keeps trading.
 *
 * A trader on the wrong side of the window for a score gets at most WRONG_SIDE_CAP.
 *
 * PERCENTILES, so the top of a strong board does not all read 99: each part
 * ranks the trader among the rows on screen. Without a cohort (one row alone)
 * the absolute fallbacks below are used.
 *
 * WHY ONLY THE BOARD'S FIGURES. The grid is sorted by these, and a card's
 * curve arrives later (each card reads its trader when it scrolls into view).
 * A score that changed as cards loaded would reshuffle the grid under the pointer.
 *
 * Pure: no React, no fetch.
 */
import type { BoardWindow, TraderRow } from '../../vsApi';

export const COPY_WEIGHTS = { roi: 25, edge: 20, profit: 15, winRate: 15, size: 15, record: 10 } as const;
/** The most a trader on the wrong side of the window (a loser for copying, a winner for countering) can score. */
export const WRONG_SIDE_CAP = 30;
/**
 * What a copier pays per traded dollar, bps: SoDEX taker 4 + copy fee 2.5 +
 * ~5 of slippage. An edge below this loses a copier money even when the trader
 * makes it; above it, the rest is the copier's.
 */
export const COPY_COST_BPS = 12;
/** Edge at which the edge part is full, above the cost. */
const EDGE_FULL_BPS = 100;

export type ScoreKind = 'copy' | 'counter';

export interface ScoreParts {
  roi: number;
  edge: number;
  profit: number;
  winRate: number;
  size: number;
  record: number;
}

export interface CopyScore {
  kind: ScoreKind;
  /** 0..100, whole. */
  score: number;
  /** Each part, 0..1, before its weight. */
  parts: ScoreParts;
  /** The window's return (fraction), or null when the row has none. */
  roi: number | null;
  /** PnL per traded dollar, bps, or null without volume. */
  edgeBps: number | null;
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const finite = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * The window's return. The venue's own ROI when the row has one; otherwise
 * PnL over the equity at the window's start (account value minus that PnL),
 * floored at a quarter of today's account value and at $1,000 so a trader
 * who withdrew most of it does not show a return of thousands of percent.
 */
export function windowReturn(row: Pick<TraderRow, 'pnl' | 'roi' | 'accountValue'>, w: BoardWindow): number | null {
  const venueRoi = (row.roi as Partial<Record<BoardWindow, number | null>>)[w];
  if (finite(venueRoi)) return venueRoi;
  const pnl = row.pnl[w];
  const av = row.accountValue;
  if (!finite(pnl) || !finite(av)) return null;
  const base = Math.max(av - pnl, 0.25 * av, 1_000);
  return pnl / base;
}

/** PnL per traded dollar in the window, bps. */
export function edgeBps(row: Pick<TraderRow, 'pnl' | 'volume'>, w: BoardWindow): number | null {
  const pnl = row.pnl[w];
  const vol = row.volume[w];
  if (!finite(pnl) || !finite(vol) || !(vol > 0)) return null;
  return (pnl / vol) * 10_000;
}

/** The 95% Wilson interval of k wins in n closes. */
export function wilson(p: number, n: number): { lo: number; hi: number } {
  if (!(n > 0)) return { lo: 0, hi: 1 };
  const z = 1.96;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const mid = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return { lo: Math.max(0, mid - half), hi: Math.min(1, mid + half) };
}

/* ------------------------------------------------------------ cohort ----- */

/** The board's figures, sorted, that the percentile parts rank against. */
export interface Cohort {
  roiUp: number[];
  roiDown: number[];
  pnlUp: number[];
  pnlDown: number[];
}

const up = (xs: number[]) => xs.filter((x) => x > 0).sort((a, b) => a - b);

export function cohortOf(rows: readonly TraderRow[], w: BoardWindow): Cohort {
  const rois = rows.map((r) => windowReturn(r, w)).filter(finite);
  const pnls = rows.map((r) => r.pnl[w]).filter(finite);
  return { roiUp: up(rois), roiDown: up(rois.map((x) => -x)), pnlUp: up(pnls), pnlDown: up(pnls.map((x) => -x)) };
}

/** The share of `sorted` at or below `v`, 0..1 (v <= 0 is 0). */
function percentile(sorted: readonly number[], v: number): number {
  if (!(v > 0) || !sorted.length) return 0;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

/* ------------------------------------------------------------ scores ----- */

function score(row: TraderRow, w: BoardWindow, kind: ScoreKind, cohort?: Cohort): CopyScore {
  const s = kind === 'copy' ? 1 : -1;
  const pnl = row.pnl[w];
  const roi = windowReturn(row, w);
  const edge = edgeBps(row, w);
  const av = row.accountValue;
  const closes = row.winRateCloses ?? null;
  const n = row.winRateExact === true && finite(row.trades) ? Math.max(row.trades, closes ?? 0) : (closes ?? 0);
  const wrKnown = finite(row.winRate) && n > 0;
  const trades = finite(row.trades) && row.trades > 0 ? row.trades : finite(closes) ? closes : null;

  const sideRoi = finite(roi) ? s * roi : null;
  const sidePnl = finite(pnl) ? s * pnl : null;
  let winPart = 0.3;
  if (wrKnown) {
    const { lo, hi } = wilson(row.winRate!, n);
    // Copy: the lower end must be high. Counter: the upper end must be low.
    winPart = kind === 'copy' ? clamp01((lo - 0.35) / 0.35) : clamp01((0.65 - hi) / 0.35);
  }

  const parts: ScoreParts = {
    roi: sideRoi === null || sideRoi <= 0 ? 0
      : cohort ? percentile(kind === 'copy' ? cohort.roiUp : cohort.roiDown, sideRoi)
      : clamp01(1 - Math.exp(-sideRoi / 0.3)),
    // The trader's edge on this side, minus what a copier pays to be there.
    edge: edge === null ? 0.3 : clamp01((s * edge - COPY_COST_BPS) / EDGE_FULL_BPS),
    profit: sidePnl === null || sidePnl <= 0 ? 0
      : cohort ? percentile(kind === 'copy' ? cohort.pnlUp : cohort.pnlDown, sidePnl)
      : clamp01(Math.log10(Math.max(1, sidePnl)) / 6),
    winRate: winPart,
    size: finite(av) && av > 0 ? clamp01((Math.log10(av) - 4) / 3) : 0,
    record: trades === null ? 0.3 : clamp01(Math.log10(trades + 1) / Math.log10(301)),
  };
  let total =
    parts.roi * COPY_WEIGHTS.roi +
    parts.edge * COPY_WEIGHTS.edge +
    parts.profit * COPY_WEIGHTS.profit +
    parts.winRate * COPY_WEIGHTS.winRate +
    parts.size * COPY_WEIGHTS.size +
    parts.record * COPY_WEIGHTS.record;
  if (sidePnl === null || sidePnl <= 0) total = Math.min(total, WRONG_SIDE_CAP);
  return { kind, score: Math.round(Math.min(100, Math.max(0, total))), parts, roi, edgeBps: edge };
}

/** How well copying this trader would have worked over the window. */
export const copyScore = (row: TraderRow, w: BoardWindow, cohort?: Cohort): CopyScore => score(row, w, 'copy', cohort);
/** How well taking the other side of this trader would have worked over the window. */
export const counterScore = (row: TraderRow, w: BoardWindow, cohort?: Cohort): CopyScore => score(row, w, 'counter', cohort);

/** The score's band: how strongly its card glows. */
export function scoreBand(score: number): 'high' | 'mid' | 'low' {
  return score >= 70 ? 'high' : score >= 45 ? 'mid' : 'low';
}

/** One sentence for the score's tooltip: what made this number. */
export function explainScore(s: CopyScore): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const edge = s.edgeBps === null ? 'unknown' : `${s.edgeBps.toFixed(0)} bps per traded dollar`;
  const name = s.kind === 'copy' ? 'Copy score' : 'Counter score';
  return (
    `${name} ${s.score}/100 from public figures: return ${pct(s.parts.roi)}, edge ${pct(s.parts.edge)} (${edge}, ` +
    `after ~${COPY_COST_BPS} bps of copy costs), profit ${pct(s.parts.profit)}, win rate ${pct(s.parts.winRate)}, ` +
    `account size ${pct(s.parts.size)}, track record ${pct(s.parts.record)} (weights 25/20/15/15/15/10; ` +
    `${s.kind === 'copy' ? 'a losing' : 'a winning'} trader scores at most ${WRONG_SIDE_CAP}). Not a recommendation.`
  );
}
