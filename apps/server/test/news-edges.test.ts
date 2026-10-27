/**
 * Edge cases of the news parsers: the RSS feeds beside SoSoValue (entities as
 * WordPress writes them, CDATA, missing dates), the route queries, the logo
 * route's checks, SoSoValue's text and coins, and the ETF flows' days and funds.
 *   npx tsx --test test/news-edges.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { FEED_SOURCES, feedNews, imageType, logoDomain, parseFeedQuery, parseRss, resetFeeds } from '../src/valuescan/feeds.js';
import { isMacroStory, mapNewsList, namesCoin, notablePost, parseNewsQuery, stripHtml } from '../src/valuescan/sosovalue/news.js';
import { coinIndex, coinsIn, stockName } from '../src/valuescan/sosovalue/coins.js';
import {
  buildFunds, daysIn, mergeDays, parseEtfAsset, parseEtfList, parseEtfRange, parseEtfSnapshot, parseEtfSummary, sosoData, type EtfDay,
} from '../src/valuescan/sosovalue/etf.js';

const WG = FEED_SOURCES.find((s) => s.id === 'watcherguru')!;
const WH = FEED_SOURCES.find((s) => s.id === 'whitehouse')!;
const rss = (items: string) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>feed</title><link>https://watcher.guru</link>${items}</channel></rss>`;

// --- text ----------------------------------------------------------------------------------

test('stripHtml: tags out, named and numeric entities back (as WordPress writes them), each decoded once', () => {
  assert.equal(stripHtml('<p>Bitcoin&nbsp;<b>rallies</b></p>\n\n  again'), 'Bitcoin rallies again');
  assert.equal(stripHtml('AT&amp;T &lt;b&gt; &quot;q&quot; &#39;s&apos;'), 'AT&T <b> "q" \'s\'');
  // WordPress feeds: curly quotes and dashes as numeric references, the apostrophe as &#039;.
  assert.equal(stripHtml('Trump&#8217;s order &#8211; &#8220;tariffs&#8221; &#x2014; it&#039;s'), 'Trump’s order – “tariffs” — it\'s');
  // Text that shows an entity keeps it: &amp;lt; is the text "&lt;", not "<".
  assert.equal(stripHtml('write &amp;lt;b&amp;gt; for bold'), 'write &lt;b&gt; for bold');
  // A reference to nothing is left as it is.
  assert.equal(stripHtml('&#0; &#xFFFFFFF; &bogus;'), '&#0; &#xFFFFFFF; &bogus;');
  assert.equal(stripHtml(''), '');
});

// --- RSS -----------------------------------------------------------------------------------

test('parseRss: WordPress titles and links decoded, CDATA, the "appeared first" line and the [...] tail, content:encoded', () => {
  const when = 'Mon, 26 Oct 2026 14:05:00 +0000';
  const xml = rss(
    `<item><title>Trump&#8217;s Crypto Order: What&#039;s In It</title><link>https://watcher.guru/news/a?utm=rss&amp;id=7</link><pubDate>${when}</pubDate>`
      + '<description><![CDATA[<p>The order&#8230; covers <a href="#">stablecoins</a> [&#8230;]</p><p>The post Trump&#8217;s Crypto Order appeared first on Watcher Guru.</p>]]></description></item>'
      + `<item><title><![CDATA[Same as text]]></title><link><![CDATA[https://watcher.guru/news/b]]></link><pubDate>${when}</pubDate><description>Same as text</description></item>`
      + `<item><title>Only content</title><link>https://watcher.guru/news/c</link><pubDate>${when}</pubDate><content:encoded><![CDATA[<p>Full body</p>]]></content:encoded></item>`
      + `<item><title>Plain http</title><link>http://watcher.guru/news/d</link><pubDate>${when}</pubDate></item>`
      + `<item><title>Bad date</title><link>https://watcher.guru/news/e</link><pubDate>someday</pubDate></item>`
      + `<item><title></title><link>https://watcher.guru/news/f</link><pubDate>${when}</pubDate></item>`
      + `<item><title>${'x'.repeat(400)}</title><link>https://watcher.guru/news/g</link><pubDate>${when}</pubDate><description>${'y '.repeat(200)}</description></item>`,
  );
  const out = parseRss(xml, WG);
  assert.deepEqual(out.map((n) => n.href), [
    'https://watcher.guru/news/a?utm=rss&id=7',
    'https://watcher.guru/news/b',
    'https://watcher.guru/news/c',
    'https://watcher.guru/news/g',
  ]);
  assert.equal(out[0]!.title, 'Trump’s Crypto Order: What\'s In It');
  assert.equal(out[0]!.summary, 'The order… covers stablecoins…');
  assert.equal(out[0]!.id, 'watcherguru:https://watcher.guru/news/a?utm=rss&id=7');
  assert.equal(out[0]!.time, Date.parse('2026-10-26T14:05:00Z'));
  assert.equal(out[0]!.author, 'Watcher.Guru');
  assert.equal(out[0]!.category, null);
  // A description that only repeats the title is no summary.
  assert.equal(out[1]!.summary, null);
  assert.equal(out[2]!.summary, 'Full body');
  assert.equal(out[3]!.title.length, 320);
  assert.equal(out[3]!.summary!.length, 240);
  assert.deepEqual(parseRss('<html>blocked</html>', WG), []);
});

test('feedNews: older than eight days left out, one copy of a link across a source\'s feeds, coins and limit applied', async () => {
  resetFeeds();
  const now = Date.now();
  const item = (title: string, link: string, ago: number) => `<item><title>${title}</title><link>${link}</link><pubDate>${new Date(now - ago).toUTCString()}</pubDate></item>`;
  const fake = (async (url: string) => {
    if (url.includes('presidential-actions')) return new Response(rss(item('Order on trade', 'https://www.whitehouse.gov/x/', 2 * 3_600_000)));
    if (url.includes('whitehouse.gov/news')) {
      return new Response(rss(item('Order on trade', 'https://www.whitehouse.gov/x/', 2 * 3_600_000) + item('Old remarks', 'https://www.whitehouse.gov/old/', 9 * 86_400_000)));
    }
    return new Response(rss(Array.from({ length: 50 }, (_, k) => item(`Story ${k}`, `https://watcher.guru/news/${k}`, k * 60_000)).join('')));
  }) as typeof fetch;
  try {
    const all = await feedNews(parseFeedQuery({ ids: 'whitehouse,watcherguru', limit: '100' }), fake);
    assert.equal(all.filter((n) => n.source === 'whitehouse').length, 1);
    // At most 40 a source, newest first.
    assert.equal(all.filter((n) => n.source === 'watcherguru').length, 40);
    assert.ok(all.every((n, k) => k === 0 || all[k - 1]!.time >= n.time));
    assert.equal((await feedNews(parseFeedQuery({ ids: 'watcherguru', limit: '3' }), fake)).length, 3);
    // No coin index loaded: no story names a coin, so a coin filter leaves none.
    assert.deepEqual(await feedNews(parseFeedQuery({ ids: 'watcherguru', coin: 'BTC' }), fake), []);
    assert.deepEqual(await feedNews(parseFeedQuery({ ids: '' }), fake), []);
  } finally {
    resetFeeds();
  }
});

test('parseFeedQuery: a limit that is not a whole number, at least one, the search collapsed and bounded, coins checked', () => {
  assert.equal(parseFeedQuery({ limit: '2.5' }).limit, 60);
  assert.equal(parseFeedQuery({ limit: '0' }).limit, 1);
  assert.equal(parseFeedQuery({ limit: 7 }).limit, 60);
  const q = parseFeedQuery({ ids: 'watcherguru,watcherguru', coin: 'btc,$eth,toolongcoinname123,sol,xrp,doge,ada,link', q: `  fed   ${'r'.repeat(100)}  ` });
  assert.deepEqual(q.ids, ['watcherguru']);
  assert.deepEqual(q.coins, ['BTC', 'SOL', 'XRP', 'DOGE', 'ADA']);
  assert.equal(q.q!.length, 80);
  assert.ok(q.q!.startsWith('fed r'));
  assert.deepEqual(parseFeedQuery({}), { ids: [], coins: [], q: null, limit: 60 });
});

test('the logo route: hostnames only; image types from their bytes, short or odd ones refused', () => {
  assert.equal(logoDomain(' Sub.Example.CO.uk '), 'sub.example.co.uk');
  assert.equal(logoDomain('a.b'), null);
  assert.equal(logoDomain('-bad.com'), null);
  assert.equal(logoDomain('bad-.com'), null);
  assert.equal(logoDomain('example.com/path'), null);
  assert.equal(logoDomain('user@example.com'), null);
  assert.equal(logoDomain(`${'a'.repeat(98)}.com`), null);
  assert.equal(logoDomain(42), null);
  assert.equal(imageType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(imageType(Buffer.from('RIFF\0\0\0\0WAVEfmt ')), null);
  assert.equal(imageType(Buffer.from('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"/>')), 'image/svg+xml');
  assert.equal(imageType(Buffer.from('<html><svg></svg></html>')), null);
  assert.equal(imageType(Buffer.from([0x89, 0x50, 0x4e])), null);
  assert.equal(imageType(Buffer.alloc(0)), null);
});

// --- SoSoValue -------------------------------------------------------------------------------

test('parseNewsQuery: categories outside the list, page and limit bounds, the history only for the latest feed without a search', () => {
  const q = parseNewsQuery({ category: '6', page: '999', limit: '500', coin: 'btc,BTC,eth', posts: 'some' });
  assert.deepEqual([q.feed, q.category, q.page, q.limit, q.coins, q.posts, q.topic, q.history], ['latest', null, 50, 50, ['BTC', 'ETH'], 'notable', null, false]);
  assert.equal(parseNewsQuery({ category: '13' }).category, 13);
  assert.equal(parseNewsQuery({ category: '1.5' }).category, null);
  assert.equal(parseNewsQuery({ page: '0' }).page, 1);
  assert.equal(parseNewsQuery({ limit: '-3' }).limit, 1);
  assert.equal(parseNewsQuery({ feed: 'top' }).feed, 'latest');
  const h = parseNewsQuery({ history: 'true', page: '3', limit: '1000' });
  assert.deepEqual([h.history, h.page, h.limit], [true, 1, 300]);
  assert.equal(parseNewsQuery({ history: '1', feed: 'hot' }).history, false);
  assert.equal(parseNewsQuery({ history: '1', q: 'etf' }).history, false);
  assert.equal(parseNewsQuery({ q: ' a ' }).q, null);
  assert.equal(parseNewsQuery({ topic: 'macro', posts: 'all' }).topic, 'macro');
});

test('notablePost: the thresholds exactly, counts as strings, the account type in any case', () => {
  assert.equal(notablePost({ impression_count: 9_999 }), false);
  assert.equal(notablePost({ impression_count: 10_000 }), true);
  assert.equal(notablePost({ like_count: '100' }), true);
  assert.equal(notablePost({ like_count: '99', retweet_count: 24 }), false);
  assert.equal(notablePost({ retweet_count: 25 }), true);
  assert.equal(notablePost({ verified_type: 'Government' }), true);
  assert.equal(notablePost({ verified_type: 'blue', like_count: '1e9' }), false);
  assert.equal(notablePost({}), false);
});

test('isMacroStory: whole words and the phrases that are economics, not a company\'s treasury or a staking yield', () => {
  for (const t of ['Fed holds rates', 'FOMC minutes', 'Treasury yields climb', 'US CPI beats', 'Jobless claims fall', '10-year at 5%', 'ECB cuts', 'Rate cut odds rise', 'Quantitative tightening ends'])
    assert.equal(isMacroStory({ title: t }), true, t);
  for (const t of ['FedEx ships bitcoin', 'Strategy adds to its bitcoin treasury', 'Staking yield tops 7%', 'Validator bond slashed', 'Federation launch'])
    assert.equal(isMacroStory({ title: t }), false, t);
  // The summary is not read.
  assert.equal(isMacroStory({ title: 'Solana upgrade', summary: 'as inflation cools' }), false);
});

const INDEX = coinIndex([
  { symbol: 'BTC', name: 'Bitcoin' },
  { symbol: 'BCH', name: 'Bitcoin Cash' },
  { symbol: 'ETH', name: 'Ethereum' },
  { symbol: 'SOL', name: 'Solana' },
  { symbol: 'SEC', name: 'Secret' },
  { symbol: 'NEAR', name: 'Near' },
  { symbol: 'HSBC', name: '{"EN":"HSBC HOLDINGS PLC ADR"}' },
  { symbol: 'btc', name: 'Bitcoin copy' },
  { symbol: '1000', name: 'Thousand' },
]);

test('coinsIn: tickers in capitals with or without $, names whole and longest first, at most max, in order of first mention', () => {
  assert.deepEqual(coinsIn('Bitcoin Cash forks; bitcoin steady', INDEX), ['BCH', 'BTC']);
  assert.deepEqual(coinsIn('$SOL and ETH beat btc, says the SEC', INDEX), ['SOL', 'ETH']);
  assert.deepEqual(coinsIn('SOLANA, Ethereum, BTC, BCH, SOL', INDEX, 2), ['SOL', 'ETH']);
  assert.deepEqual(coinsIn('ETHBTC pair and XSOL token', INDEX), []);
  // A ticker of everyday words still counts in capitals; the word alone does not.
  assert.deepEqual(coinsIn('near the highs, NEAR rallies', INDEX), ['NEAR']);
  assert.deepEqual(coinsIn('HSBC buys 1000 coins', INDEX), []);
  assert.deepEqual(coinsIn('', INDEX), []);
  assert.equal(INDEX.bySymbol.get('BTC')!.name, 'Bitcoin');
});

test('stockName: JSON names are stocks; anything else is not', () => {
  assert.equal(stockName('{"EN":" HSBC HOLDINGS "}'), 'HSBC HOLDINGS');
  assert.equal(stockName('{"zh":"汇丰"}'), '汇丰');
  assert.equal(stockName('{"EN":7}'), '');
  assert.equal(stockName('{not json'), null);
  assert.equal(stockName('Bitcoin'), null);
  assert.equal(stockName(null), null);
});

test('namesCoin: SoSoValue tagging that coin alone, else the text, else its tags without an index', () => {
  assert.equal(namesCoin({ title: 'Market wrap', summary: null, symbols: ['SOL'] }, 'SOL', INDEX), true);
  assert.equal(namesCoin({ title: 'Market wrap', summary: null, symbols: ['SOL', 'ETH'] }, 'SOL', INDEX), false);
  assert.equal(namesCoin({ title: 'Solana ETF filed', summary: null, symbols: ['SOL', 'ETH'] }, 'SOL', INDEX), true);
  assert.equal(namesCoin({ title: 'x', summary: null, symbols: ['ETH', 'SOL'] }, 'SOL', null), true);
});

test('mapNewsList: entities in titles decoded once, a numeric id\'s own page, rows without a title or link dropped, the limit kept', () => {
  const out = mapNewsList({ data: { list: [
    { id: 11, title: 'Fed&#8217;s Powell &amp;amp; co', content: '', release_time: '1761600000000' },
    { id: 'abc', title: 'No link and no numeric id' },
    { id: 12, title: '   ', content: '' },
    { id: 13, title: 'Third', source_link: 'ftp://x/y', release_time: 'soon' },
    { id: 14, title: 'Fourth' },
  ], total: 4 } }, 2);
  assert.deepEqual(out.map((n) => [n.id, n.title, n.href, n.time]), [
    ['11', 'Fed’s Powell &amp; co', 'https://sosovalue.com/research/11', 1761600000000],
    ['13', 'Third', 'https://sosovalue.com/research/13', 0],
  ]);
});

// --- ETF flows -------------------------------------------------------------------------------

test('sosoData: code 0 (number or text) is the data, any other code an error, a bare body as it is', () => {
  assert.deepEqual(sosoData({ code: 0, data: [1] }), [1]);
  assert.deepEqual(sosoData({ code: '0', data: { a: 1 } }), { a: 1 });
  assert.throws(() => sosoData({ code: 40001, message: 'rate limited' }), /SoSoValue 40001: rate limited/);
  assert.throws(() => sosoData({ code: 1 }), /SoSoValue 1: error/);
  assert.deepEqual(sosoData([2]), [2]);
  assert.equal(sosoData(null), null);
});

test('parseEtfSummary: a day read twice is its last copy, unsettled and undated rows left out, whole dollars, oldest first', () => {
  const days = parseEtfSummary({ code: 0, data: [
    { date: '2026-10-23', total_net_inflow: '100.6', cum_net_inflow: 1000, total_net_assets: '5e9', total_value_traded: null },
    { date: '2026-10-22', total_net_inflow: -50.4, cum_net_inflow: '900', total_net_assets: '', total_value_traded: 'n/a' },
    { date: '2026-10-23', total_net_inflow: 120, cum_net_inflow: 1020, total_net_assets: 5.1e9, total_value_traded: 7 },
    { date: '2026-10-24', total_net_inflow: null },
    { date: '24/10/2026', total_net_inflow: 1 },
    null,
  ] });
  assert.deepEqual(days, [
    { date: '2026-10-22', netInflow: -50, cumNetInflow: 900, totalNetAssets: null, valueTraded: null },
    { date: '2026-10-23', netInflow: 120, cumNetInflow: 1020, totalNetAssets: 5_100_000_000, valueTraded: 7 },
  ]);
  assert.deepEqual(parseEtfSummary({ code: 0, data: {} }), []);
});

test('parseEtfList and parseEtfSnapshot: tickers checked and kept once; a snapshot dated by a day or a timestamp', () => {
  assert.deepEqual(parseEtfList([{ ticker: ' ibit ', name: ' iShares ', exchange: 'NASDAQ' }, { ticker: 'IBIT', name: 'again' }, { ticker: 'BRK.B' }, { ticker: 'WAY-TOO-LONG' }, { ticker: 7 }]), [
    { ticker: 'IBIT', name: 'iShares', exchange: 'NASDAQ' },
    { ticker: 'BRK.B', name: 'BRK.B' },
  ]);
  assert.deepEqual(parseEtfSnapshot({ code: 0, data: { ticker: 'fbtc', date: Date.parse('2026-10-23T00:00:00Z'), net_inflow: '1.5', net_assets: null, mkt_price: '88.12' } }), {
    ticker: 'FBTC', date: '2026-10-23', netInflow: 2, netAssets: null, price: 88.12,
  });
  assert.equal(parseEtfSnapshot({ ticker: 'X', date: 20261023 })!.date, null);
  assert.equal(parseEtfSnapshot({ date: '2026-10-23' }), null);
  assert.equal(parseEtfSnapshot(null), null);
});

const day = (date: string, netInflow: number, totalNetAssets: number | null = null): EtfDay => ({ date, netInflow, cumNetInflow: null, totalNetAssets, valueTraded: null });

test('mergeDays and daysIn: a revised day replaces the kept one; the range counts back from the newest day', () => {
  const merged = mergeDays([day('2026-10-21', 1), day('2026-10-22', 2)], [day('2026-10-22', 5), day('2026-10-20', 0)]);
  assert.deepEqual(merged.map((d) => [d.date, d.netInflow]), [['2026-10-20', 0], ['2026-10-21', 1], ['2026-10-22', 5]]);
  const long = [day('2025-10-23', 1), day('2026-07-23', 1), day('2026-07-24', 1), day('2026-09-22', 1), day('2026-09-23', 1), day('2026-10-23', 1)];
  assert.deepEqual(daysIn(long, '1m').map((d) => d.date), ['2026-09-23', '2026-10-23']);
  assert.deepEqual(daysIn(long, '3m').map((d) => d.date), ['2026-07-24', '2026-09-22', '2026-09-23', '2026-10-23']);
  assert.equal(daysIn(long, '1y').length, 6);
  assert.equal(daysIn(long, 'all').length, 6);
  assert.deepEqual(daysIn([], '1m'), []);
  assert.equal(parseEtfAsset(' eth '), 'ETH');
  assert.equal(parseEtfAsset('PEPE'), 'BTC');
  assert.equal(parseEtfRange('3m'), '3m');
  assert.equal(parseEtfRange('5y'), '1m');
});

test('buildFunds: share of the day\'s total, of the funds\' own sum when the summary is behind and every fund is in, else none', () => {
  const list = [{ ticker: 'IBIT', name: 'iShares' }, { ticker: 'FBTC', name: 'Fidelity' }, { ticker: 'ARKB', name: 'Ark' }];
  const snap = (ticker: string, date: string | null, netAssets: number | null) => ({ ticker, date, netInflow: 1, netAssets, price: null });
  // The summary is at the 22nd; every snapshot says the 23rd.
  const ahead = buildFunds(list, new Map([['IBIT', snap('IBIT', '2026-10-23', 60)], ['FBTC', snap('FBTC', '2026-10-23', 30)], ['ARKB', snap('ARKB', '2026-10-23', 10)]]), [day('2026-10-22', 1, 99)]);
  assert.deepEqual(ahead.map((f) => [f.ticker, f.share]), [['IBIT', 0.6], ['FBTC', 0.3], ['ARKB', 0.1]]);
  // One fund still at the 22nd: the others have no total to share against.
  const mixed = buildFunds(list, new Map([['IBIT', snap('IBIT', '2026-10-23', 60)], ['FBTC', snap('FBTC', '2026-10-22', 30)]]), [day('2026-10-22', 1, 100)]);
  assert.deepEqual(mixed.map((f) => [f.ticker, f.netAssets, f.share, f.date]), [['IBIT', 60, null, '2026-10-23'], ['FBTC', 30, 0.3, '2026-10-22'], ['ARKB', null, null, null]]);
  // Equal assets: by ticker.
  const tie = buildFunds([{ ticker: 'B', name: 'b' }, { ticker: 'A', name: 'a' }], new Map([['A', snap('A', null, 5)], ['B', snap('B', null, 5)]]), []);
  assert.deepEqual(tie.map((f) => [f.ticker, f.share]), [['A', null], ['B', null]]);
});
