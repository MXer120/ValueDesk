/**
 * Instant exit for the batch vaults (owner 2026-11-28: "the instant exit thing, where it gets hedged"). A redemption
 * requested outside China's session is priced at the next Shanghai open (01:30 UTC, the `pricedAt` of every batch row
 * in SoDEX's public ledgers, 26 Oct - 27 Nov 2026), so the price can still move after the click. The hedge:
 *
 *   1. the batch redemption request, from the wallet (trading/wealth.ts requestVault)
 *   2. a market sell of the vault's perp (UNITREE-USD, CXMT-USD) of the same size, from Futures
 *   3. a reduce-only close of that short on ValueDesk's executor, timed to the pricing moment (a TWAP with closeShare 1)
 *
 * During the session SoDEX's maker quotes lock the price at the click, so no hedge is needed (the RFQ route).
 * What it does, measured by ValueDesk on 13 UNITREE batches (26 Oct - 27 Nov 2026): the move between the last request
 * and the batch price was 1.79% RMS; with a perfect perp hedge what was left was 1.51% RMS (the perp at 01:30 is not
 * the batch price); the hedge cost 0.29% ($1k) to 0.49% ($10k) in fees and book impact. The sheet says so.
 */
import type { TradingStatus } from './wealth';

/** The perp that hedges a vault, by fund. */
export const HEDGE_MARKET: Readonly<Record<string, string>> = { UNITREE: 'UNITREE-USD', CXMT: 'CXMT-USD' };

/** When a batch request is priced: an hour after the cutoff (cutoff 00:30 UTC, priced 01:30 UTC), in ms; null without a batch. */
export function pricingAt(s: TradingStatus | null): number | null {
  if (!s || s.channel !== 'batch' || !s.batch?.cutoffAt) return null;
  return (s.batch.cutoffAt + 3600) * 1000;
}

/** What ValueDesk measured; shown beside the switch, word for word the same numbers as above. */
export const HEDGE_MEASURED = {
  batches: 13,
  from: '26 Oct',
  to: '27 Nov 2026',
  unhedgedRmsPct: 1.79,
  hedgedRmsPct: 1.51,
  costLowPct: 0.29,
  costHighPct: 0.49,
} as const;

/** The executor's close: buy back the whole short, reduce-only, over a minute from 30 s before the pricing moment. */
export function hedgeCloseSpec(market: string, pricedMs: number) {
  return {
    kind: 'twap',
    symbol: market,
    side: 'buy',
    closeShare: 1,
    durationMs: 60_000,
    slices: 3,
    startAt: pricedMs - 30_000,
    label: 'Instant exit: hedge close',
  } as const;
}

/** The short's size in the perp's units: one share is one unit of the underlying (NAV tracks the stock, measured). */
export const hedgeQuantity = (shares: number): string => (shares > 0 ? String(Math.floor(shares * 100) / 100) : '0');
