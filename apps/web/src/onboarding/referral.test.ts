/** What SoDEX's public eligibility answers mean for the code (referral.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REFERRAL_URL, referralState } from './referral';

const OURS = { inviterWalletAddress: '0xAbC0000000000000000000000000000000000001' };
const ME = '0x1110000000000000000000000000000000000002';

test('the link is SoDEX\'s own join page for our code', () => {
  assert.equal(REFERRAL_URL, 'https://sodex.com/join/VALUEDESK');
});

test('no inviter: the code can be applied', () => {
  assert.equal(referralState(ME, { inviterWalletAddress: '' }, OURS), 'none');
  assert.equal(referralState(ME, {}, OURS), 'none');
});

test('our code, in any spelling of the address: bound, or one signature left on SoDEX', () => {
  assert.equal(referralState(ME, { inviterWalletAddress: OURS.inviterWalletAddress.toLowerCase() }, OURS), 'bound');
  assert.equal(referralState(ME, { inviterWalletAddress: OURS.inviterWalletAddress, needSignature: true }, OURS), 'pending');
});

test('another inviter, or the wallet behind the code: nothing to offer', () => {
  assert.equal(referralState(ME, { inviterWalletAddress: '0xdef' }, OURS), 'other');
  assert.equal(referralState(OURS.inviterWalletAddress, { inviterWalletAddress: '' }, OURS), 'self');
});

test('SoDEX silent, or the code not live: nothing to offer', () => {
  assert.equal(referralState(ME, null, OURS), 'unknown');
  assert.equal(referralState(ME, { inviterWalletAddress: '' }, null), 'unknown');
  assert.equal(referralState(ME, { inviterWalletAddress: '' }, { inviterWalletAddress: '' }), 'unknown');
});
