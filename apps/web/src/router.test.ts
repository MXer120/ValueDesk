import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGAL_LABELS, LEGAL_PAGES, TABS, legalForPath, pathForLegal, tabForPath } from './router';

test('the legal pages are routes of their own, outside the nav', () => {
  assert.deepEqual([...LEGAL_PAGES], ['impressum', 'privacy', 'terms', 'copy-terms']);
  for (const p of LEGAL_PAGES) {
    assert.ok(!(TABS as readonly string[]).includes(p), `${p} is not a tab (no nav link, no number key)`);
    assert.equal(legalForPath(pathForLegal(p)), p);
    assert.equal(tabForPath(pathForLegal(p)), null);
    assert.ok(LEGAL_LABELS[p]);
  }
});

test('legalForPath: tolerant like tabForPath, null for anything else', () => {
  assert.equal(legalForPath('/Impressum/'), 'impressum');
  assert.equal(legalForPath('/privacy?x=1'.split('?')[0]!), 'privacy');
  assert.equal(legalForPath('/terms/extra'), 'terms');
  assert.equal(legalForPath('/Copy-Terms/'), 'copy-terms');
  assert.equal(tabForPath('/copy-terms'), null, '/copy-terms is not the Copy tab');
  assert.equal(legalForPath('/trade'), null);
  assert.equal(legalForPath('/'), null);
  assert.equal(legalForPath('/legal'), null);
});
