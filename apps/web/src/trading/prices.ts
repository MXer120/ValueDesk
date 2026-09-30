/**
 * A USD price for every coin SoDEX holds, so no balance is ever "unpriced".
 *
 * Three public sources, most authoritative first:
 *   1. /asset/config `sodexMetadata.tokenPrice` - SoDEX's own price for every
 *      listed asset (vAAPL, aUNITREE, WSOSO, vsMAG7.ssi, ...);
 *   2. /perps/markets/coins `price` - the collateral price, which also covers
 *      coins without an asset config (vGRAM);
 *   3. the last price of the coin's USDC spot market.
 * vUSDC is 1. Stored under every spelling a coin goes by (engine name, asset
 * name, ValueChain symbol, and each without its v/a prefix), upper-cased, and
 * looked up with the same candidates the logos use (logoKey.ts).
 */
import { api } from '../api';
import { logoCandidates } from '../logoKey';
import { readGateway } from './gateway';

interface RawAsset {
  assetName?: string;
  valueChainMetadata?: { tokenSymbol?: string } | null;
  sodexMetadata?: { name?: string; tokenPrice?: string } | null;
}

const TTL_MS = 60_000;
let cache: { at: number; map: Promise<Map<string, number>> } | null = null;

/** Every coin's USD price, cached for a minute. */
export function coinPrices(): Promise<Map<string, number>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
  const map = buildPrices();
  cache = { at: Date.now(), map };
  map.catch(() => {
    if (cache?.map === map) cache = null; // a failed read is retried next time, not cached
  });
  return map;
}

const unprefixed = (name: string): string => name.replace(/^vs(?=[A-Z0-9])/, 's').replace(/^[va](?=[A-Z0-9])/, '');

export async function buildPrices(): Promise<Map<string, number>> {
  const [config, perps, spot] = await Promise.allSettled([
    readGateway<RawAsset[]>('/api/v1/asset/config'),
    readGateway<Array<{ name?: string; price?: string }>>('/api/v1/perps/markets/coins'),
    Promise.all([api.symbols('spot'), api.tickers('spot')]),
  ]);
  const out = new Map<string, number>();
  const put = (name: string | undefined | null, value: unknown) => {
    if (!name) return;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return;
    for (const k of [name, unprefixed(name)]) {
      const key = k.toUpperCase();
      if (!out.has(key)) out.set(key, n);
    }
  };
  put('vUSDC', 1);
  if (config.status === 'fulfilled') {
    for (const r of config.value ?? []) {
      const px = r.sodexMetadata?.tokenPrice;
      put(r.sodexMetadata?.name, px);
      put(r.valueChainMetadata?.tokenSymbol, px);
      put(r.assetName, px);
    }
  }
  if (perps.status === 'fulfilled') for (const c of perps.value ?? []) put(c.name, c.price);
  if (spot.status === 'fulfilled') {
    const [sy, tk] = spot.value;
    const last = new Map(tk.tickers.map((t) => [t.symbol, t.lastPx]));
    for (const s of sy.symbols) if (s.quoteCoin === 'vUSDC') put(s.baseCoin, last.get(s.name));
  }
  if (config.status === 'rejected' && perps.status === 'rejected' && spot.status === 'rejected') {
    throw new Error('No price source answered.');
  }
  return out;
}

/** The USD price of `coin` in any SoDEX spelling (vBTC, BTC, aUNITREE, vsMAG7.ssi...), or undefined. */
export function priceOf(prices: Map<string, number>, coin: string | null | undefined): number | undefined {
  const tries = [coin];
  // xStocks (CRCLx, AAPLx, TSLAx) are 1:1 tokenised shares: priced as the share
  // when SoDEX gives the token no price of its own.
  if (coin && /[A-Z]x$/.test(coin)) tries.push(coin.slice(0, -1));
  for (const t of tries) {
    for (const k of logoCandidates(t)) {
      const p = prices.get(k);
      if (p !== undefined) return p;
    }
  }
  return undefined;
}
