/**
 * Feedback as conversations (routes/reports.ts): one ongoing chat per visitor
 * with the owner, who answers from Telegram (ops/telegramReplies.ts). A chat
 * never expires; both sides keep writing into it.
 *
 * ONE CHAT PER WALLET (owner, 2026-10-28: "this needs to be always ... no
 * signing for sending the report. Only viewing the chat"). A message that comes
 * with a wallet address goes into that wallet's chat - proven when the sender
 * holds the wallet's session (ops/feedbackAuth.ts), otherwise only claimed,
 * and stored as such. READING a chat - its messages, its screenshots - takes
 * the wallet's session and nothing else (routes/reports.ts); typing someone's
 * address opens nothing.
 *
 * THE BROWSER'S TOKEN (32 random bytes, apps/web/src/feedback/threads.ts, sent
 * as `Authorization: Bearer`, never in a URL; only its SHA-256 is kept) opens no
 * chat and tells nothing about one - not even a reply count (owner, 2026-10-28).
 * It is what an unsigned message is sent with, and the handle of a message sent
 * with no wallet connected: kept in a chat of its own under the token
 * (unreadable by anyone), and moved into the wallet's chat when that browser
 * first signs in with a wallet (attach). Chats from before 2026-10-28, kept by
 * token, are moved the same way.
 *
 * Kept in `feedback.db` in the server's data directory (SQLite, WAL); screenshots
 * as files in `feedback-images/` beside it, named by a random id, outside any
 * web root, served back only to the chat's key (routes/reports.ts). Both are in
 * the off-server backup (deploy/server/bin/backup-offsite.sh, set api-state).
 * Messages and images are only ever added (an image uploaded but never sent is
 * removed after an hour; an attach moves messages between chats). Bounded:
 * MAX_MESSAGES messages and MAX_IMAGE_BYTES_TOTAL of images; past either, a new
 * message is refused until the owner moves the files.
 *
 * Tables:
 *   threads   id, token hash (`w:<wallet>` for a chat a wallet started), first
 *             category, the wallet it is kept on (owner_wallet, proven) or null,
 *             the chat it moved into (merged_into) or null, when it started and
 *             last moved. (`wallet` is from before 2026-10-28: an unproven address.)
 *   messages  one row per message: who (user / owner), its text, kind and areas,
 *             the wallet it was sent with and whether that was proven, the page
 *             info (JSON), when, and the Telegram message it became
 *   images    one row per screenshot: its uploader's key, the message it belongs
 *             to (null until sent), kind, size, dimensions
 *   tg        Telegram message id -> thread: what an owner's reply is matched by
 *   nonces    wallet sign-ins already used, until they expire
 *   meta      the getUpdates offset (ops/telegramReplies.ts)
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../builder/paths.js';
import type { ImageKind } from './imageCheck.js';

export const MAX_MESSAGES = 200_000;
export const MAX_IMAGE_BYTES_TOTAL = 2 * 1024 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 3;
/** An uploaded screenshot not sent with a message within this is removed. */
export const PENDING_IMAGE_MS = 60 * 60_000;

/** A thread token: 32 random bytes, base64url, as the browser makes it. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
/** The token from an `Authorization: Bearer <token>` header, or null. */
export function bearer(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header.trim());
  return m ? m[1]! : null;
}

export const feedbackDbPath = (): string => process.env.VALUESCAN_FEEDBACK_DB?.trim() || join(dataDir(), 'feedback.db');

/** Who is asking: a browser by its thread token, or a proven wallet (lower case). */
export type Who = { token: string } | { wallet: string };

/** The key a chat or a pending screenshot is filed under. */
const keyOf = (who: Who): string => ('token' in who ? tokenHash(who.token) : `w:${who.wallet.toLowerCase()}`);

export type Sender = 'user' | 'owner';

export interface ThreadRow {
  id: number;
  category: string;
  /** The wallet the chat is kept on (proven), or null. */
  wallet: string | null;
  createdAt: number;
  lastAt: number;
}

export interface MessageRow {
  id: number;
  from: Sender;
  text: string;
  at: number;
  images: string[];
  category: string | null;
  areas: string[];
  /** A visitor's message sent with the wallet's session (false: only the address was given). Always true for the owner. */
  proven: boolean;
}

export interface ImageRow {
  id: string;
  kind: ImageKind;
  bytes: number;
  width: number;
  height: number;
}

export class FullError extends Error {}
/** A thread token whose chat is kept on a wallet: only the wallet's proof opens it. */
export class LockedError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  wallet TEXT,
  created_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  context TEXT,
  at INTEGER NOT NULL,
  tg_id INTEGER
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, id);
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  message_id INTEGER,
  kind TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS images_pending ON images (token_hash, message_id);
CREATE TABLE IF NOT EXISTS tg (tg_id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pings (token_hash TEXT PRIMARY KEY, chat TEXT NOT NULL, seen_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS pings_chat ON pings (chat);
`;

/** Columns added after the first release (2026-10-28); added in place to an older file. */
const ADDED: Record<string, Array<[string, string]>> = {
  threads: [['owner_wallet', 'TEXT'], ['merged_into', 'INTEGER']],
  messages: [['category', 'TEXT'], ['areas', 'TEXT'], ['wallet', 'TEXT'], ['verified', 'INTEGER']],
};

interface ThreadDb { id: number; category: string; owner_wallet: string | null; merged_into: number | null; created_at: number; last_at: number }

const rowOf = (r: ThreadDb): ThreadRow => ({ id: Number(r.id), category: r.category, wallet: r.owner_wallet, createdAt: Number(r.created_at), lastAt: Number(r.last_at) });

export class FeedbackStore {
  private readonly db: DatabaseSync;
  readonly imageDir: string;

  constructor(path = feedbackDbPath(), o: { imageDir?: string } = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.imageDir = o.imageDir ?? join(dirname(path), 'feedback-images');
    mkdirSync(this.imageDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 2000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    for (const [table, cols] of Object.entries(ADDED)) {
      const have = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
      for (const [name, type] of cols) if (!have.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS threads_owner_wallet ON threads (owner_wallet) WHERE owner_wallet IS NOT NULL');
  }

  private byId(id: number): ThreadDb | undefined {
    return this.db.prepare('SELECT id, category, owner_wallet, merged_into, created_at, last_at FROM threads WHERE id = ?').get(id) as ThreadDb | undefined;
  }

  /** The chat a key names, after any move (attach), and whether this key may open it. */
  private find(who: Who): { row: ThreadDb; locked: boolean } | null {
    if ('wallet' in who) {
      const r = this.db.prepare('SELECT id, category, owner_wallet, merged_into, created_at, last_at FROM threads WHERE owner_wallet = ?').get(who.wallet.toLowerCase()) as ThreadDb | undefined;
      return r ? { row: r, locked: false } : null;
    }
    let r = this.db.prepare('SELECT id, category, owner_wallet, merged_into, created_at, last_at FROM threads WHERE token_hash = ?').get(tokenHash(who.token)) as ThreadDb | undefined;
    for (let hops = 0; r && r.merged_into !== null && hops < 4; hops++) r = this.byId(Number(r.merged_into));
    if (!r) return null;
    return { row: r, locked: r.owner_wallet !== null };
  }

  /** The chat this key may open; 'locked' for a token whose chat is kept on a wallet; null for none. */
  thread(who: Who): ThreadRow | 'locked' | null {
    const f = this.find(who);
    if (!f) return null;
    return f.locked ? 'locked' : rowOf(f.row);
  }

  /**
   * A visitor's message: into the chat `who` names (a wallet's - proven or only
   * claimed, see `verified` - or a token's own), the chat made if there is none,
   * with the screenshots `uploader` (default `who`) uploaded and named. Writing
   * opens nothing: reading is the route's to allow.
   */
  addUserMessage(
    who: Who,
    m: { category: string; areas?: readonly string[]; text: string; context: unknown; wallet: string | null; verified?: boolean; images: readonly string[] },
    now = Date.now(),
    uploader: Who = who,
  ): { threadId: number; messageId: number; isNew: boolean; images: ImageRow[] } {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    if (count >= MAX_MESSAGES) throw new FullError('the feedback store is full');
    const key = keyOf(uploader);
    this.db.exec('BEGIN');
    try {
      const found = this.find(who);
      const isNew = !found;
      let threadId: number;
      if (!found) {
        const r = this.db
          .prepare('INSERT INTO threads (token_hash, category, wallet, owner_wallet, created_at, last_at) VALUES (?, ?, NULL, ?, ?, ?)')
          .run(keyOf(who), m.category, 'wallet' in who ? who.wallet.toLowerCase() : null, now, now);
        threadId = Number(r.lastInsertRowid);
      } else {
        threadId = Number(found.row.id);
        this.db.prepare('UPDATE threads SET last_at = ? WHERE id = ?').run(now, threadId);
      }
      const msg = this.db
        .prepare('INSERT INTO messages (thread_id, sender, text, context, at, category, areas, wallet, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          threadId, 'user', m.text, m.context === null || m.context === undefined ? null : JSON.stringify(m.context), now,
          m.category, m.areas?.length ? JSON.stringify(m.areas) : null, m.wallet, m.verified ? 1 : 0,
        );
      const messageId = Number(msg.lastInsertRowid);
      const attached: ImageRow[] = [];
      const pick = this.db.prepare('SELECT id, kind, bytes, width, height FROM images WHERE id = ? AND token_hash = ? AND message_id IS NULL');
      const bind = this.db.prepare('UPDATE images SET message_id = ? WHERE id = ?');
      for (const id of m.images.slice(0, MAX_IMAGES_PER_MESSAGE)) {
        const r = pick.get(id, key) as { id: string; kind: ImageKind; bytes: number; width: number; height: number } | undefined;
        if (!r) continue;
        bind.run(messageId, id);
        attached.push({ id: r.id, kind: r.kind, bytes: Number(r.bytes), width: Number(r.width), height: Number(r.height) });
      }
      this.db.exec('COMMIT');
      return { threadId, messageId, isNew, images: attached };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Keep a browser's chat on a wallet it just proved. `adopted`: the chat is now
   * the wallet's; `merged`: the wallet had a chat, the messages moved into it;
   * `same`: it was already; `none`: the token has no chat; `other`: the chat is
   * kept on another wallet (nothing changes).
   */
  attach(token: string, wallet: string, now = Date.now()): { result: 'adopted' | 'merged' | 'same' | 'none' | 'other'; threadId: number | null; from: number | null } {
    const w = wallet.toLowerCase();
    this.db.exec('BEGIN');
    try {
      const own = this.find({ wallet: w });
      const t = this.db.prepare('SELECT id, category, owner_wallet, merged_into, created_at, last_at FROM threads WHERE token_hash = ?').get(tokenHash(token)) as ThreadDb | undefined;
      let out: { result: 'adopted' | 'merged' | 'same' | 'none' | 'other'; threadId: number | null; from: number | null };
      if (!t) out = { result: 'none', threadId: own ? Number(own.row.id) : null, from: null };
      else {
        const target = this.find({ token })!.row;
        if (target.owner_wallet === w) out = { result: 'same', threadId: Number(target.id), from: null };
        else if (target.owner_wallet !== null) out = { result: 'other', threadId: null, from: null };
        else if (!own) {
          this.db.prepare('UPDATE threads SET owner_wallet = ?, last_at = ? WHERE id = ?').run(w, now, target.id);
          out = { result: 'adopted', threadId: Number(target.id), from: null };
        } else {
          const to = Number(own.row.id);
          const from = Number(target.id);
          this.db.prepare('UPDATE messages SET thread_id = ? WHERE thread_id = ?').run(to, from);
          this.db.prepare('UPDATE tg SET thread_id = ? WHERE thread_id = ?').run(to, from);
          this.db.prepare('UPDATE threads SET merged_into = ? WHERE id = ? OR merged_into = ?').run(to, from, from);
          this.db.prepare('UPDATE threads SET last_at = MAX(last_at, ?) WHERE id = ?').run(Number(target.last_at), to);
          out = { result: 'merged', threadId: to, from };
        }
      }
      // The browsers watching the token's own chat now watch the wallet's (unread()).
      if (t && out.result !== 'other' && out.result !== 'none') this.db.prepare('UPDATE pings SET chat = ? WHERE chat = ?').run(`w:${w}`, tokenHash(token));
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** A wallet sign-in's nonce, accepted once (until it expires). False: a replay. */
  useNonce(nonce: string, expiresAt: number, now = Date.now()): boolean {
    this.db.prepare('DELETE FROM nonces WHERE expires_at < ?').run(now);
    return this.db.prepare('INSERT OR IGNORE INTO nonces (nonce, expires_at) VALUES (?, ?)').run(nonce, expiresAt).changes === 1;
  }

  /** The owner's reply, matched by the Telegram message it answers. Null when that message is no thread's. */
  addOwnerReply(replyToTgId: number, text: string, tgId: number, now = Date.now()): { threadId: number; messageId: number } | null {
    const t = this.threadForTg(replyToTgId);
    if (t === null) return null;
    const r = this.db.prepare('INSERT INTO messages (thread_id, sender, text, at, tg_id) VALUES (?, ?, ?, ?, ?)').run(t, 'owner', text, now, tgId);
    this.db.prepare('UPDATE threads SET last_at = ? WHERE id = ?').run(now, t);
    this.mapTg(tgId, t);
    return { threadId: t, messageId: Number(r.lastInsertRowid) };
  }

  /** A Telegram message that belongs to a thread (a forward, a photo, the owner's own reply). */
  mapTg(tgId: number, threadId: number, messageId?: number): void {
    this.db.prepare('INSERT OR REPLACE INTO tg (tg_id, thread_id) VALUES (?, ?)').run(tgId, threadId);
    if (messageId !== undefined) this.db.prepare('UPDATE messages SET tg_id = ? WHERE id = ? AND tg_id IS NULL').run(tgId, messageId);
  }

  threadForTg(tgId: number): number | null {
    const r = this.db.prepare('SELECT thread_id FROM tg WHERE tg_id = ?').get(tgId) as { thread_id: number } | undefined;
    return r ? Number(r.thread_id) : null;
  }

  /** The thread's newest Telegram message: what a follow-up is sent as a reply to, so the owner sees one chain. */
  lastTgOf(threadId: number): number | null {
    const r = this.db.prepare('SELECT MAX(tg_id) AS m FROM tg WHERE thread_id = ?').get(threadId) as { m: number | null };
    return r.m === null ? null : Number(r.m);
  }

  /** A thread's messages, oldest first, each with its screenshots' ids. */
  messages(threadId: number, limit = 500): MessageRow[] {
    const rows = this.db.prepare('SELECT id, sender, text, at, category, areas, verified FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?').all(threadId, limit) as Array<{
      id: number; sender: Sender; text: string; at: number; category: string | null; areas: string | null; verified: number | null;
    }>;
    const imgs = this.db.prepare('SELECT id FROM images WHERE message_id = ? ORDER BY at, id');
    return rows.reverse().map((r) => ({
      id: Number(r.id),
      from: r.sender,
      text: r.text,
      at: Number(r.at),
      images: (imgs.all(r.id) as Array<{ id: string }>).map((x) => x.id),
      category: r.category ?? null,
      areas: parseAreas(r.areas),
      proven: r.sender === 'owner' || Number(r.verified) === 1,
    }));
  }

  /**
   * THE UNREAD DOT (owner, 2026-10-28: "a dot to signal new notifications without
   * needing to sign"). A browser token that sent into a chat - or that a wallet's
   * sign-in named (`watch`) - is remembered with that chat and when it last saw
   * it. `unread(token)` answers ONE bit: has the team written in that chat since?
   * No count, no time, no text. Reading the chat with the wallet's signature marks
   * every such token seen. Someone who sent into a wallet's chat with only its
   * address learns that bit too - their own message is in that chat, the reply may
   * well be theirs - and nothing else.
   */
  notePing(token: string, chat: Who, now = Date.now(), o: { seen?: boolean } = {}): void {
    const c = keyOf(chat);
    if (o.seen) this.db.prepare('INSERT INTO pings (token_hash, chat, seen_at) VALUES (?, ?, ?) ON CONFLICT (token_hash) DO UPDATE SET chat = excluded.chat, seen_at = excluded.seen_at').run(tokenHash(token), c, now);
    else this.db.prepare('INSERT INTO pings (token_hash, chat, seen_at) VALUES (?, ?, ?) ON CONFLICT (token_hash) DO UPDATE SET chat = excluded.chat').run(tokenHash(token), c, now);
  }

  /** The wallet read its chat with its signature: every browser watching it has seen it. */
  markSeen(wallet: string, now = Date.now()): void {
    this.db.prepare('UPDATE pings SET seen_at = ? WHERE chat = ?').run(now, keyOf({ wallet }));
  }

  /** Whether the team wrote in the chat this token watches since it last saw it; false for a token that watches none. */
  unread(token: string): boolean {
    const p = this.db.prepare('SELECT chat, seen_at FROM pings WHERE token_hash = ?').get(tokenHash(token)) as { chat: string; seen_at: number } | undefined;
    if (!p) return false;
    let r = (p.chat.startsWith('w:')
      ? this.db.prepare('SELECT id, category, owner_wallet, merged_into, created_at, last_at FROM threads WHERE owner_wallet = ?').get(p.chat.slice(2))
      : this.db.prepare('SELECT id, category, owner_wallet, merged_into, created_at, last_at FROM threads WHERE token_hash = ?').get(p.chat)) as ThreadDb | undefined;
    for (let hops = 0; r && r.merged_into !== null && hops < 4; hops++) r = this.byId(Number(r.merged_into));
    if (!r) return false;
    return !!this.db.prepare("SELECT 1 FROM messages WHERE thread_id = ? AND sender = 'owner' AND at > ? LIMIT 1").get(r.id, Number(p.seen_at));
  }

  /** For the signed-in wallet's bell: how many owner replies its chat has, and the newest one's time. Only ever a wallet's. */
  summary(who: { wallet: string }): { owner: number; lastOwnerAt: number | null } | null {
    const f = this.find(who);
    if (!f) return null;
    const r = this.db.prepare("SELECT COUNT(*) AS n, MAX(at) AS last FROM messages WHERE thread_id = ? AND sender = 'owner'").get(f.row.id) as { n: number; last: number | null };
    return { owner: Number(r.n), lastOwnerAt: r.last === null ? null : Number(r.last) };
  }

  /** Keep one checked screenshot for a key, pending until a message names it. */
  addImage(who: Who, img: { kind: ImageKind; width: number; height: number }, bytes: Uint8Array, now = Date.now()): ImageRow {
    this.sweep(now);
    const key = keyOf(who);
    const pending = (this.db.prepare('SELECT COUNT(*) AS n FROM images WHERE token_hash = ? AND message_id IS NULL').get(key) as { n: number }).n;
    if (pending >= MAX_IMAGES_PER_MESSAGE) throw new FullError(`at most ${MAX_IMAGES_PER_MESSAGE} screenshots per message`);
    const total = (this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM images').get() as { n: number }).n;
    if (total + bytes.length > MAX_IMAGE_BYTES_TOTAL) throw new FullError('the screenshot store is full');
    const id = randomBytes(12).toString('hex');
    writeFileSync(join(this.imageDir, id), bytes, { mode: 0o600, flag: 'wx' });
    this.db.prepare('INSERT INTO images (id, token_hash, message_id, kind, bytes, width, height, at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)').run(id, key, img.kind, bytes.length, img.width, img.height, now);
    return { id, kind: img.kind, bytes: bytes.length, width: img.width, height: img.height };
  }

  /** A screenshot of this key's chat - sent in it, or pending for this key - with its bytes; null for anyone else. */
  image(who: Who, id: string): { row: ImageRow; bytes: Buffer } | null {
    if (!/^[0-9a-f]{24}$/.test(id)) return null;
    const f = this.find(who);
    const threadId = f && !f.locked ? Number(f.row.id) : -1;
    const r = this.db
      .prepare(
        `SELECT i.id, i.kind, i.bytes, i.width, i.height FROM images i LEFT JOIN messages m ON m.id = i.message_id
         WHERE i.id = ? AND (m.thread_id = ? OR (i.message_id IS NULL AND i.token_hash = ?))`,
      )
      .get(id, threadId, keyOf(who)) as { id: string; kind: ImageKind; bytes: number; width: number; height: number } | undefined;
    if (!r) return null;
    try {
      return { row: { id: r.id, kind: r.kind, bytes: Number(r.bytes), width: Number(r.width), height: Number(r.height) }, bytes: readFileSync(join(this.imageDir, r.id)) };
    } catch {
      return null;
    }
  }

  /** The bytes of a screenshot by id (forwarding to Telegram). */
  imageBytes(id: string): Buffer | null {
    try {
      return /^[0-9a-f]{24}$/.test(id) ? readFileSync(join(this.imageDir, id)) : null;
    } catch {
      return null;
    }
  }

  /** Remove screenshots uploaded but never sent within PENDING_IMAGE_MS. */
  sweep(now = Date.now()): number {
    const old = this.db.prepare('SELECT id FROM images WHERE message_id IS NULL AND at < ?').all(now - PENDING_IMAGE_MS) as Array<{ id: string }>;
    for (const { id } of old) {
      rmSync(join(this.imageDir, id), { force: true });
      this.db.prepare('DELETE FROM images WHERE id = ?').run(id);
    }
    return old.length;
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

function parseAreas(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
