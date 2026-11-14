/**
 * Invites and fee credits on record: `invites.db` in the server's data directory (SQLite, WAL), the main and the
 * beta API alike. In the off-server backup with the other API state.
 *
 *   codes      a wallet's invite code (one each, random, never reused)
 *   joins      who joined with which code, with the signed join kept whole; the first join of a wallet stands
 *   entries    the credit ledger: every amount earned (from an invitee's fee) or spent (a fee credits paid), in
 *              micro-USD, never edited, never deleted - the balance is their sum
 *   seen       per builder-ledger order, how much of it was taken into the entries already (an order that fills
 *              further later adds only the new part). Old rows go once the builder ledger let go of the order.
 *   state      per wallet: whether credits are paying now, and since when (the ledger's own record of the switch)
 */
import { DatabaseSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../builder/paths.js';
import { CODE_ALPHABET, CODE_LENGTH, type InviteJoin } from './claim.js';

export const invitesDbPath = (): string => process.env.VALUESCAN_INVITES_DB?.trim() || join(dataDir(), 'invites.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS codes (
  address TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS joins (
  wallet TEXT PRIMARY KEY,
  inviter TEXT NOT NULL,
  code TEXT NOT NULL,
  at INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  signature TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS joins_inviter ON joins (inviter, at);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL,
  kind TEXT NOT NULL,
  micro INTEGER NOT NULL,
  source TEXT,
  order_key TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_address ON entries (address, kind);
CREATE TABLE IF NOT EXISTS seen (
  address TEXT NOT NULL,
  order_key TEXT NOT NULL,
  counted_micro INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (address, order_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS state (
  address TEXT PRIMARY KEY,
  paying INTEGER NOT NULL,
  since INTEGER NOT NULL,
  first_paying INTEGER
) WITHOUT ROWID;
`;

export interface Join { wallet: string; inviter: string; code: string; at: number }
export type JoinResult =
  | { ok: true; join: Join; fresh: boolean }
  | { ok: false; code: 'unknown-code' | 'self' | 'joined' | 'has-volume' };

const isUnique = (e: unknown): boolean => /UNIQUE|constraint/i.test(String((e as Error).message));

/** A new random code. */
export function newCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export class InviteStore {
  readonly db: DatabaseSync;

  constructor(path = invitesDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  codeOf(address: string): string | null {
    const r = this.db.prepare('SELECT code FROM codes WHERE address = ?').get(address.toLowerCase()) as { code: string } | undefined;
    return r?.code ?? null;
  }

  /** The wallet's code, made the first time it is asked for. */
  ensureCode(address: string, now = Date.now(), make: () => string = newCode): string {
    const a = address.toLowerCase();
    const have = this.codeOf(a);
    if (have) return have;
    for (let i = 0; i < 8; i++) {
      try {
        const code = make();
        this.db.prepare('INSERT INTO codes (address, code, created_at) VALUES (?, ?, ?)').run(a, code, now);
        return code;
      } catch (e) {
        if (!isUnique(e)) throw e;
        const again = this.codeOf(a);
        if (again) return again; // another request made it meanwhile
      }
    }
    throw new Error('no free invite code');
  }

  ownerOf(code: string): string | null {
    const r = this.db.prepare('SELECT address FROM codes WHERE code = ?').get(code) as { address: string } | undefined;
    return r?.address ?? null;
  }

  joinOf(wallet: string): Join | null {
    const r = this.db.prepare('SELECT wallet, inviter, code, at FROM joins WHERE wallet = ?').get(wallet.toLowerCase()) as Join | undefined;
    return r ? { wallet: r.wallet, inviter: r.inviter, code: r.code, at: Number(r.at) } : null;
  }

  invitesOf(inviter: string): Join[] {
    const rows = this.db.prepare('SELECT wallet, inviter, code, at FROM joins WHERE inviter = ? ORDER BY at DESC LIMIT 500').all(inviter.toLowerCase()) as unknown as Join[];
    return rows.map((r) => ({ wallet: r.wallet, inviter: r.inviter, code: r.code, at: Number(r.at) }));
  }

  /** Every join (the credit job walks them). */
  allJoins(): Join[] {
    return (this.db.prepare('SELECT wallet, inviter, code, at FROM joins').all() as unknown as Join[]).map((r) => ({ ...r, at: Number(r.at) }));
  }

  /**
   * A signed join. `hasVolume`: whether the builder ledger counts any volume for the wallet (a wallet that already
   * trades on ValueDesk joins nobody). The first join of a wallet stands; a repeat of it is answered as done.
   */
  join(j: InviteJoin, hasVolume: boolean, now = Date.now()): JoinResult {
    const wallet = j.wallet.toLowerCase();
    const inviter = this.ownerOf(j.code);
    if (!inviter) return { ok: false, code: 'unknown-code' };
    if (inviter === wallet) return { ok: false, code: 'self' };
    const have = this.joinOf(wallet);
    if (have) return have.code === j.code ? { ok: true, join: have, fresh: false } : { ok: false, code: 'joined' };
    if (hasVolume) return { ok: false, code: 'has-volume' };
    try {
      this.db.prepare('INSERT INTO joins (wallet, inviter, code, at, nonce, issued_at, expires_at, chain_id, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(wallet, inviter, j.code, now, j.nonce, Number(j.issuedAt), Number(j.expiresAt), j.chainId, j.signature);
    } catch (e) {
      if (!isUnique(e)) throw e;
      const again = this.joinOf(wallet);
      return again && again.code === j.code ? { ok: true, join: again, fresh: false } : { ok: false, code: 'joined' };
    }
    return { ok: true, join: { wallet, inviter, code: j.code, at: now }, fresh: true };
  }

  /* -------------------------------------------------------------- the credit ledger ----- */

  /** How much of a builder-ledger order was taken in already (micro-USD of counted volume). */
  seenOf(address: string, orderKey: string): number {
    const r = this.db.prepare('SELECT counted_micro FROM seen WHERE address = ? AND order_key = ?').get(address, orderKey) as { counted_micro: number } | undefined;
    return r ? Number(r.counted_micro) : 0;
  }

  /** Take in one order's new part: its entries and how far it was seen, together. */
  take(address: string, orderKey: string, countedMicro: number, entries: ReadonlyArray<{ address: string; kind: 'earn' | 'spend'; micro: number; source: string | null }>, now: number): void {
    this.db.exec('BEGIN');
    try {
      const ins = this.db.prepare('INSERT INTO entries (address, kind, micro, source, order_key, at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const e of entries) if (e.micro > 0) ins.run(e.address, e.kind, Math.round(e.micro), e.source, orderKey, now);
      this.db.prepare('INSERT INTO seen (address, order_key, counted_micro, at) VALUES (?, ?, ?, ?) ON CONFLICT (address, order_key) DO UPDATE SET counted_micro = excluded.counted_micro, at = excluded.at')
        .run(address, orderKey, countedMicro, now);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Earned, spent and the balance of a wallet, micro-USD. */
  totals(address: string): { earned: number; spent: number; balance: number } {
    const rows = this.db.prepare('SELECT kind, sum(micro) AS m FROM entries WHERE address = ? GROUP BY kind').all(address.toLowerCase()) as Array<{ kind: string; m: number }>;
    let earned = 0;
    let spent = 0;
    for (const r of rows) {
      if (r.kind === 'earn') earned = Number(r.m);
      else if (r.kind === 'spend') spent = Number(r.m);
    }
    return { earned, spent, balance: earned - spent };
  }

  /** Credit earned from one invitee, micro-USD. */
  earnedFrom(inviter: string, invitee: string): number {
    const r = this.db.prepare("SELECT sum(micro) AS m FROM entries WHERE address = ? AND kind = 'earn' AND source = ?").get(inviter.toLowerCase(), invitee.toLowerCase()) as { m: number | null };
    return Number(r.m ?? 0);
  }

  /** Wallets that ever had credit (the job's list of whom to spend for). */
  creditWallets(): string[] {
    return (this.db.prepare("SELECT DISTINCT address FROM entries WHERE kind = 'earn'").all() as Array<{ address: string }>).map((r) => r.address);
  }

  stateOf(address: string): { paying: boolean; since: number } | null {
    const r = this.db.prepare('SELECT paying, since FROM state WHERE address = ?').get(address) as { paying: number; since: number } | undefined;
    return r ? { paying: r.paying === 1, since: Number(r.since) } : null;
  }

  setState(address: string, paying: boolean, now: number): void {
    this.db.prepare('INSERT INTO state (address, paying, since) VALUES (?, ?, ?) ON CONFLICT (address) DO UPDATE SET paying = excluded.paying, since = excluded.since WHERE state.paying <> excluded.paying')
      .run(address, paying ? 1 : 0, now);
    if (paying) this.db.prepare('UPDATE state SET first_paying = ? WHERE address = ? AND first_paying IS NULL').run(now, address);
  }

  /** When credits first paid for this wallet (null: never yet): spending is counted from then on. */
  firstPaying(address: string): number | null {
    const r = this.db.prepare('SELECT first_paying FROM state WHERE address = ?').get(address) as { first_paying: number | null } | undefined;
    return r?.first_paying === null || r?.first_paying === undefined ? null : Number(r.first_paying);
  }

  /** Let go of what the builder ledger let go of (its orders are kept for weeks; these a while longer). */
  pruneSeen(before: number): number {
    return Number(this.db.prepare('DELETE FROM seen WHERE at < ?').run(before).changes);
  }
}
