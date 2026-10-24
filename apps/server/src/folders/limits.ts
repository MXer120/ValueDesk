/**
 * The knowledge folders' limits, and where they are kept.
 *
 * Every limit is enforced HERE, on the server - the web shows the same numbers
 * (GET /api/folders reports them) but a client that ignores them gets the
 * refusal. The defaults are the owner's: 3 folders (the brief), 25 MB a file and
 * 100 MB a wallet (confirmed 2026-10-24); the rest as proposed with them. Each
 * can be changed in the API's environment without a release (a restart reads
 * them).
 *
 * WHERE FILES GO. On the server's data volume (an EBS volume in Tokyo), under
 * FOLDERS_DIR/files, beside the folders' database. They travel through the
 * site's own /api - the Vercel edge, its origin secret, its geo-blocking and
 * this API's limits - in pieces of PART_BYTES each way, because the Vercel
 * function carries at most 4.5 MB a request or an answer (blobs.ts DiskBlobs;
 * POST /api/folders/upload/put, GET /api/folders/file, both with &part=).
 *
 * With FOLDERS_S3_BUCKET set they are objects in that S3 bucket instead, sent
 * and fetched by the browser directly with links this server signs (S3Blobs).
 * That needs the owner's IAM step (deploy/aws/folders-storage.sh) AND the
 * bucket's host in the site's CSP (connect-src, in the three places) - it is
 * not used today.
 *
 *   FOLDERS_MAX_FOLDERS            folders per wallet                     3
 *   FOLDERS_MAX_ITEMS              items per folder                      50
 *   FOLDERS_MAX_FILE_MB            one uploaded file                     25   (at most 100)
 *   FOLDERS_MAX_WALLET_MB          everything one wallet keeps          100
 *   FOLDERS_WRITES_PER_MIN         changes per wallet per minute         60   (a 25 MB upload is 7 of them)
 *   FOLDERS_UPLOADS_PER_HOUR       uploads per wallet per hour           60   (images pasted into docs and boards are uploads)
 *   FOLDERS_DOWNLOAD_MB_PER_DAY    what one wallet may fetch per day   1024
 *   FOLDERS_DOWNLOAD_GB_PER_DAY    what all wallets may fetch per day   100
 *   FOLDERS_SIGNINS_PER_DAY        wallets one address signs in per day  10
 *   FOLDERS_MAX_TOTAL_GB           all wallets together                  20   (S3: 200)
 *   FOLDERS_MIN_FREE_GB            refuse growth below this much free    10   (the index lives on the volume; S3: -)
 *   FOLDERS_RETENTION_DAYS         a wallet unseen this long is deleted 365
 *   FOLDERS_WALLETS                the wallets that may use the folders  the owner's wallet only (FOLDERS_OWNER)
 *                                  - comma-separated 0x addresses, or * for every wallet
 *   FOLDERS_DIR                    the database and the files           <the device key's directory>/folders
 *                                  (production: /var/lib/valuescan/state/folders, on the data volume)
 *   FOLDERS_S3_BUCKET              files in S3 instead (see above)      empty
 *   FOLDERS_S3_REGION              its region                           ap-northeast-1
 *   FOLDERS_S3_ENDPOINT            local testing: an S3 stand-in        http://127.0.0.1:<port> only
 *
 * Fixed in code: one item's JSON by kind (a doc 768 KB; a sheet or a board
 * 1.5 MB; a chart snapshot 256 KB; a saved post 48 KB; a news story 8 KB), a
 * chart thumbnail 200 KB, 200 attachments (images) to a doc or a board, names
 * 60 and titles 120 characters. Attachments count against the wallet's bytes,
 * not against the folder's items.
 */
import { dirname, join } from 'node:path';
import { deviceKeyPath } from '../deviceKey.js';
import type { FolderLimits } from './types.js';

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/**
 * The owner's wallet (2026-10-24: "make any knowledge features ONLY accessible
 * for my wallet"). Until FOLDERS_WALLETS says otherwise, no other wallet can sign
 * in to the folders or use a token it has - the server's rule, whatever a
 * browser shows (the web hides Knowledge too: apps/web/src/folders/access.ts).
 */
export const FOLDERS_OWNER = '0x04fb8f9d0d8cd5495aa47e81ca9804cdf32a277d';

export interface FoldersConfig {
  dir: string;
  /** The wallets that may use the folders (lowercase), or '*' for every wallet. */
  wallets: readonly string[] | '*';
  limits: FolderLimits;
  /** The bucket for files and thumbnails; null (today): they are files under `dir`. */
  s3: { bucket: string; region: string; endpoint?: string } | null;
  /** Wallets one client address may sign in per day. */
  signInsPerDay: number;
  /** All wallets together, bytes. */
  totalBytes: number;
  /** Files on disk: growth is refused while the volume has less than this free. */
  minFreeBytes: number;
  /** What one wallet, and all wallets together, may fetch per day (bytes of files and thumbnails). */
  downloadBytesPerDay: number;
  downloadBytesPerDayTotal: number;
  /** A wallet not signed in for this long is deleted, with everything in it. 0 = never. */
  retentionMs: number;
}

export const DEFAULT_LIMITS: FolderLimits = {
  folders: 3,
  itemsPerFolder: 50,
  fileBytes: 25 * MB,
  walletBytes: 100 * MB,
  jsonBytes: { doc: 768 * KB, sheet: 1536 * KB, board: 1536 * KB, tweet: 48 * KB, chart: 256 * KB, news: 8 * KB },
  thumbBytes: 200 * KB,
  writesPerMinute: 60,
  uploadsPerHour: 60,
  attachmentsPerItem: 200,
  nameChars: 60,
  titleChars: 120,
};

/**
 * One piece of a file through the API, each way: what the Vercel function carries
 * (4.5 MB a request or an answer) with room for the request's own overhead.
 */
export const PART_BYTES = 4 * MB;
/** What a request that carries a piece may hold (routes/folders.ts, the Vercel function). */
export const PART_BODY_CEILING = Math.floor(4.25 * MB);
/** One file, however it travels. */
export const FILE_BYTES_CEILING = 100 * MB;

function num(env: Readonly<Record<string, string | undefined>>, name: string, dflt: number, o: { min?: number; max?: number; scale?: number } = {}): number {
  const raw = env[name]?.trim();
  if (!raw) return dflt;
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`${name} must be a number`);
  const v = Number(raw) * (o.scale ?? 1);
  if (o.min !== undefined && v < o.min) throw new Error(`${name} is below its minimum`);
  if (o.max !== undefined && v > o.max) throw new Error(`${name} is above its maximum`);
  return Math.floor(v);
}

/** FOLDERS_WALLETS: unset is the owner alone; '*' every wallet; else a list of addresses. */
export function walletsFrom(raw: string | undefined): readonly string[] | '*' {
  const s = raw?.trim() ?? '';
  if (!s) return [FOLDERS_OWNER];
  if (s === '*') return '*';
  const list = s.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
  for (const a of list) if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`FOLDERS_WALLETS holds "${a.slice(0, 12)}…", which is not a wallet address`);
  return list;
}

/** Whether this wallet may use the folders. */
export const walletAllowed = (cfg: Pick<FoldersConfig, 'wallets'>, owner: string): boolean => cfg.wallets === '*' || cfg.wallets.includes(owner.toLowerCase());

const retentionDays = (d: number): number => {
  if (d !== 0 && d < 30) throw new Error('FOLDERS_RETENTION_DAYS must be 0 (never) or at least 30');
  return d;
};

/** A bucket name as S3 allows it (3-63 of a-z 0-9 . -, starting and ending with a letter or digit). */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export function foldersConfigFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): FoldersConfig {
  const bucket = env.FOLDERS_S3_BUCKET?.trim() ?? '';
  const region = env.FOLDERS_S3_REGION?.trim() || 'ap-northeast-1';
  if (bucket && !BUCKET.test(bucket)) throw new Error('FOLDERS_S3_BUCKET is not a bucket name');
  if (!REGION.test(region)) throw new Error('FOLDERS_S3_REGION is not a region (e.g. ap-northeast-1)');
  // Local testing only: an S3 stand-in on this machine (path style). Never a remote host.
  const endpoint = env.FOLDERS_S3_ENDPOINT?.trim() ?? '';
  if (endpoint && !/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(endpoint)) throw new Error('FOLDERS_S3_ENDPOINT may only name a stand-in on this machine (http://127.0.0.1:<port>)');
  const s3 = bucket ? { bucket, region, ...(endpoint ? { endpoint } : {}) } : null;
  const limits: FolderLimits = {
    ...DEFAULT_LIMITS,
    folders: num(env, 'FOLDERS_MAX_FOLDERS', DEFAULT_LIMITS.folders, { min: 1, max: 20 }),
    itemsPerFolder: num(env, 'FOLDERS_MAX_ITEMS', DEFAULT_LIMITS.itemsPerFolder, { min: 1, max: 500 }),
    fileBytes: num(env, 'FOLDERS_MAX_FILE_MB', DEFAULT_LIMITS.fileBytes, { scale: MB, min: 64 * KB, max: FILE_BYTES_CEILING }),
    walletBytes: num(env, 'FOLDERS_MAX_WALLET_MB', DEFAULT_LIMITS.walletBytes, { scale: MB, min: MB, max: 10 * GB }),
    writesPerMinute: num(env, 'FOLDERS_WRITES_PER_MIN', DEFAULT_LIMITS.writesPerMinute, { min: 1, max: 10_000 }),
    uploadsPerHour: num(env, 'FOLDERS_UPLOADS_PER_HOUR', DEFAULT_LIMITS.uploadsPerHour, { min: 1, max: 10_000 }),
  };
  return {
    dir: env.FOLDERS_DIR?.trim() || join(dirname(deviceKeyPath()), 'folders'),
    wallets: walletsFrom(env.FOLDERS_WALLETS),
    limits,
    s3,
    signInsPerDay: num(env, 'FOLDERS_SIGNINS_PER_DAY', 10, { min: 1, max: 100_000 }),
    totalBytes: num(env, 'FOLDERS_MAX_TOTAL_GB', s3 ? 200 * GB : 20 * GB, { scale: GB, min: 64 * MB }),
    minFreeBytes: s3 ? 0 : num(env, 'FOLDERS_MIN_FREE_GB', 10 * GB, { scale: GB }),
    downloadBytesPerDay: num(env, 'FOLDERS_DOWNLOAD_MB_PER_DAY', 1024 * MB, { scale: MB, min: MB }),
    downloadBytesPerDayTotal: num(env, 'FOLDERS_DOWNLOAD_GB_PER_DAY', 100 * GB, { scale: GB, min: 64 * MB }),
    // 0 = never; otherwise at least 30 days, well past a session token's 7 (auth.ts).
    retentionMs: retentionDays(num(env, 'FOLDERS_RETENTION_DAYS', 365, { min: 0, max: 3650 })) * 86_400_000,
  };
}
