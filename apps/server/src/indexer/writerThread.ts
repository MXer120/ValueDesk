/**
 * The index's bulk writes on a thread of their own (2026-11-09).
 *
 * The indexer's one thread was 99.7% busy on production on 2026-11-08 (V8 profile: idle 0.3%), and 40-66% of it was the
 * fills' INSERT ... ON CONFLICT (store.putFills). That evening the flush backlog reached 883,699 rows, the boards were not
 * rebuilt for 87 minutes and a liquidation-history step took 54 minutes. The rows went in 50 to a transaction only so the
 * shared thread was never held long, and a 50-row transaction cost 1-8 ms a row there, against ~0.1 ms a row for 2,000 rows
 * in key order (p50 198 ms a transaction, measured 2026-11-05).
 *
 * Here a worker with its own write connection to the same file runs those writes as pure SQL, in transactions as long as
 * TARGET_MS allows (MAX_ROWS at most), and answers each part of an op once it is committed. Everything JavaScript keeps
 * about the rows (versions, day versions, dirty days, the retention's state) stays with the store on the indexer's thread:
 * it filters the rows as putFills always did, sends what is left, and on each answer does for the rows that changed what
 * putFills did in its transaction. The one thing that must be durable with a fill, its `fill_dirty` mark, the thread writes
 * in the fill's own transaction (the store says per row whether one is due).
 *
 * Two connections share the one write lock. The store counts its own writes in `ctl[WANT]` around each one; the thread
 * commits as soon as it sees one waiting and starts no transaction while one is, so a write of the indexer's thread waits
 * for one row and a commit, not for a transaction (writeBench.ts measures it).
 *
 * Each transaction also writes `meta.writer_done` = `<op>:<rows done>`: after the thread dies, or at a stop with the store
 * holding the write lock, that row says exactly which rows are in the file, so none is written twice or lost. Should the
 * thread die or hang, the store writes what is left itself and goes on writing inline until a new thread is up a minute
 * later (as checkpointer.ts does for the checkpoints). VALUESCAN_WRITER_THREAD=0, and the tests unless they ask for it,
 * keep every write inline as before.
 */
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';

/** The fills' upsert: a REST row replaces a stream row with the same id, a stream row never downgrades a REST row. */
export const FILL_UPSERT = `INSERT INTO fills (venue, address, id, t, symbol, side, px, sz, fee, closed_pnl, oid, src)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue, address, id) DO UPDATE SET
         t = excluded.t, symbol = excluded.symbol, side = excluded.side, px = excluded.px, sz = excluded.sz,
         fee = excluded.fee, closed_pnl = excluded.closed_pnl, oid = excluded.oid, src = excluded.src
       WHERE excluded.src > fills.src OR (excluded.src = fills.src AND (
         excluded.t IS NOT fills.t OR excluded.symbol IS NOT fills.symbol OR excluded.side IS NOT fills.side OR
         excluded.px IS NOT fills.px OR excluded.sz IS NOT fills.sz OR excluded.fee IS NOT fills.fee OR
         excluded.closed_pnl IS NOT fills.closed_pnl OR excluded.oid IS NOT fills.oid))`;
export const DIRTY_INSERT = 'INSERT OR IGNORE INTO fill_dirty (venue, address, day) VALUES (?, ?, ?)';
export const ACTIVITY_HOUR = `INSERT INTO activity_hour (venue, acct, hour, trades, volume) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (venue, hour, acct) DO UPDATE SET trades = trades + excluded.trades, volume = volume + excluded.volume`;
export const ACTIVITY_DAY = `INSERT INTO activity_day (venue, acct, day, trades, volume) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (venue, day, acct) DO UPDATE SET trades = trades + excluded.trades, volume = volume + excluded.volume`;
export const LIQ_ADDR_INSERT = 'INSERT INTO liq_addr (address) VALUES (?) ON CONFLICT (address) DO UPDATE SET address = excluded.address RETURNING id';
export const LIQ_LOG_INSERT = `INSERT OR REPLACE INTO liq_log (aid, coin, venue, t, side, liq, usd, sym, sz, entry, mark, iso, lev, eq, cash, read_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
export const LIQ_CUR_INSERT = 'INSERT OR REPLACE INTO liq_cur (aid, coin, venue, side, liq, usd, t) VALUES (?, ?, ?, ?, ?, ?, ?)';
export const LIQ_CUR_DELETE = 'DELETE FROM liq_cur WHERE aid = ? AND coin = ? AND venue = ?';
export const WRITER_DONE_META = 'writer_done';

/** Slots of the shared control array. */
export const CTL_WANT = 0;
const CTL_STOP = 1;
const CTL_PARKED = 2;

/**
 * How long one transaction may run. 2,000 rows in key order were p50 198 ms on production (2026-11-05); longer only makes
 * the indexer's thread wait longer when it does not say it is waiting (a statement that bypasses the count).
 */
export const TARGET_MS = 150;
export const MAX_ROWS = 5_000;
/** The thread lets the store's writes go first for this long at most, then takes its turn. */
const MAX_YIELD_MS = 2_000;
/** Pending ops and no answer for this long: hung (a transaction is at most TARGET_MS of rows; a slow disk can stretch it). */
const HUNG_MS = 120_000;
const RESTART_AFTER_MS = 60_000;
/** A dead thread's backlog up to this many rows is written on the indexer's thread; more goes to a new thread at once. */
export const INLINE_MAX_ROWS = 20_000;

export interface FillWire {
  venue: string; address: string; id: string; t: number; symbol: string; side: number; px: number; sz: number;
  fee: number | null; closedPnl: number | null; oid: string | null; src: number;
}
export interface ActivityWire { venue: string; acct: string; hour: number; trades: number; volume: number }
/** [aid (an address for a new one), coin, venue, side, liq, usd, sym, sz, entry, mark, iso, lev, eq, cash, readAt]. */
export type LiqChangedWire = [number | string, string, number, number, number, number, string | null, number | null, number | null, number | null, number | null, number | null, number | null, number | null, number | null];
/** [aid, coin, venue, mark]. */
export type LiqClosedWire = [number, string, number, number | null];

export type WriterOp =
  /** `due[i]` = 1: row i's day takes a `fill_dirty` mark if the row changes. `spillId`: a spilled part, left in one transaction with its rows. */
  | { kind: 'fills'; rows: FillWire[]; due: Uint8Array; spillId?: number; prio?: boolean }
  | { kind: 'activity'; rows: ActivityWire[]; spillId?: number }
  | { kind: 'liqLog'; t: number; newAddrs: string[]; changed: LiqChangedWire[]; closed: LiqClosedWire[] };

/** A wallet read's rows: written ahead of the stream rows, and named in meta.writer_done never (see the thread's queue). */
export const isPrio = (op: WriterOp): boolean => op.kind === 'fills' && op.prio === true;

export interface WriterAnswer {
  /** liqLog: the ids given to its new addresses. */
  ids?: Array<[string, number]>;
}

/** An op sent and not answered in full. `done`: its rows [0, done) are committed and handed to `hooks.rows`. */
export interface WriterPending<X = unknown> {
  seq: number;
  op: WriterOp;
  n: number;
  done: number;
  /** The store's own about the op (what to spill, what to release). */
  extra: X;
  /** A wallet read's op handed to a new thread after a death: its answers' `changed` is not trusted. */
  resent?: boolean;
  resolve: (a: WriterAnswer) => void;
  reject: (e: Error) => void;
}

export interface WriterHooks<X> {
  /** Rows [from, to) of an op are committed. `changed`: the fills among them that changed; null = not known (take all). */
  rows(p: WriterPending<X>, from: number, to: number, changed: readonly number[] | null): void;
  /** What is left of an op, rows [from, n), written on the calling thread (the thread is gone). */
  inline(p: WriterPending<X>, from: number): WriterAnswer;
  /** The op left the queue, however (answered, written inline, spilled, failed). */
  settled(p: WriterPending<X>): void;
  /** meta.writer_done, read on the caller's connection. */
  committed(): string | null;
  /** Run `fn` holding the write lock (the store's tx). */
  locked(fn: () => void): void;
  log(line: string): void;
}

/** An op the thread did not write before a stop: its rows went to the spill (or nowhere, for a replay or a liq step). */
export class WriterStopped extends Error {
  constructor() { super('the writer thread stopped before writing this'); }
}

export function writerThreadOn(): boolean {
  const v = process.env.VALUESCAN_WRITER_THREAD;
  if (v === '0') return false;
  if (v === '1') return true;
  return !process.env.NODE_TEST_CONTEXT;
}

export interface WriterStatus {
  running: boolean;
  /** Ops and rows sent and not committed yet. */
  pendingOps: number;
  pendingRows: number;
  rows: number;
  txs: number;
  /** The last and the longest transaction, and the longest wait for the write lock (the thread's). */
  lastTxMs: number;
  maxTxMs: number;
  maxLockMs: number;
  /** Rows skipped for a constraint (a broken row; putFills used to fail its whole slice). */
  badRows: number;
  restarts: number;
  inlineOps: number;
  lastError: string | null;
}

interface Msg {
  seq?: number; from?: number; to?: number; changed?: number[]; final?: boolean; ids?: Array<[string, number]>;
  error?: string; bad?: number; txError?: string; tx?: { ms: number; lockMs: number; rows: number }; ready?: boolean;
}

// Plain JavaScript in a string, as checkpointer.ts: the thread needs no TypeScript loader, in production or in a test.
const CODE = `
const { workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const w = workerData;
const ctl = new Int32Array(w.ctl);
const port = w.port;
const DAY = 86400000;
const WANT = ${CTL_WANT}, STOP = ${CTL_STOP}, PARKED = ${CTL_PARKED};
const db = new DatabaseSync(w.path);
db.exec('PRAGMA busy_timeout = ' + w.busyMs);
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA temp_store = MEMORY');
db.exec('PRAGMA journal_size_limit = ' + w.walLimit);
db.exec('PRAGMA cache_size = -' + w.cacheKb);
db.exec('PRAGMA wal_autocheckpoint = ' + w.autoCkpt);
const S = w.sql;
const FILL = db.prepare(S.fill), DIRTY = db.prepare(S.dirty), HOUR = db.prepare(S.hour), DAYQ = db.prepare(S.day);
const ADDR = db.prepare(S.addr), LOG = db.prepare(S.log), CUR = db.prepare(S.cur), UNCUR = db.prepare(S.uncur);
const DONE = db.prepare("INSERT INTO meta (key, value) VALUES ('" + S.doneKey + "', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
let UNSPILL = null;
const queue = [];
const dirtySeen = new Set();
let scheduled = false, parked = false, fails = 0;
// A constraint, a type or a size: the row is broken, not the transaction (SQLite undoes only that statement).
const rowError = (e) => { const c = Number(e && e.errcode) & 0xff; return c === 19 || c === 20 || c === 18 || c === 25; };
function kick() { if (!scheduled && !parked) { scheduled = true; setImmediate(pump); } }
function park() {
  parked = true;
  Atomics.store(ctl, PARKED, 1);
  Atomics.notify(ctl, PARKED);
}
port.on('message', (m) => {
  if (m.ckpt !== undefined) { try { db.exec('PRAGMA wal_autocheckpoint = ' + m.ckpt); } catch (e) {} return; }
  // A stop finds the thread idle (no transaction to end): parked at once. A busy one sees the flag between rows.
  if (m.stop) { if (Atomics.load(ctl, STOP)) park(); return; }
  // A test's hung thread: a transaction holding the lock and one row, and a loop that never looks at the stop flag.
  if (m.hang) {
    db.exec('BEGIN IMMEDIATE');
    FILL.run('hyperliquid', '0xhang', 'hang', Date.now(), 'BTC', 1, 1, 1, null, null, null, 0);
    const end = Date.now() + m.hang;
    while (Date.now() < end) { /* hung */ }
    db.exec('ROLLBACK');
    return;
  }
  // From the row a dead thread had committed (an op handed on after a death), else from the start.
  m.done = m.from > 0 ? m.from : 0;
  // A liq step goes ahead of the stream rows (after any step already there): behind a backlog of millions of rows it waited
  // hours (2026-11-09, the heatmap's history 4.7 h behind). It may: a step is written again whole where it stands (it
  // replaces its own rows), meta.writer_done names stream ops only, and their order among themselves stays.
  // A wallet read's rows (prio) the same: its lane waited behind the stream backlog, and the HL reads and the boards with
  // it (2026-11-09: 110 min). Re-written whole after a death too: an upsert of the same rows changes nothing.
  if (m.kind === 'liqLog' || m.prio) {
    let at = 0;
    while (at < queue.length && (queue[at].kind === 'liqLog' || queue[at].prio)) at++;
    queue.splice(at, 0, m);
  } else queue.push(m);
  kick();
});
const cmp = (a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || a[2] - b[2];
function prepLiq(op) {
  const ids = new Map();
  for (const a of op.newAddrs) ids.set(a, ADDR.get(a).id);
  const known = op.changed.map((c) => (typeof c[0] === 'number' ? c : [ids.get(c[0])].concat(c.slice(1)))).sort(cmp);
  op.list = known.concat(op.closed.slice().sort(cmp));
  op.idList = [...ids];
}
function runRow(op, i, changed) {
  if (op.kind === 'fills') {
    const r = op.rows[i];
    if (Number(FILL.run(r.venue, r.address, r.id, r.t, r.symbol, r.side, r.px, r.sz, r.fee, r.closedPnl, r.oid, r.src).changes) > 0) {
      changed.push(i);
      if (op.due[i]) {
        const d = Math.floor(r.t / DAY);
        const k = r.venue + '|' + r.address + '|' + d;
        if (!dirtySeen.has(k)) { dirtySeen.add(k); DIRTY.run(r.venue, r.address, d); }
      }
    }
  } else if (op.kind === 'activity') {
    const r = op.rows[i];
    HOUR.run(r.venue, r.acct, r.hour, r.trades, r.volume);
    DAYQ.run(r.venue, r.acct, Math.floor(r.hour / 24), r.trades, r.volume);
  } else {
    const x = op.list[i];
    if (x.length === 4) {
      LOG.run(x[0], x[1], x[2], op.t, 0, 0, 0, null, 0, null, x[3], null, null, null, null, null);
      UNCUR.run(x[0], x[1], x[2]);
    } else {
      LOG.run(x[0], x[1], x[2], op.t, x[3], x[4], x[5], x[6], x[7], x[8], x[9], x[10], x[11], x[12], x[13], x[14]);
      CUR.run(x[0], x[1], x[2], x[3], x[4], x[5], op.t);
    }
  }
}
function pump() {
  scheduled = false;
  if (parked) return;
  if (Atomics.load(ctl, STOP)) return park();
  if (!queue.length) return;
  // The store's writes first: no transaction starts while one waits (they are short).
  const y0 = Date.now();
  for (;;) {
    const v = Atomics.load(ctl, WANT);
    if (v <= 0 || Date.now() - y0 >= w.maxYieldMs) break;
    Atomics.wait(ctl, WANT, v, 20);
    if (Atomics.load(ctl, STOP)) return park();
  }
  const t0 = Date.now();
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (e) {
    port.postMessage({ txError: 'begin: ' + String(e && e.message || e) });
    setTimeout(kick, 100);
    return;
  }
  const t1 = Date.now();
  if (Atomics.load(ctl, STOP)) { db.exec('ROLLBACK'); return park(); }
  dirtySeen.clear();
  const out = [];
  let rows = 0, bad = 0, lastBad = null, qi = 0;
  const enough = () => rows >= w.maxRows || Atomics.load(ctl, WANT) > 0 || Atomics.load(ctl, STOP) || Date.now() - t1 >= w.targetMs;
  try {
    while (qi < queue.length) {
      const op = queue[qi];
      const atomic = op.spillId !== undefined;
      if (atomic && rows > 0 && rows + op.n > w.maxRows) break;
      if (atomic) {
        if (!UNSPILL) UNSPILL = db.prepare('DELETE FROM write_spill WHERE id = ?');
        // Already gone: written before (a stop or a crash after its transaction). Its rows are not written twice.
        if (Number(UNSPILL.run(op.spillId).changes) === 0) {
          out.push({ op, seq: op.seq, from: 0, to: op.n, changed: [], final: true });
          qi++;
          continue;
        }
      }
      if (op.kind === 'liqLog' && !op.list) prepLiq(op);
      const from = op.done;
      const changed = [];
      let i = from;
      while (i < op.n) {
        try {
          runRow(op, i, changed);
        } catch (e) {
          if (!rowError(e)) throw e;
          bad++;
          lastBad = String(e && e.message || e);
        }
        i++;
        rows++;
        if (!atomic && ((rows & 15) === 0 ? enough() : (Atomics.load(ctl, WANT) > 0 || rows >= w.maxRows))) break;
      }
      out.push({ op, seq: op.seq, from, to: i, changed: op.kind === 'fills' ? changed : undefined, final: i === op.n, ids: i === op.n && op.kind === 'liqLog' ? op.idList : undefined });
      if (i < op.n) break;
      qi++;
      if (enough()) break;
    }
    // The last stream op of the transaction: every one before it (in seq order) is in the file. A step (ahead of them,
    // out of seq order) names nothing: with only a step in the transaction the row stays as it was.
    let last = null;
    for (let k = out.length - 1; k >= 0 && !last; k--) if (out[k].op.kind !== 'liqLog' && !out[k].op.prio) last = out[k];
    if (last) DONE.run(last.seq + ':' + last.to);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (x) {}
    for (const o of out) if (o.op.kind === 'liqLog' && o.from === 0) { o.op.list = null; o.op.idList = null; }
    fails++;
    port.postMessage({ txError: String(e && e.message || e) });
    setTimeout(kick, Math.min(5000, 50 * 2 ** Math.min(fails, 7)));
    return;
  }
  try {
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (x) {}
    for (const o of out) if (o.op.kind === 'liqLog' && o.from === 0) { o.op.list = null; o.op.idList = null; }
    fails++;
    port.postMessage({ txError: 'commit: ' + String(e && e.message || e) });
    setTimeout(kick, Math.min(5000, 50 * 2 ** Math.min(fails, 7)));
    return;
  }
  fails = 0;
  const t2 = Date.now();
  for (const o of out) { o.op.done = o.to; if (o.final) o.op.fin = true; }
  while (queue.length && queue[0].fin) queue.shift();
  for (let k = 0; k < out.length; k++) {
    const o = out[k];
    const m = { seq: o.seq, from: o.from, to: o.to, changed: o.changed, final: o.final, ids: o.ids };
    if (k === out.length - 1) { m.tx = { ms: t2 - t1, lockMs: t1 - t0, rows }; if (bad) { m.bad = bad; m.error = lastBad; } }
    port.postMessage(m);
  }
  kick();
}
port.postMessage({ ready: true });
`;

export class WriterThread<X = unknown> {
  /** Shared with the thread: the store's write count (CTL_WANT), the stop flag, the thread's "parked" answer. */
  readonly ctl = new Int32Array(new SharedArrayBuffer(16));
  private worker: Worker | null = null;
  private port: MessagePort | null = null;
  private pending: Array<WriterPending<X>> = [];
  private seq = 0;
  private stopped = false;
  private lastAt = Date.now();
  private watch: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  /** When the thread last died (0: never): two deaths within the restart pause write the backlog here. */
  private diedAt = 0;
  readonly state: WriterStatus = { running: false, pendingOps: 0, pendingRows: 0, rows: 0, txs: 0, lastTxMs: 0, maxTxMs: 0, maxLockMs: 0, badRows: 0, restarts: 0, inlineOps: 0, lastError: null };

  constructor(
    private readonly path: string,
    private readonly hooks: WriterHooks<X>,
    private readonly o: {
      cacheKb: number; busyMs: number; walLimit: number; autoCkpt: number;
      targetMs?: number; maxRows?: number; hungMs?: number; restartAfterMs?: number;
    },
  ) {
    // Ops numbered on from the last process's: `meta.writer_done` must name this process's ops only by a number above it.
    const c = this.hooks.committed();
    const n = c ? Number(c.split(':')[0]) : 0;
    this.seq = Number.isFinite(n) && n > 0 ? n : 0;
    this.start();
    const hung = this.o.hungMs ?? HUNG_MS;
    this.watch = setInterval(() => {
      // The answers waiting first: after a long stall of this thread they sit unread, and a writer answering all along was
      // ended as hung (2026-11-09 15:27: an 81 s stall here, the writer's longest lock wait 44 ms, "no answer for 169 s").
      if (this.worker && this.pending.length && Date.now() - this.lastAt > hung) this.drain();
      if (this.worker && this.pending.length && Date.now() - this.lastAt > hung) {
        this.state.lastError = `no answer for ${Math.round((Date.now() - this.lastAt) / 1000)} s`;
        void this.worker.terminate();
      }
    }, Math.min(10_000, hung));
    this.watch.unref();
  }

  /** True: ops go to the thread. False: the caller writes inline (the thread is down, or stopped). */
  get on(): boolean {
    return this.worker !== null && !this.stopped;
  }

  /** The thread's autocheckpoint follows the store's (checkpointer.ts switches it). */
  setAutoCheckpoint(pages: number): void {
    this.o.autoCkpt = pages;
    this.port?.postMessage({ ckpt: pages });
  }

  private start(): void {
    if (this.stopped) return;
    Atomics.store(this.ctl, CTL_STOP, 0);
    Atomics.store(this.ctl, CTL_PARKED, 0);
    const { port1, port2 } = new MessageChannel();
    const w = new Worker(CODE, {
      eval: true,
      execArgv: [],
      workerData: {
        path: this.path, ctl: this.ctl.buffer, port: port2,
        cacheKb: this.o.cacheKb, busyMs: this.o.busyMs, walLimit: this.o.walLimit, autoCkpt: this.o.autoCkpt,
        targetMs: this.o.targetMs ?? TARGET_MS, maxRows: this.o.maxRows ?? MAX_ROWS, maxYieldMs: MAX_YIELD_MS,
        sql: { fill: FILL_UPSERT, dirty: DIRTY_INSERT, hour: ACTIVITY_HOUR, day: ACTIVITY_DAY, addr: LIQ_ADDR_INSERT, log: LIQ_LOG_INSERT, cur: LIQ_CUR_INSERT, uncur: LIQ_CUR_DELETE, doneKey: WRITER_DONE_META },
      },
      transferList: [port2],
    });
    w.unref();
    port1.unref();
    this.worker = w;
    this.port = port1;
    this.lastAt = Date.now();
    port1.on('message', (m: Msg) => this.onMessage(m));
    w.on('error', (e) => { this.state.lastError = String(e instanceof Error ? e.message : e); });
    w.on('exit', () => { if (this.worker === w) this.died(); });
  }

  /** Send an op of `n` rows. Answered once every row is committed (or written inline after the thread died). */
  send(op: WriterOp, n: number, extra: X): Promise<WriterAnswer> {
    return new Promise((resolve, reject) => {
      const p: WriterPending<X> = { seq: ++this.seq, op, n, done: 0, extra, resolve, reject };
      if (!this.pending.length) this.lastAt = Date.now();
      this.pending.push(p);
      this.state.pendingOps++;
      this.state.pendingRows += n;
      if (this.worker && !this.stopped) {
        this.port!.postMessage({ ...op, seq: p.seq, n });
        return;
      }
      // No thread (between a death and the restart, or stopped): written here and now.
      this.runInline(p);
    });
  }

  private onMessage(m: Msg): void {
    this.lastAt = Date.now();
    if (m.ready) { this.state.running = true; return; }
    if (m.txError !== undefined) { this.state.lastError = m.txError; return; }
    if (m.tx) {
      this.state.txs++;
      this.state.rows += m.tx.rows;
      this.state.lastTxMs = m.tx.ms;
      this.state.maxTxMs = Math.max(this.state.maxTxMs, m.tx.ms);
      this.state.maxLockMs = Math.max(this.state.maxLockMs, m.tx.lockMs);
    }
    if (m.bad) { this.state.badRows += m.bad; this.state.lastError = `bad row: ${m.error}`; }
    // In order, except a liq step the thread took ahead of the stream rows.
    const p = this.pending[0]?.seq === m.seq ? this.pending[0] : this.pending.find((x) => x.seq === m.seq);
    if (!p) return;
    const from = m.from!;
    const to = m.to!;
    if (to > p.done) {
      // Rows of an op are answered in order; a range this side has already settled (after a death) is not done twice.
      const lo = Math.max(from, p.done);
      // An op handed on after a death: rows the dead thread had committed come back unchanged - all taken as changed.
      this.apply(p, lo, to, m.changed && !p.resent ? m.changed.filter((i) => i >= lo) : null);
    }
    if (m.final) this.finish(p, { ids: m.ids });
  }

  private apply(p: WriterPending<X>, from: number, to: number, changed: readonly number[] | null): void {
    if (to <= from) return;
    this.state.pendingRows -= to - from;
    p.done = to;
    try {
      this.hooks.rows(p, from, to, changed);
    } catch (e) {
      this.state.lastError = `answer: ${String(e)}`;
    }
  }

  private finish(p: WriterPending<X>, a: WriterAnswer): void {
    const i = this.pending.indexOf(p);
    if (i < 0) return;
    this.pending.splice(i, 1);
    this.state.pendingOps--;
    this.state.pendingRows -= p.n - p.done;
    this.hooks.settled(p);
    p.resolve(a);
  }

  private fail(p: WriterPending<X>, e: Error): void {
    const i = this.pending.indexOf(p);
    if (i < 0) return;
    this.pending.splice(i, 1);
    this.state.pendingOps--;
    this.state.pendingRows -= p.n - p.done;
    this.hooks.settled(p);
    p.reject(e);
  }

  private runInline(p: WriterPending<X>): void {
    this.state.inlineOps++;
    let a: WriterAnswer;
    try {
      a = this.hooks.inline(p, p.done);
    } catch (e) {
      this.fail(p, e instanceof Error ? e : new Error(String(e)));
      return;
    }
    this.state.pendingRows -= p.n - p.done;
    p.done = p.n;
    this.finish(p, a);
  }

  /** Messages the thread posted and this side has not seen yet, now (a stop or a death cannot wait for the loop). */
  private drain(): void {
    if (!this.port) return;
    for (let m = receiveMessageOnPort(this.port); m; m = receiveMessageOnPort(this.port)) this.onMessage(m.message as Msg);
  }

  /**
   * What `meta.writer_done` says is in the file and no answer said: handed to `rows` as "changed: not known". The caller
   * holds the write lock, or the thread is gone: no commit can come after the read.
   */
  private settleCommitted(): void {
    const c = this.hooks.committed();
    if (!c) return;
    const [s, d] = c.split(':').map(Number) as [number, number];
    for (const p of [...this.pending]) {
      if (p.seq > s) break;
      // A liq step's ids came only with its answer: written again where it stands, which replaces the same rows.
      if (p.op.kind === 'liqLog' || isPrio(p.op)) continue;
      const upTo = p.seq < s ? p.n : Math.min(p.n, d);
      if (upTo > p.done) this.apply(p, p.done, upTo, null);
      if (p.done >= p.n) this.finish(p, {});
    }
  }

  private died(): void {
    this.drain();
    this.port?.close();
    this.port = null;
    this.worker = null;
    this.state.running = false;
    if (this.stopped) return;
    this.state.restarts++;
    try {
      this.settleCommitted();
    } catch (e) {
      this.state.lastError = `writer_done: ${String(e)}`;
    }
    const left = [...this.pending];
    const rows = left.reduce((n, p) => n + p.n - p.done, 0);
    // A backlog written here would hold this thread for minutes (2026-11-09: 2.36M rows, nothing published meanwhile): past
    // INLINE_MAX_ROWS a new thread takes the ops on from where each stands, at once - unless the last one died within the
    // restart pause too (a thread that cannot write: then here, as always).
    const quick = Date.now() - this.diedAt < (this.o.restartAfterMs ?? RESTART_AFTER_MS);
    this.diedAt = Date.now();
    if (rows > INLINE_MAX_ROWS && !quick) {
      this.hooks.log(`[indexer] writer thread ended (${this.state.lastError ?? 'no error'}): ${left.length} ops (${rows} rows) handed to a new thread`);
      this.start();
      // A liq step again whole (its ids come with its answer; it replaces its own rows), a stream op from its committed row.
      for (const p of left) {
        if (isPrio(p.op)) p.resent = true;
        this.port!.postMessage({ ...p.op, seq: p.seq, n: p.n, from: p.op.kind === 'liqLog' ? 0 : p.done });
      }
      return;
    }
    this.hooks.log(`[indexer] writer thread ended (${this.state.lastError ?? 'no error'}): ${left.length} ops written here, and every write until it is back`);
    for (const p of left) {
      const from = p.done;
      this.runInline(p);
      // A wallet read's rows the dead thread had committed are unchanged when written again here: all taken as changed.
      if (isPrio(p.op) && p.done >= p.n) { try { this.hooks.rows(p, from, p.n, null); } catch (e) { this.state.lastError = `answer: ${String(e)}`; } }
    }
    this.retry = setTimeout(() => this.start(), this.o.restartAfterMs ?? RESTART_AFTER_MS);
    this.retry.unref();
  }

  /** For a test: the thread holds the write lock in a transaction for `ms` and does not look at the stop flag meanwhile. */
  hangForTest(ms: number): void {
    this.port?.postMessage({ hang: ms });
  }

  /** For a test: the thread dies (as a crash would, mid-transaction or not). */
  kill(): Promise<number> {
    return this.worker ? this.worker.terminate() : Promise.resolve(0);
  }

  /**
   * Stop, now, in this call: the thread finishes the transaction it is in (or none) and parks; every answer it posted is
   * taken; then, holding the write lock so nothing more can be committed, what `meta.writer_done` says is in the file is
   * settled and `rest` gets the ops not written (from each one's `done`). `rest` runs inside that lock (the spill goes in
   * that transaction). Each op left is then rejected with WriterStopped. Should `rest` throw, or be null, they are written
   * inline (after the lock: the thread, told to stop before it, rolls back any transaction it begins).
   */
  stopSync(rest: ((left: ReadonlyArray<WriterPending<X>>) => void) | null, waitMs = 15_000): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.watch) clearInterval(this.watch);
    if (this.retry) clearTimeout(this.retry);
    const w = this.worker;
    if (w) {
      Atomics.store(this.ctl, CTL_STOP, 1);
      Atomics.notify(this.ctl, CTL_WANT);
      this.port?.postMessage({ stop: true });
      this.drain();
      if (Atomics.load(this.ctl, CTL_PARKED) === 0 && Atomics.wait(this.ctl, CTL_PARKED, 0, waitMs) === 'timed-out') {
        // Hung (or in a transaction far past TARGET_MS): ended. Termination stops its JavaScript at once and its connection
        // closes as the thread ends, which rolls back the transaction it had open and frees the write lock that the lock
        // below waits for. What it had committed meta.writer_done says; the rest is spilled or written here: no row lost.
        // (Stuck inside SQLite itself, say on a dead disk, it ends when that call returns: the lock waits WRITER_BUSY_MS.)
        this.hooks.log(`[indexer] writer thread did not park in ${waitMs} ms: ended, and the write lock taken from it`);
        this.state.lastError = `did not park in ${waitMs} ms`;
        void w.terminate();
      }
      this.drain();
    }
    let threw: unknown = null;
    try {
      this.hooks.locked(() => {
        if (w) this.settleCommitted();
        if (rest) rest(this.pending);
      });
    } catch (e) {
      threw = e;
    }
    for (const p of [...this.pending]) {
      if (threw || !rest) this.runInline(p);
      else this.fail(p, new WriterStopped());
    }
    this.port?.close();
    this.port = null;
    this.worker = null;
    this.state.running = false;
    void w?.terminate();
    if (threw) throw threw;
  }
}
