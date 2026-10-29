/**
 * A market SoDEX does not list is never traded here, and never silently swapped for another
 * (owner, 2026-10-29). One line says it everywhere (copy-engine markets.ts notListedLine): the
 * order ticket while its market is not on SoDEX's list, the trade page when a stored market, a
 * link or a saved chart names one that is not (it shows the default market then, and says so),
 * and the signing path (actions.ts symbolFor), which refuses before anything is signed.
 */
import { notListedLine } from '@copy-engine';

/** The coin of a SoDEX market name, as the line says it: 'PURR-USD' -> 'PURR', 'vPURR_vUSDC' and 'PURR_vUSDC' -> 'PURR'. */
export function marketCoin(name: string): string {
  const s = name.trim();
  const perp = /^(.+)-USD$/i.exec(s);
  if (perp) return perp[1]!;
  const spot = /^(?:v(?=[A-Z0-9]))?([A-Za-z0-9]+)_v?USDC$/.exec(s);
  return spot ? spot[1]! : s;
}

/** "PURR is not listed on SoDEX, so it can't be traded here." for a market name. */
export const notListed = (name: string): string => notListedLine(marketCoin(name));

/**
 * Whether `symbol` is known NOT to be on SoDEX's market list of `engine`. False while that list
 * has not come in, is empty, or is another engine's (for a moment after a switch): not knowing
 * is not "unlisted". Names compare as SoDEX's do, without case.
 */
export function knownUnlisted(
  symbol: string,
  engine: string,
  list: { engine?: string; symbols?: ReadonlyArray<{ name: string }> } | null | undefined,
): boolean {
  if (!symbol || !list || list.engine !== engine || !list.symbols?.length) return false;
  const want = symbol.toUpperCase();
  return !list.symbols.some((s) => s.name.toUpperCase() === want);
}

/**
 * The market a link names (/trade?symbol=BTC-USD: a position card's "Trade" link), with its
 * engine - spot names carry an underscore ('vBTC_vUSDC') - or null when it names none. Whether
 * SoDEX lists it is the trade page's to judge once its list is in.
 */
export function linkedMarket(search: string): { engine: 'perps' | 'spot'; symbol: string } | null {
  const symbol = new URLSearchParams(search).get('symbol')?.trim() ?? '';
  if (!symbol || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/.test(symbol)) return null;
  return { engine: symbol.includes('_') ? 'spot' : 'perps', symbol };
}
