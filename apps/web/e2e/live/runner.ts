/**
 * The live E2E run: configure the app's trading layer for Node, install the
 * network guard, create the key-backed wallet, run preflight (= plan mode),
 * then - live mode only, after every gate - the steps in order. A step's
 * assertions are recorded one by one (checks.ts); an assertion that fails
 * without leaving anything in an unknown state lets the run go on, anything
 * else stops it. Always ends with "where the funds are" and a JSON report
 * whose `checks` say what was asserted and how it came out.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATEWAY_ORIGIN, GATEWAY_WS_ORIGIN, SODEX_CHAIN_ID } from '@sodex-core';
import { recentLogs, setLogSink, type LogEntry } from '../../src/log';
import { setTradingConfig } from '../../src/trading/config';
import { _resetTradingForTests, getTradingState } from '../../src/trading/session';
import { followTerms } from '../../src/trading/terms';
import { memoryVault } from '../../src/trading/vault';
import { BIZ_ORIGIN } from '../../src/trading/relay';
import type { SocketFactory } from '../../src/exchange/ws/sodexSocket';
import { appTermsModule } from './app';
import { evmChain } from './chains';
import { Checks, STATUS_WORD, countChecks, routeCheckId, type CheckDef, type CheckRecord } from './checks';
import { loadConfig } from './config';
import { Recorder, STEP_ORDER, STEP_TITLES, SafetyStop, checkBudget, type Ctx, type Pre, type StepId } from './context';
import { fillRow } from './fees';
import { installGuard } from './guard';
import { HistoryLimiter } from './history';
import { Ledger } from './ledger';
import { preflight, printPlan, routeRows, type PlanResult } from './plan';
import { applyProfile, profileSteps, type Profile } from './profiles';
import { buildSummary, type SummaryInput } from './summary';
import type { OwnerInput } from './ownerInput';
import { KNOWN_CHAINS, createKeyProvider, type KeyProvider } from './provider';
import { snapshot, whereFundsLines, type Snapshot } from './reads';
import { STEPS, declareFundsChecks } from './steps';
import { AccountStream } from './stream';
import { TermsWatch } from './terms';
import { dur, errText, setPace, usd } from './util';

export { PROFILES, type Profile } from './profiles';

/** ValueChain's explorer API: the app reads a balance from it when the RPC does not answer (funds.ts). Reads only. */
const EXPLORER_ORIGIN = 'https://main-scan.valuechain.xyz';

export interface RunOptions {
  mode: 'plan' | 'live';
  configPath: string | null;
  /** live: must equal the wallet address derived from the key. */
  confirm: string | null;
  only: StepId[] | null;
  profile?: Profile;
  /** Read once to create the wallet, then dropped. */
  keyHex: string;
  throwaway: boolean;
  /** plan only: plan for this address; the key's wallet only stands in (a plan signs nothing). */
  watch?: string;
  registryOnly: boolean;
  reportDir: string;
  backendOverride: string | null;
  /** Where console lines go (default stdout) - tests capture them. */
  log?: (line: string) => void;
  /**
   * For the offline simulation only: a fake account stream, a short gap
   * between history reads (its fake has no rate limit), and a fast pace for
   * the runner's own waits. A real run never sets these.
   */
  test?: {
    socketFactory?: SocketFactory;
    historyGapMs?: number;
    pace?: number;
    /** Called when the run waits for a deposit the owner sends by hand (the fake "sends" it). */
    onManualDeposit?: (d: { coin: string; chain: string; address: string; amount: string }) => void;
  };
  /** What the owner types while the run waits for a hand-sent deposit (run.ts: stdin, live mode). */
  ownerInput?: OwnerInput | null;
}

const RECOVERY = [
  'How to recover in the app (connect this wallet at the backend origin, e.g. http://127.0.0.1:5180):',
  '  - Perps -> Spot ................ Transfer sheet: From "SoDEX Perps", To "SoDEX Spot"',
  '  - Spot -> a wallet on a chain .. Withdraw sheet: coin, chain, destination = your address',
  '  - ValueChain wallet -> Spot .... Deposit -> "Transfer from ValueChain"',
  '  - Open orders / a position ..... trade page, Orders / Positions tabs (cancel / close)',
  '  - A deposit IN FLIGHT .......... SoDEX credits it once custody sees it (explorer link above); nothing to resend',
  '  - A withdrawal IN FLIGHT ....... the Withdraw sheet / SoDEX history shows its status; a failed one paid from Spot returns to Spot',
];

/** The report's per-chain table: every route SoDEX lists, with what this run did there (`records`: every check, as the report lists them). */
function chainTable(ctx: Ctx, defs: CheckDef[], records: readonly CheckRecord[]): Array<Record<string, unknown>> {
  if (!ctx.pre) return [];
  const byRoute = new Map<string, { deposit?: CheckRecord; withdraw?: CheckRecord }>();
  const all = new Map(records.map((r) => [r.id, r]));
  for (const d of defs) {
    if (!d.route) continue;
    const k = `${d.route.coin.toUpperCase()}|${d.route.chain}`;
    const cur = byRoute.get(k) ?? {};
    const rec = all.get(d.id);
    // Two checks on one route (a deposit step and an extra deposit): the first that ran decides; a failure always shows.
    if (rec && (!cur[d.route.direction] || rec.status === 'fail' || cur[d.route.direction]!.status === 'not-run')) cur[d.route.direction] = rec;
    byRoute.set(k, cur);
  }
  const cell = (rec: CheckRecord | undefined, open: boolean, can: boolean, cannot: string, closed: string): { status: string; detail: string } => {
    if (rec) return { status: rec.status, detail: rec.detail };
    if (!open) return { status: 'not-testable', detail: closed };
    if (!can) return { status: 'not-testable', detail: cannot };
    return { status: 'not-run', detail: 'not part of this run' };
  };
  const evm = (chain: string) => ctx.pre.coins.some((c) => c.chains.some((x) => x.key === chain && x.addressKind === 'evm'));
  return routeRows(ctx.pre.coins).map((r) => {
    const hit = byRoute.get(`${r.coin.toUpperCase()}|${r.chain}`) ?? {};
    byRoute.delete(`${r.coin.toUpperCase()}|${r.chain}`);
    const rc = all.get(routeCheckId(r.coin, r.chain));
    return {
      chain: r.chain,
      label: r.label,
      coin: r.coin,
      native: r.native,
      deposit: cell(hit.deposit, r.depositOpen, r.canDeposit, evm(r.chain) ? 'the runner has no chain id / RPC for this chain, or the app sends no deposit of this coin' : 'the runner cannot sign on this chain - opt in to a manual deposit (manualDeposits) and send it by hand', 'deposits are closed on SoDEX right now'),
      withdraw: cell(hit.withdraw, r.withdrawOpen, r.canWithdraw, 'the app does not offer this route', 'withdrawals are closed on SoDEX right now'),
      route: rc ? { status: rc.status, detail: rc.detail } : { status: 'not-run', detail: 'not checked' },
    };
  });
}

export async function runE2E(o: RunOptions): Promise<number> {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.parse(startedAt);
  const rec = new Recorder(o.log);
  const L = (s = '') => rec.line(s);
  L(`Valuescan live E2E runner - ${o.mode === 'plan' ? 'PLAN (read-only: nothing is signed or sent)' : 'LIVE (moves real funds on SoDEX mainnet)'}`);
  if (o.test?.pace) setPace(o.test.pace);

  const loaded = loadConfig(o.configPath);
  const cfg = loaded.config;
  if (o.backendOverride) cfg.backend = o.backendOverride.replace(/\/+$/, '');
  const profile: Profile = o.profile ?? 'core';
  L(`config            ${loaded.source}`);
  L(`profile           ${profile}`);
  for (const w of loaded.warnings) L(`  config warning: ${w}`);
  if (loaded.errors.length) {
    for (const e of loaded.errors) L(`  CONFIG ERROR: ${e}`);
    return 2;
  }
  // What the profile changes in the config, said out loud; --only, when given, decides alone which steps run.
  const profileNotes = applyProfile(cfg, profile);
  for (const n of profileNotes) L(`  profile ${profile}: ${n}`);
  const only = o.only ? new Set(o.only) : null;
  const inProfile = new Set(profileSteps(profile));
  const selected = new Set<StepId>(STEP_ORDER.filter((s) => (only ? only.has(s) : inProfile.has(s))));
  if (only) {
    const extra = [...only].filter((s) => !inProfile.has(s));
    if (extra.length) L(`  --only also runs ${extra.join(', ')}, which the ${profile} profile does not include`);
  }

  const start = KNOWN_CHAINS.find((c) => c.key === cfg.startChain);
  if (!start) {
    L(`CONFIG ERROR: startChain ${cfg.startChain} is not one of ${KNOWN_CHAINS.map((c) => c.key).join(', ')}`);
    return 2;
  }

  const walletRefusals: string[] = [];
  const walletSigned: string[] = [];
  // The wallet. The key is used here once and dropped from the options.
  let provider: KeyProvider;
  try {
    provider = createKeyProvider({
      privateKey: o.keyHex,
      startChainId: start.id,
      onEvent: (e) => {
        if (e.type === 'tx-sent') {
          const ex = e.chainKey === 'VALUECHAIN' ? null : evmChain(e.chainKey)?.explorer;
          rec.tx({ chain: e.chainKey, hash: e.hash, what: `wallet tx to ${e.to} (${e.selector}${e.value !== '0' ? `, value ${e.value} wei` : ''})`, ...(ex ? { explorer: `${ex}/tx/${e.hash}` } : {}) });
        } else if (e.type === 'refused') {
          walletRefusals.push(`${e.method}: ${e.reason}`);
          rec.line(`the test wallet REFUSED ${e.method}: ${e.reason}`, 5);
        } else if (e.type === 'switch') {
          rec.line(`wallet switched chain ${e.from} -> ${e.to}`, 7);
        } else if (e.type === 'signed-typed-data') {
          walletSigned.push(e.primaryType);
          rec.line(`wallet signed ${e.primaryType} (chain ${e.chainId})`, 7);
        }
      },
    });
  } catch (e) {
    L(`KEY ERROR: ${errText(e)}`);
    return 2;
  } finally {
    o.keyHex = '';
  }
  if (o.watch && o.mode !== 'plan') {
    L('--address is for plan mode only (a live run needs the key)');
    return 2;
  }
  const owner = o.watch ? o.watch.toLowerCase() : provider.address;
  L(`wallet            ${owner}${o.watch ? ' (by address: a read-only plan, no key)' : o.throwaway ? ' (a throwaway key generated for this plan)' : ''}`);
  L(`backend           ${cfg.backend}`);
  L(`SoDEX gateway     ${GATEWAY_ORIGIN.mainnet} (relayer ${BIZ_ORIGIN})`);
  L(`steps             ${[...selected].join(', ')}`);

  // Live gates: all of them, before anything else happens.
  if (o.mode === 'live') {
    const gate: string[] = [];
    if (o.throwaway) gate.push('--throwaway-key is for plan mode only');
    if (o.registryOnly) gate.push('--registry-only is for plan mode only (live needs the backend and the registry to agree)');
    if (cfg.acknowledgeRealFunds !== true) gate.push('the config must say "acknowledgeRealFunds": true');
    if (!o.confirm) gate.push(`pass --confirm ${owner} (the wallet address this key controls)`);
    else if (o.confirm.toLowerCase() !== owner) gate.push(`--confirm ${o.confirm} is not this key's address ${owner}`);
    if (gate.length) {
      for (const g of gate) L(`REFUSED: ${g}`);
      return 2;
    }
  }

  // The run's own books.
  const checks = new Checks();
  const ledger = new Ledger();
  // The one door to the rate-limited history routes; plan mode reads none, so it gets none.
  const history = o.mode === 'live' ? new HistoryLimiter({ minGapMs: o.test?.historyGapMs, stateFile: join(o.reportDir, '.history-limit.json'), say: (l) => rec.line(l, 5) }) : null;
  const b = cfg.builder;
  const termsKeys = b?.termsKeys ?? [];
  const terms = b && termsKeys.length ? new TermsWatch({ owner, builderId: b.id, chainId: SODEX_CHAIN_ID.mainnet, keys: termsKeys, defaults: { perps: b.feePerps, spot: b.feeSpot } }) : null;

  const guard = installGuard({
    mode: o.mode,
    backend: cfg.backend,
    gateway: GATEWAY_ORIGIN.mainnet,
    relayer: BIZ_ORIGIN,
    rpcUrls: KNOWN_CHAINS.map((c) => c.rpcUrl),
    readOnlyOrigins: [EXPLORER_ORIGIN],
    owner,
    blockDepositIssuing: o.registryOnly,
    history,
    onTerms: (url, status, text) => {
      terms?.observe(url, status, text);
    },
    onWrite: (w) => {
      if (w.kind === 'order' || w.kind === 'direct-order') ledger.noteOrderRequest(w, w.kind === 'direct-order' ? 'direct' : 'app');
      else if (w.kind === 'order-replace') ledger.noteReplace(w);
    },
  });
  // The app's trading layer, configured for Node exactly as its own tests do it
  // (funds.test.ts). Plan mode: writes off AND disabled - the app refuses to sign too.
  setTradingConfig({
    network: 'mainnet',
    chainId: SODEX_CHAIN_ID.mainnet,
    gateway: GATEWAY_ORIGIN.mainnet,
    writesAllowed: o.mode === 'live',
    disabled: o.mode !== 'live',
    // OFF unless the run's config sets one (config.ts `builder`).
    builder: b ? { id: b.id, fee: { perps: b.feePerps, spot: b.feeSpot }, maxFeeRate: b.maxFee, required: b.required } : null,
    termsKeys,
    keyTtlMs: cfg.keyTtlHours * 3_600_000,
  });
  _resetTradingForTests(memoryVault());

  const ctx: Ctx = {
    mode: o.mode,
    profile,
    cfg,
    owner,
    provider,
    guard,
    rec,
    pre: null as unknown as Pre,
    selected,
    registryOnly: o.registryOnly,
    inFlight: [],
    spend: { costUsd: 0, sentAwayUsd: 0 },
    stepSentAwayUsd: 0,
    lastSnapshot: null,
    checks,
    ledger,
    stream: null,
    history,
    terms,
    appTerms: terms ? appTermsModule : null,
    feeRates: {},
    fillChecks: new Map(),
    builderBaseline: null,
    startedAtMs,
    walletRefusals,
    walletSigned,
    tiers: { cheats: [] },
    tamperTerms: null,
    routeChecks: new Map(),
    onManualDeposit: o.test?.onManualDeposit ?? null,
    ownerInput: o.ownerInput ?? null,
    otherCoins: new Map(),
    handArrived: new Map(),
    deferredWithdrawals: new Set(),
  };

  // The app's terms module asks through the guard; the runner can hand it a TAMPERED copy of a real answer (tierSteps.ts).
  appTermsModule.configureTerms({
    keys: termsKeys,
    fetch: async (input, init) => {
      const res = await globalThis.fetch(input, init);
      const tamper = ctx.tamperTerms;
      if (!tamper || !res.ok) return res;
      const body = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify(tamper(body)), { status: res.status, headers: { 'content-type': 'application/json' } });
    },
  });

  const appWarnings: LogEntry[] = [];
  setLogSink((e) => appWarnings.push(e));

  // Every recorded assertion: one console line, and the step it belongs to.
  let stepChecks: Set<string> | null = null;
  checks.onRecord = (r) => {
    stepChecks?.add(r.id);
    const mark = r.status === 'pass' ? 'ok' : STATUS_WORD[r.status];
    rec.line(`${mark.padEnd(8)} ${r.id}: ${r.detail}`, 5);
  };

  let plan: PlanResult | null = null;
  let finished = false;
  let exitCode = 0;
  let startSnapshot: Snapshot | null = null;
  const reached = new Set<StepId>();
  const finish = async (code: number): Promise<number> => {
    if (finished) return code;
    finished = true;
    let end: Snapshot | null = null;
    if (o.mode === 'live' && ctx.pre) {
      end = await snapshot(owner, ctx.pre.coins).catch(() => null);
      L('');
      L(code === 0 ? 'Where the funds are now:' : 'STOPPED. Where the funds are now:');
      if (end) for (const l of whereFundsLines(end, ctx.inFlight)) L(l);
      else L('  (could not read the balances - check the app)');
      if (code !== 0) for (const l of RECOVERY) L(l);
      L(`Spend: costs ${usd(ctx.spend.costUsd)} + sent to other addresses ${usd(ctx.spend.sentAwayUsd)} (maxSpendUsd ${usd(cfg.maxSpendUsd)})`);
    }
    ctx.stream?.close();
    ctx.ownerInput?.stop();
    followTerms(null);
    // Every declared check, with why the ones that did not run did not.
    const skips = new Map((plan?.plans ?? []).filter((p) => p.skip).map((p) => [p.id, p.skip!]));
    const all = checks.all((d) => {
      if (o.mode === 'plan') return { status: 'not-run', detail: 'plan mode: nothing is signed or sent' };
      if (d.step === 'preflight') return { status: 'not-run', detail: 'not recorded' };
      if (!selected.has(d.step)) return { status: 'skipped', detail: `its step (${d.step}) was not selected (--only)` };
      const skip = skips.get(d.step);
      if (skip) return { status: 'skipped', detail: `its step (${d.step}) was skipped: ${skip}` };
      if (!reached.has(d.step)) return { status: 'not-run', detail: `the run stopped before ${d.step}` };
      return { status: 'not-run', detail: `${d.step} ended before this check` };
    });
    const counts = countChecks(all);
    const defs = checks.definitions();
    if (o.mode === 'live') {
      L(`Checks: ${counts.pass} pass, ${counts.fail} FAIL, ${counts.finding} finding(s), ${counts.skipped} skipped, ${counts['not-run']} not run`);
      for (const r of all.filter((x) => x.status === 'fail')) L(`  FAIL     ${r.id}: ${r.detail}`);
      for (const r of all.filter((x) => x.status === 'finding')) L(`  FINDING  ${r.id}: ${r.detail}`);
    }
    // A failed check fails a LIVE run; a plan's route-check failures are warnings (it signs nothing).
    exitCode = o.mode === 'live' && code === 0 && counts.fail > 0 ? 1 : code;
    const report = {
      tool: 'valuescan-live-e2e',
      version: 2,
      mode: o.mode,
      profile,
      exitCode,
      startedAt,
      finishedAt: new Date().toISOString(),
      wallet: owner,
      throwawayKey: o.throwaway,
      backend: cfg.backend,
      gateway: GATEWAY_ORIGIN.mainnet,
      relayer: BIZ_ORIGIN,
      configSource: loaded.source,
      config: cfg,
      selectedSteps: [...selected],
      registryOnly: o.registryOnly,
      plan: plan && {
        problems: [...new Set(plan.problems)],
        warnings: plan.warnings,
        checklist: plan.checklist,
        estimatedCostUsd: plan.totalCostUsd,
        estimatedSentAwayUsd: plan.totalSentAwayUsd,
        balances: plan.balances,
        routes: plan.routeTable,
        markets: plan.markets,
        depositAddresses: Object.fromEntries(plan.pre.depositAddresses),
        receiversNeeded: plan.receiversNeeded,
        routeChecks: plan.routeChecks,
        notTestable: plan.notTestable,
        profileNotes: plan.profileNotes,
        suggestedMaxSpendUsd: plan.suggestedMaxSpendUsd,
        handDeposits: plan.handDeposits,
        budget: plan.budget,
        terms: plan.terms ? { verified: plan.terms.verdict.verified, off: plan.terms.verdict.off, problems: plan.terms.verdict.problems, keyId: plan.terms.verdict.keyId, fee: plan.terms.verdict.answer.fee, volume: plan.terms.verdict.answer.volume, tier: plan.terms.verdict.answer.tier, flags: plan.terms.verdict.answer.flags, cacheControl: plan.terms.cacheControl } : null,
        steps: plan.plans,
      },
      checks: all,
      checkCounts: counts,
      chains: chainTable(ctx, defs, all),
      orderTypes: all.filter((c) => c.area === 'orders-perps' || c.area === 'orders-spot').map((c) => ({ id: c.id, title: c.title, engine: c.area === 'orders-perps' ? 'perps' : 'spot', status: c.status, detail: c.detail })),
      feeTable: [...ctx.fillChecks.values()].map(fillRow),
      steps: rec.steps,
      spend: ctx.spend,
      tradingKey: (() => {
        const t = getTradingState();
        return t.status === 'enabled' ? { name: t.keyName, address: t.keyAddress, expiresAt: t.expiresAt, engines: t.engines, builder: t.builder } : { status: t.status };
      })(),
      orders: ledger.orders,
      fills: ledger.fills,
      termsSeen: terms ? terms.seen.map((v) => ({ at: v.receivedAt, verified: v.verified, problems: v.problems, fee: v.answer.fee, volume: v.answer.volume, flags: v.answer.flags, keyId: v.keyId })) : [],
      historyReads: history?.reads ?? [],
      stream: ctx.stream?.describe() ?? null,
      snapshots: { start: startSnapshot, end },
      inFlight: ctx.inFlight,
      whereFunds: end ? whereFundsLines(end, ctx.inFlight) : null,
      network: { requests: guard.records, refused: guard.refusals },
      walletRefusals,
      appLog: { warnings: appWarnings, recent: recentLogs() },
    };
    try {
      mkdirSync(o.reportDir, { recursive: true });
      const file = join(o.reportDir, `${startedAt.replace(/[:.]/g, '-')}-${o.mode}.json`);
      const text = provider.redact(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Map ? Object.fromEntries(v) : v), 2));
      writeFileSync(file, text, 'utf8');
      // The run in words, next to it (the guided launcher reads `<report>.summary.md`).
      const summaryFile = file.replace(/\.json$/, '.summary.md');
      try {
        const md = buildSummary({
          mode: o.mode,
          profile,
          wallet: owner,
          exitCode,
          startedAt,
          finishedAt: report.finishedAt,
          checks: all,
          chains: report.chains as unknown as SummaryInput['chains'],
          feeTable: report.feeTable,
          termsSeen: terms ? terms.seen.map((v) => ({ at: v.receivedAt, verified: v.verified, fee: v.answer.fee ?? null, flags: v.answer.flags ?? [] })) : [],
          spend: ctx.spend,
          maxSpendUsd: cfg.maxSpendUsd,
          builder: cfg.builder ? { id: cfg.builder.id, feePerps: cfg.builder.feePerps, feeSpot: cfg.builder.feeSpot } : null,
          steps: rec.steps,
          whereFunds: report.whereFunds,
          inFlight: ctx.inFlight,
          plan: plan ? { problems: [...new Set(plan.problems)], notTestable: plan.notTestable } : null,
        });
        writeFileSync(summaryFile, provider.redact(md), 'utf8');
        L(`summary           ${summaryFile}`);
      } catch (e) {
        L(`could not write the summary: ${errText(e)}`);
      }
      L(`report            ${file}`);
    } catch (e) {
      L(`could not write the report: ${errText(e)}`);
    }
    setLogSink(null);
    guard.uninstall();
    return exitCode;
  };

  const onSigint = () => {
    if (finished) process.exit(130);
    L('INTERRUPTED - reading where the funds are and writing the report (Ctrl+C again quits at once)');
    void finish(130).then((c) => process.exit(c));
  };
  process.on('SIGINT', onSigint);

  try {
    // Preflight = the whole of plan mode.
    rec.begin('preflight', 'read-only checks: backend, routes, balances, account, deposit addresses, markets, receivers, fee terms');
    try {
      plan = await preflight({ mode: o.mode, cfg, owner, selected, registryOnly: o.registryOnly, rec, terms, profile, profileNotes, checks });
      ctx.pre = plan.pre;
      declareFundsChecks(ctx);
      rec.end('ok');
    } catch (e) {
      rec.end('failed', e);
      return await finish(1);
    }
    printPlan(rec, plan, cfg, { mode: o.mode, owner, throwaway: o.throwaway });
    if (o.mode === 'plan') return await finish(plan.problems.length ? 2 : 0);
    if (plan.problems.length) {
      L('Live run refused - fix the problems above (nothing was signed or sent).');
      return await finish(2);
    }

    // The wallet's account stream: order states and fills, without the rate-limited history routes.
    const wsBase = GATEWAY_WS_ORIGIN.mainnet;
    const why = o.test?.socketFactory ? null : AccountStream.problem(wsBase);
    if (why) L(`account stream    not opened: ${why} - fills are judged in the final cross-check`);
    else {
      const stream = new AccountStream({ owner, ledger, base: wsBase, ...(o.test?.socketFactory ? { factory: o.test.socketFactory } : {}), say: (l) => rec.line(l, 5) });
      stream.start();
      const ok = await stream.waitReady(cfg.timeouts.streamSeconds * 3000);
      ctx.stream = stream;
      L(`account stream    ${ok ? 'subscribed (spot and perps: order updates, fills)' : `not ready after ${dur(cfg.timeouts.streamSeconds * 3000)} (${JSON.stringify(stream.describe())}) - it keeps trying; what it misses is judged in the final cross-check`}`);
    }

    // Live steps.
    startSnapshot = await snapshot(owner, plan.pre.coins).catch(() => null);
    ctx.lastSnapshot = startSnapshot;
    let failed = false;
    for (const id of STEP_ORDER) {
      if (!selected.has(id)) continue;
      reached.add(id);
      const planned = plan.plans.find((p) => p.id === id);
      if (planned?.skip) {
        rec.skip(id, STEP_TITLES[id], planned.skip);
        continue;
      }
      const est = plan.pre.estimates.get(id) ?? { costUsd: 0, sentAwayUsd: 0 };
      const r = rec.begin(id, STEP_TITLES[id]);
      r.plan = planned?.lines;
      r.estimateUsd = est.costUsd + est.sentAwayUsd;
      try {
        checkBudget(ctx, id, est.costUsd + est.sentAwayUsd);
      } catch (e) {
        rec.end('blocked', e);
        failed = true;
        break;
      }
      const before = ctx.lastSnapshot ?? (await snapshot(owner, plan.pre.coins).catch(() => null));
      ctx.stepSentAwayUsd = 0;
      stepChecks = new Set();
      let err: unknown = null;
      try {
        await STEPS[id](ctx);
      } catch (e) {
        err = e;
      }
      const mine = [...stepChecks].map((c) => checks.get(c)).filter((c): c is CheckRecord => !!c);
      stepChecks = null;
      const cc = countChecks(mine);
      r.checks = { pass: cc.pass, fail: cc.fail, finding: cc.finding, skipped: cc.skipped, failed: mine.filter((c) => c.status === 'fail').map((c) => c.id) };
      const after = await snapshot(owner, plan.pre.coins).catch(() => null);
      ctx.lastSnapshot = after;
      ctx.spend.sentAwayUsd += ctx.stepSentAwayUsd;
      if (before && after && !before.unreadable.length && !after.unreadable.length && !ctx.inFlight.length) {
        const cost = before.totalUsd - after.totalUsd - ctx.stepSentAwayUsd;
        r.measured = { valueBeforeUsd: before.totalUsd, valueAfterUsd: after.totalUsd, sentAwayUsd: ctx.stepSentAwayUsd, costUsd: cost };
        ctx.spend.costUsd += Math.max(0, cost);
        rec.line(`value ${usd(before.totalUsd)} -> ${usd(after.totalUsd)}: cost ${usd(cost)}${ctx.stepSentAwayUsd ? `, sent to another address ${usd(ctx.stepSentAwayUsd)}` : ''} (prices of held coins move too)`, 5);
      } else {
        // Could not measure (a place unreadable, or funds in flight): count the estimate.
        ctx.spend.costUsd += est.costUsd;
      }
      if (err) {
        rec.end(err instanceof SafetyStop ? 'blocked' : 'failed', err);
        failed = true;
        break;
      }
      if (cc.fail) r.notes.push(`${cc.fail} check(s) of this step FAILED: ${r.checks.failed.join(', ')} - the step went on (nothing was left in an unknown state)`);
      rec.end('ok');
    }
    L('');
    const ok = rec.steps.filter((s) => s.status === 'ok').length;
    L(`${failed ? 'FAILED' : 'DONE'}: ${ok} step(s) ok${failed ? `, stopped at ${rec.steps.at(-1)?.id}` : ''} - ${dur(Date.now() - startedAtMs)}`);
    return await finish(failed ? 1 : 0);
  } catch (e) {
    L(`UNEXPECTED ERROR: ${provider.redact(errText(e))}`);
    return await finish(1);
  } finally {
    process.off('SIGINT', onSigint);
    if (!finished) await finish(exitCode || 1);
    if (o.test?.pace) setPace(1);
  }
}
