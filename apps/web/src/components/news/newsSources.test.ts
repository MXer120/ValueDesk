/**
 * A story's source mark and the outlets Settings can switch off (newsSources.tsx).
 *   npx tsx --test src/components/news/newsSources.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CALENDAR_SITE, FEED_IDS, NEWS_SOURCES, OUTLETS, logoUrl, sourceSite } from './newsSources';
import SHIPPED from '../../../public/logos/news.json';

const SOSO_PAGE = 'https://sosovalue.com/news/123';
const site = (author: string | null, href = SOSO_PAGE, source?: string) => sourceSite({ author, href, post: false, ...(source ? { source } : {}) } as Parameters<typeof sourceSite>[0]);

test('a story from one of the feeds is marked by that feed, whatever its author or link', () => {
  assert.equal(site('Anyone', 'https://example.com/a', 'whitehouse'), 'whitehouse.gov');
  assert.equal(site('Watcher.Guru', SOSO_PAGE, 'watcherguru'), 'watcher.guru', 'a dropped feed id falls through to the author');
  assert.equal(site('Reuters', SOSO_PAGE, 'sosovalue'), 'sosovalue.com');
  assert.equal(site('Reuters', SOSO_PAGE, 'somethingelse'), 'reuters.com', 'an unknown source id falls through to the author');
});

test('an author that is itself a site is that site, without www', () => {
  assert.equal(site('crypto.news'), 'crypto.news');
  assert.equal(site('www.CoinDesk.com'), 'coindesk.com');
  assert.equal(site('U.Today'), 'u.today');
  assert.equal(site('  Blockcast.it '), 'blockcast.it');
});

test('a known outlet is matched by its name, ignoring case, spaces and punctuation, in any script', () => {
  assert.equal(site('ForesightNews'), 'foresightnews.pro');
  assert.equal(site('Foresight News'), 'foresightnews.pro');
  assert.equal(site('BLOOMBERG'), 'bloomberg.com');
  assert.equal(site('Yahoo! Finance'), 'finance.yahoo.com');
  assert.equal(site('吴说区块链'), 'wublock123.com');
  assert.equal(site('Odaily星球日报'), 'odaily.news');
  assert.equal(site('區塊客 Blockcast.it'), 'blockcast.it');
});

test('a longer name starting with a known one is that outlet; a key under four letters never matches a prefix', () => {
  assert.equal(site('RocketX | Privacy Swaps'), 'rocketx.exchange');
  assert.equal(site('Coinbase Assets'), 'coinbase.com');
  assert.equal(site('SEC'), 'sec.gov', 'an exact short key still matches');
  // "sec" is three letters: "Secret Network" is not the SEC. Its own link decides.
  assert.equal(site('Secret Network', 'https://scrt.network/blog/x'), 'scrt.network');
  assert.equal(site('Secret Network'), null);
});

test('no known name: the story\'s own link, unless it is SoSoValue\'s page or a post on X', () => {
  assert.equal(site('Some Blog', 'https://www.Example.org/post/1'), 'example.org');
  assert.equal(site(null, 'https://news.example.co.uk/x'), 'news.example.co.uk');
  for (const href of [SOSO_PAGE, 'https://m.sosovalue.com/a', 'https://x.com/user/status/1', 'https://twitter.com/u', 'https://t.co/abc']) {
    assert.equal(site('Unknown Person', href), null, href);
  }
  assert.equal(site('Unknown Person', '::not a url::'), null);
  assert.equal(site('', ''), null);
});

test('every outlet Settings lists is caught by its own name, so switching it off hides its stories', () => {
  // Failing before the fix: "The Wall Street Journal" and "U.S. SEC" resolved to no site.
  for (const g of OUTLETS) for (const [s, name] of g.list) assert.equal(site(name), s, `${name} -> ${s}`);
});

test('Settings lists each outlet once, and never the feeds that have their own switch', () => {
  const all = OUTLETS.flatMap((g) => g.list.map(([s]) => s));
  assert.equal(new Set(all).size, all.length);
  for (const s of NEWS_SOURCES) assert.ok(!all.includes(s.site), s.site);
  assert.deepEqual([...FEED_IDS], NEWS_SOURCES.filter((s) => s.id !== 'sosovalue').map((s) => s.id));
});

test('a site\'s icon: the app\'s own, then the shipped copy, else the logo route (encoded)', () => {
  assert.equal(logoUrl('sosovalue.com'), '/logos/brand/sosovalue.png');
  assert.equal(logoUrl('bloomberg.com'), '/logos/news/bloomberg.com.png');
  assert.equal(logoUrl('coindesk.com'), '/logos/news/coindesk.com.svg');
  // Official seals and marks that need permission are neutral letter badges (licence review 2026-10-28).
  for (const s of ['federalreserve.gov', 'sec.gov', 'dol.gov', 'kalshi.com']) assert.equal(logoUrl(s), `/logos/news/${s}.svg`, s);
  assert.equal(logoUrl('nowhere.example'), '/api/vs/logo?domain=nowhere.example');
  assert.equal(logoUrl('a b&c'), '/api/vs/logo?domain=a%20b%26c');
});

test('every shipped icon is on disk, and the calendar\'s agencies and the feeds have one', () => {
  const root = fileURLToPath(new URL('../../../public/logos/news/', import.meta.url));
  for (const [s, ext] of Object.entries(SHIPPED as Record<string, string>)) assert.ok(existsSync(`${root}${s}.${ext}`), `${s}.${ext}`);
  for (const s of [...Object.values(CALENDAR_SITE), ...NEWS_SOURCES.map((x) => x.site)]) {
    assert.doesNotMatch(logoUrl(s), /^\/api\//, `${s} should not wait on the logo route`);
  }
});
