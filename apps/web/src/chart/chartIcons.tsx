/**
 * The style bar's and the settings sheet's line glyphs: the line itself, at
 * the width (and dash) it picks. Every other small icon on the chart is the
 * app-wide menu set, MENU_ICONS in dashboard/tabExtras.tsx.
 */
import type { ReactElement } from 'react';

export const lineIcon = (width: number, dashed = false): ReactElement => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable={false}>
    <path d="M2 8h12" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeDasharray={dashed ? '3 2' : undefined} />
  </svg>
);
