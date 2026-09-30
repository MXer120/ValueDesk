/**
 * The chart switch: klinecharts (today's chart) or TradingView Advanced Charts.
 *
 * With VITE_CHART unset - the default - `withTradingView(Chart)` returns
 * `Chart` ITSELF. Not a wrapper that renders it: the same function, so the
 * default build has no extra component, no probe, no request and no state.
 *
 * With VITE_CHART=tradingview the returned component:
 *   1. probes /charting_library/ once per page (loader.ts),
 *   2. renders TvChart when the library is there,
 *   3. renders the klinecharts chart when it is not, when TvChart reports a
 *      failure, or when it throws - and remembers that for the page, so the
 *      second chart instance (the mobile carousel mounts one too) goes
 *      straight to klinecharts instead of failing the same way again.
 */
import { Component, lazy, Suspense, useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import type { ChartProps } from '../../components/Chart';
import { FEED_LOADING, FeedOverlay } from '../FeedOverlay';
import { TV_ENABLED } from './flag';
import { loadTradingView, peekTradingView } from './loader';
import { logger } from '../../log';

const log = logger('chart.tv');

const TvChart = lazy(() => import('./TvChart').then((m) => ({ default: m.TvChart })));

/** Why TradingView is not in use this page load, once decided. */
let brokenReason: string | null = null;
function markBroken(reason: string): void {
  if (brokenReason === null) {
    brokenReason = reason;
    log.warn('VITE_CHART=tradingview, using the klinecharts chart instead (see apps/web/docs/TRADINGVIEW.md)', { reason });
  }
}

type Mode = 'probe' | 'tv' | 'kline';

function initialMode(): Mode {
  if (brokenReason !== null) return 'kline';
  const r = peekTradingView();
  if (!r) return 'probe';
  return r.ok ? 'tv' : 'kline';
}

class TvBoundary extends Component<{ onError: (reason: string) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: Error): void {
    this.props.onError(`TradingView chart crashed: ${error.message}`);
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** While the library is probed and its chunk loads: the same skeleton the
 *  charts show while their first bars load, never an empty card. */
function Waiting({ label }: { label: string }) {
  return (
    <section className="panel chart kc-panel tv-panel" aria-busy="true">
      <div className="tv-stage">
        <FeedOverlay view={FEED_LOADING} label={label} />
      </div>
    </section>
  );
}

export function withTradingView(Fallback: ComponentType<ChartProps>): ComponentType<ChartProps> {
  if (!TV_ENABLED) return Fallback;
  // Only now: with the flag off not even this stylesheet reaches the page.
  void import('./tv.css');

  function ChartSwitch(props: ChartProps) {
    const [mode, setMode] = useState<Mode>(initialMode);

    useEffect(() => {
      if (mode !== 'probe') return;
      let live = true;
      void loadTradingView().then((r) => {
        if (!live) return;
        if (!r.ok) markBroken(r.reason);
        setMode(r.ok ? 'tv' : 'kline');
      });
      return () => {
        live = false;
      };
    }, [mode]);

    const fail = useCallback((reason: string) => {
      markBroken(reason);
      setMode('kline');
    }, []);

    if (mode === 'kline') return <Fallback {...props} />;
    if (mode === 'probe') return <Waiting label={props.symbol} />;
    return (
      <TvBoundary onError={fail}>
        <Suspense fallback={<Waiting label={props.symbol} />}>
          <TvChart {...props} onFail={fail} />
        </Suspense>
      </TvBoundary>
    );
  }
  return ChartSwitch;
}
