/**
 * The drawing toolbar down the LEFT edge of the chart, laid out the way
 * TradingView's is.
 *
 * One button per FAMILY of tools - lines, Fibonacci & Gann, patterns,
 * forecasting & measurement, shapes & brushes, annotation - not one per tool.
 * Each button shows the tool of its family that was used last (remembered
 * across reloads) and arms it with one click; the small arrow beside it, a
 * right-click, or a long press opens the family's flyout with every tool in
 * it, by name and glyph, in sections. Forty tools fit in seven buttons, and
 * the tool you reach for most is always one click away.
 *
 * Under the families sit the drawing modes - magnet (weak / strong snap to
 * the candles' OHLC), stay in drawing mode, lock all, hide all - and at the
 * foot, remove all. Each mode is a toggle that is amber while it is on.
 *
 * TOOL LIST IS RUNTIME, NOT AUTHORED. The names come from the caller, which gets
 * them from `getSupportedOverlays()` after every custom overlay was registered,
 * so this file only maps names to labels and glyphs: a catalogued name the
 * build does not register is filtered out (no dead buttons), and a registered
 * name the catalogue has never seen is not dropped - it lands in an "Other
 * tools" family under its titleized name.
 *
 * WHAT FITS IS MEASURED. The panel is a resizable dashboard cell that is often
 * shorter than the strip, so the body measures itself, keeps the
 * highest-ranked buttons that fit, and moves the rest into the "…" flyout at
 * the foot - with their tools and toggles intact.
 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import './rail.css';
import * as I from './drawingIcons';

export type MagnetMode = 'normal' | 'weak_magnet' | 'strong_magnet';

interface RailTool {
  /** klinecharts overlay id, verbatim. */
  name: string;
  /** Sentence-case display label. */
  label: string;
  icon: ReactElement;
}

interface RailSection {
  label: string;
  tools: RailTool[];
}

interface RailFamily {
  id: string;
  label: string;
  sections: RailSection[];
  /** Claim on a slot when the strip is too short, lowest first. */
  rank: number;
}

/**
 * Every tool, in the order the flyouts show them. The built-in klinecharts
 * overlays keep their library ids; ours carry the `ot_` prefix
 * (drawingOverlays.ts, measureOverlay.ts).
 */
const FAMILIES: RailFamily[] = [
  {
    id: 'lines',
    label: 'Lines',
    rank: 0,
    sections: [
      {
        label: 'Lines',
        tools: [
          { name: 'segment', label: 'Trend line', icon: I.TrendLineIcon },
          { name: 'rayLine', label: 'Ray', icon: I.RayIcon },
          { name: 'ot_infoLine', label: 'Info line', icon: I.InfoLineIcon },
          { name: 'straightLine', label: 'Extended line', icon: I.ExtendedLineIcon },
          { name: 'ot_trendAngle', label: 'Trend angle', icon: I.TrendAngleIcon },
        ],
      },
      {
        label: 'Horizontal and vertical',
        tools: [
          { name: 'horizontalStraightLine', label: 'Horizontal line', icon: I.HorizontalLineIcon },
          { name: 'horizontalRayLine', label: 'Horizontal ray', icon: I.HorizontalRayIcon },
          { name: 'horizontalSegment', label: 'Horizontal segment', icon: I.HorizontalSegmentIcon },
          { name: 'verticalStraightLine', label: 'Vertical line', icon: I.VerticalLineIcon },
          { name: 'verticalRayLine', label: 'Vertical ray', icon: I.VerticalRayIcon },
          { name: 'verticalSegment', label: 'Vertical segment', icon: I.VerticalSegmentIcon },
          { name: 'ot_crossLine', label: 'Cross line', icon: I.CrossLineIcon },
        ],
      },
      {
        label: 'Channels',
        tools: [
          { name: 'parallelStraightLine', label: 'Parallel channel', icon: I.ParallelChannelIcon },
          { name: 'priceChannelLine', label: 'Price channel', icon: I.PriceChannelIcon },
        ],
      },
    ],
  },
  {
    id: 'fib',
    label: 'Fibonacci and Gann',
    rank: 1,
    sections: [
      {
        label: 'Fibonacci',
        tools: [
          { name: 'fibonacciLine', label: 'Fib retracement', icon: I.FibRetracementIcon },
          { name: 'ot_fibExtension', label: 'Fib extension', icon: I.FibExtensionIcon },
          { name: 'ot_fibFan', label: 'Fib speed fan', icon: I.FibFanIcon },
          { name: 'ot_fibTimeZone', label: 'Fib time zone', icon: I.FibTimeZoneIcon },
        ],
      },
      {
        label: 'Gann',
        tools: [
          { name: 'ot_gannBox', label: 'Gann box', icon: I.GannBoxIcon },
          { name: 'ot_gannFan', label: 'Gann fan', icon: I.GannFanIcon },
        ],
      },
    ],
  },
  {
    id: 'patterns',
    label: 'Patterns',
    rank: 5,
    sections: [
      {
        label: 'Chart patterns',
        tools: [
          { name: 'ot_xabcd', label: 'XABCD pattern', icon: I.XabcdIcon },
          { name: 'ot_abcd', label: 'ABCD pattern', icon: I.AbcdIcon },
          { name: 'ot_headShoulders', label: 'Head and shoulders', icon: I.HeadShouldersIcon },
        ],
      },
      {
        label: 'Elliott waves',
        tools: [
          { name: 'ot_elliottImpulse', label: 'Elliott impulse wave', icon: I.ElliottImpulseIcon },
          { name: 'ot_elliottCorrection', label: 'Elliott correction wave', icon: I.ElliottCorrectionIcon },
        ],
      },
    ],
  },
  {
    id: 'projection',
    label: 'Forecasting and measurement',
    rank: 2,
    sections: [
      {
        label: 'Positions',
        tools: [
          { name: 'ot_longPosition', label: 'Long position', icon: I.LongPositionIcon },
          { name: 'ot_shortPosition', label: 'Short position', icon: I.ShortPositionIcon },
        ],
      },
      {
        label: 'Measurement',
        tools: [
          { name: 'ot_priceRange', label: 'Price range', icon: I.PriceRangeIcon },
          { name: 'ot_dateRange', label: 'Date range', icon: I.DateRangeIcon },
          { name: 'ot_measure', label: 'Date and price range', icon: I.MeasureIcon },
        ],
      },
    ],
  },
  {
    id: 'shapes',
    label: 'Shapes and brushes',
    rank: 3,
    sections: [
      {
        label: 'Brushes',
        tools: [
          { name: 'brush', label: 'Brush', icon: I.BrushIcon },
          { name: 'ot_highlighter', label: 'Highlighter', icon: I.HighlighterIcon },
        ],
      },
      {
        label: 'Shapes',
        tools: [
          { name: 'ot_rect', label: 'Rectangle', icon: I.RectangleIcon },
          { name: 'ot_circle', label: 'Circle', icon: I.CircleIcon },
          { name: 'ot_triangle', label: 'Triangle', icon: I.TriangleIcon },
          { name: 'ot_path', label: 'Path', icon: I.PathIcon },
        ],
      },
    ],
  },
  {
    id: 'annotation',
    label: 'Annotation',
    rank: 4,
    sections: [
      {
        label: 'Text and labels',
        tools: [
          { name: 'simpleAnnotation', label: 'Text', icon: I.TextIcon },
          { name: 'ot_note', label: 'Note', icon: I.NoteIcon },
          { name: 'simpleTag', label: 'Tag', icon: I.TagIcon },
          { name: 'priceLine', label: 'Price label', icon: I.PriceLineIcon },
          { name: 'ot_arrow', label: 'Arrow', icon: I.ArrowIcon },
        ],
      },
    ],
  },
];

const CATALOGUE = new Map(
  FAMILIES.flatMap((f) => f.sections.flatMap((s) => s.tools.map((t) => [t.name, t] as const))),
);

/** 'horizontalStraightLine' -> 'Horizontal straight line'. The fallback for a
 *  name this file has never seen. */
export const titleizeOverlay = (name: string): string => {
  const words = name.replace(/^ot_/, '').replace(/([A-Z])/g, ' $1').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The label the toolbar shows for an overlay (the armed-tool hint uses it too). */
export const overlayLabel = (name: string): string => CATALOGUE.get(name)?.label ?? titleizeOverlay(name);

/** Families restricted to what this build registers, empty ones dropped. */
function restrict(families: RailFamily[], known: Set<string>): RailFamily[] {
  return families
    .map((f) => ({
      ...f,
      sections: f.sections
        .map((s) => ({ ...s, tools: s.tools.filter((t) => known.has(t.name)) }))
        .filter((s) => s.tools.length > 0),
    }))
    .filter((f) => f.sections.length > 0);
}

const toolsOf = (f: RailFamily): RailTool[] => f.sections.flatMap((s) => s.tools);

// --- remembered tool per family ------------------------------------------------

const RECENT_KEY = 'chart.rail.recent';

function readRecent(): Record<string, string> {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// --- fitting -----------------------------------------------------------------

/** Strip geometry, read off rail.css's custom properties (see the note there). */
interface RailBox {
  avail: number;
  btn: number;
  gap: number;
  sep: number;
}
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

type ModeId = 'magnet' | 'stay' | 'lock' | 'hide';
const MODES: Array<{ id: ModeId; rank: number }> = [
  { id: 'magnet', rank: 6 },
  { id: 'hide', rank: 7 },
  { id: 'lock', rank: 8 },
  { id: 'stay', rank: 9 },
];

/** Which families and modes are buttons, and which are in the "…" flyout. */
function plan(families: RailFamily[], box: RailBox) {
  const items = [
    ...families.map((f) => ({ key: `f:${f.id}`, rank: f.rank, mode: false })),
    ...MODES.map((m) => ({ key: `m:${m.id}`, rank: m.rank, mode: true })),
  ];
  if (box.avail < 0) return new Set(items.map((i) => i.key));
  const byRank = [...items].sort((a, b) => a.rank - b.rank);
  for (let k = items.length; k > 0; k--) {
    const keep = byRank.slice(0, k);
    const hasFam = keep.some((i) => !i.mode);
    const hasMode = keep.some((i) => i.mode);
    const n = keep.length;
    const h = n * box.btn + (n - 1) * box.gap + (hasFam && hasMode ? box.sep + box.gap : 0);
    if (h <= box.avail) return new Set(keep.map((i) => i.key));
  }
  return new Set<string>();
}

// --- component ---------------------------------------------------------------

export interface DrawingRailProps {
  /** Overlay names the installed build registered (order lines stripped). */
  tools: string[];
  /** Currently armed overlay name, or null for the cursor. */
  active: string | null;
  onSelect: (name: string) => void;
  /** Disarm - the cursor. Also removes a half-drawn overlay. */
  onCancel: () => void;
  /** Remove every user drawing (never order lines - the caller enforces that). */
  onClear: () => void;
  disabled?: boolean;
  /** Width animation starting and finished (the chart holds its axis). */
  onMotion?: (phase: 'start' | 'end') => void;
  magnet: MagnetMode;
  onMagnet: (mode: MagnetMode) => void;
  stay: boolean;
  onStay: (on: boolean) => void;
  locked: boolean;
  onLock: (on: boolean) => void;
  hidden: boolean;
  onHide: (on: boolean) => void;
}

/** Long press that opens a family's flyout on touch. */
const LONG_PRESS_MS = 420;

export function DrawingRail({
  tools, active, onSelect, onCancel, onClear, disabled = false, onMotion,
  magnet, onMagnet, stay, onStay, locked, onLock, hidden, onHide,
}: DrawingRailProps) {
  /** Which flyout is open: a family id, 'magnet', or 'more'. */
  const [open, setOpen] = useState<string | null>(null);
  const [anchorTop, setAnchorTop] = useState(0);
  const [popTop, setPopTop] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [box, setBox] = useState<RailBox>(UNMEASURED);
  const [recent, setRecent] = useState<Record<string, string>>(readRecent);
  const [lastMagnet, setLastMagnet] = useState<Exclude<MagnetMode, 'normal'>>('weak_magnet');
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const press = useRef<number | undefined>(undefined);

  const known = new Set(tools);
  const catalogued = restrict(FAMILIES, known);
  const strangers = tools.filter((n) => !CATALOGUE.has(n));
  const families: RailFamily[] =
    strangers.length === 0 ?
      catalogued
    : [
        ...catalogued,
        {
          id: 'other',
          label: 'Other tools',
          rank: 10,
          sections: [
            { label: 'Other tools', tools: strangers.map((name) => ({ name, label: titleizeOverlay(name), icon: I.UnknownToolIcon })) },
          ],
        },
      ];
  const shown = plan(families, box);
  const overflowFamilies = families.filter((f) => !shown.has(`f:${f.id}`));
  const overflowModes = MODES.filter((m) => !shown.has(`m:${m.id}`));
  const overflowCount = overflowFamilies.length + overflowModes.length;
  const familyOf = (name: string | null) => (name ? families.find((f) => toolsOf(f).some((t) => t.name === name)) : undefined);
  const activeFamily = familyOf(active);

  /** The tool a family's button shows: the armed one, else the last used. */
  const faceOf = (f: RailFamily): RailTool => {
    const list = toolsOf(f);
    if (activeFamily?.id === f.id) return list.find((t) => t.name === active) ?? list[0]!;
    return list.find((t) => t.name === recent[f.id]) ?? list[0]!;
  };

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

  // A flyout opens level with its button, and moves up when it would run off
  // the bottom of the chart.
  useLayoutEffect(() => {
    if (!open || open === 'more') {
      setPopTop(null);
      return;
    }
    const r = root.current;
    const p = pop.current;
    if (!r || !p) return;
    const maxTop = r.clientHeight - p.offsetHeight - 4;
    setPopTop(Math.max(4, Math.min(anchorTop, maxTop)));
  }, [open, anchorTop]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const arm = (f: RailFamily | undefined, name: string) => {
    setOpen(null);
    if (f) {
      const next = { ...recent, [f.id]: name };
      setRecent(next);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* private mode; non-fatal */
      }
    }
    onSelect(name);
  };

  const openFlyout = (id: string, anchor: HTMLElement | null) => {
    const r = root.current;
    if (anchor && r) setAnchorTop(anchor.getBoundingClientRect().top - r.getBoundingClientRect().top);
    setOpen((o) => (o === id ? null : id));
  };

  const longPress = (id: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (e.pointerType === 'mouse') return;
      const el = e.currentTarget;
      window.clearTimeout(press.current);
      press.current = window.setTimeout(() => openFlyout(id, el), LONG_PRESS_MS);
    },
    onPointerUp: () => window.clearTimeout(press.current),
    onPointerLeave: () => window.clearTimeout(press.current),
  });

  const toggleMagnet = () => onMagnet(magnet === 'normal' ? lastMagnet : 'normal');
  const pickMagnet = (m: Exclude<MagnetMode, 'normal'>) => {
    setLastMagnet(m);
    onMagnet(m);
    setOpen(null);
  };

  const familyButton = (f: RailFamily) => {
    const face = faceOf(f);
    const on = activeFamily?.id === f.id;
    return (
      <div className={`kc-rail-tool${open === f.id ? ' is-open' : ''}`} key={f.id}>
        <button
          type="button"
          className={`kc-rail-btn${on ? ' active' : ''}`}
          title={`${face.label} · right-click for all ${f.label.toLowerCase()}`}
          aria-label={face.label}
          aria-pressed={on}
          disabled={disabled}
          onClick={() => (on ? onCancel() : arm(f, face.name))}
          onContextMenu={(e) => {
            e.preventDefault();
            openFlyout(f.id, e.currentTarget);
          }}
          {...longPress(f.id)}
        >
          {face.icon}
        </button>
        <button
          type="button"
          className="kc-rail-fly"
          aria-label={`All ${f.label.toLowerCase()}`}
          aria-haspopup="menu"
          aria-expanded={open === f.id}
          disabled={disabled}
          onClick={(e) => openFlyout(f.id, e.currentTarget.previousElementSibling as HTMLElement)}
        >
          <svg viewBox="0 0 6 8" width="6" height="8" aria-hidden focusable={false}>
            <path d="M1.5 1.5 4.5 4l-3 2.5" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    );
  };

  const modeButton = (id: ModeId) => {
    switch (id) {
      case 'magnet':
        return (
          <div className={`kc-rail-tool${open === 'magnet' ? ' is-open' : ''}`} key="magnet">
            <button
              type="button"
              className={`kc-rail-btn${magnet !== 'normal' ? ' active' : ''}`}
              title={magnet === 'strong_magnet' ? 'Strong magnet: on' : magnet === 'weak_magnet' ? 'Weak magnet: on' : 'Magnet: snap drawings to the candles'}
              aria-label="Magnet mode"
              aria-pressed={magnet !== 'normal'}
              disabled={disabled}
              onClick={toggleMagnet}
              onContextMenu={(e) => {
                e.preventDefault();
                openFlyout('magnet', e.currentTarget);
              }}
              {...longPress('magnet')}
            >
              {I.MagnetIcon}
            </button>
            <button
              type="button"
              className="kc-rail-fly"
              aria-label="Magnet strength"
              aria-haspopup="menu"
              aria-expanded={open === 'magnet'}
              disabled={disabled}
              onClick={(e) => openFlyout('magnet', e.currentTarget.previousElementSibling as HTMLElement)}
            >
              <svg viewBox="0 0 6 8" width="6" height="8" aria-hidden focusable={false}>
                <path d="M1.5 1.5 4.5 4l-3 2.5" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        );
      case 'stay':
        return (
          <button
            key="stay"
            type="button"
            className={`kc-rail-btn${stay ? ' active' : ''}`}
            title={stay ? 'Stay in drawing mode: on' : 'Stay in drawing mode'}
            aria-label="Stay in drawing mode"
            aria-pressed={stay}
            disabled={disabled}
            onClick={() => onStay(!stay)}
          >
            {I.StayDrawingIcon}
          </button>
        );
      case 'lock':
        return (
          <button
            key="lock"
            type="button"
            className={`kc-rail-btn${locked ? ' active' : ''}`}
            title={locked ? 'Unlock all drawings' : 'Lock all drawings'}
            aria-label="Lock all drawings"
            aria-pressed={locked}
            disabled={disabled}
            onClick={() => onLock(!locked)}
          >
            {locked ? I.LockIcon : I.UnlockIcon}
          </button>
        );
      case 'hide':
        return (
          <button
            key="hide"
            type="button"
            className={`kc-rail-btn${hidden ? ' active' : ''}`}
            title={hidden ? 'Show all drawings' : 'Hide all drawings'}
            aria-label="Hide all drawings"
            aria-pressed={hidden}
            disabled={disabled}
            onClick={() => onHide(!hidden)}
          >
            {hidden ? I.EyeOffIcon : I.EyeIcon}
          </button>
        );
    }
  };

  const toolRows = (f: RailFamily) =>
    f.sections.map((s) => (
      <div key={`${f.id}:${s.label}`} role="group" aria-label={s.label}>
        <div className="kc-rail-popup-head">{s.label}</div>
        {s.tools.map((t) => (
          <button
            key={t.name}
            type="button"
            role="menuitem"
            className={active === t.name ? 'active' : ''}
            onClick={() => arm(f, t.name)}
          >
            <span className="kc-rail-popup-ico" aria-hidden>
              {t.icon}
            </span>
            {t.label}
          </button>
        ))}
      </div>
    ));

  const visibleFamilies = families.filter((f) => shown.has(`f:${f.id}`));
  const visibleModes = MODES.filter((m) => shown.has(`m:${m.id}`)).sort(
    (a, b) => ['magnet', 'stay', 'lock', 'hide'].indexOf(a.id) - ['magnet', 'stay', 'lock', 'hide'].indexOf(b.id),
  );
  const openFamily = families.find((f) => f.id === open);
  const activeIsOverflow = activeFamily !== undefined && !shown.has(`f:${activeFamily.id}`);

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
        title="Cursor - no drawing tool (Esc)"
        aria-label="Cursor, no drawing tool"
        aria-pressed={active === null}
        onClick={onCancel}
      >
        {I.CursorIcon}
      </button>

      <div className="kc-rail-body" ref={body}>
        {visibleFamilies.map(familyButton)}
        {visibleFamilies.length > 0 && visibleModes.length > 0 && <div className="kc-rail-sep" role="none" />}
        {visibleModes.map((m) => modeButton(m.id))}
        {families.length === 0 && !disabled && (
          <span className="kc-rail-empty" title="This build registered no drawing overlays">
            —
          </span>
        )}
      </div>

      <div className="kc-rail-gap" role="none" />

      {overflowCount > 0 && (
        <div className="kc-rail-more">
          <button
            type="button"
            className={`kc-rail-btn${open === 'more' || activeIsOverflow ? ' active' : ''}`}
            title={`${overflowCount} more`}
            aria-label={`${overflowCount} more drawing tools and modes`}
            aria-haspopup="menu"
            aria-expanded={open === 'more'}
            disabled={disabled}
            onClick={() => setOpen((o) => (o === 'more' ? null : 'more'))}
          >
            {I.MoreIcon}
          </button>
        </div>
      )}

      <button
        type="button"
        className="kc-rail-btn kc-rail-clear"
        title="Remove all drawings - order and position lines are kept"
        aria-label="Remove all drawings"
        disabled={disabled}
        onClick={() => {
          setOpen(null);
          onClear();
        }}
      >
        {I.TrashIcon}
      </button>

      <button
        type="button"
        className="kc-rail-collapse"
        title={collapsed ? 'Show the drawing tools' : 'Hide the drawing tools'}
        aria-label={collapsed ? 'Show the drawing tools' : 'Hide the drawing tools'}
        aria-expanded={!collapsed}
        onClick={() => {
          setOpen(null);
          onMotion?.('start');
          setCollapsed((v) => !v);
        }}
      >
        <svg viewBox="-0.5 -0.5 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable={false}>
          <path d={collapsed ? 'M4.5 2 8.5 6l-4 4' : 'M7.5 2 3.5 6l4 4'} />
        </svg>
      </button>

      {openFamily && (
        <div className="kc-rail-popup is-anchored" role="menu" aria-label={openFamily.label} ref={pop} style={{ top: popTop ?? anchorTop, bottom: 'auto' }}>
          {toolRows(openFamily)}
        </div>
      )}

      {open === 'magnet' && (
        <div className="kc-rail-popup is-anchored" role="menu" aria-label="Magnet" ref={pop} style={{ top: popTop ?? anchorTop, bottom: 'auto' }}>
          <div className="kc-rail-popup-head">Magnet</div>
          <button type="button" role="menuitemradio" aria-checked={magnet === 'weak_magnet'} className={magnet === 'weak_magnet' ? 'active' : ''} onClick={() => pickMagnet('weak_magnet')}>
            <span className="kc-rail-popup-ico" aria-hidden>{I.MagnetIcon}</span>
            Weak magnet
          </button>
          <button type="button" role="menuitemradio" aria-checked={magnet === 'strong_magnet'} className={magnet === 'strong_magnet' ? 'active' : ''} onClick={() => pickMagnet('strong_magnet')}>
            <span className="kc-rail-popup-ico" aria-hidden>{I.MagnetIcon}</span>
            Strong magnet
          </button>
          <button type="button" role="menuitemradio" aria-checked={magnet === 'normal'} className={magnet === 'normal' ? 'active' : ''} onClick={() => { onMagnet('normal'); setOpen(null); }}>
            <span className="kc-rail-popup-ico" aria-hidden>{I.CursorIcon}</span>
            Off
          </button>
        </div>
      )}

      {open === 'more' && (
        <div className="kc-rail-popup" role="menu">
          {overflowFamilies.map((f) => (
            <div key={f.id}>{toolRows(f)}</div>
          ))}
          {overflowModes.length > 0 && (
            <div role="group" aria-label="Drawing modes">
              <div className="kc-rail-popup-head">Drawing modes</div>
              {overflowModes.map((m) => {
                const label =
                  m.id === 'magnet' ? (magnet === 'normal' ? 'Magnet' : 'Magnet: on')
                  : m.id === 'stay' ? 'Stay in drawing mode'
                  : m.id === 'lock' ? (locked ? 'Unlock all drawings' : 'Lock all drawings')
                  : hidden ? 'Show all drawings' : 'Hide all drawings';
                const on = m.id === 'magnet' ? magnet !== 'normal' : m.id === 'stay' ? stay : m.id === 'lock' ? locked : hidden;
                const ico = m.id === 'magnet' ? I.MagnetIcon : m.id === 'stay' ? I.StayDrawingIcon : m.id === 'lock' ? I.LockIcon : I.EyeOffIcon;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={on}
                    className={on ? 'active' : ''}
                    onClick={() => {
                      setOpen(null);
                      if (m.id === 'magnet') toggleMagnet();
                      else if (m.id === 'stay') onStay(!stay);
                      else if (m.id === 'lock') onLock(!locked);
                      else onHide(!hidden);
                    }}
                  >
                    <span className="kc-rail-popup-ico" aria-hidden>{ico}</span>
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
