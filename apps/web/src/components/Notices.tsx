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
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { indexEnabled, subscribeIndex, IDLE_PROGRESS, type IndexProgress } from '../setup/indexer';
import {
  gradeOf, markNoticesRead, notices, subscribeNotices, syncSystemNotices, unreadImportant, type Notice,
} from '../notices';
import { openFeedback } from '../feedback/FeedbackButton';
import { renewKeyFromBell } from '../bots/routes';
import { heldSession, signInFeedback } from '../feedback/session';
import { syncNotices } from '../engineNotices';
import { useStored } from '../hooks';
import { ViewPop } from './ViewPop';
import { Section, Seg } from './accountTables/FilterBar';
import { useWalletSnapshot } from './account/useWallet';
import { usePresence } from './motion';
import { useHoverMenu } from './useHoverMenu';

function setupDone(): boolean {
  try { return localStorage.getItem('vs.setup.done') != null; }
  catch { return true; }
}

type GradeView = 'all' | 'warn' | 'error';
type SourceView = 'all' | 'trading' | 'account' | 'other';
interface BellView { grade: GradeView; source: SourceView }
const DEFAULT_VIEW: BellView = { grade: 'all', source: 'all' };
const SYNC_MS = 60_000;

/** Whether a row passes the bell's View. */
export function inView(n: Pick<Notice, 'kind' | 'grade'>, v: BellView): boolean {
  const g = gradeOf(n);
  if (v.grade === 'error' && g !== 'error') return false;
  if (v.grade === 'warn' && g === 'info') return false;
  if (v.source === 'trading') return n.kind === 'algo' || n.kind === 'copy';
  if (v.source === 'account') return n.kind === 'deposit' || n.kind === 'withdraw' || n.kind === 'reply';
  if (v.source === 'other') return n.kind === 'system' || n.kind === 'info' || n.kind === 'error';
  return true;
}

export function Notices({ address }: { address: string | null }) {
  const list = useSyncExternalStore(subscribeNotices, notices, notices);
  const dot = useSyncExternalStore(subscribeNotices, unreadImportant, unreadImportant);
  const wallet = useWalletSnapshot();
  const root = useRef<HTMLDivElement>(null);
  /* Kept open while its View pop-up, drawn outside it, is up. */
  const viewUp = useRef(false);
  const { open, mode, close, press, hoverProps } = useHoverMenu(root, () => viewUp.current);
  const pres = usePresence(open);
  const [progress, setProgress] = useState<IndexProgress>(IDLE_PROGRESS);
  const [view, setView] = useStored<BellView>('vs.notices.view.v1', DEFAULT_VIEW);
  const [viewOpen, setViewOpen] = useState(false);
  viewUp.current = viewOpen;
  const viewBtn = useRef<HTMLButtonElement>(null);
  const [signing, setSigning] = useState<string | null>(null);
  const owner = address?.toLowerCase() ?? null;
  const session = owner ? heldSession(owner) : null;

  useEffect(() => subscribeIndex(setProgress), []);

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

  const signIn = async () => {
    if (!owner || !wallet.provider) return;
    setSigning('Confirm in your wallet…');
    try {
      const r = await signInFeedback(wallet.provider, owner, null);
      setSigning(r.ok ? null : r.error);
      if (r.ok) void syncNotices(owner);
    } catch (e) {
      setSigning(e instanceof Error ? e.message : String(e));
    }
  };

  const shown = list.filter((n) => inView(n, view));
  const filtered = view.grade !== 'all' || view.source !== 'all';

  return (
    <div className="navnotes" ref={root} {...hoverProps}>
      <button
        type="button"
        className="navicon"
        aria-label={dot > 0 ? `Notifications, ${dot} unread` : 'Notifications'}
        aria-expanded={open}
        title="Notifications"
        onClick={press}
      >
        <BellIcon />
        {dot > 0 && <span className="navnotes__dot" aria-hidden="true" />}
      </button>
      {pres.mounted && (
        <>
          {/* Only when pressed open: a full-window scrim under a mouse would count as still hovering. */}
          {mode === 'pinned' && open && <button type="button" className="navnotes__scrim" aria-label="Close notifications" onClick={close} />}
          <div
            className={`navnotes__panel navpop${pres.closing ? ' is-closing' : ''}`}
            role="dialog"
            aria-label="Notifications"
            onAnimationEnd={(e) => { if (pres.closing && e.animationName === 'mo-pop-out') pres.done(); }}
          >
            <div className="navnotes__head">
              <span>Notifications</span>
              <button ref={viewBtn} type="button" className={`navnotes__view${filtered ? ' is-on' : ''}`} aria-expanded={viewOpen} onClick={() => setViewOpen((v) => !v)}>
                View
              </button>
            </div>
            <ViewPop open={viewOpen} anchor={viewBtn} onClose={() => setViewOpen(false)} onReset={() => setView(DEFAULT_VIEW)} resetDisabled={!filtered}>
              <Section label="Grade">
                <Seg<GradeView> value={view.grade} onChange={(grade) => setView({ ...view, grade })} options={[['all', 'All'], ['warn', 'Warnings + errors'], ['error', 'Errors']]} />
              </Section>
              <Section label="About">
                <Seg<SourceView> value={view.source} onChange={(source) => setView({ ...view, source })} options={[['all', 'All'], ['trading', 'Algos + copies'], ['account', 'Account'], ['other', 'Other']]} cols={2} />
              </Section>
            </ViewPop>
            {shown.length === 0 ? (
              <p className="navnotes__empty">{list.length ? 'Nothing for this view.' : 'Nothing yet.'}</p>
            ) : (
              <ul className="navnotes__list">
                {shown.map((n) => (
                  <li key={n.id} className={`navnotes__row is-${gradeOf(n)}${n.important && !n.read ? ' is-new' : ''}${n.kind === 'reply' ? ' is-link' : ''}`}>
                    <span className={`navnotes__mark is-${n.kind} is-${gradeOf(n)}`} aria-hidden="true">{markOf(n)}</span>
                    {n.kind === 'reply' && n.ref ? (
                      /* A reply to the visitor's feedback: the row opens that chat (feedback/FeedbackHost.tsx). */
                      <button type="button" className="navnotes__copy navnotes__open" onClick={() => { close(); openFeedback({ thread: n.ref }); }}>
                        <span className="navnotes__k">{n.title}</span>
                        <span className="navnotes__b">{n.body}</span>
                      </button>
                    ) : (
                      <span className="navnotes__copy">
                        <span className="navnotes__k">{n.title}</span>
                        <span className="navnotes__b">{n.body}</span>
                        <span className="navnotes__t">{whenOf(n)}</span>
                        {n.action === 'renew-key' && (
                          <button type="button" className="navnotes__act" onClick={() => { close(); renewKeyFromBell(); }}>Renew the key</button>
                        )}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {owner && !session && (
              <div className="navnotes__inbox">
                <span>Your algos' and copies' notices are kept for your wallet: sign in once to see them on every device.</span>
                <button type="button" className="navnotes__sign" disabled={!wallet.provider || signing === 'Confirm in your wallet…'} onClick={() => void signIn()}>
                  Sign in with wallet
                </button>
                {signing && signing !== 'Confirm in your wallet…' && <span className="navnotes__err">{signing}</span>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const whenOf = (n: Notice): string => {
  const d = new Date(n.time);
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? '' : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} `}${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}${n.origin === 'executor' ? ' · hosted' : n.origin === 'inbox' ? ' · another device' : ''}`;
};

function markOf(n: Notice): string {
  if (n.kind === 'deposit') return 'In';
  if (n.kind === 'withdraw') return 'Out';
  if (n.kind === 'error') return '!';
  if (n.kind === 'system') return '•';
  if (n.kind === 'reply') return '✉';
  if (n.kind === 'algo') return gradeOf(n) === 'info' ? 'A' : 'A!';
  if (n.kind === 'copy') return gradeOf(n) === 'info' ? 'C' : 'C!';
  return 'i';
}

const BellIcon = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <path d="M10 2.2a5.2 5.2 0 0 0-5.2 5.2v2.4L3.2 12.6a1 1 0 0 0 .8 1.6h12a1 1 0 0 0 .8-1.6L15.2 9.8V7.4A5.2 5.2 0 0 0 10 2.2Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M8.2 15.6a1.8 1.8 0 0 0 3.6 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
