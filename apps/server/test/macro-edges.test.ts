/**
 * Edge cases of the macro parsers: New York time around the clock changes, the
 * ICS and FOMC calendar pages, merging, the route windows, Kalshi/Polymarket
 * outcomes, FRED transforms with a missing period, and the release-page text.
 *   npx tsx --test test/macro-edges.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  easternToUtc, mergeCalendar, parseCalendarQuery, parseFomc, parseIcs, parseSosoEvents, pickReleases, sosoIndicators, type CalendarEvent,
} from '../src/valuescan/calendar.js';
import {
  kalshiOutcome, marketProb, matchPolymarket, normalise, parseFedHistoryRange, parseKalshiEvents, parsePolymarket, polymarketKey, targetAfter, withTargets,
} from '../src/valuescan/fedwatch.js';
import { INDICATORS, indicatorView, parseFredCsv, parseIndicatorRange, periodLabel, transform } from '../src/valuescan/indicators.js';
import {
  decodePage, easternDay, firstSentence, htmlText, parseBrightcoveVideo, parseFedLivePage, parseMasterPlaylist, resultUrl,
} from '../src/valuescan/releases.js';

const iso = (t: number) => new Date(t).toISOString();

// --- New York time ------------------------------------------------------------------------

test('easternToUtc: either side of the March and November clock changes', () => {
  // 8 March 2026 is the second Sunday of March: 2:00 EST jumps to 3:00 EDT.
  assert.equal(iso(easternToUtc(2026, 3, 7, 23, 59)), '2026-03-08T04:59:00.000Z');
  assert.equal(iso(easternToUtc(2026, 3, 8, 1, 30)), '2026-03-08T06:30:00.000Z');
  assert.equal(iso(easternToUtc(2026, 3, 8, 3, 0)), '2026-03-08T07:00:00.000Z');
  assert.equal(iso(easternToUtc(2026, 3, 9, 8, 30)), '2026-03-09T12:30:00.000Z');
  // 2:30 does not exist that night: whatever it is read as lands within the hour around the change.
  const gap = easternToUtc(2026, 3, 8, 2, 30);
  assert.ok(gap >= Date.parse('2026-03-08T06:30:00Z') && gap <= Date.parse('2026-03-08T07:30:00Z'), iso(gap));
  // 1 November 2026 is the first Sunday of November: 2:00 EDT falls back to 1:00 EST.
  assert.equal(iso(easternToUtc(2026, 10, 31, 23, 0)), '2026-11-01T03:00:00.000Z');
  assert.equal(iso(easternToUtc(2026, 11, 1, 0, 30)), '2026-11-01T04:30:00.000Z');
  // 1:30 happens twice: one of the two, never something else.
  assert.ok(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'].includes(iso(easternToUtc(2026, 11, 1, 1, 30))));
  assert.equal(iso(easternToUtc(2026, 11, 1, 3, 0)), '2026-11-01T08:00:00.000Z');
  // A release at 8:30 the Friday after the change, and the FOMC at 2 pm in winter and summer.
  assert.equal(iso(easternToUtc(2026, 11, 6, 8, 30)), '2026-11-06T13:30:00.000Z');
  assert.equal(iso(easternToUtc(2027, 1, 27, 14, 0)), '2027-01-27T19:00:00.000Z');
  assert.equal(iso(easternToUtc(2027, 7, 28, 14, 0)), '2027-07-28T18:00:00.000Z');
  // New Year's Eve at midnight: the next UTC day, and a leap day.
  assert.equal(iso(easternToUtc(2026, 12, 31, 23, 30)), '2027-01-01T04:30:00.000Z');
  assert.equal(iso(easternToUtc(2028, 2, 29, 8, 30)), '2028-02-29T13:30:00.000Z');
});

test('easternDay: the New York date either side of its midnight, summer and winter', () => {
  assert.equal(easternDay(Date.parse('2026-10-28T03:59:59Z')), '2026-10-27');
  assert.equal(easternDay(Date.parse('2026-10-28T04:00:00Z')), '2026-10-28');
  assert.equal(easternDay(Date.parse('2026-12-10T04:59:59Z')), '2026-12-09');
  assert.equal(easternDay(Date.parse('2026-12-10T05:00:00Z')), '2026-12-10');
  // The FOMC's statement in UTC is still its Eastern day.
  assert.equal(easternDay(easternToUtc(2026, 12, 9, 14, 0)), '2026-12-09');
  assert.equal(easternDay(Date.parse('2027-01-01T04:30:00Z')), '2026-12-31');
});

// --- the calendars ----------------------------------------------------------------------------

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'SUMMARY:Consumer Price Index for September 2026\\, with a long',
  '  folded tail',
  'DTSTART;TZID=America/New_York:20261014T083000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY;LANGUAGE=en-us:Employment Situation for September',
  'DTSTART:20261002T123000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:GDP (Advance Estimate)\\, 3rd Quarter 2026',
  'DTSTART;VALUE=DATE:20261029',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:No start',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20261001T000000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Floating time',
  'DTSTART:20261015T0830',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Bad date',
  'DTSTART:2026-10-15',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('parseIcs: folded lines, escaped commas, New York / UTC / floating / all-day starts; incomplete events dropped', () => {
  const ev = parseIcs(ICS);
  assert.deepEqual(ev.map((e) => e.summary), [
    'Consumer Price Index for September 2026, with a long folded tail',
    'Employment Situation for September',
    'GDP (Advance Estimate), 3rd Quarter 2026',
    'Floating time',
  ]);
  assert.equal(iso(ev[0]!.time), '2026-10-14T12:30:00.000Z');
  assert.equal(ev[0]!.allDay, false);
  assert.equal(iso(ev[1]!.time), '2026-10-02T12:30:00.000Z');
  // A date: midday UTC of that date, so it reads as the same date anywhere.
  assert.deepEqual([iso(ev[2]!.time), ev[2]!.allDay], ['2026-10-29T12:00:00.000Z', true]);
  // No zone and no Z: read as UTC.
  assert.equal(iso(ev[3]!.time), '2026-10-15T08:30:00.000Z');
  // A summary's \n is a space; an event outside BEGIN/END is not read.
  const more = parseIcs('SUMMARY:stray\nBEGIN:VEVENT\nSUMMARY:Producer Price Index\\nfor September\nDTSTART;TZID="US-Eastern":20261015T083000\nEND:VEVENT');
  assert.deepEqual(more.map((e) => [e.summary, iso(e.time)]), [['Producer Price Index for September', '2026-10-15T12:30:00.000Z']]);
  assert.deepEqual(parseIcs(''), []);
});

test('pickReleases: the month a BLS release covers across a year end; BEA names its quarter and estimate; the rest left out', () => {
  const at = (y: number, mo: number, d: number) => ({ time: easternToUtc(y, mo, d, 8, 30), allDay: false });
  const bls = pickReleases([
    { summary: 'Consumer Price Index for December 2026', ...at(2027, 1, 13) },
    { summary: 'Job Openings and Labor Turnover Survey for November 2026', ...at(2027, 1, 5) },
    { summary: 'Employment Cost Index for Fourth Quarter 2026', ...at(2027, 1, 29) },
    { summary: 'Real Earnings for December 2026', ...at(2027, 1, 13) },
    { summary: 'County Employment and Wages', ...at(2027, 1, 13) },
  ], 'bls');
  assert.deepEqual(bls.map((e) => [e.id, e.short, e.title, e.importance]), [
    ['bls:cpi:2027-01-13', 'CPI', 'CPI inflation, December 2026', 'high'],
    ['bls:jolts:2027-01-05', 'JOLTS', 'JOLTS job openings, November 2026', 'medium'],
    ['bls:eci:2027-01-29', 'ECI', 'Employment cost index', 'medium'],
  ]);
  assert.equal(bls[0]!.detail, 'Consumer Price Index for December 2026');
  assert.ok(bls[0]!.fields?.length, 'a release with a card carries its fields');
  const bea = pickReleases([
    { summary: 'GDP (Third Estimate), GDP by Industry, and Corporate Profits (Revised), 2nd Quarter 2026', time: Date.UTC(2026, 8, 25, 12), allDay: true },
    { summary: 'Gross Domestic Product, 4th Quarter and Year 2026 (Advance Estimate)', time: Date.UTC(2027, 0, 28, 12), allDay: true },
    { summary: 'Personal Income and Outlays, September 2026', time: Date.UTC(2026, 9, 30, 12), allDay: true },
    { summary: 'GDP by County and Metropolitan Area, 2025', time: Date.UTC(2026, 11, 3, 12), allDay: true },
    { summary: 'Gross Domestic Product by State and Personal Income by State, 2nd Quarter 2026', time: Date.UTC(2026, 8, 26, 12), allDay: true },
  ], 'bea');
  assert.deepEqual(bea.map((e) => [e.id, e.title, e.allDay]), [
    ['bea:gdp:2026-09-25', 'GDP Q2 2026 (third)', true],
    ['bea:gdp:2027-01-28', 'GDP Q4 2026 (advance)', true],
    ['bea:pce:2026-10-30', 'PCE inflation, September 2026', true],
  ]);
  assert.deepEqual(pickReleases([], 'bls'), []);
});

test('parseFomc: every year panel, meetings across months, starred projections, a row without days skipped', () => {
  const row = (month: string, days: string) =>
    `<div class="fomc-meeting__month col-xs-5"><strong>${month}</strong></div><div class="fomc-meeting__date col-xs-4">${days}</div>`;
  const html = `<h4>2026 FOMC Meetings</h4>${row('January', '27-28')}${row('Apr/May', '30-1*')}${row('December', '8-9*')}`
    + `<h4>2027 FOMC Meetings</h4>${row('Jan', '26-27')}${row('Mar', '(notation vote)')}${row('Oct/Nov', '31-1')}${row('Smarch', '3-4')}`;
  const ev = parseFomc(html);
  assert.deepEqual(ev.map((e) => [e.id, iso(e.time), e.title]), [
    ['fed:fomc:2026-01-28', '2026-01-28T19:00:00.000Z', 'FOMC rate decision'],
    ['fed:fomc:2026-05-01', '2026-05-01T18:00:00.000Z', 'FOMC rate decision and projections'],
    ['fed:fomc:2026-12-09', '2026-12-09T19:00:00.000Z', 'FOMC rate decision and projections'],
    ['fed:fomc:2027-01-27', '2027-01-27T19:00:00.000Z', 'FOMC rate decision'],
    ['fed:fomc:2027-11-01', '2027-11-01T18:00:00.000Z', 'FOMC rate decision'],
  ]);
  assert.ok(ev.every((e) => e.short === 'FOMC' && e.importance === 'high' && e.source === 'fed' && !e.allDay));
  assert.match(ev[1]!.detail!, /Summary of Economic Projections/);
  assert.deepEqual(parseFomc('<html>maintenance</html>'), []);
});

const ev = (id: string, short: string, time: number, source: CalendarEvent['source'] = 'bls'): CalendarEvent => ({
  id, short, time, source, allDay: false, title: short, detail: null, importance: 'high', country: 'US', href: 'https://x',
});

test('mergeCalendar: SoSoValue only where no official release of its kind is within a day and a half; one copy per id; by time then kind', () => {
  const D = 86_400_000;
  const t = Date.parse('2026-10-14T12:30:00Z');
  const merged = mergeCalendar(
    [ev('bls:cpi:2026-10-14', 'CPI', t), ev('bls:ppi:2026-10-14', 'PPI', t), ev('bls:cpi:2026-10-14', 'CPI', t)],
    [
      ev('sosovalue:cpi-yoy:2026-10-14', 'CPI', t - 30 * 60_000, 'sosovalue'),
      ev('sosovalue:cpi:2026-10-15', 'CPI', t + 1.5 * D, 'sosovalue'),
      ev('sosovalue:cpi:2026-11-12', 'CPI', t + 29 * D, 'sosovalue'),
      ev('sosovalue:pmi:2026-10-14', 'PMI', t - 3_600_000, 'sosovalue'),
    ],
  );
  assert.deepEqual(merged.map((e) => e.id), ['sosovalue:pmi:2026-10-14', 'bls:cpi:2026-10-14', 'bls:ppi:2026-10-14', 'sosovalue:cpi:2026-11-12']);
  assert.deepEqual(mergeCalendar([], []), []);
});

test('parseSosoEvents: a bare array or {data}, names tidied, unknown kinds low, bad rows skipped, the indicators it names', () => {
  const out = parseSosoEvents([
    { date: '2026-10-28', events: ['  Core PCE  Price Index YoY ', '', 7, 'Pending Home Sales'] },
    { date: '28/10/2026', events: ['CPI'] },
    { date: '2026-10-29', events: 'GDP' },
    null,
  ]);
  assert.deepEqual(out.map((e) => [e.id, e.short, e.title, e.importance, e.indicators]), [
    ['sosovalue:core-pce-price-index-yoy:2026-10-28', 'PCE', 'Core PCE Price Index YoY', 'high', ['core_pce_yy']],
    ['sosovalue:pending-home-sales:2026-10-28', 'Housing', 'Pending Home Sales', 'low', undefined],
  ]);
  assert.equal(iso(out[0]!.time), '2026-10-28T12:00:00.000Z');
  assert.equal(parseSosoEvents({ data: [{ date: '2026-11-03', events: ['ISM Manufacturing PMI'] }] })[0]!.short, 'ISM');
  assert.deepEqual(parseSosoEvents('nope'), []);
  // The most specific name wins; a survey with no free history has no chart.
  assert.deepEqual(sosoIndicators('Continuing Jobless Claims'), ['continuing_claims']);
  assert.deepEqual(sosoIndicators('Retail Sales Ex Autos MoM'), ['retail_ex_auto_mm']);
  assert.deepEqual(sosoIndicators('S&P Global Services PMI'), []);
});

test('parseCalendarQuery: defaults, millisecond strings and numbers, a window turned round, the 400-day cap', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  const D = 86_400_000;
  assert.deepEqual(parseCalendarQuery({}, now), { from: now - 7 * D, to: now + 60 * D });
  assert.deepEqual(parseCalendarQuery({ from: 'abc', to: '12' }, now), { from: now - 7 * D, to: now + 60 * D });
  assert.deepEqual(parseCalendarQuery({ from: String(now), to: String(now + D) }, now), { from: now, to: now + D });
  assert.deepEqual(parseCalendarQuery({ from: now, to: now - D }, now), { from: now, to: now });
  assert.deepEqual(parseCalendarQuery({ from: now, to: now + 900 * D }, now), { from: now, to: now + 400 * D });
  assert.deepEqual(parseCalendarQuery({ from: Number.NaN, to: Infinity }, now), { from: now - 7 * D, to: now + 60 * D });
});

// --- the rate odds ----------------------------------------------------------------------------

test('marketProb: a tight book is its midpoint, a wide one its last trade held inside it, nothing priced is null', () => {
  assert.ok(Math.abs(marketProb(0.4, 0.44, null)! - 0.42) < 1e-12);
  // Exactly 10 c wide is still a tight book (0.40 - 0.30 is 0.10000000000000003 in floating point).
  assert.ok(Math.abs(marketProb(0.3, 0.4, 0.31)! - 0.35) < 1e-12);
  assert.ok(Math.abs(marketProb(0.4, 0.5, 0.41)! - 0.45) < 1e-12);
  assert.equal(marketProb(0.1, 0.5, 0.3), 0.3);
  assert.equal(marketProb(0.1, 0.5, 0.9), 0.5);
  assert.equal(marketProb(0.1, 0.5, 0.05), 0.1);
  assert.equal(marketProb(0.1, 0.5, null), 0.3);
  assert.equal(marketProb(null, null, 0.2), 0.2);
  assert.equal(marketProb(null, 0.3, 0.2), 0.2);
  assert.equal(marketProb(null, null, 0), null);
  assert.equal(marketProb(0, 0, null), null);
  // A crossed book is no book.
  assert.equal(marketProb(0.5, 0.4, null), null);
  assert.equal(marketProb(0.5, 0.4, 0.45), 0.45);
});

test('normalise: scaled only when the sum is near 1; four decimals; zeros and empties as they are', () => {
  assert.deepEqual(normalise([0.5, 0.45]), [0.5263, 0.4737]);
  assert.deepEqual(normalise([0.55, 0.55]), [0.5, 0.5]);
  assert.deepEqual(normalise([0.6, 0.6]), [0.6, 0.6]);
  assert.deepEqual(normalise([0.5, 0.2]), [0.5, 0.2]);
  assert.deepEqual(normalise([0.123456]), [0.1235]);
  assert.deepEqual(normalise([0, 0]), [0, 0]);
  assert.deepEqual(normalise([]), []);
});

test('Kalshi strikes and Polymarket titles: one key for one outcome, odd strikes refused', () => {
  assert.deepEqual(kalshiOutcome({ Cut: '25' }), { key: 'cut25', label: 'Cut 25 bp', bp: -25 });
  assert.deepEqual(kalshiOutcome({ Cut: ' > 25 ' }), { key: 'cut_gt25', label: 'Cut 50+ bp', bp: -50 });
  assert.deepEqual(kalshiOutcome({ Hike: '>25' }), { key: 'hike_gt25', label: 'Hike 50+ bp', bp: 50 });
  assert.deepEqual(kalshiOutcome({ Hike: '0' }), { key: 'hold', label: 'Hold', bp: 0 });
  assert.deepEqual(kalshiOutcome({ Cut: '0' }), { key: 'hold', label: 'Hold', bp: 0 });
  for (const bad of [null, 'Cut 25', {}, { Hold: '0' }, { Cut: 25 }, { Cut: '25bp' }, { Cut: '-25' }]) assert.equal(kalshiOutcome(bad), null, JSON.stringify(bad));
  assert.equal(polymarketKey(' No change '), 'hold');
  assert.equal(polymarketKey('25 bps decrease'), 'cut25');
  assert.equal(polymarketKey('25 bp decrease'), 'cut25');
  assert.equal(polymarketKey('50+ bps decrease'), 'cut_gt25');
  assert.equal(polymarketKey('50+ bps increase'), 'hike_gt25');
  assert.equal(polymarketKey('25 BPS INCREASE'), 'hike25');
  assert.equal(polymarketKey('Emergency cut'), null);
  // The two markets' names of the same outcome meet.
  assert.equal(kalshiOutcome({ Cut: '>25' })!.key, polymarketKey('50+ bps decrease'));
});

test('targetAfter and withTargets: the range an outcome leaves, ≤/≥ for the open-ended ones, never below zero', () => {
  const from = { lower: 3.75, upper: 4 };
  assert.equal(targetAfter(from, { key: 'cut25', bp: -25 }), '3.50–3.75');
  assert.equal(targetAfter(from, { key: 'hold', bp: 0 }), '3.75–4.00');
  assert.equal(targetAfter(from, { key: 'cut_gt25', bp: -50 }), '≤3.25–3.50');
  assert.equal(targetAfter(from, { key: 'hike_gt25', bp: 50 }), '≥4.25–4.50');
  assert.equal(targetAfter({ lower: 0, upper: 0.25 }, { key: 'cut25', bp: -25 }), null);
  assert.equal(targetAfter({ lower: 0.25, upper: 0.5 }, { key: 'cut25', bp: -25 }), '0.00–0.25');
  assert.equal(targetAfter(null, { key: 'hold', bp: 0 }), null);
  const o = (key: string, bp: number, prob: number) => ({ key, label: key, bp, prob, target: null });
  const out = withTargets([{ outcomes: [o('cut25', -25, 0.7), o('hold', 0, 0.3)] }, { outcomes: [o('cut25', -25, 0.4), o('hold', 0, 0.6)] }], from);
  assert.deepEqual(out.map((m) => m.outcomes.map((x) => x.target)), [['3.50–3.75', '3.75–4.00'], ['3.25–3.50', '3.50–3.75']]);
  assert.deepEqual(withTargets([{ outcomes: [o('hold', 0, 1)] }], null)[0]!.outcomes[0]!.target, null);
});

test('parseKalshiEvents: inactive, unpriced and repeated outcomes left out; a meeting needs two; nearest first', () => {
  const m = (ticker: string, strike: unknown, bid: string | null, ask: string | null, extra: Record<string, unknown> = {}) =>
    ({ ticker, custom_strike: strike, yes_bid_dollars: bid, yes_ask_dollars: ask, last_price_dollars: null, status: 'active', ...extra });
  const body = {
    events: [
      { event_ticker: 'KXFEDDECISION-27JAN', strike_date: '2027-01-27T19:00:00Z', markets: [m('J-H0', { Hike: '0' }, '0.80', '0.84'), m('J-C25', { Cut: '25' }, '0.14', '0.18')] },
      {
        event_ticker: 'KXFEDDECISION-26DEC', strike_date: '2026-12-09T19:00:00Z', markets: [
          m('D-C25', { Cut: '25' }, '0.30', '0.34'),
          m('D-H0', { Hike: '0' }, '0.62', '0.66'),
          m('D-H0b', { Cut: '0' }, '0.10', '0.12'),
          m('D-C50', { Cut: '>25' }, null, null),
          m('D-H25', { Hike: '25' }, '0.01', '0.03', { status: 'closed' }),
          m('D-X', { Pause: '0' }, '0.5', '0.5'),
        ],
      },
      { event_ticker: 'KXFEDDECISION-27MAR', strike_date: '2027-03-17T18:00:00Z', markets: [m('M-H0', { Hike: '0' }, '0.5', '0.52')] },
      { event_ticker: 'bad', strike_date: 'soon', markets: [] },
    ],
  };
  const out = parseKalshiEvents(body, 123);
  assert.deepEqual(out.map((x) => [x.meeting, x.title]), [['2026-12-09', 'FOMC December 2026'], ['2027-01-27', 'FOMC January 2027']]);
  assert.deepEqual(out[0]!.outcomes.map((x) => [x.key, x.prob]), [['cut25', 0.3333], ['hold', 0.6667]]);
  assert.deepEqual(out[0]!.ref.markets.map((x) => x.ticker), ['D-C25', 'D-H0']);
  assert.equal(out[0]!.updatedAt, 123);
  assert.deepEqual(parseKalshiEvents({}), []);
  assert.deepEqual(parseKalshiEvents(null), []);
});

test('parsePolymarket and matchPolymarket: open events only, prices as JSON text, kept on the meeting that ends the same day', () => {
  const pm = parsePolymarket({
    events: [
      {
        title: 'Fed Decision in December?', closed: false, markets: [
          { groupItemTitle: '25 bps decrease', outcomePrices: '["0.33","0.67"]', endDate: '2026-12-09T12:00:00Z' },
          { groupItemTitle: 'No change', outcomePrices: ['0.6', '0.4'], endDate: '2026-12-09T12:00:00Z' },
          { groupItemTitle: 'No change', outcomePrices: ['0.9', '0.1'] },
          { groupItemTitle: '50+ bps decrease', outcomePrices: 'not json' },
          { groupItemTitle: '25 bps increase', outcomePrices: ['0.02', '0.98'], closed: true },
        ],
      },
      { title: 'Fed Decision in January?', closed: true, markets: [] },
      { title: 'Fed Decision in Smarch?', markets: [] },
      { title: 'Who will be Fed chair?', markets: [] },
    ],
  });
  assert.deepEqual(pm, [{ month: 12, day: '2026-12-09', probs: { cut25: 0.3548, hold: 0.6452 } }]);
  const meetings = matchPolymarket([{ meeting: '2026-12-09' }, { meeting: '2027-01-27' }], pm);
  assert.deepEqual(meetings, [{ meeting: '2026-12-09', polymarket: { cut25: 0.3548, hold: 0.6452 } }, { meeting: '2027-01-27' }]);
  assert.deepEqual(parsePolymarket('x'), []);
  assert.equal(parseFedHistoryRange('90d'), '90d');
  assert.equal(parseFedHistoryRange('1y'), '30d');
  assert.equal(parseFedHistoryRange(undefined), '30d');
});

// --- FRED ----------------------------------------------------------------------------------

test('parseFredCsv: either header, CRLF, missing values and junk rows left out', () => {
  assert.deepEqual(parseFredCsv('DATE,UNRATE\r\n2025-09-01,4.4\r\n2025-10-01,.\r\n2025-11-01,\r\n2025-12-01,4.4\r\nnot,a row\r\n2026-01-01,abc\r\n'), [
    ['2025-09-01', 4.4],
    ['2025-12-01', 4.4],
  ]);
  assert.deepEqual(parseFredCsv('observation_date,X\n'), []);
  assert.throws(() => parseFredCsv(''), /not a FRED series/);
});

test('transform: a change is only between neighbouring periods - a period never published (October 2025) is not bridged', () => {
  // FRED's CPIAUCSL as read: no October 2025 (the shutdown), so there is no November m/m either.
  const cpi: Array<[string, number]> = [['2025-08-01', 323.291], ['2025-09-01', 324.245], ['2025-11-01', 325.063], ['2025-12-01', 326.031]];
  assert.deepEqual(transform(cpi, { transform: 'mm', decimals: 1 }), [['2025-09-01', 0.3], ['2025-12-01', 0.3]]);
  // A quarter missing in a quarterly series: no change across it.
  const eci: Array<[string, number]> = [['2026-01-01', 100], ['2026-04-01', 101], ['2026-10-01', 103.02]];
  assert.deepEqual(transform(eci, { transform: 'qq', decimals: 1 }), [['2026-04-01', 1]]);
  // Payrolls: the change on the month before, not on the last month published.
  const nfp: Array<[string, number]> = [['2025-08-01', 158500], ['2025-09-01', 158548], ['2025-11-01', 158449], ['2025-12-01', 158432]];
  assert.deepEqual(transform(nfp, { transform: 'diff', decimals: 0 }), [['2025-09-01', 48], ['2025-12-01', -17]]);
  // Weekly claims: neighbouring weeks count, a skipped week does not.
  const claims: Array<[string, number]> = [['2026-10-03', 200], ['2026-10-10', 210], ['2026-10-24', 190]];
  assert.deepEqual(transform(claims, { transform: 'diff', decimals: 0 }), [['2026-10-10', 10]]);
  // Months of 28 to 31 days are all neighbours, a year end too.
  const m: Array<[string, number]> = [['2026-01-01', 100], ['2026-02-01', 101], ['2026-03-01', 102.01], ['2026-12-01', 110], ['2027-01-01', 111.1]];
  assert.deepEqual(transform(m, { transform: 'mm', decimals: 1 }), [['2026-02-01', 1], ['2026-03-01', 1], ['2027-01-01', 1]]);
});

test('transform: y/y needs the same period a year before; rounding half away from zero, minus zero is zero', () => {
  const obs: Array<[string, number]> = [['2024-11-01', 100], ['2025-11-01', 102.95], ['2025-12-01', 103], ['2024-12-01', 0]];
  // December 2024 is zero: no rate from it.
  assert.deepEqual(transform(obs, { transform: 'yy', decimals: 1 }), [['2025-11-01', 3]]);
  assert.deepEqual(transform([['2026-01-01', -0.04]], { transform: 'level', decimals: 1 }), [['2026-01-01', 0]]);
  assert.ok(!Object.is(transform([['2026-01-01', -0.04]], { transform: 'level', decimals: 1 })[0]![1], -0));
  assert.deepEqual(transform([['2026-01-01', -0.05], ['2026-01-02', 0.05]], { transform: 'level', decimals: 1 }), [['2026-01-01', -0.1], ['2026-01-02', 0.1]]);
  assert.deepEqual(transform([['2026-01-01', 4.25]], { transform: 'steps', decimals: 2 }), [['2026-01-01', 4.25]]);
  assert.deepEqual(transform([], { transform: 'mm', decimals: 1 }), []);
});

test('periodLabel: every month and quarter named as the agencies do', () => {
  assert.equal(periodLabel('2026-01-01', 'monthly'), 'January 2026');
  assert.equal(periodLabel('2026-12-01', 'monthly'), 'December 2026');
  assert.deepEqual(['01', '03', '04', '07', '09', '10', '12'].map((m) => periodLabel(`2026-${m}-01`, 'quarterly')), ['Q1 2026', 'Q1 2026', 'Q2 2026', 'Q3 2026', 'Q3 2026', 'Q4 2026', 'Q4 2026']);
});

test('indicatorView: ranges count back from the newest observation; an empty series is empty; a step range opening on a change is not doubled', () => {
  const obs: Array<[string, number]> = [];
  for (let y = 2014; y <= 2026; y++) for (let mo = 1; mo <= 12; mo++) if (y < 2026 || mo <= 9) obs.push([`${y}-${String(mo).padStart(2, '0')}-01`, 3 + mo / 10]);
  const i = INDICATORS.unemployment!;
  const n = (r: Parameters<typeof indicatorView>[2]) => indicatorView(obs, i, r).points.length;
  assert.deepEqual([n('1y'), n('5y'), n('10y'), n('max')], [13, 61, 121, obs.length]);
  const v = indicatorView(obs, i, '1y');
  assert.deepEqual(v.latest, { period: 'September 2026', value: 3.9, prior: 3.8 });
  assert.equal(v.table.length, 24);
  assert.equal(v.table.at(-1)!.period, 'October 2024');
  assert.deepEqual(indicatorView([], i, '5y'), { points: [], table: [], latest: null });
  assert.deepEqual(indicatorView([['2026-09-01', 4.2]], i, '1y').latest, { period: 'September 2026', value: 4.2, prior: null });
  const fed = INDICATORS.fed_upper!;
  const steps: Array<[string, number]> = [['2025-09-01', 4.5], ['2025-10-24', 4.25], ['2026-10-24', 4]];
  assert.deepEqual(indicatorView(steps, fed, '1y').points, [[Date.parse('2025-10-24T00:00:00Z'), 4.25], [Date.parse('2026-10-24T00:00:00Z'), 4]]);
  assert.equal(parseIndicatorRange('10y'), '10y');
  assert.equal(parseIndicatorRange('2y'), '5y');
});

// --- release pages -------------------------------------------------------------------------

test('htmlText: comments, scripts and styles gone, blocks on their own lines, entities decoded, odd hyphens plain', () => {
  const t = htmlText('<p>CPI rose 0.3&nbsp;percent<!-- hidden --></p><script>var x="<p>no</p>"</script><style>p{}</style>'
    + '<div>Fed&#8217;s &#x2014; &ldquo;steady&rdquo; &amp; Co&#0; &bogus;</div>Line<br/>two‑part');
  assert.equal(t, 'CPI rose 0.3 percent\nFed’s — “steady” & Co&#0; &bogus;\nLine\ntwo-part');
});

test('firstSentence: not at initials, abbreviations, decimals or times; the whole text when it has no full stop', () => {
  assert.equal(firstSentence('The Committee, chaired by Jerome H. Powell, held rates. It will watch.'), 'The Committee, chaired by Jerome H. Powell, held rates.');
  assert.equal(firstSentence('U.S. real GDP rose 2.5 percent in the third quarter. Prices rose.'), 'U.S. real GDP rose 2.5 percent in the third quarter.');
  assert.equal(firstSentence('At 8:30 a.m. Eastern Time the BLS said so. More follows.'), 'At 8:30 a.m. Eastern Time the BLS said so.');
  assert.equal(firstSentence('The St. Louis Fed vs. the rest. Next'), 'The St. Louis Fed vs. the rest.');
  assert.equal(firstSentence('Released Oct. 14. Then more.'), 'Released Oct. 14.');
  assert.equal(firstSentence('The index rose. "Core" did too.'), 'The index rose.');
  assert.equal(firstSentence('  no stop at all  '), 'no stop at all');
  assert.equal(firstSentence('Ends here.'), 'Ends here.');
  assert.equal(firstSentence('   '), null);
});

test('decodePage: UTF-8 when it is, Windows-1252 otherwise', () => {
  assert.equal(decodePage(new TextEncoder().encode('3.75–4.00 percent')), '3.75–4.00 percent');
  assert.equal(decodePage(new Uint8Array([0x33, 0x96, 0x34, 0x20, 0x93, 0x78, 0x94])), '3–4 “x”');
});

test('resultUrl: the statement on its Eastern day even late in the UTC day; the summaries; nothing for a kind without one', () => {
  const late = Date.parse('2026-12-10T03:00:00Z'); // 22:00 on the 9th in New York
  assert.equal(resultUrl({ id: 'fed:fomc:2026-12-09', short: 'FOMC', time: late }), 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261209a.htm');
  assert.equal(resultUrl({ id: 'bls:eci:x', short: 'ECI', time: late }, 5), 'https://www.bls.gov/news.release/eci.nr0.htm?_=5');
  assert.equal(resultUrl({ id: 'bea:pce:x', short: 'PCE', time: late }), 'https://www.bea.gov/news/current-releases');
  assert.equal(resultUrl({ id: 'sosovalue:pmi:x', short: 'PMI', time: late }), null);
});

test('the Fed broadcast: page without an account, recordings vs live, https only, renditions resolved against the playlist', () => {
  assert.deepEqual(parseFedLivePage('<div><video class="x" data-video-id="6370001" data-player="abc"></video></div>'), {
    videoId: '6370001', account: '66043936001', player: 'abc', embed: 'default',
  });
  assert.equal(parseFedLivePage('<video src="x.mp4"></video>'), null);
  const rec = parseBrightcoveVideo({
    name: 'FOMC Press Conference', duration: 3_600_000, poster: 'http://cf.example/p.jpg',
    sources: [{ type: 'application/x-mpegURL', src: 'http://insecure/m.m3u8' }, { type: 'video/mp4', src: 'https://x/v.mp4' }],
    text_tracks: [{ kind: 'metadata', src: 'https://x/meta.vtt' }, { kind: 'captions', src: 'https://x/cc.vtt', sources: null }],
  });
  assert.deepEqual(rec, { name: 'FOMC Press Conference', live: false, hls: null, poster: 'https://cf.example/p.jpg', vtt: 'https://x/cc.vtt' });
  assert.deepEqual(parseBrightcoveVideo(null), { name: null, live: true, hls: null, poster: null, vtt: null });
  assert.equal(parseBrightcoveVideo({ duration: 0, sources: [{ type: 'application/x-mpegURL', src: 'https://x/live.m3u8' }] }).live, true);
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="alt",DEFAULT=NO,URI="audio/alt.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="main",DEFAULT=YES,URI="audio/main.m3u8?t=1"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="en",URI="https://cdn.example/subs.m3u8"',
    '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",INSTREAM-ID="CC1"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1',
    'v.m3u8',
  ].join('\r\n');
  assert.deepEqual(parseMasterPlaylist(master, 'https://fed.example/live/master.m3u8'), {
    audioOnly: 'https://fed.example/live/audio/main.m3u8?t=1',
    captions: 'https://cdn.example/subs.m3u8',
  });
  assert.deepEqual(parseMasterPlaylist('#EXTM3U\nv.m3u8', 'https://x/'), {});
});
