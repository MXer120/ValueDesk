/**
 * One mark per algo order type (menu.ts), for the order ticket's menu and its
 * Algo tab: the idea of the order, not its parameters.
 *
 * ONE FAMILY. A 16px box, every mark drawn inside 2..14 with a 1.5 stroke,
 * round caps and joins, in currentColor (a row's hover and chosen colours carry
 * into the mark). Lines, not fills, and no detail under 2px, so each reads at
 * the size it is used at and none looks heavier than its neighbour.
 */
import type { UiKind } from './menu';

const PATHS: Record<UiKind, JSX.Element> = {
  // Even slices over time: four equal bars.
  twap: <path d="M3 13V7.5M6.33 13V7.5M9.67 13V7.5M13 13V7.5M3 3.5h10" />,
  // Slices that rest, then catch up: three bars and an arrow after them.
  chasetwap: <path d="M3 13V8M6.5 13V8M10 13V8M3 3.5h8.5M10 1.75l1.75 1.75L10 5.25" />,
  // Following the volume of the day: bars of the volume curve.
  vwap: <path d="M3 13v-3M6.33 13V5M9.67 13V8M13 13V3" />,
  // A share of what others trade: a circle with its slice marked.
  pov: <><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5V8h5.5" /></>,
  // A small tip above the waterline, the bulk below.
  iceberg: <path d="M2 7h12M5.5 7 8 3.5 10.5 7M4 7l1.5 6h5L12 7" />,
  // Following the best price: an arrow towards a target.
  chase: <><circle cx="11.5" cy="4.5" r="2" /><path d="M3 13 8.5 7.5M8.5 7.5H5M8.5 7.5V11" /></>,
  // A ladder of orders between two prices.
  scale: <path d="M3 3h4M3 6.33h6M3 9.67h8M3 13h10" />,
  // The same amount, again and again.
  dca: <path d="M3 8a5 5 0 0 1 8.94-3.08M12 2v3H9M13 8a5 5 0 0 1-8.94 3.08M4 14v-3h3" />,
  // Many small orders at once.
  swarm: (
    <g fill="currentColor">
      <circle cx="4" cy="4.5" r="1" />
      <circle cx="8" cy="3" r="1" />
      <circle cx="12" cy="4.5" r="1" />
      <circle cx="5.5" cy="8.75" r="1" />
      <circle cx="10.5" cy="8.75" r="1" />
      <circle cx="8" cy="13" r="1" />
    </g>
  ),
  // If this, then that: one line that forks in two.
  conditional: <path d="M2.5 8H7l3.5-4.5H13M7 8l3.5 4.5H13" />,
  // A stop that follows the price at a distance.
  trailing: <><path d="M2 9.5 5.5 6l3 2.5L14 3" /><path d="M2 13.5 5.5 10l3 2.5L14 7" strokeDasharray="0.01 2.75" /></>,
  // An entry with its take-profit and stop-loss around it.
  // Fill fast: a bolt.
  sweep: <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8Z" />,
  bracket: <path d="M5 2.5H3v11h2M11 2.5h2v11h-2M6.5 8h3" />,
  // Several markets in one order.
  basket: <path d="M2 6.5h12l-1.5 7h-9Z M5.5 6.5 7.5 2.5M10.5 6.5 8.5 2.5M6.5 9v2M9.5 9v2" />,
};

export function AlgoIcon({ kind, size = 16 }: { kind: UiKind; size?: number }) {
  return (
    <svg
      className="oe-algo-ic"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[kind]}
    </svg>
  );
}
