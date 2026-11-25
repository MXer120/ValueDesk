/**
 * Which views on screen read the indexer: the Copy page, cohorts, who traded and the liquidation map. An incident of the
 * indexer alone is only news where one of them is open (owner 2026-11-25); elsewhere nothing on the page comes from it.
 */
import { useEffect, useSyncExternalStore } from 'react';

let open = 0;
const subs = new Set<() => void>();
const change = (d: 1 | -1) => { open += d; for (const f of subs) f(); };

/** A view that reads the indexer says so while it is mounted (and `on`). */
export function useIndexerView(on = true): void {
  useEffect(() => {
    if (!on) return;
    change(1);
    return () => change(-1);
  }, [on]);
}

export const indexerViewOpen = (): boolean => open > 0;
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useIndexerViewOpen = (): boolean => useSyncExternalStore(subscribe, indexerViewOpen, () => false);
