/**
 * EVERYTHING, ONE COMMAND: the live suite on every target one after another,
 * each part in its own child process (run.ts), so one part's crash never stops
 * the others. See README.md "Start here".
 *
 *   START-LIVE-TESTS.cmd (this folder; double-click), or from the repository folder:
 *   npm run live-tests                       the real run (resumes where it stopped)
 *   npm run live-tests -- --dry              everything on paper
 *   node --import tsx apps/executor/tools/live-test/all.ts --status    the progress, from a second window
 *
 * ORDER. Preflight first, a checklist that never prints a secret: the env
 * file's names (set or empty), the country and the terms, the wallets' accounts
 * and balances against what each part costs (budget.ts, as run.ts costs it),
 * ValueDesk's executor's /info, the dev web. A part whose precondition fails is
 * skipped with why; the others run. Then the parts (allParts.ts planParts):
 * self with the first leader, self with a further one (the copy scenarios
 * only), hosted, browser - a target whose last run may have left orders or
 * positions first, since its start-up cleanup flattens them. A part whose child
 * crashed (it ended without its results) is started again, at most twice more:
 * it resumes, and flattens first. At the end one summary per part, on screen
 * and in .state/report-<time>.md.
 *
 * LIVE PROGRESS. A line per scenario ("[self] twap.exits ... passed 41 s" and
 * the part's tally), .state/progress.json after every scenario (for a second
 * window: --status), the child's whole output in .state/<part>-<time>.log.
 *
 * CTRL+C once: the console's Ctrl+C reaches the running runner itself, which
 * abandons its scenario, cleans up and exits; no further part starts; the
 * summary is written. Twice: everything exits at once (the next start flattens).
 */
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hexToBytes, privateKeyToAddress } from '../../../../packages/sodex-core/src/index.ts';
import { COPY_FEE_MAX, COPY_TERMS_VERSION, regionPolicy, type ExecutorInfo, type MarketInfo } from '../../../../packages/copy-engine/src/index.ts';
import { egress } from '../../src/net.ts';
import {
  DRIVER_HELP,
  PartProgress,
  Screen,
  applyPreflight,
  childStarter,
  defaultLeaders,
  envStates,
  formatSummary,
  noFacts,
  parseDriverArgs,
  partLabel,
  planParts,
  progressOf,
  readEnvText,
  reportMarkdown,
  runFailed,
  runPart,
  showEvent,
  statusText,
  totalFees,
  type DriverArgs,
  type Part,
  type PreflightFacts,
  type ProgressFile,
} from './allParts.ts';
import { devWebFor } from './browserDriver.ts';
import { computeBudget, halfSpreadFrac, pickMarket, type LeaderCosts } from './budget.ts';
import { SodexReads } from './exchange.ts';
import { HL_MIN_ORDER_USD, HL_TAKER_FEE, HyperliquidInfo, hlCoinOf } from './hyperliquid.ts';
import { LEADER_VENUES, leaderKeyName, leaderVenueOf, type LeaderVenueName } from './leader.ts';
import { leaderSkip, type Scenario } from './scenario.ts';
import { exposedOn, stateFileOf, type Mode } from './state.ts';
import { HOSTED_BASE, TARGETS, cannotRun } from './target.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const STATE_DIR = join(HERE, '.state');
const RUN_TS = join(HERE, 'run.ts');
const PROGRESS = join(STATE_DIR, 'progress.json');
const CANDIDATES = ['BTC-USD', 'ETH-USD'];

const out = (s: string) => process.stdout.write(s);
const rel = (p: string) => relative(REPO, p) || p;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s*\n\s*/g, ' ');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const usd = (x: number) => `$${x.toFixed(2)}`;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Written whole and renamed over the old one; OneDrive and scanners hold files for a moment, so a refused rename is tried again. Never fatal. */
function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    for (let i = 0; ; i++) {
      try {
        renameSync(tmp, file);
        return;
      } catch (e) {
        if (i >= 10) throw e;
        const until = Date.now() + 30 * (i + 1);
        while (Date.now() < until) {
          /* a short wait */
        }
      }
    }
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
  }
}

function readProgress(): ProgressFile | null {
  try {
    return existsSync(PROGRESS) ? (JSON.parse(readFileSync(PROGRESS, 'utf8')) as ProgressFile) : null;
  } catch {
    return null;
  }
}

/** A private key's address, or null (empty, or not 64 hex characters). The key stays in this function. */
function addressOf(v: string | undefined): string | null {
  const h = (v ?? '').trim().replace(/^0x/i, '');
  return /^[0-9a-fA-F]{64}$/.test(h) ? privateKeyToAddress(hexToBytes(`0x${h}`)).toLowerCase() : null;
}

/** The dev web's builder and live-algo wallets, as its env files set them (Vite reads them at its start: restart it after a change). */
function webEnv(): { builder: boolean; liveWallets: string[] } {
  const merged: Record<string, string> = {};
  for (const f of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    const p = join(REPO, 'apps', 'web', f);
    try {
      if (existsSync(p)) Object.assign(merged, readEnvText(readFileSync(p, 'utf8')));
    } catch {
      /* unreadable: as not there */
    }
  }
  const liveWallets = (merged.VITE_LIVE_ALGOS_WALLETS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { builder: !!merged.VITE_BUILDER_ID?.trim(), liveWallets };
}

/** The runner's arguments for a part. */
function runnerArgs(p: Part, a: DriverArgs, tsx: string): string[] {
  return [
    '--import',
    tsx,
    RUN_TS,
    '--target',
    p.target,
    ...(a.dry ? ['--dry'] : []),
    ...(p.only ? ['--only', p.only.join(',')] : []),
    ...(a.slow ? ['--slow'] : []),
    ...(a.force ? ['--force'] : []),
    ...(a.envFile ? ['--env', resolve(a.envFile)] : []),
    ...(p.target === 'browser' && a.web ? ['--web', a.web] : []),
    ...(p.target === 'browser' && a.headed ? ['--headed'] : []),
  ];
}

/* ---------------------------------------------------------------- preflight ----- */

interface Preflight {
  facts: PreflightFacts;
  lines: string[];
  follower: string | null;
}

/**
 * The checklist and what it means for the parts. Read-only: SoDEX's market list, book and the
 * wallets' account states, Hyperliquid's account value, ValueDesk's executor's /info, the dev web.
 * Each check that fails only takes the parts that need it.
 */
async function preflight(parts: readonly Part[], o: { mode: Mode; env: Record<string, string>; envFile: string; envFound: boolean; states: ReturnType<typeof envStates>; catalogue: readonly Scenario[] | null; web: string | null }): Promise<Preflight> {
  const f = noFacts();
  const lines: string[] = [];
  const ok = (good: boolean | null, s: string) => lines.push(`  ${good === null ? '[--]' : good ? '[ok]' : '[!!]'} ${s}`);
  const live = o.mode === 'live';
  const runs = (t: string) => parts.some((p) => p.target === t && !p.skip);

  lines.push(`env file ${rel(o.envFile)}${o.envFound ? '' : ' - not found'} (names only, never a value)`);
  const required = new Set(['LIVE_FOLLOWER_KEY', 'LIVE_COUNTRY', 'LIVE_ACCEPT_TERMS']);
  for (const s of o.states) {
    const note = s.name === 'LIVE_LEADER_VENUE' ? ' (each part sets it)' : s.from === 'environment' ? ' (from this window\'s environment)' : '';
    ok(!live || s.name === 'LIVE_LEADER_VENUE' ? null : s.state === 'set' ? true : required.has(s.name) ? false : null, `${s.name.padEnd(19)} ${s.state}${note}`);
  }
  if (!live) ok(null, 'dry run: throwaway wallets, no funds; a live run needs LIVE_FOLLOWER_KEY, LIVE_COUNTRY, LIVE_ACCEPT_TERMS, and a leader key for the copy scenarios');

  let follower: string | null = null;
  let country = '';
  if (live) {
    if (!o.envFound) f.all = `there is no env file ${rel(o.envFile)}: copy .env.example to .env.live in that folder and fill it in (README "Start here")`;
    follower = addressOf(o.env.LIVE_FOLLOWER_KEY);
    if (!follower) f.all ??= `LIVE_FOLLOWER_KEY must be the follower wallet's private key (64 hex characters) in ${rel(o.envFile)}`;
    const accepted = (o.env.LIVE_ACCEPT_TERMS ?? '').trim() === COPY_TERMS_VERSION;
    ok(accepted, `copy terms ${COPY_TERMS_VERSION} ${accepted ? 'accepted (LIVE_ACCEPT_TERMS)' : 'not accepted: LIVE_ACCEPT_TERMS must name this version'}`);
    if (!accepted) f.all ??= `LIVE_ACCEPT_TERMS is not ${COPY_TERMS_VERSION}: read the copy terms (ValueDesk -> Copy -> terms, or apps/web/src/legal/copyTerms.ts) and set LIVE_ACCEPT_TERMS=${COPY_TERMS_VERSION}`;
    country = (o.env.LIVE_COUNTRY ?? '').trim().toUpperCase();
    const policy = regionPolicy(country || null, null);
    ok(policy.allowed, `country ${country || '(none)'}: ${policy.allowed ? `${policy.region}${policy.maxLeverage ? `, ${policy.maxLeverage}x cap` : ''}` : policy.reason}`);
    if (!policy.allowed) f.all ??= `LIVE_COUNTRY=${country || '(empty)'}: ${policy.reason ?? 'copying is not allowed there'}`;

    // One target at a time per wallet: a target whose last run may have left orders or positions runs first (its start-up cleanup flattens).
    if (follower) {
      for (const t of TARGETS) {
        const why = exposedOn(stateFileOf(STATE_DIR, 'live', t), follower);
        if (why) {
          f.exposed[t] = why;
          ok(false, `the last ${t} run ${why}: ${runs(t) ? 'its part goes first, its start-up cleanup flattens them' : `run --targets ${t} first (its start-up cleanup flattens them); the other targets refuse until then`}`);
        }
      }
    }

    // The wallets on their venues, and what each part costs (as run.ts costs it: budget.ts).
    const reads = new SodexReads(egress(null).fetch);
    let market: { main: MarketInfo; book: { bid: number; ask: number }; U: number } | null = null;
    const equity: Partial<Record<'follower' | LeaderVenueName, number>> = {};
    try {
      const all = await reads.markets();
      const cands: Array<{ m: MarketInfo; book: { bid: number; ask: number } }> = [];
      for (const s of CANDIDATES) {
        const m = all.find((x) => x.name === s);
        if (m) cands.push({ m, book: await reads.quote(s) });
      }
      const pick = pickMarket(cands);
      market = { main: pick.m, book: pick.book, U: Math.ceil(pick.m.minNotional * 1.2) };
      if (follower) {
        const id = await reads.accountId(follower);
        if (!id) f.all ??= `the follower ${follower} has no SoDEX account: deposit USDC on SoDEX first (see --budget for how much)`;
        else equity.follower = (await reads.equity(follower)).equity;
        ok(!!id, `follower ${follower} on SoDEX: ${id ? `account ${id}, equity ${usd(equity.follower ?? 0)}` : 'no account'}`);
      }
    } catch (e) {
      f.all ??= `SoDEX could not be read (${msg(e)}): run again later`;
      ok(false, `SoDEX could not be read: ${msg(e)}`);
    }
    const hl = new HyperliquidInfo(egress(null).fetch);
    let hlCosts: LeaderCosts | undefined;
    for (const v of LEADER_VENUES) {
      const name = leaderKeyName(v);
      const keySet = !!o.env[name]?.trim();
      const entry: { keySet: boolean; problem: string | null } = { keySet, problem: null };
      f.leader[v] = entry;
      if (!keySet || !parts.some((p) => p.leader === v && !p.skip)) continue;
      const address = addressOf(o.env[name]);
      if (!address) entry.problem = `${name} is not a private key (64 hex characters)`;
      else if (address === follower) entry.problem = `${name} and LIVE_FOLLOWER_KEY are the same wallet: the leader must be a second wallet`;
      else {
        try {
          if (v === 'sodex') {
            const id = await reads.accountId(address);
            if (!id) entry.problem = `the leader ${address} has no SoDEX account: deposit USDC on SoDEX first`;
            else equity.sodex = (await reads.equity(address)).equity;
            ok(!!id, `leader ${address} on SoDEX: ${id ? `account ${id}, equity ${usd(equity.sodex ?? 0)}` : 'no account'}`);
          } else {
            equity.hyperliquid = (await hl.state(address)).accountValue;
            ok(true, `leader ${address} on Hyperliquid: perps account value ${usd(equity.hyperliquid)}`);
            if (market) {
              const book = await hl.book(hlCoinOf(market.main.name)).catch(() => null);
              hlCosts = { venue: 'hyperliquid', market: hlCoinOf(market.main.name), takerFee: HL_TAKER_FEE, halfSpread: book ? halfSpreadFrac(book) : null, minOrderUsd: HL_MIN_ORDER_USD };
            }
          }
        } catch (e) {
          entry.problem = `the leader on ${v === 'sodex' ? 'SoDEX' : 'Hyperliquid'} could not be read (${msg(e)}): run again later`;
        }
      }
      if (entry.problem) ok(false, entry.problem);
    }
    if (market && o.catalogue) {
      for (const p of parts) {
        if (p.skip || !p.scope) continue;
        const keySet = !!f.leader[p.leader]?.keySet;
        const list = o.catalogue.filter((s) => p.scope!.includes(s.id) && (!s.leader || keySet) && !cannotRun(s, p.target) && !leaderSkip(s, p.leader));
        const b = computeBudget(list, { main: market.main, book: market.book, U: market.U, builderRate: COPY_FEE_MAX / 100_000, leverage: 2, leader: p.leader === 'hyperliquid' ? hlCosts : undefined });
        const needF = b.total.peakMarginUsd + b.total.spentUsd;
        const needL = b.total.leaderPeakMarginUsd + b.total.leaderUsd;
        const short: string[] = [];
        if (equity.follower !== undefined && equity.follower < needF) short.push(`the follower holds ${usd(equity.follower)} on SoDEX and this part needs about ${usd(needF)} (deposit at least ${usd(b.total.depositFollowerUsd)})`);
        const le = equity[p.leader];
        if (keySet && le !== undefined && le < needL) short.push(`the leader holds ${usd(le)} on ${b.leaderWhere} and this part needs about ${usd(needL)} (deposit at least ${usd(b.total.depositLeaderUsd)})`);
        if (short.length) f.funds[p.id] = `${short.join('; ')} - see --budget`;
        ok(!short.length, `${p.id}: spends about ${usd(b.total.spentUsd)}, needs about ${usd(needF)} on the follower${keySet && needL > 0 ? ` and ${usd(needL)} on the leader (${b.leaderWhere})` : ''}${short.length ? `: ${short.join('; ')}` : ''}`);
      }
    }
  }

  // ValueDesk's executor, through the site (read-only: its /info).
  if (runs('hosted')) {
    try {
      const r = await fetch(`${HOSTED_BASE}/info`, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const i = (await r.json()) as ExecutorInfo;
      if (i.kind !== 'hosted' || i.network !== 'mainnet') f.target.hosted = `${HOSTED_BASE} answers as a ${i.kind} executor on ${i.network}, not ValueDesk's executor on mainnet`;
      ok(!f.target.hosted, `hosted: ${i.executorId} v${i.version} answers at ${HOSTED_BASE}${i.open ? '' : ' - it takes no new followers now: what needs a new copy is inconclusive'}${i.brake ? ` - the operator's brake is on (${i.brake.reason}): what it holds is inconclusive` : ''}${i.viewerCountry ? `, sees you in ${i.viewerCountry}` : ''}`);
      if (live) {
        const policy = regionPolicy(country || null, i.viewerCountry);
        if (!policy.allowed) f.target.hosted ??= `ValueDesk's executor sees you in ${i.viewerCountry ?? '?'}: ${policy.reason ?? 'copying is not allowed there'}`;
        if (i.termsVersion && i.termsVersion !== COPY_TERMS_VERSION) ok(false, `hosted: it names the copy terms ${i.termsVersion}, this checkout ${COPY_TERMS_VERSION}: setup.terms may not pass there`);
        ok(null, 'hosted: whether it lets the follower run real algo orders is unknown until the first algo (neither /info nor /me says it): the owner adds the follower to EXECUTOR_LIVE_ALGOS_WALLETS on server 2, else every algo scenario there is inconclusive');
      } else ok(null, 'hosted: a dry run\'s throwaway wallet accepts the terms on ValueDesk\'s executor, which records them; it sends paper specs only');
    } catch (e) {
      f.target.hosted = `ValueDesk's executor does not answer (${HOSTED_BASE}/info: ${msg(e)}): run again later`;
      ok(false, f.target.hosted);
    }
  }

  // The local dev web, for the browser part: it must answer and serve this checkout (as the runner checks).
  if (runs('browser')) {
    try {
      const origin = await devWebFor(REPO, o.web);
      ok(true, `browser: the dev web ${origin} serves this checkout`);
      if (live) {
        const w = webEnv();
        if (!w.builder) f.target.browser = 'the dev web has no builder: set the builder lines (VITE_BUILDER_ID, VITE_BUILDER_FEE_PERPS, ...) in apps/web/.env.local as deploy/vercel/production.settings has them, then restart the dev web';
        ok(w.builder, `browser: the builder ${w.builder ? 'is set' : 'is not set'} in apps/web/.env*`);
        const lets = !!follower && w.liveWallets.includes(follower);
        ok(lets, `browser: VITE_LIVE_ALGOS_WALLETS ${lets ? 'lists the follower' : 'does not list the follower: every algo scenario of the browser part is inconclusive'} (apps/web/.env.local; restart the dev web after a change)`);
      }
    } catch (e) {
      f.target.browser = msg(e);
      ok(false, `browser: ${f.target.browser}`);
    }
  }
  return { facts: f, lines, follower };
}

/* -------------------------------------------------------------------- main ----- */

async function main(): Promise<number> {
  const parsed = parseDriverArgs(process.argv.slice(2));
  if (parsed === 'help') {
    out(DRIVER_HELP);
    return 0;
  }
  const args = parsed;
  if (args.status) {
    const f = readProgress();
    if (!f) {
      out(`no run has written its progress yet (${rel(PROGRESS)})\n`);
      return 1;
    }
    out(`${statusText(f, Date.now(), pidAlive(f.pid))}\n`);
    return 0;
  }

  const mode: Mode = args.dry ? 'dry' : 'live';
  mkdirSync(STATE_DIR, { recursive: true });
  // Two drivers at once would trade the same wallets: refused while another one runs.
  const other = readProgress();
  if (other && (other.state === 'running' || other.state === 'preflight') && other.pid !== process.pid && pidAlive(other.pid)) {
    out(`Another run is going on (process ${other.pid}, started ${new Date(other.startedAt).toISOString()}): watch it with --status, or stop it first. If none is, delete ${rel(PROGRESS)}.\n`);
    return 2;
  }

  const startedAt = Date.now();
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  const screen = new Screen(out);
  screen.line(`ValueDesk live tests - ${mode === 'dry' ? 'dry run on paper (throwaway wallets, no funds)' : 'LIVE: real orders with real money on SoDEX mainnet'} - ${new Date(startedAt).toISOString()}`);

  let parts: PartProgress[] = [];
  let state: ProgressFile['state'] = 'preflight';
  let report: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  const writeProgress = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    writeJsonAtomic(PROGRESS, progressOf({ pid: process.pid, mode, startedAt, now: Date.now(), state, report, parts }));
  };
  // At most a few writes a second: a resumed part reports dozens of skips at once.
  const progressSoon = () => {
    timer ??= setTimeout(writeProgress, 300);
  };
  writeProgress();

  // Ctrl+C: the console's reaches the running runner itself (it cleans up and exits); nothing is forwarded, a second signal would be its "exit at once".
  let stopping = false;
  let firstStop = 0;
  let child: ChildProcess | null = null;
  let childHeard = false;
  process.on('SIGINT', () => {
    const now = Date.now();
    if (!stopping) {
      stopping = true;
      firstStop = now;
      screen.line('Ctrl+C: the running part cleans up and stops, no further part starts; wait for the summary. (Ctrl+C again exits at once.)');
      // Where the signal reached this process alone (not a console's), it is passed on once - not on Windows, where that would kill the runner before its cleanup.
      setTimeout(() => {
        if (child && !childHeard && process.platform !== 'win32') child.kill('SIGINT');
      }, 2_000).unref();
      return;
    }
    // One Ctrl+C reaching this process twice (passed on by npm or a wrapper) is one.
    if (now - firstStop < 1_000) return;
    screen.line('second Ctrl+C: exiting now. The runner exits at once too; its next start flattens what is left.');
    state = 'stopped';
    writeProgress();
    process.exit(130);
  });

  // The catalogue, for the plan and the budget; a part's runner reads it again itself.
  let catalogue: readonly Scenario[] | null = null;
  let catalogueError: string | undefined;
  try {
    catalogue = (await import('./catalogue.ts')).CATALOGUE;
  } catch (e) {
    catalogueError = msg(e);
  }

  // The env file: values in memory only (an address is made from a key, nothing else); on screen, names.
  const envFile = args.envFile ? resolve(args.envFile) : join(HERE, '.env.live');
  let fileEnv: Record<string, string> | null = null;
  try {
    if (existsSync(envFile)) fileEnv = readEnvText(readFileSync(envFile, 'utf8'));
  } catch {
    fileEnv = null;
  }
  const env: Record<string, string> = { ...(fileEnv ?? {}) };
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('LIVE_') && v !== undefined) env[k] = v;
  let preferred: LeaderVenueName = 'sodex';
  try {
    preferred = leaderVenueOf(env.LIVE_LEADER_VENUE);
  } catch {
    /* each part sets LIVE_LEADER_VENUE itself */
  }
  const leaders = args.leaders ?? defaultLeaders({ sodex: !!env.LIVE_LEADER_KEY?.trim(), hyperliquid: !!env.LIVE_HL_LEADER_KEY?.trim() }, preferred);

  const planned = planParts({ targets: args.targets, leaders, only: args.only, slow: args.slow, catalogue, catalogueError });
  screen.line('\npreflight');
  if (catalogueError) screen.line(`  [!!] the catalogue could not be read: ${catalogueError}`);
  let pf: Preflight;
  try {
    pf = await preflight(planned, { mode, env, envFile, envFound: fileEnv !== null, states: envStates(fileEnv, process.env), catalogue, web: args.web });
  } catch (e) {
    pf = { facts: { ...noFacts(), all: `the preflight failed: ${msg(e)}` }, lines: [`  [!!] the preflight failed: ${msg(e)}`], follower: null };
  }
  for (const l of pf.lines) screen.line(l);
  const plan = applyPreflight(planned, pf.facts, mode);
  parts = plan.map((p) => new PartProgress(p));

  screen.line('\nplan');
  plan.forEach((p, i) => screen.line(`  ${i + 1}. ${p.id.padEnd(8)} ${partLabel(p)}${p.scope ? `: ${p.scope.length} scenarios` : ''}${p.skip ? `\n       SKIPPED: ${p.skip}` : ''}`));
  screen.line(`\nprogress ${rel(PROGRESS)} (another window: node --import tsx apps/executor/tools/live-test/all.ts --status); each part's whole output in ${join(rel(STATE_DIR), `<part>-${stamp}.log`)}`);
  state = 'running';
  writeProgress();

  const runnable = parts.filter((p) => p.status !== 'skipped');
  if (mode === 'live' && runnable.length && process.stdout.isTTY && !args.yes && !stopping) {
    screen.line('\nThe real-money run starts in 10 s. Ctrl+C now stops it before anything is signed.');
    for (let i = 0; i < 10 && !stopping; i++) await sleep(1_000);
  }

  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  let blockRest: string | null = null;
  for (const p of parts) {
    if (p.status === 'skipped') continue;
    if (stopping) {
      p.notStarted('not started: stopped by Ctrl+C');
      continue;
    }
    if (blockRest) {
      p.notStarted(blockRest);
      continue;
    }
    screen.line('');
    const logFile = join(STATE_DIR, `${p.part.id}-${stamp}.log`);
    p.log = rel(logFile);
    const skipped = { passed: 0, skipped: 0 };
    try {
      await runPart(p, {
        start: childStarter({
          command: process.execPath,
          args: runnerArgs(p.part, args, tsx),
          cwd: REPO,
          // The part's leader venue; everything else of LIVE_ the runner reads from the env file (and this environment) itself.
          env: { ...process.env, LIVE_LEADER_VENUE: p.part.leader },
          logFile,
          label: p.part.id,
          onChild: (c) => {
            child = c;
            childHeard = false;
          },
        }),
        stopping: () => stopping,
        onEvent: (e) => {
          if (e.kind === 'line' && e.line.kind === 'ctrl-c') childHeard = true;
          showEvent(screen, p, e, { logPath: p.log!, skipped, now: Date.now() });
          progressSoon();
        },
      });
    } catch (e) {
      // The driver's own fault: the part is recorded, the next one runs.
      p.endAttempt({ kind: 'crashed', code: null, signal: null, error: `the driver: ${msg(e)}`, startedAny: false }, true, Date.now());
      screen.line(`[${p.part.id}] ! the driver failed on this part: ${msg(e)}`);
    }
    writeProgress();
    // A part that may have left orders or positions on the wallets: the other targets would refuse, so none starts.
    if (mode === 'live' && pf.follower) {
      const why = exposedOn(stateFileOf(STATE_DIR, mode, p.part.target), pf.follower);
      if (why) {
        blockRest = `not started: the ${p.part.id} part ${why}. Run again (its start-up cleanup flattens them), or close them on sodex.com`;
        screen.line(`[${p.part.id}] ! ${why}: no further part starts. Run again - its start-up cleanup flattens first.`);
      }
    }
  }

  const endedAt = Date.now();
  const fees = totalFees(parts);
  screen.line('');
  screen.line(formatSummary(parts, { mode, feesUsd: fees }));
  const reportFile = join(STATE_DIR, `report-${stamp}.md`);
  const stateFiles = [...new Set(plan.map((p) => rel(stateFileOf(STATE_DIR, mode, p.target))))];
  try {
    writeFileSync(reportFile, reportMarkdown(parts, { mode, startedAt, endedAt, feesUsd: fees, preflight: pf.lines, stateFiles, interrupted: stopping }), 'utf8');
    report = rel(reportFile);
    screen.line(`\nreport ${report}`);
  } catch (e) {
    screen.line(`\n! the report could not be written: ${msg(e)}`);
  }
  screen.line(runFailed(parts) ? 'Run it again to resume: only what did not pass on this code runs.' : 'Nothing failed. Run it again after a change: only what the change touches runs.');
  state = stopping ? 'stopped' : 'done';
  writeProgress();
  return runFailed(parts) ? 1 : 0;
}

// Exits once the screen's last lines are out (a pipe may still be writing them).
main().then(
  (code) => process.stdout.write('', () => process.exit(code)),
  (e) => process.stderr.write(`\n${e instanceof Error ? e.message : String(e)}\n`, () => process.exit(1)),
);
