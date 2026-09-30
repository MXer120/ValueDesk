/**
 * The last good answer of an account read, kept on disk.
 *
 * WHY. SoDEX rate-limits the heavy history endpoints (/trades, /orders/history)
 * per IP, and a limit can last a long while. A history page that loaded an hour
 * ago is still almost entirely right - history only grows at the top - so when
 * SoDEX refuses or fails, the last good answer is served (marked `stale` with
 * its age) instead of "couldn't load". A fresh answer always wins when there is
 * one.
 *
 * Only READS of public account data are stored (no keys, no signed requests),
 * keyed by the exact upstream path. Bounded: entries older than 7 days are
 * dropped on write, and the table is capped.
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { deviceKeyPath } from '../deviceKey.js';

const MAX_AGE_MS = 7 * 86_400_000;
const MAX_ROWS = 5_000;

/** Sweep old rows and enforce MAX_ROWS every this many writes (was 2% at random). */
const SWEEP_EVERY = 50;
let writes = 0;

let db: DatabaseSync | null = null;
let tried = false;

function store(): DatabaseSync | null {
  if (tried) return db;
  tried = true;
  try {
    const path = process.env.VALUETRADE_LASTGOOD_DB?.trim() || join(dirname(deviceKeyPath()), 'last-good.db');
    mkdirSync(dirname(path), { recursive: true });
    const d = new DatabaseSync(path);
    d.exec('CREATE TABLE IF NOT EXISTS last_good (path TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL)');
    db = d;
  } catch {
    db = null; // no store: reads simply fail as before
  }
  return db;
}

export function rememberGood(path: string, value: unknown): void {
  const d = store();
  if (!d) return;
  try {
    const now = Date.now();
    d.prepare('INSERT OR REPLACE INTO last_good (path, at, body) VALUES (?, ?, ?)').run(path, now, JSON.stringify(value));
    if (++writes % SWEEP_EVERY === 0) {
      d.prepare('DELETE FROM last_good WHERE at < ?').run(now - MAX_AGE_MS);
      d.prepare('DELETE FROM last_good WHERE path NOT IN (SELECT path FROM last_good ORDER BY at DESC LIMIT ?)').run(MAX_ROWS);
    }
  } catch {
    /* best effort */
  }
}

export function lastGood(path: string): { at: number; value: unknown } | null {
  const d = store();
  if (!d) return null;
  try {
    const row = d.prepare('SELECT at, body FROM last_good WHERE path = ?').get(path) as { at?: number; body?: string } | undefined;
    if (!row?.body || typeof row.at !== 'number' || Date.now() - row.at > MAX_AGE_MS) return null;
    return { at: row.at, value: JSON.parse(row.body) };
  } catch {
    return null;
  }
}
