/**
 * The live E2E run: configure the app's trading layer for Node, install the
 * network guard, create the key-backed wallet, run preflight (= plan mode),
 * then - live mode only, after every gate - the steps in order, stopping at the
 * first failure. Always ends with "where the funds are" and a JSON report.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATEWAY_ORIGIN, SODEX_CHAIN_ID } from '@sodex-core';
import { recentLogs, setLogSink, type LogEntry } from '../../src/log';
import { setTradingConfig } from '../../src/trading/config';
import { _resetTradingForTests, getTradingState } from '../../src/trading/session';
import { memoryVault } from '../../src/trading/vault';
import { EVM_CHAINS } from '../../src/trading/onboard';
import { BIZ_ORIGIN } from '../../src/trading/relay';
import { loadConfig } from './config';
import { Recorder, STEP_ORDER, STEP_TITLES, SafetyStop, checkBudget, type Ctx, type Pre, type StepId } from './context';
import { installGuard } from './guard';
import { preflight, printPlan, type PlanResult } from './plan';
import { KNOWN_CHAINS, createKeyProvider, type KeyProvider } from './provider';
import { snapshot, whereFundsLines, type Snapshot } from './reads';
import { STEPS } from './steps';
import { dur, errText, usd } from './util';

export interface RunOptions {
  mode: 'plan' | 'live';
  configPath: string | null;
  /** live: must equal the wallet address derived from the key. */
  confirm: string | null;
  only: StepId[] | null;
  /** Read once to create the wallet, then dropped. */
  keyHex: string;
  throwaway: boolean;
  registryOnly: boolean;
  reportDir: string;
  backendOverride: string | null;
  /** Where console lines go (default stdout) - tests capture them. */
  log?: (line: string) => void;
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

export async function runE2E(o: RunOptions): Promise<number> {
  const startedAt = new Date().toISOString();
  const rec = new Recorder(o.log);
  const L = (s = '') => rec.line(s);
  L(`Valuescan live E2E runner - ${o.mode === 'plan' ? 'PLAN (read-only: nothing is signed or sent)' : 'LIVE (moves real funds on SoDEX mainnet)'}`);

  const loaded = loadConfig(o.configPath);
  const cfg = loaded.config;
  if (o.backendOverride) cfg.backend = o.backendOverride.replace(/\/+$/, '');
  L(`config            ${loaded.source}`);
  for (const w of loaded.warnings) L(`  config warning: ${w}`);
  if (loaded.errors.length) {
    for (const e of loaded.errors) L(`  CONFIG ERROR: ${e}`);
    return 2;
  }
  const only = o.only ? new Set(o.only) : null;
  const selected = new Set<StepId>(STEP_ORDER.filter((s) => !only || only.has(s)));

  const start = KNOWN_CHAINS.find((c) => c.key === cfg.startChain);
  if (!start) {
    L(`CONFIG ERROR: startChain ${cfg.startChain} is not one of ${KNOWN_CHAINS.map((c) => c.key).join(', ')}`);
    return 2;
  }

  // The wallet. The key is used here once and dropped from the options.
  let provider: KeyProvider;
  try {
    provider = createKeyProvider({
      privateKey: o.keyHex,
      startChainId: start.id,
      onEvent: (e) => {
        if (e.type === 'tx-sent') {
          const ex = e.chainKey === 'VALUECHAIN' ? null : EVM_CHAINS[e.chainKey]?.explorer;
          rec.tx({ chain: e.chainKey, hash: e.hash, what: `wallet tx to ${e.to} (${e.selector}${e.value !== '0' ? `, value ${e.value} wei` : ''})`, ...(ex ? { explorer: `${ex}/tx/${e.hash}` } : {}) });
        } else if (e.type === 'refused') {
          rec.line(`the test wallet REFUSED ${e.method}: ${e.reason}`, 5);
        } else if (e.type === 'switch') {
          rec.line(`wallet switched chain ${e.from} -> ${e.to}`, 7);
        } else if (e.type === 'signed-typed-data') {
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
  const owner = provider.address;
  L(`wallet            ${owner}${o.throwaway ? ' (a throwaway key generated for this plan)' : ''}`);
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

  const guard = installGuard({
    mode: o.mode,
    backend: cfg.backend,
    gateway: GATEWAY_ORIGIN.mainnet,
    relayer: BIZ_ORIGIN,
    rpcUrls: KNOWN_CHAINS.map((c) => c.rpcUrl),
    owner,
    blockDepositIssuing: o.registryOnly,
  });
  // The app's trading layer, configured for Node exactly as its own tests do it
  // (funds.test.ts). Plan mode: writes off AND disabled - the app refuses to sign too.
  setTradingConfig({
    network: 'mainnet',
    chainId: SODEX_CHAIN_ID.mainnet,
    gateway: GATEWAY_ORIGIN.mainnet,
    writesAllowed: o.mode === 'live',
    disabled: o.mode !== 'live',
    builder: null,
    keyTtlMs: cfg.keyTtlHours * 3_600_000,
  });
  _resetTradingForTests(memoryVault());
  const appWarnings: LogEntry[] = [];
  setLogSink((e) => appWarnings.push(e));

  const ctx: Ctx = {
    mode: o.mode,
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
  };

  let plan: PlanResult | null = null;
  let finished = false;
  let exitCode = 0;
  let startSnapshot: Snapshot | null = null;
  const finish = async (code: number): Promise<number> => {
    if (finished) return code;
    finished = true;
    exitCode = code;
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
    const report = {
      tool: 'valuescan-live-e2e',
      version: 1,
      mode: o.mode,
      exitCode: code,
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
        steps: plan.plans,
      },
      steps: rec.steps,
      spend: ctx.spend,
      tradingKey: (() => {
        const t = getTradingState();
        return t.status === 'enabled' ? { name: t.keyName, address: t.keyAddress, expiresAt: t.expiresAt, engines: t.engines } : { status: t.status };
      })(),
      snapshots: { start: startSnapshot, end },
      inFlight: ctx.inFlight,
      whereFunds: end ? whereFundsLines(end, ctx.inFlight) : null,
      network: { requests: guard.records, refused: guard.refusals },
      appLog: { warnings: appWarnings, recent: recentLogs() },
    };
    try {
      mkdirSync(o.reportDir, { recursive: true });
      const file = join(o.reportDir, `${startedAt.replace(/[:.]/g, '-')}-${o.mode}.json`);
      const text = provider.redact(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Map ? Object.fromEntries(v) : v), 2));
      writeFileSync(file, text, 'utf8');
      L(`report            ${file}`);
    } catch (e) {
      L(`could not write the report: ${errText(e)}`);
    }
    setLogSink(null);
    guard.uninstall();
    return code;
  };

  const onSigint = () => {
    if (finished) process.exit(130);
    L('INTERRUPTED - reading where the funds are and writing the report (Ctrl+C again quits at once)');
    void finish(130).then((c) => process.exit(c));
  };
  process.on('SIGINT', onSigint);

  try {
    // Preflight = the whole of plan mode.
    rec.begin('preflight', 'read-only checks: backend, routes, balances, account, deposit addresses, markets, receivers');
    try {
      plan = await preflight({ mode: o.mode, cfg, owner, selected, registryOnly: o.registryOnly, rec });
      ctx.pre = plan.pre;
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

    // Live steps.
    startSnapshot = await snapshot(owner, plan.pre.coins).catch(() => null);
    ctx.lastSnapshot = startSnapshot;
    let failed = false;
    for (const id of STEP_ORDER) {
      if (!selected.has(id)) continue;
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
      let err: unknown = null;
      try {
        await STEPS[id](ctx);
      } catch (e) {
        err = e;
      }
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
      rec.end('ok');
    }
    L('');
    const ok = rec.steps.filter((s) => s.status === 'ok').length;
    L(`${failed ? 'FAILED' : 'DONE'}: ${ok} step(s) ok${failed ? `, stopped at ${rec.steps.at(-1)?.id}` : ''} - ${dur(Date.now() - Date.parse(startedAt))}`);
    return await finish(failed ? 1 : 0);
  } catch (e) {
    L(`UNEXPECTED ERROR: ${provider.redact(errText(e))}`);
    return await finish(1);
  } finally {
    process.off('SIGINT', onSigint);
    if (!finished) await finish(exitCode || 1);
  }
}
