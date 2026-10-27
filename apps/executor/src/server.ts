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
import { normaliseCountry, type Logger } from '../../../packages/copy-engine/src/index.ts';
import type { ExecutorConfig } from './config.ts';
import { ApiError, type ExecutorService, type RequestContext } from './service.ts';

const BODY_LIMIT = 64 * 1024;
const PREFIX = '/api/copy/v1';

/** A fixed-window limiter per key. */
class Limiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private readonly perMinute: number) {}
  allow(key: string, now = Date.now()): boolean {
    let h = this.hits.get(key);
    if (!h || now >= h.reset) {
      h = { n: 0, reset: now + 60_000 };
      this.hits.set(key, h);
      if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (now >= v.reset) this.hits.delete(k);
    }
    return ++h.n <= this.perMinute;
  }
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

export function createExecutorServer(svc: ExecutorService, cfg: ExecutorConfig, log: Logger): Server {
  const reads = new Limiter(240);
  const writes = new Limiter(40);

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
    const url = new URL(req.url ?? '/', 'http://executor');
    const path = url.pathname;
    try {
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
      const client = clientOf(req);
      const isWrite = req.method === 'POST';
      if (!(isWrite ? writes : reads).allow(client)) throw new ApiError(429, 'rate', 'Too many requests; try again in a minute.');
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
      if (route === '/session') return send(res, 200, svc.session(body.request, ctx));
      if (route === '/terms') return send(res, 200, svc.acceptTerms(body.request, ctx));
      if (route === '/site-terms') return send(res, 200, svc.acceptSiteTerms(body.request, ctx));
      if (route === '/keys') return send(res, 200, svc.createKey(body.request, ctx));
      if (route === '/keys/verify') return send(res, 200, { key: await svc.verifyKey(svc.authenticate(bearer(req))) });
      if (route === '/keys/delete') return send(res, 200, await svc.deleteKey(body.request, ctx));
      if (route === '/copies') return send(res, 200, await svc.subscribe(body.request, ctx));
      if (route === '/copies/action') return send(res, 200, await svc.act(body.request, ctx));
      if (route === '/algos') return send(res, 200, await svc.algoStart(body.request, ctx));
      if (route === '/algos/action') return send(res, 200, await svc.algoAct(body.request, ctx));
      throw new ApiError(404, 'path', 'not found');
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, 'internal', 'Something went wrong in the executor.');
      if (!(e instanceof ApiError)) log.error('executor: request failed', { path, error: String(e) });
      send(res, err.status, { ok: false, code: err.code, error: err.message });
    } finally {
      if (path !== `${PREFIX}/health`) log.debug('request', { method: req.method, path, ms: Date.now() - t0, status: res.statusCode });
    }
  });
}
