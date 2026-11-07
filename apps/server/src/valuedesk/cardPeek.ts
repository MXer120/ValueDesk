/**
 * What a Copy page card draws from a trader's peek (hyperliquid/trader.ts CardPeek): the window's PnL
 * curve and the newest trade. One function for the browser's own venue read (web copy/TraderCard.tsx)
 * and the server's card cache (copyCards.ts), so a cached card is the very curve the browser would draw.
 */
import type { BoardWindow, TraderProfile, Window } from './types.js';

/** The profile window a board window's card draws (90D, YTD: the all-time curve). */
export const PROFILE_WINDOW: Record<BoardWindow, Window> = { '1d': '1d', '7d': '7d', '30d': '30d', '90d': 'all', ytd: 'all', all: 'all' };

/** A card's curve (PnL points, oldest first; null: none to draw) and its newest trade (ms; null: unknown). */
export interface CardShown {
  spark: number[] | null;
  lastActive: number | null;
}

/** Anything with a profile's curves and summary spark / last trade (a CardPeek, a TraderProfile). */
export type PeekLike = Pick<TraderProfile, 'equity'> & { summary: Pick<TraderProfile['summary'], 'spark' | 'lastActive'> };

export function cardShown(p: PeekLike, w: BoardWindow): CardShown {
  const series = p.equity[PROFILE_WINDOW[w]] ?? p.equity['30d'] ?? [];
  const pnl = series.flatMap((pt) => (pt.pnl === null ? [] : [pt.pnl]));
  const spark = pnl.length > 1 ? pnl : p.summary.spark && p.summary.spark.length > 1 ? p.summary.spark : null;
  return { spark, lastActive: p.summary.lastActive ?? null };
}
