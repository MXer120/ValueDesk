#!/usr/bin/env node
// Does a range of commits change what Vercel would build? For ignore-build.sh (Vercel's Ignored
// Build Step), before anything is installed: node builtins and git only.
//
//   node deploy/vercel/web-changed.mjs <from> <to>
//   exit 1: the site's build input changed (build), 0: it did not (skip), 2: cannot tell (build)
//
// WHY. Every push of main built the whole site (2-2.5 min on a 2-core machine, 118 MB of output kept
// as a deployment) although half of them changed only the servers: 16 of the 32 production builds of
// 2026-11-05..11-08 had no web file in their range (indexer, API, executor, docs). The site Vercel
// would have produced was byte for byte the one already live. Skipping those halves the billed build
// CPU minutes and the deployment storage that grows with every kept deployment.
//
// WHAT COUNTS AS THE SITE'S INPUT, deliberately wider than ship.sh's `web` part (parts.mjs), so a
// build is never skipped where ship.sh waits for one:
//   - parts.mjs says `web` (its import graph from apps/web/src/main.tsx, and the lockfile / package.json
//     rules for the web's dependencies);
//   - every file the site's two pages reach at run time (main.tsx AND admin/main.tsx, the admin suite
//     on dev.valuedesk.so, which parts.mjs does not start from), through the @sign alias into
//     apps/server/src;
//   - anything under apps/web/ (except e2e/), packages/ (shared code: imported by both sides),
//     deploy/vercel/ (the function, routes, this step), deploy/smoke/ (the headers table the routes
//     are made from), the build scripts (deploy/release/build-web.sh, lib.sh), vercel.json and the
//     root package files.
// Anything else - apps/server outside what the pages import, apps/executor, docs, deploy/server,
// deploy/contabo, deploy/aws, marketing, research - does not reach the build.
import { pathToFileURL } from 'node:url';
import { partsOf, reach, treeOf } from '../release/parts.mjs';

/** Folders and files that feed the build whatever the import graph says. */
export const ALWAYS = [
  /^apps\/web\/(?!e2e\/)/,
  /^packages\//,
  /^deploy\/vercel\/(?!README\.md$)/,
  /^deploy\/smoke\//,
  /^deploy\/release\/(build-web|lib)\.sh$/,
  /^vercel\.json$/,
  /^package(-lock)?\.json$/,
  /^\.(npmrc|nvmrc|node-version)$/,
];

/** The pages Vite builds (apps/web/index.html, apps/web/admin.html). */
export const PAGES = ['apps/web/src/main.tsx', 'apps/web/src/admin/main.tsx'];

/**
 * Every file the pages reach at run time: parts.mjs's own reading of imports (relative paths, the
 * @sign / @sodex-core / @copy-engine aliases, import('...'), new URL('...', import.meta.url)), from
 * both pages. Type-only imports ship no code and are left out, as ship.sh leaves them out: through
 * them the pages would "reach" the indexer's store and every indexer commit would rebuild the site.
 * Whether a server change still type-checks with the web is ship.sh's gate (every typecheck in CI
 * before main moves), not this build's; the bundle cannot change through a type.
 */
export function pageGraph(files, read) {
  return reach(PAGES, files, read);
}

/** The changed files that feed the build (empty: the build would be the same). */
export function webInputs(changed, graph, partsWeb = []) {
  const out = new Set(partsWeb);
  for (const f of changed) if (ALWAYS.some((re) => re.test(f)) || graph.has(f)) out.add(f);
  return [...out];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    console.error('usage: node deploy/vercel/web-changed.mjs <from> <to>');
    process.exit(2);
  }
  try {
    const parts = partsOf(from, to);
    const { files, read } = treeOf(to);
    const { execFileSync } = await import('node:child_process');
    const changed = execFileSync('git', ['diff', '--name-only', '-z', from, to], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
    const hits = webInputs(changed, pageGraph(files, read), parts.parts.web);
    if (hits.length) {
      console.log(`the site's input changed (${hits.length} of ${changed.length} files): ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', ...' : ''}`);
      process.exit(1);
    }
    console.log(`no file of the site changed in ${from.slice(0, 8)}..${to.slice(0, 8)} (${changed.length} files: servers, docs, tooling)`);
    process.exit(0);
  } catch (e) {
    console.error(`cannot tell (${String(e?.message ?? e).split('\n')[0]}): building`);
    process.exit(2);
  }
}
