/**
 * The live suite's browser target (apps/executor/tools/live-test/browserDriver.ts): how the
 * executor's API maps onto the web test bridge, and what comes back in the executor's shapes.
 * No browser here: the page is a fake session that records every bridge call and answers it
 * (the real page, apps/web/e2e/ui/bridgeSession.ts, needs Edge and the dev web, and CI never
 * starts either).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AlgoView, CopyView, RegionPolicy } from '../../../packages/copy-engine/src/index.ts';
import { WebBridgeDriver, browserInfo, browserMe, findAlgo, findCopy, keyInfoOf, pageRefusal, servesCheckout, type PageAbout, type WebSession } from '../tools/live-test/browserDriver.ts';
import { CheckFailed, Inconclusive, T, Unavailable, type Env } from '../tools/live-test/harness.ts';
import { BrowserTarget, CAPABILITIES } from '../tools/live-test/target.ts';

const W = '0x00000000000000000000000000000000000000aa';
const LEADER = '0x00000000000000000000000000000000000000bb';
const POLICY: RegionPolicy = { region: 'other', allowed: true, maxLeverage: null, reason: null, country: 'SG', mismatch: false } as RegionPolicy;

const about = (x: Partial<PageAbout> = {}): PageAbout => ({
  wallet: W,
  network: 'mainnet',
  build: 'local-202610291200',
  builder: { id: 234812, algoFee: 15, copyFee: 25 },
  brake: null,
  copyTerms: { version: '2026-10-28', hash: '0xterms' },
  viewerCountry: null,
  policy: POLICY,
  liveAlgos: false,
  trading: { status: 'off', owner: W, accountId: null },
  copyKey: { name: 'vd-copy-browser', maxDays: 7 },
  ...x,
});

const view = (id: string, x: Partial<AlgoView['algo']> = {}): AlgoView => ({ algo: { id, owner: W, status: 'running', filled: 0, children: [], createdAt: 1, ...x } } as unknown as AlgoView);
const copyView = (id: string): CopyView => ({ subscription: { id, owner: W, status: 'active' }, positions: [] } as unknown as CopyView);

/** A page that answers the bridge calls from `answers` (a value, or a function of the args) and records each call. */
function fakeSession(answers: Record<string, unknown>, o: { address?: string } = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const life: string[] = [];
  let ready = true;
  const s: WebSession = {
    address: o.address ?? W,
    async call(path, args = []) {
      calls.push([path, args]);
      if (!(path in answers)) return undefined;
      const a = answers[path];
      return typeof a === 'function' ? (a as (...x: unknown[]) => unknown)(...args) : a;
    },
    ready: async () => ready,
    async leave(how) {
      life.push(`leave:${how}`);
      ready = false;
    },
    async reopen() {
      life.push('reopen');
      ready = true;
    },
    gone: () => null,
    errors: () => [],
    async close() {
      life.push('close');
    },
  };
  return { s, calls, life, setReady: (v: boolean) => (ready = v) };
}

function driverOf(answers: Record<string, unknown>, o: { mode?: 'dry' | 'live'; origin?: string; now?: () => number } = {}) {
  const f = fakeSession({ about: about(), ...answers });
  let opened = 0;
  const lines: string[] = [];
  const d = new WebBridgeDriver({
    mode: o.mode ?? 'dry',
    origin: o.origin ?? 'http://127.0.0.1:5180',
    follower: W,
    session: async () => {
      opened += 1;
      return f.s;
    },
    log: (l) => lines.push(l),
    now: o.now,
  });
  return { d, f, lines, opened: () => opened };
}

/* -------------------------------------------------------------- the mapping ----- */

test('info: a browser is its own kind, with no session to sign for; its two fees are the "ladder", each from $0; no builder, none', () => {
  const i = browserInfo(about(), 'the page');
  assert.equal(i.executorId, 'browser');
  assert.equal(i.kind as string, 'browser');
  assert.deepEqual(i.builder, { id: 234812, ladder: [{ fromUsd: 0, fee: 15 }, { fromUsd: 0, fee: 25 }], windowDays: 14 }, 'an algo child\'s trading fee and a copy\'s top step');
  assert.deepEqual(browserInfo(about({ builder: { id: 1, algoFee: 25, copyFee: 25 } }), '').builder?.ladder, [{ fromUsd: 0, fee: 25 }], 'one fee once');
  assert.equal(browserInfo(about({ builder: null }), '').builder, null);
  assert.equal(i.keyImport, undefined, 'nothing is imported into a browser');
  assert.deepEqual(i.features, ['counter', 'algo-update']);
  assert.deepEqual([i.keyName, i.keyTtlDaysMax, i.termsVersion, i.version, i.owner], ['vd-copy-browser', 7, '2026-10-28', 'local-202610291200', W]);
  assert.equal(i.brake, null);
  assert.deepEqual(browserInfo(about({ brake: { trading: true, copies: false, algos: false, reason: 'maintenance' } }), '').brake, { copies: true, algos: true, reason: 'maintenance', since: null }, 'a trading brake holds both');
  assert.deepEqual(browserInfo(about({ brake: { trading: false, copies: false, algos: true, reason: 'x' } }), '').brake, { copies: false, algos: true, reason: 'x', since: null });
  assert.equal(browserInfo(about({ brake: { trading: false, copies: false, algos: false, reason: 'x' } }), '').brake, null, 'all switches off: no brake');
});

test('me: the copy terms the page holds (seen from its viewer country), its region rules, its key and its copies', () => {
  const terms = { termsVersion: '2026-10-28', termsHash: '0xterms', country: 'SG', acceptedAt: 5, recorded: false };
  const key = keyInfoOf({ address: '0xkey', name: 'vd-copy-browser', expiresAt: 99 }, 7);
  const me = browserMe(about({ viewerCountry: 'DE' }), terms, key, [copyView('b1')]);
  assert.deepEqual(me.terms, { termsVersion: '2026-10-28', termsHash: '0xterms', country: 'SG', observedCountry: 'DE', acceptedAt: 5 });
  assert.equal(me.policy, POLICY);
  assert.deepEqual(me.key, { address: '0xkey', name: 'vd-copy-browser', expiresAt: 99, registered: true, createdAt: 7 }, 'a key in the vault was kept once SoDEX listed it');
  assert.equal(me.copies[0]!.subscription.id, 'b1');
  assert.equal(browserMe(about(), null, null, []).terms, null);
  assert.equal(keyInfoOf({ address: '0xk', name: 'n', expiresAt: null, registered: false }, 0)?.registered, false);
  assert.equal(keyInfoOf(null, 0), null);
});

test('one algo or copy of a list, else the executor client\'s kind of error (a wait retries it)', () => {
  assert.equal(findAlgo([view('a1'), view('a2')], 'a2').algo.id, 'a2');
  assert.throws(() => findAlgo([], 'a9'), /the browser does not list algo a9/);
  assert.equal(findCopy([copyView('b1')], 'b1').subscription.id, 'b1');
  assert.throws(() => findCopy([], 'b9'), /the browser does not list copy b9/);
});

test('a real algo the dev web does not let this wallet start is inconclusive, saying what to set; anything else is the page\'s own error', () => {
  const r = pageRefusal(new Error('Real algo orders are off for now. Turn on Practice run to try one against the live market.'));
  assert.ok(r instanceof Inconclusive);
  assert.match(r.message, /VITE_LIVE_ALGOS_WALLETS in apps\/web\/\.env\.local/);
  const other = new Error('No such algo.');
  assert.equal(pageRefusal(other), other);
  assert.equal(pageRefusal('text').message, 'text');
});

test('the dev web serves this checkout when the engine it serves sits under this checkout\'s folder (Vite /@fs/)', () => {
  const repo = 'C:\\Users\\me\\Some Folder\\valuescan';
  const src = (p: string) => `import { AlgoRuntime } from "/@fs/${p}/packages/copy-engine/src/index.ts?t=1793268903173";`;
  assert.equal(servesCheckout(src('C:/Users/me/Some Folder/valuescan'), repo), true, 'spaces, slashes');
  assert.equal(servesCheckout(src('c:/users/me/some folder/valuescan'), repo), true, 'Windows paths are not case-sensitive');
  assert.equal(servesCheckout(src('C:/Users/me/valuescan-algo'), repo), false, 'another worktree');
  assert.equal(servesCheckout('', repo), false, 'nothing read');
});

/* --------------------------------------------------------------- the driver ----- */

test('open: the page once, with the follower\'s wallet; again after it was left; a live run refuses a dev web without a builder', async () => {
  const { d, f, opened } = driverOf({});
  await d.open();
  await d.open();
  assert.equal(opened(), 1, 'open is idempotent while the page is there');
  assert.equal(await d.ready(), true);
  await d.leave('reload');
  assert.equal(await d.ready(), false);
  await d.open();
  assert.deepEqual(f.life, ['leave:reload', 'reopen']);
  assert.equal(opened(), 1, 'the same page, reloaded');
  await d.close();
  assert.deepEqual(f.life.at(-1), 'close');

  const other = driverOf({ about: about({ wallet: LEADER }) });
  await assert.rejects(other.d.open(), /the page's wallet is 0x0+bb, not the follower/);
  const noBuilder = driverOf({ about: about({ builder: null }) }, { mode: 'live' });
  await assert.rejects(noBuilder.d.open(), /names no builder \(VITE_BUILDER_ID in apps\/web\/\.env\.local\)/);
  await driverOf({ about: about({ builder: null }) }).d.open();
  const noLive = driverOf({}, { mode: 'live' });
  await noLive.d.open();
  assert.match(noLive.lines.join('\n'), /starts no real algo for this wallet \(VITE_LIVE_ALGOS_WALLETS\)/);
});

test('algos: start, act, update, list, events map onto the bridge; the view comes back as the runtime lists it', async () => {
  const list = [view('a1')];
  const { d, f } = driverOf({ 'algos.start': 'a1', 'algos.list': () => list, 'algos.events': [{ kind: 'fill' }] });
  await d.open();
  const spec = { kind: 'twap', paper: true };
  assert.equal((await d.algoStart(spec, 7)).algo.id, 'a1');
  assert.deepEqual(f.calls.find((c) => c[0] === 'algos.start'), ['algos.start', [spec, 7]]);
  await d.algoStart(spec);
  assert.deepEqual(f.calls.filter((c) => c[0] === 'algos.start').at(-1), ['algos.start', [spec]], 'no seed: the page picks one');
  for (const op of ['pause', 'resume', 'cancel'] as const) assert.equal((await d.algoAct(op, 'a1'))[0]!.algo.id, 'a1');
  await d.algoAct('cancel-all');
  await d.algoUpdate('a1', { quantity: '0.002' });
  assert.equal((await d.algo('a1')).algo.id, 'a1');
  await assert.rejects(d.algo('a9'), /does not list algo a9/);
  assert.deepEqual(await d.events('a1', 50), [{ kind: 'fill' }]);
  const acts = f.calls.filter((c) => /^algos\.(pause|resume|cancel|cancelAll|update|events)$/.test(c[0]));
  assert.deepEqual(acts, [
    ['algos.pause', ['a1']],
    ['algos.resume', ['a1']],
    ['algos.cancel', ['a1']],
    ['algos.cancelAll', []],
    ['algos.update', ['a1', { quantity: '0.002' }]],
    ['algos.events', ['a1', 50]],
  ]);
  const refused = driverOf({ 'algos.start': () => Promise.reject(new Error('Real algo orders are off for now. Turn on Practice run to try one against the live market.')) }, { mode: 'live' });
  await refused.d.open();
  await assert.rejects(refused.d.algoStart({ kind: 'twap', paper: false }), (e: unknown) => e instanceof Inconclusive);
});

test('copies: the rules as the executor reads them (defaults filled, a bad one refused), then the page\'s start, act and activity', async () => {
  const copies = [copyView('b1')];
  const { d, f } = driverOf({ 'copier.start': 'b1', 'copier.list': () => copies, 'copier.events': [{ kind: 'order' }] });
  await d.open();
  const rules = { leader: { venue: 'sodex', address: LEADER.toUpperCase().replace('0X', '0x') }, sizingMode: 'fixedNotional', fixedNotionalUsd: 12, maxLeverage: 2, paper: true };
  assert.equal((await d.subscribe(rules)).subscription.id, 'b1');
  const sent = f.calls.find((c) => c[0] === 'copier.start')![1][0] as Record<string, unknown>;
  assert.deepEqual(sent.leader, { venue: 'sodex', address: LEADER }, 'the address lower-case, as the executor keeps it');
  assert.equal(sent.marginMode, 'isolated', 'a default filled in');
  await assert.rejects(d.subscribe({ leader: { venue: 'sodex', address: 'nope' } }), /leader\.address/);
  await d.copyAct('update', { id: 'b1', settings: { ...rules, fixedNotionalUsd: 24 } });
  await d.copyAct('pause', { id: 'b1' });
  await d.copyAct('resume', { id: 'b1' });
  await d.copyAct('stop', { id: 'b1', close: true });
  await d.copyAct('stop-all', { close: true });
  const acts = f.calls.filter((c) => /^copier\.(update|pause|resume|stop|stopAll)$/.test(c[0])).map(([p, a]) => [p, p === 'copier.update' ? [a[0], (a[1] as { fixedNotionalUsd: number }).fixedNotionalUsd] : a]);
  assert.deepEqual(acts, [
    ['copier.update', ['b1', 24]],
    ['copier.pause', ['b1']],
    ['copier.resume', ['b1']],
    ['copier.stop', ['b1', true]],
    ['copier.stopAll', [true]],
  ]);
  assert.equal((await d.copy('b1')).subscription.id, 'b1');
  assert.deepEqual(await d.activity('b1', 20), [{ kind: 'order' }]);
  assert.deepEqual(f.calls.at(-1), ['copier.events', ['b1', 20]]);
});

test('terms and key: the page signs the copy terms (refused when it shows other ones); its key is made there and kept once SoDEX lists it', async () => {
  const terms = { termsVersion: '2026-10-28', termsHash: '0xterms', country: 'SG', acceptedAt: 5, recorded: true };
  let listed = false;
  const { d, f } = driverOf(
    {
      'copier.acceptTerms': terms,
      'copier.terms': terms,
      'copier.key': null,
      'copier.list': [],
      'copier.makeKey': { address: '0xkey', name: 'vd-copy-browser' },
      'copier.verifyKey': () => ({ address: '0xkey', name: 'vd-copy-browser', expiresAt: 99, registered: listed }),
    },
    { now: () => 1234 },
  );
  await d.open();
  await assert.rejects(d.acceptTerms('SG', '0xother'), /other copy terms/);
  const me = await d.acceptTerms('SG', '0xterms');
  assert.deepEqual(f.calls.find((c) => c[0] === 'copier.acceptTerms'), ['copier.acceptTerms', ['SG']]);
  assert.equal(me.terms?.country, 'SG');
  assert.deepEqual(await d.createKey(30), { address: '0xkey', name: 'vd-copy-browser', maxDays: 7, days: 7 }, 'at most the browser key\'s 7 days');
  assert.equal((await d.verifyKey())?.registered, false, 'not listed yet');
  listed = true;
  assert.deepEqual(await d.verifyKey(), { address: '0xkey', name: 'vd-copy-browser', expiresAt: 99, registered: true, createdAt: 1234 });
  await assert.rejects(d.importKey(), (e: unknown) => e instanceof Unavailable && /makes its own copy key/.test(e.message));
  const before = f.calls.length;
  await d.signIn();
  assert.equal(f.calls.length, before, 'no session in a browser: nothing is asked of the page');
});

test('stopEverything: the page\'s kill switch and every copy stopped and closed, its errors only logged; nothing when the page is not there', async () => {
  const { d, f } = driverOf({ 'algos.cancelAll': () => Promise.reject(new Error('Connect your wallet first.')) });
  await d.stopEverything();
  assert.deepEqual(f.calls, [], 'not open yet');
  await d.open();
  await d.stopEverything();
  assert.deepEqual(f.calls.slice(-2), [['algos.cancelAll', []], ['copier.stopAll', [true]]]);
  await d.leave('close');
  const n = f.calls.length;
  await d.stopEverything();
  assert.equal(f.calls.length, n, 'a closed tab is asked nothing');
});

test('the viewer country is read where the page reads it (the dev web\'s /api/copy info), without a page; unreachable is none', async () => {
  const srv = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(req.url === '/api/copy/v1/info' ? JSON.stringify({ viewerCountry: 'DE' }) : '{}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  try {
    const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const { d, opened } = driverOf({}, { origin });
    const b = new BrowserTarget('dry', d);
    assert.equal(await b.observedCountry(), 'DE');
    assert.equal(opened(), 0, 'no page for it');
  } finally {
    srv.close();
  }
  assert.equal(await driverOf({}, { origin: 'http://127.0.0.1:1' }).d.viewerCountry(), null);
});

/* --------------------------------------------------------------- the target ----- */

test('browser target: a restart is a reload, a closed tab comes back in a new one; nothing is killed hard, nothing imported, the fee stub is self\'s', async () => {
  assert.deepEqual(CAPABILITIES.browser, { restart: true, kill: false, localFeeStub: false, keyImport: false, tabClose: true, ui: true });
  const { d, f } = driverOf({});
  const b = new BrowserTarget('dry', d);
  assert.match(b.where, /Microsoft Edge \(http:\/\/127\.0\.0\.1:5180, the test bridge\)/);
  await b.start();
  const lines: string[] = [];
  const t = new T({ mode: 'dry', timeScale: 0, log: (l: string) => lines.push(l), target: b } as unknown as Env, 'twap.restart');
  await t.restart({ downMs: 1 });
  assert.deepEqual(f.life, ['leave:reload', 'reopen']);
  assert.match(lines.join('\n'), /the page goes away, as on a reload/);
  assert.equal((await b.health()).ok, true);
  await t.closeTab({ downMs: 1 });
  assert.deepEqual(f.life, ['leave:reload', 'reopen', 'leave:close', 'reopen']);
  assert.match(lines.join('\n'), /closing the tab that runs the algos/);
  const self = { name: 'self', capabilities: CAPABILITIES.self, gone: () => null } as unknown as Env['target'];
  await assert.rejects(new T({ mode: 'dry', timeScale: 0, log: () => undefined, target: self } as unknown as Env, 'x').closeTab({ downMs: 1 }), (e: unknown) => e instanceof Unavailable && /the self target has no browser tab to close/.test(e.message));
  const abandoned = new T({ mode: 'dry', timeScale: 0, log: () => undefined, target: b } as unknown as Env, 'y');
  abandoned.abandon('timeout');
  await assert.rejects(abandoned.closeTab({ downMs: 1 }), CheckFailed);
});
