import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeForLog } from './log';

test('log redaction: secret-looking key names, however cased', () => {
  const out = sanitizeForLog({ key: 'a', privKey: 'b', pk: 'c', session_jwt: 'd', bearerToken: 'e', credentials: 'f', keyName: 'g', monkey: 'ok', apiKey: 'h' }) as Record<string, unknown>;
  for (const k of ['key', 'privKey', 'pk', 'session_jwt', 'bearerToken', 'credentials', 'keyName', 'apiKey']) assert.equal(out[k], '[redacted]', k);
  assert.equal(out.monkey, 'ok');
});

test('log redaction: bytes are counted, never copied', () => {
  assert.equal(sanitizeForLog(new Uint8Array(32)), '[bytes:32]');
  assert.equal(sanitizeForLog(new ArrayBuffer(65)), '[bytes:65]');
  assert.deepEqual(sanitizeForLog({ sealed: new Uint8Array([1, 2, 3]) }), { sealed: '[bytes:3]' });
});

test('log redaction: JWTs and bearer tokens inside free text and errors', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl';
  assert.equal(sanitizeForLog(`auth failed for ${jwt} (retry)`), 'auth failed for [jwt] (retry)');
  assert.equal(sanitizeForLog('header Authorization: Bearer abcdefgh12345678'), 'header Authorization: Bearer [redacted]');
  const e = sanitizeForLog(new Error(`bad token ${jwt}`)) as { message: string };
  assert.equal(e.message, 'bad token [jwt]');
  // Ordinary hashes and addresses stay readable for diagnostics.
  assert.equal(sanitizeForLog('tx 0x' + 'ab'.repeat(32)), 'tx 0x' + 'ab'.repeat(32));
});
