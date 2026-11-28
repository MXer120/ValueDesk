/** Requests are signed on the executors' clock once the device is more than 30 s off (executor.ts, owner 2026-11-28). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteServerTime, serverNow } from './executor';

test('a device clock minutes off signs on the server\'s time; one within 30 s keeps its own', () => {
  const now = Date.now();
  // The server says 7 minutes later than the device (a phone's clock behind).
  noteServerTime(new Date(now + 7 * 60_000).toUTCString(), null, now, now);
  assert.ok(Math.abs(serverNow() - (now + 7 * 60_000)) < 3_000);
  // A cached copy's Age counts: Date 10 min ago, kept 10 min - the server's now is the device's.
  noteServerTime(new Date(now - 10 * 60_000).toUTCString(), '600', now, now);
  assert.ok(Math.abs(serverNow() - Date.now()) < 1_000);
  // Within 30 s, or no Date at all: the device's own clock.
  noteServerTime(new Date(now + 20_000).toUTCString(), null, now, now);
  assert.ok(Math.abs(serverNow() - Date.now()) < 1_000);
  noteServerTime(new Date(now - 9 * 60_000).toUTCString(), null, now, now);
  noteServerTime(null, null, now, now);
  assert.ok(Math.abs(serverNow() - (now - 9 * 60_000)) < 3_000, 'an answer without Date keeps the last offset');
});
