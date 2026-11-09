/**
 * The copy terms in force follow ValueDesk's executor, so the setup always signs the version it records
 * (owner 2026-11-09: "These are the copy terms of ...; reload the page" must never happen).
 * Run (from apps/web): npx tsx --test src/copy/termsVersion.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COPY_TERMS_VERSION, copyTermsDoc, copyTermsHash, type CopyTermsServed, type TermsDoc } from '@copy-engine';
import type { ExecutorClient } from './executor';
import { COPY_TERMS_HASH, activeCopyTerms, adoptRecordedTerms, followExecutorTerms, onActiveCopyTerms } from './terms';

const OLDER = '2026-11-02';
const fakeClient = (served: CopyTermsServed | Error) => {
  let calls = 0;
  const client = {
    copyTerms: async () => {
      calls += 1;
      if (served instanceof Error) throw served;
      return served;
    },
  } as unknown as ExecutorClient;
  return { client, calls: () => calls };
};

test('before the executor answers, the terms in force are this build\'s own', () => {
  assert.equal(activeCopyTerms().termsVersion, COPY_TERMS_VERSION);
  assert.equal(activeCopyTerms().termsHash, COPY_TERMS_HASH);
});

test('web newer than the executor: the setup signs the executor\'s older version, from the text this build keeps', async () => {
  const f = fakeClient(new Error('not asked'));
  let told = 0;
  const off = onActiveCopyTerms(() => { told += 1; });
  assert.equal(await followExecutorTerms({ termsVersion: OLDER, features: [] }, f.client), true);
  off();
  assert.equal(f.calls(), 0, 'a version this build knows needs no fetch');
  assert.equal(told, 1, 'the page is told (setup, terms page)');
  const a = activeCopyTerms();
  assert.equal(a.termsVersion, OLDER);
  assert.equal(a.termsHash, copyTermsHash(copyTermsDoc(OLDER)!));
  // The executor's record of that version counts as accepted here; one of another version does not.
  assert.ok(adoptRecordedTerms('0x' + '11'.repeat(20), { termsVersion: OLDER, termsHash: a.termsHash, country: 'SG', acceptedAt: 1 } as never));
  assert.equal(adoptRecordedTerms('0x' + '11'.repeat(20), { termsVersion: COPY_TERMS_VERSION, termsHash: COPY_TERMS_HASH, country: 'SG', acceptedAt: 1 } as never), null);
  // Same version again: nothing changes.
  assert.equal(await followExecutorTerms({ termsVersion: OLDER, features: [] }, f.client), false);
});

test('executor newer than the web: its text is fetched, shown and signed, with the hash of what is shown', async () => {
  const doc: TermsDoc = { page: 'copy-terms', title: 'Copy trading terms', lang: 'en', updated: '2027-01-01', intro: [{ p: 'Version 2027-01-01.' }], sections: [] };
  const f = fakeClient({ termsVersion: '2027-01-01', termsHash: '0x' + '00'.repeat(32), doc });
  assert.equal(await followExecutorTerms({ termsVersion: '2027-01-01', features: ['terms-doc'] }, f.client), true);
  assert.equal(f.calls(), 1);
  const a = activeCopyTerms();
  assert.equal(a.termsVersion, '2027-01-01');
  assert.deepEqual(a.doc, doc);
  assert.equal(a.termsHash, copyTermsHash(doc), 'the hash signed is of the text shown, not a hash the executor sent');
});

test('an executor that cannot serve an unknown version leaves the terms as they were', async () => {
  const before = activeCopyTerms();
  const noDoc = fakeClient(new Error('not asked'));
  assert.equal(await followExecutorTerms({ termsVersion: '2028-01-01', features: [] }, noDoc.client), false);
  assert.equal(noDoc.calls(), 0);
  const failing = fakeClient(new Error('unreachable'));
  assert.equal(await followExecutorTerms({ termsVersion: '2028-01-01', features: ['terms-doc'] }, failing.client), false);
  const wrong = fakeClient({ termsVersion: '2028-02-02', termsHash: '0x', doc: before.doc });
  assert.equal(await followExecutorTerms({ termsVersion: '2028-01-01', features: ['terms-doc'] }, wrong.client), false, 'a text of another version is not taken');
  assert.equal(activeCopyTerms(), before);
  // Back to this build's version.
  assert.equal(await followExecutorTerms({ termsVersion: COPY_TERMS_VERSION, features: [] }, noDoc.client), true);
  assert.equal(activeCopyTerms().termsHash, COPY_TERMS_HASH);
});
