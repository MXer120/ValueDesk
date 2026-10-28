/**
 * The chart toolbar's other views - Depth and Market info. Depth is the deep
 * order book this app already fetches (see useOrderBook in Market.tsx).
 * Market info is the symbol's own trading rules, read from SoDEX's symbol
 * list (the same payload the order ticket validates against) and refreshed
 * with that list. Nothing on this panel is a hardcoded fact.
 *
 * DATA HONESTY, same rule as Market.tsx: every figure here comes from the
 * feed or renders an em-dash. The quote coin is shown as USDC — SoDEX's
 * ledger name is vUSDC, and that spelling never reaches a label.
 */
import { fmtFixed } from '../numStyle';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { type Engine, type Symbol } from '../api';
import { useOrderBook } from './Market';
import { CoinIcon, CoinLabel } from './CoinIcon';
import { useSharedStored } from '../hooks';
import { DASH, coinLabel, fmt, fmtPrice, num, precisionOf } from '../format';
import './MarketPanels.css';

/** Compact notional - same scale Market.tsx's book and header use, so a
 *  figure means the same thing wherever it is read on this page. */
function fmtCompact(v: number): string {
  if (!Number.isFinite(v)) return DASH;
  const a = Math.abs(v);
  if (a >= 1e9) return `${fmtFixed(v / 1e9, 2)}B`;
  if (a >= 1e6) return `${fmtFixed(v / 1e6, 2)}M`;
  if (a >= 1e3) return `${fmtFixed(v / 1e3, 2)}K`;
  return fmtFixed(v, 2);
}

/** A rate stored as a decimal fraction ("0.0125") to a percentage ("1.25%"). */
const pctOf = (v: string | undefined, dp = 2): string => {
  const n = v === undefined ? NaN : num(v) * 100;
  return Number.isFinite(n) ? `${fmtFixed(n, dp)}%` : DASH;
};

/**
 * This venue's OWN sentinel for "no ceiling" - confirmed against the
 * server's `normaliseOrder`, which treats a "0" bound as unbounded rather
 * than as a real cap of zero. Rendering "0 USDC" here would say the exact
 * opposite of what the field means.
 */
const isUnbounded = (v: string | undefined): boolean => v === undefined || num(v) <= 0;

const Row = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="mkinfo-row">
    <span className="mkinfo-l">{label}</span>
    <span className="mkinfo-v">{value}</span>
  </div>
);

/** Amount or name, with the coin's logo. The text is already a display label. */
const CoinValue = ({ coin, text }: { coin: string | undefined; text: string }) => (
  <CoinLabel coin={coin} size={16}>{text}</CoinLabel>
);

// --- market info -------------------------------------------------------------

/**
 * "Trading rules" - matched to the reference terminal's own panel: the same
 * left column (settlement currency, step size, leverage, tick size, minimum
 * order value) and the same right-hand "Order Guidelines" block. Below that,
 * every OTHER field this venue publishes for the symbol and this app already
 * fetches, which the reference panel does not show but nothing stops this
 * one from including - price bands, fees, funding bounds, open interest cap.
 */
export function MarketInfoView({ engine, symbol, sym }: { engine: Engine; symbol: string; sym?: Symbol }) {
  if (!sym) {
    return <div className="mkinfo mkinfo-empty">Loading market info…</div>;
  }
  const perps = engine === 'perps';
  const base = sym.baseCoin;
  const quote = sym.quoteCoin;
  const baseName = coinLabel(base) || base;
  const quoteName = coinLabel(quote) || 'USDC';
  const qty = (v: string | undefined) => `${fmt(v, precisionOf(sym.stepSize))} ${baseName}`;

  return (
    <div className="mkinfo">
      <div className="mkinfo-head">
        <span className="mkinfo-pair" aria-hidden="true">
          <CoinIcon coin={base ?? symbol} size={28} />
          <CoinIcon coin={quote ?? 'USDC'} size={28} />
        </span>
        <h2 className="mkinfo-title">{sym.displayName}</h2>
        <span className={`mkinfo-badge ${perps ? 'perp' : 'spot'}`}>{perps ? 'Futures' : 'Spot'}</span>
      </div>

      <h3 className="mkinfo-h3">Trading rules</h3>
      <div className="mkinfo-cols">
        <div className="mkinfo-col">
          <Row label="Settlement Currency" value={<CoinValue coin={quote} text={quoteName} />} />
          <Row label="Step Size" value={<CoinValue coin={base} text={`${fmt(sym.stepSize, precisionOf(sym.stepSize))} ${baseName}`} />} />
          {perps && <Row label="Maximum Leverage" value={sym.maxLeverage ? `${sym.maxLeverage}x` : DASH} />}
          <Row label="Tick Size" value={fmt(sym.tickSize, precisionOf(sym.tickSize))} />
          <Row label="Minimum Order Value" value={<CoinValue coin={quote} text={`${fmt(sym.minNotional, 2)} ${quoteName}`} />} />
          {perps && sym.fundingInterval && (
            <Row label="Funding Interval" value={`${(sym.fundingInterval / 3600).toFixed(0)}h`} />
          )}
        </div>
        <div className="mkinfo-col">
          <h4 className="mkinfo-h4">Order Guidelines</h4>
          {!isUnbounded(sym.maxNotional) && (
            <Row label="Maximum value of a limit order" value={<CoinValue coin={quote} text={`${fmt(sym.maxNotional, 0)} ${quoteName}`} />} />
          )}
          {!isUnbounded(sym.maxQuantity) && (
            <Row label="Maximum quantity per order" value={<CoinValue coin={base} text={qty(sym.maxQuantity)} />} />
          )}
          {!isUnbounded(sym.minQuantity) && (
            <Row label="Minimum order quantity" value={<CoinValue coin={base} text={qty(sym.minQuantity)} />} />
          )}
          <Row label="Maker / Taker Fee" value={`${pctOf(sym.makerFee, 3)} / ${pctOf(sym.takerFee, 3)}`} />
          {sym.buyLimitUpRatio && <Row label="Limit Order Band, Up" value={pctOf(sym.buyLimitUpRatio, 1)} />}
          {sym.sellLimitDownRatio && <Row label="Limit Order Band, Down" value={pctOf(sym.sellLimitDownRatio, 1)} />}
          {sym.marketDeviationRatio && <Row label="Market Order Slippage Band" value={pctOf(sym.marketDeviationRatio, 1)} />}
          {perps && (sym.minFundingRate || sym.maxFundingRate) && (
            <Row
              label="Funding Rate Band"
              value={`${pctOf(sym.minFundingRate, 2)} to ${pctOf(sym.maxFundingRate, 2)}`}
            />
          )}
          {perps && sym.openInterestCap && (
            <Row label="Open Interest Cap" value={<CoinValue coin={base} text={`${fmtCompact(num(sym.openInterestCap))} ${baseName}`} />} />
          )}
        </div>
      </div>
    </div>
  );
}

// --- depth chart ---------------------------------------------------------------

/**
 * A step-area path: flat between levels, a vertical jump at each one - the
 * correct shape for "cumulative size resting at or better than this price",
 * which is not a smooth function between two real levels the way a line
 * chart implies. Closed against the baseline so it can be filled as well as
 * stroked.
 */
/**
 * NO TRAILING `Z`, deliberately - this used to close back to the start,
 * which drew a flat coloured line the full width of the chart along the
 * baseline: real for FILLING (SVG treats every subpath as closed for that
 * purpose regardless), wrong for STROKING, which only draws the segments a
 * path actually states. Ending the path at the right wall's own bottom
 * corner keeps the fill exactly as before while leaving the baseline
 * unstroked - what remains visible is the left wall, the step curve, and
 * the right wall, which is the whole of what "lines going straight down at
 * the end" asked for and none of what it did not.
 */
function stepAreaD(
  points: [number, number][],
  xOf: (p: number) => number,
  yOf: (v: number) => number,
  baseline: number,
): string {
  if (!points.length) return '';
  let d = `M ${xOf(points[0]![0]).toFixed(2)} ${baseline.toFixed(2)}`;
  d += ` L ${xOf(points[0]![0]).toFixed(2)} ${yOf(points[0]![1]).toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${xOf(points[i]![0]).toFixed(2)} ${yOf(points[i - 1]![1]).toFixed(2)}`;
    d += ` L ${xOf(points[i]![0]).toFixed(2)} ${yOf(points[i]![1]).toFixed(2)}`;
  }
  const last = points[points.length - 1]!;
  d += ` L ${xOf(last[0]).toFixed(2)} ${baseline.toFixed(2)}`;
  return d;
}

/**
 * The visible outline, SEPARATE from the fill shape above: just the step
 * curve itself, open at both ends, with no vertical segment down to the
 * baseline or out to the domain edge. Stroking `stepAreaD`'s own path drew
 * those closing segments too - correct for the fill (that's what gives it a
 * bottom to fill down to) but wrong for the line, which read as a solid
 * coloured wall on both sides of the chart instead of a step curve.
 */
function stepLineD(points: [number, number][], xOf: (p: number) => number, yOf: (v: number) => number): string {
  if (!points.length) return '';
  let d = `M ${xOf(points[0]![0]).toFixed(2)} ${yOf(points[0]![1]).toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${xOf(points[i]![0]).toFixed(2)} ${yOf(points[i - 1]![1]).toFixed(2)}`;
    d += ` L ${xOf(points[i]![0]).toFixed(2)} ${yOf(points[i]![1]).toFixed(2)}`;
  }
  return d;
}

/** One wheel notch's zoom multiplier - the same accumulate-then-step shape
 *  as the Order Book's own scroll-to-zoom (see the wheel effect in Book()),
 *  but a continuous multiplier rather than a step through a fixed ladder:
 *  price is a continuous axis here, grouping there is a discrete one. */
const DEPTH_ZOOM_FACTOR = 1.15;
const DEPTH_ZOOM_WHEEL_UNIT = 120;

interface DepthPoint {
  /** Level price. */
  p: number;
  /** Cumulative BASE quantity from the touch out to and including this level. */
  base: number;
  /** Cumulative QUOTE notional over the same run - price times quantity,
   *  summed per level, not this level's price times the base total (the
   *  same distinction `withCumulative` in bookDepth.ts exists to get right). */
  quote: number;
}

/**
 * The classic cumulative depth chart - two step-areas meeting at the touch,
 * low at the spread and rising as price moves away from it either way.
 * DIFFERENT information from the Order Book panel's ladder, not a redundant
 * picture of it: the ladder answers "what is resting at this exact price",
 * this answers "how much could a market order actually eat into, at or
 * better than this price" - the running total the ladder's own Sum column
 * carries but never plots.
 *
 * Shares `useOrderBook` with the Order Book panel - see that hook for why a
 * second subscription to the same market costs no second request. Shares
 * its unit toggle too (see useSharedStored), so switching the ladder to USD
 * or BTC changes what this chart's Y axis and hover reading mean as well -
 * one setting for "which unit is this whole book displayed in", not two
 * that can disagree.
 */
export function DepthView({ engine, symbol, sym }: { engine: Engine; symbol: string; sym?: Symbol }) {
  const book = useOrderBook(engine, symbol);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ price: number; cum: number; side: 'bid' | 'ask'; x: number; y: number } | null>(
    null,
  );
  const [unit] = useSharedStored<'quote' | 'base'>('ot.bookunit', 'quote');
  /**
   * `null` = "follow the default view"; a number once the user has scrolled
   * at all, from then on holding whatever they set (the normal contract any
   * zoomable chart keeps - it does not snap back just because a new tick
   * arrived). 1 is the CEILING regardless: the true worst level on the
   * deeper side, which is genuinely all the depth there is - "zoom out
   * further" past it has nothing left to reveal, so it should be reachable,
   * not padded with more empty track.
   */
  const [zoom, setZoom] = useState<number | null>(null);
  const wheelAcc = useRef(0);
  /** The wheel listener is set up once (empty deps - see below) and reads
   *  these through a ref rather than closing over stale render values,
   *  the same pattern useRecorder's `latest` uses for the same reason. */
  const zoomBoundsRef = useRef({ minZoom: 0.01, defaultZoom: 1 });

  useEffect(() => setZoom(null), [engine, symbol]);

  const { bidPts, askPts, worstBid, worstAsk, mid } = useMemo(() => {
    const bids = (book?.bids ?? []).map(([p, q]) => [num(p), num(q)] as [number, number]).filter(([, q]) => q > 0);
    const asks = (book?.asks ?? []).map(([p, q]) => [num(p), num(q)] as [number, number]).filter(([, q]) => q > 0);
    bids.sort((a, b) => b[0] - a[0]); // best (highest) first
    asks.sort((a, b) => a[0] - b[0]); // best (lowest) first

    // Accumulated from the touch outward, then the bid side reversed so
    // BOTH arrays read left-to-right by price - worst first, touch last for
    // bids; touch first, worst last for asks (already the fold order).
    let cumBase = 0;
    let cumQuote = 0;
    const bp: DepthPoint[] = [];
    for (const [p, q] of bids) {
      cumBase += q;
      cumQuote += p * q;
      bp.push({ p, base: cumBase, quote: cumQuote });
    }
    bp.reverse();
    cumBase = 0;
    cumQuote = 0;
    const ap: DepthPoint[] = [];
    for (const [p, q] of asks) {
      cumBase += q;
      cumQuote += p * q;
      ap.push({ p, base: cumBase, quote: cumQuote });
    }

    const bb = bids[0]?.[0];
    const ba = asks[0]?.[0];
    return {
      bidPts: bp,
      askPts: ap,
      worstBid: bids[bids.length - 1]?.[0],
      worstAsk: asks[asks.length - 1]?.[0],
      mid: bb !== undefined && ba !== undefined ? (bb + ba) / 2 : undefined,
    };
  }, [book]);

  // The TRUE full range - zoom=1 reaches exactly the deeper side's real
  // worst level, no further and no less; `maxHalf` takes that deeper side
  // so a symmetric-around-mid window always reaches it, and the domain
  // clamp below pulls the thinner side back to its OWN true edge rather
  // than padding it with empty space it does not have.
  const halfBid = mid !== undefined && worstBid !== undefined ? mid - worstBid : 0;
  const halfAsk = mid !== undefined && worstAsk !== undefined ? worstAsk - mid : 0;
  const maxHalf = Math.max(halfBid, halfAsk) || 1;
  const tick = num(sym?.tickSize) || maxHalf / 1000;
  // Never zoom in past ~2 ticks of half-span - tighter than that and there
  // is nothing left to resolve between individual price levels. NO absolute
  // floor here (an earlier version had one at 0.0005) - a fixed floor on a
  // RATIO is only ever correct for one specific tick-to-price scale. BTC's
  // $1 tick against a ~$77,000 price is a ratio of ~0.000013, well under
  // 0.0005, so that floor was silently overriding the tick-based bound and
  // capping BTC's zoom-in at roughly 38 ticks of half-span instead of 2 -
  // universally wrong the moment a market's tick is small relative to its
  // price, which is exactly BTC's case and not any other listed coin's.
  const minZoom = (tick * 2) / maxHalf;

  /**
   * The DEFAULT view, before any scrolling: a PERCENTAGE of the touch
   * price, not a raw fraction of `maxHalf` - the same distinction the venue
   * itself draws by pricing every symbol's tick size relative to its own
   * price rather than a shared absolute grid (see groupingSteps in
   * bookGroup.ts). A fixed dollar window only means anything for a market
   * actually priced in the tens of thousands; the same window on a sub-$1
   * altcoin would be the entire possible price range, and on a six-figure
   * one would show nothing but the touch. Applying a PERCENTAGE rather than
   * a raw dollar figure is what makes the default "similar for every coin".
   */
  const DEFAULT_ZOOM_PCT = 0.0025;
  const defaultZoom = Math.min(1, Math.max(minZoom, ((mid ?? 0) * DEFAULT_ZOOM_PCT) / maxHalf));
  const effectiveZoom = zoom ?? defaultZoom;
  // The wheel effect below is set up once (empty deps) and so closes over
  // whatever `minZoom`/`defaultZoom` were at MOUNT - stale the moment the
  // touch moves. Refreshing this ref every render is what lets a scroll,
  // whenever it happens, bound against and start from the CURRENT values
  // rather than however-old mount-time ones.
  zoomBoundsRef.current.minZoom = minZoom;
  zoomBoundsRef.current.defaultZoom = defaultZoom;

  const visibleHalf = maxHalf * effectiveZoom;
  const domainLo = mid !== undefined ? Math.max(worstBid ?? mid, mid - visibleHalf) : (worstBid ?? 0);
  const domainHi = mid !== undefined ? Math.min(worstAsk ?? mid, mid + visibleHalf) : (worstAsk ?? 1);

  // Scroll to zoom, same reasoning as the Order Book's own wheel handler for
  // why this is a NATIVE listener and not React's onWheel: React has
  // attached wheel as a passive root listener since v17, so a synthetic
  // handler's preventDefault is silently ignored and the dashboard behind
  // the panel would scroll along with every zoom gesture.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheelAcc.current += e.deltaY;
      while (Math.abs(wheelAcc.current) >= DEPTH_ZOOM_WHEEL_UNIT) {
        const zoomingOut = wheelAcc.current > 0;
        wheelAcc.current -= (zoomingOut ? 1 : -1) * DEPTH_ZOOM_WHEEL_UNIT;
        setZoom((z) => {
          // First scroll ever (z still null): start from the CURRENT
          // default, not `1` - zooming "out" from the default view should
          // step gently past it, not jump straight to the full range.
          const from = z ?? zoomBoundsRef.current.defaultZoom;
          const next = zoomingOut ? from * DEPTH_ZOOM_FACTOR : from / DEPTH_ZOOM_FACTOR;
          return Math.min(1, Math.max(zoomBoundsRef.current.minZoom, next));
        });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // NOT an early return, deliberately - this used to bail out of the whole
  // component before reaching the `ref={wrapRef}` div below, which meant
  // that div (and the wheel listener the effect above attaches to it) never
  // existed at all for however long `book` stayed null after mount. The
  // wheel effect runs exactly once (empty deps, same reasoning as its own
  // comment), so if THAT run found `wrapRef.current` still null - which for
  // any symbol whose book had not already been cached by another subscriber
  // was the common case, not an edge one - the listener never attached, and
  // nothing after mount ever gave it a second chance. Zoom would then work
  // only for whichever load happened to already have a cached book at mount
  // time and stay silently broken for every other one. Keeping the same
  // wrap div mounted regardless of loading state means the ref - and so the
  // listener - attaches exactly once, always, on the render that matters.
  const loading = !book;
  const empty = !loading && !bidPts.length && !askPts.length;

  const unitOf = (pt: DepthPoint) => (unit === 'quote' ? pt.quote : pt.base);
  const unitLabel = unit === 'quote' ? (sym?.quoteCoin ?? 'quote') : (sym?.baseCoin ?? 'base');
  const fmtUnit = (v: number) => (unit === 'quote' ? fmtCompact(v) : fmt(v, precisionOf(sym?.stepSize)));

  const visibleBid = bidPts.filter((pt) => pt.p >= domainLo && pt.p <= domainHi);
  const visibleAsk = askPts.filter((pt) => pt.p >= domainLo && pt.p <= domainHi);
  const maxCum = Math.max(0, ...visibleBid.map(unitOf), ...visibleAsk.map(unitOf)) || 1;
  // 8% headroom so the tallest step never touches the chart's own top edge.
  const yMax = maxCum * 1.08;

  const H = 100;
  const span = domainHi - domainLo || 1;
  const xOf = (p: number) => ((p - domainLo) / span) * 100;
  const yOf = (v: number) => H - (v / yMax) * H;

  const bidPath: [number, number][] = visibleBid.map((pt) => [pt.p, unitOf(pt)]);
  const askPath: [number, number][] = visibleAsk.map((pt) => [pt.p, unitOf(pt)]);
  // EXTEND EACH AREA'S OUTER EDGE TO THE CHART'S OWN BOUNDARY. `domainLo`/
  // `domainHi` are continuous zoom fractions, not real price levels, so the
  // nearest surviving level is almost never sitting exactly on the domain
  // edge - the filtered array's first/last point is usually a little further
  // IN, leaving a gap of bare background between the fill and the chart's
  // own side. That gap is not a real reading (there is no level between the
  // domain edge and the nearest one, which is exactly why the cumulative
  // does not change there): a step function is flat until the next level,
  // so the correct value AT the edge is whatever the nearest real point
  // already carries. This only ever touches the OUTER (worst-price) end of
  // each side - the INNER end at the touch is the real spread and stays
  // exactly where the data puts it.
  if (bidPath.length && bidPath[0]![0] > domainLo) bidPath.unshift([domainLo, bidPath[0]![1]]);
  if (askPath.length && askPath[askPath.length - 1]![0] < domainHi) {
    askPath.push([domainHi, askPath[askPath.length - 1]![1]]);
  }

  // Five evenly spaced price labels and four evenly spaced size ones - not
  // "nice" rounded numbers, deliberately: this venue's tick sizes span eight
  // orders of magnitude across its listing (see groupingSteps in
  // bookGroup.ts), so a rounding scheme tuned for one market's price scale
  // would misfire on another's. Even fractions of whatever range is
  // actually on screen are correct at every scale without a special case.
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => domainLo + f * span);
  const yTicks = [0, 1 / 3, 2 / 3, 1].map((f) => f * yMax);
  // GRIDLINES skip the 0%/100% fractions the LABELS still use - one drawn
  // exactly on the chart's own left/right edge does not read as a tick, it
  // reads as an unwanted extra border around the whole box.
  const xGridTicks = xTicks.slice(1, -1);

  const onMove = (e: React.MouseEvent) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const price = domainLo + frac * span;
    // Whichever side's step curve actually covers this price - the gap
    // between the two touches belongs to neither.
    const side: 'bid' | 'ask' | null = mid === undefined ? null : price <= mid ? 'bid' : 'ask';
    const pts = side === 'bid' ? visibleBid : side === 'ask' ? visibleAsk : [];
    if (!side || !pts.length) {
      setHover(null);
      return;
    }
    // Cumulative AT OR BETTER than the hovered price: for bids, the first
    // (leftmost, worst) point whose price is >= it; for asks, the last
    // point whose price is <= it. A plain nearest-index pick would read the
    // wrong side of a level's jump about half the time.
    let cum = unitOf(pts[side === 'bid' ? pts.length - 1 : 0]!);
    if (side === 'bid') {
      for (const pt of pts) {
        if (pt.p >= price) {
          cum = unitOf(pt);
          break;
        }
      }
    } else {
      for (let i = pts.length - 1; i >= 0; i--) {
        if (pts[i]!.p <= price) {
          cum = unitOf(pts[i]!);
          break;
        }
      }
    }
    setHover({ price, cum, side, x: e.clientX, y: r.top });
  };

  return (
    <div className="mkdepth">
      <div
        ref={wrapRef}
        className="mkdepth-chart"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        // Back to the auto-computed default (see `effectiveZoom`), not `1`
        // (full zoom-out) - a double-click "reset" should return to the
        // view the chart opens with, the same contract the candlestick
        // chart and the Order Book's own grouping reset both follow.
        onDoubleClick={() => setZoom(null)}
      >
        {loading && <div className="mkinfo-empty">Loading depth…</div>}
        {empty && <div className="mkinfo-empty">The book is empty or one-sided — nothing to chart.</div>}
        {!loading && !empty && (
          <>
            <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
              {/* Vertical, frame-relative (0%/100% of the BOX, not of each
                  column's own height) - the same choice a real depth chart's
                  fill makes: a gradient relative to each step would restart at
                  full strength on every level, reading as stripes instead of
                  one fill fading toward the baseline it is anchored to. */}
              <defs>
                <linearGradient id="mkdepth-grad-bid" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--pos)" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="var(--pos)" stopOpacity="0.03" />
                </linearGradient>
                <linearGradient id="mkdepth-grad-ask" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--neg)" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="var(--neg)" stopOpacity="0.03" />
                </linearGradient>
              </defs>
              {yTicks.map((v, i) => (
                <line key={`y${i}`} x1={0} x2={100} y1={yOf(v)} y2={yOf(v)} className="mkdepth-grid" vectorEffect="non-scaling-stroke" />
              ))}
              {xGridTicks.map((p, i) => (
                <line key={`x${i}`} x1={xOf(p)} x2={xOf(p)} y1={0} y2={H} className="mkdepth-grid" vectorEffect="non-scaling-stroke" />
              ))}
              {visibleBid.length > 1 && (
                <>
                  <path d={stepAreaD(bidPath, xOf, yOf, H)} className="mkdepth-fill bid" fill="url(#mkdepth-grad-bid)" />
                  <path d={stepLineD(bidPath, xOf, yOf)} className="mkdepth-line bid" fill="none" />
                </>
              )}
              {visibleAsk.length > 1 && (
                <>
                  <path d={stepAreaD(askPath, xOf, yOf, H)} className="mkdepth-fill ask" fill="url(#mkdepth-grad-ask)" />
                  <path d={stepLineD(askPath, xOf, yOf)} className="mkdepth-line ask" fill="none" />
                </>
              )}
              {mid !== undefined && (
                <line x1={xOf(mid)} x2={xOf(mid)} y1={0} y2={H} className="mkdepth-mid" vectorEffect="non-scaling-stroke" />
              )}
              {hover && (
                <line
                  x1={xOf(hover.price)}
                  x2={xOf(hover.price)}
                  y1={0}
                  y2={H}
                  className="mkdepth-guide"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
            {yTicks.map((v, i) => (
              <span key={i} className="mkdepth-ylabel" style={{ top: `${yOf(v)}%` }}>
                {v === 0 ? DASH : fmtUnit(v)}
              </span>
            ))}
            {xTicks.map((p, i) => (
              <span key={i} className="mkdepth-xlabel" style={{ left: `${xOf(p)}%` }}>
                {fmtPrice(p, sym?.tickSize)}
              </span>
            ))}
          </>
        )}
      </div>
      {/* Portalled, like Sparkline's tooltip in Market.tsx - the same reason:
          this sits inside the toolbar card's own clipped body, which would
          cut a tooltip off the instant it tried to float above the chart. */}
      {hover &&
        createPortal(
          <div className={`mkdepth-tip ${hover.side}`} style={{ left: hover.x, top: hover.y }}>
            <div>{fmtPrice(hover.price, sym?.tickSize)}</div>
            <div>
              {fmtUnit(hover.cum)} {unitLabel} at or better
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
