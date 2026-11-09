/**
 * The indexer's stop without the checkpoint on close (2026-11-09). The stop of 2026-11-08 22:46 took 351 s, 228 s of it in
 * `database close`: the last connection to close checkpoints the whole WAL into the file and deletes the WAL. At a process
 * exit the store leaves its connection open instead: every committed row is in the WAL, and the next start goes on from it.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IndexStore, type FillRow } from '../src/indexer/store.js';

const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;
const rows = (n: number, tag: string): FillRow[] => Array.from({ length: n }, (_, i) => ({
  venue: 'hyperliquid', address: `0x${(i % 500).toString(16).padStart(40, '0')}`, id: `${tag}${i}`, t: today + i, symbol: 'BTC',
  side: 1, px: 100 + i, sz: 1, fee: 0.1, closedPnl: null, oid: `o${i}`, src: 1,
}));

/** A store with a WAL of some MB that no checkpoint has copied yet. */
function withWal(path: string): IndexStore {
  const s = new IndexStore(path, { aggRefreshMs: 0 });
  s.db.exec('PRAGMA wal_autocheckpoint = 0');
  for (let k = 0; k < 10; k++) s.putFills(rows(10_000, `r${k}-`));
  return s;
}

test('stop: closing for an exit leaves the WAL to the next start; the last close checkpoints it', () => {
  const d = mkdtempSync(join(tmpdir(), 'vs-stop-'));
  const a = join(d, 'a.db');
  const b = join(d, 'b.db');
  const sa = withWal(a);
  const walA = statSync(`${a}-wal`).size;
  let t = performance.now();
  sa.close();
  const closeMs = performance.now() - t;
  assert.equal(existsSync(`${a}-wal`), false, 'the last close copied the WAL into the file and removed it');

  const sb = withWal(b);
  const walB = statSync(`${b}-wal`).size;
  const steps: string[] = [];
  t = performance.now();
  sb.close((s) => steps.push(s), { exiting: true });
  const exitMs = performance.now() - t;
  assert.deepEqual(steps, ['writer thread', 'checkpoint thread', 'held rows', 'database left open for the exit']);
  assert.equal(statSync(`${b}-wal`).size, walB, 'the WAL as it was: nothing checkpointed');
  // The next start (here a second connection, the first still open as at an exit) reads every row.
  const next = new IndexStore(b, { aggRefreshMs: 0 });
  assert.equal(Number((next.db.prepare('SELECT COUNT(*) AS n FROM fills').get() as { n: number }).n), 100_000);
  next.close();
  console.log(`stop: WAL ${(walA / 1e6).toFixed(0)} MB, last close ${closeMs.toFixed(0)} ms; ${(walB / 1e6).toFixed(0)} MB left for the exit ${exitMs.toFixed(0)} ms`);
  // `b`'s first connection stays open until this process ends, as at a real exit; the folder is left in the temp dir.
});
