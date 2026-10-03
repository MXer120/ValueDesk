#!/usr/bin/env node
// LOCAL PRODUCTION SMOKE TEST.
//
// Builds the web for production, serves it with exactly the production response
// headers and CSP (deploy/smoke/prod-headers.mjs = deploy/aws/edge.yaml), puts a
// hosted-mode index API behind /api with the origin secret - the way CloudFront
// does - and walks every page in headless Chrome. See deploy/smoke/README.md.
//
//   node deploy/smoke/smoke.mjs --snapshot           build, hosted API on a snapshot of the index, walk
//   node deploy/smoke/smoke.mjs --dist=<dir> ...     use an existing build
//   node deploy/smoke/smoke.mjs --api=none --offline nothing leaves this machine: headers, CSP, worker, routes
//   node deploy/smoke/smoke.mjs --site=https://valuescan.example [--origin=origin.valuescan.example]
//                                                    AFTER A DEPLOY: walk the real site (no build, no local server),
//                                                    compare the headers the edge sends with edge.yaml, ask the gate
//                                                    through the edge, and check that the origin is closed to you
//
// --api=        spawn (default)  the real server in hosted mode, VALUESCAN_INDEXER=0, on --index-db
//               none             no API: /api answers 503 (a stopped instance)
//               mock             a stand-in that only tests this harness - never a product result
//               http://host:port an already running hosted server; secret in SMOKE_ORIGIN_SECRET
// --index-db=   the index file the spawned server reads. REFUSED when it is the live
//               index and the server's reader is not read-only (see "the reader" below).
// --snapshot    first take a read-only snapshot of the live index (VACUUM INTO) and read that
// --no-index    spawn the server with no index file at all (every index route says "not available")
// --server-egress=deny|allow   deny (default): the spawned server cannot reach any
//               exchange (net-guard.mjs) and spends none of this machine's budgets.
//               allow: the real thing - only on a machine that runs no other Valuescan server.
// --offline     the browser cannot resolve any host but loopback (no exchange traffic at all)
// --site=URL    walk a deployed site instead of a local build. The browser talks to the real
//               exchanges, as a visitor's does; --api, --dist and the index options do not apply.
// --origin=HOST with --site: the instance's own DNS name. Checked to be CLOSED from this
//               machine (443 and the API port), and never to serve the API on port 80.
// --edge=cloudfront|vercel   with --origin: the edge in front of it (default cloudfront).
//               vercel: 443 answers (the function has no fixed addresses), but nothing
//               may be served there without the origin secret (the Caddy gate).
// --pages=RE    only the page ids matching this regular expression
// --wallets=venue=0x..,venue=0x..   the Scan wallet per venue (default: the SoDEX market maker for all)
// --settle=MS   how long each page is watched after it loaded (default 7000)
// --port / --api-port / --cdp-port   default 4280 / 8890 / 4289
// --out=DIR     reports, screenshots, the build (default deploy/.out/smoke)
// --keep        do not stop anything at the end (to look around by hand)
//
// THE READER. Since 2026-10-02 the API opens the index READ-ONLY
// (apps/server/src/indexer/reader.ts: `new IndexStore(path, { readOnly: true })`; before,
// it opened it read-write and could apply the schema and migrate). The check is made
// from the source on every run (readerIsReadOnly): should an open without
// `readOnly: true` come back, a spawned server is never pointed at the live index -
// it reads a snapshot (--snapshot), a copy you name (--index-db) or nothing
// (--no-index). Even read-only, --snapshot stays the gentle choice next to a running
// indexer: a reader still maps the -shm file, and its long reads hold the WAL back.
//
// Exit code: 0 when every assessed check passed, 1 when one failed, 2 when the run
// was refused or could not start. The summary says how much of production the run covered.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, launchChrome, openPage, pressCtrlK, sleep, typeText, watchSharedWorkers } from './cdp.mjs';
import { checkDeployedHeaders, checkHttpsRedirect, probeOrigin } from './deployed.mjs';
import { hostedRoutes, matchRoute, startMockApi } from './mock-api.mjs';
import { CSP } from './prod-headers.mjs';
import { startStaticServer } from './static-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

// --- arguments ---------------------------------------------------------------------

const flags = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
  if (!m) { console.error(`unknown argument: ${a}`); process.exit(2); }
  flags[m[1]] = m[2] ?? true;
}
if (flags.help || flags.h) {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  console.log(lines.slice(1, lines.findIndex((l) => l.startsWith('import '))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
const refuse = (msg) => { console.error(`smoke: ${msg}`); process.exit(2); };
const PORT = Number(flags.port ?? 4280);
const API_PORT = Number(flags['api-port'] ?? 8890);
const CDP_PORT = Number(flags['cdp-port'] ?? 4289);
const OUT = resolve(String(flags.out ?? join(REPO, 'deploy', '.out', 'smoke')));
const SETTLE_MS = Number(flags.settle ?? 7000);
const OFFLINE = flags.offline === true;
// --site: a DEPLOYED site is walked as it is - nothing is built or started here but the browser.
if (flags.site === true) refuse('--site needs the origin of the deployed site: --site=https://valuescan.example');
const REMOTE = typeof flags.site === 'string';
if (REMOTE && !/^https?:\/\/[^/?#\s]+\/?$/.test(flags.site)) refuse('--site must be an origin: https://host[:port], no path');
if (REMOTE) {
  for (const f of ['dist', 'api', 'index-db', 'snapshot', 'no-index', 'server-egress', 'port', 'api-port']) {
    if (flags[f] !== undefined) refuse(`--${f} does not apply with --site: a deployed site is walked as it is`);
  }
}
if (flags.origin !== undefined && (!REMOTE || flags.origin === true || !/^[A-Za-z0-9.-]+$/.test(String(flags.origin)))) {
  refuse('--origin=<host name of the instance> goes with --site (a name or an address, no scheme, no port)');
}
const EDGE = String(flags.edge ?? 'cloudfront');
if (!['cloudfront', 'vercel'].includes(EDGE)) refuse('--edge is cloudfront or vercel');
const API_MODE = REMOTE ? 'deployed' : flags.api === undefined || flags.api === true ? 'spawn' : String(flags.api);
const EGRESS = String(flags['server-egress'] ?? 'deny');
const SITE = REMOTE ? String(flags.site).replace(/\/+$/, '') : `http://127.0.0.1:${PORT}`;
const SITE_HOST = new URL(SITE).hostname;
const MM_WALLET = '0x48d98beb9dfce0a24f284e7653f05609b058ad96'; // a SoDEX market maker: public, always active
const SCAN_VENUES = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];

if (!['deny', 'allow'].includes(EGRESS)) refuse('--server-egress must be deny or allow');
/** Console errors count only when the page can reach everything it needs: a real API with its upstreams, and the network. */
const JUDGE_CONSOLE = !OFFLINE && (REMOTE || /^https?:\/\//.test(API_MODE) || (API_MODE === 'spawn' && EGRESS === 'allow' && !flags['no-index']));
if (new Set([PORT, API_PORT, CDP_PORT]).size !== 3) refuse('--port, --api-port and --cdp-port must differ');
// The ranges reserved for this script on a machine that also runs the dev servers
// (5180/8797) and other tools. --any-port lifts the check.
if (!flags['any-port']) {
  if (PORT < 4280 || PORT > 4289 || CDP_PORT < 4280 || CDP_PORT > 4289) refuse('--port and --cdp-port must be in 4280-4289 (or pass --any-port)');
  if (API_PORT < 8890 || API_PORT > 8899) refuse('--api-port must be in 8890-8899 (or pass --any-port)');
}

const log = (...a) => console.log('[smoke]', ...a);

// --- what gets stopped at the end ---------------------------------------------------

const cleanups = [];
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch (e) { console.error('[smoke] cleanup:', e?.message ?? e); }
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => cleanup().then(() => process.exit(130)));

const portFree = (port) => new Promise((ok) => {
  const s = net.createServer();
  s.once('error', () => ok(false));
  s.listen(port, '127.0.0.1', () => s.close(() => ok(true)));
});

// --- 1. the build ----------------------------------------------------------------------

function loadWebEnv() {
  const file = join(REPO, 'deploy', 'release', 'web.env');
  if (!existsSync(file)) return { env: {}, note: 'no deploy/release/web.env: Vite reads apps/web/.env.local as in development' };
  const env = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(VITE_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    // As the shell reads it in build-web.sh: an inline comment is not part of the value, nor are quotes around it.
    const value = m[2].replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
    if (!/__/.test(value)) env[m[1]] = value;
  }
  return { env, note: `VITE_* from deploy/release/web.env (${Object.keys(env).length} set)` };
}

function build() {
  if (flags.dist) {
    const dist = resolve(String(flags.dist));
    if (!existsSync(join(dist, 'index.html'))) refuse(`--dist ${dist} has no index.html`);
    log(`using the build at ${dist}`);
    return dist;
  }
  const dist = join(OUT, 'dist');
  const { env, note } = loadWebEnv();
  log(`building apps/web for production -> ${dist} (${note})`);
  // Its own output directory: apps/web/dist and the dev server are left alone.
  // Vite is the web workspace's own (npm may or may not hoist it to the root).
  let vite;
  try {
    vite = join(dirname(createRequire(join(REPO, 'apps', 'web', 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');
  } catch {
    refuse('vite is not installed: run "npm ci" in the repository first');
  }
  const r = spawnSync(process.execPath, [vite, 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: join(REPO, 'apps', 'web'), env: { ...process.env, ...env }, encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr);
    refuse('the production build failed (above)');
  }
  return dist;
}

function audit(dist) {
  const r = spawnSync(process.execPath, [join(HERE, 'audit-dist.mjs'), dist, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try {
    const j = JSON.parse(r.stdout);
    delete j.info.origins;
    return j;
  } catch {
    return { ok: false, errors: [`audit-dist did not run: ${(r.stderr || r.stdout).slice(0, 300)}`], warnings: [], info: {} };
  }
}

// --- 2. the API -------------------------------------------------------------------------

/** Where the server keeps its index when nothing says otherwise (apps/server/src/indexer/store.ts). */
function liveIndexPath() {
  if (process.env.VALUESCAN_INDEX_DB?.trim()) return resolve(process.env.VALUESCAN_INDEX_DB.trim());
  if (process.env.VALUETRADE_DEVICE_KEY?.trim()) return join(dirname(resolve(process.env.VALUETRADE_DEVICE_KEY.trim())), 'valuescan-index.db');
  const base = platform() === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Valuescan')
    : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'valuescan');
  return join(base, 'valuescan-index.db');
}

const sameFile = (a, b) => {
  try {
    const x = statSync(a);
    const y = statSync(b);
    return resolve(a).toLowerCase() === resolve(b).toLowerCase() || (x.ino !== 0 && x.ino === y.ino && x.dev === y.dev);
  } catch {
    return resolve(a).toLowerCase() === resolve(b).toLowerCase();
  }
};

/**
 * Does the API open the index read-only? Read from the source, not assumed: every
 * `new IndexStore(...)` on the API's read path (reader.ts holds the connection,
 * read.ts uses it) must pass `readOnly: true`, and there must be at least one.
 */
function readerIsReadOnly() {
  const opens = [];
  for (const f of ['reader.ts', 'read.ts']) {
    const path = join(REPO, 'apps', 'server', 'src', 'indexer', f);
    if (!existsSync(path)) continue;
    opens.push(...[...readFileSync(path, 'utf8').matchAll(/new IndexStore\(([^)]*)\)/g)].map((m) => m[1]));
  }
  return opens.length > 0 && opens.every((a) => /readOnly:\s*true/.test(a));
}

async function startApi(report) {
  if (API_MODE === 'none') {
    report.api = { mode: 'none', note: 'no API: every /api request answers 503, as with a stopped instance' };
    return null;
  }
  if (/^https?:\/\//.test(API_MODE)) {
    const secret = process.env.SMOKE_ORIGIN_SECRET ?? '';
    if (secret.length < 32) refuse('--api=<url> needs the origin secret in SMOKE_ORIGIN_SECRET');
    report.api = { mode: 'remote', target: API_MODE };
    return { target: API_MODE.replace(/\/+$/, ''), secret };
  }
  if (!(await portFree(API_PORT))) refuse(`port ${API_PORT} is in use`);
  const secret = randomBytes(32).toString('hex');
  if (API_MODE === 'mock') {
    const mock = await startMockApi({ port: API_PORT, secret });
    cleanups.push(() => mock.close());
    report.api = { mode: 'mock', note: 'a stand-in that tests this harness; NOT the hosted server' };
    return { target: mock.url, secret };
  }
  if (API_MODE !== 'spawn') refuse(`unknown --api=${API_MODE}`);

  // Which index file, and is it safe to hand to a process that opens it read-write?
  const live = liveIndexPath();
  const readOnly = readerIsReadOnly();
  let indexDb;
  if (flags['no-index']) {
    indexDb = join(OUT, 'state', 'no-index.db'); // never created: the reader checks existsSync first
    if (existsSync(indexDb)) rmSync(indexDb);
  } else if (flags.snapshot) {
    if (!existsSync(live)) refuse(`--snapshot: the live index ${live} does not exist`);
    indexDb = join(OUT, 'index-snapshot.db');
    for (const f of [indexDb, `${indexDb}-wal`, `${indexDb}-shm`]) if (existsSync(f)) rmSync(f);
    log(`snapshot of ${live} (${Math.round(statSync(live).size / 1048576)} MiB, read-only, VACUUM INTO) ...`);
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(REPO, 'deploy', 'server', 'bin', 'backup-index.mjs'), live, indexDb], { encoding: 'utf8' });
    if (r.status !== 0) refuse(`the snapshot failed: ${r.stderr.trim()}`);
    cleanups.push(() => { for (const f of [indexDb, `${indexDb}-wal`, `${indexDb}-shm`]) if (existsSync(f)) rmSync(f, { force: true }); });
  } else if (flags['index-db']) {
    indexDb = resolve(String(flags['index-db']));
    if (!existsSync(indexDb)) refuse(`--index-db ${indexDb} does not exist`);
  } else {
    refuse('--api=spawn needs one of --snapshot, --index-db=<copy> or --no-index (see "THE READER" in --help)');
  }
  if (!flags['no-index'] && sameFile(indexDb, live) && !readOnly) {
    refuse(
      `refusing to start a server on the live index ${live}:\n` +
      '  apps/server/src/indexer/reader.ts (or read.ts) opens it with `new IndexStore(...)` WITHOUT\n' +
      '  `readOnly: true` - read-write. On open that applies the schema, adds columns, writes\n' +
      '  meta.schema and may run a data migration (apps/server/src/indexer/store.ts, the\n' +
      '  constructor). Use --snapshot or a copy.',
    );
  }

  const state = join(OUT, 'state');
  mkdirSync(state, { recursive: true });
  const guardLog = join(OUT, 'server-egress-refused.txt');
  if (existsSync(guardLog)) rmSync(guardLog);
  const env = { ...process.env };
  // Nothing of the developer's environment or of %LOCALAPPDATA%\Valuescan is used.
  for (const k of Object.keys(env)) if (/^(VALUESCAN_|VALUETRADE_|SODEX_|VALUECHAIN_)/.test(k)) delete env[k];
  Object.assign(env, {
    VALUESCAN_HOSTED: '1',
    VALUESCAN_INDEXER: '0',
    HOST: '127.0.0.1',
    PORT: String(API_PORT),
    VALUESCAN_ORIGIN_SECRET: secret,
    VALUESCAN_TRUST_PROXY: '1', // one hop in front: this script's static server, as CloudFront would be
    VALUESCAN_ALLOWED_ORIGINS: SITE,
    VALUESCAN_INDEX_DB: indexDb,
    VALUETRADE_DEVICE_KEY: join(state, 'device.key'),
    VALUETRADE_LASTGOOD_DB: join(state, 'last-good.db'),
    VALUETRADE_STATS_DB: join(state, 'stats-cache.db'),
    VALUETRADE_KEYSTORE: join(state, 'none.keystore.json'),
    LOG_LEVEL: 'info',
    SMOKE_NET_GUARD_LOG: guardLog,
  });
  const nodeArgs = ['--disable-warning=ExperimentalWarning'];
  if (EGRESS === 'deny') nodeArgs.push('--import', new URL('./net-guard.mjs', import.meta.url).href);
  nodeArgs.push('--import', 'tsx', 'src/index.ts');
  const logFile = join(OUT, 'api.log');
  const out = createWriteStream(logFile);
  log(`starting the hosted API on :${API_PORT} (VALUESCAN_INDEXER=0, egress ${EGRESS}, index ${flags['no-index'] ? 'none' : indexDb})`);
  const child = spawn(process.execPath, nodeArgs, { cwd: join(REPO, 'apps', 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  let exited = null;
  child.once('exit', (code) => { exited = code ?? -1; });
  cleanups.push(async () => {
    if (exited === null) child.kill();
    for (let i = 0; i < 50 && exited === null; i++) await sleep(100);
    if (exited === null) child.kill('SIGKILL');
  });
  let up = false;
  for (let i = 0; i < 300 && exited === null; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${API_PORT}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) { up = true; break; }
    } catch { /* not listening yet */ }
    await sleep(200);
  }
  if (!up) {
    await cleanup();
    console.error(existsSync(logFile) ? readFileSync(logFile, 'utf8').slice(-3000) : '');
    refuse(`the hosted API did not come up (exit ${exited}); its log is above and in ${logFile}`);
  }
  report.api = {
    mode: 'spawn', hosted: true, indexer: 'off', egress: EGRESS,
    index: flags['no-index'] ? 'none' : flags.snapshot ? `snapshot of ${live}` : indexDb,
    readerOpensReadOnly: readOnly, log: logFile, guardLog,
  };
  return { target: `http://127.0.0.1:${API_PORT}`, secret, direct: true };
}

/**
 * The gate itself, asked without a browser: the checks a curl would make.
 * `api.secret` set: asked directly at the origin, as CloudFront asks it.
 * `api.secret` null: asked through the deployed edge, which adds the secret itself.
 */
async function probeGate(api, report) {
  const probes = [];
  const viaEdge = api.secret === null;
  const ask = async (label, path, { secret = true, method = 'GET', expect }) => {
    try {
      const r = await fetch(api.target + path, { method, headers: secret && !viaEdge ? { 'x-origin-verify': api.secret } : {}, signal: AbortSignal.timeout(20_000) });
      await r.arrayBuffer().catch(() => {});
      const ok = expect.includes(r.status);
      probes.push({
        label, path, method, status: r.status, expect, ok,
        cacheControl: r.headers.get('cache-control'), csp: r.headers.get('content-security-policy'), hsts: r.headers.get('strict-transport-security'),
      });
    } catch (e) {
      probes.push({ label, path, method, status: null, expect, ok: false, error: String(e?.cause?.code ?? e?.message ?? e) });
    }
  };
  await ask('health needs no secret', '/api/health', { secret: false, expect: [200] });
  // Through the edge every request carries the secret, so "without it" can only be asked at the origin (--origin covers that side).
  if (!viaEdge) await ask('an index route without the secret is refused', '/api/vs/leaderboard?venue=hyperliquid&window=1d&limit=1', { secret: false, expect: [403] });
  await ask(viaEdge ? 'an index route answers through the edge (the edge and the origin share the secret)' : 'an index route with the secret answers',
    '/api/vs/leaderboard?venue=hyperliquid&window=1d&limit=1', { expect: [200] });
  await ask('a per-user route is not served (market data)', '/api/md/perps/symbols', { expect: [404] });
  await ask('a per-user route is not served (account)', `/api/acct/perps/state?address=${MM_WALLET}`, { expect: [404] });
  await ask('a per-user route is not served (trader profile)', `/api/vs/trader?venue=sodex&address=${MM_WALLET}`, { expect: [404] });
  await ask('diagnostics are not served', '/api/vs/index/status', { expect: [404] });
  await ask('custodial routes are gone', '/api/session', { expect: [410, 404] });
  // CloudFront itself refuses a method the /api/* behaviour does not allow (403); the server would say 410.
  await ask('a write is refused', '/api/trade/perps/orders', { method: 'POST', expect: [410, 404, 403, 405] });
  await ask('a repeated query parameter is refused', '/api/vs/leaderboard?venue=sodex&venue=hyperliquid', { expect: [400] });
  if (viaEdge && SITE.startsWith('https:')) {
    const health = probes[0];
    if (health.ok && !health.hsts) probes.push({ label: 'API responses carry HSTS', path: '/api/health', method: 'GET', status: health.status, expect: ['strict-transport-security'], ok: false });
  }
  report.gate = probes;
  return probes.every((p) => p.ok);
}

// --- 3. the walk ---------------------------------------------------------------------------

function pages(wallets) {
  const scan = SCAN_VENUES.filter((v) => wallets[v]).map((v) => ({
    id: `scan-${v}`,
    path: v === 'sodex' ? `/scan?address=${wallets[v]}` : `/scan?address=${wallets[v]}&venue=${v}`,
    expectPath: '/scan',
  }));
  return [
    { id: 'trade', path: '/trade', expectPath: '/trade', expectSockets: true },
    { id: 'explore', path: '/explore', expectPath: '/explore' },
    { id: 'cohorts', path: '/explore?view=cohorts', expectPath: '/explore' },
    { id: 'marketmap', path: '/explore?view=cohorts&section=map', expectPath: '/explore' },
    { id: 'asset', path: '/explore?view=cohorts&section=map&focus=coin:BTC', expectPath: '/explore' },
    { id: 'leaderboard', path: '/leaderboard', expectPath: '/leaderboard' },
    { id: 'copy', path: '/copy', expectPath: '/copy' },
    { id: 'portfolio', path: '/portfolio', expectPath: '/portfolio' },
    // The legal pages (apps/web/src/legal): reachable from every page, so they must render under the production policy too.
    { id: 'impressum', path: '/impressum', expectPath: '/impressum' },
    { id: 'privacy', path: '/privacy', expectPath: '/privacy' },
    { id: 'terms', path: '/terms', expectPath: '/terms' },
    ...scan,
    { id: 'palette', path: '/trade', expectPath: '/trade', palette: true },
    { id: 'legacy-scan', path: `/scan/?address=${wallets.sodex}`, expectPath: '/scan' },
  ];
}

const CSP_HOOK = `(() => {
  const g = globalThis;
  if (g.__smokeCsp) return;
  g.__smokeCsp = [];
  g.addEventListener('securitypolicyviolation', (e) => g.__smokeCsp.push({
    directive: e.violatedDirective, effective: e.effectiveDirective, blocked: e.blockedURI,
    source: e.sourceFile, line: e.lineNumber, sample: e.sample, disposition: e.disposition,
  }));
})();`;

const connectSrc = new Set(CSP.site.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src')).split(/\s+/).slice(1));
const originOf = (url) => { try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return url; } };

/** Console lines that are known and harmless (the task's list), by where they come from. */
function harmless(entry) {
  const url = entry.url ?? '';
  const text = entry.text ?? '';
  // Lighter and Arcus answer 400/403 for an address they do not know.
  if (/^https:\/\/(mainnet\.zklighter\.elliot\.ai|api\.arcus\.xyz)\//.test(url) && /\b(400|403|404)\b/.test(text)) return 'venue: unknown address';
  return null;
}

async function walk(dist, api, report) {
  const routes = hostedRoutes();
  const wallets = Object.fromEntries(SCAN_VENUES.map((v) => [v, MM_WALLET]));
  for (const pair of String(flags.wallets ?? '').split(',').filter(Boolean)) {
    const [v, a] = pair.split('=');
    if (!SCAN_VENUES.includes(v) || !/^0x[0-9a-fA-F]{40}$/.test(a ?? '')) refuse(`--wallets: ${pair} is not venue=0x<40 hex>`);
    wallets[v] = a.toLowerCase();
  }
  let list = pages(wallets);
  if (typeof flags.pages === 'string') list = list.filter((p) => new RegExp(flags.pages).test(p.id));

  if (!(await portFree(CDP_PORT))) refuse(`port ${CDP_PORT} is in use`);
  let server = null;
  if (REMOTE) {
    log(`walking the deployed site ${SITE}`);
  } else {
    if (!(await portFree(PORT))) refuse(`port ${PORT} is in use`);
    server = await startStaticServer({ dist, port: PORT, api: api ? { target: api.target, secret: api.secret } : null });
    cleanups.push(() => server.close());
    log(`serving the build with the production headers on ${server.url}`);
  }
  /** Is there an index API behind /api that is expected to answer? */
  const apiThere = REMOTE || !!api;

  const chrome = await launchChrome({ port: CDP_PORT, offline: OFFLINE });
  cleanups.push(() => chrome.close());
  report.browser = { version: chrome.version, offline: OFFLINE };
  log(`${chrome.version}${OFFLINE ? ' (offline: no host but loopback resolves)' : ''}`);

  // Everything seen, tagged with the page being visited.
  let current = null;
  const seen = { requests: new Map(), sockets: [], console: [], exceptions: [], issues: [], workers: [] };
  const attach = async (session, where) => {
    const key = (id) => `${session.sessionId}:${id}`;
    session.on('Network.requestWillBeSent', (p) => {
      if (!/^https?:/.test(p.request.url)) return;
      seen.requests.set(key(p.requestId), { page: current, where, url: p.request.url, method: p.request.method, type: p.type, status: null, failed: null, blocked: null });
    });
    session.on('Network.responseReceived', (p) => {
      const r = seen.requests.get(key(p.requestId));
      if (r) { r.status = p.response.status; r.mime = p.response.mimeType; }
    });
    session.on('Network.loadingFailed', (p) => {
      const r = seen.requests.get(key(p.requestId));
      if (r) { r.failed = p.canceled ? 'canceled' : p.errorText; r.blocked = p.blockedReason ?? null; }
    });
    session.on('Network.webSocketCreated', (p) => seen.sockets.push({ page: current, where, url: p.url, id: key(p.requestId), opened: false }));
    session.on('Network.webSocketHandshakeResponseReceived', (p) => {
      const s = seen.sockets.find((x) => x.id === key(p.requestId));
      if (s) s.opened = p.response?.status === 101;
    });
    session.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error' && p.type !== 'assert') return;
      const text = p.args.map((a) => a.value ?? a.description ?? a.unserializableValue ?? '').join(' ').slice(0, 500);
      seen.console.push({ page: current, where, kind: 'console.error', text, url: p.stackTrace?.callFrames?.[0]?.url ?? '' });
    });
    session.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails;
      seen.exceptions.push({ page: current, where, text: `${d.text} ${d.exception?.description ?? ''}`.slice(0, 500), url: d.url ?? '' });
    });
    session.on('Log.entryAdded', (p) => {
      if (p.entry.level !== 'error') return;
      seen.console.push({ page: current, where, kind: `log:${p.entry.source}`, text: String(p.entry.text).slice(0, 500), url: p.entry.url ?? '' });
    });
    session.on('Audits.issueAdded', (p) => {
      if (p.issue.code !== 'ContentSecurityPolicyIssue') return;
      const d = p.issue.details.contentSecurityPolicyIssueDetails;
      seen.issues.push({ page: current, where, directive: d.violatedDirective, blocked: d.blockedURL ?? null, type: d.contentSecurityPolicyViolationType, reportOnly: d.isReportOnly });
    });
    await session.send('Network.enable', {});
    await session.send('Runtime.enable', {});
    await session.send('Log.enable', {}).catch(() => {});
    await session.send('Audits.enable', {}).catch(() => {});
  };

  const stopWatching = await watchSharedWorkers(chrome.cdp, async (session) => {
    const w = { page: current, url: session.url, session, alive: true };
    seen.workers.push(w);
    await attach(session, 'worker');
    await session.send('Runtime.evaluate', { expression: CSP_HOOK }).catch(() => {});
    chrome.cdp.on('Target.detachedFromTarget', (p) => { if (p.sessionId === session.sessionId) w.alive = false; });
  });
  cleanups.push(stopWatching);

  const page = await openPage(chrome.cdp);
  await page.send('Page.enable', {});
  await attach(page, 'page');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: CSP_HOOK });
  const shots = join(OUT, 'screenshots');
  mkdirSync(shots, { recursive: true });

  const results = [];
  for (const p of list) {
    current = p.id;
    const started = Date.now();
    const loaded = new Promise((res) => {
      const off = page.on('Page.loadEventFired', () => { off(); res(true); });
      setTimeout(() => { off(); res(false); }, 30_000);
    });
    await page.send('Page.navigate', { url: SITE + p.path });
    const didLoad = await loaded;
    await sleep(SETTLE_MS);

    let paletteOpen = null;
    if (p.palette) {
      await pressCtrlK(page);
      await sleep(1200);
      paletteOpen = await evaluate(page, `!!document.querySelector('[role="dialog"][aria-label="Search traders and markets"]')`).catch(() => false);
      if (paletteOpen) {
        await typeText(page, 'btc');
        await sleep(2500);
      }
    }
    const dom = await evaluate(page, `({
      path: location.pathname, search: location.search, title: document.title,
      app: !!document.querySelector('#root .app'), nodes: document.querySelectorAll('#root *').length,
      text: (document.querySelector('#root')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 240),
      csp: globalThis.__smokeCsp ?? [],
      meta: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'),
    })`).catch((e) => ({ error: String(e.message) }));
    if (!flags['no-screenshots']) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
      if (shot) writeFileSync(join(shots, `${p.id}.png`), Buffer.from(shot.data, 'base64'));
    }

    // --- judge the page ---
    const problems = [];
    const notes = [];
    const mine = (x) => x.page === p.id;
    const reqs = [...seen.requests.values()].filter(mine);
    const site = reqs.filter((r) => r.url.startsWith(SITE + '/') && !new URL(r.url).pathname.startsWith('/api/'));
    const apiReqs = reqs.filter((r) => r.url.startsWith(SITE + '/api/'));
    const direct = reqs.filter((r) => !r.url.startsWith(SITE + '/'));
    const sockets = seen.sockets.filter(mine);

    if (!didLoad) problems.push('the page did not finish loading in 30 s');
    if (dom.error) problems.push(`the page could not be inspected: ${dom.error}`);
    else {
      if (!dom.app || dom.nodes < 30) problems.push(`the app did not render (${dom.nodes} elements under #root)`);
      if (p.expectPath && dom.path.replace(/\/+$/, '') !== p.expectPath) problems.push(`ended on ${dom.path}${dom.search}, expected ${p.expectPath}`);
      if (!dom.meta) notes.push('no <meta> CSP in the document');
    }
    if (p.palette && !paletteOpen) problems.push('Ctrl+K did not open the command palette');

    // Our own files: every one must load, with a type a browser accepts.
    for (const r of site) {
      if (r.failed && r.failed !== 'canceled') problems.push(`site file failed: ${new URL(r.url).pathname} (${r.failed}${r.blocked ? `, blocked: ${r.blocked}` : ''})`);
      else if (r.status !== null && r.status >= 400) problems.push(`site file ${r.status}: ${new URL(r.url).pathname}`);
    }

    // CSP: the page's own events, the worker's, and DevTools' issues.
    const violations = [
      ...(dom.csp ?? []).map((v) => ({ ...v, where: 'page' })),
      ...seen.issues.filter(mine).map((v) => ({ directive: v.directive, blocked: v.blocked, where: v.where, type: v.type })),
      ...reqs.filter((r) => r.blocked === 'csp').map((r) => ({ directive: 'blocked by CSP', blocked: r.url, where: r.where })),
    ];
    const uniq = [...new Map(violations.map((v) => [`${v.directive}|${v.blocked}`, v])).values()];
    for (const v of uniq) problems.push(`CSP violation: ${v.directive} blocked ${v.blocked || '(inline)'} [${v.where}]`);

    // Our API: only allow-listed routes may be asked, and none may be refused.
    for (const r of apiReqs) {
      const u = new URL(r.url);
      const route = matchRoute(routes, r.method, u.pathname);
      if (!route) problems.push(`a route hosted mode does not serve was requested: ${r.method} ${u.pathname}`);
      if (apiThere && r.status !== null && [403, 404].includes(r.status)) problems.push(`our API answered ${r.status}: ${r.method} ${u.pathname}${u.search}`);
      else if (apiThere && API_MODE !== 'mock' && r.status !== null && r.status >= 500) problems.push(`our API answered ${r.status}: ${r.method} ${u.pathname}${u.search}`);
      if (apiThere && r.failed && r.failed !== 'canceled') problems.push(`our API request failed: ${u.pathname} (${r.failed})`);
    }

    // Sockets: to the exchanges, never to us.
    for (const s of sockets) {
      const o = originOf(s.url);
      let host = '';
      try { host = new URL(s.url).hostname; } catch { /* judged by connect-src below */ }
      if (host === SITE_HOST || host === '127.0.0.1' || host === 'localhost') problems.push(`a WebSocket was opened to this site: ${s.url} [${s.where}]`);
      else if (!connectSrc.has(o)) problems.push(`a WebSocket to an origin outside connect-src: ${o} [${s.where}]`);
    }
    if (p.expectSockets && sockets.length === 0) problems.push('the trade page opened no exchange socket');
    // Direct requests: every origin must be one connect-src (or img-src) allows.
    const strangers = [...new Set(direct.map((r) => originOf(r.url)))].filter((o) => !connectSrc.has(o) && o !== 'https://api.web3modal.org');
    for (const o of strangers) problems.push(`a request to an origin the policy does not list: ${o}`);

    // The console. Error lines can only be judged when everything the page talks to
    // is really there; in a partial run they are listed, not judged. An uncaught
    // exception is a bug in any run - unless it is the network being off.
    const consoleLines = [...seen.console.filter(mine), ...seen.exceptions.filter(mine).map((e) => ({ ...e, kind: 'exception' }))];
    const assessed = [];
    for (const c of consoleLines) {
      const why = harmless(c);
      const networky = /ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|ERR_ADDRESS|Failed to fetch|NetworkError|net::ERR_|Load failed/i.test(c.text);
      if (/Content Security Policy/i.test(c.text)) {
        if (!uniq.length) problems.push(`console: ${c.text.slice(0, 200)}`);
        assessed.push({ ...c, verdict: 'CSP' });
      } else if (why) {
        assessed.push({ ...c, verdict: `harmless (${why})` });
      } else if (OFFLINE && networky) {
        assessed.push({ ...c, verdict: 'offline' });
      } else if (c.kind === 'exception' || JUDGE_CONSOLE) {
        assessed.push({ ...c, verdict: 'ERROR' });
        problems.push(`console ${c.kind} [${c.where}]: ${c.text.slice(0, 220)}`);
      } else {
        assessed.push({ ...c, verdict: 'not judged in a partial run' });
      }
    }

    const result = {
      id: p.id, path: p.path, ok: problems.length === 0, ms: Date.now() - started, problems, notes,
      landed: dom.error ? null : `${dom.path}${dom.search}`, title: dom.title, elements: dom.nodes, text: dom.text,
      requests: { site: site.length, api: apiReqs.length, direct: direct.length },
      api: [...new Set(apiReqs.map((r) => `${r.method} ${new URL(r.url).pathname} -> ${r.status ?? r.failed}`))],
      directOrigins: Object.fromEntries([...new Set(direct.map((r) => originOf(r.url)))].map((o) => [o, direct.filter((r) => originOf(r.url) === o).length])),
      directFailures: [...new Set(direct.filter((r) => (r.status ?? 0) >= 400 || (r.failed && r.failed !== 'canceled')).map((r) => `${originOf(r.url)} ${r.status ?? r.failed}`))],
      sockets: [...new Set(sockets.map((s) => `${s.url} [${s.where}]${s.opened ? ' open' : ''}`))],
      console: assessed.map((c) => ({ verdict: c.verdict, kind: c.kind, where: c.where, text: c.text.slice(0, 240), url: c.url })),
    };
    results.push(result);
    log(`${result.ok ? 'PASS' : 'FAIL'}  ${p.id.padEnd(18)} ${String(result.requests.api).padStart(2)} api, ${String(result.requests.direct).padStart(3)} direct, ${result.sockets.length} sockets${result.problems.length ? `  - ${result.problems[0]}${result.problems.length > 1 ? ` (+${result.problems.length - 1})` : ''}` : ''}`);
  }
  current = 'after';

  // --- the SharedWorker under the production policy ---
  const worker = { started: false, problems: [] };
  const hosts = seen.workers.filter((w) => /\/assets\/worker-[\w-]+\.js/.test(w.url));
  worker.instances = seen.workers.map((w) => ({ url: w.url, firstSeenOn: w.page }));
  if (!hosts.length) {
    worker.problems.push('no SharedWorker was started from /assets/worker-<hash>.js: the tabs fell back to hosting the sockets themselves');
  } else {
    worker.started = true;
    worker.url = hosts[0].url;
    const head = await fetch(hosts[0].url, { method: 'HEAD' });
    worker.csp = head.headers.get('content-security-policy');
    worker.contentType = head.headers.get('content-type');
    if (worker.csp !== CSP.site) worker.problems.push('the worker script is not served with the site CSP: a worker takes its policy from its own response');
    if (!/javascript/.test(worker.contentType ?? '')) worker.problems.push(`the worker script is served as ${worker.contentType}`);
    const live = hosts.filter((w) => w.alive).at(-1);
    if (live) {
      const inside = await evaluate(live.session, `({ onconnect: typeof self.onconnect, csp: self.__smokeCsp ?? null })`).catch(() => null);
      worker.inside = inside;
      if (inside && inside.onconnect !== 'function') worker.problems.push('the worker is running but has no onconnect handler');
      for (const v of inside?.csp ?? []) worker.problems.push(`CSP violation inside the worker: ${v.directive} blocked ${v.blocked}`);
    }
    const ws = seen.sockets.filter((s) => s.where === 'worker');
    worker.sockets = [...new Set(ws.map((s) => `${s.url}${s.opened ? ' open' : ''}`))];
    worker.socketsOpened = ws.filter((s) => s.opened).length;
    if (!ws.length) worker.problems.push('the worker never opened an exchange socket');
    else if (!OFFLINE && !ws.some((s) => s.opened)) worker.problems.push('the worker tried to open exchange sockets and none connected');
    const pageSockets = seen.sockets.filter((s) => s.where === 'page' && /sodex/.test(s.url));
    if (pageSockets.length) worker.problems.push(`${pageSockets.length} SoDEX socket(s) were opened by a page instead of the worker`);
  }
  report.sharedWorker = { ...worker, ok: worker.problems.length === 0 };
  report.pages = results;
  if (server) {
    report.edge = {
      requests: server.requests.length,
      apiThroughEdge: [...new Set(server.requests.filter((r) => r.kind === 'api').map((r) => `${r.method} ${r.path.split('?')[0]} -> ${r.status}`))],
      siteNot200: [...new Set(server.requests.filter((r) => r.kind === 'site' && r.status !== 200).map((r) => `${r.path.split('?')[0]} -> ${r.status}`))],
    };
  }
  if (!flags.keep) await page.close();

  // One path of every kind the browser really loaded: what the header check of a deployed site asks for.
  const loaded = [...seen.requests.values()].filter((r) => r.url.startsWith(SITE + '/') && r.status === 200).map((r) => new URL(r.url).pathname);
  const first = (re) => loaded.find((p) => re.test(p));
  // The worker's own script is fetched outside the page: take it from the worker target.
  const workerScript = worker.url ? new URL(worker.url).pathname : first(/^\/assets\/worker-[\w-]+\.js$/);
  return {
    samples: ['/', '/trade', '/impressum', '/scan/', '/robots.txt', '/favicon.svg', '/favicon.ico', first(/^\/assets\/(?!worker-)[^/]+\.js$/), first(/^\/assets\/[^/]+\.css$/),
      workerScript, first(/^\/logos\//), first(/^\/addrbook\//)].filter(Boolean),
  };
}

// --- main ----------------------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const report = { at: new Date().toISOString(), site: SITE, settleMs: SETTLE_MS };
let exitCode = 2;
try {
  let dist = null;
  let api = null;
  let gateOk = true;
  let buildOk = true;
  if (REMOTE) {
    report.api = { mode: 'deployed', target: SITE };
    gateOk = await probeGate({ target: SITE, secret: null }, report);
  } else {
    dist = build();
    report.build = audit(dist);
    buildOk = report.build.ok;
    log(`static audit: ${report.build.ok ? 'ok' : 'FAILED'}${report.build.info?.sharedWorker ? `, SharedWorker ${report.build.info.sharedWorker}` : ''}`);
    for (const e of report.build.errors ?? []) log(`  FAIL ${e}`);
    for (const w of report.build.warnings ?? []) log(`  warn ${w}`);

    api = await startApi(report);
    if (api && API_MODE !== 'mock') gateOk = await probeGate(api, report);
  }
  for (const p of report.gate ?? []) log(`${p.ok ? 'PASS' : 'FAIL'}  gate: ${p.label} (${p.method} ${p.path.split('?')[0]} -> ${p.status ?? p.error})`);
  const walked = await walk(dist, api, report);

  // A deployed site: what the real edge sends, and whether the origin is closed.
  let headersOk = true;
  let originOk = true;
  if (REMOTE) {
    const rows = await checkDeployedHeaders(SITE, walked.samples);
    const redirect = await checkHttpsRedirect(SITE);
    report.headers = { rows, redirect };
    headersOk = rows.every((r) => r.problems.length === 0) && redirect.ok;
    if (typeof flags.origin === 'string') {
      report.origin = await probeOrigin(flags.origin, { edge: EDGE });
      originOk = report.origin.problems.length === 0;
    }
  }

  if (report.api?.guardLog && existsSync(report.api.guardLog)) {
    report.api.egressRefused = [...new Set(readFileSync(report.api.guardLog, 'utf8').split('\n').filter(Boolean))];
  }
  const pagesOk = report.pages.every((p) => p.ok);
  const workerOk = report.sharedWorker.ok;
  // How much of production this run stood for.
  const allPages = typeof flags.pages !== 'string';
  const full = !OFFLINE && allPages && (REMOTE || (API_MODE === 'spawn' && EGRESS === 'allow' && !flags['no-index']));
  report.coverage = full
    ? REMOTE
      ? `full: the deployed site ${SITE}, a browser with network access${report.origin ? '' : ' (the origin was not probed: no --origin)'}`
      : 'full: the hosted server with its index and its upstreams, a browser with network access'
    : `partial: ${REMOTE ? `site=${SITE}` : `api=${API_MODE}${API_MODE === 'spawn' ? ` (egress ${EGRESS}, index ${report.api.index})` : ''}`}, browser ${OFFLINE ? 'offline' : 'online'}${allPages ? '' : `, pages ${flags.pages}`}`;
  report.ok = buildOk && gateOk && headersOk && originOk && pagesOk && workerOk;
  exitCode = report.ok ? 0 : 1;

  console.log('');
  if (report.build) console.log(`  build audit        ${report.build.ok ? 'PASS' : 'FAIL'}`);
  if (report.gate) console.log(`  hosted gate        ${gateOk ? 'PASS' : 'FAIL'}  (${report.gate.filter((p) => p.ok).length}/${report.gate.length} probes${REMOTE ? ', through the edge' : ''})`);
  for (const p of report.pages) console.log(`  ${p.id.padEnd(18)} ${p.ok ? 'PASS' : 'FAIL'}${p.problems.map((x) => `\n      - ${x}`).join('')}`);
  console.log(`  SharedWorker       ${workerOk ? 'PASS' : 'FAIL'}${report.sharedWorker.problems.map((x) => `\n      - ${x}`).join('')}`);
  if (report.headers) {
    // One line per path for what is missing, one per header that differs.
    const lines = [];
    for (const r of report.headers.rows) {
      const missing = r.problems.filter((x) => x.endsWith(' is missing')).map((x) => x.slice(0, -' is missing'.length));
      if (missing.length) lines.push(`${r.path}: missing ${missing.join(', ')}`);
      for (const x of r.problems.filter((p) => !p.endsWith(' is missing'))) lines.push(`${r.path}: ${x}`);
    }
    if (!report.headers.redirect.ok) lines.push(report.headers.redirect.note);
    console.log(`  edge headers       ${headersOk ? 'PASS' : 'FAIL'}  (${report.headers.rows.length} paths; ${report.headers.redirect.note})${lines.map((x) => `\n      - ${x}`).join('')}`);
  }
  if (report.origin) {
    console.log(`  origin closed      ${originOk ? 'PASS' : 'FAIL'}  (${report.origin.host}: 443 ${report.origin.checks.tls}, API port ${report.origin.checks.api}, 80 ${report.origin.checks.http})`
      + report.origin.problems.map((x) => `\n      - ${x}`).join(''));
  }
  if (report.api?.egressRefused?.length) console.log(`  the server tried to reach (refused, egress deny): ${report.api.egressRefused.join(', ')}`);
  console.log(`  coverage           ${report.coverage}`);
} catch (e) {
  console.error('[smoke] failed:', e?.stack ?? e);
  report.error = String(e?.message ?? e);
  exitCode = 2;
} finally {
  const file = join(OUT, 'smoke-report.json');
  writeFileSync(file, JSON.stringify(report, (k, v) => (k === 'session' ? undefined : v), 2));
  log(`report: ${file}`);
  if (flags.keep) {
    log(`--keep: everything is left running (site ${SITE}); stop with Ctrl+C`);
    await new Promise(() => {});
  }
  await cleanup();
  await sleep(300);
  // The ports this run listened on (the browser's debugging port always; the stand-in and the API when started here).
  const mine = [...(REMOTE ? [] : [PORT]), CDP_PORT, ...(REMOTE || API_MODE === 'none' || /^https?:/.test(API_MODE) ? [] : [API_PORT])];
  const busy = [];
  for (const port of mine) if (!(await portFree(port))) busy.push(port);
  log(busy.length ? `WARNING: still listening on ${busy.join(', ')}` : `stopped everything; port${mine.length > 1 ? 's' : ''} ${mine.join(', ')} ${mine.length > 1 ? 'are' : 'is'} free`);
}
process.exit(exitCode);
