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
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { CopySetupSheet } from '../../copy/CopySetupSheet';
import { copyRows, startCopy } from '../../copy/live';
import { notify } from '../../toast';
import { shortAddr } from '../../format';
import { VENUE_BRAND } from '../venueBrand';
import { VENUE_LABEL, type TraderRow, type Venue } from '../../vsApi';
import { BacktestPanel, CopiesPanel, PositionsPanel, TraderPanel } from './panels';
import { CopyModal } from './CopyModal';
import { Discover } from './Discover';
import { Avatar, CopyButton, holdPeeks } from './TraderCard';
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

function TraderView({ c, onBack, onCopy, copying }: { c: ReturnType<typeof useCopyContext>; onBack: () => void; onCopy: (direction: 'copy' | 'counter') => void; copying: boolean }) {
  const leader = c.leader!;
  return (
    <div className="cpy-trader">
      <header className="cpy-trader__head">
        <button type="button" className="cpy-back" onClick={onBack} aria-label="Back to all traders">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          All traders
        </button>
        <div className="cpy-trader__who">
          <Avatar address={leader} size={40} />
          <div>
            <h1 className="cpy-trader__addr" title={leader}>{shortAddr(leader)}</h1>
            <span className="cpy-venue" style={{ '--venue': VENUE_BRAND[c.venue] } as CSSProperties}>{VENUE_LABEL[c.venue]}</span>
          </div>
        </div>
        <span className="cpy-tabs__fill" />
        <button type="button" className="cpy-chip" onClick={() => c.onScan(leader, c.venue)} title="Open this trader in Scan">Open in Scan</button>
        <CopyButton kind="counter" size="lg" label="Counter-trade" title="Take the other side of every trade" onClick={() => onCopy('counter')} />
        <CopyButton kind="copy" size="lg" copying={copying} label={copying ? 'Copying · add another' : 'Copy this trader'} onClick={() => onCopy('copy')} />
      </header>
      <div className="pf copy cpy-trader__grid">
        <div className="cpy-trader__side"><TraderPanel c={c} /></div>
        <div className="cpy-trader__main">
          <BacktestPanel c={c} />
          <PositionsPanel c={c} />
        </div>
      </div>
    </div>
  );
}
