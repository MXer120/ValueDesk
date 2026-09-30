/**
 * Named starting points for the trade page, in the shape of the layout-preset
 * cards: a picture of the grid, a title, and one line about it.
 * Placements are the lg grid (48 columns, 90 rows). Other breakpoints keep
 * the designed arrangement until the user moves something there.
 */
import type { PanelPlacement } from './types';

export interface LayoutPreset {
  id: string;
  title: string;
  blurb: string;
  /** Absent breakpoint means "the designed default at that size". */
  layouts: { lg?: PanelPlacement[] };
}

const price: PanelPlacement[] = [
  { i: 'markets', x: 0, y: 0, w: 36, h: 3 },
  { i: 'ticker', x: 0, y: 3, w: 36, h: 4 },
  { i: 'chart', x: 0, y: 7, w: 36, h: 53 },
  { i: 'book', x: 36, y: 0, w: 6, h: 60 },
  { i: 'exec', x: 42, y: 0, w: 6, h: 60 },
  { i: 'positions', x: 0, y: 60, w: 36, h: 30 },
  { i: 'account', x: 36, y: 60, w: 12, h: 30 },
];

const flow: PanelPlacement[] = [
  { i: 'markets', x: 0, y: 0, w: 20, h: 3 },
  { i: 'ticker', x: 0, y: 3, w: 20, h: 4 },
  { i: 'chart', x: 0, y: 7, w: 20, h: 53 },
  { i: 'book', x: 20, y: 0, w: 16, h: 60 },
  { i: 'exec', x: 36, y: 0, w: 12, h: 60 },
  { i: 'positions', x: 0, y: 60, w: 36, h: 30 },
  { i: 'account', x: 36, y: 60, w: 12, h: 30 },
];

const review: PanelPlacement[] = [
  { i: 'markets', x: 0, y: 0, w: 28, h: 3 },
  { i: 'ticker', x: 0, y: 3, w: 28, h: 4 },
  { i: 'chart', x: 0, y: 7, w: 28, h: 33 },
  { i: 'book', x: 28, y: 0, w: 10, h: 40 },
  { i: 'exec', x: 38, y: 0, w: 10, h: 40 },
  { i: 'positions', x: 0, y: 40, w: 28, h: 50 },
  { i: 'account', x: 28, y: 40, w: 20, h: 50 },
];

const higher: PanelPlacement[] = [
  { i: 'chart', x: 0, y: 0, w: 34, h: 58 },
  { i: 'book', x: 34, y: 0, w: 14, h: 58 },
  { i: 'positions', x: 0, y: 58, w: 48, h: 32 },
];

const liquidations: PanelPlacement[] = [
  { i: 'chart', x: 0, y: 0, w: 28, h: 50 },
  { i: 'liq', x: 28, y: 0, w: 20, h: 50 },
  { i: 'book', x: 0, y: 50, w: 24, h: 40 },
  { i: 'poschg', x: 24, y: 50, w: 24, h: 40 },
];

const traders: PanelPlacement[] = [
  { i: 'chart', x: 0, y: 0, w: 30, h: 50 },
  { i: 'book', x: 30, y: 0, w: 18, h: 50 },
  { i: 'toptraders', x: 0, y: 50, w: 28, h: 40 },
  { i: 'positions', x: 28, y: 50, w: 20, h: 40 },
];

const funding: PanelPlacement[] = [
  { i: 'chart', x: 0, y: 0, w: 32, h: 48 },
  { i: 'funding', x: 32, y: 0, w: 16, h: 48 },
  { i: 'positions', x: 0, y: 48, w: 32, h: 42 },
  { i: 'account', x: 32, y: 48, w: 16, h: 42 },
];

export const TRADE_PRESETS: LayoutPreset[] = [
  {
    id: 'default',
    title: 'Default',
    blurb: 'Chart, book, and ticket, the usual terminal.',
    layouts: {},
  },
  {
    id: 'price',
    title: 'Price action',
    blurb: 'The chart takes the width. Book and ticket stay beside it.',
    layouts: { lg: price },
  },
  {
    id: 'flow',
    title: 'Order flow',
    blurb: 'The book and the ticket share the top with a narrower chart.',
    layouts: { lg: flow },
  },
  {
    id: 'review',
    title: 'Portfolio review',
    blurb: 'Positions and the account take the lower half of the page.',
    layouts: { lg: review },
  },
  {
    id: 'higher',
    title: 'Higher',
    blurb: 'Chart and book on top, positions across the bottom.',
    layouts: { lg: higher },
  },
  {
    id: 'liquidations',
    title: 'Liquidations',
    blurb: 'Chart beside the liquidation map, changes underneath.',
    layouts: { lg: liquidations },
  },
  {
    id: 'traders',
    title: 'Top traders',
    blurb: 'Chart and book, with the leader list under the chart.',
    layouts: { lg: traders },
  },
  {
    id: 'funding',
    title: 'Funding',
    blurb: 'Funding next to the chart, positions and balances below.',
    layouts: { lg: funding },
  },
];
