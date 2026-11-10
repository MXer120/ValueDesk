// The self-host bundle: one file, Node 22+, no install step.
//
//   node tools/bundle.mjs [--out=<dir>]     -> <dir>/valuedesk-copier.mjs (+ .sha256)
//
// Default <dir>: apps/web/public/copier, so the site serves it at
// /copier/valuedesk-copier.mjs next to its checksum (the Copy setup links both).
//
// The file is handed to users, so it carries the licences of what it bundles:
// ours (MIT, ../LICENSE) and every npm package esbuild put in, with the
// copyright and notice files each ships (MIT and the others ask for that in
// every copy), appended as comments at the end. A package whose licence is not
// cleared stops the build (apps/web/tools/licenses.mjs, the same rule as the site).
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { licenceAllowed, packageDirOf, readPackage, renderLicences } from '../../web/tools/licenses.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outArg = process.argv.find((a) => a.startsWith('--out='));
// Not on the site any more (owner 2026-11-10: no self-hosted copier, only the browser and the executor): dist/ by default.
const outDir = outArg ? resolve(outArg.slice(6)) : resolve(root, 'dist/copier');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, 'valuedesk-copier.mjs');

const result = await build({
  entryPoints: [join(root, 'src/main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // The licences go in whole at the end (below), not as scattered fragments.
  legalComments: 'none',
  // Module paths as written, not resolved through a linked node_modules: the
  // file's path comments then never name the folder it was built in.
  preserveSymlinks: true,
  metafile: true,
  minify: false,
  sourcemap: false,
  banner: {
    js: [
      `// ValueDesk copier ${pkg.version} - the self-hosted copy executor. MIT licence.`,
      '// Run: node valuedesk-copier.mjs   (Node.js 22 or newer). Settings: see README (EXECUTOR_* variables).',
      '// It talks to SoDEX and Hyperliquid directly and to nothing else; your copy key stays in ./copier-data.',
      "import { createRequire as __vdRequire } from 'node:module'; const require = __vdRequire(import.meta.url);",
    ].join('\n'),
  },
});

const dirs = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const hit = packageDirOf(resolve(process.cwd(), input));
  if (hit && existsSync(join(hit.dir, 'package.json'))) dirs.add(hit.dir);
}
const pkgs = [...new Map([...dirs].map((d) => readPackage(d)).map((p) => [`${p.name}@${p.version}`, p])).values()].sort((a, b) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1,
);
const refused = pkgs.filter((p) => !p.cleared && !licenceAllowed(p.licence));
if (refused.length) throw new Error(`licence not cleared for shipping: ${refused.map((p) => `${p.name}@${p.version} (${p.licence ?? 'none'})`).join(', ')}`);
const notices = [
  `ValueDesk copier ${pkg.version}`,
  '',
  readFileSync(join(root, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim(),
  '',
  renderLicences(pkgs, 'the ValueDesk copier'),
].join('\n');
appendFileSync(outfile, `\n// ${'-'.repeat(76)}\n// LICENCES\n${notices.split('\n').map((l) => (l ? `// ${l}` : '//')).join('\n')}\n`);

const sha = createHash('sha256').update(readFileSync(outfile)).digest('hex');
writeFileSync(`${outfile}.sha256`, `${sha}  valuedesk-copier.mjs\n`);
process.stdout.write(`${outfile}\nsha256 ${sha}\n`);
