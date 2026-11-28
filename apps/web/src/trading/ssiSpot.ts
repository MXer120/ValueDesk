/**
 * SoSoValue's SSI index tokens that SoDEX trades on its spot order book (owner 2026-11-28: "add the ssi tokens, but
 * fixed only. Nothing were we need to rebalance ourselves"): MAG7.ssi, DEFI.ssi, MEME.ssi and USSI. Each is one token
 * whose own basket the SSI protocol manages; an index here holds the token at its fixed weight, like any other leg, and
 * nothing is rebalanced by ValueDesk. They are not SoDEX Wealth funds, so they are added as funds of their own kind:
 *
 *   bought   a spot market buy from Spot, like a US ETF (spotOnly: always the order book, no Wealth trading status)
 *   price    SoDEX's spot ticker (last price, 24 h change)
 *   history  SoDEX's daily spot candles, up to 1000 days (/spot/markets/<symbol>/klines)
 *   schedule never: SoDEX's recurring-buy contract does not list them
 *
 * Markets checked against /api/v1/spot/markets/symbols on 2026-11-28 (each TRADING, $5 minimum).
 */
import { readGateway } from './gateway';
import type { WealthFund, WealthQuote } from './wealth';

export interface SsiSpot { fundId: string; symbol: string; name: string; coin: string; marketId: number }

export const SSI_SPOT: readonly SsiSpot[] = [
  { fundId: 'vMAG7ssi', symbol: 'vMAG7ssi_vUSDC', name: 'MAG7.ssi', coin: 'MAG7.ssi', marketId: 3 },
  { fundId: 'vDEFIssi', symbol: 'vDEFIssi_vUSDC', name: 'DEFI.ssi', coin: 'DEFI.ssi', marketId: 24 },
  { fundId: 'vMEMEssi', symbol: 'vMEMEssi_vUSDC', name: 'MEME.ssi', coin: 'MEME.ssi', marketId: 25 },
  { fundId: 'vUSSI', symbol: 'vUSSI_vUSDC', name: 'USSI', coin: 'USSI', marketId: 26 },
];

export const ssiSpotOf = (fundId: string): SsiSpot | null => SSI_SPOT.find((s) => s.fundId === fundId) ?? null;

/** The tokens as funds the index code takes (a clob fund that is always on the order book). */
export const SSI_FUNDS: readonly WealthFund[] = SSI_SPOT.map((s) => ({
  fundId: s.fundId,
  name: s.name,
  fundType: 'clob' as const,
  fundStatus: 'live' as const,
  spotOnly: true,
  share: { coin: s.coin, address: '', decimals: 8 },
  spot: { symbol: s.symbol, symbolId: s.marketId, displayName: `${s.name}/USDC`, quote: { coin: 'vUSDC', decimals: 6 } },
}));

/** Their prices from SoDEX's spot tickers, as quotes; read at most once a minute. */
let quoteCache: { at: number; p: Promise<WealthQuote[]> } | null = null;
export function readSsiQuotes(): Promise<WealthQuote[]> {
  if (quoteCache && Date.now() - quoteCache.at < 60_000) return quoteCache.p;
  const p = readGateway<Array<{ symbol: string; lastPx?: string; changePct?: number }>>('/api/v1/spot/markets/tickers').then((rows) =>
    SSI_SPOT.flatMap((s) => {
      const t = (rows ?? []).find((r) => r.symbol === s.symbol);
      return t ? [{ fundId: s.fundId, symbol: s.coin, price: t.lastPx, roi24h: t.changePct !== undefined ? String(t.changePct) : undefined, asOf: new Date().toISOString() }] : [];
    }));
  quoteCache = { at: Date.now(), p };
  p.catch(() => { quoteCache = null; });
  return p;
}

/** Daily closes from SoDEX's spot candles, oldest first. */
export async function readSsiCloses(fundId: string): Promise<Array<{ t: number; v: number }>> {
  const s = ssiSpotOf(fundId);
  if (!s) return [];
  const rows = await readGateway<Array<{ t: number; c: string }>>(`/api/v1/spot/markets/${encodeURIComponent(s.symbol)}/klines?interval=1d&limit=1000`);
  return (rows ?? []).map((k) => ({ t: k.t, v: Number(k.c) })).filter((p) => Number.isFinite(p.t) && p.v > 0).sort((a, b) => a.t - b.t);
}
