/**
 * The landing page (/home, router.ts HOME_PATH): what ValueDesk does, for someone who has never opened it - the Bots,
 * copy trading and the analytics, in that order, each with its way in (/bots/new, /copy, /trade). A visitor who lands
 * on /trade sees a terminal and no reason to stay; this page gives the three reasons first.
 *
 * NOTHING ON IT IS MADE UP. Every figure is read live or comes from the code that charges it:
 *   - the bot cost per $1M on each market: GET /api/vs/bots/markets (bots/data.ts useBotMarkets), ranked exactly as
 *     Bots > Explore ranks it (bots/estimate.ts rankRecipes + bestOf) at the bot fee ladder's first step;
 *   - SoDEX's maker fee: the same answer's `fee.makerBps`;
 *   - the bot fee ladder and VIP step, the copy fee ladder: @copy-engine policy.ts (BOT_FEE_LADDER, BOT_FEE_VIP,
 *     COPY_FEE_LADDER), the constants the executor charges;
 *   - the fees per $1M of each strategy: bots/presets.ts costPerMillion, as Bots > Overview shows them;
 *   - the traders: the public boards (/api/vs/leaderboard), scored as the Copy page scores them (gridModel scoreRows);
 *   - the analytics tab: the terminal's own widgets (liquidation map, ETF flows, news and calendar), live.
 * No user counts, no returns, no "best".
 *
 * PERFORMANCE: the hero's one read starts with the page; the copy boards and the analytics widgets are read and mounted
 * only once their section comes near the screen (useNear), the widgets' code from their own chunks (lazyWidgets.tsx).
 * Decorative motion: none beyond the kit's own transitions and the trader cards' glare, which pauses off screen.
 *
 * Links are plain <a href>: App.tsx opens any of the app's paths in place (a plain click), and a middle click still
 * opens a new tab.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BOT_FEE_LADDER, BOT_FEE_VIP, COPY_FEE_LADDER, COPY_FEE_WINDOW_DAYS } from '@copy-engine';
import { useAsync } from '../../hooks';
import { fmtUsd } from '../../format';
import { openPath } from '../../nav';
import { vsApi, VENUE_LABEL, type BoardWindow, type TraderRow, type Venue } from '../../vsApi';
import { useBotMarkets, type BotMarket } from '../../bots/data';
import { bestOf, feeAdjOf, rankRecipes } from '../../bots/estimate';
import { RECIPE } from '../../bots/recipes';
import { DEFAULT_MAKER_FEE, STRATEGY_INFO, costPerMillion, draftFor } from '../../bots/presets';
import { CoinIcon } from '../CoinIcon';
import { VenueLogo } from '../VenueLogo';
import { BrandMark } from '../BrandMark';
import { StrategyTile } from '../bots/BotIcon';
import { Icon, Panel, Shell, ShellHeader, Skeleton, StatusPill, Tabs, type IconName } from '../bots/kit/kit';
import { TraderCard } from '../copy/TraderCard';
import { COPY_VENUES, GRID_VENUES, scoreRows } from '../copy/gridModel';
import { EtfFlows, LazyWidget, LiqHeatmap, NewsFeed } from '../../dashboard/lazyWidgets';
import './landing.css';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

/** The bot fee a new wallet pays (the ladder's first step), tenths of a bp. */
const FIRST_BOT_FEE = BOT_FEE_LADDER[0]!.fee;
const LOWEST_BOT_FEE = BOT_FEE_LADDER[BOT_FEE_LADDER.length - 1]!.fee;
const COPY_FEE_TOP = COPY_FEE_LADDER[0]!.fee;
const COPY_FEE_LOW = COPY_FEE_LADDER[COPY_FEE_LADDER.length - 1]!.fee;
/** Tenths of a bp -> "0.4 bp". */
const bpOf = (tenths: number): string => `${(tenths / 10).toFixed(1)} bp`;
/** The copy window (30 days), as the Copy page's grid opens. */
const BOARD_WINDOW: BoardWindow = '30d';

/** "$5.96M", "$186.8K": a volume. */
function usdShort(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return fmtUsd(v, 0);
}

/** True once the element has come within `margin` of the screen (and stays true): what reads and mounts wait for. */
function useNear<T extends Element>(margin = '320px'): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver !== 'function') { setNear(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); } }, { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [near, margin]);
  return [ref, near];
}

/** A link styled as the kit's Button (kit.tsx: same classes), so a middle click opens a new tab. */
function LinkButton({ href, variant = 'secondary', size = 'md', icon, children, className }: { href: string; variant?: 'primary' | 'secondary' | 'quiet' | 'go'; size?: 'sm' | 'md'; icon?: IconName; children: ReactNode; className?: string }) {
  return (
    <a href={href} className={cx('tf-btn', `is-${variant}`, `is-${size}`, 'lp-linkbtn', className)}>
      {icon && <Icon name={icon} size={size === 'md' ? 16 : 14} />}
      {children}
    </a>
  );
}

function SectionHead({ n, eyebrow, title, line, aside }: { n: string; eyebrow: string; title: ReactNode; line: ReactNode; aside?: ReactNode }) {
  return (
    <header className="lp-shead">
      <div className="lp-shead__t">
        <p className="lp-eyebrow"><span className="lp-eyebrow__n">{n}</span>{eyebrow}</p>
        <h2 className="lp-h2">{title}</h2>
        <p className="lp-lead">{line}</p>
      </div>
      {aside && <div className="lp-shead__aside">{aside}</div>}
    </header>
  );
}

function Point({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <li className="lp-point">
      <span className="tf-tile lp-point__ic" aria-hidden="true"><Icon name={icon} size={16} /></span>
      <div className="lp-point__t">
        <p className="lp-point__title">{title}</p>
        <p className="lp-point__line">{children}</p>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------- hero ----- */

interface MarketRow { m: BotMarket; bp: number | null; recipe: string | null }

/** Each market's cheapest bot at the ladder's first step, as Bots > Explore reads it. */
function rankMarkets(markets: readonly BotMarket[], builderBps: number | undefined): MarketRow[] {
  const adj = feeAdjOf(FIRST_BOT_FEE, builderBps);
  return markets
    .filter((m) => m.confidence === 'high')
    .sort((a, b) => b.volumeUsdH - a.volumeUsdH)
    .slice(0, 5)
    .map((m) => {
      const best = bestOf(rankRecipes(m, [], adj));
      return { m, bp: best?.est.bp ?? null, recipe: best ? RECIPE[best.id].name : null };
    });
}

/** Cost per $1M, from bp: a cost as "$156", an earning as "+$79" in green. */
function PerMillion({ bp }: { bp: number | null }) {
  if (bp === null) return <span className="lp-dim">—</span>;
  const usd = Math.abs(bp) * 100;
  return bp <= 0 ? <b className="pos">+{fmtUsd(usd, 0)}</b> : <b>{fmtUsd(usd, 0)}</b>;
}

function HeroMarkets({ data, error }: { data: ReturnType<typeof useBotMarkets>['data']; error: string | null }) {
  const rows = useMemo(() => (data ? rankMarkets(data.markets, data.fee.builderBps) : []), [data]);
  const at = data ? new Date(data.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <Shell className="lp-heromkts" aria-label="What a market maker costs per $1M of volume on SoDEX now">
      <ShellHeader
        icon="robot"
        title="Market maker cost per $1M"
        subtitle={data ? `SoDEX's busiest markets, last 24 h · ${at}` : 'SoDEX markets, last 24 h'}
        aside={<StatusPill tone={error && !data ? 'neutral' : 'positive'} size="sm" dot pulse={!!data}>{error && !data ? 'Offline' : 'Live'}</StatusPill>}
      />
      <Panel className="lp-mkts">
        <div className="lp-mkts__head" aria-hidden="true">
          <span>Market</span><span className="r">Volume / h</span><span className="r">Est. cost</span>
        </div>
        {!data && !error && [0, 1, 2, 3, 4].map((i) => <div key={i} className="lp-mkts__row is-skel"><Skeleton className="lp-skel" /></div>)}
        {!data && error && <p className="lp-mkts__empty">The estimates did not load. Explore has them once SoDEX's trades are in.</p>}
        {rows.map(({ m, bp, recipe }) => (
          <a key={m.symbol} href={`/bots/new?market=${encodeURIComponent(m.symbol)}&kind=market`} className="lp-mkts__row" title={recipe ? `Cheapest bot here: ${recipe}` : undefined}>
            <span className="lp-mkts__coin"><CoinIcon coin={m.base} size={22} /><span><b>{m.base}</b><small>{recipe ?? 'Market maker'}</small></span></span>
            <span className="r lp-num">{usdShort(m.volumeUsdH)}</span>
            <span className="r lp-num"><PerMillion bp={bp} /></span>
          </a>
        ))}
      </Panel>
      <p className="lp-heromkts__foot">
        Estimated from each market's own trades with the {bpOf(FIRST_BOT_FEE)} bot fee, refreshed every 5 minutes. Green: it earned more than it paid.
        {data && <> <a href="/bots/explore">All {data.markets.length} markets</a></>}
      </p>
    </Shell>
  );
}

/* ------------------------------------------------------------- bots ----- */

function StrategyCard({ s, makerBps }: { s: 'market' | 'grid'; makerBps: number | null }) {
  const info = STRATEGY_INFO[s];
  const cost = costPerMillion(draftFor(s), makerBps === null ? null : { makerFee: makerBps / 10_000, tickSize: '' }, null, FIRST_BOT_FEE);
  return (
    <Panel className="lp-strat">
      <div className="lp-strat__top">
        <StrategyTile strategy={s} size={44} />
        <div className="lp-strat__t">
          <h3 className="lp-strat__name">{info.name}</h3>
          <p className="lp-strat__line">{info.line}</p>
        </div>
      </div>
      <ul className="lp-strat__how">
        {info.how.map((h) => <li key={h}><Icon name="check" size={14} />{h}</li>)}
      </ul>
      <div className="lp-strat__foot">
        <span><small>Fees per $1M</small><b className="lp-num">{fmtUsd(cost.fees, 0)}</b></span>
        <span><small>Best for</small><b>{info.best}</b></span>
      </div>
      <LinkButton href={`/bots/new?kind=${s}`} variant={s === 'market' ? 'primary' : 'secondary'} icon="plus" className="lp-strat__cta">Set up a {s === 'market' ? 'market maker' : 'grid'}</LinkButton>
    </Panel>
  );
}

function BotFeeLadder() {
  const from = (usd: number) => (usd === 0 ? 'From the first trade' : `From ${usd >= 1e6 ? `${usd / 1e6}M` : `${usd / 1e3}K`} in 14 days`);
  return (
    <Panel className="lp-ladder" aria-label="Bot fee by 14-day volume">
      <p className="lp-ladder__title">Bot fee, by your 14-day volume</p>
      <ol>
        {BOT_FEE_LADDER.map((s) => (
          <li key={s.fromUsd}><span>{from(s.fromUsd)}</span><b className="lp-num">{bpOf(s.fee)}</b></li>
        ))}
        <li className="vip-row"><span><span className="tf-pill is-sm vip-pill">VIP</span> $5M in 14 days</span><b className="lp-num vip-text">{bpOf(BOT_FEE_VIP)}</b></li>
      </ol>
      <p className="lp-ladder__note">On top of SoDEX's own maker fee, on each bot fill.</p>
    </Panel>
  );
}

/* ------------------------------------------------------------- copy ----- */

function TopTraders({ on }: { on: boolean }) {
  const boards = useAsync(
    () => Promise.all(COPY_VENUES.map((venue) => vsApi.leaderboard({ venue, window: BOARD_WINDOW, sort: 'pnl', limit: 100 }).then((b) => b.rows, () => [] as TraderRow[]))),
    [],
    { enabled: on, pollMs: 60_000 },
  );
  const top = useMemo(() => scoreRows((boards.data ?? []).flat(), BOARD_WINDOW, 'copy').sort((a, b) => b.score.score - a.score.score).slice(0, 3), [boards.data]);
  const open = (r: TraderRow) => openPath(`/copy?address=${r.address}&venue=${r.venue}`);
  if (!boards.data) {
    return (
      <div className="lp-traders" aria-busy="true">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="lp-skel is-card" />)}
      </div>
    );
  }
  if (!top.length) return <p className="lp-dim">The boards did not load. The Copy page has every trader.</p>;
  return (
    <div className="cpy lp-cpy">
      <div className="lp-traders">
        {top.map((s) => (
          <TraderCard key={`${s.row.venue}:${s.row.address}`} row={s.row} score={s.score} window={BOARD_WINDOW} unit="usd" kind="copy" onOpen={open} onCopy={open} />
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------- analytics ----- */

type View = 'liq' | 'etf' | 'news';
const VIEWS: Array<{ value: View; label: string }> = [
  { value: 'liq', label: 'Liquidation map' },
  { value: 'etf', label: 'ETF flows' },
  { value: 'news', label: 'News & calendar' },
];

function LiveTerminal({ on }: { on: boolean }) {
  const [view, setView] = useState<View>('liq');
  return (
    <Shell className="lp-term">
      <div className="lp-term__bar">
        <Tabs tabs={VIEWS} value={view} onChange={setView} label="Live analytics" />
        <StatusPill tone="positive" size="sm" dot>Live, from the terminal</StatusPill>
      </div>
      <Panel className={cx('lp-term__body', `is-${view}`)}>
        {!on ? <Skeleton className="lp-skel is-term" /> : (
          <LazyWidget>
            {view === 'liq' && <LiqHeatmap symbol="BTC-USD" engine="perps" instance="landing" />}
            {view === 'etf' && <EtfFlows instance="landing" />}
            {view === 'news' && <NewsFeed instance="landing" />}
          </LazyWidget>
        )}
      </Panel>
    </Shell>
  );
}

const TOOLS: Array<{ icon: IconName; title: string; line: string; href: string; cta: string }> = [
  { icon: 'layers', title: 'Liquidation heatmap', line: 'Where positions on five venues get liquidated, by price and leverage, streamed live and back in history.', href: '/trade', cta: 'Open on the chart' },
  { icon: 'pulse', title: 'Who traded each candle', line: 'Pick a candle: the wallets that bought and sold in it, by size, each one a click from its history.', href: '/trade', cta: 'Open on the chart' },
  { icon: 'star', title: 'Leaderboards and wallet scan', line: 'Rank traders by PnL, return, volume and equity, then open any wallet: positions, fills and history.', href: '/leaderboard', cta: 'Leaderboard' },
  { icon: 'compass', title: 'Cohorts and markets', line: 'How the tracked wallets are positioned, by size and by profit, and every SoDEX market in one table.', href: '/explore', cta: 'Explore' },
  { icon: 'clock', title: 'News and the macro calendar', line: 'Crypto news as it lands, FOMC meetings and US releases, with their figures as they print.', href: '/trade', cta: 'Open the terminal' },
  { icon: 'chart', title: 'ETF flows', line: 'Daily money in and out of the US spot crypto ETFs, fund by fund. Powered by SoSoValue.', href: '/trade', cta: 'Open the terminal' },
];

/* ------------------------------------------------------------- page ----- */

export function Landing() {
  const bots = useBotMarkets('24h');
  const makerBps = bots.data?.fee.makerBps ?? null;
  const [copyRef, copyNear] = useNear<HTMLElement>();
  const [termRef, termNear] = useNear<HTMLDivElement>('120px');
  // The phone's sticky bar shows once the hero's own buttons have scrolled away.
  const ctaRef = useRef<HTMLDivElement>(null);
  const [ctaGone, setCtaGone] = useState(false);
  useEffect(() => {
    const el = ctaRef.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver(([e]) => setCtaGone(!!e && !e.isIntersecting && e.boundingClientRect.top < 0));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="tf lp">
      <div className="lp-col">
        {/* ---------------------------------------------------------- hero */}
        <section className="lp-hero" aria-labelledby="lp-title">
          <div className="lp-hero__text">
            <p className="lp-brand"><BrandMark size={22} /><span>ValueDesk</span><span className="lp-brand__on">for SoDEX</span></p>
            <h1 id="lp-title" className="lp-h1">Bots, copy trading and analytics, <em>on one desk.</em></h1>
            <p className="lp-hero__sub">
              Run a market maker or grid bot on our servers around the clock. Copy any Hyperliquid or SoDEX wallet. Read
              liquidations, flow and the macro calendar before you trade. Every order lands in your own SoDEX account.
            </p>
            <div className="lp-cta" ref={ctaRef}>
              <LinkButton href="/bots/new" variant="primary" icon="robot">Start a bot</LinkButton>
              <LinkButton href="/copy" icon="layers">Copy a trader</LinkButton>
              <LinkButton href="/trade" variant="quiet" icon="chart">Open the terminal</LinkButton>
            </div>
            <ul className="lp-facts">
              <li><Icon name="wallet" size={14} />Set up with 3 wallet signatures</li>
              <li><Icon name="shield" size={14} />No deposit to us: funds stay on SoDEX</li>
              <li><Icon name="coins" size={14} />Bot fee {bpOf(FIRST_BOT_FEE)}, down to {bpOf(LOWEST_BOT_FEE)}</li>
            </ul>
          </div>
          <HeroMarkets data={bots.data} error={bots.error} />
        </section>

        {/* ---------------------------------------------------------- bots */}
        <section className="lp-sec" id="bots" aria-labelledby="lp-bots">
          <SectionHead
            n="01"
            eyebrow="Bots"
            title={<span id="lp-bots">Volume on SoDEX, running 24/7 without you.</span>}
            line="Pick a market, a size and a loss limit. The bot quotes on our servers day and night, rests every order on the book and stops at your limits. Close the tab: it keeps going."
            aside={<LinkButton href="/bots/explore" variant="quiet" icon="compass">Costs on every market</LinkButton>}
          />
          <div className="lp-bots">
            <StrategyCard s="market" makerBps={makerBps} />
            <StrategyCard s="grid" makerBps={makerBps} />
            <div className="lp-bots__side">
              <BotFeeLadder />
              <Panel className="lp-maker">
                <span className="tf-tile" aria-hidden="true"><Icon name="gauge" size={16} /></span>
                <div>
                  <p className="lp-maker__v lp-num">{makerBps === null ? bpOf(DEFAULT_MAKER_FEE * 100_000) : `${makerBps.toFixed(1)} bp`}</p>
                  <p className="lp-maker__l">SoDEX's maker fee {makerBps === null ? '(tier 0)' : 'now, tier 0'}: what every bot fill pays SoDEX</p>
                </div>
              </Panel>
            </div>
          </div>
          <ul className="lp-points is-3">
            <Point icon="bolt" title="Hosted, always on">Bots run on the ValueDesk executor, not in your browser. Start one and close the laptop.</Point>
            <Point icon="shield" title="Limits you set">An inventory cap, a loss limit and trading hours. A bot holds while its price source is not fresh.</Point>
            <Point icon="play" title="Practice first">Run any bot in practice, with no real orders, then run the same settings for real.</Point>
          </ul>
        </section>

        {/* ---------------------------------------------------------- copy */}
        <section className="lp-sec" id="copy" ref={copyRef} aria-labelledby="lp-copy">
          <SectionHead
            n="02"
            eyebrow="Copy trading"
            title={<span id="lp-copy">Copy any wallet on Hyperliquid or SoDEX.</span>}
            line="Follow a trader trade for trade, or trade against them. Run the copy in your browser, or hand it to our executor in Tokyo so it keeps copying when the tab is closed."
            aside={<LinkButton href="/copy" variant="quiet" icon="search">All traders</LinkButton>}
          />
          <div className="lp-copy">
            <div className="lp-copy__cards">
              <p className="lp-label"><span>Top copy scores, last 30 days</span><StatusPill tone="positive" size="sm" dot>Live</StatusPill></p>
              <TopTraders on={copyNear} />
            </div>
            <ul className="lp-points">
              <Point icon="search" title="Any address">Pick from the boards, or paste any Hyperliquid or SoDEX wallet and copy it.</Point>
              <Point icon="gear" title="Your size, your limits">Set a multiplier, a leverage cap and whether to follow only new trades. Every copy lands in your own account.</Point>
              <Point icon="clock" title="Browser or hosted">Run it from an open tab, or hosted on the executor in Tokyo for copies that keep going.</Point>
              <Point icon="coins" title={`Copy fee ${bpOf(COPY_FEE_TOP)}, down to ${bpOf(COPY_FEE_LOW)}`}>By your {COPY_FEE_WINDOW_DAYS}-day volume, on the copied trades only.</Point>
            </ul>
          </div>
        </section>

        {/* ----------------------------------------------------- analytics */}
        <section className="lp-sec" id="analytics" aria-labelledby="lp-an">
          <SectionHead
            n="03"
            eyebrow="Analytics"
            title={<span id="lp-an">See the market before you trade it.</span>}
            line="Liquidation levels, who traded each candle, leaderboards, cohorts, news, the macro calendar and ETF flows, in the terminal you trade from."
            aside={<LinkButton href="/trade" variant="quiet" icon="chart">Open the terminal</LinkButton>}
          />
          <div ref={termRef}><LiveTerminal on={termNear} /></div>
          <div className="lp-tools">
            {TOOLS.map((t) => (
              <a key={t.title} href={t.href} className="lp-tool">
                <span className="tf-tile" aria-hidden="true"><Icon name={t.icon} size={16} /></span>
                <span className="lp-tool__t"><b>{t.title}</b><span>{t.line}</span></span>
                <span className="lp-tool__go">{t.cta}<Icon name="arrowRight" size={12} /></span>
              </a>
            ))}
          </div>
          <div className="lp-venues" aria-label="Venues the analytics read">
            <span className="lp-venues__l">Indexed venues</span>
            {GRID_VENUES.map((v: Venue) => (
              <span key={v} className="lp-venue"><VenueLogo venue={v} size={16} />{VENUE_LABEL[v]}</span>
            ))}
          </div>
        </section>

        {/* --------------------------------------------------------- start */}
        <section className="lp-sec lp-start" aria-labelledby="lp-start">
          <div className="lp-start__t">
            <h2 id="lp-start" className="lp-h2">Set up once, in three signatures.</h2>
            <p className="lp-lead">Connect your wallet and approve with three signatures. No deposit to ValueDesk: your funds stay in your SoDEX account, and you can revoke the access at any time.</p>
          </div>
          <ol className="lp-steps">
            <li><span className="lp-steps__n">1</span><b>Connect</b><span>Any wallet you use on SoDEX.</span></li>
            <li><span className="lp-steps__n">2</span><b>Sign three times</b><span>Accept the terms and approve the trading key.</span></li>
            <li><span className="lp-steps__n">3</span><b>Start</b><span>A bot, a copy, or a trade from the terminal.</span></li>
          </ol>
          <div className="lp-cta is-end">
            <LinkButton href="/bots/new" variant="primary" icon="robot">Start a bot</LinkButton>
            <LinkButton href="/copy" icon="layers">Copy a trader</LinkButton>
            <LinkButton href="/trade" variant="quiet" icon="chart">Open the terminal</LinkButton>
          </div>
        </section>

        <p className="lp-risk">
          Trading perpetual futures carries a high risk of loss. Bots and copies can lose money, and past results of any trader or market say nothing about future ones.{' '}
          <a href="/copy-terms">Copy terms and risks</a>
        </p>
      </div>

      {/* The phone's way in, once the hero's buttons are gone (above the tab bar). */}
      <div className={cx('lp-sticky', ctaGone && 'is-on')} aria-hidden={!ctaGone}>
        <LinkButton href="/bots/new" variant="primary" icon="robot">Start a bot</LinkButton>
        <LinkButton href="/copy" icon="layers">Copy</LinkButton>
      </div>
    </div>
  );
}
