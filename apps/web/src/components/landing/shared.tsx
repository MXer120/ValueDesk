/**
 * What every version of the landing page shares (owner 2026-11-23: four versions, each a different page): the facts it
 * may state, the live reads, the swimming whale and the version switcher.
 *
 * THE FACTS. Every figure is live or a constant the executor charges; nothing is rounded in our favour:
 *   - fees: @copy-engine BOT_FEE_LADDER / BOT_FEE_VIP / COPY_FEE_LADDER. The LOWEST fee may be advertised only WITH its
 *     condition ("from 0.1 bp" + "VIP, $5M 14-day volume"); the fee a new wallet pays is the ladder's first step.
 *   - startFrom: the smallest margin a real market maker needs today, computed with the New bot page's own code
 *     (presets.ts planMarkets): the balanced draft at SoDEX's minimum order, max holding one order, the market's
 *     highest leverage, on every market the bots run on; the lowest one wins. Live, so it follows prices.
 *   - markets, hourly volume, the market maker cost per $1M: /api/vs/bots/markets (useBotMarkets), ranked as Explore.
 *   - funds: they stay in the user's SoDEX account. The trading key can trade and, per SoDEX, move funds only between
 *     the user's OWN SoDEX accounts and wallet - never to anyone else. Never say "the bot can only trade".
 *   - setup: connect + 3 signatures (terms, fee, key), one click asks for each; free, no transaction.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { BOT_FEE_LADDER, BOT_FEE_VIP, COPY_FEE_LADDER, COPY_FEE_WINDOW_DAYS } from '@copy-engine';
import { useSymbols } from '../../hooks';
import { useBotMarkets, type BotMarket } from '../../bots/data';
import { bestOf, feeAdjOf, rankRecipes } from '../../bots/estimate';
import { RECIPE } from '../../bots/recipes';
import { draftFor, minQuoteUsd, planMarkets } from '../../bots/presets';
import { marketOf } from '../algo/draft';
import { loadTone, stipple, TH, TW, type Dot } from '../copy/DotWhale';

/* -------------------------------------------------------------------------------------------------- fees ----- */

export const bp = (tenths: number): string => `${(tenths / 10).toFixed(1)} bp`;
export const FEES = {
  /** What a new wallet's bot orders pay (the ladder's first step). */
  botNew: BOT_FEE_LADDER[0]!.fee,
  /** The ladder (volume steps), for tables. */
  botLadder: BOT_FEE_LADDER,
  /** The lowest bot fee: VIP only. Advertise it only with VIP_CONDITION beside it. */
  botLowest: BOT_FEE_VIP,
  vipCondition: 'VIP: $5M bot volume in 14 days',
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

export interface MarketRow { m: BotMarket; bp: number | null; recipe: string | null }

export interface LiveDesk {
  loading: boolean;
  error: string | null;
  /** Busiest markets first, each with its cheapest bot's cost (bp; negative = earned) at the new wallet's fee. */
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

/** The live figures every version shows (one read of /api/vs/bots/markets and SoDEX's symbols). */
export function useLiveDesk(): LiveDesk {
  const bots = useBotMarkets('24h');
  const { byName } = useSymbols('perps');
  const rows = useMemo<MarketRow[]>(() => {
    if (!bots.data) return [];
    const adj = feeAdjOf(FEES.botNew, bots.data.fee.builderBps);
    return bots.data.markets
      .filter((m) => m.confidence === 'high')
      .sort((a, b) => b.volumeUsdH - a.volumeUsdH)
      .slice(0, 16)
      .map((m) => {
        const best = bestOf(rankRecipes(m, [], adj));
        return { m, bp: best?.est.bp ?? null, recipe: best ? RECIPE[best.id].name : null };
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

/* ------------------------------------------------------------------------------------------ the whale ----- */

/**
 * The owner's dotted humpback (copy/DotWhale.tsx's tone map, the same photo, never redrawn or warped) swimming through
 * the page as it scrolls: a fixed layer behind the content; the scroll position moves the WHOLE whale along a slow
 * path across the screen and turns it a little (the image is only moved, scaled and rotated as one piece). Its dots
 * shimmer. Behind everything, pointer-events none; under reduced motion it rests in one place.
 *
 * `path`: where it swims, as fractions of the screen per scroll progress 0..1 - [x, y, rotate deg, scale] at the start
 * and the end (eased between, with a gentle sway). `tone`: dot colour.
 */
export function SwimmingWhale({
  from = [1.05, 0.25, -64, 1],
  to = [-0.25, 0.7, -76, 1.1],
  height = 520,
  opacity = 0.7,
  color = '232, 238, 244',
  className,
}: {
  from?: [number, number, number, number];
  to?: [number, number, number, number];
  height?: number;
  opacity?: number;
  color?: string;
  className?: string;
}) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = cv.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let dots: Dot[] = [];
    let raf = 0;
    let alive = true;
    const still = reducedMotion();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = () => {
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
    };
    size();
    const draw = (t: number) => {
      if (!alive) return;
      const W = window.innerWidth;
      const H = window.innerHeight;
      const max = Math.max(1, document.documentElement.scrollHeight - H);
      const p = still ? 0.35 : Math.min(1, Math.max(0, window.scrollY / max));
      const e = p * p * (3 - 2 * p);
      const lerp = (a: number, b: number) => a + (b - a) * e;
      const sway = still ? 0 : Math.sin(t / 2400) * 0.012;
      const x = lerp(from[0], to[0]) * W;
      const y = (lerp(from[1], to[1]) + sway) * H;
      const rot = (lerp(from[2], to[2]) + (still ? 0 : Math.sin(t / 3100) * 2)) * (Math.PI / 180);
      const k = (height / TH) * lerp(from[3], to[3]) * Math.min(1, W / 900 + 0.35);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.scale(k, k);
      ctx.translate(-TW / 2, -TH / 2);
      for (const d of dots) {
        const tw = still ? 1 : 0.7 + 0.3 * Math.sin(t / 1000 * d.sp + d.ph);
        ctx.fillStyle = `rgba(${color}, ${(d.a * tw * opacity).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r / Math.max(0.35, k) * 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!still && document.visibilityState === 'visible') raf = requestAnimationFrame(draw);
    };
    const kick = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); };
    void loadTone().then((tone) => {
      if (!alive) return;
      dots = stipple(tone, 7000);
      kick();
    }).catch(() => {});
    const onResize = () => { size(); kick(); };
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', kick, { passive: true });
    document.addEventListener('visibilitychange', kick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', kick);
      document.removeEventListener('visibilitychange', kick);
    };
  }, [from, to, height, opacity, color]);
  return <canvas ref={cv} className={className} aria-hidden="true" style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 0 }} />;
}

/* ------------------------------------------------------------------------------------ version switcher ----- */

export const VERSIONS = [
  { n: 1, name: 'Chrome' },
  { n: 2, name: 'Version 2' },
  { n: 3, name: 'Version 3' },
  { n: 4, name: 'Version 4' },
  { n: 5, name: 'Chrome on heat' },
  { n: 6, name: 'Heat, then convert' },
  { n: 7, name: 'One desk, long' },
  { n: 8, name: 'V5 with the aurora header' },
] as const;

/** The version in the path: /home -> 1, /home/2 -> 2 ... */
export function versionOfPath(pathname: string): number {
  const v = Number(pathname.replace(/\/+$/, '').split('/').filter(Boolean)[1] ?? '1');
  return VERSIONS.some((x) => x.n === v) ? v : 1;
}

/** Localhost only: a small pill to flip between the versions while the owner picks one. */
export function VersionSwitcher({ current }: { current: number }): ReactNode {
  if (!import.meta.env.DEV) return null;
  return (
    <nav aria-label="Landing versions" style={{ position: 'fixed', left: 16, bottom: 16, zIndex: 100, display: 'flex', gap: 4, padding: 4, borderRadius: 999, background: 'rgba(20,20,20,0.85)', border: '1px solid rgba(255,255,255,0.15)', backdropFilter: 'blur(10px)', fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 12 }}>
      {VERSIONS.map((v) => (
        <a key={v.n} href={v.n === 1 ? '/home' : `/home/${v.n}`} title={v.name} style={{ padding: '6px 11px', borderRadius: 999, color: v.n === current ? '#0a0a0a' : v.n >= 5 ? '#4fe3b3' : '#ddd', background: v.n === current ? '#f4f4f2' : 'transparent', textDecoration: 'none' }}>
          V{v.n}
        </a>
      ))}
    </nav>
  );
}
