/**
 * Main thread <-> simulation worker messages.
 *
 * The result's trade log references the caller's leader fills. Cloning those
 * back from the worker would double the payload, so the worker nulls every
 * `leaderFill` that is just `fills[leaderIndex]` and the main thread re-attaches
 * the caller's own objects (which also keeps object identity for the UI).
 * Merged (synthetic) leader fills are sent as they are.
 */
import type { SimOptions, SimResult, SimTrade } from './engine';
import type { CopyConfig, SimFill } from './types';

export interface SimRequest {
  id: number;
  fills: SimFill[];
  config: CopyConfig;
  opts?: SimOptions;
}

export type PackedTrade = Omit<SimTrade, 'leaderFill'> & { leaderFill: SimFill | null };
export type PackedResult = Omit<SimResult, 'fills'> & { fills: PackedTrade[] };

export type SimResponse = { id: number; ok: true; result: PackedResult } | { id: number; ok: false; error: string };

/** Strip leader fills the caller already holds. MUTATES and consumes `result` (worker side). */
export function packResult(result: SimResult, fills: SimFill[]): PackedResult {
  const packed = result as unknown as PackedResult;
  for (const t of packed.fills) {
    if (t.leaderFill !== null && t.leaderFill === fills[t.leaderIndex]) t.leaderFill = null;
  }
  return packed;
}

/** Re-attach the caller's leader fills. MUTATES `packed` (main-thread side). */
export function unpackResult(packed: PackedResult, fills: SimFill[]): SimResult {
  for (const t of packed.fills) {
    if (t.leaderFill === null) t.leaderFill = fills[t.leaderIndex] ?? null;
  }
  return packed as unknown as SimResult;
}
