/**
 * Dashboard contract: the two data structures the whole terminal is built from.
 *
 * The split is deliberate and is the single most important thing about this
 * directory:
 *
 *   registry  = WHAT a panel is        (id, title, what to render, its limits)
 *   layout    = WHERE a panel sits     (x/y/w/h per breakpoint)
 *
 * Nothing about position lives in the registry, and nothing about rendering
 * lives in the layout. That is what makes "move the order book" a two-number
 * edit in one file instead of a component change, and "add a panel" one entry
 * appended to an array.
 */
import type { ReactNode } from 'react';

/**
 * Breakpoint names. Fixed set rather than an open string union so that a typo
 * in the layout config is a compile error and not a silently missing layout at
 * one screen size - which would only ever be noticed by the one user on a
 * 1280px laptop.
 */
export type BreakpointName = 'lg' | 'md' | 'sm' | 'xs';

/** Ascending by min-width. Used to resolve a measured width to a breakpoint. */
export const BREAKPOINT_ORDER: readonly BreakpointName[] = ['xs', 'sm', 'md', 'lg'];

/**
 * Which directions a panel may be resized in.
 *
 * This exists because a one-line ticker strip that can be dragged to 400px
 * tall is not a feature, it is a bug the user has to undo by hand. Constraining
 * it here - next to the component that has the constraint - means the layout
 * config never has to know about it.
 */
export type ResizeMode = 'both' | 'horizontal' | 'vertical' | 'none';

/**
 * There is no panel SURFACE option, and this note is here so nobody adds one
 * back. Every panel is the same card: a --bg-panel fill, a 4px radius, no
 * border, separated from its neighbours by the 4px gutter. A `chrome` field
 * used to pick between that and a transparent box, on the mistaken reading that
 * the reference's panels were unfilled - they are not, and a page of unfilled
 * panels reads washed out. What panels genuinely do not have is a title bar and
 * a permanent drag affordance. See dashboard.css.
 */

/**
 * How the panel body handles content that is taller than the panel.
 *
 * 'auto'   - the body scrolls. Correct for anything list-shaped.
 * 'hidden' - the body does not scroll, and the content is expected to size
 *            itself to the box (chart, order book). These components measure
 *            their container and adapt; giving them a scrollbar would let them
 *            grow forever instead of fitting.
 */
export type PanelScroll = 'auto' | 'hidden';

/**
 * One panel, declared once.
 *
 * `C` is the context type the panel's render functions receive - for the trade
 * page that is `TradeContext` (see registry.tsx). Panels are pure functions of
 * that context; they never reach for global state, which is what lets the
 * dashboard re-render them anywhere in the grid without surprises.
 */
export interface PanelDefinition<C> {
  /**
   * Stable identifier. This is the key used in the layout config AND in the
   * user's saved localStorage layout, so renaming it silently orphans every
   * saved position for that panel (it falls back to the config default, which
   * is safe but surprising). Treat it as permanent.
   */
  id: string;

  /**
   * The panel's ACCESSIBLE NAME. Never painted: there is no title bar. It is
   * the region's `aria-label` and the name an error boundary reports under, so
   * it still has to be a real, human-readable string - a screen reader has
   * nothing else to distinguish seven sibling regions by. A function when it
   * depends on live context.
   */
  title: string | ((ctx: C) => string);

  /**
   * The panel content. Rendered inside the body wrapper.
   *
   * The second argument is the breakpoint the grid has resolved to, which a
   * panel needs when its CONTENT changes shape between layouts rather than just
   * its box - the book/tape module picks up the chart as a third tab at the two
   * narrow breakpoints, where the chart has no column of its own. It is passed
   * rather than read from a media query so that the tab list and the layout
   * that dropped the chart can never disagree about which breakpoint is live.
   */
  render: (ctx: C, bp: BreakpointName) => ReactNode;

  /** Minimum size in GRID UNITS (columns / rows), not pixels. */
  minW?: number;
  minH?: number;

  /**
   * Minimum height in PIXELS, which is what a component actually needs.
   *
   * A grid row is not the same height at every breakpoint - `lg` DERIVES its row
   * from the viewport (about 7px) while md/sm/xs use a fixed 26px - so one
   * `minH` in rows means two very different floors. The order book declared
   * `minH: 10` and got ~70px at lg: 41px of tab bar plus its padding and its
   * controls left nineteen pixels for the ladder, so a panel at its own declared
   * minimum rendered ZERO price levels.
   *
   * Stated in pixels and converted per breakpoint, a floor means the same thing
   * everywhere. When both are given the larger wins.
   */
  minPx?: number;
  maxW?: number;
  maxH?: number;

  /** Default 'both'. */
  resize?: ResizeMode;

  /** Default 'auto'. */
  scroll?: PanelScroll;

  /**
   * Default true. Set false for content that manages its own insets (the
   * chart's canvas, the order book's flush rows) so the body adds no padding
   * of its own.
   */
  pad?: boolean;

  /**
   * Predicate for panels that do not apply in every context or at every screen
   * size - a perps-only panel on a spot market, or the chart, which has no
   * column of its own once the terminal is down to two. A hidden panel keeps
   * its saved position; it is simply not rendered or placed while the predicate
   * is false, and reappears where it was when it becomes true again.
   *
   * A panel hidden at a breakpoint must still be REACHABLE there - dropping the
   * chart from the narrow layouts is only acceptable because the book panel
   * picks it up as a tab at exactly those breakpoints. Hiding a panel with no
   * second route to it makes a feature silently vanish on a phone.
   */
  when?: (ctx: C, bp: BreakpointName) => boolean;

  /**
   * Ships SWITCHED OFF: offered in the layout menu, absent from the grid until
   * someone ticks it.
   *
   * This is how a new panel is added to a dashboard people already use. Adding
   * one visible-by-default would push every saved layout around on upgrade -
   * the panel appears, the compactor moves its neighbours, and a workspace
   * someone arranged deliberately is rearranged for them. Off by default, the
   * upgrade changes nothing until they ask for it.
   *
   * Distinct from `when`, which is about whether a panel CAN apply at all.
   * `defaultHidden` is a preference; `when` is a capability.
   */
  defaultHidden?: boolean;
}

/**
 * A panel's position and size, in grid units, for one breakpoint.
 * This is exactly what gets written to localStorage - nothing else.
 */
export interface PanelPlacement {
  /** Panel id. Matches PanelDefinition.id. */
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Grid geometry for one breakpoint. */
export interface GridMetrics {
  /**
   * Columns. 48 across every breakpoint, not 12: the measured design puts the
   * chart at 1114px and the book and the order ticket at 395px each inside a
   * 1912px content width, and 28/10/10 of 48 lands all three within a pixel.
   * There is no 12-column split that does - the closest is 7/2/3, which is
   * 1087/306/462. See layout.ts for the arithmetic.
   */
  cols: number;

  /**
   * Height of one grid row, in pixels. Ignored when `fitRows` is set AND the
   * dashboard has a measurable height.
   */
  rowHeight: number;

  /**
   * Derive `rowHeight` so that exactly this many rows fill the visible
   * dashboard area - i.e. "the default layout should fill the viewport with no
   * page scroll".
   *
   * The count does NOT have to be the whole layout, but on this dashboard it
   * is: only `lg` sets it, to the full 90-row arrangement, so nothing scrolls at
   * all. The count itself is not a scale - doubling it does not make anything
   * smaller, it only makes the bands finer, because every placement is in the
   * same units. What it buys is resolution: see the note above GRID in
   * layout.ts.
   *
   * IMPORTANT: this only does something useful where the dashboard has a
   * definite height, otherwise the derived row height is a fixed point of
   * itself. styles.css pins the app to the viewport from >=994px
   * (`.appcontent { flex: 1; min-height: 0 }`). Below that the page scrolls
   * normally and the dashboard's height is its own content height, which is why
   * `md` - whose range reaches down to an 808px window - uses a fixed row like
   * `sm` and `xs`. If you set this on one of those three it degrades to
   * `rowHeight` rather than misbehaving, but it will not do what you want.
   *
   * The floor that stops this shrinking without limit is a minimum DASHBOARD
   * HEIGHT in Dashboard.tsx, deliberately not a minimum row height: a floor on
   * the row would make this count decide which screens scroll.
   */
  fitRows?: number;

  /** [horizontal, vertical] gap between panels, in pixels. */
  margin: [number, number];

  /** [horizontal, vertical] padding inside the grid container, in pixels. */
  containerPadding: [number, number];
}

/**
 * The complete layout configuration for one dashboard. See layout.ts - that
 * file is the knob; this is just its shape.
 */
export interface DashboardConfig {
  /**
   * Namespaces the saved layout in localStorage (`ot.dashboard.<id>`).
   * Two dashboards with different ids never fight over the same saved state.
   */
  id: string;

  /**
   * Bump this when a default layout change must reach users who already have
   * a saved layout. Saved state carrying a different version is discarded on
   * load, which is the only way to push a new default to an existing session -
   * without it, the first person to drag a panel is frozen on the old design
   * forever.
   */
  version: number;

  /** Breakpoint name -> minimum container width in px. The smallest must be 0. */
  breakpoints: Record<BreakpointName, number>;

  /** Grid geometry per breakpoint. */
  grid: Record<BreakpointName, GridMetrics>;

  /** Default placements per breakpoint. */
  layouts: Record<BreakpointName, PanelPlacement[]>;

  /**
   * Named canvases the dashboard ships with, switched from the icon rail
   * (SideBar.tsx). The first is the designed default and becomes the user's
   * current arrangement; the others are added once each (storage.ts
   * seedTerminals), so deleting one keeps it deleted.
   */
  terminals?: TerminalSeed[];
}

export interface TerminalSeed {
  id: string;
  name: string;
  /** The rail's glyph for it (SideBar.tsx). */
  icon?: string;
  /** An allow-list canvas: only `shown` panels are on it. */
  blank?: boolean;
  layouts?: Partial<Record<BreakpointName, PanelPlacement[]>>;
  shown?: string[];
  hidden?: string[];
}
