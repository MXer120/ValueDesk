/**
 * The algo order types the ticket offers, in the order of the menu. Chase
 * TWAP is a TWAP whose slices rest first (the engine's 'hybrid' execution),
 * named on its own because that is how traders look for it.
 */
import type { AlgoKind } from '@copy-engine';

/** Every kind but the bots' (volume maker, grid): those start from the Bots page, never the ticket. */
export type UiKind = Exclude<AlgoKind, 'mm' | 'grid'> | 'chasetwap';

export interface AlgoMenuItem {
  id: UiKind;
  name: string;
  detail: string;
}

export const ALGO_MENU: readonly AlgoMenuItem[] = [
  { id: 'twap', name: 'TWAP', detail: 'Even slices over a time you choose, with an urgency curve, jitter and price bounds.' },
  { id: 'chasetwap', name: 'Chase TWAP', detail: 'A TWAP whose slices rest at the best price and only take what falls behind.' },
  { id: 'vwap', name: 'VWAP', detail: "Follows the market's own volume by time of day, and adapts as it runs." },
  { id: 'pov', name: 'POV', detail: 'A fixed share of the market’s live volume: faster when it is busy, slower when it is quiet. It rests at the best price and crosses the spread only to catch up.' },
  { id: 'iceberg', name: 'Iceberg', detail: 'Shows one small clip at a time and refills it, at a price or pegged.' },
  { id: 'chase', name: 'Chase', detail: 'One post-only order that follows the best price until it fills.' },
  { id: 'scale', name: 'Scale', detail: 'A ladder of resting orders between two prices, sized and spaced by curves.' },
  { id: 'dca', name: 'DCA', detail: 'Buys at set prices: a first buy, then a limit at every price step below it (or at prices you type), bigger each step if you like.' },
  { id: 'swarm', name: 'Swarm', detail: 'Many small takers in waves, so the book refills between them.' },
  { id: 'conditional', name: 'Conditional', detail: 'When price, a move, funding, OI, spread, volume or time say so: act.' },
  { id: 'trailing', name: 'Trailing stop', detail: 'A stop that follows the price at a distance and closes when it turns.' },
  { id: 'sweep', name: 'Fill fast', detail: 'Fills as fast as the book allows: IOC limits, round after round, never past your max slippage from an oracle or SoDEX price.' },
  { id: 'bracket', name: 'Bracket', detail: 'An entry with its take-profit and stop-loss on SoDEX: when one fills, the other is cancelled.' },
  { id: 'basket', name: 'Basket', detail: 'One order over several markets at once, long and short, in USD per market.' },
];

export const engineKind = (k: UiKind): AlgoKind => (k === 'chasetwap' ? 'twap' : k);

export const menuName = (k: UiKind): string => ALGO_MENU.find((m) => m.id === k)?.name ?? k;

/** Whether the kind is sized by the ticket's Amount field. */
export const usesAmount = (k: UiKind, o: { trailWhole?: boolean; thenClose?: boolean; twapClose?: boolean } = {}): boolean =>
  k === 'dca' || k === 'basket' ? false : k === 'trailing' ? !o.trailWhole : k === 'conditional' ? !o.thenClose : k === 'twap' ? !o.twapClose : true;

/** 90 s, 12 min, 3 h 20 min, 2 d 4 h. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 s';
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 48) return mm ? `${h} h ${mm} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d} d ${hh} h` : `${d} d`;
}
