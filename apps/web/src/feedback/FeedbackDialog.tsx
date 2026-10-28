/**
 * The feedback chat (feedback.ts): a wallet's one ongoing conversation with the
 * ValueDesk team - everything said so far, and the box to say more. It never
 * ends; there is no "new conversation".
 *
 * WHOSE CHAT (owner, 2026-10-28): always the connected wallet's. SENDING needs
 * no signature - anyone can send, with or without a wallet; the message carries
 * the connected wallet's address. READING the chat needs the wallet's signature
 * (session.ts: once, then 30 days): without it the form shows "Sign in to read
 * your chat", never a word of it. Without a wallet the message still goes, and
 * the form says a reply can only be read with a wallet connected. What this
 * browser sent before signing in joins the wallet's chat at the first sign-in.
 *
 * A message names its kind (Bug, Idea, Other) and its areas (AreaPicker.tsx; at
 * least one for a bug), can take up to three screenshots (pasted, or picked as
 * PNG, JPEG or WebP; re-encoded before they leave - images.ts), the element
 * right-clicked to open the form (a chip, removable), the page and browser info
 * - on by default, Recommended, every line shown under "What will be sent". A
 * text that holds a private key or a seed phrase is not sent (secretIn): the
 * form says so in red.
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
import { REPLY_EVENT, imageUrl, loadThread, markAttached, rememberThread, threads, tokenFor, uploadImage, type ChatMessage } from './threads';
import { forgetSession, heldSession, markSessionSeen, signInFeedback, type WalletSession } from './session';
import { AreaPicker } from './AreaPicker';
import { pushNotice } from '../notices';
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

/** The bell's one row for unsigned senders: always the same, whatever happens in the chat. */
export const SIGN_IN_NOTICE = 'feedback:sign-in';

/** The words on the slide (the owner's "I did not include any private info"). */
export const CONFIRM_LABEL = 'Slide to confirm: I included no private keys, seed phrases or passwords';

interface Shot {
  key: number;
  url: string;
  blob: Blob;
}

/** `chat`: signed in, the chat on screen. `signin`: a wallet, not signed in. `nowallet`: none connected. */
type View = 'loading' | 'chat' | 'signin' | 'nowallet' | 'error';

const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ownerCount = (msgs: ChatMessage[]): number => msgs.filter((m) => m.from === 'owner').length;

export function FeedbackDialog({ open, request, onClose, onThread, address = null, provider = null }: {
  open: boolean;
  request: OpenFeedback | null;
  onClose: () => void;
  /** The chat on screen (FeedbackHost: a reply to it is shown here, not announced): 'wallet', or '' for none. */
  onThread: (key: string) => void;
  /** The connected wallet (App.tsx) - its address goes with every message, and it signs in to read the chat. */
  address?: string | null;
  provider?: Eip1193Provider | null;
}) {
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

  // Each opening: the element right-clicked, the wallet's session, fresh page info.
  useEffect(() => {
    if (!open) return;
    if (request?.element) setElement(request.element);
    setError(null);
    setNote(null);
    void gatherSources().then(setSources).catch(() => setSources(null));
  }, [open, request]);
  useEffect(() => {
    if (open) setSession(heldSession(wallet));
  }, [open, wallet]);

  const reload = useCallback(async () => {
    if (!session) {
      setHistory([]);
      setView(wallet ? 'signin' : 'nowallet');
      return;
    }
    const r = await loadThread(session.token);
    if (!r) {
      setView((v) => (v === 'loading' ? 'error' : v));
      return;
    }
    if (r.status === 'wallet' || r.status === 'session') {
      forgetSession(session.owner);
      setSession(null);
      setHistory([]);
      setView('signin');
      return;
    }
    const msgs = r.status === 'ok' ? r.messages : [];
    setHistory(msgs);
    setView('chat');
    const n = ownerCount(msgs);
    markSessionSeen(session.owner, n);
  }, [session, wallet]);

  useEffect(() => {
    if (!open) return;
    onThread(session ? 'wallet' : '');
    void reload();
    const onReply = (e: Event) => {
      if (session && (e as CustomEvent<string>).detail === 'wallet') void reload();
    };
    window.addEventListener(REPLY_EVENT, onReply);
    return () => window.removeEventListener(REPLY_EVENT, onReply);
  }, [open, session, reload, onThread]);

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
  const canWrite = view === 'chat' || view === 'signin' || view === 'nowallet';
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

  /** The slide reached its end: now it goes out - with the wallet's session when there is one, else this browser's token. */
  const send = async () => {
    setConfirming(false);
    if (!canSend || needAreas) return;
    setBusy(true);
    setError(null);
    setNote(null);
    const key = session?.token ?? tokenFor(wallet);
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
      if (r.auth && session) {
        forgetSession(session.owner);
        setSession(null);
      }
      return;
    }
    if (!session) {
      rememberThread(key, text, wallet);
      setNote(wallet ? 'Sent. Sign in with your wallet to read our reply.' : 'Sent. Connect a wallet to read our reply - replies are kept on a wallet.');
      // The same words in the bell, whether or not a reply ever comes - it says nothing about the chat.
      pushNotice({ id: SIGN_IN_NOTICE, kind: 'info', title: 'Feedback sent', body: wallet ? 'Sign in with your wallet in Send feedback to see replies to your feedback.' : 'Connect a wallet and sign in in Send feedback to see replies to your feedback.', important: false });
    }
    setText('');
    shots.forEach((s) => URL.revokeObjectURL(s.url));
    setShots([]);
    setElement(null);
    setAreas([]);
    setTried(false);
    await reload();
  };

  /** One free signature: the wallet's chat opens here, and what this browser sent without a wallet joins it. */
  const signIn = async () => {
    if (!wallet || !provider) return;
    setSigning(true);
    setError(null);
    const own = threads().find((t) => !t.wallet)?.token ?? null;
    const r = await signInFeedback(provider, wallet, own);
    setSigning(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (own && (r.attached === 'adopted' || r.attached === 'merged' || r.attached === 'same')) markAttached(own, wallet);
    if (r.attached === 'merged' || r.attached === 'adopted') setNote('What you sent from this browser before is now in your wallet\'s chat.');
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

  const title = history.length ? 'Feedback chat' : 'Send feedback';
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
          {view === 'signin' && wallet && (
            <div className="fb-lock" role="status">
              <p>
                Your chat with us is kept on wallet <b className="fb-mono">{short(wallet)}</b>. Sign in to read it and our replies - a free signature, never a transaction. You can send without signing.
              </p>
              {provider ? (
                <button type="button" className="dlg-btn is-go" disabled={signing} onClick={() => void signIn()}>
                  {signing ? 'Waiting for your wallet…' : 'Sign in to read your chat'}
                </button>
              ) : (
                <p className="fb-hint">Reconnect your wallet to sign in.</p>
              )}
            </div>
          )}
          {view === 'nowallet' && (
            <div className="fb-lock" role="status">
              <p>No wallet connected. You can send this, but our reply can only be read with a wallet connected - connect yours to read replies.</p>
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
                    {m.from === 'user' && m.proven === false && <span className="fb-msg__unsigned" title="Sent with this wallet's address, without its signature - from a browser that was not signed in."> · not signed</span>}
                  </span>
                  <p className="fb-msg__text">{m.text}</p>
                  {m.images.length > 0 && session && (
                    <span className="fb-msg__shots">{m.images.map((id) => <ThreadImage key={id} credential={session.token} id={id} />)}</span>
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
                      ? <>Signed in as <span className="fb-mono">{short(session.owner)}</span> - this is your wallet's chat.</>
                      : wallet
                        ? <>Your address <span className="fb-mono">{short(wallet)}</span> goes with every message, so we know whose account it is about.</>
                        : 'No wallet connected - replies can be read only with a wallet connected.'
                  }
                />
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

/** A screenshot of the chat, fetched with the wallet's session (no URL could carry it). */
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
