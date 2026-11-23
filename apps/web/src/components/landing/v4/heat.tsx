/**
 * The heat field through ribbed glass (marketing/BRAND.md): the liquidation heatmap's own ramp, mostly indigo and blue,
 * a green body and one small hot point, seen through vertical glass strips that each bend and shade it on their own.
 * A drawing, never a figure: there is no number in it.
 *
 * How: the field is painted small (a few soft blobs that drift) on an offscreen canvas; each strip of the visible canvas
 * draws a slightly wider slice of it squeezed into the strip (the lens), then one shading pattern lays the light and
 * shade of every rib on top. Pauses off screen and while the tab is hidden; under reduced motion it paints once.
 */
import { useEffect, useRef } from 'react';
import { reducedMotion } from '../shared';

export const HEAT = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'] as const;

/** A blob of the field: centre (0..1), radius (share of the larger side), colour, alpha, drift. */
interface Blob { x: number; y: number; r: number; c: string; a: number; dx: number; dy: number; sp: number; ph: number }

/** Where the heat sits. `right`: the hero (the field leans right, the hot point small and away from the type). */
const LAYOUTS: Record<'right' | 'card' | 'wide', Blob[]> = {
  right: [
    { x: 0.62, y: 0.28, r: 0.62, c: HEAT[0], a: 0.95, dx: 0.06, dy: 0.05, sp: 0.07, ph: 0 },
    { x: 0.9, y: 0.62, r: 0.55, c: HEAT[1], a: 0.9, dx: 0.05, dy: 0.06, sp: 0.06, ph: 1.7 },
    { x: 0.42, y: 0.85, r: 0.38, c: HEAT[0], a: 0.8, dx: 0.06, dy: 0.04, sp: 0.05, ph: 3.1 },
    { x: 0.74, y: 0.78, r: 0.34, c: HEAT[2], a: 0.85, dx: 0.05, dy: 0.05, sp: 0.08, ph: 0.8 },
    { x: 0.8, y: 0.5, r: 0.2, c: HEAT[3], a: 0.75, dx: 0.04, dy: 0.05, sp: 0.09, ph: 2.4 },
    { x: 0.84, y: 0.44, r: 0.06, c: HEAT[4], a: 0.9, dx: 0.03, dy: 0.04, sp: 0.1, ph: 4.2 },
  ],
  card: [
    { x: 0.5, y: 0.05, r: 0.9, c: HEAT[0], a: 1, dx: 0.08, dy: 0.04, sp: 0.06, ph: 0 },
    { x: 0.15, y: 0.35, r: 0.55, c: HEAT[1], a: 0.85, dx: 0.06, dy: 0.06, sp: 0.07, ph: 2 },
    { x: 0.95, y: 0.95, r: 0.6, c: HEAT[0], a: 0.9, dx: 0.05, dy: 0.05, sp: 0.05, ph: 1 },
    { x: 0.8, y: 0.2, r: 0.28, c: HEAT[2], a: 0.6, dx: 0.06, dy: 0.06, sp: 0.08, ph: 3 },
    { x: 0.88, y: 0.12, r: 0.12, c: HEAT[3], a: 0.55, dx: 0.04, dy: 0.04, sp: 0.09, ph: 4 },
    { x: 0.9, y: 0.08, r: 0.035, c: HEAT[4], a: 0.85, dx: 0.02, dy: 0.02, sp: 0.1, ph: 5 },
  ],
  wide: [
    { x: 0.3, y: 0.6, r: 0.55, c: HEAT[0], a: 1, dx: 0.08, dy: 0.05, sp: 0.06, ph: 0 },
    { x: 0.7, y: 0.4, r: 0.55, c: HEAT[1], a: 0.9, dx: 0.07, dy: 0.06, sp: 0.05, ph: 2 },
    { x: 0.55, y: 0.75, r: 0.32, c: HEAT[2], a: 0.8, dx: 0.06, dy: 0.04, sp: 0.07, ph: 1 },
    { x: 0.86, y: 0.3, r: 0.16, c: HEAT[3], a: 0.7, dx: 0.04, dy: 0.04, sp: 0.08, ph: 3.5 },
    { x: 0.9, y: 0.24, r: 0.045, c: HEAT[4], a: 0.9, dx: 0.02, dy: 0.02, sp: 0.1, ph: 4.5 },
    { x: 0.05, y: 0.2, r: 0.4, c: HEAT[0], a: 0.7, dx: 0.04, dy: 0.04, sp: 0.05, ph: 5 },
  ],
};

const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

export function HeatGlass({ layout = 'right', rib = 26, className }: { layout?: keyof typeof LAYOUTS; rib?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const off = document.createElement('canvas');
    const OW = 192;
    const OH = 120;
    off.width = OW;
    off.height = OH;
    const o = off.getContext('2d');
    if (!o) return;
    const blobs = LAYOUTS[layout];
    const still = reducedMotion();
    let W = 0;
    let H = 0;
    let dpr = 1;
    let sw = rib;
    let shade: CanvasPattern | null = null;
    let raf = 0;
    let visible = false;
    let alive = true;

    const size = () => {
      const r = cv.getBoundingClientRect();
      W = Math.max(1, r.width);
      H = Math.max(1, r.height);
      dpr = Math.min(1.5, window.devicePixelRatio || 1);
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      sw = W < 560 ? Math.max(14, rib * 0.66) : rib;
      // One rib's light and shade, repeated across: a bright lip on the left, clear middle, a dark fold on the right.
      const s = document.createElement('canvas');
      s.width = Math.max(2, Math.round(sw * dpr));
      s.height = 2;
      const sc = s.getContext('2d');
      if (sc) {
        const g = sc.createLinearGradient(0, 0, s.width, 0);
        g.addColorStop(0, 'rgba(255,255,255,0.22)');
        g.addColorStop(0.06, 'rgba(255,255,255,0.08)');
        g.addColorStop(0.4, 'rgba(255,255,255,0.02)');
        g.addColorStop(0.62, 'rgba(0,0,0,0)');
        g.addColorStop(0.9, 'rgba(0,0,0,0.26)');
        g.addColorStop(1, 'rgba(0,0,0,0.5)');
        sc.fillStyle = g;
        sc.fillRect(0, 0, s.width, s.height);
        shade = ctx.createPattern(s, 'repeat');
      }
    };

    const paintField = (t: number) => {
      o.globalCompositeOperation = 'source-over';
      o.fillStyle = '#07040f';
      o.fillRect(0, 0, OW, OH);
      o.globalCompositeOperation = 'lighter';
      const R = Math.max(OW, OH);
      for (const b of blobs) {
        const k = t / 1000 * b.sp;
        const x = (b.x + Math.sin(k * 6.28 + b.ph) * b.dx) * OW;
        const y = (b.y + Math.cos(k * 5.1 + b.ph) * b.dy) * OH;
        const r = b.r * R * (1 + Math.sin(k * 4 + b.ph) * 0.06);
        const g = o.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, hexA(b.c, b.a));
        g.addColorStop(0.5, hexA(b.c, b.a * 0.45));
        g.addColorStop(1, hexA(b.c, 0));
        o.fillStyle = g;
        o.fillRect(0, 0, OW, OH);
      }
    };

    const draw = (t: number) => {
      if (!alive) return;
      paintField(still ? 8000 : t);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      const drift = still ? 0 : Math.sin(t / 5200) * 0.35; // the ribs' lens slides a little: the shimmer of glass
      for (let x = 0; x < W; x += sw) {
        const c = (x + sw / 2) / W;
        const srcW = (sw / W) * OW * 2.1;
        const sx = Math.min(OW - srcW, Math.max(0, c * OW - srcW / 2 + drift * srcW));
        ctx.drawImage(off, sx, 0, srcW, OH, x, 0, sw + 0.5, H);
      }
      if (shade) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = shade;
        ctx.fillRect(0, 0, cv.width, cv.height);
      }
      if (!still && visible && document.visibilityState === 'visible') raf = requestAnimationFrame(draw);
    };
    const kick = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); };

    size();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { size(); kick(); }) : null;
    ro?.observe(cv);
    const io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; if (visible) kick(); else cancelAnimationFrame(raf); }, { rootMargin: '80px' })
      : null;
    if (io) io.observe(cv); else { visible = true; kick(); }
    const onVis = () => { if (visible) kick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [layout, rib]);
  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
