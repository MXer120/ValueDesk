/**
 * Invites and fee credits (invites/claim.ts has the rules):
 *
 *   GET  /api/vs/invites/code?address=0x…   the wallet's invite code, made the first time it is asked for. Nothing is
 *                                           signed: a code only ever earns for its own wallet.
 *   GET  /api/vs/invites/check?code=…        whether a code exists (the page keeps ?i only for a real one)
 *   GET  /api/vs/invites/me?address=0x…     the wallet's code, its join, welcome, credits and invitees (shortened)
 *   POST /api/vs/invites/join {join}         a signed join (the invited wallet's own signature)
 *
 * The credit job runs on the main API only (the beta API reads the same file).
 */
import type { FastifyInstance } from 'fastify';
import { clientKey } from '../hosted.js';
import { KeyedLimiter, type Limit } from '../rateLimit.js';
import { builderService, type BuilderService } from '../builder/service.js';
import { channelFrom } from '../beta/gate.js';
import { CODE_RE } from '../invites/claim.js';
import { checkInviteJoin } from '../invites/check.js';
import { InviteService } from '../invites/service.js';
import { InviteStore } from '../invites/store.js';

const MINUTE = 60_000;
export const INVITE_LIMITS: { write: Limit; read: Limit } = {
  write: { max: 12, windowMs: MINUTE },
  read: { max: 120, windowMs: MINUTE },
};
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface InviteRouteOptions {
  service?: InviteService;
  builder?: BuilderService;
  limiter?: KeyedLimiter;
  now?: () => number;
  /** Run the credit job here (default: on the main API). */
  keep?: boolean;
}

let instance: InviteService | null = null;

/** The running server's service (one per process: it hooks into the builder's fee decisions). */
export function inviteService(builder: BuilderService = builderService()): InviteService {
  return (instance ??= new InviteService(new InviteStore(), builder));
}

export async function inviteRoutes(app: FastifyInstance, opts: InviteRouteOptions = {}): Promise<void> {
  const limiter = opts.limiter ?? new KeyedLimiter(20_000);
  const now = opts.now ?? Date.now;
  let svc: InviteService | null = opts.service ?? null;
  const service = (): InviteService => (svc ??= inviteService(opts.builder));
  if (opts.keep ?? channelFrom(process.env) === 'main') {
    // Started with the server: credits must switch on and off whether or not anyone opens the page.
    try {
      service().start();
    } catch (e) {
      app.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'invites: the credit job could not start');
    }
  }
  const limited = (ip: string, cls: 'iw' | 'ir', limit: Limit): number | null => limiter.take(`${cls}|${clientKey(ip)}`, limit, now());
  const slow = (reply: { header(k: string, v: string): unknown; code(n: number): { send(b: unknown): unknown } }, wait: number) => {
    reply.header('Retry-After', String(wait));
    return reply.code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
  };

  app.get('/api/vs/invites/code', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const address = String((req.query as { address?: unknown }).address ?? '');
    if (!ADDRESS.test(address)) return reply.code(400).send({ ok: false, error: 'address must be a 0x address' });
    const s = service();
    const have = s.store.codeOf(address);
    if (have) return { ok: true, code: have };
    const wait = limited(req.ip, 'iw', INVITE_LIMITS.write);
    if (wait !== null) return slow(reply, wait);
    return { ok: true, code: s.store.ensureCode(address, now()) };
  });

  app.get('/api/vs/invites/check', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited(req.ip, 'ir', INVITE_LIMITS.read);
    if (wait !== null) return slow(reply, wait);
    const code = String((req.query as { code?: unknown }).code ?? '');
    if (!CODE_RE.test(code)) return { ok: true, valid: false };
    return { ok: true, valid: service().store.ownerOf(code) !== null };
  });

  app.get('/api/vs/invites/me', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited(req.ip, 'ir', INVITE_LIMITS.read);
    if (wait !== null) return slow(reply, wait);
    const address = String((req.query as { address?: unknown }).address ?? '');
    if (!ADDRESS.test(address)) return reply.code(400).send({ ok: false, error: 'address must be a 0x address' });
    return service().me(address);
  });

  app.post('/api/vs/invites/join', { bodyLimit: 4 * 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited(req.ip, 'iw', INVITE_LIMITS.write);
    if (wait !== null) return slow(reply, wait);
    const c = checkInviteJoin((req.body as { join?: unknown } | null)?.join, now());
    if (!c.ok) return reply.code(400).send({ ok: false, error: c.error });
    const s = service();
    const r = s.store.join(c.join, s.hasVolume(c.join.wallet), now());
    if (r.ok) {
      if (r.fresh) app.log.info({ wallet: r.join.wallet, code: r.join.code }, 'invites: joined');
      return { ok: true, at: r.join.at };
    }
    const words: Record<typeof r.code, string> = {
      'unknown-code': 'This invite code does not exist.',
      self: 'This is your own invite.',
      joined: 'This wallet joined with another invite already.',
      'has-volume': 'This wallet has traded on ValueDesk already: invites are for new wallets.',
    };
    return reply.code(409).send({ ok: false, code: r.code, error: words[r.code] });
  });
}
