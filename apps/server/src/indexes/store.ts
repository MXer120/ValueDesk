/**
 * Published ValueDesk indexes: `indexes.db` in the server's data directory (SQLite, WAL), read and written by the main
 * and the beta API alike, so an index is published once across both. In the off-server backup with the other API state
 * (deploy/server/bin/backup-offsite.sh).
 *
 *   published_indexes  each index as it stands: its owner, name, description and legs (legsText). Taking one down sets
 *                      removed_at and keeps the row: no data is ever deleted, and an id is never handed out twice.
 *   index_actions      every accepted signed action, kept whole: who asked for what, which index it made or changed,
 *                      and the signature that proves it (the picture's hash among the signed fields).
 *   index_images       the pictures, by the SHA-256 of their bytes (claim.ts INDEX_IMAGE): content-addressed, so a
 *                      picture is kept once however many indexes or versions use it, and a hash names one picture
 *                      forever. Only bytes the route checked (ops/imageCheck.ts) get here, and only with an accepted
 *                      signed publish naming that hash. Served only while an index that is up shows it (image()).
 *
 * Every action is the owner's signature (claim.ts), checked before it gets here (check.ts). Here: an index changes only
 * for the wallet that published it, only while it is up, and only by a signature made later than the one that last
 * changed it, so an old signature cannot bring back an old version; and a nonce is used once per wallet, so a signed
 * publish cannot make a second index.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../builder/paths.js';
import type { ImageKind } from '../ops/imageCheck.js';
import { INDEX_PER_WALLET_MAX, legsText, parseLegs, type IndexAction, type IndexLegBp, type PublishedIndex } from './claim.js';

export const indexesDbPath = (): string => process.env.VALUESCAN_INDEXES_DB?.trim() || join(dataDir(), 'indexes.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS published_indexes (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  legs TEXT NOT NULL,
  image TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_issued_at INTEGER NOT NULL,
  removed_at INTEGER
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS published_indexes_owner ON published_indexes (owner, removed_at);
CREATE INDEX IF NOT EXISTS published_indexes_updated ON published_indexes (updated_at);
CREATE TABLE IF NOT EXISTS index_actions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  index_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  signed_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  legs TEXT NOT NULL,
  image TEXT NOT NULL DEFAULT '',
  statement TEXT NOT NULL,
  nonce TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  signature TEXT NOT NULL,
  at INTEGER NOT NULL,
  UNIQUE (owner, nonce)
);
CREATE INDEX IF NOT EXISTS index_actions_index ON index_actions (index_id, at);
CREATE TABLE IF NOT EXISTS index_images (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
`;

/** Columns added after a table was first made: added to an older file on open (an old row reads as no picture). */
const ADDED_COLUMNS: Array<{ table: string; column: string; type: string }> = [
  { table: 'published_indexes', column: 'image', type: 'TEXT' },
  { table: 'index_actions', column: 'image', type: "TEXT NOT NULL DEFAULT ''" },
];

/** A picture that passed the route's check (ops/imageCheck.ts), with the hash its bytes have. */
export interface IndexPicture {
  hash: string;
  kind: ImageKind;
  bytes: Uint8Array;
}

/** An index as stored; the route adds the owner's username (PublishedIndex). */
export type StoredIndex = Omit<PublishedIndex, 'ownerName'>;

export type IndexRefusal =
  /** No such index, or it was taken down. */
  | 'not-found'
  /** Another wallet published it. */
  | 'not-owner'
  /** Signed before the signature that last changed it. */
  | 'stale'
  /** The wallet has INDEX_PER_WALLET_MAX indexes up already. */
  | 'limit'
  /** This wallet used this nonce for another action already. */
  | 'replay'
  /** The action names a picture that is not the index's current one, and its bytes were not sent. */
  | 'image-missing';

export type PublishResult =
  /** `fresh` false: this very signed action was taken before (a repeat after a lost answer), nothing changed. */
  | { ok: true; index: StoredIndex; fresh: boolean }
  | { ok: false; code: IndexRefusal };

export type UnpublishResult = { ok: true; fresh: boolean } | { ok: false; code: IndexRefusal };

interface Row {
  id: string;
  owner: string;
  name: string;
  description: string;
  legs: string;
  image: string | null;
  created_at: number;
  updated_at: number;
  last_issued_at: number;
  removed_at: number | null;
}

const COLUMNS = 'id, owner, name, description, legs, image, created_at, updated_at, last_issued_at, removed_at';

const toIndex = (r: Row): StoredIndex => ({
  id: r.id,
  owner: r.owner,
  name: r.name,
  description: r.description,
  // Stored as legsText of checked legs, so this parses; [] only for a row someone wrote by hand.
  legs: parseLegs(r.legs) ?? [],
  image: r.image || null,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

/** A fresh index id: 'c' and nine base-36 characters (claim.ts INDEX_ID), from the system's random source. */
export function randomIndexId(): string {
  const bytes = randomBytes(9);
  let out = 'c';
  for (const b of bytes) out += (b % 36).toString(36);
  return out;
}

/** How often a new index may draw an id already taken before the store gives up (36^9 ids: never in practice). */
const ID_TRIES = 8;

export class IndexStore {
  private readonly db: DatabaseSync;

  constructor(path = indexesDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    for (const c of ADDED_COLUMNS) {
      const has = (this.db.prepare(`PRAGMA table_info(${c.table})`).all() as Array<{ name: string }>).some((x) => x.name === c.column);
      if (!has) this.db.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.type}`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS published_indexes_image ON published_indexes (image, removed_at)');
  }

  private row(id: string): Row | null {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM published_indexes WHERE id = ?`).get(id) as Row | undefined) ?? null;
  }

  /** One index while it is up (null: none, or taken down). */
  get(id: string): StoredIndex | null {
    const r = this.row(id);
    return r && r.removed_at === null ? toIndex(r) : null;
  }

  /** Indexes that are up, the last changed first; `before`: only those last changed before this time (ms), for paging. */
  list(o: { owner?: string; limit: number; before?: number }): StoredIndex[] {
    const where = ['removed_at IS NULL'];
    const args: Array<string | number> = [];
    if (o.owner) {
      where.push('owner = ?');
      args.push(o.owner.toLowerCase());
    }
    if (o.before !== undefined) {
      where.push('updated_at < ?');
      args.push(o.before);
    }
    args.push(Math.max(1, Math.floor(o.limit)));
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM published_indexes WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...args) as unknown as Row[];
    return rows.map(toIndex);
  }

  /** How many indexes this wallet has up. */
  countLive(owner: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM published_indexes WHERE owner = ? AND removed_at IS NULL').get(owner.toLowerCase()) as { n: number };
    return Number(r.n);
  }

  /**
   * The action this wallet signed with this nonce before, if any. The same signature again is a repeat of a request
   * whose answer was lost: answered as before, nothing changed. Any other action with that nonce is a replay.
   */
  private seen(owner: string, nonce: string): { indexId: string; signature: string } | null {
    const r = this.db.prepare('SELECT index_id, signature FROM index_actions WHERE owner = ? AND nonce = ?').get(owner, nonce) as
      | { index_id: string; signature: string }
      | undefined;
    return r ? { indexId: r.index_id, signature: r.signature } : null;
  }

  private keep(kind: 'publish' | 'unpublish', indexId: string, a: IndexAction, now: number): void {
    this.db.prepare(`INSERT INTO index_actions (kind, index_id, owner, signed_id, name, description, legs, image, statement, nonce, issued_at, expires_at, chain_id, signature, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(kind, indexId, a.owner.toLowerCase(), a.id, a.name, a.description, a.legs, a.image, a.statement, a.nonce, Number(a.issuedAt), Number(a.expiresAt), a.chainId, a.signature, now);
  }

  /** Keeps a checked picture once (content-addressed: the same bytes under the same hash, so a second copy is the first). */
  private keepPicture(p: IndexPicture, now: number): void {
    this.db.prepare('INSERT OR IGNORE INTO index_images (hash, kind, bytes, created_at) VALUES (?, ?, ?, ?)').run(p.hash, p.kind, p.bytes, now);
  }

  /**
   * A picture's bytes while an index that is up shows it; null otherwise (none with that hash, or only on indexes taken
   * down or changed since). So taking an index down, or giving it another picture, also stops its old picture being
   * served from here.
   */
  image(hash: string): { kind: ImageKind; bytes: Uint8Array } | null {
    const r = this.db.prepare(`SELECT kind, bytes FROM index_images WHERE hash = ?
      AND EXISTS (SELECT 1 FROM published_indexes WHERE image = ? AND removed_at IS NULL)`).get(hash, hash) as { kind: ImageKind; bytes: Uint8Array } | undefined;
    return r ? { kind: r.kind, bytes: r.bytes } : null;
  }

  /** In one write transaction: main and beta API share the file, and two tabs may sign at the same moment. */
  private inTx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * A checked, signed publish (check.ts: signature, wording and index rules passed). Id '' makes a new index with an id
   * of the store's choosing; a real id replaces that index's name, description, legs and picture.
   *
   * `picture`: the checked bytes of the picture a.image names (its hash already matched). Needed whenever a.image is not
   * '' and is not the index's current picture: an update that keeps its picture may leave the bytes out, nothing else.
   */
  publish(a: IndexAction, legs: readonly IndexLegBp[], now = Date.now(), newId: () => string = randomIndexId, picture: IndexPicture | null = null): PublishResult {
    if (picture && picture.hash !== a.image) throw new Error('indexes: the picture is not the one the action names');
    const owner = a.owner.toLowerCase();
    const image = a.image === '' ? null : a.image;
    const text = legsText(legs);
    const issuedAt = Number(a.issuedAt);
    return this.inTx((): PublishResult => {
      const before = this.seen(owner, a.nonce);
      if (before) {
        const ix = before.signature === a.signature ? this.get(before.indexId) : null;
        return ix ? { ok: true, index: ix, fresh: false } : { ok: false, code: 'replay' };
      }
      if (a.id === '') {
        if (this.countLive(owner) >= INDEX_PER_WALLET_MAX) return { ok: false, code: 'limit' };
        if (image && !picture) return { ok: false, code: 'image-missing' };
        let id = '';
        for (let i = 0; i < ID_TRIES && !id; i++) {
          const pick = newId();
          if (!this.row(pick)) id = pick;
        }
        if (!id) throw new Error('indexes: no free id after several tries');
        if (picture) this.keepPicture(picture, now);
        this.db.prepare('INSERT INTO published_indexes (id, owner, name, description, legs, image, created_at, updated_at, last_issued_at, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
          .run(id, owner, a.name, a.description, text, image, now, now, issuedAt);
        this.keep('publish', id, a, now);
        return { ok: true, index: { id, owner, name: a.name, description: a.description, legs: [...legs], image, createdAt: now, updatedAt: now }, fresh: true };
      }
      const r = this.row(a.id);
      if (!r || r.removed_at !== null) return { ok: false, code: 'not-found' };
      if (r.owner !== owner) return { ok: false, code: 'not-owner' };
      if (issuedAt <= Number(r.last_issued_at)) return { ok: false, code: 'stale' };
      // The bytes may stay out only for the picture this index shows now (checked when it was sent).
      if (image && !picture && image !== (r.image || null)) return { ok: false, code: 'image-missing' };
      if (picture) this.keepPicture(picture, now);
      this.db.prepare('UPDATE published_indexes SET name = ?, description = ?, legs = ?, image = ?, updated_at = ?, last_issued_at = ? WHERE id = ?')
        .run(a.name, a.description, text, image, now, issuedAt, a.id);
      this.keep('publish', a.id, a, now);
      return { ok: true, index: { id: a.id, owner, name: a.name, description: a.description, legs: [...legs], image, createdAt: Number(r.created_at), updatedAt: now }, fresh: true };
    });
  }

  /** A checked, signed take-down: the index stops being listed; its row and every action stay. */
  unpublish(a: IndexAction, now = Date.now()): UnpublishResult {
    const owner = a.owner.toLowerCase();
    const issuedAt = Number(a.issuedAt);
    return this.inTx((): UnpublishResult => {
      const before = this.seen(owner, a.nonce);
      if (before) return before.signature === a.signature && before.indexId === a.id ? { ok: true, fresh: false } : { ok: false, code: 'replay' };
      const r = this.row(a.id);
      if (!r || r.removed_at !== null) return { ok: false, code: 'not-found' };
      if (r.owner !== owner) return { ok: false, code: 'not-owner' };
      if (issuedAt <= Number(r.last_issued_at)) return { ok: false, code: 'stale' };
      this.db.prepare('UPDATE published_indexes SET removed_at = ?, last_issued_at = ? WHERE id = ?').run(now, issuedAt, a.id);
      this.keep('unpublish', a.id, a, now);
      return { ok: true, fresh: true };
    });
  }

  close(): void {
    this.db.close();
  }
}
