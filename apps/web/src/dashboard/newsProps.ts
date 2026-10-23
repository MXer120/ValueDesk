import { coinLabel } from '../format';
import type { TradeContext } from './registry';

/** A market's coin as the news names it: BTC for a spot market's vBTC too, PEPE for 1000PEPE. */
const newsCoin = (base: string | undefined | null) => coinLabel(base).replace(/^v(?=[A-Z0-9])/, '').toUpperCase().replace(/^1000+(?=[A-Z])/, '');
const NEWS_FIRST = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];

/**
 * What the News widget takes from the trade page (NewsFeed.tsx): the chart's
 * coin, the coins this book trades - the majors first, then A to Z - and the
 * switch that opens a coin's chart from a story.
 */
export function newsProps(c: TradeContext) {
  const market = new Map<string, string>();
  for (const s of c.byName.values()) {
    const coin = newsCoin(s.baseCoin);
    if (coin && !market.has(coin)) market.set(coin, s.name);
  }
  const rank = (s: string) => (NEWS_FIRST.includes(s) ? NEWS_FIRST.indexOf(s) : NEWS_FIRST.length);
  const markets = [...market.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((symbol) => ({ symbol }));
  const open = c.onSelectSymbol;
  return {
    coin: newsCoin(c.sym?.baseCoin) || null,
    markets,
    onCoin: open ? (symbol: string) => { const m = market.get(symbol); if (m) open(m); } : undefined,
  };
}
