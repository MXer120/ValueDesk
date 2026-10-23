/**
 * One small mark per algo order type (menu.ts), for the order ticket's menu and
 * its Algo tab: the idea of the order, not its parameters. 16px, stroked in
 * currentColor, so a row's hover and chosen colours carry into the mark.
 */
import type { UiKind } from './menu';

const PATHS: Record<UiKind, JSX.Element> = {
  // Even slices over time: four equal bars.
  twap: <path d="M3 12V7M6.5 12V7M10 12V7M13.5 12V7M2 13.5h13" />,
  // Slices that rest, then catch up: bars and an arrow along them.
  chasetwap: <><path d="M3 12V8M6.5 12V8M10 12V8M2 13.5h13" /><path d="M9.5 4h4.5M12 2l2 2-2 2" /></>,
  // Following the volume of the day: bars of the volume curve.
  vwap: <path d="M3 12V9M6 12V5M9 12V7M12 12V4M2 13.5h13" />,
  // A share of what others trade: a pie with its slice out.
  pov: <><circle cx="7.5" cy="8.5" r="5" /><path d="M7.5 8.5V3.5M7.5 8.5h5" /><path d="M10 2.5a5 5 0 0 1 3.5 3.5H10Z" /></>,
  // One clip above the water, the rest below.
  iceberg: <><path d="M1.5 8h13" strokeDasharray="1.6 1.6" /><path d="M5 8 7 4.5 8.5 6l1-1.5L11 8" /><path d="M4 8l1.5 5h5L12 8" /></>,
  // Following the best price: a marker and the arrow after it.
  chase: <><circle cx="12" cy="5" r="1.8" /><path d="M2.5 12.5 9 6.5M9 6.5H5.5M9 6.5V10" /></>,
  // A ladder between two prices.
  scale: <path d="M3 3.5h4M3 6.5h6.5M3 9.5h9M3 12.5h11.5" />,
  // The same amount, again and again.
  dca: <><path d="M13 6.5A5.2 5.2 0 0 0 3.4 5M3 2.5v2.8h2.8" /><path d="M3 9.5a5.2 5.2 0 0 0 9.6 1.5M13 13.5v-2.8h-2.8" /></>,
  // Many small orders at once.
  swarm: <><circle cx="4" cy="5" r="1.2" /><circle cx="8" cy="3.5" r="1.2" /><circle cx="12" cy="5.5" r="1.2" /><circle cx="5.5" cy="9.5" r="1.2" /><circle cx="10" cy="9.5" r="1.2" /><circle cx="7.5" cy="13" r="1.2" /></>,
  // If this, then that: a fork.
  conditional: <><path d="M3 8h4" /><path d="m7 8 3-4h3M7 8l3 4h3" /><circle cx="3" cy="8" r="1.2" /></>,
  // A stop that follows the price at a distance.
  trailing: <><path d="M1.5 11 5 7.5l2.5 2L12 4.5" /><path d="M2.5 13.5 6 10l2.5 2 4.5-5" strokeDasharray="1.6 1.6" /></>,
  // An entry with its take-profit and stop-loss around it.
  bracket: <><path d="M5 3H3v10h2M11 3h2v10h-2" /><path d="M6 8h4" /></>,
  // Several markets in one order.
  basket: <><path d="M2.5 6.5h11l-1.3 6.5H3.8Z" /><path d="M5.5 6.5 7.5 3M10.5 6.5 8.5 3M6 9v2M8 9v2M10 9v2" /></>,
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
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[kind]}
    </svg>
  );
}
