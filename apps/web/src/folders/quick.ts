/**
 * Saving something into a folder in one move - what the rail's quick drop
 * (QuickDrop.tsx) and the Knowledge page share:
 *
 *   files           uploaded, one item each (an image, a PDF, a text file)
 *   a folder item   moved (dragged out of the Knowledge page's tree)
 *   a news story    saved as it is (dragged out of the News widget)
 *   a post on X     its link: read by our server from X's embed, saved as a tweet
 *   a link          a doc with the link in it
 *   text            a doc, titled by its first line
 *
 * And the empty items the page makes. Everything goes through the server (state.ts
 * `change`): a full folder or the wallet's quota is the server's own sentence.
 */
import type { BoardData, DocData, DocNode, SheetData, TweetData } from '@sign/folders/types.js';
import { findTweetUrl } from '@sign/folders/tweetUrl.js';
import type { SavedNews } from './bridge';
import { foldersApi } from './api';
import { change, foldersState, moveItem, putSummary } from './state';

/** What was dropped, read once from the drag (a DataTransfer is only readable during the drop). */
export type Dropped =
  | { kind: 'files'; files: File[] }
  | { kind: 'item'; id: string }
  | { kind: 'news'; news: SavedNews }
  | { kind: 'text'; text: string };

/** The drag types this app sets itself (drag.ts, so a drag source need not load this module). */
import { DRAG_ITEM, DRAG_NEWS } from './drag';
export { DRAG_ITEM, DRAG_NEWS };

/** Whether a drag carries something a folder can keep (checked on dragenter, before the data can be read). */
export function canKeep(types: readonly string[]): boolean {
  return types.some((t) => t === 'Files' || t === DRAG_ITEM || t === DRAG_NEWS || t === 'text/uri-list' || t === 'text/plain');
}

export function readDrop(dt: DataTransfer): Dropped | null {
  if (dt.files.length) return { kind: 'files', files: Array.from(dt.files) };
  const item = dt.getData(DRAG_ITEM);
  if (item) return { kind: 'item', id: item };
  const news = dt.getData(DRAG_NEWS);
  if (news) {
    try {
      const n = JSON.parse(news) as SavedNews;
      if (n && typeof n.href === 'string' && typeof n.title === 'string') return { kind: 'news', news: n };
    } catch {
      /* not ours after all */
    }
  }
  const uri = dt.getData('text/uri-list').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
  const text = (uri || dt.getData('text/plain')).trim();
  return text ? { kind: 'text', text } : null;
}

/* ------------------------------------------------------------- empty items ----- */

export const emptyDoc = (): DocData => ({ v: 1, doc: { type: 'doc', content: [{ type: 'paragraph', attrs: { textAlign: null } }] } });
export const emptySheet = (): SheetData => ({ v: 1, sheets: [{ id: 's1', name: 'Sheet1', cells: {} }] });
export const emptyBoard = (): BoardData => ({ v: 1, elements: [], bg: 'dots' });

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** A line as text nodes, its links as links. */
function lineNodes(line: string): DocNode[] {
  const out: DocNode[] = [];
  let at = 0;
  for (const m of line.matchAll(URL_RE)) {
    if (m.index! > at) out.push({ type: 'text', text: line.slice(at, m.index) });
    out.push({ type: 'text', text: m[0], marks: [{ type: 'link', attrs: { href: m[0] } }] });
    at = m.index! + m[0].length;
  }
  if (at < line.length) out.push({ type: 'text', text: line.slice(at) });
  return out;
}

/** Plain text as a doc: a paragraph per block, a line break where the text has one, links kept as links. */
export function docFromText(text: string): DocData {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const content: DocNode[] = blocks.map((b) => {
    const kids: DocNode[] = [];
    b.split('\n').forEach((line, i) => {
      if (i > 0) kids.push({ type: 'hardBreak' });
      kids.push(...lineNodes(line));
    });
    return { type: 'paragraph', attrs: { textAlign: null }, ...(kids.length ? { content: kids } : {}) };
  });
  return { v: 1, doc: { type: 'doc', content: content.length ? content : [{ type: 'paragraph', attrs: { textAlign: null } }] } };
}

/** A title out of text: its first line, at most 80 characters. */
export function titleOf(text: string, fallback = 'Quick note'): string {
  const first = text.trim().split('\n')[0]!.replace(/\s+/g, ' ').trim();
  if (!first) return fallback;
  if (/^https?:\/\//i.test(first)) {
    try {
      const u = new URL(first);
      return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 80);
    } catch {
      /* not a URL after all */
    }
  }
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/* ------------------------------------------------------------------ saving ----- */

export interface Saved {
  /** The item made (or moved). */
  id: string | null;
  /** What happened, in a few words for a toast. */
  said: string;
}

/**
 * A post on X into a folder: read by the server from X's embed; when X will not
 * show it, the link alone is kept (the user can still write about it).
 */
export async function saveTweet(url: string, folderId: string, extra: { note?: string; tags?: string[] } = {}): Promise<Saved | null> {
  const ref = findTweetUrl(url);
  if (!ref) return null;
  const token = foldersState().token;
  if (!token) return null;
  let tweet: TweetData;
  try {
    tweet = { ...(await foldersApi.tweet(token, ref.url)), ...extra };
  } catch {
    tweet = { url: ref.url, id: ref.id, handle: ref.handle, author: ref.handle, text: '', time: null, fetched: false, ...extra };
  }
  const title = tweet.author ? `${tweet.author}${tweet.handle && tweet.handle !== tweet.author ? ` (@${tweet.handle})` : ''}` : `Post ${ref.id}`;
  const item = await change((t) => foldersApi.createItem(t, { folderId, kind: 'tweet', title: title.slice(0, 120), data: tweet }), (it) => void putSummary(it));
  return item ? { id: item.id, said: tweet.fetched ? 'Post saved' : 'Link to the post saved (X did not show its text)' } : null;
}

/** Text or a link as a doc; a link to a post on X as a tweet. */
export async function saveText(text: string, folderId: string): Promise<Saved | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const tweet = findTweetUrl(trimmed);
  // A post's link alone (or with a word or two around it) is a post; a longer text that quotes one stays a note.
  if (tweet && trimmed.length < tweet.url.length + 60) return saveTweet(tweet.url, folderId);
  const item = await change(
    (t) => foldersApi.createItem(t, { folderId, kind: 'doc', title: titleOf(trimmed), data: docFromText(trimmed) }),
    (it) => void putSummary(it),
  );
  return item ? { id: item.id, said: /^https?:\/\/\S+$/i.test(trimmed) ? 'Link saved' : 'Note saved' } : null;
}

export async function saveNews(news: SavedNews, folderId: string): Promise<Saved | null> {
  const item = await change(
    (t) => foldersApi.createItem(t, { folderId, kind: 'news', title: news.title.slice(0, 120), data: news }),
    (it) => void putSummary(it),
  );
  return item ? { id: item.id, said: 'Story saved' } : null;
}

/** Files, one after the other; `onProgress` hears which and how far. Stops at the first refusal. */
export async function saveFiles(files: File[], folderId: string, onProgress?: (name: string, share: number) => void): Promise<Saved | null> {
  const limits = foldersState().list?.limits;
  let last: string | null = null;
  let n = 0;
  for (const f of files) {
    if (limits && f.size > limits.fileBytes) continue;
    onProgress?.(f.name, 0);
    const it = await change(
      (t) => foldersApi.upload(t, { folderId, file: f, name: f.name }, (share) => onProgress?.(f.name, share)),
      (r) => void putSummary(r),
    );
    if (!it) break;
    last = it.id;
    n++;
  }
  return n ? { id: last, said: n === 1 ? 'File saved' : `${n} files saved` } : null;
}

/** Whatever was dropped, into a folder. */
export async function saveDropped(d: Dropped, folderId: string, onProgress?: (name: string, share: number) => void): Promise<Saved | null> {
  switch (d.kind) {
    case 'files':
      return saveFiles(d.files, folderId, onProgress);
    case 'item': {
      const f = foldersState().list?.folders.find((x) => x.id === folderId);
      if (!f || f.items.some((i) => i.id === d.id)) return null;
      const r = await moveItem(d.id, folderId, f.items.length);
      return r ? { id: d.id, said: `Moved to ${f.name}` } : null;
    }
    case 'news':
      return saveNews(d.news, folderId);
    case 'text':
      return saveText(d.text, folderId);
  }
}
