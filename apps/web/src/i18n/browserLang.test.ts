/**
 * The browser's language for a visitor who never chose one (browserLang.ts), and the same rule in the build's
 * route-preload script (tools/route-preload.mjs browserPick).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { browserPick } from '../../tools/route-preload.mjs';
import { browserLang, matchLanguage, pickLanguage } from './browserLang';
import { READY } from './languages';
import { bootLanguage, currentLanguage, i18nEnv, resetI18nForTest, setLanguage } from './store';

const CODES = [...READY];

test('a tag is matched exactly first, then by its base language, Chinese by script or region', () => {
  assert.equal(matchLanguage('pt-BR', CODES), 'pt');
  assert.equal(matchLanguage('fr-MA', CODES), 'fr');
  assert.equal(matchLanguage('de', CODES), 'de');
  assert.equal(matchLanguage('en-NG', CODES), 'en');
  assert.equal(matchLanguage('zh-TW', CODES), 'zh-TW');
  assert.equal(matchLanguage('zh-Hant-HK', CODES), 'zh-TW');
  assert.equal(matchLanguage('zh-HK', CODES), 'zh-TW');
  assert.equal(matchLanguage('zh', CODES), 'zh-CN');
  assert.equal(matchLanguage('zh-Hans-SG', CODES), 'zh-CN');
  assert.equal(matchLanguage('es_419', CODES), 'es');
  assert.equal(matchLanguage('am-ET', CODES), null, 'Amharic is not one of the languages');
  assert.equal(matchLanguage('ar-MA', CODES), null);
  assert.equal(matchLanguage('', CODES), null);
});

test("the browser's order decides: the first language the app has wins, English included", () => {
  assert.equal(pickLanguage(['pt-BR', 'pt', 'en-US'], CODES), 'pt');
  assert.equal(pickLanguage(['ar-MA', 'fr-MA', 'en'], CODES), 'fr', 'Arabic first, then French');
  assert.equal(pickLanguage(['en-US', 'pt-BR'], CODES), 'en', 'English first stays English');
  assert.equal(pickLanguage(['am-ET'], CODES), null);
  assert.equal(pickLanguage([], CODES), null);
});

test("the build's script picks exactly what the app picks", () => {
  const cases: string[][] = [
    ['pt-BR', 'pt', 'en-US'], ['ar-MA', 'fr-MA', 'en'], ['en-US', 'pt-BR'], ['am-ET'], [], ['zh-Hant-TW'], ['zh-HK'],
    ['zh-Hans-CN'], ['zh'], ['ja-JP'], ['nb-NO', 'de-DE'], ['es_419'], ['TR-tr'], ['yo-NG', 'en-NG'],
  ];
  for (const prefs of cases) {
    const got = runInNewContext(browserPick(CODES), { window: { navigator: { languages: prefs, language: prefs[0] } } });
    assert.equal(got, pickLanguage(prefs, CODES), prefs.join(','));
  }
  assert.equal(runInNewContext(browserPick(CODES), { window: {} }), null, 'no navigator');
  assert.equal(runInNewContext(browserPick(CODES), { window: { navigator: { language: 'it-IT' } } }), 'it', 'only navigator.language');
});

/* --- the store: a default, never stored --------------------------------------------------------------------- */

const g = globalThis as unknown as Record<string, unknown>;
const mem = new Map<string, string>();
g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
g.document = { documentElement: { lang: 'en' } };
g.window = globalThis;
g.location = { pathname: '/trade' };
i18nEnv.fetchJson = async () => ({ Trade: 'Negociar' });
i18nEnv.apply = async () => {};
i18nEnv.split = false;

function fresh(stored: string | null, browser: string[]) {
  resetI18nForTest();
  mem.clear();
  if (stored) mem.set('vs.lang', stored);
  browserLang.languages = () => browser;
}

test("a visitor who never chose reads the browser's language, and nothing is stored for them", () => {
  fresh(null, ['pt-BR', 'en']);
  bootLanguage();
  assert.equal(currentLanguage(), 'pt');
  assert.equal(mem.get('vs.lang'), undefined, 'the menu stays the explicit choice');
});

test('a choice in the menu wins over the browser, English included', async () => {
  fresh('en', ['pt-BR']);
  bootLanguage();
  assert.equal(currentLanguage(), 'en');
  fresh('de', ['pt-BR']);
  bootLanguage();
  assert.equal(currentLanguage(), 'de');
});

test("picking the browser's language in the menu makes it the visitor's choice", async () => {
  fresh(null, ['fr-MA']);
  bootLanguage();
  assert.equal(currentLanguage(), 'fr');
  assert.equal(await setLanguage('fr'), true);
  assert.equal(mem.get('vs.lang'), 'fr');
});

test('a browser in a language the app does not have stays English', () => {
  fresh(null, ['am-ET']);
  bootLanguage();
  assert.equal(currentLanguage(), 'en');
});
