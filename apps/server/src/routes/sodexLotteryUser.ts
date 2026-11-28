/**
 * SoDEX's Blind Box, the signed-in half, relayed (owner 2026-11-28: "blind box page says SoDEX's sign-in only opens on
 * sodex.com so far ... we fixed that for sopoints too so fix, so users can see their boxes, open & merge them").
 *
 * WHY A RELAY. mainnet-lottery.sodex.dev sends no CORS headers, so a browser on our site cannot read its answers. The
 * wallet's SoDEX token (the SoPoints sign-in, routes/pointsAuth.ts) is passed through as the user's browser sent it.
 *
 *   GET  /api/vs/sodex/lottery/u/<read>          boxes, pfps, progress, treasures, history, ledger, jobs, job/<id>,
 *                                                draw/entries, box/sign-params?action=open|merge
 *   POST /api/vs/sodex/lottery/u/box/open        {tokenIds, nonce, deadline, signature}
 *   POST /api/vs/sodex/lottery/u/box/merge       {tokenIds, nonce, deadline, signature}
 *   POST /api/vs/sodex/lottery/u/treasure/open   {count, source?|campaignId?}   (claims earned boxes into the wallet)
 *
 * WHY NO FUNDS ARE AT RISK.
 * - An open or a merge only runs with the wallet's own EIP-712 signature over SoDEX's typed request
 *   (SoDEXTreasureBox v1, chain 286623: RequestOpen / RequestMerge (owner, tokenIds, nonce, deadline)), made in the
 *   user's wallet in the browser. It names the owner, so it can only open or merge that owner's boxes, and the rewards
 *   go to that owner's SoDEX account. The nonce is single-use and the deadline about an hour.
 * - The token reads the programme and starts those requests; it cannot move funds or sign anything.
 * - Strict allow-list: the paths above, the query keys each needs, the body fields each needs, checked by shape; any
 *   other field is dropped, not passed.
 * - Nothing is kept: no token, address, signature or answer is stored or logged (the request log carries the method
 *   and path only, never headers or bodies). No Origin or other header is set beyond Accept, Content-Type and the
 *   user's own Authorization.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientKey } from '../hosted.js';
import { KeyedLimiter, type Limit } from '../rateLimit.js';

const DEFAULT_API = 'https://mainnet-lottery.sodex.dev/api/v1/lottery';
const TIMEOUT_MS = 15_000;
const MINUTE = 60_000;
/** A JWT-like bearer: three base64url parts. Anything else is refused before SoDEX sees it. */
const BEARER = /^Bearer ([A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,1024})$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const UINT = /^[0-9]{1,78}$/;
/** SoDEX's own cap on one request is 30 (meta.rules.limits.maxBoxOpen); the contract takes 256. */
export const MAX_IDS = 256;

export const LOTTERY_USER_LIMITS: { read: Limit; write: Limit } = {
  read: { max: 120, windowMs: MINUTE },
  write: { max: 20, windowMs: MINUTE },
};

/** The reads, and the query keys each may carry (values checked by shape). */
const READS: Record<string, readonly string[]> = {
  boxes: ['limit', 'offset', 'level'],
  pfps: ['limit', 'offset'],
  progress: [],
  treasures: [],
  history: ['limit', 'offset'],
  ledger: ['limit', 'offset', 'type'],
  jobs: ['limit', 'offset', 'status'],
  'draw/entries': [],
  'box/sign-params': ['action'],
};
const QUERY_VALUE: Record<string, RegExp> = {
  limit: /^[0-9]{1,3}$/,
  offset: /^[0-9]{1,7}$/,
  level: /^(Common|Uncommon|Rare|SuperRare)$/,
  type: /^(treasure|transfer|merge|pfp_transfer|milestone)$/,
  status: /^[a-z_]{1,24}$/,
  action: /^(open|merge)$/,
};

/** The read's path and query as SoDEX takes them, or null when anything is off the list. */
export function readPath(path: string, query: Record<string, unknown>): string | null {
  const job = /^job\/([0-9A-Za-z_-]{1,80})$/.exec(path);
  const keys = job ? [] : READS[path];
  if (!keys) return null;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (!keys.includes(k)) continue;
    if (typeof v !== 'string' || !QUERY_VALUE[k]!.test(v)) return null;
    q.set(k, v);
  }
  if (path === 'box/sign-params' && !q.has('action')) return null;
  const s = q.toString();
  return `/${path}${s ? `?${s}` : ''}`;
}

/** An open or merge request's body, rebuilt from its four fields; null when one is off. */
export function signedBody(b: unknown): { tokenIds: string[]; nonce: string; deadline: string; signature: string } | null {
  const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : typeof v === 'string' ? v : '');
  if (!Array.isArray(o.tokenIds) || o.tokenIds.length === 0 || o.tokenIds.length > MAX_IDS) return null;
  const ids = o.tokenIds.map(str);
  if (!ids.every((x) => UINT.test(x))) return null;
  const nonce = str(o.nonce);
  const deadline = str(o.deadline);
  if (!UINT.test(nonce) || !UINT.test(deadline)) return null;
  if (typeof o.signature !== 'string' || !SIGNATURE.test(o.signature)) return null;
  return { tokenIds: ids, nonce, deadline, signature: o.signature };
}

/** A claim of earned boxes: how many, and from which source or campaign. */
export function claimBody(b: unknown): { count: number; source?: string; campaignId?: string } | null {
  const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
  if (typeof o.count !== 'number' || !Number.isSafeInteger(o.count) || o.count < 1 || o.count > 1000) return null;
  const out: { count: number; source?: string; campaignId?: string } = { count: o.count };
  if (o.source !== undefined) { if (typeof o.source !== 'string' || !/^[a-z_]{1,32}$/.test(o.source)) return null; out.source = o.source; }
  if (o.campaignId !== undefined) { const c = String(o.campaignId); if (!/^[0-9A-Za-z_-]{1,64}$/.test(c)) return null; out.campaignId = c; }
  return out;
}

type Fetch = typeof fetch;

export function sodexLotteryUserRoutes(opts: { fetchImpl?: Fetch; now?: () => number; base?: string } = {}) {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const base = (opts.base ?? (process.env.SODEX_LOTTERY_API?.trim() || DEFAULT_API)).replace(/\/+$/, '');
  const limiter = new KeyedLimiter();

  return async function routes(app: FastifyInstance): Promise<void> {
    /** The checks every call shares: the limit, then the bearer. Answers the refusal itself, else gives the header. */
    const gate = (req: FastifyRequest, reply: FastifyReply, kind: 'read' | 'write'): string | null => {
      reply.header('Cache-Control', 'no-store');
      const wait = limiter.take(`lu${kind}|${clientKey(req.ip)}`, LOTTERY_USER_LIMITS[kind], now());
      if (wait) { void reply.header('Retry-After', String(wait)).code(429).send({ ok: false, error: `too many requests - wait ${wait}s` }); return null; }
      const auth = req.headers.authorization;
      if (typeof auth !== 'string' || !BEARER.test(auth)) { void reply.code(401).send({ code: 401, msg: 'Sign in to SoDEX first.' }); return null; }
      return auth;
    };

    /** One call to SoDEX, its envelope answered as it came (status kept); a fault is a 502 with no detail. */
    const pass = async (reply: FastifyReply, auth: string, path: string, body?: unknown) => {
      try {
        const r = await f(base + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Accept: 'application/json', Authorization: auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const text = await r.text();
        let json: unknown;
        try { json = JSON.parse(text); } catch { return reply.code(502).send({ code: -1, msg: `SoDEX answered ${r.status}` }); }
        /* SoDEX says "invalid token" with code -1 on a 200: the browser drops a dead token on a 401. */
        const msg = (json as { msg?: unknown })?.msg;
        const unauth = typeof msg === 'string' && /^unauthorized/i.test(msg);
        return reply.code(unauth ? 401 : r.status >= 500 ? 502 : r.status).send(unauth ? { code: 401, msg } : json);
      } catch (e) {
        return reply.code(502).send({ code: -1, msg: e instanceof Error && e.name === 'TimeoutError' ? 'SoDEX did not answer in time.' : 'SoDEX could not be reached.' });
      }
    };

    app.get('/api/vs/sodex/lottery/u/*', async (req, reply) => {
      const path = readPath(String((req.params as { '*'?: string })['*'] ?? ''), (req.query ?? {}) as Record<string, unknown>);
      if (!path) return reply.code(404).send({ code: 404, msg: 'not relayed' });
      const auth = gate(req, reply, 'read');
      if (!auth) return reply;
      return pass(reply, auth, path);
    });

    const signed = (what: 'open' | 'merge') => async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = gate(req, reply, 'write');
      if (!auth) return reply;
      const body = signedBody(req.body);
      if (!body) return reply.code(400).send({ code: 400, msg: 'tokenIds, nonce, deadline and the wallet\'s signature are required' });
      return pass(reply, auth, `/box/${what}`, body);
    };
    app.post('/api/vs/sodex/lottery/u/box/open', signed('open'));
    app.post('/api/vs/sodex/lottery/u/box/merge', signed('merge'));

    app.post('/api/vs/sodex/lottery/u/treasure/open', async (req, reply) => {
      const auth = gate(req, reply, 'write');
      if (!auth) return reply;
      const body = claimBody(req.body);
      if (!body) return reply.code(400).send({ code: 400, msg: 'count is required' });
      return pass(reply, auth, '/treasure/open', body);
    });
  };
}
