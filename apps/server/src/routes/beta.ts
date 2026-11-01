/**
 * The beta channel's sign-in (beta.valuedesk.so; beta/gate.ts is the lock). Registered by the beta
 * API only (VALUESCAN_CHANNEL=beta); on the main API these paths are 404.
 *
 *   POST /api/beta/session  {signIn}  -> {token, wallet, expiresAt}   a listed wallet's BetaSignIn
 *   GET  /api/beta/me                 -> {channel, wallet, listed}     who the token (x-vs-beta) names
 *
 * The site keeps the token in its vs_beta cookie; the Vercel function hands it on as x-vs-beta.
 */
import type { FastifyInstance } from 'fastify';
import { BETA_TOKEN_HEADER } from '../beta/signIn.js';
import { checkBetaSignIn, type BetaList, type BetaTokens } from '../beta/gate.js';

export interface BetaRouteOptions {
  tokens: BetaTokens;
  list: BetaList;
  now?: () => number;
}

export async function betaRoutes(app: FastifyInstance, opts: BetaRouteOptions): Promise<void> {
  const now = opts.now ?? Date.now;
  // A sign-in's nonce is accepted once, until the sign-in would have expired anyway.
  const used = new Map<string, number>();

  app.post('/api/beta/session', { bodyLimit: 8 * 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const t = now();
    const c = checkBetaSignIn((req.body as { signIn?: unknown } | null)?.signIn, t);
    if (!c.ok) return reply.code(400).send({ ok: false, error: c.error });
    for (const [n, exp] of used) if (exp <= t) used.delete(n);
    if (used.has(c.nonce)) return reply.code(403).send({ ok: false, error: 'this signature was used already; sign again' });
    used.set(c.nonce, c.expiresAt);
    if (!opts.list.has(c.owner, t)) return reply.code(403).send({ ok: false, code: 'beta-list', error: 'this wallet is not on the beta list', wallet: c.owner });
    const { token, expiresAt } = opts.tokens.issue(c.owner, t);
    app.log.info({ wallet: c.owner }, 'beta: signed in');
    return { ok: true, token, wallet: c.owner, expiresAt };
  });

  app.get('/api/beta/me', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wallet = opts.tokens.read(req.headers[BETA_TOKEN_HEADER], now());
    return { channel: 'beta', wallet, listed: wallet ? opts.list.has(wallet, now()) : false };
  });
}
