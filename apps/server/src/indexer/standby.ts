/**
 * The incoming side of a handover (handover.ts): stand by beside the running indexer, sockets open and buffering, then
 * take over writing the moment it lets go of the writer lock.
 *
 * Lean until it writes: no index connection, no 6 GB page cache, no writer or checkpoint thread, no liquidation feed
 * port, no lanes - its sockets and their buffer. Measured 2026-11-09 on live venues: 142 MB resident after 123 s with
 * 40,285 prints buffered; 83 MB in the test (fake venue, handover.test.ts).
 */
import { existsSync } from 'node:fs';
import type { Venue } from '../valuedesk/types.js';
import { defaultDbPath } from './store.js';
import { LighterStream, type HlStream } from './streams.js';
import { lockHolder, tryWriterLock, waitWriterLock } from './writerLock.js';
import {
  LEND_WAIT_MS, LOCK_WAIT_MS, PrintBuffer, PrintTap, READY_MAX_MS, REQUEST_WAIT_MS, SNAPSHOT_FLOOR_MS, STANDBY_GAVE_UP, alive, handoverPaths, readJson,
  removeFiles, tellSupervisor, withdrawRequest, writeJsonAtomic, type Accepted, type Boundary, type HandoverPaths, type HlLent,
} from './handover.js';
import { openSources, sourceFactory, sourceOf, sourceVenues, stopSources, type Sources } from './printSources.js';
import { runIndexer, type Running } from './worker.js';

/** Hyperliquid markets moved per step: the standby takes them, then the running process lets them go. */
export const HL_BATCH = 150;
/**
 * Lighter's subscribes from the standby are spaced wider than a cold start's (330 ms): measured 2026-11-09, two
 * processes subscribing at once from one address drew "Too Many Websocket Messages!" (code 30009) and took 140 s
 * instead of ~75 s. Beside a running indexer that only pings, 500 ms (120 a minute) leaves Lighter's 200 room.
 */
const STANDBY_LIGHTER_GAP_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(get: () => T | null | false | undefined, ms: number, everyMs = 100, stop: () => boolean = () => false): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() >= end || stop()) return null;
    await sleep(everyMs);
  }
}

const log = (line: string) => console.log(`[indexer] ${line}`);

export interface Standby {
  /** The indexer once it writes (null: it gave up and the process ends). */
  running: Promise<Running | null>;
  /** SIGTERM while standing by: withdraw if not taken yet, else take over and stop at once (nothing buffered is lost). */
  cancel(): void;
}

/**
 * Move Hyperliquid's markets across (streams.ts HL_SUBSCRIPTION_LIMIT): take a batch, wait for Hyperliquid's acks, ask the
 * running process to let the acked ones go, wait for its answer. Refused ones are asked for again once more is let go.
 * Returns how many were moved; stops early when the running process does not answer (older code) or nothing moves.
 */
async function moveHlMarkets(hl: HlStream, paths: HandoverPaths, deadline: number, cancelled: () => boolean): Promise<{ moved: number; of: number; why: string | null }> {
  const markets = await hl.marketList();
  let pending = [...markets];
  let seq = 0;
  let stalls = 0;
  const moved = new Set<string>();
  while (pending.length && Date.now() < deadline && !cancelled()) {
    const coins = pending.slice(0, HL_BATCH);
    hl.take(coins);
    const refusals = hl.refusals;
    await until(() => coins.every((c) => hl.acked.has(c)) || (hl.refusals > refusals && coins.every((c) => hl.acked.has(c) || hl.refusals - refusals >= coins.length)), 3_000, 50);
    // Give the last acks a moment after a refusal: they come in order.
    if (!coins.every((c) => hl.acked.has(c))) await sleep(300);
    const got = coins.filter((c) => hl.acked.has(c));
    const missed = coins.filter((c) => !hl.acked.has(c));
    if (got.length) {
      seq++;
      writeJsonAtomic(paths.hlLend, { seq, pid: process.pid, coins: got });
      const ok = await until(() => readJson<HlLent>(paths.hlLent)?.seq === seq, seq === 1 ? Math.min(LEND_WAIT_MS, REQUEST_WAIT_MS) : LEND_WAIT_MS, 50, cancelled);
      if (!ok) return { moved: moved.size, of: markets.length, why: 'the running indexer does not let markets go (older code?)' };
      for (const c of got) moved.add(c);
      stalls = 0;
    } else if (++stalls >= 3) {
      return { moved: moved.size, of: markets.length, why: `Hyperliquid refused ${missed.length} subscriptions three times (its 1,000 per IP, other subscribers on this address)` };
    }
    pending = [...pending.slice(HL_BATCH), ...missed];
  }
  return { moved: moved.size, of: markets.length, why: pending.length ? `${pending.length} not moved by the deadline` : null };
}

/** Start standing by. `exit`: the process ends with this code (it gave up, or was stopped before taking over). */
export function startStandby(path = defaultDbPath(), o: { exit: (code: number) => void; onHandedOver?: () => void }): Standby {
  let cancelled = false;
  let accepted: Accepted | null = null;
  let stopAfter = false;
  let promoted = false;
  let sources: Sources | null = null;
  const paths = handoverPaths(path);
  const giveUp = (why: string, code = STANDBY_GAVE_UP): null => {
    cancelled = true;
    removeFiles(paths.hello, paths.hlLend, paths.hlLent);
    if (sources) stopSources(sources);
    LighterStream.SEND_GAP_MS = 330;
    console.warn(`[indexer] standby: giving up - ${why}`);
    tellSupervisor('failed', { reason: why, accepted: !!accepted });
    o.exit(code);
    return null;
  };

  const run = async (): Promise<Running | null> => {
    const free = tryWriterLock(path);
    if (free) {
      log('standby: no indexer holds the writer lock, so there is nothing to take over: starting as the writer');
      tellSupervisor('promoted', { takeover: false });
      return runIndexer(path, { lock: free, onHandedOver: o.onHandedOver });
    }
    const holder = lockHolder(path);
    const helloAt = Date.now();
    removeFiles(paths.request, paths.accepted, paths.withdrawn, paths.boundary, paths.heldDone, paths.hlLend, paths.hlLent);
    writeJsonAtomic(paths.hello, { pid: process.pid, at: helloAt });
    log(`standby: pid ${holder?.pid ?? '?'} writes the index; opening the trade sockets beside it, every print buffered`);
    tellSupervisor('standby', { holder: holder?.pid ?? null });
    const tap = new PrintTap();
    const buffer = new PrintBuffer();
    tap.sink = buffer.push;
    LighterStream.SEND_GAP_MS = STANDBY_LIGHTER_GAP_MS;
    sources = openSources(tap.emit, () => promoted || cancelled, { gradualHl: true });
    const s = sources;
    const wanted: Venue[] = sourceFactory() ? sourceVenues(s) : ['hyperliquid', 'sodex', 'lighter', 'arcus'];
    const up = (v: Venue) => (sourceOf(s, v)?.since ?? null) !== null;
    const deadline = helloAt + READY_MAX_MS;
    // Hyperliquid once the others are up: its markets leave the running process, so the window in which only this one
    // has them is kept short.
    await until(() => wanted.every((v) => v === 'hyperliquid' || up(v)), deadline - Date.now(), 250, () => cancelled);
    if (cancelled) return giveUp('stopped while standing by', 0);
    const notUp = wanted.filter((v) => v !== 'hyperliquid' && !up(v));
    if (notUp.length) log(`standby: ${notUp.join(', ')} still not up after ${Math.round(READY_MAX_MS / 60_000)} min: handing over with what is up`);
    // A test's fake venue (printSources.ts setSourceFactory) has no subscription limit to move around.
    if (s.hyperliquid && typeof s.hyperliquid.marketList === 'function') {
      const t = Date.now();
      const r = await moveHlMarkets(s.hyperliquid, paths, Math.max(deadline, Date.now() + 60_000), () => cancelled);
      log(`standby: ${r.moved} of ${r.of} Hyperliquid markets moved here in ${Date.now() - t} ms${r.why ? ` (${r.why})` : ''}`);
      if (cancelled) return giveUp('stopped while standing by', 0);
      await until(() => up('hyperliquid'), 10_000, 100);
    }
    const ups = Object.fromEntries(wanted.map((v) => [v, up(v)])) as Partial<Record<Venue, boolean>>;
    const from = buffer.from(helloAt - SNAPSHOT_FLOOR_MS, wanted, Date.now());
    const askedAt = Date.now();
    writeJsonAtomic(paths.request, { pid: process.pid, at: askedAt, helloAt, from, up: ups });
    log(`standby: asking to take over after ${Math.round((askedAt - helloAt) / 1000)} s, ${buffer.size} prints buffered, ${Math.round(process.memoryUsage().rss / 1e6)} MB resident; sockets ${wanted.map((v) => `${v} ${ups[v] ? 'up' : 'DOWN'}`).join(', ')}`);
    tellSupervisor('requested', { up: ups, buffered: buffer.size });
    const mine = () => { const a = readJson<Accepted>(paths.accepted); return a && a.pid === process.pid ? a : null; };
    for (;;) {
      accepted = await until(mine, REQUEST_WAIT_MS, 50, () => cancelled);
      if (accepted) break;
      // Withdrawn only if it was not taken in the same moment (both rename the file: one wins).
      if (withdrawRequest(paths)) return giveUp(cancelled ? 'stopped before the running indexer took the request' : `the running indexer did not take the request in ${Math.round(REQUEST_WAIT_MS / 1000)} s (older code, or not watching)`, cancelled ? 0 : STANDBY_GAVE_UP);
    }
    const a = accepted;
    tellSupervisor('accepted', { by: a.by });
    // From here on this process must take over: the running one is stopping.
    const lock = await waitWriterLock(path, { waitMs: LOCK_WAIT_MS, everyMs: 50 });
    if (!lock) return giveUp(`pid ${a.by} took the request but still held the writer lock ${Math.round(LOCK_WAIT_MS / 60_000)} min later`);
    const lockAt = Date.now();
    const b = readJson<Boundary>(paths.boundary);
    const boundary = b && b.to === process.pid && b.pid === a.by ? b : null;
    const ids = boundary ? Object.values(boundary.venues).reduce((n, v) => n + v!.ids.length, 0) : 0;
    log(`handover: writer lock taken ${lockAt - a.acceptedAt} ms after pid ${a.by} took the request (its sockets closed ${boundary ? lockAt - boundary.stoppedAt : '?'} ms ago); ${boundary ? `boundary of ${ids} print ids` : 'NO boundary: the outgoing process ended without one, the restart check decides'}; ${buffer.size} prints buffered`);
    promoted = true;
    LighterStream.SEND_GAP_MS = 330;
    const buffered = buffer.size;
    const running = runIndexer(path, { lock, handover: { tap, buffer, sources: s, boundary, floor: helloAt - SNAPSHOT_FLOOR_MS }, onHandedOver: o.onHandedOver });
    removeFiles(paths.hello, paths.accepted, paths.boundary, paths.hlLend, paths.hlLent);
    const startedAt = Date.now();
    tellSupervisor('promoted', { takeover: true, from: a.by, lockWaitMs: lockAt - a.acceptedAt, startMs: startedAt - lockAt, buffered, boundary: !!boundary });
    // The held rows: written by the outgoing process after it let go of the lock.
    void until(() => (readJson<{ pid: number }>(paths.heldDone)?.pid === a.by) || !alive(a.by), 15 * 60_000, 500).then(() => {
      if (!existsSync(paths.heldDone)) log(`handover: pid ${a.by} ended without saying its held rows are written; reading what is there`);
      try { running.store.loadHeldLate(); } catch (e) { console.warn(`[indexer] handover: held rows not read: ${String(e)}`); }
      removeFiles(paths.heldDone);
    });
    if (stopAfter) {
      // Stopped while taking over: the buffer goes in first, then the classic stop writes or spills it.
      await until(() => running.indexer.handover !== null, 10 * 60_000, 100);
      running.stop();
      o.exit(0);
    }
    return running;
  };
  return {
    running: run(),
    cancel() {
      if (accepted) { stopAfter = true; return; }
      cancelled = true;
    },
  };
}
