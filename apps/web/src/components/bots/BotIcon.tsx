/**
 * Each strategy's mark, drawn like the algo icons (AlgoIcon.tsx): a 20-unit glyph on a soft tile.
 *   maker  two quotes either side of a price line;
 *   lead   the same quotes, led by a second price line a step ahead;
 *   grid   levels with a price zig-zagging through them.
 */
import type { ReactNode } from 'react';
import type { Strategy } from '../../bots/presets';

const GLYPHS: Record<Strategy, ReactNode> = {
  // The market maker: two resting quotes either side of the price, a clock arc for the rest it keeps.
  market: (
    <>
      <path d="M3 10h14" />
      <path d="M5 6.5h4.5M10.5 13.5H15" />
      <circle cx="5" cy="6.5" r="1.2" />
      <circle cx="15" cy="13.5" r="1.2" />
      <path d="M13.2 4.2a3 3 0 1 1-1.9 3.9" strokeOpacity="0.55" />
    </>
  ),
  maker: (
    <>
      <path d="M3 10h14" />
      <path d="M6 6.5h4M10 13.5h4" />
      <circle cx="6" cy="6.5" r="1.2" />
      <circle cx="14" cy="13.5" r="1.2" />
    </>
  ),
  lead: (
    <>
      <path d="M3 11.5h8l2-3h4" strokeOpacity="0.45" />
      <path d="M3 10h14" />
      <path d="M6 6.5h4M10 13.5h4" />
      <circle cx="6" cy="6.5" r="1.2" />
      <circle cx="14" cy="13.5" r="1.2" />
    </>
  ),
  grid: (
    <>
      <path d="M3 5h14M3 10h14M3 15h14" strokeOpacity="0.45" />
      <path d="M3.5 13 7 7l3.5 6 3.5-6 2.5 4" />
    </>
  ),
};

export function BotIcon({ strategy, size = 20, tile = true }: { strategy: Strategy; size?: number; tile?: boolean }) {
  const svg = (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPHS[strategy]}
    </svg>
  );
  return tile ? <span className={`bot-ic is-${strategy}`}>{svg}</span> : svg;
}
