/**
 * Stage B: read-only live checks. No key exists in the process at this point,
 * nothing is signed, and every request passes readonly.ts's policy first -
 * which never lets a SoDEX history read (`/trades`, `/orders/history`) out.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkStop, logWriter, type Ctx } from './context';
import { isNotReady, parseHostedRoutes, parseVenues, probesFor, FALLBACK_ROUTES, type ProbeContext, type RouteDef } from './ownApi';
import { childEnv } from './proc';
import { confirm } from './prompt';
import {
  ARCUS_API,
  HL_INFO,
  LIGHTER_API,
  RPC_HOSTS,
  SODEX_BIZ,
  SODEX_DATA,
  SODEX_GATEWAY,
  SODEX_WS,
  VALUECHAIN_EXPLORER,
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
  type Verdict,
} from './readonly';
import { STAGE_TITLES, stageStatus, type Item, type StageResult } from './types';
import { fmtDur } from './ui';

interface Got {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
  ms: number;
}

interface NetRecord {
  at: string;
  method: string;
  url: string;
  status: number | null;
  ms: number;
  error?: string;
}

/** A verdict, optionally "not run" (with the reason in `detail`). */
type Outcome = Verdict | { status: 'SKIPPED'; detail: string };

const SIGNED_HEADERS = ['content-type', 'x-api-key', 'x-api-sign', 'x-api-nonce', 'x-api-chain'];

export async function runStageB(ctx: Ctx): Promise<StageResult> {
  const { out, args } = ctx;
  const startedAt = new Date(ctx.now()).toISOString();
  const t0 = ctx.now();
  const origin = args.siteOrigin;
  const backend = args.backend;
  const items: Item[] = [];
  ctx.shared.partial = items;
  const net: NetRecord[] = [];
  const notes: string[] = [];

  /** The one way a request leaves in this stage. */
  const call = async (method: string, url: string, o: { headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<Got> => {
    const refused = readOnlyProblem(method, url, o.body ?? null, { backend });
    if (refused) throw new Error(`not sent - the read-only policy refuses it: ${refused}`);
    const started = ctx.now();
    const rec: NetRecord = { at: new Date(started).toISOString(), method, url, status: null, ms: 0 };
    net.push(rec);
    try {
      const res = await ctx.fetch(url, { method, headers: o.headers, body: o.body, signal: AbortSignal.timeout(o.timeoutMs ?? 20_000), redirect: 'manual' });
      const text = method === 'HEAD' ? '' : await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      rec.status = res.status;
      rec.ms = ctx.now() - started;
      return { status: res.status, headers: res.headers, text, json, ms: rec.ms };
    } catch (e) {
      rec.ms = ctx.now() - started;
      const err = e as Error & { cause?: { code?: string; message?: string } };
      rec.error = err.name === 'TimeoutError' ? `no answer within ${fmtDur(o.timeoutMs ?? 20_000)}` : `${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`;
      throw new Error(rec.error);
    }
  };
  const browser = (extra: Record<string, string> = {}): Record<string, string> => ({ Origin: origin, Accept: 'application/json', ...extra });

  let group = '';
  const startGroup = (name: string): void => {
    group = name;
    out.line();
    out.line(` ${name}`);
  };
  const check = async (id: string, title: string, fn: () => Promise<Outcome>): Promise<Outcome> => {
    checkStop(ctx);
    const started = ctx.now();
    out.live(`  ...     ${title}`);
    let v: Outcome;
    try {
      v = await fn();
    } catch (e) {
      v = { status: 'FAIL', detail: (e as Error).message };
    }
    const ms = ctx.now() - started;
    items.push({ id, group, title, status: v.status, ms, detail: v.detail });
    out.result(v.status, title, v.detail, ms);
    return v;
  };
  /** CORS on a JSON answer: the host must let a page on our site read it. */
  const withCors = (g: Got, v: Verdict): Verdict => {
    const c = judgeCors(g.headers.get('access-control-allow-origin'), origin);
    if (!c.ok) return { status: 'FAIL', detail: `${v.detail}; browser calls: ${c.how}` };
    return { status: v.status, detail: `${v.detail}; browser calls allowed (${c.how})` };
  };

  out.say('Live checks that only read: the exchanges, their market data, and our own API. No key is in memory at this point and nothing is signed. SoDEX\'s account-history routes are never called here (they allow about four requests a minute).');
  out.line(` The browser-call checks send Origin: ${origin}`);

  // --- 1. the exchange hosts ------------------------------------------------------------------
  startGroup('Exchange hosts answer and let the browser call them');
  let perpsSymbols: unknown[] = [];
  let spotSymbols: unknown[] = [];
  await check('gw-rest', 'SoDEX gateway (REST)', async () => {
    const g = await call('GET', `${SODEX_GATEWAY}/api/v1/perps/markets/symbols`, { headers: browser() });
    if (g.status !== 200) return { status: 'FAIL', detail: `HTTP ${g.status}` };
    const u = unwrapSodex(g.json);
    if (!u.ok) return { status: 'FAIL', detail: u.problem };
    perpsSymbols = Array.isArray(u.data) ? u.data : [];
    const left = g.headers.get('x-ratelimit-remaining');
    const lim = g.headers.get('x-ratelimit-limit');
    return withCors(g, { status: 'PASS', detail: `answers${left && lim ? `, rate limit left ${left} of ${lim}` : ''}` });
  });
  await check('gw-preflight', 'SoDEX gateway: signed orders from a browser', async () => {
    const paths: Array<[string, string]> = [['POST', '/api/v1/perps/trade/orders'], ['DELETE', '/api/v1/perps/trade/orders'], ['POST', '/api/v1/spot/trade/orders/batch'], ['POST', '/api/v1/perps/exchange']];
    const bad: string[] = [];
    for (const [m, p] of paths) {
      // A preflight (OPTIONS) is what the browser sends BEFORE a write: it asks permission and changes nothing.
      const g = await call('OPTIONS', `${SODEX_GATEWAY}${p}`, { headers: { Origin: origin, 'Access-Control-Request-Method': m, 'Access-Control-Request-Headers': SIGNED_HEADERS.join(',') } });
      const j = judgePreflight({ allowOrigin: g.headers.get('access-control-allow-origin'), allowMethods: g.headers.get('access-control-allow-methods'), allowHeaders: g.headers.get('access-control-allow-headers') }, origin, m, SIGNED_HEADERS);
      if (g.status >= 400 || !j.ok) bad.push(`${m} ${p}: ${g.status >= 400 ? `HTTP ${g.status}` : j.how}`);
    }
    return bad.length ? { status: 'FAIL', detail: `the browser would be refused: ${bad.join('; ')}` } : { status: 'PASS', detail: `preflight allows ${paths.length} signed routes with the X-API-* headers (nothing was sent to them)` };
  });
  await check('data-host', 'SoDEX data host (leaderboard, charts)', async () => {
    const g = await call('GET', `${SODEX_DATA}/api/v1/leaderboard?window_type=30D&sort_by=pnl&sort_order=desc&page=1&page_size=10`, { headers: browser() });
    if (g.status !== 200) return { status: 'FAIL', detail: `HTTP ${g.status}` };
    const u = unwrapSodex(g.json);
    if (!u.ok) return { status: 'FAIL', detail: u.problem };
    const rows = (u.data as { items?: unknown[] } | null)?.items;
    if (!Array.isArray(rows) || !rows.length) return { status: 'FAIL', detail: 'the leaderboard page is empty' };
    return withCors(g, { status: 'PASS', detail: `${rows.length} leaderboard rows` });
  });
  await check('biz-host', 'sodex.com API (maintenance, deposits)', async () => {
    const g = await call('GET', `${SODEX_BIZ}/biz/v1/ext-chain/maintenance?coin=USDC&lang=en&address=0x0000000000000000000000000000000000000001&env=mainnet`, { headers: browser() });
    if (g.status !== 200) return { status: 'FAIL', detail: `HTTP ${g.status}` };
    const u = unwrapSodex(g.json);
    if (!u.ok) return { status: 'FAIL', detail: u.problem };
    const n = Array.isArray(u.data) ? u.data.length : 0;
    return withCors(g, { status: n ? 'WARN' : 'PASS', detail: n ? `SoDEX lists ${n} maintenance notice(s) for USDC` : 'no maintenance notice for USDC' });
  });
  await check('hyperliquid', 'Hyperliquid info', async () => {
    const pre = await call('OPTIONS', HL_INFO, { headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    const pj = judgePreflight({ allowOrigin: pre.headers.get('access-control-allow-origin'), allowMethods: pre.headers.get('access-control-allow-methods'), allowHeaders: pre.headers.get('access-control-allow-headers') }, origin, 'POST', ['content-type']);
    // `/info` is a query API: the POST carries the question and changes nothing.
    const g = await call('POST', HL_INFO, { headers: browser({ 'content-type': 'application/json' }), body: JSON.stringify({ type: 'meta' }) });
    if (g.status !== 200) return { status: 'FAIL', detail: `HTTP ${g.status}` };
    const uni = (g.json as { universe?: unknown[] } | null)?.universe;
    if (!Array.isArray(uni) || !uni.length) return { status: 'FAIL', detail: 'meta has no markets' };
    const mids = await call('POST', HL_INFO, { headers: browser({ 'content-type': 'application/json' }), body: JSON.stringify({ type: 'allMids' }) });
    const btc = Number((mids.json as Record<string, unknown> | null)?.BTC);
    if (!(btc > 0)) return { status: 'FAIL', detail: 'allMids has no BTC price' };
    if (!pj.ok) return { status: 'FAIL', detail: `${uni.length} markets; browser calls: ${pj.how}` };
    return withCors(g, { status: 'PASS', detail: `${uni.length} markets, BTC ${btc}` });
  });
  await check('lighter', 'Lighter public API', async () => {
    const g = await call('GET', `${LIGHTER_API}/api/v1/orderBooks`, { headers: browser() });
    if (g.status !== 200) return { status: 'FAIL', detail: `HTTP ${g.status}` };
    const books = (g.json as { order_books?: unknown[] } | null)?.order_books;
    if (!Array.isArray(books) || !books.length) return { status: 'FAIL', detail: 'no order books listed' };
    return withCors(g, { status: 'PASS', detail: `${books.length} markets` });
  });
  await check('arcus', 'Arcus public API', async () => {
    const g = await call('GET', `${ARCUS_API}/v1/markets`, { headers: browser() });
    if (g.status !== 200) return { status: 'FAIL', detail: `HTTP ${g.status}` };
    const markets = (g.json as { markets?: unknown[] } | null)?.markets;
    if (!Array.isArray(markets) || !markets.length) return { status: 'FAIL', detail: 'no markets listed' };
    return withCors(g, { status: 'PASS', detail: `${markets.length} markets` });
  });
  for (const rpc of RPC_HOSTS) {
    await check(`rpc-${rpc.chainId}`, `${rpc.name} RPC`, async () => {
      // eth_chainId only reads.
      const g = await call('POST', rpc.url, { headers: browser({ 'content-type': 'application/json' }), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if (g.status !== 200) return { status: 'FAIL', detail: `HTTP ${g.status}` };
      const id = Number.parseInt(String((g.json as { result?: unknown } | null)?.result ?? ''), 16);
      if (id !== rpc.chainId) return { status: 'FAIL', detail: `chain id ${Number.isFinite(id) ? id : 'unreadable'}, expected ${rpc.chainId}` };
      return withCors(g, { status: 'PASS', detail: `chain ${id}` });
    });
  }
  await check('explorer', 'ValueChain explorer API', async () => {
    const g = await call('GET', `${VALUECHAIN_EXPLORER}/api/v2/stats`, { headers: browser() });
    if (g.status !== 200 || !g.json) return { status: 'FAIL', detail: `HTTP ${g.status}` };
    return withCors(g, { status: 'PASS', detail: 'answers' });
  });
  await check('csp', 'the app\'s CSP allows every host above', async () => {
    let html: string;
    try {
      html = readFileSync(join(ctx.paths.web, 'index.html'), 'utf8');
    } catch {
      return { status: 'SKIPPED', detail: 'apps/web/index.html could not be read' };
    }
    const allowed = cspConnectSources(html);
    if (!allowed || !allowed.length) return { status: 'FAIL', detail: 'index.html has no Content-Security-Policy with a connect-src list' };
    const needed = [SODEX_GATEWAY, SODEX_WS, SODEX_DATA, SODEX_BIZ, new URL(HL_INFO).origin, LIGHTER_API, ARCUS_API, VALUECHAIN_EXPLORER, ...RPC_HOSTS.map((r) => new URL(r.url).origin)];
    const missing = missingFromCsp(allowed, needed);
    return missing.length ? { status: 'FAIL', detail: `not in connect-src (the browser would block it): ${missing.join(', ')}` } : { status: 'PASS', detail: `${needed.length} hosts checked, all listed (${allowed.length} origins in connect-src)` };
  });

  // --- 2. SoDEX market data -------------------------------------------------------------------
  startGroup('SoDEX market data (mainnet)');
  const firstTrading = (list: unknown[], prefer: string): string => {
    const names = list.map((s) => s as { name?: unknown; status?: unknown }).filter((s) => typeof s.name === 'string' && s.status === 'TRADING').map((s) => s.name as string);
    return names.includes(prefer) ? prefer : names[0] ?? prefer;
  };
  await check('md-symbols-perps', 'perps market list', async () => judgeSymbols(perpsSymbols, 'perps'));
  await check('md-symbols-spot', 'spot market list', async () => {
    const g = await call('GET', `${SODEX_GATEWAY}/api/v1/spot/markets/symbols`, { headers: browser() });
    const u = unwrapSodex(g.json);
    if (g.status !== 200 || !u.ok) return { status: 'FAIL', detail: u.ok ? `HTTP ${g.status}` : u.problem };
    spotSymbols = Array.isArray(u.data) ? u.data : [];
    return judgeSymbols(spotSymbols, 'spot');
  });
  const perp = firstTrading(perpsSymbols, 'BTC-USD');
  const spot = firstTrading(spotSymbols, 'WSOSO_vUSDC');
  let perpMid: number | null = null;
  for (const [engine, symbol] of [['perps', perp], ['spot', spot]] as const) {
    await check(`md-book-${engine}`, `${engine} order book ${symbol}`, async () => {
      const g = await call('GET', `${SODEX_GATEWAY}/api/v1/${engine}/markets/${encodeURIComponent(symbol)}/orderbook?limit=20`, { headers: browser() });
      const u = unwrapSodex(g.json);
      if (g.status !== 200 || !u.ok) return { status: 'FAIL', detail: u.ok ? `HTTP ${g.status}` : u.problem };
      const b = bestBidAsk(u.data);
      if (engine === 'perps' && b) perpMid = (b.bid + b.ask) / 2;
      return judgeBook(u.data, symbol);
    });
  }
  await check('md-mark', `mark price ${perp}`, async () => {
    const g = await call('GET', `${SODEX_GATEWAY}/api/v1/perps/markets/mark-prices`, { headers: browser() });
    const u = unwrapSodex(g.json);
    if (g.status !== 200 || !u.ok) return { status: 'FAIL', detail: u.ok ? `HTTP ${g.status}` : u.problem };
    return judgeMark(u.data, perp, perpMid);
  });
  for (const [engine, symbol] of [['perps', perp], ['spot', spot]] as const) {
    await check(`md-klines-${engine}`, `${engine} candles ${symbol} (1m)`, async () => {
      const g = await call('GET', `${SODEX_GATEWAY}/api/v1/${engine}/markets/${encodeURIComponent(symbol)}/klines?interval=1m&limit=30`, { headers: browser() });
      const u = unwrapSodex(g.json);
      if (g.status !== 200 || !u.ok) return { status: 'FAIL', detail: u.ok ? `HTTP ${g.status}` : u.problem };
      return judgeKlines(u.data, 60_000, ctx.now(), symbol);
    });
  }
  for (const [engine, symbol] of [['perps', perp], ['spot', spot]] as const) {
    await check(`md-ws-${engine}`, `${engine} stream ${symbol} (WebSocket)`, () => wsCheck(ctx, engine, symbol));
  }

  // --- 3. our own API --------------------------------------------------------------------------
  startGroup(`Our own API (${backend})`);
  let apiUp = false;
  await check('api-health', '/api/health', async () => {
    const g = await call('GET', `${backend}/api/health`, { timeoutMs: 8000 });
    const o = g.json as { ok?: unknown; network?: unknown; chainId?: unknown; mainnetWritesAllowed?: unknown } | null;
    if (g.status !== 200 || !o || o.ok !== true) return { status: 'FAIL', detail: `HTTP ${g.status} - is the dev server running? (npm run dev in the repository folder)` };
    apiUp = true;
    if (!/\bno-store\b/.test(g.headers.get('cache-control') ?? '')) return { status: 'FAIL', detail: `health is cacheable (Cache-Control: ${g.headers.get('cache-control') ?? 'none'})` };
    if (o.network !== 'mainnet') return { status: 'WARN', detail: `the server runs on ${String(o.network)}, not mainnet` };
    return { status: 'PASS', detail: `ok, mainnet, chain ${String(o.chainId)}, app mainnet writes ${o.mainnetWritesAllowed === true ? 'allowed' : 'OFF (the app will not trade)'}, not cacheable` };
  });
  if (!apiUp) {
    notes.push(`The dev server did not answer on ${backend}: start it (npm run dev) and run stage B again.`);
  } else {
    let routes: RouteDef[] = [];
    let venues: string[] = [];
    try {
      routes = parseHostedRoutes(readFileSync(join(ctx.paths.repo, 'apps', 'server', 'src', 'hosted.ts'), 'utf8'));
    } catch {
      routes = [];
    }
    try {
      venues = parseVenues(readFileSync(join(ctx.paths.repo, 'apps', 'server', 'src', 'valuedesk', 'types.ts'), 'utf8'));
    } catch {
      venues = parseVenues(null);
    }
    if (!routes.length) {
      routes = [...FALLBACK_ROUTES];
      notes.push('apps/server/src/hosted.ts could not be read: the route list of 2026-10-02 was used.');
    }
    const { probes, unknown } = probesFor(routes.filter((r) => r.url !== '/api/health'), venues);
    const pctx: ProbeContext = { venues };
    for (const p of probes) {
      await check(`api-${p.id}`, p.title, async () => {
        const path = p.path(pctx);
        if (!path) return { status: 'SKIPPED', detail: `needs ${p.needs ?? 'an earlier answer'}, which did not come` };
        let last: Verdict = { status: 'FAIL', detail: 'no answer' };
        for (let attempt = 0; attempt < (p.retryIfNotReady ? 4 : 1); attempt++) {
          if (attempt) await ctx.sleep(5000);
          const g = await call('GET', `${backend}${path}`, { timeoutMs: 60_000 });
          last = p.judge(g.status, g.json);
          if (last.status !== 'FAIL') {
            p.learn?.(g.json, pctx);
            break;
          }
          if (!isNotReady(last.detail)) break;
        }
        return last;
      });
    }
    for (const r of unknown) {
      await check(`api-unknown-${r.url}`, `${r.method} ${r.url}`, async () => ({ status: 'WARN', detail: 'this route is in the hosted allow-list but the guide has no check for it yet (add one in e2e/guide/ownApi.ts)' }));
    }
    await check('api-bad-input', 'a bad request is refused politely', async () => {
      const g = await call('GET', `${backend}/api/vs/leaderboard?venue=not-a-venue`);
      return g.status === 400 ? { status: 'PASS', detail: 'HTTP 400 with a reason, not a server error' } : { status: 'FAIL', detail: `HTTP ${g.status} for an unknown venue (expected 400)` };
    });
    const big = `${backend}/api/vs/cohorts/map`;
    await check('api-compression', 'compression (brotli, gzip)', async () => {
      const seen: string[] = [];
      for (const enc of ['br', 'gzip', 'identity']) {
        const g = await call('GET', big, { headers: { 'Accept-Encoding': enc }, timeoutMs: 60_000 });
        if (g.status !== 200) return { status: 'FAIL', detail: `HTTP ${g.status} with Accept-Encoding: ${enc}` };
        const got = g.headers.get('content-encoding') ?? 'none';
        if (enc === 'identity' ? got !== 'none' : got !== enc) return { status: 'FAIL', detail: `asked for ${enc}, the answer was encoded as ${got} (${g.text.length} bytes of JSON)` };
        if (!/accept-encoding/i.test(g.headers.get('vary') ?? '')) return { status: 'FAIL', detail: 'the answer has no "Vary: Accept-Encoding"' };
        seen.push(`${enc}${g.headers.get('content-length') ? ` ${g.headers.get('content-length')} B` : ''}`);
      }
      return { status: 'PASS', detail: `the same answer as ${seen.join(', ')}` };
    });
    await check('api-etag', 'ETag and 304 Not Modified', async () => {
      const board = `${backend}/api/vs/leaderboard?venue=hyperliquid&window=30d&limit=5`;
      let why = '';
      // The boards are rebuilt about once a minute: an ETag can change between two requests. Try a few times.
      for (let attempt = 0; attempt < 4; attempt++) {
        const a = await call('GET', board);
        const etag = a.headers.get('etag');
        if (a.status !== 200) return { status: 'FAIL', detail: `HTTP ${a.status}` };
        if (!etag) return { status: 'FAIL', detail: 'the answer has no ETag' };
        const cc = a.headers.get('cache-control') ?? '';
        if (!/max-age=\d+/.test(cc) && !/no-cache/.test(cc)) return { status: 'FAIL', detail: `an index answer with Cache-Control: ${cc || 'none'}` };
        const b = await call('GET', board, { headers: { 'If-None-Match': etag } });
        if (b.status === 304) {
          if (b.text.length) return { status: 'FAIL', detail: 'a 304 answer carried a body' };
          const c = await call('GET', board, { headers: { 'If-None-Match': 'W/"something-else"' } });
          if (c.status !== 200) return { status: 'FAIL', detail: `another ETag was answered ${c.status}, expected 200` };
          return { status: 'PASS', detail: `unchanged answers cost a 304 and no body (Cache-Control: ${cc})` };
        }
        why = `HTTP ${b.status} for If-None-Match (the ETag changed to ${b.headers.get('etag') ?? 'none'})`;
        await ctx.sleep(1500);
      }
      return { status: 'FAIL', detail: why };
    });
    await check('api-indexer', 'indexer status (streams and lanes)', async () => {
      // A local diagnostics route (not served by a public server).
      const g = await call('GET', `${backend}/api/vs/index/status`);
      if (g.status !== 200) return { status: 'FAIL', detail: `HTTP ${g.status}` };
      const v = judgeIndexerStatus((g.json as { status?: unknown } | null)?.status, ctx.now());
      const log = logWriter(ctx, 'B-indexer-status.log');
      for (const l of v.lines) log.write(l);
      return { status: v.status, detail: v.detail };
    });
  }

  // --- 4. the production smoke test ------------------------------------------------------------
  startGroup('Production smoke test (deploy/smoke)');
  const smoke = join(ctx.paths.repo, 'deploy', 'smoke', 'smoke.mjs');
  let smokeExists = false;
  try {
    readFileSync(smoke, 'utf8');
    smokeExists = true;
  } catch {
    smokeExists = false;
  }
  if (!smokeExists) {
    await check('smoke', 'production smoke test', async () => ({ status: 'SKIPPED', detail: 'deploy/smoke/smoke.mjs is not in this checkout' }));
  } else if (args.smoke === 'no') {
    await check('smoke', 'production smoke test', async () => ({ status: 'SKIPPED', detail: 'switched off with --no-smoke' }));
  } else {
    out.say('It builds the web app for production, serves it with the production security headers and walks every page in a hidden Chrome. In this mode nothing leaves the computer and the dev servers are not touched (it uses ports 4280, 4289 and 8890). It takes a few minutes.', '   ');
    const go = args.smoke === 'yes' || (await confirm(ctx.ask, 'Run the production smoke test now?', true));
    if (!go) await check('smoke', 'production smoke test', async () => ({ status: 'SKIPPED', detail: 'not run - you answered no' }));
    else await check('smoke', 'production smoke test', () => runSmoke(ctx, smoke));
  }

  // The requests of this stage, for the record (no bodies, no secrets: there were none to send).
  try {
    mkdirSync(ctx.paths.logsDir, { recursive: true });
    writeFileSync(join(ctx.paths.logsDir, 'B-requests.json'), JSON.stringify(net, null, 2), 'utf8');
  } catch {
    /* the record is a convenience */
  }

  const status = stageStatus(items);
  const count = (s: Item['status']): number => items.filter((x) => x.status === s).length;
  out.line();
  out.line(` Stage B: ${status} - ${count('PASS')} passed, ${count('WARN')} warnings, ${count('FAIL')} failed, ${count('SKIPPED')} skipped, in ${fmtDur(ctx.now() - t0)} (${net.length} requests, none of them a write).`);
  return { id: 'B', title: STAGE_TITLES.B, status, startedAt, ms: ctx.now() - t0, items, notes, ...(count('FAIL') ? { reason: `${count('FAIL')} check${count('FAIL') === 1 ? '' : 's'} failed` } : {}) };
}

/** One SoDEX market stream: a book snapshot with bid < ask, then a trade or ticker push. */
async function wsCheck(ctx: Ctx, engine: 'perps' | 'spot', symbol: string): Promise<Outcome> {
  const url = `${SODEX_WS}/ws/${engine}`;
  const refused = wsProblem(url);
  if (refused) return { status: 'FAIL', detail: refused };
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) return { status: 'SKIPPED', detail: 'this Node has no built-in WebSocket (Node 22 or newer has)' };
  const OPEN_MS = 10_000;
  const BOOK_MS = 10_000;
  const PUSH_MS = 25_000;
  return new Promise<Outcome>((resolve) => {
    const t0 = ctx.now();
    let opened: number | null = null;
    let book: { at: number; verdict: Verdict } | null = null;
    let push: { at: number; kind: string } | null = null;
    let done = false;
    const ws = new WS(url);
    const finish = (v: Outcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(tick);
      try {
        ws.close(1000, 'done');
      } catch {
        /* already closed */
      }
      resolve(v);
    };
    const verdict = (): Outcome | null => {
      const now = ctx.now();
      if (opened === null) return now - t0 > OPEN_MS ? { status: 'FAIL', detail: `the socket did not open within ${fmtDur(OPEN_MS)}` } : null;
      if (!book) return now - opened > BOOK_MS ? { status: 'FAIL', detail: `no order-book snapshot within ${fmtDur(BOOK_MS)} of subscribing` } : null;
      if (book.verdict.status === 'FAIL') return book.verdict;
      if (!push) return now - opened > PUSH_MS ? { status: 'FAIL', detail: `the book came, but no trade or ticker push within ${fmtDur(PUSH_MS)}` } : null;
      return { status: 'PASS', detail: `open in ${fmtDur(opened - t0)}, book snapshot after ${fmtDur(book.at - opened)} (${book.verdict.detail.replace(`${symbol}: `, '')}), first ${push.kind} push after ${fmtDur(push.at - opened)}` };
    };
    const tick = setInterval(() => {
      const v = verdict();
      if (v) finish(v);
    }, 250);
    const timer = setTimeout(() => finish(verdict() ?? { status: 'FAIL', detail: 'timed out' }), OPEN_MS + PUSH_MS + 2000);
    const send = (msg: unknown): void => {
      const bad = wsMessageProblem(msg);
      if (bad) return finish({ status: 'FAIL', detail: `the guide refused to send a socket message: ${bad}` });
      ws.send(JSON.stringify(msg));
    };
    ws.onopen = () => {
      opened = ctx.now();
      send({ op: 'subscribe', params: { channel: 'l2Book', symbol } });
      send({ op: 'subscribe', params: { channel: 'trade', symbols: [symbol] } });
      send({ op: 'subscribe', params: { channel: 'ticker', symbols: [symbol] } });
    };
    ws.onmessage = (ev: MessageEvent) => {
      let m: { op?: unknown; success?: unknown; error?: unknown; channel?: unknown; type?: unknown; data?: unknown };
      try {
        m = JSON.parse(String(ev.data)) as typeof m;
      } catch {
        return;
      }
      if (m.op && m.success === false) return finish({ status: 'FAIL', detail: `the gateway refused a subscription: ${String(m.error ?? 'no reason')}` });
      if (m.channel === 'l2Book' && !book) book = { at: ctx.now(), verdict: judgeBook(m.data, symbol) };
      else if ((m.channel === 'trade' || (m.channel === 'ticker' && m.type === 'update')) && !push) push = { at: ctx.now(), kind: String(m.channel) };
    };
    ws.onerror = () => {
      if (opened === null) finish({ status: 'FAIL', detail: 'the socket could not be opened' });
    };
    ws.onclose = () => {
      if (!done) finish(verdict() ?? { status: 'FAIL', detail: 'the gateway closed the socket early' });
    };
  });
}

/** deploy/smoke/smoke.mjs in its "nothing leaves this machine" mode. */
async function runSmoke(ctx: Ctx, script: string): Promise<Outcome> {
  const log = logWriter(ctx, 'B-smoke.log');
  const lines: string[] = [];
  // Its own defaults for ports and output (deploy/.out/smoke, ignored by git); the mode in which nothing leaves this machine.
  const argv = [script, '--api=spawn', '--no-index', '--server-egress=deny', '--offline'];
  log.write(`$ node ${argv.join(' ')}`);
  const r = await ctx.run(ctx.tools.node, argv, {
    cwd: ctx.paths.repo,
    env: childEnv(ctx.env),
    timeoutMs: 25 * 60_000,
    onStart: (c) => {
      ctx.children.add(c);
      c.once('close', () => ctx.children.delete(c));
    },
    onLine: (l) => {
      lines.push(l);
      log.write(l);
      if (l.trim()) ctx.out.live(`  ...     smoke: ${l.trim()}`);
    },
  });
  if (r.startError) return { status: 'FAIL', detail: `could not start it: ${r.startError}` };
  if (r.timedOut) return { status: 'FAIL', detail: 'timed out after 25 minutes' };
  const results = lines.filter((l) => /^\s{2}\S.*\b(PASS|FAIL)\b/.test(l));
  const failed = results.filter((l) => /\bFAIL\b/.test(l)).map((l) => l.trim().replace(/\s+/g, ' '));
  if (r.code === 0) return { status: 'PASS', detail: `${results.length} checks passed (build audit, hosted gate, every page, the SharedWorker)` };
  if (r.code === 2) {
    const why = [...lines].reverse().find((l) => /^smoke: |\[smoke\] failed:/.test(l))?.replace(/^smoke: /, '') ?? 'it could not start';
    // A busy port or a missing browser is this computer's state, not a finding about the product.
    if (/port \d+ is in use|Chrome was not found|Chrome did not start/.test(lines.join('\n'))) return { status: 'SKIPPED', detail: `could not run here: ${why}` };
    return { status: 'FAIL', detail: why };
  }
  return { status: 'FAIL', detail: `${failed.length} of ${results.length} checks failed: ${failed.slice(0, 4).join('; ')}` };
}
