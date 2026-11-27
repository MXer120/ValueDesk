/**
 * The design system's pieces - Card, Group, Row, Stat, Tag, PeriodSeg, Meter - the
 * equity curve every chart surface draws through, and the two formatters they share.
 *
 * Moved here from components/Portfolio.tsx unchanged (2026-10-02; PeriodSeg and Meter
 * 2026-11-18, so /points no longer loads the Portfolio page for them). They have no
 * tie to the Portfolio page: only React, the privacy masks and the number
 * formatters. Styles: Portfolio.css.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Private, safeText, useMask, usePrivacy, type PrivacyKey, type PrivacyMode } from '../../privacy';
import { DASH, MINUS, fmtUsd, signClass } from '../../format';
import { dotGrid, timeTicks } from './timeTicks';
import { pathOf, sampleLine, samplesFor, yExtent, type LineShape } from '../../chart/lineMorph';
import { useLineMorph } from '../../chart/useLineMorph';
import '../Portfolio.css';
import { fmtFixed, fmtNum } from '../../numStyle';

/** The portfolio's periods (Portfolio.tsx's period maths takes them). */
export type Period = '24H' | '7D' | '14D' | '30D' | '90D' | 'ALL';
const PERIODS: Period[] = ['7D', '30D', '90D', 'ALL'];

export interface CurveWindow {
  /** Cumulative PnL points inside the period, oldest first. */
  points: Array<{ t: number; v: number }>;
  /**
   * Cumulative PnL immediately BEFORE the period, i.e. the level the period
   * started from. 0 when the period covers the whole history, because the
   * venue's cumulative series starts at zero.
   */
  baseline: number;
  /** points[last] - baseline. Realised PnL earned inside the period. */
  change: number | null;
  /**
   * Biggest fall from a peak to a low that follows it, inside the period - see
   * `maxDrawdown`. Not the curve's lowest point. Signed negative, and computed
   * here rather than published by the venue.
   */
  maxDrawdown: number | null;
}


/**
 * Compact money for the rail, e.g. $1.24M.
 *
 * Rounding is fine HERE and only here: these are order-of-magnitude figures
 * (lifetime volume, notional exposure) read at a glance, and every call site
 * puts the exact value in the row's title attribute. Nothing that has to
 * reconcile - equity, margin, PnL - goes through this.
 */
export function fmtCompactUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const abs = Math.abs(v);
  if (abs < 10_000) return fmtUsd(v, 2);
  const sign = v < 0 ? MINUS : '';
  return `${sign}$${fmtNum(abs, { notation: 'compact', maximumFractionDigits: 2 })}`;
}

/** An axis figure: no cents, and thousands shortened from 10k up. */
const wholeUsd = (v: number): string => (Math.abs(v) < 10_000 ? fmtUsd(v, 0) : fmtCompactUsd(v));

export const fmtDay = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' }) : DASH;

/**
 * Provenance chips are OFF.
 *
 * The `venue` / `derived` / `est.` annotations still sit on every row and stat
 * below - which side of the wire a number came from is part of what this file
 * knows about it, and the tests and comments still lean on it - but they are no
 * longer drawn next to the label. Flip this to true to render them again;
 * nothing else has to change.
 *
 * Typed `boolean` rather than left to infer the literal `false`, so the guard
 * below does not read as statically dead to a linter.
 */
const SHOW_PROVENANCE_TAGS: boolean = false;

/**
 * Provenance tag. Three values only, and they mean exactly three things:
 *   derived - computed in this file from the venue's inputs
 *   est.    - a model output with assumptions (risk.ts)
 *   venue   - printed exactly as the venue reported it, snapshot and all
 * Anything with no source at all gets an em-dash, not a tag.
 */
/* ===========================================================================
 *  THE DESIGN SYSTEM.
 *
 *  Card, Group, Row, Stat, PeriodSeg, Meter and Tag are EXPORTED, not private,
 *  because "follow the design system" has to be something a page does by
 *  importing it rather than something a person remembers. Every new surface -
 *  the points page, the scan page - builds from these, so a change to a row's
 *  rhythm reaches all of them and no page can quietly invent a second look.
 *
 *  They live in this module, apart from the Portfolio page they were born in,
 *  so that a page using a Card does not load that whole page and the account
 *  tables behind it: Explore, Copy and the command palette (through the venue
 *  chooser's curve) each did - 175 kB of script before their first render.
 *  Portfolio.tsx re-exports them; import them from here.
 * ======================================================================== */
export function Tag({ kind, title }: { kind: 'derived' | 'est.' | 'venue'; title: string }) {
  return <span className="pf-tag" title={title}>{kind}</span>;
}

/**
 * One row of the rail: label left, value right, both on one 20px line.
 *
 * `hint` becomes the title attribute rather than visible copy, because the rail
 * is scanned vertically and a second line under any row destroys the alignment
 * that is the whole point of a fixed-width rail.
 */
export function Row({
  label, value, cls, hint, tag, tagHint, privacy = 'funds', sub, onToggle, expanded, hideTwisty,
}: {
  label: ReactNode;
  value: ReactNode;
  cls?: string;
  hint?: string;
  tag?: 'derived' | 'est.' | 'venue';
  tagHint?: string;
  /** Which incognito category this row's value belongs to. Defaults to `funds`
   *  because this rail is overwhelmingly balances; pass 'pnl' for PnL rows. */
  privacy?: PrivacyKey;
  /** A breakdown line under its parent: indented and quieter. */
  sub?: boolean;
  /** Keep the row clickable but drop the chevron. */
  hideTwisty?: boolean;
  /**
   * Makes the row a disclosure for the `sub` rows beneath it. The WHOLE row
   * becomes the control - a 12px twisty is a worse target than the 200px line
   * of text already sitting there, and the label is what people aim at anyway.
   */
  onToggle?: () => void;
  expanded?: boolean;
}) {
  const mask = useMask(privacy);
  const hidden = mask('x') !== 'x';

  const body = (
    <>
      <span className="pf-row__label">
        {onToggle && !hideTwisty && (
          <span className={`pf-row__twisty ${expanded ? 'is-open' : ''}`} aria-hidden="true">›</span>
        )}
        {label}
        {SHOW_PROVENANCE_TAGS && tag && <Tag kind={tag} title={tagHint ?? hint ?? ''} />}
      </span>
      <span className={`pf-row__value ${cls ?? ''}`}>{mask(value)}</span>
    </>
  );

  const cn = `pf-row ${sub ? 'pf-row--sub' : ''} ${onToggle ? 'pf-row--toggle' : ''}`;
  /* THE TOOLTIP IS MASKED TOO. `hint` frequently restates the number in full
     ("$229,632.59 - the venue's cumulative quote volume"), so leaving it live
     would put the exact figure one hover away from a hidden row. */
  const title = hidden ? undefined : (hint ?? tagHint);

  /* A real <button> when it toggles, so Enter, Space and the focus ring all
     work without re-implementing any of them on a div. */
  return onToggle ? (
    <button type="button" className={cn} title={title} onClick={onToggle} aria-expanded={expanded}>
      {body}
    </button>
  ) : (
    <div className={cn} title={title}>{body}</div>
  );
}

/**
 * A card.
 *
 * The portfolio page is the one page in this app built from cards rather than
 * from bare panels separated by a gutter: a panel fill, a hairline, a 4px
 * radius, and a 40px header strip carrying a title and at most one control.
 * Heading is 14px/400 in --text against 12px/400 --muted labels - rank is
 * carried by colour and size, never by weight.
 */
export function Card({
  title, action, children, className,
}: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`pf-card ${className ?? ''}`}>
      {(title || action) && (
        <header className="pf-card__head">
          {title && <h2 className="pf-h">{title}</h2>}
          {action && <div className="pf-card__action">{action}</div>}
        </header>
      )}
      <div className="pf-card__body">{children}</div>
    </section>
  );
}

/**
 * A labelled group INSIDE a card, for the rail's stacked lists.
 *
 * The rail carries two lists in one card, so each needs a heading that is
 * quieter than the card's own but louder than a row label. It gets that from
 * colour alone (--text against the rows' --muted) at the same 12px the rows
 * use; nothing here changes weight to make a point.
 */
export function Group({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="pf-group">
      <header className="pf-group__head">
        <h3 className="pf-h pf-h--sub">{title}</h3>
        {action}
      </header>
      {/* The rows sit in a well - the funds sheets' box (Portfolio.css). */}
      <div className="pf-group__body">{children}</div>
    </section>
  );
}

/**
 * One cell of a card's three-column stat strip: 10px/400 label above a
 * 12px/500 value, with room under it for a meter or a one-line note.
 */
export function Stat({
  label, value, cls, hint, tag, tagHint, children, privacy,
}: {
  label: ReactNode;
  value: ReactNode;
  cls?: string;
  hint?: string;
  tag?: 'derived' | 'est.' | 'venue';
  tagHint?: string;
  children?: ReactNode;
  /**
   * Which incognito category this figure belongs to, or nothing.
   *
   * Unlike `Row`, this has NO default. A Row is always one of your numbers; a
   * Stat is used for the venue's numbers too - open interest, funding, 24h
   * volume - and defaulting those to `funds` would blank the market data the
   * whole feature exists to keep visible.
   */
  privacy?: PrivacyKey;
}) {
  const mask = useMask(privacy ?? 'funds');
  const hidden = usePrivacy().isHidden(privacy ?? 'funds') && privacy !== undefined;
  return (
    /*
     * The HINT is dropped when the value is hidden, not masked. These hints
     * quote figures inside prose - "Buffer $1,240.18", "Reaches 100% when..." -
     * and there is no way to mask a number inside a title attribute. Hovering a
     * covered stat must not read it back out, so the explanation waits until the
     * value is visible. `tagHint` stays: it describes the SOURCE, not the value.
     */
    <div className="pf-stat" title={(hidden ? tagHint : hint ?? tagHint) ?? undefined}>
      <span className="pf-stat__label">
        {label}
        {SHOW_PROVENANCE_TAGS && tag && <Tag kind={tag} title={tagHint ?? hint ?? ''} />}
      </span>
      <span className={`pf-stat__value ${cls ?? ''}`}>
        {privacy ? mask(value) : value}
      </span>
      {children}
    </div>
  );
}

// =============================================================================
//  THE CURVE
// =============================================================================

/**
 * The equity curve.
 *
 * Plots the venue's own cumulative realised perps PnL, one point per UTC day.
 * `preserveAspectRatio="none"` stretches the box to the panel, which is fine for
 * a shape - and `vector-effect` keeps the stroke a true 1.5px so the line does
 * not smear horizontally with it.
 */
/**
 * The curve. Shared by Account value and Performance.
 *
 * Four things it has to get right, all of which it used to get wrong:
 *
 *  - ZERO IS THE PERIOD'S OWN START. The series arrives already rebased by
 *    `sliceCurve`, so v=0 means "level where this period opened". Change the
 *    period and zero moves with it, which is the only reading that makes the
 *    number above the chart checkable.
 *  - COLOUR FOLLOWS THE SIGN, not the endpoint. A curve that spends half the
 *    period underwater and closes up was drawn entirely green; now every
 *    segment below zero is red and every segment above is green, by clipping
 *    the same path twice.
 *  - AXES. A y scale, and enough x ticks to place a point in time, instead of
 *    just the two end dates.
 *  - HOVER. Date and value at the cursor.
 */
/**
 * Cut a series into runs that are wholly at-or-above zero, or wholly below it.
 *
 * WHY NOT CLIP. The obvious approach is two clip rects meeting at the zero line,
 * and it is wrong: a stroke is 1.5px wide and centred on the path, so a point
 * sitting exactly at zero has half its stroke in each rect and renders green and
 * red at the same time. Nudging the boundary a pixel does not fix that - it just
 * moves the seam to whatever value that pixel represents.
 *
 * So the split is done on VALUES, not on geometry. Where consecutive points
 * straddle zero the exact crossing is interpolated and becomes the last point of
 * one run and the first of the next, so every run is entirely on one side and
 * nothing is drawn twice.
 *
 * Zero itself belongs to the ABOVE run: `v >= 0`. A flat line at zero is green,
 * not half-and-half, and not red.
 */
function splitAtZero(
  pts: Array<{ t: number; v: number }>,
  x: (i: number) => number,
  y: (v: number) => number,
): Array<{ up: boolean; d: string; x0: number; x1: number }> {
  const runs: Array<{ up: boolean; pts: Array<[number, number]> }> = [];
  const isUp = (v: number) => v >= 0;
  let cur: Array<[number, number]> = [];
  let curUp = isUp(pts[0]!.v);

  for (let i = 0; i < pts.length; i++) {
    const v = pts[i]!.v;
    const up = isUp(v);
    if (i === 0) {
      cur.push([x(0), y(v)]);
      continue;
    }
    if (up === curUp) {
      cur.push([x(i), y(v)]);
      continue;
    }
    // Straddles zero: place the crossing exactly, then start the next run there.
    const v0 = pts[i - 1]!.v;
    const t = v0 === v ? 0 : v0 / (v0 - v);
    const cx = x(i - 1) + (x(i) - x(i - 1)) * t;
    const cy = y(0);
    cur.push([cx, cy]);
    runs.push({ up: curUp, pts: cur });
    cur = [[cx, cy], [x(i), y(v)]];
    curUp = up;
  }
  if (cur.length > 1) runs.push({ up: curUp, pts: cur });

  return runs.map((r) => ({
    up: r.up,
    d: r.pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' '),
    x0: r.pts[0]![0],
    x1: r.pts[r.pts.length - 1]![0],
  }));
}

/**
 * A monotone cubic (Fritsch-Carlson): smooth, and it never swings past a data point, so the line shows no high or low
 * that did not happen.
 */
function smoothPath(p: ReadonlyArray<readonly [number, number]>): string {
  const n = p.length;
  const dx = (i: number) => p[i + 1]![0] - p[i]![0];
  const m = Array.from({ length: n - 1 }, (_, i) => (p[i + 1]![1] - p[i]![1]) / (dx(i) || 1));
  const t = p.map((_, i) => {
    if (i === 0) return m[0]!;
    if (i === n - 1) return m[n - 2]!;
    return m[i - 1]! * m[i]! <= 0 ? 0 : (2 * m[i - 1]! * m[i]!) / (m[i - 1]! + m[i]!);
  });
  let d = `M${p[0]![0].toFixed(1)},${p[0]![1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx(i) / 3;
    d += ` C${(p[i]![0] + h).toFixed(1)},${(p[i]![1] + h * t[i]!).toFixed(1)} ${(p[i + 1]![0] - h).toFixed(1)},${(p[i + 1]![1] - h * t[i + 1]!).toFixed(1)} ${p[i + 1]![0].toFixed(1)},${p[i + 1]![1].toFixed(1)}`;
  }
  return d;
}

/**
 * Every curve on the page, behind one incognito category.
 *
 * All three chart surfaces - the account-value card, the performance card and
 * the standalone Chart panel - draw through this one component, so wrapping HERE
 * covers them all and there is no fourth place to forget. Same wrapper
 * convention as the account tables in Account.tsx.
 *
 * `Private` does not paint over a chart: for `charts` it renders a placeholder
 * INSTEAD, so no curve is mounted and the shape cannot be recovered.
 */
export function EquityCurve(props: Parameters<typeof EquityCurveInner>[0]) {
  return <Private k="charts"><EquityCurveInner {...props} /></Private>;
}

/**
 * One y-axis label under incognito (owner 2026-11-08: "privacy mode also needs to blurr/hide the y axis"). The axis
 * says how much as plainly as a headline figure, so it is hidden with the figure's own category, in the chosen mode.
 * As with `useMask`, the real value never reaches the page: blur and pixelate draw a stand-in, not the number.
 */
function MaskedTick({ x, y, sample, mode, mosaic }: { x: number; y: number; sample: string; mode: PrivacyMode; mosaic: string }) {
  const w = Math.max(18, sample.length * 5.6);
  if (mode === 'stars') return <text x={x} y={y} className="pf-chart__ylabel">{'*'.repeat(Math.min(8, Math.max(3, sample.replace(/[^\w]/g, '').length)))}</text>;
  if (mode === 'blackout') return <rect x={x} y={y - 8} width={w} height={10} rx={2} className="pf-chart__mask" />;
  if (mode === 'pixelate') return <rect x={x} y={y - 8} width={w} height={10} rx={2} fill={`url(#${mosaic})`} />;
  return <text x={x} y={y} className="pf-chart__ylabel is-blur">{safeText(sample)}</text>;
}

function EquityCurveInner({ win, unit = 'usd', tone = 'pnl', compactAxis = false, level = false, clean = false, privacy }: {
  win: CurveWindow;
  /**
   * The category the curve's AMOUNTS belong to. Under it the y-axis labels and the hover value are hidden while the
   * shape stays (the `charts` category hides the whole curve). Leave it out for a curve that is not the user's own.
   */
  privacy?: PrivacyKey;
  unit?: 'usd' | 'pct';
  /**
   * 'pnl' colours gains green. 'equity' draws them white instead - an account
   * balance rising is not a profit, and painting it the same green as realised
   * PnL invites reading it as one. Losses stay red in both.
   */
  tone?: 'pnl' | 'equity';
  /**
   * Y-axis labels in compact money ($80M) instead of full ($80,000,000.00).
   * Off by default, so every existing chart is unchanged. The label gutter is
   * 54px, which holds a SoDEX-sized account; a nine-figure Hyperliquid account
   * would be cut at the card edge. The hover readout stays exact either way.
   */
  compactAxis?: boolean;
  /**
   * The points are LEVELS (an account's value), not a change from zero: the axis fits the data and reads the
   * real values, the area fills to the plot's foot, and no zero line is drawn, since zero is not on it.
   */
  level?: boolean;
  /**
   * The portfolio's chart (owner 2026-11-06): a smooth line on a gray dotted ground, read against the START of the
   * window. Above the start is green, below it red, in the line and the fill; the fill colours the dots it covers,
   * and no others. There are no grid lines. Also a
   * whole-dollar axis, dates without the year, evenly spaced date labels and a dot on the latest point. `tone` does
   * not apply here.
   */
  clean?: boolean;
}) {
  const pts = win.points;
  const priv = usePrivacy();
  const hidden = privacy !== undefined && priv.isHidden(privacy);
  const maskTip = useMask(privacy ?? 'funds');
  const [hover, setHover] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  /*
   * Draw in REAL PIXELS, not in a stretched viewBox.
   *
   * This used to be a fixed `viewBox="0 0 1000 240"` with
   * preserveAspectRatio="none" inside a 110px-tall box. That scales x by ~0.5
   * and y by ~0.46 - two different factors - so every glyph came out visibly
   * squashed and no stroke width meant what it said. Measuring the box and
   * setting the viewBox to match renders 1:1: text is text, 1px is 1px.
   */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry?.contentRect;
      if (r) setBox({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /*
   * Unique ids per instance.
   *
   * The clip paths and gradients used to be hardcoded (`pf-clip-up` etc). With
   * two charts on this page that is a duplicate id: the second chart's
   * `url(#pf-clip-up)` resolved to the FIRST chart's rect, whose split sits at a
   * different height - which is why the red half was wrong or missing. `useId`
   * scopes them per component instance.
   */
  const uid = useId().replace(/:/g, '');
  const ID = { fillUp: `${uid}-fu`, fillDown: `${uid}-fd`, dotUp: `${uid}-du`, dotDown: `${uid}-dd`, dotGround: `${uid}-dg`, clipUp: `${uid}-cu`, clipDown: `${uid}-cd`, washUp: `${uid}-wu`, washDown: `${uid}-wd`, fadeUp: `${uid}-au`, fadeDown: `${uid}-ad`, maskUp: `${uid}-mu`, maskDown: `${uid}-md` };

  const geo = pts.length < 2 ? null : (() => {
  const W = box.w || 600;
  const H = box.h || 110;
  /** Room for the y labels on the right, the x labels below, and headroom so
   *  the top of the curve is not sliced by its own stroke. */
  const PAD_R = 54;
  /* The bottom band holds the date labels AND a clear margin under them. It was
     14px, which put the labels 1px off the stat strip's border - they read as
     part of the divider rather than as part of the chart. */
  const PAD_B = 28;
  const PAD_T = 8;
  const PLOT_W = Math.max(1, W - PAD_R);
  const PLOT_H = Math.max(1, H - PAD_B);

  const ys = pts.map((q) => q.v);
  let lo = level ? Math.min(...ys) : Math.min(...ys, 0);
  let hi = level ? Math.max(...ys) : Math.max(...ys, 0);
  if (level && hi > lo) {
    const room = (hi - lo) * 0.12;
    hi += room;
    lo = lo >= 0 ? Math.max(0, lo - room) : lo - room;
  }
  if (hi === lo) {
    const pad = Math.max(1, Math.abs(hi) * 0.1);
    hi += pad;
    lo -= pad;
  }
  const span = hi - lo;
  const y = (v: number) => PAD_T + (PLOT_H - PAD_T) - ((v - lo) / span) * (PLOT_H - PAD_T);
  const tFrom = pts[0]!.t;
  const tTo = pts[pts.length - 1]!.t;
  /* The portfolio chart places points by time: unevenly spaced points must not bend the axis. */
  const byTime = clean && tTo > tFrom;
  const x = (i: number) => (byTime ? ((pts[i]!.t - tFrom) / (tTo - tFrom)) * PLOT_W : (i / (pts.length - 1)) * PLOT_W);

  const zeroY = level ? PLOT_H : y(0);
  const runs = splitAtZero(pts, x, y);
  const last = ys[ys.length - 1]!;

  const baseV = pts[0]!.v;
  const baseY = y(baseV);
  const line = clean ? smoothPath(pts.map((p, i) => [x(i), y(p.v)])) : '';
  const sideOf = (v: number) => (v >= baseV ? 'pos' : 'neg');
  const dots = dotGrid(PLOT_W, pts.length);

  const fmtV = (v: number) => (unit === 'pct' ? `${fmtFixed(v * 100, 1)}%` : fmtUsd(v));

  /*
   * Y ticks at ROUNDED values, not just the extremes.
   *
   * Showing only [max, 0, min] gives three labels, two of which are arbitrary
   * data values - you cannot read a level off the chart from that. This picks a
   * 1/2/5 x 10^n step so the labels land on numbers a person would choose, then
   * always adds zero because zero is the line the sign is read against.
   */
  const targetTicks = level || clean ? 3 : Math.max(3, Math.min(6, Math.floor((PLOT_H - PAD_T) / 26)));
  const rawStep = span / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(Math.abs(rawStep) || 1));
  const norm = rawStep / mag;
  const niceStep = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const yTicks: number[] = [];
  for (let t = Math.ceil(lo / niceStep) * niceStep; t <= hi + 1e-9; t += niceStep) {
    yTicks.push(Math.abs(t) < niceStep / 1e6 ? 0 : t);
  }
  if (!level && !yTicks.some((t) => t === 0)) yTicks.push(0);
  // Drop any tick that would collide with zero's label.
  const minGap = (PLOT_H - PAD_T) / 12;
  const shown = yTicks
    .sort((a, b) => b - a)
    .filter((t, i, arr) => t === 0 || i === 0 || Math.abs(y(t) - y(arr[i - 1]!)) >= minGap)
    .filter((t) => level || t === 0 || Math.abs(y(t) - y(0)) >= minGap);

  /*
   * How many date labels FIT, checked in PIXELS.
   *
   * Counting ticks by index is not enough. The first and last labels are anchored
   * start and end, so they hang INWARD from the plot edges by a full label width
   * while the ones between are centred on their tick and hang half a width each
   * way. An index-spacing rule cannot see that asymmetry, which is how "Aug 24"
   * and "Aug 30" still ended up printed over each other at 30D.
   *
   * So each candidate label's real extent is computed and the whole set is
   * accepted only if no two touch - trying six labels first and standing down a
   * label at a time until a set fits. Evenly spaced at every count, because
   * dropping crowded ticks one by one leaves visibly uneven gaps.
   */
  const lastIdx = pts.length - 1;
  /** "Aug 07, 2026" measures ~58px at 9px; the rest is the gutter. */
  const X_LABEL_W = 68;
  const labelExtent = (i: number): [number, number] =>
    i === 0 ? [0, X_LABEL_W]
      : i === lastIdx ? [PLOT_W - X_LABEL_W, PLOT_W]
        : [x(i) - X_LABEL_W / 2, x(i) + X_LABEL_W / 2];

  const fits = (ticks: number[]) =>
    ticks.every((t, j) => j === 0 || labelExtent(t)[0] >= labelExtent(ticks[j - 1]!)[1]);

  let xTicks: number[] = [0];
  if (lastIdx > 0) {
    xTicks = [0, lastIdx];
    for (let c = Math.min(6, lastIdx + 1); c >= 3; c--) {
      const cand = Array.from({ length: c }, (_, k) => Math.round((k / (c - 1)) * lastIdx));
      if (new Set(cand).size !== c) continue;
      if (fits(cand)) { xTicks = cand; break; }
    }
  }
  return { W, H, PAD_T, PLOT_W, PLOT_H, ys, y, tFrom, tTo, byTime, x, zeroY, runs, last, baseV, baseY, line, sideOf, dots, fmtV, niceStep, shown, lastIdx, xTicks };
  })();

  /*
   * THE SWITCH (owner 2026-11-26: "make switching between all charts like type and timeframe ... smooth like the main
   * chart on trade"). Another range, Value to PnL, another wallet: the line on screen reshapes into the new one on the
   * trading chart's clock, its start level and fill with it, while the axis labels cross-fade (chart/lineMorph.ts).
   * A new point or a resize redraws at once.
   */
  const target: LineShape | null = geo
    ? { pts: sampleLine(pts.map((p, i) => [geo.x(i), geo.y(p.v)] as const), samplesFor(geo.PLOT_W), clean), base: clean ? geo.baseY : geo.zeroY }
    : null;
  const labelsOf = (g: NonNullable<typeof geo>): ReactNode => (
    <>
      {g.shown.map((t) => {
        const label = clean && unit === 'usd' && g.niceStep >= 1 ? wholeUsd(t) : compactAxis && unit === 'usd' ? fmtCompactUsd(t) : g.fmtV(t);
        return (
          <g key={t}>
            {!clean && (
              <line
                x1="0" y1={g.y(t)} x2={g.PLOT_W} y2={g.y(t)}
                className={t === 0 && !level ? 'pf-chart__zero' : 'pf-chart__grid'}
              />
            )}
            {hidden
              ? <MaskedTick x={g.PLOT_W + 5} y={g.y(t) + 3} sample={label} mode={priv.mode} mosaic={`${uid}-mz`} />
              : <text x={g.PLOT_W + 5} y={g.y(t) + 3} className="pf-chart__ylabel">{label}</text>}
          </g>
        );
      })}
      {/* One label per ~88px past the first: a week reads in days, not half days, on the page's wide chart, and a
          phone's 250px still gets three (as at 72px a label before). */}
      {g.byTime && timeTicks(g.tFrom, g.tTo, Math.max(2, Math.floor(g.PLOT_W / 88) + 1)).map((tick) => {
        const px = ((tick.t - g.tFrom) / (g.tTo - g.tFrom)) * g.PLOT_W;
        return (
          <text key={`x${tick.t}`} x={px} y={g.PLOT_H + 11} className="pf-chart__xlabel" textAnchor={px < 24 ? 'start' : px > g.PLOT_W - 24 ? 'end' : 'middle'}>
            {tick.label}
          </text>
        );
      })}
      {!g.byTime && g.xTicks.map((i) => (
        <text
          key={`i${i}`}
          x={Math.min(g.PLOT_W, Math.max(0, g.x(i)))}
          /* Just under the plot, not at the very bottom of the box - the rest
             of PAD_B is the margin below the axis. */
          y={g.PLOT_H + 11}
          className="pf-chart__xlabel"
          textAnchor={i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}
        >
          {fmtDay(pts[i]!.t)}
        </text>
      ))}
    </>
  );
  const labels = geo ? labelsOf(geo) : null;
  const morph = useLineMorph(target, `${pts[0]?.t ?? ''}|${level}|${clean}|${unit}|${tone}`, labels);
  const frame = morph.frame;

  if (!geo) return null;
  const { W, H, PAD_T, PLOT_W, PLOT_H, ys, y, tFrom, tTo, byTime, x, zeroY, runs, last, lastIdx, sideOf, dots, fmtV } = geo;
  // While morphing, the frame's line and start level stand in for the settled ones.
  const baseY = frame ? frame.base : geo.baseY;
  const line = frame ? pathOf(frame.pts) : geo.line;
  const reach = frame ? yExtent(frame.pts) : { top: y(Math.max(...ys)), foot: y(Math.min(...ys)) };

  // The pointer is followed during a morph too; its readout shows once the line has landed.
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px > PLOT_W) return setHover(null);
    if (byTime) {
      const at = tFrom + (px / PLOT_W) * (tTo - tFrom);
      let best = 0;
      for (let k = 1; k < pts.length; k++) if (Math.abs(pts[k]!.t - at) < Math.abs(pts[best]!.t - at)) best = k;
      return setHover(best);
    }
    const i = Math.round((px / PLOT_W) * (pts.length - 1));
    setHover(Math.min(pts.length - 1, Math.max(0, i)));
  };

  const h = hover === null || frame || hover >= pts.length ? null : pts[hover]!;

  return (
    <div className="pf-chart" ref={boxRef}>
      <svg
        className="pf-chart__svg"
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={hidden ? `${pts.length} points` : `${pts.length} points, ending at ${fmtV(last)} relative to the start of the period`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={ID.fillUp} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone === 'equity' ? 'var(--text)' : 'var(--pos)'} stopOpacity="0.18" />
            <stop offset="100%" stopColor={tone === 'equity' ? 'var(--text)' : 'var(--pos)'} stopOpacity="0" />
          </linearGradient>
          <linearGradient id={ID.fillDown} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--neg)" stopOpacity="0" />
            <stop offset="100%" stopColor="var(--neg)" stopOpacity="0.22" />
          </linearGradient>
          {hidden && priv.mode === 'pixelate' && (
            <pattern id={`${uid}-mz`} width="5" height="5" patternUnits="userSpaceOnUse">
              <rect width="5" height="5" className="pf-chart__mosaic" />
              <rect width="2.5" height="2.5" className="pf-chart__mosaic is-lit" />
              <rect x="2.5" y="2.5" width="2.5" height="2.5" className="pf-chart__mosaic is-lit" />
            </pattern>
          )}
          {clean && (
            <>
              {([[ID.dotGround, 'none'], [ID.dotUp, 'pos'], [ID.dotDown, 'neg']] as const).map(([id, tone]) => (
                <pattern key={id} id={id} width={dots.x} height={dots.y} x={-dots.x / 2} y={baseY - dots.y / 2} patternUnits="userSpaceOnUse">
                  <circle cx={dots.x / 2} cy={dots.y / 2} r="0.8" className={`pf-chart__dots ${tone}`} />
                </pattern>
              ))}
              {/* The fill is strongest at the line's furthest reach and fades towards the start level. */}
              <linearGradient id={ID.washUp} gradientUnits="userSpaceOnUse" x1="0" y1={reach.top} x2="0" y2={baseY}>
                <stop offset="0%" stopColor="var(--pos)" stopOpacity="0.26" />
                <stop offset="100%" stopColor="var(--pos)" stopOpacity="0.02" />
              </linearGradient>
              <linearGradient id={ID.washDown} gradientUnits="userSpaceOnUse" x1="0" y1={reach.foot} x2="0" y2={baseY}>
                <stop offset="0%" stopColor="var(--neg)" stopOpacity="0.26" />
                <stop offset="100%" stopColor="var(--neg)" stopOpacity="0.02" />
              </linearGradient>
              <linearGradient id={ID.fadeUp} gradientUnits="userSpaceOnUse" x1="0" y1={reach.top} x2="0" y2={baseY}>
                <stop offset="0%" stopColor="#fff" stopOpacity="0.9" />
                <stop offset="100%" stopColor="#fff" stopOpacity="0.2" />
              </linearGradient>
              <linearGradient id={ID.fadeDown} gradientUnits="userSpaceOnUse" x1="0" y1={reach.foot} x2="0" y2={baseY}>
                <stop offset="0%" stopColor="#fff" stopOpacity="0.9" />
                <stop offset="100%" stopColor="#fff" stopOpacity="0.2" />
              </linearGradient>
              <mask id={ID.maskUp} maskUnits="userSpaceOnUse" x="0" y="0" width={W} height={H}><rect x="0" y="0" width={W} height={H} fill={`url(#${ID.fadeUp})`} /></mask>
              <mask id={ID.maskDown} maskUnits="userSpaceOnUse" x="0" y="0" width={W} height={H}><rect x="0" y="0" width={W} height={H} fill={`url(#${ID.fadeDown})`} /></mask>
              <clipPath id={ID.clipUp}><rect x="-4" y="-4" width={PLOT_W + 8} height={Math.max(0, baseY + 4)} /></clipPath>
              <clipPath id={ID.clipDown}><rect x="-4" y={baseY} width={PLOT_W + 8} height={Math.max(0, PLOT_H - baseY + 4)} /></clipPath>
            </>
          )}
          {!clean && frame && (
            <>
              <clipPath id={ID.clipUp}><rect x="-4" y="-4" width={PLOT_W + 8} height={Math.max(0, frame.base + 4)} /></clipPath>
              <clipPath id={ID.clipDown}><rect x="-4" y={frame.base} width={PLOT_W + 8} height={Math.max(0, H - frame.base + 4)} /></clipPath>
            </>
          )}
        </defs>

        {clean && (
          <>
            <rect x="-2" y="0" width={PLOT_W + 4} height={PLOT_H} fill={`url(#${ID.dotGround})`} className="pf-chart__ground" />
            <g mask={`url(#${ID.maskUp})`}><path d={`${line} L${PLOT_W},${baseY.toFixed(1)} L0,${baseY.toFixed(1)} Z`} fill={`url(#${ID.dotUp})`} clipPath={`url(#${ID.clipUp})`} /></g>
            <g mask={`url(#${ID.maskDown})`}><path d={`${line} L${PLOT_W},${baseY.toFixed(1)} L0,${baseY.toFixed(1)} Z`} fill={`url(#${ID.dotDown})`} clipPath={`url(#${ID.clipDown})`} /></g>
            <path d={`${line} L${PLOT_W},${baseY.toFixed(1)} L0,${baseY.toFixed(1)} Z`} fill={`url(#${ID.washUp})`} clipPath={`url(#${ID.clipUp})`} />
            <path d={`${line} L${PLOT_W},${baseY.toFixed(1)} L0,${baseY.toFixed(1)} Z`} fill={`url(#${ID.washDown})`} clipPath={`url(#${ID.clipDown})`} />
            <line x1="0" y1={baseY} x2={PLOT_W} y2={baseY} className="pf-chart__zero" />
            <path d={line} className="pf-chart__line pos" clipPath={`url(#${ID.clipUp})`} />
            <path d={line} className="pf-chart__line neg" clipPath={`url(#${ID.clipDown})`} />
          </>
        )}

        {morph.prev && <g opacity={1 - morph.e}>{morph.prev}</g>}
        <g opacity={morph.prev ? morph.e : undefined}>{labels}</g>

        {/* Fills first, then the strokes on top, so a run's own line is never
            dimmed by the next run's translucent area. */}
        {!clean && frame && (
          <>
            <path d={`${line} L${PLOT_W},${frame.base.toFixed(1)} L0,${frame.base.toFixed(1)} Z`} fill={`url(#${ID.fillUp})`} clipPath={`url(#${ID.clipUp})`} />
            <path d={`${line} L${PLOT_W},${frame.base.toFixed(1)} L0,${frame.base.toFixed(1)} Z`} fill={`url(#${ID.fillDown})`} clipPath={`url(#${ID.clipDown})`} />
            <path d={line} className={`pf-chart__line ${tone === 'equity' ? 'neutral' : 'pos'}`} clipPath={`url(#${ID.clipUp})`} />
            <path d={line} className="pf-chart__line neg" clipPath={`url(#${ID.clipDown})`} />
          </>
        )}
        {!clean && !frame && runs.map((r, i) => (
          <path
            key={`f${i}`}
            d={`${r.d} L${r.x1.toFixed(1)},${zeroY.toFixed(1)} L${r.x0.toFixed(1)},${zeroY.toFixed(1)} Z`}
            fill={`url(#${r.up ? ID.fillUp : ID.fillDown})`}
          />
        ))}
        {!clean && !frame && runs.map((r, i) => (
          <path
            key={`l${i}`}
            d={r.d}
            className={`pf-chart__line ${r.up ? (tone === 'equity' ? 'neutral' : 'pos') : 'neg'}`}
          />
        ))}

        {clean && !h && lastIdx > 0 && (
          <circle
            cx={frame ? frame.pts[frame.pts.length - 1]![0] : x(lastIdx)} cy={frame ? frame.pts[frame.pts.length - 1]![1] : y(last)} r="3"
            className={`pf-chart__dot ${sideOf(last)}`}
          />
        )}

        {h && (
          <g>
            <line x1={x(hover!)} y1={PAD_T} x2={x(hover!)} y2={PLOT_H} className="pf-chart__cursor" />
              <circle
              cx={x(hover!)} cy={y(h.v)} r="2.5"
              className={`pf-chart__dot ${clean ? sideOf(h.v) : h.v >= 0 ? (tone === 'equity' ? 'neutral' : 'pos') : 'neg'}`}
            />
          </g>
        )}
      </svg>

      {h && (
        <div
          className="pf-chart__tip"
          style={{
            // Clamped so the box cannot hang off either edge of the card.
            left: `${Math.min(PLOT_W - 40, Math.max(40, x(hover!)))}px`,
          }}
        >
          <span className="pf-chart__tipday">{clean && tTo - tFrom <= 2 * 86_400_000 ? `${fmtDay(h.t)}, ${new Date(h.t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : fmtDay(h.t)}</span>
          <span className={`pf-chart__tipval ${clean ? sideOf(h.v) : level ? '' : signClass(h.v)}`}>{hidden ? maskTip(fmtV(h.v)) : fmtV(h.v)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * The period selector, in one place because three headers carry it and they
 * must not drift apart. Selection is amber text on a filled control - the
 * label never changes weight, so the group cannot re-flow under the cursor.
 */
export function PeriodSeg({ period, onPeriod, label }: {
  period: Period; onPeriod: (p: Period) => void; label: string;
}) {
  return (
    <div className="pf-seg" role="tablist" aria-label={label}>
      {PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          role="tab"
          aria-selected={p === period}
          className={`pf-ctl ${p === period ? 'is-on' : ''}`}
          onClick={() => onPeriod(p)}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

/**
 * A meter, animated by TRANSFORM.
 *
 * Never width. A width transition re-runs layout on every frame of every tick of
 * the mark feed, and on this page there can be fifty of these on screen at once;
 * a transform is composited and costs nothing. `--pf-v` is the 0..1 fraction.
 */
export function Meter({ value, tone, label }: { value: number; tone: string; label?: string }) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div className="pf-meter" role="img" aria-label={label ?? `${fmtFixed(v * 100, 1)}%`}>
      <span className={`pf-meter__fill pf-meter__fill--${tone}`} style={{ transform: `scaleX(${v})` }} />
    </div>
  );
}
