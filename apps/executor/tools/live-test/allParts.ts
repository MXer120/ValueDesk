/**
 * THE PARTS OF ONE RUN OF EVERYTHING (all.ts): every target the live suite runs
 * against, one after another, each in its own child process (run.ts), so one
 * part's crash never stops the others. What is here needs no network: the plan,
 * why a part is skipped, what the runner's output says, when a crashed part is
 * started again, the progress file, and the summary and the report at the end.
 * all.ts reads the facts (the env file, the balances, the hosted executor, the
 * dev web) and starts the children.
 *
 * A PART is a target with a leader venue. The first leader runs everything
 * selected on its target. A further leader (Hyperliquid, when its key is set)
 * runs the copy scenarios once more, on self: nothing else involves the leader,
 * so what passed with the first one stands for it (the state keeps a copy
 * scenario's result per leader: state.ts resultKey). Hosted and browser run with
 * the first leader.
 *
 * WHAT THE RUNNER SAYS (run.ts), one line each: "> id: title [why]" when a
 * scenario starts, "< id: STATUS (checks, fees $x): error" when it ended (after
 * its cleanup), "- id: skip (why)" and "- id: skipped (why)" for one it does not
 * run, "N scenarios selected" before the first, "RESULTS" once it reached its
 * end. A child that exits without RESULTS crashed: it is started again - it
 * resumes, and its start-up cleanup flattens what the crash left - at most twice
 * more, and not when the same error came before any scenario both times (a
 * refusal at the start, which only repeats).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { LEADER_VENUES, leaderKeyName, leaderVenueOf, type LeaderVenueName } from './leader.ts';
import type { Scenario } from './scenario.ts';
import { selected, type Mode } from './state.ts';
import { TARGETS, targetName, type TargetName } from './target.ts';

/* ------------------------------------------------------------------ options ----- */

export interface DriverArgs {
  dry: boolean;
  /** --targets: the targets to run (default all three, in this order: self, hosted, browser). */
  targets: TargetName[] | null;
  /** --leaders: the leader venues; the first runs on every target, a further one runs the copy scenarios on self. */
  leaders: LeaderVenueName[] | null;
  only: string[] | null;
  slow: boolean;
  force: boolean;
  /** --env: another env file, given to every part. */
  envFile: string | null;
  /** The browser part's dev web (--web) and Edge shown (--headed). */
  web: string | null;
  headed: boolean;
  /** No countdown before a real-money run. */
  yes: boolean;
  /** Print the progress file of the run going on (or the last one) and stop. */
  status: boolean;
}

export const DRIVER_HELP = `all: every live-test target one after another, each part in its own process (README.md "Start here")

  --dry            everything on paper (throwaway wallets, no funds, no keys)
  --targets <list> self, hosted, browser (default: all three, in that order)
  --leaders <list> sodex, hyperliquid (default: each whose key is set, LIVE_LEADER_VENUE's first; else sodex).
                   The first leads on every target; a further one runs the copy scenarios again on self.
  --only <list>    as run.ts: ids, prefixes (twap.*), kinds or sections; the bootstrap always runs
  --slow           include the slow scenarios
  --force          run even what passed on this code
  --env <file>     another env file (default .env.live in this folder)
  --web <origin>   the browser part's dev web;  --headed  show Edge
  --yes            no 10 s countdown before a real-money run
  --status         print the progress of the run going on (or the last one) and stop
  --no-pause       START-LIVE-TESTS.cmd: close its window at the end without waiting for a key

  Run it again to resume: what passed on this code is not run again. Ctrl+C once: the running
  part cleans up and stops, no further part starts, the summary is written.
`;

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function parseDriverArgs(argv: readonly string[]): DriverArgs | 'help' {
  const a: DriverArgs = { dry: false, targets: null, leaders: null, only: null, slow: false, force: false, envFile: null, web: null, headed: false, yes: false, status: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (x === '--dry') a.dry = true;
    else if (x === '--slow') a.slow = true;
    else if (x === '--force') a.force = true;
    else if (x === '--headed') a.headed = true;
    else if (x === '--yes') a.yes = true;
    else if (x === '--status') a.status = true;
    // START-LIVE-TESTS.cmd's own: no pause at its end.
    else if (x === '--no-pause') continue;
    else if (x === '--only') a.only = list(argv[++i]);
    else if (x === '--targets') a.targets = [...new Set(list(argv[++i]).map((t) => targetName(t)))];
    else if (x === '--leaders') a.leaders = [...new Set(list(argv[++i]).map((l) => leaderVenueOf(l)))];
    else if (x === '--env') a.envFile = (argv[++i] ?? '').trim() || null;
    else if (x === '--web') a.web = (argv[++i] ?? '').trim() || null;
    else if (x === '--help' || x === '-h') return 'help';
    else throw new Error(`unknown option ${x} (see --help)`);
  }
  if (a.targets && !a.targets.length) throw new Error('--targets needs at least one of self, hosted, browser');
  if (a.leaders && !a.leaders.length) throw new Error('--leaders needs sodex, hyperliquid or both');
  if (a.only && !a.only.length) a.only = null;
  return a;
}

/* --------------------------------------------------------------------- env ----- */

/** The names the env file holds (.env.example). */
export const ENV_NAMES = ['LIVE_FOLLOWER_KEY', 'LIVE_LEADER_VENUE', 'LIVE_LEADER_KEY', 'LIVE_HL_LEADER_KEY', 'LIVE_COUNTRY', 'LIVE_ACCEPT_TERMS'] as const;

/** KEY=VALUE lines, as run.ts reads them (comments with #, optional quotes). In memory only. */
export function readEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export type EnvState = 'set' | 'empty' | 'missing';

/**
 * Each name's state, never its value: set, empty (in the file without a value) or missing.
 * A LIVE_ variable of the environment counts over the file, as run.ts takes it.
 */
export function envStates(file: Record<string, string> | null, environment: Record<string, string | undefined>): Array<{ name: string; state: EnvState; from: 'file' | 'environment' | null }> {
  return ENV_NAMES.map((name) => {
    const e = environment[name];
    if (e !== undefined) return { name, state: e.trim() ? 'set' : 'empty', from: 'environment' };
    const f = file?.[name];
    if (f === undefined) return { name, state: 'missing', from: null };
    return { name, state: f.trim() ? 'set' : 'empty', from: 'file' };
  });
}

/** The leader venues with a key set, LIVE_LEADER_VENUE's first; none: SoDEX (its copy scenarios are then skipped by the runner). */
export function defaultLeaders(keys: Record<LeaderVenueName, boolean>, preferred: LeaderVenueName = 'sodex'): LeaderVenueName[] {
  const set = LEADER_VENUES.filter((v) => keys[v]);
  if (!set.length) return ['sodex'];
  return set.includes(preferred) ? [preferred, ...set.filter((v) => v !== preferred)] : set;
}

/* -------------------------------------------------------------------- plan ----- */

export interface Part {
  /** 'self', 'self-hl', 'hosted', 'browser': the name on screen, in the report and of its log. */
  id: string;
  target: TargetName;
  leader: LeaderVenueName;
  /** Runs the copy scenarios only (a further leader): the rest ran with the first leader. */
  copyOnly: boolean;
  /** What the runner is given as --only (null: everything). */
  only: string[] | null;
  /** The ids the runner goes through, as it selects them (null: the catalogue could not be read). */
  scope: string[] | null;
  /** Why it does not run (the plan or the preflight), or null. */
  skip: string | null;
}

export const LEADER_LABEL: Record<LeaderVenueName, string> = { sodex: 'SoDEX', hyperliquid: 'Hyperliquid' };

export const partId = (target: TargetName, leader: LeaderVenueName): string => (leader === 'sodex' ? target : `${target}-hl`);

export const partLabel = (p: Pick<Part, 'target' | 'leader' | 'copyOnly'>): string => `target ${p.target}, leader on ${LEADER_LABEL[p.leader]}${p.copyOnly ? ', copy scenarios only' : ''}`;

/** What the plan needs of a scenario. */
export type CatalogueEntry = Pick<Scenario, 'id' | 'kind' | 'section' | 'always' | 'slow' | 'leader'>;

/** The ids run.ts goes through for --only and --slow (its `list`): the bootstrap and what is selected. */
export function scopeOf(catalogue: readonly CatalogueEntry[], only: readonly string[] | null, slow: boolean): string[] {
  return catalogue.filter((s) => (slow || !s.slow) && (s.always || selected(only, s))).map((s) => s.id);
}

/**
 * The parts in order: each target (self, hosted, browser, as --targets keeps them) with the
 * first leader, and on self each further leader right after, with the copy scenarios that
 * --only selects. `catalogue` null (it could not be read): the scope is unknown, and a further
 * leader runs the copy section, or is skipped when --only would have to be narrowed.
 */
export function planParts(o: { targets: readonly TargetName[] | null; leaders: readonly LeaderVenueName[]; only: string[] | null; slow: boolean; catalogue: readonly CatalogueEntry[] | null; catalogueError?: string }): Part[] {
  const targets = TARGETS.filter((t) => !o.targets || o.targets.includes(t));
  const [first = 'sodex', ...more] = o.leaders;
  const parts: Part[] = [];
  for (const target of targets) {
    parts.push({ id: partId(target, first), target, leader: first, copyOnly: false, only: o.only, scope: o.catalogue ? scopeOf(o.catalogue, o.only, o.slow) : null, skip: null });
    if (target !== 'self') continue;
    for (const leader of more) {
      const p: Part = { id: partId(target, leader), target, leader, copyOnly: true, only: null, scope: null, skip: null };
      if (o.catalogue) {
        const ids = o.catalogue.filter((s) => s.leader && !s.always && (o.slow || !s.slow) && selected(o.only, s)).map((s) => s.id);
        p.only = ids;
        // An empty --only would select everything: with nothing to run, nothing is in scope.
        p.scope = ids.length ? scopeOf(o.catalogue, ids, o.slow) : [];
        if (!ids.length) p.skip = 'nothing selected involves the leader (the copy scenarios)';
      } else if (!o.only) p.only = ['copy'];
      else p.skip = `the catalogue could not be read (${o.catalogueError ?? 'unknown'}), so --only cannot be narrowed to the copy scenarios`;
      parts.push(p);
    }
  }
  return parts;
}

/** What the preflight found (all.ts): why parts cannot run. null everywhere: everything runs. */
export interface PreflightFacts {
  /** Why no part can run (live: the follower's key, the terms, the region, its SoDEX account), or null. */
  all: string | null;
  /** Per target: why it cannot run (hosted: its /info; browser: the dev web), or null. */
  target: Partial<Record<TargetName, string | null>>;
  /**
   * Per leader venue: whether its key is set, and why it cannot lead (no account, too little). A
   * part led by a venue with no key runs, its copy scenarios skipped by the runner - but a
   * copy-only part does not; one whose key is set and cannot lead is skipped (the runner refuses it).
   */
  leader: Partial<Record<LeaderVenueName, { keySet: boolean; problem: string | null }>>;
  /** Per part id: why the follower or the leader holds too little for it, or null. */
  funds: Record<string, string | null>;
  /** Targets whose last run may have left orders or positions (live): their part goes first, its start-up cleanup flattens. */
  exposed: Partial<Record<TargetName, string>>;
}

export const noFacts = (): PreflightFacts => ({ all: null, target: {}, leader: {}, funds: {}, exposed: {} });

/** The plan with the preflight's reasons applied (the first reason a part has stands), and an exposed target's parts first. */
export function applyPreflight(parts: readonly Part[], f: PreflightFacts, mode: Mode): Part[] {
  const out = parts.map((p): Part => {
    if (p.skip) return p;
    const l = f.leader[p.leader];
    const why =
      f.all ??
      f.target[p.target] ??
      (mode === 'live' && l && !l.keySet && p.copyOnly ? `${leaderKeyName(p.leader)} is empty: no leader to copy` : null) ??
      (l?.keySet && l.problem ? l.problem : null) ??
      f.funds[p.id] ??
      null;
    return why ? { ...p, skip: why } : p;
  });
  // A target that may have left orders or positions and does not run now: every other target's runner refuses to start (run.ts), so their parts are skipped.
  const stuck = (Object.keys(f.exposed) as TargetName[]).filter((t) => !out.some((p) => p.target === t && !p.skip));
  const plan = stuck.length
    ? out.map((p) => (p.skip || stuck.includes(p.target) ? p : { ...p, skip: `the last ${stuck[0]} run ${f.exposed[stuck[0]!]}: run --targets ${stuck[0]} first (its start-up cleanup flattens them)` }))
    : out;
  const first = plan.filter((p) => !p.skip && f.exposed[p.target]);
  return [...first, ...plan.filter((p) => !first.includes(p))];
}

/* ------------------------------------------------------------ the runner's lines ----- */

export type ScenarioStatusEnd = 'passed' | 'failed' | 'inconclusive' | 'skipped';

export type RunnerLine =
  | { kind: 'selected'; n: number }
  | { kind: 'start'; id: string; title: string; why: string }
  | { kind: 'end'; id: string; status: ScenarioStatusEnd; checks: string; feesUsd: number | null; error: string | null }
  | { kind: 'skip'; id: string; status: 'passed' | 'skipped'; earlier: boolean; why: string }
  | { kind: 'results' }
  | { kind: 'stopped'; why: string }
  | { kind: 'ctrl-c' }
  | { kind: 'warning'; text: string };

/** One line of run.ts's output, as far as the driver reads it; null: anything else. */
export function parseRunnerLine(line: string): RunnerLine | null {
  let m: RegExpExecArray | null;
  if ((m = /^\s+(\d+) scenarios selected\b/.exec(line))) return { kind: 'selected', n: Number(m[1]) };
  if ((m = /^> (\S+): (.*) \[(.*)\]$/.exec(line)) || (m = /^> (\S+): (.*)$/.exec(line))) return { kind: 'start', id: m[1]!, title: m[2]!, why: m[3] ?? '' };
  if ((m = /^< (\S+): (PASSED|FAILED|INCONCLUSIVE|SKIPPED) \(([^)]*)\)(?:: (.*))?$/.exec(line))) {
    const fees = /fees \$(\d+(?:\.\d+)?)/.exec(m[3]!);
    return { kind: 'end', id: m[1]!, status: m[2]!.toLowerCase() as ScenarioStatusEnd, checks: m[3]!, feesUsd: fees ? Number(fees[1]) : null, error: m[4]?.trim() || null };
  }
  if ((m = /^- (\S+): skip \((.*)\)$/.exec(line))) {
    const earlier = /^passed on this code\b/.test(m[2]!);
    return { kind: 'skip', id: m[1]!, status: earlier ? 'passed' : 'skipped', earlier, why: m[2]! };
  }
  if ((m = /^- (\S+): skipped \((.*)\)$/.exec(line))) return { kind: 'skip', id: m[1]!, status: 'skipped', earlier: false, why: m[2]! };
  if (line === 'RESULTS') return { kind: 'results' };
  if ((m = /^STOPPED: (.*)$/.exec(line))) return { kind: 'stopped', why: m[1]! };
  if (/^Ctrl\+C: stopping\b/.test(line)) return { kind: 'ctrl-c' };
  if ((m = /^\s*! (.*)$/.exec(line))) return { kind: 'warning', text: m[1]! };
  return null;
}

/** The line of a crashed child's error output that says what happened: an Error line, else the first line that is not a Node warning. */
export function crashLine(errLines: readonly string[]): string | null {
  const lines = errLines.map((l) => l.trim()).filter((l) => l && !/^\(node:\d+\)/.test(l) && !/^\(Use `node --trace/.test(l) && !/^Node\.js v\d/.test(l));
  const hit = lines.find((l) => /^\w*Error\b/.test(l)) ?? lines[0];
  return hit ? hit.slice(0, 300) : null;
}

/* --------------------------------------------------------------- one attempt ----- */

export type AttemptEnd =
  | { kind: 'finished'; code: number }
  | { kind: 'crashed'; code: number | null; signal: string | null; error: string; startedAny: boolean }
  | { kind: 'interrupted'; code: number | null };

/**
 * How a child ended: interrupted by Ctrl+C (the driver's, or its own second one: exit 130),
 * finished when it printed RESULTS (whatever its exit code: 1 is a failed scenario or a
 * bootstrap that did not pass), crashed otherwise.
 */
export function attemptEnd(o: { code: number | null; signal: string | null; sawResults: boolean; stopping: boolean; error: string | null; startedAny: boolean }): AttemptEnd {
  if (o.stopping || o.code === 130) return { kind: 'interrupted', code: o.code };
  if (o.sawResults) return { kind: 'finished', code: o.code ?? 1 };
  const error = o.error ?? (o.signal ? `it was ended by ${o.signal}` : o.code === 0 ? 'it ended without its results' : `it ended with exit code ${o.code}, without its results`);
  return { kind: 'crashed', code: o.code, signal: o.signal, error, startedAny: o.startedAny };
}

/** Attempts per part: the first and two more after a crash. */
export const MAX_ATTEMPTS = 3;
/** Before the second and the third attempt: time for a busy exchange or network to recover. */
export const RETRY_WAIT_MS: readonly number[] = [5_000, 15_000];

/** Whether a part runs again after this attempt. */
export function retryAfter(attempt: number, end: AttemptEnd, previous: AttemptEnd | null): { retry: boolean; why: string } {
  if (end.kind === 'finished') return { retry: false, why: 'finished' };
  if (end.kind === 'interrupted') return { retry: false, why: 'stopped by Ctrl+C' };
  if (attempt >= MAX_ATTEMPTS) return { retry: false, why: `it crashed ${attempt} times` };
  if (!end.startedAny && previous?.kind === 'crashed' && !previous.startedAny && previous.error === end.error) {
    return { retry: false, why: 'the same error before any scenario twice: a refusal at the start, not a crash' };
  }
  return { retry: true, why: `attempt ${attempt + 1} of ${MAX_ATTEMPTS}` };
}

/* --------------------------------------------------------------- one part ----- */

export interface ScenarioOutcome {
  status: ScenarioStatusEnd;
  /** Passed on this code in an earlier run: not run again. */
  earlier: boolean;
  error: string | null;
  feesUsd: number | null;
  durationMs: number | null;
}

export type PartStatus = 'pending' | 'skipped' | 'running' | 'finished' | 'crashed' | 'interrupted';

export interface Tally {
  /** Scenarios the part goes through (the runner's count, else the plan's; null: unknown). */
  total: number | null;
  done: number;
  passed: number;
  /** Of the passed: on this code in an earlier run. */
  earlier: number;
  failed: number;
  inconclusive: number;
  skipped: number;
  notRun: number;
  /** What SoDEX charged the follower's fills (live; null: nothing known). */
  feesUsd: number | null;
}

/** One part as it runs and after: what the runner said, attempt by attempt. */
export class PartProgress {
  status: PartStatus;
  reason: string | null;
  attempts = 0;
  exit: number | null = null;
  /** The runner's own count ("N scenarios selected"). */
  selected: number | null = null;
  readonly results = new Map<string, ScenarioOutcome>();
  current: { id: string; title: string; startedAt: number } | null = null;
  stopped: string | null = null;
  readonly warnings: string[] = [];
  startedAt: number | null = null;
  endedAt: number | null = null;
  log: string | null = null;
  /** This attempt: RESULTS seen, a scenario started, the tail of its error output. */
  sawResults = false;
  startedAny = false;
  errTail: string[] = [];
  /** The last attempt's end. */
  lastEnd: AttemptEnd | null = null;

  constructor(readonly part: Part) {
    this.status = part.skip ? 'skipped' : 'pending';
    this.reason = part.skip;
  }

  beginAttempt(n: number, now: number): void {
    this.attempts = n;
    this.status = 'running';
    this.startedAt ??= now;
    this.sawResults = false;
    this.startedAny = false;
    this.errTail = [];
    this.current = null;
  }

  /** One line of the child's output; what the driver shows of it (null: nothing). */
  line(text: string, stream: 'out' | 'err', now: number): RunnerLine | null {
    if (stream === 'err') {
      this.errTail.push(text);
      if (this.errTail.length > 40) this.errTail.shift();
      return null;
    }
    const e = parseRunnerLine(text);
    if (!e) return null;
    if (e.kind === 'selected') this.selected = e.n;
    else if (e.kind === 'start') {
      this.current = { id: e.id, title: e.title, startedAt: now };
      this.startedAny = true;
    } else if (e.kind === 'end') {
      const started = this.current?.id === e.id ? this.current.startedAt : null;
      this.results.set(e.id, { status: e.status, earlier: false, error: e.error, feesUsd: e.feesUsd, durationMs: started !== null ? now - started : null });
      if (this.current?.id === e.id) this.current = null;
    } else if (e.kind === 'skip') {
      // Passed in an earlier attempt of this run: that result, with its time, stays.
      const had = this.results.get(e.id);
      if (!(e.earlier && had?.status === 'passed')) this.results.set(e.id, { status: e.status, earlier: e.earlier, error: e.status === 'skipped' ? e.why : null, feesUsd: null, durationMs: null });
    } else if (e.kind === 'results') this.sawResults = true;
    else if (e.kind === 'stopped') this.stopped = e.why;
    else if (e.kind === 'warning') this.warnings.push(e.text);
    return e;
  }

  /** The attempt ended; `last`: no attempt follows. A scenario a last crash broke off is failed with it. */
  endAttempt(end: AttemptEnd, last: boolean, now: number): void {
    this.lastEnd = end;
    this.exit = end.code;
    if (end.kind === 'crashed' && last && this.current) {
      this.results.set(this.current.id, { status: 'failed', earlier: false, error: `the runner crashed while it ran: ${end.error}`, feesUsd: null, durationMs: now - this.current.startedAt });
    }
    if (end.kind === 'interrupted' && this.current) this.current = null;
    if (!last) return;
    this.current = null;
    this.endedAt = now;
    this.status = end.kind;
    this.reason = end.kind === 'crashed' ? end.error : end.kind === 'interrupted' ? 'stopped by Ctrl+C' : this.stopped;
  }

  /** Not started: the plan or the preflight skipped it, or the run stopped before it. */
  notStarted(why: string): void {
    this.status = 'skipped';
    this.reason = why;
  }

  tally(): Tally {
    const t: Tally = { total: this.selected ?? this.part.scope?.length ?? null, done: 0, passed: 0, earlier: 0, failed: 0, inconclusive: 0, skipped: 0, notRun: 0, feesUsd: null };
    for (const r of this.results.values()) {
      t.done += 1;
      t[r.status] += 1;
      if (r.earlier) t.earlier += 1;
      if (r.feesUsd !== null) t.feesUsd = (t.feesUsd ?? 0) + r.feesUsd;
    }
    const scope = this.part.scope;
    t.notRun = scope ? scope.filter((id) => !this.results.has(id)).length : t.total !== null ? Math.max(0, t.total - t.done) : 0;
    return t;
  }

  /** The failed and inconclusive ones, with the first line of their error. */
  failures(): Array<{ id: string; status: ScenarioStatusEnd; error: string }> {
    return [...this.results.entries()].filter(([, r]) => r.status === 'failed' || r.status === 'inconclusive').map(([id, r]) => ({ id, status: r.status, error: firstLine(r.error) }));
  }
}

export const firstLine = (s: string | null | undefined): string => (s ?? '').split('\n')[0]!.trim().slice(0, 200);

/** One child of a part: started with the attempt's number, each line of its output passed on as it comes. */
export type StartChild = (attempt: number, onLine: (line: string, stream: 'out' | 'err') => void) => Promise<{ code: number | null; signal: string | null; error?: string }>;

export type PartEvent = { kind: 'attempt'; attempt: number } | { kind: 'line'; line: RunnerLine } | { kind: 'retry'; attempt: number; end: AttemptEnd; waitMs: number; why: string } | { kind: 'ended'; end: AttemptEnd; why: string };

/** Run a part: its child, again after a crash (retryAfter), until it finished, gave up or was stopped. */
export async function runPart(p: PartProgress, o: { start: StartChild; stopping: () => boolean; onEvent: (e: PartEvent) => void; sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<void> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // The screen or the progress file failing never stops a part (its child would lose its reader).
  const tell = (e: PartEvent) => {
    try {
      o.onEvent(e);
    } catch {
      /* shown or not, the part goes on */
    }
  };
  let previous: AttemptEnd | null = null;
  for (let attempt = 1; ; attempt++) {
    p.beginAttempt(attempt, now());
    tell({ kind: 'attempt', attempt });
    let exit: { code: number | null; signal: string | null; error?: string };
    try {
      exit = await o.start(attempt, (line, stream) => {
        const e = p.line(line, stream, now());
        if (e) tell({ kind: 'line', line: e });
      });
    } catch (e) {
      exit = { code: null, signal: null, error: `it could not be started: ${e instanceof Error ? e.message : String(e)}` };
    }
    const end = attemptEnd({ code: exit.code, signal: exit.signal, sawResults: p.sawResults, stopping: o.stopping(), error: exit.error ?? crashLine(p.errTail), startedAny: p.startedAny });
    const r = retryAfter(attempt, end, previous);
    const again = r.retry && !o.stopping();
    p.endAttempt(end, !again, now());
    if (!again) {
      tell({ kind: 'ended', end, why: r.why });
      return;
    }
    const waitMs = RETRY_WAIT_MS[attempt - 1] ?? RETRY_WAIT_MS[RETRY_WAIT_MS.length - 1]!;
    tell({ kind: 'retry', attempt: attempt + 1, end, waitMs, why: r.why });
    await sleep(waitMs);
    if (o.stopping()) {
      const stopped: AttemptEnd = { kind: 'interrupted', code: end.code };
      p.endAttempt(stopped, true, now());
      tell({ kind: 'ended', end: stopped, why: 'stopped by Ctrl+C before the next attempt' });
      return;
    }
    previous = end;
  }
}

/**
 * A StartChild that runs `command args` and appends its whole output to `logFile` (a header per
 * attempt). Its stdin is closed; it shares this console, so a Ctrl+C there reaches it directly
 * (nothing is forwarded: a second signal would be its "exit at once").
 */
export function childStarter(o: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; logFile: string; label: string; onChild?: (c: ChildProcess | null) => void }): StartChild {
  return (attempt, onLine) =>
    new Promise((resolve) => {
      const log = createWriteStream(o.logFile, { flags: 'a' });
      // A log that cannot be written loses the log, never the part.
      log.on('error', () => undefined);
      log.write(`\n===== ${o.label}, attempt ${attempt}, ${new Date().toISOString()}: ${[o.command, ...o.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\n`);
      let settled = false;
      const done = (r: { code: number | null; signal: string | null; error?: string }) => {
        if (settled) return;
        settled = true;
        o.onChild?.(null);
        log.end();
        resolve(r);
      };
      const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'] });
      o.onChild?.(child);
      let open = 2;
      let exit: { code: number | null; signal: string | null } | null = null;
      const finish = () => {
        if (open === 0 && exit) done(exit);
      };
      for (const [stream, name] of [[child.stdout!, 'out'], [child.stderr!, 'err']] as const) {
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        rl.on('line', (line) => {
          log.write(`${line}\n`);
          onLine(line, name);
        });
        rl.on('close', () => {
          open -= 1;
          finish();
        });
      }
      child.on('error', (e) => done({ code: null, signal: null, error: `it could not be started: ${e.message}` }));
      child.on('exit', (code, signal) => {
        exit = { code, signal };
        finish();
      });
    });
}

/* ------------------------------------------------------------------ screen ----- */

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const fmtUsd = (x: number): string => `$${x.toFixed(4)}`;

/** "14/60: 12 passed (3 earlier), 1 failed, 1 inconclusive, 0 skipped; fees $0.0841" */
export function tallyText(t: Tally): string {
  const parts = [`${t.passed} passed${t.earlier ? ` (${t.earlier} earlier)` : ''}`, `${t.failed} failed`, `${t.inconclusive} inconclusive`, `${t.skipped} skipped`];
  return `${t.done}/${t.total ?? '?'}: ${parts.join(', ')}${t.feesUsd !== null ? `; fees ${fmtUsd(t.feesUsd)}` : ''}`;
}

/**
 * The console: one line per scenario, "[self] twap.exits ... passed 41 s" - its start writes the
 * first half and its end completes it; anything printed in between closes the half line first.
 */
export class Screen {
  private open: string | null = null;
  constructor(private readonly write: (s: string) => void) {}

  /** A line, after the half line if one is open. */
  line(s: string): void {
    if (this.open !== null) this.write('\n');
    this.open = null;
    this.write(`${s}\n`);
  }

  /** The first half of a line, `key` naming what will complete it. */
  begin(key: string, s: string): void {
    if (this.open !== null) this.write('\n');
    this.open = key;
    this.write(s);
  }

  /** Completes the half line `key` opened, or writes `full` on a line of its own. */
  end(key: string, rest: string, full: string): void {
    if (this.open === key) {
      this.open = null;
      this.write(`${rest}\n`);
    } else this.line(full);
  }
}

/** What the screen shows of a part's event, each line headed [part]: a scenario as a half line at its start that its end completes; skips counted, shown as one line. */
export function showEvent(screen: Screen, p: PartProgress, e: PartEvent, o: { logPath: string; skipped: { passed: number; skipped: number }; now: number }): void {
  const tag = `[${p.part.id}]`;
  const flushSkips = () => {
    const s = o.skipped;
    if (!s.passed && !s.skipped) return;
    const what = [s.passed ? `${s.passed} passed on this code earlier, not run again` : '', s.skipped ? `${s.skipped} skipped here (why: in the report)` : ''].filter(Boolean);
    screen.line(`${tag} ${what.join('; ')}`);
    s.passed = 0;
    s.skipped = 0;
  };
  if (e.kind === 'attempt') {
    screen.line(`${tag} starting${e.attempt > 1 ? ` again, attempt ${e.attempt} of ${MAX_ATTEMPTS} (it resumes; its start-up cleanup flattens first)` : ''} - ${partLabel(p.part)}; full output: ${o.logPath}`);
    return;
  }
  if (e.kind === 'retry') {
    flushSkips();
    screen.line(`${tag} the runner crashed: ${e.end.kind === 'crashed' ? e.end.error : ''}; ${e.why} in ${fmtDuration(e.waitMs)}`);
    return;
  }
  if (e.kind === 'ended') {
    flushSkips();
    const t = p.tally();
    const how = e.end.kind === 'finished' ? `finished (exit ${e.end.code})` : e.end.kind === 'crashed' ? `CRASHED, not tried again (${e.why}): ${e.end.error}` : 'stopped by Ctrl+C';
    screen.line(`${tag} ${how} - ${tallyText(t)}${t.notRun ? `, ${t.notRun} not run` : ''}`);
    return;
  }
  const l = e.line;
  if (l.kind === 'skip') {
    if (l.earlier) o.skipped.passed += 1;
    else o.skipped.skipped += 1;
    return;
  }
  if (l.kind === 'start') {
    flushSkips();
    screen.begin(l.id, `${tag} ${l.id} ...`);
    return;
  }
  if (l.kind === 'end') {
    flushSkips();
    const r = p.results.get(l.id);
    const dur = r?.durationMs !== null && r?.durationMs !== undefined ? ` ${fmtDuration(r.durationMs)}` : '';
    const rest = ` ${l.status}${dur}   (${tallyText(p.tally())})`;
    screen.end(l.id, rest, `${tag} ${l.id} ...${rest}`);
    if (l.error && l.status !== 'passed') screen.line(`${' '.repeat(tag.length + 1)}${firstLine(l.error)}`);
    return;
  }
  if (l.kind === 'selected') screen.line(`${tag} ${l.n} scenarios selected`);
  else if (l.kind === 'warning') screen.line(`${tag} ! ${l.text}`);
  else if (l.kind === 'stopped') screen.line(`${tag} STOPPED: ${l.why}`);
  else if (l.kind === 'ctrl-c') screen.line(`${tag} the runner stops after the cleanup of its scenario`);
}

/* --------------------------------------------------------------- progress ----- */

export interface ProgressFile {
  version: 1;
  /** The driver's process (a second window can tell whether it still runs). */
  pid: number;
  mode: Mode;
  startedAt: number;
  updatedAt: number;
  state: 'preflight' | 'running' | 'done' | 'stopped';
  /** What SoDEX charged the follower's fills this run, every part (live; null: none known). */
  feesUsd: number | null;
  report: string | null;
  parts: Array<{
    id: string;
    target: TargetName;
    leader: LeaderVenueName;
    copyOnly: boolean;
    status: PartStatus;
    reason: string | null;
    attempts: number;
    log: string | null;
    startedAt: number | null;
    endedAt: number | null;
    tally: Tally;
    current: { id: string; title: string; startedAt: number } | null;
    failures: Array<{ id: string; status: ScenarioStatusEnd; error: string }>;
  }>;
}

export function totalFees(parts: readonly PartProgress[]): number | null {
  let fees: number | null = null;
  for (const p of parts) {
    const f = p.tally().feesUsd;
    if (f !== null) fees = (fees ?? 0) + f;
  }
  return fees;
}

export function progressOf(o: { pid: number; mode: Mode; startedAt: number; now: number; state: ProgressFile['state']; report: string | null; parts: readonly PartProgress[] }): ProgressFile {
  return {
    version: 1,
    pid: o.pid,
    mode: o.mode,
    startedAt: o.startedAt,
    updatedAt: o.now,
    state: o.state,
    feesUsd: totalFees(o.parts),
    report: o.report,
    parts: o.parts.map((p) => ({
      id: p.part.id,
      target: p.part.target,
      leader: p.part.leader,
      copyOnly: p.part.copyOnly,
      status: p.status,
      reason: p.reason,
      attempts: p.attempts,
      log: p.log,
      startedAt: p.startedAt,
      endedAt: p.endedAt,
      tally: p.tally(),
      current: p.current,
      failures: p.failures(),
    })),
  };
}

/** The progress file for a second window (all.ts --status). `alive`: whether its driver still runs. */
export function statusText(f: ProgressFile, now: number, alive: boolean): string {
  const out: string[] = [];
  const at = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  out.push(`live tests (${f.mode === 'dry' ? 'dry, paper' : 'LIVE, real money'}) started ${at(f.startedAt)} UTC: ${f.state}${f.state === 'running' || f.state === 'preflight' ? (alive ? '' : ' - but its driver no longer runs (closed or crashed)') : ''}, updated ${fmtDuration(now - f.updatedAt)} ago${f.feesUsd !== null ? `, fees so far ${fmtUsd(f.feesUsd)}` : ''}`);
  for (const p of f.parts) {
    const head = `  ${p.id.padEnd(9)} ${p.status.padEnd(11)}`;
    if (p.status === 'skipped' || p.status === 'pending') out.push(`${head} ${p.reason ?? ''}`.trimEnd());
    else {
      out.push(`${head} ${tallyText(p.tally)}${p.tally.notRun ? `, ${p.tally.notRun} not run` : ''}${p.attempts > 1 ? `, attempt ${p.attempts}` : ''}${p.current ? `; now ${p.current.id} (${fmtDuration(now - p.current.startedAt)})` : ''}`);
      if (p.reason && p.status !== 'running') out.push(`            ${p.reason}`);
      for (const x of p.failures) out.push(`            ${x.status} ${x.id}: ${x.error}`);
    }
  }
  if (f.report) out.push(`report: ${f.report}`);
  return out.join('\n');
}

/* ---------------------------------------------------------------- summary ----- */

export interface SummaryRow {
  id: string;
  label: string;
  passed: number;
  earlier: number;
  failed: number;
  inconclusive: number;
  skipped: number;
  notRun: number;
  result: string;
}

export function summaryRows(parts: readonly PartProgress[]): SummaryRow[] {
  return parts.map((p) => {
    const t = p.tally();
    const time = p.startedAt !== null && p.endedAt !== null ? `, ${fmtDuration(p.endedAt - p.startedAt)}` : '';
    const tries = p.attempts > 1 ? `, ${p.attempts} attempts` : '';
    const result =
      p.status === 'skipped' ? `skipped: ${p.reason ?? ''}`
      : p.status === 'finished' ? `finished, exit ${p.exit ?? '?'}${tries}${time}${p.stopped ? `; STOPPED: ${p.stopped}` : ''}`
      : p.status === 'crashed' ? `CRASHED${tries}${time}: ${p.reason ?? ''}`
      : p.status === 'interrupted' ? `stopped by Ctrl+C${time}`
      : p.status;
    return { id: p.part.id, label: `${p.part.target} / ${LEADER_LABEL[p.part.leader]}${p.part.copyOnly ? ' (copy)' : ''}`, passed: t.passed, earlier: t.earlier, failed: t.failed, inconclusive: t.inconclusive, skipped: t.skipped, notRun: t.notRun, result };
  });
}

/** Whether the run as a whole went wrong: a failed scenario, a crashed or stopped part. */
export const runFailed = (parts: readonly PartProgress[]): boolean => parts.some((p) => p.status === 'crashed' || p.status === 'interrupted' || p.tally().failed > 0);

export function formatSummary(parts: readonly PartProgress[], o: { mode: Mode; feesUsd: number | null }): string {
  const rows = summaryRows(parts);
  const out: string[] = [];
  out.push(`SUMMARY (${o.mode === 'dry' ? 'dry, paper' : 'live'})`);
  out.push(`  ${'part'.padEnd(9)} ${'target / leader'.padEnd(24)} ${'passed'.padStart(10)} ${'failed'.padStart(7)} ${'inconcl.'.padStart(9)} ${'skipped'.padStart(8)} ${'not run'.padStart(8)}  result`);
  for (const r of rows) {
    const passed = `${r.passed}${r.earlier ? ` (${r.earlier}e)` : ''}`;
    out.push(`  ${r.id.padEnd(9)} ${r.label.padEnd(24)} ${passed.padStart(10)} ${String(r.failed).padStart(7)} ${String(r.inconclusive).padStart(9)} ${String(r.skipped).padStart(8)} ${String(r.notRun).padStart(8)}  ${r.result}`);
  }
  if (rows.some((r) => r.earlier)) out.push('  (Ne: of them N passed on this code in an earlier run and were not run again)');
  const fails = parts.flatMap((p) => p.failures().map((f) => ({ part: p.part.id, ...f })));
  if (fails.length) {
    out.push('');
    for (const f of fails) out.push(`  ${f.status === 'failed' ? 'FAILED      ' : 'inconclusive'} [${f.part}] ${f.id}: ${f.error}`);
  }
  if (o.feesUsd !== null) out.push(`\n  fees SoDEX charged the follower this run: ${fmtUsd(o.feesUsd)} (spread and the leader's fees not included)`);
  return out.join('\n');
}

export function reportMarkdown(parts: readonly PartProgress[], o: { mode: Mode; startedAt: number; endedAt: number; feesUsd: number | null; preflight: readonly string[]; stateFiles: readonly string[]; interrupted: boolean }): string {
  const at = (t: number) => `${new Date(t).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const out: string[] = [];
  out.push(`# Live tests ${at(o.startedAt)} (${o.mode === 'dry' ? 'dry run, paper' : 'live, real money'})`);
  out.push('');
  out.push(`${fmtDuration(o.endedAt - o.startedAt)}${o.interrupted ? ', stopped by Ctrl+C' : ''}. ${runFailed(parts) ? 'Something failed: see below.' : 'Nothing failed.'} Run it again to resume: what passed on this code is not run again.`);
  out.push('');
  out.push('| Part | Target / leader | Passed | Failed | Inconclusive | Skipped | Not run | Result |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const r of summaryRows(parts)) out.push(`| ${r.id} | ${r.label} | ${r.passed}${r.earlier ? ` (${r.earlier} earlier)` : ''} | ${r.failed} | ${r.inconclusive} | ${r.skipped} | ${r.notRun} | ${cell(r.result)} |`);
  out.push('');
  if (o.feesUsd !== null) out.push(`Fees SoDEX charged the follower in this run: ${fmtUsd(o.feesUsd)} (from its fills; the spread and the leader's fees are not in it).\n`);
  const fails = parts.flatMap((p) => p.failures().map((f) => ({ part: p.part.id, ...f })));
  out.push('## Failed and inconclusive');
  out.push('');
  if (!fails.length) out.push('None.');
  for (const f of fails) out.push(`- **${f.status}** [${f.part}] \`${f.id}\`: ${cell(f.error)}`);
  out.push('');
  const skipped = parts.flatMap((p) => [...p.results.entries()].filter(([, r]) => r.status === 'skipped').map(([id, r]) => ({ part: p.part.id, id, why: firstLine(r.error) })));
  if (skipped.length) {
    out.push('## Skipped scenarios');
    out.push('');
    for (const s of skipped) out.push(`- [${s.part}] \`${s.id}\`: ${cell(s.why)}`);
    out.push('');
  }
  const notes = parts.filter((p) => p.warnings.length);
  if (notes.length) {
    out.push('## What the runner warned of');
    out.push('');
    for (const p of notes) for (const w of p.warnings) out.push(`- [${p.part.id}] ${cell(w)}`);
    out.push('');
  }
  out.push('## Preflight');
  out.push('');
  out.push('```');
  for (const l of o.preflight) out.push(l);
  out.push('```');
  out.push('');
  out.push('## Files');
  out.push('');
  for (const p of parts) if (p.log) out.push(`- ${p.part.id}: the runner's whole output, ${p.log}`);
  for (const f of o.stateFiles) out.push(`- state: ${f}`);
  out.push('');
  return out.join('\n');
}
