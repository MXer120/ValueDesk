/** A failed sign-in in words with an error code (signIn.ts), never the server's raw text (owner 2026-11-09, 2026-11-28). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutorError } from '../copy/executor';
import { signInCode, signInWords } from './signIn';

test('a failed sign-in is one sentence with its code; a cancelled one says nothing', () => {
  assert.equal(signInWords(new Error('User rejected the request.')), null);
  assert.equal(signInWords(new ExecutorError('method not allowed', 405, 'method')), 'The sign-in did not go through. Try again. Code: DOWN');
  assert.equal(signInCode(new ExecutorError('x', 503, 'starting')), 'DOWN');
  assert.equal(signInCode(new ExecutorError('slow down', 429, 'rate')), 'BUSY');
  assert.equal(signInCode(new ExecutorError('The ValueDesk executor could not be reached. Try again in a moment.', 0, 'network')), 'NET');
  assert.equal(signInCode(new Error('Failed to fetch')), 'NET');
  assert.equal(signInCode(new Error('Your wallet is locked.')), 'WALLET');
  assert.equal(signInCode(new ExecutorError('This signed request was already used. Sign it again.', 409, 'replay')), 'HTTP-409');
});

test('each signature refusal of the executor has its own code (owner 2026-11-28)', () => {
  const sig = (m: string) => signInCode(new ExecutorError(m, 401, 'signature'));
  assert.equal(sig('the request time is too far from now; check your clock'), 'SIG-CLOCK');
  assert.equal(sig("this request has expired; sign it again (if it keeps happening, check your computer's clock: it may be behind)"), 'SIG-LATE');
  assert.equal(sig('this request was signed for another executor'), 'SIG-SERVER');
  assert.equal(sig("the day key's approval does not hold: expired"), 'SIG-DAYKEY');
  assert.equal(sig('the signature is not from this wallet'), 'SIG-ACCOUNT');
  assert.equal(sig('payload is not in canonical form'), 'SIG-OTHER');
});
