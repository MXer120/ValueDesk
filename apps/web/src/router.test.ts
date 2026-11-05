import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGAL_LABELS, LEGAL_PAGES, SODEX_VIEWS, TABS, landingTab, legalForPath, pathForLegal, pathForSodexView, sodexViewForPath, soonTabs, tabForPath } from './router';

test('the legal pages are routes of their own, outside the nav', () => {
  assert.deepEqual([...LEGAL_PAGES], ['impressum', 'privacy', 'cookies', 'terms', 'risk', 'copy-terms', 'licenses']);
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
  assert.equal(legalForPath('/Risk'), 'risk');
  assert.equal(legalForPath('/cookies/'), 'cookies');
  assert.equal(legalForPath('/trade'), null);
  assert.equal(legalForPath('/'), null);
  assert.equal(legalForPath('/legal'), null);
});

test('Bots on the main site: in the nav as coming soon, no route; the beta channel has the page', () => {
  assert.ok(soonTabs(undefined).has('bots'));
  assert.equal(soonTabs('beta').size, 0);
  assert.equal(tabForPath('/bots', soonTabs(undefined)), null, '/bots lands where an unknown path does');
  assert.equal(tabForPath('/Bots/', soonTabs('beta')), 'bots');
  assert.equal(tabForPath('/copy', soonTabs(undefined)), 'copy');
});

test('the SoDEX views are routes of their own, outside the tabs; a fund is still Wealth', () => {
  for (const v of SODEX_VIEWS) {
    assert.equal(sodexViewForPath(pathForSodexView(v)), v);
    assert.equal(tabForPath(pathForSodexView(v)), null);
  }
  assert.equal(sodexViewForPath('/Points/'), 'points');
  assert.equal(sodexViewForPath('/wealth/vQQQ'), 'wealth');
  assert.equal(sodexViewForPath('/blind-boxes'), 'blind-boxes');
  assert.equal(sodexViewForPath('/trade'), null);
  assert.equal(landingTab('/verify'), 'trade', 'removed pages still move');
});
