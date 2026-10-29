/**
 * What visitors send the owner: feedback - a chat with the owner, screenshots
 * included - and client error reports.
 *
 *   POST /api/vs/feedback          a message: {category?, areas?, message, context?, wallet?, images?}   ops/feedback.ts
 *   POST /api/vs/feedback/upload   one screenshot, the raw bytes (PNG, JPEG, WebP; 2 MB)     ops/imageCheck.ts
 *   POST /api/vs/feedback/thread   the chat's messages, oldest first
 *   POST /api/vs/feedback/poll     a wallet session: how many replies its chat has (nothing without one)
 *   POST /api/vs/feedback/unread   a browser token: {unread} - one bit, a new reply since it last
 *                                  saw the chat it sent into or watches (the dot; no count, no text)
 *   POST /api/vs/feedback/session  {signIn, attach?, watch?}: a wallet's session token; `attach`
 *                                  (a thread token) keeps that browser's chat on the wallet;
 *                                  `watch` (this browser's token) gets the wallet's unread dot
 *   GET  /api/vs/feedback/image?id=   one screenshot of the chat, back to its key
 *   POST /api/vs/client-errors     {build, route, browser, errors: [...]}                     ops/clientErrors.ts
 *
 * WHO MAY DO WHAT (ops/feedbackThreads.ts). One chat per wallet. SENDING needs no
 * signature: a browser sends with its own token (`Authorization: Bearer`, never in
 * a URL), and the message goes into the chat of the wallet address it carries -
 * marked "not proven" unless the sender holds that wallet's session
 * (ops/feedbackAuth.ts). READING - /thread and /image - takes the wallet's session
 * and nothing else: a browser token gets 401 `wallet`. So does poll, the bell's
 * reply count: without the signature nothing about a chat is told, not even that.
 *
 * Like the knowledge folders' (hosted.ts), the POSTs need the site's exact Origin
 * and are counted as `write` by the gate; on top of that each has much tighter
 * limits of its own here, per client and for everyone together - messages and
 * screenshots also per chat - and a small body (a screenshot's 2 MB the largest).
 *
 * Everything is stored before anything else happens, then forwarded to the owner
 * by Telegram (ops/telegram.ts) when it is configured, without waiting for it: a
 * visitor's message as a reply to the thread's last message, so the owner sees
 * one chain per thread and answers by replying (ops/telegramReplies.ts). An error
 * report is forwarded only for a fingerprint seen for the first time, at most
 * ALERTS_PER_DAY a day.
 *
 * A JSON body may come as application/json or as text/plain: the error reporter's
 * sendBeacon on page hide can only send the latter without a preflight.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientKey } from '../hosted.js';
import { KeyedLimiter, type Limit } from '../rateLimit.js';
import { sendTelegramMessage, sendTelegramPhoto } from '../ops/telegram.js';
import { FEEDBACK_BODY_LIMIT, feedbackText, parseFeedback } from '../ops/feedback.js';
import { FeedbackStore, FullError, TOKEN_RE, bearer, feedbackDbPath, tokenHash, type Who } from '../ops/feedbackThreads.js';
import { FeedbackSessions, checkFeedbackSignIn, sessionBearer } from '../ops/feedbackAuth.js';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, checkImage } from '../ops/imageCheck.js';
import { BATCH_BODY_LIMIT, ClientErrorStore, alertText, parseBatch } from '../ops/clientErrors.js';
import { InboxStore, parseInboxBatch, type InboxGrade } from '../ops/inbox.js';

const MINUTE = 60_000;

type LimitKind = 'feedback' | 'upload' | 'read' | 'errors' | 'auth';

export interface ReportLimits {
  feedback: Limit;
  feedbackGlobal: Limit;
  /** Messages into one chat, whichever address they come from. */
  feedbackThread: Limit;
  /** Screenshots into one chat. */
  uploadThread: Limit;
  /** Wallet sign-ins. */
  auth: Limit;
  authGlobal: Limit;
  upload: Limit;
  uploadGlobal: Limit;
  read: Limit;
  readGlobal: Limit;
  errors: Limit;
  errorsGlobal: Limit;
}

export const REPORT_LIMITS: ReportLimits = {
  feedback: { max: 10, windowMs: 10 * MINUTE },
  feedbackGlobal: { max: 200, windowMs: 60 * MINUTE },
  feedbackThread: { max: 30, windowMs: 60 * MINUTE },
  uploadThread: { max: 18, windowMs: 60 * MINUTE },
  auth: { max: 10, windowMs: 10 * MINUTE },
  authGlobal: { max: 300, windowMs: 60 * MINUTE },
  upload: { max: 9, windowMs: 10 * MINUTE },
  uploadGlobal: { max: 150, windowMs: 60 * MINUTE },
  read: { max: 60, windowMs: MINUTE },
  readGlobal: { max: 3000, windowMs: MINUTE },
  errors: { max: 12, windowMs: MINUTE },
  errorsGlobal: { max: 600, windowMs: MINUTE },
};

/** Where the owner hears about things: Telegram by default; message ids come back for the reply chain. */
export interface OwnerChannel {
  message(text: string, replyTo: number | null): Promise<number | null>;
  photo(bytes: Uint8Array, type: string, caption: string, replyTo: number | null): Promise<number | null>;
}

export const TELEGRAM_CHANNEL: OwnerChannel = {
  message: (text, replyTo) => sendTelegramMessage(text, { replyTo }),
  photo: (bytes, type, caption, replyTo) => sendTelegramPhoto(bytes, type, { caption, replyTo }),
};

export interface ReportRouteOptions {
  /** The feedback store (tests); default one opened on first use. */
  feedbackStore?: FeedbackStore;
  /** The wallets' inboxes (tests); default ops/inbox.ts inbox.db. */
  inbox?: InboxStore;
  /** The wallet sessions (tests); default the key beside feedback.db. */
  sessions?: FeedbackSessions;
  /** The error store (tests); default one opened on first use. */
  errorStore?: ClientErrorStore;
  limiter?: KeyedLimiter;
  limits?: ReportLimits;
  /** The owner's channel (tests); default Telegram. */
  owner?: OwnerChannel;
  /** Each forward to the owner as it starts (tests wait on it). */
  onForward?: (p: Promise<void>) => void;
  now?: () => number;
}


/** JSON in a string (text/plain) or already parsed (application/json). */
function jsonBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export async function reportRoutes(app: FastifyInstance, opts: ReportRouteOptions = {}) {
  const limiter = opts.limiter ?? new KeyedLimiter(20_000);
  const limits = opts.limits ?? REPORT_LIMITS;
  const owner = opts.owner ?? TELEGRAM_CHANNEL;
  const now = opts.now ?? Date.now;
  let errors = opts.errorStore ?? null;
  const errorStore = (): ClientErrorStore => (errors ??= new ClientErrorStore());
  let threads = opts.feedbackStore ?? null;
  const feedbackStore = (): FeedbackStore => (threads ??= new FeedbackStore());
  let inboxOpen = opts.inbox ?? null;
  const inbox = (): InboxStore => (inboxOpen ??= new InboxStore());
  let sessionsOpen = opts.sessions ?? null;
  const sessions = (): FeedbackSessions => (sessionsOpen ??= FeedbackSessions.beside(feedbackDbPath()));

  // A screenshot is the raw bytes; the type it claims is not believed (ops/imageCheck.ts).
  app.addContentTypeParser(['application/octet-stream', 'image/png', 'image/jpeg', 'image/webp'], { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_req, body, done) => done(null, body));

  /** The client's and everyone's bucket; the seconds to wait, or null. */
  const limited = (kind: LimitKind, who: string): number | null => {
    const t = now();
    const global = `${kind}Global` as keyof ReportLimits;
    return limiter.take(`${kind}|${who}`, limits[kind], t) ?? limiter.take(`${kind}|*`, limits[global], t);
  };
  const tooMany = (reply: FastifyReply, wait: number) => {
    reply.header('Retry-After', String(wait));
    return reply.code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
  };
  /** A chat's own limit (a token's or a wallet's); the seconds to wait, or null. */
  const limitedChat = (kind: 'feedbackThread' | 'uploadThread', who: Who): number | null =>
    limiter.take(`${kind}|${'token' in who ? tokenHash(who.token) : who.wallet}`, limits[kind], now());
  /** A wallet session from the header, or null (none, forged, expired). */
  const walletOf = (req: FastifyRequest): string | null => {
    const s = sessionBearer(req.headers.authorization);
    return s ? sessions().read(s, now()) : null;
  };
  const expired = (reply: FastifyReply) => reply.code(401).send({ ok: false, code: 'session', error: 'your wallet sign-in has expired - sign again' });
  /** Who may WRITE: a proven wallet, or a browser by its token - or a 401 sent. */
  const writerOf = (req: FastifyRequest, reply: FastifyReply): Who | null => {
    const wallet = walletOf(req);
    if (wallet) return { wallet };
    const t = bearer(req.headers.authorization);
    if (t) return { token: t };
    void (sessionBearer(req.headers.authorization)
      ? expired(reply)
      : reply.code(401).send({ ok: false, error: 'a browser token or a wallet session is required (Authorization: Bearer)' }));
    return null;
  };
  /** Who may READ a chat: only a proven wallet, its own - or a 401 sent. A browser token reads nothing. */
  const readerOf = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const wallet = walletOf(req);
    if (wallet) return wallet;
    void (sessionBearer(req.headers.authorization)
      ? expired(reply)
      : reply.code(401).send({ ok: false, code: 'wallet', error: 'sign in with your wallet to read your chat' }));
    return null;
  };

  app.post('/api/vs/feedback', { bodyLimit: FEEDBACK_BODY_LIMIT }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited('feedback', clientKey(req.ip));
    if (wait !== null) return tooMany(reply, wait);
    const writer = writerOf(req, reply);
    if (!writer) return reply;
    const parsed = parseFeedback(jsonBody(req.body));
    if (parsed.ok === 'spam') return { ok: true };
    if (!parsed.ok) return reply.code(400).send({ ok: false, error: parsed.error, ...(parsed.code ? { code: parsed.code } : {}) });
    // Counted per sender (a wallet's session, or a browser), so typing someone's address cannot use up their limit.
    const chatWait = limitedChat('feedbackThread', writer);
    if (chatWait !== null) return tooMany(reply, chatWait);
    // Which chat: a signed-in wallet's own (proven); else the address the browser says is connected (claimed,
    // marked so); else, with no wallet at all, the browser's own chat - nobody reads it until it signs in.
    const verified = 'wallet' in writer;
    const f = 'wallet' in writer ? { ...parsed.feedback, wallet: writer.wallet } : parsed.feedback;
    const into: Who = f.wallet ? { wallet: f.wallet } : writer;
    const store = feedbackStore();
    let saved;
    try {
      saved = store.addUserMessage(into, { category: f.category, areas: f.areas, text: f.message, context: f.context, wallet: f.wallet, verified, images: f.images }, now(), writer);
      // The browser that sent gets the chat's unread dot (ops/feedbackThreads.ts unread).
      if ('token' in writer) store.notePing(writer.token, into, now());
    } catch (e) {
      if (e instanceof FullError) {
        req.log.error('feedback: the store is at its cap - move feedback.db away to take messages again');
        return reply.code(503).send({ ok: false, error: 'feedback cannot be taken right now' });
      }
      throw e;
    }
    const { threadId, messageId, isNew, images } = saved;
    // Never awaited: the message is stored, Telegram is a courtesy.
    const forward = (async () => {
      let replyTo = isNew ? null : store.lastTgOf(threadId);
      const id = await owner.message(feedbackText(f, { id: threadId, isNew, images: images.length, verified }), replyTo).catch(() => null);
      if (id) {
        store.mapTg(id, threadId, messageId);
        replyTo = id;
      }
      for (const [i, img] of images.entries()) {
        const bytes = store.imageBytes(img.id);
        if (!bytes) continue;
        const pid = await owner.photo(bytes, IMAGE_TYPES[img.kind], `Thread #${threadId} · screenshot ${i + 1}/${images.length}`, replyTo).catch(() => null);
        if (pid) store.mapTg(pid, threadId);
      }
      if (!id) req.log.info({ thread: threadId }, 'feedback stored (not forwarded: Telegram is not configured or did not answer)');
    })();
    opts.onForward?.(forward);
    // `readable`: whether this sender can read the chat now (a wallet's session) - else it must sign in.
    return { ok: true, message: messageId, images: images.map((i) => i.id), readable: verified };
  });

  app.post('/api/vs/feedback/upload', { bodyLimit: MAX_IMAGE_BYTES }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited('upload', clientKey(req.ip));
    if (wait !== null) return tooMany(reply, wait);
    const who = writerOf(req, reply);
    if (!who) return reply;
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ ok: false, error: 'send the image as its raw bytes' });
    const check = checkImage(req.body);
    if (!check.ok) return reply.code(400).send({ ok: false, error: check.error });
    const chatWait = limitedChat('uploadThread', who);
    if (chatWait !== null) return tooMany(reply, chatWait);
    try {
      const img = feedbackStore().addImage(who, check, req.body, now());
      return { ok: true, id: img.id, width: img.width, height: img.height };
    } catch (e) {
      if (e instanceof FullError) return reply.code(409).send({ ok: false, error: e.message });
      throw e;
    }
  });

  app.post('/api/vs/feedback/thread', { bodyLimit: 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited('read', clientKey(req.ip));
    if (wait !== null) return tooMany(reply, wait);
    const wallet = readerOf(req, reply);
    if (!wallet) return reply;
    const store = feedbackStore();
    const t = store.thread({ wallet });
    if (!t || t === 'locked') return reply.code(404).send({ ok: false, error: 'no such thread' });
    store.markSeen(wallet, now());
    return { ok: true, thread: { id: t.id, category: t.category, createdAt: t.createdAt, wallet: t.wallet }, messages: store.messages(t.id) };
  });

  app.post('/api/vs/feedback/poll', { bodyLimit: 4096 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited('read', clientKey(req.ip));
    if (wait !== null) return tooMany(reply, wait);
    // Only the signed-in wallet learns anything about its chat - not even a count without it.
    const wallet = readerOf(req, reply);
    if (!wallet) return reply;
    return { ok: true, wallet: feedbackStore().summary({ wallet }) };
  });

  app.post('/api/vs/feedback/unread', { bodyLimit: 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited('read', clientKey(req.ip));
    if (wait !== null) return tooMany(reply, wait);
    // A browser token only: one bit about the chat it sent into or watches, nothing more.
    const t = bearer(req.headers.authorization);
    if (!t) return reply.code(401).send({ ok: false, error: 'a browser token is required (Authorization: Bearer)' });
    return { ok: true, unread: feedbackStore().unread(t) };
  });

  // A signed-in wallet's inbox (ops/inbox.ts): its browser-run algos' and copies' notices, kept on the server. The
  // browser that ran them sends them; only that wallet reads them back - with the feedback chat's wallet session.
  app.post('/api/vs/inbox/add', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited('read', clientKey(req.ip));
    if (wait !== null) return tooMany(reply, wait);
    const wallet = readerOf(req, reply);
    if (!wallet) return reply;
    const parsed = parseInboxBatch(jsonBody(req.body), wallet, now());
    if (!parsed.ok) return reply.code(400).send({ ok: false, error: parsed.error });
    return { ok: true, added: inbox().add(wallet, parsed.notices, now()) };
  });

  app.post('/api/vs/inbox/list', { bodyLimit: 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited('read', clientKey(req.ip));
    if (wait !== null) return tooMany(reply, wait);
    const wallet = readerOf(req, reply);
    if (!wallet) return reply;
    const b = (jsonBody(req.body) ?? {}) as { before?: unknown; limit?: unknown; grades?: unknown };
    const before = Number(b.before);
    const grades = Array.isArray(b.grades) ? b.grades.filter((g): g is InboxGrade => g === 'info' || g === 'warn' || g === 'error') : [];
    return { ok: true, wallet, notices: inbox().list(wallet, { before: before > 0 ? before : undefined, limit: Number(b.limit) || 100, grades }) };
  });

  app.post('/api/vs/feedback/session', { bodyLimit: 4096 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited('auth', clientKey(req.ip));
    if (wait !== null) return tooMany(reply, wait);
    const b = jsonBody(req.body) as { signIn?: unknown; attach?: unknown; watch?: unknown } | undefined;
    const v = checkFeedbackSignIn(b?.signIn, now());
    if (!v.ok) return reply.code(401).send({ ok: false, code: 'signature', error: v.error });
    const attach = b?.attach;
    if (attach !== undefined && (typeof attach !== 'string' || !TOKEN_RE.test(attach))) return reply.code(400).send({ ok: false, error: 'attach must be a thread token' });
    const watch = b?.watch;
    if (watch !== undefined && (typeof watch !== 'string' || !TOKEN_RE.test(watch))) return reply.code(400).send({ ok: false, error: 'watch must be a browser token' });
    const store = feedbackStore();
    if (!store.useNonce(v.nonce, v.expiresAt, now())) return reply.code(409).send({ ok: false, code: 'replay', error: 'this sign-in was already used - sign again' });
    const s = sessions().issue(v.owner, now());
    const a = typeof attach === 'string' ? store.attach(attach, v.owner, now()) : { result: 'none' as const, threadId: null, from: null };
    if (typeof watch === 'string') store.notePing(watch, { wallet: v.owner }, now(), { seen: true });
    if ((a.result === 'merged' || a.result === 'adopted') && a.threadId !== null) {
      const threadId = a.threadId;
      const text = a.result === 'merged'
        ? `Thread #${a.from} was signed in with wallet ${v.owner} and moved into thread #${threadId}, that wallet's chat.`
        : `Thread #${threadId} is now kept on wallet ${v.owner} (signed in - proven).`;
      // Into the chat's chain, like every forward; never awaited.
      const forward = (async () => {
        const id = await owner.message(text, store.lastTgOf(threadId)).catch(() => null);
        if (id) store.mapTg(id, threadId);
      })();
      opts.onForward?.(forward);
    }
    return { ok: true, owner: v.owner, token: s.token, expiresAt: s.expiresAt, attached: a.result };
  });

  app.get('/api/vs/feedback/image', async (req, reply) => {
    const wait = limited('read', clientKey(req.ip));
    if (wait !== null) return tooMany(reply, wait);
    const wallet = readerOf(req, reply);
    if (!wallet) return reply;
    const id = (req.query as Record<string, unknown> | undefined)?.id;
    const img = typeof id === 'string' ? feedbackStore().image({ wallet }, id) : null;
    if (!img) return reply.code(404).send({ ok: false, error: 'not found' });
    // Only ever an image, shown inline, of the kind its bytes were checked to be - never sniffed, never run.
    return reply
      .header('Content-Type', IMAGE_TYPES[img.row.kind])
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `inline; filename="screenshot.${img.row.kind === 'jpeg' ? 'jpg' : img.row.kind}"`)
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, no-store')
      .send(img.bytes);
  });

  app.post('/api/vs/client-errors', { bodyLimit: BATCH_BODY_LIMIT }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited('errors', clientKey(req.ip));
    if (wait !== null) return tooMany(reply, wait);
    const parsed = parseBatch(jsonBody(req.body) ?? req.body);
    if (!parsed.ok) return reply.code(400).send({ ok: false, error: parsed.error });
    const s = errorStore();
    const t = now();
    const fresh = s.record(parsed.batch, t);
    for (const { fp, error } of fresh) {
      if (!s.takeAlert(t)) break;
      void owner.message(alertText(fp, error, parsed.batch), null).catch(() => null);
    }
    // 204 would do; a body keeps the answer one shape with every other route.
    return { ok: true };
  });
}
