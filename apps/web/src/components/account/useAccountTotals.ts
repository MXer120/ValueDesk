/**
 * The address menu's figures, in USD: the Perps account value, what the Spot
 * account holds, and what the EVM wallet holds (ValueChain plus USDC and gas on
 * the other EVM chains SoDEX routes through).
 *
 * Perps is the venue's own `av` - collateral plus unrealised PnL, verified
 * against live accounts (see Account.tsx). Spot and the wallet have no USD
 * figure of their own, so every coin is valued with trading/prices.ts, which
 * prices everything SoDEX lists (its own tokenPrice, then the perps collateral
 * price, then the spot market) - no "unpriced" remainder.
 *
 * The two states ride the shared account feeds (accountFeeds.ts) on the same
 * keys and interval as the account panel and the order ticket, so opening the
 * menu adds no requests when those are already polling. The wallet is the
 * store in trading/walletBalances.ts: already read by the navbar
 * (prefetchAccountTotals), chain by chain, refreshed in the background.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api } from '../../api';
import { useAccountResource } from '../../accountFeeds';
import { num, pick } from '../../format';
import { coinPrices, priceOf } from '../../trading/prices';
import { refreshWallet, subscribeWallet, valueHoldings, walletRead, type WalletHolding } from '../../trading/walletBalances';

export interface AccountTotals {
  /** null while unknown; 0 for an account that does not exist yet. */
  perpsUsd: number | null;
  spotUsd: number | null;
  /** null until something of the wallet has been read (and priced). */
  evmUsd: number | null;
  evm: WalletHolding[] | null;
  /** Chains of the wallet still being read (the figures so far are shown). */
  evmLoading: boolean;
}

/** Start the reads the menu shows (the navbar calls this once an address is known, and on hover). */
export function prefetchAccountTotals(address: string): void {
  refreshWallet(address);
  void coinPrices().catch(() => undefined);
}

export function useAccountTotals(address: string | null): AccountTotals {
  const perps = useAccountResource(address ? `state:perps:${address}` : null, () => api.state('perps', address!), 20_000);
  const spot = useAccountResource(address ? `state:spot:${address}` : null, () => api.state('spot', address!), 20_000);
  const [prices, setPrices] = useState<Map<string, number> | null>(null);

  useEffect(() => {
    let off = false;
    coinPrices()
      .then((m) => !off && setPrices(m))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, []);
  // Opening the menu refreshes a read older than its TTL (the old figures stay meanwhile).
  useEffect(() => {
    if (address) refreshWallet(address);
  }, [address]);
  const read = useSyncExternalStore(subscribeWallet, () => (address ? walletRead(address) : null));
  const evm = useMemo(() => (read && prices ? valueHoldings(read.rows, prices) : null), [read, prices]);

  const ps = perps.data?.state;
  const ss = spot.data?.state;
  const perpsUsd = ps ? num(pick(ps, 'av')) : perps.data ? 0 : null;

  let spotUsd: number | null = spot.data && !ss ? 0 : null;
  if (ss && prices) {
    spotUsd = 0;
    for (const b of Array.isArray(ss.B) ? ss.B : []) {
      const amount = num(pick(b, 't', 'total'));
      if (!amount) continue;
      spotUsd += amount * (priceOf(prices, String(pick(b, 'a', 'coin') ?? '')) ?? 0);
    }
  }
  const evmLoading = !read || read.pending > 0 || !prices;
  // Nothing yet while the first chains are still out; a running total after that.
  const evmUsd = evm && (evm.length > 0 || !evmLoading) ? evm.reduce((s, h) => s + h.usd, 0) : null;
  return { perpsUsd, spotUsd, evmUsd, evm: evm && (evm.length > 0 || !evmLoading) ? evm : null, evmLoading };
}
