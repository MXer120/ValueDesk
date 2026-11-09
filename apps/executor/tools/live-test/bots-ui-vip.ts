/**
 * REAL-MONEY live test of a ValueDesk market maker bot through the UI, on the follower test wallet, entirely on this
 * laptop: two local executors (standard + VIP) from this checkout, a local stub for the API server's volume and VIP
 * reads, and the local dev web driven by Playwright (Edge, the UI specs' test wallet with the follower's key).
 *
 *   node --import tsx apps/executor/tools/live-test/bots-ui-vip.ts [--env <.env.live>] [--headed] [--stop-after a..f] [--skip c] [--adopt]
 *
 * Steps (each one screenshotted into .state/bots-ui-vip-<time>/, the whole run logged to .state/bots-ui-vip-<time>.log):
 *   a  /bots: sign in (the day key), the bot setup's terms, real orders set up (fee approval, trading key)
 *   b  New bot: Market maker, Oracle maker, real orders, $12 orders, $24 max holding, $3 loss limit, 1 h; Start;
 *      Running and "Check passed" on its page; its post-only quotes on SoDEX; the leverage the page showed
 *   c  the bot fee ladder: stub volume $0 / $150k / $600k / VIP -> /me bots.feeTenths 3 / 2 / 1 / 1, the standard
 *      executor hard-restarted after each change (the bot resumes, its quotes reconciled, no order twice); the fee on
 *      the quotes and on any fill SoDEX booked
 *   d  VIP up: Savings > Move to VIP, the full-screen scene, no wallet signature; the bot runs on the VIP executor
 *   e  VIP down: the stub says not VIP; the VIP executor moves the wallet back by itself (sweep every 30 s); the page
 *      follows (reload only if it does not); a 'vip-back' notice
 *   f  Stop > Clean stop on the bot page; nothing resting, flat on SoDEX; the harness's flatten finds nothing
 *
 * Money: one bot, BTC-USD, $12 orders, $24 max holding, $3 loss limit. Any failure: the executors' kill switches, then
 * the harness's flatten (cancel everything, close reduce-only) on BTC-USD, read back flat.
 *
 * Secrets: the follower key is read from the env file into memory only (allParts.ts readEnvText), handed to the test
 * wallet (apps/web/e2e/live/provider.ts createKeyProvider via e2e/ui/wallet.ts) and to the harness's SoDEX wallet
 * (cleanup) and signed client (/me reads). Never logged, never in a child process's environment.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, type WriteStream } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { hexToBytes } from '../../../../packages/sodex-core/src/index.ts';
import type { AlgoView } from '../../../../packages/copy-engine/src/index.ts';
import { egress } from '../../src/net.ts';
import { readEnvText } from './allParts.ts';
import { flatten } from './cleanup.ts';
import { SodexReads, SodexWallet, type FillInfo, type OrderInfo } from './exchange.ts';
import { CopyWallet, ExecutorClient } from './executor.ts';
import { VolumeStub, VOLUME_PATH } from './feeStub.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const WEB = join(REPO, 'apps', 'web');
const EXEC_DIR = join(REPO, 'apps', 'executor');
const STATE = join(HERE, '.state');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SHOTS = join(STATE, `bots-ui-vip-${STAMP}`);
const LOGFILE = join(STATE, `bots-ui-vip-${STAMP}.log`);
const SYMBOL = 'BTC-USD';
const ORDER_USD = 12;
const HOLD_USD = 24;
const LOSS_USD = 3;
const PORTS = { std: 18811, vip: 18812, stub: 18813, web: 5193 };
const LOCAL = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local');
const DATA = { std: join(LOCAL, 'Valuescan', 'live-bots-std'), vip: join(LOCAL, 'Valuescan', 'live-bots-vip') };
const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ args, log ----- */

const argv = process.argv.slice(2);
const arg = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const ENV_FILE = arg('--env') ?? join(REPO, '..', '..', '..', 'apps', 'executor', 'tools', 'live-test', '.env.live');
const HEADED = argv.includes('--headed');
const ADOPT = argv.includes('--adopt');
const STOP_AFTER = arg('--stop-after');
/** Steps left out (comma-separated, e.g. --skip c: the fee ladder, which an earlier run already showed). */
const SKIP = new Set((arg('--skip') ?? '').split(',').map((x) => x.trim()).filter(Boolean));

mkdirSync(SHOTS, { recursive: true });
const logStream = createWriteStream(LOGFILE, { flags: 'a' });
function log(s: string): void {
  const line = `${new Date().toISOString().slice(11, 19)} ${s}`;
  process.stdout.write(`${line}\n`);
  logStream.write(`${line}\n`);
}

/** The results table: step -> pass/fail and its evidence. */
const results: Record<string, { status: 'pass' | 'fail' | 'partial' | 'skip'; evidence: string[] }> = {};
const ev = (step: string, line: string) => {
  (results[step] ??= { status: 'pass', evidence: [] }).evidence.push(line);
  log(`  [${step}] ${line}`);
};
const fail = (step: string, line: string) => {
  (results[step] ??= { status: 'pass', evidence: [] }).status = 'fail';
  ev(step, `FAIL ${line}`);
};
const partial = (step: string, line: string) => {
  const r = (results[step] ??= { status: 'pass', evidence: [] });
  if (r.status === 'pass') r.status = 'partial';
  ev(step, `NOTE ${line}`);
};
const surprises: string[] = [];
const surprise = (s: string) => {
  surprises.push(s);
  log(`  ! ${s}`);
};
function writeResults(extra: Record<string, unknown> = {}): void {
  writeFileSync(join(SHOTS, 'results.json'), JSON.stringify({ at: new Date().toISOString(), results, surprises, ...extra }, null, 2));
}

/* ------------------------------------------------------------------ processes ----- */

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** The environment a child Node process needs, and nothing else (no key, no alert tokens). */
function baseEnv(): Record<string, string> {
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'ComSpec', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS'];
  const out: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) out[k] = process.env[k]!;
  return out;
}

class Proc {
  private child: ChildProcess | null = null;
  private out: WriteStream;
  exited: number | null | undefined = undefined;
  constructor(readonly name: string, readonly logFile: string, private readonly spawnArgs: () => { args: string[]; cwd: string; env: Record<string, string> }, readonly healthUrl: string) {
    this.out = createWriteStream(logFile, { flags: 'a' });
  }
  get running(): boolean {
    return !!this.child && this.exited === undefined;
  }
  async start(timeoutMs = 120_000): Promise<void> {
    if (this.running) return;
    const { args, cwd, env } = this.spawnArgs();
    this.out.write(`\n--- start ${new Date().toISOString()} ---\n`);
    this.exited = undefined;
    const c = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = c;
    c.stdout?.on('data', (d: Buffer) => this.out.write(d));
    c.stderr?.on('data', (d: Buffer) => this.out.write(d));
    c.once('exit', (code) => {
      if (this.child === c) this.exited = code;
      this.out.write(`--- exit ${code} ${new Date().toISOString()} ---\n`);
    });
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (this.exited !== undefined) throw new Error(`${this.name} exited at start (code ${this.exited}); see ${this.logFile}`);
      try {
        const r = await fetch(this.healthUrl, { signal: AbortSignal.timeout(3_000) });
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      await sleep(500);
    }
    throw new Error(`${this.name} did not answer ${this.healthUrl} within ${timeoutMs / 1000} s; see ${this.logFile}`);
  }
  /** Hard: no shutdown code runs (as a power cut). */
  async kill(): Promise<void> {
    const c = this.child;
    if (!c || this.exited !== undefined) {
      this.child = null;
      return;
    }
    const gone = new Promise<void>((r) => c.once('exit', () => r()));
    c.kill('SIGKILL');
    await Promise.race([gone, sleep(10_000)]);
    this.child = null;
    this.exited = null;
  }
}

/* ------------------------------------------------------------------ the stub ----- */

/**
 * The API server as both executors and the page read it: GET /api/vs/builder/volume (feeStub.ts VolumeStub's checks:
 * token, follower, builder, 14 days; plus `vip` when set), /api/vs/builder/beta, /api/vs/calendar, and
 * GET /api/vs/bots/vip?address (the page reads it through the dev web; the executors directly).
 */
class ApiStub {
  readonly volume: VolumeStub;
  vip = false;
  eligible = false;
  eligibleVolume = 0;
  readonly hits: Array<{ at: number; path: string; status: number; from: string }> = [];
  private server: Server | null = null;
  constructor(follower: string) {
    this.volume = new VolumeStub(follower);
  }
  get origin(): string {
    return `http://127.0.0.1:${PORTS.stub}`;
  }
  get volumeUrl(): string {
    return `${this.origin}${VOLUME_PATH}`;
  }
  async start(): Promise<void> {
    const s = createHttpServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      let status = 200;
      let body: unknown;
      if (u.pathname === VOLUME_PATH) {
        const t = req.headers['x-internal-token'];
        const r = this.volume.judge(req.url ?? '/', Array.isArray(t) ? t[0] : t);
        this.volume.reads.push(r.read);
        status = r.status;
        body = r.status === 200 ? { ...(r.body as object), ...(this.vip ? { vip: true } : {}) } : r.body;
      } else if (u.pathname === '/api/vs/builder/beta') {
        body = { ok: true, listed: false };
      } else if (u.pathname === '/api/vs/calendar') {
        body = { ok: true, events: [] };
      } else if (u.pathname === '/api/vs/bots/vip') {
        const a = (u.searchParams.get('address') ?? '').toLowerCase();
        if (a !== this.volume.follower.toLowerCase()) {
          status = 400;
          body = { ok: false, error: 'another wallet' };
        } else body = { ok: true, eligible: this.eligible, volumeUsd: this.eligibleVolume, minUsd: 1_000_000, days: 14, promo: null };
      } else {
        status = 404;
        body = { error: 'not found' };
      }
      this.hits.push({ at: Date.now(), path: u.pathname, status, from: String(req.headers['user-agent'] ?? '').slice(0, 20) });
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(PORTS.stub, '127.0.0.1', () => resolve());
    });
    this.server = s;
  }
  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
  set(o: { usd?: number; vip?: boolean; eligible?: boolean }): void {
    if (o.usd !== undefined) this.volume.answer = { usd: o.usd };
    if (o.vip !== undefined) this.vip = o.vip;
    if (o.eligible !== undefined) {
      this.eligible = o.eligible;
      this.eligibleVolume = o.eligible ? 1_250_000 : 40_000;
    }
    log(`stub: volume ${JSON.stringify(this.volume.answer)}, vip perk ${this.vip}, VIP eligible ${this.eligible}`);
  }
}

/* ------------------------------------------------------------------ web modules ----- */

async function webModule<T>(rel: string): Promise<T> {
  const { tsImport } = (await import('tsx/esm/api')) as { tsImport: (spec: string, o: { parentURL: string; tsconfig: string }) => Promise<unknown> };
  return (await tsImport(pathToFileURL(join(WEB, rel)).href, { parentURL: import.meta.url, tsconfig: join(WEB, 'tsconfig.json') })) as T;
}

interface TestWallet {
  readonly address: string;
  readonly log: Array<{ at: number; method: string; kind?: string; outcome: string; reason?: string; action?: string }>;
  since(mark?: number): TestWallet['log'];
  mark(): number;
}
interface UiHarness {
  newUiContext(browser: Browser, wallet: TestWallet, storage?: Record<string, string>): Promise<BrowserContext>;
  acceptWelcome(page: Page): Promise<void>;
  connectWallet(page: Page): Promise<void>;
  until(page: Page, cond: () => Promise<boolean> | boolean, what: string, ms?: number): Promise<void>;
}

/* ------------------------------------------------------------------ main ----- */

const env = (() => {
  if (!existsSync(ENV_FILE)) throw new Error(`no env file at ${ENV_FILE} (--env <file>)`);
  return readEnvText(readFileSync(ENV_FILE, 'utf8'));
})();
const keyHex = (() => {
  const h = (env.LIVE_FOLLOWER_KEY ?? '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error('LIVE_FOLLOWER_KEY in the env file is not 64 hex characters');
  return `0x${h}`;
})();
const pk = hexToBytes(keyHex);

const reads = new SodexReads(egress(null).fetch);
const follower = new SodexWallet('follower', pk, reads);
const stub = new ApiStub(follower.address);
const vipToken = randomBytes(24).toString('hex');
const stdBase = `http://127.0.0.1:${PORTS.std}/api/copy/v1`;
const vipBase = `http://127.0.0.1:${PORTS.vip}/api/copy/v1`;
const pubkeys: { std: string | null; vip: string | null } = { std: null, vip: null };
const tsxLoader = import.meta.resolve('tsx');

function executorEnv(which: 'std' | 'vip'): Record<string, string> {
  const e: Record<string, string> = {
    ...baseEnv(),
    EXECUTOR_KIND: 'hosted',
    EXECUTOR_EDGE: 'none',
    EXECUTOR_DATA_DIR: DATA[which],
    EXECUTOR_BRAKE_FILE: join(DATA[which], 'brake.json'),
    EXECUTOR_LOCATION: which === 'vip' ? 'this computer (VIP, live test)' : 'this computer (standard, live test)',
    HOST: '127.0.0.1',
    PORT: String(which === 'std' ? PORTS.std : PORTS.vip),
    SODEX_NETWORK: 'mainnet',
    LOG_LEVEL: 'info',
    EXECUTOR_BUILDER_URL: stub.volumeUrl,
    EXECUTOR_BUILDER_TOKEN: stub.volume.token,
    EXECUTOR_VIP_CHECK_URL: `${stub.origin}/api/vs/bots/vip`,
    EXECUTOR_VIP_TOKEN: vipToken,
    EXECUTOR_LIVE_ALGOS_WALLETS: follower.address,
  };
  if (which === 'std') {
    e.EXECUTOR_VIP_URL = vipBase;
    if (pubkeys.vip) e.EXECUTOR_VIP_PUBKEY = pubkeys.vip;
  } else {
    e.EXECUTOR_TIER = 'vip';
    e.EXECUTOR_VIP_SWEEP_MS = '30000';
    e.EXECUTOR_STD_URL = stdBase;
    if (pubkeys.std) e.EXECUTOR_STD_PUBKEY = pubkeys.std;
  }
  return e;
}
const execArgs = () => ['--import', tsxLoader, '--disable-warning=ExperimentalWarning', join(EXEC_DIR, 'src', 'main.ts')];
const std = new Proc('standard executor', join(SHOTS, 'executor-std.log'), () => ({ args: execArgs(), cwd: EXEC_DIR, env: executorEnv('std') }), `${stdBase}/health`);
const vip = new Proc('VIP executor', join(SHOTS, 'executor-vip.log'), () => ({ args: execArgs(), cwd: EXEC_DIR, env: executorEnv('vip') }), `${vipBase}/health`);
const web = new Proc(
  'dev web',
  join(SHOTS, 'web.log'),
  () => ({
    args: [join(WEB, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', join(HERE, 'vite.bots-ui-vip.config.ts'), '--port', String(PORTS.web), '--strictPort', '--host', '127.0.0.1'],
    cwd: WEB,
    env: {
      ...baseEnv(),
      VALUETRADE_DEV_API: 'prod',
      VS_BOTS_FIXTURES: join(WEB, 'dev-fixtures'),
      LIVE_BOTS_STD_ORIGIN: `http://127.0.0.1:${PORTS.std}`,
      LIVE_BOTS_VIP_ORIGIN: `http://127.0.0.1:${PORTS.vip}`,
      LIVE_BOTS_STUB_ORIGIN: stub.origin,
      LIVE_BOTS_WEB_PORT: String(PORTS.web),
      LIVE_BOTS_VITE_CACHE: join(STATE, 'vite-cache-bots-ui-vip'),
    },
  }),
  `http://127.0.0.1:${PORTS.web}/`,
);
const WEB_ORIGIN = `http://127.0.0.1:${PORTS.web}`;

async function info(base: string): Promise<{ executorId: string; keyImport?: { publicKey?: string }; vip?: unknown; builder?: { id: number } }> {
  const r = await fetch(`${base}/info`, { signal: AbortSignal.timeout(5_000) });
  return (await r.json()) as never;
}
async function internalStats(base: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${base}/internal/stats`, { headers: { 'X-Internal-Token': stub.volume.token }, signal: AbortSignal.timeout(5_000) });
    return r.ok ? (((await r.json()) as { stats: Record<string, unknown> }).stats ?? null) : null;
  } catch {
    return null;
  }
}

/** The harness's signed clients for /me, /algos, /notices (a session signed by the follower in this process). */
let stdClient: ExecutorClient;
let vipClient: ExecutorClient;

let browser: Browser | null = null;
let page: Page | null = null;
let wallet: TestWallet | null = null;
let ui: UiHarness;
let botId: string | null = null;
let botStopped = false;
const startedAt = Date.now();
let equityStart = 0;

async function shot(name: string): Promise<void> {
  if (!page) return;
  const n = String(Object.keys(shotCount).length + 1).padStart(2, '0');
  shotCount[name] = true;
  await page.screenshot({ path: join(SHOTS, `${n}-${name}.png`), fullPage: false }).catch((e) => log(`  (screenshot ${name} failed: ${String(e).slice(0, 80)})`));
}
const shotCount: Record<string, boolean> = {};
const signed = (mark: number) => (wallet ? wallet.since(mark).filter((r) => r.outcome === 'signed').map((r) => r.kind ?? r.method) : []);
const walletAsked = (mark: number) => (wallet ? wallet.since(mark).map((r) => `${r.kind ?? r.action ?? r.method}:${r.outcome}${r.reason ? `(${r.reason.slice(0, 60)})` : ''}`) : []);

async function botOrders(): Promise<OrderInfo[]> {
  const all = await reads.openOrders(follower.address, SYMBOL);
  return botId ? all.filter((o) => o.clOrdID?.startsWith(`va-${botId!.slice(1, 13)}-`)) : all;
}
const fmtOrders = (os: OrderInfo[]) => os.map((o) => `${o.side} ${o.qty}@${o.price} ${o.tif} id=${o.orderId} cl=${o.clOrdID} bfee=${o.builderFee}`).join('; ') || 'none';

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 3_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      last = null;
    } catch (e) {
      last = e;
    }
    if (Date.now() > until) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${last ? ` (${String((last as Error)?.message ?? last).slice(0, 200)})` : ''}`);
    await sleep(everyMs);
  }
}

async function algoOn(c: ExecutorClient): Promise<AlgoView | null> {
  if (!botId) return null;
  return (await c.algos()).find((v) => v.algo.id === botId) ?? null;
}

/** SoDEX's fills of the bot since `since` (drip-limited history: read sparingly). */
async function botFills(since: number): Promise<FillInfo[]> {
  const fills = await reads.fills(follower.address, SYMBOL, since);
  return botId ? fills.filter((f) => f.clOrdID?.startsWith(`va-${botId!.slice(1, 13)}-`)) : fills;
}
const feeOfFill = (f: FillInfo) => (f.builderFee / (f.qty * f.price)) * 100_000;

/* ------------------------------------------------------------------ the page ----- */

const P = () => {
  if (!page) throw new Error('no page');
  return page;
};
const headState = async () => ((await P().locator('.bots-head .bots-state').first().textContent().catch(() => '')) ?? '').trim();
const goPage = async (name: 'Overview' | 'New bot' | 'Explore' | 'Savings', heading: string) => {
  await P().getByRole('navigation', { name: 'Bots pages' }).getByRole('button', { name, exact: true }).click();
  await P().getByRole('heading', { name: heading, exact: true }).waitFor({ timeout: 20_000 });
};
const pageVipFlag = async (): Promise<boolean> => P().evaluate((a) => (localStorage.getItem('vs.vip.moved') ?? '').split(',').includes(a), follower.address).catch(() => false);

/** Copy requests the page sent to each executor in the last `ms`. */
const traffic: Array<{ at: number; to: 'std' | 'vip'; path: string }> = [];
/** The page's executor calls answered 4xx/5xx (time, path, status). */
const refused: string[] = [];
/** The page's kept executor sessions: key names and expiry only, never a token. */
const sessionKeys = async (): Promise<Array<{ key: string; expiresAt: string | null }>> =>
  P().evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('vd.copy.session:')).map((k) => {
    let exp: string | null = null;
    try { exp = new Date((JSON.parse(localStorage.getItem(k) ?? '{}') as { expiresAt?: number }).expiresAt ?? 0).toISOString(); } catch { exp = null; }
    return { key: k.replace(/0x[0-9a-f]{40}/, 'OWNER'), expiresAt: exp };
  })).catch(() => []);
const recentTraffic = (ms: number) => {
  const since = Date.now() - ms;
  const r = traffic.filter((t) => t.at >= since);
  return { std: r.filter((t) => t.to === 'std').length, vip: r.filter((t) => t.to === 'vip').length };
};

/** The bot setup sheet: whatever steps are still open (sign in, terms, fee, key), as a person does them. */
async function finishSetupSheet(step: string): Promise<void> {
  const p = P();
  const sheet = p.getByRole('dialog', { name: 'Bot setup' });
  await sheet.waitFor({ state: 'visible', timeout: 20_000 });
  await p.waitForTimeout(600);
  await shot(`${step}-setup-sheet`);
  const stepItem = (t: string) => sheet.getByRole('listitem').filter({ hasText: t });
  for (let round = 0; round < 12; round++) {
    // Done when the sheet's primary button says Done.
    const done = sheet.locator('.cs-actions').getByRole('button', { name: 'Done', exact: true });
    if (await done.isVisible().catch(() => false)) {
      if (await done.isEnabled().catch(() => false)) {
        await shot(`${step}-setup-ready`);
        await done.click();
        await sheet.waitFor({ state: 'hidden', timeout: 10_000 });
        return;
      }
    }
    // Terms: Continue/Review, the four statements, Sign and accept (+ ValueDesk's own terms popup).
    const termsBtn = stepItem('Accept the terms').getByRole('button', { name: /^(Continue|Review)$/ });
    if (await termsBtn.isVisible().catch(() => false)) {
      await termsBtn.click();
      await p.waitForTimeout(800);
      continue;
    }
    const statement = sheet.getByRole('checkbox', { name: /^I am at least 18/ });
    if (await statement.isVisible().catch(() => false)) {
      for (const s of [/^I am at least 18/, /^I am not a US person/, /^I chose every bot/, /^I have read the terms and risk disclosure/]) await sheet.getByRole('checkbox', { name: s }).check();
      await shot(`${step}-terms-form`);
      await sheet.getByRole('button', { name: 'Sign and accept', exact: true }).click();
      const site = p.getByRole('dialog', { name: 'Sign the terms to continue' });
      if (await site.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)) {
        await site.getByRole('checkbox', { name: /^I confirm that/ }).check();
        await site.getByRole('button', { name: 'Only necessary', exact: true }).click();
      }
      await p.getByText('Terms accepted.').first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
      await p.waitForTimeout(1_000);
      continue;
    }
    // Fee approval.
    const feeBtn = stepItem('Approve the fee').getByRole('button', { name: 'Approve', exact: true });
    if (await feeBtn.isVisible().catch(() => false) && (await feeBtn.isEnabled().catch(() => false))) {
      await feeBtn.click();
      await p.getByText('Fee approved on SoDEX.').first().waitFor({ state: 'visible', timeout: 60_000 }).catch(() => undefined);
      await p.waitForTimeout(1_000);
      continue;
    }
    // Trading key: the shortest lifetime, Approve (the executor makes the key, the wallet registers it on SoDEX).
    const keyStep = stepItem('Approve the trading key');
    const keyBtn = keyStep.getByRole('button', { name: 'Approve', exact: true });
    if (await keyBtn.isVisible().catch(() => false) && (await keyBtn.isEnabled().catch(() => false))) {
      const seven = keyStep.getByRole('button', { name: '7 days', exact: true });
      if (await seven.isVisible().catch(() => false)) await seven.click();
      await shot(`${step}-key-step`);
      await keyBtn.click();
      await p.getByText('Trading key registered on your SoDEX account.').first().waitFor({ state: 'visible', timeout: 90_000 }).catch(() => undefined);
      await p.waitForTimeout(1_500);
      continue;
    }
    // Sign in (a step of its own, if shown).
    const signIn = sheet.getByRole('button', { name: 'Sign in', exact: true });
    if (await signIn.isVisible().catch(() => false) && (await signIn.isEnabled().catch(() => false))) {
      await signIn.click();
      await p.waitForTimeout(1_500);
      continue;
    }
    await p.waitForTimeout(1_500);
  }
  const text = ((await sheet.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 600);
  await shot(`${step}-setup-stuck`);
  throw new Error(`the bot setup sheet did not finish: ${text}`);
}

/* ------------------------------------------------------------------ steps ----- */

async function bootProcesses(): Promise<void> {
  for (const [k, p] of Object.entries(PORTS)) if (!(await portFree(p))) throw new Error(`port ${p} (${k}) is in use: another run, or something else; stop it first`);
  for (const d of Object.values(DATA)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await stub.start();
  log(`stub on ${stub.origin}`);
  // The pinned import keys: VIP first (its key for the standard side), then standard, then VIP again with standard's.
  await vip.start();
  pubkeys.vip = (await info(vipBase)).keyImport?.publicKey ?? null;
  if (!pubkeys.vip) throw new Error('the VIP executor has no keyImport.publicKey in /info');
  await std.start();
  const si = await info(stdBase);
  pubkeys.std = si.keyImport?.publicKey ?? null;
  if (!pubkeys.std) throw new Error('the standard executor has no keyImport.publicKey in /info');
  await vip.kill();
  await vip.start();
  const vi = await info(vipBase);
  if (vi.executorId !== si.executorId) throw new Error(`executor ids differ: ${si.executorId} / ${vi.executorId}`);
  stub.volume.builder = si.builder?.id ?? null;
  log(`executors up: standard ${stdBase}, VIP ${vipBase}, id ${si.executorId}, builder ${si.builder?.id}, std vip=${JSON.stringify(si.vip)}, vip vip=${JSON.stringify(vi.vip)}`);
  stdClient = new ExecutorClient({ base: stdBase }, new CopyWallet(pk), si.executorId, 'live');
  vipClient = new ExecutorClient({ base: vipBase }, new CopyWallet(pk), si.executorId, 'live');
  await web.start(240_000);
  log(`dev web on ${WEB_ORIGIN} (log ${web.logFile})`);
}

async function openBrowser(): Promise<void> {
  ui = await webModule<UiHarness>('e2e/ui/harness.ts');
  const { launchEdge } = await webModule<{ launchEdge: (o: { headed?: boolean }) => Promise<Browser> }>('e2e/ui/browser.ts');
  const { createTestWallet } = await webModule<{ createTestWallet: (o: { privateKey?: string }) => TestWallet }>('e2e/ui/wallet.ts');
  wallet = createTestWallet({ privateKey: keyHex });
  if (wallet.address.toLowerCase() !== follower.address) throw new Error('the test wallet is not the follower');
  browser = await launchEdge({ headed: HEADED });
  const ctx = await ui.newUiContext(browser, wallet, { 'vd.bots.demo': '0' });
  page = await ctx.newPage();
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/api/copy-vip/')) traffic.push({ at: Date.now(), to: 'vip', path: new URL(u).pathname });
    else if (u.includes('/api/copy/')) traffic.push({ at: Date.now(), to: 'std', path: new URL(u).pathname });
  });
  page.on('pageerror', (e) => logStream.write(`pageerror: ${String(e?.message ?? e).slice(0, 300)}\n`));
  // Every refused executor call of the page (status and path), for the log: a 401/403/429 explains a sign-out.
  page.on('response', (r) => {
    const u = r.url();
    if (r.status() >= 400 && /\/api\/copy(-vip)?\//.test(u)) {
      const line = `${new Date().toISOString().slice(11, 19)} page ${r.request().method()} ${new URL(u).pathname} -> ${r.status()}`;
      refused.push(line);
      logStream.write(`${line}\n`);
    }
  });
  page.on('console', (m) => {
    if (m.type() === 'error') logStream.write(`console: ${m.text().slice(0, 300)}\n`);
  });
}

async function stepA(): Promise<void> {
  const p = P();
  await p.goto(`${WEB_ORIGIN}/bots`, { waitUntil: 'domcontentloaded' });
  await ui.acceptWelcome(p);
  await p.getByRole('heading', { name: 'Bots', exact: true }).waitFor({ timeout: 60_000 });
  await ui.connectWallet(p);
  await shot('a-connected');
  let mark = wallet!.mark();
  const signIn = p.locator('.bots-setupcard').getByRole('button', { name: 'Sign in', exact: true });
  await signIn.waitFor({ state: 'visible', timeout: 30_000 });
  await signIn.click();
  await p.getByRole('button', { name: 'Set up', exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
  const sig = signed(mark);
  if (sig.length === 1 && sig[0] === 'day-key') ev('a', `sign-in: one wallet signature, the day key ('delegate')`);
  else fail('a', `sign-in signatures: ${JSON.stringify(sig)} (asked: ${walletAsked(mark).join(', ')})`);
  await shot('a-signed-in');
  mark = wallet!.mark();
  await p.getByRole('button', { name: 'Set up', exact: true }).first().click();
  await finishSetupSheet('a');
  const termsSig = signed(mark);
  ev('a', `terms: signatures ${JSON.stringify(termsSig)}`);
  if (!termsSig.includes('copy-terms')) fail('a', 'no copy-terms signature recorded');
  const me = await stdClient.me();
  ev('a', `executor /me: terms ${me.terms?.termsVersion} from ${me.terms?.country}, key ${me.key ? `${me.key.name} registered=${me.key.registered}` : 'none'}, bots.feeTenths ${(me as { bots?: { feeTenths?: number } }).bots?.feeTenths}`);
  if (me.terms?.termsVersion !== '2026-11-09') fail('a', `terms version ${me.terms?.termsVersion}, not 2026-11-09`);
}

async function stepB(): Promise<void> {
  const p = P();
  await goPage('New bot', 'New bot');
  const next = p.getByRole('button', { name: /^Next/ });
  if ((await p.getByRole('radio', { name: 'Market maker', exact: true }).getAttribute('aria-checked')) !== 'true') await p.getByRole('radio', { name: 'Market maker', exact: true }).click();
  await shot('b-new-type');
  await next.click();
  await p.getByRole('table', { name: 'Markets' }).waitFor({ timeout: 30_000 });
  await p.getByRole('searchbox', { name: 'Search a market' }).fill('BTC');
  const btc = p.getByRole('checkbox', { name: SYMBOL, exact: true }).first();
  await btc.waitFor({ timeout: 20_000 });
  if ((await btc.getAttribute('aria-checked')) !== 'true') await btc.click();
  await shot('b-new-market');
  await next.click();
  const oracle = p.getByRole('radio', { name: 'Oracle maker', exact: true });
  await oracle.waitFor({ timeout: 20_000 });
  if ((await oracle.getAttribute('aria-checked')) !== 'true') await oracle.click();
  await shot('b-new-preset');
  await next.click();
  await p.getByText('Order size', { exact: true }).first().waitFor({ timeout: 20_000 });
  const practice = p.getByRole('switch', { name: 'Practice' });
  if (await practice.isDisabled()) throw new Error('the Practice switch is disabled: real orders are not offered to this wallet (VITE_LIVE_ALGOS_WALLETS / liveBotsFor)');
  if ((await practice.getAttribute('aria-checked')) === 'true') await practice.click();
  await ui.until(p, async () => (await practice.getAttribute('aria-checked')) === 'false', 'Practice off', 5_000);
  const fill = async (name: string, v: string) => {
    const box = p.getByRole('textbox', { name, exact: true }).first();
    await box.click();
    await box.press('Control+A');
    await box.pressSequentially(v, { delay: 20 });
    await box.blur();
  };
  await fill('Order size', String(ORDER_USD));
  await fill('Max holding', String(HOLD_USD));
  await fill('Loss', String(LOSS_USD));
  await p.getByRole('radiogroup', { name: 'Run for' }).getByRole('radio', { name: '1h', exact: true }).click();
  await p.waitForTimeout(2_500);
  const levBox = p.getByRole('textbox', { name: 'Leverage', exact: true }).first();
  const levShown = (await levBox.isVisible().catch(() => false)) ? await levBox.inputValue() : '(no leverage row)';
  const vals = { order: await p.getByRole('textbox', { name: 'Order size', exact: true }).first().inputValue(), hold: await p.getByRole('textbox', { name: 'Max holding', exact: true }).first().inputValue(), loss: await p.getByRole('textbox', { name: 'Loss', exact: true }).first().inputValue() };
  ev('b', `Size & risk: order ${vals.order}, max holding ${vals.hold}, loss ${vals.loss}, run for 1h, leverage shown ${levShown} (Auto)`);
  await shot('b-new-size');
  for (let i = 0; i < 3; i++) {
    await next.click();
    await p.waitForTimeout(500);
  }
  await shot('b-new-review');
  // Real orders not set up yet: the review's Set up opens the sheet for them (fee, trading key).
  const why = p.locator('.bots-fine');
  for (let i = 0; i < 2; i++) {
    const t = ((await why.textContent().catch(() => '')) ?? '').trim();
    if (!t) break;
    log(`  review says: ${t}`);
    const setUp = why.getByRole('button', { name: 'Set up', exact: true });
    if (await setUp.isVisible().catch(() => false)) {
      const mark = wallet!.mark();
      await setUp.click();
      await finishSetupSheet('b-real');
      ev('a', `real orders set up: signatures ${JSON.stringify(signed(mark))}`);
      await p.waitForTimeout(1_500);
    } else break;
  }
  const keys = await reads.apiKeys(follower.address);
  const k = keys.find((x) => x.name === 'vd-copy-tokyo');
  ev('a', `SoDEX lists key vd-copy-tokyo ${k ? `${String(k.publicKey).slice(0, 10)}... until ${k.expiresAt ? new Date(Number(k.expiresAt)).toISOString() : '?'}` : 'NOT FOUND'}; builder approval ${await reads.builderApproval(follower.address, 234812)}`);
  const levFinal = (await levBox.isVisible().catch(() => false)) ? await levBox.inputValue() : null;
  const startBtn = p.getByRole('button', { name: 'Start bot', exact: true });
  await ui.until(p, async () => await startBtn.isEnabled(), `Start bot enabled (${((await why.textContent().catch(() => '')) ?? '').trim()})`, 60_000);
  await shot('b-ready-to-start');
  const mark = wallet!.mark();
  await startBtn.click();
  const dlg = p.getByRole('dialog', { name: /^Start / });
  await dlg.waitFor({ timeout: 10_000 });
  ev('b', `start dialog: ${((await dlg.innerText()) ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
  await shot('b-start-confirm');
  await dlg.getByRole('button', { name: 'Start bot', exact: true }).click();
  await p.waitForURL((u) => /^\/bots\/[^/]+$/.test(u.pathname) && !['/bots/new', '/bots/explore', '/bots/savings'].includes(u.pathname), { timeout: 45_000 });
  botId = new URL(p.url()).pathname.split('/')[2]!;
  const sig = signed(mark);
  if (sig.length === 0) ev('b', `bot ${botId} started with no wallet signature (the day key signed)`);
  else fail('b', `start signatures: ${JSON.stringify(sig)}`);
  await ui.until(p, async () => (await headState()).includes('Running'), 'the bot page says Running', 60_000);
  ev('b', `bot page header: ${await headState()}`);
  await p.waitForTimeout(8_000);
  await shot('b-bot-running');
  // Its quotes on SoDEX: post-only (GTX), the bot's client ids.
  const orders = await waitFor('the bot quotes on SoDEX', async () => {
    const o = await botOrders();
    return o.length >= 1 ? o : null;
  }, 90_000);
  ev('b', `SoDEX open orders of the bot: ${fmtOrders(orders)}`);
  if (!orders.every((o) => /GTX|POST/i.test(o.tif))) fail('b', `not every quote is post-only: ${orders.map((o) => o.tif).join(',')}`);
  const lev = await reads.leverage(follower.address, SYMBOL);
  ev('b', `SoDEX leverage on ${SYMBOL}: ${JSON.stringify(lev)}; page showed ${levFinal ?? levShown}`);
  if (levFinal && lev && Number(levFinal) !== lev.leverage) fail('b', `leverage on SoDEX ${lev.leverage} != page ${levFinal}`);
  // Activity: "Check passed" lines.
  await p.getByRole('tab', { name: 'Activity', exact: true }).click();
  await p.locator('.bots-flog__row').first().waitFor({ state: 'visible', timeout: 30_000 });
  await p.waitForTimeout(1_500);
  const rows = await p.locator('.bots-flog__row').allInnerTexts();
  const checks = rows.filter((r) => /Check passed/i.test(r)).map((r) => r.replace(/\s+/g, ' ').slice(0, 140));
  if (checks.length) ev('b', `Activity shows ${checks.length} "Check passed" line(s): ${checks.slice(0, 6).join(' | ')}`);
  else {
    const evs = await stdClient.events(botId, 50).catch(() => []);
    fail('b', `no "Check passed" in Activity (${rows.length} rows; executor events: ${evs.filter((e) => /Check passed/.test(e.text)).map((e) => e.text).join(' | ') || 'none'})`);
  }
  await shot('b-activity');
  const v = await algoOn(stdClient);
  ev('b', `standard executor: ${v?.algo.status}, spec orderUsd ${(v?.algo.spec as { orderUsd?: number })?.orderUsd}, maxInventoryUsd ${(v?.algo.spec as { maxInventoryUsd?: number })?.maxInventoryUsd}, maxLossUsd ${(v?.algo.spec as { maxLossUsd?: number })?.maxLossUsd}, endAt ${(v?.algo.spec as { endAt?: number })?.endAt ? new Date((v?.algo.spec as { endAt: number }).endAt).toISOString() : '-'}, paper ${v?.algo.spec.paper}, leverage ${(v?.algo.spec as { leverage?: number })?.leverage}`);
}

/** Restart the standard executor hard, then check the bot came back without doubling a quote. */
async function restartStd(step: string): Promise<void> {
  const before = await botOrders();
  const t0 = Date.now();
  await std.kill();
  await sleep(5_000);
  await std.start();
  ev(step, `standard executor hard-killed and up again in ${((Date.now() - t0) / 1000).toFixed(1)} s (orders before: ${before.length})`);
  const v = await waitFor('the bot runs again after the restart', async () => {
    const x = await algoOn(stdClient);
    return x && x.algo.status === 'running' && (x.bot?.orders.length ?? 0) >= 1 ? x : null;
  }, 2 * MIN);
  ev(step, `after restart: ${v.algo.status}, book orders ${v.bot?.orders.length}, fills ${v.bot?.fills}, rejects ${v.algo.rejects}`);
  // Never two quotes on one side, in a few reads over 20 s.
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    const o = await botOrders();
    worst = Math.max(worst, o.filter((x) => x.side === 'buy').length, o.filter((x) => x.side === 'sell').length);
    if (i < 3) await sleep(5_000);
  }
  if (worst <= 1) ev(step, 'never two resting quotes on one side after the restart (4 reads over 15 s)');
  else fail(step, `${worst} resting quotes on one side after the restart`);
}

async function stepC(): Promise<void> {
  const tiers: Array<{ label: string; set: { usd: number; vip: boolean }; want: number }> = [
    { label: '$0', set: { usd: 0, vip: false }, want: 3 },
    { label: '$150k', set: { usd: 150_000, vip: false }, want: 2 },
    { label: '$600k', set: { usd: 600_000, vip: false }, want: 1 },
    { label: 'VIP perk ($0 volume)', set: { usd: 0, vip: true }, want: 1 },
  ];
  for (const [i, t] of tiers.entries()) {
    const since = Date.now();
    if (i > 0) {
      stub.set(t.set);
      await restartStd('c');
    }
    const fee = await waitFor(`/me bots.feeTenths ${t.want}`, async () => {
      const me = (await stdClient.me()) as { bots?: { feeTenths?: number; vip?: boolean } };
      return me.bots?.feeTenths === t.want ? me.bots : null;
    }, 60_000, 3_000).catch(async (e) => {
      const me = (await stdClient.me().catch(() => null)) as { bots?: unknown } | null;
      fail('c', `${t.label}: ${String(e).slice(0, 120)}; /me bots ${JSON.stringify(me?.bots)}`);
      return null;
    });
    if (fee) ev('c', `${t.label}: /me bots ${JSON.stringify(fee)}`);
    // The quotes placed after the change carry the new fee (SoDEX's order builder fee rate).
    const quotes = await waitFor(`quotes with builder fee ${t.want}`, async () => {
      const o = await botOrders();
      return o.length && o.every((x) => x.builderFee === t.want) ? o : null;
    }, 3 * MIN, 5_000).catch(async () => {
      const o = await botOrders();
      partial('c', `${t.label}: resting quotes' builder fee rates ${JSON.stringify(o.map((x) => x.builderFee))} (wanted ${t.want} on all within 3 min)`);
      return null;
    });
    if (quotes) ev('c', `${t.label}: SoDEX resting quotes carry builder fee ${t.want}: ${fmtOrders(quotes)}`);
    // A fill, if one came (not forced): read once after ~2 min on the step.
    const left = since + 2.5 * MIN - Date.now();
    if (left > 0) await sleep(left);
    const fills = await botFills(since).catch((e) => {
      partial('c', `${t.label}: fills could not be read (${String(e).slice(0, 80)})`);
      return [] as FillInfo[];
    });
    const fresh = fills.filter((f) => f.time >= since + (i > 0 ? 20_000 : 0));
    if (fresh.length) {
      const rates = fresh.map((f) => feeOfFill(f).toFixed(2));
      const ok = fresh.every((f) => Math.abs(feeOfFill(f) - t.want) < 0.3);
      (ok ? ev : fail)('c', `${t.label}: ${fresh.length} fill(s) on SoDEX, builder fee ${fresh.map((f) => `$${f.builderFee.toFixed(6)} on ${f.side} ${f.qty}@${f.price} (${f.maker ? 'maker' : 'taker'}, order ${f.orderId})`).join('; ')} = ${rates.join(', ')} tenths bp (want ${t.want})`);
    } else ev('c', `${t.label}: no fill in ~2.5 min on this step (not forced)`);
    await shot(`c-tier-${i}`);
  }
}

async function stepD(): Promise<void> {
  const p = P();
  stub.set({ eligible: true });
  // The page reads the VIP standing on load and every minute: a reload reads it now.
  await p.goto(`${WEB_ORIGIN}/bots/savings`, { waitUntil: 'domcontentloaded' });
  await p.getByRole('heading', { name: 'Savings', exact: true }).waitFor({ timeout: 30_000 });
  const panel = p.locator('.bots-vip').first();
  const move = panel.getByRole('button', { name: 'Move to VIP', exact: true });
  await move.waitFor({ state: 'visible', timeout: 60_000 });
  // A wallet that just became VIP sees the full-screen unlock once ("You are VIP"): Later, then the Savings button.
  const unlock = p.getByRole('dialog', { name: 'You are VIP' });
  if (await unlock.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false)) {
    await p.waitForTimeout(1_500);
    await shot('d-vip-unlock');
    ev('d', 'the "You are VIP" unlock scene opened by itself on Savings; closed with Later');
    await unlock.getByRole('button', { name: 'Later', exact: true }).click();
    await unlock.waitFor({ state: 'hidden', timeout: 10_000 });
  }
  await shot('d-vip-panel');
  const mark = wallet!.mark();
  const ordersBefore = await botOrders();
  await move.click();
  await p.getByRole('dialog', { name: /Move your bots to the VIP servers/ }).getByRole('button', { name: 'Move to VIP', exact: true }).click();
  const scene = p.getByRole('dialog', { name: 'Moving your bots to the VIP servers' });
  await scene.waitFor({ state: 'visible', timeout: 15_000 });
  await p.waitForTimeout(700);
  await shot('d-vip-moving');
  await p.locator('.bots-vipmove.is-done[aria-label="Moving your bots to the VIP servers"]').waitFor({ state: 'visible', timeout: 60_000 });
  const secs = Number(((await scene.locator('.bots-vipmove__clock b').textContent().catch(() => '')) ?? '').replace(/[^0-9.]/g, ''));
  await p.waitForTimeout(1_200);
  await shot('d-vip-done');
  ev('d', `the move scene completed (clock ${secs} s); scene text: ${((await scene.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 240)}`);
  const sig = signed(mark);
  if (sig.length === 0) ev('d', 'no wallet signature for the move (the day key signed it)');
  else fail('d', `move signatures: ${JSON.stringify(sig)}`);
  const doneBtn = scene.getByRole('button', { name: 'Done', exact: true });
  if (await doneBtn.isVisible().catch(() => false)) await doneBtn.click();
  await panel.getByText('VIP servers', { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => partial('d', 'the panel does not say "VIP servers" within 30 s'));
  ev('d', `page localStorage vs.vip.moved holds the wallet: ${await pageVipFlag()}`);
  const onVip = await waitFor('the bot runs on the VIP executor', async () => {
    const x = await algoOn(vipClient);
    return x && x.algo.status === 'running' ? x : null;
  }, 60_000).catch((e) => {
    fail('d', String(e));
    return null;
  });
  if (onVip) ev('d', `VIP executor runs ${botId}: ${onVip.algo.status}, book fills ${onVip.bot?.fills}, volume $${onVip.bot?.volume?.toFixed(2)}`);
  const onStd = await algoOn(stdClient).catch(() => null);
  ev('d', `standard executor: ${onStd?.algo.status} (${onStd?.algo.statusReason ?? '-'})`);
  if (onStd && onStd.algo.status === 'running') fail('d', 'the standard executor still runs the bot');
  const vs = await internalStats(vipBase);
  const ss = await internalStats(stdBase);
  ev('d', `internal stats: VIP liveBots ${vs?.liveBots} vipMoves ${JSON.stringify(vs?.vipMoves)}; standard liveBots ${ss?.liveBots} vipMoves ${JSON.stringify(ss?.vipMoves)}`);
  const after = await waitFor('quotes on SoDEX after the move', async () => {
    const o = await botOrders();
    return o.length ? o : null;
  }, 90_000).catch(() => null);
  if (after) ev('d', `SoDEX quotes after the move: ${fmtOrders(after)} (before: ${ordersBefore.length})`);
  else fail('d', 'no bot quote on SoDEX within 90 s of the move');
  const meVip = (await vipClient.me()) as { bots?: unknown; movedTo?: unknown };
  const meStd = (await stdClient.me()) as { bots?: unknown; movedTo?: unknown };
  ev('d', `VIP /me bots ${JSON.stringify(meVip.bots)}, movedTo ${JSON.stringify(meVip.movedTo)}; standard /me movedTo ${JSON.stringify(meStd.movedTo)}`);
  await p.goto(`${WEB_ORIGIN}/bots/${botId}`, { waitUntil: 'domcontentloaded' });
  await ui.until(p, async () => (await headState()).includes('Running'), 'the bot page says Running on VIP', 45_000).catch(() => partial('d', `bot page header after the move: ${'?'}`));
  ev('d', `bot page header on VIP: ${await headState()}`);
  await shot('d-bot-on-vip');
}

async function stepE(): Promise<void> {
  const p = P();
  // The bot page stays open, not reloaded: whether the page follows the move back by itself is part of the test.
  ev('e', `page session keys before the move back: ${JSON.stringify(await sessionKeys())}`);
  stub.set({ eligible: false, vip: false, usd: 0 });
  const t0 = Date.now();
  const back = await waitFor('the VIP executor moves the wallet back (sweep every 30 s)', async () => {
    const x = await algoOn(stdClient);
    return x && x.algo.status === 'running' ? x : null;
  }, 4 * MIN, 5_000).catch((e) => {
    fail('e', String(e));
    return null;
  });
  if (back) ev('e', `moved back by itself ${((Date.now() - t0) / 1000).toFixed(0)} s after the stub said not VIP: standard runs ${botId} (${back.algo.status}, book fills ${back.bot?.fills})`);
  const onVip = await algoOn(vipClient).catch(() => null);
  ev('e', `VIP executor: ${onVip?.algo.status} (${onVip?.algo.statusReason ?? '-'})`);
  // The page: follows by itself?
  const followed = await waitFor('the page follows back to the standard executor', async () => {
    const flag = await pageVipFlag();
    const tr = recentTraffic(15_000);
    return !flag && tr.std > 0 && tr.vip === 0 ? { flag, tr } : null;
  }, 2.5 * MIN, 5_000).catch(() => null);
  let reloadNeeded = false;
  if (followed) ev('e', `the page followed back by itself (no reload): vs.vip.moved cleared, last 15 s ${followed.tr.std} requests to standard, 0 to VIP`);
  else {
    reloadNeeded = true;
    const tr = recentTraffic(30_000);
    partial('e', `the page did not follow back within 2.5 min (vs.vip.moved ${await pageVipFlag()}, last 30 s: std ${tr.std}, vip ${tr.vip} requests); reloading`);
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(8_000);
    const tr2 = recentTraffic(8_000);
    ev('e', `after reload: vs.vip.moved ${await pageVipFlag()}, std ${tr2.std}, vip ${tr2.vip} requests`);
  }
  results.e!.evidence.push(`reload needed: ${reloadNeeded}`);
  ev('e', `page session keys (names, expiry; no tokens): ${JSON.stringify(await sessionKeys())}`);
  ev('e', `page executor calls refused so far: ${refused.slice(-12).join(' | ') || 'none'}`);
  await ui.until(p, async () => (await headState()).includes('Running'), 'the bot page says Running after the move back', 45_000).catch(() => partial('e', 'bot page not Running within 45 s'));
  ev('e', `bot page header: ${await headState()}`);
  await shot('e-bot-back-on-standard');
  const o = await waitFor('quotes on SoDEX after the move back', async () => {
    const x = await botOrders();
    return x.length ? x : null;
  }, 90_000).catch(() => null);
  if (o) ev('e', `SoDEX quotes after the move back: ${fmtOrders(o)}`);
  else fail('e', 'no quote on SoDEX within 90 s of the move back');
  const notices = await stdClient.notices(50).catch(() => []);
  const vb = notices.find((n) => n.kind === 'vip-back');
  if (vb) ev('e', `notice ${vb.id}: "${vb.title}"`);
  else fail('e', `no vip-back notice on the standard executor (${notices.map((n) => n.kind).join(',') || 'none'})`);
  const vs = await internalStats(vipBase);
  ev('e', `VIP internal stats vipMoves ${JSON.stringify(vs?.vipMoves)}, liveBots ${vs?.liveBots}`);
  return void reloadNeeded;
}

async function stepF(): Promise<void> {
  const p = P();
  await p.goto(`${WEB_ORIGIN}/bots/${botId}`, { waitUntil: 'domcontentloaded' });
  // After the move back the page may have lost its sign-in to the standard executor: Sign in, as a person does.
  const gate = p.getByText('Sign in to see this bot');
  await ui.until(p, async () => (await headState()).length > 0 || (await gate.isVisible().catch(() => false)), 'the bot page', 30_000);
  if (await gate.isVisible().catch(() => false)) {
    await shot('f-signed-out');
    const mark = wallet!.mark();
    fail('e', `after the move back the bot page says "Sign in to see this bot" (signed out of the standard executor); session keys ${JSON.stringify(await sessionKeys())}; refused calls: ${refused.slice(-12).join(' | ') || 'none'}`);
    await p.locator('.bots-empty, main').getByRole('button', { name: 'Sign in', exact: true }).first().click();
    await ui.until(p, async () => (await headState()).length > 0, 'the bot page after signing in', 30_000);
    ev('f', `signed in again from the bot page: wallet signatures ${JSON.stringify(signed(mark))}`);
  }
  const head = p.locator('.bots-head');
  await head.getByRole('button', { name: /^Stop$/ }).click();
  const ways = p.getByRole('menu', { name: 'Stop' });
  await ways.getByRole('menuitem', { name: /Clean stop/ }).waitFor({ state: 'visible', timeout: 10_000 });
  await shot('f-stop-menu');
  await ways.getByRole('menuitem', { name: /Clean stop/ }).click();
  const confirm = p.getByRole('dialog', { name: /Stop|Clean/ });
  if (await confirm.isVisible().catch(() => false)) {
    const btn = confirm.getByRole('button', { name: /Stop|Clean/ }).last();
    await btn.click().catch(() => undefined);
  }
  await ui.until(p, async () => /Stopped|Closing/.test(await headState()), 'stopped or closing', 60_000);
  ev('f', `after Clean stop: ${await headState()}`);
  await ui.until(p, async () => /Stopped/.test(await headState()), 'stopped (closed)', 3 * MIN).catch(() => partial('f', `still "${'closing'}" after 3 min`));
  botStopped = /Stopped/.test(await headState());
  ev('f', `bot page header: ${await headState()}`);
  await shot('f-stopped');
  const v = await algoOn(stdClient).catch(() => null);
  ev('f', `standard executor: ${v?.algo.status} (${v?.algo.statusReason ?? '-'}), book volume $${v?.bot?.volume?.toFixed(2)}, net $${v?.bot?.netPnl?.toFixed(4)}, fills ${v?.bot?.fills}`);
  const flat = await waitFor('nothing resting and flat on SoDEX', async () => {
    const [o, pos] = await Promise.all([reads.openOrders(follower.address, SYMBOL), reads.position(follower.address, SYMBOL)]);
    return o.length === 0 && pos === 0 ? { o, pos } : null;
  }, 90_000).catch(async () => {
    const [o, pos] = await Promise.all([reads.openOrders(follower.address, SYMBOL), reads.position(follower.address, SYMBOL)]);
    fail('f', `on SoDEX after the stop: ${o.length} open order(s) (${fmtOrders(o)}), position ${pos}`);
    return null;
  });
  if (flat) ev('f', 'SoDEX: no open order on BTC-USD, position 0');
}

/* ------------------------------------------------------------------ cleanup ----- */

async function cleanupMoney(why: string): Promise<boolean> {
  log(`cleanup (${why}): kill switches, then the harness's flatten on ${SYMBOL}`);
  for (const [name, c, proc] of [['standard', stdClient, std], ['VIP', vipClient, vip]] as const) {
    if (!c || !proc.running) continue;
    try {
      const left = await c.algoAct('cancel-all');
      log(`  ${name} kill switch: ${left.filter((x) => x.algo.status === 'running' || x.algo.status === 'paused').length} still running`);
    } catch (e) {
      log(`  ${name} kill switch failed: ${String(e).slice(0, 120)}`);
    }
  }
  await sleep(3_000);
  const r = await flatten([follower], [SYMBOL]);
  for (const l of r.lines) log(`  flatten: ${l}`);
  log(`  flatten ${r.ok ? 'ok: flat, nothing resting' : `NOT FLAT: ${JSON.stringify(r.left)}`} (${r.rounds} round(s))`);
  return r.ok;
}

async function shutdown(): Promise<void> {
  await browser?.close().catch(() => undefined);
  await web.kill();
  await std.kill();
  await vip.kill();
  await stub.stop();
}

/* ------------------------------------------------------------------ run ----- */

async function main(): Promise<number> {
  log(`bots-ui-vip live test ${STAMP}; screenshots and logs in ${SHOTS}`);
  log(`follower ${follower.address} (from ${ENV_FILE.replace(/\\/g, '/').split('/').slice(-4).join('/')}, key not shown)`);
  if (!(await follower.load())) throw new Error('the follower has no SoDEX account');
  const eq = await reads.equity(follower.address);
  equityStart = eq.equity;
  log(`follower equity $${eq.equity.toFixed(4)} (available $${eq.available.toFixed(4)})`);
  const [o0, p0] = await Promise.all([reads.openOrders(follower.address, SYMBOL), reads.position(follower.address, SYMBOL)]);
  if ((o0.length || p0) && !ADOPT) throw new Error(`${SYMBOL} holds ${o0.length} order(s) and position ${p0} already: not this run's; pass --adopt to flatten them first`);
  // The harness's own key on the follower, for the cleanup (one day; replaces an older vd-livetest-ops).
  await follower.ownKey('vd-livetest-ops');
  log('harness key vd-livetest-ops registered on the follower (cleanup only)');
  if (o0.length || p0) await cleanupMoney('--adopt');

  let ok = true;
  const steps: Array<[string, () => Promise<unknown>]> = [['a', stepA], ['b', stepB], ['c', stepC], ['d', stepD], ['e', stepE], ['f', stepF]];
  try {
    await bootProcesses();
    await openBrowser();
    for (const [id, fn] of steps) {
      if (SKIP.has(id)) {
        log(`\n=== step ${id}: skipped (--skip) ===`);
        results[id] = { status: 'skip', evidence: ['--skip'] };
        continue;
      }
      log(`\n=== step ${id} ===`);
      results[id] ??= { status: 'pass', evidence: [] };
      try {
        await fn();
      } catch (e) {
        ok = false;
        fail(id, `${e instanceof Error ? e.message : String(e)}`.slice(0, 600));
        await shot(`${id}-error`);
        // Without a running bot nothing later can be checked; with one, d and e depend on the step before.
        break;
      }
      writeResults();
      if (STOP_AFTER === id) {
        log(`--stop-after ${id}: stopping here`);
        break;
      }
    }
  } catch (e) {
    ok = false;
    log(`RUN ERROR: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  } finally {
    const flat = await cleanupMoney(botStopped ? 'final check' : 'the bot was not stopped through the page').catch((e) => {
      log(`cleanup error: ${String(e)}`);
      return false;
    });
    (results.f ??= { status: botStopped ? 'pass' : 'skip', evidence: [] }).evidence.push(`harness flatten at the end: ${flat ? 'flat, nothing resting' : 'NOT FLAT'}`);
    if (!flat) ok = false;
    // What it cost, from SoDEX's own fills and the account's equity.
    try {
      const fills = await reads.allFills(follower.address, SYMBOL, startedAt);
      const fees = fills.reduce((a, f) => a + f.fee, 0);
      const builder = fills.reduce((a, f) => a + f.builderFee, 0);
      const vol = fills.reduce((a, f) => a + f.qty * f.price, 0);
      const eq1 = (await reads.equity(follower.address)).equity;
      log(`spent: equity $${equityStart.toFixed(4)} -> $${eq1.toFixed(4)} (${(eq1 - equityStart).toFixed(4)}); ${fills.length} fills, volume $${vol.toFixed(2)}, fees $${fees.toFixed(5)} of which builder $${builder.toFixed(6)}`);
      writeResults({ spent: { equityStart, equityEnd: eq1, fills: fills.length, volume: vol, fees, builder, fillList: fills } });
    } catch (e) {
      log(`spend read failed: ${String(e)}`);
      writeResults();
    }
    if (wallet) log(`wallet log: ${wallet.log.map((r) => `${r.kind ?? r.method}:${r.outcome}`).join(', ')}`);
    await shutdown();
  }
  log('\nRESULTS');
  for (const [k, r] of Object.entries(results)) log(`  ${k}  ${r.status.toUpperCase()}  ${r.evidence.length} line(s)`);
  for (const s of surprises) log(`  surprise: ${s}`);
  log(`results.json in ${SHOTS}`);
  return ok && Object.values(results).every((r) => r.status !== 'fail') ? 0 : 1;
}

// Ctrl+C: the cleanup runs (kill switches, flatten), then exit.
let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(130);
  stopping = true;
  log('Ctrl+C: cleaning up (again to exit at once)');
  void cleanupMoney('Ctrl+C').finally(() => shutdown().finally(() => process.exit(130)));
});
setInterval(() => undefined, 60_000);
main().then(
  (code) => {
    logStream.end();
    setTimeout(() => process.exit(code), 300);
  },
  async (e) => {
    log(`FATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    await cleanupMoney('fatal').catch(() => undefined);
    await shutdown().catch(() => undefined);
    process.exit(1);
  },
);
