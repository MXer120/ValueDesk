/**
 * The Copy page's hero art (Discover.tsx, in place of the trader card deck): a
 * humpback breaching, drawn in dots like a stipple print - no sea drawn, only the
 * water running off its tail as it comes up.
 *
 *   The whale   sampled from a silhouette and a shade map: dense on the belly, the
 *               raised fin and along every edge, thin on its back; the long flat
 *               head has its knobs (tubercles), the mouth, the throat grooves and
 *               an eye, the raised fin a knobbly leading edge, the long fin a
 *               scalloped trailing one; the tail stock narrows to spread flukes
 *               that thin out into loose dots.
 *   The water   a slow trickle of drops off the flukes only, falling and fading.
 *
 * Little moves (owner, 2026-10-25): a slow small bob, a faint twinkle, a light
 * give where the pointer passes. Drawn on a canvas (no image file); still under
 * reduced motion.
 */
import { useEffect, useRef } from 'react';

/** The silhouette in a 400 x 300 box. */
const BODY = 'M38 110 C50 100 80 90 112 84 C146 77 176 80 202 90 C254 110 294 150 314 206 C320 222 322 238 322 250 L318 262 C312 264 304 264 298 262 L292 248 C282 218 252 190 210 172 C176 158 140 148 104 138 C80 132 56 124 38 116 Z';
/** The flukes, spread at the end of the tail stock, dissolving into the water running off them. */
const FLUKES = 'M302 254 C292 264 278 270 262 274 C278 280 296 279 308 272 C318 280 336 286 354 286 C344 277 332 266 322 254 Z';
/** The raised fin: a knobbly leading edge (left), a smooth trailing one. */
const FIN_UP = 'M136 92 C131 84 133 76 136 70 C133 66 136 60 139 56 C137 51 141 46 145 43 C145 38 150 34 155 33 C162 33 166 40 167 50 C169 64 167 80 161 94 C158 101 154 105 149 106 Z';
/** The long fin: a scalloped trailing edge along its underside. */
const FIN_LONG = 'M194 88 C238 66 290 52 340 52 C346 58 336 66 322 70 C318 74 310 72 304 76 C298 80 290 78 284 82 C276 86 268 84 260 88 C248 94 230 98 206 104 Z';
const W = 400;
const H = 300;

interface Dot { x: number; y: number; r: number; a: number; ph: number; sp: number; dx: number; dy: number }
interface Drop { x: number; y: number; vx: number; vy: number; r: number; life: number; max: number }

/** The whale's dots and where water runs off it (points on its underside and tail). */
function whale(count: number): { dots: Dot[]; drips: Array<[number, number]> } {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return { dots: [], drips: [] };
  const body = new Path2D(BODY);
  const finUp = new Path2D(FIN_UP);
  const finLong = new Path2D(FIN_LONG);
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  // The shade map (red channel = density): the back light, the belly dark.
  const shade = g.createLinearGradient(150, 66, 226, 220);
  shade.addColorStop(0, 'rgb(38,0,0)');
  shade.addColorStop(0.5, 'rgb(130,0,0)');
  shade.addColorStop(1, 'rgb(235,0,0)');
  g.fillStyle = shade;
  g.fill(body);
  g.fillStyle = 'rgb(250,0,0)';
  g.fill(finUp);
  g.fillStyle = 'rgb(110,0,0)';
  g.fill(finLong);
  const flukes = new Path2D(FLUKES);
  g.fillStyle = 'rgb(150,0,0)';
  g.fill(flukes);
  g.save();
  g.clip(body);
  // Where the fin meets the body, in shadow.
  const blot = g.createRadialGradient(176, 120, 2, 176, 120, 44);
  blot.addColorStop(0, 'rgba(255,0,0,0.9)');
  blot.addColorStop(1, 'rgba(255,0,0,0)');
  g.fillStyle = blot;
  g.fillRect(0, 0, W, H);
  // The throat grooves: dark lines from the jaw back along the underside.
  g.strokeStyle = 'rgba(255,0,0,0.85)';
  g.lineWidth = 1.6;
  for (let i = 0; i < 7; i++) {
    g.beginPath();
    g.moveTo(52 + i * 3, 117 + i * 2.2);
    g.bezierCurveTo(84, 124 + i * 2.8, 118, 134 + i * 3, 156 + i * 4, 148 + i * 3.4);
    g.stroke();
  }
  // The mouth: from the tip of the head back under the eye.
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(40, 113);
  g.bezierCurveTo(66, 116, 96, 118, 124, 124);
  g.stroke();
  g.restore();
  // Toward the flukes the dots thin out, so the tail dissolves into its water.
  const thin = g.createLinearGradient(0, 228, 0, 290);
  thin.addColorStop(0, 'rgba(0,0,0,0)');
  thin.addColorStop(1, 'rgba(0,0,0,0.6)');
  g.fillStyle = thin;
  g.fillRect(250, 228, 150, 62);
  // Every edge drawn darker, so the shape reads crisply.
  g.strokeStyle = 'rgba(255,0,0,0.9)';
  g.lineWidth = 2.2;
  g.stroke(finUp);
  g.lineWidth = 1.6;
  g.stroke(finLong);
  g.lineWidth = 1.8;
  g.stroke(body);
  g.lineWidth = 1.2;
  g.stroke(flukes);
  // The tubercles: knobs along the top of the head, and the eye.
  g.fillStyle = 'rgba(255,0,0,1)';
  for (const [x, y, r] of [[50, 103, 1.9], [62, 97, 2.2], [74, 92, 2.3], [87, 88, 2.2], [100, 85, 2.2], [58, 104, 1.5], [70, 99, 1.7], [83, 94, 1.6], [96, 90, 1.7], [109, 87, 1.5]] as const) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  g.beginPath();
  g.arc(128, 116, 2.6, 0, Math.PI * 2);
  g.fill();

  const px = g.getImageData(0, 0, W, H).data;
  const density = (x: number, y: number) => px[(Math.floor(y) * W + Math.floor(x)) * 4]! / 255;
  const dots: Dot[] = [];
  let tries = 0;
  while (dots.length < count && tries < count * 45) {
    tries++;
    const x = Math.random() * W;
    const y = Math.random() * H;
    const d = density(x, y);
    if (d <= 0 || Math.random() > d) continue;
    dots.push({ x, y, r: 0.5 + Math.random() * 0.7 * (0.5 + d), a: 0.3 + d * 0.7, ph: Math.random() * Math.PI * 2, sp: 0.6 + Math.random() * 1.4, dx: 0, dy: 0 });
  }
  // The tail dissolving: loose dots scattered below and beside its end.
  for (let i = 0; i < count * 0.035; i++) {
    const t = Math.random();
    dots.push({ x: 262 + Math.random() * 92, y: 276 + t * 18, r: 0.5 + Math.random() * 0.7, a: 0.55 * (1 - t) + 0.08, ph: Math.random() * Math.PI * 2, sp: 0.6 + Math.random(), dx: 0, dy: 0 });
  }
  // Where water runs off: the lowest point of the body in each column from the belly to the tail.
  const drips: Array<[number, number]> = [];
  for (let x = 262; x <= 354; x += 2) {
    for (let y = H - 1; y > 230; y--) {
      if (g.isPointInPath(flukes, x, y) || g.isPointInPath(body, x, y)) { drips.push([x, y]); break; }
    }
  }
  return { dots, drips };
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
    const { dots, drips } = whale(5600);
    const drops: Drop[] = [];
    const pointer = { x: -1e4, y: -1e4 };
    let scale = 1;
    let ox = 0;
    let oy = 0;
    let raf = 0;
    let last = 0;
    let prev = 0;

    /** A drop running off the body: more off the tail, where the whale left the water last. */
    const spawn = () => {
      if (!drips.length) return;
      const i = Math.floor(Math.random() * drips.length);
      const [x, y] = drips[Math.min(drips.length - 1, i)]!;
      drops.push({ x: x + (Math.random() - 0.5) * 3, y: y - Math.random() * 3, vx: (Math.random() - 0.5) * 2, vy: 1 + Math.random() * 5, r: 0.7 + Math.random() * 0.9, life: 0, max: 1.4 + Math.random() * 1.8 });
    };
    if (!still) for (let i = 0; i < 45; i++) { spawn(); drops[drops.length - 1]!.life = Math.random() * 1.4; }

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
      const bob = still ? 0 : Math.sin(t / 4200) * 1.4;
      for (const d of dots) {
        const sx = ox + d.x * scale;
        const sy = oy + (d.y + bob) * scale;
        const vx = sx - pointer.x;
        const vy = sy - pointer.y;
        const dist2 = vx * vx + vy * vy;
        const reach = 70 * scale;
        if (!still && dist2 < reach * reach) {
          const len = Math.sqrt(dist2) || 1;
          const push = (1 - len / reach) * 3.5;
          d.dx += ((vx / len) * push - d.dx) * 0.2;
          d.dy += ((vy / len) * push - d.dy) * 0.2;
        } else {
          d.dx *= 0.9;
          d.dy *= 0.9;
        }
        const tw = still ? 1 : 0.88 + 0.12 * Math.sin((t / 1300) * d.sp + d.ph);
        dot(d.x + d.dx, d.y + bob + d.dy, d.r, d.a * tw);
      }
      // The water running off: down under gravity, fading as it falls.
      if (!still) {
        if (Math.random() < 0.7) spawn();
        for (let i = drops.length - 1; i >= 0; i--) {
          const p = drops[i]!;
          p.life += dt;
          p.vy += 55 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (p.life > p.max || p.y > H + 4) { drops.splice(i, 1); continue; }
          dot(p.x, p.y + bob, p.r, 0.9 * (1 - p.life / p.max));
        }
        if (drops.length > 700) drops.splice(0, drops.length - 700);
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
