/**
 * The address book's logos: exchanges, wallets, protocols and chains.
 *
 *   node tools/fetch-addrbook-logos.mjs
 *
 * Reads tools/addrbook-catalog.json (the curated list: ids, names, aliases,
 * address kinds, and where each logo can be downloaded), downloads every logo
 * ONCE into public/addrbook/ - the app serves them itself and never asks a
 * third party for an image at runtime - and writes
 * src/components/funds/addrbook/catalogData.ts, which the app reads.
 *
 * A logo that cannot be fetched from its source falls back to the site's
 * favicon (Google's favicon service, at build time only); one that still fails
 * is listed and left out - the app draws a letter avatar for it. The set is
 * replaced in whole, so a re-run never leaves stale files behind.
 *
 * Separate from fetch-logos.mjs on purpose: that tool replaces public/logos/
 * wholesale and must not wipe these.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shrinkPng } from './png-shrink.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(WEB, 'tools', 'addrbook-catalog.json');
const OUT = join(WEB, 'public', 'addrbook');
const STAGE = join(tmpdir(), 'valuedesk-addrbook-staging');
const DATA = join(WEB, 'src', 'components', 'funds', 'addrbook', 'catalogData.ts');
const UA = { 'User-Agent': 'Mozilla/5.0 (valuedesk logo sync)' };
const MAX_BYTES = 400_000;

const TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico', 'image/gif': '.gif' };
const KINDS = new Set(['evm', 'solana', 'bitcoin', 'litecoin', 'dogecoin', 'tron', 'xrp', 'stellar', 'ton', 'sui', 'cardano', 'other']);

const catalog = JSON.parse(readFileSync(SOURCE, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileSafe = (s) => s.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();

/** One image, or throws. Sniffs the bytes when the server's content-type is vague. */
async function fetchImage(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 64 || buf.length > MAX_BYTES) throw new Error(`${buf.length} bytes`);
    let ext = TYPES[(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()];
    if (!ext) {
      if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = '.png';
      else if (buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg';
      else if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') ext = '.webp';
      else if (/^\s*(<\?xml|<svg)/i.test(buf.subarray(0, 200).toString())) ext = '.svg';
    }
    if (!ext) throw new Error(`not an image (${res.headers.get('content-type')})`);
    if (ext === '.svg' && /<script|on[a-z]+=/i.test(buf.toString())) throw new Error('svg with script');
    return { buf: ext === '.png' ? shrinkPng(buf, url) : buf, ext };
  }
  throw new Error('rate limited');
}

async function save(entry, dir) {
  const urls = [entry.logo?.url, ...(entry.logo?.fallbacks ?? []), entry.domain && `https://www.google.com/s2/favicons?domain=${entry.domain}&sz=128`].filter(Boolean);
  const errors = [];
  for (const url of urls) {
    try {
      const { buf, ext } = await fetchImage(url);
      const rel = `${dir}/${fileSafe(entry.id)}${ext}`;
      mkdirSync(join(STAGE, dir), { recursive: true });
      writeFileSync(join(STAGE, rel), buf);
      return rel;
    } catch (e) {
      errors.push(`${url.slice(0, 80)}: ${e.message}`);
    }
  }
  throw new Error(errors.join(' | ') || 'no logo source');
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
console.log(`ok: ${Object.keys(platformLogos).length}/${catalog.platforms.length} platform logos, ${Object.keys(chainLogos).length}/${catalog.chains.length} chain logos`);
if (missing.length) console.log(`no logo (letter avatar instead):\n  ${missing.join('\n  ')}`);
