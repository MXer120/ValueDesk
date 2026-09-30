/**
 * The leaderboard's time windows and the rules every board shares.
 *
 * Pure: no I/O, no clock of its own (callers pass `now`), so the board
 * builder and the tests agree on exactly where a window starts.
 */
import type { BoardWindow, Venue } from '../valuescan/types.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Every board the indexer keeps: venue x window x side x filter. */
export const INDEX_WINDOWS: readonly BoardWindow[] = ['1d', '7d', '30d', '90d', 'ytd', 'all'];
export type Side = 'top' | 'worst';
export const SIDES: readonly Side[] = ['top', 'worst'];
/** `active` = more than one trade in the window; `any` = no trade filter. */
export type BoardFilter = 'active' | 'any';
export const FILTERS: readonly BoardFilter[] = ['active', 'any'];

/** Rows per board. */
export const BOARD_SIZE = 100;

/**
 * "More than one trade". A trade is one EXECUTION: an account's fills in one
 * market, on one side, in one block. A taker order that sweeps three makers
 * is one trade; a resting order filled at three different times is three.
 * Opens and closes both count. The public streams and the REST histories
 * both carry exactly these fields, so both count the same thing.
 */
export const MIN_TRADES = 2;
export const HOUR_MS = 60 * 60 * 1000;

/** 1 January 00:00 UTC of the year containing `now`. */
export function yearStartUtc(now: number): number {
  return Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
}

/** First millisecond of the window. `all` starts at 0. */
export function windowStart(window: BoardWindow, now: number): number {
  switch (window) {
    case '1d': return now - DAY_MS;
    case '7d': return now - 7 * DAY_MS;
    case '30d': return now - 30 * DAY_MS;
    case '90d': return now - 90 * DAY_MS;
    case 'ytd': return yearStartUtc(now);
    case 'all': return 0;
  }
}

/** UTC day number (days since epoch) of a timestamp. */
export const dayOf = (t: number): number => Math.floor(t / DAY_MS);
/** Hours since epoch. */
export const hourOf = (t: number): number => Math.floor(t / HOUR_MS);

export const boardKey = (venue: Venue, window: BoardWindow, side: Side, filter: BoardFilter): string =>
  `${venue}|${window}|${side}|${filter}`;

/** The key a fill is counted under (see MIN_TRADES): block time, market, side. */
export function tradeKey(t: number, symbol: string, side: number): string {
  return `${t}|${symbol}|${side}`;
}
