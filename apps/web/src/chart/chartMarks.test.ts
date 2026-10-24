/**
 * The chart's own marks: fill arrows and news badges, grouped per bar.
 *   npx tsx --test src/chart/chartMarks.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEWS_KINDS, SYSTEM_OVERLAYS, barOpen, clusterNews, fillMarks, markFace, newsCoin, newsKind, newsMarks, sanitizeShow } from './chartMarks';

const MIN = 60_000;
const DAY = 86_400_000;

test('a moment lands on the open of its bar', () => {
  const t = Date.UTC(2026, 9, 24, 14, 47, 31);
  assert.equal(barOpen(t, '1m'), Date.UTC(2026, 9, 24, 14, 47));
  assert.equal(barOpen(t, '15m'), Date.UTC(2026, 9, 24, 14, 45));
  assert.equal(barOpen(t, '4h'), Date.UTC(2026, 9, 24, 12));
  assert.equal(barOpen(t, '1D'), Date.UTC(2026, 9, 24));
  // 24 Oct 2026 is a Saturday: its week opened on Monday the 19th.
  assert.equal(barOpen(t, '1W'), Date.UTC(2026, 9, 19));
  assert.equal(barOpen(t, '1M'), Date.UTC(2026, 9, 1));
  // The loaded bars know better.
  assert.equal(barOpen(t, '1W', () => Date.UTC(2026, 9, 18)), Date.UTC(2026, 9, 18));
  assert.equal(barOpen(t, '1m', () => null), Date.UTC(2026, 9, 24, 14, 47));
});

test('fills of one side in one bar make one arrow at their size-weighted price', () => {
  const at = Date.UTC(2026, 9, 24, 14, 0);
  const rows = [
    { symbol: 'BTC-USD', side: 'BUY', price: '100', quantity: '1', time: at + 5_000 },
    { symbol: 'BTC-USD', side: 'BUY', price: '110', quantity: '3', time: at + 20_000 },
    { symbol: 'BTC-USD', side: 2, price: '120', quantity: '0.5', time: at + 30_000 },
    { symbol: 'BTC-USD', side: 'SELL', price: '130', quantity: '1', time: at + MIN + 1 },
    { symbol: 'ETH-USD', side: 'BUY', price: '5', quantity: '1', time: at },
    { symbol: 'BTC-USD', side: 'BUY', price: 'x', quantity: '1', time: at },
    null,
  ];
  const marks = fillMarks(rows, 'BTC-USD', '1m');
  assert.deepEqual(
    marks.map((m) => [m.timestamp - at, m.side, m.price, m.qty, m.count]),
    [
      [0, 'buy', 107.5, 4, 2],
      [0, 'sell', 120, 0.5, 1],
      [MIN, 'sell', 130, 1, 1],
    ],
  );
  assert.equal(marks[0]!.last, at + 20_000);
  // On an hourly chart the second-minute sell joins the first.
  assert.equal(fillMarks(rows, 'BTC-USD', '1h').length, 2);
});

test('news lands on the bar it came out in, newest first, each story once', () => {
  const at = Date.UTC(2026, 9, 24, 14, 0);
  const story = (id: string, time: number) => ({ id, title: id, href: `https://example.com/${id}`, time });
  const marks = newsMarks([story('a', at + 1_000), story('b', at + 50_000), story('a', at + 1_000), story('c', at + 2 * MIN), story('d', 0)], '1m');
  assert.deepEqual(marks.map((m) => [m.timestamp - at, m.stories.map((s) => s.id)]), [[0, ['b', 'a']], [2 * MIN, ['c']]]);
  assert.equal(newsMarks([story('a', at)], '1D')[0]!.timestamp, Date.UTC(2026, 9, 24));
  assert.equal(newsMarks([], '1m').length, 0);
  // Zoomed out, badges three bars apart are one.
  const merged = newsMarks([story('a', at), story('b', at + 2 * MIN), story('c', at + 3 * MIN), story('e', at + 9 * MIN)], '1m', undefined, 3 * MIN);
  assert.deepEqual(merged.map((m) => [m.timestamp - at, m.stories.map((s) => s.id)]), [[0, ['b', 'a']], [3 * MIN, ['c']], [9 * MIN, ['e']]]);
  assert.equal(DAY, 86_400_000);
});

test('a market names its coin the way the news does', () => {
  assert.equal(newsCoin('BTC'), 'BTC');
  assert.equal(newsCoin('vBTC'), 'BTC');
  assert.equal(newsCoin('1000PEPE'), 'PEPE');
  assert.equal(newsCoin(null), '');
});

test('the marks and order lines are never user drawings', () => {
  for (const n of ['vs_exec', 'vs_news', 'ot_order_line']) assert.ok(SYSTEM_OVERLAYS.has(n), n);
  assert.ok(!SYSTEM_OVERLAYS.has('segment'));
});

test('the same story told twice is one marker entry, the latest copy kept', () => {
  const at = Date.UTC(2026, 9, 24, 14, 0);
  const marks = newsMarks(
    [
      { id: 'a', title: 'BTC breaks $80,000!', href: 'https://x/a', time: at + 5_000 },
      { id: 'b', title: 'btc breaks 80000 ', href: 'https://x/b', time: at + 40_000 },
      { id: 'c', title: 'ETH ETF inflows', href: 'https://x/c', time: at + 50_000 },
    ],
    '1m',
  );
  assert.deepEqual(marks[0]!.stories.map((s) => s.id), ['c', 'b']);
});

test('a marker shows what its newest story is', () => {
  const s = (o: object) => ({ id: 'x', title: 't', href: 'h', time: 1, ...o });
  assert.equal(newsKind(s({ post: true, category: 5 })), 'post');
  assert.equal(newsKind(s({ category: 2 })), 'research');
  assert.equal(newsKind(s({ category: 99 })), 'news');
  assert.equal(newsKind(s({})), 'news');
  // On the BTC chart a BTC story shows its kind; an ETH one, ETH's logo.
  assert.deepEqual(markFace({ stories: [s({ category: 7, symbols: ['BTC'] })] }, 'BTC'), { kind: 'announcement', coin: null });
  assert.deepEqual(markFace({ stories: [s({ category: 1, symbols: ['BTC', 'ETH'] })] }, 'BTC'), { kind: 'news', coin: 'ETH' });
  // Among the macro stories any coin's logo says what it is about; none, the globe.
  assert.deepEqual(markFace({ stories: [s({ category: 5, symbols: ['BTC'] })] }, ''), { kind: 'macro', coin: 'BTC' });
  assert.deepEqual(markFace({ stories: [s({ category: 5 })] }, ''), { kind: 'macro', coin: null });
  // A post about another coin shows that coin; about this one, X's mark.
  assert.deepEqual(markFace({ stories: [s({ post: true, symbols: ['SOL'] })] }, 'BTC'), { kind: 'post', coin: 'SOL' });
  assert.deepEqual(markFace({ stories: [s({ post: true, symbols: ['BTC'] })] }, 'BTC'), { kind: 'post', coin: null });
  assert.deepEqual(markFace({ stories: [] }, 'BTC'), { kind: 'news', coin: null });
});

test('markers closer than the gap become one, holding all their stories', () => {
  const st = (id: string, time: number) => ({ id, title: id, href: id, time });
  const placed = [
    { key: 'c', x: 140, timestamp: 3, stories: [st('c', 3)] },
    { key: 'a', x: 100, timestamp: 1, stories: [st('a', 1)] },
    { key: 'b', x: 120, timestamp: 2, stories: [st('b', 2)] },
    { key: 'd', x: 200, timestamp: 4, stories: [st('d', 4)] },
  ];
  const out = clusterNews(placed, 28);
  assert.deepEqual(out.map((p) => [p.key, p.x, p.stories.map((s) => s.id)]), [['a', 100, ['b', 'a']], ['c', 140, ['c']], ['d', 200, ['d']]]);
  // The input is left as it was.
  assert.equal(placed[1]!.stories.length, 1);
});

test('news is a switch with its own settings; older saved choices carry over', () => {
  assert.deepEqual(sanitizeShow(null), { position: true, orders: true, executions: true, news: false, newsScope: 'coin', newsKinds: [...NEWS_KINDS] });
  // 'macro' used to mean on and macro.
  assert.deepEqual([sanitizeShow({ news: 'macro' }).news, sanitizeShow({ news: 'macro' }).newsScope], [true, 'macro']);
  assert.equal(sanitizeShow({ news: 'off' }).news, false);
  const s = sanitizeShow({ news: true, newsScope: 'all', newsKinds: ['post', 'bogus', 'research'], position: false });
  assert.deepEqual([s.news, s.newsScope, s.newsKinds, s.position], [true, 'all', ['post', 'research'], false]);
  // Never no kind at all.
  assert.deepEqual(sanitizeShow({ newsKinds: [] }).newsKinds, [...NEWS_KINDS]);
});
