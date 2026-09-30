/**
 * The order book's two inline recordings - the spread (mid row) and the
 * buy/sell share (ratio row) - and the recorder that feeds them.
 *
 * DRAWN, not a charting library: a chart the width of a few words and the
 * height of a table row needs a line and nothing else.
 *
 * STABLE BY CONSTRUCTION (see sparkSampler.ts for the full argument):
 *  - points are kept in DATA coordinates - x is the sample's ABSOLUTE index,
 *    y its value - and decimation buckets are aligned to that index, so the
 *    `points` text of everything already drawn never changes; new samples
 *    append on the right, aged-off ones drop on the left;
 *  - the x scroll is a translate of the whole line, one slot per sample;
 *  - the y-scale is a band that moves only when a value leaves it or it has
 *    gone loose, applied as ONE transform over the whole line and eased by
 *    CSS - a rare, smooth rescale, never a reshaping;
 *  - only the newest point (the live, still-averaging second) moves.
 *
 * X-POSITIONS ARE SLOTS OF A FIXED `capacity`-WIDE TRACK, ANCHORED TO THE
 * RIGHT EDGE, as before: a fresh recording is a short run hard against the
 * right edge with blank track to its left, not three samples stretched across
 * the whole box.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { logger } from '../../log';
import {
  bucketSizeFor,
  extentOf,
  nextBand,
  pointsAttr,
  stablePoints,
  type Band,
  type BandOptions,
  type Recording,
  type SparkPoint,
} from './sparkSampler';

const log = logger('book');

/** Never draw two vertices closer than this, in CSS px. */
export const MIN_PX_PER_POINT = 2;

/**
 * An ALWAYS-ON, capacity-bounded rolling average of `value`, one closed sample
 * per `bucketMs`, with the running average of the current bucket as a live tip
 * in between - the same contract as the recorder it replaces (the bucket
 * boundary is a real clock, a steady reading still records, a bucket with no
 * fresh push falls back to the latest reading), plus the ABSOLUTE index of
 * every sample, which is what lets the chart keep drawn points fixed.
 */
export function useSampleRecorder(
  value: number | null,
  capacity: number,
  /** The market the samples belong to: a new key starts a new recording. */
  key: string,
  bucketMs = 1000,
): Recording {
  const [closed, setClosed] = useState<{ key: string; history: number[]; times: number[]; start: number; gen: number }>(
    () => ({ key, history: [], times: [], start: 0, gen: 0 }),
  );
  const [live, setLive] = useState<number | null>(null);
  const bucket = useRef({ sum: 0, count: 0 });
  const latest = useRef<number | null>(value);
  latest.current = value;

  /*
   * A NEW `key` (a new market) IS A NEW RECORDING FROM ITS FIRST RENDER. A
   * reset in a passive effect left one render - painted - in which the new
   * market's chart and precision were computed from the OLD market's minute:
   * an open chart drew the previous symbol's line, and the bps readout took its
   * decimals from the previous symbol's spread (BTC's 0.119 held DOGE at three
   * places). So a stale recording is reported empty in that very render, and
   * the state is cleared in a layout effect, before anything is painted.
   */
  const stale = closed.key !== key;
  useLayoutEffect(() => {
    if (!stale) return;
    bucket.current = { sum: 0, count: 0 };
    setLive(null);
    setClosed((prev) => (prev.key === key ? prev : { key, history: [], times: [], start: 0, gen: prev.gen + 1 }));
  }, [stale, key]);

  useEffect(() => {
    if (value === null) return;
    bucket.current.sum += value;
    bucket.current.count += 1;
    setLive(bucket.current.sum / bucket.current.count);
  }, [value]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (bucket.current.count === 0 && latest.current !== null) {
        bucket.current.sum = latest.current;
        bucket.current.count = 1;
      }
      const { sum, count } = bucket.current;
      bucket.current = { sum: 0, count: 0 };
      // Batched with the append below: the live tip becomes the closed sample
      // at the SAME index, with the same value, in one render.
      setLive(null);
      if (count === 0) return;
      const v = sum / count;
      const at = Date.now();
      setClosed((prev) => {
        const history = [...prev.history, v];
        const times = [...prev.times, at];
        const drop = Math.max(0, history.length - capacity);
        return {
          key: prev.key,
          history: drop ? history.slice(drop) : history,
          times: drop ? times.slice(drop) : times,
          start: prev.start + drop,
          gen: prev.gen,
        };
      });
    }, bucketMs);
    return () => clearInterval(id);
  }, [bucketMs, capacity]);

  return useMemo(
    () =>
      stale
        ? { history: NO_SAMPLES, times: NO_SAMPLES, start: 0, gen: closed.gen + 1, live: null }
        : { history: closed.history, times: closed.times, start: closed.start, gen: closed.gen, live },
    [stale, closed, live],
  );
}

const NO_SAMPLES: readonly number[] = [];

/** The hovered sample's close time, HH:MM:SS (24h, locale-stable), or "live" for the running sample. */
function timeOf(rec: Recording, i: number): string {
  const t = rec.times?.[i - rec.start];
  if (i >= rec.start + rec.history.length || t === undefined) return 'live';
  return new Date(t).toLocaleTimeString('en-GB', { hour12: false });
}

export interface SparkLineSpec {
  color: string;
  label: string;
  /** Applied to each sample before bucketing - e.g. the sell share is `100 - bid`. */
  map?: (v: number) => number;
}

export function Sparkline({
  rec,
  lines,
  capacity,
  band: bandOpts,
  height = 24,
  empty,
  className = '',
  valueLabel,
}: {
  rec: Recording;
  lines: SparkLineSpec[];
  /** The recorder's window, in samples: the fixed track every sample is slotted into. */
  capacity: number;
  /** How the y-band may move - see sparkSampler.ts. */
  band: BandOptions;
  height?: number;
  empty?: string;
  className?: string;
  /** Formats a value for the hover tooltip ("0.119 bps", "51.30%"). */
  valueLabel: (v: number) => string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // Measured, not assumed; defaults to "wide enough never to decimate" so the
  // first frame is not coarser than it needs to be.
  const [pxWidth, setPxWidth] = useState(capacity * MIN_PX_PER_POINT);
  /** Pointer position while scrubbing: a FRACTION of the box, so the guide stays under the pointer as the chart scrolls. */
  const [scrub, setScrub] = useState<{ frac: number; x: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setPxWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const s = bucketSizeFor(capacity, pxWidth, MIN_PX_PER_POINT);
  // The band in use belongs to one series: a reset (`gen`) starts a fresh one.
  const bandRef = useRef<{ gen: number; band: Band | null }>({ gen: rec.gen, band: null });
  const prevBand = bandRef.current.gen === rec.gen ? bandRef.current.band : null;
  // Guarded: a chart that cannot be drawn says so in the log and shows its
  // empty state, rather than taking the whole order book down with it.
  let pts: SparkPoint[][] = [];
  let band: Band | null = prevBand;
  try {
    pts = lines.map((l) => stablePoints(rec, s, l.map));
    const ext = extentOf(pts);
    if (ext) band = nextBand(prevBand, ext.lo, ext.hi, bandOpts);
  } catch (e) {
    log.error('inline chart could not be drawn', { chart: className, samples: rec.history.length, error: e });
    pts = [];
  }
  const n = Math.max(0, ...pts.map((p) => p.length));
  useLayoutEffect(() => {
    bandRef.current = { gen: rec.gen, band };
  });

  if (n < 2 || !band) {
    return (
      <div ref={wrapRef} className={`mkt-spark mkt-spark--empty ${className}`} style={{ height }}>
        {empty}
      </div>
    );
  }

  // The newest drawn index sits on the right edge; the track runs `capacity`
  // slots back from it.
  const newest = Math.max(...pts.map((p) => (p.length ? p[p.length - 1]!.i : -Infinity)));
  const x0 = newest - (capacity - 1);
  const sy = height / Math.max(1e-12, band.hi - band.lo);
  const ref = pts.find((p) => p.length === n) ?? pts[0]!;

  // Nearest DRAWN point to the pointer, on the visible track.
  let hover: number | null = null;
  if (scrub) {
    const want = x0 + scrub.frac * (capacity - 1);
    const first = ref[0]!;
    if (want >= first.i - s / 2) {
      let best = first;
      for (const p of ref) if (Math.abs(p.i - want) < Math.abs(best.i - want)) best = p;
      hover = best.i;
    }
  }

  const onMove = (e: React.MouseEvent) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
    // Pinned to the box's own top edge, not the pointer's Y: a 20-26px chart
    // would make a Y-tracking tooltip jitter by its whole height.
    setScrub({ frac, x: e.clientX, top: r.top });
  };
  const onLeave = () => setScrub(null);

  return (
    <div
      ref={wrapRef}
      className={`mkt-spark ${className}`}
      style={{ height }}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      data-spark-bucket={s}
    >
      <svg viewBox={`0 0 ${capacity - 1} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {/* x: slide the absolute-index track so `newest` lands on the right
            edge. y: flip once here, so the eased scale below stays positive. */}
        <g transform={`translate(${-x0} ${height}) scale(1 -1)`}>
          {/* THE BAND, as one eased transform over points kept in data
              coordinates: y = sy * (v - lo). Keyed by the series, so a reset
              starts at its new scale instead of animating from the old one. */}
          <g
            key={rec.gen}
            className="mkt-spark-scale"
            style={{ transform: `translate(0px, ${(-sy * band.lo).toFixed(4)}px) scale(1, ${sy.toFixed(6)})` }}
          >
            {lines.map((l, k) => (
              // vector-effect keeps the stroke a constant SCREEN width through
              // the stretched viewBox and both transforms.
              <polyline
                key={k}
                points={pointsAttr(pts[k]!)}
                fill="none"
                stroke={l.color}
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        </g>
        {/* A subtle guide at the hovered sample, the weight of the panel's own dividers. */}
        {hover !== null && (
          <line
            x1={hover - x0}
            x2={hover - x0}
            y1={0}
            y2={height}
            stroke="var(--line)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {/* PORTALLED: the chart sits inside `overflow: hidden` ancestors that
          would clip a tooltip floating above a 20-26px box. */}
      {hover !== null &&
        scrub &&
        createPortal(
          <div className="mkt-spark-tip" style={{ left: scrub.x, top: scrub.top }}>
            {/* WHEN: the time the hovered sample closed - for a bucket, its
                last sample - or "live" for the still-averaging newest one. */}
            <div className="mkt-spark-tip-t">{timeOf(rec, hover)}</div>
            {lines.map((l, k) => {
              const p = pts[k]!.find((q) => q.i === hover);
              return p ? (
                <div key={k} style={{ color: l.color }}>
                  {l.label} {valueLabel(p.v)}
                </div>
              ) : null;
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
