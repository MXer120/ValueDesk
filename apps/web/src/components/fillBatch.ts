/**
 * How a run of fills becomes notification cards (FillToasts.tsx). A burst (one order sweeping several levels)
 * collapses into one card per market and side once the stream has been quiet for a moment.
 *
 * An account whose bots fill several times a second is never quiet, so the wait also has a limit: without one
 * no card ever came while they ran (measured 2026-11-05, 5 fills a second and up). And a batch over many markets
 * says so on one card rather than sending one per market past the four the rail shows.
 */
import { coinLabel, fmt } from '../format';

export const FILL_QUIET_MS = 350;
export const FILL_MAX_WAIT_MS = 2_000;
export const FILL_MAX_CARDS = 3;

export interface FillGroup { qty: number; notional: number; maker: boolean; side: 'buy' | 'sell' | null; symbol: string; fills: number }
export interface FillCard { coin?: string; title: string; detail: string }

/** "BTC-USD" / "vBTC_vUSDC" -> "BTC". */
export const baseOf = (symbol: string): string => (symbol.split(/[-_/]/)[0] ?? symbol).replace(/^v(?=[A-Z])/, '');

/** How long to wait for more, the first fill of this batch having come at `firstAt`. */
export const fillWait = (firstAt: number, now: number): number => Math.min(FILL_QUIET_MS, Math.max(0, firstAt + FILL_MAX_WAIT_MS - now));

export function fillCards(groups: readonly FillGroup[], engine: 'spot' | 'perps'): FillCard[] {
  if (groups.length > FILL_MAX_CARDS) {
    const fills = groups.reduce((n, g) => n + g.fills, 0);
    const coins = [...new Set(groups.map((g) => coinLabel(baseOf(g.symbol)) || baseOf(g.symbol)))];
    const named = coins.slice(0, FILL_MAX_CARDS).join(', ');
    return [{
      title: `${fills.toLocaleString('en-US')} fills`,
      detail: coins.length > FILL_MAX_CARDS ? `${named} and ${coins.length - FILL_MAX_CARDS} more` : named,
    }];
  }
  return groups.map((g) => {
    const base = baseOf(g.symbol);
    const avg = g.qty > 0 ? g.notional / g.qty : 0;
    const sideWord = g.side === null ? '' : engine === 'perps' ? (g.side === 'buy' ? ' long' : ' short') : (g.side === 'buy' ? ' buy' : ' sell');
    return {
      coin: base,
      title: `${coinLabel(base) || base}${sideWord} filled`,
      detail: `${fmt(g.qty)} ${coinLabel(base) || base} @ ${fmt(avg)} · ${g.maker ? 'maker' : 'taker'}`,
    };
  });
}
