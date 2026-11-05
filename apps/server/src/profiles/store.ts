/**
 * Who has which username: `profiles.db` in the server's data directory (SQLite, WAL), read and
 * written by the main and the beta API alike, so a name is taken once across both. In the off-server
 * backup with the other API state (deploy/server/bin/backup-offsite.sh).
 *
 *   wallet_names    a wallet's current name; unique in any spelling.
 *   name_changes    every signed change, kept whole, old name included: who asked for what and when.
 *
 * The first name is unsigned, so it can only be taken by a wallet that has none. Every later name
 * needs the wallet's signature (claim.ts), signed later than its last signed change, so an old
 * signature cannot be replayed to bring back an old name.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../builder/paths.js';
import { usernameKey, type UsernameChange } from './claim.js';

export const profilesDbPath = (): string => process.env.VALUESCAN_PROFILES_DB?.trim() || join(dataDir(), 'profiles.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wallet_names (
  address TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS name_changes (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL,
  old_username TEXT NOT NULL,
  username TEXT NOT NULL,
  at INTEGER NOT NULL,
  statement TEXT NOT NULL,
  nonce TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  signature TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS name_changes_address ON name_changes (address, at);
`;

export interface Profile {
  address: string;
  username: string;
  updatedAt: number;
}

export type SetResult =
  /** Taken now, or this very name was this wallet's already (a repeat of the same request). */
  | { ok: true; profile: Profile; fresh: boolean }
  /** This wallet has another name: changing it needs its signature. */
  | { ok: false; code: 'has-name'; profile: Profile }
  /** Another wallet has this name. */
  | { ok: false; code: 'taken' };

export type ChangeResult =
  | { ok: true; profile: Profile; fresh: boolean }
  | { ok: false; code: 'taken' }
  /** Signed before the wallet's last change. */
  | { ok: false; code: 'stale' };

const isUnique = (e: unknown): boolean => /UNIQUE|constraint/i.test(String((e as Error).message));

export class ProfileStore {
  private readonly db: DatabaseSync;

  constructor(path = profilesDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.carryOver();
  }

  /**
   * v0.2.158 kept names in `usernames`, each with the claim its wallet signed. Those wallets keep them:
   * copied once, the old table left as it is for its signatures.
   */
  private carryOver(): void {
    const old = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usernames'").get();
    if (!old) return;
    this.db.exec('INSERT OR IGNORE INTO wallet_names (address, username, username_key, created_at, updated_at) SELECT address, username, username_key, claimed_at, claimed_at FROM usernames');
  }

  byAddress(address: string): Profile | null {
    const r = this.db.prepare('SELECT address, username, updated_at FROM wallet_names WHERE address = ?').get(address.toLowerCase()) as
      | { address: string; username: string; updated_at: number }
      | undefined;
    return r ? { address: r.address, username: r.username, updatedAt: r.updated_at } : null;
  }

  /** Whether a wallet other than `except` holds this name, in any spelling. */
  isTaken(username: string, except?: string): boolean {
    const r = this.db.prepare('SELECT address FROM wallet_names WHERE username_key = ?').get(usernameKey(username)) as { address: string } | undefined;
    return !!r && r.address !== except?.toLowerCase();
  }

  /** A wallet's first name. No signature: so only for a wallet that has none. */
  setFirst(address: string, username: string, now = Date.now()): SetResult {
    const owner = address.toLowerCase();
    const have = this.byAddress(owner);
    if (have) {
      return usernameKey(have.username) === usernameKey(username) ? { ok: true, profile: have, fresh: false } : { ok: false, code: 'has-name', profile: have };
    }
    try {
      this.db.prepare('INSERT INTO wallet_names (address, username, username_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(owner, username, usernameKey(username), now, now);
    } catch (e) {
      /* Two tabs or two wallets at the same moment: the UNIQUE constraints decide, and the row tells who won. */
      if (!isUnique(e)) throw e;
      const again = this.byAddress(owner);
      if (!again) return { ok: false, code: 'taken' };
      return usernameKey(again.username) === usernameKey(username) ? { ok: true, profile: again, fresh: false } : { ok: false, code: 'has-name', profile: again };
    }
    return { ok: true, profile: { address: owner, username, updatedAt: now }, fresh: true };
  }

  /** A checked, signed change (route: signature, wording and name rules passed). Works with or without a name before. */
  change(c: UsernameChange, now = Date.now()): ChangeResult {
    const owner = c.owner.toLowerCase();
    const have = this.byAddress(owner);
    const last = this.db.prepare('SELECT MAX(issued_at) AS t FROM name_changes WHERE address = ?').get(owner) as { t: number | null };
    if (last.t !== null && Number(c.issuedAt) <= last.t) {
      return have?.username === c.username ? { ok: true, profile: have, fresh: false } : { ok: false, code: 'stale' };
    }
    try {
      this.db.exec('BEGIN IMMEDIATE');
      if (have) {
        this.db.prepare('UPDATE wallet_names SET username = ?, username_key = ?, updated_at = ? WHERE address = ?').run(c.username, usernameKey(c.username), now, owner);
      } else {
        this.db.prepare('INSERT INTO wallet_names (address, username, username_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(owner, c.username, usernameKey(c.username), now, now);
      }
      this.db.prepare('INSERT INTO name_changes (address, old_username, username, at, statement, nonce, issued_at, expires_at, chain_id, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(owner, have?.username ?? '', c.username, now, c.statement, c.nonce, Number(c.issuedAt), Number(c.expiresAt), c.chainId, c.signature);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      if (!isUnique(e)) throw e;
      return { ok: false, code: 'taken' };
    }
    return { ok: true, profile: { address: owner, username: c.username, updatedAt: now }, fresh: true };
  }

  close(): void {
    this.db.close();
  }
}
