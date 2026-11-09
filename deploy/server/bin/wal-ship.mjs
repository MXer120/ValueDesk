#!/usr/bin/env node
// A copy of the index database that follows the live file by seconds, without ever holding a long read
// transaction on it and without reading the 50 GB live file again once the copy exists.
//
//   node wal-ship.mjs run      --db <live.db> --dir <replica dir> [--rebase]    the daemon (valuescan-walship.service)
//   node wal-ship.mjs snapshot --dir <replica dir> --out <copy.db> [--timeout <s>]
//                                                   ask the daemon for a consistent copy of the REPLICA (backup.sh)
//   node wal-ship.mjs status   --dir <replica dir>  what the daemon last published (status.json)
//
// WHY (2026-11-08). The nightly backup held ONE read transaction for its whole copy: 41 minutes at the unit's 40 MB/s.
// A checkpoint cannot copy past a reader's snapshot, so the WAL grew to 5.5 GB, the indexer starved and the boards went
// 2 h stale; 11 of the 12 worst indexer stalls before that fell inside backups. VACUUM INTO and the byte copy both hold
// one snapshot for the length of a 50 GB copy; SQLite's backup API restarts whenever another connection writes, and the
// indexer writes every few seconds, so on this file it never finishes.
//
// HOW. SQLite already writes every change twice: into the WAL, then (checkpoint) into the file. This daemon reads each
// commit out of the WAL - frames just written, so from the page cache - checks every frame's salt and checksum chain
// the way SQLite's own recovery does, and a writer thread puts the committed pages into the replica (<dir>/replica.db).
//
// THE PINS. Its read transactions on the live file are a rolling chain of short ones: every WALSHIP_POLL_MS (10 ms) a
// new one is taken, the -shm says how many frames are committed at that moment, the WAL is read up to there, and then
// the older one is let go. A pin is what keeps the writer from starting the WAL over frames not read here yet (wal.c: a
// checkpoint never copies past the oldest reader's snapshot, a reader on read-mark 0 blocks every copy, and the WAL is
// only started over once every frame is in the file), so nothing can be lost between two reads, and the indexer's
// PASSIVE checkpoints copy all but the last few milliseconds of WAL as before. The main thread only reads and checks:
// every write, fsync and copy happens on the writer thread, so the disk never holds a pin open.
//
//   - First start, or after a gap it cannot prove complete: ONE base copy of the live file, read in 1 MiB pieces at
//     WALSHIP_BASE_MB_S (25) while the WAL is followed from its first frame. Pages the WAL brings meanwhile are marked
//     and never overwritten by the copy's older bytes, so copy + WAL is one committed instant (the fuzzy copy plus redo
//     log of a PostgreSQL base backup).
//   - Then only the WAL. The live file is not read again.
//   - A snapshot (backup.sh, nightly) is made from the REPLICA the same way, at WALSHIP_SNAP_MB_S (40), while commits
//     keep going into both; it is cut between two commits.
//   - A transaction is held until its commit frame (beyond WALSHIP_SPOOL_MEM_MB in a spool file); one that rolls back
//     is dropped. SQLite may overwrite a frame of an open transaction in place and rewrite the checksums at its commit
//     (walRewriteChecksums): when the -shm says more is committed than checks out, it reads again from the last commit.
//   - A restart of this daemon resumes when the WAL still holds the frame state.json ended on; otherwise (the WAL
//     started over while it was down) a new base copy. The old replica stays until the new one is complete.
//
// SAFETY NETS. A watchdog thread kills the process when the main loop has not come round for WALSHIP_WATCHDOG_MS (2000)
// while a pin is held; a pin that ages past WALSHIP_PIN_STUCK_MS (1000) without the reading getting anywhere is let go
// (and the copy made again). The live database is opened read-only and never written. Page cache: the unit runs this
// under MemoryHigh, so what it reads and writes is reclaimed from its own cgroup, not from the indexer's.
//
// Node 22.13+, no dependencies. Test: wal-ship.test.mjs (a writer and checkpointer like the indexer's, kill -9, restore).
import { DatabaseSync } from 'node:sqlite';
import {
  closeSync, existsSync, fdatasyncSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync,
  readdirSync, renameSync, statSync, statfsSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { open as openAsync, rename as renameAsync } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const num = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
const POLL_MS = num('WALSHIP_POLL_MS', 10);
const MAX_FRAMES = num('WALSHIP_MAX_FRAMES', 512); // per read: 2 MiB of 4 KiB pages
const BASE_MB_S = num('WALSHIP_BASE_MB_S', 25);
const SNAP_MB_S = num('WALSHIP_SNAP_MB_S', 40);
const CHUNK = num('WALSHIP_CHUNK_KB', 1024) * 1024;
const SYNC_MS = num('WALSHIP_SYNC_MS', 5000);
const STATUS_MS = num('WALSHIP_STATUS_MS', 2000);
const SPOOL_MEM = num('WALSHIP_SPOOL_MEM_MB', 64) * 1024 * 1024;
const MAX_OUTSTANDING = num('WALSHIP_MAX_OUTSTANDING_MB', 512) * 1024 * 1024;
const WATCHDOG_MS = num('WALSHIP_WATCHDOG_MS', 2000);
const PIN_STUCK_MS = num('WALSHIP_PIN_STUCK_MS', 1000);
const DEBUG = !!process.env.WALSHIP_DEBUG;

const HOST_LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const WAL_HDR = 32;
const FRAME_HDR = 24;

const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[walship] ${msg}`);
const iso = (t) => (t ? new Date(t).toISOString() : null);
const r1 = (x) => Math.round(x * 10) / 10;

/** SQLite's WAL checksum (wal.c walChecksumBytes), continued from s = [s0, s1]. `be`: the words are big-endian. */
export function walChecksum(buf, off, len, be, s) {
  let s0 = s[0];
  let s1 = s[1];
  if (be !== HOST_LE && ((buf.byteOffset + off) & 3) === 0) {
    const u = new Uint32Array(buf.buffer, buf.byteOffset + off, len >>> 2);
    for (let i = 0; i < u.length; i += 2) {
      s0 = (s0 + u[i] + s1) >>> 0;
      s1 = (s1 + u[i + 1] + s0) >>> 0;
    }
  } else {
    for (let i = off; i < off + len; i += 8) {
      const x0 = be ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
      const x1 = be ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4);
      s0 = (s0 + x0 + s1) >>> 0;
      s1 = (s1 + x1 + s0) >>> 0;
    }
  }
  s[0] = s0;
  s[1] = s1;
  return s;
}

/** Read the whole range, or as much as the file has. */
function readFully(fd, buf, len, pos) {
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, pos + got);
    if (n <= 0) break;
    got += n;
  }
  return got;
}

/** Written whole or not at all, never fsynced: for files nothing depends on after a crash. */
function writeJsonQuick(file, obj) {
  writeFileSync(`${file}.tmp`, JSON.stringify(obj));
  renameSync(`${file}.tmp`, file);
}

/** Durable, off the event loop. */
async function writeJsonDurable(file, obj) {
  const fh = await openAsync(`${file}.tmp`, 'w');
  try {
    await fh.writeFile(JSON.stringify(obj));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await renameAsync(`${file}.tmp`, file);
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

function freeBytes(dir) {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function dbPageSize(file) {
  const b = Buffer.alloc(100);
  const fd = openSync(file, 'r');
  try {
    readFully(fd, b, 100, 0);
  } finally {
    closeSync(fd);
  }
  const p = b.readUInt16BE(16);
  return p === 1 ? 65536 : p;
}

// =====================================================================================================================
// The writer thread: the replica, the copies, the open transactions. Messages are handled in order, one at a time, and a
// copy's chunks run between them - so a page a commit wrote is never overwritten by a copy's older bytes.
// =====================================================================================================================

class PageSet {
  bits = new Uint8Array(1 << 16);
  add(p) {
    const i = p >>> 3;
    if (i >= this.bits.length) {
      const b = new Uint8Array(Math.max(i + 1, this.bits.length * 2));
      b.set(this.bits);
      this.bits = b;
    }
    this.bits[i] |= 1 << (p & 7);
  }
  has(p) {
    const i = p >>> 3;
    return i < this.bits.length && (this.bits[i] & (1 << (p & 7))) !== 0;
  }
  count() {
    let n = 0;
    for (const b of this.bits) for (let x = b; x; x &= x - 1) n++;
    return n;
  }
}

function writerThread({ dir }) {
  let replicaFd = null;
  let replicaPath = null;
  let copy = null; // { kind, fd, set, done, total, startedAt, ps }
  let dbPages = null;
  let applied = null; // { gen, frame, chain }
  let spoolSeq = 0;
  let spoolBytes = 0;
  let cutWaiter = null;
  const txns = new Map(); // id -> { pages: Map(pgno -> Buffer view), bytes, spool: { path, fd, bytes } | null }
  const post = (m) => parentPort.postMessage(m);

  const txnOf = (id) => {
    let t = txns.get(id);
    if (!t) txns.set(id, (t = { pages: new Map(), bytes: 0, spool: null }));
    return t;
  };

  const dropSpool = (sp) => {
    try { closeSync(sp.fd); } catch { /* */ }
    try { unlinkSync(sp.path); } catch { /* */ }
    spoolBytes -= sp.bytes;
  };

  const spill = (t, ps) => {
    if (!t.spool) {
      const path = join(dir, `spool-${process.pid}-${++spoolSeq}.bin`);
      t.spool = { path, fd: openSync(path, 'w+'), bytes: 0 };
    }
    const rec = 4 + ps;
    const out = Buffer.allocUnsafe(t.pages.size * rec);
    let o = 0;
    for (const [pgno, page] of t.pages) {
      out.writeUInt32BE(pgno, o);
      page.copy(out, o + 4);
      o += rec;
    }
    writeSync(t.spool.fd, out, 0, o, t.spool.bytes);
    t.spool.bytes += o;
    spoolBytes += o;
    t.pages = new Map();
    t.bytes = 0;
  };

  /** Pages in page order, neighbours in one write. */
  const writePages = (fd, entries, ps) => {
    entries.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < entries.length;) {
      let j = i + 1;
      while (j < entries.length && entries[j][0] === entries[j - 1][0] + 1) j++;
      const run = j - i === 1 ? entries[i][1] : Buffer.concat(entries.slice(i, j).map((e) => e[1]));
      writeSync(fd, run, 0, run.length, (entries[i][0] - 1) * ps);
      i = j;
    }
  };

  const applyPages = (entries, ps) => {
    if (!entries.length) return;
    if (copy) {
      for (const [pgno] of entries) copy.set.add(pgno);
      writePages(copy.fd, entries, ps);
    }
    if (replicaFd !== null) writePages(replicaFd, entries, ps);
  };

  const commit = (m) => {
    const t = txns.get(m.txn);
    txns.delete(m.txn);
    const ps = m.ps;
    if (t?.spool) {
      const rec = 4 + ps;
      const per = Math.max(1, Math.floor(CHUNK / rec));
      const buf = Buffer.allocUnsafe(per * rec);
      for (let pos = 0; pos < t.spool.bytes; pos += per * rec) {
        const got = readFully(t.spool.fd, buf, Math.min(per * rec, t.spool.bytes - pos), pos);
        const entries = new Map();
        for (let o = 0; o + rec <= got; o += rec) entries.set(buf.readUInt32BE(o), Buffer.from(buf.subarray(o + 4, o + rec)));
        applyPages([...entries], ps);
      }
      dropSpool(t.spool);
    }
    if (t) applyPages([...t.pages], ps);
    dbPages = m.dbPages;
    applied = { gen: m.gen, frame: m.frame, chain: m.chain, at: m.at };
    if (replicaFd !== null && fstatSync(replicaFd).size > dbPages * ps) ftruncateSync(replicaFd, dbPages * ps);
  };

  const pagesOf = (fd, ps) => {
    if (dbPages) return dbPages;
    const b = Buffer.alloc(100);
    readFully(fd, b, 100, 0);
    const n = b.readUInt32BE(28);
    if (n > 0 && b.readUInt32BE(24) === b.readUInt32BE(92)) return n;
    return Math.ceil(fstatSync(fd).size / ps);
  };

  /** Copy src into the new file dst at mbs MB/s; commits keep landing in it. Resolves after the cut (dst closed). */
  const runCopy = async (kind, src, dst, mbs, ps) => {
    const fd = openSync(dst, 'w+');
    const c = { kind, fd, set: new PageSet(), done: 0, total: statSync(src).size, startedAt: now(), ps };
    copy = c; // before the first await: no commit can fall between
    const fh = await openAsync(src, 'r');
    try {
      const chunk = Math.max(ps, CHUNK - (CHUNK % ps));
      const buf = Buffer.allocUnsafeSlow(chunk);
      for (let off = 0; off < c.total; off += chunk) {
        if (copy !== c) throw new Error(`the ${kind} copy was cancelled`);
        let got;
        try {
          ({ bytesRead: got } = await fh.read(buf, 0, Math.min(chunk, c.total - off), off));
        } catch {
          got = 0; // Windows' lock range (SQLite's pending-byte page, never data): left empty
        }
        if (copy !== c) throw new Error(`the ${kind} copy was cancelled`);
        const pages = Math.floor(got / ps);
        const p0 = off / ps + 1;
        for (let i = 0; i < pages;) {
          if (c.set.has(p0 + i)) {
            i++;
            continue;
          }
          let j = i;
          while (j < pages && !c.set.has(p0 + j)) j++;
          writeSync(fd, buf, i * ps, (j - i) * ps, off + i * ps);
          i = j;
        }
        c.done = off + got;
        const ahead = (c.done / (mbs * 1e6)) * 1000 - (now() - c.startedAt);
        if (ahead > 0) await sleep(ahead);
      }
    } finally {
      await fh.close();
    }
    if (kind === 'base') {
      // The live file may hold pages a checkpoint copied from frames this thread has not been handed yet. Ask the main
      // thread for a cut: it answers after posting every frame it has read, and it has read past anything a checkpoint
      // can have copied (the pins), so the messages before the cut make the copy whole.
      await new Promise((res) => {
        cutWaiter = res;
        post({ t: 'copyRead' });
      });
      if (copy !== c) throw new Error(`the ${kind} copy was cancelled`);
    }
    // The cut, synchronous: the copy is the state after the last commit handled.
    copy = null;
    const pages = pagesOf(fd, ps);
    ftruncateSync(fd, pages * ps);
    fdatasyncSync(fd);
    closeSync(fd);
    const s = (now() - c.startedAt) / 1000;
    return { bytes: pages * ps, seconds: r1(s), mbPerS: r1(c.total / 1e6 / s), pagesFromWal: c.set.count(), dbPages: pages, frame: applied?.frame ?? null, generation: applied?.gen ?? null, lastCommitAt: applied?.at ? iso(applied.at) : null, cutAt: iso(now()) };
  };

  const handlers = {
    open(m) {
      replicaPath = m.replicaPath;
      replicaFd = openSync(replicaPath, 'r+');
      dbPages = m.dbPages;
      applied = m.applied;
    },
    pass(m) {
      const buf = Buffer.from(m.buf);
      const ops = m.ops;
      for (let i = 0; i < ops.length; i += 4) {
        const kind = ops[i];
        if (kind === 0) { // frame: txn, pgno, offset
          const t = txnOf(ops[i + 1]);
          const page = buf.subarray(ops[i + 3], ops[i + 3] + m.ps);
          if (!t.pages.has(ops[i + 2])) t.bytes += m.ps;
          t.pages.set(ops[i + 2], page);
          if (t.bytes > SPOOL_MEM) spill(t, m.ps);
        }
      }
      for (const c of m.commits) commit(c);
      post({ t: 'ack', bytes: m.buf.byteLength });
    },
    drop(m) {
      const t = txns.get(m.txn);
      if (t?.spool) dropSpool(t.spool);
      txns.delete(m.txn);
    },
    dropAll() {
      for (const t of txns.values()) if (t.spool) dropSpool(t.spool);
      txns.clear();
    },
    cut() {
      const f = cutWaiter;
      cutWaiter = null;
      f?.();
    },
    base(m) {
      if (copy) { try { closeSync(copy.fd); } catch { /* */ } copy = null; }
      if (replicaFd !== null) { closeSync(replicaFd); replicaFd = null; }
      dbPages = null;
      applied = m.applied; // the WAL's first frame: nothing of it handed over yet
      replicaPath = m.replicaPath;
      const rebasePath = `${m.replicaPath}.rebase`;
      runCopy('base', m.src, rebasePath, m.mbs, m.ps).then((r) => {
        renameSync(rebasePath, m.replicaPath);
        replicaFd = openSync(m.replicaPath, 'r+');
        post({ t: 'baseDone', r, applied, dbPages });
      }, (e) => post({ t: 'error', error: String(e?.stack ?? e) }));
    },
    snapshot(m) {
      if (copy || replicaFd === null) {
        post({ t: 'snapDone', id: m.id, r: { ok: false, error: copy ? 'a copy is already running' : 'no replica yet' } });
        return;
      }
      const partial = `${m.out}.partial`;
      runCopy('snapshot', replicaPath, partial, m.mbs, m.ps).then((r) => {
        renameSync(partial, m.out);
        post({ t: 'snapDone', id: m.id, r: { ok: true, out: m.out, ...r } });
      }, (e) => {
        try { unlinkSync(partial); } catch { /* */ }
        post({ t: 'snapDone', id: m.id, r: { ok: false, error: String(e?.message ?? e) } });
      });
    },
    sync(m) {
      const a = applied;
      if (replicaFd !== null) fdatasyncSync(replicaFd);
      post({ t: 'synced', id: m.id, applied: a, dbPages });
    },
    progress() {
      const c = copy;
      post({ t: 'progress', applied, dbPages, openTxns: txns.size, spoolBytes, copy: c && { kind: c.kind, done: c.done, total: c.total, mbPerS: r1(c.done / 1e6 / Math.max(0.001, (now() - c.startedAt) / 1000)) } });
    },
    stop(m) {
      handlers.sync(m);
      post({ t: 'stopped' });
    },
  };

  parentPort.on('message', (m) => {
    try {
      handlers[m.t](m);
    } catch (e) {
      post({ t: 'error', error: String(e?.stack ?? e) });
    }
  });
}

// =====================================================================================================================
// The main thread: the pins, reading and checking the WAL, the state.
// =====================================================================================================================

/** How long each read transaction on the live file lasted. */
class PinStats {
  count = 0;
  maxMs = 0;
  totalMs = 0;
  buckets = [5, 10, 20, 50, 100, 250, 1000, 2000, Infinity];
  hist = new Array(this.buckets.length).fill(0);
  windowMax = 0;
  windowAt = 0;
  prevWindowMax = 0;
  add(ms) {
    this.count++;
    this.totalMs += ms;
    if (ms > this.maxMs) this.maxMs = ms;
    this.hist[this.buckets.findIndex((b) => ms <= b)]++;
    const t = now();
    if (t - this.windowAt > 60_000) {
      this.prevWindowMax = this.windowMax;
      this.windowMax = 0;
      this.windowAt = t;
    }
    if (ms > this.windowMax) this.windowMax = ms;
  }
  toJSON() {
    const q = (f) => {
      let acc = 0;
      for (let i = 0; i < this.hist.length; i++) {
        acc += this.hist[i];
        if (acc >= f * this.count) return this.buckets[i] === Infinity ? '>2000' : `<=${this.buckets[i]}`;
      }
      return null;
    };
    return {
      count: this.count,
      maxMs: r1(this.maxMs),
      meanMs: this.count ? Math.round((this.totalMs / this.count) * 100) / 100 : 0,
      p99: q(0.99),
      p999: q(0.999),
      lastMinuteMaxMs: r1(Math.max(this.windowMax, this.prevWindowMax)),
      hist: Object.fromEntries(this.buckets.map((b, i) => [b === Infinity ? 'inf' : String(b), this.hist[i]])),
    };
  }
}

class GapError extends Error {}

class Shipper {
  constructor({ db, dir, rebase = false }) {
    this.dbPath = resolve(db);
    this.walPath = `${this.dbPath}-wal`;
    this.shmPath = `${this.dbPath}-shm`;
    this.dir = resolve(dir);
    this.replicaPath = join(this.dir, 'replica.db');
    this.statePath = join(this.dir, 'state.json');
    this.statusPath = join(this.dir, 'status.json');
    this.reqDir = join(this.dir, 'requests');
    this.forceRebase = rebase;

    this.mode = 'starting'; // 'rebase' | 'follow'
    this.gen = null; // { salt1, salt2, seq, be, pageSize }
    this.S = 0; // frames of this generation read up to the last commit
    this.chainS = [0, 0];
    this.readPos = 0; // frames checked, the open transaction's included
    this.chainR = [0, 0];
    this.txnId = 1;
    this.need = null; // the -shm's committed frames when the newer pin was taken
    this.progressAt = now();
    this.walFd = null;
    this.shmFd = null;
    this.pins = new PinStats();
    this.held = [];
    this.conns = [];
    this.outstanding = 0;
    this.worker = null;
    this.workerState = {};
    this.waiting = new Map(); // id -> resolve
    this.reqSeq = 0;
    this.stats = {
      frames: 0, bytes: 0, commits: 0, rebases: 0, resumes: 0, walRestarts: 0, rewinds: 0, stuck: 0, paused: 0,
      startCatchUpMs: null, lastCommitAt: null, lastSyncAt: null, lastBase: null, lastSnapshot: null, errors: 0,
    };
    this.lastSaved = null;
    this.syncing = false;
    this.stopping = false;
    this.snapshotBusy = false;
  }

  // ---------------------------------------------------------------- pins

  openConns() {
    for (let i = 0; i < 2; i++) {
      const c = new DatabaseSync(this.dbPath, { readOnly: true });
      c.exec('PRAGMA busy_timeout = 1000');
      this.conns.push({ c, probe: c.prepare('SELECT count(*) FROM sqlite_master'), busy: false });
    }
  }

  takePin() {
    const k = this.conns.find((x) => !x.busy);
    const t = now();
    k.c.exec('BEGIN');
    k.probe.get(); // the snapshot is taken here
    k.busy = true;
    this.held.push({ k, at: t, took: now() - t, ticks: 0, work: 0 });
    this.pinFlag[0] = 1;
  }

  releaseOldest() {
    const pin = this.held.shift();
    pin.k.c.exec('COMMIT');
    pin.k.busy = false;
    const ms = now() - pin.at;
    this.pins.add(ms);
    if (DEBUG && ms > 45) log(`long pin ${ms.toFixed(0)} ms: begin ${pin.took.toFixed(1)} ms, ${pin.ticks} ticks, ${pin.work.toFixed(1)} ms in them, mode ${this.mode}, copy ${this.workerState.copy?.kind ?? '-'}, gaps ${pin.gaps?.map((g) => g.toFixed(0)).join(',')}, works ${pin.works?.map((g) => g.toFixed(0)).join(',')}`);
    if (!this.held.length) this.pinFlag[0] = 0;
  }

  releaseAll() {
    while (this.held.length) {
      try {
        this.releaseOldest();
      } catch {
        this.held.shift();
      }
    }
    this.pinFlag[0] = 0;
  }

  // ---------------------------------------------------------------- the WAL and the -shm

  walHeader() {
    if (this.walFd === null) {
      if (!existsSync(this.walPath)) return null;
      this.walFd = openSync(this.walPath, 'r');
    }
    const b = Buffer.alloc(WAL_HDR);
    if (readFully(this.walFd, b, WAL_HDR, 0) < WAL_HDR) return null;
    const magic = b.readUInt32BE(0);
    if (magic !== 0x377f0682 && magic !== 0x377f0683) return null;
    const be = (magic & 1) === 1;
    const ck = walChecksum(b, 0, 24, be, [0, 0]);
    if (ck[0] !== b.readUInt32BE(24) || ck[1] !== b.readUInt32BE(28)) return null; // being rewritten
    return { be, pageSize: b.readUInt32BE(8), seq: b.readUInt32BE(12), salt1: b.readUInt32BE(16), salt2: b.readUInt32BE(20), ck };
  }

  /**
   * The wal-index header in the -shm (wal.c WalIndexHdr, host byte order, written twice): how many frames of which
   * generation are COMMITTED. null when it cannot be read whole.
   */
  shmHeader() {
    if (this.shmFd === null) {
      if (!existsSync(this.shmPath)) return null;
      this.shmFd = openSync(this.shmPath, 'r');
    }
    const b = this.shmBuf ?? (this.shmBuf = Buffer.alloc(96));
    for (let tries = 0; tries < 8; tries++) {
      if (readFully(this.shmFd, b, 96, 0) < 96) return null;
      if (b.compare(b, 0, 48, 48, 96) !== 0 || b[12] !== 1) continue; // being written
      const ck = walChecksum(b, 0, 40, !HOST_LE, [0, 0]);
      const u32 = (o) => (HOST_LE ? b.readUInt32LE(o) : b.readUInt32BE(o));
      if (ck[0] !== u32(40) || ck[1] !== u32(44)) continue;
      // The salts are the WAL header's bytes, copied as they are (big-endian).
      return { mxFrame: u32(16), salt1: b.readUInt32BE(32), salt2: b.readUInt32BE(36) };
    }
    return null;
  }

  adopt(h) {
    this.gen = { salt1: h.salt1, salt2: h.salt2, seq: h.seq, be: h.be, pageSize: h.pageSize };
    this.S = 0;
    this.chainS = [h.ck[0], h.ck[1]];
    this.dropTxn();
  }

  /** Forget what was read of the open transaction: back to the last commit frame. */
  dropTxn() {
    if (this.readPos !== this.S || this.txnTouched) {
      this.worker.postMessage({ t: 'drop', txn: this.txnId });
      this.txnId++;
    }
    this.txnTouched = false;
    this.readPos = this.S;
    this.chainR = [this.chainS[0], this.chainS[1]];
  }

  /**
   * The WAL started over. Frames of the old generation past the last commit read here that are still in the file (the
   * new one overwrites from its first frame on) must not hold a commit: that would be a commit never read, which the
   * pins exclude. A check that it holds, not a mechanism.
   */
  checkOldTail() {
    const ps = this.gen.pageSize;
    const fs = FRAME_HDR + ps;
    const b = Buffer.allocUnsafe(fs);
    const ck = [this.chainS[0], this.chainS[1]];
    for (let f = this.S; ; f++) {
      if (readFully(this.walFd, b, fs, WAL_HDR + f * fs) < fs) return;
      if (b.readUInt32BE(8) !== this.gen.salt1 || b.readUInt32BE(12) !== this.gen.salt2) return;
      walChecksum(b, 0, 8, this.gen.be, ck);
      walChecksum(b, FRAME_HDR, ps, this.gen.be, ck);
      if (ck[0] !== b.readUInt32BE(16) || ck[1] !== b.readUInt32BE(20)) return;
      if (b.readUInt32BE(4)) throw new GapError(`the WAL started over with a commit at frame ${f + 1} never read`);
    }
  }

  /** Has every frame committed when the newer pin was taken (this.need) been read? Then the older pin may go. */
  readEnough(r) {
    const n = this.need;
    if (!n) return r.ended && !r.rewound; // no -shm to ask (never on the servers): the end of the valid frames
    if (n.mxFrame === 0) return true; // a generation with nothing committed: the one before is in the file and read
    if (!this.gen) return false;
    if (n.salt1 === this.gen.salt1 && n.salt2 === this.gen.salt2) return this.S >= n.mxFrame;
    return this.gen.salt1 === ((n.salt1 + 1) >>> 0); // reading a newer generation already
  }

  /**
   * Check frames after readPos and hand them to the writer thread with every commit. { ended } is true when the read ran
   * out of valid frames, false when it stopped at MAX_FRAMES; { rewound } when what was read of an open transaction was
   * stale and the next pass reads again from the last commit.
   *
   * A frame that does not check out is not always the end. SQLite overwrites a page's frame in place when the same
   * transaction writes the page again (after its frames spilled into the WAL), and at the commit rewrites the checksums
   * from that frame on (wal.c walRewriteChecksums); a transaction that rolled back leaves frames that the next one
   * overwrites. So when the -shm says more frames are committed than read, read again from the last commit.
   */
  pass() {
    if (this.outstanding > MAX_OUTSTANDING) {
      this.stats.paused++;
      return { ended: true }; // the writer thread is behind
    }
    const h = this.walHeader();
    if (!h) return { ended: true };
    if (!this.gen) this.adopt(h);
    else if (h.salt1 !== this.gen.salt1 || h.salt2 !== this.gen.salt2) {
      // The writer started the WAL over. The pins make that possible only once every committed frame of the old
      // generation was read (the header comment); frames past the last commit were a rolled-back transaction's.
      if (h.seq !== ((this.gen.seq + 1) >>> 0) || h.pageSize !== this.gen.pageSize) {
        throw new GapError(`the WAL started over unseen (checkpoint sequence ${this.gen.seq} -> ${h.seq})`);
      }
      this.checkOldTail();
      this.stats.walRestarts++;
      this.adopt(h);
    }
    const ps = this.gen.pageSize;
    const fs = FRAME_HDR + ps;
    if (!this.readBuf || this.readBuf.length !== MAX_FRAMES * fs) this.readBuf = Buffer.allocUnsafeSlow(MAX_FRAMES * fs);
    const buf = this.readBuf;
    const n = Math.floor(readFully(this.walFd, buf, buf.length, WAL_HDR + this.readPos * fs) / fs);
    const be = this.gen.be;
    const ops = [];
    const commits = [];
    let bad = false;
    const before = this.readPos;
    for (let i = 0; i < n; i++) {
      const o = i * fs;
      const pgno = buf.readUInt32BE(o);
      const commit = buf.readUInt32BE(o + 4);
      if (pgno === 0 || buf.readUInt32BE(o + 8) !== this.gen.salt1 || buf.readUInt32BE(o + 12) !== this.gen.salt2) {
        bad = true;
        break;
      }
      const ck = [this.chainR[0], this.chainR[1]];
      walChecksum(buf, o, 8, be, ck);
      walChecksum(buf, o + FRAME_HDR, ps, be, ck);
      if (ck[0] !== buf.readUInt32BE(o + 16) || ck[1] !== buf.readUInt32BE(o + 20)) {
        bad = true;
        break;
      }
      this.chainR = ck;
      this.readPos++;
      this.stats.frames++;
      this.stats.bytes += ps;
      ops.push(0, this.txnId, pgno, o + FRAME_HDR);
      this.txnTouched = true;
      if (commit) {
        this.S = this.readPos;
        this.chainS = [ck[0], ck[1]];
        commits.push({ txn: this.txnId, ps, dbPages: commit, gen: this.gen, frame: this.S, chain: [ck[0], ck[1]], at: now() });
        this.txnId++;
        this.txnTouched = false;
        this.stats.commits++;
        this.stats.lastCommitAt = now();
      }
    }
    if (ops.length) {
      // Only the frames that checked out, in a buffer of their own, handed over without another copy.
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + (this.readPos - before) * fs);
      this.outstanding += ab.byteLength;
      this.worker.postMessage({ t: 'pass', buf: ab, ps, ops, commits }, [ab]);
    }
    if (this.readPos !== before) this.progressAt = now();
    if (bad || n < MAX_FRAMES) {
      const s = this.shmHeader();
      if (s && s.salt1 === this.gen.salt1 && s.salt2 === this.gen.salt2 && s.mxFrame > this.S) {
        // Committed frames past what checks out: what was read of the open transaction is stale.
        if (this.readPos > this.S) this.stats.rewinds++;
        this.dropTxn();
        return { ended: false, rewound: true };
      }
      return { ended: true };
    }
    return { ended: false };
  }

  // ---------------------------------------------------------------- the writer thread

  startWorker() {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { role: 'writer', dir: this.dir } });
    this.worker = w;
    w.on('message', (m) => {
      if (m.t === 'ack') this.outstanding -= m.bytes;
      else if (m.t === 'progress') this.workerState = m;
      else if (m.t === 'error') this.fatal(new Error(`writer thread: ${m.error}`));
      else if (m.t === 'baseDone') this.onBaseDone(m);
      else if (m.t === 'copyRead') this.worker.postMessage({ t: 'cut' }); // after every pass posted so far
      else {
        const k = m.id ?? m.t;
        const f = this.waiting.get(k);
        if (f) {
          this.waiting.delete(k);
          f(m);
        }
      }
    });
    w.on('error', (e) => this.fatal(e));
    w.on('exit', (code) => { if (!this.stopping) this.fatal(new Error(`the writer thread ended (${code})`)); });
  }

  ask(msg) {
    const id = msg.id ?? `${msg.t}-${++this.reqSeq}`;
    return new Promise((res) => {
      this.waiting.set(msg.t === 'stop' ? 'stopped' : id, res);
      this.worker.postMessage({ ...msg, id });
    });
  }

  // ---------------------------------------------------------------- base copy, snapshots, state

  /** Throw away what was read; read the WAL from its first frame and copy the live file again. */
  startRebase(reason) {
    this.mode = 'rebase';
    this.stats.rebases++;
    const need = statSync(this.dbPath).size;
    const free = freeBytes(this.dir);
    if (free !== null && free < need * 1.1) {
      const old = existsSync(this.replicaPath) ? statSync(this.replicaPath).size : 0;
      throw new Error(`not enough room in ${this.dir} for a base copy of ${Math.round(need / 1e6)} MB (free ${Math.round(free / 1e6)} MB${old ? `; the old replica, ${Math.round(old / 1e6)} MB, is kept until a new one is complete` : ''})`);
    }
    log(`base copy of ${this.dbPath} (${Math.round(need / 1e6)} MB) at ${BASE_MB_S} MB/s: ${reason}`);
    this.worker.postMessage({ t: 'dropAll' });
    this.gen = null;
    this.S = 0;
    this.readPos = 0;
    this.txnTouched = false;
    this.txnId++;
    const h = this.walHeader();
    if (h) this.adopt(h);
    this.baseReason = reason;
    this.baseStarted = now();
    // Before any frame of the new reading: every one of them lands in the copy.
    // No WAL at all (the last writer closed and SQLite deleted it): the file is the whole database; the WAL that comes
    // next is read from its first frame. That position cannot be resumed from (generation null): a restart copies again.
    const applied = this.gen ? { gen: this.gen, frame: 0, chain: [...this.chainS] } : { gen: null, frame: 0, chain: null };
    this.worker.postMessage({ t: 'base', src: this.dbPath, replicaPath: this.replicaPath, mbs: BASE_MB_S, ps: this.gen?.pageSize ?? dbPageSize(this.dbPath), applied });
    writeJsonQuick(this.statePath, { ...(readJson(this.statePath) ?? {}), rebaseStarted: iso(now()), rebaseReason: reason });
  }

  onBaseDone(m) {
    this.mode = 'follow';
    this.stats.lastBase = { at: iso(now()), reason: this.baseReason, ...m.r };
    log(`base copy done: ${Math.round(m.r.bytes / 1e6)} MB in ${m.r.seconds} s (${m.r.pagesFromWal} pages from the WAL meanwhile); following the WAL`);
    this.lastSaved = null;
    this.syncState().catch((e) => this.fatal(e));
  }

  /** fdatasync the replica (writer thread), then record how far it is: a restart resumes there if the WAL still has it. */
  async syncState() {
    if (this.syncing || this.mode !== 'follow') return;
    this.syncing = true;
    try {
      const r = await this.ask({ t: 'sync' });
      const a = r.applied;
      if (!a?.gen || this.mode !== 'follow') return;
      const key = `${a.gen.salt1}:${a.gen.salt2}:${a.frame}`;
      if (key === this.lastSaved) return;
      await writeJsonDurable(this.statePath, { mode: 'follow', generation: a.gen, frame: a.frame, chain: a.chain, dbPages: r.dbPages, at: iso(now()) });
      this.lastSaved = key;
      this.stats.lastSyncAt = now();
    } finally {
      this.syncing = false;
    }
  }

  /** null when the replica and the WAL line up (same generation, the saved frame there with its checksum); else why not. */
  tryResume() {
    if (this.forceRebase) return 'asked for (--rebase)';
    const st = readJson(this.statePath);
    if (!st || st.mode !== 'follow' || st.rebaseStarted) return st?.rebaseStarted ? 'the last base copy did not finish' : 'no complete replica yet';
    if (!existsSync(this.replicaPath)) return 'the replica file is missing';
    const h = this.walHeader();
    if (!h) return 'there is no WAL to resume from';
    const g = st.generation;
    if (h.salt1 !== g.salt1 || h.salt2 !== g.salt2) return 'the WAL started over while the shipper was not running';
    if (st.frame > 0) {
      const b = Buffer.alloc(FRAME_HDR);
      if (readFully(this.walFd, b, FRAME_HDR, WAL_HDR + (st.frame - 1) * (FRAME_HDR + g.pageSize)) < FRAME_HDR
        || b.readUInt32BE(16) !== st.chain[0] || b.readUInt32BE(20) !== st.chain[1]) {
        return `frame ${st.frame} of the WAL is not the one the replica ended on`;
      }
    } else if (st.chain[0] !== h.ck[0] || st.chain[1] !== h.ck[1]) return 'the WAL header changed';
    this.gen = { ...g };
    this.S = st.frame;
    this.chainS = [...st.chain];
    this.readPos = this.S;
    this.chainR = [...st.chain];
    this.worker.postMessage({ t: 'open', replicaPath: this.replicaPath, dbPages: st.dbPages, applied: { gen: g, frame: st.frame, chain: st.chain } });
    this.mode = 'follow';
    this.stats.resumes++;
    this.lastSaved = `${g.salt1}:${g.salt2}:${st.frame}`;
    log(`resumed at frame ${st.frame} of WAL generation ${g.seq}`);
    return null;
  }

  async serveRequests() {
    if (this.snapshotBusy || this.mode !== 'follow') return;
    let names;
    try {
      names = readdirSync(this.reqDir).filter((f) => /^snapshot-[\w.-]+\.json$/.test(f) && !f.endsWith('.done.json'));
    } catch {
      return;
    }
    const name = names.sort()[0];
    if (!name) return;
    const file = join(this.reqDir, name);
    const req = readJson(file);
    unlinkSync(file);
    const done = join(this.reqDir, name.replace(/\.json$/, '.done.json'));
    this.snapshotBusy = true;
    try {
      if (!req?.out) throw new Error('the request names no output file');
      const out = resolve(req.out);
      log(`snapshot to ${out} at ${SNAP_MB_S} MB/s`);
      const m = await this.ask({ t: 'snapshot', out, mbs: SNAP_MB_S, ps: this.gen?.pageSize ?? dbPageSize(this.dbPath) });
      if (m.r.ok) this.stats.lastSnapshot = { at: iso(now()), seconds: m.r.seconds, bytes: m.r.bytes, mbPerS: m.r.mbPerS };
      else this.stats.errors++;
      writeJsonQuick(done, m.r);
    } catch (e) {
      this.stats.errors++;
      writeJsonQuick(done, { ok: false, error: String(e?.message ?? e) });
    } finally {
      this.snapshotBusy = false;
    }
  }

  writeStatus() {
    let walBytes = null;
    try { walBytes = statSync(this.walPath).size; } catch { /* */ }
    const w = this.workerState;
    writeJsonQuick(this.statusPath, {
      at: iso(now()),
      pid: process.pid,
      mode: this.mode,
      db: this.dbPath,
      generation: this.gen,
      frame: this.S,
      appliedFrame: w.applied?.frame ?? null,
      openTxnFrames: this.readPos - this.S,
      outstandingBytes: this.outstanding,
      dbPages: w.dbPages ?? null,
      walBytes,
      spoolBytes: w.spoolBytes ?? 0,
      lastSyncAgoS: this.stats.lastSyncAt ? r1((now() - this.stats.lastSyncAt) / 1000) : null,
      pins: this.pins.toJSON(),
      copy: w.copy ?? null,
      ...this.stats,
      lastCommitAt: iso(this.stats.lastCommitAt),
      lastSyncAt: iso(this.stats.lastSyncAt),
      settings: { POLL_MS, MAX_FRAMES, BASE_MB_S, SNAP_MB_S, CHUNK, SYNC_MS, SPOOL_MEM, WATCHDOG_MS, PIN_STUCK_MS },
    });
  }

  // ---------------------------------------------------------------- the loop

  startWatchdog() {
    this.beat = new Float64Array(new SharedArrayBuffer(8));
    this.pinFlag = new Int32Array(new SharedArrayBuffer(4));
    this.beat[0] = now();
    const code = `
      const { workerData } = require('node:worker_threads');
      const { beat, pinFlag, ms, pid } = workerData;
      setInterval(() => {
        const age = performance.timeOrigin + performance.now() - beat[0];
        if (pinFlag[0] && age > ms) {
          process.stderr.write('[walship] watchdog: the main loop has not come round for ' + Math.round(age) + ' ms while a read transaction is open - ending the process so SQLite lets go of it\\n');
          process.kill(pid, 'SIGKILL');
        }
      }, Math.max(20, Math.min(250, ms / 4)));
    `;
    new Worker(code, { eval: true, workerData: { beat: this.beat, pinFlag: this.pinFlag, ms: WATCHDOG_MS, pid: process.pid } }).unref();
  }

  fatal(e) {
    try { this.releaseAll(); } catch { /* */ }
    console.error(`[walship] error: ${e?.stack ?? e}`);
    try { this.writeStatus(); } catch { /* */ }
    process.exit(1);
  }

  async run() {
    mkdirSync(this.reqDir, { recursive: true });
    for (const f of readdirSync(this.dir)) if (/^spool-\d+-\d+\.bin$/.test(f)) unlinkSync(join(this.dir, f)); // our own, from a process that ended
    this.startWatchdog();
    this.startWorker();
    this.openConns();
    this.dbIno = statSync(this.dbPath).ino;
    // The first pin before anything is read: from here no frame can be lost.
    this.takePin();
    let gap = this.tryResume();
    const t0 = now();
    let releasedOnce = false;
    let lastStatus = 0;
    let lastSync = now();
    let lastProgress = 0;
    const loop = () => {
      if (this.stopping) return;
      const tickAt = now();
      if (DEBUG && this.held[0]) (this.held[0].gaps ??= []).push(tickAt - (this.lastTickEnd ?? tickAt));
      this.beat[0] = tickAt;
      if (gap) {
        const reason = gap;
        gap = null;
        this.startRebase(reason);
      }
      let r;
      try {
        if (this.held.length === 1) {
          this.takePin();
          this.need = this.shmHeader();
        }
        r = this.pass();
        if (this.held.length === 2) {
          if (this.readEnough(r)) {
            // Everything committed before the newer pin was taken is read: the older one may go.
            this.releaseOldest();
            if (!releasedOnce) {
              releasedOnce = true;
              this.stats.startCatchUpMs = Math.round(now() - t0);
            }
          } else if (now() - this.held[0].at > PIN_STUCK_MS && now() - this.progressAt > PIN_STUCK_MS / 2) {
            // No headway while a pin ages: let go rather than hold the indexer up, and copy the file again.
            this.stats.stuck++;
            throw new GapError(`no headway reading the WAL for ${Math.round(now() - this.progressAt)} ms (read ${this.S}, committed ${this.need?.mxFrame}, writer thread ${Math.round(this.outstanding / 1e6)} MB behind)`);
          }
        }
      } catch (e) {
        if (!(e instanceof GapError)) throw e;
        log(e.message);
        if (this.mode === 'rebase') throw e; // a gap during the base copy: the process starts again (systemd)
        this.releaseAll();
        this.takePin();
        gap = e.message;
        r = { ended: false };
      }
      const t = now();
      if (t - lastSync > SYNC_MS) {
        lastSync = t;
        this.syncState().catch((e) => this.fatal(e));
      }
      if (t - lastProgress > Math.min(500, STATUS_MS / 2)) {
        lastProgress = t;
        this.worker.postMessage({ t: 'progress' });
      }
      if (t - lastStatus > STATUS_MS) {
        lastStatus = t;
        // A restore puts another file in the database's place: these connections would follow the old one. Start over.
        let ino = null;
        try { ino = statSync(this.dbPath).ino; } catch { /* moved aside, the new one not there yet */ }
        if (ino !== this.dbIno) throw new Error(`${this.dbPath} was replaced (a restore?): ending, to start again on the new file`);
        try {
          this.writeStatus();
        } catch { /* a reader holds the file open (Windows); the next round writes it */ }
        this.serveRequests().catch((e) => this.fatal(e));
      }
      for (const p of this.held) {
        p.ticks++;
        p.work += now() - tickAt;
        if (DEBUG) (p.works ??= []).push(now() - tickAt);
      }
      this.lastTickEnd = now();
      if (r.ended) setTimeout(loopSafe, POLL_MS);
      else setImmediate(loopSafe);
    };
    const loopSafe = () => {
      try {
        loop();
      } catch (e) {
        this.fatal(e);
      }
    };
    const stop = async () => {
      if (this.stopping) return;
      this.stopping = true;
      this.releaseAll();
      log('stopping');
      try {
        const m = await this.ask({ t: 'stop' });
        void m;
        if (this.mode === 'follow') {
          this.lastSaved = null;
          const r = await new Promise((res) => {
            this.waiting.set('final', res);
            this.worker.postMessage({ t: 'sync', id: 'final' });
          });
          if (r.applied) await writeJsonDurable(this.statePath, { mode: 'follow', generation: r.applied.gen, frame: r.applied.frame, chain: r.applied.chain, dbPages: r.dbPages, at: iso(now()) });
        }
        this.writeStatus();
      } catch { /* */ }
      process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    loopSafe();
  }
}

// =====================================================================================================================
// The CLI
// =====================================================================================================================

function arg(args, name, def) {
  const i = args.indexOf(name);
  return i < 0 ? def : args[i + 1];
}

function fail(msg) {
  console.error(`wal-ship: ${msg}`);
  process.exit(1);
}

async function cliSnapshot(args) {
  const dir = resolve(arg(args, '--dir') ?? fail('--dir is required'));
  const out = resolve(arg(args, '--out') ?? fail('--out is required'));
  const timeout = Number(arg(args, '--timeout', '14400')) * 1000;
  if (existsSync(out)) fail(`${out} already exists - a snapshot never overwrites`);
  const fresh = () => {
    const st = readJson(join(dir, 'status.json'));
    return st && Date.now() - Date.parse(st.at) < 30_000 ? st : null;
  };
  const st0 = fresh();
  if (!st0) fail(`the WAL shipper has published no fresh status in ${dir} - is valuescan-walship.service running? (systemctl status valuescan-walship)`);
  if (st0.mode !== 'follow') console.error(`[walship] the shipper is in mode '${st0.mode}'; the snapshot waits for its base copy to finish`);
  const id = `${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}`;
  mkdirSync(join(dir, 'requests'), { recursive: true });
  writeJsonQuick(join(dir, 'requests', `snapshot-${id}.json`), { out, at: new Date().toISOString() });
  const doneFile = join(dir, 'requests', `snapshot-${id}.done.json`);
  const t0 = Date.now();
  let lastNote = Date.now();
  for (;;) {
    const done = readJson(doneFile);
    if (done) {
      unlinkSync(doneFile);
      if (!done.ok) fail(`snapshot failed: ${done.error}`);
      // The copy says WAL in its header: make it one plain file, as the backups always were.
      const db = new DatabaseSync(out);
      try {
        db.exec('PRAGMA journal_mode = DELETE');
      } finally {
        db.close();
      }
      console.log(JSON.stringify(done));
      return;
    }
    if (Date.now() - t0 > timeout) fail(`no snapshot after ${timeout / 1000} s (request ${id})`);
    const st = fresh();
    if (!st) fail('the WAL shipper stopped publishing its status while the snapshot was made');
    if (Date.now() - lastNote > 60_000) {
      lastNote = Date.now();
      if (st.copy) console.error(`[walship] ${st.copy.kind}: ${Math.round(st.copy.done / 1e6)} of ${Math.round(st.copy.total / 1e6)} MB`);
    }
    await sleep(500);
  }
}

if (!isMainThread && workerData?.role === 'writer') {
  writerThread(workerData);
} else if (isMainThread && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'run') {
    const db = arg(args, '--db') ?? fail('--db is required');
    const dir = arg(args, '--dir') ?? fail('--dir is required');
    if (!existsSync(db)) fail(`${db} does not exist`);
    mkdirSync(dir, { recursive: true });
    new Shipper({ db, dir, rebase: args.includes('--rebase') }).run().catch((e) => fail(e?.stack ?? e));
  } else if (cmd === 'snapshot') {
    cliSnapshot(args).catch((e) => fail(e?.stack ?? e));
  } else if (cmd === 'status') {
    const s = readJson(join(resolve(arg(args, '--dir') ?? fail('--dir is required')), 'status.json'));
    if (!s) fail('no status yet');
    console.log(JSON.stringify(s, null, 2));
  } else {
    fail('usage: wal-ship.mjs run --db <live.db> --dir <dir> [--rebase] | snapshot --dir <dir> --out <copy.db> [--timeout <s>] | status --dir <dir>');
  }
}
