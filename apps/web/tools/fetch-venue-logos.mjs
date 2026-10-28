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
 * it covers its perps, its spot tokens and the HIP-3 `xyz:` stocks. An unknown
 * name there answers an HTML page, which is rejected (only image/* is kept).
 * Coins it does not have take their owner's own icon (fetch-site-logos.mjs
 * COIN_SITES) or keep the app's letter avatar. Licence review 2026-10-28:
 * TradingView's crypto marks and its symbol search (issuer logos) are no longer
 * used - its terms bar commercial use without an agreement.
 *
 * Brand marks: each venue's own apple-touch-icon, read from its app's HTML.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recompressPng, shrinkPng } from './png-shrink.mjs';
import { cleanSvg } from './logo-clean.mjs';
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
  return res.json();
}

/** An image at `url`, or null (not found, not an image, too big). */
async function image(url) {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) });
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!res.ok || !EXT[type]) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES * 4) return null;
    return { buf, ext: EXT[type] };
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
  return Buffer.from(svg, 'utf8');
}

function write(rel, img, label) {
  const file = join(OUT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, img.ext === '.png' ? recompressPng(shrinkPng(img.buf, label)) : img.ext === '.svg' ? cleanedSvg(img.buf, label) : img.buf);
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
  const traded = new Set((spot.universe ?? []).flatMap((u) => u.tokens ?? []));
  for (const t of spot.tokens ?? []) if (t?.name && traded.has(t.index)) out.push({ name: t.name, hl: t.name });
  const lighter = await json('https://mainnet.zklighter.elliot.ai/api/v1/orderBooks');
  for (const o of lighter.order_books ?? []) if (o?.symbol) out.push({ name: o.symbol, hl: null });
  const arcus = await json('https://api.arcus.xyz/v1/markets');
  for (const m of Array.isArray(arcus) ? arcus : (arcus.markets ?? Object.values(arcus))) {
    if (m?.marketDisplayName) out.push({ name: m.marketDisplayName, hl: null });
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
  let i = 0;
  for (const [key, c] of want) {
    const tries = [
      ...(c.hl ? [`${HL_COINS}/${encodeURIComponent(c.hl).replace(/%3A/g, ':')}.svg`] : []),
      `${HL_COINS}/${key}.svg`,
      `${HL_COINS}/xyz:${key}.svg`,
    ];
    for (const url of tries) {
      const img = await image(url);
      if (!img) continue;
      const rel = `coins/${key.replace(/[^A-Z0-9_.]/gi, '_')}${img.ext}`;
      write(rel, img, key);
      manifest[key] = `venues/${rel}`;
      break;
    }
    if (++i % 50 === 0) console.log(`  ${i}/${want.size}`);
    await sleep(60);
  }

  const brand = {};
  for (const [key, site] of Object.entries(BRANDS)) {
    try {
      const html = await (await fetch(site, { headers: UA, signal: AbortSignal.timeout(20_000) })).text();
      const href = /<link[^>]*rel="apple-touch-icon"[^>]*href="([^"]+)"/i.exec(html)?.[1]
        ?? /<link[^>]*href="([^"]+)"[^>]*rel="apple-touch-icon"/i.exec(html)?.[1];
      if (!href) throw new Error('no apple-touch-icon');
      const img = await image(new URL(href, site + '/').toString());
      if (!img) throw new Error(`icon ${href} did not load`);
      const rel = `brand/${key.toLowerCase()}${img.ext}`;
      write(rel, img, key);
      brand[key] = `venues/${rel}`;
    } catch (e) {
      console.warn(`brand ${key}: ${e.message}`);
    }
  }

  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(
    MANIFEST,
    `/* Generated by tools/fetch-venue-logos.mjs - do not edit by hand. */\n` +
      `export const VENUE_COIN_LOGOS: Record<string, string> = ${JSON.stringify(sorted(manifest), null, 1)};\n\n` +
      `export const VENUE_BRAND_LOGOS: Record<string, string> = ${JSON.stringify(sorted(brand), null, 1)};\n`,
  );
  const missing = [...want.keys()].filter((k) => !manifest[k]);
  console.log(`coins: ${Object.keys(manifest).length} saved, ${missing.length} without any source (letter avatar): ${missing.slice(0, 60).join(' ')}`);
  console.log(`brands: ${Object.keys(brand).join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
