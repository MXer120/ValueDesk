/**
 * The Hyperliquid leaderboard snapshot on disk, so a restarted indexer does not wait for the 39 MB file again.
 *
 * The first board build after the restart of 2026-11-06 23:33 UTC spent 84.5 s of its 352 s on that download and its
 * parse on a busy thread. HL writes a new file each hour; a snapshot whose numbers are under an hour old (maxAgeMs) is
 * what HL serves or the one before it, and the store checks HL again at once with its ETag, so a newer file replaces it
 * within a minute while the boards build from this one.
 *
 * Layout: u32 length of a JSON head, the head (format, times, addresses, labels, column names), then the columns as
 * float64 arrays in the head's order. About 7 MB for 47k rows; written once per new file.
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { LbSnapshot, parseLeaderboard, type ParsedLeaderboard } from './leaderboard.js';

const FORMAT = 'hl-lb-1';
export const LB_FILE_MAX_AGE_MS = 60 * 60_000;

interface Head {
  format: string;
  lastModified: number;
  etag: string | null;
  fetchedAt: number;
  addresses: string[];
  labels: Array<string | null>;
  cols: string[];
}

export function saveLeaderboardFile(path: string, snap: LbSnapshot): void {
  const d = snap.data;
  const cols = Object.keys(d.cols).sort();
  const head: Head = { format: FORMAT, lastModified: snap.lastModified, etag: snap.etag, fetchedAt: snap.fetchedAt, addresses: d.addresses, labels: d.labels, cols };
  const text = Buffer.from(JSON.stringify(head), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(text.length);
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, len);
    writeSync(fd, text);
    for (const a of [d.accountValue, ...cols.map((k) => d.cols[k as keyof ParsedLeaderboard['cols']])]) {
      writeSync(fd, new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    }
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** The snapshot if the file holds one whose numbers are under `maxAgeMs` old; else null (and a bad file is removed). */
export function loadLeaderboardFile(path: string, now = Date.now(), maxAgeMs = LB_FILE_MAX_AGE_MS): LbSnapshot | null {
  if (!existsSync(path)) return null;
  try {
    const buf = readFileSync(path);
    const hl = buf.readUInt32LE(0);
    const head = JSON.parse(buf.subarray(4, 4 + hl).toString('utf8')) as Head;
    if (head.format !== FORMAT) return null;
    const updatedAt = head.lastModified || head.fetchedAt;
    if (!(now - updatedAt < maxAgeMs)) return null;
    const n = head.addresses.length;
    if (head.labels.length !== n) throw new Error('labels do not match the rows');
    // The columns this code reads, no more and no fewer: a release that adds one reads the file as none.
    const want = Object.keys(parseLeaderboard({ leaderboardRows: [] }).cols).sort();
    if (want.join() !== [...head.cols].sort().join()) return null;
    let off = 4 + hl;
    const col = (): Float64Array => {
      const a = new Float64Array(n);
      if (off + a.byteLength > buf.length) throw new Error('short file');
      new Uint8Array(a.buffer).set(buf.subarray(off, off + a.byteLength));
      off += a.byteLength;
      return a;
    };
    const accountValue = col();
    const cols = {} as ParsedLeaderboard['cols'];
    for (const k of head.cols) cols[k as keyof ParsedLeaderboard['cols']] = col();
    if (off !== buf.length) throw new Error('long file');
    return new LbSnapshot({ addresses: head.addresses, labels: head.labels, accountValue, cols }, head.lastModified, head.etag, head.fetchedAt);
  } catch (e) {
    console.warn(`[hl leaderboard] snapshot file not read: ${String(e)}`);
    try { rmSync(path, { force: true }); } catch { /* gone */ }
    return null;
  }
}
