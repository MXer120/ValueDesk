/**
 * The macro widgets' formatters and reads (api.ts).
 *   npx tsx --test src/components/macro/api.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtUsd, fmtValue, macroApi } from './api';

test('fmtUsd: a flow in B, M, K or dollars, signed, the minus sign not a hyphen', () => {
  assert.equal(fmtUsd(1_240_000_000), '+$1.24B');
  assert.equal(fmtUsd(-310_500_000), '−$310.5M');
  assert.equal(fmtUsd(12_345), '+$12.3K');
  assert.equal(fmtUsd(-512), '−$512');
  assert.equal(fmtUsd(512, false), '$512');
  assert.equal(fmtUsd(-512, false), '−$512', 'an outflow keeps its sign without the plus');
  assert.equal(fmtUsd(0), '$0');
});

test('fmtUsd: missing, NaN and infinite figures are a dash, never "$NaN"', () => {
  for (const v of [null, undefined, Number.NaN, Infinity, -Infinity]) assert.equal(fmtUsd(v), '—');
});

test('fmtUsd: a figure that rounds up moves to the next unit (no "$1000" or "$1000.0K")', () => {
  // Failing before the fix: '+$1000', '+$1000.0K', '+$1000.0M'.
  assert.equal(fmtUsd(999.5), '+$1.0K');
  assert.equal(fmtUsd(999.4), '+$999');
  assert.equal(fmtUsd(999_950), '+$1.0M');
  assert.equal(fmtUsd(999_949), '+$999.9K');
  assert.equal(fmtUsd(-999_950_000), '−$1.00B');
  assert.equal(fmtUsd(999_949_999), '+$999.9M');
});

test('fmtUsd: a flow that rounds to $0 carries no sign', () => {
  // Failing before the fix: '−$0' and '+$0'.
  assert.equal(fmtUsd(-0.4), '$0');
  assert.equal(fmtUsd(0.3), '$0');
  assert.equal(fmtUsd(-0.6), '−$1');
});

test('fmtValue: an indicator in its unit', () => {
  assert.equal(fmtValue('%', 3.04), '3.0%');
  assert.equal(fmtValue('%', 2.95, 2), '2.95%');
  assert.equal(fmtValue('k', 177), '+177k', 'a change (payrolls) is signed');
  assert.equal(fmtValue('k', -33.4), '−33k');
  assert.equal(fmtValue('k', 1234.6), '+1,235k');
  assert.equal(fmtValue('K', 684), '684k', 'a level (claims) is not');
  assert.equal(fmtValue('K', -12), '−12k');
  assert.equal(fmtValue('M', 7.123, 2), '7.12M');
  assert.equal(fmtValue('', 7.1), '7.1');
  assert.equal(fmtValue('', -0.25, 2), '−0.25');
  for (const v of [null, undefined, Number.NaN, Infinity]) assert.equal(fmtValue('%', v), '—');
});

test('fmtValue: a reading that rounds to zero has no sign (no "−0.0%" or "−0k")', () => {
  // Failing before the fix: '−0.0%', '−0k', '−0k', '−0.0', '+0k'.
  assert.equal(fmtValue('%', -0.04), '0.0%');
  assert.equal(fmtValue('k', -0.3), '0k');
  assert.equal(fmtValue('K', -0.4), '0k');
  assert.equal(fmtValue('', -0.001), '0.0');
  assert.equal(fmtValue('k', 0.3), '0k');
  assert.equal(fmtValue('%', -0.05), '−0.1%', 'one that rounds away from zero keeps it');
  assert.equal(fmtValue('k', -0.5), '0k', 'Math.round(-0.5) is -0: no sign');
  assert.equal(fmtValue('k', -0.6), '−1k');
});

type FetchArgs = Parameters<typeof fetch>;
function withFetch(reply: (url: string) => { status?: number; body: unknown }, run: (urls: string[]) => Promise<void>) {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (...[input]: FetchArgs) => {
    const url = String(input);
    urls.push(url);
    const { status = 200, body } = reply(url);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return run(urls).finally(() => { globalThis.fetch = real; });
}

test('macroApi: each read asks its route with its query encoded, and returns the body', async () => {
  await withFetch(() => ({ body: { ok: true, meetings: [], now: 1, current: null } }), async (urls) => {
    const fw = await macroApi.fedwatch();
    assert.deepEqual(fw.meetings, []);
    await macroApi.fedHistory('2026-12-09', '30d');
    await macroApi.indicators();
    await macroApi.indicator('core pce&yy', 'max');
    await macroApi.etf('B/TC', 'all');
    assert.deepEqual(urls, [
      '/api/vs/fedwatch',
      '/api/vs/fedwatch/history?meeting=2026-12-09&range=30d',
      '/api/vs/indicators',
      '/api/vs/indicator?id=core%20pce%26yy&range=max',
      '/api/vs/etf/flows?asset=B%2FTC&range=all',
    ]);
  });
});

test('macroApi: a refused read throws the server\'s message, its error code, or the status', async () => {
  await withFetch(() => ({ status: 503, body: { ok: false, message: 'Kalshi did not answer' } }), async () => {
    await assert.rejects(macroApi.fedwatch(), /Kalshi did not answer/);
  });
  await withFetch(() => ({ status: 400, body: { ok: false, error: 'unknown_indicator' } }), async () => {
    await assert.rejects(macroApi.indicator('nope', '1y'), /unknown_indicator/);
  });
  await withFetch(() => ({ status: 502, body: '<html>Bad gateway</html>' }), async () => {
    await assert.rejects(macroApi.etf('BTC', 'all'), /The request failed \(502\)/);
  });
  await withFetch(() => ({ status: 200, body: { results: [] } }), async () => {
    await assert.rejects(macroApi.indicators(), /The request failed \(200\)/, 'a body without ok:true is not an answer');
  });
});
