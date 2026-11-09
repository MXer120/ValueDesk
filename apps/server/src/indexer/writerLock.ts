/**
 * The index's writer lock: one process at a time may write the index, even by mistake.
 *
 * A handover (handover.ts) runs two indexer processes side by side for a few minutes, and only one of them may write.
 * SQLite already refuses two writes at the same instant, but not two writers taking turns, and two writers taking
 * turns would count every print twice. So the writer holds a lock for as long as it writes:
 *
 *   `<index>.writer-lock`  a tiny SQLite file opened in EXCLUSIVE locking mode with one write: SQLite then keeps the
 *                          file's lock (fcntl on Linux, LockFileEx on Windows) until the connection closes. The kernel
 *                          drops it the moment the process ends, crash or SIGKILL included, so a dead writer never
 *                          leaves it held - what a pid file alone cannot promise. Node has no flock; this is the same
 *                          kernel lock through the SQLite the indexer already loads.
 *   `<index>.writer-pid`   who holds it, as text (a held lock cannot be read through SQLite): for the log lines.
 *
 * Within one process a second open of the same file does not conflict (POSIX locks are per process): the lock is
 * between processes, which is what it is for.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

export interface WriterLock {
  readonly path: string;
  /** Let go now (the handover: the incoming process takes it). The process may go on running. */
  release(): void;
  readonly held: boolean;
}

export const lockPathOf = (dbPath: string): string => `${dbPath}.writer-lock`;
const pidPathOf = (dbPath: string): string => `${dbPath}.writer-pid`;

/** Who holds the lock, as the holder wrote it (null: no record). Not proof that it is held. */
export function lockHolder(dbPath: string): { pid: number; at: number; role: string } | null {
  try {
    const j = JSON.parse(readFileSync(pidPathOf(dbPath), 'utf8')) as { pid?: unknown; at?: unknown; role?: unknown };
    return typeof j.pid === 'number' ? { pid: j.pid, at: Number(j.at) || 0, role: String(j.role ?? '') } : null;
  } catch {
    return null;
  }
}

/** Take the lock if no other process holds it; null if one does. Never waits. */
export function tryWriterLock(dbPath: string, role = 'indexer'): WriterLock | null {
  if (dbPath === ':memory:') return { path: dbPath, release() {}, held: true };
  const path = lockPathOf(dbPath);
  let db: DatabaseSync | null = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    // The first write takes the EXCLUSIVE lock, and in this mode it is kept until close.
    db.exec('CREATE TABLE IF NOT EXISTS holder (k INTEGER PRIMARY KEY, pid INTEGER, at INTEGER, role TEXT)');
    db.prepare('INSERT OR REPLACE INTO holder (k, pid, at, role) VALUES (1, ?, ?, ?)').run(process.pid, Date.now(), role);
  } catch (e) {
    try { db.close(); } catch { /* not open */ }
    db = null;
    if (/locked|busy/i.test(String(e))) return null;
    throw e;
  }
  try { writeFileSync(pidPathOf(dbPath), JSON.stringify({ pid: process.pid, at: Date.now(), role })); } catch { /* the lock still holds */ }
  let held = true;
  return {
    path,
    get held() { return held; },
    release() {
      if (!held) return;
      held = false;
      // The record first: whoever reads it after the lock is free must not see this process as the holder.
      try {
        if (lockHolder(dbPath)?.pid === process.pid) rmSync(pidPathOf(dbPath), { force: true });
      } catch { /* gone */ }
      try { db?.close(); } catch { /* closed */ }
      db = null;
    },
  };
}

/** Take the lock, polling every `everyMs`, for up to `waitMs`; null if it stayed held. `stop`: give up early. */
export async function waitWriterLock(dbPath: string, o: { role?: string; waitMs: number; everyMs?: number; stop?: () => boolean }): Promise<WriterLock | null> {
  const end = Date.now() + o.waitMs;
  for (;;) {
    const lock = tryWriterLock(dbPath, o.role);
    if (lock) return lock;
    if (Date.now() >= end || o.stop?.()) return null;
    await new Promise((r) => setTimeout(r, o.everyMs ?? 100));
  }
}
