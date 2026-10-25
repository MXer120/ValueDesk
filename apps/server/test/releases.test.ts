/**
 * Official results at the release second: the parsers on pages saved from the
 * agencies (test/fixtures/releases), and the watcher against a fake network.
 * Nothing here calls the network.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { easternToUtc, type CalendarEvent } from '../src/valuescan/calendar.js';
import {
  RELEASE_FIELDS,
  decodePage,
  easternDay,
  firstSentence,
  parseBeaListing,
  parseBrightcoveVideo,
  parseFedLivePage,
  parseMasterPlaylist,
  parseRelease,
  releaseResults,
  resetReleases,
  resultUrl,
  startReleaseWatcher,
} from '../src/valuescan/releases.js';

const page = (name: string) => decodePage(readFileSync(new URL(`./fixtures/releases/${name}`, import.meta.url)));
const values = (r: ReturnType<typeof parseRelease>) => Object.fromEntries(Object.entries(r!.values).map(([k, v]) => [k, v.value]));
const at830 = (y: number, mo: number, d: number) => easternToUtc(y, mo, d, 8, 30);

test('the jobs report: payrolls in thousands, the unemployment rate, hourly earnings', () => {
  const r = parseRelease('NFP', page('bls-empsit.html'), at830(2026, 10, 2))!;
  assert.equal(r.releaseDate, '2026-10-02');
  assert.equal(r.fresh, true);
  assert.equal(r.period, 'September 2026');
  assert.match(r.headline!, /^Both nonfarm payroll employment \(\+29,000\) and the unemployment rate \(4\.2 percent\) changed little in September, the U\.S\. Bureau of Labor Statistics reported today\.$/);
  assert.deepEqual(values(r), { payrolls: '29', unemployment: '4.2', ahe_mm: '0.1', ahe_yy: '3.0' });
  // The page before the release is not the release.
  assert.equal(parseRelease('NFP', page('bls-empsit.html'), at830(2026, 11, 6))!.fresh, false);
});

test('CPI from table A: the seasonally adjusted month and the unadjusted 12 months', () => {
  const r = parseRelease('CPI', page('bls-cpi.html'), at830(2026, 10, 14))!;
  assert.equal(r.releaseDate, '2026-10-14');
  assert.equal(r.fresh, true);
  assert.equal(r.period, 'September 2026');
  assert.match(r.headline!, /^The Consumer Price Index for All Urban Consumers \(CPI-U\) increased 0\.6 percent/);
  assert.deepEqual(values(r), { cpi_mm: '0.6', cpi_yy: '3.7', core_mm: '0.3', core_yy: '2.6' });
  // Without the table the summary's words give the same.
  const words = page('bls-cpi.html').replace(/<table[\s\S]*?<\/table>/gi, '');
  assert.deepEqual(values(parseRelease('CPI', words, at830(2026, 10, 14))), { cpi_mm: '0.6', cpi_yy: '3.7', core_mm: '0.3', core_yy: '2.6' });
});

test('PPI: final demand and the core the summary names', () => {
  const r = parseRelease('PPI', page('bls-ppi.html'), at830(2026, 10, 15))!;
  assert.equal(r.releaseDate, '2026-10-15');
  assert.equal(r.period, 'September 2026');
  assert.deepEqual(values(r), { ppi_mm: '1.3', ppi_yy: '6.3', core_mm: '0.5', core_yy: '5.0' });
  assert.equal(r.values.core_mm!.note, 'Final demand less foods, energy, and trade services');
});

test('JOLTS and the employment cost index (a page in Windows-1252)', () => {
  const j = parseRelease('JOLTS', page('bls-jolts.html'), easternToUtc(2026, 9, 29, 10, 0))!;
  assert.equal(j.releaseDate, '2026-09-29');
  assert.equal(j.fresh, true);
  assert.equal(j.period, 'August 2026');
  assert.deepEqual(values(j), { openings: '7.1' });
  const e = parseRelease('ECI', page('bls-eci.html'), at830(2026, 7, 31))!;
  assert.equal(e.releaseDate, '2026-07-31');
  assert.equal(e.period, 'June 2026');
  assert.deepEqual(values(e), { eci_qq: '0.9', eci_yy: '3.4' });
});

test('FOMC statement 16 September 2026: a hike, the new range, a unanimous vote', () => {
  const r = parseRelease('FOMC', page('fomc-20260916.html'), easternToUtc(2026, 9, 16, 14, 0))!;
  assert.equal(r.releaseDate, '2026-09-16');
  assert.equal(r.fresh, true);
  assert.equal(r.headline, "The Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent, in support of the Federal Reserve's dual mandate.");
  assert.deepEqual(r.values, { decision: { value: 'Hike 25 bp' }, range: { value: '3.75–4.00' }, votes: { value: '12–0' } });
});

test('FOMC statements with dissents: a hold with three against, a cut with the vote listed by name', () => {
  const july = parseRelease('FOMC', page('fomc-20260729.html'), easternToUtc(2026, 7, 29, 14, 0))!;
  assert.equal(july.releaseDate, '2026-07-29');
  assert.deepEqual(values(july), { decision: 'Hold', range: '3.50–3.75', votes: '9–3' });
  assert.equal(july.values.votes!.note, 'Against: Beth M. Hammack, Neel Kashkari, Lorie K. Logan (preferred to raise the target range for the federal funds rate by 1/4 percentage point)');
  const sep25 = parseRelease('FOMC', page('fomc-20250917.html'), easternToUtc(2025, 9, 17, 14, 0))!;
  assert.deepEqual(values(sep25), { decision: 'Cut 25 bp', range: '4.00–4.25', votes: '11–1' });
  assert.equal(sep25.values.votes!.note, 'Against: Stephen I. Miran (preferred to lower the target range for the federal funds rate by 1/2 percentage point)');
  assert.match(sep25.headline!, /^In support of its goals .* the Committee decided to lower the target range/);
});

test('BEA: the current-releases list, GDP and PCE from their release pages', () => {
  const listed = parseBeaListing(page('bea-current.html'));
  assert.deepEqual(listed.find((r) => /^Personal Income and Outlays/.test(r.title)), {
    title: 'Personal Income and Outlays, August 2026',
    href: 'https://www.bea.gov/news/2026/personal-income-and-outlays-august-2026',
    date: '2026-09-30',
  });
  assert.equal(listed.find((r) => /^GDP \(/.test(r.title))?.date, '2026-09-30');

  const gdp = parseRelease('GDP', page('bea-gdp-release.html'), at830(2026, 9, 30))!;
  assert.equal(gdp.releaseDate, '2026-09-30');
  assert.equal(gdp.fresh, true);
  assert.equal(gdp.period, 'Q2 2026 (third estimate)');
  assert.match(gdp.headline!, /^Real gross domestic product \(GDP\) increased at an annual rate of 2\.2 percent in the second quarter of 2026/);
  assert.deepEqual(values(gdp), { gdp: '2.2', pce_price: '5.0', core_pce: '3.3' });

  const pce = parseRelease('PCE', page('bea-pio-release.html'), at830(2026, 9, 30))!;
  assert.equal(pce.releaseDate, '2026-09-30');
  assert.equal(pce.period, 'August 2026');
  assert.deepEqual(values(pce), { pce_mm: '0.3', core_mm: '0.2', pce_yy: '3.4', core_yy: '3.0' });
});

test('sentences, signs and pages that are not releases', () => {
  assert.equal(firstSentence('Rates rose 0.1 percent, the U.S. Bureau said at 8:30 a.m. Today. More.'), 'Rates rose 0.1 percent, the U.S. Bureau said at 8:30 a.m. Today.');
  const pre = (s: string) => `<pre>Transmission of material in this release is embargoed until\n8:30 a.m. (ET) Friday, March 6, 2026\n\nTHE EMPLOYMENT SITUATION - FEBRUARY 2026\n\n${s}\n</pre>`;
  assert.deepEqual(
    values(parseRelease('NFP', pre('Total nonfarm payroll employment declined by 92,000 in February, and the unemployment rate rose to 4.4 percent.'), at830(2026, 3, 6))),
    { payrolls: '-92', unemployment: '4.4' },
  );
  assert.equal(parseRelease('CPI', '<p>Page not found</p>', at830(2026, 3, 6)), null);
  assert.equal(parseRelease('ISM', page('bls-cpi.html'), at830(2026, 3, 6)), null);
});

test('result URLs: the statement by the meeting day, the summary pages, a query that busts an edge cache', () => {
  const ev = (short: string, time: number) => ({ id: '', short, time });
  assert.equal(resultUrl(ev('FOMC', easternToUtc(2026, 10, 28, 14, 0))), 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm');
  assert.equal(resultUrl(ev('NFP', at830(2026, 11, 6)), 123), 'https://www.bls.gov/news.release/empsit.nr0.htm?_=123');
  assert.equal(resultUrl(ev('CPI', 0)), 'https://www.bls.gov/news.release/cpi.nr0.htm');
  assert.equal(resultUrl(ev('PCE', 0)), 'https://www.bea.gov/news/current-releases');
  assert.equal(resultUrl(ev('Retail', 0)), null);
  assert.equal(easternDay(Date.parse('2026-10-29T03:00:00Z')), '2026-10-28');
  for (const k of ['FOMC', 'CPI', 'NFP', 'PPI', 'GDP', 'PCE', 'JOLTS', 'ECI']) assert.ok(RELEASE_FIELDS[k]!.length, k);
});

test('the Fed broadcast: the embedded video, the playback JSON, the audio and subtitles renditions', () => {
  assert.deepEqual(parseFedLivePage(page('fed-live.html')), { videoId: '6405157968112', account: '66043936001', player: 'default', embed: 'default' });
  assert.equal(parseFedLivePage('<p>No video</p>'), null);
  const v = parseBrightcoveVideo(JSON.parse(page('brightcove-video.json')));
  assert.equal(v.name, 'FOMC Press Conference September 16, 2026');
  assert.equal(v.live, false, 'a recording has a duration');
  assert.match(v.hls!, /^https:\/\/manifest\.prod\.boltdns\.net\/.*master\.m3u8/);
  assert.match(v.vtt!, /^https:\/\/.*text\.vtt/);
  assert.match(v.poster!, /^https:\/\//);
  assert.equal(parseBrightcoveVideo({ name: 'Live', duration: -1, sources: [] }).live, true);
  const m = parseMasterPlaylist(page('master.m3u8'), v.hls!);
  assert.match(m.audioOnly!, /\/1891dfb8-eae7-4659-8348-f0ff8e285cef\/10s\/rendition\.m3u8/);
  assert.match(m.captions!, /\/0f3a034b-b968-4513-872f-66507b131c8d\/rendition\.m3u8/);
});

// --- the watcher -----------------------------------------------------------------------------

const event = (short: string, source: CalendarEvent['source'], id: string, time: number): CalendarEvent => ({
  id, time, allDay: false, short, title: short, detail: null, importance: 'high', country: 'US', source, href: 'https://www.bls.gov/',
});

test('the watcher polls from before the release until the page is the new one, and keeps it', async () => {
  resetReleases();
  const dir = mkdtempSync(join(tmpdir(), 'releases-'));
  const release = at830(2026, 10, 2);
  const offset = release - 1_000 - Date.now();
  const now = () => Date.now() + offset;
  const nfp = event('NFP', 'bls', 'bls:nfp:2026-10-02', release);
  const fresh = page('bls-empsit.html');
  const stale = fresh.replace('Friday, October 2, 2026', 'Friday, September 4, 2026');
  const urls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return new Response(urls.length <= 2 ? stale : fresh, { status: 200 });
  }) as unknown as typeof fetch;
  const w = startReleaseWatcher({ fetchImpl, calendarImpl: async () => ({ events: [nfp] }), dir, now, prime: false, fastMs: 20, slowMs: 20, tickMs: 3_600_000 });
  try {
    await w.tick();
    await w.idle();
    assert.equal(urls.length, 3, 'stale twice, then the release');
    assert.equal(maxInFlight, 1);
    assert.ok(urls.every((u) => /^https:\/\/www\.bls\.gov\/news\.release\/empsit\.nr0\.htm\?_=\d+$/.test(u)), urls[0]);
    const { results, hot } = releaseResults(['bls:nfp:2026-10-02', 'sosovalue:ism:2026-10-02'], now());
    assert.equal(hot, true, 'within five minutes of the release');
    assert.deepEqual(Object.keys(results), ['bls:nfp:2026-10-02']);
    const r = results['bls:nfp:2026-10-02']!;
    assert.equal(r.state, 'released');
    assert.equal(r.releasedAt, release);
    assert.ok(r.seenAt! >= release - 1_000 && r.seenAt! < release + 60_000);
    assert.equal(r.period, 'September 2026');
    assert.deepEqual(r.fields.map((f) => [f.key, f.value, f.unit]), [['payrolls', '29', 'k'], ['unemployment', '4.2', '%'], ['ahe_mm', '0.1', '%'], ['ahe_yy', '3.0', '%']]);
    // Kept on disk and read back by the next start.
    assert.ok(existsSync(join(dir, 'release-results.json')));
    w.stop();
    resetReleases();
    const again = startReleaseWatcher({ fetchImpl, calendarImpl: async () => ({ events: [] }), dir, now, prime: false, tickMs: 3_600_000 });
    assert.equal(releaseResults(['bls:nfp:2026-10-02'], now()).results['bls:nfp:2026-10-02']!.state, 'released');
    again.stop();
  } finally {
    w.stop();
    resetReleases();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('at start-up the current pages give the next event its prior values, and fill a release missed while down', async () => {
  resetReleases();
  const dir = mkdtempSync(join(tmpdir(), 'releases-'));
  const now = () => Date.parse('2026-10-25T12:00:00Z');
  const past = event('CPI', 'bls', 'bls:cpi:2026-10-14', at830(2026, 10, 14));
  const next = event('CPI', 'bls', 'bls:cpi:2026-11-13', at830(2026, 11, 13));
  const fomcPast = event('FOMC', 'fed', 'fed:fomc:2026-09-16', easternToUtc(2026, 9, 16, 14, 0));
  const fomcNext = event('FOMC', 'fed', 'fed:fomc:2026-10-28', easternToUtc(2026, 10, 28, 14, 0));
  const fetchImpl = (async (url: string) => {
    if (url.includes('/cpi.nr0.htm')) return new Response(page('bls-cpi.html'));
    if (url.includes('monetary20260916a.htm')) return new Response(page('fomc-20260916.html'));
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  const w = startReleaseWatcher({ fetchImpl, calendarImpl: async () => ({ events: [past, next, fomcPast, fomcNext] }), dir, now, tickMs: 3_600_000 });
  try {
    await w.tick();
    const { results, hot } = releaseResults([past.id, next.id, fomcNext.id, 'bls:ppi:2026-08-14'], now());
    assert.equal(hot, false);
    assert.equal(results[past.id]!.state, 'released');
    assert.equal(results[past.id]!.seenAt, null, 'read after the fact');
    assert.equal(results[past.id]!.fields.find((f) => f.key === 'cpi_yy')!.value, '3.7');
    const n = results[next.id]!;
    assert.equal(n.state, 'scheduled');
    assert.equal(n.priorPeriod, 'September 2026');
    assert.deepEqual(n.fields.map((f) => [f.key, f.value, f.prior]), [['cpi_mm', null, '0.6'], ['cpi_yy', null, '3.7'], ['core_mm', null, '0.3'], ['core_yy', null, '2.6']]);
    const f = results[fomcNext.id]!;
    assert.deepEqual(f.fields.map((x) => [x.key, x.prior]), [['decision', 'Hike 25 bp'], ['range', '3.75–4.00'], ['votes', '12–0']]);
    assert.equal(f.href, 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm');
    // An id the watcher has never seen on the calendar: its time is unknown, so it stays scheduled.
    assert.equal(results['bls:ppi:2026-08-14']!.state, 'scheduled', 'not on the calendar the watcher saw: its time is unknown');
  } finally {
    w.stop();
    resetReleases();
    rmSync(dir, { recursive: true, force: true });
  }
});
