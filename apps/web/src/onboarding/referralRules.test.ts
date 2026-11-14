import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFER_REST_MS, WE_GET, YOU_GET, mayAttachCode, shouldOffer } from './referralRules';

test('the VALUEDESK popup opens only for a wallet SoDEX says has no inviter, and rests after "Not now"', () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldOffer('none', null, now), true);
  for (const s of ['other', 'self', 'unknown', 'pending', 'bound'] as const) assert.equal(shouldOffer(s, null, now), false, s);
  assert.equal(shouldOffer('none', now - 1_000, now), false, 'answered a moment ago');
  assert.equal(shouldOffer('none', now - OFFER_REST_MS, now), true, 'asked again after the rest');
});

test('the code rides on a request only where the wallet may take it (never over another inviter, never unverified)', () => {
  assert.deepEqual((['none', 'pending', 'bound', 'other', 'self', 'unknown'] as const).map(mayAttachCode), [true, true, true, false, false, false]);
});

test('every benefit says where it comes from (no number of ours), and what ValueDesk gets is said', () => {
  for (const b of [...YOU_GET, ...WE_GET]) assert.match(b.source.url, /^https:\/\/(docs\.sodex\.com|sodex-support\.zendesk\.com)\//, b.title);
  assert.ok(WE_GET.length >= 1);
});
