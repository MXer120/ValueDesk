/**
 * The NFT card's glare (owner 2026-11-28: "For nfts copy the glare from the original cybereator.com domain 100% exact").
 * The same effect as cybereator.com's cards, measured from its page (2026-11-28) and written here:
 *
 * - the card tilts toward the pointer, up to 8 degrees each way, eased 16% of the way per frame;
 * - a foil layer twice the card's size, colour-dodged at 16% (45% on hover, its idle drift paused), a 115 degree band
 *   of magenta, cyan, yellow and violet that moves against the pointer (40% of the offset) and drifts on its own
 *   (7 s, alternate) while the pointer is away; "strong" is 30% / 65%, "gold" a gold band at 34% / 70%;
 * - a glare layer: a white radial (16% at its centre, gone by 32%) that follows the pointer, shown on hover (0.4 s).
 *
 * With reduced motion the card holds still and shows no glare.
 */
import { useEffect, useRef, type ReactNode } from 'react';

const EASE = 0.16;
const still = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Holo({ foil = 'normal', tilt = 8, children, className = '' }: { foil?: 'normal' | 'strong' | 'gold' | false; tilt?: number; children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const s = useRef({ x: 0, y: 0, tx: 0, ty: 0, mx: 0.5, my: 0.5, tmx: 0.5, tmy: 0.5, raf: 0 });
  useEffect(() => () => cancelAnimationFrame(s.current.raf), []);
  const step = () => {
    const p = s.current;
    const el = box.current;
    if (!el) return;
    p.x += (p.tx - p.x) * EASE; p.y += (p.ty - p.y) * EASE; p.mx += (p.tmx - p.mx) * EASE; p.my += (p.tmy - p.my) * EASE;
    el.style.setProperty('--rx', `${p.x.toFixed(2)}deg`);
    el.style.setProperty('--ry', `${p.y.toFixed(2)}deg`);
    el.style.setProperty('--mxn', p.mx.toFixed(3));
    el.style.setProperty('--myn', p.my.toFixed(3));
    const moving = Math.abs(p.tx - p.x) + Math.abs(p.ty - p.y) + Math.abs(p.tmx - p.mx) + Math.abs(p.tmy - p.my) > 0.002;
    p.raf = moving ? requestAnimationFrame(step) : 0;
  };
  const kick = () => { if (!s.current.raf) s.current.raf = requestAnimationFrame(step); };
  const move = (e: React.PointerEvent) => {
    if (still() || !box.current) return;
    const r = box.current.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    Object.assign(s.current, { tx: (x - 0.5) * tilt * 2, ty: (0.5 - y) * tilt * 2, tmx: x, tmy: y });
    box.current.classList.add('is-hover');
    kick();
  };
  const leave = () => {
    Object.assign(s.current, { tx: 0, ty: 0, tmx: 0.5, tmy: 0.5 });
    box.current?.classList.remove('is-hover');
    kick();
  };
  return (
    <div ref={box} className={`vh-tilt${foil ? ` vh-holo is-${foil}` : ''} ${className}`} onPointerMove={move} onPointerLeave={leave}>
      {children}
      {foil && <i className="vh-foil" aria-hidden="true" />}
      <i className="vh-glare" aria-hidden="true" />
    </div>
  );
}
