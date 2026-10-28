/**
 * The executor's HTTP API, on node:http (no framework: a self-hosted copier
 * should be one small file). Every path is under /api/copy/v1, so behind the
 * site's edge (Vercel /api/* -> Caddy -> here) and on a follower's own machine
 * the web app calls the same paths.
 *
 *   GET  /api/copy/v1/info                       what this executor is (public)
 *   GET  /api/copy/v1/health                     liveness (public)
 *   POST /api/copy/v1/session                    {request: session}          -> a read token
 *   POST /api/copy/v1/terms                      {request: accept-terms}
 *   POST /api/copy/v1/site-terms                 {request: accept-site-terms}  (hosted: ValueDesk's own terms, recorded)
 *   GET  /api/copy/v1/me                         Bearer                      -> terms, policy, key, copies
 *   POST /api/copy/v1/keys                       {request: create-key}       -> the key to register
 *   POST /api/copy/v1/keys/verify                Bearer                      -> registered?
 *   POST /api/copy/v1/keys/delete                {request: delete-key}
 *   POST /api/copy/v1/copies                     {request: subscribe}
 *   POST /api/copy/v1/copies/action              {request: update|pause|resume|stop|stop-all}
 *   GET  /api/copy/v1/copies/:id/activity        Bearer, ?limit=&before=
 *   GET  /api/copy/v1/consents                   Bearer                      -> the wallet's signed instructions
 *   GET  /api/copy/v1/algos                      Bearer                      -> the wallet's algo orders
 *   GET  /api/copy/v1/algos/:id/events           Bearer, ?limit=&before=
 *   POST /api/copy/v1/algos                      {request: algo-start}
 *   POST /api/copy/v1/algos/action               {request: algo-action}
 *
 * HOSTED behind the edge: requests must carry the origin secret (Caddy checks
 * it first; this is the second check), and the viewer's country and address
 * come from the edge's headers. SELF-HOSTED: loopback by default; the browser
 * calls it from the site's https page, which Chrome allows for loopback after
 * a Private Network Access preflight - answered here.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { copyRequestDigest, normaliseCountry, type Logger } from '../../../packages/copy-engine/src/index.ts';
import type { ExecutorConfig } from './config.ts';
import { ApiError, type ExecutorService, type RequestContext } from './service.ts';

const BODY_LIMIT = 64 * 1024;
const PREFIX = '/api/copy/v1';

/**
 * The rate-limit key of a client address: IPv4 as is (an IPv4-mapped IPv6 address
 * counts as its IPv4), IPv6 by its /64 - one subscriber is normally handed a whole
 * /64 and could otherwise take a fresh budget from every address in it (the API
 * does the same: apps/server/src/hosted.ts clientKey).
 */
export function rateKey(ip: string): string {
  let a = ip.trim().toLowerCase();
  if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
  if (isIP(a) !== 6) return a || 'unknown';
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const gap = a.indexOf('::');
  const width = (p: string[]) => p.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
  let groups: string[];
  if (gap >= 0) {
    const head = a.slice(0, gap) ? a.slice(0, gap).split(':') : [];
    const tail = a.slice(gap + 2) ? a.slice(gap + 2).split(':') : [];
    groups = [...head, ...Array<string>(Math.max(0, 8 - width(head) - width(tail))).fill('0'), ...tail];
  } else groups = a.split(':');
  return `${groups.slice(0, 4).map((g) => (g.includes('.') ? '0' : (Number.parseInt(g, 16) || 0).toString(16))).join(':')}::/64`;
}

/** What the limiter says: allowed; the first refusal of a key's window; a later one. */
export type Verdict = 'ok' | 'first-refusal' | 'refused';

/**
 * A fixed-window limiter per key, with bounded memory and bounded work. The keys
 * are chosen by whoever sends requests, so a flood of new ones must neither grow
 * the map without end nor make each request walk it: expired windows are swept at
 * most every few seconds, and at the cap the oldest window goes (that client just
 * starts a fresh one - failing open for one, never closed for everyone).
 */
export class Limiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private lastSweep = 0;
  constructor(
    private readonly perMinute: number,
    private readonly maxKeys = 50_000,
  ) {}
  check(key: string, now = Date.now()): Verdict {
    let h = this.hits.get(key);
    if (!h || now >= h.reset) {
      if (!h && this.hits.size >= this.maxKeys) {
        if (now - this.lastSweep >= 5_000) {
          this.lastSweep = now;
          for (const [k, v] of this.hits) if (now >= v.reset) this.hits.delete(k);
        }
        if (this.hits.size >= this.maxKeys) {
          const oldest = this.hits.keys().next().value;
          if (oldest !== undefined) this.hits.delete(oldest);
        }
      }
      h = { n: 0, reset: now + 60_000 };
      // Re-inserted, so the map's order stays "oldest window first".
      this.hits.delete(key);
      this.hits.set(key, h);
    }
    h.n++;
    if (h.n <= this.perMinute) return 'ok';
    return h.n === this.perMinute + 1 ? 'first-refusal' : 'refused';
  }
  allow(key: string, now = Date.now()): boolean {
    return this.check(key, now) === 'ok';
  }
  get size(): number {
    return this.hits.size;
  }
}

/**
 * Self-hosted: whether a request's Host header may reach the copier. A web page
 * on any site can make its own name resolve to 127.0.0.1 (DNS rebinding) and
 * then talk to a copier on loopback as if it were the same site; the Host
 * header still carries that name. Loopback names, IP literals and the names in
 * EXECUTOR_ALLOWED_HOSTS pass; every other name is refused.
 */
export function hostAllowed(host: string | undefined, allowed: readonly string[]): boolean {
  if (!host) return true; // no Host at all: not a browser
  let name = host.trim().toLowerCase();
  if (name.startsWith('[')) return /^\[[0-9a-f:.]+\](:\d+)?$/.test(name);
  name = name.replace(/:\d+$/, '').replace(/\.$/, '');
  if (isIP(name)) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  return allowed.includes(name);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > BODY_LIMIT) throw new ApiError(413, 'too-large', 'The request is too large.');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'json', 'The body is not JSON.');
  }
}

/** What the audit log keeps of a signed request: the action, the wallet, the digest it was signed over. */
function signedOf(r: unknown): { action: string | null; owner: string | null; digest: string | null } | null {
  if (!r || typeof r !== 'object') return null;
  const x = r as Record<string, unknown>;
  let digest: string | null = null;
  try {
    digest = copyRequestDigest(x as unknown as Parameters<typeof copyRequestDigest>[0]);
  } catch {
    digest = null;
  }
  return { action: typeof x.action === 'string' ? x.action.slice(0, 40) : null, owner: typeof x.owner === 'string' ? x.owner.toLowerCase().slice(0, 42) : null, digest };
}

/** An address cut to its network (IPv4 /24, IPv6 /48): enough to tell where a request came from, not who. */
export function ipPrefix(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::/48`;
  return 'unknown';
}

export function createExecutorServer(svc: ExecutorService, cfg: ExecutorConfig, log: Logger): Server {
  const reads = new Limiter(240);
  const writes = new Limiter(40);
  // Calls that read SoDEX for one wallet (is its key registered?): every follower's reads share this
  // server's one per-IP budget at SoDEX, so a signed-in wallet may not spend it - per wallet, and in all.
  const keyChecksPerWallet = new Limiter(12);
  const keyChecksAll = new Limiter(60, 1);
  const keyCheck = (owner: string): string => {
    if (!keyChecksPerWallet.allow(owner) || !keyChecksAll.allow('all')) throw new ApiError(429, 'rate', 'Too many key checks; try again in a minute.');
    return owner;
  };

  const clientOf = (req: IncomingMessage): string => {
    if (cfg.trustEdge) {
      const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const contextOf = (req: IncomingMessage): RequestContext => ({
    viewerCountry: cfg.trustEdge ? normaliseCountry(String(req.headers['x-viewer-country'] ?? '')) : null,
    pairingCode: typeof req.headers['x-pairing-code'] === 'string' ? req.headers['x-pairing-code'] : null,
  });

  const cors = (req: IncomingMessage, res: ServerResponse): void => {
    const origin = req.headers.origin;
    if (origin && cfg.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Pairing-Code');
      res.setHeader('Access-Control-Max-Age', '600');
      // Private Network Access: the site (public, https) may call this executor on loopback.
      if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
  };

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  };

  /** A log page's `limit` (1-1000, default 200) and `before` (a time); anything else is a 400. */
  const page = (url: URL): { limit: number; before?: number } => {
    const l = url.searchParams.get('limit');
    const b = url.searchParams.get('before');
    const limit = l === null ? 200 : Number(l);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ApiError(400, 'limit', 'limit must be a whole number from 1 to 1000.');
    if (b === null) return { limit };
    const before = Number(b);
    if (!Number.isSafeInteger(before) || before < 0) throw new ApiError(400, 'before', 'before must be a time in milliseconds.');
    return { limit, before };
  };

  const bearer = (req: IncomingMessage): string | null => {
    const h = req.headers.authorization;
    return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : null;
  };

  return createServer(async (req, res) => {
    const t0 = Date.now();
    // The signed request's action, wallet and digest, for the audit log (never its signature).
    let signed: { action: string | null; owner: string | null; digest: string | null } | null = null;
    // A request target new URL cannot read ("//[x]/..." is one) must be a 400, never a throw out of
    // this handler: an unhandled rejection stops the executor (main.ts), every wallet's copies with it.
    let url: URL | null;
    try {
      url = new URL(req.url ?? '/', 'http://executor');
    } catch {
      url = null;
    }
    const path = url ? url.pathname.slice(0, 512) : '(unreadable)';
    // A refusal by the rate limiter is recorded once per client and window, not once per request: a
    // flood of refused requests must not fill the audit log (and the disk) one row at a time.
    let quiet = false;
    try {
      if (!url) throw new ApiError(400, 'path', 'bad request');
      if (cfg.kind === 'self' && !hostAllowed(req.headers.host, cfg.allowedHosts ?? [])) {
        throw new ApiError(421, 'host', 'This copier answers only on its own address (127.0.0.1 or localhost). To reach it under another name, set EXECUTOR_ALLOWED_HOSTS.');
      }
      cors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (cfg.originSecrets.length && path !== `${PREFIX}/health`) {
        const v = String(req.headers['x-origin-verify'] ?? '');
        if (!cfg.originSecrets.some((s) => safeEqual(s, v))) throw new ApiError(403, 'origin', 'forbidden');
      }
      if (!path.startsWith(PREFIX)) throw new ApiError(404, 'path', 'not found');
      const client = rateKey(clientOf(req));
      const isWrite = req.method === 'POST';
      const verdict = (isWrite ? writes : reads).check(client);
      if (verdict !== 'ok') {
        quiet = verdict === 'refused';
        throw new ApiError(429, 'rate', 'Too many requests; try again in a minute.');
      }
      const ctx = contextOf(req);
      const route = path.slice(PREFIX.length);

      if (req.method === 'GET' && route === '/info') return send(res, 200, svc.info(ctx));
      if (req.method === 'GET' && route === '/health') return send(res, 200, svc.health());
      if (req.method === 'GET' && route === '/me') return send(res, 200, svc.me(svc.authenticate(bearer(req)), ctx));
      if (req.method === 'GET' && route === '/consents') return send(res, 200, { consents: svc.consents(svc.authenticate(bearer(req))) });
      if (req.method === 'GET' && route === '/algos') return send(res, 200, { algos: svc.algoList(svc.authenticate(bearer(req))) });
      const algoEv = /^\/algos\/([A-Za-z0-9_-]{1,40})\/events$/.exec(route);
      if (req.method === 'GET' && algoEv) {
        const owner = svc.authenticate(bearer(req));
        return send(res, 200, { events: await svc.algoEvents(owner, algoEv[1]!, page(url)) });
      }
      const act = /^\/copies\/([A-Za-z0-9_-]{1,40})\/activity$/.exec(route);
      if (req.method === 'GET' && act) {
        const owner = svc.authenticate(bearer(req));
        return send(res, 200, { entries: await svc.activity(owner, act[1]!, page(url)) });
      }
      if (!isWrite) throw new ApiError(404, 'path', 'not found');

      const body = (await readJson(req)) as { request?: unknown };
      signed = signedOf(body.request);
      if (route === '/session') return send(res, 200, svc.session(body.request, ctx));
      if (route === '/terms') return send(res, 200, svc.acceptTerms(body.request, ctx));
      if (route === '/site-terms') return send(res, 200, svc.acceptSiteTerms(body.request, ctx));
      if (route === '/keys') return send(res, 200, svc.createKey(body.request, ctx));
      if (route === '/keys/verify') return send(res, 200, { key: await svc.verifyKey(keyCheck(svc.authenticate(bearer(req)))) });
      if (route === '/keys/delete') return send(res, 200, await svc.deleteKey(body.request, ctx));
      if (route === '/copies') return send(res, 200, await svc.subscribe(body.request, ctx));
      if (route === '/copies/action') return send(res, 200, await svc.act(body.request, ctx));
      if (route === '/keys/import') return send(res, 200, { key: await svc.importKey(keyCheck(svc.authenticate(bearer(req))), body as { name?: unknown; envelope?: unknown }, ctx) });
      if (route === '/algos') return send(res, 200, await svc.algoStart(body.request, ctx));
      if (route === '/algos/action') return send(res, 200, await svc.algoAct(body.request, ctx));
      throw new ApiError(404, 'path', 'not found');
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, 'internal', 'Something went wrong in the executor.');
      if (!(e instanceof ApiError)) log.error('executor: request failed', { path, error: String(e) });
      send(res, err.status, { ok: false, code: err.code, error: err.message });
    } finally {
      if (path !== `${PREFIX}/health`) log.debug('request', { method: req.method, path, ms: Date.now() - t0, status: res.statusCode });
      // Every write, and every read that was refused, into the audit log: who asked for what, from where, and the answer.
      // (Never throws: while the executor starts, the service is not there yet - nothing to record then.)
      if (!quiet && (req.method === 'POST' || (res.statusCode >= 400 && res.statusCode !== 401 && res.statusCode !== 404))) {
        try {
          svc.audit({ method: req.method ?? '', path, status: res.statusCode, ms: Date.now() - t0, client: ipPrefix(clientOf(req)), country: cfg.trustEdge ? normaliseCountry(String(req.headers['x-viewer-country'] ?? '')) : null, request: signed });
        } catch {
          /* starting */
        }
      }
    }
  });
}
