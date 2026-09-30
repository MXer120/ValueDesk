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
  const small = PNG.sync.write(out, { colorType: 6 });
  if (small.length >= buf.length) return buf;
  console.log(`  shrunk ${url.slice(url.lastIndexOf('/') + 1)} ${w}x${h} ${Math.round(buf.length / 1024)} KB -> ${W}x${H} ${Math.round(small.length / 1024)} KB`);
  return small;
}

