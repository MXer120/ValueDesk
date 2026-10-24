/**
 * The chart's small icons that the app-wide menu set (MENU_ICONS in
 * dashboard/tabExtras.tsx: settings, show, hide, lock, front, back, duplicate,
 * remove, close) does not have: "more", the line-width glyphs, and the pane
 * moves of an indicator's menu. Drawn in that set's hand - 16-unit outlines at
 * 15px, 1.35 stroke, round joins, in the text's colour - so a menu mixing the
 * two reads as one set.
 *
 * All original drawings; no icon set is copied.
 */
import type { ReactElement, ReactNode } from 'react';

const glyph = (d: ReactNode): ReactElement => (
  <svg
    viewBox="0 0 16 16"
    width="15"
    height="15"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.35"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable={false}
  >
    {d}
  </svg>
);

/** "More": three dots. */
export const MoreIcon = glyph(
  <>
    <circle cx="3.5" cy="8" r="0.9" />
    <circle cx="8" cy="8" r="0.9" />
    <circle cx="12.5" cy="8" r="0.9" />
  </>,
);

export const ArrowUpIcon = glyph(<path d="M8 13V3.5M4.5 7 8 3.5 11.5 7" />);
export const ArrowDownIcon = glyph(<path d="M8 3v9.5M4.5 9 8 12.5 11.5 9" />);

/** A pane of its own: a frame split by a divider. */
export const NewPaneIcon = glyph(
  <>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <path d="M2.5 9.5h11" />
  </>,
);
/** The main chart: two candles. */
export const MainChartIcon = glyph(<path d="M5 2.5v11M11 4v9M3.5 5.5h3v5h-3zM9.5 6.5h3v4h-3z" />);
/** Into another pane: a frame with an arrow going down into its lower half. */
export const MergePaneIcon = glyph(
  <>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <path d="M2.5 8.5h11M8 4.5V11M6 9l2 2 2-2" />
  </>,
);

/** The style bar's width and dash pickers show the line itself. */
export const lineIcon = (width: number, dashed = false): ReactElement => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable={false}>
    <path d="M2 8h12" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeDasharray={dashed ? '3 2' : undefined} />
  </svg>
);
