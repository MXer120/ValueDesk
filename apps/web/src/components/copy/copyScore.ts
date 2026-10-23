/**
 * The copy score on the Copy page's trader cards: one number, 0 to 100, from
 * the PUBLIC figures a board row already carries for the window. The same
 * formula for every trader and every viewer; nothing personal goes in, and
 * nothing in it is a recommendation (the page says so next to it).
 *
 *   30  profit         the window's PnL, on a log scale ($1M and more = full)
 *   25  return         PnL over the equity it was made on (1 - e^(-roi/0.3))
 *   20  win rate       0.40 or less = none, 0.75 or more = full; unknown = 0.4 of it
 *   15  account size   $1k = none, $10M and more = full (log scale)
 *   10  track record   closed trades in the sample, log scale (300 = full)
 *
 * A trader who lost money over the window scores at most LOSING_CAP.
 *
 * WHY ONLY THE BOARD'S FIGURES. The grid is sorted by this score, and a card's
 * curve and drawdown arrive later (each card reads its trader when it scrolls
 * into view). A score that changed as cards loaded would reshuffle the grid
 * under the pointer. These inputs are all on the row from the first paint.
 *
 * Pure: no React, no fetch.
 */
import type { BoardWindow, TraderRow } from '../../vsApi';

export const SCORE_WEIGHTS = { profit: 30, roi: 25, winRate: 20, size: 15, record: 10 } as const;
/** The highest score a trader with a loss over the window can get. */
export const LOSING_CAP = 35;
/** A win rate from fewer closes than this counts as unknown. */
export const MIN_CLOSES = 10;

export interface ScoreParts {
  profit: number;
  roi: number;
  winRate: number;
  size: number;
  record: number;
}

export interface CopyScore {
  /** 0..100, whole. */
  score: number;
  /** Each part, 0..1, before its weight. */
  parts: ScoreParts;
  /** The return the score used (fraction), or null when the row has none. */
  roi: number | null;
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

export function copyScore(row: TraderRow, w: BoardWindow): CopyScore {
  const pnl = row.pnl[w];
  const roi = windowReturn(row, w);
  const av = row.accountValue;
  const closes = row.winRateCloses ?? null;
  const wrKnown = finite(row.winRate) && (row.winRateExact === true || (closes ?? 0) >= MIN_CLOSES);
  const trades = finite(row.trades) && row.trades > 0 ? row.trades : finite(closes) ? closes : null;

  const parts: ScoreParts = {
    profit: finite(pnl) && pnl > 0 ? clamp01(Math.log10(Math.max(1, pnl)) / 6) : 0,
    roi: finite(roi) && roi > 0 ? clamp01(1 - Math.exp(-roi / 0.3)) : 0,
    winRate: wrKnown ? clamp01((row.winRate! - 0.4) / 0.35) : 0.4,
    size: finite(av) && av > 0 ? clamp01((Math.log10(av) - 3) / 4) : 0,
    record: trades === null ? 0.3 : clamp01(Math.log10(trades + 1) / Math.log10(301)),
  };
  let score =
    parts.profit * SCORE_WEIGHTS.profit +
    parts.roi * SCORE_WEIGHTS.roi +
    parts.winRate * SCORE_WEIGHTS.winRate +
    parts.size * SCORE_WEIGHTS.size +
    parts.record * SCORE_WEIGHTS.record;
  if (!finite(pnl) || pnl <= 0) score = Math.min(score, LOSING_CAP);
  return { score: Math.round(Math.min(100, Math.max(0, score))), parts, roi };
}

/** The score's band: what colour its meter is drawn in. */
export function scoreBand(score: number): 'high' | 'mid' | 'low' {
  return score >= 70 ? 'high' : score >= 45 ? 'mid' : 'low';
}

/** One sentence for the score's tooltip: what made this number. */
export function explainScore(s: CopyScore): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    `Copy score ${s.score}/100 from public figures: profit ${pct(s.parts.profit)}, return ${pct(s.parts.roi)}, ` +
    `win rate ${pct(s.parts.winRate)}, account size ${pct(s.parts.size)}, track record ${pct(s.parts.record)} ` +
    `(weights 30/25/20/15/10; a losing trader scores at most ${LOSING_CAP}). Not a recommendation.`
  );
}
