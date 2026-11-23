/**
 * The landing page (/home, router.ts HOME_PATH), owner 2026-11-23: a page of its own OUTSIDE the app - no rail, no
 * navbar, no terms popup (main.tsx mounts it instead of <App/>) - in the brand's ink and chrome with the V's green
 * point as the one accent (marketing/BRAND.md).
 *
 * NOTHING ON IT IS MADE UP. Every figure is read live or is the constant the executor charges:
 *   - markets, volume and the market maker cost per $1M: GET /api/vs/bots/markets (bots/data.ts useBotMarkets), ranked
 *     as Bots > Explore ranks it (bots/estimate.ts) at the bot fee ladder's first step;
 *   - the traders: the public boards (/api/vs/leaderboard), scored as the Copy page scores them;
 *   - fees: @copy-engine policy.ts (BOT_FEE_LADDER, BOT_FEE_VIP, COPY_FEE_LADDER);
 *   - venues: the ones the analytics index (copy/gridModel.ts GRID_VENUES).
 * The graphics (the chrome V, the book, the two lines, the heat field) are drawings, never figures: no number on them.
 *
 * Motion: every loop pauses off screen (data-off, set by useOnScreen) and stops for prefers-reduced-motion.
 * English only (data-no-i18n): the translation layer translated it word by word.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { BOT_FEE_LADDER, BOT_FEE_VIP, COPY_FEE_LADDER, COPY_FEE_WINDOW_DAYS } from '@copy-engine';
import { useAsync } from '../../hooks';
import { vsApi, VENUE_LABEL, type BoardWindow, type TraderRow } from '../../vsApi';
import { useBotMarkets, type BotMarket } from '../../bots/data';
import { bestOf, feeAdjOf, rankRecipes } from '../../bots/estimate';
import { RECIPE } from '../../bots/recipes';
import { CoinIcon } from '../CoinIcon';
import { VenueLogo } from '../VenueLogo';
import { BrandMark } from '../BrandMark';
import { COPY_VENUES, GRID_VENUES, scoreRows } from '../copy/gridModel';
import { dropBootShell } from '../../bootShell';
import { FEES, startFromText, SwimmingWhale, usdStep, useLiveDesk } from './shared';
import './home.css';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
const FIRST_BOT_FEE = BOT_FEE_LADDER[0]!.fee;
const bp = (tenths: number): string => `${(tenths / 10).toFixed(1)} bp`;
const BOARD_WINDOW: BoardWindow = '30d';

function usdShort(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

const reduced = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** On screen now (true/false, follows): loops pause off screen. `once`: true from the first time it comes near, for reveals and reads. */
export function useOnScreen<T extends Element>(o: { once?: boolean; margin?: string } = {}): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver !== 'function') { setOn(true); return; }
    const io = new IntersectionObserver(([e]) => {
      if (!e) return;
      if (o.once) { if (e.isIntersecting) { setOn(true); io.disconnect(); } } else setOn(e.isIntersecting);
    }, { rootMargin: o.margin ?? '0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [o.once, o.margin]);
  return [ref, on];
}

/** Fades and lifts its children in once, as they come on screen. */
export function Reveal({ children, className, delay = 0, as: As = 'div' }: { children: ReactNode; className?: string; delay?: number; as?: 'div' | 'section' | 'li' | 'header' }) {
  const [ref, on] = useOnScreen<HTMLDivElement>({ once: true, margin: '-8% 0px' });
  return <As ref={ref as never} className={cx('h-rv', on && 'is-in', className)} style={{ '--d': `${delay}ms` } as CSSProperties}>{children}</As>;
}

/** A number that counts up to its value once on screen. */
export function Count({ to, fmt }: { to: number | null; fmt: (v: number) => string }) {
  const [ref, on] = useOnScreen<HTMLSpanElement>({ once: true });
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!on || to === null) return;
    if (reduced()) { setV(to); return; }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 1400);
      setV(to * (1 - Math.pow(1 - k, 4)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on, to]);
  return <span ref={ref}>{to === null ? '—' : fmt(v)}</span>;
}

/* ---------------------------------------------------------------------------------------------- chrome V ----- */

// The brand mark's five blocks (BrandMark.tsx): columns and rows of the V; the bottom one is the green point.
const COLS = [0, 4, 1, 3, 2] as const;
const ROWS = [0, 0, 1, 1, 2] as const;

function Block({ c, r, i }: { c: number; r: number; i: number }) {
  return (
    <div className={cx('cv-b', r === 2 && 'is-pt')} style={{ '--c': c, '--r': r, '--i': i } as CSSProperties}>
      <i className="cv-f cv-front" /><i className="cv-f cv-back" /><i className="cv-f cv-left" /><i className="cv-f cv-right" /><i className="cv-f cv-top" /><i className="cv-f cv-bottom" />
    </div>
  );
}

/** The V in chrome: five extruded blocks turning slowly, leaning toward the pointer. Decorative. */
export function ChromeV() {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reduced()) return;
    const el = stage.current;
    if (!el) return;
    let raf = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const x = e.clientX / window.innerWidth - 0.5;
        const y = e.clientY / window.innerHeight - 0.5;
        el.style.setProperty('--px', `${(x * 18).toFixed(2)}deg`);
        el.style.setProperty('--py', `${(-y * 12).toFixed(2)}deg`);
      });
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => { window.removeEventListener('pointermove', move); cancelAnimationFrame(raf); };
  }, []);
  return (
    <div ref={ref} className="cv" data-off={on ? undefined : ''} aria-hidden="true">
      <div className="cv-glow" />
      <div ref={stage} className="cv-stage">
        <div className="cv-rig">
          {COLS.map((c, i) => <Block key={i} c={c} r={ROWS[i]!} i={i} />)}
        </div>
      </div>
      {/* Loose blocks orbiting the mark: the brand's one shape. */}
      <span className="cv-bit b1" /><span className="cv-bit b2" /><span className="cv-bit b3" /><span className="cv-bit b4 is-g" />
      <div className="cv-floor" />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------- hero ----- */

interface MarketRow { m: BotMarket; bp: number | null; recipe: string | null }

function rankMarkets(markets: readonly BotMarket[], builderBps: number | undefined, n: number): MarketRow[] {
  const adj = feeAdjOf(FIRST_BOT_FEE, builderBps);
  return markets
    .filter((m) => m.confidence === 'high')
    .sort((a, b) => b.volumeUsdH - a.volumeUsdH)
    .slice(0, n)
    .map((m) => {
      const best = bestOf(rankRecipes(m, [], adj));
      return { m, bp: best?.est.bp ?? null, recipe: best ? RECIPE[best.id].name : null };
    });
}

function perMillion(b: number | null): ReactNode {
  if (b === null) return <span className="h-dim">—</span>;
  const usd = `$${Math.round(Math.abs(b) * 100).toLocaleString('en-US')}`;
  return b <= 0 ? <b className="h-pos">+{usd}</b> : <b>{usd}</b>;
}

/** The live tape under the hero: each busy SoDEX market, its hourly volume and what a market maker costs per $1M there. */
export function Tape({ rows, label }: { rows: MarketRow[]; label?: string }) {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  if (!rows.length) return <div className="h-tape is-empty" />;
  const items = rows.map(({ m, bp: b }) => (
    <a key={m.symbol} href={`/bots/new?market=${encodeURIComponent(m.symbol)}&kind=market`} className="h-tape__i">
      <CoinIcon coin={m.base} size={18} />
      <b>{m.base}</b>
      <span className="h-dim">{usdShort(m.volumeUsdH)}/h</span>
      <span className="h-tape__c">{perMillion(b)}<small> per $1M</small></span>
    </a>
  ));
  return (
    <div ref={ref} className={cx('h-tape', label && 'has-k')} data-off={on ? undefined : ''} aria-label="SoDEX markets now: hourly volume and the market maker cost per $1M">
      {label && <span className="h-tape__k">{label}</span>}
      <div className="h-tape__run">{items}<span aria-hidden="true" className="h-tape__dup">{items}</span></div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- graphics ----- */

/**
 * What a market maker does, as a book (owner 2026-11-23: the old "your bid / your ask" over two depth charts made no
 * sense): asks above, bids below, the spread between. Your two quotes rest at the best price on each side; a trade
 * takes one (it lights up and empties: filled), the bot quotes again, then the other side. Drawing, no figures.
 */
export function BookViz() {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const asks = [0.86, 0.58, 0.74, 0.42]; // far -> near the spread
  const bids = [0.5, 0.78, 0.62, 0.9]; // near -> far
  return (
    <div ref={ref} className="g-book g-ob" data-off={on ? undefined : ''} aria-hidden="true">
      <div className="g-ob__side is-ask">
        {asks.map((w, i) => <span key={i} className="g-ob__row" style={{ '--w': w, '--i': i } as CSSProperties}><i /></span>)}
        <span className="g-ob__row is-mine" style={{ '--w': 0.34 } as CSSProperties}><i /><em className="g-ob__tag"><b>Your ask</b><b className="is-done">Filled</b></em></span>
      </div>
      <div className="g-ob__spread"><span>spread</span></div>
      <div className="g-ob__side is-bid">
        <span className="g-ob__row is-mine" style={{ '--w': 0.34 } as CSSProperties}><i /><em className="g-ob__tag"><b>Your bid</b><b className="is-done">Filled</b></em></span>
        {bids.map((w, i) => <span key={i} className="g-ob__row" style={{ '--w': w, '--i': i + 4 } as CSSProperties}><i /></span>)}
      </div>
    </div>
  );
}

/** A leader's line and a copy following it a step behind. Drawing, no figures. */
export function FollowViz() {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const d = 'M0 120 C40 110 60 70 100 78 S160 120 200 96 S260 30 300 44 S360 70 400 24';
  return (
    <div ref={ref} className="g-follow" data-off={on ? undefined : ''} aria-hidden="true">
      <svg viewBox="0 0 400 140" preserveAspectRatio="none">
        <defs>
          <linearGradient id="gf-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#00b481" stopOpacity="0.28" /><stop offset="1" stopColor="#00b481" stopOpacity="0" /></linearGradient>
        </defs>
        <path d={`${d} L400 140 L0 140 Z`} fill="url(#gf-fill)" className="g-follow__area" />
        <path d={d} className="g-follow__lead" pathLength={1} />
        <path d={d} className="g-follow__copy" pathLength={1} transform="translate(0 6)" />
      </svg>
      <span className="g-follow__tag is-l">Leader</span><span className="g-follow__tag is-c">Your copy</span>
    </div>
  );
}

// The heatmap's own ramp (BRAND.md Heat).
const HEAT = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'];

/** Bands of liquidation heat drifting behind ribbed glass: the brand's one big colour field. Drawing, no figures. */
export function HeatViz() {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = cv.current;
    if (!c || !on) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const W = (c.width = 360);
    const H = (c.height = 200);
    // Bands: price rows of heat, mostly indigo and blue, a green body, one small hot point.
    const bands = Array.from({ length: 26 }, (_, i) => ({ y: (i / 26) * H, h: 3 + Math.random() * 9, k: Math.random() ** 2.2, ph: Math.random() * 6.28, sp: 0.2 + Math.random() * 0.6 }));
    const still = reduced();
    let raf = 0;
    const draw = (t: number) => {
      ctx.fillStyle = '#0d0420';
      ctx.fillRect(0, 0, W, H);
      for (const b of bands) {
        const k = Math.min(0.999, b.k * (0.75 + 0.25 * Math.sin(t / 1000 * b.sp + b.ph)));
        const ci = Math.min(HEAT.length - 1, Math.floor(k * HEAT.length));
        const grd = ctx.createLinearGradient(0, 0, W, 0);
        grd.addColorStop(0, HEAT[Math.max(0, ci - 1)]!);
        grd.addColorStop(0.55 + 0.25 * Math.sin(t / 2600 + b.ph), HEAT[ci]!);
        grd.addColorStop(1, HEAT[Math.max(0, ci - 1)]!);
        ctx.globalAlpha = 0.5 + k * 0.5;
        ctx.fillStyle = grd;
        ctx.fillRect(0, b.y + 2 * Math.sin(t / 1800 + b.ph), W, b.h);
      }
      ctx.globalAlpha = 1;
      // The price line walking across it.
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 6) {
        const y = H * 0.52 + Math.sin(x / 40 + t / 1400) * 14 + Math.sin(x / 13 + t / 900) * 4;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (!still) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [on]);
  return (
    <div ref={ref} className="g-heat" aria-hidden="true">
      <canvas ref={cv} />
      <div className="g-heat__ribs" />
    </div>
  );
}

/** The three signatures as chrome tiles, ticked in turn. */
export function SignViz() {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  return (
    <div ref={ref} className="g-sign" data-off={on ? undefined : ''} aria-hidden="true">
      {['Terms', 'Fee', 'Key'].map((t, i) => (
        <div key={t} className="g-sign__t" style={{ '--i': i } as CSSProperties}>
          <span className="g-sign__n">{i + 1}</span>
          <b>{t}</b>
          <svg viewBox="0 0 20 20" className="g-sign__ok"><path d="m5 10.4 3.2 3.1L15 6.7" /></svg>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------- copy list ----- */

export function TopTraders({ on }: { on: boolean }) {
  const boards = useAsync(
    () => Promise.all(COPY_VENUES.map((venue) => vsApi.leaderboard({ venue, window: BOARD_WINDOW, sort: 'pnl', limit: 100 }).then((b) => b.rows, () => [] as TraderRow[]))),
    [],
    { enabled: on, pollMs: 120_000 },
  );
  const top = useMemo(() => scoreRows((boards.data ?? []).flat(), BOARD_WINDOW, 'copy').sort((a, b) => b.score.score - a.score.score).slice(0, 3), [boards.data]);
  if (!boards.data) return <ul className="h-traders is-skel">{[0, 1, 2].map((i) => <li key={i} />)}</ul>;
  if (!top.length) return null;
  return (
    <ul className="h-traders">
      {top.map(({ row }) => {
        const pnl = row.pnl[BOARD_WINDOW] ?? null;
        return (
          <li key={`${row.venue}:${row.address}`}>
            <a href={`/copy?address=${row.address}&venue=${row.venue}`}>
              <VenueLogo venue={row.venue} size={16} />
              <span className="h-traders__a">{row.label || `${row.address.slice(0, 6)}…${row.address.slice(-4)}`}</span>
              <span className={cx('h-traders__p', pnl !== null && pnl >= 0 && 'h-pos')}>{pnl === null ? '—' : `${pnl >= 0 ? '+' : '−'}${usdShort(Math.abs(pnl))}`}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/* -------------------------------------------------------------------------------------------------- page ----- */

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="h-eyebrow"><span className="h-eyebrow__dot" />{children}</p>;
}

export function Arrow() {
  return <svg className="h-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" /></svg>;
}

const FAQ: Array<{ q: string; a: string }> = [
  { q: 'Do I deposit anything with ValueDesk?', a: 'No. Your funds stay in your own SoDEX account. Bots and copies place orders there with a trading key you register on SoDEX; that key can move funds only between your own SoDEX accounts and your wallet.' },
  { q: 'What does it cost?', a: `The analytics are free. Bot orders pay ${bp(BOT_FEE_LADDER[0]!.fee)} of their value, down to ${bp(BOT_FEE_LADDER[BOT_FEE_LADDER.length - 1]!.fee)} by your 14-day volume and ${bp(BOT_FEE_VIP)} for VIP. Copied orders pay ${bp(COPY_FEE_LADDER[0]!.fee)} down to ${bp(COPY_FEE_LADDER[COPY_FEE_LADDER.length - 1]!.fee)}. SoDEX charges its own trading fee on top.` },
  { q: 'Can I stop at any time?', a: 'Yes. Stop a bot or a copy in the app, and revoke the trading key and the fee approval on SoDEX whenever you like. The key also ends on its own after the days you chose, at most 180.' },
  { q: 'Do bots keep running when I close the tab?', a: 'Yes. Bots and hosted copies run on the ValueDesk executor in Tokyo around the clock. Browser copies run while their tab is open.' },
  { q: 'What does setting up take?', a: 'Connect a wallet you use on SoDEX and sign three times: the terms, the fee and the trading key. Signatures are free; nothing is a transaction.' },
  { q: 'How much do I need to start?', a: `${startFromText(null)} is enough to start a market maker on the busiest markets; SoDEX's own minimum order on each market applies. Keep room for fees and your loss limit.` },
  { q: 'Can a bot send my money anywhere?', a: 'No. The trading key places orders and, as SoDEX allows, moves funds only between your own SoDEX accounts and your wallet, never to anyone else. You can revoke it on SoDEX at any time.' },
  { q: 'Where is it available?', a: 'Not in the United States, the United Kingdom, Canada or sanctioned countries. The terms list every place it is not offered.' },
];

export function Home() {
  const bots = useBotMarkets('24h');
  const live = useLiveDesk();
  const rows = useMemo(() => (bots.data ? rankMarkets(bots.data.markets, bots.data.fee.builderBps, 14) : []), [bots.data]);
  const volH = useMemo(() => (bots.data ? bots.data.markets.reduce((s, m) => s + (m.volumeUsdH || 0), 0) : null), [bots.data]);
  const [copyRef, copyOn] = useOnScreen<HTMLDivElement>({ once: true, margin: '300px' });
  const [faq, setFaq] = useState<number>(0);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    dropBootShell();
    document.title = 'ValueDesk: bots, copy trading and analytics on SoDEX';
    const s = () => setScrolled(window.scrollY > 12);
    s();
    window.addEventListener('scroll', s, { passive: true });
    return () => window.removeEventListener('scroll', s);
  }, []);

  return (
    <div className="h" data-no-i18n="">
      <div className="h-bg" aria-hidden="true"><div className="h-bg__grid" /><div className="h-bg__beam" /></div>
      {/* The owner's dotted whale, swimming from the hero's right across to the footer as the page scrolls. */}
      <SwimmingWhale from={[1.15, 0.3, -64, 0.9]} to={[-0.2, 0.75, -78, 1.15]} height={560} opacity={0.5} />

      <nav className={cx('h-nav', scrolled && 'is-solid')} aria-label="ValueDesk">
        <a href="/home" className="h-logo"><BrandMark size={22} /><span>ValueDesk</span></a>
        <div className="h-nav__links">
          <a href="#bots">Bots</a><a href="#copy">Copy trading</a><a href="#analytics">Analytics</a><a href="#fees">Fees</a><a href="#faq">FAQ</a>
        </div>
        <a href="/trade" className="h-btn is-light is-sm">Open app<Arrow /></a>
      </nav>

      {/* --------------------------------------------------------------------------------------------- hero */}
      <header className="h-hero">
        <div className="h-hero__t">
          <div className="h-up"><Eyebrow>Live on SoDEX · bots, copy trading, analytics</Eyebrow></div>
          <div className="h-up" style={{ '--d': '80ms' } as CSSProperties}><h1 className="h-h1">The market,<br /><span>on one desk.</span></h1></div>
          <div className="h-up" style={{ '--d': '160ms' } as CSSProperties}>
            <p className="h-sub">Market makers that run around the clock, copies of any Hyperliquid or SoDEX wallet, and the liquidation map to read it all. Every order lands in your own SoDEX account.</p>
          </div>
          <div className="h-up h-cta" style={{ '--d': '240ms' } as CSSProperties}>
            <a href="/bots/new" className="h-btn is-light">Start a bot with {startFromText(live.startFrom)}<Arrow /></a>
            <a href="/copy" className="h-btn is-glass">Copy a trader</a>
          </div>
          <ul className="h-up h-trust" style={{ '--d': '320ms' } as CSSProperties}>
            <li><i />Your funds stay in your SoDEX account</li>
            <li><i />Up and running in 3 signatures</li>
            <li><i />Bot fee from {bp(BOT_FEE_VIP)} <span className="h-dim">(VIP)</span></li>
          </ul>
        </div>
        <ChromeV />
      </header>

      <Tape rows={rows} />

      {/* -------------------------------------------------------------------------------------------- bento */}
      <section className="h-sec" id="bots">
        <Reveal as="header" className="h-head">
          <Eyebrow>What it does</Eyebrow>
          <h2 className="h-h2">Three desks.<br /><span>One SoDEX account.</span></h2>
          <p className="h-lead">Run bots, copy traders and read the market from the same place, with the same wallet, without moving your funds.</p>
        </Reveal>

        <div className="h-bento">
          <Reveal className="h-card is-wide">
            <div className="h-card__t">
              <p className="h-card__k">01 · Bots</p>
              <h3>Market makers that never sleep.</h3>
              <p>Pick a market, a size and a loss limit. The bot rests quotes on both sides of the book on our servers, day and night, and stops at your limits. Close the laptop: it keeps going.</p>
              <a href="/bots/explore" className="h-link">Costs on every market<Arrow /></a>
            </div>
            <BookViz />
          </Reveal>

          <Reveal className="h-card" delay={80}>
            <div className="h-card__t" id="copy" ref={copyRef}>
              <p className="h-card__k">02 · Copy trading</p>
              <h3>Follow any wallet.</h3>
              <p>Hyperliquid or SoDEX, trade for trade, at your size and leverage cap.</p>
            </div>
            <FollowViz />
            <p className="h-card__sub">Top copy scores, last 30 days <span className="h-live">Live</span></p>
            <TopTraders on={copyOn} />
          </Reveal>

          <Reveal className="h-card" delay={0}>
            <div className="h-card__t" id="analytics">
              <p className="h-card__k">03 · Analytics</p>
              <h3>See the liquidations first.</h3>
              <p>Where positions on five venues get liquidated, who traded each candle, ETF flows and the macro calendar.</p>
            </div>
            <HeatViz />
          </Reveal>

          <Reveal className="h-card is-wide is-flip" delay={80}>
            <div className="h-card__t">
              <p className="h-card__k">Set up</p>
              <h3>Three signatures. No deposit.</h3>
              <p>Connect a wallet you use on SoDEX. Sign the terms, the fee and the trading key: one click asks for each in turn. Free signatures, never a transaction.</p>
              <a href="/bots/new" className="h-link">Set up now<Arrow /></a>
            </div>
            <SignViz />
          </Reveal>
        </div>
      </section>

      {/* -------------------------------------------------------------------------------------------- stats */}
      <section className="h-sec h-stats">
        <Reveal as="header" className="h-head">
          <Eyebrow>From the live desk</Eyebrow>
          <h2 className="h-h2">Numbers, read now.<br /><span>Not promised.</span></h2>
          <p className="h-lead">What the desk reads this minute on SoDEX and the venues it indexes. Nothing here is a return.</p>
        </Reveal>
        <div className="h-tiles">
          {[
            { v: <Count to={bots.data ? bots.data.markets.length : null} fmt={(x) => String(Math.round(x))} />, l: 'SoDEX markets a bot can run on' },
            { v: <Count to={volH} fmt={(x) => usdShort(x)} />, l: 'Traded on those markets in the last hour' },
            { v: <Count to={GRID_VENUES.length} fmt={(x) => String(Math.round(x))} />, l: `Venues indexed: ${GRID_VENUES.map((v) => VENUE_LABEL[v]).join(', ')}` },
            { v: <>{bp(BOT_FEE_VIP)}</>, l: 'Lowest bot fee, for VIP' },
          ].map((t, i) => (
            <Reveal key={i} className="h-tile" delay={i * 90}>
              <span className="h-tile__ic"><BrandMark size={18} /></span>
              <b className="h-tile__v">{t.v}</b>
              <span className="h-tile__l">{t.l}</span>
            </Reveal>
          ))}
        </div>
        <div className="h-venues">
          {GRID_VENUES.map((v) => <span key={v}><VenueLogo venue={v} size={18} />{VENUE_LABEL[v]}</span>)}
        </div>
      </section>

      {/* --------------------------------------------------------------------------------------------- fees */}
      <section className="h-sec" id="fees">
        <Reveal as="header" className="h-head is-center">
          <Eyebrow>Fees</Eyebrow>
          <h2 className="h-h2">Pay on what runs.<br /><span>Nothing else.</span></h2>
          <p className="h-lead">No subscription. A fee in basis points on the orders a bot or a copy places, lower as your 14-day volume grows.</p>
        </Reveal>
        <div className="h-fees">
          <Reveal className="h-fee">
            <p className="h-fee__k">Analytics</p>
            <b className="h-fee__v">Free</b>
            <ul><li>Liquidation map, live and history</li><li>Who traded each candle</li><li>Leaderboards and wallet scan</li><li>News, calendar, ETF flows</li></ul>
            <a href="/trade" className="h-btn is-glass is-block">Open the terminal</a>
          </Reveal>
          <Reveal className="h-fee is-hot" delay={90}>
            <p className="h-fee__k">Bots</p>
            <b className="h-fee__v"><small>from </small>{bp(BOT_FEE_VIP)}<small> per order</small></b>
            <p className="h-fee__c"><span className="h-vip">VIP</span> {FEES.vipCondition}</p>
            <ul>
              {BOT_FEE_LADDER.map((s) => <li key={s.fromUsd}>{bp(s.fee)} {s.fromUsd === 0 ? 'for a new wallet' : `from ${usdStep(s.fromUsd)} in 14 days`}</li>)}
              <li>Market maker and grid, start with {startFromText(live.startFrom)}</li>
            </ul>
            <a href="/bots/new" className="h-btn is-dark is-block">Start a bot<Arrow /></a>
          </Reveal>
          <Reveal className="h-fee" delay={180}>
            <p className="h-fee__k">Copy trading</p>
            <b className="h-fee__v"><small>from </small>{bp(FEES.copyLowest)}<small> per order</small></b>
            <p className="h-fee__c">{FEES.copyLowestCondition}</p>
            <ul>
              <li>{bp(FEES.copyNew)} for a new wallet, lower by {COPY_FEE_WINDOW_DAYS}-day volume</li>
              <li>Hyperliquid and SoDEX leaders</li>
              <li>In your browser or hosted</li>
              <li>Your size, your leverage cap</li>
            </ul>
            <a href="/copy" className="h-btn is-glass is-block">Copy a trader</a>
          </Reveal>
        </div>
        <p className="h-note">SoDEX charges its own trading fee on every fill, on top.</p>
      </section>

      {/* ---------------------------------------------------------------------------------------------- faq */}
      <section className="h-sec h-faqsec" id="faq">
        <Reveal as="header" className="h-head">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="h-h2">Questions,<br /><span>answered.</span></h2>
          <p className="h-lead">The rest is in the <a href="/copy-terms">terms and risk disclosure</a>.</p>
        </Reveal>
        <div className="h-faq">
          {FAQ.map((f, i) => (
            <div key={f.q} className={cx('h-faq__i', faq === i && 'is-open')}>
              <button type="button" aria-expanded={faq === i} onClick={() => setFaq(faq === i ? -1 : i)}>
                {f.q}<span className="h-faq__x" aria-hidden="true" />
              </button>
              <div className="h-faq__a"><p>{f.a}</p></div>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------------------------------------- footer */}
      <footer className="h-foot">
        <div className="h-foot__cta">
          <h2 className="h-h2">Put the market<br /><span>on your desk.</span></h2>
          <div className="h-cta">
            <a href="/bots/new" className="h-btn is-light">Start a bot<Arrow /></a>
            <a href="/trade" className="h-btn is-glass">Open the app</a>
          </div>
        </div>
        <div className="h-foot__cols">
          <div><a href="/home" className="h-logo"><BrandMark size={20} /><span>ValueDesk</span></a><p className="h-dim">Bots, copy trading and analytics for SoDEX.</p></div>
          <div><p>Product</p><a href="/bots">Bots</a><a href="/copy">Copy trading</a><a href="/trade">Terminal</a><a href="/leaderboard">Leaderboard</a></div>
          <div><p>Legal</p><a href="/terms">Terms of use</a><a href="/risk">Risk disclosure</a><a href="/privacy">Privacy</a><a href="/copy-terms">Copy and bot terms</a></div>
          <div><p>More</p><a href="/status">Status</a><a href="/licenses">Licences</a></div>
        </div>
        <p className="h-risk">Trading perpetual futures carries a high risk of loss. Bots and copies can lose money, and past results of any trader or market say nothing about future ones.</p>
        <div className="h-word" aria-hidden="true">ValueDesk</div>
      </footer>
    </div>
  );
}
