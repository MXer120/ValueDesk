/**
 * Explore.
 *
 * Three views. Markets is the landing (markets/Markets.tsx): the board's
 * pulse, a featured market and its chart, the day's heatmap, the sectors, the
 * funding spreads and every market in one table. Funding is the full spread
 * scanner; Cohorts is the tracked wallets' positioning. The leaderboard has its
 * own page.
 */
import { useEffect, useState } from 'react';
import type { Venue } from '../../vsApi';
import { FundingScanner } from './FundingScanner';
import { Cohorts } from './cohorts/Cohorts';
import { Markets } from './markets/Markets';
import './Explore.css';

type ExploreView = 'overview' | 'funding' | 'cohorts';

const viewFromUrl = (): ExploreView => {
  const v = new URLSearchParams(window.location.search).get('view');
  return v === 'funding' || v === 'cohorts' ? v : 'overview';
};

export interface ExploreProps {
  address: string | null;
  onScan: (address: string, venue?: Venue) => void;
  onOpenCopy: (address: string, venue: Venue) => void;
  onOpenSymbol: (symbol: string) => void;
}

const TABS: { id: ExploreView; label: string }[] = [
  { id: 'overview', label: 'Markets' },
  { id: 'funding', label: 'Funding' },
  { id: 'cohorts', label: 'Cohorts' },
];

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

export function Explore({ onOpenSymbol }: ExploreProps) {
  const pageVisible = usePageVisible();
  const [view, setViewState] = useState<ExploreView>(viewFromUrl);
  useEffect(() => {
    const onPop = () => setViewState(viewFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const setView = (v: ExploreView) => {
    if (v === view) return;
    setViewState(v);
    window.history.pushState(null, '', v === 'overview' ? '/explore' : `/explore?view=${v}`);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="vs-explore-page">
      <div className="pf ex-views">
        <div className="dash-tabs__bar">
          <div className="ex-views__tabs" role="tablist" aria-label="Explore">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={view === t.id} className={`dash-tab${view === t.id ? ' is-active' : ''}`} onClick={() => setView(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {view === 'cohorts' ? (
        <div className="pf ex-cohorts">
          <Cohorts onScan={(a) => { window.location.href = `/scan?find=${encodeURIComponent(a)}`; }} />
        </div>
      ) : view === 'funding' ? (
        <div className="ex-desk">
          <FundingScanner enabled={pageVisible} mode="full" onOpenSymbol={onOpenSymbol} />
        </div>
      ) : (
        <Markets enabled={pageVisible} onOpenSymbol={onOpenSymbol} onOpenScanner={() => setView('funding')} />
      )}
    </div>
  );
}
