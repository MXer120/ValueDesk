/**
 * Copy trading.
 *
 *   Discover    the trader grid (Discover.tsx): hero, categories, filters, cards
 *   Trader      one trader (?address=&venue=): profile, a replay under your
 *               rules, their open positions, and Copy
 *   My copies   every copy of this wallet in every mode, their activity
 *
 * "Copy" opens the two-step setup (CopyModal.tsx) over whatever is on screen;
 * "Start copying" there starts the copy in the mode chosen, once that mode's
 * steps are the follower's own signatures (copy/CopySetupSheet.tsx).
 *
 * One context hook (useCopy.ts) owns every fetch and the setup form; the
 * trader and My copies views reuse the dashboard panels (panels.tsx) inside
 * the portfolio's `pf` design-system scope.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CopySetupSheet } from '../../copy/CopySetupSheet';
import { copyRows, startCopy } from '../../copy/live';
import { notify } from '../../toast';
import type { TraderRow, Venue } from '../../vsApi';
import { BacktestPanel, CopiesPanel, PositionsPanel, TraderHero } from './panels';
import { CopyModal } from './CopyModal';
import { Discover } from './Discover';
import { holdPeeks } from './TraderCard';
import { useCopyContext, type CopyPageProps } from './useCopy';
import './Copy.css';
import './CopyHome.css';

export type { CopyPageProps } from './useCopy';

type Page = 'discover' | 'trader' | 'mine';

const pageFromUrl = (): Page => {
  const p = new URLSearchParams(window.location.search);
  if (p.get('tab') === 'mine') return 'mine';
  return p.get('address') ? 'trader' : 'discover';
};

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

  /* A trader's page reads their fills for the replay: the grid's card reads wait meanwhile. */
  useEffect(() => (page === 'trader' ? holdPeeks() : undefined), [page]);

  /* Back and forward move between the grid and a trader, like links. */
  useEffect(() => {
    const onPop = () => setPage(pageFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((p: Page) => {
    setPage(p);
    if (p === 'discover') c.selectLeader(null);
    if (p === 'mine') window.history.replaceState(null, '', '/copy?tab=mine');
    window.scrollTo({ top: 0 });
  }, [c]);

  const openTrader = useCallback((row: Pick<TraderRow, 'address' | 'venue'>) => {
    window.history.pushState(null, '', `/copy?address=${row.address.toLowerCase()}&venue=${row.venue}`);
    c.selectLeader(row.address, row.venue);
    setPage('trader');
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
      ) : page === 'trader' && c.leader ? (
        <TraderView c={c} onBack={() => { window.history.pushState(null, '', '/copy'); go('discover'); }} onCopy={(d) => copyTrader(d, null, c.leader!, c.venue)} copying={copying.has(`${c.venue}:${c.leader}`)} />
      ) : (
        <Discover
          onOpen={openTrader}
          onCopy={(row, d) => copyTrader(d, row)}
          copying={copying}
          onAddress={(address, venue) => openTrader({ address, venue })}
          onScan={(row) => c.onScan(row.address, row.venue)}
        />
      )}

      <CopyModal
        c={c}
        open={modal.open}
        row={modal.row}
        onClose={() => setModal({ open: false, row: null })}
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

/** One trader: the hero (who, the buttons, the figures, the curve), then the replay and what they hold. */
function TraderView({ c, onBack, onCopy, copying }: { c: ReturnType<typeof useCopyContext>; onBack: () => void; onCopy: (direction: 'copy' | 'counter') => void; copying: boolean }) {
  return (
    <div className="cpy-trader">
      <TraderHero c={c} onBack={onBack} onCopy={onCopy} copying={copying} />
      <div className="pf copy cpy-trader__main">
        <BacktestPanel c={c} />
        <PositionsPanel c={c} />
      </div>
    </div>
  );
}
