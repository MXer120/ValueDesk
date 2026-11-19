/**
 * What the plot shows while it has no bars to show - and the Live / Delayed
 * word in the footer. Shared by the klinecharts chart and the TradingView
 * chart; the decisions behind every state live in feedHealth.ts.
 *
 *   loading   skeleton candles and NOTHING else on screen - no label, no
 *             spinner. "Loading BTC-USD · 1m" is said to screen readers only.
 *   retrying  the same, with a "Reconnecting…" pill and a countdown
 *   error     after 3 failures: only "Chart couldn't load." and Retry
 *             (LoadFailed.tsx wording; the reason is in the console, and the
 *             automatic retries never stop while it is shown)
 *   empty     the venue answered with no candles for this interval
 *
 * `bare`: the host draws its own skeleton. The klinecharts chart does
 * (CandleMorph.tsx), because its skeleton has to sit on the chart's real slot
 * grid to morph into the loaded candles; this overlay is then see-through and
 * only keeps the pointer off the plot and carries the pill or the card. The
 * TradingView chart cannot reach its plot (an iframe), so it keeps this SVG
 * skeleton and crossfades from it.
 *
 * It does not simply vanish at 'ready': it keeps showing what it last showed
 * and fades that out (`kc-leaving`) over the chart fading in, so loading hands
 * over to the chart as a crossfade rather than a cut. Render it on every
 * frame, with the 'ready' view once there are bars; it unmounts its own mask
 * when the fade is done.
 *
 * Styles: chart.css, "feed failsafes".
 */
import { useEffect, useRef, useState } from 'react';
import type { FeedHealth } from './feedHealth';
import { couldntLoad } from '../components/LoadFailed';

export type FeedPhase = 'loading' | 'retrying' | 'error' | 'empty' | 'ready';

export interface FeedView {
  phase: FeedPhase;
  failures: number;
  nextRetryAt: number | null;
  error: string | null;
}

export const FEED_LOADING: FeedView = { phase: 'loading', failures: 0, nextRetryAt: null, error: null };

/** The mask's fade-out, as `.kc-feed-mask.kc-leaving` in chart.css states it. */
const EXIT_MS = 260;

// A seeded walk, computed once: the same skeleton on every render and every
// mount, so the placeholder never twitches.
const SKELETON = (() => {
  const out: { x: number; top: number; h: number; wTop: number; wBot: number }[] = [];
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let mid = 58;
  const N = 40;
  for (let i = 0; i < N; i++) {
    mid = Math.min(80, Math.max(20, mid + (rnd() - 0.52) * 9));
    const h = 3 + rnd() * 11;
    const top = mid - h / 2;
    out.push({ x: i * 10 + 3, top, h, wTop: top - 1 - rnd() * 5, wBot: top + h + 1 + rnd() * 5 });
  }
  return { bars: out, width: N * 10 };
})();

function SkeletonCandles() {
  return (
    <svg viewBox={`0 0 ${SKELETON.width} 100`} preserveAspectRatio="none">
      {SKELETON.bars.map((b) => (
        <g key={b.x}>
          <line x1={b.x + 2} x2={b.x + 2} y1={b.wTop} y2={b.wBot} vectorEffect="non-scaling-stroke" />
          <rect x={b.x} y={b.top} width={4} height={b.h} rx={0.5} />
        </g>
      ))}
    </svg>
  );
}

/** The candles, and a brighter copy of them in a window that glides across -
 *  see "the shimmer" in chart.css for why it is built this way. */
function Skeleton() {
  return (
    <div className="kc-skel" aria-hidden="true">
      <SkeletonCandles />
      <div className="kc-skel-glint">
        <SkeletonCandles />
      </div>
    </div>
  );
}

/** Whole seconds until `at`, re-rendered once a second while counting. */
function useCountdown(at: number | null): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (at === null) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [at]);
  return at === null ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

export interface FeedOverlayProps {
  view: FeedView;
  /** "BTC-USD · 1m" - read out while loading, shown in the empty and error cards. */
  label: string;
  onRetry?: () => void;
  /** The host draws the skeleton itself; see the header. */
  bare?: boolean;
}

interface Shown {
  view: FeedView;
  label: string;
}

export function FeedOverlay({ view, label, onRetry, bare = false }: FeedOverlayProps) {
  const ready = view.phase === 'ready';
  const secs = useCountdown(ready ? null : view.nextRetryAt);

  // The last thing shown, held so it can fade out once the bars are in. Written
  // during render on purpose: it must be the exact frame the chart replaced.
  const held = useRef<Shown | null>(null);
  if (!ready) held.current = { view, label };
  // The fade has run (or there was never anything to fade).
  const [gone, setGone] = useState(ready);
  if (!ready && gone) setGone(false);
  useEffect(() => {
    if (!ready || gone) return;
    const t = window.setTimeout(() => setGone(true), EXIT_MS + 60);
    return () => window.clearTimeout(t);
  }, [ready, gone]);

  const shown: Shown | null = ready ? (gone ? null : held.current) : { view, label };
  if (!shown || shown.view.phase === 'ready') return null;
  const leaving = ready;
  const cls = `kc-feed-mask${bare ? ' kc-bare' : ''}${leaving ? ' kc-leaving' : ''}`;
  const skeleton = bare ? null : <Skeleton />;
  const v = shown.view;

  // While a retry is out there is no countdown: say which attempt it is.
  const next = secs === null || secs <= 0 ? `attempt ${v.failures + 1}…` : `next try in ${secs}s`;

  if (v.phase === 'empty') {
    return (
      <div className={cls} role="status" aria-hidden={leaving || undefined}>
        <div className="kc-feed-card">
          <div className="kc-feed-title">No candles yet</div>
          <div className="kc-feed-detail">
            The venue has no {shown.label} bars. The chart fills in as trades arrive.
          </div>
        </div>
      </div>
    );
  }

  if (v.phase === 'error') {
    return (
      <div className={cls} role="alert" aria-hidden={leaving || undefined}>
        {skeleton}
        <div className="kc-feed-card boxed">
          <div className="kc-feed-title">{couldntLoad('Chart')}</div>
          {onRetry && (
            <div className="kc-feed-actions">
              <button type="button" className="kc-feed-retry" onClick={onRetry} disabled={leaving}>
                Retry
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cls}
      role="status"
      aria-live={leaving ? undefined : 'polite'}
      aria-busy={!leaving}
      aria-hidden={leaving || undefined}
    >
      {skeleton}
      <span className="kc-sr">Loading {shown.label}</span>
      {v.phase === 'retrying' && (
        <div className="kc-feed-pill">
          <span className="kc-spinner" aria-hidden="true" />
          Reconnecting…
          <span className="muted">{next}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Footer word: "Live" with a green dot, or "Delayed" in amber - or, while a series the chart had
 * already loaded is shown before its newest bars are in (chart/seriesCache.ts), the app's "As of"
 * line (asOf.ts) with a neutral dot, for the moment those bars take to arrive.
 */
export function FeedBadge({ health, why, asOf }: { health: FeedHealth; why: string; asOf?: string | null }) {
  if (asOf) {
    return (
      <span className="kc-feed kept" title="Candles this chart had already loaded. The newest are on their way." role="status">
        <span className="kc-feed-dot" aria-hidden="true" />
        {asOf}
      </span>
    );
  }
  return (
    <span className={`kc-feed ${health}`} title={why} role="status">
      <span className="kc-feed-dot" aria-hidden="true" />
      {health === 'live' ? 'Live' : 'Delayed'}
    </span>
  );
}
