/**
 * A post on X by its link - x.com or twitter.com, with or without www or
 * mobile, /<handle>/status/<id> or /i/web/status/<id>, any query or fragment.
 * Pure (no Node import): the web reads links with it too (the quick drop, a
 * paste into the Knowledge page) through the `@sign` alias.
 */

export interface TweetRef {
  id: string;
  /** Without @; '' when the link does not name the account (/i/web/status/…). */
  handle: string;
  /** The canonical link: https://x.com/<handle or i>/status/<id>. */
  url: string;
}

const HOSTS = new Set(['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com', 'mobile.x.com', 'mobile.twitter.com']);
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const ID = /^\d{1,25}$/;

export function parseTweetUrl(raw: unknown): TweetRef | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s || s.length > 2048) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || !HOSTS.has(u.hostname.toLowerCase())) return null;
  const seg = u.pathname.split('/').filter(Boolean);
  let handle = '';
  let id = '';
  if (seg[0] === 'i' && seg[1] === 'web' && seg[2] === 'status') id = seg[3] ?? '';
  else if (seg[0] === 'i' && seg[1] === 'status') id = seg[2] ?? '';
  else if ((seg[1] === 'status' || seg[1] === 'statuses') && seg[0] && HANDLE.test(seg[0])) {
    handle = seg[0];
    id = seg[2] ?? '';
  }
  if (!ID.test(id)) return null;
  return { id, handle, url: `https://x.com/${handle || 'i'}/status/${id}` };
}

/** The first link to a post on X in some text (a paste, a drop), or null. */
export function findTweetUrl(text: string): TweetRef | null {
  for (const m of text.matchAll(/(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^\s<>"']+/gi)) {
    const r = parseTweetUrl(m[0]);
    if (r) return r;
  }
  return null;
}
