/**
 * Each strategy's mark, drawn like the algo icons (AlgoIcon.tsx): a 20-unit glyph on a soft tile.
 *   maker  two quotes either side of a price line;
 *   grid   levels with a price zig-zagging through them;
 *   dca    equal steps on a schedule.
 */
import type { ReactNode } from 'react';
import type { Strategy } from '../../bots/presets';

const GLYPHS: Record<Strategy, ReactNode> = {
  maker: (
    <>
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
  dca: (
    <>
      <path d="M3 16.5h14" strokeOpacity="0.45" />
      <path d="M5 14v2.5M8.5 12v4.5M12 10v6.5M15.5 8v8.5" />
      <path d="M4 9.5 15.5 3.5" strokeOpacity="0.55" />
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
