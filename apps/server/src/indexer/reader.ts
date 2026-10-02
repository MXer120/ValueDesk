/**
 * The API side's one connection to the index file. READ-ONLY.
 *
 * The indexer owns the only writing connection - a worker thread of this
 * process in dev, its own process in production (VALUESCAN_INDEXER=0 here). It
 * creates the file, applies the schema and migrates. This side opens the same
 * file with SQLite's read-only flag and runs no statement that can change it:
 * no journal mode, no schema, no added column, no migration. So an API process
 * can never write to the index, whatever it is asked, and can run on a file it
 * has no permission to write.
 *
 * (Until 2026-10-02 this connection was opened read-write and ran the same
 * constructor as the writer - WAL, the schema, added columns, `meta.schema`,
 * even the Arcus re-read migration that deletes rows. Harmless while both
 * lived in one dev process; wrong for an API process next to the indexer.)
 *
 * WAL still needs the `-shm` file beside the database for a reader: the
 * account an API process runs as must be able to open it (the writer creates
 * it), which is the case when both run as the same user.
 *
 * A file that is missing, or that the writer has not brought to this code's
 * schema yet, reads as "no index": `null`, the routes answer "indexing", and
 * the file is tried again after RETRY_MS.
 */
import { existsSync } from 'node:fs';
import { IndexStore, defaultDbPath } from './store.js';

/** How long a failed attempt (no file, an older schema, a file that will not open) stands. */
export const RETRY_MS = 10_000;

let store: IndexStore | null = null;
let triedAt = 0;

export function reader(): IndexStore | null {
  if (store) return store;
  if (Date.now() - triedAt < RETRY_MS) return null;
  triedAt = Date.now();
  const path = defaultDbPath();
  if (!existsSync(path)) return null;
  let s: IndexStore | null = null;
  try {
    s = new IndexStore(path, { readOnly: true });
    if (s.schemaReady()) store = s;
  } catch {
    store = null;
  }
  if (!store) {
    try { s?.close(); } catch { /* it never opened */ }
  }
  return store;
}

/** Close the connection and forget the last attempt: the next read opens the file again. */
export function closeReader(): void {
  try { store?.close(); } catch { /* closed already */ }
  store = null;
  triedAt = 0;
}
