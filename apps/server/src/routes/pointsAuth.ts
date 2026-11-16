/**
 * SoPoints sign-in, relayed (owner 2026-11-16: "do server relay if that works without putting user funds at risk at
 * all"). It replaces the 2026-11-05 "browser only" rule: SoDEX's auth host still answers no browser on our origin
 * (re-checked 2026-11-16), while alpha-biz.sodex.dev, where the points are read, already allows valuedesk.so.
 *
 * THE FLOW, as SoDEX's own points page runs it (read out of their bundle, 2026-11-16):
 *
 *     POST sodex.com/auth/v2/nonce   {address, type:'sign_in'}
 *            -> {data:{message, nonce, expiresIn:300}}
 *     personal_sign(message)                      <- the user's wallet, in the browser
 *     POST sodex.com/auth/v2/verify  {address, message, signature, type:'sign_in', autoSign:false}
 *            -> {data:{accessToken}}              <- a ~15 day SoDEX identity token
 *
 * WHY NO FUNDS ARE AT RISK.
 * - The wallet signs a plain text message, SoDEX's own: "Confirm wallet to reveal your SoDEX referral code. No
 *   blockchain transaction or gas fee will occur." The relay refuses any other text (SIGN_IN_TEXT), so it can never
 *   carry a signature over an order, a transfer or anything else.
 * - The token SoDEX returns reads points, referral lists and notifications. Every order, transfer and withdrawal on
 *   SoDEX needs an EIP-712 signature by the wallet or one of its API keys, which the token is not and which this
 *   process never sees.
 * - `type` is fixed to 'sign_in' and `autoSign` to false: a caller cannot turn this into a terms acceptance or a
 *   session that signs by itself.
 * - Nothing is kept: no token, address, message or signature is stored or logged. The answer carries only the token.
 * - No forged headers: the old version sent `Origin: https://sodex.com`; this one sends none, as any server client.
 *
 * Only these TWO calls pass here. The browser reads the points with the token straight from SoDEX, no relay.
 */
import type { FastifyInstance } from 'fastify';
import { clientKey } from '../hosted.js';
import { KeyedLimiter, type Limit } from '../rateLimit.js';

const SODEX_AUTH = (process.env.VALUESCAN_SODEX_AUTH?.trim() || 'https://sodex.com/auth/v2').replace(/\/+$/, '');
const SIGN_TYPE = 'sign_in';
/** SoDEX's sign-in text, exactly; the nonce line is checked separately. */
export const SIGN_IN_TEXT = /^Confirm wallet to reveal your SoDEX referral code\. No blockchain transaction or gas fee will occur\.\n\nURI: https:\/\/sodex\.com\nNonce: [A-Za-z0-9]{8,64}\n?$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const MINUTE = 60_000;
export const POINTS_AUTH_LIMITS: { nonce: Limit; verify: Limit } = {
  nonce: { max: 10, windowMs: MINUTE },
  verify: { max: 10, windowMs: MINUTE },
};

type Fetch = typeof fetch;

/** One call to SoDEX's auth host, with no Origin and no cookie. Never logs the body. */
async function ask(f: Fetch, path: string, body: unknown): Promise<{ status: number; json: { code?: unknown; message?: unknown; msg?: unknown; data?: Record<string, unknown> } | null }> {
  const res = await f(`${SODEX_AUTH}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  let json = null;
  try {
    json = (await res.json()) as never;
  } catch {
    /* the status says enough */
  }
  return { status: res.status, json };
}

const why = (j: { message?: unknown; msg?: unknown } | null, status: number): string => {
  const m = j && (typeof j.message === 'string' ? j.message : typeof j.msg === 'string' ? j.msg : '');
  return m ? String(m).slice(0, 160) : `SoDEX answered ${status}`;
};

export function pointsAuthRoutes(opts: { fetchImpl?: Fetch; now?: () => number } = {}) {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const limiter = new KeyedLimiter();
  return async function routes(app: FastifyInstance): Promise<void> {
    const slow = (key: string, limit: Limit, ip: string): number | null => limiter.take(`${key}|${clientKey(ip)}`, limit, now());

    /** Step 1: SoDEX's message to sign. */
    app.post('/api/vs/sodex-auth/nonce', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const wait = slow('pn', POINTS_AUTH_LIMITS.nonce, req.ip);
      if (wait) return reply.header('Retry-After', String(wait)).code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
      const b = (req.body ?? {}) as { address?: unknown };
      if (typeof b.address !== 'string' || !ADDRESS.test(b.address)) return reply.code(400).send({ ok: false, error: 'address is required' });
      try {
        const { status, json } = await ask(f, '/nonce', { address: b.address, type: SIGN_TYPE });
        const message = json?.code === 0 ? json.data?.message : undefined;
        if (typeof message !== 'string' || !SIGN_IN_TEXT.test(message)) return reply.code(502).send({ ok: false, error: json?.code === 0 ? 'SoDEX sent an unexpected message to sign; nothing was signed.' : why(json, status) });
        return reply.send({ ok: true, message });
      } catch {
        return reply.code(502).send({ ok: false, error: 'SoDEX sign-in did not answer.' });
      }
    });

    /** Step 2: the signed message, exchanged for SoDEX's token; the answer carries the token only. */
    app.post('/api/vs/sodex-auth/verify', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const wait = slow('pv', POINTS_AUTH_LIMITS.verify, req.ip);
      if (wait) return reply.header('Retry-After', String(wait)).code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
      const b = (req.body ?? {}) as { address?: unknown; message?: unknown; signature?: unknown };
      if (typeof b.address !== 'string' || !ADDRESS.test(b.address)) return reply.code(400).send({ ok: false, error: 'address is required' });
      if (typeof b.message !== 'string' || !SIGN_IN_TEXT.test(b.message)) return reply.code(400).send({ ok: false, error: 'only SoDEX\'s sign-in message is relayed' });
      if (typeof b.signature !== 'string' || !SIGNATURE.test(b.signature)) return reply.code(400).send({ ok: false, error: 'signature is required' });
      try {
        const { status, json } = await ask(f, '/verify', { address: b.address, message: b.message, signature: b.signature, type: SIGN_TYPE, autoSign: false });
        const token = json?.code === 0 ? json.data?.accessToken : undefined;
        if (typeof token !== 'string' || !token) return reply.code(status >= 400 && status < 500 ? 401 : 502).send({ ok: false, error: why(json, status) });
        return reply.send({ ok: true, accessToken: token });
      } catch {
        return reply.code(502).send({ ok: false, error: 'SoDEX sign-in did not answer.' });
      }
    });
  };
}
