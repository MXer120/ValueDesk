/**
 * Referrals and fee credits on record: `invites.db` in the server's data directory (SQLite, WAL), the main and the
 * beta API alike. In the off-server backup with the other API state.
 *
 *   codes      SoDEX referral codes and the wallet behind each, as SoDEX said (a code does not change hands)
 *   joins      who joined with which code, with the signed join kept whole; the first join of a wallet stands.
 *              `welcome`: whether that join came with the welcome (0 only on joins from before 2026-11-25, when an inviter had a cap)
 *   entries    the credit ledger: every amount earned (a share of a referral's fee, with its tier) or spent (a fee
 *              credits paid), micro-USD, never edited, never deleted - the balance is their sum
 *   seen       per builder-ledger order, how much of it was taken in already (an order that fills further later adds
 *              only the new part). Old rows go once the builder ledger let go of the order.
 *   state      per wallet: whether credits are paying now, and since when
 *   grants     credits given rather than earned (the VIP credit, until 2026-11-25). Nothing is deleted: from the row
 *              ('*', 'vip-removed') on, only what had been spent of them by then still counts (totals)
 *   counts     per UTC day: links opened with a real code ('link'), joins ('signed', 'terms', 'sodex'), refusals, errors -
 *              what the health check judges (deploy/server/bin/healthcheck.mjs: links opened, nobody joined)
 *   vip_codes  codes upgraded on the dev page: whoever joins with one gets the VIP fee for claim.ts VIP_CODE_DAYS
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../builder/paths.js';
import { INVITES_PER_WEEK, TIERS, inviteWeekStart, type CreditDay, type InviteJoin, type JoinRefusal } from './claim.js';

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
CREATE TABLE IF NOT EXISTS grants (
  address TEXT NOT NULL,
  reason TEXT NOT NULL,
  micro INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (address, reason)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS vip_codes (
  code TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL,
  added_by TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS counts (
  day INTEGER NOT NULL,
  kind TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, kind)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS state (
  address TEXT PRIMARY KEY,
  paying INTEGER NOT NULL,
  since INTEGER NOT NULL,
  first_paying INTEGER
) WITHOUT ROWID;
`;

/** Spends of a removed grant may still reach the ledger this long after (signed fees' life, the explorer's delay). */
const REMOVED_LATE_MS = 15 * 60_000;

export interface Join { wallet: string; inviter: string; code: string; at: number; welcome: boolean; vipUntil: number | null }
export interface VipCode { code: string; addedAt: number; addedBy: string }
export type JoinVia = 'signed' | 'terms' | 'sodex';
export type JoinResult = { ok: true; join: Join; fresh: boolean } | { ok: false; code: JoinRefusal };
export interface Entry { address: string; kind: 'earn' | 'spend' | 'grant'; micro: number; source: string | null; tier: number | null }

const isUnique = (e: unknown): boolean => /UNIQUE|constraint/i.test(String((e as Error).message));
const joinOfRow = (r: { wallet: string; inviter: string; code: string; at: number | bigint; welcome?: number | bigint; vip_until?: number | bigint | null }): Join =>
  ({ wallet: r.wallet, inviter: r.inviter, code: r.code, at: Number(r.at), welcome: Number(r.welcome ?? 1) === 1, vipUntil: r.vip_until === null || r.vip_until === undefined ? null : Number(r.vip_until) });

export class InviteStore {
  readonly db: DatabaseSync;

  constructor(path = invitesDbPath(), now = Date.now()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    // A file from before the tiers: the columns they added.
    const has = (t: string, c: string) => (this.db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).some((x) => x.name === c);
    if (!has('joins', 'welcome')) this.db.exec('ALTER TABLE joins ADD COLUMN welcome INTEGER NOT NULL DEFAULT 1');
    if (!has('joins', 'via')) this.db.exec("ALTER TABLE joins ADD COLUMN via TEXT NOT NULL DEFAULT 'signed'");
    if (!has('joins', 'vip_until')) this.db.exec('ALTER TABLE joins ADD COLUMN vip_until INTEGER');
    // The VIP credit ended (owner 2026-11-25), from the first start of this code on.
    this.db.prepare("INSERT OR IGNORE INTO grants (address, reason, micro, at) VALUES ('*', 'vip-removed', 0, ?)").run(now);
    // From the first start of the SoDEX check on: only wallets first seen since then join by it (service.ts autoTick).
    this.db.prepare("INSERT OR IGNORE INTO grants (address, reason, micro, at) VALUES ('*', 'auto-from', 0, ?)").run(now);
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

  /** A code kept for this owner. */
  codeOfOwner(owner: string): string | null {
    const r = this.db.prepare('SELECT code FROM sodex_codes WHERE owner = ? ORDER BY at DESC LIMIT 1').get(owner.toLowerCase()) as { code: string } | undefined;
    return r?.code ?? null;
  }

  /** When the SoDEX check began. */
  autoFrom(): number {
    const r = this.db.prepare("SELECT at FROM grants WHERE address = '*' AND reason = 'auto-from'").get() as { at: number } | undefined;
    return Number(r?.at ?? 0);
  }

  count(kind: string, now: number): void {
    this.db.prepare('INSERT INTO counts (day, kind, n) VALUES (?, ?, 1) ON CONFLICT (day, kind) DO UPDATE SET n = n + 1').run(Math.floor(now / 86_400_000), kind);
  }

  counted(kind: string, sinceDay: number): number {
    const r = this.db.prepare('SELECT coalesce(sum(n), 0) AS n FROM counts WHERE kind = ? AND day >= ?').get(kind, sinceDay) as { n: number };
    return Number(r.n);
  }

  /* ------------------------------------------------------------------- VIP codes ----- */

  isVipCode(code: string): boolean {
    return !!this.db.prepare('SELECT 1 AS x FROM vip_codes WHERE code = ?').get(code);
  }

  vipCodes(): VipCode[] {
    return (this.db.prepare('SELECT code, added_at, added_by FROM vip_codes ORDER BY added_at DESC').all() as Array<{ code: string; added_at: number; added_by: string }>)
      .map((r) => ({ code: r.code, addedAt: Number(r.added_at), addedBy: r.added_by }));
  }

  /** True when it was not a VIP code before. */
  addVipCode(code: string, by: string, now: number): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO vip_codes (code, added_at, added_by) VALUES (?, ?, ?)').run(code, now, by.toLowerCase()).changes) === 1;
  }

  removeVipCode(code: string): boolean {
    return Number(this.db.prepare('DELETE FROM vip_codes WHERE code = ?').run(code).changes) === 1;
  }

  /** Wallets joined with a code, and how many of them have its VIP fee at `now`. */
  joinsOfCode(code: string, now: number): { joins: number; vipNow: number } {
    const r = this.db.prepare('SELECT count(*) AS n, coalesce(sum(CASE WHEN vip_until > ? THEN 1 ELSE 0 END), 0) AS v FROM joins WHERE code = ?').get(now, code) as { n: number; v: number };
    return { joins: Number(r.n), vipNow: Number(r.v) };
  }

  /** A code of this wallet that was upgraded. */
  ownsVipCode(owner: string): boolean {
    return !!this.db.prepare('SELECT 1 AS x FROM vip_codes v JOIN sodex_codes c ON c.code = v.code WHERE c.owner = ? LIMIT 1').get(owner.toLowerCase());
  }

  /* ------------------------------------------------------------------- joins ----- */

  joinOf(wallet: string): Join | null {
    const r = this.db.prepare('SELECT wallet, inviter, code, at, welcome, vip_until FROM joins WHERE wallet = ?').get(wallet.toLowerCase()) as Parameters<typeof joinOfRow>[0] | undefined;
    return r ? joinOfRow(r) : null;
  }

  /** The wallet's direct referrals, newest first. */
  referralsOf(inviter: string, limit = -1): Join[] {
    return (this.db.prepare('SELECT wallet, inviter, code, at, welcome, vip_until FROM joins WHERE inviter = ? ORDER BY at DESC LIMIT ?').all(inviter.toLowerCase(), limit) as Array<Parameters<typeof joinOfRow>[0]>).map(joinOfRow);
  }

  hasReferrals(wallet: string): boolean {
    return !!this.db.prepare('SELECT 1 AS x FROM joins WHERE inviter = ? LIMIT 1').get(wallet.toLowerCase());
  }

  /** Every join (the credit job walks them). */
  allJoins(): Join[] {
    return (this.db.prepare('SELECT wallet, inviter, code, at, welcome, vip_until FROM joins').all() as Array<Parameters<typeof joinOfRow>[0]>).map(joinOfRow);
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

  /**
   * A signed join under `inviter` (the code's owner, from SoDEX). The first join of a wallet stands; a repeat of it is
   * answered as done. `hasVolume`: the builder ledger counts volume for the wallet already.
   */
  join(j: InviteJoin, inviter: string, o: { hasVolume: boolean; welcome: boolean; vipUntil?: number | null; /** Signed by the wallet (default), by its terms signature (check.ts checkTermsJoin), or on SoDEX's word (service.ts restore). */ via?: JoinVia }, now = Date.now()): JoinResult {
    const wallet = j.wallet.toLowerCase();
    const by = inviter.toLowerCase();
    if (by === wallet) return { ok: false, code: 'self' };
    const have = this.joinOf(wallet);
    if (have) return have.inviter === by ? { ok: true, join: have, fresh: false } : { ok: false, code: 'joined' };
    if (o.hasVolume) return { ok: false, code: 'has-volume' };
    // No loops: a wallet others joined already joins nobody (and so a chain only ever grows downwards).
    if (this.hasReferrals(wallet)) return { ok: false, code: 'has-referrals' };
    // SoDEX's weekly quota per code; a join SoDEX made itself passed SoDEX's.
    if ((o.via ?? 'signed') !== 'sodex' && this.joinsThisWeek(by, now) >= INVITES_PER_WEEK) return { ok: false, code: 'limit' };
    try {
      this.db.prepare('INSERT INTO joins (wallet, inviter, code, at, nonce, issued_at, expires_at, chain_id, signature, welcome, vip_until, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(wallet, by, j.code, now, j.nonce, Number(j.issuedAt), Number(j.expiresAt), j.chainId, j.signature, o.welcome ? 1 : 0, o.vipUntil ?? null, o.via ?? 'signed');
    } catch (e) {
      if (!isUnique(e)) throw e;
      const again = this.joinOf(wallet);
      return again && again.inviter === by ? { ok: true, join: again, fresh: false } : { ok: false, code: 'joined' };
    }
    return { ok: true, join: { wallet, inviter: by, code: j.code, at: now, welcome: o.welcome, vipUntil: o.vipUntil ?? null }, fresh: true };
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

  /**
   * A one-time credit (`reason`: 'vip'), given once per wallet whatever happens: true when given now, false when the
   * wallet had it already.
   */
  grant(address: string, reason: string, micro: number, now: number): boolean {
    const a = address.toLowerCase();
    this.db.exec('BEGIN');
    try {
      const r = this.db.prepare('INSERT OR IGNORE INTO grants (address, reason, micro, at) VALUES (?, ?, ?, ?)').run(a, reason, Math.round(micro), now);
      const fresh = Number(r.changes) === 1;
      if (fresh) this.db.prepare("INSERT INTO entries (address, kind, micro, source, order_key, at, tier) VALUES (?, 'grant', ?, ?, NULL, ?, NULL)").run(a, Math.round(micro), reason, now);
      this.db.exec('COMMIT');
      return fresh;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  hasGrant(address: string, reason: string): boolean {
    return !!this.db.prepare('SELECT 1 AS x FROM grants WHERE address = ? AND reason = ?').get(address.toLowerCase(), reason);
  }

  /** When the VIP credit was removed. */
  private removedAt(): number {
    const r = this.db.prepare("SELECT at FROM grants WHERE address = '*' AND reason = 'vip-removed'").get() as { at: number } | undefined;
    return Number(r?.at ?? 0);
  }

  /**
   * Earned (from referrals), granted, spent and the balance of a wallet, micro-USD. Granted: the removed VIP credit counts
   * only for what it had paid by its removal, so no balance is left of it and nobody owes what it paid.
   */
  totals(address: string): { earned: number; granted: number; spent: number; balance: number } {
    const rows = this.db.prepare('SELECT kind, sum(micro) AS m FROM entries WHERE address = ? GROUP BY kind').all(address.toLowerCase()) as Array<{ kind: string; m: number }>;
    let earned = 0;
    let granted = 0;
    let spent = 0;
    for (const r of rows) {
      if (r.kind === 'earn') earned = Number(r.m);
      else if (r.kind === 'grant') granted = Number(r.m);
      else if (r.kind === 'spend') spent = Number(r.m);
    }
    if (granted > 0) {
      const r = this.db.prepare("SELECT coalesce(sum(micro), 0) AS m FROM entries WHERE address = ? AND kind = 'spend' AND at <= ?").get(address.toLowerCase(), this.removedAt() + REMOVED_LATE_MS) as { m: number };
      granted = Math.min(granted, Number(r.m));
    }
    return { earned, granted, spent, balance: earned + granted - spent };
  }

  /** Joins under an inviter since Monday 00:00 UTC, every kind (SoDEX's weekly quota, claim.ts INVITES_PER_WEEK). */
  joinsThisWeek(inviter: string, now: number): number {
    const r = this.db.prepare('SELECT count(*) AS n FROM joins WHERE inviter = ? AND at >= ?').get(inviter.toLowerCase(), inviteWeekStart(now)) as { n: number };
    return Number(r.n);
  }


  /** The whole ledger by UTC day, oldest first. Grants (the removed VIP credit) are not in it. */
  days(address: string): CreditDay[] {
    const a = address.toLowerCase();
    const rows = this.db.prepare("SELECT at / 86400000 AS day, kind, tier, sum(micro) AS m FROM entries WHERE address = ? AND kind IN ('earn', 'spend') GROUP BY day, kind, tier ORDER BY day").all(a) as Array<{ day: number; kind: string; tier: number | null; m: number }>;
    return rows.map((r): CreditDay => ({ day: Number(r.day), kind: r.kind === 'spend' ? 'spend' : 'earn', tier: r.tier === null ? null : Number(r.tier), usd: Number(r.m) / 1e6 }));
  }

  /** Credit earned from each referral (any tier), micro-USD. */
  earnedBySource(inviter: string): Map<string, number> {
    const rows = this.db.prepare("SELECT source, sum(micro) AS m FROM entries WHERE address = ? AND kind = 'earn' GROUP BY source").all(inviter.toLowerCase()) as Array<{ source: string | null; m: number }>;
    return new Map(rows.filter((r) => r.source).map((r) => [r.source!, Number(r.m)]));
  }

  /** The newest entries of a wallet. */
  history(address: string, limit = 300): Array<{ at: number; kind: 'earn' | 'spend' | 'grant'; micro: number; tier: number | null; source: string | null }> {
    const a = address.toLowerCase();
    const rows = (this.db.prepare('SELECT at, kind, micro, tier, source FROM entries WHERE address = ? ORDER BY at DESC, id DESC LIMIT ?').all(a, limit) as Array<{ at: number; kind: string; micro: number; tier: number | null; source: string | null }>)
      .map((r) => ({ at: Number(r.at), kind: (r.kind === 'spend' ? 'spend' : r.kind === 'grant' ? 'grant' : 'earn') as 'earn' | 'spend' | 'grant', micro: Number(r.micro), tier: r.tier === null ? null : Number(r.tier), source: r.source }));
    return rows;
  }

  /** Wallets that ever had credit, earned or granted (the job's list of whom to spend for). */
  creditWallets(): string[] {
    return (this.db.prepare("SELECT DISTINCT address FROM entries WHERE kind IN ('earn', 'grant')").all() as Array<{ address: string }>).map((r) => r.address);
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
