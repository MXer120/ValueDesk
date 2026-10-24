/**
 * klinecharts theme, mirrored from the design tokens in web/src/styles.css.
 *
 * Everything klinecharts paints goes onto a <canvas>, and canvas takes literal
 * colour strings - `var(--pos)` resolves to nothing there. So the token VALUES
 * are duplicated once, here, with the token name next to each. If styles.css
 * moves a token, this file is the single place to follow it. The one thing that
 * is NOT duplicated is the chart background: klinecharts never fills it, so the
 * container keeps `background: var(--bg)` in chart.css and stays live.
 *
 * The palette is WARM. There is no blue, no cold grey and no violet anywhere in
 * here: a single cold hue on a warm near-black surface is the most visible
 * possible mismatch, and the canvas is the largest single surface on the page.
 */
import type {
  AxisCreateTicksCallback,
  AxisRange,
  AxisTick,
  Chart as KChart,
  DeepPartial,
  Styles,
  YAxisTemplate,
} from 'klinecharts';
import { compactNumber } from './volumeAxis';

/** Values copied from :root in web/src/styles.css. */
export const T = {
  bg: '#141310', // --bg, the chart surface
  panel: '#1b1a14', // --bg-panel
  elevated: '#2a2620', // --bg-elevated
  control: '#544a4c', // --bg-control
  text: '#fffeef', // --text
  muted: '#c6b6ba', // --muted
  dim: '#807678', // --dim
  pos: '#00b481', // --pos
  neg: '#ef4a3c', // --neg
  accent: '#ffb547', // --accent (amber)
  /* Grid lines are a hint that the eye should be able to ignore, but the
     previous alpha value (0.045) was tuned against the page base and measured
     #1e1d19 once composited - one step too faint, so the plot read as an empty
     field. The chart is a --bg-panel card now, and the measured reference grid
     on that surface is a flat #272621. Flat rather than alpha because the two
     surfaces it can land on (panel fill, candle body) are far enough apart in
     luminance that one alpha cannot serve both. */
  grid: '#272621',
  /* Indicator lines. Deliberately NOT --pos/--neg (green and red mean
     direction on a trading screen, and an MA that borrows them reads as a
     signal it is not) and deliberately not the violet/cyan pair this file used
     to carry - those were the last cold hues left in the app. A warm ramp
     stays distinguishable without introducing a second temperature. */
  line1: '#ffb547',
  line2: '#c6b6ba',
  line3: '#e08a5a',
  line4: '#fffeef',
  line5: '#807678',
  /* --- text INSIDE the canvas is a NEUTRAL grey, not the warm UI grey -------
     This is a measurement, not a slip, and it is the one place the warm palette
     rule above is deliberately not applied. Sampled off the reference: its
     price-scale and time-scale label cores are #b8b8b8, fully neutral (R=G=B),
     while the SAME reference paints its DOM chrome — tab bar, order-book
     headers — in the warm #c6b6ba we use everywhere else. So the reference
     drops the tint once you are inside the plot, and ours did not: our scale
     numerals sampled #c3b3b7/#c4b5b9 (R and B above G) and carried a faint pink
     cast against a neutral chart.

     Three steps, so the canvas has a ramp of its own rather than one neutral
     value adrift in a warm set:
       canvasText  #dbdbdb  measured — the reference's brightest canvas ink
       canvasMuted #b8b8b8  measured — its axis labels
       canvasDim   #797979  derived — --dim (#807678) neutralised at its own
                            luminance (121), for the high/low extreme marks,
                            which the reference did not give us a sample of. */
  canvasText: '#dbdbdb',
  canvasMuted: '#b8b8b8',
  canvasDim: '#797979',
} as const;

/** Matches the body font stack in styles.css. Canvas parses the CSS shorthand. */
export const FAMILY =
  '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * The NUMERAL family — `--font-num` in styles.css, restated here because a
 * canvas cannot inherit a CSS custom property.
 *
 * The reference splits its type by CONTENT: IBM Plex Sans for words, a DIN face
 * for every number. Everything this chart draws as text is a number — prices on
 * the y-axis, clock times on the x-axis, the crosshair readouts, the last-price
 * badge — so the whole canvas is on the numeral side of that split, and Asap
 * (the open face closest to DIN, chosen in SPEC) is what belongs here.
 *
 * IT ALSO FIXES THE AXIS SIZE, which had been read as a separate fault. Measured
 * in this browser at the same 12px: IBM Plex Sans puts 8px of ink on a digit,
 * Asap puts 9 — and 9 is exactly the reference's figure height. Our axis was not
 * a step too small, it was a step too WIDE and too short, which is what the
 * wrong family does. So the size stays 12 (the terminal has four sizes:
 * 10/12/14/20, and 14 would put the axis level with the toolbar) and the family
 * carries the correction. Widths follow too: Asap's ten-digit run is 64.2px at
 * 12/400 against DIN's 63.98 and Plex's 72.
 */
export const NUM_FAMILY = '"Asap", "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif';

/** Axis labels: 12px / 400. Exported because the x-axis tick filter below has
 *  to measure a label at exactly the size it will be drawn at.
 *
 *  12, not 10. Measured against the reference: its price-axis digits carry 9px
 *  of figure height and its time labels the same, while ours at 10px rendered
 *  7px — the axis was a full step quieter than every other number on the page,
 *  which is the wrong rank for the scale you read the chart against. 12 is the
 *  next step on the terminal's four-size scale (10/12/14/20); 14 would put the
 *  axis level with the toolbar, which it should not be.
 *
 *  It STAYS 12 now that the family is NUM_FAMILY — see the note there. At 12px
 *  Plex draws an 8px digit and Asap a 9px one, so the remaining 1px the reviews
 *  kept reporting as "the axis is one size step small" was the font, not the
 *  size, and bumping to 14 would now overshoot by a whole pixel in the other
 *  direction while breaking the four-size scale. */
export const AXIS_FONT_SIZE = 12;
export const AXIS_FONT_WEIGHT = 400;

/**
 * Clear space between the right-hand price labels and the edge of the canvas.
 *
 * klinecharts' own default is 6. Measured, the reference right-aligns its tick
 * labels 9px inside the chart card and ours landed at 6; the canvas itself is
 * inset 2px from the card by `.kc-canvas` in chart.css (which is what puts the
 * last-price badge on the reference's line), so 7 here plus that 2 is the 9.
 *
 * It is `marginEnd` rather than a padding on the label: the library adds
 * marginStart + marginEnd to the y-axis band width, so the price gutter grows
 * with the inset instead of the labels sliding over the candles.
 */
const AXIS_LABEL_MARGIN_END = 7;

/** Volume/histogram fills: the candle colours at ~60% so bars never shout. */
const POS_FILL = 'rgba(0, 180, 129, 0.6)';
const NEG_FILL = 'rgba(239, 74, 60, 0.6)';

export const CANDLE_PANE_ID = 'candle_pane';

/**
 * Default distance between bar centres, in px.
 *
 * 6, and the number that matters is not the body width but the GAP.
 *
 * klinecharts derives the body from the pitch and never exposes the gap: the
 * store computes `ratio = 1 - 0.2*atan(max(4, barSpace) - 4)/(PI/2)`, floors
 * `barSpace * ratio`, and steps an even result down to the next odd number so
 * the body can straddle a whole pixel column. That function is nearly flat at
 * this end of the range, so it produces a 5px body for every pitch from 6 to 8
 * — which is why our candles kept their width while the space between them
 * grew. At the 8 this used to hold, 5 of every 8px slot was ink and 3 was gap
 * (63%) and the candles read as thin sticks in a wide field; measured, the
 * reference runs a 6px pitch around the same 5px body — a 1px gap, 83% — and
 * its bodies nearly touch. 6 lands exactly there (ratio 0.859 -> floor 5, odd,
 * kept), so the fix is the pitch, not a body override.
 *
 * Applied once after init; the user's own zoom is free to move it afterwards,
 * and the same formula keeps the body proportionate as they do.
 */
export const DEFAULT_BAR_SPACE = 6;

/**
 * Gap between the newest bar and the price axis on a fresh chart, in px -
 * klinecharts' own default (80), stated here because two things must agree on
 * it: every load puts the newest bar there, and the double-click reset
 * (viewTween.ts) has to land exactly where a fresh chart would. Chart.tsx
 * applies it once at init, so it is ours rather than an assumption.
 */
export const DEFAULT_OFFSET_RIGHT = 80;

/** Text badge sitting on a --pos/--neg background: near-black, not white. */
const ON_ACCENT = T.bg;

export const chartStyles: DeepPartial<Styles> = {
  // Off by default (the owner's call): the candles on the plain panel, no lines behind them.
  grid: {
    show: false,
    horizontal: { show: true, size: 1, style: 'solid', color: T.grid },
    vertical: { show: true, size: 1, style: 'solid', color: T.grid },
  },
  candle: {
    type: 'candle_solid',
    /* ONLY BULLISH AND BEARISH. A candle that closed exactly where it opened -
       a doji, and every new candle until its first trade moves it - is drawn
       bullish: close >= open is up, the convention TradingView's own charts
       use. klinecharts' default grey for "no change" put a grey candle on the
       chart at every rollover and on every doji, a third colour that means
       nothing to a trader. */
    bar: {
      compareRule: 'current_open',
      upColor: T.pos,
      downColor: T.neg,
      noChangeColor: T.pos,
      upBorderColor: T.pos,
      downBorderColor: T.neg,
      noChangeBorderColor: T.pos,
      upWickColor: T.pos,
      downWickColor: T.neg,
      noChangeWickColor: T.pos,
    },
    priceMark: {
      // `textWeight` is typed as a string here, unlike every other weight in
      // the style tree - hence the quotes rather than the shared constant.
      // OFF. klinecharts prints an arrow plus the price at the visible high and
      // low, directly over the candles. The reference draws no such markers -
      // its only canvas text is the legend - and on a live chart these two
      // labels jump to a different candle every time the window scrolls, which
      // is exactly the kind of movement that pulls the eye away from the price
      // action they sit on top of. The high and low are already readable from
      // the axis and are printed exactly in the header's 24h High / 24h Low.
      high: { show: false, color: T.canvasDim, textFamily: NUM_FAMILY, textSize: AXIS_FONT_SIZE, textWeight: '400' },
      low: { show: false, color: T.canvasDim, textFamily: NUM_FAMILY, textSize: AXIS_FONT_SIZE, textWeight: '400' },
      last: {
        /* The rule and its badge take the LAST CANDLE's colour (its close
           against its open, flat counting as up - see candle.bar), never a
           grey of their own: klinecharts' default compares with the previous
           close and turned both grey whenever a new candle opened. */
        compareRule: 'current_open',
        upColor: T.pos,
        downColor: T.neg,
        noChangeColor: T.pos,
        /* The dotted last-price rule. klinecharts' default is a 4-on/4-off dash
           that reads as a bold rule competing with the candles; measured, the
           reference is a 1px dot every 3px - present, but something the eye
           steps over on its way to the price action. */
        line: { show: true, style: 'dashed', size: 1, dashedValue: [1, 2] },
        /* The badge on the price axis. WHITE on the red/green fill, not
           near-black: at this size on #ef4a3c a dark label is genuinely
           unreadable, and this is the one number on the axis a trader looks at.
           Square corners, measured.

           VERTICAL PADDING IS 3, NOT 4. The library builds the box as
           paddingTop + fontSize + paddingBottom, so 4 gave a 20px chip around
           11px of ink — measured, the reference's is 17px around the same 11,
           and ours read as a chunkier tag pinned to the scale rather than a
           label riding on it. 3 gives 18: a pixel over the reference, chosen
           over the 16 that 2 would give because a badge that crowds its own
           digits reads as a rendering fault and one that is a pixel generous
           does not. Horizontal padding stays 4 — the badge's width was never
           the complaint. */
        text: {
          color: T.text,
          family: NUM_FAMILY,
          size: AXIS_FONT_SIZE,
          weight: 500,
          borderRadius: 0,
          borderSize: 0,
          paddingLeft: 4,
          paddingRight: 4,
          paddingTop: 3,
          paddingBottom: 3,
        },
      },
    },
    /* The DOM legend in Chart.tsx already shows symbol / interval / OHLC /
       change, so the canvas tooltip would be a second copy of the same numbers
       in a different font. Indicator tooltips stay on - those have no DOM
       equivalent and are how you read a MACD pane. */
    /* offsetTop is 28 against the library's 6, and it is NOT dead just because
       this tooltip is off. On the candle pane the library lays the two
       tooltips out in one column: it draws the candle tooltip from
       `candle.tooltip.offsetTop` and starts the INDICATOR tooltip wherever that
       one finished — which, with showRule 'none', is offsetTop itself. So this
       number is what positions an indicator's readout, and at 6 it printed
       straight through the DOM legend in Chart.tsx ("BTC-USD · 1m O… H… L… C…")
       the moment anyone added an MA, leaving neither line readable. The legend
       sits 8px down from the pane top and is one 16.5px line box tall; 28
       clears it with a few pixels to spare, so the two stack as two rows.
       `indicator.tooltip.offsetTop` is deliberately left alone — that one
       governs indicators in a pane of their own, where there is no DOM legend
       to avoid. */
    tooltip: { showRule: 'none', offsetTop: 28 },
  },
  indicator: {
    // Flat counts as up here too (volume bars follow their candle).
    ohlc: { upColor: POS_FILL, downColor: NEG_FILL, noChangeColor: POS_FILL },
    bars: [{ style: 'fill', upColor: POS_FILL, downColor: NEG_FILL, noChangeColor: POS_FILL }],
    lines: [
      { color: T.line1 },
      { color: T.line2 },
      { color: T.line3 },
      { color: T.line4 },
      { color: T.line5 },
    ],
    circles: [{ style: 'fill', upColor: POS_FILL, downColor: NEG_FILL, noChangeColor: POS_FILL }],
    /* OFF on the canvas. The newest value of each study in its own pane is
       tagged on that pane's scale by the DOM legend layer instead
       (chart/IndicatorLegend.tsx): the library paints every tag with one text
       colour, which is unreadable on the light lines of the warm ramp, while
       the DOM tag picks dark or light text per background. */
    lastValueMark: { show: false },
    /* OFF: every indicator now has a DOM legend row (chart/IndicatorLegend.tsx)
       carrying its name, its values and its eye / settings / remove controls,
       so the canvas copy would print the same numbers twice. */
    tooltip: {
      showRule: 'none',
      showType: 'standard',
      /* Both neutral, like every other pixel of text inside the canvas. The
         title is the indicator's NAME — "MA(5,10,20)" — so it keeps the text
         family; the legend line is "MA5: 80,123.45", a value with a short
         prefix, so it takes the numeral one. Same label/value split the DOM
         legend uses, and the same reason the O/H/L/C letters ride along with
         their figures: a prefix set in a different face reads as a second
         word rather than as part of the token. */
      title: { color: T.canvasMuted, family: FAMILY, size: 12, weight: 400 },
      legend: { color: T.canvasMuted, family: NUM_FAMILY, size: 12, weight: 400 },
    },
  },
  /* No axis line and no tick marks. The reference draws the axis as text alone
     floating on the surface; a hairline box around the plot is the single
     biggest thing that makes a chart read as a widget rather than as the page. */
  xAxis: {
    /* 32px, pinned rather than 'auto'.
     *
     * Auto sizes the band to exactly the text it holds (4px lead-in + 12px of
     * glyph + 6px trail = 22), which leaves the time labels almost touching the
     * footer strip below them. Measured, the reference reserves ~67px between
     * the last candle and the card floor against our 52, and holds 34px between
     * the time-axis baseline and the clock where we held 24 — the axis is meant
     * to float in clear space, not to be packed against the row under it. The
     * label itself does not move: klinecharts draws it 8px below the plot in
     * either case, so the whole 10px goes underneath where it is wanted. The
     * remaining 4px of the 15 are the footer's, in chart.css. */
    size: 32,
    axisLine: { show: false },
    tickLine: { show: false },
    tickText: {
      color: T.canvasMuted,
      family: NUM_FAMILY,
      size: AXIS_FONT_SIZE,
      weight: AXIS_FONT_WEIGHT,
    },
  },
  yAxis: {
    axisLine: { show: false },
    tickLine: { show: false },
    tickText: {
      color: T.canvasMuted,
      family: NUM_FAMILY,
      size: AXIS_FONT_SIZE,
      weight: AXIS_FONT_WEIGHT,
      marginEnd: AXIS_LABEL_MARGIN_END,
    },
  },
  separator: { size: 1, color: T.grid, fill: true, activeBackgroundColor: 'rgba(255, 181, 71, 0.14)' },
  crosshair: {
    horizontal: {
      line: { color: T.dim },
      text: {
        color: T.text,
        family: NUM_FAMILY,
        size: AXIS_FONT_SIZE,
        weight: AXIS_FONT_WEIGHT,
        backgroundColor: T.control,
        borderColor: T.control,
      },
    },
    vertical: {
      line: { color: T.dim },
      text: {
        color: T.text,
        family: NUM_FAMILY,
        size: AXIS_FONT_SIZE,
        weight: AXIS_FONT_WEIGHT,
        backgroundColor: T.control,
        borderColor: T.control,
      },
    },
  },
  overlay: {
    /* The handle under the pointer keeps the accent too - the library's
       default active colour is its own blue, the one cold hue that would
       otherwise appear on this canvas the moment a drawing is hovered. */
    point: {
      color: T.accent,
      borderColor: 'rgba(255, 181, 71, 0.35)',
      activeColor: T.accent,
      activeBorderColor: 'rgba(255, 181, 71, 0.35)',
    },
    line: { color: T.accent },
    rect: { color: 'rgba(255, 181, 71, 0.14)', borderColor: T.accent },
    polygon: { color: T.accent, borderColor: T.accent },
    circle: { color: 'rgba(255, 181, 71, 0.14)', borderColor: T.accent },
    arc: { color: T.accent },
    /* NUM_FAMILY: everything an overlay prints is a price — the tag on a price
       line, the levels down a retracement — so it belongs to the numeral half
       of the type split like the axis it is read against. */
    text: { color: ON_ACCENT, family: NUM_FAMILY, size: 12, weight: 400, backgroundColor: T.accent, borderColor: T.accent },
  },
};

/**
 * Name of our x-axis behaviour. Registered globally by name, applied per chart
 * with `chart.overrideXAxis({ name: X_AXIS_NAME })`.
 */
export const X_AXIS_NAME = 'valuetrade';

/** Pixels of clear space a tick label must have inside the plot's left edge. */
const AXIS_EDGE_INSET = 4;

/* --- the logarithmic price scale -------------------------------------------
 *
 * klinecharts ships a `logarithm` y-axis and it auto-ranges over an interval
 * that has nothing to do with the data. Measured on BTC-USD 1m: the loaded bars
 * spanned 79,245–79,800 and the axis ranged 45,000–150,110, which squeezed 350
 * pixel rows of candles into three. Lin and % were unaffected.
 *
 * THE CAUSE IS A UNIT ERROR IN THE LIBRARY, not a bad bound in our data.
 * `YAxisImp.createRangeImp` asks the axis for a `minSpan` — the narrowest range
 * it is willing to show — and widens the range by `TICK_COUNT * minSpan` when
 * the data is narrower than that. The comparison happens in the axis's REAL
 * space, which for a log axis is log10(price): dimensionless decades. But the
 * built-in template answers in PRICE units:
 *
 *     minSpan: (precision) => 0.05 * 10 ** -precision
 *
 * BTC-USD has a tickSize of "1", so pricePrecision is 0 and that returns 0.05.
 * On the linear axis 0.05 is five cents and never binds. On the log axis 0.05
 * is five hundredths of a DECADE — a 12% price move — so the 0.0031-decade
 * range the data actually occupies is judged too narrow, and the axis is opened
 * by 8 × 0.05 = 0.4 decades, then by the 30% top/bottom gap: exactly the
 * 45,563–152,290 window observed. The narrower the real range and the coarser
 * the tick size, the worse it gets, which is why it looked random.
 *
 * So we register our own axis under the same name — `registerYAxis` keys the
 * registry by name, so this replaces the built-in for every chart — with the
 * two things it gets wrong put right:
 *
 *   1. `minSpan` answers in decades, because that is the space the number is
 *      compared in. It is a floor against a zero-height range, nothing more,
 *      and it is deliberately small enough that no real chart ever reaches it.
 *   2. Values a log axis genuinely cannot place are EXCLUDED from the range
 *      rather than transformed anyway. log10(0) is -Infinity and log10 of a
 *      negative is NaN; either one, fed into `realFrom`, opens the range
 *      without limit — the same failure mode by a different door. The built-in
 *      transform instead mirrors negatives (`-log10(|v|)`), which is not
 *      monotonic across zero: it plots -0.5 ABOVE +0.5. A price that cannot be
 *      shown on a log axis is not shown, and does not drag the axis with it.
 */

/**
 * Narrowest span the log axis will accept before widening, in DECADES (log10
 * units). 1e-5 decades is 0.0023% of price — 1.8 dollars on BTC at 80,000, and
 * the widening it triggers opens the range to eight times that.
 *
 * It exists only so a perfectly flat series does not produce a zero-height
 * axis. Any window with a candle of visible height in it is orders of magnitude
 * wider than this and passes untouched, which is the whole point: the library's
 * value was large enough to bind on ordinary data. Measured: the 1m BTC window
 * that triggered this fix occupies 0.0031 decades, 300× the floor.
 */
const LOG_MIN_SPAN = 1e-5;

/** log10 for values a log axis can actually place, NaN for the rest. */
const logOrNaN = (v: number): number => (v > 0 && Number.isFinite(v) ? Math.log10(v) : Number.NaN);

/** Inverse. Guards the overflow that would come back as Infinity. */
const unlog = (v: number): number => {
  const out = 10 ** v;
  return Number.isFinite(out) ? out : Number.NaN;
};

/**
 * Smallest strictly-positive price among the candles currently on screen.
 *
 * Reached only when the range the library computed starts at or below zero,
 * which means something in the visible window cannot go on a log axis. Rather
 * than let that value set the floor (it cannot — it has no logarithm), the
 * floor becomes the lowest price that CAN be drawn, so the rest of the series
 * stays legible. Returns null when the window holds no positive price at all.
 *
 * Reads the same two public getters the library's own percentage axis reads.
 * The candle series is the right source because this scale is only ever mounted
 * on the candle pane (Chart.tsx passes CANDLE_PANE_ID); on an indicator pane it
 * would be a floor taken from the wrong series, and the rescue would need the
 * indicator's own results instead.
 */
function lowestPositiveVisible(chart: KChart): number | null {
  const bars = chart.getDataList();
  const visible = chart.getVisibleRange();
  const from = Math.max(0, Math.floor(visible.from));
  const to = Math.min(bars.length, Math.ceil(visible.to));
  let low: number | null = null;
  for (let i = from; i < to; i++) {
    const v = bars[i]?.low;
    if (typeof v === 'number' && v > 0 && Number.isFinite(v) && (low === null || v < low)) low = v;
  }
  return low;
}

const logYAxis: YAxisTemplate = {
  name: 'logarithm',
  minSpan: () => LOG_MIN_SPAN,
  valueToRealValue: (value) => logOrNaN(value),
  displayValueToRealValue: (value) => logOrNaN(value),
  realValueToValue: (value) => unlog(value),
  realValueToDisplayValue: (value) => unlog(value),
  createRange: ({ chart, defaultRange }): AxisRange => {
    const { from, to, range } = defaultRange;
    let realFrom = logOrNaN(from);
    const realTo = logOrNaN(to);
    // Nothing in the window can go on a log axis. Handing back the linear
    // range would silently draw a linear chart under a "Log" button, so the
    // range is left as the library computed it and the transforms above return
    // NaN — the pane draws empty, which is the truthful answer.
    if (!Number.isFinite(realTo)) return defaultRange;
    if (!Number.isFinite(realFrom)) {
      const floor = lowestPositiveVisible(chart);
      realFrom = floor === null ? realTo : logOrNaN(floor);
    }
    return {
      from,
      to,
      range,
      realFrom,
      realTo,
      realRange: realTo - realFrom,
      // Recomputed from the real bounds by createRangeImp once the gap is
      // applied; mirrored here so the object is coherent on its own.
      displayFrom: from,
      displayTo: to,
      displayRange: range,
    };
  },
};

let axisRegistered = false;

/**
 * Register our axes: the x-axis that fixes the clipped leftmost time label, and
 * the y-axis that fixes the logarithmic price scale (see the block above).
 *
 * klinecharts places a tick label CENTRED on its tick, and the first tick can
 * sit two or three pixels from the left edge of the plot, so the label is drawn
 * half outside the canvas and gets cut: "21:48" renders as "1:48". A time that
 * is wrong by ten hours is worse than no time at all, and the same mis-read is
 * invisible on the other labels, so it does not even look like a fault.
 *
 * The fix is to measure the label at the size it will actually be drawn at
 * (klinecharts exports the same `calcTextWidth` its own renderer uses) and drop
 * any tick whose text would not fit whole. Dropping is right rather than
 * nudging: sliding the label right would put it out of line with its own tick,
 * which is a second, quieter lie about where that time is on the axis.
 *
 * Idempotent, and safe to call before every `init`.
 */
export function registerChartAxes(kc: typeof import('klinecharts')): void {
  if (axisRegistered) return;
  axisRegistered = true;
  kc.registerXAxis({
    name: X_AXIS_NAME,
    createTicks: ({ bounding, defaultTicks }) =>
      defaultTicks.filter((tick) => {
        // NUM_FAMILY, matching what the axis will actually be drawn in: the
        // whole point of this filter is that the measurement and the render
        // agree, and Asap sets the same label ~11% narrower than Plex — so
        // measuring in the wrong family would drop labels that do fit.
        const half =
          kc.utils.calcTextWidth(tick.text, AXIS_FONT_SIZE, AXIS_FONT_WEIGHT, NUM_FAMILY) / 2;
        // Left edge only. The right edge is already handled by the library's
        // own tick spacing, and a second filter there could quietly drop a
        // label that fits if the axis bounding is not what we assume.
        return tick.coord - half >= AXIS_EDGE_INSET && tick.coord <= bounding.width;
      }),
  });
  // Replaces the built-in `logarithm` axis: the registry is keyed by name, so
  // `overrideYAxis({ name: 'logarithm' })` in Chart.tsx picks this one up with
  // no change at the call site.
  kc.registerYAxis(logYAxis);
}

/* --- price gridline density ------------------------------------------------
 *
 * klinecharts derives its price ticks from a hard-coded TICK_COUNT of 8, which
 * on a 450px plot lands a gridline roughly every 61px. Measured, the reference
 * runs about 38px — twelve lines where we drew seven — and because the two
 * charts show almost the same px-per-price (0.19 vs 0.20), that gap is a tick
 * COUNT difference and nothing to do with the live range. Seven lines over a
 * 450px plot is a visibly emptier field than the reference's, and the price
 * scale is also the thing you read the candles against, so it is not only
 * decoration: half as many labelled levels is half the resolution.
 *
 * TICK_COUNT is a module constant inside the library, so the count cannot be
 * configured. What CAN be replaced is the axis's `createTicks`, which the
 * library calls with its own finished ticks and whose return value feeds both
 * the labels and the grid. So we recompute the ladder at the pitch we want.
 *
 * THE HARD PART IS NOT THE ARITHMETIC, IT IS KNOWING WHEN NOT TO RUN IT. The
 * callback is handed values and pixel coordinates and nothing that says which
 * price scale is mounted, and the arithmetic below assumes two things that are
 * not true of all of them: that pixels are linear in the tick VALUE, and that
 * the label is that value run through a plain grouped-decimal formatter. On
 * `logarithm` the first is false — pixels are linear in log10(price) — so a
 * straight-line fit would place every inserted line at the wrong height,
 * silently, on a chart people read prices off.
 *
 * Rather than naming scales (which breaks the moment a fourth is registered),
 * both assumptions are PROVEN against the library's own ticks before anything
 * is added: the straight line has to pass within a pixel of every one of them,
 * and our formatter has to reproduce every one of their labels byte for byte.
 * If either check fails we hand the library's ticks straight back, unchanged.
 * The percentage scale passes both (it is linear, and its trailing '%' is
 * carried through as a suffix) and is densified with the rest.
 *
 * The log scale is decided by the same measurement rather than by its name, and
 * the answer depends on how much of a decade is on screen: a wide window curves
 * visibly and is handed back untouched, while an intraday window spanning under
 * a percent is straight to well inside the one-pixel tolerance and is densified
 * — correctly, because over that span the curve and the line are the same line.
 * The gate is a proof about the range in front of it, not a fact about a scale,
 * so it needs no updating when one of them changes.
 */

/** Target pitch between price gridlines, px. */
const Y_TICK_PITCH = 38;
/** Floor, so a short pane never becomes a stack of hairlines. Below the target
 *  because the ladder is coarse: forbidding everything under the target would
 *  round the pitch up on every range where the ladder straddles 38. */
const Y_TICK_MIN_PITCH = 28;
/**
 * Step ladder within a decade.
 *
 * 1.5 earns its place here and it is not decoration: the ladder is what decides
 * the pitch, and without a rung between 1 and 2 a range whose ideal step is 1.3
 * gets rounded to 2 and the plot comes out half again as sparse as asked for —
 * measured, exactly the 58px pitch this ladder produced on its first pass
 * against a 38px target. 3, 4, 6 and 7 (which the library's own ladder allows)
 * stay out: a price axis stepping in 300s is a ladder nobody reads in their
 * head, and it was the source of the 300-unit steps we started from.
 */
const NICE_STEPS = [1, 1.5, 2, 2.5, 5];

const decade = (v: number): number => 10 ** Math.floor(Math.log10(v));

/**
 * The ladder rung whose pitch lands closest to the target, ignoring any rung
 * that would crowd the labels tighter than the floor. Searched across three
 * decades so the answer never depends on which side of a power of ten the
 * ideal step happened to fall. Returns 0 when nothing qualifies.
 */
const chooseStep = (ideal: number, pxPerUnit: number): number => {
  const e = decade(ideal);
  let best = 0;
  let bestErr = Infinity;
  for (const mult of [e / 10, e, e * 10]) {
    for (const s of NICE_STEPS) {
      const step = s * mult;
      const pitch = step * pxPerUnit;
      if (pitch < Y_TICK_MIN_PITCH) continue;
      const err = Math.abs(pitch - Y_TICK_PITCH);
      if (err < bestErr) {
        bestErr = err;
        best = step;
      }
    }
  }
  return best;
};

interface TickFormat {
  decimals: number;
  group: boolean;
  /** Anything the axis appends after the number — '%' on the percentage scale. */
  suffix: string;
}

/**
 * Put every horizontal gridline on ONE pixel row.
 *
 * The price ticks are the grid: klinecharts' GridView reads `yAxis.getTicks()`
 * and strokes a line straight across the pane at each `tick.coord`. Its line
 * figure already does the right thing for an odd stroke width — it offsets by
 * half a pixel so a 1px line covers a whole row — but that only works if the
 * coordinate it is given is a WHOLE number, and a tick's coord is a price
 * mapped through a float scale, so most of them are not. Measured: only 4 of
 * our 9 horizontal lines were a clean 1px #272621; the rest split into two rows
 * carrying roughly 67% and 33% of the intended contrast (#23221d over #1f1e18),
 * which is why the grid read as some lines sharp and some washed out. The
 * reference's twelve lines are all exactly one row of #272621, with no dim
 * intermediate greys anywhere in the plot histogram.
 *
 * Rounding moves a line by at most half a pixel, which at ~38px between lines
 * is well under the price resolution the label states — and the label text is
 * computed from the VALUE, so nothing on the axis changes meaning. Applied to
 * the library's own ticks as well as ours, so the fallback paths below (the
 * logarithmic scale, an axis with a formatter we cannot reproduce) get a crisp
 * grid too rather than only the linear one.
 */
const snapTicks = (ticks: AxisTick[]): AxisTick[] =>
  ticks.map((t) => (Number.isInteger(t.coord) ? t : { ...t, coord: Math.round(t.coord) }));

const formatTick = (v: number, f: TickFormat): string => {
  const fixed = Math.abs(v).toFixed(f.decimals);
  const dot = fixed.indexOf('.');
  const whole = dot === -1 ? fixed : fixed.slice(0, dot);
  const frac = dot === -1 ? '' : fixed.slice(dot);
  const grouped = f.group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole;
  // `-0` is a real outcome of toFixed on a small negative and is never a price.
  const sign = v < 0 && Number(fixed) !== 0 ? '-' : '';
  return `${sign}${grouped}${frac}${f.suffix}`;
};

/**
 * Work out how the axis is printing its numbers, by reproducing every label it
 * already produced. Returns null the moment one does not match, which is what
 * keeps a custom formatter, a folded decimal or a percent sign from being
 * quietly rewritten in the ticks we add.
 */
const readTickFormat = (ticks: AxisTick[], values: number[]): TickFormat | null => {
  const sample = ticks[0]?.text;
  if (sample === undefined) return null;
  const head = /^-?[\d,]+(\.\d+)?/.exec(sample);
  if (head === null) return null;
  const [number, fraction] = head;
  const decimals = fraction === undefined ? 0 : fraction.length - 1;
  const suffix = sample.slice(number.length);
  for (const group of [number.includes(','), !number.includes(',')]) {
    const f = { decimals, group, suffix };
    const ok = ticks.every((t, i) => {
      const v = values[i];
      return v !== undefined && formatTick(v, f) === t.text;
    });
    if (ok) return f;
  }
  return null;
};

/**
 * The ladder itself, before pixel snapping. Every `return defaultTicks` below is
 * a gate refusing to guess; `createDenseYTicks` snaps whichever set comes back.
 */
const denseYTicks: AxisCreateTicksCallback = ({ bounding, defaultTicks }) => {
  const n = defaultTicks.length;
  const height = bounding.height;
  // Two points cannot show a line is straight, so three is the minimum this is
  // willing to extrapolate from.
  if (n < 3 || !(height > 0)) return defaultTicks;

  const first = defaultTicks[0];
  const last = defaultTicks[n - 1];
  if (first === undefined || last === undefined) return defaultTicks;

  const values = defaultTicks.map((t) => Number(t.value));
  if (values.some((v) => !Number.isFinite(v))) return defaultTicks;

  const anchor = first.coord;
  const base = Number(first.value);
  const dv = Number(last.value) - base;
  const dc = last.coord - anchor;
  if (dv === 0 || dc === 0) return defaultTicks;
  const slope = dc / dv;

  // Linearity gate. This is what excludes the logarithmic scale, and it is the
  // check that keeps a wrong PRICE off the axis rather than merely a wrong gap.
  const straight = defaultTicks.every(
    (t) => Math.abs(anchor + (Number(t.value) - base) * slope - t.coord) <= 1,
  );
  if (!straight) return defaultTicks;

  // Format gate — anything printing its labels through a formatter we cannot
  // reproduce exactly (a folded decimal, a custom unit) keeps the library's.
  const fmt = readTickFormat(defaultTicks, values);
  if (fmt === null) return defaultTicks;

  const pxPerUnit = Math.abs(slope);
  const step = chooseStep(Y_TICK_PITCH / pxPerUnit, pxPerUnit);
  if (step <= 0) return defaultTicks;
  // A step the axis cannot print — 2.5 on an axis showing whole units — would
  // label two different lines with the same number.
  if (Number(step.toFixed(fmt.decimals)) !== step) return defaultTicks;

  // The library drops any tick whose label would touch the top or bottom edge;
  // ours has to do the same or the axis grows a clipped first and last line.
  const edge = AXIS_FONT_SIZE;
  const at = (coord: number) => base + (coord - anchor) / slope;
  const a = at(edge);
  const b = at(height - edge);
  const min = Math.min(a, b);
  const max = Math.max(a, b);

  const round = Math.min(15, fmt.decimals + 6);
  const out: AxisTick[] = [];
  for (let k = Math.ceil(min / step); k * step <= max && out.length < 64; k++) {
    const v = Number((k * step).toFixed(round));
    const coord = anchor + (v - base) * slope;
    if (coord <= edge || coord >= height - edge) continue;
    out.push({ coord, value: v, text: formatTick(v, fmt) });
  }
  // Never hand back a SPARSER axis than the library's — if the arithmetic above
  // produced fewer lines than it started with, something about this range is not
  // what we assumed.
  return out.length >= n ? out : defaultTicks;
};

/**
 * Denser price ticks, at the measured pitch, each on a whole pixel row. Pass to
 * `overrideYAxis`.
 *
 * Falls back to the library's own ticks whenever it cannot prove the axis is
 * linear in price and that it can reproduce the axis's labels — see the block
 * comment above — but snaps those too, because the grid is drawn from these
 * coordinates whichever set wins.
 */
export const createDenseYTicks: AxisCreateTicksCallback = (params) =>
  snapTicks(denseYTicks(params));

/**
 * Volume/turnover axis labels. v9's `customApi` option is `formatter` in v10;
 * the built-in date formatter already renders through `Intl.DateTimeFormat('en')`
 * into explicit YYYY-MM-DD/HH:mm templates, so it needs no override (overriding
 * it could only reintroduce the locale ambiguity format.ts exists to prevent).
 * From a thousand up a value folds to K/M/B with at most two decimals and no
 * padding zeros (5K, 2.5K, 1.28K). Below that it comes back AS GIVEN: the
 * library has already printed it at the series' own precision (the volume
 * step size), and re-rounding it here is what turned SoDEX's 696.15681 into
 * our 696.24 and 0.9 into "0.9000".
 */
export function formatBigNumber(value: string | number): string {
  const v = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(v)) return String(value);
  if (Math.abs(v) < 1e3) return String(value);
  return compactNumber(v);
}
