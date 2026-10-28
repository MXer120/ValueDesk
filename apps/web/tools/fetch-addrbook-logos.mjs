/**
 * The address book's logos: exchanges, wallets, protocols and chains.
 *
 *   node tools/fetch-addrbook-logos.mjs              every logo, the set replaced in whole
 *   node tools/fetch-addrbook-logos.mjs --missing    only the entries without a file; the rest is kept
 *
 * Reads tools/addrbook-catalog.json (the curated list: ids, names, aliases,
 * address kinds, and each platform's or chain's own site), downloads every logo
 * ONCE into public/addrbook/ - the app serves them itself and never asks a
 * third party for an image at runtime - and writes
 * src/components/funds/addrbook/catalogData.ts, which the app reads.
 *
 * Where each logo comes from (licence review 2026-10-28): the platform's own
 * site - a logo file on it (logo.source "site", logo.url), else its declared /
 * conventional icon (logo.source "site-icon", site-icon.mjs). A site that
 * refuses the tool: its own GitHub organisation's avatar (logo.github, checked
 * by hand to be the platform's org and its logo; GitHub's generated default
 * identicon is refused), else Trust Wallet's assets repo (logo.trustwallet, a
 * path under github.com/trustwallet/assets, MIT; one raw file, never a clone).
 * CoinGecko's and DefiLlama's images and Google's favicon service are no longer
 * used. A chain SoDEX routes to has no file here: the app shows SoDEX's own
 * chain icon. One that cannot be fetched is listed and left out - the app then
 * draws an identicon of it, never a letter. The set is replaced in whole
 * (unless --missing), so a re-run never leaves stale files behind. Each file's
 * source is recorded in tools/logo-sources.json.
 *
 * Separate from fetch-logos.mjs on purpose: that tool replaces public/logos/
 * wholesale and must not wipe these.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloaded, githubAvatar, imageAt, recordSources, siteIcon } from './site-icon.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(WEB, 'tools', 'addrbook-catalog.json');
const OUT = join(WEB, 'public', 'addrbook');
const STAGE = join(tmpdir(), 'valuedesk-addrbook-staging');
const DATA = join(WEB, 'src', 'components', 'funds', 'addrbook', 'catalogData.ts');
const KINDS = new Set(['evm', 'solana', 'bitcoin', 'litecoin', 'dogecoin', 'tron', 'xrp', 'stellar', 'ton', 'sui', 'cardano', 'other']);

const catalog = JSON.parse(readFileSync(SOURCE, 'utf8'));
const onlyMissing = process.argv.includes('--missing');
const TRUST = 'https://raw.githubusercontent.com/trustwallet/assets/master';
const sources = {};
const oldSources = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./logo-sources.json', import.meta.url), 'utf8')).addrbook ?? {};
  } catch {
    return {};
  }
})();
/** The file this entry has in public/addrbook now, or null. */
function shipped(entry, dir) {
  try {
    const f = readdirSync(join(OUT, dir)).find((x) => x.slice(0, x.lastIndexOf('.')) === fileSafe(entry.id));
    return f ? `${dir}/${f}` : null;
  } catch {
    return null;
  }
}
const fileSafe = (s) => s.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();

/** A site that refuses the tool may still be in the news set (public/logos/news, the same site's own icon). */
function newsIcon(domain) {
  const dir = join(WEB, 'public', 'logos', 'news');
  const f = readdirSync(dir).find((x) => x.slice(0, x.lastIndexOf('.')) === domain.replace(/^www\./, ''));
  return f ? { buf: readFileSync(join(dir, f)), ext: f.slice(f.lastIndexOf('.')), url: `news/${f}` } : null;
}

async function save(entry, dir) {
  if (!entry.logo) throw new Error('no logo source');
  const key = `${dir}/${entry.id}`;
  if (onlyMissing) {
    const have = shipped(entry, dir);
    if (have) {
      mkdirSync(join(STAGE, dir), { recursive: true });
      cpSync(join(OUT, have), join(STAGE, have));
      sources[key] = oldSources[key] ?? (entry.logo.url ?? (entry.domain ? `https://${entry.domain}/ (its own site icon)` : 'kept'));
      return have;
    }
  }
  // A logo file on the platform's own site, else the site's own icon, else its GitHub org's avatar, else Trust Wallet's file.
  let img = (entry.logo.source === 'site' && entry.logo.url ? await imageAt(entry.logo.url) : null) ?? (entry.domain ? (await siteIcon(entry.domain)) ?? newsIcon(entry.domain) : null);
  let from = img?.url;
  if (!img && entry.logo.github) {
    img = await githubAvatar(entry.logo.github);
    from = img?.url;
  }
  if (!img && entry.logo.trustwallet) {
    img = await imageAt(`${TRUST}/${entry.logo.trustwallet}`);
    from = img && `${TRUST}/${entry.logo.trustwallet} (Trust Wallet assets, MIT)`;
  }
  if (!img) throw new Error(`${entry.logo.url ?? entry.domain ?? '-'}: no icon`);
  const rel = `${dir}/${fileSafe(entry.id)}${img.ext}`;
  mkdirSync(join(STAGE, dir), { recursive: true });
  writeFileSync(join(STAGE, rel), img.buf);
  sources[key] = from;
  console.log(`${key}: ${from} (${img.buf.length} B)`);
  return rel;
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
const platformLogos = {};
const chainLogos = {};
const missing = [];
const ids = new Set();
for (const [list, dir, into] of [[catalog.platforms, 'p', platformLogos], [catalog.chains, 'c', chainLogos]]) {
  for (const e of list) {
    if (!e.id || ids.has(`${dir}:${e.id}`)) throw new Error(`duplicate or empty id: ${dir}:${e.id}`);
    ids.add(`${dir}:${e.id}`);
    if (!e.logo) continue;
    try {
      into[e.id] = await save(e, dir);
    } catch (err) {
      missing.push(`${dir}/${e.id}: ${err.message}`);
    }
  }
}
for (const c of catalog.chains) if (!KINDS.has(c.addressKind)) throw new Error(`chain ${c.id}: unknown addressKind ${c.addressKind}`);

rmSync(OUT, { recursive: true, force: true });
cpSync(STAGE, OUT, { recursive: true });
recordSources('addrbook', sources);
rmSync(STAGE, { recursive: true, force: true });

const aliases = (a) => [...new Set((a ?? []).map((s) => String(s).toLowerCase().trim()).filter(Boolean))];
const data = {
  platforms: catalog.platforms.map((p) => ({ id: p.id, name: p.name, kind: p.kind, aliases: aliases(p.aliases) })),
  chains: catalog.chains.map((c) => ({ id: c.id, name: c.name, sodexKey: c.sodexKey ?? null, aliases: aliases(c.aliases), addressKind: c.addressKind })),
};
writeFileSync(
  DATA,
  `// Generated by tools/fetch-addrbook-logos.mjs from tools/addrbook-catalog.json on ${new Date().toISOString().slice(0, 10)} - do not edit, re-run the tool.\n` +
    `// Logo paths are relative to public/addrbook/: they ship with the app and load from our own origin.\n` +
    `import type { Catalog } from './detect';\n\n` +
    `export const CATALOG: Catalog = ${JSON.stringify(data, null, 1)};\n\n` +
    `export const PLATFORM_LOGOS: Record<string, string> = ${JSON.stringify(platformLogos, null, 1)};\n\n` +
    `export const CHAIN_LOGOS: Record<string, string> = ${JSON.stringify(chainLogos, null, 1)};\n`,
);
console.log(`downloaded ${(downloaded() / 1e6).toFixed(2)} MB`);
console.log(`ok: ${Object.keys(platformLogos).length}/${catalog.platforms.length} platform logos, ${Object.keys(chainLogos).length}/${catalog.chains.length} chain logos`);
if (missing.length) console.log(`no logo (the app draws an identicon instead):\n  ${missing.join('\n  ')}`);
