/**
 * Where the Copy page's panels sit. Same machinery and the same fixed 26px row
 * as the portfolio and points dashboards (dashboard/layout.ts): the page
 * scrolls, so it cannot derive a row height from its own content.
 *
 * THE TRADE PAGE'S SHAPE, ON PURPOSE. A copy setup is an order ticket for a
 * whole strategy, so it sits where the ticket sits - a 12-column column on the
 * right - with the backtest in the chart's place in the middle and the list you
 * pick from on the left. What you already have (your copies) runs along the
 * bottom under the chart and the ticket, like the account band.
 */
import type { DashboardConfig, PanelPlacement } from '../../dashboard';

const LG: PanelPlacement[] = [
  { i: 'traders',   x: 0,  y: 0,  w: 12, h: 12 },
  { i: 'trader',    x: 0,  y: 12, w: 12, h: 11 },
  { i: 'how',       x: 0,  y: 23, w: 12, h: 15 },
  { i: 'backtest',  x: 12, y: 0,  w: 24, h: 25 },
  { i: 'positions', x: 12, y: 25, w: 24, h: 6 },
  { i: 'setup',     x: 36, y: 0,  w: 12, h: 31 },
  { i: 'copies',    x: 12, y: 31, w: 36, h: 7 },
];

/** Two columns: the picker and the setup on the left, the results on the right. */
const MD: PanelPlacement[] = [
  { i: 'traders',   x: 0,  y: 0,  w: 20, h: 12 },
  { i: 'trader',    x: 0,  y: 12, w: 20, h: 11 },
  { i: 'setup',     x: 0,  y: 23, w: 20, h: 31 },
  { i: 'backtest',  x: 20, y: 0,  w: 28, h: 26 },
  { i: 'positions', x: 20, y: 26, w: 28, h: 7 },
  { i: 'copies',    x: 20, y: 33, w: 28, h: 8 },
  { i: 'how',       x: 20, y: 41, w: 28, h: 13 },
];

/** One column, in the order you would use it: pick, check, set up, test. */
const SM: PanelPlacement[] = [
  { i: 'traders',   x: 0, y: 0,   w: 48, h: 13 },
  { i: 'trader',    x: 0, y: 13,  w: 48, h: 12 },
  { i: 'setup',     x: 0, y: 25,  w: 48, h: 34 },
  { i: 'backtest',  x: 0, y: 59,  w: 48, h: 34 },
  { i: 'positions', x: 0, y: 93,  w: 48, h: 8 },
  { i: 'copies',    x: 0, y: 101, w: 48, h: 10 },
  { i: 'how',       x: 0, y: 111, w: 48, h: 17 },
];

export const COPY_DASHBOARD: DashboardConfig = {
  id: 'copy',
  /* 2: the band moved under the ticket; drops any layout saved from the first cut. */
  version: 2,
  breakpoints: { lg: 1200, md: 800, sm: 552, xs: 0 },
  grid: {
    lg: { cols: 48, rowHeight: 26, margin: [4, 4], containerPadding: [0, 0] },
    md: { cols: 48, rowHeight: 26, margin: [4, 4], containerPadding: [0, 0] },
    sm: { cols: 48, rowHeight: 26, margin: [4, 4], containerPadding: [0, 0] },
    xs: { cols: 48, rowHeight: 26, margin: [4, 4], containerPadding: [0, 0] },
  },
  layouts: { lg: LG, md: MD, sm: SM, xs: SM },
};
