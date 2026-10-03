/**
 * Stage A: every offline suite of the repository, one after another, with a
 * live line per suite and the full output in the report folder.
 * No network secrets, no key: nothing here is given one.
 */
import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkStop, logWriter, type Ctx } from './context';
import { childEnv, hasProgram } from './proc';
import {
  applyReporterLine,
  countsText,
  discoverSuites,
  filterSuites,
  newCounts,
  nodeTestArgs,
  parseForgeOutput,
  parseTscOutput,
  testVerdict,
  type FsView,
  type SuiteCommand,
  type SuiteDef,
  type Tools,
} from './suites';
import { STAGE_TITLES, stageStatus, type Item, type StageResult } from './types';
import { fmtDur } from './ui';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);

/** The repository as discovery sees it: forward slashes, no dependency or build folders, no dot folders. */
export function diskView(repo: string): FsView {
  const abs = (p: string): string => join(repo, ...p.split('/'));
  const walk = (dir: string, rel: string, out: string[]): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let dirLike = false;
      try {
        dirLike = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (dirLike) walk(full, rel ? `${rel}/${name}` : name, out);
      else out.push(rel ? `${rel}/${name}` : name);
    }
  };
  return {
    exists: (p) => existsSync(abs(p)),
    files: (dir) => {
      const out: string[] = [];
      walk(abs(dir), '', out);
      return out;
    },
    dirs: (dir) => {
      try {
        return readdirSync(abs(dir)).filter((n) => !n.startsWith('.') && !SKIP_DIRS.has(n) && statSync(join(abs(dir), n)).isDirectory());
      } catch {
        return [];
      }
    },
  };
}

export function detectTools(): Tools {
  const python = hasProgram('python');
  return { forge: hasProgram('forge'), python, pyyaml: python && hasProgram('python', ['-c', 'import yaml']) };
}

interface SuiteOutcome {
  item: Item;
  /** Lines to print under a failed suite. */
  failures: string[];
}

async function runSuite(ctx: Ctx, def: SuiteDef, label: string): Promise<SuiteOutcome> {
  const { out } = ctx;
  if (def.skip) return { item: { id: def.id, title: def.title, status: 'SKIPPED', detail: def.skip }, failures: [] };
  const cwd = join(ctx.paths.repo, ...def.cwd.split('/'));
  const env = childEnv(ctx.env);
  const t0 = ctx.now();
  let progress = 'starting';
  const draw = (): void => out.live(`  ${label} ${def.title} ... ${progress}   ${fmtDur(ctx.now() - t0)}`);
  const ticker = setInterval(draw, 1000);
  draw();
  const log = logWriter(ctx, `A-${def.id}.log`);
  const done = (status: Item['status'], detail: string, failures: string[] = []): SuiteOutcome => {
    clearInterval(ticker);
    out.clearLive();
    return { item: { id: def.id, title: def.title, status, ms: ctx.now() - t0, detail, log: log.path }, failures };
  };
  const track = {
    onStart: (c: ChildProcess): void => {
      ctx.children.add(c);
      c.once('close', () => ctx.children.delete(c));
    },
  };

  try {
    if (def.kind === 'tsc') {
      if (!ctx.tools.tsc) return done('FAIL', 'TypeScript is not installed (run "npm install" in the repository)');
      const lines: string[] = [];
      let failed = false;
      for (const project of def.projects ?? [null]) {
        progress = `type-checking${project ? ` ${project}` : ''}`;
        draw();
        log.write(`$ tsc --noEmit${project ? ` -p ${project}` : ''}   (in ${def.cwd})`);
        const r = await ctx.run(ctx.tools.node, [ctx.tools.tsc, '--noEmit', '--pretty', 'false', ...(project ? ['-p', project] : [])], {
          cwd, env, timeoutMs: def.timeoutMs, ...track,
          onLine: (l) => { lines.push(l); log.write(l); },
        });
        log.write(`exit ${r.code}${r.timedOut ? ' (timed out)' : ''}`);
        if (r.startError) return done('FAIL', `could not start the compiler: ${r.startError}`);
        if (r.timedOut) return done('FAIL', `timed out after ${fmtDur(def.timeoutMs)}`);
        if (r.code !== 0) failed = true;
      }
      const t = parseTscOutput(lines);
      if (!failed && t.errors === 0) return done('PASS', 'no type errors');
      return done('FAIL', t.errors ? `${t.errors} type error${t.errors === 1 ? '' : 's'} in ${t.files} file${t.files === 1 ? '' : 's'}` : 'the compiler exited with an error', t.first);
    }

    if (def.kind === 'node-test') {
      const counts = newCounts();
      const extra = logWriter(ctx, `A-${def.id}.output.log`);
      const reporterUrl = pathToFileURL(join(ctx.paths.guide, 'reporter.mjs')).href;
      progress = `${def.files?.length ?? 0} files`;
      const r = await ctx.run(ctx.tools.node, nodeTestArgs(def, { reporterUrl, logFile: log.path }), {
        cwd, env, timeoutMs: def.timeoutMs, ...track,
        onLine: (l) => {
          if (applyReporterLine(counts, l)) {
            progress = countsText(counts);
          } else if (l.trim()) extra.write(l);
        },
      });
      if (r.startError) return done('FAIL', `could not start node: ${r.startError}`);
      const v = testVerdict(counts, r.code, r.timedOut);
      const failures = counts.failures.slice(0, 12).map((f) => `${f.name}${f.error ? ` - ${f.error}` : ''}`);
      return done(v.ok ? 'PASS' : 'FAIL', `${v.detail}${v.ok ? ` in ${def.files?.length ?? 0} files` : ''}`, v.ok ? [] : failures);
    }

    // kind === 'command'
    const notes: string[] = [];
    for (const c of def.commands ?? []) {
      progress = c.label;
      draw();
      const { program, args } = commandLine(ctx, c);
      if (!program) return done('FAIL', `${c.program} is not installed`);
      log.write(`$ ${c.program} ${c.args.join(' ')}   (in ${def.cwd})`);
      const lines: string[] = [];
      const r = await ctx.run(program, args, { cwd, env, timeoutMs: def.timeoutMs, ...track, onLine: (l) => { lines.push(l); log.write(l); } });
      log.write(`exit ${r.code}${r.timedOut ? ' (timed out)' : ''}`);
      if (r.startError) return done('FAIL', `could not start ${c.program}: ${r.startError}`);
      if (r.timedOut) return done('FAIL', `${c.label}: timed out after ${fmtDur(def.timeoutMs)}`);
      const forge = c.program === 'forge' ? parseForgeOutput(lines) : null;
      if (r.code !== 0) {
        const tail = lines.map((l) => l.trim()).filter(Boolean).slice(-6);
        return done('FAIL', `${c.label}: ${forge ? `${forge.passed} passed, ${forge.failed} failed` : `exit code ${r.code}`}`, tail);
      }
      notes.push(forge ? `${forge.passed} passed, ${forge.failed} failed, ${forge.skipped} skipped` : c.label);
    }
    return done('PASS', notes.join('; '));
  } catch (e) {
    return done('FAIL', `the guide could not run this suite: ${(e as Error).message}`);
  }
}

/** The real program and arguments of a suite command. */
function commandLine(ctx: Ctx, c: SuiteCommand): { program: string | null; args: string[] } {
  if (c.program === 'node') return { program: ctx.tools.node, args: c.args };
  if (c.program === 'tsx') return ctx.tools.tsxCli ? { program: ctx.tools.node, args: [ctx.tools.tsxCli, ...c.args] } : { program: null, args: [] };
  return { program: c.program, args: c.args };
}

export async function runStageA(ctx: Ctx, tools: Tools = detectTools(), view: FsView = diskView(ctx.paths.repo)): Promise<StageResult> {
  const { out } = ctx;
  const startedAt = new Date(ctx.now()).toISOString();
  const t0 = ctx.now();
  const all = discoverSuites(view, tools);
  const suites = filterSuites(all, ctx.args.suites);
  out.say('Every type check and every offline test of the repository. Nothing here uses the network or a key. The full output of each suite is kept in the report folder.');
  if (ctx.args.suites) out.line(` Only the suites matching: ${ctx.args.suites.join(', ')} (${suites.length} of ${all.length}).`);
  out.line();
  const items: Item[] = [];
  ctx.shared.partial = items;
  let i = 0;
  for (const def of suites) {
    checkStop(ctx);
    i++;
    const label = `[${String(i).padStart(2)}/${suites.length}]`;
    const r = await runSuite(ctx, def, label);
    items.push(r.item);
    out.result(r.item.status, def.title, r.item.detail ?? '', r.item.ms);
    for (const f of r.failures) out.line(`            - ${f}`);
    if (r.item.status === 'FAIL' && r.item.log) out.line(`            full output: ${r.item.log}`);
  }
  const status = stageStatus(items);
  const pass = items.filter((x) => x.status === 'PASS').length;
  const fail = items.filter((x) => x.status === 'FAIL').length;
  const skip = items.filter((x) => x.status === 'SKIPPED').length;
  out.line();
  out.line(` Stage A: ${status} - ${pass} suite${pass === 1 ? '' : 's'} passed, ${fail} failed, ${skip} skipped, in ${fmtDur(ctx.now() - t0)}.`);
  return { id: 'A', title: STAGE_TITLES.A, status, startedAt, ms: ctx.now() - t0, items, notes: [], ...(fail ? { reason: `${fail} suite${fail === 1 ? '' : 's'} failed` } : !items.length ? { reason: 'no suite matched' } : {}) };
}
