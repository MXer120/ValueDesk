/**
 * The bell's open panel (Notices.tsx is the bell): the list, its View pop-up (grade and source) and the inbox
 * sign-in. A chunk of its own (phone pass, 2026-11-18): nothing of it shows until the bell opens, so it is not in any
 * page's first render; the bell fetches it after the page's load event and on a hover or press, so it opens at once.
 * Moved here from Notices.tsx unchanged.
 */
import { useRef, useSyncExternalStore, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { gradeOf, notices, subscribeNotices, type Notice } from '../notices';
import { openFeedback } from '../feedback/FeedbackButton';
import { renewKeyFromBell } from '../bots/routes';
import { heldSession, signInFeedback } from '../feedback/session';
import { syncNotices } from '../engineNotices';
import { useStored } from '../hooks';
import { ViewPop } from './ViewPop';
import { Section, Seg } from './accountTables/FilterBar';
import { useWalletSnapshot } from './account/useWallet';

type GradeView = 'all' | 'warn' | 'error';
type SourceView = 'all' | 'trading' | 'account' | 'other';
interface BellView { grade: GradeView; source: SourceView }
const DEFAULT_VIEW: BellView = { grade: 'all', source: 'all' };

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

export interface NoticesPanelProps {
  address: string | null;
  /** Pressed open (not hovered): the scrim goes under it. */
  pinned: boolean;
  open: boolean;
  closing: boolean;
  onExited: () => void;
  close: () => void;
  /** Set while the View pop-up (drawn outside the panel) is up, so the hover menu stays open. */
  viewUp: MutableRefObject<boolean>;
  /* Kept by the bell across openings, as before the split. */
  viewOpen: boolean;
  setViewOpen: Dispatch<SetStateAction<boolean>>;
  signing: string | null;
  setSigning: (s: string | null) => void;
}

export function NoticesPanel({ address, pinned, open, closing, onExited, close, viewUp, viewOpen, setViewOpen, signing, setSigning }: NoticesPanelProps) {
  const list = useSyncExternalStore(subscribeNotices, notices, notices);
  const wallet = useWalletSnapshot();
  const [view, setView] = useStored<BellView>('vs.notices.view.v1', DEFAULT_VIEW);
  viewUp.current = viewOpen;
  const viewBtn = useRef<HTMLButtonElement>(null);
  const owner = address?.toLowerCase() ?? null;
  const session = owner ? heldSession(owner) : null;

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
    <>
      {/* Only when pressed open: a full-window scrim under a mouse would count as still hovering. */}
      {pinned && open && <button type="button" className="navnotes__scrim" aria-label="Close notifications" onClick={close} />}
      <div
        className={`navnotes__panel navpop${closing ? ' is-closing' : ''}`}
        role="dialog"
        aria-label="Notifications"
        onAnimationEnd={(e) => { if (closing && e.animationName === 'mo-pop-out') onExited(); }}
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
