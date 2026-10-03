/**
 * Stand-ins for everything a stage touches, so the guided flows can be run in
 * a test from the first question to the summary: a scripted keyboard, a
 * captured screen, a fake live runner that records exactly what it was handed.
 *
 * Nothing here starts a process or opens a connection.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from './args';
import type { BuilderKeyNames, Json } from './config';
import { newShared, type Ctx } from './context';
import type { Prompter } from './prompt';
import type { RunnerInvocation } from './runner';
import { runnerArgs } from './runner';
import type { DDeps, RunnerCallOptions, RunnerRun } from './stageD';
import { planSteps } from './stages';
import { Output } from './ui';

/** A keyboard with the answers written down in advance. */
export class ScriptedPrompter implements Prompter {
  readonly asked: string[] = [];
  hiddenAsked = 0;
  constructor(
    public interactive: boolean,
    /** Answers to visible questions, in order. */
    private readonly lines: string[],
    /** What is "typed" into hidden prompts, in order. */
    private readonly hidden: string[] = [],
    /** What waitLine returns, in order (then null forever). */
    private readonly waits: Array<string | null> = [],
  ) {}
  async ask(question: string): Promise<string | null> {
    this.asked.push(question);
    return this.lines.length ? this.lines.shift()! : null;
  }
  async askHidden(): Promise<string | null> {
    this.hiddenAsked++;
    return this.hidden.length ? this.hidden.shift()! : null;
  }
  async waitLine(): Promise<string | null> {
    return this.waits.length ? this.waits.shift()! : null;
  }
  interrupt(): void {}
  close(): void {}
  /** Answers that were written down and never asked for. */
  get unused(): string[] {
    return [...this.lines];
  }
}

export interface Kit {
  ctx: Ctx;
  prompter: ScriptedPrompter;
  /** Everything printed, joined. */
  screen: () => string;
  /** The same with every run of white space as one blank - paragraphs are wrapped, so a sentence may span lines. */
  flat: () => string;
  dir: string;
  cleanup: () => void;
}

export function kit(o: { argv?: string[]; lines?: string[]; hidden?: string[]; waits?: Array<string | null>; interactive?: boolean; devServerUp?: boolean } = {}): Kit {
  const parsed = parseArgs(o.argv ?? []);
  if (!parsed.ok) throw new Error(parsed.error);
  const dir = mkdtempSync(join(tmpdir(), 'vs-guide-'));
  const printed: string[] = [];
  const out = new Output((s) => printed.push(s), { tty: false });
  const prompter = new ScriptedPrompter(o.interactive ?? true, [...(o.lines ?? [])], [...(o.hidden ?? [])], [...(o.waits ?? [])]);
  let clock = 1_790_000_000_000;
  const shared = newShared();
  shared.devServerUp = o.devServerUp ?? true;
  const ctx: Ctx = {
    args: parsed.args,
    out,
    ask: { out, prompter, auto: parsed.args.yes },
    steps: planSteps(parsed.args),
    paths: {
      repo: dir,
      web: join(dir, 'apps', 'web'),
      guide: join(dir, 'apps', 'web', 'e2e', 'guide'),
      reportDir: join(dir, 'reports'),
      logsDir: join(dir, 'reports', 'logs'),
      stamp: 'test',
      config: { config: join(dir, 'config.json'), example: join(dir, 'config.example.json'), runnerSource: join(dir, 'config.ts') },
    },
    tools: { node: process.execPath, tsxCli: 'tsx-cli', tsc: 'tsc' },
    env: {},
    now: () => (clock += 1000),
    sleep: async () => undefined,
    fetch: (async () => {
      throw new Error('a test must not use the network');
    }) as typeof fetch,
    run: async () => {
      throw new Error('a test must not start a process');
    },
    children: new Set(),
    liveRuns: new Set(),
    stopRequested: () => false,
    shared,
  };
  return { ctx, prompter, screen: () => printed.join(''), flat: () => printed.join('').replace(/\s+/g, ' '), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const NAMES_TODAY: BuilderKeyNames = { max: 'maxFee', address: false, required: true, termsKeys: null };
export const NAMES_TIERS: BuilderKeyNames = { max: 'maxFee', address: false, required: true, termsKeys: 'termsKeys' };

export const EXAMPLE_CONFIG = (): Json => ({
  acknowledgeRealFunds: false,
  backend: 'http://127.0.0.1:5180',
  maxSpendUsd: 8,
  allowExistingAccount: false,
  deposit: { chain: 'ARBITRUM_ETH', amount: '25' },
  withdrawExternal: { coin: 'USDC', chain: 'ARBITRUM_ETH', amount: '5', receiver: 'self' },
  receivers: { valuechain: '' },
  cleanup: { enabled: false, chain: 'ARBITRUM_ETH' },
  builder: null,
});

export interface RunnerCall {
  inv: RunnerInvocation;
  /** The arguments the runner process would get. */
  argv: string[];
  /** Whether a key was handed to the child, and which. */
  key: string | null;
  protect: boolean;
  /** Lines typed during the call are forwarded to the runner (the live run). */
  input: boolean;
  /** The config file's content at the moment of the call. */
  config: Json | null;
}

export interface FakeRunnerOptions {
  /** What `capabilities` prints, and its exit code. */
  capabilities?: { text: string; code: number };
  /** The report (and exit code) of each plan call, in order; the last one repeats. */
  plans: Array<{ report: unknown; code: number; lines?: string[] }>;
  /** The live run. */
  live?: { report: unknown; code: number; lines?: string[] };
  existing?: Json | null;
  example?: Json | null;
  names?: BuilderKeyNames;
  /** Reports of earlier live runs (path -> report), newest first. */
  earlier?: Array<[string, unknown]>;
  /** Text files that exist (a runner's summary next to its report). */
  texts?: Record<string, string>;
}

/** A live runner that does nothing but remember what it was asked - and with what. */
export class FakeRunner implements DDeps {
  readonly calls: RunnerCall[] = [];
  readonly saved: Array<{ path: string; cfg: Json }> = [];
  private readonly reports = new Map<string, unknown>();
  private readonly files = new Map<string, Json>();
  private planIndex = 0;

  constructor(private readonly o: FakeRunnerOptions) {
    for (const [p, r] of o.earlier ?? []) this.reports.set(p, r);
  }

  async runner(inv: RunnerInvocation, call: RunnerCallOptions): Promise<RunnerRun> {
    // The same guard the real path has: an invocation the runner would refuse cannot even be built.
    const argv = runnerArgs(inv);
    this.calls.push({ inv, argv, key: call.key, protect: call.protect === true, input: call.input === true, config: inv.config ? structuredClone(this.files.get(inv.config) ?? null) : null });
    const done = (code: number, lines: string[], report: unknown): RunnerRun => {
      const path = `mem://report-${this.calls.length}.json`;
      if (report !== null && report !== undefined) this.reports.set(path, report);
      const all = [...lines, ...(report !== null && report !== undefined ? [`20:00:00  report            ${path}`] : [])];
      for (const l of all) call.onLine?.(l);
      return { code, lines: all, reportPath: report !== null && report !== undefined ? path : null, ms: 1234, startError: null, timedOut: false };
    };
    if (inv.mode === 'capabilities') {
      const c = this.o.capabilities ?? { text: 'unknown argument capabilities\n\nusage: npx tsx e2e/live/run.ts [plan|live] --config <file>\n  --only a,b   run only these steps: deposit-external, enable-trading, orders, withdraw-external, extra-withdrawals, cleanup', code: 2 };
      return done(c.code, c.text.split('\n'), null);
    }
    if (inv.mode === 'plan') {
      const p = this.o.plans[Math.min(this.planIndex++, this.o.plans.length - 1)]!;
      return done(p.code, p.lines ?? ['20:00:00  SoDEX account     none yet (brand-new wallet)'], p.report);
    }
    const l = this.o.live ?? { report: null, code: 1 };
    return done(l.code, l.lines ?? ['20:00:01  == deposit-external: deposit USDC', '20:00:02  ok deposit-external (1.0 s)'], l.report);
  }

  readJson(path: string): unknown {
    return this.reports.get(path) ?? null;
  }
  readText(path: string): string | null {
    if (path.endsWith('run.ts')) return '// the runner is in this checkout';
    return this.o.texts?.[path] ?? null;
  }
  liveReports(): string[] {
    return (this.o.earlier ?? []).map(([p]) => p);
  }
  loadConfig(): { existing: Json | null; example: Json | null; problem: string | null; names: BuilderKeyNames } {
    const saved = this.saved.at(-1);
    return { existing: saved ? structuredClone(saved.cfg) : this.o.existing ?? null, example: this.o.example === undefined ? EXAMPLE_CONFIG() : this.o.example, problem: null, names: this.o.names ?? NAMES_TODAY };
  }
  saveConfig(path: string, cfg: Json): void {
    this.saved.push({ path, cfg: structuredClone(cfg) });
    this.files.set(path, structuredClone(cfg));
  }

  get plans(): RunnerCall[] {
    return this.calls.filter((c) => c.inv.mode === 'plan');
  }
  get lives(): RunnerCall[] {
    return this.calls.filter((c) => c.inv.mode === 'live');
  }
  /** Was `acknowledgeRealFunds: true` ever on disk? When (which save)? */
  get ackHistory(): boolean[] {
    return this.saved.map((s) => s.cfg.acknowledgeRealFunds === true);
  }
}
