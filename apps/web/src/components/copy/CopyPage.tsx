/**
 * Copy trading.
 *
 *   Discover    the trader grid (Discover.tsx): hero, categories, filters, cards
 *   My copies   every copy of this wallet in every mode, their activity
 *
 * A trader opens on the Scan page, the app's one trader page (as a trader
 * opens on Hyperdash's address page): its header has Copy and Counter-trade,
 * which come back here as /copy?address=&venue=&direction= and open the setup.
 *
 * "Copy" opens the two-step setup (CopyModal.tsx) over whatever is on screen;
 * "Start copying" there starts the copy in the mode chosen, once that mode's
 * steps are the follower's own signatures (copy/CopySetupSheet.tsx).
 *
 * One context hook (useCopy.ts) owns every fetch and the setup form; My copies
 * reuses the dashboard panels (panels.tsx) inside the portfolio's `pf` scope.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CopySetupSheet } from '../../copy/CopySetupSheet';
import { copyRows, startCopy } from '../../copy/live';
import { notify } from '../../toast';
import type { TraderRow, Venue } from '../../vsApi';
import { CopiesPanel } from './panels';
import { CopyModal } from './CopyModal';
import { Discover } from './Discover';
import { isCopyable } from './gridModel';
import { useCopyContext, type CopyPageProps } from './useCopy';
import './Copy.css';
import './CopyHome.css';

export type { CopyPageProps } from './useCopy';

type Page = 'discover' | 'mine';

const pageFromUrl = (): Page => (new URLSearchParams(window.location.search).get('tab') === 'mine' ? 'mine' : 'discover');

/** /copy?address=&venue=&direction=: the setup to open for that trader (from Scan, Explore, the Leaderboard). */
function setupFromUrl(): { address: string; venue: Venue; direction: 'copy' | 'counter' } | null {
  const p = new URLSearchParams(window.location.search);
  const address = p.get('address');
  const venue = p.get('venue') as Venue | null;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || !venue || !isCopyable(venue)) return null;
  return { address: address.toLowerCase(), venue, direction: p.get('direction') === 'counter' ? 'counter' : 'copy' };
}

export function CopyPage(props: CopyPageProps) {
  const c = useCopyContext(props);
  const [page, setPage] = useState<Page>(pageFromUrl);
  const [modal, setModal] = useState<{ open: boolean; row: TraderRow | null }>({ open: false, row: null });
  const settings = c.copySettings;

  const rows = copyRows(c.live);
  const running = rows.filter((r) => r.view.subscription.status !== 'stopped');
  const copying = useMemo(
    () => new Set(running.map((r) => `${r.view.subscription.settings.leader.venue}:${r.view.subscription.settings.leader.address.toLowerCase()}`)),
    [running],
  );

  useEffect(() => {
    const onPop = () => setPage(pageFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((p: Page) => {
    setPage(p);
    if (p === 'discover') c.selectLeader(null);
    window.history.replaceState(null, '', p === 'mine' ? '/copy?tab=mine' : '/copy');
    window.scrollTo({ top: 0 });
  }, [c]);

  /** Open the copy setup for a trader, in the direction the button said (Copy or Counter). */
  const copyTrader = useCallback((direction: 'copy' | 'counter', row: TraderRow | null, address?: string, venue?: Venue) => {
    const a = row?.address ?? address;
    if (!a) return;
    if (c.setup.direction !== direction) c.patchSetup({ direction });
    c.selectLeader(a, row?.venue ?? venue);
    setModal({ open: true, row });
  }, [c]);

  /* Arrived with a trader in the link (Scan's Copy / Counter-trade): their setup, over the grid. */
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const t = setupFromUrl();
    if (t) copyTrader(t.direction, null, t.address, t.venue);
  }, [copyTrader]);

  /** A trader opens on Scan: the universal trader page. */
  const openTrader = useCallback((row: Pick<TraderRow, 'address' | 'venue'>) => c.onScan(row.address, row.venue), [c]);

  return (
    <div className="cpy">
      <div className="cpy-tabs" role="tablist" aria-label="Copy trading">
        <button type="button" role="tab" aria-selected={page !== 'mine'} className={page !== 'mine' ? 'is-on' : undefined} onClick={() => go('discover')}>
          Discover
        </button>
        <button type="button" role="tab" aria-selected={page === 'mine'} className={page === 'mine' ? 'is-on' : undefined} onClick={() => go('mine')}>
          My copies{running.length ? <span className="cpy-tabs__n">{running.length}</span> : null}
        </button>
        <span className="cpy-tabs__fill" />
        <button type="button" className="cpy-chip" onClick={() => c.openSetup(false)} title="Where copies run, and the signatures each mode needs">
          Copy setup
        </button>
      </div>

      {page === 'mine' ? (
        <div className="pf copy cpy-mine">
          <CopiesPanel c={c} />
          {rows.length === 0 && (
            <div className="cpy-empty">
              <p>{c.wallet ? 'No copies yet.' : 'Connect a wallet to see your copies.'}</p>
              <button type="button" className="cpy-copybtn" onClick={() => go('discover')}>Find a trader</button>
            </div>
          )}
        </div>
      ) : (
        <Discover
          onOpen={openTrader}
          onCopy={(row, d) => copyTrader(d, row)}
          copying={copying}
          onAddress={(address, venue) => openTrader({ address, venue })}
          onScan={openTrader}
        />
      )}

      <CopyModal
        c={c}
        open={modal.open}
        row={modal.row}
        onClose={() => { setModal({ open: false, row: null }); if (window.location.search.includes('address=')) window.history.replaceState(null, '', '/copy'); }}
        onStarted={() => go('mine')}
      />
      <CopySetupSheet
        open={c.setupOpen}
        onClose={c.closeSetup}
        mode={c.runOn}
        onMode={c.setRunOn}
        live={c.live}
        paper={c.setup.paper}
        onStart={
          c.setupStarts && settings
            ? async () => {
                await startCopy(c.runOn, settings);
                notify('ok', settings.paper ? 'Paper copy started.' : 'Copying started.');
              }
            : undefined
        }
        startLabel={c.setup.paper ? 'Start paper copy' : 'Start copying'}
      />
    </div>
  );
}
