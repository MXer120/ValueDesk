/**
 * The two engines' market lists for the Futures / Spot choice (bots/engines.ts), and what a spot bot pays its buys
 * with: the account's spot USDC.
 */
import { useMemo } from 'react';
import { api } from '../api';
import { useAccountResource } from '../accountFeeds';
import { useSymbols } from '../hooks';
import { isBotSpot, twinOf, type BotEngine } from './engines';

/** Every market name a bot may use, per engine (spot: the USDC-quoted ones that trade). */
export function useBotSymbolNames(): Record<BotEngine, string[]> {
  const perps = useSymbols('perps').symbols;
  const spot = useSymbols('spot').symbols;
  return useMemo(() => ({
    perps: perps.map((s) => s.name),
    spot: spot.filter((s) => isBotSpot(s.name) && (s.status === undefined || s.status === 'TRADING')).map((s) => s.name),
  }), [perps, spot]);
}

/** This market's coin on each engine (null: SoDEX does not list it there). */
export function useTwins(symbol: string): Record<BotEngine, string | null> {
  const names = useBotSymbolNames();
  return useMemo(() => ({ perps: twinOf(symbol, 'perps', names.perps), spot: twinOf(symbol, 'spot', names.spot) }), [symbol, names]);
}

/**
 * The account's spot USDC: what a spot bot's buys are paid from. `free` is what is not tied up in resting orders
 * (SoDEX's own locked amount). null while it is not read (or no wallet).
 */
export function useSpotCash(address: string | null): { total: number; free: number } | null {
  const acct = useAccountResource(address ? `state:spot:${address}` : null, () => api.state('spot', address!), 20_000);
  const st = (acct.data as { state?: { B?: Array<{ a?: string; t?: string; l?: string }> } } | null)?.state;
  return useMemo(() => {
    if (!st) return null;
    const row = (st.B ?? []).find((b) => b.a === 'vUSDC');
    const total = Number(row?.t ?? 0) || 0;
    const locked = Number(row?.l ?? 0) || 0;
    return { total, free: Math.max(0, total - locked) };
  }, [st]);
}
