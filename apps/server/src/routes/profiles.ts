/**
 * A wallet's username (profiles/): one per wallet, one wallet per name. Taking the first needs no
 * signature; changing it needs the wallet's (owner, 2026-11-05).
 *
 *   GET  /api/vs/profile?address=0x…             -> {ok, username|null, updatedAt|null, known}
 *   GET  /api/vs/username/check?name=x&for=0x…   -> {ok, available, reason|null}   the rules, then the store
 *   POST /api/vs/username         {address, username}  -> {ok, username, updatedAt}   a wallet's first name
 *   POST /api/vs/username/change  {change}             -> {ok, username, updatedAt}   signed (claim.ts)
 *
 * Reads are the `read` class at the hosted gate. The POSTs are `write` there (the site's exact Origin)
 * with a tighter limit of their own here, which is what bounds naming other people's wallets: the
 * first name is not proof of ownership, and the wallet's own signature always replaces it.
 */
import type { FastifyInstance } from 'fastify';
import { clientKey } from '../hosted.js';
import { KeyedLimiter, type Limit } from '../rateLimit.js';
import { checkUsernameChange } from '../profiles/check.js';
import { usernameProblem, usernameProblemText } from '../profiles/claim.js';
import { ProfileStore } from '../profiles/store.js';

const MINUTE = 60_000;
export const USERNAME_LIMITS: { write: Limit; check: Limit } = {
  write: { max: 12, windowMs: MINUTE },
  check: { max: 120, windowMs: MINUTE },
};

export interface ProfileRouteOptions {
  store?: ProfileStore;
  /** Whether this wallet has traded through ValueDesk (the builder ledger): a returning user, whatever browser they are on. */
  known?: (address: string) => boolean;
  limiter?: KeyedLimiter;
  now?: () => number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function profileRoutes(app: FastifyInstance, opts: ProfileRouteOptions = {}): Promise<void> {
  const limiter = opts.limiter ?? new KeyedLimiter(20_000);
  const now = opts.now ?? Date.now;
  let opened: ProfileStore | null = opts.store ?? null;
  /* Opened on first use: most servers answer no name request for minutes after a start. */
  const store = (): ProfileStore => (opened ??= new ProfileStore());

  const limited = (ip: string, cls: 'un' | 'uc', limit: Limit, t: number): number | null => limiter.take(`${cls}|${clientKey(ip)}`, limit, t);

  app.get('/api/vs/profile', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const address = String((req.query as { address?: unknown }).address ?? '');
    if (!ADDRESS.test(address)) return reply.code(400).send({ ok: false, error: 'address must be a 0x address' });
    const p = store().byAddress(address);
    let known = false;
    try {
      known = opts.known?.(address.toLowerCase()) ?? false;
    } catch {
      /* the ledger is not this route's to fail on */
    }
    return { ok: true, username: p?.username ?? null, updatedAt: p?.updatedAt ?? null, known };
  });

  app.get('/api/vs/username/check', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited(req.ip, 'uc', USERNAME_LIMITS.check, now());
    if (wait !== null) {
      reply.header('Retry-After', String(wait));
      return reply.code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
    }
    const q = req.query as { name?: unknown; for?: unknown };
    const name = String(q.name ?? '');
    const problem = usernameProblem(name);
    if (problem) return { ok: true, available: false, reason: usernameProblemText(problem) };
    const asker = typeof q.for === 'string' && ADDRESS.test(q.for) ? q.for : undefined;
    if (store().isTaken(name, asker)) return { ok: true, available: false, reason: 'This username is taken.' };
    return { ok: true, available: true, reason: null };
  });

  app.post('/api/vs/username', { bodyLimit: 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const t = now();
    const wait = limited(req.ip, 'un', USERNAME_LIMITS.write, t);
    if (wait !== null) {
      reply.header('Retry-After', String(wait));
      return reply.code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
    }
    const b = (req.body ?? {}) as { address?: unknown; username?: unknown };
    if (typeof b.address !== 'string' || !ADDRESS.test(b.address)) return reply.code(400).send({ ok: false, error: 'address must be a 0x address' });
    if (typeof b.username !== 'string') return reply.code(400).send({ ok: false, error: 'username must be text' });
    const problem = usernameProblem(b.username);
    if (problem) return reply.code(400).send({ ok: false, error: usernameProblemText(problem) });
    const r = store().setFirst(b.address, b.username, t);
    if (r.ok) {
      if (r.fresh) app.log.info({ wallet: r.profile.address, username: r.profile.username }, 'username: first');
      return { ok: true, username: r.profile.username, updatedAt: r.profile.updatedAt };
    }
    if (r.code === 'has-name') return reply.code(409).send({ ok: false, code: 'has-name', error: `This wallet already has the username ${r.profile.username}. Changing it needs the wallet's signature.`, username: r.profile.username });
    return reply.code(409).send({ ok: false, code: 'taken', error: 'This username is taken.' });
  });

  app.post('/api/vs/username/change', { bodyLimit: 4 * 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const t = now();
    const wait = limited(req.ip, 'un', USERNAME_LIMITS.write, t);
    if (wait !== null) {
      reply.header('Retry-After', String(wait));
      return reply.code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
    }
    const c = checkUsernameChange((req.body as { change?: unknown } | null)?.change, t);
    if (!c.ok) return reply.code(400).send({ ok: false, error: c.error });
    const r = store().change(c.change, t);
    if (r.ok) {
      if (r.fresh) app.log.info({ wallet: r.profile.address, username: r.profile.username }, 'username: changed');
      return { ok: true, username: r.profile.username, updatedAt: r.profile.updatedAt };
    }
    if (r.code === 'stale') return reply.code(409).send({ ok: false, code: 'stale', error: 'This signature is older than the wallet\'s last change; sign again.' });
    return reply.code(409).send({ ok: false, code: 'taken', error: 'This username is taken.' });
  });
}
