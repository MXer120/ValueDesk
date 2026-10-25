/**
 * The trading key on this device, for its lifetime (7 days by default).
 *
 * WHY KEEP IT AT ALL. A key held only in memory dies with the tab: every
 * reload, every new tab would ask the wallet for another signature. SoDEX's
 * own web app keeps its 7-day key; so do Hyperliquid and most perp DEXs.
 * What bounds the risk is the key itself - it expires, it can be revoked, and
 * per SoDEX's docs it cannot send funds to anyone but its owner - not where a
 * page keeps it: script running in this origin could use an in-memory key
 * just as well.
 *
 * HOW. IndexedDB, one record per (network, wallet). The private key is sealed
 * with AES-GCM under a device key that WebCrypto generates NON-EXTRACTABLE and
 * stores in the same database: the raw key bytes are never written anywhere,
 * and the wrapping key cannot be read out of the browser at all, only used by
 * this origin. The record's own identity (network, owner, key address) is the
 * AES-GCM additional data, so a sealed key cannot be moved onto another record.
 * On load the key must hash back to the address it was registered under.
 *
 * Opting out ("don't remember this device") keeps it in memory only. Without
 * IndexedDB or WebCrypto (some private windows) the vault falls back to memory
 * and says so.
 *
 * THE USER LOCK (keyLock.ts, optional). The device key only proves "this
 * browser profile": anyone at the unlocked computer, or script in this origin,
 * can use it. With a password or passkey lock the private key is sealed TWICE:
 * first under the user's key (derived from the password / passkey PRF, held in
 * memory only while unlocked), then that ciphertext under the device key as
 * above, both bound to the same additional data. Such a record says `lock: 1`;
 * without a lock the record is byte for byte what it always was, so nobody who
 * never sets a lock is migrated. A locked record without the right user key
 * throws KeyLockedError and is KEPT: a wrong password must never delete a key.
 * The memory vault seals locked keys under the user key too, so after an
 * auto-lock no plaintext copy is left in the tab.
 */
import { privateKeyToAddress, type Engine, type Network } from '@sodex-core';
import type { BuilderApproval } from './builder';

export interface StoredKey {
  v: 1;
  network: Network;
  /** The master wallet (SoDEX account owner), lower-case. */
  owner: string;
  accountId: number;
  /** The API key name - X-API-Key. Public: anyone can list an account's key names. */
  name: string;
  /** The key's EVM address (its registered `publicKey`), lower-case. */
  keyAddress: string;
  /** Registration expiry, ms. */
  expiresAt: number;
  createdAt: number;
  /**
   * The builder-fee approval SoDEX lists for this ACCOUNT, per engine, as last
   * read (builder.ts). It is not part of the key: it is kept here so orders
   * know where the fee may be attached, and re-read whenever the key is restored.
   */
  builder: BuilderApproval | null;
  /** Engines that accepted the key; absent = both. */
  engines?: Engine[];
}

export interface Unsealed {
  meta: StoredKey;
  privateKey: Uint8Array;
  /** The record was sealed under a user key (keyLock.ts). */
  locked?: boolean;
}

/** The lock version a locked record is sealed with (the inner layer's format). */
export const LOCK_VERSION = 1 as const;

/**
 * A locked record whose user key was not given, or did not open it. The record
 * is kept; `meta` is what the UI may show meanwhile (it holds nothing secret).
 */
export class KeyLockedError extends Error {
  override name = 'KeyLockedError';
  constructor(
    readonly meta: StoredKey,
    /** True when a user key was given and did not open the record. */
    readonly wrongKey: boolean,
  ) {
    super(wrongKey ? 'The trading key is locked with another password or passkey.' : 'The trading key is locked.');
  }
}

export interface SaveOptions {
  persist?: boolean;
  /** Seal under this user key too (keyLock.ts); absent = an unlocked record, as before. */
  userKey?: CryptoKey | null;
}

export interface KeyVault {
  /** True when keys survive a reload. */
  readonly persistent: boolean;
  save(meta: StoredKey, privateKey: Uint8Array, opts?: SaveOptions): Promise<void>;
  /** Throws KeyLockedError for a locked record without the right `userKey`. */
  load(network: Network, owner: string, now?: number, userKey?: CryptoKey | null): Promise<Unsealed | null>;
  remove(network: Network, owner: string): Promise<void>;
  /**
   * Seal the stored key again, from `from` (null: it is unlocked now) to `to`
   * (null: unlock it), keeping where it lives (device or this tab). False when
   * there is nothing stored. Throws KeyLockedError when `from` does not open it.
   */
  reseal(network: Network, owner: string, from: CryptoKey | null, to: CryptoKey | null, now?: number): Promise<boolean>;
}

const baseId = (network: Network, owner: string): string => `${network}:${owner.toLowerCase()}`;
/** A slot keeps a second key per wallet apart (the browser copier's, 'copy'); '' is the trading key. */
const idIn = (slot: string) => (network: Network, owner: string): string => (slot ? `${slot}:${baseId(network, owner)}` : baseId(network, owner));
const aad = (m: Pick<StoredKey, 'network' | 'owner' | 'keyAddress'>): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(`vs-trading-key:v1:${m.network}:${m.owner.toLowerCase()}:${m.keyAddress.toLowerCase()}`);

/** Seal `privateKey` under `wrapKey` (AES-GCM, 96-bit random IV, bound to `meta`). */
export async function sealKey(
  wrapKey: CryptoKey,
  meta: StoredKey,
  privateKey: Uint8Array,
): Promise<{ iv: Uint8Array; ct: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  // WebCrypto wants an ArrayBuffer-backed view: a copy (zeroed after use).
  const plain = privateKey.slice();
  try {
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(meta) }, wrapKey, plain);
    return { iv, ct };
  } finally {
    plain.fill(0);
  }
}

/** Open a sealed key; null when it does not decrypt or does not match its record. */
export async function openKey(
  wrapKey: CryptoKey,
  meta: StoredKey,
  sealed: { iv: Uint8Array; ct: ArrayBuffer },
): Promise<Uint8Array | null> {
  let pk: Uint8Array;
  try {
    pk = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(sealed.iv), additionalData: aad(meta) }, wrapKey, sealed.ct),
    );
  } catch {
    return null;
  }
  if (pk.length !== 32 || privateKeyToAddress(pk).toLowerCase() !== meta.keyAddress.toLowerCase()) {
    pk.fill(0);
    return null;
  }
  return pk;
}

/** A fresh non-extractable device key. */
export const newWrapKey = (): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as Promise<CryptoKey>;

/** Inner layer: `iv (12) || AES-GCM(userKey, privateKey)`, bound to the record like the outer one. */
async function lockSeal(userKey: CryptoKey, meta: StoredKey, privateKey: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const { iv, ct } = await sealKey(userKey, meta, privateKey);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out;
}

/** The inner layer's private key, checked against its address; null when `userKey` is not the one. */
async function lockOpen(userKey: CryptoKey, meta: StoredKey, inner: Uint8Array): Promise<Uint8Array | null> {
  if (inner.length <= 12) return null;
  return openKey(userKey, meta, { iv: inner.slice(0, 12), ct: inner.slice(12).buffer });
}

/** A stored record: the device-key seal of the private key, or (locked) of its user-key seal. */
export interface SealedRecord {
  id: string;
  meta: StoredKey;
  iv: Uint8Array;
  ct: ArrayBuffer;
  /** Present on a locked record: the lock version its inner layer was sealed with. */
  lock?: typeof LOCK_VERSION;
}

/** Seal a record under the device key, and first under `userKey` when one is given. */
export async function sealRecord(
  deviceKey: CryptoKey,
  id: string,
  meta: StoredKey,
  privateKey: Uint8Array,
  userKey?: CryptoKey | null,
): Promise<SealedRecord> {
  if (!userKey) return { id, meta, ...(await sealKey(deviceKey, meta, privateKey)) };
  const inner = await lockSeal(userKey, meta, privateKey);
  // The outer layer is the same AES-GCM seal; what it seals is the inner ciphertext, not a key.
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(meta) }, deviceKey, inner);
  return { id, meta, iv, ct, lock: LOCK_VERSION };
}

/**
 * Open a record. Null when the DEVICE layer fails (corrupt, or another
 * browser's key: unusable here for good). A locked record without the right
 * `userKey` throws KeyLockedError - it is not broken, it is waiting.
 */
export async function openRecord(deviceKey: CryptoKey, rec: SealedRecord, userKey?: CryptoKey | null): Promise<Unsealed | null> {
  if (!rec.lock) {
    const pk = await openKey(deviceKey, rec.meta, rec);
    return pk ? { meta: rec.meta, privateKey: pk } : null;
  }
  if (rec.lock !== LOCK_VERSION) return null;
  let inner: Uint8Array;
  try {
    inner = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(rec.iv), additionalData: aad(rec.meta) }, deviceKey, rec.ct),
    );
  } catch {
    return null;
  }
  if (!userKey) throw new KeyLockedError(rec.meta, false);
  const pk = await lockOpen(userKey, rec.meta, inner);
  if (!pk) throw new KeyLockedError(rec.meta, true);
  return { meta: rec.meta, privateKey: pk, locked: true };
}

// --- memory ------------------------------------------------------------------

type MemoryEntry = { meta: StoredKey; privateKey: Uint8Array; inner?: undefined } | { meta: StoredKey; privateKey?: undefined; inner: Uint8Array };

export function memoryVault(slot = ''): KeyVault {
  const recordId = idIn(slot);
  const keys = new Map<string, MemoryEntry>();
  const forget = (id: string) => {
    const e = keys.get(id);
    e?.privateKey?.fill(0);
    e?.inner?.fill(0);
    keys.delete(id);
  };
  const v: KeyVault = {
    persistent: false,
    async save(meta, privateKey, opts) {
      const id = recordId(meta.network, meta.owner);
      // Sealed before the old entry goes, so a failing seal leaves what was there.
      const inner = opts?.userKey ? await lockSeal(opts.userKey, meta, privateKey) : null;
      forget(id);
      keys.set(id, inner ? { meta: { ...meta }, inner } : { meta: { ...meta }, privateKey: privateKey.slice() });
    },
    async load(network, owner, now = Date.now(), userKey) {
      const id = recordId(network, owner);
      const hit = keys.get(id);
      if (!hit) return null;
      if (hit.meta.expiresAt <= now) {
        forget(id);
        return null;
      }
      if (hit.privateKey) return { meta: { ...hit.meta }, privateKey: hit.privateKey.slice() };
      if (!userKey) throw new KeyLockedError({ ...hit.meta }, false);
      const pk = await lockOpen(userKey, hit.meta, hit.inner);
      if (!pk) throw new KeyLockedError({ ...hit.meta }, true);
      return { meta: { ...hit.meta }, privateKey: pk, locked: true };
    },
    async remove(network, owner) {
      forget(recordId(network, owner));
    },
    async reseal(network, owner, from, to, now = Date.now()) {
      const hit = await v.load(network, owner, now, from);
      if (!hit) return false;
      try {
        await v.save(hit.meta, hit.privateKey, { userKey: to });
      } finally {
        hit.privateKey.fill(0);
      }
      return true;
    },
  };
  return v;
}

// --- IndexedDB ---------------------------------------------------------------

const DB_NAME = 'vs-trading';
const DB_VERSION = 1;
const KEYS = 'keys';
const WRAP = 'wrap';

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(WRAP)) db.createObjectStore(WRAP);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB unavailable'));
    r.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

function idbVault(slot = ''): KeyVault {
  const recordId = idIn(slot);
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= openDb());
  const session = memoryVault(slot);

  const wrapKey = async (): Promise<CryptoKey> => {
    const d = await db();
    const got = (await req(d.transaction(WRAP, 'readonly').objectStore(WRAP).get('device'))) as CryptoKey | undefined;
    if (got) return got;
    const k = await newWrapKey();
    // A second tab may have raced us here: keep whichever landed first.
    const tx = d.transaction(WRAP, 'readwrite');
    const store = tx.objectStore(WRAP);
    const again = (await req(store.get('device'))) as CryptoKey | undefined;
    if (again) return again;
    await req(store.put(k, 'device'));
    return k;
  };

  const remove = async (network: Network, owner: string): Promise<void> => {
    await session.remove(network, owner);
    try {
      await req((await db()).transaction(KEYS, 'readwrite').objectStore(KEYS).delete(recordId(network, owner)));
    } catch {
      /* nothing stored */
    }
  };

  const readRecord = async (network: Network, owner: string): Promise<SealedRecord | undefined> =>
    (await req((await db()).transaction(KEYS, 'readonly').objectStore(KEYS).get(recordId(network, owner)))) as SealedRecord | undefined;

  const v: KeyVault = {
    persistent: true,
    remove,
    async save(meta, privateKey, opts) {
      if (opts?.persist === false) {
        await remove(meta.network, meta.owner);
        await session.save(meta, privateKey, { userKey: opts.userKey });
        return;
      }
      await session.remove(meta.network, meta.owner);
      const k = await wrapKey();
      const rec = await sealRecord(k, recordId(meta.network, meta.owner), meta, privateKey, opts?.userKey);
      await req((await db()).transaction(KEYS, 'readwrite').objectStore(KEYS).put(rec));
    },
    async load(network, owner, now = Date.now(), userKey) {
      const inMemory = await session.load(network, owner, now, userKey);
      if (inMemory) return inMemory;
      const rec = await readRecord(network, owner);
      if (!rec) return null;
      if (rec.meta?.v !== 1 || !(rec.meta.expiresAt > now)) {
        await remove(network, owner);
        return null;
      }
      // A locked record without its user key throws KeyLockedError out of here, and stays.
      const hit = await openRecord(await wrapKey(), rec, userKey);
      if (!hit) {
        // Corrupt, or sealed under a device key this browser no longer has.
        await remove(network, owner);
        return null;
      }
      return hit;
    },
    async reseal(network, owner, from, to, now = Date.now()) {
      // Where it lives is kept: a tab-only key stays tab-only.
      const inTab = await session.reseal(network, owner, from, to, now);
      if (inTab) return true;
      const hit = await v.load(network, owner, now, from);
      if (!hit) return false;
      try {
        await v.save(hit.meta, hit.privateKey, { persist: true, userKey: to });
      } finally {
        hit.privateKey.fill(0);
      }
      return true;
    },
  };
  return v;
}

/** The device's vault: IndexedDB + WebCrypto when both work, else memory.  names a second key per wallet. */
export async function openVault(slot = ''): Promise<KeyVault> {
  try {
    if (typeof indexedDB === 'undefined' || !globalThis.crypto?.subtle) return memoryVault(slot);
    const v = idbVault(slot);
    // Prove it works end to end before relying on it (private windows can
    // expose the API and then fail every request).
    await v.load('testnet', '0x0000000000000000000000000000000000000000');
    return v;
  } catch {
    return memoryVault(slot);
  }
}
