/**
 * The app's own analytics (usage.ts): nothing - no storage, no request - before
 * consent; after it, page views, feature names from the list only, routes without
 * addresses; withdrawing stops it and deletes the ids. Run in a small stand-in for
 * the browser (no DOM library).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  keys() {
    return [...this.m.keys()];
  }
}

const local = new MemStorage();
const session = new MemStorage();
const requests: string[] = [];
const g = globalThis as Record<string, unknown>;
Object.assign(g, {
  window: globalThis,
  localStorage: local,
  sessionStorage: session,
  location: { pathname: `/trader/0x${'ab'.repeat(20)}`, search: '?utm_source=x&utm_campaign=launch', hostname: 'www.valuedesk.so' },
  document: { visibilityState: 'visible', referrer: 'https://x.com/somebody', addEventListener() {} },
  innerWidth: 1440,
  screen: { width: 2560, height: 1440 },
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
});
Object.defineProperty(globalThis, 'navigator', { value: { language: 'de-DE', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36', maxTouchPoints: 0 }, configurable: true });
globalThis.fetch = (async (url: string) => {
  requests.push(url);
  return new Response(null, { status: 204 });
}) as typeof fetch;

const { allowAnalytics, analyticsDecided, revokeAnalytics, _resetAnalyticsConsentForTests } = await import('../legal/analyticsConsent');
const { startAnalytics, track, routeOf, browserOf, sourceOf, randomId, _queueForTests, _resetForTests } = await import('./usage');

test('before consent: no id stored, nothing queued, nothing sent', () => {
  _resetAnalyticsConsentForTests();
  assert.equal(analyticsDecided(), false);
  startAnalytics();
  track('order.place', { engine: 'perps' });
  assert.deepEqual(local.keys(), []);
  assert.deepEqual(session.keys(), []);
  assert.equal(_queueForTests().length, 0);
  assert.deepEqual(requests, []);
});

test('after consent: a page view without the address, ids kept, features from the list only', () => {
  allowAnalytics();
  const q = _queueForTests();
  assert.deepEqual(q.map((e) => [e.k, e.p]), [['view', '/trader/:address']]);
  track('order.place', { engine: 'perps', legs: 1 });
  track('not.a.feature');
  assert.deepEqual(_queueForTests().filter((e) => e.k === 'feature').map((e) => e.n), ['order.place']);
  assert.ok(local.keys().includes('vd.consent.analytics.v1'));
});

test('withdrawing: nothing more is queued and the ids are deleted', () => {
  local.setItem('vd.an.v1', JSON.stringify({ id: randomId(), at: Date.now() }));
  revokeAnalytics();
  assert.equal(_queueForTests().length, 0);
  assert.equal(local.getItem('vd.an.v1'), null);
  track('order.place');
  assert.equal(_queueForTests().length, 0);
  assert.equal(analyticsDecided(), true, 'a withdrawal is an answer: the visitor is not asked again');
  _resetForTests();
});

test('routes, browsers and sources are cut down to words', () => {
  assert.equal(routeOf(`/scan/0x${'cd'.repeat(20)}?tab=fills`), '/scan/:address');
  assert.equal(routeOf('/copy/12345/x'), '/copy/:id/x');
  assert.deepEqual(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Mobile Safari/604.1'), { browser: 'safari 18', os: 'ios' });
  assert.deepEqual(browserOf('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0'), { browser: 'edge 130', os: 'windows' });
  assert.deepEqual(sourceOf('https://www.google.com/search?q=secret', '', 'www.valuedesk.so'), { ref: 'google.com' });
  assert.deepEqual(sourceOf('https://www.valuedesk.so/trade', '?utm_source=x&utm_medium=social', 'www.valuedesk.so'), { utm: { source: 'x', medium: 'social', campaign: undefined } });
  assert.match(randomId(), /^[A-Za-z0-9_-]{22}$/);
});
