import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GEO_PATH, _resetGeoForTests, loadViewerGeo, parseGeo, viewerAccess, viewerGeo } from './geo';

const answer = (status: number, body: unknown, type = 'application/json') =>
  (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } })) as unknown as typeof fetch;

test('the edge\'s answer: country and region, normalised; anything else is unknown', () => {
  assert.deepEqual(parseGeo({ country: 'de', region: 'BY' }), { country: 'DE', region: 'BY', known: true });
  assert.deepEqual(parseGeo({ country: null, region: null }), { country: null, region: null, known: true });
  assert.deepEqual(parseGeo({ error: 'x' }), { country: null, region: null, known: false });
  assert.deepEqual(parseGeo('nope'), { country: null, region: null, known: false });
});

test('asked once; a sanctioned or close-only place sets the access; failures restrict nothing', async () => {
  let calls = 0;
  _resetGeoForTests();
  const f = (async (url: string) => {
    calls++;
    assert.equal(url, GEO_PATH);
    return new Response('{"country":"US","region":"CA"}', { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  await loadViewerGeo(f);
  await loadViewerGeo(f);
  assert.equal(calls, 1);
  assert.equal(viewerGeo().country, 'US');
  assert.equal(viewerAccess().level, 'close-only');

  _resetGeoForTests();
  await loadViewerGeo(answer(200, { country: 'UA', region: '14' }));
  assert.equal(viewerAccess().level, 'blocked');
  assert.equal(viewerAccess().place, 'Donetsk');

  _resetGeoForTests();
  await loadViewerGeo(answer(451, { error: 'x' }));
  assert.equal(viewerAccess().level, 'blocked', 'the edge refused the place itself');

  for (const f2 of [answer(404, 'not found', 'text/html'), answer(503, { error: 'x' }), (async () => { throw new Error('offline'); }) as unknown as typeof fetch]) {
    _resetGeoForTests();
    await loadViewerGeo(f2);
    assert.equal(viewerAccess().level, 'open');
    assert.equal(viewerGeo().known, false);
  }
  _resetGeoForTests();
});

test('the region strip: close-only places by name, an unknown country, nothing where open', async () => {
  const { regionBannerText } = await import('./notices');
  const { siteAccess } = await import('./jurisdictions.mjs');
  assert.equal(regionBannerText(siteAccess({ country: 'US' }), true), 'ValueDesk is close-only in the United States: you can close positions, cancel orders and withdraw, but not open new positions.');
  assert.match(regionBannerText(siteAccess({ country: 'GB' }), true)!, /close-only in the United Kingdom:/);
  assert.match(regionBannerText(siteAccess({ country: 'DE', declared: 'CA' }), true)!, /close-only in Canada:/);
  assert.match(regionBannerText(siteAccess({ country: 'PR' }), true)!, /Puerto Rico \(a US territory\)/);
  assert.match(regionBannerText(siteAccess(), false)!, /could not tell your country/);
  assert.equal(regionBannerText(siteAccess({ country: 'DE' }), true), null);
});
