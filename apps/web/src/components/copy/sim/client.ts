/**
 * A simulator that runs large replays in a Web Worker so the UI thread never
 * janks, with a synchronous fallback whenever a worker is unavailable (tests,
 * CSP refusal, a worker that fails to load or crashes).
 *
 * Kept free of `new Worker(...)` itself so it is testable in Node: the worker
 * factory is injected (see index.ts for the Vite one).
 */
import { runCopySimulation, type SimOptions, type SimResult } from './engine';
import { unpackResult, type SimRequest, type SimResponse } from './protocol';
import type { CopyConfig, SimFill } from './types';

/** The slice of the DOM Worker API this client uses. */
export interface WorkerLike {
  postMessage(msg: SimRequest): void;
  terminate(): void;
  onmessage: ((e: { data: SimResponse }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface WorkerSimulatorOptions {
  /** Creates the worker; null / omitted = always synchronous. */
  createWorker?: (() => WorkerLike) | null;
  /** Replays with at least this many fills go to the worker. Default 5000. */
  threshold?: number;
  /** Terminate the worker after this long idle, ms (0 = immediately). Default 30000. */
  idleMs?: number;
}

export const WORKER_THRESHOLD = 5_000;

export type CopySimulator = (fills: SimFill[], config: CopyConfig, opts?: SimOptions) => SimResult | Promise<SimResult>;

export type WorkerSimulator = CopySimulator & {
  /** Terminate the worker; jobs in flight finish synchronously. */
  dispose(): void;
  /** Whether the next large job would use a worker. */
  readonly usesWorker: boolean;
};

interface Job {
  fills: SimFill[];
  config: CopyConfig;
  opts: SimOptions | undefined;
  resolve(r: SimResult): void;
  reject(e: unknown): void;
}

export function createWorkerSimulator(o: WorkerSimulatorOptions = {}): WorkerSimulator {
  const threshold = o.threshold ?? WORKER_THRESHOLD;
  const idleMs = o.idleMs ?? 30_000;
  const factory = o.createWorker ?? null;
  let broken = factory === null;
  let worker: WorkerLike | null = null;
  let nextId = 1;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<number, Job>();

  const clearIdle = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const teardown = (): void => {
    clearIdle();
    const w = worker;
    worker = null;
    if (!w) return;
    w.onmessage = null;
    w.onerror = null;
    try {
      w.terminate();
    } catch {
      /* already gone */
    }
  };

  /** Run every job still waiting on the worker synchronously. */
  const drainSync = (): void => {
    const jobs = [...pending.values()];
    pending.clear();
    for (const j of jobs) {
      try {
        j.resolve(runCopySimulation(j.fills, j.config, j.opts));
      } catch (e) {
        j.reject(e);
      }
    }
  };

  const failOver = (): void => {
    broken = true;
    teardown();
    drainSync();
  };

  const scheduleIdle = (): void => {
    clearIdle();
    if (idleMs <= 0) teardown();
    else idleTimer = setTimeout(teardown, idleMs);
  };

  const ensureWorker = (): WorkerLike | null => {
    if (broken || !factory) return null;
    clearIdle();
    if (worker) return worker;
    let w: WorkerLike;
    try {
      w = factory();
    } catch {
      broken = true;
      return null;
    }
    w.onmessage = (e) => {
      const msg = e.data;
      const job = pending.get(msg.id);
      if (!job) return;
      pending.delete(msg.id);
      if (msg.ok) job.resolve(unpackResult(msg.result, job.fills));
      else job.reject(new Error(msg.error));
      if (pending.size === 0) scheduleIdle();
    };
    w.onerror = () => failOver();
    worker = w;
    return w;
  };

  const simulate = (fills: SimFill[], config: CopyConfig, opts?: SimOptions): SimResult | Promise<SimResult> => {
    if (fills.length < threshold) return runCopySimulation(fills, config, opts);
    const w = ensureWorker();
    if (!w) return runCopySimulation(fills, config, opts);
    return new Promise<SimResult>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { fills, config, opts, resolve, reject });
      try {
        w.postMessage({ id, fills, config, opts });
      } catch {
        // e.g. DataCloneError: run this one on the main thread instead.
        pending.delete(id);
        try {
          resolve(runCopySimulation(fills, config, opts));
        } catch (e) {
          reject(e);
        }
        if (pending.size === 0) scheduleIdle();
      }
    });
  };

  const dispose = (): void => {
    teardown();
    drainSync();
  };
  return Object.defineProperties(simulate, {
    dispose: { value: dispose },
    usesWorker: { get: () => !broken && factory !== null },
  }) as unknown as WorkerSimulator;
}
