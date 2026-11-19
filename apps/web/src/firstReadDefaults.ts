/**
 * THE BUILD'S FIRST READS (phone pass, 2026-11-18): per landing URL (path + query, as serverFetch.ts keys them), the
 * index reads that page makes first in its DEFAULT view - what a visitor who never opened it in this browser gets.
 * tools/route-preload.mjs writes this table into the route script (vite.config.ts), which starts those reads while the
 * HTML is still being read; serverFetch.ts hands each answer to the page's own read. A browser that has opened the URL
 * before starts what the page really read there instead (its venues, its window), so a default that differs from a
 * visitor's stored choice costs one read once.
 *
 * Built from the same builders and constants the pages read with (vsPaths.ts, lbState.ts, gridModel.ts,
 * markets/reads.ts), so a changed default changes this table with it. Loaded by the build config under Node: pure
 * modules only (type imports from @sign are erased).
 *
 * The order is the page's own: serverFetch.ts starts at most six per page and 64 KB on the wire together, first
 * first. Measured 2026-11-18 (fresh profile, phone and desktop, production data): these are every /api/vs read each
 * page made before its first poll. /points, /referrals, /portfolio and /scan read none of the index before a wallet.
 *
 * An EMPTY list is the page's rule, not a default: nothing is started early for that URL, whatever this browser
 * remembers, and nothing is learned for it.
 */
import { DEFAULT_MIN_TRADES, DEFAULT_VIEW, lbQuery } from './components/leaderboard/lbState';
import { GRID_DEFAULT_WINDOW, GRID_VENUES, boardVenues } from './components/copy/gridModel';
import { marketsReads } from './components/explore/markets/reads';
import { LOTTERY_FEED_SIZE } from './blindBox';
import { WEALTH_MAINTENANCE_PATH } from './components/sodex/wealthMaintenance';
import { SCAN_VENUES, vsPaths } from './vsPaths';

/** The Copy page's boards in its default view, in the order it asks: each platform's top hundred, then its worst. */
export const copyBoards = (): string[] => {
  const venues = boardVenues(GRID_VENUES);
  return [
    ...venues.map((venue) => vsPaths.leaderboard({ venue, window: GRID_DEFAULT_WINDOW, sort: 'pnl', limit: 100 })),
    ...venues.map((venue) => vsPaths.leaderboard({ venue, window: GRID_DEFAULT_WINDOW, sort: 'pnl', limit: 100, side: 'worst' })),
  ];
};

export function firstReadDefaults(): Record<string, string[]> {
  return {
    /*
     * NONE, also for a browser that remembers reads there: these pages draw their first data only once SoDEX's own
     * reads are in (the trade page's candles; Explore's board waits for SoDEX's tickers too), so an index read started
     * ahead only shares the line with the page's code. Measured 2026-11-18 (Slow 4G, 4x CPU, local HTTP/2, 3 runs):
     * /explore with its five reads early (46 KB) first paint +0.34 s and data +0.14 s; the screener alone +0.05 s /
     * -0.04 s, nothing. What these pages read is started on intent instead (aheadReads, below).
     */
    '/': [],
    '/trade': [],
    '/explore': [],
    // Cohorts open on every venue (Cohorts.tsx: the stored set, SCAN_VENUES by default) and no filter.
    '/explore?view=cohorts': [vsPaths.cohorts(SCAN_VENUES, {})],
    // The podium's curves follow only when the board lacks them: not started ahead.
    // Measured (as above): first paint +0.22 s, the board -0.60 s; the cohorts (below) +0.18 s / -0.90 s.
    '/leaderboard': [vsPaths.leaderboard(lbQuery(DEFAULT_VIEW, DEFAULT_MIN_TRADES))],
    /*
     * NONE either: Discover draws once every platform's board is in (five hundreds, ~42 KB); started early they only
     * shared the line with the code - first paint +0.26 s for the cards -0.15 s (2 runs). Its reads: copyBoards(),
     * started on intent (aheadReads).
     */
    '/copy': [],
    // The Bots overview's Market conditions (BotsRegime.tsx MarketConditions: every market, 24 h, by default).
    '/bots': [vsPaths.botRegime('ALL', '24h')],
    '/blind-boxes': [vsPaths.lotteryMeta, vsPaths.lotteryFeed(LOTTERY_FEED_SIZE)],
    '/wealth': [WEALTH_MAINTENANCE_PATH],
  };
}

/**
 * A page ABOUT TO BE OPENED in the app (its tab touched, the phone's More sheet opened: serverFetch.ts primeRoute) where
 * nothing is started early on landing: there is no first paint to share the line with, so its reads go at once.
 */
export function aheadReads(): Record<string, string[]> {
  const trade = [vsPaths.sodexOiExcluded];
  return { '/': trade, '/trade': trade, '/explore': marketsReads(), '/copy': copyBoards() };
}
