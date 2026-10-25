/**
 * The Copy page's hero art (Discover.tsx, in place of the trader card deck): a
 * humpback breaching, taken from a photo and printed four ways, picked with the
 * small switch under it (remembered per browser):
 *
 *   Dots        a stipple print, the dots denser where the photo is lighter.
 *   Guilloche   a duotone with the crossed wavy lines of a banknote engraving.
 *   Engraving   cream paper and blue ink, lines running along the body, thicker
 *               where the photo is darker (an etching).
 *   Pixel       a dithered grid of dots on black, with a few stars around it.
 *
 * The photo is cut out by hand and kept as a tone map (whale-tone.png: grey =
 * the photo's light, alpha = the whale), equalised over the whale so its dark
 * skin spreads over the whole range. Little moves (owner, 2026-10-25): a slow
 * small bob, water falling off the tail, the dots giving where the pointer passes,
 * the stars twinkling. Still under reduced motion.
 */
import { useEffect, useRef, useState } from 'react';
import toneUrl from './whale-tone.png';

export type WhaleStyle = 'dots' | 'guilloche' | 'engraving' | 'pixel';
const STYLES: Array<{ id: WhaleStyle; label: string }> = [
  { id: 'dots', label: 'Dots' },
  { id: 'guilloche', label: 'Guilloche' },
  { id: 'engraving', label: 'Engraving' },
  { id: 'pixel', label: 'Pixel' },
];
const KEY = 'vs:whale-style';

/** The tone map's size; the box adds room under it for the falling water. */
const TW = 478;
const TH = 252;
/** Room either side, so the fin tip clears the hero's edge fade. */
const PAD = 18;
const W = TW + PAD * 2;
const H = 290;

interface Tone { l: Float32Array; a: Float32Array; drips: Array<[number, number]> }
interface Dot { x: number; y: number; r: number; a: number; ph: number; sp: number; dx: number; dy: number }
interface Drop { x: number; y: number; vx: number; vy: number; r: number; life: number; max: number }

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
      // Where water falls off: the tail's right edge, near the surface.
      const drips: Array<[number, number]> = [];
      for (let y = TH - 60; y < TH - 2; y += 2) {
        for (let x = TW - 1; x > TW / 2; x--) if (a[y * TW + x]! > 0.5) { drips.push([x, y]); break; }
      }
      ok({ l, a, drips });
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

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

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

type Rgb = [number, number, number];
/** Image 1's duotone: deep blue shadows, periwinkle mid-tones, pink and cream lights. */
const GUILLOCHE_RAMP: Array<[number, Rgb]> = [[0, [30, 42, 82]], [0.38, [86, 104, 160]], [0.72, [204, 168, 184]], [1, [248, 236, 228]]];
function ramp(stops: Array<[number, Rgb]>, x: number): Rgb {
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i]!;
    const [p0, c0] = stops[i - 1]!;
    if (x <= p1) {
      const k = (x - p0) / (p1 - p0);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return stops[stops.length - 1]![1];
}

/** A device-pixel canvas the size of the view, the whale painted per pixel by `pixel`. */
function perPixel(w: number, h: number, scale: number, ox: number, oy: number, pixel: (u: number, v: number, out: Uint8ClampedArray, j: number) => void): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) return c;
  const img = g.createImageData(w, h);
  const d = img.data;
  const u0 = Math.max(0, Math.floor(ox));
  const u1 = Math.min(w, Math.ceil(ox + TW * scale));
  const v0 = Math.max(0, Math.floor(oy));
  const v1 = Math.min(h, Math.ceil(oy + TH * scale));
  for (let py = v0; py < v1; py++) {
    for (let px = u0; px < u1; px++) pixel((px - ox) / scale, (py - oy) / scale, d, (py * w + px) * 4);
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Image 1: the photo in duotone, crossed by two families of wavy lines like a banknote. */
function guilloche(t: Tone, w: number, h: number, scale: number, ox: number, oy: number): HTMLCanvasElement {
  const ca = Math.cos(0.95);
  const sa = Math.sin(0.95);
  const period = 2.7;
  // The line's half-width in |sin| units, about a device pixel and a bit.
  const half = Math.min(0.45, 0.9 / (period * scale / Math.PI));
  return perPixel(w, h, scale, ox, oy, (u, v, d, j) => {
    const a = samp(t.a, u, v);
    if (a <= 0.01) return;
    const l = samp(t.l, u, v);
    const s1 = u * ca + v * sa;
    const t1 = -u * sa + v * ca;
    const s2 = u * ca - v * sa;
    const t2 = u * sa + v * ca;
    const w1 = Math.abs(Math.sin(Math.PI * (s1 + 2.4 * Math.sin(t1 / 5.2)) / period));
    const w2 = Math.abs(Math.sin(Math.PI * (s2 + 2.4 * Math.sin(t2 / 5.2 + 1.7)) / period));
    const line = 1 - smooth(half * 0.4, half * 1.6, Math.min(w1, w2));
    const [r, g, b] = ramp(GUILLOCHE_RAMP, Math.pow(l, 1.3));
    const k = 1 - (0.38 + 0.25 * l) * line;
    d[j] = r * k;
    d[j + 1] = g * k;
    d[j + 2] = b * k;
    d[j + 3] = a * 255;
  });
}

/** Signed distance (in tone units) to a polyline, sampled over the whole tone map. */
function sideField(line: Array<[number, number]>): Float32Array {
  const f = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW; x++) {
      let best = Infinity;
      let side = 1;
      for (let i = 1; i < line.length; i++) {
        const [ax, ay] = line[i - 1]!;
        const [bx, by] = line[i]!;
        const dx = bx - ax;
        const dy = by - ay;
        const k = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
        const ex = x - ax - dx * k;
        const ey = y - ay - dy * k;
        const dd = ex * ex + ey * ey;
        if (dd < best) { best = dd; side = dx * (y - ay) - dy * (x - ax) >= 0 ? 1 : -1; }
      }
      f[y * TW + x] = Math.sqrt(best) * side;
    }
  }
  return f;
}

/** The body's spine, head tip to tail, and the fin's axis (tone coordinates). */
const SPINE: Array<[number, number]> = [[0, 44], [60, 50], [130, 58], [200, 72], [262, 94], [312, 124], [352, 160], [384, 202], [410, 252], [420, 290]];
const FIN_AXIS: Array<[number, number]> = [[270, 70], [330, 38], [400, 18], [470, 14]];
/** The fin, where the engraving's lines follow its axis instead of the body's. */
const FIN: Array<[number, number]> = [[264, 26], [294, 19], [324, 11], [369, 4], [404, 3], [434, 5], [454, 14], [463, 26], [454, 34], [424, 39], [394, 46], [364, 56], [344, 69], [318, 62]];
function inPoly(p: Array<[number, number]>, x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i]!;
    const [xj, yj] = p[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

let fields: { body: Float32Array; fin: Float32Array; finMask: Float32Array } | null = null;
function engravingFields() {
  if (fields) return fields;
  const mask = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) mask[y * TW + x] = inPoly(FIN, x, y) ? 1 : 0;
  fields = { body: sideField(SPINE), fin: sideField(FIN_AXIS), finMask: mask };
  return fields;
}

/** Image 2: cream paper, blue ink lines running along the body, heavier in the shadows. */
function engraving(t: Tone, w: number, h: number, scale: number, ox: number, oy: number): HTMLCanvasElement {
  const f = engravingFields();
  const period = 2.5;
  const px = 1 / (period * scale);
  const ink: Rgb = [34, 64, 176];
  const paper: Rgb = [247, 238, 221];
  return perPixel(w, h, scale, ox, oy, (u, v, d, j) => {
    const a = samp(t.a, u, v);
    if (a <= 0.01) return;
    const l = samp(t.l, u, v);
    const m = samp(f.finMask, u, v);
    const dist = samp(f.body, u, v) * (1 - m) + samp(f.fin, u, v) * m;
    // The burin's hand: the lines wander a little, and break up in the lights.
    const phase = dist / period + 0.18 * Math.sin(u / 3.3 + v / 9) + 0.1 * Math.sin(u / 1.3 - v / 2.1);
    const off = Math.abs((((phase % 1) + 1) % 1) - 0.5) * 2;
    let width = 0.05 + 0.62 * Math.pow(1 - l, 1.5);
    if (l > 0.55) width *= smooth(-0.6, 0.6, Math.sin(u * 0.9 + 3 * Math.sin(v * 0.5)) + Math.sin(v * 1.7 - u * 0.3));
    const on = 1 - smooth(width - px * 1.2, width + px * 1.2, 1 - off);
    const k = 1 - on;
    d[j] = ink[0] + (paper[0] - ink[0]) * k;
    d[j + 1] = ink[1] + (paper[1] - ink[1]) * k;
    d[j + 2] = ink[2] + (paper[2] - ink[2]) * k;
    d[j + 3] = a * 255;
  });
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Image 3: an ordered-dither grid of dots, little crosses in the lights. */
function pixelGrid(t: Tone, w: number, h: number, scale: number, ox: number, oy: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) return c;
  const cell = 2.6;
  const size = Math.max(1, Math.round(cell * scale * 0.42));
  g.fillStyle = '#e4e4e4';
  g.strokeStyle = '#f4f4f4';
  g.lineWidth = Math.max(1, scale * 0.35);
  for (let j = 0; j * cell < TH; j++) {
    for (let i = 0; i * cell < TW; i++) {
      const u = (i + 0.5) * cell;
      const v = (j + 0.5) * cell;
      if (samp(t.a, u, v) < 0.5) continue;
      const l = samp(t.l, u, v);
      const b = (BAYER[(j & 3) * 4 + (i & 3)]! + 0.5) / 16;
      if (0.1 + 0.9 * l < b) continue;
      const x = Math.round(ox + (i * cell) * scale);
      const y = Math.round(oy + (j * cell) * scale);
      g.globalAlpha = 0.3 + 0.7 * l;
      if (l > 0.8 && (i + j) % 2 === 0) {
        const s = cell * scale * 0.8;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + s, y + s);
        g.moveTo(x + s, y);
        g.lineTo(x, y + s);
        g.stroke();
      } else {
        g.fillRect(x, y, size, size);
      }
    }
  }
  g.globalAlpha = 1;
  return c;
}

function readStyle(): WhaleStyle {
  try {
    const s = localStorage.getItem(KEY);
    if (s && STYLES.some((x) => x.id === s)) return s as WhaleStyle;
  } catch { /* storage blocked */ }
  return 'dots';
}

export function DotWhale() {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [style, setStyle] = useState<WhaleStyle>(readStyle);

  const pick = (s: WhaleStyle) => {
    setStyle(s);
    try { localStorage.setItem(KEY, s); } catch { /* storage blocked */ }
  };

  useEffect(() => {
    const el = box.current;
    const canvas = cv.current;
    if (!el || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let tone: Tone | null = null;
    let dots: Dot[] = [];
    let print: HTMLCanvasElement | null = null;
    const drops: Drop[] = [];
    const stars = Array.from({ length: 120 }, () => ({ x: Math.random(), y: Math.random(), s: Math.random() < 0.15 ? 2 : 1, a: 0.15 + Math.random() * 0.6, ph: Math.random() * Math.PI * 2, sp: 0.3 + Math.random() * 0.8 }));
    const pointer = { x: -1e4, y: -1e4 };
    let scale = 1;
    let ox = 0;
    let oy = 0;
    let raf = 0;
    let last = 0;
    let prev = 0;
    let gone = false;

    const dropColor = style === 'guilloche' ? '#f1d9d6' : style === 'engraving' ? '#f7eedd' : style === 'pixel' ? '#e4e4e4' : '';
    const spawn = () => {
      const drips = tone?.drips;
      if (!drips?.length) return;
      const [x, y] = drips[Math.floor(Math.random() * drips.length)]!;
      drops.push({ x: x + (Math.random() - 0.5) * 3, y: y - Math.random() * 3, vx: (Math.random() - 0.5) * 2, vy: 1 + Math.random() * 5, r: 0.7 + Math.random() * 0.9, life: 0, max: 1.4 + Math.random() * 1.8 });
    };

    const build = () => {
      if (!tone) return;
      if (style === 'dots') { if (!dots.length) dots = stipple(tone, 9000); print = null; return; }
      const make = style === 'guilloche' ? guilloche : style === 'engraving' ? engraving : pixelGrid;
      print = make(tone, canvas.width, canvas.height, scale, ox, oy);
    };
    const fit = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      scale = Math.min(r.width / W, r.height / H) * dpr;
      ox = Math.round((canvas.width - W * scale) / 2 + PAD * scale);
      oy = Math.round((canvas.height - H * scale) / 2);
      build();
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
      if (!tone) return;
      const bob = still ? 0 : Math.sin(t / 4200) * 1.4;
      if (style === 'pixel') {
        ctx.fillStyle = '#e4e4e4';
        for (const s of stars) {
          ctx.globalAlpha = s.a * (still ? 1 : 0.55 + 0.45 * Math.sin((t / 1000) * s.sp + s.ph));
          ctx.fillRect(Math.round(s.x * canvas.width), Math.round(s.y * canvas.height), s.s, s.s);
        }
        ctx.globalAlpha = 1;
      }
      if (print) ctx.drawImage(print, 0, Math.round(bob * scale));
      ctx.fillStyle = dropColor || getComputedStyle(el).color || '#e8e8e8';
      if (style === 'dots') {
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
          dot(d.x + d.dx, d.y + bob + d.dy, d.r, d.a * tw);
        }
      }
      // The water running off the tail: down under gravity, fading as it falls.
      if (!still) {
        if (Math.random() < 0.7) spawn();
        for (let i = drops.length - 1; i >= 0; i--) {
          const p = drops[i]!;
          p.life += dt;
          p.vy += 55 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (p.life > p.max || p.y > H + 4) { drops.splice(i, 1); continue; }
          const a = 0.9 * (1 - p.life / p.max);
          if (style === 'pixel') {
            const cell = 2.6 * scale;
            ctx.globalAlpha = a;
            ctx.fillRect(Math.round(ox + Math.round(p.x / 2.6) * cell), Math.round(oy + Math.round((p.y + bob) / 2.6) * cell), Math.max(1, cell * 0.42), Math.max(1, cell * 0.42));
          } else dot(p.x, p.y + bob, p.r, a);
        }
        if (drops.length > 700) drops.splice(0, drops.length - 700);
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
      build();
      if (!still) for (let i = 0; i < 45; i++) { spawn(); drops[drops.length - 1]!.life = Math.random() * 1.4; }
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
  }, [style]);

  return (
    <div className="cpy-whalewrap">
      <div ref={box} className={`cpy-whale cpy-whale--${style}`} aria-hidden="true">
        <canvas ref={cv} />
      </div>
      <div className="cpy-whale__styles" role="group" aria-label="Whale print style">
        {STYLES.map((s) => (
          <button key={s.id} type="button" className={s.id === style ? 'is-on' : ''} aria-pressed={s.id === style} onClick={() => pick(s.id)}>{s.label}</button>
        ))}
      </div>
    </div>
  );
}
