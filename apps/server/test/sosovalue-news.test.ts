/**
 * SoSoValue news: the page is reduced to title, link, time, author and coins.
 * Nothing here calls the network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as mod from '../src/valuescan/sosovalue/news.js';
import { latestNews, mapNewsList, resetNewsCache } from '../src/valuescan/sosovalue/news.js';

test('mapNewsList keeps a title, an http(s) link and at most three symbols', () => {
  const items = mapNewsList({
    list: [
      {
        id: 'a',
        title: 'Hello',
        source_link: 'https://sosovalue.xyz/research/1',
        release_time: 10,
        nick_name: 'Ada',
        matched_currencies: [{ name: 'btc' }, { name: 'eth' }, { name: 'sol' }, { name: 'btc' }, { name: 'doge' }],
      },
      { id: 'b', title: null, content: '<p>Only &amp; body</p>', original_link: 'javascript:alert(1)' },
      { id: 'c', title: '  ', content: '<p>Plain <b>story</b></p>', source_link: 'https://example.com/c', release_time: 20 },
      { title: 'No link' },
    ],
  }, 12);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.title, 'Hello');
  assert.equal(items[0]!.author, 'Ada');
  assert.deepEqual(items[0]!.symbols, ['BTC', 'ETH', 'SOL']);
  assert.equal(items[1]!.title, 'Plain story');
  assert.equal(items[1]!.href, 'https://example.com/c');
});

test('mapNewsList reads a page wrapped in data', () => {
  const items = mapNewsList({ data: { list: [{ id: 'z', title: 'Wrapped', source_link: 'http://example.com/z' }] } }, 4);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.title, 'Wrapped');
});

test('latestNews asks once and serves the cache', async () => {
  const prev = process.env.SOSOVALUE_API_KEY;
  process.env.SOSOVALUE_API_KEY = 'test-key';
  resetNewsCache();
  let calls = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls += 1;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-soso-api-key'), 'test-key');
    assert.equal(String(_url).includes('test-key'), false);
    return new Response(JSON.stringify({
      list: [{ id: 'n', title: 'One', source_link: 'https://example.com/n', release_time: 5 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const a = await latestNews(8, fetchImpl);
    const b = await latestNews(8, fetchImpl);
    assert.equal(calls, 1);
    assert.equal(a[0]!.title, 'One');
    assert.equal(b[0]!.id, 'n');
  } finally {
    resetNewsCache();
    if (prev === undefined) delete process.env.SOSOVALUE_API_KEY;
    else process.env.SOSOVALUE_API_KEY = prev;
  }
});

test('parseNewsQuery: known values pass, anything else falls back', () => {
  const { parseNewsQuery } = mod;
  assert.deepEqual(parseNewsQuery({}), { feed: 'latest', category: null, coin: null, q: null, page: 1, limit: 12 });
  assert.deepEqual(
    parseNewsQuery({ feed: 'hot', category: '2', coin: ' btc ', q: '  etf   flows ', page: '3', limit: '200' }),
    { feed: 'hot', category: 2, coin: 'BTC', q: 'etf flows', page: 3, limit: 50 },
  );
  assert.equal(parseNewsQuery({ category: '5' }).category, null, 'not a SoSoValue category');
  assert.equal(parseNewsQuery({ coin: 'BTC; DROP' }).coin, null);
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
  const feed = new URL(newsUrl(parseNewsQuery({ category: '13' }), '1673723677362319867'));
  assert.equal(feed.pathname, '/openapi/v1/news');
  assert.equal(feed.searchParams.get('category'), '13');
  assert.equal(feed.searchParams.get('currency_id'), '1673723677362319867');
  assert.equal(feed.searchParams.get('language'), 'en');
});

test('news: a coin is looked up once, a coin SoSoValue does not list is an empty page, the page carries its total', async () => {
  const { news, parseNewsQuery } = mod;
  const prev = process.env.SOSOVALUE_API_KEY;
  process.env.SOSOVALUE_API_KEY = 'test-key';
  resetNewsCache();
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    urls.push(String(url));
    const body = String(url).includes('/currencies')
      ? [{ currency_id: '7', symbol: 'btc', name: 'Bitcoin' }]
      : { code: 0, data: { page: 1, total: 41, list: [{ id: 'n', title: 'BTC up', content: '<p>BTC up, and more.</p>', source_link: 'https://example.com/n', category: 1 }] } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const btc = await news(parseNewsQuery({ coin: 'BTC' }), fetchImpl);
    assert.equal(btc.total, 41);
    assert.equal(btc.items[0]!.category, 1);
    assert.equal(btc.items[0]!.summary, 'BTC up, and more.');
    assert.ok(urls.some((u) => u.includes('currency_id=7')));
    const none = await news(parseNewsQuery({ coin: 'NOPE' }), fetchImpl);
    assert.deepEqual(none.items, []);
    assert.equal(urls.filter((u) => u.includes('/currencies')).length, 1, 'the currency list is read once');
  } finally {
    resetNewsCache();
    if (prev === undefined) delete process.env.SOSOVALUE_API_KEY;
    else process.env.SOSOVALUE_API_KEY = prev;
  }
});

test('news: past the budget a query is refused as busy, never sent', async () => {
  const { news, parseNewsQuery } = mod;
  const prev = process.env.SOSOVALUE_API_KEY;
  process.env.SOSOVALUE_API_KEY = 'test-key';
  resetNewsCache();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ list: [] }), { status: 200 });
  };
  try {
    for (let p = 1; p <= 15; p++) await news(parseNewsQuery({ page: String(p) }), fetchImpl);
    await assert.rejects(news(parseNewsQuery({ page: '16' }), fetchImpl), /busy/);
    assert.equal(calls, 15);
  } finally {
    resetNewsCache();
    if (prev === undefined) delete process.env.SOSOVALUE_API_KEY;
    else process.env.SOSOVALUE_API_KEY = prev;
  }
});
