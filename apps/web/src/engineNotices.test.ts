/**
 * Engine notices in the bell: a trading key about to expire offers its renewal in the row (owner 2026-11-09).
 * Run (from apps/web): npx tsx --test src/engineNotices.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EngineNotice } from '@copy-engine';
import { noticeRow } from './engineNotices';

const base: EngineNotice = {
  id: 'n1', owner: '0x' + '11'.repeat(20), source: 'algo', ref: 'a1', kind: 'done', grade: 'info',
  title: 'Done', body: '', at: 1, paper: false,
} as EngineNotice;

test('a key-expiry notice carries the renew action; others carry none', () => {
  const row = noticeRow({ ...base, kind: 'key-expiry', grade: 'warn', title: 'Your trading key expires in 14 days' }, 'executor' as never);
  assert.equal(row.action, 'renew-key');
  assert.equal(noticeRow(base, 'executor' as never).action, undefined);
});
