/**
 * Everything the portfolio versions read, gathered once per page (localhost only, versions/DevVersions.tsx).
 *
 * The SAME reads as today's page (PortfolioPage.tsx): the four buckets from summary.ts, SoDEX's account-value series
 * and its 24-hour window, the leaderboard's 7-day volume, the fee rates, the Wealth reads. On top, only figures the app
 * already reads elsewhere and that come from a named source:
 *   - the Perps account's margin and positions (Portfolio.tsx's model: SoDEX's account state, verbatim),
 *   - the Spot balances by coin (the shared state feed the Balances table reads, valued by the app's prices),
 *   - the wallet's standing on SoDEX's own leaderboard (30-day and all-time PnL, volume and rank; the Leaderboard page
 *     reads the same routes).
 * Nothing here is estimated or invented: a figure that is not read is null, and the page shows a dash.
 */
import { useEffect, useMemo, useState } from 'react';
import { pnlAt, sliceCurve, useVolume7d, type PortfolioContext } from '../../Portfolio';
import type { CurveWindow } from '../parts';
import { asRate, use24h, useSummary } from '../PortfolioPage';
import { useWealth, type WealthState } from '../useWealth';
import { summarize, type PortfolioSummary } from '../summary';
import { api } from '../../../api';
import { useAccountResource } from '../../../accountFeeds';
import { useAsync } from '../../../hooks';
import { num, pick } from '../../../format';
import type { VenueFeeRate } from '../../../fees';
import type { ChartPoint } from '../../../performance';
import { coinPrices, priceOf } from '../../../trading/prices';
import { leaderboardPage, walletRank } from '../../../exchange/sodexData';
import { useBotsAccess } from '../../../beta/access';
import { logLoadFailure } from '../../LoadFailed';

export type Bucket = 'perps' | 'spot' | 'wealth' | 'evm';

/** The four places money is, in this order everywhere. Colours checked as a set (dataviz validator, both themes). */
export const BUCKETS: ReadonlyArray<{ key: Bucket; label: string; line: string }> = [
  { key: 'perps', label: 'Perps', line: 'Margin and open positions' },
  { key: 'spot', label: 'Spot', line: 'Coins on SoDEX' },
  { key: 'wealth', label: 'Wealth', line: 'Funds and vaults' },
  { key: 'evm', label: 'EVM', line: 'Your wallet, on chain' },
];

export interface Part { key: Bucket; label: string; line: string; usd: number | null; share: number | null }

export interface Standing {
  /** SoDEX's leaderboard row for the window; null when the wallet is not ranked in it. */
  rank: number | null;
  pnl: number | null;
  volume: number | null;
}

export interface SpotCoin { coin: string; amount: number; usd: number | null }

export interface PfData {
  c: PortfolioContext;
  w: WealthState;
  s: PortfolioSummary;
  parts: Part[];
  evmRows: Array<{ chain: string; chainLabel: string; symbol: string; usd: number }>;
  evmLoading: boolean;
  spotCoins: SpotCoin[] | null;
  vol7d: number | null;
  h24: ChartPoint[] | null;
  /** SoDEX's 24-hour PnL (its own 24H series, first to last point). */
  today: number | null;
  /** PnL over the last 7 days, from SoDEX's daily series. */
  week: CurveWindow | null;
  /** Account value over the last 7 days, for a sparkline. */
  weekValues: number[] | null;
  fees: { perps: VenueFeeRate | null; spot: VenueFeeRate | null };
  month: Standing | null;
  ever: Standing | null;
  /** How many wallets SoDEX's leaderboard ranks over 30 days. */
  ranked: number | null;
  botsOpen: boolean;
}

function useStanding(address: string | null, window: '30D' | 'ALL_TIME'): Standing | null {
  const [s, setS] = useState<Standing | null>(null);
  useEffect(() => {
    setS(null);
    if (!address) return;
    let off = false;
    walletRank(window, 'pnl', address)
      .then((j: { found?: boolean; item?: { rank?: number; pnl_usd?: string; volume_usd?: string } }) => {
        if (off) return;
        setS(j.found && j.item ? { rank: Number(j.item.rank) || null, pnl: num(j.item.pnl_usd), volume: num(j.item.volume_usd) } : { rank: null, pnl: null, volume: null });
      })
      .catch((e) => logLoadFailure(`${window} standing`, e));
    return () => { off = true; };
  }, [address, window]);
  return s;
}

function useRankedCount(enabled: boolean): number | null {
  const r = useAsync(
    () => leaderboardPage<{ total?: number }>({ window_type: '30D', sort_by: 'pnl', sort_order: 'desc', page: 1, page_size: 20 }),
    [],
    { enabled },
  );
  const t = Number(r.data?.total);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** Nothing known: what the page shows with no wallet. */
const NONE = summarize({ perps: null, spot: null, evm: null, wealth: null, venueTotal: null });

export function usePfData(c: PortfolioContext): PfData {
  const w = useWealth(c.address, c.refreshToken);
  const { summary, evmRows, evmLoading } = useSummary(c, w);
  // The shared account feed keeps its last read when the address goes away (a wallet disconnected, or the switch's
  // view of another wallet ended): with no wallet nothing is known, whatever the feed still holds.
  const s = c.address ? summary : NONE;
  const vol7d = useVolume7d(c.address);
  const h24 = use24h(c);
  const botsOpen = useBotsAccess(c.address);
  const month = useStanding(c.address, '30D');
  const ever = useStanding(c.address, 'ALL_TIME');
  const ranked = useRankedCount(!!c.address);
  const perpsFee = useAsync(() => api.feeRate('perps', c.address!), [c.address], { enabled: !!c.address });
  const spotFee = useAsync(() => api.feeRate('spot', c.address!), [c.address], { enabled: !!c.address });

  // The shared state feed and price map useSummary already reads: no extra request.
  const px = useAsync(() => coinPrices(), [], { pollMs: 60_000 });
  const spotState = useAccountResource(c.address ? `state:spot:${c.address}` : null, () => api.state('spot', c.address!), 20_000);
  const spotCoins = useMemo((): SpotCoin[] | null => {
    if (!c.address || !spotState.data || !px.data) return null;
    return ((spotState.data.state?.B ?? []) as unknown[])
      .map((b) => {
        const coin = String(pick(b, 'a', 'coin') ?? '');
        const amount = num(pick(b, 't', 'total'));
        const p = priceOf(px.data!, coin);
        return { coin, amount, usd: p === undefined ? null : amount * p };
      })
      .filter((x) => x.amount > 0 && (x.usd === null || x.usd >= 0.01))
      .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  }, [c.address, spotState.data, px.data]);

  const today = useMemo(() => (h24 && h24.length >= 2 ? pnlAt('pnl-total', h24[h24.length - 1]!) - pnlAt('pnl-total', h24[0]!) : null), [h24]);
  const week = useMemo(() => (c.venue.points ? sliceCurve(c.venue.points, '7D', (p) => pnlAt('pnl-total', p)) : null), [c.venue.points]);
  const weekValues = useMemo(() => {
    const v = c.venue.points ? sliceCurve(c.venue.points, '7D', (p) => p.accountValue) : null;
    return v ? v.points.map((p) => p.v + v.baseline) : null;
  }, [c.venue.points]);

  const parts = useMemo((): Part[] => {
    const by: Record<Bucket, number | null> = { perps: s.perps, spot: s.spot, wealth: s.wealth, evm: s.evm };
    const total = s.total !== null && s.total > 0 ? s.total : null;
    return BUCKETS.map((b) => {
      const usd = by[b.key];
      return { ...b, usd, share: total === null || usd === null ? null : Math.max(0, usd) / total };
    });
  }, [s]);

  return {
    c, w, s, parts, evmRows, evmLoading, spotCoins, vol7d, h24, today, week, weekValues,
    fees: { perps: asRate(perpsFee.data), spot: asRate(spotFee.data) },
    month, ever, ranked, botsOpen,
  };
}
