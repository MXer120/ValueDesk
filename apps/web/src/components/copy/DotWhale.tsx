/**
 * The Copy page's hero art (Discover.tsx, in place of the trader card deck): a
 * humpback breaching, taken from a photo, in two views and printed four ways,
 * picked with the small switches under it (remembered per browser). Views, both
 * swimming to the left:
 *
 *   Side        from its side, the near flipper raised (whale-tone.png).
 *   Belly       from below, throat pleats and both flippers (whale-tone-belly.png,
 *               mirrored from the photo so it heads left, its upper body bent a
 *               little further over for more curve).
 *
 * Prints:
 *
 *   Dots        a stipple print, the dots denser where the photo is lighter, round
 *               stars around it.
 *   Guilloche   a duotone with the crossed wavy lines of a banknote engraving.
 *   Engraving   cream paper and blue ink, lines running along the body, thicker
 *               where the photo is darker (an etching).
 *   Pixel       a dithered grid of dots on black, square stars around it.
 *
 * Each photo is cut out by hand and kept as a tone map (grey = the photo's light,
 * alpha = the whale), equalised over the whale so its dark skin spreads over the
 * whole range. A made-up far flipper on the side view did not read as anatomy
 * (owner, 2026-10-25), so the belly view shows both flippers as photographed.
 * The whale sits on the bottom edge of its box at every size (it comes out of the
 * page's edge as out of the water). Little moves: a slow small dip (never up, so
 * no gap opens under it), the dots giving where the pointer passes, the
 * stars twinkling; no falling water (owner, 2026-10-25). Still under reduced motion.
 */
import { useEffect, useRef, useState } from 'react';
import sideUrl from './whale-tone.png';
import bellyUrl from './whale-tone-belly.png';

export type WhaleStyle = 'dots' | 'guilloche' | 'engraving' | 'pixel';
const STYLES: Array<{ id: WhaleStyle; label: string }> = [
  { id: 'dots', label: 'Dots' },
  { id: 'guilloche', label: 'Guilloche' },
  { id: 'engraving', label: 'Engraving' },
  { id: 'pixel', label: 'Pixel' },
];
const KEY = 'vs:whale-style';

export type WhaleView = 'side' | 'belly';
const VIEWS: Array<{ id: WhaleView; label: string; url: string }> = [
  { id: 'side', label: 'Side', url: sideUrl },
  { id: 'belly', label: 'Belly', url: bellyUrl },
];
const VIEW_KEY = 'vs:whale-view';

/** The tone map's size; the box adds a little room either side. */
const TW = 478;
const TH = 252;
/** Room either side, so the fin tip clears the hero's edge fade. */
const PAD = 18;
const W = TW + PAD * 2;

/** `bottom`: the whale's lowest row, put on the box's bottom edge. */
interface Tone { l: Float32Array; a: Float32Array; bottom: number }
interface Dot { x: number; y: number; r: number; a: number; ph: number; sp: number; dx: number; dy: number }

const tones = new Map<WhaleView, Promise<Tone>>();
function loadTone(view: WhaleView): Promise<Tone> {
  const had = tones.get(view);
  if (had) return had;
  const p = new Promise<Tone>((ok, fail) => {
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
    img.src = VIEWS.find((v) => v.id === view)!.url;
  });
  tones.set(view, p);
  return p;
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

type Poly = Array<[number, number]>;
/**
 * Where the engraving's lines run, per view (tone coordinates): along the body's
 * spine, head tip to tail, and on each flipper along its own axis.
 */
const GEOMETRY: Record<WhaleView, { spine: Poly; fins: Array<{ shape: Poly; axis: Poly }> }> = {
  side: {
    spine: [[0, 44], [60, 50], [130, 58], [200, 72], [262, 94], [312, 124], [352, 160], [384, 202], [410, 252], [420, 290]],
    fins: [{ shape: [[264, 26], [294, 19], [324, 11], [369, 4], [404, 3], [434, 5], [454, 14], [463, 26], [454, 34], [424, 39], [394, 46], [364, 56], [344, 69], [318, 62]], axis: [[270, 70], [330, 38], [400, 18], [470, 14]] }],
  },
  belly: {
    spine: [[97, 44], [179, 89], [245, 126], [297, 172], [324, 222], [328, 262]],
    fins: [
      { shape: [[341, 139], [363, 147], [381, 163], [374, 174], [346, 170], [321, 163], [312, 146]], axis: [[302, 154], [380, 164]] },
      { shape: [[255, 73], [290, 74], [318, 78], [326, 91], [317, 102], [301, 101], [284, 95], [264, 89]], axis: [[252, 85], [326, 91]] },
    ],
  },
};
function inPoly(p: Array<[number, number]>, x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i]!;
    const [xj, yj] = p[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const fields = new Map<WhaleView, { body: Float32Array; fins: Array<{ field: Float32Array; mask: Float32Array }> }>();
function engravingFields(view: WhaleView) {
  const had = fields.get(view);
  if (had) return had;
  const g = GEOMETRY[view];
  const made = {
    body: sideField(g.spine),
    fins: g.fins.map((fin) => {
      const mask = new Float32Array(TW * TH);
      for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) mask[y * TW + x] = inPoly(fin.shape, x, y) ? 1 : 0;
      return { field: sideField(fin.axis), mask };
    }),
  };
  fields.set(view, made);
  return made;
}

/** Image 2: cream paper, blue ink lines running along the body, heavier in the shadows. */
function engraving(t: Tone, w: number, h: number, scale: number, ox: number, oy: number, view: WhaleView): HTMLCanvasElement {
  const f = engravingFields(view);
  const period = 2.5;
  const px = 1 / (period * scale);
  const ink: Rgb = [34, 64, 176];
  const paper: Rgb = [247, 238, 221];
  return perPixel(w, h, scale, ox, oy, (u, v, d, j) => {
    const a = samp(t.a, u, v);
    if (a <= 0.01) return;
    const l = samp(t.l, u, v);
    let rest = 1;
    let dist = 0;
    for (const fin of f.fins) {
      const m = samp(fin.mask, u, v) * rest;
      dist += samp(fin.field, u, v) * m;
      rest -= m;
    }
    dist += samp(f.body, u, v) * rest;
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

function readPick<T extends string>(key: string, ids: readonly T[], fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    if (s && (ids as readonly string[]).includes(s)) return s as T;
  } catch { /* storage blocked */ }
  return fallback;
}
function savePick(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
}

export function DotWhale() {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [style, setStyle] = useState<WhaleStyle>(() => readPick(KEY, STYLES.map((x) => x.id), 'dots'));
  const [view, setView] = useState<WhaleView>(() => readPick(VIEW_KEY, VIEWS.map((x) => x.id), 'side'));
  const pick = (s: WhaleStyle) => { setStyle(s); savePick(KEY, s); };
  const look = (v: WhaleView) => { setView(v); savePick(VIEW_KEY, v); };

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
    const stars = Array.from({ length: 120 }, () => ({ x: Math.random(), y: Math.random(), s: Math.random() < 0.15 ? 2 : 1, a: 0.15 + Math.random() * 0.6, ph: Math.random() * Math.PI * 2, sp: 0.3 + Math.random() * 0.8 }));
    const pointer = { x: -1e4, y: -1e4 };
    let scale = 1;
    let ox = 0;
    let oy = 0;
    let raf = 0;
    let last = 0;
    let gone = false;


    const build = () => {
      if (!tone) return;
      if (style === 'dots') { if (!dots.length) dots = stipple(tone, 9000); print = null; return; }
      print = style === 'guilloche' ? guilloche(tone, canvas.width, canvas.height, scale, ox, oy)
        : style === 'engraving' ? engraving(tone, canvas.width, canvas.height, scale, ox, oy, view)
          : pixelGrid(tone, canvas.width, canvas.height, scale, ox, oy);
    };
    const fit = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      scale = Math.min(r.width / W, r.height / TH) * dpr;
      ox = Math.round((canvas.width - W * scale) / 2 + PAD * scale);
      oy = Math.round(canvas.height - (tone?.bottom ?? TH) * scale);
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
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!tone) return;
      const bob = still ? 0 : (1 - Math.cos(t / 4200)) * 0.8;
      if (style === 'pixel' || style === 'dots') {
        ctx.fillStyle = style === 'pixel' ? '#e4e4e4' : getComputedStyle(el).color || '#e8e8e8';
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        for (const s of stars) {
          ctx.globalAlpha = s.a * (still ? 1 : 0.55 + 0.45 * Math.sin((t / 1000) * s.sp + s.ph));
          const x = Math.round(s.x * canvas.width);
          const y = Math.round(s.y * canvas.height);
          if (style === 'pixel') ctx.fillRect(x, y, s.s, s.s);
          else {
            ctx.beginPath();
            ctx.arc(x, y, s.s * 0.6 * dpr, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      }
      if (print) ctx.drawImage(print, 0, Math.round(bob * scale));
      ctx.fillStyle = getComputedStyle(el).color || '#e8e8e8';
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
    loadTone(view).then((t) => {
      if (gone) return;
      tone = t;
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
  }, [style, view]);

  return (
    <div className="cpy-whalewrap">
      <div ref={box} className={`cpy-whale cpy-whale--${style}`} aria-hidden="true">
        <canvas ref={cv} />
      </div>
      <div className="cpy-whale__switches">
        <div className="cpy-whale__styles" role="group" aria-label="Whale view">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" className={v.id === view ? 'is-on' : ''} aria-pressed={v.id === view} onClick={() => look(v.id)}>{v.label}</button>
          ))}
        </div>
        <div className="cpy-whale__styles" role="group" aria-label="Whale print style">
          {STYLES.map((s) => (
            <button key={s.id} type="button" className={s.id === style ? 'is-on' : ''} aria-pressed={s.id === style} onClick={() => pick(s.id)}>{s.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
