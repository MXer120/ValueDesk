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
import { VIP_DAYS, VIP_MIN_USD, builderService, isVip, type BuilderService } from '../builder/service.js';
import { ADDRESS_RE, NONCE_RE } from '../builder/terms.js';
import { SANCTIONED_WALLET_REASON, isSanctionedAddress } from '../builder/sanctions.js';
import { AdminStore } from '../admin/store.js';

export interface BuilderRouteOptions {
  /** A service to answer from instead of the running server's (tests). */
  service?: BuilderService;
  /** The token /api/vs/builder/volume asks for (tests); default VALUESCAN_INTERNAL_TOKEN. */
  internalToken?: string;
  /** The beta list to answer /api/vs/builder/beta from (tests); default the admin suite's (admin/store.ts beta_wallets). */
  betaWallets?: () => string[];
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
    // A wallet on the sanctions list gets no signed terms (and starts no verification): the app then
    // charges its default fee, and its own screen signs nothing for that wallet (builder/sanctions.ts).
    if (isSanctionedAddress(q.address)) return reply.code(451).send({ ok: false, code: 'sanctioned', error: SANCTIONED_WALLET_REASON });
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
    // The executor trades for this wallet: have the ledger verify it (a follower with no tab open is otherwise never counted).
    service.hint(q.address.toLowerCase(), 'executor');
    if (usd === null) return reply.code(503).send({ ok: false, code: 'unavailable', error: 'the builder ledger is not open' });
    // VIP and the dev page's programs for the executor's products (copy trading, bots): fee, until when (programs.ts).
    const lw = service.loweredFor(q.address.toLowerCase());
    const pick = (p: 'copy' | 'bots') => (lw.fees[p] ? { fee: lw.fees[p]!.fee, until: lw.fees[p]!.until } : null);
    return { ok: true, usd, days, vip: lw.vip, fees: { copy: pick('copy'), bots: pick('bots') } };
  });

  /**
   * GET /api/vs/builder/beta?address=0x..., header X-Internal-Token
   *
   * Whether a wallet is on the beta list (the admin suite's Beta page): the hosted executor on the other
   * server lets a wallet run REAL bots only from beta.valuedesk.so and only while it is listed (owner,
   * 2026-11-02: "Beta only"). Internal, as the volume above: without the token it is a 404.
   */
  let admin: AdminStore | null = null;
  const betaWallets = opts.betaWallets ?? (() => (admin ??= new AdminStore()).betaWallets().map((w) => w.address.toLowerCase()));
  app.get('/api/vs/builder/beta', async (req, reply) => {
    reply.header('Cache-Control', 'no-store, no-transform');
    const want = opts.internalToken ?? process.env.VALUESCAN_INTERNAL_TOKEN?.trim() ?? '';
    if (!tokenOk(want, req.headers['x-internal-token'])) return reply.code(404).send({ error: 'not found', source: 'server' });
    const q = (req.query ?? {}) as Record<string, unknown>;
    if (typeof q.address !== 'string' || !ADDRESS_RE.test(q.address)) return reply.code(400).send({ ok: false, error: 'a valid 0x wallet address is required' });
    try {
      return { ok: true, listed: betaWallets().includes(q.address.toLowerCase()) };
    } catch (e) {
      req.log.error({ err: e instanceof Error ? e.message : String(e) }, 'beta list: not readable');
      return reply.code(503).send({ ok: false, code: 'unavailable', error: 'the beta list is not readable' });
    }
  });

  /**
   * GET /api/vs/beta/listed?address=0x...  ->  {ok, listed}
   *
   * The same answer for the main site's page (owner, 2026-11-06: a whitelisted wallet gets Bots and the
   * advanced orders on valuedesk.so too). It only decides what the page OFFERS: a real bot starts on
   * the executor, which asks the list again for the wallet that signed the request (apps/executor
   * service.ts liveBotFor), so a page told "listed" by anyone else still starts nothing real.
   * It says whether one address is listed, never who is.
   */
  /**
   * GET /api/vs/bots/vip?address=0x...  ->  {ok, eligible, volumeUsd, minUsd, days}
   *
   * VIP (owner 2026-11-08): a wallet with $1M of its own counted volume in 14 days - the lowest fee on every product,
   * and its bots may move to the VIP executor (AWS Tokyo). What the page shows as progress, and what the executors
   * ask before a move. A wallet's builder volume is public on SoDEX already; it says nothing of anyone else.
   */
  app.get('/api/vs/bots/vip', async (req, reply) => {
    reply.header('Cache-Control', 'private, max-age=30');
    const q = (req.query ?? {}) as Record<string, unknown>;
    if (typeof q.address !== 'string' || !ADDRESS_RE.test(q.address)) return reply.code(400).send({ ok: false, error: 'a valid 0x wallet address is required' });
    const v = service.vipOf(q.address.toLowerCase());
    if (!v) return reply.code(503).send({ ok: false, code: 'unavailable', error: 'the builder ledger is not open' });
    return { ok: true, eligible: isVip(v), volumeUsd: v.volumeUsd, minUsd: VIP_MIN_USD, days: VIP_DAYS };
  });

  app.get('/api/vs/beta/listed', async (req, reply) => {
    reply.header('Cache-Control', 'private, max-age=30');
    const q = (req.query ?? {}) as Record<string, unknown>;
    if (typeof q.address !== 'string' || !ADDRESS_RE.test(q.address)) return reply.code(400).send({ ok: false, error: 'a valid 0x wallet address is required' });
    try {
      return { ok: true, listed: betaWallets().includes(q.address.toLowerCase()) };
    } catch (e) {
      req.log.error({ err: e instanceof Error ? e.message : String(e) }, 'beta list: not readable');
      return reply.code(503).send({ ok: false, code: 'unavailable', error: 'the beta list is not readable' });
    }
  });
}
