/**
 * The palette's line glyphs, drawn the app's way (DESIGN.md section 7): a 24px
 * grid, a 1.6 stroke, round caps and joins, currentColor - so a glyph takes the
 * tab's, chip's or row's own text colour (muted at rest, --text when active).
 * Rendered at 16px by default; the page marks in "Jump to" at 18px.
 */
import type { ReactNode } from 'react';
import { CohortIcon } from '../explore/cohorts/CohortIcon';

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      className="cp-ico"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

type P = { size?: number };

/* --- palette sections ------------------------------------------------------ */

export const IconHome = ({ size }: P = {}) => (
  <Svg size={size}><path d="M3.5 10.5 12 3.8l8.5 6.7V20a.8.8 0 0 1-.8.8H14.5v-5.6h-5v5.6H4.3a.8.8 0 0 1-.8-.8Z" /></Svg>
);
export const IconTraders = ({ size }: P = {}) => (
  <Svg size={size}>
    <circle cx="9" cy="8.2" r="3.4" />
    <path d="M2.8 19.8c.6-3.4 3.1-5.4 6.2-5.4s5.6 2 6.2 5.4" />
    <path d="M15.6 4.9a3.3 3.3 0 0 1 0 6.4M17.8 14.7c1.8.8 3 2.4 3.4 5.1" />
  </Svg>
);
export const IconScreener = ({ size }: P = {}) => (
  <Svg size={size}>
    <path d="M3.5 6h9M17.5 6h3M3.5 12h3M11.5 12h9M3.5 18h10.5M18.5 18h2" />
    <circle cx="15" cy="6" r="2.2" />
    <circle cx="9" cy="12" r="2.2" />
    <circle cx="16.3" cy="18" r="2.2" />
  </Svg>
);
export const IconAssets = ({ size }: P = {}) => (
  <Svg size={size}>
    <ellipse cx="9.5" cy="7" rx="6" ry="3" />
    <path d="M3.5 7v4.5c0 1.7 2.7 3 6 3M3.5 11.5V16c0 1.7 2.7 3 6 3" />
    <ellipse cx="15.5" cy="14" rx="5" ry="2.5" />
    <path d="M10.5 14v3.6c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V14" />
  </Svg>
);

/* --- home lists -------------------------------------------------------------- */

export const IconFlame = ({ size }: P = {}) => (
  <Svg size={size}>
    <path d="M12 21c-3.9 0-6.5-2.6-6.5-6.1 0-3.4 2.4-5.4 3.6-8.4.4 1.8 1.3 2.9 2.4 3.4.3-2.9 1.6-5.3 3.8-6.9-.3 2.8.8 4.6 2.2 6.4 1.2 1.6 1.9 3.4 1.9 5.4 0 3.6-2.6 6.2-7.4 6.2Z" />
  </Svg>
);
export const IconEye = ({ size }: P = {}) => (
  <Svg size={size}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </Svg>
);
export const IconClock = ({ size }: P = {}) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.2V12l3.2 2.2" />
  </Svg>
);

/* --- screener presets ---------------------------------------------------------- */

export const IconGrid = ({ size }: P = {}) => (
  <Svg size={size}>
    <rect x="3.8" y="3.8" width="6.6" height="6.6" rx="1.5" />
    <rect x="13.6" y="3.8" width="6.6" height="6.6" rx="1.5" />
    <rect x="3.8" y="13.6" width="6.6" height="6.6" rx="1.5" />
    <rect x="13.6" y="13.6" width="6.6" height="6.6" rx="1.5" />
  </Svg>
);
export const IconBadgeCheck = ({ size }: P = {}) => (
  <Svg size={size}>
    <path d="m12 2.8 2.3 1.7 2.9-.1.9 2.7 2.3 1.8-1 2.7 1 2.8-2.3 1.7-.9 2.8h-2.9L12 21.2l-2.3-1.7h-2.9l-.9-2.8-2.3-1.7 1-2.8-1-2.7 2.3-1.8.9-2.7 2.9.1Z" />
    <path d="m8.8 12 2.2 2.2 4.3-4.4" />
  </Svg>
);
export const IconTarget = ({ size }: P = {}) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="8.3" />
    <circle cx="12" cy="12" r="4.5" />
    <circle cx="12" cy="12" r=".9" fill="currentColor" />
  </Svg>
);
export const IconShield = ({ size }: P = {}) => (
  <Svg size={size}><path d="M12 2.9 19.5 5.7v5.5c0 4.5-3.1 8.1-7.5 9.9-4.4-1.8-7.5-5.4-7.5-9.9V5.7Z" /></Svg>
);
export const IconTrendUp = ({ size }: P = {}) => (
  <Svg size={size}>
    <path d="m2.8 17.6 6.3-6.3 3.9 3.9 8.2-8.2" />
    <path d="M15.6 7h5.6v5.6" />
  </Svg>
);
export const IconActivity = ({ size }: P = {}) => (
  <Svg size={size}><path d="M2.8 12h3.9l2.7-6.7 5.2 13.4 2.7-6.7h3.9" /></Svg>
);
/** The Whales preset: the cohort pages' own whale mark (CohortIcon). */
export const IconWhale = ({ size = 16 }: P = {}) => (
  <span className="cp-ico cp-ico--cohort" aria-hidden="true"><CohortIcon id="whale" size={size} /></span>
);

/* --- pages ("Jump to") ------------------------------------------------------------ */

/** Trade: two candles. */
export const IconCandles = ({ size }: P = {}) => (
  <Svg size={size}>
    <path d="M8 3.5v3M8 17.5v3M16 5.5v4M16 17.5v1" />
    <rect x="5.5" y="6.5" width="5" height="11" rx="1" />
    <rect x="13.5" y="9.5" width="5" height="8" rx="1" />
  </Svg>
);
/** Explore: a compass. */
export const IconPoints = ({ size }: P = {}) => (
  <Svg size={size}><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1.1 5.9-5.300-2.900-5.300 2.900 1.100-5.900-4.300-4.100 5.900-.8z" /></Svg>
);

export const IconBox = ({ size }: P = {}) => (
  <Svg size={size}><path d="M12 3 20 7.500v9L12 21l-8-4.500v-9z" /><path d="M4 7.500 12 12l8-4.500M12 12v9" /></Svg>
);

export const IconFunds = ({ size }: P = {}) => (
  <Svg size={size}><path d="M3.500 20h17M6 20v-7M10.500 20V8M15 20v-5M19 20V4" /></Svg>
);

export const IconCompass = ({ size }: P = {}) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m15.4 8.6-2 4.8-4.8 2 2-4.8Z" />
  </Svg>
);
/** Copy: two stacked cards with a forward arrow. */
export const IconCopyTrade = ({ size }: P = {}) => (
  <Svg size={size}>
    <rect x="8" y="8" width="12.5" height="12.5" rx="2.2" />
    <path d="M16 4.2A2.2 2.2 0 0 0 13.8 3.5H5.7a2.2 2.2 0 0 0-2.2 2.2v8.1a2.2 2.2 0 0 0 .7 1.6" />
    <path d="m12.3 14.3h4.4M14.9 12.5l1.8 1.8-1.8 1.8" />
  </Svg>
);
/** Leaderboard: a podium. */
export const IconPodium = ({ size }: P = {}) => (
  <Svg size={size}>
    <path d="M9 20.5v-11h6v11M3.5 20.5v-7H9M15 20.5v-5h5.5v5M2.5 20.5h19" />
    <path d="m12 3.5.8 1.6 1.7.2-1.2 1.2.3 1.7-1.6-.8-1.6.8.3-1.7-1.2-1.2 1.7-.2Z" />
  </Svg>
);
/** Portfolio: a pie. */
export const IconPie = ({ size }: P = {}) => (
  <Svg size={size}>
    <path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.6" />
    <path d="M13.5 3.5a7 7 0 0 1 7 7h-7Z" />
  </Svg>
);
/** Scan: a lens inside scan corners. */
export const IconScan = ({ size }: P = {}) => (
  <Svg size={size}>
    <path d="M3.5 8V5.5a2 2 0 0 1 2-2H8M16 3.5h2.5a2 2 0 0 1 2 2V8M20.5 16v2.5a2 2 0 0 1-2 2H16M8 20.5H5.5a2 2 0 0 1-2-2V16" />
    <circle cx="11.3" cy="11.3" r="3.6" />
    <path d="m14 14 2.6 2.6" />
  </Svg>
);
/** Market map: a treemap. */
export const IconMap = ({ size }: P = {}) => (
  <Svg size={size}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
    <path d="M11 3.5v17M11 12.5h9.5M15.8 12.5v8" />
  </Svg>
);

/* --- controls ---------------------------------------------------------------------- */

export const IconChevronDown = ({ size = 12 }: P = {}) => (
  <Svg size={size}><path d="m6 9 6 6 6-6" /></Svg>
);
export const IconChevronRight = ({ size }: P = {}) => (
  <Svg size={size}><path d="m9 5.5 6.5 6.5L9 18.5" /></Svg>
);
export const IconPlus = ({ size }: P = {}) => (
  <Svg size={size}><path d="M12 5v14M5 12h14" /></Svg>
);
export const IconCheck = ({ size = 14 }: P = {}) => (
  <Svg size={size}><path d="m5 12.6 4.4 4.4L19 7.2" /></Svg>
);
export const IconClose = ({ size }: P = {}) => (
  <Svg size={size}><path d="m6 6 12 12M18 6 6 18" /></Svg>
);
export const IconStar = ({ filled, size = 16 }: { filled?: boolean; size?: number } = {}) => (
  <svg className="cp-ico" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d="m12 3 2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9l-5.4 2.9 1.1-6.1-4.5-4.3 6.1-.8Z"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinejoin="round"
    />
  </svg>
);
export const IconCopy = ({ size }: P = {}) => (
  <Svg size={size}>
    <rect x="8" y="8" width="12.5" height="12.5" rx="2.2" />
    <path d="M16 4.2A2.2 2.2 0 0 0 13.8 3.5H5.7a2.2 2.2 0 0 0-2.2 2.2v8.1a2.2 2.2 0 0 0 .7 1.6" />
  </Svg>
);
export const IconArrowUpRight = ({ size }: P = {}) => (
  <Svg size={size}><path d="M7 17 17 7M8.5 7H17v8.5" /></Svg>
);
export const IconSearch = ({ size }: P = {}) => (
  <Svg size={size}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 5 5" />
  </Svg>
);
