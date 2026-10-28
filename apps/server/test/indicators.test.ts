/**
 * Indicator history: the agencies' own answers saved on 28 October 2026
 * (test/fixtures/indicators: BLS API, Census survey files, DOL's claims XML,
 * the Fed's open market operations page and G.17 CSV, trimmed), the figures
 * computed from them checked against what releases.ts read from the agencies'
 * release pages (test/fixtures/releases), and the cache against a fake
 * network. Nothing here calls the network.
 *
 * The two BEA files are SYNTHETIC: with no BEA_API_KEY to read the API, they
 * are BEA's numbers (as FRED carried them on 25 October 2026: PCEPI, PCEPILFE,
 * A191RL1Q225SBEA) in the shape of the API's NIPA GetData answer.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { easternToUtc, sosoIndicators, type CalendarEvent } from '../src/valuedesk/calendar.js';
import {
  INDICATORS, SERIES, fedTargetRange, indicator, indicatorList, indicatorReleased, indicatorView, parseBea, parseBls, parseCensus, parseClaims, parseDdp,
  parseFedTargets, periodLabel, resetIndicators, transform, unzipFirst, type Observation, type SourceId,
} from '../src/valuedesk/indicators.js';
import { RELEASE_FIELDS, decodePage, parseRelease } from '../src/valuedesk/releases.js';

const fx = (name: string) => new URL(`./fixtures/indicators/${name}`, import.meta.url);
const text = (name: string) => readFileSync(fx(name), 'utf8');
const TODAY = '2026-10-24';
const prefixed = (program: string, m: Map<string, Observation[]>) => new Map([...m].map(([k, v]) => [`${program}/${k}`, v]));
const SAVED: Record<SourceId, () => Map<string, Observation[]>> = {
  bls: () => parseBls(JSON.parse(text('bls-2017-2026.json'))),
  'bea-T20804': () => parseBea(JSON.parse(text('bea-T20804.json'))),
  'bea-T10101': () => parseBea(JSON.parse(text('bea-T10101.json'))),
  'census-RESSALES': () => prefixed('RESSALES', parseCensus(unzipFirst(readFileSync(fx('census-RESSALES.zip'))))),
  'census-RESCONST': () => prefixed('RESCONST', parseCensus(text('census-RESCONST.csv'))),
  'census-MARTS': () => prefixed('MARTS', parseCensus(text('census-MARTS.csv'))),
  'census-M3ADV': () => prefixed('M3ADV', parseCensus(text('census-M3ADV.csv'))),
  'dol-claims': () => parseClaims(text('dol-claims-2026.xml')),
  'fed-target': () => parseFedTargets(text('fed-openmarket.htm'), TODAY),
  'fed-g17': () => parseDdp(text('fed-g17.csv')),
};
const obsOf = (series: string) => SAVED[SERIES[series]!.source]().get(series) ?? [];
const latest = (id: string) => indicatorView(obsOf(INDICATORS[id]!.series), INDICATORS[id]!, 'max').latest;
const release = (file: string, short: string, t: number) => parseRelease(short, decodePage(readFileSync(new URL(`./fixtures/releases/${file}`, import.meta.url))), t)!;

test('the parsers: BLS months and quarters, Census rows by index, DOL weeks, the DDP columns, the target range page', () => {
  const bls = parseBls(JSON.parse(text('bls-2017-2026.json')));
  assert.equal(bls.size, 8);
  const cpi = bls.get('CUSR0000SA0')!;
  assert.deepEqual(cpi[0], ['2017-01-01', 243.618]);
  assert.deepEqual(cpi.at(-1), ['2026-09-01', 336.298]);
  // October 2025 was never published (the shutdown): BLS gives '-', the series skips it.
  assert.equal(cpi.some(([d]) => d === '2025-10-01'), false);
  assert.deepEqual(bls.get('CIS1010000000000I')!.at(-1), ['2026-04-01', 177.178]);
  assert.throws(() => parseBls({ status: 'REQUEST_NOT_PROCESSED', message: ['daily threshold'] }), /daily threshold/);
  assert.deepEqual(parseBls({ status: 'REQUEST_SUCCEEDED', Results: { series: [{ seriesID: 'X', data: [{ year: '2026', period: 'M13', value: '1' }, { year: '2026', period: 'Q05', value: '1' }, { year: '2026', period: 'M02', value: '2.5' }] }] } }).get('X'), [['2026-02-01', 2.5]]);

  assert.deepEqual(parseBea({ BEAAPI: { Results: { Data: [{ SeriesCode: 'A', TimePeriod: '2026Q2', DataValue: '1,234.5' }, { SeriesCode: 'A', TimePeriod: '2026M07', DataValue: '(NA)' }] } } }).get('A'), [['2026-04-01', 1234.5]]);
  assert.throws(() => parseBea({ BEAAPI: { Results: { Error: { APIErrorDescription: 'Invalid API UserId.' } } } }), /Invalid API UserId/);

  // The zip (deflated) holds the survey's CSV; only the SA US rows of each category/data type count.
  const sales = parseCensus(unzipFirst(readFileSync(fx('census-RESSALES.zip'))));
  assert.deepEqual([...sales.keys()], ['ASOLD/TOTAL']);
  assert.deepEqual(sales.get('ASOLD/TOTAL')![0], ['1963-01-01', 591]);
  // M3ADV has no error-type column.
  assert.deepEqual(parseCensus(text('census-M3ADV.csv')).get('MDM/NO')!.at(-1), ['2026-09-01', 345371]);
  assert.throws(() => parseCensus('<html>busy</html>'), /not a Census/);
  assert.throws(() => unzipFirst(new TextEncoder().encode('not a zip')), /not a zip/);

  const claims = parseClaims(text('dol-claims-2026.xml'));
  assert.deepEqual(claims.get('claims/initial')![0], ['2026-01-03', 207000]);
  assert.deepEqual(claims.get('claims/continued')![0], ['2026-01-03', 1875000]);
  // Weeks not yet out are '&#160;' and left out.
  assert.equal(claims.get('claims/initial')!.at(-1)![0], '2026-09-26');

  const ip = parseDdp(text('fed-g17.csv'));
  assert.deepEqual(ip.get('IP.B50001.S')!.at(-1), ['2026-09-01', 103.9506]);
  assert.throws(() => parseDdp('nothing'), /Data Download/);

  const fed = parseFedTargets(text('fed-openmarket.htm'), TODAY);
  // Ranges since 16 December 2008 (the single targets before are left out), effective dates, and today.
  assert.deepEqual(fed.get('target/upper')!.slice(0, 2), [['2008-12-16', 0.25], ['2015-12-17', 0.5]]);
  assert.deepEqual(fed.get('target/lower')!.slice(-3), [['2025-12-11', 3.5], ['2026-09-17', 3.75], [TODAY, 3.75]]);
  assert.throws(() => parseFedTargets('<h4>2026</h4><p>none</p>', TODAY), /no target range/);
});

test('the transforms: changes on the period and the year before, one decimal, half away from zero', () => {
  const obs: Array<[string, number]> = [['2025-01-01', 100], ['2025-02-01', 100.05], ['2026-01-01', 103], ['2026-02-01', 102.9]];
  // No change across the gap from February 2025 to January 2026 (macro-edges.test.ts).
  assert.deepEqual(transform(obs, { transform: 'mm', decimals: 1 }), [['2025-02-01', 0.1], ['2026-02-01', -0.1]]);
  assert.deepEqual(transform(obs, { transform: 'yy', decimals: 1 }), [['2026-01-01', 3], ['2026-02-01', 2.8]]);
  assert.deepEqual(transform(obs, { transform: 'diff', decimals: 0 }), [['2025-02-01', 0], ['2026-02-01', 0]]);
  assert.deepEqual(transform([['2026-01-01', 7079]], { transform: 'thousandths', decimals: 3 }), [['2026-01-01', 7.079]]);
  assert.deepEqual(
    transform([['2026-01-01', 4], ['2026-01-02', 4], ['2026-01-03', 4.25], ['2026-01-04', 4.25]], { transform: 'steps', decimals: 2 }),
    [['2026-01-01', 4], ['2026-01-03', 4.25], ['2026-01-04', 4.25]],
  );
  assert.equal(periodLabel('2026-09-01', 'monthly'), 'September 2026');
  assert.equal(periodLabel('2026-04-01', 'quarterly'), 'Q2 2026');
  assert.equal(periodLabel('2026-09-17', 'daily'), '2026-09-17');
  assert.equal(periodLabel('2026-10-17', 'weekly'), 'Week of 2026-10-17');
  assert.deepEqual(transform([['2026-01-01', 3_990_000]], { transform: 'millionths', decimals: 2 }), [['2026-01-01', 3.99]]);
});

test('the newest figures, as the agencies had them on 28 October 2026', () => {
  const want: Record<string, [string, number, number]> = {
    cpi_mm: ['September 2026', 0.6, 0.4],
    cpi_yy: ['September 2026', 3.7, 3.4],
    core_cpi_mm: ['September 2026', 0.3, 0.3],
    core_cpi_yy: ['September 2026', 2.6, 2.4],
    payrolls: ['September 2026', 29, 133],
    unemployment: ['September 2026', 4.2, 4.1],
    ahe_mm: ['September 2026', 0.1, 0.3],
    ahe_yy: ['September 2026', 3, 3.1],
    ppi_mm: ['September 2026', 1.3, 0.5],
    ppi_yy: ['September 2026', 6.3, 5.6],
    pce_mm: ['August 2026', 0.3, 0.1],
    pce_yy: ['August 2026', 3.4, 3.4],
    core_pce_mm: ['August 2026', 0.2, 0.1],
    core_pce_yy: ['August 2026', 3, 3],
    gdp: ['Q2 2026', 2.2, 2.5],
    jolts: ['August 2026', 7.079, 7.335],
    eci_qq: ['Q2 2026', 0.9, 0.9],
    eci_yy: ['Q2 2026', 3.4, 3.4],
    // The Fed's September hike, effective the day after the statement.
    fed_upper: ['2026-09-17', 4, 3.75],
    fed_lower: ['2026-09-17', 3.75, 3.5],
    // SoSoValue's releases: September's new home sales and durable goods came out on 27 October.
    new_home_sales: ['September 2026', 676, 680],
    housing_starts: ['September 2026', 1221, 1288],
    building_permits: ['September 2026', 1398, 1403],
    retail_mm: ['September 2026', 0.8, 1.3],
    retail_ex_auto_mm: ['September 2026', 0.9, 1.4],
    // DOL's weekly claims report was three weeks behind its press release that day.
    initial_claims: ['Week of 2026-09-26', 199, 198],
    continuing_claims: ['Week of 2026-09-26', 1714, 1699],
    ip_mm: ['September 2026', 0.7, 0.1],
    durables_mm: ['September 2026', 1.8, 0.1],
  };
  assert.deepEqual(Object.keys(want).sort(), Object.keys(INDICATORS).sort());
  for (const [id, [period, value, prior]] of Object.entries(want)) assert.deepEqual(latest(id), { period, value, prior }, id);
  // Neither copyrighted series is offered.
  assert.equal(INDICATORS.umich_sentiment, undefined);
  assert.equal(INDICATORS.existing_home_sales, undefined);
  assert.deepEqual([...sosoIndicators('Michigan Consumer Sentiment'), ...sosoIndicators('Existing Home Sales')], []);
});

test("each indicator is a figure of its kind's release card, and matches the agency's printed figure", () => {
  // A kind with an official card: a figure on it. One without (SoSoValue's): a figure some SoSoValue event names.
  const named = new Set(['New Home Sales', 'Housing Starts', 'Building Permits', 'Retail Sales', 'Initial Jobless Claims', 'Industrial Production MoM', 'Durable Goods Orders MoM'].flatMap(sosoIndicators));
  for (const i of Object.values(INDICATORS)) assert.ok(RELEASE_FIELDS[i.kind] ? RELEASE_FIELDS[i.kind]!.some((f) => f.key === i.field) : named.has(i.id), `${i.id}: ${i.kind}/${i.field}`);
  const at830 = (y: number, mo: number, d: number) => easternToUtc(y, mo, d, 8, 30);
  const printed = {
    CPI: release('bls-cpi.html', 'CPI', at830(2026, 10, 14)),
    NFP: release('bls-empsit.html', 'NFP', at830(2026, 10, 2)),
    PPI: release('bls-ppi.html', 'PPI', at830(2026, 10, 15)),
    JOLTS: release('bls-jolts.html', 'JOLTS', at830(2026, 9, 29)),
    ECI: release('bls-eci.html', 'ECI', at830(2026, 7, 31)),
    PCE: release('bea-pio-release.html', 'PCE', at830(2026, 9, 30)),
    GDP: release('bea-gdp-release.html', 'GDP', at830(2026, 9, 30)),
  } as Record<string, ReturnType<typeof release>>;
  let compared = 0;
  for (const i of Object.values(INDICATORS)) {
    const p = printed[i.kind];
    const v = p?.values[i.field]?.value;
    // PPI's core is a different series (less trade services); FOMC's range is text.
    if (!p || v === undefined || i.id.startsWith('fed_')) continue;
    const mine = latest(i.id)!;
    // GDP's period carries its estimate ("Q2 2026 (third estimate)"); BLS names the ECI's quarter by its last month.
    const theirs = p.period!.replace(/ \(.*\)$/, '').replace(/^June (\d{4})$/, (m, y: string) => (i.kind === 'ECI' ? `Q2 ${y}` : m));
    assert.equal(mine.period, theirs, i.id);
    // JOLTS prints millions to one decimal.
    assert.equal(i.id === 'jolts' ? mine.value.toFixed(1) : String(mine.value), i.id === 'jolts' ? v : String(Number(v)), i.id);
    compared++;
  }
  assert.equal(compared, 18);
});

test("the route's view: the range from the newest observation, the table newest first with priors", () => {
  const i = INDICATORS.cpi_yy!;
  const obs = obsOf('CUSR0000SA0');
  const y1 = indicatorView(obs, i, '1y');
  // September 2025 to September 2026 is 13 months; October 2025's CPI was never published.
  assert.equal(y1.points.length, 12);
  assert.deepEqual(y1.points[0], [Date.parse('2025-09-01T00:00:00Z'), 3]);
  assert.deepEqual(y1.points.at(-1), [Date.parse('2026-09-01T00:00:00Z'), 3.7]);
  assert.equal(y1.table.length, 24);
  assert.deepEqual(y1.table.slice(0, 2), [{ period: 'September 2026', value: 3.7, prior: 3.4 }, { period: 'August 2026', value: 3.4, prior: 3.3 }]);
  // The saved file is 2017 on: y/y from 2018.
  assert.equal(indicatorView(obs, i, 'max').points.length, 104);
  // A step series starts the range with the level then in force, and tabulates its changes.
  const fed = indicatorView(obsOf('target/upper'), INDICATORS.fed_upper!, '1y');
  assert.deepEqual(fed.points, [
    [Date.parse('2025-10-24T00:00:00Z'), 4.25],
    [Date.parse('2025-10-30T00:00:00Z'), 4],
    [Date.parse('2025-12-11T00:00:00Z'), 3.75],
    [Date.parse('2026-09-17T00:00:00Z'), 4],
    [Date.parse('2026-10-24T00:00:00Z'), 4],
  ]);
  assert.deepEqual(fed.table.slice(0, 3).map((r) => [r.period, r.value]), [['2026-09-17', 4], ['2025-12-11', 3.75], ['2025-10-30', 4]]);
  assert.deepEqual(indicatorList().find((x) => x.id === 'core_pce_yy'), { id: 'core_pce_yy', name: 'Core PCE y/y', unit: '%', frequency: 'monthly', kind: 'PCE', field: 'core_yy' });
});

test('the route: each source read once, its history once, again after a release of its kind, a key where one is needed', async () => {
  resetIndicators();
  const saved = { bls: process.env.BLS_API_KEY, bea: process.env.BEA_API_KEY };
  delete process.env.BLS_API_KEY;
  delete process.env.BEA_API_KEY;
  const asked: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === 'api.bls.gov') {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.seriesid.length, 8, 'every BLS series in one request');
      assert.equal(body.registrationkey, undefined);
      asked.push(`bls ${body.startyear}-${body.endyear}`);
      return new Response(body.startyear === '2017' ? text('bls-2017-2026.json') : JSON.stringify({ status: 'REQUEST_SUCCEEDED', Results: { series: [] } }));
    }
    if (u.hostname === 'apps.bea.gov') {
      asked.push(`bea ${u.searchParams.get('TableName')} ${u.searchParams.get('Year')}`);
      assert.equal(u.searchParams.get('UserID'), 'test-key');
      return new Response(text(`bea-${u.searchParams.get('TableName')}.json`));
    }
    if (u.hostname === 'www.census.gov') {
      asked.push(`census ${u.searchParams.get('programCode')}`);
      return new Response(readFileSync(fx('census-RESSALES.zip')));
    }
    if (u.pathname.endsWith('/openmarket.htm')) {
      asked.push('fed openmarket');
      return new Response(text('fed-openmarket.htm'));
    }
    return new Response('', { status: 404 });
  };
  const now = Date.parse('2026-10-25T12:00:00Z');
  const ev = (id: string, short: string, time: number) => ({ id, short, time, source: id.split(':')[0] }) as CalendarEvent;
  const calendarImpl = async () => ({
    events: [ev('sosovalue:cpi:2026-11-11', 'CPI', now + 3 * 86_400_000), ev('bls:cpi:2026-11-12', 'CPI', Date.parse('2026-11-12T13:30:00Z')), ev('bea:pce:2026-10-29', 'PCE', Date.parse('2026-10-29T12:30:00Z'))],
    sources: { fed: 'ok', bls: 'ok', bea: 'ok', sosovalue: 'ok' } as const,
  });
  try {
    const page = (await indicator('cpi_yy', '1y', { fetchImpl, calendarImpl, now }))!;
    assert.deepEqual(page.source, { name: 'BLS', series: 'CUSR0000SA0', href: 'https://data.bls.gov/timeseries/CUSR0000SA0' });
    assert.deepEqual(page.latest, { period: 'September 2026', value: 3.7, prior: 3.4 });
    assert.deepEqual(page.next, { time: Date.parse('2026-11-12T13:30:00Z'), eventId: 'bls:cpi:2026-11-12' });
    assert.equal(page.points.length, 12);
    assert.ok(page.updatedAt > 0);
    // Without a key: the newest 10 years, then the history back to 1939 in 10-year pieces.
    assert.deepEqual(asked, ['bls 2017-2026', 'bls 2007-2016', 'bls 1997-2006', 'bls 1987-1996', 'bls 1977-1986', 'bls 1967-1976', 'bls 1957-1966', 'bls 1947-1956', 'bls 1939-1946']);
    asked.length = 0;
    await indicator('payrolls', '5y', { fetchImpl, calendarImpl, now });
    await indicator('cpi_mm', '5y', { fetchImpl, calendarImpl, now });
    assert.deepEqual(asked, [], 'one read for every BLS indicator');
    // A PCE release leaves BLS alone; a CPI release has it read again - the newest years only.
    indicatorReleased('PCE');
    await indicator('cpi_yy', '1y', { fetchImpl, calendarImpl, now });
    assert.deepEqual(asked, []);
    await new Promise((r) => setTimeout(r, 5));
    indicatorReleased('CPI');
    await indicator('cpi_yy', '1y', { fetchImpl, calendarImpl, now });
    assert.deepEqual(asked, ['bls 2017-2026']);
    asked.length = 0;

    // BEA needs its key: without one nothing is asked and the read fails (the route answers upstream).
    await assert.rejects(indicator('core_pce_yy', '1y', { fetchImpl, calendarImpl, now }), /BEA_API_KEY/);
    assert.deepEqual(asked, []);
    process.env.BEA_API_KEY = 'test-key';
    await new Promise((r) => setTimeout(r, 5));
    resetIndicators();
    const pce = (await indicator('core_pce_yy', '1y', { fetchImpl, calendarImpl, now }))!;
    assert.deepEqual(pce.source, { name: 'BEA', series: 'T20804 DPCCRG', href: 'https://www.bea.gov/data/personal-consumption-expenditures-price-index-excluding-food-and-energy' });
    assert.deepEqual(pce.latest, { period: 'August 2026', value: 3, prior: 3 });
    assert.equal(pce.points.length, 13);
    await indicator('pce_mm', '1y', { fetchImpl, calendarImpl, now });
    assert.deepEqual(asked, ['bea T20804 X'], 'the whole table once, for both PCE gauges');

    // Census: the survey's zip, read and unzipped.
    asked.length = 0;
    const homes = (await indicator('new_home_sales', '1y', { fetchImpl, calendarImpl, now }))!;
    assert.deepEqual(asked, ['census RESSALES']);
    assert.equal(homes.source.name, 'Census');
    assert.match(homes.source.href, /^https:\/\/www\.census\.gov\/econ\/currentdata\/dbsearch\?programCode=RESSALES&categories%5B%5D=ASOLD&dataType=TOTAL/);
    assert.deepEqual(homes.latest, { period: 'September 2026', value: 676, prior: 680 });

    // The target range for fedwatch.ts, from the same cached read.
    assert.deepEqual(await fedTargetRange(fetchImpl), { lower: 3.75, upper: 4 });
    // Not in the catalog: nothing read.
    asked.length = 0;
    assert.equal(await indicator('nope', '1y', { fetchImpl, calendarImpl, now }), null);
    assert.deepEqual(asked, []);
  } finally {
    if (saved.bls === undefined) delete process.env.BLS_API_KEY;
    else process.env.BLS_API_KEY = saved.bls;
    if (saved.bea === undefined) delete process.env.BEA_API_KEY;
    else process.env.BEA_API_KEY = saved.bea;
    resetIndicators();
  }
});
