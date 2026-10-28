/**
 * Before a release switches the copy executor over (deploy/release/ship.sh): does the NEW
 * code read TODAY's data? Run from the new release's apps/executor, given the live database -
 * which it never opens for writing: it takes a snapshot (VACUUM INTO a private temporary
 * file), opens the snapshot with the new code's ExecutorDb (any schema change lands on the
 * copy only), loads every copy and algo the way the engines do at start, and walks the audit
 * chain. Starts nothing, sends nothing, unseals no key. One JSON line; the snapshot is deleted.
 *
 *   sudo -u valuescan-executor node --import tsx tools/preflight.ts /var/lib/valuescan/executor/executor.db \
 *     [--keep=/var/lib/valuescan/executor/pre-release/executor-before-v0.2.58.db]
 *
 *   {"ok":true,"copies":3,"active":2,"algos":1,"audit":{"rows":5120,"brokenAt":null},"kept":"..."}
 *
 * --keep also leaves the snapshot as it was taken (before the new code opened anything) at that
 * path: the database as it stood before the release, for going back. Nothing deletes it.
 *
 * The counts are what /api/copy/v1/health reports (copies: every saved copy, algos: those not
 * finished), so ship.sh compares them with the running executor's before it restarts it.
 * Exit 0: the new code reads it and the chain holds; 1: it does not (the line says why); 2: usage.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ExecutorDb, sqlite } from '../src/db.ts';
import { FINAL_STATUSES } from '../../../packages/copy-engine/src/index.ts';

export interface Preflight {
  ok: boolean;
  copies?: number;
  active?: number;
  algos?: number;
  audit?: { rows: number; brokenAt: number | null };
  /** Where the untouched snapshot was left (--keep). */
  kept?: string;
  error?: string;
}

/** A consistent copy of a live database into `to` (the writer may keep writing meanwhile). */
export function snapshot(from: string, to: string): void {
  const into = `VACUUM INTO '${to.replace(/'/g, "''")}'`;
  let src;
  try {
    src = new (sqlite().DatabaseSync)(from, { readOnly: true });
    src.exec(into);
  } catch {
    // A read-only handle on a WAL database without its -shm file cannot read: an ordinary one only reads here too.
    src?.close();
    src = new (sqlite().DatabaseSync)(from);
    src.exec(into);
  }
  src.close();
}

/** What the new code makes of a database (a copy of it, never the file itself); `keep` leaves the untouched snapshot there. */
export async function preflight(live: string, o: { keep?: string } = {}): Promise<Preflight> {
  const dir = mkdtempSync(join(tmpdir(), 'vs-preflight-'));
  const copy = join(dir, 'executor.db');
  try {
    if (!existsSync(live)) throw new Error(`no database at ${live}`);
    if (o.keep) {
      if (existsSync(o.keep)) throw new Error(`${o.keep} exists already: a snapshot is never written over`);
      mkdirSync(dirname(o.keep), { recursive: true, mode: 0o700 });
      snapshot(live, o.keep);
      snapshot(o.keep, copy);
    } else {
      snapshot(live, copy);
    }
    const db = new ExecutorDb(copy);
    try {
      db.ping();
      const subs = await db.subscriptions();
      const algos = await db.algos();
      const chain = db.verifyAudit();
      return {
        ok: chain.brokenAt === null,
        copies: subs.length,
        active: subs.filter((s) => s.status === 'active').length,
        algos: algos.filter((a) => !FINAL_STATUSES.has(a.status)).length,
        audit: { rows: chain.rows, brokenAt: chain.brokenAt },
        ...(o.keep ? { kept: o.keep } : {}),
        ...(chain.brokenAt === null ? {} : { error: `the audit chain breaks at row ${chain.brokenAt}` }),
      };
    } finally {
      db.close();
    }
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0]!.slice(0, 300) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('preflight.ts')) {
  const live = process.argv[2];
  if (!live || live.startsWith('--')) {
    console.error('usage: node --import tsx tools/preflight.ts <executor.db> [--keep=<path>]');
    process.exit(2);
  }
  const keep = process.argv.find((a) => a.startsWith('--keep='))?.slice('--keep='.length);
  const r = await preflight(live, { keep });
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
