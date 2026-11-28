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
 *   ... --only=ADI,USDE,sec.gov                         just these coin keys / news sites; the rest is kept
 *
 * Why (licence review 2026-10-28):
 * TradingView's symbol logos (no commercial use without an agreement),
 * CoinGecko's and DefiLlama's images and the DuckDuckGo / Google favicon
 * services are no longer used. Instead:
 *
 *   coins  COIN_SITES: a stock's, fund's or project's own icon from its own site,
 *          shown small next to its own ticker - identification (nominative use
 *          of the owner's mark). A site that refuses the tool: the project's own
 *          GitHub organisation avatar (COIN_GITHUB, checked to be the org's
 *          logo). Trust Wallet's assets (MIT, TRUST_COINS). CC0: a few icons from spothq/cryptocurrency-icons (CC0 1.0, no
 *          rights reserved). A coin none of these has shows its venue's mark
 *          (CoinIcon), never a letter. Written to public/logos/sites/ +
 *          src/logoManifestSites.ts, which logos.ts reads after SoDEX's set and
 *          before the other venues'.
 *   news   every site in public/logos/news.json (the outlets the news names) and
 *          the price oracle's venues: their own icons, re-taken from the sites
 *          themselves; a site that cannot be read keeps the file it has. The
 *          Federal Reserve Board, the SEC and the DOL are US federal agencies
 *          (their works are public domain, 17 U.S.C. section 105); their own site
 *          icons only say which agency published a story, never that it endorses
 *          ValueDesk. The St. Louis Fed and Kalshi: their own site icons, as
 *          every other outlet (identification).
 *
 * Each file's source URL is recorded in tools/logo-sources.json (site-icon.mjs recordSources).
 *
 * Downloads are staged in the OS temp folder, checked (images only, SVGs
 * sanitised, PNGs shrunk to 128 px) and only then copied into public/.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloaded, githubAvatar, imageAt, recordSources, siteIcon } from './site-icon.mjs';
import { SITE_COIN_LOGOS } from '../src/logoManifestSites.ts';

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
 * whose token is listed under its own name). Memecoins and unclear tickers show
 * the icon of the venue's own set, else the venue's mark.
 */
export const COIN_SITES = {
  // US stocks
  ADI: 'analog.com', ARM: 'arm.com', AVGO: 'broadcom.com', AXTI: 'axt.com', BAC: 'bankofamerica.com', BE: 'bloomenergy.com',
  CCL: 'carnival.com', CIFR: 'ciphermining.com', EBAY: 'ebay.com', MCD: 'mcdonalds.com', NKE: 'nike.com', F: 'ford.com', IONQ: 'ionq.com', MELI: 'mercadolibre.com',
  MRNA: 'modernatx.com', NBIS: 'nebius.com', QCOM: 'qualcomm.com', SMCI: 'supermicro.com', SOFI: 'sofi.com', TTWO: 'take2games.com',
  LITE: 'lumentum.com',
  // The Wealth funds' holdings (QQQ, VOO, VGT, VYM, SMH, SCHD top holdings; owner 2026-11-28: logos for ALL)
  ABBV: 'abbvie.com', ACN: 'accenture.com', ALAB: 'asteralabs.com', AMGN: 'amgen.com', ANET: 'arista.com', APH: 'amphenol.com',
  'BRK.B': 'berkshirehathaway.com', CDNS: 'cadence.com', CRM: 'salesforce.com', CSCO: 'cisco.com', GILD: 'gilead.com',
  GS: 'goldmansachs.com', HD: 'homedepot.com', JNJ: 'jnj.com', JPM: 'jpmorganchase.com', KLAC: 'kla.com', KO: 'coca-colacompany.com',
  LIN: 'linde.com', MA: 'mastercard.com', MCHP: 'microchip.com', MPWR: 'monolithicpower.com', MRK: 'merck.com', MS: 'morganstanley.com',
  NXPI: 'nxp.com', ON: 'onsemi.com', PANW: 'paloaltonetworks.com', PG: 'pg.com', PM: 'pmi.com', RTX: 'rtx.com', SKHYV: 'skhynix.com',
  SNPS: 'synopsys.com', STM: 'st.com', TXN: 'ti.com', UNH: 'unitedhealthgroup.com', V: 'visa.com', WFC: 'wellsfargo.com',
  WMT: 'walmart.com', XOM: 'exxonmobil.com', QQQ: 'invesco.com',
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

/**
 * The project's own GitHub organisation avatar, for a coin whose site refuses
 * the tool (each org checked by hand to be the project's and its avatar to be
 * its logo, 2026-10-28). github.com/<org>.png redirects to avatars.githubusercontent.com.
 */
export const COIN_GITHUB = { ADI: 'analogdevicesinc', USDE: 'ethena-labs', FOLKS: 'Folks-Finance', RAIL: 'Railgun-Privacy' };

/**
 * Trust Wallet's assets repo (github.com/trustwallet/assets, MIT): the token's
 * logo file by chain and contract, one raw file each (never a clone). Only
 * where the venue's ticker is certainly that token - for coins whose own icon in
 * Hyperliquid's set is a traced photo too heavy to ship (fetch-venue-logos.mjs
 * MAX_ICON), or that no set has.
 */
const TRUST = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains';
export const TRUST_COINS = {
  AERO: 'base/assets/0x940181a94A35A4569E4529A3CDfB74e38FD98631', // Aerodrome
  NEIRO: 'ethereum/assets/0x812Ba41e071C7b7fA4EBcFB62dF5F45f6fA853Ee', // Neiro (Ethereum)
  PEOPLE: 'ethereum/assets/0x7A58c0Be72BE218B41C608b7Fe7C5bB630736C71', // ConstitutionDAO
  MOG: 'ethereum/assets/0xaaeE1A9723aaDB7afA2810263653A34bA2C21C7a', // Mog Coin
  PNUT: 'solana/assets/2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump', // Peanut the Squirrel
  GOAT: 'solana/assets/CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump', // Goatseus Maximus
};

/** News outlets / venues whose site refuses the tool: their own GitHub organisation (checked by hand, 2026-10-28). */
const NEWS_GITHUB = { 'kalshi.com': 'Kalshi' };

/** The price oracle's venues the news set does not carry yet (VenuePicker.tsx VENUE_SITE). */
const VENUE_SITES = ['gate.com', 'mexc.com', 'kucoin.com', 'htx.com', 'deribit.com'];

const args = new Set(process.argv.slice(2));
const onlyArg = process.argv.slice(2).find((a) => a.startsWith('--only='));
/** --only=KEY,site: just these; everything else keeps the file it has. */
const only = onlyArg ? new Set(onlyArg.slice(7).split(',').map((x) => x.trim()).filter(Boolean)) : null;
const wanted = (k) => !only || only.has(k);
const oldSources = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./logo-sources.json', import.meta.url), 'utf8'));
  } catch {
    return {};
  }
})();
const doCoins = !args.has('--news');
const doNews = !args.has('--coins');
const fileSafe = (s) => s.replace(/[^a-z0-9._-]/gi, '_').toLowerCase();

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
const report = { coins: { site: [], github: [], trustwallet: [], cc0: [], venueMark: [] }, news: { fresh: [], kept: [], added: [], missing: [] } };

if (doCoins) {
  const byDomain = new Map();
  const manifest = {};
  const sources = {};
  mkdirSync(join(STAGE, 'sites'), { recursive: true });
  // --only: every other key keeps its file and its recorded source.
  if (only) {
    for (const [key, rel] of Object.entries(SITE_COIN_LOGOS)) {
      if (only.has(key) || !existsSync(join(LOGOS, rel))) continue;
      cpSync(join(LOGOS, rel), join(STAGE, rel));
      manifest[key] = rel;
      sources[key] = oldSources.sites?.[key] ?? (CC0_COINS[key] ? `${CC0}/${CC0_COINS[key]}.svg (CC0 1.0)` : TRUST_COINS[key] ? `${TRUST}/${TRUST_COINS[key]}/logo.png (Trust Wallet assets, MIT)` : `https://${COIN_SITES[key]}/ (its own site icon)`);
    }
  }
  for (const [key, sym] of Object.entries(CC0_COINS)) {
    if (!wanted(key)) continue;
    const img = await imageAt(`${CC0}/${sym}.svg`);
    if (!img) { report.coins.venueMark.push(key); continue; }
    const rel = `sites/cc0-${sym}${img.ext}`;
    writeFileSync(join(STAGE, rel), img.buf);
    manifest[key] = rel;
    sources[key] = `${img.url} (CC0 1.0)`;
    report.coins.cc0.push(key);
  }
  for (const [key, path] of Object.entries(TRUST_COINS)) {
    if (!wanted(key)) continue;
    const img = await imageAt(`${TRUST}/${path}/logo.png`);
    if (!img) { report.coins.venueMark.push(key); continue; }
    const rel = `sites/tw-${fileSafe(key)}${img.ext}`;
    writeFileSync(join(STAGE, rel), img.buf);
    manifest[key] = rel;
    sources[key] = `${img.url} (Trust Wallet assets, MIT)`;
    report.coins.trustwallet.push(key);
  }
  for (const [key, domain] of Object.entries(COIN_SITES)) {
    if (!wanted(key)) continue;
    if (!byDomain.has(domain)) {
      const img = await siteIcon(domain);
      let hit = null;
      if (img) {
        hit = { rel: `sites/${fileSafe(domain)}${img.ext}`, url: img.url };
        writeFileSync(join(STAGE, hit.rel), img.buf);
      }
      byDomain.set(domain, hit);
      console.log(`${domain}: ${img ? `${img.url} (${img.buf.length} B)` : 'no icon'}`);
    }
    let hit = byDomain.get(domain);
    let via = 'site';
    if (!hit && COIN_GITHUB[key]) {
      // The site refuses the tool: the project's own GitHub organisation avatar.
      const org = COIN_GITHUB[key];
      const img = await githubAvatar(org);
      if (img) {
        hit = { rel: `sites/github-${fileSafe(org)}${img.ext}`, url: img.url };
        writeFileSync(join(STAGE, hit.rel), img.buf);
        via = 'github';
      }
      console.log(`github ${org}: ${img ? `${img.url} (${img.buf.length} B)` : 'no avatar'}`);
    }
    if (hit) { manifest[key] = hit.rel; sources[key] = hit.url; report.coins[via].push(key); } else report.coins.venueMark.push(key);
  }
  recordSources('sites', sources);
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
  const sources = Object.fromEntries(Object.keys(shipped).map((site) => [site, oldSources.news?.[site] ?? `https://${site}/ (its own site icon)`]));
  for (const site of sites) {
    if (!wanted(site)) continue;
    // A site that refuses the tool: its own GitHub organisation's avatar (NEWS_GITHUB).
    const img = (await siteIcon(site)) ?? (NEWS_GITHUB[site] ? await githubAvatar(NEWS_GITHUB[site]) : null);
    if (!img) {
      (shipped[site] ? report.news.kept : report.news.missing).push(site);
      continue;
    }
    const ext = img.ext.slice(1);
    writeFileSync(join(STAGE, 'news', `${site}.${ext}`), img.buf);
    (shipped[site] ? report.news.fresh : report.news.added).push(site);
    next[site] = ext;
    sources[site] = img.url;
    console.log(`${site}: ${img.url} (${img.buf.length} B)`);
  }
  for (const f of readdirSync(join(STAGE, 'news'))) {
    const site = f.slice(0, f.lastIndexOf('.'));
    for (const old of readdirSync(dir)) if (old.slice(0, old.lastIndexOf('.')) === site) rmSync(join(dir, old));
    cpSync(join(STAGE, 'news', f), join(dir, f));
  }
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(NEWS_JSON, JSON.stringify(sorted) + '\n');
  recordSources('news', sources);
}

rmSync(STAGE, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 1));
console.log(`downloaded ${(downloaded() / 1e6).toFixed(2)} MB`);
