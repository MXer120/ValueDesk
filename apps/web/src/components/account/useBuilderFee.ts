/**
 * The Valuescan builder fee an order placed NOW would carry, for the fee lines
 * in the ticket, the order review and the fee panel.
 *
 * It is the same decision the signed order makes (trading/builder.ts
 * `quoteBuilderFee` -> `orderBuilder`), so the cost on screen is the cost SoDEX
 * charges: quoted when the account's approval covers the fee on that engine
 * (or, in a build that requires the fee, always). It follows the trading
 * session, so approving, revoking or a re-read updates every line at once.
 *
 * Null whenever no builder fee applies - and ALWAYS null in a build with no
 * builder configured, so callers render nothing and the UI is unchanged.
 */
import { useSyncExternalStore } from 'react';
import { quoteBuilderFee, type BuilderFeeQuote } from '../../trading/builder';
import { tradingConfig } from '../../trading/config';
import { getTradingState, subscribeTrading } from '../../trading/session';

export type { BuilderFeeQuote };

export function useBuilderFee(
  engine: 'spot' | 'perps',
  side: 'buy' | 'sell',
  /** The wallet on screen: another wallet's key (and approval) does not count. */
  address?: string | null,
): BuilderFeeQuote | null {
  const t = useSyncExternalStore(subscribeTrading, getTradingState, getTradingState);
  const builder = tradingConfig().builder;
  if (!builder) return null;
  const mine = t.status === 'enabled' && (!address || t.owner === address.toLowerCase());
  return quoteBuilderFee({ builder, approval: mine ? t.builder : null, engine, side });
}
