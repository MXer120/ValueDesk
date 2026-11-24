/**
 * What every version of the landing page shares (owner 2026-11-23: four versions, each a different page): the facts it
 * may state, the live reads, the swimming whale and the version switcher.
 *
 * THE FACTS. Every figure is live or a constant the executor charges; nothing is rounded in our favour:
 *   - fees: @copy-engine BOT_FEE_LADDER / BOT_FEE_VIP / COPY_FEE_LADDER. The LOWEST fee may be advertised only WITH its
 *     condition ("from 0.1 bp" + "VIP, $1M 14-day volume"); the fee a new wallet pays is the ladder's first step.
 *   - startFrom: the smallest margin a real market maker needs today, computed with the New bot page's own code
 *     (presets.ts planMarkets): the balanced draft at SoDEX's minimum order, max holding one order, the market's
 *     highest leverage, on every market the bots run on; the lowest one wins. Live, so it follows prices.
 *   - markets, hourly volume, the market maker cost per $1M: /api/vs/bots/markets (useBotMarkets), ranked as Explore.
 *   - funds: they stay in the user's SoDEX account. The trading key can trade and, per SoDEX, move funds only between
 *     the user's OWN SoDEX accounts and wallet - never to anyone else. Never say "the bot can only trade".
 *   - setup: connect + 3 signatures (terms, fee, key), one click asks for each; free, no transaction.
 */
import { useEffect, useMemo, useState } from 'react';
import { BOT_FEE_LADDER, BOT_FEE_VIP, BOT_VIP_MIN_USD, COPY_FEE_LADDER, COPY_FEE_WINDOW_DAYS } from '@copy-engine';
import { useSymbols } from '../../hooks';
import { useBotMarkets, type BotMarket } from '../../bots/data';
import { bestOf, feeAdjOf, rankRecipes } from '../../bots/estimate';
import { RECIPE } from '../../bots/recipes';
import { draftFor, minQuoteUsd, planMarkets } from '../../bots/presets';
import { marketOf } from '../algo/draft';
import { scoreRows, COPY_VENUES } from '../copy/gridModel';
import { vsApi, type TraderRow } from '../../vsApi';


/* -------------------------------------------------------------------------------------------------- fees ----- */

export const bp = (tenths: number): string => `${(tenths / 10).toFixed(1)} bp`;
export const FEES = {
  /** What everyone's bot orders pay until VIP (one step since 2026-11-23). */
  botNew: BOT_FEE_LADDER[0]!.fee,
  /** The ladder (volume steps), for tables. */
  botLadder: BOT_FEE_LADDER,
  /** The lowest bot fee: VIP only. Advertise it only with VIP_CONDITION beside it. */
  botLowest: BOT_FEE_VIP,
  vipMinUsd: BOT_VIP_MIN_USD,
  vipCondition: `VIP: $${BOT_VIP_MIN_USD / 1e6}M volume in 14 days`,
  copyNew: COPY_FEE_LADDER[0]!.fee,
  copyLowest: COPY_FEE_LADDER[COPY_FEE_LADDER.length - 1]!.fee,
  copyLowestCondition: `from $${COPY_FEE_LADDER[COPY_FEE_LADDER.length - 1]!.fromUsd / 1e6}M copied volume in ${COPY_FEE_WINDOW_DAYS} days`,
  copyLadder: COPY_FEE_LADDER,
  windowDays: COPY_FEE_WINDOW_DAYS,
} as const;
/** "$100K", "$1M". */
export const usdStep = (usd: number): string => (usd >= 1e6 ? `$${usd / 1e6}M` : `$${usd / 1e3}K`);

export function usdShort(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

/* ------------------------------------------------------------------------------------------- live reads ----- */

export interface MarketRow { m: BotMarket; bp: number | null; recipe: string | null; recipeId: string | null }

export interface LiveDesk {
  loading: boolean;
  error: string | null;
  /** Busiest markets first, each with its cheapest bot's cost (bp; negative = earned) at the VIP fee. */
  rows: MarketRow[];
  /** Markets a bot can run on. */
  marketCount: number | null;
  /** USD traded per hour over those markets. */
  volumeH: number | null;
  /** SoDEX's maker fee now (bp). */
  makerBps: number | null;
  /** The smallest margin a real market maker needs today (USD, rounded UP to the dollar) and where. */
  startFrom: { usd: number; symbol: string; base: string; leverage: number } | null;
}

/**
 * The window the landing pages read the market costs over (owner 2026-11-23: ETH looked dearest though it usually is
 * not). A day swings with one volatile move - on 2026-11-23 ETH read 19.6 bp over 1 h, 4.1 over 24 h and 2.3 over 7 d,
 * level with BTC - so the pages use the week, and say so.
 */
export const DESK_WINDOW = '7d' as const;
export const DESK_WINDOW_TEXT = 'the last 7 days';

/** The live figures every version shows (one read of /api/vs/bots/markets and SoDEX's symbols). */
export function useLiveDesk(): LiveDesk {
  const bots = useBotMarkets(DESK_WINDOW, true, 16);
  const { byName } = useSymbols('perps');
  const rows = useMemo<MarketRow[]>(() => {
    if (!bots.data) return [];
    // At the VIP fee (owner 2026-11-23: "always use vip tiers there"); every place that shows these says so.
    const adj = feeAdjOf(FEES.botLowest, bots.data.fee.builderBps);
    return bots.data.markets
      .filter((m) => m.confidence === 'high')
      .sort((a, b) => b.volumeUsdH - a.volumeUsdH)
      .slice(0, 16)
      .map((m) => {
        const best = bestOf(rankRecipes(m, [], adj));
        return { m, bp: best?.est.bp ?? null, recipe: best ? RECIPE[best.id].name : null, recipeId: best?.id ?? null };
      });
  }, [bots.data]);
  const startFrom = useMemo<LiveDesk['startFrom']>(() => {
    if (!bots.data || !byName?.size) return null;
    let best: LiveDesk['startFrom'] = null;
    for (const m of bots.data.markets) {
      const y = byName.get(m.symbol);
      if (!y || !(m.price > 0)) continue;
      const market = marketOf(y);
      const min = minQuoteUsd(market, m.price);
      if (!(min > 0)) continue;
      const lev = Math.max(1, Math.floor(y.maxLeverage ?? 1));
      const d = { ...draftFor('market', 'balanced', m.symbol), orderUsd: Math.ceil(min * 100) / 100, maxInventoryUsd: Math.ceil(min * 100) / 100, leverage: lev };
      const [plan] = planMarkets(d, [m.symbol], () => ({ market, price: m.price, maxLeverage: y.maxLeverage ?? null }), { paper: false });
      if (!plan || plan.errors.length || !(plan.marginUsd > 0)) continue;
      const usd = Math.ceil(plan.marginUsd);
      if (!best || usd < best.usd) best = { usd, symbol: m.symbol, base: m.base, leverage: lev };
    }
    return best;
  }, [bots.data, byName]);
  return {
    loading: !bots.data && !bots.error,
    error: bots.error,
    rows,
    marketCount: bots.data ? bots.data.markets.length : null,
    volumeH: bots.data ? bots.data.markets.reduce((s, m) => s + (m.volumeUsdH || 0), 0) : null,
    makerBps: bots.data?.fee.makerBps ?? null,
    startFrom,
  };
}

/** The New bot page on this market with exactly the bot shown (Explore's Configure: /bots/new?market=&kind=<recipe>). */
export const botHref = (r: Pick<MarketRow, 'm' | 'recipeId'>): string =>
  `/bots/new?market=${encodeURIComponent(r.m.symbol)}&kind=${encodeURIComponent(r.recipeId ?? 'market')}`;

/**
 * The amount the page advertises to start with (owner 2026-11-23: "Start with as low as $5"): $5, unless today's real
 * minimum (startFrom) is higher, then that. $5 is never below what a real bot needs, so the claim stays true; the
 * real minimum is often lower (about $1 of margin on BTC at 40x on 2026-11-23) but a bot also needs room for its fees
 * and loss limit, so the page never goes under $5.
 */
export const START_FLOOR_USD = 5;
export function startAmount(s: LiveDesk['startFrom']): number {
  return s ? Math.max(START_FLOOR_USD, s.usd) : START_FLOOR_USD;
}
export function startFromText(s: LiveDesk['startFrom']): string {
  return `$${startAmount(s)}`;
}

/* ----------------------------------------------------------------------------------------------- motion ----- */

export const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A phone or laptop with little memory or few cores, or a visitor saving data: fewer frames, no dust, no blur. */
let lite: boolean | null = null;
export function liteDevice(): boolean {
  if (lite === null) {
    const n = typeof navigator === 'undefined' ? null : (navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } });
    lite = !!n && ((n.deviceMemory ?? 8) <= 4 || (n.hardwareConcurrency ?? 8) <= 4 || n.connection?.saveData === true);
  }
  return lite;
}
/** A canvas loop's least time between two frames: half a 60 Hz display's on a good device, a few a second on a small one. */
export const frameMs = (): number => (liteDevice() ? 120 : 32);

/* ---------------------------------------------------------------------------------- the public boards ----- */

/** The copy venues' 30-day boards: read once per page load, whoever asks (the tape, the consoles, the lists). */
const boardReads = new Map<string, Promise<TraderRow[]>>();
export function readBoards(side: 'best' | 'worst', limit: number): Promise<TraderRow[]> {
  const key = `${side}|${limit}`;
  let p = boardReads.get(key);
  if (!p) {
    p = Promise.all(COPY_VENUES.map((venue) => vsApi.leaderboard({ venue, window: '30d', sort: 'pnl', ...(side === 'worst' ? { side } : {}), limit }).then((b) => b.rows, () => [] as TraderRow[]))).then((x) => x.flat());
    boardReads.set(key, p);
  }
  return p;
}
export interface TopTrader { venue: TraderRow['venue']; address: string; label: string | null; pnl: number; row: TraderRow }
/** The best copy scores of the last 30 days (empty until read). */
export function useTopTraders(on: boolean): TopTrader[] {
  const [xs, setXs] = useState<TopTrader[]>([]);
  useEffect(() => {
    if (!on || xs.length) return;
    let alive = true;
    void readBoards('best', 100).then((rows) => {
      if (alive) setXs(scoreRows(rows, '30d', 'copy').sort((a, b) => b.score.score - a.score.score).slice(0, 5).map(({ row }) => ({ venue: row.venue, address: row.address, label: row.label ?? null, pnl: row.pnl['30d'] ?? 0, row })));
    });
    return () => { alive = false; };
  }, [on, xs.length]);
  return xs;
}
