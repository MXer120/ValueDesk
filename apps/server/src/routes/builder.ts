/**
 * GET /api/vs/builder/terms?address=0x...&nonce=<16-64 of A-Z a-z 0-9 _ ->[&hint=1]
 *
 * The signed statement of the builder fee a wallet owes (docs/BUILDER-TIERS.md
 * §3). Everything behind it is src/builder; this file checks the three inputs
 * and hands over.
 *
 * The inputs are checked HERE, not only by the hosted gate: local mode has no
 * gate, and `address` and `nonce` go into the text that is signed - so they
 * must be plain strings that match, start to end. A repeated parameter arrives
 * as an array and fails the same check.
 *
 * The answer is never cached and never transformed: it is one wallet's, it is
 * valid for minutes, and its signature covers exact values.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { clientKey } from '../hosted.js';
import { builderService, type BuilderService } from '../builder/service.js';
import { ADDRESS_RE, NONCE_RE } from '../builder/terms.js';

export interface BuilderRouteOptions {
  /** A service to answer from instead of the running server's (tests). */
  service?: BuilderService;
  /** The token /api/vs/builder/volume asks for (tests); default VALUESCAN_INTERNAL_TOKEN. */
  internalToken?: string;
}

/** The internal token, compared in constant time; an empty one (unset) matches nothing. */
function tokenOk(want: string, given: unknown): boolean {
  if (!want || typeof given !== 'string') return false;
  const a = Buffer.from(want);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function builderRoutes(app: FastifyInstance, opts: BuilderRouteOptions = {}) {
  const service =
    opts.service ??
    builderService({
      info: (o, msg) => app.log.info(o, msg),
      warn: (o, msg) => app.log.warn(o, msg),
      error: (o, msg) => app.log.error(o, msg),
    });

  app.get('/api/vs/builder/terms', async (req, reply) => {
    reply.header('Cache-Control', 'no-store, no-transform');
    const q = (req.query ?? {}) as Record<string, unknown>;
    const bad = (error: string) => reply.code(400).send({ ok: false, error });
    if (typeof q.address !== 'string' || !ADDRESS_RE.test(q.address)) return bad('a valid 0x wallet address is required');
    if (typeof q.nonce !== 'string' || !NONCE_RE.test(q.nonce)) return bad('nonce must be 16 to 64 characters of A-Z a-z 0-9 _ -');
    if (q.hint !== undefined && q.hint !== '1') return bad('hint, when given, must be 1');
    try {
      return service.terms({ address: q.address.toLowerCase(), nonce: q.nonce, hint: q.hint === '1', client: clientKey(req.ip) });
    } catch (e) {
      // No terms: the app charges its default fee. Why goes to the log, not to the caller.
      req.log.error({ err: e instanceof Error ? e.message : String(e) }, 'builder terms: the request failed');
      return reply.code(200).send({ ok: false, code: 'unavailable', error: 'terms are not available right now' });
    }
  });

  /**
   * GET /api/vs/builder/volume?address=0x...&builder=<id>&days=<1-90>, header X-Internal-Token
   *
   * A wallet's counted volume for one builder over the last days, in USD: what
   * the hosted copy executor (on another server, without this ledger) sets its
   * copy fee step from. Internal: it answers only the holder of
   * VALUESCAN_INTERNAL_TOKEN - the site's proxy adds the origin secret to every
   * request, so that secret alone would make one wallet's volume anyone's to
   * read. Without the token it is a 404, like any path that does not exist.
   */
  app.get('/api/vs/builder/volume', async (req, reply) => {
    reply.header('Cache-Control', 'no-store, no-transform');
    const want = opts.internalToken ?? process.env.VALUESCAN_INTERNAL_TOKEN?.trim() ?? '';
    if (!tokenOk(want, req.headers['x-internal-token'])) return reply.code(404).send({ error: 'not found', source: 'server' });
    const q = (req.query ?? {}) as Record<string, unknown>;
    const bad = (error: string) => reply.code(400).send({ ok: false, error });
    if (typeof q.address !== 'string' || !ADDRESS_RE.test(q.address)) return bad('a valid 0x wallet address is required');
    const builder = Number(q.builder);
    if (!Number.isSafeInteger(builder) || builder <= 0) return bad('builder must be a SoDEX account id');
    const days = Number(q.days ?? 14);
    if (!Number.isSafeInteger(days) || days < 1 || days > 90) return bad('days must be a whole number from 1 to 90');
    const usd = service.volumeUsd(builder, q.address.toLowerCase(), days);
    if (usd === null) return reply.code(503).send({ ok: false, code: 'unavailable', error: 'the builder ledger is not open' });
    return { ok: true, usd, days };
  });
}
