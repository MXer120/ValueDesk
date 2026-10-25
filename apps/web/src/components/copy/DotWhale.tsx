/**
 * The Copy page's hero art (Discover.tsx, in place of the trader card deck): a
 * humpback breaching out of the water, drawn in dots like a stipple print.
 *
 *   The whale   sampled from a silhouette with a shade map - dense on the belly
 *               and the raised fin, thin on its back - above the waterline; under
 *               it the body shows faint and wavering, as through water.
 *   The water   rows of dots that ripple, closer together and fainter with depth.
 *   The splash  drops thrown up where the body breaks the surface, falling back
 *               into it under gravity.
 *
 * The whale bobs a little, the dots twinkle and step aside from the pointer.
 * Drawn on a canvas from the silhouette (no image file); still under reduced motion.
 */
import { useEffect, useRef } from 'react';

/** The silhouette in a 400 x 300 box: the body (its tail goes under), the raised fin, the long fin. */
const BODY = 'M54 104 C66 82 118 73 176 83 C242 97 297 146 322 220 L338 300 L292 300 L288 262 C260 210 214 182 156 158 C108 142 70 128 54 114 Z';
const FIN_UP = 'M136 92 C133 66 141 44 156 34 C165 38 169 54 166 74 C164 90 158 100 149 106 Z';
const FIN_LONG = 'M194 88 C240 66 292 54 340 54 C345 61 332 70 302 76 C262 84 226 94 206 104 Z';
const W = 400;
const H = 300;
/** The water's surface in the box. */
const SEA = 238;

interface Dot { x: number; y: number; r: number; a: number; ph: number; sp: number; dx: number; dy: number; under: boolean }
interface Drop { x: number; y: number; vx: number; vy: number; r: number; life: number }

/** The whale's dots: inside the silhouette, denser where its shade is. */
function whaleDots(count: number): Dot[] {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return [];
  const body = new Path2D(BODY);
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  // The shade map: the belly and the raised fin dark, the back light (red channel = density).
  const shade = g.createLinearGradient(150, 64, 230, 224);
  shade.addColorStop(0, 'rgb(40,0,0)');
  shade.addColorStop(0.5, 'rgb(135,0,0)');
  shade.addColorStop(1, 'rgb(245,0,0)');
  g.fillStyle = shade;
  g.fill(body);
  g.fillStyle = 'rgb(255,0,0)';
  g.fill(new Path2D(FIN_UP));
  g.fillStyle = 'rgb(120,0,0)';
  g.fill(new Path2D(FIN_LONG));
  const blot = g.createRadialGradient(175, 119, 2, 175, 119, 46);
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
    const under = y > SEA + 2;
    dots.push({ x, y, r: 0.55 + Math.random() * 0.75 * (0.5 + d), a: (0.35 + d * 0.65) * (under ? 0.22 * Math.max(0, 1 - (y - SEA) / 55) : 1), ph: Math.random() * Math.PI * 2, sp: 0.6 + Math.random() * 1.4, dx: 0, dy: 0, under });
  }
  return dots;
}

/** The sea: rows of dots, closer together and fainter going down. */
function seaDots(): Array<{ x: number; row: number; y: number; r: number; a: number; ph: number }> {
  const out: Array<{ x: number; row: number; y: number; r: number; a: number; ph: number }> = [];
  let y = SEA;
  for (let row = 0; y < H + 6; row++) {
    const gap = 3.2 + row * 0.55;
    for (let x = -10; x < W + 10; x += gap + Math.random() * 1.6) {
      out.push({ x, row, y: y + (Math.random() - 0.5) * 1.2, r: 0.5 + Math.random() * 0.6, a: Math.max(0.08, 0.62 - row * 0.05), ph: Math.random() * Math.PI * 2 });
    }
    y += 4 + row * 1.1;
  }
  return out;
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
    const dots = whaleDots(5200);
    const sea = seaDots();
    const drops: Drop[] = [];
    const pointer = { x: -1e4, y: -1e4 };
    let scale = 1;
    let ox = 0;
    let oy = 0;
    let raf = 0;
    let last = 0;
    let prev = 0;

    /** A drop thrown up from where the body breaks the surface. */
    const spawn = () => {
      const x = 286 + Math.random() * 52;
      drops.push({ x, y: SEA - 1, vx: (Math.random() - 0.35) * 28, vy: -(38 + Math.random() * 70), r: 0.9 + Math.random() * 1.3, life: 0 });
    };
    if (!still) for (let i = 0; i < 70; i++) { spawn(); drops[i]!.life = Math.random() * 2; }

    const fit = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      scale = Math.min(r.width / W, r.height / H) * dpr;
      ox = (canvas.width - W * scale) / 2;
      oy = canvas.height - H * scale;
    };
    const dot = (x: number, y: number, r: number, a: number) => {
      if (a <= 0.01) return;
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(ox + x * scale, oy + y * scale, r * scale, 0, Math.PI * 2);
      ctx.fill();
    };
    const draw = (t: number) => {
      const dt = prev ? Math.min(0.05, (t - prev) / 1000) : 0;
      prev = t;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const bob = still ? 0 : Math.sin(t / 2600) * 3;
      // The sea, behind the whale's underwater part and in front of nothing.
      for (const s of sea) {
        const wave = still ? 0 : Math.sin(s.x / 26 + t / 900 + s.row * 0.7) * (1.4 + s.row * 0.25);
        const tw = still ? 1 : 0.75 + 0.25 * Math.sin(t / 800 + s.ph);
        dot(s.x + (still ? 0 : Math.sin(t / 1500 + s.row) * 2), s.y + wave, s.r, s.a * tw);
      }
      for (const d of dots) {
        const sx = ox + d.x * scale;
        const sy = oy + (d.y + bob) * scale;
        const vx = sx - pointer.x;
        const vy = sy - pointer.y;
        const dist2 = vx * vx + vy * vy;
        const reach = 70 * scale;
        if (!still && !d.under && dist2 < reach * reach) {
          const len = Math.sqrt(dist2) || 1;
          const push = (1 - len / reach) * 9;
          d.dx += ((vx / len) * push - d.dx) * 0.2;
          d.dy += ((vy / len) * push - d.dy) * 0.2;
        } else {
          d.dx *= 0.9;
          d.dy *= 0.9;
        }
        // Under the surface the body wavers, as seen through water.
        const waver = d.under && !still ? Math.sin(d.y / 6 + t / 500) * 2.2 : 0;
        const tw = still ? 1 : 0.72 + 0.28 * Math.sin((t / 700) * d.sp + d.ph);
        dot(d.x + d.dx + waver, d.y + bob + d.dy, d.r, d.a * tw);
      }
      // The splash: up, then down under gravity, back into the sea.
      if (!still) {
        spawn();
        if (Math.random() < 0.6) spawn();
        for (let i = drops.length - 1; i >= 0; i--) {
          const p = drops[i]!;
          p.life += dt;
          p.vy += 95 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (p.y > SEA + 4 && p.vy > 0) { drops.splice(i, 1); continue; }
          dot(p.x, p.y, p.r, Math.min(0.85, 0.3 + p.life));
        }
        if (drops.length > 260) drops.splice(0, drops.length - 260);
      }
      ctx.globalAlpha = 1;
    };
    const loop = (t: number) => {
      if (t - last > 32) { draw(t); last = t; }
      raf = requestAnimationFrame(loop);
    };
    const paint = () => { ctx.fillStyle = getComputedStyle(el).color || '#e8e8e8'; };
    fit();
    paint();
    const ro = new ResizeObserver(() => { fit(); paint(); if (still) draw(0); });
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
