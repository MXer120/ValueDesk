/**
 * tools/preflight.ts, ship.sh's check before it restarts the executor: the new code opens a
 * snapshot of the live database, never the file itself; a broken audit chain stops the release.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutorDb } from '../src/db.ts';
import { preflight } from '../tools/preflight.ts';

test('preflight: the counts health reports, the audit chain walked, the live file left as it was', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-preflight-'));
  try {
    const live = join(dir, 'executor.db');
    const db = new ExecutorDb(live);
    db.audit('process', null, null, { event: 'start' });
    db.audit('process', null, null, { event: 'stop' });
    db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = readFileSync(live);
    const r = await preflight(live);
    assert.deepEqual(r, { ok: true, copies: 0, active: 0, algos: 0, audit: { rows: 2, brokenAt: null } });
    db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.ok(readFileSync(live).equals(before), 'the live database is read, never written');

    db.db.prepare(`UPDATE audit SET data = '{"event":"forged"}' WHERE seq = 2`).run();
    const broken = await preflight(live);
    assert.equal(broken.ok, false);
    assert.equal(broken.audit?.brokenAt, 2);
    assert.match(broken.error ?? '', /audit chain breaks at row 2/);
    db.close();

    const missing = await preflight(join(dir, 'nope', 'executor.db'));
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? '', /no database/);

    // --keep: the snapshot as taken, before the new code opened anything; never written over.
    const fresh = join(dir, 'fresh.db');
    const f = new ExecutorDb(fresh);
    f.audit('process', null, null, { event: 'start' });
    f.close();
    const keep = join(dir, 'pre-release', 'executor-before-v1.db');
    const kept = await preflight(fresh, { keep });
    assert.equal(kept.ok, true);
    assert.equal(kept.kept, keep);
    const k = new ExecutorDb(keep);
    assert.equal(k.verifyAudit().rows, 1, 'the kept copy holds the data');
    k.close();
    const again = await preflight(fresh, { keep });
    assert.equal(again.ok, false);
    assert.match(again.error ?? '', /never written over/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
