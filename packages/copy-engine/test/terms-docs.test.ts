/**
 * The copy terms by version (src/terms): what followers signed must never change under them, and the version in
 * force always has its text (owner 2026-11-09: the terms version must never make anyone reload the page).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COPY_TERMS_DOCS, COPY_TERMS_VERSION, copyTermsDoc, copyTermsHash, currentCopyTerms } from '../src/index.ts';

// The hashes followers signed. A published version's text is frozen: if one of these fails, a published file was
// edited - restore it and put the change in a new version instead.
const SIGNED: Record<string, string> = {
  '2026-11-02': '0x74fb626ff4abb0b0a9d40c7caaf387b1643076322aba14b2c97336e8c3f28fcd',
  '2026-11-09': '0x2bcbecb06b80a4b5f4d5f6bdfc99a9dcd8a15545107669682a0f0d3f6c194411',
};

test('every published version keeps the exact text its followers signed', () => {
  for (const [v, h] of Object.entries(SIGNED)) {
    const doc = copyTermsDoc(v);
    assert.ok(doc, `version ${v} is still known`);
    assert.equal(copyTermsHash(doc), h, `the text of ${v} is unchanged`);
  }
});

test('the version in force has its text, and each text names its own version', () => {
  const cur = currentCopyTerms();
  assert.equal(cur.termsVersion, COPY_TERMS_VERSION);
  assert.equal(cur.termsHash, copyTermsHash(cur.doc));
  for (const [v, doc] of Object.entries(COPY_TERMS_DOCS)) {
    assert.ok(JSON.stringify(doc.intro).includes(`Version ${v}`), `${v}: its intro names ${v}`);
  }
});

test('the version before the newest is kept, for an executor one release behind the web', () => {
  const versions = Object.keys(COPY_TERMS_DOCS).sort();
  assert.ok(versions.length >= 2, 'at least the newest and the one before');
  assert.equal(versions.at(-1), COPY_TERMS_VERSION, 'the newest listed is the one in force');
  assert.equal(copyTermsDoc('1999-01-01'), null);
});
