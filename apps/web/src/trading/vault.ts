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
 */
import { privateKeyToAddress, type Engine, type Network } from '@sodex-core';

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
  /** The builder approval signed with the key, if any. */
  builder: { id: number; maxFeeRate: number } | null;
  /** Engines that accepted the key; absent = both. */
  engines?: Engine[];
}

export interface Unsealed {
  meta: StoredKey;
  privateKey: Uint8Array;
}

export interface KeyVault {
  /** True when keys survive a reload. */
  readonly persistent: boolean;
  save(meta: StoredKey, privateKey: Uint8Array, opts?: { persist?: boolean }): Promise<void>;
  load(network: Network, owner: string, now?: number): Promise<Unsealed | null>;
  remove(network: Network, owner: string): Promise<void>;
}

const recordId = (network: Network, owner: string): string => `${network}:${owner.toLowerCase()}`;
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

// --- memory ------------------------------------------------------------------

export function memoryVault(): KeyVault {
  const keys = new Map<string, Unsealed>();
  return {
    persistent: false,
    async save(meta, privateKey) {
      keys.get(recordId(meta.network, meta.owner))?.privateKey.fill(0);
      keys.set(recordId(meta.network, meta.owner), { meta: { ...meta }, privateKey: privateKey.slice() });
    },
    async load(network, owner, now = Date.now()) {
      const hit = keys.get(recordId(network, owner));
      if (!hit) return null;
      if (hit.meta.expiresAt <= now) {
        hit.privateKey.fill(0);
        keys.delete(recordId(network, owner));
        return null;
      }
      return { meta: { ...hit.meta }, privateKey: hit.privateKey.slice() };
    },
    async remove(network, owner) {
      keys.get(recordId(network, owner))?.privateKey.fill(0);
      keys.delete(recordId(network, owner));
    },
  };
}

// --- IndexedDB ---------------------------------------------------------------

const DB_NAME = 'vs-trading';
const DB_VERSION = 1;
const KEYS = 'keys';
const WRAP = 'wrap';

interface SealedRecord {
  id: string;
  meta: StoredKey;
  iv: Uint8Array;
  ct: ArrayBuffer;
}

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

function idbVault(): KeyVault {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= openDb());
  const session = memoryVault();

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

  return {
    persistent: true,
    remove,
    async save(meta, privateKey, opts) {
      if (opts?.persist === false) {
        await remove(meta.network, meta.owner);
        await session.save(meta, privateKey);
        return;
      }
      await session.remove(meta.network, meta.owner);
      const k = await wrapKey();
      const sealed = await sealKey(k, meta, privateKey);
      const rec: SealedRecord = { id: recordId(meta.network, meta.owner), meta, ...sealed };
      await req((await db()).transaction(KEYS, 'readwrite').objectStore(KEYS).put(rec));
    },
    async load(network, owner, now = Date.now()) {
      const inMemory = await session.load(network, owner, now);
      if (inMemory) return inMemory;
      const d = await db();
      const rec = (await req(d.transaction(KEYS, 'readonly').objectStore(KEYS).get(recordId(network, owner)))) as
        | SealedRecord
        | undefined;
      if (!rec) return null;
      if (rec.meta?.v !== 1 || !(rec.meta.expiresAt > now)) {
        await remove(network, owner);
        return null;
      }
      const pk = await openKey(await wrapKey(), rec.meta, rec);
      if (!pk) {
        // Corrupt, or sealed under a device key this browser no longer has.
        await remove(network, owner);
        return null;
      }
      return { meta: rec.meta, privateKey: pk };
    },
  };
}

/** The device's vault: IndexedDB + WebCrypto when both work, else memory. */
export async function openVault(): Promise<KeyVault> {
  try {
    if (typeof indexedDB === 'undefined' || !globalThis.crypto?.subtle) return memoryVault();
    const v = idbVault();
    // Prove it works end to end before relying on it (private windows can
    // expose the API and then fail every request).
    await v.load('testnet', '0x0000000000000000000000000000000000000000');
    return v;
  } catch {
    return memoryVault();
  }
}
