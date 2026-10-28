import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEED_SOURCES, feedNews, logoDomain, parseFeedQuery, parseRss, resetFeeds } from '../src/valuedesk/feeds.js';

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
  // Watcher.Guru was dropped (its terms: personal, non-commercial use only): its id is refused like any unknown one.
  const q = parseFeedQuery({ ids: 'whitehouse,nope,watcherguru', coin: 'btc, eth', q: 'x', limit: '500' });
  assert.deepEqual(q.ids, ['whitehouse']);
  assert.deepEqual(q.coins, ['BTC', 'ETH']);
  assert.equal(q.q, null);
  assert.equal(q.limit, 100);
});

test('feedNews: merged newest first, filtered by a search; a failing feed is just absent', async () => {
  resetFeeds();
  const older = new Date(now.getTime() - 3_600_000);
  const fake = (async (url: string) => {
    if (url.includes('presidential-actions')) return new Response(rss(item('Order on bitcoin reserves, tariff fears fade', 'https://www.whitehouse.gov/b/', now)), { status: 200 });
    return new Response(rss(item('Tariff update', 'https://www.whitehouse.gov/a/', older)), { status: 200 });
  }) as typeof fetch;
  const all = await feedNews(parseFeedQuery({ ids: 'whitehouse' }), fake);
  assert.deepEqual(all.map((n) => n.href), ['https://www.whitehouse.gov/b/', 'https://www.whitehouse.gov/a/']);
  const found = await feedNews(parseFeedQuery({ ids: 'whitehouse', q: 'bitcoin tariff' }), fake);
  assert.deepEqual(found.map((n) => n.href), ['https://www.whitehouse.gov/b/']);
  resetFeeds();
  const failing = (async (url: string) => (url.includes('presidential-actions')
    ? new Response('nope', { status: 500 })
    : new Response(rss(item('Tariff update', 'https://www.whitehouse.gov/a/', older)), { status: 200 }))) as typeof fetch;
  assert.deepEqual((await feedNews(parseFeedQuery({ ids: 'whitehouse' }), failing)).map((n) => n.href), ['https://www.whitehouse.gov/a/']);
});

test('logoDomain: hostnames only, www dropped', () => {
  assert.equal(logoDomain('WWW.Bloomberg.com'), 'bloomberg.com');
  assert.equal(logoDomain('whitehouse.gov'), 'whitehouse.gov');
  assert.equal(logoDomain('http://x.com'), null);
  assert.equal(logoDomain('../etc'), null);
  assert.equal(logoDomain('localhost'), null);
});

test('imageType: the type the bytes are', async () => {
  const { imageType } = await import('../src/valuedesk/feeds.js');
  assert.equal(imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(imageType(Buffer.from([0, 0, 1, 0, 1, 0, 32, 32])), 'image/x-icon');
  assert.equal(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
  assert.equal(imageType(Buffer.from('hello')), null);
});

test('siteLogo: only the site itself is asked (no icon services), and an SVG is never served', async () => {
  const { siteLogo } = await import('../src/valuedesk/feeds.js');
  const asked: string[] = [];
  const svg = async (url: string) => {
    asked.push(url);
    return { status: 200, body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') };
  };
  const got = await siteLogo('svg-test.example', svg);
  assert.equal(got.body, null, 'an SVG is not a logo');
  assert.deepEqual(asked, ['https://svg-test.example/apple-touch-icon.png', 'https://svg-test.example/favicon.ico']);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const ok = await siteLogo('logo-test.example', async (url) => (url.endsWith('/favicon.ico') ? { status: 200, body: png } : { status: 404, body: Buffer.alloc(0) }));
  assert.equal(ok.type, 'image/png');
  assert.ok(ok.body?.equals(png));
});

test('publicGet: private, loopback and link-local hosts are refused (SSRF), plain http and IP literals too', async () => {
  const { isPublicAddress, publicGet } = await import('../src/valuedesk/feeds.js');
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
    assert.equal(isPublicAddress(a), false, a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(a), true, a);
  assert.equal(isPublicAddress('not an ip'), false);
  // Refused before any socket: not https, an IP literal, credentials, another port; and a name resolving to loopback.
  assert.equal(await publicGet('http://example.com/favicon.ico'), null);
  assert.equal(await publicGet('https://127.0.0.1/favicon.ico'), null);
  assert.equal(await publicGet('https://[::1]/favicon.ico'), null);
  assert.equal(await publicGet('https://user:pw@example.com/favicon.ico'), null);
  assert.equal(await publicGet('https://example.com:8443/favicon.ico'), null);
  assert.equal(await publicGet('https://localhost/favicon.ico'), null);
});
