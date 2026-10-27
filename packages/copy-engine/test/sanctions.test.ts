import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SANCTIONED_LEADER_REASON,
  SANCTIONED_WALLET_REASON,
  SANCTIONS_LIST_META,
  _resetSanctionsForTests,
  _sanctionForTests,
  isSanctionedAddress,
  regionPolicy,
  sanctionedOf,
  screenPolicy,
} from '../src/index.ts';
import { SANCTIONED_ADDRESSES } from '../src/sanctionsList.ts';

/** On the oracle's list (a Lazarus Group address on OFAC's SDN list). */
const LISTED = '0x098b716b8aaf21512996dc57eb0615e2383e2f96';
const CLEAN = '0x1111111111111111111111111111111111111111';

test('the list in the repository: lower case, unique, counted, from the oracle', () => {
  assert.ok(SANCTIONED_ADDRESSES.length > 50, 'a list this short means the script read a short history');
  assert.equal(SANCTIONS_LIST_META.count, SANCTIONED_ADDRESSES.length);
  assert.equal(new Set(SANCTIONED_ADDRESSES).size, SANCTIONED_ADDRESSES.length);
  for (const a of SANCTIONED_ADDRESSES) assert.match(a, /^0x[0-9a-f]{40}$/);
  assert.match(SANCTIONS_LIST_META.source, /^chainalysis-oracle:0x40c57923924b5c5c5455c48d93317139addac8fb$/);
  assert.match(SANCTIONS_LIST_META.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
});

test('an address is listed in any case; anything else is not', () => {
  assert.ok(isSanctionedAddress(LISTED));
  assert.ok(isSanctionedAddress(LISTED.toUpperCase().replace('0X', '0x')));
  assert.equal(isSanctionedAddress(CLEAN), false);
  for (const bad of [undefined, null, 1, {}, '', LISTED.slice(2), `${LISTED}0`]) assert.equal(isSanctionedAddress(bad), false);
  assert.equal(sanctionedOf([]), null);
  assert.equal(sanctionedOf([CLEAN, null, LISTED]), 2);
});

test('screenPolicy: a listed follower or leader turns any policy into a refusal, with its reason', () => {
  const eea = regionPolicy('DE');
  assert.equal(screenPolicy(eea, CLEAN, CLEAN), eea);
  const follower = screenPolicy(eea, LISTED, CLEAN);
  assert.equal(follower.allowed, false);
  assert.equal(follower.region, 'blocked');
  assert.equal(follower.maxLeverage, null);
  assert.equal(follower.reason, SANCTIONED_WALLET_REASON);
  assert.equal(follower.country, 'DE');
  const leader = screenPolicy(regionPolicy('SG'), CLEAN, LISTED);
  assert.equal(leader.allowed, false);
  assert.equal(leader.reason, SANCTIONED_LEADER_REASON);
  // An already refused policy stays refused, now for the sanctions reason.
  assert.equal(screenPolicy(regionPolicy('US'), LISTED).reason, SANCTIONED_WALLET_REASON);
});

test('the test hook only ever adds to the list', () => {
  _sanctionForTests(CLEAN);
  assert.ok(isSanctionedAddress(CLEAN));
  _resetSanctionsForTests();
  assert.equal(isSanctionedAddress(CLEAN), false);
  assert.ok(isSanctionedAddress(LISTED));
});
