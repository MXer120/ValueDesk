/**
 * The test wallet's key, as it is typed or pasted: checked, never echoed.
 *
 * Nothing here prints, stores or returns the input in a message - a rejected
 * input may be a real key with a typo. Only its LENGTH and its KIND are named.
 */
import { privateKeyToAccount } from 'viem/accounts';

export type KeyResult = { ok: true; key: `0x${string}` } | { ok: false; problem: string };

/**
 * What was typed -> `0x` + 64 lower-case hex, or why not. Spaces, line breaks
 * and quotes around it are dropped; the 0x is optional (MetaMask exports a key
 * without it).
 */
export function normaliseKey(input: string): KeyResult {
  const s = input.replace(/[\s"'`]/g, '');
  if (!s) return { ok: false, problem: 'Nothing was entered.' };
  const words = input.trim().split(/\s+/);
  if (words.length >= 12 && words.every((w) => /^[a-zA-Z]+$/.test(w))) {
    return { ok: false, problem: 'That looks like a recovery phrase (words). This needs the private key of ONE account: 64 hex characters. Never type a recovery phrase into anything.' };
  }
  const hex = s.replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{40}$/.test(hex)) {
    return { ok: false, problem: 'That is a wallet ADDRESS (40 hex characters), not a private key (64 hex characters).' };
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    return { ok: false, problem: `That has characters that are not hex (0-9, a-f). A private key is 64 hex characters; ${hex.length} characters were entered.` };
  }
  if (hex.length !== 64) {
    return { ok: false, problem: `That is ${hex.length} hex characters; a private key is exactly 64 (optionally with 0x in front).` };
  }
  if (/^0+$/.test(hex)) return { ok: false, problem: 'That is all zeros - not a usable key.' };
  return { ok: true, key: `0x${hex.toLowerCase()}` };
}

/** The address this key controls (checksummed), or null when the key is not on the curve. */
export function addressOfKey(key: `0x${string}`): string | null {
  try {
    return privateKeyToAccount(key).address;
  } catch {
    return null;
  }
}

/** `0x1234...abcd` - short enough to read aloud. */
export const shortAddress = (a: string): string => (a.length > 14 ? `${a.slice(0, 8)}...${a.slice(-6)}` : a);

/** Same wallet? Addresses compare without case; anything that is not an address is never equal. */
export function sameAddress(a: string, b: string): boolean {
  const re = /^0x[0-9a-fA-F]{40}$/;
  return re.test(a.trim()) && re.test(b.trim()) && a.trim().toLowerCase() === b.trim().toLowerCase();
}
