/**
 * Origin rules: loopback-or-listed for the local API (unchanged), and hosted
 * mode's exact site-origin rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedOrigin, isSiteOrigin, normaliseOrigin } from '../src/origin.js';

const SITE = ['https://app.valuedesk.example'];

test('local rule unchanged: loopback, listed origins, and a missing Origin for native clients', () => {
  assert.equal(isAllowedOrigin('http://localhost:5180'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:5180'), true);
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin('https://app.valuedesk.example', SITE), true);
  assert.equal(isAllowedOrigin('https://app.valuedesk.example.evil.test', SITE), false);
  assert.equal(isAllowedOrigin('https://evil.example', SITE), false);
});

test('hosted rule: the site origin exactly; no loopback, no missing or opaque Origin', () => {
  assert.equal(isSiteOrigin('https://app.valuedesk.example', SITE), true);
  assert.equal(isSiteOrigin('https://APP.valuedesk.example', SITE), true, 'hosts compare case-insensitively');
  for (const bad of [
    undefined, null, '', 'null',
    'http://app.valuedesk.example', // scheme differs
    'https://app.valuedesk.example:8443', // port differs
    'https://app.valuedesk.example.evil.test',
    'https://evil.example',
    'http://localhost:5180',
    'http://127.0.0.1:8797',
  ]) {
    assert.equal(isSiteOrigin(bad as string | undefined, SITE), false, String(bad));
  }
});

test('origin normalisation keeps only a bare http(s) origin', () => {
  assert.equal(normaliseOrigin('https://App.Example:443/'), 'https://app.example');
  assert.equal(normaliseOrigin('http://localhost:5180'), 'http://localhost:5180');
  for (const bad of ['app.example', 'ftp://app.example', 'https://app.example/x', 'https://a:b@app.example', 'https://app.example#x', 'javascript:alert(1)']) {
    assert.equal(normaliseOrigin(bad), null, bad);
  }
});
