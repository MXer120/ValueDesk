/**
 * HOSTED MODE - the public, read-only index API (VALUESCAN_HOSTED=1).
 *
 * Everything else in this server was built for one user on one machine: a
 * loopback bind, a token the Vite proxy injects, and routes that proxy that
 * user's own exchange traffic. None of that is safe on the internet. With the
 * web app talking to the exchanges directly (browser-direct - see
 * docs/ARCH-traffic.md), a public server only has to serve the index -
 * leaderboards, cohorts, screener, explore, the market map - and hosted mode
 * is exactly that and nothing more:
 *
 *   - ROUTE ALLOW-LIST. Only HOSTED_ROUTES answer; every other path is a 404,
 *     whatever plugin registered it. Matched on the route PATTERN the router
 *     chose (req.routeOptions.url), so percent-encoding cannot slip past it.
 *   - NO CUSTODY, WHATEVER THE ENV. Server signing and the .env key bootstrap
 *     are forced off (config.ts), the custodial route plugins are not even
 *     registered (index.ts), and their paths still answer 410.
 *   - NO LOCAL TOKEN. It keeps other processes on one machine out; a public
 *     read API has no such boundary. Every listed route is a GET today; a
 *     state-changing one, if ever listed, needs the site's own Origin, exactly.
 *   - PER-CLIENT RATE LIMITS keyed by the address Fastify derives through
 *     `trustProxy`, which believes X-Forwarded-For ONLY from the configured
 *     proxy hops (VALUESCAN_TRUST_PROXY). IPv6 clients are grouped by /64.
 *   - CORS locked to the site origin(s), no WebSocket hub, a minimal
 *     /api/health and API security headers (index.ts).
 *
 * Local dev is untouched while the switch is off: nothing here runs, and
 * hostedConfigFromEnv reads no other variable.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { KeyedLimiter, type Limit } from './rateLimit.js';
import { isSiteOrigin, normaliseOrigin } from './origin.js';

// --- the allow-list ------------------------------------------------------------

/**
 * `read`     cheap: answered from the index file or a shared cache.
 * `upstream` each new input can cost fresh upstream requests (a wallet, a coin,
 *            an account id), so it is limited much tighter - it is how one
 *            client could otherwise spend this server's exchange budgets and get
 *            its egress address rate-limited for everyone, indexer included.
 * `auth`     a sign-in relay (the SoPoints one, when listed): rare for a
 *            human, and every call is a request to a third party from this
 *            server's address - capped per client and overall.
 */
export type RateClass = 'read' | 'upstream' | 'auth';

export interface HostedRoute {
  method: 'GET' | 'POST';
  /** The route pattern exactly as registered - what req.routeOptions.url reports. */
  url: string;
  cls: RateClass;
  /** Non-empty values of these query parameters move a GET into `upstream` as well. */
  upstreamWhen?: readonly string[];
  /**
   * Set while the route is only on the list until docs/ARCH-traffic.md decides
   * whether the web still needs it from here: why it is kept for now.
   */
  provisional?: string;
}

const PROVISIONAL_DIRECT = 'per-user or per-address venue read; drop once the web reads it browser-direct';

/**
 * Everything a public server answers.
 *
 * PROVISIONAL LIST. The index routes (no `provisional`) are what a hosted
 * server exists for. The rest are here because the web app, as of 2026-09-30,
 * still calls them from pages that must work in production; each is to be
 * confirmed or removed against docs/ARCH-traffic.md once that inventory lands.
 * Not listed - so 404 in hosted mode - includes on purpose: /ws (the web goes
 * direct), /api/md/* /api/acct/* /api/scan* /api/stats/* /api/onboarding
 * /api/mirror/* /api/deposit/{assets,prepare,status,tx} (a user's own exchange
 * traffic, moving browser-direct), /api/vs/index/status (diagnostics), and every
 * custodial route (which answers 410 before this list is consulted).
 */
export const HOSTED_ROUTES: readonly HostedRoute[] = [
  { method: 'GET', url: '/api/health', cls: 'read' },
  // The index: leaderboards, cohorts, screener, explore, the market map.
  { method: 'GET', url: '/api/vs/leaderboard', cls: 'read', upstreamWhen: ['q'] },
  { method: 'GET', url: '/api/vs/explore', cls: 'read' },
  { method: 'GET', url: '/api/vs/cohorts', cls: 'read' },
  { method: 'GET', url: '/api/vs/cohorts/detail', cls: 'read' },
  { method: 'GET', url: '/api/vs/cohorts/map', cls: 'read' },
  { method: 'GET', url: '/api/vs/cohorts/focus', cls: 'read' },
  { method: 'GET', url: '/api/vs/cohorts/wallets', cls: 'read' },
  { method: 'GET', url: '/api/vs/screener', cls: 'read' },
  // Provisional - see above.
  { method: 'GET', url: '/api/vs/whales', cls: 'read', provisional: 'Explore tape, aggregated server-side from venue trade streams' },
  { method: 'GET', url: '/api/vs/positioning', cls: 'read', provisional: 'Explore positioning, aggregated server-side' },
  { method: 'GET', url: '/api/vs/price', cls: 'upstream', provisional: 'cohort asset price chart (Hyperliquid candles); could go browser-direct' },
  { method: 'GET', url: '/api/vs/trader', cls: 'upstream', provisional: PROVISIONAL_DIRECT },
  { method: 'GET', url: '/api/vs/fills', cls: 'upstream', provisional: PROVISIONAL_DIRECT },
  { method: 'GET', url: '/api/vs/account', cls: 'upstream', provisional: PROVISIONAL_DIRECT },
  { method: 'GET', url: '/api/external/maintenance/status', cls: 'read', provisional: 'maintenance banner; alpha-biz answers any origin, so it could go direct' },
  { method: 'GET', url: '/api/external/announcements', cls: 'read', provisional: 'maintenance page; could go direct' },
  { method: 'GET', url: '/api/external/announcements/:id', cls: 'upstream', provisional: 'maintenance page; could go direct' },
  { method: 'GET', url: '/api/external/leaderboard', cls: 'upstream', provisional: 'the SoDEX leaderboard panel' },
  { method: 'GET', url: '/api/external/leaderboard/rank', cls: 'upstream', provisional: PROVISIONAL_DIRECT },
  { method: 'GET', url: '/api/external/resolve-account', cls: 'upstream', provisional: 'account id -> wallet, verified on-chain' },
  { method: 'GET', url: '/api/feed/account', cls: 'upstream', provisional: 'deep links by SoDEX account id' },
  { method: 'GET', url: '/api/deposit/chain', cls: 'read', provisional: 'static ValueChain parameters; should be pinned in the web instead' },
  // NOT LISTED: POST /api/points/auth/{nonce,verify}, the SoPoints sign-in
  // relay. The points page is not mounted (web router.ts: points -> trade), so
  // hosted mode has no state-changing route at all. If it returns, add both as
  // { method: 'POST', cls: 'auth' }: the gate then requires the exact site
  // Origin and applies the per-client and overall `auth` caps.
];

// --- configuration ---------------------------------------------------------------

export interface HostedLimits {
  /** Per client, every allowed request. */
  read: Limit;
  /** Per client, requests that can cost upstream calls. */
  upstream: Limit;
  /** Per client, `auth` routes (none listed today). */
  auth: Limit;
  /** All clients together, `auth` routes. */
  authGlobal: Limit;
}

export interface HostedConfig {
  enabled: boolean;
  /** Passed to Fastify's `trustProxy`: false, a hop count, or proxy addresses/CIDRs. */
  trustProxy: false | number | string[];
  /** When set, every request but /api/health must carry it in ORIGIN_SECRET_HEADER. */
  originSecret: string | null;
  limits: HostedLimits;
}

export const ORIGIN_SECRET_HEADER = 'x-origin-verify';

const MINUTE = 60_000;
export const DEFAULT_LIMITS: HostedLimits = {
  read: { max: 600, windowMs: MINUTE },
  upstream: { max: 120, windowMs: MINUTE },
  auth: { max: 20, windowMs: MINUTE },
  authGlobal: { max: 300, windowMs: MINUTE },
};

const OFF: HostedConfig = { enabled: false, trustProxy: false, originSecret: null, limits: DEFAULT_LIMITS };

/**
 * VALUESCAN_TRUST_PROXY -> Fastify `trustProxy`.
 *
 *   unset, 0, false, off, none   use the socket address (no proxy believed)
 *   1..9                         trust that many proxy hops in front of this
 *                                process (CloudFront straight to the box: 1)
 *   a,b/24,loopback              trust X-Forwarded-For only when the peer is
 *                                one of these (Caddy on the same box: loopback)
 *
 * `true`, `*` and `all` are refused: believing X-Forwarded-For from anyone
 * lets every client choose its own rate-limit key.
 */
export function parseTrustProxy(raw: string | undefined): false | number | string[] {
  const v = (raw ?? '').trim();
  if (!v || /^(0|false|off|no|none)$/i.test(v)) return false;
  if (/^(true|\*|all|yes|on)$/i.test(v)) {
    throw new Error(
      'VALUESCAN_TRUST_PROXY must name the proxy (addresses/CIDRs, e.g. "loopback") or a hop count - trusting every peer lets clients forge their address',
    );
  }
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n < 1 || n > 9) throw new Error('VALUESCAN_TRUST_PROXY hop count must be 1..9');
    return n;
  }
  const list = v.split(',').map((s) => s.trim()).filter(Boolean);
  for (const item of list) {
    if (!isProxySpec(item)) throw new Error(`VALUESCAN_TRUST_PROXY: "${item}" is not an IP address, a CIDR or loopback/linklocal/uniquelocal`);
  }
  return list;
}

/**
 * The config as Fastify's `trustProxy` option takes it: a hop count becomes
 * "trust the first N addresses counted from the socket" (the socket peer is
 * hop 0), an address list the comma-separated form Fastify compiles itself.
 */
export function fastifyTrustProxy(tp: HostedConfig['trustProxy']): boolean | string | ((address: string, hop: number) => boolean) {
  if (tp === false) return false;
  if (typeof tp === 'number') return (_address: string, hop: number) => hop < tp;
  return tp.join(',');
}

function isProxySpec(s: string): boolean {
  if (s === 'loopback' || s === 'linklocal' || s === 'uniquelocal') return true;
  const slash = s.indexOf('/');
  if (slash < 0) return isIP(s) !== 0;
  const ip = s.slice(0, slash);
  const bits = s.slice(slash + 1);
  const fam = isIP(ip);
  if (!fam || !/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (fam === 4 ? 32 : 128);
}

function perMinute(name: string, raw: string, dflt: Limit): Limit {
  if (!raw) return dflt;
  if (!/^\d{1,7}$/.test(raw) || Number(raw) < 1) throw new Error(`${name} must be a positive whole number of requests per minute`);
  return { max: Number(raw), windowMs: MINUTE };
}

/**
 * The hosted configuration. With VALUESCAN_HOSTED unset nothing else is read,
 * so a stray or malformed hosted variable can never change local dev.
 */
export function hostedConfigFromEnv(env: Readonly<Record<string, string | undefined>>): HostedConfig {
  const get = (k: string): string => env[k]?.trim() ?? '';
  if (get('VALUESCAN_HOSTED') !== '1') return OFF;
  const secret = get('VALUESCAN_ORIGIN_SECRET');
  if (secret && secret.length < 32) throw new Error('VALUESCAN_ORIGIN_SECRET must be at least 32 characters');
  return {
    enabled: true,
    trustProxy: parseTrustProxy(get('VALUESCAN_TRUST_PROXY')),
    originSecret: secret || null,
    limits: {
      read: perMinute('VALUESCAN_RATE_READ_PER_MIN', get('VALUESCAN_RATE_READ_PER_MIN'), DEFAULT_LIMITS.read),
      upstream: perMinute('VALUESCAN_RATE_UPSTREAM_PER_MIN', get('VALUESCAN_RATE_UPSTREAM_PER_MIN'), DEFAULT_LIMITS.upstream),
      auth: perMinute('VALUESCAN_RATE_AUTH_PER_MIN', get('VALUESCAN_RATE_AUTH_PER_MIN'), DEFAULT_LIMITS.auth),
      authGlobal: perMinute('VALUESCAN_RATE_AUTH_GLOBAL_PER_MIN', get('VALUESCAN_RATE_AUTH_GLOBAL_PER_MIN'), DEFAULT_LIMITS.authGlobal),
    },
  };
}

/** The configured site origins, normalised; throws on anything that is not a bare http(s) origin. */
export function siteOriginsFrom(list: readonly string[]): string[] {
  return list.map((raw) => {
    const o = normaliseOrigin(raw);
    if (!o) throw new Error(`site origin "${raw}" is not an http(s) origin (scheme://host[:port], nothing after it)`);
    return o;
  });
}

// --- client identity ---------------------------------------------------------------

/**
 * The rate-limit key for a client address. IPv4 as is (an IPv4-mapped IPv6
 * address counts as its IPv4); IPv6 by /64, because one subscriber is normally
 * handed a whole /64 and could otherwise rotate through it address by address.
 */
export function clientKey(ip: string | undefined): string {
  let a = (ip ?? '').trim();
  if (!a) return 'unknown';
  if (/^::ffff:/i.test(a) && isIP(a.slice(7)) === 4) a = a.slice(7);
  if (isIP(a) === 6) return `${ipv6Prefix64(a)}::/64`;
  return a;
}

function ipv6Prefix64(addr: string): string {
  const zone = addr.indexOf('%');
  const a = zone >= 0 ? addr.slice(0, zone) : addr;
  const width = (parts: string[]) => parts.reduce((n, p) => n + (p.includes('.') ? 2 : 1), 0);
  let groups: string[];
  const gap = a.indexOf('::');
  if (gap >= 0) {
    const head = a.slice(0, gap) ? a.slice(0, gap).split(':') : [];
    const tail = a.slice(gap + 2) ? a.slice(gap + 2).split(':') : [];
    groups = [...head, ...Array<string>(Math.max(0, 8 - width(head) - width(tail))).fill('0'), ...tail];
  } else {
    groups = a.split(':');
  }
  return groups
    .slice(0, 4)
    .map((g) => (g.includes('.') ? '0' : (Number.parseInt(g, 16) || 0).toString(16)))
    .join(':');
}

function secretMatches(got: unknown, want: string): boolean {
  if (typeof got !== 'string' || !got) return false;
  // Hash both sides so the comparison is constant-time whatever the lengths.
  const a = createHash('sha256').update(got).digest();
  const b = createHash('sha256').update(want).digest();
  return timingSafeEqual(a, b);
}

// --- the gate ------------------------------------------------------------------------

export function hostedRoute(method: string, pattern: string | undefined, routes: readonly HostedRoute[] = HOSTED_ROUTES): HostedRoute | null {
  if (!pattern) return null;
  const m = method === 'HEAD' ? 'GET' : method;
  return routes.find((r) => r.method === m && r.url === pattern) ?? null;
}

/** The rate-limit buckets one request is counted in. */
export function limitsFor(
  route: HostedRoute,
  query: unknown,
  limits: HostedLimits,
  who: string,
): Array<{ key: string; limit: Limit }> {
  if (route.cls === 'auth') {
    return [
      { key: `auth|${who}`, limit: limits.auth },
      { key: 'auth|*', limit: limits.authGlobal },
    ];
  }
  const q = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>;
  const upstream = route.cls === 'upstream' || (route.upstreamWhen ?? []).some((k) => typeof q[k] === 'string' && (q[k] as string).trim() !== '');
  return [
    { key: `read|${who}`, limit: limits.read },
    ...(upstream ? [{ key: `upstream|${who}`, limit: limits.upstream }] : []),
  ];
}

const repeatedParam = (query: unknown): string | null => {
  if (!query || typeof query !== 'object') return null;
  for (const [k, v] of Object.entries(query as Record<string, unknown>)) if (Array.isArray(v)) return k;
  return null;
};

export interface GateOptions {
  cfg: HostedConfig;
  /** Normalised site origins (siteOriginsFrom). */
  site: readonly string[];
  routes?: readonly HostedRoute[];
  limiter?: KeyedLimiter;
}

/**
 * Install the hosted gate: origin secret, allow-list, input shape, site
 * origin for state-changing routes, then the per-client limits. CORS preflights
 * pass through to @fastify/cors, which answers them for the site origins only.
 */
export function installHostedGate(app: FastifyInstance, o: GateOptions): KeyedLimiter {
  const limiter = o.limiter ?? new KeyedLimiter();
  const routes = o.routes ?? HOSTED_ROUTES;
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const pattern = req.routeOptions?.url;
    if (o.cfg.originSecret && pattern !== '/api/health' && !secretMatches(req.headers[ORIGIN_SECRET_HEADER], o.cfg.originSecret)) {
      return reply.code(403).send({ error: 'forbidden', source: 'server' });
    }
    const route = hostedRoute(req.method, pattern, routes);
    if (!route) return reply.code(404).send({ error: 'not found', source: 'server' });
    const repeated = repeatedParam(req.query);
    if (repeated) return reply.code(400).send({ error: `query parameter "${repeated}" is repeated`, source: 'validation' });
    if (route.method === 'POST' && !isSiteOrigin(req.headers.origin, o.site)) {
      return reply.code(403).send({ error: 'origin not allowed', source: 'server' });
    }
    for (const { key, limit } of limitsFor(route, req.query, o.cfg.limits, clientKey(req.ip))) {
      const wait = limiter.take(key, limit);
      if (wait !== null) {
        reply.header('Retry-After', String(wait));
        return reply.code(429).send({ error: `too many requests - wait ${wait}s`, source: 'server' });
      }
    }
  });
  return limiter;
}

// --- custodial routes ------------------------------------------------------------------

/**
 * Custodial routes: this process minting, holding or using a trading key
 * (config.ts, SERVER_SIGNING). Trading happens in the browser now; with server
 * signing off - the default, and always in hosted mode - these answer 410 and
 * say where it went, so a server can never hold a key that trades or moves
 * funds.
 */
export const SERVER_SIGNING_PATHS: readonly RegExp[] = [
  /^\/api\/session(\/|$)/,
  /^\/api\/wallet\/(enable|permissions|apikey)(\/|$)/,
  /^\/api\/trade\//,
  /^\/api\/money\/(elevat|transfer\/|withdraw)/,
];

export const isServerSigningPath = (path: string): boolean => SERVER_SIGNING_PATHS.some((re) => re.test(path));

/**
 * Whether a request reaches a custodial route. BOTH the raw path and the route
 * pattern the router matched are checked: the router matches the
 * percent-DECODED path, so `/api/%73ession/import` reaches the handler for
 * `/api/session/import` while its raw URL matches no pattern above. That is
 * exactly how the 410 used to be bypassed.
 */
export function isServerSigningRequest(rawUrl: string, routePattern: string | undefined): boolean {
  return isServerSigningPath(rawUrl.split('?')[0] ?? '') || (routePattern !== undefined && isServerSigningPath(routePattern));
}

export function installServerSigningGate(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!isServerSigningRequest(req.url, req.routeOptions?.url)) return;
    return reply.code(410).send({
      error: 'This server does not hold trading keys. Trading keys are created and used in your browser.',
      source: 'server',
      hint: 'Enable trading in the app. VALUETRADE_SERVER_SIGNING=1 turns server-side signing back on for a local, single-user setup only.',
    });
  });
}

// --- response headers --------------------------------------------------------------------

/**
 * Added to every API response in hosted mode, on top of the headers every mode
 * sends (index.ts). JSON only ever: nothing may frame it, run in it or load
 * from it, and a browser that has seen it over HTTPS keeps using HTTPS.
 */
export const HOSTED_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
