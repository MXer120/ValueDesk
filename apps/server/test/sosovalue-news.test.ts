/**
 * SoSoValue news: the page is reduced to title, link, time, author and coins.
 * Nothing here calls the network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
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
