#!/usr/bin/env node
// Turn a production web build into a Vercel deployment directory (Build Output API v3):
// the site with the production headers, the SPA fallback, and /api/* through the proxy
// function to the instance.
//
//   node deploy/vercel/package.mjs --dist=<built site> --origin=https://<origin name> --out=<dir>
//
// It writes <out>/.vercel/output/ (and replaces only that: a <out>/.vercel/project.json
// from `vercel link` stays). Then, from <out>:
//   npx vercel@latest deploy --prebuilt --prod
// deploy/release/publish-vercel.sh does both for a tag.
//
// WHAT GOES IN
//   static/                      the build as it is (apps/web/dist)
//   functions/api/__vs_proxy.func/   deploy/vercel/api-proxy.cjs, Node.js, region hnd1 (Tokyo),
//                                VALUESCAN_ORIGIN_URL fixed here; the secret is a Vercel
//                                environment variable (production only), never in here
//   config.json                  the routes:
//     0. a visitor from a sanctioned country or region (apps/web/src/legal/jurisdictions.mjs,
//        by Vercel's x-vercel-ip-country / x-vercel-ip-country-region): 451 Unavailable For
//        Legal Reasons for every path - /restricted.html, or /restricted.json under /api/ -
//        except the legal pages, the files they need and /api/edge/geo (geoRoutes below)
//     1. /api/*      -> the function (nothing else applies to it: the API and the copy executor
//                       send their own headers)
//     2. the headers of every other path - deploy/smoke/prod-headers.mjs, the same table
//        deploy/aws/edge.yaml is validated against: the security headers, the CSP of the
//        path's class (site, /scan/*, /logos/* + /addrbook/*) and Cache-Control
//     3. /scan/      -> /scan/index.html (the redirect page for old links)
//     4. the files of the build
//     5. a path whose last segment has no dot -> /index.html (the app's routes)
//   deploy/vercel/vercel.test.mjs checks, path by path, that these routes give what
//   prod-headers.mjs says - so edge.yaml, the smoke test and Vercel cannot drift apart.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CSP, HEADERS, headersFor } from '../smoke/prod-headers.mjs';
import { LEGAL_PATHS, edgeBlockList } from '../../apps/web/src/legal/jurisdictions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The function's path; package.mjs routes /api/* to it. */
export const FUNCTION_PATH = '/api/__vs_proxy';
/** Tokyo: next to the instance in ap-northeast-1 (it was fra1 next to eu-central-1 until 2026-10-23). */
export const FUNCTION_REGION = 'hnd1';
export const NODE_RUNTIME = 'nodejs22.x';

/** Extensions the build may contain (the same list deploy/release/publish-web.sh types by hand). */
export const KNOWN_EXTENSIONS = new Set(['html', 'js', 'mjs', 'css', 'json', 'map', 'txt', 'sha256', 'xml', 'svg', 'png', 'jpg', 'jpeg',
  'webp', 'avif', 'gif', 'ico', 'woff2', 'woff', 'ttf', 'otf', 'wasm', 'webmanifest']);

// Path classes. Each route below matches one class only, so no header is ever set twice
// for one path (Vercel's order of precedence between two matching routes then never matters).
const NOT_SPECIAL = '(?!api/|logos/|addrbook/|scan/)';
const DIRS = '(?:[^/]*/)*';
const NO_DOT_LAST = `${DIRS}[^/.]*$`; // the last segment has no dot: an app route (the shell)
const DOT_LAST = `${DIRS}[^/]*\\.[^/]*$`;
const HTML_LAST = `${DIRS}[^/]*\\.html$`;
const NOT_HTML = '(?!.*\\.html$)';

/** [src, a path of that class] - the headers of the class are headersFor(that path). */
export const HEADER_CLASSES = [
  [`^/${NOT_SPECIAL}${NO_DOT_LAST}`, '/trade'],
  [`^/assets/${DOT_LAST}`, '/assets/index-0.js'],
  [`^/(?!api/|logos/|addrbook/|scan/|assets/)${HTML_LAST}`, '/index.html'],
  [`^${NOT_HTML}/(?!api/|logos/|addrbook/|scan/|assets/)${DOT_LAST}`, '/favicon.svg'],
  [`^/(?:logos|addrbook)/${NO_DOT_LAST}`, '/logos/x'],
  [`^/(?:logos|addrbook)/${HTML_LAST}`, '/logos/x.html'],
  [`^${NOT_HTML}/(?:logos|addrbook)/${DOT_LAST}`, '/logos/x.svg'],
  [`^/scan/${NO_DOT_LAST}`, '/scan/'],
  [`^/scan/${HTML_LAST}`, '/scan/index.html'],
  [`^${NOT_HTML}/scan/${DOT_LAST}`, '/scan/x.js'],
];

// --- the sanctioned places (jurisdictions.mjs) ----------------------------------------------------

/** What a visitor from a blocked place still gets: the legal pages and what they load. */
export const GEO_OPEN = `(?:assets/|restricted\\.(?:html|json)$|favicon\\.(?:svg|ico)$|robots\\.txt$|third-party-licenses\\.txt$|(?:${LEGAL_PATHS.join('|')})/?$)`;
/** The answer's headers: the site's, never cached anywhere (the same path is the app elsewhere). */
export const GEO_PAGE_HEADERS = { ...HEADERS, 'Content-Security-Policy': CSP.site, 'Cache-Control': 'no-store' };
export const GEO_API_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

/**
 * The 451 routes, first of all: each matches one class of path (an /api/ path or a
 * site path) for one condition (a country, or a region of a country), and ends the
 * routing with its own headers - no other route adds any to it.
 */
export function geoRoutes(block = edgeBlockList()) {
  const conditions = [];
  if (block.countries.length) conditions.push([{ type: 'header', key: 'x-vercel-ip-country', value: { inc: [...block.countries] } }]);
  const byCountry = new Map();
  for (const r of block.regions) byCountry.set(r.country, [...(byCountry.get(r.country) ?? []), r.region]);
  for (const [country, regions] of byCountry) {
    conditions.push([
      { type: 'header', key: 'x-vercel-ip-country', value: { eq: country } },
      { type: 'header', key: 'x-vercel-ip-country-region', value: { inc: regions } },
    ]);
  }
  return conditions.flatMap((has) => [
    { src: '^/api/(?!edge/geo$).*$', has, dest: '/restricted.json', status: 451, headers: GEO_API_HEADERS, caseSensitive: true },
    { src: `^/(?!api/)(?!${GEO_OPEN}).*$`, has, dest: '/restricted.html', status: 451, headers: GEO_PAGE_HEADERS, caseSensitive: true },
  ]);
}

/** The routes of config.json. */
export function routes() {
  return [
    // A sanctioned place: 451, whatever was asked for (apart from the legal pages).
    ...geoRoutes(),
    // The index API: only the function, which forwards the API's own headers.
    { src: '^/api/.*$', dest: FUNCTION_PATH, caseSensitive: true },
    ...HEADER_CLASSES.map(([src, sample]) => ({ src, headers: headersFor(sample), continue: true, caseSensitive: true })),
    // public/scan/index.html forwards links saved from the old Scan page.
    { src: '^/scan/$', dest: '/scan/index.html', caseSensitive: true },
    // /scan without the slash is the app's route. Vercel's filesystem step would serve
    // the directory's index.html for it - the old redirect page, under the site policy
    // that blocks its script, whose meta refresh to /scan then reloads it forever.
    { src: '^/scan$', dest: '/index.html', caseSensitive: true },
    { handle: 'filesystem' },
    // An app route: the shell. A missing file with an extension stays a 404.
    { src: `^/${NO_DOT_LAST}`, dest: '/index.html', caseSensitive: true },
  ];
}

export function config() {
  return { version: 3, routes: routes() };
}

/** The function's .vc-config.json. */
export function functionConfig(originUrl) {
  return {
    runtime: NODE_RUNTIME,
    handler: 'index.js',
    launcherType: 'Nodejs',
    shouldAddHelpers: false,
    supportsResponseStreaming: true,
    regions: [FUNCTION_REGION],
    maxDuration: 35,
    // The function refuses the same places as the routes (a second check: api-proxy.cjs).
    environment: { VALUESCAN_ORIGIN_URL: originUrl, VALUESCAN_GEO_BLOCK: JSON.stringify(edgeBlockList()) },
  };
}

function files(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

/** Problems with a build directory: what the deployment would serve wrongly, or not at all. */
export function checkDist(dist) {
  const problems = [];
  if (!existsSync(join(dist, 'index.html'))) problems.push('no index.html');
  if (!existsSync(join(dist, 'assets'))) problems.push('no assets/');
  for (const f of existsSync(dist) ? files(dist) : []) {
    const rel = relative(dist, f).split(sep).join('/');
    const ext = extname(f).slice(1).toLowerCase();
    if (!ext) problems.push(`${rel}: a file without an extension (would be answered as an app route's shell or untyped)`);
    else if (!KNOWN_EXTENSIONS.has(ext)) problems.push(`${rel}: .${ext} is not a known type - add it to KNOWN_EXTENSIONS after checking how Vercel types it`);
    if (rel.startsWith('api/')) problems.push(`${rel}: a file under /api/ would never be served (the function owns /api/*)`);
  }
  return problems;
}

export function originUrlOk(origin) {
  return /^https:\/\/([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(origin);
}

/** Write <out>/.vercel/output. Returns a short summary. */
export function packageSite({ dist, origin, out }) {
  const problems = checkDist(dist);
  if (problems.length) throw new Error(`the build cannot be deployed as it is:\n  ${problems.join('\n  ')}`);
  if (!originUrlOk(origin)) throw new Error(`--origin must be https://<a DNS name>, nothing after it (got ${origin})`);
  const output = join(out, '.vercel', 'output');
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  cpSync(dist, join(output, 'static'), { recursive: true });
  const fn = join(output, 'functions', `${FUNCTION_PATH.slice(1)}.func`);
  mkdirSync(fn, { recursive: true });
  writeFileSync(join(fn, 'index.js'), readFileSync(join(HERE, 'api-proxy.cjs')));
  writeFileSync(join(fn, 'package.json'), `${JSON.stringify({ type: 'commonjs' })}\n`);
  writeFileSync(join(fn, '.vc-config.json'), `${JSON.stringify(functionConfig(origin), null, 2)}\n`);
  writeFileSync(join(output, 'config.json'), `${JSON.stringify(config(), null, 2)}\n`);
  const all = files(join(output, 'static'));
  const bytes = all.reduce((n, f) => n + statSync(f).size, 0);
  return { output, files: all.length, bytes, routes: routes().length };
}

// Run directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = /^--([\w-]+)=(.*)$/.exec(a);
    if (!m) { console.error(`unknown argument: ${a}`); process.exit(2); }
    return [m[1], m[2]];
  }));
  if (!flags.dist || !flags.origin || !flags.out) {
    console.error('usage: node deploy/vercel/package.mjs --dist=<built site> --origin=https://<origin name> --out=<dir>');
    process.exit(2);
  }
  try {
    const r = packageSite({ dist: resolve(flags.dist), origin: flags.origin, out: resolve(flags.out) });
    console.log(`wrote ${r.output}: ${r.files} files (${(r.bytes / 1048576).toFixed(1)} MB), ${r.routes} routes, the /api function in ${FUNCTION_REGION} -> ${flags.origin}`);
  } catch (e) {
    console.error(`package: ${e.message}`);
    process.exit(1);
  }
}
