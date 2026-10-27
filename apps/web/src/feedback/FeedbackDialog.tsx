/**
 * The feedback chat (feedback.ts): this visitor's one ongoing conversation with
 * the ValueDesk team - everything said so far, and the box to say more. It
 * never ends; there is no "new conversation".
 *
 * WHOSE CHAT. A browser writes by its thread token (threads.ts) - with or
 * without a wallet. A connected wallet can keep the chat on itself with one free
 * signature (session.ts): then it opens in any browser with that wallet, and
 * only with its signature. A chat already kept on a wallet asks for that
 * signature before it shows a word.
 *
 * A message names its kind (Bug, Idea, Other) and its areas (AreaPicker.tsx; at
 * least one for a bug), can take up to three screenshots (pasted, or picked as
 * PNG, JPEG or WebP; re-encoded before they leave - images.ts), the element
 * right-clicked to open the form (a chip, removable), the page and browser info
 * - on by default, Recommended, every line shown under "What will be sent" - and
 * always the connected wallet's address. A text that holds a private key or a
 * seed phrase is not sent (secretIn): the form says so in red.
 *
 * SEND opens a second, small window: the red warning (never a private key, a
 * seed phrase, passwords or API keys) and a slide to confirm (the algo ticket's,
 * components/algo/SlideConfirm.tsx). Only the slide sends.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { Modal } from '../components/Modal';
import { DlgFoot, DlgSection, DlgSeg, DlgSwitch, DlgRow } from '../components/dialogParts';
import { SlideConfirm } from '../components/algo/SlideConfirm';
import { areaLabel } from '@sign/ops/feedbackAreas.js';
import type { Eip1193Provider } from '../wallet';
import { FEEDBACK_MAX, FEEDBACK_URL, messageLength, secretIn, sendMessage, type FeedbackCategory } from './feedback';
import { buildContext, connectedWallet, contextRows, gatherSources, type ContextSources } from './context';
import { elementSummary, type ElementInfo } from './element';
import { ACCEPT, MAX_IMAGES, acceptable, reencode } from './images';
import { REPLY_EVENT, imageUrl, loadThread, markAttached, markSeen, newToken, rememberThread, threads, uploadImage, type ChatMessage } from './threads';
import { forgetSession, heldSession, markSessionSeen, signInFeedback, type WalletSession } from './session';
import { AreaPicker } from './AreaPicker';
import type { OpenFeedback } from './FeedbackButton';

const CATEGORIES: Array<{ value: FeedbackCategory; label: string }> = [
  { value: 'bug', label: 'Bug' },
  { value: 'idea', label: 'Idea' },
  { value: 'other', label: 'Other' },
];

const PLACEHOLDER: Record<FeedbackCategory, string> = {
  bug: 'What happened, and what did you expect? The steps to get there help most. Paste a screenshot here.',
  idea: 'What would make ValueDesk better for you?',
  other: 'Tell us anything.',
};

/** The words on the slide (the owner's "I did not include any private info"). */
export const CONFIRM_LABEL = 'Slide to confirm: I included no private keys, seed phrases or passwords';

interface Shot {
  key: number;
  url: string;
  blob: Blob;
}

type View = 'loading' | 'ok' | 'locked' | 'error';

const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ownerCount = (msgs: ChatMessage[]): number => msgs.filter((m) => m.from === 'owner').length;

export function FeedbackDialog({ open, request, onClose, onThread, address = null, provider = null }: {
  open: boolean;
  request: OpenFeedback | null;
  onClose: () => void;
  /** The chat on screen (FeedbackHost: a reply to it is shown here, not announced): a thread token, or 'wallet'. */
  onThread: (key: string) => void;
  /** The connected wallet (App.tsx) - its address goes with every message, and it can sign the chat in. */
  address?: string | null;
  provider?: Eip1193Provider | null;
}) {
  const [token, setToken] = useState<string>(() => threads()[0]?.token ?? newToken());
  const [session, setSession] = useState<WalletSession | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [view, setView] = useState<View>('loading');
  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [areas, setAreas] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [shots, setShots] = useState<Shot[]>([]);
  const [element, setElement] = useState<ElementInfo | null>(null);
  const [withContext, setWithContext] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [website, setWebsite] = useState('');
  const [sources, setSources] = useState<ContextSources | null>(null);
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const shotKey = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  /** An open dropdown inside the form: Escape closes it before the window. */
  const layer = useRef<(() => void) | null>(null);
  const wallet = useMemo(() => (open ? (address ?? connectedWallet())?.toLowerCase() ?? null : null), [open, address]);

  // Each opening: the chat asked for (a reply in the bell), the element right-clicked, the wallet's session, fresh page info.
  useEffect(() => {
    if (!open) return;
    if (request?.thread && request.thread !== 'wallet') setToken(request.thread);
    if (request?.element) setElement(request.element);
    setError(null);
    setNote(null);
    void gatherSources().then(setSources).catch(() => setSources(null));
  }, [open, request]);
  useEffect(() => {
    if (open) setSession(heldSession(wallet));
  }, [open, wallet]);

  /** The key the chat on screen is opened with: the wallet's session, else this browser's token. */
  const key = session?.token ?? token;
  const ref = threads().find((t) => t.token === token);

  const reload = useCallback(async () => {
    if (!session && !threads().some((t) => t.token === token)) {
      setHistory([]);
      setView('ok');
      return;
    }
    const r = await loadThread(key);
    if (!r) {
      setView((v) => (v === 'loading' ? 'error' : v));
      return;
    }
    if (r.status === 'wallet' || r.status === 'session') {
      if (r.status === 'session' && session) {
        forgetSession(session.owner);
        setSession(null);
      }
      setHistory([]);
      setView('locked');
      return;
    }
    const msgs = r.status === 'ok' ? r.messages : [];
    setHistory(msgs);
    setView('ok');
    const n = ownerCount(msgs);
    if (session) {
      markSessionSeen(session.owner, n);
      for (const t of threads()) if (t.wallet === session.owner) markSeen(t.token, n);
    } else markSeen(token, n);
  }, [key, session, token]);

  useEffect(() => {
    if (!open) return;
    onThread(session ? 'wallet' : token);
    void reload();
    const onReply = (e: Event) => {
      const d = (e as CustomEvent<string>).detail;
      if (d === token || (session && d === 'wallet')) void reload();
    };
    window.addEventListener(REPLY_EVENT, onReply);
    return () => window.removeEventListener(REPLY_EVENT, onReply);
  }, [open, token, session, reload, onThread]);

  // A fresh chat starts as a bug report; a reply in a running chat is "Other" until changed.
  const started = history.length > 0;
  useEffect(() => {
    setCategory(started ? 'other' : 'bug');
  }, [started]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [history]);

  const context = sources && withContext ? buildContext(sources, element) : null;
  const len = messageLength(text);
  const secret = text ? secretIn(text) : null;
  const needAreas = category === 'bug' && areas.length === 0;
  const canWrite = view === 'ok';
  const canSend = canWrite && !busy && len >= 1 && len <= FEEDBACK_MAX && !secret;

  const addFiles = async (files: Iterable<File>) => {
    setError(null);
    for (const f of files) {
      if (!acceptable(f)) {
        setError('Only screenshots can be attached - PNG, JPEG or WebP images.');
        continue;
      }
      if (shots.length >= MAX_IMAGES) {
        setError(`At most ${MAX_IMAGES} screenshots per message.`);
        break;
      }
      const r = await reencode(f);
      if (!r.ok) {
        setError(r.error);
        continue;
      }
      setShots((s) => (s.length >= MAX_IMAGES ? s : [...s, { key: ++shotKey.current, url: r.url, blob: r.blob }]));
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  };
  const dropShot = (k: number) => setShots((s) => s.filter((x) => (x.key === k ? (URL.revokeObjectURL(x.url), false) : true)));

  /** Send pressed: check the form, then the warning and the slide. */
  const askToSend = () => {
    setTried(true);
    if (!canSend) return;
    if (needAreas) {
      setError('Pick at least one area for a bug.');
      return;
    }
    setError(null);
    setConfirming(true);
  };

  /** The slide reached its end: now it goes out. */
  const send = async () => {
    setConfirming(false);
    if (!canSend || needAreas) return;
    setBusy(true);
    setError(null);
    const ids: string[] = [];
    for (const s of shots) {
      const r = await uploadImage(key, s.blob);
      if (!r.ok) {
        setError(r.error);
        setBusy(false);
        return;
      }
      ids.push(r.id);
    }
    const r = await sendMessage(key, { category, areas, message: text, images: ids, context, wallet, website });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      if (r.auth) {
        if (session) forgetSession(session.owner);
        setSession(null);
        setView('locked');
      }
      return;
    }
    if (!session) rememberThread(token, text);
    setText('');
    shots.forEach((s) => URL.revokeObjectURL(s.url));
    setShots([]);
    setElement(null);
    setAreas([]);
    setTried(false);
    await reload();
  };

  /** One free signature: the wallet's chat opens here, and this browser's chat joins it. */
  const signIn = async () => {
    if (!wallet || !provider) return;
    setSigning(true);
    setError(null);
    const attach = threads().some((t) => t.token === token) ? token : null;
    const r = await signInFeedback(provider, wallet, attach);
    setSigning(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (attach && (r.attached === 'adopted' || r.attached === 'merged' || r.attached === 'same')) markAttached(attach, wallet);
    if (r.attached === 'other') setNote('The chat in this browser is kept on another wallet. This wallet has its own chat.');
    else if (r.attached === 'merged') setNote('Your chat from this browser was added to your wallet\'s chat.');
    else if (r.attached === 'adopted') setNote('This chat is now kept on your wallet - open it on any device with it.');
    setView('loading');
    setSession(r.session);
  };

  const closeTop = () => {
    if (layer.current) {
      layer.current();
      return;
    }
    if (confirming) {
      setConfirming(false);
      return;
    }
    onClose();
  };

  const lockedWallet = ref?.wallet ?? null;
  const title = view === 'locked' ? 'Feedback chat' : history.length ? 'Feedback chat' : 'Send feedback';
  return (
    <>
      <Modal open={open} size="md" title={title} className="fx fb-dialog" onClose={closeTop} dismissOnBackdrop={!text.trim() && !shots.length}>
        <form
          className="dlg fb-form"
          onPaste={onPaste}
          onSubmit={(e) => {
            e.preventDefault();
            askToSend();
          }}
        >
          {view === 'locked' && (
            <div className="fb-lock" role="status">
              <p>
                This chat is kept on {lockedWallet ? <>wallet <b className="fb-mono">{short(lockedWallet)}</b></> : 'a wallet'}. Sign in with that wallet to open it - a free signature, never a transaction.
              </p>
              {wallet && provider ? (
                <button type="button" className="dlg-btn is-go" disabled={signing} onClick={() => void signIn()}>
                  {signing ? 'Waiting for your wallet…' : 'Sign in with wallet'}
                </button>
              ) : (
                <p className="fb-hint">Connect {lockedWallet ? 'that wallet' : 'your wallet'} first.</p>
              )}
            </div>
          )}
          {view === 'error' && <p className="dlg-err fb-err" role="alert">The chat could not be loaded - check your connection and open it again.</p>}
          {history.length > 0 && (
            <div className="fb-chat" ref={listRef} aria-label="Your conversation with the ValueDesk team" role="log">
              {history.map((m) => (
                <div key={m.id} className={`fb-msg is-${m.from}`}>
                  <span className="fb-msg__who">
                    {m.from === 'owner' ? 'ValueDesk team' : 'You'} · {when(m.at)}
                    {m.from === 'user' && m.areas && m.areas.length > 0 && <> · {m.areas.map(areaLabel).join(', ')}</>}
                  </span>
                  <p className="fb-msg__text">{m.text}</p>
                  {m.images.length > 0 && (
                    <span className="fb-msg__shots">{m.images.map((id) => <ThreadImage key={id} credential={key} id={id} />)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {note && <p className="fb-note" role="status">{note}</p>}
          {canWrite && (
            <>
              <DlgSection label="What is it about">
                <DlgRow title="Kind">
                  <DlgSeg label="Kind of feedback" value={category} options={CATEGORIES} onChange={setCategory} />
                </DlgRow>
                <DlgRow title="Area" line={category === 'bug' ? 'Required for a bug - pick every part it touches.' : 'Optional - which parts of the site.'} stack>
                  <AreaPicker value={areas} onChange={setAreas} required={category === 'bug'} invalid={tried && needAreas} onLayer={(c) => { layer.current = c; }} />
                </DlgRow>
              </DlgSection>
              <DlgSection label={history.length ? 'Your reply' : 'Your message'} aside={<span className={`fb-count${len > FEEDBACK_MAX ? ' is-over' : ''}`}>{len}/{FEEDBACK_MAX}</span>}>
                <div className="dlg-row is-full">
                  <div className={`dlg-field is-wide is-text${secret ? ' is-bad' : ''}`}>
                    <textarea
                      aria-label={history.length ? 'Your reply' : 'Your message'}
                      value={text}
                      placeholder={PLACEHOLDER[category]}
                      rows={4}
                      maxLength={FEEDBACK_MAX * 2}
                      onChange={(e) => setText(e.target.value)}
                    />
                  </div>
                </div>
                {secret && <p className="dlg-err fb-secret" role="alert">{secret.text}</p>}
                <div className="fb-attach">
                  {element && (
                    <span className="fb-chip" title={`${element.path}${element.panel ? ` · ${element.panel}` : ''}`}>
                      <span>{elementSummary(element)}</span>
                      <button type="button" aria-label="Remove the attached element" onClick={() => setElement(null)}>×</button>
                    </span>
                  )}
                  {shots.map((s) => (
                    <span key={s.key} className="fb-shot">
                      <img src={s.url} alt="Attached screenshot" />
                      <button type="button" aria-label="Remove this screenshot" onClick={() => dropShot(s.key)}>×</button>
                    </span>
                  ))}
                  {shots.length < MAX_IMAGES && (
                    <label className="dlg-btn is-small fb-pick">
                      <input
                        type="file"
                        accept={ACCEPT}
                        multiple
                        onChange={(e) => {
                          const files = e.target.files ? [...e.target.files] : [];
                          e.target.value = '';
                          void addFiles(files);
                        }}
                      />
                      Add screenshot
                    </label>
                  )}
                  <span className="fb-attach__hint">or paste one ({shots.length}/{MAX_IMAGES})</span>
                </div>
              </DlgSection>
              <DlgSection label="Page and browser info">
                <DlgRow
                  title="Include page and browser info"
                  line={<><b className="fb-rec">Recommended</b> - helps us find what went wrong. Nothing that identifies you.</>}
                >
                  <DlgSwitch label="Include page and browser info" on={withContext} onChange={setWithContext} />
                </DlgRow>
                {withContext && context && (
                  <div className="fb-details">
                    <button type="button" className="dlg-link" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>
                      {showDetails ? 'Hide what will be sent' : 'Show what will be sent'}
                    </button>
                    {showDetails && (
                      <dl className="fb-sent">
                        {contextRows(context).map(([k, v]) => (
                          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
                        ))}
                      </dl>
                    )}
                  </div>
                )}
                <DlgRow
                  title="Your wallet"
                  line={
                    session
                      ? <>Signed in as <span className="fb-mono">{short(session.owner)}</span> - this chat is kept on your wallet.</>
                      : wallet
                        ? <>Your address <span className="fb-mono">{short(wallet)}</span> goes with every message, so we can look at your account's public trades.</>
                        : 'No wallet connected - you can still write. Connect one to keep this chat on it.'
                  }
                >
                  {!session && wallet && provider && (
                    <button type="button" className="dlg-btn is-small" disabled={signing} onClick={() => void signIn()} title="Read this chat on any device with your wallet. A free signature, never a transaction.">
                      {signing ? 'Waiting…' : 'Keep chat on wallet'}
                    </button>
                  )}
                </DlgRow>
              </DlgSection>
            </>
          )}
          {/* Hidden from people and from assistive tech; a bot that fills in every field fills this in too. */}
          <input className="fb-hp" type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(e) => setWebsite(e.target.value)} />
          <p className="fb-hint">Goes to the ValueDesk team only; our reply appears here and in the bell.</p>
          {error && <p className="dlg-err fb-err" role="alert">{error}</p>}
          <DlgFoot
            left={
              <span className="fb-foot-left">
                {FEEDBACK_URL ? (
                  <a className="dlg-btn is-small fb-discord" href={FEEDBACK_URL} target="_blank" rel="noopener noreferrer">Discord</a>
                ) : (
                  <button type="button" className="dlg-btn is-small fb-discord" disabled title="Our Discord server is coming soon">Discord · coming soon</button>
                )}
              </span>
            }
          >
            <button type="button" className="dlg-btn" onClick={onClose}>Close</button>
            {canWrite && <button type="submit" className="dlg-btn is-go" disabled={!canSend}>{busy ? 'Sending…' : 'Send'}</button>}
          </DlgFoot>
        </form>
      </Modal>
      <SendConfirm open={open && confirming} onCancel={() => setConfirming(false)} onConfirm={() => void send()} />
    </>
  );
}

/** The second window on Send: the warning in red and the slide. Exported for the test's render. */
export function SendConfirm({ open, onCancel, onConfirm }: { open: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal open={open} size="sm" title="Before you send" className="fx fb-confirm" onClose={onCancel}>
      <div className="dlg fb-confirm__body">
        <p className="fb-warn" role="alert">
          <b>Never</b> send a <b>private key</b>, a <b>seed phrase</b>, <b>passwords</b> or <b>API keys</b> - nobody from ValueDesk will ever ask for one. Check your message and your screenshots.
        </p>
        <SlideConfirm label={CONFIRM_LABEL} tone="sell" onConfirm={onConfirm} />
        <DlgFoot>
          <button type="button" className="dlg-btn" onClick={onCancel}>Back to my message</button>
        </DlgFoot>
      </div>
    </Modal>
  );
}

/** A screenshot of the chat, fetched with the chat's key (no URL could carry it). */
function ThreadImage({ credential, id }: { credential: string; id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    void imageUrl(credential, id).then((u) => {
      made = u;
      if (live) setUrl(u);
      else if (u) URL.revokeObjectURL(u);
    });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [credential, id]);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer" className="fb-msg__shot"><img src={url} alt="Screenshot" /></a> : <span className="fb-msg__shot is-loading" />;
}
