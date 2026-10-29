/**
 * The executor keeps what a follower should hear of (db.ts notices, from copy-engine notices.ts):
 * once per id, a wallet's own only, newest first, by grade, a page before a time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutorDb } from '../src/db.ts';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const n = (o: Partial<{ id: string; owner: string; grade: 'info' | 'warn' | 'error'; at: number }> = {}) => ({
  id: 'algo:al_1:failed:1000', owner: A, source: 'algo' as const, ref: 'al_1', kind: 'failed' as const, grade: 'error' as const,
  title: 'TWAP sell on BTC-USD failed', body: 'No margin.', at: 1_000, paper: false, ...o,
});

test('notices: once each, the wallet\'s own, newest first, by grade and page', () => {
  const db = new ExecutorDb(':memory:');
  db.addNotice(n());
  db.addNotice(n());
  db.addNotice(n({ id: 'b', grade: 'warn', at: 2_000 }));
  db.addNotice(n({ id: 'c', grade: 'info', at: 3_000, owner: B }));
  assert.deepEqual(db.notices(A).map((x) => x.id), ['b', 'algo:al_1:failed:1000']);
  assert.deepEqual(db.notices(A, { grades: ['error'] }).map((x) => x.id), ['algo:al_1:failed:1000']);
  assert.deepEqual(db.notices(A, { before: 2_000 }).map((x) => x.id), ['algo:al_1:failed:1000']);
  assert.deepEqual(db.notices(B).map((x) => x.grade), ['info']);
  assert.equal(db.notices(A)[0]!.paper, false);
  db.close();
});
