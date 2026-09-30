/**
 * PNG icons, area-averaged down to at most ICON_MAX px in premultiplied alpha
 * (so transparent edges don't darken). Shared by the logo tools. pngjs is
 * already installed (via qrcode); without it the originals are kept.
 */
import { createRequire } from 'node:module';

export const ICON_MAX = 128;
let PNG;
try {
  PNG = createRequire(import.meta.url)('pngjs').PNG;
} catch {
  console.log('pngjs not found - large PNGs are kept at full size');
}

function areaWeights(from, to) {
  const scale = from / to;
  return Array.from({ length: to }, (_, d) => {
    const a = d * scale, b = a + scale, ws = [];
    for (let s = Math.floor(a); s < Math.min(from, Math.ceil(b)); s++) {
      const w = Math.min(b, s + 1) - Math.max(a, s);
      if (w > 0) ws.push([s, w / scale]);
    }
    return ws;
  });
}

export function shrinkPng(buf, url) {
  if (!PNG) return buf;
  let img;
  try {
    img = PNG.sync.read(buf);
  } catch {
    return buf; // not decodable by pngjs (e.g. APNG quirks): keep as served
  }
  const { width: w, height: h, data } = img;
  if (w <= ICON_MAX && h <= ICON_MAX) return buf;
  const k = ICON_MAX / Math.max(w, h);
  const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
  const xw = areaWeights(w, W), yw = areaWeights(h, H);
  const row = new Float64Array(W * 4); // one source row, resampled horizontally
  const acc = new Float64Array(W * H * 4);
  for (let y = 0; y < h; y++) {
    row.fill(0);
    for (let X = 0; X < W; X++) {
      for (const [sx, wt] of xw[X]) {
        const i = (y * w + sx) * 4, a = data[i + 3] / 255;
        row[X * 4] += data[i] * a * wt;
        row[X * 4 + 1] += data[i + 1] * a * wt;
        row[X * 4 + 2] += data[i + 2] * a * wt;
        row[X * 4 + 3] += data[i + 3] * wt;
      }
    }
    for (let Y = 0; Y < H; Y++) {
      const hit = yw[Y].find(([sy]) => sy === y);
      if (!hit) continue;
      for (let j = 0; j < W * 4; j++) acc[Y * W * 4 + j] += row[j] * hit[1];
    }
  }
  const out = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i++) {
    const alpha = acc[i * 4 + 3], a = alpha / 255;
    out.data[i * 4] = a > 0 ? Math.min(255, Math.round(acc[i * 4] / a)) : 0;
    out.data[i * 4 + 1] = a > 0 ? Math.min(255, Math.round(acc[i * 4 + 1] / a)) : 0;
    out.data[i * 4 + 2] = a > 0 ? Math.min(255, Math.round(acc[i * 4 + 2] / a)) : 0;
    out.data[i * 4 + 3] = Math.min(255, Math.round(alpha));
  }
  const small = recompressPng(PNG.sync.write(out, { colorType: 6 }));
  if (small.length >= buf.length) return buf;
  console.log(`  shrunk ${url.slice(url.lastIndexOf('/') + 1)} ${w}x${h} ${Math.round(buf.length / 1024)} KB -> ${W}x${H} ${Math.round(small.length / 1024)} KB`);
  return small;
}


/* ------------------------------------------------------------------ lossless */

/** Chunks that change how a PNG renders (colour management, orientation): always carried over. */
const KEEP_ANCILLARY = new Set(['sRGB', 'gAMA', 'cHRM', 'iCCP', 'cICP', 'mDCV', 'cLLI', 'eXIf', 'pHYs', 'bKGD']);

function pngChunks(buf) {
  const out = [];
  let o = 8;
  while (o + 12 <= buf.length) {
    const len = buf.readUInt32BE(o);
    out.push({ type: buf.toString('latin1', o + 4, o + 8), raw: buf.subarray(o, o + 12 + len), data: buf.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  return out;
}

/**
 * The same pixels in fewer bytes: re-deflated at level 9 with the best of the
 * row filters, alpha dropped when every pixel is opaque. Only 8-bit truecolour
 * sources are touched (anything else would be converted, not recompressed),
 * every chunk that affects rendering is copied over unchanged, and the result
 * is decoded again and compared pixel for pixel before it is used. Returns the
 * original buffer whenever that cannot be proven or does not save bytes.
 */
export function recompressPng(buf) {
  if (!PNG || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return buf;
  let chunks, img;
  try {
    chunks = pngChunks(buf);
    const ihdr = chunks[0];
    if (ihdr?.type !== 'IHDR') return buf;
    const bitDepth = ihdr.data[8], colorType = ihdr.data[9];
    if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) return buf;
    if (chunks.some((c) => c.type === 'acTL')) return buf; // APNG: leave animation alone
    if (chunks.some((c) => c.type === 'tRNS')) return buf; // colour-key transparency: not worth the risk
    img = PNG.sync.read(buf);
  } catch {
    return buf;
  }
  let opaque = true;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) { opaque = false; break; }
  let best = null;
  for (const colorType of opaque ? [2, 6] : [6]) {
    for (const filterType of [-1, 0, 1, 2, 3, 4]) {
      for (const deflateStrategy of [0, 1]) {
        const out = PNG.sync.write(img, { colorType, inputColorType: 6, inputHasAlpha: true, filterType, deflateLevel: 9, deflateStrategy });
        if (!best || out.length < best.length) best = out;
      }
    }
  }
  // Rebuild from pngjs's image data only (IHDR, IDAT..., IEND - it also writes a gAMA of its
  // own, dropped here) with the ORIGINAL rendering chunks back in, right after IHDR.
  const fresh = pngChunks(best).filter((c) => c.type === 'IHDR' || c.type === 'IDAT' || c.type === 'IEND');
  const keep = chunks.filter((c) => KEEP_ANCILLARY.has(c.type));
  const rebuilt = Buffer.concat([
    best.subarray(0, 8),
    fresh[0].raw,
    ...keep.map((c) => c.raw),
    ...fresh.slice(1).map((c) => c.raw),
  ]);
  if (rebuilt.length >= buf.length) return buf;
  // Proof: identical pixels.
  try {
    const again = PNG.sync.read(rebuilt);
    if (again.width !== img.width || again.height !== img.height || !again.data.equals(img.data)) return buf;
  } catch {
    return buf;
  }
  return rebuilt;
}
