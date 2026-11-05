/**
 * Who took which username: `profiles.db` in the server's data directory (SQLite, WAL), read and
 * written by the main and the beta API alike, so a name is taken once across both. In the
 * off-server backup with the other API state (deploy/server/bin/backup-offsite.sh).
 *
 * A row is the wallet's signed claim, kept whole (profiles/claim.ts): the signature, its nonce and
 * times, so whoever reads this later can recompute who asked for the name and when.
 *
 * A NAME DOES NOT CHANGE, and that is the database's rule as well as the route's: a trigger aborts
 * every UPDATE. Removing a name (a court order, an impersonation report) is a deliberate hand
 * edit on the server: this code has no path to it.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../builder/paths.js';
import { usernameKey, type UsernameClaim } from './claim.js';

export const profilesDbPath = (): string => process.env.VALUESCAN_PROFILES_DB?.trim() || join(dataDir(), 'profiles.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usernames (
  address TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_key TEXT NOT NULL UNIQUE,
  claimed_at INTEGER NOT NULL,
  statement TEXT NOT NULL,
  nonce TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  signature TEXT NOT NULL
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS usernames_never_change BEFORE UPDATE ON usernames
BEGIN SELECT RAISE(ABORT, 'a username does not change'); END;
`;

export interface Profile {
  address: string;
  username: string;
  claimedAt: number;
}

export type ClaimResult =
  /** Taken now, or this very name was this wallet's already (a repeat of the same claim). */
  | { ok: true; profile: Profile; fresh: boolean }
  /** This wallet already has another name. */
  | { ok: false; code: 'has-name'; profile: Profile }
  /** Another wallet has this name. */
  | { ok: false; code: 'taken' };

export class ProfileStore {
  private readonly db: DatabaseSync;

  constructor(path = profilesDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  byAddress(address: string): Profile | null {
    const r = this.db.prepare('SELECT address, username, claimed_at FROM usernames WHERE address = ?').get(address.toLowerCase()) as
      | { address: string; username: string; claimed_at: number }
      | undefined;
    return r ? { address: r.address, username: r.username, claimedAt: r.claimed_at } : null;
  }

  /** Whether another wallet holds this name, in any spelling. */
  isTaken(username: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM usernames WHERE username_key = ?').get(usernameKey(username));
  }

  /** Take a checked claim (route: signature, statement and name rules already passed). */
  claim(c: UsernameClaim, now = Date.now()): ClaimResult {
    const owner = c.owner.toLowerCase();
    const have = this.byAddress(owner);
    if (have) {
      return usernameKey(have.username) === usernameKey(c.username) ? { ok: true, profile: have, fresh: false } : { ok: false, code: 'has-name', profile: have };
    }
    try {
      this.db.prepare(
        'INSERT INTO usernames (address, username, username_key, claimed_at, statement, nonce, issued_at, expires_at, chain_id, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(owner, c.username, usernameKey(c.username), now, c.statement, c.nonce, Number(c.issuedAt), Number(c.expiresAt), c.chainId, c.signature);
    } catch (e) {
      /* Two tabs or two wallets at the same moment: the UNIQUE constraints decide, and the row tells who won. */
      if (!/UNIQUE|constraint/i.test(String((e as Error).message))) throw e;
      const again = this.byAddress(owner);
      if (again) return usernameKey(again.username) === usernameKey(c.username) ? { ok: true, profile: again, fresh: false } : { ok: false, code: 'has-name', profile: again };
      return { ok: false, code: 'taken' };
    }
    return { ok: true, profile: { address: owner, username: c.username, claimedAt: now }, fresh: true };
  }

  close(): void {
    this.db.close();
  }
}
