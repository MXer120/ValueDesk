/**
 * Glyphs for the drawing toolbar.
 *
 * OUTLINE ONLY, the way TradingView draws its toolbar: one 1px stroke, small
 * hollow handles, and no fill anywhere - not on zones, not on vertex dots, not
 * on arrowheads. An earlier set filled those, and at 24px a filled zone or a
 * solid dot outweighs every hairline around it, so the strip read as a column
 * of solid blobs rather than of tools.
 *
 * One vocabulary for every tool, the one TradingView's toolbar taught traders:
 * a small hollow HANDLE wherever the tool has an anchor you click and drag,
 * and a line that runs to the EDGE of the box where the drawing runs off the
 * chart. A trend line is two handles and the line between them; a ray is one
 * handle and a line to the corner; an extended line crosses the whole box with
 * its two handles inside it.
 *
 * Drawing: 24 units at 24px, `currentColor` strokes, 1px wide, and the
 * viewBox origin at -0.5 so integer coordinates land on pixel CENTRES and an
 * axis-aligned 1px line covers one pixel column at full colour instead of two
 * at half (see the note in DrawingRail.tsx). Axis-aligned runs therefore use
 * whole numbers; diagonals and curves are free. Lines stop short of a handle
 * rather than running through it, so each anchor reads as a ring.
 *
 * All original drawings; no icon set is copied.
 */
import type { ReactElement } from 'react';

const SVG = {
  viewBox: '-0.5 -0.5 24 24',
  width: 24,
  height: 24,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
} as const;

/** An anchor handle: a hollow ring, something to grab. */
const H = ({ x, y }: { x: number; y: number }) => <circle cx={x} cy={y} r={1.8} />;
/** A vertex on the pattern tools: a smaller ring. */
const V = ({ x, y }: { x: number; y: number }) => <circle cx={x} cy={y} r={1.3} />;

const icon = (children: ReactElement | ReactElement[]): ReactElement => <svg {...SVG}>{children}</svg>;

// --- cursor ------------------------------------------------------------------

export const CursorIcon = icon(<path d="M12 2v6M12 16v6M2 12h6M16 12h6" />);

// --- lines -------------------------------------------------------------------

export const TrendLineIcon = icon([
  <path key="l" d="M6.3 17.7 17.7 6.3" />,
  <H key="a" x={5} y={19} />,
  <H key="b" x={19} y={5} />,
]);

export const RayIcon = icon([<path key="l" d="M7.3 16.7 21 3" />, <H key="a" x={6} y={18} />]);

export const ExtendedLineIcon = icon([
  <path key="l" d="M3 21l3.7-3.7M9.3 14.7l5.4-5.4M17.3 6.7 21 3" />,
  <H key="a" x={8} y={16} />,
  <H key="b" x={16} y={8} />,
]);

export const InfoLineIcon = icon([
  <path key="l" d="M6.3 17.7l5.4-5.4" />,
  <H key="a" x={5} y={19} />,
  <H key="b" x={13} y={11} />,
  <path key="t" d="M15 4h6v5h-6zM17 6.5h2" />,
]);

export const TrendAngleIcon = icon([
  <path key="base" d="M4 19h16" />,
  <path key="l" d="M4 19 17.6 7.2" />,
  <H key="b" x={19} y={6} />,
  <path key="arc" d="M11 19a7 7 0 0 0-1.7-4.6" />,
]);

export const HorizontalLineIcon = icon([<path key="l" d="M3 12h7.2M13.8 12H21" />, <H key="a" x={12} y={12} />]);
export const HorizontalRayIcon = icon([<path key="l" d="M6.8 12H21" />, <H key="a" x={5} y={12} />]);
export const HorizontalSegmentIcon = icon([
  <path key="l" d="M6.8 12h10.4" />,
  <H key="a" x={5} y={12} />,
  <H key="b" x={19} y={12} />,
]);
export const VerticalLineIcon = icon([<path key="l" d="M12 3v7.2M12 13.8V21" />, <H key="a" x={12} y={12} />]);
export const VerticalRayIcon = icon([<path key="l" d="M12 17.2V3" />, <H key="a" x={12} y={19} />]);
export const VerticalSegmentIcon = icon([
  <path key="l" d="M12 6.8v10.4" />,
  <H key="a" x={12} y={5} />,
  <H key="b" x={12} y={19} />,
]);
export const CrossLineIcon = icon([<path key="l" d="M3 12h7.2M13.8 12H21M12 3v7.2M12 13.8V21" />, <H key="a" x={12} y={12} />]);

export const PriceLineIcon = icon([<path key="l" d="M3 12h10" />, <path key="t" d="M13 12l3-5h5v10h-5z" />]);

export const ParallelChannelIcon = icon([
  <path key="a" d="M6.6 11.2 17.4 5.8" />,
  <H key="h1" x={5} y={12} />,
  <H key="h2" x={19} y={5} />,
  <path key="b" d="M3 20 21 11" />,
]);

export const PriceChannelIcon = icon([
  <path key="a" d="M3 10 21 2" />,
  <path key="m" d="M3 15 21 7" strokeDasharray="2 2" />,
  <path key="b" d="M3 20 21 12" />,
]);

// --- fib & gann --------------------------------------------------------------

export const FibRetracementIcon = icon([
  <path key="l" d="M7 5h14M7 9h14M7 12h14M7 15h14M7 19h14" />,
  <H key="a" x={4} y={5} />,
  <H key="b" x={4} y={19} />,
]);

export const FibExtensionIcon = icon([
  <path key="z" d="M4.6 17.5 7.9 9.6M9.4 9.7l2.3 3.5" />,
  <H key="a" x={4} y={19} />,
  <H key="b" x={8.6} y={8} />,
  <H key="c" x={12.6} y={14.6} />,
  <path key="lv" d="M16 4h5M16 9h5M16 14h5M16 19h5" />,
]);

export const FibTimeZoneIcon = icon(<path d="M4 4v16M7 4v16M10 4v16M14 4v16M21 4v16" />);

export const FibFanIcon = icon([
  <path key="r" d="M6.4 16.9 21 3M6.7 17.6 21 8M6.9 18.3 21 13M7 19.1 21 18" />,
  <H key="o" x={5} y={18.5} />,
]);

export const GannBoxIcon = icon([
  <path key="b" d="M4 4h16v16H4z" />,
  <path key="g" d="M4 10h16M4 14h16M10 4v16M14 4v16" strokeDasharray="1.5 1.5" />,
  <path key="d" d="M4 20 20 4" />,
]);

export const GannFanIcon = icon([
  <path key="r" d="M6.3 17.7 20 4M6.7 18.2 20 11M5.7 17.3 11 4M6.9 18.9 20 17M5.2 16.8 7 4" />,
  <H key="o" x={5} y={18.5} />,
]);

// --- patterns ------------------------------------------------------------------

export const XabcdIcon = icon([
  <path key="z" d="M4 16.8 7.5 6.2M8.5 6.2l3 5.7M12.5 11.9l3-4.6M16.5 7.4l3.7 9.4" />,
  <path key="g" d="M4 17l8-4.5" strokeDasharray="1.5 1.5" />,
  <V key="x" x={3.5} y={18} />,
  <V key="a" x={8} y={5} />,
  <V key="b" x={12} y={13} />,
  <V key="c" x={16} y={6.2} />,
  <V key="d" x={20.5} y={18} />,
]);

export const AbcdIcon = icon([
  <path key="z" d="M4 17.8 8.4 7.3M9.6 7.2l3.6 5.6M14.6 12.9l5.5-7.8" />,
  <path key="g" d="M4.5 18 13 14" strokeDasharray="1.5 1.5" />,
  <V key="a" x={3.5} y={19} />,
  <V key="b" x={9} y={6} />,
  <V key="c" x={14} y={14} />,
  <V key="d" x={21} y={4} />,
]);

export const HeadShouldersIcon = icon([
  <path key="z" d="M2.5 19.5 5.5 11.5 8.5 16 12 4.5l3.5 11.5 3-4.5 3 8" />,
  <path key="n" d="M3 16h18" strokeDasharray="1.5 1.5" />,
]);

export const ElliottImpulseIcon = icon([
  <path key="z" d="M3.6 18.8 5.4 13M6.8 13.2l1.6 2M9.8 14.8l4.4-8.6M15.8 6.6l1.4 2.4M18.7 9l2-3.8" />,
  <V key="0" x={3} y={20} />,
  <V key="1" x={6} y={12} />,
  <V key="2" x={9} y={16} />,
  <V key="3" x={15} y={5} />,
  <V key="4" x={18} y={10} />,
  <V key="5" x={21} y={4} />,
]);

export const ElliottCorrectionIcon = icon([
  <path key="z" d="M4.6 5.2 8.4 14.8M10 14.8l3.2-4.6M14.8 10.2l5.5 8.6" />,
  <V key="0" x={4} y={4} />,
  <V key="a" x={9} y={16} />,
  <V key="b" x={14} y={9} />,
  <V key="c" x={21} y={20} />,
]);

// --- projection & measurement -----------------------------------------------

export const LongPositionIcon = icon(<path d="M4 4h16v16H4zM4 13h16M12 10.5V6.5M10 8.5l2-2 2 2" />);

export const ShortPositionIcon = icon(<path d="M4 4h16v16H4zM4 11h16M12 13.5v4M10 15.5l2 2 2-2" />);

export const PriceRangeIcon = icon(<path d="M4 4h16M4 20h16M12 7v10M10 9l2-2 2 2M10 15l2 2 2-2" />);

export const DateRangeIcon = icon(<path d="M4 4v16M20 4v16M7 12h10M9 10l-2 2 2 2M15 10l2 2-2 2" />);

/** Date and price range: the box the measure tool draws, with its diagonal. */
export const MeasureIcon = icon(<path d="M4 4h16v16H4zM8 16l8-8M12.5 8H16v3.5" />);

// --- shapes & brushes --------------------------------------------------------

export const BrushIcon = icon([
  <path key="p" d="M16.6 3.4a2.1 2.1 0 0 1 3 0l1 1a2.1 2.1 0 0 1 0 3L8.6 19.4 4 21l1.6-4.6z" />,
  <path key="t" d="M15.2 4.8 19.2 8.8" />,
]);

export const HighlighterIcon = icon([
  <path key="b" d="M15.5 3 21 8.5l-8.5 8.5H8v-4.5z" />,
  <path key="s" d="M11 7.5l5.5 5.5" />,
  <path key="m" d="M3 21h11" />,
]);

export const RectangleIcon = icon([<path key="r" d="M5.8 6h12.4M5.8 18h12.4M4 7.8v8.4M20 7.8v8.4" />, <H key="a" x={4} y={6} />, <H key="b" x={20} y={18} />, <H key="c" x={20} y={6} />, <H key="d" x={4} y={18} />]);

export const CircleIcon = icon([<circle key="c" cx={12} cy={12} r={8} />, <H key="o" x={12} y={12} />]);

export const TriangleIcon = icon([<path key="t" d="M12 4 20.5 19.5h-17z" />]);

export const PathIcon = icon([
  <path key="z" d="M4 17.3 8.3 9.7M10 9.6l3.3 4.7M15 14.3l5-7.6" />,
  <H key="a" x={3} y={19} />,
  <H key="b" x={9} y={8} />,
  <H key="c" x={14} y={16} />,
  <H key="d" x={21} y={5} />,
]);

export const ArrowIcon = icon(<path d="M4 20 19 5M12 5h7v7" />);

// --- annotation --------------------------------------------------------------

export const TextIcon = icon(<path d="M4 4h16M12 4v16M10 20h4" />);

/** A note card with a turned corner. */
export const NoteIcon = icon(<path d="M5 3h10l4 4v14H5zM15 3v4h4M8 11h8M8 15h6" />);

export const TagIcon = icon([<path key="p" d="M6 3v18" />, <path key="f" d="M6 4h12l-3 4 3 4H6" />]);

// --- toolbar actions -----------------------------------------------------------

export const MagnetIcon = icon(<path d="M6 4v8a6 6 0 0 0 12 0V4h-3.5v8a2.5 2.5 0 0 1-5 0V4zM6 8h3.5M14.5 8H18" />);

export const StayDrawingIcon = icon([
  <path key="p" d="M3.5 17.5 4.2 14.3l9-9 2.5 2.5-9 9z" />,
  <path key="l" d="M15 15h6v6h-6zM16.5 15v-1.5a1.5 1.5 0 0 1 3 0V15" />,
]);

export const LockIcon = icon(<path d="M6 11h12v10H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3M12 15v2" />);
export const UnlockIcon = icon(<path d="M6 11h12v10H6zM8.5 11V8a3.5 3.5 0 0 1 6.9-.8M12 15v2" />);

export const EyeIcon = icon([
  <path key="e" d="M2.5 12c2.4-4.2 5.6-6.3 9.5-6.3s7.1 2.1 9.5 6.3c-2.4 4.2-5.6 6.3-9.5 6.3S4.9 16.2 2.5 12z" />,
  <circle key="p" cx={12} cy={12} r={2.8} />,
]);
export const EyeOffIcon = icon([
  <path key="e" d="M5.4 8C4.3 9 3.3 10.4 2.5 12c2.4 4.2 5.6 6.3 9.5 6.3 1.5 0 2.8-.3 4.1-.9M9.2 6.1c.9-.3 1.8-.4 2.8-.4 3.9 0 7.1 2.1 9.5 6.3-.6 1.1-1.3 2.1-2.1 2.9" />,
  <path key="s" d="M4 4l16 16" />,
]);

export const TrashIcon = icon([
  <path key="a" d="M4 6.5h16" />,
  <path key="b" d="M9.5 6.5V4.5h5v2" />,
  <path key="c" d="M6 6.5l1 13.5h10l1-13.5" />,
  <path key="d" d="M10.5 10.5v6M13.5 10.5v6" />,
]);

export const MoreIcon = icon([
  <circle key="a" cx={6} cy={12} r={1.3} />,
  <circle key="b" cx={12} cy={12} r={1.3} />,
  <circle key="c" cx={18} cy={12} r={1.3} />,
]);

/** A tool the catalogue has never seen (a future library build). */
export const UnknownToolIcon = icon(<path d="M4 4h16v16H4zM9 15l6-6" />);
