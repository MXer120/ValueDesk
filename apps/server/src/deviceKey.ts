/**
 * Device secret: the thing that replaces the user-chosen passphrase.
 *
 * WHY THIS EXISTS. Encrypting the signing key under a passphrase the user types
 * on every unlock is real friction for an app that only ever runs on localhost,
 * and in practice people choose weak passphrases. But dropping encryption
 * entirely would be wrong here for a specific reason:
 *
 *   This project lives inside a OneDrive folder. Anything written next to the
 *   source - including server/.keystore.json - is synchronised to Microsoft's
 *   cloud and to every other machine on the account.
 *
 * So the keystore stays encrypted, and the key that decrypts it is a random
 * 32-byte secret stored OUTSIDE any synced directory (%LOCALAPPDATA% on Windows,
 * ~/.local/share elsewhere). The ciphertext may sync; the secret never does.
 *
 * What this protects against: the keystore leaking through cloud sync, a backup,
 * a repo copy, or a synced second machine. What it does not protect against:
 * malware already running as this user - which a typed passphrase would not stop
 * either, since it would be in this process's memory the moment you unlocked.
 *
 * Users who want a passphrase can still have one; this is only the default.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

/** A per-user directory that cloud sync clients do not touch. */
export function deviceKeyPath(): string {
  const override = process.env.VALUETRADE_DEVICE_KEY?.trim();
  if (override) return override;

  if (platform() === 'win32') {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'Valuescan', 'device.key');
  }
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'valuescan', 'device.key');
}

/**
 * Load the device secret, creating it on first use.
 * Returns 32 raw bytes suitable as scrypt input.
 */
export function deviceSecret(): Buffer {
  const path = deviceKeyPath();
  if (existsSync(path)) {
    const hex = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
    // Corrupt or truncated: refuse rather than silently minting a new secret,
    // which would make an existing keystore permanently undecryptable.
    throw new Error(
      `Device key at ${path} is malformed. Delete it to start over - you will need to re-enable trading.`,
    );
  }

  mkdirSync(dirname(path), { recursive: true });
  const secret = randomBytes(32);
  writeFileSync(path, secret.toString('hex'), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* no-op on Windows */
  }
  return secret;
}

export const deviceKeyExists = (): boolean => existsSync(deviceKeyPath());

/**
 * The passphrase string handed to the keystore when running in device mode.
 * Deriving it from the secret keeps the keystore format unchanged, so a
 * passphrase-protected keystore and a device-protected one are the same file
 * shape and the same crypto - only the source of the secret differs.
 */
export const devicePassphrase = (): string => 'device:' + deviceSecret().toString('hex');
