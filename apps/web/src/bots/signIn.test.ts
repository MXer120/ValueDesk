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
