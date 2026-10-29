/**
 * Every widget the terminal can show: its palette name, a line on what it shows
 * (the palette's search reads both), and its group. Every one of them is also a
 * tab the account band or the chart card can hold, bar the panel itself
 * (tabWidgetIds). What each draws is widgetBodies.tsx; its card, sketches.tsx.
 */

export type WidgetGroup = 'Suggested' | 'Portfolio' | 'Charts' | 'Tools';

export interface WidgetFace {
  id: string;
  name: string;
  /** What it shows, in a line: the card's subtitle and what the search matches. */
  blurb: string;
  group: WidgetGroup;
  /** A shorter name for a tab label, where the name is long. */
  tab?: string;
}

export const WIDGET_GROUPS: WidgetGroup[] = ['Suggested', 'Portfolio', 'Charts', 'Tools'];

export const WIDGET_FACES: readonly WidgetFace[] = [
  { id: 'chart', name: 'Price chart', blurb: 'Candles for the market on screen, with your orders and position on the axis', group: 'Suggested' },
  { id: 'book', name: 'Order book', blurb: 'Bids and asks with depth; a click prices the ticket', group: 'Suggested' },
  { id: 'exec', name: 'Order entry', blurb: 'The order ticket: long or short, limit, market, stop and algos', group: 'Suggested' },
  { id: 'liqmap', name: 'Liquidation heatmap', blurb: 'Where open positions would be liquidated, by price and time', group: 'Suggested', tab: 'Liq. heatmap' },

  { id: 'positions', name: 'Account activity', blurb: 'Positions, open orders, balances and history in one tabbed band', group: 'Portfolio' },
  { id: 'account', name: 'Balances', blurb: 'Account value, margin and what you can trade with', group: 'Portfolio' },
  { id: 'assets', name: 'Assets', blurb: 'Spot, perps and wallet balances together', group: 'Portfolio' },
  { id: 'orders', name: 'Open orders', blurb: 'Your resting orders, to modify or cancel', group: 'Portfolio' },
  { id: 'fills', name: 'Fills', blurb: 'Your trade history: every fill with price, size and fee', group: 'Portfolio' },
  { id: 'history', name: 'History', blurb: 'Trades, orders, funding payments and closed positions', group: 'Portfolio' },
  { id: 'transfers', name: 'Transfers', blurb: 'Deposits, withdrawals and transfers between accounts', group: 'Portfolio' },
  { id: 'twap', name: 'Algo orders', blurb: 'TWAP, VWAP, DCA and the other algos, running and ended', group: 'Portfolio' },
  { id: 'twaplive', name: 'Running algos', blurb: 'The algo orders working right now, with their progress', group: 'Portfolio' },
  { id: 'copy', name: 'Copytrade', blurb: 'The traders you copy and how each copy is doing', group: 'Portfolio' },
  { id: 'quick', name: 'Quick trade', blurb: 'A second order ticket for the market on screen', group: 'Portfolio' },
  { id: 'watch', name: 'Watchlist', blurb: 'Your starred markets with last price and 24h move', group: 'Portfolio' },

  { id: 'heatmap', name: 'Price heatmap', blurb: 'Every market by 24h volume, coloured by its 24h move', group: 'Charts' },
  { id: 'cohort', name: 'Market map', blurb: 'What tracked wallets hold, asset by asset, and which way they lean', group: 'Charts' },
  { id: 'funding', name: 'Funding spreads', blurb: 'SoDEX against Hyperliquid funding, market by market', group: 'Charts' },
  { id: 'indicator', name: 'Economic indicator', blurb: 'A macro series (CPI, jobs, rates) with its releases', group: 'Charts', tab: 'Indicator' },
  { id: 'etfflows', name: 'ETF flows', blurb: 'Daily net flows into the spot bitcoin and ether ETFs', group: 'Charts' },

  { id: 'tape', name: 'Trades', blurb: 'Every print on the market on screen, newest first', group: 'Tools' },
  { id: 'poschg', name: 'Whale trades', blurb: 'Large fills on SoDEX and Hyperliquid, with the wallet', group: 'Tools' },
  { id: 'news', name: 'News', blurb: 'Headlines for the market on screen and the macro calendar', group: 'Tools' },
  { id: 'livefeed', name: 'Live feed', blurb: 'Live market video streams', group: 'Tools' },
  { id: 'fedlive', name: 'Fed live', blurb: "The Fed chair's press conference, transcribed live", group: 'Tools' },
  { id: 'fedwatch', name: 'FOMC rate odds', blurb: 'What prediction markets price for the next FOMC decision', group: 'Tools', tab: 'FOMC odds' },
  { id: 'cohorts', name: 'Cohorts', blurb: 'Wallets grouped by size and profit: their positioning and PnL', group: 'Tools' },
  { id: 'toptraders', name: 'Top traders', blurb: 'The leaderboard across SoDEX, Hyperliquid and the other venues', group: 'Tools' },
  { id: 'leaderboard', name: 'Leaderboard', blurb: 'SoDEX traders ranked by PnL, with your rank', group: 'Tools' },
  { id: 'sizecalc', name: 'Position size calculator', blurb: 'Size from your equity, risk and stop distance', group: 'Tools', tab: 'Position size' },
  { id: 'markets', name: 'Markets', blurb: 'The market strip: your favourites, one click to switch', group: 'Tools' },
  { id: 'ticker', name: 'Market summary', blurb: 'The market on screen: price, 24h change, volume and funding', group: 'Tools' },
  { id: 'feetier', name: 'Fee tier', blurb: 'Your SoDEX fee tier, volume and what the next tier needs', group: 'Tools' },
  { id: 'venue', name: 'Venue status', blurb: 'SoDEX and Hyperliquid: up, slow or down', group: 'Tools' },
];

const BY_ID = new Map(WIDGET_FACES.map((face) => [face.id, face]));

export function faceFor(id: string): WidgetFace | undefined {
  return BY_ID.get(id);
}

/** The palette search: every word must appear in the name, the line or the group. */
export function matchesWidget(q: string, name: string, blurb?: string, group?: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${name} ${blurb ?? ''} ${group ?? ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * What a tab of `host` (the band: `positions`; the chart card: `chart`) may
 * hold: every widget but the host itself - and, on the chart card, its own
 * coin row - in palette order. FOMC rate odds stay out while their licence is
 * off (FedWatch.tsx FOMC_ODDS_ON).
 */
export function tabWidgetIds(host: 'positions' | 'chart', fomcOn: boolean): string[] {
  const skip = new Set([host, ...(host === 'chart' ? ['ticker'] : []), ...(fomcOn ? [] : ['fedwatch'])]);
  return WIDGET_FACES.map((f) => f.id).filter((id) => !skip.has(id));
}

/** Size = equity × risk% / (price × stop%). Null when an input cannot be used. */
export function positionSize(equity: number, riskPct: number, stopPct: number, price: number): number | null {
  if (!(equity > 0) || !(riskPct > 0) || !(stopPct > 0) || !(price > 0)) return null;
  const perUnit = price * (stopPct / 100);
  if (!(perUnit > 0)) return null;
  return (equity * (riskPct / 100)) / perUnit;
}

/** Ids that are not already a hand-built panel in the registry (registry.tsx draws them through widgetBodies.tsx). */
export const EXTRA_WIDGET_IDS: readonly string[] = [
  'poschg', 'copy', 'assets', 'orders', 'twap', 'history', 'fills', 'transfers', 'twaplive', 'watch', 'quick',
  'funding', 'cohort', 'heatmap', 'liqmap', 'tape', 'news', 'livefeed', 'fedlive', 'fedwatch', 'indicator',
  'etfflows', 'toptraders', 'cohorts', 'sizecalc',
];
