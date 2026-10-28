/**
 * This browser's feedback conversations (apps/server routes/reports.ts,
 * ops/feedbackThreads.ts).
 *
 * The chat is always a wallet's, and only the wallet's signature reads it
 * (session.ts). What this browser keeps is a random token per wallet it sent
 * for (32 bytes from crypto.getRandomValues; `wallet` unset: sent with no wallet
 * connected), in localStorage, with how many of the owner's replies were already
 * seen and announced. The token reads NOTHING: it is what an unsigned message is
 * sent with (Authorization header, never a URL; the server keeps only its hash),
 * and - the one without a wallet - what joins the wallet's chat at the first
 * sign-in (attach). It never tells anything about a chat, not even a count.
 *
 * At most MAX_THREADS are kept (the server's poll takes as many).
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
  /** The wallet whose chat this token sent into (or, after a sign-in, joined); unset: no wallet. */
  wallet?: string;
}

export interface ChatMessage {
  id: number;
  from: 'user' | 'owner';
  text: string;
  at: number;
  images: string[];
  category?: string | null;
  areas?: string[];
  /** False: sent with this wallet's address but without its signature. */
  proven?: boolean;
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
      .map((t): ThreadRef => ({
        token: t.token,
        startedAt: t.startedAt,
        seenOwner: Number(t.seenOwner) || 0,
        notifiedOwner: Number(t.notifiedOwner) || 0,
        preview: typeof t.preview === 'string' ? t.preview : '',
        ...(typeof t.wallet === 'string' && /^0x[0-9a-f]{40}$/.test(t.wallet) ? { wallet: t.wallet } : {}),
      }))
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

/** The token this browser sends with for `wallet` (null: no wallet connected) - the one it has, or a new one. */
export function tokenFor(wallet: string | null): string {
  const w = wallet?.toLowerCase();
  return threads().find((t) => (w ? t.wallet === w : !t.wallet))?.token ?? newToken();
}

/** Remember a token (newest first) once a message went out with it, for `wallet` (null: none). */
export function rememberThread(token: string, preview: string, wallet: string | null = null, now = Date.now()): void {
  const rest = threads().filter((t) => t.token !== token);
  const prev = threads().find((t) => t.token === token);
  const w = wallet?.toLowerCase();
  save([prev ?? { token, startedAt: now, seenOwner: 0, notifiedOwner: 0, preview: preview.slice(0, 80), ...(w ? { wallet: w } : {}) }, ...rest]);
}

/** The chat this token opened is kept on `wallet` now (the server attached it at the sign-in). */
export function markAttached(token: string, wallet: string): void {
  save(threads().map((t) => (t.token === token ? { ...t, wallet: wallet.toLowerCase() } : t)));
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

/**
 * The chat a key opens (a thread token or a wallet session), oldest message
 * first. `none`: the server has no chat for it yet; `wallet`: it is kept on a
 * wallet - only that wallet's sign-in opens it; `session`: the wallet's sign-in
 * expired; null: the server cannot be reached.
 */
export type ThreadLoad =
  | { status: 'ok'; messages: ChatMessage[]; wallet: string | null }
  | { status: 'none' | 'wallet' | 'session' };

export async function loadThread(key: string, f: typeof fetch = fetch): Promise<ThreadLoad | null> {
  try {
    const r = await postJson('/api/vs/feedback/thread', {}, authed(key), f);
    if (r.status === 200 && Array.isArray(r.json?.messages)) {
      const w = (r.json!.thread as { wallet?: unknown } | undefined)?.wallet;
      return { status: 'ok', messages: r.json!.messages as ChatMessage[], wallet: typeof w === 'string' ? w : null };
    }
    if (r.status === 404) return { status: 'none' };
    if (r.status === 401 && r.json?.code === 'wallet') return { status: 'wallet' };
    if (r.status === 401 && r.json?.code === 'session') return { status: 'session' };
    return null;
  } catch {
    return null;
  }
}

export type ReplyCount = { owner: number; lastOwnerAt: number | null } | null;

/**
 * How many owner replies the signed-in wallet's chat has (null: no chat yet), or
 * null when it failed. Only with the wallet's session: without it the server
 * tells nothing about a chat, not even a count.
 */
export async function pollWallet(session: string, f: typeof fetch = fetch): Promise<{ wallet: ReplyCount } | null> {
  try {
    const r = await postJson('/api/vs/feedback/poll', {}, authed(session), f);
    if (r.status !== 200 || r.json?.ok !== true) return null;
    return { wallet: (r.json.wallet as ReplyCount | undefined) ?? null };
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
