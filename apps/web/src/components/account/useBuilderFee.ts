/**
 * The Valuescan builder fee an order placed NOW would carry, for the fee lines
 * in the ticket, the order review and the fee panel.
 *
 * It is the same decision the signed order makes (trading/builder.ts
 * `quoteBuilderFee` -> `orderBuilder`, at the fee trading/terms.ts `feeNow`
 * says the wallet owes), so the cost on screen is the cost SoDEX charges:
 * quoted when the account's approval covers the fee on that engine (or, in a
 * build that requires the fee, always). It follows the trading session and the
 * signed fee terms, so approving, revoking, a new volume tier or terms that run
 * out update every line at once.
 *
 * Null whenever no builder fee applies - and ALWAYS null in a build with no
 * builder configured, so callers render nothing and the UI is unchanged.
 */
import { useSyncExternalStore } from 'react';
import { quoteBuilderFee, type BuilderFeeQuote } from '../../trading/builder';
import { tradingConfig } from '../../trading/config';
import { getTradingState, subscribeTrading } from '../../trading/session';
import { feeNow, subscribeTerms, termsRevision, termsView } from '../../trading/terms';

export type { BuilderFeeQuote };

export function useBuilderFee(
  engine: 'spot' | 'perps',
  side: 'buy' | 'sell',
  /** The wallet on screen: another wallet's key (and approval) does not count. */
  address?: string | null,
): BuilderFeeQuote | null {
  const t = useSyncExternalStore(subscribeTrading, getTradingState, getTradingState);
  // The fee owed can change without the session changing: new terms, or terms that ran out.
  useSyncExternalStore(subscribeTerms, termsRevision, termsRevision);
  const builder = tradingConfig().builder;
  if (!builder) return null;
  const mine = t.status === 'enabled' && (!address || t.owner === address.toLowerCase());
  const wallet = address ?? t.owner;
  const view = termsView(wallet);
  return quoteBuilderFee({
    builder,
    approval: mine ? t.builder : null,
    engine,
    side,
    fee: feeNow(engine, wallet),
    next: view?.next ? { atUsd: view.next.atUsd, rate: view.next.fee[engine], volumeUsd: view.volumeUsd } : null,
  });
}
