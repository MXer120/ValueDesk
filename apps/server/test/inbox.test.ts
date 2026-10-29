/**
 * Run: npx tsx --test test/inbox.test.ts   (from apps/server)
 *
 * A wallet's inbox (ops/inbox.ts): a browser's batch is checked field by field and only its own
 * wallet's notices are kept, once each; read back newest first, by grade, a page at a time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InboxStore, parseInboxBatch } from '../src/ops/inbox.js';

const W = `0x${'a'.repeat(40)}`;
const T = Date.UTC(2026, 9, 29, 1, 0, 0);
const n = (o: Record<string, unknown> = {}) => ({ id: `algo:al_1:failed:${T}`, owner: W, source: 'algo', ref: 'al_1', kind: 'failed', grade: 'error', title: 'TWAP sell on BTC-USD failed', body: 'No margin.', at: T, paper: false, ...o });

test('a batch: only the signed-in wallet\'s notices, each checked; too many or none refused', () => {
  const r = parseInboxBatch({ notices: [n(), n({ id: 'x', owner: `0x${'b'.repeat(40)}` }), n({ id: 'y', grade: 'fatal' }), n({ id: 'z', at: T + 3_600_000 }), n({ id: 'w', title: '' })] }, W, T);
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.notices.map((x) => x.id), [`algo:al_1:failed:${T}`], 'another wallet, a bad grade, a time far ahead, no title: dropped');
  assert.equal(parseInboxBatch({ notices: [] }, W, T).ok, false);
  assert.equal(parseInboxBatch({ notices: Array.from({ length: 51 }, (_, i) => n({ id: String(i) })) }, W, T).ok, false);
  assert.equal(parseInboxBatch({ notices: [n({ owner: W.toUpperCase().replace('0X', '0x') })] }, W, T).ok && true, true, 'owner compared without case');
});

test('the store: once per id, newest first, by grade, a page before a time', () => {
  const s = new InboxStore(':memory:');
  const rows = [n(), n({ id: 'b', grade: 'warn', at: T - 60_000 }), n({ id: 'c', grade: 'info', at: T - 120_000, source: 'copy', ref: 'cp_1' })];
  const ok = (x: Record<string, unknown>) => parseInboxBatch({ notices: [x] }, W, T);
  const parsed = rows.map((x) => { const p = ok(x); assert.ok(p.ok); return p.ok ? p.notices[0]! : null!; });
  assert.equal(s.add(W, parsed, T), 3);
  assert.equal(s.add(W, parsed, T), 0, 'the same notices again: nothing new');
  assert.deepEqual(s.list(W).map((x) => x.id), [`algo:al_1:failed:${T}`, 'b', 'c']);
  assert.deepEqual(s.list(W, { grades: ['warn', 'error'] }).map((x) => x.grade), ['error', 'warn']);
  assert.deepEqual(s.list(W, { before: T - 30_000, limit: 1 }).map((x) => x.id), ['b']);
  assert.deepEqual(s.list(`0x${'b'.repeat(40)}`), [], 'another wallet reads nothing');
  assert.equal(s.list(W)[2]!.source, 'copy');
  s.close();
});
