/**
 * The knowledge folders' limits, and where they are kept.
 *
 * Every limit is enforced HERE, on the server - the web shows the same numbers
 * (GET /api/folders reports them) but a client that ignores them gets the
 * refusal. The defaults are the ones proposed to the owner; each can be changed
 * in the API's environment without a release (a restart reads them):
 *
 *   FOLDERS_MAX_FOLDERS            folders per wallet                      3
 *   FOLDERS_MAX_ITEMS              items per folder                       50
 *   FOLDERS_MAX_FILE_MB            one uploaded file                       4  (the Vercel edge carries 4.5 MB at most)
 *   FOLDERS_MAX_WALLET_MB          everything one wallet keeps            25
 *   FOLDERS_WRITES_PER_MIN         changes per wallet per minute          60
 *   FOLDERS_UPLOADS_PER_HOUR       uploads per wallet per hour            20
 *   FOLDERS_SIGNINS_PER_DAY        wallets one address signs in per day   10
 *   FOLDERS_MAX_TOTAL_GB           all wallets together                   20
 *   FOLDERS_MIN_FREE_GB            refuse growth below this much free     5  (the index lives on the same volume)
 *   FOLDERS_RETENTION_DAYS         a wallet unseen this long is deleted  365
 *   FOLDERS_DIR                    where it is kept   <the device key's directory>/folders
 *                                                     (production: /var/lib/valuescan/state/folders, on the data volume)
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
  /** Wallets one client address may sign in per day. */
  signInsPerDay: number;
  /** All wallets together, bytes. */
  totalBytes: number;
  /** Growth is refused while the volume has less than this free. */
  minFreeBytes: number;
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

/** The most an upload can be: what the Vercel function forwards (4.5 MB, less the request's own overhead). */
export const FILE_BYTES_CEILING = Math.floor(4.25 * MB);

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

export function foldersConfigFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): FoldersConfig {
  const limits: FolderLimits = {
    ...DEFAULT_LIMITS,
    folders: num(env, 'FOLDERS_MAX_FOLDERS', DEFAULT_LIMITS.folders, { min: 1, max: 20 }),
    itemsPerFolder: num(env, 'FOLDERS_MAX_ITEMS', DEFAULT_LIMITS.itemsPerFolder, { min: 1, max: 500 }),
    fileBytes: num(env, 'FOLDERS_MAX_FILE_MB', DEFAULT_LIMITS.fileBytes, { scale: MB, min: 64 * KB, max: FILE_BYTES_CEILING }),
    walletBytes: num(env, 'FOLDERS_MAX_WALLET_MB', DEFAULT_LIMITS.walletBytes, { scale: MB, min: MB, max: 2 * GB }),
    writesPerMinute: num(env, 'FOLDERS_WRITES_PER_MIN', DEFAULT_LIMITS.writesPerMinute, { min: 1, max: 10_000 }),
    uploadsPerHour: num(env, 'FOLDERS_UPLOADS_PER_HOUR', DEFAULT_LIMITS.uploadsPerHour, { min: 1, max: 10_000 }),
  };
  return {
    dir: env.FOLDERS_DIR?.trim() || join(dirname(deviceKeyPath()), 'folders'),
    limits,
    signInsPerDay: num(env, 'FOLDERS_SIGNINS_PER_DAY', 10, { min: 1, max: 100_000 }),
    totalBytes: num(env, 'FOLDERS_MAX_TOTAL_GB', 20 * GB, { scale: GB, min: 64 * MB }),
    minFreeBytes: num(env, 'FOLDERS_MIN_FREE_GB', 5 * GB, { scale: GB }),
    // 0 = never; otherwise at least 30 days, well past a session token's 7 (auth.ts).
    retentionMs: retentionDays(num(env, 'FOLDERS_RETENTION_DAYS', 365, { min: 0, max: 3650 })) * 86_400_000,
  };
}
