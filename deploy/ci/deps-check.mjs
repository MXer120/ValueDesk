#!/usr/bin/env node
// Are the installed packages (node_modules, npm's own record of it) the ones package-lock.json names? The test gate asks
// (deploy/release/test-gate.sh): a worktree borrows the main checkout's node_modules, and nothing runs npm ci before the
// tests. Optional packages (another platform's) may be missing; a wrong version never passes.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The lockfile's packages that are missing or of another version: "name wanted installed". */
export function differing(lock, installed) {
  const out = [];
  for (const [k, p] of Object.entries(lock.packages ?? {})) {
    if (!k.includes('node_modules/') || p.link || !p.version) continue;
    const have = installed.packages?.[k];
    if (!have ? !(p.optional || p.devOptional || p.peer) : have.version !== p.version) out.push(`${k} ${p.version} ${have?.version ?? 'missing'}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read = (f) => JSON.parse(readFileSync(join(root, f), 'utf8'));
  const d = differing(read('package-lock.json'), read('node_modules/.package-lock.json'));
  for (const l of d.slice(0, 20)) console.log(`deps-check: ${l}`);
  console.log(d.length ? `deps-check: ${d.length} packages differ from package-lock.json` : "deps-check: the installed packages are the lockfile's");
  process.exitCode = d.length ? 1 : 0;
}
