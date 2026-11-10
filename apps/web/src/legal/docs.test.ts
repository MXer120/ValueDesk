import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AcceptTermsPayload } from '../../../../packages/copy-engine/src/api.ts';
import {
  BLOCKED_COUNTRIES,
  COPY_FEE_LADDER,
  COPY_FEE_MAX,
  COPY_FEE_WINDOW_DAYS,
  COPY_TERMS_VERSION,
  EEA_COUNTRIES,
  EEA_MAX_LEVERAGE,
  feePercent,
} from '../../../../packages/copy-engine/src/policy.ts';
import { LEGAL_PAGES, legalForPath, type LegalPage } from '../router';
import { COPY_RISK_SUMMARY, COPY_STATEMENTS, COPY_TERMS, HOSTED_KEY_NOTICE } from './copyTerms';
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
  docs['copy-terms'] = { ...docs['copy-terms'], sections: [{ title: '7. Risk disclosure', blocks: [{ ul: ['[[OWNER: w]]'] }] }] };
  docs.risk = { ...docs.risk, sections: [{ title: '1. Leverage', blocks: [{ p: '[[OWNER: v]]' }] }] };
  docs.cookies = { ...docs.cookies, updated: '[[OWNER: u]]' };
  assert.deepEqual(
    legalPlaceholders(docs).map((l) => `${l.page}:${l.where}`).sort(),
    ['cookies:updated', 'copy-terms:7. Risk disclosure', 'impressum:updated', 'privacy:intro', 'risk:1. Leverage', 'terms:title'],
  );
});

test('each document is filed under its own page, in its language', () => {
  for (const page of LEGAL_PAGES) assert.equal(LEGAL_DOCS[page].page, page);
  assert.equal(LEGAL_DOCS.impressum.lang, 'de');
  for (const page of ['privacy', 'cookies', 'terms', 'risk', 'copy-terms'] as const) assert.equal(LEGAL_DOCS[page].lang, 'en', page);
  assert.equal(LEGAL_DOCS['copy-terms'], COPY_TERMS);
});

test('the section numbers of each document run 1, 2, 3 ... and every "section N" it cites exists', () => {
  for (const page of LEGAL_PAGES) {
    const doc = LEGAL_DOCS[page];
    const numbered = doc.sections.map((s) => /^(\d+)\./.exec(s.title)?.[1]).filter((n): n is string => !!n).map(Number);
    if (!numbered.length) continue;
    assert.deepEqual(numbered, numbered.map((_, i) => i + 1), `${page}: sections numbered in order`);
    // A reference to this document's own section: "section N" not preceded by a link to another page.
    const own = JSON.stringify([doc.intro ?? [], doc.sections]).replace(/\]\(\/[a-z-]+\)(,)? sections? \d+/g, '');
    for (const m of own.matchAll(/sections? (\d+)(?: and (\d+))?/g)) {
      for (const n of [m[1], m[2]].filter(Boolean).map(Number)) assert.ok(n >= 1 && n <= numbered.length, `${page} cites section ${n}, which it does not have`);
    }
  }
});

test('links in the texts go only to the legal pages, https, mailto or the build\'s licence file', () => {
  const text = JSON.stringify(LEGAL_DOCS);
  for (const m of text.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
    const href = m[1]!;
    const ok = legalForPath(href) !== null || /^https:\/\//.test(href) || /^mailto:/.test(href) || href === '/third-party-licenses.txt';
    assert.ok(ok, `unexpected link target ${href}`);
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

/* ------------------------------------------------------- copy trading terms ----- */

const text = (v: unknown): string => JSON.stringify(v);

test('the copy terms show the version every follower signs, before the first heading', () => {
  // A date, with a counter when the terms change more than once on one day (2026-10-23.2).
  assert.match(COPY_TERMS_VERSION, /^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
  assert.ok(text(COPY_TERMS.intro).includes(`Version ${COPY_TERMS_VERSION}`), 'the intro names the version');
});

test('COPY_STATEMENTS are exactly the four statements of AcceptTermsPayload, each with a label', () => {
  // Typed as the payload: a statement added to or removed from AcceptTermsPayload breaks this line in tsc.
  const signed: AcceptTermsPayload = {
    termsVersion: COPY_TERMS_VERSION,
    termsHash: `0x${'0'.repeat(64)}`,
    country: 'DE',
    adult: true,
    notUsPerson: true,
    ownDecision: true,
    risksUnderstood: true,
  };
  const statements = Object.entries(signed).filter(([, v]) => v === true).map(([k]) => k).sort();
  assert.deepEqual(COPY_STATEMENTS.map((s) => s.id).sort(), statements);
  assert.equal(new Set(COPY_STATEMENTS.map((s) => s.id)).size, COPY_STATEMENTS.length, 'no statement twice');
  for (const s of COPY_STATEMENTS) assert.ok(s.label.trim().length > 20, `${s.id} has a label`);
});

test('the copy terms disclose the fee ladder, no regional leverage cap, and the excluded countries of policy.ts', () => {
  const doc = text(COPY_TERMS);
  for (const step of COPY_FEE_LADDER) {
    const rate = feePercent(step.fee);
    const line = step.fromUsd === 0
      ? `under $${COPY_FEE_LADDER[1]!.fromUsd.toLocaleString('en-US')}: ${rate}`
      : `from $${step.fromUsd.toLocaleString('en-US')}: ${rate}`;
    assert.ok(doc.includes(line), `the ladder step "${line}" is in the copy terms`);
  }
  assert.ok(doc.includes(`last ${COPY_FEE_WINDOW_DAYS} days`), 'the volume window');
  assert.ok(doc.includes(`ceiling of ${feePercent(COPY_FEE_MAX)}`), 'the approval ceiling');
  assert.ok(text(COPY_RISK_SUMMARY).includes(`up to ${feePercent(COPY_FEE_MAX)}`), 'the setup sheet names the highest fee');

  // No regional leverage cap since 2026-11-10 (owner: "remove everywhere"): the terms say so and name none.
  assert.ok(!doc.includes(`at most ${EEA_MAX_LEVERAGE}x leverage`), 'no EEA cap');
  assert.ok(doc.includes('No regional leverage limit'), 'the terms say there is none');
  assert.equal(EEA_COUNTRIES.length, 37, 'the EEA: the 27 EU member states, Iceland, Liechtenstein and Norway, and the 7 EU territories with a country code of their own');

  const NAMES: Record<string, string> = {
    US: 'United States', PR: 'Puerto Rico', VI: 'US Virgin Islands', GU: 'Guam', AS: 'American Samoa',
    MP: 'Northern Mariana Islands', UM: 'US Minor Outlying Islands', GB: 'United Kingdom', CA: 'Canada',
    CU: 'Cuba', IR: 'Iran', KP: 'North Korea', SY: 'Syria', RU: 'Russia', BY: 'Belarus', MM: 'Myanmar',
  };
  const statement = COPY_STATEMENTS.find((s) => s.id === 'notUsPerson')!.label;
  for (const code of BLOCKED_COUNTRIES) {
    const name = NAMES[code];
    assert.ok(name, `${code} is excluded in policy.ts: name it in the copy terms and here`);
    assert.ok(doc.includes(name), `the copy terms name ${name}`);
    if (!['PR', 'VI', 'GU', 'AS', 'MP', 'UM'].includes(code)) assert.ok(statement.includes(name), `the notUsPerson statement names ${name}`);
  }
});

test('the copy texts the app shows outside the legal pages hold no placeholder', () => {
  // The build check reads LEGAL_DOCS only; these are shown on the Copy page itself.
  assert.ok(COPY_RISK_SUMMARY.length >= 6 && COPY_RISK_SUMMARY.length <= 9, '6 to 9 bullets');
  for (const s of COPY_RISK_SUMMARY) assert.ok(s.endsWith('.') && s.split(/\.\s/).length === 1, `one sentence: ${s}`);
  assert.deepEqual(placeholdersIn([COPY_RISK_SUMMARY, COPY_STATEMENTS, HOSTED_KEY_NOTICE]), []);
  for (const must of ['encrypted', 'Tokyo', 'around the clock', 'without asking you', 'move funds', 'revoke']) {
    assert.ok(HOSTED_KEY_NOTICE.includes(must), `the hosted key notice says "${must}"`);
  }
});
