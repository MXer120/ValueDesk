#!/usr/bin/env node
/**
 * Downloads every coin and chain logo SoDEX lists into apps/web/public/logos
 * and writes the manifest the app resolves them with (src/logoManifest.ts).
 *
 *   node apps/web/tools/fetch-logos.mjs
 *
 * This is a maintenance tool, not a runtime dependency: the app only ever
 * loads the files this writes, from our own origin. Re-run it when SoDEX lists
 * something new, review the diff, and ship the files with the app.
 *
 * Sources, first match wins per symbol:
 *   1. sodex.com's own icon set - the symbol -> icon map in its trade bundle
 *      (read from the live bundle, so it stays current) plus the files it
 *      points at under sodex.com/assets/img/{tokens,chains}/.
 *   2. SUPPLEMENT below - listed assets sodex.com itself has no icon for
 *      (newer stocks/ETFs/pre-IPO perps, a few memecoins). Each one was
 *      checked by hand against the issuer / listing it names.
 *   3. SoDEX's coins/logo config - most of its S3 links are dead (404); the
 *      ones that still answer are kept.
 *
 * The run fails without touching the manifest if any listed asset or chain
 * ends up without an image, so a partial download can never ship.
 */
import { mkdirSync, writeFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Icons render at 16-64 CSS px; some sources ship 400-1600 px PNGs (sodex.com's sol.png is 400 KB).
import { recompressPng, shrinkPng } from './png-shrink.mjs';
import { cleanSvg } from './logo-clean.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(WEB, 'public', 'logos');
// Staged outside the repo: a synced folder (OneDrive) or the dev server's watcher can lock a directory mid-swap.
const STAGE = join(tmpdir(), 'valuedesk-logos-staging');
const MANIFEST = join(WEB, 'src', 'logoManifest.ts');

const SODEX = 'https://sodex.com';
const GATEWAY = 'https://mainnet-gw.sodex.dev/api/v1';
const COINS_LOGO = 'https://alpha-biz.sodex.dev/biz/config/coins/logo';
const TV = 'https://s3-symbol-logo.tradingview.com';
const UA = { 'User-Agent': 'Mozilla/5.0 (valuedesk logo sync)' };

/** Listed on SoDEX, no icon on sodex.com. Keys are canonical (see canonical()). */
const SUPPLEMENT = {
  // US ETFs - issuer marks, same TradingView set sodex.com's stock icons come from.
  QQQ: { tv: 'invesco' }, // Invesco QQQ Trust (NASDAQ:QQQ)
  VOO: { tv: 'vanguard' }, // Vanguard S&P 500 ETF
  VGT: { tv: 'vanguard' }, // Vanguard Information Technology ETF
  VYM: { tv: 'vanguard' }, // Vanguard High Dividend Yield ETF
  SMH: { tv: 'vaneck' }, // VanEck Semiconductor ETF
  SCHD: { tv: 'schwab' }, // Schwab US Dividend Equity ETF
  BOXX: { tv: 'alpha-architect' }, // Alpha Architect 1-3 Month Box ETF (CBOE:BOXX)
  DRAM: { tv: 'roundhmetave-aeoa' }, // Roundhill Memory ETF (CBOE:DRAM)
  // Stocks
  STRC: { sameAs: 'MSTR' }, // Strategy Inc. Stretch preferred (NASDAQ:STRC) - Strategy's mark
  SMCI: { tv: 'super-micro-computer' }, // Super Micro Computer
  MRNA: { tv: 'moderna' }, // Moderna
  NBIS: { tv: 'nebius-group-nv' }, // Nebius Group
  LITE: { tv: 'lumentum-hldgs' }, // Lumentum Holdings
  KIOXIA: { tv: 'kioxia' }, // Kioxia Holdings (TSE:285A)
  MINIMAX: { tv: 'minimax' }, // MiniMax Group (HKEX:100)
  ZHIPU: { tv: 'knowledge-atlas-technology-joint-stock-company-limited-class-h' }, // Z.AI / Zhipu (HKEX:2513)
  UNITREE: { unitree: true }, // Unitree Robotics (pre-IPO) - the company's own mark
  // Crypto
  MORPHO: { tv: 'crypto/XTVCMORPHO' },
  BREV: { tv: 'crypto/XTVCBREV' }, // Brevis
  BASED: { tv: 'crypto/XTVCBASED2' },
  BIANRENSHENG: { tv: 'crypto/XTVCBIANRENSHENG' }, // 币安人生
  GRAM: { tv: 'crypto/XTVCGRAM' }, // Gram (previously Toncoin)
  CASHCAT: { coingecko: 'cash-cat' },
  PONS: { coingecko: 'pons' },
  NIULAI: { coingecko: 'niu-lai' }, // 牛来
};

/** SoDEX's own mark (the 20px "XS" one, dark-theme), for "SoDEX Spot" and the like. */
const BUNDLED_BRAND = { SODEX: 'SoDEX_XS_Dark.svg' };

/**
 * Chains whose own logo sodex.com bundles into its app (data URIs / hashed
 * files under "/src/assets/images/logo/chains/") rather than serving from
 * /assets/img/chains/ - preferred over the coin stand-ins below. Arc has a
 * light and a dark mark; this UI is dark, so the dark-theme one.
 */
const BUNDLED_CHAIN = { ARC: 'arc-dark.svg', AVAXC: 'avaxc.png', HYPEREVM_HYPE: 'hyperevm_hype.jpg', LTC: 'ltc.png', TON: 'ton.jpg', XLM: 'xlm.jpg', SUI: 'sui.png' };

/** Chains sodex.com's chain map leaves out -> the coin whose icon stands for them. */
const CHAIN_AS_COIN = { AVAXC: 'AVAX', HYPEREVM_HYPE: 'HYPE', SUI: 'SUI', LTC: 'LTC', TRX: 'TRX', TON: 'TON', XLM: 'XLM', ZEC: 'ZEC', POLYGON: 'POL' };

/**
 * The key a symbol is filed under. Mirrors the resolver in src/logos.ts: upper
 * case, SoDEX's ValueChain prefixes (v, vs, a) are handled there by trying
 * candidates, so the manifest keeps sodex.com's own keys verbatim (upper-cased).
 */
const canonical = (k) => k.trim().toUpperCase();

// ---------------------------------------------------------------------------

async function get(url, { json = false, attempts = 3 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25_000) });
      if (res.status === 404) throw Object.assign(new Error('HTTP 404'), { final: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? await res.json() : res;
    } catch (e) {
      last = e;
      if (e.final) break;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error(`${url}: ${last?.message}`);
}

const EXT = { 'image/png': '.png', 'image/svg+xml': '.svg', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

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
const saved = new Map(); // source url -> relative path (one file per source image)
const byContent = new Map(); // sha1 of the stored bytes -> relative path (identical images stored once)
const failed = new Map(); // source url -> error, so a dead link is asked once, not once per key

async function save(url, relNoExt) {
  if (saved.has(url)) return saved.get(url);
  if (failed.has(url)) throw failed.get(url);
  const res = await get(url).catch((e) => {
    failed.set(url, e);
    throw e;
  });
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  const buf = Buffer.from(await res.arrayBuffer());
  const urlExt = extname(new URL(url).pathname).toLowerCase();
  const ext = EXT[type] ?? (['.png', '.svg', '.jpg', '.jpeg', '.webp'].includes(urlExt) ? urlExt : null);
  if (!ext) throw new Error(`${url}: not an image (${type || 'no content-type'})`);
  if (buf.length < 64) throw new Error(`${url}: empty image`);
  if (ext === '.svg' && !/<svg[\s>]/i.test(buf.toString('utf8', 0, 4096))) throw new Error(`${url}: not an SVG`);
  const bytes = ext === '.png' ? recompressPng(shrinkPng(buf, url)) : ext === '.svg' ? cleanedSvg(buf, url) : buf;
  const hash = createHash('sha1').update(bytes).digest('hex');
  let rel = byContent.get(hash);
  if (!rel) {
    rel = `${relNoExt}${ext === '.jpeg' ? '.jpg' : ext}`;
    mkdirSync(dirname(join(STAGE, rel)), { recursive: true });
    writeFileSync(join(STAGE, rel), bytes);
    byContent.set(hash, rel);
  }
  saved.set(url, rel);
  return rel;
}

/** A bundled logo: a data: URI decoded to a file, or a hashed /assets/ file downloaded. */
async function saveBundled(src, relNoExt) {
  if (!src.startsWith('data:')) return save(SODEX + src, relNoExt);
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
  if (!m) throw new Error(`${relNoExt}: unreadable data URI`);
  const ext = EXT[m[1]];
  if (!ext) throw new Error(`${relNoExt}: ${m[1]} is not an image type`);
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  const rel = `${relNoExt}${ext}`;
  mkdirSync(dirname(join(STAGE, rel)), { recursive: true });
  writeFileSync(join(STAGE, rel), ext === '.png' ? recompressPng(shrinkPng(buf, relNoExt)) : ext === '.svg' ? cleanedSvg(buf, relNoExt) : buf);
  return rel;
}

const fileSafe = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1).replace(/\.[a-z]+$/i, '');

/** sodex.com's symbol->icon and chain->icon maps, straight from its current trade bundle. */
async function sodexIconMaps() {
  const html = await (await get(`${SODEX}/trade/futures/BTC-USD`)).text();
  const scripts = [...new Set(html.match(/\/assets\/[A-Za-z0-9_.-]+\.js/g) ?? [])];
  const maps = [];
  const bundledChains = {};
  const bundledBrand = {};
  for (const path of scripts.filter((p) => /\/(features|main)-/.test(p))) {
    const src = await (await get(SODEX + path)).text();
    for (const m of src.matchAll(/"\/src\/assets\/images\/logo\/((?:chains\/)?[^"]+)":([A-Za-z_$][\w$]*)/g)) {
      const [, name, v] = m;
      const chain = name.startsWith('chains/');
      const file = chain ? name.slice('chains/'.length) : name;
      const into = chain ? bundledChains : bundledBrand;
      for (const q of ['`', '"']) {
        const at = src.indexOf(`${v}=${q}`);
        if (at < 0) continue;
        const from = at + v.length + 2;
        into[file] = src.slice(from, src.indexOf(q, from));
        break;
      }
    }
    const re = /[A-Za-z_$][\w$]*=\{(?=(?:[A-Za-z0-9_$.]+|`[^`]*`|"[^"]*"):`(?:\/assets\/img\/|https:\/\/)[^`]+`,)/g;
    let m;
    while ((m = re.exec(src))) {
      let depth = 0, j = m.index + m[0].length - 1;
      for (; j < src.length; j++) {
        const c = src[j];
        if (c === '`') { j = src.indexOf('`', j + 1); continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
      }
      const body = src.slice(m.index + m[0].length, j);
      const entries = [...body.matchAll(/(?:^|,)\s*(?:([A-Za-z0-9_$.]+)|`([^`]*)`|"([^"]*)"):`([^`]*)`/g)].map((e) => [e[1] ?? e[2] ?? e[3], e[4]]);
      if (entries.every(([, v]) => /^(\/assets\/img\/|https:\/\/)/.test(v))) maps.push(entries);
    }
  }
  const coins = maps.find((m) => m.some(([k]) => k === 'vUSDC') && m.some(([, v]) => v.startsWith('/assets/img/tokens/')));
  const chains = maps.find((m) => m.some(([k]) => k === 'BASE_ETH') && m.some(([, v]) => v.startsWith('/assets/img/chains/')));
  if (!coins || !chains) throw new Error('sodex.com bundle changed shape: symbol/chain icon maps not found - update sodexIconMaps()');
  return { coins, chains, bundledChains, bundledBrand };
}

/** Every asset and chain SoDEX lists right now (markets, coins, deposit/withdraw config). */
async function listedAssets() {
  const [spotSyms, perpSyms, spotCoins, perpCoins, config] = await Promise.all(
    ['spot/markets/symbols', 'perps/markets/symbols', 'spot/markets/coins', 'perps/markets/coins', 'asset/config'].map((p) => get(`${GATEWAY}/${p}`, { json: true }).then((j) => j.data ?? [])),
  );
  const assets = new Set();
  for (const s of spotSyms) assets.add(s.baseCoin).add(s.quoteCoin);
  for (const s of perpSyms) assets.add(s.baseCoin);
  for (const c of [...spotCoins, ...perpCoins]) assets.add(c.name);
  const chains = new Set(['VALUECHAIN']);
  for (const a of config) {
    assets.add(a.assetName);
    for (const c of a.chains ?? []) chains.add(c.chainName);
  }
  return { assets: [...assets].filter(Boolean), chains: [...chains] };
}

async function coingeckoImage(id) {
  const j = await get(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`, { json: true });
  const url = j?.image?.large;
  if (!url) throw new Error(`coingecko ${id}: no image`);
  return url.replace(/\?.*$/, '');
}

/** Unitree publishes a dark "U" on transparent; frame it like the other stock tiles so it reads on dark UI. */
async function unitreeTile() {
  const svg = await (await get('https://www.unitree.com/unitree-favicon.svg')).text();
  const paths = [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
  if (!paths.length) throw new Error('unitree favicon: no path');
  const rel = 'coins/UNITREE.svg';
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1D1D1F"/><g fill="#FFFFFF" transform="translate(16 16) scale(.68)">${paths.map((d) => `<path d="${d}"/>`).join('')}</g></svg>\n`;
  mkdirSync(dirname(join(STAGE, rel)), { recursive: true });
  writeFileSync(join(STAGE, rel), cleanedSvg(Buffer.from(tile, 'utf8'), rel));
  return rel;
}

// ---------------------------------------------------------------------------

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const coins = {}; // canonical key -> relative path
const chains = {};
const brand = {};
const problems = [];
const put = (map, key, rel) => { if (!map[key]) map[key] = rel; };

const sodexMaps = await sodexIconMaps();
const listed = await listedAssets();

// 1. sodex.com's own icons.
for (const [key, src] of sodexMaps.coins) {
  try {
    const url = src.startsWith('/') ? SODEX + src : src;
    const rel = src.startsWith('/assets/img/tokens/')
      ? await save(url, `tokens/${fileSafe(baseName(src))}`)
      : await save(url, src.includes('indexIcon') ? 'coins/ssi-index' : `coins/${fileSafe(canonical(key))}`);
    put(coins, canonical(key), rel);
  } catch (e) {
    if (!problems.includes(e.message)) problems.push(e.message);
  }
}
for (const [key, src] of sodexMaps.chains) {
  try {
    put(chains, canonical(key), await save(SODEX + src, `chains/${fileSafe(baseName(src))}`));
  } catch (e) {
    problems.push(e.message);
  }
}

// Chain logos sodex.com bundles into its app win over the plain files and the coin stand-ins.
for (const [key, file] of Object.entries(BUNDLED_CHAIN)) {
  const src = sodexMaps.bundledChains[file];
  if (!src) continue;
  try {
    chains[key] = await saveBundled(src, `chains/${fileSafe(baseName(file))}`);
  } catch (e) {
    problems.push(e.message);
  }
}

for (const [key, file] of Object.entries(BUNDLED_BRAND)) {
  const src = sodexMaps.bundledBrand[file];
  if (!src) {
    problems.push(`brand logo ${file} not found in the sodex.com bundle`);
    continue;
  }
  try {
    brand[key] = await saveBundled(src, `brand/${key.toLowerCase()}`);
  } catch (e) {
    problems.push(e.message);
  }
}

// 2. Listed assets sodex.com has no icon for.
for (const [key, how] of Object.entries(SUPPLEMENT)) {
  if (coins[key]) continue;
  try {
    if (how.sameAs) {
      if (!coins[how.sameAs]) throw new Error(`${key}: ${how.sameAs} has no icon to share`);
      coins[key] = coins[how.sameAs];
    } else if (how.tv) {
      coins[key] = await save(`${TV}/${how.tv}.svg`, `coins/${fileSafe(key)}`);
    } else if (how.coingecko) {
      coins[key] = await save(await coingeckoImage(how.coingecko), `coins/${fileSafe(key)}`);
      await new Promise((r) => setTimeout(r, 2500)); // CoinGecko's public rate limit
    } else if (how.unitree) {
      coins[key] = await unitreeTile();
    }
  } catch (e) {
    problems.push(e.message);
  }
}

// 3. SoDEX's coin-logo config, where its links still work.
try {
  const { data = [] } = await get(COINS_LOGO, { json: true });
  let dead = 0;
  for (const c of data) {
    const key = canonical(String(c.coin ?? ''));
    if (!key || !c.logo || coins[key]) continue;
    try {
      coins[key] = await save(c.logo, `coins/${fileSafe(key)}`);
    } catch {
      dead++;
    }
  }
  console.log(`coins/logo: ${data.length} entries, ${dead} dead links skipped`);
} catch (e) {
  problems.push(e.message);
}

for (const [chain, coin] of Object.entries(CHAIN_AS_COIN)) if (!chains[chain] && coins[coin]) chains[chain] = coins[coin];

// Every listed asset and chain must resolve, with the same rules the app uses.
const { resolveKey } = await import('../src/logoKey.ts');
const unresolvedAssets = listed.assets.filter((a) => !resolveKey(a, coins));
const unresolvedChains = listed.chains.filter((c) => !chains[canonical(c)]);
if (problems.length) console.log('problems:\n  ' + problems.join('\n  '));
if (unresolvedAssets.length || unresolvedChains.length) {
  console.error(`missing icons - assets: ${unresolvedAssets.join(', ') || '-'}; chains: ${unresolvedChains.join(', ') || '-'}`);
  console.error('Add them to SUPPLEMENT / CHAIN_AS_COIN. Nothing was changed.');
  rmSync(STAGE, { recursive: true, force: true });
  process.exit(1);
}

// Replace the set in whole, so a re-run never leaves stale or half-written files behind.
rmSync(OUT, { recursive: true, force: true });
cpSync(STAGE, OUT, { recursive: true });
rmSync(STAGE, { recursive: true, force: true });

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(
  MANIFEST,
  `// Generated by tools/fetch-logos.mjs on ${new Date().toISOString().slice(0, 10)} - do not edit, re-run the tool.\n` +
    `// Paths are relative to public/logos/: the icons ship with the app and load from our own origin.\n\n` +
    `export const COIN_LOGOS: Record<string, string> = ${JSON.stringify(sorted(coins), null, 1)};\n\n` +
    `export const CHAIN_LOGOS: Record<string, string> = ${JSON.stringify(sorted(chains), null, 1)};\n\n` +
    `export const BRAND_LOGOS: Record<string, string> = ${JSON.stringify(sorted(brand), null, 1)};\n`,
);
const files = readdirSync(OUT, { recursive: true }).filter((f) => /\.[a-z]+$/.test(f)).length;
console.log(`ok: ${Object.keys(coins).length} coin keys, ${Object.keys(chains).length} chains, ${files} files; all ${listed.assets.length} listed assets and ${listed.chains.length} chains covered`);
