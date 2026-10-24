/**
 * The knowledge folders' limits, and where they are kept.
 *
 * Every limit is enforced HERE, on the server - the web shows the same numbers
 * (GET /api/folders reports them) but a client that ignores them gets the
 * refusal. The defaults are the owner's: 3 folders (the brief), 25 MB a file and
 * 100 MB a wallet with S3 (confirmed 2026-10-24); the rest as proposed with them.
 * Each can be changed in the API's environment without a release (a restart
 * reads them).
 *
 * WHERE FILES GO. With FOLDERS_S3_BUCKET set (production), uploads and
 * thumbnails are objects in that Amazon S3 bucket: the browser sends a file
 * straight to S3 and fetches it from there, each time with a link this server
 * signed for that one object for minutes (blobs.ts, s3.ts) - so a file is not
 * held to what the Vercel function carries. Without it (local development, or a
 * server without the bucket), they are files under FOLDERS_DIR and travel
 * through the API, which caps one file at FILE_BYTES_CEILING. The folders, the
 * items and their text are always in FOLDERS_DIR's database.
 *
 *                                                                        S3       disk
 *   FOLDERS_MAX_FOLDERS            folders per wallet                     3          3
 *   FOLDERS_MAX_ITEMS              items per folder                      50         50
 *   FOLDERS_MAX_FILE_MB            one uploaded file                     25          4   (disk: at most 4.25)
 *   FOLDERS_MAX_WALLET_MB          everything one wallet keeps          100         25
 *   FOLDERS_WRITES_PER_MIN         changes per wallet per minute         60         60
 *   FOLDERS_UPLOADS_PER_HOUR       uploads per wallet per hour           20         20
 *   FOLDERS_DOWNLOAD_MB_PER_DAY    what one wallet may fetch per day   1024       1024
 *   FOLDERS_DOWNLOAD_GB_PER_DAY    what all wallets may fetch per day   100        100   (S3's traffic out is billed)
 *   FOLDERS_SIGNINS_PER_DAY        wallets one address signs in per day  10         10
 *   FOLDERS_MAX_TOTAL_GB           all wallets together                 200         20
 *   FOLDERS_MIN_FREE_GB            refuse growth below this much free     -          5   (the index lives on the volume)
 *   FOLDERS_RETENTION_DAYS         a wallet unseen this long is deleted 365        365
 *   FOLDERS_DIR                    the database (and disk-mode files)   <the device key's directory>/folders
 *                                  (production: /var/lib/valuescan/state/folders, on the data volume)
 *   FOLDERS_S3_BUCKET              the bucket; empty = disk mode        (production: valuedesk-folders-tokyo)
 *   FOLDERS_S3_REGION              its region                           ap-northeast-1
 *   FOLDERS_S3_ENDPOINT            local testing: an S3 stand-in        http://127.0.0.1:<port> only
 *
 * Fixed in code: one item's JSON by kind (a note or a table 200 KB, a chart
 * snapshot 256 KB, a news story 8 KB), a chart thumbnail 200 KB, names 60 and
 * titles 120 characters.
 */
import { dirname, join } from 'node:path';
import { deviceKeyPath } from '../deviceKey.js';
import type { FolderLimits } from './types.js';

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

export interface FoldersConfig {
  dir: string;
  limits: FolderLimits;
  /** The bucket for files and thumbnails; null: they are files under `dir`. */
  s3: { bucket: string; region: string; endpoint?: string } | null;
  /** Wallets one client address may sign in per day. */
  signInsPerDay: number;
  /** All wallets together, bytes. */
  totalBytes: number;
  /** Disk mode: growth is refused while the volume has less than this free. */
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
  fileBytes: 4 * MB,
  walletBytes: 25 * MB,
  jsonBytes: { note: 200 * KB, table: 200 * KB, chart: 256 * KB, news: 8 * KB },
  thumbBytes: 200 * KB,
  writesPerMinute: 60,
  uploadsPerHour: 20,
  nameChars: 60,
  titleChars: 120,
};

/** S3 mode's defaults where they differ from disk mode's. */
export const S3_DEFAULTS = { fileBytes: 25 * MB, walletBytes: 100 * MB, totalBytes: 200 * GB } as const;

/** Disk mode: the most an upload can be - what the Vercel function forwards (4.5 MB, less the request's own overhead). */
export const FILE_BYTES_CEILING = Math.floor(4.25 * MB);
/** S3 mode: one PUT from the browser; kept well under what a phone uploads before the signed link lapses. */
export const S3_FILE_BYTES_CEILING = 100 * MB;

function num(env: Readonly<Record<string, string | undefined>>, name: string, dflt: number, o: { min?: number; max?: number; scale?: number } = {}): number {
  const raw = env[name]?.trim();
  if (!raw) return dflt;
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`${name} must be a number`);
  const v = Number(raw) * (o.scale ?? 1);
  if (o.min !== undefined && v < o.min) throw new Error(`${name} is below its minimum`);
  if (o.max !== undefined && v > o.max) throw new Error(`${name} is above its maximum`);
  return Math.floor(v);
}

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
    fileBytes: num(env, 'FOLDERS_MAX_FILE_MB', s3 ? S3_DEFAULTS.fileBytes : DEFAULT_LIMITS.fileBytes, {
      scale: MB,
      min: 64 * KB,
      max: s3 ? S3_FILE_BYTES_CEILING : FILE_BYTES_CEILING,
    }),
    walletBytes: num(env, 'FOLDERS_MAX_WALLET_MB', s3 ? S3_DEFAULTS.walletBytes : DEFAULT_LIMITS.walletBytes, { scale: MB, min: MB, max: 10 * GB }),
    writesPerMinute: num(env, 'FOLDERS_WRITES_PER_MIN', DEFAULT_LIMITS.writesPerMinute, { min: 1, max: 10_000 }),
    uploadsPerHour: num(env, 'FOLDERS_UPLOADS_PER_HOUR', DEFAULT_LIMITS.uploadsPerHour, { min: 1, max: 10_000 }),
  };
  return {
    dir: env.FOLDERS_DIR?.trim() || join(dirname(deviceKeyPath()), 'folders'),
    limits,
    s3,
    signInsPerDay: num(env, 'FOLDERS_SIGNINS_PER_DAY', 10, { min: 1, max: 100_000 }),
    totalBytes: num(env, 'FOLDERS_MAX_TOTAL_GB', s3 ? S3_DEFAULTS.totalBytes : 20 * GB, { scale: GB, min: 64 * MB }),
    minFreeBytes: s3 ? 0 : num(env, 'FOLDERS_MIN_FREE_GB', 5 * GB, { scale: GB }),
    downloadBytesPerDay: num(env, 'FOLDERS_DOWNLOAD_MB_PER_DAY', 1024 * MB, { scale: MB, min: MB }),
    downloadBytesPerDayTotal: num(env, 'FOLDERS_DOWNLOAD_GB_PER_DAY', 100 * GB, { scale: GB, min: 64 * MB }),
    // 0 = never; otherwise at least 30 days, well past a session token's 7 (auth.ts).
    retentionMs: retentionDays(num(env, 'FOLDERS_RETENTION_DAYS', 365, { min: 0, max: 3650 })) * 86_400_000,
  };
}
