/**
 * Encrypted-at-rest storage for the SoDEX API signing keys.
 *
 * Threat model, stated plainly:
 *  - The MASTER wallet key is never here and never anywhere in this codebase.
 *    It lives in the user's wallet extension and only ever signs EIP-712
 *    authorisations via `eth_signTypedData_v4`.
 *  - The API signing key IS here, because something has to sign order payloads.
 *    It is encrypted at rest and held in plaintext only in this process's memory
 *    while unlocked.
 *  - The encryption secret is EITHER a machine-local device key (the default -
 *    see deviceKey.ts) OR a user passphrase. Same file format and same crypto
 *    either way; only the source of the secret differs.
 *  - Encryption protects the key at rest (backups, cloud-synced folders, disk
 *    images) - which matters here because this project sits inside a OneDrive
 *    directory. It does NOT protect against malware already running as this
 *    user, and a typed passphrase would not either.
 *
 * The file holds N accounts, keyed by master wallet address. Each account is a
 * self-contained record with ITS OWN scrypt salt and IV: sharing a salt across
 * accounts would mean one scrypt evaluation cracks every record encrypted under
 * the same passphrase, which is exactly the amortisation scrypt exists to deny.
 * A record is therefore byte-identical to the old single-slot file, which is what
 * makes the migration below a pure re-keying of the container.
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync, renameSync } from 'node:fs';

/** One encrypted signing key. Unchanged from the pre-multi-account format. */
export interface KeystoreRecord {
  version: 1;
  /** scrypt salt, hex. Per record - never shared between accounts. */
  salt: string;
  /** AES-256-GCM iv, hex. */
  iv: string;
  /** GCM auth tag, hex. */
  tag: string;
  /** Encrypted private key, hex. */
  ciphertext: string;
  /** Public, non-secret metadata - safe to read without the passphrase. */
  meta: KeystoreMeta;
}

/**
 * Historical name for a single record, kept because `encryptKeystore` /
 * `decryptKeystore` still speak in records and callers (and tests) name the type.
 */
export type KeystoreFile = KeystoreRecord;

/** The on-disk container: many records plus which one routes default to. */
export interface KeystoreVault {
  version: 2;
  /** Lowercased master wallet address -> record. */
  accounts: Record<string, KeystoreRecord>;
  /** Lowercased address of the account unspecified requests act as; null when empty. */
  active: string | null;
}

export interface KeystoreMeta {
  apiKeyName: string;
  accountId: number;
  /** Master wallet address this key acts for. */
  address: string;
  /** The API key's own EVM address (what the gateway calls "publicKey"). */
  keyAddress: string;
  network: string;
  permissions: number;
  /** Unix seconds; 0 = never. */
  expiresAt: number;
  createdAt: number;
  /**
   * How the ciphertext is protected. 'device' means the secret lives in a
   * machine-local file outside any synced directory and unlocking needs no user
   * input; 'passphrase' means the user supplies it. Absent on older keystores,
   * which are treated as 'passphrase'.
   *
   * 'memory' is the DEFAULT for the one-click flow and never appears in a file:
   * such a key is held in this process only and is deliberately never written.
   * It is part of this type because the same metadata shape describes a live
   * session, not only a stored one - `saveAccount` refuses to persist it.
   */
  protection?: 'device' | 'passphrase' | 'memory';
}

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32 } as const;

const derive = (passphrase: string, salt: Buffer): Buffer =>
  scryptSync(passphrase, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });

export function encryptKeystore(privateKeyHex: string, passphrase: string, meta: KeystoreMeta): KeystoreRecord {
  // Fresh salt AND fresh iv on every call, so two accounts sharing a passphrase
  // still derive different keys and never reuse a GCM (key, iv) pair.
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(passphrase, salt), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex')),
    cipher.final(),
  ]);
  return {
    version: 1,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    meta,
  };
}

export class KeystoreError extends Error {}

export function decryptKeystore(file: KeystoreRecord, passphrase: string): string {
  if (file.version !== 1) throw new KeystoreError(`unsupported keystore version ${file.version}`);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    derive(passphrase, Buffer.from(file.salt, 'hex')),
    Buffer.from(file.iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(file.tag, 'hex'));
  try {
    const plain = Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext, 'hex')),
      decipher.final(),
    ]);
    if (plain.length !== 32) throw new KeystoreError('decrypted key is not 32 bytes');
    return '0x' + plain.toString('hex');
  } catch (e) {
    if (e instanceof KeystoreError) throw e;
    // GCM auth failure - wrong passphrase or a tampered file. Same message either way.
    throw new KeystoreError('wrong passphrase or corrupted keystore');
  }
}

// --- vault -------------------------------------------------------------------

/**
 * Addresses are the vault's primary key, so they must normalise exactly once and
 * in one place. EIP-55 mixed case is display sugar; the same wallet arrives from
 * the browser, the gateway and the keystore in three different casings, and three
 * casings would be three accounts.
 */
export const addressKey = (address: string): string => address.trim().toLowerCase();

const keyOfRecord = (r: KeystoreRecord): string => {
  // `address` is the master wallet; `keyAddress` is only a fallback for a record
  // written before the wallet address was recorded. Without either there is no
  // stable identity to file it under, and inventing one would orphan the key.
  const id = r.meta?.address || r.meta?.keyAddress;
  if (!id) throw new KeystoreError('keystore record has no address to key it by');
  return addressKey(id);
};

const emptyVault = (): KeystoreVault => ({ version: 2, accounts: {}, active: null });

/**
 * Fold whatever is on disk into the vault shape.
 *
 * Exported because the legacy migration is the one path here that, if it were
 * wrong, would silently orphan a user's only signing key - it is tested directly
 * rather than only through the filesystem.
 */
export function parseVault(raw: unknown): KeystoreVault {
  if (!raw || typeof raw !== 'object') throw new KeystoreError('keystore file is not an object');
  const obj = raw as Record<string, unknown>;

  // Legacy single-slot file: `{version:1, salt, iv, tag, ciphertext, meta}`. It is
  // already exactly one record, so migrating is filing it under its own address
  // and marking it active - no re-encryption, and the existing device key or
  // passphrase still opens it.
  if (obj.version === 1 && typeof obj.ciphertext === 'string') {
    const record = raw as KeystoreRecord;
    const key = keyOfRecord(record);
    return { version: 2, accounts: { [key]: record }, active: key };
  }

  if (obj.version === 2 && obj.accounts && typeof obj.accounts === 'object') {
    const accounts: Record<string, KeystoreRecord> = {};
    for (const [k, v] of Object.entries(obj.accounts as Record<string, KeystoreRecord>)) {
      // Re-key rather than trusting the stored key: a hand-edited file, or one
      // written by an older build, may carry checksummed casing.
      accounts[addressKey(k)] = v;
    }
    const wanted = typeof obj.active === 'string' ? addressKey(obj.active) : null;
    const active = wanted && accounts[wanted] ? wanted : (Object.keys(accounts)[0] ?? null);
    return { version: 2, accounts, active };
  }

  // Refuse rather than guess. Returning an empty vault here would look identical
  // to "no keystore yet" and the next save would overwrite real key material.
  throw new KeystoreError(`unrecognised keystore file (version ${String(obj.version)})`);
}

/** Read the whole vault. An absent file is an empty vault, not an error. */
export function loadVault(path: string): KeystoreVault {
  if (!existsSync(path)) return emptyVault();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new KeystoreError(`keystore file is not valid JSON: ${(e as Error).message}`);
  }
  return parseVault(raw);
}

/**
 * Write the whole vault.
 *
 * Temp file plus rename, because this path now carries N users' keys and a
 * half-written file destroys all of them. `renameSync` maps to MoveFileEx with
 * REPLACE_EXISTING on Windows, so the swap is atomic there too. The direct-write
 * fallback exists for the OneDrive case, where the sync client can hold a
 * transient lock on the destination: the serialised text is complete in memory
 * before either write, so the fallback's only exposure is the process dying
 * mid-write, which is far narrower than not persisting a just-registered key.
 */
export function saveVault(path: string, vault: KeystoreVault): void {
  const text = JSON.stringify(vault, null, 2);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    writeFileSync(path, text, { mode: 0o600 });
  }
  try {
    chmodSync(path, 0o600); // no-op on Windows, meaningful elsewhere
  } catch {
    /* best effort */
  }
}

/**
 * Persist ONE account, leaving every other account untouched.
 *
 * Read-modify-write, never a blind overwrite: the old code wrote the file as a
 * single slot, so registering a second wallet would have silently destroyed the
 * first wallet's key - unrecoverably, since the plaintext exists nowhere else.
 */
export function saveAccount(path: string, record: KeystoreRecord, makeActive = true): string {
  // A belt-and-braces refusal, not a redundant check: the whole security value
  // of a memory-only session key is that it is never on disk, and that property
  // should not depend on every future caller remembering to branch first.
  if (record.meta.protection === 'memory') {
    throw new KeystoreError('refusing to persist a memory-only session key');
  }
  const key = keyOfRecord(record);
  const vault = loadVault(path);
  vault.accounts[key] = record;
  if (makeActive || !vault.active || !vault.accounts[vault.active]) vault.active = key;
  saveVault(path, vault);
  return key;
}

/** Legacy single-account entry point: save and make active. */
export const save = (path: string, record: KeystoreRecord): void => void saveAccount(path, record, true);

/** Every stored record, active first so the UI's default ordering is meaningful. */
export function listAccounts(path: string): KeystoreRecord[] {
  const vault = loadVault(path);
  const keys = Object.keys(vault.accounts);
  keys.sort((a, b) => Number(b === vault.active) - Number(a === vault.active));
  return keys.map((k) => vault.accounts[k]!);
}

export function loadAccount(path: string, address: string): KeystoreRecord | null {
  return loadVault(path).accounts[addressKey(address)] ?? null;
}

/**
 * The active record, or null.
 *
 * Named `load` because that is what every existing caller asks for: "the one
 * account to act as by default".
 */
export function load(path: string): KeystoreRecord | null {
  const vault = loadVault(path);
  return vault.active ? (vault.accounts[vault.active] ?? null) : null;
}

/** Returns false when the address is not stored, so the caller can 404 honestly. */
export function setActiveAccount(path: string, address: string): boolean {
  const key = addressKey(address);
  const vault = loadVault(path);
  if (!vault.accounts[key]) return false;
  vault.active = key;
  saveVault(path, vault);
  return true;
}

/** Delete one account, promoting some other one to active if it was active. */
export function removeAccount(path: string, address: string): boolean {
  const key = addressKey(address);
  const vault = loadVault(path);
  if (!vault.accounts[key]) return false;
  delete vault.accounts[key];
  if (vault.active === key) vault.active = Object.keys(vault.accounts)[0] ?? null;
  // An emptied vault is removed outright rather than left as `{accounts:{}}`, so
  // "no keystore yet" stays a single observable state for the onboarding UI.
  if (Object.keys(vault.accounts).length === 0) remove(path);
  else saveVault(path, vault);
  return true;
}

/** Delete the whole keystore - every account. */
export const remove = (path: string): void => {
  if (existsSync(path)) unlinkSync(path);
};

/** Constant-time compare, used where a secret is checked. */
export function safeEqual(a: string, b: string): boolean {
  const [ba, bb] = [Buffer.from(a), Buffer.from(b)];
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
