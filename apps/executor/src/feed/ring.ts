/**
 * The shared market-data ring: ONE process on the box holds the exchange sockets (feed/main.ts, valuescan-feed) and
 * every other process reads the same ticks from a file in memory (tmpfs) - no second set of connections, no second
 * rate-limit use, and a reader that restarts has every symbol's latest quote at once.
 *
 * The layout is the one the trading box (apex-tokyo) uses for its shared Binance feed, byte for byte (its
 * FEED_SHM.md, "ARCFEED1" version 1), so the tools there read this file as they are (`--feed-tap`, feedshm.py):
 *
 *   [header 4096][feed names 16 B each][symbol table 48 B each][latest table feeds x symbols ticks][ring]
 *
 *   header  0 magic "ARCFEED1" | 8 u32 version 1 | 12 u32 tick size 64 | 16 u64 ring capacity (power of two)
 *           24 u32 feeds | 28 u32 symbols | 32/40/48/56 u64 offsets of names / symbols / latest / ring
 *           64 u64 file length | 72 u32 producer pid | 76 u32 flags (0: readers poll, no futex)
 *           80 u64 generation (wall-clock ns at the producer's start) | 88 u64 head (ticks published)
 *           96 u64 beat (CLOCK_MONOTONIC ns of the last tick or 100 ms heartbeat) | 104 u32 low 32 bits of head
 *   tick    0 seq (tick number + 1; 0 = empty or being written) | 8 rx (CLOCK_MONOTONIC ns, received)
 *           16 bid | 24 ask | 32 bid size | 40 ask size (f64) | 48 exchange event time ms (i64)
 *           56 bits 0-15 feed, 16-31 symbol, 32-63 low 32 bits of the exchange's update id
 *   symbol  24 B our market (ETH-USD) + 24 B the exchange's symbol (ETHUSDT), NUL padded
 *
 * Writing a tick: seq 0, the other words, then seq = n + 1 - in the ring slot (n & (capacity - 1)) and in the
 * latest table - then head and beat. Reading: only ticks below head; one whose slot the producer has lapped since
 * (head - n > capacity) is dropped, never half-read. A producer that restarts writes a NEW file and renames it into
 * place (the generation changes): a reader sees the path's inode change and opens it again.
 *
 * Node has no mmap, so both sides go through pread/pwrite on the tmpfs file: 7 system calls a tick (~1-2 µs each),
 * and the reader's delay is its poll period (2 ms in reference.ts). Ticks that change neither bid nor ask are not
 * written (a size-only update is no news for a reference price).
 */
import { closeSync, fstatSync, ftruncateSync, openSync, readSync, renameSync, statSync, writeSync } from 'node:fs';

/** Where valuescan-feed writes the ring (its unit's RuntimeDirectory) and the executor reads it. */
export const DEFAULT_FEED_PATH = '/run/valuescan-feed/binance-l1';

export const MAGIC = 'ARCFEED1';
export const VERSION = 1;
export const TICK_BYTES = 64;
const HEADER_BYTES = 4096;
const NAME_BYTES = 16;
const SYMBOL_BYTES = 48;
const H_HEAD = 88;
const H_BEAT = 96;

/** CLOCK_MONOTONIC in ns, the same clock in every process on the box (libuv's hrtime is CLOCK_MONOTONIC on Linux). */
export const monoNs = (): bigint => process.hrtime.bigint();

export interface RingSymbol {
  /** Our market, e.g. ETH-USD. */
  market: string;
  /** The exchange's symbol, e.g. ETHUSDT. */
  venue: string;
}

export interface Tick {
  /** The tick's number in the ring. */
  n: bigint;
  rxNs: bigint;
  bid: number;
  ask: number;
  bidSz: number;
  askSz: number;
  /** The exchange's event time, ms since the epoch (0: not given). */
  eventMs: number;
  feed: number;
  symbol: number;
  /** The low 32 bits of the exchange's update id. */
  update: number;
}

interface Layout {
  capacity: number;
  feeds: number;
  symbols: number;
  names: number;
  table: number;
  latest: number;
  ring: number;
  length: number;
}

function layoutOf(capacity: number, feeds: number, symbols: number): Layout {
  const names = HEADER_BYTES;
  const table = names + feeds * NAME_BYTES;
  const latest = align64(table + symbols * SYMBOL_BYTES);
  const ring = align64(latest + feeds * symbols * TICK_BYTES);
  return { capacity, feeds, symbols, names, table, latest, ring, length: ring + capacity * TICK_BYTES };
}

const align64 = (x: number): number => Math.ceil(x / 64) * 64;

function putName(b: Buffer, at: number, s: string, max: number): void {
  b.fill(0, at, at + max);
  b.write(s.slice(0, max - 1), at, 'latin1');
}

const getName = (b: Buffer, at: number, max: number): string => {
  const end = b.indexOf(0, at);
  return b.toString('latin1', at, end < 0 || end > at + max ? at + max : end);
};

/** The producer's side. */
export class RingWriter {
  private readonly fd: number;
  private readonly l: Layout;
  private head = 0n;
  private readonly tick = Buffer.alloc(TICK_BYTES);
  private readonly zero = Buffer.alloc(8);
  private readonly seq = Buffer.alloc(8);
  private readonly hb = Buffer.alloc(20);
  /** The last bid / ask written per feed and symbol: an unchanged pair is not written again. */
  private readonly last: Float64Array;

  /**
   * Builds the file next to `path` and renames it into place (readers of an older file see the path change).
   * `capacity` a power of two (default 65,536 ticks: 4 MB).
   */
  constructor(readonly path: string, readonly feeds: readonly string[], readonly symbols: readonly RingSymbol[], capacity = 65_536) {
    if (capacity & (capacity - 1)) throw new Error('ring capacity must be a power of two');
    if (symbols.length > 0xffff || feeds.length > 0xffff) throw new Error('too many symbols or feeds');
    this.l = layoutOf(capacity, feeds.length, symbols.length);
    this.last = new Float64Array(feeds.length * symbols.length * 2).fill(NaN);
    const tmp = `${path}.tmp-${process.pid}`;
    this.fd = openSync(tmp, 'w+', 0o644);
    ftruncateSync(this.fd, this.l.length);
    const h = Buffer.alloc(this.l.ring);
    h.write(MAGIC, 0, 'latin1');
    h.writeUInt32LE(VERSION, 8);
    h.writeUInt32LE(TICK_BYTES, 12);
    h.writeBigUInt64LE(BigInt(capacity), 16);
    h.writeUInt32LE(feeds.length, 24);
    h.writeUInt32LE(symbols.length, 28);
    h.writeBigUInt64LE(BigInt(this.l.names), 32);
    h.writeBigUInt64LE(BigInt(this.l.table), 40);
    h.writeBigUInt64LE(BigInt(this.l.latest), 48);
    h.writeBigUInt64LE(BigInt(this.l.ring), 56);
    h.writeBigUInt64LE(BigInt(this.l.length), 64);
    h.writeUInt32LE(process.pid, 72);
    h.writeUInt32LE(0, 76);
    h.writeBigUInt64LE(BigInt(Date.now()) * 1_000_000n, 80);
    h.writeBigUInt64LE(0n, H_HEAD);
    h.writeBigUInt64LE(monoNs(), H_BEAT);
    feeds.forEach((f, i) => putName(h, this.l.names + i * NAME_BYTES, f, NAME_BYTES));
    symbols.forEach((s, i) => {
      putName(h, this.l.table + i * SYMBOL_BYTES, s.market, 24);
      putName(h, this.l.table + i * SYMBOL_BYTES + 24, s.venue, 24);
    });
    writeSync(this.fd, h, 0, h.length, 0);
    renameSync(tmp, path);
  }

  /** Ticks published so far. */
  get published(): bigint {
    return this.head;
  }

  /** One quote. false: bid and ask are what was written last for this pair (nothing written). */
  publish(feed: number, symbol: number, bid: number, ask: number, bidSz: number, askSz: number, eventMs: number, update: number, rxNs: bigint = monoNs()): boolean {
    const k = (feed * this.l.symbols + symbol) * 2;
    if (this.last[k] === bid && this.last[k + 1] === ask) return false;
    this.last[k] = bid;
    this.last[k + 1] = ask;
    const n = this.head;
    const t = this.tick;
    t.writeBigUInt64LE(n + 1n, 0);
    t.writeBigUInt64LE(rxNs, 8);
    t.writeDoubleLE(bid, 16);
    t.writeDoubleLE(ask, 24);
    t.writeDoubleLE(bidSz, 32);
    t.writeDoubleLE(askSz, 40);
    t.writeBigInt64LE(BigInt(Math.trunc(eventMs)), 48);
    t.writeBigUInt64LE(BigInt(feed & 0xffff) | (BigInt(symbol & 0xffff) << 16n) | (BigInt(update >>> 0) << 32n), 56);
    this.put(this.l.ring + Number(n & BigInt(this.l.capacity - 1)) * TICK_BYTES);
    this.put(this.l.latest + (feed * this.l.symbols + symbol) * TICK_BYTES);
    this.head = n + 1n;
    this.beat(rxNs);
    return true;
  }

  /** The heartbeat (every 100 ms from the producer): a reader takes a silent beat for a dead producer. */
  beat(now: bigint = monoNs()): void {
    this.hb.writeBigUInt64LE(this.head, 0);
    this.hb.writeBigUInt64LE(now, 8);
    this.hb.writeUInt32LE(Number(this.head & 0xffffffffn), 16);
    writeSync(this.fd, this.hb, 0, 20, H_HEAD);
  }

  close(): void {
    closeSync(this.fd);
  }

  /** seq 0, the body, then the seq: a reader never takes a half-written tick for a whole one. */
  private put(at: number): void {
    this.seq.set(this.tick.subarray(0, 8));
    writeSync(this.fd, this.zero, 0, 8, at);
    writeSync(this.fd, this.tick, 8, TICK_BYTES - 8, at + 8);
    writeSync(this.fd, this.seq, 0, 8, at);
  }
}

/** A reader's side. Open it; `drain` returns the ticks published since the last call. */
export class RingReader {
  private fd: number;
  private ino: number;
  private l!: Layout;
  readonly feeds: string[] = [];
  readonly symbols: RingSymbol[] = [];
  readonly bySymbol = new Map<string, number>();
  generation = 0n;
  /** The next tick to read. */
  private next = 0n;
  /** Ticks the producer lapped before they were read. */
  lost = 0n;
  private readonly h = Buffer.alloc(16);
  private buf = Buffer.alloc(0);

  constructor(readonly path: string) {
    this.fd = openSync(path, 'r');
    this.ino = fstatSync(this.fd).ino;
    this.load();
  }

  private load(): void {
    const head = Buffer.alloc(HEADER_BYTES);
    readSync(this.fd, head, 0, HEADER_BYTES, 0);
    if (head.toString('latin1', 0, 8) !== MAGIC || head.readUInt32LE(8) !== VERSION || head.readUInt32LE(12) !== TICK_BYTES) throw new Error(`${this.path}: not an ${MAGIC} v${VERSION} ring`);
    const capacity = Number(head.readBigUInt64LE(16));
    const feeds = head.readUInt32LE(24);
    const symbols = head.readUInt32LE(28);
    this.l = {
      capacity,
      feeds,
      symbols,
      names: Number(head.readBigUInt64LE(32)),
      table: Number(head.readBigUInt64LE(40)),
      latest: Number(head.readBigUInt64LE(48)),
      ring: Number(head.readBigUInt64LE(56)),
      length: Number(head.readBigUInt64LE(64)),
    };
    this.generation = head.readBigUInt64LE(80);
    const t = Buffer.alloc(this.l.latest - this.l.names);
    readSync(this.fd, t, 0, t.length, this.l.names);
    this.feeds.length = 0;
    this.symbols.length = 0;
    this.bySymbol.clear();
    for (let i = 0; i < feeds; i++) this.feeds.push(getName(t, i * NAME_BYTES, NAME_BYTES));
    for (let i = 0; i < symbols; i++) {
      const at = this.l.table - this.l.names + i * SYMBOL_BYTES;
      const s = { market: getName(t, at, 24), venue: getName(t, at + 24, 24) };
      this.symbols.push(s);
      this.bySymbol.set(s.market, i);
    }
    // Start at the producer's head: what came before is in the latest table.
    this.next = this.readHead().head;
    this.buf = Buffer.alloc(Math.min(this.l.capacity, 4096) * TICK_BYTES);
  }

  private readHead(): { head: bigint; beat: bigint } {
    readSync(this.fd, this.h, 0, 16, H_HEAD);
    return { head: this.h.readBigUInt64LE(0), beat: this.h.readBigUInt64LE(8) };
  }

  /** The producer's heartbeat is younger than `maxMs`. */
  alive(maxMs = 2_000): boolean {
    return monoNs() - this.readHead().beat < BigInt(maxMs) * 1_000_000n;
  }

  /** The path now names another file (the producer restarted): open that one. true when it did. */
  reopenIfReplaced(): boolean {
    let ino: number;
    try {
      ino = statSync(this.path).ino;
    } catch {
      return false;
    }
    if (ino === this.ino) return false;
    const fd = openSync(this.path, 'r');
    closeSync(this.fd);
    this.fd = fd;
    this.ino = ino;
    this.load();
    return true;
  }

  /** The newest tick of one feed and symbol (null: none yet, or being written twice over while read). */
  latest(feed: number, symbol: number): Tick | null {
    if (feed >= this.l.feeds || symbol >= this.l.symbols) return null;
    const at = this.l.latest + (feed * this.l.symbols + symbol) * TICK_BYTES;
    const b = Buffer.alloc(TICK_BYTES);
    const s = Buffer.alloc(8);
    for (let i = 0; i < 3; i++) {
      readSync(this.fd, b, 0, TICK_BYTES, at);
      readSync(this.fd, s, 0, 8, at);
      const seq = b.readBigUInt64LE(0);
      if (seq !== 0n && seq === s.readBigUInt64LE(0)) return decode(b, 0, seq - 1n);
    }
    return null;
  }

  /** Every tick published since the last call, oldest first (at most `max`; the rest the next call). */
  drain(max = 4096): Tick[] {
    const { head } = this.readHead();
    if (head <= this.next) return [];
    const cap = BigInt(this.l.capacity);
    if (head - this.next > cap) {
      this.lost += head - this.next - cap;
      this.next = head - cap;
    }
    const want = Number(head - this.next < BigInt(max) ? head - this.next : BigInt(max));
    if (this.buf.length < want * TICK_BYTES) this.buf = Buffer.alloc(want * TICK_BYTES);
    // At most two reads: up to the ring's end, then from its start.
    const slot = Number(this.next & (cap - 1n));
    const first = Math.min(want, this.l.capacity - slot);
    readSync(this.fd, this.buf, 0, first * TICK_BYTES, this.l.ring + slot * TICK_BYTES);
    if (want > first) readSync(this.fd, this.buf, first * TICK_BYTES, (want - first) * TICK_BYTES, this.l.ring);
    // Ticks the producer may have lapped while they were read are dropped.
    const after = this.readHead().head;
    const out: Tick[] = [];
    for (let i = 0; i < want; i++) {
      const n = this.next + BigInt(i);
      if (after - n > cap - 1n) {
        this.lost++;
        continue;
      }
      const seq = this.buf.readBigUInt64LE(i * TICK_BYTES);
      if (seq !== n + 1n) {
        this.lost++;
        continue;
      }
      out.push(decode(this.buf, i * TICK_BYTES, n));
    }
    this.next += BigInt(want);
    return out;
  }

  close(): void {
    closeSync(this.fd);
  }
}

function decode(b: Buffer, at: number, n: bigint): Tick {
  const ids = b.readBigUInt64LE(at + 56);
  return {
    n,
    rxNs: b.readBigUInt64LE(at + 8),
    bid: b.readDoubleLE(at + 16),
    ask: b.readDoubleLE(at + 24),
    bidSz: b.readDoubleLE(at + 32),
    askSz: b.readDoubleLE(at + 40),
    eventMs: Number(b.readBigInt64LE(at + 48)),
    feed: Number(ids & 0xffffn),
    symbol: Number((ids >> 16n) & 0xffffn),
    update: Number(ids >> 32n),
  };
}
