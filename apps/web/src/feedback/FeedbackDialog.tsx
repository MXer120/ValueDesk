/**
 * The feedback chat (feedback.ts): this browser's conversation with the
 * ValueDesk team - what was said so far, and the box to say more.
 *
 * A message can take up to three screenshots (pasted, or picked as PNG, JPEG or
 * WebP; re-encoded before they leave - images.ts), the element right-clicked to
 * open the form (a chip, removable), and the page and browser info - on by
 * default, marked Recommended, every line of it shown under "What will be sent".
 * The wallet's address goes only with its own tick. A text that holds a private
 * key or a seed phrase is not sent (secretIn): the form says so in red.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { Modal } from '../components/Modal';
import { DlgFoot, DlgSection, DlgSeg, DlgSwitch, DlgRow } from '../components/dialogParts';
import { FEEDBACK_MAX, FEEDBACK_URL, messageLength, secretIn, sendMessage, type FeedbackCategory } from './feedback';
import { buildContext, connectedWallet, contextRows, gatherSources, type ContextSources } from './context';
import { elementSummary, type ElementInfo } from './element';
import { ACCEPT, MAX_IMAGES, acceptable, reencode } from './images';
import { REPLY_EVENT, imageUrl, loadThread, markSeen, newToken, rememberThread, threads, uploadImage, type ChatMessage } from './threads';
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

interface Shot {
  key: number;
  url: string;
  blob: Blob;
}

const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function FeedbackDialog({ open, request, onClose, onThread }: {
  open: boolean;
  request: OpenFeedback | null;
  onClose: () => void;
  /** The thread on screen (FeedbackHost: a reply to it is shown here, not announced). */
  onThread: (token: string) => void;
}) {
  const [token, setToken] = useState<string>(() => threads()[0]?.token ?? newToken());
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [text, setText] = useState('');
  const [shots, setShots] = useState<Shot[]>([]);
  const [element, setElement] = useState<ElementInfo | null>(null);
  const [withContext, setWithContext] = useState(true);
  const [withWallet, setWithWallet] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [website, setWebsite] = useState('');
  const [sources, setSources] = useState<ContextSources | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shotKey = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const wallet = useMemo(() => (open ? connectedWallet() : null), [open]);

  // Each opening: the thread asked for (a reply in the bell), the element right-clicked, fresh page info.
  useEffect(() => {
    if (!open) return;
    if (request?.thread) setToken(request.thread);
    if (request?.element) setElement(request.element);
    setError(null);
    void gatherSources().then(setSources).catch(() => setSources(null));
  }, [open, request]);

  const known = useMemo(() => threads().some((t) => t.token === token), [token, history]);
  const reload = useCallback(async () => {
    if (!threads().some((t) => t.token === token)) {
      setHistory([]);
      return;
    }
    const msgs = await loadThread(token);
    if (!msgs) return;
    setHistory(msgs);
    markSeen(token, msgs.filter((m) => m.from === 'owner').length);
  }, [token]);

  useEffect(() => {
    if (!open) return;
    onThread(token);
    void reload();
    const onReply = (e: Event) => {
      if ((e as CustomEvent<string>).detail === token) void reload();
    };
    window.addEventListener(REPLY_EVENT, onReply);
    return () => window.removeEventListener(REPLY_EVENT, onReply);
  }, [open, token, reload, onThread]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [history]);

  const context = sources && withContext ? buildContext(sources, element) : null;
  const len = messageLength(text);
  const secret = text ? secretIn(text) : null;
  const canSend = !busy && len >= 1 && len <= FEEDBACK_MAX && !secret;

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
  const dropShot = (key: number) => setShots((s) => s.filter((x) => (x.key === key ? (URL.revokeObjectURL(x.url), false) : true)));

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    const ids: string[] = [];
    for (const s of shots) {
      const r = await uploadImage(token, s.blob);
      if (!r.ok) {
        setError(r.error);
        setBusy(false);
        return;
      }
      ids.push(r.id);
    }
    const r = await sendMessage(token, { category, message: text, images: ids, context, wallet: withWallet ? wallet : null, website });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    rememberThread(token, text);
    setText('');
    shots.forEach((s) => URL.revokeObjectURL(s.url));
    setShots([]);
    setElement(null);
    await reload();
  };

  const startNew = () => {
    setToken(newToken());
    setHistory([]);
    setText('');
    setError(null);
  };

  return (
    <Modal open={open} size="md" title={history.length ? 'Feedback chat' : 'Send feedback'} className="fx fb-dialog" onClose={onClose} dismissOnBackdrop={!text.trim() && !shots.length}>
      <form
        className="dlg fb-form"
        onPaste={onPaste}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {history.length > 0 && (
          <div className="fb-chat" ref={listRef} aria-label="Your conversation with the ValueDesk team" role="log">
            {history.map((m) => (
              <div key={m.id} className={`fb-msg is-${m.from}`}>
                <span className="fb-msg__who">{m.from === 'owner' ? 'ValueDesk team' : 'You'} · {when(m.at)}</span>
                <p className="fb-msg__text">{m.text}</p>
                {m.images.length > 0 && (
                  <span className="fb-msg__shots">{m.images.map((id) => <ThreadImage key={id} token={token} id={id} />)}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {history.length === 0 && (
          <DlgSection label="What is it about">
            <DlgRow title="Kind">
              <DlgSeg label="Kind of feedback" value={category} options={CATEGORIES} onChange={setCategory} />
            </DlgRow>
          </DlgSection>
        )}
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
                  {withWallet && wallet && <div><dt>Wallet address</dt><dd>{wallet}</dd></div>}
                </dl>
              )}
            </div>
          )}
          {wallet && (
            <DlgRow title="Add my wallet address" line="Only if it helps with your question - it lets us look at your account's public trades.">
              <DlgSwitch label="Add my wallet address" on={withWallet} onChange={setWithWallet} />
            </DlgRow>
          )}
        </DlgSection>
        {/* Hidden from people and from assistive tech; a bot that fills in every field fills this in too. */}
        <input className="fb-hp" type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(e) => setWebsite(e.target.value)} />
        <p className="fb-warn" role="note">
          <b>Never</b> put a <b>private key</b>, a <b>seed phrase</b>, <b>passwords</b> or <b>API keys</b> in here - nobody from ValueDesk will ever ask for one. Goes to the ValueDesk team only; our reply appears here and in the bell.
        </p>
        {error && <p className="dlg-err fb-err" role="alert">{error}</p>}
        <DlgFoot
          left={
            <span className="fb-foot-left">
              {FEEDBACK_URL ? (
                <a className="dlg-btn is-small fb-discord" href={FEEDBACK_URL} target="_blank" rel="noopener noreferrer">Discord</a>
              ) : (
                <button type="button" className="dlg-btn is-small fb-discord" disabled title="Our Discord server is coming soon">Discord · coming soon</button>
              )}
              {known && <button type="button" className="dlg-link" onClick={startNew}>New conversation</button>}
            </span>
          }
        >
          <button type="button" className="dlg-btn" onClick={onClose}>Close</button>
          <button type="submit" className="dlg-btn is-go" disabled={!canSend}>{busy ? 'Sending…' : 'Send'}</button>
        </DlgFoot>
      </form>
    </Modal>
  );
}

/** A screenshot of the thread, fetched with the thread's token (no URL could carry it). */
function ThreadImage({ token, id }: { token: string; id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    void imageUrl(token, id).then((u) => {
      made = u;
      if (live) setUrl(u);
      else if (u) URL.revokeObjectURL(u);
    });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [token, id]);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer" className="fb-msg__shot"><img src={url} alt="Screenshot" /></a> : <span className="fb-msg__shot is-loading" />;
}
