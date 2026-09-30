/**
 * Copy-trading simulation engine: public entry for the Copy page.
 *
 *   simulate            runs a replay; 5,000+ fills go to a module Web Worker,
 *                       everything else (and any worker failure) runs inline.
 *   runCopySimulation   the pure engine, synchronous.
 *   toSimFills          VsFill[] + current positions -> engine input (adapt.ts).
 *   skipReasonLabel     UI label for a skippedReason id.
 *
 * Algorithm and assumptions: ./README.md.
 */
import { createWorkerSimulator, type WorkerLike, type WorkerSimulator } from './client';
import { SKIP_REASONS, type SimOptions, type SimResult } from './engine';
import type { CopyConfig, SimFill } from './types';

export {
  runCopySimulation,
  isSimResult,
  isSpotSymbol,
  defaultLotSize,
  SKIP_REASONS,
  ENGINE_VERSION,
  type SimOptions,
  type SimResult,
  type SimTrade,
  type SimAction,
  type SimOpenPosition,
  type SkipReason,
  type ClampReason,
  type HaltReason,
  type LeaderEquitySource,
} from './engine';
export { toSimFills, coinOf, reconstructStartPositions, type Reconstruction } from './adapt';
export { WORKER_THRESHOLD } from './client';
export type { CopyConfig, CopySizingMode, SimFill, TraderRef } from './types';

/** Human label for a skippedReason id (falls back to the id itself). */
export function skipReasonLabel(reason: string): string {
  return (SKIP_REASONS as Record<string, string>)[reason] ?? reason;
}

let simulator: WorkerSimulator | null = null;

/** The page's simulator, created on first use so importing this module has no side effect. */
export function simulate(fills: SimFill[], config: CopyConfig, opts?: SimOptions): SimResult | Promise<SimResult> {
  if (!simulator) {
    simulator = createWorkerSimulator({
      createWorker:
        typeof Worker === 'undefined'
          ? null
          : () => new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
    });
  }
  return simulator(fills, config, opts);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    simulator?.dispose();
    simulator = null;
  });
}
