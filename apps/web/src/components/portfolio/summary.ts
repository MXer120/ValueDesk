/**
 * Where the money is: the portfolio's four buckets, every dollar in exactly one.
 *
 * THE RULE THE PAGE IS BUILT ON. Total Value = Perps + Spot + Wealth + EVM.
 *
 *   Perps    SoDEX's own account value (`av`), verbatim, so it equals the trade page.
 *   Spot     the Spot balances, minus coins that are shares of a Wealth fund.
 *   Wealth   the funds' market value and what is in flight, wherever the shares sit,
 *            minus shares pledged as Perps margin (`av` already holds those), plus SLP.
 *   EVM      the wallet, minus Wealth shares on ValueChain.
 *
 * WHY THIS MATTERS. One holding can show up in three reads. vQQQ is a Spot balance AND a
 * row in SoDEX's /wealth/users/{a}/pnl. aCXMT is an ERC-20 in the wallet read AND a row in
 * /pnl. soUSDC can be pledged as margin, so it is in `av` AND in /pnl. Adding the reads
 * would count them twice. So a Wealth fund claims its share coin out of Spot and EVM, and
 * gives back the part in Perps.
 *
 * A fund SoDEX could not price claims nothing. Its coin stays where the balance read
 * valued it, because removing it from Spot with no Wealth value to replace it would make
 * the money vanish. Same when the whole Wealth read failed: Spot and EVM stay as read.
 *
 * COPY TRADING AND BOTS ARE NOT BUCKETS, AND THIS FILE TAKES NO INPUT FOR THEM. Copies and
 * bots trade from the wallet's own Perps and Spot accounts. A copy's allocation is a size
 * limit, not money moved anywhere, and its positions are already in `av`. A bot's quotes
 * lock funds that are already in the balances. So the page shows them as views of activity,
 * never as balances, and there is no way to add them to the total here.
 */

/** One Wealth fund as the holdings reads report it. Amounts are numbers, USD or shares. */
export interface WealthRow {
  fundId: string;
  /** Share coin, as SoDEX spells it (vQQQ, aCXMT, vsoUSDC). */
  coin: string;
  /** Settled market value. null when SoDEX has no price for the fund. */
  marketValue: number | null;
  /** Value paid and not yet received. Never part of marketValue (SoDEX keeps them apart). */
  inFlight: number;
  shares: number;
  spotShares: number;
  perpShares: number;
  evmShares: number;
}

export interface SummaryInput {
  /** SoDEX's `av`. null while unknown. */
  perps: number | null;
  /** Spot balances valued by the app's prices. null while unknown. */
  spot: ReadonlyArray<{ coin: string; usd: number | null }> | null;
  /** The wallet's holdings, valued. null while unknown. */
  evm: ReadonlyArray<{ chain: string; symbol: string; usd: number }> | null;
  /** The Wealth holdings. null while unknown or when the read failed. */
  wealth: readonly WealthRow[] | null;
  /** The last point of SoDEX's own account-value series, for the SLP inference. */
  venueTotal: number | null;
}

export interface PortfolioSummary {
  /** null until at least one bucket is known. */
  total: number | null;
  perps: number | null;
  spot: number | null;
  wealth: number | null;
  evm: number | null;
  /** The part of `wealth` that is SLP, inferred. null when there is none. */
  slp: number | null;
  /** Share value left in Perps because `av` already counts it. Informational. */
  wealthInPerps: number;
  /** Funds SoDEX could not price. Their coins stay valued where the balance reads saw them. */
  unpriced: number;
}

/** vQQQ and QQQ, vsoUSDC and soUSDC: the same coin. Only a lower-case `v` is a prefix (VANA is not vANA). */
export const shareKey = (coin: string): string => coin.replace(/^v(?=[A-Za-z])/, '').toUpperCase();

const add = (a: number, b: number): number => a + b;
const usable = (v: number): number => (Number.isFinite(v) ? v : 0);

/** Below this, the gap to SoDEX's series is lag and rounding, not a vault position. */
function slpFloor(venueTotal: number): number {
  return Math.max(1, Math.abs(venueTotal) * 0.005);
}

export function summarize(input: SummaryInput): PortfolioSummary {
  const rows = input.wealth ?? [];
  const priced = rows.filter((r) => r.marketValue !== null);
  const claimed = new Set(priced.map((r) => shareKey(r.coin)));

  const inPerps = priced.reduce((sum, r) => {
    if (!(r.shares > 0) || !(r.perpShares > 0)) return sum;
    return sum + r.marketValue! * Math.min(1, r.perpShares / r.shares);
  }, 0);
  const inSpot = priced.reduce((sum, r) => {
    if (!(r.shares > 0) || !(r.spotShares > 0)) return sum;
    return sum + r.marketValue! * Math.min(1, r.spotShares / r.shares);
  }, 0);
  const marketValue = priced.reduce((sum, r) => sum + usable(r.marketValue!), 0);
  const inFlight = rows.reduce((sum, r) => sum + usable(r.inFlight), 0);

  const rawSpot = input.spot === null ? null : input.spot.reduce((sum, b) => sum + (b.usd ?? 0), 0);
  const spot = input.spot === null
    ? null
    : input.spot.filter((b) => !claimed.has(shareKey(b.coin))).map((b) => b.usd ?? 0).reduce(add, 0);
  const evm = input.evm === null
    ? null
    : input.evm
        // A token called vQQQ on another chain is not the fund's share: only ValueChain is claimed.
        .filter((h) => !(h.chain === 'VALUECHAIN' && claimed.has(shareKey(h.symbol))))
        .map((h) => h.usd)
        .reduce(add, 0);

  /*
   * SLP. Depositing MAG7.ssi or sMAG7.ssi into the liquidity vault takes the coins out of
   * the account, and no route reports the position, but SoDEX's account-value series still
   * counts it. So: series total minus what the series is known to hold.
   */
  let slp: number | null = null;
  if (input.venueTotal !== null && rawSpot !== null && input.perps !== null) {
    const outside = marketValue - inSpot - inPerps + inFlight;
    const gap = input.venueTotal - rawSpot - input.perps - outside;
    if (gap > slpFloor(input.venueTotal)) slp = gap;
  }

  const wealth = input.wealth === null && slp === null
    ? null
    : Math.max(0, marketValue - inPerps) + inFlight + (slp ?? 0);

  const parts = [input.perps, spot, wealth, evm];
  return {
    total: parts.every((p) => p === null) ? null : parts.reduce<number>((sum, p) => sum + (p ?? 0), 0),
    perps: input.perps,
    spot,
    wealth,
    evm,
    slp,
    wealthInPerps: inPerps,
    unpriced: rows.length - priced.length,
  };
}

/** The share coins the Wealth figure already counts: Spot and EVM tables mark these. */
export function claimedCoins(wealth: readonly WealthRow[] | null): ReadonlySet<string> {
  return new Set((wealth ?? []).filter((r) => r.marketValue !== null).map((r) => shareKey(r.coin)));
}

// --- the activity panel: what an account's fills and funding add up to in a window --------

export interface FillRow { time: number; side: 'buy' | 'sell' | null; notional: number; fee: number; feeCoin: string | null }
export interface FundingRow { time: number; fee: number; coin: string | null }

export interface ActivitySummary {
  trades: number;
  buys: number;
  sells: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  /** Fees in USDC only. Fees in other coins are counted in `otherFeeCoins`, not converted. */
  commission: number;
  latestCommission: number | null;
  otherFeeCoins: number;
  /** null on an engine with no funding (Spot). Positive = received. */
  funding: number | null;
  latestFunding: number | null;
  /** False when the page of rows ran out before the window did: the figures are a floor. */
  complete: boolean;
}

const usdcFee = (coin: string | null): boolean => coin === null || shareKey(coin) === 'USDC';

/**
 * Add up one fetched page of fills and funding inside a window. `pageLimit` is the row
 * count the read asked for: a full page whose oldest row is inside the window says more
 * rows exist, so the sum is a floor and the UI must say so.
 */
export function summarizeActivity(
  fills: readonly FillRow[],
  funding: readonly FundingRow[] | null,
  since: number,
  pageLimit: number,
): ActivitySummary {
  const inside = fills.filter((f) => f.time >= since);
  const paid = funding === null ? null : funding.filter((f) => f.time >= since);
  const buys = inside.filter((f) => f.side === 'buy');
  const sells = inside.filter((f) => f.side === 'sell');
  const newest = <T extends { time: number }>(list: readonly T[]): T | null =>
    list.reduce<T | null>((best, x) => (best === null || x.time > best.time ? x : best), null);
  const usdFees = inside.filter((f) => usdcFee(f.feeCoin));
  const lastFee = newest(usdFees);
  const lastPaid = paid === null ? null : newest(paid);
  const ranOut = (rows: ReadonlyArray<{ time: number }>): boolean =>
    rows.length >= pageLimit && rows.every((r) => r.time >= since);
  return {
    trades: inside.length,
    buys: buys.length,
    sells: sells.length,
    volume: inside.reduce((s, f) => s + f.notional, 0),
    buyVolume: buys.reduce((s, f) => s + f.notional, 0),
    sellVolume: sells.reduce((s, f) => s + f.notional, 0),
    commission: usdFees.reduce((s, f) => s + f.fee, 0),
    latestCommission: lastFee ? lastFee.fee : null,
    otherFeeCoins: inside.length - usdFees.length,
    funding: paid === null ? null : paid.filter((f) => usdcFee(f.coin)).reduce((s, f) => s + f.fee, 0),
    latestFunding: lastPaid ? lastPaid.fee : null,
    complete: !ranOut(fills) && !(funding !== null && ranOut(funding)),
  };
}
