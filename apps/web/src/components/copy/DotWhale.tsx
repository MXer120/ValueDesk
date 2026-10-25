/**
 * The Copy page's hero art (Discover.tsx, in place of the trader card deck): a
 * humpback breaching, seen from below - throat pleats and both flippers - in dots
 * like a stipple print, the dots denser where the photo is lighter, faint round
 * stars around it.
 *
 * The photo is cut out along its outline and kept as a tone map
 * (whale-tone-belly.png: grey = the photo's light, alpha = the whale), mirrored so
 * it heads left, its upper body bent a little further over, and equalised over
 * the whale so its dark skin spreads over the whole range. The map is inlined in
 * the page's code (no second request), and read as soon as this module loads.
 *
 * The whole body (owner, 2026-10-25): the photo stops at the waterline, so the
 * body is carried on below it (extend()) - along the line of the tail, narrowing
 * - and drawn past the hero's bottom edge, behind the toolbar and the cards,
 * blurred and fading there as if under water. The hero's own edge is the
 * surface: everything above it is sharp.
 *
 * Little moves: a slow small dip, the dots giving where the pointer passes, the
 * stars twinkling. Still under reduced motion.
 */
import { useEffect, useRef } from 'react';
import toneUrl from './whale-tone-belly.png?inline';

/** The tone map's size; the box adds a little room either side. */
const TW = 478;
const TH = 252;
const PAD = 18;
const W = TW + PAD * 2;
/** How far the whale sinks past the box's bottom edge (tone units). */
const SINK = 5;
/** The body carried on below the photo's waterline (tone units), and drawn under water. */
const EXT = 90;
const TE = TH + EXT;

/** `bottom`: the photo's lowest row of whale (the waterline), put on the box's bottom edge. */
interface Tone { l: Float32Array; a: Float32Array; bottom: number }
interface Dot { x: number; y: number; r: number; a: number; ph: number; sp: number; dx: number; dy: number }

const sm = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The body below the waterline: each row's span carried on along the line the
 * tail runs (its centre's drift over the last 40 rows), narrowing a little, its
 * grain taken from the rows above so it does not repeat as stripes.
 */
function extend(l: Float32Array, a: Float32Array, bottom: number): void {
  const span = (y: number) => {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < TW; x++) if (a[y * TW + x]! > 0.5) { if (lo < 0) lo = x; hi = x; }
    return lo < 0 ? null : { lo, hi };
  };
  const base = bottom - 3;
  const last = span(base);
  const up = span(Math.max(0, base - 40));
  if (!last) return;
  const c0 = (last.lo + last.hi) / 2;
  const w0 = (last.hi - last.lo) / 2;
  const drift = up ? (c0 - (up.lo + up.hi) / 2) / 40 : 0;
  for (let y = base + 1; y < TE; y++) {
    const d = y - base;
    const c = c0 + drift * d;
    const w = w0 * (1 - 0.35 * sm(0, EXT, d));
    for (let x = Math.max(0, Math.floor(c - w - 2)); x <= Math.min(TW - 1, Math.ceil(c + w + 2)); x++) {
      const u = (x - c) / w;
      const edge = 1 - sm(0.92, 1.05, Math.abs(u));
      if (edge <= 0) continue;
      const sx = Math.round(c0 + u * w0);
      const sy = base - 1 - ((d * 7) % 36);
      const i = y * TW + x;
      a[i] = edge;
      l[i] = l[sy * TW + Math.min(TW - 1, Math.max(0, sx))]!;
    }
  }
}

let toneOnce: Promise<Tone> | null = null;
function loadTone(): Promise<Tone> {
  toneOnce ??= new Promise<Tone>((ok, fail) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = TW;
      c.height = TH;
      const g = c.getContext('2d', { willReadFrequently: true });
      if (!g) { fail(new Error('no canvas')); return; }
      g.drawImage(img, 0, 0, TW, TH);
      const px = g.getImageData(0, 0, TW, TH).data;
      const n = TW * TH;
      const raw = new Uint8Array(n);
      const a = new Float32Array(TW * TE);
      const hist = new Float64Array(256);
      let total = 0;
      for (let i = 0; i < n; i++) {
        raw[i] = px[i * 4]!;
        a[i] = px[i * 4 + 3]! / 255;
        if (a[i]! > 0.5) { hist[raw[i]!]!++; total++; }
      }
      const cdf = new Float32Array(256);
      let run = 0;
      for (let v = 0; v < 256; v++) { run += hist[v]!; cdf[v] = total ? run / total : v / 255; }
      const l = new Float32Array(TW * TE);
      for (let i = 0; i < n; i++) l[i] = cdf[raw[i]!]!;
      let bottom = TH;
      for (let y = TH - 1; y > 0; y--) {
        let row = 0;
        for (let x = 0; x < TW; x++) row = Math.max(row, a[y * TW + x]!);
        if (row > 0.5) { bottom = y + 1; break; }
      }
      extend(l, a, bottom);
      ok({ l, a, bottom });
    };
    img.onerror = () => fail(new Error('whale tone did not load'));
    img.src = toneUrl;
  });
  return toneOnce;
}
// Started with the module, not with the first render.
if (typeof window !== 'undefined') void loadTone().catch(() => {});

/** A tone map value at (x, y), bilinear; 0 outside. */
function samp(f: Float32Array, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= TW - 1 || y >= TE - 1) return 0;
  const xi = x | 0;
  const yi = y | 0;
  const fx = x - xi;
  const fy = y - yi;
  const i = yi * TW + xi;
  return (f[i]! * (1 - fx) + f[i + 1]! * fx) * (1 - fy) + (f[i + TW]! * (1 - fx) + f[i + TW + 1]! * fx) * fy;
}

/** The stipple: dots dropped where the whale is, kept more often where it is light. */
function stipple(t: Tone, count: number): Dot[] {
  const dots: Dot[] = [];
  let tries = 0;
  while (dots.length < count && tries < count * 40) {
    tries++;
    const x = Math.random() * TW;
    const y = Math.random() * TE;
    if (samp(t.a, x, y) < 0.5) continue;
    const v = 0.07 + 0.93 * Math.pow(samp(t.l, x, y), 1.5);
    if (Math.random() > v) continue;
    dots.push({ x, y, r: 0.4 + Math.random() * 0.45 * (0.5 + v), a: 0.3 + 0.7 * v, ph: Math.random() * Math.PI * 2, sp: 0.6 + Math.random() * 1.4, dx: 0, dy: 0 });
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
    // The dots are drawn here first, then onto the canvas twice: sharp above the surface, blurred below.
    const off = document.createElement('canvas');
    const octx = off.getContext('2d');
    if (!ctx || !octx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let tone: Tone | null = null;
    let dots: Dot[] = [];
    const stars = Array.from({ length: 120 }, () => ({ x: Math.random(), y: Math.random(), s: Math.random() < 0.15 ? 2 : 1, a: 0.15 + Math.random() * 0.6, ph: Math.random() * Math.PI * 2, sp: 0.3 + Math.random() * 0.8 }));
    const pointer = { x: -1e4, y: -1e4 };
    let scale = 1;
    let ox = 0;
    let oy = 0;
    /** The surface (the box's bottom edge), in canvas pixels. */
    let surface = 0;
    let raf = 0;
    let last = 0;
    let gone = false;

    const fit = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cssScale = Math.min(r.width / W, r.height / TH);
      const below = EXT * cssScale;
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round((r.height + below) * dpr));
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height + below}px`;
      off.width = canvas.width;
      off.height = canvas.height;
      scale = cssScale * dpr;
      surface = Math.round(r.height * dpr);
      ox = Math.round((canvas.width - W * scale) / 2 + PAD * scale);
      oy = Math.round(surface - ((tone?.bottom ?? TH) - SINK) * scale);
    };
    const draw = (t: number) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!tone) return;
      const color = getComputedStyle(el).color || '#e8e8e8';
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      ctx.fillStyle = color;
      for (const s of stars) {
        ctx.globalAlpha = s.a * (still ? 1 : 0.55 + 0.45 * Math.sin((t / 1000) * s.sp + s.ph));
        ctx.beginPath();
        ctx.arc(Math.round(s.x * canvas.width), Math.round(s.y * surface), s.s * 0.6 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      octx.clearRect(0, 0, off.width, off.height);
      octx.fillStyle = color;
      const bob = still ? 0 : (1 - Math.cos(t / 4200)) * 0.8;
      const reach = 70 * scale;
      for (const d of dots) {
        const vx = ox + d.x * scale - pointer.x;
        const vy = oy + (d.y + bob) * scale - pointer.y;
        const dist2 = vx * vx + vy * vy;
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
        if (d.a * tw <= 0.01) continue;
        octx.globalAlpha = d.a * tw;
        octx.beginPath();
        octx.arc(ox + (d.x + d.dx) * scale, oy + (d.y + bob + d.dy) * scale, d.r * scale, 0, Math.PI * 2);
        octx.fill();
      }
      // Above the surface: sharp.
      ctx.globalAlpha = 1;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, surface);
      ctx.clip();
      ctx.drawImage(off, 0, 0);
      ctx.restore();
      // Below it: blurred, dimmer, fading out with depth.
      const depth = canvas.height - surface;
      if (depth > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, surface, canvas.width, depth);
        ctx.clip();
        ctx.filter = `blur(${(2.4 * dpr).toFixed(1)}px)`;
        ctx.globalAlpha = 0.6;
        ctx.drawImage(off, 0, 0);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'destination-out';
        const fade = ctx.createLinearGradient(0, surface, 0, canvas.height);
        fade.addColorStop(0, 'rgba(0,0,0,0)');
        fade.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = fade;
        ctx.fillRect(0, surface, canvas.width, depth);
        ctx.restore();
      }
    };
    const loop = (t: number) => {
      if (t - last > 32) { draw(t); last = t; }
      raf = requestAnimationFrame(loop);
    };

    fit();
    const ro = new ResizeObserver(() => { fit(); if (still) draw(0); });
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
    loadTone().then((t) => {
      if (gone) return;
      tone = t;
      dots = stipple(t, 10000);
      fit();
      if (still) draw(0);
    }).catch(() => { /* no art, the hero still reads */ });
    if (!still) raf = requestAnimationFrame(loop);
    return () => {
      gone = true;
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
