/**
 * Referrals and fee credits on record: `invites.db` in the server's data directory (SQLite, WAL), the main and the
 * beta API alike. In the off-server backup with the other API state.
 *
 *   codes      SoDEX referral codes and the wallet behind each, as SoDEX said (a code does not change hands)
 *   joins      who joined with which code, with the signed join kept whole; the first join of a wallet stands.
 *              `welcome`: whether that join came with the welcome (the inviter's cap, claim.ts WELCOME_CAP)
 *   entries    the credit ledger: every amount earned (a share of a referral's fee, with its tier) or spent (a fee
 *              credits paid), micro-USD, never edited, never deleted - the balance is their sum
 *   seen       per builder-ledger order, how much of it was taken in already (an order that fills further later adds
 *              only the new part). Old rows go once the builder ledger let go of the order.
 *   state      per wallet: whether credits are paying now, and since when
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../builder/paths.js';
import { TIERS, type InviteJoin, type JoinRefusal } from './claim.js';

export const invitesDbPath = (): string => process.env.VALUESCAN_INVITES_DB?.trim() || join(dataDir(), 'invites.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sodex_codes (
  code TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sodex_codes_owner ON sodex_codes (owner);
CREATE TABLE IF NOT EXISTS joins (
  wallet TEXT PRIMARY KEY,
  inviter TEXT NOT NULL,
  code TEXT NOT NULL,
  at INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  signature TEXT NOT NULL,
  welcome INTEGER NOT NULL DEFAULT 1
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS joins_inviter ON joins (inviter, at);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL,
  kind TEXT NOT NULL,
  micro INTEGER NOT NULL,
  source TEXT,
  order_key TEXT,
  at INTEGER NOT NULL,
  tier INTEGER
);
CREATE INDEX IF NOT EXISTS entries_address ON entries (address, kind);
CREATE INDEX IF NOT EXISTS entries_at ON entries (address, at);
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

export interface Join { wallet: string; inviter: string; code: string; at: number; welcome: boolean }
export type JoinResult = { ok: true; join: Join; fresh: boolean } | { ok: false; code: JoinRefusal };
export interface Entry { address: string; kind: 'earn' | 'spend'; micro: number; source: string | null; tier: number | null }

const isUnique = (e: unknown): boolean => /UNIQUE|constraint/i.test(String((e as Error).message));
const joinOfRow = (r: { wallet: string; inviter: string; code: string; at: number | bigint; welcome?: number | bigint }): Join =>
  ({ wallet: r.wallet, inviter: r.inviter, code: r.code, at: Number(r.at), welcome: Number(r.welcome ?? 1) === 1 });

export class InviteStore {
  readonly db: DatabaseSync;

  constructor(path = invitesDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    // A file from before the tiers: the columns they added.
    const has = (t: string, c: string) => (this.db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).some((x) => x.name === c);
    if (!has('joins', 'welcome')) this.db.exec('ALTER TABLE joins ADD COLUMN welcome INTEGER NOT NULL DEFAULT 1');
    if (!has('entries', 'tier')) this.db.exec('ALTER TABLE entries ADD COLUMN tier INTEGER');
  }

  close(): void {
    this.db.close();
  }

  /* ------------------------------------------------------------------- codes ----- */

  ownerOfCode(code: string): string | null {
    const r = this.db.prepare('SELECT owner FROM sodex_codes WHERE code = ?').get(code) as { owner: string } | undefined;
    return r?.owner ?? null;
  }

  noteCode(code: string, owner: string, now: number): void {
    this.db.prepare('INSERT INTO sodex_codes (code, owner, at) VALUES (?, ?, ?) ON CONFLICT (code) DO NOTHING').run(code, owner.toLowerCase(), now);
  }

  /* ------------------------------------------------------------------- joins ----- */

  joinOf(wallet: string): Join | null {
    const r = this.db.prepare('SELECT wallet, inviter, code, at, welcome FROM joins WHERE wallet = ?').get(wallet.toLowerCase()) as Parameters<typeof joinOfRow>[0] | undefined;
    return r ? joinOfRow(r) : null;
  }

  /** The wallet's direct referrals, newest first. */
  referralsOf(inviter: string, limit = 2000): Join[] {
    return (this.db.prepare('SELECT wallet, inviter, code, at, welcome FROM joins WHERE inviter = ? ORDER BY at DESC LIMIT ?').all(inviter.toLowerCase(), limit) as Array<Parameters<typeof joinOfRow>[0]>).map(joinOfRow);
  }

  hasReferrals(wallet: string): boolean {
    return !!this.db.prepare('SELECT 1 AS x FROM joins WHERE inviter = ? LIMIT 1').get(wallet.toLowerCase());
  }

  /** Every join (the credit job walks them). */
  allJoins(): Join[] {
    return (this.db.prepare('SELECT wallet, inviter, code, at, welcome FROM joins').all() as Array<Parameters<typeof joinOfRow>[0]>).map(joinOfRow);
  }

  /**
   * Who earns from a wallet's fees: its inviter (tier 1), the inviter's inviter (tier 2), the next (tier 3). A loop
   * cannot form (a wallet with referrals never joins), and is cut short should one be on record anyway.
   */
  chainOf(wallet: string): string[] {
    const out: string[] = [];
    let at = wallet.toLowerCase();
    for (let i = 0; i < TIERS; i++) {
      const j = this.joinOf(at);
      if (!j || j.inviter === wallet.toLowerCase() || out.includes(j.inviter)) break;
      out.push(j.inviter);
      at = j.inviter;
    }
    return out;
  }

  /** Welcomes an inviter handed out since `since`. */
  welcomesSince(inviter: string, since: number): number {
    const r = this.db.prepare('SELECT count(*) AS n FROM joins WHERE inviter = ? AND welcome = 1 AND at >= ?').get(inviter.toLowerCase(), since) as { n: number };
    return Number(r.n);
  }

  /**
   * A signed join under `inviter` (the code's owner, from SoDEX). The first join of a wallet stands; a repeat of it is
   * answered as done. `hasVolume`: the builder ledger counts volume for the wallet already.
   */
  join(j: InviteJoin, inviter: string, o: { hasVolume: boolean; welcome: boolean }, now = Date.now()): JoinResult {
    const wallet = j.wallet.toLowerCase();
    const by = inviter.toLowerCase();
    if (by === wallet) return { ok: false, code: 'self' };
    const have = this.joinOf(wallet);
    if (have) return have.inviter === by ? { ok: true, join: have, fresh: false } : { ok: false, code: 'joined' };
    if (o.hasVolume) return { ok: false, code: 'has-volume' };
    // No loops: a wallet others joined already joins nobody (and so a chain only ever grows downwards).
    if (this.hasReferrals(wallet)) return { ok: false, code: 'has-referrals' };
    try {
      this.db.prepare('INSERT INTO joins (wallet, inviter, code, at, nonce, issued_at, expires_at, chain_id, signature, welcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(wallet, by, j.code, now, j.nonce, Number(j.issuedAt), Number(j.expiresAt), j.chainId, j.signature, o.welcome ? 1 : 0);
    } catch (e) {
      if (!isUnique(e)) throw e;
      const again = this.joinOf(wallet);
      return again && again.inviter === by ? { ok: true, join: again, fresh: false } : { ok: false, code: 'joined' };
    }
    return { ok: true, join: { wallet, inviter: by, code: j.code, at: now, welcome: o.welcome }, fresh: true };
  }

  /* -------------------------------------------------------------- the credit ledger ----- */

  /** How much of a builder-ledger order was taken in already (micro-USD of counted volume). */
  seenOf(address: string, orderKey: string): number {
    const r = this.db.prepare('SELECT counted_micro FROM seen WHERE address = ? AND order_key = ?').get(address, orderKey) as { counted_micro: number } | undefined;
    return r ? Number(r.counted_micro) : 0;
  }

  /** Take in one order's new part: its entries and how far it was seen, together. */
  take(address: string, orderKey: string, countedMicro: number, entries: ReadonlyArray<Entry>, now: number): void {
    this.db.exec('BEGIN');
    try {
      const ins = this.db.prepare('INSERT INTO entries (address, kind, micro, source, order_key, at, tier) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const e of entries) if (Math.round(e.micro) > 0) ins.run(e.address, e.kind, Math.round(e.micro), e.source, orderKey, now, e.tier);
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

  /** Credit earned from each referral (any tier), micro-USD. */
  earnedBySource(inviter: string): Map<string, number> {
    const rows = this.db.prepare("SELECT source, sum(micro) AS m FROM entries WHERE address = ? AND kind = 'earn' GROUP BY source").all(inviter.toLowerCase()) as Array<{ source: string | null; m: number }>;
    return new Map(rows.filter((r) => r.source).map((r) => [r.source!, Number(r.m)]));
  }

  /** The newest entries of a wallet. */
  history(address: string, limit = 300): Array<{ at: number; kind: 'earn' | 'spend'; micro: number; tier: number | null; source: string | null }> {
    return (this.db.prepare('SELECT at, kind, micro, tier, source FROM entries WHERE address = ? ORDER BY at DESC, id DESC LIMIT ?').all(address.toLowerCase(), limit) as Array<{ at: number; kind: string; micro: number; tier: number | null; source: string | null }>)
      .map((r) => ({ at: Number(r.at), kind: r.kind === 'spend' ? 'spend' : 'earn', micro: Number(r.micro), tier: r.tier === null ? null : Number(r.tier), source: r.source }));
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
