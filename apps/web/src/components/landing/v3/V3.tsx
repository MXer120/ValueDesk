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

import type { BotLatencyResponse } from '../../../bots/data';
import { usdShort, useLiveDesk, liteDevice, reducedMotion, type MarketRow } from '../shared';

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
function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="v3-eyebrow"><span className="v3-eyebrow__dot" />{children}</p>;
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

/**
 * Speed as a speedometer (owner 2026-11-23): further right is faster, and the dial fills up from the left as the needle
 * rises. Without a public latency read it is a drawing: the needle sweeps up once it comes on screen and holds near the
 * fast end with a small live jitter. With a real p50, lower is faster, so it points further right.
 */
const SEGS = 26;
export function GaugeViz({ latency }: { latency: { p50: number; label: string } | null }) {
  const dial = useRef<HTMLDivElement>(null);
  const [ref, on] = useOnScreen<HTMLDivElement>();
  // A real p50 on a 0..1000 ms log scale: 0 ms far right (fast), 1000 ms far left.
  const real = latency ? 90 - 180 * Math.min(1, Math.log10(1 + latency.p50) / 3) : null;
  useEffect(() => {
    const el = dial.current;
    if (!el) return;
    const needle = el.querySelector<HTMLElement>('.v3-gauge__needle');
    const segs = Array.from(el.querySelectorAll<HTMLElement>('i'));
    const paint = (deg: number) => {
      if (needle) needle.style.transform = `rotate(${deg.toFixed(2)}deg)`;
      const lit = Math.round(((deg + 90) / 180) * (SEGS - 1));
      segs.forEach((s, i) => s.classList.toggle('is-on', i <= lit));
    };
    if (real !== null || reducedMotion()) { paint(real ?? 64); return; }
    if (!on) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = (t - t0) / 1000;
      // Sweep up over ~1.6 s (ease out), then hold near 64 deg with a slow wobble and a little flutter.
      const sweep = Math.min(1, k / 1.6);
      const base = -90 + (64 + 90) * (1 - Math.pow(1 - sweep, 3));
      const hold = sweep < 1 ? 0 : Math.sin(k * 0.9) * 5 + Math.sin(k * 5.3) * 1.2;
      paint(base + hold);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on, real]);
  return (
    <div ref={ref} className={cx('v3-viz v3-gauge is-speedo', real !== null && 'is-real')} aria-hidden="true">
      <div ref={dial} className="v3-gauge__dial">
        {Array.from({ length: SEGS }, (_, i) => <i key={i} style={{ '--a': `${-90 + (i * 180) / (SEGS - 1)}deg`, '--k': i / (SEGS - 1) } as CSSProperties} />)}
        <div className="v3-gauge__arc" />
        <div className="v3-gauge__needle" />
        <div className="v3-gauge__hub" />
        <span className="v3-gauge__end is-l">slower</span><span className="v3-gauge__end is-r">faster</span>
      </div>
      <span className="v3-gauge__tag"><i className="v3-gauge__dot" />{latency ? `${Math.round(latency.p50)} ms p50 · ${latency.label}` : 'Executor in Tokyo'}</span>
    </div>
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
  if (liteDevice()) return <span className={`v3-fx is-${v}`} aria-hidden="true"><span className="v3-fx__dots" /></span>;
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
