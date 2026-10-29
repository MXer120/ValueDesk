/**
 * Every scenario, in the order they run. The order keeps the margin low: each
 * scenario ends flat (the cleanup), so the account's peak is the largest single
 * scenario, never a sum. The bootstrap comes first, the algo kinds next, copy
 * trading (which needs the leader) after them, and the fee ladder last (it puts
 * the executor on other fee steps; the cleanup puts it back on the first).
 * Slow ones only with --slow.
 */
import type { Scenario } from './scenario.ts';
import { SETUP_SCENARIOS } from './scenarios/setup.ts';
import { ALGO_SCENARIOS } from './scenarios/algos.ts';
import { COPY_SCENARIOS } from './scenarios/copy.ts';
import { FEE_SCENARIOS } from './scenarios/fees.ts';

export const CATALOGUE: readonly Scenario[] = [...SETUP_SCENARIOS, ...ALGO_SCENARIOS, ...COPY_SCENARIOS, ...FEE_SCENARIOS];

{
  const ids = new Set<string>();
  for (const s of CATALOGUE) {
    if (ids.has(s.id)) throw new Error(`two scenarios are called ${s.id}`);
    ids.add(s.id);
  }
}

/** Counts per section and kind, for the report. */
export function countByKind(list: readonly Scenario[]): Array<{ section: string; kind: string; n: number; ids: string[] }> {
  const m = new Map<string, { section: string; kind: string; n: number; ids: string[] }>();
  for (const s of list) {
    const k = `${s.section}/${s.kind}`;
    const e = m.get(k) ?? { section: s.section, kind: s.kind, n: 0, ids: [] };
    e.n += 1;
    e.ids.push(s.id);
    m.set(k, e);
  }
  return [...m.values()];
}
