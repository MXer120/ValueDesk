/**
 * Where the knowledge folders live: one SQLite file (node:sqlite, WAL) for the
 * folders, the items and their text, and a directory of files for uploads and
 * chart thumbnails - both under FoldersConfig.dir, on the server's data volume.
 *
 *   <dir>/folders.db                 owners, sign-in nonces, folders, items
 *   <dir>/files/<wallet>/<item>      an upload's bytes
 *   <dir>/files/<wallet>/<item>.thumb  a chart snapshot's thumbnail
 *   <dir>/session.key                the token secret (auth.ts)
 *   <dir>/backup/folders-<day>.db    the database as it was each night, the last 7
 *
 * EVERY QUOTA IS CHECKED HERE, inside the same synchronous step that writes:
 * node:sqlite is synchronous and nothing in a write awaits, so two requests of
 * one wallet cannot both pass a check that only one of them fits. Files are
 * written to a temporary name first and renamed into place in that step; a
 * refused write removes its temporary file.
 *
 * Deleting is deleting: an item's row and its files go at once; erasing a
 * wallet removes all of it and ends its sessions (auth.ts, the epoch). What
 * remains for a while is the nightly copy of the database (text, never files),
 * for seven days - the privacy policy says so.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FoldersConfig } from './limits.js';
import { checkItemData, cleanFileName, cleanName, decodeThumb, InputError, sniffFile } from './validate.js';
import {
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

export interface StoreDeps {
  now?: () => number;
  /** Free bytes on the volume (tests); statfs of the directory otherwise. */
  freeBytes?: () => number;
}

export class FoldersStore {
  readonly db: DatabaseSync;
  private readonly files: string;
  private readonly now: () => number;
  private total = 0;
  private free: { at: number; bytes: number } | null = null;

  constructor(
    readonly cfg: FoldersConfig,
    private readonly deps: StoreDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });
    this.files = join(cfg.dir, 'files');
    mkdirSync(this.files, { recursive: true, mode: 0o700 });
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS items_folder ON items (folder_id, position);
      CREATE INDEX IF NOT EXISTS items_owner ON items (owner);
    `);
    this.total = Number((this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM items').get() as { n: number }).n);
  }

  close(): void {
    this.db.close();
  }

  /** Every wallet's items together, bytes. */
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
    const items = this.db.prepare('SELECT * FROM items WHERE owner = ? ORDER BY position, created_at').all(owner) as unknown as ItemRow[];
    const byFolder = new Map<string, ItemSummary[]>();
    for (const r of items) {
      const list = byFolder.get(r.folder_id) ?? [];
      list.push(summary(r));
      byFolder.set(r.folder_id, list);
    }
    const out: FolderSummary[] = folders.map((f) => ({ id: f.id, name: f.name, createdAt: f.created_at, updatedAt: f.updated_at, items: byFolder.get(f.id) ?? [] }));
    return { owner, folders: out, usage: { bytes: items.reduce((n, r) => n + r.bytes, 0), folders: folders.length, items: items.length } };
  }

  getItem(owner: string, id: unknown): FolderItem {
    const r = this.item(owner, id);
    let data: FolderItem['data'] = null;
    if (r.data !== null) data = JSON.parse(r.data) as FolderItem['data'];
    return { ...summary(r), data };
  }

  /** An upload's or a thumbnail's bytes and type, for its owner only. */
  readFile(owner: string, id: string, thumb: boolean): { bytes: Buffer; type: FileType; name: string } {
    const r = this.item(owner, id);
    if (thumb ? r.thumb_bytes === 0 : r.kind !== 'file') throw new FoldersFailure(404, 'not-found', 'There is no such file.');
    const path = this.filePath(owner, id, thumb);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new FoldersFailure(404, 'not-found', 'The file is missing.');
    }
    const meta = JSON.parse(r.meta) as ItemMeta;
    // Sniffed again on the way out: what is served is what the bytes are.
    const type = sniffFile(bytes);
    if (!type || (!thumb && type !== r.file_type)) throw new FoldersFailure(404, 'not-found', 'The file cannot be served.');
    return { bytes, type, name: thumb ? `${id}.thumb` : meta.fileName ?? 'file' };
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

  deleteFolder(owner: string, id: string): void {
    this.folder(owner, id);
    const items = this.db.prepare('SELECT * FROM items WHERE owner = ? AND folder_id = ?').all(owner, id) as unknown as ItemRow[];
    this.tx(() => {
      this.db.prepare('DELETE FROM items WHERE owner = ? AND folder_id = ?').run(owner, id);
      this.db.prepare('DELETE FROM folders WHERE owner = ? AND id = ?').run(owner, id);
      this.renumberFolders(owner);
    });
    for (const r of items) this.dropFiles(r);
    this.total -= items.reduce((n, r) => n + r.bytes, 0);
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

  createItem(owner: string, o: { folderId: unknown; kind: unknown; title: unknown; data: unknown; thumb?: unknown }): ItemSummary {
    const folderId = this.folder(owner, o.folderId).id;
    if (typeof o.kind !== 'string' || !(ITEM_KINDS as readonly string[]).includes(o.kind) || o.kind === 'file') {
      throw new FoldersFailure(400, 'input', 'Choose a note, a table, a chart or a news story (files are uploaded).');
    }
    const kind = o.kind as JsonKind;
    const title = cleanName(o.title, this.cfg.limits.titleChars, 'A title');
    const { json, meta } = this.checked(kind, o.data);
    const thumb = kind === 'chart' ? this.thumb(o.thumb) : null;
    const bytes = Buffer.byteLength(json) + (thumb?.length ?? 0);
    const id = newId();
    const now = this.now();
    const tmp = thumb ? this.writeTemp(owner, thumb) : null;
    try {
      this.tx(() => {
        this.roomFor(owner, folderId, bytes, 1);
        const position = this.count('SELECT COUNT(*) AS n FROM items WHERE folder_id = ?', folderId);
        this.db
          .prepare('INSERT INTO items (id, owner, folder_id, kind, title, position, data, meta, file_type, file_bytes, thumb_bytes, bytes, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, 1, ?, ?)')
          .run(id, owner, folderId, kind, title, position, json, JSON.stringify({ ...meta, ...(thumb ? { thumb: true } : {}) }), thumb?.length ?? 0, bytes, now, now);
        if (tmp) renameSync(tmp, this.filePath(owner, id, true));
      });
    } catch (e) {
      if (tmp) rmQuiet(tmp);
      throw e;
    }
    this.total += bytes;
    return summary(this.item(owner, id));
  }

  /** Change an item's title or content. `rev`, when given, must be the item's current one. */
  updateItem(owner: string, o: { id: unknown; title?: unknown; data?: unknown; rev?: unknown }): ItemSummary {
    const r = this.item(owner, o.id);
    if (o.rev !== undefined && o.rev !== r.rev) throw new FoldersFailure(409, 'conflict', 'This item was changed somewhere else. Reload it before saving.');
    const title = o.title === undefined ? r.title : cleanName(o.title, this.cfg.limits.titleChars, 'A title');
    let json = r.data;
    let meta = JSON.parse(r.meta) as ItemMeta;
    if (o.data !== undefined) {
      if (r.kind === 'file' || r.kind === 'news' || r.kind === 'chart') throw new FoldersFailure(400, 'input', `A ${r.kind} keeps what was saved; only its title can change.`);
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
        .run(title, json, JSON.stringify({ ...meta, ...(r.thumb_bytes ? { thumb: true } : {}) }), bytes, this.now(), r.id, owner);
    });
    this.total += grow;
    return summary(this.item(owner, r.id));
  }

  /** Move an item to `index` in a folder - its own (reorder) or another. */
  moveItem(owner: string, o: { id: unknown; folderId: unknown; index: unknown }): void {
    const r = this.item(owner, o.id);
    const to = this.folder(owner, o.folderId).id;
    const index = typeof o.index === 'number' && Number.isInteger(o.index) && o.index >= 0 ? o.index : Number.MAX_SAFE_INTEGER;
    this.tx(() => {
      if (to !== r.folder_id) {
        const n = this.count('SELECT COUNT(*) AS n FROM items WHERE folder_id = ?', to);
        if (n >= this.cfg.limits.itemsPerFolder) throw new FoldersFailure(409, 'folder-full', `A folder holds ${this.cfg.limits.itemsPerFolder} items. That one is full.`);
      }
      const ids = (this.db.prepare('SELECT id FROM items WHERE folder_id = ? AND id <> ? ORDER BY position, created_at').all(to, r.id) as Array<{ id: string }>).map((x) => x.id);
      ids.splice(Math.min(index, ids.length), 0, r.id);
      this.db.prepare('UPDATE items SET folder_id = ?, updated_at = ? WHERE id = ? AND owner = ?').run(to, this.now(), r.id, owner);
      ids.forEach((id, i) => this.db.prepare('UPDATE items SET position = ? WHERE id = ?').run(i, id));
      if (to !== r.folder_id) this.renumberItems(r.folder_id);
    });
  }

  deleteItem(owner: string, id: unknown): void {
    const r = this.item(owner, id);
    this.tx(() => {
      this.db.prepare('DELETE FROM items WHERE id = ? AND owner = ?').run(r.id, owner);
      this.renumberItems(r.folder_id);
    });
    this.dropFiles(r);
    this.total -= r.bytes;
  }

  /** Store an uploaded file: sniffed, counted, written. */
  upload(owner: string, o: { folderId: unknown; name: unknown; title?: unknown; bytes: Buffer }): ItemSummary {
    const folderId = this.folder(owner, o.folderId).id;
    const size = o.bytes.length;
    if (size === 0) throw new FoldersFailure(400, 'input', 'The file is empty.');
    if (size > this.cfg.limits.fileBytes) throw new FoldersFailure(413, 'too-large', `A file can be at most ${mb(this.cfg.limits.fileBytes)}.`);
    const type = sniffFile(o.bytes);
    if (!type) throw new FoldersFailure(415, 'file-type', 'Folders keep PDFs, images (PNG, JPEG, WebP, GIF) and plain text files.');
    const fileName = cleanFileName(o.name);
    const title = o.title === undefined || o.title === '' ? cleanName(fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '') || fileName, this.cfg.limits.titleChars, 'A title') : cleanName(o.title, this.cfg.limits.titleChars, 'A title');
    const id = newId();
    const now = this.now();
    const tmp = this.writeTemp(owner, o.bytes);
    try {
      this.tx(() => {
        this.roomFor(owner, folderId, size, 1);
        const position = this.count('SELECT COUNT(*) AS n FROM items WHERE folder_id = ?', folderId);
        const meta: ItemMeta = { fileType: type, fileName };
        this.db
          .prepare('INSERT INTO items (id, owner, folder_id, kind, title, position, data, meta, file_type, file_bytes, thumb_bytes, bytes, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, ?, 1, ?, ?)')
          .run(id, owner, folderId, 'file', title, position, JSON.stringify(meta), type, size, size, now, now);
        renameSync(tmp, this.filePath(owner, id, false));
      });
    } catch (e) {
      rmQuiet(tmp);
      throw e;
    }
    this.total += size;
    return summary(this.item(owner, id));
  }

  /** Delete everything the wallet keeps here and end its sessions everywhere. */
  erase(owner: string): { items: number; folders: number } {
    const items = this.db.prepare('SELECT bytes FROM items WHERE owner = ?').all(owner) as Array<{ bytes: number }>;
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
    rmSync(join(this.files, owner), { recursive: true, force: true });
    this.total -= items.reduce((n, r) => n + r.bytes, 0);
    return { items: items.length, folders };
  }

  /* ----------------------------------------------------------- upkeep ----- */

  /**
   * Expired nonces go; a wallet not seen for the retention period goes with
   * everything it kept (FOLDERS_RETENTION_DAYS, the privacy policy's period).
   */
  sweep(): { owners: number } {
    const now = this.now();
    this.db.prepare('DELETE FROM nonces WHERE expires_at < ?').run(now);
    if (!this.cfg.retentionMs) return { owners: 0 };
    const stale = (this.db.prepare('SELECT owner FROM owners WHERE last_seen < ?').all(now - this.cfg.retentionMs) as Array<{ owner: string }>).map((r) => r.owner);
    for (const owner of stale) {
      this.erase(owner);
      this.db.prepare('DELETE FROM owners WHERE owner = ?').run(owner);
    }
    return { owners: stale.length };
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

  /** Room for `bytes` more (and `items` more in `folderId`): the folder, the wallet, the server, the disk. */
  private roomFor(owner: string, folderId: string | null, bytes: number, items: number): void {
    const l = this.cfg.limits;
    if (folderId && items > 0) {
      const n = this.count('SELECT COUNT(*) AS n FROM items WHERE folder_id = ?', folderId);
      if (n + items > l.itemsPerFolder) throw new FoldersFailure(409, 'folder-full', `A folder holds ${l.itemsPerFolder} items. Delete one or use another folder.`);
    }
    const used = this.count('SELECT COALESCE(SUM(bytes), 0) AS n FROM items WHERE owner = ?', owner);
    if (used + bytes > l.walletBytes) {
      throw new FoldersFailure(413, 'quota', `Your folders can hold ${mb(l.walletBytes)}; ${mb(Math.max(0, l.walletBytes - used))} is left. Delete something to make room.`);
    }
    if (this.total + bytes > this.cfg.totalBytes || this.freeBytes() - bytes < this.cfg.minFreeBytes) {
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

  private item(owner: string, id: unknown): ItemRow {
    if (typeof id !== 'string' || !ID.test(id)) throw new FoldersFailure(404, 'not-found', 'There is no such item.');
    const r = this.db.prepare('SELECT * FROM items WHERE id = ? AND owner = ?').get(id, owner) as ItemRow | undefined;
    if (!r) throw new FoldersFailure(404, 'not-found', 'There is no such item.');
    return r;
  }

  private count(sql: string, ...args: string[]): number {
    return Number((this.db.prepare(sql).get(...args) as { n: number }).n);
  }

  private renumberItems(folderId: string): void {
    const ids = (this.db.prepare('SELECT id FROM items WHERE folder_id = ? ORDER BY position, created_at').all(folderId) as Array<{ id: string }>).map((x) => x.id);
    ids.forEach((id, i) => this.db.prepare('UPDATE items SET position = ? WHERE id = ?').run(i, id));
  }

  private renumberFolders(owner: string): void {
    const ids = (this.db.prepare('SELECT id FROM folders WHERE owner = ? ORDER BY position, created_at').all(owner) as Array<{ id: string }>).map((x) => x.id);
    ids.forEach((id, i) => this.db.prepare('UPDATE folders SET position = ? WHERE id = ?').run(i, id));
  }

  private filePath(owner: string, id: string, thumb: boolean): string {
    return join(this.files, owner, thumb ? `${id}.thumb` : id);
  }

  private writeTemp(owner: string, bytes: Buffer): string {
    const dir = join(this.files, owner);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.tmp-${newId()}`);
    writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
    return tmp;
  }

  private dropFiles(r: ItemRow): void {
    if (r.kind === 'file') rmQuiet(this.filePath(r.owner, r.id, false));
    if (r.thumb_bytes) rmQuiet(this.filePath(r.owner, r.id, true));
  }

  /** One transaction; rolled back when `fn` throws. */
  private tx<T>(fn: () => T): T {
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
    /* gone already, or the next sweep's */
  }
}

const mb = (n: number): string => `${(n / 1048576).toFixed(n % 1048576 === 0 ? 0 : 1)} MB`;

/** For the content type a file is served with. */
export const mimeOf = (t: FileType): string => FILE_TYPES[t].mime;
