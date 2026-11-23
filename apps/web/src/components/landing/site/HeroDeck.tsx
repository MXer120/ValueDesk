/**
 * V5's hero visual (owner 2026-11-23): the product's parts floating in depth over the heat - balanced across the
 * product, not mostly bots: the copy card, the live bot card (the cheapest busy SoDEX market now), cross-venue
 * analytics (the five venues the map and the leaderboards read) and the fee tiers (each lowest fee with its condition).
 * Cards are opaque (backdrop blur does not work inside a 3D scene). Each card flies in, floats on its own beat and leans
 * with the pointer by its depth.
 *
 * Figures: only live ones (BotPanel) and the fee constants (FEES). The heat strip is a drawing.
 * Motion pauses off screen and stops for prefers-reduced-motion. Sits inside a `.v3` scope (V3's card styles).
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { VenueLogo } from '../../VenueLogo';
import { GRID_VENUES } from '../../copy/gridModel';
import { VENUE_LABEL } from '../../../vsApi';
import { BotPanel, CopyPanel } from '../v3/V3';
import { bp, FEES, reducedMotion, type LiveDesk } from '../shared';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
const VIP_RULE = FEES.vipCondition.replace(/^VIP:\s*/, '');

/** Cross-venue analytics: the five venues and a strip of liquidation heat drifting under them. */
function VenuesCard() {
  return (
    <div className="v3-card hd-venues">
      <div className="v3-card__top"><span className="v3-chip">Cross-venue analytics</span><span className="v3-chip is-sm is-g">Free</span></div>
      <ul>
        {GRID_VENUES.map((v, i) => (
          <li key={v} style={{ '--i': i } as CSSProperties}><VenueLogo venue={v} size={16} /><span>{VENUE_LABEL[v]}</span><i /></li>
        ))}
      </ul>
      <div className="hd-strip"><i /></div>
      <small className="hd-cap">Liquidation map and leaderboards, every venue</small>
    </div>
  );
}

/** The fee tiers: analytics free, copy and bots each from their lowest fee, with the condition beside it. */
function TiersCard() {
  const rows: Array<{ k: string; v: ReactNode; c: ReactNode }> = [
    { k: 'Analytics', v: 'Free', c: 'no wallet needed' },
    { k: 'Copy trading', v: <><small>from </small>{bp(FEES.copyLowest)}</>, c: FEES.copyLowestCondition },
    { k: 'Bots', v: <><small>from </small><span className="vip-text">{bp(FEES.botLowest)}</span></>, c: <><span className="vip-pill">VIP</span> {VIP_RULE}</> },
  ];
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (reducedMotion()) return;
    const id = window.setInterval(() => setAt((a) => (a + 1) % rows.length), 2200);
    return () => window.clearInterval(id);
  }, [rows.length]);
  return (
    <div className="v3-card hd-tiers">
      <div className="v3-card__top"><span className="v3-chip">Fees</span><span className="hd-auto">lower as volume grows</span></div>
      {rows.map((r, i) => (
        <div key={r.k} className={cx('hd-tier', i === at && 'is-on')}>
          <span>{r.k}</span><b>{r.v}</b><small>{r.c}</small>
        </div>
      ))}
    </div>
  );
}

export function HeroDeck({ live }: { live: LiveDesk }) {
  const box = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([e]) => setOn(!!e?.isIntersecting)) : null;
    io?.observe(el);
    if (reducedMotion()) return () => io?.disconnect();
    let raf = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.style.setProperty('--mx', (e.clientX / window.innerWidth - 0.5).toFixed(3));
        el.style.setProperty('--my', (e.clientY / window.innerHeight - 0.5).toFixed(3));
      });
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => { io?.disconnect(); window.removeEventListener('pointermove', move); cancelAnimationFrame(raf); };
  }, []);
  const card = (cls: string, z: number, i: number, child: ReactNode) => (
    <div className={cx('hd-slot', cls)} style={{ '--z': z, '--i': i } as CSSProperties}>
      <div className="hd-float">{child}</div>
    </div>
  );
  return (
    <div ref={box} className="hd" data-off={on ? undefined : ''} aria-hidden="true">
      <div className="hd-stage">
        {card('is-copy', 0.5, 0, <CopyPanel />)}
        {card('is-venues', 0.8, 1, <VenuesCard />)}
        {card('is-bot', 1.3, 2, <BotPanel rows={live.rows} loading={live.loading} error={live.error} />)}
        {card('is-tiers', 1.8, 3, <TiersCard />)}
      </div>
    </div>
  );
}
