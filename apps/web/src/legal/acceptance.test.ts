import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJSON, type AcceptSiteTermsPayload } from '@copy-engine';
import { bytesToHex, keccak256, utf8 } from '@sodex-core';
import { RISK } from './risk';
import { TERMS } from './terms';
import {
  BROWSE_STATEMENTS,
  SITE_TERMS_HASH,
  SITE_TERMS_VERSION,
  TRADE_STATEMENTS,
  _resetAcceptanceForTests,
  acceptBrowse,
  acceptedBefore,
  browseAccepted,
  countryProblem,
  signedTerms,
  siteTermsPayload,
} from './acceptance';
import { placeholdersIn } from './model';

test('the pinned fingerprint is the keccak256 of the terms and the risk disclosure as shipped', () => {
  const hash = bytesToHex(keccak256(utf8(canonicalJSON({ terms: TERMS, risk: RISK }))));
  assert.equal(
    SITE_TERMS_HASH,
    hash,
    `terms.ts or risk.ts changed: every visitor and every trading wallet must accept them again. Raise SITE_TERMS_VERSION in legal/acceptance.ts (a date, or ${SITE_TERMS_VERSION}.2 on the same day) and set SITE_TERMS_HASH to ${hash}.`,
  );
  assert.match(SITE_TERMS_VERSION, /^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
});

test('the statements: complete, each a full sentence, no placeholder; the signed ones are exactly AcceptSiteTermsPayload\'s', () => {
  const payload: AcceptSiteTermsPayload = siteTermsPayload('de');
  const flags = Object.entries(payload).filter(([, v]) => v === true).map(([k]) => k).sort();
  assert.deepEqual(TRADE_STATEMENTS.map((s) => s.id).sort(), flags);
  assert.equal(payload.country, 'DE');
  assert.equal(payload.termsVersion, SITE_TERMS_VERSION);
  assert.equal(payload.termsHash, SITE_TERMS_HASH);
  for (const s of [...BROWSE_STATEMENTS, ...TRADE_STATEMENTS]) {
    assert.ok(s.label.length > 40 && s.label.endsWith('.'), s.id);
  }
  assert.deepEqual(placeholdersIn([BROWSE_STATEMENTS, TRADE_STATEMENTS]), []);
  assert.ok(BROWSE_STATEMENTS[0]!.label.includes('(/terms)') && BROWSE_STATEMENTS[0]!.label.includes('(/risk)') && BROWSE_STATEMENTS[0]!.label.includes('(/privacy)'));
  assert.throws(() => siteTermsPayload('Germany'), /country/);
});

test('a restricted country of residence cannot sign; others can', () => {
  for (const c of ['IR', 'KP', 'RU', 'US', 'PR', 'gu']) assert.ok(countryProblem(c), c);
  for (const c of ['DE', 'SG', 'UA', 'JP', 'GB', 'CA']) assert.equal(countryProblem(c), null, c);
});

test('the first-visit acceptance: every statement, the current version only', () => {
  _resetAcceptanceForTests();
  assert.equal(browseAccepted(), null);
  assert.throws(() => acceptBrowse(['agree', 'risk']), /every statement/);
  const r = acceptBrowse(['risk', 'eligible', 'agree'], 1_700_000_000_000);
  assert.deepEqual(r, { termsVersion: SITE_TERMS_VERSION, termsHash: SITE_TERMS_HASH, acceptedAt: 1_700_000_000_000, statements: ['agree', 'eligible', 'risk'] });
  assert.deepEqual(browseAccepted(), r);
  assert.equal(acceptedBefore(), false);
  assert.equal(signedTerms('0xabc'), null, 'no wallet has signed');
  assert.equal(signedTerms(null), null);
  _resetAcceptanceForTests();
});
