/**
 * The feedback chat (feedback.ts): a wallet's one ongoing conversation with the
 * ValueDesk team - everything said so far, and the box to say more. It never
 * ends; there is no "new conversation".
 *
 * WHOSE CHAT (owner, 2026-10-28): the wallet the form names - the connected one
 * unless changed. SENDING needs no signature - anyone can send, with or without a
 * wallet; the message carries that address. READING the chat needs the wallet's
 * signature (session.ts: once, then 30 days): until then the form offers "Sign in
 * to read replies" (a small button in its foot), never a word of the chat. What
 * this browser sent before signing in joins the wallet's chat at the first sign-in.
 *
 * THE WALLET FIELD (owner, 2026-10-28), between Kind and Area: the connected
 * address, changeable. Emptied, the form warns that no reply can reach you; changed
 * to another address, that only that wallet's owner can read the reply - signing in
 * with it. A message with no wallet is marked for the owner (server ops/feedback.ts
 * NO_WALLET_MARK); one with a changed address is sent as typed (walletTyped).
 *
 * A message names its kind (Bug, Idea, Other) and its areas (AreaPicker.tsx; at
 * least one for a bug), can take up to three screenshots (pasted, or picked as
 * PNG, JPEG or WebP; re-encoded before they leave - images.ts), the element
 * right-clicked to open the form (a chip, removable), the page and browser info
 * - on by default, Recommended, every line shown in "What will be sent", a window
 * of its own. A text that holds a private key or a seed phrase is not sent
 * (secretIn): the form says so in red.
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
import { REPLY_EVENT, imageUrl, loadThread, markAttached, rememberThread, setUnread, threads, tokenFor, uploadImage, type ChatMessage } from './threads';
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
const ADDRESS = /^0x[0-9a-f]{40}$/;

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
  const [preview, setPreview] = useState(false);
  /** The wallet field: the connected address unless changed. */
  const [walletText, setWalletText] = useState('');
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
    if (request?.areas) setAreas(request.areas);
    if (request?.draft) setText(request.draft);
    setError(null);
    setNote(null);
    void gatherSources().then(setSources).catch(() => setSources(null));
  }, [open, request]);
  useEffect(() => {
    if (open) setSession(heldSession(wallet));
  }, [open, wallet]);
  useEffect(() => {
    if (open) setWalletText(wallet ?? '');
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
    // Read with the signature: the server marked this wallet's browsers seen, the dot goes.
    setUnread(false);
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

  const entered = walletText.trim().toLowerCase();
  const walletOk = entered === '' || ADDRESS.test(entered);
  /** The address the message goes with, and whose chat it joins. */
  const sendWallet = walletOk && entered ? entered : null;
  const walletTyped = sendWallet !== null && sendWallet !== wallet;
  /** Into the signed-in chat only with that chat's own address; any other goes as unsigned. */
  const signedSend = !!session && sendWallet === session.owner;
  const built = sources && withContext ? buildContext(sources, element) : null;
  const context = built && walletTyped ? { ...built, walletTyped: true } : built;
  const len = messageLength(text);
  const secret = text ? secretIn(text) : null;
  const needAreas = category === 'bug' && areas.length === 0;
  const canWrite = view === 'chat' || view === 'signin' || view === 'nowallet';
  const canSend = canWrite && !busy && len >= 1 && len <= FEEDBACK_MAX && !secret && walletOk;
  const walletWarn = !walletOk
    ? null
    : !sendWallet
      ? wallet
        ? "Without a wallet you won't get updates on this: our reply is kept on a wallet, and only that wallet can read it."
        : "No wallet - we can't reply to this. Enter your wallet address to get an answer; you read it by connecting that wallet and signing in."
      : walletTyped
        ? `Our reply goes to this wallet's chat, and only its owner can read it - by connecting ${short(sendWallet)} and signing in. Make sure it is yours.${session ? ' It will not show in the chat you are signed in to.' : ''}`
        : null;

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
    const key = signedSend ? session!.token : tokenFor(sendWallet);
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
    const r = await sendMessage(key, { category, areas, message: text, images: ids, context, wallet: sendWallet, website });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      if (r.auth && session && signedSend) {
        forgetSession(session.owner);
        setSession(null);
      }
      return;
    }
    if (!signedSend) {
      rememberThread(key, text, sendWallet);
      setNote(
        !sendWallet
          ? "Sent without a wallet - we can't reply to it."
          : walletTyped
            ? `Sent to the chat of ${short(sendWallet)} - only that wallet can read our reply, after signing in with it.`
            : 'Sent. Sign in with your wallet to read our reply.',
      );
      // The same words in the bell, whether or not a reply ever comes - it says nothing about the chat.
      if (sendWallet) pushNotice({ id: SIGN_IN_NOTICE, kind: 'info', title: 'Feedback sent', body: 'Sign in with the wallet in Send feedback to see replies to your feedback.', important: false });
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
    // This browser's token for the wallet watches the chat: the unread dot later, with no signature.
    const watch = tokenFor(wallet);
    const r = await signInFeedback(provider, wallet, own, fetch, { watch });
    setSigning(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    rememberThread(watch, '', wallet);
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
    if (preview) {
      setPreview(false);
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
      <Modal open={open} size="lg" title={title} className="fx fb-dialog" onClose={closeTop} dismissOnBackdrop={!text.trim() && !shots.length}>
        <form
          className="dlg fb-form"
          onPaste={onPaste}
          onSubmit={(e) => {
            e.preventDefault();
            askToSend();
          }}
        >
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
                <DlgRow
                  title="Wallet"
                  line={signedSend ? <>Signed in - this is your wallet&apos;s chat.</> : 'Our reply is kept on this wallet; you read it by signing in with it.'}
                  stack
                >
                  <div className={`dlg-field is-wide fb-wallet${walletOk ? '' : ' is-bad'}`}>
                    <input
                      aria-label="Wallet address for replies"
                      value={walletText}
                      placeholder="0x… - your wallet address, to get our reply"
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => setWalletText(e.target.value)}
                    />
                    {wallet && entered !== wallet && (
                      <button type="button" className="dlg-link fb-wallet__reset" onClick={() => setWalletText(wallet)}>Use connected wallet</button>
                    )}
                  </div>
                  {!walletOk && <p className="dlg-err fb-wallet__msg" role="alert">Not a wallet address - it starts with 0x and has 40 characters after that.</p>}
                  {walletWarn && <p className="dlg-warn fb-wallet__msg" role="alert">{walletWarn}</p>}
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
                      rows={6}
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
                <div className="fb-details">
                  <button type="button" className="dlg-link" aria-haspopup="dialog" onClick={() => setPreview(true)}>Show what will be sent</button>
                </div>
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
                {view === 'signin' && wallet && provider && (
                  <button type="button" className="dlg-btn is-small" disabled={signing} title={`Your chat is kept on ${short(wallet)}: one free signature, never a transaction`} onClick={() => void signIn()}>
                    {signing ? 'Waiting for your wallet…' : 'Sign in to read replies'}
                  </button>
                )}
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
      <Modal open={open && preview} size="md" title="What will be sent" className="fx fb-preview" onClose={() => setPreview(false)}>
        <div className="dlg">
          <dl className="fb-sent">
            <div><dt>Kind</dt><dd>{CATEGORIES.find((c) => c.value === category)?.label}{areas.length > 0 && ` · ${areas.map(areaLabel).join(', ')}`}</dd></div>
            <div><dt>Wallet</dt><dd>{sendWallet ? `${sendWallet}${signedSend ? ' (signed in)' : walletTyped ? ' (typed in - not the connected wallet)' : ''}` : 'None - no reply can reach you'}</dd></div>
            <div><dt>Message</dt><dd>{len} characters{shots.length > 0 && `, ${shots.length} screenshot${shots.length === 1 ? '' : 's'}`}</dd></div>
            {context
              ? contextRows(context).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)
              : <div><dt>Page and browser info</dt><dd>Not included</dd></div>}
          </dl>
          <p className="dlg-note">Nothing else: no balances, no keys, nothing that identifies you beyond the wallet address.</p>
          <DlgFoot>
            <button type="button" className="dlg-btn" onClick={() => setPreview(false)}>Close</button>
          </DlgFoot>
        </div>
      </Modal>
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
