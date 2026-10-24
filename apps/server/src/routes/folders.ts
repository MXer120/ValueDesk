/**
 * KNOWLEDGE FOLDERS - a wallet's private research folders (src/folders/).
 *
 *   POST /api/folders/session          {signIn}                     -> a token (auth.ts)
 *   GET  /api/folders                  Bearer                       -> folders, items, usage, limits
 *   GET  /api/folders/item?id=         Bearer                       -> one item with its content
 *   GET  /api/folders/file?id=[&thumb=1] Bearer                     -> an upload's bytes (or a chart's thumbnail)
 *   POST /api/folders/folder/create    Bearer {name}
 *   POST /api/folders/folder/rename    Bearer {id, name}
 *   POST /api/folders/folder/delete    Bearer {id}                  (with everything in it)
 *   POST /api/folders/folder/order     Bearer {ids}
 *   POST /api/folders/item/create      Bearer {folderId, kind, title, data, thumb?}
 *   POST /api/folders/item/update      Bearer {id, title?, data?, rev?}
 *   POST /api/folders/item/move        Bearer {id, folderId, index}  (reorder, or to another folder)
 *   POST /api/folders/item/delete      Bearer {id}
 *   POST /api/folders/upload?folderId=&name=[&title=]   Bearer, application/octet-stream
 *   POST /api/folders/erase            Bearer {confirm: 'erase-everything'}
 *
 * PRIVATE TO THE WALLET. Every route but the sign-in needs the wallet's token,
 * and every read and write is scoped to that wallet in the store's queries -
 * an id of another wallet's item is "not found", exactly like one that does
 * not exist.
 *
 * LIMITS, SERVER-SIDE. The store enforces the counts and the bytes (store.ts);
 * here are the rates: changes per wallet per minute, uploads per wallet per
 * hour, file reads per wallet per minute, and how many wallets one client
 * address signs in per day. Hosted mode's gate adds its per-address limits on
 * top (hosted.ts: `auth` for the sign-in, `write` for every change).
 *
 * WHAT A FILE IS SERVED AS. The type its bytes are (sniffed again on the way
 * out, never the name or the type the upload claimed): PDF, an image, or
 * text/plain - never HTML or SVG - always as an attachment, `nosniff`, with a
 * sandboxing CSP, and never cached.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientKey } from '../hosted.js';
import { KeyedLimiter } from '../rateLimit.js';
import { checkSignIn, SessionTokens } from '../folders/auth.js';
import { foldersConfigFromEnv, FILE_BYTES_CEILING, type FoldersConfig } from '../folders/limits.js';
import { asFailure, FoldersFailure, FoldersStore, mimeOf } from '../folders/store.js';
import type { FoldersError } from '../folders/types.js';

export interface FoldersRouteOptions {
  /** A store to answer from instead of one opened from the environment (tests). */
  store?: FoldersStore;
  tokens?: SessionTokens;
  cfg?: FoldersConfig;
  /** The daily sweep and backup (off in tests). */
  upkeep?: boolean;
  now?: () => number;
}

const KB = 1024;
/** A chart snapshot (256 KB) and its thumbnail (200 KB as base64), with room for the JSON around them. */
export const CREATE_BODY_LIMIT = 640 * KB;
/** A note or a table (200 KB), as JSON text. */
export const UPDATE_BODY_LIMIT = 320 * KB;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FILE_READS_PER_MIN = 120;

/** Wallets one client address signed in today: bounded, reset each day. */
class SignInCounter {
  private day = -1;
  private readonly seen = new Map<string, Set<string>>();
  allow(client: string, owner: string, max: number, now: number): boolean {
    const day = Math.floor(now / DAY);
    if (day !== this.day) {
      this.day = day;
      this.seen.clear();
    }
    let set = this.seen.get(client);
    if (!set) {
      if (this.seen.size >= 100_000) this.seen.clear();
      set = new Set();
      this.seen.set(client, set);
    }
    if (set.has(owner)) return true;
    if (set.size >= max) return false;
    set.add(owner);
    return true;
  }
}

export async function foldersRoutes(app: FastifyInstance, opts: FoldersRouteOptions = {}) {
  const now = opts.now ?? Date.now;
  let cfg: FoldersConfig | null = opts.cfg ?? null;
  let store: FoldersStore | null = opts.store ?? null;
  let tokens: SessionTokens | null = opts.tokens ?? null;
  try {
    cfg ??= store?.cfg ?? foldersConfigFromEnv();
    store ??= new FoldersStore(cfg);
    tokens ??= new SessionTokens(cfg.dir);
  } catch (e) {
    // Folders are off, the rest of the API is not: every folders route says so.
    app.log.error({ err: e instanceof Error ? e.message : String(e) }, 'knowledge folders: the store could not be opened - the folders routes answer 503');
    store = null;
  }
  const limiter = new KeyedLimiter();
  const signIns = new SignInCounter();

  if (store && (opts.upkeep ?? true)) {
    const s = store;
    const upkeep = () => {
      try {
        const swept = s.sweep();
        if (swept.owners) app.log.info({ wallets: swept.owners }, 'knowledge folders: wallets past the retention period deleted');
        s.backup();
      } catch (e) {
        app.log.error({ err: e instanceof Error ? e.message : String(e) }, 'knowledge folders: the daily sweep or backup failed');
      }
    };
    setTimeout(upkeep, 60_000).unref();
    setInterval(upkeep, DAY).unref();
  }

  const fail = (reply: FastifyReply, status: number, code: FoldersError['code'], error: string) =>
    reply.code(status).send({ ok: false, code, error } satisfies FoldersError);

  /** Runs `fn` for the wallet behind the request's token; every refusal in one shape. */
  const withOwner = (kind: 'read' | 'write' | 'file' | 'upload', fn: (owner: string, req: FastifyRequest, reply: FastifyReply) => unknown) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store');
      if (!store || !tokens || !cfg) return fail(reply, 503, 'unavailable', 'Folders are not available right now.');
      const h = req.headers.authorization;
      const session = tokens.read(typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : null, now());
      if (!session || session.epoch !== store.epoch(session.owner)) return fail(reply, 401, 'session', 'Sign in to your folders again.');
      const owner = session.owner;
      const rates =
        kind === 'write' ? [{ key: `w|${owner}`, limit: { max: cfg.limits.writesPerMinute, windowMs: MINUTE } }]
        : kind === 'upload' ? [{ key: `w|${owner}`, limit: { max: cfg.limits.writesPerMinute, windowMs: MINUTE } }, { key: `u|${owner}`, limit: { max: cfg.limits.uploadsPerHour, windowMs: HOUR } }]
        : kind === 'file' ? [{ key: `f|${owner}`, limit: { max: FILE_READS_PER_MIN, windowMs: MINUTE } }]
        : [];
      for (const r of rates) {
        const wait = limiter.take(r.key, r.limit, now());
        if (wait !== null) {
          reply.header('Retry-After', String(wait));
          return fail(reply, 429, 'rate', `Too many changes at once - wait ${wait}s.`);
        }
      }
      store.touch(owner);
      try {
        return await fn(owner, req, reply);
      } catch (e) {
        const f = asFailure(e);
        if (f instanceof FoldersFailure) return fail(reply, f.status, f.code, f.message);
        throw e;
      }
    };

  const body = (req: FastifyRequest): Record<string, unknown> =>
    req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
  const query = (req: FastifyRequest): Record<string, unknown> => (req.query ?? {}) as Record<string, unknown>;
  const list = (owner: string) => ({ ok: true as const, ...store!.list(owner), limits: cfg!.limits });

  // An upload is the file's bytes as they are: no multipart, no base64.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: FILE_BYTES_CEILING + KB }, (_req, payload, done) => done(null, payload));

  app.post('/api/folders/session', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!store || !tokens || !cfg) return fail(reply, 503, 'unavailable', 'Folders are not available right now.');
    const v = checkSignIn(body(req).signIn, now());
    if (!v.ok) return fail(reply, 401, 'signature', v.error);
    if (!signIns.allow(clientKey(req.ip), v.owner, cfg.signInsPerDay, now())) {
      return fail(reply, 429, 'rate', 'Too many wallets signed in from this address today.');
    }
    const r = store.signIn(v.owner, v.nonce, v.expiresAt);
    if (!r.fresh) return fail(reply, 409, 'replay', 'This sign-in was already used. Sign again.');
    const t = tokens.issue(v.owner, r.epoch, now());
    return { ok: true, owner: v.owner, token: t.token, expiresAt: t.expiresAt };
  });

  app.get('/api/folders', withOwner('read', (owner) => list(owner)));

  app.get('/api/folders/item', withOwner('read', (owner, req) => ({ ok: true, item: store!.getItem(owner, query(req).id) })));

  app.get('/api/folders/file', withOwner('file', (owner, req, reply) => {
    const q = query(req);
    if (q.thumb !== undefined && q.thumb !== '1') return fail(reply, 400, 'input', 'thumb, when given, must be 1');
    const f = store!.readFile(owner, String(q.id ?? ''), q.thumb === '1');
    const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    reply
      .header('Content-Type', mimeOf(f.type))
      .header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, no-store');
    return reply.send(f.bytes);
  }));

  app.post('/api/folders/folder/create', withOwner('write', (owner, req) => {
    const folder = store!.createFolder(owner, body(req).name);
    return { ...list(owner), folder };
  }));

  app.post('/api/folders/folder/rename', withOwner('write', (owner, req) => {
    const b = body(req);
    store!.renameFolder(owner, String(b.id ?? ''), b.name);
    return list(owner);
  }));

  app.post('/api/folders/folder/delete', withOwner('write', (owner, req) => {
    store!.deleteFolder(owner, String(body(req).id ?? ''));
    return list(owner);
  }));

  app.post('/api/folders/folder/order', withOwner('write', (owner, req) => {
    store!.orderFolders(owner, body(req).ids);
    return list(owner);
  }));

  app.post('/api/folders/item/create', { bodyLimit: CREATE_BODY_LIMIT }, withOwner('write', (owner, req) => {
    const b = body(req);
    return { ok: true, item: store!.createItem(owner, { folderId: b.folderId, kind: b.kind, title: b.title, data: b.data, thumb: b.thumb }) };
  }));

  app.post('/api/folders/item/update', { bodyLimit: UPDATE_BODY_LIMIT }, withOwner('write', (owner, req) => {
    const b = body(req);
    return { ok: true, item: store!.updateItem(owner, { id: b.id, title: b.title, data: b.data, rev: b.rev }) };
  }));

  app.post('/api/folders/item/move', withOwner('write', (owner, req) => {
    const b = body(req);
    store!.moveItem(owner, { id: b.id, folderId: b.folderId, index: b.index });
    return list(owner);
  }));

  app.post('/api/folders/item/delete', withOwner('write', (owner, req) => {
    store!.deleteItem(owner, body(req).id);
    return list(owner);
  }));

  app.post('/api/folders/upload', { bodyLimit: FILE_BYTES_CEILING + KB }, withOwner('upload', (owner, req, reply) => {
    if (!Buffer.isBuffer(req.body)) return fail(reply, 415, 'input', 'Send the file as application/octet-stream.');
    const q = query(req);
    return { ok: true, item: store!.upload(owner, { folderId: q.folderId, name: q.name, title: q.title, bytes: req.body }) };
  }));

  app.post('/api/folders/erase', withOwner('write', (owner, req, reply) => {
    if (body(req).confirm !== 'erase-everything') return fail(reply, 400, 'input', 'Confirm with "erase-everything".');
    const r = store!.erase(owner);
    req.log.info({ items: r.items, folders: r.folders }, 'knowledge folders: a wallet erased everything');
    return { ok: true, erased: r };
  }));
}
