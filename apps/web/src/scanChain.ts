/**
 * What ValueChain itself says about an address.
 *
 * The SoDEX gateway knows about your EXCHANGE balances - spot, perps, margin.
 * It knows nothing about tokens sitting in your wallet on-chain. For a scan
 * page that claims to show everything public, that is half the picture missing.
 *
 * ValueChain runs an open Blockscout instance which enumerates an address's
 * ERC-20 holdings in ONE call, unpaginated and without a key. That removes the
 * approach this codebase previously assumed was necessary - probing a list of
 * known token contracts one at a time - and it is why there is no token list
 * here to maintain.
 *
 * THE EXPLORER PRICES NOTHING. Every token it returns carries
 * `exchange_rate: null` - all 50 ERC-20s on the chain, not just the obscure
 * ones - so reading a dollar value out of it was always going to produce an
 * em-dash. Prices come from the VENUE instead: each on-chain coin has a
 * `<coin>_vUSDC` spot market, and its last trade is the price. 42 of the 50
 * tokens on the chain have such a market; the rest are counted and named as
 * unpriced rather than being silently valued at zero, which would understate a
 * wallet and look like a working total.
 */

const EXPLORER = 'https://main-scan.valuechain.xyz';

export interface ChainToken {
  symbol: string;
  name: string;
  contract: string;
  decimals: number;
  /** Human amount, already scaled by decimals. */
  amount: number;
  /** Explorer's fiat valuation, when it has one. */
  usd: number | null;
}

interface RawBalance {
  value?: string;
  token?: {
    address?: string;
    address_hash?: string;
    symbol?: string;
    name?: string;
    decimals?: string;
    exchange_rate?: string | null;
  };
}

/**
 * Every ERC-20 the explorer knows this address holds.
 *
 * Blockscout answers with a BARE ARRAY here, not the `{items, next_page_params}`
 * envelope its other endpoints use, so there is nothing to paginate - but the
 * parser tolerates both shapes rather than assuming, because that is an
 * undocumented API on someone else's service.
 */
export async function fetchChainTokens(address: string): Promise<ChainToken[]> {
  const r = await fetch(`${EXPLORER}/api/v2/addresses/${address}/token-balances`, {
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`explorer ${r.status}`);
  const j: unknown = await r.json();
  const rows: RawBalance[] = Array.isArray(j)
    ? (j as RawBalance[])
    : (((j as { items?: RawBalance[] })?.items) ?? []);

  return rows
    .map((b): ChainToken | null => {
      const t = b.token ?? {};
      const decimals = Number(t.decimals ?? 18);
      const raw = b.value ?? '0';
      if (!Number.isFinite(decimals)) return null;
      /* Token amounts are integer strings in base units and routinely exceed
         Number.MAX_SAFE_INTEGER, so the scaling is done on BigInt and only the
         final, small quotient becomes a float. */
      let amount = 0;
      try {
        const scale = 10n ** BigInt(Math.max(0, Math.min(36, decimals)));
        const v = BigInt(raw);
        const whole = v / scale;
        const frac = v % scale;
        amount = Number(whole) + Number(frac) / Number(scale);
      } catch {
        amount = Number(raw) / 10 ** decimals;
      }
      if (!Number.isFinite(amount) || amount === 0) return null;
      const rate = Number(t.exchange_rate ?? NaN);
      return {
        symbol: t.symbol ?? '?',
        name: t.name ?? '',
        contract: (t.address ?? t.address_hash ?? '').toLowerCase(),
        decimals,
        amount,
        usd: Number.isFinite(rate) ? amount * rate : null,
      };
    })
    .filter((x): x is ChainToken => x !== null)
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || b.amount - a.amount);
}

export interface ChainNative {
  balance: number;
  txCount: number | null;
  transferCount: number | null;
}

/**
 * The native coin balance, and how busy the address has been.
 *
 * TWO CALLS, because Blockscout splits them: `/addresses/{a}` carries the
 * balance but NO transaction count (its keys are all `has_*` flags), and the
 * counts live on `/addresses/{a}/counters`. Reading only the first is what left
 * the Transactions row showing an em-dash on an address with four of them.
 */
export async function fetchChainNative(address: string): Promise<ChainNative | null> {
  const base = `${EXPLORER}/api/v2/addresses/${address}`;
  const [addrRes, cntRes] = await Promise.allSettled([
    fetch(base, { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)),
    fetch(`${base}/counters`, { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null)),
  ]);

  const a = addrRes.status === 'fulfilled' ? (addrRes.value as { coin_balance?: string } | null) : null;
  const c = cntRes.status === 'fulfilled'
    ? (cntRes.value as { transactions_count?: string; token_transfers_count?: string } | null)
    : null;
  if (!a && !c) return null;

  /* Wei is an integer string well past Number.MAX_SAFE_INTEGER, so the division
     happens on BigInt and only the small quotient becomes a float. Six decimals
     rather than three: a balance of 0.000999 is not "0.000". */
  let balance = 0;
  try {
    balance = Number(BigInt(a?.coin_balance ?? '0') / 10n ** 12n) / 1e6;
  } catch {
    balance = Number(a?.coin_balance ?? 0) / 1e18;
  }

  const n = (v: unknown): number | null => {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  return {
    balance,
    txCount: n(c?.transactions_count),
    transferCount: n(c?.token_transfers_count),
  };
}

/* ---------------------------------------------------------------------------
 * PRICING, from the venue rather than the explorer.
 * ------------------------------------------------------------------------ */

/**
 * A coin -> USD price map, built from the venue's own spot markets.
 *
 * Only `*_vUSDC` markets are used. A cross pair would need a second hop through
 * another price to reach dollars, and every coin that has a market at all has a
 * vUSDC one - so the hop would add a rounding step and a failure mode to buy
 * nothing.
 *
 * `vUSDC` is pinned to 1 rather than looked up: it is the quote unit, so there
 * is no `vUSDC_vUSDC` market to read it from.
 */
export async function fetchCoinPrices(
  symbols: Array<{ name: string; baseCoin: string; quoteCoin: string }>,
  tickers: Array<{ symbol: string; lastPx: string }>,
): Promise<Map<string, number>> {
  const last = new Map(tickers.map((t) => [t.symbol, Number(t.lastPx)]));
  const out = new Map<string, number>();
  for (const s of symbols) {
    if (s.quoteCoin !== 'vUSDC') continue;
    const p = last.get(s.name);
    if (p !== undefined && Number.isFinite(p) && p > 0) out.set(s.baseCoin, p);
  }
  out.set('vUSDC', 1);
  return out;
}

/**
 * Apply a price map to a token list.
 *
 * Returns a NEW list rather than mutating, and leaves `usd` null where there is
 * no price - the caller distinguishes "worth nothing" from "not priced", and
 * those are very different sentences to put in front of someone.
 */
export function priceTokens(tokens: ChainToken[], prices: Map<string, number>): ChainToken[] {
  return tokens.map((t) => {
    const p = prices.get(t.symbol);
    return p === undefined ? t : { ...t, usd: t.amount * p };
  }).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || b.amount - a.amount);
}
