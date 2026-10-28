/**
 * The calendar's official results (releases.tsx): how a figure is shown, the
 * one-line summary, and the event card's states and figures (rendered on the
 * server, the Modal in place - no DOM).
 *   npx tsx --test src/components/news/releases.test.tsx
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { INLINE_MODAL, installViteStubs, staticMarkup } from '../macro/testEnv';
import { setNumStyle } from '../../numStyle';

setNumStyle('comma-dot');

installViteStubs({ stubs: { '/components/Modal.tsx': INLINE_MODAL } });
const { createElement } = await import('react');
const renderToStaticMarkup = await staticMarkup();
const { EventCard, fmtField, hasResults, summary } = await import('./releases');
type ReleaseResult = import('./releases').ReleaseResult;
type CalendarEvent = import('../../vsApi').CalendarEvent;

const pct = { unit: '%' as const };
const k = { unit: 'k' as const };
const bp = { unit: 'bp' as const };
const none = { unit: '' as const };

test('only the Fed\'s, BLS\'s and BEA\'s events have official results', () => {
  assert.deepEqual((['fed', 'bls', 'bea', 'sosovalue'] as const).map((source) => hasResults({ source })), [true, true, true, false]);
});

test('fmtField: a rate, a change in thousands, basis points, plain text', () => {
  assert.equal(fmtField(pct, '0.3'), '0.3%');
  assert.equal(fmtField(pct, '-0.1'), '-0.1%');
  assert.equal(fmtField(k, '177'), '+177k');
  assert.equal(fmtField(k, '1234'), '+1,234k');
  assert.equal(fmtField(k, '-33'), '-33k');
  assert.equal(fmtField(k, '0'), '0k', 'no change carries no sign');
  assert.equal(fmtField(bp, '-25'), '-25 bp');
  assert.equal(fmtField(bp, '0'), '0 bp');
  assert.equal(fmtField(bp, '50'), '+50 bp');
  assert.equal(fmtField(none, '29'), '29');
});

test('fmtField: the Fed\'s text figures - a range gets its %, a word or a vote stays as printed', () => {
  assert.equal(fmtField(pct, '3.75–4.00'), '3.75–4.00%');
  assert.equal(fmtField(pct, '4.00%'), '4.00%', 'already a percentage: no second %');
  assert.equal(fmtField(pct, 'Hold'), 'Hold');
  assert.equal(fmtField(none, '11–1'), '11–1');
  assert.equal(fmtField(bp, 'Hold'), 'Hold');
});

test('fmtField: no figure is a dash', () => {
  assert.equal(fmtField(pct, null), '—');
  assert.equal(fmtField(k, ''), '—');
});

const result = (fields: ReleaseResult['fields'], extra: Partial<ReleaseResult> = {}): ReleaseResult => ({
  id: 'bls:cpi:1', state: 'released', releasedAt: 1, seenAt: 1, scheduledAt: 1, period: 'September 2026', priorPeriod: 'August 2026',
  headline: null, href: 'https://www.bls.gov/news.release/cpi.nr0.htm', fields, ...extra,
});
const CPI = [
  { key: 'mm', label: 'CPI m/m', unit: '%' as const, value: '0.3', prior: '0.4' },
  { key: 'yy', label: 'CPI y/y', unit: '%' as const, value: '2.9', prior: '2.9' },
  { key: 'core_mm', label: 'Core m/m', unit: '%' as const, value: '0.2', prior: '0.3' },
];

test('summary: the first figures out, in a line; none out is "released"', () => {
  assert.equal(summary(result(CPI)), 'CPI m/m 0.3% · CPI y/y 2.9%');
  assert.equal(summary(result(CPI), 3), 'CPI m/m 0.3% · CPI y/y 2.9% · Core m/m 0.2%');
  assert.equal(summary(result([{ ...CPI[0]!, value: null }, CPI[1]!])), 'CPI y/y 2.9%', 'a figure not printed is skipped');
  assert.equal(summary(result([])), 'released');
  assert.equal(summary(result([{ key: 'rate', label: 'Decision', unit: 'bp', value: 'Hold', prior: null }])), 'Decision Hold');
});

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'bls:cpi:1', time: Date.now() + 86_400_000, allDay: false, short: 'CPI', title: 'CPI inflation, September 2026', detail: null,
  importance: 'high', country: 'US', source: 'bls', href: 'https://www.bls.gov/schedule/news_release/cpi.htm',
  fields: CPI.map(({ key, label, unit }) => ({ key, label, unit })), ...over,
});
const card = (e: CalendarEvent, r?: ReleaseResult, sourceName?: string) =>
  renderToStaticMarkup(createElement(EventCard, { event: e, result: r, onClose: () => {}, sourceName }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

test('EventCard, released: each figure, the previous one and the change, coloured by direction', () => {
  const html = card(event({ time: Date.now() - 3_600_000 }), result(CPI, { releasedAt: 1_000_000, seenAt: 1_001_234 }), 'Bureau of Labor Statistics');
  const t = text(html);
  assert.match(t, /^Released /);
  assert.match(t, /Bureau of Labor Statistics/);
  assert.match(t, /September 2026/);
  assert.match(t, /CPI m\/m 0\.3% Prev 0\.4% −0\.1 pp/);
  assert.match(t, /CPI y\/y 2\.9% Prev 2\.9% Core/, 'no change: no change shown');
  assert.match(html, /evc__figval is-down">0\.3%/);
  assert.match(t, /Previous: August 2026\./);
  assert.match(t, /Read from bls\.gov 1\.2s after the scheduled time\./);
  assert.match(t, /Open on bls\.gov/);
  assert.match(html, /href="https:\/\/www\.bls\.gov\/news\.release\/cpi\.nr0\.htm"/, 'the release itself, not the schedule');
});

test('EventCard: payrolls in thousands, the change signed in k', () => {
  const nfp = [{ key: 'payrolls', label: 'Payrolls', unit: 'k' as const, value: '177', prior: '-33' }];
  const t = text(card(event({ short: 'NFP', fields: [{ key: 'payrolls', label: 'Payrolls', unit: 'k' }] }), result(nfp)));
  assert.match(t, /Payrolls \+177k Prev -33k \+210k/);
});

test('EventCard, still to come: a countdown and empty figures; the source in capitals without a name', () => {
  const html = card(event({ time: Date.now() + 2 * 86_400_000 + 3 * 3_600_000 + 4 * 60_000 + 30_000 }));
  const t = text(html);
  assert.match(t, /^In 2d 3h 4m /);
  assert.match(t, /BLS/);
  assert.match(t, /CPI m\/m — Prev —/);
  assert.match(html, /evc__figval is-empty">—/);
  assert.doesNotMatch(t, /Read from/, 'not read yet: no lag');
  assert.match(t, /Consensus forecasts are not published by the official sources\./);
  assert.match(t, /Open on bls\.gov/);
});

test('EventCard: a minute before to twenty after its time, not out yet, it is waiting', () => {
  for (const off of [-50_000, 0, 19 * 60_000]) {
    const html = card(event({ time: Date.now() - off }), result(CPI.map((f) => ({ ...f, value: null })), { state: 'watching' }));
    assert.match(text(html), /^Waiting for the release…/, String(off));
    assert.match(html, /is-wait/);
  }
  assert.match(text(card(event({ time: Date.now() - 21 * 60_000 }))), /^Not read yet/, 'past the window with no result');
  assert.match(text(card(event({ time: Date.now() + 5 * 60_000 }))), /^In 5m 00s/);
  assert.match(text(card(event({ time: Date.now() + 2 * 3_600_000 + 61_000 }))), /^In 2h 1m \d+s/);
});

test('EventCard: an event with neither figures nor indicators says why there is nothing to show', () => {
  const soso = { source: 'sosovalue' as const, fields: undefined, href: 'https://sosovalue.com/calendar' };
  assert.match(text(card(event({ ...soso, title: 'ISM Manufacturing PMI' }))), /this survey's history is not freely published/);
  assert.match(text(card(event({ ...soso, title: 'Retail sales' }))), /This calendar publishes the date only; there are no official figures to show here\./);
  assert.match(text(card(event({ ...soso, title: 'Retail sales', detail: 'Advance estimate, 8:30 am ET' }))), /Advance estimate, 8:30 am ET/);
  assert.match(text(card(event({ ...soso }))), /Open on sosovalue\.com/);
});

test('EventCard: an all-day event shows its own date (UTC), and a broken link is "the source"', () => {
  const noon = Date.UTC(2026, 10, 3, 12);
  const t = text(card(event({ allDay: true, time: noon, href: 'not a url', fields: [] })));
  assert.match(t, new RegExp(new Date(noon).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })));
  assert.match(t, /Open on the source/);
});

test('EventCard: a result read after a restart (no seenAt) or seen early claims no lag', () => {
  assert.doesNotMatch(text(card(event({ time: Date.now() - 3_600_000 }), result(CPI, { seenAt: null }))), /Read from/);
  assert.doesNotMatch(text(card(event({ time: Date.now() - 3_600_000 }), result(CPI, { releasedAt: 2_000, seenAt: 1_000 }))), /Read from/);
});
