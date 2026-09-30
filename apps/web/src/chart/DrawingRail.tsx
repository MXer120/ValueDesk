/**
 * Vertical drawing-tool rail down the LEFT edge of the chart pane.
 *
 * This replaces a "Draw ▾" dropdown in the toolbar. The move is not decoration:
 * a dropdown costs two clicks per tool and hides the armed state behind a closed
 * popup, which on a chart that also carries live order lines means the user can
 * be holding a drawing tool without any standing evidence of it. A rail keeps
 * "which tool is armed" permanently on screen, one click away, in the place
 * every professional charting terminal puts it.
 *
 * TOOL LIST IS RUNTIME, NOT AUTHORED. The names come from the caller, which gets
 * them from `getSupportedOverlays()` on the installed klinecharts build — after
 * our own custom overlays have been registered into that same global registry,
 * so the measure tool arrives through the identical path rather than being
 * special-cased here. Nothing in this file may ADD to that list: a name we
 * render but the library did not register produces a button that silently does
 * nothing when clicked. So this file only ever maps names to icons and labels,
 * and the mapping is deliberately allowed to be incomplete — a name with no
 * entry is NOT dropped, it lands in an "Other tools" group under its own
 * titleized label. A library upgrade that ships three new overlays therefore
 * gains three usable tools here on the day it lands.
 *
 * EVERY REGISTERED OVERLAY IS IN THE RAIL. The installed 10.0.2 build registers
 * sixteen, our measure tool makes seventeen, and all seventeen are here with a
 * glyph of their own — none is reachable only as a bare name in a list.
 *
 * WHICH ONES ARE ON SCREEN AT ANY MOMENT IS MEASURED, NOT AUTHORED. Seventeen
 * tools at the rail's measured 36px pitch is 612px of strip before the cursor,
 * the clear action and the collapse handle are counted, and the chart panel is
 * a resizable dashboard cell that is routinely half that tall. Rather than
 * guess a cut-off, the rail measures its own body and fills it: each tool
 * carries a rank, the highest-ranked ones that fit are drawn as glyphs, and
 * everything else moves into the "…" flyout at the foot of the strip — WITH its
 * icon, its label and its group heading, so the overflow is a browsable menu
 * and not a list of raw ids. Drag the panel taller and tools promote out of the
 * flyout into the strip on the next frame; drag it shorter and they demote. The
 * order the user sees never changes, only how many of them are glyphs.
 *
 * The icons are hand-written inline SVG on a shared 24x24 grid, drawn at 24px.
 * They are drawn with `currentColor` so the whole active/hover/disabled state
 * model is carried by one CSS `color` property, which is also what the measured
 * interaction spec wants: state is COLOUR, never weight and never a size change.
 *
 * SIZE IS A MEASUREMENT, not a preference. Sampled off the reference, its rail
 * glyphs carry 15-23px of ink in a 34px button and are drawn in --muted
 * (#c6b6ba), which ours already match on colour. Every path below is drawn to
 * fill its grid in BOTH axes — an axis-aligned tool gets arrowheads, handles or
 * a stack rather than being left as a one-dimensional scratch — because a 20x6
 * glyph is invisible next to a 19x19 one however correct it is in the abstract.
 *
 * THE THREE-WAY FAMILIES ARE DRAWN BY THEIR ENDS, which is the whole answer to
 * the old complaint that the strip shipped eleven variations of a diagonal
 * line. A line, a ray and a segment differ only in where they stop, so that is
 * exactly what the glyph shows: two ARROWHEADS means it runs off both edges of
 * the chart, one handle and one arrowhead means it starts somewhere and runs
 * off one edge, two HANDLES means it is finite. A 5px hollow circle and an open
 * chevron are not mistakable for one another at 24px, and the same three-way
 * reading works identically on the horizontal, diagonal and vertical families —
 * so it is one rule to learn, not nine glyphs to memorise.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import './rail.css';

/**
 * Shared attributes for every glyph below. Stroke-based rather than filled so a
 * single `color` change repaints the whole icon.
 *
 * THE VIEWBOX ORIGIN IS -0.5, AND THAT HALF PIXEL IS THE WHOLE POINT.
 *
 * The grid is 1:1 with device pixels (24 units drawn at 24px), so a 1px stroke
 * whose centreline sits on an INTEGER coordinate straddles the boundary between
 * two pixel columns and each of them gets half the ink. Measured, that is
 * exactly what was happening: the rail's hairlines rendered as two columns at
 * ~75% of the token colour instead of one column at 100%, which made the armed
 * tool's amber sample #c68f3a where the accent is #ffb547 — the same token, half
 * of it thrown away by antialiasing. Shifting the whole viewport by half a pixel
 * moves every integer coordinate in the paths below onto a pixel CENTRE, where a
 * 1px stroke covers one column outright.
 *
 * Two consequences bind every path in this file:
 *   1. `strokeWidth` is 1, not 1.5. A 1.5px stroke cannot land on one column
 *      whatever the offset.
 *   2. Axis-aligned strokes use INTEGER coordinates. A `.5` in a horizontal or
 *      vertical run puts that stroke back on a boundary and undoes the fix for
 *      that one line. Diagonals and curves are free — they antialias either way,
 *      and so do the reference's.
 *
 * `shapeRendering: crispEdges` would do the same job for the straight runs and
 * wreck every diagonal in the set, so the alignment is geometric instead.
 */
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

/**
 * An overlay endpoint handle.
 *
 * HOLLOW, not filled — that is how the reference draws them, and a filled dot
 * at this size reads as a bullet rather than as something you can grab. The
 * handle says "this end is an anchor you drag", and by saying so it also says
 * the line STOPS there: a handle at both ends is a segment, a handle at one end
 * and an arrowhead at the other is a ray.
 */
const Handle = ({ cx, cy }: { cx: number; cy: number }) => (
  <circle cx={cx} cy={cy} r={2.6} />
);

// --- glyphs ------------------------------------------------------------------

/* Price levels. The horizontal family is drawn by its ends — see the file
   header — and the price line is the odd one out because it carries a value. */

const HorizontalLine = (
  <svg {...SVG}>
    <path d="M2 12h6.6M15.4 12H22" />
    <path d="M6 7 2 12l4 5M18 7l4 5-4 5" />
    <Handle cx={12} cy={12} />
  </svg>
);

const HorizontalRay = (
  <svg {...SVG}>
    <path d="M6 12h16" />
    <path d="M18 7l4 5-4 5" />
    <Handle cx={3} cy={12} />
  </svg>
);

const HorizontalSegment = (
  <svg {...SVG}>
    <path d="M6 12h12" />
    <Handle cx={3} cy={12} />
    <Handle cx={21} cy={12} />
  </svg>
);

/* The same level, carrying its price in a tag on the axis side. The tag is the
   whole tell, so it is drawn big enough to read as a shape. Its top and bottom
   edges are on integers (6 / 18, not 6.5 / 17.5) so the two horizontal runs
   land on whole pixel rows like everything else in the set. */
const PriceLabel = (
  <svg {...SVG}>
    <path d="M2 12h11.5" />
    <path d="M13.5 12 16.8 6H22v12h-5.2z" />
  </svg>
);

/* Lines and channels. */

const TrendSegment = (
  <svg {...SVG}>
    <path d="M6.8 17.2 17.2 6.8" />
    <Handle cx={4.6} cy={19.4} />
    <Handle cx={19.4} cy={4.6} />
  </svg>
);

const TrendRay = (
  <svg {...SVG}>
    <path d="M6.8 17.2 20.5 3.5" />
    <path d="M14.5 3.5H21v6.5" />
    <Handle cx={4.6} cy={19.4} />
  </svg>
);

const ExtendedLine = (
  <svg {...SVG}>
    <path d="M3.5 20.5 20.5 3.5" />
    <path d="M14.5 3.5H21v6.5M9.5 20.5H3v-6.5" />
  </svg>
);

/* Channel: two rails at one angle. No handles — the trend line above already
   owns the hollow-circle silhouette, and a pair of them on the left of these
   rails read as a scissors rather than as anchors. Two clean parallels spanning
   the box is the whole idea and needs no decoration. */
const ParallelChannel = (
  <svg {...SVG}>
    <path d="M2.5 12.5 21.5 3.5" />
    <path d="M2.5 20.5 21.5 11.5" />
  </svg>
);

/* klinecharts' priceChannelLine is a parallel channel with a MEDIAN, so the
   third rail is not decoration — it is the difference between the two tools. */
const PriceChannel = (
  <svg {...SVG}>
    <path d="M2.5 10.5 21.5 1.5" />
    <path d="M2.5 16.5 21.5 7.5" />
    <path d="M2.5 22.5 21.5 13.5" />
  </svg>
);

const VerticalLine = (
  <svg {...SVG}>
    <path d="M12 2v6.6M12 15.4V22" />
    <path d="M7 6l5-4 5 4M7 18l5 4 5-4" />
    <Handle cx={12} cy={12} />
  </svg>
);

const VerticalRay = (
  <svg {...SVG}>
    <path d="M12 18V2" />
    <path d="M7 6l5-4 5 4" />
    <Handle cx={12} cy={21} />
  </svg>
);

const VerticalSegment = (
  <svg {...SVG}>
    <path d="M12 6v12" />
    <Handle cx={12} cy={3} />
    <Handle cx={12} cy={21} />
  </svg>
);

/* Retracement. Unequal spacing is the whole visual cue — an even stack would
   read as a grid — and the two anchors on opposite levels say the set is
   dragged between two points rather than being a fixed list. */
const Retracement = (
  <svg {...SVG}>
    <path d="M6 4h15M6 8h15M6 11h15M6 15h15M6 20h15" />
    <Handle cx={3.4} cy={4} />
    <Handle cx={3.4} cy={20} />
  </svg>
);

/* Measure. A framed region with a dimension arrow through it — the drafting
   glyph for "how far", and the only closed rectangle in the whole set, so it
   cannot be confused with any of the line families however fast the eye moves
   down the strip. It is also what the tool actually draws: a box with a
   readout. */
const Measure = (
  <svg {...SVG}>
    <path d="M3 4h18v16H3z" />
    <path d="M12 6v12" />
    <path d="M8.5 9.5 12 6l3.5 3.5M8.5 14.5 12 18l3.5-3.5" />
  </svg>
);

/* Freehand. A pencil rather than an abstract squiggle: at 24px a wavy line is
   one more stroke among strokes, while a tool with a body and a tip is
   recognisable before it is read. */
const Freehand = (
  <svg {...SVG}>
    <path d="M17 2.8a2.3 2.3 0 0 1 3.3 0l.9.9a2.3 2.3 0 0 1 0 3.3L8.8 19.4l-5.3 1.8 1.8-5.3z" />
    <path d="M15.4 4.4 18.6 7.6" />
  </svg>
);

/* Text on the chart. The reference draws a plain T here and so do we — it is
   the one glyph in any drawing rail that needs no explanation at all. The foot
   is short on purpose: a full-width one turns the letter into an I-beam text
   cursor, which means "select text", not "place text". */
const TextTool = (
  <svg {...SVG}>
    <path d="M3 3h18M12 3v17M10 20h4" />
  </svg>
);

/* A label pinned to a level, drawn on the axis. A flag on a pole: it shares no
   silhouette with anything above it. */
const TagTool = (
  <svg {...SVG}>
    <path d="M6 2v20" />
    <path d="M6 4h13l-3 4 3 4H6z" />
  </svg>
);

/* Stand-in for an overlay a future library build registers that this file has
   never seen. Deliberately generic — an invented specific glyph would be a
   claim about a tool we know nothing about. */
const UnknownTool = (
  <svg {...SVG}>
    <path d="M4 4h16v16H4z" />
    <path d="M9 15 15 9" />
  </svg>
);

// --- catalogue ---------------------------------------------------------------

interface RailTool {
  /** klinecharts overlay id, verbatim. */
  name: string;
  /** Sentence-case display label. */
  label: string;
  /**
   * Claim on a rail slot, lowest first.
   *
   * This decides ONLY which tools are glyphs and which are in the "…" flyout
   * when the panel is too short for all of them — never the order they are
   * shown in, which is always the group order below. Ranked by how often the
   * tool is reached for on a price chart: a support level and a trend line
   * before a vertical segment, and the measure high because it is the one tool
   * here that answers a question rather than marking a place.
   */
  rank: number;
  icon: ReactElement;
}

interface RailGroup {
  id: string;
  /** Heading in the overflow flyout. Sentence case, like every other heading. */
  label: string;
  tools: RailTool[];
}

/**
 * Every overlay the installed build registers, in the order the rail shows them.
 *
 * Verified against `getSupportedOverlays()` on klinecharts 10.0.2 — sixteen
 * names — plus `ot_measure`, which Chart.tsx registers into the same registry
 * before it reads that list. Nothing here is speculative: a name in this table
 * that the library does not report is filtered out at render, so a downgrade
 * cannot leave a dead button in the strip.
 */
const GROUPS: RailGroup[] = [
  {
    id: 'levels',
    label: 'Price levels',
    tools: [
      { name: 'horizontalStraightLine', label: 'Horizontal line', rank: 0, icon: HorizontalLine },
      { name: 'priceLine', label: 'Price label', rank: 4, icon: PriceLabel },
      { name: 'horizontalRayLine', label: 'Horizontal ray', rank: 11, icon: HorizontalRay },
      { name: 'horizontalSegment', label: 'Horizontal segment', rank: 14, icon: HorizontalSegment },
    ],
  },
  {
    id: 'lines',
    label: 'Lines and channels',
    tools: [
      { name: 'segment', label: 'Trend line', rank: 1, icon: TrendSegment },
      { name: 'rayLine', label: 'Trend ray', rank: 10, icon: TrendRay },
      { name: 'straightLine', label: 'Extended line', rank: 12, icon: ExtendedLine },
      { name: 'parallelStraightLine', label: 'Parallel channel', rank: 5, icon: ParallelChannel },
      { name: 'priceChannelLine', label: 'Price channel', rank: 13, icon: PriceChannel },
      { name: 'verticalStraightLine', label: 'Vertical line', rank: 6, icon: VerticalLine },
      { name: 'verticalRayLine', label: 'Vertical ray', rank: 15, icon: VerticalRay },
      { name: 'verticalSegment', label: 'Vertical segment', rank: 16, icon: VerticalSegment },
    ],
  },
  {
    id: 'retracement',
    label: 'Retracement and projection',
    tools: [
      { name: 'fibonacciLine', label: 'Fibonacci retracement', rank: 3, icon: Retracement },
    ],
  },
  {
    id: 'measure',
    label: 'Measurement',
    tools: [{ name: 'ot_measure', label: 'Measure', rank: 2, icon: Measure }],
  },
  {
    id: 'annotation',
    label: 'Annotation',
    tools: [
      { name: 'brush', label: 'Freehand', rank: 8, icon: Freehand },
      { name: 'simpleAnnotation', label: 'Text', rank: 7, icon: TextTool },
      { name: 'simpleTag', label: 'Tag', rank: 9, icon: TagTool },
    ],
  },
];

const CATALOGUE = new Map(GROUPS.flatMap((g) => g.tools.map((t) => [t.name, t] as const)));

/** 'horizontalStraightLine' -> 'Horizontal straight line'. The fallback for a
 *  name this file has never seen; display only, the raw library id stays in
 *  `title` so the name that was actually created is never lost from the UI. */
export const titleizeOverlay = (name: string): string => {
  const words = name.replace(/([A-Z])/g, ' $1').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The label the rail shows for an overlay. Exported because the toolbar prints
 *  the armed tool's name too, and "Measure" and "Ot measure" must not both be
 *  on screen for the same tool. */
export const overlayLabel = (name: string): string =>
  CATALOGUE.get(name)?.label ?? titleizeOverlay(name);

// --- fitting -----------------------------------------------------------------

/**
 * Geometry of the strip: button size, flex gap, group break.
 *
 * NOT constants. rail.css owns these as custom properties and the touch
 * breakpoint changes one of them, so they are read off the live computed style
 * instead of being copied here — a hardcoded 34 would have over-filled the
 * strip by six pixels a button on any panel narrow enough to get the 40px
 * touch targets, which is precisely the panel with the least height to spare.
 */
interface RailBox {
  avail: number;
  btn: number;
  gap: number;
  sep: number;
}

/** The pre-measurement box. `avail: -1` is the sentinel for "not measured yet",
 *  distinguishable from a genuinely zero-height rail. */
const UNMEASURED: RailBox = { avail: -1, btn: 34, gap: 2, sep: 11 };

function readBox(el: HTMLElement): RailBox {
  const cs = getComputedStyle(el);
  const px = (prop: string, fallback: number) => {
    const v = Number.parseFloat(cs.getPropertyValue(prop));
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    avail: el.clientHeight,
    btn: px('--rail-btn', UNMEASURED.btn),
    gap: px('--rail-gap', UNMEASURED.gap),
    sep: px('--rail-break', UNMEASURED.sep),
  };
}

const sameBox = (a: RailBox, b: RailBox): boolean =>
  a.avail === b.avail && a.btn === b.btn && a.gap === b.gap && a.sep === b.sep;

interface RailPlan {
  /** Groups whose tools are drawn as glyphs, in catalogue order. */
  visible: RailGroup[];
  /** Groups whose tools are in the "…" flyout, in catalogue order. */
  overflow: RailGroup[];
}

/** Height a set of tools would occupy in the body, separators included. */
function planHeight(groups: RailGroup[], box: RailBox): number {
  const items = groups.reduce((n, g) => n + g.tools.length, 0);
  if (items === 0) return 0;
  const seps = groups.length - 1;
  return items * box.btn + seps * box.sep + (items + seps - 1) * box.gap;
}

/** Drop the tools not in `keep`, then drop any group that is left empty. */
function restrict(groups: RailGroup[], keep: Set<string>): RailGroup[] {
  return groups
    .map((g) => ({ ...g, tools: g.tools.filter((t) => keep.has(t.name)) }))
    .filter((g) => g.tools.length > 0);
}

/**
 * Fill `avail` pixels with the highest-ranked tools that fit.
 *
 * Linear from the top rather than binary: the list is seventeen long, the whole
 * scan is cheaper than one layout, and walking down from "everything" means the
 * common answer — a tall panel that fits the lot — is the first one tested.
 *
 * An unmeasured box is "not known yet", which happens for exactly one frame on
 * mount. It renders everything rather than nothing: a strip that starts full and
 * settles is a much smaller lie than one that starts empty.
 */
function planRail(groups: RailGroup[], box: RailBox): RailPlan {
  const all = groups.flatMap((g) => g.tools);
  if (box.avail < 0 || all.length === 0) return { visible: groups, overflow: [] };

  const byRank = [...all].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  for (let k = all.length; k > 0; k--) {
    const keep = new Set(byRank.slice(0, k).map((t) => t.name));
    const visible = restrict(groups, keep);
    if (planHeight(visible, box) <= box.avail) {
      const dropped = new Set(byRank.slice(k).map((t) => t.name));
      return { visible, overflow: restrict(groups, dropped) };
    }
  }
  return { visible: [], overflow: groups };
}

// --- rail chrome -------------------------------------------------------------

/** Kept out of the catalogue so a library overlay can never be confused with a
 *  rail action. */
/* The idle/cursor tool. A STROKED crosshair, not a filled arrow: the filled
   arrow carried noticeably more visual weight than every other item in the
   rail, so the one tool that does nothing was also the loudest thing in the
   strip. Same stroke weight as the tools, amber only when it is the armed one.

   A HAIRLINE WITH A WIDE CENTRE, measured. This is the rail's default state and
   therefore the glyph most often wearing the accent, so its weight sets how the
   armed state reads across the whole strip. The reference draws four 1px arms
   spanning ~23px with a 7px clear square at the crossing; ours drew 2px arms
   around a 4px gap, which at 34px reads as a plus sign rather than as a
   crosshair. Arms run 1→8 and 16→23 on the 24 grid: with the half-pixel origin
   and 1px round caps that is 23px of span and 7 clear rows through the middle. */
const CursorIcon = (
  <svg {...SVG}>
    <path d="M12 1v7M12 16v7M1 12h7M16 12h7" />
  </svg>
);
const ClearIcon = (
  <svg {...SVG}>
    <path d="M3 6h18" />
    <path d="M9 6V4h6v2" />
    <path d="M5 6l1 14h12l1-14" />
    <path d="M10 10v6M14 10v6" />
  </svg>
);
const MoreIcon = (
  <svg {...SVG}>
    <circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none" />
  </svg>
);
/* Collapse / expand handle. Drawn at 12px rather than 24: it is chrome for the
   rail, not a tool in it, and at tool size it would read as one more drawing
   option at the foot of the strip.
 *
 * It gets its OWN 12-unit viewBox rather than shrinking the 24 one. Rendering a
 * 24-unit grid into a 12px box halves every length including the stroke, so the
 * 1px hairline became 0.5px and the handle could never reach its own colour
 * whatever the alignment — the same defect the toolbar's caret had. A grid that
 * is 1:1 with the box it is drawn into is the only way a 1px stroke stays 1px. */
const chevron = { ...SVG, viewBox: '-0.5 -0.5 12 12', width: 12, height: 12 } as const;
const CollapseIcon = (
  <svg {...chevron}>
    <path d="M7.5 2 3.5 6l4 4" />
  </svg>
);
const ExpandIcon = (
  <svg {...chevron}>
    <path d="M4.5 2 8.5 6l-4 4" />
  </svg>
);

export interface DrawingRailProps {
  /** Overlay names the installed build registered, order-line template already
   *  stripped by the caller. The rail renders exactly these and nothing else. */
  tools: string[];
  /** Currently armed overlay name, or null for the cursor. */
  active: string | null;
  /** Arm a tool. */
  onSelect: (name: string) => void;
  /** Disarm — cursor tool. Also removes a half-drawn overlay. */
  onCancel: () => void;
  /** Remove every user drawing (never order lines — the caller enforces that). */
  onClear: () => void;
  /** The chart is not up yet; nothing can be created. */
  disabled?: boolean;
  /** Width animation starting and finished. The chart holds its price axis
   *  across the move so it does not refit on every frame. */
  onMotion?: (phase: 'start' | 'end') => void;
}

export function DrawingRail({
  tools, active, onSelect, onCancel, onClear, disabled = false, onMotion,
}: DrawingRailProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  /* Folded away, so a narrow dashboard column can give the 52px back to the
     plot. Local state rather than a prop: nothing outside the rail has an
     opinion about it, and the chart re-measures itself through the
     ResizeObserver already watching the holder. */
  const [collapsed, setCollapsed] = useState(false);
  /* Body height and strip geometry, both measured — see RailBox. */
  const [box, setBox] = useState<RailBox>(UNMEASURED);
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);

  const known = new Set(tools);
  // Catalogue order, minus anything this build does not actually register.
  const catalogued = restrict(GROUPS, known);
  // Anything the library reports that this file has never seen. It keeps its
  // library order and its raw name: inventing a rank or a glyph for a tool we
  // do not recognise would be a guess printed as an opinion.
  const strangers = tools.filter((n) => !CATALOGUE.has(n));
  const groups: RailGroup[] =
    strangers.length === 0 ?
      catalogued
    : [
        ...catalogued,
        {
          id: 'other',
          label: 'Other tools',
          tools: strangers.map((name, i) => ({
            name,
            label: titleizeOverlay(name),
            // Behind every catalogued tool, so an unrecognised overlay never
            // displaces one we can actually draw a glyph for.
            rank: 100 + i,
            icon: UnknownTool,
          })),
        },
      ];

  const { visible, overflow } = planRail(groups, box);
  const overflowCount = overflow.reduce((n, g) => n + g.tools.length, 0);
  // A tool can only be armed from the rail, so an armed tool that is not in the
  // visible strip must be one of the overflow entries; the "…" button carries
  // the active colour in that case so the rail never looks idle while a tool is
  // actually holding the next click on the chart.
  const activeIsOverflow =
    active !== null && overflow.some((g) => g.tools.some((t) => t.name === active));

  /* The body is a flex child that takes whatever the fixed chrome leaves, so
     its own height IS the space available for tools — no arithmetic against the
     stylesheet, and it re-answers itself when the dashboard cell is resized or
     the viewport crosses the touch breakpoint. The "…" slot below reserves its
     34px whether or not the button is in it, which is what keeps this
     measurement from moving when a tool promotes or demotes. */
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const read = () => {
      const next = readBox(el);
      setBox((prev) => (sameBox(prev, next) ? prev : next));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsed]);

  // Close the overflow popup on any outside click. Scoped to the rail rather
  // than the toolbar's shared handler because the rail lives inside the chart
  // pane and the toolbar ref does not contain it.
  useEffect(() => {
    if (!overflowOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOverflowOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverflowOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [overflowOpen]);

  const arm = (name: string) => {
    setOverflowOpen(false);
    onSelect(name);
  };

  return (
    <div
      className={`kc-rail${collapsed ? ' is-collapsed' : ''}`}
      ref={root}
      role="toolbar"
      aria-label="Drawing tools"
      aria-orientation="vertical"
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && e.propertyName === 'width') onMotion?.('end');
      }}
    >
      <button
        type="button"
        className={`kc-rail-btn${active === null ? ' active' : ''}`}
        title="Cursor — no drawing tool (Esc)"
        aria-label="Cursor, no drawing tool"
        aria-pressed={active === null}
        onClick={onCancel}
      >
        {CursorIcon}
      </button>

      {/* NO group break under the cursor. Measured, the reference holds one
          uniform 36px pitch from the top of the rail through its eighth item and
          only then opens a gap; ours broke immediately after the cursor, which
          pushed every tool 13px down the strip and made the idle tool look like
          a separate control rather than the first member of the set. */}

      {/* The measured box. It never scrolls in practice — planRail only puts in
          what fits — but it stays scrollable so that a body measured mid-
          transition can never clip a button outright. */}
      <div className="kc-rail-body" ref={body}>
        {visible.map((group, gi) => (
          <div className="kc-rail-group" key={group.id} role="group" aria-label={group.label}>
            {gi > 0 && <div className="kc-rail-sep" role="none" />}
            {group.tools.map((tool) => (
              <button
                key={tool.name}
                type="button"
                className={`kc-rail-btn${active === tool.name ? ' active' : ''}`}
                /* The raw library id stays in the tooltip. Our labels are
                   friendlier than the registry's names — "Trend line" for
                   `segment`, "Measure" for `ot_measure` — and without the id
                   somewhere on screen there would be no way to tell which
                   overlay a button actually creates. */
                title={`${tool.label} · ${group.label} (${tool.name})`}
                aria-label={tool.label}
                aria-pressed={active === tool.name}
                disabled={disabled}
                onClick={() => arm(tool.name)}
              >
                {tool.icon}
              </button>
            ))}
          </div>
        ))}
        {visible.length === 0 && !disabled && (
          // Honest empty state. The library registering no overlays is a real
          // possible outcome of a dependency change, and a blank rail with no
          // explanation would read as a rendering bug.
          <span className="kc-rail-empty" title="This build registered no drawing overlays">
            —
          </span>
        )}
      </div>

      <div className="kc-rail-gap" role="none" />

      {/* The "…" slot changes the body's own height when it appears, which is
          the height planRail just measured — so the two could in principle
          argue. They cannot: overflow only ever grows as the body shrinks, so
          showing the button can never empty the flyout and hiding it can never
          fill one. The worst case is a single extra layout pass at the moment a
          tool promotes or demotes, and the alternative — reserving 36px of dead
          strip forever — costs a tool on every panel. */}
      {overflowCount > 0 && (
        <div className="kc-rail-more">
          <button
            type="button"
            className={`kc-rail-btn${overflowOpen || activeIsOverflow ? ' active' : ''}`}
            title={`${overflowCount} more tool${overflowCount === 1 ? '' : 's'}`}
            aria-label={`${overflowCount} more drawing tools`}
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            disabled={disabled}
            onClick={() => setOverflowOpen((o) => !o)}
          >
            {MoreIcon}
          </button>
          {overflowOpen && (
            <div className="kc-rail-popup" role="menu">
              {overflow.map((group) => (
                <div key={group.id} role="group" aria-label={group.label}>
                  <div className="kc-rail-popup-head">{group.label}</div>
                  {group.tools.map((tool) => (
                    <button
                      key={tool.name}
                      type="button"
                      role="menuitem"
                      className={active === tool.name ? 'active' : ''}
                      title={tool.name}
                      onClick={() => arm(tool.name)}
                    >
                      <span className="kc-rail-popup-ico" aria-hidden>
                        {tool.icon}
                      </span>
                      {tool.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        className="kc-rail-btn kc-rail-clear"
        title="Clear all drawings — order and position lines are kept"
        aria-label="Clear all drawings"
        disabled={disabled}
        onClick={() => {
          setOverflowOpen(false);
          onClear();
        }}
      >
        {ClearIcon}
      </button>

      <button
        type="button"
        className="kc-rail-collapse"
        title={collapsed ? 'Show the drawing tools' : 'Hide the drawing tools'}
        aria-label={collapsed ? 'Show the drawing tools' : 'Hide the drawing tools'}
        aria-expanded={!collapsed}
        onClick={() => {
          setOverflowOpen(false);
          onMotion?.('start');
          setCollapsed((v) => !v);
        }}
      >
        {collapsed ? ExpandIcon : CollapseIcon}
      </button>
    </div>
  );
}
