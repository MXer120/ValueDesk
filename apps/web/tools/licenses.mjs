/**
 * The third-party licences that ship with the site.
 *
 * A Vite build plugin: after bundling it collects every npm package whose code,
 * styles or fonts are in the build (the module graph, not package.json - a
 * dependency that never reaches the browser is not listed), reads each one's
 * package.json and its LICENSE / NOTICE / COPYING files, and emits
 * `third-party-licenses.txt` next to index.html. MIT, BSD and ISC ask for the
 * copyright and permission notice to go with every copy, Apache-2.0 for the
 * licence and the NOTICE file, the fonts' SIL Open Font License for the licence
 * with the fonts: this file is that copy. The footer links it (LegalGate.tsx).
 *
 * The build fails on a licence outside ALLOWED (copyleft, source-available,
 * "see licence in", none at all): adding such a package needs a decision first
 * (docs/legal/TECH-AUDIT.md). Nothing about this machine is written - no paths,
 * only package names, versions and licence texts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** SPDX ids a package may carry and still ship (permissive, or font/data licences that allow bundling). */
export const ALLOWED = new Set([
  'MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'OFL-1.1', 'CC0-1.0', 'CC-BY-4.0', 'Unlicense', 'BlueOak-1.0.0', 'Zlib', 'Python-2.0',
]);

/**
 * Packages under a licence of their own, cleared by name after reading it. Reown's
 * AppKit and WalletConnect (Reown / WalletConnect Community License, 2025): the
 * notice "Portions © 2025 Reown, Inc." on the site (the footer's licences link
 * and this file), a copy of the licence (this file), and a paid licence once more
 * than 500 wallets connect in 30 days or 2.5 million RPC calls a month - an owner
 * decision (docs/legal/TECH-AUDIT.md).
 */
export const CLEARED = [
  { test: /^@(reown|walletconnect)\//, licence: 'SEE LICENSE IN LICENSE.md', as: 'Reown / WalletConnect Community License' },
];

const clearedAs = (name, licence) => CLEARED.find((c) => c.test.test(name) && c.licence === licence)?.as ?? null;

const LICENCE_FILE = /^(licen[cs]e|copying|notice|copyright)(\.|-|$)/i;

/** The npm package directory a module id belongs to, or null for our own code. */
export function packageDirOf(id) {
  const clean = id.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
  const at = clean.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const rest = clean.slice(at + '/node_modules/'.length).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  return { dir: `${clean.slice(0, at)}/node_modules/${name}`, name };
}

/** package.json's licence as an SPDX expression ("MIT", "(MIT OR Apache-2.0)"), or null. */
export function licenceOf(pkg) {
  const l = pkg.license ?? pkg.licence ?? pkg.licenses ?? pkg.licences;
  if (typeof l === 'string') return l.trim() || null;
  if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : x?.type)).filter(Boolean).join(' OR ') || null;
  if (l && typeof l === 'object' && typeof l.type === 'string') return l.type;
  return null;
}

/** Whether an SPDX expression lets us ship the package: every AND part allowed, at least one OR branch. */
export function licenceAllowed(expr) {
  if (!expr) return false;
  const e = expr.replace(/[()]/g, ' ').trim();
  return e.split(/\s+OR\s+/i).some((branch) => branch.split(/\s+AND\s+/i).every((id) => ALLOWED.has(id.trim())));
}

export function readPackage(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const files = readdirSync(dir)
    .filter((f) => LICENCE_FILE.test(f))
    .sort()
    .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim() }));
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const declared = licenceOf(pkg);
  return {
    name: pkg.name,
    version: pkg.version,
    licence: clearedAs(pkg.name, declared) ?? declared,
    cleared: !!clearedAs(pkg.name, declared),
    source: (repo || pkg.homepage || `https://www.npmjs.com/package/${pkg.name}`).replace(/^git\+/, '').replace(/\.git$/, ''),
    files,
  };
}

/** The file's text for a list of packages (sorted by name). */
export function renderLicences(pkgs, product = "ValueDesk's web app") {
  const head = [
    `Third-party software in ${product}`,
    '',
    `${product[0].toUpperCase()}${product.slice(1)} contains the packages below. Each is used under its own licence,`,
    'reproduced here with the copyright and notice files the package ships. Generated at build time',
    'from what is actually in the build.',
    '',
    // The notice the Reown / WalletConnect Community License asks for, word for word.
    ...(pkgs.some((p) => p.cleared && /^@(reown|walletconnect)\//.test(p.name)) ? ['Portions © 2025 Reown, Inc. All Rights Reserved', ''] : []),
    'Summary:',
    ...pkgs.map((p) => `  ${p.name}@${p.version} - ${p.licence ?? 'unknown'}`),
    '',
  ];
  const body = pkgs.map((p) => {
    const texts = p.files.length
      ? p.files.map((f) => `--- ${f.name} ---\n${f.text}`).join('\n\n')
      : `(The package ships no licence file. Its package.json declares: ${p.licence ?? 'nothing'}.)`;
    return [`${'='.repeat(78)}`, `${p.name}@${p.version}`, `Licence: ${p.licence ?? 'unknown'}`, `Source: ${p.source}`, '', texts, ''].join('\n');
  });
  return `${head.join('\n')}\n${body.join('\n')}`;
}

/** The plugin. `fileName` is where the text lands in the build. */
export function thirdPartyLicences({ fileName = 'third-party-licenses.txt' } = {}) {
  return {
    name: 'valuescan:third-party-licences',
    apply: 'build',
    generateBundle() {
      const dirs = new Map();
      for (const id of this.getModuleIds()) {
        const hit = packageDirOf(id);
        if (!hit) continue;
        // A nested package.json without a name (an "exports" shim) belongs to the package above it.
        let dir = hit.dir;
        while (existsSync(join(dir, 'package.json')) && !JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name) dir = dirname(dir);
        if (existsSync(join(dir, 'package.json'))) dirs.set(dir, hit.name);
      }
      const byKey = new Map();
      for (const dir of dirs.keys()) {
        const p = readPackage(dir);
        byKey.set(`${p.name}@${p.version}`, p);
      }
      const pkgs = [...byKey.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1));
      const refused = pkgs.filter((p) => !p.cleared && !licenceAllowed(p.licence));
      if (refused.length) {
        this.error(
          `licence not cleared for shipping: ${refused.map((p) => `${p.name}@${p.version} (${p.licence ?? 'none'})`).join(', ')}. ` +
            'Decide first (docs/legal/TECH-AUDIT.md), then add the SPDX id to ALLOWED in apps/web/tools/licenses.mjs.',
        );
      }
      this.emitFile({ type: 'asset', fileName, source: renderLicences(pkgs) });
    },
  };
}
