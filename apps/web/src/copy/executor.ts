/**
 * Talking to a copy executor: ValueDesk's (hosted, behind this site's /api)
 * or the follower's own (self-hosted, usually http://127.0.0.1:8799).
 *
 * Every change is a CopyRequest the connected wallet signs
 * (packages/copy-engine/src/api.ts): the wallet shows the action and the exact
 * payload, the executor checks the signature and keeps it as the record of
 * the instruction. Reads use a session token from one signed 'session'
 * request, kept in this browser's localStorage until it expires (owner 2026-11-08: a new tab or a restart must not
 * ask for a signature again; the token only reads, every change is signed on its own).
 */
import type { KeyImportEnvelope } from './keyImport';
import {
  buildCopyRequest,
  copyRequestTypedData,
  type ActivityEntry,
  type CopyAction,
  type CopyView,
  type EngineNotice,
  type ExecutorInfo,
  type KeyInfo,
  type MeResponse,
  type SessionGrant,
  type SignedCopyRequest,
  type SiteTermsRecord,
  type VipMoveView,
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

/**
 * Where a read token is kept: per base, executor and wallet (owner 2026-11-08: "i need to sign in multiple times a
 * day"). Keyed by the executor's id too, so two executors behind one base (production and the test box on localhost,
 * or an executor replaced behind the same address) each keep their own token instead of discarding the other's.
 */
const sessionKey = (base: string, owner: string, id?: string | null) => `vd.copy.session:${base}${id ? `#${id}` : ''}:${owner.toLowerCase()}`;
/** The id of the executor last seen behind a base, so a token can be looked up before /info answers again. */
const lastIdKey = (base: string) => `vd.copy.exec:${base}`;

export class ExecutorClient {
  private at: string;
  constructor(
    base: string,
    readonly kind: 'hosted' | 'self',
  ) {
    this.at = base;
  }

  get base(): string {
    return this.at;
  }

  /** VIP: the hosted client talks to the VIP executor from now on (its own tokens, its own data). */
  setBase(base: string): void {
    this.at = base;
  }

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

  info = async (): Promise<ExecutorInfo> => {
    const i = await this.call<ExecutorInfo>('GET', '/info');
    if (i?.executorId) {
      this.id = i.executorId;
      try { localStorage.setItem(lastIdKey(this.base), i.executorId); } catch { /* private mode */ }
    }
    return i;
  };

  /** The executor behind this base, as its /info last said (null until it answered). */
  private id: string | null = null;
  private idNow(): string | null {
    if (this.id) return this.id;
    try { return localStorage.getItem(lastIdKey(this.base)); } catch { return null; }
  }

  /* ---------------------------------------------------------- session ----- */

  private ownerCache: string | null = null;

  token(owner: string): string | null {
    try {
      // A token from before 2026-11-08 sits in this tab's sessionStorage: carried over once, no new signature.
      const id = this.idNow();
      const key = sessionKey(this.base, owner, id);
      // Carried over once, no new signature: a token from before 2026-11-08 (this tab's sessionStorage), or one kept
      // without the executor's id (it is tried, and dropped if the executor refuses it).
      const old = sessionStorage.getItem(sessionKey(this.base, owner));
      if (old) { localStorage.setItem(key, old); sessionStorage.removeItem(sessionKey(this.base, owner)); }
      if (id) {
        const legacy = localStorage.getItem(sessionKey(this.base, owner));
        if (legacy) { if (!localStorage.getItem(key)) localStorage.setItem(key, legacy); localStorage.removeItem(sessionKey(this.base, owner)); }
      }
      const raw = localStorage.getItem(key);
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
      localStorage.removeItem(sessionKey(this.base, this.ownerCache, this.idNow()));
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
      localStorage.setItem(sessionKey(this.base, owner, this.id ?? executorId), JSON.stringify(g));
    } catch {
      /* storage refused: one signature per load */
    }
    this.ownerCache = owner;
    return g.token;
  }

  /* ------------------------------------------------------------ reads ----- */

  me = (token: string) => this.call<MeResponse>('GET', '/me', { token });
  verifyKey = (token: string) => this.call<{ key: KeyInfo | null }>('POST', '/keys/verify', { token, body: {} });
  /** A key the follower made on SoDEX themselves, its private key sealed to this executor (keyImport.ts). */
  importKey = (token: string, name: string, envelope: KeyImportEnvelope) => this.call<{ key: KeyInfo }>('POST', '/keys/import', { token, body: { name, envelope } });
  activity = (token: string, id: string, limit = 300) => this.call<{ entries: ActivityEntry[] }>('GET', `/copies/${encodeURIComponent(id)}/activity?limit=${limit}`, { token });
  consents = (token: string) => this.call<{ consents: Array<{ action: string; payload: string; at: number; digest: string }> }>('GET', '/consents', { token });
  /** What the wallet should hear of: its copies' and algos' notices on this executor, newest first (copy-engine notices.ts). */
  notices = (token: string, limit = 200) => this.call<{ notices: EngineNotice[] }>('GET', `/notices?limit=${limit}`, { token });

  /* ----------------------------------------------------------- writes ----- */

  acceptTerms = (request: SignedCopyRequest) => this.call<MeResponse>('POST', '/terms', { body: { request } });
  /** ValueDesk's own terms (legal/acceptance.ts): recorded by the hosted executor only. */
  acceptSiteTerms = (request: SignedCopyRequest) => this.call<SiteTermsRecord>('POST', '/site-terms', { body: { request } });
  createKey = (request: SignedCopyRequest) => this.call<{ address: string; name: string; maxDays: number; days: number }>('POST', '/keys', { body: { request } });
  deleteKey = (request: SignedCopyRequest) => this.call<MeResponse>('POST', '/keys/delete', { body: { request } });
  subscribe = (request: SignedCopyRequest) => this.call<CopyView>('POST', '/copies', { body: { request } });
  act = (request: SignedCopyRequest) => this.call<{ copies: CopyView[] }>('POST', '/copies/action', { body: { request } });
  /** VIP: start moving this wallet's bots (standard executor), and follow it. */
  vipMove = (request: SignedCopyRequest) => this.call<{ job: VipMoveView }>('POST', '/vip/move', { body: { request } });
  vipJob = (token: string) => this.call<{ job: VipMoveView | null }>('GET', '/vip/move', { token });
  health = () => this.call<{ ok: boolean }>('GET', '/health');
}

export const hostedExecutor = new ExecutorClient(HOSTED_BASE, 'hosted');

/**
 * VIP (owner 2026-11-08): a wallet whose bots moved to the VIP executor (AWS Tokyo) talks to it through this base;
 * the edge routes it there as /api/copy to the standard one. Which wallet moved is the standard executor's record
 * (MeResponse.movedTo); this browser keeps it too, so the page goes there first.
 */
export const VIP_BASE = '/api/copy-vip/v1';
const VIP_KEY = 'vs.vip.moved';
export const vipClient = new ExecutorClient(VIP_BASE, 'hosted');
export function vipMoved(owner: string): boolean {
  try {
    return (localStorage.getItem(VIP_KEY) ?? '').split(',').includes(owner.toLowerCase());
  } catch {
    return false;
  }
}
export function setVipMoved(owner: string, on: boolean): void {
  try {
    const xs = new Set((localStorage.getItem(VIP_KEY) ?? '').split(',').filter(Boolean));
    if (on) xs.add(owner.toLowerCase());
    else xs.delete(owner.toLowerCase());
    localStorage.setItem(VIP_KEY, [...xs].join(','));
  } catch {
    /* private mode: the standard executor's record still sends the page there */
  }
}
/** Point the hosted client at the wallet's executor: VIP when it moved there. */
export function pointHostedAt(owner: string | null): void {
  hostedExecutor.setBase(owner && vipMoved(owner) ? VIP_BASE : HOSTED_BASE);
}
/** Keep a session token the VIP executor issued in a move (no second signature). */
export function keepVipSession(owner: string, g: { token: string; expiresAt: number }): void {
  try {
    localStorage.setItem(sessionKey(VIP_BASE, owner.toLowerCase()), JSON.stringify(g));
  } catch {
    /* private mode */
  }
}
