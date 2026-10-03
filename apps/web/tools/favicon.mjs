/**
 * public/favicon.ico, drawn from public/favicon.svg - no new design.
 *
 *   node tools/favicon.mjs        (from apps/web) rewrites public/favicon.ico
 *
 * Browsers that do not take the SVG icon (and every crawler) ask for
 * /favicon.ico on their own; without the file the site answers 403. The SVG is
 * rounded rectangles only, so it is rasterised here exactly - each pixel
 * averages 16 x 16 samples - into 16, 32 and 48 px, stored as 32-bit BMP
 * images (the one ICO payload every browser and OS reads). The same input
 * always gives the same bytes; src/favicon.test.ts checks the committed file
 * against the SVG, so the two cannot drift apart.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ICO_SIZES = [16, 32, 48];
const SAMPLES = 16;

/** The SVG's shapes, in paint order. Anything but <rect> is refused: this rasteriser draws rectangles only. */
export function shapesOf(svg) {
  const body = svg.replace(/<!--[\s\S]*?-->/g, '');
  const view = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(body);
  if (!view) throw new Error('favicon.svg: no "0 0 w h" viewBox');
  const others = [...body.matchAll(/<([a-zA-Z]+)\b/g)].map((m) => m[1]).filter((t) => t !== 'svg' && t !== 'rect');
  if (others.length) throw new Error(`favicon.svg: only <rect> can be rasterised here, found <${others[0]}>`);
  const num = (attrs, name, dflt) => {
    const m = new RegExp(`\\b${name}="(-?\\d+(?:\\.\\d+)?)"`).exec(attrs);
    return m ? Number(m[1]) : dflt;
  };
  const rects = [...body.matchAll(/<rect\b([^>]*)\/?>/g)].map((m) => {
    const a = m[1];
    const fill = /\bfill="#([0-9a-fA-F]{6})"/.exec(a)?.[1];
    if (!fill) throw new Error(`favicon.svg: a <rect> without a #rrggbb fill: ${a.trim()}`);
    const w = num(a, 'width', NaN), h = num(a, 'height', NaN);
    if (!(w > 0 && h > 0)) throw new Error(`favicon.svg: a <rect> without a size: ${a.trim()}`);
    const rx = num(a, 'rx', num(a, 'ry', 0));
    return {
      x: num(a, 'x', 0), y: num(a, 'y', 0), w, h, r: Math.min(rx, w / 2, h / 2),
      rgb: [0, 2, 4].map((i) => parseInt(fill.slice(i, i + 2), 16)),
    };
  });
  return { width: Number(view[1]), height: Number(view[2]), rects };
}

const inside = (s, x, y) => {
  if (x < s.x || x > s.x + s.w || y < s.y || y > s.y + s.h) return false;
  if (s.r <= 0) return true;
  const cx = Math.min(Math.max(x, s.x + s.r), s.x + s.w - s.r);
  const cy = Math.min(Math.max(y, s.y + s.r), s.y + s.h - s.r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= s.r ** 2;
};

/** RGBA, top row first, `size` x `size`. */
export function rasterise(shapes, size) {
  const out = new Uint8Array(size * size * 4);
  const kx = shapes.width / size, ky = shapes.height / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let n = 0, r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) * kx;
          const y = (py + (sy + 0.5) / SAMPLES) * ky;
          let hit = null;
          for (const s of shapes.rects) if (inside(s, x, y)) hit = s; // painter's order: the last one wins
          if (hit) { n++; r += hit.rgb[0]; g += hit.rgb[1]; b += hit.rgb[2]; }
        }
      }
      const o = (py * size + px) * 4;
      if (n) {
        out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
        out[o + 3] = Math.round((255 * n) / (SAMPLES * SAMPLES));
      }
    }
  }
  return out;
}

/** One ICO image: BITMAPINFOHEADER, BGRA bottom-up, then the 1-bit AND mask (set = transparent). */
function bmpEntry(rgba, size) {
  const maskRow = Math.ceil(size / 32) * 4;
  const buf = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(size, 4);
  buf.writeInt32LE(size * 2, 8); // colour rows + mask rows
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  let o = 40;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      buf[o++] = rgba[i + 2]; buf[o++] = rgba[i + 1]; buf[o++] = rgba[i]; buf[o++] = rgba[i + 3];
    }
  }
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      if (rgba[(y * size + x) * 4 + 3] === 0) buf[o + (x >> 3)] |= 0x80 >> (x & 7);
    }
    o += maskRow;
  }
  return buf;
}

/** The whole .ico for an SVG's text. */
export function icoFromSvg(svg) {
  const shapes = shapesOf(svg);
  const images = ICO_SIZES.map((s) => bmpEntry(rasterise(shapes, s), s));
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // icon
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach((img, k) => {
    const e = 6 + 16 * k, s = ICO_SIZES[k];
    head.writeUInt8(s >= 256 ? 0 : s, e);
    head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt8(0, e + 2); // no palette
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(img.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += img.length;
  });
  return Buffer.concat([head, ...images]);
}

const here = dirname(fileURLToPath(import.meta.url));
export const SVG_PATH = join(here, '..', 'public', 'favicon.svg');
export const ICO_PATH = join(here, '..', 'public', 'favicon.ico');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ico = icoFromSvg(readFileSync(SVG_PATH, 'utf8'));
  writeFileSync(ICO_PATH, ico);
  console.log(`wrote ${ICO_PATH} (${ico.length} bytes; ${ICO_SIZES.join(', ')} px)`);
}
