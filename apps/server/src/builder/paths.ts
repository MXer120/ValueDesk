/**
 * Where the builder fee tiers keep their files (docs/BUILDER-TIERS.md §4, §6).
 *
 * All three live in the server's data directory - the directory of the device
 * key file (deviceKey.ts): outside the synced project tree on a workstation,
 * `/var/lib/valuescan/state` on the instance. None of them is ever read from
 * or written to the repository.
 *
 *   builder-tiers.json   the tiers (VALUESCAN_BUILDER_TIERS_FILE). Missing = the feature is off.
 *   builder-terms.key    the Ed25519 key the terms are signed with (VALUESCAN_BUILDER_TERMS_KEY_FILE).
 *   builder.db           what the verifier has counted (VALUESCAN_BUILDER_DB).
 */
import { dirname, join } from 'node:path';
import { deviceKeyPath } from '../deviceKey.js';

const env = (name: string): string => process.env[name]?.trim() ?? '';

/** The server's data directory: where the device key lives. */
export const dataDir = (): string => dirname(deviceKeyPath());

export const tiersPath = (): string => env('VALUESCAN_BUILDER_TIERS_FILE') || join(dataDir(), 'builder-tiers.json');

export const termsKeyPath = (): string => env('VALUESCAN_BUILDER_TERMS_KEY_FILE') || join(dataDir(), 'builder-terms.key');

export const builderDbPath = (): string => env('VALUESCAN_BUILDER_DB') || join(dataDir(), 'builder.db');
