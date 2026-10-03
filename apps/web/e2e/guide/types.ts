/**
 * What the guided test run records: one row per thing that was tested, grouped
 * into stages. The summary (summary.ts) is built from these and nothing else.
 */

/**
 * A row. FINDING: the live run observed how SoDEX behaves - not a failure, but
 * for the owner to read. PLANNED: a step of a plan-only run (nothing was executed).
 */
export type ItemStatus = 'PASS' | 'FAIL' | 'WARN' | 'FINDING' | 'SKIPPED' | 'PLANNED';
export type StageStatus = 'PASS' | 'FAIL' | 'SKIPPED';
export type StageId = 'A' | 'B' | 'C' | 'D';

export const STAGE_TITLES: Record<StageId, string> = {
  A: 'Offline test suites',
  B: 'Read-only live checks',
  C: 'Builder account',
  D: 'Live money run',
};

export interface TxRef {
  chain: string;
  hash: string;
  explorer?: string;
}

export interface Item {
  id: string;
  /** A sub-heading inside the stage (e.g. "SoDEX market data"). */
  group?: string;
  title: string;
  status: ItemStatus;
  ms?: number;
  /** USD. null/undefined = not applicable. */
  costUsd?: number | null;
  /** One line: counts, what was seen, why it failed. */
  detail?: string;
  /** Where the full log of this row is (a file in the report folder). */
  log?: string;
  txs?: TxRef[];
}

export interface StageResult {
  id: StageId;
  title: string;
  status: StageStatus;
  /** Why it was skipped, or the one-line reason it failed. */
  reason?: string;
  startedAt: string;
  ms: number;
  items: Item[];
  notes: string[];
}

/** The stage's verdict from its rows: any FAIL fails it; nothing run = SKIPPED. */
export function stageStatus(items: readonly Item[]): StageStatus {
  if (items.some((i) => i.status === 'FAIL')) return 'FAIL';
  if (!items.length || items.every((i) => i.status === 'SKIPPED')) return 'SKIPPED';
  return 'PASS';
}

export function skippedStage(id: StageId, reason: string): StageResult {
  return { id, title: STAGE_TITLES[id], status: 'SKIPPED', reason, startedAt: new Date().toISOString(), ms: 0, items: [], notes: [] };
}

/** The guide was asked to stop (Ctrl+C, "q" at a wait, or the input ended). */
export class Stopped extends Error {
  override name = 'Stopped';
  constructor(readonly why: string) {
    super(why);
  }
}
