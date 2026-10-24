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
 *     read API has no such boundary. The index is GET only. The one thing a
 *     visitor changes is their own knowledge folders (routes/folders.ts): POST
 *     routes that need the site's own Origin, exactly, and the wallet's token.
 *   - PER-CLIENT RATE LIMITS keyed by the address Fastify derives through
 *     `trustProxy`, which believes X-Forwarded-For ONLY from the configured
 *     proxy hops (VALUESCAN_TRUST_PROXY). IPv6 clients are grouped by /64.
 *   - CORS locked to the site origin(s), no WebSocket hub, a minimal
 *     /api/health and API security headers (index.ts).
 *   - AN ORIGIN SECRET, when configured: every request but /api/health must
 *     carry it, so nobody reaches the server around the edge. Two values are
 *     accepted for the length of a rotation (parseOriginSecrets).
 *   - DIAGNOSTICS STAY ON THE INSTANCE. The indexer's status is never public;
 *     a minimal health view of it answers a caller on this instance only
 *     (ON_INSTANCE_ROUTES, isOnInstanceRequest, indexerHealth).
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
 * `auth`     a sign-in: rare for a human - the knowledge folders' wallet
 *            sign-in (one signature per browser), and the SoPoints relay if it
 *            is ever listed again, whose every call is a request to a third
 *            party from this server's address - capped per client and overall.
 * `write`    a change to a wallet's own knowledge folders: counted per client
 *            here, per wallet in the route (routes/folders.ts), and only ever
 *            with the site's Origin.
 */
export type RateClass = 'read' | 'upstream' | 'auth' | 'write';

export interface HostedRoute {
  method: 'GET' | 'POST';
  /** The route pattern exactly as registered - what req.routeOptions.url reports. */
  url: string;
  cls: RateClass;
  /** Non-empty values of these query parameters move a GET into `upstream` as well. */
  upstreamWhen?: readonly string[];
}

/**
 * Everything a public server answers - final, per docs/ARCH-traffic.md §5.
 *
 * Every user's exchange traffic now leaves from that user's browser, so the
 * list is the index and a few answers that are about no user at all. Not
 * listed - so 404 in hosted mode - on purpose:
 *   - /ws, /api/md/*, /api/acct/*, /api/stats/*, /api/mirror/*, /api/onboarding,
 *     /api/wallet/*, /api/money/*, /api/deposit/*, /api/scan*: one user's
 *     exchange traffic, now browser-direct;
 *   - /api/vs/trader|fills|account|price, /api/external/leaderboard(/rank),
 *     /api/external/resolve-account: the web reads them itself (ARCH §1.2, §1.4);
 *   - /api/vs/index/status: the indexer's full diagnostics (wallet addresses,
 *     error text, a pid). A 404 for every caller, on the instance too - which is
 *     also how operations tell that hosted mode is in effect. Monitoring reads
 *     /api/vs/index/health instead: ON_INSTANCE_ROUTES below, not this list;
 *   - /api/points/* (the SoPoints relay: the page is not mounted; if it returns,
 *     list both routes as { method: 'POST', cls: 'auth' } - the gate then needs
 *     the exact site Origin and applies the `auth` caps);
 *   - every custodial route, which answers 410 before this list is consulted.
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
  // Aggregated server-side from the venues' trade streams - no one user's traffic.
  { method: 'GET', url: '/api/vs/whales', cls: 'read' },
  { method: 'GET', url: '/api/vs/positioning', cls: 'read' },
  // SoSoValue news. The process caches the page (valuescan/sosovalue/news.ts);
  // without SOSOVALUE_API_KEY the route answers not_available.
  { method: 'GET', url: '/api/vs/news', cls: 'read' },
  // The Live Feed's stream lookup: one cached read of a YouTube channel's /live
  // page per channel (valuescan/youtube/live.ts); upstream, since a new channel is a fetch.
  { method: 'GET', url: '/api/vs/live', cls: 'upstream' },
  // One Hyperliquid leaderboard row from the index (the Scan profile's rank):
  // a lookup in the file already in memory, never a per-address upstream call.
  { method: 'GET', url: '/api/vs/lbrow', cls: 'read' },
  // The builder fee a wallet owes, signed (routes/builder.ts, docs/BUILDER-TIERS.md §3). Asking is a
  // read of this server's own ledger and one signature. A hint is what later costs SoDEX reads from
  // this server's address, so a request that carries one counts as `upstream` too.
  { method: 'GET', url: '/api/vs/builder/terms', cls: 'read', upstreamWhen: ['hint'] },
  // Deep links by SoDEX account id: the index's leaderboard map, on-chain as a fallback.
  { method: 'GET', url: '/api/feed/account', cls: 'upstream' },
  // Global, not per-user (until the web reads alpha-biz directly).
  { method: 'GET', url: '/api/external/maintenance/status', cls: 'read' },
  { method: 'GET', url: '/api/external/announcements', cls: 'read' },
  { method: 'GET', url: '/api/external/announcements/:id', cls: 'upstream' },
  // Knowledge folders (routes/folders.ts): one wallet's own research, behind its token. The
  // sign-in is the only route without one; every POST needs the site's Origin as well.
  { method: 'POST', url: '/api/folders/session', cls: 'auth' },
  { method: 'GET', url: '/api/folders', cls: 'read' },
  { method: 'GET', url: '/api/folders/item', cls: 'read' },
  { method: 'GET', url: '/api/folders/file', cls: 'read' },
  { method: 'GET', url: '/api/folders/file/url', cls: 'read' },
  { method: 'POST', url: '/api/folders/folder/create', cls: 'write' },
  { method: 'POST', url: '/api/folders/folder/rename', cls: 'write' },
  { method: 'POST', url: '/api/folders/folder/delete', cls: 'write' },
  { method: 'POST', url: '/api/folders/folder/order', cls: 'write' },
  { method: 'POST', url: '/api/folders/item/create', cls: 'write' },
  { method: 'POST', url: '/api/folders/item/update', cls: 'write' },
  { method: 'POST', url: '/api/folders/item/move', cls: 'write' },
  { method: 'POST', url: '/api/folders/item/delete', cls: 'write' },
  { method: 'POST', url: '/api/folders/upload/start', cls: 'write' },
  { method: 'POST', url: '/api/folders/upload/put', cls: 'write' },
  { method: 'POST', url: '/api/folders/upload/finish', cls: 'write' },
  { method: 'POST', url: '/api/folders/erase', cls: 'write' },
];

/**
 * Answered ONLY to a caller on this instance (isOnInstanceRequest) - the health
 * check and an operator's curl - and never part of the public list above:
 * through the proxy these are a 404 like any unknown path, so the public
 * surface stays exactly HOSTED_ROUTES.
 *
 * Why not public: even a minimal health view tells an attacker, live, how the
 * indexer is coping with what they send. Why not the index file instead: a
 * monitor that opens the database needs write access to its directory (a WAL
 * reader writes the -shm file) and knowledge of the store's schema.
 *
 * No origin secret is asked of these: the caller is identified by where it
 * is, and a monitor should not have to hold the credential that gets past the
 * edge. The body is numbers and booleans only (indexerHealth), so a proxy that
 * relays without marking its requests leaks nothing that matters.
 */
export const ON_INSTANCE_ROUTES: readonly HostedRoute[] = [
  { method: 'GET', url: '/api/vs/index/health', cls: 'read' },
];

// --- configuration ---------------------------------------------------------------

export interface HostedLimits {
  /** Per client, every allowed request. */
  read: Limit;
  /** Per client, requests that can cost upstream calls. */
  upstream: Limit;
  /** Per client, `auth` routes (the folders' sign-in). */
  auth: Limit;
  /** All clients together, `auth` routes. */
  authGlobal: Limit;
  /** Per client, `write` routes (changes to knowledge folders). */
  write: Limit;
}

export interface HostedConfig {
  enabled: boolean;
  /** Passed to Fastify's `trustProxy`: false, a hop count, or proxy addresses/CIDRs. */
  trustProxy: false | number | string[];
  /**
   * The accepted values of ORIGIN_SECRET_HEADER. Empty: not enforced. Otherwise
   * every request but /api/health must carry ONE of them. One value in normal
   * operation, two while the secret is rotated (parseOriginSecrets).
   */
  originSecrets: readonly string[];
  limits: HostedLimits;
}

export const ORIGIN_SECRET_HEADER = 'x-origin-verify';
export const MIN_ORIGIN_SECRET_LENGTH = 32;
/** The current value and the next one, with room for a rotation that overlaps another. */
export const MAX_ORIGIN_SECRETS = 4;

const MINUTE = 60_000;
export const DEFAULT_LIMITS: HostedLimits = {
  read: { max: 600, windowMs: MINUTE },
  upstream: { max: 120, windowMs: MINUTE },
  auth: { max: 20, windowMs: MINUTE },
  authGlobal: { max: 300, windowMs: MINUTE },
  write: { max: 120, windowMs: MINUTE },
};

const OFF: HostedConfig = { enabled: false, trustProxy: false, originSecrets: [], limits: DEFAULT_LIMITS };

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
 * VALUESCAN_ORIGIN_SECRET -> the accepted secrets.
 *
 *   unset                 not enforced
 *   <secret>              the normal case
 *   <current>,<next>      while the secret is rotated: the server accepts both, so
 *                         it does not matter in which order - or how slowly - the
 *                         edge switches from one to the other. Remove the old value
 *                         once the edge sends the new one everywhere.
 *
 * Anything else stops the boot rather than weakening the gate: an empty entry
 * (a stray comma must never read as "no secret"), a value under 32 characters,
 * one that could not travel in a header (visible ASCII only; a comma separates),
 * or more than MAX_ORIGIN_SECRETS values (old ones are to be removed, not kept).
 * No message quotes a value: this text reaches the log.
 */
export function parseOriginSecrets(raw: string | undefined): string[] {
  const v = (raw ?? '').trim();
  if (!v) return [];
  const list = v.split(',').map((s) => s.trim());
  if (list.some((s) => !s)) throw new Error('VALUESCAN_ORIGIN_SECRET has an empty entry - remove the stray comma');
  if (list.some((s) => s.length < MIN_ORIGIN_SECRET_LENGTH)) {
    throw new Error(`VALUESCAN_ORIGIN_SECRET must be at least ${MIN_ORIGIN_SECRET_LENGTH} characters (each value, when several are listed)`);
  }
  if (list.some((s) => !/^[\x21-\x7e]+$/.test(s))) {
    throw new Error('VALUESCAN_ORIGIN_SECRET may only hold visible ASCII characters, without spaces (it travels in a header)');
  }
  const unique = [...new Set(list)];
  if (unique.length > MAX_ORIGIN_SECRETS) {
    throw new Error(`VALUESCAN_ORIGIN_SECRET lists more than ${MAX_ORIGIN_SECRETS} values - remove the ones no longer in use`);
  }
  return unique;
}

/**
 * The hosted configuration. With VALUESCAN_HOSTED unset nothing else is read,
 * so a stray or malformed hosted variable can never change local dev.
 */
export function hostedConfigFromEnv(env: Readonly<Record<string, string | undefined>>): HostedConfig {
  const get = (k: string): string => env[k]?.trim() ?? '';
  if (get('VALUESCAN_HOSTED') !== '1') return OFF;
  return {
    enabled: true,
    trustProxy: parseTrustProxy(get('VALUESCAN_TRUST_PROXY')),
    originSecrets: parseOriginSecrets(get('VALUESCAN_ORIGIN_SECRET')),
    limits: {
      read: perMinute('VALUESCAN_RATE_READ_PER_MIN', get('VALUESCAN_RATE_READ_PER_MIN'), DEFAULT_LIMITS.read),
      upstream: perMinute('VALUESCAN_RATE_UPSTREAM_PER_MIN', get('VALUESCAN_RATE_UPSTREAM_PER_MIN'), DEFAULT_LIMITS.upstream),
      auth: perMinute('VALUESCAN_RATE_AUTH_PER_MIN', get('VALUESCAN_RATE_AUTH_PER_MIN'), DEFAULT_LIMITS.auth),
      authGlobal: perMinute('VALUESCAN_RATE_AUTH_GLOBAL_PER_MIN', get('VALUESCAN_RATE_AUTH_GLOBAL_PER_MIN'), DEFAULT_LIMITS.authGlobal),
      write: perMinute('VALUESCAN_RATE_WRITE_PER_MIN', get('VALUESCAN_RATE_WRITE_PER_MIN'), DEFAULT_LIMITS.write),
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

// --- the origin secret -----------------------------------------------------------------

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

/** The accepted secrets as the gate compares them: hashed once, not per request. */
export const originSecretDigests = (secrets: readonly string[]): Buffer[] => secrets.map(sha256);

/**
 * Whether the presented header is one of the accepted secrets.
 *
 * Constant-time on purpose. Both sides are hashed, so their lengths do not
 * matter; each comparison is timingSafeEqual; and EVERY accepted value is
 * compared, match or not - no early exit that would tell a caller which entry
 * matched, or that the first one did not. The header must be exactly one
 * value: a client that holds the whole list sends one entry of it.
 */
export function originSecretAccepted(got: unknown, digests: readonly Buffer[]): boolean {
  if (typeof got !== 'string' || !got) return false;
  const presented = sha256(got);
  let ok = false;
  for (const d of digests) {
    const same = timingSafeEqual(presented, d);
    ok = ok || same;
  }
  return ok;
}

// --- a caller on this instance ---------------------------------------------------------

/** 127.0.0.0/8 or ::1 (an IPv4-mapped IPv6 address counts as its IPv4). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  let a = (addr ?? '').trim().toLowerCase();
  if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
  if (isIP(a) === 4) return a.startsWith('127.');
  return a === '::1' || a === '0:0:0:0:0:0:0:1';
}

/** A Host header that names this server by a loopback name: 127.x.x.x, localhost or [::1], any port. */
export function isLoopbackHost(host: unknown): boolean {
  if (typeof host !== 'string') return false;
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/.exec(host.trim().toLowerCase());
  if (!m) return false;
  const name = m[1]!;
  if (name === 'localhost') return true;
  return isLoopbackAddress(name.startsWith('[') ? name.slice(1, -1) : name);
}

/**
 * Headers a relaying proxy puts on what it forwards. Caddy's reverse_proxy
 * always sets the three X-Forwarded-* ones; CloudFront adds Via, X-Amz-Cf-Id
 * and X-Forwarded-For; the rest are other proxies' and CDNs' equivalents.
 */
const RELAY_HEADERS: ReadonlySet<string> = new Set([
  'forwarded', 'via', 'x-real-ip', 'x-client-ip', 'true-client-ip', 'cdn-loop',
  'x-amz-cf-id', 'x-amzn-trace-id', 'cf-connecting-ip', 'cf-ray', 'fastly-client-ip', 'x-envoy-external-address',
]);
const isRelayHeader = (name: string): boolean => name.startsWith('x-forwarded-') || name.startsWith('cloudfront-') || RELAY_HEADERS.has(name);

/**
 * Whether a request started on this instance: a process here that opened the
 * socket itself, not something a proxy passed on.
 *
 *   - the TCP peer is loopback. The SOCKET's address, never req.ip: that one is
 *     derived from X-Forwarded-For and is whatever the trusted hops say;
 *   - it carries no header a relaying proxy adds. In production every request
 *     from the internet arrives from Caddy on loopback, and Caddy marks each one;
 *   - it names the server by a loopback name. What Caddy forwards keeps the
 *     public Host.
 *
 * A proxy on the instance that relayed WITHOUT marking its requests would make
 * the whole internet look local. It would equally hand every client the same
 * rate-limit key (docs/deploy/SECURITY-HEADERS.md 2.3), and all this unlocks is
 * ON_INSTANCE_ROUTES, whose bodies are harmless by construction.
 */
export function isOnInstanceRequest(peer: string | undefined, headers: Readonly<Record<string, unknown>>): boolean {
  if (!isLoopbackAddress(peer)) return false;
  if (!isLoopbackHost(headers.host)) return false;
  return !Object.keys(headers).some((h) => isRelayHeader(h.toLowerCase()));
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
  if (route.cls === 'write') {
    return [
      { key: `read|${who}`, limit: limits.read },
      { key: `write|${who}`, limit: limits.write },
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
  /** Routes answered to a caller on this instance only (default ON_INSTANCE_ROUTES). */
  onInstance?: readonly HostedRoute[];
  limiter?: KeyedLimiter;
}

/**
 * Install the hosted gate: origin secret, allow-list, input shape, site
 * origin for state-changing routes, then the per-client limits. CORS preflights
 * pass through to @fastify/cors, which answers them for the site origins only.
 *
 * A request that started on this instance may also reach ON_INSTANCE_ROUTES,
 * without the origin secret. For every other caller those are a 403 without
 * the secret and a 404 with it - exactly what a path that does not exist gets.
 */
export function installHostedGate(app: FastifyInstance, o: GateOptions): KeyedLimiter {
  const limiter = o.limiter ?? new KeyedLimiter();
  const routes = o.routes ?? HOSTED_ROUTES;
  const onInstance = o.onInstance ?? ON_INSTANCE_ROUTES;
  const secrets = originSecretDigests(o.cfg.originSecrets);
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const pattern = req.routeOptions?.url;
    const local = isOnInstanceRequest(req.raw.socket?.remoteAddress, req.headers) ? hostedRoute(req.method, pattern, onInstance) : null;
    if (!local && secrets.length && pattern !== '/api/health' && !originSecretAccepted(req.headers[ORIGIN_SECRET_HEADER], secrets)) {
      return reply.code(403).send({ error: 'forbidden', source: 'server' });
    }
    const route = local ?? hostedRoute(req.method, pattern, routes);
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

// --- the indexer's health, for monitoring ------------------------------------------------

/** What /api/vs/index/health answers: numbers and booleans, nothing else. */
export interface IndexerHealth {
  /** When the indexer last published its status (ms since the epoch); it does so every 30 s. */
  at: number | null;
  /** venue -> its trade stream is connected. */
  streams: Record<string, boolean>;
  /** The event loop's worst delay: within the last minute, and since the indexer started. */
  loopLagMs: { lastMinute: number | null; sinceStart: number | null };
  /** lane -> its counts (a lane is one upstream budget's work queue). */
  lanes: Record<string, { queued: number | null; done: number | null; failed: number | null; backoffMs: number | null }>;
  /** When the boards were last built, and how long that took. Null: not yet. */
  lastBuildAt: number | null;
  lastBuildMs: number | null;
  /**
   * The indexer has recorded an error since it started (it keeps the last one,
   * so this stays true). The text stays in its own log.
   */
  errorSinceStart: boolean;
}

/** A venue or lane name. Never an address (0x...), a path or anything long. */
const HEALTH_NAME = /^[a-z][a-z0-9_]{0,23}$/;
const HEALTH_MAX_NAMES = 16;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const amount = (v: unknown): number | null => {
  const n = finite(v);
  return n === null ? null : Math.max(0, Math.round(n));
};
const stamp = (v: unknown): number | null => {
  const n = finite(v);
  return n !== null && n > 0 ? Math.round(n) : null;
};

function namedEntries(v: unknown): Array<[string, unknown]> {
  if (!isRecord(v)) return [];
  return Object.entries(v).filter(([k]) => HEALTH_NAME.test(k)).slice(0, HEALTH_MAX_NAMES);
}

/**
 * The indexer's status (the `indexer_status` row its worker publishes) reduced
 * to what monitoring needs: which streams are up, the loop lag, each lane's
 * counts, the last build.
 *
 * A PROJECTION, not a filter: every field is picked by name and rebuilt as a
 * number or a boolean, so nothing else can leave with it - not the wallet a
 * lane is working on, not an error's text (they name addresses and URLs), not
 * a pid, a path or a budget - whatever the indexer adds to its status later.
 * Null when there is no status to read.
 */
export function indexerHealth(status: unknown): IndexerHealth | null {
  if (!isRecord(status)) return null;
  // `sockets` is the live connection; an older indexer only published `streams`.
  const up = isRecord(status.sockets) ? status.sockets : status.streams;
  const lag = isRecord(status.loopLagMs) ? status.loopLagMs : {};
  const streams: IndexerHealth['streams'] = {};
  // The indexer publishes since-when a stream is up, or null while it is down.
  for (const [venue, v] of namedEntries(up)) streams[venue] = Boolean(v);
  const lanes: IndexerHealth['lanes'] = {};
  for (const [name, v] of namedEntries(status.lanes)) {
    const l = isRecord(v) ? v : {};
    lanes[name] = { queued: amount(l.queued), done: amount(l.done), failed: amount(l.failed), backoffMs: amount(l.backoffMs) };
  }
  return {
    at: stamp(status.at),
    streams,
    loopLagMs: { lastMinute: amount(lag.lastMinute), sinceStart: amount(lag.sinceStart) },
    lanes,
    lastBuildAt: stamp(status.lastBuildAt),
    lastBuildMs: amount(status.lastBuildMs),
    errorSinceStart: Boolean(status.lastError),
  };
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
