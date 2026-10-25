/**
 * The Copy page's hero art (Discover.tsx, in place of the trader card deck): a
 * humpback breaching, drawn in dots like a stipple print - no sea drawn, only the
 * water streaming off its body as it comes up.
 *
 *   The whale   sampled from a silhouette and a shade map: dense on the belly, the
 *               raised fin and along every edge, thin on its back; the head has
 *               its knobs (tubercles), the throat grooves and an eye, the raised
 *               fin a knobbly leading edge, the long fin a scalloped trailing one.
 *               Toward the tail the body thins out and dissolves into loose dots.
 *   The water   drops running off the belly and the tail, falling under gravity
 *               and fading as they go.
 *
 * The whale bobs a little, the dots twinkle and step aside from the pointer.
 * Drawn on a canvas (no image file); still under reduced motion.
 */
import { useEffect, useRef } from 'react';

/** The silhouette in a 400 x 300 box. */
const BODY = 'M52 106 C58 92 76 84 98 80 C126 75 154 76 180 84 C244 100 296 146 320 214 L334 276 C322 282 306 282 298 276 L288 246 C262 200 214 178 156 156 C110 140 70 128 54 116 Z';
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
  for (let i = 0; i < 6; i++) {
    g.beginPath();
    g.moveTo(60 + i * 2, 110 + i * 2.6);
    g.bezierCurveTo(90, 120 + i * 3.2, 120, 132 + i * 3.4, 150 + i * 4, 146 + i * 3.6);
    g.stroke();
  }
  // The tail thins out: fade the density toward its end, so the body dissolves.
  const thin = g.createLinearGradient(0, 200, 0, 282);
  thin.addColorStop(0, 'rgba(0,0,0,0)');
  thin.addColorStop(1, 'rgba(0,0,0,0.75)');
  g.fillStyle = thin;
  g.fillRect(0, 200, W, 82);
  g.restore();
  // Every edge drawn darker, so the shape reads crisply.
  g.strokeStyle = 'rgba(255,0,0,0.9)';
  g.lineWidth = 2.2;
  g.stroke(finUp);
  g.lineWidth = 1.6;
  g.stroke(finLong);
  g.lineWidth = 1.8;
  g.save();
  g.clip(new Path2D('M0 0H400V230H0Z'));
  g.stroke(body);
  g.restore();
  // The tubercles: knobs along the top of the head, and the eye.
  g.fillStyle = 'rgba(255,0,0,1)';
  for (const [x, y, r] of [[62, 98, 2.2], [72, 92, 2.4], [84, 87, 2.2], [96, 84, 2.4], [70, 99, 1.6], [82, 93, 1.8], [94, 90, 1.6], [106, 86, 1.8]] as const) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  g.beginPath();
  g.arc(118, 112, 2.6, 0, Math.PI * 2);
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
  for (let i = 0; i < count * 0.07; i++) {
    const t = Math.random();
    dots.push({ x: 296 + (Math.random() - 0.3) * 60 * (0.5 + t), y: 250 + t * 46, r: 0.5 + Math.random() * 0.7, a: 0.55 * (1 - t) + 0.08, ph: Math.random() * Math.PI * 2, sp: 0.6 + Math.random(), dx: 0, dy: 0 });
  }
  // Where water runs off: the lowest point of the body in each column from the belly to the tail.
  const drips: Array<[number, number]> = [];
  for (let x = 110; x <= 334; x += 2) {
    for (let y = H - 1; y > 60; y--) {
      if (g.isPointInPath(body, x, y)) { drips.push([x, y]); break; }
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
      const i = Math.floor(Math.pow(Math.random(), 0.55) * drips.length);
      const [x, y] = drips[Math.min(drips.length - 1, i)]!;
      drops.push({ x: x + (Math.random() - 0.5) * 3, y: y - Math.random() * 3, vx: (Math.random() - 0.5) * 5, vy: 2 + Math.random() * 10, r: 0.8 + Math.random() * 1.1, life: 0, max: 1.1 + Math.random() * 1.6 });
    };
    if (!still) for (let i = 0; i < 160; i++) { spawn(); drops[drops.length - 1]!.life = Math.random(); }

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
      const bob = still ? 0 : Math.sin(t / 2600) * 3;
      for (const d of dots) {
        const sx = ox + d.x * scale;
        const sy = oy + (d.y + bob) * scale;
        const vx = sx - pointer.x;
        const vy = sy - pointer.y;
        const dist2 = vx * vx + vy * vy;
        const reach = 70 * scale;
        if (!still && dist2 < reach * reach) {
          const len = Math.sqrt(dist2) || 1;
          const push = (1 - len / reach) * 9;
          d.dx += ((vx / len) * push - d.dx) * 0.2;
          d.dy += ((vy / len) * push - d.dy) * 0.2;
        } else {
          d.dx *= 0.9;
          d.dy *= 0.9;
        }
        const tw = still ? 1 : 0.72 + 0.28 * Math.sin((t / 700) * d.sp + d.ph);
        dot(d.x + d.dx, d.y + bob + d.dy, d.r, d.a * tw);
      }
      // The water running off: down under gravity, fading as it falls.
      if (!still) {
        for (let k = 0; k < 7; k++) spawn();
        for (let i = drops.length - 1; i >= 0; i--) {
          const p = drops[i]!;
          p.life += dt;
          p.vy += 120 * dt;
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
