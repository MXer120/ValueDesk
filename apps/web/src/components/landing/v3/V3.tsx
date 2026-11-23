/**
 * Landing version 3 (/home/3), owner 2026-11-23: "One desk, everything connected". Product first: the hero IS the
 * desk, a tilted glass mockup assembled from the real parts (a bot card with the live cheapest busy market, a copy
 * card, a liquidation heat panel), then one job per feature card, the funds diagram, the three signatures, the fees
 * (lowest only with its condition), the FAQ and the risk line.
 *
 * Nothing on it is made up (shared.tsx header): every figure comes from useLiveDesk(), the fee constants, or the
 * venue list. The illustrations are drawings and carry no figures. The speed gauge shows a number only if a public
 * latency read answers (GET /api/vs/bots/latency); otherwise it is a drawing without one.
 *
 * Motion: reveals on scroll, loops paused off screen ([data-off]), all of it off for prefers-reduced-motion.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { BrandMark } from '../../BrandMark';
import { CoinIcon } from '../../CoinIcon';
import { VenueLogo } from '../../VenueLogo';
import { GRID_VENUES, COPY_VENUES } from '../../copy/gridModel';
import { VENUE_LABEL } from '../../../vsApi';
import { dropBootShell } from '../../../bootShell';
import type { BotLatencyResponse } from '../../../bots/data';
import { FEES, bp, usdStep, usdShort, useLiveDesk, startFromText, reducedMotion, SwimmingWhale, DESK_WINDOW_TEXT, type MarketRow } from '../shared';
import './v3.css';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
const listOf = (xs: readonly string[], conj = 'and'): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${conj} ${xs[xs.length - 1]}`);

/* ------------------------------------------------------------------------------------------------ hooks ----- */

/** On screen now (follows), or from the first time it comes near (`once`). */
function useOnScreen<T extends Element>(o: { once?: boolean; margin?: string } = {}): [React.RefObject<T>, boolean] {
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

function Reveal({ children, className, delay = 0, as: As = 'div', id }: { children: ReactNode; className?: string; delay?: number; as?: 'div' | 'section' | 'header' | 'article'; id?: string }) {
  const [ref, on] = useOnScreen<HTMLDivElement>({ once: true, margin: '0px 0px -10% 0px' });
  return <As ref={ref as never} id={id} className={cx('v3-rv', on && 'is-in', className)} style={{ '--d': `${delay}ms` } as CSSProperties}>{children}</As>;
}

/** A loop that runs only on screen: its subtree's animations pause under [data-off]. */
function Live({ children, className }: { children: ReactNode; className?: string }) {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  return <div ref={ref} className={className} data-off={on ? undefined : ''} aria-hidden="true">{children}</div>;
}

function Count({ to, fmt }: { to: number | null; fmt: (v: number) => string }) {
  const [ref, on] = useOnScreen<HTMLSpanElement>({ once: true });
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!on || to === null) return;
    if (reducedMotion()) { setV(to); return; }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 1300);
      setV(to * (1 - Math.pow(1 - k, 4)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on, to]);
  return <span ref={ref}>{to === null ? '—' : fmt(v)}</span>;
}

/**
 * A public latency read, if the server has one (GET /api/vs/bots/latency). Today the only latency read is the
 * wallet's own (/api/copy/v1, with its session), so this usually answers 404 and the gauge stays a drawing.
 */
const PUBLIC_LATENCY = false;
function usePublicLatency(enabled: boolean): { p50: number; label: string } | null {
  const [v, setV] = useState<{ p50: number; label: string } | null>(null);
  useEffect(() => {
    // No public latency read exists yet (the route answers 404): ask nothing until one does, so no failed request
    // shows on every load. Flip PUBLIC_LATENCY when the server serves it.
    if (!enabled || !PUBLIC_LATENCY) return;
    let alive = true;
    fetch('/api/vs/bots/latency?hours=1', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
      .then((b) => {
        const x = b as BotLatencyResponse | null;
        const reg = x && Array.isArray(x.regions) ? x.regions.find((r) => typeof r?.now?.p50 === 'number' && (r.now.p50 ?? 0) > 0) : undefined;
        if (alive && reg && reg.now.p50 !== null) setV({ p50: reg.now.p50, label: reg.label || reg.where || reg.id });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [enabled]);
  return v;
}

/* ------------------------------------------------------------------------------------------------ bits ----- */

function Arrow() {
  return <svg className="v3-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" /></svg>;
}
function Check() {
  return <svg className="v3-check" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10.4 3.2 3.1L15 6.7" /></svg>;
}
function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="v3-eyebrow"><span className="v3-eyebrow__dot" />{children}</p>;
}

/** "$123 per $1M" from a cost in bp (negative = earned). */
function perMillion(b: number): { text: string; earned: boolean } {
  return { text: `$${Math.round(Math.abs(b) * 100).toLocaleString('en-US')}`, earned: b < 0 };
}

const HEAT = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'];

/** Liquidation heat drifting behind ribbed glass. A drawing: no figures. */
export function HeatField({ className }: { className?: string }) {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = cv.current;
    if (!c || !on) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const W = (c.width = 320);
    const H = (c.height = 260);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const bands = Array.from({ length: 30 }, (_, i) => ({ y: (i / 30) * H, h: 3 + rnd() * 8, k: rnd() ** 2.3, ph: rnd() * 6.28, sp: 0.2 + rnd() * 0.6 }));
    const still = reducedMotion();
    let raf = 0;
    const draw = (t: number) => {
      ctx.fillStyle = '#0d0420';
      ctx.fillRect(0, 0, W, H);
      for (const b of bands) {
        const k = Math.min(0.999, b.k * (0.75 + 0.25 * Math.sin((t / 1000) * b.sp + b.ph)));
        const ci = Math.min(HEAT.length - 1, Math.floor(k * HEAT.length));
        const g = ctx.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0, HEAT[Math.max(0, ci - 1)]!);
        g.addColorStop(0.5 + 0.3 * Math.sin(t / 2600 + b.ph), HEAT[ci]!);
        g.addColorStop(1, HEAT[Math.max(0, ci - 1)]!);
        ctx.globalAlpha = 0.45 + k * 0.55;
        ctx.fillStyle = g;
        ctx.fillRect(0, b.y + 2 * Math.sin(t / 1800 + b.ph), W, b.h);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 5) {
        const y = H * 0.5 + Math.sin(x / 38 + t / 1500) * 16 + Math.sin(x / 11 + t / 800) * 4;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (!still) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [on]);
  return (
    <div ref={ref} className={cx('v3-heat', className)} aria-hidden="true">
      <canvas ref={cv} />
      <div className="v3-heat__ribs" />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------- hero ----- */

/** The busy market where a market maker costs least now (rows = the busiest, each at the VIP fee). */
function cheapestOf(rows: MarketRow[]): MarketRow | null {
  let best: MarketRow | null = null;
  for (const r of rows) if (r.bp !== null && (!best || r.bp < (best.bp as number))) best = r;
  return best;
}

export function BotPanel({ rows, loading, error }: { rows: MarketRow[]; loading: boolean; error: string | null }) {
  const best = cheapestOf(rows);
  const pm = best && best.bp !== null ? perMillion(best.bp) : null;
  return (
    <div className="v3-card v3-bot">
      <div className="v3-card__top">
        <span className="v3-chip"><span className="v3-dot is-on" />Market maker</span>
        <span className="v3-livetag">Live</span>
      </div>
      {best && pm ? (
        <>
          <div className="v3-bot__mkt">
            <CoinIcon coin={best.m.base} size={30} />
            <div><b>{best.m.base}</b><span>{usdShort(best.m.volumeUsdH)} traded / h</span></div>
            {best.recipe && <span className="v3-chip is-sm">{best.recipe}</span>}
          </div>
          <div className="v3-bot__cost">
            <b className={cx(pm.earned && 'is-pos')}>{pm.earned ? '+' : ''}{pm.text}</b>
            <span>{pm.earned ? 'est. earned' : 'est. cost'} per $1M traded</span>
          </div>
        </>
      ) : (
        <div className="v3-bot__skel">{error ? <span>Live figures are not available right now.</span> : loading ? <><i /><i /><i /></> : <span>No market read yet.</span>}</div>
      )}
      <div className="v3-bot__book">
        {[0.5, 0.8, 0.35, 0.95, 0.6, 0.4, 0.75, 0.55, 0.9, 0.3].map((w, i) => <span key={i} className={i < 5 ? 'is-ask' : 'is-bid'} style={{ '--w': w, '--i': i } as CSSProperties} />)}
      </div>
      <p className="v3-bot__note">Lowest market maker cost of the {rows.length || 'busiest'} busiest SoDEX markets over {DESK_WINDOW_TEXT}, at the VIP fee.</p>
    </div>
  );
}

export function CopyPanel() {
  const d = 'M0 92 C30 86 48 52 80 58 S130 92 160 74 S210 22 240 34 S290 52 320 16';
  return (
    <div className="v3-card v3-copy">
      <div className="v3-card__top">
        <span className="v3-chip"><VenueLogo venue="hyperliquid" size={14} />Copy a wallet</span>
        <span className="v3-dot is-on" />
      </div>
      <svg viewBox="0 0 320 110" preserveAspectRatio="none" className="v3-copy__svg">
        <defs><linearGradient id="v3cf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#00b481" stopOpacity="0.3" /><stop offset="1" stopColor="#00b481" stopOpacity="0" /></linearGradient></defs>
        <path d={`${d} L320 110 L0 110 Z`} fill="url(#v3cf)" />
        <path d={d} className="v3-copy__lead" pathLength={1} />
        <path d={d} className="v3-copy__mine" pathLength={1} transform="translate(0 7)" />
      </svg>
      <div className="v3-copy__keys"><span><i className="is-lead" />Leader</span><span><i className="is-mine" />Your copy</span></div>
      <div className="v3-copy__opts"><span>Your size</span><span>Leverage cap</span><span>Hosted</span></div>
    </div>
  );
}

/** The desk: the product's parts on a tilted glass slab, assembling on load and leaning toward the pointer. */
export function Desk({ live }: { live: ReturnType<typeof useLiveDesk> }) {
  const box = useRef<HTMLDivElement>(null);
  const rig = useRef<HTMLDivElement>(null);
  const [ref, on] = useOnScreen<HTMLDivElement>();
  useEffect(() => {
    const b = box.current;
    const r = rig.current;
    if (!b || !r) return;
    const fit = () => {
      const s = Math.min(1, b.clientWidth / r.offsetWidth);
      b.style.setProperty('--s', s.toFixed(4));
      b.style.height = `${Math.round(r.offsetHeight * s)}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(b);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const b = box.current;
    if (!b || reducedMotion() || !on) return;
    let raf = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        b.style.setProperty('--mx', (e.clientX / window.innerWidth - 0.5).toFixed(3));
        b.style.setProperty('--my', (e.clientY / window.innerHeight - 0.5).toFixed(3));
      });
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => { window.removeEventListener('pointermove', move); cancelAnimationFrame(raf); };
  }, [on]);
  return (
    <div ref={ref} className="v3-deskwrap" data-off={on ? undefined : ''}>
      <div ref={box} className="v3-desk">
        <div ref={rig} className="v3-rig"><div className="v3-tilt">
          <div className="v3-slab" aria-hidden="true"><div className="v3-slab__grid" /><div className="v3-slab__shine" /></div>
          <div className="v3-pn is-heat" style={{ '--z': 40, '--k': 0.6 } as CSSProperties}>
            <div className="v3-pn__in" style={{ '--i': 0 } as CSSProperties}>
              <div className="v3-card v3-heatcard" aria-hidden="true">
                <div className="v3-card__top"><span className="v3-chip">Liquidation map</span><span className="v3-chip is-sm">Free</span></div>
                <HeatField />
              </div>
            </div>
          </div>
          <div className="v3-pn is-copy" style={{ '--z': 70, '--k': 0.9 } as CSSProperties}>
            <div className="v3-pn__in" style={{ '--i': 2 } as CSSProperties}><CopyPanel /></div>
          </div>
          <div className="v3-pn is-bot" style={{ '--z': 120, '--k': 1.3 } as CSSProperties}>
            <div className="v3-pn__in" style={{ '--i': 1 } as CSSProperties}><BotPanel rows={live.rows} loading={live.loading} error={live.error} /></div>
          </div>
          <div className="v3-pn is-mark" style={{ '--z': 180, '--k': 1.8 } as CSSProperties} aria-hidden="true">
            <div className="v3-pn__in" style={{ '--i': 3 } as CSSProperties}><div className="v3-marktile"><BrandMark size={34} /></div></div>
          </div>
          <div className="v3-pn is-sign" style={{ '--z': 150, '--k': 1.6 } as CSSProperties} aria-hidden="true">
            <div className="v3-pn__in" style={{ '--i': 4 } as CSSProperties}>
              <div className="v3-signchip">{['Terms', 'Fee', 'Key'].map((t, i) => <span key={t} style={{ '--i': i } as CSSProperties}><Check />{t}</span>)}</div>
            </div>
          </div>
        </div></div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------------------- feature cards ----- */

export function PickerViz({ rows }: { rows: MarketRow[] }) {
  const items = rows.slice(0, 4);
  return (
    <Live className="v3-viz v3-picker">
      <div className="v3-picker__plate">
        <div className="v3-picker__btn">
          {items[0] ? <CoinIcon coin={items[0].m.base} size={16} /> : <i className="v3-sk-dot" />}
          <span>Market</span>
          <svg viewBox="0 0 12 12"><path d="M3 4.5 6 7.5 9 4.5" /></svg>
        </div>
        <ul className="v3-picker__list">
          {(items.length ? items : [null, null, null, null]).map((r, i) => (
            <li key={r ? r.m.symbol : i}>
              {r ? <><CoinIcon coin={r.m.base} size={18} /><b>{r.m.base}</b><span>{usdShort(r.m.volumeUsdH)}/h</span></> : <><i className="v3-sk-dot" /><i className="v3-sk-bar" /></>}
            </li>
          ))}
          <span className="v3-picker__hi" />
        </ul>
        <svg className="v3-picker__cur" viewBox="0 0 24 24"><path d="M4 3 20 11l-7 2-3 7Z" /></svg>
      </div>
    </Live>
  );
}

export function SleepViz() {
  return (
    <Live className="v3-viz v3-sleep">
      <div className="v3-sleep__ring">
        {Array.from({ length: 24 }, (_, i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}
        <span className="v3-sleep__orb" />
        <div className="v3-sleep__c">
          <svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>
        </div>
      </div>
      <div className="v3-sleep__card">
        <div><span className="v3-dot is-on" /><b>Bot running</b><span className="v3-chip is-sm">Tab closed</span></div>
        <div className="v3-sleep__bar"><i /></div>
      </div>
    </Live>
  );
}

export function GaugeViz({ latency }: { latency: { p50: number; label: string } | null }) {
  // A real p50 points the needle on a 0..1000 ms scale (log-ish); without one the needle only idles.
  const angle = latency ? -90 + 180 * Math.min(1, Math.log10(1 + latency.p50) / 3) : null;
  return (
    <Live className={cx('v3-viz v3-gauge', angle !== null && 'is-real')}>
      <div className="v3-gauge__dial">
        {/* Zones by where the needle points (owner 2026-11-23): left fast (green), middle amber, right slow (red). */}
        {Array.from({ length: 26 }, (_, i) => <i key={i} className={i < 11 ? 'is-fast' : i < 17 ? 'is-mid' : 'is-slow'} style={{ '--a': `${-90 + (i * 180) / 25}deg`, '--i': i } as CSSProperties} />)}
        <div className="v3-gauge__arc" />
        <div className="v3-gauge__needle" style={angle !== null ? ({ '--to': `${angle}deg` } as CSSProperties) : undefined} />
        <div className="v3-gauge__hub" />
      </div>
      <span className="v3-gauge__tag"><i className="v3-gauge__dot" />{latency ? `${Math.round(latency.p50)} ms p50 · ${latency.label}` : 'Executor in Tokyo'}</span>
    </Live>
  );
}

export function HubViz() {
  const n = GRID_VENUES.length;
  // Nodes on an ellipse around the centre (percent of the box).
  const pts = GRID_VENUES.map((v, i) => {
    const a = (-90 + (360 / n) * i) * (Math.PI / 180);
    return { v, x: 50 + Math.cos(a) * 36, y: 50 + Math.sin(a) * 38 };
  });
  return (
    <Live className="v3-viz v3-hub">
      <svg className="v3-hub__lines" viewBox="0 0 100 100" preserveAspectRatio="none">
        {pts.map((p) => <line key={p.v} x1="50" y1="50" x2={p.x} y2={p.y} className="v3-hub__base" />)}
        {pts.map((p, i) => <line key={`f${p.v}`} x1={p.x} y1={p.y} x2="50" y2="50" className="v3-hub__flow" pathLength={1} style={{ '--i': i } as CSSProperties} />)}
      </svg>
      <div className="v3-hub__core"><span className="v3-hub__ring" /><span className="v3-hub__ring is-2" /><div className="v3-hub__mark"><BrandMark size={40} /></div></div>
      {pts.map((p, i) => (
        <span key={p.v} className="v3-hub__node" style={{ left: `${p.x}%`, top: `${p.y}%`, '--i': i } as CSSProperties}>
          <VenueLogo venue={p.v} size={22} />
        </span>
      ))}
    </Live>
  );
}

export function FollowViz() {
  return (
    <Live className="v3-viz v3-follow">
      <div className="v3-follow__card is-lead">
        <VenueLogo venue="hyperliquid" size={18} /><b>Leader</b><span className="v3-chip is-sm">Opens long</span>
      </div>
      <div className="v3-follow__wire"><i /></div>
      <div className="v3-follow__card is-mine">
        <VenueLogo venue="sodex" size={18} /><b>You</b><span className="v3-chip is-sm is-g">Same trade, your size</span>
      </div>
    </Live>
  );
}

/* --------------------------------------------------------------------------------------------- the page ----- */

// The whale enters from the right as the fees come up and crosses behind the FAQ (fractions of the screen).
const WHALE_FROM: [number, number, number, number] = [1.7, 0.18, -62, 0.95];
const WHALE_TO: [number, number, number, number] = [0.3, 0.42, -78, 1.1];

const FAQ: Array<{ q: string; a: ReactNode }> = [
  { q: 'Do I deposit anything with ValueDesk?', a: 'No. Your funds stay in your own SoDEX account. Bots and copies place orders there with a trading key you register on SoDEX; that key can move funds only between your own SoDEX accounts and your wallet, never to anyone else.' },
  { q: 'What does it cost?', a: `The analytics are free. Bot orders pay ${bp(FEES.botNew)} of their value for a new wallet, down to ${bp(FEES.botLadder[FEES.botLadder.length - 1]!.fee)} by your ${FEES.windowDays}-day volume, and ${bp(FEES.botLowest)} for VIP (${FEES.vipCondition}). Copied orders pay ${bp(FEES.copyNew)}, down to ${bp(FEES.copyLowest)} ${FEES.copyLowestCondition}. SoDEX charges its own trading fee on top.` },
  { q: 'Can I stop at any time?', a: 'Yes. Stop a bot or a copy in the app, and revoke the trading key and the fee approval on SoDEX whenever you like. The key also ends on its own after the days you chose, at most 180.' },
  { q: 'Do bots keep running when I close the tab?', a: "Yes. Bots and hosted copies run on ValueDesk's executor in Tokyo around the clock. Browser copies run while their tab is open." },
  { q: 'How long does setting up take?', a: 'Connect a wallet you use on SoDEX and sign three times: the terms, the fee and the trading key. One click asks your wallet for each. Signatures are free; none is a transaction.' },
  { q: 'Where is it available?', a: 'Not in the United States, the United Kingdom, Canada or sanctioned countries. The terms list every place it is not offered.' },
  { q: 'What is the minimum?', a: "$5 is enough to start a market maker on the busiest markets. SoDEX's own minimum order applies." },
];

/**
 * The feature cards' ground (owner 2026-11-23, after a reference: "particles - move slowly but subtle, subtle slightly
 * directional glares, some have a glare on the side and some a dotted bg in the glare"): each card its own - a corner,
 * a side or a top glare, a dotted field lit by it on some, and a few dust particles drifting one way. Decorative only.
 */
const FX_DUST = Array.from({ length: 9 }, (_, i) => {
  const r = (k: number) => { const x = Math.sin(i * 91.7 + k * 47.3) * 43758.5453; return x - Math.floor(x); };
  return { x: r(1) * 100, y: r(2) * 100, s: 1 + r(3) * 1.6, d: 22 + r(4) * 26, o: -r(5) * 40, a: 0.2 + r(6) * 0.45 };
});
export function FeatureFx({ v }: { v: number }) {
  return (
    <span className={`v3-fx is-${v}`} aria-hidden="true">
      <span className="v3-fx__dots" />
      {FX_DUST.map((p, i) => <i key={i} style={{ left: `${p.x}%`, top: `${p.y}%`, width: p.s, height: p.s, '--dur': `${p.d}s`, '--del': `${p.o}s`, '--a': p.a } as CSSProperties} />)}
    </span>
  );
}

/* ------------------------------------------------------------------- sections other pages reuse (site/) ----- */

/** The feature cards (owner 2026-11-23: "very very good"): one job per card, live where a figure shows. */
export function V3Features({ live }: { live: ReturnType<typeof useLiveDesk> }) {
  const [gaugeRef, gaugeNear] = useOnScreen<HTMLDivElement>({ once: true, margin: '400px' });
  const latency = usePublicLatency(gaugeNear);
  const venueNames = useMemo(() => GRID_VENUES.map((v) => VENUE_LABEL[v]), []);
  const copyNames = useMemo(() => COPY_VENUES.map((v) => VENUE_LABEL[v]), []);
  return (
    <>
    {/* ------------------------------------------------------------------------------------------ features */}
    <section className="v3-sec" id="features">
      <Reveal as="header" className="v3-head">
        <Eyebrow>Features</Eyebrow>
        <h2 className="v3-h2">Every part has one job.<br /><span>Making your trading run.</span></h2>
      </Reveal>
      <div className="v3-grid">
        <Reveal as="article" className="v3-feat">
          <FeatureFx v={1} />
          <PickerViz rows={live.rows} />
          <h3>Built around your market</h3>
          <p>Pick any of the {live.marketCount ?? ''} SoDEX markets a bot can run on. Each shows its volume and what a market maker costs there, read live.</p>
        </Reveal>
        <Reveal as="article" className="v3-feat" delay={80}>
          <FeatureFx v={2} />
          <SleepViz />
          <h3>Runs while you sleep</h3>
          <p>Bots and hosted copies run on ValueDesk's executor in Tokyo, day and night. Close the laptop; they stop at your limits or when you stop them.</p>
        </Reveal>
        <Reveal as="article" className="v3-feat" delay={160}>
          <FeatureFx v={3} />
          <FollowViz />
          <h3>Follow any trader</h3>
          <p>Copy any {listOf(copyNames, 'or')} wallet trade for trade, at your size and under your leverage cap. In your browser or hosted.</p>
        </Reveal>
        <Reveal as="article" className="v3-feat is-wide" delay={0}>
          <FeatureFx v={4} />
          <div ref={gaugeRef}><GaugeViz latency={latency} /></div>
          <h3>Speed you can see</h3>
          <p>{latency
            ? <>Signed orders reach SoDEX's answer in {Math.round(latency.p50)} ms at the median (p50, {latency.label}), read live. Your own bots' times are on the Bots page.</>
            : <>Bots sign and send from the executor in Tokyo. The Bots page shows how long your own bots' orders take to SoDEX's answer, measured on every order.</>}</p>
        </Reveal>
        <Reveal as="article" className="v3-feat is-wide" delay={80}>
          <FeatureFx v={5} />
          <HubViz />
          <h3>Everything connected</h3>
          <p>Bots trade SoDEX, copies follow {listOf(copyNames)}, and the analytics read liquidations and flows from {listOf(venueNames)}. One wallet, one desk.</p>
        </Reveal>
      </div>
    </section>
    </>
  );
}

/** "Your funds stay yours": the key path and the four facts. */
export function V3Safety() {
  return (
    <>
    {/* -------------------------------------------------------------------------------------------- safety */}
    <section className="v3-sec" id="safety">
      <Reveal as="header" className="v3-head is-center">
        <Eyebrow>Your funds</Eyebrow>
        <h2 className="v3-h2">Your funds stay yours.</h2>
        <p className="v3-lead">ValueDesk never holds your money. A trading key you register on SoDEX places the orders.</p>
      </Reveal>
      <Reveal className="v3-safe">
        <Live className="v3-flow">
          <div className="v3-node"><span className="v3-node__ic"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="3" /><path d="M16 12.5h2M3 9h15" /></svg></span><b>Your wallet</b><span>signs</span></div>
          <div className="v3-wire"><i /></div>
          <div className="v3-node"><span className="v3-node__ic"><svg viewBox="0 0 24 24"><circle cx="8" cy="12" r="4" /><path d="M12 12h9M18 12v3M21 12v2" /></svg></span><b>Trading key</b><span>at most 180 days</span></div>
          <div className="v3-wire"><i /></div>
          <div className="v3-node is-shield"><span className="v3-node__ic"><svg viewBox="0 0 24 24"><path d="M12 3 5 6v5.5c0 4.4 3 7.9 7 9.5 4-1.6 7-5.1 7-9.5V6Z" /><path d="m9 12 2.2 2.2L15.5 10" /></svg></span><b>Your SoDEX account</b><span>funds stay here</span></div>
          <div className="v3-wire"><i /></div>
          <div className="v3-node__pair">
            <div className="v3-node is-sm"><span className="v3-node__ic"><BrandMark size={18} /></span><b>Bots</b></div>
            <div className="v3-node is-sm"><span className="v3-node__ic"><svg viewBox="0 0 24 24"><path d="M4 16c3-6 5-8 8-4s5 2 8-4" /><path d="M4 19c3-6 5-8 8-4s5 2 8-4" opacity=".45" /></svg></span><b>Copies</b></div>
          </div>
        </Live>
        <ul className="v3-facts">
          <li><Check /><span>Your funds stay in your own SoDEX account. Nothing is deposited with ValueDesk.</span></li>
          <li><Check /><span>The trading key trades, and can move funds only between your own SoDEX accounts and your wallet. Never to anyone else.</span></li>
          <li><Check /><span>Revoke the key on SoDEX at any time.</span></li>
          <li><Check /><span>The key ends on its own after the days you choose, at most 180.</span></li>
        </ul>
      </Reveal>
    </section>
    </>
  );
}

/** "Up and running in three signatures": the three tiles and the CTA. */
export function V3SignTiles() {
  return (
    <>
    {/* ----------------------------------------------------------------------------------------- signatures */}
    <section className="v3-sec v3-signsec">
      <Reveal as="header" className="v3-head is-center">
        <Eyebrow>Set up</Eyebrow>
        <h2 className="v3-h2">Up and running<br /><span>in three signatures.</span></h2>
        <p className="v3-lead">Connect a wallet you use on SoDEX. One click asks your wallet for each; free, no transaction.</p>
      </Reveal>
      <Live className="v3-tiles">
        {[
          { t: 'Terms', s: 'Accept the terms of use' },
          { t: 'Fee', s: "Approve ValueDesk's fee on SoDEX" },
          { t: 'Key', s: 'Register the trading key' },
        ].map((x, i) => (
          <div key={x.t} className="v3-tile" style={{ '--i': i } as CSSProperties}>
            <div className="v3-tile__in">
              <span className="v3-tile__n">{i + 1}</span>
              <span className="v3-tile__ok"><Check /></span>
              <b>{x.t}</b>
              <span>{x.s}</span>
              <em>Free signature</em>
            </div>
          </div>
        ))}
      </Live>
      <div className="v3-cta is-center"><a href="/bots/new" className="v3-btn is-light">Set up now<Arrow /></a></div>
    </section>
    </>
  );
}

export function V3() {
  const live = useLiveDesk();
  const start = startFromText(live.startFrom);
  const [faq, setFaq] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [whaleRef, whaleNear] = useOnScreen<HTMLDivElement>({ margin: '0px 0px -30% 0px' });
  const copyNames = useMemo(() => COPY_VENUES.map((v) => VENUE_LABEL[v]), []);

  useEffect(() => {
    dropBootShell();
    document.title = 'ValueDesk: bots and copy trading on SoDEX, on one desk';
    const s = () => setScrolled(window.scrollY > 12);
    s();
    window.addEventListener('scroll', s, { passive: true });
    return () => window.removeEventListener('scroll', s);
  }, []);

  return (
    <div className="v3" data-no-i18n="">
      <div className="v3-bg" aria-hidden="true"><div className="v3-bg__light" /><div className="v3-bg__dots" /></div>
      <div className={cx('v3-whale', whaleNear && 'is-on')} aria-hidden="true">
        {whaleNear && <SwimmingWhale from={WHALE_FROM} to={WHALE_TO} height={560} opacity={0.45} />}
      </div>

      <nav className={cx('v3-nav', scrolled && 'is-solid')} aria-label="ValueDesk">
        <a href="/home" className="v3-logo"><BrandMark size={22} /><span>ValueDesk</span></a>
        <div className="v3-nav__links"><a href="#features">Features</a><a href="#safety">Your funds</a><a href="#fees">Fees</a><a href="#faq">FAQ</a></div>
        <a href="/trade" className="v3-btn is-glass is-sm">Open app</a>
      </nav>

      {/* --------------------------------------------------------------------------------------------- hero */}
      <header className="v3-hero">
        <div className="v3-hero__t">
          <div className="v3-up"><Eyebrow>Bots · copy trading · analytics on SoDEX</Eyebrow></div>
          <h1 className="v3-h1 v3-up" style={{ '--d': '70ms' } as CSSProperties}>One desk.<br /><span>Everything connected.</span></h1>
          <p className="v3-sub v3-up" style={{ '--d': '140ms' } as CSSProperties}>Market makers that run while you sleep, copies of any {listOf(copyNames, 'or')} wallet and the liquidation map, all trading in your own SoDEX account.</p>
          <div className="v3-start v3-up" style={{ '--d': '210ms' } as CSSProperties}>
            <span className="v3-start__k">Start with</span><b>{start}</b>
          </div>
          <div className="v3-cta v3-up" style={{ '--d': '280ms' } as CSSProperties}>
            <a href="/bots/new" className="v3-btn is-light">Start a bot<Arrow /></a>
            <a href="/copy" className="v3-btn is-glass">Copy a trader</a>
          </div>
          <p className="v3-hero__fine v3-up" style={{ '--d': '340ms' } as CSSProperties}>No deposit · three free signatures · stop any time</p>
        </div>
        <Desk live={live} />
      </header>

      {/* ---------------------------------------------------------------------------------------- live strip */}
      <section className="v3-strip" aria-label="Live from SoDEX">
        <div><b><Count to={live.marketCount} fmt={(x) => String(Math.round(x))} /></b><span>SoDEX markets a bot can run on</span></div>
        <div><b><Count to={live.volumeH} fmt={usdShort} /></b><span>traded on them in the last hour</span></div>
        <div><b><Count to={GRID_VENUES.length} fmt={(x) => String(Math.round(x))} /></b><span>venues indexed for analytics</span></div>
        <div><b>{start}</b><span>enough to start a market maker</span></div>
        <span className="v3-livetag is-abs">Live</span>
      </section>

      <V3Features live={live} />
      <V3Safety />
      <V3SignTiles />

      {/* the whale swims behind everything from here down */}
      <div ref={whaleRef}>
        {/* ------------------------------------------------------------------------------------------- fees */}
        <section className="v3-sec" id="fees">
          <Reveal as="header" className="v3-head is-center">
            <Eyebrow>Fees</Eyebrow>
            <h2 className="v3-h2 v3-feehead">Bot fee from <span className="v3-num">{bp(FEES.botLowest)}</span></h2>
            <p className="v3-vipline"><span className="v3-vip">VIP</span>{FEES.vipCondition}</p>
            <p className="v3-lead">No subscription. A fee in basis points on the orders that run, lower as your {FEES.windowDays}-day volume grows.</p>
          </Reveal>
          <div className="v3-fees">
            <Reveal className="v3-fee is-hot">
              <p className="v3-fee__k">Bots</p>
              <b className="v3-fee__v">{bp(FEES.botNew)}<small> per order, new wallet</small></b>
              <ul>
                {FEES.botLadder.slice(1).map((s) => <li key={s.fromUsd}><span>{bp(s.fee)}</span>from {usdStep(s.fromUsd)} in {FEES.windowDays} days</li>)}
                <li className="is-vip"><span>{bp(FEES.botLowest)}</span>VIP, {FEES.vipCondition.replace(/^VIP: /, '')}</li>
              </ul>
              <a href="/bots/new" className="v3-btn is-light is-block">Start a bot<Arrow /></a>
            </Reveal>
            <Reveal className="v3-fee" delay={90}>
              <p className="v3-fee__k">Copy trading</p>
              <b className="v3-fee__v">{bp(FEES.copyNew)}<small> per copied order</small></b>
              <ul>
                {FEES.copyLadder.slice(1).map((s) => <li key={s.fromUsd}><span>{bp(s.fee)}</span>from {usdStep(s.fromUsd)} copied in {FEES.windowDays} days</li>)}
              </ul>
              <a href="/copy" className="v3-btn is-glass is-block">Copy a trader</a>
            </Reveal>
            <Reveal className="v3-fee" delay={180}>
              <p className="v3-fee__k">Analytics</p>
              <b className="v3-fee__v">Free</b>
              <ul className="is-plain">
                <li>Liquidation map, live and history</li>
                <li>Who traded each candle</li>
                <li>Leaderboards and wallet scan</li>
                <li>News, calendar, ETF flows</li>
              </ul>
              <a href="/trade" className="v3-btn is-glass is-block">Open the terminal</a>
            </Reveal>
          </div>
          <p className="v3-note">SoDEX charges its own trading fee on top.</p>
        </section>

        {/* -------------------------------------------------------------------------------------------- faq */}
        <section className="v3-sec v3-faqsec" id="faq">
          <Reveal as="header" className="v3-head">
            <Eyebrow>FAQ</Eyebrow>
            <h2 className="v3-h2">Questions,<br /><span>answered.</span></h2>
            <p className="v3-lead">The rest is in the <a href="/copy-terms">copy and bot terms</a> and the <a href="/risk">risk disclosure</a>.</p>
          </Reveal>
          <div className="v3-faq">
            {FAQ.map((f, i) => (
              <div key={f.q} className={cx('v3-faq__i', faq === i && 'is-open')}>
                <button type="button" aria-expanded={faq === i} onClick={() => setFaq(faq === i ? -1 : i)}>{f.q}<span className="v3-faq__x" aria-hidden="true" /></button>
                <div className="v3-faq__a"><div><p>{f.a}</p></div></div>
              </div>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------------------------------------------ final */}
        <section className="v3-final">
          <Reveal className="v3-final__in">
            <div className="v3-final__mark"><BrandMark size={44} /></div>
            <h2 className="v3-h2">Put your market<br /><span>on one desk.</span></h2>
            <p className="v3-lead">Start with {start}. Connect, sign three times, and your first bot is running.</p>
            <div className="v3-cta is-center">
              <a href="/bots/new" className="v3-btn is-light">Start a bot<Arrow /></a>
              <a href="/copy" className="v3-btn is-glass">Copy a trader</a>
            </div>
          </Reveal>
        </section>

        <footer className="v3-foot">
          <div className="v3-foot__row">
            <a href="/home" className="v3-logo"><BrandMark size={20} /><span>ValueDesk</span></a>
            <nav aria-label="Legal and status">
              <a href="/terms">Terms</a><a href="/risk">Risk</a><a href="/privacy">Privacy</a><a href="/copy-terms">Copy and bot terms</a><a href="/status">Status</a>
            </nav>
          </div>
          <p className="v3-risk">Trading perpetual futures carries a high risk of loss. Bots and copies can lose money, and past results say nothing about future ones.</p>
        </footer>
      </div>
    </div>
  );
}
