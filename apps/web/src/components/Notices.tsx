/**
 * The navbar bell. History lives in localStorage (the last 200). The dot is only for an
 * unread deposit, withdrawal, error, a system row such as unfinished setup, or an algo or
 * copy that failed, stopped, halted or was held (engineNotices.ts).
 *
 * Those algo and copy notices are also kept for the wallet: in its inbox on the server once it
 * signs in (the feedback chat's wallet sign-in), and by the hosted executor for its own - while
 * the bell is open (and every minute while a wallet is connected) both are brought in, so what
 * happened on another device or while no tab was open shows here too.
 *
 * "View" (the app's View pop-up, ViewPop + FilterBar's Section / Seg) filters by grade - every
 * notice, warnings and errors, errors only - and by what it is about; the choice is kept.
 *
 * This module is the bell: its dot, and the syncs that feed it, run on every page. The open panel is
 * NoticesPanel.tsx, a chunk of its own fetched after the page's load event and on a hover or press of the bell.
 */
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Guarded } from './ErrorBoundary';
import { indexEnabled, subscribeIndex, IDLE_PROGRESS, type IndexProgress } from '../setup/indexer';
import { markNoticesRead, subscribeNotices, syncSystemNotices, unreadImportant } from '../notices';
import { heldSession } from '../feedback/session';
import { syncNotices } from '../engineNotices';
import { usePresence } from './motion';
import { useHoverMenu } from './useHoverMenu';
import { lazyPage } from '../lazyPage';
import { prefetchAfterLoad } from '../afterLoad';
import type { NoticesPanelProps } from './NoticesPanel';

const Panel = lazyPage<NoticesPanelProps>('notices', () => import('./NoticesPanel').then((m) => m.NoticesPanel));
const warmPanel = () => { void Panel.preload().catch(() => {}); };

function setupDone(): boolean {
  try { return localStorage.getItem('vs.setup.done') != null; }
  catch { return true; }
}

const SYNC_MS = 60_000;

export function Notices({ address }: { address: string | null }) {
  const dot = useSyncExternalStore(subscribeNotices, unreadImportant, unreadImportant);
  const root = useRef<HTMLDivElement>(null);
  /* Kept open while its View pop-up, drawn outside it, is up. */
  const viewUp = useRef(false);
  const { open, mode, close, press, hoverProps } = useHoverMenu(root, () => viewUp.current);
  const pres = usePresence(open);
  const [progress, setProgress] = useState<IndexProgress>(IDLE_PROGRESS);
  const [viewOpen, setViewOpen] = useState(false);
  const [signing, setSigning] = useState<string | null>(null);
  const owner = address?.toLowerCase() ?? null;
  const session = owner ? heldSession(owner) : null;

  useEffect(() => subscribeIndex(setProgress), []);
  /* The panel's code after the page's load event (and on a hover or press of the bell): it opens at once. */
  useEffect(() => prefetchAfterLoad(Panel.preload), []);

  useEffect(() => {
    syncSystemNotices({
      connected: !!address,
      setupDone: setupDone(),
      indexing: indexEnabled() && progress.running && !progress.done,
    });
  }, [address, progress.running, progress.done]);

  // The stored notices (the wallet's inbox, the hosted executor's): now, on opening, and every minute.
  useEffect(() => {
    if (!owner) return;
    void syncNotices(owner);
    const t = setInterval(() => { if (document.visibilityState === 'visible') void syncNotices(owner); }, SYNC_MS);
    return () => clearInterval(t);
  }, [owner, session?.token]);
  useEffect(() => { if (open && owner) void syncNotices(owner); }, [open, owner]);

  /* Opened is read, however it opened. */
  useEffect(() => { if (open) markNoticesRead(); }, [open]);

  return (
    <div className="navnotes" ref={root} {...hoverProps} onPointerEnter={(e) => { warmPanel(); hoverProps.onPointerEnter?.(e); }}>
      <button
        type="button"
        className="navicon"
        aria-label={dot > 0 ? `Notifications, ${dot} unread` : 'Notifications'}
        aria-expanded={open}
        title="Notifications"
        onPointerDown={warmPanel}
        onClick={press}
      >
        <BellIcon />
        {dot > 0 && <span className="navnotes__dot" aria-hidden="true" />}
      </button>
      {pres.mounted && (
        <Guarded name="Notifications" bare>
        <Suspense fallback={null}>
          <Panel
            address={address}
            pinned={mode === 'pinned'}
            open={open}
            closing={pres.closing}
            onExited={pres.done}
            close={close}
            viewUp={viewUp}
            viewOpen={viewOpen}
            setViewOpen={setViewOpen}
            signing={signing}
            setSigning={setSigning}
          />
        </Suspense>
        </Guarded>
      )}
    </div>
  );
}

const BellIcon = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <path d="M10 2.2a5.2 5.2 0 0 0-5.2 5.2v2.4L3.2 12.6a1 1 0 0 0 .8 1.6h12a1 1 0 0 0 .8-1.6L15.2 9.8V7.4A5.2 5.2 0 0 0 10 2.2Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M8.2 15.6a1.8 1.8 0 0 0 3.6 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
