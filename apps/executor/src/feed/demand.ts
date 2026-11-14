/**
 * Which markets the box's readers want from the shared feed - for a feed that carries only those (main.ts,
 * FEED_ON_DEMAND=1). Owner 2026-11-13: the VIP box's feed read 155-245 GB a day of Binance books (every SoDEX perp,
 * two raced copies, billed as AWS regional transfer) while no bot there quoted off Binance; "make sure the VIP feed
 * self starts fast if a bot is starting".
 *
 * A reader (reference.ts) keeps ONE small file per process in the want directory, named by its pid, holding the
 * markets it watches (ETH-USD,BTC-USD): written at once on every change, rewritten every TOUCH_MS while it watches
 * any, removed when it watches none or stops. The feed carries the union of the files that are fresh (written within
 * STALE_MS) and whose process is alive, and each market for LINGER_MS after it was last wanted (a bot restarted or
 * replaced finds the feed warm). No file: no sockets, no traffic.
 *
 * The directory is the feed's (`<ring path>.want`): it makes it with mode 1777, so every user on the box may add its
 * own file and none may remove another's. A reader whose directory is missing - a feed that carries every market, as
 * on server 2 - writes nothing and needs nothing. A starting bot never waits for any of this: the reader serves a
 * market the ring lacks from its own socket until the feed carries it (reference.ts).
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A reader rewrites its file this often while it watches any market (the feed's proof it is still there). */
export const TOUCH_MS = 10_000;
/** A file not written for this long is a reader gone without removing it (killed): ignored. */
export const STALE_MS = 35_000;
/** A market stays carried this long after its last want. */
export const LINGER_MS = 10 * 60_000;

export const wantDirOf = (ringPath: string): string => `${ringPath}.want`;

/** The process exists (EPERM: it does, as another user). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A reader's side: its own file in the want directory. Never throws; a failure is reported once through `warn`. */
export class DemandWriter {
  private markets = '';
  private writtenAt = 0;
  private warned = false;
  private readonly file: string;

  constructor(readonly dir: string, private readonly warn: (msg: string, data: Record<string, unknown>) => void = () => {}, pid: number = process.pid) {
    this.file = join(dir, String(pid));
  }

  /** The markets this process watches now (empty: its file goes). */
  set(markets: readonly string[], now = Date.now()): void {
    const next = [...new Set(markets)].sort().join(',');
    if (next === this.markets && (next === '' || this.writtenAt > 0)) return;
    this.markets = next;
    if (!next) this.remove();
    else this.write(now);
  }

  /** Called often (the reader's 250 ms check): rewrites the file when due, or once the feed made the directory. */
  tick(now = Date.now()): void {
    if (!this.markets) return;
    if (this.writtenAt === 0 || now - this.writtenAt >= TOUCH_MS) this.write(now);
  }

  clear(): void {
    this.markets = '';
    this.remove();
  }

  private write(now: number): void {
    if (!existsSync(this.dir)) {
      this.writtenAt = 0;
      return;
    }
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, this.markets);
      renameSync(tmp, this.file);
      this.writtenAt = now;
    } catch (e) {
      this.writtenAt = now; // not again before TOUCH_MS
      if (!this.warned) this.warn('feed demand: cannot write', { file: this.file, error: String(e) });
      this.warned = true;
    }
  }

  private remove(): void {
    this.writtenAt = 0;
    try {
      rmSync(this.file, { force: true });
    } catch {
      /* gone or never there */
    }
  }
}

/** The feed's side: the markets the fresh files of live processes want. */
export function readDemand(dir: string, now = Date.now(), alive: (pid: number) => boolean = pidAlive): { markets: Set<string>; readers: number } {
  const markets = new Set<string>();
  let readers = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { markets, readers };
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > STALE_MS || !alive(Number(name))) continue;
      const list = readFileSync(file, 'utf8').split(',').map((s) => s.trim()).filter((s) => /^[A-Z0-9]+-USD$/.test(s));
      if (!list.length) continue;
      readers++;
      for (const m of list) markets.add(m);
    } catch {
      /* removed while read */
    }
  }
  return { markets, readers };
}

/**
 * The markets to carry now: every market wanted now (their time set to `now` in `lastWant`), and those wanted within
 * LINGER_MS; older ones are dropped from `lastWant`. Sorted.
 */
export function carryNow(wanted: ReadonlySet<string>, lastWant: Map<string, number>, now = Date.now()): string[] {
  for (const m of wanted) lastWant.set(m, now);
  for (const [m, at] of lastWant) if (now - at >= LINGER_MS) lastWant.delete(m);
  return [...lastWant.keys()].sort();
}
