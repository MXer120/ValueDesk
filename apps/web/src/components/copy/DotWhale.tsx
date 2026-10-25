/**
 * The Copy page's hero art (Discover.tsx, in place of the trader card deck): a
 * breaching humpback drawn in dots, like a stipple print - dense where the body
 * turns away from the light, thin on its back, the spray breaking off its tail
 * into loose dots. The dots drift a little and twinkle, and step aside from the
 * pointer. Drawn on a canvas from a silhouette (no image file); still under
 * reduced motion.
 */
import { useEffect, useRef } from 'react';

/** The silhouette in a 400 x 300 box: the body, the raised fin, the long fin. */
const BODY = 'M54 110 C66 88 118 79 176 89 C242 103 297 152 322 226 L334 290 C322 296 308 296 302 290 L292 254 C262 206 214 183 156 162 C108 146 70 134 54 120 Z';
const FIN_UP = 'M136 98 C133 72 141 50 156 40 C165 44 169 60 166 80 C164 96 158 106 149 112 Z';
const FIN_LONG = 'M194 94 C240 72 292 60 340 60 C345 67 332 76 302 82 C262 90 226 100 206 110 Z';
const W = 400;
const H = 300;

interface Dot { x: number; y: number; r: number; a: number; ph: number; sp: number; dx: number; dy: number; spray: boolean }

/** The dots: sampled inside the silhouette, denser where its shade is, plus the spray. */
function makeDots(count: number): Dot[] {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return [];
  const body = new Path2D(BODY);
  const finUp = new Path2D(FIN_UP);
  const finLong = new Path2D(FIN_LONG);
  // The shade map: the belly and the raised fin dark, the back light (red channel = density).
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  const shade = g.createLinearGradient(150, 70, 230, 230);
  shade.addColorStop(0, 'rgb(40,0,0)');
  shade.addColorStop(0.5, 'rgb(135,0,0)');
  shade.addColorStop(1, 'rgb(245,0,0)');
  g.fillStyle = shade;
  g.fill(body);
  g.fillStyle = 'rgb(255,0,0)';
  g.fill(finUp);
  g.fillStyle = 'rgb(120,0,0)';
  g.fill(finLong);
  // The shadow where the fin meets the body.
  const blot = g.createRadialGradient(175, 125, 2, 175, 125, 46);
  blot.addColorStop(0, 'rgba(255,0,0,0.9)');
  blot.addColorStop(1, 'rgba(255,0,0,0)');
  g.save();
  g.clip(body);
  g.fillStyle = blot;
  g.fillRect(0, 0, W, H);
  g.restore();
  const px = g.getImageData(0, 0, W, H).data;
  const density = (x: number, y: number) => px[(Math.floor(y) * W + Math.floor(x)) * 4]! / 255;

  const dots: Dot[] = [];
  let tries = 0;
  while (dots.length < count && tries < count * 40) {
    tries++;
    const x = Math.random() * W;
    const y = Math.random() * H;
    const d = density(x, y);
    if (d <= 0 || Math.random() > d) continue;
    dots.push({ x, y, r: 0.55 + Math.random() * 0.75 * (0.5 + d), a: 0.35 + d * 0.65, ph: Math.random() * Math.PI * 2, sp: 0.6 + Math.random() * 1.4, dx: 0, dy: 0, spray: false });
  }
  // The spray: loose dots off the tail, thinning away from it.
  for (let i = 0; i < count * 0.09; i++) {
    const t = Math.random();
    const x = 300 + t * 70 + (Math.random() - 0.5) * 40 * (0.4 + t);
    const y = 250 + t * 45 + (Math.random() - 0.5) * 50 * (0.4 + t);
    dots.push({ x, y, r: 0.5 + Math.random() * 0.8, a: 0.55 * (1 - t) + 0.1, ph: Math.random() * Math.PI * 2, sp: 0.5 + Math.random(), dx: 0, dy: 0, spray: true });
  }
  return dots;
}

export function DotWhale() {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = box.current;
    const canvas = cv.current;
    if (!el || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dots = makeDots(4200);
    const pointer = { x: -1e4, y: -1e4 };
    let scale = 1;
    let ox = 0;
    let oy = 0;
    let raf = 0;
    let last = 0;

    const fit = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      scale = Math.min(r.width / W, r.height / H) * dpr;
      ox = (canvas.width - W * scale) / 2;
      oy = (canvas.height - H * scale) / 2;
    };
    const draw = (t: number) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const bob = still ? 0 : Math.sin(t / 2400) * 3;
      for (const d of dots) {
        // Step aside from the pointer, then ease back.
        const sx = ox + d.x * scale;
        const sy = oy + (d.y + bob) * scale;
        const vx = sx - pointer.x;
        const vy = sy - pointer.y;
        const dist2 = vx * vx + vy * vy;
        const reach = 70 * scale;
        if (!still && dist2 < reach * reach) {
          const push = (1 - Math.sqrt(dist2) / reach) * 9;
          const len = Math.sqrt(dist2) || 1;
          d.dx += ((vx / len) * push - d.dx) * 0.2;
          d.dy += ((vy / len) * push - d.dy) * 0.2;
        } else {
          d.dx *= 0.9;
          d.dy *= 0.9;
        }
        const drift = still || !d.spray ? 0 : ((t / 1000) * d.sp * 4) % 30;
        const tw = still ? 1 : 0.72 + 0.28 * Math.sin(t / 700 * d.sp + d.ph);
        ctx.globalAlpha = d.a * tw * (d.spray ? Math.max(0, 1 - drift / 30) : 1);
        ctx.beginPath();
        ctx.arc(sx + d.dx * scale + drift * scale * 0.6, sy + d.dy * scale + drift * scale * 0.35, d.r * scale, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    const loop = (t: number) => {
      // ~30 frames a second is plenty for a drift.
      if (t - last > 32) { draw(t); last = t; }
      raf = requestAnimationFrame(loop);
    };
    fit();
    ctx.fillStyle = getComputedStyle(el).color || '#e8e8e8';
    const ro = new ResizeObserver(() => { fit(); ctx.fillStyle = getComputedStyle(el).color || '#e8e8e8'; if (still) draw(0); });
    ro.observe(el);
    const move = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const dpr = canvas.width / Math.max(1, r.width);
      pointer.x = (e.clientX - r.left) * dpr;
      pointer.y = (e.clientY - r.top) * dpr;
    };
    const leave = () => { pointer.x = -1e4; pointer.y = -1e4; };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    if (still) draw(0);
    else raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, []);

  return (
    <div ref={box} className="cpy-whale" aria-hidden="true">
      <canvas ref={cv} />
    </div>
  );
}
