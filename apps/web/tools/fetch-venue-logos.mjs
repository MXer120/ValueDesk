#!/usr/bin/env node
/**
 * Coin and brand logos for the venues other than SoDEX (Hyperliquid, trade.xyz,
 * Lighter, Arcus), downloaded once into apps/web/public/logos/venues/ with the
 * manifest src/logoManifestVenues.ts. The app only ever loads these files
 * from our own origin.
 *
 *   node apps/web/tools/fetch-venue-logos.mjs
 *
 * Kept apart from fetch-logos.mjs (SoDEX's set): that tool rebuilds
 * public/logos by swapping in a staged copy, and must not have to know about
 * these. Anything SoDEX's set already has is skipped here.
 *
 * Coin source: Hyperliquid's own icon set, app.hyperliquid.xyz/coins/<NAME>.svg -
 * it covers its perps and the HIP-3 `xyz:` stocks; a spot token's file is named
 * after its pair, <BASE>_<QUOTE>.svg (PURR_USDC.svg), as the Hyperliquid app
 * itself loads it. An unknown name there answers an HTML page, which is
 * rejected (only image/* is kept). Coins it does not have take their owner's
 * own icon (fetch-site-logos.mjs COIN_SITES); a coin no allowed source has an
 * icon for gets the mark of the venue it trades on (VENUE_OF below: Hyperliquid's
 * for its perps and spot tokens, trade.xyz's for `xyz:` markets, Lighter's,
 * Arcus's) - never a letter. Licence review 2026-10-28: TradingView's crypto
 * marks and its symbol search (issuer logos) are no longer used - its terms bar
 * commercial use without an agreement.
 *
 * Every download is paced with site-icon.mjs's budget (~1.5 MB/s, one at a
 * time: the laptop's bandwidth cap). An SVG that embeds a large PNG (some
 * memecoin icons are 0.5-1 MB) has that PNG shrunk to 128 px - the drawing and
 * its displayed size are unchanged.
 *
 * Brand marks: each venue's own apple-touch-icon, read from its app's HTML.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { recompressPng, shrinkPng } from './png-shrink.mjs';
import { SLIM_OVER, cleanSvg, slimTracedSvg } from './logo-clean.mjs';
import { pace, recordSources } from './site-icon.mjs';
import { COIN_LOGOS } from '../src/logoManifest.ts';
import { SITE_COIN_LOGOS } from '../src/logoManifestSites.ts';
import { logoCandidates, resolveKey } from '../src/logoKey.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(WEB, 'public', 'logos', 'venues');
const MANIFEST = join(WEB, 'src', 'logoManifestVenues.ts');
const UA = { 'User-Agent': 'Mozilla/5.0 (valuedesk logo sync)' };
const HL_INFO = 'https://api.hyperliquid.xyz/info';
const HL_COINS = 'https://app.hyperliquid.xyz/coins';

const BRANDS = {
  HYPERLIQUID: 'https://app.hyperliquid.xyz',
  TRADEXYZ: 'https://app.trade.xyz',
  LIGHTER: 'https://app.lighter.xyz',
  ARCUS: 'https://arcus.xyz',
};

const EXT = { 'image/svg+xml': '.svg', 'image/png': '.png', 'image/webp': '.webp', 'image/jpeg': '.jpg' };
const MAX_BYTES = 300_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, body) {
  const res = await fetch(url, body
    ? { method: 'POST', headers: { ...UA, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }
    : { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  await pace(text.length);
  return JSON.parse(text);
}

/** An image at `url`, or null (not found, not an image, too big). */
async function image(url) {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) });
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!res.ok || !EXT[type]) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    await pace(buf.length);
    if (!buf.length || buf.length > MAX_BYTES * 4) return null;
    return { buf, ext: EXT[type], url: res.url || url };
  } catch {
    return null;
  }
}

/**
 * SVGs are sanitised - script, event handlers, foreignObject, external or
 * javascript: references (security audit W-09) - and minified without
 * changing a pixel; see logo-clean.mjs. Anything removed is reported.
 */
function cleanedSvg(buf, label) {
  const { svg, removed } = cleanSvg(buf);
  if (removed.length) console.log(`  sanitised ${label}: removed ${[...new Set(removed)].join(', ')}`);
  const small = shrinkEmbedded(svg, label);
  // A traced photo (thousands of paths, 0.5-1 MB): coordinates rounded to 1/1000 of its box (logo-clean.mjs).
  const slim = small.length > SLIM_OVER ? slimTracedSvg(small) : small;
  if (slim.length < small.length) console.log(`  slimmed ${label}: ${Math.round(small.length / 1024)} KB -> ${Math.round(slim.length / 1024)} KB`);
  return Buffer.from(slim, 'utf8');
}

/** PNGs embedded in an SVG, shrunk to at most 128 px (their <image> keeps its width / height, so nothing moves). */
function shrinkEmbedded(svg, label) {
  return svg.replace(/(data:image\/png;base64,)([A-Za-z0-9+/=\s]+)/g, (m, head, b64) => {
    const png = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
    const out = recompressPng(shrinkPng(png, label));
    return out.length < png.length ? head + out.toString('base64') : m;
  });
}

/** The venue whose mark a coin without any icon shows (a key of BRANDS). */
function venueOf(c) {
  if (c.venue) return c.venue;
  return /^xyz:/i.test(c.name) ? 'TRADEXYZ' : 'HYPERLIQUID';
}

/**
 * The largest file shipped as a coin icon. A traced photo that is still bigger
 * after slimming (a few memecoins, up to 1 MB for a 20 px disc) is shipped as a
 * 96 px WebP drawn from it instead (a few KB) - its own logo, not the venue's.
 */
export const MAX_ICON = 300_000;

async function rasterized(svg) {
  const w = Number(/<svg[^>]*width="([\d.]+)"/.exec(svg.toString('utf8', 0, 400))?.[1]) || 96;
  const buf = await sharp(svg, { density: Math.max(1, Math.min(72, Math.round((72 * 192) / w))), limitInputPixels: false })
    .resize(96, 96, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
  return { ext: '.webp', prepared: buf };
}

function prepared(img, label) {
  return img.ext === '.png' ? recompressPng(shrinkPng(img.buf, label)) : img.ext === '.svg' ? cleanedSvg(img.buf, label) : img.buf;
}

function write(rel, img, label) {
  const file = join(OUT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, img.prepared ?? prepared(img, label));
}

/** Every market / coin name the four venues use, with the name Hyperliquid would know it by. */
async function venueCoins() {
  const out = [];
  const meta = await json(HL_INFO, { type: 'meta' });
  for (const u of meta.universe ?? []) if (!u.isDelisted) out.push({ name: u.name, hl: u.name });
  const dexes = await json(HL_INFO, { type: 'perpDexs' });
  for (const d of dexes ?? []) {
    if (!d?.name) continue;
    const m = await json(HL_INFO, { type: 'meta', dex: d.name });
    for (const u of m.universe ?? []) if (!u.isDelisted) out.push({ name: u.name, hl: u.name });
  }
  const spot = await json(HL_INFO, { type: 'spotMeta' });
  // A spot token's icon is its pair's: <BASE>_<QUOTE>.svg (the first pair it trades in).
  const tokens = new Map((spot.tokens ?? []).map((t) => [t.index, t]));
  const pairOf = new Map();
  for (const u of spot.universe ?? []) {
    const [b, q] = u.tokens ?? [];
    if (!pairOf.has(b) && tokens.get(b)?.name && tokens.get(q)?.name) pairOf.set(b, `${tokens.get(b).name}_${tokens.get(q).name}`);
  }
  for (const [idx, pair] of pairOf) out.push({ name: tokens.get(idx).name, hl: tokens.get(idx).name, pair });
  const lighter = await json('https://mainnet.zklighter.elliot.ai/api/v1/orderBooks');
  for (const o of lighter.order_books ?? []) if (o?.symbol) out.push({ name: o.symbol, hl: null, venue: 'LIGHTER' });
  const arcus = await json('https://api.arcus.xyz/v1/markets');
  for (const m of Array.isArray(arcus) ? arcus : (arcus.markets ?? Object.values(arcus))) {
    if (m?.marketDisplayName) out.push({ name: m.marketDisplayName, hl: null, venue: 'ARCUS' });
  }
  return out;
}

async function main() {
  const coins = await venueCoins();
  const want = new Map();
  for (const c of coins) {
    if (resolveKey(c.name, COIN_LOGOS) || resolveKey(c.name, SITE_COIN_LOGOS)) continue; // SoDEX's set or the owners' own already has it
    const key = logoCandidates(c.name).find((k) => !k.includes(':') && !k.includes('/') && !k.includes('-')) ?? logoCandidates(c.name)[0];
    if (!key || want.has(key)) continue;
    want.set(key, c);
  }
  console.log(`${coins.length} venue names, ${want.size} coins without a logo`);

  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  const manifest = {};
  const sources = {};
  const heavy = {};
  let i = 0;
  for (const [key, c] of want) {
    const tries = [
      ...(c.pair ? [`${HL_COINS}/${encodeURIComponent(c.pair)}.svg`] : []),
      ...(c.hl ? [`${HL_COINS}/${encodeURIComponent(c.hl).replace(/%3A/g, ':')}.svg`] : []),
      `${HL_COINS}/${key}.svg`,
      `${HL_COINS}/xyz:${key}.svg`,
    ];
    for (const url of tries) {
      const img = await image(url);
      if (!img) continue;
      img.prepared = prepared(img, key);
      if (img.prepared.length > MAX_ICON) {
        if (img.ext !== '.svg') {
          heavy[key] = `${img.url} is ${Math.round(img.prepared.length / 1024)} KB even slimmed (over ${MAX_ICON / 1000} KB)`;
          continue;
        }
        Object.assign(img, await rasterized(img.buf));
      }
      const rel = `coins/${key.replace(/[^A-Z0-9_.]/gi, '_')}${img.ext}`;
      write(rel, img, key);
      manifest[key] = `venues/${rel}`;
      sources[key] = img.url;
      break;
    }
    if (++i % 50 === 0) console.log(`  ${i}/${want.size}`);
    await sleep(60);
  }

  const brand = {};
  for (const [key, site] of Object.entries(BRANDS)) {
    try {
      const html = await (await fetch(site, { headers: UA, signal: AbortSignal.timeout(20_000) })).text();
      await pace(html.length);
      const href = /<link[^>]*rel="apple-touch-icon"[^>]*href="([^"]+)"/i.exec(html)?.[1]
        ?? /<link[^>]*href="([^"]+)"[^>]*rel="apple-touch-icon"/i.exec(html)?.[1];
      if (!href) throw new Error('no apple-touch-icon');
      const img = await image(new URL(href, site + '/').toString());
      if (!img) throw new Error(`icon ${href} did not load`);
      const rel = `brand/${key.toLowerCase()}${img.ext}`;
      write(rel, img, key);
      brand[key] = `venues/${rel}`;
      sources[`brand:${key}`] = img.url;
    } catch (e) {
      console.warn(`brand ${key}: ${e.message}`);
    }
  }

  // No allowed source has an icon: the mark of the venue it trades on, never a letter.
  const missing = [...want.keys()].filter((k) => !manifest[k]);
  const fellBack = {};
  for (const k of missing) {
    const v = venueOf(want.get(k));
    const mark = brand[v] ?? brand.HYPERLIQUID;
    if (mark) {
      manifest[k] = mark;
      sources[k] = heavy[k] ? `${heavy[k]}: ${v}'s venue mark` : `no icon at any allowed source: ${v}'s venue mark`;
      (fellBack[v] ??= []).push(k);
    }
  }
  console.log(`coins: ${Object.keys(manifest).length - missing.length} icons saved, ${missing.length} without any source show their venue's mark:`);
  for (const [v, ks] of Object.entries(fellBack)) console.log(`  ${v} (${ks.length}): ${ks.join(' ')}`);

  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(
    MANIFEST,
    `/* Generated by tools/fetch-venue-logos.mjs - do not edit by hand. */\n` +
      `export const VENUE_COIN_LOGOS: Record<string, string> = ${JSON.stringify(sorted(manifest), null, 1)};\n\n` +
      `export const VENUE_BRAND_LOGOS: Record<string, string> = ${JSON.stringify(sorted(brand), null, 1)};\n`,
  );
  recordSources('venues', sources);
  console.log(`brands: ${Object.keys(brand).join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
