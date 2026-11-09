// node --test deploy/release/indexer-gate.test.mjs
//
// ship.sh's indexer gate (deploy/release/indexer-gate.mjs): from one reading a minute of the indexer's published
// status, whether the release is rolled back - its status going stale, its thread held 3 minutes in a row, its write
// backlog rising 3 minutes in a row - and nothing for the ordinary: a backlog that drains, a single long pause, a field
// an older indexer does not publish. Then the command ship.sh runs, on a file of readings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKLOG_MIN, LAG_MS, STALE_MS, judgeIndexerGate } from './indexer-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const MIN = 60_000;
/** Readings a minute apart, each published 10 s before it was read. */
const minutes = (rows) => rows.map((r, i) => ({ now: T0 + i * MIN, at: T0 + i * MIN - 10_000, backlog: 0, lag: 300, ...r }));

test('ordinary minutes after a restart: no rollback', () => {
  // The spill of the last stop written first: a big backlog that drains.
  assert.equal(judgeIndexerGate(minutes([{ backlog: 9_000 }, { backlog: 6_000 }, { backlog: 6_500 }, { backlog: 2_000 }, { backlog: 0 }])).rollback, false);
  // One long pause (a first build's step), then ordinary ones.
  assert.equal(judgeIndexerGate(minutes([{ lag: 40_000 }, { lag: 400 }, { lag: 20_000 }, { lag: 300 }])).rollback, false);
  // A handful of steps going up is noise.
  assert.equal(judgeIndexerGate(minutes([{ backlog: 1 }, { backlog: 2 }, { backlog: 3 }, { backlog: 4 }])).rollback, false);
  assert.equal(judgeIndexerGate([]).rollback, false);
});

test('the write backlog rising three minutes in a row rolls back; a flat minute in between does not', () => {
  const v = judgeIndexerGate(minutes([{ backlog: 50 }, { backlog: 300 }, { backlog: 900 }, { backlog: 2_400 }]));
  assert.equal(v.rollback, true);
  assert.match(v.why, /backlog rose 3 minutes in a row \(50 -> 300 -> 900 -> 2400 steps\)/);
  assert.equal(judgeIndexerGate(minutes([{ backlog: 300 }, { backlog: 900 }, { backlog: 900 }, { backlog: 2_400 }])).rollback, false);
  // Only three readings: two rises so far.
  assert.equal(judgeIndexerGate(minutes([{ backlog: 300 }, { backlog: 900 }, { backlog: 2_400 }])).rollback, false);
  // Under the floor at the end.
  assert.equal(judgeIndexerGate(minutes([{ backlog: 10 }, { backlog: 20 }, { backlog: 40 }, { backlog: BACKLOG_MIN - 1 }])).rollback, false);
});

test('the thread held 15 s or more three minutes in a row rolls back (past the start-up grace)', () => {
  const v = judgeIndexerGate(minutes([{ lag: 300 }, { lag: LAG_MS }, { lag: 22_000 }, { lag: 16_000 }]), { lagGraceMs: 0 });
  assert.equal(v.rollback, true);
  assert.match(v.why, /each of the last 3 minutes \(worst 22000 ms\)/);
  assert.equal(judgeIndexerGate(minutes([{ lag: LAG_MS }, { lag: LAG_MS - 1 }, { lag: LAG_MS }]), { lagGraceMs: 0 }).rollback, false);
});

test('pauses in the first 10 minutes are the start catching up (v0.2.202, 2026-11-09: 14-63 s); from minute 10 they count', () => {
  const startUp = Array.from({ length: 10 }, () => ({ lag: 40_000 }));
  assert.equal(judgeIndexerGate(minutes(startUp)).rollback, false, 'held every minute while it catches up: not judged');
  assert.equal(judgeIndexerGate(minutes([...startUp, { lag: 300 }, { lag: 500 }])).rollback, false, 'then ordinary');
  const v = judgeIndexerGate(minutes([...startUp, { lag: 20_000 }, { lag: 18_000 }, { lag: 16_000 }]));
  assert.equal(v.rollback, true, 'still held three minutes after the grace');
  // The other rules know no grace: a stale status or a rising backlog in the first minutes rolls back as before.
  assert.equal(judgeIndexerGate(minutes([{ backlog: 50 }, { backlog: 300 }, { backlog: 900 }, { backlog: 2_400 }])).rollback, true);
});

test('a status over 180 s old rolls back at once; none at all too', () => {
  const v = judgeIndexerGate([{ now: T0, at: T0 - STALE_MS - 1_000, backlog: 0, lag: 0 }]);
  assert.equal(v.rollback, true);
  assert.match(v.why, /published no status for 181 s/);
  assert.equal(judgeIndexerGate([{ now: T0, at: T0 - STALE_MS, backlog: 0, lag: 0 }]).rollback, false, 'at the limit');
  assert.equal(judgeIndexerGate([{ now: T0, at: null }]).why, 'published no status');
});

test('fields an indexer does not publish are judged as nothing', () => {
  assert.equal(judgeIndexerGate(minutes([{ backlog: null, lag: null }, { backlog: null, lag: null }, { backlog: null, lag: null }, { backlog: null, lag: null }])).rollback, false);
  assert.equal(judgeIndexerGate([{}, {}, {}, {}]).rollback, false, 'unreadable lines');
});

test('the command ship.sh runs: ok with a summary, or rollback with why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-ixgate-'));
  const run = (rows) => {
    const f = join(dir, `r${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(f, `${rows.map((r) => JSON.stringify(r)).join('\n')}\nnot json\n`);
    return spawnSync(process.execPath, [join(HERE, 'indexer-gate.mjs'), f], { encoding: 'utf8' });
  };
  const ok = run(minutes([{ backlog: 40, lag: 900 }, { backlog: 10, lag: 2_000 }]));
  assert.equal(ok.status, 0);
  // The unreadable last line is no reading: left out.
  assert.equal(ok.stdout.trim(), 'ok: 2 readings, write backlog at most 40 steps, longest pause 2000 ms');
  const bad = run([{ now: T0, at: T0 - 10 * MIN }]);
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout.trim(), 'rollback: published no status for 600 s');
  const stale = spawnSync(process.execPath, [join(HERE, 'indexer-gate.mjs'), join(dir, 'missing.jsonl')], { encoding: 'utf8' });
  assert.equal(stale.status, 2);
});
