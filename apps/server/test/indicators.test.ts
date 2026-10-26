/**
 * Indicator history: FRED's CSVs saved on 25 October 2026
 * (test/fixtures/indicators), the figures computed from them checked against
 * what releases.ts read from the agencies' own pages (test/fixtures/releases),
 * and the cache against a fake network. Nothing here calls the network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { easternToUtc, sosoIndicators, type CalendarEvent } from '../src/valuescan/calendar.js';
import { INDICATORS, indicator, indicatorList, indicatorReleased, indicatorView, parseFredCsv, periodLabel, resetIndicators, transform } from '../src/valuescan/indicators.js';
import { RELEASE_FIELDS, decodePage, parseRelease } from '../src/valuescan/releases.js';

const csv = (series: string) => readFileSync(new URL(`./fixtures/indicators/${series}.csv`, import.meta.url), 'utf8');
const latest = (id: string) => indicatorView(parseFredCsv(csv(INDICATORS[id]!.series)), INDICATORS[id]!, 'max').latest;
const release = (file: string, short: string, t: number) => parseRelease(short, decodePage(readFileSync(new URL(`./fixtures/releases/${file}`, import.meta.url))), t)!;

test("FRED's CSV: a row per period, '.' left out", () => {
  const u = parseFredCsv(csv('UNRATE'));
  assert.equal(u.length, 944);
  assert.deepEqual(u[0], ['1948-01-01', 3.4]);
  assert.deepEqual(u.at(-1), ['2026-09-01', 4.2]);
  // October 2025 was never published (the shutdown): FRED has '.', the series skips it.
  assert.equal(u.some(([d]) => d === '2025-10-01'), false);
  assert.throws(() => parseFredCsv('<html>busy</html>'), /not a FRED series/);
});

test('the transforms: changes on the period and the year before, one decimal, half away from zero', () => {
  const obs: Array<[string, number]> = [['2025-01-01', 100], ['2025-02-01', 100.05], ['2026-01-01', 103], ['2026-02-01', 102.9]];
  assert.deepEqual(transform(obs, { transform: 'mm', decimals: 1 }), [['2025-02-01', 0.1], ['2026-01-01', 2.9], ['2026-02-01', -0.1]]);
  assert.deepEqual(transform(obs, { transform: 'yy', decimals: 1 }), [['2026-01-01', 3], ['2026-02-01', 2.8]]);
  assert.deepEqual(transform(obs, { transform: 'diff', decimals: 0 }), [['2025-02-01', 0], ['2026-01-01', 3], ['2026-02-01', 0]]);
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

test('the newest figures, as FRED had them on 25 October 2026', () => {
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
    // SoSoValue's releases (saved 26 October 2026).
    new_home_sales: ['August 2026', 684, 643],
    existing_home_sales: ['September 2026', 3.99, 3.93],
    housing_starts: ['September 2026', 1221, 1288],
    building_permits: ['September 2026', 1400, 1403],
    retail_mm: ['September 2026', 0.8, 1.3],
    retail_ex_auto_mm: ['September 2026', 0.9, 1.4],
    initial_claims: ['Week of 2026-10-17', 194, 200],
    continuing_claims: ['Week of 2026-10-10', 1728, 1703],
    umich_sentiment: ['September 2026', 48.1, 51.7],
    ip_mm: ['September 2026', 0.7, 0.1],
    durables_mm: ['August 2026', -0.1, 0.9],
  };
  assert.deepEqual(Object.keys(want).sort(), Object.keys(INDICATORS).sort());
  for (const [id, [period, value, prior]] of Object.entries(want)) assert.deepEqual(latest(id), { period, value, prior }, id);
});

test("each indicator is a figure of its kind's release card, and matches the agency's printed figure", () => {
  // A kind with an official card: a figure on it. One without (SoSoValue's): a figure some SoSoValue event names.
  const named = new Set(['New Home Sales', 'Existing Home Sales', 'Housing Starts', 'Building Permits', 'Retail Sales', 'Initial Jobless Claims', 'Michigan Consumer Sentiment', 'Industrial Production MoM', 'Durable Goods Orders MoM'].flatMap(sosoIndicators));
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
  const obs = parseFredCsv(csv('CPIAUCSL'));
  const y1 = indicatorView(obs, i, '1y');
  // September 2025 to September 2026 is 13 months; October 2025's CPI was never published.
  assert.equal(y1.points.length, 12);
  assert.deepEqual(y1.points[0], [Date.parse('2025-09-01T00:00:00Z'), 3]);
  assert.deepEqual(y1.points.at(-1), [Date.parse('2026-09-01T00:00:00Z'), 3.7]);
  assert.equal(y1.table.length, 24);
  assert.deepEqual(y1.table.slice(0, 2), [{ period: 'September 2026', value: 3.7, prior: 3.4 }, { period: 'August 2026', value: 3.4, prior: 3.3 }]);
  assert.ok(indicatorView(obs, i, 'max').points.length > 900);
  // A step series starts the range with the level then in force, and tabulates its changes.
  const fed = indicatorView(parseFredCsv(csv('DFEDTARU')), INDICATORS.fed_upper!, '1y');
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

test('the route: FRED read once per series, again after a release of its kind, the next release from the calendar', async () => {
  resetIndicators();
  const asked: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    const id = /id=(\w+)/.exec(String(url))![1]!;
    asked.push(id);
    return new Response(csv(id));
  };
  const now = Date.parse('2026-10-25T12:00:00Z');
  const ev = (id: string, short: string, time: number) => ({ id, short, time, source: id.split(':')[0] }) as CalendarEvent;
  const calendarImpl = async () => ({
    events: [ev('sosovalue:pce:2026-10-28', 'PCE', now + 3 * 86_400_000), ev('bea:pce:2026-10-29', 'PCE', Date.parse('2026-10-29T12:30:00Z')), ev('bls:cpi:2026-11-12', 'CPI', now + 18 * 86_400_000)],
    sources: { fed: 'ok', bls: 'ok', bea: 'ok', sosovalue: 'ok' } as const,
  });
  try {
    const page = (await indicator('core_pce_yy', '1y', { fetchImpl, calendarImpl, now }))!;
    assert.deepEqual(page.source, { name: 'FRED (BEA)', series: 'PCEPILFE', href: 'https://fred.stlouisfed.org/series/PCEPILFE' });
    assert.deepEqual(page.latest, { period: 'August 2026', value: 3, prior: 3 });
    assert.deepEqual(page.next, { time: Date.parse('2026-10-29T12:30:00Z'), eventId: 'bea:pce:2026-10-29' });
    assert.equal(page.points.length, 13);
    assert.ok(page.updatedAt > 0);
    await indicator('core_pce_mm', '5y', { fetchImpl, calendarImpl, now });
    assert.deepEqual(asked, ['PCEPILFE'], 'one read for both of its indicators');
    // A CPI release leaves PCE alone; a PCE release has it read again.
    indicatorReleased('CPI');
    await indicator('core_pce_yy', '1y', { fetchImpl, calendarImpl, now });
    assert.deepEqual(asked, ['PCEPILFE']);
    await new Promise((r) => setTimeout(r, 5));
    indicatorReleased('PCE');
    await indicator('core_pce_yy', '1y', { fetchImpl, calendarImpl, now });
    assert.deepEqual(asked, ['PCEPILFE', 'PCEPILFE']);
    // Not in the catalog: nothing read.
    assert.equal(await indicator('nope', '1y', { fetchImpl, calendarImpl, now }), null);
  } finally {
    resetIndicators();
  }
});
