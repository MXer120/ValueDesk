// The self-host bundle: one file, Node 22+, no install step.
//
//   node tools/bundle.mjs [--out=<dir>]     -> <dir>/valuedesk-copier.mjs (+ .sha256)
//
// Default <dir>: apps/web/public/copier, so the site serves it at
// /copier/valuedesk-copier.mjs next to its checksum (the Copy setup links both).
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outArg = process.argv.find((a) => a.startsWith('--out='));
const outDir = outArg ? resolve(outArg.slice(6)) : resolve(root, '../web/public/copier');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, 'valuedesk-copier.mjs');

await build({
  entryPoints: [join(root, 'src/main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
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

const sha = createHash('sha256').update(readFileSync(outfile)).digest('hex');
writeFileSync(`${outfile}.sha256`, `${sha}  valuedesk-copier.mjs\n`);
process.stdout.write(`${outfile}\nsha256 ${sha}\n`);
