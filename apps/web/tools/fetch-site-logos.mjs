#!/usr/bin/env node
/**
 * Logos taken from their owners' own sites (site-icon.mjs) and from CC0 sets,
 * for what SoDEX's and Hyperliquid's icon sets do not cover - written once into
 * public/logos and shipped with the app; the app never asks a third party for
 * an image at runtime.
 *
 *   node apps/web/tools/fetch-site-logos.mjs            coins and news
 *   node apps/web/tools/fetch-site-logos.mjs --coins    the coin / stock icons only
 *   node apps/web/tools/fetch-site-logos.mjs --news     the news outlets' and venues' icons only
 *
 * Why (licence review 2026-10-28, docs/legal/THIRD-PARTY-REVIEW.md row 23-26):
 * TradingView's symbol logos (no commercial use without an agreement),
 * CoinGecko's and DefiLlama's images and the DuckDuckGo / Google favicon
 * services are no longer used. Instead:
 *
 *   coins  COIN_SITES: a stock's, fund's or project's own icon from its own site,
 *          shown small next to its own ticker - identification (nominative use
 *          of the owner's mark). CC0: a few icons from spothq/cryptocurrency-icons
 *          (CC0 1.0, no rights reserved). Anything else keeps the app's letter
 *          avatar. Written to public/logos/sites/ + src/logoManifestSites.ts,
 *          which logos.ts reads after SoDEX's set and before the other venues'.
 *   news   every site in public/logos/news.json (the outlets the news names) and
 *          the price oracle's venues: their own icons, re-taken from the sites
 *          themselves; a site that cannot be read keeps the file it has. The
 *          Federal Reserve Board, the St. Louis Fed, the SEC, the DOL and Kalshi keep the neutral
 *          letter badges in the folder (official seals, or marks that need written permission).
 *
 * Downloads are staged in the OS temp folder, checked (images only, SVGs
 * sanitised, PNGs shrunk to 128 px) and only then copied into public/.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloaded, imageAt, siteIcon } from './site-icon.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOGOS = join(WEB, 'public', 'logos');
const STAGE = join(tmpdir(), 'valuedesk-site-logos-staging');
const MANIFEST = join(WEB, 'src', 'logoManifestSites.ts');
const NEWS_JSON = join(LOGOS, 'news.json');

/** CC0 1.0 (github.com/spothq/cryptocurrency-icons, LICENSE.md): the same coin, checked by name. */
const CC0 = 'https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/svg/color';
const CC0_COINS = { NMR: 'nmr', RAY: 'ray' }; // Numeraire, Raydium

/**
 * Ticker -> the issuer's or project's own site. Only where the venue's ticker is
 * certainly that asset (a US listing, an Arcus market's full name, a project
 * whose token is listed under its own name). Memecoins and unclear tickers keep
 * the letter avatar.
 */
export const COIN_SITES = {
  // US stocks
  ADI: 'analog.com', ARM: 'arm.com', AVGO: 'broadcom.com', AXTI: 'axt.com', BAC: 'bankofamerica.com', BE: 'bloomenergy.com',
  CCL: 'carnival.com', CIFR: 'ciphermining.com', EBAY: 'ebay.com', F: 'ford.com', IONQ: 'ionq.com', MELI: 'mercadolibre.com',
  MRNA: 'modernatx.com', NBIS: 'nebius.com', QCOM: 'qualcomm.com', SMCI: 'supermicro.com', SOFI: 'sofi.com', TTWO: 'take2games.com',
  LITE: 'lumentum.com',
  // Other listings and pre-IPO
  BYD: 'byd.com', KIOXIA: 'kioxia.com', MINIMAX: 'minimax.io', ZHIPU: 'z.ai', SPACEX: 'spacex.com', UNITREE: 'unitree.com',
  // Funds: the issuer's mark
  DIA: 'ssga.com', SPY: 'ssga.com', XBI: 'ssga.com', GLD: 'spdrgoldshares.com',
  IWM: 'ishares.com', SOXX: 'ishares.com', SGOV: 'ishares.com', SLV: 'ishares.com', EWT: 'ishares.com', IGV: 'ishares.com',
  BOTZ: 'globalxetfs.com', URA: 'globalxetfs.com', CPER: 'uscfinvestments.com', USO: 'uscfinvestments.com',
  VOO: 'vanguard.com', VGT: 'vanguard.com', VYM: 'vanguard.com', VT: 'vanguard.com', SCHD: 'schwab.com', SMH: 'vaneck.com',
  QQQ: 'invesco.com', QQQM: 'invesco.com', SOXS: 'direxion.com', URNM: 'sprott.com', BOXX: 'alphaarchitect.com',
  DRAM: 'roundhillinvestments.com', RVI: 'robinhood.com',
  // Crypto projects listed under their own token
  MORPHO: 'morpho.org', HMSTR: 'hamsterkombatgame.io', BREV: 'brevis.network', AXL: 'axelar.network', DOLO: 'dolomite.io',
  FLR: 'flare.network', KITE: 'gokite.ai', MYX: 'myx.finance', SIGN: 'sign.global', SOLV: 'solv.finance', SOON: 'soo.network',
  USDE: 'ethena.fi', ZAMA: 'zama.ai', DUSK: 'dusk.network', FOLKS: 'folks.finance', FF: 'falcon.finance', XION: 'xion.burnt.com',
  USDT0: 'usdt0.to', KHYPE: 'kinetiq.xyz', SEDA: 'seda.xyz', MUX: 'mux.network', RAIL: 'railgun.org', MONAD: 'monad.xyz',
};

/** The price oracle's venues the news set does not carry yet (VenuePicker.tsx VENUE_SITE). */
const VENUE_SITES = ['gate.com', 'mexc.com', 'kucoin.com', 'htx.com', 'deribit.com'];
/** Kept as the neutral badges in public/logos/news (never re-fetched). */
const BADGES = new Set(['federalreserve.gov', 'stlouisfed.org', 'kalshi.com', 'sec.gov', 'dol.gov']);

const args = new Set(process.argv.slice(2));
const doCoins = !args.has('--news');
const doNews = !args.has('--coins');
const fileSafe = (s) => s.replace(/[^a-z0-9._-]/gi, '_').toLowerCase();

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
const report = { coins: { site: [], cc0: [], letter: [] }, news: { fresh: [], kept: [], added: [], missing: [] } };

if (doCoins) {
  const byDomain = new Map();
  const manifest = {};
  for (const [key, sym] of Object.entries(CC0_COINS)) {
    const img = await imageAt(`${CC0}/${sym}.svg`);
    if (!img) { report.coins.letter.push(key); continue; }
    const rel = `sites/cc0-${sym}${img.ext}`;
    mkdirSync(join(STAGE, 'sites'), { recursive: true });
    writeFileSync(join(STAGE, rel), img.buf);
    manifest[key] = rel;
    report.coins.cc0.push(key);
  }
  for (const [key, domain] of Object.entries(COIN_SITES)) {
    if (!byDomain.has(domain)) {
      const img = await siteIcon(domain);
      let rel = null;
      if (img) {
        rel = `sites/${fileSafe(domain)}${img.ext}`;
        mkdirSync(join(STAGE, 'sites'), { recursive: true });
        writeFileSync(join(STAGE, rel), img.buf);
      }
      byDomain.set(domain, rel);
      console.log(`${domain}: ${img ? `${img.url} (${img.buf.length} B)` : 'no icon'}`);
    }
    const rel = byDomain.get(domain);
    if (rel) { manifest[key] = rel; report.coins.site.push(key); } else report.coins.letter.push(key);
  }
  // Replace the set in whole.
  rmSync(join(LOGOS, 'sites'), { recursive: true, force: true });
  if (existsSync(join(STAGE, 'sites'))) cpSync(join(STAGE, 'sites'), join(LOGOS, 'sites'), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(
    MANIFEST,
    `// Generated by tools/fetch-site-logos.mjs on ${new Date().toISOString().slice(0, 10)} - do not edit, re-run the tool.\n` +
      `// Each icon is its owner's own (taken from its own site) or CC0; paths are relative to public/logos/.\n\n` +
      `export const SITE_COIN_LOGOS: Record<string, string> = ${JSON.stringify(sorted, null, 1)};\n`,
  );
}

if (doNews) {
  const shipped = JSON.parse(readFileSync(NEWS_JSON, 'utf8'));
  const sites = [...new Set([...Object.keys(shipped), ...VENUE_SITES])].sort();
  const dir = join(LOGOS, 'news');
  const next = { ...shipped };
  mkdirSync(join(STAGE, 'news'), { recursive: true });
  for (const site of sites) {
    if (BADGES.has(site)) continue;
    const img = await siteIcon(site);
    if (!img) {
      (shipped[site] ? report.news.kept : report.news.missing).push(site);
      continue;
    }
    const ext = img.ext.slice(1);
    writeFileSync(join(STAGE, 'news', `${site}.${ext}`), img.buf);
    (shipped[site] ? report.news.fresh : report.news.added).push(site);
    next[site] = ext;
    console.log(`${site}: ${img.url} (${img.buf.length} B)`);
  }
  for (const f of readdirSync(join(STAGE, 'news'))) {
    const site = f.slice(0, f.lastIndexOf('.'));
    for (const old of readdirSync(dir)) if (old.slice(0, old.lastIndexOf('.')) === site) rmSync(join(dir, old));
    cpSync(join(STAGE, 'news', f), join(dir, f));
  }
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(NEWS_JSON, JSON.stringify(sorted) + '\n');
}

rmSync(STAGE, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 1));
console.log(`downloaded ${(downloaded() / 1e6).toFixed(2)} MB`);
