import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEED_SOURCES, feedNews, logoDomain, parseFeedQuery, parseRss, resetFeeds } from '../src/valuescan/feeds.js';

const WH = FEED_SOURCES.find((s) => s.id === 'whitehouse')!;
const now = new Date();
const rss = (items: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${items}</channel></rss>`;
const item = (title: string, link: string, when: Date, desc = '') =>
  `<item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${when.toUTCString()}</pubDate><description><![CDATA[${desc}]]></description></item>`;

test('parseRss: title, link, time, summary and source; items without a link or time dropped', () => {
  const xml = rss(
    item('Fact Sheet: Tariffs &amp; Trade', 'https://www.whitehouse.gov/fact-sheets/x/', now, '<p>The President signed an order.</p> The post Fact Sheet appeared first on The White House.') +
      item('No link', '', now) +
      '<item><title>No time</title><link>https://www.whitehouse.gov/y/</link></item>',
  );
  const out = parseRss(xml, WH);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.title, 'Fact Sheet: Tariffs & Trade');
  assert.equal(out[0]!.href, 'https://www.whitehouse.gov/fact-sheets/x/');
  assert.equal(out[0]!.author, 'The White House');
  assert.equal(out[0]!.source, 'whitehouse');
  assert.equal(out[0]!.summary, 'The President signed an order.');
  assert.equal(out[0]!.time, Math.floor(now.getTime() / 1000) * 1000);
});

test('parseFeedQuery: known sources only, coins upper-cased, a short search ignored', () => {
  const q = parseFeedQuery({ ids: 'whitehouse,nope,watcherguru', coin: 'btc, eth', q: 'x', limit: '500' });
  assert.deepEqual(q.ids, ['whitehouse', 'watcherguru']);
  assert.deepEqual(q.coins, ['BTC', 'ETH']);
  assert.equal(q.q, null);
  assert.equal(q.limit, 100);
});

test('feedNews: merged newest first, filtered by a search; a failing feed is just absent', async () => {
  resetFeeds();
  const older = new Date(now.getTime() - 3_600_000);
  const fake = (async (url: string) => {
    if (url.includes('presidential-actions')) return new Response('nope', { status: 500 });
    if (url.includes('whitehouse.gov/news')) return new Response(rss(item('Tariff update', 'https://www.whitehouse.gov/a/', older)), { status: 200 });
    return new Response(rss(item('Bitcoin hits a high, tariff fears fade', 'https://watcher.guru/news/b', now)), { status: 200 });
  }) as typeof fetch;
  const all = await feedNews(parseFeedQuery({ ids: 'whitehouse,watcherguru' }), fake);
  assert.deepEqual(all.map((n) => n.source), ['watcherguru', 'whitehouse']);
  const found = await feedNews(parseFeedQuery({ ids: 'whitehouse,watcherguru', q: 'bitcoin tariff' }), fake);
  assert.deepEqual(found.map((n) => n.href), ['https://watcher.guru/news/b']);
});

test('logoDomain: hostnames only, www dropped', () => {
  assert.equal(logoDomain('WWW.Bloomberg.com'), 'bloomberg.com');
  assert.equal(logoDomain('watcher.guru'), 'watcher.guru');
  assert.equal(logoDomain('http://x.com'), null);
  assert.equal(logoDomain('../etc'), null);
  assert.equal(logoDomain('localhost'), null);
});

test('imageType: the type the bytes are', async () => {
  const { imageType } = await import('../src/valuescan/feeds.js');
  assert.equal(imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(imageType(Buffer.from([0, 0, 1, 0, 1, 0, 32, 32])), 'image/x-icon');
  assert.equal(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
  assert.equal(imageType(Buffer.from('hello')), null);
});

test('siteLogo: only the icon services are asked - never the site (SSRF) - and an SVG is never served', async () => {
  const { siteLogo } = await import('../src/valuescan/feeds.js');
  const asked: string[] = [];
  const svg = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', { status: 200 });
  }) as typeof fetch;
  const got = await siteLogo('127-0-0-1.sslip.io', svg);
  assert.equal(got.body, null, 'an SVG is not a logo');
  assert.ok(asked.length > 0);
  for (const u of asked) {
    const host = new URL(u).hostname;
    assert.ok(host === 'icons.duckduckgo.com' || host === 'www.google.com', `asked ${u}`);
  }
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const ok = await siteLogo('logo-test.example', (async () => new Response(png, { status: 200 })) as typeof fetch);
  assert.equal(ok.type, 'image/png');
  assert.ok(ok.body?.equals(png));
});
