/**
 * Drawings and live consoles for the product pages (owner 2026-11-23 rework). Drawings carry no figures; consoles show
 * only live reads (useLiveDesk rows at the VIP fee over 7 days, the public leaderboards) and fee constants.
 *
 *   LiqMapViz   - looks like the real liquidation map: candles walking over viridis bands of liquidation levels; a band
 *                 the price crosses is taken out (those positions were liquidated), new ones build up over time.
 *   BotConsole  - the Bots hero: BTC's best bot, its all-in cost per $1M, the book it quotes, the limits that are yours.
 *   CopyConsole - the Copy hero: a live top trader, the copy below it, switching between Copy and Counter.
 *   FeatureMap  - the Bots page: every setting of a bot around the bot itself, a pulse running out to each in turn.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useAsync } from '../../../hooks';
import { vsApi, type BoardWindow, type TraderRow } from '../../../vsApi';
import { BrandMark } from '../../BrandMark';
import { CoinIcon } from '../../CoinIcon';
import { VenueLogo } from '../../VenueLogo';
import { COPY_VENUES, scoreRows } from '../../copy/gridModel';
import { BookViz } from '../Home';
import { FeatureFx } from '../v3/V3';
import { DESK_WINDOW_TEXT, reducedMotion, usdShort, type MarketRow } from '../shared';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

function useOn<T extends Element>(margin = '0px'): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') { setOn(true); return; }
    const io = new IntersectionObserver(([e]) => setOn(!!e?.isIntersecting), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [margin]);
  return [ref, on];
}

/* ------------------------------------------------------------------------------------------ liq map ----- */

const VIRIDIS = ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'];
const viridis = (k: number) => VIRIDIS[Math.max(0, Math.min(VIRIDIS.length - 1, Math.floor(k * VIRIDIS.length)))]!;

export function LiqMapViz({ className, cols = 72 }: { className?: string; cols?: number }) {
  const [ref, on] = useOn<HTMLDivElement>('100px');
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = cv.current;
    if (!c || !on) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const ROWS = 90;
    // The price path (in rows), a random walk with a little pull to the middle.
    const prices: number[] = [];
    let p = ROWS * 0.5;
    const nextPrice = () => { p += (rnd() - 0.5) * 6.5 + (ROWS * 0.5 - p) * 0.025; p = Math.max(14, Math.min(ROWS - 14, p)); return p; };
    // Liquidation levels: rows with a weight that builds while the price stays away and is cleared when it crosses.
    const levels = new Map<number, number>();
    const seedLevels = () => { for (let i = 0; i < 16; i++) { const r = Math.floor(rnd() * ROWS); if (Math.abs(r - p) > 5) levels.set(r, (levels.get(r) ?? 0) + rnd() ** 3 * 1.1 + 0.08); } };
    seedLevels();
    const grid: Array<Float32Array> = [];
    const pushCol = () => {
      const prev = prices.length ? prices[prices.length - 1]! : p;
      const np = nextPrice();
      prices.push(np);
      const lo = Math.min(prev, np) - 1.2, hi = Math.max(prev, np) + 1.2;
      for (const [r] of levels) if (r >= lo && r <= hi) levels.delete(r); // crossed: liquidated
      if (rnd() < 0.35) { // new positions open; their liquidation levels sit away from the price
        const side = rnd() < 0.5 ? -1 : 1;
        const r = Math.round(np + side * (5 + rnd() * 32));
        if (r > 0 && r < ROWS) levels.set(r, (levels.get(r) ?? 0) + 0.06 + rnd() ** 2 * 0.35);
      }
      for (const [r, w] of levels) levels.set(r, Math.min(1.5, w * 1.01 + 0.002));
      const col = new Float32Array(ROWS);
      for (const [r, w] of levels) for (let d = -1; d <= 1; d++) { const y = r + d; if (y >= 0 && y < ROWS) col[y] = Math.max(col[y]!, w * (d === 0 ? 1 : 0.35)); }
      grid.push(col);
      if (grid.length > cols) { grid.shift(); prices.shift(); }
    };
    for (let i = 0; i < cols; i++) pushCol();
    const still = reducedMotion();
    let raf = 0, last = 0;
    const draw = (t: number) => {
      const W = (c.width = c.clientWidth * Math.min(2, devicePixelRatio || 1));
      const H = (c.height = c.clientHeight * Math.min(2, devicePixelRatio || 1));
      if (!still && t - last > 420) { pushCol(); last = t; }
      const cw = W / cols, rh = H / ROWS;
      ctx.fillStyle = '#0a0612';
      ctx.fillRect(0, 0, W, H);
      grid.forEach((col, x) => {
        for (let y = 0; y < ROWS; y++) {
          const v = col[y]!;
          if (v < 0.05) continue;
          ctx.globalAlpha = Math.min(1, 0.25 + v * 0.75);
          ctx.fillStyle = viridis(Math.min(0.999, Math.pow(v / 1.5, 0.85)));
          ctx.fillRect(x * cw, (ROWS - 1 - y) * rh, cw + 0.6, rh + 0.6);
        }
      });
      ctx.globalAlpha = 1;
      // candles
      for (let x = 1; x < prices.length; x++) {
        const o = prices[x - 1]!, cl = prices[x]!;
        const up = cl >= o;
        const top = Math.max(o, cl) + 0.8, bot = Math.min(o, cl) - 0.8;
        const cxp = x * cw + cw / 2;
        ctx.strokeStyle = up ? 'rgba(46, 220, 160, 0.9)' : 'rgba(255, 98, 98, 0.9)';
        ctx.lineWidth = Math.max(1, cw * 0.08);
        ctx.beginPath(); ctx.moveTo(cxp, (ROWS - top) * rh); ctx.lineTo(cxp, (ROWS - bot) * rh); ctx.stroke();
        ctx.fillStyle = up ? '#2edca0' : '#ff6262';
        const y1 = (ROWS - Math.max(o, cl)) * rh, y2 = (ROWS - Math.min(o, cl)) * rh;
        ctx.fillRect(x * cw + cw * 0.2, y1, cw * 0.6, Math.max(1.5, y2 - y1));
      }
      // the last price
      const lp = prices[prices.length - 1]!;
      ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, (ROWS - lp) * rh); ctx.lineTo(W, (ROWS - lp) * rh); ctx.stroke(); ctx.setLineDash([]);
      if (!still) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [on, cols]);
  return <div ref={ref} className={cx('vd-lq', className)} aria-hidden="true"><canvas ref={cv} /></div>;
}

/* ------------------------------------------------------------------------------------------ console ----- */

function Console({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('vd-con', className)}>
      <FeatureFx v={1} />
      {children}
    </div>
  );
}

function perMillion(b: number | null): ReactNode {
  if (b === null) return '—';
  const usd = `$${Math.round(Math.abs(b) * 100).toLocaleString('en-US')}`;
  return b <= 0 ? <span className="h-pos">+{usd}</span> : usd;
}

/** The Bots hero: BTC (or the busiest market) with its cheapest bot at the VIP fee, the book it quotes, your limits. */
export function BotConsole({ rows }: { rows: MarketRow[] }) {
  const r = rows.find((x) => x.m.base === 'BTC') ?? rows[0] ?? null;
  return (
    <Console className="is-bot">
      <div className="vd-con__head">
        <span className="vd-con__mkt">{r ? <CoinIcon coin={r.m.base} venue="SODEX" size={26} /> : <i className="vd-con__sk" />}<b>{r ? r.m.symbol : 'BTC-USD'}</b></span>
        {r?.recipe && <span className="vd-con__chip">{r.recipe}</span>}
        <span className="vd-con__live"><i />Running · tab closed</span>
      </div>
      <div className="vd-con__big">
        <b>{r ? perMillion(r.bp) : '—'}</b>
        <span>all-in per $1M traded · VIP fee · {DESK_WINDOW_TEXT}</span>
      </div>
      <div className="vd-con__book"><BookViz /></div>
      <div className="vd-con__foot">
        <span><small>Max holding</small>yours</span>
        <span><small>Loss limit</small>yours</span>
        <span><small>Runs on</small>Tokyo executor</span>
      </div>
    </Console>
  );
}

const WIN: BoardWindow = '30d';

/** The Copy hero: the best copy score now, and your copy following it - or countering it. */
export function CopyConsole() {
  const [ref, on] = useOn<HTMLDivElement>('200px');
  const boards = useAsync(
    () => Promise.all(COPY_VENUES.map((venue) => vsApi.leaderboard({ venue, window: WIN, sort: 'pnl', limit: 100 }).then((b) => b.rows, () => [] as TraderRow[]))),
    [],
    { enabled: on, pollMs: 300_000 },
  );
  const top = useMemo(() => scoreRows((boards.data ?? []).flat(), WIN, 'copy').sort((a, b) => b.score.score - a.score.score)[0]?.row ?? null, [boards.data]);
  const [counter, setCounter] = useState(false);
  useEffect(() => {
    if (reducedMotion()) return;
    const id = window.setInterval(() => setCounter((c) => !c), 4200);
    return () => window.clearInterval(id);
  }, []);
  const pnl = top?.pnl[WIN] ?? null;
  return (
    <div ref={ref}>
      <Console className={cx('is-copy', counter && 'is-counter')}>
        <div className="vd-con__head">
          <span className="vd-con__chip">Top copy score · 30 days</span>
          <div className="vd-con__toggle" role="presentation"><span className={cx(!counter && 'is-on')}>Copy</span><span className={cx(counter && 'is-on')}>Counter</span></div>
        </div>
        <div className="vd-cp__leader">
          {top ? <VenueLogo venue={top.venue} size={22} /> : <i className="vd-con__sk" />}
          <div><b>{top ? top.label || `${top.address.slice(0, 6)}…${top.address.slice(-4)}` : 'Loading the board…'}</b><small>Leader · {top ? (top.venue === 'hyperliquid' ? 'Hyperliquid' : 'SoDEX') : ''}</small></div>
          <span className={cx('vd-cp__pnl', pnl !== null && pnl >= 0 && 'h-pos')}>{pnl === null ? '' : `${pnl >= 0 ? '+' : '−'}${usdShort(Math.abs(pnl))}`}</span>
        </div>
        <div className="vd-cp__wire" aria-hidden="true"><i /><i /><i /></div>
        <div className="vd-cp__you">
          <span className="vd-cp__me"><BrandMark size={16} /></span>
          <div><b>You, on SoDEX</b><small>{counter ? 'The opposite trade, at your size' : 'The same trade, at your size'}</small></div>
        </div>
        <svg className="vd-cp__lines" viewBox="0 0 320 90" preserveAspectRatio="none" aria-hidden="true">
          <path className="is-lead" d="M0 70 C40 66 60 40 100 46 S160 72 200 54 S260 18 320 14" />
          <path className="is-copy" d="M0 76 C40 72 60 46 100 52 S160 78 200 60 S260 24 320 20" />
          <path className="is-counter" d="M0 20 C40 24 60 50 100 44 S160 18 200 36 S260 72 320 76" />
        </svg>
        <div className="vd-con__foot"><span><small>Size</small>yours</span><span><small>Leverage cap</small>yours</span><span><small>Runs</small>browser or hosted</span></div>
      </Console>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ feature map ----- */

const I = {
  pulse: <svg viewBox="0 0 24 24"><path d="M3 12h4l2-5 4 10 2-5h6" /></svg>,
  flow: <svg viewBox="0 0 24 24"><path d="M4 8h12l-3-3M20 16H8l3 3" /></svg>,
  clock: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></svg>,
  news: <svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M8 9h8M8 13h8M8 17h5" /></svg>,
  stop: <svg viewBox="0 0 24 24"><path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" /><path d="M9 12h6" /></svg>,
  box: <svg viewBox="0 0 24 24"><path d="M4 8l8-4 8 4v8l-8 4-8-4z" /><path d="M4 8l8 4 8-4M12 12v8" /></svg>,
  timer: <svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="7" /><path d="M12 13V9M9 3h6" /></svg>,
  lev: <svg viewBox="0 0 24 24"><path d="M4 18 18 6M14 6h4v4" /></svg>,
  sliders: <svg viewBox="0 0 24 24"><path d="M5 6h14M5 12h14M5 18h14" /><circle cx="9" cy="6" r="1.8" /><circle cx="15" cy="12" r="1.8" /><circle cx="11" cy="18" r="1.8" /></svg>,
  swap: <svg viewBox="0 0 24 24"><path d="M7 4v16M17 4v16M4 8l3-4 3 4M14 16l3 4 3-4" /></svg>,
};

const FEATURES: Array<{ ic: ReactNode; t: string; s: string }> = [
  { ic: I.pulse, t: 'Volatility gate', s: 'Pauses the moment the price moves fast' },
  { ic: I.flow, t: 'Flow gate', s: 'Quotes only while enough flow trades' },
  { ic: I.clock, t: 'Trading hours', s: 'Pause inside or outside your hours' },
  { ic: I.news, t: 'News gate', s: 'Pauses around CPI, jobs and the Fed' },
  { ic: I.stop, t: 'Loss limit', s: 'Stops at the loss you set' },
  { ic: I.box, t: 'Max holding', s: 'Caps the position it may build' },
  { ic: I.timer, t: 'Run for', s: 'An hour, a day, a week or until stopped' },
  { ic: I.lev, t: 'Leverage', s: "Yours, up to the market's maximum" },
  { ic: I.sliders, t: 'Presets', s: 'Steady, Balanced or Active' },
  { ic: I.swap, t: 'Perps and spot', s: 'Market maker and grid on both' },
  { ic: <svg viewBox="0 0 24 24"><path d="M4 9h16M4 15h16" /><path d="M9 5v4M15 15v4" /></svg>, t: 'Spread limit', s: 'Pauses while the book is too wide' },
  { ic: <svg viewBox="0 0 24 24"><path d="M4 19h16M6 15l4-4 3 3 5-6" /></svg>, t: 'Stop after volume', s: 'Stops once it has traded your amount' },
];

/** Every setting around the bot: tiles on a ring, a pulse running from the bot to each in turn. */
export function FeatureMap() {
  const [ref, on] = useOn<HTMLDivElement>();
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (!on || reducedMotion()) return;
    const id = window.setInterval(() => setAt((a) => (a + 1) % FEATURES.length), 1100);
    return () => window.clearInterval(id);
  }, [on]);
  // Grid: 4 columns x 4 rows, the bot in the middle 2 x 2; ten tiles on the ring around it.
  const slots: Array<[number, number]> = [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [3, 2], [3, 3], [2, 3], [1, 3], [0, 3]];
  const left: Array<[number, number]> = [[0, 2], [0, 1]];
  const all = [...slots, ...left];
  return (
    <div ref={ref} className="vd-fm">
      <svg className="vd-fm__lines" viewBox="0 0 400 400" preserveAspectRatio="none" aria-hidden="true">
        {FEATURES.map((_, i) => {
          const [c, r] = all[i]!;
          return <line key={i} x1="200" y1="200" x2={(c + 0.5) * 100} y2={(r + 0.5) * 100} className={cx(i === at && 'is-on')} />;
        })}
      </svg>
      <div className="vd-fm__core" aria-hidden="true">
        <span className="vd-fm__ring" /><span className="vd-fm__ring is-2" />
        <span className="vd-fm__mark"><BrandMark size={34} /></span>
        <b>Your bot</b>
        <small>Runs on the executor in Tokyo</small>
      </div>
      {FEATURES.map((f, i) => {
        const [c, r] = all[i]!;
        return (
          <div key={f.t} className={cx('vd-fm__tile', i === at && 'is-on')} style={{ gridColumn: c + 1, gridRow: r + 1 } as CSSProperties}>
            <span className="vd-fm__ic">{f.ic}</span>
            <b>{f.t}</b>
            <small>{f.s}</small>
          </div>
        );
      })}
    </div>
  );
}
