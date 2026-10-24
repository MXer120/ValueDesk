/**
 * Talking to the knowledge folders on our server (apps/server/src/routes/folders.ts).
 *
 * A wallet's folders are private to it: the first time a browser opens them,
 * the connected wallet signs a FoldersSignIn (free typed data with a fixed
 * statement, never a transaction) and the server hands back a token for seven
 * days. It is kept in this browser's localStorage under the wallet's address,
 * so the same wallet is asked once a week, not once a page load; another wallet
 * signs for itself. "Sign out" forgets it here; deleting everything ends it on
 * every device (the server raises the wallet's epoch).
 */
import {
  SIGN_IN_STATEMENT,
  SIGN_IN_TTL_MS,
  signInTypedData,
  type FolderItem,
  type FoldersError,
  type FoldersList,
  type FoldersSession,
  type ItemSummary,
  type JsonKind,
} from '@sign/folders/types.js';
import { getChainId, signTypedData, type Eip1193Provider } from '../wallet';

export class FoldersApiError extends Error {
  override name = 'FoldersApiError';
  constructor(
    message: string,
    readonly status: number,
    readonly code: FoldersError['code'] | 'network' | 'http',
  ) {
    super(message);
  }
}

const tokenKey = (owner: string) => `vd.folders.session:${owner.toLowerCase()}`;

interface Held {
  token: string;
  expiresAt: number;
}

/** The token this browser holds for `owner`, while it has more than a minute left. */
export function heldToken(owner: string | null): string | null {
  if (!owner) return null;
  try {
    const raw = localStorage.getItem(tokenKey(owner));
    if (!raw) return null;
    const h = JSON.parse(raw) as Held;
    return typeof h.token === 'string' && h.expiresAt > Date.now() + 60_000 ? h.token : null;
  } catch {
    return null;
  }
}

export function forgetToken(owner: string | null): void {
  if (!owner) return;
  try {
    localStorage.removeItem(tokenKey(owner));
  } catch {
    /* private mode */
  }
}

function randomNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** One signature from the connected wallet for a token; kept for the next visits. */
export async function signIn(provider: Eip1193Provider, owner: string): Promise<string> {
  const chainId = await getChainId(provider);
  const now = Date.now();
  const unsigned = {
    owner: owner.toLowerCase(),
    statement: SIGN_IN_STATEMENT,
    nonce: randomNonce(),
    issuedAt: String(now),
    expiresAt: String(now + SIGN_IN_TTL_MS),
    chainId,
  };
  const signature = await signTypedData(provider, owner, signInTypedData(unsigned));
  const g = await call<FoldersSession>(null, 'POST', '/api/folders/session', { json: { signIn: { ...unsigned, signature } } });
  try {
    localStorage.setItem(tokenKey(owner), JSON.stringify({ token: g.token, expiresAt: g.expiresAt } satisfies Held));
  } catch {
    /* private mode: one signature per page load */
  }
  return g.token;
}

async function call<T>(
  token: string | null,
  method: 'GET' | 'POST',
  path: string,
  o: { json?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (o.json !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: o.json !== undefined ? JSON.stringify(o.json) : undefined,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new FoldersApiError('Your folders could not be reached. Check the connection and try again.', 0, 'network');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: an edge's error page */
  }
  if (!res.ok) {
    const d = (data ?? {}) as Partial<FoldersError>;
    const msg = d.error || (res.status === 413 ? 'That is too large for a folder.' : `The server answered HTTP ${res.status}.`);
    throw new FoldersApiError(msg, res.status, d.code ?? 'http');
  }
  return data as T;
}

const q = (id: string) => encodeURIComponent(id);

/** Where an upload's bytes go (apps/server/src/folders/blobs.ts UploadTarget). */
interface UploadTarget {
  method: 'PUT' | 'POST';
  url: string;
  headers: Record<string, string>;
  /** Our own route: with the wallet's token. Never true for S3. */
  bearer: boolean;
}

/** The bytes to their target, with progress (XMLHttpRequest: fetch reports none for uploads). */
function send(target: UploadTarget, file: Blob, token: string, onProgress?: (share: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(target.method, target.url);
    for (const [k, v] of Object.entries(target.headers)) x.setRequestHeader(k, v);
    if (target.bearer) x.setRequestHeader('Authorization', `Bearer ${token}`);
    x.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return resolve();
      let msg = `The upload was refused (HTTP ${x.status}).`;
      try {
        const d = JSON.parse(x.responseText) as Partial<FoldersError>;
        if (d.error) msg = d.error;
      } catch {
        /* S3 answers XML: its own words are not for the user */
      }
      reject(new FoldersApiError(msg, x.status, 'http'));
    };
    x.onerror = () => reject(new FoldersApiError('The upload did not get through. Check the connection and try again.', 0, 'network'));
    x.send(file);
  });
}

async function fetchFile(t: string, id: string, thumb: boolean): Promise<Blob> {
  const link = await call<{ ok: true; url: string; bearer: boolean }>(t, 'GET', `/api/folders/file/url?id=${q(id)}${thumb ? '&thumb=1' : ''}`);
  let res: Response;
  try {
    res = await fetch(link.url, { headers: link.bearer ? { Authorization: `Bearer ${t}` } : {}, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch {
    throw new FoldersApiError('The file could not be loaded.', 0, 'network');
  }
  if (!res.ok) {
    let d: Partial<FoldersError> = {};
    try {
      d = (await res.json()) as Partial<FoldersError>;
    } catch {
      /* not JSON (S3 answers XML) */
    }
    throw new FoldersApiError(d.error || 'The file could not be loaded.', res.status, d.code ?? 'http');
  }
  return res.blob();
}

/**
 * Files fetched in this tab, the newest first, up to FILE_CACHE_BYTES: an item opened again shows at
 * once and does not count against the day's downloads again. A file's bytes never change (a new
 * upload is a new item), so nothing in here goes stale.
 */
const FILE_CACHE_BYTES = 80 * 1024 * 1024;
const fileCache = new Map<string, Blob>();
const fetching = new Map<string, Promise<Blob>>();
function keep(key: string, blob: Blob): void {
  if (blob.size > FILE_CACHE_BYTES / 2) return;
  fileCache.delete(key);
  fileCache.set(key, blob);
  let total = 0;
  for (const b of fileCache.values()) total += b.size;
  for (const [k, b] of fileCache) {
    if (total <= FILE_CACHE_BYTES) break;
    fileCache.delete(k);
    total -= b.size;
  }
}

/** Every call takes the wallet's token; a 401 means "sign in again". */
export const foldersApi = {
  list: (t: string) => call<FoldersList>(t, 'GET', '/api/folders'),
  item: (t: string, id: string) => call<{ ok: true; item: FolderItem }>(t, 'GET', `/api/folders/item?id=${q(id)}`).then((r) => r.item),

  /**
   * An upload's (or a chart's thumbnail's) bytes, typed as the server says they are: the server
   * hands out where to fetch them - S3, with a link signed for a minute (the wallet's token is
   * never sent there), or its own route (without the bucket).
   */
  async file(t: string, id: string, thumb = false): Promise<Blob> {
    const key = `${id}|${thumb ? 't' : 'f'}`;
    const held = fileCache.get(key);
    if (held) return held;
    // Two views asking at once (a card and the pane, an effect run twice) share one download.
    let pending = fetching.get(key);
    if (!pending) {
      pending = fetchFile(t, id, thumb).finally(() => fetching.delete(key));
      fetching.set(key, pending);
    }
    const blob = await pending;
    keep(key, blob);
    return blob;
  },

  createFolder: (t: string, name: string) => call<FoldersList & { folder: { id: string } }>(t, 'POST', '/api/folders/folder/create', { json: { name } }),
  renameFolder: (t: string, id: string, name: string) => call<FoldersList>(t, 'POST', '/api/folders/folder/rename', { json: { id, name } }),
  deleteFolder: (t: string, id: string) => call<FoldersList>(t, 'POST', '/api/folders/folder/delete', { json: { id } }),
  orderFolders: (t: string, ids: string[]) => call<FoldersList>(t, 'POST', '/api/folders/folder/order', { json: { ids } }),

  createItem: (t: string, o: { folderId: string; kind: JsonKind; title: string; data: unknown; thumb?: string }) =>
    call<{ ok: true; item: ItemSummary }>(t, 'POST', '/api/folders/item/create', { json: o }).then((r) => r.item),
  updateItem: (t: string, o: { id: string; title?: string; data?: unknown; rev?: number }) =>
    call<{ ok: true; item: ItemSummary }>(t, 'POST', '/api/folders/item/update', { json: o }).then((r) => r.item),
  moveItem: (t: string, o: { id: string; folderId: string; index: number }) => call<FoldersList>(t, 'POST', '/api/folders/item/move', { json: o }),
  deleteItem: (t: string, id: string) => call<FoldersList>(t, 'POST', '/api/folders/item/delete', { json: { id } }),

  /**
   * An upload: the server reserves it (its size and place counted), says where the bytes go - S3
   * with a link for exactly this file's size, or its own route - and lists it once it has checked
   * what arrived. `onProgress` gets 0..1 while the bytes travel.
   */
  async upload(t: string, o: { folderId: string; file: Blob; name: string; title?: string }, onProgress?: (share: number) => void): Promise<ItemSummary> {
    const s = await call<{ ok: true; id: string; target: UploadTarget }>(t, 'POST', '/api/folders/upload/start', { json: { folderId: o.folderId, name: o.name, size: o.file.size, ...(o.title ? { title: o.title } : {}) } });
    await send(s.target, o.file, t, onProgress);
    return call<{ ok: true; item: ItemSummary }>(t, 'POST', '/api/folders/upload/finish', { json: { id: s.id } }).then((r) => r.item);
  },

  erase: (t: string) => call<{ ok: true; erased: { items: number; folders: number } }>(t, 'POST', '/api/folders/erase', { json: { confirm: 'erase-everything' } }),
};
