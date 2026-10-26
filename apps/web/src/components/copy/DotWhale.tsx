/**
 * The Copy page's hero art (Discover.tsx, in place of the trader card deck): a
 * humpback, the whole animal from snout to flukes, in dots like a stipple print -
 * the dots denser where the photo is lighter - with faint round stars around it.
 *
 * The photo (owner, 2026-10-26: a full-body humpback cut out on white) is cut
 * out, its outline smoothed a little and its head smoothed right out (owner,
 * 2026-10-26: "doesn't need to be fully realistic there"), mirrored so it heads
 * left and tilted 22 degrees into a breach - no part of it bent or moved - and
 * kept as a tone map
 * (whale-tone.png: grey = the photo's light, alpha = the whale), equalised over
 * the whale so its dark skin spreads over the whole range. The map is inlined in
 * the page's code (no second request), and read as soon as this module loads.
 *
 * The surface is the hero's bottom edge, on the toolbar's divider line. Above
 * it - the head, both flippers, the front of the body (rows above WATERLINE) - the
 * whale is sharp and fills the hero's box; below it the rest of the body and the
 * flukes run on behind the toolbar and the cards, blurred and dimmer as if under
 * water. The sharp body stays whole down to the surface, gives way over a band
 * below it to a lightly blurred one at full strength, and that to the blurred,
 * dimmer one - so the whale sinks into the water with no step in its brightness.
 *
 * Little moves: a slow small dip, the dots giving where the pointer passes, the
 * stars twinkling. Still under reduced motion.
 */
import { useEffect, useRef } from 'react';
import toneUrl from './whale-tone.png?inline';

/** The tone map's size, and its row on the surface; the box adds a little room either side. */
const TW = 478;
const TH = 831;
const WATERLINE = 382;
const PAD = 44;
const W = TW + PAD * 2;
/** The band below the surface over which sharp turns to under water (CSS px). */
const SURFACE_BAND = 26;

interface Tone { l: Float32Array; a: Float32Array }

const sm = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
interface Dot { x: number; y: number; r: number; a: number; ph: number; sp: number; dx: number; dy: number }

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
      const a = new Float32Array(n);
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
      const l = new Float32Array(n);
      for (let i = 0; i < n; i++) l[i] = cdf[raw[i]!]!;
      ok({ l, a });
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
  if (x < 0 || y < 0 || x >= TW - 1 || y >= TH - 1) return 0;
  const xi = x | 0;
  const yi = y | 0;
  const fx = x - xi;
  const fy = y - yi;
  const i = yi * TW + xi;
  return (f[i]! * (1 - fx) + f[i + 1]! * fx) * (1 - fy) + (f[i + TW]! * (1 - fx) + f[i + TW + 1]! * fx) * fy;
}

/**
 * The stipple: dots dropped where the whale is, kept more often where it is light -
 * the dark skin (the raised flipper) still dotted, so it reads as skin, not a hole -
 * and dense along the outline whatever the skin there, so the silhouette reads as a
 * smooth line even where the whale is dark.
 */
function stipple(t: Tone, count: number): Dot[] {
  const dots: Dot[] = [];
  let tries = 0;
  while (dots.length < count && tries < count * 40) {
    tries++;
    const x = Math.random() * TW;
    const y = Math.random() * TH;
    const edge = samp(t.a, x, y);
    if (edge < 0.04) continue;
    let v = 0.16 + 0.84 * Math.pow(samp(t.l, x, y), 1.5);
    if (edge < 0.92) v = Math.max(v, 0.62);
    if (Math.random() > v * sm(0.1, 0.5, edge)) continue;
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
    const low = document.createElement('canvas');
    const lctx = low.getContext('2d');
    const mid = document.createElement('canvas');
    const mctx = mid.getContext('2d');
    if (!ctx || !octx || !lctx || !mctx) return;
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
      const cssScale = Math.min(r.width / W, r.height / WATERLINE);
      const below = (TH - WATERLINE) * cssScale;
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round((r.height + below) * dpr));
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height + below}px`;
      off.width = low.width = mid.width = canvas.width;
      off.height = low.height = mid.height = canvas.height;
      scale = cssScale * dpr;
      surface = Math.round(r.height * dpr);
      ox = Math.round((canvas.width - W * scale) / 2 + PAD * scale);
      oy = Math.round(surface - WATERLINE * scale);
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
      octx.globalCompositeOperation = 'source-over';
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
      // Under water: blurred and dimmer, a little more so with depth, coming in over the band.
      const band = SURFACE_BAND * dpr;
      const top = surface;
      lctx.globalCompositeOperation = 'source-over';
      lctx.clearRect(0, 0, low.width, low.height);
      lctx.filter = `blur(${(2 * dpr).toFixed(1)}px)`;
      lctx.drawImage(off, 0, 0);
      lctx.filter = 'none';
      lctx.globalCompositeOperation = 'destination-in';
      const at = (y: number) => Math.min(1, Math.max(0, y / low.height));
      const under = lctx.createLinearGradient(0, 0, 0, low.height);
      under.addColorStop(at(surface + band), 'rgba(0,0,0,0)');
      under.addColorStop(at(surface + band * 3), 'rgba(0,0,0,0.85)');
      under.addColorStop(at(surface + band * 6), 'rgba(0,0,0,0.62)');
      under.addColorStop(1, 'rgba(0,0,0,0.34)');
      lctx.fillStyle = under;
      lctx.fillRect(0, 0, low.width, low.height);
      // Just under the surface: lightly blurred at full strength, between the sharp body and the blurred one.
      mctx.globalCompositeOperation = 'source-over';
      mctx.clearRect(0, 0, mid.width, mid.height);
      mctx.filter = `blur(${(0.7 * dpr).toFixed(1)}px)`;
      mctx.drawImage(off, 0, 0);
      mctx.filter = 'none';
      mctx.globalCompositeOperation = 'destination-in';
      const near = mctx.createLinearGradient(0, 0, 0, mid.height);
      near.addColorStop(at(surface), 'rgba(0,0,0,0)');
      near.addColorStop(at(surface + band), 'rgba(0,0,0,1)');
      near.addColorStop(at(surface + band * 3), 'rgba(0,0,0,0)');
      mctx.fillStyle = near;
      mctx.fillRect(0, 0, mid.width, mid.height);
      // Above it: sharp, giving way over the same band. (destination-in clears whatever it
      // does not cover: the whole canvas is filled, opaque above the band.)
      octx.globalAlpha = 1;
      octx.globalCompositeOperation = 'destination-in';
      const over = octx.createLinearGradient(0, 0, 0, off.height);
      over.addColorStop(top / off.height, 'rgba(0,0,0,1)');
      over.addColorStop(Math.min(1, (surface + band) / off.height), 'rgba(0,0,0,0)');
      octx.fillStyle = over;
      octx.fillRect(0, 0, off.width, off.height);
      octx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(off, 0, 0);
      ctx.drawImage(mid, 0, 0);
      ctx.drawImage(low, 0, 0);
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
      dots = stipple(t, 18000);
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
    // The box takes the shape of the whale above the surface, so it fills it at any width.
    <div ref={box} className="cpy-whale" style={{ aspectRatio: `${W} / ${WATERLINE}` }} aria-hidden="true">
      <canvas ref={cv} />
    </div>
  );
}
