/**
 * A site's own icon, from the site itself - the mark its owner publishes for
 * browsers, bookmarks and home screens to show next to its name. Shared by the
 * logo tools (fetch-logos.mjs, fetch-venue-logos.mjs, fetch-addrbook-logos.mjs,
 * fetch-site-logos.mjs); build time only, the app serves the files itself.
 *
 * Why this source (licence review 2026-10-28, docs/legal/THIRD-PARTY-REVIEW.md):
 * TradingView's symbol logos, CoinGecko's and DefiLlama's images and the
 * DuckDuckGo / Google favicon services all come with terms that do not cover a
 * commercial site. A company's, fund issuer's or project's own published icon,
 * shown small next to its own name to say which asset or venue a row is, is
 * nominative (identifying) use of its mark (Art. 14(1)(c) EUTMR, § 23 MarkenG);
 * the file is the owner's own, shipped unaltered (only sanitised / shrunk
 * losslessly or to at most 128 px).
 *
 * Order: /apple-touch-icon.png; else the page's declared icons (SVG first, then
 * apple-touch-icons, then the largest size); then /favicon.ico. Only the first
 * 32 KB of the page are read (the <head>), and every transfer is
 * paced to stay under ~1.5 MB/s (the laptop's bandwidth cap), one at a time.
 *
 * recordSources() keeps tools/logo-sources.json: for every shipped logo file,
 * the URL it was downloaded from (or the fallback it shows), per tool section -
 * the attribution record the licence review points to.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cleanSvg } from './logo-clean.mjs';
import { createRequire } from 'node:module';
import { recompressPng, shrinkPng } from './png-shrink.mjs';

let PNG = null;
try {
  PNG = createRequire(import.meta.url)('pngjs').PNG; // installed via qrcode, as png-shrink.mjs uses it
} catch {
  /* BMP frames of .ico files are then kept as .ico */
}

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; ValueDesk logo sync; +https://www.valuedesk.so)', Accept: 'text/html,image/*;q=0.9,*/*;q=0.5' };
const MAX_IMAGE = 400_000;
const HEAD_BYTES = 32 * 1024;
const RATE = 1_500_000; // bytes per second, on average
const started = Date.now();
let bytes = 0;

/** Total bytes this process downloaded through here. */
export const downloaded = () => bytes;

/** Count `n` downloaded bytes and wait until the average is back under RATE (shared by every logo tool). */
export async function pace(n) {
  bytes += n;
  const due = (bytes / RATE) * 1000 - (Date.now() - started);
  if (due > 0) await new Promise((r) => setTimeout(r, due));
}

/** Up to `limit` bytes of a response body; the rest is not downloaded. */
async function readCapped(res, limit) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  await pace(size);
  return Buffer.concat(parts);
}

/** The image type the bytes are; null when they are not one. */
export function sniff(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png';
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return '.ico';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (b.length >= 3 && b.toString('ascii', 0, 3) === 'GIF') return '.gif';
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(b.toString('utf8', 0, Math.min(b.length, 4096)))) return '.svg';
  return null;
}

/** <link rel=...icon...> tags of a page head, best first. */
export function declaredIcons(html, base) {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (n) => new RegExp(`\\s${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find((x) => x !== undefined) ?? '';
    const rel = attr('rel').toLowerCase();
    if (!/(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/.test(rel)) continue;
    const href = attr('href');
    if (!href || href.startsWith('data:')) continue;
    let url;
    try {
      url = new URL(href.replace(/&amp;/g, '&'), base).toString();
    } catch {
      continue;
    }
    if (!url.startsWith('https://')) continue;
    const sizes = attr('sizes').toLowerCase();
    const px = sizes === 'any' ? 512 : Math.max(0, ...[...sizes.matchAll(/(\d+)x\d+/g)].map((s) => Number(s[1])));
    const svg = /\.svg(\?|$)/i.test(url) || /svg/i.test(attr('type'));
    const touch = rel.includes('apple-touch-icon');
    // Rank: SVG, then apple-touch-icons (180 px), then the largest declared size.
    out.push({ url, rank: (svg ? 1000 : 0) + (touch ? 180 : 0) + Math.min(px, 512) });
  }
  return out.sort((a, b) => b.rank - a.rank).map((x) => x.url);
}

async function get(url, limit, imageOnly = false) {
  try {
    const res = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    // A page where an image was asked for (an app answering every path with its HTML) is not read.
    if (!res.ok || (imageOnly && /html|json|javascript/i.test(res.headers.get('content-type') ?? ''))) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return { url: res.url || url, type: (res.headers.get('content-type') ?? '').toLowerCase(), body: await readCapped(res, limit) };
  } catch {
    return null;
  }
}

/** An image at `url` ready to ship (SVG sanitised, PNG shrunk), or null. */
export async function imageAt(url) {
  return ready(await get(url, MAX_IMAGE, true), url);
}

/**
 * A GitHub organisation's own avatar (github.com/<org>.png, served from
 * avatars.githubusercontent.com), or null - also when the org never set one:
 * GitHub then answers its generated 420 x 420 identicon, which is no logo.
 */
export async function githubAvatar(org) {
  const url = `https://github.com/${encodeURIComponent(org)}.png?size=128`;
  const res = await get(url, MAX_IMAGE, true);
  if (res && sniff(res.body) === '.png' && res.body.readUInt32BE(16) === 420 && res.body.readUInt32BE(20) === 420) return null;
  const img = ready(res, url);
  return img && { ...img, url: `https://github.com/${org}.png (${img.url})` };
}

function ready(res, url) {
  if (!res || res.body.length < 64 || res.body.length > MAX_IMAGE) return null;
  const ext = sniff(res.body);
  if (!ext) return null;
  // A placeholder pixel (dowjones.com's apple-touch-icon is 1 x 1) is no icon.
  if (ext === '.png' && res.body.length >= 24 && (res.body.readUInt32BE(16) < 16 || res.body.readUInt32BE(20) < 16)) return null;
  if (ext === '.svg') {
    const { svg, removed } = cleanSvg(res.body);
    if (removed.length) console.log(`  sanitised ${url}: removed ${[...new Set(removed)].join(', ')}`);
    return { buf: Buffer.from(svg, 'utf8'), ext, url };
  }
  if (ext === '.ico') {
    // A multi-size .ico that carries PNG frames: its largest frame, as a PNG of at most 128 px
    // (the same picture, a fraction of the bytes; solv.finance's .ico is 188 KB).
    const png = largestPngFrame(res.body);
    if (png) return { buf: recompressPng(shrinkPng(png, url)), ext: '.png', url };
  }
  return { buf: ext === '.png' ? recompressPng(shrinkPng(res.body, url)) : res.body, ext, url };
}

/**
 * The largest frame of an .ico file as PNG bytes, or null: a PNG frame as it is,
 * a 32- or 24-bit BMP frame decoded (with its AND mask for 24-bit) and encoded
 * as PNG. Paletted frames are left alone (null).
 */
export function largestPngFrame(ico) {
  if (ico.length < 6 || ico.readUInt16LE(2) !== 1) return null;
  const n = ico.readUInt16LE(4);
  const frames = [];
  for (let k = 0; k < n; k++) {
    const at = 6 + 16 * k;
    if (at + 16 > ico.length) break;
    const size = ico.readUInt32LE(at + 8);
    const off = ico.readUInt32LE(at + 12);
    if (off + size > ico.length || size < 8) continue;
    frames.push({ w: ico[at] || 256, data: ico.subarray(off, off + size) });
  }
  for (const f of frames.sort((a, b) => b.w - a.w)) {
    if (f.data[0] === 0x89 && f.data[1] === 0x50) return Buffer.from(f.data);
    const png = bmpFrameToPng(f.data);
    if (png) return png;
  }
  return null;
}

function bmpFrameToPng(d) {
  if (!PNG || d.length < 40 || d.readUInt32LE(0) < 40) return null;
  const hdr = d.readUInt32LE(0);
  const w = d.readInt32LE(4);
  const h = Math.abs(d.readInt32LE(8)) / 2; // the height counts the XOR and AND bitmaps
  const bpp = d.readUInt16LE(14);
  if (!(w > 0 && w <= 512 && h > 0 && h <= 512) || (bpp !== 32 && bpp !== 24) || d.readUInt32LE(16) !== 0) return null;
  const stride = Math.ceil((w * bpp) / 32) * 4;
  const maskStride = Math.ceil(w / 32) * 4;
  const maskAt = hdr + stride * h;
  if (maskAt > d.length) return null;
  const img = new PNG({ width: w, height: h });
  let anyAlpha = false;
  for (let y = 0; y < h; y++) {
    const row = hdr + (h - 1 - y) * stride; // bottom-up
    for (let x = 0; x < w; x++) {
      const p = row + x * (bpp / 8);
      const o = (y * w + x) * 4;
      img.data[o] = d[p + 2];
      img.data[o + 1] = d[p + 1];
      img.data[o + 2] = d[p];
      img.data[o + 3] = bpp === 32 ? d[p + 3] : 255;
      if (bpp === 32 && d[p + 3]) anyAlpha = true;
    }
  }
  // 24-bit frames, and 32-bit ones whose alpha is all zero, take transparency from the AND mask.
  if ((bpp === 24 || !anyAlpha) && maskAt + maskStride * h <= d.length) {
    for (let y = 0; y < h; y++) {
      const row = maskAt + (h - 1 - y) * maskStride;
      for (let x = 0; x < w; x++) img.data[(y * w + x) * 4 + 3] = (d[row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 255;
    }
  }
  return PNG.sync.write(img);
}

/**
 * The site's own icon: { buf, ext, url } or null. `domain` is a hostname
 * ("ishares.com"); `page` an optional page to read the declared icons from
 * (default https://<domain>/).
 */
export async function siteIcon(domain, page = `https://${domain}/`) {
  const tried = new Set();
  const attempt = async (url) => {
    if (tried.has(url)) return null;
    tried.add(url);
    return imageAt(url);
  };
  // The conventional touch icon first: one small request, and most sites have it.
  const touch = await attempt(`https://${domain}/apple-touch-icon.png`);
  if (touch) return touch;
  const head = await get(page, HEAD_BYTES);
  const base = head?.url ?? page;
  const html = head && /html|xml|text/.test(head.type) ? head.body.toString('utf8') : '';
  const origin = new URL(base).origin;
  for (const url of [...declaredIcons(html, base), `${origin}/apple-touch-icon.png`, `${origin}/favicon.ico`, `https://${domain}/favicon.ico`]) {
    const img = await attempt(url);
    if (img) return img;
  }
  return null;
}

/**
 * Replace one tool's section of tools/logo-sources.json ({ key: source URL or
 * fallback note }), leaving the other tools' sections as they are.
 */
export function recordSources(section, entries) {
  const file = new URL('./logo-sources.json', import.meta.url);
  let all = {};
  try {
    all = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* first run */
  }
  all[section] = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(file, JSON.stringify(sorted, null, 1) + '\n');
}
