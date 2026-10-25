#!/usr/bin/env node
// Static audit of a built site (vite build output) against what production serves.
// No browser, no network: it reads files.
//
//   node deploy/smoke/audit-dist.mjs <dist dir> [--json] [--hosts]
//
// FAILS (exit 1) when the build cannot work under the production headers:
//   - index.html is missing, or references a file that is not in the build
//   - index.html has an inline <script> (script-src 'self' refuses it)
//   - the <meta> CSP differs from the CSP header production sends
//     (deploy/smoke/prod-headers.mjs = deploy/aws/edge.yaml); a browser enforces
//     BOTH, so a difference silently narrows the policy
//   - the SharedWorker script that holds the exchange sockets is not in the build
//   - /scan/index.html's inline script no longer matches the hash in the CSP
//   - a file has no extension, or one the publish script has no content type for
//   - leftovers of the old static pages (verify/, scan/*.js) or source maps
//
// REPORTS (never fails on):
//   - the size of the build and of what the first paint needs
//   - with --hosts: every absolute origin named in the JavaScript, marked by
//     whether connect-src allows it. Most are links, schemas and wallet-library
//     defaults that are never contacted; the browser smoke test is what proves
//     that nothing outside the policy is requested.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { CSP, SCAN_SCRIPT_HASH, sourceAllows } from './prod-headers.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const dist = resolve(args.find((a) => !a.startsWith('--')) ?? '');
if (!args.find((a) => !a.startsWith('--'))) {
  console.error('usage: node deploy/smoke/audit-dist.mjs <dist dir> [--json] [--hosts]');
  process.exit(2);
}

/** Extensions deploy/release/publish-web.sh has a content type for. Keep in step with its content_type(). */
export const KNOWN_EXTENSIONS = new Set([
  'html', 'js', 'mjs', 'css', 'json', 'map', 'txt', 'sha256', 'xml', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'ico',
  'woff2', 'woff', 'ttf', 'otf', 'wasm', 'onnx', 'webmanifest',
]);

const errors = [];
const warnings = [];
const info = {};
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const parseCsp = (text) => {
  const out = new Map();
  for (const part of text.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length) out.set(tokens[0].toLowerCase(), tokens.slice(1).sort());
  }
  return out;
};

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`audit-dist: ${dist} has no index.html - is it a vite build output?`);
  process.exit(1);
}

const files = walk(dist);
const rel = (p) => '/' + relative(dist, p).split(sep).join('/');
const byPath = new Map(files.map((p) => [rel(p), p]));
const bytes = (p) => statSync(p).size;
info.files = files.length;
info.bytes = files.reduce((n, p) => n + bytes(p), 0);

// --- index.html ----------------------------------------------------------------------
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const body = html.replace(/<!--[\s\S]*?-->/g, '');

const inline = [...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(([, attrs, code]) => !/\bsrc\s*=/.test(attrs) && code.trim() !== '');
if (inline.length) fail(`index.html has ${inline.length} inline <script> block(s): script-src 'self' refuses them`);
if (/\son[a-z]+\s*=\s*["']/i.test(body.replace(/<meta[\s\S]*?>/gi, ''))) fail('index.html has an inline event handler attribute: the CSP refuses it');

const refs = [...body.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
const local = refs.filter((r) => r.startsWith('/') && !r.startsWith('//'));
for (const r of local) {
  const path = r.split(/[?#]/)[0];
  if (!byPath.has(path)) fail(`index.html references ${path}, which is not in the build`);
}
const external = refs.filter((r) => /^https?:\/\//.test(r));
info.preconnect = external;
const entry = local.find((r) => /^\/assets\/.*\.js$/.test(r) && new RegExp(`<script[^>]*src="${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(body));
if (!entry) fail('index.html has no module entry script under /assets/');
if (!/<title>[^<]+<\/title>/.test(body)) warn('index.html has no <title>');
if (!/<meta\s+name="description"/i.test(body)) warn('index.html has no <meta name="description"> (search results and link previews show nothing)');
if (!/<link[^>]+rel="icon"/i.test(body)) warn('index.html has no favicon link');

// What the first paint downloads: the entry, the stylesheet and the modulepreloads.
const firstPaint = local.filter((r) => r.startsWith('/assets/'));
info.firstPaintBytes = firstPaint.reduce((n, r) => n + (byPath.has(r) ? bytes(byPath.get(r)) : 0), 0);
info.firstPaintFiles = firstPaint.length;

// --- the two policies a browser enforces together -------------------------------------
const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(body);
if (!meta) {
  warn('index.html has no <meta> CSP: only the header policy applies (fine in production, nothing in a file:// or misconfigured host)');
} else {
  const m = parseCsp(meta[1]);
  const h = parseCsp(CSP.site);
  // Only a header can carry these; everything else must be identical.
  for (const d of ['manifest-src', 'frame-ancestors', 'upgrade-insecure-requests']) h.delete(d);
  for (const d of new Set([...m.keys(), ...h.keys()])) {
    const a = (m.get(d) ?? ['<absent>']).join(' ');
    const b = (h.get(d) ?? ['<absent>']).join(' ');
    if (a !== b) {
      const onlyMeta = (m.get(d) ?? []).filter((x) => !(h.get(d) ?? []).includes(x));
      const onlyHeader = (h.get(d) ?? []).filter((x) => !(m.get(d) ?? []).includes(x));
      fail(`CSP ${d}: index.html and the production header differ (only in index.html: ${onlyMeta.join(' ') || '-'}; only in the header: ${onlyHeader.join(' ') || '-'}) - update deploy/aws/edge.yaml and deploy/smoke/prod-headers.mjs together with index.html`);
    }
  }
}

// --- the SharedWorker and the other workers ----------------------------------------------
const js = files.filter((p) => p.endsWith('.js'));
const workers = js.filter((p) => /[/\\]assets[/\\](?:[\w.-]*\.)?worker-[\w-]+\.js$/.test(p));
const shared = workers.filter((p) => /[/\\]worker-[\w-]+\.js$/.test(p));
info.workers = workers.map(rel);
if (shared.length !== 1) {
  fail(`expected exactly one SharedWorker script assets/worker-<hash>.js (apps/web/src/exchange/ws/worker.ts), found ${shared.length}`);
} else {
  const src = readFileSync(shared[0], 'utf8');
  info.sharedWorker = rel(shared[0]);
  // Self-contained: nothing to import, so the worker needs no script-src beyond its own file.
  info.sharedWorkerImports = /\bimport\s*(?:\(|[\w{*])/.test(src);
  if (!/onconnect/.test(src)) fail(`${rel(shared[0])} does not look like the socket host (no onconnect)`);
  for (const host of ['wss://mainnet-gw.sodex.dev', 'wss://testnet-gw.sodex.dev']) {
    if (!src.includes(host)) warn(`${rel(shared[0])} does not name ${host}: check its allow-list (exchange/ws/allowed.ts)`);
  }
}
const referencesWorker = js.some((p) => info.sharedWorker && readFileSync(p, 'utf8').includes(info.sharedWorker.slice(1)));
if (info.sharedWorker && !referencesWorker) fail(`no script references ${info.sharedWorker}: the SharedWorker would never start`);

// --- /scan/index.html, the redirect for old links -----------------------------------------
if (byPath.has('/scan/index.html')) {
  const scan = readFileSync(byPath.get('/scan/index.html'), 'utf8');
  const code = /<script>([\s\S]*?)<\/script>/.exec(scan)?.[1];
  if (code === undefined) {
    warn('/scan/index.html has no inline script any more: drop its hash from the CSP');
  } else {
    const hash = `'sha256-${createHash('sha256').update(code).digest('base64')}'`;
    if (hash !== SCAN_SCRIPT_HASH) fail(`/scan/index.html's inline script hashes to ${hash}, the CSP allows ${SCAN_SCRIPT_HASH}: saved /scan/?address= links would lose the address`);
  }
} else {
  warn('no /scan/index.html in the build: links to the old /scan/ page fall through to the app shell');
}

// --- what must not ship ----------------------------------------------------------------------
for (const p of files) {
  const r = rel(p);
  const ext = extname(p).slice(1).toLowerCase();
  if (!ext) fail(`${r} has no extension: the publish script cannot give it a content type`);
  else if (!KNOWN_EXTENSIONS.has(ext)) fail(`${r}: no content type is known for .${ext} (deploy/release/publish-web.sh content_type)`);
  if (ext === 'map') fail(`${r}: a source map is in the build`);
  if (r.startsWith('/verify/')) fail(`${r}: the old static verify page is in the build (a stale dist?)`);
  if (r.startsWith('/scan/') && r !== '/scan/index.html') fail(`${r}: an old static Scan file is in the build (a stale dist?)`);
  if (r.startsWith('/charting_library/')) warn(`${r}: TradingView's library is in the build - it needs its own CSP review`);
  if (/(^|\/)\.env|\.pem$|\.key$|keystore|\.token$/.test(r)) fail(`${r}: looks like a secret or a key file`);
}
if (!byPath.has('/robots.txt')) warn('no /robots.txt in the build (apps/web/public/robots.txt)');
if (!byPath.has('/favicon.svg') && !byPath.has('/favicon.ico')) warn('no favicon in the build');

// --- origins named in the JavaScript (information) ----------------------------------------------
if (flags.has('--hosts') || flags.has('--json')) {
  const connect = new Set(parseCsp(CSP.site).get('connect-src') ?? []);
  const seen = new Map();
  for (const p of js) {
    const src = readFileSync(p, 'utf8');
    for (const m of src.matchAll(/\b(https?|wss?):\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d+)?/gi)) {
      const origin = `${m[1].toLowerCase()}://${m[2].toLowerCase()}`;
      if (!/\./.test(m[2]) || /\.(?:js|ts|json|md|html|svg|png)$/i.test(m[2])) continue;
      const e = seen.get(origin) ?? { origin, allowed: sourceAllows(connect, origin), files: new Set() };
      e.files.add(rel(p));
      seen.set(origin, e);
    }
  }
  info.origins = [...seen.values()]
    .map((e) => ({ origin: e.origin, allowed: e.allowed, files: e.files.size }))
    .sort((a, b) => Number(b.allowed) - Number(a.allowed) || a.origin.localeCompare(b.origin));
}

const ok = errors.length === 0;
if (flags.has('--json')) {
  console.log(JSON.stringify({ ok, dist, errors, warnings, info }, null, 2));
} else {
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  console.log(`audit-dist: ${dist}`);
  console.log(`  ${info.files} files, ${mb(info.bytes)}; first paint ${info.firstPaintFiles} files, ${mb(info.firstPaintBytes)} uncompressed`);
  console.log(`  entry ${entry ?? '-'}; SharedWorker ${info.sharedWorker ?? '-'}${info.sharedWorkerImports ? ' (has imports)' : ' (self-contained)'}; workers ${info.workers.length}`);
  if (info.origins) {
    console.log('  origins named in the JavaScript (allowed by connect-src / not):');
    for (const o of info.origins) console.log(`    ${o.allowed ? 'allowed' : '   -   '}  ${o.origin}  (${o.files} file${o.files === 1 ? '' : 's'})`);
  }
  for (const w of warnings) console.log(`  warn  ${w}`);
  for (const e of errors) console.log(`  FAIL  ${e}`);
  console.log(ok ? '  ok: the build fits the production headers' : `  ${errors.length} problem(s)`);
}
process.exit(ok ? 0 : 1);
