import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashTypedData } from '@sodex-core';
import { INVITE_STATEMENT, inviteTypedData } from '@sign/invites/claim';
import { inviteJoinDigest } from '@sign/invites/check';
import { inviteLink, inviteParam, withInvite } from './invites';

test('the invite parameter: a real code only, any case', () => {
  assert.equal(inviteParam('?i=abcd2345'), 'abcd2345');
  assert.equal(inviteParam('?x=1&i=ABCD2345'), 'abcd2345');
  assert.equal(inviteParam('?i=abcd0345'), null, '0 is not in the alphabet');
  assert.equal(inviteParam('?i=short'), null);
  assert.equal(inviteParam(''), null);
});

test('links: the site with ?i=, and a share card link keeps its own parameters', () => {
  assert.equal(inviteLink('abcd2345'), 'https://valuedesk.so/?i=abcd2345');
  assert.equal(withInvite('https://valuedesk.so/bots/new?market=SOL-USD&kind=gridv', 'abcd2345'), 'https://valuedesk.so/bots/new?market=SOL-USD&kind=gridv&i=abcd2345');
});

test('what the wallet signs is exactly what the server checks (typed data = the server digest)', () => {
  const f = { wallet: '0x00000000000000000000000000000000000000a1', code: 'abcd2345', statement: INVITE_STATEMENT, nonce: 'b'.repeat(32), issuedAt: '1800000000000', expiresAt: '1800000300000', chainId: 286623 };
  const td = inviteTypedData(f);
  assert.deepEqual(Buffer.from(hashTypedData(td as unknown as Parameters<typeof hashTypedData>[0])).toString('hex'), Buffer.from(inviteJoinDigest(f)).toString('hex'));
});
