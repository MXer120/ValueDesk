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

import { useAsync } from '../../hooks';
import { type BoardWindow } from '../../vsApi';


import { VenueLogo } from '../VenueLogo';

import { scoreRows } from '../copy/gridModel';

import { readBoards } from './shared';
import './home.css';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
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
        <path d={d} className="g-follow__lead" />
        <path d={d} className="g-follow__copy" transform="translate(0 6)" />
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

/* --------------------------------------------------------------------------------------------- copy list ----- */

export function TopTraders({ on }: { on: boolean }) {
  const boards = useAsync(() => readBoards('best', 100), [], { enabled: on });
  const top = useMemo(() => scoreRows(boards.data ?? [], BOARD_WINDOW, 'copy').sort((a, b) => b.score.score - a.score.score).slice(0, 3), [boards.data]);
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
