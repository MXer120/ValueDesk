/**
 * FOMC rate probabilities: the parsers on responses saved from Kalshi and
 * Polymarket on 25 October 2026 (test/fixtures/fedwatch), and the route's
 * cache against a fake network. Nothing here calls the network.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { easternToUtc, type CalendarEvent } from '../src/valuedesk/calendar.js';
import { decodePage, latestTargetRange, onRelease, resetReleases, startReleaseWatcher } from '../src/valuedesk/releases.js';
import {
  fedWatch,
  fedWatchHistory,
  kalshiOutcome,
  marketProb,
  matchPolymarket,
  normalise,
  parseKalshiCandles,
  parseKalshiEvents,
  parsePolymarket,
  polymarketKey,
  resetFedWatch,
  targetAfter,
  withTargets,
} from '../src/valuedesk/fedwatch.js';
import { resetIndicators } from '../src/valuedesk/indicators.js';

const json = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/fedwatch/${name}`, import.meta.url), 'utf8'));
const fixture = (name: string) => readFileSync(new URL(`./fixtures/indicators/${name}`, import.meta.url), 'utf8');
const probs = (m: { outcomes: Array<{ prob: number }> }) => m.outcomes.map((o) => o.prob);

test('a market: the midpoint of a book up to 10 c wide, else the last trade held inside the book', () => {
  // Kalshi's Mar 2027 cut: last 35 c, book 6-13 c - the book wins.
  assert.equal(marketProb(0.06, 0.13, 0.35), 0.095);
  assert.equal(marketProb(0.93, 0.94, 0.94), 0.935);
  // No bids, the ask at a cent: half a cent.
  assert.equal(marketProb(0, 0.01, 0.01), 0.005);
  // A book 30 c wide: the last trade, kept inside it.
  assert.equal(marketProb(0.1, 0.4, 0.6), 0.4);
  assert.equal(marketProb(0.1, 0.4, 0.25), 0.25);
  // No book at all: the last trade.
  assert.equal(marketProb(null, null, 0.3), 0.3);
  assert.equal(marketProb(null, null, null), null);
  // Scaled only when the sum is near 1.
  assert.deepEqual(normalise([0.5, 0.505]), [0.4975, 0.5025]);
  assert.deepEqual(normalise([0.2, 0.3]), [0.2, 0.3]);
});

test("Kalshi's strikes and Polymarket's titles name the same outcomes", () => {
  assert.deepEqual(kalshiOutcome({ Cut: '>25' }), { key: 'cut_gt25', label: 'Cut 50+ bp', bp: -50 });
  assert.deepEqual(kalshiOutcome({ Cut: '25' }), { key: 'cut25', label: 'Cut 25 bp', bp: -25 });
  assert.deepEqual(kalshiOutcome({ Hike: '0' }), { key: 'hold', label: 'Hold', bp: 0 });
  assert.deepEqual(kalshiOutcome({ Hike: '>25' }), { key: 'hike_gt25', label: 'Hike 50+ bp', bp: 50 });
  assert.equal(kalshiOutcome({ Pause: '1' }), null);
  assert.equal(polymarketKey('50+ bps decrease'), 'cut_gt25');
  assert.equal(polymarketKey('25 bps decrease'), 'cut25');
  assert.equal(polymarketKey('No change'), 'hold');
  assert.equal(polymarketKey('25 bps increase'), 'hike25');
  assert.equal(polymarketKey('50+ bps increase'), 'hike_gt25');
  assert.equal(targetAfter({ lower: 3.75, upper: 4 }, { key: 'cut25', bp: -25 }), '3.50–3.75');
  assert.equal(targetAfter({ lower: 3.75, upper: 4 }, { key: 'hike_gt25', bp: 50 }), '≥4.25–4.50');
  assert.equal(targetAfter(null, { key: 'hold', bp: 0 }), null);
});

test("Kalshi's open meetings: one per event, outcomes from the cut to the hike, summing to 1", () => {
  const ms = parseKalshiEvents(json('kalshi-events.json'), 1_792_927_795_000);
  assert.equal(ms.length, 11);
  assert.deepEqual(ms.slice(0, 6).map((m) => m.meeting), ['2026-10-28', '2026-12-09', '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09']);
  const [oct, dec, jan, mar] = ms;
  assert.equal(oct!.statementAt, Date.parse('2026-10-28T18:00:00Z'));
  assert.equal(oct!.title, 'FOMC October 2026');
  assert.equal(oct!.updatedAt, 1_792_927_795_000);
  assert.deepEqual(oct!.outcomes.map((o) => o.key), ['cut_gt25', 'cut25', 'hold', 'hike25', 'hike_gt25']);
  assert.deepEqual(oct!.outcomes.map((o) => o.bp), [-50, -25, 0, 25, 50]);
  // Oct: books 0/1, 0/1, 93/94, 5/6, 0/1 c - midpoints summing to 1.005, scaled.
  assert.deepEqual(probs(oct!), [0.005, 0.005, 0.9303, 0.0547, 0.005]);
  // Dec: a hike priced at 73/74 c.
  assert.deepEqual(probs(dec!), [0.0049, 0.0146, 0.2282, 0.7136, 0.0388]);
  assert.deepEqual(probs(jan!), [0.005, 0.015, 0.64, 0.315, 0.025]);
  // Mar 2027: the cut's last trade (35 c) is ignored for its book (6/13 c).
  assert.deepEqual(probs(mar!), [0.0148, 0.0936, 0.2709, 0.6059, 0.0148]);
  assert.deepEqual(dec!.ref.markets.map((m) => m.ticker), ['KXFEDDECISION-26DEC-C26', 'KXFEDDECISION-26DEC-C25', 'KXFEDDECISION-26DEC-H0', 'KXFEDDECISION-26DEC-H25', 'KXFEDDECISION-26DEC-H26']);
  for (const m of ms) assert.ok(Math.abs(probs(m).reduce((s, p) => s + p, 0) - 1) < 0.001, m.meeting);
});

test('the resulting ranges: from the current range, then along the most likely path', () => {
  const ms = withTargets(parseKalshiEvents(json('kalshi-events.json')).slice(0, 3), { lower: 3.75, upper: 4 });
  const t = (k: number) => Object.fromEntries(ms[k]!.outcomes.map((o) => [o.key, o.target]));
  // October: a hold is most likely, so December starts from the same range...
  assert.deepEqual(t(0), { cut_gt25: '≤3.25–3.50', cut25: '3.50–3.75', hold: '3.75–4.00', hike25: '4.00–4.25', hike_gt25: '≥4.25–4.50' });
  assert.deepEqual(t(1), t(0));
  // ...and December's likely hike moves January's up a step.
  assert.equal(t(2).hold, '4.00–4.25');
  assert.equal(t(2).hike25, '4.25–4.50');
  assert.ok(withTargets(ms, null).every((m) => m.outcomes.every((o) => o.target === null)));
});

test("Polymarket's Fed Decision events, kept on the Kalshi meeting of the same day", () => {
  const pm = parsePolymarket(json('polymarket-search.json'));
  assert.deepEqual(pm.map((p) => [p.month, p.day]), [[10, '2026-10-28'], [12, '2026-12-09'], [1, '2027-01-27']]);
  assert.deepEqual(pm[0]!.probs, { cut_gt25: 0.0005, cut25: 0.0015, hold: 0.9507, hike25: 0.0448, hike_gt25: 0.0025 });
  assert.deepEqual(pm[1]!.probs, { cut_gt25: 0.0045, cut25: 0.0065, hold: 0.2039, hike25: 0.7608, hike_gt25: 0.0244 });
  const matched = matchPolymarket(parseKalshiEvents(json('kalshi-events.json')).slice(0, 4), pm);
  assert.deepEqual(matched.map((m) => !!m.polymarket), [true, true, true, false]);
  assert.equal(matched[2]!.polymarket!.hold, 0.6817);
  // Not the same day: not the same meeting.
  assert.equal(matchPolymarket([{ meeting: '2026-10-29' }], pm)[0]!.polymarket, undefined);
});

test("Kalshi's candlesticks: one series per outcome, the gaps carried, normalised at each close", () => {
  const ref = parseKalshiEvents(json('kalshi-events.json'))[1]!.ref;
  const hourly = parseKalshiCandles(json('kalshi-26dec-60.json'), ref);
  assert.deepEqual(hourly.map((s) => [s.key, s.points.length]), [['cut_gt25', 168], ['cut25', 168], ['hold', 168], ['hike25', 168], ['hike_gt25', 168]]);
  assert.deepEqual(hourly.find((s) => s.key === 'hold')!.points[0], [1_792_324_800_000, 0.2108]);
  assert.deepEqual(hourly.map((s) => s.points.at(-1)), [[1_792_926_000_000, 0.0049], [1_792_926_000_000, 0.0146], [1_792_926_000_000, 0.2282], [1_792_926_000_000, 0.7136], [1_792_926_000_000, 0.0388]]);
  const daily = parseKalshiCandles(json('kalshi-26dec-1440.json'), ref);
  assert.deepEqual(daily.map((s) => s.points.length), [90, 90, 90, 90, 90]);
  // Three months back a hold led (58 %); now the hike does (71 %).
  assert.deepEqual(daily.map((s) => s.points[0]![1]), [0.0148, 0.1034, 0.5764, 0.2808, 0.0246]);
  assert.deepEqual(daily.map((s) => s.points.at(-1)![1]), [0.0048, 0.0145, 0.2271, 0.7101, 0.0435]);
});

test("the route: Kalshi read once a minute, the range from the Board's open market page (no statement read), a history only for a listed meeting", async () => {
  resetFedWatch();
  resetIndicators();
  const asked: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    const u = String(url);
    asked.push(new URL(u).hostname + new URL(u).pathname);
    if (u.includes('/events?')) return new Response(JSON.stringify(json('kalshi-events.json')));
    if (u.includes('public-search')) return new Response(JSON.stringify(json('polymarket-search.json')));
    if (u.includes('/markets/candlesticks')) {
      assert.match(u, /market_tickers=KXFEDDECISION-26DEC-C26,KXFEDDECISION-26DEC-C25,KXFEDDECISION-26DEC-H0,KXFEDDECISION-26DEC-H25,KXFEDDECISION-26DEC-H26&/);
      assert.match(u, /period_interval=60$/);
      return new Response(JSON.stringify(json('kalshi-26dec-60.json')));
    }
    if (u.endsWith('/monetarypolicy/openmarket.htm')) return new Response(fixture('fed-openmarket.htm'));
    return new Response('', { status: 404 });
  };
  // The meetings are filtered to those still ahead: run the clock as of the save.
  const realNow = Date.now;
  Date.now = () => 1_792_927_795_000;
  try {
    const page = await fedWatch(fetchImpl);
    assert.deepEqual(page.current, { lower: 3.75, upper: 4 });
    assert.equal(page.meetings.length, 6);
    assert.equal(page.meetings[0]!.outcomes[2]!.target, '3.75–4.00');
    assert.equal(page.meetings[1]!.polymarket!.hike25, 0.7608);
    assert.equal('ref' in page.meetings[0]!, false);
    await fedWatch(fetchImpl);
    assert.equal(asked.filter((a) => a.endsWith('/events')).length, 1, 'cached a minute');
    const series = await fedWatchHistory('2026-12-09', '7d', fetchImpl);
    assert.equal(series!.length, 5);
    await fedWatchHistory('2026-12-09', '7d', fetchImpl);
    assert.equal(asked.filter((a) => a.endsWith('/candlesticks')).length, 1, 'cached ten minutes');
    assert.equal(await fedWatchHistory('2026-12-10', '7d', fetchImpl), null);
  } finally {
    Date.now = realNow;
    resetFedWatch();
    resetIndicators();
  }
});

test("the current range from the newest FOMC statement the watcher read, and its release told to listeners", async () => {
  resetReleases();
  const dir = mkdtempSync(join(tmpdir(), 'fedwatch-'));
  const heard: string[] = [];
  const stop = onRelease((kind) => heard.push(kind));
  const statement = decodePage(readFileSync(new URL('./fixtures/releases/fomc-20260916.html', import.meta.url)));
  const sep: CalendarEvent = { id: 'fed:fomc:2026-09-16', time: easternToUtc(2026, 9, 16, 14, 0), allDay: false, short: 'FOMC', title: 'FOMC', detail: null, importance: 'high', country: 'US', source: 'fed', href: 'https://www.federalreserve.gov/' };
  const fetchImpl = (async (url: string) => (url.includes('monetary20260916a.htm') ? new Response(statement) : new Response('not found', { status: 404 }))) as unknown as typeof fetch;
  const w = startReleaseWatcher({ fetchImpl, calendarImpl: async () => ({ events: [sep] }), dir, now: () => Date.parse('2026-10-25T12:00:00Z'), tickMs: 3_600_000 });
  try {
    assert.equal(latestTargetRange(), null);
    await w.tick();
    // September's hike to 3.75-4.00, read at start-up as a release this server missed.
    assert.deepEqual(latestTargetRange(), { lower: 3.75, upper: 4 });
    assert.deepEqual(heard, ['FOMC']);
  } finally {
    stop();
    w.stop();
    resetReleases();
    rmSync(dir, { recursive: true, force: true });
  }
});
