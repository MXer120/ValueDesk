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
 * and belly beneath. The outline is roughened afterwards (see rough()), since a
 * real whale's skin is knobbly and scarred, never a clean curve.
 */
const BODY = 'M44 108 C50 97 66 90 88 87 C120 83 160 81 196 85 C232 89 263 100 290 118 C326 144 354 184 368 226 C376 248 380 266 381 282 L322 282 C314 256 292 228 256 207 C220 187 180 170 140 157 C108 147 80 135 62 125 C54 121 47 115 44 108 Z';
const W = 400;
const H = 300;
/** Where the body leaves the water. */
const WATERLINE = 282;

type Pt = [number, number];

/** Points along a path of absolute M / C / L / Z commands, about every `step` px. */
function flatten(d: string, step = 1.5): Pt[] {
  const tok = d.match(/[MCLZ]|-?\d*\.?\d+/g) ?? [];
  const pts: Pt[] = [];
  let i = 0;
  let cur: Pt = [0, 0];
  const num = () => Number(tok[i++]);
  while (i < tok.length) {
    const cmd = tok[i++];
    if (cmd === 'M') { cur = [num(), num()]; pts.push(cur); }
    else if (cmd === 'L') {
      const to: Pt = [num(), num()];
      const n = Math.max(1, Math.ceil(Math.hypot(to[0] - cur[0], to[1] - cur[1]) / step));
      for (let k = 1; k <= n; k++) pts.push([cur[0] + (to[0] - cur[0]) * k / n, cur[1] + (to[1] - cur[1]) * k / n]);
      cur = to;
    } else if (cmd === 'C') {
      const a: Pt = [num(), num()];
      const b: Pt = [num(), num()];
      const to: Pt = [num(), num()];
      const len = Math.hypot(a[0] - cur[0], a[1] - cur[1]) + Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(to[0] - b[0], to[1] - b[1]);
      const n = Math.max(2, Math.ceil(len / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const u = 1 - t;
        pts.push([
          u * u * u * cur[0] + 3 * u * u * t * a[0] + 3 * u * t * t * b[0] + t * t * t * to[0],
          u * u * u * cur[1] + 3 * u * u * t * a[1] + 3 * u * t * t * b[1] + t * t * t * to[1],
        ]);
      }
      cur = to;
    }
  }
  return pts;
}

/**
 * The outline pushed in and out along its normal: uneven skin everywhere, and the
 * knobs (tubercles) standing proud along the head's top. Fixed phases, so the
 * whale is the same on every load. The waterline itself stays straight.
 */
function rough(pts: Pt[]): Pt[] {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[(i + 1) % pts.length]!;
    area += x1 * y2 - x2 * y1;
  }
  const out = area > 0 ? -1 : 1;
  let s = 0;
  return pts.map(([x, y], i) => {
    const [px, py] = pts[(i - 1 + pts.length) % pts.length]!;
    const [nx, ny] = pts[(i + 1) % pts.length]!;
    s += Math.hypot(x - px, y - py);
    if (y > WATERLINE - 3) return [x, y] as Pt;
    const tx = nx - px;
    const ty = ny - py;
    const tl = Math.hypot(tx, ty) || 1;
    let k = 1.4 * Math.sin(s / 9 + 1.3) + 1 * Math.sin(s / 3.7 + 0.4) + 0.6 * Math.sin(s / 1.9 + 2.2);
    // The head's top, rostrum tip to behind the blowhole: a row of knobs.
    if (x < 175 && y < 100) k += 3.4 * Math.pow(Math.max(0, Math.sin(s / 2.6)), 3);
    // The chin and throat: barnacle lumps.
    if (x < 120 && y > 108) k += 2.6 * Math.pow(Math.max(0, Math.sin(s / 3.3 + 1)), 4);
    return [x + out * (ty / tl) * k, y - out * (tx / tl) * k] as Pt;
  });
}

/**
 * The pectoral fin, built along a curved spine from its root behind the head to
 * the tip: narrow and long like a humpback's (about a third of the body), widest
 * near the root, its leading (upper) edge scalloped with big knobs, its trailing
 * edge almost straight with a few nicks.
 */
function flipper(): Pt[] {
  const root: Pt = [236, 152];
  const ctl: Pt = [296, 86];
  const tip: Pt = [392, 70];
  const n = 120;
  const lead: Pt[] = [];
  const trail: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const x = u * u * root[0] + 2 * u * t * ctl[0] + t * t * tip[0];
    const y = u * u * root[1] + 2 * u * t * ctl[1] + t * t * tip[1];
    const dx = 2 * u * (ctl[0] - root[0]) + 2 * t * (tip[0] - ctl[0]);
    const dy = 2 * u * (ctl[1] - root[1]) + 2 * t * (tip[1] - ctl[1]);
    const dl = Math.hypot(dx, dy);
    const ux = dy / dl;
    const uy = -dx / dl;
    const w = t < 0.2 ? 13 + (t / 0.2) * 5 : 18 * (1 - Math.pow((t - 0.2) / 0.8, 1.9)) + 2;
    const fade = t < 0.1 ? 0 : Math.min(1, (t - 0.1) / 0.08) * (1 - t * 0.55);
    const knob = 4 * fade * Math.pow(Math.abs(Math.sin(t * Math.PI * 11)), 0.55);
    const nick = 0.5 * Math.sin(t * 61) + 0.35 * Math.sin(t * 23 + 1);
    lead.push([x + ux * (w * 0.55 + knob), y + uy * (w * 0.55 + knob)]);
    trail.push([x - ux * (w * 0.45 + nick * (1 - t)), y - uy * (w * 0.45 + nick * (1 - t))]);
  }
  return [...lead, ...trail.reverse()];
}

const toPath = (pts: Pt[]) => {
  const p = new Path2D();
  pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
  p.closePath();
  return p;
};

interface Dot { x: number; y: number; r: number; a: number; ph: number; sp: number; dx: number; dy: number }
interface Drop { x: number; y: number; vx: number; vy: number; r: number; life: number; max: number }

/** The whale's dots, and where water falls off it (the back's lower stretch near the surface). */
function whale(count: number): { dots: Dot[]; drips: Array<[number, number]> } {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return { dots: [], drips: [] };
  const body = toPath(rough(flatten(BODY)));
  const fin = toPath(flipper());
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
  g.fillRect(300, 238, 100, WATERLINE - 238);
  // Every edge of the body darker, so the shape reads crisply (not along the surface).
  g.save();
  g.clip(new Path2D('M0 0H400V250H0Z'));
  g.strokeStyle = 'rgba(255,0,0,0.95)';
  g.lineWidth = 1.8;
  g.stroke(body);
  g.restore();
  // The fin, drawn last so it covers the body behind it: its upper face light
  // (sparse), a shadow along the trailing edge, its whole edge dense.
  // A thin empty gap around it, so it reads as standing in front of the body.
  g.strokeStyle = '#000';
  g.lineWidth = 6;
  g.stroke(fin);
  g.fillStyle = 'rgb(120,0,0)';
  g.fill(fin);
  g.save();
  g.clip(fin);
  g.strokeStyle = 'rgba(255,0,0,0.8)';
  g.lineWidth = 12;
  g.beginPath();
  g.moveTo(228, 166);
  g.quadraticCurveTo(292, 104, 392, 82);
  g.stroke();
  g.restore();
  g.strokeStyle = 'rgba(255,0,0,0.95)';
  g.lineWidth = 2;
  g.stroke(fin);
  // The knobs on the head, and the eye.
  g.fillStyle = 'rgba(255,0,0,1)';
  const dotAt = (x: number, y: number, r: number) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
  for (const [x, y, r] of [[56, 99, 1.7], [68, 94, 2], [81, 91, 2.1], [95, 89, 2], [109, 88, 1.9], [124, 87, 1.8], [62, 103, 1.4], [75, 98, 1.6], [89, 95, 1.5], [103, 93, 1.6], [118, 92, 1.4]] as const) dotAt(x, y, r);
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
    dots.push({ x: 312 + Math.random() * 80, y: WATERLINE - 14 + t * 18, r: 0.5 + Math.random() * 0.7, a: 0.5 * (1 - t) + 0.06, ph: Math.random() * Math.PI * 2, sp: 0.6 + Math.random(), dx: 0, dy: 0 });
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
