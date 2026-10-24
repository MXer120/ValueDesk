/**
 * KNOWLEDGE FOLDERS - a wallet's private research folders (src/folders/).
 *
 *   POST /api/folders/session          {signIn}                     -> a token (auth.ts)
 *   GET  /api/folders                  Bearer                       -> folders, items, usage, limits
 *   GET  /api/folders/item?id=         Bearer                       -> one item with its content
 *   GET  /api/folders/file/url?id=[&thumb=1]  Bearer                -> where to fetch an upload (or a chart's thumbnail), its size
 *   GET  /api/folders/file?id=[&thumb=1]&part=  Bearer              -> one piece of its bytes (PART_BYTES; S3 mode: the link is S3's)
 *   POST /api/folders/folder/create    Bearer {name}
 *   POST /api/folders/folder/rename    Bearer {id, name}
 *   POST /api/folders/folder/delete    Bearer {id}                  (with everything in it)
 *   POST /api/folders/folder/order     Bearer {ids}
 *   POST /api/folders/item/create      Bearer {folderId, kind, title, data, thumb?}
 *   POST /api/folders/item/update      Bearer {id, title?, data?, rev?}
 *   POST /api/folders/item/move        Bearer {id, folderId, index}  (reorder, or to another folder)
 *   POST /api/folders/item/delete      Bearer {id}
 *   POST /api/folders/upload/start     Bearer {folderId, name, size, title?} -> {id, target}: where the bytes go
 *   POST /api/folders/upload/put?id=&part=  Bearer, application/octet-stream: one piece, in order
 *   POST /api/folders/upload/finish    Bearer {id}                  -> the item, once the bytes are checked
 *   POST /api/folders/erase            Bearer {confirm: 'erase-everything'}
 *
 * PRIVATE TO THE WALLET. Every route but the sign-in needs the wallet's token,
 * and every read and write is scoped to that wallet in the store's queries -
 * an id of another wallet's item is "not found", exactly like one that does
 * not exist. A signed S3 link names one key under the wallet's own prefix.
 *
 * LIMITS, SERVER-SIDE. The store enforces the counts and the bytes (store.ts);
 * here are the rates: changes per wallet per minute, uploads per wallet per
 * hour, download links per wallet per minute and the bytes they may fetch per
 * day (per wallet and for everyone: S3's traffic out is billed), and how many
 * wallets one client address signs in per day. Hosted mode's gate adds its
 * per-address limits on top (hosted.ts: `auth` for the sign-in, `write` for
 * every change).
 *
 * WHAT A FILE IS SERVED AS. The type its bytes are (sniffed when the upload
 * finishes, never the name or the type the client claimed): PDF, an image, or
 * text/plain - never HTML or SVG - always as an attachment and never cached:
 * from S3 by the overrides signed into the link, from disk with `nosniff` and a
 * sandboxing CSP as well.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientKey } from '../hosted.js';
import { KeyedLimiter } from '../rateLimit.js';
import { checkSignIn, SessionTokens } from '../folders/auth.js';
import { attachment, DiskBlobs, partLength, partsOf, S3Blobs, type BlobStore } from '../folders/blobs.js';
import { foldersConfigFromEnv, PART_BODY_CEILING, type FoldersConfig } from '../folders/limits.js';
import { asFailure, FoldersFailure, FoldersStore, mimeOf, type Gone } from '../folders/store.js';
import type { FoldersError } from '../folders/types.js';
import { sniffFile } from '../folders/validate.js';

export interface FoldersRouteOptions {
  /** A store to answer from instead of one opened from the environment (tests). */
  store?: FoldersStore;
  tokens?: SessionTokens;
  cfg?: FoldersConfig;
  /** Where the bytes go (tests: a stand-in); otherwise S3 with a bucket configured, else disk. */
  blobs?: BlobStore;
  /** The hourly sweep and the daily backup (off in tests). */
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
const FILE_LINKS_PER_MIN = 120;

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

/** Bytes handed out per key per day (a wallet, and '*' for everyone): counted when a link is issued. */
class DailyBytes {
  private day = -1;
  private readonly used = new Map<string, number>();
  take(keys: ReadonlyArray<{ key: string; max: number }>, bytes: number, now: number): boolean {
    const day = Math.floor(now / DAY);
    if (day !== this.day) {
      this.day = day;
      this.used.clear();
    }
    if (keys.some((k) => (this.used.get(k.key) ?? 0) + bytes > k.max)) return false;
    if (this.used.size >= 100_000) this.used.clear();
    for (const k of keys) this.used.set(k.key, (this.used.get(k.key) ?? 0) + bytes);
    return true;
  }
}

export async function foldersRoutes(app: FastifyInstance, opts: FoldersRouteOptions = {}) {
  const now = opts.now ?? Date.now;
  let cfg: FoldersConfig | null = opts.cfg ?? null;
  let store: FoldersStore | null = opts.store ?? null;
  let tokens: SessionTokens | null = opts.tokens ?? null;
  let blobs: BlobStore | null = opts.blobs ?? null;
  try {
    cfg ??= store?.cfg ?? foldersConfigFromEnv();
    store ??= new FoldersStore(cfg);
    tokens ??= new SessionTokens(cfg.dir);
    blobs ??= cfg.s3 ? new S3Blobs(cfg.s3) : new DiskBlobs(cfg.dir);
    app.log.info({ files: blobs.kind === 's3' ? `s3://${cfg.s3?.bucket}` : 'disk' }, 'knowledge folders: ready');
  } catch (e) {
    // Folders are off, the rest of the API is not: every folders route says so.
    app.log.error({ err: e instanceof Error ? e.message : String(e) }, 'knowledge folders: the store could not be opened - the folders routes answer 503');
    store = null;
  }
  const limiter = new KeyedLimiter();
  const signIns = new SignInCounter();
  const downloads = new DailyBytes();

  /** Blobs of deleted items: removed after the rows (a failure is logged; the rows are gone already). */
  const removeGone = async (gone: readonly Gone[]): Promise<void> => {
    for (const g of gone) {
      if (!g.names.length) continue;
      try {
        await blobs!.remove(g.owner, g.names);
      } catch (e) {
        app.log.error({ err: e instanceof Error ? e.message : String(e), objects: g.names.length }, 'knowledge folders: deleted items left objects behind');
      }
    }
  };

  if (store && (opts.upkeep ?? true)) {
    const s = store;
    const sweep = () => {
      try {
        const swept = s.sweep();
        if (swept.owners) app.log.info({ wallets: swept.owners }, 'knowledge folders: wallets past the retention period deleted');
        void removeGone(swept.gone);
      } catch (e) {
        app.log.error({ err: e instanceof Error ? e.message : String(e) }, 'knowledge folders: the sweep failed');
      }
    };
    const backup = () => {
      try {
        s.backup();
      } catch (e) {
        app.log.error({ err: e instanceof Error ? e.message : String(e) }, 'knowledge folders: the nightly backup failed');
      }
    };
    setTimeout(() => {
      sweep();
      backup();
    }, 60_000).unref();
    // Hourly: an upload reserved and never finished goes within two hours, with its object.
    setInterval(sweep, HOUR).unref();
    setInterval(backup, DAY).unref();
  }

  const fail = (reply: FastifyReply, status: number, code: FoldersError['code'], error: string) =>
    reply.code(status).send({ ok: false, code, error } satisfies FoldersError);

  /** Runs `fn` for the wallet behind the request's token; every refusal in one shape. */
  const withOwner = (kind: 'read' | 'write' | 'file' | 'upload', fn: (owner: string, req: FastifyRequest, reply: FastifyReply) => unknown) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store');
      if (!store || !tokens || !cfg || !blobs) return fail(reply, 503, 'unavailable', 'Folders are not available right now.');
      const h = req.headers.authorization;
      const session = tokens.read(typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : null, now());
      if (!session || session.epoch !== store.epoch(session.owner)) return fail(reply, 401, 'session', 'Sign in to your folders again.');
      const owner = session.owner;
      const rates =
        kind === 'write' ? [{ key: `w|${owner}`, limit: { max: cfg.limits.writesPerMinute, windowMs: MINUTE } }]
        : kind === 'upload' ? [{ key: `w|${owner}`, limit: { max: cfg.limits.writesPerMinute, windowMs: MINUTE } }, { key: `u|${owner}`, limit: { max: cfg.limits.uploadsPerHour, windowMs: HOUR } }]
        : kind === 'file' ? [{ key: `f|${owner}`, limit: { max: FILE_LINKS_PER_MIN, windowMs: MINUTE } }]
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
  /** `part`: 0 when absent, else a whole number below `parts`. */
  const partParam = (req: FastifyRequest, parts: number): number => {
    const raw = query(req).part;
    if (raw === undefined) return 0;
    const n = typeof raw === 'string' && /^\d{1,4}$/.test(raw) ? Number(raw) : -1;
    if (n < 0 || n >= parts) throw new FoldersFailure(400, 'input', `part must be 0 to ${parts - 1}`);
    return n;
  };
  const thumbParam = (req: FastifyRequest): boolean => {
    const t = query(req).thumb;
    if (t !== undefined && t !== '1') throw new FoldersFailure(400, 'input', 'thumb, when given, must be 1');
    return t === '1';
  };

  // A piece of an upload: its bytes as they are - no multipart, no base64.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: PART_BODY_CEILING + KB }, (_req, payload, done) => done(null, payload));

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

  /** Where the browser fetches a file: S3's signed link for a minute, or this API (disk mode). Counted against the day's bytes. */
  app.get('/api/folders/file/url', withOwner('file', async (owner, req, reply) => {
    const thumb = thumbParam(req);
    const f = store!.fileInfo(owner, query(req).id, thumb);
    const ok = downloads.take([{ key: owner, max: cfg!.downloadBytesPerDay }, { key: '*', max: cfg!.downloadBytesPerDayTotal }], f.bytes, now());
    if (!ok) return fail(reply, 429, 'rate', 'You have opened a lot of files today. Try again tomorrow.');
    const link = await blobs!.downloadLink(owner, f.name, { mime: mimeOf(f.type), fileName: f.fileName, thumb, id: String(query(req).id), size: f.bytes });
    return { ok: true, mime: mimeOf(f.type), ...link };
  }));

  /**
   * One piece of a file. Every piece is sent as application/octet-stream, as an attachment, with a
   * sandboxing CSP: the browser puts the pieces together and types the whole itself (from file/url).
   * The first piece is sniffed again on the way out - what is served is what the bytes are.
   */
  app.get('/api/folders/file', withOwner('file', (owner, req, reply) => {
    if (!(blobs instanceof DiskBlobs)) return fail(reply, 404, 'not-found', 'Files are fetched from their own link (GET /api/folders/file/url).');
    const thumb = thumbParam(req);
    const f = store!.fileInfo(owner, query(req).id, thumb);
    const n = partParam(req, partsOf(f.bytes));
    const got = blobs.readPart(owner, f.name, n);
    if (!got || got.size !== f.bytes) return fail(reply, 404, 'not-found', 'The file cannot be served.');
    if (n === 0) {
      const type = sniffFile(got.bytes, got.bytes.length >= got.size);
      if (!type || (!thumb && type !== f.type)) return fail(reply, 404, 'not-found', 'The file cannot be served.');
    }
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', attachment(f.fileName))
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, no-store');
    return reply.send(got.bytes);
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

  app.post('/api/folders/folder/delete', withOwner('write', async (owner, req) => {
    await removeGone([store!.deleteFolder(owner, String(body(req).id ?? ''))]);
    return list(owner);
  }));

  app.post('/api/folders/folder/order', withOwner('write', (owner, req) => {
    store!.orderFolders(owner, body(req).ids);
    return list(owner);
  }));

  app.post('/api/folders/item/create', { bodyLimit: CREATE_BODY_LIMIT }, withOwner('write', async (owner, req) => {
    const b = body(req);
    const p = store!.prepareItem(owner, { folderId: b.folderId, kind: b.kind, title: b.title, data: b.data, thumb: b.thumb });
    // The thumbnail first: a refusal after it leaves nothing behind, a crash at worst an object no row names.
    if (p.thumb) await blobs!.put(owner, `${p.id}.thumb`, p.thumb);
    try {
      return { ok: true, item: store!.insertItem(owner, p) };
    } catch (e) {
      if (p.thumb) await removeGone([{ owner, names: [`${p.id}.thumb`] }]);
      throw e;
    }
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

  app.post('/api/folders/item/delete', withOwner('write', async (owner, req) => {
    await removeGone([store!.deleteItem(owner, body(req).id)]);
    return list(owner);
  }));

  /** Reserve an upload and say where its bytes go: S3 (a link for exactly this key and size) or upload/put. */
  app.post('/api/folders/upload/start', withOwner('upload', async (owner, req) => {
    const b = body(req);
    const u = store!.startUpload(owner, { folderId: b.folderId, name: b.name, title: b.title, size: b.size });
    try {
      return { ok: true, id: u.id, target: await blobs!.uploadTarget(owner, u.id, u.size) };
    } catch (e) {
      // No link, no reservation (e.g. the instance role's keys could not be read).
      try {
        store!.finishUpload(owner, u.id, null);
      } catch {
        /* refused, as meant: the reservation is gone */
      }
      throw e;
    }
  }));

  /** One piece of a reserved upload, in order (DiskBlobs.appendPart); each is exactly as long as its place says. */
  app.post('/api/folders/upload/put', { bodyLimit: PART_BODY_CEILING + KB }, withOwner('write', (owner, req, reply) => {
    if (!(blobs instanceof DiskBlobs)) return fail(reply, 404, 'not-found', 'Uploads go to their own link (POST /api/folders/upload/start).');
    if (!Buffer.isBuffer(req.body)) return fail(reply, 415, 'input', 'Send the file as application/octet-stream.');
    const u = store!.pendingUpload(owner, query(req).id);
    const n = partParam(req, partsOf(u.size));
    if (req.body.length !== partLength(u.size, n)) return fail(reply, 400, 'input', 'This piece is not the size its place in the upload says.');
    const r = blobs.appendPart(owner, u.id, n, req.body, u.size);
    if (r === 'out-of-order') return fail(reply, 409, 'conflict', 'A piece of the upload is missing. Start the upload again.');
    return { ok: true, part: n, parts: partsOf(u.size) };
  }));

  app.post('/api/folders/upload/finish', withOwner('write', async (owner, req) => {
    const u = store!.pendingUpload(owner, body(req).id);
    const got = await blobs!.inspect(owner, u.id);
    try {
      return { ok: true, item: store!.finishUpload(owner, u.id, got) };
    } catch (e) {
      // Refused (the size, what the bytes are): the reservation is gone, and so are the bytes.
      if (got) await removeGone([{ owner, names: [u.id] }]);
      throw e;
    }
  }));

  app.post('/api/folders/erase', withOwner('write', async (owner, req, reply) => {
    if (body(req).confirm !== 'erase-everything') return fail(reply, 400, 'input', 'Confirm with "erase-everything".');
    const r = store!.erase(owner);
    await removeGone([r.gone]);
    req.log.info({ items: r.items, folders: r.folders }, 'knowledge folders: a wallet erased everything');
    return { ok: true, erased: { items: r.items, folders: r.folders } };
  }));
}
