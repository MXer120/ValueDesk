/**
 * What a trade page version changes in the dashboard's own config: the gutter between panels and, for Deck, where
 * the default design puts the ticket. Never the config's id or version, so every saved layout (storage.ts keys on
 * both) loads unchanged in every version: a placement is columns and rows, and those mean the same at any gutter.
 *
 * The phone tiers (sm, xs) are fixed arrangements nobody drags (responsive.css), so a version may re-cut them.
 */
import type { DashboardConfig, GridMetrics, PanelPlacement } from '../types';
import type { PageVersion } from './store';

const withMargin = (g: DashboardConfig['grid'], m: number): DashboardConfig['grid'] => {
  const at = (x: GridMetrics): GridMetrics => ({ ...x, margin: [m, m] });
  return { lg: at(g.lg), md: at(g.md), sm: at(g.sm), xs: at(g.xs) };
};

/**
 * Deck's default design, ticket first: the ticket over the account on the left, the chart in the middle, the book
 * on the right, the account band under chart and book. The same panels and sizes as the original (28/10/10 of 48,
 * 60 + 30 of 90 rows), in reading order: decide, look, read the depth.
 */
const DECK_LG: PanelPlacement[] = [
  // The ticket a little taller than the book beside it, so its send button never scrolls on a 900px screen.
  { i: 'exec', x: 0, y: 0, w: 10, h: 65 },
  { i: 'account', x: 0, y: 65, w: 10, h: 25 },
  { i: 'markets', x: 10, y: 0, w: 28, h: 6 },
  { i: 'chart', x: 10, y: 6, w: 28, h: 54 },
  { i: 'book', x: 38, y: 0, w: 10, h: 60 },
  { i: 'positions', x: 10, y: 60, w: 38, h: 30 },
];

/** md: the ticket left of the book under the full-width chart. */
function ticketLeft(layout: readonly PanelPlacement[]): PanelPlacement[] {
  const exec = layout.find((p) => p.i === 'exec');
  const book = layout.find((p) => p.i === 'book');
  if (!exec || !book || exec.y !== book.y) return [...layout];
  return layout.map((p) => (p.i === 'exec' ? { ...p, x: book.x } : p.i === 'book' ? { ...p, x: exec.x } : p));
}

/** xs and sm, re-cut: the markets strip and the coin row, then the one trading panel, then the tables. */
function phone(h: { markets: number; ticker: number; band: number; positions: number; account: number }): PanelPlacement[] {
  let y = 0;
  const row = (i: string, rows: number): PanelPlacement => {
    const p = { i, x: 0, y, w: 48, h: rows };
    y += rows;
    return p;
  };
  return [row('markets', h.markets), row('ticker', h.ticker), row('book', h.band), row('positions', h.positions), row('account', h.account)];
}

export function tradeConfigFor(v: PageVersion, base: DashboardConfig): DashboardConfig {
  switch (v) {
    case 'slate':
      // One sheet: a 1px seam between panels, drawn by each panel's own hairline ring (slate.css). The markets strip
      // is one 36px band, level with the book's and the ticket's head bands beside it; the chart takes the rest.
      return {
        ...base,
        grid: withMargin(base.grid, 1),
        layouts: {
          ...base.layouts,
          lg: base.layouts.lg.map((p) => (p.i === 'markets' ? { ...p, h: 4 } : p.i === 'chart' ? { ...p, y: 4, h: 56 } : p)),
        },
      };
    case 'deck':
      return {
        ...base,
        grid: withMargin(base.grid, 6),
        layouts: {
          ...base.layouts,
          lg: DECK_LG,
          md: ticketLeft(base.layouts.md),
          // The phone's one screen: book and ticket side by side under a chart that opens on a tap (PhoneDeck.tsx).
          sm: phone({ markets: 2, ticker: 2, band: 24, positions: 12, account: 7 }),
          xs: phone({ markets: 2, ticker: 3, band: 23, positions: 11, account: 9 }),
        },
      };
    case 'pulse':
      return {
        ...base,
        layouts: {
          ...base.layouts,
          // Chart first, then the book; the ticket is a sheet off the sticky Long / Short bar (PhonePulse.tsx). The coin
          // row a row taller: the 24-hour line under it (RangeBar.tsx).
          sm: phone({ markets: 2, ticker: 3, band: 26, positions: 12, account: 7 }),
          xs: phone({ markets: 2, ticker: 5, band: 26, positions: 11, account: 9 }),
        },
      };
    default:
      return base;
  }
}
