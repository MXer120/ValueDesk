/**
 * Posts on X, saved by their link (the server reads each from X's own embed
 * endpoint: folders/tweets.ts on the server - the page loads nothing from X):
 *
 *   TweetView       one post as it was saved, with the user's note and tags
 *   TweetsWall      every saved post in one place, to search, filter by tag and
 *                   by account, and sort
 *   AddTweetDialog  a link in, a preview of the post, into a folder with tags
 *
 * A post is plain text here: its links are shown as links (http and https
 * only), nothing in it is markup.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { FolderLimits, FolderSummary, ItemSummary, TweetData } from '@sign/folders/types.js';
import { findTweetUrl } from '@sign/folders/tweetUrl.js';
import { Modal } from '../components/Modal';
import { DlgFoot } from '../components/dialogParts';
import { foldersApi } from '../folders/api';
import { foldersState } from '../folders/state';
import { ConflictBar, useEditorSave, type EditorProps } from './editing';
import { when } from './views';

const TAG_RE = /^[\p{L}\p{N}_-]{1,32}$/u;
export const cleanTag = (t: string): string | null => {
  const tag = t.trim().replace(/^#/, '').toLowerCase();
  return TAG_RE.test(tag) ? tag : null;
};

/** Text with its http(s) links as links; everything else as text. */
export function Linked({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g)) {
    if (m.index! > at) parts.push(text.slice(at, m.index));
    parts.push(<a key={m.index} href={m[0]} target="_blank" rel="noopener noreferrer nofollow">{m[0].replace(/^https?:\/\//, '')}</a>);
    at = m.index! + m[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** A round initial for an account: no picture is fetched from X. */
function Avatar({ handle, name, size = 36 }: { handle: string; name: string; size?: number }) {
  let h = 0;
  for (const c of handle || name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span className="kt-avatar" style={{ width: size, height: size, background: `hsl(${h % 360} 45% 32%)`, fontSize: size * 0.42 }} aria-hidden="true">
      {(name || handle || '?').trim().charAt(0).toUpperCase()}
    </span>
  );
}

function PostCard({ t, full = true }: { t: Pick<TweetData, 'author' | 'handle' | 'text' | 'time' | 'url' | 'fetched'>; full?: boolean }) {
  return (
    <div className="kt-post">
      <div className="kt-post__who">
        <Avatar handle={t.handle} name={t.author} />
        <span className="kt-post__names">
          <b>{t.author || (t.handle ? `@${t.handle}` : 'A post on X')}</b>
          <span>{[t.handle ? `@${t.handle}` : null, t.time ? when(t.time) : null].filter(Boolean).join(' · ')}</span>
        </span>
      </div>
      {t.text ? (
        <p className={`kt-post__text${full ? '' : ' is-clipped'}`}><Linked text={t.text} /></p>
      ) : (
        <p className="kt-post__none">X did not show this post's text when it was saved (deleted, private, or not public). The link is kept.</p>
      )}
    </div>
  );
}

function Tags({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [v, setV] = useState('');
  const add = () => {
    const next = [...tags];
    for (const raw of v.split(/[,\s]+/)) {
      const t = cleanTag(raw);
      if (t && !next.includes(t) && next.length < 12) next.push(t);
    }
    setV('');
    if (next.length !== tags.length) onChange(next);
  };
  return (
    <div className="kt-tags">
      {tags.map((t) => (
        <span key={t} className="kt-tag">
          #{t}
          <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
            <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </span>
      ))}
      {tags.length < 12 && (
        <input
          className="kt-tags__input"
          value={v}
          placeholder={tags.length ? 'Add a tag' : 'Tags: macro, btc, thesis…'}
          aria-label="Add a tag"
          onChange={(e) => setV(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add();
            } else if (e.key === 'Backspace' && !v && tags.length) onChange(tags.slice(0, -1));
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- one post ----- */

export function TweetView({ item, data, limitBytes, onStatus }: EditorProps<TweetData>) {
  const [t, setT] = useState<TweetData>(data);
  const cur = useRef(t);
  cur.current = t;
  const save = useEditorSave(item, () => cur.current, limitBytes, onStatus);
  const [reading, setReading] = useState(false);

  const change = (patch: Partial<TweetData>) => {
    setT((x) => ({ ...x, ...patch }));
    save.touched();
  };

  const readAgain = async () => {
    const token = foldersState().token;
    if (!token) return;
    setReading(true);
    try {
      const fresh = await foldersApi.tweet(token, t.url);
      change({ ...fresh, note: t.note, tags: t.tags });
    } catch {
      /* still not shown: nothing changes */
    }
    setReading(false);
  };

  return (
    <div className="kt kn-pad">
      <ConflictBar status={save.status} message={save.message} onKeep={save.keepMine} onLoad={() => void save.loadTheirs().then((f) => f && setT(f.data as TweetData))} />
      <PostCard t={t} />
      <div className="kt__acts">
        <a className="fx-cta kt__open" href={t.url} target="_blank" rel="noopener noreferrer nofollow">Open on X</a>
        {!t.fetched && <button type="button" className="fx-cta fx-cta--ghost kt__open" disabled={reading} onClick={() => void readAgain()}>{reading ? 'Asking X…' : 'Try reading it again'}</button>}
      </div>
      <label className="kt__label" htmlFor="kt-note">Your note</label>
      <textarea id="kt-note" className="kt__note" rows={4} value={t.note ?? ''} maxLength={5000} placeholder="Why it matters, what it would mean for a trade…" onChange={(e) => change({ note: e.target.value })} />
      <span className="kt__label">Tags</span>
      <Tags tags={t.tags ?? []} onChange={(tags) => change({ tags })} />
      <p className="kt__fine">Saved from {t.url.replace(/^https:\/\//, '')}. The text is as X's embed showed it then; our server asked X for it, your browser did not.</p>
    </div>
  );
}

/* ---------------------------------------------------------- every saved post ----- */

export function TweetsWall({ posts, onOpen, onMenu, onAdd }: { posts: ItemSummary[]; onOpen: (id: string) => void; onMenu: (e: ReactMouseEvent, it: ItemSummary) => void; onAdd: () => void }) {
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [who, setWho] = useState<string | null>(null);
  const [sort, setSort] = useState<'saved' | 'posted'>('saved');
  const tags = useMemo(() => count(posts.flatMap((p) => p.meta.tags ?? [])), [posts]);
  const authors = useMemo(() => count(posts.map((p) => p.meta.handle ?? '').filter(Boolean)), [posts]);
  const needle = q.trim().toLowerCase();
  const shown = posts
    .filter((p) => (!tag || (p.meta.tags ?? []).includes(tag)) && (!who || p.meta.handle === who))
    .filter((p) => !needle || `${p.title} ${p.meta.excerpt ?? ''} ${p.meta.handle ?? ''}`.toLowerCase().includes(needle))
    .sort((a, b) => (sort === 'saved' ? b.createdAt - a.createdAt : (b.meta.time ?? 0) - (a.meta.time ?? 0)));
  return (
    <section className="kt-wall">
      <header className="kt-wall__head">
        <div>
          <h1 className="kn-folder__name">Saved posts</h1>
          <span className="kn-folder__count">{posts.length} from X, across your folders</span>
        </div>
        <button type="button" className="fx-cta kt-wall__add" onClick={onAdd}>Add a post</button>
      </header>
      {posts.length > 0 && (
        <div className="kt-wall__filters">
          <label className="kn__search kt-wall__search">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.3" /><path d="m10.3 10.3 3 3" /></svg>
            <input value={q} placeholder="Search posts" aria-label="Search posts" onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="kt-wall__sort" role="group" aria-label="Sort">
            <button type="button" className={sort === 'saved' ? 'is-on' : ''} onClick={() => setSort('saved')}>Newest saved</button>
            <button type="button" className={sort === 'posted' ? 'is-on' : ''} onClick={() => setSort('posted')}>Newest posted</button>
          </div>
          {tags.length > 0 && (
            <div className="kt-chips" role="group" aria-label="Tags">
              {tags.map(([t, n]) => (
                <button key={t} type="button" className={`kt-chip${tag === t ? ' is-on' : ''}`} onClick={() => setTag(tag === t ? null : t)}>#{t}<small>{n}</small></button>
              ))}
            </div>
          )}
          {authors.length > 1 && (
            <div className="kt-chips" role="group" aria-label="Accounts">
              {authors.slice(0, 24).map(([h, n]) => (
                <button key={h} type="button" className={`kt-chip${who === h ? ' is-on' : ''}`} onClick={() => setWho(who === h ? null : h)}>@{h}<small>{n}</small></button>
              ))}
            </div>
          )}
        </div>
      )}
      {posts.length === 0 ? (
        <p className="kn-folder__hint">
          No posts yet. Paste a link to a post on X anywhere on this page, drag one onto the Knowledge button in the rail, or add one here - the post's text is kept with your note and tags.
        </p>
      ) : (
        <div className="kt-wall__grid">
          {shown.map((p) => (
            <button
              key={p.id}
              type="button"
              className="kt-wall__card"
              draggable
              onDragStart={(e) => e.dataTransfer.setData('application/x-vd-folder-item', p.id)}
              onClick={() => onOpen(p.id)}
              onContextMenu={(e) => onMenu(e, p)}
            >
              <PostCard t={{ author: p.meta.author ?? '', handle: p.meta.handle ?? '', text: p.meta.excerpt ?? '', time: p.meta.time ?? null, url: p.meta.href ?? '', fetched: !!p.meta.excerpt }} full={false} />
              {(p.meta.tags ?? []).length > 0 && <span className="kt-wall__tags">{p.meta.tags!.map((t) => `#${t}`).join(' ')}</span>}
            </button>
          ))}
          {shown.length === 0 && <p className="kn-folder__hint">Nothing matches.</p>}
        </div>
      )}
    </section>
  );
}

function count(xs: string[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/* --------------------------------------------------------------- add a post ----- */

export function AddTweetDialog({ initialUrl, folders, limits, defaultFolder, onClose, onSave }: {
  initialUrl: string;
  folders: FolderSummary[];
  limits: FolderLimits | null;
  defaultFolder: string | null;
  onClose: () => void;
  onSave: (url: string, folderId: string, extra: { note?: string; tags?: string[] }) => Promise<boolean>;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [folderId, setFolderId] = useState(defaultFolder ?? folders[0]?.id ?? '');
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<{ for: string; tweet: Omit<TweetData, 'note' | 'tags'> | null; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = findTweetUrl(url);

  // A preview of the post, a moment after the link is complete.
  useEffect(() => {
    if (!ref) return;
    const token = foldersState().token;
    if (!token || preview?.for === ref.url) return;
    const t = setTimeout(() => {
      foldersApi.tweet(token, ref.url).then(
        (tweet) => setPreview({ for: ref.url, tweet, error: null }),
        (e) => setPreview({ for: ref.url, tweet: null, error: e instanceof Error ? e.message : 'X did not answer.' }),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [ref?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  const full = (f: FolderSummary) => !!limits && f.items.length >= limits.itemsPerFolder;
  const save = async () => {
    if (!ref || !folderId || busy) return;
    setBusy(true);
    const ok = await onSave(ref.url, folderId, { ...(note.trim() ? { note: note.trim() } : {}), ...(tags.length ? { tags } : {}) });
    if (!ok) setBusy(false);
  };
  const shown = preview && ref && preview.for === ref.url ? preview : null;

  return (
    <Modal
      open
      className="fx kt-add"
      title="Save a post from X"
      onClose={onClose}
      footer={
        <DlgFoot>
          <button type="button" className="dlg-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="dlg-btn is-go" disabled={!ref || !folderId || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save post'}</button>
        </DlgFoot>
      }
    >
      <div className="kt-add__body dlg">
        <label className="dlg-label kf-save__label" htmlFor="kt-url">Link to the post</label>
        <span className="dlg-field is-wide"><input id="kt-url" value={url} autoFocus placeholder="https://x.com/…/status/…" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} /></span>
        {url && !ref && <p className="fx-note fx-note--warn">That is not a link to a post on x.com or twitter.com.</p>}
        {ref && !shown && <p className="fx-wait"><span className="fx-spin" aria-hidden="true" />Asking X for the post…</p>}
        {shown?.tweet && <PostCard t={shown.tweet} />}
        {shown?.error && <p className="fx-note">{shown.error}</p>}
        <label className="dlg-label kf-save__label" htmlFor="kt-folder">Folder</label>
        <select id="kt-folder" className="dlg-select kt-add__sel" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          {folders.map((f) => <option key={f.id} value={f.id} disabled={full(f)}>{f.name}{full(f) ? ' (full)' : ''}</option>)}
        </select>
        <span className="dlg-label kf-save__label">Tags</span>
        <Tags tags={tags} onChange={setTags} />
        <label className="dlg-label kf-save__label" htmlFor="kt-addnote">Your note</label>
        <textarea id="kt-addnote" className="kt__note" rows={3} value={note} maxLength={5000} placeholder="Optional" onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}
