/**
 * Where the bytes of the knowledge folders' files and thumbnails are: one
 * interface, two places (limits.ts says which is used).
 *
 *   DiskBlobs  production today: files under FOLDERS_DIR/files on the server's data
 *              volume, sent and fetched through the API's own routes in pieces of
 *              PART_BYTES (POST /api/folders/upload/put?id=&part=, GET
 *              /api/folders/file?id=&part=) - every piece passes the Vercel edge,
 *              which carries 4.5 MB at most, and every protection that comes with it.
 *   S3Blobs    with a bucket configured (the owner's IAM step, and the bucket in the
 *              CSP): objects `files/<wallet>/<item>` (and `<item>.thumb`). The
 *              browser PUTs an upload straight to S3 with a link signed for exactly
 *              that key and that many bytes, and fetches a file with a link signed
 *              for a minute that makes S3 answer with the sniffed type, as an
 *              attachment.
 *
 * The store (store.ts) decides what may be kept; this module only moves bytes.
 * A name is `<item id>` for an upload or `<item id>.thumb` for a thumbnail, both
 * under the wallet's own prefix - one wallet's link can never name another's.
 */
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { PART_BYTES } from './limits.js';
import { credentialSource, presignUrl, s3Request, type AwsCredentials, type S3Location } from './s3.js';

/**
 * How the browser sends an upload's bytes. `bearer`: with the wallet's token (our own route),
 * never to S3. `partBytes`: in pieces of that size, each to `url` + `&part=<n>`, in order.
 */
export interface UploadTarget {
  method: 'PUT' | 'POST';
  url: string;
  headers: Record<string, string>;
  bearer: boolean;
  partBytes?: number;
}

/** Where the browser fetches a file from; with `partBytes`, in pieces (`&part=<n>`) of `size` bytes in all. */
export interface DownloadLink {
  url: string;
  bearer: boolean;
  partBytes?: number;
  size?: number;
}

/** How many pieces `size` bytes are, and how long piece `n` is. */
export const partsOf = (size: number): number => Math.max(1, Math.ceil(size / PART_BYTES));
export const partLength = (size: number, n: number): number => Math.max(0, Math.min(PART_BYTES, size - n * PART_BYTES));

export interface BlobStore {
  readonly kind: 'disk' | 's3';
  /** Where the browser sends `size` bytes for upload `id`. */
  uploadTarget(owner: string, id: string, size: number): Promise<UploadTarget>;
  /** What arrived for `name`: its size and its first bytes (at most HEAD_BYTES); null when nothing did. */
  inspect(owner: string, name: string): Promise<{ size: number; head: Buffer } | null>;
  /** A small object from this server (a chart thumbnail). */
  put(owner: string, name: string, bytes: Buffer): Promise<void>;
  /** A link the browser fetches `name` with, answered as `mime`, as an attachment called `fileName`. */
  downloadLink(owner: string, name: string, o: { mime: string; fileName: string; thumb: boolean; id: string; size: number }): Promise<DownloadLink>;
  remove(owner: string, names: readonly string[]): Promise<void>;
}

/** Enough of a file to tell what it is (validate.ts sniffFile), and to judge text by. */
export const HEAD_BYTES = 64 * 1024;
const keyOf = (owner: string, name: string): string => `files/${owner}/${name}`;

/** RFC 6266: an ASCII fallback and the UTF-8 name. */
export function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/* ------------------------------------------------------------------- S3 ----- */

export class S3Blobs implements BlobStore {
  readonly kind = 's3' as const;
  private readonly creds: () => Promise<AwsCredentials>;

  constructor(
    private readonly loc: S3Location,
    creds?: () => Promise<AwsCredentials>,
  ) {
    this.creds = creds ?? credentialSource();
  }

  async uploadTarget(owner: string, id: string, size: number): Promise<UploadTarget> {
    // The length is signed: S3 refuses a body of any other size. The type is fixed: nothing
    // stored is ever served as what a client claimed (downloads name their own type).
    const headers = { 'content-length': String(size), 'content-type': 'application/octet-stream' };
    const url = presignUrl({ method: 'PUT', loc: this.loc, key: keyOf(owner, id), creds: await this.creds(), expiresIn: 600, headers });
    return { method: 'PUT', url, headers: { 'Content-Type': headers['content-type'] }, bearer: false };
  }

  async inspect(owner: string, name: string): Promise<{ size: number; head: Buffer } | null> {
    const creds = await this.creds();
    const key = keyOf(owner, name);
    const h = await s3Request({ method: 'HEAD', loc: this.loc, key, creds, allow404: true });
    if (h.status === 404) return null;
    const size = Number(h.headers.get('content-length'));
    if (!Number.isFinite(size) || size <= 0) return { size: 0, head: Buffer.alloc(0) };
    const r = await s3Request({ method: 'GET', loc: this.loc, key, creds, headers: { range: `bytes=0-${Math.min(size, HEAD_BYTES) - 1}` } });
    return { size, head: Buffer.from(await r.arrayBuffer()) };
  }

  async put(owner: string, name: string, bytes: Buffer): Promise<void> {
    await s3Request({ method: 'PUT', loc: this.loc, key: keyOf(owner, name), creds: await this.creds(), body: bytes, headers: { 'content-type': 'application/octet-stream' } });
  }

  async downloadLink(owner: string, name: string, o: { mime: string; fileName: string }): Promise<DownloadLink> {
    const url = presignUrl({
      method: 'GET',
      loc: this.loc,
      key: keyOf(owner, name),
      creds: await this.creds(),
      expiresIn: 60,
      query: {
        'response-content-type': o.mime,
        'response-content-disposition': attachment(o.fileName),
        'response-cache-control': 'private, no-store',
      },
    });
    return { url, bearer: false };
  }

  async remove(owner: string, names: readonly string[]): Promise<void> {
    const creds = await this.creds();
    // One DELETE per object: a DeleteObjects batch needs a checksum of its XML body, and a
    // wallet holds at most a few hundred objects.
    for (const n of names) await s3Request({ method: 'DELETE', loc: this.loc, key: keyOf(owner, n), creds, allow404: true });
  }
}

/* ----------------------------------------------------------------- disk ----- */

export class DiskBlobs implements BlobStore {
  readonly kind = 'disk' as const;
  readonly root: string;

  constructor(dir: string) {
    this.root = join(dir, 'files');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  path(owner: string, name: string): string {
    return join(this.root, owner, name);
  }

  async uploadTarget(_owner: string, id: string): Promise<UploadTarget> {
    return { method: 'POST', url: `/api/folders/upload/put?id=${encodeURIComponent(id)}`, headers: { 'Content-Type': 'application/octet-stream' }, bearer: true, partBytes: PART_BYTES };
  }

  /**
   * Piece `n` of an upload of `size` bytes, in order: accepted when the pieces before it are
   * there (the file is `n * PART_BYTES` long); a piece sent again (a retry after a lost answer)
   * is accepted and changes nothing; one out of order is refused.
   */
  appendPart(owner: string, name: string, n: number, bytes: Buffer, size: number): 'stored' | 'again' | 'out-of-order' {
    const dir = join(this.root, owner);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = this.path(owner, name);
    const have = existsSync(p) ? statSync(p).size : 0;
    const at = n * PART_BYTES;
    if (have >= at + bytes.length && bytes.length === partLength(size, n)) return 'again';
    if (have !== at) return 'out-of-order';
    const fd = openSync(p, n === 0 ? 'w' : 'r+', 0o600);
    try {
      writeSync(fd, bytes, 0, bytes.length, at);
    } finally {
      closeSync(fd);
    }
    return 'stored';
  }

  /** Piece `n` of a stored file, for GET /api/folders/file. Null when the file is not there. */
  readPart(owner: string, name: string, n: number): { bytes: Buffer; size: number } | null {
    const p = this.path(owner, name);
    if (!existsSync(p)) return null;
    const size = statSync(p).size;
    const bytes = Buffer.alloc(partLength(size, n));
    const fd = openSync(p, 'r');
    try {
      readSync(fd, bytes, 0, bytes.length, n * PART_BYTES);
    } finally {
      closeSync(fd);
    }
    return { bytes, size };
  }

  /** A small file written whole (a chart thumbnail): under a temporary name first, then moved into place. */
  receive(owner: string, name: string, bytes: Buffer): void {
    const dir = join(this.root, owner);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.tmp-${randomBytes(9).toString('base64url')}`);
    writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
    try {
      renameSync(tmp, this.path(owner, name));
    } catch (e) {
      rmQuiet(tmp);
      throw e;
    }
  }

  async inspect(owner: string, name: string): Promise<{ size: number; head: Buffer } | null> {
    const p = this.path(owner, name);
    if (!existsSync(p)) return null;
    const size = statSync(p).size;
    const head = Buffer.alloc(Math.min(size, HEAD_BYTES));
    const fd = openSync(p, 'r');
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    return { size, head };
  }

  async put(owner: string, name: string, bytes: Buffer): Promise<void> {
    this.receive(owner, name, bytes);
  }

  async downloadLink(_owner: string, _name: string, o: { thumb: boolean; id: string; size: number }): Promise<DownloadLink> {
    return { url: `/api/folders/file?id=${encodeURIComponent(o.id)}${o.thumb ? '&thumb=1' : ''}`, bearer: true, partBytes: PART_BYTES, size: o.size };
  }

  async remove(owner: string, names: readonly string[]): Promise<void> {
    for (const n of names) rmQuiet(this.path(owner, n));
    try {
      rmdirSync(join(this.root, owner));
    } catch {
      /* not empty, or gone */
    }
  }
}

function rmQuiet(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* gone already */
  }
}
