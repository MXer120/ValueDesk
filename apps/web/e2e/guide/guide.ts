/**
 * The guided test run - what RUN-LIVE-TESTS.cmd starts.
 *
 *   node --import tsx e2e/guide/guide.ts [--stages A,B] [--yes] [--plan-only [--throwaway-key]] ...
 *   (from apps/web; `--help` lists every option)
 *
 * It walks the owner through everything that can be tested before launch, in
 * numbered steps, and ends with one summary:
 *
 *   A  offline suites         typechecks and every offline test        stageA.ts
 *   B  read-only live checks  exchanges, market data, our own API      stageB.ts
 *   C  builder account        check / set up, fee tiers, settings      stageC.ts
 *   D  live money run         the live runner, with a test wallet      stageD.ts
 *   E  summary                screen + Markdown + JSON, scrubbed       summary.ts
 *
 * THE KEY. The guide asks for it itself, hidden, in stage D. It is refused as
 * an argument (args.ts) and in the config file (config.ts). If the shell that
 * started the guide has VS_E2E_KEY set, that variable is dropped from this
 * process before anything else happens - without being read - so no child can
 * inherit it; the only child that ever gets a key is the live runner, from
 * proc.childEnv, with the key typed here.
 */
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { USAGE, parseArgs, type GuideArgs } from './args';
import { heading, newShared, type Ctx, type Paths } from './context';
import { GUIDE_DIR, KEY_ENV, REPO_DIR, WEB_DIR, killTree, runProcess, toolchain } from './proc';
import { StdinPrompter, windowsClipboard } from './prompt';
import { readLiveReport, readPlanReport } from './runner';
import { needsDevServer, planSteps } from './stages';
import { runStageA } from './stageA';
import { runStageB } from './stageB';
import { runStageC } from './stageC';
import { feeTableOf, runStageD } from './stageD';
import { buildSummary } from './summary';
import { STAGE_TITLES, Stopped, skippedStage, type StageId, type StageResult } from './types';
import { Output, fmtDur, toAscii } from './ui';

// 1. The key variable is never read here. Whatever the shell exported is dropped before anything can inherit it.
let keyVarWasSet = false;
for (const k of Object.keys(process.env)) {
  if (k.toUpperCase() === KEY_ENV) {
    keyVarWasSet = true;
    delete process.env[k];
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The screen, once it exists - so that even a last-resort error message passes its redactor. */
let screen: Output | null = null;

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${toAscii(parsed.error)}\n\nRUN-LIVE-TESTS.cmd --help  lists the options.\n`);
    return 2;
  }
  const args = parsed.args;
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const reportDir = args.reportDir ? resolve(args.reportDir) : join(WEB_DIR, 'e2e', 'live', 'reports');
  const paths: Paths = {
    repo: REPO_DIR,
    web: WEB_DIR,
    guide: GUIDE_DIR,
    reportDir,
    logsDir: join(reportDir, `${stamp}-all-logs`),
    stamp,
    config: {
      config: args.config ? resolve(args.config) : join(WEB_DIR, 'e2e', 'live', 'config.json'),
      example: join(WEB_DIR, 'e2e', 'live', 'config.example.json'),
      runnerSource: join(WEB_DIR, 'e2e', 'live', 'config.ts'),
    },
  };

  // The screen, and a transcript of it in the log folder (the same redacted lines).
  let transcriptReady = false;
  const transcript = (line: string): void => {
    try {
      if (!transcriptReady) {
        mkdirSync(paths.logsDir, { recursive: true });
        transcriptReady = true;
      }
      appendFileSync(join(paths.logsDir, 'guide-console.log'), `${line}\n`, 'utf8');
    } catch {
      /* the transcript is a convenience */
    }
  };
  const out = new Output((s) => process.stdout.write(s), { tty: process.stdout.isTTY === true, columns: () => process.stdout.columns, transcript });
  screen = out;
  const prompter = new StdinPrompter(process.stdin, (s) => process.stdout.write(toAscii(s)), { clipboard: windowsClipboard });

  const children = new Set<ChildProcess>();
  const liveRuns = new Set<ChildProcess>();
  let stops = 0;
  process.on('SIGINT', () => {
    stops++;
    out.clearLive();
    if (liveRuns.size) {
      // The runner got the same Ctrl+C and is reading where the funds are: wait for it.
      process.stdout.write('\n Ctrl+C: the live run is stopping - it reads where the funds are and writes its report. Wait for it.\n');
      return;
    }
    if (stops > 1) process.exit(130);
    process.stdout.write('\n Ctrl+C: stopping. The summary of what ran so far follows. (Press Ctrl+C again to quit at once.)\n');
    prompter.interrupt();
    for (const c of children) killTree(c);
  });

  const ctx: Ctx = {
    args,
    out,
    ask: { out, prompter, auto: args.yes },
    steps: planSteps(args),
    paths,
    tools: toolchain(),
    env: { ...process.env },
    now: () => Date.now(),
    sleep,
    fetch: (input, init) => fetch(input, init),
    run: runProcess,
    children,
    liveRuns,
    stopRequested: () => stops > 0,
    shared: newShared(),
  };

  out.banner('VALUESCAN - GUIDED TEST RUN', startedAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC');
  out.say(`This guide tests everything that can be tested before launch, step by step, and ends with one summary. It tells you what to do whenever it needs you. Stages in this run: ${args.stages.map((s) => `${s} (${STAGE_TITLES[s].toLowerCase()})`).join(', ')}.`);
  if (args.yes) out.say('--yes: questions that do not involve money are answered with their default. A key and a real-funds confirmation are always asked.');
  if (args.planOnly) out.say('--plan-only: stage D stops after the read-only plan. Nothing is signed or sent in this run.');

  const results: StageResult[] = [];
  let stopped: string | null = null;

  // ---------------------------------------------------------------- check this computer
  try {
    await prepare(ctx, keyVarWasSet);
  } catch (e) {
    if (e instanceof Stopped) stopped = e.why;
    else throw e;
  }

  // ---------------------------------------------------------------- the stages
  const runners: Record<StageId, () => Promise<StageResult>> = {
    A: async () => {
      heading(ctx, 'A');
      return runStageA(ctx);
    },
    B: async () => {
      heading(ctx, 'B');
      return runStageB(ctx);
    },
    C: async () => {
      heading(ctx, 'C');
      if (!ctx.shared.devServerUp) {
        out.say(`Stage C needs the dev server (${args.backend}) and it does not answer. Skipped.`, '   ');
        return skippedStage('C', 'the dev server is not running');
      }
      return runStageC(ctx);
    },
    D: () => runStageD(ctx),
  };
  for (const id of args.stages) {
    if (stopped ?? (stops > 0 ? (stopped = 'stopped with Ctrl+C') : null)) {
      results.push(skippedStage(id, 'the run was stopped before this stage'));
      continue;
    }
    const t0 = Date.now();
    ctx.shared.partial = [];
    try {
      results.push(await runners[id]());
    } catch (e) {
      out.clearLive();
      const items = ctx.shared.partial;
      if (e instanceof Stopped) {
        stopped = e.why;
        out.line();
        out.line(` Stopped: ${e.why}.`);
        results.push({ id, title: STAGE_TITLES[id], status: items.some((x) => x.status === 'FAIL') ? 'FAIL' : 'SKIPPED', reason: `stopped: ${e.why}`, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, items, notes: [] });
      } else {
        const msg = out.redact(e instanceof Error ? e.message : String(e));
        out.line();
        out.line(` Stage ${id} could not be completed: the guide itself hit an error (${msg}).`);
        results.push({ id, title: STAGE_TITLES[id], status: 'FAIL', reason: `the guide hit an error: ${msg}`, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, items, notes: [] });
      }
    }
  }
  if (!stopped && stops > 0) stopped = 'stopped with Ctrl+C';

  // ---------------------------------------------------------------- the summary
  heading(ctx, 'E');
  const next = [...nextSteps(results, args), ...ctx.shared.next];
  const files = {
    summaryMd: join(reportDir, `${stamp}-all.summary.md`),
    summaryJson: join(reportDir, `${stamp}-all.json`),
    logsDir: paths.logsDir,
    runnerReport: ctx.shared.liveReportPath,
    runnerSummary: ctx.shared.runnerSummaryPath,
  };
  const summary = buildSummary({
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    mode: { stages: args.stages, planOnly: args.planOnly, throwawayKey: args.throwawayKey, yes: args.yes },
    stages: results,
    stopped,
    wallet: ctx.shared.wallet,
    profile: ctx.shared.profile,
    plan: readPlanReport(ctx.shared.planReport),
    live: readLiveReport(ctx.shared.liveReport),
    planReport: ctx.shared.planReport,
    liveReport: ctx.shared.liveReport,
    feeTable: feeTableOf(ctx),
    envLines: ctx.shared.envLines,
    next,
    files,
    key: null,
  });
  // The summary passes the same redactor as every other line (a key typed in stage D is known to it).
  for (const l of summary.screen) out.line(` ${l}`);
  let written = false;
  try {
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(files.summaryMd, `${out.redact(summary.markdown)}\n`, 'utf8');
    writeFileSync(files.summaryJson, `${out.redact(JSON.stringify(summary.json, null, 2))}\n`, 'utf8');
    written = true;
  } catch (e) {
    out.line(` The summary files could not be written: ${(e as Error).message}`);
  }
  out.line();
  out.rule('=');
  out.line(` ${String(summary.json.result)}   ${results.map((r) => `${r.id}: ${r.status}`).join('   ')}   (${fmtDur(Date.now() - startedAt.getTime())})`);
  if (written) out.line(` Summary: ${files.summaryMd}`);
  out.rule('=');

  prompter.close();
  if (stopped) return 130;
  return results.some((r) => r.status === 'FAIL') ? 1 : 0;
}

/** Step 1: is this computer ready? Never starts or stops anything - it says what to do and waits. */
async function prepare(ctx: Ctx, keyVarWasSet: boolean): Promise<void> {
  const { out, args, paths } = ctx;
  heading(ctx, 'prep');
  const major = Number(process.versions.node.split('.')[0]);
  out.result(major >= 22 ? 'PASS' : 'FAIL', `Node.js ${process.versions.node}`, major >= 22 ? '' : 'Node 22 or newer is needed - install it from nodejs.org and start again');
  if (major < 22) throw new Stopped('Node.js is too old');
  const tools = ctx.tools;
  out.result(tools.tsxCli && tools.tsc ? 'PASS' : 'FAIL', 'the project\'s packages are installed', tools.tsxCli && tools.tsc ? '' : 'run "npm install" in the repository folder, then start again');
  if (!tools.tsxCli || !tools.tsc) throw new Stopped('the project\'s packages are not installed');

  // Private files must stay out of git.
  let ignore = '';
  try {
    ignore = readFileSync(join(paths.repo, '.gitignore'), 'utf8');
  } catch {
    ignore = '';
  }
  const wanted = ['apps/web/e2e/live/reports/', 'apps/web/e2e/live/config.json'];
  const missing = wanted.filter((l) => !ignore.split(/\r?\n/).map((x) => x.trim()).includes(l));
  out.result(missing.length ? 'WARN' : 'PASS', 'reports and the run config are ignored by git', missing.length ? `add to .gitignore: ${missing.join('  and  ')}` : '');
  if (keyVarWasSet) {
    out.say(`Note: this shell has ${KEY_ENV} set. The guide does not use it and has dropped it from its own process; it asks for the key itself, hidden. Remove it from the shell when you are done:  Remove-Item Env:${KEY_ENV}`, '   ');
  }
  out.line(`   Reports and logs of this run go to: ${paths.reportDir}`);

  if (!needsDevServer(args)) return;
  const probe = async (): Promise<boolean> => {
    try {
      const r = await ctx.fetch(`${args.backend}/api/health`, { signal: AbortSignal.timeout(5000) });
      const j = (await r.json().catch(() => null)) as { ok?: unknown } | null;
      return r.status === 200 && j?.ok === true;
    } catch {
      return false;
    }
  };
  let up = await probe();
  if (!up && !args.noWait && !args.yes && ctx.ask.prompter.interactive) {
    out.line();
    out.line(`   The dev server does not answer on ${args.backend}. Stages B, C and D need it.`);
    out.line('   DO THIS: open a second terminal window in the repository folder and run');
    out.line('               npm run dev');
    out.line('            and leave that window open. (The guide never starts or stops the servers itself.)');
    out.line('   The guide checks again every 5 seconds. Type s + Enter to go on without it, q + Enter to stop.');
    const t0 = ctx.now();
    while (!up) {
      if (ctx.stopRequested()) throw new Stopped('stopped with Ctrl+C');
      out.live(`   waiting for ${args.backend} ... ${fmtDur(ctx.now() - t0)}`);
      const typed = await ctx.ask.prompter.waitLine(5000);
      out.clearLive();
      const t = typed?.trim().toLowerCase();
      if (t === 's' || t === 'skip') break;
      if (t === 'q' || t === 'quit') throw new Stopped('you stopped while waiting for the dev server');
      up = await probe();
    }
  }
  ctx.shared.devServerUp = up;
  out.result(up ? 'PASS' : 'FAIL', `the dev server answers on ${args.backend}`, up ? '' : 'not running - what needs it is reported as failed or skipped (start it with: npm run dev)');
}

/** What the results themselves say to do next (the stages add their own). */
function nextSteps(results: readonly StageResult[], args: GuideArgs): string[] {
  const out: string[] = [];
  for (const r of results) {
    const failed = r.items.filter((x) => x.status === 'FAIL');
    if (r.id === 'A' && failed.length) {
      out.push(`Stage A: ${failed.length} suite(s) failed (${failed.map((x) => x.id).join(', ')}). Each has its full output in the log named next to it. To run one again: RUN-LIVE-TESTS.cmd --stages A --suites ${failed[0]!.id}`);
    }
    if (r.id === 'B' && failed.length) {
      out.push(`Stage B: ${failed.length} check(s) failed (${failed.slice(0, 6).map((x) => x.title).join('; ')}${failed.length > 6 ? '; ...' : ''}). Fix them and run it again: RUN-LIVE-TESTS.cmd --stages B`);
    }
    if (r.id === 'C' && r.status === 'FAIL') out.push('Stage C: the builder account or the fee tiers are not ready (see the stage). Run it again: RUN-LIVE-TESTS.cmd --stages C');
    const warned = r.items.filter((x) => x.status === 'WARN');
    if (warned.length) out.push(`Stage ${r.id}: look at ${warned.length} warning(s): ${warned.slice(0, 4).map((x) => x.title).join('; ')}${warned.length > 4 ? '; ...' : ''}.`);
  }
  const all = (['A', 'B', 'C', 'D'] as StageId[]).filter((s) => !args.stages.includes(s));
  if (all.length) out.push(`Not part of this run: stage ${all.join(', ')}. The full run is RUN-LIVE-TESTS.cmd without --stages.`);
  return out;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    // Let the output drain, then leave even if a socket is still open somewhere.
    setTimeout(() => process.exit(code), 1500).unref();
  },
  (e) => {
    // Never print a raw error object: only its message, through the same plain-text filter.
    const msg = toAscii(e instanceof Error ? e.message : String(e));
    process.stderr.write(`\nThe guide stopped with an error: ${screen ? screen.redact(msg) : msg}\n`);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 1500).unref();
  },
);
