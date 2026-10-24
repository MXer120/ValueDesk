/**
 * The knowledge folders' records: one SQLite file (node:sqlite, WAL) for the
 * owners, the folders, the items and their text, under FoldersConfig.dir on the
 * server's data volume. The bytes of uploads and thumbnails are blobs.ts's (in
 * S3, or files beside this database); this module says which exist, and every
 * deletion here answers with the blob names that go with it.
 *
 *   <dir>/folders.db                 owners, sign-in nonces, folders, items
 *   <dir>/session.key                the token secret (auth.ts)
 *   <dir>/backup/folders-<day>.db    the database as it was each night, the last 7
 *
 * EVERY QUOTA IS CHECKED HERE, inside the same synchronous step that writes:
 * node:sqlite is synchronous and nothing in a write awaits, so two requests of
 * one wallet cannot both pass a check that only one of them fits.
 *
 * AN UPLOAD IS RESERVED FIRST. startUpload counts its size and its place in
 * the folder at once (a row in state 'pending', not listed); the browser then
 * sends the bytes; finishUpload checks what arrived - the exact size, and what
 * the bytes are - and lists it, or deletes the row (the caller deletes the
 * blob). A reservation not finished within an hour is swept with its blob.
 *
 * AN ATTACHMENT is a file that belongs to a doc or a board (an image in it):
 * a row with parent_id, in its parent's folder but not listed there and not
 * counted against the folder's items (the wallet's bytes count it). It moves
 * and is deleted with its parent; one the parent no longer shows for a day is
 * swept (an undo within that day still finds it).
 *
 * Deleting is deleting: an item's row and its blobs go at once; erasing a
 * wallet removes all of it and ends its sessions (auth.ts, the epoch). What
 * remains for a while is the nightly copy of this database (text, never files),
 * for seven days - the privacy policy says so.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statfsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FoldersConfig } from './limits.js';
import { checkItemData, cleanFileName, cleanName, decodeThumb, InputError, sniffFile } from './validate.js';
import { checkNote, checkTable, noteToDoc, tableToSheet } from './legacy.js';
import {
  ATTACHING_KINDS,
  EDITABLE_KINDS,
  FILE_TYPES,
  ITEM_KINDS,
  type FileType,
  type FolderItem,
  type FolderSummary,
  type FoldersError,
  type FoldersList,
  type ItemKind,
  type ItemMeta,
  type ItemSummary,
  type JsonKind,
} from './types.js';

export class FoldersFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: FoldersError['code'],
    message: string,
  ) {
    super(message);
  }
}

const ID = /^[A-Za-z0-9_-]{16}$/;
const newId = (): string => randomBytes(12).toString('base64url');
const BACKUPS_KEPT = 7;
const FREE_SPACE_TTL_MS = 10_000;
/** How long a reserved upload waits for its bytes before it is swept. */
export const UPLOAD_TTL_MS = 60 * 60_000;
/** An attachment its doc or board no longer shows is kept this long (an undo still finds it), then swept. */
export const UNUSED_ATTACHMENT_MS = 24 * 60 * 60_000;
/** Items listed in a folder: not attachments. */
const LISTED = 'parent_id IS NULL';

interface ItemRow {
  id: string;
  owner: string;
  folder_id: string;
  kind: ItemKind;
  title: string;
  position: number;
  data: string | null;
  meta: string;
  file_type: string | null;
  file_bytes: number;
  thumb_bytes: number;
  bytes: number;
  rev: number;
  state: 'ready' | 'pending';
  expires_at: number | null;
  parent_id: string | null;
  created_at: number;
  updated_at: number;
}

interface FolderRow {
  id: string;
  owner: string;
  name: string;
  position: number;
  created_at: number;
  updated_at: number;
}

/** The blobs that go with a deletion, per wallet. */
export interface Gone {
  owner: string;
  names: string[];
}

/** A JSON item checked and counted, waiting for its thumbnail to be stored (createItem). */
export interface PreparedItem {
  id: string;
  folderId: string;
  kind: JsonKind;
  title: string;
  json: string;
  meta: ItemMeta;
  thumb: Buffer | null;
  bytes: number;
}

export interface StoreDeps {
  now?: () => number;
  /** Free bytes on the volume (tests); statfs of the directory otherwise. Disk mode only. */
  freeBytes?: () => number;
}

const namesOf = (r: Pick<ItemRow, 'id' | 'kind' | 'thumb_bytes'>): string[] => [...(r.kind === 'file' ? [r.id] : []), ...(r.thumb_bytes ? [`${r.id}.thumb`] : [])];

export class FoldersStore {
  readonly db: DatabaseSync;
  private readonly now: () => number;
  private total = 0;
  private free: { at: number; bytes: number } | null = null;

  constructor(
    readonly cfg: FoldersConfig,
    private readonly deps: StoreDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(cfg.dir, 'folders.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS owners (
        owner TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nonces (
        nonce TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS folders_owner ON folders (owner, position);
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        folder_id TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        position INTEGER NOT NULL,
        data TEXT,
        meta TEXT NOT NULL,
        file_type TEXT,
        file_bytes INTEGER NOT NULL DEFAULT 0,
        thumb_bytes INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL,
        rev INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL DEFAULT 'ready',
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS items_folder ON items (folder_id, position);
      CREATE INDEX IF NOT EXISTS items_owner ON items (owner);
    `);
    // A database from before reserved uploads (2026-10-24, never in production): the two columns.
    const cols = new Set((this.db.prepare('PRAGMA table_info(items)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has('state')) this.db.exec("ALTER TABLE items ADD COLUMN state TEXT NOT NULL DEFAULT 'ready'");
    if (!cols.has('expires_at')) this.db.exec('ALTER TABLE items ADD COLUMN expires_at INTEGER');
    if (!cols.has('parent_id')) this.db.exec('ALTER TABLE items ADD COLUMN parent_id TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS items_pending ON items (state, expires_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS items_parent ON items (parent_id)');
    this.upgradeLegacy();
    this.total = Number((this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM items').get() as { n: number }).n);
  }

  close(): void {
    this.db.close();
  }

  /** Every wallet's items together, reservations included, bytes. */
  get totalBytes(): number {
    return this.total;
  }

  /* ------------------------------------------------------------ owners ----- */

  /** The wallet's token epoch (0 for a wallet never seen). */
  epoch(owner: string): number {
    const r = this.db.prepare('SELECT epoch FROM owners WHERE owner = ?').get(owner) as { epoch: number } | undefined;
    return r?.epoch ?? 0;
  }

  /**
   * Accept a sign-in's nonce once and note that the wallet was here. False when
   * the nonce was used before - the signed sign-in is then a replay.
   */
  signIn(owner: string, nonce: string, expiresAt: number): { fresh: boolean; epoch: number } {
    const now = this.now();
    return this.tx(() => {
      const used = this.db.prepare('INSERT OR IGNORE INTO nonces (nonce, owner, expires_at) VALUES (?, ?, ?)').run(nonce, owner, expiresAt);
      if (Number(used.changes) === 0) return { fresh: false, epoch: this.epoch(owner) };
      this.db.prepare('INSERT INTO owners (owner, epoch, created_at, last_seen) VALUES (?, 0, ?, ?) ON CONFLICT (owner) DO UPDATE SET last_seen = excluded.last_seen').run(owner, now, now);
      return { fresh: true, epoch: this.epoch(owner) };
    });
  }

  /** A request with a valid token keeps the wallet from expiring (at most once an hour). */
  touch(owner: string): void {
    const now = this.now();
    // An upsert: a wallet whose row the retention sweep removed while one of its tokens was still
    // valid gets it back, so what it keeps from now on expires like everything else.
    this.db
      .prepare('INSERT INTO owners (owner, epoch, created_at, last_seen) VALUES (?, 0, ?, ?) ON CONFLICT (owner) DO UPDATE SET last_seen = excluded.last_seen WHERE owners.last_seen < ?')
      .run(owner, now, now, now - 3_600_000);
  }

  /* ------------------------------------------------------------- reads ----- */

  list(owner: string): Omit<FoldersList, 'ok' | 'limits'> {
    const folders = this.db.prepare('SELECT * FROM folders WHERE owner = ? ORDER BY position, created_at').all(owner) as unknown as FolderRow[];
    const items = this.db.prepare("SELECT * FROM items WHERE owner = ? AND state = 'ready' ORDER BY position, created_at").all(owner) as unknown as ItemRow[];
    const byFolder = new Map<string, ItemSummary[]>();
    for (const r of items) {
      if (r.parent_id) continue;
      const list = byFolder.get(r.folder_id) ?? [];
      list.push(summary(r));
      byFolder.set(r.folder_id, list);
    }
    const out: FolderSummary[] = folders.map((f) => ({ id: f.id, name: f.name, createdAt: f.created_at, updatedAt: f.updated_at, items: byFolder.get(f.id) ?? [] }));
    const listed = items.filter((r) => !r.parent_id).length;
    return { owner, folders: out, usage: { bytes: items.reduce((n, r) => n + r.bytes, 0), folders: folders.length, items: listed } };
  }

  getItem(owner: string, id: unknown): FolderItem {
    const r = this.item(owner, id);
    let data: FolderItem['data'] = null;
    if (r.data !== null) data = JSON.parse(r.data) as FolderItem['data'];
    return { ...summary(r), data };
  }

  /** What a download of an upload (or a chart's thumbnail) is: its blob, its type, the name it is saved as, its size. */
  fileInfo(owner: string, id: unknown, thumb: boolean): { name: string; type: FileType; fileName: string; bytes: number } {
    const r = this.item(owner, id);
    if (thumb ? r.thumb_bytes === 0 : r.kind !== 'file') throw new FoldersFailure(404, 'not-found', 'There is no such file.');
    const meta = JSON.parse(r.meta) as ItemMeta;
    if (thumb) {
      const t = meta.thumbType === 'png' ? 'png' : 'jpeg';
      return { name: `${r.id}.thumb`, type: t, fileName: `${r.title}.${t === 'png' ? 'png' : 'jpg'}`, bytes: r.thumb_bytes };
    }
    const type = r.file_type as FileType;
    return { name: r.id, type, fileName: meta.fileName ?? 'file', bytes: r.file_bytes };
  }

  /* ----------------------------------------------------------- folders ----- */

  createFolder(owner: string, rawName: unknown): FolderSummary {
    const name = cleanName(rawName, this.cfg.limits.nameChars, 'A folder name');
    const now = this.now();
    return this.tx(() => {
      const n = this.count('SELECT COUNT(*) AS n FROM folders WHERE owner = ?', owner);
      if (n >= this.cfg.limits.folders) throw new FoldersFailure(409, 'folders-full', `You can keep ${this.cfg.limits.folders} folders. Delete one to make another.`);
      const id = newId();
      this.db.prepare('INSERT INTO folders (id, owner, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, owner, name, n, now, now);
      return { id, name, createdAt: now, updatedAt: now, items: [] };
    });
  }

  renameFolder(owner: string, id: string, rawName: unknown): void {
    const name = cleanName(rawName, this.cfg.limits.nameChars, 'A folder name');
    this.folder(owner, id);
    this.db.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ? AND owner = ?').run(name, this.now(), id, owner);
  }

  /** The folder and everything in it, reservations included; answers with their blobs. */
  deleteFolder(owner: string, id: string): Gone {
    this.folder(owner, id);
    const items = this.db.prepare('SELECT * FROM items WHERE owner = ? AND folder_id = ?').all(owner, id) as unknown as ItemRow[];
    this.tx(() => {
      this.db.prepare('DELETE FROM items WHERE owner = ? AND folder_id = ?').run(owner, id);
      this.db.prepare('DELETE FROM folders WHERE owner = ? AND id = ?').run(owner, id);
      this.renumberFolders(owner);
    });
    this.total -= items.reduce((n, r) => n + r.bytes, 0);
    return { owner, names: items.flatMap(namesOf) };
  }

  /** Put the wallet's folders in this order (every one of its folders, each once). */
  orderFolders(owner: string, ids: unknown): void {
    const mine = (this.db.prepare('SELECT id FROM folders WHERE owner = ?').all(owner) as Array<{ id: string }>).map((r) => r.id);
    if (!sameSet(ids, mine)) throw new FoldersFailure(400, 'input', 'Name every folder once to reorder them.');
    this.tx(() => {
      (ids as string[]).forEach((id, i) => this.db.prepare('UPDATE folders SET position = ? WHERE id = ? AND owner = ?').run(i, id, owner));
    });
  }

  /* ------------------------------------------------------------- items ----- */

  /**
   * A note, table, chart or story, checked and counted - not yet stored. A chart's
   * thumbnail is stored by the caller (blobs.ts) before insertItem lists it.
   */
  prepareItem(owner: string, o: { folderId: unknown; kind: unknown; title: unknown; data: unknown; thumb?: unknown }): PreparedItem {
    const folderId = this.folder(owner, o.folderId).id;
    if (typeof o.kind !== 'string' || !(ITEM_KINDS as readonly string[]).includes(o.kind) || o.kind === 'file') {
      throw new FoldersFailure(400, 'input', 'Choose a doc, a sheet, a board, a post, a chart or a news story (files are uploaded).');
    }
    const kind = o.kind as JsonKind;
    const title = cleanName(o.title, this.cfg.limits.titleChars, 'A title');
    const { json, meta } = this.checked(kind, o.data);
    const thumb = kind === 'chart' ? this.thumb(o.thumb) : null;
    const bytes = Buffer.byteLength(json) + (thumb?.length ?? 0);
    this.roomFor(owner, folderId, bytes, 1);
    return { id: newId(), folderId, kind, title, json, meta, thumb, bytes };
  }

  /** List a prepared item; the room is checked again inside the write. */
  insertItem(owner: string, p: PreparedItem): ItemSummary {
    const now = this.now();
    this.tx(() => {
      this.folder(owner, p.folderId);
      this.roomFor(owner, p.folderId, p.bytes, 1);
      const position = this.count(`SELECT COUNT(*) AS n FROM items WHERE folder_id = ? AND ${LISTED}`, p.folderId);
      this.db
        .prepare("INSERT INTO items (id, owner, folder_id, kind, title, position, data, meta, file_type, file_bytes, thumb_bytes, bytes, rev, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, 1, 'ready', ?, ?)")
        .run(p.id, owner, p.folderId, p.kind, p.title, position, p.json, JSON.stringify({ ...p.meta, ...(p.thumb ? { thumb: true, thumbType: sniffFile(p.thumb) === 'png' ? 'png' : 'jpeg' } : {}) }), p.thumb?.length ?? 0, p.bytes, now, now);
    });
    this.total += p.bytes;
    return summary(this.item(owner, p.id));
  }

  /** Change an item's title or content. `rev`, when given, must be the item's current one. */
  updateItem(owner: string, o: { id: unknown; title?: unknown; data?: unknown; rev?: unknown }): ItemSummary {
    const r = this.item(owner, o.id);
    if (o.rev !== undefined && o.rev !== r.rev) throw new FoldersFailure(409, 'conflict', 'This item was changed somewhere else. Reload it before saving.');
    const title = o.title === undefined ? r.title : cleanName(o.title, this.cfg.limits.titleChars, 'A title');
    let json = r.data;
    let meta = JSON.parse(r.meta) as ItemMeta;
    if (o.data !== undefined) {
      if (r.kind === 'file' || !EDITABLE_KINDS.includes(r.kind)) throw new FoldersFailure(400, 'input', `A ${r.kind} keeps what was saved; only its title can change.`);
      const c = this.checked(r.kind, o.data);
      json = c.json;
      meta = c.meta;
    }
    const bytes = (json === null ? 0 : Buffer.byteLength(json)) + r.file_bytes + r.thumb_bytes;
    const grow = bytes - r.bytes;
    this.tx(() => {
      if (grow > 0) this.roomFor(owner, null, grow, 0);
      this.db
        .prepare('UPDATE items SET title = ?, data = ?, meta = ?, bytes = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND owner = ?')
        .run(title, json, JSON.stringify({ ...meta, ...(r.thumb_bytes ? { thumb: true, thumbType: (JSON.parse(r.meta) as ItemMeta).thumbType } : {}) }), bytes, this.now(), r.id, owner);
    });
    this.total += grow;
    return summary(this.item(owner, r.id));
  }

  /** Move an item to `index` in a folder - its own (reorder) or another. */
  moveItem(owner: string, o: { id: unknown; folderId: unknown; index: unknown }): void {
    const r = this.item(owner, o.id);
    if (r.parent_id) throw new FoldersFailure(400, 'input', 'An image in a doc or a board moves with it.');
    const to = this.folder(owner, o.folderId).id;
    const index = typeof o.index === 'number' && Number.isInteger(o.index) && o.index >= 0 ? o.index : Number.MAX_SAFE_INTEGER;
    this.tx(() => {
      if (to !== r.folder_id) {
        const n = this.count(`SELECT COUNT(*) AS n FROM items WHERE folder_id = ? AND ${LISTED}`, to);
        if (n >= this.cfg.limits.itemsPerFolder) throw new FoldersFailure(409, 'folder-full', `A folder holds ${this.cfg.limits.itemsPerFolder} items. That one is full.`);
      }
      const ids = (this.db.prepare(`SELECT id FROM items WHERE folder_id = ? AND id <> ? AND ${LISTED} ORDER BY position, created_at`).all(to, r.id) as Array<{ id: string }>).map((x) => x.id);
      ids.splice(Math.min(index, ids.length), 0, r.id);
      this.db.prepare('UPDATE items SET folder_id = ?, updated_at = ? WHERE id = ? AND owner = ?').run(to, this.now(), r.id, owner);
      this.db.prepare('UPDATE items SET folder_id = ? WHERE parent_id = ? AND owner = ?').run(to, r.id, owner);
      ids.forEach((id, i) => this.db.prepare('UPDATE items SET position = ? WHERE id = ?').run(i, id));
      if (to !== r.folder_id) this.renumberItems(r.folder_id);
    });
  }

  /** The item, and its attachments when it is a doc or a board; answers with their blobs. */
  deleteItem(owner: string, id: unknown): Gone {
    const r = this.item(owner, id);
    const attached = this.db.prepare('SELECT * FROM items WHERE parent_id = ? AND owner = ?').all(r.id, owner) as unknown as ItemRow[];
    this.tx(() => {
      for (const a of attached) this.drop(a);
      this.drop(r);
    });
    return { owner, names: [r, ...attached].flatMap(namesOf) };
  }

  /* ----------------------------------------------------------- uploads ----- */

  /** Reserve an upload: its size and its place are counted now; it is listed once finished. */
  startUpload(owner: string, o: { folderId: unknown; name: unknown; title?: unknown; size: unknown; parentId?: unknown }): { id: string; size: number } {
    // An attachment goes where its doc or board is, whatever folder was named.
    const parent = o.parentId === undefined || o.parentId === null ? null : this.item(owner, o.parentId);
    if (parent && (parent.kind === 'file' || !ATTACHING_KINDS.includes(parent.kind) || parent.parent_id)) {
      throw new FoldersFailure(400, 'input', 'Images can be added to a doc or a board.');
    }
    const folderId = parent ? parent.folder_id : this.folder(owner, o.folderId).id;
    const size = o.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) throw new FoldersFailure(400, 'input', 'The file is empty.');
    if (size > this.cfg.limits.fileBytes) throw new FoldersFailure(413, 'too-large', `A file can be at most ${mb(this.cfg.limits.fileBytes)}.`);
    const fileName = cleanFileName(o.name);
    const title =
      o.title === undefined || o.title === ''
        ? cleanName(fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '') || fileName, this.cfg.limits.titleChars, 'A title')
        : cleanName(o.title, this.cfg.limits.titleChars, 'A title');
    const id = newId();
    const now = this.now();
    this.tx(() => {
      if (parent) {
        const n = this.count('SELECT COUNT(*) AS n FROM items WHERE parent_id = ?', parent.id);
        if (n >= this.cfg.limits.attachmentsPerItem) throw new FoldersFailure(409, 'folder-full', `A ${parent.kind} holds ${this.cfg.limits.attachmentsPerItem} images. Remove some first.`);
      }
      this.roomFor(owner, folderId, size, parent ? 0 : 1);
      const position = parent ? -1 : this.count(`SELECT COUNT(*) AS n FROM items WHERE folder_id = ? AND ${LISTED}`, folderId);
      this.db
        .prepare("INSERT INTO items (id, owner, folder_id, kind, title, position, data, meta, file_type, file_bytes, thumb_bytes, bytes, rev, state, expires_at, created_at, updated_at, parent_id) VALUES (?, ?, ?, 'file', ?, ?, NULL, ?, NULL, ?, 0, ?, 1, 'pending', ?, ?, ?, ?)")
        .run(id, owner, folderId, title, position, JSON.stringify({ fileName } satisfies ItemMeta), size, size, now + UPLOAD_TTL_MS, now, now, parent?.id ?? null);
    });
    this.total += size;
    return { id, size };
  }

  /** A reservation of this wallet that is still waiting for its bytes, or a 404. */
  pendingUpload(owner: string, id: unknown): { id: string; size: number } {
    const r = this.row(owner, id);
    if (!r || r.state !== 'pending' || (r.expires_at ?? 0) < this.now()) throw new FoldersFailure(404, 'not-found', 'There is no such upload (it may have taken longer than an hour). Start it again.');
    return { id: r.id, size: r.file_bytes };
  }

  /**
   * What arrived for a reservation: exactly the size reserved, and bytes that are a
   * PDF, an image or text (sniffed - the name and any type the client gave claim
   * nothing). Listed, or refused - then the reservation is gone and the caller
   * deletes the blob.
   */
  finishUpload(owner: string, id: unknown, got: { size: number; head: Buffer } | null): ItemSummary {
    const p = this.pendingUpload(owner, id);
    const r = this.item(owner, p.id, true);
    const refuse = (status: number, code: FoldersError['code'], message: string): never => {
      this.drop(r);
      throw new FoldersFailure(status, code, message);
    };
    if (!got) return refuse(400, 'input', 'The file did not arrive. Upload it again.');
    if (got.size !== p.size) return refuse(400, 'input', 'The file that arrived is not the one announced. Upload it again.');
    const type = sniffFile(got.head, got.head.length >= got.size);
    if (!type) return refuse(415, 'file-type', 'Folders keep PDFs, images (PNG, JPEG, WebP, GIF) and plain text files.');
    const meta: ItemMeta = { ...(JSON.parse(r.meta) as ItemMeta), fileType: type };
    const now = this.now();
    this.db
      .prepare("UPDATE items SET state = 'ready', expires_at = NULL, file_type = ?, meta = ?, created_at = ?, updated_at = ? WHERE id = ? AND owner = ?")
      .run(type, JSON.stringify(meta), now, now, r.id, owner);
    return summary(this.item(owner, r.id));
  }

  /** Delete everything the wallet keeps here and end its sessions everywhere; answers with its blobs. */
  erase(owner: string): { items: number; folders: number; gone: Gone } {
    const items = this.db.prepare('SELECT * FROM items WHERE owner = ?').all(owner) as unknown as ItemRow[];
    const folders = this.count('SELECT COUNT(*) AS n FROM folders WHERE owner = ?', owner);
    const now = this.now();
    this.tx(() => {
      this.db.prepare('DELETE FROM items WHERE owner = ?').run(owner);
      this.db.prepare('DELETE FROM folders WHERE owner = ?').run(owner);
      this.db.prepare('DELETE FROM nonces WHERE owner = ?').run(owner);
      // The row stays with a higher epoch only, so a token issued before cannot be used; it
      // holds no content and goes with the retention sweep like any wallet not seen again.
      this.db.prepare('INSERT INTO owners (owner, epoch, created_at, last_seen) VALUES (?, 1, ?, ?) ON CONFLICT (owner) DO UPDATE SET epoch = epoch + 1').run(owner, now, now);
    });
    this.total -= items.reduce((n, r) => n + r.bytes, 0);
    return { items: items.filter((r) => r.state === 'ready').length, folders, gone: { owner, names: items.flatMap(namesOf) } };
  }

  /* ----------------------------------------------------------- upkeep ----- */

  /**
   * Expired nonces go; reserved uploads that never finished go; a wallet not seen
   * for the retention period goes with everything it kept (FOLDERS_RETENTION_DAYS,
   * the privacy policy's period). Answers with the blobs to delete.
   */
  sweep(): { owners: number; uploads: number; gone: Gone[] } {
    const now = this.now();
    this.db.prepare('DELETE FROM nonces WHERE expires_at < ?').run(now);
    const gone: Gone[] = [];
    const stalled = this.db.prepare("SELECT * FROM items WHERE state = 'pending' AND expires_at < ?").all(now) as unknown as ItemRow[];
    for (const r of stalled) {
      this.drop(r);
      gone.push({ owner: r.owner, names: namesOf(r) });
    }
    // An image its doc or board has not shown for a day (or whose parent is gone).
    const unused = this.db
      .prepare(
        "SELECT a.* FROM items a LEFT JOIN items p ON p.id = a.parent_id WHERE a.parent_id IS NOT NULL AND a.state = 'ready' AND a.updated_at < ? AND (p.id IS NULL OR instr(COALESCE(p.data, ''), a.id) = 0)",
      )
      .all(now - UNUSED_ATTACHMENT_MS) as unknown as ItemRow[];
    for (const r of unused) {
      this.drop(r);
      gone.push({ owner: r.owner, names: namesOf(r) });
    }
    if (!this.cfg.retentionMs) return { owners: 0, uploads: stalled.length, gone };
    const stale = (this.db.prepare('SELECT owner FROM owners WHERE last_seen < ?').all(now - this.cfg.retentionMs) as Array<{ owner: string }>).map((r) => r.owner);
    for (const owner of stale) {
      gone.push(this.erase(owner).gone);
      this.db.prepare('DELETE FROM owners WHERE owner = ?').run(owner);
    }
    return { owners: stale.length, uploads: stalled.length, gone: gone.filter((g) => g.names.length) };
  }

  /** The database as it is now, into backup/folders-<day>.db; the newest BACKUPS_KEPT are kept. */
  backup(): string {
    const dir = join(this.cfg.dir, 'backup');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const path = join(dir, `folders-${day}.db`);
    rmQuiet(path);
    this.db.prepare('VACUUM INTO ?').run(path);
    const all = readdirSync(dir).filter((f) => /^folders-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) rmQuiet(join(dir, f));
    return path;
  }

  /* ---------------------------------------------------------- helpers ----- */

  private checked(kind: JsonKind, data: unknown): { json: string; meta: ItemMeta } {
    try {
      const c = checkItemData(kind, data, this.cfg.limits);
      return { json: c.json, meta: c.meta };
    } catch (e) {
      throw asFailure(e);
    }
  }

  private thumb(raw: unknown): Buffer | null {
    try {
      return decodeThumb(raw, this.cfg.limits.thumbBytes);
    } catch (e) {
      throw asFailure(e);
    }
  }

  /** A row out of the folder (its place closed up) and out of the count. */
  private drop(r: ItemRow): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM items WHERE id = ? AND owner = ?').run(r.id, r.owner);
      if (!r.parent_id) this.renumberItems(r.folder_id);
    });
    this.total -= r.bytes;
  }

  /** Room for `bytes` more (and `items` more in `folderId`): the folder, the wallet, the server, the disk. */
  private roomFor(owner: string, folderId: string | null, bytes: number, items: number): void {
    const l = this.cfg.limits;
    if (folderId && items > 0) {
      const n = this.count(`SELECT COUNT(*) AS n FROM items WHERE folder_id = ? AND ${LISTED}`, folderId);
      if (n + items > l.itemsPerFolder) throw new FoldersFailure(409, 'folder-full', `A folder holds ${l.itemsPerFolder} items. Delete one or use another folder.`);
    }
    const used = this.count('SELECT COALESCE(SUM(bytes), 0) AS n FROM items WHERE owner = ?', owner);
    if (used + bytes > l.walletBytes) {
      throw new FoldersFailure(413, 'quota', `Your folders can hold ${mb(l.walletBytes)}; ${mb(Math.max(0, l.walletBytes - used))} is left. Delete something to make room.`);
    }
    if (this.total + bytes > this.cfg.totalBytes || (this.cfg.minFreeBytes > 0 && this.freeBytes() - bytes < this.cfg.minFreeBytes)) {
      throw new FoldersFailure(507, 'storage-full', 'Folders cannot take more right now. Try again later.');
    }
  }

  private freeBytes(): number {
    if (this.deps.freeBytes) return this.deps.freeBytes();
    const now = this.now();
    if (!this.free || now - this.free.at > FREE_SPACE_TTL_MS) {
      try {
        const s = statfsSync(this.cfg.dir);
        this.free = { at: now, bytes: Number(s.bavail) * Number(s.bsize) };
      } catch {
        this.free = { at: now, bytes: Number.MAX_SAFE_INTEGER };
      }
    }
    return this.free.bytes;
  }

  private folder(owner: string, id: unknown): FolderRow {
    if (typeof id !== 'string' || !ID.test(id)) throw new FoldersFailure(404, 'not-found', 'There is no such folder.');
    const f = this.db.prepare('SELECT * FROM folders WHERE id = ? AND owner = ?').get(id, owner) as FolderRow | undefined;
    if (!f) throw new FoldersFailure(404, 'not-found', 'There is no such folder.');
    return f;
  }

  private row(owner: string, id: unknown): ItemRow | null {
    if (typeof id !== 'string' || !ID.test(id)) return null;
    return (this.db.prepare('SELECT * FROM items WHERE id = ? AND owner = ?').get(id, owner) as ItemRow | undefined) ?? null;
  }

  /** A listed item of this wallet (a reservation too, with `pending`), or a 404. */
  private item(owner: string, id: unknown, pending = false): ItemRow {
    const r = this.row(owner, id);
    if (!r || (r.state !== 'ready' && !pending)) throw new FoldersFailure(404, 'not-found', 'There is no such item.');
    return r;
  }

  private count(sql: string, ...args: string[]): number {
    return Number((this.db.prepare(sql).get(...args) as { n: number }).n);
  }

  private renumberItems(folderId: string): void {
    const ids = (this.db.prepare(`SELECT id FROM items WHERE folder_id = ? AND ${LISTED} ORDER BY position, created_at`).all(folderId) as Array<{ id: string }>).map((x) => x.id);
    ids.forEach((id, i) => this.db.prepare('UPDATE items SET position = ? WHERE id = ?').run(i, id));
  }

  /**
   * Notes and tables of the first release become docs and sheets, in place: the
   * same id, title, folder and place, the content converted (legacy.ts). At
   * every start, so a copy restored from a backup is upgraded too. One that
   * cannot be read is left as it was (it can still be deleted).
   */
  private upgradeLegacy(): number {
    const rows = this.db.prepare("SELECT * FROM items WHERE kind IN ('note', 'table')").all() as unknown as ItemRow[];
    let done = 0;
    for (const r of rows) {
      try {
        const raw = JSON.parse(r.data ?? 'null') as unknown;
        const kind: JsonKind = (r.kind as string) === 'note' ? 'doc' : 'sheet';
        const converted = kind === 'doc' ? noteToDoc(checkNote(raw)) : tableToSheet(checkTable(raw));
        const c = checkItemData(kind, converted, this.cfg.limits);
        const bytes = Buffer.byteLength(c.json) + r.file_bytes + r.thumb_bytes;
        this.db.prepare('UPDATE items SET kind = ?, data = ?, meta = ?, bytes = ?, rev = rev + 1 WHERE id = ?').run(kind, c.json, JSON.stringify(c.meta), bytes, r.id);
        done++;
      } catch {
        /* unreadable: kept as it was */
      }
    }
    return done;
  }

  private renumberFolders(owner: string): void {
    const ids = (this.db.prepare('SELECT id FROM folders WHERE owner = ? ORDER BY position, created_at').all(owner) as Array<{ id: string }>).map((x) => x.id);
    ids.forEach((id, i) => this.db.prepare('UPDATE folders SET position = ? WHERE id = ?').run(i, id));
  }

  /** One transaction; rolled back when `fn` throws. Nested calls join the open one. */
  private depth = 0;
  private tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }
}

function summary(r: ItemRow): ItemSummary {
  return {
    id: r.id,
    folderId: r.folder_id,
    kind: r.kind,
    title: r.title,
    bytes: r.bytes,
    meta: JSON.parse(r.meta) as ItemMeta,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    rev: r.rev,
    ...(r.parent_id ? { parentId: r.parent_id } : {}),
  };
}

function sameSet(ids: unknown, mine: readonly string[]): boolean {
  if (!Array.isArray(ids) || ids.length !== mine.length) return false;
  const set = new Set(mine);
  return new Set(ids).size === ids.length && ids.every((id) => typeof id === 'string' && set.has(id));
}

export function asFailure(e: unknown): unknown {
  if (e instanceof InputError) return new FoldersFailure(e.code === 'too-large' ? 413 : e.code === 'file-type' ? 415 : 400, e.code, e.message);
  return e;
}

function rmQuiet(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* gone already */
  }
}

const mb = (n: number): string => `${(n / 1048576).toFixed(n % 1048576 === 0 ? 0 : 1)} MB`;

/** For the content type a file is served with. */
export const mimeOf = (t: FileType): string => FILE_TYPES[t].mime;
