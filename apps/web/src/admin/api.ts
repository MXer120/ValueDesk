/**
 * The admin suite's calls (apps/server/src/routes/admin.ts): every one a POST to
 * /api/admin/<path> with the session token. The server decides everything - this
 * file only carries the token and reports what it says.
 *
 * The session (token, wallet, end) is kept in this host's localStorage
 * (vd.admin.session.v1): dev.valuedesk.so is its own origin, so nothing on the
 * site can read it. It ends after 24 hours whatever this file thinks - the
 * server keeps the time - and is dropped here at the first 401.
 */

import { forgetAll } from './cache';

export interface AdminSession {
  token: string;
  wallet: string;
  expiresAt: number;
}

const KEY = 'vd.admin.session.v1';

export function loadSession(now = Date.now()): AdminSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<AdminSession>;
    if (typeof s.token !== 'string' || !/^vda_[A-Za-z0-9_-]{43}$/.test(s.token)) return null;
    if (typeof s.wallet !== 'string' || typeof s.expiresAt !== 'number' || s.expiresAt <= now) return null;
    return { token: s.token, wallet: s.wallet, expiresAt: s.expiresAt };
  } catch {
    return null;
  }
}

const listeners = new Set<(s: AdminSession | null) => void>();
export const onSession = (cb: (s: AdminSession | null) => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function saveSession(s: AdminSession | null): void {
  // Another wallet signed in: the kept copies of the pages go (cache.ts; their keys name the wallet anyway).
  // A session that simply ran out keeps them, so the next sign-in draws at once; "Sign out" forgets them.
  const before = loadSession();
  if (s && before && before.wallet !== s.wallet) forgetAll();
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage off: the session lasts this page */
  }
  for (const l of listeners) l(s);
}

export class AdminApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/** Each call's time and size, the last 100, for measuring (the session menu lists them; nothing leaves the page). */
export interface CallTiming { path: string; ms: number; bytes: number; status: number; at: number }
export const timings: CallTiming[] = [];
function note(t: CallTiming): void {
  timings.push(t);
  if (timings.length > 100) timings.shift();
}

/** Sign out on purpose: the session and every kept copy of the pages. */
export function signOutHere(): void {
  forgetAll();
  saveSession(null);
}

/** One call. `blob`: the answer's bytes (a screenshot). A 401 `session` signs this page out. */
export async function call<T = Record<string, unknown>>(path: string, body: unknown = {}, o: { blob?: boolean; anonymous?: boolean } = {}): Promise<T> {
  const s = o.anonymous ? null : loadSession();
  const started = performance.now();
  let r: Response;
  try {
    r = await fetch(`/api/admin/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(s ? { authorization: `Bearer ${s.token}` } : {}) },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new AdminApiError('The server cannot be reached.', 0);
  }
  if (r.ok && o.blob) return (await r.blob()) as T;
  let j: Record<string, unknown> = {};
  let text = '';
  try {
    text = await r.text();
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON (a 404 from the edge, say) */
  }
  note({ path, ms: Math.round(performance.now() - started), bytes: text.length, status: r.status, at: Date.now() });
  if (!r.ok) {
    const code = typeof j.code === 'string' ? j.code : undefined;
    if (r.status === 401 && code === 'session' && !o.anonymous) saveSession(null);
    const msg = typeof j.error === 'string' ? j.error : r.status === 404 ? 'The admin suite is off on this server (no password set).' : `HTTP ${r.status}`;
    throw new AdminApiError(msg, r.status, code);
  }
  return j as T;
}
