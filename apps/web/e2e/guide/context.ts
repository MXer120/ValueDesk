/**
 * What every stage is handed: the arguments, the screen, the keyboard, the
 * paths, and the few things a stage leaves for the next one.
 *
 * Everything that touches the outside (time, sleeping, HTTP, child processes)
 * is a field here, so a test can drive a whole stage with fakes.
 */
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GuideArgs } from './args';
import type { BuilderChoice, ConfigFiles } from './config';
import type { Asker } from './prompt';
import type { RunOptions, RunResult, Toolchain } from './proc';
import type { Capabilities } from './runner';
import type { GuideStep, StepKey } from './stages';
import { stepHeading } from './stages';
import type { Output } from './ui';
import { Stopped, type Item } from './types';

export interface Paths {
  repo: string;
  web: string;
  guide: string;
  /** Where the runner's reports and the guide's summary go. */
  reportDir: string;
  /** This run's log folder inside reportDir. */
  logsDir: string;
  /** `2026-10-02T20-23-01-798Z`: the prefix of everything this run writes. */
  stamp: string;
  config: ConfigFiles;
}

/** What one stage found out that a later one needs. */
export interface Shared {
  /** The dev server answered /api/health when the run started. */
  devServerUp: boolean;
  caps: Capabilities | null;
  /** Stage C's result: undefined = stage C did not decide, null = no builder. */
  builder: BuilderChoice | null | undefined;
  /** The builder's wallet (for the summary and the terms check). */
  builderAddress: string | null;
  /** Lines for apps/web/.env.local, printed again in the summary. */
  envLines: string[];
  /** Raw reports of the live runner, for the summary: the last plan and the live run. */
  planReport: unknown;
  liveReport: unknown;
  liveReportPath: string | null;
  /** The runner's own summary of its live run, when it writes one: the text, and the file it came from. */
  runnerSummaryMd: string | null;
  runnerSummaryPath: string | null;
  /** What to do next, collected by the stages. */
  next: string[];
  /** The wallet the live run used (an address - never a key). */
  wallet: string | null;
  profile: string | null;
  /** The rows of the stage that is running, so a stop in the middle of it does not lose them. */
  partial: Item[];
}

export interface Ctx {
  args: GuideArgs;
  out: Output;
  ask: Asker;
  steps: GuideStep[];
  paths: Paths;
  tools: Toolchain;
  /** This process's environment WITHOUT the key variable (proc.childEnv builds a child's from it). */
  env: NodeJS.ProcessEnv;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetch: typeof fetch;
  run: (program: string, args: readonly string[], o: RunOptions) => Promise<RunResult>;
  /** Children that are running right now and may be stopped with the guide. */
  children: Set<ChildProcess>;
  /** A live money run in progress: never killed by the guide (Ctrl+C reaches it directly, and it then reports where the funds are). */
  liveRuns: Set<ChildProcess>;
  /** Ctrl+C was pressed. */
  stopRequested: () => boolean;
  shared: Shared;
}

export const newShared = (): Shared => ({
  devServerUp: false,
  caps: null,
  builder: undefined,
  builderAddress: null,
  envLines: [],
  planReport: null,
  liveReport: null,
  liveReportPath: null,
  runnerSummaryMd: null,
  runnerSummaryPath: null,
  next: [],
  wallet: null,
  profile: null,
  partial: [],
});

/** Print "Step n of N - title". */
export function heading(ctx: Pick<Ctx, 'out' | 'steps'>, key: StepKey): void {
  const h = stepHeading(ctx.steps, key);
  ctx.out.step(h.n, h.total, h.title, h.stage);
}

/** Stop here if Ctrl+C was pressed. */
export function checkStop(ctx: Pick<Ctx, 'stopRequested'>): void {
  if (ctx.stopRequested()) throw new Stopped('stopped with Ctrl+C');
}

/** A log file of this run (the folder is made on first use). Lines are appended as they are. */
export function logWriter(ctx: Pick<Ctx, 'paths' | 'out'>, name: string): { path: string; write: (line: string) => void } {
  const path = join(ctx.paths.logsDir, name);
  let ready = false;
  return {
    path,
    write: (line: string) => {
      try {
        if (!ready) {
          mkdirSync(ctx.paths.logsDir, { recursive: true });
          ready = true;
        }
        // Whatever reaches a log has been through the same redactor as the screen.
        appendFileSync(path, `${ctx.out.redact(line)}\n`, 'utf8');
      } catch {
        /* a log that cannot be written must not stop a test run */
      }
    },
  };
}
