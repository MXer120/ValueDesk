import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashTypedData } from '@sodex-core';
import { INVITE_STATEMENT, inviteTypedData } from '@sign/invites/claim';
import { inviteJoinDigest } from '@sign/invites/check';
import { inviteLink, inviteParam, withInvite } from './invites';

test('the referral parameter: a SoDEX code, any case, never ValueDesk\'s own', () => {
  assert.equal(inviteParam('?ref=WNQITYUE'), 'WNQITYUE');
  assert.equal(inviteParam('?x=1&ref=wnqityue'), 'WNQITYUE');
  assert.equal(inviteParam('?ref=VALUEDESK'), null, 'our own code refers nobody');
  assert.equal(inviteParam('?ref=ab'), null);
  assert.equal(inviteParam('?ref=a-b-c-d'), null);
  assert.equal(inviteParam(''), null);
});

test('links: the site with ?ref=, and a share card link keeps its own parameters', () => {
  assert.equal(inviteLink('WNQITYUE'), 'https://valuedesk.so/?ref=WNQITYUE');
  assert.equal(withInvite('https://valuedesk.so/bots/new?market=SOL-USD&kind=gridv', 'WNQITYUE'), 'https://valuedesk.so/bots/new?market=SOL-USD&kind=gridv&ref=WNQITYUE');
});

test('what the wallet signs is exactly what the server checks (typed data = the server digest)', () => {
  const f = { wallet: '0x00000000000000000000000000000000000000a1', code: 'WNQITYUE', statement: INVITE_STATEMENT, nonce: 'b'.repeat(32), issuedAt: '1800000000000', expiresAt: '1800000300000', chainId: 286623 };
  const td = inviteTypedData(f);
  assert.deepEqual(Buffer.from(hashTypedData(td as unknown as Parameters<typeof hashTypedData>[0])).toString('hex'), Buffer.from(inviteJoinDigest(f)).toString('hex'));
});
