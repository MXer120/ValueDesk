/**
 * The navbar bell. History lives in localStorage. The dot is only for an
 * unread deposit, withdrawal, error, or a system row such as unfinished setup.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { indexEnabled, subscribeIndex, IDLE_PROGRESS, type IndexProgress } from '../setup/indexer';
import {
  markNoticesRead, notices, subscribeNotices, syncSystemNotices, unreadImportant,
} from '../notices';

function setupDone(): boolean {
  try { return localStorage.getItem('vs.setup.done') != null; }
  catch { return true; }
}

export function Notices({ address }: { address: string | null }) {
  const list = useSyncExternalStore(subscribeNotices, notices, notices);
  const dot = useSyncExternalStore(subscribeNotices, unreadImportant, unreadImportant);
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<IndexProgress>(IDLE_PROGRESS);

  useEffect(() => subscribeIndex(setProgress), []);

  useEffect(() => {
    syncSystemNotices({
      connected: !!address,
      setupDone: setupDone(),
      indexing: indexEnabled() && progress.running && !progress.done,
    });
  }, [address, progress.running, progress.done]);

  const toggle = () => {
    setOpen((v) => {
      if (!v) markNoticesRead();
      return !v;
    });
  };

  return (
    <div className="navnotes">
      <button
        type="button"
        className="navicon"
        aria-label={dot > 0 ? `Notifications, ${dot} unread` : 'Notifications'}
        aria-expanded={open}
        title="Notifications"
        onClick={toggle}
      >
        <BellIcon />
        {dot > 0 && <span className="navnotes__dot" aria-hidden="true" />}
      </button>
      {open && (
        <>
          <button type="button" className="navnotes__scrim" aria-label="Close notifications" onClick={() => setOpen(false)} />
          <div className="navnotes__panel" role="dialog" aria-label="Notifications">
            <div className="navnotes__head">Notifications</div>
            {list.length === 0 ? (
              <p className="navnotes__empty">Nothing yet.</p>
            ) : (
              <ul className="navnotes__list">
                {list.map((n) => (
                  <li key={n.id} className={`navnotes__row${n.important && !n.read ? ' is-new' : ''}`}>
                    <span className={`navnotes__mark is-${n.kind}`} aria-hidden="true">{markOf(n.kind)}</span>
                    <span className="navnotes__copy">
                      <span className="navnotes__k">{n.title}</span>
                      <span className="navnotes__b">{n.body}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function markOf(kind: string): string {
  if (kind === 'deposit') return 'In';
  if (kind === 'withdraw') return 'Out';
  if (kind === 'error') return '!';
  if (kind === 'system') return '•';
  return 'i';
}

const BellIcon = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <path d="M10 2.2a5.2 5.2 0 0 0-5.2 5.2v2.4L3.2 12.6a1 1 0 0 0 .8 1.6h12a1 1 0 0 0 .8-1.6L15.2 9.8V7.4A5.2 5.2 0 0 0 10 2.2Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M8.2 15.6a1.8 1.8 0 0 0 3.6 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
