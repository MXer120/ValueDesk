/**
 * Replacing the executor's secret files (secrets.ts) without losing anything:
 * the kek, session.key and import.key. Used by tools/rotate-kek.ts and
 * tools/rotate-key.ts, which deploy/server/bin/rotate-secret.sh runs on the
 * server with the executor STOPPED (docs/deploy/SECRETS.md).
 *
 * THE KEK sealed every follower's trading key in executor.db. A new kek is only
 * in force once every sealed record has been opened under the old one and
 * sealed again under the new one - in ONE transaction, checked row by row under
 * the new kek before it commits. The order on disk makes a crash at any point
 * recoverable:
 *
 *   1. executor.db.before-kek-<stamp>   a consistent copy of the database (VACUUM INTO)
 *   2. kek.new                          the new kek (0600, fsync) - nothing uses it yet
 *   3. one transaction                  every row re-sealed, every row opened under kek.new,
 *                                       an audit row; COMMIT
 *   4. kek.old-<stamp>                  a copy of the old kek, kept until the owner deletes it
 *                                       (the older database backups open only with it)
 *   5. kek.new -> kek                   rename (atomic), directory fsync
 *   6. every row opened again under the kek file as it now is on disk
 *
 * A run that finds kek.new left over looks at which kek opens the rows: the new
 * one (the crash came after 3) - it finishes 4-6; the old one (before 3) - it
 * removes kek.new and starts again. Anything else it refuses to touch.
 *
 * Nothing secret is printed, logged or written to the audit log: keys are named
 * by an id (16 hex of SHA-256 over a fixed label and the key), which says which
 * key is which without saying anything about it.
 *
 * The database is opened through ExecutorDb, so its lock file refuses to run
 * next to a live executor (two processes would also break the audit chain:
 * each keeps the last hash in memory).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ExecutorDb, sqlite } from './db.ts';
import { openWith, sealWith } from './secrets.ts';

/** 20261027T101500Z */
export const stampOf = (now: number): string => new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/** A name for a secret that reveals nothing about it. */
export const secretId = (b: Buffer): string => createHash('sha256').update('valuedesk-secret-id\0').update(b).digest('hex').slice(0, 16);

/** A public key's id: SHA-256 of its SPKI DER (public, so plainly). */
const publicId = (pem: string): string =>
  createHash('sha256').update(createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* not on every platform (Windows) */
  }
}

/** Owner only; and, when this runs as root, owned by whoever owns `like` (the database). */
function protect(path: string, like: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not on every file system (Windows) */
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    const s = statSync(like);
    chownSync(path, s.uid, s.gid);
  }
}

/** A new file with exactly these bytes, made exclusively, 0600, on disk before this returns. */
function writeNew(path: string, data: Buffer | string, like: string): void {
  writeFileSync(path, data, { mode: 0o600, flag: 'wx' });
  protect(path, like);
  fsyncFile(path);
}

/** `<path>.old-<stamp>`: a copy of the file as it is (never overwrites one). */
function keepOld(path: string, stamp: string, like: string): string {
  let out = `${path}.old-${stamp}`;
  for (let i = 2; existsSync(out); i++) out = `${path}.old-${stamp}-${i}`;
  copyFileSync(path, out, constants.COPYFILE_EXCL);
  protect(out, like);
  fsyncFile(out);
  return out;
}

export function readKek(path: string): Buffer {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  const b = readFileSync(path);
  if (b.length !== 32) throw new Error(`${path} must hold exactly 32 bytes (it holds ${b.length})`);
  return b;
}

interface KeyRecord {
  owner: string;
  slot: string;
  address: string;
  sealed: string;
}

type Db = InstanceType<ReturnType<typeof sqlite>['DatabaseSync']>;

const keyRows = (db: Db): KeyRecord[] =>
  (db.prepare('SELECT owner, slot, address, sealed FROM keys ORDER BY owner, slot').all() as Array<Record<string, unknown>>).map((r) => ({
    owner: String(r.owner),
    slot: String(r.slot),
    address: String(r.address),
    sealed: String(r.sealed),
  }));

/** Whether a record opens under this kek (the private key is wiped at once). */
function opens(kek: Buffer, network: string, r: KeyRecord): boolean {
  try {
    openWith(kek, network, r.owner, r.address, r.sealed).fill(0);
    return true;
  } catch {
    return false;
  }
}

function paths(dir: string) {
  return { db: join(dir, 'executor.db'), kek: join(dir, 'kek'), next: join(dir, 'kek.new') };
}

export interface KekCheck {
  rows: number;
  failed: Array<{ owner: string; slot: string }>;
  kekId: string;
}

/**
 * Does every sealed key in the database open under the kek file? Read-only: safe next
 * to a running executor. `kekFile` defaults to `<dir>/kek`.
 */
export function checkKek(o: { dir: string; network: string; kekFile?: string }): KekCheck {
  const p = paths(o.dir);
  const kek = readKek(o.kekFile ?? p.kek);
  if (!existsSync(p.db)) throw new Error(`${p.db} does not exist`);
  const db = new (sqlite().DatabaseSync)(p.db, { readOnly: true });
  try {
    const rows = keyRows(db);
    const failed = rows.filter((r) => !opens(kek, o.network, r)).map((r) => ({ owner: r.owner, slot: r.slot }));
    return { rows: rows.length, failed, kekId: secretId(kek) };
  } finally {
    db.close();
  }
}

export interface KekRotation {
  rows: number;
  oldId: string;
  newId: string;
  /** Where the old kek is kept. */
  oldFile: string;
  /** The copy of the database made before anything changed (null: none was made). */
  snapshot: string | null;
  /** A run left unfinished was finished (no new kek was made). */
  resumed: boolean;
}

/**
 * Seal every follower key again under a new kek (random, or `newKek` - e.g. the old one
 * back, from a kek.old-<stamp> file, to undo a rotation), and make it the kek file.
 * The executor must be stopped (the database lock says so).
 */
export function rotateKek(o: { dir: string; network: string; now?: number; newKek?: Buffer; snapshot?: boolean }): KekRotation {
  const now = o.now ?? Date.now();
  const stamp = stampOf(now);
  const p = paths(o.dir);
  if (!existsSync(p.db)) throw new Error(`${p.db} does not exist - nothing to rotate (is this the executor's data directory?)`);
  const oldKek = readKek(p.kek);
  const edb = new ExecutorDb(p.db); // the lock: refuses while an executor runs on this directory
  const db = edb.db;
  try {
    // --- a run that did not finish --------------------------------------------------------
    if (existsSync(p.next)) {
      const cand = readKek(p.next);
      const rows = keyRows(db);
      if (rows.length > 0 && rows.every((r) => opens(cand, o.network, r))) {
        const oldFile = keepOld(p.kek, stamp, p.db);
        renameSync(p.next, p.kek);
        fsyncDir(o.dir);
        verifyOnDisk(p.kek, o.network, db);
        edb.audit('secret', null, 'kek', { action: 'rotate-finished', rows: rows.length, oldId: secretId(oldKek), newId: secretId(cand), oldFile: basename(oldFile) }, now);
        return { rows: rows.length, oldId: secretId(oldKek), newId: secretId(cand), oldFile, snapshot: null, resumed: true };
      }
      if (rows.length === 0 || rows.every((r) => opens(oldKek, o.network, r))) {
        rmSync(p.next, { force: true }); // made before the transaction: never used
      } else {
        throw new Error('kek.new is left from an earlier run and the sealed keys open neither under it nor under kek alone - nothing was changed; look before touching anything (docs/deploy/SECRETS.md)');
      }
    }

    const newKek = o.newKek ? Buffer.from(o.newKek) : randomBytes(32);
    if (newKek.length !== 32) throw new Error('the new kek must be 32 bytes');
    if (newKek.equals(oldKek)) throw new Error('the new kek is the kek in force - nothing to do');

    // Every row must open under the old kek, or nothing is changed.
    const before = keyRows(db);
    const broken = before.filter((r) => !opens(oldKek, o.network, r));
    if (broken.length) {
      throw new Error(
        `${broken.length} of ${before.length} sealed keys do not open under the kek in force (network ${o.network}): ${broken.map((r) => `${r.owner}/${r.slot}`).join(', ')} - nothing was changed. Wrong network (SODEX_NETWORK)?`,
      );
    }

    // 1. a copy of the database as it is
    let snapshot: string | null = null;
    if (o.snapshot !== false) {
      // Two rotations within one second (a fast test machine) get -2, -3, ... as the old keks do.
      snapshot = `${p.db}.before-kek-${stamp}`;
      for (let i = 2; existsSync(snapshot); i++) snapshot = `${p.db}.before-kek-${stamp}-${i}`;
      db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      protect(snapshot, p.db);
    }

    // 2. the new kek, beside the old one; nothing uses it yet
    writeNew(p.next, newKek, p.db);

    // 3. one transaction: re-seal, check under the new kek, audit, commit
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = keyRows(db);
      const upd = db.prepare('UPDATE keys SET sealed = ? WHERE owner = ? AND slot = ? AND sealed = ?');
      for (const r of rows) {
        const pk = openWith(oldKek, o.network, r.owner, r.address, r.sealed);
        try {
          const sealed = sealWith(newKek, o.network, r.owner, r.address, pk);
          const ch = upd.run(sealed, r.owner, r.slot, r.sealed);
          if (Number(ch.changes) !== 1) throw new Error(`the key of ${r.owner}/${r.slot} changed under the rotation`);
        } finally {
          pk.fill(0);
        }
      }
      const after = keyRows(db);
      if (after.length !== rows.length) throw new Error('the number of keys changed under the rotation');
      const bad = after.filter((r) => !opens(newKek, o.network, r) || opens(oldKek, o.network, r));
      if (bad.length) throw new Error(`${bad.length} keys do not open under the new kek after re-sealing: ${bad.map((r) => `${r.owner}/${r.slot}`).join(', ')}`);
      const auditBefore = Number((db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n);
      edb.audit('secret', null, 'kek', { action: 'rotate', rows: rows.length, network: o.network, oldId: secretId(oldKek), newId: secretId(newKek), snapshot: snapshot ? basename(snapshot) : null }, now);
      const auditAfter = Number((db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n);
      if (auditAfter !== auditBefore + 1) throw new Error('the audit row could not be written');
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      rmSync(p.next, { force: true });
      throw e;
    }

    // 4. the old kek kept;  5. the new one in force
    const oldFile = keepOld(p.kek, stamp, p.db);
    renameSync(p.next, p.kek);
    fsyncDir(o.dir);
    // 6. what is on disk now opens every row
    verifyOnDisk(p.kek, o.network, db);
    return { rows: before.length, oldId: secretId(oldKek), newId: secretId(newKek), oldFile, snapshot, resumed: false };
  } finally {
    oldKek.fill(0);
    edb.close();
  }
}

function verifyOnDisk(kekPath: string, network: string, db: Db): void {
  const k = readKek(kekPath);
  try {
    const bad = keyRows(db).filter((r) => !opens(k, network, r));
    if (bad.length) throw new Error(`after the swap ${bad.length} keys do not open under ${kekPath} - put the newest kek.old-* back ONLY if they open under it (rotate-kek.ts check --kek <file>)`);
  } finally {
    k.fill(0);
  }
}

export interface KeyFileRotation {
  file: string;
  oldFile: string | null;
  oldId: string | null;
  newId: string;
}

/**
 * A new session.key (every follower's dashboard token ends: they sign in again) or a
 * new import.key (a key import in flight fails once and is sent again), with an audit
 * row. The old file is kept as <name>.old-<stamp>. The executor must be stopped.
 */
export function rotateKeyFile(o: { dir: string; which: 'session' | 'import'; now?: number }): KeyFileRotation {
  const now = o.now ?? Date.now();
  const stamp = stampOf(now);
  const p = paths(o.dir);
  if (!existsSync(p.db)) throw new Error(`${p.db} does not exist (is this the executor's data directory?)`);
  const name = o.which === 'session' ? 'session.key' : 'import.key';
  const file = join(o.dir, name);
  const next = `${file}.new`;
  const edb = new ExecutorDb(p.db);
  try {
    rmSync(next, { force: true }); // a left-over from a run that stopped before the rename: never used
    let data: Buffer | string;
    let newId: string;
    if (o.which === 'session') {
      const b = randomBytes(32);
      data = b;
      newId = secretId(b);
    } else {
      const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
      data = pem;
      newId = publicId(pem);
    }
    let oldId: string | null = null;
    let oldFile: string | null = null;
    if (existsSync(file)) {
      const cur = readFileSync(file);
      oldId = o.which === 'session' ? secretId(cur) : publicId(cur.toString('utf8'));
      cur.fill(0);
      oldFile = keepOld(file, stamp, p.db);
    }
    writeNew(next, data, p.db);
    if (Buffer.isBuffer(data)) data.fill(0);
    renameSync(next, file);
    fsyncDir(o.dir);
    edb.audit('secret', null, name, { action: 'rotate', oldId, newId, oldFile: oldFile ? basename(oldFile) : null }, now);
    return { file, oldFile, oldId, newId };
  } finally {
    edb.close();
  }
}
