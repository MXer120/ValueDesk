import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LANGUAGES, READY } from './languages';
import { createMatcher, hasWords, holesOf } from './match';

const web = fileURLToPath(new URL('../../', import.meta.url));
const english = JSON.parse(readFileSync(`${web}i18n/en.json`, 'utf8')) as string[];
const catalogues = readdirSync(`${web}public/i18n`).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
const load = (code: string) => JSON.parse(readFileSync(`${web}public/i18n/${code}.json`, 'utf8')) as Record<string, string>;

test('an exact string is found, its outer spaces kept', () => {
  const t = createMatcher({ 'Send feedback': 'Feedback senden' });
  assert.equal(t('Send feedback'), 'Feedback senden');
  assert.equal(t('  Send feedback '), '  Feedback senden ');
  assert.equal(t('Send  feedback'), 'Feedback senden');
});

test('what it does not know stays English', () => {
  const t = createMatcher({ 'Send feedback': 'Feedback senden' });
  assert.equal(t('Something else'), null);
  assert.equal(t('75,870.5'), null);
  assert.equal(t(''), null);
});

test('a pattern carries its values, in the order the translation wants them', () => {
  const t = createMatcher({ '{0} of {1}': '{1} 中の {0}', 'Delete {0} drawings': '{0} Zeichnungen löschen', 'Moved {0} {1} to Spot': '{0} {1} nach Spot verschoben' });
  assert.equal(t('11 of 14'), '14 中の 11');
  assert.equal(t('Delete 3 drawings'), '3 Zeichnungen löschen');
  assert.equal(t('Moved 1.5 BTC to Spot'), '1.5 BTC nach Spot verschoben');
});

test('the longer pattern wins, and a pattern never matches across a different sentence', () => {
  const t = createMatcher({ '{0} of {1}': 'A', '{0} of {1} wallets': 'B' });
  assert.equal(t('2 of 3 wallets'), 'B');
  assert.equal(t('2 to 3'), null);
});

test('a value containing regex marks or dollars comes through whole', () => {
  const t = createMatcher({ 'Cap {0}': 'Limit {0}' });
  assert.equal(t('Cap $1,000.50 (x)'), 'Limit $1,000.50 (x)');
});

test('a known word inside a sentence is translated with it', () => {
  const t = createMatcher({ 'Everyone who {0} money': 'Alle, die Geld {0}', made: 'verdient haben' });
  assert.equal(t('Everyone who made money'), 'Alle, die Geld verdient haben');
  assert.equal(t('Everyone who burned money'), 'Alle, die Geld burned');
});

test('text that fits no pattern is quick to refuse, whatever the patterns', () => {
  // A regex version of these took minutes on this text and froze the page (2026-11-06).
  const many: Record<string, string> = {};
  for (let i = 0; i < 2000; i++) many[`{0} word${i} {1} and {2} then {3} or {4}`] = 'x {0} {1} {2} {3} {4}';
  many['{0}{1}{2} bp'] = 'y {0}{1}{2}';
  const t = createMatcher(many);
  const started = Date.now();
  for (let i = 0; i < 200; i++) assert.equal(t(`${'a and b then c or d '.repeat(15)}${i}`), null);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});

test('holes side by side are left to the English, not guessed at', () => {
  const t = createMatcher({ '{0}{1} bp': '{0}{1} Bp', '{0} {1}': 'z' });
  assert.equal(t('12 bp'), null);
  assert.equal(t('ab cd'), null);
});

test('an English plural ending from the code does not reach another language', () => {
  const t = createMatcher({ '{0} order{1} filled': '{0} Order{1} ausgeführt' });
  assert.equal(t('3 orders filled'), '3 Order ausgeführt');
});

test('prices and times are not words', () => {
  assert.ok(!hasWords('22:40:02'));
  assert.ok(!hasWords('$1,234.50'));
  assert.ok(hasWords('Спот'));
  assert.ok(hasWords('現貨'));
});

test('a language is ready only with its catalogue and its flag; no catalogue sits unused', () => {
  for (const code of READY) if (code !== 'en') assert.ok(catalogues.includes(code), `${code} is ready but has no catalogue`);
  for (const code of catalogues) assert.ok(READY.has(code), `${code} has a catalogue but is not ready`);
  for (const l of LANGUAGES) assert.ok(existsSync(`${web}public/flags/${l.flag}.svg`), `no flag for ${l.code}`);
});

for (const code of catalogues) {
  const c = load(code);
  test(`${code}: every string of en.json is there, none empty`, () => {
    const missing = english.filter((s) => !c[s]?.trim());
    assert.deepEqual(missing.slice(0, 20), [], `${missing.length} missing`);
  });
  test(`${code}: every placeholder survives`, () => {
    const bad = Object.entries(c).filter(([en, to]) => holesOf(en).join() !== holesOf(to).join()).map(([en, to]) => `${en} => ${to}`);
    assert.deepEqual(bad.slice(0, 20), [], `${bad.length} broken`);
  });
  test(`${code}: every number of the English is in the translation`, () => {
    // Written the local way is the same number: 200,000 = 200 000; 2:30 pm = 14:30; $1M = 100 万; 24/7 = round the clock.
    const nums = (t: string) => (t.replace(/\{\d+\}/g, '').replace(/~?\d{1,2}(:\d\d)? ?(am|pm)\b/gi, '').replace(/24\/7/g, '').replace(/\$?\d+(\.\d+)?[KMB]\b/g, '').match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/[.,]/g, ''));
    const digits = (t: string) => t.replace(/\{\d+\}/g, '').replace(/(\d)[\s\u00a0\u202f.,'’](?=\d)/g, '$1');
    const bad = Object.entries(c).filter(([en, to]) => { const have = digits(to); return nums(en).some((n) => !have.includes(n)); }).map(([en, to]) => `${en} => ${to}`);
    assert.deepEqual(bad.slice(0, 20), [], `${bad.length} changed`);
  });
  test(`${code}: names and tickers stay as they are`, () => {
    const NAMES = ['SoDEX', 'ValueDesk', 'USDC', 'SOSO', 'BTC', 'Hyperliquid', 'Discord'];
    const bad = Object.entries(c).filter(([en, to]) => NAMES.some((n) => en.includes(n) && !to.includes(n))).map(([en, to]) => `${en} => ${to}`);
    assert.deepEqual(bad.slice(0, 20), [], `${bad.length} changed`);
  });
}

test("with nothing picked, the browser's language is used when we have it; the page keeps Chrome's translation off", async () => {
  const { browserLanguage } = await import('./store');
  assert.equal(browserLanguage(['pt-BR', 'en']), 'pt');
  assert.equal(browserLanguage(['en-US']), 'en');
  assert.equal(browserLanguage(['am-ET', 'fr-MA', 'en']), 'fr', 'a language we lack is skipped for the next one');
  assert.equal(browserLanguage(['am-ET']), null, 'none we have: English');
  assert.equal(browserLanguage(['zh-TW']), 'zh-TW');
  assert.equal(browserLanguage(['zh-Hant-HK']), 'zh-TW');
  assert.equal(browserLanguage(['zh', 'en']), 'zh-CN');
  assert.equal(browserLanguage(['zh-Hans-CN']), 'zh-CN');
  assert.equal(browserLanguage(['TR-tr']), 'tr');
  assert.equal(browserLanguage(['', ' de-DE ']), 'de');
  const html = readFileSync(`${web}index.html`, 'utf8');
  assert.match(html, /<html lang="en" translate="no">/, 'Chrome Translate rewrites the tree React holds: insertBefore/removeChild crashes');
  assert.match(html, /<meta name="google" content="notranslate" \/>/);
});
