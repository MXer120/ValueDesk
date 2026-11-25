import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashTypedData } from '@sodex-core';
import { INVITE_STATEMENT, inviteTypedData } from '@sign/invites/claim';
import { inviteJoinDigest } from '@sign/invites/check';
import { inviteLink, inviteParam, withInvite } from './invites';
import { INVITE_KEY, KEEP_MS, OWN_KEY, keepInvite, pendingInvite, writeInvite } from './capture';

test('the referral parameter: a SoDEX code, any case, never ValueDesk\'s own', () => {
  assert.equal(inviteParam('?ref=WNQITYUE'), 'WNQITYUE');
  assert.equal(inviteParam('?x=1&ref=wnqityue'), 'WNQITYUE');
  assert.equal(inviteParam('?ref=VALUEDESK'), null, 'our own code refers nobody');
  assert.equal(inviteParam('?ref=ab'), null);
  assert.equal(inviteParam('?ref=a-b-c-d'), null);
  assert.equal(inviteParam(''), null);
});

function store(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
}

test('a link\'s code is kept at once, unasked; the first checked one stands; an own code never', () => {
  const s = store();
  assert.equal(keepInvite('?ref=eddie', 1_000, s), 'EDDIE');
  assert.deepEqual(pendingInvite(1_000, s), { code: 'EDDIE', at: 1_000, welcome: true, vipDays: 0, checked: false });
  // Not asked about yet: the newer link is the one the visitor followed.
  assert.equal(keepInvite('?ref=WNQITYUE', 2_000, s), 'WNQITYUE');
  writeInvite({ ...pendingInvite(2_000, s)!, vipDays: 7, checked: true }, s);
  assert.equal(keepInvite('?ref=EDDIE', 3_000, s), 'WNQITYUE');
  assert.equal(pendingInvite(3_000, s)!.vipDays, 7);
  // The same link again changes nothing; no code, ours, or an own one keeps nothing.
  assert.equal(keepInvite('?ref=WNQITYUE', 4_000, s), 'WNQITYUE');
  assert.equal(pendingInvite(4_000, s)!.at, 2_000);
  for (const q of ['', '?x=1', '?ref=VALUEDESK']) assert.equal(keepInvite(q, 1, store()), null);
  assert.equal(keepInvite('?ref=EDDIE', 1, store({ [OWN_KEY]: '["EDDIE"]' })), null);
  // One older than KEEP_MS is let go; one kept before 2026-11-25 was checked.
  assert.equal(pendingInvite(2_000 + KEEP_MS, s), null);
  assert.equal(pendingInvite(10, store({ [INVITE_KEY]: '{"code":"EDDIE","at":1}' }))!.checked, true);
  // No storage: nothing kept, nothing thrown.
  assert.equal(pendingInvite(1, null), null);
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
