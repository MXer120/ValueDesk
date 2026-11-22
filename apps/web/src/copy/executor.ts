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
  type CopyTermsServed,
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
  DELEGABLE_ACTIONS,
  DELEGATION_TTL_MS,
  copyRequestDigest,
} from '@copy-engine';
import { bytesToHex, hexToBytes } from '@sodex-core';
import { getChainId, signTypedData, type Eip1193Provider } from '../wallet';

export const HOSTED_BASE = '/api/copy/v1';

/**
 * Where the bots page opens its live stream (GET <base>/algos/stream). In production straight to the instance
 * (VITE_COPY_STREAM_ORIGIN=https://api.valuedesk.so: server 1's Caddy passes exactly the two stream paths without the
 * origin secret and adds it itself, deploy/server/caddy/Caddyfile.template), not through the site's /api function: a
 * stream holds that function for as long as the tab is open (cut at its 35 s and opened again), and on 2026-11-12 the
 * two streams were 49.5 of its 52 GB-hours, 87% of its CPU and nearly all of its origin transfer. Unset (dev, tests) or a
 * base that is already a full URL (a self-hosted executor): the base itself, as before.
 */
export function streamUrlOf(base: string, origin: string | undefined = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_COPY_STREAM_ORIGIN): string {
  const o = origin?.trim().replace(/\/+$/, '');
  return `${o && base.startsWith('/') ? o : ''}${base}/algos/stream`;
}
export const DEFAULT_SELF_URL = 'http://127.0.0.1:8799';

export class ExecutorError extends Error {
  override name = 'ExecutorError';
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** Figures that go with a refusal (a bot's margin, the bot already on that market), as the executor sent them. */
    readonly detail: Record<string, unknown> | null = null,
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

/** Executors whose /info says they accept day-key signatures ('day-key'); every other one gets the wallet's own. */
const dayKeyExecutors = new Set<string>();
/**
 * Executors that also take a day key approved inside the terms acceptance and a day-key-signed 'create-key'
 * ('terms-day-key', owner 2026-11-22 "make that shorter"): a new follower then signs the terms, the fee and SoDEX's key.
 */
const termsDayKeyExecutors = new Set<string>();

/** Sign one request for `executor` with the connected wallet. */
export async function signCopy(provider: Eip1193Provider, owner: string, executor: string, action: CopyAction, payload: unknown): Promise<SignedCopyRequest> {
  const chainId = await getChainId(provider);
  const req = buildCopyRequest({ action, owner, executor, payload, chainId });
  // Everyday actions (start, stop, pause, save, sign-in...) are signed by this browser's day key: the wallet signs
  // once a day at most (owner 2026-11-08). The terms and a trading key always take the wallet itself.
  if (DELEGABLE_ACTIONS.has(action) && dayKeyExecutors.has(executor) && (action !== 'create-key' || termsDayKeyExecutors.has(executor))) {
    const day = await dayKey(provider, owner, executor, chainId);
    if (day) {
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, day.key, new Uint8Array(hexToBytes(copyRequestDigest(req) as `0x${string}`))));
      return { ...req, signature: bytesToHex(sig), delegation: day.approval };
    }
  }
  const signature = await signTypedData(provider, owner, copyRequestTypedData(req));
  return { ...req, signature };
}

/**
 * The day key (owner 2026-11-08, hardened 2026-11-09): a P-256 key made by this browser's WebCrypto as NON-extractable,
 * so its private part can be used to sign but never read out - not by a script on the page either. The wallet approves
 * its public key with one 'delegate' signature, valid 24 h (DELEGATION_TTL_MS) for this executor id. Kept in IndexedDB
 * (a CryptoKey survives there as itself); a new one is approved once it has less than ten minutes left. It signs only
 * DELEGABLE_ACTIONS; the executor checks the approval on every request (verifyCopyRequest) and refuses approvals from
 * before a revocation (revokeDayKeys). No WebCrypto or IndexedDB (an old browser, a locked-down profile): the wallet
 * signs each action as before.
 */
interface DayKey { key: CryptoKey; approval: SignedCopyRequest; expiresAt: number }
const dayKeyName = (executor: string, owner: string, chainId: number) => `vd.copy.daykey:${executor}:${chainId}:${owner.toLowerCase()}`;
const dayKeys = new Map<string, DayKey>();
const dayKeyPending = new Map<string, { p: Promise<DayKey | null>; at: number }>();
/**
 * A day-key request left unanswered (owner 2026-11-18, "fix that": a Start sat on "Waiting for your wallet…" with no
 * popup, because every later action waited on the first, unanswered request). An action within SHARE_MS of the request
 * shares it (two clicks, one popup); a later one asks the wallet again. No action waits longer than ANSWER_MS: it fails
 * with words, so its button is free again. An approval that comes in late is still kept for the next action.
 */
const DAY_KEY_SHARE_MS = 15_000;
const DAY_KEY_ANSWER_MS = 90_000;
export const DAY_KEY_NO_ANSWER = 'Your wallet did not answer the request. Open your wallet, then try again: the next try asks it again.';
const DAY_DB = 'vd-daykeys';
function dayDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DAY_DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('keys');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
async function dayDbDo<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await dayDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const r = fn(db.transaction('keys', mode).objectStore('keys'));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
async function dayKey(provider: Eip1193Provider, owner: string, executor: string, chainId: number): Promise<DayKey | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle || typeof indexedDB === 'undefined') return null;
  const name = dayKeyName(executor, owner, chainId);
  const fresh = (d: DayKey | null | undefined): d is DayKey => !!d && d.expiresAt - Date.now() > 10 * 60_000 && !!d.key && !!d.approval;
  const held = dayKeys.get(name);
  if (fresh(held)) return held;
  const stored = (await dayDbDo<DayKey>('readonly', (s) => s.get(name) as IDBRequest<DayKey>)) ?? null;
  if (fresh(stored)) {
    dayKeys.set(name, stored);
    return stored;
  }
  // One approval at a time while it is fresh: actions that wait on it all use the same key.
  const pending = dayKeyPending.get(name);
  if (pending && Date.now() - pending.at < DAY_KEY_SHARE_MS) return withAnswerTime(pending.p);
  const make = (async (): Promise<DayKey | null> => {
    let pair: CryptoKeyPair;
    try {
      pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    } catch {
      return null;
    }
    const pub = bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    const expiresAt = Date.now() + DELEGATION_TTL_MS - 60_000;
    const req = buildCopyRequest({ action: 'delegate', owner, executor, payload: { alg: 'p256', key: pub, expiresAt }, chainId, ttlMs: DELEGATION_TTL_MS - 60_000 });
    const signature = await signTypedData(provider, owner, copyRequestTypedData(req));
    const d: DayKey = { key: pair.privateKey, approval: { ...req, signature }, expiresAt };
    dayKeys.set(name, d);
    await dayDbDo('readwrite', (s) => s.put(d, name));
    return d;
  })();
  const entry = { p: make, at: Date.now() };
  dayKeyPending.set(name, entry);
  // Forgotten once answered (or refused); a newer request that replaced it stays.
  void make.then(() => {}, () => {}).finally(() => { if (dayKeyPending.get(name) === entry) dayKeyPending.delete(name); });
  return withAnswerTime(make);
}

/**
 * Sign the copy terms acceptance with the wallet and, for an executor with 'terms-day-key', approve this browser's day
 * key for it in the same signature (payload.dayKey): the follower's sign-in, key request and everyday actions there then
 * take no further wallet popup for a day. Without WebCrypto / IndexedDB, or for an older executor: the terms alone.
 */
export async function signTermsWithDayKey(provider: Eip1193Provider, owner: string, termsExecutor: string, payload: Record<string, unknown>, dayKeyFor: string | null): Promise<SignedCopyRequest> {
  const chainId = await getChainId(provider);
  let pair: CryptoKeyPair | null = null;
  let expiresAt = 0;
  if (dayKeyFor && termsDayKeyExecutors.has(dayKeyFor) && dayKeyExecutors.has(dayKeyFor) && typeof crypto !== 'undefined' && crypto.subtle && typeof indexedDB !== 'undefined') {
    try {
      pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    } catch {
      pair = null;
    }
  }
  const body: Record<string, unknown> = { ...payload };
  if (pair && dayKeyFor) {
    expiresAt = Date.now() + DELEGATION_TTL_MS - 60_000;
    body.dayKey = { alg: 'p256', key: bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))), expiresAt, executor: dayKeyFor };
  }
  const req = buildCopyRequest({ action: 'accept-terms', owner, executor: termsExecutor, payload: body, chainId });
  const signature = await signTypedData(provider, owner, copyRequestTypedData(req));
  const signed: SignedCopyRequest = { ...req, signature };
  if (pair && dayKeyFor) {
    const d: DayKey = { key: pair.privateKey, approval: signed, expiresAt };
    const name = dayKeyName(dayKeyFor, owner, chainId);
    dayKeys.set(name, d);
    await dayDbDo('readwrite', (s) => s.put(d, name));
  }
  return signed;
}

/** The request as an action waits on it: at most DAY_KEY_ANSWER_MS, then a clear failure (the request itself goes on). */
function withAnswerTime<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(DAY_KEY_NO_ANSWER)), DAY_KEY_ANSWER_MS); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Forget this browser's day keys for a wallet (sign-out, a refused approval): the next action asks the wallet again. */
export function forgetDayKeys(owner: string): void {
  const o = owner.toLowerCase();
  for (const k of [...dayKeys.keys()]) if (k.endsWith(`:${o}`)) dayKeys.delete(k);
  void (async () => {
    const keys = (await dayDbDo<IDBValidKey[]>('readonly', (s) => s.getAllKeys())) ?? [];
    for (const k of keys) if (typeof k === 'string' && k.endsWith(`:${o}`)) await dayDbDo('readwrite', (s) => s.delete(k));
  })();
}

/**
 * Revoke every day key of this wallet on an executor, on every device (a wallet signature): approvals signed before
 * now are refused there from now on. This browser's own are forgotten too.
 */
export async function revokeDayKeys(provider: Eip1193Provider, owner: string, executor: string, client: ExecutorClient): Promise<void> {
  const chainId = await getChainId(provider);
  const req = buildCopyRequest({ action: 'delegate', owner, executor, payload: { revoke: true }, chainId });
  const signature = await signTypedData(provider, owner, copyRequestTypedData(req));
  await client.revokeDayKeys({ ...req, signature });
  forgetDayKeys(owner);
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

  /**
   * VIP: the hosted client talks to the VIP executor from now on (its own tokens, its own data). The executor id
   * and the wallet the last token was for belong to the old base: dropped, so a token is never filed under the
   * other executor's id (audit A5).
   */
  setBase(base: string): void {
    if (base === this.at) return;
    this.at = base;
    this.id = null;
    this.ownerCache = null;
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
      const d = (data ?? {}) as { error?: string; code?: string; detail?: unknown };
      if (res.status === 401 && d.code === 'session') this.forgetSession();
      throw new ExecutorError(d.error || `The executor answered HTTP ${res.status}.`, res.status, d.code || 'http', d.detail && typeof d.detail === 'object' ? (d.detail as Record<string, unknown>) : null);
    }
    return data as T;
  }

  info = async (): Promise<ExecutorInfo> => {
    const i = await this.call<ExecutorInfo>('GET', '/info');
    if (i?.executorId) {
      this.id = i.executorId;
      if (i.features?.includes('day-key')) dayKeyExecutors.add(i.executorId);
      else dayKeyExecutors.delete(i.executorId);
      if (i.features?.includes('terms-day-key')) termsDayKeyExecutors.add(i.executorId);
      else termsDayKeyExecutors.delete(i.executorId);
      try { localStorage.setItem(lastIdKey(this.base), i.executorId); } catch { /* private mode */ }
    }
    return i;
  };

  /** The executor behind this base, as its /info last said (null until it answered). */
  private id: string | null = null;
  /** The executor id behind this base (last /info), for keys another base's token is kept under. */
  executorIdNow(): string | null {
    return this.idNow();
  }
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

  /** Drop the read token kept for the wallet last signed in here (the executor refused it). */
  forgetSession(): void {
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
  /** Whether `owner` accepted the copy terms in force here (public yes/no; 'terms-day-key' executors). */
  termsStatus = (owner: string) => this.call<{ accepted: boolean; termsVersion: string }>('GET', `/terms/status?owner=${encodeURIComponent(owner.toLowerCase())}`);
  /** ValueDesk's own terms (legal/acceptance.ts): recorded by the hosted executor only. */
  acceptSiteTerms = (request: SignedCopyRequest) => this.call<SiteTermsRecord>('POST', '/site-terms', { body: { request } });
  createKey = (request: SignedCopyRequest) => this.call<{ address: string; name: string; maxDays: number; days: number }>('POST', '/keys', { body: { request } });
  deleteKey = (request: SignedCopyRequest) => this.call<MeResponse>('POST', '/keys/delete', { body: { request } });
  subscribe = (request: SignedCopyRequest) => this.call<CopyView>('POST', '/copies', { body: { request } });
  act = (request: SignedCopyRequest) => this.call<{ copies: CopyView[] }>('POST', '/copies/action', { body: { request } });
  /** VIP: start moving this wallet's bots (standard executor), and follow it. */
  vipMove = (request: SignedCopyRequest) => this.call<{ job: VipMoveView }>('POST', '/vip/move', { body: { request } });
  vipJob = (token: string) => this.call<{ job: VipMoveView | null }>('GET', '/vip/move', { token });
  /** The copy terms in force on this executor: version, hash and text (executors with 'terms-doc'). */
  copyTerms = () => this.call<CopyTermsServed>('GET', '/terms/copy');
  revokeDayKeys = (request: SignedCopyRequest) => this.call<{ ok: true; revokedBefore: number }>('POST', '/daykeys/revoke', { body: { request } });
  health = () => this.call<{ ok: boolean }>('GET', '/health');
}

export const hostedExecutor = new ExecutorClient(HOSTED_BASE, 'hosted');
/**
 * The standard executor whatever the hosted client points at: a VIP move is followed here to its end, also after
 * the hosted client has switched to the VIP base (same base, so the same kept token).
 */
export const standardExecutor = new ExecutorClient(HOSTED_BASE, 'hosted');

/**
 * The wallet's bot fee and VIP standing as the executor's /me says it (contract 2026-11-08: `bots`, tenths of a bp).
 * Read defensively: an executor from before it says nothing, and the page falls back to the ladder's first step.
 */
export interface MeBots { feeTenths: number; vip: boolean; until: number | null }
export function meBots(me: MeResponse | null | undefined): MeBots | null {
  const b = (me as (MeResponse & { bots?: Partial<MeBots> | null }) | null | undefined)?.bots;
  if (!b || typeof b.feeTenths !== 'number' || !Number.isFinite(b.feeTenths) || b.feeTenths < 0) return null;
  return { feeTenths: b.feeTenths, vip: b.vip === true, until: typeof b.until === 'number' ? b.until : null };
}

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
/**
 * Keep a read token one executor issued for the other in a move (no second signature): the VIP one's after a move up,
 * the standard one's after a move back. `id`: the executor id both run under (the key the client reads first).
 */
export function keepSessionAt(base: string, owner: string, id: string | null, g: { token: string; expiresAt: number }): void {
  try {
    localStorage.setItem(sessionKey(base, owner.toLowerCase(), id), JSON.stringify(g));
  } catch {
    /* private mode */
  }
}
/** Keep a session token the VIP executor issued in a move (no second signature). */
export function keepVipSession(owner: string, g: { token: string; expiresAt: number }): void {
  try {
    localStorage.setItem(sessionKey(VIP_BASE, owner.toLowerCase()), JSON.stringify(g));
  } catch {
    /* private mode */
  }
}
