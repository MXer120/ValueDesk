/**
 * Stage D: the live money run, through the live runner (apps/web/e2e/live).
 *
 * The runner's safety model is the contract and stays the only thing between a
 * key and a signature; the guide adds a person's decisions in front of it:
 *
 *   - THE KEY is typed into a hidden prompt, lives in this process's memory, and
 *     reaches the runner only as VS_E2E_KEY in THAT child's environment
 *     (proc.childEnv). Never an argument, never a file, never a log: every line
 *     the guide prints or logs goes through a redactor that knows the key.
 *   - A LIVE run starts only at a console, after the plan says it would start,
 *     after the owner typed YES and after they typed the wallet address.
 *     `acknowledgeRealFunds` is written into the config only then, and switched
 *     off again when the run ends.
 *   - Everything before that is the runner's read-only `plan`. While waiting for
 *     funds it is run with --registry-only, so nothing is asked of SoDEX but
 *     reads.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkStop, heading, logWriter, type Ctx } from './context';
import { applyChoices, configProblems, describeConfig, loadExample, loadExisting, readBuilderKeyNames, receiversSet, saveConfig, type BuilderKeyNames, type ConfigChoices, type Json, type ReceiverValue } from './config';
import { lastJsonLine } from './builder';
import { addressOfKey, normaliseKey, sameAddress } from './key';
import { childEnv } from './proc';
import { askValue, choose, confirm, pressEnter, typeExactly } from './prompt';
import {
  DEFAULT_CAPABILITIES,
  FULL_TEST,
  FULL_TEST_PROFILE,
  capabilitiesFromUsage,
  configWarnings,
  extractFeeTable,
  findReportPath,
  findWallet,
  fundingInstructions,
  fundingStatus,
  missingLine,
  parseCapabilities,
  planFromConsole,
  plannedSkips,
  profileMenu,
  readLiveReport,
  readPlanReport,
  receiversToAsk,
  refusalLines,
  resumeCommand,
  resumeSteps,
  retestSteps,
  runnerArgs,
  stepItemStatus,
  stripClock,
  summaryPathsFor,
  type Capabilities,
  type LiveView,
  type PlanView,
  type RunnerInvocation,
} from './runner';
import { readChecks, type RunnerCheck } from './report';
import { looksLikeKey, makeKeyRedactor } from './scrub';
import { STAGE_TITLES, Stopped, type Item, type StageResult, type StageStatus } from './types';
import { fmtDur, fmtUsd } from './ui';

export interface RunnerRun {
  code: number | null;
  lines: string[];
  reportPath: string | null;
  ms: number;
  startError: string | null;
  timedOut: boolean;
}

export interface RunnerCallOptions {
  /** Handed to the child's environment as VS_E2E_KEY - and to nothing else. */
  key: string | null;
  logName: string;
  onLine?: (line: string) => void;
  /** A live run: Ctrl+C must reach the runner, which then reports where the funds are; the guide never kills it. */
  protect?: boolean;
  timeoutMs?: number;
  /** Lines the owner types while it runs go to the runner (the live run: "s" skips a hand-sent deposit). */
  input?: boolean;
}

/** Everything stage D does to the outside world, so a test can stand in for all of it. */
export interface DDeps {
  runner(inv: RunnerInvocation, o: RunnerCallOptions): Promise<RunnerRun>;
  readJson(path: string): unknown;
  readText(path: string): string | null;
  /** Reports of earlier live runs, newest first (full paths). */
  liveReports(): string[];
  loadConfig(): { existing: Json | null; example: Json | null; problem: string | null; names: BuilderKeyNames };
  saveConfig(path: string, cfg: Json): void;
  /**
   * apps/server/tools/builderTiers.ts `forget --address` for the TEST wallet: the local server's
   * record of it (counted volume, flags) is removed, so the fee test can show the default fee again.
   * Absent: not available here.
   */
  forgetTierWallet?(address: string): Promise<{ ok: boolean; detail: string }>;
  /**
   * apps/server/tools/builderTiers.ts `set-window --days <n>` on the LOCAL server: its tiers go by the volume
   * of the last n days, as on the live site. Run from here because this process is outside the Claude app,
   * whose own tools cannot write the server's data directory (Windows redirects them to a private copy).
   * Absent: not available here.
   */
  setTierWindow?(days: number): Promise<{ ok: boolean; detail: string }>;
}

/** The volume window of the live site's fee tiers (its builder-tiers.json, docs/BUILDER-TIERS.md section 4). */
export const LIVE_VOLUME_DAYS = 14;

const PLAN_TIMEOUT_MS = 6 * 60_000;
const POLL_MS = 20_000;

export function realDDeps(ctx: Ctx): DDeps {
  const readText = (p: string): string | null => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
  return {
    readText,
    readJson: (p) => {
      const t = readText(p);
      if (t === null) return null;
      try {
        return JSON.parse(t) as unknown;
      } catch {
        return null;
      }
    },
    liveReports: () => {
      try {
        return readdirSync(ctx.paths.reportDir).filter((f) => /-live\.json$/.test(f)).sort().reverse().map((f) => join(ctx.paths.reportDir, f));
      } catch {
        return [];
      }
    },
    loadConfig: () => {
      const names = readBuilderKeyNames(ctx.paths.config);
      const ex = loadExample(ctx.paths.config);
      const cur = loadExisting(ctx.paths.config);
      return {
        existing: cur && cur.ok ? cur.config : null,
        example: ex.ok ? ex.config : null,
        problem: cur && !cur.ok ? cur.problem : !ex.ok && !cur ? ex.problem : null,
        names,
      };
    },
    saveConfig,
    setTierWindow: async (days) => {
      const server = join(ctx.paths.repo, 'apps', 'server');
      if (!existsSync(join(server, 'tools', 'builderTiers.ts'))) return { ok: false, detail: 'apps/server/tools/builderTiers.ts is not in this checkout' };
      if (!ctx.tools.tsxCli) return { ok: false, detail: 'tsx is not installed (run "npm install" in the repository)' };
      const outLines: string[] = [];
      const errLines: string[] = [];
      const r = await ctx.run(ctx.tools.node, [ctx.tools.tsxCli, 'tools/builderTiers.ts', 'set-window', '--days', String(days)], { cwd: server, env: childEnv(ctx.env), timeoutMs: 120_000, onLine: (l, from) => (from === 'out' ? outLines : errLines).push(l) });
      const j = lastJsonLine(outLines.join('\n'));
      if (r.code !== 0 || !j) return { ok: false, detail: r.startError ?? (typeof j?.error === 'string' ? j.error : errLines.filter((l) => l.trim()).slice(-2).join(' ').slice(0, 300) || `the tool exited with code ${r.code}`) };
      return { ok: true, detail: `tiers by the volume of the last ${String(j.volumeDays ?? days)} days` };
    },
    forgetTierWallet: async (address) => {
      const server = join(ctx.paths.repo, 'apps', 'server');
      if (!existsSync(join(server, 'tools', 'builderTiers.ts'))) return { ok: false, detail: 'apps/server/tools/builderTiers.ts is not in this checkout' };
      if (!ctx.tools.tsxCli) return { ok: false, detail: 'tsx is not installed (run "npm install" in the repository)' };
      const outLines: string[] = [];
      const errLines: string[] = [];
      const r = await ctx.run(ctx.tools.node, [ctx.tools.tsxCli, 'tools/builderTiers.ts', 'forget', '--address', address], { cwd: server, env: childEnv(ctx.env), timeoutMs: 120_000, onLine: (l, from) => (from === 'out' ? outLines : errLines).push(l) });
      const j = lastJsonLine(outLines.join('\n'));
      if (r.code !== 0 || !j) return { ok: false, detail: r.startError ?? (typeof j?.error === 'string' ? j.error : errLines.filter((l) => l.trim()).slice(-2).join(' ').slice(0, 300) || `the tool exited with code ${r.code}`) };
      return { ok: true, detail: j.dbExists === false ? 'the server had no record of it' : `${typeof j.total === 'number' ? j.total : '?'} record(s) removed` };
    },
    runner: async (inv, o) => {
      const lines: string[] = [];
      const log = logWriter(ctx, o.logName);
      if (!ctx.tools.tsxCli) return { code: null, lines, reportPath: null, ms: 0, startError: 'tsx is not installed (run "npm install" in the repository)', timedOut: false };
      const args = runnerArgs(inv);
      log.write(`$ npx tsx e2e/live/run.ts ${args.join(' ')}   (in apps/web)`);
      const r = await ctx.run(ctx.tools.node, [ctx.tools.tsxCli, 'e2e/live/run.ts', ...args], {
        cwd: ctx.paths.web,
        // The ONE place a key leaves this process: the environment of this one child.
        env: childEnv(ctx.env, o.key),
        timeoutMs: o.timeoutMs,
        ...(o.input ? { input: { next: (ms: number) => ctx.ask.prompter.waitLine(ms) } } : {}),
        onStart: (c) => {
          const set = o.protect ? ctx.liveRuns : ctx.children;
          set.add(c);
          c.once('close', () => set.delete(c));
        },
        onLine: (raw) => {
          const line = ctx.out.redact(raw);
          lines.push(line);
          log.write(line);
          o.onLine?.(line);
        },
      });
      log.write(`exit ${r.code}${r.timedOut ? ' (timed out)' : ''}`);
      return { code: r.code, lines, reportPath: findReportPath(lines), ms: r.ms, startError: r.startError, timedOut: r.timedOut };
    },
  };
}

// --- capabilities -----------------------------------------------------------------------------

/** What this runner version can do: asked once, remembered. Never throws. */
export async function detectCapabilities(ctx: Ctx, deps: DDeps): Promise<Capabilities> {
  if (ctx.shared.caps) return ctx.shared.caps;
  let caps: Capabilities = DEFAULT_CAPABILITIES;
  try {
    const r = await deps.runner({ mode: 'capabilities' }, { key: null, logName: 'D-capabilities.log', timeoutMs: 120_000 });
    const text = r.lines.join('\n');
    caps = parseCapabilities(text, r.code) ?? capabilitiesFromUsage(text) ?? DEFAULT_CAPABILITIES;
  } catch {
    caps = DEFAULT_CAPABILITIES;
  }
  ctx.shared.caps = caps;
  return caps;
}

// --- the plan ---------------------------------------------------------------------------------

export interface Planned {
  run: RunnerRun;
  view: PlanView;
  raw: unknown;
  /** `none yet (brand-new wallet)` -> null; `#123` -> 123; unknown -> undefined. */
  accountId: number | null | undefined;
  /** The runner refused before planning (config, key, arguments): its reasons. */
  refused: string[];
}

export async function planOnce(
  ctx: Ctx,
  deps: DDeps,
  o: { config: string | null; key: string | null; throwaway: boolean; registryOnly: boolean; profile: string | null; only: readonly string[] | null; logName: string; show?: boolean },
): Promise<Planned> {
  const run = await deps.runner(
    { mode: 'plan', config: o.config, only: o.only, throwaway: o.throwaway, registryOnly: o.registryOnly, reportDir: ctx.paths.reportDir, profile: o.profile },
    { key: o.throwaway ? null : o.key, logName: o.logName, timeoutMs: PLAN_TIMEOUT_MS, onLine: o.show ? (l) => ctx.out.line(`   | ${stripClock(l)}`) : (l) => ctx.out.live(`  ...     planning: ${stripClock(l).trim()}`) },
  );
  ctx.out.clearLive();
  const raw = run.reportPath ? deps.readJson(run.reportPath) : null;
  const view = readPlanReport(raw) ?? planFromConsole(run.lines, run.code);
  const acct = run.lines.map(stripClock).map((l) => /^SoDEX account\s+(?:(none yet)|#(\d+))/.exec(l)).find(Boolean);
  const refused = run.startError ? [`the runner could not be started: ${run.startError}`] : run.timedOut ? ['the plan did not finish in time'] : !view.steps.length && !view.checklist.length ? refusalLines(run.lines) : [];
  return { run, view, raw, accountId: acct ? (acct[1] ? null : Number(acct[2])) : undefined, refused };
}

/** The plan in the owner's words: account, balances, what each step does and costs. */
function showPlan(ctx: Ctx, p: Planned, o: { steps: boolean }): void {
  const { out } = ctx;
  const v = p.view;
  if (p.accountId !== undefined) out.line(`   SoDEX account ....... ${p.accountId === null ? 'none yet - a brand-new wallet, as expected' : `#${p.accountId} (this wallet has been used on SoDEX before)`}`);
  if (v.balances.length) {
    out.line('   What the wallet holds now:');
    for (const b of v.balances) out.line(`      ${b}`);
  }
  if (o.steps && v.steps.length) {
    out.line('   What the run will do, step by step:');
    for (const s of v.steps) {
      out.line(`      ${s.id.padEnd(26)} ${s.skip ? `skipped - ${s.skip}` : `estimated cost ${fmtUsd(s.costUsd)}${s.sentAwayUsd ? ` + ${fmtUsd(s.sentAwayUsd)} sent to your other address` : ''}`}`);
    }
  }
  if (v.estimatedCostUsd !== null) {
    out.line(`   Estimated cost ...... ${fmtUsd(v.estimatedCostUsd)}${v.estimatedSentAwayUsd ? ` + ${fmtUsd(v.estimatedSentAwayUsd)} sent to your other addresses` : ''}`);
    out.line(`   Spend cap ........... ${fmtUsd(v.maxSpendUsd)} (the run stops before it would lose more than this)`);
  }
  for (const w of [...configWarnings(p.run.lines), ...v.warnings]) out.say(`note: ${w}`, '   ');
}

/** The runner's budget for this plan, in the owner's words: what to fund, what it costs, what goes to your addresses and comes back, how long. */
function showBudget(ctx: Ctx, v: PlanView, title: string): void {
  const b = v.budget;
  if (!b) return;
  const { out } = ctx;
  const needs = fundingStatus(v).needs;
  out.line();
  out.line(`   ${title}`);
  out.line(`      fund the test wallet .... ${needs.length ? needs.map((n) => `${n.amount} ${n.coin} on ${n.chain}`).join(' + ') : 'nothing'} - nothing else, on no other chain`);
  out.line(`      costs ................... ~${fmtUsd(b.costUsd)} (fees, gas, spreads, the activation fee)`);
  out.line(`      sent to your addresses .. ~${fmtUsd(b.sentAwayUsd)}${b.returnsUsd ? ` - of it ~${fmtUsd(b.returnsUsd)} comes back if you send every hand-sent deposit` : ''}`);
  for (const l of b.leftOnChains) out.say(`left on a chain: ${l}`, '      ');
  if (b.ownerWallet.length) {
    out.line('      in your own wallet (OPTIONAL - only for the hand-sent deposits you send):');
    for (const l of b.ownerWallet) out.say(`- ${l}`, '        ');
  }
  if (b.suggestedMaxSpendUsd !== null) out.line(`      spend cap suggested ..... ${fmtUsd(b.suggestedMaxSpendUsd)} (costs + what goes to your addresses, with room)`);
  if (b.minutes.expected !== null) out.line(`      time .................... ~${Math.round(b.minutes.expected)} min expected${b.minutes.worst !== null ? `, at most ~${Math.round(b.minutes.worst)} min before a time-out stops it` : ''}`);
}

// --- the config -------------------------------------------------------------------------------

interface Prepared {
  path: string;
  config: Json;
  names: BuilderKeyNames;
}

/**
 * The run config for this session. `scratch`: a copy in the log folder (a
 * throwaway plan must not touch the owner's config.json). The real-funds
 * acknowledgement is always written as false here.
 */
function prepareConfig(ctx: Ctx, deps: DDeps, o: { scratch: boolean; extra?: ConfigChoices }): { ok: true; cfg: Prepared; created: boolean } | { ok: false; problem: string } {
  const loaded = deps.loadConfig();
  if (loaded.problem) return { ok: false, problem: loaded.problem };
  const base = loaded.existing ?? loaded.example;
  if (!base) return { ok: false, problem: 'neither config.json nor config.example.json could be read' };
  const bad = configProblems(base);
  if (bad.length) return { ok: false, problem: bad[0]! };
  const choices: ConfigChoices = {
    // Both switches start OFF in every session: real funds are acknowledged only for the run the owner confirms,
    // and a wallet that already has an account is only used when the owner says so (below).
    acknowledgeRealFunds: false,
    allowExistingAccount: false,
    ...(ctx.args.backend !== 'http://127.0.0.1:5180' || base.backend !== ctx.args.backend ? { backend: ctx.args.backend } : {}),
    ...(ctx.shared.builder !== undefined ? { builder: ctx.shared.builder } : {}),
    ...o.extra,
  };
  const config = applyChoices(base, choices, loaded.names);
  const path = o.scratch ? join(ctx.paths.logsDir, 'config.plan.json') : ctx.paths.config.config;
  try {
    deps.saveConfig(path, config);
  } catch (e) {
    return { ok: false, problem: `the run config could not be written: ${(e as Error).message}` };
  }
  return { ok: true, cfg: { path, config, names: loaded.names }, created: !loaded.existing };
}

function updateConfig(deps: DDeps, cfg: Prepared, c: ConfigChoices): void {
  cfg.config = applyChoices(cfg.config, c, cfg.names);
  deps.saveConfig(cfg.path, cfg.config);
}

/**
 * The spend cap is the owner's. When the plan's estimate is above it, the guide
 * shows the runner's suggestion and what it covers, and writes it into the run
 * config only on a typed yes - the default is no, so `--yes` never raises it -
 * and never more than the suggestion. Then the plan is read again.
 */
export async function offerSpendCap(ctx: Ctx, deps: DDeps, cfg: Prepared, plan: Planned, notes: string[], replan: () => Promise<Planned>): Promise<Planned> {
  const v = plan.view;
  const s = v.suggestedMaxSpendUsd;
  const over = v.problems.some((p) => /\babove maxSpendUsd\b/.test(p));
  if (!over || s === null || !(s > 0) || (v.maxSpendUsd !== null && s <= v.maxSpendUsd)) return plan;
  const { out } = ctx;
  out.line();
  out.line('   THE SPEND CAP');
  out.say(
    `The run config caps what this run may lose at ${fmtUsd(v.maxSpendUsd)}. The plan estimates ${fmtUsd(v.estimatedCostUsd)} in costs (fees, gas, the activation fee, trading)${v.estimatedSentAwayUsd ? ` + ${fmtUsd(v.estimatedSentAwayUsd)} sent to your other addresses` : ''} - so a live run would not start.`,
    '   ',
  );
  out.say(`The runner suggests a cap of ${fmtUsd(s)}: its estimate with about 30 % room. The cap is a limit, not a price - the run stops before it would lose more, and what it does not spend stays in the wallet.`, '   ');
  // --go: the owner asked for no questions but the key and the start - the cap is set to the
  // suggestion here and shown again right before the YES that starts the run.
  if (ctx.args.go) {
    updateConfig(deps, cfg, { maxSpendUsd: s });
    notes.push(`--go: the spend cap ("maxSpendUsd") in ${cfg.path} was set to ${s} - the runner's suggestion for this plan - and confirmed with the YES that started the run.`);
    out.line(`   Set: "maxSpendUsd": ${s} (you confirm it with YES before anything moves). Reading the plan again...`);
    return replan();
  }
  if (!(await confirm(ctx.ask, `Set the spend cap ("maxSpendUsd") in the run config to ${fmtUsd(s)}?`, false, { money: true }))) {
    ctx.shared.next.push(`The plan's estimate is above the spend cap: set "maxSpendUsd" in ${cfg.path} to at least ${s} (the runner's suggestion), or choose a smaller profile.`);
    return plan;
  }
  updateConfig(deps, cfg, { maxSpendUsd: s });
  notes.push(`On your yes, the spend cap ("maxSpendUsd") in ${cfg.path} was set to ${s} - the runner's suggestion for this plan.`);
  out.line(`   Written: "maxSpendUsd": ${s}. Reading the plan again...`);
  return replan();
}

// --- the key ----------------------------------------------------------------------------------

export interface HeldKey {
  key: `0x${string}`;
  address: string;
}

/**
 * Ask for a wallet's private key with echo off, show the ADDRESS it controls,
 * and let the owner confirm it. From here on every printed or logged line is
 * redacted of this key. Returns null when the owner gives up.
 */
export async function askKey(ctx: Ctx, what: string): Promise<HeldKey | null> {
  const { out } = ctx;
  for (let attempt = 0; attempt < 5; attempt++) {
    out.prompt(` Private key of ${what} (nothing is shown while you type or paste): `);
    const typed = await ctx.ask.prompter.askHidden('');
    if (typed === null) throw new Stopped('the key prompt was closed');
    if (!typed.trim()) {
      out.line('   Nothing was entered. Paste the key and press Enter - or press Ctrl+C to stop.');
      continue;
    }
    const k = normaliseKey(typed);
    if (!k.ok) {
      out.say(k.problem, '   ');
      continue;
    }
    const address = addressOfKey(k.key);
    if (!address) {
      out.line('   That is not a valid key for an Ethereum-style wallet.');
      continue;
    }
    // From now on nothing this process prints or logs can contain this key - nor any key entered before it.
    const earlier = out.redact;
    const mine = makeKeyRedactor(k.key);
    out.redact = (s) => mine(earlier(s));
    out.line();
    out.line(`   This key controls the wallet  ${address}`);
    out.line('   (Only this address is ever shown. The key itself stays in this window\'s memory.)');
    if (await confirm(ctx.ask, 'Is that the wallet you mean?', true, { money: true })) return { key: k.key, address };
    out.line('   Then enter the key of the right wallet.');
  }
  out.line('   Five attempts did not give a usable key. Stopping here.');
  return null;
}

// --- waiting for funds ------------------------------------------------------------------------

export type WaitResult = { state: 'ready'; plan: Planned } | { state: 'not-funded' | 'blocked' | 'stopped' | 'refused'; plan: Planned };

/**
 * Re-run the plan until the wallet holds what the run needs. Each round is the
 * runner's read-only plan with --registry-only. The owner can type q to stop;
 * without a console (or with --no-wait) it checks once.
 */
export async function waitForFunding(ctx: Ctx, deps: DDeps, first: Planned, o: { config: string; key: string | null; address: string; profile: string | null; only: readonly string[] | null; maxWaitMs: number | null }): Promise<WaitResult> {
  const { out } = ctx;
  let plan = first;
  const started = ctx.now();
  let lastMissing = '';
  let round = 0;
  for (;;) {
    checkStop(ctx);
    if (plan.refused.length) return { state: 'refused', plan };
    const st = fundingStatus(plan.view);
    if (st.blockers.length) return { state: 'blocked', plan };
    if (st.funded) return { state: 'ready', plan };
    const missing = missingLine(st);
    if (round === 0) {
      out.line();
      out.line('   SEND THIS TO THE TEST WALLET (and nothing else):');
      for (const l of fundingInstructions(o.address, st, plan.view)) out.line(`      ${l}`);
      out.line();
      out.say('A little more of the gas coin is fine - what is not used stays in the wallet. Send the coins from an exchange or from another wallet of yours; they must arrive on exactly the chain named above.', '   ');
    } else if (missing !== lastMissing) {
      out.line(`   ${clock(ctx)}  something arrived. Still missing: ${missing}`);
    }
    lastMissing = missing;
    const waited = ctx.now() - started;
    if (ctx.args.noWait || (o.maxWaitMs !== null && waited >= o.maxWaitMs)) return { state: 'not-funded', plan };
    if (round === 0) out.line(`   The guide checks again every ${Math.round(POLL_MS / 1000)} seconds and goes on by itself when the funds are there. Type q and Enter to stop waiting.`);
    out.live(`   ${clock(ctx)}  waiting for: ${missing}   (waited ${fmtDur(waited)}; q + Enter stops)`);
    const typed = await ctx.ask.prompter.waitLine(POLL_MS);
    out.clearLive();
    if (typed !== null && ['q', 'quit', 'stop', 'exit'].includes(typed.trim().toLowerCase())) return { state: 'stopped', plan };
    round++;
    plan = await planOnce(ctx, deps, { config: o.config, key: o.key, throwaway: false, registryOnly: true, profile: o.profile, only: o.only, logName: 'D-plan-wait.log' });
  }
}

const clock = (ctx: Pick<Ctx, 'now'>): string => new Date(ctx.now()).toTimeString().slice(0, 8);

// --- rows for the summary ---------------------------------------------------------------------

function planItems(v: PlanView): Item[] {
  return v.steps.map((s) => ({
    id: `step-${s.id}`,
    group: 'runner steps',
    title: s.id,
    status: s.skip ? 'SKIPPED' : 'PLANNED',
    costUsd: s.skip ? null : (s.costUsd ?? 0) + (s.sentAwayUsd ?? 0),
    detail: s.skip ? s.skip : `planned, not executed: ${s.title}`,
  }));
}

function liveItems(v: LiveView): Item[] {
  return v.steps.map((s) => ({
    id: `step-${s.id}`,
    group: 'runner steps',
    title: s.id,
    status: stepItemStatus(s.status),
    ...(s.ms !== null ? { ms: s.ms } : {}),
    costUsd: s.costUsd ?? (s.status === 'ok' ? s.estimateUsd : null),
    detail: s.status === 'ok' ? `${s.title}${s.costUsd === null && s.estimateUsd !== null ? ' (cost: the plan\'s estimate)' : ''}` : s.status === 'skipped' ? s.reason ?? 'skipped' : `${s.status}${s.error ? `: ${s.error}` : ''}`,
    ...(s.txs.length ? { txs: s.txs } : {}),
  }));
}

/** A check from the runner's report as a row of stage D. */
function checkItem(c: RunnerCheck): Item {
  const status: Item['status'] = c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : c.status === 'finding' ? 'FINDING' : c.status === 'warn' ? 'WARN' : 'SKIPPED';
  return { id: `check-${c.id}`, group: 'runner checks', title: c.title, status, detail: c.detail ?? (c.status === 'not-run' ? 'not run' : c.status === 'not-testable' ? 'not testable' : '') };
}

/** Does this run config give the builder the server's terms keys (fee tiers on)? */
function hasTermsKeys(cfg: Json): boolean {
  const b = cfg.builder;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
  return Object.entries(b).some(([k, v]) => /^terms/i.test(k) && (Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim() !== ''));
}

// --- the stage --------------------------------------------------------------------------------

export interface MoneyRunOptions {
  /** Which wallet this is, in the owner's words ("the test wallet"). */
  what: string;
  /** A profile forced by the caller; undefined: the owner chooses. */
  profile?: string | null;
  /** Step headings are printed (stage D); stage C's nested run prints its own. */
  headings: boolean;
}

export async function runStageD(ctx: Ctx, deps: DDeps = realDDeps(ctx)): Promise<StageResult> {
  const startedAt = new Date(ctx.now()).toISOString();
  const t0 = ctx.now();
  const r = await moneyRun(ctx, deps, { what: 'the test wallet', headings: true });
  return { id: 'D', title: STAGE_TITLES.D, status: r.status, startedAt, ms: ctx.now() - t0, items: r.items, notes: r.notes, ...(r.reason ? { reason: r.reason } : {}) };
}

export interface MoneyRunResult {
  status: StageStatus;
  reason?: string;
  items: Item[];
  notes: string[];
  /** The live run finished with exit code 0. */
  completed: boolean;
}

export async function moneyRun(ctx: Ctx, deps: DDeps, o: MoneyRunOptions): Promise<MoneyRunResult> {
  const { out, args } = ctx;
  const items: Item[] = [];
  ctx.shared.partial = items;
  const notes: string[] = [];
  const end = (status: StageStatus, reason?: string, completed = false): MoneyRunResult => ({ status, ...(reason ? { reason } : {}), items, notes, completed });
  const say = (text: string): void => out.say(text, '   ');
  const throwaway = args.planOnly && args.throwawayKey && o.profile === undefined;

  if (deps.readText(join(ctx.paths.web, 'e2e', 'live', 'run.ts')) === null) return end('SKIPPED', 'the live runner (apps/web/e2e/live/run.ts) is not in this checkout');
  if (!ctx.shared.devServerUp) {
    ctx.shared.next.push(`Start the dev servers (npm run dev in the repository folder) and run stage D again: the live runner needs ${args.backend}.`);
    return end('SKIPPED', `the dev server did not answer on ${args.backend} - the live runner needs it`);
  }
  const caps = await detectCapabilities(ctx, deps);

  // ------------------------------------------------------------------ what to test
  if (o.headings) heading(ctx, throwaway ? 'D-plan' : 'D-profile');
  const menu = profileMenu(caps);
  let profile: string | null = o.profile ?? null;
  /** The full test: all-chains with every receiver, every hand-sent deposit offered, the cleanup on. */
  let full = false;
  if (o.profile === undefined) {
    const wanted = args.profile === FULL_TEST.name && caps.profiles.includes(FULL_TEST_PROFILE) ? FULL_TEST_PROFILE : args.profile;
    full = args.profile === FULL_TEST.name && wanted === FULL_TEST_PROFILE;
    if (wanted) {
      if (!caps.profiles.includes(wanted)) {
        say(`The profile "${wanted}" is not available in this runner version${caps.profiles.length ? ` (it has: ${caps.profiles.join(', ')})` : ' (it has no profiles yet)'}.`);
        ctx.shared.next.push(`Stage D was asked for the profile "${wanted}", which this version of the live runner does not have. Run it without --profile, or update the runner.`);
        return end('SKIPPED', `profile "${wanted}" is not available in this runner version`);
      }
      profile = wanted;
    } else if (!menu.available.length) {
      say('This version of the live runner has ONE live run and no profiles yet. It tests, on one chain: a deposit, enabling trading, transfers, limit and market orders on spot and perps, every way out (ValueChain wallet, another address, another chain), and - with a builder configured - the builder fee.');
      // That one run is what the "core" profile will be: only the wider ones are missing.
      const missing = menu.missing.filter((m) => m.name !== 'core');
      if (missing.length) {
        out.line('   Not available in this runner version (they come with a later one):');
        for (const m of missing) out.line(`      - ${m.title}`);
        notes.push(`Not available in this runner version (it has one run and no profiles): ${missing.map((m) => m.name).join(', ')}.`);
      }
    }
  } else if (profile && !caps.profiles.includes(profile)) {
    return end('SKIPPED', `profile "${profile}" is not available in this runner version`);
  }

  // The run config. A throwaway plan works on a scratch copy and leaves config.json alone.
  const prep = prepareConfig(ctx, deps, { scratch: throwaway });
  if (!prep.ok) {
    say(`The run config cannot be used: ${prep.problem}`);
    items.push({ id: 'config', title: 'run config', status: 'FAIL', detail: prep.problem });
    return end('FAIL', prep.problem);
  }
  const cfg = prep.cfg;
  if (!throwaway) {
    out.line(`   Run config: ${cfg.path}${prep.created ? '   (created from config.example.json)' : '   (yours - kept, with the real-funds switch off)'}`);
  }

  /** A plan with a throwaway key: what a brand-new wallet would need for this profile. Reads only. */
  const preview = (p: string | null, logName: string): Promise<Planned> =>
    planOnce(ctx, deps, { config: cfg.path, key: null, throwaway: true, registryOnly: true, profile: p, only: args.only, logName });
  const needsLine = (p: Planned): string => {
    if (p.refused.length) return `could not be planned: ${p.refused[0]}`;
    const st = fundingStatus(p.view);
    const funds = st.needs.map((n) => `${n.amount} ${n.coin} on ${n.chain}`).join(' + ') || 'nothing from other chains';
    const rc = receiversToAsk(p.view.receivers).map((x) => x.name);
    return `needs ${funds}; estimated cost ${fmtUsd(p.view.estimatedCostUsd)}${rc.length ? `; can use addresses of yours for: ${rc.join(', ')}` : ''}`;
  };

  let previewPlan: Planned | null = null;
  const runnerProfileOf = (name: string): string => (name === FULL_TEST.name ? FULL_TEST_PROFILE : name);
  if (o.profile === undefined && !args.profile && menu.available.length) {
    say('Choose what the live run tests. For each choice the guide first asks the runner what it needs (a read-only plan with a throwaway key).');
    const previews = new Map<string, Planned>();
    for (const p of menu.available) {
      checkStop(ctx);
      out.line();
      out.line(`   ${p.title}`);
      for (const c of p.covers) out.line(`      - ${c}`);
      const rp = runnerProfileOf(p.name);
      const pv = previews.get(rp) ?? (await preview(rp, `D-preview-${rp}.log`));
      previews.set(rp, pv);
      out.say(p.name === FULL_TEST.name ? `${needsLine(pv)} - before your addresses: each address you enter adds its withdrawal; the exact budget follows once they are in` : needsLine(pv), '      ');
    }
    for (const m of menu.missing) out.line(`   ${m.title}: not available in this runner version`);
    out.line();
    const usable = menu.available.filter((p) => !previews.get(runnerProfileOf(p.name))!.refused.length);
    if (!usable.length) return end('FAIL', 'the runner could not plan any profile');
    const picked = await choose(
      ctx.ask,
      'Which one?',
      menu.available.map((p) => ({ key: p.name, label: p.title, ...(previews.get(runnerProfileOf(p.name))!.refused.length ? { disabled: 'the runner could not plan it' } : {}) })),
      usable[0]!.name,
    );
    full = picked === FULL_TEST.name;
    profile = runnerProfileOf(picked);
    previewPlan = previews.get(profile) ?? null;
  }
  ctx.shared.profile = profile;
  if (full) {
    // Everything back where it came from at the end: Spot USDC withdrawn to Arbitrum One (one more withdrawal fee).
    updateConfig(deps, cfg, { cleanupEnabled: true });
    notes.push('Full test: the cleanup at the end was switched on (all USDC back to Arbitrum One).');
    say(`The full test: the runner profile "${FULL_TEST_PROFILE}" with every address of yours, every deposit you can send back by hand, ${ctx.shared.builder ? 'the builder fee and its tiers (set up in stage C), ' : ''}and the cleanup at the end (everything sold back to USDC, the USDC withdrawn back to Arbitrum One).`);
    previewPlan = await preview(profile, 'D-preview-full.log');
  }

  // ------------------------------------------------------------------ plan only, throwaway key
  if (throwaway) {
    say('A read-only plan with a throwaway key: the runner makes up a random key in its own memory, reads what a brand-new wallet would need, and signs and sends nothing. No key is asked for.');
    const p = await planOnce(ctx, deps, { config: cfg.path, key: null, throwaway: true, registryOnly: true, profile, only: args.only, logName: 'D-plan.log', show: true });
    return finishPlanOnly(ctx, p, items, notes, end);
  }

  // ------------------------------------------------------------------ what it needs, and receivers
  if (!previewPlan) {
    out.line();
    say('First, what this run needs - asked of the runner with a throwaway key (read-only, nothing is signed).');
    previewPlan = await preview(profile, 'D-preview.log');
  }
  if (previewPlan.refused.length) {
    for (const l of previewPlan.refused) say(l);
    items.push({ id: 'plan', title: 'read-only plan', status: 'FAIL', detail: previewPlan.refused.join('; ') });
    return end('FAIL', 'the runner refused to plan');
  }
  showPlan(ctx, previewPlan, { steps: true });
  out.line(`   A brand-new wallet needs: ${fundingStatus(previewPlan.view).needs.map((n) => `${n.amount} ${n.coin} on ${n.chain}`).join(' + ') || 'nothing from other chains'}`);
  const savedReceivers = receiversSet(cfg.config).filter((r) => r.address);
  if (args.go && savedReceivers.length) {
    // --go: the addresses entered in an earlier session, as they are in the run config.
    say(`Your addresses from the run config (${savedReceivers.length}): ${savedReceivers.map((r) => r.name).join(', ')}.`);
  } else {
    previewPlan = await collectReceivers(ctx, deps, cfg, previewPlan, preview.bind(null, profile, 'D-preview-receivers.log'), full);
  }
  if (previewPlan.view.handDeposits.length && !previewPlan.refused.length) {
    if (args.go) {
      // --go: nothing that waits for a person during the run. The deposits back by hand are left out
      // (reported "skipped (owner)"); the withdrawals to your addresses still run.
      updateConfig(deps, cfg, { manualDeposits: previewPlan.view.handDeposits.map((h) => ({ coin: h.coin, chain: h.chain, amount: 'auto', skip: true })) });
      say('The deposits you would send back by hand are left out (--go runs without waiting for you); the withdrawals to your addresses run.');
      previewPlan = await preview(profile, 'D-preview-hand.log');
    } else {
      previewPlan = await collectHandDeposits(ctx, deps, cfg, previewPlan, preview.bind(null, profile, 'D-preview-hand.log'), full);
    }
  }
  if (previewPlan.view.budget) showBudget(ctx, previewPlan.view, 'THE BUDGET (the runner\'s read-only plan for a brand-new wallet, with your addresses)');

  // ------------------------------------------------------------------ the key
  if (o.headings) heading(ctx, 'D-key');
  if (!ctx.ask.prompter.interactive && !args.planOnly) {
    say('A live run needs a person at the keyboard: the key is typed into a hidden prompt and the run is confirmed by typing the wallet address. This window is not a console (the input comes from a file or another program), so the guide stops here. Nothing was signed or sent.');
    ctx.shared.next.push('Run RUN-LIVE-TESTS.cmd by double-clicking it (or from a normal terminal window) for the live money run.');
    return end('SKIPPED', 'not at a console - a live run is only started by a person');
  }
  say(`Now the private key of ${o.what}.`);
  out.line('    - Use a BRAND-NEW wallet made for this test. Never a wallet that holds other funds.');
  out.line('    - The key is typed or pasted into a hidden prompt. It stays in the memory of this');
  out.line('      window and is handed to the test runner only. It is never written to a file,');
  out.line('      a log or the summary, and it is gone when this window closes.');
  out.line('    - To paste: right-click in the window (or Ctrl+V), then press Enter.');
  out.line('    - Where to get it: in MetaMask, create a new account, then Account details ->');
  out.line('      Show private key. Other wallets have the same under "export private key".');
  out.line();
  const held = await askKey(ctx, o.what);
  if (!held) return end('SKIPPED', 'no usable key was entered');
  ctx.shared.wallet = held.address;
  out.say('Tip: if you pasted the key, it is still in your clipboard. Copy something else when you are done here.', '   ');
  // An address of yours that IS the test wallet (one SafePal wallet for everything): sending to it
  // is sending to itself - that step is left out instead of failing the run.
  for (const r of receiversSet(cfg.config)) {
    if (r.address && sameAddress(r.address, held.address)) {
      updateConfig(deps, cfg, { receivers: { [r.name]: '' } });
      say(`Your "${r.name}" address is this test wallet itself, so the step that sends to "another address of yours" is left out.`);
    }
  }
  const builderAddress = ctx.shared.builderAddress;
  if (o.profile === undefined && builderAddress && sameAddress(builderAddress, held.address)) {
    say('That is the BUILDER wallet. The test wallet must be a different one: it is the user who pays the fee. Start again with another wallet.');
    return end('SKIPPED', 'the test wallet is the builder wallet');
  }

  // ------------------------------------------------------------------ plan with the real wallet
  if (o.headings) heading(ctx, args.planOnly ? 'D-plan' : 'D-fund');
  let only: string[] | null = args.only;
  say(`Reading what ${held.address} holds and what the run needs (the runner's read-only plan)...`);
  let plan = await planOnce(ctx, deps, { config: cfg.path, key: held.key, throwaway: false, registryOnly: true, profile, only, logName: 'D-plan.log' });
  if (plan.view.wallet && !sameAddress(plan.view.wallet, held.address)) {
    items.push({ id: 'plan', title: 'read-only plan', status: 'FAIL', detail: 'the runner derived another address from the key than the guide did' });
    return end('FAIL', 'the runner and the guide disagree about the wallet address - nothing was started');
  }

  // A wallet SoDEX already knows: either a resume, or the wrong wallet. Always the owner's decision -
  // the config's own switch was set to "refuse" when this session prepared it.
  if (!args.planOnly && plan.accountId !== undefined && plan.accountId !== null) {
    const earlier = latestStoppedRun(deps, held.address, caps);
    out.line();
    say(`This wallet already has a SoDEX account (#${plan.accountId}). The test expects a brand-new wallet.`);
    if (only) {
      say(`You started the guide with --only ${only.join(',')}: those steps are run with this account. Each of them moves its configured amount again.`);
    } else if (args.go && earlier) {
      // --go: the owner asked for no questions. What passed whole is not repeated; the rest runs again.
      only = earlier.retest;
      say(`--go: the earlier run of this wallet did not pass everything. Running again ONLY what did not pass or was not run: ${only.join(', ')}.`);
      say('Steps that passed whole (their money moved already) are left out. The earlier report:');
      out.line(`      ${earlier.path}`);
    } else {
      if (earlier) say(`An earlier live run with this wallet stopped at the step "${earlier.resume.stoppedAt}". What did not pass or was not run can be run again (${earlier.retest.join(', ')}).`);
      // The default is to stop, so `--yes` (which only ever takes defaults) never goes on with a used wallet.
      const pick = await choose(
        ctx.ask,
        'What now?',
        [
          ...(earlier ? [{ key: 'resume' as const, label: `Resume the earlier run: ${earlier.retest.join(', ')}` }] : []),
          { key: 'continue' as const, label: 'Run the whole test with this wallet anyway (the first deposit pays no activation fee)' },
          { key: 'stop' as const, label: 'Stop - I will use a brand-new wallet' },
        ],
        'stop',
      );
      if (pick === 'stop') return end('SKIPPED', 'the wallet already has a SoDEX account - use a brand-new wallet');
      if (pick === 'resume' && earlier) {
        only = earlier.retest;
        say('Each resumed step moves its configured amount again. Look at the earlier report if you are not sure what already happened:');
        out.line(`      ${earlier.path}`);
      }
    }
    updateConfig(deps, cfg, { allowExistingAccount: true });
    if (only?.includes('builder-tiers')) await resetTierWallet(ctx, deps, cfg.config, held.address);
    plan = await planOnce(ctx, deps, { config: cfg.path, key: held.key, throwaway: false, registryOnly: true, profile, only, logName: 'D-plan.log' });
  }
  showPlan(ctx, plan, { steps: false });
  ctx.shared.planReport = plan.raw;

  if (args.planOnly) return finishPlanOnly(ctx, plan, items, notes, end);

  // ------------------------------------------------------------------ the spend cap (the owner's)
  plan = await offerSpendCap(ctx, deps, cfg, plan, notes, () => planOnce(ctx, deps, { config: cfg.path, key: held.key, throwaway: false, registryOnly: true, profile, only, logName: 'D-plan.log' }));

  // ------------------------------------------------------------------ funding
  const maxWaitMs = args.waitMinutes !== null ? args.waitMinutes * 60_000 : ctx.ask.prompter.interactive ? null : 0;
  const waited = await waitForFunding(ctx, deps, plan, { config: cfg.path, key: held.key, address: held.address, profile, only, maxWaitMs });
  plan = waited.plan;
  ctx.shared.planReport = plan.raw ?? ctx.shared.planReport;
  if (waited.state !== 'ready') {
    const st = fundingStatus(plan.view);
    if (waited.state === 'refused') {
      for (const l of plan.refused) say(l);
      items.push({ id: 'plan', title: 'read-only plan', status: 'FAIL', detail: plan.refused.join('; ') });
      return end('FAIL', 'the runner refused to plan');
    }
    if (waited.state === 'blocked') {
      out.line();
      say('The run cannot start, and waiting will not change it:');
      for (const b of st.blockers) out.say(`- ${b}`, '      ');
      items.push({ id: 'plan', title: 'read-only plan', status: 'FAIL', detail: st.blockers.join('; ') }, ...planItems(plan.view));
      ctx.shared.next.push('Stage D: fix what the plan reports (above), then start the guide again. Nothing was signed or sent.');
      return end('FAIL', 'the plan has problems that funding does not fix');
    }
    items.push({ id: 'plan', title: 'read-only plan', status: 'PASS', ms: plan.run.ms, detail: `works; the wallet is not funded yet: ${missingLine(st)}` }, ...planItems(plan.view));
    ctx.shared.next.push(`Fund the test wallet ${held.address} (${missingLine(st)}), then start the guide again with --stages D. Nothing was signed or sent.`);
    return end('SKIPPED', waited.state === 'stopped' ? 'you stopped waiting for the funds - no live run' : 'the wallet is not funded - no live run');
  }
  out.line(`   ${clock(ctx)}  The wallet holds what the run needs.`);

  // ------------------------------------------------------------------ the live run
  if (o.headings) heading(ctx, 'D-live');
  say('One more read-only plan, this time the complete one: it also asks SoDEX for the wallet\'s deposit address - the same as opening the Deposit sheet in the app. No funds move.');
  const finalPlan = await planOnce(ctx, deps, { config: cfg.path, key: held.key, throwaway: false, registryOnly: false, profile, only, logName: 'D-plan-final.log' });
  ctx.shared.planReport = finalPlan.raw ?? ctx.shared.planReport;
  const fst = fundingStatus(finalPlan.view);
  if (finalPlan.refused.length || !fst.ready) {
    const why = finalPlan.refused.length ? finalPlan.refused : [...fst.blockers, ...fst.fundingProblems];
    say('The complete plan says a live run would not start:');
    for (const b of why) out.say(`- ${b}`, '      ');
    items.push({ id: 'plan', title: 'read-only plan', status: 'FAIL', detail: why.join('; ') }, ...planItems(finalPlan.view));
    ctx.shared.next.push('Stage D: fix what the plan reports, then start the guide again. Nothing was signed or sent.');
    return end('FAIL', 'the complete plan has problems');
  }
  items.push({ id: 'plan', title: 'read-only plan', status: 'PASS', ms: finalPlan.run.ms, detail: `a live run would start; estimated cost ${fmtUsd(finalPlan.view.estimatedCostUsd)}` });
  out.line();
  out.line('   THE LIVE RUN');
  out.line(`   wallet .............. ${held.address}`);
  if (profile) out.line(`   profile ............. ${profile}`);
  showPlan(ctx, finalPlan, { steps: true });
  for (const l of describeConfig(cfg.config)) out.line(`   ${l}`);
  if (finalPlan.view.budget) showBudget(ctx, finalPlan.view, 'THE BUDGET');
  const handSends = finalPlan.view.handDeposits.filter((h) => h.state === 'send');
  if (handSends.length) {
    out.line();
    out.line(`   DEPOSITS YOU SEND BY HAND (${handSends.length}, each optional)`);
    say('Near the end the run shows them one at a time: exactly which coin, on which network, how much (never below SoDEX\'s deposit minimum - your wallet\'s network fee comes on top) and to which address (the one the app and SoDEX\'s on-chain registry both name). Send it from your wallet and the run goes on by itself once SoDEX credits it. To skip one: type s and Enter while it waits ("skip all" skips the rest) - it is then reported as skipped (owner). Skipping never stops the run.');
  }
  out.line();
  out.line('   BEFORE YOU START: close every other Valuescan tab and every sodex.com tab.');
  say('SoDEX allows about four history reads a minute per internet address. The run and the server\'s fee check need them; another open tab can use them up, SoDEX then blocks this address for a minute, and the run fails.');
  if (!args.go) await pressEnter(ctx.ask, 'Press Enter when the other tabs are closed.');
  const tiersOn = hasTermsKeys(cfg.config);
  if (tiersOn) {
    out.line();
    out.line('   ABOUT THE FEE-CHANGE TEST: it works ONCE per wallet.');
    say(`The run places two "cheating" orders on purpose (one with a lower fee, one without the builder) to prove they are not credited. After that the server keeps this wallet on the default fee for 30 days. A resumed run (--go, or "Resume the earlier run") makes the LOCAL server forget this test wallet before the fee test runs again; for another backend: in the folder apps/server on its computer,  npx tsx tools/builderTiers.ts forget --address ${held.address}`);
  }
  out.line();
  say(`This moves REAL money: the run deposits, trades and withdraws with the wallet above, up to the spend cap of ${fmtUsd(finalPlan.view.maxSpendUsd)} (costs + what goes to your own addresses).`);
  if (!(await typeExactly(ctx.ask, 'Type YES (in capitals) to allow it, or q to stop:', 'YES', { exactCase: true }))) {
    items.push(...planItems(finalPlan.view));
    ctx.shared.next.push(`Stage D stopped before the live run: you did not confirm. The funds are still in the test wallet ${held.address}.`);
    return end('SKIPPED', 'not confirmed - no live run');
  }
  if (!(await typeExactly(ctx.ask, 'Type the wallet address to start the run:', held.address))) {
    items.push(...planItems(finalPlan.view));
    ctx.shared.next.push(`Stage D stopped before the live run: the wallet address was not typed. The funds are still in the test wallet ${held.address}.`);
    return end('SKIPPED', 'the wallet address was not confirmed - no live run');
  }

  // Only now, and only for this run.
  updateConfig(deps, cfg, { acknowledgeRealFunds: true });
  out.line();
  out.line('   Starting. Everything below is the runner\'s own output, live.');
  out.line('   To stop: press Ctrl+C ONCE - the runner then reads where the funds are and writes its report.');
  out.rule();
  let live: RunnerRun;
  try {
    live = await deps.runner(
      { mode: 'live', config: cfg.path, confirm: held.address, only, reportDir: ctx.paths.reportDir, profile },
      { key: held.key, logName: 'D-live.log', protect: true, input: true, onLine: (l) => out.line(`   ${l}`) },
    );
  } finally {
    // The acknowledgement was for this run only.
    try {
      updateConfig(deps, cfg, { acknowledgeRealFunds: false });
    } catch {
      notes.push('The real-funds switch in config.json could not be switched off again - set "acknowledgeRealFunds": false by hand.');
    }
  }
  out.rule();

  const raw = live.reportPath ? deps.readJson(live.reportPath) : null;
  const view = readLiveReport(raw);
  ctx.shared.liveReport = raw;
  ctx.shared.liveReportPath = live.reportPath;
  if (live.reportPath) {
    for (const p of summaryPathsFor(live.reportPath)) {
      const md = deps.readText(p);
      if (md !== null) {
        ctx.shared.runnerSummaryMd = md;
        ctx.shared.runnerSummaryPath = p;
        break;
      }
    }
  }
  if (view) items.push(...liveItems(view));
  else items.push({ id: 'live', title: 'live run', status: live.code === 0 ? 'PASS' : 'FAIL', ms: live.ms, detail: live.startError ?? `exit code ${live.code}; the runner's report could not be read` });
  // The runner's own checks are rows too: a check it reports as failed fails the stage, whatever its exit code says.
  const checks = readChecks(raw);
  items.push(...checks.map(checkItem));
  if (tiersOn) {
    ctx.shared.next.push(`The fee-change test works once per wallet: after the cheating-orders check the server keeps ${held.address} on the default fee for 30 days. For another run use a brand-new wallet, or first run in the folder apps/server:  npx tsx tools/builderTiers.ts forget --address ${held.address}`);
  }

  if (live.code === 0) {
    const failedChecks = checks.filter((c) => c.status === 'fail');
    const found = checks.filter((c) => c.status === 'finding');
    if (found.length) ctx.shared.next.push(`Read the ${found.length} finding(s) of the live run at the top of the summary: they are not failures, they say how SoDEX behaved.`);
    if (failedChecks.length) {
      out.line(`   The live run reached its end, but ${failedChecks.length} of its checks FAILED:`);
      for (const c of failedChecks) out.say(`- ${c.title}: ${c.detail ?? 'no detail'}`, '      ');
      ctx.shared.next.push(`The live run finished, but ${failedChecks.length} check(s) failed (${failedChecks.map((c) => c.id).join(', ')}). They are at the top of the summary, with the runner's evidence.`);
      return end('FAIL', `${failedChecks.length} check(s) of the live run failed`, true);
    }
    out.line(`   The live run finished: every step passed (${fmtDur(live.ms)}).`);
    ctx.shared.next.push(`The live run passed. What is left of the funds is listed under "Where every coin is"; move it out of the test wallet ${held.address} in the app when you are done, and do not reuse that wallet for real funds.`);
    return end('PASS', undefined, true);
  }
  // It stopped. Where the funds are is in the runner's output above and in the summary; say how to go on.
  const resume = view ? resumeSteps(view, caps.steps, plannedSkips(raw)) : { stoppedAt: null, remaining: [] as string[] };
  // What a resume runs: every step that did not pass whole (a step can end "ok" with checks unjudged).
  const again = view ? retestSteps(view, caps.steps, plannedSkips(raw)) : [];
  out.line();
  out.line(`   THE RUN STOPPED${resume.stoppedAt ? ` at the step "${resume.stoppedAt}"` : ''} (exit code ${live.code}${live.code === 130 ? ': interrupted' : live.code === 2 ? ': refused before anything was signed' : ''}).`);
  if (view?.whereFunds.length) {
    out.line('   Where the funds are now:');
    for (const l of view.whereFunds) out.line(`   ${l}`);
    for (const f of view.inFlight) out.line(`     IN FLIGHT: ${f}`);
  } else {
    say('Where the funds are: see the runner\'s output above ("Where the funds are now"). If it could not read the balances, connect the wallet in the app and look there.');
  }
  if (again.length) {
    out.line();
    out.line('   TO RESUME, after fixing the cause:');
    out.line('     - start RUN-LIVE-TESTS.cmd --go again and enter the same key: it runs only what did not pass or was not run; or');
    out.line('     - start RUN-LIVE-TESTS.cmd again, enter the same key, and choose "Resume the earlier run"; or');
    out.line('     - by hand (the guide switches the real-funds acknowledgement off after every run, so set');
    out.line('       "acknowledgeRealFunds": true and "allowExistingAccount": true in the config first):');
    for (const l of resumeCommand(held.address, again)) out.line(`         ${l}`);
    say('Each resumed step moves its configured amount again - check the report before repeating a step that had already sent something.');
    ctx.shared.next.push(`The live run stopped at "${resume.stoppedAt}". Fix the cause, then start RUN-LIVE-TESTS.cmd --go again with the same wallet (steps to run again: ${again.join(', ')}).`);
  } else {
    ctx.shared.next.push('The live run did not finish. Read the runner\'s output in the log folder, fix the cause and start the guide again.');
  }
  return end('FAIL', `the live run stopped${resume.stoppedAt ? ` at ${resume.stoppedAt}` : ''}`);
}

/** The end of a plan-only run: the plan is the result. */
function finishPlanOnly(ctx: Ctx, p: Planned, items: Item[], notes: string[], end: (status: StageStatus, reason?: string) => MoneyRunResult): MoneyRunResult {
  const { out } = ctx;
  ctx.shared.planReport = p.raw;
  // The wallet of this plan: keep the spelling the owner confirmed when it is the same address.
  const planned = p.view.wallet ?? findWallet(p.run.lines);
  if (!ctx.shared.wallet || !planned || !sameAddress(ctx.shared.wallet, planned)) ctx.shared.wallet = planned;
  if (p.refused.length) {
    for (const l of p.refused) out.say(l, '   ');
    items.push({ id: 'plan', title: 'read-only plan', status: 'FAIL', ms: p.run.ms, detail: p.refused.join('; ') });
    return end('FAIL', 'the runner refused to plan');
  }
  const st = fundingStatus(p.view);
  if (p.run.code === 1 || st.blockers.length) {
    out.line();
    out.say('The plan has problems that funding would not fix:', '   ');
    for (const b of st.blockers) out.say(`- ${b}`, '      ');
    items.push({ id: 'plan', title: 'read-only plan', status: 'FAIL', ms: p.run.ms, detail: st.blockers.join('; ') || `the runner exited with code ${p.run.code}` }, ...planItems(p.view));
    return end('FAIL', 'the plan has problems');
  }
  out.line();
  out.line('   What a live run would need in the wallet:');
  // The address as the owner saw it (checksummed) when the guide derived it; else as the runner printed it.
  const shown = ctx.shared.wallet && p.view.wallet && sameAddress(ctx.shared.wallet, p.view.wallet) ? ctx.shared.wallet : p.view.wallet;
  for (const l of fundingInstructions(shown ?? 'the test wallet', st, p.view)) out.line(`      ${l}`);
  out.line(`   Estimated cost ${fmtUsd(p.view.estimatedCostUsd)}, spend cap ${fmtUsd(p.view.maxSpendUsd)}.`);
  items.push(
    { id: 'plan', title: 'read-only plan', status: 'PASS', ms: p.run.ms, detail: `${p.view.steps.filter((s) => !s.skip).length} steps planned, estimated cost ${fmtUsd(p.view.estimatedCostUsd)}; nothing was signed or sent` },
    ...planItems(p.view),
  );
  notes.push('Plan only: nothing was signed or sent.');
  ctx.shared.next.push('Stage D ran as a plan only. For the real run start RUN-LIVE-TESTS.cmd without --plan-only, at a console.');
  return end('PASS');
}

/**
 * The newest earlier live run of this wallet that did not finish: where it stopped, and what has
 * to run again (`retest`: every step that did not pass whole - runner.ts retestSteps).
 */
function latestStoppedRun(deps: DDeps, address: string, caps: Capabilities): { path: string; resume: ReturnType<typeof resumeSteps>; retest: string[] } | null {
  for (const path of deps.liveReports().slice(0, 20)) {
    const raw = deps.readJson(path);
    const v = readLiveReport(raw);
    if (!v || v.mode !== 'live' || !v.wallet || !sameAddress(v.wallet, address)) continue;
    if (v.exitCode === 0) return null; // the newest run of this wallet finished
    const resume = resumeSteps(v, caps.steps, plannedSkips(raw));
    const retest = retestSteps(v, caps.steps, plannedSkips(raw));
    return retest.length ? { path, resume, retest } : null;
  }
  return null;
}

const isLocalOrigin = (origin: string): boolean => {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
};

/**
 * The fee test runs again on a wallet the server already knows (its volume counted, flagged by the
 * cheating orders): it could not show the default fee. The record of the TEST wallet is removed
 * from the LOCAL server's ledger first (builderTiers.ts forget - the server reads the ledger on
 * every request, no restart). Another backend's ledger is not on this computer: its command is shown.
 */
async function resetTierWallet(ctx: Ctx, deps: DDeps, config: Json, address: string): Promise<void> {
  const backend = typeof config.backend === 'string' && config.backend ? config.backend : ctx.args.backend;
  const cmd = `npx tsx tools/builderTiers.ts forget --address ${address}   (in apps/server, on the server's computer)`;
  if (!isLocalOrigin(backend) || !deps.forgetTierWallet) {
    ctx.out.say(`The fee test runs again: the server at ${backend} must forget this test wallet first, or the fee checks are skipped: ${cmd}`, '   ');
    ctx.shared.next.push(`Before the next fee test with ${address}: ${cmd}`);
    return;
  }
  // The local server counts volume as the live site does: by the last LIVE_VOLUME_DAYS days (not lifetime).
  if (deps.setTierWindow) {
    const w = await deps.setTierWindow(LIVE_VOLUME_DAYS);
    ctx.out.say(
      w.ok
        ? `The local server's fee tiers go by the volume of the last ${LIVE_VOLUME_DAYS} days, as on the live site (${w.detail}).`
        : `The local server's volume window could not be set (${w.detail}) - its tiers may go by lifetime volume. By hand: npx tsx tools/builderTiers.ts set-window --days ${LIVE_VOLUME_DAYS}   (in apps/server)`,
      '   ',
    );
  }
  const r = await deps.forgetTierWallet(address);
  ctx.out.say(
    r.ok
      ? `The fee test runs again: the local server's fee record of this test wallet was reset (${r.detail}), so it starts on the default fee.`
      : `The fee test runs again, but the local server's fee record of this test wallet could not be reset (${r.detail}) - the fee checks that need a fresh wallet are skipped. By hand: ${cmd}`,
    '   ',
  );
}

/**
 * Addresses of the owner's that the run can send to (another ValueChain
 * address, a wallet on a chain this computer cannot sign on). Each is typed,
 * written to the private config, and then VALIDATED BY THE RUNNER: its plan is
 * run again and whatever it says about the address is shown.
 */
async function collectReceivers(ctx: Ctx, deps: DDeps, cfg: Prepared, first: Planned, replan: () => Promise<Planned>, full = false): Promise<Planned> {
  const { out } = ctx;
  let plan = first;
  for (let round = 0; round < 3; round++) {
    const ask = receiversToAsk(plan.view.receivers);
    if (!ask.length) return plan;
    const set: Record<string, ReceiverValue> = {};
    out.line();
    if (round === 0) {
      if (full) {
        out.line('   YOUR ADDRESSES (one wallet of yours - e.g. SafePal - holds them all)');
        out.say('The run withdraws to your own address on each chain below; everything lands in your wallet. Copy each address from your wallet\'s "Receive" screen for exactly that coin and network. Each is optional: press Enter to leave one out, and the withdrawals there are skipped.', '   ');
      } else out.say('The run can also send to addresses of yours. Each is optional: press Enter to leave one out, and the steps that need it are skipped.', '   ');
    }
    for (const n of ask) {
      checkStop(ctx);
      const current = receiversSet(cfg.config).find((r) => r.name === n.name)?.address;
      out.line(`   "${n.name}"${n.chain ? ` (${n.chain})` : ''}: ${n.problem ? `the runner says: ${n.problem}` : n.why || 'needed by a step of this run'}`);
      if (ctx.ask.auto) {
        out.line('      left out (--yes never enters an address)');
        if (n.problem && current) set[n.name] = '';
        continue;
      }
      let address = current ?? '';
      if (!n.set || n.problem) {
        out.prompt(`      Address for "${n.name}" (Enter = leave it out): `);
        const typed = await ctx.ask.prompter.ask('');
        if (typed === null) throw new Stopped('the input ended');
        address = typed.trim();
        // A Sui address IS 0x + 64 hex characters - the size of a key - so it is not refused there.
        if (looksLikeKey(address) && !(n.name === 'sui' && /^0x[0-9a-fA-F]{64}$/.test(address))) {
          out.line('      That is the size of a PRIVATE KEY. Never enter a key here - this wants an ADDRESS. Left out.');
          address = '';
        } else if (address && (/\s/.test(address) || address.length > 130)) {
          out.line('      That does not look like an address. Left out.');
          address = '';
        }
      }
      if (!address) {
        set[n.name] = '';
        continue;
      }
      if (n.memo) {
        out.say('A memo (destination tag) is only for an account at an exchange. Your own wallet (SafePal and the like) needs none.', '      ');
        out.prompt('      Memo - press Enter for none (your own wallet), or type the digits an exchange gave you: ');
        const memo = ((await ctx.ask.prompter.ask('')) ?? '').trim();
        if (!memo || /^(none|no|-)$/i.test(memo)) set[n.name] = { address, noMemo: true };
        else if (/^\d{1,20}$/.test(memo)) set[n.name] = { address, memo };
        else {
          out.line('      Neither digits nor empty. Left out.');
          set[n.name] = '';
        }
      } else set[n.name] = address;
    }
    if (!Object.keys(set).length) return plan;
    updateConfig(deps, cfg, { receivers: set });
    if (!Object.values(set).some((v) => v !== '')) return plan;
    out.line('   Asking the runner to check these addresses (read-only)...');
    plan = await replan();
    if (plan.refused.length) {
      for (const l of plan.refused) out.say(l, '   ');
      // An address the runner's config check rejects outright: take them out again and go on without.
      updateConfig(deps, cfg, { receivers: Object.fromEntries(Object.keys(set).map((k) => [k, ''])) });
      out.line('   Those addresses were taken out again.');
      return replan();
    }
    const still = receiversToAsk(plan.view.receivers).filter((n) => n.set && n.problem);
    if (!still.length) {
      out.line('   The runner accepts them.');
      return plan;
    }
  }
  // Three rounds without an accepted address: leave the rejected ones out.
  const rejected = receiversToAsk(plan.view.receivers).filter((n) => n.set && n.problem);
  if (rejected.length) {
    updateConfig(deps, cfg, { receivers: Object.fromEntries(rejected.map((n) => [n.name, ''])) });
    out.line(`   Left out after three tries: ${rejected.map((n) => n.name).join(', ')}.`);
    return replan();
  }
  return plan;
}

/**
 * The deposits the owner can send back by hand (profile all-chains): listed with
 * what each takes, offered as a whole, single ones can be left out. Written as
 * "auto" amounts - the runner computes them (never below SoDEX's deposit minimum)
 * - with `skip` for the ones left out (reported "skipped (owner)"). Then the plan
 * is read again.
 */
async function collectHandDeposits(ctx: Ctx, deps: DDeps, cfg: Prepared, first: Planned, replan: () => Promise<Planned>, full: boolean): Promise<Planned> {
  const { out } = ctx;
  const offers = first.view.handDeposits;
  if (!offers.length) return first;
  out.line();
  out.line('   DEPOSITS YOU SEND BACK BY HAND (optional)');
  out.say('The run withdraws to your addresses above. It can also test the way IN from those chains: during the run it shows, one at a time, exactly what to send from your wallet - coin, network, amount (at least SoDEX\'s deposit minimum; your wallet\'s network fee comes on top) and the verified SoDEX address - and waits until SoDEX credits it. Each one is optional: leave it out here, or type s and Enter while the run waits for it.', '   ');
  offers.forEach((h, i) => out.say(`${i + 1}. ${h.line}`, '      '));
  const want = await confirm(ctx.ask, 'Include these deposits you send by hand in the run?', full);
  let drop = new Set<number>();
  if (want) {
    drop = await askValue(
      ctx.ask,
      'Leave any out? Type their numbers (e.g. 2,5), or press Enter to keep them all:',
      (raw) => {
        const t = raw.trim();
        if (!t) return { ok: true, value: new Set<number>() };
        const nums = t.split(/[\s,]+/).filter(Boolean).map(Number);
        if (nums.some((x) => !Number.isInteger(x) || x < 1 || x > offers.length)) return { ok: false, problem: `Numbers from 1 to ${offers.length}, separated by commas - or just Enter.` };
        return { ok: true, value: new Set(nums) };
      },
      { auto: '' },
    );
  }
  const list = offers.map((h, i) => ({ coin: h.coin, chain: h.chain, amount: 'auto', ...(!want || drop.has(i + 1) ? { skip: true } : {}) }));
  updateConfig(deps, cfg, { manualDeposits: list });
  const sends = list.filter((d) => !d.skip).length;
  out.line(`   Written: ${sends} deposit(s) you send by hand${list.length - sends ? `, ${list.length - sends} left out (reported "skipped (owner)")` : ''}. Asking the runner for the exact amounts (read-only)...`);
  return replan();
}

/** The runner's own fee table for the summary, if it provides one. */
export function feeTableOf(ctx: Pick<Ctx, 'shared'>): string[] | null {
  const live = readLiveReport(ctx.shared.liveReport);
  return extractFeeTable(ctx.shared.runnerSummaryMd, live?.feeTable ?? null);
}
