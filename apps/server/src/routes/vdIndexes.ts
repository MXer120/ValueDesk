/**
 * Published ValueDesk indexes (indexes/): a wallet's own basket of SoDEX Wealth funds, up for everyone to browse.
 * Publishing, changing and taking one down are signed by the wallet (claim.ts): free typed data, never a transaction.
 *
 *   GET  /api/vs/indexes?owner=0x…&limit=n&before=ms -> {ok, indexes}   the last changed first, only those still up
 *   GET  /api/vs/indexes/:id                         -> {ok, index}     404 when there is none, or it was taken down
 *   GET  /api/vs/indexes/image/:hash                 -> the picture's bytes, while an index that is up shows it
 *   POST /api/vs/indexes/publish    {action, image?} -> {ok, index}     signed; id '' publishes a new one
 *   POST /api/vs/indexes/unpublish  {action}         -> {ok}            signed; the row is kept, marked taken down
 *
 * Reads are the `read` class at the hosted gate, the POSTs `write` there (the site's exact Origin) with a tighter limit
 * of their own here: each one costs the wallet a signature, so more than a few a minute is a script. Nothing about
 * buying is sent or kept: what a wallet bought stays in its own browser.
 *
 * THE PICTURE. The action signs its SHA-256 (claim.ts INDEX_IMAGE, '' for none); `image` in the body is its bytes as
 * base64. They are needed unless the action names no picture, or is an update keeping the picture the index shows now.
 * Checked here before anything is kept: strict base64, at most INDEX_IMAGE_MAX_BYTES, the hash the wallet signed, and
 * ops/imageCheck.ts (a whole PNG, JPEG or WebP judged by its bytes, nothing appended, no markup anywhere) at most
 * INDEX_IMAGE_SIDE on each side. Served back only as that checked kind, never sniffed, under a sandboxing CSP, and by
 * its hash only: content-addressed, so the answer never changes and may be kept for a year.
 */
import type { FastifyInstance } from 'fastify';
import { clientKey } from '../hosted.js';
import { KeyedLimiter, type Limit } from '../rateLimit.js';
import { createHash } from 'node:crypto';
import { checkIndexAction } from '../indexes/check.js';
import { INDEX_ID, INDEX_IMAGE, INDEX_IMAGE_MAX_BYTES, INDEX_IMAGE_SIDE, INDEX_PER_WALLET_MAX, type PublishedIndex } from '../indexes/claim.js';
import { IndexStore, type IndexPicture, type IndexRefusal, type StoredIndex } from '../indexes/store.js';
import { checkImage, IMAGE_TYPES } from '../ops/imageCheck.js';

const MINUTE = 60_000;
export const INDEX_LIMITS: { write: Limit; read: Limit } = {
  write: { max: 12, windowMs: MINUTE },
  read: { max: 300, windowMs: MINUTE },
};
export const INDEX_LIST_DEFAULT = 100;
export const INDEX_LIST_MAX = 200;

export interface IndexRouteOptions {
  store?: IndexStore;
  /** The owner's ValueDesk username (profiles.db), or null. */
  nameOf?: (address: string) => string | null;
  limiter?: KeyedLimiter;
  now?: () => number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WHOLE = /^\d{1,16}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** The longest base64 of a picture at INDEX_IMAGE_MAX_BYTES. */
const IMAGE_BASE64_MAX = Math.ceil(INDEX_IMAGE_MAX_BYTES / 3) * 4;
/**
 * 160 KiB: a picture at its most (96 KiB, 128 KiB as base64) and the longest action the rules allow (under 5 KiB as
 * JSON). The Vercel function lets as much through on this path (deploy/vercel/api-proxy.cjs bodyLimitFor).
 */
export const INDEX_PUBLISH_BODY_LIMIT = 160 * 1024;

/**
 * The picture a publish sends, checked: null when none was sent, or why it is refused. Strict base64 only (one
 * spelling, so the bytes hashed are the bytes sent), then the size, the hash the wallet signed, and the bytes themselves.
 */
export function readPicture(raw: unknown, signed: string): { ok: true; picture: IndexPicture | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, picture: null };
  if (signed === '') return { ok: false, error: 'a picture was sent for an index signed without one; sign again with the picture' };
  if (typeof raw !== 'string') return { ok: false, error: 'image must be the picture as base64' };
  if (raw.length > IMAGE_BASE64_MAX) return { ok: false, error: `the picture is larger than ${INDEX_IMAGE_MAX_BYTES / 1024} KB` };
  if (raw.length % 4 !== 0 || !BASE64.test(raw)) return { ok: false, error: 'image must be the picture as base64' };
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.toString('base64') !== raw) return { ok: false, error: 'image must be the picture as base64' };
  if (bytes.length > INDEX_IMAGE_MAX_BYTES) return { ok: false, error: `the picture is larger than ${INDEX_IMAGE_MAX_BYTES / 1024} KB` };
  if (createHash('sha256').update(bytes).digest('hex') !== signed) return { ok: false, error: 'the picture is not the one that was signed; sign again' };
  const c = checkImage(bytes);
  if (!c.ok) return { ok: false, error: `the picture cannot be used: ${c.error}` };
  if (c.width > INDEX_IMAGE_SIDE || c.height > INDEX_IMAGE_SIDE) return { ok: false, error: `the picture is larger than ${INDEX_IMAGE_SIDE} x ${INDEX_IMAGE_SIDE} pixels` };
  return { ok: true, picture: { hash: signed, kind: c.kind, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) } };
}

/** Each refusal's status and words: whose index it is decides 403, a missing one 404, the rest are conflicts. */
const REFUSALS: Record<IndexRefusal, { status: number; error: string }> = {
  'not-found': { status: 404, error: 'There is no published index with this id.' },
  'not-owner': { status: 403, error: 'This index was published by another wallet.' },
  stale: { status: 409, error: 'This signature is older than the index\'s last change; sign again.' },
  limit: { status: 409, error: `A wallet can have ${INDEX_PER_WALLET_MAX} published indexes at once. Take one down first.` },
  replay: { status: 409, error: 'This signature was used already; sign again.' },
  'image-missing': { status: 400, error: 'The picture was not sent with the index; publish again with it.' },
};

export async function vdIndexRoutes(app: FastifyInstance, opts: IndexRouteOptions = {}): Promise<void> {
  const limiter = opts.limiter ?? new KeyedLimiter(20_000);
  const now = opts.now ?? Date.now;
  let opened: IndexStore | null = opts.store ?? null;
  /* Opened on first use: most servers answer no index request for minutes after a start. */
  const store = (): IndexStore => (opened ??= new IndexStore());

  const limited = (ip: string, cls: 'xr' | 'xw', limit: Limit, t: number): number | null => limiter.take(`${cls}|${clientKey(ip)}`, limit, t);
  const slow = (reply: { header(k: string, v: string): unknown; code(n: number): { send(b: unknown): unknown } }, wait: number) => {
    reply.header('Retry-After', String(wait));
    return reply.code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
  };

  /** The usernames of a page of indexes, each owner asked once. */
  const named = (list: StoredIndex[]): PublishedIndex[] => {
    const names = new Map<string, string | null>();
    const nameOf = (owner: string): string | null => {
      if (!names.has(owner)) {
        let n: string | null = null;
        try {
          n = opts.nameOf?.(owner) ?? null;
        } catch {
          /* the usernames are not this route's to fail on: the index shows its address instead */
        }
        names.set(owner, n);
      }
      return names.get(owner) ?? null;
    };
    return list.map((ix) => ({ ...ix, ownerName: nameOf(ix.owner) }));
  };

  app.get('/api/vs/indexes', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited(req.ip, 'xr', INDEX_LIMITS.read, now());
    if (wait !== null) return slow(reply, wait);
    const q = req.query as { owner?: unknown; limit?: unknown; before?: unknown };
    const owner = q.owner === undefined || q.owner === '' ? undefined : String(q.owner);
    if (owner !== undefined && !ADDRESS.test(owner)) return reply.code(400).send({ ok: false, error: 'owner must be a 0x address' });
    let limit = INDEX_LIST_DEFAULT;
    if (q.limit !== undefined && q.limit !== '') {
      const s = String(q.limit);
      if (!WHOLE.test(s) || Number(s) < 1) return reply.code(400).send({ ok: false, error: 'limit must be a whole number from 1' });
      limit = Math.min(INDEX_LIST_MAX, Number(s));
    }
    let before: number | undefined;
    if (q.before !== undefined && q.before !== '') {
      const s = String(q.before);
      if (!WHOLE.test(s)) return reply.code(400).send({ ok: false, error: 'before must be a time in ms' });
      before = Number(s);
    }
    return { ok: true, indexes: named(store().list({ ...(owner ? { owner } : {}), limit, ...(before !== undefined ? { before } : {}) })) };
  });

  // A static segment: Fastify's router takes it before /api/vs/indexes/:id (and it is one segment longer anyway).
  app.get('/api/vs/indexes/image/:hash', async (req, reply) => {
    const wait = limited(req.ip, 'xr', INDEX_LIMITS.read, now());
    if (wait !== null) {
      reply.header('Cache-Control', 'no-store');
      return slow(reply, wait);
    }
    const hash = String((req.params as { hash?: unknown }).hash ?? '');
    const img = INDEX_IMAGE.test(hash) ? store().image(hash) : null;
    if (!img) {
      reply.header('Cache-Control', 'no-store');
      return reply.code(404).send({ ok: false, code: 'not-found', error: 'There is no published picture with this hash.' });
    }
    // Only ever an image, shown inline, of the kind its bytes were checked to be: never sniffed, never run.
    return reply
      .header('Content-Type', IMAGE_TYPES[img.kind])
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Disposition', `inline; filename="index.${img.kind === 'jpeg' ? 'jpg' : img.kind}"`)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(Buffer.from(img.bytes.buffer, img.bytes.byteOffset, img.bytes.byteLength));
  });

  app.get('/api/vs/indexes/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const wait = limited(req.ip, 'xr', INDEX_LIMITS.read, now());
    if (wait !== null) return slow(reply, wait);
    const id = String((req.params as { id?: unknown }).id ?? '');
    const ix = INDEX_ID.test(id) ? store().get(id) : null;
    if (!ix) return reply.code(404).send({ ok: false, code: 'not-found', error: REFUSALS['not-found'].error });
    return { ok: true, index: named([ix])[0] };
  });

  app.post('/api/vs/indexes/publish', { bodyLimit: INDEX_PUBLISH_BODY_LIMIT }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const t = now();
    const wait = limited(req.ip, 'xw', INDEX_LIMITS.write, t);
    if (wait !== null) return slow(reply, wait);
    const body = req.body as { action?: unknown; image?: unknown } | null;
    const c = checkIndexAction(body?.action, t);
    if (!c.ok) return reply.code(400).send({ ok: false, error: c.error });
    if (c.kind !== 'publish') return reply.code(400).send({ ok: false, error: 'this signature takes an index down; send it to /api/vs/indexes/unpublish' });
    const pic = readPicture(body?.image, c.action.image);
    if (!pic.ok) return reply.code(400).send({ ok: false, error: pic.error });
    const r = store().publish(c.action, c.legs, t, undefined, pic.picture);
    if (!r.ok) return reply.code(REFUSALS[r.code].status).send({ ok: false, code: r.code, error: REFUSALS[r.code].error });
    if (r.fresh) app.log.info({ wallet: r.index.owner, index: r.index.id, new: c.action.id === '' }, 'index: published');
    return { ok: true, index: named([r.index])[0] };
  });

  // 8 KiB: the longest action the rules allow (280 characters of description, twelve legs) is under 5 KiB as JSON.
  app.post('/api/vs/indexes/unpublish', { bodyLimit: 8 * 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const t = now();
    const wait = limited(req.ip, 'xw', INDEX_LIMITS.write, t);
    if (wait !== null) return slow(reply, wait);
    const c = checkIndexAction((req.body as { action?: unknown } | null)?.action, t);
    if (!c.ok) return reply.code(400).send({ ok: false, error: c.error });
    if (c.kind !== 'unpublish') return reply.code(400).send({ ok: false, error: 'this signature publishes an index; send it to /api/vs/indexes/publish' });
    const r = store().unpublish(c.action, t);
    if (!r.ok) return reply.code(REFUSALS[r.code].status).send({ ok: false, code: r.code, error: REFUSALS[r.code].error });
    if (r.fresh) app.log.info({ wallet: c.action.owner, index: c.action.id }, 'index: taken down');
    return { ok: true };
  });
}
