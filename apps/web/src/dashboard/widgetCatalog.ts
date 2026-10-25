/**
 * How a widget is drawn in the edit palette and inside a layout thumbnail.
 * The mark is a small colored schematic, the same idea as the reference
 * cards: a chart reads as a chart, a book as a book, a table as rows.
 */

export type SketchKind =
  | 'chart'
  | 'book'
  | 'table'
  | 'trades'
  | 'ticket'
  | 'liq'
  | 'stops'
  | 'funding'
  | 'heatmap'
  | 'cohort'
  | 'news'
  | 'calc';

export type WidgetGroup = 'Suggested' | 'Portfolio' | 'Charts' | 'Tools';

export interface WidgetFace {
  id: string;
  name: string;
  kind: SketchKind;
  group: WidgetGroup;
  /** Market-wide widget: All / SoDEX / Hyperliquid. Account tools leave this off. */
  source: boolean;
}

export const WIDGET_GROUPS: WidgetGroup[] = ['Suggested', 'Portfolio', 'Charts', 'Tools'];

export const WIDGET_FACES: readonly WidgetFace[] = [
  { id: 'chart', name: 'Price chart', kind: 'chart', group: 'Suggested', source: false },
  { id: 'book', name: 'Order book', kind: 'book', group: 'Suggested', source: false },
  { id: 'liq', name: 'Liquidations', kind: 'liq', group: 'Suggested', source: true },
  { id: 'poschg', name: 'Position changes', kind: 'trades', group: 'Suggested', source: true },

  { id: 'positions', name: 'Positions', kind: 'table', group: 'Portfolio', source: false },
  { id: 'copy', name: 'Copytrade', kind: 'table', group: 'Portfolio', source: false },
  { id: 'account', name: 'Balances', kind: 'table', group: 'Portfolio', source: false },
  { id: 'assets', name: 'Assets', kind: 'table', group: 'Portfolio', source: false },
  { id: 'orders', name: 'Open orders', kind: 'table', group: 'Portfolio', source: false },
  { id: 'twap', name: 'TWAP', kind: 'table', group: 'Portfolio', source: false },
  { id: 'history', name: 'History', kind: 'table', group: 'Portfolio', source: false },
  { id: 'fills', name: 'Fills', kind: 'trades', group: 'Portfolio', source: false },
  { id: 'transfers', name: 'Transfers', kind: 'table', group: 'Portfolio', source: false },
  { id: 'twaplive', name: 'Current TWAPs', kind: 'table', group: 'Portfolio', source: false },
  { id: 'watch', name: 'Watchlist', kind: 'table', group: 'Portfolio', source: false },
  { id: 'exec', name: 'Order entry', kind: 'ticket', group: 'Portfolio', source: false },
  { id: 'quick', name: 'Quick trade', kind: 'ticket', group: 'Portfolio', source: false },

  { id: 'stops', name: 'Stops', kind: 'stops', group: 'Charts', source: true },
  { id: 'funding', name: 'Historical funding', kind: 'funding', group: 'Charts', source: true },
  { id: 'cohort', name: 'Cohort heatmap', kind: 'cohort', group: 'Charts', source: true },
  { id: 'heatmap', name: 'Price heatmap', kind: 'heatmap', group: 'Charts', source: true },
  { id: 'liqmap', name: 'Liquidation heatmap', kind: 'liq', group: 'Charts', source: false },

  { id: 'tape', name: 'Trades', kind: 'trades', group: 'Tools', source: true },
  { id: 'news', name: 'News', kind: 'news', group: 'Tools', source: false },
  { id: 'livefeed', name: 'Live feed', kind: 'news', group: 'Tools', source: false },
  { id: 'fedlive', name: 'Fed live', kind: 'news', group: 'Tools', source: false },
  { id: 'fedwatch', name: 'FOMC rate odds', kind: 'table', group: 'Tools', source: false },
  { id: 'indicator', name: 'Economic indicator', kind: 'funding', group: 'Charts', source: false },
  { id: 'etfflows', name: 'ETF flows', kind: 'funding', group: 'Charts', source: false },
  { id: 'tracked', name: 'Tracked', kind: 'table', group: 'Tools', source: true },
  { id: 'toptraders', name: 'Top traders', kind: 'table', group: 'Tools', source: true },
  { id: 'cohorts', name: 'Cohorts', kind: 'cohort', group: 'Tools', source: true },
  { id: 'sizecalc', name: 'Position size calculator', kind: 'calc', group: 'Tools', source: false },
  { id: 'markets', name: 'Markets', kind: 'table', group: 'Tools', source: false },
  { id: 'ticker', name: 'Market summary', kind: 'table', group: 'Tools', source: false },
  { id: 'leaderboard', name: 'Leaderboard', kind: 'table', group: 'Tools', source: false },
  { id: 'feetier', name: 'Fee tier', kind: 'table', group: 'Tools', source: false },
  { id: 'venue', name: 'Venue status', kind: 'table', group: 'Tools', source: false },
];

const BY_ID = new Map(WIDGET_FACES.map((face) => [face.id, face]));

export function faceFor(id: string): WidgetFace | undefined {
  return BY_ID.get(id);
}

export function kindFor(id: string): SketchKind {
  return BY_ID.get(id)?.kind ?? 'table';
}

/** Size = equity × risk% / (price × stop%). Null when an input cannot be used. */
export function positionSize(equity: number, riskPct: number, stopPct: number, price: number): number | null {
  if (!(equity > 0) || !(riskPct > 0) || !(stopPct > 0) || !(price > 0)) return null;
  const perUnit = price * (stopPct / 100);
  if (!(perUnit > 0)) return null;
  return (equity * (riskPct / 100)) / perUnit;
}

/** Ids that are not already a hand-built panel in the registry. */
export const EXTRA_WIDGET_IDS: readonly string[] = [
  'liq', 'poschg', 'copy', 'assets', 'orders', 'twap', 'history', 'fills',
  'transfers', 'twaplive', 'watch', 'quick', 'stops', 'funding', 'cohort', 'heatmap', 'liqmap',
  'tape', 'news', 'livefeed', 'fedlive', 'fedwatch', 'indicator', 'etfflows', 'tracked', 'toptraders', 'cohorts', 'sizecalc',
];
