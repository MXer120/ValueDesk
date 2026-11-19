/**
 * Futures or spot for a bot (owner 2026-11-19: "select futures/spot when creating a new bot, during setup & in
 * settings"). One coin trades on both SoDEX engines under two names - BTC-USD (futures) and vBTC_vUSDC (spot, shown
 * as BTC/USDC) - so the switch maps a market to its twin on the other engine, by the coin.
 *
 * Spot differs where it matters to a bot, and the page says so:
 *   - no short: a market maker only sells what it bought, a grid's sells follow its filled buys;
 *   - no leverage or margin: buys are paid from the account's spot USDC;
 *   - SoDEX's spot fees are its own (the market's makerFee / takerFee), and the builder fee is charged on sells only.
 */
import type { Engine } from '../api';

export type BotEngine = Engine;
export const BOT_ENGINES: readonly BotEngine[] = ['perps', 'spot'];
export const ENGINE_NAME: Record<BotEngine, string> = { perps: 'Futures', spot: 'Spot' };

/** The engine a market name belongs to: SoDEX's spot names join two coins with "_" (vBTC_vUSDC). */
export const engineOfSymbol = (symbol: string): BotEngine => (symbol.includes('_') ? 'spot' : 'perps');

/** A spot market a bot can run on: quoted in USDC (what a bot's buys are paid with). */
export const isBotSpot = (symbol: string): boolean => /_vUSDC$/.test(symbol) && !/^vUSDT_/.test(symbol);

/** The coin of a market, comparable across engines: BTC-USD -> BTC, vBTC_vUSDC -> BTC, WSOSO_vUSDC -> SOSO. */
export function coinOf(symbol: string): string {
  if (engineOfSymbol(symbol) === 'perps') return symbol.replace(/-USD$/, '').toUpperCase();
  const base = symbol.split('_')[0] ?? symbol;
  return base.replace(/^v(?=[A-Z])/, '').replace(/^W(?=SOSO$)/, '').toUpperCase();
}

/** A market's name as people read it: BTC on futures, BTC/USDC on spot. */
export function marketLabel(symbol: string): string {
  if (engineOfSymbol(symbol) === 'perps') return symbol.replace(/-USD$/, '');
  return `${(symbol.split('_')[0] ?? symbol).replace(/^v(?=[A-Z])/, '')}/USDC`;
}

/** The same coin's market on the other engine, from that engine's market list (null: it has none). */
export function twinOf(symbol: string, to: BotEngine, names: readonly string[]): string | null {
  if (engineOfSymbol(symbol) === to) return symbol;
  const coin = coinOf(symbol);
  return names.find((n) => engineOfSymbol(n) === to && (to === 'perps' || isBotSpot(n)) && coinOf(n) === coin) ?? null;
}
