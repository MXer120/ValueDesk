/**
 * SoPoints sign-in, proxied.
 *
 * THE FLOW IS A WALLET SIGNATURE. SoDEX's own points page does exactly this,
 * and it is read straight out of their bundle (`Tie` in features-*.js):
 *
 *     POST sodex.com/auth/v2/nonce   {address, type:'sign_in'}
 *            -> {data:{message, nonce, expiresIn:300}}
 *     personal_sign(message)                      <- the user's wallet, in the browser
 *     POST sodex.com/auth/v2/verify  {address, message, signature, type:'sign_in'}
 *            -> {data:{accessToken}}              <- a ~15 day SoDEX identity JWT
 *
 * That JWT is the bearer `alpha-biz.sodex.dev/biz/sopoints/*` wants. No email,
 * no Privy: the account IS the wallet.
 *
 * WHY IT IS PROXIED. `sodex.com/auth/v2/*` sends `Access-Control-Allow-Origin`
 * only for origins on their allowlist - their own domains plus
 * `http://localhost:3000`. Every other origin gets no ACAO header at all:
 *
 *     Origin: http://localhost:3000        -> access-control-allow-origin: http://localhost:3000
 *     Origin: http://localhost:5173        -> (none)
 *     Origin: https://anything.else        -> (none)
 *
 * A browser cannot forge `Origin`, so a build served from any other host could
 * never reach these two endpoints. A server is an ordinary HTTP client and sets
 * its own headers, so forwarding from here makes sign-in work on any port in
 * development and any domain in production.
 *
 * Only these TWO calls need it. `alpha-biz.sodex.dev` reflects whatever origin
 * asks, so once the browser holds a token it reads the points endpoints
 * directly, with no proxy in the path.
 *
 * WHAT THIS PROCESS CANNOT DO. It never sees a private key and cannot produce a
 * signature - that happens in the user's wallet, in their browser. All this
 * forwards is a nonce request and an already-signed message. It stores nothing:
 * no token, no address, no log line. The returned JWT does pass through on its
 * way back, which on a self-hosted install is the same trust boundary as the
 * signing key this process already holds, and is NOT the same on a shared
 * deployment - DEPLOYMENT.md says so.
 */
import type { FastifyInstance } from 'fastify';

const SODEX = 'https://sodex.com';

/**
 * An origin SoDEX's auth host answers with CORS headers.
 *
 * Stated rather than derived from the incoming request: it must NOT follow this
 * app's own origin, since that origin failing the allowlist is the entire
 * problem being solved here.
 */
const ALLOWED_ORIGIN = 'https://sodex.com';

/**
 * The only signature type this route will ask for or verify.
 *
 * Their auth host also mints tokens for `terms_of_use`, and pins `autoSign` to
 * choose whether the session may then sign trades unattended. Both are fixed
 * here rather than taken from the request body: a client has no business
 * choosing what it is about to be asked to sign, and accepting either from the
 * wire would let a caller turn a "read my points" prompt into something else.
 */
const SIGN_TYPE = 'sign_in';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length < 4096;
const isAddress = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);

async function forward(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${SODEX}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: ALLOWED_ORIGIN,
      Referer: `${ALLOWED_ORIGIN}/`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { message: text.slice(0, 200) || `SoDEX ${res.status}` };
  }
  return { status: res.status, json };
}

export async function pointsAuthRoutes(app: FastifyInstance): Promise<void> {
  /** Step 1: the message SoDEX wants signed. Public - it names an address only. */
  app.post('/api/points/auth/nonce', async (req, reply) => {
    const b = (req.body ?? {}) as { address?: unknown };
    if (!isAddress(b.address)) return reply.code(400).send({ message: 'address is required' });
    const { status, json } = await forward('/auth/v2/nonce', {
      address: b.address,
      type: SIGN_TYPE,
    });
    return reply.code(status).send(json);
  });

  /** Step 2: the signature, exchanged for the access token. */
  app.post('/api/points/auth/verify', async (req, reply) => {
    const b = (req.body ?? {}) as { address?: unknown; message?: unknown; signature?: unknown };
    if (!isAddress(b.address)) return reply.code(400).send({ message: 'address is required' });
    if (!isStr(b.message)) return reply.code(400).send({ message: 'message is required' });
    if (!isStr(b.signature)) return reply.code(400).send({ message: 'signature is required' });
    const { status, json } = await forward('/auth/v2/verify', {
      address: b.address,
      message: b.message,
      signature: b.signature,
      type: SIGN_TYPE,
      /* Read-only sign-in. `true` is what SoDEX passes when it is also arming a
         session to sign trades by itself; this app never wants that from a
         points login. */
      autoSign: false,
    });
    return reply.code(status).send(json);
  });
}
