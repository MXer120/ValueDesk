import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKED_COUNTRIES, US_REGIONS } from '@copy-engine';
import { LEGAL_PAGES } from '../router';
import {
  CLOSE_ONLY_CODES,
  CLOSE_ONLY_COUNTRIES,
  LEGAL_PATHS,
  SANCTIONED_CODES,
  SANCTIONED_COUNTRIES,
  SANCTIONED_REGIONS,
  edgeBlockList,
  normaliseCountry,
  normaliseRegion,
  siteAccess,
} from './jurisdictions.mjs';
import { LEGAL_DOCS } from './docs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('the edge serves exactly the legal pages of the router where the site is blocked', () => {
  assert.deepEqual([...LEGAL_PATHS].sort(), [...LEGAL_PAGES].sort());
});

test('copy trading is at least as strict as the site: every blocked or close-only country is excluded from copying', () => {
  for (const c of [...SANCTIONED_CODES, ...CLOSE_ONLY_CODES]) assert.ok(BLOCKED_COUNTRIES.includes(c), `${c} is restricted site-wide but allowed for copy trading`);
  assert.deepEqual([...CLOSE_ONLY_CODES].sort(), [...US_REGIONS].sort(), 'close-only is the US and its territories, as for copying (owner, 2026-10-23)');
});

test('the Terms of use and the restricted page name every restricted place', () => {
  const terms = JSON.stringify(LEGAL_DOCS.terms);
  for (const p of [...SANCTIONED_COUNTRIES, ...CLOSE_ONLY_COUNTRIES, ...SANCTIONED_REGIONS]) {
    assert.ok(terms.includes(p.name), `the Terms of use (terms.ts section 3) do not name ${p.name}`);
  }
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'restricted.html'), 'utf8');
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = m[1]!;
    assert.ok(href === '/favicon.svg' || LEGAL_PATHS.includes(href.slice(1)), `restricted.html links to ${href}, which the edge blocks there`);
  }
  assert.doesNotMatch(html, /<script/i, 'no script: the site CSP allows none inline');
});

test('siteAccess: sanctioned places block, the US is close-only, the stricter of seen and declared wins', () => {
  assert.equal(siteAccess().level, 'open');
  assert.equal(siteAccess({ country: 'DE' }).level, 'open');
  assert.equal(siteAccess({ country: 'ir' }).level, 'blocked');
  assert.equal(siteAccess({ country: 'UA', region: '43' }).level, 'blocked');
  assert.equal(siteAccess({ country: 'UA', region: '43' }).place, 'Crimea');
  assert.equal(siteAccess({ country: 'UA', region: '30' }).level, 'open');
  assert.equal(siteAccess({ country: 'RO', region: '43' }).level, 'open', 'a region code belongs to its country');
  assert.equal(siteAccess({ country: 'US' }).level, 'close-only');
  assert.equal(siteAccess({ country: 'DE', declared: 'US' }).level, 'close-only');
  assert.equal(siteAccess({ country: 'DE', declared: 'US' }).source, 'declared');
  assert.equal(siteAccess({ country: 'US', declared: 'KP' }).level, 'blocked', 'blocked beats close-only');
  assert.equal(siteAccess({ country: 'XX', declared: null }).level, 'open', 'unknown restricts nothing');
  assert.equal(siteAccess({ country: 'T1' }).level, 'open');
  for (const a of [siteAccess({ country: 'CU' }), siteAccess({ country: 'US' })]) assert.ok(a.reason && a.reason.endsWith('.'));
  assert.equal(normaliseCountry(' de '), 'DE');
  assert.equal(normaliseCountry('DEU'), null);
  assert.equal(normaliseRegion('09'), '09');
  assert.equal(normaliseRegion('toolong'), null);
  assert.deepEqual(edgeBlockList().countries, [...SANCTIONED_CODES]);
});
