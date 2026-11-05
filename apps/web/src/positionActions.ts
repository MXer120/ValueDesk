/**
 * The chart's buttons on a position line (chart/orderOverlays.ts) ask the Positions table
 * (components/Account.tsx) to act: it holds the close review and the TP/SL dialog, and nothing is
 * sent without them. Answers false when no table is there to take it.
 */
export type PositionAction = 'close' | 'tpsl';
type Listener = (symbol: string, action: PositionAction) => boolean;

const listeners = new Set<Listener>();

export function onPositionAction(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function askPositionAction(symbol: string, action: PositionAction): boolean {
  for (const fn of listeners) if (fn(symbol, action)) return true;
  return false;
}
