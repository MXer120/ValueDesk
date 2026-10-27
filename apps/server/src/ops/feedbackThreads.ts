/**
 * Feedback as conversations (routes/reports.ts): every thread is a chat between
 * one browser and the owner, who answers from Telegram (ops/telegramReplies.ts).
 *
 * WHO MAY READ A THREAD. The browser makes a random token per thread (32 bytes,
 * apps/web/src/feedback/threads.ts) and sends it as `Authorization: Bearer` -
 * never in a URL. Here only its SHA-256 is kept: a copy of this database opens
 * no thread. Whoever holds the token reads and writes that thread, nobody else.
 *
 * Kept in `feedback.db` in the server's data directory (SQLite, WAL); screenshots
 * as files in `feedback-images/` beside it, named by a random id, outside any
 * web root, served back only to the thread's token (routes/reports.ts). Nothing
 * here is ever edited: messages and images are only added (and an image that was
 * uploaded but never sent is removed after an hour). Bounded: MAX_MESSAGES
 * messages and MAX_IMAGE_BYTES_TOTAL of images; past either, a new message is
 * refused until the owner moves the files.
 *
 * Tables:
 *   threads   id, token hash, category, the wallet the visitor chose to add (or null),
 *             when it started and last moved
 *   messages  one row per message: who (user / owner), its text, the page info
 *             sent with it (JSON), when, and the Telegram message it became
 *   images    one row per screenshot: its thread's token hash, the message it
 *             belongs to (null until sent), kind, size, dimensions, file name
 *   tg        Telegram message id -> thread: what an owner's reply is matched by
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

export type Sender = 'user' | 'owner';

export interface ThreadRow {
  id: number;
  category: string;
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
}

export interface ImageRow {
  id: string;
  kind: ImageKind;
  bytes: number;
  width: number;
  height: number;
}

export class FullError extends Error {}

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
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
`;

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
  }

  thread(token: string): ThreadRow | null {
    const r = this.db.prepare('SELECT id, category, wallet, created_at, last_at FROM threads WHERE token_hash = ?').get(tokenHash(token)) as
      | { id: number; category: string; wallet: string | null; created_at: number; last_at: number }
      | undefined;
    return r ? { id: Number(r.id), category: r.category, wallet: r.wallet, createdAt: Number(r.created_at), lastAt: Number(r.last_at) } : null;
  }

  /**
   * A visitor's message: into its thread, the thread made if the token is new,
   * with the screenshots this token uploaded and named. Returns the thread and
   * message ids and the images attached.
   */
  addUserMessage(
    token: string,
    m: { category: string; text: string; context: unknown; wallet: string | null; images: readonly string[] },
    now = Date.now(),
  ): { threadId: number; messageId: number; isNew: boolean; images: ImageRow[] } {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    if (count >= MAX_MESSAGES) throw new FullError('the feedback store is full');
    const hash = tokenHash(token);
    this.db.exec('BEGIN');
    try {
      let t = this.db.prepare('SELECT id FROM threads WHERE token_hash = ?').get(hash) as { id: number } | undefined;
      const isNew = !t;
      if (!t) {
        const r = this.db.prepare('INSERT INTO threads (token_hash, category, wallet, created_at, last_at) VALUES (?, ?, ?, ?, ?)').run(hash, m.category, m.wallet, now, now);
        t = { id: Number(r.lastInsertRowid) };
      } else {
        this.db.prepare('UPDATE threads SET last_at = ?, wallet = COALESCE(?, wallet) WHERE id = ?').run(now, m.wallet, t.id);
      }
      const msg = this.db
        .prepare('INSERT INTO messages (thread_id, sender, text, context, at) VALUES (?, ?, ?, ?, ?)')
        .run(t.id, 'user', m.text, m.context === null || m.context === undefined ? null : JSON.stringify(m.context), now);
      const messageId = Number(msg.lastInsertRowid);
      const attached: ImageRow[] = [];
      const pick = this.db.prepare('SELECT id, kind, bytes, width, height FROM images WHERE id = ? AND token_hash = ? AND message_id IS NULL');
      const bind = this.db.prepare('UPDATE images SET message_id = ? WHERE id = ?');
      for (const id of m.images.slice(0, MAX_IMAGES_PER_MESSAGE)) {
        const r = pick.get(id, hash) as { id: string; kind: ImageKind; bytes: number; width: number; height: number } | undefined;
        if (!r) continue;
        bind.run(messageId, id);
        attached.push({ id: r.id, kind: r.kind, bytes: Number(r.bytes), width: Number(r.width), height: Number(r.height) });
      }
      this.db.exec('COMMIT');
      return { threadId: Number(t.id), messageId, isNew, images: attached };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
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
    const rows = this.db.prepare('SELECT id, sender, text, at FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?').all(threadId, limit) as Array<{ id: number; sender: Sender; text: string; at: number }>;
    const imgs = this.db.prepare('SELECT id FROM images WHERE message_id = ? ORDER BY at, id');
    return rows.reverse().map((r) => ({
      id: Number(r.id),
      from: r.sender,
      text: r.text,
      at: Number(r.at),
      images: (imgs.all(r.id) as Array<{ id: string }>).map((x) => x.id),
    }));
  }

  /** For the browser's poll: how many owner replies a thread has, and the newest one's time. */
  summary(token: string): { owner: number; lastOwnerAt: number | null } | null {
    const t = this.thread(token);
    if (!t) return null;
    const r = this.db.prepare("SELECT COUNT(*) AS n, MAX(at) AS last FROM messages WHERE thread_id = ? AND sender = 'owner'").get(t.id) as { n: number; last: number | null };
    return { owner: Number(r.n), lastOwnerAt: r.last === null ? null : Number(r.last) };
  }

  /** Keep one checked screenshot for a token, pending until a message names it. */
  addImage(token: string, img: { kind: ImageKind; width: number; height: number }, bytes: Uint8Array, now = Date.now()): ImageRow {
    this.sweep(now);
    const hash = tokenHash(token);
    const pending = (this.db.prepare('SELECT COUNT(*) AS n FROM images WHERE token_hash = ? AND message_id IS NULL').get(hash) as { n: number }).n;
    if (pending >= MAX_IMAGES_PER_MESSAGE) throw new FullError(`at most ${MAX_IMAGES_PER_MESSAGE} screenshots per message`);
    const total = (this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM images').get() as { n: number }).n;
    if (total + bytes.length > MAX_IMAGE_BYTES_TOTAL) throw new FullError('the screenshot store is full');
    const id = randomBytes(12).toString('hex');
    writeFileSync(join(this.imageDir, id), bytes, { mode: 0o600, flag: 'wx' });
    this.db.prepare('INSERT INTO images (id, token_hash, message_id, kind, bytes, width, height, at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)').run(id, hash, img.kind, bytes.length, img.width, img.height, now);
    return { id, kind: img.kind, bytes: bytes.length, width: img.width, height: img.height };
  }

  /** A screenshot of this token's thread - sent, or pending for it - with its bytes; null for anyone else. */
  image(token: string, id: string): { row: ImageRow; bytes: Buffer } | null {
    if (!/^[0-9a-f]{24}$/.test(id)) return null;
    const hash = tokenHash(token);
    const r = this.db
      .prepare(
        `SELECT i.id, i.kind, i.bytes, i.width, i.height FROM images i
         LEFT JOIN messages m ON m.id = i.message_id LEFT JOIN threads t ON t.id = m.thread_id
         WHERE i.id = ? AND (t.token_hash = ? OR (i.message_id IS NULL AND i.token_hash = ?))`,
      )
      .get(id, hash, hash) as { id: string; kind: ImageKind; bytes: number; width: number; height: number } | undefined;
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
