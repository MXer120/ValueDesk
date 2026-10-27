/**
 * What visitors send the owner: feedback - a chat with the owner, screenshots
 * included - and client error reports.
 *
 *   POST /api/vs/feedback          a message: {category?, message, context?, wallet?, images?}   ops/feedback.ts
 *   POST /api/vs/feedback/upload   one screenshot, the raw bytes (PNG, JPEG, WebP; 2 MB)     ops/imageCheck.ts
 *   POST /api/vs/feedback/thread   the thread's messages, oldest first
 *   POST /api/vs/feedback/poll     {tokens: [...]}: per thread, the owner's replies so far
 *   GET  /api/vs/feedback/image?id=   one screenshot of the thread, back to its token
 *   POST /api/vs/client-errors     {build, route, browser, errors: [...]}                     ops/clientErrors.ts
 *
 * THE THREAD TOKEN (ops/feedbackThreads.ts) travels as `Authorization: Bearer`
 * on every feedback route but poll, which takes the browser's tokens in its body
 * - never in a URL, so never in a log or a Referer. A new token starts a thread.
 *
 * Like the knowledge folders' (hosted.ts), the POSTs need the site's exact Origin
 * and are counted as `write` by the gate; on top of that each has much tighter
 * limits of its own here, per client and for everyone together, and a small body
 * (a screenshot's 2 MB being the largest).
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
import { FeedbackStore, FullError, TOKEN_RE, bearer } from '../ops/feedbackThreads.js';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, checkImage } from '../ops/imageCheck.js';
import { BATCH_BODY_LIMIT, ClientErrorStore, alertText, parseBatch } from '../ops/clientErrors.js';

const MINUTE = 60_000;

type LimitKind = 'feedback' | 'upload' | 'read' | 'errors';

export interface ReportLimits {
  feedback: Limit;
  feedbackGlobal: Limit;
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

/** Tokens a poll may carry at once: a browser keeps its last threads. */
export const MAX_POLL_TOKENS = 10;

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
  /** The thread token, or a 401 sent. */
  const tokenOf = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const t = bearer(req.headers.authorization);
    if (!t) void reply.code(401).send({ ok: false, error: 'a thread token is required (Authorization: Bearer)' });
    return t;
  };

  app.post('/api/vs/feedback', { bodyLimit: FEEDBACK_BODY_LIMIT }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited('feedback', clientKey(req.ip));
    if (wait !== null) return tooMany(reply, wait);
    const token = tokenOf(req, reply);
    if (!token) return reply;
    const parsed = parseFeedback(jsonBody(req.body));
    if (parsed.ok === 'spam') return { ok: true };
    if (!parsed.ok) return reply.code(400).send({ ok: false, error: parsed.error, ...(parsed.code ? { code: parsed.code } : {}) });
    const f = parsed.feedback;
    const store = feedbackStore();
    let saved;
    try {
      saved = store.addUserMessage(token, { category: f.category, text: f.message, context: f.context, wallet: f.wallet, images: f.images }, now());
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
      const id = await owner.message(feedbackText(f, { id: threadId, isNew, images: images.length }), replyTo).catch(() => null);
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
    return { ok: true, thread: threadId, message: messageId, images: images.map((i) => i.id) };
  });

  app.post('/api/vs/feedback/upload', { bodyLimit: MAX_IMAGE_BYTES }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited('upload', clientKey(req.ip));
    if (wait !== null) return tooMany(reply, wait);
    const token = tokenOf(req, reply);
    if (!token) return reply;
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ ok: false, error: 'send the image as its raw bytes' });
    const check = checkImage(req.body);
    if (!check.ok) return reply.code(400).send({ ok: false, error: check.error });
    try {
      const img = feedbackStore().addImage(token, check, req.body, now());
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
    const token = tokenOf(req, reply);
    if (!token) return reply;
    const store = feedbackStore();
    const t = store.thread(token);
    if (!t) return reply.code(404).send({ ok: false, error: 'no such thread' });
    return { ok: true, thread: { id: t.id, category: t.category, createdAt: t.createdAt }, messages: store.messages(t.id) };
  });

  app.post('/api/vs/feedback/poll', { bodyLimit: 4096 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited('read', clientKey(req.ip));
    if (wait !== null) return tooMany(reply, wait);
    const b = jsonBody(req.body) as { tokens?: unknown } | undefined;
    const tokens = b && Array.isArray(b.tokens) ? b.tokens : null;
    if (!tokens || tokens.length > MAX_POLL_TOKENS || !tokens.every((t) => typeof t === 'string' && TOKEN_RE.test(t))) {
      return reply.code(400).send({ ok: false, error: `tokens must be at most ${MAX_POLL_TOKENS} thread tokens` });
    }
    const store = feedbackStore();
    return { ok: true, threads: (tokens as string[]).map((t) => store.summary(t)) };
  });

  app.get('/api/vs/feedback/image', async (req, reply) => {
    const wait = limited('read', clientKey(req.ip));
    if (wait !== null) return tooMany(reply, wait);
    const token = tokenOf(req, reply);
    if (!token) return reply;
    const id = (req.query as Record<string, unknown> | undefined)?.id;
    const img = typeof id === 'string' ? feedbackStore().image(token, id) : null;
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
