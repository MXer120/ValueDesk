/**
 * The real-money test suite of algo orders and copy trading, on SoDEX mainnet,
 * through a real executor. See README.md in this folder.
 *
 *   npx tsx apps/executor/tools/live-test/run.ts --budget      what it costs; nothing is signed
 *   npx tsx apps/executor/tools/live-test/run.ts --dry         the whole suite on paper (no funds, no keys)
 *   npx tsx apps/executor/tools/live-test/run.ts               the live run (resumes where it stopped)
 *
 * Options: --target self|hosted|browser (default self)  --only <ids,kinds,sections,prefix.*>
 *          --force  --slow  --adopt  --env <file> (default .env.live here)  --keep-data
 *          --web <origin>  --headed (browser target)  --help
 *
 * THE TARGET (target.ts) is the executor the scenarios run against: self, an
 * executor process started here from this checkout (what the suite always
 * did); hosted, ValueDesk's own executor through the site; browser, the web
 * app's runtime in a tab of Microsoft Edge on the local dev web, through the
 * web test bridge (browserDriver.ts) - the dev web must be running already. A
 * scenario that needs what a target cannot do (a hard restart of ValueDesk's
 * executor) is skipped there, with why. Each target keeps its own state file.
 *
 * THE LEADER (leader.ts) trades on SoDEX (default) or on Hyperliquid
 * (LIVE_LEADER_VENUE=hyperliquid, its key LIVE_HL_LEADER_KEY): the copy
 * scenarios follow it there; the few written for a Hyperliquid leader are
 * skipped with a SoDEX one, with why.
 *
 * THE FEE STUB (feeStub.ts, self target only): the executor started here reads
 * the follower's 14-day volume from the runner, $0 (the copy fee ladder's
 * first step) unless a fee scenario sets another; the cleanup sets it back.
 *
 * ORDER OF A RUN. Read SoDEX's market rules and book and pick the cheapest of
 * BTC-USD and ETH-USD; print the budget. (Live:) check the env file, the
 * region (the declared country, and the one the target sees), that no other
 * target's run left the wallets exposed, the wallets' SoDEX accounts and that
 * they hold enough; stop an executor a crashed run left behind; register the
 * harness's own key on each wallet; the START-UP CLEANUP (cleanup.ts) -
 * flatten what a crashed run left, refuse what this runner never sent. Start
 * the target. Then each scenario in catalogue order: skip what passed on this
 * code, mark it running (saved), run it with its timeout, and ALWAYS clean up
 * after it - executor kill switch, every copy stopped and closed, every order
 * cancelled and position closed on SoDEX, read back flat - before the next one
 * starts. A cleanup that cannot read the accounts flat stops the run with the
 * exposure flag set.
 *
 * Ctrl+C once: the running scenario is abandoned, the cleanup runs, the state
 * is saved, the runner exits. Twice: it exits at once; the next start flattens.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, keccak256, utf8 } from '../../../../packages/sodex-core/src/index.ts';
import { COPY_FEE_MAX, COPY_TERMS_VERSION, MarketBook, canonicalJSON, copyFeeFor, regionPolicy, type MarketInfo } from '../../../../packages/copy-engine/src/index.ts';
import { computeBudget, formatBudget, halfSpreadFrac, pickMarket, type LeaderCosts } from './budget.ts';
import { CATALOGUE, countByKind } from './catalogue.ts';
import { flatten, startDecision, type FlattenVenue } from './cleanup.ts';
import { egress } from '../../src/net.ts';
import { SodexReads, SodexWallet } from './exchange.ts';
import { WebBridgeDriver, devWebFor, openWebSession } from './browserDriver.ts';
import { CopyWallet, ExecutorProcess } from './executor.ts';
import { VolumeStub } from './feeStub.ts';
import { CheckFailed, Inconclusive, T, Unavailable, type Env } from './harness.ts';
import { CodeHashes } from './hash.ts';
import { HL_MIN_ORDER_USD, HL_TAKER_FEE, HyperliquidExchange, HyperliquidInfo, hlCoinOf } from './hyperliquid.ts';
import { HyperliquidLeader, SodexLeader, leaderKeyName, leaderVenueOf, type LeaderVenue, type LeaderVenueName } from './leader.ts';
import { leaderSkip, type Scenario } from './scenario.ts';
import { K_COIN } from './scenarios/copy.ts';
import { decide, exposedOn, loadState, markDone, markRunning, noteRun, resultKey, saveState, selected, stateFileOf, type Mode, type RunState } from './state.ts';
import { BrowserTarget, CAPABILITIES, HostedTarget, SelfTarget, TARGETS, cannotRun, targetName, type ExecutorTarget, type TargetName } from './target.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const STATE_DIR = join(HERE, '.state');
const CANDIDATES = ['BTC-USD', 'ETH-USD'];

interface Args {
  dry: boolean;
  budget: boolean;
  force: boolean;
  slow: boolean;
  adopt: boolean;
  keepData: boolean;
  only: string[] | null;
  envFile: string;
  target: TargetName;
  /** The browser target's dev web (else VS_E2E_WEB, else the first local Vite port serving ValueDesk). */
  web: string | null;
  /** The browser target: show Edge. */
  headed: boolean;
}

const HELP = `live-test: algo orders and copy trading with real money on SoDEX mainnet (README.md)

  --budget        print what the suite costs and stop (no keys needed, nothing signed)
  --dry           run every scenario on paper against live data (throwaway wallets, no funds)
  --target <t>    the executor the scenarios run against: self (default: one started here from this
                  checkout), hosted (ValueDesk's executor, through www.valuedesk.so), browser (the web
                  app's runtime in Microsoft Edge on the local dev web, which must be running)
  --web <origin>  browser target: the dev web (default: VS_E2E_WEB, else 127.0.0.1:5180-5183)
  --headed        browser target: show Edge
  --only <list>   comma-separated ids (twap.taker-buy), prefixes (twap.*), kinds (twap) or sections (algo, copy)
  --force         run even what passed on this code
  --slow          include the slow scenarios (vwap.full, copy.tp-fires)
  --adopt         at start, flatten positions/orders on the test markets this runner never recorded sending
  --env <file>    the env file with the keys (default: .env.live in this folder)
  --keep-data     keep the executor's data folder at the end (it holds the executor's sealed key)

  The leader trades on SoDEX unless LIVE_LEADER_VENUE=hyperliquid (env file or environment):
  then on Hyperliquid, with LIVE_HL_LEADER_KEY.
`;

function parseArgs(argv: string[]): Args {
  const a: Args = { dry: false, budget: false, force: false, slow: false, adopt: false, keepData: false, only: null, envFile: join(HERE, '.env.live'), target: 'self', web: null, headed: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (x === '--dry') a.dry = true;
    else if (x === '--budget') a.budget = true;
    else if (x === '--force') a.force = true;
    else if (x === '--slow') a.slow = true;
    else if (x === '--adopt') a.adopt = true;
    else if (x === '--keep-data') a.keepData = true;
    else if (x === '--only') a.only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (x === '--env') a.envFile = resolve(argv[++i] ?? '');
    else if (x === '--target') a.target = targetName(argv[++i]);
    else if (x === '--web') a.web = (argv[++i] ?? '').trim() || null;
    else if (x === '--headed') a.headed = true;
    else if (x === '--help' || x === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else throw new Error(`unknown option ${x} (see --help)`);
  }
  return a;
}

/** KEY=VALUE lines (comments with #, optional quotes). Read into memory only: never into process.env, never into the executor's environment. */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function privateKey(v: string | undefined, name: string): Uint8Array {
  const h = (v ?? '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error(`${name} must be a private key: 64 hex characters (with or without 0x)`);
  return hexToBytes(`0x${h}`);
}

/** keccak256 of the copy terms text as the web app shows it (apps/web/src/copy/terms.ts COPY_TERMS_HASH). */
async function termsHash(): Promise<string> {
  const mod = (await import(pathToFileURL(join(REPO, 'apps', 'web', 'src', 'legal', 'copyTerms.ts')).href)) as { COPY_TERMS: unknown };
  return bytesToHex(keccak256(utf8(canonicalJSON(mod.COPY_TERMS))));
}

const log = (s: string) => process.stdout.write(`${s}\n`);

/** The target this run started: stopped on any way out, so no executor process outlives the runner. */
let started: ExecutorTarget | null = null;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A crashed run's executor still running: stop it, but only if it answers as ours. */
async function stopStale(state: RunState): Promise<void> {
  const e = state.executor;
  if (!e) return;
  if (pidAlive(e.pid)) {
    let ours = false;
    try {
      const r = await fetch(`http://127.0.0.1:${e.port}/api/copy/v1/info`, { signal: AbortSignal.timeout(3_000) });
      ours = r.ok && ((await r.json()) as { executorId?: string }).executorId === e.executorId;
    } catch {
      ours = false;
    }
    if (ours) {
      log(`stopping the executor a previous run left running (pid ${e.pid})`);
      try {
        process.kill(e.pid, 'SIGKILL');
      } catch {
        /* gone meanwhile */
      }
    }
  }
  try {
    rmSync(e.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* kept; harmless */
  }
  state.executor = null;
}

/**
 * The target's executor, its client signed by the follower's wallet. Self: a new data folder every
 * run (nothing of a crashed run is resumed by it), the follower's volume read from the runner's stub.
 * Browser: a tab of Edge on the dev web, whose test wallet holds the follower's key in this process
 * (the page sees addresses and signatures only); a new browser profile every run.
 */
function makeTarget(
  name: TargetName,
  o: { mode: Mode; owner: string; wallet: CopyWallet; stamp: string; feeStub: VolumeStub | null; browser: { web: string; key: Uint8Array; headed: boolean } | null },
): ExecutorTarget {
  if (name === 'hosted') return new HostedTarget(o.wallet, o.mode);
  if (name === 'browser') {
    const b = o.browser!;
    const session = () => openWebSession(REPO, { origin: b.web, privateKey: bytesToHex(b.key), live: o.mode === 'live', headed: b.headed, log: (l) => log(`  ${l}`) });
    return new BrowserTarget(o.mode, new WebBridgeDriver({ mode: o.mode, origin: b.web, follower: o.owner, session, log }));
  }
  const proc = new ExecutorProcess({
    mode: o.mode,
    owner: o.owner,
    dataDir: join(STATE_DIR, `executor-${o.mode}-${o.stamp}`),
    logFile: join(STATE_DIR, `executor-${o.mode}-${o.stamp}.log`),
    executorId: `vd-livetest-${o.mode}`,
    builderVolume: o.feeStub ? { url: o.feeStub.url, token: o.feeStub.token } : null,
  });
  return new SelfTarget(proc, o.wallet, o.mode);
}

/** What the leader pays on its venue, for the budget: Hyperliquid's taker fee and its book now (SoDEX: the main market's, the default). */
async function leaderCostsOf(venue: LeaderVenueName, main: MarketInfo, hl: HyperliquidInfo | null): Promise<LeaderCosts | undefined> {
  if (venue !== 'hyperliquid' || !hl) return undefined;
  const coin = hlCoinOf(main.name);
  const book = await hl.book(coin).catch(() => null);
  return { venue, market: coin, takerFee: HL_TAKER_FEE, halfSpread: book ? halfSpreadFrac(book) : null, minOrderUsd: HL_MIN_ORDER_USD };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const mode: Mode = args.dry ? 'dry' : 'live';
  const caps = CAPABILITIES[args.target];
  const reads = new SodexReads(egress(null).fetch);

  // Markets and the book: the cheapest of the candidates is the main one, the other carries basket legs.
  const all = await reads.markets();
  const cands: Array<{ m: MarketInfo; book: { bid: number; ask: number } }> = [];
  for (const s of CANDIDATES) {
    const m = all.find((x) => x.name === s);
    if (m) cands.push({ m, book: await reads.quote(s) });
  }
  const pick = pickMarket(cands);
  const main = pick.m;
  const second = cands.find((c) => c.m.name !== main.name)?.m ?? main;
  const U = Math.ceil(main.minNotional * 1.2);
  log(`main market ${main.name} (taker + half spread ${pick.costBps.toFixed(2)} bp), second ${second.name}, child order $${U}`);

  const env = { ...readEnvFile(args.envFile), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('LIVE_')) as Array<[string, string]>) };
  // An empty LIVE_COUNTRY= (the env file's template) is none: a dry run then declares SG.
  const country = (env.LIVE_COUNTRY?.trim() || (args.dry ? 'SG' : '')).toUpperCase();
  // Where the leader trades, and its key there (LIVE_LEADER_KEY on SoDEX, LIVE_HL_LEADER_KEY on Hyperliquid).
  const leaderVenue = leaderVenueOf(env.LIVE_LEADER_VENUE);
  const leaderKey = env[leaderKeyName(leaderVenue)]?.trim() || '';
  const hl = leaderVenue === 'hyperliquid' ? new HyperliquidInfo(egress(null).fetch) : null;
  // --budget costs the whole suite, leader included; a live run without a leader key skips the copy scenarios.
  const hasLeader = args.dry || args.budget || !!leaderKey;
  // With a Hyperliquid leader, copy.hl-k-prefix copies kPEPE into SoDEX's thousand-unit market (where SoDEX lists one): the cleanup flattens the follower there too.
  const book = new MarketBook();
  book.load(all);
  const kMarket = leaderVenue === 'hyperliquid' ? book.sodexMarketFor('hyperliquid', K_COIN) : null;
  const testMarkets = [...new Set([main.name, second.name, ...(kMarket ? [kMarket.name] : [])])];

  const list = CATALOGUE.filter((s) => (args.slow || !s.slow) && (s.always || selected(args.only, s)));
  // What the target cannot do (a hard restart of ValueDesk's executor), and what another leader venue is for, are skipped: not costed.
  const lacking = list.filter((s) => cannotRun(s, args.target, caps));
  const otherVenue = list.filter((s) => leaderSkip(s, leaderVenue));
  const budget = computeBudget(list.filter((s) => (!s.leader || hasLeader) && !lacking.includes(s) && !otherVenue.includes(s)), {
    main,
    book: pick.book,
    U,
    builderRate: COPY_FEE_MAX / 100_000,
    builderWhy: caps.localFeeStub
      ? 'the copy ladder\'s top step: the runner\'s stub answers $0 of volume, and the fee scenarios, which walk the ladder, are costed at the top step too'
      : args.target === 'browser'
        ? 'the copy ladder\'s top step: a browser charges it on copies, and the dev web builder\'s trading fee on an algo\'s children'
        : 'the copy ladder\'s top step, the most it charges: ValueDesk\'s executor charges the step of the follower\'s 14-day volume',
    leverage: 2,
    leader: await leaderCostsOf(leaderVenue, main, hl),
  });
  log('');
  log(formatBudget(budget));
  log('');
  for (const c of countByKind(list)) log(`  ${c.section.padEnd(6)} ${c.kind.padEnd(12)} ${c.n}`);
  log(`  ${list.length} scenarios selected${args.slow ? '' : ' (slow ones left out; --slow adds them)'}, target ${args.target}, leader on ${leaderVenue === 'hyperliquid' ? 'Hyperliquid' : 'SoDEX'}`);
  for (const s of lacking) log(`  - ${s.id} is skipped on this target: ${cannotRun(s, args.target, caps)}`);
  for (const s of otherVenue) log(`  - ${s.id} is skipped with this leader: ${leaderSkip(s, leaderVenue)}`);
  if (args.budget) return 0;

  if (caps.paperOnly && !args.dry) throw new Error(`The ${args.target} target runs paper only for now: use --dry.`);
  // The browser target runs in the local dev web, which the runner never starts itself: it must answer, and serve this checkout.
  const web = args.target === 'browser' ? await devWebFor(REPO, args.web) : null;
  if (web) log(`dev web ${web} (this checkout's), in Microsoft Edge${args.headed ? ' (shown)' : ''}`);
  if (!args.dry && env.LIVE_ACCEPT_TERMS !== COPY_TERMS_VERSION) {
    throw new Error(`The runner signs the copy terms ${COPY_TERMS_VERSION} in your name. Read them (ValueDesk -> Copy -> terms, or apps/web/src/legal/copyTerms.ts) and set LIVE_ACCEPT_TERMS=${COPY_TERMS_VERSION} in ${args.envFile}.`);
  }

  // Wallets: live, the owner's two; dry, throwaway keys that never touch SoDEX or Hyperliquid.
  const fpk = args.dry ? secp256k1.utils.randomPrivateKey() : privateKey(env.LIVE_FOLLOWER_KEY, 'LIVE_FOLLOWER_KEY');
  const lpk = args.dry ? secp256k1.utils.randomPrivateKey() : leaderKey ? privateKey(leaderKey, leaderKeyName(leaderVenue)) : null;
  const followerW = args.dry ? null : new SodexWallet('follower', fpk, reads);
  const leader: LeaderVenue | null =
    args.dry || !lpk ? null : leaderVenue === 'hyperliquid' ? new HyperliquidLeader(new HyperliquidExchange(lpk, hl!, egress(null).fetch), log) : new SodexLeader(new SodexWallet('leader', lpk, reads));
  const followerAddress = followerW?.address ?? new CopyWallet(fpk).address;
  const leaderAddress = leader?.address ?? (lpk ? new CopyWallet(lpk).address : '0x0000000000000000000000000000000000000001');
  if (leader && leader.address === followerAddress) throw new Error(`${leaderKeyName(leaderVenue)} and LIVE_FOLLOWER_KEY are the same wallet: the leader must be a second wallet`);

  // Self: the executor reads the follower's volume (its copy fee step) from the runner's own stub.
  const feeStub = caps.localFeeStub ? new VolumeStub(followerAddress) : null;
  await feeStub?.start();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = makeTarget(args.target, { mode, owner: followerAddress, wallet: new CopyWallet(fpk), stamp, feeStub, browser: web ? { web, key: fpk, headed: args.headed } : null });
  started = target;

  // The region rule is the stricter of the declared country and the one the target sees the requests come from (ValueDesk's: its edge's).
  const observed = await target.observedCountry();
  const policy = regionPolicy(country || null, observed);
  if (!policy.allowed && !args.dry) throw new Error(`LIVE_COUNTRY=${country || '(missing)'}${observed ? `, seen from ${observed}` : ''}: ${policy.reason ?? 'copying is not allowed there'}`);

  // One target at a time per wallet: a run on another target that may have left orders or positions on these wallets stops this one.
  if (mode === 'live') {
    for (const other of TARGETS) {
      if (other === args.target) continue;
      const why = exposedOn(stateFileOf(STATE_DIR, mode, other), followerAddress);
      if (why) throw new Error(`The last run on the ${other} target may have left orders or positions on these wallets: ${why}. Run --target ${other} again first (its start-up cleanup flattens them), or close them on sodex.com and run it once to clear its record.`);
    }
  }

  const stateFile = stateFileOf(STATE_DIR, mode, args.target);
  const { state, report } = loadState(stateFile, mode, Date.now(), args.target);
  if (report.corrupt) log(`! the state file could not be read: ${report.corrupt}; treating the account as exposed`);
  for (const id of report.interrupted) log(`! ${id} was interrupted by a crash: it is failed and runs again; the start-up cleanup flattens first`);
  state.follower = followerAddress;
  await stopStale(state);
  saveState(stateFile, state);
  log(`follower ${followerAddress}${leader || args.dry ? `, leader ${leaderAddress} on ${leaderVenue === 'hyperliquid' ? 'Hyperliquid' : 'SoDEX'}` : ` (no ${leaderKeyName(leaderVenue)}: copy scenarios are skipped)`}, country ${country}${observed && observed !== country ? ` (seen from ${observed})` : ''} (${policy.region}${policy.maxLeverage ? `, ${policy.maxLeverage}x cap` : ''}), mode ${mode}, target ${target.name}`);

  const venues: FlattenVenue[] = [];
  const holds = (name: string, where: string, account: string, equity: number, need: number, deposit: number) => {
    log(`${name} on ${where}: ${account}, equity $${equity.toFixed(2)} (the suite needs about $${need.toFixed(2)}; at least $${deposit.toFixed(0)} recommended)`);
    if (equity < need) throw new Error(`${name} holds $${equity.toFixed(2)} on ${where}; the suite needs about $${need.toFixed(2)}. Deposit more (see --budget).`);
  };
  if (followerW) {
    if (!(await followerW.load())) throw new Error(`follower ${followerW.address} has no SoDEX account: deposit USDC on SoDEX first`);
    holds('follower', 'SoDEX', `account ${followerW.accountId}`, (await reads.equity(followerW.address)).equity, budget.total.peakMarginUsd + budget.total.spentUsd, budget.total.depositFollowerUsd);
    // The harness's own key on the wallet, for the cleanup (one day; re-made every run).
    await followerW.ownKey('vd-livetest-ops');
    venues.push(followerW);
    if (leader) {
      const pf = await leader.preflight();
      holds('leader', leader.where, pf.account, pf.equity, budget.total.leaderPeakMarginUsd + budget.total.leaderUsd, budget.total.depositLeaderUsd);
      // SoDEX: the harness's own key on it, for its trades and the cleanup. Hyperliquid: its master key signs.
      await leader.prepare();
      venues.push(leader);
    }
    // START-UP CLEANUP.
    let orders = 0;
    let positions = 0;
    for (const v of venues) for (const s of v.markets ? await v.markets(testMarkets) : testMarkets) {
      orders += (await v.openOrders(s)).length;
      positions += (await v.position(s)) !== 0 ? 1 : 0;
    }
    const d = startDecision(state.exposure, { orders, positions }, args.adopt);
    if (d === 'refuse') {
      throw new Error(`The test markets hold ${positions} position(s) and ${orders} order(s) this runner never recorded sending. They may be your own: close them yourself, use dedicated test wallets, or pass --adopt to let the runner close them.`);
    }
    if (d === 'flatten') {
      log(`start-up cleanup: ${state.exposure ? `exposure recorded since ${new Date(state.exposure.since).toISOString()} (${state.exposure.by})` : '--adopt'}: flattening`);
      const r = await flatten(venues, testMarkets);
      for (const l of r.lines) log(`  ${l}`);
      if (!r.ok) throw new Error(`the start-up cleanup could not flatten: ${JSON.stringify(r.left)}. Close these on sodex.com, then run again.`);
      state.exposure = null;
      saveState(stateFile, state);
    }
  }

  // The target: self starts its executor process here; hosted reads ValueDesk's /info and /health; browser opens the page.
  await target.start();
  state.executor = target.processRecord();
  saveState(stateFile, state);
  const info = await target.info();
  log(`executor ${info.executorId} v${info.version} on ${target.where}`);
  if (!info.open) log('! it takes no new followers right now: what needs a new copy is inconclusive');
  if (info.brake) log(`! the operator's brake is on (${[info.brake.copies ? 'copies' : '', info.brake.algos ? 'algos' : ''].filter(Boolean).join(', ')}): ${info.brake.reason}. What it holds is inconclusive.`);
  const ladder = (info.builder?.ladder ?? []).map((s) => s.fee);
  if (feeStub) feeStub.builder = info.builder?.id ?? null;

  const henv: Env = {
    mode,
    reads,
    follower: followerW,
    leader,
    followerAddress,
    leaderAddress,
    leaderVenue,
    hl,
    feeStub,
    target,
    regionMaxLeverage: policy.maxLeverage,
    country,
    termsHash: await termsHash(),
    builderId: info.builder?.id ?? 0,
    builderFee: ladder.length ? Math.max(...ladder) : COPY_FEE_MAX,
    builderLadder: ladder,
    // A local executor reads the runner's stub ($0 but in the fee scenarios): its orders carry the ladder's first step. ValueDesk's reads its own ledger.
    orderFee: caps.localFeeStub && info.builder ? copyFeeFor(null, info.builder.ladder) : null,
    main,
    second,
    childUsd: U,
    timeScale: args.dry ? 0.5 : 1,
    log,
  };

  // Ctrl+C: abandon the scenario, clean up, save. Twice: exit now.
  let interrupts = 0;
  let abandon: ((e: Error) => void) | null = null;
  process.on('SIGINT', () => {
    interrupts += 1;
    if (interrupts > 1) {
      log('\nsecond Ctrl+C: exiting now. The next start flattens what is left.');
      process.exit(130);
    }
    log('\nCtrl+C: stopping after the cleanup of this scenario (Ctrl+C again to exit at once).');
    abandon?.(new Error('stopped by Ctrl+C'));
  });

  const hashes = new CodeHashes(REPO, { name: target.name, release: target.release(info), leader: leaderVenue });
  const tally = { passed: 0, failed: 0, skipped: 0, inconclusive: 0, ran: 0 };
  let stopRun: string | null = null;

  const cleanup = async (): Promise<boolean> => {
    const up = await target.health();
    if (!up.ok && target.capabilities.restart) {
      log('  the executor is not running: starting it again for the cleanup');
      await target.start().catch((e) => log(`  ! could not start it: ${String(e)}`));
    } else if (!up.ok) log(`  ! ${target.where} does not answer (${up.why ?? ''}): its kill switch is tried anyway`);
    // A fee scenario leaves the stub on another step, and the executor holds that answer 10 minutes: back to $0, and a restart forgets it.
    if (feeStub?.reset() && target.capabilities.restart) {
      log('  the volume stub answers $0 again: restarting the executor so it forgets the last answer');
      await target.kill();
      await target.start().catch((e) => log(`  ! could not start it: ${String(e)}`));
    }
    await target.stopEverything();
    if (!venues.length) return true;
    await new Promise((r) => setTimeout(r, 2_000));
    const r = await flatten(venues, testMarkets);
    for (const l of r.lines) log(`    cleanup: ${l}`);
    if (!r.ok) log(`  ! CLEANUP COULD NOT FLATTEN: ${JSON.stringify(r.left)}`);
    return r.ok;
  };

  // Where each result is kept: a copy scenario with a Hyperliquid leader apart from the same one with a SoDEX leader (state.ts resultKey).
  const key = (s: Scenario) => resultKey(s, leaderVenue);
  for (const s of list) {
    if (stopRun || interrupts) break;
    const hash = hashes.scenario(s);
    const d = decide(state, s, hash, { only: args.only, force: args.force, key: key(s) });
    if (!d.run) {
      log(`- ${s.id}: skip (${d.why})`);
      continue;
    }
    const otherLeader = leaderSkip(s, leaderVenue);
    if (otherLeader) {
      markDone(state, key(s), 'skipped', { error: otherLeader });
      tally.skipped += 1;
      log(`- ${s.id}: skipped (${otherLeader})`);
      continue;
    }
    if (s.leader && !hasLeader) {
      markDone(state, key(s), 'skipped', { error: `no ${leaderKeyName(leaderVenue)} in the env file` });
      tally.skipped += 1;
      log(`- ${s.id}: skipped (no leader key)`);
      continue;
    }
    const lacks = cannotRun(s, target.name, target.capabilities);
    if (lacks) {
      markDone(state, key(s), 'skipped', { error: lacks });
      tally.skipped += 1;
      log(`- ${s.id}: skipped (${lacks})`);
      continue;
    }
    log(`\n> ${s.id}: ${s.title} [${d.why}]`);
    markRunning(state, key(s), hash);
    if (mode === 'live') state.exposure ??= { since: Date.now(), by: s.id };
    saveState(stateFile, state);
    tally.ran += 1;
    const t = new T(henv, s.id);
    let status: 'passed' | 'failed' | 'inconclusive' | 'skipped' = 'passed';
    let error: string | null = null;
    try {
      await Promise.race([
        s.run(t),
        new Promise<never>((_, rej) => setTimeout(() => rej(new CheckFailed(`the scenario took longer than its ${Math.round(s.timeoutMs / 1000)} s`)), s.timeoutMs).unref()),
        new Promise<never>((_, rej) => {
          abandon = rej;
        }),
      ]);
    } catch (e) {
      // The scenario's own code may still be waiting somewhere: from here on it can send nothing.
      t.abandon(e instanceof Error ? e.message : String(e));
      error = e instanceof Error ? e.message : String(e);
      status = e instanceof Inconclusive ? 'inconclusive' : e instanceof Unavailable ? 'skipped' : 'failed';
      if (!(e instanceof Inconclusive || e instanceof Unavailable || e instanceof CheckFailed)) error = `${error}${e instanceof Error && e.stack ? `\n${e.stack.split('\n').slice(1, 4).join('\n')}` : ''}`;
    } finally {
      abandon = null;
    }
    // THE CLEANUP: always, before anything else happens.
    const flat = await cleanup().catch((e) => {
      log(`  ! cleanup failed: ${String(e)}`);
      return false;
    });
    let feesUsd: number | null = null;
    if (mode === 'live') {
      try {
        feesUsd = 0;
        for (const sym of testMarkets) for (const f of await reads.fills(followerAddress, sym, t.startedAt)) feesUsd += f.fee;
      } catch {
        feesUsd = null;
      }
    }
    if (!flat) {
      status = 'failed';
      error = `${error ? `${error}; ` : ''}the cleanup could not read the accounts flat`;
      stopRun = 'a cleanup did not leave the accounts flat';
    } else if (mode === 'live') state.exposure = null;
    markDone(state, key(s), status, { error, notes: t.notes, checks: t.checks, feesUsd });
    saveState(stateFile, state);
    tally[status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : status === 'skipped' ? 'skipped' : 'inconclusive'] += 1;
    log(`< ${s.id}: ${status.toUpperCase()} (${t.checks.passed} checks${t.checks.liveOnly ? `, ${t.checks.liveOnly} live-only not checked` : ''}${feesUsd !== null ? `, fees $${feesUsd.toFixed(4)}` : ''})${error ? `: ${error}` : ''}`);
    // The bootstrap is what every other scenario stands on: if it did not pass (failed, or the target refused it), nothing else runs.
    if (s.always && status !== 'passed') stopRun = `the bootstrap step ${s.id} ${status === 'failed' ? 'failed' : `did not pass (${status})`}`;
  }

  // The end: nothing left running, nothing left on SoDEX, the executor stopped.
  await cleanup().catch(() => false);
  await target.stop();
  await feeStub?.stop();
  state.executor = null;
  if (target.dataDir && !args.keepData) {
    try {
      rmSync(target.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      log(`(the executor's data folder ${target.dataDir} could not be removed; delete it yourself)`);
    }
  }
  noteRun(state, { at: Date.now(), target: target.name, codeHash: hashes.all(), selected: list.length, passed: tally.passed, failed: tally.failed, skipped: tally.skipped });
  saveState(stateFile, state);

  log('\nRESULTS');
  for (const s of list) {
    const r = state.scenarios[key(s)];
    if (!r) continue;
    log(`  ${r.status.padEnd(12)} ${s.id.padEnd(30)} ${r.checks.passed} checks${r.checks.liveOnly ? ` (+${r.checks.liveOnly} live-only)` : ''}${r.feesUsd !== null ? `  fees $${r.feesUsd.toFixed(4)}` : ''}${r.error ? `  ${r.error.split('\n')[0]!.slice(0, 140)}` : ''}`);
  }
  log(`\nthis run: ${tally.ran} ran, ${tally.passed} passed, ${tally.failed} failed, ${tally.inconclusive} inconclusive, ${tally.skipped} skipped; state in ${stateFile}`);
  if (stopRun) log(`STOPPED: ${stopRun}`);
  if (state.exposure) log(`! EXPOSURE FLAG SET: positions or orders may remain on SoDEX. Run again to flatten, or close them on sodex.com.`);
  return tally.failed || stopRun ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  async (e) => {
    process.stderr.write(`\n${e instanceof Error ? e.message : String(e)}\n`);
    await started?.stop().catch(() => undefined);
    process.exit(1);
  },
);
