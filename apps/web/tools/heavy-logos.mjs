#!/usr/bin/env node
/**
 * The coin logos that cost a phone far more than they show (phone pass, 2026-11-18), brought to the size they are
 * drawn at. A coin icon is at most 32 px (CoinIcon), an address-book face 34 px: 128 px (png-shrink.mjs ICON_MAX)
 * is 3-4x that, so at any screen density these look as before.
 *
 *   - a raster logo (.jpg / .png / .webp) over 128 px: scaled to 128 px on its long side, same format and name
 *     (tokens/trump.jpg was a 660x880 photo, 297 KB, for a 20 px circle);
 *   - an SVG over 50 KB brotli (a traced photo, or a photo wrapped in SVG): the same SVG - same viewBox, same file
 *     name, so the manifests stay as generated - drawing one 128 px WebP of itself.
 *
 * Only the coin sets (logos/tokens, logos/coins, logos/venues/coins): those are only ever drawn that small. The
 * site, news, brand and address-book logos are left alone. Idempotent: a file already small enough is not touched.
 * Run after fetch-logos.mjs / fetch-venue-logos.mjs. Uses sharp when it resolves (it is not one of this app's
 * dependencies; nothing else needs it): without it, it says so and changes nothing.
 *
 *   node apps/web/tools/heavy-logos.mjs [--dry]
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGOS = join(HERE, '..', 'public', 'logos');
const DIRS = ['tokens', 'coins', join('venues', 'coins')];
/** Long side of a coin logo, px (png-shrink.mjs ICON_MAX). */
export const LOGO_MAX = 128;
/** An SVG heavier than this (brotli) is drawn as a raster of itself. */
export const SVG_MAX_BR = 50_000;
const dry = process.argv.includes('--dry');

let sharp;
try {
  sharp = createRequire(join(HERE, '..', 'package.json'))('sharp');
} catch {
  console.log('sharp not found - nothing changed');
  process.exit(0);
}

const br = (buf) => brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

/** A raster over LOGO_MAX, scaled down in its own format; null when it is small enough already. */
async function smallerRaster(buf, ext) {
  const meta = await sharp(buf).metadata();
  if (Math.max(meta.width ?? 0, meta.height ?? 0) <= LOGO_MAX) return null;
  const img = sharp(buf).resize({ width: LOGO_MAX, height: LOGO_MAX, fit: 'inside', kernel: 'lanczos3' });
  const fmt = meta.format;
  if (fmt === 'jpeg') return img.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  if (fmt === 'webp') return img.webp({ quality: 90 }).toBuffer();
  if (fmt === 'png') return img.png({ compressionLevel: 9, palette: false }).toBuffer();
  console.log(`  ${ext} in ${fmt}: kept`);
  return null;
}

/** An SVG over SVG_MAX_BR, as itself drawing a LOGO_MAX WebP of itself; null when it is light enough. */
async function rasterSvg(buf) {
  if (br(buf) <= SVG_MAX_BR) return null;
  const text = buf.toString('utf8');
  const vb = /viewBox\s*=\s*"([^"]+)"/.exec(text)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (!vb || vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = vb;
  const k = LOGO_MAX / Math.max(w, h);
  const px = { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
  const webp = await sharp(buf, { density: Math.max(72, Math.ceil(72 * k * 4)) }).resize({ ...px, fit: 'fill', kernel: 'lanczos3' }).webp({ quality: 90, alphaQuality: 100 }).toBuffer();
  // xlink:href, as the photo-in-SVG logos already use: every browser the app supports reads it.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${x} ${y} ${w} ${h}"><image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" xlink:href="data:image/webp;base64,${webp.toString('base64')}"/></svg>\n`;
  return Buffer.from(svg, 'utf8');
}

let before = 0;
let after = 0;
for (const dir of DIRS) {
  const abs = join(LOGOS, dir);
  for (const name of readdirSync(abs)) {
    const file = join(abs, name);
    if (!statSync(file).isFile()) continue;
    const ext = extname(name).toLowerCase();
    const buf = readFileSync(file);
    const out = ext === '.svg' ? await rasterSvg(buf) : ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? await smallerRaster(buf, ext) : null;
    if (!out || out.length >= buf.length) continue;
    const was = ext === '.svg' ? br(buf) : buf.length;
    const now = ext === '.svg' ? br(out) : out.length;
    before += was;
    after += now;
    console.log(`${join(dir, name)}: ${kb(was)} -> ${kb(now)}${ext === '.svg' ? ' (brotli)' : ''}`);
    if (!dry) writeFileSync(file, out);
  }
}
console.log(`${dry ? 'would save' : 'saved'} ${kb(before - after)} (${kb(before)} -> ${kb(after)})`);
