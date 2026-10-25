/**
 * The Copy page's hero art (Discover.tsx, in place of the trader card deck): a
 * humpback breaching, seen from below - throat pleats and both flippers - in dots
 * like a stipple print, the dots denser where the photo is lighter, faint round
 * stars around it.
 *
 * The photo is cut out along its outline and kept as a tone map
 * (whale-tone-belly.png: grey = the photo's light, alpha = the whale), mirrored so
 * it heads left, its upper body bent a little further over, and equalised over
 * the whale so its dark skin spreads over the whole range.
 *
 * It sits behind the hero's text, on the hero's bottom edge and a touch past it
 * (SINK), cut off by its own canvas there, as if still coming out of the water. Little moves
 * (owner, 2026-10-25): a slow small dip (never up, so no gap opens under it), the
 * dots giving where the pointer passes, the stars twinkling. Still under reduced
 * motion.
 */
import { useEffect, useRef } from 'react';
import toneUrl from './whale-tone-belly.png';

/** The tone map's size; the box adds a little room either side. */
const TW = 478;
const TH = 252;
const PAD = 18;
const W = TW + PAD * 2;
/** How far the whale sinks past the box's bottom edge (tone units), cut off there. */
const SINK = 5;

/** `bottom`: the whale's lowest row, put on the box's bottom edge. */
interface Tone { l: Float32Array; a: Float32Array; bottom: number }
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
      let bottom = TH;
      for (let y = TH - 1; y > 0; y--) {
        let row = 0;
        for (let x = 0; x < TW; x++) row = Math.max(row, a[y * TW + x]!);
        if (row > 0.5) { bottom = y + 1; break; }
      }
      ok({ l, a, bottom });
    };
    img.onerror = () => fail(new Error('whale tone did not load'));
    img.src = toneUrl;
  });
  return toneOnce;
}

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

/** The stipple: dots dropped where the whale is, kept more often where it is light. */
function stipple(t: Tone, count: number): Dot[] {
  const dots: Dot[] = [];
  let tries = 0;
  while (dots.length < count && tries < count * 40) {
    tries++;
    const x = Math.random() * TW;
    const y = Math.random() * TH;
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
    if (!ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let tone: Tone | null = null;
    let dots: Dot[] = [];
    const stars = Array.from({ length: 120 }, () => ({ x: Math.random(), y: Math.random(), s: Math.random() < 0.15 ? 2 : 1, a: 0.15 + Math.random() * 0.6, ph: Math.random() * Math.PI * 2, sp: 0.3 + Math.random() * 0.8 }));
    const pointer = { x: -1e4, y: -1e4 };
    let scale = 1;
    let ox = 0;
    let oy = 0;
    let raf = 0;
    let last = 0;
    let gone = false;

    const fit = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      scale = Math.min(r.width / W, r.height / TH) * dpr;
      ox = Math.round((canvas.width - W * scale) / 2 + PAD * scale);
      oy = Math.round(canvas.height - ((tone?.bottom ?? TH) - SINK) * scale);
    };
    const draw = (t: number) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!tone) return;
      const color = getComputedStyle(el).color || '#e8e8e8';
      ctx.fillStyle = color;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      for (const s of stars) {
        ctx.globalAlpha = s.a * (still ? 1 : 0.55 + 0.45 * Math.sin((t / 1000) * s.sp + s.ph));
        ctx.beginPath();
        ctx.arc(Math.round(s.x * canvas.width), Math.round(s.y * canvas.height), s.s * 0.6 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
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
        ctx.globalAlpha = d.a * tw;
        ctx.beginPath();
        ctx.arc(ox + (d.x + d.dx) * scale, oy + (d.y + bob + d.dy) * scale, d.r * scale, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
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
      dots = stipple(t, 9000);
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
