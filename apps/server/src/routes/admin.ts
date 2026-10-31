/**
 * The admin suite's API (dev.valuedesk.so, apps/web/src/admin/): the owner's
 * tickets, numbers, users and status. Every route is a POST under /api/admin/.
 *
 *   POST /api/admin/session          {signIn, password} -> {token, wallet, expiresAt}     admin/auth.ts
 *   POST /api/admin/me               the session: wallet, ends at; the open sessions
 *   POST /api/admin/signout          ends this session
 *   POST /api/admin/sessions/revoke  {action}: signs every session out (signed)
 *   POST /api/admin/tickets          every feedback chat, with its status
 *   POST /api/admin/ticket           {id}: one chat, every message with its page info
 *   POST /api/admin/ticket/image     {id, image}: one screenshot of that chat, its bytes
 *   POST /api/admin/ticket/reply     {id, text, action}: the owner's answer (signed)
 *   POST /api/admin/ticket/status    {id, status, action}: open / waiting / closed (signed)
 *   POST /api/admin/builder          {days?}: volume, fees, wallets, tiers (admin/builderStats.ts)
 *   POST /api/admin/users            every wallet ValueDesk knows: volume, fees, tier, activity
 *   POST /api/admin/analytics        {days?}: visitors, pages, time, places, sources, features
 *   POST /api/admin/status           the status of everything (admin/statusView.ts)
 *   POST /api/admin/audit            {before?, kind?}: the audit log, newest first
 *   POST /api/admin/page-error       {message, stack, where, route, build, browser}: an error the page hit,
 *                                    into the audit log (the page shows it too - apps/web/src/admin/Crash.tsx)
 *
 * THE LOCK IS HERE, NOT IN THE PAGE. In this plugin's own hook (after the hosted gate), before any handler:
 *   1. no password set on this server (admin/auth.ts): every route is a 404, as a
 *      path that does not exist - the suite is off;
 *   2. the Origin must be one of the suite's own (VALUESCAN_ADMIN_ORIGINS, exactly) -
 *      the gate (hosted.ts) checks the same for the `admin` class first;
 *   3. every route but the sign-in needs an open session (Authorization: Bearer vda_…).
 * A write needs, on top, a fresh AdminAction signed by the session's wallet that
 * names exactly this action, target and payload (admin/auth.ts checkAdminAction).
 *
 * Sign-in: the signature first - it must be an admin wallet's - then the password.
 * Five wrong passwords within 15 minutes lock the sign-in for 15 minutes; every
 * wrong password (it comes with a valid admin signature: someone holds the key)
 * and every sign-in is told to the owner by Telegram. Everything is in the audit
 * log (admin/store.ts).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { clientKey } from '../hosted.js';
import { isAllowedOrigin, normaliseOrigin } from '../origin.js';
import { KeyedLimiter, type Limit } from '../rateLimit.js';
import { sendTelegramMessage } from '../ops/telegram.js';
import { FeedbackStore } from '../ops/feedbackThreads.js';
import { IMAGE_TYPES } from '../ops/imageCheck.js';
import type { AnalyticsStore } from '../ops/analytics.js';
import type { TiersConfig } from '../builder/config.js';
import {
  ADMIN_SESSION_TTL_MS, adminBearer, adminOriginsFrom, adminPasswordPath, adminWalletsFrom, checkAdminAction, checkAdminSignIn,
  newSessionToken, passwordIsSet, readPasswordHash, verifyPassword,
} from '../admin/auth.js';
import { AdminStore, TICKET_STATUSES, type TicketStatus } from '../admin/store.js';
import { builderOverview, builderUsers, syncFeeOrders } from '../admin/builderStats.js';
import { statusOfEverything, type StatusSources } from '../admin/statusView.js';
import type { AdminActionName } from '../admin/signIn.js';

const MINUTE = 60_000;
const DAY = 86_400_000;

export interface AdminLimits {
  signIn: Limit;
  signInGlobal: Limit;
  read: Limit;
  write: Limit;
}

export const ADMIN_LIMITS: AdminLimits = {
  signIn: { max: 10, windowMs: 15 * MINUTE },
  signInGlobal: { max: 60, windowMs: 60 * MINUTE },
  read: { max: 240, windowMs: MINUTE },
  write: { max: 30, windowMs: MINUTE },
};

/** Wrong passwords within LOCK_WINDOW_MS that lock the sign-in, and for how long after the last one. */
export const LOCK_AFTER = 5;
export const LOCK_WINDOW_MS = 15 * MINUTE;

export const REPLY_MAX = 4000;
/** How often the builder ledger's counted orders are copied (admin/builderStats.ts syncFeeOrders). */
export const FEE_SYNC_MS = 5 * MINUTE;

export interface AdminRouteOptions {
  store?: AdminStore;
  feedback?: FeedbackStore;
  analytics?: () => AnalyticsStore;
  /** The builder ledger, read-only (null while there is none) and the tiers in force. */
  ledger?: () => DatabaseSync | null;
  tiers?: () => TiersConfig | null;
  status?: StatusSources;
  passwordPath?: string;
  admins?: readonly string[];
  origins?: readonly string[];
  /** Hosted: the edge's country header is believed, and only the suite's own origins pass. */
  hosted?: boolean;
  /** Where the owner hears about sign-ins; also the Telegram copy of an answer. Default Telegram. */
  tell?: (text: string, replyTo?: number | null) => Promise<number | null>;
  limiter?: KeyedLimiter;
  limits?: AdminLimits;
  /** Copy the ledger's counted orders every FEE_SYNC_MS (off in tests). */
  syncTimer?: boolean;
  now?: () => number;
}

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bodyOf = (req: FastifyRequest): Record<string, unknown> => (isRecord(req.body) ? req.body : {});
const idOf = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);

export async function adminRoutes(app: FastifyInstance, opts: AdminRouteOptions = {}) {
  const now = opts.now ?? Date.now;
  const limiter = opts.limiter ?? new KeyedLimiter(5_000);
  const limits = opts.limits ?? ADMIN_LIMITS;
  const admins = opts.admins ?? adminWalletsFrom(process.env.VALUESCAN_ADMIN_WALLETS);
  const origins = (opts.origins ?? adminOriginsFrom(process.env.VALUESCAN_ADMIN_ORIGINS)).map((o) => normaliseOrigin(o) ?? o);
  const passwordPath = opts.passwordPath ?? adminPasswordPath();
  const hosted = opts.hosted ?? false;
  const tell = opts.tell ?? ((text: string, replyTo?: number | null) => sendTelegramMessage(text, { replyTo: replyTo ?? null }));
  let storeOpen = opts.store ?? null;
  const store = (): AdminStore => (storeOpen ??= new AdminStore());
  let feedbackOpen = opts.feedback ?? null;
  const feedback = (): FeedbackStore => (feedbackOpen ??= new FeedbackStore());

  const countryOf = (req: FastifyRequest): string | null => {
    if (!hosted) return null;
    const c = String(req.headers['x-viewer-country'] ?? '').trim().toUpperCase();
    return /^[A-Z]{2}$/.test(c) ? c : null;
  };
  const originOk = (o: unknown): boolean => {
    const n = typeof o === 'string' ? normaliseOrigin(o) : null;
    if (n && origins.includes(n)) return true;
    // Local dev: the Vite dev server's loopback origin (the global hook of index.ts checks it too).
    return !hosted && isAllowedOrigin(typeof o === 'string' ? o : undefined);
  };
  const tooMany = (reply: FastifyReply, wait: number) => {
    reply.header('Retry-After', String(wait));
    return reply.code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
  };

  // --- the lock ------------------------------------------------------------------------------

  type Session = { wallet: string; expiresAt: number; token: string };
  const sessionOf = new WeakMap<FastifyRequest, Session>();
  const session = (req: FastifyRequest): Session => sessionOf.get(req)!;

  // preValidation, not onRequest: it runs after EVERY onRequest hook, so in hosted mode the gate (hosted.ts:
  // origin secret, allow-list, the suite's Origin, its limits) has always had its say first - however the
  // gate and this plugin were registered. The body (32 KB at most) is parsed by then; nothing reads it before.
  app.addHook('preValidation', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!passwordIsSet(passwordPath)) return reply.code(404).send({ error: 'not found', source: 'server' });
    if (req.method !== 'POST') return reply.code(405).send({ ok: false, error: 'POST only' });
    if (!originOk(req.headers.origin)) return reply.code(403).send({ ok: false, error: 'origin not allowed' });
    const who = clientKey(req.ip);
    const isSignIn = req.routeOptions?.url === '/api/admin/session';
    const wait = isSignIn
      ? limiter.take(`signin|${who}`, limits.signIn, now()) ?? limiter.take('signin|*', limits.signInGlobal, now())
      : limiter.take(`read|${who}`, limits.read, now());
    if (wait !== null) return tooMany(reply, wait);
    if (isSignIn) return;
    const token = adminBearer(req.headers.authorization);
    const s = store().session(token, now());
    if (!token || !s) return reply.code(401).send({ ok: false, code: 'session', error: 'sign in again' });
    sessionOf.set(req, { wallet: s.wallet, expiresAt: s.expiresAt, token });
  });

  /** A write's signature, checked and its nonce spent - or the refusal sent (and audited). */
  const signed = (req: FastifyRequest, reply: FastifyReply, action: AdminActionName, target: string, payload: unknown): boolean => {
    const s = session(req);
    const wait = limiter.take(`write|${s.wallet}`, limits.write, now());
    if (wait !== null) {
      void tooMany(reply, wait);
      return false;
    }
    const c = checkAdminAction(bodyOf(req).action, { wallet: s.wallet, action, target, payload }, now());
    const ok = c.ok && store().useNonce(c.nonce, c.expiresAt, now());
    if (!ok) {
      store().audit({ kind: action, ok: false, wallet: s.wallet, client: clientKey(req.ip), country: countryOf(req), detail: { target, why: c.ok ? 'replayed signature' : c.error } }, now());
      void reply.code(403).send({ ok: false, code: 'signature', error: c.ok ? 'this signature was used already; sign again' : c.error });
    }
    return ok;
  };

  // --- sessions -----------------------------------------------------------------------------

  app.post('/api/admin/session', { bodyLimit: 8 * 1024 }, async (req, reply) => {
    const b = bodyOf(req);
    const client = clientKey(req.ip);
    const country = countryOf(req);
    const t = now();
    const last = store().lastFailure('signin.password');
    if (store().failures('signin.password', t - LOCK_WINDOW_MS) >= LOCK_AFTER && last !== null) {
      const wait = Math.max(1, Math.ceil((last + LOCK_WINDOW_MS - t) / 1000));
      reply.header('Retry-After', String(wait));
      return reply.code(423).send({ ok: false, code: 'locked', error: `sign-in is locked after ${LOCK_AFTER} wrong passwords - wait ${Math.ceil(wait / 60)} min` });
    }
    const c = checkAdminSignIn(b.signIn, admins, t);
    if (!c.ok) {
      store().audit({ kind: 'signin.signature', ok: false, client, country, detail: { why: c.error } }, t);
      return reply.code(401).send({ ok: false, code: 'signature', error: c.error });
    }
    if (!store().useNonce(c.nonce, c.expiresAt, t)) {
      store().audit({ kind: 'signin.signature', ok: false, wallet: c.owner, client, country, detail: { why: 'replayed signature' } }, t);
      return reply.code(401).send({ ok: false, code: 'signature', error: 'this sign-in was used already; sign again' });
    }
    const hash = readPasswordHash(passwordPath);
    if (!hash || !(await verifyPassword(b.password, hash))) {
      store().audit({ kind: 'signin.password', ok: false, wallet: c.owner, client, country }, t);
      const n = store().failures('signin.password', t - LOCK_WINDOW_MS);
      void tell(`🚨 FAILURE · Admin sign-in refused: wrong password with a valid signature of ${short(c.owner)} (${country ?? 'country unknown'}, ${n}/${LOCK_AFTER} in 15 min)${n >= LOCK_AFTER ? ' - sign-in locked for 15 min' : ''}`).catch(() => null);
      return reply.code(401).send({ ok: false, code: 'password', error: 'wrong password' });
    }
    const token = newSessionToken();
    const expiresAt = t + ADMIN_SESSION_TTL_MS;
    store().openSession(token, { wallet: c.owner, createdAt: t, expiresAt, client, country });
    store().audit({ kind: 'signin', ok: true, wallet: c.owner, client, country, detail: { expiresAt } }, t);
    void tell(`ℹ️ INFO · Admin sign-in: ${short(c.owner)} on dev.valuedesk.so (${country ?? 'country unknown'}), 24 h`).catch(() => null);
    return { ok: true, token, wallet: c.owner, expiresAt };
  });

  app.post('/api/admin/me', { bodyLimit: 1024 }, async (req) => {
    const s = session(req);
    return { ok: true, wallet: s.wallet, expiresAt: s.expiresAt, sessions: store().openSessions(now()) };
  });

  app.post('/api/admin/signout', { bodyLimit: 1024 }, async (req) => {
    const s = session(req);
    store().endSession(s.token, now());
    store().audit({ kind: 'signout', ok: true, wallet: s.wallet, client: clientKey(req.ip), country: countryOf(req) }, now());
    return { ok: true };
  });

  app.post('/api/admin/sessions/revoke', { bodyLimit: 8 * 1024 }, async (req, reply) => {
    if (!signed(req, reply, 'sessions.revoke', 'all sessions', {})) return reply;
    const s = session(req);
    const n = store().endAllSessions(now());
    store().audit({ kind: 'sessions.revoke', ok: true, wallet: s.wallet, client: clientKey(req.ip), country: countryOf(req), detail: { ended: n } }, now());
    return { ok: true, ended: n };
  });

  // --- tickets --------------------------------------------------------------------------------

  /** The status a chat shows: the owner's, or from its last message (the visitor wrote last: open). */
  const statusOf = (statuses: Map<number, { status: TicketStatus; updatedAt: number }>, t: { id: number; lastAt: number; lastFrom: string | null }): TicketStatus => {
    const set = statuses.get(t.id);
    // A visitor's message after the owner closed or parked it opens it again.
    if (set && !(t.lastFrom === 'user' && t.lastAt > set.updatedAt && set.status !== 'open')) return set.status;
    return t.lastFrom === 'owner' ? 'waiting' : 'open';
  };

  app.post('/api/admin/tickets', { bodyLimit: 1024 }, async () => {
    const statuses = store().ticketStatuses();
    const tickets = feedback().adminThreads().map((t) => ({ ...t, status: statusOf(statuses, t) }));
    return { ok: true, tickets };
  });

  app.post('/api/admin/ticket', { bodyLimit: 1024 }, async (req, reply) => {
    const id = idOf(bodyOf(req).id);
    const t = id === null ? null : feedback().threadById(id);
    if (!t) return reply.code(404).send({ ok: false, error: 'no such ticket' });
    const row = feedback().adminThreads().find((x) => x.id === t.id);
    return {
      ok: true,
      ticket: { ...t, status: row ? statusOf(store().ticketStatuses(), row) : 'open' },
      messages: feedback().adminMessages(t.id),
    };
  });

  app.post('/api/admin/ticket/image', { bodyLimit: 1024 }, async (req, reply) => {
    const b = bodyOf(req);
    const id = idOf(b.id);
    const img = id === null || typeof b.image !== 'string' ? null : feedback().adminImage(id, b.image);
    if (!img) return reply.code(404).send({ ok: false, error: 'no such screenshot' });
    reply.header('Content-Type', IMAGE_TYPES[img.row.kind]);
    return reply.send(img.bytes);
  });

  app.post('/api/admin/ticket/reply', { bodyLimit: 32 * 1024 }, async (req, reply) => {
    const b = bodyOf(req);
    const id = idOf(b.id);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (id === null) return reply.code(400).send({ ok: false, error: 'id must be a ticket id' });
    if (!text || text.length > REPLY_MAX) return reply.code(400).send({ ok: false, error: `the answer must be 1 to ${REPLY_MAX} characters` });
    if (!signed(req, reply, 'ticket.reply', `ticket ${id}`, { id, text: b.text })) return reply;
    const s = session(req);
    const saved = feedback().addOwnerMessage(id, text, now());
    if (!saved) return reply.code(404).send({ ok: false, error: 'no such ticket' });
    store().audit({ kind: 'ticket.reply', ok: true, wallet: s.wallet, client: clientKey(req.ip), country: countryOf(req), detail: { ticket: saved.threadId, message: saved.messageId, chars: text.length } }, now());
    // A reply also answers the ticket: it waits for the visitor now.
    store().setTicketStatus(saved.threadId, 'waiting', s.wallet, now());
    // The Telegram chain keeps every answer, wherever it was written; never awaited.
    const f = feedback();
    void tell(`↩️ Answered on dev.valuedesk.so · thread #${saved.threadId}\n\n${text}`, f.lastTgOf(saved.threadId))
      .then((tg) => (tg ? f.mapTg(tg, saved.threadId, saved.messageId) : undefined))
      .catch(() => null);
    return { ok: true, message: saved.messageId };
  });

  app.post('/api/admin/ticket/status', { bodyLimit: 8 * 1024 }, async (req, reply) => {
    const b = bodyOf(req);
    const id = idOf(b.id);
    const status = b.status as TicketStatus;
    if (id === null || !TICKET_STATUSES.includes(status)) return reply.code(400).send({ ok: false, error: `status must be one of ${TICKET_STATUSES.join(', ')}` });
    if (!signed(req, reply, 'ticket.status', `ticket ${id}`, { id, status })) return reply;
    const t = feedback().threadById(id);
    if (!t) return reply.code(404).send({ ok: false, error: 'no such ticket' });
    const s = session(req);
    store().setTicketStatus(t.id, status, s.wallet, now());
    store().audit({ kind: 'ticket.status', ok: true, wallet: s.wallet, client: clientKey(req.ip), country: countryOf(req), detail: { ticket: t.id, status } }, now());
    return { ok: true };
  });

  // --- numbers --------------------------------------------------------------------------------

  const ledgerAndTiers = (): { ledger: DatabaseSync; cfg: TiersConfig } | null => {
    const cfg = opts.tiers?.() ?? null;
    const ledger = opts.ledger?.() ?? null;
    if (!cfg || !ledger) return null;
    try {
      syncFeeOrders(ledger, store(), cfg.builderId);
    } catch (e) {
      app.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'admin: copying the counted orders failed');
    }
    return { ledger, cfg };
  };

  if (opts.syncTimer) {
    const timer = setInterval(() => void ledgerAndTiers(), FEE_SYNC_MS);
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  app.post('/api/admin/builder', { bodyLimit: 1024 }, async (req) => {
    const days = Math.max(7, Math.min(120, Number(bodyOf(req).days) || 30));
    const l = ledgerAndTiers();
    if (!l) return { ok: true, builder: null };
    return { ok: true, builder: builderOverview(l.ledger, store(), l.cfg, now(), days), tiers: l.cfg.tiers, volumeDays: l.cfg.volumeDays };
  });

  app.post('/api/admin/users', { bodyLimit: 1024 }, async () => {
    const l = ledgerAndTiers();
    const builder = l ? builderUsers(l.ledger, store(), l.cfg, now()) : [];
    const activity = opts.analytics ? opts.analytics().walletActivity() : new Map();
    const chats = new Map(feedback().adminThreads().filter((t) => t.wallet).map((t) => [t.wallet!, t.id]));
    const all = new Set<string>([...builder.map((u) => u.address), ...activity.keys(), ...chats.keys()]);
    const byAddress = new Map(builder.map((u) => [u.address, u]));
    const users = [...all].map((address) => ({
      address,
      builder: byAddress.get(address) ?? null,
      activity: activity.get(address) ?? null,
      ticket: chats.get(address) ?? null,
    }));
    return { ok: true, users, builderId: l?.cfg.builderId ?? null };
  });

  app.post('/api/admin/analytics', { bodyLimit: 1024 }, async (req) => {
    if (!opts.analytics) return { ok: true, analytics: null };
    const days = Math.max(1, Math.min(365, Number(bodyOf(req).days) || 30));
    const t = now();
    const to = (Math.floor(t / DAY) + 1) * DAY;
    const a = opts.analytics();
    return { ok: true, analytics: a.summary(to - days * DAY, to, t), recent: a.recentVisits(50) };
  });

  app.post('/api/admin/status', { bodyLimit: 1024 }, async () => {
    if (!opts.status) return { ok: true, status: null };
    return { ok: true, status: await statusOfEverything(opts.status, now()) };
  });

  /** What the page reports about an error it hit: short strings only, cut to size. */
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, max) : '');

  app.post('/api/admin/page-error', { bodyLimit: 8 * 1024 }, async (req, reply) => {
    const s = session(req);
    const wait = limiter.take(`pageerr|${s.wallet}`, { max: 20, windowMs: 60 * MINUTE }, now());
    if (wait !== null) return tooMany(reply, wait);
    const b = bodyOf(req);
    store().audit({
      kind: 'page.error', ok: false, wallet: s.wallet, client: clientKey(req.ip), country: countryOf(req),
      detail: { message: text(b.message, 400), where: text(b.where, 400), route: text(b.route, 80), build: text(b.build, 40), browser: text(b.browser, 200), stack: text(b.stack, 1800) },
    }, now());
    return { ok: true };
  });

  app.post('/api/admin/audit', { bodyLimit: 1024 }, async (req) => {
    const b = bodyOf(req);
    const before = idOf(b.before) ?? undefined;
    const kind = typeof b.kind === 'string' && /^[a-z.]{1,40}$/.test(b.kind) ? b.kind : undefined;
    return { ok: true, rows: store().auditRows({ before, kind, limit: 200 }), chain: store().verifyAudit() };
  });
}
