/**
 * The economic calendar: the Fed's meetings, the BLS and BEA release calendars
 * and SoSoValue's macro events, read from the shapes they publish. Nothing
 * here calls the network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calendar,
  easternToUtc,
  mergeCalendar,
  parseCalendarQuery,
  parseFomc,
  parseIcs,
  parseSosoEvents,
  sosoIndicators,
  pickReleases,
  resetCalendar,
} from '../src/valuescan/calendar.js';

const meeting = (month: string, date: string) =>
  `<div class="row fomc-meeting"><div class="fomc-meeting__month col-xs-5"><strong>${month}</strong></div>
   <div class="fomc-meeting__date col-xs-4">${date}</div><div>Statement</div></div>`;
const FED_HTML = `<h4><a id="1">2026 FOMC Meetings</a></h4>${meeting('October', '27-28')}${meeting('December', '8-9*')}
  <h4><a id="2">2027 FOMC Meetings</a></h4>${meeting('Apr/May', '30-1')}${meeting('June', 'notation vote')}`;

test('easternToUtc: New York time, summer and winter', () => {
  assert.equal(new Date(easternToUtc(2026, 10, 28, 14, 0)).toISOString(), '2026-10-28T18:00:00.000Z');
  assert.equal(new Date(easternToUtc(2026, 12, 9, 14, 0)).toISOString(), '2026-12-09T19:00:00.000Z');
  // The Sunday the clocks go back: 8:30 am is already standard time.
  assert.equal(new Date(easternToUtc(2026, 11, 1, 8, 30)).toISOString(), '2026-11-01T13:30:00.000Z');
});

test('parseFomc: the decision at 2 pm ET on the last day, projections where starred, a meeting across months', () => {
  const ev = parseFomc(FED_HTML);
  assert.deepEqual(
    ev.map((e) => [new Date(e.time).toISOString().slice(0, 16), e.title, e.short, e.importance]),
    [
      ['2026-10-28T18:00', 'FOMC rate decision', 'FOMC', 'high'],
      ['2026-12-09T19:00', 'FOMC rate decision and projections', 'FOMC', 'high'],
      ['2027-05-01T18:00', 'FOMC rate decision', 'FOMC', 'high'],
    ],
  );
  assert.ok(ev.every((e) => e.source === 'fed' && e.href.startsWith('https://www.federalreserve.gov/')));
  // What its result card shows (releases.ts RELEASE_FIELDS).
  assert.deepEqual(ev[0]!.fields?.map((f) => f.key), ['decision', 'range', 'votes']);
  assert.deepEqual(parseFomc('<p>No calendar here</p>'), []);
});

const BLS_ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'DTSTART;TZID=US-Eastern:20261110T083000',
  'SUMMARY:Consumer Price Index',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=US-Eastern:20261103T100000',
  'SUMMARY:Job Openings and Labor Turnover Survey',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=US-Eastern:20261112T100000',
  'SUMMARY:Metropolitan Area Employment and',
  '  Unemployment (Monthly)',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const BEA_ICS = [
  'BEGIN:VEVENT',
  'SUMMARY:GDP (Advance Estimate)\\, 3rd Quarter 2026',
  'DTSTART;VALUE=DATE-TIME:20261029T123000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Personal Income and Outlays\\, September 2026',
  'DTSTART;VALUE=DATE-TIME:20261029T123000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:GDP by County and Personal Income by County\\, 2025',
  'DTSTART;VALUE=DATE-TIME:20261202T133000Z',
  'END:VEVENT',
].join('\n');

test('parseIcs and pickReleases: the releases that count, named, at their time', () => {
  const raw = parseIcs(BLS_ICS);
  assert.equal(raw.length, 3);
  assert.equal(raw[2]!.summary, 'Metropolitan Area Employment and Unemployment (Monthly)', 'a folded line is one line');
  const bls = pickReleases(raw, 'bls');
  assert.deepEqual(
    bls.map((e) => [new Date(e.time).toISOString().slice(0, 16), e.short, e.title, e.importance]),
    [
      ['2026-11-10T13:30', 'CPI', 'CPI inflation, October 2026', 'high'],
      ['2026-11-03T15:00', 'JOLTS', 'JOLTS job openings, September 2026', 'medium'],
    ],
  );
  const bea = pickReleases(parseIcs(BEA_ICS), 'bea');
  assert.deepEqual(bea.map((e) => [e.short, e.title]), [['GDP', 'GDP Q3 2026 (advance)'], ['PCE', 'PCE inflation, September 2026']]);
});

test('parseSosoEvents and mergeCalendar: SoSoValue fills in what the official calendars do not publish', () => {
  const soso = parseSosoEvents({ code: 0, data: [
    { date: '2026-10-28', events: ['Core PCE Price Index (MoM)', 'GDP (QoQ) '] },
    { date: '2026-11-01', events: ['ISM Manufacturing PMI'] },
    { date: 'soon', events: ['Broken'] },
  ] });
  assert.deepEqual(soso.map((e) => [e.short, e.allDay, e.importance]), [['PCE', true, 'high'], ['GDP', true, 'high'], ['ISM', true, 'medium']]);
  // Its figures are indicators the server charts; ISM's history is not free, so it has none.
  assert.deepEqual(soso.map((e) => e.indicators), [['core_pce_mm'], ['gdp'], undefined]);
  assert.deepEqual(sosoIndicators('Retail Sales Ex Autos (MoM)'), ['retail_ex_auto_mm']);
  assert.deepEqual(sosoIndicators('Continuing Jobless Claims'), ['continuing_claims']);
  assert.deepEqual(sosoIndicators('CPI (YoY)'), ['cpi_yy']);
  assert.deepEqual(sosoIndicators('S&P Global Services PMI'), []);
  const bea = pickReleases(parseIcs(BEA_ICS), 'bea');
  const merged = mergeCalendar(bea, soso);
  assert.deepEqual(merged.map((e) => `${e.source}:${e.short}`), ['bea:GDP', 'bea:PCE', 'sosovalue:ISM'], 'the official GDP and PCE a day later stand for SoSoValue\'s');
});

test('calendar: every source read once in twelve hours; one that has never answered says so', async () => {
  resetCalendar();
  const prev = process.env.SOSOVALUE_API_KEY;
  delete process.env.SOSOVALUE_API_KEY;
  let fedUp = true;
  const asked: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    const u = String(url);
    asked.push(new URL(u).hostname);
    if (u.includes('federalreserve.gov')) return fedUp ? new Response(FED_HTML) : new Response('down', { status: 503 });
    if (u.includes('bls.gov')) return new Response(BLS_ICS);
    return new Response(BEA_ICS);
  };
  try {
    const from = Date.UTC(2026, 9, 1);
    const to = Date.UTC(2026, 11, 31);
    const a = await calendar(from, to, fetchImpl);
    assert.deepEqual(a.sources, { fed: 'ok', bls: 'ok', bea: 'ok', sosovalue: 'ok' });
    assert.deepEqual(a.events.map((e) => e.short), ['FOMC', 'GDP', 'PCE', 'JOLTS', 'CPI', 'FOMC']);
    await calendar(from, to, fetchImpl);
    assert.equal(asked.length, 3, 'read once in twelve hours');
    // A fresh process while the Fed's page is down: no FOMC, and the source says none.
    resetCalendar();
    fedUp = false;
    const b = await calendar(from, to, fetchImpl);
    assert.equal(b.sources.fed, 'none');
    assert.ok(!b.events.some((e) => e.short === 'FOMC'));
  } finally {
    resetCalendar();
    if (prev !== undefined) process.env.SOSOVALUE_API_KEY = prev;
  }
});

test('parseCalendarQuery: a week back to two months ahead, at most about a year', () => {
  const now = Date.UTC(2026, 9, 24);
  const DAY = 86_400_000;
  assert.deepEqual(parseCalendarQuery({}, now), { from: now - 7 * DAY, to: now + 60 * DAY });
  const q = parseCalendarQuery({ from: String(now), to: String(now + 900 * DAY) }, now);
  assert.equal(q.to, now + 400 * DAY);
  assert.deepEqual(parseCalendarQuery({ from: 'yesterday', to: String(now - DAY) }, now), { from: now - 7 * DAY, to: now - DAY });
});
