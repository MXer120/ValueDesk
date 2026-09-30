/**
 * The order book's inline charts (spread, buy/sell share), reduced to what gets
 * DRAWN - pure and DOM-free:  npx tsx --test src/components/orderbook/sparkSampler.test.ts
 *
 * THE CONTRACT: A POINT, ONCE DRAWN AS FINAL, NEVER CHANGES - neither which
 * samples it stands for, nor its value, nor its place on the time axis. Only
 * the newest point (the live, still-accumulating second) moves.
 *
 * The chart this replaces broke that twice over:
 *
 *  1. DECIMATION BY CURRENT COUNT. It drew `round(k * (n-1)/(maxPts-1))` - a
 *     stride that depends on how many samples exist NOW - so every new sample
 *     re-picked which historical samples got a vertex, and the drawn history
 *     reshaped itself once a second.
 *  2. A Y-SCALE FITTED TO EVERY FRAME. min/max of the window + 10% pad,
 *     recomputed on every render: each new extreme, each extreme ageing off the
 *     back of the window, and each wobble of the live tip re-stretched the whole
 *     line vertically.
 *
 * HERE:
 *
 *  - Samples carry an ABSOLUTE index (seconds since the recording started), and
 *    decimation buckets are aligned to it: bucket b covers [b*s, (b+1)*s), with
 *    s a power of two chosen from the chart's measured width and the recorder's
 *    fixed capacity - never from the current count. A complete bucket is drawn
 *    once, at its last index, as the mean of its s samples, and never again
 *    differently. The newest, incomplete bucket is the live point. A bucket
 *    whose first sample has already aged off the window is dropped whole rather
 *    than re-averaged over what is left. s only changes when the chart's WIDTH
 *    crosses a power of two - a resize, not a tick.
 *  - The y-band (`nextBand`) moves only when it has to: when a drawn value
 *    leaves it (it is refitted around the data with 25% headroom a side), or
 *    when it has become more than 2.5x looser than a fresh fit (a spike has
 *    aged off). Otherwise it is returned unchanged, and the renderer applies it
 *    as a transform over points kept in DATA coordinates - so between two band
 *    moves nothing about a drawn point changes at all, and a band move is one
 *    eased affine rescale of the whole line, never a reshaping of it.
 */

/** A rolling recording: closed samples plus the live, still-accumulating one. */
export interface Recording {
  /** Closed samples, oldest first. */
  history: readonly number[];
  /** Absolute index of `history[0]`. The live sample's index is `start + history.length`. */
  start: number;
  /** The in-progress sample's running value, or null between samples. */
  live: number | null;
  /** Wall-clock ms at which each closed sample closed, parallel to `history` (the tooltip's time). */
  times?: readonly number[];
  /** Bumped by every reset, so a consumer can drop state (its y-band) that belonged to the old series. */
  gen: number;
}

export interface SparkPoint {
  /** Absolute sample index the point is drawn at (a bucket's last index). */
  i: number;
  v: number;
  /** False only for the newest bucket - the one still accumulating. */
  final: boolean;
}

/**
 * The decimation bucket size: the smallest power of two `s` with
 * `ceil(capacity / s) <= floor(pxWidth / minPxPerPoint)`, i.e. a full window
 * never draws two vertices closer than `minPxPerPoint`. 1 whenever every sample
 * fits - the common case at desktop widths.
 */
export function bucketSizeFor(capacity: number, pxWidth: number, minPxPerPoint: number): number {
  const maxPts = Math.max(2, Math.floor(pxWidth / Math.max(0.5, minPxPerPoint)));
  let s = 1;
  while (Math.ceil(capacity / s) > maxPts && s < 1 << 20) s *= 2;
  return s;
}

/**
 * The points to draw for one line of `rec`, bucketed by `s` (a power of two).
 * `map` transforms each sample BEFORE averaging (the sell line is `100 - bid`);
 * pass it here rather than mapping the output so a bucket's value is the mean
 * of the mapped samples, exactly as the line it is paired with.
 */
export function stablePoints(rec: Recording, s: number, map?: (v: number) => number): SparkPoint[] {
  const out: SparkPoint[] = [];
  const f = map ?? ((v: number) => v);
  const n = rec.history.length;
  const lastClosed = rec.start + n - 1;
  const hasLive = rec.live !== null && Number.isFinite(rec.live);
  const newest = hasLive ? lastClosed + 1 : lastClosed;
  if (newest < rec.start) return out;
  const at = (i: number): number => (i <= lastClosed ? f(rec.history[i - rec.start]!) : f(rec.live!));
  if (s <= 1) {
    for (let i = rec.start; i <= lastClosed; i++) out.push({ i, v: at(i), final: true });
    if (hasLive) out.push({ i: newest, v: at(newest), final: false });
    return out;
  }
  // First bucket wholly inside the window; a partially aged-off one is dropped whole.
  let b = Math.ceil(rec.start / s);
  for (; b * s <= newest; b++) {
    const first = b * s;
    const last = Math.min(first + s - 1, newest);
    let sum = 0;
    for (let i = first; i <= last; i++) sum += at(i);
    const complete = first + s - 1 <= lastClosed;
    out.push({ i: last, v: sum / (last - first + 1), final: complete });
  }
  return out;
}

// --- the y-band ----------------------------------------------------------------

export interface Band {
  lo: number;
  hi: number;
}

export interface BandOptions {
  /** Headroom added above and below the data on a (re)fit, as a fraction of the data's span. */
  pad: number;
  /** The narrowest band there can be - a flat or near-flat series is drawn flat, not magnified. */
  minSpan: number;
  /** Refit (shrink) once the band is this many times wider than a fresh fit would be. */
  loose: number;
  /** Hard bounds the band never extends past (0 for a spread, 0/100 for a share). */
  floor?: number;
  ceil?: number;
}

/** A fresh fit around [lo, hi]: centred, padded, never narrower than minSpan, kept inside floor/ceil. */
export function fitBand(lo: number, hi: number, o: BandOptions): Band {
  const dataSpan = Math.max(0, hi - lo);
  let span = Math.max(dataSpan * (1 + 2 * o.pad), o.minSpan, 1e-12);
  if (o.floor !== undefined && o.ceil !== undefined) span = Math.min(span, o.ceil - o.floor);
  const c = (lo + hi) / 2;
  let blo = c - span / 2;
  let bhi = c + span / 2;
  if (o.floor !== undefined && blo < o.floor) {
    bhi += o.floor - blo;
    blo = o.floor;
  }
  if (o.ceil !== undefined && bhi > o.ceil) {
    blo -= bhi - o.ceil;
    bhi = o.ceil;
    if (o.floor !== undefined && blo < o.floor) blo = o.floor;
  }
  return { lo: blo, hi: bhi };
}

/**
 * The band to draw with, given the band in use and the drawn data's extent.
 * Returns `prev` ITSELF (same object) whenever it still serves, so callers can
 * tell "no move" by identity.
 */
export function nextBand(prev: Band | null, dataLo: number, dataHi: number, o: BandOptions): Band | null {
  if (!Number.isFinite(dataLo) || !Number.isFinite(dataHi) || dataHi < dataLo) return prev;
  if (!prev) return fitBand(dataLo, dataHi, o);
  const outside = dataLo < prev.lo || dataHi > prev.hi;
  if (outside) return fitBand(dataLo, dataHi, o);
  const fresh = fitBand(dataLo, dataHi, o);
  const tooLoose = prev.hi - prev.lo > o.loose * (fresh.hi - fresh.lo);
  return tooLoose ? fresh : prev;
}

/** Extent of every point's value across all lines. */
export function extentOf(lines: readonly (readonly SparkPoint[])[]): { lo: number; hi: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const l of lines) {
    for (const p of l) {
      if (!Number.isFinite(p.v)) continue;
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
  }
  return lo === Infinity ? null : { lo, hi };
}

/**
 * The SVG `points` attribute for a line, in DATA coordinates (x = absolute
 * index, y = value). Deterministic: the same point always prints the same
 * characters, so a final point's text in this string never changes either.
 */
export function pointsAttr(points: readonly SparkPoint[]): string {
  let s = '';
  for (const p of points) s += `${s ? ' ' : ''}${p.i},${+p.v.toPrecision(10)}`;
  return s;
}
