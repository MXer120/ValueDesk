/**
 * What Explore -> Markets reads of the index, in a pure module (no React, no CSS): Markets.tsx reads with these, and
 * the build's tables (firstReadDefaults.ts) name the same reads for a page about to be opened.
 */
import type { BoardWindow, Venue } from '@sign/valuedesk/types.js';
import { COPY_VENUES } from '../../copy/gridModel';
import { vsPaths, type LeaderboardQuery } from '../../../vsPaths';

/** The venues whose tracked wallets the "Tracked wallets" column sums. */
export const MAP_VENUES: readonly Venue[] = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];
/** Traders to copy: the window they are scored over. */
export const TRADERS_WINDOW: BoardWindow = '30d';
/** One copy venue's board, as Traders to copy reads it. */
export const tradersBoard = (venue: Venue): LeaderboardQuery => ({ venue, window: TRADERS_WINDOW, sort: 'pnl', limit: 100 });

/** The page's index reads, in the order it asks for them (the boards once the books are in). */
export const marketsReads = (): string[] => [
  vsPaths.screenerAssets,
  vsPaths.cohortMap(MAP_VENUES, null),
  vsPaths.sodexOiExcluded,
  ...COPY_VENUES.map((v) => vsPaths.leaderboard(tradersBoard(v))),
];
