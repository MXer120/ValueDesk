/**
 * Who sees the first-signup flow, and what it remembers (model.ts). The walk itself, with a wallet
 * that really signs, is e2e/ui/onboarding.spec.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, decide, markProfileSeen, markSetupDone, profileSeen, readProgress, setupDoneBefore, stepsOf, writeProgress } from './model';

const fresh = { progress: null, setupDone: false, username: null, known: false, offerReferral: false };

function memory(): Pick<Storage, 'getItem' | 'setItem'> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

test('a new wallet on a new browser starts at the username', () => {
  assert.equal(decide(fresh), 'username');
});

test('a returning user never sees it: a used browser, a name, or orders through ValueDesk', () => {
  assert.equal(decide({ ...fresh, setupDone: true }), null);
  assert.equal(decide({ ...fresh, username: 'Luke_1' }), null);
  assert.equal(decide({ ...fresh, known: true }), null);
});

test('finished or skipped: closed for good, whatever else is true', () => {
  assert.equal(decide({ ...fresh, progress: { step: 'theme', closed: true } }), null);
  assert.equal(decide({ ...fresh, progress: { step: 'username', closed: true } }), null);
});

test('stopped half way: it resumes there, with the name taken or not', () => {
  assert.equal(decide({ ...fresh, progress: { step: 'heatmap', closed: false }, username: 'Luke_1', setupDone: false }), 'heatmap');
  assert.equal(decide({ ...fresh, progress: { step: 'username', closed: false } }), 'username');
});

test('stopped on the username, and the name was taken elsewhere: on to the next step', () => {
  assert.equal(decide({ ...fresh, progress: { step: 'username', closed: false }, username: 'Luke_1' }), 'traders');
});

test('the steps: username and referral only when they apply, dark or light last', () => {
  assert.deepEqual([...STEPS], ['username', 'referral', 'traders', 'copy', 'heatmap', 'flow', 'overview', 'theme']);
  assert.deepEqual(stepsOf(false, true).slice(0, 3), ['username', 'referral', 'traders']);
  assert.deepEqual(stepsOf(false, false).slice(0, 2), ['username', 'traders']);
  assert.deepEqual(stepsOf(true, false).slice(0, 1), ['traders']);
  assert.equal(stepsOf(true, true)[0], 'referral');
  assert.equal(stepsOf(false, false).at(-1), 'theme');
});

test('stopped on a referral step the wallet no longer needs: the next step that applies', () => {
  assert.equal(decide({ ...fresh, progress: { step: 'referral', closed: false }, username: 'Luke_1' }), 'traders');
  assert.equal(decide({ ...fresh, progress: { step: 'referral', closed: false }, username: 'Luke_1', offerReferral: true }), 'referral');
});

test('the green dot is done once Profile was opened, per wallet', () => {
  const s = memory();
  assert.equal(profileSeen('0xABC', s), false);
  markProfileSeen('0xabc', s);
  assert.equal(profileSeen('0xABC', s), true);
  assert.equal(profileSeen('0xdef', s), false);
});

test('progress is per wallet, any case, and survives junk', () => {
  const s = memory();
  writeProgress('0xABC', { step: 'flow', closed: false }, s);
  assert.deepEqual(readProgress('0xabc', s), { step: 'flow', closed: false });
  assert.equal(readProgress('0xdef', s), null);
  s.setItem('vs.onboard.v1.0xbad', '{nope');
  assert.equal(readProgress('0xbad', s), null);
  s.setItem('vs.onboard.v1.0xodd', JSON.stringify({ step: 'gone', closed: 1 }));
  assert.deepEqual(readProgress('0xodd', s), { step: 'username', closed: false });
});

test('setup done is the mark of a used browser, and the flow sets it', () => {
  const s = memory();
  assert.equal(setupDoneBefore(s), false);
  markSetupDone(s);
  assert.equal(setupDoneBefore(s), true);
});

test('no storage at all: nobody is trapped in a flow that cannot remember', () => {
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(setupDoneBefore(broken), true);
  assert.equal(readProgress('0xabc', broken), null);
  writeProgress('0xabc', { step: 'flow', closed: false }, broken);
});
