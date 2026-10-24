/**
 * The chart's own small glyphs: the style bar's and the settings sheet's line
 * (at the width and dash it picks), and the few toolbar / object-list icons
 * the app-wide menu set lacks - drawn in that set's hand (MENU_ICONS in
 * dashboard/tabExtras.tsx: 16px outlines, 1.35 stroke, the text's colour),
 * which every other small icon on the chart comes from.
 */
import type { ReactElement, ReactNode } from 'react';

export const lineIcon = (width: number, dashed = false): ReactElement => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable={false}>
    <path d="M2 8h12" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeDasharray={dashed ? '3 2' : undefined} />
  </svg>
);

const glyph = (d: ReactNode, size = 15): ReactElement => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable={false}>
    {d}
  </svg>
);

export const CHART_ICONS = {
  /** News on the chart: a folded paper. */
  news: glyph(<><path d="M3.5 3h7.5v9.5a1 1 0 0 0 1 1H4a1.5 1.5 0 0 1-1.5-1.5V3.5" /><path d="M11 6h2.5v6.5a1 1 0 0 1-2 0M5.2 5.6h3.6M5.2 8h3.6M5.2 10.4h2.4" /></>),
  /** The object list: a window with its right column. */
  sidebar: glyph(<><rect x="2" y="2.8" width="12" height="10.4" rx="1.6" /><path d="M10 2.8v10.4M11.6 5.4h1M11.6 7.4h1" /></>),
  /** Save to a research folder. */
  folder: glyph(<><path d="M2.5 4.5a1 1 0 0 1 1-1h2.8l1.4 1.5h4.8a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z" /><path d="M8 7.3v3.6M6.3 9.2 8 10.9l1.7-1.7" /></>),
  /** A row's drag handle. */
  grip: glyph(<><circle cx="6" cy="4.5" r="0.7" /><circle cx="10" cy="4.5" r="0.7" /><circle cx="6" cy="8" r="0.7" /><circle cx="10" cy="8" r="0.7" /><circle cx="6" cy="11.5" r="0.7" /><circle cx="10" cy="11.5" r="0.7" /></>, 14),
} as const;
