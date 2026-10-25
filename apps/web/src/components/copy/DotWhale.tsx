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
 * The whole body (owner, 2026-10-26): the photo stops at the waterline, so the
 * body is carried on below it (extend()) - the tail stock narrowing along the
 * line of the tail, then a humpback's flukes across its end (notched in the
 * middle, the trailing edge serrated), strongly foreshortened as the tail runs
 * away from a camera below, so the flukes lie in the toolbar's see-through band
 * rather than behind the cards - and drawn past the hero's bottom edge, behind the toolbar and
 * the cards, blurred and dimmer there as if under water. The hero's bottom edge,
 * on the toolbar's divider line, is the surface: everything above it is sharp.
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
/** The body carried on below the photo's waterline (tone units), flukes and all, drawn under water. */
const EXT = 60;
/** The tail stock's length below the waterline, and the flukes' half-span and deepest chord (tone units). */
const STOCK = 24;
const FLUKE_SPAN = 72;
const FLUKE_CHORD = 17;
const TE = TH + EXT;

/** `bottom`: the photo's lowest row of whale (the waterline), put on the box's bottom edge. */
interface Tone { l: Float32Array; a: Float32Array; bottom: number }
interface Dot { x: number; y: number; r: number; a: number; ph: number; sp: number; dx: number; dy: number }

const sm = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The body below the waterline. The tail stock: each row's span carried on along
 * the line the tail runs (its centre's drift over the last 40 rows), narrowing to
 * about a third, its shading the average of the photo's last rows at the same
 * place across, darker with depth, with a little grain. Then the flukes across
 * the stock's end: two lobes whose leading edges sweep back from the stock and
 * whose trailing edge is serrated and notched at the middle.
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
  // The photo's last rows, averaged per place across (-1..1 of the span), for the stock's shading.
  const shade = new Float32Array(41);
  for (let k = 0; k <= 40; k++) {
    let sum = 0;
    let n = 0;
    for (let y = base - 24; y <= base; y++) {
      const r = span(y);
      if (!r) continue;
      const x = Math.round((r.lo + r.hi) / 2 + ((k - 20) / 20) * ((r.hi - r.lo) / 2) * 0.92);
      sum += l[y * TW + x]!;
      n++;
    }
    shade[k] = n ? sum / n : 0.3;
  }
  const shadeAt = (u: number) => shade[Math.round((Math.max(-1, Math.min(1, u)) + 1) * 20)]!;
  const grain = (x: number, y: number) => Math.sin(x * 12.9898 + y * 78.233) * 43758.5453 % 1;
  const put = (x: number, y: number, alpha: number, lum: number) => {
    if (x < 0 || x >= TW || y < 0 || y >= TE) return;
    const i = y * TW + x;
    if (alpha <= a[i]!) return;
    a[i] = alpha;
    l[i] = Math.max(0, Math.min(1, lum));
  };
  // The tail stock.
  const wEnd = w0 * 0.4;
  for (let y = base + 1; y <= base + STOCK; y++) {
    const d = y - base;
    const c = c0 + drift * d;
    const w = w0 - (w0 - wEnd) * sm(0, STOCK, d) ** 0.85;
    const dark = 1 - 0.15 * (d / STOCK);
    for (let x = Math.floor(c - w - 2); x <= Math.ceil(c + w + 2); x++) {
      const u = (x - c) / w;
      const edge = 1 - sm(0.9, 1.05, Math.abs(u));
      if (edge > 0) put(x, y, edge, shadeAt(u) * dark + 0.12 * Math.abs(grain(x, y)) - 0.06);
    }
  }
  // The flukes: across the stock's end, perpendicular to the tail's line.
  const len = Math.hypot(drift, 1);
  const ax = drift / len;
  const ay = 1 / len;
  const px = ay;
  const py = -ax;
  const fx = c0 + drift * STOCK;
  const fy = base + STOCK - 4;
  const sweep = 11 / FLUKE_SPAN ** 1.5;
  const lead = (sAbs: number) => sweep * sAbs ** 1.5;
  const trail = (s: number) => {
    const sAbs = Math.abs(s);
    const t = sAbs / FLUKE_SPAN;
    let chord = FLUKE_CHORD * (1 - t * t) ** 0.55 + 3;
    chord += 1.6 * Math.abs(Math.sin(s * 0.55)) * (1 - t);
    chord -= 6 * Math.exp(-(sAbs * sAbs) / 16);
    return lead(sAbs) + chord;
  };
  const depth = FLUKE_CHORD + lead(FLUKE_SPAN) + 6;
  for (let y = Math.floor(fy - 6); y <= Math.min(TE - 1, Math.ceil(fy + depth + 6)); y++) {
    for (let x = Math.floor(fx - FLUKE_SPAN - 6); x <= Math.ceil(fx + FLUKE_SPAN + 6); x++) {
      const dx = x - fx;
      const dy = y - fy;
      const s = dx * px + dy * py;
      const u = dx * ax + dy * ay;
      const sAbs = Math.abs(s);
      if (sAbs > FLUKE_SPAN) continue;
      const lo = lead(sAbs);
      const hi = trail(s);
      if (u < lo - 1.5 || u > hi + 1.5) continue;
      const edge = Math.min(sm(lo - 1.5, lo + 1, u), 1 - sm(hi - 1, hi + 1.5, u), 1 - sm(FLUKE_SPAN - 3, FLUKE_SPAN, sAbs));
      // Lighter along the leading edge (as a humpback's underside), darker toward the tips.
      const lum = 0.6 + 0.25 * (1 - sm(lo, lo + 6, u)) - 0.15 * (sAbs / FLUKE_SPAN) + 0.12 * Math.abs(grain(x, y)) - 0.06;
      if (edge > 0) put(x, y, edge, lum);
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
      // Below it: blurred, dimmer, a little more so with depth.
      const depth = canvas.height - surface;
      if (depth > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, surface, canvas.width, depth);
        ctx.clip();
        ctx.filter = `blur(${(2 * dpr).toFixed(1)}px)`;
        ctx.globalAlpha = 0.62;
        ctx.drawImage(off, 0, 0);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'destination-out';
        const fade = ctx.createLinearGradient(0, surface, 0, canvas.height);
        fade.addColorStop(0, 'rgba(0,0,0,0)');
        fade.addColorStop(1, 'rgba(0,0,0,0.45)');
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
