/**
 * Talking to a copy executor: ValueDesk's (hosted, behind this site's /api)
 * or the follower's own (self-hosted, usually http://127.0.0.1:8799).
 *
 * Every change is a CopyRequest the connected wallet signs
 * (packages/copy-engine/src/api.ts): the wallet shows the action and the exact
 * payload, the executor checks the signature and keeps it as the record of
 * the instruction. Reads use a session token from one signed 'session'
 * request, kept in this tab's sessionStorage until it expires.
 */
import {
  buildCopyRequest,
  copyRequestTypedData,
  type ActivityEntry,
  type CopyAction,
  type CopyView,
  type ExecutorInfo,
  type KeyInfo,
  type MeResponse,
  type SessionGrant,
  type SignedCopyRequest,
} from '@copy-engine';
import { getChainId, signTypedData, type Eip1193Provider } from '../wallet';

export const HOSTED_BASE = '/api/copy/v1';
export const DEFAULT_SELF_URL = 'http://127.0.0.1:8799';

export class ExecutorError extends Error {
  override name = 'ExecutorError';
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

/** `http://127.0.0.1:8799` -> `http://127.0.0.1:8799/api/copy/v1`; a full API base is kept. */
export function selfBase(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  return /\/api\/copy\/v1$/.test(u) ? u : `${u}/api/copy/v1`;
}

/** Only loopback, or https: what the site's security policy lets the browser reach. */
export function selfUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return 'Enter the address the copier printed, e.g. http://127.0.0.1:8799.';
  }
  const loop = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol === 'http:' && loop) return null;
  if (u.protocol === 'https:' && loop) return null;
  return 'Use the copier on this computer (http://127.0.0.1:8799), or reach one on a server through an SSH tunnel to that address.';
}

/** Sign one request for `executor` with the connected wallet. */
export async function signCopy(provider: Eip1193Provider, owner: string, executor: string, action: CopyAction, payload: unknown): Promise<SignedCopyRequest> {
  const chainId = await getChainId(provider);
  const req = buildCopyRequest({ action, owner, executor, payload, chainId });
  const signature = await signTypedData(provider, owner, copyRequestTypedData(req));
  return { ...req, signature };
}

const sessionKey = (base: string, owner: string) => `vd.copy.session:${base}:${owner.toLowerCase()}`;

export class ExecutorClient {
  constructor(
    readonly base: string,
    readonly kind: 'hosted' | 'self',
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, o: { body?: unknown; token?: string | null; pairing?: string | null } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    if (o.pairing) headers['X-Pairing-Code'] = o.pairing;
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        credentials: 'omit',
        cache: 'no-store',
        mode: 'cors',
      });
    } catch {
      throw new ExecutorError(
        this.kind === 'self' ? 'Your copier does not answer at this address. Is it running?' : 'The ValueDesk executor could not be reached. Try again in a moment.',
        0,
        'network',
      );
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const d = (data ?? {}) as { error?: string; code?: string };
      if (res.status === 401 && d.code === 'session') this.forget();
      throw new ExecutorError(d.error || `The executor answered HTTP ${res.status}.`, res.status, d.code || 'http');
    }
    return data as T;
  }

  info = () => this.call<ExecutorInfo>('GET', '/info');

  /* ---------------------------------------------------------- session ----- */

  private ownerCache: string | null = null;

  token(owner: string): string | null {
    try {
      const raw = sessionStorage.getItem(sessionKey(this.base, owner));
      if (!raw) return null;
      const g = JSON.parse(raw) as SessionGrant;
      if (!(g.expiresAt > Date.now() + 60_000)) return null;
      this.ownerCache = owner;
      return g.token;
    } catch {
      return null;
    }
  }

  private forget(): void {
    if (!this.ownerCache) return;
    try {
      sessionStorage.removeItem(sessionKey(this.base, this.ownerCache));
    } catch {
      /* private mode */
    }
  }

  /** A read token: from this tab if one is held, else one signature. */
  async session(provider: Eip1193Provider, owner: string, executorId: string, pairing?: string | null): Promise<string> {
    const held = this.token(owner);
    if (held) return held;
    const request = await signCopy(provider, owner, executorId, 'session', {});
    const g = await this.call<SessionGrant>('POST', '/session', { body: { request }, pairing });
    try {
      sessionStorage.setItem(sessionKey(this.base, owner), JSON.stringify(g));
    } catch {
      /* private mode: one signature per load */
    }
    this.ownerCache = owner;
    return g.token;
  }

  /* ------------------------------------------------------------ reads ----- */

  me = (token: string) => this.call<MeResponse>('GET', '/me', { token });
  verifyKey = (token: string) => this.call<{ key: KeyInfo | null }>('POST', '/keys/verify', { token, body: {} });
  activity = (token: string, id: string, limit = 300) => this.call<{ entries: ActivityEntry[] }>('GET', `/copies/${encodeURIComponent(id)}/activity?limit=${limit}`, { token });
  consents = (token: string) => this.call<{ consents: Array<{ action: string; payload: string; at: number; digest: string }> }>('GET', '/consents', { token });

  /* ----------------------------------------------------------- writes ----- */

  acceptTerms = (request: SignedCopyRequest) => this.call<MeResponse>('POST', '/terms', { body: { request } });
  createKey = (request: SignedCopyRequest) => this.call<{ address: string; name: string; maxDays: number; days: number }>('POST', '/keys', { body: { request } });
  deleteKey = (request: SignedCopyRequest) => this.call<MeResponse>('POST', '/keys/delete', { body: { request } });
  subscribe = (request: SignedCopyRequest) => this.call<CopyView>('POST', '/copies', { body: { request } });
  act = (request: SignedCopyRequest) => this.call<{ copies: CopyView[] }>('POST', '/copies/action', { body: { request } });
}

export const hostedExecutor = new ExecutorClient(HOSTED_BASE, 'hosted');
