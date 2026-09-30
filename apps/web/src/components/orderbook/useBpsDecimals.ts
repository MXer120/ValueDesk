/**
 * The mid row's spread decimals, held steady - see bpsPrecision.ts for the rule
 * (three significant figures of the smallest reading in the recorder's minute,
 * clamped to [1, 4], with a 10% dead band at decade edges). The readout and the
 * spread chart's tooltip both print with this one number.
 */
import { useLayoutEffect, useRef } from 'react';
import { referenceMagnitude, stableBpsDecimals } from './bpsPrecision';
import type { Recording } from './sparkSampler';

export function useBpsDecimals(rec: Recording, current: number | null, marketKey: string): number {
  const held = useRef<{ key: string; dp: number | null }>({ key: marketKey, dp: null });
  // A new market starts from its own readings, not the last market's precision.
  const prev = held.current.key === marketKey ? held.current.dp : null;
  const ref = referenceMagnitude([...rec.history, rec.live, current]);
  const dp = stableBpsDecimals(ref, prev);
  useLayoutEffect(() => {
    // Nothing is HELD until there is a reading: a precision chosen while the
    // new market's book is still loading would otherwise be kept by the dead
    // band once real readings arrive.
    held.current = { key: marketKey, dp: ref === null ? prev : dp };
  });
  return dp;
}
