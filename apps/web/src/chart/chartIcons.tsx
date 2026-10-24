/**
 * The chart's own small glyphs: the style bar's and the settings sheet's line
 * (at the width and dash it picks), and the few toolbar / object-list icons
 * the app-wide menu set lacks - drawn in that set's hand (MENU_ICONS in
 * dashboard/tabExtras.tsx: 16px outlines, 1.35 stroke, the text's colour),
 * which every other small icon on the chart comes from.
 */
import type { ReactElement, ReactNode } from 'react';
import type { NewsKind } from './chartMarks';

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

/** What a news story is, on its marker and in its list (chartMarks.ts NewsKind). */
export const NEWS_ICONS: Record<NewsKind, ReactElement> = {
  news: CHART_ICONS.news,
  research: glyph(<><path d="M4 2.5h5.5L12 5v8.5H4z" /><path d="M9.5 2.5V5H12M6 8h4M6 10.5h3" /></>),
  institution: glyph(<path d="M2.5 6 8 3l5.5 3M3.8 6.5v5.5M6.6 6.5v5.5M9.4 6.5v5.5M12.2 6.5v5.5M2.5 13h11" />),
  insight: glyph(<path d="M6 11.5h4M6.6 13.5h2.8M8 2.5a3.8 3.8 0 0 0-2.3 6.8c.5.4.8.9.8 1.5v.2h3v-.2c0-.6.3-1.1.8-1.5A3.8 3.8 0 0 0 8 2.5Z" />),
  macro: glyph(<><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.6 5.9 5.6 8s.8 3.9 2.4 5.5" /></>),
  announcement: glyph(<><path d="M3 6.5v3h2l4.5 3v-9L5 6.5z" /><path d="M11.6 6a2.5 2.5 0 0 1 0 4M5.4 9.5l.8 3.5" /></>),
  stocks: glyph(<><path d="M5 2.5v11M11 3.5v9" /><rect x="3.5" y="5" width="3" height="5" rx=".6" /><rect x="9.5" y="6" width="3" height="4" rx=".6" /></>),
  // X's mark, drawn in the set's hand.
  post: glyph(<><path d="M3.2 3h2.6l7 10h-2.6z" /><path d="M12.6 3 8.9 7.2M7.1 8.8 3.4 13" /></>),
};
