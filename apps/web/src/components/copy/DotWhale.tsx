/**
 * The Copy page's hero art (Discover.tsx, in place of the trader card deck): a
 * humpback breaching (drawn from a photo), in dots like a stipple print - no sea
 * drawn, only the water falling off it where it leaves the surface.
 *
 *   The whale   sampled from a silhouette and a shade map: dense on the belly, the
 *               flank and along every edge, light on its back and head top; the
 *               long rostrum with its knobs (tubercles), the mouth, the throat
 *               grooves and an eye; the pectoral fin with its knobbly leading edge.
 *   The water   a slow trickle off its back near the surface, spray at its base.
 *
 * Little moves (owner, 2026-10-25): a slow small bob, a faint twinkle, a light
 * give where the pointer passes. Drawn on a canvas (no image file); still under
 * reduced motion.
 */
import { useEffect, useRef } from 'react';

/**
 * The silhouette in a 400 x 300 box, drawn from a photo of a breaching humpback:
 * the long rostrum up and to the left, the head's flat top, the back arching down
 * to where the body leaves the water (bottom right, no tail showing), the throat
 * and belly beneath.
 */
const BODY = 'M44 108 C50 97 66 90 88 87 C120 83 160 81 196 85 C232 89 263 100 290 118 C330 145 362 187 381 234 C389 254 393 268 396 282 L300 282 C292 254 270 224 244 205 C212 185 176 169 140 157 C108 147 80 135 62 125 C54 121 47 115 44 108 Z';
/** The pectoral fin, reaching up and to the right from behind the head; knobs along its leading (top) edge. */
const FIN = 'M226 138 C238 118 262 102 288 92 C292 87 298 88 302 85 C306 80 312 81 316 78 C320 74 327 75 331 73 C336 69 343 70 348 69 C356 66 364 66 372 67 C381 67 389 70 391 76 C392 83 386 89 377 93 C346 104 306 121 270 148 Z';
const W = 400;
const H = 300;
/** Where the body leaves the water. */
const WATERLINE = 282;

interface Dot { x: number; y: number; r: number; a: number; ph: number; sp: number; dx: number; dy: number }
interface Drop { x: number; y: number; vx: number; vy: number; r: number; life: number; max: number }

/** The whale's dots, and where water falls off it (the back's lower stretch near the surface). */
function whale(count: number): { dots: Dot[]; drips: Array<[number, number]> } {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return { dots: [], drips: [] };
  const body = new Path2D(BODY);
  const fin = new Path2D(FIN);
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  // The shade map (red channel = dot density). As in the photo: the back and the
  // head's top catch the light (sparse), the flank and belly are dark (dense).
  const shade = g.createLinearGradient(190, 84, 150, 190);
  shade.addColorStop(0, 'rgb(70,0,0)');
  shade.addColorStop(0.45, 'rgb(150,0,0)');
  shade.addColorStop(1, 'rgb(245,0,0)');
  g.fillStyle = shade;
  g.fill(body);
  g.save();
  g.clip(body);
  // The flank toward the water: dark, thinning where the body is still wet with spray.
  const flank = g.createLinearGradient(260, 140, 360, 260);
  flank.addColorStop(0, 'rgba(255,0,0,0)');
  flank.addColorStop(0.5, 'rgba(255,0,0,0.5)');
  flank.addColorStop(1, 'rgba(255,0,0,0.2)');
  g.fillStyle = flank;
  g.fillRect(0, 0, W, H);
  // The shadow under the fin's root.
  const root = g.createRadialGradient(240, 150, 2, 240, 150, 40);
  root.addColorStop(0, 'rgba(255,0,0,0.95)');
  root.addColorStop(1, 'rgba(255,0,0,0)');
  g.fillStyle = root;
  g.fillRect(0, 0, W, H);
  // The throat grooves: long lines from the chin back along the underside.
  g.strokeStyle = 'rgba(255,0,0,0.9)';
  g.lineWidth = 1.5;
  for (let i = 0; i < 8; i++) {
    g.beginPath();
    g.moveTo(60 + i * 4, 122 + i * 3);
    g.bezierCurveTo(110, 136 + i * 3.4, 170, 156 + i * 3.4, 236 + i * 3, 196 + i * 3.6);
    g.stroke();
  }
  // The mouth: from the rostrum's tip back to under the eye.
  g.lineWidth = 2.2;
  g.beginPath();
  g.moveTo(46, 110);
  g.bezierCurveTo(80, 114, 120, 118, 160, 128);
  g.stroke();
  // The head's top: light.
  const top = g.createLinearGradient(0, 84, 0, 104);
  top.addColorStop(0, 'rgba(0,0,0,0.55)');
  top.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = top;
  g.fillRect(40, 80, 200, 26);
  g.restore();
  // Where it leaves the water, the last part above the surface thins into spray.
  const wet = g.createLinearGradient(0, 238, 0, WATERLINE);
  wet.addColorStop(0, 'rgba(0,0,0,0)');
  wet.addColorStop(1, 'rgba(0,0,0,0.7)');
  g.fillStyle = wet;
  g.fillRect(280, 238, 120, WATERLINE - 238);
  // The fin: its top light (sparse), its edge drawn dense.
  g.fillStyle = 'rgb(55,0,0)';
  g.fill(fin);
  g.strokeStyle = 'rgba(255,0,0,0.95)';
  g.lineWidth = 2;
  g.stroke(fin);
  // Every edge of the body darker, so the shape reads crisply (not along the surface).
  g.save();
  g.clip(new Path2D('M0 0H400V250H0Z'));
  g.lineWidth = 1.8;
  g.stroke(body);
  g.restore();
  // The knobs on the head and along the fin's leading edge, and the eye.
  g.fillStyle = 'rgba(255,0,0,1)';
  const dotAt = (x: number, y: number, r: number) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
  for (const [x, y, r] of [[56, 99, 1.7], [68, 94, 2], [81, 91, 2.1], [95, 89, 2], [109, 88, 1.9], [124, 87, 1.8], [62, 103, 1.4], [75, 98, 1.6], [89, 95, 1.5], [103, 93, 1.6], [118, 92, 1.4]] as const) dotAt(x, y, r);
  for (const [x, y] of [[296, 86], [309, 80], [322, 76], [336, 72], [351, 68], [366, 67], [380, 68]] as const) dotAt(x, y, 2.3);
  dotAt(164, 124, 2.8);

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
  // The spray it leaves the water through: loose dots around its base, thinning outward.
  for (let i = 0; i < count * 0.04; i++) {
    const t = Math.random();
    dots.push({ x: 288 + Math.random() * 118, y: WATERLINE - 14 + t * 18, r: 0.5 + Math.random() * 0.7, a: 0.5 * (1 - t) + 0.06, ph: Math.random() * Math.PI * 2, sp: 0.6 + Math.random(), dx: 0, dy: 0 });
  }
  // Where water falls off: the back's lower stretch near the surface.
  const drips: Array<[number, number]> = [];
  for (let y = 200; y <= WATERLINE - 4; y += 2) {
    for (let x = W - 1; x > 250; x--) {
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
