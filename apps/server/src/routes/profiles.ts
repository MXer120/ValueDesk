/**
 * A wallet's username (profiles/): one per wallet, one wallet per name, signed by the wallet, and
 * it does not change.
 *
 *   GET  /api/vs/profile?address=0x…       -> {ok, username|null, claimedAt|null, known}
 *   GET  /api/vs/username/check?name=x     -> {ok, available, reason|null}   the rules, then the store
 *   POST /api/vs/username  {claim}         -> {ok, username, claimedAt}      a signed claim (claim.ts)
 *
 * Reads are the `read` class at the hosted gate. The POST is `write` there (the site's exact Origin)
 * with a tighter limit of its own here: a person takes one name, ever.
 */
import type { FastifyInstance } from 'fastify';
import { clientKey } from '../hosted.js';
import { KeyedLimiter, type Limit } from '../rateLimit.js';
import { checkUsernameClaim } from '../profiles/check.js';
import { usernameProblem, usernameProblemText } from '../profiles/claim.js';
import { ProfileStore } from '../profiles/store.js';

const MINUTE = 60_000;
export const USERNAME_LIMITS: { claim: Limit; check: Limit } = {
  claim: { max: 12, windowMs: MINUTE },
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
    return { ok: true, username: p?.username ?? null, claimedAt: p?.claimedAt ?? null, known };
  });

  app.get('/api/vs/username/check', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limiter.take(`uc|${clientKey(req.ip)}`, USERNAME_LIMITS.check, now());
    if (wait !== null) {
      reply.header('Retry-After', String(wait));
      return reply.code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
    }
    const name = String((req.query as { name?: unknown }).name ?? '');
    const problem = usernameProblem(name);
    if (problem) return { ok: true, available: false, reason: usernameProblemText(problem) };
    if (store().isTaken(name)) return { ok: true, available: false, reason: 'This username is taken.' };
    return { ok: true, available: true, reason: null };
  });

  app.post('/api/vs/username', { bodyLimit: 4 * 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const t = now();
    const wait = limiter.take(`un|${clientKey(req.ip)}`, USERNAME_LIMITS.claim, t);
    if (wait !== null) {
      reply.header('Retry-After', String(wait));
      return reply.code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
    }
    const c = checkUsernameClaim((req.body as { claim?: unknown } | null)?.claim, t);
    if (!c.ok) return reply.code(400).send({ ok: false, error: c.error });
    const r = store().claim(c.claim, t);
    if (r.ok) {
      if (r.fresh) app.log.info({ wallet: r.profile.address, username: r.profile.username }, 'username: taken');
      return { ok: true, username: r.profile.username, claimedAt: r.profile.claimedAt };
    }
    if (r.code === 'has-name') return reply.code(409).send({ ok: false, code: 'has-name', error: `This wallet already has the username ${r.profile.username}. A username cannot be changed.`, username: r.profile.username });
    return reply.code(409).send({ ok: false, code: 'taken', error: 'This username is taken.' });
  });
}
