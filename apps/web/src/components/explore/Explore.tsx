/**
 * Explore.
 *
 * Two views. Markets is the landing (markets/Markets.tsx): the board's pulse,
 * the day's moves, traders to copy, the sectors and every SoDEX market in one
 * table. Cohorts is the tracked wallets' positioning. The funding page is gone
 * (owner, 2026-11-06); the funding scanner lives on as a dashboard panel. The
 * leaderboard has its own page.
 *
 * Cohorts is a chunk of its own (phone pass, 2026-11-18): the Markets landing - nearly every visit - does not load
 * it. App.tsx's loader waits for it when the URL opens on it (exploreReady), so that landing still mounts in one
 * commit; otherwise it is fetched after the page's load event (whenever this page's code is fetched) and on a
 * press of its tab, so the switch is instant.
 * Markets stays in the page's chunk: making it lazy too would put a round trip in front of the landing's first paint.
 */
import { Suspense, useEffect, useState } from 'react';
import type { Venue } from '../../vsApi';
import { openPath, scrollPageTop } from '../../nav';
import { Markets } from './markets/Markets';
import { lazyPage } from '../../lazyPage';
import { prefetchAfterLoad } from '../../afterLoad';
import { LazyWait } from '../LazyWait';
import type { Cohorts as CohortsComponent } from './cohorts/Cohorts';
import './Explore.css';

const Cohorts = lazyPage<Parameters<typeof CohortsComponent>[0]>('explore cohorts', () => import('./cohorts/Cohorts').then((m) => m.Cohorts));
/* Whenever this page's code is fetched (its landing, or the app's prefetch of other pages), Cohorts follows after the
   load event: the tab and the palette's Cohorts and Market map links then open it at once. */
if (typeof window !== 'undefined') prefetchAfterLoad(Cohorts.preload);

type ExploreView = 'overview' | 'cohorts';

const viewFromUrl = (): ExploreView => {
  const v = new URLSearchParams(window.location.search).get('view');
  return v === 'cohorts' ? v : 'overview';
};

/** App.tsx's loader for /explore waits for this: the code of the view the URL opens on is in. Never rejects. */
export const exploreReady = (): Promise<void> =>
  window.location.pathname.startsWith('/explore') && viewFromUrl() === 'cohorts' ? Cohorts.preload().catch(() => {}) : Promise.resolve();

export interface ExploreProps {
  address: string | null;
  onScan: (address: string, venue?: Venue) => void;
  onOpenCopy: (address: string, venue: Venue) => void;
  onOpenSymbol: (symbol: string) => void;
  /** The Copy page itself (Markets > Traders to copy > All traders). */
  onOpenCopyPage?: () => void;
}

const TABS: { id: ExploreView; label: string }[] = [
  { id: 'overview', label: 'Markets' },
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

export function Explore({ onOpenSymbol, onOpenCopy, onOpenCopyPage }: ExploreProps) {
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
    scrollPageTop();
  };

  return (
    <div className="vs-explore-page">
      <div className="pf ex-views">
        <div className="dash-tabs__bar">
          <div className="ex-views__tabs" role="tablist" aria-label="Explore">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={view === t.id} className={`dash-tab${view === t.id ? ' is-active' : ''}`} onPointerDown={t.id === 'cohorts' ? () => { void Cohorts.preload().catch(() => {}); } : undefined} onClick={() => setView(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {view === 'cohorts' ? (
        <div className="pf ex-cohorts">
          {/* Its code is in by now unless the tab was pressed in the first seconds of a slow load: then a wait in its place. */}
          <Suspense fallback={<LazyWait page />}>
            <Cohorts onScan={(a) => { openPath(`/scan?find=${encodeURIComponent(a)}`); }} onOpenSymbol={onOpenSymbol} />
          </Suspense>
        </div>
      ) : (
        <Markets enabled={pageVisible} onOpenSymbol={onOpenSymbol} onOpenCopy={onOpenCopy} onOpenCopyPage={onOpenCopyPage} />
      )}
    </div>
  );
}
