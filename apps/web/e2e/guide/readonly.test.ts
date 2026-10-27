/**
 * Stage B's rules: what may be sent at all, and how each answer is judged.
 *   npx tsx --test e2e/guide/readonly.test.ts        (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FALLBACK_ROUTES, isNotReady, leaderboardProbes, parseHostedRoutes, parseVenues, probesFor, type ProbeContext } from './ownApi';
import {
  HL_INFO,
  RPC_HOSTS,
  SODEX_GATEWAY,
  bestBidAsk,
  cspConnectSources,
  judgeBook,
  judgeCors,
  judgeIndexerStatus,
  judgeKlines,
  judgeMark,
  judgePreflight,
  judgeSymbols,
  missingFromCsp,
  readOnlyProblem,
  unwrapSodex,
  wsMessageProblem,
  wsProblem,
} from './readonly';

const BACKEND = { backend: 'http://127.0.0.1:5180' };
const A = '0x1111111111111111111111111111111111111111';
const allowed = (method: string, url: string, body: string | null = null): void => assert.equal(readOnlyProblem(method, url, body, BACKEND), null, `${method} ${url}`);
const refused = (method: string, url: string, body: string | null, why: RegExp): void => assert.match(String(readOnlyProblem(method, url, body, BACKEND)), why, `${method} ${url}`);

// --- the policy -------------------------------------------------------------------------------

test('reads go out: GET / HEAD / OPTIONS to the app\'s hosts and to the dev server', () => {
  allowed('GET', `${SODEX_GATEWAY}/api/v1/perps/markets/symbols`);
  allowed('GET', `${SODEX_GATEWAY}/api/v1/perps/accounts/${A}/state`);
  allowed('OPTIONS', `${SODEX_GATEWAY}/api/v1/perps/trade/orders`);
  allowed('HEAD', 'https://mainnet-data.sodex.dev/api/v1/leaderboard');
  allowed('GET', 'https://api.arcus.xyz/v1/markets');
  allowed('GET', 'http://127.0.0.1:5180/api/vs/leaderboard?venue=sodex');
});

test('HARD LIMIT: SoDEX history reads never leave - directly or through our own API', () => {
  const why = /history/;
  refused('GET', `${SODEX_GATEWAY}/api/v1/perps/accounts/${A}/trades?limit=1`, null, why);
  refused('GET', `${SODEX_GATEWAY}/api/v1/spot/accounts/${A}/trades`, null, why);
  refused('GET', `${SODEX_GATEWAY}/api/v1/perps/accounts/${A}/orders/history?limit=1`, null, why);
  refused('GET', `http://127.0.0.1:5180/api/acct/perps/trades?address=${A}`, null, why);
  refused('GET', `http://127.0.0.1:5180/api/acct/spot/orders/history?address=${A}`, null, why);
  refused('GET', `http://127.0.0.1:5180/api/vs/fills?venue=sodex&address=${A}`, null, why);
  refused('GET', 'http://127.0.0.1:5180/api/stats/all-time', null, why);
  // The public trade tape of a MARKET is not an account's history.
  allowed('GET', `${SODEX_GATEWAY}/api/v1/perps/markets/BTC-USD/trades?limit=5`);
});

test('writes never leave: POST / DELETE / PUT to an exchange, a chain or our API', () => {
  refused('POST', `${SODEX_GATEWAY}/api/v1/perps/trade/orders`, '{"orders":[]}', /is a write/);
  refused('DELETE', `${SODEX_GATEWAY}/api/v1/perps/trade/orders`, null, /is a write/);
  refused('PUT', `${SODEX_GATEWAY}/api/v1/x`, null, /is a write/);
  refused('POST', `${SODEX_GATEWAY}/api/v1/user/${A}/builders`, '{}', /is a write/);
  refused('POST', 'https://alpha-biz.sodex.dev/biz/mirror/call_for_permit', '{}', /is a write/);
  refused('POST', 'https://alpha-biz.sodex.dev/biz/mirror/create_deposit_addresses', '{}', /is a write/);
  refused('POST', 'http://127.0.0.1:5180/api/deposit/prepare', '{}', /is a write/);
  refused('POST', HL_INFO.replace('/info', '/exchange'), '{"action":{}}', /is a write/);
});

test('the two POSTs that are reads: Hyperliquid /info queries and JSON-RPC read methods - and only those', () => {
  allowed('POST', HL_INFO, '{"type":"meta"}');
  allowed('POST', HL_INFO, '{"type":"allMids"}');
  refused('POST', HL_INFO, '{"type":"userFills","user":"0x1"}', /not on the read list/);
  refused('POST', HL_INFO, 'not json', /treated as a write/);
  const rpc = RPC_HOSTS[0]!.url;
  allowed('POST', rpc, '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}');
  allowed('POST', 'https://arb1.arbitrum.io/rpc', '[{"method":"eth_chainId"},{"method":"eth_blockNumber"}]');
  refused('POST', rpc, '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x"]}', /eth_sendRawTransaction is not on the read list/);
  refused('POST', rpc, '[{"method":"eth_chainId"},{"method":"eth_sendRawTransaction"}]', /not on the read list/);
});

test('other hosts, plain http, and the other project\'s ports are refused', () => {
  refused('GET', 'https://example.com/', null, /not a host the app talks to/);
  refused('GET', 'http://mainnet-gw.sodex.dev/api/v1/perps/markets/symbols', null, /not https/);
  refused('GET', 'http://127.0.0.1:5173/api/health', null, /another project/);
  refused('GET', 'http://127.0.0.1:8787/api/health', null, /another project/);
  refused('GET', 'http://127.0.0.1:8797/api/health', null, /not https/); // only through the dev server's proxy
  refused('GET', 'not a url', null, /not a URL/);
});

test('sockets: only SoDEX\'s two market streams, only public market subscriptions', () => {
  assert.equal(wsProblem('wss://mainnet-gw.sodex.dev/ws/perps'), null);
  assert.equal(wsProblem('wss://mainnet-gw.sodex.dev/ws/spot'), null);
  assert.match(String(wsProblem('wss://example.com/ws')), /not a SoDEX market stream/);
  assert.equal(wsMessageProblem({ op: 'ping' }), null);
  assert.equal(wsMessageProblem({ op: 'subscribe', params: { channel: 'l2Book', symbol: 'BTC-USD' } }), null);
  assert.equal(wsMessageProblem({ op: 'subscribe', params: { channel: 'trade', symbols: ['BTC-USD'] } }), null);
  assert.match(String(wsMessageProblem({ op: 'subscribe', params: { channel: 'accountTrade', user: A } })), /public market channels/);
  assert.match(String(wsMessageProblem({ op: 'subscribe', params: { channel: 'trade', symbols: ['X'], user: A } })), /account channels/);
  assert.match(String(wsMessageProblem({ op: 'order', params: {} })), /not allowed/);
});

// --- judging ----------------------------------------------------------------------------------

test('CORS: "*" or the calling origin; a missing header or another origin blocks a browser', () => {
  const o = 'https://valuedesk.example';
  assert.deepEqual(judgeCors('*', o), { ok: true, how: 'any origin' });
  assert.deepEqual(judgeCors(o, o), { ok: true, how: 'echoes the calling origin' });
  assert.equal(judgeCors(null, o).ok, false);
  assert.equal(judgeCors('https://sodex.com', o).ok, false);
  const pre = { allowOrigin: '*', allowMethods: 'GET,POST,DELETE,OPTIONS', allowHeaders: 'Origin,Content-Type,X-Api-Key,X-Api-Sign,X-Api-Nonce,X-Api-Chain' };
  assert.equal(judgePreflight(pre, o, 'POST', ['content-type', 'x-api-key', 'x-api-sign']).ok, true);
  assert.match(judgePreflight(pre, o, 'PATCH', []).how, /PATCH is not in/);
  assert.match(judgePreflight(pre, o, 'POST', ['x-custom']).how, /x-custom is not in/);
  assert.equal(judgePreflight({ allowOrigin: '*', allowMethods: '*', allowHeaders: '*' }, o, 'POST', ['anything']).ok, true);
  assert.equal(judgePreflight({ ...pre, allowOrigin: null }, o, 'POST', []).ok, false);
});

test('the page\'s own policy: connect-src is read from the CSP meta tag - not from a comment that mentions it', () => {
  const html = `<!doctype html><html><head>
    <!--
      connect-src 'self'      the ValueDesk index API; https://not-a-real-entry.example is only prose here
    -->
    <meta
      http-equiv="Content-Security-Policy"
      content="
        default-src 'self';
        img-src 'self' data: https://api.web3modal.org;
        connect-src 'self'
          https://mainnet-gw.sodex.dev wss://mainnet-gw.sodex.dev
          https://api.hyperliquid.xyz;
        form-action 'none';
      "
    />
  </head></html>`;
  assert.deepEqual(cspConnectSources(html), ['https://mainnet-gw.sodex.dev', 'wss://mainnet-gw.sodex.dev', 'https://api.hyperliquid.xyz']);
  assert.deepEqual(missingFromCsp(cspConnectSources(html)!, ['https://mainnet-gw.sodex.dev', 'https://api.arcus.xyz']), ['https://api.arcus.xyz']);
  assert.equal(cspConnectSources('<html><head></head></html>'), null);
  assert.equal(cspConnectSources('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'), null);
});

test('the real index.html lists every host stage B talks to', () => {
  const file = fileURLToPath(new URL('../../index.html', import.meta.url));
  if (!existsSync(file)) return;
  const allowed = cspConnectSources(readFileSync(file, 'utf8'));
  assert.ok(allowed && allowed.length > 5, 'apps/web/index.html has a connect-src list');
  const needed = [SODEX_GATEWAY, 'wss://mainnet-gw.sodex.dev', new URL(HL_INFO).origin, ...RPC_HOSTS.map((r) => new URL(r.url).origin)];
  assert.deepEqual(missingFromCsp(allowed, needed), []);
});

test('SoDEX\'s envelope: only code 0 is success', () => {
  assert.deepEqual(unwrapSodex({ code: 0, data: [1] }), { ok: true, data: [1] });
  const bad = unwrapSodex({ code: -1, error: 'internal server error' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.problem, /internal server error/);
  assert.equal(unwrapSodex('error code: 1015').ok, false);
});

test('market list: not empty, named, something trading', () => {
  assert.equal(judgeSymbols([{ name: 'BTC-USD', status: 'TRADING' }, { name: 'X', status: 'HALT' }], 'perps').detail, '2 perps markets, 1 trading');
  assert.equal(judgeSymbols([], 'spot').status, 'FAIL');
  assert.equal(judgeSymbols([{ name: 'X', status: 'HALT' }], 'spot').status, 'FAIL');
  assert.equal(judgeSymbols({}, 'spot').status, 'FAIL');
});

test('order book: best bid below best ask - REST and stream shapes, whatever the order of the levels', () => {
  assert.deepEqual(bestBidAsk({ bids: [['84466', '1'], ['84465', '2']], asks: [['84467', '1'], ['84468', '3']] }), { bid: 84466, ask: 84467, bids: 2, asks: 2 });
  assert.deepEqual(bestBidAsk({ b: [['1', '1'], ['2', '1']], a: [['4', '1'], ['3', '1']] }), { bid: 2, ask: 3, bids: 2, asks: 2 });
  assert.equal(judgeBook({ bids: [['84466', '1']], asks: [['84467', '1']] }, 'BTC-USD').status, 'PASS');
  assert.match(judgeBook({ bids: [['84468', '1']], asks: [['84467', '1']] }, 'BTC-USD').detail, /crossed book/);
  assert.match(judgeBook({ bids: [['84466', '1']], asks: [] }, 'BTC-USD').detail, /no bids or no asks/);
  assert.equal(judgeBook(null, 'BTC-USD').status, 'FAIL');
});

test('mark price: present, positive, near the book', () => {
  const rows = [{ symbol: 'BTC-USD', markPrice: '84400', indexPrice: '84390' }, { symbol: 'ETH-USD', markPrice: '0' }];
  assert.equal(judgeMark(rows, 'BTC-USD', 84410).status, 'PASS');
  assert.equal(judgeMark(rows, 'BTC-USD', 90000).status, 'WARN');
  assert.match(judgeMark(rows, 'ETH-USD', null).detail, /missing or not positive/);
  assert.match(judgeMark(rows, 'SOL-USD', null).detail, /no mark price for SOL-USD/);
  assert.equal(judgeMark([], 'BTC-USD', null).status, 'FAIL');
});

test('candles: continuous and current - a hole, a duplicate, a stale series and a broken candle are named', () => {
  const now = 1_790_000_000_000;
  const t0 = now - (now % 60_000);
  const k = (i: number, extra: Record<string, unknown> = {}) => ({ t: t0 - i * 60_000, o: '1', h: '2', l: '1', c: '1.5', ...extra });
  const newestFirst = [0, 1, 2, 3, 4].map((i) => k(i));
  assert.equal(judgeKlines(newestFirst, 60_000, now, 'BTC-USD').status, 'PASS');
  assert.equal(judgeKlines([...newestFirst].reverse(), 60_000, now, 'BTC-USD').status, 'PASS');
  assert.match(judgeKlines([k(0), k(1), k(3), k(4)], 60_000, now, 'BTC-USD').detail, /not continuous \(1 missing after/);
  assert.match(judgeKlines([k(0), k(1), k(1)], 60_000, now, 'BTC-USD').detail, /duplicate at/);
  assert.match(judgeKlines([5, 6, 7].map((i) => k(i)), 60_000, now, 'BTC-USD').detail, /newest candle is \d+ s old/);
  assert.match(judgeKlines([k(0), k(1, { l: '3' })], 60_000, now, 'BTC-USD').detail, /low above high/);
  assert.equal(judgeKlines([k(0)], 60_000, now, 'BTC-USD').status, 'FAIL');
  assert.equal(judgeKlines('nope', 60_000, now, 'BTC-USD').status, 'FAIL');
});

// --- the indexer's status -----------------------------------------------------------------------

const NOW = 1_790_972_501_573;
const lane = (o: Record<string, unknown> = {}) => ({ queued: 10, done: 100, failed: 0, spent: 100, lastError: null, current: null, byKind: {}, visible: {}, backoffMs: 0, ...o });
const status = (o: Record<string, unknown> = {}) => ({
  streams: { sodex: NOW - 3_600_000, hyperliquid: NOW - 3_600_000 },
  sockets: { sodex: NOW - 60_000, hyperliquid: NOW - 60_000 },
  lanes: { hl: lane(), sgw: lane(), strades: lane({ done: 0, queued: 0 }), sdata: lane() },
  venues: {},
  lastBuildAt: NOW - 60_000,
  lastBuildMs: 12_000,
  lastError: null,
  at: NOW - 10_000,
  ...o,
});

test('indexer: streams up and no failing lane', () => {
  const v = judgeIndexerStatus(status(), NOW);
  assert.equal(v.status, 'PASS', v.detail);
  assert.equal(v.detail, '2 of 2 streams up, 4 lanes, none failing');
  assert.ok(v.lines.some((l) => l.startsWith('stream sodex: up')));
});

test('indexer: no status, or an old one, means it is not running', () => {
  assert.match(judgeIndexerStatus(null, NOW).detail, /published no status/);
  assert.match(judgeIndexerStatus(status({ at: NOW - 600_000 }), NOW).detail, /600 s old - the indexer is not running/);
});

test('indexer: a stream that is down fails; one still subscribing (Lighter after a restart) is a warning', () => {
  const down = judgeIndexerStatus(status({ sockets: { sodex: NOW, hyperliquid: null } }), NOW);
  assert.equal(down.status, 'FAIL');
  assert.match(down.detail, /hyperliquid stream is down/);
  const subscribing = judgeIndexerStatus(status({ sockets: { sodex: NOW, lighter: null }, streams: { sodex: NOW, lighter: null }, venues: { lighter: { queued: 5, done: 211, failed: 0, lastError: null, subscribed: { confirmed: 130, markets: 221 } } } }), NOW);
  assert.equal(subscribing.status, 'WARN');
  assert.match(subscribing.detail, /lighter stream is still subscribing \(130 of 221 markets confirmed\)/);
});

test('indexer: a failing lane - nothing done, a high failure rate, or a long back-off; a few failures only warn', () => {
  assert.match(judgeIndexerStatus(status({ lanes: { hl: lane({ done: 0, failed: 3, lastError: 'HTTP 502' }) } }), NOW).detail, /lane hl: 3 failed and nothing done \(last error: HTTP 502\)/);
  assert.match(judgeIndexerStatus(status({ lanes: { hl: lane({ done: 10, failed: 9 }) } }), NOW).detail, /lane hl: 9 of 19 tasks failed/);
  assert.match(judgeIndexerStatus(status({ lanes: { sgw: lane({ backoffMs: 120_000, lastError: 'Request Timeout' }) } }), NOW).detail, /lane sgw is backing off for 120 s/);
  const few = judgeIndexerStatus(status({ venues: { arcus: { queued: 3490, done: 94, failed: 3, lastError: 'The operation was aborted due to timeout' } } }), NOW);
  assert.equal(few.status, 'WARN');
  assert.match(few.detail, /lane arcus: 3 failed of 97/);
  // One stray failure among hundreds is an upstream hiccup, not a failing lane.
  const stray = judgeIndexerStatus(status({ lanes: { sdata: lane({ done: 622, failed: 1, lastError: 'non-JSON response (HTTP 503)' }) } }), NOW);
  assert.equal(stray.status, 'PASS', stray.detail);
  assert.ok(stray.lines.some((l) => /lane sdata: done 622, failed 1/.test(l)), 'it is still in the log');
  // Backing off right now is worth a look even without a failure count.
  assert.equal(judgeIndexerStatus(status({ lanes: { hl: lane({ backoffMs: 15_000 }) } }), NOW).status, 'WARN');
  assert.equal(judgeIndexerStatus(status({ lanes: {} }), NOW).status, 'FAIL');
});

test('indexer: boards that stopped being rebuilt', () => {
  assert.equal(judgeIndexerStatus(status({ lastBuildAt: NOW - 20 * 60_000 }), NOW).status, 'WARN');
  assert.match(judgeIndexerStatus(status({ lastBuildAt: NOW - 3 * 3_600_000 }), NOW).detail, /boards were last rebuilt 3\.0 h ago/);
  assert.equal(judgeIndexerStatus(status({ lastBuildAt: 0 }), NOW).status, 'WARN');
  assert.match(judgeIndexerStatus(status({ lastError: 'SQLITE_BUSY' }), NOW).detail, /last build error: SQLITE_BUSY/);
});

// --- our own API ------------------------------------------------------------------------------

test('the hosted allow-list is read from the server\'s source text', () => {
  const src = `export const HOSTED_ROUTES: readonly HostedRoute[] = [
  { method: 'GET', url: '/api/health', cls: 'read' },
  // a comment
  { method: 'GET', url: '/api/vs/leaderboard', cls: 'read', upstreamWhen: ['q'] },
  { method: 'POST', url: '/api/points/auth/nonce', cls: 'auth' },
];
export const OTHER = [{ method: 'GET', url: '/not/this' }];`;
  assert.deepEqual(parseHostedRoutes(src), [{ method: 'GET', url: '/api/health' }, { method: 'GET', url: '/api/vs/leaderboard' }, { method: 'POST', url: '/api/points/auth/nonce' }]);
  assert.deepEqual(parseHostedRoutes('nothing here'), []);
});

test('the real hosted.ts gives a list, and every route in it has a check (or is reported)', () => {
  const file = fileURLToPath(new URL('../../../server/src/hosted.ts', import.meta.url));
  if (!existsSync(file)) return;
  const routes = parseHostedRoutes(readFileSync(file, 'utf8'));
  assert.ok(routes.length >= 10, `only ${routes.length} routes were read from hosted.ts`);
  assert.ok(routes.some((r) => r.url === '/api/health'));
  const { probes, unknown } = probesFor(routes, parseVenues(null));
  assert.ok(probes.length >= routes.length - unknown.length);
  // A route this guide has no check for is surfaced by stage B as a warning - make that visible here too.
  for (const r of unknown) assert.ok(r.method !== 'GET' || !FALLBACK_ROUTES.some((f) => f.url === r.url), `no probe for ${r.url}`);
});

test('venues with a board come from the server\'s types, else the five of 2026-10-02', () => {
  assert.deepEqual(parseVenues("export const VENUES: readonly Venue[] = ['sodex', 'hyperliquid', 'newvenue'];"), ['sodex', 'hyperliquid', 'newvenue']);
  assert.deepEqual(parseVenues(null), ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus']);
});

test('probes: one per route, a board per venue, and the routes that need an id run last', () => {
  const venues = ['sodex', 'hyperliquid'];
  const { probes, unknown } = probesFor([...FALLBACK_ROUTES, { method: 'GET', url: '/api/vs/new-thing' }, { method: 'POST', url: '/api/points/auth/nonce' }], venues);
  assert.deepEqual(unknown.map((r) => r.url), ['/api/vs/new-thing', '/api/points/auth/nonce']);
  const ids = probes.map((p) => p.id);
  assert.deepEqual(ids.slice(0, 4), ['health', 'leaderboard-sodex', 'leaderboard-hyperliquid', 'leaderboard-net']);
  const needy = ['cohorts-detail', 'cohorts-wallets', 'lbrow', 'feed-account', 'announcement'];
  assert.deepEqual(ids.slice(-needy.length).sort(), [...needy].sort());
  const ctx: ProbeContext = { venues };
  const byId = Object.fromEntries(probes.map((p) => [p.id, p]));
  assert.equal(byId['lbrow']!.path(ctx), null);
  assert.equal(byId['cohorts-detail']!.path(ctx), null);
  // What an earlier answer teaches a later probe.
  byId['leaderboard-hyperliquid']!.learn!({ ok: true, rows: [{ address: '0xabc' }] }, ctx);
  byId['leaderboard-sodex']!.learn!({ ok: true, rows: [{ address: '0xdef', accountId: 1225 }] }, ctx);
  byId['cohorts']!.learn!({ ok: true, cohorts: [{ id: 'whale' }] }, ctx);
  byId['announcements']!.learn!({ items: [{ id: 452 }] }, ctx);
  assert.equal(byId['lbrow']!.path(ctx), '/api/vs/lbrow?venue=hyperliquid&address=0xabc');
  assert.equal(byId['feed-account']!.path(ctx), '/api/feed/account?id=1225');
  assert.equal(byId['cohorts-detail']!.path(ctx), '/api/vs/cohorts/detail?cohort=whale&range=7d');
  assert.equal(byId['announcement']!.path(ctx), '/api/external/announcements/452?lang=en');
});

test('probe verdicts: a sane answer, an empty board, the routes\' own failure answer, a server error', () => {
  const [sodex] = leaderboardProbes(['sodex']);
  assert.deepEqual(sodex!.judge(200, { ok: true, rows: [{}, {}], total: 100 }), { status: 'PASS', detail: '2 board rows of 100' });
  assert.deepEqual(sodex!.judge(200, { ok: true, rows: [] }), { status: 'FAIL', detail: '0 board rows' });
  assert.match(sodex!.judge(200, { ok: false, code: 'not_available', error: 'The index is not running yet' }).detail, /ok:false \(not_available\): The index is not running yet/);
  assert.match(sodex!.judge(500, { error: 'internal error' }).detail, /HTTP 500: internal error/);
  assert.equal(sodex!.judge(200, 'html').status, 'FAIL');
  assert.equal(isNotReady('ok:false (upstream): SoDEX positioning is still being computed (12 of 200)'), true);
  assert.equal(isNotReady('HTTP 500'), false);

  const { probes } = probesFor(FALLBACK_ROUTES, ['sodex']);
  const byId = Object.fromEntries(probes.map((p) => [p.id, p]));
  assert.equal(byId['health']!.judge(200, { ok: true, network: 'mainnet', chainId: 286623, mainnetWritesAllowed: true }).status, 'PASS');
  assert.equal(byId['health']!.judge(200, { ok: true, network: 'testnet', chainId: 138565 }).status, 'WARN');
  assert.equal(byId['whales']!.judge(200, { ok: true, trades: [] }).status, 'WARN'); // a quiet minute
  assert.equal(byId['maintenance']!.judge(200, { reachable: true, maintenance: true, reason: 'upgrade' }).status, 'WARN');
  assert.equal(byId['maintenance']!.judge(200, { reachable: false, error: 'timeout' }).status, 'FAIL');
  assert.equal(byId['lbrow']!.judge(200, { ok: true, row: null }).status, 'FAIL');
  assert.equal(byId['lbrow']!.judge(200, { ok: true, row: { rank: 3 } }).status, 'PASS');
  assert.equal(byId['feed-account']!.judge(200, { ok: true, resolved: true, address: A, account_id: 1225 }).status, 'PASS');
  assert.equal(byId['feed-account']!.judge(200, { ok: true, resolved: false }).status, 'FAIL');
  assert.equal(byId['announcement']!.judge(200, { id: 452, title: 'x', text: 'y' }).status, 'PASS');
});
