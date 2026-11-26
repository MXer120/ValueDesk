/**
 * What a trade page version changes in the dashboard's own config: the gutter between panels and its own default
 * design. Owner 2026-11-26: "Rework trade page more, and more uniquely". Each version keeps its layout under its own
 * id (`trade-deck`, `trade-pulse`; storage.ts keys on it), so a browser with a saved Trade layout
 * still sees each version's own design, an edit made in a version stays in that version, and the saved Trade layout
 * itself is never read or written by a version.
 *
 * Deck: the ticket first, on the left. Pulse: the chart takes the page; the ticket over the book in one rail card on
 * the right, positions and the account in a frameless drawer under the chart.
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
 * Deck's default design, ticket first: the ticket alone down the whole left column (every step to what the order
 * costs, nothing scrolled), the chart in the middle, the book on the right; positions under the chart, the account
 * under the book. In reading order: decide, look, read the depth.
 *
 * Deck's cards stand 12px apart every way. The lg grid fits its rows to the screen and counts a gutter per row
 * (Dashboard.tsx), so 90 rows of 12px gutters would outgrow a laptop: Deck's lg grid has 45 rows, and this design is
 * written in them (every column sums to 45).
 */
const DECK_ROWS = 45;
const DECK_LG: PanelPlacement[] = [
  { i: 'exec', x: 0, y: 0, w: 10, h: 45 },
  { i: 'markets', x: 10, y: 0, w: 28, h: 3 },
  { i: 'chart', x: 10, y: 3, w: 28, h: 27 },
  { i: 'book', x: 38, y: 0, w: 10, h: 30 },
  { i: 'positions', x: 10, y: 30, w: 28, h: 15 },
  { i: 'account', x: 38, y: 30, w: 10, h: 15 },
];

/**
 * Pulse's focus (owner 2026-11-26: "4 chart is unique keep but rest is bad"): the chart 37 of 48 columns on the
 * backdrop; on its right one rail, the ticket over the book in a single card (no gap between them: Pulse's lg grid
 * has 12px between columns and none between rows); under the chart a frameless drawer, positions and the account.
 * 90 rows, the original's count: rows carry no gutter here.
 */
const PULSE_LG: PanelPlacement[] = [
  { i: 'markets', x: 0, y: 0, w: 37, h: 6 },
  { i: 'chart', x: 0, y: 6, w: 37, h: 62 },
  { i: 'positions', x: 0, y: 68, w: 26, h: 22 },
  { i: 'account', x: 26, y: 68, w: 11, h: 22 },
  // The ticket down to its send button on a 900px screen (what it costs scrolls under it); the book below, five levels
  // a side there and more on a taller screen.
  { i: 'exec', x: 37, y: 0, w: 11, h: 55 },
  { i: 'book', x: 37, y: 55, w: 11, h: 35 },
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
  const id = v === 'original' ? base.id : `${base.id}-${v}`;
  switch (v) {
    case 'deck': {
      // 12px between the cards on a wide screen; the smaller tiers keep the 6px their designs were made with.
      const grid = withMargin(base.grid, 6);
      return {
        ...base,
        id,
        grid: { ...grid, lg: { ...grid.lg, margin: [12, 12], fitRows: DECK_ROWS } },
        layouts: {
          ...base.layouts,
          lg: DECK_LG,
          md: ticketLeft(base.layouts.md),
          // The phone's one screen: book and ticket side by side under a chart that opens on a tap (PhoneDeck.tsx).
          sm: phone({ markets: 2, ticker: 2, band: 24, positions: 12, account: 7 }),
          xs: phone({ markets: 2, ticker: 3, band: 23, positions: 11, account: 9 }),
        },
      };
    }
    case 'pulse': {
      // 12px between the chart and the rail, none between rows (the rail is one card); the smaller tiers keep the
      // original's gutter.
      return {
        ...base,
        id,
        grid: { ...base.grid, lg: { ...base.grid.lg, margin: [12, 0] } },
        layouts: {
          ...base.layouts,
          lg: PULSE_LG,
          // Chart first, then the book; the ticket is a sheet off the sticky Long / Short bar (PhonePulse.tsx). The coin
          // row a row taller: the 24-hour line under it (RangeBar.tsx).
          sm: phone({ markets: 2, ticker: 3, band: 26, positions: 12, account: 7 }),
          xs: phone({ markets: 2, ticker: 5, band: 26, positions: 11, account: 9 }),
        },
      };
    }
    default:
      return base;
  }
}
