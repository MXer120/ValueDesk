/**
 * Copy trading: the trader grid (Discover.tsx) - hero, categories, filters,
 * cards - and nothing above it (owner, 2026-10-26: no Discover / My copies tabs,
 * no Copy setup button). A wallet's copies are on the Portfolio page (its My
 * copies card); where a copy runs and the signatures it needs are steps of the
 * Copy dialog itself, so there is no separate setup to open first.
 *
 * A trader opens on the Scan page, the app's one trader page (as a trader
 * opens on Hyperdash's address page): its header has Copy and Counter-trade,
 * which come back here as /copy?address=&venue=&direction= and open the setup.
 *
 * "Copy" opens the two-step setup (CopyModal.tsx) over whatever is on screen;
 * "Start copying" there starts the copy in the mode chosen, once that mode's
 * steps are the follower's own signatures (copy/CopySetupSheet.tsx).
 *
 * One context hook (useCopy.ts) owns every fetch and the setup form. The setup
 * sheet still opens when a start needs a step that is not done (useCopy.ts).
 */
import { useIndexerView } from '../../status/indexerViews';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CopySetupSheet } from '../../copy/CopySetupSheet';
import { copyRows, startCopy } from '../../copy/live';
import { notify } from '../../toast';
import type { TraderRow, Venue } from '../../vsApi';
import { CopyModal } from './CopyModal';
import { Discover } from './Discover';
import { isCopyable } from './gridModel';
import { useCopyContext, type CopyPageProps } from './useCopy';
import { TraderPeek, type PeekTarget } from './TraderPeek';
import './Copy.css';
import './CopyHome.css';

export type { CopyPageProps } from './useCopy';

/** /copy?address=&venue=&direction=: the setup to open for that trader (from Scan, Explore, the Leaderboard). */
function setupFromUrl(): { address: string; venue: Venue; direction: 'copy' | 'counter' } | null {
  const p = new URLSearchParams(window.location.search);
  const address = p.get('address');
  const venue = p.get('venue') as Venue | null;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || !venue || !isCopyable(venue)) return null;
  return { address: address.toLowerCase(), venue, direction: p.get('direction') === 'counter' ? 'counter' : 'copy' };
}

export function CopyPage(props: CopyPageProps) {
  useIndexerView();
  const c = useCopyContext(props);
  const [modal, setModal] = useState<{ open: boolean; row: TraderRow | null }>({ open: false, row: null });
  const settings = c.copySettings;

  const rows = copyRows(c.live);
  const running = rows.filter((r) => r.view.subscription.status !== 'stopped');
  const copying = useMemo(
    () => new Set(running.map((r) => `${r.view.subscription.settings.leader.venue}:${r.view.subscription.settings.leader.address.toLowerCase()}`)),
    [running],
  );

  /** Open the copy setup for a trader, in the direction the button said (Copy or Counter). */
  const copyTrader = useCallback((direction: 'copy' | 'counter', row: TraderRow | null, address?: string, venue?: Venue) => {
    const a = row?.address ?? address;
    if (!a) return;
    if (c.setup.direction !== direction) c.patchSetup({ direction });
    c.selectLeader(a, row?.venue ?? venue);
    setModal({ open: true, row });
  }, [c]);

  /* Arrived with a trader in the link (Scan's Copy / Counter-trade): their setup, over the grid. And again when an
     in-place link (nav.ts openPath, which dispatches popstate) or Back brings another trader to this page. */
  const opened = useRef(false);
  useEffect(() => {
    const open = () => {
      const t = setupFromUrl();
      if (t) copyTrader(t.direction, null, t.address, t.venue);
    };
    if (!opened.current) {
      opened.current = true;
      open();
    }
    window.addEventListener('popstate', open);
    return () => window.removeEventListener('popstate', open);
  }, [copyTrader]);

  /** A trader opens in a large window over the page (TraderPeek.tsx: the Scan page itself, dockable to the side);
   * without the Scan context, on Scan. */
  const [peek, setPeek] = useState<PeekTarget | null>(null);
  const openTrader = useCallback((row: Pick<TraderRow, 'address' | 'venue'>) => {
    if (props.scanCtx) setPeek({ address: row.address, venue: row.venue });
    else c.onScan(row.address, row.venue);
  }, [c, props.scanCtx]);
  const closePeek = useCallback(() => setPeek(null), []);

  return (
    <div className="cpy">
      <Discover
        onOpen={openTrader}
        onCopy={(row, d) => copyTrader(d, row)}
        copying={copying}
        onAddress={(address, venue) => openTrader({ address, venue })}
        onScan={openTrader}
      />

      <TraderPeek target={peek} ctx={props.scanCtx ?? null} onClose={closePeek} onOpenScan={(t) => { setPeek(null); c.onScan(t.address, t.venue); }} />

      <CopyModal
        c={c}
        open={modal.open}
        row={modal.row}
        onClose={() => { setModal({ open: false, row: null }); if (window.location.search.includes('address=')) window.history.replaceState(null, '', '/copy'); }}
        onStarted={() => notify('info', 'Your copies are on the Portfolio page.')}
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
