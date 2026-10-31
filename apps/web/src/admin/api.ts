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

/** One call. `blob`: the answer's bytes (a screenshot). A 401 `session` signs this page out. */
export async function call<T = Record<string, unknown>>(path: string, body: unknown = {}, o: { blob?: boolean; anonymous?: boolean } = {}): Promise<T> {
  const s = o.anonymous ? null : loadSession();
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
  try {
    j = (await r.json()) as Record<string, unknown>;
  } catch {
    /* not JSON (a 404 from the edge, say) */
  }
  if (!r.ok) {
    const code = typeof j.code === 'string' ? j.code : undefined;
    if (r.status === 401 && code === 'session' && !o.anonymous) saveSession(null);
    const msg = typeof j.error === 'string' ? j.error : r.status === 404 ? 'The admin suite is off on this server (no password set).' : `HTTP ${r.status}`;
    throw new AdminApiError(msg, r.status, code);
  }
  return j as T;
}
