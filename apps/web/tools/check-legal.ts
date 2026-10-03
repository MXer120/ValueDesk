/**
 * Refuses a public build while the legal pages still hold a placeholder.
 *
 *   npx tsx tools/check-legal.ts                 the texts in src/legal
 *   npx tsx tools/check-legal.ts --dist <dir>    and, after `vite build`, every .js / .html in <dir>
 *
 * Run from apps/web. Exit code 0: no placeholder left. 1: placeholders left
 * (each one is printed). 2: not understood. The check itself is
 * `assertLegalPagesComplete` in src/legal/docs.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { assertLegalPagesComplete } from '../src/legal/docs';

const args = process.argv.slice(2);
let dist: string | null = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dist' && args[i + 1]) dist = args[++i]!;
  else {
    console.error('usage: npx tsx tools/check-legal.ts [--dist <dir>]');
    process.exit(2);
  }
}

let failed = false;
try {
  assertLegalPagesComplete();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  failed = true;
}

if (dist) {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|html)$/.test(name)) files.push(p);
    }
  };
  try {
    walk(dist);
  } catch (e) {
    console.error(`cannot read ${dist}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const hits = files.filter((f) => /\[\[\s*OWNER\b/i.test(readFileSync(f, 'utf8')));
  if (hits.length) {
    console.error(`A legal placeholder is in the build: ${hits.map((f) => relative(dist!, f)).join(', ')}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('legal pages: no placeholder left');
