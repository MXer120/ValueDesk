/**
 * V5's hero visual (owner 2026-11-23: "instead of the logo maybe components or something with cool animations"): the
 * product's own parts floating in depth over the heat - the live bot card (the cheapest busy SoDEX market now), the
 * copy card, the three signatures ticking, a bot running with the tab closed, and the bot fee ladder stepping down to
 * VIP. Each card flies in, floats on its own beat and leans with the pointer by its depth.
 *
 * Figures: only live ones (BotPanel, useLiveDesk) and the fee ladder (FEES). The rest are drawings without numbers.
 * Motion pauses off screen and stops for prefers-reduced-motion. Sits inside a `.v3` scope (V3's card styles).
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { BrandMark } from '../../BrandMark';
import { BotPanel, CopyPanel } from '../v3/V3';
import { bp, FEES, reducedMotion, type LiveDesk } from '../shared';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
const Check = () => <svg className="v3-check" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10.4 3.2 3.1L15 6.7" /></svg>;

/** The fee ladder as steps, the lit one walking down to VIP. */
function FeeSteps() {
  const steps = [...FEES.botLadder.map((s) => ({ k: s.fromUsd === 0 ? 'New' : `$${s.fromUsd >= 1e6 ? `${s.fromUsd / 1e6}M` : `${s.fromUsd / 1e3}K`}`, v: bp(s.fee), vip: false })), { k: 'VIP', v: bp(FEES.botLowest), vip: true }];
  const [at, setAt] = useState(reducedMotion() ? steps.length - 1 : 0);
  useEffect(() => {
    if (reducedMotion()) return;
    const id = window.setInterval(() => setAt((a) => (a + 1) % steps.length), 1400);
    return () => window.clearInterval(id);
  }, [steps.length]);
  return (
    <div className="v3-card hd-fee">
      <div className="v3-card__top"><span className="v3-chip is-sm">Bot fee</span><span className="hd-auto">applies by itself</span></div>
      <div className="hd-steps">
        {steps.map((s, i) => (
          <span key={s.k} className={cx(i === at && 'is-on', s.vip && 'is-vip', i < at && 'is-past')}>
            <small>{s.vip ? <b className="vip-pill">VIP</b> : s.k}</small>
            <b className={s.vip ? 'vip-text' : undefined}>{s.v}</b>
          </span>
        ))}
      </div>
      <div className="hd-bar"><i style={{ width: `${((at + 1) / steps.length) * 100}%` }} /></div>
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
  const card = (cls: string, z: number, i: number, child: React.ReactNode) => (
    <div className={cx('hd-slot', cls)} style={{ '--z': z, '--i': i } as CSSProperties}>
      <div className="hd-float">{child}</div>
    </div>
  );
  return (
    <div ref={box} className="hd" data-off={on ? undefined : ''} aria-hidden="true">
      <div className="hd-stage">
        {card('is-copy', 0.5, 0, <CopyPanel />)}
        {card('is-bot', 1.2, 1, <BotPanel rows={live.rows} loading={live.loading} error={live.error} />)}
        {card('is-run', 1.6, 2, (
          <div className="v3-card hd-run">
            <span className="hd-run__mark"><BrandMark size={18} /></span>
            <div><b>Bot running</b><small>on the executor in Tokyo</small></div>
            <span className="v3-chip is-sm is-g"><span className="v3-dot is-on" />Tab closed</span>
          </div>
        ))}
        {card('is-fee', 1.7, 3, <FeeSteps />)}
        {card('is-sign', 1.9, 4, <div className="v3-signchip">{['Terms', 'Fee', 'Key'].map((t, i) => <span key={t} style={{ '--i': i } as CSSProperties}><Check />{t}</span>)}</div>)}
      </div>
    </div>
  );
}
