/**
 * SoSoValue news: the page is reduced to title, link, time, author, coins and
 * keywords, in the shapes SoSoValue sends (times as strings, coins as
 * {currency_id, symbol, name}, stocks with JSON names). Nothing here calls the
 * network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as mod from '../src/valuescan/sosovalue/news.js';
import { latestNews, mapNewsList, resetNewsCache } from '../src/valuescan/sosovalue/news.js';
import { coinIndex, coinsIn, stockName } from '../src/valuescan/sosovalue/coins.js';

const CURRENCIES = [
  { currency_id: '1', symbol: 'btc', name: 'Bitcoin' },
  { currency_id: '2', symbol: 'eth', name: 'Ethereum' },
  { currency_id: '3', symbol: 'USDC', name: 'USDC' },
  { currency_id: '4', symbol: 'SOL', name: 'SOLANA' },
  { currency_id: '5', symbol: 'HSBC', name: '{"EN": "HSBC HOLDINGS PLC ADR"}' },
  { currency_id: '6', symbol: 'SEC', name: 'Secret' },
  { currency_id: '7', symbol: 'flow', name: 'Flow' },
];

test('mapNewsList: SoSoValue\'s shapes - a string time, tickers not names, no stocks, at most four coins', () => {
  const items = mapNewsList({
    code: 0,
    data: {
      list: [
        {
          id: '11',
          title: 'Hello',
          source_link: 'https://sosovalue.com/research/11',
          release_time: '1792794902000',
          nick_name: 'Ada',
          matched_currencies: [
            { currency_id: '1', symbol: 'btc', name: 'Bitcoin' }, { symbol: 'eth', name: 'Ethereum' },
            { symbol: 'HSBC', name: '{"EN": "HSBC HOLDINGS PLC ADR"}' }, { symbol: 'sol', name: 'SOLANA' }, { symbol: 'btc', name: 'BITCOIN' },
            { symbol: 'doge', name: 'Dogecoin' }, { symbol: 'xrp', name: 'XRP' },
          ],
          tags: ['Germany', ' BASF ', 'Germany'],
        },
        { id: 'b', title: null, content: '<p>Only &amp; body</p>', original_link: 'javascript:alert(1)' },
        { id: 'c', title: '  ', content: '<p>Plain <b>story</b></p>', source_link: 'https://example.com/c', release_time: 20 },
        { title: 'No link and no id' },
      ],
    },
  }, 12);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.title, 'Hello');
  assert.equal(items[0]!.time, 1792794902000, 'the time comes as a string');
  assert.equal(items[0]!.author, 'Ada');
  assert.deepEqual(items[0]!.symbols, ['BTC', 'ETH', 'SOL', 'DOGE'], 'tickers, the stock left out, four at most');
  assert.deepEqual(items[0]!.tags, ['Germany', 'BASF']);
  assert.equal(items[1]!.title, 'Plain story');
  assert.equal(items[1]!.href, 'https://example.com/c');
});

test('mapNewsList: a post is its own text, a story without a link gets SoSoValue\'s page, a second copy of a story is dropped', () => {
  const items = mapNewsList({
    list: [
      { id: '1', title: 'The chart for today 😂 Something big…', content: 'The chart for today 😂 Something big is coming, trust me.', original_link: 'https://twitter.com/x/status/1', source_link: 'https://sosovalue.com/research/1', category: 4 },
      { id: '2113744892984115200', title: 'Market <span style="color:#F00">Bitcoin</span> deleverages', content: 'More.', source_link: null, original_link: null },
      { id: '3', title: 'U.S. Bitcoin ETFs saw an outflow of 6,998 BTC', source_link: 'https://a.example/3' },
      { id: '4', title: 'U.S. Bitcoin ETFs saw an outflow of 6,998 BTC.', source_link: 'https://b.example/4' },
    ],
  }, 12);
  assert.equal(items.length, 3);
  assert.equal(items[0]!.post, true);
  assert.equal(items[0]!.title, 'The chart for today 😂 Something big is coming, trust me.');
  assert.equal(items[0]!.summary, null, 'a post has no summary under it');
  assert.equal(items[1]!.title, 'Market Bitcoin deleverages', 'the search highlight is stripped');
  assert.equal(items[1]!.href, 'https://sosovalue.com/research/2113744892984115200');
  assert.equal(items.filter((n) => n.title.startsWith('U.S. Bitcoin ETFs')).length, 1);
});

test('mapNewsList: coins found in the text when SoSoValue tagged none, and the hot list numbered', () => {
  const index = coinIndex(CURRENCIES);
  const items = mapNewsList({
    list: [
      { id: '1', title: 'BlackRock moved $356 million in BTC and ETH to Coinbase', source_link: 'https://sosovalue.com/hot/1' },
      { id: '2', title: 'The SEC delays a decision', source_link: 'https://sosovalue.com/hot/2' },
      { id: '3', title: 'Solana outpaces Bitcoin', source_link: 'https://sosovalue.com/hot/3' },
    ],
  }, 12, { index, rankFrom: 21 });
  assert.deepEqual(items.map((n) => n.symbols), [['BTC', 'ETH'], [], ['SOL', 'BTC']]);
  assert.deepEqual(items.map((n) => n.rank), [21, 22, 23]);
});

test('coins: tickers in capitals, names whole and in any case, stocks and everyday words left out', () => {
  const index = coinIndex(CURRENCIES);
  assert.deepEqual(index.coins.map((c) => c.symbol), ['BTC', 'ETH', 'USDC', 'SOL', 'SEC', 'FLOW']);
  assert.deepEqual(coinsIn('$SOL and bitcoin rally; ETH lags', index), ['SOL', 'BTC', 'ETH']);
  assert.deepEqual(coinsIn('The SEC says the flow of funds is up', index), [], 'SEC is the regulator, flow a word');
  assert.deepEqual(coinsIn('FLOW jumps 20%', index), ['FLOW'], 'a ticker in capitals still counts');
  assert.deepEqual(coinsIn('btcfi and Ethereumish', index), [], 'only whole words');
  assert.equal(stockName('{"EN": "HSBC HOLDINGS PLC ADR"}'), 'HSBC HOLDINGS PLC ADR');
  assert.equal(stockName('Bitcoin'), null);
});

test('mapNewsList reads a page wrapped in data', () => {
  const items = mapNewsList({ data: { list: [{ id: 'z', title: 'Wrapped', source_link: 'http://example.com/z' }] } }, 4);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.title, 'Wrapped');
});

const withKey = async (fn: () => Promise<void>) => {
  const prev = process.env.SOSOVALUE_API_KEY;
  process.env.SOSOVALUE_API_KEY = 'test-key';
  resetNewsCache();
  try {
    await fn();
  } finally {
    resetNewsCache();
    if (prev === undefined) delete process.env.SOSOVALUE_API_KEY;
    else process.env.SOSOVALUE_API_KEY = prev;
  }
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('latestNews asks once and serves the cache', () => withKey(async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    urls.push(String(url));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-soso-api-key'), 'test-key');
    assert.equal(String(url).includes('test-key'), false);
    return json(String(url).includes('/currencies') ? { code: 0, data: CURRENCIES } : { list: [{ id: 'n', title: 'One', source_link: 'https://example.com/n', release_time: '5' }] });
  };
  const a = await latestNews(8, fetchImpl);
  const b = await latestNews(8, fetchImpl);
  assert.equal(urls.filter((u) => u.includes('/news')).length, 1);
  assert.equal(a[0]!.title, 'One');
  assert.equal(a[0]!.time, 5);
  assert.equal(b[0]!.id, 'n');
}));

test('parseNewsQuery: known values pass, anything else falls back; coins come comma-separated', () => {
  const { parseNewsQuery } = mod;
  assert.deepEqual(parseNewsQuery({}), { feed: 'latest', category: null, coins: [], q: null, page: 1, limit: 12 });
  assert.deepEqual(
    parseNewsQuery({ feed: 'hot', category: '2', coin: ' btc ', q: '  etf   flows ', page: '3', limit: '200' }),
    { feed: 'hot', category: 2, coins: ['BTC'], q: 'etf flows', page: 3, limit: 50 },
  );
  assert.deepEqual(parseNewsQuery({ coin: 'btc,eth, sol,btc,BTC; DROP,a,b,c,d' }).coins, ['BTC', 'ETH', 'SOL', 'A', 'B'], 'valid, distinct, five at most');
  assert.equal(parseNewsQuery({ category: '5' }).category, null, 'not a SoSoValue category');
  assert.deepEqual(parseNewsQuery({ coin: 'BTC; DROP' }).coins, []);
  assert.equal(parseNewsQuery({ q: 'x' }).q, null, 'one letter is not a search');
});

test('newsUrl: search, hot, featured and the filtered feed', () => {
  const { newsUrl, parseNewsQuery } = mod;
  const search = new URL(newsUrl(parseNewsQuery({ q: 'etf', category: '1' }), null));
  assert.equal(search.pathname, '/openapi/v1/news/search');
  assert.equal(search.searchParams.get('keyword'), 'etf');
  assert.equal(search.searchParams.get('category'), '1');
  assert.equal(new URL(newsUrl(parseNewsQuery({ feed: 'hot' }), null)).pathname, '/openapi/v1/news/hot');
  assert.equal(new URL(newsUrl(parseNewsQuery({ feed: 'featured' }), null)).pathname, '/openapi/v1/news/pick');
  assert.equal(new URL(newsUrl(parseNewsQuery({ feed: 'hot', coin: 'BTC' }), null)).searchParams.get('page_size'), '50', 'a list filtered here reads more');
  const feed = new URL(newsUrl(parseNewsQuery({ category: '13' }), '1673723677362319867'));
  assert.equal(feed.pathname, '/openapi/v1/news');
  assert.equal(feed.searchParams.get('category'), '13');
  assert.equal(feed.searchParams.get('currency_id'), '1673723677362319867');
  assert.equal(feed.searchParams.get('language'), 'en');
});

test('news: a coin is looked up once, a coin SoSoValue does not list is an empty page, the page carries its total', () => withKey(async () => {
  const { news, parseNewsQuery } = mod;
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    urls.push(String(url));
    return json(String(url).includes('/currencies')
      ? { code: 0, data: CURRENCIES }
      : { code: 0, data: { page: 1, total: 41, list: [{ id: 'n', title: 'BTC up', content: '<p>BTC up, and more.</p>', source_link: 'https://example.com/n', category: 1 }] } });
  };
  const btc = await news(parseNewsQuery({ coin: 'BTC' }), fetchImpl);
  assert.equal(btc.total, 41);
  assert.equal(btc.items[0]!.category, 1);
  assert.equal(btc.items[0]!.summary, 'BTC up, and more.');
  assert.ok(urls.some((u) => u.includes('currency_id=1')));
  const none = await news(parseNewsQuery({ coin: 'NOPE' }), fetchImpl);
  assert.deepEqual(none.items, []);
  assert.equal(urls.filter((u) => u.includes('/currencies')).length, 1, 'the currency list is read once');
}));

test('news: several coins in the feed are each coin\'s page, merged by time; the hot list is filtered by its stories\' coins', () => withKey(async () => {
  const { news, parseNewsQuery } = mod;
  const fetchImpl: typeof fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/currencies')) return json({ code: 0, data: CURRENCIES });
    if (u.pathname.endsWith('/news/hot')) {
      return json({ data: { list: [
        { id: 'h1', title: 'Ethereum gas falls', source_link: 'https://sosovalue.com/hot/h1', release_time: '9' },
        { id: 'h2', title: 'Phantom launches a market', source_link: 'https://sosovalue.com/hot/h2', release_time: '8' },
        { id: 'h3', title: 'BTC holds $80k', source_link: 'https://sosovalue.com/hot/h3', release_time: '7' },
      ] } });
    }
    const c = u.searchParams.get('currency_id');
    return json({ data: { total: 99, list: [
      { id: `a${c}`, title: `Story ${c} new`, source_link: `https://example.com/a${c}`, release_time: c === '1' ? '30' : '20' },
      { id: `b${c}`, title: `Story ${c} old`, source_link: `https://example.com/b${c}`, release_time: c === '1' ? '10' : '15' },
    ] } });
  };
  const merged = await news(parseNewsQuery({ coin: 'BTC,ETH', limit: '3' }), fetchImpl);
  assert.deepEqual(merged.items.map((n) => n.id), ['a1', 'a2', 'b2']);
  assert.equal(merged.total, null);
  const hot = await news(parseNewsQuery({ feed: 'hot', coin: 'BTC,ETH' }), fetchImpl);
  assert.deepEqual(hot.items.map((n) => [n.id, n.rank, n.symbols.join()]), [['h1', 1, 'ETH'], ['h3', 3, 'BTC']], 'the coinless story is left out, each keeps its place');
}));

test('news: past the budget a query is refused as busy, never sent', () => withKey(async () => {
  const { news, parseNewsQuery } = mod;
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return json({ list: [] });
  };
  // The first query reads the currency list too: 1 + 14 pages is the budget of 15.
  for (let p = 1; p <= 14; p++) await news(parseNewsQuery({ page: String(p) }), fetchImpl);
  await assert.rejects(news(parseNewsQuery({ page: '15' }), fetchImpl), /busy/);
  assert.equal(calls, 15);
}));
