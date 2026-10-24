/**
 * Glyphs for the drawing toolbar.
 *
 * One vocabulary for every tool, the one TradingView's toolbar taught traders:
 * a small hollow HANDLE wherever the tool has an anchor you click and drag,
 * and a line that runs to the EDGE of the box where the drawing runs off the
 * chart. A trend line is two handles and the line between them; a ray is one
 * handle and a line to the corner; an extended line crosses the whole box with
 * its two handles inside it. Read once, it works on every family.
 *
 * Drawing: 24 units at 24px, `currentColor` strokes, 1px wide, and the
 * viewBox origin at -0.5 so integer coordinates land on pixel CENTRES and an
 * axis-aligned 1px line covers one pixel column at full colour instead of two
 * at half (see the note in DrawingRail.tsx). Axis-aligned runs therefore use
 * whole numbers; diagonals and curves are free. Fills, where a tool has a
 * zone (positions, patterns), are `currentColor` at low opacity so the armed
 * amber and the hover white still repaint the whole glyph with one property.
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

/** An anchor handle: hollow, so it reads as something to grab. */
const H = ({ x, y }: { x: number; y: number }) => <circle cx={x} cy={y} r={2.2} />;
/** A vertex dot on the pattern tools, where five handles would be noise. */
const Dot = ({ x, y }: { x: number; y: number }) => <circle cx={x} cy={y} r={1.3} fill="currentColor" stroke="none" />;
const ZONE = { fill: 'currentColor', fillOpacity: 0.18, stroke: 'none' } as const;

const icon = (children: ReactElement | ReactElement[]): ReactElement => <svg {...SVG}>{children}</svg>;

// --- cursor ------------------------------------------------------------------

export const CursorIcon = icon(<path d="M12 1v7M12 16v7M1 12h7M16 12h7" />);

// --- lines -------------------------------------------------------------------

export const TrendLineIcon = icon([
  <path key="l" d="M6.1 17.9 17.9 6.1" />,
  <H key="a" x={4.5} y={19.5} />,
  <H key="b" x={19.5} y={4.5} />,
]);

export const RayIcon = icon([<path key="l" d="M7.1 16.9 22 2" />, <H key="a" x={5.5} y={18.5} />]);

export const ExtendedLineIcon = icon([
  <path key="l" d="M2 22l4.4-4.4M9.6 14.4l4.8-4.8M17.6 6.4 22 2" />,
  <H key="a" x={8} y={16} />,
  <H key="b" x={16} y={8} />,
]);

export const InfoLineIcon = icon([
  <path key="l" d="M6.1 17.9l5.3-5.3" />,
  <H key="a" x={4.5} y={19.5} />,
  <H key="b" x={13} y={11} />,
  <path key="t" d="M15 3h7v6h-7z" />,
  <path key="r" d="M17 6h3" />,
]);

export const TrendAngleIcon = icon([
  <path key="base" d="M3 19h18" />,
  <path key="l" d="M3 19 17.3 6.6" />,
  <H key="b" x={19} y={5.1} />,
  <path key="arc" d="M11 19a8 8 0 0 0-1.9-5.2" />,
]);

export const HorizontalLineIcon = icon([<path key="l" d="M2 12h7.8M14.2 12H22" />, <H key="a" x={12} y={12} />]);
export const HorizontalRayIcon = icon([<path key="l" d="M7 12h15" />, <H key="a" x={4.8} y={12} />]);
export const HorizontalSegmentIcon = icon([
  <path key="l" d="M7 12h10" />,
  <H key="a" x={4.8} y={12} />,
  <H key="b" x={19.2} y={12} />,
]);
export const VerticalLineIcon = icon([<path key="l" d="M12 2v7.8M12 14.2V22" />, <H key="a" x={12} y={12} />]);
export const VerticalRayIcon = icon([<path key="l" d="M12 17V2" />, <H key="a" x={12} y={19.2} />]);
export const VerticalSegmentIcon = icon([
  <path key="l" d="M12 7v10" />,
  <H key="a" x={12} y={4.8} />,
  <H key="b" x={12} y={19.2} />,
]);
export const CrossLineIcon = icon([<path key="l" d="M2 12h7.8M14.2 12H22M12 2v7.8M12 14.2V22" />, <H key="a" x={12} y={12} />]);

export const PriceLineIcon = icon([<path key="l" d="M2 12h11.5" />, <path key="t" d="M13.5 12 16.8 6H22v12h-5.2z" />]);

export const ParallelChannelIcon = icon([
  <path key="a" d="M6 11.5 17.9 5.6" />,
  <H key="h1" x={4} y={12.5} />,
  <H key="h2" x={20} y={4.5} />,
  <path key="b" d="M2 21.5 22 11.5" />,
]);

export const PriceChannelIcon = icon([
  <path key="a" d="M2 10.5 22 1.5" />,
  <path key="m" d="M2 16 22 7" strokeDasharray="2 2" />,
  <path key="b" d="M2 21.5 22 12.5" />,
]);

// --- fib & gann --------------------------------------------------------------

export const FibRetracementIcon = icon([
  <path key="l" d="M7 4h15M7 9h15M7 12h15M7 15h15M7 20h15" />,
  <H key="a" x={3.8} y={4} />,
  <H key="b" x={3.8} y={20} />,
]);

export const FibExtensionIcon = icon([
  <path key="z" d="M4.3 18.4 8 9.6M9.9 9.5l2.2 3.4" />,
  <H key="a" x={3.5} y={20.3} />,
  <H key="b" x={8.8} y={7.6} />,
  <H key="c" x={13.2} y={14.6} />,
  <path key="lv" d="M16 3h6M16 8h6M16 13h6M16 19h6" />,
]);

export const FibTimeZoneIcon = icon(<path d="M3 3v18M6 3v18M9 3v18M14 3v18M22 3v18" />);

export const FibFanIcon = icon([
  <path key="r" d="M5.6 17.4 22 2M6 18.1 22 7M6.3 18.8 22 12.5M6.4 19.6 22 18" />,
  <H key="o" x={4} y={20} />,
]);

export const GannBoxIcon = icon([
  <path key="b" d="M3 3h18v18H3z" />,
  <path key="g" d="M3 9h18M3 15h18M9 3v18M15 3v18" strokeDasharray="1.5 1.5" />,
  <path key="d" d="M3 21 21 3" />,
]);

export const GannFanIcon = icon([
  <path key="r" d="M5.6 18.4 21 3M6 18.9 21 11M5.1 18 12 3M6.2 19.6 21 17M4.4 17.5 7 3" />,
  <H key="o" x={4} y={20} />,
]);

// --- patterns ------------------------------------------------------------------

export const XabcdIcon = icon([
  <path key="z" d="M3 17 8 5l4 8 4-6 5 12" />,
  <path key="f" d="M3 17 8 5l4 8z" {...ZONE} />,
  <Dot key="x" x={3} y={17} />,
  <Dot key="a" x={8} y={5} />,
  <Dot key="b" x={12} y={13} />,
  <Dot key="c" x={16} y={7} />,
  <Dot key="d" x={21} y={19} />,
]);

export const AbcdIcon = icon([
  <path key="z" d="M3 19 9 6l5 8 7-10" />,
  <path key="g" d="M3 19 14 14M9 6l12-2" strokeDasharray="1.5 1.5" />,
  <Dot key="a" x={3} y={19} />,
  <Dot key="b" x={9} y={6} />,
  <Dot key="c" x={14} y={14} />,
  <Dot key="d" x={21} y={4} />,
]);

export const HeadShouldersIcon = icon([
  <path key="z" d="M2 20 5.5 11 8.5 16 12 4l3.5 12 3-5 3.5 9" />,
  <path key="n" d="M3 16h18" strokeDasharray="1.5 1.5" />,
]);

export const ElliottImpulseIcon = icon([
  <path key="z" d="M2 20 6 12l3 4 6-11 3 5 4-7" />,
  <Dot key="0" x={2} y={20} />,
  <Dot key="1" x={6} y={12} />,
  <Dot key="2" x={9} y={16} />,
  <Dot key="3" x={15} y={5} />,
  <Dot key="4" x={18} y={10} />,
  <Dot key="5" x={22} y={3} />,
]);

export const ElliottCorrectionIcon = icon([
  <path key="z" d="M3 4l6 12 5-7 7 11" />,
  <Dot key="0" x={3} y={4} />,
  <Dot key="a" x={9} y={16} />,
  <Dot key="b" x={14} y={9} />,
  <Dot key="c" x={21} y={20} />,
]);

// --- projection & measurement -----------------------------------------------

export const LongPositionIcon = icon([
  <path key="f" d="M3 4h18v9H3z" {...ZONE} />,
  <path key="b" d="M3 4h18v16H3zM3 13h18" />,
  <path key="a" d="M12 11V6.5M9.5 9 12 6.5 14.5 9" />,
]);

export const ShortPositionIcon = icon([
  <path key="f" d="M3 11h18v9H3z" {...ZONE} />,
  <path key="b" d="M3 4h18v16H3zM3 11h18" />,
  <path key="a" d="M12 13v4.5M9.5 15l2.5 2.5 2.5-2.5" />,
]);

export const PriceRangeIcon = icon(<path d="M3 4h18M3 20h18M12 7v10M9.5 9.5 12 7l2.5 2.5M9.5 14.5 12 17l2.5-2.5" />);

export const DateRangeIcon = icon(<path d="M4 3v18M20 3v18M7 12h10M9.5 9.5 7 12l2.5 2.5M14.5 9.5 17 12l-2.5 2.5" />);

/** Date and price range: the box the measure tool draws, with its diagonal. */
export const MeasureIcon = icon(<path d="M3 4h18v16H3zM7 16 17 8M12.5 8H17v4.5" />);

// --- shapes & brushes --------------------------------------------------------

export const BrushIcon = icon([
  <path key="p" d="M17 2.8a2.3 2.3 0 0 1 3.3 0l.9.9a2.3 2.3 0 0 1 0 3.3L8.8 19.4l-5.3 1.8 1.8-5.3z" />,
  <path key="t" d="M15.4 4.4 18.6 7.6" />,
]);

export const HighlighterIcon = icon([
  <path key="b" d="M15.5 2.5 21.5 8.5l-9 9H7.5v-5z" />,
  <path key="s" d="M11 7l6 6" />,
  <path key="m" d="M3 21h10" strokeWidth={3} strokeOpacity={0.45} />,
]);

export const RectangleIcon = icon([<path key="r" d="M4 6h16v12H4z" />, <path key="f" d="M4 6h16v12H4z" {...ZONE} />]);

export const CircleIcon = icon([
  <circle key="c" cx={12} cy={12} r={8.5} />,
  <circle key="f" cx={12} cy={12} r={8.5} {...ZONE} />,
  <Dot key="o" x={12} y={12} />,
]);

export const TriangleIcon = icon([<path key="t" d="M12 3.5 21 20H3z" />, <path key="f" d="M12 3.5 21 20H3z" {...ZONE} />]);

export const PathIcon = icon([
  <path key="z" d="M3 18 9 8l5 7 7-10" />,
  <Dot key="a" x={3} y={18} />,
  <Dot key="b" x={9} y={8} />,
  <Dot key="c" x={14} y={15} />,
  <Dot key="d" x={21} y={5} />,
]);

export const ArrowIcon = icon([
  <path key="l" d="M4 20 16.5 7.5" />,
  <path key="h" d="M20.5 3.5 19 11l-6-6z" fill="currentColor" stroke="none" />,
]);

// --- annotation --------------------------------------------------------------

export const TextIcon = icon(<path d="M3 3h18M12 3v17M10 20h4" />);

/** A note card with a turned corner. */
export const NoteIcon = icon(<path d="M4 3h12l4 4v14H4zM16 3v4h4M7 11h10M7 15h7" />);

export const TagIcon = icon([<path key="p" d="M6 2v20" />, <path key="f" d="M6 4h13l-3 4 3 4H6z" />]);

// --- toolbar actions -----------------------------------------------------------

export const MagnetIcon = icon([
  <path key="u" d="M5 3v9a7 7 0 0 0 14 0V3h-4v9a3 3 0 0 1-6 0V3z" />,
  <path key="p" d="M5 7h4M15 7h4" />,
]);

export const StayDrawingIcon = icon([
  <path key="p" d="M3 18 3.8 14.6 13.2 5.2l2.6 2.6-9.4 9.4z" />,
  <path key="l" d="M15 15h6v6h-6zM16.5 15v-1.5a1.5 1.5 0 0 1 3 0V15" />,
]);

export const LockIcon = icon(<path d="M6 11h12v10H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3M12 15v2" />);
export const UnlockIcon = icon(<path d="M6 11h12v10H6zM8.5 11V8a3.5 3.5 0 0 1 6.9-.8M12 15v2" />);

export const EyeIcon = icon([
  <path key="e" d="M2 12c2.5-4.4 5.8-6.6 10-6.6s7.5 2.2 10 6.6c-2.5 4.4-5.8 6.6-10 6.6S4.5 16.4 2 12z" />,
  <circle key="p" cx={12} cy={12} r={3} />,
]);
export const EyeOffIcon = icon([
  <path key="e" d="M5.2 7.8C4 8.9 2.9 10.3 2 12c2.5 4.4 5.8 6.6 10 6.6 1.6 0 3-.3 4.3-1M9 5.8c.9-.3 1.9-.4 3-.4 4.2 0 7.5 2.2 10 6.6-.7 1.3-1.5 2.4-2.4 3.3" />,
  <path key="s" d="M3 3l18 18" />,
]);

export const TrashIcon = icon([
  <path key="a" d="M3 6h18" />,
  <path key="b" d="M9 6V4h6v2" />,
  <path key="c" d="M5 6l1 14h12l1-14" />,
  <path key="d" d="M10 10v6M14 10v6" />,
]);

export const MoreIcon = icon([
  <circle key="a" cx={5} cy={12} r={1.7} fill="currentColor" stroke="none" />,
  <circle key="b" cx={12} cy={12} r={1.7} fill="currentColor" stroke="none" />,
  <circle key="c" cx={19} cy={12} r={1.7} fill="currentColor" stroke="none" />,
]);

/** A tool the catalogue has never seen (a future library build). */
export const UnknownToolIcon = icon(<path d="M4 4h16v16H4zM9 15l6-6" />);
