/** A failed sign-in in words (signIn.ts), never the server's raw text (owner 2026-11-09). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutorError } from '../copy/executor';
import { signInWords } from './signIn';

test('a failed sign-in reads as words; a cancelled one says nothing', () => {
  assert.match(signInWords(new ExecutorError('method not allowed', 405, 'method'))!, /did not answer the sign-in just now/);
  assert.match(signInWords(new ExecutorError('x', 503, 'starting'))!, /Your bots keep running/);
  assert.equal(signInWords(new Error('User rejected the request.')), null);
  assert.match(signInWords(new Error('Failed to fetch'))!, /got no answer/);
  assert.equal(signInWords(new Error('Your wallet is locked.')), 'Your wallet is locked.');
  assert.equal(signInWords(new Error('{"error":"x"}')), 'The sign-in did not go through. Try again.');
});

test('the executor\'s signature refusals each say what to do (owner 2026-11-28); others stay plain, never raw', () => {
  const sig = (m: string) => signInWords(new ExecutorError(m, 401, 'signature'));
  assert.match(sig('the request time is too far from now; check your clock')!, /clock is off/);
  assert.match(sig("this request has expired; sign it again (if it keeps happening, check your computer's clock: it may be behind)")!, /5 minutes ran out/);
  assert.match(sig('this request was signed for another executor')!, /changed servers/);
  assert.match(sig("the day key's approval does not hold: expired")!, /daily key/);
  assert.match(sig('the signature is not from this wallet')!, /another account than the connected one/);
  assert.equal(sig('payload is not in canonical form'), 'The sign-in did not go through. Try again.');
});
