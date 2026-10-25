/**
 * The optional user lock on the trading key: a password or a passkey.
 *
 * WHY. The vault (vault.ts) seals the key under a device key the browser will
 * not hand out - but it hands out its USE to anyone at this browser profile: a
 * shared computer, a laptop left open. The key can trade and move the owner's
 * funds to the owner's own wallet. A lock makes "this browser" mean "this
 * browser, and the person who knows the password / holds the passkey".
 *
 * HOW.
 *   - Password: PBKDF2-SHA256, 600,000 iterations (OWASP's current figure for
 *     SHA-256), 16-byte random salt -> a NON-extractable AES-GCM-256 key.
 *   - Passkey: WebAuthn with the PRF extension. The authenticator computes an
 *     HMAC of our salt with a secret that never leaves it, only after user
 *     verification; HKDF-SHA256 turns that output into the same kind of AES key.
 *     Without PRF a passkey only proves presence, which cannot encrypt anything,
 *     so such a passkey is refused rather than turned into a lock in name only.
 *   - The user key seals the trading key's inner layer (vault.ts). It is held in
 *     memory only, per wallet, and dropped after `autoLockMinutes` without an
 *     unlock or a signature (0 = until the tab closes) or on `lockNow`.
 *
 * WHAT IS STORED (localStorage `vd.keylock.v1`, per wallet): the kind, the
 * salt and iteration count, or the credential id, PRF salt and RP id - and a
 * `check`: a 16-byte AES-GCM ciphertext of a fixed text under the user key, so a
 * wrong password is told apart from a right one even with no trading key stored
 * (and BEFORE a new key is sealed under it). It reveals nothing a guesser could
 * not already test against the sealed key in IndexedDB; it is no secret. The
 * password, the PRF output and the AES key itself are never written anywhere.
 *
 * The dialog (UnlockDialog.tsx) is driven from here: `requestUnlock` and
 * `confirmMoneyMove` queue a request, the dialog shows the head of the queue.
 */
import { useMemo, useSyncExternalStore } from 'react';

export type LockKind = 'none' | 'password' | 'passkey';

interface Check {
  iv: string;
  ct: string;
}

export type LockConfig =
  | { kind: 'password'; salt: string; iterations: number; check: Check }
  | { kind: 'passkey'; credentialId: string; prfSalt: string; rpId: string; check: Check };

export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSWORD_LENGTH = 8;
const CONFIG_KEY = 'vd.keylock.v1';
const SETTINGS_KEY = 'vd.keylock.settings.v1';
const HKDF_INFO = 'vd-key-lock-v1';
const CHECK_TEXT = 'vd-key-lock-check-v1';
const DEFAULT_AUTO_LOCK_MINUTES = 30;

/** The user closed the dialog: nothing was changed. */
export class KeyLockCancelled extends Error {
  override name = 'KeyLockCancelled';
  constructor(message = 'Cancelled: the lock was not changed.') {
    super(message);
  }
}

// --- bytes --------------------------------------------------------------------

const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

export function toB64u(b: Uint8Array | ArrayBuffer): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const random = (n: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));

// --- storage --------------------------------------------------------------------

/** localStorage where it works; a Map where it does not (tests, some private windows). */
const memStore = new Map<string, string>();
function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      ls.getItem(CONFIG_KEY);
      return ls;
    }
  } catch {
    /* blocked: fall through */
  }
  return {
    getItem: (k) => memStore.get(k) ?? null,
    setItem: (k, v) => void memStore.set(k, v),
    removeItem: (k) => void memStore.delete(k),
  };
}

const isCheck = (c: unknown): c is Check =>
  !!c && typeof (c as Check).iv === 'string' && typeof (c as Check).ct === 'string';

function validConfig(c: unknown): LockConfig | null {
  if (!c || typeof c !== 'object') return null;
  const x = c as Record<string, unknown>;
  if (!isCheck(x.check)) return null;
  if (x.kind === 'password' && typeof x.salt === 'string' && typeof x.iterations === 'number' && x.iterations >= 100_000) {
    return { kind: 'password', salt: x.salt, iterations: x.iterations, check: x.check };
  }
  if (x.kind === 'passkey' && typeof x.credentialId === 'string' && typeof x.prfSalt === 'string' && typeof x.rpId === 'string') {
    return { kind: 'passkey', credentialId: x.credentialId, prfSalt: x.prfSalt, rpId: x.rpId, check: x.check };
  }
  return null;
}

function readConfigs(): Record<string, LockConfig> {
  try {
    const raw = JSON.parse(storage().getItem(CONFIG_KEY) ?? '{}') as Record<string, unknown>;
    const out: Record<string, LockConfig> = {};
    for (const [owner, c] of Object.entries(raw ?? {})) {
      const v = validConfig(c);
      if (v) out[owner.toLowerCase()] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeConfig(owner: string, cfg: LockConfig | null): void {
  const all = readConfigs();
  if (cfg) all[owner] = cfg;
  else delete all[owner];
  const s = storage();
  if (Object.keys(all).length) s.setItem(CONFIG_KEY, JSON.stringify(all));
  else s.removeItem(CONFIG_KEY);
}

/** The lock set for `owner`, or null. */
export const lockConfig = (owner: string | null | undefined): LockConfig | null => (owner ? readConfigs()[owner.toLowerCase()] ?? null : null);
export const lockKind = (owner: string | null | undefined): LockKind => lockConfig(owner)?.kind ?? 'none';

interface Settings {
  autoLockMinutes: number;
  askOnMoney: boolean;
}

function readSettings(): Settings {
  try {
    const s = JSON.parse(storage().getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
    return {
      autoLockMinutes: typeof s.autoLockMinutes === 'number' && s.autoLockMinutes >= 0 ? s.autoLockMinutes : DEFAULT_AUTO_LOCK_MINUTES,
      askOnMoney: typeof s.askOnMoney === 'boolean' ? s.askOnMoney : true,
    };
  } catch {
    return { autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES, askOnMoney: true };
  }
}

function writeSettings(next: Partial<Settings>): void {
  try {
    storage().setItem(SETTINGS_KEY, JSON.stringify({ ...readSettings(), ...next }));
  } catch {
    /* kept for this tab only */
  }
}

// --- change notification ------------------------------------------------------------

let version = 0;
const listeners = new Set<() => void>();
function emit(): void {
  version++;
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* a listener's fault is its own */
    }
  }
}
export function subscribeKeyLock(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
// Another tab set, changed or removed a lock, or changed a setting.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key === CONFIG_KEY || e.key === SETTINGS_KEY || e.key === null) emit();
  });
}

/**
 * For the session (session.ts): the key of `owner` became usable (true) or was
 * dropped (false). An unlock waits for what the listeners return, so whoever
 * asked for the unlock finds the trading key open when its promise resolves.
 */
type LockEvent = (owner: string, unlocked: boolean) => void | Promise<void>;
const lockEvents = new Set<LockEvent>();
export function onLockEvent(fn: LockEvent): () => void {
  lockEvents.add(fn);
  return () => lockEvents.delete(fn);
}
const fire = async (owner: string, unlocked: boolean): Promise<void> => {
  await Promise.all(
    [...lockEvents].map(async (fn) => {
      try {
        await fn(owner, unlocked);
      } catch {
        /* the session logs its own failures */
      }
    }),
  );
};

/**
 * Re-seals the stored trading key when a lock is set, changed or removed
 * (session.ts registers it; keyLock does not know the network or the vault).
 */
type Resealer = (owner: string, from: CryptoKey | null, to: CryptoKey | null) => Promise<void>;
let resealer: Resealer | null = null;
export function setLockResealer(fn: Resealer | null): void {
  resealer = fn;
}

// --- crypto ------------------------------------------------------------------------

/** Password -> a non-extractable AES-GCM-256 key (PBKDF2-SHA256). */
export async function derivePasswordKey(password: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const pw = utf8(password);
  try {
    const base = await crypto.subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    pw.fill(0);
  }
}

/** A passkey's PRF output -> a non-extractable AES-GCM-256 key (HKDF-SHA256, info "vd-key-lock-v1"). */
export async function deriveKeyFromPrf(prfOutput: ArrayBuffer | Uint8Array): Promise<CryptoKey> {
  const ikm = new Uint8Array(prfOutput instanceof Uint8Array ? prfOutput : new Uint8Array(prfOutput));
  try {
    const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(HKDF_INFO) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    ikm.fill(0);
  }
}

const checkAad = (owner: string) => utf8(`vd-key-lock:v1:${owner.toLowerCase()}`);

export async function makeCheck(key: CryptoKey, owner: string): Promise<Check> {
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: checkAad(owner) }, key, utf8(CHECK_TEXT));
  return { iv: toB64u(iv), ct: toB64u(ct) };
}

/** AES-GCM refuses to decrypt under another key: that refusal is "wrong password". */
export async function verifyCheck(key: CryptoKey, owner: string, check: Check): Promise<boolean> {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(check.iv), additionalData: checkAad(owner) }, key, fromB64u(check.ct));
    return new TextDecoder().decode(pt) === CHECK_TEXT;
  } catch {
    return false;
  }
}

// --- passkeys ----------------------------------------------------------------------

interface PrfResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

const webauthn = (): boolean =>
  typeof window !== 'undefined' &&
  typeof PublicKeyCredential !== 'undefined' &&
  !!navigator.credentials?.create &&
  window.isSecureContext !== false;

/**
 * Can this browser try a passkey lock? Honest, not certain: whether the
 * authenticator the user picks supports PRF is only known after registration
 * (setPasskeyLock refuses then). False only where WebAuthn is missing, the
 * browser says it has no PRF (getClientCapabilities), or no authenticator could
 * verify the user (no platform one and no roaming/hybrid support).
 */
export async function passkeySupported(): Promise<boolean> {
  if (!webauthn()) return false;
  const PKC = PublicKeyCredential as unknown as {
    getClientCapabilities?: () => Promise<Record<string, boolean>>;
    isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
  };
  try {
    const caps = await PKC.getClientCapabilities?.();
    if (caps && caps['extension:prf'] === false) return false;
    if (caps && (caps.hybridTransport || caps.passkeyPlatformAuthenticator || caps.userVerifyingPlatformAuthenticator)) return true;
  } catch {
    /* older browsers: decide below */
  }
  try {
    if (await PKC.isUserVerifyingPlatformAuthenticatorAvailable?.()) return true;
  } catch {
    /* fall through */
  }
  // A security key or a phone (hybrid) may still work; registration tells.
  return true;
}

const PRF_UNSUPPORTED =
  'This passkey or browser does not support the PRF extension, which the lock needs to encrypt your key. Use a password lock instead (PRF works with Chrome/Edge 116+, Safari 18+ and Firefox 135+ on most platform passkeys and recent security keys).';

function passkeyError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return 'The passkey prompt was closed or timed out.';
  if (name === 'SecurityError') return 'Passkeys are not allowed on this address.';
  if (name === 'InvalidStateError') return 'This passkey is already registered here.';
  return (e as Error)?.message || 'The passkey could not be used.';
}

async function passkeyOutput(cfg: { credentialId: string; prfSalt: string; rpId: string }): Promise<ArrayBuffer> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      rpId: cfg.rpId,
      allowCredentials: [{ id: fromB64u(cfg.credentialId), type: 'public-key' }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: fromB64u(cfg.prfSalt) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was used.');
  const out = (cred.getClientExtensionResults() as PrfResults).prf?.results?.first;
  if (!out) throw new Error(PRF_UNSUPPORTED);
  return out;
}

const shortOwner = (o: string) => (o.length > 12 ? `${o.slice(0, 6)}…${o.slice(-4)}` : o);

// --- the unlocked keys -------------------------------------------------------------

const unlocked = new Map<string, { key: CryptoKey; timer?: ReturnType<typeof setTimeout> }>();

function arm(owner: string): void {
  const e = unlocked.get(owner);
  if (!e) return;
  if (e.timer) clearTimeout(e.timer);
  e.timer = undefined;
  const minutes = readSettings().autoLockMinutes;
  if (!(minutes > 0)) return;
  e.timer = setTimeout(() => lockNow(owner), minutes * 60_000);
  (e.timer as unknown as { unref?: () => void })?.unref?.();
}

async function setUnlocked(owner: string, key: CryptoKey): Promise<void> {
  const prev = unlocked.get(owner);
  if (prev?.timer) clearTimeout(prev.timer);
  unlocked.set(owner, { key });
  arm(owner);
  emit();
  await fire(owner, true);
}

/** The user key of `owner` while unlocked (session.ts seals and opens with it); null when locked or no lock. */
export function userKeyFor(owner: string | null | undefined): CryptoKey | null {
  if (!owner) return null;
  const o = owner.toLowerCase();
  if (lockKind(o) === 'none') return null;
  return unlocked.get(o)?.key ?? null;
}

/** Activity (an unlock, a signature): the idle auto-lock starts over. */
export function touch(owner: string | null | undefined): void {
  if (owner) arm(owner.toLowerCase());
}

/** Drop the user key now; the session wipes the private key and shows trading as locked. */
export function lockNow(owner: string): void {
  const o = owner.toLowerCase();
  const e = unlocked.get(o);
  if (e?.timer) clearTimeout(e.timer);
  unlocked.delete(o);
  emit();
  void fire(o, false);
}

export function setAutoLockMinutes(n: number): void {
  const minutes = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  writeSettings({ autoLockMinutes: minutes });
  for (const o of unlocked.keys()) arm(o);
  emit();
}

export function setAskOnMoney(on: boolean): void {
  writeSettings({ askOnMoney: !!on });
  emit();
}

// --- the dialog's queue ---------------------------------------------------------------

/** What the dialog shows and answers. Answers resolve to null on success, else the error to show. */
export interface UnlockRequest {
  id: number;
  owner: string;
  kind: 'password' | 'passkey';
  /** The line under the title: "Unlock trading", "Confirm withdrawal of 100 USDC". */
  reason: string;
  /** 'confirm': asked even while unlocked (a money move, changing the lock). */
  purpose: 'unlock' | 'confirm';
  submitPassword(password: string): Promise<string | null>;
  usePasskey(): Promise<string | null>;
  cancel(): void;
}

interface Pending {
  req: UnlockRequest;
  promise: Promise<CryptoKey | null>;
}

let queue: Pending[] = [];
let nextId = 1;
let failDelayMs = 1_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const currentUnlockRequest = (): UnlockRequest | null => queue[0]?.req ?? null;

/** The request the dialog shows (null: closed). */
export function useUnlockRequest(): UnlockRequest | null {
  return useSyncExternalStore(subscribeKeyLock, currentUnlockRequest, currentUnlockRequest);
}

/**
 * Ask for the lock of `owner`; resolves to the verified user key (also kept as
 * the unlocked key), or null when the dialog was cancelled or there is no lock.
 */
function ask(owner: string, reason: string, purpose: 'unlock' | 'confirm'): Promise<CryptoKey | null> {
  const cfg = lockConfig(owner);
  if (!cfg) return Promise.resolve(null);
  if (purpose === 'unlock') {
    // Several things may want the key at once (an order, a restore): one dialog.
    const same = queue.find((p) => p.req.owner === owner && p.req.purpose === 'unlock');
    if (same) return same.promise;
  }
  let settle!: (k: CryptoKey | null) => void;
  const promise = new Promise<CryptoKey | null>((r) => (settle = r));
  let done = false;
  const finish = async (k: CryptoKey | null): Promise<void> => {
    if (done) return;
    done = true;
    queue = queue.filter((p) => p.req !== req);
    if (k) await setUnlocked(owner, k);
    else emit();
    settle(k);
  };
  /** A key that is not the lock's is refused after a pause, so guessing is slow. */
  const attempt = async (derive: () => Promise<CryptoKey>, wrong: string): Promise<string | null> => {
    if (done) return null;
    const now = lockConfig(owner);
    if (!now || now.kind !== cfg.kind) {
      void finish(null);
      return 'The lock was changed in another tab. Try again.';
    }
    let key: CryptoKey;
    try {
      key = await derive();
    } catch (e) {
      return cfg.kind === 'passkey' ? passkeyError(e) : (e as Error)?.message || wrong;
    }
    if (!(await verifyCheck(key, owner, now.check))) {
      await sleep(failDelayMs);
      return wrong;
    }
    await finish(key);
    return null;
  };
  const req: UnlockRequest = {
    id: nextId++,
    owner,
    kind: cfg.kind,
    reason,
    purpose,
    submitPassword: (password) => {
      const c = lockConfig(owner);
      if (c?.kind !== 'password') return attempt(() => Promise.reject(new Error('This wallet is locked with a passkey.')), '');
      return attempt(() => derivePasswordKey(password, fromB64u(c.salt), c.iterations), 'Wrong password.');
    },
    usePasskey: () => {
      const c = lockConfig(owner);
      if (c?.kind !== 'passkey') return attempt(() => Promise.reject(new Error('This wallet is locked with a password.')), '');
      return attempt(async () => deriveKeyFromPrf(await passkeyOutput(c)), 'This is not the passkey this lock was set with.');
    },
    cancel: () => void finish(null),
  };
  queue = [...queue, { req, promise }];
  emit();
  return promise;
}

/** Open the unlock dialog (unless already unlocked, or no lock). True once the key is usable. */
export async function requestUnlock(owner: string | null | undefined, reason = 'Unlock trading'): Promise<boolean> {
  if (!owner) return false;
  const o = owner.toLowerCase();
  if (lockKind(o) === 'none') return true;
  if (unlocked.has(o)) {
    touch(o);
    // Already unlocked here: make sure whatever still holds the key shut opens it (a no-op otherwise).
    await fire(o, true);
    return true;
  }
  return !!(await ask(o, reason, 'unlock'));
}

/** "Withdraw 100 USDC" -> "Confirm withdrawal of 100 USDC". */
function confirmLine(what: string): string {
  const m = /^(Withdraw|Transfer)\s+(.+)$/i.exec(what.trim());
  if (m) return `Confirm ${m[1]!.toLowerCase() === 'withdraw' ? 'withdrawal' : 'transfer'} of ${m[2]}`;
  return `Confirm: ${what}`;
}

/**
 * Before a withdrawal or transfer starts: with a lock and `askOnMoney`, the
 * password / passkey is asked AGAIN, even while unlocked - money leaving is the
 * moment a walked-away-from screen matters most. True at once without a lock.
 */
export async function confirmMoneyMove(owner: string | null | undefined, what: string): Promise<boolean> {
  if (!owner) return true;
  const o = owner.toLowerCase();
  if (lockKind(o) === 'none') return true;
  if (!readSettings().askOnMoney) return requestUnlock(o, `Unlock to continue: ${what}`);
  return !!(await ask(o, confirmLine(what), 'confirm'));
}

// --- setting the lock ------------------------------------------------------------------

/** Changing or removing a lock first proves the current one. Null: there is none. */
async function proveCurrent(owner: string, reason: string): Promise<CryptoKey | null> {
  if (lockKind(owner) === 'none') return null;
  const k = await ask(owner, reason, 'confirm');
  if (!k) throw new KeyLockCancelled();
  return k;
}

async function install(owner: string, prev: CryptoKey | null, key: CryptoKey, cfg: LockConfig): Promise<void> {
  // The stored key first: if it cannot be re-sealed, the old lock stays as it was.
  await resealer?.(owner, prev, key);
  writeConfig(owner, cfg);
  await setUnlocked(owner, key);
}

export async function setPasswordLock(owner: string, password: string): Promise<void> {
  const o = owner.toLowerCase();
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  const prev = await proveCurrent(o, 'Confirm your current lock to change it');
  const salt = random(16);
  const key = await derivePasswordKey(password, salt, PBKDF2_ITERATIONS);
  await install(o, prev, key, {
    kind: 'password',
    salt: toB64u(salt),
    iterations: PBKDF2_ITERATIONS,
    check: await makeCheck(key, o),
  });
}

export async function setPasskeyLock(owner: string): Promise<void> {
  const o = owner.toLowerCase();
  if (!webauthn()) throw new Error('This browser cannot use passkeys here. Use a password lock instead.');
  const prev = await proveCurrent(o, 'Confirm your current lock to change it');
  const rpId = location.hostname;
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        challenge: random(32),
        rp: { name: 'ValueDesk', id: rpId },
        user: { id: random(16), name: shortOwner(o), displayName: 'ValueDesk trading key' },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw new Error(passkeyError(e));
  }
  if (!cred) throw new KeyLockCancelled();
  if (!(cred.getClientExtensionResults() as PrfResults).prf?.enabled) throw new Error(PRF_UNSUPPORTED);
  const base = { credentialId: toB64u(cred.rawId), prfSalt: toB64u(random(32)), rpId };
  // Registration does not evaluate the PRF (no salt was given): one sign-in with the new passkey does.
  let out: ArrayBuffer;
  try {
    out = await passkeyOutput(base);
  } catch (e) {
    throw new Error((e as Error)?.message === PRF_UNSUPPORTED ? PRF_UNSUPPORTED : passkeyError(e));
  }
  const key = await deriveKeyFromPrf(out);
  await install(o, prev, key, { kind: 'passkey', ...base, check: await makeCheck(key, o) });
}

export async function removeLock(owner: string): Promise<void> {
  const o = owner.toLowerCase();
  const prev = await proveCurrent(o, 'Confirm your lock to remove it');
  if (!prev) return;
  await resealer?.(o, prev, null);
  writeConfig(o, null);
  const e = unlocked.get(o);
  if (e?.timer) clearTimeout(e.timer);
  unlocked.delete(o);
  emit();
}

// --- the hook ---------------------------------------------------------------------------

export interface KeyLockState {
  kind: LockKind;
  /** The key can be used without asking. Always true without a lock (there is nothing to unlock). */
  unlocked: boolean;
  autoLockMinutes: number;
  /** Ask again before withdrawals and transfers; only ever true while a lock exists. */
  askOnMoney: boolean;
}

export function keyLockState(owner: string | null | undefined): KeyLockState {
  const kind = lockKind(owner);
  const s = readSettings();
  return {
    kind,
    unlocked: kind === 'none' || (!!owner && unlocked.has(owner.toLowerCase())),
    autoLockMinutes: s.autoLockMinutes,
    askOnMoney: kind !== 'none' && s.askOnMoney,
  };
}

export function useKeyLock(owner: string | null): KeyLockState {
  const v = useSyncExternalStore(subscribeKeyLock, () => version, () => version);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => keyLockState(owner), [owner, v]);
}

/** For tests: forget every lock, key, setting and request. */
export function _resetKeyLockForTests(o: { failDelayMs?: number } = {}): void {
  for (const e of unlocked.values()) if (e.timer) clearTimeout(e.timer);
  unlocked.clear();
  for (const p of queue) p.req.cancel();
  queue = [];
  memStore.clear();
  try {
    storage().removeItem(CONFIG_KEY);
    storage().removeItem(SETTINGS_KEY);
  } catch {
    /* nothing stored */
  }
  failDelayMs = o.failDelayMs ?? 1_000;
  emit();
}
