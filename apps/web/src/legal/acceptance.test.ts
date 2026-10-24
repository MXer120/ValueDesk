import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SITE_TERMS_EXECUTOR, canonicalJSON, verifyCopyRequest, type AcceptSiteTermsPayload } from '@copy-engine';
import { bytesToHex, generateTradingKey, hexToBytes, keccak256, signTypedDataWithKey, utf8 } from '@sodex-core';
import { RISK } from './risk';
import { TERMS } from './terms';
import {
  SITE_TERMS_HASH,
  SITE_TERMS_VERSION,
  STATEMENTS,
  _resetAcceptanceForTests,
  acceptBrowse,
  acceptedBefore,
  browseAccepted,
  TermsNotAccepted,
  countryProblem,
  lookAround,
  lookedAround,
  requireTerms,
  requireTermsOrThrow,
  setTermsGate,
  signSiteTerms,
  signedTerms,
  signedText,
  siteTermsPayload,
  type TermsRequest,
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

test('one list of statements: ticked without a wallet, signed with one - exactly the flags of AcceptSiteTermsPayload', () => {
  const payload: AcceptSiteTermsPayload = siteTermsPayload('de');
  const flags = Object.entries(payload).filter(([, v]) => v === true).map(([k]) => k).sort();
  assert.deepEqual(STATEMENTS.map((s) => s.id).sort(), flags);
  assert.equal(payload.country, 'DE');
  assert.equal(payload.termsVersion, SITE_TERMS_VERSION);
  assert.equal(payload.termsHash, SITE_TERMS_HASH);
  for (const s of STATEMENTS) assert.ok(s.label.length > 40 && s.label.endsWith('.'), s.id);
  assert.deepEqual(placeholdersIn(STATEMENTS), []);
  assert.ok(STATEMENTS[0]!.label.includes('(/terms)') && STATEMENTS[0]!.label.includes('(/risk)') && STATEMENTS[0]!.label.includes('(/privacy)'));
  assert.throws(() => siteTermsPayload('Germany'), /country/);
});

test('the wallet signs the statements word for word, without link syntax, with the version, the fingerprint and the country', () => {
  const text = siteTermsPayload('SG').text;
  assert.equal(text, signedText('SG'));
  assert.ok(text.includes(`version ${SITE_TERMS_VERSION}`) && text.includes(SITE_TERMS_HASH));
  assert.ok(text.includes('Country of residence: SG.'));
  assert.ok(text.includes('I agree to the Terms of use and the Risk disclosure, and have read the Privacy policy.'));
  assert.ok(STATEMENTS.every((s) => s.label.length <= 130), 'each statement stays one short line in the gate');
  assert.doesNotMatch(text, /\]\(/, 'no markdown links');
  assert.match(text, /not a transaction and moves no funds/);
  assert.ok(text.length > 40 && text.length <= 4000, 'within what the executor accepts');
});

test('signing: ONE free wallet signature (typed data, no transaction) that verifies for ValueDesk\'s terms, kept here and counted as this browser\'s acceptance', async () => {
  _resetAcceptanceForTests();
  const key = generateTradingKey();
  const owner = key.address.toLowerCase();
  const calls: string[] = [];
  const wallet = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      calls.push(method);
      if (method === 'eth_chainId') return '0xa4b1';
      if (method === 'eth_signTypedData_v4') {
        const td = JSON.parse((params as [string, string])[1]);
        const raw = hexToBytes(signTypedDataWithKey(td, key.privateKey)).slice(1);
        raw[64] = raw[64]! + 27;
        return bytesToHex(raw);
      }
      throw new Error(`unexpected wallet call ${method}`);
    },
  };
  const t = await signSiteTerms({ provider: wallet, owner, country: 'sg' });
  assert.deepEqual(calls, ['eth_chainId', 'eth_signTypedData_v4'], 'a signature only - never eth_sendTransaction');
  const v = verifyCopyRequest(t.request, { executor: SITE_TERMS_EXECUTOR });
  assert.ok(v.ok, v.ok ? '' : v.error);
  assert.equal(t.request.action, 'accept-site-terms');
  const payload = JSON.parse(t.request.payload) as AcceptSiteTermsPayload;
  assert.equal(payload.text, signedText('SG'), 'the readable statements are what the wallet signed');
  assert.equal(signedTerms(owner)?.country, 'SG');
  assert.equal(t.recorded, false, 'no executor in this test: kept, to be sent again');
  assert.equal(browseAccepted()?.signedBy, owner, 'the signature is this browser\'s acceptance too');
  await assert.rejects(signSiteTerms({ provider: wallet, owner, country: 'US' }), /United States/);
  _resetAcceptanceForTests();
});

test('looking around first: nothing accepted, the popup stays closed for this version, and an action asks the popup (its answer decides)', async () => {
  _resetAcceptanceForTests();
  assert.equal(lookedAround(), false);
  lookAround();
  assert.equal(lookedAround(), true);
  assert.equal(browseAccepted(), null, 'looking around accepts nothing');
  // Outside a browser and without the popup: nobody to ask (the tests, the Node runner).
  assert.equal(await requireTerms({ reason: 'place this order' }), true);
  const asked: TermsRequest[] = [];
  let answer = false;
  setTermsGate(async (r) => {
    asked.push(r);
    return answer;
  });
  assert.equal(await requireTerms({ owner: '0xabc', reason: 'make this deposit' }), false, 'closed: the action is dropped');
  await assert.rejects(requireTermsOrThrow({ reason: 'make this deposit' }), (e: unknown) => e instanceof TermsNotAccepted && /did not make this deposit/.test(String(e)));
  answer = true;
  assert.equal(await requireTerms({ owner: '0xabc', reason: 'start this copy' }), true, 'accepted in the popup: the action goes on');
  assert.deepEqual(asked.map((r) => r.reason), ['make this deposit', 'make this deposit', 'start this copy']);
  assert.equal(asked[0]!.owner, '0xabc');
  _resetAcceptanceForTests();
  assert.equal(lookedAround(), false, 'reset');
});

test('a restricted country of residence cannot sign; others can', () => {
  for (const c of ['IR', 'KP', 'RU', 'US', 'PR', 'gu']) assert.ok(countryProblem(c), c);
  for (const c of ['DE', 'SG', 'UA', 'JP', 'GB', 'CA']) assert.equal(countryProblem(c), null, c);
});

test('the first-visit acceptance: every statement, the current version only', () => {
  _resetAcceptanceForTests();
  assert.equal(browseAccepted(), null);
  assert.throws(() => acceptBrowse(['agree', 'risks']), /every statement/);
  const r = acceptBrowse(['risks', 'eligible', 'ownDecisions', 'agree'], 1_700_000_000_000);
  assert.deepEqual(r, { termsVersion: SITE_TERMS_VERSION, termsHash: SITE_TERMS_HASH, acceptedAt: 1_700_000_000_000, statements: ['agree', 'eligible', 'risks', 'ownDecisions'] });
  assert.deepEqual(browseAccepted(), r);
  assert.equal(acceptedBefore(), false);
  assert.equal(acceptBrowse(STATEMENTS.map((s) => s.id), 1, '0xabc').signedBy, '0xabc', 'a signed acceptance names its wallet');
  assert.equal(signedTerms('0xabc'), null, 'no wallet has signed');
  assert.equal(signedTerms(null), null);
  _resetAcceptanceForTests();
});
