/**
 * Drawings and live consoles for the product pages (owner 2026-11-23 rework). Drawings carry no figures; consoles show
 * only live reads (useLiveDesk rows at the VIP fee over 7 days, the public leaderboards) and fee constants.
 *
 *   LiqMapViz   - looks like the real liquidation map: candles walking over viridis bands of liquidation levels; a band
 *                 the price crosses is taken out (those positions were liquidated), new ones build up over time.
 *   BotConsole  - the Bots hero: BTC's best bot, its all-in cost per $1M, the book it quotes, the limits that are yours.
 *   CopyConsole - the Copy hero: a live top trader, the copy below it, switching between Copy and Counter.
 *   BotSettingsMap - the Bots page: every setting as three questions (when it trades, when it stops, how hard it works).
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { BoardWindow } from '../../../vsApi';
import { BrandMark } from '../../BrandMark';
import { CoinIcon } from '../../CoinIcon';
import { VenueLogo } from '../../VenueLogo';
import { BookViz } from '../Home';
import { FeatureFx } from '../v3/V3';
import { DESK_WINDOW_TEXT, liteDevice, reducedMotion, usdShort, useTopTraders, type MarketRow } from '../shared';

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
      if (!still) raf = requestAnimationFrame(draw);
      // Drawn only when a column came in (it was every frame), never on a hidden tab.
      if (!still && last && t - last < 420) return;
      if (!still && last) pushCol();
      last = t || 1;
      const W = (c.width = c.clientWidth * Math.min(liteDevice() ? 1 : 2, devicePixelRatio || 1));
      const H = (c.height = c.clientHeight * Math.min(liteDevice() ? 1 : 2, devicePixelRatio || 1));
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
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [on, cols]);
  return <div ref={ref} className={cx('vd-lq', className)} aria-hidden="true"><canvas ref={cv} /></div>;
}

/**
 * The map's Live view as the app draws it: the price along the bottom, a bar per price (longs below it, shorts above),
 * and the two running totals stepping away from the price. A drawing, breathing.
 */
export function LiveLiqViz({ className }: { className?: string }) {
  const [ref, on] = useOn<HTMLDivElement>('100px');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!on || reducedMotion()) return;
    const id = window.setInterval(() => setTick((x) => x + 1), liteDevice() ? 2400 : 1000);
    return () => window.clearInterval(id);
  }, [on]);
  const n = 92;
  const mid = 46;
  const v = (i: number) => {
    const d = Math.abs(i - mid);
    if (d < 2) return 0;
    const h = ((i * 7919 + 13) % 97) / 97;
    const wall = i % 17 === 5 ? 0.5 : 0;
    return (0.06 + h ** 2 * 0.36 + wall) * (0.55 + 0.45 * Math.min(1, d / 20)) * (1 + 0.1 * Math.sin(tick * 0.7 + i));
  };
  const bars = Array.from({ length: n }, (_, i) => v(i));
  const X = 900 / n;
  const cum = (dir: -1 | 1) => {
    let s = 0, d = `M${mid * X} 296`;
    for (let i = mid + dir; i >= 0 && i < n; i += dir) { s += bars[i]!; d += `H${((dir > 0 ? i : i + 1) * X).toFixed(1)}V${(296 - Math.min(1, s / 12) * 270).toFixed(1)}`; }
    return d + `H${dir > 0 ? 900 : 0}`;
  };
  return (
    <div ref={ref} className={cx('vd-ll', className)} aria-hidden="true">
      <svg viewBox="0 0 900 300" preserveAspectRatio="none">
        {bars.map((b, i) => <rect key={i} className={i < mid ? 'is-long' : 'is-short'} x={i * X + 1} width={X - 2} y="0" height="296" style={{ transform: `scaleY(${b.toFixed(3)})` }} />)}
        <path className="is-long" d={cum(-1)} /><path className="is-short" d={cum(1)} />
        <line x1={mid * X} x2={mid * X} y1="6" y2="296" />
      </svg>
      <span className="vd-ll__p">price now</span>
      <span className="vd-ll__k is-l">Cumulative longs</span><span className="vd-ll__k is-r">Cumulative shorts</span>
    </div>
  );
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
  const top = useTopTraders(on)[0]?.row ?? null;
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

/* --------------------------------------------------------------------------------------- bot settings ----- */

/** The gates: each one lights the stretch of the drawing where the bot would stand aside. x in 0..600. */
const GATES: Array<{ t: string; s: string; x: [number, number] }> = [
  { t: 'Volatility gate', s: 'Pauses the moment the price moves fast, and comes back when it is calm.', x: [92, 168] },
  { t: 'Flow gate', s: 'Quotes only while enough volume trades.', x: [196, 282] },
  { t: 'News gate', s: 'Pauses around US releases: CPI, jobs and the Fed.', x: [328, 354] },
  { t: 'Trading hours', s: 'Pauses inside or outside the hours you set.', x: [450, 566] },
  // Over the hours' right half: the band moves right and gets slimmer.
  { t: 'Spread limit', s: 'Pauses while the book is too wide.', x: [518, 560] },
];

/** One day of a drawn market: the price, its bid and ask, the volume. Every gate has its reason in it. A drawing. */
const DAY = (() => {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const pts: Array<{ x: number; y: number; w: number; v: number }> = [];
  for (let i = 0; i <= 100; i++) {
    const x = i * 6;
    const spike = x > 92 && x < 168 ? Math.sin(((x - 92) / 76) * Math.PI * 3) * 34 : 0;
    const news = x >= 336 ? -22 * Math.min(1, (x - 336) / 14) : 0;
    const y = 92 + Math.sin(x / 70) * 10 + Math.sin(x / 23) * 4 + (rnd() - 0.5) * 5 + spike + news;
    const w = 4 + (x > 518 && x < 560 ? 19 * Math.sin(((x - 518) / 42) * Math.PI) : 0) + (Math.abs(x - 342) < 12 ? 4 : 0);
    const thin = (x > 196 && x < 282) || (x > 450 && x < 566);
    const v = x > 196 && x < 282 ? 2 + rnd() * 3 : thin ? 5 + rnd() * 5 : 9 + rnd() * 13 + (Math.abs(spike) > 8 ? 12 : 0) + (Math.abs(x - 342) < 14 ? 14 : 0);
    pts.push({ x, y, w, v });
  }
  const line = (f: (p: (typeof pts)[number]) => number) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${f(p).toFixed(1)}`).join('');
  return { pts, mid: line((p) => p.y), bid: line((p) => p.y + p.w), ask: line((p) => p.y - p.w) };
})();

function GateStage() {
  const [ref, on] = useOn<HTMLDivElement>();
  const [at, setAt] = useState(0);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!on || held || reducedMotion()) return;
    const id = window.setInterval(() => setAt((a) => (a + 1) % GATES.length), 2600);
    return () => window.clearInterval(id);
  }, [on, held]);
  const g = GATES[at]!;
  return (
    <div ref={ref} className="vd-st__card is-gates">
      <FeatureFx v={1} />
      <div className="vd-st__top"><h3>When it trades</h3><p>Five gates. Each one takes the bot off the book when the market is wrong for it.</p></div>
      <div className="vd-gt__tabs" role="group" aria-label="Gates" onPointerLeave={() => setHeld(false)}>
        {GATES.map((x, i) => (
          <button key={x.t} type="button" aria-pressed={i === at} className={cx(i === at && 'is-on')} onPointerEnter={(e) => { if (e.pointerType === 'mouse') { setHeld(true); setAt(i); } }} onClick={() => { setHeld(true); setAt(i); }}>{x.t}</button>
        ))}
      </div>
      <div className="vd-gt__plot" aria-hidden="true">
        <svg viewBox="0 0 600 200" preserveAspectRatio="none">
          <rect className="vd-gt__band" x={g.x[0]} y="0" width={g.x[1] - g.x[0]} height="200" />
          {DAY.pts.map((p) => <rect key={p.x} className={cx('vd-gt__vol', p.x >= g.x[0] && p.x <= g.x[1] && 'is-in')} x={p.x - 2} y={198 - p.v} width="3.4" height={p.v} />)}
          <path className="vd-gt__q" d={DAY.ask} /><path className="vd-gt__q" d={DAY.bid} />
          <path className="vd-gt__p" d={DAY.mid} />
          <line className="vd-gt__news" x1="338" x2="338" y1="14" y2="200" />
        </svg>
        <span className="vd-gt__flag" style={{ left: `${(338 / 600) * 100}%` }}>CPI</span>
        <span className="vd-gt__pause" style={{ left: `${((g.x[0] + g.x[1]) / 12)}%` }}>paused</span>
      </div>
      <div className="vd-gt__run" aria-hidden="true">
        <small>Bot</small>
        <div><i style={{ left: `${g.x[0] / 6}%`, width: `${(g.x[1] - g.x[0]) / 6}%` }} /></div>
      </div>
      <p className="vd-gt__say"><b>{g.t}</b>{g.s}</p>
    </div>
  );
}

/** What ends a run: the loss limit with its margin (the bot stops a little before the line, so closing fits in), volume, time. Drawings. */
function StopStage() {
  const rows: Array<[string, string, string]> = [['Loss limit', 'Stops just before it, so closing still fits inside', 'is-neg'], ['Stop after volume', 'Stops once it has traded your amount', 'is-pos'], ['Run for', 'An hour, a day, a week, or until you stop it', '']];
  return (
    <div className="vd-st__card">
      <FeatureFx v={4} />
      <div className="vd-st__top"><h3>When it stops</h3></div>
      <div className="vd-sp">
        {rows.map(([t, sub, tone], i) => (
          <div key={t} className={tone}>
            <p><b>{t}</b><small>{sub}</small></p>
            <div className="vd-sp__bar"><i style={{ '--d': `${i * -1.6}s` } as CSSProperties} />{tone === 'is-neg' && <u />}<em /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** How hard it works: the book around the price, the bot's own orders in it, and what it may hold - per preset. A drawing. */
const EFFORT = [
  { t: 'Steady', s: 'Further from the price, small position', n: 2, far: 2, hold: 0.28, beat: 2.6 },
  { t: 'Balanced', s: 'Closer, a normal position', n: 3, far: 1, hold: 0.52, beat: 1.7 },
  { t: 'Active', s: 'At the price, more volume, more risk', n: 4, far: 0, hold: 0.8, beat: 1 },
] as const;
const LEVELS = 6;
function SizeStage() {
  const [ref, on] = useOn<HTMLDivElement>();
  const [p, setP] = useState(1);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!on || held || reducedMotion()) return;
    const id = window.setInterval(() => setP((x) => (x + 1) % 3), 3000);
    return () => window.clearInterval(id);
  }, [on, held]);
  const e = EFFORT[p]!;
  const level = (side: 'ask' | 'bid', i: number) => {
    const mine = i >= e.far && i < e.far + e.n;
    return <div key={side + i} className={cx('vd-ef__l', side, mine && 'is-mine')} style={{ '--w': 0.34 + ((i * 37 + (side === 'ask' ? 11 : 5)) % 60) / 100, '--i': i } as CSSProperties}><i /><b /></div>;
  };
  return (
    <div ref={ref} className="vd-st__card" data-off={on ? undefined : ''}>
      <FeatureFx v={5} />
      <div className="vd-st__top"><h3>How hard it works</h3></div>
      <div className="vd-ef__tabs" role="group" aria-label="Presets" style={{ '--at': p } as CSSProperties}>
        <i aria-hidden="true" />
        {EFFORT.map((x, i) => <button key={x.t} type="button" aria-pressed={i === p} className={cx(i === p && 'is-on')} onClick={() => { setHeld(true); setP(i); }}>{x.t}</button>)}
      </div>
      <div className="vd-ef" style={{ '--beat': `${e.beat}s`, '--hold': e.hold } as CSSProperties} aria-hidden="true">
        <div className="vd-ef__book">
          {Array.from({ length: LEVELS }, (_, i) => level('ask', LEVELS - 1 - i))}
          <div className="vd-ef__px"><span>price</span></div>
          {Array.from({ length: LEVELS }, (_, i) => level('bid', i))}
        </div>
        <div className="vd-ef__hold"><div><i /></div><small>Max<br />holding</small></div>
      </div>
      <p className="vd-ef__say"><b>{e.t}</b>{e.s}. Order size, holding and leverage stay yours to change.</p>
    </div>
  );
}

/** Every setting of a bot as three questions: when it trades, when it stops, how hard it works. */
export function BotSettingsMap() {
  return <div className="vd-st"><GateStage /><StopStage /><SizeStage /></div>;
}
