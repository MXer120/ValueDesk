/**
 * The live test's memory: one JSON file per mode and target
 * (.state/live-self.json, .state/dry-hosted.json, ...), so a practice run can
 * never mark a real-money scenario passed, and a pass on one executor never
 * stands for another. A self state from before targets (.state/live.json) is
 * renamed to its new name the first time (stateFileOf).
 *
 * CRASH SAFETY. The file is written whole to a temporary file and renamed over
 * the old one, so a crash mid-write leaves the previous version, never half a
 * file. Before a scenario sends anything it is marked `running` and the file is
 * saved; a run that dies there leaves `running` behind, which the next start
 * reads as "interrupted": that scenario is failed (and retried), and the
 * account is treated as exposed, so the start-up cleanup flattens it. While a
 * live order may be on SoDEX, `exposure` is set; only a cleanup that read the
 * accounts flat clears it. A file that cannot be read at all is kept aside and
 * the account is treated as exposed too: unknown is never read as flat.
 *
 * RESUME. A scenario that passed on the same code (its hash: the engine and
 * executor files it depends on, and the harness itself) in the same mode on the
 * same target is skipped; failed, inconclusive, interrupted and never-run ones run.
 * A copy scenario run with a Hyperliquid leader is kept under its own key
 * (resultKey: `<id>@hyperliquid`), so a run with each leader resumes on its own
 * and neither overwrites the other's result; what does not involve the leader is
 * the same with either and kept once.
 *
 * ONE TARGET AT A TIME PER WALLET. A live start reads the other targets' files
 * too (exposedOn): if one says the follower's account may be exposed there, it
 * refuses - that target's own next run flattens it first.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LeaderVenueName } from './leader.ts';
import type { TargetName } from './target.ts';

export type Mode = 'live' | 'dry';

/**
 * pending       never run (or reset);
 * running       started and not finished - read back after a crash as interrupted;
 * passed        every check held;
 * failed        a check failed, the scenario threw, or it was interrupted;
 * inconclusive  the market did not do what the scenario waits for (a take-profit never reached in time): retried;
 * skipped       not runnable here (the executor lacks the feature, a region rule): with the reason.
 */
export type ScenarioStatus = 'pending' | 'running' | 'passed' | 'failed' | 'inconclusive' | 'skipped';

export interface ScenarioResult {
  status: ScenarioStatus;
  /** The code hash it last ran on. */
  hash: string | null;
  startedAt: number | null;
  endedAt: number | null;
  attempts: number;
  error: string | null;
  /** Checks that held, and (dry) checks that only a real exchange can answer and were not made. */
  checks: { passed: number; liveOnly: number };
  notes: string[];
  /** USD the scenario cost on SoDEX (fees, from SoDEX's own fill rows); live only. */
  feesUsd: number | null;
}

export interface ExecutorRecord {
  /** The target that started it (only self starts a process). */
  target: TargetName;
  pid: number;
  port: number;
  executorId: string;
  dataDir: string;
  startedAt: number;
}

export interface RunState {
  version: 1;
  mode: Mode;
  /** The executor the scenarios ran against (target.ts); a file from before targets is self's. */
  target: TargetName;
  /** The follower wallet of the last run (a state of another wallet does not block this one: exposedOn). */
  follower: string | null;
  scenarios: Record<string, ScenarioResult>;
  /** Set while live orders may be on SoDEX (from the first order of a scenario to a cleanup that read the accounts flat). */
  exposure: { since: number; by: string } | null;
  /** The executor process this runner started, so a crashed run's executor can be found and stopped. */
  executor: ExecutorRecord | null;
  /** The last runs, newest last (at most 50). */
  runs: Array<{ at: number; target: TargetName; codeHash: string; selected: number; passed: number; failed: number; skipped: number }>;
}

export const emptyState = (mode: Mode, target: TargetName = 'self'): RunState => ({ version: 1, mode, target, follower: null, scenarios: {}, exposure: null, executor: null, runs: [] });

/**
 * The state file of a mode on a target: <dir>/<mode>-<target>.json. A self
 * state from before targets (<dir>/<mode>.json) is renamed to it the first
 * time, so what passed there still counts; if the rename is refused, the old
 * name is read (never an empty state in place of one that may record exposure).
 */
export function stateFileOf(dir: string, mode: Mode, target: TargetName): string {
  const file = join(dir, `${mode}-${target}.json`);
  const old = join(dir, `${mode}.json`);
  if (target !== 'self' || existsSync(file) || !existsSync(old)) return file;
  try {
    renameSync(old, file);
    return file;
  } catch {
    return old;
  }
}

export const emptyResult = (): ScenarioResult => ({ status: 'pending', hash: null, startedAt: null, endedAt: null, attempts: 0, error: null, checks: { passed: 0, liveOnly: 0 }, notes: [], feesUsd: null });

/** What loading found besides the state: an interrupted scenario, a file that could not be read. */
export interface LoadReport {
  interrupted: string[];
  corrupt: string | null;
}

/**
 * Read the state, repairing what a crash left: `running` becomes `failed`
 * (interrupted) and sets the exposure flag; an unreadable file (or another
 * mode's or target's) is moved to `<file>.corrupt-<time>` and an empty state
 * with the exposure flag set is returned.
 */
export function loadState(file: string, mode: Mode, now = Date.now(), target: TargetName = 'self'): { state: RunState; report: LoadReport } {
  const report: LoadReport = { interrupted: [], corrupt: null };
  if (!existsSync(file)) return { state: emptyState(mode, target), report };
  let state: RunState;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<RunState>;
    if (raw.version !== 1 || raw.mode !== mode || !raw.scenarios || typeof raw.scenarios !== 'object') throw new Error('not a live-test state file of this mode');
    if ((raw.target ?? 'self') !== target) throw new Error(`a state file of the ${raw.target} target, not ${target}`);
    state = { ...emptyState(mode, target), ...raw, scenarios: { ...raw.scenarios } } as RunState;
  } catch (e) {
    const aside = `${file}.corrupt-${now}`;
    try {
      renameSync(file, aside);
    } catch {
      /* left where it is; it is overwritten by the next save */
    }
    report.corrupt = `${String(e instanceof Error ? e.message : e)} (kept as ${aside})`;
    const fresh = emptyState(mode, target);
    fresh.exposure = { since: now, by: 'unreadable state file' };
    return { state: fresh, report };
  }
  state.runs = (state.runs ?? []).map((r) => ({ ...r, target: r.target ?? target }));
  if (state.executor) state.executor = { ...state.executor, target: state.executor.target ?? target };
  for (const [id, r] of Object.entries(state.scenarios)) {
    const full = { ...emptyResult(), ...r };
    if (full.status === 'running') {
      full.status = 'failed';
      full.error = 'interrupted: the runner stopped while this scenario ran';
      full.endedAt = now;
      report.interrupted.push(id);
      state.exposure ??= { since: full.startedAt ?? now, by: id };
    }
    state.scenarios[id] = full;
  }
  return { state, report };
}

/**
 * Whether another target's state file (read as it is: nothing repaired, nothing
 * moved) says the follower's account may be exposed there - an exposure
 * recorded, a scenario a crash left running, or a file that cannot be read
 * (unknown is never flat). A state of another follower wallet does not count.
 * Returns why, or null.
 */
export function exposedOn(file: string, follower: string): string | null {
  if (!existsSync(file)) return null;
  let raw: Partial<RunState>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<RunState>;
  } catch {
    return `its state file ${file} cannot be read`;
  }
  if (raw.follower && raw.follower.toLowerCase() !== follower.toLowerCase()) return null;
  if (raw.exposure) return `it recorded orders or positions that may still be out, since ${new Date(raw.exposure.since).toISOString()} (${raw.exposure.by})`;
  const running = Object.entries(raw.scenarios ?? {}).filter(([, r]) => r?.status === 'running').map(([id]) => id);
  if (running.length) return `${running.join(', ')} was left running by a crash`;
  return null;
}

/** Write the whole state atomically (temporary file, then rename over the old one). */
export function saveState(file: string, state: RunState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  // OneDrive and virus scanners hold files for a moment: a refused rename is tried again.
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 20) {
        try {
          unlinkSync(tmp);
        } catch {
          /* nothing to clean */
        }
        throw e;
      }
      const until = Date.now() + 50 * (i + 1);
      while (Date.now() < until) {
        /* a short synchronous wait: the state must be on disk before the next order */
      }
    }
  }
}

export function resultOf(state: RunState, id: string): ScenarioResult {
  return (state.scenarios[id] ??= emptyResult());
}

/**
 * Whether `--only` selects scenario `id` of kind `kind` and section `section`.
 * Each entry is an id ('twap.taker-buy'), a prefix with a star ('twap.*',
 * 'copy.*'), a kind ('twap') or a section ('algo', 'copy', 'setup').
 */
export function selected(only: readonly string[] | null, s: { id: string; kind: string; section: string }): boolean {
  if (!only || !only.length) return true;
  return only.some((o) => {
    const x = o.trim();
    if (!x) return false;
    if (x.endsWith('*')) return s.id.startsWith(x.slice(0, -1));
    return x === s.id || x === s.kind || x === s.section;
  });
}

/**
 * The key a scenario's result is kept under: its id, but a scenario with the
 * leader run with a leader on another venue than SoDEX is kept apart
 * (`copy.fixed@hyperliquid`). With one key for both, a run with one leader
 * overwrote the other's pass (so each ran everything again), and one that skips a
 * scenario written for the other leader recorded it skipped on that one's code.
 */
export function resultKey(s: { id: string; leader?: boolean }, leaderVenue: LeaderVenueName = 'sodex'): string {
  return s.leader && leaderVenue !== 'sodex' ? `${s.id}@${leaderVenue}` : s.id;
}

export type Decision = { run: true; why: string } | { run: false; why: string };

/**
 * Whether to run a scenario now: not selected -> no; `always` (the bootstrap) or
 * `force` -> yes; passed on this very code hash -> no; anything else -> yes.
 * `key`: where its result is kept (resultKey; default its id).
 */
export function decide(state: RunState, s: { id: string; kind: string; section: string; always?: boolean }, hash: string, o: { only: readonly string[] | null; force: boolean; key?: string }): Decision {
  if (!selected(o.only, s) && !s.always) return { run: false, why: 'not selected' };
  if (s.always) return { run: true, why: 'runs every time (bootstrap)' };
  if (o.force) return { run: true, why: '--force' };
  const r = state.scenarios[o.key ?? s.id];
  if (!r || r.status === 'pending') return { run: true, why: 'never run' };
  if (r.status === 'passed' && r.hash === hash) return { run: false, why: `passed on this code (${new Date(r.endedAt ?? 0).toISOString()})` };
  if (r.status === 'passed') return { run: true, why: 'passed on other code: the engine, the executor or the harness changed since' };
  if (r.status === 'skipped' && r.hash === hash) return { run: false, why: `skipped on this code: ${r.error ?? ''}` };
  return { run: true, why: `last ${r.status}${r.error ? `: ${r.error}` : ''}` };
}

/** Mark a scenario started (and save before anything is sent). */
export function markRunning(state: RunState, id: string, hash: string, now = Date.now()): ScenarioResult {
  const r = resultOf(state, id);
  r.status = 'running';
  r.hash = hash;
  r.startedAt = now;
  r.endedAt = null;
  r.attempts += 1;
  r.error = null;
  r.notes = [];
  r.checks = { passed: 0, liveOnly: 0 };
  r.feesUsd = null;
  return r;
}

export function markDone(state: RunState, id: string, status: Exclude<ScenarioStatus, 'running' | 'pending'>, o: { error?: string | null; notes?: string[]; checks?: ScenarioResult['checks']; feesUsd?: number | null } = {}, now = Date.now()): ScenarioResult {
  const r = resultOf(state, id);
  r.status = status;
  r.endedAt = now;
  r.error = o.error ?? null;
  if (o.notes) r.notes = o.notes.slice(-40);
  if (o.checks) r.checks = o.checks;
  if (o.feesUsd !== undefined) r.feesUsd = o.feesUsd;
  return r;
}

export function noteRun(state: RunState, run: RunState['runs'][number]): void {
  state.runs.push(run);
  if (state.runs.length > 50) state.runs.splice(0, state.runs.length - 50);
}
