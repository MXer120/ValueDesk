import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGAL_PAGES, legalForPath, type LegalPage } from '../router';
import { LEGAL_DOCS, assertLegalPagesComplete, legalPlaceholders } from './docs';
import { isDraft, placeholderReport, placeholdersIn, type LegalDoc } from './model';

/** The documents with every placeholder filled in, as the owner will leave them. */
function filled(): Record<LegalPage, LegalDoc> {
  const fill = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\[\[\s*OWNER\b[\s\S]*?(?:\]\]|$)/gi, 'filled in');
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return fill(LEGAL_DOCS) as Record<LegalPage, LegalDoc>;
}

test('placeholdersIn: every marker, nested, in any case, and a half-edited one', () => {
  assert.deepEqual(placeholdersIn('no marker here'), []);
  assert.deepEqual(
    placeholdersIn({ a: ['x [[OWNER: name]] y', { p: '[[owner:address]]' }], b: 3 }),
    ['[[OWNER: name]]', '[[owner:address]]'],
  );
  assert.equal(placeholdersIn('E-Mail: [[OWNER: e-mail').length, 1, 'a marker whose brackets were deleted still counts');
  assert.equal(placeholdersIn('[[ OWNER : spaced ]]').length, 1);
  assert.deepEqual(placeholdersIn('[[OWNERSHIP]] is a different word'), [], 'only the OWNER marker counts');
});

test('the drafts as shipped: every page is a draft, and the build check refuses them', () => {
  for (const page of LEGAL_PAGES) assert.ok(isDraft(LEGAL_DOCS[page]), `${page} has placeholders for the owner`);
  const left = legalPlaceholders();
  assert.ok(left.length > 0);
  assert.deepEqual([...new Set(left.map((l) => l.page))].sort(), [...LEGAL_PAGES].sort());
  assert.throws(() => assertLegalPagesComplete(), (e: unknown) => {
    const msg = e instanceof Error ? e.message : '';
    // One line per placeholder, saying where it is.
    return /placeholder/.test(msg) && /impressum \/ Angaben gemäß § 5 DDG: \[\[OWNER:/.test(msg) && msg.split('\n').length === left.length + 2;
  });
});

test('once every placeholder is filled in, nothing is a draft and the build check passes', () => {
  const docs = filled();
  for (const page of LEGAL_PAGES) assert.equal(isDraft(docs[page]), false, page);
  assert.deepEqual(legalPlaceholders(docs), []);
  assert.doesNotThrow(() => assertLegalPagesComplete(docs));
  assert.equal(placeholderReport([]), '');
});

test('the check finds a placeholder wherever it is: title, intro, a section, the date', () => {
  const docs = filled();
  docs.terms = { ...docs.terms, title: 'Terms [[OWNER: x]]' };
  docs.privacy = { ...docs.privacy, intro: [{ p: '[[OWNER: y]]' }] };
  docs.impressum = { ...docs.impressum, updated: '[[OWNER: z]]' };
  assert.deepEqual(
    legalPlaceholders(docs).map((l) => `${l.page}:${l.where}`).sort(),
    ['impressum:updated', 'privacy:intro', 'terms:title'],
  );
});

test('each document is filed under its own page, in its language', () => {
  for (const page of LEGAL_PAGES) assert.equal(LEGAL_DOCS[page].page, page);
  assert.equal(LEGAL_DOCS.impressum.lang, 'de');
  assert.equal(LEGAL_DOCS.privacy.lang, 'en');
  assert.equal(LEGAL_DOCS.terms.lang, 'en');
});

test('links in the texts go only to the legal pages, https or mailto', () => {
  const text = JSON.stringify(LEGAL_DOCS);
  for (const m of text.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
    const href = m[1]!;
    assert.ok(legalForPath(href) !== null || /^https:\/\//.test(href) || /^mailto:/.test(href), `unexpected link target ${href}`);
  }
});

test('the privacy policy names every host the browser may contact (index.html CSP)', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html'), 'utf8');
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
  assert.ok(csp, 'the CSP was read');
  const hosts = new Set<string>();
  for (const dir of ['connect-src', 'frame-src', 'img-src']) {
    const value = new RegExp(`${dir}([^;]+);`).exec(csp)?.[1] ?? '';
    for (const src of value.trim().split(/\s+/)) {
      const host = /^(?:https|wss):\/\/([^/]+)/.exec(src)?.[1];
      if (host) hosts.add(host);
    }
  }
  assert.ok(hosts.size > 10, 'hosts were read from the CSP');
  const policy = JSON.stringify(LEGAL_DOCS.privacy);
  const missing = [...hosts].filter((h) => !policy.includes(h));
  assert.deepEqual(missing, [], 'a host the app connects to is missing from the privacy policy (src/legal/privacy.ts)');
});
