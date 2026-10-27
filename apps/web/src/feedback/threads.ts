/**
 * This browser's feedback conversations (apps/server routes/reports.ts,
 * ops/feedbackThreads.ts).
 *
 * A thread is a random token made here (32 bytes from crypto.getRandomValues),
 * kept in localStorage with how many of the owner's replies were already seen.
 * The token is the only key to the thread: it goes to the server in the
 * Authorization header (poll: in the body), never in a URL, and the server keeps
 * only its hash. Clearing this browser's storage loses the thread for good.
 *
 * At most MAX_THREADS are kept (the server's poll takes as many); the newest is
 * "the" conversation the form opens on.
 */

export const STORAGE_KEY = 'vs.feedback.threads.v1';
export const MAX_THREADS = 10;
export const CHANGED_EVENT = 'vs:feedback-threads';
/** A new reply in the thread the chat shows (FeedbackHost tells the dialog; detail: the token). */
export const REPLY_EVENT = 'vs:feedback-reply';

export interface ThreadRef {
  token: string;
  startedAt: number;
  /** The owner's replies already shown to the visitor (the chat was open with them). */
  seenOwner: number;
  /** The owner's replies already announced (bell and toast), so a reply is announced once. */
  notifiedOwner: number;
  /** The first words of the first message, for the list. */
  preview: string;
}

export interface ChatMessage {
  id: number;
  from: 'user' | 'owner';
  text: string;
  at: number;
  images: string[];
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function threads(): ThreadRef[] {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((t): t is ThreadRef => !!t && typeof t.token === 'string' && TOKEN_RE.test(t.token) && typeof t.startedAt === 'number')
      .map((t) => ({ ...t, seenOwner: Number(t.seenOwner) || 0, notifiedOwner: Number(t.notifiedOwner) || 0, preview: typeof t.preview === 'string' ? t.preview : '' }))
      .slice(0, MAX_THREADS);
  } catch {
    return [];
  }
}

function save(list: ThreadRef[]): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_THREADS)));
  } catch {
    /* private mode: the thread lives as long as the tab */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

/** A new random token: 32 bytes, base64url, 43 characters. */
export function newToken(random: (b: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Remember a thread (newest first) once its first message went out. */
export function rememberThread(token: string, preview: string, now = Date.now()): void {
  const rest = threads().filter((t) => t.token !== token);
  const prev = threads().find((t) => t.token === token);
  save([prev ?? { token, startedAt: now, seenOwner: 0, notifiedOwner: 0, preview: preview.slice(0, 80) }, ...rest]);
}

export function markSeen(token: string, owner: number): void {
  save(threads().map((t) => (t.token === token ? { ...t, seenOwner: Math.max(t.seenOwner, owner), notifiedOwner: Math.max(t.notifiedOwner, owner) } : t)));
}

export function markNotified(token: string, owner: number): void {
  save(threads().map((t) => (t.token === token ? { ...t, notifiedOwner: Math.max(t.notifiedOwner, owner) } : t)));
}

/** Replies the poll found that were not announced yet: [token, owner count]. */
export function unannounced(list: readonly ThreadRef[], counts: ReadonlyArray<{ owner: number } | null>): Array<{ token: string; owner: number; fresh: number }> {
  const out: Array<{ token: string; owner: number; fresh: number }> = [];
  list.forEach((t, i) => {
    const c = counts[i];
    if (c && c.owner > t.notifiedOwner && c.owner > t.seenOwner) out.push({ token: t.token, owner: c.owner, fresh: c.owner - Math.max(t.notifiedOwner, t.seenOwner) });
  });
  return out;
}

const authed = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}, f: typeof fetch = fetch): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await f(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    credentials: 'omit',
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/** The thread's messages, oldest first; null when the server has no such thread (or cannot be reached). */
export async function loadThread(token: string, f: typeof fetch = fetch): Promise<ChatMessage[] | null> {
  try {
    const r = await postJson('/api/vs/feedback/thread', {}, authed(token), f);
    return r.status === 200 && Array.isArray(r.json?.messages) ? (r.json!.messages as ChatMessage[]) : null;
  } catch {
    return null;
  }
}

/** For each kept thread, how many owner replies it has (null: unknown to the server). */
export async function pollThreads(tokens: readonly string[], f: typeof fetch = fetch): Promise<Array<{ owner: number; lastOwnerAt: number | null } | null> | null> {
  if (!tokens.length) return [];
  try {
    const r = await postJson('/api/vs/feedback/poll', { tokens }, {}, f);
    return r.status === 200 && Array.isArray(r.json?.threads) ? (r.json!.threads as Array<{ owner: number; lastOwnerAt: number | null } | null>) : null;
  } catch {
    return null;
  }
}

/** Upload one screenshot (already re-encoded, images.ts): its id, or a sentence why not. */
export async function uploadImage(token: string, blob: Blob, f: typeof fetch = fetch): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const res = await f('/api/vs/feedback/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...authed(token) }, body: blob, credentials: 'omit' });
    const j = (await res.json().catch(() => null)) as { ok?: boolean; id?: string; error?: string } | null;
    if (res.ok && j?.ok && typeof j.id === 'string') return { ok: true, id: j.id };
    if (res.status === 413) return { ok: false, error: 'That screenshot is larger than 2 MB.' };
    if (res.status === 429) return { ok: false, error: 'Too many screenshots just now - please wait a few minutes.' };
    return { ok: false, error: j?.error ? `The screenshot was refused: ${j.error}.` : 'The screenshot could not be uploaded.' };
  } catch {
    return { ok: false, error: 'The screenshot could not be uploaded - check your connection.' };
  }
}

/** A screenshot of the thread as an object URL for an <img> (the caller revokes it). */
export async function imageUrl(token: string, id: string, f: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await f(`/api/vs/feedback/image?id=${encodeURIComponent(id)}`, { headers: authed(token), credentials: 'omit' });
    if (!res.ok || !/^image\/(png|jpeg|webp)$/.test(res.headers.get('content-type') ?? '')) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

export { authed as authHeaders, postJson };
