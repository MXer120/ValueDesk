/**
 * Explore.
 *
 * One page, two readings, then Cohorts on its own view. The landing is the
 * funding scanner's short list and the leaderboard under it. The scanner
 * itself is the Funding view. This is not a grid of cards.
 */
import { useEffect, useState } from 'react';
import type { Venue } from '../../vsApi';
import { LeaderboardPage } from '../leaderboard/LeaderboardPage';
import { FundingScanner } from './FundingScanner';
import { Cohorts } from './cohorts/Cohorts';
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

export function Explore({ address, onScan, onOpenCopy, onOpenSymbol }: ExploreProps) {
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
      ) : (
        <div className="ex-desk">
          <FundingScanner
            enabled={pageVisible}
            mode={view === 'funding' ? 'full' : 'compact'}
            onOpenSymbol={onOpenSymbol}
            onOpenScanner={() => setView('funding')}
          />
          {view === 'overview' && <LeaderboardPage address={address} onScan={onScan} onOpenCopy={onOpenCopy} />}
        </div>
      )}
    </div>
  );
}
