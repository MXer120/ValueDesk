/**
 * The unit every max-slippage field shows: basis points or percent, one choice for the whole app
 * (kept in localStorage `vs.slipUnit`). A field keeps its own value as it always did; switching the
 * unit converts what is shown (10 bp <-> 0.10%), never the value.
 */
import { fmtFixed, localize } from './numStyle';
import { useSyncExternalStore } from 'react';

export type SlipUnit = 'bp' | 'pct';
const KEY = 'vs.slipUnit';
const subs = new Set<() => void>();

function read(): SlipUnit {
  try {
    return localStorage.getItem(KEY) === 'pct' ? 'pct' : 'bp';
  } catch {
    return 'bp';
  }
}

let current: SlipUnit = read();

export function setSlipUnit(u: SlipUnit): void {
  current = u;
  try {
    localStorage.setItem(KEY, u);
  } catch {
    /* kept for this page only */
  }
  for (const f of subs) f();
}

export function useSlipUnit(): [SlipUnit, (u: SlipUnit) => void] {
  const u = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => current,
    () => current,
  );
  return [u, setSlipUnit];
}

const trim = (x: number, dp: number): string => String(Number(x.toFixed(dp)));

/** A slippage in percent as the unit shows it: "10" (bp) or "0.1" (%), as field text. */
export const pctAsUnit = (pct: number, u: SlipUnit): string => (Number.isFinite(pct) ? (u === 'bp' ? trim(pct * 100, 2) : trim(pct, 4)) : '');
/** Field text in the unit back to percent. */
export const unitAsPct = (text: string, u: SlipUnit): number => {
  const v = Number(text);
  return Number.isFinite(v) ? (u === 'bp' ? v / 100 : v) : Number.NaN;
};
/** "10 bp" / "0.10%". */
export const fmtSlip = (pct: number, u: SlipUnit): string => (u === 'bp' ? `${localize(trim(pct * 100, 1))} bp` : `${fmtFixed(pct, 2)}%`);
